import assert from 'node:assert/strict';
import vm from 'node:vm';

const uiSource = await Deno.readTextFile(new URL('../src/zaptos-actions-original.js', import.meta.url));
const ui = { window: {}, location: { href: 'https://crm.example/location/test' }, TextEncoder, File, FormData, URL, AbortController, setTimeout, clearTimeout, btoa };
vm.runInNewContext(uiSource.slice(0, uiSource.lastIndexOf("  document.addEventListener('pointerdown'")) + `
  window.test = { validateTemplateMedia, normalizeOfficialTemplates, buildOfficialTemplateParameters,
    useOfficialTemplate, attachTemplateMedia, callTemplateEdge,
    setWriter: (fn) => { writeAndSendCommand = fn; }, setToast: (fn) => { showToast = fn; }
  };
})();`, ui);
const frontend = (ui.window as any).test;
const edgeSource = (await Deno.readTextFile(new URL('../src/supabase/functions/edge-fcuntions/get-waba-templates.ts', import.meta.url)))
  .replace(/import \{ createClient \} from '[^']+';/, '');
const edgeModule = edgeSource.slice(0, edgeSource.indexOf('Deno.serve(async')) + `
  export { buildTemplateSubmission, validateTemplateMediaFile, readTemplateRequest, createOfficialTemplate, sanitizeTemplate };
`;
// The data module is TypeScript, avoiding a production export or starting an HTTP server.
const edge = await import(`data:application/typescript;base64,${btoa(unescape(encodeURIComponent(edgeModule)))}`);

function sample(format: string): File {
  const samples: Record<string, [number[], string, string]> = {
    IMAGE: [[137, 80, 78, 71, 13, 10, 26, 10], 'image/png', 'exemplo.png'],
    VIDEO: [[0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109], 'video/mp4', 'exemplo.mp4'],
    DOCUMENT: [[37, 80, 68, 70, 45, 49, 46, 55], 'application/pdf', 'exemplo.pdf']
  };
  const [bytes, type, name] = samples[format];
  return new File([new Uint8Array(bytes)], name, { type });
}

function input(format: string) {
  return { template: { name: 'pedido_confirmado', category: 'UTILITY', language: 'pt_BR', header_format: format,
    body_text: 'Olá {{1}}, seu pedido chegou.', body_examples: ['João'] } };
}

for (const format of ['IMAGE', 'VIDEO', 'DOCUMENT']) {
  Deno.test(`${format}: validates sample, sends multipart, preserves body parameters`, async () => {
    const file = sample(format);
    assert.equal(frontend.validateTemplateMedia(file, format), '');
    await edge.validateTemplateMediaFile(file, format);
    const form = new FormData();
    form.append('payload', JSON.stringify({ action: 'create_template', ...input(format) }));
    form.append('media', file);
    const parsed = await edge.readTemplateRequest(new Request('https://example.test', { method: 'POST', body: form }));
    assert.equal(parsed.media.name, file.name);
    const submission = edge.buildTemplateSubmission(parsed.payload);
    assert.deepEqual(submission.components[0], { type: 'HEADER', format });
    const sanitized = edge.sanitizeTemplate({ ...submission.request, status: 'APPROVED' });
    const template = frontend.normalizeOfficialTemplates({ templates: [sanitized] })[0];
    assert.equal(template.canUse, true);
    assert.equal(template.requiresMedia, true);
    assert.equal(frontend.buildOfficialTemplateParameters(template, {}).ok, false);
    const parameters = frontend.buildOfficialTemplateParameters(template, { 'BODY:1': 'João' });
    assert.equal(parameters.ok, true);
    let command = '';
    frontend.setWriter((text: string, opts: any) => { command = text; assert.equal(opts.autoSend, false); return true; });
    assert.equal(await frontend.useOfficialTemplate('Oficial', template, parameters.parameters, file), true);
    assert.match(command, /^#switch:Oficial\n#template:pedido_confirmado\n#templateparams:/);
    const encoded = command.split('#templateparams:')[1];
    assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (v) => v.charCodeAt(0)))), { body: ['João'] });
    assert.ok(!command.includes('blob:'));
  });
}

Deno.test('rejects missing, wrong type, empty, oversized and forged files', async () => {
  for (const format of ['IMAGE', 'VIDEO', 'DOCUMENT']) {
    assert.ok(frontend.validateTemplateMedia(null, format));
    assert.ok(frontend.validateTemplateMedia(new File([], 'empty', { type: sample(format).type }), format));
    assert.ok(frontend.validateTemplateMedia({ type: sample(format).type, size: 101 * 1024 * 1024 }, format));
    await assert.rejects(() => edge.validateTemplateMediaFile(new File(['not media'], 'fake', { type: sample(format).type }), format), /INVALID_TEMPLATE_MEDIA/);
  }
  assert.ok(frontend.validateTemplateMedia(sample('VIDEO'), 'IMAGE'));
  await assert.rejects(() => edge.validateTemplateMediaFile(sample('VIDEO'), 'IMAGE'), /INVALID_TEMPLATE_MEDIA/);
  await assert.rejects(() => edge.createOfficialTemplate({ waba_id: '123' }, input('IMAGE')), /TEMPLATE_MEDIA_REQUIRED/);
  await assert.rejects(() => edge.createOfficialTemplate({ waba_id: '123' }, input('NONE'), sample('IMAGE')), /INVALID_TEMPLATE_MEDIA/);
});

Deno.test('text/authentication templates still work and nonapproved templates stay disabled', () => {
  const text = edge.buildTemplateSubmission({ template: { ...input('TEXT').template, header_text: 'Pedido {{1}}', header_examples: ['123'] } });
  assert.deepEqual(text.components[0].example, { header_text: ['123'] });
  const auth = edge.buildTemplateSubmission({ template: { ...input('NONE').template, category: 'AUTHENTICATION' } });
  assert.equal(auth.components.some((part: any) => part.type === 'HEADER'), false);
  for (const status of ['PENDING', 'REJECTED']) {
    const row = edge.sanitizeTemplate({ ...text.request, status });
    assert.equal(frontend.normalizeOfficialTemplates({ templates: [row] })[0].canUse, false);
  }
});

Deno.test('multipart rejects duplicates and media on unrelated actions; JSON stays supported', async () => {
  const request = () => {
    const form = new FormData();
    form.append('payload', JSON.stringify({ action: 'sync_templates' }));
    form.append('media', sample('IMAGE'));
    return new Request('https://example.test', { method: 'POST', body: form });
  };
  await assert.rejects(() => edge.readTemplateRequest(request()), /INVALID_BODY/);
  const form = new FormData();
  form.append('payload', JSON.stringify({ action: 'create_template' }));
  form.append('media', sample('IMAGE')); form.append('media', sample('IMAGE'));
  await assert.rejects(() => edge.readTemplateRequest(new Request('https://example.test', { method: 'POST', body: form })), /INVALID_BODY/);
  assert.deepEqual(await edge.readTemplateRequest(new Request('https://example.test', { method: 'POST', body: JSON.stringify({ action: 'sync_templates' }) })), { payload: { action: 'sync_templates' }, media: null });
});

Deno.test('attaches only one compatible composer input and excludes the template file picker', () => {
  const runtime = ui as any;
  const events: string[] = [];
  const nativeInput = { accept: 'image/*', disabled: false, files: null, closest: () => null,
    dispatchEvent: (event: Event) => events.push(event.type) };
  const modalInput = { ...nativeInput, closest: () => ({}) };
  const audioInput = { ...nativeInput, accept: 'audio/*' };
  const file = sample('IMAGE');
  runtime.Event = Event;
  runtime.DataTransfer = class {
    files: File[] = [];
    items = { add: (entry: File) => { this.files.push(entry); } };
  };
  let inputs = [nativeInput, modalInput, audioInput];
  runtime.document = { body: {}, querySelectorAll: () => inputs };
  frontend.setToast(() => {});
  const composer = { parentElement: { querySelectorAll: () => inputs, parentElement: null } };
  assert.equal(frontend.attachTemplateMedia(composer, file), true);
  assert.equal((nativeInput.files as any)[0], file);
  assert.deepEqual(events, ['input', 'change']);
  events.length = 0;
  inputs = [nativeInput, { ...nativeInput }];
  assert.equal(frontend.attachTemplateMedia(composer, file), false);
  assert.deepEqual(events, []);
  inputs = [modalInput, audioInput];
  assert.equal(frontend.attachTemplateMedia(composer, file), false);
});

Deno.test('frontend sends binary multipart for samples and JSON for text templates', async () => {
  const runtime = ui as any;
  const requests: RequestInit[] = [];
  runtime.fetch = (_url: string, init: RequestInit) => {
    requests.push(init);
    return Promise.resolve(Response.json({ ok: true }));
  };
  await frontend.callTemplateEdge('create_template', { location_id: 'test-location', ...input('IMAGE') }, sample('IMAGE'));
  assert.ok(requests[0].body instanceof FormData);
  assert.equal(new Headers(requests[0].headers).has('Content-Type'), false);
  assert.equal((requests[0].body as FormData).get('media') instanceof File, true);
  await frontend.callTemplateEdge('create_template', { location_id: 'test-location', ...input('NONE') });
  assert.equal(new Headers(requests[1].headers).get('Content-Type'), 'application/json');
  assert.equal(JSON.parse(String(requests[1].body)).template.header_format, 'NONE');
});

Deno.test('creation uploads the sample before submission and uses the returned Meta handle', async () => {
  const keyBytes = new Uint8Array(32).fill(7);
  const iv = new Uint8Array(12).fill(2);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('uazapi:test-instance:official_api_key') }, key, new TextEncoder().encode('zto_live_test_only'));
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const previousKey = Deno.env.get('ZAPTOS_LOCAL_DATA_KEY');
  const previousGateway = Deno.env.get('ZAPTOS_OFFICIAL_GATEWAY_URL');
  Deno.env.set('ZAPTOS_LOCAL_DATA_KEY', b64(keyBytes));
  Deno.env.set('ZAPTOS_OFFICIAL_GATEWAY_URL', 'https://gateway.example');
  const fetchOriginal = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Promise.resolve(Response.json(calls.length === 1 ? { h: '4::example-handle' } : { id: '42', status: 'PENDING' }));
  };
  try {
    const result = await edge.createOfficialTemplate({ id: 'test-instance', waba_id: '123', official_api_key_ciphertext: b64(new Uint8Array(ciphertext)), official_api_key_iv: b64(iv) }, input('IMAGE'), sample('IMAGE'));
    assert.equal(result.status, 'PENDING');
    assert.match(calls[0].url, /\/123\/template_media\?/);
    assert.ok(calls[0].init.body instanceof File);
    const body = JSON.parse(String(calls[1].init.body));
    assert.deepEqual(body.components[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::example-handle'] } });
    calls.length = 0;
    globalThis.fetch = () => Promise.resolve(Response.json({ error: 'upload failed' }, { status: 422 }));
    await assert.rejects(() => edge.createOfficialTemplate({ id: 'test-instance', waba_id: '123', official_api_key_ciphertext: b64(new Uint8Array(ciphertext)), official_api_key_iv: b64(iv) }, input('IMAGE'), sample('IMAGE')), /GATEWAY_TEMPLATE_REJECTED/);
  } finally {
    globalThis.fetch = fetchOriginal;
    previousKey === undefined ? Deno.env.delete('ZAPTOS_LOCAL_DATA_KEY') : Deno.env.set('ZAPTOS_LOCAL_DATA_KEY', previousKey);
    previousGateway === undefined ? Deno.env.delete('ZAPTOS_OFFICIAL_GATEWAY_URL') : Deno.env.set('ZAPTOS_OFFICIAL_GATEWAY_URL', previousGateway);
  }
});
