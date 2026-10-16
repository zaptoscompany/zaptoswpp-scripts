// Deploy as forward-ghl-message. Authentication is the GHL encrypted session,
// verified below (Supabase gateway verify_jwt=false; no anonymous data access).
// @ts-ignore Deno HTTP import
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// @ts-ignore Deno HTTP import
import CryptoJS from 'https://esm.sh/crypto-js@4.2.0';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };
type RecordValue = Record<string, any>;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store'
};
const MAX_TEXT_LENGTH = 20000;
const ID = /^[A-Za-z0-9_-]{8,80}$/;
class ForwardError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: RecordValue) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new ForwardError(status, code, message); }
function forwardStorageError(error: RecordValue, operation: string): never {
  // Keep SQL text, record contents and credentials out of browser responses/logs.
  const dbCode = /^[A-Z0-9]{5,12}$/.test(String(error?.code)) ? String(error.code) : 'UNKNOWN';
  console.warn('forward-ghl-message storage failure', { operation, code: dbCode });
  if (['42P01', 'PGRST205'].includes(dbCode)) {
    fail(503, 'forward_table_missing', 'A tabela ghl_message_forwards não foi encontrada. Execute a migração 20261016_ghl_message_forwards.sql no mesmo projeto Supabase da função.');
  }
  if (['42703', 'PGRST204'].includes(dbCode)) {
    fail(503, 'forward_schema_outdated', 'A estrutura de ghl_message_forwards está incompleta. Confira a migração 20261016_ghl_message_forwards.sql.');
  }
  if (dbCode === '42501') {
    fail(503, 'forward_storage_forbidden', 'A função não tem permissão para acessar ghl_message_forwards. Confira as permissões da migração e a configuração da chave de serviço no servidor.');
  }
  fail(500, 'storage_error', `Não foi possível acessar o registro de encaminhamento (código ${dbCode}). Consulte os logs da função.`);
}
function string(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}
function requireId(value: unknown): string {
  const result = string(value);
  if (!ID.test(result)) fail(400, 'invalid_id', 'Identificador inválido. Abra novamente o encaminhamento.');
  return result;
}
function verifySession(encryptedData: unknown, locationId: string, secret: string): RecordValue {
  if (typeof encryptedData !== 'string' || encryptedData.length > 16000) fail(401, 'invalid_session', 'Sessão inválida. Recarregue o CRM.');
  let user;
  try { user = JSON.parse(CryptoJS.AES.decrypt(encryptedData, secret).toString(CryptoJS.enc.Utf8)); } catch { /* fail closed */ }
  if (!user || !ID.test(string(user.userId)) || string(user.activeLocation) !== locationId) {
    fail(403, 'invalid_session', 'Sua sessão não permite acessar esta subconta.');
  }
  return user;
}
function normalizePhone(value: unknown): string {
  const raw = string(value).replace(/[\s().-]/g, '');
  return /^\+?[1-9]\d{7,14}$/.test(raw) ? `+${raw.replace(/^\+/, '')}` : '';
}
function normalizeContact(contact: RecordValue, locationId: string): RecordValue | null {
  if (!ID.test(string(contact.id)) || contact.locationId !== locationId) return null;
  return {
    id: contact.id,
    name: string(contact.contactName || contact.name) || [string(contact.firstName), string(contact.lastName)].filter(Boolean).join(' ') || 'Contato sem nome',
    phone: normalizePhone(contact.phone)
  };
}
function normalizeSource(message: RecordValue, locationId: string, forwarded = false): { text: string; attachments: string[]; contactId: string } {
  if (message.locationId !== locationId || !ID.test(string(message.contactId))) fail(403, 'wrong_location', 'Mensagem fora da subconta atual.');
  if (!['inbound', 'outbound'].includes(message.direction) || !['SMS', 'TYPE_SMS', 'Custom', 'TYPE_CUSTOM'].includes(message.messageType)) {
    fail(422, 'unsupported_message', 'Selecione uma mensagem de texto ou mídia do WhatsApp.');
  }
  if (['failed', 'undelivered', 'scheduled', 'pending'].includes(message.status)) fail(422, 'message_not_sent', 'Esta mensagem ainda não foi enviada ou falhou.');
  if (message.contentType && message.contentType !== 'text/plain') fail(422, 'unsupported_message', 'Este formato de mensagem não pode ser encaminhado.');
  let text = typeof message.body === 'string' ? message.body : '';
  if (!forwarded) {
    // Do not forward an action command or a system notification as customer content.
    if (message.direction === 'outbound' && /^\s*(?:#[a-z_]+\s*:|\[System\])/i.test(text)) fail(422, 'command_message', 'Comandos e avisos do sistema não podem ser encaminhados. Selecione a mensagem original.');
    text = text.replace(/\n?\s*Instance Source\s*:[^\n\r]*\s*$/i, '');
  }
  if (text.length > MAX_TEXT_LENGTH) fail(422, 'message_too_large', 'Esta mensagem é muito longa para encaminhar.');
  const attachments = message.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 10) fail(422, 'invalid_attachments', 'Esta mensagem contém anexos não suportados.');
  for (const attachment of attachments) {
    try {
      const url = new URL(attachment);
      if (typeof attachment !== 'string' || attachment.length > 4096 || url.protocol !== 'https:' || url.username || url.password) throw new Error();
    } catch { fail(422, 'invalid_attachments', 'Um anexo não está disponível para encaminhamento.'); }
  }
  if (!text.trim() && !attachments.length) fail(422, 'empty_message', 'Esta mensagem não possui texto ou anexos encaminháveis.');
  return { text, attachments, contactId: message.contactId };
}
async function sourceRevision(source: { text: string; attachments: string[] }): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([source.text, source.attachments])));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function ghlOperation(path: string): string {
  if (path.startsWith('/conversations/search')) return 'recent_conversations';
  if (path === '/contacts/search') return 'search_contacts';
  if (path === '/conversations/messages/inbound') return 'register_message';
  if (path.startsWith('/conversations/messages/')) return 'read_message';
  if (path.startsWith('/contacts/')) return 'read_contact';
  return 'ghl_request';
}
function ghlValidationIssues(raw: string): { field: string; rule: string }[] {
  // Emit only our own field/rule labels, never upstream text or rejected values.
  const fields = ['type', 'contactId', 'conversationId', 'conversationProviderId', 'message', 'attachments', 'direction', 'status', 'locationId'];
  const rules: [RegExp, string][] = [
    [/should not exist/i, 'unexpected_field'],
    [/must not be empty|should not be empty|is required/i, 'required'],
    [/must be (?:a |an )?string/i, 'string_expected'],
    [/must be (?:a |an )?array/i, 'array_expected'],
    [/must be (?:a |an )?(?:valid )?(?:enum|one of)/i, 'invalid_option'],
    [/must be (?:a |an )?(?:valid )?(?:mongo.?id|uuid)/i, 'invalid_id'],
    [/must be (?:a |an )?(?:valid )?url/i, 'invalid_url']
  ];
  let payload;
  try { payload = JSON.parse(raw); } catch { return []; }
  const messages = Array.isArray(payload?.message) ? payload.message : [payload?.message];
  const issues: { field: string; rule: string }[] = [];
  for (const message of messages.slice(0, 30)) {
    if (typeof message !== 'string') continue;
    const field = fields.find((name) => new RegExp(`^(?:property |each value in )?${name}\\b`).test(message));
    const rule = rules.find(([pattern]) => pattern.test(message))?.[1];
    if (field && rule && !issues.some((issue) => issue.field === field && issue.rule === rule)) issues.push({ field, rule });
  }
  return issues;
}
async function ghlRequest(auth: string, path: string, body?: unknown): Promise<RecordValue> {
  const operation = ghlOperation(path);
  const labels: Record<string, string> = {
    recent_conversations: 'listar as conversas recentes', search_contacts: 'buscar os contatos',
    register_message: 'registrar a mensagem na conversa de destino', read_message: 'ler a mensagem original',
    read_contact: 'consultar o contato de destino', ghl_request: 'concluir a operação'
  };
  let response;
  try {
    response = await fetch(`https://services.leadconnectorhq.com${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: auth, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new ForwardError(504, 'ghl_timeout', `A GHL não respondeu a tempo ao ${labels[operation]}.`, { operation });
  }
  if (!response.ok) {
    // Do not return/log upstream bodies: they may contain contact data or credentials.
    const upstream = await response.text().catch(() => '');
    const validationIssues = [400, 422].includes(response.status) ? ghlValidationIssues(upstream) : [];
    const details = { operation, upstreamStatus: response.status,
      ...(validationIssues.length ? { validationIssues } : {}) };
    console.warn('forward-ghl-message GHL failure', details);
    let code = 'ghl_error';
    let hint = '';
    if (response.status === 401 || response.status === 403) {
      code = 'ghl_auth';
      hint = operation === 'recent_conversations'
        ? ' Verifique o escopo conversations.readonly do aplicativo.'
        : ' Verifique a conexão e as permissões da integração com o WhatsApp.';
    } else if (response.status === 429) {
      code = 'rate_limit'; hint = ' Aguarde um momento antes de tentar novamente.';
    } else if (response.status === 404) {
      hint = ' O recurso solicitado não foi encontrado na GHL.';
    } else if ([400, 422].includes(response.status)) {
      hint = ' A GHL recusou os dados da solicitação.';
      if (validationIssues.length) hint += ` Campos recusados: ${[...new Set(validationIssues.map((issue) => issue.field))].join(', ')}.`;
      if (operation === 'register_message' && /conversation.?provider|provider.?id/i.test(upstream)) {
        code = 'ghl_provider_invalid';
        hint = ' Confira se GHL_CONVERSATION_PROVIDER_ID pertence ao provedor SMS do aplicativo instalado nesta subconta.';
      }
    } else if (response.status >= 500) {
      hint = ' A GHL apresentou uma falha temporária.';
    }
    throw new ForwardError(response.status === 429 ? 429 : 502, code,
      `Falha ao ${labels[operation]} na GHL (HTTP ${response.status}).${hint}`, details);
  }
  try { return await response.json(); } catch {
    throw new ForwardError(502, 'invalid_response', `A GHL retornou uma resposta inválida ao ${labels[operation]}.`, { operation });
  }
}
async function recentForwardContacts(auth: string, locationId: string): Promise<RecordValue> {
  const params = new URLSearchParams({ locationId, limit: '20', sort: 'desc', sortBy: 'last_message_date' });
  let result;
  try { result = await ghlRequest(auth, `/conversations/search?${params}`); }
  catch (error) {
    // Older app installations may have contacts scope but not conversations scope.
    if (!(error instanceof ForwardError) || error.details?.upstreamStatus !== 403) throw error;
    const fallback = await ghlRequest(auth, '/contacts/search', { locationId, page: 1, pageLimit: 20 });
    if (!Array.isArray(fallback.contacts)) fail(502, 'invalid_response', 'Não foi possível carregar os contatos.');
    return { ok: true, listKind: 'contacts', contacts: fallback.contacts.slice(0, 20)
      .map((contact: RecordValue) => normalizeContact(contact, locationId)).filter(Boolean) };
  }
  if (!Array.isArray(result.conversations)) fail(502, 'invalid_response', 'Não foi possível carregar as conversas recentes.');
  const seen = new Set<string>();
  const contacts = [];
  for (const conversation of result.conversations.slice(0, 20)) {
    const contact = normalizeContact({ ...conversation, id: conversation.contactId,
      name: conversation.contactName || conversation.fullName }, locationId);
    if (!contact || seen.has(contact.id)) continue;
    seen.add(contact.id);
    contacts.push(contact);
  }
  return { ok: true, listKind: 'recent', contacts };
}
async function loadSource(db: any, auth: string, locationId: string, messageId: string) {
  // Only messages already linked to WhatsApp by our receiver are eligible.
  const { data, error } = await db.from('messages').select('id, body').eq('location_id', locationId).eq('mensagem', messageId).limit(1);
  if (error) fail(500, 'lookup_failed', 'Não foi possível consultar a mensagem.');
  if (!data?.length) fail(404, 'message_not_found', 'Mensagem não encontrada no WhatsApp. Aguarde a sincronização e tente novamente.');
  const response = await ghlRequest(auth, `/conversations/messages/${encodeURIComponent(messageId)}`);
  const message = response.message || response;
  if (message.id !== messageId) fail(502, 'invalid_response', 'A GHL não retornou a mensagem solicitada.');
  return normalizeSource(message, locationId, data[0]?.body?.forward === true);
}
function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function decryptOfficialApiKey(row: RecordValue): Promise<string> {
  const instanceId = string(row.id);
  const ciphertext = string(row.official_api_key_ciphertext);
  const encodedIv = string(row.official_api_key_iv);
  const encodedDataKey = string(Deno.env.get('ZAPTOS_LOCAL_DATA_KEY'));
  const keyVersion = Number(row.official_api_key_key_version ?? 1);

  if (
    !instanceId ||
    !ciphertext ||
    !encodedIv ||
    !encodedDataKey ||
    keyVersion !== 1
  ) {
    throw new Error('CREDENTIAL_CONFIGURATION_INVALID');
  }

  let dataKey: Uint8Array | null = null;
  try {
    dataKey = base64UrlToBytes(encodedDataKey);
    const iv = base64UrlToBytes(encodedIv);
    const encrypted = base64UrlToBytes(ciphertext);

    if (dataKey.byteLength !== 32 || iv.byteLength !== 12 || encrypted.byteLength < 17) {
      throw new Error('INVALID_ENVELOPE');
    }

    const key = await crypto.subtle.importKey(
      'raw',
      ownedBuffer(dataKey),
      'AES-GCM',
      false,
      ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ownedBuffer(iv),
        additionalData: ownedBuffer(
          new TextEncoder().encode(`uazapi:${instanceId}:official_api_key`)
        )
      },
      key,
      ownedBuffer(encrypted)
    );
    const apiKey = new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
    if (!apiKey.startsWith('zto_live_')) throw new Error('INVALID_KEY_PREFIX');
    return apiKey;
  } catch {
    throw new Error('CREDENTIAL_DECRYPTION_FAILED');
  } finally {
    if (dataKey) dataKey.fill(0);
  }
}

function providerBase(instance: RecordValue): string {
  try {
    const url = new URL(string(instance.url || instance['Instance Url']));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch { return fail(503, 'invalid_instance', 'O endereço do provedor de WhatsApp não está configurado.'); }
}
async function selectForwardInstance(db: any, locationId: string, contactId: string, userId: string): Promise<RecordValue> {
  const { data: rows, error } = await db.from(Deno.env.get('INSTANCE_DELETION_ASYNC_ENABLED') === 'false' ? 'uazapi_active' : 'uazapi').select('id, nome, url, "Instance Url", "Instance Token", "userID", is_primary, api_oficial, phone_number_id, status, official_api_key_ciphertext, official_api_key_iv, official_api_key_key_version')
    .eq('LocationID', locationId);
  if (error) fail(503, 'instance_lookup', 'Não foi possível consultar os canais de WhatsApp.');
  const instances = rows || [];
  const { data: map, error: mapError } = await db.from('whatsapp_instance_map').select('instance').eq('location_id', locationId).eq('contact_id', contactId).maybeSingle();
  if (mapError) fail(503, 'instance_lookup', 'Não foi possível consultar o canal do contato.');
  const assigned = instances.filter((row: RecordValue) => {
    let ids = row.userID;
    if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = [ids]; } }
    return Array.isArray(ids) && ids.includes(userId);
  });
  const mapped = string(map?.instance);
  const candidates = assigned.length ? assigned : mapped
    ? instances.filter((row: RecordValue) => string(row.nome).toLowerCase() === mapped.toLowerCase())
    : instances.some((row: RecordValue) => row.is_primary === true)
      ? instances.filter((row: RecordValue) => row.is_primary === true) : instances;
  if (candidates.length !== 1) fail(422, 'instance_ambiguous', 'Defina um canal de WhatsApp para o contato ou um único canal principal.');
  const instance = candidates[0];
  providerBase(instance);
  if (instance.api_oficial === true) {
    if (!['active', 'connected'].includes(string(instance.status).toLowerCase()) || !/^\d+$/.test(string(instance.phone_number_id))) {
      fail(422, 'instance_offline', 'O canal oficial não está ativo.');
    }
  } else if (!string(instance['Instance Token'])) fail(503, 'invalid_instance', 'O canal não possui credencial de envio.');
  return instance;
}
function attachmentType(url: string): string {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.(jpe?g|png|gif|webp)$/.test(path)) return 'image';
  if (/\.(mp4|mov|3gp|webm)$/.test(path)) return 'video';
  if (/\.(mp3|ogg|opus|wav|m4a|aac|amr)$/.test(path)) return 'audio';
  return 'document';
}
function forwardParts(payload: RecordValue): RecordValue[] {
  const attachments: string[] = payload.attachments;
  const text: string = payload.text;
  const parts: RecordValue[] = [];
  const mediaType = attachments.length === 1 ? attachmentType(attachments[0]) : '';
  if (text && (attachments.length !== 1 || mediaType === 'audio')) parts.push({ type: 'text', text });
  for (const url of attachments) parts.push({ type: attachmentType(url), url,
    caption: attachments.length === 1 && mediaType !== 'audio' ? text : '' });
  return parts;
}
async function sendForwardPart(instance: RecordValue, phone: string, part: RecordValue, officialKey: string): Promise<string> {
  const official = instance.api_oficial === true;
  const base = providerBase(instance);
  const version = string(Deno.env.get('META_GRAPH_VERSION')) || 'v25.0';
  if (!/^v\d+\.\d+$/.test(version)) fail(503, 'invalid_version', 'Versão da API oficial inválida.');
  let body: RecordValue;
  let path: string;
  let headers: Record<string, string>;
  if (official) {
    path = `/${version}/${instance.phone_number_id}/messages`;
    headers = { Authorization: `Bearer ${officialKey}` };
    body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.replace(/^\+/, ''), type: part.type };
    body[part.type] = part.type === 'text' ? { body: part.text, preview_url: false }
      : { link: part.url, ...(part.caption ? { caption: part.caption } : {}) };
  } else {
    path = part.type === 'text' ? '/send/text' : '/send/media';
    headers = { token: instance['Instance Token'] };
    body = { number: phone.replace(/^\+/, ''), forward: true,
      ...(part.type === 'text' ? { text: part.text, linkPreview: false }
        : { type: part.type, file: part.url, text: part.caption }) };
  }
  let response;
  try {
    response = await fetch(base + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch { return fail(504, 'provider_unconfirmed', 'O provedor não confirmou o envio. Não repita antes de verificar a conversa.'); }
  if (!response.ok) fail(502, 'provider_error', 'O provedor recusou o encaminhamento. Verifique o canal e as regras de envio.');
  const data = await response.json().catch(() => ({}));
  const id = official ? data.messages?.[0]?.id : data.messageid || data.messageId || data.message_id || data.msgId || data.id || data.key?.id || data.message?.key?.id || data.data?.messageId || data.data?.id;
  if (typeof id !== 'string' || !id) fail(502, 'provider_unconfirmed', 'O provedor não retornou a confirmação do envio.');
  return id;
}
async function dispatchForward(db: any, row: RecordValue): Promise<void> {
  // Compare-and-set gives this request a single sender, including concurrent retries.
  const { data: claimed, error } = await db.from('ghl_message_forwards').update({ status: 'dispatching' })
    .eq('request_id', row.request_id).eq('status', 'registered').select('*').maybeSingle();
  if (error || !claimed) fail(409, 'send_unconfirmed', 'O encaminhamento já está em andamento. Verifique o resultado em instantes.');
  const { data: instance, error: instanceError } = await db.from(Deno.env.get('INSTANCE_DELETION_ASYNC_ENABLED') === 'false' ? 'uazapi_active' : 'uazapi').select('*')
    .eq('LocationID', row.location_id).eq('id', row.payload.instanceId).maybeSingle();
  if (instanceError || !instance) {
    fail(503, 'instance_unavailable', 'O canal de WhatsApp não está disponível.');
  }
  const officialKey = instance.api_oficial === true ? await decryptOfficialApiKey(instance) : '';
  if (instance.api_oficial === true && !['active', 'connected'].includes(string(instance.status).toLowerCase())) {
    fail(422, 'instance_offline', 'O canal oficial não está ativo.');
  }
  const ids: string[] = [];
  for (const part of forwardParts(row.payload)) {
    const id = await sendForwardPart(instance, row.payload.phone, part, officialKey);
    ids.push(id);
    // Persist each receipt; never repeat a partially confirmed batch automatically.
    const { error: saveError } = await db.from('ghl_message_forwards').update({ provider_message_ids: ids })
      .eq('request_id', row.request_id);
    if (saveError) fail(502, 'send_unconfirmed', 'Envio solicitado, mas a confirmação não pôde ser salva.');
  }
  const { error: messageError } = await db.from('messages').insert({
    location_id: row.location_id, remote_jid: `${row.payload.phone.replace(/^\+/, '')}@s.whatsapp.net`,
    message_id: ids[0], mensagem: row.ghl_message_id, direction: 'out', status: 'sent', ts: new Date().toISOString(),
    body: { text: row.payload.text, attachments: row.payload.attachments, forward: true,
      providerMessageIds: ids, uazapiId: instance.id,
      raw: { contactId: row.target_contact_id, conversationId: row.conversation_id, messageId: row.ghl_message_id } }
  });
  if (messageError) fail(502, 'send_unconfirmed', 'Envio solicitado, mas não foi possível sincronizar o histórico.');
  const { error: acceptedError } = await db.from('ghl_message_forwards').update({ status: 'accepted' }).eq('request_id', row.request_id);
  if (acceptedError) fail(502, 'send_unconfirmed', 'Envio solicitado, mas não foi possível salvar a confirmação.');
}

async function handleForwardRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
  try {
    const raw = await req.text();
    if (raw.length > 25000) fail(413, 'too_large', 'Solicitação muito grande.');
    let input;
    try { input = JSON.parse(raw); } catch { fail(400, 'invalid_json', 'Solicitação inválida.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_json', 'Solicitação inválida.');
    const appId = string(Deno.env.get('GHL_APP_ID'));
    const secret = string(Deno.env.get('GHL_APP_SHARED_SECRET'));
    const providerId = string(Deno.env.get('GHL_CONVERSATION_PROVIDER_ID'));
    const missingConfig = [
      !appId && 'GHL_APP_ID',
      !secret && 'GHL_APP_SHARED_SECRET',
      !providerId && 'GHL_CONVERSATION_PROVIDER_ID'
    ].filter(Boolean);
    if (missingConfig.length) fail(503, 'not_configured',
      `Configure os secrets ausentes da Edge Function: ${missingConfig.join(', ')}.`);
    if (input.action === 'config') return json({ ok: true, appId });
    if (!['recent', 'search', 'preview', 'forward'].includes(input.action)) fail(400, 'invalid_action', 'Ação inválida.');
    const locationId = requireId(input.locationId);
    const user = verifySession(input.encryptedData, locationId, secret);
    const db = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', { auth: { persistSession: false } });
    const { data: token, error } = await db.from('code_autorization_ghl').select('access_token, token_type').eq('LocationId', locationId).maybeSingle();
    if (error || !token?.access_token) fail(503, 'not_connected', 'Conecte esta subconta à integração com o WhatsApp.');
    const auth = `${token.token_type || 'Bearer'} ${token.access_token}`;
    if (input.action === 'recent') return json(await recentForwardContacts(auth, locationId));
    if (input.action === 'search') {
      let query = string(input.query);
      if (query.length < 2 || query.length > 100) fail(400, 'invalid_query', 'Digite entre 2 e 100 caracteres.');
      if (/^[+\d\s().-]+$/.test(query)) query = query.replace(/[^\d+]/g, '');
      const result = await ghlRequest(auth, '/contacts/search', { locationId, page: 1, pageLimit: 20, query });
      if (!Array.isArray(result.contacts)) fail(502, 'invalid_response', 'Não foi possível carregar os contatos.');
      return json({ ok: true, contacts: result.contacts.map((contact: RecordValue) => normalizeContact(contact, locationId)).filter(Boolean) });
    }
    const messageId = requireId(input.messageId);
    if (input.action === 'preview') {
      const source = await loadSource(db, auth, locationId, messageId);
      return json({ ok: true, message: { text: source.text, attachmentCount: source.attachments.length, contactId: source.contactId, revision: await sourceRevision(source) } });
    }
    const contactId = requireId(input.contactId);
    const requestId = string(input.requestId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) fail(400, 'invalid_request_id', 'Identificador de envio inválido.');
    // Check before rereading the source: retries never recreate the GHL message.
    const readExisting = async () => {
      const { data: existing, error: readError } = await db.from('ghl_message_forwards').select('*').eq('request_id', requestId).maybeSingle();
      if (readError) forwardStorageError(readError, 'read_request');
      if (!existing) return null;
      if (existing.location_id !== locationId || existing.user_id !== user.userId || existing.source_message_id !== messageId || existing.target_contact_id !== contactId) {
        fail(409, 'request_conflict', 'Esta solicitação já está associada a outro encaminhamento.');
      }
      if (existing.status === 'registered') { await dispatchForward(db, existing); return json({ ok: true, messageId: existing.ghl_message_id, conversationId: existing.conversation_id }); }
      if (existing.status === 'accepted') return json({ ok: true, messageId: existing.ghl_message_id, conversationId: existing.conversation_id });
      fail(409, 'send_unconfirmed', 'Este envio já foi solicitado. Confira a conversa de destino; ele não será repetido automaticamente.');
    };
    const existing = await readExisting();
    if (existing) return existing;
    const source = await loadSource(db, auth, locationId, messageId);
    if (input.expectedRevision !== await sourceRevision(source)) fail(409, 'message_changed', 'A mensagem foi alterada. Reabra o encaminhamento para revisar o conteúdo.');
    if (source.contactId === contactId) fail(400, 'same_contact', 'Escolha outro contato para encaminhar.');
    const contactResponse = await ghlRequest(auth, `/contacts/${encodeURIComponent(contactId)}`);
    const contact = normalizeContact(contactResponse.contact || contactResponse, locationId);
    if (!contact?.phone) fail(422, 'invalid_contact', 'O contato não possui telefone válido nesta subconta.');
    if (contact.phone !== normalizePhone(input.expectedPhone)) fail(409, 'contact_changed', 'O telefone do contato mudou. Pesquise e selecione o contato novamente.');
    const instance = await selectForwardInstance(db, locationId, contactId, user.userId);
    if (instance.api_oficial === true) await decryptOfficialApiKey(instance);
    const { error: insertError } = await db.from('ghl_message_forwards').insert({ request_id: requestId, location_id: locationId,
      user_id: user.userId, source_message_id: messageId, target_contact_id: contactId, status: 'submitting',
      payload: { text: source.text, attachments: source.attachments, phone: contact.phone, instanceId: instance.id } });
    if (insertError) {
      if (insertError.code === '23505') { const duplicate = await readExisting(); if (duplicate) return duplicate; }
      forwardStorageError(insertError, 'insert_request');
    }
    // Never retry this POST automatically, including after a timeout or lost response.
    const result = await ghlRequest(auth, '/conversations/messages/inbound', {
      type: 'SMS', contactId, conversationProviderId: providerId,
      // This endpoint does not document a status field. Delivery receipts belong
      // to the status API/webhooks; omit optional empty content fields as well.
      ...(source.text.trim() ? { message: source.text } : {}),
      ...(source.attachments.length ? { attachments: source.attachments } : {}),
      direction: 'outbound'
    });
    if (!ID.test(string(result.messageId)) || !ID.test(string(result.conversationId))) fail(502, 'send_unconfirmed', 'A GHL não confirmou o encaminhamento.');
    const { error: updateError } = await db.from('ghl_message_forwards').update({ status: 'registered', ghl_message_id: result.messageId,
      conversation_id: result.conversationId }).eq('request_id', requestId);
    if (updateError) fail(502, 'send_unconfirmed', 'O envio foi solicitado, mas não foi possível salvar a confirmação.');
    await dispatchForward(db, { request_id: requestId, location_id: locationId, target_contact_id: contactId,
      ghl_message_id: result.messageId, conversation_id: result.conversationId,
      payload: { text: source.text, attachments: source.attachments, phone: contact.phone, instanceId: instance.id } });
    return json({ ok: true, messageId: result.messageId, conversationId: result.conversationId });
  } catch (error) {
    if (error instanceof ForwardError) return json({ ok: false, code: error.code, error: error.message, ...(error.details || {}) }, error.status);
    return json({ ok: false, code: 'internal_error', error: 'Não foi possível concluir o encaminhamento.' }, 500);
  }
}
Deno.serve(handleForwardRequest);
