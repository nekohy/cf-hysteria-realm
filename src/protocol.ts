const MAX_REQUEST_BODY_BYTES = 4 << 10;
const MAX_ADDRESSES = 8;
const NONCE_HEX_LENGTH = 32;
const OBFS_HEX_LENGTH = 64;
export const DEFAULT_REALM_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";

export type Route =
  | { kind: "register" | "deregister" | "events" | "heartbeat" | "connect"; realmId: string }
  | { kind: "connectResponse"; realmId: string; nonce: string };

export type RouteResult =
  | Route
  | { kind: "badRequest"; message: string }
  | { kind: "methodNotAllowed"; realmId: string };

export function isValidRealmId(
  realmId: string,
  namePattern = DEFAULT_REALM_NAME_PATTERN,
): boolean {
  return new RegExp(namePattern).test(realmId);
}

export function parseRoute(pathname: string, method: string): RouteResult | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "v1") {
    return null;
  }

  let realmId: string;
  try {
    realmId = decodeURIComponent(parts[1]);
  } catch {
    return { kind: "badRequest", message: "invalid realm name" };
  }

  if (parts.length === 2) {
    if (method === "POST") return { kind: "register", realmId };
    if (method === "DELETE") return { kind: "deregister", realmId };
    return { kind: "methodNotAllowed", realmId };
  }
  if (parts.length === 3) {
    if (parts[2] === "events") {
      return method === "GET" ? { kind: "events", realmId } : { kind: "methodNotAllowed", realmId };
    }
    if (parts[2] === "heartbeat") {
      return method === "POST" ? { kind: "heartbeat", realmId } : { kind: "methodNotAllowed", realmId };
    }
    if (parts[2] === "connect") {
      return method === "POST" ? { kind: "connect", realmId } : { kind: "methodNotAllowed", realmId };
    }
  }
  if (parts.length === 4 && parts[2] === "connects") {
    return method === "POST"
      ? { kind: "connectResponse", realmId, nonce: parts[3] }
      : { kind: "methodNotAllowed", realmId };
  }
  return null;
}

export async function readJson<T>(request: Request, allowEmpty = false): Promise<T | Response> {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    return errorResponse(400, "bad_request", "request body too large");
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_REQUEST_BODY_BYTES) {
    return errorResponse(400, "bad_request", "request body too large");
  }
  if (bytes.byteLength === 0 && allowEmpty) {
    return {} as T;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return errorResponse(400, "bad_request", "invalid json");
  }
}

export function validateAddresses(value: unknown): string[] | string {
  if (!Array.isArray(value) || !value.every((address) => typeof address === "string")) {
    return "at least one address required";
  }
  if (value.length === 0) return "at least one address required";
  if (value.length > MAX_ADDRESSES) return `too many addresses (max ${MAX_ADDRESSES})`;
  for (const address of value) {
    if (!isAddressPort(address)) return `invalid address: ${address}`;
  }
  return [...value];
}

export function validateNonce(value: unknown): string | null {
  return validateHexField("nonce", value, NONCE_HEX_LENGTH);
}

export function validateObfs(value: unknown): string | null {
  return validateHexField("obfs", value, OBFS_HEX_LENGTH);
}

function validateHexField(name: string, value: unknown, length: number): string | null {
  if (typeof value !== "string" || value.length !== length) {
    return `${name} must be ${length} hex characters`;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) return `${name} must be valid hex`;
  return null;
}

function isAddressPort(value: string): boolean {
  let host: string;
  let portText: string;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0 || value[end + 1] !== ":") return false;
    host = value.slice(1, end);
    portText = value.slice(end + 2);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon <= 0 || value.indexOf(":") !== colon) return false;
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }

  if (!/^\d+$/.test(portText)) return false;
  const port = Number(portText);
  return Number.isInteger(port) && port >= 0 && port <= 65535 && (isIPv4(host) || isIPv6(host));
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255 && String(octet) === part;
  });
}

function isIPv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

export function normalizeIpAddress(value: string): string | null {
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const normalized = mapped ?? value;
  if (isIPv4(normalized)) return normalized;
  if (isIPv6(normalized)) {
    return new URL(`http://[${normalized}]/`).hostname.slice(1, -1).toLowerCase();
  }
  return null;
}

export function bearer(request: Request): string {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

export function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: code, message });
}
