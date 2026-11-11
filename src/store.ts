export const SESSION_TTL_MS = 60_000;
export const CONNECT_RESPONSE_TIMEOUT_MS = 10_000;
export const MAX_PENDING_ATTEMPTS = 16;
export const EVENTS_BUFFER_SIZE = 16;

const CONNECT_ATTEMPT_CLEANUP_GRACE_MS = 60_000;

export interface StoredSession {
  realmId: string;
  id: string;
  addresses: string[];
  expiresAt: number;
}

export interface StoredAttempt {
  realmId: string;
  nonce: string;
  id: string;
  sessionId: string;
  responseAddresses: string[] | null;
  expiresAt: number;
}

export interface StoredEvent {
  id: string;
  realmId: string;
  sessionId: string;
  name: string;
  data: unknown;
  createdAt: number;
}

export type RegisterResult =
  | { status: "ok"; session: StoredSession }
  | { status: "realm_taken" }
  | { status: "realm_limit_reached" }
  | { status: "ip_limit_reached" };

export interface MetricsResult {
  realms: number;
  attempts: number;
  streams: number;
}

export interface DeregisterResult {
  session: StoredSession;
  canceledAttempts: StoredAttempt[];
}

export interface HeartbeatResult {
  session: StoredSession;
  event: StoredEvent | null;
}

export type BeginConnectResult =
  | { status: "ok"; session: StoredSession; attempt: StoredAttempt; event: StoredEvent }
  | { status: "no_session" }
  | { status: "rate_limited" };

export type ClaimEventsResult =
  | { status: "ok"; events: StoredEvent[] }
  | { status: "not_owner" };

export type ClaimEventResult =
  | { status: "ok"; event: StoredEvent | null }
  | { status: "not_owner" };

export type RecordConnectResponseResult =
  | { status: "ok"; attempt: StoredAttempt }
  | { status: "no_session" }
  | { status: "attempt_not_found" };

export type EndConnectResult =
  | { status: "response" | "fallback"; addresses: string[] }
  | { status: "missing" };

interface SessionRow {
  realm_id: string;
  id: string;
  addresses: string;
  expires_at: number;
}

interface AttemptRow {
  realm_id: string;
  nonce: string;
  id: string;
  session_id: string;
  response_addresses: string | null;
  expires_at: number;
}

interface EventRow {
  id: string;
  realm_id: string;
  session_id: string;
  name: string;
  data: string;
  created_at: number;
}

interface RegistrationCheckRow {
  realm_taken: number;
  realms: number;
  owner_realms: number;
}

interface ClaimedEventRow extends EventRow {
  sequence: number;
}

interface MetricsRow {
  realms: number;
  attempts: number;
  streams: number;
}

const SESSION_COLUMNS = "realm_id, id, addresses, expires_at";
const ATTEMPT_COLUMNS = "realm_id, nonce, id, session_id, response_addresses, expires_at";
const EVENT_COLUMNS = "id, realm_id, session_id, name, data, created_at";

export class RealmStore {
  constructor(private readonly db: D1Database) {}

  async session(realmId: string, sessionId: string): Promise<StoredSession | null> {
    const now = Date.now();
    const row = await this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS}
         FROM realm_sessions
         WHERE realm_id = ? AND id = ? AND expires_at > ?`,
      )
      .bind(realmId, sessionId, now)
      .first<SessionRow>();
    return row ? toSession(row) : null;
  }

  async register(
    realmId: string,
    addresses: string[],
    ownerIp: string,
    maxRealms: number,
    maxRealmsPerIp: number,
  ): Promise<RegisterResult> {
    const now = Date.now();
    const session: StoredSession = {
      realmId,
      id: randomHex(16),
      addresses: [...addresses],
      expiresAt: now + SESSION_TTL_MS,
    };
    const registrationCondition = `NOT EXISTS (
      SELECT 1 FROM realm_sessions
      WHERE realm_id = ? AND expires_at > ?
    )
    AND (? = 0 OR (SELECT COUNT(*) FROM realm_sessions WHERE expires_at > ?) < ?)
    AND (
      ? = 0 OR (
        SELECT COUNT(*) FROM realm_sessions WHERE owner_ip = ? AND expires_at > ?
      ) < ?
    )`;
    const conditionArguments = [
      realmId,
      now,
      maxRealms,
      now,
      maxRealms,
      maxRealmsPerIp,
      ownerIp,
      now,
      maxRealmsPerIp,
    ];

    const [checkResult, , , , insertResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT
             EXISTS (
               SELECT 1 FROM realm_sessions WHERE realm_id = ? AND expires_at > ?
             ) AS realm_taken,
             (SELECT COUNT(*) FROM realm_sessions WHERE expires_at > ?) AS realms,
             (
               SELECT COUNT(*) FROM realm_sessions WHERE owner_ip = ? AND expires_at > ?
             ) AS owner_realms`,
        )
        .bind(realmId, now, now, ownerIp, now),
      this.db
        .prepare(
          `DELETE FROM connect_attempts
           WHERE realm_id = ? AND ${registrationCondition}`,
        )
        .bind(realmId, ...conditionArguments),
      this.db
        .prepare(
          `DELETE FROM realm_events
           WHERE realm_id = ? AND ${registrationCondition}`,
        )
        .bind(realmId, ...conditionArguments),
      this.db
        .prepare(
          `DELETE FROM event_streams
           WHERE realm_id = ? AND ${registrationCondition}`,
        )
        .bind(realmId, ...conditionArguments),
      this.db
        .prepare(
          `INSERT INTO realm_sessions (realm_id, id, owner_ip, addresses, expires_at)
           SELECT ?, ?, ?, ?, ?
           WHERE ${registrationCondition}
           ON CONFLICT (realm_id) DO UPDATE SET
             id = excluded.id,
             owner_ip = excluded.owner_ip,
             addresses = excluded.addresses,
             expires_at = excluded.expires_at`,
        )
        .bind(
          session.realmId,
          session.id,
          ownerIp,
          JSON.stringify(session.addresses),
          session.expiresAt,
          ...conditionArguments,
        ),
    ]);

    const checks = checkResult.results[0] as RegistrationCheckRow | undefined;
    if (!checks) throw new Error("registration check returned no row");
    if (checks.realm_taken !== 0) return { status: "realm_taken" };
    if (maxRealms > 0 && checks.realms >= maxRealms) return { status: "realm_limit_reached" };
    if (maxRealmsPerIp > 0 && checks.owner_realms >= maxRealmsPerIp) {
      return { status: "ip_limit_reached" };
    }
    if (insertResult.meta.changes !== 1) throw new Error("conditional registration did not insert");
    return { status: "ok", session };
  }

  async deregister(realmId: string, sessionId: string): Promise<DeregisterResult | null> {
    const now = Date.now();
    const currentSessionExists = `EXISTS (
      SELECT 1 FROM realm_sessions
      WHERE realm_id = ? AND id = ? AND expires_at > ?
    )`;
    const [sessionResult, attemptsResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${SESSION_COLUMNS}
           FROM realm_sessions
           WHERE realm_id = ? AND id = ? AND expires_at > ?`,
        )
        .bind(realmId, sessionId, now),
      this.db
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS}
           FROM connect_attempts
           WHERE realm_id = ? AND session_id = ?
             AND ${currentSessionExists}
           ORDER BY nonce, id`,
        )
        .bind(realmId, sessionId, realmId, sessionId, now),
      this.db
        .prepare(
          `DELETE FROM connect_attempts
           WHERE realm_id = ? AND session_id = ? AND ${currentSessionExists}`,
        )
        .bind(realmId, sessionId, realmId, sessionId, now),
      this.db
        .prepare(
          `DELETE FROM realm_events
           WHERE realm_id = ? AND session_id = ? AND ${currentSessionExists}`,
        )
        .bind(realmId, sessionId, realmId, sessionId, now),
      this.db
        .prepare(
          `DELETE FROM event_streams
           WHERE realm_id = ? AND session_id = ? AND ${currentSessionExists}`,
        )
        .bind(realmId, sessionId, realmId, sessionId, now),
      this.db
        .prepare(
          `DELETE FROM realm_sessions
           WHERE realm_id = ? AND id = ? AND expires_at > ?`,
        )
        .bind(realmId, sessionId, now),
    ]);

    const row = sessionResult.results[0] as SessionRow | undefined;
    if (!row) return null;
    return {
      session: toSession(row),
      canceledAttempts: (attemptsResult.results as AttemptRow[]).map(toAttempt),
    };
  }

  async openEventStream(
    realmId: string,
    sessionId: string,
    streamId: string,
  ): Promise<StoredSession | null> {
    const now = Date.now();
    const [, sessionResult] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO event_streams (session_id, realm_id, stream_id)
           SELECT id, realm_id, ?
           FROM realm_sessions
           WHERE realm_id = ? AND id = ? AND expires_at > ?
           ON CONFLICT (session_id) DO UPDATE SET
             realm_id = excluded.realm_id,
             stream_id = excluded.stream_id`,
        )
        .bind(streamId, realmId, sessionId, now),
      this.db
        .prepare(
          `SELECT ${SESSION_COLUMNS}
           FROM realm_sessions
           WHERE realm_id = ? AND id = ? AND expires_at > ?`,
        )
        .bind(realmId, sessionId, now),
    ]);
    const row = sessionResult.results[0] as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async closeEventStream(realmId: string, sessionId: string, streamId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM event_streams
         WHERE realm_id = ? AND session_id = ? AND stream_id = ?`,
      )
      .bind(realmId, sessionId, streamId)
      .run();
  }

  async heartbeat(
    realmId: string,
    sessionId: string,
    addresses?: string[],
  ): Promise<HeartbeatResult | null> {
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    const event: StoredEvent = {
      id: randomHex(16),
      realmId,
      sessionId,
      name: "heartbeat_ack",
      data: { ttl: SESSION_TTL_MS / 1000 },
      createdAt: now,
    };
    const update = addresses === undefined
      ? this.db
          .prepare(
            `UPDATE realm_sessions
             SET expires_at = ?
             WHERE realm_id = ? AND id = ? AND expires_at > ?`,
          )
          .bind(expiresAt, realmId, sessionId, now)
      : this.db
          .prepare(
            `UPDATE realm_sessions
             SET expires_at = ?, addresses = ?
             WHERE realm_id = ? AND id = ? AND expires_at > ?`,
          )
          .bind(expiresAt, JSON.stringify(addresses), realmId, sessionId, now);
    const [, insertResult, sessionResult] = await this.db.batch([
      update,
      this.db
        .prepare(
          `INSERT INTO realm_events (id, realm_id, session_id, name, data, created_at)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM realm_sessions
             WHERE realm_id = ? AND id = ? AND expires_at > ?
           )
           AND (
             SELECT COUNT(*) FROM realm_events
             WHERE realm_id = ? AND session_id = ?
           ) < ?`,
        )
        .bind(
          event.id,
          event.realmId,
          event.sessionId,
          event.name,
          JSON.stringify(event.data),
          event.createdAt,
          realmId,
          sessionId,
          now,
          realmId,
          sessionId,
          EVENTS_BUFFER_SIZE,
        ),
      this.db
        .prepare(
          `SELECT ${SESSION_COLUMNS}
           FROM realm_sessions
           WHERE realm_id = ? AND id = ? AND expires_at > ?`,
        )
        .bind(realmId, sessionId, now),
    ]);
    const row = sessionResult.results[0] as SessionRow | undefined;
    return row
      ? { session: toSession(row), event: insertResult.meta.changes === 1 ? event : null }
      : null;
  }

  async beginConnect(
    realmId: string,
    nonce: string,
    punch: { addresses: string[]; obfs: string },
  ): Promise<BeginConnectResult> {
    const now = Date.now();
    const attemptId = randomHex(16);
    const eventId = randomHex(16);
    const expiresAt = now + CONNECT_RESPONSE_TIMEOUT_MS;
    const eventData = {
      addresses: [...punch.addresses],
      nonce,
      obfs: punch.obfs,
    };
    const [sessionResult, insertResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${SESSION_COLUMNS}
           FROM realm_sessions
           WHERE realm_id = ? AND expires_at > ?`,
        )
        .bind(realmId, now),
      this.db
        .prepare(
          `INSERT INTO connect_attempts
             (realm_id, nonce, id, session_id, response_addresses, expires_at)
           SELECT ?, ?, ?, session.id, NULL, ?
           FROM realm_sessions AS session
           WHERE session.realm_id = ? AND session.expires_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM connect_attempts AS attempt
               WHERE attempt.realm_id = ? AND attempt.nonce = ? AND attempt.expires_at > ?
             )
             AND (
               SELECT COUNT(*) FROM connect_attempts AS attempt
               WHERE attempt.realm_id = ? AND attempt.expires_at > ?
             ) < ?
             AND (
               SELECT COUNT(*) FROM realm_events AS event
               WHERE event.realm_id = session.realm_id AND event.session_id = session.id
             ) < ?`,
        )
        .bind(
          realmId,
          nonce,
          attemptId,
          expiresAt,
          realmId,
          now,
          realmId,
          nonce,
          now,
          realmId,
          now,
          MAX_PENDING_ATTEMPTS,
          EVENTS_BUFFER_SIZE,
        ),
      this.db
        .prepare(
          `INSERT INTO realm_events (id, realm_id, session_id, name, data, created_at)
           SELECT ?, attempt.realm_id, attempt.session_id, 'punch', ?, ?
           FROM connect_attempts AS attempt
           WHERE attempt.realm_id = ? AND attempt.nonce = ? AND attempt.id = ?`,
        )
        .bind(eventId, JSON.stringify(eventData), now, realmId, nonce, attemptId),
    ]);

    const row = sessionResult.results[0] as SessionRow | undefined;
    if (!row) return { status: "no_session" };
    if (insertResult.meta.changes === 0) return { status: "rate_limited" };
    const session = toSession(row);
    const attempt: StoredAttempt = {
      realmId,
      nonce,
      id: attemptId,
      sessionId: session.id,
      responseAddresses: null,
      expiresAt,
    };
    const event: StoredEvent = {
      id: eventId,
      realmId,
      sessionId: session.id,
      name: "punch",
      data: eventData,
      createdAt: now,
    };
    return { status: "ok", session, attempt, event };
  }

  async recordConnectResponse(
    realmId: string,
    sessionId: string,
    nonce: string,
    addresses: string[],
  ): Promise<RecordConnectResponseResult> {
    const now = Date.now();
    const [sessionResult, updateResult, attemptResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT id
           FROM realm_sessions
           WHERE realm_id = ? AND id = ? AND expires_at > ?`,
        )
        .bind(realmId, sessionId, now),
      this.db
        .prepare(
          `UPDATE connect_attempts
           SET response_addresses = ?
           WHERE realm_id = ? AND nonce = ? AND session_id = ? AND expires_at > ?
             AND response_addresses IS NULL
             AND EXISTS (
               SELECT 1 FROM realm_sessions AS session
               WHERE session.realm_id = ? AND session.id = ? AND session.expires_at > ?
             )`,
        )
        .bind(
          JSON.stringify(addresses),
          realmId,
          nonce,
          sessionId,
          now,
          realmId,
          sessionId,
          now,
        ),
      this.db
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS}
           FROM connect_attempts
           WHERE realm_id = ? AND nonce = ? AND session_id = ? AND expires_at > ?`,
        )
        .bind(realmId, nonce, sessionId, now),
    ]);

    if (sessionResult.results.length === 0) return { status: "no_session" };
    const row = attemptResult.results[0] as AttemptRow | undefined;
    if (updateResult.meta.changes === 0 || !row) return { status: "attempt_not_found" };
    return { status: "ok", attempt: toAttempt(row) };
  }

  async endConnect(
    realmId: string,
    nonce: string,
    sessionId: string,
    attemptId: string,
  ): Promise<EndConnectResult> {
    const now = Date.now();
    const [attemptResult, , sessionResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS}
           FROM connect_attempts
           WHERE realm_id = ? AND nonce = ? AND session_id = ? AND id = ?`,
        )
        .bind(realmId, nonce, sessionId, attemptId),
      this.db
        .prepare(
          `DELETE FROM connect_attempts
           WHERE realm_id = ? AND nonce = ? AND session_id = ? AND id = ?`,
        )
        .bind(realmId, nonce, sessionId, attemptId),
      this.db
        .prepare(
          `SELECT ${SESSION_COLUMNS}
           FROM realm_sessions
           WHERE realm_id = ? AND id = ? AND expires_at > ?`,
        )
        .bind(realmId, sessionId, now),
    ]);

    const attemptRow = attemptResult.results[0] as AttemptRow | undefined;
    if (!attemptRow) return { status: "missing" };
    if (attemptRow.response_addresses !== null) {
      return {
        status: "response",
        addresses: JSON.parse(attemptRow.response_addresses) as string[],
      };
    }
    const sessionRow = sessionResult.results[0] as SessionRow | undefined;
    if (!sessionRow) return { status: "missing" };
    return { status: "fallback", addresses: toSession(sessionRow).addresses };
  }

  async cancelConnect(realmId: string, nonce: string, attemptId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM connect_attempts WHERE realm_id = ? AND nonce = ? AND id = ?")
      .bind(realmId, nonce, attemptId)
      .run();
  }

  async takeEvents(realmId: string, sessionId: string): Promise<StoredEvent[]> {
    const result = await this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM realm_events
         WHERE realm_id = ? AND session_id = ?
         ORDER BY sequence ASC`,
      )
      .bind(realmId, sessionId)
      .all<EventRow>();
    return result.results.map(toEvent);
  }

  async deleteEvents(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.batch(
      ids.map((id) => this.db.prepare("DELETE FROM realm_events WHERE id = ?").bind(id)),
    );
  }

  async claimEvents(
    realmId: string,
    sessionId: string,
    streamId: string,
  ): Promise<ClaimEventsResult> {
    const now = Date.now();
    const [ownerResult, deleteResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT 1 AS owned
           FROM event_streams AS stream
           INNER JOIN realm_sessions AS session
             ON session.realm_id = stream.realm_id AND session.id = stream.session_id
           WHERE stream.realm_id = ? AND stream.session_id = ? AND stream.stream_id = ?
             AND session.expires_at > ?`,
        )
        .bind(realmId, sessionId, streamId, now),
      this.db
        .prepare(
          `DELETE FROM realm_events
           WHERE sequence IN (
             SELECT sequence FROM realm_events
             WHERE realm_id = ? AND session_id = ?
             ORDER BY sequence ASC
             LIMIT ?
           )
           AND EXISTS (
             SELECT 1
             FROM event_streams AS stream
             INNER JOIN realm_sessions AS session
               ON session.realm_id = stream.realm_id AND session.id = stream.session_id
             WHERE stream.realm_id = ? AND stream.session_id = ? AND stream.stream_id = ?
               AND session.expires_at > ?
           )
           RETURNING sequence, ${EVENT_COLUMNS}`,
        )
        .bind(
          realmId,
          sessionId,
          EVENTS_BUFFER_SIZE,
          realmId,
          sessionId,
          streamId,
          now,
        ),
    ]);
    if (ownerResult.results.length === 0) return { status: "not_owner" };
    const rows = deleteResult.results as ClaimedEventRow[];
    rows.sort((left, right) => left.sequence - right.sequence);
    return { status: "ok", events: rows.map(toEvent) };
  }

  async claimEvent(
    realmId: string,
    sessionId: string,
    streamId: string,
    eventId: string,
  ): Promise<ClaimEventResult> {
    const now = Date.now();
    const [ownerResult, deleteResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT 1 AS owned
           FROM event_streams AS stream
           INNER JOIN realm_sessions AS session
             ON session.realm_id = stream.realm_id AND session.id = stream.session_id
           WHERE stream.realm_id = ? AND stream.session_id = ? AND stream.stream_id = ?
             AND session.expires_at > ?`,
        )
        .bind(realmId, sessionId, streamId, now),
      this.db
        .prepare(
          `DELETE FROM realm_events
           WHERE realm_id = ? AND session_id = ? AND id = ?
             AND EXISTS (
               SELECT 1
               FROM event_streams AS stream
               INNER JOIN realm_sessions AS session
                 ON session.realm_id = stream.realm_id AND session.id = stream.session_id
               WHERE stream.realm_id = ? AND stream.session_id = ? AND stream.stream_id = ?
                 AND session.expires_at > ?
             )
           RETURNING ${EVENT_COLUMNS}`,
        )
        .bind(realmId, sessionId, eventId, realmId, sessionId, streamId, now),
    ]);
    if (ownerResult.results.length === 0) return { status: "not_owner" };
    const row = deleteResult.results[0] as EventRow | undefined;
    return { status: "ok", event: row ? toEvent(row) : null };
  }

  async metrics(): Promise<MetricsResult> {
    const now = Date.now();
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM realm_sessions WHERE expires_at > ?) AS realms,
           (SELECT COUNT(*) FROM connect_attempts WHERE expires_at > ?) AS attempts,
           (
             SELECT COUNT(*)
             FROM event_streams AS stream
             INNER JOIN realm_sessions AS session
               ON session.realm_id = stream.realm_id AND session.id = stream.session_id
             WHERE session.expires_at > ?
           ) AS streams`,
      )
      .bind(now, now, now)
      .first<MetricsRow>();
    return {
      realms: Number(row?.realms ?? 0),
      attempts: Number(row?.attempts ?? 0),
      streams: Number(row?.streams ?? 0),
    };
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    const [attemptsResult, sessionsResult, eventsResult, streamsResult] = await this.db.batch([
      this.db
        .prepare("DELETE FROM connect_attempts WHERE expires_at <= ?")
        .bind(now - CONNECT_ATTEMPT_CLEANUP_GRACE_MS),
      this.db.prepare("DELETE FROM realm_sessions WHERE expires_at <= ?").bind(now),
      this.db.prepare(
        `DELETE FROM realm_events
         WHERE NOT EXISTS (
           SELECT 1 FROM realm_sessions
           WHERE realm_sessions.realm_id = realm_events.realm_id
             AND realm_sessions.id = realm_events.session_id
         )`,
      ),
      this.db.prepare(
        `DELETE FROM event_streams
         WHERE NOT EXISTS (
           SELECT 1 FROM realm_sessions
           WHERE realm_sessions.realm_id = event_streams.realm_id
             AND realm_sessions.id = event_streams.session_id
         )`,
      ),
    ]);
    return attemptsResult.meta.changes + sessionsResult.meta.changes + eventsResult.meta.changes +
      streamsResult.meta.changes;
  }
}

function toSession(row: SessionRow): StoredSession {
  return {
    realmId: row.realm_id,
    id: row.id,
    addresses: JSON.parse(row.addresses) as string[],
    expiresAt: row.expires_at,
  };
}

function toAttempt(row: AttemptRow): StoredAttempt {
  return {
    realmId: row.realm_id,
    nonce: row.nonce,
    id: row.id,
    sessionId: row.session_id,
    responseAddresses: row.response_addresses === null
      ? null
      : JSON.parse(row.response_addresses) as string[],
    expiresAt: row.expires_at,
  };
}

function toEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    realmId: row.realm_id,
    sessionId: row.session_id,
    name: row.name,
    data: JSON.parse(row.data) as unknown,
    createdAt: row.created_at,
  };
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
