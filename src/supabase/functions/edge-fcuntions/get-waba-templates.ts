import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-zaptos-location-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const SOURCE_TABLE = 'uazapi';
const MAX_INSTANCES = 100;
const MAX_TEMPLATE_PAGES = 20;
const FETCH_TIMEOUT_MS = readPositiveIntEnv('WABA_TEMPLATE_FETCH_TIMEOUT_MS', 12000);
const GRAPH_VERSION = normalizeGraphVersion(Deno.env.get('META_GRAPH_VERSION'));

type JsonMap = Record<string, unknown>;

type OfficialInstanceRow = JsonMap & {
  id?: unknown;
  nome?: unknown;
  waba_id?: unknown;
  url?: unknown;
  'Instance Url'?: unknown;
  official_api_key_ciphertext?: unknown;
  official_api_key_iv?: unknown;
  official_api_key_key_version?: unknown;
};

type OfficialInstanceQuery = {
  eq: (column: string, value: unknown) => OfficialInstanceQuery;
  limit: (count: number) => Promise<{ data: unknown; error: unknown }>;
};

type OfficialInstanceClient = {
  from: (table: string) => {
    select: (columns: string) => OfficialInstanceQuery;
  };
};

function readString(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function readPositiveIntEnv(name: string, fallbackValue: number): number {
  const parsed = Number(readString(Deno.env.get(name)));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallbackValue;
}

function normalizeGraphVersion(value: unknown): string {
  const version = readString(value);
  return /^v\d+\.\d+$/.test(version) ? version : 'v25.0';
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function errorResponse(status: number, code: string, error: string): Response {
  return jsonResponse({ ok: false, code, error }, status);
}

async function readJsonBody(req: Request): Promise<JsonMap> {
  const raw = await req.text().catch(() => '');
  if (!raw) return {};
  if (raw.length > 20_000) throw new Error('INVALID_BODY');

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('INVALID_BODY');
    }
    return parsed as JsonMap;
  } catch {
    throw new Error('INVALID_BODY');
  }
}

function resolveLocationId(req: Request, payload: JsonMap): string {
  return readString(
    payload.location_id ??
      payload.locationId ??
      payload.locationid ??
      req.headers.get('x-zaptos-location-id')
  );
}

function isValidLocationId(locationId: string): boolean {
  return /^[A-Za-z0-9_-]{4,128}$/.test(locationId);
}

function normalizeInstanceName(row: OfficialInstanceRow): string {
  return readString(row.nome)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
    .trim();
}

function hasOfficialCredential(row: OfficialInstanceRow): boolean {
  return Boolean(
    readString(row.id) &&
      readString(row.waba_id) &&
      readString(row.official_api_key_ciphertext) &&
      readString(row.official_api_key_iv) &&
      Number(row.official_api_key_key_version ?? 1) === 1
  );
}

async function loadOfficialInstances(
  supabaseValue: unknown,
  locationId: string
): Promise<OfficialInstanceRow[]> {
  const supabase = supabaseValue as OfficialInstanceClient;
  const { data, error } = await supabase
    .from(SOURCE_TABLE)
    .select(
      'id,nome,waba_id,url,"Instance Url",official_api_key_ciphertext,official_api_key_iv,official_api_key_key_version'
    )
    .eq('LocationID', locationId)
    .eq('api_oficial', true)
    .limit(MAX_INSTANCES);

  if (error) throw new Error('INSTANCE_LOOKUP_FAILED');

  return (Array.isArray(data) ? data : [])
    .map((row) => (row || {}) as OfficialInstanceRow)
    .filter((row) => hasOfficialCredential(row));
}

function publicInstanceList(rows: OfficialInstanceRow[]) {
  const deduped = new Map<string, string>();

  for (const row of rows) {
    const name = normalizeInstanceName(row);
    if (!name) continue;
    const key = name.toLocaleLowerCase('pt-BR');
    if (!deduped.has(key)) deduped.set(key, name);
  }

  return Array.from(deduped.values())
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
    .map((instance_name) => ({ instance_name }));
}

function findInstanceByName(
  rows: OfficialInstanceRow[],
  requestedName: string
): OfficialInstanceRow | null {
  const normalized = requestedName.toLocaleLowerCase('pt-BR');
  const matches = rows.filter(
    (row) => normalizeInstanceName(row).toLocaleLowerCase('pt-BR') === normalized
  );

  if (matches.length > 1) throw new Error('INSTANCE_NAME_AMBIGUOUS');
  return matches[0] || null;
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

async function decryptOfficialApiKey(row: OfficialInstanceRow): Promise<string> {
  const instanceId = readString(row.id);
  const ciphertext = readString(row.official_api_key_ciphertext);
  const encodedIv = readString(row.official_api_key_iv);
  const encodedDataKey = readString(Deno.env.get('ZAPTOS_LOCAL_DATA_KEY'));
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

function resolveGatewayBaseUrl(row: OfficialInstanceRow): string {
  const configured =
    readString(Deno.env.get('ZAPTOS_OFFICIAL_GATEWAY_URL')) ||
    readString(Deno.env.get('OFFICIAL_GATEWAY_URL'));
  const raw = configured || readString(row.url ?? row['Instance Url']);
  if (!raw) throw new Error('GATEWAY_URL_MISSING');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('GATEWAY_URL_INVALID');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('GATEWAY_URL_INVALID');
  }

  return parsed.toString().replace(/\/+$/, '');
}

async function fetchJsonWithTimeout(url: URL, apiKey: string): Promise<JsonMap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      }
    });
    const raw = await response.text().catch(() => '');

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('GATEWAY_NOT_AUTHORIZED');
      }
      if (response.status === 429) throw new Error('GATEWAY_RATE_LIMITED');
      throw new Error('GATEWAY_REQUEST_FAILED');
    }

    try {
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as JsonMap)
        : {};
    } catch {
      throw new Error('GATEWAY_INVALID_RESPONSE');
    }
  } finally {
    clearTimeout(timer);
  }
}

function containsTemplateVariables(value: unknown): boolean {
  if (typeof value === 'string') return /\{\{\s*[^{}]+\s*\}\}/.test(value);
  if (Array.isArray(value)) return value.some(containsTemplateVariables);
  if (value && typeof value === 'object') {
    return Object.values(value as JsonMap).some(containsTemplateVariables);
  }
  return false;
}

function truncateText(value: unknown, maxLength: number): string {
  const text = readString(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function buildTemplatePreview(components: unknown): {
  preview: string;
  headerText: string;
  bodyText: string;
  footerText: string;
  buttons: string[];
  headerFormat: string;
  requiresMedia: boolean;
  hasVariables: boolean;
} {
  const rows = Array.isArray(components)
    ? components.filter(
        (item): item is JsonMap =>
          Boolean(item && typeof item === 'object' && !Array.isArray(item))
      )
    : [];
  const previewParts: string[] = [];
  let headerFormat = '';
  let headerText = '';
  let bodyText = '';
  let footerText = '';
  let buttons: string[] = [];

  for (const component of rows) {
    const type = readString(component.type).toUpperCase();
    if (type === 'HEADER') {
      headerFormat = readString(component.format).toUpperCase() || 'TEXT';
      const text = truncateText(component.text, 500);
      if (!headerText) headerText = text;
      if (text) previewParts.push(text);
      continue;
    }
    if (type === 'BODY') {
      const text = truncateText(component.text, 1500);
      if (!bodyText) bodyText = text;
      if (text) previewParts.push(text);
      continue;
    }
    if (type === 'FOOTER') {
      const text = truncateText(component.text, 300);
      if (!footerText) footerText = text;
      if (text) previewParts.push(text);
      continue;
    }
    if (type === 'BUTTONS' && Array.isArray(component.buttons)) {
      const labels = component.buttons
        .map((button) =>
          button && typeof button === 'object' && !Array.isArray(button)
            ? truncateText((button as JsonMap).text, 80)
            : ''
        )
        .filter(Boolean)
        .slice(0, 10);
      if (!buttons.length) buttons = labels;
      if (labels.length) previewParts.push(`Botoes: ${labels.join(' | ')}`);
    }
  }

  const requiresMedia = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat);
  return {
    preview: truncateText(previewParts.join('\n\n'), 2200),
    headerText,
    bodyText,
    footerText,
    buttons,
    headerFormat,
    requiresMedia,
    hasVariables: containsTemplateVariables(rows)
  };
}

function sanitizeTemplate(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as JsonMap;
  const templateName = readString(row.name).toLowerCase();
  const language = readString(row.language);
  if (!/^[a-z0-9_]{1,512}$/.test(templateName) || !language) return null;

  const status = readString(row.status).toUpperCase() || 'UNKNOWN';
  const category = readString(row.category).toUpperCase() || 'UTILITY';
  const previewData = buildTemplatePreview(row.components);
  const canUse =
    status === 'APPROVED' &&
    !previewData.hasVariables &&
    previewData.headerFormat !== 'LOCATION';

  return {
    template_name: templateName,
    language,
    category,
    status,
    preview: previewData.preview,
    header_text: previewData.headerText,
    body_text: previewData.bodyText,
    footer_text: previewData.footerText,
    buttons: previewData.buttons,
    header_format: previewData.headerFormat || null,
    requires_media: previewData.requiresMedia,
    has_variables: previewData.hasVariables,
    can_use: canUse
  };
}

async function fetchOfficialTemplates(row: OfficialInstanceRow) {
  const wabaId = readString(row.waba_id);
  if (!/^\d+$/.test(wabaId)) throw new Error('INSTANCE_METADATA_INVALID');

  const apiKey = await decryptOfficialApiKey(row);
  const baseUrl = resolveGatewayBaseUrl(row);
  const templates: JsonMap[] = [];
  let after = '';
  let page = 0;

  do {
    page += 1;
    const url = new URL(
      `${baseUrl}/${GRAPH_VERSION}/${wabaId}/message_templates`
    );
    url.searchParams.set(
      'fields',
      'name,language,status,category,components'
    );
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);

    const payload = await fetchJsonWithTimeout(url, apiKey);
    if (Array.isArray(payload.data)) {
      templates.push(
        ...payload.data.filter(
          (item): item is JsonMap =>
            Boolean(item && typeof item === 'object' && !Array.isArray(item))
        )
      );
    }

    const paging =
      payload.paging &&
      typeof payload.paging === 'object' &&
      !Array.isArray(payload.paging)
        ? (payload.paging as JsonMap)
        : {};
    const cursors =
      paging.cursors &&
      typeof paging.cursors === 'object' &&
      !Array.isArray(paging.cursors)
        ? (paging.cursors as JsonMap)
        : {};
    after = paging.next ? readString(cursors.after) : '';
  } while (after && page < MAX_TEMPLATE_PAGES);

  // O comando #template seleciona pelo nome (nao pelo idioma). Mantemos uma
  // unica opcao por nome, priorizando a primeira versao aprovada retornada pelo
  // gateway, que e a mesma regra usada pelo processamento de envio atual.
  const deduped = new Map<string, NonNullable<ReturnType<typeof sanitizeTemplate>>>();
  for (const template of templates) {
    const sanitized = sanitizeTemplate(template);
    if (!sanitized) continue;
    const current = deduped.get(sanitized.template_name);
    if (!current || (current.status !== 'APPROVED' && sanitized.status === 'APPROVED')) {
      deduped.set(sanitized.template_name, sanitized);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    if (a.status === 'APPROVED' && b.status !== 'APPROVED') return -1;
    if (a.status !== 'APPROVED' && b.status === 'APPROVED') return 1;
    const byName = a.template_name.localeCompare(b.template_name, 'pt-BR');
    return byName || a.language.localeCompare(b.language, 'pt-BR');
  });
}

function publicError(error: unknown): { status: number; code: string; message: string } {
  const code = readString((error as { message?: unknown })?.message);
  if (code === 'INVALID_BODY') {
    return { status: 400, code: 'invalid_body', message: 'Corpo da requisicao invalido.' };
  }
  if (code === 'INSTANCE_LOOKUP_FAILED') {
    return { status: 500, code: 'instance_lookup_failed', message: 'Erro ao buscar instancias oficiais.' };
  }
  if (code === 'INSTANCE_NAME_AMBIGUOUS') {
    return { status: 409, code: 'instance_name_ambiguous', message: 'Existem instancias oficiais com o mesmo nome. Renomeie uma delas para continuar.' };
  }
  if (code === 'GATEWAY_NOT_AUTHORIZED') {
    return { status: 502, code: 'gateway_not_authorized', message: 'A instancia nao esta autorizada a consultar templates.' };
  }
  if (code === 'GATEWAY_RATE_LIMITED') {
    return { status: 429, code: 'gateway_rate_limited', message: 'A consulta foi limitada temporariamente. Tente novamente.' };
  }
  if (code === 'CREDENTIAL_CONFIGURATION_INVALID' || code === 'CREDENTIAL_DECRYPTION_FAILED') {
    return { status: 500, code: 'credential_unavailable', message: 'A credencial segura da instancia nao esta disponivel.' };
  }
  if (
    code === 'GATEWAY_URL_MISSING' ||
    code === 'GATEWAY_URL_INVALID' ||
    code === 'INSTANCE_METADATA_INVALID'
  ) {
    return { status: 500, code: 'instance_not_configured', message: 'A instancia oficial esta incompleta.' };
  }
  if ((error as { name?: unknown })?.name === 'AbortError') {
    return { status: 504, code: 'gateway_timeout', message: 'A consulta de templates excedeu o tempo limite.' };
  }
  return { status: 502, code: 'template_sync_failed', message: 'Nao foi possivel sincronizar os templates.' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  try {
    const supabaseUrl = readString(Deno.env.get('SUPABASE_URL'));
    const serviceRoleKey = readString(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (!supabaseUrl || !serviceRoleKey) {
      return errorResponse(500, 'server_not_configured', 'Servico nao configurado.');
    }

    const payload = await readJsonBody(req);
    const action = readString(payload.action).toLowerCase();
    const locationId = resolveLocationId(req, payload);
    if (!isValidLocationId(locationId)) {
      return errorResponse(400, 'location_required', 'Subconta invalida.');
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const rows = await loadOfficialInstances(supabase, locationId);

    if (action === 'list_instances') {
      const instances = publicInstanceList(rows);
      return jsonResponse({ ok: true, instances, count: instances.length });
    }

    if (action === 'sync_templates' || action === 'list_templates') {
      const instanceName = readString(
        payload.instance_name ?? payload.instanceName
      );
      if (!instanceName || instanceName.length > 200) {
        return errorResponse(400, 'instance_required', 'Selecione uma instancia oficial.');
      }

      const instance = findInstanceByName(rows, instanceName);
      if (!instance) {
        return errorResponse(404, 'instance_not_found', 'Instancia oficial nao encontrada nesta subconta.');
      }

      const templates = await fetchOfficialTemplates(instance);
      return jsonResponse({
        ok: true,
        instance_name: normalizeInstanceName(instance),
        templates,
        count: templates.length,
        synced_at: new Date().toISOString()
      });
    }

    return errorResponse(400, 'action_not_supported', 'Acao nao suportada.');
  } catch (error) {
    const safe = publicError(error);
    return errorResponse(safe.status, safe.code, safe.message);
  }
});
