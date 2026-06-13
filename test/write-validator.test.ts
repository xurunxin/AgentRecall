import { describe, expect, it } from "vitest";
import { detectSecrets } from "../src/secret-detector.js";
import { validateRememberInput, validateUpdateInput } from "../src/write-validator.js";

describe("secret detector", () => {
  it("detects private keys, bearer tokens, env secrets, and high entropy tokens", () => {
    expect(detectSecrets("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toMatchObject([
      { category: "private_key", field: "body" }
    ]);
    expect(detectSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890")).toMatchObject([
      { category: "bearer_token", field: "body" }
    ]);
    expect(detectSecrets("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890")).toMatchObject([
      { category: "env_secret", field: "body" }
    ]);
    expect(detectSecrets("token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toMatchObject([
      { category: "high_entropy_token", field: "body" }
    ]);
  });

  it("does not return raw secret values", () => {
    const findings = detectSecrets("API_TOKEN=secret-value-that-should-not-return");
    expect(JSON.stringify(findings)).not.toContain("secret-value-that-should-not-return");
  });
});

describe("remember input validation", () => {
  const validInput = {
    scope: "global",
    type: "debugging",
    topic: "tests",
    title: "Vitest uses node environment",
    body: "Use vitest config with environment set to node for filesystem tests.",
    tags: ["vitest", "node"],
    source: { kind: "agent", ref: "planning" },
    importance: 4,
    confidence: 5
  };

  it("accepts a complete global memory write", () => {
    const result = validateRememberInput(validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("active");
      expect(result.value.supersedes).toEqual([]);
      expect(result.value.char_count).toBeGreaterThan(0);
    }
  });

  it("rejects missing project identity for project scope", () => {
    const result = validateRememberInput({ ...validInput, scope: "project" });
    expect(result).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
  });

  it("rejects invalid importance and confidence", () => {
    expect(validateRememberInput({ ...validInput, importance: 6 })).toMatchObject({ ok: false, error: "invalid_schema" });
    expect(validateRememberInput({ ...validInput, confidence: 0 })).toMatchObject({ ok: false, error: "invalid_schema" });
  });

  it("rejects secret text before storage", () => {
    const result = validateRememberInput({
      ...validInput,
      body: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890"
    });
    expect(result).toMatchObject({
      ok: false,
      error: "secret_detected"
    });
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  });
});

describe("update validation", () => {
  it("allows only mutable fields", () => {
    const result = validateUpdateInput({
      title: "Updated title",
      importance: 3,
      status: "archived"
    });
    expect(result.ok).toBe(true);
  });

  it("rejects status values outside active and archived", () => {
    expect(validateUpdateInput({ status: "forgotten" })).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
  });

  it("rejects immutable fields", () => {
    expect(validateUpdateInput({ type: "debugging" })).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
    expect(validateUpdateInput({ source: { kind: "agent" } })).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
    expect(validateUpdateInput({ supersedes: ["mem_123"] })).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
  });
});
