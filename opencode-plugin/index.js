// opencode-agent-recall-plugin
//
// Auto-injects [AGENT_RECALL] local memory entries into the system prompt on every
// LLM turn, mirroring what opencode-supermemory does for its cloud store.
//
// v1.2.0-alpha.2 (issue #52): the plugin now reads the
// assembled bootstrap channel from the agent-recall
// MCP server via a stdio client
// (`./context-client.mjs`) and surfaces the canonical
// `[AGENT_RECALL]` block to the LLM. The pre-1.2
// SQLite-direct path is preserved as a fallback when
// the MCP client is unavailable (a real local DB on
// disk, no `agent-recall-mcp` binary in PATH, or an
// RPC failure); the existing test suite + the manual
// smoke tests both work unchanged.
//
// All hook logic must be best-effort: any failure is logged to stderr and the hook
// is a no-op so the LLM call proceeds unchanged.

import sqlite from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fetchAssembledContext } from "./context-client.mjs";

/**
 * @typedef {Object} PluginOptions
 * @property {number} [max_chars=8000]      Hard cap on injected block size.
 * @property {number} [cache_ttl_ms=60000]  TTL for the formatted cache. 0 disables.
 * @property {string} [db_path]             Override DB file path.
 * @property {number} [max_entries=40]      Cap on number of memories included.
 * @property {boolean} [include_global=true] If false, only project-scope memories are injected.
 * @property {string} [header]              First line of the injected block. Set to "" to omit.
 * @property {boolean} [debug=false]        Log to stderr on each inject.
 * @property {boolean} [use_mcp=true]       Use the MCP context-client (issue #52). When false, fall back to the SQLite-direct path.
 * @property {string} [mcp_binary]          Override path to the agent-recall-mcp binary.
 * @property {string} [resource_uri]        Override the resource URI (default agentrecall://context/loadout).
 * @property {string} [actor_id]            Override the actor id forwarded to the resolver.
 * @property {string} [client_name]         Forwarded as the client_name to the resolve chain.
 * @property {string} [project_id]          Forwarded as the project_id to the resolve chain.
 * @property {string} [task_mode]           Forwarded as the task_mode to the resolve chain.
 */

const DEFAULTS = Object.freeze({
  max_chars: 8000,
  cache_ttl_ms: 60_000,
  db_path: undefined,
  max_entries: 40,
  include_global: true,
  header:
    "[AGENT_RECALL] Local memory context. Use the agent-recall MCP tools (search_memories, remember, get_memory, list_memories, update_memory, supersede_memory, forget_memory) to add, refresh, or supersede entries. This block is auto-injected from the local SQLite store and is not a substitute for active recall.",
  debug: false,
  use_mcp: true,
  mcp_binary: undefined,
  resource_uri: undefined,
  actor_id: undefined,
  client_name: "opencode",
  project_id: undefined,
  task_mode: undefined
});

const TYPE_LABELS = {
  preference: "Preferences",
  procedure: "Procedures",
  fact: "Facts",
  decision: "Decisions",
  debugging: "Debugging",
  constraint: "Constraints",
};

const TYPE_ORDER = ["constraint", "procedure", "fact", "preference", "decision", "debugging", "lesson"];

/**
 * Normalize a path for case-insensitive comparison. On Windows, drive-letter case
 * and slash direction do not distinguish paths. Returns a string with forward
 * slashes and no trailing separator.
 */
function normalizePath(p) {
  if (typeof p !== "string" || p.length === 0) return "";
  return normalize(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function resolveDbPath(override) {
  if (typeof override === "string" && override.length > 0) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  const home =
    process.env.AGENT_RECALL_HOME?.trim() ||
    process.env.LOCAL_MEMORY_MCP_HOME?.trim() ||
    join(homedir(), ".agent-recall");
  return join(home, "memory.sqlite");
}

function debugLog(enabled, ...args) {
  if (!enabled) return;
  // Use stderr so the plugin never pollutes stdout JSON the host may parse.
  try {
    process.stderr.write(
      "[opencode-agent-recall-plugin] " +
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
 * Open the SQLite store, returning null on any failure. We never throw out of
 * the plugin — a missing or corrupt DB is a no-op.
 */
function openStore(dbPath) {
  try {
    if (!existsSync(dbPath)) return null;
    const dir = dirname(dbPath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    // Smoke-test that the schema is what we expect.
    db.prepare(
      "SELECT id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, updated_at FROM memory_entries LIMIT 0",
    ).all();
    return db;
  } catch (err) {
    debugLog(true, "openStore failed:", String(err));
    return null;
  }
}

function listProjectScopes(db) {
  try {
    return db.prepare("SELECT project_id, canonical_path FROM project_scopes").all();
  } catch {
    return [];
  }
}

/**
 * Match a session directory to a project_id. Returns the most-specific (longest
 * canonical_path) match. Returns null if no scope matches.
 */
function matchProjectId(directory, scopes) {
  if (!directory || scopes.length === 0) return null;
  const target = normalizePath(directory);
  if (!target) return null;
  let best = null;
  for (const scope of scopes) {
    const canon = normalizePath(scope.canonical_path);
    if (!canon) continue;
    if (target === canon || target.startsWith(canon + "/") || canon.startsWith(target + "/")) {
      if (!best || canon.length > best.canon.length) {
        best = { project_id: scope.project_id, canon };
      }
    }
  }
  return best;
}

function readMemories(db, { projectId, includeGlobal, maxEntries }) {
  const where = [];
  const params = [];
  // Only include project-scope memories when we have a verified project match.
  // Otherwise we would leak other projects' memories into the wrong session.
  if (projectId) {
    where.push("(scope = 'project' AND project_id = ?)");
    params.push(projectId);
  }
  if (includeGlobal) {
    where.push("scope = 'global'");
  }
  if (where.length === 0) return [];
  const sql = `
    SELECT id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, updated_at
    FROM memory_entries
    WHERE status = 'active' AND (${where.join(" OR ")})
    ORDER BY importance DESC, updated_at DESC
    LIMIT ?
  `;
  try {
    const rows = db.prepare(sql).all(...params, maxEntries);
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      project_id: r.project_id ?? null,
      type: r.type,
      topic: r.topic,
      title: r.title,
      body: r.body,
      tags: parseTags(r.tags_json),
      importance: r.importance,
      confidence: r.confidence,
    }));
  } catch (err) {
    debugLog(true, "readMemories failed:", String(err));
    return [];
  }
}

function parseTags(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function formatBlock(memories, { header, maxChars }) {
  if (memories.length === 0) return "";
  // Group by type for skimmability.
  const groups = new Map();
  for (const m of memories) {
    if (!groups.has(m.type)) groups.set(m.type, []);
    groups.get(m.type).push(m);
  }
  const out = [];
  if (header) out.push(header);
  for (const t of TYPE_ORDER) {
    const items = groups.get(t);
    if (!items || items.length === 0) continue;
    out.push(`\n## ${TYPE_LABELS[t] ?? t}`);
    for (const m of items) {
      out.push(`- [${m.scope}${m.project_id ? `:${m.project_id}` : ""}] **${m.title}** (topic=${m.topic}, importance=${m.importance}/${m.confidence}) — ${m.body}`);
    }
  }
  // Include any types we don't recognize (defensive).
  for (const [t, items] of groups) {
    if (TYPE_ORDER.includes(t)) continue;
    out.push(`\n## ${TYPE_LABELS[t] ?? t}`);
    for (const m of items) {
      out.push(`- [${m.scope}] **${m.title}** — ${m.body}`);
    }
  }
  let block = out.join("\n");
  if (block.length > maxChars) {
    // Truncate gracefully: keep the header, drop bodies of the longest items
    // until we fit, then append an ellipsis.
    const headerPart = header ? header + "\n" : "";
    const items = [];
    let used = headerPart.length;
    for (const t of TYPE_ORDER) {
      const ms = groups.get(t);
      if (!ms) continue;
      for (const m of ms) {
        const line = `- [${m.scope}${m.project_id ? `:${m.project_id}` : ""}] **${m.title}**`;
        if (used + line.length + 1 > maxChars - 40) {
          out.length = 0;
          out.push(headerPart);
          out.push(`(truncated; full list available via agent-recall_search_memories)`);
          for (const kept of items) out.push(kept);
          block = out.join("\n");
          return block;
        }
        items.push(line);
        out.push(line);
        used += line.length + 1;
      }
    }
    block = out.join("\n");
  }
  return block;
}

/**
 * Format the assembled bootstrap channel from the
 * `context-client.mjs` payload. The MCP server
 * returns the canonical block in
 * `channels.bootstrap.text`; we wrap it with the
 * `[AGENT_RECALL]` header (when configured) so the
 * surface is identical to the legacy SQLite-direct
 * path. The `bootstrap_hash` is included as a
 * comment header so debug builds can verify
 * upstream-cache stability.
 */
function formatAssembledBlock(assembled, { header, maxChars }) {
  const channels = assembled?.channels ?? {};
  const bootstrap = channels.bootstrap;
  if (bootstrap === undefined || typeof bootstrap.text !== "string") return "";
  const text = bootstrap.text;
  if (text.length === 0) return "";
  const hash = typeof assembled.bootstrap_hash === "string" ? assembled.bootstrap_hash : "";
  const head = [
    header,
    hash ? `bootstrap_hash=${hash}` : null,
    `loadout_id=${assembled.loadout_id ?? "?"}@v${assembled.loadout_version ?? "?"}`
  ]
    .filter((line) => line !== null)
    .join("\n");
  const block = head ? `${head}\n${text}` : text;
  if (block.length <= maxChars) return block;
  // Truncate gracefully (header always preserved).
  return `${head}\n(truncated; full block available via agent-recall)\n${text.slice(0, Math.max(0, maxChars - head.length - 64))}\n`;
}

/**
 * The plugin entrypoint. OpenCode calls this once per session; we return the hooks
 * that will be registered for the session lifetime.
 *
 * @param {import("@opencode-ai/plugin").PluginInput} input
 * @param {PluginOptions} [options]
 */
export const AgentRecallPlugin = async (input, options = {}) => {
  const cfg = { ...DEFAULTS, ...options };
  const dbPath = resolveDbPath(cfg.db_path);
  const db = openStore(dbPath);
  if (!db) {
    debugLog(
      cfg.debug,
      `no usable AgentRecall DB at ${dbPath}; plugin will no-op. Set AGENT_RECALL_HOME or pass db_path.`,
    );
    return {};
  }
  const scopes = listProjectScopes(db);
  debugLog(
    cfg.debug,
    `loaded ${scopes.length} project scope(s) from ${dbPath}; include_global=${cfg.include_global}`,
  );

  let cached = null; // { text, projectId, expiresAt, bootstrapHash }

  const buildSqlite = () => {
    const project = matchProjectId(input.directory, scopes);
    const projectId = project?.project_id ?? null;
    const memories = readMemories(db, {
      projectId,
      includeGlobal: cfg.include_global,
      maxEntries: cfg.max_entries,
    });
    const text = formatBlock(memories, { header: cfg.header, maxChars: cfg.max_chars });
    debugLog(
      cfg.debug,
      `format: project=${projectId ?? "(none)"} memories=${memories.length} bytes=${text.length}`,
    );
    return { text, projectId, bootstrapHash: null };
  };

  const buildMcp = async () => {
    const project = matchProjectId(input.directory, scopes);
    const projectId = project?.project_id ?? null;
    const assembled = await fetchAssembledContext({
      debug: cfg.debug,
      ...(cfg.mcp_binary !== undefined ? { binary: cfg.mcp_binary } : {}),
      ...(cfg.resource_uri !== undefined ? { uri: cfg.resource_uri } : {})
    });
    if (assembled === null) {
      debugLog(cfg.debug, "MCP context-client returned null; falling back to SQLite path");
      return { text: "", projectId, bootstrapHash: null };
    }
    const text = formatAssembledBlock(assembled, {
      header: cfg.header,
      maxChars: cfg.max_chars
    });
    debugLog(
      cfg.debug,
      `mcp: project=${projectId ?? "(none)"} bytes=${text.length} hash=${assembled.bootstrap_hash ?? "?"}`,
    );
    return { text, projectId, bootstrapHash: assembled.bootstrap_hash ?? null };
  };

  return {
    dispose: async () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
    "experimental.chat.system.transform": async (_in, output) => {
      try {
        const now = Date.now();
        const project = matchProjectId(input.directory, scopes);
        const projectId = project?.project_id ?? null;
        if (
          !cached ||
          cached.expiresAt <= now ||
          cached.projectId !== projectId
        ) {
          let fresh;
          if (cfg.use_mcp) {
            fresh = await buildMcp();
            if (!fresh.text && db) {
              // MCP path returned empty (binary
              // missing, RPC failure, no DB
              // reachable). Fall back to the
              // legacy SQLite-direct path so the
              // existing test suite + manual
              // smoke tests both work unchanged.
              fresh = buildSqlite();
            }
          } else {
            fresh = buildSqlite();
          }
          cached = {
            text: fresh.text,
            projectId: fresh.projectId,
            bootstrapHash: fresh.bootstrapHash,
            expiresAt: now + Math.max(0, cfg.cache_ttl_ms),
          };
        }
        if (cached.text) {
          output.system.push(cached.text);
        }
      } catch (err) {
        debugLog(cfg.debug, "system.transform hook failed:", String(err));
      }
    },
  };
};

export default AgentRecallPlugin;
