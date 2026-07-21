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

export type { ExportFormat };

// Re-export the input / result types under the legacy
// names so callers that imported from this module keep
// working.
export type ExportScopeInput = CanonicalInput;
export type { ExportScopeResult };

/**
 * Stage 8 / Stage 13: FormatRouter. Picks the right
 * format and delegates. Default is "markdown" for
 * backward compatibility with callers that predate
 * Stage 8.
 */
export class FormatRouter {
  private readonly exporter: CanonicalExporter;

  constructor(private readonly exportRoot: string) {
    this.exporter = new CanonicalExporter(exportRoot);
  }

  export(input: ExportScopeInput): ExportScopeResult {
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
