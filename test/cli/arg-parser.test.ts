import { describe, expect, it } from "vitest";
import { flagBool, flagString, parseArgs } from "../../src/cli/arg-parser.js";

describe("parseArgs", () => {
  it("returns help command for empty input", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("parses --flag as boolean", () => {
    const result = parseArgs(["list", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  it("parses --key=value", () => {
    const result = parseArgs(["list", "--scope=project"]);
    expect(result.flags.scope).toBe("project");
  });

  it("parses --key value when next arg is not a flag", () => {
    const result = parseArgs(["list", "--scope", "project"]);
    expect(result.flags.scope).toBe("project");
  });

  it("parses --key with no value when next arg is a flag", () => {
    const result = parseArgs(["list", "--scope", "--json"]);
    expect(result.flags.scope).toBe(true);
    expect(result.flags.json).toBe(true);
  });

  it("maps -h to --help", () => {
    const result = parseArgs(["-h"]);
    expect(result.flags.help).toBe(true);
  });

  it("treats everything after -- as positional", () => {
    const result = parseArgs(["search", "query", "--", "--weird", "-x"]);
    expect(result.positional).toEqual(["query", "--weird", "-x"]);
  });

  it("captures positional arguments", () => {
    const result = parseArgs(["show", "mem_abc"]);
    expect(result.command).toBe("show");
    expect(result.positional).toEqual(["mem_abc"]);
  });
});

describe("flagString / flagBool", () => {
  it("returns fallback for missing key", () => {
    const args = parseArgs(["list"]);
    expect(flagString(args, "scope")).toBeUndefined();
    expect(flagString(args, "scope", "global")).toBe("global");
  });

  it("returns the value when present", () => {
    const args = parseArgs(["list", "--scope", "project"]);
    expect(flagString(args, "scope")).toBe("project");
  });

  it("returns undefined for boolean flags when expected string", () => {
    const args = parseArgs(["list", "--json"]);
    expect(flagString(args, "json")).toBeUndefined();
    expect(flagBool(args, "json")).toBe(true);
  });
});
