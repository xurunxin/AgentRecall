// src/mcp/auth.ts
//
// Request-layer authentication for the shared HTTP
// MCP daemon.
//
// The spec (.superpowers/specs
// /2026-08-06-mcp-process-lifecycle-and-shared-http-design.md,
// "共享安全") pins the contract:
//
//   - HTTP daemon accepts only loopback callers
//     (`allowedHosts` whitelist) and trusted
//     browser origins (`allowedOrigins` whitelist),
//     matching the MCP SDK's DNS-rebinding
//     protection shape.
//   - Bearer token is the only credential. It
//     lives in the lockfile (`daemon-lock.ts`),
//     generated as 32 raw bytes -> 64 hex chars.
//   - `/mcp` is the only enforced path prefix.
//     Other paths (Task 8/9 will route `/healthz`
//     and friends) skip auth at this layer so
//     liveness probes and similar can return
//     without a token.
//   - Failure modes: missing / mismatched token
//     -> 401; host or origin not in the
//     whitelist -> 403. The spec is explicit that
//     these failures MUST NOT be logged:
//     "Host/Origin 不在白名单 → 403 + 不写日志
//     (防止侧信道)". This module therefore
//     contains zero `console.*` /
//     `process.stderr.write` calls. The caller
//     (Task 9's HTTP route handler) is
//     responsible for translating the thrown
//     `HttpError` into a response; the route
//     layer's logging policy is its own concern.
//
// Order of checks matters: the path prefix is
// evaluated FIRST so non-`/mcp` paths return
// without touching host / token / origin state
// (the brief's `enforcePathPrefix` defaults to
// `/mcp` when omitted). Host is checked before
// the token so a misconfigured client on an
// unallowed host doesn't burn a token-validation
// attempt. Origin is checked LAST and is
// skipped when the request omits the header
// (non-browser clients legitimately have no
// `Origin`); the spec's intent is "browser
// callers must come from a known origin",
// not "every caller must send an origin".
//
// Edge cases handled:
//   - `headers.host` / `headers.authorization` /
//     `headers.origin` are typed
//     `string | string[] | undefined`. Each
//     accessor helper normalises array values to
//     the first element so the comparator sees
//     a single string.
//   - `Authorization` is parsed as
//     `/^Bearer\s+(.+)$/`. Lowercase `bearer`,
//     extra whitespace, and an empty token all
//     return `undefined` and trip the 401 path.
//     A multi-word `Authorization` value would
//     not match the regex, which is intentional:
//     the MCP spec mandates a single bearer
//     token per request.
//   - `req.url` may be `undefined` for the
//     malformed-request edge case (HTTP parser
//     guarantees it on `/mcp` traffic, but the
//     optional chain keeps the type checker
//     honest). When `url` is missing the
//     `startsWith` check evaluates false and the
//     function returns without erroring — the
//     route layer's own 400 path picks up the
//     malformed request.
//
// This module owns NO state beyond the
// stateless helpers. The caller is responsible
// for deriving `expectedToken` from the
// lockfile and constructing `allowedHosts` /
// `allowedOrigins` (Task 9's route layer does
// this once per process and reuses the
// constants across requests).
//
// Zero new dependencies: Node stdlib types only.

import type { IncomingMessage } from "node:http";

/**
 * Thrown by `validateRequest` on every auth failure
 * path. Carries the HTTP status the caller should
 * write back to the client (401 for credential
 * issues, 403 for host/origin whitelist misses)
 * and a stable machine-readable `reason` code
 * the caller can log on its OWN terms — this
 * module intentionally does NOT log on the
 * failure path.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string
  ) {
    super(`HTTP ${status} ${reason}`);
  }
}

export interface ValidateOptions {
  req: IncomingMessage;
  /**
   * The Bearer token the request must present.
   * In production this is the 32-byte / 64-hex-char
   * value from the lockfile payload.
   */
  expectedToken: string;
  /**
   * Whitelist of accepted `Host` header values
   * (with port, e.g. `"127.0.0.1:7777"`). DNS
   * rebinding protection: a request whose `Host`
   * is missing or not in this list is rejected
   * with 403 before any other check runs.
   */
  allowedHosts: string[];
  /**
   * Whitelist of accepted `Origin` header values.
   * Only consulted when the request actually
   * carries an `Origin` (browsers do, non-browser
   * clients may not). A missing `Origin` is NOT
   * a 403 — it is treated as "non-browser,
   * whitelist doesn't apply".
   */
  allowedOrigins: string[];
  /**
   * Path prefix that triggers auth enforcement.
   * Defaults to `"/mcp"`. Requests whose `url`
   * does not start with this prefix return
   * without an auth check so liveness probes and
   * future non-MCP routes can opt out.
   */
  enforcePathPrefix?: string;
}

function authHeader(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  return Array.isArray(h) ? h[0] : h;
}

function hostHeader(req: IncomingMessage): string | undefined {
  const h = req.headers["host"];
  return Array.isArray(h) ? h[0] : h;
}

function originHeader(req: IncomingMessage): string | undefined {
  const o = req.headers["origin"];
  if (o === undefined) return undefined;
  return Array.isArray(o) ? o[0] : o;
}

function tokenFromBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^Bearer\s+(.+)$/.exec(value);
  return m?.[1];
}

/**
 * Validate a single incoming request against the
 * configured host/origin whitelist and the
 * expected Bearer token. Throws `HttpError` on
 * the first failure encountered. Order of
 * checks: path prefix -> host -> token ->
 * origin. The path prefix check short-circuits
 * the rest of the function so non-`/mcp` paths
 * are returned as-is (no 401, no 403, no log).
 *
 * The function is intentionally synchronous
 * (no I/O, no allocation beyond a single regex
 * match) so the route layer can call it on
 * every request without overhead.
 */
export function validateRequest(opts: ValidateOptions): void {
  const { req, expectedToken, allowedHosts, allowedOrigins } = opts;
  const prefix = opts.enforcePathPrefix ?? "/mcp";
  if (!req.url?.startsWith(prefix)) return;
  const host = hostHeader(req);
  if (!host || !allowedHosts.includes(host)) {
    throw new HttpError(403, "forbidden_host");
  }
  const token = tokenFromBearer(authHeader(req));
  if (!token || token !== expectedToken) {
    throw new HttpError(401, "unauthorized");
  }
  const origin = originHeader(req);
  if (origin !== undefined && !allowedOrigins.includes(origin)) {
    throw new HttpError(403, "forbidden_origin");
  }
}
