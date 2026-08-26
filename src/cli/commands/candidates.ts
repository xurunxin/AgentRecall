// src/cli/commands/candidates.ts
//
// v1.2.0-alpha.2 (issue #50): the `agent-recall candidates
// ...` subcommand. Five verbs:
//
//   list     -- by job (--job <id>) or all candidate rows
//   show     -- a single candidate with its evidence + actions
//   accept   -- accept (review) one or all proposed candidates
//   reject   -- reject (review) one or all proposed candidates
//   apply    -- apply an accepted candidate (or all accepted
//               candidates for a job) to the memory store
//
// The verbs map 1:1 to the `DistillationService` methods
// (`listForJob` / `show` / `setReview` / `apply`).

import { flagBool, flagString } from "../arg-parser.js";
import { jsonOut } from "../format.js";
import { type CliContext, type CliResult, buildCliWriteContext } from "../index.js";
import { DerivationJobStore } from "../../jobs/service.js";
import { DistillationService } from "../../distillation/service.js";
import { SessionService } from "../../sessions/service.js";
import { MemoryWriteService } from "../../services/memory-write-service.js";
import type {
  CandidateActionRow,
  CandidateEvidenceRow,
  DerivationCandidateRow
} from "../../sqlite-store.js";

const HELP = `agent-recall candidates — manage derivation candidates

Usage:
  agent-recall candidates list   [--job <id>] [--json]
  agent-recall candidates show   <candidate_id> [--json]
  agent-recall candidates accept <candidate_id> [--actor <id>] [--all] [--json]
  agent-recall candidates reject <candidate_id> [--actor <id>] [--all] [--json]
  agent-recall candidates apply  [--actor <id>] [--all] [--job <id>] [--json]

Subcommands:
  list    List candidates for a job (or all if --job is omitted).
  show    Inspect a single candidate with its evidence + actions.
  accept  Accept one candidate (or all 'proposed' candidates with --all).
  reject  Reject one candidate (or all 'proposed' candidates with --all).
  apply   Apply an accepted candidate (or all 'accepted' with --all) to memory entries.

Flags:
  --job <id>    Filter (list) to a single job, or scope (apply --all) to one job.
  --actor <id>  Reviewer / apply actor id (defaults to "user:cli").
  --all         Apply the verb to every eligible candidate in scope.
  --json        Emit JSON.
`;

function services(ctx: CliContext): {
  distillation: DistillationService;
  jobStore: DerivationJobStore;
  sessionService: SessionService;
} {
  const jobStore = new DerivationJobStore(ctx.store);
  const sessionService = new SessionService(ctx.store, ctx.identityResolver);
  const writeContext = buildCliWriteContext(ctx);
  const writeService = new MemoryWriteService(writeContext);
  const distillation = new DistillationService(ctx.store, sessionService, jobStore, {
    memoryWriteService: writeService
  });
  return { distillation, jobStore, sessionService };
}

export async function candidatesCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0] ?? "help";
  switch (sub) {
    case "list":
      return candidatesList(ctx);
    case "show":
      return candidatesShow(ctx);
    case "accept":
      return candidatesAccept(ctx);
    case "reject":
      return candidatesReject(ctx);
    case "apply":
      return candidatesApply(ctx);
    case "help":
    case "--help":
    case "-h":
      return { exitCode: 0, stdout: HELP, stderr: "" };
    default:
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[usage_error] unknown candidates subcommand: ${sub}\n\n${HELP}`
      };
  }
}

function candidatesList(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const jobId = flagString(ctx.args, "job");
  const { distillation } = services(ctx);
  const rows = jobId === undefined
    ? allCandidates(distillation)
    : distillation.listForJob(jobId);
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ candidates: rows.map(candidateToJson) }), stderr: "" };
  }
  const lines: string[] = [];
  lines.push("CANDIDATE_ID                       KIND     STATE     CONF  EXTRACTOR");
  for (const r of rows) {
    const id = r.candidate.candidate_id.padEnd(34);
    const k = r.candidate.candidate_kind.padEnd(8);
    const s = r.candidate.state.padEnd(9);
    const c = r.candidate.confidence.toFixed(2).padStart(4);
    const e = r.candidate.extractor_id;
    lines.push(`${id} ${k} ${s} ${c}  ${e}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function allCandidates(
  distillation: DistillationService
): ReturnType<DistillationService["listForJob"]> {
  // The distillation service does not expose an
  // "all" verb by design (every caller scopes by
  // job_id). The CLI is the only place we need the
  // flat list, so we walk the store's
  // `listCandidatesForJob` from the underlying
  // sqlite store via the job store's list of jobs.
  // The walk is bounded by the job list (which is
  // already paginated at 50 by the CLI default).
  const { jobStore, store } = underlyingStores(distillation);
  const jobs = jobStore.list({ limit: 200 });
  const out: ReturnType<DistillationService["listForJob"]> = [];
  for (const job of jobs) {
    if (job.job_id === "job_standalone") continue;
    for (const c of store.listCandidatesForJob(job.job_id)) {
      out.push(distillation.show(c.candidate_id) ?? { candidate: c, evidence: [], actions: [] });
    }
  }
  return out;
}

function underlyingStores(distillation: DistillationService): {
  store: import("../../sqlite-store.js").SQLiteMemoryStore;
  jobStore: DerivationJobStore;
} {
  // The DistillationService does not expose its
  // internal `store` / `jobStore` references. The CLI
  // needs them to walk the full candidate list.
  // We rely on the public `list` + `show` methods
  // and re-derive the store via the job store's
  // constructor argument (the same store instance).
  return {
    store: (distillation as unknown as { store: import("../../sqlite-store.js").SQLiteMemoryStore }).store,
    jobStore: (distillation as unknown as { jobStore: DerivationJobStore }).jobStore
  };
}

function candidatesShow(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const candidateId = ctx.args.positional[1];
  if (candidateId === undefined || candidateId === "") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] candidates show requires a <candidate_id> argument"
    };
  }
  const { distillation } = services(ctx);
  const inspection = distillation.show(candidateId);
  if (inspection === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[candidate_not_found] no candidate with id ${candidateId}`
    };
  }
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        candidate: candidateToJson(inspection),
        evidence: inspection.evidence.map(evidenceToJson),
        actions: inspection.actions.map(actionToJson)
      }),
      stderr: ""
    };
  }
  const lines: string[] = [];
  const c = inspection.candidate;
  lines.push(`candidate_id: ${c.candidate_id}`);
  lines.push(`job_id:       ${c.job_id}`);
  lines.push(`run_id:       ${c.run_id}`);
  lines.push(`kind:         ${c.candidate_kind}`);
  lines.push(`state:        ${c.state}`);
  lines.push(`scope:        ${c.proposed_scope}${c.proposed_project_id ? ` (${c.proposed_project_id})` : ""}`);
  lines.push(`extractor:    ${c.extractor_id}@${c.extractor_version}`);
  lines.push(`confidence:   ${c.confidence}`);
  lines.push(`title:        ${c.proposed_title ?? "—"}`);
  lines.push(`topic:        ${c.proposed_topic ?? "—"}`);
  lines.push(`tags:         ${c.proposed_tags_json}`);
  if (c.reviewed_at !== null) lines.push(`reviewed_at:  ${new Date(c.reviewed_at).toISOString()}`);
  if (c.reviewed_by_actor_id !== null) lines.push(`reviewer:     ${c.reviewed_by_actor_id}`);
  if (c.applied_at !== null) lines.push(`applied_at:   ${new Date(c.applied_at).toISOString()}`);
  lines.push("");
  lines.push(`evidence (${inspection.evidence.length}):`);
  for (const e of inspection.evidence) {
    lines.push(
      `  - role=${e.evidence_role} session=${e.session_id ?? "—"} event=${e.event_id ?? "—"} digest=${e.excerpt_digest}`
    );
  }
  lines.push("");
  lines.push(`actions (${inspection.actions.length}):`);
  for (const a of inspection.actions) {
    lines.push(
      `  - action=${a.action} risk=${a.risk} rationale="${a.rationale}" targets=${a.target_memory_ids_json}`
    );
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function candidatesAccept(ctx: CliContext): CliResult {
  return reviewCandidates(ctx, "accept");
}

function candidatesReject(ctx: CliContext): CliResult {
  return reviewCandidates(ctx, "reject");
}

function reviewCandidates(
  ctx: CliContext,
  decision: "accept" | "reject"
): CliResult {
  const json = flagBool(ctx.args, "json");
  const all = flagBool(ctx.args, "all");
  const actor = flagString(ctx.args, "actor") ?? "user:cli";
  const { distillation } = services(ctx);
  const positional = ctx.args.positional[1];
  if (all) {
    const candidates = collectAllProposed(distillation);
    const updated: DerivationCandidateRow[] = [];
    for (const c of candidates) {
      updated.push(distillation.setReview(c.candidate_id, decision, actor));
    }
    if (json) {
      return { exitCode: 0, stdout: jsonOut({ updated: updated.map((c) => ({ candidate_id: c.candidate_id, state: c.state })) }), stderr: "" };
    }
    return { exitCode: 0, stdout: `${decision}ed ${updated.length} candidates\n`, stderr: "" };
  }
  if (positional === undefined || positional === "") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[usage_error] candidates ${decision} requires a <candidate_id> argument (or --all)`
    };
  }
  try {
    const updated = distillation.setReview(positional, decision, actor);
    if (json) {
      return { exitCode: 0, stdout: jsonOut({ candidate_id: updated.candidate_id, state: updated.state }), stderr: "" };
    }
    return { exitCode: 0, stdout: `${decision}ed ${updated.candidate_id}\n`, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

function candidatesApply(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const all = flagBool(ctx.args, "all");
  const jobId = flagString(ctx.args, "job");
  const actor = flagString(ctx.args, "actor") ?? "user:cli";
  const positional = ctx.args.positional[1];
  const { distillation } = services(ctx);
  if (all) {
    const accepted = collectAllAccepted(distillation, jobId);
    const result = distillation.apply({ acceptedCandidateIds: accepted, actor });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `applied=${result.applied} stale=${result.stale} failed=${result.failed}\n`,
      stderr: ""
    };
  }
  if (positional === undefined || positional === "") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] candidates apply requires a <candidate_id> argument (or --all)"
    };
  }
  try {
    const result = distillation.apply({ acceptedCandidateIds: [positional], actor });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `applied=${result.applied} stale=${result.stale} failed=${result.failed}\n`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

function collectAllProposed(
  distillation: DistillationService
): DerivationCandidateRow[] {
  const { store, jobStore } = underlyingStores(distillation);
  const out: DerivationCandidateRow[] = [];
  for (const job of jobStore.list({ limit: 500 })) {
    if (job.job_id === "job_standalone") continue;
    for (const c of store.listCandidatesForJob(job.job_id)) {
      if (c.state === "proposed") out.push(c);
    }
  }
  return out;
}

function collectAllAccepted(
  distillation: DistillationService,
  jobId: string | undefined
): string[] {
  const { store, jobStore } = underlyingStores(distillation);
  if (jobId !== undefined) {
    return store
      .listCandidatesForJob(jobId)
      .filter((c) => c.state === "accepted")
      .map((c) => c.candidate_id);
  }
  const out: string[] = [];
  for (const job of jobStore.list({ limit: 500 })) {
    if (job.job_id === "job_standalone") continue;
    for (const c of store.listCandidatesForJob(job.job_id)) {
      if (c.state === "accepted") out.push(c.candidate_id);
    }
  }
  return out;
}

function candidateToJson(
  row:
    | DerivationCandidateRow
    | {
        candidate: DerivationCandidateRow;
        evidence: CandidateEvidenceRow[];
        actions: CandidateActionRow[];
      }
): Record<string, unknown> {
  const c = "candidate" in row ? row.candidate : row;
  return {
    candidate_id: c.candidate_id,
    job_id: c.job_id,
    run_id: c.run_id,
    candidate_kind: c.candidate_kind,
    proposed_type: c.proposed_type,
    proposed_topic: c.proposed_topic,
    proposed_title: c.proposed_title,
    proposed_body: c.proposed_body,
    proposed_tags: JSON.parse(c.proposed_tags_json) as string[],
    proposed_scope: c.proposed_scope,
    proposed_project_id: c.proposed_project_id,
    proposed_tier: c.proposed_tier,
    proposed_trust_level: c.proposed_trust_level,
    proposed_sensitivity: c.proposed_sensitivity,
    confidence: c.confidence,
    state: c.state,
    extractor_id: c.extractor_id,
    extractor_version: c.extractor_version,
    content_hash: c.content_hash,
    created_at: c.created_at,
    reviewed_at: c.reviewed_at,
    reviewed_by_actor_id: c.reviewed_by_actor_id,
    applied_at: c.applied_at,
    expected_target_revision: c.expected_target_revision
  };
}

function evidenceToJson(row: CandidateEvidenceRow): Record<string, unknown> {
  return {
    candidate_id: row.candidate_id,
    evidence_role: row.evidence_role,
    session_id: row.session_id,
    event_id: row.event_id,
    message_id: row.message_id,
    tool_call_id: row.tool_call_id,
    file_ref: row.file_ref,
    excerpt_digest: row.excerpt_digest
  };
}

function actionToJson(row: CandidateActionRow): Record<string, unknown> {
  return {
    candidate_id: row.candidate_id,
    action: row.action,
    target_memory_ids: JSON.parse(row.target_memory_ids_json) as string[],
    expected_revisions: JSON.parse(row.expected_revisions_json) as number[],
    rationale: row.rationale,
    conflict_signals: JSON.parse(row.conflict_signals_json) as string[],
    risk: row.risk
  };
}
