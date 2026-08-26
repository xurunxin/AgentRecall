// opencode-plugin/context-client.mjs
//
// v1.2.0-alpha.2 (issue #52): the small stdio client
// the OpenCode plugin uses to fetch the assembled
// context from the agent-recall MCP server. The client
// spawns the `agent-recall-mcp` binary as a child
// process, sends a `resources/read` JSON-RPC request
// for the `agentrecall://context/loadout` URI, and
// returns the assembled payload.
//
// The client is failure-isolated: any spawn / RPC /
// schema error logs to stderr and returns `null` (the
// plugin then no-ops; the LLM call proceeds unchanged).
// The plugin never throws out of the context-client.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_RESOURCE_URI = "agentrecall://context/loadout";

function debugLog(enabled, ...args) {
  if (!enabled) return;
  try {
    process.stderr.write(
      "[opencode-agent-recall-plugin/context-client] " +
        args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" ") +
        "\n",
    );
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the path to the `agent-recall-mcp` binary.
 * Walks the standard node_modules install paths
 * first, then the published-package `bin/`
 * directory as a fallback. The lookup is best-effort:
 * a `null` return signals "binary not found" and
 * the caller logs + returns empty.
 */
function resolveMcpBinary(override) {
  if (typeof override === "string" && override.length > 0) return override;
  const candidates = [
    // Bundled in the same package (dev / monorepo layout).
    resolve(__dirname, "..", "..", ".worktrees", "v12a2-loadouts", "dist", "src", "launcher.js"),
    resolve(__dirname, "..", "..", "dist", "src", "launcher.js"),
    resolve(__dirname, "..", "launcher.js"),
    // Per-user global install (`npm i -g agent-recall`).
    join(homedir(), ".npm-global", "bin", "agent-recall-mcp"),
    join(homedir(), ".local", "bin", "agent-recall-mcp")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Send a single JSON-RPC request to a child
 * process's stdio. The `params` object is sent
 * verbatim. The first `id`-matching response that
 * carries a `result` is returned; the request is
 * aborted after `timeoutMs`. Any protocol error
 * (process exited, write failed, parse failed,
 * timeout) resolves to `null` so the caller can
 * log + no-op without throwing.
 */
function sendRpc(child, payload, timeoutMs, debug) {
  return new Promise((resolveP) => {
    let buffer = "";
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      try {
        child.stdout?.off("data", onData);
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolveP(value);
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line);
            if (
              parsed &&
              typeof parsed === "object" &&
              "id" in parsed &&
              parsed.id === payload.id
            ) {
              if ("result" in parsed) {
                finish(parsed.result);
                return;
              }
              if ("error" in parsed) {
                debugLog(debug, "RPC error:", JSON.stringify(parsed.error));
                finish(null);
                return;
              }
            }
          } catch (err) {
            debugLog(debug, "RPC parse error:", String(err));
          }
        }
        idx = buffer.indexOf("\n");
      }
    };
    child.stdout?.on("data", onData);
    const timer = setTimeout(() => {
      debugLog(debug, "RPC timeout after", timeoutMs, "ms");
      finish(null);
    }, timeoutMs);
    try {
      child.stdin?.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      debugLog(debug, "RPC write error:", String(err));
      finish(null);
    }
  });
}

/**
 * Fetch the assembled context payload from the
 * agent-recall MCP server. Returns the parsed
 * `AssembledContextV1` on success, `null` on
 * any failure. The caller (the plugin) treats
 * `null` as "no-op: do not inject anything".
 *
 * The query string is optional; the agent-recall
 * MCP server returns the same `bootstrap_hash`
 * for a fixed `(loadout_id, loadout_version,
 * policy_version, actor_id, project_id,
 * bootstrap_text)` regardless of the query
 * (the bootstrap channel is query-independent
 * by spec). The query only affects the
 * `channels.query` channel.
 */
export async function fetchAssembledContext(options) {
  const debug = Boolean(options.debug);
  const binary = resolveMcpBinary(options.binary);
  if (binary === null) {
    debugLog(debug, "agent-recall-mcp binary not found; context-client no-op");
    return null;
  }
  const home =
    process.env.AGENT_RECALL_HOME?.trim() ||
    process.env.LOCAL_MEMORY_MCP_HOME?.trim() ||
    join(homedir(), ".agent-recall");
  const child = spawn(
    process.execPath,
    [binary, "--stdio"],
    {
      env: { ...process.env, AGENT_RECALL_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  // Stderr is a log sink (the MCP server may
  // write diagnostics); we forward it to the
  // plugin's stderr (with a `context-client`
  // prefix) only when debug is on.
  child.stderr?.on("data", (chunk) => {
    if (debug) {
      try {
        process.stderr.write(
          "[opencode-agent-recall-plugin/context-client] server stderr: " +
            String(chunk)
        );
      } catch {
        /* ignore */
      }
    }
  });
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: {
      uri: options.uri ?? DEFAULT_RESOURCE_URI
    }
  };
  try {
    const result = await sendRpc(child, payload, options.timeoutMs ?? 5000, debug);
    if (result === null || typeof result !== "object") return null;
    const contents = result.contents;
    if (!Array.isArray(contents) || contents.length === 0) return null;
    const text = contents[0]?.text;
    if (typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      debugLog(debug, "result parse error:", String(err));
      return null;
    }
  } finally {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}
