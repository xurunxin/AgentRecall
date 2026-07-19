import { statfsSync } from "node:fs";
import type { CheckContext, CheckResult } from "../types.js";

const WARN_BYTES = 100 * 1024 * 1024;

export function checkDiskFree(ctx: CheckContext): CheckResult {
  try {
    const stat = statfsSync(ctx.dataHome);
    const freeBytes = stat.bavail * stat.bsize;
    if (freeBytes < WARN_BYTES) {
      return {
        name: "disk_free",
        status: "warn",
        message: `${(freeBytes / 1_048_576).toFixed(1)} MB available`,
        details: { free_bytes: freeBytes }
      };
    }
    return {
      name: "disk_free",
      status: "ok",
      message: `${(freeBytes / 1_073_741_824).toFixed(2)} GB available`,
      details: { free_bytes: freeBytes }
    };
  } catch (error) {
    return {
      name: "disk_free",
      status: "warn",
      message: `statfs failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
