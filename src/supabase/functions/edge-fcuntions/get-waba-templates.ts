// @ts-ignore -- O runtime Deno resolve imports HTTP; o TypeScript padrão do VS Code não.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

declare const Deno: {
  env: {
    get(name: string): string | undefined;
  };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

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
  if (raw.length > 50_000) throw new Error('INVALID_BODY');

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

async function requestJsonWithTimeout(
  url: URL,
  apiKey: string,
  method: 'GET' | 'POST' = 'GET',
  body?: JsonMap
): Promise<JsonMap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const raw = await response.text().catch(() => '');

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('GATEWAY_NOT_AUTHORIZED');
      }
      if (response.status === 429) throw new Error('GATEWAY_RATE_LIMITED');
      if (response.status === 400 || response.status === 409 || response.status === 422) {
        throw new Error('GATEWAY_TEMPLATE_REJECTED');
      }
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

function normalizeTemplateText(value: unknown, maxLength: number): string {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, maxLength + 1);
}

function templateVariableIndexes(text: string): number[] {
  const matches = Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g));
  return Array.from(new Set(matches.map((match) => Number(match[1])))).sort(
    (a, b) => a - b
  );
}

function assertSequentialVariables(text: string, examples: unknown): string[] {
  const indexes = templateVariableIndexes(text);
  const invalidPlaceholder = /\{\{[^{}]*\}\}/.test(
    text.replace(/\{\{\s*\d+\s*\}\}/g, '')
  );
  if (invalidPlaceholder || indexes.some((index, position) => index !== position + 1)) {
    throw new Error('INVALID_TEMPLATE_VARIABLES');
  }

  const values = (Array.isArray(examples) ? examples : [])
    .map((item) => normalizeTemplateText(item, 200))
    .filter(Boolean);
  if (indexes.length !== values.length) throw new Error('TEMPLATE_EXAMPLES_REQUIRED');
  return values;
}

function buildTemplateSubmission(payload: JsonMap): {
  request: JsonMap;
  components: JsonMap[];
} {
  const input =
    payload.template &&
      typeof payload.template === 'object' &&
      !Array.isArray(payload.template)
      ? (payload.template as JsonMap)
      : payload;
  const name = readString(input.name).toLowerCase();
  const language = readString(input.language);
  const category = readString(input.category).toUpperCase();

  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new Error('INVALID_TEMPLATE_NAME');
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
    throw new Error('INVALID_TEMPLATE_LANGUAGE');
  }
  if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(category)) {
    throw new Error('INVALID_TEMPLATE_CATEGORY');
  }

  if (category === 'AUTHENTICATION') {
    const expirationMinutes = Math.min(
      90,
      Math.max(1, Number(input.code_expiration_minutes) || 10)
    );
    const components: JsonMap[] = [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: expirationMinutes },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copiar código' }]
      }
    ];
    return { request: { name, language, category, components }, components };
  }

  const headerFormat = readString(input.header_format).toUpperCase() || 'NONE';
  if (!['NONE', 'TEXT'].includes(headerFormat)) {
    throw new Error('UNSUPPORTED_TEMPLATE_HEADER');
  }

  const components: JsonMap[] = [];
  if (headerFormat === 'TEXT') {
    const headerText = normalizeTemplateText(input.header_text, 60);
    if (!headerText || headerText.length > 60) throw new Error('INVALID_TEMPLATE_HEADER');
    const headerExamples = assertSequentialVariables(
      headerText,
      input.header_examples
    );
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: headerText,
      ...(headerExamples.length
        ? { example: { header_text: headerExamples } }
        : {})
    });
  }

  const bodyText = normalizeTemplateText(input.body_text, 1024);
  if (!bodyText || bodyText.length > 1024) throw new Error('INVALID_TEMPLATE_BODY');
  const bodyExamples = assertSequentialVariables(bodyText, input.body_examples);
  components.push({
    type: 'BODY',
    text: bodyText,
    ...(bodyExamples.length
      ? { example: { body_text: [bodyExamples] } }
      : {})
  });

  const footerText = normalizeTemplateText(input.footer_text, 60);
  if (footerText.length > 60) throw new Error('INVALID_TEMPLATE_FOOTER');
  if (footerText) components.push({ type: 'FOOTER', text: footerText });

  const rawButtons = Array.isArray(input.buttons) ? input.buttons : [];
  if (rawButtons.length > 10) throw new Error('INVALID_TEMPLATE_BUTTONS');
  const buttons: JsonMap[] = [];
  for (const rawButton of rawButtons) {
    if (!rawButton || typeof rawButton !== 'object' || Array.isArray(rawButton)) {
      throw new Error('INVALID_TEMPLATE_BUTTONS');
    }
    const button = rawButton as JsonMap;
    const type = readString(button.type).toUpperCase();
    const text = normalizeTemplateText(button.text, 25);
    if (!text || text.length > 25) throw new Error('INVALID_TEMPLATE_BUTTONS');

    if (type === 'QUICK_REPLY') {
      buttons.push({ type, text });
      continue;
    }
    if (type === 'URL') {
      const urlText = readString(button.url);
      let url: URL;
      try {
        url = new URL(urlText.replace(/\{\{\s*1\s*\}\}/g, 'example'));
      } catch {
        throw new Error('INVALID_TEMPLATE_BUTTONS');
      }
      if (url.protocol !== 'https:') throw new Error('INVALID_TEMPLATE_BUTTONS');
      const dynamic = /\{\{\s*1\s*\}\}/.test(urlText);
      const example = normalizeTemplateText(button.example, 300);
      if (dynamic && !example) throw new Error('TEMPLATE_EXAMPLES_REQUIRED');
      buttons.push({ type, text, url: urlText, ...(dynamic ? { example: [example] } : {}) });
      continue;
    }
    if (type === 'PHONE_NUMBER') {
      const phoneNumber = readString(button.phone_number).replace(/[^\d+]/g, '');
      if (!/^\+?\d{8,20}$/.test(phoneNumber)) {
        throw new Error('INVALID_TEMPLATE_BUTTONS');
      }
      buttons.push({ type, text, phone_number: phoneNumber });
      continue;
    }
    throw new Error('INVALID_TEMPLATE_BUTTONS');
  }
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });

  return { request: { name, language, category, components }, components };
}

function containsTemplateVariables(value: unknown): boolean {
  if (typeof value === 'string') return /\{\{\s*[^{}]+\s*\}\}/.test(value);
  if (Array.isArray(value)) return value.some(containsTemplateVariables);
  if (value && typeof value === 'object') {
    return Object.values(value as JsonMap).some(containsTemplateVariables);
  }
  return false;
}

type TemplateParameterButtonSchema = {
  index: number;
  type: 'URL' | 'COPY_CODE' | 'QUICK_REPLY';
  label: string;
  value_count: number;
  required: boolean;
  max_value_bytes: number;
};

// Metadados mínimos para montar o formulário no navegador. URLs, exemplos,
// credenciais e a definição completa aprovada permanecem somente no backend.
type TemplateParameterSchema = {
  supported: boolean;
  header: {
    type: 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
    value_count: number;
  };
  body: { value_count: number };
  buttons: TemplateParameterButtonSchema[];
  location_required: boolean;
  has_parameter_fields: boolean;
  error_code: string | null;
};

function templateParameterSchemaError(errorCode: string): TemplateParameterSchema {
  return {
    supported: false,
    header: { type: 'NONE', value_count: 0 },
    body: { value_count: 0 },
    buttons: [],
    location_required: false,
    has_parameter_fields: false,
    error_code: errorCode
  };
}

function approvedPlaceholderIndexes(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  const indexes = new Set<number>();
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const rawIndex = readString(match[1]);
    if (!/^[1-9]\d*$/.test(rawIndex)) throw new Error('NAMED_PLACEHOLDER');
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index > 50) {
      throw new Error('INVALID_PLACEHOLDER_SEQUENCE');
    }
    indexes.add(index);
  }
  const ordered = Array.from(indexes).sort((left, right) => left - right);
  if (ordered.some((index, position) => index !== position + 1)) {
    throw new Error('INVALID_PLACEHOLDER_SEQUENCE');
  }
  return ordered;
}

function buildTemplateParameterSchema(components: unknown): TemplateParameterSchema {
  const rows = Array.isArray(components)
    ? components.filter(
        (item): item is JsonMap =>
          Boolean(item && typeof item === 'object' && !Array.isArray(item))
      )
    : [];
  const schema: TemplateParameterSchema = {
    supported: true,
    header: { type: 'NONE', value_count: 0 },
    body: { value_count: 0 },
    buttons: [],
    location_required: false,
    has_parameter_fields: false,
    error_code: null
  };
  let headerSeen = false;
  let bodySeen = false;
  let buttonsSeen = false;

  try {
    for (const component of rows) {
      const type = readString(component.type).toUpperCase();
      if (type === 'HEADER') {
        if (headerSeen) throw new Error('DUPLICATE_HEADER');
        headerSeen = true;
        const format = readString(component.format).toUpperCase() || 'TEXT';
        if (!['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(format)) {
          throw new Error('UNSUPPORTED_HEADER');
        }
        schema.header.type = format as TemplateParameterSchema['header']['type'];
        if (format === 'TEXT') {
          schema.header.value_count = approvedPlaceholderIndexes(component.text).length;
        } else if (format === 'LOCATION') {
          schema.location_required = true;
        }
        continue;
      }
      if (type === 'BODY') {
        if (bodySeen) throw new Error('DUPLICATE_BODY');
        bodySeen = true;
        schema.body.value_count = approvedPlaceholderIndexes(component.text).length;
        continue;
      }
      if (type === 'BUTTONS') {
        if (buttonsSeen) throw new Error('DUPLICATE_BUTTONS');
        buttonsSeen = true;
        if (!Array.isArray(component.buttons) || component.buttons.length > 10) {
          throw new Error('UNSUPPORTED_BUTTONS');
        }
        for (let index = 0; index < component.buttons.length; index += 1) {
          const rawButton = component.buttons[index];
          if (!rawButton || typeof rawButton !== 'object' || Array.isArray(rawButton)) {
            throw new Error('UNSUPPORTED_BUTTON');
          }
          const button = rawButton as JsonMap;
          const buttonType = readString(button.type).toUpperCase();
          const label = truncateText(button.text, 80) || `Botão ${index + 1}`;
          if (buttonType === 'URL') {
            const valueCount = approvedPlaceholderIndexes(button.url).length;
            if (valueCount > 0) {
              schema.buttons.push({
                index,
                type: 'URL',
                label,
                value_count: valueCount,
                required: true,
                max_value_bytes: 2048
              });
            }
            continue;
          }
          if (buttonType === 'COPY_CODE') {
            schema.buttons.push({
              index,
              type: 'COPY_CODE',
              label,
              value_count: 1,
              required: true,
              max_value_bytes: 2048
            });
            continue;
          }
          if (buttonType === 'QUICK_REPLY') {
            schema.buttons.push({
              index,
              type: 'QUICK_REPLY',
              label,
              value_count: 1,
              required: false,
              max_value_bytes: 256
            });
            continue;
          }
          if (containsTemplateVariables(button)) throw new Error('UNSUPPORTED_BUTTON_TYPE');
        }
        continue;
      }
      if (containsTemplateVariables(component)) {
        throw new Error('UNSUPPORTED_DYNAMIC_COMPONENT');
      }
    }
  } catch (error) {
    return templateParameterSchemaError(
      readString((error as { message?: unknown })?.message) || 'UNSUPPORTED_STRUCTURE'
    );
  }

  const requiredParameterCount =
    schema.header.value_count +
    schema.body.value_count +
    (schema.location_required ? 1 : 0) +
    schema.buttons
      .filter((button) => button.required)
      .reduce((total, button) => total + button.value_count, 0);
  if (requiredParameterCount > 100) {
    return templateParameterSchemaError('TOO_MANY_REQUIRED_PARAMETERS');
  }
  schema.has_parameter_fields = Boolean(
    schema.header.value_count ||
      schema.body.value_count ||
      schema.buttons.length ||
      schema.location_required
  );
  return schema;
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
      if (labels.length) previewParts.push(`Botões: ${labels.join(' | ')}`);
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
  const parameterSchema = buildTemplateParameterSchema(row.components);
  const canUse = status === 'APPROVED' && parameterSchema.supported;

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
    parameter_schema: parameterSchema,
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

    const payload = await requestJsonWithTimeout(url, apiKey);
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

  // O comando #template seleciona pelo nome (não pelo idioma). Mantemos uma
  // única opção por nome, priorizando a primeira versão aprovada retornada pelo
  // gateway, que é a mesma regra usada pelo processamento de envio atual.
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

async function createOfficialTemplate(row: OfficialInstanceRow, payload: JsonMap) {
  const wabaId = readString(row.waba_id);
  if (!/^\d+$/.test(wabaId)) throw new Error('INSTANCE_METADATA_INVALID');

  const submission = buildTemplateSubmission(payload);
  const apiKey = await decryptOfficialApiKey(row);
  const baseUrl = resolveGatewayBaseUrl(row);
  const url = new URL(
    `${baseUrl}/${GRAPH_VERSION}/${wabaId}/message_templates`
  );
  const response = await requestJsonWithTimeout(
    url,
    apiKey,
    'POST',
    submission.request
  );
  const template = sanitizeTemplate({
    name: submission.request.name,
    language: submission.request.language,
    category: submission.request.category,
    status: readString(response.status).toUpperCase() || 'PENDING',
    components: submission.components
  });
  if (!template) throw new Error('GATEWAY_INVALID_RESPONSE');
  return template;
}

function publicError(error: unknown): { status: number; code: string; message: string } {
  const code = readString((error as { message?: unknown })?.message);
  if (code === 'INVALID_BODY') {
    return { status: 400, code: 'invalid_body', message: 'Corpo da requisicao invalido.' };
  }
  if (code === 'INSTANCE_LOOKUP_FAILED') {
    return { status: 500, code: 'instance_lookup_failed', message: 'Erro ao buscar instâncias oficiais.' };
  }
  if (code === 'INSTANCE_NAME_AMBIGUOUS') {
    return { status: 409, code: 'instance_name_ambiguous', message: 'Existem instâncias oficiais com o mesmo nome. Renomeie uma delas para continuar.' };
  }
  if (code === 'GATEWAY_NOT_AUTHORIZED') {
    return { status: 502, code: 'gateway_not_authorized', message: 'A instância não está autorizada a consultar templates.' };
  }
  if (code === 'GATEWAY_RATE_LIMITED') {
    return { status: 429, code: 'gateway_rate_limited', message: 'A consulta foi limitada temporariamente. Tente novamente.' };
  }
  if (
    code === 'INVALID_TEMPLATE_NAME' ||
    code === 'INVALID_TEMPLATE_LANGUAGE' ||
    code === 'INVALID_TEMPLATE_CATEGORY' ||
    code === 'INVALID_TEMPLATE_HEADER' ||
    code === 'INVALID_TEMPLATE_BODY' ||
    code === 'INVALID_TEMPLATE_FOOTER' ||
    code === 'INVALID_TEMPLATE_BUTTONS' ||
    code === 'INVALID_TEMPLATE_VARIABLES'
  ) {
    return { status: 400, code: 'invalid_template', message: 'Revise os dados e os componentes do template.' };
  }
  if (code === 'TEMPLATE_EXAMPLES_REQUIRED') {
    return { status: 400, code: 'template_examples_required', message: 'Informe um exemplo para cada parâmetro do template.' };
  }
  if (code === 'UNSUPPORTED_TEMPLATE_HEADER') {
    return { status: 400, code: 'unsupported_template_header', message: 'Nesta tela, use cabeçalho de texto ou sem cabeçalho.' };
  }
  if (code === 'GATEWAY_TEMPLATE_REJECTED') {
    return { status: 422, code: 'template_rejected', message: 'A Meta recusou os dados do template. Revise o conteudo e tente novamente.' };
  }
  if (code === 'CREDENTIAL_CONFIGURATION_INVALID' || code === 'CREDENTIAL_DECRYPTION_FAILED') {
    return { status: 500, code: 'credential_unavailable', message: 'A credencial segura da instância não está disponível.' };
  }
  if (
    code === 'GATEWAY_URL_MISSING' ||
    code === 'GATEWAY_URL_INVALID' ||
    code === 'INSTANCE_METADATA_INVALID'
  ) {
    return { status: 500, code: 'instance_not_configured', message: 'A instância oficial está incompleta.' };
  }
  if ((error as { name?: unknown })?.name === 'AbortError') {
    return { status: 504, code: 'gateway_timeout', message: 'A consulta de templates excedeu o tempo limite.' };
  }
  return { status: 502, code: 'template_sync_failed', message: 'Não foi possível sincronizar os templates.' };
}

Deno.serve(async (req: Request) => {
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
      return errorResponse(500, 'server_not_configured', 'Serviço não configurado.');
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
        return errorResponse(400, 'instance_required', 'Selecione uma instância oficial.');
      }

      const instance = findInstanceByName(rows, instanceName);
      if (!instance) {
        return errorResponse(404, 'instance_not_found', 'Instância oficial não encontrada nesta subconta.');
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

    if (action === 'create_template') {
      const instanceName = readString(
        payload.instance_name ?? payload.instanceName
      );
      if (!instanceName || instanceName.length > 200) {
        return errorResponse(400, 'instance_required', 'Selecione uma instância oficial.');
      }
      if (payload.confirm_submission !== true) {
        return errorResponse(400, 'confirmation_required', 'Confirme o envio para aprovacao.');
      }

      const instance = findInstanceByName(rows, instanceName);
      if (!instance) {
        return errorResponse(404, 'instance_not_found', 'Instância oficial não encontrada nesta subconta.');
      }

      const template = await createOfficialTemplate(instance, payload);
      return jsonResponse({
        ok: true,
        instance_name: normalizeInstanceName(instance),
        template,
        submitted_at: new Date().toISOString()
      }, 201);
    }

    return errorResponse(400, 'action_not_supported', 'Ação não suportada.');
  } catch (error) {
    const safe = publicError(error);
    return errorResponse(safe.status, safe.code, safe.message);
  }
});
