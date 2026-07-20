import { describe, expect, it } from "vitest";
import { jaccard, textSimilarity, tokenizeForSimilarity } from "../src/text-similarity.js";

describe("tokenizeForSimilarity", () => {
  it("lowercases and folds whitespace", () => {
    expect(tokenizeForSimilarity("  Foo  BAR  baz ")).toEqual(new Set(["foo", "bar", "baz"]));
  });
  it("strips basic punctuation", () => {
    expect(tokenizeForSimilarity("hello, world!")).toEqual(new Set(["hello", "world"]));
  });
  it("drops a built-in stop-word set", () => {
    expect(tokenizeForSimilarity("this is a test of the thing"))
      .toEqual(new Set(["test", "thing"]));
  });
  it("returns an empty set for stop-word-only input", () => {
    expect(tokenizeForSimilarity("the a an of in")).toEqual(new Set());
  });
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  it("returns 0 when both inputs are empty", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  it("computes |intersect| / |union|", () => {
    // a={x,y,z}, b={y,z,w}; |I|=2, |U|=4, jaccard=0.5
    expect(jaccard(new Set(["x", "y", "z"]), new Set(["y", "z", "w"]))).toBe(0.5);
  });
});

describe("textSimilarity (end-to-end)", () => {
  it("catches a moderate rephrasing above the 0.7 threshold", () => {
    // rephrased version adds 1 extra content token
    const s = textSimilarity("project uses postgres", "this project uses postgres");
    expect(s).toBeGreaterThanOrEqual(0.7);
  });
  it("catches a body-extension rephrasing", () => {
    // shared: project, uses, postgres; union: + "for", "api"
    const s = textSimilarity("project uses postgres", "project uses postgres for api");
    expect(s).toBeGreaterThanOrEqual(0.7);
  });
  it("does not flag unrelated memories", () => {
    const s = textSimilarity("project uses postgres", "user prefers tabs");
    expect(s).toBeLessThan(0.2);
  });
  it("does not catch completely-different phrasings with one shared token", () => {
    // known limitation of pure token Jaccard — only 1/4 tokens overlap.
    // documented as out-of-scope for stage 3 (would need embeddings).
    const s = textSimilarity("project uses postgres", "db is postgres");
    expect(s).toBeLessThan(0.5);
  });
  it("returns 1 for two identical strings", () => {
    expect(textSimilarity("hello world", "hello world")).toBe(1);
  });
  it("returns 0 for two empty strings", () => {
    expect(textSimilarity("", "")).toBe(0);
  });
});
