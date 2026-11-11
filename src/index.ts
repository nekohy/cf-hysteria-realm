import {
  AblyClient,
  AblyError,
  attemptChannel,
  encodeSseEvent,
  readAblyMessages,
  sessionChannel,
} from "./ably";
import {
  bearer,
  errorResponse,
  isValidRealmId,
  jsonResponse,
  normalizeIpAddress,
  parseRoute,
  readJson,
  validateAddresses,
  validateNonce,
  validateObfs,
} from "./protocol";
import {
  CONNECT_RESPONSE_TIMEOUT_MS,
  RealmStore,
  SESSION_TTL_MS,
  type StoredAttempt,
  type StoredEvent,
  type StoredSession,
} from "./store";

const SSE_KEEPALIVE_MS = 15_000;
const MAX_D1_OPERATIONS_PER_STREAM = 40;

export interface Env {
  DB: D1Database;
  REALM_TOKEN: string;
  ABLY_API_KEY: string;
  REALM_NAME_PATTERN?: string;
  MAX_REALMS?: string;
  MAX_REALMS_PER_IP?: string;
  TRUSTED_PROXY_HEADER?: string;
  METRICS_TOKEN?: string;
  DEBUG?: string;
}

type App = {
  env: Env;
  ctx: ExecutionContext;
  store: RealmStore;
  ably: AblyClient;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/metrics") {
      try {
        return await metrics(request, env);
      } catch (error) {
        debug(env, "metrics failed", error);
        return errorResponse(500, "internal_error", "internal server error");
      }
    }
    const route = parseRoute(url.pathname, request.method);
    if (!route) return errorResponse(404, "not_found", "unknown path");
    if (route.kind === "badRequest") return errorResponse(400, "bad_request", route.message);
    let validRealmId: boolean;
    try {
      validRealmId = isValidRealmId(route.realmId, env.REALM_NAME_PATTERN);
    } catch {
      return errorResponse(500, "bad_request", "invalid REALM_NAME_PATTERN");
    }
    if (!validRealmId) return errorResponse(400, "bad_request", "invalid realm name");
    if (!env.REALM_TOKEN) return errorResponse(500, "bad_request", "REALM_TOKEN is not configured");
    if (!env.ABLY_API_KEY) return errorResponse(500, "bad_request", "ABLY_API_KEY is not configured");
    if (route.kind === "methodNotAllowed") return errorResponse(405, "bad_request", "method not allowed");

    const app: App = {
      env,
      ctx,
      store: new RealmStore(env.DB),
      ably: new AblyClient(env.ABLY_API_KEY),
    };

    try {
      switch (route.kind) {
        case "register":
          return await register(request, app, route);
        case "deregister":
          return await deregister(request, app, route);
        case "events":
          return await events(request, app, route);
        case "heartbeat":
          return await heartbeat(request, app, route);
        case "connect":
          return await connect(request, app, route);
        case "connectResponse":
          return await connectResponse(request, app, route);
      }
    } catch (error) {
      debug(env, "request failed", error);
      if (error instanceof AblyError) {
        return errorResponse(502, "bad_gateway", "realtime service unavailable");
      }
      return errorResponse(500, "internal_error", "internal server error");
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const deleted = await new RealmStore(env.DB).cleanupExpired();
    debug(env, `expired cleanup deleted=${deleted}`);
  },
};

async function metrics(request: Request, env: Env): Promise<Response> {
  if (!env.METRICS_TOKEN) return errorResponse(404, "not_found", "unknown path");
  if (request.method !== "GET") return errorResponse(405, "bad_request", "method not allowed");
  if (bearer(request) !== env.METRICS_TOKEN) {
    return errorResponse(401, "invalid_token", "invalid metrics token");
  }

  const values = await new RealmStore(env.DB).metrics();
  const maxRealms = numericLimit(env.MAX_REALMS, 65_536);
  const maxRealmsPerIp = numericLimit(env.MAX_REALMS_PER_IP, 4);
  const body = [
    "# TYPE hysteria_realm_realms_registered gauge",
    `hysteria_realm_realms_registered ${values.realms}`,
    "# TYPE hysteria_realm_sessions_active gauge",
    `hysteria_realm_sessions_active ${values.realms}`,
    "# TYPE hysteria_realm_pending_connects gauge",
    `hysteria_realm_pending_connects ${values.attempts}`,
    "# TYPE hysteria_realm_event_streams_active gauge",
    `hysteria_realm_event_streams_active ${values.streams}`,
    "# TYPE hysteria_realm_global_limit gauge",
    `hysteria_realm_global_limit ${maxRealms}`,
    "# TYPE hysteria_realm_ip_limit gauge",
    `hysteria_realm_ip_limit ${maxRealmsPerIp}`,
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

async function register(request: Request, app: App, route: { realmId: string }): Promise<Response> {
  if (bearer(request) !== app.env.REALM_TOKEN) return errorResponse(401, "invalid_token", "invalid realm token");
  const body = await readJson<{ addresses?: unknown }>(request);
  if (body instanceof Response) return body;
  const addresses = validateAddresses(body.addresses);
  if (typeof addresses === "string") return errorResponse(400, "bad_request", addresses);

  const result = await app.store.register(
    route.realmId,
    addresses,
    clientIp(request, app.env),
    numericLimit(app.env.MAX_REALMS, 65_536),
    numericLimit(app.env.MAX_REALMS_PER_IP, 4),
  );
  if (result.status === "realm_taken") {
    return errorResponse(409, "realm_taken", "realm is already registered");
  }
  if (result.status === "realm_limit_reached") {
    return errorResponse(429, "realm_limit_reached", "maximum number of realms reached");
  }
  if (result.status === "ip_limit_reached") {
    return errorResponse(429, "ip_limit_reached", "maximum realms per client IP reached");
  }
  return jsonResponse(200, { session_id: result.session.id, ttl: SESSION_TTL_MS / 1000 });
}

async function deregister(request: Request, app: App, route: { realmId: string }): Promise<Response> {
  const result = await app.store.deregister(route.realmId, bearer(request));
  if (!result) return errorResponse(401, "invalid_token", "invalid session token");

  await closePreviousSession(app, result.session, result.canceledAttempts);
  return new Response(null, { status: 204 });
}

async function heartbeat(request: Request, app: App, route: { realmId: string }): Promise<Response> {
  const body = await readJson<{ addresses?: unknown }>(request, true);
  if (body instanceof Response) return body;

  let addresses: string[] | undefined;
  if (body.addresses !== undefined) {
    const validated = validateAddresses(body.addresses);
    if (typeof validated === "string") return errorResponse(400, "bad_request", validated);
    addresses = validated;
  }

  const result = await app.store.heartbeat(route.realmId, bearer(request), addresses);
  if (!result) return errorResponse(401, "invalid_token", "invalid session token");
  const { session, event } = result;

  if (event) {
    await app.ably.publish(sessionChannel(session.realmId, session.id), "heartbeat_ack", {
      eventId: event.id,
    });
  }
  return jsonResponse(200, { ttl: SESSION_TTL_MS / 1000 });
}

async function events(request: Request, app: App, route: { realmId: string }): Promise<Response> {
  let session = await app.store.session(route.realmId, bearer(request));
  if (!session) return errorResponse(401, "invalid_token", "invalid session token");

  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  request.signal.addEventListener("abort", onRequestAbort, { once: true });
  if (request.signal.aborted) onRequestAbort();

  const streamId = crypto.randomUUID();
  let upstream: Response;
  try {
    upstream = await app.ably.subscribe(sessionChannel(session.realmId, session.id), {
      signal: abort.signal,
    });
    const leasedSession = await app.store.openEventStream(session.realmId, session.id, streamId);
    if (!leasedSession) {
      abort.abort();
      request.signal.removeEventListener("abort", onRequestAbort);
      return errorResponse(401, "invalid_token", "invalid session token");
    }
    session = leasedSession;
  } catch (error) {
    abort.abort();
    request.signal.removeEventListener("abort", onRequestAbort);
    throw error;
  }

  let pump: Promise<void>;
  const readable = new ReadableStream<Uint8Array>({
    start(output) {
      output.enqueue(encode(": connected\n\n"));
      pump = pumpEvents(output, upstream, session, streamId, request, app, abort, onRequestAbort);
    },
    cancel() {
      abort.abort();
    },
  });
  app.ctx.waitUntil(pump!);

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

async function pumpEvents(
  output: ReadableStreamDefaultController<Uint8Array>,
  upstream: Response,
  session: StoredSession,
  streamId: string,
  request: Request,
  app: App,
  abort: AbortController,
  onRequestAbort: () => void,
): Promise<void> {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let currentExpiry = session.expiresAt;
  let d1Operations = 0;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      output.close();
    } catch {
      // The client may already have canceled the response.
    }
  };
  const armExpiry = () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => abort.abort(), Math.max(0, currentExpiry - Date.now()));
  };
  const writeEvent = (event: StoredEvent): void => {
    if (abort.signal.aborted) return;
    if (event.name === "heartbeat_ack") {
      const ttl = (event.data as { ttl?: unknown } | null)?.ttl;
      if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) {
        currentExpiry = Math.max(currentExpiry, event.createdAt + ttl * 1000);
        armExpiry();
      }
    }
    output.enqueue(encode(encodeSseEvent(event.name, event.data, event.id)));
  };

  try {
    armExpiry();
    keepalive = setInterval(() => {
      if (closed || abort.signal.aborted) return;
      try {
        output.enqueue(encode(": keepalive\n\n"));
      } catch {
        abort.abort();
      }
    }, SSE_KEEPALIVE_MS);

    // Subscribe before claiming the outbox so the subscribe/backlog gap is covered.
    const backlog = await app.store.claimEvents(session.realmId, session.id, streamId);
    d1Operations += 1;
    if (backlog.status === "not_owner") {
      close();
      return;
    }
    for (const event of backlog.events) writeEvent(event);

    for await (const message of readAblyMessages(upstream, abort.signal)) {
      if (message.name === "session_closed") break;
      if (message.name !== "punch" && message.name !== "heartbeat_ack") continue;
      const claimed = await app.store.claimEvent(
        session.realmId,
        session.id,
        streamId,
        decodeEventId(message.data),
      );
      d1Operations += 1;
      if (claimed.status === "not_owner") break;
      if (claimed.event) writeEvent(claimed.event);
      // Reconnect before approaching the Free plan's 50 D1 queries/invocation limit.
      if (d1Operations >= MAX_D1_OPERATIONS_PER_STREAM) break;
    }
    close();
  } catch (error) {
    if (abort.signal.aborted) {
      close();
    } else {
      debug(app.env, "event stream failed", error);
      closed = true;
      output.error(error);
    }
  } finally {
    if (expiryTimer) clearTimeout(expiryTimer);
    if (keepalive) clearInterval(keepalive);
    abort.abort();
    request.signal.removeEventListener("abort", onRequestAbort);
    await app.store.closeEventStream(session.realmId, session.id, streamId).catch((error) => {
      debug(app.env, "event stream lease cleanup failed", error);
    });
  }
}

function decodeEventId(value: unknown): string {
  const eventId = (value as { eventId?: unknown } | null)?.eventId;
  if (typeof eventId !== "string" || !eventId) {
    throw new AblyError("Ably event notification is malformed");
  }
  return eventId;
}

async function connect(request: Request, app: App, route: { realmId: string }): Promise<Response> {
  if (bearer(request) !== app.env.REALM_TOKEN) return errorResponse(401, "invalid_token", "invalid realm token");
  const body = await readJson<{ addresses?: unknown; nonce?: unknown; obfs?: unknown }>(request);
  if (body instanceof Response) return body;

  const addresses = validateAddresses(body.addresses);
  if (typeof addresses === "string") return errorResponse(400, "bad_request", addresses);
  const nonceError = validateNonce(body.nonce);
  if (nonceError) return errorResponse(400, "bad_request", nonceError);
  const obfsError = validateObfs(body.obfs);
  if (obfsError) return errorResponse(400, "bad_request", obfsError);
  const nonce = body.nonce as string;
  const obfs = body.obfs as string;

  const started = await app.store.beginConnect(route.realmId, nonce, { addresses, obfs });
  if (started.status === "no_session") return errorResponse(404, "realm_not_found", "realm not registered");
  if (started.status === "rate_limited") {
    return errorResponse(503, "rate_limited", "too many in-flight connect attempts");
  }

  const session = started.session;
  const attempt = started.attempt;
  const event = started.event;
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  request.signal.addEventListener("abort", onRequestAbort, { once: true });
  if (request.signal.aborted) onRequestAbort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      abort.abort();
      resolve();
    }, CONNECT_RESPONSE_TIMEOUT_MS);
  });

  try {
    const notifyAndWait = async (): Promise<void> => {
      let upstream: Response | null;
      try {
        upstream = await app.ably.subscribe(attemptChannel(route.realmId, session.id, attempt.id), {
          signal: abort.signal,
        });
        await app.ably.publish(sessionChannel(route.realmId, session.id), "punch", {
          eventId: event.id,
        }, abort.signal);
      } catch (error) {
        if (!abort.signal.aborted) {
          await app.store.cancelConnect(route.realmId, nonce, attempt.id).catch(() => undefined);
        }
        throw error;
      }

      while (!abort.signal.aborted) {
        try {
          upstream ??= await app.ably.subscribe(attemptChannel(route.realmId, session.id, attempt.id), {
            signal: abort.signal,
          });
          await waitForAttemptSignal(upstream, abort.signal);
          return;
        } catch (error) {
          if (abort.signal.aborted) return;
          debug(app.env, "connect notification failed; resubscribing", error);
          upstream = null;
          await retryDelay(250, abort.signal);
        }
      }
    };
    await Promise.race([notifyAndWait(), timeoutPromise]);

    const ended = await app.store.endConnect(route.realmId, nonce, session.id, attempt.id);
    if (ended.status === "missing") return errorResponse(404, "realm_not_found", "realm not registered");
    return jsonResponse(200, { addresses: ended.addresses, nonce, obfs });
  } finally {
    if (timeout) clearTimeout(timeout);
    abort.abort();
    request.signal.removeEventListener("abort", onRequestAbort);
  }
}

async function waitForAttemptSignal(upstream: Response, signal: AbortSignal): Promise<void> {
  for await (const message of readAblyMessages(upstream, signal)) {
    if (message.name === "connect_response" || message.name === "connect_cancel") return;
  }
  throw new AblyError("Ably attempt stream closed before a response arrived");
}

async function retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function connectResponse(
  request: Request,
  app: App,
  route: { realmId: string; nonce: string },
): Promise<Response> {
  const nonceError = validateNonce(route.nonce);
  if (nonceError) return errorResponse(400, "bad_request", nonceError);
  const body = await readJson<{ addresses?: unknown }>(request);
  if (body instanceof Response) return body;
  const addresses = validateAddresses(body.addresses);
  if (typeof addresses === "string") return errorResponse(400, "bad_request", addresses);

  const result = await app.store.recordConnectResponse(
    route.realmId,
    bearer(request),
    route.nonce,
    addresses,
  );
  if (result.status === "no_session") return errorResponse(401, "invalid_token", "invalid session token");
  if (result.status === "attempt_not_found") {
    return errorResponse(404, "attempt_not_found", "no pending attempt for nonce");
  }

  await app.ably.publish(
    attemptChannel(route.realmId, result.attempt.sessionId, result.attempt.id),
    "connect_response",
    { nonce: route.nonce },
  );
  return new Response(null, { status: 204 });
}

async function closePreviousSession(
  app: App,
  session: StoredSession | null,
  canceledAttempts: StoredAttempt[],
): Promise<void> {
  if (!session) return;
  try {
    await app.ably.publish(sessionChannel(session.realmId, session.id), "session_closed", {});
    for (const attempt of canceledAttempts) {
      await app.ably.publish(
        attemptChannel(session.realmId, session.id, attempt.id),
        "connect_cancel",
        { nonce: attempt.nonce },
      );
    }
  } catch (error) {
    // TTL checks and endConnect still provide correct behavior if cancellation is lost.
    debug(app.env, "session cancellation publish failed", error);
  }
}

function numericLimit(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function clientIp(request: Request, env: Env): string {
  const header = env.TRUSTED_PROXY_HEADER ?? "CF-Connecting-IP";
  const trusted = header ? normalizeClientIp(request.headers.get(header)) : null;
  return trusted ?? normalizeClientIp(request.headers.get("CF-Connecting-IP")) ?? "unknown";
}

function normalizeClientIp(value: string | null): string | null {
  if (!value) return null;
  let candidate = value.split(",", 1)[0].trim();
  if (candidate.startsWith("[")) {
    const end = candidate.indexOf("]");
    if (end < 0) return null;
    candidate = candidate.slice(1, end);
  } else {
    const colon = candidate.lastIndexOf(":");
    if (colon > 0 && candidate.indexOf(":") === colon && /^\d+$/.test(candidate.slice(colon + 1))) {
      candidate = candidate.slice(0, colon);
    }
  }
  return normalizeIpAddress(candidate);
}

function debug(env: Env, message: string, error?: unknown): void {
  if (env.DEBUG === "true") console.log(message, error ?? "");
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
