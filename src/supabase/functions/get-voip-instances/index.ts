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
  const apiKey = readString(
    row.api_key ?? row.instance_api_key ?? row.apiKey ?? row.apikey
  );
  const token = readString(row.token ?? row.access_token ?? row.webphone_token);

  return {
    id: instanceId || instanceName,
    instance_id: instanceId || instanceName,
    instance_name: instanceName,
    api_key: apiKey || null,
    token: token || null
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

  if (!locationId) {
    return jsonResponse(
      { ok: false, error: 'location_id is required' },
      400
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

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

  return jsonResponse({
    ok: true,
    location_id: locationId,
    count: instances.length,
    instances
  });
});
