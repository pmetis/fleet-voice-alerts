'use strict';

/**
 * Live ACE Q&A module — called during a live voice call on cache miss.
 *
 * ACE Flow (real stateful API):
 *   1. create-chat  → get chat_id
 *   2. send-prompt  → get message_group_id
 *   3. poll get-message-group until status === "DONE"
 *
 * Multi-round Twilio strategy (avoids 429 rate limits):
 *
 *   Round 0 — askAceLive():
 *     Creates a new ACE session (create-chat + send-prompt).
 *     Immediately persists chatId + messageGroupId to Firestore
 *     via callAceStatefulWithPersist(). Then polls up to ~15s.
 *     If ACE responds → return answer.
 *     If timeout → return null (session IDs already in Firestore).
 *
 *   Rounds 1+ — resumeAcePoll():
 *     Reads chatId + messageGroupId from the call doc (set in round 0).
 *     Only calls get-message-group — NO new create-chat or send-prompt.
 *     This is cheap and avoids 429 errors from repeated session creation.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { GeotabClient }          = require('./geotabClient');
const { decrypt }               = require('./crypto');

const db = new Firestore();

// Hard ceiling per round — must stay under Twilio's ~15s webhook timeout
const ACE_LIVE_TIMEOUT_MS = 12000;

// ─── Language labels used in prompts ─────────────────────────────────────────
const LANG_NAMES = { en: 'English', es: 'Spanish', pt: 'Portuguese' };

// ─── Authenticate helper ──────────────────────────────────────────────────────
async function buildGeotabClient(config, dbName) {
  const startServer = config.geotabSession?.server || config.geotabServer || 'my.geotab.com';
  const password    = decrypt(config.geotabPassword);
  const geotab      = new GeotabClient(startServer, dbName, config.geotabUser, password);
  await geotab.authenticate();

  // Persist resolved server if it changed
  if (geotab.server !== config.geotabSession?.server) {
    await db.collection('configs').doc(dbName).set(
      { geotabSession: { server: geotab.server } },
      { merge: true }
    );
    console.log(`[ace-live] Persisted resolved server: ${geotab.server} for ${dbName}`);
  }

  return geotab;
}

// ─── Round 0: create session + poll ──────────────────────────────────────────
/**
 * Ask ACE a question in the context of an active call — ROUND 0 only.
 *
 * Uses callAceStatefulWithPersist so the session IDs (chatId, messageGroupId)
 * are saved to Firestore as soon as send-prompt succeeds. This way, if ACE
 * doesn't respond within the 12s window, rounds 1+ can resume polling the
 * same session instead of creating a new one (which causes 429 errors).
 *
 * @returns {Promise<string|null>} ACE answer, or null if still processing
 */
async function askAceLive(config, call, question) {
  let geotab;
  try {
    geotab = await buildGeotabClient(config, call.dbName);
  } catch (err) {
    console.error(`[ace-live] Auth failed for ${call.dbName}:`, err.message);
    return null;
  }

  const lang     = call.lang || 'en';
  const langName = LANG_NAMES[lang] || LANG_NAMES.en;

  // ── Fetch real-time vehicle context: address, speed, ignition ─────────────
  // GetAddresses converts lat/lng to street address so ACE can answer
  // "where is the vehicle?" with a human-readable location.
  let realtimeContext = '';
  try {
    const [status, ignition] = await Promise.all([
      geotab.getDeviceStatus(call.vehicleId),
      geotab.getLastIgnition(call.vehicleId)
    ]);

    if (status) {
      const lat   = status.latitude;
      const lng   = status.longitude;
      const speed = status.speed != null ? `${Math.round(status.speed)}km/h` : 'unknown';
      const gps   = status.isDeviceCommunicating ? 'online' : 'offline';

      let location = (lat != null && lng != null) ? `${lat.toFixed(4)},${lng.toFixed(4)}` : 'unknown';
      if (lat != null && lng != null) {
        const address = await geotab.getAddress(lat, lng);
        if (address) {
          location = address.slice(0, 55);
          console.log(`[ace-live] Address resolved: ${location}`);
        }
      }
      realtimeContext += `Loc:${location}|Speed:${speed}|GPS:${gps}`;
    }

    if (ignition) {
      const ignOn   = ignition.data === 1;
      const ignTime = ignition.dateTime
        ? new Date(ignition.dateTime).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
        : 'unknown';
      realtimeContext += `|Ign:${ignOn ? 'ON' : 'OFF'}@${ignTime}`;
    }

    if (realtimeContext) {
      console.log(`[ace-live] Realtime ctx for ${call.vehicleId}: ${realtimeContext}`);
    }
  } catch (err) {
    console.warn(`[ace-live] Realtime context fetch failed:`, err.message);
  }

  const prompt = buildLivePrompt(call, question, langName, realtimeContext);

  try {
    const answer = await Promise.race([
      geotab.callAceStatefulWithPersist(prompt, async (chatId, messageGroupId) => {
        // Persist IDs immediately after send-prompt — before polling starts.
        // Even if this round times out, rounds 1+ will find these in Firestore.
        await db.collection('calls').doc(call.callId).update({
          aceSessionChatId:     chatId,
          aceSessionMsgGroupId: messageGroupId,
          updatedAt:            FieldValue.serverTimestamp()
        });
        console.log(`[ace-live] Session persisted — chat=${chatId} msg_group=${messageGroupId} callId=${call.callId}`);
      }),
      rejectAfter(ACE_LIVE_TIMEOUT_MS, 'ACE_TIMEOUT')
    ]);

    if (answer) {
      console.log(`[ace-live] ACE answered on round 0 for callId=${call.callId}`);
    }
    return answer || null;

  } catch (err) {
    if (err.message === 'ACE_TIMEOUT') {
      console.warn(`[ace-live] Round 0 timed out after ${ACE_LIVE_TIMEOUT_MS}ms for callId=${call.callId}`);
    } else {
      console.error(`[ace-live] ACE error for callId=${call.callId}:`, err.message);
    }
    return null;
  }
}

// ─── Rounds 1+: resume polling only ──────────────────────────────────────────
/**
 * Resume polling an existing ACE session — rounds 1+ only.
 *
 * Does NOT create a new chat or send a new prompt.
 * Just polls get-message-group with the IDs saved in round 0.
 * This is very cheap and never triggers 429 rate limits.
 *
 * @param {object} config          Firestore config doc data
 * @param {object} call            Firestore call doc data (must have aceSessionChatId/MsgGroupId)
 * @returns {Promise<string|null>} ACE answer, or null if still processing
 */
async function resumeAcePoll(config, call) {
  const chatId         = call.aceSessionChatId;
  const messageGroupId = call.aceSessionMsgGroupId;

  if (!chatId || !messageGroupId) {
    console.warn(`[ace-resume] No session IDs in call doc ${call.callId} — cannot resume`);
    return null;
  }

  let geotab;
  try {
    geotab = await buildGeotabClient(config, call.dbName);
  } catch (err) {
    console.error(`[ace-resume] Auth failed:`, err.message);
    return null;
  }

  try {
    const answer = await Promise.race([
      geotab.pollAceSession(chatId, messageGroupId),
      rejectAfter(ACE_LIVE_TIMEOUT_MS, 'ACE_TIMEOUT')
    ]);

    if (answer) {
      console.log(`[ace-resume] ACE answered for callId=${call.callId}`);
    }
    return answer || null;

  } catch (err) {
    if (err.message === 'ACE_TIMEOUT') {
      console.warn(`[ace-resume] Timed out after ${ACE_LIVE_TIMEOUT_MS}ms for callId=${call.callId}`);
    } else {
      console.error(`[ace-resume] Poll error for callId=${call.callId}:`, err.message);
    }
    return null;
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Minimal live prompt — stays well under ACE's 500-char limit.
 * Context is short + question is capped at 120 chars.
 */
function buildLivePrompt(call, question, langName, realtimeContext = '') {
  const exception = (call.exceptionName || 'Unknown').slice(0, 40);
  const vehicle   = (call.vehicleName   || 'Unknown').slice(0, 30);
  const driver    = (call.driverName    || 'Unknown').slice(0, 30);
  const severity  = (call.ruleSeverity  || 'medium').slice(0, 10);
  const q         = question.slice(0, 100);
  const ctx       = realtimeContext.slice(0, 80);

  const prompt =
`Fleet AI. Live call. Respond in ${langName}. 1-2 spoken sentences, no lists.
Alert:${exception}|${vehicle}|${driver}|sev:${severity}
${ctx ? `Realtime:${ctx}` : ''}
Q:"${q}"
Answer concisely using realtime data if relevant.`;

  return prompt.slice(0, 490);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rejectAfter(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

module.exports = { askAceLive, resumeAcePoll };