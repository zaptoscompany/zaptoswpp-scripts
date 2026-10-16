// Node 24+. npm ci --prefix tests; node --test tests/forward-message.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import test from 'node:test';
import CryptoJS from 'crypto-js';
import { parseHTML } from 'linkedom';

const uiSource = readFileSync(new URL('../src/zaptos-actions-original.js', import.meta.url), 'utf8');
const edgeSource = readFileSync(new URL('../src/supabase/functions/edge-fcuntions/forward-ghl-message.ts', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const locationId = 'location12345678';
const messageId = 'message123456789';
const contactId = 'contact987654321';
const secret = 'test-only-shared-secret';
const encryptedData = CryptoJS.AES.encrypt(JSON.stringify({ activeLocation: locationId, userId: 'user1234567890' }), secret).toString();

function database() {
  const errors = {};
  const tables = {
    code_autorization_ghl: [{ LocationId: locationId, access_token: 'test-oauth', token_type: 'Bearer' }],
    messages: [{ location_id: locationId, mensagem: messageId, id: 1 }],
    uazapi: [{ id: 'instance12345678', LocationID: locationId, nome: 'Principal', is_primary: true,
      url: 'https://whatsapp.example', 'Instance Token': 'private-instance-token' }],
    whatsapp_instance_map: [],
    ghl_message_forwards: []
  };
  return {
    tables, errors,
    from(table) {
      const filters = [];
      let operation = 'select', value, single = false, limit = Infinity, promise;
      const q = {
        select() { return q; },
        eq(key, expected) { filters.push((row) => row[key] === expected); return q; },
        limit(n) { limit = n; return q; },
        maybeSingle() { single = true; return q; },
        insert(data) { operation = 'insert'; value = plain(data); return q; },
        update(data) { operation = 'update'; value = plain(data); return q; },
        then(resolve, reject) {
          promise ||= Promise.resolve().then(() => {
            if (errors[table]) return { data: null, error: errors[table] };
            if (operation === 'insert') {
              if (table === 'ghl_message_forwards' && tables[table].some((row) => row.request_id === value.request_id)) return { error: { code: '23505' }, data: null };
              tables[table].push(value); return { error: null, data: value };
            }
            const rows = tables[table].filter((row) => filters.every((filter) => filter(row))).slice(0, limit);
            if (operation === 'update') rows.forEach((row) => Object.assign(row, value));
            return { error: null, data: single ? rows[0] || null : rows };
          });
          return promise.then(resolve, reject);
        }
      };
      return q;
    }
  };
}
function backend() {
  const db = database();
  const source = { id: messageId, locationId, contactId: 'source123456789', direction: 'inbound', messageType: 'TYPE_SMS',
    status: 'delivered', contentType: 'text/plain', body: 'Olá 👋\nVeja o arquivo\nInstance Source: Canal 1', attachments: ['https://files.example/image.png'] };
  const contact = { id: contactId, locationId, firstName: 'Maria', lastName: 'Silva', phone: '+55 (11) 99999-9999' };
  const calls = [];
  const env = { GHL_APP_ID: 'app123456789', GHL_APP_SHARED_SECRET: secret, GHL_CONVERSATION_PROVIDER_ID: 'provider12345678',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' };
  const runtime = {
    CryptoJS, URL, URLSearchParams, Response, Request, AbortSignal, TextEncoder, TextDecoder, Uint8Array, atob, crypto: webcrypto,
    createClient: () => db,
    Deno: { env: { get: (key) => env[key] }, serve: (handler) => { runtime.handler = handler; } },
    async fetch(url, options) {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, body, headers: options.headers });
      if (runtime.overrideFetch) { const override = await runtime.overrideFetch(url, options); if (override) return override; }
      if (url.includes('/conversations/search?')) return Response.json({ conversations: [
        { locationId, contactId, fullName: 'Maria Silva', phone: contact.phone },
        { locationId, contactId, fullName: 'Duplicado', phone: contact.phone },
        { locationId: 'foreign12345678', contactId: 'foreigncontact123', phone: contact.phone }
      ] });
      if (url.endsWith('/contacts/search')) return Response.json({ contacts: [contact, { ...contact, id: 'foreign12345678', locationId: 'other12345678' }] });
      if (url.includes('/contacts/')) return Response.json({ contact });
      if (url.endsWith('/messages/inbound')) return Response.json({ messageId: 'newmessage123456', conversationId: 'conversation12345' });
      if (url.includes('/conversations/messages/')) return Response.json(source);
      if (url.startsWith('https://whatsapp.example/')) return Response.json({ messageId: 'whatsapp123456789' });
      throw new Error(`Unexpected URL: ${url}`);
    }
  };
  vm.runInNewContext(stripTypeScriptTypes(edgeSource.replace(/^import .*;\n/gm, ''), { mode: 'transform' }), runtime);
  async function request(action, extra = {}) {
    let expectedRevision;
    try { expectedRevision = await runtime.sourceRevision(runtime.normalizeSource(source, locationId)); } catch {}
    const result = await runtime.handler(new Request('https://edge.example/forward', { method: 'POST', body: JSON.stringify({
      action, locationId, encryptedData, messageId, contactId, expectedRevision, expectedPhone: '+5511999999999', ...extra
    }) }));
    return { status: result.status, data: await result.json() };
  }
  return { db, source, contact, calls, runtime, request, env };
}

test('search by name and formatted phone is location scoped; only safe contact fields return', async () => {
  const app = backend();
  for (const query of ['Maria', '+55 (11) 99999-9999']) {
    const result = await app.request('search', { query });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.contacts, [{ id: contactId, name: 'Maria Silva', phone: '+5511999999999' }]);
    assert.equal(app.calls.at(-1).body.locationId, locationId);
    assert.equal(app.calls.at(-1).body.query, query === 'Maria' ? query : '+5511999999999');
  }
});
test('requires a real encrypted session in the same location before reading contacts', async () => {
  const app = backend();
  for (const encryptedData of ['', 'broken', CryptoJS.AES.encrypt(JSON.stringify({ activeLocation: 'other12345678', userId: 'user1234567890' }), secret).toString()]) {
    assert.equal((await app.request('search', { query: 'Maria', encryptedData })).status, 403);
  }
  assert.equal(app.calls.length, 0);
});
test('previews inbound and outbound text/media, preserves Unicode and strips instance footer', async () => {
  const app = backend();
  for (const direction of ['inbound', 'outbound']) {
    app.source.direction = direction;
    const result = await app.request('preview');
    assert.equal(result.status, 200);
    assert.equal(result.data.message.text, 'Olá 👋\nVeja o arquivo');
    assert.equal(result.data.message.attachmentCount, 1);
  }
});
test('rejects foreign, missing, failed, empty, unsupported messages and invalid attachments', async () => {
  for (const mutation of [
    { locationId: 'other12345678' }, { messageType: 'TYPE_EMAIL' }, { status: 'failed' },
    { body: '', attachments: [] }, { attachments: ['javascript:alert(1)'] },
    { direction: 'outbound', body: '#delmessage:another1234567' }
  ]) {
    const app = backend(); Object.assign(app.source, mutation);
    assert.notEqual((await app.request('preview')).status, 200);
    assert.equal(app.db.tables.ghl_message_forwards.length, 0);
  }
  const app = backend(); app.db.tables.messages.length = 0;
  assert.equal((await app.request('preview')).status, 404);
});
test('forwards literal content and attachments into destination history, then dispatches directly once', async () => {
  const app = backend();
  app.source.body = '#delmessage:another1234567\ntexto recebido';
  const requestId = randomUUID();
  const first = await app.request('forward', { requestId });
  assert.equal(first.status, 200);
  const log = app.calls.find((call) => call.url.endsWith('/messages/inbound'));
  assert.deepEqual(log.body, { type: 'SMS', contactId, conversationProviderId: app.env.GHL_CONVERSATION_PROVIDER_ID,
    message: app.source.body, attachments: app.source.attachments, direction: 'outbound' });
  const send = app.calls.find((call) => call.url.endsWith('/send/media'));
  assert.equal(send.body.forward, true);
  assert.equal(send.body.text, app.source.body);
  assert.equal(send.headers.token, 'private-instance-token');
  assert.ok(app.calls.every((call) => !call.url.includes('receiver') && !JSON.stringify(call.body).includes('test-service-key')));
  const second = await app.request('forward', { requestId });
  assert.deepEqual(second, first);
  assert.equal(app.calls.filter((call) => call.url.endsWith('/messages/inbound')).length, 1);
  assert.equal(app.calls.filter((call) => call.url.endsWith('/send/media')).length, 1);
});
test('parallel submissions cannot create two GHL messages', async () => {
  const app = backend(); const requestId = randomUUID();
  const results = await Promise.all([app.request('forward', { requestId }), app.request('forward', { requestId })]);
  assert.ok(results.some((result) => result.status === 200));
  assert.equal(app.calls.filter((call) => call.url.endsWith('/messages/inbound')).length, 1);
});
test('unknown GHL result is not retried, and a request cannot change recipient', async () => {
  const app = backend(); const requestId = randomUUID();
  app.runtime.overrideFetch = async (url) => { if (url.endsWith('/messages/inbound')) throw new Error('network lost'); };
  assert.equal((await app.request('forward', { requestId })).status, 504);
  assert.equal((await app.request('forward', { requestId })).status, 409);
  assert.equal((await app.request('forward', { requestId, contactId: 'changed123456789' })).data.code, 'request_conflict');
  assert.equal(app.calls.filter((call) => call.url.endsWith('/messages/inbound')).length, 1);
});
test('revalidates phone, source contact, and target location before creating any message', async () => {
  for (const change of [{ phone: '+5511888888888' }, { phone: '' }, { locationId: 'other123456789' }]) {
    const app = backend(); Object.assign(app.contact, change);
    assert.notEqual((await app.request('forward', { requestId: randomUUID() })).status, 200);
    assert.equal(app.db.tables.ghl_message_forwards.length, 0);
  }
  const app = backend();
  assert.equal((await app.request('forward', { requestId: randomUUID(), contactId: app.source.contactId })).data.code, 'same_contact');
});

function frontend(api) {
  const dom = parseHTML(`<html><head></head><body><div class="message-item" data-message-id="${messageId}"></div></body></html>`);
  const location = { href: `https://crm.example/v2/location/${locationId}/conversations/one`, pathname: `/v2/location/${locationId}/conversations/one` };
  const window = { crypto: { randomUUID }, CSS: { escape: (value) => value } };
  const runtime = { window, document: dom.document, Element: dom.Element, HTMLElement: dom.HTMLElement, URL, AbortController,
    setTimeout, clearTimeout, location, console };
  vm.runInNewContext(uiSource.slice(0, uiSource.lastIndexOf("  document.addEventListener('pointerdown'")) + `
    callForwardEdge = window.api;
    getForwardSession = async () => 'session';
    showToast = (...args) => window.toasts.push(args);
    window.test = { runForwardAction, forwardState, injectActionsForDetails,
      setupMenu: () => { isVisibleElement = () => true; resolveMessageContext = () => ({ messageId: '${messageId}' }); } };
  })();`, Object.assign(runtime, { window: Object.assign(window, { api, toasts: [] }) }));
  return { ...runtime, api: window.test, dom };
}
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const preview = { message: { text: 'Olá <script>texto</script>', attachmentCount: 1, contactId: 'source123456789' } };
function type(app, value) {
  const input = app.document.querySelector('#za-forward-search'); input.value = value;
  input.dispatchEvent(new app.dom.Event('input')); return input;
}
test('menu injects five actions once and includes forwarding', () => {
  const app = frontend(async () => preview); app.api.setupMenu();
  const root = app.document.createElement('div');
  const details = app.document.createElement('div'); root.append(details); app.document.body.append(root);
  app.api.injectActionsForDetails(details); app.api.injectActionsForDetails(details);
  assert.equal(root.querySelectorAll('[data-zaptos-action-item]').length, 5);
  assert.equal(root.querySelector('[data-zaptos-action-item="forward"]').textContent, 'Encaminhar Mensagem');
});
test('modal cancels without sending; preview uses text, never HTML', async () => {
  const calls = []; const app = frontend(async (action) => { calls.push(action); return preview; });
  await app.api.runForwardAction({ messageId });
  assert.equal(app.document.querySelector('.za-forward-preview script'), null);
  app.document.querySelector('.za-modal-footer button').click();
  assert.equal(app.document.querySelector('.za-overlay'), null);
  assert.deepEqual(calls, ['preview', 'recent']);
});
test('contact search ignores stale responses and requires explicit selection; double click sends once', async () => {
  let oldResolve, finishSend; const calls = [];
  const app = frontend(async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'preview') return preview;
    if (action === 'recent') return { contacts: [], listKind: 'recent' };
    if (action === 'search' && payload.query === 'old') return new Promise((resolve) => { oldResolve = resolve; });
    if (action === 'search') return { contacts: [{ id: contactId, name: '<b>Maria</b>', phone: '+5511999999999' }] };
    return new Promise((resolve) => { finishSend = resolve; });
  });
  await app.api.runForwardAction({ messageId });
  type(app, 'old'); await delay(380);
  type(app, 'Maria'); await delay(380);
  oldResolve({ contacts: [{ id: 'old123456789', name: 'Wrong', phone: '+5511888888888' }] }); await delay();
  const contact = app.document.querySelector('.za-forward-contact');
  assert.match(contact.textContent, /Maria/); assert.equal(contact.querySelector('b'), null);
  const send = app.document.querySelector('.za-modal-footer .primary');
  assert.equal(send.disabled, true); contact.click(); assert.equal(send.disabled, false);
  send.click(); send.click(); await delay();
  assert.equal(calls.filter((call) => call.action === 'forward').length, 1);
  assert.equal(calls.at(-1).payload.contactId, contactId);
  finishSend({ ok: true }); await delay();
  assert.equal(app.document.querySelector('.za-overlay'), null);
});
test('changing route while preparing cannot enable or send the stale message', async () => {
  let finish; const app = frontend(async () => new Promise((resolve) => { finish = resolve; }));
  const opening = app.api.runForwardAction({ messageId }); await delay();
  app.location.href += '/other'; finish(preview); await opening;
  assert.equal(app.document.querySelector('.za-overlay'), null);
});

test('changed message after preview requires a new review before sending', async () => {
  const app = backend();
  const preview = await app.request('preview');
  app.source.body = 'edited after preview';
  const result = await app.request('forward', { requestId: randomUUID(), expectedRevision: preview.data.message.revision });
  assert.equal(result.data.code, 'message_changed');
  assert.equal(app.db.tables.ghl_message_forwards.length, 0);
});


test('standalone implementation has no receiver dependency or service-key HTTP dispatch', () => {
  assert.doesNotMatch(edgeSource, /ghl_in-redis|ZAPTOS_FORWARD_RECEIVER_URL|zaptosForwardRequestId/);
  assert.doesNotMatch(edgeSource, /Authorization:.*SUPABASE_SERVICE_ROLE_KEY/);
});
test('provider timeout does not repeat WhatsApp delivery on retry', async () => {
  const app = backend(); const requestId = randomUUID();
  app.runtime.overrideFetch = async (url) => { if (url.includes('/send/media')) throw new Error('timeout'); };
  assert.equal((await app.request('forward', { requestId })).data.code, 'provider_unconfirmed');
  assert.equal((await app.request('forward', { requestId })).status, 409);
  assert.equal(app.calls.filter((call) => call.url.endsWith('/send/media')).length, 1);
});
test('ambiguous or foreign instances never send and do not create destination history', async () => {
  for (const mode of ['foreign', 'ambiguous']) {
    const app = backend(); const row = app.db.tables.uazapi[0];
    if (mode === 'foreign') row.LocationID = 'other123456789';
    else app.db.tables.uazapi.push({ ...row, id: 'instance987654321' });
    assert.equal((await app.request('forward', { requestId: randomUUID() })).data.code, 'instance_ambiguous');
    assert.equal(app.calls.some((call) => call.url.endsWith('/messages/inbound')), false);
  }
});
test('multiple attachments preserve captions, save receipts, and partial sends cannot restart', async () => {
  const app = backend();
  app.source.attachments.push('https://files.example/audio.ogg');
  let mediaCount = 0;
  app.runtime.overrideFetch = async (url) => {
    if (url.endsWith('/send/media') && ++mediaCount === 2) return new Response('{}', { status: 503 });
  };
  const requestId = randomUUID();
  assert.equal((await app.request('forward', { requestId })).data.code, 'provider_error');
  assert.equal(app.calls.filter((call) => call.url.includes('/send/')).length, 3);
  assert.equal(app.db.tables.ghl_message_forwards[0].provider_message_ids.length, 2);
  assert.equal((await app.request('forward', { requestId })).status, 409);
  assert.equal(mediaCount, 2);
});
test('official channel decrypts only on server and sends text/media to its gateway', async () => {
  const app = backend(); const row = app.db.tables.uazapi[0];
  const dataKey = webcrypto.getRandomValues(new Uint8Array(32));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['encrypt']);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(`uazapi:${row.id}:official_api_key`) }, key, new TextEncoder().encode('zto_live_test-only'));
  Object.assign(row, { api_oficial: true, status: 'active', phone_number_id: '123456789',
    official_api_key_ciphertext: Buffer.from(encrypted).toString('base64url'),
    official_api_key_iv: Buffer.from(iv).toString('base64url'), official_api_key_key_version: 1 });
  app.env.ZAPTOS_LOCAL_DATA_KEY = Buffer.from(dataKey).toString('base64url');
  app.runtime.overrideFetch = async (url) => {
    if (url.startsWith('https://whatsapp.example/')) return Response.json({ messages: [{ id: 'wamid.test123456789' }] });
  };
  const result = await app.request('forward', { requestId: randomUUID() });
  assert.equal(result.status, 200);
  const sent = app.calls.find((call) => call.url.endsWith('/123456789/messages'));
  assert.equal(sent.headers.Authorization, 'Bearer zto_live_test-only');
  assert.equal(sent.body.image.link, app.source.attachments[0]);
  assert.equal(sent.body.image.caption, 'Olá 👋\nVeja o arquivo');
  assert.doesNotMatch(JSON.stringify(result), /zto_live|private-instance-token|test-service-key/);
});

test('configuration error names only missing secrets, never their values', async () => {
  for (const missing of ['GHL_APP_ID', 'GHL_APP_SHARED_SECRET', 'GHL_CONVERSATION_PROVIDER_ID']) {
    const app = backend();
    delete app.env[missing];
    const result = await app.request('config');
    assert.equal(result.status, 503);
    assert.equal(result.data.code, 'not_configured');
    assert.equal(result.data.error, `Configure os secrets ausentes da Edge Function: ${missing}.`);
    assert.doesNotMatch(JSON.stringify(result), /test-only-shared-secret|test-service-key/);
  }
  const app = backend();
  const result = await app.request('config');
  assert.deepEqual(result.data, { ok: true, appId: app.env.GHL_APP_ID });
});


test('missing forwarding table gives migration instructions before any outbound request', async () => {
  for (const code of ['42P01', 'PGRST205']) {
    const app = backend();
    app.db.errors.ghl_message_forwards = { code, message: 'private SQL and row content' };
    const result = await app.request('forward', { requestId: randomUUID() });
    assert.equal(result.status, 503);
    assert.equal(result.data.code, 'forward_table_missing');
    assert.match(result.data.error, /20261016_ghl_message_forwards.sql/);
    assert.doesNotMatch(JSON.stringify(result), /private SQL/);
    assert.equal(app.calls.length, 0);
  }
});
test('storage permission and schema failures have distinct safe diagnostics', async () => {
  for (const [code, expected] of [['42501', 'forward_storage_forbidden'], ['42703', 'forward_schema_outdated'], ['PGRST204', 'forward_schema_outdated'], ['XX000', 'storage_error']]) {
    const app = backend();
    app.db.errors.ghl_message_forwards = { code, message: 'test-service-key' };
    const result = await app.request('forward', { requestId: randomUUID() });
    assert.equal(result.data.code, expected);
    assert.doesNotMatch(JSON.stringify(result), /test-service-key/);
    assert.equal(app.calls.length, 0);
  }
});


test('recent conversations are scoped, sorted, deduplicated and contain only recipient fields', async () => {
  const app = backend(); const result = await app.request('recent');
  assert.equal(result.status, 200);
  assert.equal(result.data.listKind, 'recent');
  assert.deepEqual(result.data.contacts, [{ id: contactId, name: 'Maria Silva', phone: '+5511999999999' }]);
  const params = new URL(app.calls[0].url).searchParams;
  assert.equal(params.get('locationId'), locationId);
  assert.equal(params.get('sortBy'), 'last_message_date');
  assert.equal(params.get('sort'), 'desc');
});
test('missing conversations scope falls back to contacts without mislabeling them as recent', async () => {
  const app = backend();
  app.runtime.overrideFetch = async (url) => url.includes('/conversations/search?') ? new Response('{}', { status: 403 }) : null;
  const result = await app.request('recent');
  assert.equal(result.status, 200);
  assert.equal(result.data.listKind, 'contacts');
  assert.equal(result.data.contacts.length, 1);
});
test('GHL failures identify stage and HTTP status without exposing upstream body or retrying sends', async () => {
  for (const [action, path, operation, status] of [
    ['preview', '/conversations/messages/', 'read_message', 404],
    ['search', '/contacts/search', 'search_contacts', 500],
    ['forward', '/messages/inbound', 'register_message', 400]
  ]) {
    const app = backend();
    app.runtime.overrideFetch = async (url) => url.includes(path)
      ? Response.json({ message: 'private contact email test-service-key' }, { status }) : null;
    const result = await app.request(action, { requestId: randomUUID(), query: 'Maria' });
    assert.equal(result.data.operation, operation);
    assert.equal(result.data.upstreamStatus, status);
    assert.match(result.data.error, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(JSON.stringify(result), /private contact|test-service-key/);
    assert.equal(app.calls.filter((call) => call.url.includes('/send/')).length, 0);
  }
});
test('opening modal lists recent recipients without typing; clearing search restores recents', async () => {
  const calls = [];
  const app = frontend(async (action) => {
    calls.push(action);
    if (action === 'preview') return preview;
    return { listKind: 'recent', contacts: [{ id: contactId, name: 'Maria', phone: '+5511999999999' }] };
  });
  await app.api.runForwardAction({ messageId }); await delay();
  assert.deepEqual(calls, ['preview', 'recent']);
  assert.match(app.document.querySelector('.za-forward-contact').textContent, /Maria/);
  assert.equal(app.document.querySelector('.za-modal-footer .primary').disabled, true);
  type(app, 'Maria'); await delay(380);
  type(app, ''); await delay(380);
  assert.deepEqual(calls, ['preview', 'recent', 'search', 'recent']);
  app.api.forwardState.activeClose();
});
test('failed recent list leaves the search available', async () => {
  const app = frontend(async (action) => {
    if (action === 'preview') return preview;
    if (action === 'recent') throw new Error('GHL indisponível');
    return { contacts: [{ id: contactId, name: 'Maria', phone: '+5511999999999' }] };
  });
  await app.api.runForwardAction({ messageId }); await delay();
  assert.equal(app.document.querySelector('#za-forward-search').disabled, false);
  assert.match(app.document.querySelector('.za-forward-status').textContent, /Você pode pesquisar/);
  type(app, 'Maria'); await delay(380);
  assert.ok(app.document.querySelector('.za-forward-contact'));
  app.api.forwardState.activeClose();
});

test('history registration omits undocumented status and empty optional content fields', async () => {
  for (const mediaOnly of [false, true]) {
    const app = backend();
    if (mediaOnly) app.source.body = '';
    else app.source.attachments = [];
    app.runtime.overrideFetch = async (url, options) => {
      if (!url.endsWith('/messages/inbound')) return;
      const body = JSON.parse(options.body);
      const allowed = ['type', 'contactId', 'conversationProviderId', 'direction', 'message', 'attachments'];
      if (Object.keys(body).some((key) => !allowed.includes(key)) || body.message === '' || body.attachments?.length === 0) {
        return Response.json({ message: ['property status should not exist'] }, { status: 422 });
      }
    };
    assert.equal((await app.request('forward', { requestId: randomUUID() })).status, 200);
    const body = app.calls.find((call) => call.url.endsWith('/messages/inbound')).body;
    assert.equal('status' in body, false);
    assert.equal('message' in body, !mediaOnly);
    assert.equal('attachments' in body, mediaOnly);
    assert.equal(app.calls.filter((call) => call.url.includes('/send/')).length, 1);
  }
});

test('422 validation returns only allowlisted fields and rules and never dispatches or retries', async () => {
  const app = backend(); const requestId = randomUUID();
  app.runtime.overrideFetch = async (url) => url.endsWith('/messages/inbound') ? Response.json({ message: [
    'property status should not exist',
    'each value in attachments must be a URL address: https://private.example/secret',
    'contactId must be a string: private-contact-id',
    'privateToken must be a string: private-token',
    'private-contact-id contains message and status',
    'direction must be one of the following values: private-value'
  ], contact: { phone: '+5511888888888' } }, { status: 422 }) : null;
  const result = await app.request('forward', { requestId });
  assert.equal(result.data.upstreamStatus, 422);
  assert.equal(result.data.operation, 'register_message');
  assert.deepEqual(result.data.validationIssues, [
    { field: 'status', rule: 'unexpected_field' }, { field: 'attachments', rule: 'invalid_url' },
    { field: 'contactId', rule: 'string_expected' }, { field: 'direction', rule: 'invalid_option' }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private|5511888888888/);
  assert.equal((await app.request('forward', { requestId })).status, 409);
  assert.equal(app.calls.filter((call) => call.url.endsWith('/messages/inbound')).length, 1);
  assert.equal(app.calls.filter((call) => call.url.includes('/send/')).length, 0);
});
