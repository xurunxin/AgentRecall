// src/cli/commands/assets.ts
//
// v1.2.0-alpha.1 (issue #51): the `agent-recall
// assets ...` subcommand. Five verbs:
//
//   list     -- filter by --type / --state / --scope / --project-id
//   show     -- envelope + current head + payload
//   history  -- all version rows (oldest first)
//   lifecycle <id> <state>   -- set lifecycle (state in draft|active|deprecated|archived)
//   create-memory-ref       -- (programmatic helper) append a v1 memory_ref asset
//
// The `create-memory-ref` subcommand is the only
// mutation that takes user input directly. Lifecycle
// transitions are otherwise the public mutation
// surface for the v1.2-alpha.1 envelope.

import { flagBool, flagString, flagNumber } from "../arg-parser.js";
import { jsonOut } from "../format.js";
import type { CliContext, CliResult } from "../index.js";
import { AssetService } from "../../assets/service.js";
import type { AssetLifecycleState, AssetRow, AssetVersionRow } from "../../sqlite-store.js";

const HELP = `agent-recall assets — manage the typed asset registry

Usage:
  agent-recall assets list     [--type <t>] [--state <s>] [--scope <global|project>] [--project-id <id>] [--limit <n>] [--json]
  agent-recall assets show     <asset_id> [--json]
  agent-recall assets history  <asset_id> [--json]
  agent-recall assets lifecycle <asset_id> <state> [--json]
  agent-recall assets create-memory-ref
    --scope <global|project> [--project-id <id>]
    --memory-id <mem_xxx> --memory-revision <n>
    [--trust <user_confirmed|agent_observed|inferred>]
    [--sensitivity <normal|private|restricted>]
    [--binding-rule <text>] [--note <text>] [--json]

Subcommands:
  list        List assets, newest first.
  show        Inspect one asset (envelope + current head + payload).
  history     List all version rows for an asset, oldest first.
  lifecycle   Set lifecycle state (draft|active|deprecated|archived).
  create-memory-ref  Append a v1 memory_ref asset pointing at a memory entry.

Flags:
  --type <t>            Filter (list) to a single asset type.
  --state <s>           Filter (list) to a single lifecycle state.
  --scope <s>           Filter (list) to global|project.
  --project-id <id>     Filter (list) to a single project.
  --limit <n>           Cap (list) row count (default 50).
  --memory-id <id>      Memory id the new memory_ref points at.
  --memory-revision <n> Revision of the memory entry.
  --trust <lvl>         Trust level (default user_confirmed).
  --sensitivity <lvl>   Sensitivity (default normal).
  --binding-rule <text> Optional free-form binding rule.
  --note <text>         Optional note.
  --json                Emit JSON.
`;

function service(ctx: CliContext): AssetService {
  return new AssetService(ctx.store);
}

function assetRowToJson(row: AssetRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    asset_id: row.asset_id,
    asset_type: row.asset_type,
    scope: row.scope,
    owner_actor_id: row.owner_actor_id,
    lifecycle_state: row.lifecycle_state,
    current_version: row.current_version,
    trust_level: row.trust_level,
    sensitivity: row.sensitivity,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at
  };
  if (row.project_id !== null) out["project_id"] = row.project_id;
  return out;
}

function versionRowToJson(row: AssetVersionRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    asset_id: row.asset_id,
    version: row.version,
    schema_version: row.schema_version,
    content_hash: row.content_hash,
    manifest_json: row.manifest_json,
    created_by_actor_id: row.created_by_actor_id,
    created_at: row.created_at
  };
  if (row.provenance_kind !== null) out["provenance_kind"] = row.provenance_kind;
  if (row.provenance_ref !== null) out["provenance_ref"] = row.provenance_ref;
  return out;
}

function parseLifecycle(value: string): AssetLifecycleState {
  switch (value) {
    case "draft":
    case "active":
    case "deprecated":
    case "archived":
      return value;
    default:
      throw new Error(
        `[usage_error] invalid lifecycle state '${value}' (expected draft|active|deprecated|archived)`
      );
  }
}

export async function assetsCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0] ?? "help";
  switch (sub) {
    case "list":
      return assetsList(ctx);
    case "show":
      return assetsShow(ctx);
    case "history":
      return assetsHistory(ctx);
    case "lifecycle":
      return assetsLifecycle(ctx);
    case "create-memory-ref":
      return assetsCreateMemoryRef(ctx);
    case "help":
    case "--help":
    case "-h":
      return { exitCode: 0, stdout: HELP, stderr: "" };
    default:
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[usage_error] unknown assets subcommand: ${sub}\n\n${HELP}`
      };
  }
}

function assetsList(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const type = flagString(ctx.args, "type") as AssetRow["asset_type"] | undefined;
  const state = flagString(ctx.args, "state");
  const scope = flagString(ctx.args, "scope") as "global" | "project" | undefined;
  const projectId = flagString(ctx.args, "project-id");
  const limit = flagNumber(ctx.args, "limit") ?? 50;
  const rows = service(ctx).list({
    ...(type !== undefined ? { asset_type: type } : {}),
    ...(state !== undefined ? { lifecycle_state: parseLifecycle(state) } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    limit
  });
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ assets: rows.map(assetRowToJson) }), stderr: "" };
  }
  const lines: string[] = [];
  lines.push("ASSET_ID                         TYPE          STATE      VERSION  UPDATED");
  for (const r of rows) {
    const id = r.asset_id.padEnd(34);
    const t = r.asset_type.padEnd(13);
    const s = r.lifecycle_state.padEnd(10);
    const v = String(r.current_version).padStart(7);
    lines.push(`${id} ${t} ${s} ${v}  ${r.updated_at}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function assetsShow(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const assetId = ctx.args.positional[1];
  if (assetId === undefined || assetId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] assets show requires an <asset_id> argument" };
  }
  const inspection = service(ctx).show(assetId);
  if (inspection === undefined) {
    return { exitCode: 1, stdout: "", stderr: `[asset_not_found] no asset with id ${assetId}` };
  }
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        asset: assetRowToJson(inspection.asset),
        current_version:
          inspection.current_version === null ? null : versionRowToJson(inspection.current_version),
        payload: inspection.payload
      }),
      stderr: ""
    };
  }
  const lines: string[] = [];
  const a = inspection.asset;
  lines.push(`asset_id:        ${a.asset_id}`);
  lines.push(`asset_type:      ${a.asset_type}`);
  lines.push(`scope:           ${a.scope}${a.project_id ? ` (${a.project_id})` : ""}`);
  lines.push(`lifecycle:       ${a.lifecycle_state}`);
  lines.push(`current_version: ${a.current_version}`);
  lines.push(`trust_level:     ${a.trust_level}`);
  lines.push(`sensitivity:     ${a.sensitivity}`);
  if (inspection.current_version !== null) {
    lines.push(`head:            v${inspection.current_version.version} content_hash=${inspection.current_version.content_hash}`);
  }
  if (inspection.payload !== null) {
    if (a.asset_type === "memory_ref") {
      const binding = inspection.payload as { memory_id: string; memory_revision: number };
      lines.push(
        `binding:         memory_id=${binding.memory_id} ` +
          `revision=${binding.memory_revision}`
      );
    } else if (a.asset_type === "skill") {
      const row = inspection.payload as { name: string; body_hash: string };
      lines.push(`skill:           name=${row.name} body_hash=${row.body_hash}`);
    }
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function assetsHistory(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const assetId = ctx.args.positional[1];
  if (assetId === undefined || assetId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] assets history requires an <asset_id> argument" };
  }
  const versions = service(ctx).history(assetId);
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ asset_id: assetId, versions: versions.map(versionRowToJson) }), stderr: "" };
  }
  const lines: string[] = [];
  lines.push(`ASSET_ID: ${assetId}`);
  lines.push("VERSION  CONTENT_HASH                         PROVENANCE          CREATED");
  for (const v of versions) {
    const ver = String(v.version).padEnd(7);
    const hash = v.content_hash.padEnd(40);
    const prov = `${v.provenance_kind ?? "-"}${v.provenance_ref ? `:${v.provenance_ref}` : ""}`.padEnd(18);
    lines.push(`${ver} ${hash} ${prov} ${v.created_at}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function assetsLifecycle(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const assetId = ctx.args.positional[1];
  const stateRaw = ctx.args.positional[2];
  if (assetId === undefined || stateRaw === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] assets lifecycle requires <asset_id> <state>"
    };
  }
  const newState = parseLifecycle(stateRaw);
  try {
    const updated = service(ctx).setLifecycle(assetId, newState);
    if (json) {
      return { exitCode: 0, stdout: jsonOut({ asset: assetRowToJson(updated) }), stderr: "" };
    }
    return { exitCode: 0, stdout: `${updated.asset_id} -> ${updated.lifecycle_state}\n`, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

function assetsCreateMemoryRef(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const scope = flagString(ctx.args, "scope") as "global" | "project" | undefined;
  const projectId = flagString(ctx.args, "project-id");
  const memoryId = flagString(ctx.args, "memory-id");
  const memoryRevisionRaw = flagString(ctx.args, "memory-revision");
  const trustLevel = flagString(ctx.args, "trust") as
    | "user_confirmed" | "agent_observed" | "inferred" | undefined;
  const sensitivity = flagString(ctx.args, "sensitivity") as
    | "normal" | "private" | "restricted" | undefined;
  const bindingRule = flagString(ctx.args, "binding-rule");
  const note = flagString(ctx.args, "note");
  if (scope === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --scope is required" };
  }
  if (memoryId === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --memory-id is required" };
  }
  const memoryRevision = memoryRevisionRaw === undefined ? Number.NaN : Number(memoryRevisionRaw);
  if (!Number.isFinite(memoryRevision) || memoryRevision <= 0) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --memory-revision must be a positive integer" };
  }
  try {
    const result = service(ctx).createMemoryRef({
      scope,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      owner_actor_id: "user:cli",
      trust_level: trustLevel ?? "user_confirmed",
      sensitivity: sensitivity ?? "normal",
      memory_id: memoryId,
      memory_revision: memoryRevision,
      ...(bindingRule !== undefined ? { binding_rule: bindingRule } : {}),
      ...(note !== undefined ? { note } : {})
    });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `asset_id=${result.asset_id} version=${result.version} content_hash=${result.content_hash}\n`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}
