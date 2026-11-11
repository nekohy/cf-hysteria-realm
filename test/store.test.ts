import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_RESPONSE_TIMEOUT_MS,
  EVENTS_BUFFER_SIZE,
  MAX_PENDING_ATTEMPTS,
  RealmStore,
  SESSION_TTL_MS,
  type StoredEvent,
} from "../src/store";

interface SqliteStatement {
  all(...values: SqlValue[]): unknown[];
  run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(query: string): void;
  prepare(query: string): SqliteStatement;
  close(): void;
}

interface EventRow {
  id: string;
  realm_id: string;
  session_id: string;
  name: string;
  data: string;
  created_at: number;
}

const [{ readFileSync }, { DatabaseSync }] = await Promise.all([
  vi.importActual<{ readFileSync(path: string, encoding: "utf8"): string }>("node:fs"),
  vi.importActual<{ DatabaseSync: new (path: string) => SqliteDatabase }>("node:sqlite"),
]);

const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();
const MIGRATION_SQL = readFileSync("migrations/0001_init.sql", "utf8");
const INITIAL_ADDRESSES = ["203.0.113.10:4433"];
const UPDATED_ADDRESSES = ["203.0.113.11:4433"];
const FRESH_ADDRESSES = ["198.51.100.20:9999"];
const OWNER_IP = "192.0.2.10";
const OTHER_OWNER_IP = "192.0.2.11";
const PUNCH = {
  addresses: ["198.51.100.30:4433"],
  obfs: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
};

type SqlValue = string | number | bigint | null | Uint8Array;

function d1Result<T>(results: T[], changes = 0, lastRowId = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      changes,
    },
  };
}

class FakeD1PreparedStatement {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly query: string,
    private readonly values: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.database, this.query, values as SqlValue[]);
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const result = this.execute<Record<string, unknown>>();
    const row = result.results[0];
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  execute<T>(): D1Result<T> {
    const statement = this.database.prepare(this.query);
    if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(this.query) || /\bRETURNING\b/i.test(this.query)) {
      const rows = statement.all(...this.values) as T[];
      return d1Result(rows);
    }
    const result = statement.run(...this.values);
    return d1Result<T>([], Number(result.changes), Number(result.lastInsertRowid));
  }
}

class FakeD1Database {
  private readonly database: SqliteDatabase = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec(MIGRATION_SQL);
  }

  prepare(query: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.database, query);
  }

  async batch<T = unknown>(statements: FakeD1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute<T>());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }

  close(): void {
    this.database.close();
  }
}

async function readEvents(
  database: FakeD1Database,
  realmId: string,
  sessionId: string,
): Promise<StoredEvent[]> {
  const result = await database
    .prepare(
      `SELECT id, realm_id, session_id, name, data, created_at
       FROM realm_events
       WHERE realm_id = ? AND session_id = ?
       ORDER BY sequence ASC`,
    )
    .bind(realmId, sessionId)
    .all<EventRow>();
  return result.results.map((row) => ({
    id: row.id,
    realmId: row.realm_id,
    sessionId: row.session_id,
    name: row.name,
    data: JSON.parse(row.data) as unknown,
    createdAt: row.created_at,
  }));
}

async function registerOk(
  store: RealmStore,
  realmId: string,
  addresses = INITIAL_ADDRESSES,
  ownerIp = OWNER_IP,
  maxRealms = 65_536,
  maxRealmsPerIp = 4,
) {
  const result = await store.register(realmId, addresses, ownerIp, maxRealms, maxRealmsPerIp);
  if (result.status !== "ok") throw new Error(`unexpected registration result: ${result.status}`);
  return result.session;
}

async function beginOk(store: RealmStore, realmId: string, nonce: string, punch = PUNCH) {
  const result = await store.beginConnect(realmId, nonce, punch);
  if (result.status !== "ok") throw new Error(`unexpected begin result: ${result.status}`);
  return result;
}

describe("RealmStore", () => {
  let database: FakeD1Database;
  let store: RealmStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    database = new FakeD1Database();
    store = new RealmStore(database.asD1());
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  it("registers 16-byte hex sessions and isolates realms", async () => {
    const first = await registerOk(store, "realm-a");
    const second = await registerOk(store, "realm-b", UPDATED_ADDRESSES);

    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
    expect(first).toEqual({
      realmId: "realm-a",
      id: first.id,
      addresses: INITIAL_ADDRESSES,
      expiresAt: NOW + SESSION_TTL_MS,
    });
    expect(await store.session("realm-a", first.id)).toEqual(first);
    expect(await store.session("realm-a", second.id)).toBeNull();
    expect(await store.session("realm-b", first.id)).toBeNull();

    const firstAttempt = await beginOk(store, "realm-a", "shared-nonce");
    const secondAttempt = await beginOk(store, "realm-b", "shared-nonce");
    expect(firstAttempt.attempt.id).toMatch(/^[0-9a-f]{32}$/);
    expect(firstAttempt.attempt.id).not.toBe(secondAttempt.attempt.id);
    expect((await store.beginConnect("realm-a", "shared-nonce", PUNCH)).status).toBe("rate_limited");

    expect(
      (await store.recordConnectResponse("realm-a", first.id, "shared-nonce", FRESH_ADDRESSES)).status,
    ).toBe("ok");
    expect(
      (await store.recordConnectResponse("realm-b", second.id, "shared-nonce", UPDATED_ADDRESSES)).status,
    ).toBe("ok");
    expect(
      await store.endConnect("realm-a", "shared-nonce", first.id, firstAttempt.attempt.id),
    ).toEqual({ status: "response", addresses: FRESH_ADDRESSES });
    expect(
      await store.endConnect("realm-b", "shared-nonce", second.id, secondAttempt.attempt.id),
    ).toEqual({ status: "response", addresses: UPDATED_ADDRESSES });
  });

  it("rejects an active duplicate without replacing state or canceling events", async () => {
    const session = await registerOk(store, "realm-a");
    const started = await beginOk(store, "realm-a", "pending-nonce");

    expect(await store.register("realm-a", UPDATED_ADDRESSES, OTHER_OWNER_IP, 100, 4)).toEqual({
      status: "realm_taken",
    });
    expect(await store.session("realm-a", session.id)).toEqual(session);
    expect(await readEvents(database, "realm-a", session.id)).toEqual([started.event]);
    expect(
      await store.endConnect("realm-a", "pending-nonce", session.id, started.attempt.id),
    ).toEqual({ status: "fallback", addresses: INITIAL_ADDRESSES });
  });

  it("allows expired registration and clears old attempts and events", async () => {
    const first = await registerOk(store, "realm-a");
    await beginOk(store, "realm-a", "old-nonce");
    await store.heartbeat("realm-a", first.id);
    expect(await store.openEventStream("realm-a", first.id, "old-stream")).toEqual(first);
    vi.advanceTimersByTime(SESSION_TTL_MS + 1);

    const result = await store.register("realm-a", UPDATED_ADDRESSES, OWNER_IP, 1, 1);
    if (result.status !== "ok") throw new Error(`unexpected registration result: ${result.status}`);

    expect(result.session.id).not.toBe(first.id);
    expect(result.session.addresses).toEqual(UPDATED_ADDRESSES);
    expect(result.session.expiresAt).toBe(Date.now() + SESSION_TTL_MS);
    expect(await store.session("realm-a", first.id)).toBeNull();
    expect(await readEvents(database, "realm-a", first.id)).toEqual([]);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM connect_attempts WHERE realm_id = ?")
        .bind("realm-a")
        .first<number>("count"),
    ).toBe(0);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM realm_events WHERE realm_id = ?")
        .bind("realm-a")
        .first<number>("count"),
    ).toBe(0);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM event_streams WHERE realm_id = ?")
        .bind("realm-a")
        .first<number>("count"),
    ).toBe(0);
    expect((await beginOk(store, "realm-a", "new-nonce")).attempt.sessionId).toBe(result.session.id);
  });

  it("deletes events only for a valid deregistered session", async () => {
    const first = await registerOk(store, "realm-a");
    vi.advanceTimersByTime(SESSION_TTL_MS + 1);
    const second = await registerOk(store, "realm-a", UPDATED_ADDRESSES);
    const started = await beginOk(store, "realm-a", "new-session-nonce");

    expect(await store.deregister("realm-a", first.id)).toBeNull();
    expect(await store.session("realm-a", second.id)).toEqual(second);
    expect(await readEvents(database, "realm-a", second.id)).toEqual([started.event]);
    expect(
      await store.endConnect("realm-a", "new-session-nonce", second.id, started.attempt.id),
    ).toEqual({ status: "fallback", addresses: UPDATED_ADDRESSES });

    const canceled = await beginOk(store, "realm-a", "cancel-on-deregister");
    expect(await store.deregister("realm-a", second.id)).toEqual({
      session: second,
      canceledAttempts: [canceled.attempt],
    });
    expect(await store.session("realm-a", second.id)).toBeNull();
    expect(await readEvents(database, "realm-a", second.id)).toEqual([]);
    expect(
      await store.endConnect("realm-a", "cancel-on-deregister", second.id, canceled.attempt.id),
    ).toEqual({ status: "missing" });
    expect(await store.deregister("realm-a", second.id)).toBeNull();
  });

  it("atomically renews heartbeat state and emits heartbeat_ack events", async () => {
    const session = await registerOk(store, "realm-a");
    vi.advanceTimersByTime(30_000);

    const renewed = await store.heartbeat("realm-a", session.id);
    expect(renewed).not.toBeNull();
    if (!renewed) throw new Error("heartbeat failed");
    expect(renewed.session).toEqual({ ...session, expiresAt: Date.now() + SESSION_TTL_MS });
    expect(renewed.event).toMatchObject({
      realmId: "realm-a",
      sessionId: session.id,
      name: "heartbeat_ack",
      data: { ttl: 60 },
      createdAt: Date.now(),
    });
    expect(await readEvents(database, "realm-a", session.id)).toEqual([renewed.event]);

    expect(await store.heartbeat("realm-a", "wrong-token", FRESH_ADDRESSES)).toBeNull();
    expect(await store.heartbeat("realm-b", session.id, FRESH_ADDRESSES)).toBeNull();
    expect(await readEvents(database, "realm-a", session.id)).toEqual([renewed.event]);

    vi.advanceTimersByTime(1_000);
    const updated = await store.heartbeat("realm-a", session.id, UPDATED_ADDRESSES);
    expect(updated?.session).toEqual({
      ...session,
      addresses: UPDATED_ADDRESSES,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    expect(await store.session("realm-a", session.id)).toEqual(updated?.session);
    expect(await readEvents(database, "realm-a", session.id)).toEqual([renewed.event, updated?.event]);

    vi.advanceTimersByTime(SESSION_TTL_MS + 1);
    expect(await store.heartbeat("realm-a", session.id)).toBeNull();
    expect(await store.session("realm-a", session.id)).toBeNull();
    expect(await readEvents(database, "realm-a", session.id)).toHaveLength(2);
  });

  it("enforces duplicate nonce and the concurrent 16-attempt cap per realm", async () => {
    expect(await store.beginConnect("realm-a", "no-session", PUNCH)).toEqual({ status: "no_session" });
    const session = await registerOk(store, "realm-a");
    await registerOk(store, "realm-b", UPDATED_ADDRESSES);

    const results = await Promise.all(
      Array.from({ length: MAX_PENDING_ATTEMPTS + 1 }, (_, index) =>
        store.beginConnect("realm-a", `nonce-${index}`, PUNCH)),
    );
    expect(results.filter((result) => result.status === "ok")).toHaveLength(MAX_PENDING_ATTEMPTS);
    expect(results.filter((result) => result.status === "rate_limited")).toHaveLength(1);
    expect(await store.beginConnect("realm-a", "nonce-0", PUNCH)).toEqual({ status: "rate_limited" });
    expect(await readEvents(database, "realm-a", session.id)).toHaveLength(MAX_PENDING_ATTEMPTS);
    expect(await store.beginConnect("realm-b", "nonce-0", PUNCH)).toMatchObject({ status: "ok" });

    const first = results[0];
    if (first.status !== "ok") throw new Error("first attempt failed");
    await store.cancelConnect("realm-a", "nonce-0", first.attempt.id);
    await database.prepare("DELETE FROM realm_events WHERE id = ?").bind(first.event.id).run();
    expect(await beginOk(store, "realm-a", "replacement-nonce")).toMatchObject({ session });

    vi.advanceTimersByTime(CONNECT_RESPONSE_TIMEOUT_MS + 1);
    expect(
      await store.recordConnectResponse("realm-a", session.id, "nonce-1", FRESH_ADDRESSES),
    ).toEqual({ status: "attempt_not_found" });
    await database
      .prepare("DELETE FROM realm_events WHERE realm_id = ? AND session_id = ?")
      .bind("realm-a", session.id)
      .run();
    expect((await beginOk(store, "realm-a", "nonce-0")).attempt.id).not.toBe(first.attempt.id);
  });

  it("returns responses and fallback, and consumes only the matching attempt", async () => {
    const session = await registerOk(store, "realm-a");

    const responseStarted = await beginOk(store, "realm-a", "response-nonce");
    const recorded = await store.recordConnectResponse(
      "realm-a",
      session.id,
      "response-nonce",
      FRESH_ADDRESSES,
    );
    if (recorded.status !== "ok") throw new Error(`unexpected result: ${recorded.status}`);
    expect(recorded.attempt).toEqual({
      realmId: "realm-a",
      nonce: "response-nonce",
      id: responseStarted.attempt.id,
      sessionId: session.id,
      responseAddresses: FRESH_ADDRESSES,
      expiresAt: NOW + CONNECT_RESPONSE_TIMEOUT_MS,
    });
    expect(
      await store.endConnect("realm-a", "response-nonce", session.id, responseStarted.attempt.id),
    ).toEqual({ status: "response", addresses: FRESH_ADDRESSES });
    expect(
      await store.endConnect("realm-a", "response-nonce", session.id, responseStarted.attempt.id),
    ).toEqual({ status: "missing" });

    const fallbackStarted = await beginOk(store, "realm-a", "fallback-nonce");
    await store.heartbeat("realm-a", session.id, UPDATED_ADDRESSES);
    expect(
      await store.endConnect("realm-a", "fallback-nonce", session.id, "wrong-attempt"),
    ).toEqual({ status: "missing" });
    expect(
      await store.endConnect("realm-a", "fallback-nonce", session.id, fallbackStarted.attempt.id),
    ).toEqual({ status: "fallback", addresses: UPDATED_ADDRESSES });

    const canceled = await beginOk(store, "realm-a", "canceled-nonce");
    await store.cancelConnect("realm-a", "canceled-nonce", canceled.attempt.id);
    expect(
      await store.endConnect("realm-a", "canceled-nonce", session.id, canceled.attempt.id),
    ).toEqual({ status: "missing" });
  });

  it("accepts only the first connect response", async () => {
    const session = await registerOk(store, "realm-a");
    const started = await beginOk(store, "realm-a", "response-nonce");

    expect(
      await store.recordConnectResponse("realm-a", "wrong-session", "response-nonce", FRESH_ADDRESSES),
    ).toEqual({ status: "no_session" });
    expect(
      await store.recordConnectResponse("realm-b", session.id, "response-nonce", FRESH_ADDRESSES),
    ).toEqual({ status: "no_session" });
    expect(
      await store.recordConnectResponse("realm-a", session.id, "unknown-nonce", FRESH_ADDRESSES),
    ).toEqual({ status: "attempt_not_found" });
    expect(
      await store.recordConnectResponse("realm-a", session.id, "response-nonce", INITIAL_ADDRESSES),
    ).toMatchObject({ status: "ok", attempt: { responseAddresses: INITIAL_ADDRESSES } });
    expect(
      await store.recordConnectResponse("realm-a", session.id, "response-nonce", FRESH_ADDRESSES),
    ).toEqual({ status: "attempt_not_found" });
    expect(
      await store.endConnect("realm-a", "response-nonce", session.id, started.attempt.id),
    ).toEqual({ status: "response", addresses: INITIAL_ADDRESSES });
  });

  it("keeps an expired attempt response available to its original owner", async () => {
    const session = await registerOk(store, "realm-a");
    const first = await beginOk(store, "realm-a", "reused-nonce");
    expect(
      await store.recordConnectResponse("realm-a", session.id, "reused-nonce", FRESH_ADDRESSES),
    ).toMatchObject({ status: "ok", attempt: { id: first.attempt.id } });

    vi.advanceTimersByTime(CONNECT_RESPONSE_TIMEOUT_MS + 1);
    const second = await beginOk(store, "realm-a", "reused-nonce");
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(await store.cleanupExpired()).toBe(0);
    expect(
      await store.endConnect("realm-a", "reused-nonce", session.id, first.attempt.id),
    ).toEqual({ status: "response", addresses: FRESH_ADDRESSES });
    await store.cancelConnect("realm-a", "reused-nonce", first.attempt.id);
    expect(
      await store.recordConnectResponse("realm-a", session.id, "reused-nonce", UPDATED_ADDRESSES),
    ).toMatchObject({ status: "ok", attempt: { id: second.attempt.id } });
    expect(
      await store.endConnect("realm-a", "reused-nonce", session.id, second.attempt.id),
    ).toEqual({ status: "response", addresses: UPDATED_ADDRESSES });
  });

  it("does not let an old cancel remove its active nonce replacement", async () => {
    const session = await registerOk(store, "realm-a");
    const first = await beginOk(store, "realm-a", "reused-nonce");
    vi.advanceTimersByTime(CONNECT_RESPONSE_TIMEOUT_MS + 1);
    const second = await beginOk(store, "realm-a", "reused-nonce");

    await store.cancelConnect("realm-a", "reused-nonce", first.attempt.id);
    expect(
      await store.endConnect("realm-a", "reused-nonce", session.id, first.attempt.id),
    ).toEqual({ status: "missing" });
    expect(
      await store.recordConnectResponse("realm-a", session.id, "reused-nonce", FRESH_ADDRESSES),
    ).toMatchObject({ status: "ok", attempt: { id: second.attempt.id } });
    expect(
      await store.endConnect("realm-a", "reused-nonce", session.id, second.attempt.id),
    ).toEqual({ status: "response", addresses: FRESH_ADDRESSES });
  });

  it("reads events in sequence order with realm and session isolation", async () => {
    const first = await registerOk(store, "realm-a");
    const second = await registerOk(store, "realm-b", UPDATED_ADDRESSES, OTHER_OWNER_IP);
    const firstHeartbeat = await store.heartbeat("realm-a", first.id);
    const firstPunch = await beginOk(store, "realm-a", "nonce-a");
    const secondHeartbeat = await store.heartbeat("realm-b", second.id);
    const secondPunch = await beginOk(store, "realm-b", "nonce-b", {
      addresses: FRESH_ADDRESSES,
      obfs: PUNCH.obfs,
    });

    const firstEvents = [firstHeartbeat?.event, firstPunch.event];
    const secondEvents = [secondHeartbeat?.event, secondPunch.event];
    expect(await readEvents(database, "realm-a", first.id)).toEqual(firstEvents);
    expect(await readEvents(database, "realm-b", second.id)).toEqual(secondEvents);
    expect(await readEvents(database, "realm-a", second.id)).toEqual([]);
    expect(await readEvents(database, "realm-b", first.id)).toEqual([]);
    expect(firstPunch.event.data).toEqual({
      addresses: PUNCH.addresses,
      nonce: "nonce-a",
      obfs: PUNCH.obfs,
    });
    expect(secondPunch.event.data).toEqual({
      addresses: FRESH_ADDRESSES,
      nonce: "nonce-b",
      obfs: PUNCH.obfs,
    });
  });

  it("allows only the current stream lease to claim events", async () => {
    const session = await registerOk(store, "realm-a");
    expect(await store.openEventStream("realm-a", "wrong-session", "stream-a")).toBeNull();
    expect(await store.openEventStream("realm-b", session.id, "stream-a")).toBeNull();
    expect(await store.openEventStream("realm-a", session.id, "stream-a")).toEqual(session);

    const firstHeartbeat = await store.heartbeat("realm-a", session.id);
    if (!firstHeartbeat?.event) throw new Error("first heartbeat event missing");
    expect(await store.openEventStream("realm-a", session.id, "stream-b")).toEqual(session);
    expect(await store.claimEvents("realm-a", session.id, "stream-a")).toEqual({
      status: "not_owner",
    });
    await store.closeEventStream("realm-a", session.id, "stream-a");
    expect(await store.claimEvents("realm-a", session.id, "stream-b")).toEqual({
      status: "ok",
      events: [firstHeartbeat.event],
    });

    const secondHeartbeat = await store.heartbeat("realm-a", session.id);
    if (!secondHeartbeat?.event) throw new Error("second heartbeat event missing");
    expect(await store.openEventStream("realm-a", session.id, "stream-a")).toEqual(session);
    expect(
      await store.claimEvent("realm-a", session.id, "stream-b", secondHeartbeat.event.id),
    ).toEqual({ status: "not_owner" });
    await store.closeEventStream("realm-a", session.id, "stream-b");

    const claims = await Promise.all([
      store.claimEvent("realm-a", session.id, "stream-a", secondHeartbeat.event.id),
      store.claimEvent("realm-a", session.id, "stream-a", secondHeartbeat.event.id),
    ]);
    expect(claims).toEqual([
      { status: "ok", event: secondHeartbeat.event },
      { status: "ok", event: null },
    ]);
    expect(await readEvents(database, "realm-a", session.id)).toEqual([]);

    const thirdHeartbeat = await store.heartbeat("realm-a", session.id);
    const fourthHeartbeat = await store.heartbeat("realm-a", session.id);
    if (!thirdHeartbeat?.event || !fourthHeartbeat?.event) throw new Error("heartbeat event missing");
    await store.openEventStream("realm-a", session.id, "stream-b");
    await store.closeEventStream("realm-a", session.id, "stream-a");
    const [oldClaim, currentClaim] = await Promise.all([
      store.claimEvents("realm-a", session.id, "stream-a"),
      store.claimEvents("realm-a", session.id, "stream-b"),
    ]);
    expect(oldClaim).toEqual({ status: "not_owner" });
    expect(currentClaim).toEqual({
      status: "ok",
      events: [thirdHeartbeat.event, fourthHeartbeat.event],
    });
    expect(await store.claimEvents("realm-a", session.id, "stream-b")).toEqual({
      status: "ok",
      events: [],
    });

    await store.closeEventStream("realm-a", session.id, "stream-b");
    expect(await store.claimEvents("realm-a", session.id, "stream-b")).toEqual({
      status: "not_owner",
    });
  });

  it("claims the oldest 16 events atomically and returns an empty batch after draining", async () => {
    const session = await registerOk(store, "realm-a");
    for (let index = 0; index < EVENTS_BUFFER_SIZE + 2; index += 1) {
      await database
        .prepare(
          `INSERT INTO realm_events (id, realm_id, session_id, name, data, created_at)
           VALUES (?, ?, ?, 'test', ?, ?)`,
        )
        .bind(`event-${index}`, session.realmId, session.id, JSON.stringify({ index }), NOW + index)
        .run();
    }
    const allEvents = await readEvents(database, "realm-a", session.id);
    await store.openEventStream("realm-a", session.id, "stream-a");

    expect(await store.claimEvents("realm-a", session.id, "stream-a")).toEqual({
      status: "ok",
      events: allEvents.slice(0, EVENTS_BUFFER_SIZE),
    });
    expect(await readEvents(database, "realm-a", session.id)).toEqual(allEvents.slice(EVENTS_BUFFER_SIZE));
    expect(await store.claimEvents("realm-a", session.id, "stream-a")).toEqual({
      status: "ok",
      events: allEvents.slice(EVENTS_BUFFER_SIZE),
    });
    expect(await store.claimEvents("realm-a", session.id, "stream-a")).toEqual({
      status: "ok",
      events: [],
    });
  });

  it("renews a full outbox session without an event and rejects punch without an attempt", async () => {
    const session = await registerOk(store, "realm-a");
    const events = [];
    for (let index = 0; index < EVENTS_BUFFER_SIZE; index += 1) {
      const heartbeat = await store.heartbeat("realm-a", session.id);
      if (!heartbeat?.event) throw new Error(`heartbeat event ${index} missing`);
      events.push(heartbeat.event);
    }

    vi.advanceTimersByTime(1_000);
    const fullHeartbeat = await store.heartbeat("realm-a", session.id, UPDATED_ADDRESSES);
    expect(fullHeartbeat).toEqual({
      session: {
        ...session,
        addresses: UPDATED_ADDRESSES,
        expiresAt: Date.now() + SESSION_TTL_MS,
      },
      event: null,
    });
    expect(await store.beginConnect("realm-a", "full-outbox", PUNCH)).toEqual({
      status: "rate_limited",
    });
    expect(await readEvents(database, "realm-a", session.id)).toEqual(events);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM connect_attempts WHERE realm_id = ?")
        .bind("realm-a")
        .first<number>("count"),
    ).toBe(0);
  });

  it("deregister returns expired attempts and removes the session lease", async () => {
    const session = await registerOk(store, "realm-a");
    const expired = await beginOk(store, "realm-a", "expired-nonce");
    await store.openEventStream("realm-a", session.id, "stream-a");
    vi.advanceTimersByTime(CONNECT_RESPONSE_TIMEOUT_MS + 1);
    const active = await beginOk(store, "realm-a", "active-nonce");

    expect(await store.deregister("realm-a", session.id)).toEqual({
      session,
      canceledAttempts: [active.attempt, expired.attempt],
    });
    expect(await store.metrics()).toEqual({ realms: 0, attempts: 0, streams: 0 });
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM connect_attempts WHERE session_id = ?")
        .bind(session.id)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM event_streams WHERE session_id = ?")
        .bind(session.id)
        .first<number>("count"),
    ).toBe(0);
  });

  it("cleans up an orphaned lease after its session expires", async () => {
    const session = await registerOk(store, "realm-a");
    await store.openEventStream("realm-a", session.id, "stream-a");
    expect(await store.metrics()).toEqual({ realms: 1, attempts: 0, streams: 1 });

    vi.advanceTimersByTime(SESSION_TTL_MS + 1);
    expect(await store.metrics()).toEqual({ realms: 0, attempts: 0, streams: 0 });
    expect(await store.openEventStream("realm-a", session.id, "stream-b")).toBeNull();
    expect(await store.cleanupExpired()).toBe(2);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM event_streams WHERE session_id = ?")
        .bind(session.id)
        .first<number>("count"),
    ).toBe(0);
  });

  it("treats zero registration limits as unlimited", async () => {
    await expect(store.register("realm-a", INITIAL_ADDRESSES, OWNER_IP, 0, 0)).resolves.toMatchObject({
      status: "ok",
    });
    await expect(store.register("realm-b", UPDATED_ADDRESSES, OWNER_IP, 0, 0)).resolves.toMatchObject({
      status: "ok",
    });
  });

  it("enforces global registration limits and the required error priority", async () => {
    const session = await registerOk(store, "realm-a");

    expect(await store.register("realm-a", UPDATED_ADDRESSES, OWNER_IP, 0, 0)).toEqual({
      status: "realm_taken",
    });
    expect(await store.register("realm-b", UPDATED_ADDRESSES, OWNER_IP, 1, 1)).toEqual({
      status: "realm_limit_reached",
    });
    expect(
      await store.register("realm-b", UPDATED_ADDRESSES, OTHER_OWNER_IP, 2, 4),
    ).toMatchObject({ status: "ok" });
    expect(
      await store.register("realm-c", FRESH_ADDRESSES, "192.0.2.12", 2, 4),
    ).toEqual({ status: "realm_limit_reached" });
    expect(await store.session("realm-a", session.id)).toEqual(session);
  });

  it("enforces per-IP registration limits concurrently and isolates other IPs", async () => {
    const results = await Promise.all([
      store.register("realm-a", INITIAL_ADDRESSES, OWNER_IP, 100, 1),
      store.register("realm-b", UPDATED_ADDRESSES, OWNER_IP, 100, 1),
    ]);

    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(results.filter((result) => result.status === "ip_limit_reached")).toHaveLength(1);
    expect(
      await store.register("realm-c", FRESH_ADDRESSES, OTHER_OWNER_IP, 100, 1),
    ).toMatchObject({ status: "ok" });
  });

  it("still returns fallback at the exact attempt deadline", async () => {
    const session = await registerOk(store, "realm-a");
    const started = await beginOk(store, "realm-a", "deadline-nonce");
    vi.advanceTimersByTime(CONNECT_RESPONSE_TIMEOUT_MS);

    expect(
      await store.endConnect("realm-a", "deadline-nonce", session.id, started.attempt.id),
    ).toEqual({ status: "fallback", addresses: INITIAL_ADDRESSES });
  });

  it("reports only unexpired realm and attempt metrics", async () => {
    const first = await registerOk(store, "realm-a");
    const second = await registerOk(store, "realm-b", UPDATED_ADDRESSES, OTHER_OWNER_IP);
    const firstAttempt = await beginOk(store, "realm-a", "nonce-a");
    await beginOk(store, "realm-a", "nonce-b");
    await beginOk(store, "realm-b", "nonce-c");
    await store.openEventStream("realm-a", first.id, "stream-a");
    await store.openEventStream("realm-b", second.id, "stream-b");
    expect(await store.metrics()).toEqual({ realms: 2, attempts: 3, streams: 2 });

    expect(
      await store.endConnect("realm-a", "nonce-a", first.id, firstAttempt.attempt.id),
    ).toMatchObject({ status: "fallback" });
    expect(await store.metrics()).toEqual({ realms: 2, attempts: 2, streams: 2 });

    vi.advanceTimersByTime(CONNECT_RESPONSE_TIMEOUT_MS + 1);
    expect(await store.metrics()).toEqual({ realms: 2, attempts: 0, streams: 2 });
    expect(await store.session("realm-b", second.id)).toEqual(second);

    vi.advanceTimersByTime(SESSION_TTL_MS - CONNECT_RESPONSE_TIMEOUT_MS);
    expect(await store.metrics()).toEqual({ realms: 0, attempts: 0, streams: 0 });
  });

  it("cleans expired rows and orphan events after their sessions", async () => {
    const first = await registerOk(store, "realm-a");
    const second = await registerOk(store, "realm-b", UPDATED_ADDRESSES);
    await beginOk(store, "realm-a", "nonce-a");
    await beginOk(store, "realm-b", "nonce-b");

    vi.advanceTimersByTime(CONNECT_RESPONSE_TIMEOUT_MS + 1);
    expect(await store.cleanupExpired()).toBe(0);
    expect(await store.session("realm-a", first.id)).toEqual(first);
    expect(await store.session("realm-b", second.id)).toEqual(second);
    expect(await readEvents(database, "realm-a", first.id)).toHaveLength(1);
    expect(await readEvents(database, "realm-b", second.id)).toHaveLength(1);

    const third = await registerOk(store, "realm-c", FRESH_ADDRESSES);
    await store.heartbeat("realm-c", third.id);
    vi.advanceTimersByTime(SESSION_TTL_MS - CONNECT_RESPONSE_TIMEOUT_MS);
    expect(await store.cleanupExpired(NOW + SESSION_TTL_MS + 1)).toBe(4);
    expect(await store.session("realm-a", first.id)).toBeNull();
    expect(await store.session("realm-b", second.id)).toBeNull();
    expect(await readEvents(database, "realm-a", first.id)).toEqual([]);
    expect(await readEvents(database, "realm-b", second.id)).toEqual([]);
    expect(await store.session("realm-c", third.id)).toEqual(third);

    vi.advanceTimersByTime(CONNECT_RESPONSE_TIMEOUT_MS);
    expect(await store.cleanupExpired()).toBe(4);
    expect(await store.session("realm-c", third.id)).toBeNull();
    expect(await readEvents(database, "realm-c", third.id)).toEqual([]);
  });
});
