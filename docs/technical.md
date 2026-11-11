# Technical documentation

## Compatibility and architecture

The service implements the rendezvous protocol used by [HyNetworks/hysteria-realm-server](https://github.com/HyNetworks/hysteria-realm-server) and the Hysteria 2 Realm client. It coordinates metadata only; it never relays Hysteria UDP traffic.

Cloudflare Workers handle all external requests. D1 stores sessions and connect attempts, while Ably supplies realtime notifications. No Durable Object, KV entry, or database polling loop is held open by an SSE connection.

### Request flow

1. A realm server registers its addresses and receives a random `session_id`.
2. The realm server opens `/events`; the Worker subscribes to that session's private Ably channel and forwards messages as Hy2-compatible SSE.
3. A client calls `/connect`. D1 atomically records the nonce and a persistent `punch` event, then the Worker publishes an event notification to the realm server's channel.
4. The realm server performs its hole-punching work and calls `/connects/{nonce}`.
5. D1 stores the fresh addresses and Ably wakes the waiting client request. The returned addresses are read from D1, not trusted from the notification payload.
6. If no response arrives within 10 seconds, the client receives the latest registered/heartbeat addresses.

Session and attempt expiry is enforced on every relevant D1 query. A scheduled Worker runs every five minutes to delete expired rows; correctness does not depend on that cleanup running exactly at the expiry instant.

## API

All error responses have this shape:

```json
{
  "error": "bad_request",
  "message": "invalid json"
}
```

`{id}` uses the original Hy2 Realm name pattern:

```text
^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$
```

### Authentication

| Token | Endpoints |
| --- | --- |
| `REALM_TOKEN` | `POST /v1/{id}`, `POST /v1/{id}/connect` |
| `session_id` | `GET /events`, `POST /heartbeat`, `DELETE /v1/{id}`, `POST /connects/{nonce}` |
| `METRICS_TOKEN` | `GET /metrics` when configured |

Use this header:

```http
Authorization: Bearer <token>
```

### Register

```http
POST /v1/{id}
Authorization: Bearer <REALM_TOKEN>
Content-Type: application/json

{"addresses":["203.0.113.10:4433"]}
```

Success:

```json
{"session_id":"generated-session-token","ttl":60}
```

An active realm name returns `409 realm_taken`. An expired name can be registered again. There are no artificial global or per-IP realm-count limits.

### Events

```http
GET /v1/{id}/events
Authorization: Bearer <session_id>
```

The response is `text/event-stream`. Business events match the original implementation:

```text
event: punch
data: {"addresses":["198.51.100.20:4433"],"nonce":"00112233445566778899aabbccddeeff","obfs":"..."}

event: heartbeat_ack
data: {"ttl":60}
```

The Worker can also emit `: connected` and `: keepalive` comments. SSE comments are ignored by the Hy2 client. A deregistered or expired session closes the stream.

Every business event is stored in a D1 outbox before its Ably notification is published. The Worker subscribes first, revalidates the session, and acquires a D1 stream lease before claiming undelivered rows. The newest lease supersedes older streams. `DELETE ... RETURNING` atomically claims each event before writing it, so overlapping streams cannot consume the same row. Delivery does not depend on `Last-Event-ID`, which the original Hy2 client does not send. As with the original in-memory queue, a crash after claiming but before writing can lose the in-flight event. The outbox is capped at 16 events per session, and streams rotate before reaching the Free plan's per-invocation D1 query limit.

### Heartbeat

```http
POST /v1/{id}/heartbeat
Authorization: Bearer <session_id>
Content-Type: application/json

{"addresses":["203.0.113.11:4433"]}
```

The body can be empty or `{}` to renew without changing addresses. Success returns `{"ttl":60}` and publishes `heartbeat_ack`.

### Deregister

```http
DELETE /v1/{id}
Authorization: Bearer <session_id>
```

Success returns `204`. The session and its pending attempts are removed; the event stream and waiting connect requests are notified through Ably.

### Client connect

```http
POST /v1/{id}/connect
Authorization: Bearer <REALM_TOKEN>
Content-Type: application/json

{
  "addresses":["198.51.100.20:4433"],
  "nonce":"00112233445566778899aabbccddeeff",
  "obfs":"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
}
```

A realm can have at most 16 active attempts. A duplicate active nonce or a full pending set returns `503 rate_limited`. Success returns fresh server addresses or the fallback addresses:

```json
{
  "addresses":["198.51.100.1:9999"],
  "nonce":"00112233445566778899aabbccddeeff",
  "obfs":"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
}
```

### Realm-server connect response

```http
POST /v1/{id}/connects/{nonce}
Authorization: Bearer <session_id>
Content-Type: application/json

{"addresses":["198.51.100.1:9999"]}
```

Success returns `204`. An expired or unknown nonce returns `404 attempt_not_found`. If the Ably wakeup is delayed or lost, the 10-second cleanup path still reads any recorded D1 response.

### Metrics

When `METRICS_TOKEN` is configured:

```http
GET /metrics
Authorization: Bearer <METRICS_TOKEN>
```

The Prometheus text response exposes `realms_registered`, `sessions_active`, `event_streams_active`, and `pending_connects` gauges under the `hysteria_realm_` namespace. Without `METRICS_TOKEN`, the route is not exposed.

## Validation and limits

- Request bodies: 4 KiB.
- Addresses: 1–8 IP/port strings; hostnames are not accepted.
- `nonce`: 32 hexadecimal characters.
- `obfs`: 64 hexadecimal characters.
- Active connect attempts: 16 per realm.
- Undelivered events: 16 per session.

Realm sessions have no artificial global or per-IP count limit. Cloudflare and Ably account quotas still apply.

## Local development

Create D1 once with `corepack pnpm exec wrangler d1 create cf-hysteria-realm`. No `database_id` is required; commands resolve the `DB` binding. Then:

```bash
cp .dev.vars.example .dev.vars
corepack pnpm run db:migrate:local
corepack pnpm run dev
```

Local event delivery requires a real Ably key. Unit and integration tests use `node:sqlite` and mocked Ably responses instead.

## Checks

```bash
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm exec wrangler deploy --dry-run
```
