// src/format-exporters.ts
//
// Stage 13 PR10 (spec § 6.7): the format router. Picks
// the right exporter based on `input.format` and
// delegates to the unified `CanonicalExporter` in
// `src/portability/`. Before PR10 this file held its own
// JsonExporter + YamlExporter classes; PR10 removed
// them because the collision-safe filename map and the
// atomic publish logic now live in the portability
// module and the three renderers are format-specific
// pure functions rather than full exporter classes.

import { CanonicalExporter, type ExportScopeInput as CanonicalInput, type ExportScopeResult } from "./portability/exporter.js";
import type { ExportFormat } from "./portability/canonical-model.js";
// v1.1.3 GATE-03 (issue #33): the router threads
// the `authorization` field through to the
// `MarkdownExporter` so the fail-closed throw path
// is reached on an unauthorized restricted export.
import { MarkdownExporter, type ExportScopeInput as MarkdownInput } from "./markdown-exporter.js";

export type { ExportFormat };

// Re-export the input / result types under the legacy
// names so callers that imported from this module keep
// working. The router's input type is the union of
// the markdownexporter's (which carries the optional
// `authorization`) and the canonical one (which does
// not).
export type ExportScopeInput = CanonicalInput & MarkdownInput;
export type { ExportScopeResult };

/**
 * Stage 8 / Stage 13: FormatRouter. Picks the right
 * format and delegates. Default is "markdown" for
 * backward compatibility with callers that predate
 * Stage 8.
 */
export class FormatRouter {
  private readonly exporter: CanonicalExporter;
  // v1.1.3 GATE-03 (issue #33): the router can also
  // route to the markdown-only exporter so the
  // `authorization` field on the input is honoured
  // (the `MarkdownExporter.exportScope` is the
  // single point that throws `ForbiddenVisibilityError`).
  private readonly markdownExporter: MarkdownExporter;

  constructor(private readonly exportRoot: string) {
    this.exporter = new CanonicalExporter(exportRoot);
    this.markdownExporter = new MarkdownExporter(exportRoot);
  }

  export(input: ExportScopeInput): ExportScopeResult {
    // v1.1.3 GATE-03 (issue #33): the markdown
    // path delegates to the `MarkdownExporter` so
    // the `authorization` throw path is reached.
    // The JSON / YAML paths delegate to the
    // canonical exporter (no throw; the envelope's
    // `max_sensitivity` field is the audit signal).
    if (input.format === undefined || input.format === "markdown") {
      return this.markdownExporter.exportScope(input);
    }
    return this.exporter.exportScope(input);
  }

  // Convenience for the CLI / doctor / smoke tests that
  // want to inspect the canonical model before writing.
  stage(input: ExportScopeInput): { format: ExportFormat; result: ExportScopeResult; canonical: unknown } {
    const staged = this.exporter.stageScope(input);
    return {
      format: staged.format,
      result: { indexPath: staged.indexPath, topicPaths: staged.topicPaths },
      canonical: staged.canonical
    };
  }
}
