'use strict';

/**
 * ACE Validation Script v3 (fixed)
 *
 * What changed vs v2:
 * - Removed non-existent ACE functionNames (send-message, start-conversation, chat, send-user-input).
 * - Implemented the real ACE flow:
 *     Authenticate -> create-chat -> send-prompt -> poll get-message-group (until DONE/FAILED)
 *
 * Usage:
 *   node ace-validate.js <user> <password> <database> [question]
 *
 * Optional env toggles:
 *   ACE_ENV=prod|staging          (default: prod)
 *   ACE_CUSTOMER_DATA=true|false (default: true)
 */

const https = require('https');

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('Usage: node ace-validate.js <user> <password> <database> [question]');
  process.exit(1);
}

const geotabUser     = args[0];
const geotabPassword = args[1];
const geotabDatabase = args[2];
const userQuestion   = args[3] || 'Where is vehicle Demo - 35 right now?';

const ACE_ENV = (process.env.ACE_ENV || 'prod').trim();
const ACE_CUSTOMER_DATA = String(process.env.ACE_CUSTOMER_DATA || 'true').toLowerCase() === 'true';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// HTTP helper
function post(hostname, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: Object.assign({
        'Content-Type':       'text/plain;charset=UTF-8',
        'Content-Length':     Buffer.byteLength(raw),
        'x-application-name': 'MyGeotab',
        'page-name':          'ace'
      }, extraHeaders || {})
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* keep raw */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.write(raw);
    req.end();
  });
}

function getApiResultEnvelope(httpRes) {
  const b = httpRes && httpRes.body;
  if (!b || typeof b !== 'object') return null;
  if (!b.result || !b.result.apiResult) return null;
  return b.result.apiResult;
}

function hasApiErrors(httpRes) {
  const env = getApiResultEnvelope(httpRes);
  if (!env) return true;
  return Array.isArray(env.errors) && env.errors.length > 0;
}

function printHttp(label, httpRes, max = 4000) {
  const body = httpRes && httpRes.body;
  const str = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const ok = !hasApiErrors(httpRes) && body && body.result;
  console.log('\n' + (ok ? '✓' : '✗') + ' ' + label + ':\n' + str.slice(0, max));
  return ok;
}

function pickAssistantAnswer(messageGroup) {
  if (!messageGroup || !messageGroup.messages) return null;

  const msgs = Object.values(messageGroup.messages);
  msgs.sort((a, b) => (a.creation_date_unix_milli || 0) - (b.creation_date_unix_milli || 0));

  // Prefer an assistant message with content
  const lastAssistant =
    [...msgs].reverse().find(m => (m.type === 'AssistantMessage' || m.role === 'assistant') && m.content) ||
    null;

  if (lastAssistant) return { kind: 'text', content: lastAssistant.content };

  // Sometimes ACE returns structured references
  const lastRef =
    [...msgs].reverse().find(m => m.type === 'UserDataReference') ||
    null;

  if (lastRef) return { kind: 'ref', content: lastRef };

  // Fallback
  return { kind: 'raw', content: msgs[msgs.length - 1] || null };
}

async function run() {
  console.log(`\nAuthenticating ${geotabUser} on ${geotabDatabase}...`);
  let server = 'my.geotab.com';

  // 1) Authenticate (handle redirect)
  const auth1 = await post(server, '/apiv1', {
    method: 'Authenticate',
    params: { database: geotabDatabase, userName: geotabUser, password: geotabPassword },
    id: 1
  });

  if (!auth1.body || auth1.body.error) {
    console.error('Auth failed:', auth1.body?.error?.message || JSON.stringify(auth1.body, null, 2));
    process.exit(1);
  }

  let authResult = auth1.body.result;
  if (authResult && authResult.path && authResult.path !== 'ThisServer') {
    server = authResult.path;
    console.log('Redirected to ' + server);

    const auth2 = await post(server, '/apiv1', {
      method: 'Authenticate',
      params: { database: geotabDatabase, userName: geotabUser, password: geotabPassword },
      id: 1
    });

    if (!auth2.body || auth2.body.error) {
      console.error('Auth (redirect) failed:', auth2.body?.error?.message || JSON.stringify(auth2.body, null, 2));
      process.exit(1);
    }

    authResult = auth2.body.result;
  }

  const creds = authResult && authResult.credentials;
  if (!creds || !creds.sessionId) {
    console.error('No credentials/sessionId returned by Authenticate');
    process.exit(1);
  }

  console.log('Authenticated on ' + server);
  console.log(`ACE env=${ACE_ENV} customerData=${ACE_CUSTOMER_DATA}`);

  // ACE wrapper
  function aceCall(functionName, functionParameters) {
    return {
      method: 'GetAceResults',
      params: {
        serviceName: 'dna-planet-orchestration',
        functionName,
        customerData: ACE_CUSTOMER_DATA,
        environment: ACE_ENV,
        functionParameters,
        credentials: creds
      },
      id: 1
    };
  }

  // 2) create-chat
  console.log('\n=== [1] create-chat ===');
  const c1 = await post(server, '/apiv1', aceCall('create-chat', {}));
  printHttp('create-chat', c1);

  const chatId =
    c1.body?.result?.apiResult?.results?.[0]?.chat_id ||
    null;

  if (!chatId) {
    console.error('No chat_id returned from create-chat.');
    process.exit(2);
  }

  // 3) send-prompt
  console.log('\n=== [2] send-prompt ===');
  const p1 = await post(server, '/apiv1', aceCall('send-prompt', {
    chat_id: chatId,
    prompt: userQuestion
  }));
  printHttp('send-prompt', p1);

  const messageGroupId =
	p1.body?.result?.apiResult?.results?.[0]?.message_group_id ||
	p1.body?.result?.apiResult?.results?.[0]?.message_group?.id ||
	null;

  if (!messageGroupId) {
    console.error('No message_group_id returned from send-prompt.');
    process.exit(3);
  }

  // 4) poll get-message-group
  console.log('\n=== [3] poll get-message-group ===');
  let finalGroup = null;

  for (let i = 0; i < 60; i++) {
    await sleep(1000);

    const g1 = await post(server, '/apiv1', aceCall('get-message-group', {
      chat_id: chatId,
      message_group_id: messageGroupId
    }));

    const group = g1.body?.result?.apiResult?.results?.[0]?.message_group;
    const status = group?.status?.status;

    console.log(`poll #${i + 1}: status=${status || '??'}`);

    if (status === 'DONE') {
      finalGroup = group;
      break;
    }
    if (status === 'FAILED') {
      console.error('ACE FAILED:', JSON.stringify(group?.status || {}, null, 2));
      break;
    }
  }

  if (!finalGroup) {
    console.error('Did not reach DONE (try more polls, or set ACE_CUSTOMER_DATA=false).');
    process.exit(4);
  }

  // 5) print answer
  const picked = pickAssistantAnswer(finalGroup);

  console.log('\n=== ANSWER ===');
  if (!picked || !picked.content) {
    console.log(JSON.stringify(finalGroup, null, 2).slice(0, 8000));
    return;
  }

  if (picked.kind === 'text') {
    console.log(picked.content);
    return;
  }

  if (picked.kind === 'ref') {
    // Structured reference (may include signed_urls / preview_array)
    const ref = picked.content;
    console.log(JSON.stringify({
      type: ref.type,
      query: ref.query,
      reasoning: ref.reasoning,
      preview_array: ref.preview_array,
      signed_urls: ref.signed_urls
    }, null, 2).slice(0, 8000));
    return;
  }

  console.log(JSON.stringify(picked.content, null, 2).slice(0, 8000));
}

run().catch(err => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});