# HighLevel MCP server (permission-scoped)

An MCP server for HighLevel where each person signs in as themselves, and the AI only gets the
tools their HighLevel user permissions allow.

```
Claude ──▶ /mcp (401) ──▶ OAuth: /authorize ──▶ HighLevel sign-in + pick sub-account
                                                     │
        ◀── access + refresh token ◀── /callback ◀───┘   (we learn userId + locationId)

Every call: token ──▶ GET /users/{userId} ──▶ permissions ──▶ filter tools/list, block tools/call
```

- **Who can do what:** each tool needs one HighLevel user permission (`contactsEnabled`,
  `opportunitiesEnabled`, `conversationsEnabled`, `appointmentsEnabled`). Users without it don't
  see the tool, and calls are rejected server-side.
- **Only assigned data:** users with `assignedDataOnly` only see and change records assigned to them.
- **Always current:** permissions are read live from HighLevel (cached 60 seconds), so role changes
  apply right away. Removed users are blocked on their next call.
- **No database:** client IDs, codes and tokens are AES-256-GCM encrypted blobs (`lib/seal.js`).
  Rotating `TOKEN_SECRET` signs everyone out.

## Connect (users)

Claude → Settings → Connectors → **Add custom connector** → `https://mcp.evergreenjunction.com/mcp`

Claude Code: `claude mcp add --transport http highlevel https://mcp.evergreenjunction.com/mcp`

## Setup

1. **HighLevel Marketplace app** (private). Redirect URL `https://mcp.evergreenjunction.com/callback`,
   with the scopes in `lib/ghl.js` (`GHL_SCOPES`).
2. **Vercel env vars:** see `.env.example` (`BASE_URL`, `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`,
   `GHL_VERSION_ID`, `TOKEN_SECRET`).
3. Deploy. Vercel serves `api/index.js` for every path (`vercel.json`).

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
