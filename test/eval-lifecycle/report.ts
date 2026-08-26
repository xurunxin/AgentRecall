// test/eval-lifecycle/report.ts
//
// v1.2.0-alpha.2 (issue #55): the lifecycle
// evaluation report formatter. Two outputs:
// 1. `formatReportJson` — the canonical
//    machine-readable artifact the CI step
//    publishes as a workflow artifact so a
//    regression can be diffed against the
//    previous accepted run.
// 2. `formatReportMarkdown` — the human-readable
//    summary the release manager reviews before
//    merging. The Markdown links the per-fixture
//    status to the fixture id and dimension so a
//    reader can drill into the underlying
//    service-layer test for context.

import type { CorpusReport, FixtureResult } from "./schemas.js";

const JSON_INDENT = 2;

export function formatReportJson(report: CorpusReport): string {
  return JSON.stringify(report, null, JSON_INDENT);
}

function resultLine(result: FixtureResult): string {
  const status = result.passed ? "PASS" : "FAIL";
  const notes =
    result.notes.length === 0
      ? ""
      : ` (${result.notes.join("; ")})`;
  const err =
    result.error === null
      ? ""
      : ` — error: \`${result.error}\``;
  return `- ${status} \`${result.fixture_id}\` [${result.dimension}/${result.workstream}/${result.fixture_class}] ${result.duration_ms}ms${notes}${err}`;
}

function dimensionRollup(
  report: CorpusReport
): Map<string, { passed: number; total: number }> {
  const rollup = new Map<string, { passed: number; total: number }>();
  for (const r of report.results) {
    const key = r.dimension;
    const cur = rollup.get(key) ?? { passed: 0, total: 0 };
    cur.total += 1;
    if (r.passed) cur.passed += 1;
    rollup.set(key, cur);
  }
  return rollup;
}

function workstreamRollup(
  report: CorpusReport
): Map<string, { passed: number; total: number }> {
  const rollup = new Map<string, { passed: number; total: number }>();
  for (const r of report.results) {
    const key = r.workstream;
    const cur = rollup.get(key) ?? { passed: 0, total: 0 };
    cur.total += 1;
    if (r.passed) cur.passed += 1;
    rollup.set(key, cur);
  }
  return rollup;
}

export function formatReportMarkdown(report: CorpusReport): string {
  const lines: string[] = [];
  lines.push(`# Lifecycle evaluation report — ${report.corpus_version}`);
  lines.push("");
  lines.push(
    `- Generated at: \`${report.generated_at}\``
  );
  lines.push(
    `- Fixtures: ${report.totals.fixture_count} (passed ${report.totals.passed} / failed ${report.totals.failed})`
  );
  lines.push(`- Total duration: ${report.totals.duration_ms}ms`);
  lines.push(
    `- Safety gate: ${report.safety_gate.passed ? "PASS" : "FAIL"} (${report.safety_gate.reasons.length} reason(s))`
  );
  if (report.baselines !== undefined) {
    const b = report.baselines;
    lines.push(
      `- Baselines: ${b.passed ? "PASS" : "FAIL"} (${b.reasons.length} reason(s))`
    );
  }
  lines.push("");
  lines.push("## By dimension");
  lines.push("");
  for (const [dim, agg] of dimensionRollup(report)) {
    lines.push(`- **${dim}**: ${agg.passed}/${agg.total}`);
  }
  lines.push("");
  lines.push("## By workstream");
  lines.push("");
  for (const [ws, agg] of workstreamRollup(report)) {
    lines.push(`- **${ws}**: ${agg.passed}/${agg.total}`);
  }
  lines.push("");
  if (report.baselines !== undefined) {
    lines.push("## Quality baselines (v0.4.0 / issue #55c)");
    lines.push("");
    lines.push("| Metric | Measured | Declared |");
    lines.push("| --- | --- | --- |");
    const m = report.baselines.measured;
    const d = report.baselines.declared;
    lines.push(
      `| distillation_supported_claim_rate | ${m.distillation_supported_claim_rate.toFixed(4)} | ${d.distillation_supported_claim_rate.toFixed(4)} |`
    );
    lines.push(
      `| distillation_hallucination_rejection_rate | ${m.distillation_hallucination_rejection_rate.toFixed(4)} | ${d.distillation_hallucination_rejection_rate.toFixed(4)} |`
    );
    lines.push(
      `| bootstrap_hash_byte_determinism | ${m.bootstrap_hash_byte_determinism.toFixed(4)} | ${d.bootstrap_hash_byte_determinism.toFixed(4)} |`
    );
    lines.push("");
    if (report.baselines.reasons.length > 0) {
      lines.push("### Baseline reasons");
      lines.push("");
      for (const reason of report.baselines.reasons) {
        lines.push(`- ${reason}`);
      }
      lines.push("");
    }
  }
  lines.push("## Per-fixture results");
  lines.push("");
  for (const r of report.results) {
    lines.push(resultLine(r));
  }
  lines.push("");
  if (report.safety_gate.reasons.length > 0) {
    lines.push("## Safety gate reasons");
    lines.push("");
    for (const reason of report.safety_gate.reasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
