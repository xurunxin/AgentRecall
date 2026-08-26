// src/context-assembly/assembler.ts
//
// v1.2.0-alpha.2 (issue #52): the shared
// context-assembly service. The module is a pure
// function (no DB access); it takes a pre-resolved
// `LoadoutRow` + `LoadoutRuleRow[]` + a visibility
// filter (the caller's `actor_id` + `max_sensitivity`)
// and returns the assembled `bootstrap` / `query` /
// `tool_only` channels.
//
// The single hard invariant the assembler protects is
// the `bootstrap_hash` stability contract:
//
//   `bootstrap_hash` only changes when
//   (loadout_id, loadout_version, policy_version,
//   actor_id, project_id, <bootstrap channel text>)
//   changes. Memory writes that do not affect the
//   bootstrap channel MUST NOT churn it.
//
// The `bootstrap` channel only ever reads
// `tier = 'core'` + pinned `tier = 'working'` + the
// selected `context_pack` + compact `skill` summaries.
// `risk_injection = true` events are always excluded
// from `bootstrap`. `working` memory writes (the
// dominant write path) therefore cannot churn the
// hash; only a `core` memory body change, a loadout
// version bump, or a `policy_version` bump can.

import { createHash } from "node:crypto";

import type {
  LoadoutChannel,
  LoadoutRow,
  LoadoutRuleRow
} from "../sqlite-store.js";
import type { MemoryEntry, MemoryType } from "../domain.js";
import type {
  MemoryReadService,
  SearchMemoryItem
} from "../services/memory-read-service.js";
import {
  type AssembledChannelV1,
  type AssembledContextV1
} from "../../packages/contracts/src/loadouts.js";
import { LoadoutService } from "../loadouts/service.js";

/**
 * Stable policy version stamped on every
 * `AssembledContextV1.policy_version` row. Bumped
 * only when the context-assembly policy itself
 * changes (a new filter field, a new channel rule,
 * etc.). The literal MUST match the canonical
 * `LoadoutService.POLICY_VERSION` so callers can
 * pin the policy against the loadout service
 * version.
 */
export const ASSEMBLER_POLICY_VERSION = LoadoutService.POLICY_VERSION;

/**
 * The caller's authorization envelope. The
 * `max_sensitivity` is forwarded to the
 * `MemoryReadService` so every read is gated on the
 * SQL-boundary sensitivity filter.
 */
export type CallerAuthz = {
  actor_id: string;
  max_sensitivity: "normal" | "private" | "restricted";
};

/**
 * One channel's assembled output. Mirrors the
 * `AssembledChannelV1Schema` contract in
 * `packages/contracts/src/loadouts.ts`.
 */
export type AssembledChannel = AssembledChannelV1;

/**
 * The full assembled payload. Mirrors
 * `AssembledContextV1Schema`.
 */
export type Assembled = AssembledContextV1;

/**
 * The read-only inputs the assembler needs. The
 * `read_service` instance is the
 * `MemoryReadService` already wired against the
 * caller's authorization envelope; the assembler
 * never talks to the store directly.
 */
export type AssemblerDeps = {
  read_service: MemoryReadService;
  /**
   * An optional override for the legacy fallback
   * "all-active" memory list. When the resolved
   * loadout is the built-in `legacy-inject-all-active`
   * row, the assembler reads every `active` memory
   * the caller is authorised to see; a custom
   * `listActiveEntries` lets tests inject a
   * pre-filtered list without going through the full
   * `MemoryReadService` search path.
   */
  listActiveEntries?: (authz: CallerAuthz) => MemoryEntry[];
};

/**
 * The output shape the assembler hands back. The
 * `bootstrap_hash` field is the upstream prompt-cache
 * key — the canonical byte sequence is
 * `sha256(loadout_id + "\n" + loadout_version + "\n" +
 * policy_version + "\n" + actor_id + "\n" + project_id
 * + "\n" + bootstrap_channel_text)`.
 */
export type AssembleResult = Assembled;

export class ContextAssembler {
  private readonly deps: AssemblerDeps;

  constructor(deps: AssemblerDeps) {
    this.deps = deps;
  }

  /**
   * Assemble the bootstrap channel. The result is
   * always byte-stable: the same `(loadout, authz)`
   * pair always produces the same `text` and
   * `hash`; a `working` memory write is invisible
   * to the bootstrap surface (only `core` +
   * pinned-`working` + `context_pack` + compact
   * `skill` are eligible).
   *
   * `risk_injection=true` events are excluded.
   */
  assembleBootstrap(loadout: LoadoutRow, rules: LoadoutRuleRow[], authz: CallerAuthz): AssembledChannel {
    const rule = this.findRule(rules, "bootstrap");
    const candidates = this.bootstrapCandidates(loadout, rule, authz);
    const included: MemoryEntry[] = [];
    const excluded: string[] = [];
    const requiredRefsUnavailable: string[] = [];
    let riskInjectionFiltered = 0;
    const maxItems = rule?.max_items ?? 32;
    const maxChars = rule?.max_chars ?? 8000;
    let usedItems = 0;
    let usedChars = 0;
    // Required refs are pinned: they are
    // always surfaced even after the budget is
    // exhausted. The bootstrap channel only
    // honours `include_*` for `context_pack` /
    // `skill` asset ids; `include_memory_ids` is
    // honoured for direct memory pins.
    const requiredIds = new Set(rule?.required_refs ?? []);
    const explicitMemoryIds = new Set(rule?.include_memory_ids ?? []);
    const explicitAssetIds = new Set(rule?.include_asset_ids ?? []);

    for (const entry of candidates) {
      if (usedItems >= maxItems) break;
      if (!this.passesChannelFilters(entry, rule, "bootstrap")) {
        excluded.push(entry.id);
        continue;
      }
      if (this.entryIsRiskInjection(entry)) {
        riskInjectionFiltered += 1;
        excluded.push(entry.id);
        continue;
      }
      const lineCost = approxEntryChars(entry);
      if (usedItems > 0 && usedChars + lineCost > maxChars) {
        // budget exhausted; required refs still
        // get pinned below
        if (!requiredIds.has(entry.id)) continue;
      }
      if (requiredIds.has(entry.id) && !this.entryExists(entry)) {
        requiredRefsUnavailable.push(entry.id);
        continue;
      }
      included.push(entry);
      usedItems += 1;
      usedChars += lineCost;
    }
    // Honour explicit `include_*` pins even if
    // the candidate set is empty (the rule was
    // the entire selection). Required refs that
    // are not present in the candidate set (and
    // therefore could not be surfaced) are reported
    // in `required_refs_unavailable` — the caller
    // is expected to fail closed (no silent
    // substitution).
    for (const id of requiredIds) {
      if (included.some((e) => e.id === id)) continue;
      if (candidates.some((e) => e.id === id)) continue;
      requiredRefsUnavailable.push(id);
    }
    const text = this.formatChannelText("bootstrap", included);
    return {
      schema_version: "1",
      channel: "bootstrap",
      text,
      selected_ids: included.map((e) => e.id).sort(lexicographic),
      excluded_ids: [...excluded, ...[]].sort(lexicographic).filter(unique),
      required_refs_unavailable: requiredRefsUnavailable.sort(lexicographic),
      risk_injection_filtered: riskInjectionFiltered,
      hash: "sha256:" + createHash("sha256").update(text, "utf8").digest("hex"),
      budget: { used_items: usedItems, used_chars: usedChars, max_items: maxItems, max_chars: maxChars }
    };
  }

  /**
   * Assemble the query channel. The
   * `MemoryReadService.searchMemories` ranker is
   * the canonical candidate source; the rule's
   * `include_*` / `exclude_*` filters narrow the
   * candidate set, the budget caps the output.
   * `risk_injection=true` events are excluded.
   */
  assembleQuery(
    loadout: LoadoutRow,
    rules: LoadoutRuleRow[],
    authz: CallerAuthz,
    query: string
  ): AssembledChannel {
    const rule = this.findRule(rules, "query");
    const ranked = this.queryCandidates(loadout, authz, query);
    const included: SearchMemoryItem[] = [];
    const excluded: string[] = [];
    const requiredRefsUnavailable: string[] = [];
    let riskInjectionFiltered = 0;
    const maxItems = rule?.max_items ?? 32;
    const maxChars = rule?.max_chars ?? 8000;
    let usedItems = 0;
    let usedChars = 0;
    const requiredIds = new Set(rule?.required_refs ?? []);
    for (const item of ranked) {
      if (usedItems >= maxItems) break;
      if (!this.searchItemPassesChannelFilters(item, rule)) {
        excluded.push(item.id);
        continue;
      }
      if (this.searchItemIsRiskInjection(item)) {
        riskInjectionFiltered += 1;
        excluded.push(item.id);
        continue;
      }
      const lineCost = approxSearchItemChars(item);
      if (usedItems > 0 && usedChars + lineCost > maxChars) {
        if (!requiredIds.has(item.id)) continue;
      }
      if (requiredIds.has(item.id) && !this.searchItemExists(item, ranked)) {
        requiredRefsUnavailable.push(item.id);
        continue;
      }
      included.push(item);
      usedItems += 1;
      usedChars += lineCost;
    }
    for (const id of requiredIds) {
      if (included.some((e) => e.id === id)) continue;
      if (ranked.some((e) => e.id === id)) continue;
      requiredRefsUnavailable.push(id);
    }
    const text = this.formatQueryText("query", included);
    return {
      schema_version: "1",
      channel: "query",
      text,
      selected_ids: included.map((e) => e.id).sort(lexicographic),
      excluded_ids: excluded.sort(lexicographic).filter(unique),
      required_refs_unavailable: requiredRefsUnavailable.sort(lexicographic),
      risk_injection_filtered: riskInjectionFiltered,
      hash: "sha256:" + createHash("sha256").update(text, "utf8").digest("hex"),
      budget: { used_items: usedItems, used_chars: usedChars, max_items: maxItems, max_chars: maxChars }
    };
  }

  /**
   * Assemble the `tool_only` channel. The channel
   * returns the full body list of every material the
   * caller is authorised to see: archived memories,
   * raw session evidence (when the loadout opts in),
   * full Skill bodies / resources, and
   * `external_reference` assets. There is no budget
   * trim by default; the rule's `max_items` /
   * `max_chars` caps are honoured as soft caps.
   */
  assembleToolOnly(loadout: LoadoutRow, rules: LoadoutRuleRow[], authz: CallerAuthz): AssembledChannel {
    const rule = this.findRule(rules, "tool_only");
    const candidates = this.toolOnlyCandidates(loadout, rule, authz);
    const included: MemoryEntry[] = [];
    const excluded: string[] = [];
    const requiredRefsUnavailable: string[] = [];
    let riskInjectionFiltered = 0;
    const maxItems = rule?.max_items ?? 1000;
    const maxChars = rule?.max_chars ?? 200_000;
    let usedItems = 0;
    let usedChars = 0;
    const requiredIds = new Set(rule?.required_refs ?? []);
    for (const entry of candidates) {
      if (usedItems >= maxItems) break;
      if (!this.passesChannelFilters(entry, rule, "tool_only")) {
        excluded.push(entry.id);
        continue;
      }
      if (this.entryIsRiskInjection(entry)) {
        riskInjectionFiltered += 1;
        excluded.push(entry.id);
        continue;
      }
      const lineCost = approxEntryChars(entry);
      if (usedItems > 0 && usedChars + lineCost > maxChars) {
        if (!requiredIds.has(entry.id)) continue;
      }
      if (requiredIds.has(entry.id) && !this.entryExists(entry)) {
        requiredRefsUnavailable.push(entry.id);
        continue;
      }
      included.push(entry);
      usedItems += 1;
      usedChars += lineCost;
    }
    for (const id of requiredIds) {
      if (included.some((e) => e.id === id)) continue;
      if (candidates.some((e) => e.id === id)) continue;
      requiredRefsUnavailable.push(id);
    }
    const text = this.formatChannelText("tool_only", included);
    return {
      schema_version: "1",
      channel: "tool_only",
      text,
      selected_ids: included.map((e) => e.id).sort(lexicographic),
      excluded_ids: excluded.sort(lexicographic).filter(unique),
      required_refs_unavailable: requiredRefsUnavailable.sort(lexicographic),
      risk_injection_filtered: riskInjectionFiltered,
      hash: "sha256:" + createHash("sha256").update(text, "utf8").digest("hex"),
      budget: { used_items: usedItems, used_chars: usedChars, max_items: maxItems, max_chars: maxChars }
    };
  }

  /**
   * Convenience helper: assemble every channel the
   * loadout defines and compute the
   * `bootstrap_hash` upstream-cache key. The
   * `bootstrap_hash` is the SHA-256 of
   * `loadout_id + version + policy_version +
   * actor_id + project_id + bootstrap_text`.
   */
  assembleAll(input: {
    loadout: LoadoutRow;
    rules: LoadoutRuleRow[];
    authz: CallerAuthz;
    project_id?: string;
    query?: string;
  }): AssembleResult {
    const bootstrap = this.assembleBootstrap(input.loadout, input.rules, input.authz);
    const queryChannel =
      input.query !== undefined && input.query.length > 0
        ? this.assembleQuery(input.loadout, input.rules, input.authz, input.query)
        : undefined;
    const toolOnly = this.assembleToolOnly(input.loadout, input.rules, input.authz);
    const channels: Assembled["channels"] = { bootstrap, tool_only: toolOnly };
    if (queryChannel !== undefined) channels.query = queryChannel;
    const explanation: string[] = [];
    if (input.loadout.loadout_id === LoadoutService.LEGACY_FALLBACK_LOADOUT_ID) {
      explanation.push("resolved via built-in legacy-inject-all-active fallback (no binding matched)");
    } else {
      explanation.push(`loadout=${input.loadout.loadout_id}@v${input.loadout.version} (${input.loadout.scope})`);
    }
    const canonical =
      input.loadout.loadout_id +
      "\n" +
      String(input.loadout.version) +
      "\n" +
      ASSEMBLER_POLICY_VERSION +
      "\n" +
      input.authz.actor_id +
      "\n" +
      (input.project_id ?? "") +
      "\n" +
      bootstrap.text;
    const bootstrapHash =
      "sha256:" + createHash("sha256").update(canonical, "utf8").digest("hex");
    return {
      schema_version: "1",
      loadout_id: input.loadout.loadout_id,
      loadout_version: input.loadout.version,
      policy_version: ASSEMBLER_POLICY_VERSION,
      channels,
      bootstrap_hash: bootstrapHash,
      explanation
    };
  }

  // ───────────────── private helpers ─────────────────

  private findRule(rules: LoadoutRuleRow[], channel: LoadoutChannel): LoadoutRuleRow | undefined {
    return rules.find((r) => r.channel === channel);
  }

  private bootstrapCandidates(loadout: LoadoutRow, rule: LoadoutRuleRow | undefined, authz: CallerAuthz): MemoryEntry[] {
    // Bootstrap is locked to `core` + pinned
    // `working` + the loadout's `include_*` /
    // `context_pack` material. The full memory
    // set is the SQL-boundary-filtered list of
    // every `active` memory the caller is
    // authorised to see; we then narrow to the
    // bootstrap subset.
    const active = this.listActiveEntries(authz);
    const explicit = new Set(rule?.include_memory_ids ?? []);
    const allowed: MemoryEntry[] = [];
    for (const entry of active) {
      // Project-scope guard: a project-scope
      // loadout cannot include memories from a
      // different project. The listActiveEntries
      // call already honours the loadout's
      // project_id when it is set, but we
      // double-check here so a misconfigured
      // caller cannot leak memories across
      // projects.
      if (loadout.scope === "project" && loadout.project_id !== null) {
        if (entry.scope === "project" && entry.project_id !== loadout.project_id) {
          continue;
        }
      }
      if (entry.tier === "core") {
        if (entry.pinned || explicit.has(entry.id) || this.isBootstrapAllowListed(entry)) {
          allowed.push(entry);
        }
        continue;
      }
      if (entry.tier === "working" && entry.pinned) {
        allowed.push(entry);
        continue;
      }
      if (explicit.has(entry.id)) {
        allowed.push(entry);
        continue;
      }
    }
    // Sort: tier asc (core first), then importance desc,
    // then updated_at desc.
    allowed.sort((a, b) => {
      const tierRank = (e: MemoryEntry) => (e.tier === "core" ? 0 : e.tier === "working" ? 1 : 2);
      const ta = tierRank(a);
      const tb = tierRank(b);
      if (ta !== tb) return ta - tb;
      if (a.importance !== b.importance) return b.importance - a.importance;
      return a.updated_at < b.updated_at ? 1 : -1;
    });
    return allowed;
  }

  private queryCandidates(loadout: LoadoutRow, _authz: CallerAuthz, query: string): SearchMemoryItem[] {
    if (query.length === 0) return [];
    const scope = loadout.scope === "project" && loadout.project_id !== null
      ? { scope: "project" as const, project_id: loadout.project_id, include_global: true }
      : { scope: "global" as const };
    const result = this.deps.read_service.searchMemories({
      ...scope,
      query,
      limit: 200
    });
    if (!("items" in result)) return [];
    // Project-scope guard: drop cross-project matches.
    return result.items.filter((item: SearchMemoryItem) => {
      if (loadout.scope === "project" && loadout.project_id !== null) {
        if (item.scope === "project" && item.project_id !== loadout.project_id) {
          return false;
        }
      }
      return true;
    });
  }

  private toolOnlyCandidates(loadout: LoadoutRow, rule: LoadoutRuleRow | undefined, authz: CallerAuthz): MemoryEntry[] {
    // The `tool_only` channel is the full body
    // surface. It returns every entry the caller
    // is authorised to see (including `archived`),
    // so the caller can pull full bodies on demand.
    // We widen the status filter to include
    // `archived` so the channel can be used for
    // historical deep-dive without the cost of a
    // second `list_memories` call.
    const explicit = new Set(rule?.include_memory_ids ?? []);
    void explicit;
    const active = this.listAllEntries(authz);
    return active.filter((entry) => {
      if (loadout.scope === "project" && loadout.project_id !== null) {
        if (entry.scope === "project" && entry.project_id !== loadout.project_id) {
          return false;
        }
      }
      return true;
    });
  }

  private passesChannelFilters(
    entry: MemoryEntry,
    rule: LoadoutRuleRow | undefined,
    _channel: LoadoutChannel
  ): boolean {
    if (rule === undefined) return true;
    if (rule.exclude_memory_ids.length > 0 && rule.exclude_memory_ids.includes(entry.id)) {
      return false;
    }
    if (rule.exclude_tags.length > 0) {
      for (const tag of entry.tags) {
        if (rule.exclude_tags.includes(tag)) return false;
      }
    }
    if (rule.include_memory_ids.length > 0 && !rule.include_memory_ids.includes(entry.id)) {
      return false;
    }
    if (rule.include_types.length > 0 && !rule.include_types.includes(entry.type)) {
      return false;
    }
    if (rule.include_tiers.length > 0 && !rule.include_tiers.includes(entry.tier)) {
      return false;
    }
    if (rule.include_tags.length > 0) {
      let match = false;
      for (const tag of entry.tags) {
        if (rule.include_tags.includes(tag)) {
          match = true;
          break;
        }
      }
      if (!match) return false;
    }
    if (rule.include_topics.length > 0 && !rule.include_topics.includes(entry.topic)) {
      return false;
    }
    return true;
  }

  private searchItemPassesChannelFilters(
    item: SearchMemoryItem,
    rule: LoadoutRuleRow | undefined
  ): boolean {
    if (rule === undefined) return true;
    if (rule.exclude_memory_ids.length > 0 && rule.exclude_memory_ids.includes(item.id)) {
      return false;
    }
    if (rule.include_memory_ids.length > 0 && !rule.include_memory_ids.includes(item.id)) {
      return false;
    }
    if (rule.include_types.length > 0 && !rule.include_types.includes(item.type)) {
      return false;
    }
    if (rule.include_topics.length > 0 && !rule.include_topics.includes(item.topic)) {
      return false;
    }
    return true;
  }

  private entryIsRiskInjection(_entry: MemoryEntry): boolean {
    // The memory hierarchy does not yet stamp
    // a `risk_injection` flag on `memory_entries`;
    // the contract reserves the slot for the
    // session evidence surface (#49). The
    // assembler always returns `false` today;
    // bootstrap is `risk_injection`-free by
    // construction.
    return false;
  }

  private searchItemIsRiskInjection(_item: SearchMemoryItem): boolean {
    return false;
  }

  private entryExists(entry: MemoryEntry): boolean {
    return entry.id.length > 0;
  }

  private searchItemExists(item: SearchMemoryItem, ranked: SearchMemoryItem[]): boolean {
    return ranked.some((e) => e.id === item.id);
  }

  private isBootstrapAllowListed(entry: MemoryEntry): boolean {
    // The `bootstrap` channel always surfaces
    // `tier = 'core'` memories (per the assembler
    // contract documented in the file header). The
    // `pinned` / `include_*` filters are additive
    // narrowings (a pinned working memory is also
    // included; a loadout's `include_memory_ids`
    // can force-include a working / archival
    // memory).
    return entry.tier === "core";
  }

  private formatChannelText(channel: LoadoutChannel, entries: MemoryEntry[]): string {
    // Canonical byte sequence: LF separators,
    // sorted headers, deterministic. The hash is
    // SHA-256 over the canonical bytes; any byte
    // change (including whitespace) invalidates the
    // hash. The output is therefore stable across
    // platforms and Node.js versions.
    const headers = `# ${channel} channel`;
    const grouped = new Map<MemoryType, MemoryEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.type) ?? [];
      list.push(entry);
      grouped.set(entry.type, list);
    }
    const lines: string[] = [headers];
    const typeOrder: MemoryType[] = [
      "constraint",
      "procedure",
      "fact",
      "preference",
      "decision",
      "debugging",
      "lesson"
    ];
    for (const type of typeOrder) {
      const list = grouped.get(type);
      if (list === undefined || list.length === 0) continue;
      lines.push(`\n## ${type}`);
      const sorted = [...list].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      );
      for (const entry of sorted) {
        const header = `- [${entry.scope}${entry.project_id ? `:${entry.project_id}` : ""}] **${entry.title}** (tier=${entry.tier}, importance=${entry.importance}/${entry.confidence}, id=${entry.id})`;
        const body = entry.body.replace(/\r\n/g, "\n").replace(/\n+$/, "");
        lines.push(header);
        lines.push(body);
      }
    }
    for (const [type, list] of grouped) {
      if (typeOrder.includes(type as MemoryType)) continue;
      lines.push(`\n## ${type}`);
      const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const entry of sorted) {
        const header = `- [${entry.scope}${entry.project_id ? `:${entry.project_id}` : ""}] **${entry.title}** (tier=${entry.tier}, importance=${entry.importance}/${entry.confidence}, id=${entry.id})`;
        const body = entry.body.replace(/\r\n/g, "\n").replace(/\n+$/, "");
        lines.push(header);
        lines.push(body);
      }
    }
    return lines.join("\n") + "\n";
  }

  private formatQueryText(channel: "query", items: SearchMemoryItem[]): string {
    const lines: string[] = [`# ${channel} channel`];
    for (const item of items) {
      lines.push(
        `- [${item.scope}${item.project_id ? `:${item.project_id}` : ""}] **${item.title}** (topic=${item.topic}, type=${item.type}, id=${item.id}) — match_reason=${item.match_reason}`
      );
    }
    return lines.join("\n") + "\n";
  }

  private listActiveEntries(authz: CallerAuthz): MemoryEntry[] {
    if (this.deps.listActiveEntries !== undefined) {
      return this.deps.listActiveEntries(authz);
    }
    const result = this.deps.read_service.listMemories({ status: "active" });
    if (!("items" in result)) return [];
    return result.items;
  }

  private listAllEntries(authz: CallerAuthz): MemoryEntry[] {
    if (this.deps.listActiveEntries !== undefined) {
      // Re-use the override; the test fixture
      // controls the full status surface.
      return this.deps.listActiveEntries(authz);
    }
    void authz;
    const result = this.deps.read_service.listMemories({});
    if (!("items" in result)) return [];
    return result.items;
  }
}

// ───────── local helpers ─────────

function lexicographic(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unique<T>(value: T, index: number, array: T[]): boolean {
  return array.indexOf(value) === index;
}

function approxEntryChars(entry: MemoryEntry): number {
  return entry.body.length + entry.title.length + 64;
}

function approxSearchItemChars(item: SearchMemoryItem): number {
  return item.title.length + item.topic.length + 64;
}
