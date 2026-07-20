// src/text-similarity.ts
//
// Pure token-set Jaccard similarity. Used by budget-governor and
// findDuplicateGroups to surface near-duplicate memories that the
// exact-match path would miss. No external dependencies.

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "in", "is", "it", "its", "of", "on", "or", "that",
  "the", "this", "to", "was", "were", "will", "with"
]);

export function tokenizeForSimilarity(text: string): Set<string> {
  const out = new Set<string>();
  const lowered = text.toLowerCase();
  // Split on any non-letter/digit/underscore run. Keeps CJK characters
  // (which are individual code points, not word-broken by spaces).
  const tokens = lowered.split(/[^\p{L}\p{N}_]+/u);
  for (const t of tokens) {
    if (t.length === 0) continue;
    if (STOP_WORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const token of a) if (b.has(token)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export function textSimilarity(a: string, b: string): number {
  return jaccard(tokenizeForSimilarity(a), tokenizeForSimilarity(b));
}

export const SIMILARITY_THRESHOLD = 0.7;
