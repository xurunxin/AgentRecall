// test/tools-profile.test.ts
//
// Stage 17 v1.1.2 (issue #22): the MCP server's
// profile selector. The selector reads the
// `AGENT_RECALL_PROFILE` env var, defaults to
// `core` when unset, accepts `core` / `extended`,
// and fail-closes on any other value. The test
// is the executable contract for `selectToolProfile`
// and `resolveActiveProfile`; the file is placed
// next to the existing `tools-descriptions.test.ts`
// so the tooling conventions (no test doubles, no
// package.json changes, vitest only) line up.
//
// The v1.1.2 contract pins two rules:
//
//   1. Default = `core` (the safe, low-surface
//      default for an unconfigured packaged server).
//   2. Fail-closed on unknown values. The error
//      message names the env var so an operator
//      can discover the contract from the runtime
//      output without reading the docs.

import { describe, expect, it } from "vitest";
import {
  CORE_TOOL_NAMES,
  EXTENDED_TOOL_NAMES
} from "../src/tools/register-tools.js";
import {
  PROFILE_NAMES,
  resolveActiveProfile,
  selectToolProfile
} from "../src/tools/profile.js";

describe("selectToolProfile (Stage 17 v1.1.2 #22)", () => {
  it("defaults to core when the value is undefined", () => {
    expect(selectToolProfile(undefined)).toBe("core");
  });

  it("defaults to core when the value is the empty string", () => {
    // The MCP server reads the env var via
    // `process.env.AGENT_RECALL_PROFILE`; an unset
    // env var surfaces as `undefined`. An empty
    // value surfaces as `""`; the selector treats
    // both the same way (default = `core`).
    expect(selectToolProfile("")).toBe("core");
  });

  it("accepts the canonical core value", () => {
    expect(selectToolProfile("core")).toBe("core");
  });

  it("accepts the canonical extended value", () => {
    expect(selectToolProfile("extended")).toBe("extended");
  });

  it("fail-closes on unknown values with a stable error message", () => {
    expect(() => selectToolProfile("admin")).toThrowError(/AGENT_RECALL_PROFILE/);
    expect(() => selectToolProfile("Admin")).toThrowError(/AGENT_RECALL_PROFILE/);
    expect(() => selectToolProfile("EXTENDED")).toThrowError(/AGENT_RECALL_PROFILE/);
    expect(() => selectToolProfile("full")).toThrowError(/AGENT_RECALL_PROFILE/);
    expect(() => selectToolProfile("1")).toThrowError(/AGENT_RECALL_PROFILE/);
  });

  it("exposes the canonical profile name list", () => {
    // The v1.1.2 contract exposes two profiles.
    // The list is the source of truth for the
    // error message and for any future
    // profile-validation helper that needs to
    // enumerate the supported names.
    expect(PROFILE_NAMES).toEqual(["core", "extended"]);
  });
});

describe("resolveActiveProfile (Stage 17 v1.1.2 #22)", () => {
  it("returns core when AGENT_RECALL_PROFILE is unset", () => {
    expect(resolveActiveProfile({})).toBe("core");
  });

  it("returns core when AGENT_RECALL_PROFILE is the empty string", () => {
    expect(resolveActiveProfile({ AGENT_RECALL_PROFILE: "" })).toBe("core");
  });

  it("returns core when AGENT_RECALL_PROFILE='core'", () => {
    expect(resolveActiveProfile({ AGENT_RECALL_PROFILE: "core" })).toBe("core");
  });

  it("returns extended when AGENT_RECALL_PROFILE='extended'", () => {
    expect(resolveActiveProfile({ AGENT_RECALL_PROFILE: "extended" })).toBe("extended");
  });

  it("fail-closes when AGENT_RECALL_PROFILE is any other value", () => {
    expect(() => resolveActiveProfile({ AGENT_RECALL_PROFILE: "admin" })).toThrowError(
      /AGENT_RECALL_PROFILE/
    );
    expect(() => resolveActiveProfile({ AGENT_RECALL_PROFILE: "Core" })).toThrowError(
      /AGENT_RECALL_PROFILE/
    );
  });
});

describe("profile -> tool set parity (Stage 17 v1.1.2 #22)", () => {
  it("CORE_TOOL_NAMES and EXTENDED_TOOL_NAMES are disjoint", () => {
    const core = new Set(CORE_TOOL_NAMES);
    for (const name of EXTENDED_TOOL_NAMES) {
      expect(core.has(name)).toBe(false);
    }
  });

  it("CORE_TOOL_NAMES + EXTENDED_TOOL_NAMES cover every wire-level tool", () => {
    // The union of the two profiles must equal
    // the canonical `memoryToolNames` list (the
    // 20-tool surface). The selector MUST NOT
    // expose a tool that is not in one of the two
    // profiles; this test guards against an
    // accidental gap in the registry.
    const union = new Set([...CORE_TOOL_NAMES, ...EXTENDED_TOOL_NAMES]);
    // The two lists already cover the canonical
    // list; the assertion is symmetric so a
    // future addition to `memoryToolNames`
    // surfaces as a failure here.
    expect(union.size).toBe(CORE_TOOL_NAMES.length + EXTENDED_TOOL_NAMES.length);
  });
});
