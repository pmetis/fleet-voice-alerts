'use strict';

/**
 * Fleet Voice Alerts — Voice Engine (Day 3)
 *
 * Three Cloud Functions:
 *
 *  initiateCall        — Cloud Scheduler every 60s. Picks up queued call docs
 *                        from Firestore and dials supervisors via Twilio.
 *
 *  voiceResponse       — Twilio webhook. Stateless TwiML state machine.
 *                        Plays script, gathers supervisor speech/DTMF,
 *                        answers Q&A from cachedQA, escalates on no-answer.
 *
 *  callStatusCallback  — Twilio status callback. Updates call doc when
 *                        Twilio reports the call has ended. Triggers
 *                        escalation to next contact if no-answer/busy/failed.
 *
 * All state lives in Firestore — these functions are fully stateless.
 *
 * Deployment:
 *   npm run deploy:day3
 *
 * Cloud Scheduler job for initiateCall:
 *   gcloud scheduler jobs create http initiate-fleet-calls \
 *     --schedule "* * * * *" \
 *     --uri https://REGION-PROJECT.cloudfunctions.net/initiateCall \
 *     --http-method POST \
 *     --message-body '{}' \
 *     --time-zone "UTC" \
 *     --attempt-deadline 120s
 */

const functions  = require('@google-cloud/functions-framework');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const twilio     = require('twilio');

const { decrypt }             = require('./lib/crypto');
const { isInScheduleWindow }  = require('./lib/scheduleCheck');
const { synthesizeAndCache, synthesizeMany } = require('./lib/ttsCache');
const { askAceLive, resumeAcePoll } = require('./lib/aceQuery');
const { GeotabClient }              = require('./lib/geotabClient');

const db = new Firestore();

// ─── Voice / TTS config ──────────────────────────────────────────────────────
// WaveNet voices are synthesized via lib/ttsCache.js and served as GCS-signed
// URLs to Twilio's <Play> tag. VOICE_CONFIG is kept here for the <Say> fallback
// only — used when TTS synthesis fails so the call doesn't go silent.
const VOICE_CONFIG = {
  en: { voice: 'Polly.Matthew',  language: 'en-US' },
  es: { voice: 'Polly.Miguel',   language: 'es-US' },
  pt: { voice: 'Polly.Ricardo',  language: 'pt-BR' }
};

// Twilio speech recognition language codes — tells Twilio STT which language
// to transcribe. Without this it always defaults to en-US regardless of lang.
const GATHER_LANG = {
  en: 'en-US',
  es: 'es-MX',   // es-MX works better for Latin American Spanish
  pt: 'pt-BR'
};

// DTMF key assignments (same across all languages — digits are universal)
// * mirrors 2 (repeat) — a common phone-system convention for "say again"
const DTMF = {
  ACKNOWLEDGE: '1',
  REPEAT:      '2',
  DISMISS:     '9',
  ESCALATE:    '0',
  STAR:        '*'   // same as REPEAT
};

// Full menu — played on first greeting and on explicit repeat request (key 2 / *)
const MENU_PROMPTS_FULL = {
  en: `Press 1 or say "confirmed" to acknowledge this alert. Press 2 or star to repeat this message. Press 9 or say "dismiss" to close the alert. Press 0 to escalate to the next supervisor. Or simply ask any question about this alert.`,
  es: `Presione 1 o diga "confirmado" para reconocer esta alerta. Presione 2 o asterisco para repetir este mensaje. Presione 9 o diga "descartar" para cerrar la alerta. Presione 0 para escalar al siguiente supervisor. O haga cualquier pregunta sobre esta alerta.`,
  pt: `Pressione 1 ou diga "confirmado" para reconhecer este alerta. Pressione 2 ou asterisco para repetir esta mensagem. Pressione 9 ou diga "descartar" para fechar o alerta. Pressione 0 para escalar para o próximo supervisor. Ou faça qualquer pergunta sobre este alerta.`
};

// Short menu — used after Q&A answers and as unintelligible fallback
// No need to re-announce all options every turn; supervisor already heard them
const MENU_PROMPTS_SHORT = {
  en: 'Press 1 to confirm, 9 to dismiss, 2 to repeat, or ask a question.',
  es: 'Presione 1 para confirmar, 9 para descartar, 2 para repetir, o haga una pregunta.',
  pt: 'Pressione 1 para confirmar, 9 para descartar, 2 para repetir, ou faça uma pergunta.'
};

const REPEAT_PROMPTS = {
  en: "I didn't catch that. ",
  es: 'No entendí. ',
  pt: 'Não entendi. '
};

const FAREWELL = {
  acknowledged: {
    en: 'Thank you for confirming. The alert has been acknowledged. Goodbye.',
    es: 'Gracias por confirmar. La alerta ha sido reconocida. Hasta luego.',
    pt: 'Obrigado por confirmar. O alerta foi reconhecido. Tchau.'
  },
  dismissed: {
    en: 'Alert dismissed. Goodbye.',
    es: 'Alerta descartada. Hasta luego.',
    pt: 'Alerta descartado. Tchau.'
  },
  escalating: {
    en: 'Escalating to the next supervisor. Goodbye.',
    es: 'Escalando al siguiente supervisor. Hasta luego.',
    pt: 'Escalando para o próximo supervisor. Tchau.'
  },
  no_more_contacts: {
    en: 'No further supervisors available. The alert has been logged. Goodbye.',
    es: 'No hay más supervisores disponibles. La alerta ha sido registrada. Hasta luego.',
    pt: 'Nenhum supervisor adicional disponível. O alerta foi registrado. Tchau.'
  }
};

const NO_MATCH_RESPONSE = {
  en: "I don't have a specific answer for that, but it has been noted. Is there anything else?",
  es: 'No tengo una respuesta específica para eso, pero ha sido anotado. ¿Hay algo más?',
  pt: 'Não tenho uma resposta específica para isso, mas foi anotado. Há mais alguma coisa?'
};

// Spoken while ACE is being queried — buys time in the double-webhook pattern
const THINKING_PROMPTS = {
  en: 'Let me check on that for you.',
  es: 'Déjame verificar eso para usted.',
  pt: 'Deixe-me verificar isso para você.'
};

// Fallback when ACE times out or errors during a live call
const ACE_TIMEOUT_RESPONSE = {
  en: "I wasn't able to retrieve that information right now. Please ask again or check the fleet management system.",
  es: 'No pude obtener esa información en este momento. Por favor, pregunte de nuevo o consulte el sistema de gestión de flota.',
  pt: 'Não consegui obter essa informação agora. Por favor, pergunte novamente ou consulte o sistema de gestão de frota.'
};

// ─── Waiting prompts — played between ACE polling rounds ─────────────────────
// Each round is ~12s. Up to MAX_ACE_ROUNDS rounds = ~60s total wait budget.
// Different phrase per round so the caller doesn't hear the same thing twice.
const WAITING_PROMPTS = {
  en: [
    'One moment, consulting the fleet system.',
    'Still working on that, please hold.',
    'Almost there, processing your question.',
    'Just a few more seconds.',
    'Thank you for your patience.'
  ],
  es: [
    'Un momento, consultando el sistema de flota.',
    'Seguimos procesando, espere en línea.',
    'Ya casi, procesando su consulta.',
    'Solo unos segundos más.',
    'Gracias por su paciencia.'
  ],
  pt: [
    'Um momento, consultando o sistema de frota.',
    'Ainda processando, por favor aguarde.',
    'Quase pronto, processando sua consulta.',
    'Só mais alguns segundos.',
    'Obrigado pela sua paciência.'
  ]
};

// Max ACE polling rounds before giving up (each round ~12s → 5 rounds = ~60s)
const MAX_ACE_ROUNDS = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function voiceFor(lang) {
  return VOICE_CONFIG[lang] || VOICE_CONFIG.en;
}

/** <Say> fallback — used when TTS synthesis fails so the call doesn't go silent. */
function sayFallback(text, lang) {
  const { voice, language } = voiceFor(lang);
  const safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<Say voice="${voice}" language="${language}">${safe}</Say>`;
}

/**
 * Resolve audio for a text string.
 * Returns a <Play> tag if TTS succeeds, falls back to <Say> on error.
 * Always resolves — never throws — so a TTS failure never breaks a call.
 */
async function ttsTag(text, lang) {
  try {
    const url = await synthesizeAndCache(text, lang);
    // Twilio <Play> URL must be XML-attribute safe
    const safeUrl = url.replace(/&/g, '&amp;');
    return `<Play>${safeUrl}</Play>`;
  } catch (err) {
    console.warn(`[TTS] Falling back to <Say> for lang=${lang}:`, err.message);
    return sayFallback(text, lang);
  }
}

/**
 * Build a <Gather> that plays a TTS audio file while listening for input.
 * Twilio supports <Play> nested inside <Gather> since TwiML 2.x.
 * actionUrl must already be XML-attribute safe (& → &amp;).
 *
 * numDigits defaults to 1 — a single keypress submits immediately without
 * waiting for # or timeout. This is correct for single-key menus and also
 * works with speech (Twilio submits on first digit OR after speech ends).
 *
 * language= tells Twilio STT which language to use for transcription.
 * Without it, Twilio always defaults to en-US regardless of the call lang.
 */
async function gatherWithTts(text, actionUrl, lang, { timeout = 10, numDigits = 1 } = {}) {
  const safeUrl    = actionUrl.replace(/&(?!amp;)/g, '&amp;');
  const audio      = await ttsTag(text, lang);
  const gatherLang = GATHER_LANG[lang] || 'en-US';
  return `<Gather input="speech dtmf" numDigits="${numDigits}" timeout="${timeout}" speechTimeout="auto" language="${gatherLang}" action="${safeUrl}" method="POST">
  ${audio}
</Gather>`;
}

/** Build the full action URL for a voiceResponse step.
 * Returns a plain URL (with bare &). Use stepUrlXml() when embedding in TwiML attributes.
 */
function stepUrl(webhookBase, callId, step, extra = '') {
  return `${webhookBase}/voiceResponse?callId=${callId}&step=${step}${extra}`;
}

/** XML-safe version of stepUrl — escapes & as &amp; for use in TwiML attributes.
 * Twilio parses TwiML as XML, so bare & in attribute values causes a parse error
 * and Twilio reports "Application Error" to the caller.
 */
function stepUrlXml(webhookBase, callId, step, extra = '') {
  return stepUrl(webhookBase, callId, step, extra).replace(/&/g, '&amp;');
}

/** Build the callStatusCallback URL (points to a different function). */
function statusCbUrl(webhookBase, callId) {
  return `${webhookBase}/callStatusCallback?callId=${callId}`;
}

/** Simple keyword-based Q&A match against cachedQA keys */
function matchQA(speechInput, cachedQA) {
  if (!speechInput || !cachedQA || !Object.keys(cachedQA).length) return null;
  const input = speechInput.toLowerCase();

  // Exact question key match first
  for (const [question, answer] of Object.entries(cachedQA)) {
    if (input.includes(question.toLowerCase())) return answer;
  }

  // Keyword overlap — score each question by word hits
  let bestMatch = null;
  let bestScore = 0;
  const inputWords = new Set(input.split(/\W+/).filter(w => w.length > 3));

  for (const [question, answer] of Object.entries(cachedQA)) {
    const qWords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const hits   = qWords.filter(w => inputWords.has(w)).length;
    const score  = hits / Math.max(qWords.length, 1);
    if (score > bestScore && score >= 0.4) {
      bestScore = score;
      bestMatch = answer;
    }
  }
  return bestMatch;
}

/** Append a message to the conversation array in Firestore */
async function appendConversation(callId, speaker, text) {
  try {
    await db.collection('calls').doc(callId).update({
      conversation: FieldValue.arrayUnion({
        speaker,
        text:      text.slice(0, 500), // cap length
        timestamp: new Date().toISOString()
      }),
      updatedAt: FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.warn(`[voice] conversation append failed for ${callId}:`, e.message);
  }
}

/** Load Twilio client from config */
async function twilioClientForDb(dbName) {
  const snap = await db.collection('configs').doc(dbName).get();
  if (!snap.exists) throw new Error(`Config not found for ${dbName}`);
  const config = snap.data();
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    throw new Error('Twilio credentials not configured');
  }
  const authToken = decrypt(config.twilioAuthToken);
  return {
    client: twilio(config.twilioAccountSid, authToken),
    config
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// initiateCall
// Cloud Scheduler triggers this every 60 seconds.
// Picks up all call docs with status 'queued', dials via Twilio, sets 'active'.
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('initiateCall', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const now = new Date();

  try {
    // Query all queued + scheduled calls across all databases.
    // 'scheduled' includes: calls outside the time window, and calls that were
    // held because all contacts were busy on a previous tick.
    const snapshot = await db.collection('calls')
      .where('status', 'in', ['queued', 'scheduled'])
      .limit(50)   // safety cap — process up to 50 per tick
      .get();

    if (snapshot.empty) {
      return res.json({ success: true, initiated: 0 });
    }

    // Build a set of phone numbers currently in active/dialing calls.
    // A contact whose phone is already on a live call should not be dialled again —
    // new alerts for them skip to the next escalation contact or wait as 'scheduled'.
    const activeSnap = await db.collection('calls')
      .where('status', 'in', ['active', 'dialing'])
      .select('currentContactPhone')
      .get();
    const busyPhones = new Set(
      activeSnap.docs
        .map(d => d.data().currentContactPhone)
        .filter(Boolean)
    );

    const results = [];

    for (const doc of snapshot.docs) {
      const callId   = doc.id;
      const call     = doc.data();
      const dbName   = call.dbName;

      try {
        // Load config + check schedule window
        const configSnap = await db.collection('configs').doc(dbName).get();
        if (!configSnap.exists) {
          console.warn(`[initiate:${callId}] config not found for ${dbName}`);
          continue;
        }
        const config = configSnap.data();

        // Re-check schedule window (call may have been queued hours ago)
        const { inWindow, reason } = isInScheduleWindow(config.schedule, now);
        if (!inWindow) {
          console.log(`[initiate:${callId}] Outside schedule window: ${reason} — leaving queued`);
          continue;
        }

        // Walk the escalation chain to find a contact that isn't currently busy
        const contacts   = config.escalationContacts || [];
        let contactIdx   = call.contactIndex || 0;
        let contact      = null;

        while (contactIdx < contacts.length) {
          const candidate = contacts[contactIdx];
          if (!candidate?.phone) { contactIdx++; continue; }

          if (busyPhones.has(candidate.phone)) {
            // This contact is on another live call — try the next in chain
            console.log(`[initiate:${callId}] ${candidate.phone} busy — checking next escalation contact`);
            contactIdx++;
            continue;
          }
          contact = candidate;
          break;
        }

        if (!contact) {
          // All contacts busy or phone missing — hold as 'scheduled', retry next tick
          const allBusy = contacts.slice(call.contactIndex || 0)
            .some(c => c?.phone && busyPhones.has(c.phone));
          if (allBusy) {
            console.log(`[initiate:${callId}] All contacts busy — holding as scheduled`);
            await db.collection('calls').doc(callId).update({
              status:    'scheduled',
              holdNote:  'All contacts currently on calls — will retry',
              updatedAt: FieldValue.serverTimestamp()
            });
          } else {
            console.warn(`[initiate:${callId}] No contact phone found — marking failed`);
            await db.collection('calls').doc(callId).update({
              status:   'failed',
              failNote: 'No contact phone configured',
              updatedAt: FieldValue.serverTimestamp()
            });
          }
          continue;
        }

        // If we had to advance past the original contact, update the doc
        if (contactIdx !== (call.contactIndex || 0)) {
          console.log(`[initiate:${callId}] Advanced contact from ${call.contactIndex} to ${contactIdx}`);
        }

        // Validate Twilio config
        if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber) {
          console.warn(`[initiate:${callId}] Twilio not configured for ${dbName}`);
          continue;
        }
        const authToken = decrypt(config.twilioAuthToken);
        const client    = twilio(config.twilioAccountSid, authToken);

        const webhookBase = config.webhookBaseUrl;
        if (!webhookBase) {
          console.warn(`[initiate:${callId}] webhookBaseUrl not set for ${dbName}`);
          continue;
        }

        // Mark as 'dialing' immediately to prevent double-dial on next tick.
        // Also add this phone to busyPhones so subsequent calls in this tick
        // don't try to dial the same contact concurrently.
        busyPhones.add(contact.phone);
        await db.collection('calls').doc(callId).update({
          status:              'dialing',
          contactIndex:        contactIdx,
          currentContactName:  contact.name  || '',
          currentContactPhone: contact.phone || '',
          startedAt:           FieldValue.serverTimestamp(),
          updatedAt:           FieldValue.serverTimestamp()
        });

        // Initiate Twilio call
        const twilioCall = await client.calls.create({
          to:     contact.phone,
          from:   config.twilioFromNumber,
          url:    stepUrl(webhookBase, callId, 'greeting'),
          statusCallback:       statusCbUrl(webhookBase, callId),
          statusCallbackMethod: 'POST',
          statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
          timeout:  30,   // ring timeout in seconds before no-answer
          machineDetection: 'Enable' // hang up on voicemail
        });

        // Update call with Twilio SID → status active
        await db.collection('calls').doc(callId).update({
          twilioCallSid: twilioCall.sid,
          status:        'active',
          updatedAt:     FieldValue.serverTimestamp()
        });

        console.log(`[initiate] Dialed ${contact.phone} for call ${callId} — Twilio SID: ${twilioCall.sid}`);
        results.push({ callId, to: contact.phone, sid: twilioCall.sid });

      } catch (err) {
        console.error(`[initiate:${callId}] Error:`, err.message);
        // Roll back to queued so it retries next tick
        await db.collection('calls').doc(callId).update({
          status:    'queued',
          updatedAt: FieldValue.serverTimestamp()
        }).catch(() => {});
        results.push({ callId, error: err.message });
      }
    }

    return res.json({ success: true, initiated: results.filter(r => !r.error).length, results });

  } catch (err) {
    console.error('[initiateCall] Fatal:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// voiceResponse
// Twilio webhook — returns TwiML for each turn of the conversation.
//
// URL params (set by us when constructing the Twilio call URL):
//   callId  — Firestore call document ID
//   step    — conversation state: greeting | respond | qa | farewell | no-input-N
//   round   — ACE polling round number (only used in ace-lookup step)
//
// POST body from Twilio:
//   SpeechResult  — transcribed speech (if any)
//   Digits        — DTMF key pressed (if any)
//   CallStatus    — current call status
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('voiceResponse', async (req, res) => {
  res.set('Content-Type', 'text/xml');

  const callId = req.query.callId;
  const step   = req.query.step || 'greeting';

  if (!callId) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Invalid call configuration.</Say><Hangup/></Response>`);
  }

  // Load call document
  let call;
  try {
    const snap = await db.collection('calls').doc(callId).get();
    if (!snap.exists) throw new Error('Call document not found');
    call = snap.data();
  } catch (err) {
    console.error(`[voice:${callId}] Load failed:`, err.message);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>System error. The alert has been logged.</Say><Hangup/></Response>`);
  }

  const lang        = call.lang || 'en';
  const webhookBase = call.webhookBase || req.query.webhookBase || '';
  const cachedQA    = call.cachedQA || {};
  const script      = call.script || '';

  // Helper: build XML-safe action URL for the next gather/redirect.
  // Must use stepUrlXml because URLs are embedded in TwiML XML attributes.
  const base        = webhookBase || `${req.protocol}://${req.headers.host}`;
  const nextUrl     = (nextStep, extra = '') => stepUrlXml(base, callId, nextStep, extra);
  // Redirect element content also requires & → &amp; (XML text node, same rule)
  const nextRedirect = (nextStep) => stepUrl(base, callId, nextStep).replace(/&/g, '&amp;');

  let twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n`;

  // ── Step: greeting ──────────────────────────────────────────────────────────
  if (step === 'greeting') {
    await appendConversation(callId, 'system', script);

    // The script and the menu prompt are intentionally separated:
    //   <Play> (script)  — bare, outside <Gather>.  Twilio plays it fully.
    //                      No VAD is active here, so the supervisor can't
    //                      accidentally barge in mid-sentence.
    //   <Gather> (menu)  — opens AFTER the script ends.  The supervisor
    //                      now hears the options and can respond cleanly.
    //
    // numDigits="1" on the Gather means any single keypress submits
    // immediately — no need to press # after the digit.
    const menuText = MENU_PROMPTS_FULL[lang] || MENU_PROMPTS_FULL.en;
    const [scriptAudio, menuAudio] = await Promise.all([
      ttsTag(script, lang),
      ttsTag(menuText, lang)
    ]);

    twiml += scriptAudio;   // plays fully, no interruption
    const safeRespondUrl = nextUrl('respond');
    const gatherLang     = GATHER_LANG[lang] || 'en-US';
    twiml += `<Gather input="speech dtmf" numDigits="1" timeout="10" speechTimeout="auto" language="${gatherLang}" action="${safeRespondUrl}" method="POST">
  ${menuAudio}
</Gather>`;
    twiml += `<Redirect method="POST">${nextRedirect('no-input-1')}</Redirect>`;

  // ── Step: respond — process supervisor input ────────────────────────────────
  } else if (step === 'respond') {
    const speech = (req.body?.SpeechResult || '').toLowerCase().trim();
    const digit  = (req.body?.Digits || '').trim();

    await appendConversation(callId, 'supervisor', speech || digit || '(no input)');

    // ── Acknowledge — key 1 or spoken keywords (EN + ES + PT)
    if (digit === DTMF.ACKNOWLEDGE ||
        /\b(confirm|acknowledged|yes|got it|confirmado|ok|confirmar|sim|reconhecer)\b/.test(speech)) {
      await db.collection('calls').doc(callId).update({
        status:    'completed',
        outcome:   'acknowledged',
        endedAt:   FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      twiml += await ttsTag(FAREWELL.acknowledged[lang] || FAREWELL.acknowledged.en, lang);
      twiml += '<Hangup/>';

    // ── Dismiss — key 9 or spoken keywords (EN + ES + PT)
    } else if (digit === DTMF.DISMISS ||
               /\b(dismiss|close|cancel|ignore|descartar|eliminar|cerrar|cancelar|fechar)\b/.test(speech)) {
      await db.collection('calls').doc(callId).update({
        status:    'dismissed',
        outcome:   'dismissed',
        endedAt:   FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      twiml += await ttsTag(FAREWELL.dismissed[lang] || FAREWELL.dismissed.en, lang);
      twiml += '<Hangup/>';

    // ── Escalate — key 0 or spoken keywords (EN + ES + PT)
    } else if (digit === DTMF.ESCALATE ||
               /\b(escalat|transfer|next|escalar|otro|siguiente|transferir)\b/.test(speech)) {
      await triggerEscalation(callId, call, 'manual-escalation');
      twiml += await ttsTag(FAREWELL.escalating[lang] || FAREWELL.escalating.en, lang);
      twiml += '<Hangup/>';

    // ── Repeat — key 2 or * — play full script + full menu
    } else if (digit === DTMF.REPEAT || digit === DTMF.STAR) {
      await appendConversation(callId, 'system', '(repeat requested)');
      const fullText = `${script} ${MENU_PROMPTS_FULL[lang] || MENU_PROMPTS_FULL.en}`;
      twiml += await gatherWithTts(fullText, nextUrl('respond'), lang, { timeout: 12 });
      twiml += `<Redirect method="POST">${nextRedirect('no-input-1')}</Redirect>`;

    // ── Question — supervisor asked something
    } else if (speech.length > 3) {
      const answer = matchQA(speech, cachedQA);
      if (answer) {
        // Cache hit — respond instantly
        await appendConversation(callId, 'system', answer);
        const fullAnswer = `${answer} ${MENU_PROMPTS_SHORT[lang] || MENU_PROMPTS_SHORT.en}`;
        twiml += await gatherWithTts(fullAnswer, nextUrl('respond'), lang, { timeout: 12 });
        twiml += `<Redirect method="POST">${nextRedirect('no-input-1')}</Redirect>`;
      } else {
        // Cache miss — start ACE live lookup with round-based polling.
        // Round 0: play thinking phrase → redirect to ace-lookup&round=0
        await db.collection('calls').doc(callId).update({
          pendingQuestion: speech,
          updatedAt:       FieldValue.serverTimestamp()
        });
        await appendConversation(callId, 'supervisor-question', speech);
        const thinkingText = THINKING_PROMPTS[lang] || THINKING_PROMPTS.en;
        twiml += await ttsTag(thinkingText, lang);
        twiml += `<Redirect method="POST">${stepUrl(base, callId, 'ace-lookup', '&round=0').replace(/&/g, '&amp;')}</Redirect>`;
      }

    // ── No recognisable input — short re-prompt
    } else {
      const shortPrompt = MENU_PROMPTS_SHORT[lang] || MENU_PROMPTS_SHORT.en;
      twiml += await gatherWithTts(shortPrompt, nextUrl('respond'), lang, { timeout: 10 });
      twiml += `<Redirect method="POST">${nextRedirect('no-input-1')}</Redirect>`;
    }

  // ── Step: no-input-1 — first silence → replay full menu only (not script) ───
  } else if (step === 'no-input-1') {
    const prompt = `${REPEAT_PROMPTS[lang]}${MENU_PROMPTS_FULL[lang] || MENU_PROMPTS_FULL.en}`;
    twiml += await gatherWithTts(prompt, nextUrl('respond'), lang, { timeout: 12 });
    twiml += `<Redirect method="POST">${nextRedirect('no-input-2')}</Redirect>`;

  // ── Step: no-input-2 — second silence → escalate ───────────────────────────
  } else if (step === 'no-input-2') {
    await triggerEscalation(callId, call, 'no-input');
    twiml += await ttsTag(FAREWELL.escalating[lang] || FAREWELL.escalating.en, lang);
    twiml += '<Hangup/>';

  // ── Step: farewell — clean hangup ──────────────────────────────────────────
  } else if (step === 'farewell') {
    twiml += await ttsTag(FAREWELL.acknowledged[lang] || FAREWELL.acknowledged.en, lang);
    twiml += '<Hangup/>';

  // ── Step: ace-lookup — round-based ACE polling ──────────────────────────────
  //
  // Pattern:
  //   respond → "Un momento..." → ace-lookup&round=0
  //   ace-lookup round 0: call ACE (12s budget)
  //     → if answer: play it + gather
  //     → if timeout: play WAITING_PROMPTS[0] → ace-lookup&round=1
  //   ace-lookup round 1: call ACE again (fresh 12s budget)
  //     → if answer: play it + gather
  //     → if timeout: play WAITING_PROMPTS[1] → ace-lookup&round=2
  //   ...up to MAX_ACE_ROUNDS rounds (~60s total)
  //   after MAX_ACE_ROUNDS: play final fallback + gather
  //
  // Each Twilio webhook has its own ~15s budget, so chaining redirects
  // gives us unlimited time without violating Twilio's limits.
  } else if (step === 'ace-lookup') {
    // ── Round-based ACE polling ────────────────────────────────────────────────
    //
    // Round 0: askAceLive() → creates ACE session (create-chat + send-prompt),
    //          persists chatId + messageGroupId to Firestore, then polls ~12s.
    //
    // Rounds 1+: resumeAcePoll() → reads session IDs from Firestore,
    //            only calls get-message-group (no new session = no 429 errors).
    //
    // Each round is a fresh Twilio webhook (~15s budget). Chaining up to
    // MAX_ACE_ROUNDS rounds gives ~60s total wait without violating Twilio limits.
    //
    const pendingQ = call.pendingQuestion || '';
    const round    = parseInt(req.query.round || '0', 10);

    if (!pendingQ) {
      twiml += await gatherWithTts(
        `${REPEAT_PROMPTS[lang]}${MENU_PROMPTS_SHORT[lang] || MENU_PROMPTS_SHORT.en}`,
        nextUrl('respond'), lang, { timeout: 10 }
      );
      twiml += `<Redirect method="POST">${nextRedirect('no-input-1')}</Redirect>`;

    } else {
      let aceAnswer = null;
      try {
        const configSnap = await db.collection('configs').doc(call.dbName).get();
        if (configSnap.exists) {
          const config = configSnap.data();
          if (config.geotabUser && config.geotabPassword) {
            if (round === 0) {
              // Round 0: create new session + poll
              // Session IDs are persisted inside askAceLive via callAceStatefulWithPersist
              console.log(`[ace-lookup:${callId}] Round 0 — new ACE session for: "${pendingQ}"`);
              aceAnswer = await askAceLive(config, { ...call, callId }, pendingQ);
            } else {
              // Rounds 1+: resume polling existing session (NO new create-chat/send-prompt)
              console.log(`[ace-lookup:${callId}] Round ${round} — resuming poll chat=${call.aceSessionChatId}`);
              aceAnswer = await resumeAcePoll(config, { ...call, callId });
            }
          } else {
            console.warn(`[ace-lookup:${callId}] geotabUser/geotabPassword not configured`);
          }
        }
      } catch (err) {
        console.error(`[ace-lookup:${callId}] Round ${round} error:`, err.message);
      }

      if (aceAnswer) {
        // ✅ ACE responded — cache and play
        const updatedQA = { ...cachedQA, [pendingQ]: aceAnswer };
        await db.collection('calls').doc(callId).update({
          cachedQA:             updatedQA,
          pendingQuestion:      null,
          aceSessionChatId:     null,   // clean up session IDs
          aceSessionMsgGroupId: null,
          updatedAt:            FieldValue.serverTimestamp()
        });
        await appendConversation(callId, 'ace', aceAnswer);
        console.log(`[ace-lookup:${callId}] ACE answered on round ${round}`);

        const answerWithMenu = `${aceAnswer} ${MENU_PROMPTS_SHORT[lang] || MENU_PROMPTS_SHORT.en}`;
        twiml += await gatherWithTts(answerWithMenu, nextUrl('respond'), lang, { timeout: 12 });
        twiml += `<Redirect method="POST">${nextRedirect('no-input-1')}</Redirect>`;

      } else if (round < MAX_ACE_ROUNDS) {
        // ⏳ ACE still processing — play waiting phrase, go to next round
        const waitingPhrases = WAITING_PROMPTS[lang] || WAITING_PROMPTS.en;
        const phrase         = waitingPhrases[round] || waitingPhrases[waitingPhrases.length - 1];
        const nextRound      = round + 1;

        console.log(`[ace-lookup:${callId}] Round ${round} timed out — going to round ${nextRound}`);
        await appendConversation(callId, 'system', `(waiting round ${nextRound})`);

        const nextRoundUrl = stepUrl(base, callId, 'ace-lookup', `&round=${nextRound}`).replace(/&/g, '&amp;');
        twiml += await ttsTag(phrase, lang);
        twiml += `<Redirect method="POST">${nextRoundUrl}</Redirect>`;

      } else {
        // ❌ All rounds exhausted — fallback
        console.warn(`[ace-lookup:${callId}] All ${MAX_ACE_ROUNDS} rounds exhausted — fallback`);
        await db.collection('calls').doc(callId).update({
          pendingQuestion:      null,
          aceSessionChatId:     null,
          aceSessionMsgGroupId: null,
          updatedAt:            FieldValue.serverTimestamp()
        });
        await appendConversation(callId, 'system', ACE_TIMEOUT_RESPONSE[lang]);

        const fallbackText = `${ACE_TIMEOUT_RESPONSE[lang]} ${MENU_PROMPTS_SHORT[lang] || MENU_PROMPTS_SHORT.en}`;
        twiml += await gatherWithTts(fallbackText, nextUrl('respond'), lang, { timeout: 10 });
        twiml += `<Redirect method="POST">${nextRedirect('no-input-1')}</Redirect>`;
      }
    }

  } else {
    // Unknown step — <Say> fallback (no TTS round-trip on error path)
    twiml += sayFallback('An error occurred. The alert has been logged.', 'en');
    twiml += '<Hangup/>';
  }

  twiml += '\n</Response>';
  return res.send(twiml);
});

// ═══════════════════════════════════════════════════════════════════════════════
// callStatusCallback
// Twilio posts call lifecycle events here.
// We use 'completed' to record duration, and 'no-answer'/'busy'/'failed'
// to trigger escalation to the next contact.
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('callStatusCallback', async (req, res) => {
  // Twilio expects a 200 response immediately
  res.status(200).send('');

  const callId       = req.query.callId;
  const twilioStatus = req.body?.CallStatus || req.query.CallStatus || '';
  const duration     = parseInt(req.body?.CallDuration || '0', 10);
  const sid          = req.body?.CallSid || '';

  if (!callId) return;

  console.log(`[statusCb:${callId}] Twilio status: ${twilioStatus}, duration: ${duration}s`);

  try {
    const snap = await db.collection('calls').doc(callId).get();
    if (!snap.exists) return;
    const call = snap.data();

    // ── Call completed normally ────────────────────────────────────────────
    if (twilioStatus === 'completed') {
      // Only update if the app-level outcome hasn't already been set
      // (acknowledged/dismissed are set in voiceResponse before hangup)
      const update = {
        durationSeconds: duration,
        endedAt:         FieldValue.serverTimestamp(),
        updatedAt:       FieldValue.serverTimestamp()
      };
      if (!['acknowledged', 'dismissed', 'completed'].includes(call.status)) {
        update.status  = 'completed';
        update.outcome = 'completed-no-response';
      }
      await db.collection('calls').doc(callId).update(update);

    // ── No answer / busy / failed → escalate ──────────────────────────────
    } else if (['no-answer', 'busy', 'failed'].includes(twilioStatus)) {
      await triggerEscalation(callId, call, twilioStatus);

    // ── AMD: voicemail detected ─────────────────────────────────────────────
    } else if (twilioStatus === 'in-progress' && req.body?.AnsweredBy === 'machine_start') {
      // Hang up immediately — don't leave voicemail, try next contact
      const { client } = await twilioClientForDb(call.dbName).catch(() => ({ client: null }));
      if (client && sid) {
        await client.calls(sid).update({ status: 'completed' }).catch(() => {});
      }
      await triggerEscalation(callId, call, 'voicemail-detected');
    }

  } catch (err) {
    console.error(`[statusCb:${callId}] Error:`, err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// synthesize
// On-demand TTS endpoint.  voiceResponse never calls this — it uses
// synthesizeAndCache() directly.  This endpoint exists so the add-in UI can
// pre-warm the cache for a known script, and for manual testing.
//
// POST body: { text: string, lang: 'en'|'es'|'pt' }
// Returns:   { url: string }  — signed GCS URL valid for 1 hour
// ═══════════════════════════════════════════════════════════════════════════════
functions.http('synthesize', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const { text, lang } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Missing text' });

  try {
    const url = await synthesizeAndCache(text, lang || 'en');
    return res.json({ url });
  } catch (err) {
    console.error('[synthesize]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Escalation logic ─────────────────────────────────────────────────────────
/**
 * Attempt to escalate a call to the next contact in the escalation chain.
 * If no next contact exists, marks the call as escalation-exhausted.
 * The next tick of initiateCall will pick it up and dial the new contact.
 *
 * @param {string} callId
 * @param {object} callData  Current call document data
 * @param {string} reason    Why escalation was triggered
 */
async function triggerEscalation(callId, callData, reason) {
  const dbName    = callData.dbName;
  const nextIndex = (callData.contactIndex || 0) + 1;

  console.log(`[escalate:${callId}] Reason: ${reason} — trying contact index ${nextIndex}`);

  try {
    const configSnap = await db.collection('configs').doc(dbName).get();
    const contacts   = configSnap.data()?.escalationContacts || [];

    if (nextIndex < contacts.length && contacts[nextIndex]?.phone) {
      const nextContact = contacts[nextIndex];
      // Re-queue for next contact — initiateCall will pick it up
      await db.collection('calls').doc(callId).update({
        status:              'queued',
        contactIndex:        nextIndex,
        currentContactName:  nextContact.name  || '',
        currentContactPhone: nextContact.phone || '',
        escalationReason:    reason,
        escalationAt:        FieldValue.serverTimestamp(),
        updatedAt:           FieldValue.serverTimestamp()
      });
      console.log(`[escalate:${callId}] Re-queued for ${nextContact.name} (${nextContact.phone})`);
    } else {
      // Escalation chain exhausted — update status and send SMS fallback
      await db.collection('calls').doc(callId).update({
        status:           'escalation-exhausted',
        escalationReason: reason,
        endedAt:          FieldValue.serverTimestamp(),
        updatedAt:        FieldValue.serverTimestamp()
      });
      console.log(`[escalate:${callId}] No more contacts — escalation-exhausted`);

      // SMS fallback: notify the last contact (or first if chain had only one)
      // so no alert is silently lost when the entire voice chain fails.
      await sendSmsFallback(callId, callData, contacts, configSnap.data(), reason);
    }
  } catch (err) {
    console.error(`[escalate:${callId}] Error:`, err.message);
  }
}

// ─── SMS fallback ─────────────────────────────────────────────────────────────
/**
 * Send an SMS to the last contact in the escalation chain when all voice
 * attempts are exhausted. Uses the same Twilio credentials stored in config.
 * Non-fatal — a failure here is logged but does not affect the call status.
 *
 * @param {string} callId
 * @param {object} callData   Call document data
 * @param {Array}  contacts   Full escalation contacts array from config
 * @param {object} config     Firestore config document data (already loaded)
 * @param {string} reason     Why escalation was triggered (for the SMS body)
 */
async function sendSmsFallback(callId, callData, contacts, config, reason) {
  try {
    if (!config?.twilioAccountSid || !config?.twilioAuthToken || !config?.twilioFromNumber) {
      console.warn(`[sms-fallback:${callId}] Twilio not configured — skipping SMS`);
      return;
    }

    // Target: last contact attempted, or first contact if none were tried
    const lastIdx = Math.max(0, (callData.contactIndex || 0));
    const target  = contacts[lastIdx] || contacts[0];
    if (!target?.phone) {
      console.warn(`[sms-fallback:${callId}] No target phone for SMS`);
      return;
    }

    const authToken = decrypt(config.twilioAuthToken);
    const client    = twilio(config.twilioAccountSid, authToken);

    // Build a concise SMS — max 160 chars to stay in a single segment
    const vehicle   = callData.vehicleName  || callData.vehicleId  || 'Unknown vehicle';
    const exception = callData.exceptionName || 'Fleet exception';
    const body      = `[Fleet Alert] ${exception} on ${vehicle}. All voice contacts unreachable (${reason}). Please check your fleet management system immediately. Call ID: ${callId.slice(0, 8)}`;

    await client.messages.create({
      to:   target.phone,
      from: config.twilioFromNumber,
      body: body.slice(0, 320) // cap at 2 SMS segments
    });

    console.log(`[sms-fallback:${callId}] SMS sent to ${target.phone}`);

    // Record in Firestore so the dashboard can show "SMS sent" badge
    await db.collection('calls').doc(callId).update({
      smsFallbackSent:   true,
      smsFallbackTo:     target.phone,
      smsFallbackSentAt: FieldValue.serverTimestamp()
    });

  } catch (err) {
    // Non-fatal — log and move on, the call status is already escalation-exhausted
    console.error(`[sms-fallback:${callId}] Failed to send SMS:`, err.message);
  }
}