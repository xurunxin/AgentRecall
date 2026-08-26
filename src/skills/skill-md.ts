// src/skills/skill-md.ts
//
// v1.2.0-alpha.2 (issue #53): the canonical
// SKILL.md parser / formatter. The byte-stable
// contract:
//
//   parseSkillMd(input) -> ParsedSkill
//   formatSkillMd(parsed) -> string (canonical bytes)
//
// Round-trip property:
//   parseSkillMd(formatSkillMd(x)) is observationally
//   identical to x for any x in canonical form
//   (same frontmatter keys in the same sorted order,
//   same body bytes apart from trailing-whitespace /
//   line-ending normalisation).
//
// Canonicalisation rules applied by `formatSkillMd`:
//   1. Line endings: LF (CRLF and CR are both
//      collapsed to LF).
//   2. Frontmatter keys: sorted alphabetically
//      (case-sensitive, byte-wise). Values are
//      kept verbatim apart from rule 4.
//   3. Empty consecutive lines: collapsed to a
//      single blank line.
//   4. Trailing whitespace: stripped on every line.
//   5. The body section is preserved verbatim apart
//      from the line-ending / trailing-whitespace
//      normalisation.
//   6. Unknown frontmatter keys are kept under the
//      `extension.<name>` namespace and round-tripped.
//
// The parser is intentionally YAML-free: the
// v1 SKILL.md frontmatter is a small, well-defined
// subset of YAML (scalar / list / inline map), and
// hand-rolling the parser avoids a runtime
// dependency for what is otherwise a 200-line file.
// The parser accepts only the subset documented in
// the contract; anything outside the subset is
// rejected with a typed error so the caller can
// surface it as `[skill_invalid]` on the CLI or
// wire.

import { createHash } from "node:crypto";

/**
 * The structured shape produced by `parseSkillMd`
 * and consumed by `formatSkillMd`. Keys are typed
 * as a stable superset: callers that do not need
 * the optional fields can ignore them.
 */
export type SkillFrontmatter = {
  name: string;
  description: string;
  schema_version: "1";
  category?: string;
  triggers?: string[];
  when_to_use?: string;
  when_not_to_use?: string;
  compatibility?: Record<string, unknown>;
  source?: "manual" | "derived" | "imported";
  resources?: Array<{
    path: string;
    type: "text" | "reference";
    media_type: string;
    sha256: string;
  }>;
  /**
   * Namespaced bag for keys the v1 contract does
   * not know about. The round-trip is:
   *  - `foo: bar` in the source becomes
   *    `extension.foo: bar` in the parsed
   *    frontmatter (the parser namespaces every
   *    unknown top-level key).
   *  - `extension.foo: bar` in the source is
   *    kept as `extension.foo: bar` (a literal
   *    `extension.` prefix is left as-is so a
   *    caller can pre-namespace a key).
   *
   * The Service layer does not consume the
   * namespace; the on-disk `skills` table does
   * not store it as a typed column (it is
   * preserved through `skill_md_canonical`).
   */
  extension?: Record<string, unknown>;
};

export type ParsedSkill = {
  frontmatter: SkillFrontmatter;
  body_md: string;
};

/**
 * Stable error code emitted on a parse failure.
 * The CLI surfaces this as `[skill_invalid]`.
 */
export type SkillParseErrorCode =
  | "missing_frontmatter"
  | "unterminated_frontmatter"
  | "empty_frontmatter"
  | "invalid_frontmatter"
  | "missing_name"
  | "missing_description"
  | "missing_schema_version"
  | "invalid_name"
  | "invalid_schema_version"
  | "invalid_source"
  | "invalid_resource_type"
  | "duplicate_key";

export class SkillParseError extends Error {
  readonly code: SkillParseErrorCode;
  constructor(code: SkillParseErrorCode, message: string) {
    super(message);
    this.name = "SkillParseError";
    this.code = code;
  }
}

// ── parser ─────────────────────────────────────────────────────

const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;

function normaliseLineEndings(input: string): string {
  // CR -> LF first, then CRLF -> LF.
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripTrailingWhitespace(line: string): string {
  return line.replace(/\s+$/, "");
}

function splitTopLevelFrontmatter(input: string): { yaml: string; body: string } {
  // The SKILL.md shape is a single `---` line,
  // a YAML frontmatter block, a closing `---` line,
  // and the Markdown body. We accept the variant
  // where the opening line is the FIRST line of the
  // file; if the frontmatter is missing, we
  // raise `missing_frontmatter`.
  if (!input.startsWith("---")) {
    throw new SkillParseError(
      "missing_frontmatter",
      "SKILL.md must start with a `---` line that opens the frontmatter block"
    );
  }
  const afterOpen = input.slice(3);
  // The opening `---` may be followed by a newline
  // (and only a newline). Reject if the file
  // contains `---abc` (no boundary).
  if (afterOpen.length > 0 && afterOpen[0] !== "\n") {
    throw new SkillParseError(
      "missing_frontmatter",
      "SKILL.md must start with a `---` line that opens the frontmatter block"
    );
  }
  const bodyStart = afterOpen.indexOf("\n---");
  if (bodyStart < 0) {
    throw new SkillParseError(
      "unterminated_frontmatter",
      "SKILL.md frontmatter is not terminated by a closing `---` line"
    );
  }
  const yaml = afterOpen.slice(1, bodyStart);
  // Skip the `---` and the single newline that
  // follows it; if the body is empty, return "".
  const afterClose = afterOpen.slice(bodyStart + 4);
  // Strip leading + trailing newlines so the
  // round-trip `parse(format(parse(x)))` is
  // byte-stable: the body shape the parser
  // surfaces never has a leading or trailing
  // newline, and the formatter is the only
  // authority on adding the canonical single
  // blank line between `---` and the body and
  // the document terminator.
  let body = afterClose;
  if (body.startsWith("\n")) body = body.slice(1);
  while (body.endsWith("\n")) {
    body = body.slice(0, -1);
  }
  return { yaml, body };
}

function parseScalar(raw: string): string {
  // A v1 scalar is either a plain string, a
  // single-quoted string, or a double-quoted
  // string. Plain strings are stripped of
  // surrounding whitespace; quoted strings keep
  // their interior verbatim (with the standard
  // escape sequences for double-quoted YAML).
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    const interior = trimmed.slice(1, -1);
    return interior
      .replace(/\\\\/g, "\u0000")
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\u0000/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    // Single-quoted YAML is "double the single
    // quote to escape". No other escape sequences.
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseListItem(raw: string): string {
  // `- foo` or `- "foo bar"` or `- 'foo bar'`.
  if (!raw.startsWith("-")) {
    throw new SkillParseError(
      "invalid_frontmatter",
      `expected list item to start with '-', got: ${raw}`
    );
  }
  const tail = raw.slice(1);
  if (tail.length === 0 || tail[0] !== " ") {
    throw new SkillParseError(
      "invalid_frontmatter",
      `list item must have a space after '-': ${raw}`
    );
  }
  return parseScalar(tail.slice(1));
}

function parseList(raw: string): string[] {
  // A list is one or more `- value` lines at the
  // same indentation. The caller has already
  // stripped the leading `key:` and the value
  // continuation lines arrive here verbatim.
  return raw
    .split("\n")
    .map((line) => stripTrailingWhitespace(line))
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/^ {2}/, ""))
    .map(parseListItem);
}

function parseInlineMap(raw: string): Record<string, unknown> {
  // `{ key: value, key2: "value 2" }` with no
  // nested structure (the v1 contract does not
  // use nested maps in `compatibility`).
  const trimmed = raw.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    throw new SkillParseError(
      "invalid_frontmatter",
      `expected inline map to be wrapped in { ... }, got: ${raw}`
    );
  }
  const interior = trimmed.slice(1, -1).trim();
  if (interior.length === 0) return {};
  const out: Record<string, unknown> = {};
  // Split on commas at the top level (the
  // contract forbids nested braces, so a plain
  // split is safe).
  for (const part of splitTopLevelCommas(interior)) {
    const colonAt = part.indexOf(":");
    if (colonAt < 0) {
      throw new SkillParseError(
        "invalid_frontmatter",
        `inline map entry must contain a ':' separator: ${part}`
      );
    }
    const key = part.slice(0, colonAt).trim();
    const valueRaw = part.slice(colonAt + 1);
    out[key] = parseScalar(valueRaw);
  }
  return out;
}

function parseBlockMap(raw: string): Record<string, unknown> {
  // A block-form map is a sequence of
  // 2-space-indented `key: value` lines (no
  // leading dash, no flow braces). The v1
  // contract uses block form for
  // `compatibility`; the values are scalar
  // strings.
  const out: Record<string, unknown> = {};
  const lines = raw
    .split("\n")
    .map(stripTrailingWhitespace)
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    // Each line is `  key: value`. Strip the
    // 2-space indent and parse the colon
    // separator.
    if (!line.startsWith("  ")) {
      throw new SkillParseError(
        "invalid_frontmatter",
        `block map entry must be indented by 2 spaces: ${line}`
      );
    }
    const body = line.slice(2);
    const colonAt = body.indexOf(":");
    if (colonAt < 0) {
      throw new SkillParseError(
        "invalid_frontmatter",
        `block map entry must contain a ':' separator: ${line}`
      );
    }
    const key = body.slice(0, colonAt).trim();
    const valueRaw = body.slice(colonAt + 1);
    out[key] = parseScalar(valueRaw);
  }
  return out;
}

function splitTopLevelCommas(input: string): string[] {
  // No nested braces in v1; the contract for
  // `compatibility` is a flat map of string keys
  // to scalar values. A plain `split(",")` is
  // therefore safe (a v2 with nested maps would
  // need a real parser here).
  return input.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

type RawFrontmatter = {
  raw: Map<string, string>;
  listKeys: Set<string>;
  mapKeys: Set<string>;
};

function indexFrontmatter(yaml: string): RawFrontmatter {
  const lines = yaml.split("\n").map(stripTrailingWhitespace);
  const raw = new Map<string, string>();
  const listKeys = new Set<string>();
  const mapKeys = new Set<string>();
  let currentKey: string | null = null;
  let currentKind: "scalar" | "list" | "map" | null = null;
  let currentValue: string[] = [];

  const flush = (): void => {
    if (currentKey === null) return;
    const joined = currentValue.join("\n");
    raw.set(currentKey, joined);
    if (currentKind === "list") listKeys.add(currentKey);
    if (currentKind === "map") mapKeys.add(currentKey);
  };

  for (const line of lines) {
    if (line.trim().length === 0) {
      if (currentKey !== null) currentValue.push("");
      continue;
    }
    // A list continuation line is `  - value`.
    // A map continuation line is `  key: value`.
    // Both are indented by exactly 2 spaces.
    if (
      currentKey !== null &&
      (line.startsWith("  -") || /^\s+[A-Za-z_]/.test(line))
    ) {
      currentValue.push(line);
      continue;
    }
    // A new top-level key: `key: value` or `key:`.
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/);
    if (m === null) {
      throw new SkillParseError(
        "invalid_frontmatter",
        `expected a 'key: value' line, got: ${line}`
      );
    }
    flush();
    const key = m[1]!;
    const rest = m[2] ?? "";
    currentKey = key;
    currentValue = [];
    if (rest.length === 0) {
      // The kind is decided by the FIRST
      // continuation line. Default to scalar
      // (treat empty value as the empty string).
      currentKind = "scalar";
    } else if (rest.startsWith("[")) {
      // Flow-style list. The v1 contract uses
      // block style exclusively; we reject the
      // flow form so the surface stays narrow.
      throw new SkillParseError(
        "invalid_frontmatter",
        `flow-style list '[...]' is not supported (use block style with '- value' lines): ${line}`
      );
    } else if (rest.startsWith("{")) {
      currentKind = "map";
      currentValue.push(rest);
    } else {
      currentKind = "scalar";
      currentValue.push(rest);
    }
  }
  flush();

  // Determine the list / map kind by peeking at
  // the value when the first line was empty:
  for (const key of raw.keys()) {
    if (listKeys.has(key) || mapKeys.has(key)) continue;
    const value = raw.get(key) ?? "";
    const firstCont = value.split("\n").find((l) => l.trim().length > 0) ?? "";
    if (/^ {2}- /.test(firstCont)) {
      listKeys.add(key);
    } else if (/^ {2}[A-Za-z_]/.test(firstCont)) {
      mapKeys.add(key);
    }
  }

  return { raw, listKeys, mapKeys };
}

function parseFrontmatter(
  yaml: string
): SkillFrontmatter {
  if (yaml.trim().length === 0) {
    throw new SkillParseError(
      "empty_frontmatter",
      "SKILL.md frontmatter is empty; `name`, `description`, and `schema_version` are required"
    );
  }
  const { raw, listKeys, mapKeys } = indexFrontmatter(yaml);

  for (const key of raw.keys()) {
    const lowercase = key.toLowerCase();
    if (lowercase !== key) {
      throw new SkillParseError(
        "invalid_frontmatter",
        `frontmatter key '${key}' must be lowercase (the v1 contract is case-sensitive)`
      );
    }
  }

  if (raw.has("name") && listKeys.has("name")) {
    throw new SkillParseError(
      "invalid_frontmatter",
      "`name` must be a scalar string"
    );
  }
  if (raw.has("description") && listKeys.has("description")) {
    throw new SkillParseError(
      "invalid_frontmatter",
      "`description` must be a scalar string"
    );
  }
  if (raw.has("schema_version") && listKeys.has("schema_version")) {
    throw new SkillParseError(
      "invalid_frontmatter",
      "`schema_version` must be a scalar string"
    );
  }
  if (raw.has("source") && listKeys.has("source")) {
    throw new SkillParseError(
      "invalid_frontmatter",
      "`source` must be a scalar enum"
    );
  }

  const name = raw.has("name") ? parseScalar(raw.get("name")!) : undefined;
  if (name === undefined) {
    throw new SkillParseError(
      "missing_name",
      "SKILL.md frontmatter is missing the required `name` key"
    );
  }
  if (!KEBAB_CASE_RE.test(name)) {
    throw new SkillParseError(
      "invalid_name",
      `\`name\` must match /^[a-z][a-z0-9-]*$/ (kebab-case), got: ${name}`
    );
  }

  const description = raw.has("description")
    ? parseScalar(raw.get("description")!)
    : undefined;
  if (description === undefined) {
    throw new SkillParseError(
      "missing_description",
      "SKILL.md frontmatter is missing the required `description` key"
    );
  }

  const schemaVersion = raw.has("schema_version")
    ? parseScalar(raw.get("schema_version")!)
    : undefined;
  if (schemaVersion === undefined) {
    throw new SkillParseError(
      "missing_schema_version",
      "SKILL.md frontmatter is missing the required `schema_version` key"
    );
  }
  if (schemaVersion !== "1") {
    throw new SkillParseError(
      "invalid_schema_version",
      `\`schema_version\` must be the literal "1" (the only supported value in v1.2-alpha.2), got: ${schemaVersion}`
    );
  }

  const out: SkillFrontmatter = {
    name,
    description,
    schema_version: "1"
  };

  if (raw.has("category") && !listKeys.has("category")) {
    out.category = parseScalar(raw.get("category")!);
  }

  if (raw.has("triggers")) {
    if (!listKeys.has("triggers")) {
      throw new SkillParseError(
        "invalid_frontmatter",
        "`triggers` must be a list of scalar strings"
      );
    }
    out.triggers = parseList(raw.get("triggers")!);
  } else {
    out.triggers = [];
  }

  if (raw.has("when_to_use") && !listKeys.has("when_to_use")) {
    out.when_to_use = parseScalar(raw.get("when_to_use")!);
  }
  if (raw.has("when_not_to_use") && !listKeys.has("when_not_to_use")) {
    out.when_not_to_use = parseScalar(raw.get("when_not_to_use")!);
  }

  if (raw.has("compatibility")) {
    if (!mapKeys.has("compatibility")) {
      throw new SkillParseError(
        "invalid_frontmatter",
        "`compatibility` must be an inline or block map of string keys to scalar values"
      );
    }
    // The block detector in `indexFrontmatter`
    // tags the key as `mapKeys` regardless of
    // form; we pick the parser here based on
    // whether the value starts with `{` (inline)
    // or with a 2-space indent (block).
    const rawValue = raw.get("compatibility")!;
    if (rawValue.trimStart().startsWith("{")) {
      out.compatibility = parseInlineMap(rawValue);
    } else {
      out.compatibility = parseBlockMap(rawValue);
    }
  } else {
    out.compatibility = {};
  }

  if (raw.has("source")) {
    const value = parseScalar(raw.get("source")!);
    if (value !== "manual" && value !== "derived" && value !== "imported") {
      throw new SkillParseError(
        "invalid_source",
        `\`source\` must be one of 'manual' | 'derived' | 'imported', got: ${value}`
      );
    }
    out.source = value;
  }

  if (raw.has("resources")) {
    if (!listKeys.has("resources")) {
      throw new SkillParseError(
        "invalid_frontmatter",
        "`resources` must be a list of inline maps"
      );
    }
    out.resources = parseResources(raw.get("resources")!);
  }

  // Namespaced extension keys: anything else in
  // the frontmatter survives under the
  // `extension` map (the in-memory shape uses
  // un-prefixed keys; the formatter is
  // responsible for adding the `extension.`
  // prefix on write). A literal `extension.foo`
  // in the source maps to `extension["foo"]`
  // (the prefix is stripped on read so the
  // round-trip is byte-stable); a literal
  // `extension.extension.foo` in the source
  // maps to `extension["extension.foo"]`
  // (double-prefix preserved).
  const extension: Record<string, unknown> = {};
  for (const key of raw.keys()) {
    if (isKnownKey(key)) continue;
    if (key.startsWith("extension.")) {
      const inner = key.slice("extension.".length);
      extension[inner] = parseScalarOrListOrMap(
        raw.get(key)!,
        listKeys.has(key),
        mapKeys.has(key)
      );
    } else {
      extension[key] = parseScalarOrListOrMap(
        raw.get(key)!,
        listKeys.has(key),
        mapKeys.has(key)
      );
    }
  }
  if (Object.keys(extension).length > 0) {
    out.extension = extension;
  }

  return out;
}

function isKnownKey(key: string): boolean {
  return (
    key === "name" ||
    key === "description" ||
    key === "schema_version" ||
    key === "category" ||
    key === "triggers" ||
    key === "when_to_use" ||
    key === "when_not_to_use" ||
    key === "compatibility" ||
    key === "source" ||
    key === "resources"
  );
}

function parseScalarOrListOrMap(
  raw: string,
  isList: boolean,
  isMap: boolean
): unknown {
  if (isList) return parseList(raw);
  if (isMap) return parseInlineMap(raw);
  return parseScalar(raw);
}

function parseResources(
  raw: string
): Array<{ path: string; type: "text" | "reference"; media_type: string; sha256: string }> {
  // Each list item is `- { path: ..., type: ..., media_type: ..., sha256: ... }`
  // across one or more continuation lines. The
  // v1 contract uses the inline-map form on a
  // single `- ` line, so the implementation is
  // permissive of either: a single inline line OR
  // a multi-line entry where each field is on its
  // own line at 4-space indent.
  const lines = raw
    .split("\n")
    .map(stripTrailingWhitespace)
    .filter((line) => line.trim().length > 0);
  const out: Array<{
    path: string;
    type: "text" | "reference";
    media_type: string;
    sha256: string;
  }> = [];

  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join(" ").trim();
    if (joined.startsWith("-")) {
      const afterDash = joined.startsWith("- ") ? joined.slice(2) : joined.slice(1);
      const parsed = parseInlineMap(afterDash);
      const path = typeof parsed["path"] === "string" ? (parsed["path"] as string) : "";
      const type = typeof parsed["type"] === "string" ? (parsed["type"] as string) : "";
      const mediaType =
        typeof parsed["media_type"] === "string" ? (parsed["media_type"] as string) : "";
      const sha256 = typeof parsed["sha256"] === "string" ? (parsed["sha256"] as string) : "";
      if (path.length === 0) {
        throw new SkillParseError(
          "invalid_frontmatter",
          "resource is missing required `path`"
        );
      }
      if (type !== "text" && type !== "reference") {
        throw new SkillParseError(
          "invalid_resource_type",
          `resource type must be 'text' | 'reference', got: ${type}`
        );
      }
      if (mediaType.length === 0) {
        throw new SkillParseError(
          "invalid_frontmatter",
          `resource '${path}' is missing required \`media_type\``
        );
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(sha256)) {
        throw new SkillParseError(
          "invalid_frontmatter",
          `resource '${path}' has a non-canonical \`sha256\` value (expected 'sha256:' + 64 hex digits)`
        );
      }
      out.push({
        path,
        type,
        media_type: mediaType,
        sha256
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("  -")) {
      flush();
      buffer.push(line);
    } else if (buffer.length > 0) {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Parse a SKILL.md string into its structured
 * shape. Throws `SkillParseError` on any v1
 * contract violation; the caller is responsible
 * for translating the typed error code to a
 * user-facing message.
 */
export function parseSkillMd(input: string): ParsedSkill {
  const normalised = normaliseLineEndings(input);
  const { yaml, body } = splitTopLevelFrontmatter(normalised);
  const frontmatter = parseFrontmatter(yaml);
  return {
    frontmatter,
    body_md: body
  };
}

// ── formatter ──────────────────────────────────────────────────

function collapseBlankLines(text: string): string {
  // Three or more consecutive newlines collapse
  // to two (a single blank line between content
  // blocks). The frontmatter is single-line so
  // this only affects the body section, but the
  // formatter applies it to the whole output for
  // predictability.
  return text.replace(/\n{3,}/g, "\n\n");
}

function escapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  // Quote when the value contains a YAML-significant
  // character or starts with a quote / list marker.
  if (/[:#{}\[\],&*!|>'"%@`\n\t]/.test(value)) return true;
  if (value.startsWith("- ") || value.startsWith("--")) return true;
  if (value !== value.trim()) return true;
  if (/^(true|false|null|~)$/i.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  return false;
}

function formatScalar(value: string): string {
  if (!needsQuoting(value)) return value;
  return `"${escapeDoubleQuoted(value)}"`;
}

function formatList(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    out.push(`  - ${formatScalar(v)}`);
  }
  return out;
}

function formatMap(map: Record<string, unknown>): string[] {
  const keys = Object.keys(map).sort();
  const out: string[] = [];
  for (const k of keys) {
    const v = map[k];
    if (typeof v === "string") {
      out.push(`  ${k}: ${formatScalar(v)}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.push(`  ${k}: ${String(v)}`);
    } else {
      // Non-scalar values are serialised as JSON
      // in a double-quoted YAML scalar. This is
      // the v1 escape hatch for
      // extension.<name> fields that need a
      // structured value.
      out.push(`  ${k}: ${formatScalar(JSON.stringify(v))}`);
    }
  }
  return out;
}

function formatResources(
  resources: Array<{ path: string; type: "text" | "reference"; media_type: string; sha256: string }>
): string[] {
  const out: string[] = [];
  for (const r of resources) {
    out.push(`  - { path: ${formatScalar(r.path)}, type: ${r.type}, media_type: ${formatScalar(r.media_type)}, sha256: ${r.sha256} }`);
  }
  return out;
}

type FormatValue =
  | { kind: "scalar"; value: string }
  | { kind: "list"; values: string[] }
  | { kind: "map"; map: Record<string, unknown> }
  | { kind: "resources"; values: Array<{ path: string; type: "text" | "reference"; media_type: string; sha256: string }> };

function formatFrontmatter(frontmatter: SkillFrontmatter): string {
  // Build a `(sourceKey, FormatValue)` list and
  // sort the lot alphabetically. The round-trip
  // property requires that every key appear in
  // the same sorted order on every write; the
  // contract also requires alphabetical key
  // ordering, so the v1 known keys (name,
  // description, schema_version, ...) are
  // sorted alongside the extension keys.
  type Entry = { sourceKey: string; value: FormatValue };
  const entries: Entry[] = [];
  const push = (sourceKey: string, value: FormatValue): void => {
    entries.push({ sourceKey, value });
  };

  push("name", { kind: "scalar", value: frontmatter.name });
  push("description", { kind: "scalar", value: frontmatter.description });
  push("schema_version", { kind: "scalar", value: frontmatter.schema_version });
  if (frontmatter.category !== undefined) {
    push("category", { kind: "scalar", value: frontmatter.category });
  }
  if (frontmatter.triggers !== undefined && frontmatter.triggers.length > 0) {
    push("triggers", { kind: "list", values: frontmatter.triggers });
  }
  if (frontmatter.when_to_use !== undefined) {
    push("when_to_use", { kind: "scalar", value: frontmatter.when_to_use });
  }
  if (frontmatter.when_not_to_use !== undefined) {
    push("when_not_to_use", { kind: "scalar", value: frontmatter.when_not_to_use });
  }
  if (
    frontmatter.compatibility !== undefined &&
    Object.keys(frontmatter.compatibility).length > 0
  ) {
    push("compatibility", { kind: "map", map: frontmatter.compatibility });
  }
  if (frontmatter.source !== undefined) {
    push("source", { kind: "scalar", value: frontmatter.source });
  }
  if (frontmatter.resources !== undefined && frontmatter.resources.length > 0) {
    push("resources", { kind: "resources", values: frontmatter.resources });
  }

  // Extension keys: the in-memory shape stores
  // the un-prefixed key (the parser strips the
  // `extension.` prefix on read); the formatter
  // re-adds it on write so the source matches
  // the v1 namespacing contract. A literal
  // `extension.foo` in the parsed `extension`
  // map (i.e. a user-supplied double-namespaced
  // key) becomes `extension.extension.foo` in
  // the source.
  const extension = frontmatter.extension ?? {};
  for (const k of Object.keys(extension).sort()) {
    const sourceKey = k.startsWith("extension.")
      ? `extension.${k}`
      : `extension.${k}`;
    const value = extension[k];
    if (Array.isArray(value)) {
      push(sourceKey, { kind: "list", values: value as string[] });
    } else if (value !== null && typeof value === "object") {
      push(sourceKey, { kind: "map", map: value as Record<string, unknown> });
    } else if (typeof value === "string") {
      push(sourceKey, { kind: "scalar", value });
    } else if (value === undefined) {
      continue;
    } else {
      push(sourceKey, { kind: "scalar", value: String(value) });
    }
  }

  entries.sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));

  const lines: string[] = [];
  for (const { sourceKey, value } of entries) {
    switch (value.kind) {
      case "scalar":
        lines.push(`${sourceKey}: ${formatScalar(value.value)}`);
        break;
      case "list":
        if (value.values.length === 0) {
          lines.push(`${sourceKey}: []`);
        } else {
          lines.push(`${sourceKey}:`);
          lines.push(...formatList(value.values));
        }
        break;
      case "map": {
        const mapKeys = Object.keys(value.map);
        if (mapKeys.length === 0) {
          lines.push(`${sourceKey}: {}`);
        } else {
          lines.push(`${sourceKey}:`);
          lines.push(...formatMap(value.map));
        }
        break;
      }
      case "resources": {
        if (value.values.length === 0) {
          lines.push(`${sourceKey}: []`);
        } else {
          lines.push(`${sourceKey}:`);
          lines.push(...formatResources(value.values));
        }
        break;
      }
    }
  }
  return lines.join("\n");
}

/**
 * Format a parsed SKILL.md into the canonical
 * byte-stable string. The output is the value
 * the store records in `skills.skill_md_canonical`
 * and what the CLI `export` verb writes to disk.
 */
export function formatSkillMd(parsed: ParsedSkill): string {
  const yaml = formatFrontmatter(parsed.frontmatter);
  const body = collapseBlankLines(
    parsed.body_md
      .split("\n")
      .map(stripTrailingWhitespace)
      .join("\n")
  );
  // The body must be joined to the closing
  // `---` line with exactly one blank line
  // between them. If the body itself already
  // starts with a leading blank line, we must
  // NOT add another (otherwise we get 2 blank
  // lines, which is the byte-stable bug the
  // `collapseBlankLines` test catches). If the
  // body is empty, the closing `---` is followed
  // by exactly one newline (the document
  // terminator) and nothing else.
  if (body.length === 0) {
    return `---\n${yaml}\n---\n`;
  }
  const needsLeadingBlank = !body.startsWith("\n");
  const bodyWithBlank = needsLeadingBlank ? `\n${body}` : body;
  // Always end the document with a single
  // trailing newline.
  const trailing = bodyWithBlank.endsWith("\n") ? "" : "\n";
  return `---\n${yaml}\n---\n${bodyWithBlank}${trailing}`;
}

/**
 * Convenience: hash the canonical SKILL.md bytes
 * with SHA-256 and return `sha256:hex64`. This
 * is the value the store writes to
 * `skills.body_hash` and `asset_versions.content_hash`.
 */
export function canonicalSkillHash(parsed: ParsedSkill): string {
  const canonical = formatSkillMd(parsed);
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}
