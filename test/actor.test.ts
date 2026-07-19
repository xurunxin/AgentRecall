import { describe, expect, it } from "vitest";
import {
  ACTOR_KINDS,
  CLI_ACTOR,
  DEFAULT_ACTOR,
  RECOMMENDED_ACTOR_NAMES,
  isRecommendedActor,
  parseActor,
  resolveActor
} from "../src/actor.js";

describe("resolveActor", () => {
  it("returns the explicit override when provided", () => {
    expect(resolveActor("agent:claude-code", {})).toBe("agent:claude-code");
    expect(resolveActor("user:cli", {})).toBe("user:cli");
  });

  it("falls back to AGENT_RECALL_ACTOR env when override is missing", () => {
    expect(resolveActor(undefined, { AGENT_RECALL_ACTOR: "agent:codex" })).toBe("agent:codex");
  });

  it("falls back to agent:unknown when neither override nor env is set", () => {
    expect(resolveActor(undefined, {})).toBe(DEFAULT_ACTOR);
  });

  it("treats whitespace as empty", () => {
    expect(resolveActor("   ", {})).toBe(DEFAULT_ACTOR);
    expect(resolveActor(undefined, { AGENT_RECALL_ACTOR: "  " })).toBe(DEFAULT_ACTOR);
  });

  it("preserves legacy bare values", () => {
    expect(resolveActor("agent", {})).toBe("agent");
    expect(resolveActor("user", {})).toBe("user");
    expect(resolveActor("system", {})).toBe("system");
  });

  it("passes through unknown free-form strings", () => {
    expect(resolveActor("agent:custom-thing", {})).toBe("agent:custom-thing");
    expect(resolveActor("tool:ide", {})).toBe("tool:ide");
  });
});

describe("parseActor", () => {
  it("parses legacy values into themselves", () => {
    expect(parseActor("agent")).toEqual({ raw: "agent", kind: "agent", name: "agent" });
    expect(parseActor("system")).toEqual({ raw: "system", kind: "system", name: "system" });
  });

  it("parses structured values", () => {
    expect(parseActor("agent:claude-code")).toEqual({
      raw: "agent:claude-code",
      kind: "agent",
      name: "claude-code"
    });
    expect(parseActor("system:expiry")).toEqual({
      raw: "system:expiry",
      kind: "system",
      name: "expiry"
    });
  });

  it("falls back to system kind for malformed values", () => {
    expect(parseActor("nocolon")).toEqual({ raw: "nocolon", kind: "system", name: "nocolon" });
    expect(parseActor("tool:custom")).toEqual({ raw: "tool:custom", kind: "system", name: "custom" });
  });
});

describe("isRecommendedActor", () => {
  it("accepts each recommended name", () => {
    expect(isRecommendedActor("agent:claude-code")).toBe(true);
    expect(isRecommendedActor("user:cli")).toBe(true);
    expect(isRecommendedActor("system:expiry")).toBe(true);
  });

  it("rejects unknown names", () => {
    expect(isRecommendedActor("agent:mystery")).toBe(false);
    expect(isRecommendedActor("user:random")).toBe(false);
  });
});

describe("RECOMMENDED_ACTOR_NAMES", () => {
  it("covers all actor kinds", () => {
    for (const kind of ACTOR_KINDS) {
      expect(RECOMMENDED_ACTOR_NAMES[kind].length).toBeGreaterThan(0);
    }
  });
});

describe("CLI_ACTOR", () => {
  it("is a user-kind actor", () => {
    expect(parseActor(CLI_ACTOR).kind).toBe("user");
  });
});
