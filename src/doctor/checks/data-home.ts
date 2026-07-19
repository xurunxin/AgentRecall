import { accessSync, constants, existsSync } from "node:fs";
import type { CheckContext, CheckResult } from "../types.js";

export function checkDataHome(ctx: CheckContext): CheckResult {
  if (!existsSync(ctx.dataHome)) {
    return { name: "data_home", status: "fail", message: `${ctx.dataHome} does not exist` };
  }
  try {
    accessSync(ctx.dataHome, constants.W_OK);
    return { name: "data_home", status: "ok", message: `${ctx.dataHome} writable` };
  } catch {
    return { name: "data_home", status: "fail", message: `${ctx.dataHome} not writable` };
  }
}
