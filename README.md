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
- **The whole HighLevel API, per user:** `search_operations`, `describe_operation` and
  `execute_operation` reach ~500 sub-account operations (invoices, payments, products, store,
  social planner, blogs, emails, forms, workflows, Voice AI, custom objects, ...), like HighLevel's
  own MCP server. Each user only finds and runs the operations their HighLevel permissions and
  role scopes allow (see "Operation catalog" below).
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
   the scopes in `lib/ghl.js` (`GHL_SCOPES`: the base scopes, including `oauth.readonly` and
   `oauth.write`, plus every scope in `CATALOG_SCOPES`; see "Operation catalog").
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
| search_operations, describe_operation, execute_operation | per operation (below) |

To add a tool, add an entry to `TOOLS` in `lib/tools.js` with its `permission`.

## Operation catalog

`lib/catalog.generated.js` lists every HighLevel API operation that works with a sub-account
token, built from HighLevel's public OpenAPI specs. Agency-only areas (OAuth, SaaS, snapshots,
companies, custom menus, marketplace billing) and file uploads are left out. To update it:

```bash
git clone --depth 1 https://github.com/GoHighLevel/highlevel-api-docs /tmp/hl-docs
npm run build:catalog -- /tmp/hl-docs
```

**Who may run an operation** (`lib/access.js`, `checkOperation`). The server's sub-account token
can do everything, so these checks are what limits each user:

1. **Area permission.** `AREAS` maps each API area to the HighLevel user permission that turns it
   on (invoices → `invoiceEnabled`, payments/products/store → `paymentsEnabled`, social planner →
   `socialPlanner`, workflows → `workflowsEnabled` + `workflowsReadOnly`, ...). Some areas are
   admin-only for changes (users, sub-account settings, custom fields/values, AI agent setup,
   phone numbers) or entirely (payment provider setup). **Areas not in the table are admin-only.**
2. **Role scopes.** When the user has `scopes`, viewing needs one of the area's scopes and
   changing needs an edit one, e.g. `invoices.readonly` lets a user list invoices but not create
   them; deleting products needs `products.delete`. Areas HighLevel has no role scopes for
   (contacts viewing, for example) are decided by step 1.
3. **Assigned data only.** Users limited to assigned records can't use catalog operations for
   contacts, opportunities, conversations or calendars; the built-in tools filter to their records.
4. **Locked to the sub-account.** `locationId`/`altId` (and `companyId`) are always filled in from
   the connection; a request naming any other sub-account is refused.
5. **Confirmation.** Deleting, sending, charging, refunding, bulk and similar operations only run
   with `confirm: true`, which the AI is told to set only after the user confirms.

`execute_operation` calls are logged as `execute_operation:<operation id>`, and refusals as
`tool_denied`.

**Scopes.** By default the install asks for every scope the catalog uses (`CATALOG_SCOPES`), so
turn all of them on in the Marketplace app (Advanced Settings → Auth). To ask for fewer, set
`GHL_SCOPES` (space-separated); operations needing a scope the app lacks will fail with a 401
from HighLevel. Sub-accounts installed before the scopes were added must re-install the app.
