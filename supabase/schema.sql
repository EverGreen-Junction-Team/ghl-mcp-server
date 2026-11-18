-- EverGreen MCP connector: run once in Supabase > SQL Editor.
-- The server talks to these tables with the service role key only (RLS on, no policies),
-- so nothing here is reachable with the public anon key.

-- The agency's HighLevel connection (saved when the agency admin installs the app).
-- HighLevel replaces the refresh token on every refresh, so it must be kept here.
create table if not exists public.mcp_agency (
  company_id     text primary key,
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  scope          text,
  installed_by   text,
  updated_at     timestamptz not null default now()
);
alter table public.mcp_agency enable row level security;

-- A sub-account access token per installed location, minted from the agency token and renewed
-- daily by the /cron/refresh job. These are live credentials at rest -- service role only, RLS
-- on, no policies, same as mcp_agency. Dropping this table is safe: the server falls back to
-- minting a token on demand, which is how it worked before.
create table if not exists public.mcp_location (
  location_id    text primary key,
  company_id     text not null,
  access_token   text not null,
  expires_at     timestamptz not null,
  name           text,
  updated_at     timestamptz not null default now()
);
alter table public.mcp_location enable row level security;
create index if not exists mcp_location_company_idx on public.mcp_location (company_id);

-- Who did what: every sign-in and every tool call.
create table if not exists public.mcp_audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  event        text not null,          -- sign_in, sign_in_denied, code_sent, code_failed, tool_call, tool_denied, agency_installed, reconnect_denied, disconnected
  user_id      text,
  user_email   text,
  user_name    text,
  location_id  text,
  location_name text,
  company_id   text,
  tool         text,
  ok           boolean,
  error        text,
  args         jsonb,
  duration_ms  integer,
  client       text,                   -- AI app name (e.g. Claude)
  ip           text
);
alter table public.mcp_audit_log enable row level security;
create index if not exists mcp_audit_log_at_idx on public.mcp_audit_log (at desc);
create index if not exists mcp_audit_log_user_idx on public.mcp_audit_log (user_id, at desc);
create index if not exists mcp_audit_log_location_idx on public.mcp_audit_log (location_id, at desc);

-- Idempotency claims for execute_operation: one row per key, so a retried write returns the
-- first attempt's result instead of running twice. Rows older than an hour are ignored and
-- replaced; the cleanup below is optional housekeeping, not required for correctness.
create table if not exists public.mcp_idempotency (
  id           text primary key,
  location_id  text,
  user_id      text,
  operation    text,
  status       text not null,          -- running | done
  result       jsonb,
  at           timestamptz not null default now()
);
alter table public.mcp_idempotency enable row level security;
create index if not exists mcp_idempotency_at_idx on public.mcp_idempotency (at);

-- Disconnected sign-ins (one row per "Disconnect" in the AI app). Their tokens stop working.
create table if not exists public.mcp_revoked (
  gid          text primary key,
  user_id      text,
  location_id  text,
  client       text,
  revoked_at   timestamptz not null default now()
);
alter table public.mcp_revoked enable row level security;

-- Handy view for the Supabase table editor: newest first, readable columns.
-- security_invoker keeps the table's RLS in force, so the view isn't public either.
create or replace view public.mcp_activity with (security_invoker = true) as
select at, event, user_name, user_email, location_name, tool, ok, error, args, duration_ms, client
from public.mcp_audit_log
order by at desc;

revoke all on public.mcp_agency, public.mcp_location, public.mcp_idempotency, public.mcp_audit_log, public.mcp_activity, public.mcp_revoked from anon, authenticated;
