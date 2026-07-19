import { describe, expect, it } from "vitest";
import { memoryToolNames } from "../src/tools/register-tools.js";
import { memoryToolDescriptions } from "../src/tools/descriptions.js";
import type { MemoryToolName } from "../src/tools/schemas.js";

describe("memoryToolDescriptions", () => {
  it("has an entry for every tool", () => {
    for (const name of memoryToolNames) {
      expect(memoryToolDescriptions[name]).toBeDefined();
    }
  });

  it("respects the 400 character total budget per tool", () => {
    for (const name of memoryToolNames) {
      expect(memoryToolDescriptions[name].length, name).toBeLessThanOrEqual(400);
    }
  });

  it("contains all four segments", () => {
    for (const name of memoryToolNames) {
      const text = memoryToolDescriptions[name];
      expect(text).toContain("[TRIGGER]");
      expect(text).toContain("[INPUT]");
      expect(text).toContain("[OUTPUT]");
      expect(text).toContain("[FAILURE]");
    }
  });

  it("keeps each segment under 80 characters", () => {
    for (const name of memoryToolNames) {
      const lines = memoryToolDescriptions[name].split("\n");
      for (const line of lines) {
        const body = line.replace(/^\[[A-Z]+\] /, "");
        expect(body.length, `${name} line: ${line}`).toBeLessThanOrEqual(80);
      }
    }
  });
});
