const ABLY_REST_BASE = "https://main.realtime.ably.net";
const ABLY_SSE_URL = `${ABLY_REST_BASE}/sse`;

export interface AblyMessage {
  id: string;
  name: string;
  data: unknown;
}

export interface AblySubscribeOptions {
  signal?: AbortSignal;
  lastEventId?: string;
}

export class AblyError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AblyError";
    this.status = status;
  }
}

export class AblyClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async publish(channel: string, name: string, data: unknown, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(
      `${ABLY_REST_BASE}/channels/${encodeURIComponent(channel)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: this.authorization(),
          "Content-Type": "application/json",
          "X-Ably-Version": "1.2",
        },
        body: JSON.stringify({ name, data: JSON.stringify(data) }),
        signal,
      },
    );
    if (!response.ok) {
      throw new AblyError(`Ably publish failed with status ${response.status}`, response.status);
    }
  }

  async subscribe(channel: string, options: AblySubscribeOptions = {}): Promise<Response> {
    const url = new URL(ABLY_SSE_URL);
    url.searchParams.set("channels", channel);
    url.searchParams.set("v", "1.2");
    if (options.lastEventId !== undefined) {
      url.searchParams.set("lastEvent", options.lastEventId);
    }

    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: this.authorization(),
      },
      signal: options.signal,
    });
    if (!response.ok) {
      throw new AblyError(`Ably subscribe failed with status ${response.status}`, response.status);
    }
    if (!response.body) {
      throw new AblyError("Ably subscribe response has no body", response.status);
    }
    return response;
  }

  private authorization(): string {
    return `Basic ${btoa(this.apiKey)}`;
  }
}

type SseFrame = {
  id?: string;
  type: string;
  data: string;
};

export async function* readAblyMessages(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<AblyMessage, void> {
  if (!response.body) {
    throw new AblyError("Ably response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let buffer = "";
  let eventId: string | undefined;
  let eventType = "";
  let dataLines: string[] = [];
  let streamEnded = false;

  try {
    if (signal?.aborted) {
      onAbort();
    }

    while (!streamEnded) {
      const result = await reader.read();
      streamEnded = result.done;
      buffer += streamEnded ? decoder.decode() : decoder.decode(result.value, { stream: true });

      while (true) {
        const resultLine = takeSseLine(buffer, streamEnded);
        if (!resultLine) {
          break;
        }
        buffer = resultLine.rest;
        const line = resultLine.line;

        if (line === "") {
          const frame: SseFrame = {
            id: eventId,
            type: eventType || "message",
            data: dataLines.join("\n"),
          };
          const hasData = dataLines.length > 0;
          eventId = undefined;
          eventType = "";
          dataLines = [];

          if (frame.type === "error") {
            throw new AblyError(frame.data ? `Ably SSE error: ${frame.data}` : "Ably SSE error");
          }
          if (frame.type === "message" && hasData) {
            yield decodeAblyMessage(frame);
          }
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }

        switch (field) {
          case "data":
            dataLines.push(value);
            break;
          case "event":
            eventType = value;
            break;
          case "id":
            if (!value.includes("\0")) {
              eventId = value;
            }
            break;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // Preserve a parsing or stream error from the body of the generator.
    }
    reader.releaseLock();
  }
}

export function sessionChannel(realmId: string, sessionId: string): string {
  return makeChannel("session", realmId, sessionId);
}

export function attemptChannel(realmId: string, sessionId: string, attemptId: string): string {
  return makeChannel("attempt", realmId, sessionId, attemptId);
}

export function encodeSseEvent(name: string, data: unknown, id?: string): string {
  assertSseField("event name", name);
  if (id !== undefined) {
    assertSseField("event id", id);
  }
  const json = JSON.stringify(data) ?? "null";
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${name}\ndata: ${json}\n\n`;
}

function takeSseLine(buffer: string, final: boolean): { line: string; rest: string } | null {
  let end = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === "\n" || buffer[index] === "\r") {
      end = index;
      break;
    }
  }

  if (end < 0) {
    if (!final || buffer.length === 0) {
      return null;
    }
    return { line: buffer, rest: "" };
  }
  if (buffer[end] === "\r" && end + 1 === buffer.length && !final) {
    return null;
  }

  const delimiterLength = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
  return {
    line: buffer.slice(0, end),
    rest: buffer.slice(end + delimiterLength),
  };
}

function decodeAblyMessage(frame: SseFrame): AblyMessage {
  let value: unknown;
  try {
    value = JSON.parse(frame.data);
  } catch {
    throw new AblyError("Ably message envelope is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AblyError("Ably message envelope is not an object");
  }

  const envelope = value as Record<string, unknown>;
  const encoding = typeof envelope.encoding === "string" ? envelope.encoding : "";
  let data = envelope.data;
  if (typeof data === "string") {
    if (encoding.toLowerCase().includes("json")) {
      try {
        data = JSON.parse(data);
      } catch {
        throw new AblyError("Ably message data is not valid JSON");
      }
    } else if (encoding === "") {
      // Messages published by AblyClient are JSON strings without an encoding field.
      try {
        data = JSON.parse(data);
      } catch {
        // Plain strings from other publishers remain unchanged.
      }
    }
  }

  return {
    // Ably resumes SSE with the stream frame id, not the enclosed message id.
    id: frame.id || (typeof envelope.id === "string" ? envelope.id : ""),
    name: typeof envelope.name === "string" ? envelope.name : "",
    data,
  };
}

function makeChannel(kind: "session" | "attempt", ...parts: string[]): string {
  return ["hysteria", kind, ...parts.map(encodeChannelPart)].join(":");
}

function encodeChannelPart(value: string): string {
  if (!value) throw new TypeError("channel components may not be empty");
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function assertSseField(label: string, value: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new TypeError(`${label} may not contain newlines`);
  }
}
