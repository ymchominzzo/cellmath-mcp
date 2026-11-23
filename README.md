# cellmath-mcp

> Lightweight MCP client & spec wrapper for CellMath (Bring Your Own Key).

CellMath is a memory governance layer for AI agents: durable knowledge **cells** that are
retrieved through a retrieval gate, checked before use, and committed with provenance.
This repository is only the thin client side of that contract — a single-file bridge that
lets any **stdio** MCP client talk to a CellMath **Streamable HTTP** endpoint using your own
API key.

There is no server code, no data, and no credential in this repository. Nothing here talks
to a fixed host: you point it at your own endpoint.

- Node.js 18+ · zero dependencies · one file
- stdio (`stdin`/`stdout` JSON-RPC) ↔ Streamable HTTP (`POST`, JSON or SSE)
- Pass-through: tools and schemas are whatever your endpoint serves

---

## Quick start

```bash
git clone https://github.com/<your-account>/cellmath-mcp.git
cd cellmath-mcp

export CELLMATH_MCP_URL="https://<your-mcp-endpoint>/api/mcp"
export CELLMATH_API_KEY="sk_live_<your_api_key>"

node index.js
```

The bridge now waits for newline-delimited JSON-RPC on stdin. Paste a message and press
Enter:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}
```

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

Each response is printed to stdout as one JSON object per line. Diagnostics go to stderr.

---

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `CELLMATH_MCP_URL` | yes | Streamable HTTP endpoint, e.g. `https://<your-mcp-endpoint>/api/mcp` |
| `CELLMATH_API_KEY` | yes | Your CellMath API key, sent as `Authorization: Bearer <key>` |
| `CELLMATH_MCP_TIMEOUT_MS` | no | Per-request timeout in milliseconds (default `120000`) |

The bridge reads only the environment; it never loads a `.env` file by itself. For a local
shell, copy `.env.example` to `.env`, fill it in, and export it:

```bash
set -a; . ./.env; set +a
node index.js
```

If a required variable is missing, the bridge prints what is missing and how to set it, then
exits with status 1 before any network call is made.

---

## Client setup

Most desktop MCP clients expect a **command** they can launch. Use `node` with the absolute
path to `index.js`, and pass the two variables in an `env` block.

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "cellmath": {
      "command": "node",
      "args": ["/absolute/path/to/cellmath-mcp/index.js"],
      "env": {
        "CELLMATH_MCP_URL": "https://<your-mcp-endpoint>/api/mcp",
        "CELLMATH_API_KEY": "sk_live_<your_api_key>"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "cellmath": {
      "command": "node",
      "args": ["/absolute/path/to/cellmath-mcp/index.js"],
      "env": {
        "CELLMATH_MCP_URL": "https://<your-mcp-endpoint>/api/mcp",
        "CELLMATH_API_KEY": "sk_live_<your_api_key>"
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "cellmath": {
      "command": "node",
      "args": ["/absolute/path/to/cellmath-mcp/index.js"],
      "env": {
        "CELLMATH_MCP_URL": "https://<your-mcp-endpoint>/api/mcp",
        "CELLMATH_API_KEY": "sk_live_<your_api_key>"
      }
    }
  }
}
```

### Native Streamable HTTP client

If your client speaks Streamable HTTP directly, you do not need this bridge — connect it to
the endpoint with the same headers the bridge sends:

```json
{
  "mcpServers": {
    "cellmath": {
      "type": "streamable-http",
      "url": "https://<your-mcp-endpoint>/api/mcp",
      "headers": {
        "Authorization": "Bearer sk_live_<your_api_key>",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18"
      }
    }
  }
}
```

---

## The three tools

A CellMath endpoint exposes a small, deliberately fixed tool surface. The bridge forwards
whatever schema your endpoint reports — call `tools/list` for the authoritative definition;
the summary below is orientation, not a contract.

| Tool | Role | Main parameters |
| --- | --- | --- |
| `vault_access` | Retrieve knowledge. Search the index, fetch one cell, or walk the causal graph. Read-only. | `action` (`search` \| `get` \| `graph`), `query`, `id`, `category` (`cell` \| `organ` \| `fact` \| `skill` \| `hypothesis` \| `all`), `tag`, `limit`, `auto_hydrate`, `limit_full`, `include_session` |
| `verify_safety` | Independent check before acting: destructive command and injection screening, plus math checks for drift and groundedness. Read-only. | `actionProposal`, `operation` (`safety_check` \| `wasserstein` \| `entropy` \| `matrix_solve` \| `groundedness` \| `unblock`), `params` |
| `vault_commit` | Durable mutation: save, update, supersede, link causal edges, checkpoint a session, or purge. Destructive — confirm before calling. | `action` (`save` \| `update` \| `checkpoint` \| `link_edge` \| `resolve_hypothesis` \| `remove` \| `sync` \| `unblock` \| `lift_do_not`), `title`, `content`, `id`, `tags`, `ai_compressed_summary`, `is_hypothesis`, `supersedes_id`, `goalTask`, `from` / `to` / `rel`, `hypothesis_action`, `confirm` |

A typical agent loop is **retrieve → verify → commit**: pull the smallest relevant cell, have
the planned action checked, then commit only what the evidence supports. An empty retrieval
is not necessarily an error — a query with no verified match may legitimately return nothing.

---

## What the bridge does

- Reads stdin line by line; each non-empty line must be one JSON-RPC 2.0 message.
- `POST`s it to `CELLMATH_MCP_URL` with:
  - `Content-Type: application/json`
  - `Authorization: Bearer <CELLMATH_API_KEY>`
  - `Accept: application/json, text/event-stream`
  - `MCP-Protocol-Version: 2025-06-18`
  - `Mcp-Session-Id` once the server has issued one
- Accepts either response shape:
  - `Content-Type: application/json` — single object or batch array
  - `Content-Type: text/event-stream` — every `data:` field is parsed and emitted; empty
    keep-alive events are ignored
- Treats `202` / `204` (the normal answer to notifications) as success with no output.
- Keeps request order: one request in flight at a time.
- Reports a transport or HTTP failure as a JSON-RPC error (`-32603`) for the affected
  request id, logs the detail to stderr, and keeps running.
- Malformed stdin lines get a `-32700` parse error instead of crashing the process.
- Exits with status 0 when stdin closes, 1 on bad configuration.

---

## Security notes

- The API key comes only from the environment. It is never written to disk, never printed,
  and is redacted from error messages before they reach stdout or stderr.
- Use `https://`. Plain `http://` is accepted only for local development and prints a warning
  when the host is not loopback.
- `.env` is git-ignored; keep it out of shell history and CI logs too.
- If a key leaks, rotate it on the CellMath side — this client stores no credential to revoke.
- Usage and billing belong to the CellMath account that owns the key (Bring Your Own Key).

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `missing required environment variable(s)` on start | The client's `env` block does not reach the process; check the exact names |
| `upstream returned HTTP 401` | Wrong, expired or rotated key |
| `upstream returned HTTP 403` | Key not allowed to call that tool, or account restriction |
| `upstream returned HTTP 404` / `405` | `CELLMATH_MCP_URL` is not the MCP endpoint path (usually `/api/mcp`) |
| No output at all for a notification | Expected: notifications get `202` and produce no stdout |
| `upstream returned no response payload` | The endpoint accepted the request but returned an empty body for a request id |
| `request failed: ...` followed by a `-32603` error | Transport or server error; the detail on stderr is the upstream message |

---

## Scope

This project is intentionally a shell:

- no client-side schema validation, caching, retries or rate limiting
- no tool implementations, prompts or resources bundled — the endpoint is the source of truth
- no default endpoint, domain or account baked in

Add those in your own client if you need them; the bridge stays small on purpose.

## License

MIT — see [LICENSE](LICENSE).
