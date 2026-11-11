import { describe, expect, it, vi } from "vitest";
import {
  AblyClient,
  AblyError,
  attemptChannel,
  encodeSseEvent,
  readAblyMessages,
  sessionChannel,
  type AblyMessage,
} from "../src/ably";

const API_KEY = "key-id:secret";

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function responseFromBytes(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }));
}

function splitEvery(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

async function collect(response: Response): Promise<AblyMessage[]> {
  const messages: AblyMessage[] = [];
  for await (const message of readAblyMessages(response)) {
    messages.push(message);
  }
  return messages;
}

describe("AblyClient", () => {
  it("publishes to the encoded channel with basic auth and a JSON body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    const client = new AblyClient(API_KEY, fetchMock);
    const data = { addresses: ["203.0.113.1:443"] };

    await client.publish("hysteria:session:realm:session", "punch", data);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe(
      "https://main.realtime.ably.net/channels/hysteria%3Asession%3Arealm%3Asession/messages",
    );
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Basic ${btoa(API_KEY)}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Ably-Version")).toBe("1.2");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "punch", data: JSON.stringify(data) });
  });

  it("throws an AblyError with status for a failed publish", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const client = new AblyClient(API_KEY, fetchMock);

    await expect(client.publish("channel", "event", null)).rejects.toMatchObject({
      name: "AblyError",
      status: 403,
    });
  });

  it("subscribes without exposing the key in the URL and forwards resume state", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const client = new AblyClient(API_KEY, fetchMock);
    const controller = new AbortController();

    const response = await client.subscribe("hysteria:session:realm:session", {
      signal: controller.signal,
      lastEventId: "event 1",
    });

    expect(response.body).not.toBeNull();
    const [input, init] = fetchMock.mock.calls[0];
    const url = requestUrl(input);
    expect(url.origin).toBe("https://main.realtime.ably.net");
    expect(url.pathname).toBe("/sse");
    expect(url.searchParams.get("channels")).toBe("hysteria:session:realm:session");
    expect(url.searchParams.get("v")).toBe("1.2");
    expect(url.searchParams.get("lastEvent")).toBe("event 1");
    expect(url.toString()).not.toContain(API_KEY);
    expect(url.toString()).not.toContain(encodeURIComponent(API_KEY));
    expect(init?.method).toBe("GET");
    expect(init?.signal).toBe(controller.signal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Basic ${btoa(API_KEY)}`);
    expect(headers.get("Accept")).toBe("text/event-stream");
  });

  it("rejects unsuccessful subscriptions and successful responses without bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new AblyClient(API_KEY, fetchMock);

    await expect(client.subscribe("channel")).rejects.toMatchObject({
      name: "AblyError",
      status: 401,
    });
    await expect(client.subscribe("channel")).rejects.toMatchObject({
      name: "AblyError",
      status: 204,
    });
  });
});

describe("readAblyMessages", () => {
  it("parses CRLF, split chunks, multiline data, UTF-8, and keepalives", async () => {
    const payload = ":keepalive\r\n\r\n" +
      "id: event-1\r\n" +
      "event: message\r\n" +
      "data: {\"id\":\"ably-1\",\"name\":\"greeting\",\"data\":\r\n" +
      "data: {\"text\":\"你好\"}}\r\n\r\n";
    const response = responseFromBytes(splitEvery(new TextEncoder().encode(payload), 5));

    await expect(collect(response)).resolves.toEqual([
      { id: "event-1", name: "greeting", data: { text: "你好" } },
    ]);
  });

  it("decodes encoding=json and JSON strings published by AblyClient", async () => {
    const payload = "event: message\n" +
      "data: {\"id\":\"1\",\"name\":\"remote\",\"encoding\":\"json\",\"data\":\"{\\\"foo\\\":1}\"}\n\n" +
      "event: message\n" +
      "data: {\"id\":\"2\",\"name\":\"local\",\"data\":\"{\\\"bar\\\":2}\"}\n\n";
    const response = responseFromBytes([new TextEncoder().encode(payload)]);

    await expect(collect(response)).resolves.toEqual([
      { id: "1", name: "remote", data: { foo: 1 } },
      { id: "2", name: "local", data: { bar: 2 } },
    ]);
  });

  it("throws AblyError for an error frame and cancels the reader", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "event: error\ndata: {\"message\":\"upstream failed\"}\n\n",
        ));
      },
      cancel,
    });

    await expect(collect(new Response(stream))).rejects.toBeInstanceOf(AblyError);
    await expect(collect(new Response("event: error\ndata: boom\n\n"))).rejects.toThrow(/boom/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("channel and SSE encoding", () => {
  it("builds namespaced channels from conservative components", () => {
    expect(sessionChannel("realm_1", "session-2")).toBe("hysteria:session:cmVhbG1fMQ:c2Vzc2lvbi0y");
    expect(attemptChannel("realm_1", "session-2", "nonce3")).toBe(
      "hysteria:attempt:cmVhbG1fMQ:c2Vzc2lvbi0y:bm9uY2Uz",
    );
    expect(sessionChannel("realm.example/一", "session-2")).toMatch(
      /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/,
    );
    expect(() => sessionChannel("", "session")).toThrow(TypeError);
  });

  it("encodes external SSE events without allowing newline injection", () => {
    expect(encodeSseEvent("punch", { text: "one\ntwo" }, "event-1")).toBe(
      "id: event-1\nevent: punch\ndata: {\"text\":\"one\\ntwo\"}\n\n",
    );
    expect(encodeSseEvent("ack", { ok: true })).toBe(
      "event: ack\ndata: {\"ok\":true}\n\n",
    );
    expect(() => encodeSseEvent("punch\ndata: injected", {})).toThrow(TypeError);
    expect(() => encodeSseEvent("punch", {}, "id\r\ndata: injected")).toThrow(TypeError);
  });
});
