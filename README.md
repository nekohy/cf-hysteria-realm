# cf-hysteria-realm

A Hy2 Realm rendezvous service on Cloudflare Workers, implementing the original HTTP/SSE protocol and dynamically named realms.

Maintained by [Nekohy](https://github.com/nekohy) · [中文说明](README.zh-CN.md) · [Technical docs](docs/technical.md)

## Features

- Original register, deregister, heartbeat, SSE, connect, and connect-response endpoints.
- D1 persistence for sessions, quotas, attempts, and a 16-event outbox; Ably for realtime notifications.
- Original 409/429 quota behavior, 60-second TTL, 10-second wait, and address fallback.
- No Durable Objects, database polling, or runtime npm dependencies.

Only UDP hole-punching metadata passes through this service; Hysteria traffic is not relayed.

## One-click deploy

Prepare free Cloudflare and Ably accounts and create an Ably API key with **publish + subscribe** permission.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nekohy/cf-hysteria-realm)

1. Click the button, authorize GitHub and Cloudflare, and confirm the source is `nekohy/cf-hysteria-realm`.
2. Enter `REALM_TOKEN` and `ABLY_API_KEY`. Cloudflare creates D1 and the deploy script applies the initial schema.
3. Use the deployed Worker URL and `REALM_TOKEN` in your Hy2 Realm configuration.

## Manual deploy

Node.js 24+ is required:

```bash
git clone https://github.com/nekohy/cf-hysteria-realm.git
cd cf-hysteria-realm
corepack pnpm install
corepack pnpm exec wrangler login
corepack pnpm exec wrangler d1 create cf-hysteria-realm
corepack pnpm exec wrangler secret put REALM_TOKEN
corepack pnpm exec wrangler secret put ABLY_API_KEY
corepack pnpm run deploy
```

No `database_id` is needed; migrations and deployment use the `DB` binding. To enable `/metrics`, also run `wrangler secret put METRICS_TOKEN`.

## Configuration

| Name | Default | Description |
| --- | --- | --- |
| `REALM_TOKEN` | Required Secret | Random token shared by realm servers and clients. |
| `ABLY_API_KEY` | Required Secret | Full Ably key with publish/subscribe permission. |
| `MAX_REALMS` | `65536` | Global active realm limit; `0` is unlimited. |
| `MAX_REALMS_PER_IP` | `4` | Active realms per IP; `0` is unlimited. |
| `REALM_NAME_PATTERN` | Original pattern | Optional JavaScript regular expression. |
| `TRUSTED_PROXY_HEADER` | `CF-Connecting-IP` | Trusted client-IP header. |
| `METRICS_TOKEN` | Unset | Enables `/metrics` with separate Bearer authentication. |
| `DEBUG` | `false` | Set to `true` for troubleshooting. |

Only use a `TRUSTED_PROXY_HEADER` overwritten by a trusted proxy; otherwise clients can spoof it to bypass per-IP quotas.

## Local development and tests

```bash
cp .dev.vars.example .dev.vars  # Set a real token and Ably key
corepack pnpm run db:migrate:local
corepack pnpm run dev
```

```bash
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm exec wrangler deploy --dry-run
```

Workers, D1, and Ably free quotas are shared per account. Actual capacity depends on heartbeat rate, connect activity, and other account projects. See the [technical docs](docs/technical.md) for protocol and runtime details.

## License

MIT
