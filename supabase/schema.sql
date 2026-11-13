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

revoke all on public.mcp_agency, public.mcp_audit_log, public.mcp_activity, public.mcp_revoked from anon, authenticated;
