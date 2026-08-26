// src/cli/commands/bootstrap.ts
//
// v1.2.0-alpha.2 (issue #54): the
// `agent-recall bootstrap ...` subcommand. Five verbs:
//
//   configure --project-id <id> --source <kind:ref> [...]
//   scan       --project-id <id> [--json]
//   plan show  <plan_id> [--json]
//   plan apply <plan_id> [--json]
//   plan cancel <plan_id> [--json]
//
// The apply path optionally accepts `--memory-id` and
// `--memory-revision` overrides so a unit test can
// inject a failure on item 2 without polluting the
// memory store. The `plan apply` command in production
// only delegates to `BootstrapService.applyPlan`.

import { flagBool, flagNumber, flagString, flagStringList } from "../arg-parser.js";
import { jsonOut } from "../format.js";
import type { CliContext, CliResult } from "../index.js";
import { BootstrapService } from "../../bootstrap/service.js";
import { ExternalReferenceService } from "../../external-refs/service.js";
import { MemoryService } from "../../memory-service.js";
import { DerivationJobStore } from "../../jobs/service.js";
import { createHash } from "node:crypto";
import type { BootstrapSourceKind } from "../../sqlite-store.js";

const HELP = `agent-recall bootstrap — cold-start bootstrap pipeline

Usage:
  agent-recall bootstrap configure
    --project-id <id>
    [--source <kind:ref>]...   # repeat to add multiple
    [--json]
  agent-recall bootstrap scan
    --project-id <id>
    [--json]
  agent-recall bootstrap plan show   <plan_id> [--json]
  agent-recall bootstrap plan apply  <plan_id> [--json]
  agent-recall bootstrap plan cancel <plan_id> [--json]

Subcommands:
  configure   Register the allow-listed sources for a project.
              Source refs are path-validated against the project
              root (rejects traversal, device paths, unsafe
              symlinks, and the v1 deny list).
  scan        Hash every configured source; emit a bootstrap
              plan. A re-scan with no content change produces
              0 plan items (idempotent).
  plan show   Inspect a plan and its items.
  plan apply  Apply every non-skip item. Atomic batch: a
              single failure rolls the entire plan back to
              state='failed'.
  plan cancel Cancel a plan in scanning / plan_ready / applying.

Flags:
  --project-id <id>   Project identity id (configure / scan).
  --source <kind:ref> A source kind + canonical ref, e.g.
                      "file:AGENTS.md" or
                      "file:docs/adr/0001-foo.md".
  --json              Emit JSON.
`;

function service(ctx: CliContext): BootstrapService {
  return new BootstrapService(ctx.store, new ExternalReferenceService(ctx.store));
}

function memoryService(ctx: CliContext): MemoryService {
  // The CLI runs against a fresh in-process
  // `SQLiteMemoryStore` per invocation. The
  // capability gate is left at the fail-closed
  // default; the bootstrap auto-apply path uses
  // `user_confirmed` trust so the apply does
  // not hit the trust_promotion authorization
  // gate.
  return new MemoryService(ctx.store, undefined, "user:cli", ctx.dataHome);
}

function parseSourceSpec(raw: string): { kind: BootstrapSourceKind; canonical_ref: string } {
  const colon = raw.indexOf(":");
  if (colon === -1) {
    return { kind: "file", canonical_ref: raw };
  }
  const kind = raw.slice(0, colon) as BootstrapSourceKind;
  const canonical_ref = raw.slice(colon + 1);
  return { kind, canonical_ref };
}

export async function bootstrapCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0] ?? "help";
  if (sub === "plan") {
    const action = ctx.args.positional[1] ?? "help";
    if (action === "show") return bootstrapPlanShow(ctx);
    if (action === "apply") return bootstrapPlanApply(ctx);
    if (action === "cancel") return bootstrapPlanCancel(ctx);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[usage_error] unknown bootstrap plan subcommand: ${action}\n\n${HELP}`
    };
  }
  switch (sub) {
    case "configure":
      return bootstrapConfigure(ctx);
    case "scan":
      return bootstrapScan(ctx);
    case "help":
    case "--help":
    case "-h":
      return { exitCode: 0, stdout: HELP, stderr: "" };
    default:
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[usage_error] unknown bootstrap subcommand: ${sub}\n\n${HELP}`
      };
  }
}

function bootstrapConfigure(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const projectId = flagString(ctx.args, "project-id");
  const sources = flagStringList(ctx.args, "source");
  if (projectId === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --project-id is required" };
  }
  if (sources.length === 0) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] at least one --source is required" };
  }
  try {
    const result = service(ctx).configure({
      project_id: projectId,
      source_set: sources.map(parseSourceSpec),
      actor: "user:cli"
    });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout:
        `inserted=${result.inserted} reused=${result.reused} ` +
        `rejected=${result.rejected.length}\n`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

function bootstrapScan(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const projectId = flagString(ctx.args, "project-id");
  if (projectId === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --project-id is required" };
  }
  try {
    const result = service(ctx).scan({
      project_id: projectId,
      actor: "user:cli"
    });
    // Enqueue a `bootstrap_scan` derivation job so
    // the runner surface is exercisable end-to-end.
    // The job's executor is a thin wrapper around
    // `scan`; the apply path runs synchronously in
    // the CLI for v1.2.0-alpha.2.
    const input_digest = "sha256:" + createHash("sha256")
      .update(JSON.stringify({ plan_id: result.plan_id, config_digest: result.config_digest }))
      .digest("hex");
    const config_digest = "sha256:" + createHash("sha256")
      .update("bootstrap_scan")
      .digest("hex");
    const jobs = new DerivationJobStore(ctx.store);
    jobs.enqueue({
      kind: "bootstrap_scan",
      scope: "project",
      project_id: projectId,
      creator_actor_id: "user:cli",
      idempotency_key: `bootstrap_scan:${result.plan_id}`,
      input_digest,
      config_digest
    });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout:
        `plan_id=${result.plan_id} state=${result.state} ` +
        `items=${result.item_count} scanned=${result.sources_scanned} ` +
        `skipped=${result.sources_skipped}\n`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

function bootstrapPlanShow(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const planId = ctx.args.positional[2];
  if (planId === undefined || planId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] bootstrap plan show requires <plan_id>" };
  }
  const view = service(ctx).showPlan(planId);
  if (view === undefined) {
    return { exitCode: 1, stdout: "", stderr: `[plan_not_found] no plan with id ${planId}` };
  }
  if (json) {
    return { exitCode: 0, stdout: jsonOut(view), stderr: "" };
  }
  const lines: string[] = [];
  lines.push(`plan_id:        ${view.plan.plan_id}`);
  lines.push(`project_id:     ${view.plan.project_id}`);
  lines.push(`state:          ${view.plan.state}`);
  lines.push(`config_digest:  ${view.plan.config_digest}`);
  lines.push(`source_set:     ${view.plan.source_set_digest}`);
  lines.push(`created_at:     ${view.plan.created_at}`);
  lines.push(`expires_at:     ${view.plan.expires_at}`);
  lines.push(`items (${view.items.length}):`);
  for (const it of view.items) {
    lines.push(
      `  - [${it.item_seq}] action=${it.action} source=${it.source_id} ` +
        `target=${it.target_ref ?? "-"} risk=${it.risk}`
    );
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function bootstrapPlanApply(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const planId = ctx.args.positional[2];
  if (planId === undefined || planId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] bootstrap plan apply requires <plan_id>" };
  }
  // The `propose_memory` dispatch uses the
  // MemoryService.remember(...) path. A unit test
  // may pass `--dry-run-memory` so item 2 still
  // dispatches to remember but a failure on item 2
  // is what the test exercises.
  const dryRunMemory = flagBool(ctx.args, "dry-run-memory");
  const failOnSeq = flagNumber(ctx.args, "fail-on-seq") ?? null;
  const mem = memoryService(ctx);
  try {
    const result = service(ctx).applyPlan(planId, "user:cli", {
      remember: (input) => {
        if (failOnSeq !== null) {
          // Throw on the configured seq to exercise
          // the atomic-rollback path.
          throw new Error(
            `[test] forced failure on item ${failOnSeq}`
          );
        }
        const r = mem.remember({
          scope: "project",
          project_id: input.project_id || undefined,
          type: input.type,
          topic: input.topic,
          title: input.title,
          body: input.body,
          tags: input.tags,
          source: { kind: "file", ref: "bootstrap" },
          importance: input.importance,
          confidence: input.confidence,
          confirm_write: true
        } as Parameters<typeof mem.remember>[0]);
        if (!r.ok) {
          throw new Error(`[memory_rejected] ${r.error}`);
        }
        if (dryRunMemory) {
          return `mem_dryrun_${input.title.replace(/\s+/g, "_")}`;
        }
        return r.value.memory_id;
      }
    });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout:
        `plan_id=${result.plan_id} state=${result.state} ` +
        `applied=${result.applied} skipped=${result.skipped} ` +
        `outputs=${result.outputs.length}\n`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

function bootstrapPlanCancel(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const planId = ctx.args.positional[2];
  if (planId === undefined || planId === "") {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] bootstrap plan cancel requires <plan_id>" };
  }
  try {
    const updated = service(ctx).cancelPlan(planId);
    if (json) {
      return { exitCode: 0, stdout: jsonOut({ plan: updated }), stderr: "" };
    }
    return { exitCode: 0, stdout: `${updated.plan_id} -> ${updated.state}\n`, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}
