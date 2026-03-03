'use strict';

/**
 * Geotab JSON-RPC client for backend Cloud Functions.
 *
 * Geotab's API is JSON-RPC over HTTPS.
 * Endpoint: POST https://{server}/apiv1
 *
 * Authentication flow:
 *   1. Call Authenticate → get { credentials, path }
 *      - credentials = { sessionId, database, userName }
 *      - path may redirect to a different server (e.g. my1234.geotab.com)
 *   2. Use credentials in every subsequent call
 *
 * ACE flow (confirmed via ace-validate.js):
 *   GetAceResults does NOT accept a raw `query` param.
 *   The real flow is stateful and uses three functionNames:
 *     1. create-chat      → { chat_id }
 *     2. send-prompt      → { message_group_id }
 *     3. get-message-group (poll until status === "DONE")
 *
 *   Use callAceFunction(functionName, functionParameters) for each step,
 *   or callAceStateful(prompt) to run the entire flow in one call.
 *
 *   For multi-round Twilio polling use:
 *     callAceStatefulWithPersist(prompt, onSessionCreated)
 *       → creates session, fires callback with {chatId, messageGroupId},
 *         then polls until DONE or timeout.
 *     pollAceSession(chatId, messageGroupId)
 *       → resumes polling an existing session — no new create-chat/send-prompt.
 *         Use this for rounds 1+ to avoid 429 rate limits.
 *
 * IMPORTANT — server resolution:
 *   GetAceResults must be called against the specific redirected server
 *   (e.g. my1234.geotab.com), NOT the generic my.geotab.com proxy.
 *   The proxy's DaaS layer returns HTTP 415 for this method.
 *   authenticate() handles the redirect automatically and updates this.server.
 */

const https = require('https');

// ─── ACE constants ────────────────────────────────────────────────────────────
const ACE_SERVICE_NAME     = 'dna-planet-orchestration';
const ACE_ENVIRONMENT      = 'prod';
const ACE_CUSTOMER_DATA    = true;
const ACE_POLL_INTERVAL_MS = 3000; // ms between get-message-group polls
const ACE_MAX_POLLS        = 10;   // max polls per callAceStateful call (~15s)

// ─── Core JSON-RPC call ───────────────────────────────────────────────────────

/**
 * Low-level HTTPS POST to Geotab's JSON-RPC endpoint.
 *
 * Uses 'text/plain;charset=UTF-8' as Content-Type — required by GetAceResults.
 * The standard 'application/json' causes a 415 error on ACE endpoints.
 */
function rpc(server, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params, id: 1 });
    const options = {
      hostname: server,
      path:     '/apiv1',
      method:   'POST',
      headers: {
        'Content-Type':       'text/plain;charset=UTF-8',
        'Content-Length':     Buffer.byteLength(body),
        'x-application-name': 'MyGeotab',
        'page-name':          'ace'
      }
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);

          if (parsed.error) {
            return reject(new Error(
              parsed.error.message || JSON.stringify(parsed.error)
            ));
          }

          if (Array.isArray(parsed.errors) && parsed.errors.length) {
            const e = parsed.errors[0];
            // Return the full raw so callers can log it
            return reject(new Error(
              `callAceFunction(${method}): empty apiResult — raw: ${JSON.stringify(parsed)}`
            ));
          }

          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(
              `Geotab API HTTP ${res.statusCode} for method ${method} — raw: ${raw.slice(0, 200)}`
            ));
          }

          resolve(parsed.result);
        } catch (e) {
          reject(new Error(`Geotab JSON parse error: ${e.message} — raw: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Geotab API request timed out after 15s'));
    });
    req.write(body);
    req.end();
  });
}

// ─── GeotabClient class ───────────────────────────────────────────────────────

class GeotabClient {
  /**
   * @param {string} server   e.g. 'my.geotab.com' or 'my1234.geotab.com'
   * @param {string} database Geotab database name
   * @param {string} userName Service account email
   * @param {string} password Service account password (plaintext, decrypted before use)
   */
  constructor(server, database, userName, password) {
    this.server      = server;
    this.database    = database;
    this.userName    = userName;
    this.password    = password;
    this.credentials = null; // set after authenticate()
  }

  /**
   * Authenticate with Geotab and store credentials.
   * Must be called before any other method.
   */
  async authenticate() {
    let result;
    try {
      result = await rpc(this.server, 'Authenticate', {
        database: this.database,
        userName: this.userName,
        password: this.password
      });
    } catch (err) {
      throw new Error(`Geotab authentication failed: ${err.message}`);
    }

    if (result.path && result.path !== 'ThisServer') {
      this.server = result.path;
      try {
        result = await rpc(this.server, 'Authenticate', {
          database: this.database,
          userName: this.userName,
          password: this.password
        });
      } catch (err) {
        throw new Error(`Geotab re-authentication on ${this.server} failed: ${err.message}`);
      }
    }

    if (!result.credentials) {
      throw new Error('Geotab authentication succeeded but returned no credentials');
    }

    this.credentials = result.credentials;
    return this.credentials;
  }

  /**
   * Make an authenticated API call.
   */
  async call(method, params = {}) {
    if (!this.credentials) {
      throw new Error('GeotabClient.call() called before authenticate()');
    }
    return rpc(this.server, method, { ...params, credentials: this.credentials });
  }

  // ─── ACE (AI) methods ───────────────────────────────────────────────────────

  /**
   * Call a single ACE function via GetAceResults.
   * Low-level primitive — prefer callAceStateful() for the full flow.
   */
  async callAceFunction(functionName, functionParameters = {}) {
    if (!this.credentials) {
      throw new Error('GeotabClient.callAceFunction() called before authenticate()');
    }

    const result = await rpc(this.server, 'GetAceResults', {
      serviceName:        ACE_SERVICE_NAME,
      functionName,
      customerData:       ACE_CUSTOMER_DATA,
      environment:        ACE_ENVIRONMENT,
      functionParameters,
      credentials:        this.credentials
    });

    const apiResult = result?.apiResult;
    if (!apiResult) {
      throw new Error(`callAceFunction(${functionName}): empty apiResult — raw: ${JSON.stringify(result)}`);
    }

    if (Array.isArray(apiResult.errors) && apiResult.errors.length) {
      const e = apiResult.errors[0];
      throw new Error(
        `callAceFunction(${functionName}) ACE error: ${e.message || JSON.stringify(e)}`
      );
    }

    return apiResult;
  }

  /**
   * Run the full 3-step ACE stateful conversation and return the assistant's answer.
   * Flow: create-chat → send-prompt → poll get-message-group until DONE
   *
   * @param {string} prompt  The question / prompt text to send to ACE
   * @returns {Promise<string|null>}
   */
  async callAceStateful(prompt) {
    const chatResult = await this.callAceFunction('create-chat', {});
    const chatId     = chatResult?.results?.[0]?.chat_id;
    if (!chatId) throw new Error(`callAceStateful: create-chat returned no chat_id — ${JSON.stringify(chatResult)}`);
    console.log(`[geotabClient] ACE create-chat OK — chat_id=${chatId}`);

    const promptResult   = await this.callAceFunction('send-prompt', { chat_id: chatId, prompt });
    const messageGroupId =
      promptResult?.results?.[0]?.message_group_id ||
      promptResult?.results?.[0]?.message_group?.id || null;
    if (!messageGroupId) throw new Error(`callAceStateful: send-prompt returned no message_group_id — ${JSON.stringify(promptResult)}`);
    console.log(`[geotabClient] ACE send-prompt OK — message_group_id=${messageGroupId}`);

    return this._pollUntilDone(chatId, messageGroupId);
  }

  /**
   * Like callAceStateful but fires onSessionCreated(chatId, messageGroupId)
   * as soon as send-prompt succeeds — BEFORE polling starts.
   *
   * This lets the caller persist the session IDs to Firestore so that
   * subsequent Twilio redirect rounds can resume polling without creating
   * a new chat (which causes 429 rate-limit errors).
   *
   * @param {string}   prompt
   * @param {Function} onSessionCreated  async (chatId, messageGroupId) => void
   * @returns {Promise<string|null>}
   */
  async callAceStatefulWithPersist(prompt, onSessionCreated) {
    // Step 1: create-chat
    const chatResult = await this.callAceFunction('create-chat', {});
    const chatId     = chatResult?.results?.[0]?.chat_id;
    if (!chatId) throw new Error(`callAceStatefulWithPersist: create-chat returned no chat_id`);
    console.log(`[geotabClient] ACE create-chat OK — chat_id=${chatId}`);

    // Step 2: send-prompt
    const promptResult   = await this.callAceFunction('send-prompt', { chat_id: chatId, prompt });
    const messageGroupId =
      promptResult?.results?.[0]?.message_group_id ||
      promptResult?.results?.[0]?.message_group?.id || null;
    if (!messageGroupId) throw new Error(`callAceStatefulWithPersist: send-prompt returned no message_group_id`);
    console.log(`[geotabClient] ACE send-prompt OK — message_group_id=${messageGroupId}`);

    // Fire callback with session IDs BEFORE polling — so they're persisted
    // even if polling times out on this round
    try {
      await onSessionCreated(chatId, messageGroupId);
    } catch (cbErr) {
      // Non-fatal — if persisting fails, we still try to poll
      console.warn(`[geotabClient] onSessionCreated callback failed:`, cbErr.message);
    }

    // Step 3: poll
    return this._pollUntilDone(chatId, messageGroupId);
  }

  /**
   * Resume polling an existing ACE session.
   * Use this for rounds 1+ of the Twilio multi-redirect pattern.
   *
   * Does NOT call create-chat or send-prompt — just polls get-message-group.
   * This avoids the 429 rate limit caused by creating multiple sessions.
   *
   * @param {string} chatId
   * @param {string} messageGroupId
   * @returns {Promise<string|null>}  Answer text or null if still processing
   */
  async pollAceSession(chatId, messageGroupId) {
    console.log(`[geotabClient] ACE resume poll — chat_id=${chatId} msg_group=${messageGroupId}`);
    return this._pollUntilDone(chatId, messageGroupId);
  }

  /**
   * Internal polling loop — shared by callAceStateful, callAceStatefulWithPersist,
   * and pollAceSession.
   */
  async _pollUntilDone(chatId, messageGroupId) {
    for (let i = 0; i < ACE_MAX_POLLS; i++) {
      await sleep(ACE_POLL_INTERVAL_MS);

      const groupResult = await this.callAceFunction('get-message-group', {
        chat_id:          chatId,
        message_group_id: messageGroupId
      });

      const group  = groupResult?.results?.[0]?.message_group;
      const status = group?.status?.status;
      console.log(`[geotabClient] ACE poll #${i + 1}: status=${status || '??'}`);

      if (status === 'DONE') return extractAssistantText(group);
      if (status === 'FAILED') throw new Error(`ACE FAILED — ${JSON.stringify(group?.status)}`);
    }

    // Did not finish within max polls — return null so caller can retry next round
    return null;
  }

  // ─── Convenience methods ────────────────────────────────────────────────────

  async getFeedExceptions(fromVersion, resultsLimit = 500) {
    return this.call('GetFeed', {
      typeName:     'ExceptionEvent',
      fromVersion,
      resultsLimit
    });
  }

  async getExceptionRules() {
    return this.call('Get', {
      typeName:     'Rule',
      resultsLimit: 1000
    });
  }

  async getDevice(deviceId) {
    const results = await this.call('Get', {
      typeName: 'Device',
      search:   { id: deviceId }
    });
    return results?.[0] || null;
  }

  async getDriver(driverId) {
    if (!driverId || driverId === 'UnknownDriverId') return null;
    const results = await this.call('Get', {
      typeName: 'User',
      search:   { id: driverId }
    });
    return results?.[0] || null;
  }

  /**
   * Reverse geocode a lat/lng to a human-readable address via GetAddresses.
   * @returns {Promise<string|null>} e.g. "123 Main St, Toronto, ON"
   */
  async getAddress(latitude, longitude) {
    if (latitude == null || longitude == null) return null;
    try {
      const results = await this.call('GetAddresses', {
        coordinates: [{ x: longitude, y: latitude }]
      });
      const addr = results?.[0];
      if (!addr) return null;
      if (typeof addr === 'string') return addr;
      return addr.formattedAddress
        || [addr.street, addr.city, addr.state, addr.country].filter(Boolean).join(', ')
        || null;
    } catch (err) {
      console.warn(`[geotabClient] getAddress failed for ${latitude},${longitude}:`, err.message);
      return null;
    }
  }

  /**
   * Get real-time device status: location, speed, GPS communicating.
   * @returns {Promise<object|null>} DeviceStatusInfo or null
   */
  async getDeviceStatus(deviceId) {
    if (!deviceId) return null;
    try {
      const results = await this.call('Get', {
        typeName: 'DeviceStatusInfo',
        search:   { deviceSearch: { id: deviceId } }
      });
      return results?.[0] || null;
    } catch (err) {
      console.warn(`[geotabClient] getDeviceStatus failed for ${deviceId}:`, err.message);
      return null;
    }
  }

  /**
   * Get last ignition status for a device.
   * data === 1 = ignition ON, data === 0 = ignition OFF.
   * @returns {Promise<object|null>} StatusData record or null
   */
  async getLastIgnition(deviceId) {
    if (!deviceId) return null;
    try {
      const results = await this.call('Get', {
        typeName:     'StatusData',
        resultsLimit: 1,
        search: {
          deviceSearch:     { id: deviceId },
          diagnosticSearch: { id: 'DiagnosticIgnitionId' }
        }
      });
      return results?.[0] || null;
    } catch (err) {
      console.warn(`[geotabClient] getLastIgnition failed for ${deviceId}:`, err.message);
      return null;
    }
  }

  async getRecentDriverExceptions(driverId, deviceId, days = 7) {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const params = {
      typeName:     'ExceptionEvent',
      resultsLimit: 20,
      search: {
        fromDate: fromDate.toISOString(),
        toDate:   new Date().toISOString()
      }
    };
    if (driverId && driverId !== 'UnknownDriverId') {
      params.search.driverSearch = { id: driverId };
    } else if (deviceId) {
      params.search.deviceSearch = { id: deviceId };
    }

    try {
      return await this.call('Get', params) || [];
    } catch {
      return [];
    }
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function extractAssistantText(messageGroup) {
  if (!messageGroup?.messages) return null;

  const msgs = Object.values(messageGroup.messages);
  msgs.sort((a, b) => (a.creation_date_unix_milli || 0) - (b.creation_date_unix_milli || 0));

  const lastAssistant = [...msgs]
    .reverse()
    .find(m => (m.type === 'AssistantMessage' || m.role === 'assistant') && m.content);

  if (lastAssistant) {
    const raw = lastAssistant.content;
    return cleanText(typeof raw === 'string' ? raw : JSON.stringify(raw));
  }

  const last = msgs[msgs.length - 1];
  return last?.content ? cleanText(String(last.content)) : null;
}

function cleanText(text) {
  return text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { GeotabClient };