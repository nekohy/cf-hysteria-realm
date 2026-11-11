# cf-hysteria-realm

A Hy2 Realm rendezvous service running on Cloudflare Workers. It implements the original six HTTP/SSE endpoints and supports dynamically registered realms.

[中文说明](README.zh-CN.md) · [Technical docs](docs/technical.md)

## Architecture

- **Cloudflare Workers** serve the HTTP API, authentication, SSE responses, and the 10-second punch wait.
- **Cloudflare D1** persists realm sessions, per-IP quotas, nonces, punch responses, and the offline event outbox.
- **Ably** carries `punch`, `heartbeat_ack`, and punch responses over REST + SSE.

There are no Durable Objects and no KV/D1 polling. This service only exchanges UDP hole-punching metadata; Hysteria traffic does not pass through it.

## Features

- Dynamically named realms with a shared `REALM_TOKEN`.
- Original 60-second session TTL, heartbeat updates, 10-second connect wait, and address fallback.
- Original `realm_taken`, `realm_limit_reached`, and `ip_limit_reached` behavior.
- Up to 16 in-flight connects per realm, with nonce isolation between realms.
- Persistent sessions and attempts, plus a 16-event outbox with atomic claim-on-delivery for SSE reconnects.
- Optional token-protected Prometheus core gauges.
- No runtime packages: Ably uses native HTTP/SSE without an SDK.

## Deploy

### 1. Prepare free accounts

You need Cloudflare and Ably accounts. Create an Ably API key with **publish + subscribe** permission. The key is stored as a Worker secret and is never returned to Hysteria servers or clients.

### 2. Create D1

Node.js 24+ is required. Use Corepack to run pnpm:

```bash
corepack pnpm install
corepack pnpm exec wrangler login
corepack pnpm exec wrangler d1 create cf-hysteria-realm
```

Copy the resulting `database_id` into `wrangler.jsonc`, then apply the initial schema:

```bash
corepack pnpm run db:migrate:remote
```

### 3. Configure secrets

```bash
corepack pnpm exec wrangler secret put REALM_TOKEN
corepack pnpm exec wrangler secret put ABLY_API_KEY
```

Use a long random `REALM_TOKEN`. To enable `GET /metrics`, also set a separate secret:

```bash
corepack pnpm exec wrangler secret put METRICS_TOKEN
```

### 4. Deploy and configure Hy2

```bash
corepack pnpm run deploy
```

Use the deployed Worker URL and `REALM_TOKEN` in your Hysteria Realm configuration. See the [official Hy2 Realms documentation](https://v2.hysteria.network/docs/advanced/Realms/) for server and client settings.

## Configuration

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `REALM_TOKEN` | Secret | Required | Shared token for realm registration and client connects. |
| `ABLY_API_KEY` | Secret | Required | Full Ably API key with publish/subscribe permission. |
| `MAX_REALMS` | Variable | `65536` | Global active realm limit; `0` disables the limit. |
| `MAX_REALMS_PER_IP` | Variable | `4` | Active realms per registering client IP; `0` disables the limit. |
| `REALM_NAME_PATTERN` | Variable | Original pattern | Optional realm-name regular expression. |
| `TRUSTED_PROXY_HEADER` | Variable | `CF-Connecting-IP` | Trusted client-IP header; the left-most comma-separated value is used. |
| `METRICS_TOKEN` | Secret | Unset | Enables `GET /metrics` with a separate Bearer token. |
| `DEBUG` | Variable | `false` | Set to `true` only for troubleshooting. |

Only configure `TRUSTED_PROXY_HEADER` when a trusted proxy overwrites that header. Otherwise clients can spoof it and bypass the per-IP quota. The default is appropriate for direct Cloudflare deployments.

## Free-tier limits

Quotas are shared by the account, not duplicated per deployment:

- Cloudflare Workers Free: 100,000 requests/day.
- Cloudflare D1 Free: 5M rows read and 100K rows written/day, with 5 GB storage.
- Ably Free: 500 concurrent connections, 500 peak channels, and 6M messages/month.

Long-lived streams do not poll D1, but heartbeats and events still consume D1 writes and Ably messages. Actual realm capacity depends on activity and other projects in the same accounts.

## Local development and tests

```bash
cp .dev.vars.example .dev.vars
# Set real REALM_TOKEN and ABLY_API_KEY values
corepack pnpm run db:migrate:local
corepack pnpm run dev
```

```bash
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm exec wrangler deploy --dry-run
```

Tests use in-memory SQLite and a mocked Ably transport; no real services are contacted.

## License

MIT
