<div align="center">

# @devcxl/cabbage-memory

[![npm version](https://img.shields.io/npm/v/@devcxl/cabbage-memory)](https://www.npmjs.com/package/@devcxl/cabbage-memory)
[![npm downloads](https://img.shields.io/npm/dm/@devcxl/cabbage-memory)](https://www.npmjs.com/package/@devcxl/cabbage-memory)
[![license](https://img.shields.io/npm/l/@devcxl/cabbage-memory)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/devcxl/opencode-memory/ci.yml?branch=main)](https://github.com/devcxl/opencode-memory/actions)

[English](./README.md) | [中文](./README.zh.md)

Remote memory system on Cloudflare Workers (D1 + Vectorize) for OpenCode plugins and MCP clients.

</div>

## Architecture (v2)

- **Storage**: unified D1 memory table (`daily` / `fact` / `instruction` / `digest`) + Vectorize index + Workers AI (Qwen3 embedding / LLM)
- **Search**: hybrid retrieval — full keyword matches are strictly ranked above partial matches (bucket tiering), fused with vector ranking via RRF; optional facet-based hard filtering
- **Daily digest**: every day at 04:00 (user timezone), yesterday's daily logs are summarized into a single fact memory; idempotent and re-runnable
- **Memory metabolism**: after each fact is written, an LLM asynchronously checks for duplicates/supersessions/contradictions; superseded facts are retired automatically
- **Auth**: GitHub OAuth2 for the web console; revocable API tokens (hashed at rest) for plugins and MCP
- **Access**: OpenCode native plugin (with context injection) / MCP Streamable HTTP (`/mcp`, 7 tools) / REST API

## Repository Layout

```
opencode-memory/
├── apps/
│   ├── api/            # Cloudflare Worker: REST + MCP + OAuth + cron
│   ├── plugin/         # @devcxl/cabbage-memory  OpenCode plugin (remote-only)
│   ├── pi-extension/   # @devcxl/cabbage-memory-pi  pi coding agent extension
│   └── web/            # Web console (React, deployed with the Worker)
├── packages/shared/    # Shared types & domain model
├── scripts/            # Migration & ops scripts
└── docs/               # Architecture docs & ADRs
```

## Deploy & Migrate (v1 → v2)

Run Wrangler commands from `apps/api`, where `wrangler.toml` lives.

1. Apply migrations and deploy:

   ```bash
   cd apps/api
   wrangler d1 migrations apply memory-db --remote
   cd ../..
   pnpm --filter @devcxl/cabbage-memory-web build
   pnpm deploy:api
   ```

2. Set secrets and register a GitHub OAuth App (callback `<worker-url>/auth/github/callback`):

   ```bash
   cd apps/api
   wrangler secret put JWT_SECRET
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   # Required for legacy data remap (`/api/admin/remap-user`)
   wrangler secret put ADMIN_SECRET
   ```

   Optional: set `OAUTH_ALLOWLIST` in `apps/api/wrangler.toml` to a comma-separated list of GitHub ids/logins; when empty, only the first login can claim the instance.

3. After the first GitHub login, generate an API token in the web console, then remap legacy data and rebuild the vector index (`--admin-secret` must match the `ADMIN_SECRET` Worker secret):

   ```bash
   npx tsx scripts/migrate-v2.ts \
     --url https://<worker-url> \
     --token opm_xxx \
     --old-user-id <legacy JWT sub> \
     --admin-secret <ADMIN_SECRET> \
     --force-reindex
   ```

## Plugin Setup

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    ["@devcxl/cabbage-memory", {
      "remote": {
        "apiUrl": "https://<worker-url>",
        "apiKey": "env://OPM_API_KEY"
      }
    }]
  ]
}
```

Environment variables `OPM_API_URL` / `OPM_API_KEY` take precedence over the config file.

## MCP

Streamable HTTP endpoint: `<worker-url>/mcp`, authenticated with an API token:

```bash
claude mcp add --transport http memory https://<worker-url>/mcp --header "Authorization: Bearer opm_xxx"
```

Tools: `memory_add` / `memory_search` / `memory_get` / `memory_update` / `memory_delete` / `memory_context` / `memory_digest_status`.

## pi Integration

The [pi coding agent](https://pi.dev/) does not support MCP (by design), so it uses a native TypeScript extension (see [apps/pi-extension](./apps/pi-extension/README.md)):

```bash
git clone https://github.com/devcxl/opencode-memory.git
pi -e ./opencode-memory/apps/pi-extension/src/extension.ts

export OPM_API_URL="https://<worker-url>"
export OPM_API_KEY="opm_xxx"
```

It provides the `memory_add/search/get/update/delete/list` tools and injects the server-assembled memory context into the system prompt at session start.

## Tool: memory (OpenCode plugin)

| Action | Description | Key params |
|--------|-------------|------------|
| `add` | Create a record | `type`: daily/fact/instruction, `subtype`, `title`, `content`, `scope`, `date`, `tags` |
| `search` | Hybrid search | `query`, `max_results`, `scope` |
| `get` | Read one record | `id` |
| `update` | Update one record | `id`, `title`, `content`, `tags` |
| `delete` | Delete one record | `id` |
| `list` | List recent records | `type`, `date`, `scope` |

`scope`: `project` (current git project) / `global` / `all`.

**Memory types:**

| type | Purpose |
|------|---------|
| `daily` | Raw daily logs (default write target, summarized by the digest cron) |
| `fact` | Atomic facts (preferences/episodic/knowledge); one topic per record; auto dedup & metabolism |
| `instruction` | Stable directives (identity/rules/workflows) |
| `digest` | Daily summary (system-generated, one per user×project per day) |

## Context Injection

At session start the plugin injects: identity + user preferences + rules/workflows + project knowledge + the 3 latest digests, assembled server-side by `/api/context` — injection strategy can change without releasing a new plugin version.

## License

MIT
