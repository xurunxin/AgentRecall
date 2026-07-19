// src/cli/format.ts

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m"
} as const;

export type ColorMode = "auto" | "always" | "never";

export function resolveColorMode(
  args: { flags: Record<string, string | boolean> },
  env: NodeJS.ProcessEnv = process.env
): ColorMode {
  if (args.flags["no-color"] === true) return "never";
  if (args.flags.color === "always") return "always";
  if (args.flags.color === "never") return "never";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "never";
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return "always";
  return "auto";
}

export function useColor(mode: ColorMode, stream: { isTTY?: boolean } = process.stdout): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return Boolean(stream.isTTY);
}

export function paint(text: string, color: keyof typeof COLORS, enabled: boolean): string {
  if (!enabled) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

export function statusGlyph(status: "ok" | "warn" | "fail", color: boolean): string {
  if (status === "ok") return paint("[ OK ]", "green", color);
  if (status === "warn") return paint("[WARN]", "yellow", color);
  return paint("[FAIL]", "red", color);
}

export function formatTable(rows: string[][], widths: number[]): string {
  return rows.map((cells) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}

export function jsonOut(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
