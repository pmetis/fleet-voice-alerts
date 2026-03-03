'use strict';

/**
 * Fleet Voice Alerts — pollExceptions Cloud Function (Day 2)
 *
 * Triggered by Cloud Scheduler every 60 seconds per active database.
 * Fully stateless — all state lives in Firestore.
 *
 * Flow:
 *   1. Read all active configs from Firestore
 *   2. For each database:
 *      a. Authenticate with Geotab (service account)
 *      b. GetFeed/ExceptionEvent using stored fromVersion cursor
 *      c. Match events against enabled exception rules
 *      d. Check per-rule cooldown windows
 *      e. For each qualifying exception: call ACE, write call doc
 *      f. Update feed cursor + cooldowns in Firestore
 *
 * Deployment:
 *   gcloud functions deploy pollExceptions \
 *     --gen2 --runtime nodejs20 \
 *     --trigger-http --allow-unauthenticated \
 *     --set-env-vars CONFIG_ENCRYPTION_KEY=$CONFIG_ENCRYPTION_KEY \
 *     --timeout 540s \
 *     --memory 512MB
 *
 * Cloud Scheduler job (created in Step 3 of Day 2 setup):
 *   gcloud scheduler jobs create http poll-fleet-exceptions \
 *     --schedule "* * * * *" \
 *     --uri https://REGION-PROJECT.cloudfunctions.net/pollExceptions \
 *     --http-method POST \
 *     --message-body '{}' \
 *     --time-zone "UTC"
 */

const functions = require('@google-cloud/functions-framework');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { v4: uuidv4 } = require('uuid');

const { decrypt }          = require('./lib/crypto');
const { GeotabClient }     = require('./lib/geotabClient');
const { enrichWithAce }    = require('./lib/aceEnricher');
const { isInScheduleWindow } = require('./lib/scheduleCheck');

const db = new Firestore();

// ─── Constants ────────────────────────────────────────────────────────────────
const GETFEED_RESULTS_LIMIT = 500;  // max exceptions fetched per poll per database
const ACE_TIMEOUT_MS        = 45000; // ACE can take up to 40s — 9min function timeout
const NEW_CALLS_PER_DB_LIMIT = 1;   // max new call docs created per database per poll cycle
                                     // Prevents flooding when a backlog of exceptions accumulates
                                     // (e.g. demo database with 66+ historical events).

// ─── HTTP entry point ─────────────────────────────────────────────────────────
// Accepts POST from Cloud Scheduler (body ignored) or manual trigger with
// optional { dbName } to poll a single database for testing.
functions.http('pollExceptions', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const startTime = Date.now();
  const targetDb  = req.body?.dbName || null; // optional: poll single DB for testing

  try {
    const results = await pollAllDatabases(targetDb);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`[poll] Completed in ${elapsed}s —`, JSON.stringify(results));
    return res.json({ success: true, elapsed: `${elapsed}s`, results });
  } catch (err) {
    console.error('[poll] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Poll all databases ───────────────────────────────────────────────────────
async function pollAllDatabases(targetDb) {
  // Load all configs — or just the target if specified
  let configDocs;
  if (targetDb) {
    const snap = await db.collection('configs').doc(targetDb).get();
    configDocs = snap.exists ? [snap] : [];
  } else {
    const snap = await db.collection('configs').get();
    configDocs = snap.docs;
  }

  const results = [];

  // Process databases sequentially to avoid hammering Geotab + ACE in parallel.
  // For large multi-tenant deployments, consider Promise.allSettled with concurrency limit.
  for (const doc of configDocs) {
    const dbName = doc.id;
    const config = doc.data();

    // Skip databases with no enabled rules
    const enabledRules = (config.exceptionRules || []).filter(r => r.enabled);
    if (!enabledRules.length) {
      results.push({ dbName, skipped: 'no enabled rules' });
      continue;
    }

    // Skip databases missing Geotab credentials
    // geotabSession.server is written back after the first successful authenticate()
    // so on the very first poll we fall back to the user-entered geotabServer.
    if (!config.geotabUser || !config.geotabPassword || !config.geotabServer) {
      results.push({ dbName, skipped: 'missing Geotab credentials (geotabUser / geotabPassword / geotabServer)' });
      continue;
    }

    try {
      const result = await pollOneDatabase(dbName, config, enabledRules);
      results.push({ dbName, ...result });
    } catch (err) {
      console.error(`[poll:${dbName}] Error:`, err.message);
      results.push({ dbName, error: err.message });
    }
  }

  return results;
}

// ─── Poll one database ────────────────────────────────────────────────────────
async function pollOneDatabase(dbName, config, enabledRules) {
  // 1. Authenticate with Geotab
  let geotab;
  try {
    const password = decrypt(config.geotabPassword);

    // Prefer the persisted session server (already resolved / redirected from a
    // previous successful authenticate).  Fall back to the user-entered
    // geotabServer on the very first poll, or after a config reset.
    const startServer = config.geotabSession?.server || config.geotabServer;

    geotab = new GeotabClient(
      startServer,
      dbName,
      config.geotabUser,
      password
    );
    await geotab.authenticate();

    // Persist the resolved server (post-redirect) back to Firestore so all
    // other Cloud Functions (aceQuery, voiceEngine) can use the exact DB server
    // without needing to go through the generic my.geotab.com proxy.
    if (geotab.server !== (config.geotabSession?.server)) {
      await db.collection('configs').doc(dbName).set(
        { geotabSession: { server: geotab.server } },
        { merge: true }
      );
      console.log(`[poll:${dbName}] Persisted resolved Geotab server: ${geotab.server}`);
    }
  } catch (err) {
    throw new Error(`Geotab auth failed: ${err.message}`);
  }

  // 2. Read feed cursor + cooldowns in parallel
  const [cursorDoc, cooldownDoc] = await Promise.all([
    db.collection('feed-cursors').doc(dbName).get(),
    db.collection('cooldowns').doc(dbName).get()
  ]);

  const fromVersion = cursorDoc.exists ? (cursorDoc.data().fromVersion || '0') : '0';
  const cooldowns   = cooldownDoc.exists ? (cooldownDoc.data().records || {}) : {};

  // 3. GetFeed/ExceptionEvent
  let feedResult;
  try {
    feedResult = await geotab.getFeedExceptions(fromVersion, GETFEED_RESULTS_LIMIT);
  } catch (err) {
    throw new Error(`GetFeed failed: ${err.message}`);
  }

  const events     = feedResult.data      || [];
  const toVersion  = feedResult.toVersion || fromVersion;

  console.log(`[poll:${dbName}] GetFeed returned ${events.length} events, toVersion: ${toVersion}`);

  // Build a lookup map of enabled rules: { geotabRuleId → rule config }
  const ruleMap = {};
  enabledRules.forEach(r => { ruleMap[r.id] = r; });

  // 4. Process each event
  const now           = new Date();
  const callsCreated  = [];
  const skipped       = { noMatch: 0, cooldown: 0, outsideWindow: 0, cappedByLimit: 0 };
  const cooldownUpdates = {};

  for (const event of events) {
    // Per-database cap — stop creating new call docs once limit is reached this cycle
    if (callsCreated.length >= NEW_CALLS_PER_DB_LIMIT) {
      skipped.cappedByLimit++;
      continue;
    }

    const ruleId = event.rule?.id;
    const rule   = ruleMap[ruleId];

    // a. Rule match check
    if (!rule) {
      skipped.noMatch++;
      continue;
    }

    const vehicleId  = event.device?.id || event.deviceId;
    const cooldownKey = `${vehicleId}_${ruleId}`;

    // b. Cooldown check — per vehicle + rule
    const lastAlert   = cooldowns[cooldownKey]?.lastAlertAt;
    const cooldownMs  = (rule.cooldownMinutes || 30) * 60 * 1000;
    if (lastAlert) {
      const lastAlertDate = lastAlert.toDate ? lastAlert.toDate() : new Date(lastAlert);
      if ((now - lastAlertDate) < cooldownMs) {
        skipped.cooldown++;
        console.log(`[poll:${dbName}] Cooldown active for ${cooldownKey} — skipping`);
        continue;
      }
    }

    // c. Enrich with vehicle + driver info
    const [vehicle, driver] = await Promise.all([
      geotab.getDevice(vehicleId).catch(() => null),
      geotab.getDriver(event.driver?.id).catch(() => null)
    ]);

    const exceptionName = event.rule?.name || rule.name || ruleId;
    const vehicleName   = vehicle?.name || vehicleId || 'Unknown vehicle';
    const enrichedEvent = {
      ...event,
      exceptionName,
      vehicleName,
      vehicleId,
      driverId:   event.driver?.id  || null,
      driverName: driver
        ? `${driver.firstName || ''} ${driver.lastName || ''}`.trim() || driver.name
        : 'Unknown driver',
      dateTime:   event.activeFrom || event.dateTime || now.toISOString()
    };

    // d. Schedule window check
    const { inWindow, reason } = isInScheduleWindow(config.schedule, now);

    // e. ACE enrichment (even for scheduled calls — script is generated now)
    let aceResult;
    try {
      const recentEvents = await geotab.getRecentDriverExceptions(
        enrichedEvent.driverId, vehicleId, 7
      );
      // Delay entre excepciones para no saturar ACE rate limit
      if (callsCreated.length > 0) {
        await new Promise(r => setTimeout(r, 3000)); // 3s entre calls ACE
      }
      aceResult = await withTimeout(
        enrichWithAce(geotab, enrichedEvent, driver, recentEvents, config.language || 'en', rule.severity || 'medium'),
        ACE_TIMEOUT_MS,
        'ACE enrichment timed out'
      );
    } catch (err) {
      console.warn(`[poll:${dbName}] ACE enrichment failed for ${enrichedEvent.id}:`, err.message);
      // Use fallback — non-fatal
      const { buildFallbackScript } = require('./lib/aceEnricher');
      aceResult = {
        severityAssessment: '',
        script:             buildFallbackScript(enrichedEvent, driver, config.language || 'en'),
        cachedQA:           {}
      };
    }

    // f. Write call document to Firestore
    const callId = uuidv4();
    const callDoc = {
      dbName,
      exceptionId:        event.id,
      exceptionName,
      vehicleId,
      vehicleName,
      driverId:           enrichedEvent.driverId,
      driverName:         enrichedEvent.driverName,
      status:             inWindow ? 'queued' : 'scheduled',
      contactIndex:       0,
      currentContactName: config.escalationContacts?.[0]?.name  || '',
      currentContactPhone: config.escalationContacts?.[0]?.phone || '',
      script:             aceResult.script,
      cachedQA:           aceResult.cachedQA,
      severityAssessment: aceResult.severityAssessment,
      ruleSeverity:       rule.severity || 'medium',
      // Stored so voiceResponse/initiateCall don't need to re-load config
      lang:               config.language || 'en',
      webhookBase:        config.webhookBaseUrl || '',
      conversation:       [],
      startedAt:          null,
      endedAt:            null,
      durationSeconds:    null,
      twilioCallSid:      null,
      createdAt:          FieldValue.serverTimestamp(),
      updatedAt:          FieldValue.serverTimestamp()
    };

    if (!inWindow) {
      callDoc.scheduleNote = reason;
    }

    await db.collection('calls').doc(callId).set(callDoc);

    // Track cooldown update (apply in batch after loop)
    cooldownUpdates[cooldownKey] = {
      lastAlertAt: now,
      vehicleId,
      ruleId
    };

    callsCreated.push({ callId, vehicleName, exceptionName, status: callDoc.status });
    console.log(`[poll:${dbName}] Created call ${callId} — ${exceptionName} on ${vehicleName} (${callDoc.status})`);
  }

  // 5. Write cursor + cooldown updates in parallel (after all events processed)
  const writes = [];

  // Always update cursor even if no events — advances the version
  writes.push(
    db.collection('feed-cursors').doc(dbName).set({
      fromVersion: toVersion,
      lastPollAt:  FieldValue.serverTimestamp()
    }, { merge: true })
  );

  // Update cooldowns if any fired
  if (Object.keys(cooldownUpdates).length > 0) {
    const cooldownPatch = {};
    Object.entries(cooldownUpdates).forEach(([key, val]) => {
      cooldownPatch[`records.${key}`] = val;
    });
    writes.push(
      db.collection('cooldowns').doc(dbName).set(
        { ...cooldownPatch, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      )
    );
  }

  await Promise.all(writes);

  return {
    eventsReceived: events.length,
    callsCreated:   callsCreated.length,
    skipped,
    calls:          callsCreated
  };
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    )
  ]);
}

module.exports = { pollOneDatabase }; // exported for unit testing