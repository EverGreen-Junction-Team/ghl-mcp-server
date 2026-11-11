# EverGreen Junction AI connector (HighLevel MCP server)

An MCP server for HighLevel where each person signs in as themselves on **EverGreen-branded
pages** (never a HighLevel screen), and the AI only gets the tools their HighLevel user
permissions allow. Every sign-in and tool call is logged per user.

```
Claude ──▶ /mcp (401) ──▶ /authorize (EverGreen page)
            email ──▶ is this an active agency user?  (HighLevel, via the agency connection)
            6-digit code by email                      (Supabase Auth)
            pick sub-account (only theirs, app installed)
            ──▶ sub-account token from the agency connection ──▶ back to Claude

Every call: token ──▶ GET /users/{userId} ──▶ permissions ──▶ filter tools/list, block tools/call
                  ──▶ row in mcp_audit_log (user, sub-account, tool, arguments, result)
```

- **Agency connection:** an agency admin installs the app once at `/install` (choosing the
  agency). The agency token is saved in Supabase (`mcp_agency`) and refreshed automatically;
  it's used to look up users and to get sub-account tokens. Only one agency can own it.
- **Who can do what:** each tool needs one HighLevel user permission (`contactsEnabled`,
  `opportunitiesEnabled`, `conversationsEnabled`, `appointmentsEnabled`). Users without it don't
  see the tool, and calls are rejected server-side.
- **Only assigned data:** users with `assignedDataOnly` only see and change records assigned to them.
- **Always current:** permissions are read live (cached 60 seconds). Removed users, or users
  taken off a sub-account, are blocked on their next call and can't renew their connection.
- **Activity log:** Supabase table `mcp_audit_log` (view `mcp_activity`, newest first). Events:
  `sign_in`, `sign_in_denied`, `code_sent`, `code_failed`, `tool_call`, `tool_denied`,
  `reconnect_denied`, `agency_installed`. Tool arguments are stored (truncated at 4,000 chars).

## Connect (users)

Claude → Settings → Connectors → **Add custom connector** → `https://mcp.evergreenjunction.com/mcp`

Claude Code: `claude mcp add --transport http evergreen https://mcp.evergreenjunction.com/mcp`

## Setup

1. **Supabase:** run `supabase/schema.sql` in the SQL Editor. In Authentication: set up custom
   SMTP (your sender address), and paste `supabase/email-code.html` into the **Magic Link** and
   **Confirm signup** templates.
2. **HighLevel Marketplace app:** redirect URL `https://mcp.evergreenjunction.com/callback`, with
   the scopes in `lib/ghl.js` (`GHL_SCOPES`, including `oauth.readonly` and `oauth.write`).
3. **Vercel env vars:** see `.env.example` (`GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `TOKEN_SECRET`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; optional `BRAND_NAME`, `BRAND_LOGO_URL`,
   `GHL_COMPANY_ID`).
4. Deploy, then an agency admin opens `https://mcp.evergreenjunction.com/install` and chooses the
   **agency**. Install the app in every sub-account that should use it.

## Local dev

```bash
cp .env.example .env   # fill in, BASE_URL=http://localhost:3000
npm run dev
```

## Tools

| Tool | Needs permission |
|---|---|
| whoami | none |
| search_contacts, get_contact, create_contact, update_contact, add_contact_note | contactsEnabled |
| list_pipelines, search_opportunities, create_opportunity | opportunitiesEnabled |
| search_conversations, get_conversation_messages, send_message | conversationsEnabled |
| list_calendars, get_calendar_events | appointmentsEnabled |

To add a tool, add an entry to `TOOLS` in `lib/tools.js` with its `permission`.
