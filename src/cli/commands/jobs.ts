// src/cli/commands/jobs.ts
//
// v1.2.0-alpha.0 (issue #48): the agent-recall jobs
// subcommand. Four verbs:
//
//   list   -- filter by --state / --kind, --limit (default 50)
//   show   -- print a job + its runs + outputs as JSON
//   cancel -- request cancellation (terminal transition
//             happens at the next stage boundary)
//   run    -- one synchronous pass: enqueue + claim +
//             run all claimable jobs. --watch enters a
//             polling loop. --kind filters the claimable
//             jobs to a specific kind.
//
// The verbs are intentionally read-mostly; mutation
// outside enqueue is the runner's job. The CLI
// surfaces the durable DerivationJobStore shape so
// the operator can inspect state without going
// through the MCP server.

import { flagBool, flagNumber, flagString } from "../arg-parser.js";
import { jsonOut } from "../format.js";
import type { CliContext, CliResult } from "../index.js";
import { DerivationJobStore } from "../../jobs/service.js";
import { runOnce, makeLeaseOwner } from "../../jobs/runner.js";
import type {
  DerivationJobRow,
  DerivationJobState,
  DerivationOutputRow,
  DerivationRunRow
} from "../../sqlite-store.js";

const HELP = `agent-recall jobs — manage derivation jobs

Usage:
  agent-recall jobs list   [--state <s>] [--kind <k>] [--limit <n>] [--json]
  agent-recall jobs show   <job_id> [--json]
  agent-recall jobs cancel <job_id> [--json]
  agent-recall jobs run    [--kind <k>] [--once] [--max-jobs <n>] [--json]

Subcommands:
  list    List derivation jobs (newest first).
  show    Inspect a single job, its run rows and outputs.
  cancel  Request cancellation of a running or queued job.
  run     Claim + process claimable jobs. --once exits after a single pass.

Flags:
  --state <state>     Filter (list) to a single state.
  --kind <kind>       Filter (list / run) to a single kind.
  --limit <n>         Cap (list) row count (default 50).
  --max-jobs <n>      Cap (run --once) processed jobs (default 16).
  --once              Default for run: one pass.
  --json              Emit JSON.
`;

function parseState(value: string): DerivationJobState {
  switch (value) {
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return value;
    default:
      throw new Error(
        `[usage_error] invalid --state '${value}' (expected queued|running|succeeded|failed|cancelled)`
      );
  }
}

function jobStore(ctx: CliContext): DerivationJobStore {
  return new DerivationJobStore(ctx.store);
}

function jobRowToJson(row: DerivationJobRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    job_id: row.job_id,
    kind: row.kind,
    state: row.state,
    scope: row.scope,
    creator_actor_id: row.creator_actor_id,
    idempotency_key: row.idempotency_key,
    input_digest: row.input_digest,
    config_digest: row.config_digest,
    cursor_json: row.cursor_json,
    attempt_count: row.attempt_count,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (row.project_id !== null) out["project_id"] = row.project_id;
  if (row.lease_owner !== null) out["lease_owner"] = row.lease_owner;
  if (row.lease_expires_at !== null) out["lease_expires_at"] = row.lease_expires_at;
  if (row.cancel_requested_at !== null) out["cancel_requested_at"] = row.cancel_requested_at;
  if (row.next_retry_at !== null) out["next_retry_at"] = row.next_retry_at;
  if (row.error_code !== null) out["error_code"] = row.error_code;
  if (row.redacted_error !== null) out["redacted_error"] = row.redacted_error;
  if (row.started_at !== null) out["started_at"] = row.started_at;
  if (row.finished_at !== null) out["finished_at"] = row.finished_at;
  return out;
}

function runRowToJson(row: DerivationRunRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    run_id: row.run_id,
    job_id: row.job_id,
    stage: row.stage,
    status: row.status,
    input_refs_json: row.input_refs_json,
    output_refs_json: row.output_refs_json,
    policy_version: row.policy_version,
    started_at: row.started_at
  };
  if (row.provider_id !== null) out["provider_id"] = row.provider_id;
  if (row.model_id !== null) out["model_id"] = row.model_id;
  if (row.prompt_template_version !== null) out["prompt_template_version"] = row.prompt_template_version;
  if (row.prompt_hash !== null) out["prompt_hash"] = row.prompt_hash;
  if (row.result_digest !== null) out["result_digest"] = row.result_digest;
  if (row.finished_at !== null) out["finished_at"] = row.finished_at;
  return out;
}

function outputRowToJson(row: DerivationOutputRow): Record<string, unknown> {
  return {
    job_id: row.job_id,
    run_id: row.run_id,
    output_kind: row.output_kind,
    output_id: row.output_id,
    disposition: row.disposition,
    created_at: row.created_at
  };
}

function formatTs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return new Date(ms).toISOString();
}

export async function jobsCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0] ?? "help";
  switch (sub) {
    case "list":
      return jobsList(ctx);
    case "show":
      return jobsShow(ctx);
    case "cancel":
      return jobsCancel(ctx);
    case "run":
      return jobsRun(ctx);
    case "help":
    case "--help":
    case "-h":
      return { exitCode: 0, stdout: HELP, stderr: "" };
    default:
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[usage_error] unknown jobs subcommand: ${sub}\n\n${HELP}`
      };
  }
}

function jobsList(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const limit = flagNumber(ctx.args, "limit") ?? 50;
  const stateRaw = flagString(ctx.args, "state");
  const kind = flagString(ctx.args, "kind");
  const state = stateRaw === undefined ? undefined : parseState(stateRaw);
  const rows = jobStore(ctx).list({
    ...(state !== undefined ? { state } : {}),
    ...(kind !== undefined ? { kind } : {}),
    limit
  });
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ jobs: rows.map(jobRowToJson) }), stderr: "" };
  }
  const lines: string[] = [];
  lines.push("JOB_ID                            KIND                 STATE         ATT  CREATED");
  for (const r of rows) {
    const id = r.job_id.padEnd(34);
    const k = r.kind.slice(0, 20).padEnd(20);
    const s = r.state.padEnd(13);
    const a = String(r.attempt_count).padStart(3);
    const t = formatTs(r.created_at);
    lines.push(`${id} ${k} ${s} ${a}  ${t}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function jobsShow(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const positional = ctx.args.positional;
  const job_id = positional[1];
  if (job_id === undefined || job_id === "") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] jobs show requires a <job_id> argument"
    };
  }
  const inspection = jobStore(ctx).inspect(job_id);
  if (inspection === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[job_not_found] no derivation job with id ${job_id}`
    };
  }
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        job: jobRowToJson(inspection.job),
        runs: inspection.runs.map(runRowToJson),
        outputs: inspection.outputs.map(outputRowToJson)
      }),
      stderr: ""
    };
  }
  const lines: string[] = [];
  const j = inspection.job;
  lines.push(`job_id:           ${j.job_id}`);
  lines.push(`kind:             ${j.kind}`);
  lines.push(`state:            ${j.state}`);
  lines.push(`scope:            ${j.scope}${j.project_id ? ` (${j.project_id})` : ""}`);
  lines.push(`creator:          ${j.creator_actor_id}`);
  lines.push(`idempotency_key:  ${j.idempotency_key}`);
  lines.push(`input_digest:     ${j.input_digest}`);
  lines.push(`config_digest:    ${j.config_digest}`);
  lines.push(`attempt_count:    ${j.attempt_count}`);
  lines.push(`created_at:       ${formatTs(j.created_at)}`);
  lines.push(`started_at:       ${formatTs(j.started_at)}`);
  lines.push(`finished_at:      ${formatTs(j.finished_at)}`);
  if (j.lease_owner !== null) lines.push(`lease_owner:      ${j.lease_owner}`);
  if (j.lease_expires_at !== null) lines.push(`lease_expires_at: ${formatTs(j.lease_expires_at)}`);
  if (j.cancel_requested_at !== null) lines.push(`cancel_requested_at: ${formatTs(j.cancel_requested_at)}`);
  if (j.next_retry_at !== null) lines.push(`next_retry_at:    ${formatTs(j.next_retry_at)}`);
  if (j.error_code !== null) lines.push(`error_code:       ${j.error_code}`);
  if (j.redacted_error !== null) lines.push(`redacted_error:   ${j.redacted_error}`);
  lines.push("");
  lines.push(`runs (${inspection.runs.length}):`);
  for (const r of inspection.runs) {
    lines.push(
      `  - ${r.run_id} stage=${r.stage} status=${r.status} ` +
        `started_at=${formatTs(r.started_at)}` +
        (r.finished_at !== null ? ` finished_at=${formatTs(r.finished_at)}` : "")
    );
  }
  lines.push("");
  lines.push(`outputs (${inspection.outputs.length}):`);
  for (const o of inspection.outputs) {
    lines.push(
      `  - ${o.output_kind}:${o.output_id} disposition=${o.disposition} run=${o.run_id}`
    );
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function jobsCancel(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const positional = ctx.args.positional;
  const job_id = positional[1];
  if (job_id === undefined || job_id === "") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] jobs cancel requires a <job_id> argument"
    };
  }
  const ok = jobStore(ctx).requestCancel(job_id, Date.now());
  if (!ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[job_not_found_or_terminal] no cancellable job with id ${job_id}`
    };
  }
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ job_id, cancel_requested: true }), stderr: "" };
  }
  return { exitCode: 0, stdout: `cancel requested for ${job_id}\n`, stderr: "" };
}

async function jobsRun(ctx: CliContext): Promise<CliResult> {
  const json = flagBool(ctx.args, "json");
  const kind = flagString(ctx.args, "kind");
  const watch = flagBool(ctx.args, "watch");
  const maxJobs = flagNumber(ctx.args, "max-jobs") ?? 16;
  if (watch) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] jobs run --watch is not yet implemented; use --once for the synchronous pass"
    };
  }
  // No executors are registered in v1.2.0-alpha.0: every
  // claimable job fails with `no executor registered for
  // kind '<kind>'`. This is the documented Phase 0
  // surface — the enqueue / claim / cancel / inspect
  // lifecycle is exercisable end-to-end; the real
  // executors land in Phase 2 (#50, #53, #54).
  const result = await runOnce(ctx.store, [], {
    ...(kind !== undefined ? { kind } : {}),
    lease_owner: makeLeaseOwner(),
    max_jobs: maxJobs
  });
  if (json) {
    return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
  }
  return {
    exitCode: 0,
    stdout:
      `attempted=${result.attempted} succeeded=${result.succeeded} ` +
      `failed=${result.failed} cancelled=${result.cancelled}\n`,
    stderr: ""
  };
}
