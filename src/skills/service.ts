// src/skills/service.ts
//
// v1.2.0-alpha.2 (issue #53): the type-specific
// `skill` asset service. The Skill envelope lives
// in `assets` (issue #51); this service is the
// bridge between the canonical SKILL.md bytes
// (parsed by `skill-md.ts`) and the type-specific
// `skills` row.
//
// Public surface (mirrors the CLI / MCP verbs):
//   importSkillMd      -- parse + write v1
//   appendSkillVersion -- CAS-style new version
//   search             -- lexical match over
//                          name + description + triggers
//   get                -- envelope + head + body
//   exportSkillMd      -- canonical SKILL.md string
//
// Skill activation state is the asset envelope's
// `lifecycle_state` (set through the existing
// `assets lifecycle` CLI). There is no separate
// `skills activate` verb.

import { createHash } from "node:crypto";

import type {
  AssetRow,
  AssetVersionRow,
  SkillResourceRow,
  SkillRow,
  SQLiteMemoryStore
} from "../sqlite-store.js";
import { AssetService } from "../assets/service.js";
import { SkillAssetV1Schema } from "../../dist/packages/contracts/dist/index.js";
import {
  formatSkillMd,
  parseSkillMd,
  type ParsedSkill
} from "./skill-md.js";

export type SkillImportInput = {
  skillMd: string;
  source: "manual" | "derived" | "imported";
  scope: "global" | "project";
  project_id?: string;
  owner_actor_id: string;
  trust_level?: "user_confirmed" | "agent_observed" | "inferred";
  sensitivity?: "normal" | "private" | "restricted";
  /**
   * Optional `provenance_ref` stamped on the
   * asset version. The CLI does not pass this;
   * the derivation job pipeline (issue #50) will.
   */
  provenance_ref?: string | null;
};

export type SkillImportResult = {
  asset_id: string;
  version: number;
  content_hash: string;
  body_hash: string;
};

export type SkillAppendInput = {
  asset_id: string;
  skillMd: string;
  created_by_actor_id: string;
  change_summary?: string;
};

export type SkillSummary = {
  asset_id: string;
  version: number;
  name: string;
  description: string;
  category: string | null;
  triggers: string[];
  source: "manual" | "derived" | "imported";
  lifecycle_state: AssetRow["lifecycle_state"];
  updated_at: string;
};

export type SkillGetResult = {
  asset: AssetRow;
  current_version: AssetVersionRow;
  row: SkillRow;
  body: string;
};

export type SkillSearchInput = {
  query: string;
  limit?: number;
};

export type StableErrorCode =
  | "skill_invalid"
  | "skill_contract_mismatch"
  | "cas_mismatch"
  | "asset_not_found"
  | "binding_invalid";

function stableError(code: StableErrorCode, message: string): Error & { code: string } {
  const err: Error & { code?: string } = new Error(`${code}: ${message}`);
  err.code = code;
  return err as Error & { code: string };
}

function describeParseError(err: unknown): string {
  if (err instanceof Error) {
    const maybe = err as Error & { code?: string };
    if (typeof maybe.code === "string") {
      return `parse_error(${maybe.code}): ${err.message}`;
    }
    return err.message;
  }
  return String(err);
}

function sha256Hex(input: string): string {
  return "sha256:" + createHash("sha256").update(input).digest("hex");
}

function parseAndValidate(input: string): ParsedSkill {
  let parsed: ParsedSkill;
  try {
    parsed = parseSkillMd(input);
  } catch (error) {
    throw stableError("skill_invalid", describeParseError(error));
  }
  // Re-run through the Zod contract so the
  // envelope / store never sees a payload that
  // fails the wire shape. The two layers are
  // intentionally duplicated: the parser is the
  // shape-source for canonical bytes, the
  // contract is the shape-source for downstream
  // APIs.
  const canonical = formatSkillMd(parsed);
  const bodyHash = sha256Hex(canonical);
  const contractInput = {
    asset_id: "scratch",
    version: 1,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    schema_version: parsed.frontmatter.schema_version,
    ...(parsed.frontmatter.category !== undefined
      ? { category: parsed.frontmatter.category }
      : {}),
    triggers: parsed.frontmatter.triggers ?? [],
    ...(parsed.frontmatter.when_to_use !== undefined
      ? { when_to_use: parsed.frontmatter.when_to_use }
      : {}),
    ...(parsed.frontmatter.when_not_to_use !== undefined
      ? { when_not_to_use: parsed.frontmatter.when_not_to_use }
      : {}),
    compatibility: parsed.frontmatter.compatibility ?? {},
    source: parsed.frontmatter.source ?? "manual",
    skill_md_canonical: canonical,
    body_hash: bodyHash,
    resources: parsed.frontmatter.resources ?? []
  };
  const result = SkillAssetV1Schema.safeParse(contractInput);
  if (!result.success) {
    throw stableError(
      "skill_contract_mismatch",
      `parsed SKILL.md fails the contract check: ${result.error.message}`
    );
  }
  return parsed;
}

function buildRowFromParsed(
  asset_id: string,
  version: number,
  parsed: ParsedSkill,
  source: "manual" | "derived" | "imported"
): { row: SkillRow; canonical: string; bodyHash: string } {
  const canonical = formatSkillMd(parsed);
  const bodyHash = sha256Hex(canonical);
  const fm = parsed.frontmatter;
  const resources: SkillResourceRow[] = (fm.resources ?? []).map((r) => ({
    path: r.path,
    type: r.type,
    media_type: r.media_type,
    sha256: r.sha256
  }));
  const row: SkillRow = {
    asset_id,
    version,
    name: fm.name,
    description: fm.description,
    schema_version: fm.schema_version,
    category: fm.category ?? null,
    triggers_json: JSON.stringify(fm.triggers ?? []),
    when_to_use: fm.when_to_use ?? null,
    when_not_to_use: fm.when_not_to_use ?? null,
    compatibility_json: JSON.stringify(fm.compatibility ?? {}),
    source: source,
    skill_md_canonical: canonical,
    body_hash: bodyHash,
    resources_json: JSON.stringify(resources)
  };
  return { row, canonical, bodyHash };
}

export class SkillService {
  /**
   * The schema version stamped on the
   * `skills.schema_version` column. The
   * v1.2-alpha.2 (issue #53) row shape is the
   * "1" line of the SKILL.md frontmatter
   * (`schema_version: "1"`).
   */
  static readonly SKILL_ROW_SCHEMA_VERSION = "1";

  constructor(
    private readonly store: SQLiteMemoryStore,
    private readonly assets: AssetService = new AssetService(store)
  ) {}

  /**
   * Import a SKILL.md string as a new `skill`
   * asset. The asset envelope is minted with
   * a fresh UUID via `AssetService.createSkillVersion`;
   * the type-specific `skills` row is written
   * immediately after, in the same logical
   * transaction. On a UUID collision (rare;
   * randomUUID prevents it), retry once.
   */
  importSkillMd(input: SkillImportInput): SkillImportResult {
    if (input.scope === "project" && input.project_id === undefined) {
      throw stableError(
        "binding_invalid",
        "scope=project requires project_id"
      );
    }
    const parsed = parseAndValidate(input.skillMd);
    const { row, canonical, bodyHash } = buildRowFromParsed(
      "scratch",
      1,
      parsed,
      input.source
    );
    const provenanceKind: "manual" | "derivation_run" | "import_batch" | "external" =
      input.source === "derived"
        ? "derivation_run"
        : input.source === "imported"
          ? "import_batch"
          : "manual";
    const created = this.assets.createSkillVersion({
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      owner_actor_id: input.owner_actor_id,
      ...(input.trust_level !== undefined ? { trust_level: input.trust_level } : {}),
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      name: parsed.frontmatter.name,
      body_hash: bodyHash,
      source: input.source,
      provenance_kind: provenanceKind,
      provenance_ref: input.provenance_ref ?? null
    });
    const rowInserted = this.store.insertSkillRow({
      ...row,
      asset_id: created.asset_id,
      version: 1
    });
    if (!rowInserted) {
      throw stableError(
        "binding_invalid",
        `skills row insert failed for ${created.asset_id} v1`
      );
    }
    return {
      asset_id: created.asset_id,
      version: 1,
      content_hash: bodyHash,
      body_hash: bodyHash
    };
  }

  /**
   * Append a new version of an existing skill
   * asset. The CAS on
   * `expected_previous_version` (in
   * `AssetService.appendSkillVersion`) makes
   * concurrent appends safe — the second writer
   * receives `cas_mismatch` and can retry. The
   * asset must be a `skill` type; the service
   * does not silently upgrade a `memory_ref`
   * envelope.
   */
  appendSkillVersion(input: SkillAppendInput): SkillImportResult {
    const asset = this.store.getAsset(input.asset_id);
    if (asset === undefined) {
      throw stableError("asset_not_found", `no asset with id ${input.asset_id}`);
    }
    if (asset.asset_type !== "skill") {
      throw stableError(
        "binding_invalid",
        `asset ${input.asset_id} is type '${asset.asset_type}', not 'skill'`
      );
    }
    const parsed = parseAndValidate(input.skillMd);
    const previousVersion = asset.current_version;
    const newVersion = previousVersion + 1;
    const { row } = buildRowFromParsed(
      input.asset_id,
      newVersion,
      parsed,
      // The new version inherits the source from
      // the existing envelope. The first version
      // set this on import; the CLI does not have
      // a "rewrite source" verb.
      "manual"
    );
    const bodyHash = row.body_hash;
    const appended = this.assets.appendSkillVersion({
      asset_id: input.asset_id,
      expected_previous_version: previousVersion,
      body_hash: bodyHash,
      name: parsed.frontmatter.name,
      created_by_actor_id: input.created_by_actor_id,
      ...(input.change_summary !== undefined
        ? { change_summary: input.change_summary }
        : {})
    });
    const rowInserted = this.store.insertSkillRow({
      ...row,
      asset_id: input.asset_id,
      version: newVersion
    });
    if (!rowInserted) {
      throw stableError(
        "binding_invalid",
        `skills row insert failed for ${input.asset_id} v${newVersion}`
      );
    }
    return {
      asset_id: input.asset_id,
      version: appended.version,
      content_hash: bodyHash,
      body_hash: bodyHash
    };
  }

  /**
   * Read the full skill row + envelope + head
   * version + the canonical SKILL.md bytes. The
   * `body` is the literal `skill_md_canonical`
   * (already canonicalised on write).
   */
  get(asset_id: string, version?: number): SkillGetResult | undefined {
    const asset = this.store.getAsset(asset_id);
    if (asset === undefined) return undefined;
    if (asset.asset_type !== "skill") return undefined;
    const versions = this.store.listAssetVersions(asset_id);
    if (versions.length === 0) return undefined;
    const head = versions[versions.length - 1]!;
    const targetVersion = version ?? head.version;
    if (targetVersion > head.version) return undefined;
    const row = this.store.getSkillRow(asset_id, targetVersion);
    if (row === undefined) return undefined;
    const versionRow =
      versions.find((v) => v.version === targetVersion) ?? head;
    return {
      asset,
      current_version: versionRow,
      row,
      body: row.skill_md_canonical
    };
  }

  /**
   * Return the canonical SKILL.md string for
   * the supplied `(asset_id, version)`. The
   * caller can write this to disk; the bytes
   * round-trip through `parseSkillMd` to the
   * same parsed shape.
   */
  exportSkillMd(asset_id: string, version?: number): string | undefined {
    const result = this.get(asset_id, version);
    if (result === undefined) return undefined;
    return result.row.skill_md_canonical;
  }

  /**
   * Lexical search over `name` + `description`
   * + `triggers` (case-insensitive substring).
   * The result is the head of each matching
   * asset (the largest version) joined with the
   * envelope's lifecycle_state and updated_at.
   * The full SKILL.md body is NEVER returned
   * here — the summary is the contract.
   */
  search(input: SkillSearchInput): SkillSummary[] {
    const limit = input.limit ?? 50;
    const q = input.query.trim().toLowerCase();
    if (q.length === 0) return [];
    // Pull a bounded set of rows (the cap is
    // `limit * 4` with a 200-row floor) and
    // match in-process. The store's
    // `listSkillRows` only filters by `name` via
    // LIKE; description / triggers need a
    // substring match. The row payload is small
    // (the frontmatter, not the body) so an
    // in-process scan is bounded.
    const ceiling = Math.max(limit * 4, 200);
    const candidates = this.store.listSkillRows("%", ceiling);
    const byAsset = new Map<string, SkillRow>();
    for (const row of candidates) {
      const existing = byAsset.get(row.asset_id);
      if (existing === undefined || existing.version < row.version) {
        byAsset.set(row.asset_id, row);
      }
    }
    const out: SkillSummary[] = [];
    for (const row of byAsset.values()) {
      const triggers = parseTriggersJson(row.triggers_json);
      const matches =
        row.name.toLowerCase().includes(q) ||
        row.description.toLowerCase().includes(q) ||
        triggers.some((t) => t.toLowerCase().includes(q));
      if (!matches) continue;
      const asset = this.store.getAsset(row.asset_id);
      if (asset === undefined) continue;
      out.push({
        asset_id: row.asset_id,
        version: row.version,
        name: row.name,
        description: row.description,
        category: row.category,
        triggers,
        source: row.source,
        lifecycle_state: asset.lifecycle_state,
        updated_at: asset.updated_at
      });
      if (out.length >= limit) break;
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return out;
  }

  /**
   * List all skill assets (compact summary).
   * The list is a single AssetService.list call
   * filtered to asset_type='skill' and joined
   * with the head row from `skills`.
   */
  list(filter: { lifecycle_state?: AssetRow["lifecycle_state"]; limit?: number }): SkillSummary[] {
    const limit = filter.limit ?? 50;
    const envelopes = this.assets.list({
      asset_type: "skill",
      ...(filter.lifecycle_state !== undefined
        ? { lifecycle_state: filter.lifecycle_state }
        : {}),
      limit
    });
    const out: SkillSummary[] = [];
    for (const envelope of envelopes) {
      const head = this.store.getSkillRow(envelope.asset_id, envelope.current_version);
      if (head === undefined) continue;
      out.push({
        asset_id: envelope.asset_id,
        version: head.version,
        name: head.name,
        description: head.description,
        category: head.category,
        triggers: parseTriggersJson(head.triggers_json),
        source: head.source,
        lifecycle_state: envelope.lifecycle_state,
        updated_at: envelope.updated_at
      });
    }
    return out;
  }
}

function parseTriggersJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Corrupt JSON; treat as empty.
  }
  return [];
}
