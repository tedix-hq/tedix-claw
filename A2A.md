# Agent-to-Agent (A2A) Collaboration

How to connect external agents (Claude Code, other OpenClaw instances, custom tools) to the remote OpenClaw gateway at `claw.tedix.tech`.

## Current State

The gateway runs inside a Cloudflare Sandbox container behind **Cloudflare Access** (JWT auth). All non-public routes require a valid CF Access token. The Worker injects `OPENCLAW_GATEWAY_TOKEN` server-side after CF Access validation, so the gateway itself never sees unauthenticated requests.

**Public (no auth):** `/api/status`, `/sandbox-health`, static assets
**Protected (CF Access + auto-injected gateway token):** Everything else, including all proxied paths to OpenClaw

This means raw CLI/API calls from outside the browser won't work without solving the auth layer first.

---

## Collaboration Options

### 1. Gateway HTTP API (OpenAI-compatible)

OpenClaw exposes an **OpenAI-compatible** `/v1/chat/completions` endpoint on the gateway. The Worker proxies it through the catch-all. Any OpenAI SDK client can talk to it.

```bash
curl https://claw.tedix.tech/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "CF-Access-Client-Id: $SERVICE_TOKEN_ID" \
  -H "CF-Access-Client-Secret: $SERVICE_TOKEN_SECRET" \
  -d '{"messages":[{"role":"user","content":"summarize today"}]}'
```

| Aspect | Detail |
|--------|--------|
| **Works today** | Yes, if CF Access is solved |
| **Complexity** | Low (standard HTTP) |
| **Latency** | Per-request, no persistent connection |
| **Bidirectional** | No (request/response only) |
| **Use case** | One-shot queries, task delegation, tool calls |

### 2. ACP Bridge (Agent Control Protocol)

The `openclaw acp` command creates a local bridge to a remote gateway via WebSocket. It maintains a persistent session and supports interactive agent turns.

```bash
openclaw acp \
  --url wss://claw.tedix.tech/ws \
  --token $GATEWAY_TOKEN \
  --session agent:main:main
```

| Aspect | Detail |
|--------|--------|
| **Works today** | Needs CF Access bypass for WebSocket |
| **Complexity** | Medium (CLI subprocess or MCP wrapper) |
| **Latency** | Low (persistent WebSocket) |
| **Bidirectional** | Yes (full duplex) |
| **Use case** | Interactive sessions, streaming, real-time collaboration |

Could be wrapped as an **MCP server** for Claude Code:
```jsonc
// ~/.claude/mcp_servers.json
{
  "openclaw": {
    "command": "openclaw",
    "args": ["acp", "--url", "wss://claw.tedix.tech/ws", "--token", "..."]
  }
}
```

### 3. Gateway RPC (`gateway call`)

Direct method calls against the gateway. Good for health checks, status, and cron triggers.

```bash
openclaw gateway call health \
  --url wss://claw.tedix.tech/ws \
  --token $GATEWAY_TOKEN --json
```

| Aspect | Detail |
|--------|--------|
| **Works today** | Needs CF Access bypass |
| **Complexity** | Low (one-shot CLI calls) |
| **Use case** | Health checks, status queries, cron triggers |

### 4. Cross-Instance Messaging (Telegram/Discord)

Two OpenClaw instances in a shared group chat. They communicate through the messaging channel like humans would. No infrastructure changes needed.

```
Instance A (claw.tedix.tech) ←→ Telegram Group ←→ Instance B (local)
```

| Aspect | Detail |
|--------|--------|
| **Works today** | Yes, fully |
| **Complexity** | None (just add both bots to a group) |
| **Latency** | High (message delivery + processing) |
| **Bidirectional** | Yes |
| **Use case** | Loose coordination, async tasks, notifications |
| **Drawback** | Slow, noisy, message format overhead, no structured data |

### 5. Hooks / Webhooks

OpenClaw has a hooks system. One instance can POST to another's webhook endpoint to trigger agent turns. The Worker could expose a webhook route that forwards to the gateway.

```
Claude Code → POST /api/hooks/trigger → Worker → OpenClaw gateway
```

| Aspect | Detail |
|--------|--------|
| **Works today** | No (webhook route not implemented in Worker) |
| **Complexity** | Medium (new route + auth) |
| **Latency** | Medium (HTTP round-trip) |
| **Use case** | Task delegation, fire-and-forget triggers |

### 6. Node Pairing

Register the local Mac as a "node" paired to the remote gateway. The gateway can then invoke commands on the local machine (shell, screen capture, file access).

```bash
openclaw nodes list --url wss://claw.tedix.tech/ws --token $TOKEN
```

| Aspect | Detail |
|--------|--------|
| **Works today** | Needs CF Access bypass + pairing flow |
| **Complexity** | Medium |
| **Direction** | Remote gateway → local machine (reverse of most options) |
| **Use case** | Gateway-initiated local actions, tool execution on your Mac |

### 7. Intra-Instance Multi-Agent

Within a single OpenClaw instance, multiple agents can coordinate:

- **`sessions_send`** — Send messages between agent sessions
- **`sessions_spawn`** — Spawn sub-agents with their own workspace/skills/model
- **`agents.list`** config — Define multiple agents with different roles

| Aspect | Detail |
|--------|--------|
| **Works today** | Yes (within the same gateway) |
| **Scope** | Single instance only |
| **Use case** | Sub-task delegation, specialized agents, parallel work |

---

## The CF Access Blocker

Most options above require solving programmatic auth. Current state:

- Browser requests work (CF Access cookie from login flow)
- CLI/API requests fail (no JWT)
- The Worker injects `OPENCLAW_GATEWAY_TOKEN` after CF Access validation

### Solutions

**A. CF Access Service Token** (recommended, zero code changes)

Create a service token in the Cloudflare Zero Trust dashboard. Pass headers with every request:

```bash
curl https://claw.tedix.tech/v1/chat/completions \
  -H "CF-Access-Client-Id: $CF_SERVICE_TOKEN_ID" \
  -H "CF-Access-Client-Secret: $CF_SERVICE_TOKEN_SECRET" \
  -d '...'
```

Works with HTTP and WebSocket. No code changes needed.

**B. API-Key Auth Route** (code change, cleanest for programmatic access)

Add a new public route in the Worker that authenticates via bearer token instead of CF Access:

```typescript
// New route: /api/v1/* — programmatic access with API key
publicRoutes.all("/api/v1/*", async (c) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (token !== c.env.OPENCLAW_GATEWAY_TOKEN) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // Proxy to gateway
  return sandbox.containerFetch(c.req.raw, GATEWAY_PORT);
});
```

Pros: Simple, standard bearer token auth, no CF Access dependency
Cons: Bypasses CF Access audit trail, needs rate limiting

**C. `cloudflared access` Tunnel Wrapper**

Wrap CLI connections through `cloudflared`:

```bash
cloudflared access tcp --hostname claw.tedix.tech --url localhost:18790
# Then point CLI at localhost:18790
openclaw acp --url ws://localhost:18790/ws --token $TOKEN
```

Pros: Uses your CF Access credentials, full audit trail
Cons: Extra process, manual setup

---

## Recommended Path

### Phase 1: Quick Win (today)

1. **Create a CF Access service token** in the Zero Trust dashboard
2. **Test the HTTP API**:
   ```bash
   curl https://claw.tedix.tech/v1/chat/completions \
     -H "CF-Access-Client-Id: $ID" \
     -H "CF-Access-Client-Secret: $SECRET" \
     -H "Authorization: Bearer $GATEWAY_TOKEN" \
     -d '{"messages":[{"role":"user","content":"hello"}]}'
   ```
3. If that works, Claude Code can call the gateway via `curl`/`fetch` in Bash

### Phase 2: MCP Integration (short-term)

1. **Add an API-key auth route** (`/api/v1/*`) in the Worker for clean programmatic access
2. **Build an MCP server** that wraps OpenClaw's HTTP API, exposing tools like:
   - `send_message` — Send a message to an agent session
   - `list_sessions` — List active conversations
   - `agent_turn` — Run an agent turn and get the response
   - `gateway_status` — Health check
3. Register the MCP server in Claude Code's config

### Phase 3: Federation (medium-term)

1. **Hooks endpoint** in the Worker for fire-and-forget task triggers
2. **Shared context** via R2 (both instances read/write to the same bucket)
3. **Lightweight RPC protocol** — instances register as peers, delegate tasks, report results

---

## What's Missing in OpenClaw Today

| Gap | Impact |
|-----|--------|
| No native mesh/federation | Each instance is isolated |
| No shared memory across instances | Can't share context without external storage |
| No task delegation protocol | No "handle this and report back" primitive |
| No MCP server mode | Can't expose gateway as MCP tools natively |
| Hooks system is 80% there | Needs a standardized trigger/response format |

The hooks system + OpenAI-compatible API are the closest building blocks. A thin MCP wrapper over the HTTP API would get us most of the way to useful collaboration without needing OpenClaw core changes.
