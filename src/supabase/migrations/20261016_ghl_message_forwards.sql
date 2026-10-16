-- Idempotência do POST de envio à GHL. Somente a Edge Function acessa a tabela.
create table if not exists public.ghl_message_forwards (
  request_id uuid primary key,
  location_id text not null,
  user_id text not null,
  source_message_id text not null,
  target_contact_id text not null,
  status text not null check (status in ('submitting', 'registered', 'dispatching', 'accepted')),
  payload jsonb not null,
  provider_message_ids jsonb not null default '[]'::jsonb,
  ghl_message_id text,
  conversation_id text,
  created_at timestamptz not null default now()
);
alter table public.ghl_message_forwards enable row level security;
revoke all on table public.ghl_message_forwards from anon, authenticated;
grant select, insert, update on table public.ghl_message_forwards to service_role;

-- Compatibilidade se a primeira revisão da migração já tiver sido aplicada.
alter table public.ghl_message_forwards add column if not exists provider_message_ids jsonb not null default '[]'::jsonb;
