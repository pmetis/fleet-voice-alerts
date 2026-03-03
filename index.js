/**
 * Fleet Voice Alerts — Cloud Functions (Day 1 + Day 2 + Day 3)
 * Day 1: getConfig, saveConfig, saveSession, getStatus, testTwilio
 * Day 2: pollExceptions (pollExceptions.js)
 * Day 3: initiateCall, voiceResponse, callStatusCallback (voiceEngine.js)
 *
 * All state lives in Firestore — functions are fully stateless.
 */

'use strict';

const functions  = require('@google-cloud/functions-framework');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const twilio     = require('twilio');

// Shared crypto helpers (also used by pollExceptions.js)
const { encrypt, decrypt, isMasked, MASKED } = require('./lib/crypto');

const db = new Firestore();

// Re-export Day 2 + Day 3 modules so all functions deploy from the same source
require('./pollExceptions');
require('./voiceEngine');

// ─── CORS helper ──────────────────────────────────────────────────────────────
// Lock down to your add-in hosting domain in production
function setCors(res) {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

// ─── Default config ───────────────────────────────────────────────────────────
function defaultConfig() {
  return {
    language:           'en',
    twilioAccountSid:   '',
    twilioAuthToken:    '',   // encrypted at rest
    twilioFromNumber:   '',
    webhookBaseUrl:     '',
    exceptionRules:     [],
    escalationContacts: [],
    schedule: {
      enabled:   false,
      days:      [1, 2, 3, 4, 5],
      startTime: '07:00',
      endTime:   '22:00',
      timezone:  'America/Mexico_City'
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /getConfig?db={dbName}
// Returns config for the given Geotab database, with sensitive fields masked.
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('getConfig', async (req, res) => {
  setCors(res);
  if (handlePreflight(req, res)) return;

  const dbName = req.query.db;
  if (!dbName) return res.status(400).json({ error: 'Missing ?db= parameter' });

  try {
    const docRef = db.collection('configs').doc(dbName);
    const doc    = await docRef.get();

    if (!doc.exists) {
      return res.json({ exists: false, config: defaultConfig() });
    }

    const data = { ...doc.data() };

    // Mask sensitive fields — never send encrypted values to the browser.
    // isMasked() checks for the bullet character so saveConfig can detect
    // when the client sends the placeholder back and preserve the real value.
    if (data.twilioAuthToken) data.twilioAuthToken = MASKED;
    if (data.geotabPassword)  data.geotabPassword  = MASKED;
    // Never send raw Geotab session to client
    delete data.geotabSession;

    return res.json({ exists: true, config: data });
  } catch (err) {
    console.error('[getConfig]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /saveConfig
// Body: { dbName: string, config: object }
// Encrypts the Twilio Auth Token before storing. Preserves existing encrypted
// token if the client sends back the masked value.
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('saveConfig', async (req, res) => {
  setCors(res);
  if (handlePreflight(req, res)) return;

  const { dbName, config } = req.body || {};
  if (!dbName || !config) {
    return res.status(400).json({ error: 'Body must contain { dbName, config }' });
  }

  try {
    const docRef  = db.collection('configs').doc(dbName);
    const docSnap = await docRef.get();
    const existing = docSnap.exists ? docSnap.data() : {};

    const toStore = {
      ...defaultConfig(),
      ...existing,
      ...config,
      updatedAt: FieldValue.serverTimestamp()
    };

    // Handle Twilio Auth Token encryption
    if (config.twilioAuthToken && !isMasked(config.twilioAuthToken)) {
      // Fresh token from client — encrypt it
      toStore.twilioAuthToken = encrypt(config.twilioAuthToken);
    } else {
      // Client sent back masked value or nothing — keep existing encrypted token
      toStore.twilioAuthToken = existing.twilioAuthToken || '';
    }

    // Handle Geotab Password encryption (same pattern)
    if (config.geotabPassword && !isMasked(config.geotabPassword)) {
      toStore.geotabPassword = encrypt(config.geotabPassword);
    } else {
      toStore.geotabPassword = existing.geotabPassword || '';
    }

    // Never store geotabSession via this endpoint (use saveSession)
    delete toStore.geotabSession;

    await docRef.set(toStore, { merge: false }); // full replace to avoid stale fields
    return res.json({ success: true });
  } catch (err) {
    console.error('[saveConfig]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /saveSession
// Body: { dbName, userName }
//
// Lightweight heartbeat — records that the add-in is actively open.
// Only dbName is required. userName is informational.
//
// The backend poller authenticates independently using geotabUser +
// geotabPassword stored in configs/{dbName} — NOT a session token.
// api.getSession() in the add-in only returns { userName, database };
// sessionId and server are intentionally not exposed to JavaScript.
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('saveSession', async (req, res) => {
  setCors(res);
  if (handlePreflight(req, res)) return;

  const { dbName, userName } = req.body || {};
  if (!dbName) {
    return res.status(400).json({ error: 'Missing required field: dbName' });
  }

  try {
    await db.collection('configs').doc(dbName).set({
      lastSeenAt: FieldValue.serverTimestamp(),
      lastSeenUser: userName || ''
    }, { merge: true });

    // Initialise feed cursor on first load if it doesn't exist yet
    const cursorRef = db.collection('feed-cursors').doc(dbName);
    const cursor    = await cursorRef.get();
    if (!cursor.exists) {
      await cursorRef.set({ fromVersion: '0', createdAt: FieldValue.serverTimestamp() });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[saveSession]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /getStatus?db={dbName}
// Returns aggregated call stats + call documents for the Status dashboard.
//
// Two-query approach:
//   1. Live calls  — status IN [queued, scheduled, dialing, active, hold]
//                    No date filter — these are always small in count.
//   2. Today's log — createdAt >= midnight today (all terminal statuses)
//                    Uses createdAt (set at creation) not startedAt (set later).
//
// conversation[] is intentionally stripped from the list response — it can be
// hundreds of entries. Use GET /getConversation?callId= for the full transcript.
//
// Composite indexes required in Firestore (create via console or firestore.indexes.json):
//   Collection: calls  Fields: dbName ASC, status ASC            (for live query)
//   Collection: calls  Fields: dbName ASC, createdAt DESC        (for log query)
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('getStatus', async (req, res) => {
  setCors(res);
  if (handlePreflight(req, res)) return;

  const dbName = req.query.db;
  if (!dbName) return res.status(400).json({ error: 'Missing ?db= parameter' });

  const LIVE_STATUSES = ['queued', 'scheduled', 'dialing', 'active', 'hold'];

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // ── Query 1: live / in-flight calls (no date restriction) ─────────────────
    const liveSnap = await db.collection('calls')
      .where('dbName',  '==', dbName)
      .where('status',  'in', LIVE_STATUSES)
      .limit(50)
      .get();

    // ── Query 2: today's completed / terminal calls ────────────────────────────
    const logSnap = await db.collection('calls')
      .where('dbName',    '==', dbName)
      .where('createdAt', '>=', today)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    // Merge, deduplicate by id, live calls take precedence over stale log snapshot
    const seen  = new Set();
    const calls = [];

    function addDoc(doc) {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      const d = doc.data();
      calls.push({
        id:                  doc.id,
        dbName:              d.dbName,
        status:              d.status,
        outcome:             d.outcome             || null,
        vehicleId:           d.vehicleId           || null,
        vehicleName:         d.vehicleName         || null,
        exceptionName:       d.exceptionName       || null,
        driverName:          d.driverName          || null,
        ruleSeverity:        d.ruleSeverity        || null,
        contactIndex:        d.contactIndex        ?? 0,
        totalContacts:       d.totalContacts       ?? null,
        currentContactName:  d.currentContactName  || null,
        currentContactPhone: d.currentContactPhone || null,
        holdNote:            d.holdNote            || null,
        durationSeconds:     d.durationSeconds     || null,
        smsFallbackSent:     d.smsFallbackSent     || false,
        smsFallbackTo:       d.smsFallbackTo       || null,
        twilioCallSid:       d.twilioCallSid       || null,
        // Timestamps → ISO strings
        createdAt:  d.createdAt?.toDate?.()?.toISOString()         || null,
        startedAt:  d.startedAt?.toDate?.()?.toISOString()         || null,
        endedAt:    d.endedAt?.toDate?.()?.toISOString()           || null,
        updatedAt:  d.updatedAt?.toDate?.()?.toISOString()         || null,
        smsFallbackSentAt: d.smsFallbackSentAt?.toDate?.()?.toISOString() || null,
        // conversation deliberately excluded — use getConversation endpoint
      });
    }

    liveSnap.docs.forEach(addDoc);
    logSnap.docs.forEach(addDoc);

    // Sort: live first (by createdAt desc), then log (by createdAt desc)
    calls.sort((a, b) => {
      const aLive = LIVE_STATUSES.includes(a.status);
      const bLive = LIVE_STATUSES.includes(b.status);
      if (aLive !== bLive) return aLive ? -1 : 1;
      return (b.createdAt || '') > (a.createdAt || '') ? 1 : -1;
    });

    // ── Stats ─────────────────────────────────────────────────────────────────
    const liveActive  = calls.filter(c => ['active', 'dialing'].includes(c.status));
    const completed   = calls.filter(c => c.status === 'completed');
    const escalated   = calls.filter(c => ['escalated', 'no-answer', 'escalation-exhausted'].includes(c.status));
    const smsFallbacks = calls.filter(c => c.smsFallbackSent);

    const durations   = completed.filter(c => c.durationSeconds > 0);
    const avgDuration = durations.length
      ? Math.round(durations.reduce((s, c) => s + c.durationSeconds, 0) / durations.length)
      : null;

    const acknowledged = completed.filter(c => c.outcome === 'acknowledged');
    const avgTurns     = null; // future: avg conversation turns

    return res.json({
      calls,
      stats: {
        todayTotal:          calls.length,
        activeNow:           liveActive.length,
        escalations:         escalated.length,
        smsFallbacks:        smsFallbacks.length,
        avgDurationSeconds:  avgDuration,
        acknowledged:        acknowledged.length,
      }
    });
  } catch (err) {
    console.error('[getStatus]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /getConversation?callId={callId}
// Returns the full conversation transcript for a single call.
// Kept separate from getStatus to avoid sending large arrays in the bulk response.
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('getConversation', async (req, res) => {
  setCors(res);
  if (handlePreflight(req, res)) return;

  const { callId } = req.query;
  if (!callId) return res.status(400).json({ error: 'Missing ?callId= parameter' });

  try {
    const snap = await db.collection('calls').doc(callId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Call not found' });

    const d = snap.data();
    return res.json({
      callId,
      conversation: d.conversation || [],
      script:       d.script       || '',
      status:       d.status,
      outcome:      d.outcome      || null,
    });
  } catch (err) {
    console.error('[getConversation]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /testTwilio
// Body: { dbName }
// Validates Twilio credentials by fetching the account info.
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('testTwilio', async (req, res) => {
  setCors(res);
  if (handlePreflight(req, res)) return;

  const { dbName } = req.body || {};
  if (!dbName) return res.status(400).json({ error: 'Missing dbName' });

  try {
    const docSnap = await db.collection('configs').doc(dbName).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'No config found for this database' });

    const config = docSnap.data();
    if (!config.twilioAccountSid || !config.twilioAuthToken) {
      return res.status(400).json({ error: 'Twilio credentials not configured' });
    }

    let authToken;
    try {
      authToken = decrypt(config.twilioAuthToken);
    } catch {
      return res.status(400).json({ error: 'Failed to decrypt stored auth token. Re-enter it.' });
    }

    const client = twilio(config.twilioAccountSid, authToken);
    const account = await client.api.accounts(config.twilioAccountSid).fetch();

    return res.json({
      success:     true,
      accountName: account.friendlyName,
      status:      account.status
    });
  } catch (err) {
    console.error('[testTwilio]', err);
    return res.status(400).json({ error: err.message || 'Twilio connection failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /retryCall
// Re-queues a call that ended without acknowledgement.
// Resets contactIndex to 0 (start the escalation chain over).
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('retryCall', async (req, res) => {
  setCors(res);
  if (handlePreflight(req, res)) return;
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'Missing callId' });
  try {
    const snap = await db.collection('calls').doc(callId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Call not found' });
    const call = snap.data();

    // If there's an active Twilio call, cancel it first
    if (call.twilioCallSid && call.dbName) {
      try {
        const configSnap = await db.collection('configs').doc(call.dbName).get();
        const config = configSnap.data() || {};
        if (config.twilioAccountSid && config.twilioAuthToken) {
          const authToken = decrypt(config.twilioAuthToken);
          const client = twilio(config.twilioAccountSid, authToken);
          await client.calls(call.twilioCallSid).update({ status: 'completed' });
        }
      } catch (e) {
        console.warn('[retryCall] Could not cancel active Twilio call:', e.message);
      }
    }

    // Load first contact name for display
    const configSnap = await db.collection('configs').doc(call.dbName).get();
    const contacts = configSnap.data()?.escalationContacts || [];
    const firstContact = contacts[0] || {};

    await db.collection('calls').doc(callId).update({
      status:              'queued',
      contactIndex:        0,
      currentContactName:  firstContact.name  || '',
      currentContactPhone: firstContact.phone || '',
      twilioCallSid:       null,
      startedAt:           null,
      endedAt:             null,
      durationSeconds:     null,
      conversation:        [],
      updatedAt:           FieldValue.serverTimestamp()
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[retryCall]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /dismissCall
// Dismisses a call — if active, cancels it via Twilio first.
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('dismissCall', async (req, res) => {
  setCors(res);
  if (handlePreflight(req, res)) return;
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'Missing callId' });
  try {
    const snap = await db.collection('calls').doc(callId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Call not found' });
    const call = snap.data();

    // Cancel active Twilio call if one exists
    if (call.twilioCallSid && call.dbName) {
      try {
        const configSnap = await db.collection('configs').doc(call.dbName).get();
        const config = configSnap.data() || {};
        if (config.twilioAccountSid && config.twilioAuthToken) {
          const authToken = decrypt(config.twilioAuthToken);
          const client = twilio(config.twilioAccountSid, authToken);
          await client.calls(call.twilioCallSid).update({ status: 'completed' });
        }
      } catch (e) {
        console.warn('[dismissCall] Could not cancel Twilio call:', e.message);
      }
    }

    await db.collection('calls').doc(callId).update({
      status:      'dismissed',
      outcome:     'dismissed',
      endedAt:     FieldValue.serverTimestamp(),
      updatedAt:   FieldValue.serverTimestamp()
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[dismissCall]', err);
    return res.status(500).json({ error: err.message });
  }
});
