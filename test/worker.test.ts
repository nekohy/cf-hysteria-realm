import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { RealmStore, type StoredAttempt, type StoredEvent, type StoredSession } from "../src/store";

const REALM_TOKEN = "realm-token";
const SESSION_ID = "00112233445566778899aabbccddeeff";
const NONCE = "00112233445566778899aabbccddeeff";
const ATTEMPT_ID = "11112233445566778899aabbccddeeff";
const EVENT_ID = "22112233445566778899aabbccddeeff";
const OBFS = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ADDRESSES = ["203.0.113.10:4433"];
const FRESH_ADDRESSES = ["198.51.100.1:9999"];

function session(realmId = "realm-a"): StoredSession {
  return {
    realmId,
    id: SESSION_ID,
    addresses: ADDRESSES,
    expiresAt: Date.now() + 60_000,
  };
}

function attempt(realmId = "realm-a"): StoredAttempt {
  return {
    realmId,
    nonce: NONCE,
    id: ATTEMPT_ID,
    sessionId: SESSION_ID,
    responseAddresses: FRESH_ADDRESSES,
    expiresAt: Date.now() + 10_000,
  };
}

function storedEvent(
  name: string,
  data: unknown,
  realmId = "realm-a",
  id = EVENT_ID,
): StoredEvent {
  return { id, realmId, sessionId: SESSION_ID, name, data, createdAt: Date.now() };
}

function env(): Env {
  return {
    DB: {} as D1Database,
    REALM_TOKEN,
    ABLY_API_KEY: "key-id:secret",
    DEBUG: "false",
  };
}

function executionContext(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

function request(method: string, path: string, token = REALM_TOKEN, body?: unknown): Request {
  return new Request(`https://realm.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "CF-Connecting-IP": "203.0.113.50",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ablyFrame(name: string, data: unknown, id = "event-1"): Uint8Array {
  const envelope = JSON.stringify({ name, data: JSON.stringify(data) });
  return new TextEncoder().encode(`id: ${id}\nevent: message\ndata: ${envelope}\n\n`);
}

function controllableStream(): {
  stream: ReadableStream<Uint8Array>;
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    stream,
    enqueue: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Worker API", () => {
  it("registers arbitrary valid realms", async () => {
    const register = vi.spyOn(RealmStore.prototype, "register").mockResolvedValue({
      status: "ok",
      session: session("any-name"),
    });
    const { ctx } = executionContext();

    const response = await worker.fetch(request("POST", "/v1/any-name", REALM_TOKEN, {
      addresses: ADDRESSES,
    }), env(), ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session_id: SESSION_ID, ttl: 60 });
    expect(register).toHaveBeenCalledWith("any-name", ADDRESSES);
  });

  it("maps registration conflicts", async () => {
    vi.spyOn(RealmStore.prototype, "register").mockResolvedValue({ status: "realm_taken" });

    const response = await worker.fetch(request("POST", "/v1/realm-a", REALM_TOKEN, {
      addresses: ADDRESSES,
    }), env(), executionContext().ctx);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "realm_taken" });
  });

  it("renews heartbeats and publishes heartbeat_ack", async () => {
    const current = session();
    vi.spyOn(RealmStore.prototype, "heartbeat").mockResolvedValue({
      session: current,
      event: storedEvent("heartbeat_ack", { ttl: 60 }),
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      request("POST", "/v1/realm-a/heartbeat", SESSION_ID, { addresses: FRESH_ADDRESSES }),
      env(),
      executionContext().ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ttl: 60 });
    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toContain("/channels/hysteria%3Asession%3A");
    const published = JSON.parse(String(init?.body));
    expect(published.name).toBe("heartbeat_ack");
    expect(JSON.parse(published.data)).toEqual({ eventId: EVENT_ID });
  });

  it("renews without publishing when the original 16-event buffer is full", async () => {
    vi.spyOn(RealmStore.prototype, "heartbeat").mockResolvedValue({
      session: session(),
      event: null,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      request("POST", "/v1/realm-a/heartbeat", SESSION_ID, {}),
      env(),
      executionContext().ctx,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("atomically claims outbox events and ignores duplicate notifications", async () => {
    const current = session();
    const backlog = storedEvent("heartbeat_ack", { ttl: 60 });
    const punch = storedEvent("punch", {
      addresses: ["198.51.100.20:4433"],
      nonce: NONCE,
      obfs: OBFS,
    }, "realm-a", "event-punch");
    vi.spyOn(RealmStore.prototype, "session").mockResolvedValue(current);
    vi.spyOn(RealmStore.prototype, "openEventStream").mockResolvedValue(current);
    vi.spyOn(RealmStore.prototype, "claimEvents").mockResolvedValue({ status: "ok", events: [backlog] });
    const claimEvent = vi.spyOn(RealmStore.prototype, "claimEvent").mockImplementation(
      async (_realmId, _sessionId, _streamId, eventId) => ({
        status: "ok",
        event: eventId === EVENT_ID ? null : punch,
      }),
    );
    const closeLease = vi.spyOn(RealmStore.prototype, "closeEventStream").mockResolvedValue();
    const upstream = controllableStream();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(upstream.stream));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = executionContext();
    const req = request("GET", "/v1/realm-a/events", SESSION_ID);
    req.headers.set("Last-Event-ID", "unsupported-by-original-hy2");

    const response = await worker.fetch(req, env(), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(await reader.read()).toEqual({ done: false, value: new TextEncoder().encode(": connected\n\n") });

    const replayed = await reader.read();
    expect(new TextDecoder().decode(replayed.value)).toBe(
      `id: ${EVENT_ID}\nevent: heartbeat_ack\ndata: {\"ttl\":60}\n\n`,
    );

    upstream.enqueue(ablyFrame("heartbeat_ack", { eventId: EVENT_ID }, "duplicate"));
    upstream.enqueue(ablyFrame("punch", { eventId: "event-punch" }, "fresh"));
    const event = await reader.read();
    expect(new TextDecoder().decode(event.value)).toBe(
      "id: event-punch\nevent: punch\ndata: " + JSON.stringify(punch.data) + "\n\n",
    );

    upstream.enqueue(ablyFrame("session_closed", {}, "close"));
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await Promise.all(pending);
    expect(claimEvent).toHaveBeenCalledTimes(2);
    expect(closeLease).toHaveBeenCalledWith("realm-a", SESSION_ID, expect.any(String));
    const subscribeUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(subscribeUrl.searchParams.has("lastEvent")).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("closes an older event stream when its D1 lease is no longer current", async () => {
    const current = session();
    vi.spyOn(RealmStore.prototype, "session").mockResolvedValue(current);
    vi.spyOn(RealmStore.prototype, "openEventStream").mockResolvedValue(current);
    vi.spyOn(RealmStore.prototype, "claimEvents").mockResolvedValue({ status: "not_owner" });
    const closeLease = vi.spyOn(RealmStore.prototype, "closeEventStream").mockResolvedValue();
    const upstream = controllableStream();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(upstream.stream));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = executionContext();

    const response = await worker.fetch(
      request("GET", "/v1/realm-a/events", SESSION_ID),
      env(),
      ctx,
    );
    const reader = response.body!.getReader();
    await reader.read();

    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await Promise.all(pending);
    expect(closeLease).toHaveBeenCalledWith("realm-a", SESSION_ID, expect.any(String));
  });

  it("revalidates the session after subscribing before opening a stream", async () => {
    vi.spyOn(RealmStore.prototype, "session").mockResolvedValue(session());
    vi.spyOn(RealmStore.prototype, "openEventStream").mockResolvedValue(null);
    const upstream = controllableStream();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(upstream.stream));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      request("GET", "/v1/realm-a/events", SESSION_ID),
      env(),
      executionContext().ctx,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
  });

  it("delivers a fresh connect response through D1 after the Ably wakeup", async () => {
    const current = session();
    vi.spyOn(RealmStore.prototype, "beginConnect").mockResolvedValue({
      status: "ok",
      session: current,
      attempt: attempt(),
      event: storedEvent("punch", { addresses: ["198.51.100.20:4433"], nonce: NONCE, obfs: OBFS }),
    });
    const endConnect = vi.spyOn(RealmStore.prototype, "endConnect").mockResolvedValue({
      status: "response",
      addresses: FRESH_ADDRESSES,
    });
    const upstream = controllableStream();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      return new URL(String(input)).pathname === "/sse"
        ? new Response(upstream.stream)
        : new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = worker.fetch(request("POST", "/v1/realm-a/connect", REALM_TOKEN, {
      addresses: ["198.51.100.20:4433"],
      nonce: NONCE,
      obfs: OBFS,
    }), env(), executionContext().ctx);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    upstream.enqueue(ablyFrame("connect_response", { nonce: NONCE }));
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ addresses: FRESH_ADDRESSES, nonce: NONCE, obfs: OBFS });
    expect(endConnect).toHaveBeenCalledWith("realm-a", NONCE, SESSION_ID, ATTEMPT_ID);
    const publishInit = fetchMock.mock.calls[1][1];
    const published = JSON.parse(String(publishInit?.body));
    expect(published.name).toBe("punch");
    expect(JSON.parse(published.data)).toEqual({ eventId: EVENT_ID });
  });

  it("resubscribes after an attempt stream EOF instead of returning early", async () => {
    const current = session();
    vi.spyOn(RealmStore.prototype, "beginConnect").mockResolvedValue({
      status: "ok",
      session: current,
      attempt: attempt(),
      event: storedEvent("punch", { addresses: ADDRESSES, nonce: NONCE, obfs: OBFS }),
    });
    vi.spyOn(RealmStore.prototype, "endConnect").mockResolvedValue({
      status: "response",
      addresses: FRESH_ADDRESSES,
    });
    const first = controllableStream();
    const second = controllableStream();
    let subscriptions = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (new URL(String(input)).pathname !== "/sse") return new Response(null, { status: 201 });
      subscriptions += 1;
      return new Response(subscriptions === 1 ? first.stream : second.stream);
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = worker.fetch(request("POST", "/v1/realm-a/connect", REALM_TOKEN, {
      addresses: ADDRESSES,
      nonce: NONCE,
      obfs: OBFS,
    }), env(), executionContext().ctx);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    first.close();
    await vi.waitFor(() => expect(subscriptions).toBe(2));
    second.enqueue(ablyFrame("connect_response", { nonce: NONCE }));
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ addresses: FRESH_ADDRESSES });
    expect(subscriptions).toBe(2);
  });

  it("falls back to current registered addresses after ten seconds", async () => {
    vi.useFakeTimers();
    const current = session();
    vi.spyOn(RealmStore.prototype, "beginConnect").mockResolvedValue({
      status: "ok",
      session: current,
      attempt: attempt(),
      event: storedEvent("punch", { addresses: ["198.51.100.20:4433"], nonce: NONCE, obfs: OBFS }),
    });
    vi.spyOn(RealmStore.prototype, "endConnect").mockResolvedValue({
      status: "fallback",
      addresses: ADDRESSES,
    });
    const upstream = controllableStream();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      return new URL(String(input)).pathname === "/sse"
        ? new Response(upstream.stream)
        : new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = worker.fetch(request("POST", "/v1/realm-a/connect", REALM_TOKEN, {
      addresses: ["198.51.100.20:4433"],
      nonce: NONCE,
      obfs: OBFS,
    }), env(), executionContext().ctx);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ addresses: ADDRESSES, nonce: NONCE, obfs: OBFS });
  });

  it("records and publishes realm-server connect responses", async () => {
    vi.spyOn(RealmStore.prototype, "recordConnectResponse").mockResolvedValue({
      status: "ok",
      attempt: attempt(),
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      request("POST", `/v1/realm-a/connects/${NONCE}`, SESSION_ID, { addresses: FRESH_ADDRESSES }),
      env(),
      executionContext().ctx,
    );

    expect(response.status).toBe(204);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/channels/hysteria%3Aattempt%3A");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: "connect_response",
      data: JSON.stringify({ nonce: NONCE }),
    });
  });

  it("keeps route, authentication, and validation errors in the original shape", async () => {
    const { ctx } = executionContext();
    const register = vi.spyOn(RealmStore.prototype, "register");

    expect((await worker.fetch(request("GET", "/unknown"), env(), ctx)).status).toBe(404);
    expect((await worker.fetch(request("POST", "/v1/bad%20realm", REALM_TOKEN, {
      addresses: ADDRESSES,
    }), env(), ctx)).status).toBe(400);
    expect((await worker.fetch(request("POST", "/v1/realm-a", "wrong", {
      addresses: ADDRESSES,
    }), env(), ctx)).status).toBe(401);
    expect((await worker.fetch(request("POST", "/v1/realm-a/events"), env(), ctx)).status).toBe(405);
    expect(register).not.toHaveBeenCalled();
  });

  it("exposes token-protected core Prometheus gauges", async () => {
    vi.spyOn(RealmStore.prototype, "metrics").mockResolvedValue({ realms: 2, attempts: 3, streams: 1 });
    const environment = env();
    environment.METRICS_TOKEN = "metrics-token";

    const denied = await worker.fetch(request("GET", "/metrics", "wrong"), environment, executionContext().ctx);
    expect(denied.status).toBe(401);
    const response = await worker.fetch(
      request("GET", "/metrics", "metrics-token"),
      environment,
      executionContext().ctx,
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("hysteria_realm_pending_connects 3\n");
    expect(text).toContain("hysteria_realm_event_streams_active 1\n");
  });
});
