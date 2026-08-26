// src/cli/commands/loadouts.ts
//
// v1.2.0-alpha.2 (issue #52): the `agent-recall
// loadouts ...` subcommand. Seven verbs:
//
//   list     -- filter by --scope / --actor / --client
//   show     -- envelope + per-channel rules
//   create   -- new loadout row at version 1
//   update   -- CAS-update rules; --channel is required
//   bind     -- attach a binding row
//   unbind   -- remove a binding row
//   resolve  -- run the 5-step precedence chain
//
// The CLI is a thin wrapper over `LoadoutService`
// (src/loadouts/service.ts); the wire shape is the
// canonical row / `ResolveResult` JSON.

import { flagBool, flagString, flagNumber } from "../arg-parser.js";
import { jsonOut } from "../format.js";
import type { CliContext, CliResult } from "../index.js";
import { LoadoutService } from "../../loadouts/service.js";
import type {
  LoadoutChannel,
  LoadoutRow,
  LoadoutRuleRow,
  LoadoutScope,
  LoadoutTier
} from "../../sqlite-store.js";

const HELP = `agent-recall loadouts — manage the agent loadout substrate (issue #52)

Usage:
  agent-recall loadouts list       [--scope <global|project>] [--project-id <id>] [--json]
  agent-recall loadouts show       <loadout_id> [--json]
  agent-recall loadouts create
    --name <text> --scope <global|project>
    [--project-id <id>] [--actor <id>] [--client <text>] [--task-mode <mode>]
    [--json]
  agent-recall loadouts update     <loadout_id>
    --channel <bootstrap|query|tool_only>
    [--max-items <n>] [--max-chars <n>]
    [--include-asset-ids <csv>] [--include-memory-ids <csv>]
    [--include-types <csv>] [--include-tags <csv>] [--include-topics <csv>]
    [--exclude-tags <csv>] [--required-refs <csv>]
    [--timeout-ms <n>] [--ordering-policy <rule_then_score|score_only|rule_only>]
    [--json]
  agent-recall loadouts bind       <loadout_id>
    [--actor <id>] [--client <text>] [--project-id <id>] [--task-mode <mode>]
    [--priority <n>] [--json]
  agent-recall loadouts unbind     <binding_id> [--json]
  agent-recall loadouts resolve
    --actor <id> [--client <text>] [--project-id <id>] [--task-mode <mode>]
    [--explicit <loadout_id>] [--json]

Subcommands:
  list        List loadout rows, newest first.
  show        Inspect one loadout + its per-channel rules.
  create      Create a new loadout row (version 1, lifecycle_state=draft).
  update      CAS-update the rules; --channel is required per call.
  bind        Attach a binding row (the precedence matcher).
  unbind      Remove a binding row.
  resolve     Run the 5-step precedence chain and report the resolved loadout.

Flags:
  --scope <s>            Filter (list) to a single scope.
  --project-id <id>      Filter (list) or scope (create) project_id.
  --actor <id>           match_actor_id (create) or actor_id (bind / resolve).
  --client <text>        match_client_name (create) or client_name (bind / resolve).
  --task-mode <mode>     task_mode attribute (create / bind / resolve).
  --channel <c>          Channel name (update).
  --max-items <n>        Budget cap on items.
  --max-chars <n>        Budget cap on chars.
  --include-asset-ids <csv>    CSV of asset_ids to include.
  --include-memory-ids <csv>   CSV of memory_ids to include.
  --include-types <csv>        CSV of memory types.
  --include-tags <csv>         CSV of tags.
  --include-topics <csv>       CSV of topics.
  --exclude-tags <csv>         CSV of tags to exclude.
  --required-refs <csv>        CSV of required asset / memory refs.
  --timeout-ms <n>             Channel timeout.
  --ordering-policy <p>        Per-channel ordering policy.
  --priority <n>               Binding priority (default 0).
  --explicit <loadout_id>      Skip the precedence chain and use this loadout.
  --json                Emit JSON.
`;

function service(ctx: CliContext): LoadoutService {
  return new LoadoutService(ctx.store);
}

function loadoutRowToJson(row: LoadoutRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    loadout_id: row.loadout_id,
    name: row.name,
    version: row.version,
    lifecycle_state: row.lifecycle_state,
    match_actor_id: row.match_actor_id,
    match_client_name: row.match_client_name,
    scope: row.scope,
    project_id: row.project_id,
    task_mode: row.task_mode,
    created_by_actor_id: row.created_by_actor_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  return out;
}

function ruleRowToJson(row: LoadoutRuleRow): Record<string, unknown> {
  return {
    loadout_id: row.loadout_id,
    version: row.version,
    channel: row.channel,
    include_asset_ids: row.include_asset_ids,
    include_memory_ids: row.include_memory_ids,
    include_types: row.include_types,
    include_tiers: row.include_tiers,
    include_tags: row.include_tags,
    include_topics: row.include_topics,
    exclude_asset_ids: row.exclude_asset_ids,
    exclude_memory_ids: row.exclude_memory_ids,
    exclude_tags: row.exclude_tags,
    required_refs: row.required_refs,
    max_items: row.max_items,
    max_chars: row.max_chars,
    max_tokens: row.max_tokens,
    timeout_ms: row.timeout_ms,
    ordering_policy: row.ordering_policy
  };
}

function csv(input: string | undefined): string[] {
  if (input === undefined || input.length === 0) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseChannel(value: string): LoadoutChannel {
  switch (value) {
    case "bootstrap":
    case "query":
    case "tool_only":
      return value;
    default:
      throw new Error(
        `[usage_error] invalid channel '${value}' (expected bootstrap|query|tool_only)`
      );
  }
}

function parseScope(value: string): LoadoutScope {
  switch (value) {
    case "global":
    case "project":
      return value;
    default:
      throw new Error(
        `[usage_error] invalid scope '${value}' (expected global|project)`
      );
  }
}

function parseTiers(value: string): LoadoutTier[] {
  const out: LoadoutTier[] = [];
  for (const tier of csv(value)) {
    if (tier !== "core" && tier !== "working" && tier !== "archival") {
      throw new Error(
        `[usage_error] invalid tier '${tier}' (expected core|working|archival)`
      );
    }
    out.push(tier);
  }
  return out;
}

function loadoutErrorResult(err: unknown): CliResult {
  const code = (err as { code?: string }).code ?? "tool_error";
  const message = err instanceof Error ? err.message : String(err);
  return {
    exitCode: 1,
    stdout: "",
    stderr: `[${code}] ${message}`
  };
}

export async function loadoutsCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0] ?? "help";
  try {
    switch (sub) {
      case "list":
        return loadoutsList(ctx);
      case "show":
        return loadoutsShow(ctx);
      case "create":
        return loadoutsCreate(ctx);
      case "update":
        return loadoutsUpdate(ctx);
      case "bind":
        return loadoutsBind(ctx);
      case "unbind":
        return loadoutsUnbind(ctx);
      case "resolve":
        return loadoutsResolve(ctx);
      case "help":
      case "--help":
      case "-h":
        return { exitCode: 0, stdout: HELP, stderr: "" };
      default:
        return {
          exitCode: 1,
          stdout: "",
          stderr: `[usage_error] unknown loadouts subcommand: ${sub}\n\n${HELP}`
        };
    }
  } catch (err) {
    return loadoutErrorResult(err);
  }
}

function loadoutsList(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const scope = flagString(ctx.args, "scope");
  const projectId = flagString(ctx.args, "project-id");
  const limit = flagNumber(ctx.args, "limit") ?? 50;
  const rows = service(ctx).list({
    ...(scope !== undefined ? { scope: parseScope(scope) } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    limit
  });
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ loadouts: rows.map(loadoutRowToJson) }), stderr: "" };
  }
  const lines: string[] = [];
  lines.push("LOADOUT_ID                      NAME                 VERSION  STATE     SCOPE     PROJECT");
  for (const r of rows) {
    const id = r.loadout_id.padEnd(33);
    const name = r.name.slice(0, 20).padEnd(20);
    const v = String(r.version).padStart(7);
    const s = r.lifecycle_state.padEnd(9);
    const sc = r.scope.padEnd(9);
    const p = r.project_id ?? "-";
    lines.push(`${id} ${name} ${v}  ${s} ${sc} ${p}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function loadoutsShow(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const loadoutId = ctx.args.positional[1];
  if (loadoutId === undefined || loadoutId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] loadouts show requires a <loadout_id> argument" };
  }
  const svc = service(ctx);
  const row = svc.get(loadoutId);
  if (row === undefined) {
    return { exitCode: 1, stdout: "", stderr: `[loadout_not_found] no loadout with id ${loadoutId}` };
  }
  const rules = ctx.store.loadoutRulesForVersion(row.loadout_id, row.version);
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        loadout: loadoutRowToJson(row),
        rules: rules.map(ruleRowToJson)
      }),
      stderr: ""
    };
  }
  const lines: string[] = [];
  lines.push(`loadout_id:    ${row.loadout_id}`);
  lines.push(`name:          ${row.name}`);
  lines.push(`version:       ${row.version}`);
  lines.push(`lifecycle:     ${row.lifecycle_state}`);
  lines.push(`scope:         ${row.scope}${row.project_id ? ` (${row.project_id})` : ""}`);
  if (rules.length === 0) {
    lines.push("rules:         (none — built-in fallback applies)");
  } else {
    lines.push("rules:");
    for (const r of rules) {
      lines.push(`  - ${r.channel}: max_items=${r.max_items} max_chars=${r.max_chars}`);
    }
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function loadoutsCreate(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const name = flagString(ctx.args, "name");
  const scopeStr = flagString(ctx.args, "scope");
  const projectId = flagString(ctx.args, "project-id");
  const actor = flagString(ctx.args, "actor");
  const client = flagString(ctx.args, "client");
  const taskMode = flagString(ctx.args, "task-mode");
  if (name === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --name is required" };
  }
  if (scopeStr === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --scope is required" };
  }
  const loadoutId = service(ctx).create({
    name,
    scope: parseScope(scopeStr),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(actor !== undefined ? { match_actor_id: actor } : {}),
    ...(client !== undefined ? { match_client_name: client } : {}),
    ...(taskMode !== undefined ? { task_mode: taskMode } : {}),
    created_by_actor_id: ctx.ctx.actor_id
  });
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ loadout_id: loadoutId }), stderr: "" };
  }
  return { exitCode: 0, stdout: `created loadout: ${loadoutId}\n`, stderr: "" };
}

function loadoutsUpdate(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const loadoutId = ctx.args.positional[1];
  if (loadoutId === undefined || loadoutId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] loadouts update requires a <loadout_id> argument" };
  }
  const channelStr = flagString(ctx.args, "channel");
  if (channelStr === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --channel is required" };
  }
  const channel = parseChannel(channelStr);
  const maxItems = flagNumber(ctx.args, "max-items");
  const maxChars = flagNumber(ctx.args, "max-chars");
  const includeAssetIds = flagString(ctx.args, "include-asset-ids");
  const includeMemoryIds = flagString(ctx.args, "include-memory-ids");
  const includeTypes = flagString(ctx.args, "include-types");
  const includeTags = flagString(ctx.args, "include-tags");
  const includeTopics = flagString(ctx.args, "include-topics");
  const excludeTags = flagString(ctx.args, "exclude-tags");
  const requiredRefs = flagString(ctx.args, "required-refs");
  const timeoutMs = flagNumber(ctx.args, "timeout-ms");
  const orderingPolicy = flagString(ctx.args, "ordering-policy");
  const tiers = flagString(ctx.args, "include-tiers");
  let orderingPolicyValue: "rule_then_score" | "score_only" | "rule_only" | undefined;
  if (orderingPolicy !== undefined) {
    if (
      orderingPolicy !== "rule_then_score" &&
      orderingPolicy !== "score_only" &&
      orderingPolicy !== "rule_only"
    ) {
      throw new Error(
        `[usage_error] invalid --ordering-policy '${orderingPolicy}' (expected rule_then_score|score_only|rule_only)`
      );
    }
    orderingPolicyValue = orderingPolicy;
  }
  const patch = {
    channel,
    ...(maxItems !== undefined ? { max_items: maxItems } : {}),
    ...(maxChars !== undefined ? { max_chars: maxChars } : {}),
    ...(includeAssetIds !== undefined ? { include_asset_ids: csv(includeAssetIds) } : {}),
    ...(includeMemoryIds !== undefined ? { include_memory_ids: csv(includeMemoryIds) } : {}),
    ...(includeTypes !== undefined ? { include_types: csv(includeTypes) } : {}),
    ...(includeTags !== undefined ? { include_tags: csv(includeTags) } : {}),
    ...(includeTopics !== undefined ? { include_topics: csv(includeTopics) } : {}),
    ...(excludeTags !== undefined ? { exclude_tags: csv(excludeTags) } : {}),
    ...(requiredRefs !== undefined ? { required_refs: csv(requiredRefs) } : {}),
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    ...(tiers !== undefined ? { include_tiers: parseTiers(tiers) } : {}),
    ...(orderingPolicyValue !== undefined ? { ordering_policy: orderingPolicyValue } : {})
  };
  const updated = service(ctx).updateRules(loadoutId, [patch]);
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ loadout: loadoutRowToJson(updated) }), stderr: "" };
  }
  return { exitCode: 0, stdout: `updated ${loadoutId} to version ${updated.version}\n`, stderr: "" };
}

function loadoutsBind(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const loadoutId = ctx.args.positional[1];
  if (loadoutId === undefined || loadoutId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] loadouts bind requires a <loadout_id> argument" };
  }
  const actor = flagString(ctx.args, "actor");
  const client = flagString(ctx.args, "client");
  const projectId = flagString(ctx.args, "project-id");
  const taskMode = flagString(ctx.args, "task-mode");
  const priority = flagNumber(ctx.args, "priority") ?? 0;
  const bindingId = service(ctx).bind({
    loadout_id: loadoutId,
    ...(actor !== undefined ? { actor_id: actor } : {}),
    ...(client !== undefined ? { client_name: client } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(taskMode !== undefined ? { task_mode: taskMode } : {}),
    priority
  });
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ binding_id: bindingId }), stderr: "" };
  }
  return { exitCode: 0, stdout: `bound ${bindingId} -> ${loadoutId}\n`, stderr: "" };
}

function loadoutsUnbind(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const bindingId = ctx.args.positional[1];
  if (bindingId === undefined || bindingId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] loadouts unbind requires a <binding_id> argument" };
  }
  const removed = service(ctx).unbind(bindingId);
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ binding_id: bindingId, removed }), stderr: "" };
  }
  return { exitCode: 0, stdout: `${removed ? "unbound" : "no-op (unknown id)"} ${bindingId}\n`, stderr: "" };
}

function loadoutsResolve(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const actor = flagString(ctx.args, "actor");
  const client = flagString(ctx.args, "client");
  const projectId = flagString(ctx.args, "project-id");
  const taskMode = flagString(ctx.args, "task-mode");
  const explicit = flagString(ctx.args, "explicit");
  if (actor === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --actor is required" };
  }
  const resolved = service(ctx).resolve({
    actor_id: actor,
    ...(client !== undefined ? { client_name: client } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(taskMode !== undefined ? { task_mode: taskMode } : {}),
    ...(explicit !== undefined ? { explicit_loadout_id: explicit } : {})
  });
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        loadout: loadoutRowToJson(resolved.loadout),
        rules: resolved.rules.map(ruleRowToJson),
        binding: resolved.binding,
        matched_rule: resolved.matched_rule
      }),
      stderr: ""
    };
  }
  return {
    exitCode: 0,
    stdout: `resolved ${resolved.loadout.loadout_id}@v${resolved.loadout.version} via ${resolved.matched_rule}\n`,
    stderr: ""
  };
}
