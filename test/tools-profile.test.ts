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
  EXTENDED_TOOL_NAMES,
  memoryToolNames
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
    //
    // Bidirectional members-of comparison against
    // the real `memoryToolNames` registry: a
    // profile-side tool that is not in the
    // registry surfaces as an "extra tool" failure
    // here, and a registry-side tool that is not
    // in either profile surfaces as a "missing
    // tool" failure here.
    const registry = new Set<string>(memoryToolNames);
    const union = new Set<string>([...CORE_TOOL_NAMES, ...EXTENDED_TOOL_NAMES]);
    // Every tool in the union must be in the
    // registry (no profile-side extras).
    for (const name of union) {
      expect(registry.has(name), `profile union has tool ${name} not in memoryToolNames`).toBe(true);
    }
    // Every tool in the registry must be in the
    // union (no registry-side gap).
    for (const name of registry) {
      expect(
        union.has(name),
        `memoryToolNames has tool ${name} not in CORE_TOOL_NAMES or EXTENDED_TOOL_NAMES`
      ).toBe(true);
    }
    // The union has exactly the registry size.
    expect(union.size).toBe(registry.size);
  });
});

describe("resolveActiveProfile rejects non-string env values (Task 3 follow-up)", () => {
  it("throws when AGENT_RECALL_PROFILE is null", () => {
    expect(() =>
      resolveActiveProfile({ AGENT_RECALL_PROFILE: null as unknown as string })
    ).toThrowError(/AGENT_RECALL_PROFILE/);
  });

  it("throws when AGENT_RECALL_PROFILE is a number", () => {
    expect(() =>
      resolveActiveProfile({ AGENT_RECALL_PROFILE: 1 as unknown as string })
    ).toThrowError(/AGENT_RECALL_PROFILE/);
  });

  it("throws when AGENT_RECALL_PROFILE is an object", () => {
    expect(() =>
      resolveActiveProfile({ AGENT_RECALL_PROFILE: { foo: "bar" } as unknown as string })
    ).toThrowError(/AGENT_RECALL_PROFILE/);
  });

  it("throws when AGENT_RECALL_PROFILE is an array", () => {
    expect(() =>
      resolveActiveProfile({ AGENT_RECALL_PROFILE: ["extended"] as unknown as string })
    ).toThrowError(/AGENT_RECALL_PROFILE/);
  });

  it("error message names AGENT_RECALL_PROFILE and the supported values", () => {
    // The follow-up brief requires the error
    // message to include the env var name and
    // the supported value list so an operator
    // can recover without reading the docs.
    try {
      resolveActiveProfile({ AGENT_RECALL_PROFILE: null as unknown as string });
      throw new Error("expected resolveActiveProfile to throw");
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      const msg = (error as Error).message;
      expect(msg).toMatch(/AGENT_RECALL_PROFILE/);
      expect(msg).toMatch(/core/);
      expect(msg).toMatch(/extended/);
    }
  });

  it("still falls back to core when AGENT_RECALL_PROFILE is the empty string", () => {
    // The empty string is documented Core
    // fallback (operator unset the var); the
    // selector must NOT throw on the empty
    // string but still return `core`. The
    // TypeScript signature accepts
    // `string | undefined`, so a string-only
    // input preserves the documented fallback
    // contract while non-string inputs are
    // rejected above.
    expect(resolveActiveProfile({ AGENT_RECALL_PROFILE: "" })).toBe("core");
  });
});
