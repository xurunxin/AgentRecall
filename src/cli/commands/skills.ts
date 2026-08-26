// src/cli/commands/skills.ts
//
// v1.2.0-alpha.2 (issue #53): the
// `agent-recall skills ...` subcommand. Five
// verbs:
//
//   list         -- list all skill assets (compact summary)
//   search       -- lexical match over name / description / triggers
//   show         -- show one skill (envelope + body)
//   import       -- import a SKILL.md file as a new skill asset
//   export       -- export the canonical SKILL.md bytes to a file
//
// Skill lifecycle is managed through the
// existing `agent-recall assets lifecycle <id>
// <state>` command (issue #51's envelope is the
// single source of truth for `lifecycle_state`).
// There is no `skills activate` verb.

import { readFileSync, writeFileSync } from "node:fs";

import { flagBool, flagNumber, flagString } from "../arg-parser.js";
import { jsonOut } from "../format.js";
import type { CliContext, CliResult } from "../index.js";
import { SkillService } from "../../skills/service.js";

const HELP = `agent-recall skills — manage typed Skill assets

Usage:
  agent-recall skills list                       [--limit <n>] [--json]
  agent-recall skills search --query <text>      [--limit <n>] [--json]
  agent-recall skills show   <asset_id>          [--version <n>] [--json]
  agent-recall skills import
    --scope <global|project> [--project-id <id>]
    --source <path/to/SKILL.md>
    [--source-kind <manual|derived|imported>]
    [--owner <actor_id>]
    [--trust <user_confirmed|agent_observed|inferred>]
    [--sensitivity <normal|private|restricted>]
    [--json]
  agent-recall skills export <asset_id>          [--version <n>] --out <path>

Subcommands:
  list        List skill assets (compact summary, newest first).
  search      Lexical match over name + description + triggers.
  show        Inspect one skill asset (envelope + head + canonical body).
  import      Import a SKILL.md file as a new skill asset.
  export      Write the canonical SKILL.md bytes to disk.

Flags:
  --query <text>         Search query (search).
  --limit <n>            Cap result row count (list / search). Default 50.
  --version <n>          Pick a specific version (show / export). Default head.
  --scope <s>            Asset scope (import).
  --project-id <id>      Project id for scope=project (import).
  --source <path>        Path to a SKILL.md file to import.
  --source-kind <k>      manual | derived | imported (default manual).
  --owner <actor_id>     owner_actor_id for the new asset (default user:cli).
  --trust <lvl>          Trust level (default user_confirmed).
  --sensitivity <lvl>    Sensitivity (default normal).
  --out <path>           Output file for the export verb.
  --json                 Emit JSON.
`;

function service(ctx: CliContext): SkillService {
  return new SkillService(ctx.store);
}

function summaryToJson(s: ReturnType<SkillService["list"]>[number]): Record<string, unknown> {
  return {
    asset_id: s.asset_id,
    version: s.version,
    name: s.name,
    description: s.description,
    category: s.category,
    triggers: s.triggers,
    source: s.source,
    lifecycle_state: s.lifecycle_state,
    updated_at: s.updated_at
  };
}

function summaryToText(s: ReturnType<SkillService["list"]>[number]): string {
  const id = s.asset_id.padEnd(34);
  const name = s.name.padEnd(28);
  const state = s.lifecycle_state.padEnd(10);
  const ver = String(s.version).padStart(3);
  return `${id} ${name} ${state} v${ver}  ${s.updated_at}`;
}

function parseScope(value: string): "global" | "project" {
  if (value === "global" || value === "project") return value;
  throw new Error(
    `[usage_error] --scope must be 'global' | 'project', got '${value}'`
  );
}

function parseSourceKind(value: string): "manual" | "derived" | "imported" {
  if (value === "manual" || value === "derived" || value === "imported") {
    return value;
  }
  throw new Error(
    `[usage_error] --source-kind must be 'manual' | 'derived' | 'imported', got '${value}'`
  );
}

function parseTrust(value: string): "user_confirmed" | "agent_observed" | "inferred" {
  if (
    value === "user_confirmed" ||
    value === "agent_observed" ||
    value === "inferred"
  ) {
    return value;
  }
  throw new Error(
    `[usage_error] --trust must be 'user_confirmed' | 'agent_observed' | 'inferred', got '${value}'`
  );
}

function parseSensitivity(value: string): "normal" | "private" | "restricted" {
  if (value === "normal" || value === "private" || value === "restricted") {
    return value;
  }
  throw new Error(
    `[usage_error] --sensitivity must be 'normal' | 'private' | 'restricted', got '${value}'`
  );
}

function parseVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(
      `[usage_error] --version must be a positive integer, got '${value}'`
    );
  }
  return n;
}

export async function skillsCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0] ?? "help";
  switch (sub) {
    case "list":
      return skillsList(ctx);
    case "search":
      return skillsSearch(ctx);
    case "show":
      return skillsShow(ctx);
    case "import":
      return skillsImport(ctx);
    case "export":
      return skillsExport(ctx);
    case "help":
    case "--help":
    case "-h":
      return { exitCode: 0, stdout: HELP, stderr: "" };
    default:
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[usage_error] unknown skills subcommand: ${sub}\n\n${HELP}`
      };
  }
}

function skillsList(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const limit = flagNumber(ctx.args, "limit") ?? 50;
  const rows = service(ctx).list({ limit });
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({ skills: rows.map(summaryToJson) }),
      stderr: ""
    };
  }
  if (rows.length === 0) {
    return { exitCode: 0, stdout: "(no skills)\n", stderr: "" };
  }
  const lines: string[] = [];
  lines.push("ASSET_ID                         NAME                          STATE      VERSION  UPDATED");
  for (const r of rows) {
    lines.push(summaryToText(r));
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function skillsSearch(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const query = flagString(ctx.args, "query");
  if (query === undefined || query.length === 0) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --query is required" };
  }
  const limit = flagNumber(ctx.args, "limit") ?? 50;
  const rows = service(ctx).search({ query, limit });
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({ skills: rows.map(summaryToJson) }),
      stderr: ""
    };
  }
  if (rows.length === 0) {
    return { exitCode: 0, stdout: "(no matches)\n", stderr: "" };
  }
  const lines: string[] = [];
  lines.push("ASSET_ID                         NAME                          STATE      VERSION  UPDATED");
  for (const r of rows) {
    lines.push(summaryToText(r));
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function skillsShow(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const assetId = ctx.args.positional[1];
  if (assetId === undefined || assetId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] skills show requires an <asset_id> argument" };
  }
  let version: number | undefined;
  try {
    version = parseVersion(flagString(ctx.args, "version"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
  const result = service(ctx).get(assetId, version);
  if (result === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[asset_not_found] no skill with id ${assetId} (version=${version ?? "head"})`
    };
  }
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        asset_id: result.asset.asset_id,
        version: result.current_version.version,
        name: result.row.name,
        description: result.row.description,
        category: result.row.category,
        triggers: JSON.parse(result.row.triggers_json) as string[],
        when_to_use: result.row.when_to_use,
        when_not_to_use: result.row.when_not_to_use,
        compatibility: JSON.parse(result.row.compatibility_json) as Record<string, unknown>,
        source: result.row.source,
        body_hash: result.row.body_hash,
        resources: JSON.parse(result.row.resources_json) as unknown[],
        lifecycle_state: result.asset.lifecycle_state,
        skill_md_canonical: result.row.skill_md_canonical
      }),
      stderr: ""
    };
  }
  const lines: string[] = [];
  lines.push(`asset_id:        ${result.asset.asset_id}`);
  lines.push(`version:         ${result.current_version.version}`);
  lines.push(`name:            ${result.row.name}`);
  lines.push(`description:     ${result.row.description}`);
  if (result.row.category !== null) {
    lines.push(`category:        ${result.row.category}`);
  }
  const triggers = JSON.parse(result.row.triggers_json) as string[];
  if (triggers.length > 0) {
    lines.push(`triggers:        ${triggers.join(", ")}`);
  }
  if (result.row.when_to_use !== null) {
    lines.push(`when_to_use:     ${result.row.when_to_use}`);
  }
  if (result.row.when_not_to_use !== null) {
    lines.push(`when_not_to_use: ${result.row.when_not_to_use}`);
  }
  const compatibility = JSON.parse(result.row.compatibility_json) as Record<string, unknown>;
  if (Object.keys(compatibility).length > 0) {
    lines.push(`compatibility:   ${JSON.stringify(compatibility)}`);
  }
  lines.push(`source:          ${result.row.source}`);
  lines.push(`body_hash:       ${result.row.body_hash}`);
  lines.push(`lifecycle:       ${result.asset.lifecycle_state}`);
  lines.push(`--- SKILL.md ---`);
  lines.push(result.row.skill_md_canonical);
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function skillsImport(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  let scope: "global" | "project";
  try {
    const raw = flagString(ctx.args, "scope");
    if (raw === undefined) {
      return { exitCode: 1, stdout: "", stderr: "[usage_error] --scope is required" };
    }
    scope = parseScope(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
  const projectId = flagString(ctx.args, "project-id");
  const source = flagString(ctx.args, "source");
  if (source === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --source is required" };
  }
  let sourceKind: "manual" | "derived" | "imported";
  try {
    sourceKind = parseSourceKind(flagString(ctx.args, "source-kind") ?? "manual");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
  const owner = flagString(ctx.args, "owner") ?? "user:cli";
  let trustLevel: "user_confirmed" | "agent_observed" | "inferred" | undefined;
  try {
    const raw = flagString(ctx.args, "trust");
    trustLevel = raw === undefined ? undefined : parseTrust(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
  let sensitivity: "normal" | "private" | "restricted" | undefined;
  try {
    const raw = flagString(ctx.args, "sensitivity");
    sensitivity = raw === undefined ? undefined : parseSensitivity(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
  let skillMd: string;
  try {
    skillMd = readFileSync(source, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `[read_error] ${message}` };
  }
  try {
    const result = service(ctx).importSkillMd({
      skillMd,
      source: sourceKind,
      scope,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      owner_actor_id: owner,
      ...(trustLevel !== undefined ? { trust_level: trustLevel } : {}),
      ...(sensitivity !== undefined ? { sensitivity } : {})
    });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout:
        `asset_id=${result.asset_id} version=${result.version} ` +
        `body_hash=${result.body_hash}\n`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

function skillsExport(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const assetId = ctx.args.positional[1];
  if (assetId === undefined || assetId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] skills export requires an <asset_id> argument" };
  }
  let version: number | undefined;
  try {
    version = parseVersion(flagString(ctx.args, "version"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
  const out = flagString(ctx.args, "out");
  if (out === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --out is required" };
  }
  const body = service(ctx).exportSkillMd(assetId, version);
  if (body === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[asset_not_found] no skill with id ${assetId} (version=${version ?? "head"})`
    };
  }
  try {
    writeFileSync(out, body, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `[write_error] ${message}` };
  }
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({ asset_id: assetId, version: version ?? null, out }),
      stderr: ""
    };
  }
  return { exitCode: 0, stdout: `wrote ${out} (${body.length} bytes)\n`, stderr: "" };
}
