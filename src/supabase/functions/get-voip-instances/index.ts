import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-wavoip-location-id',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}

function readString(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function resolveLocationId(req: Request, url: URL): string {
  return (
    readString(url.searchParams.get('location_id')) ||
    readString(req.headers.get('x-wavoip-location-id'))
  );
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

function parseJsonSafe(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

  if (lastError) {
    throw lastError;
  }

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

async function fetchWavoipDeviceConnection(
  deviceId: string,
  panelJwt: string
) {
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    return jsonResponse(
      { ok: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' },
      500
    );
  }

  const url = new URL(req.url);
  const locationId = resolveLocationId(req, url);
  const contactIdParam = readString(
    url.searchParams.get('contact_id') ?? url.searchParams.get('contactId')
  );
  const conversationIdParam = readString(
    url.searchParams.get('conversation_id') ?? url.searchParams.get('conversationId')
  );

  if (!locationId) {
    return jsonResponse(
      { ok: false, error: 'location_id is required' },
      400
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Fluxo 1: Buscar telefone do contato via API GHL usando o token salvo por location.
  if (contactIdParam || conversationIdParam) {
    let authData: any = null;
    try {
      authData = await getGhlAccessTokenForLocation(supabase, locationId);
    } catch (e: any) {
      return jsonResponse(
        {
          ok: false,
          error: e?.message || 'Erro ao buscar token da GHL',
          location_id: locationId
        },
        500
      );
    }

    if (!authData || !authData.token) {
      return jsonResponse(
        {
          ok: false,
          error: 'access_token nao encontrado para esta location',
          location_id: locationId
        },
        404
      );
    }

    const accessToken = authData.token;
    let resolvedContactId = contactIdParam;
    let conversationPayload: any = null;

    if (!resolvedContactId && conversationIdParam) {
      const conversationUrl = `https://services.leadconnectorhq.com/conversations/${conversationIdParam}`;
      const convo = await fetchGhlResource(
        conversationUrl,
        accessToken,
        '2021-04-15'
      );

      if (!convo.ok) {
        return jsonResponse(
          {
            ok: false,
            error: 'Falha ao consultar conversa na GHL',
            location_id: locationId,
            conversation_id: conversationIdParam,
            ghl_status: convo.status,
            ghl_response: convo.json || convo.text
          },
          502
        );
      }

      conversationPayload = convo.json;
      resolvedContactId = extractContactIdFromConversationPayload(conversationPayload);
    }

    if (!resolvedContactId) {
      return jsonResponse(
        {
          ok: false,
          error: 'contact_id nao encontrado',
          location_id: locationId,
          conversation_id: conversationIdParam || null
        },
        404
      );
    }

    const contactUrl = `https://services.leadconnectorhq.com/contacts/${resolvedContactId}`;
    const contactResp = await fetchGhlResource(contactUrl, accessToken, '2021-07-28');

    if (!contactResp.ok) {
      return jsonResponse(
        {
          ok: false,
          error: 'Falha ao consultar contato na GHL',
          location_id: locationId,
          contact_id: resolvedContactId,
          ghl_status: contactResp.status,
          ghl_response: contactResp.json || contactResp.text
        },
        502
      );
    }

    const phone = extractContactPhone(contactResp.json);

    return jsonResponse({
      ok: true,
      mode: 'contact-phone',
      location_id: locationId,
      contact_id: resolvedContactId,
      conversation_id: conversationIdParam || null,
      phone: phone || null,
      contact: contactResp.json?.contact || contactResp.json?.data?.contact || null,
      conversation: conversationPayload?.conversation || null
    });
  }

  // Fluxo 2: Buscar instancias VOIP por location.
  const { data, error } = await supabase
    .from('voip_instances')
    .select('*')
    .eq('location_id', locationId)
    .order('instance_name', { ascending: true });

  if (error) {
    return jsonResponse(
      { ok: false, error: error.message, location_id: locationId },
      500
    );
  }

  const instances = (data || [])
    .map((row) => normalizeInstanceRow((row || {}) as Record<string, unknown>))
    .filter((row) => !!row.instance_name);

  const panelJwt = readString(Deno.env.get('WAVOIP_PANEL_JWT'));
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
          call_error:
            'Instancia sem wavoip_device_id cadastrado para verificacao.'
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
          call_error: `Erro ao verificar dispositivo Wavoip: ${readString(
            e?.message || e
          ) || 'erro desconhecido'}`
        };
      }
    })
  );

  return jsonResponse({
    ok: true,
    location_id: locationId,
    count: instancesWithStatus.length,
    wavoip_checks_enabled: wavoipChecksEnabled,
    instances: instancesWithStatus
  });
});
