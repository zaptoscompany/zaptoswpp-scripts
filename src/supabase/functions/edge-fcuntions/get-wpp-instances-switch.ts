import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-wavoip-location-id, x-zaptos-location-id',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const SOURCE_TABLE = 'uazapi';
const LOCATION_COLUMNS = ['LocationID', 'location_id', 'locationid', 'LocationId'];

type JsonMap = Record<string, unknown>;

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
    readString(url.searchParams.get('locationId')) ||
    readString(url.searchParams.get('locationid')) ||
    readString(req.headers.get('x-wavoip-location-id')) ||
    readString(req.headers.get('x-zaptos-location-id'))
  );
}

function isSchemaLookupError(error: any): boolean {
  const msg = readString(error?.message).toLowerCase();
  const code = readString(error?.code).toLowerCase();
  return (
    code === '42p01' ||
    code === '42703' ||
    code === 'pgrst204' ||
    code === 'pgrst205' ||
    msg.includes('does not exist') ||
    msg.includes('column') ||
    msg.includes('relation') ||
    msg.includes('schema cache')
  );
}

async function queryUazapiByLocation(
  supabase: ReturnType<typeof createClient>,
  locationId: string
): Promise<{
  ok: boolean;
  column: string;
  rows: JsonMap[];
  error: any;
}> {
  let lastError: any = null;

  for (const column of LOCATION_COLUMNS) {
    const { data, error } = await supabase
      .from(SOURCE_TABLE)
      .select('*')
      .eq(column, locationId)
      .limit(500);

    if (error) {
      lastError = error;
      if (isSchemaLookupError(error)) continue;
      return {
        ok: false,
        column,
        rows: [],
        error
      };
    }

    return {
      ok: true,
      column,
      rows: Array.isArray(data) ? (data as JsonMap[]) : [],
      error: null
    };
  }

  return {
    ok: false,
    column: '',
    rows: [],
    error: lastError
  };
}

function normalizeInstanceName(row: JsonMap): string {
  return readString(
    row.nome ??
      row.Nome ??
      row.InstanceName ??
      row.instance_name ??
      row.instanceName ??
      row.Instance ??
      row.name ??
      row.instance ??
      row.label ??
      row.display_name ??
      row.uazapi_instance_name
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return jsonResponse(
      { ok: false, error: 'Method not allowed. Use GET.' },
      405
    );
  }

  const supabaseUrl = readString(Deno.env.get('SUPABASE_URL'));
  const supabaseServiceKey = readString(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));

  if (!supabaseUrl || !supabaseServiceKey) {
    return jsonResponse(
      {
        ok: false,
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
      },
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

  const queryResult = await queryUazapiByLocation(supabase, locationId);

  if (!queryResult.ok) {
    if (queryResult.error && !isSchemaLookupError(queryResult.error)) {
      return jsonResponse(
        {
          ok: false,
          error:
            readString(queryResult.error?.message) ||
            'Erro ao consultar nomes das instancias.'
        },
        500
      );
    }
    return jsonResponse(
      {
        ok: false,
        error:
          'Nao foi possivel consultar os nomes das instancias.'
      },
      500
    );
  }

  const dedupedNames = new Map<string, string>();
  for (const row of queryResult.rows) {
    const name = normalizeInstanceName(row);
    if (!name) continue;

    const key = name.toLowerCase();
    if (!dedupedNames.has(key)) {
      dedupedNames.set(key, name);
    }
  }

  const names = Array.from(dedupedNames.values()).sort((a, b) =>
    a.localeCompare(b, 'pt-BR')
  );

  return jsonResponse({
    ok: true,
    instances: names.map((instance_name) => ({ instance_name }))
  });
});
