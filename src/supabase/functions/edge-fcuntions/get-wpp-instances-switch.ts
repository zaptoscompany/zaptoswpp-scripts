import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-wavoip-location-id, x-zaptos-location-id',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const CANDIDATE_TABLES = [
  'wpp_instances',
  'whatsapp_instances',
  'voip_instances',
  'wavoip_instances'
];

const CANDIDATE_LOCATION_COLUMNS = [
  'location_id',
  'locationId',
  'locationid',
  'LocationId',
  'Location ID'
];

type JsonMap = Record<string, unknown>;
type TableQueryResult = {
  ok: boolean;
  table: string;
  column: string;
  rows: JsonMap[];
  error: any;
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

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
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

async function queryTableForLocation(
  supabase: ReturnType<typeof createClient>,
  table: string,
  locationId: string
): Promise<TableQueryResult> {
  let lastError: any = null;

  for (const column of CANDIDATE_LOCATION_COLUMNS) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq(column, locationId)
      .limit(500);

    if (error) {
      lastError = error;
      if (isSchemaLookupError(error)) continue;
      return {
        ok: false,
        table,
        column,
        rows: [],
        error
      };
    }

    return {
      ok: true,
      table,
      column,
      rows: Array.isArray(data) ? (data as JsonMap[]) : [],
      error: null
    };
  }

  return {
    ok: false,
    table,
    column: '',
    rows: [],
    error: lastError
  };
}

function normalizeInstanceRow(row: JsonMap) {
  const name = readString(
    row.instance_name ??
      row.name ??
      row.instance ??
      row.label ??
      row.display_name ??
      row.whatsapp_instance_name ??
      row.wpp_instance_name
  );

  const id = readString(
    row.instance_id ?? row.instanceId ?? row.id ?? row.uuid ?? name
  );

  const status = readString(
    row.status ?? row.connection_status ?? row.state
  ).toLowerCase();

  const isActive = readBoolean(
    row.is_active ?? row.active ?? row.enabled ?? row.is_enabled
  );

  return {
    id: id || name,
    instance_id: id || name,
    instance_name: name,
    status: status || null,
    is_active: isActive
  };
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

  const tableResults: TableQueryResult[] = [];
  const allRows: JsonMap[] = [];
  const successfulTables: Array<{ table: string; column: string; count: number }> = [];

  for (const table of CANDIDATE_TABLES) {
    const result = await queryTableForLocation(supabase, table, locationId);
    tableResults.push(result);

    if (!result.ok) {
      if (result.error && !isSchemaLookupError(result.error)) {
        return jsonResponse(
          {
            ok: false,
            error:
              readString(result.error?.message) ||
              'Erro ao consultar tabela de instancias.',
            location_id: locationId,
            table,
            column: result.column || null
          },
          500
        );
      }
      continue;
    }

    successfulTables.push({
      table: result.table,
      column: result.column,
      count: result.rows.length
    });

    allRows.push(...result.rows);
  }

  if (!successfulTables.length) {
    return jsonResponse(
      {
        ok: false,
        error:
          'Nao foi possivel localizar uma tabela de instancias compativel.',
        location_id: locationId,
        tried_tables: CANDIDATE_TABLES
      },
      500
    );
  }

  const normalized = allRows
    .map((row) => normalizeInstanceRow(row))
    .filter((row) => !!row.instance_name);

  const dedupedMap = new Map<string, (typeof normalized)[number]>();
  for (const item of normalized) {
    const key = item.instance_name.toLowerCase();
    const prev = dedupedMap.get(key);
    if (!prev) {
      dedupedMap.set(key, item);
      continue;
    }

    dedupedMap.set(key, {
      id: prev.id || item.id,
      instance_id: prev.instance_id || item.instance_id,
      instance_name: prev.instance_name || item.instance_name,
      status: prev.status || item.status,
      is_active: prev.is_active || item.is_active
    });
  }

  const instances = Array.from(dedupedMap.values()).sort((a, b) =>
    a.instance_name.localeCompare(b.instance_name, 'pt-BR')
  );

  return jsonResponse({
    ok: true,
    location_id: locationId,
    count: instances.length,
    instances,
    sources: successfulTables,
    tried: tableResults.map((item) => ({
      table: item.table,
      ok: item.ok,
      column: item.column || null
    }))
  });
});
