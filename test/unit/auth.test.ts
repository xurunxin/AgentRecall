// test/unit/auth.test.ts
import { describe, expect, it } from "vitest";
import { validateRequest, HttpError } from "../../src/mcp/auth.js";

function req(opts: Partial<{ host: string; origin: string | undefined; authorization: string | undefined; url: string }>) {
  return {
    headers: {
      host: opts.host ?? "127.0.0.1:7777",
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {})
    },
    url: opts.url ?? "/mcp"
  } as unknown as import("node:http").IncomingMessage;
}

describe("validateRequest", () => {
  it("accepts token + allowed host", () => {
    expect(() => validateRequest({
      req: req({ authorization: "Bearer abc", host: "127.0.0.1:7777" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: []
    })).not.toThrow();
  });

  it("rejects missing token with 401", () => {
    expect(() => validateRequest({
      req: req({ host: "127.0.0.1:7777" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: []
    })).toThrow(HttpError);
    try {
      validateRequest({ req: req({ host: "127.0.0.1:7777" }), expectedToken: "abc", allowedHosts: ["127.0.0.1:7777"], allowedOrigins: [] });
    } catch (e) {
      expect((e as HttpError).status).toBe(401);
    }
  });

  it("rejects disallowed host with 403", () => {
    expect(() => validateRequest({
      req: req({ authorization: "Bearer abc", host: "evil.example" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: []
    })).toThrow(HttpError);
  });

  it("rejects mismatched origin when present", () => {
    expect(() => validateRequest({
      req: req({ authorization: "Bearer abc", host: "127.0.0.1:7777", origin: "http://evil.example" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: ["http://localhost:7777"]
    })).toThrow(HttpError);
  });

  it("skips auth outside /mcp path", () => {
    expect(() => validateRequest({
      req: req({ url: "/healthz" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: [],
      enforcePathPrefix: "/mcp"
    })).not.toThrow();
  });
});
