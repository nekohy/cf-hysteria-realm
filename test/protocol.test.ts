import { describe, expect, it } from "vitest";
import {
  errorResponse,
  isValidRealmId,
  parseRoute,
  readJson,
  validateAddresses,
  validateNonce,
  validateObfs,
} from "../src/protocol";

const NONCE = "00112233445566778899aabbccddeeff";
const OBFS = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

describe("protocol", () => {
  it("validates realm IDs", () => {
    expect(isValidRealmId("realm-a_1")).toBe(true);
    expect(isValidRealmId("-bad")).toBe(false);
    expect(isValidRealmId("bad realm")).toBe(false);
  });

  it("keeps the existing route contract", () => {
    expect(parseRoute("/v1/example", "POST")).toEqual({ kind: "register", realmId: "example" });
    expect(parseRoute("/v1/example/events", "GET")).toEqual({ kind: "events", realmId: "example" });
    expect(parseRoute(`/v1/example/connects/${NONCE}`, "POST")).toEqual({
      kind: "connectResponse",
      realmId: "example",
      nonce: NONCE,
    });
    expect(parseRoute("/v1/%E0%A4%A", "POST")).toEqual({
      kind: "badRequest",
      message: "invalid realm name",
    });
    expect(parseRoute("/v1/example/events", "POST")).toEqual({
      kind: "methodNotAllowed",
      realmId: "example",
    });
    expect(parseRoute("/unknown", "GET")).toBeNull();
  });

  it("validates addresses and hex fields", () => {
    expect(validateAddresses(["203.0.113.10:4433", "[2001:db8::1]:4433"])).toEqual([
      "203.0.113.10:4433",
      "[2001:db8::1]:4433",
    ]);
    expect(validateAddresses([])).toBe("at least one address required");
    expect(validateAddresses(["example.com:4433"])).toBe("invalid address: example.com:4433");
    expect(validateNonce(NONCE)).toBeNull();
    expect(validateNonce("bad")).toContain("32 hex");
    expect(validateObfs(OBFS)).toBeNull();
  });

  it("reads JSON and preserves error responses", async () => {
    const valid = await readJson<{ value: number }>(new Request("https://realm.test", {
      method: "POST",
      body: JSON.stringify({ value: 1 }),
    }));
    expect(valid).toEqual({ value: 1 });

    const invalid = await readJson(new Request("https://realm.test", { method: "POST", body: "{" }));
    expect(invalid).toBeInstanceOf(Response);
    expect((invalid as Response).status).toBe(400);
    expect(await (invalid as Response).json()).toEqual({ error: "bad_request", message: "invalid json" });

    const error = errorResponse(404, "not_found", "unknown path");
    expect(error.status).toBe(404);
  });
});
