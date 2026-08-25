// src/cli/arg-parser.ts
//
// Hand-rolled argv parser. No third-party dependency.
//
// Supports:
//   --flag                 -> flags.flag = true
//   --key=value            -> flags.key = "value"
//   --key value            -> flags.key = "value" (only if next arg is not a flag)
//   -h                     -> flags.help = true (via SHORT_TO_LONG)
//   --                     -> everything after is positional, even if it looks like a flag

export type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

const SHORT_TO_LONG: Record<string, string> = {
  h: "help",
  v: "version"
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: "help", positional: [], flags: {} };
  }
  const args = [...argv];
  let command = "help";
  if (args.length > 0) {
    const first = args[0]!;
    if (!first.startsWith("-")) {
      command = args.shift()!;
    }
  }
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let afterDoubleDash = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (afterDoubleDash) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length === 2) {
      const short = arg.slice(1);
      const long = SHORT_TO_LONG[short] ?? short;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[long] = next;
        i += 1;
      } else {
        flags[long] = true;
      }
      continue;
    }
    positional.push(arg);
  }

  return { command, positional, flags };
}

export function flagString(args: ParsedArgs, name: string, fallback?: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  return value;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
