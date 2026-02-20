import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-wavoip-location-id, x-zv-ts, x-zv-nonce',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const SESSION_TTL_SECONDS = readPositiveIntEnv('VOIP_SESSION_TTL_SECONDS', 600);
const NONCE_TTL_SECONDS = readPositiveIntEnv('VOIP_NONCE_TTL_SECONDS', 120);
const REQUEST_TS_SKEW_MS = 60_000;

type JsonMap = Record<string, unknown>;

function readPositiveIntEnv(name: string, fallbackValue: number) {
  const raw = Number(String(Deno.env.get(name) || '').trim());
  if (!Number.isFinite(raw) || raw <= 0) return fallbackValue;
  return Math.floor(raw);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: JsonMap
) {
  return jsonResponse(
    {
      ok: false,
      code,
      error: message,
      ...(extra || {})
    },
    status
  );
}

function readString(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function parseJsonSafe(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getClientIp(req: Request): string {
  const raw =
    readString(req.headers.get('x-forwarded-for')) ||
    readString(req.headers.get('cf-connecting-ip')) ||
    readString(req.headers.get('x-real-ip'));

  if (!raw) return '';
  return readString(raw.split(',')[0]);
}

function getUserAgent(req: Request): string {
  return readString(req.headers.get('user-agent'));
}

async function parseRequestBody(req: Request): Promise<JsonMap> {
  const text = await req.text().catch(() => '');
  if (!text) return {};
  const parsed = parseJsonSafe(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid JSON body');
  }
  return parsed as JsonMap;
}

function resolvePayloadLocationId(payload: JsonMap): string {
  return readString(
    payload.location_id ?? payload.locationId ?? payload.locationid ?? ''
  );
}

function parseBearerToken(req: Request): string {
  const authHeader = readString(req.headers.get('authorization'));
  if (!authHeader) return '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? readString(match[1]) : '';
}

function createRandomTokenHex(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashSessionToken(rawToken: string, secret: string): Promise<string> {
  return await sha256Hex(`${secret}:${rawToken}`);
}

function dateToIsoFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isIsoDateExpired(value: unknown): boolean {
  const text = readString(value);
  if (!text) return true;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp <= Date.now();
}

async function auditSecurityEvent(
  supabase: ReturnType<typeof createClient>,
  event: {
    locationId?: string;
    sid?: string;
    action: string;
    ok: boolean;
    reason?: string;
    ip?: string;
    userAgent?: string;
  }
) {
  try {
    await supabase.from('voip_security_audit').insert({
      location_id: event.locationId || null,
      sid: event.sid || null,
      action: readString(event.action) || 'unknown',
      ok: !!event.ok,
      reason: readString(event.reason) || null,
      ip: readString(event.ip) || null,
      user_agent: readString(event.userAgent) || null
    });
  } catch {
    /* ignore audit errors */
  }
}

async function isLocationActiveInSubcontas(
  supabase: ReturnType<typeof createClient>,
  locationId: string
) {
  const columns = ['Location ID', 'location_id', 'locationid', 'LocationId'];
  let lastError: any = null;

  for (const column of columns) {
    const { data, error } = await supabase
      .from('subcontas')
      .select('*')
      .eq(column, locationId)
      .limit(1);

    if (error) {
      lastError = error;
      continue;
    }

    if (data && data.length) {
      return { ok: true, row: data[0], column };
    }
  }

  if (lastError) {
    return { ok: false, error: lastError };
  }

  return { ok: false, error: null };
}

async function createVoipSession(
  supabase: ReturnType<typeof createClient>,
  locationId: string,
  req: Request,
  sessionSecret: string
) {
  const rawToken = createRandomTokenHex(32);
  const tokenHash = await hashSessionToken(rawToken, sessionSecret);
  const expiresAt = dateToIsoFromNow(SESSION_TTL_SECONDS);

  const insertPayload = {
    token_hash: tokenHash,
    location_id: locationId,
    expires_at: expiresAt,
    created_ip: getClientIp(req) || null,
    user_agent: getUserAgent(req) || null
  };

  const { data, error } = await supabase
    .from('voip_sessions')
    .insert(insertPayload)
    .select('*')
    .limit(1);

  if (error) throw error;

  return {
    rawToken,
    tokenHash,
    expiresAt,
    row: (data && data[0]) || null
  };
}

async function resolveSessionFromRequest(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  sessionSecret: string
) {
  const rawToken = parseBearerToken(req);
  if (!rawToken) {
    return { ok: false, status: 401, code: 'session_required', error: 'Authorization ausente.' };
  }

  const tokenHash = await hashSessionToken(rawToken, sessionSecret);
  const { data, error } = await supabase
    .from('voip_sessions')
    .select('*')
    .eq('token_hash', tokenHash)
    .limit(1);

  if (error) {
    return {
      ok: false,
      status: 500,
      code: 'session_lookup_failed',
      error: readString(error.message) || 'Falha ao validar sessao.'
    };
  }

  const row = data && data[0];
  if (!row) {
    return {
      ok: false,
      status: 401,
      code: 'session_invalid',
      error: 'Sessao invalida.'
    };
  }

  if (readString((row as any).revoked_at)) {
    return {
      ok: false,
      status: 401,
      code: 'session_revoked',
      error: 'Sessao revogada.'
    };
  }

  if (isIsoDateExpired((row as any).expires_at)) {
    return {
      ok: false,
      status: 401,
      code: 'session_expired',
      error: 'Sessao expirada.'
    };
  }

  return { ok: true, row };
}

async function touchSession(
  supabase: ReturnType<typeof createClient>,
  sessionId: string
) {
  try {
    await supabase
      .from('voip_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', sessionId);
  } catch {
    /* ignore */
  }
}

async function validateNonceAndTimestamp(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  sessionId: string
) {
  const nonce = readString(req.headers.get('x-zv-nonce'));
  const tsRaw = readString(req.headers.get('x-zv-ts'));

  if (!nonce || !tsRaw) {
    return {
      ok: false,
      status: 400,
      code: 'nonce_required',
      error: 'Headers x-zv-nonce e x-zv-ts sao obrigatorios.'
    };
  }

  if (nonce.length < 8 || nonce.length > 200) {
    return {
      ok: false,
      status: 400,
      code: 'nonce_invalid',
      error: 'Nonce invalido.'
    };
  }

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) {
    return {
      ok: false,
      status: 400,
      code: 'timestamp_invalid',
      error: 'Timestamp invalido.'
    };
  }

  if (Math.abs(Date.now() - ts) > REQUEST_TS_SKEW_MS) {
    return {
      ok: false,
      status: 401,
      code: 'timestamp_out_of_window',
      error: 'Requisicao fora da janela de tempo permitida.'
    };
  }

  const { error } = await supabase.from('voip_session_nonces').insert({
    sid: sessionId,
    nonce,
    expires_at: dateToIsoFromNow(NONCE_TTL_SECONDS)
  });

  if (error) {
    if (readString((error as any).code) === '23505') {
      return {
        ok: false,
        status: 409,
        code: 'nonce_replay',
        error: 'Nonce ja utilizado para esta sessao.'
      };
    }

    return {
      ok: false,
      status: 500,
      code: 'nonce_store_failed',
      error: readString((error as any).message) || 'Falha ao validar nonce.'
    };
  }

  return { ok: true };
}

function normalizeInstanceRow(row: Record<string, unknown>) {
  const instanceName = readString(
    row.instance_name ?? row.name ?? row.instance ?? row.label
  );
  const instanceId = readString(row.instance_id ?? row.id ?? instanceName);
  const token = readString(
    row.wavoip_token ?? row.token ?? row.access_token ?? row.webphone_token
  );
  const wavoipDeviceId = readString(
    row.wavoip_device_id ?? row.device_id ?? row.wavoipDeviceId
  );

  return {
    id: instanceId || instanceName,
    instance_id: instanceId || instanceName,
    instance_name: instanceName,
    token: token || null,
    wavoip_device_id: wavoipDeviceId || null
  };
}

function extractContactIdFromConversationPayload(payload: any): string {
  return readString(
    payload?.contactId ??
      payload?.contact_id ??
      payload?.contact?.id ??
      payload?.conversation?.contactId ??
      payload?.conversation?.contact_id ??
      payload?.conversation?.contact?.id ??
      payload?.data?.contactId ??
      payload?.data?.contact_id ??
      payload?.data?.contact?.id
  );
}

function extractContactPhone(payload: any): string {
  return readString(
    payload?.phone ??
      payload?.contact?.phone ??
      payload?.data?.phone ??
      payload?.data?.contact?.phone
  );
}

async function getGhlAccessTokenForLocation(
  supabase: ReturnType<typeof createClient>,
  locationId: string
) {
  const columns = ['LocationId', 'location_id', 'locationid'];
  let lastError: any = null;

  for (const column of columns) {
    const { data, error } = await supabase
      .from('code_autorization_ghl')
      .select('*')
      .eq(column, locationId)
      .limit(1);

    if (error) {
      lastError = error;
      continue;
    }

    if (data && data.length) {
      const row = data[0] as Record<string, unknown>;
      const token = readString(
        row.access_token ?? row.accessToken ?? row.token ?? row.ghl_access_token
      );
      return { token, row, matchedColumn: column };
    }
  }

  if (lastError) throw lastError;
  return null;
}

async function fetchGhlResource(
  resourceUrl: string,
  accessToken: string,
  version: string
) {
  const resp = await fetch(resourceUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Version: version,
      Authorization: `Bearer ${accessToken}`
    }
  });

  const text = await resp.text().catch(() => '');
  const json = parseJsonSafe(text);
  return { ok: resp.ok, status: resp.status, text, json };
}

function extractWavoipDeviceStatus(payload: any): string {
  const resultItem = Array.isArray(payload?.result)
    ? payload.result[0]
    : payload?.result;
  const dataItem = Array.isArray(payload?.data)
    ? payload.data[0]
    : payload?.data;

  const candidates = [
    payload?.status,
    payload?.status_norm,
    payload?.device?.status,
    payload?.device?.status_norm,
    resultItem?.status,
    resultItem?.status_norm,
    resultItem?.device?.status,
    resultItem?.device?.status_norm,
    dataItem?.status,
    dataItem?.status_norm,
    dataItem?.device?.status,
    dataItem?.device?.status_norm,
    payload?.data?.status,
    payload?.data?.device?.status,
    payload?.result?.status
  ];

  for (const candidate of candidates) {
    const status = readString(candidate).toLowerCase();
    if (status) return status;
  }

  return '';
}

async function fetchWavoipDeviceConnection(deviceId: string, panelJwt: string) {
  const endpoint = `http://api.wavoip.com/devices/${encodeURIComponent(deviceId)}`;
  const resp = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${panelJwt}`
    }
  });

  const text = await resp.text().catch(() => '');
  const json = parseJsonSafe(text);
  const status = extractWavoipDeviceStatus(json);

  return {
    ok: resp.ok,
    http_status: resp.status,
    status
  };
}

async function loadInstancesWithStatus(
  supabase: ReturnType<typeof createClient>,
  locationId: string,
  panelJwt: string
) {
  const { data, error } = await supabase
    .from('voip_instances')
    .select('*')
    .eq('location_id', locationId)
    .order('instance_name', { ascending: true });

  if (error) {
    return {
      ok: false,
      status: 500,
      error: error.message,
      location_id: locationId,
      instances: []
    };
  }

  const instances = (data || [])
    .map((row) => normalizeInstanceRow((row || {}) as Record<string, unknown>))
    .filter((row) => !!row.instance_name);

  const wavoipChecksEnabled = !!panelJwt;
  const instancesWithStatus = await Promise.all(
    instances.map(async (instance) => {
      const deviceId = readString((instance as any).wavoip_device_id);

      if (!wavoipChecksEnabled) {
        return {
          ...instance,
          status: null,
          wavoip_status: null,
          can_call: false,
          call_error:
            'Verificacao de dispositivo indisponivel: secret WAVOIP_PANEL_JWT nao configurado.'
        };
      }

      if (!deviceId) {
        return {
          ...instance,
          status: null,
          wavoip_status: null,
          can_call: false,
          call_error: 'Instancia sem wavoip_device_id cadastrado para verificacao.'
        };
      }

      try {
        const check = await fetchWavoipDeviceConnection(deviceId, panelJwt);
        const status = readString(check.status).toLowerCase();
        const canCall = check.ok && status === 'open';
        const callError = canCall
          ? null
          : `Instancia nao esta pronta para ligacao (status: ${status || 'desconhecido'}).`;

        return {
          ...instance,
          status: status || null,
          wavoip_status: status || null,
          can_call: canCall,
          wavoip_http_status: check.http_status,
          call_error: callError
        };
      } catch (e: any) {
        return {
          ...instance,
          status: null,
          wavoip_status: null,
          can_call: false,
          call_error: `Erro ao verificar dispositivo Wavoip: ${
            readString(e?.message || e) || 'erro desconhecido'
          }`
        };
      }
    })
  );

  return {
    ok: true,
    status: 200,
    location_id: locationId,
    count: instancesWithStatus.length,
    wavoip_checks_enabled: wavoipChecksEnabled,
    instances: instancesWithStatus
  };
}

async function resolveContactData(
  supabase: ReturnType<typeof createClient>,
  locationId: string,
  contactIdParam: string,
  conversationIdParam: string
) {
  if (!contactIdParam && !conversationIdParam) {
    return {
      ok: false,
      status: 400,
      code: 'contact_params_required',
      error: 'contact_id ou conversation_id e obrigatorio.'
    };
  }

  let authData: any = null;
  try {
    authData = await getGhlAccessTokenForLocation(supabase, locationId);
  } catch (e: any) {
    return {
      ok: false,
      status: 500,
      code: 'ghl_token_lookup_failed',
      error: e?.message || 'Erro ao buscar token da GHL'
    };
  }

  if (!authData || !authData.token) {
    return {
      ok: false,
      status: 404,
      code: 'ghl_token_not_found',
      error: 'access_token nao encontrado para esta location'
    };
  }

  const accessToken = authData.token;
  let resolvedContactId = contactIdParam;
  let conversationPayload: any = null;

  if (!resolvedContactId && conversationIdParam) {
    const conversationUrl = `https://services.leadconnectorhq.com/conversations/${conversationIdParam}`;
    const convo = await fetchGhlResource(conversationUrl, accessToken, '2021-04-15');

    if (!convo.ok) {
      return {
        ok: false,
        status: 502,
        code: 'ghl_conversation_lookup_failed',
        error: 'Falha ao consultar conversa na GHL',
        ghl_status: convo.status,
        ghl_response: convo.json || convo.text
      };
    }

    conversationPayload = convo.json;
    resolvedContactId = extractContactIdFromConversationPayload(conversationPayload);
  }

  if (!resolvedContactId) {
    return {
      ok: false,
      status: 404,
      code: 'contact_id_not_found',
      error: 'contact_id nao encontrado'
    };
  }

  const contactUrl = `https://services.leadconnectorhq.com/contacts/${resolvedContactId}`;
  const contactResp = await fetchGhlResource(contactUrl, accessToken, '2021-07-28');

  if (!contactResp.ok) {
    return {
      ok: false,
      status: 502,
      code: 'ghl_contact_lookup_failed',
      error: 'Falha ao consultar contato na GHL',
      ghl_status: contactResp.status,
      ghl_response: contactResp.json || contactResp.text
    };
  }

  const phone = extractContactPhone(contactResp.json);
  const contact = contactResp.json?.contact || contactResp.json?.data?.contact || null;
  const conversation = conversationPayload?.conversation || null;

  return {
    ok: true,
    status: 200,
    location_id: locationId,
    contact_id: resolvedContactId,
    conversation_id: conversationIdParam || null,
    phone: phone || null,
    contact,
    conversation
  };
}

function pickAction(payload: JsonMap): string {
  return readString(payload.action).toLowerCase();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Method not allowed');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const sessionSecret = readString(Deno.env.get('VOIP_SESSION_SIGNING_SECRET'));
  const panelJwt = readString(Deno.env.get('WAVOIP_PANEL_JWT'));

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponse(
      500,
      'missing_supabase_config',
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  if (!sessionSecret) {
    return errorResponse(
      500,
      'missing_session_secret',
      'Missing VOIP_SESSION_SIGNING_SECRET'
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const ip = getClientIp(req);
  const userAgent = getUserAgent(req);

  let payload: JsonMap;
  try {
    payload = await parseRequestBody(req);
  } catch {
    return errorResponse(400, 'invalid_json', 'Invalid JSON body');
  }

  const action = pickAction(payload);
  if (!action) {
    return errorResponse(400, 'action_required', 'action is required');
  }

  if (action === 'session_start') {
    const locationId = resolvePayloadLocationId(payload);
    if (!locationId) {
      return errorResponse(400, 'location_required', 'location_id is required');
    }

    const activeLocation = await isLocationActiveInSubcontas(supabase, locationId);
    if (!activeLocation.ok) {
      await auditSecurityEvent(supabase, {
        locationId,
        action,
        ok: false,
        reason: activeLocation.error ? 'subcontas_lookup_error' : 'location_not_active',
        ip,
        userAgent
      });

      if (activeLocation.error) {
        return errorResponse(
          500,
          'subcontas_lookup_failed',
          readString((activeLocation.error as any)?.message) ||
            'Erro ao validar subconta.'
        );
      }
      return errorResponse(
        403,
        'location_not_active',
        'Esta subconta nao esta ativa no sistema.'
      );
    }

    try {
      const session = await createVoipSession(
        supabase,
        locationId,
        req,
        sessionSecret
      );

      await auditSecurityEvent(supabase, {
        locationId,
        sid: readString((session.row as any)?.id),
        action,
        ok: true,
        ip,
        userAgent
      });

      return jsonResponse({
        ok: true,
        action: 'session_start',
        location_id: locationId,
        session_token: session.rawToken,
        expires_at: session.expiresAt
      });
    } catch (e: any) {
      await auditSecurityEvent(supabase, {
        locationId,
        action,
        ok: false,
        reason: 'session_create_failed',
        ip,
        userAgent
      });
      return errorResponse(
        500,
        'session_create_failed',
        readString(e?.message || e) || 'Nao foi possivel criar sessao.'
      );
    }
  }

  const sessionCheck = await resolveSessionFromRequest(req, supabase, sessionSecret);
  if (!sessionCheck.ok) {
    await auditSecurityEvent(supabase, {
      action,
      ok: false,
      reason: sessionCheck.code,
      ip,
      userAgent
    });
    return errorResponse(
      sessionCheck.status,
      sessionCheck.code,
      sessionCheck.error
    );
  }

  const sessionRow = sessionCheck.row as any;
  const sessionLocationId = readString(sessionRow.location_id);
  const payloadLocationId = resolvePayloadLocationId(payload);
  const locationId = payloadLocationId || sessionLocationId;

  if (!locationId || !sessionLocationId || locationId !== sessionLocationId) {
    await auditSecurityEvent(supabase, {
      locationId,
      sid: readString(sessionRow.id),
      action,
      ok: false,
      reason: 'location_mismatch',
      ip,
      userAgent
    });
    return errorResponse(
      403,
      'location_mismatch',
      'Sessao nao autorizada para esta subconta.'
    );
  }

  const activeLocation = await isLocationActiveInSubcontas(supabase, locationId);
  if (!activeLocation.ok) {
    await auditSecurityEvent(supabase, {
      locationId,
      sid: readString(sessionRow.id),
      action,
      ok: false,
      reason: activeLocation.error ? 'subcontas_lookup_error' : 'location_not_active',
      ip,
      userAgent
    });

    if (activeLocation.error) {
      return errorResponse(
        500,
        'subcontas_lookup_failed',
        readString((activeLocation.error as any)?.message) ||
          'Erro ao validar subconta.'
      );
    }

    return errorResponse(
      403,
      'location_not_active',
      'Esta subconta nao esta ativa no sistema.'
    );
  }

  const nonceValidation = await validateNonceAndTimestamp(
    req,
    supabase,
    readString(sessionRow.id)
  );
  if (!nonceValidation.ok) {
    await auditSecurityEvent(supabase, {
      locationId,
      sid: readString(sessionRow.id),
      action,
      ok: false,
      reason: nonceValidation.code,
      ip,
      userAgent
    });
    return errorResponse(
      nonceValidation.status,
      nonceValidation.code,
      nonceValidation.error
    );
  }

  await touchSession(supabase, readString(sessionRow.id));

  if (action === 'get_instances' || action === 'list_instances') {
    const result = await loadInstancesWithStatus(supabase, locationId, panelJwt);
    await auditSecurityEvent(supabase, {
      locationId,
      sid: readString(sessionRow.id),
      action,
      ok: !!result.ok,
      reason: result.ok ? '' : readString(result.error),
      ip,
      userAgent
    });

    if (!result.ok) {
      return errorResponse(
        Number(result.status) || 500,
        'instances_lookup_failed',
        readString(result.error) || 'Falha ao carregar instancias.',
        { location_id: locationId }
      );
    }

    return jsonResponse({
      ok: true,
      action: 'get_instances',
      location_id: locationId,
      count: result.count,
      wavoip_checks_enabled: result.wavoip_checks_enabled,
      instances: result.instances
    });
  }

  if (action === 'get_contact' || action === 'resolve_contact') {
    const contactIdParam = readString(payload.contact_id ?? payload.contactId);
    const conversationIdParam = readString(
      payload.conversation_id ?? payload.conversationId
    );

    const contactResult = await resolveContactData(
      supabase,
      locationId,
      contactIdParam,
      conversationIdParam
    );

    await auditSecurityEvent(supabase, {
      locationId,
      sid: readString(sessionRow.id),
      action,
      ok: !!contactResult.ok,
      reason: contactResult.ok ? '' : readString(contactResult.code),
      ip,
      userAgent
    });

    if (!contactResult.ok) {
      return errorResponse(
        Number(contactResult.status) || 500,
        readString(contactResult.code) || 'contact_lookup_failed',
        readString(contactResult.error) || 'Falha ao consultar contato.',
        {
          location_id: locationId,
          contact_id: contactIdParam || null,
          conversation_id: conversationIdParam || null,
          ghl_status: (contactResult as any).ghl_status || null
        }
      );
    }

    return jsonResponse({
      ok: true,
      action: 'get_contact',
      location_id: locationId,
      contact_id: contactResult.contact_id,
      conversation_id: contactResult.conversation_id,
      phone: contactResult.phone || null,
      contact: contactResult.contact || null,
      conversation: contactResult.conversation || null
    });
  }

  if (action === 'prepare_call') {
    const instanceId = readString(payload.instance_id ?? payload.instanceId ?? payload.id);
    const providedPhone = readString(payload.phone);
    const contactIdParam = readString(payload.contact_id ?? payload.contactId);
    const conversationIdParam = readString(
      payload.conversation_id ?? payload.conversationId
    );

    if (!instanceId) {
      return errorResponse(
        400,
        'instance_required',
        'instance_id e obrigatorio para preparar a ligacao.'
      );
    }

    const instancesResult = await loadInstancesWithStatus(supabase, locationId, panelJwt);
    if (!instancesResult.ok) {
      return errorResponse(
        Number(instancesResult.status) || 500,
        'instances_lookup_failed',
        readString(instancesResult.error) || 'Falha ao validar instancia.'
      );
    }

    const matched = (instancesResult.instances || []).find((item: any) => {
      const id = readString(item.instance_id || item.id);
      const name = readString(item.instance_name);
      return id === instanceId || name === instanceId;
    }) as any;

    if (!matched) {
      return errorResponse(
        404,
        'instance_not_found',
        'Instancia nao encontrada para esta subconta.'
      );
    }

    const status = readString(matched.wavoip_status || matched.status).toLowerCase();
    const canCall = readBoolean(matched.can_call) || status === 'open';
    if (!canCall) {
      return errorResponse(
        409,
        'instance_not_open',
        readString(matched.call_error) ||
          `A instancia selecionada nao esta pronta para ligacao (status: ${status || 'desconhecido'}).`
      );
    }

    const token = readString(matched.token);
    if (!token) {
      return errorResponse(
        409,
        'instance_without_token',
        'A instancia selecionada nao possui token configurado.'
      );
    }

    let resolvedPhone = providedPhone;
    let resolvedContactId = contactIdParam;
    if (!resolvedPhone && (contactIdParam || conversationIdParam)) {
      const contactResult = await resolveContactData(
        supabase,
        locationId,
        contactIdParam,
        conversationIdParam
      );

      if (contactResult.ok) {
        resolvedPhone = readString(contactResult.phone);
        resolvedContactId = readString(contactResult.contact_id);
      }
    }

    await auditSecurityEvent(supabase, {
      locationId,
      sid: readString(sessionRow.id),
      action,
      ok: true,
      ip,
      userAgent
    });

    return jsonResponse({
      ok: true,
      action: 'prepare_call',
      location_id: locationId,
      instance_id: readString(matched.instance_id || matched.id),
      instance_name: readString(matched.instance_name),
      status: status || null,
      token,
      phone: resolvedPhone || null,
      contact_id: resolvedContactId || null
    });
  }

  await auditSecurityEvent(supabase, {
    locationId,
    sid: readString(sessionRow.id),
    action,
    ok: false,
    reason: 'action_not_supported',
    ip,
    userAgent
  });

  return errorResponse(400, 'action_not_supported', 'Action nao suportada.');
});
