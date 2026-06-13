# Local Memory MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first stdio MCP server that gives generic coding agents direct-write global and project memory with strict schema validation, SQLite FTS search, hard capacity budgets, markdown export, and full auditability.

**Architecture:** Implement a TypeScript Node.js package with a thin MCP transport layer over focused memory modules. SQLite is the source of truth through Node's built-in `node:sqlite`; markdown files are deterministic exports. Agents write directly, while validation, scope resolution, secret screening, and budget governance enforce memory hygiene.

**Tech Stack:** Node.js 24+, TypeScript, `@modelcontextprotocol/sdk`, `zod/v4`, built-in `node:sqlite`, Vitest.

---

## File Structure

- Create: `package.json` - package metadata, build/test/start scripts, runtime dependency declarations.
- Create: `tsconfig.json` - strict TypeScript config for ESM Node output.
- Create: `vitest.config.ts` - Vitest config for TypeScript tests.
- Create: `.gitignore` - ignore dependency, build, coverage, and local memory runtime artifacts.
- Create: `src/domain.ts` - shared enums, types, default budgets, result helpers, ID and timestamp helpers.
- Create: `src/secret-detector.ts` - deterministic secret detection rules that never return raw secret values.
- Create: `src/write-validator.ts` - validation and normalization for direct memory writes and updates.
- Create: `src/scope-resolver.ts` - global/project scope resolution, path canonicalization, project ID derivation.
- Create: `src/sqlite-store.ts` - schema migration, CRUD, FTS index maintenance, audit persistence, usage queries.
- Create: `src/budget-governor.ts` - hard budget checks, duplicate warnings, cleanup candidate scoring.
- Create: `src/memory-service.ts` - application service coordinating validation, scope, budget, store, lifecycle operations.
- Create: `src/markdown-exporter.ts` - deterministic `MEMORY.md` and topic markdown export.
- Create: `src/tools/schemas.ts` - Zod schemas for MCP tool inputs.
- Create: `src/tools/register-tools.ts` - MCP tool registration and JSON result wrapping.
- Create: `src/index.ts` - stdio MCP server entrypoint.
- Create: `test/*.test.ts` - focused tests for every module plus one end-to-end MCP handler test.
- Create: `README.md` - local setup, MCP configuration, tool list, memory hygiene guidance.

## Task 1: Scaffold TypeScript MCP Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts`
- Create: `test/smoke.test.ts`

- [ ] **Step 1: Initialize Git repository**

Run:

```bash
rtk git init
```

Expected: repository initialized in `G:\Projects\MetronX\local-memory-mcp`.

- [ ] **Step 2: Create the package scaffold**

Create `package.json`:

```json
{
  "name": "local-memory-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Local-first MCP memory server for coding agents.",
  "bin": {
    "local-memory-mcp": "./dist/index.js"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.8.0",
    "@vitest/coverage-v8": "^3.2.0",
    "vitest": "^3.2.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.local-memory-mcp/
*.log
```

Create `src/index.ts`:

```ts
export function serverName(): string {
  return "local-memory-mcp";
}
```

Create `test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serverName } from "../src/index.js";

describe("project scaffold", () => {
  it("exports the server name", () => {
    expect(serverName()).toBe("local-memory-mcp");
  });
});
```

- [ ] **Step 3: Install dependencies**

Run:

```bash
rtk npm install
```

Expected: dependency installation completes and creates `package-lock.json`.

- [ ] **Step 4: Run the scaffold test**

Run:

```bash
rtk npm test
```

Expected: PASS with `test/smoke.test.ts`.

- [ ] **Step 5: Typecheck the scaffold**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit scaffold**

Run:

```bash
rtk git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/index.ts test/smoke.test.ts
rtk git commit -m "chore: scaffold local memory mcp project"
```

Expected: commit succeeds.

## Task 2: Add Domain Types and Shared Helpers

**Files:**
- Create: `src/domain.ts`
- Create: `test/domain.test.ts`

- [ ] **Step 1: Write domain tests first**

Create `test/domain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_PROJECT_BUDGET,
  createMemoryId,
  estimateTokens,
  isMemoryStatus,
  isMemoryType,
  nowIso
} from "../src/domain.js";

describe("domain helpers", () => {
  it("defines the default hard budgets from the design", () => {
    expect(DEFAULT_GLOBAL_BUDGET).toEqual({
      max_active_entries: 500,
      max_total_chars: 250_000,
      max_index_chars: 25_000
    });
    expect(DEFAULT_PROJECT_BUDGET).toEqual({
      max_active_entries: 300,
      max_total_chars: 150_000,
      max_topic_chars: 30_000,
      max_index_chars: 25_000
    });
  });

  it("validates memory type and status values", () => {
    expect(isMemoryType("debugging")).toBe(true);
    expect(isMemoryType("random")).toBe(false);
    expect(isMemoryStatus("forgotten")).toBe(true);
    expect(isMemoryStatus("deleted")).toBe(false);
  });

  it("creates sortable timestamps and stable memory id shape", () => {
    expect(nowIso()).toMatch(/^\\d{4}-\\d{2}-\\d{2}T/);
    expect(createMemoryId()).toMatch(/^mem_[a-f0-9]{24}$/);
  });

  it("estimates token count from character count without external models", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- test/domain.test.ts
```

Expected: FAIL with module resolution error for `../src/domain.js`.

- [ ] **Step 3: Implement domain types and helpers**

Create `src/domain.ts`:

```ts
import { randomBytes } from "node:crypto";

export const MEMORY_TYPES = [
  "preference",
  "procedure",
  "fact",
  "decision",
  "lesson",
  "debugging",
  "constraint"
] as const;

export const MEMORY_STATUSES = ["active", "archived", "superseded", "forgotten"] as const;
export const MEMORY_SCOPES = ["global", "project"] as const;
export const SOURCE_KINDS = ["user", "agent", "tool", "file", "command", "external"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type Importance = 1 | 2 | 3 | 4 | 5;
export type Confidence = 1 | 2 | 3 | 4 | 5;

export type MemoryBudget = {
  max_active_entries: number;
  max_total_chars: number;
  max_topic_chars?: number;
  max_index_chars: number;
};

export const DEFAULT_GLOBAL_BUDGET: MemoryBudget = {
  max_active_entries: 500,
  max_total_chars: 250_000,
  max_index_chars: 25_000
};

export const DEFAULT_PROJECT_BUDGET: MemoryBudget = {
  max_active_entries: 300,
  max_total_chars: 150_000,
  max_topic_chars: 30_000,
  max_index_chars: 25_000
};

export type MemorySource = {
  kind: SourceKind;
  ref?: string;
};

export type MemoryEntry = {
  id: string;
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  type: MemoryType;
  topic: string;
  title: string;
  body: string;
  tags: string[];
  source: MemorySource;
  importance: Importance;
  confidence: Confidence;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
  last_accessed_at?: string;
  access_count: number;
  expires_at?: string;
  review_after?: string;
  supersedes: string[];
  superseded_by?: string;
  token_estimate: number;
  char_count: number;
};

export type ProjectScope = {
  project_id: string;
  canonical_path: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  budget: MemoryBudget;
};

export type AuditEventName =
  | "created"
  | "updated"
  | "archived"
  | "superseded"
  | "forgotten"
  | "write_rejected"
  | "maintenance_run"
  | "markdown_exported";

export type MemoryAuditEvent = {
  id: string;
  memory_id?: string;
  scope: MemoryScope;
  project_id?: string;
  event: AuditEventName;
  reason?: string;
  actor: "agent" | "user" | "system";
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string; details?: Record<string, unknown> };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends string>(
  error: E,
  message: string,
  details?: Record<string, unknown>
): Result<never, E> {
  return details === undefined ? { ok: false, error, message } : { ok: false, error, message, details };
}

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isMemoryStatus(value: string): value is MemoryStatus {
  return (MEMORY_STATUSES as readonly string[]).includes(value);
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function createMemoryId(): string {
  return `mem_${randomBytes(12).toString("hex")}`;
}

export function createAuditId(): string {
  return `aud_${randomBytes(12).toString("hex")}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function computeEntrySize(title: string, body: string, tags: string[]): { char_count: number; token_estimate: number } {
  const char_count = title.length + body.length + tags.join(" ").length;
  return { char_count, token_estimate: estimateTokens(`${title}\n${body}\n${tags.join(" ")}`) };
}
```

- [ ] **Step 4: Run domain tests**

Run:

```bash
rtk npm test -- test/domain.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit domain layer**

Run:

```bash
rtk git add src/domain.ts test/domain.test.ts
rtk git commit -m "feat: add memory domain model"
```

Expected: commit succeeds.

## Task 3: Add Secret Detection and Write Validation

**Files:**
- Create: `src/secret-detector.ts`
- Create: `src/write-validator.ts`
- Create: `test/write-validator.test.ts`

- [ ] **Step 1: Write validation tests**

Create `test/write-validator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectSecrets } from "../src/secret-detector.js";
import { validateRememberInput, validateUpdateInput } from "../src/write-validator.js";

describe("secret detector", () => {
  it("detects private keys, bearer tokens, env secrets, and high entropy tokens", () => {
    expect(detectSecrets("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toMatchObject([
      { category: "private_key", field: "body" }
    ]);
    expect(detectSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890")).toMatchObject([
      { category: "bearer_token", field: "body" }
    ]);
    expect(detectSecrets("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890")).toMatchObject([
      { category: "env_secret", field: "body" }
    ]);
    expect(detectSecrets("token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toMatchObject([
      { category: "high_entropy_token", field: "body" }
    ]);
  });

  it("does not return raw secret values", () => {
    const findings = detectSecrets("API_TOKEN=secret-value-that-should-not-return");
    expect(JSON.stringify(findings)).not.toContain("secret-value-that-should-not-return");
  });
});

describe("remember input validation", () => {
  const validInput = {
    scope: "global",
    type: "debugging",
    topic: "tests",
    title: "Vitest uses node environment",
    body: "Use vitest config with environment set to node for filesystem tests.",
    tags: ["vitest", "node"],
    source: { kind: "agent", ref: "planning" },
    importance: 4,
    confidence: 5
  };

  it("accepts a complete global memory write", () => {
    const result = validateRememberInput(validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("active");
      expect(result.value.supersedes).toEqual([]);
      expect(result.value.char_count).toBeGreaterThan(0);
    }
  });

  it("rejects missing project identity for project scope", () => {
    const result = validateRememberInput({ ...validInput, scope: "project" });
    expect(result).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
  });

  it("rejects invalid importance and confidence", () => {
    expect(validateRememberInput({ ...validInput, importance: 6 })).toMatchObject({ ok: false, error: "invalid_schema" });
    expect(validateRememberInput({ ...validInput, confidence: 0 })).toMatchObject({ ok: false, error: "invalid_schema" });
  });

  it("rejects secret text before storage", () => {
    const result = validateRememberInput({
      ...validInput,
      body: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890"
    });
    expect(result).toMatchObject({
      ok: false,
      error: "secret_detected"
    });
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  });
});

describe("update validation", () => {
  it("allows only mutable fields", () => {
    const result = validateUpdateInput({
      title: "Updated title",
      importance: 3,
      status: "archived"
    });
    expect(result.ok).toBe(true);
  });

  it("rejects status values outside active and archived", () => {
    expect(validateUpdateInput({ status: "forgotten" })).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
rtk npm test -- test/write-validator.test.ts
```

Expected: FAIL with module resolution errors for `secret-detector` and `write-validator`.

- [ ] **Step 3: Implement secret detector**

Create `src/secret-detector.ts`:

```ts
export type SecretCategory = "private_key" | "bearer_token" | "env_secret" | "api_key_prefix" | "high_entropy_token";

export type SecretFinding = {
  category: SecretCategory;
  field: string;
};

const API_KEY_PREFIXES = /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/i;
const ENV_SECRET = /\b[A-Z0-9_]*(SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?[^"'\s]{8,}/i;
const HIGH_ENTROPY = /\b[A-Za-z0-9+/=_-]{40,}\b/;

export function detectSecrets(text: string, field = "body"): SecretFinding[] {
  const findings: SecretFinding[] = [];
  if (PRIVATE_KEY.test(text)) findings.push({ category: "private_key", field });
  if (BEARER_TOKEN.test(text)) findings.push({ category: "bearer_token", field });
  if (ENV_SECRET.test(text)) findings.push({ category: "env_secret", field });
  if (API_KEY_PREFIXES.test(text)) findings.push({ category: "api_key_prefix", field });
  if (HIGH_ENTROPY.test(text) && /\b(token|secret|key|password|authorization)\b/i.test(text)) {
    findings.push({ category: "high_entropy_token", field });
  }
  return findings;
}
```

- [ ] **Step 4: Implement write validator**

Create `src/write-validator.ts`:

```ts
import {
  computeEntrySize,
  err,
  isMemoryStatus,
  isMemoryType,
  MEMORY_SCOPES,
  SOURCE_KINDS,
  type Confidence,
  type Importance,
  type MemoryEntry,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
  type Result
} from "./domain.js";
import { detectSecrets } from "./secret-detector.js";

export type RememberInput = {
  scope: string;
  project_id?: string;
  project_path?: string;
  type: string;
  topic: string;
  title: string;
  body: string;
  tags?: string[];
  source: MemorySource;
  importance: number;
  confidence: number;
  expires_at?: string;
  review_after?: string;
  supersedes?: string[];
  status?: string;
};

export type ValidatedRememberInput = Omit<
  MemoryEntry,
  "id" | "created_at" | "updated_at" | "last_accessed_at" | "access_count" | "superseded_by"
>;

export type UpdateInput = {
  topic?: string;
  title?: string;
  body?: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  expires_at?: string;
  review_after?: string;
  status?: string;
};

export type ValidatedUpdateInput = {
  topic?: string;
  title?: string;
  body?: string;
  tags?: string[];
  importance?: Importance;
  confidence?: Confidence;
  expires_at?: string;
  review_after?: string;
  status?: "active" | "archived";
};

function isScope(value: string): value is MemoryScope {
  return (MEMORY_SCOPES as readonly string[]).includes(value);
}

function isSource(value: MemorySource): boolean {
  return typeof value === "object" && value !== null && (SOURCE_KINDS as readonly string[]).includes(value.kind);
}

function isRating(value: number): value is Importance & Confidence {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))].sort();
}

export function validateRememberInput(input: RememberInput): Result<ValidatedRememberInput, "invalid_schema" | "secret_detected"> {
  if (!isScope(input.scope)) return err("invalid_schema", "scope must be global or project");
  if (input.scope === "project" && !input.project_id && !input.project_path) {
    return err("invalid_schema", "project memory requires project_id or project_path");
  }
  if (!isMemoryType(input.type)) return err("invalid_schema", "type is not a supported memory type");
  if (!isNonEmptyString(input.topic)) return err("invalid_schema", "topic is required");
  if (!isNonEmptyString(input.title)) return err("invalid_schema", "title is required");
  if (!isNonEmptyString(input.body)) return err("invalid_schema", "body is required");
  if (!isSource(input.source)) return err("invalid_schema", "source.kind is invalid");
  if (!isRating(input.importance)) return err("invalid_schema", "importance must be an integer from 1 to 5");
  if (!isRating(input.confidence)) return err("invalid_schema", "confidence must be an integer from 1 to 5");

  const status = input.status ?? "active";
  if (!isMemoryStatus(status) || status === "forgotten" || status === "superseded") {
    return err("invalid_schema", "new memories can only start as active or archived");
  }

  const secretFindings = [
    ...detectSecrets(input.title, "title"),
    ...detectSecrets(input.body, "body"),
    ...detectSecrets((input.tags ?? []).join(" "), "tags")
  ];
  if (secretFindings.length > 0) {
    return err("secret_detected", "memory text appears to contain a secret", { findings: secretFindings });
  }

  const tags = normalizeTags(input.tags);
  const size = computeEntrySize(input.title.trim(), input.body.trim(), tags);
  return {
    ok: true,
    value: {
      scope: input.scope,
      project_id: input.project_id,
      project_path: input.project_path,
      type: input.type as MemoryType,
      topic: input.topic.trim(),
      title: input.title.trim(),
      body: input.body.trim(),
      tags,
      source: input.source,
      importance: input.importance as Importance,
      confidence: input.confidence as Confidence,
      status: status as MemoryStatus,
      expires_at: input.expires_at,
      review_after: input.review_after,
      supersedes: input.supersedes ?? [],
      ...size
    }
  };
}

export function validateUpdateInput(input: UpdateInput): Result<ValidatedUpdateInput, "invalid_schema" | "secret_detected"> {
  const output: ValidatedUpdateInput = {};
  if (input.topic !== undefined) {
    if (!isNonEmptyString(input.topic)) return err("invalid_schema", "topic must be non-empty");
    output.topic = input.topic.trim();
  }
  if (input.title !== undefined) {
    if (!isNonEmptyString(input.title)) return err("invalid_schema", "title must be non-empty");
    output.title = input.title.trim();
  }
  if (input.body !== undefined) {
    if (!isNonEmptyString(input.body)) return err("invalid_schema", "body must be non-empty");
    output.body = input.body.trim();
  }
  if (input.tags !== undefined) output.tags = normalizeTags(input.tags);
  if (input.importance !== undefined) {
    if (!isRating(input.importance)) return err("invalid_schema", "importance must be an integer from 1 to 5");
    output.importance = input.importance as Importance;
  }
  if (input.confidence !== undefined) {
    if (!isRating(input.confidence)) return err("invalid_schema", "confidence must be an integer from 1 to 5");
    output.confidence = input.confidence as Confidence;
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "archived") {
      return err("invalid_schema", "status updates only support active or archived");
    }
    output.status = input.status;
  }
  if (input.expires_at !== undefined) output.expires_at = input.expires_at;
  if (input.review_after !== undefined) output.review_after = input.review_after;

  const secretFindings = [
    ...detectSecrets(output.title ?? "", "title"),
    ...detectSecrets(output.body ?? "", "body"),
    ...detectSecrets((output.tags ?? []).join(" "), "tags")
  ];
  if (secretFindings.length > 0) {
    return err("secret_detected", "update text appears to contain a secret", { findings: secretFindings });
  }

  return { ok: true, value: output };
}
```

- [ ] **Step 5: Run validation tests**

Run:

```bash
rtk npm test -- test/write-validator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit validation layer**

Run:

```bash
rtk git add src/secret-detector.ts src/write-validator.ts test/write-validator.test.ts
rtk git commit -m "feat: validate memory writes"
```

Expected: commit succeeds.

## Task 4: Add Scope Resolution

**Files:**
- Create: `src/scope-resolver.ts`
- Create: `test/scope-resolver.test.ts`

- [ ] **Step 1: Write scope resolver tests**

Create `test/scope-resolver.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMemoryScope } from "../src/scope-resolver.js";

describe("resolveMemoryScope", () => {
  it("resolves global scope without project fields", () => {
    const result = resolveMemoryScope({ scope: "global" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scope).toBe("global");
      expect(result.value.project_id).toBeUndefined();
    }
  });

  it("canonicalizes existing project paths and derives stable IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "local-memory-mcp-"));
    const project = join(root, "repo");
    mkdirSync(project);
    const first = resolveMemoryScope({ scope: "project", project_path: project });
    const second = resolveMemoryScope({ scope: "project", project_path: join(project, ".") });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.project_id).toBe(second.value.project_id);
      expect(first.value.project_path).toBe(realpathSync.native(project));
    }
  });

  it("accepts explicit project_id for remote or not-yet-created paths", () => {
    const result = resolveMemoryScope({ scope: "project", project_id: "metronx-core" });
    expect(result).toMatchObject({
      ok: true,
      value: {
        scope: "project",
        project_id: "metronx-core"
      }
    });
  });

  it("rejects project scope without identity", () => {
    expect(resolveMemoryScope({ scope: "project" })).toMatchObject({
      ok: false,
      error: "invalid_scope"
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- test/scope-resolver.test.ts
```

Expected: FAIL with module resolution error for `../src/scope-resolver.js`.

- [ ] **Step 3: Implement scope resolver**

Create `src/scope-resolver.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { err, ok, type MemoryBudget, type MemoryScope, type Result } from "./domain.js";

export type ScopeInput = {
  scope: MemoryScope | string;
  project_id?: string;
  project_path?: string;
};

export type ResolvedScope = {
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  display_name?: string;
  budget?: MemoryBudget;
};

function sanitizeProjectId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 96);
}

function canonicalizePath(projectPath: string): string {
  const absolute = resolve(projectPath);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function deriveProjectId(canonicalPath: string): string {
  const hash = createHash("sha256").update(canonicalPath).digest("hex").slice(0, 12);
  const name = sanitizeProjectId(basename(canonicalPath) || "project");
  return `${name}-${hash}`;
}

export function resolveMemoryScope(input: ScopeInput): Result<ResolvedScope, "invalid_scope"> {
  if (input.scope !== "global" && input.scope !== "project") {
    return err("invalid_scope", "scope must be global or project");
  }
  if (input.scope === "global") {
    return ok({ scope: "global" });
  }
  if (input.project_path) {
    const project_path = canonicalizePath(input.project_path);
    return ok({
      scope: "project",
      project_id: input.project_id ? sanitizeProjectId(input.project_id) : deriveProjectId(project_path),
      project_path,
      display_name: basename(project_path)
    });
  }
  if (input.project_id) {
    return ok({
      scope: "project",
      project_id: sanitizeProjectId(input.project_id),
      display_name: sanitizeProjectId(input.project_id)
    });
  }
  return err("invalid_scope", "project scope requires project_id or project_path");
}
```

- [ ] **Step 4: Run scope tests**

Run:

```bash
rtk npm test -- test/scope-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit scope resolver**

Run:

```bash
rtk git add src/scope-resolver.ts test/scope-resolver.test.ts
rtk git commit -m "feat: resolve memory scopes"
```

Expected: commit succeeds.

## Task 5: Add SQLite Store and FTS Index

**Files:**
- Create: `src/sqlite-store.ts`
- Create: `test/sqlite-store.test.ts`

- [ ] **Step 1: Write SQLite store tests**

Create `test/sqlite-store.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_BUDGET, type MemoryEntry } from "../src/domain.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "mem_test_001",
    scope: overrides.scope ?? "project",
    project_id: overrides.project_id ?? "repo-123",
    project_path: overrides.project_path ?? "G:\\Projects\\Example",
    type: overrides.type ?? "debugging",
    topic: overrides.topic ?? "tests",
    title: overrides.title ?? "SQLite FTS test",
    body: overrides.body ?? "Use SQLite FTS to find debugging memories about postgres failures.",
    tags: overrides.tags ?? ["sqlite", "debugging"],
    source: overrides.source ?? { kind: "agent", ref: "test" },
    importance: overrides.importance ?? 4,
    confidence: overrides.confidence ?? 5,
    status: overrides.status ?? "active",
    created_at: overrides.created_at ?? "2026-06-13T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-06-13T00:00:00.000Z",
    access_count: overrides.access_count ?? 0,
    expires_at: overrides.expires_at,
    review_after: overrides.review_after,
    supersedes: overrides.supersedes ?? [],
    superseded_by: overrides.superseded_by,
    token_estimate: overrides.token_estimate ?? 20,
    char_count: overrides.char_count ?? 80
  };
}

describe("SQLiteMemoryStore", () => {
  it("migrates schema and persists a project scope", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.upsertProjectScope({
      project_id: "repo-123",
      canonical_path: "G:\\Projects\\Example",
      display_name: "Example",
      budget: DEFAULT_PROJECT_BUDGET,
      created_at: "2026-06-13T00:00:00.000Z",
      updated_at: "2026-06-13T00:00:00.000Z"
    });
    expect(store.getProjectScope("repo-123")).toMatchObject({
      project_id: "repo-123",
      canonical_path: "G:\\Projects\\Example"
    });
    store.close();
  });

  it("inserts, reads, lists, and FTS-searches memory entries", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(makeEntry());
    expect(store.getEntry("mem_test_001")).toMatchObject({
      id: "mem_test_001",
      title: "SQLite FTS test"
    });
    expect(store.listEntries({ scope: "project", project_id: "repo-123" })).toHaveLength(1);
    expect(store.searchEntries({ query: "postgres", scope: "project", project_id: "repo-123", limit: 5 })).toHaveLength(1);
    store.close();
  });

  it("updates entries, appends audit events, and reports budget usage", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(makeEntry());
    store.updateEntry("mem_test_001", {
      title: "Updated title",
      body: "Updated body for postgres debugging",
      tags: ["postgres"],
      updated_at: "2026-06-13T00:01:00.000Z",
      char_count: 42,
      token_estimate: 11
    });
    store.appendAudit({
      id: "aud_001",
      memory_id: "mem_test_001",
      scope: "project",
      project_id: "repo-123",
      event: "updated",
      actor: "agent",
      metadata: { fields: ["title"] },
      created_at: "2026-06-13T00:01:00.000Z"
    });
    expect(store.getEntry("mem_test_001")).toMatchObject({ title: "Updated title" });
    expect(store.getAuditEvents("mem_test_001")).toHaveLength(1);
    expect(store.getBudgetUsage({ scope: "project", project_id: "repo-123" })).toMatchObject({
      active_entries: 1,
      active_chars: 42
    });
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- test/sqlite-store.test.ts
```

Expected: FAIL with module resolution error for `../src/sqlite-store.js`.

- [ ] **Step 3: Implement SQLite store**

Create `src/sqlite-store.ts`:

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryAuditEvent, MemoryEntry, MemoryScope, ProjectScope } from "./domain.js";

export type EntryFilters = {
  scope?: MemoryScope;
  project_id?: string;
  type?: string;
  topic?: string;
  status?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
};

export type SearchFilters = EntryFilters & {
  query: string;
};

export type BudgetUsage = {
  active_entries: number;
  active_chars: number;
  topic_chars: Record<string, number>;
  index_chars: number;
};

type EntryRow = Record<string, unknown>;

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decodeEntry(row: EntryRow): MemoryEntry {
  return {
    id: String(row.id),
    scope: row.scope as MemoryScope,
    project_id: row.project_id === null ? undefined : String(row.project_id),
    project_path: row.project_path === null ? undefined : String(row.project_path),
    type: row.type as MemoryEntry["type"],
    topic: String(row.topic),
    title: String(row.title),
    body: String(row.body ?? ""),
    tags: JSON.parse(String(row.tags_json)) as string[],
    source: JSON.parse(String(row.source_json)) as MemoryEntry["source"],
    importance: Number(row.importance) as MemoryEntry["importance"],
    confidence: Number(row.confidence) as MemoryEntry["confidence"],
    status: row.status as MemoryEntry["status"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_accessed_at: row.last_accessed_at === null ? undefined : String(row.last_accessed_at),
    access_count: Number(row.access_count),
    expires_at: row.expires_at === null ? undefined : String(row.expires_at),
    review_after: row.review_after === null ? undefined : String(row.review_after),
    supersedes: JSON.parse(String(row.supersedes_json)) as string[],
    superseded_by: row.superseded_by === null ? undefined : String(row.superseded_by),
    token_estimate: Number(row.token_estimate),
    char_count: Number(row.char_count)
  };
}

function decodeProject(row: EntryRow): ProjectScope {
  return {
    project_id: String(row.project_id),
    canonical_path: String(row.canonical_path),
    display_name: String(row.display_name),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    budget: JSON.parse(String(row.budget_json)) as ProjectScope["budget"]
  };
}

function decodeAudit(row: EntryRow): MemoryAuditEvent {
  return {
    id: String(row.id),
    memory_id: row.memory_id === null ? undefined : String(row.memory_id),
    scope: row.scope as MemoryScope,
    project_id: row.project_id === null ? undefined : String(row.project_id),
    event: row.event as MemoryAuditEvent["event"],
    reason: row.reason === null ? undefined : String(row.reason),
    actor: row.actor as MemoryAuditEvent["actor"],
    metadata: JSON.parse(String(row.metadata_json)),
    created_at: String(row.created_at)
  };
}

function ftsQuery(query: string): string {
  return query
    .split(/\\s+/)
    .map((token) => token.replace(/[^\\p{L}\\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((token) => `"${token}"`)
    .join(" OR ");
}

export class SQLiteMemoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, timeout: 5000 });
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_scopes (
        project_id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        project_path TEXT,
        type TEXT NOT NULL,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        confidence INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL,
        expires_at TEXT,
        review_after TEXT,
        supersedes_json TEXT NOT NULL,
        superseded_by TEXT,
        token_estimate INTEGER NOT NULL,
        char_count INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        scope TEXT NOT NULL,
        project_id TEXT,
        event TEXT NOT NULL,
        reason TEXT,
        actor TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        scope UNINDEXED,
        project_id UNINDEXED,
        topic,
        title,
        body,
        tags
      );
    `);
  }

  upsertProjectScope(scope: ProjectScope): void {
    this.db.prepare(`
      INSERT INTO project_scopes (project_id, canonical_path, display_name, budget_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        canonical_path = excluded.canonical_path,
        display_name = excluded.display_name,
        budget_json = excluded.budget_json,
        updated_at = excluded.updated_at
    `).run(scope.project_id, scope.canonical_path, scope.display_name, encode(scope.budget), scope.created_at, scope.updated_at);
  }

  getProjectScope(projectId: string): ProjectScope | undefined {
    const row = this.db.prepare("SELECT * FROM project_scopes WHERE project_id = ?").get(projectId) as EntryRow | undefined;
    return row ? decodeProject(row) : undefined;
  }

  insertEntry(entry: MemoryEntry): void {
    this.db.prepare(`
      INSERT INTO memory_entries (
        id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json,
        importance, confidence, status, created_at, updated_at, last_accessed_at, access_count,
        expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.scope,
      entry.project_id ?? null,
      entry.project_path ?? null,
      entry.type,
      entry.topic,
      entry.title,
      entry.body,
      encode(entry.tags),
      encode(entry.source),
      entry.importance,
      entry.confidence,
      entry.status,
      entry.created_at,
      entry.updated_at,
      entry.last_accessed_at ?? null,
      entry.access_count,
      entry.expires_at ?? null,
      entry.review_after ?? null,
      encode(entry.supersedes),
      entry.superseded_by ?? null,
      entry.token_estimate,
      entry.char_count
    );
    this.upsertFts(entry);
  }

  private upsertFts(entry: MemoryEntry): void {
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(entry.id);
    this.db.prepare("INSERT INTO memory_fts (id, scope, project_id, topic, title, body, tags) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      entry.id,
      entry.scope,
      entry.project_id ?? "",
      entry.topic,
      entry.title,
      entry.body,
      entry.tags.join(" ")
    );
  }

  getEntry(id: string): MemoryEntry | undefined {
    const row = this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as EntryRow | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?").run(id);
    return decodeEntry(row);
  }

  listEntries(filters: EntryFilters): MemoryEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.scope) {
      clauses.push("scope = ?");
      params.push(filters.scope);
    }
    if (filters.project_id) {
      clauses.push("project_id = ?");
      params.push(filters.project_id);
    }
    if (filters.type) {
      clauses.push("type = ?");
      params.push(filters.type);
    }
    if (filters.topic) {
      clauses.push("topic = ?");
      params.push(filters.topic);
    }
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const rows = this.db.prepare(`SELECT * FROM memory_entries ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as EntryRow[];
    const entries = rows.map(decodeEntry);
    return filters.tags?.length
      ? entries.filter((entry) => filters.tags!.every((tag) => entry.tags.includes(tag)))
      : entries;
  }

  searchEntries(filters: SearchFilters): MemoryEntry[] {
    const query = ftsQuery(filters.query);
    if (!query) return [];
    const clauses = ["memory_fts MATCH ?"];
    const params: unknown[] = [query];
    if (filters.scope) {
      clauses.push("m.scope = ?");
      params.push(filters.scope);
    }
    if (filters.project_id) {
      clauses.push("m.project_id = ?");
      params.push(filters.project_id);
    }
    if (filters.status) {
      clauses.push("m.status = ?");
      params.push(filters.status);
    }
    if (filters.type) {
      clauses.push("m.type = ?");
      params.push(filters.type);
    }
    if (filters.topic) {
      clauses.push("m.topic = ?");
      params.push(filters.topic);
    }
    const rows = this.db.prepare(`
      SELECT m.*
      FROM memory_fts f
      JOIN memory_entries m ON m.id = f.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `).all(...params, filters.limit ?? 10) as EntryRow[];
    const entries = rows.map(decodeEntry);
    return filters.tags?.length
      ? entries.filter((entry) => filters.tags!.every((tag) => entry.tags.includes(tag)))
      : entries;
  }

  updateEntry(id: string, patch: Partial<MemoryEntry> & { updated_at: string }): void {
    const current = this.getEntry(id);
    if (!current) return;
    const next: MemoryEntry = { ...current, ...patch };
    this.db.prepare(`
      UPDATE memory_entries SET
        topic = ?, title = ?, body = ?, tags_json = ?, importance = ?, confidence = ?, status = ?,
        updated_at = ?, expires_at = ?, review_after = ?, superseded_by = ?, token_estimate = ?, char_count = ?
      WHERE id = ?
    `).run(
      next.topic,
      next.title,
      next.body,
      encode(next.tags),
      next.importance,
      next.confidence,
      next.status,
      next.updated_at,
      next.expires_at ?? null,
      next.review_after ?? null,
      next.superseded_by ?? null,
      next.token_estimate,
      next.char_count,
      id
    );
    this.upsertFts(next);
  }

  appendAudit(event: MemoryAuditEvent): void {
    this.db.prepare(`
      INSERT INTO audit_events (id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.memory_id ?? null,
      event.scope,
      event.project_id ?? null,
      event.event,
      event.reason ?? null,
      event.actor,
      encode(event.metadata),
      event.created_at
    );
  }

  getAuditEvents(memoryId: string): MemoryAuditEvent[] {
    const rows = this.db.prepare("SELECT * FROM audit_events WHERE memory_id = ? ORDER BY created_at ASC").all(memoryId) as EntryRow[];
    return rows.map(decodeAudit);
  }

  getBudgetUsage(filters: { scope: MemoryScope; project_id?: string }): BudgetUsage {
    const entries = this.listEntries({ ...filters, status: "active", limit: 10_000 });
    const topic_chars: Record<string, number> = {};
    for (const entry of entries) {
      topic_chars[entry.topic] = (topic_chars[entry.topic] ?? 0) + entry.char_count;
    }
    return {
      active_entries: entries.length,
      active_chars: entries.reduce((sum, entry) => sum + entry.char_count, 0),
      topic_chars,
      index_chars: entries.reduce((sum, entry) => sum + entry.title.length + entry.topic.length + entry.tags.join(" ").length + 16, 0)
    };
  }
}
```

- [ ] **Step 4: Run SQLite store tests**

Run:

```bash
rtk npm test -- test/sqlite-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full tests and typecheck**

Run:

```bash
rtk npm test
rtk npm run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 6: Commit store**

Run:

```bash
rtk git add src/sqlite-store.ts test/sqlite-store.test.ts
rtk git commit -m "feat: persist memory in sqlite"
```

Expected: commit succeeds.

## Task 6: Add Budget Governance

**Files:**
- Create: `src/budget-governor.ts`
- Create: `test/budget-governor.test.ts`

- [ ] **Step 1: Write budget tests**

Create `test/budget-governor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/domain.js";
import { evaluateBudget, rankCleanupCandidates } from "../src/budget-governor.js";

function entry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    scope: "project",
    project_id: "repo-123",
    type: "lesson",
    topic: "tests",
    title: `Memory ${id}`,
    body: "A memory body",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 4,
    char_count: 20,
    ...overrides
  };
}

describe("evaluateBudget", () => {
  it("allows writes inside budget", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 3, max_total_chars: 100, max_topic_chars: 80, max_index_chars: 200 },
      usage: { active_entries: 1, active_chars: 20, topic_chars: { tests: 20 }, index_chars: 20 },
      candidate: entry("mem_new")
    });
    expect(result.ok).toBe(true);
  });

  it("rejects writes exceeding active entry count and returns actions", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 1, max_total_chars: 100, max_topic_chars: 80, max_index_chars: 200 },
      usage: { active_entries: 1, active_chars: 20, topic_chars: { tests: 20 }, index_chars: 20 },
      candidate: entry("mem_new"),
      existingEntries: [entry("mem_old", { importance: 1, confidence: 1 })]
    });
    expect(result).toMatchObject({
      ok: false,
      error: "capacity_exceeded"
    });
    if (!result.ok) {
      expect(result.details?.candidate_actions).toEqual([
        expect.objectContaining({ action: "forget_memory", memory_id: "mem_old" })
      ]);
    }
  });

  it("warns when duplicate title and body candidates exist", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 10, max_total_chars: 1000, max_topic_chars: 500, max_index_chars: 500 },
      usage: { active_entries: 1, active_chars: 20, topic_chars: { tests: 20 }, index_chars: 20 },
      candidate: entry("mem_new", { title: "Same", body: "Same body" }),
      existingEntries: [entry("mem_old", { title: "Same", body: "Same body" })]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toContainEqual(expect.objectContaining({ code: "duplicate_candidate" }));
    }
  });
});

describe("rankCleanupCandidates", () => {
  it("prefers low importance, expired, low access memories", () => {
    const ranked = rankCleanupCandidates([
      entry("keep", { importance: 5, confidence: 5, access_count: 20 }),
      entry("remove", { importance: 1, confidence: 1, expires_at: "2026-01-01T00:00:00.000Z" })
    ], "2026-06-13T00:00:00.000Z");
    expect(ranked[0]?.memory_id).toBe("remove");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- test/budget-governor.test.ts
```

Expected: FAIL with module resolution error for `../src/budget-governor.js`.

- [ ] **Step 3: Implement budget governor**

Create `src/budget-governor.ts`:

```ts
import { err, ok, type MemoryBudget, type MemoryEntry, type Result } from "./domain.js";
import type { BudgetUsage } from "./sqlite-store.js";

export type BudgetWarning = {
  code: "duplicate_candidate";
  memory_id: string;
  reason: string;
};

export type CandidateAction = {
  action: "forget_memory" | "supersede_memory" | "archive";
  memory_id?: string;
  memory_ids?: string[];
  reason: string;
};

export type BudgetAccepted = {
  warnings: BudgetWarning[];
  budget_after: BudgetUsage;
};

export type BudgetInput = {
  budget: MemoryBudget;
  usage: BudgetUsage;
  candidate: Pick<MemoryEntry, "topic" | "title" | "body" | "char_count">;
  existingEntries?: MemoryEntry[];
  now?: string;
};

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function rankCleanupCandidates(entries: MemoryEntry[], now: string): CandidateAction[] {
  return entries
    .map((entry) => {
      let score = 0;
      score += 6 - entry.importance;
      score += 6 - entry.confidence;
      if (entry.expires_at && entry.expires_at <= now) score += 5;
      if (entry.review_after && entry.review_after <= now) score += 2;
      if (entry.access_count === 0) score += 2;
      if (entry.source.kind === "user") score -= 3;
      if (entry.importance >= 5) score -= 5;
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ entry }) => ({
      action: entry.expires_at && entry.expires_at <= now ? "forget_memory" : "archive",
      memory_id: entry.id,
      reason: entry.expires_at && entry.expires_at <= now ? "expired low-value entry" : "stale low-value entry"
    }));
}

export function evaluateBudget(input: BudgetInput): Result<BudgetAccepted, "capacity_exceeded"> {
  const existingEntries = input.existingEntries ?? [];
  const warnings: BudgetWarning[] = existingEntries
    .filter((entry) => sameText(entry.title, input.candidate.title) || sameText(entry.body, input.candidate.body))
    .map((entry) => ({
      code: "duplicate_candidate",
      memory_id: entry.id,
      reason: "existing active memory has the same title or body"
    }));

  const budget_after: BudgetUsage = {
    active_entries: input.usage.active_entries + 1,
    active_chars: input.usage.active_chars + input.candidate.char_count,
    topic_chars: {
      ...input.usage.topic_chars,
      [input.candidate.topic]: (input.usage.topic_chars[input.candidate.topic] ?? 0) + input.candidate.char_count
    },
    index_chars: input.usage.index_chars + input.candidate.title.length + input.candidate.topic.length + 16
  };

  const exceeds =
    budget_after.active_entries > input.budget.max_active_entries ||
    budget_after.active_chars > input.budget.max_total_chars ||
    budget_after.index_chars > input.budget.max_index_chars ||
    (input.budget.max_topic_chars !== undefined &&
      (budget_after.topic_chars[input.candidate.topic] ?? 0) > input.budget.max_topic_chars);

  if (!exceeds) {
    return ok({ warnings, budget_after });
  }

  return err("capacity_exceeded", "memory write would exceed configured budget", {
    budget: input.budget,
    usage: input.usage,
    budget_after,
    candidate_actions: rankCleanupCandidates(existingEntries, input.now ?? new Date().toISOString())
  });
}
```

- [ ] **Step 4: Run budget tests**

Run:

```bash
rtk npm test -- test/budget-governor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit budget governor**

Run:

```bash
rtk git add src/budget-governor.ts test/budget-governor.test.ts
rtk git commit -m "feat: enforce memory budgets"
```

Expected: commit succeeds.

## Task 7: Add Memory Service Lifecycle Operations

**Files:**
- Create: `src/memory-service.ts`
- Create: `test/memory-service.test.ts`

- [ ] **Step 1: Write memory service tests**

Create `test/memory-service.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_BUDGET } from "../src/domain.js";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function service() {
  const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-service-")), "memory.sqlite"));
  return { store, memory: new MemoryService(store) };
}

describe("MemoryService", () => {
  it("remembers, searches, and reads project memory", () => {
    const { store, memory } = service();
    const result = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "debugging",
      topic: "database",
      title: "Postgres tests need local database",
      body: "Start the local database before running integration tests.",
      tags: ["postgres", "tests"],
      source: { kind: "agent", ref: "test" },
      importance: 4,
      confidence: 5
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(memory.searchMemories({ scope: "project", project_id: "repo-123", query: "postgres", limit: 5 }).items).toHaveLength(1);
      expect(memory.getMemory(result.value.memory_id)?.entry.title).toBe("Postgres tests need local database");
    }
    store.close();
  });

  it("rejects over-budget writes without mutating state", () => {
    const { store, memory } = service();
    memory.configureProjectBudget("repo-123", DEFAULT_PROJECT_BUDGET, "G:\\Projects\\Repo", "Repo");
    memory.configureProjectBudget("repo-123", { max_active_entries: 1, max_total_chars: 1000, max_topic_chars: 1000, max_index_chars: 1000 }, "G:\\Projects\\Repo", "Repo");
    expect(memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "tests",
      title: "First",
      body: "First memory",
      tags: [],
      source: { kind: "agent" },
      importance: 2,
      confidence: 2
    }).ok).toBe(true);
    const rejected = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "tests",
      title: "Second",
      body: "Second memory",
      tags: [],
      source: { kind: "agent" },
      importance: 2,
      confidence: 2
    });
    expect(rejected).toMatchObject({ ok: false, error: "capacity_exceeded" });
    expect(memory.listMemories({ scope: "project", project_id: "repo-123" }).items).toHaveLength(1);
    store.close();
  });

  it("updates, supersedes, forgets, and preserves audit history", () => {
    const { store, memory } = service();
    const first = memory.remember({
      scope: "global",
      type: "preference",
      topic: "shell",
      title: "Use rtk",
      body: "Prefix shell commands with rtk.",
      tags: ["shell"],
      source: { kind: "user" },
      importance: 5,
      confidence: 5
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first memory");
    expect(memory.updateMemory(first.value.memory_id, { title: "Use rtk wrapper" }).ok).toBe(true);
    const replacement = memory.supersedeMemory({
      old_memory_ids: [first.value.memory_id],
      replacement: {
        scope: "global",
        type: "preference",
        topic: "shell",
        title: "Use rtk wrapper for shell commands",
        body: "Always prefix shell commands with rtk in this environment.",
        tags: ["shell"],
        source: { kind: "user" },
        importance: 5,
        confidence: 5
      },
      reason: "clarified wording"
    });
    expect(replacement.ok).toBe(true);
    expect(memory.getMemory(first.value.memory_id)?.entry.status).toBe("superseded");
    expect(memory.forgetMemory(first.value.memory_id, "old wording no longer needed").ok).toBe(true);
    const forgotten = memory.getMemory(first.value.memory_id);
    expect(forgotten?.entry.status).toBe("forgotten");
    expect(forgotten?.entry.body).toBe("");
    expect(forgotten?.audit.length).toBeGreaterThanOrEqual(3);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- test/memory-service.test.ts
```

Expected: FAIL with module resolution error for `../src/memory-service.js`.

- [ ] **Step 3: Implement memory service**

Create `src/memory-service.ts`:

```ts
import {
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_PROJECT_BUDGET,
  computeEntrySize,
  createAuditId,
  createMemoryId,
  err,
  nowIso,
  ok,
  type MemoryAuditEvent,
  type MemoryBudget,
  type MemoryEntry,
  type MemoryScope,
  type ProjectScope,
  type Result
} from "./domain.js";
import { evaluateBudget } from "./budget-governor.js";
import { resolveMemoryScope } from "./scope-resolver.js";
import type { EntryFilters, SearchFilters, SQLiteMemoryStore } from "./sqlite-store.js";
import { type RememberInput, type UpdateInput, validateRememberInput, validateUpdateInput } from "./write-validator.js";

export type RememberResult = {
  memory_id: string;
  status: MemoryEntry["status"];
  budget_after: unknown;
  warnings: unknown[];
};

export type ListResult = {
  items: MemoryEntry[];
};

export type SearchResult = {
  items: Array<Pick<MemoryEntry, "id" | "scope" | "project_id" | "type" | "topic" | "title" | "tags" | "source" | "updated_at" | "status"> & {
    match_reason: string;
  }>;
};

export class MemoryService {
  constructor(private readonly store: SQLiteMemoryStore) {}

  configureProjectBudget(project_id: string, budget: MemoryBudget, canonical_path: string, display_name: string): ProjectScope {
    const now = nowIso();
    const existing = this.store.getProjectScope(project_id);
    const scope: ProjectScope = {
      project_id,
      canonical_path,
      display_name,
      budget,
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    this.store.upsertProjectScope(scope);
    return scope;
  }

  remember(input: RememberInput): Result<RememberResult, "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded"> {
    const validated = validateRememberInput(input);
    if (!validated.ok) {
      this.auditRejected(input.scope === "project" ? "project" : "global", input.project_id, validated.error, validated.details);
      return validated;
    }
    const resolved = resolveMemoryScope(input);
    if (!resolved.ok) return resolved;
    const now = nowIso();
    const projectScope = resolved.value.scope === "project"
      ? this.ensureProjectScope(resolved.value.project_id!, resolved.value.project_path ?? "", resolved.value.display_name ?? resolved.value.project_id!)
      : undefined;
    const entry: MemoryEntry = {
      id: createMemoryId(),
      ...validated.value,
      project_id: resolved.value.project_id,
      project_path: resolved.value.project_path,
      created_at: now,
      updated_at: now,
      access_count: 0
    };
    const budget = entry.scope === "global" ? DEFAULT_GLOBAL_BUDGET : projectScope!.budget;
    const usage = this.store.getBudgetUsage({ scope: entry.scope, project_id: entry.project_id });
    const existingEntries = this.store.listEntries({ scope: entry.scope, project_id: entry.project_id, status: "active", limit: 10_000 });
    const budgetResult = evaluateBudget({ budget, usage, candidate: entry, existingEntries, now });
    if (!budgetResult.ok) {
      this.auditRejected(entry.scope, entry.project_id, "capacity_exceeded", budgetResult.details);
      return budgetResult;
    }
    this.store.insertEntry(entry);
    this.appendAudit({
      memory_id: entry.id,
      scope: entry.scope,
      project_id: entry.project_id,
      event: "created",
      actor: "agent",
      metadata: { type: entry.type, topic: entry.topic }
    });
    return ok({
      memory_id: entry.id,
      status: entry.status,
      budget_after: budgetResult.value.budget_after,
      warnings: budgetResult.value.warnings
    });
  }

  getMemory(id: string): { entry: MemoryEntry; audit: MemoryAuditEvent[] } | undefined {
    const entry = this.store.getEntry(id);
    if (!entry) return undefined;
    return { entry, audit: this.store.getAuditEvents(id) };
  }

  listMemories(filters: EntryFilters): ListResult {
    return { items: this.store.listEntries({ status: "active", ...filters }) };
  }

  searchMemories(filters: SearchFilters & { include_global?: boolean }): SearchResult {
    const status = filters.status ?? "active";
    const projectItems = this.store.searchEntries({ ...filters, status });
    const globalItems = filters.scope === "project" && filters.include_global
      ? this.store.searchEntries({ query: filters.query, scope: "global", status, limit: filters.limit ?? 10 })
      : [];
    return {
      items: [...globalItems, ...projectItems].slice(0, filters.limit ?? 10).map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        project_id: entry.project_id,
        type: entry.type,
        topic: entry.topic,
        title: entry.title,
        tags: entry.tags,
        source: entry.source,
        updated_at: entry.updated_at,
        status: entry.status,
        match_reason: "SQLite FTS matched query text against title, body, topic, or tags"
      }))
    };
  }

  updateMemory(id: string, input: UpdateInput): Result<{ memory_id: string }, "not_found" | "invalid_state" | "invalid_schema" | "secret_detected"> {
    const current = this.store.getEntry(id);
    if (!current) return err("not_found", "memory not found");
    if (current.status === "forgotten") return err("invalid_state", "forgotten memories cannot be updated");
    const validated = validateUpdateInput(input);
    if (!validated.ok) return validated;
    const patch: Partial<MemoryEntry> & { updated_at: string } = { ...validated.value, updated_at: nowIso() };
    if (validated.value.title !== undefined || validated.value.body !== undefined || validated.value.tags !== undefined) {
      const title = validated.value.title ?? current.title;
      const body = validated.value.body ?? current.body;
      const tags = validated.value.tags ?? current.tags;
      Object.assign(patch, computeEntrySize(title, body, tags));
    }
    this.store.updateEntry(id, patch);
    this.appendAudit({
      memory_id: id,
      scope: current.scope,
      project_id: current.project_id,
      event: "updated",
      actor: "agent",
      metadata: { fields: Object.keys(validated.value) }
    });
    return ok({ memory_id: id });
  }

  supersedeMemory(input: { old_memory_ids: string[]; replacement: RememberInput; reason: string }): Result<{ memory_id: string }, string> {
    const created = this.remember({ ...input.replacement, supersedes: input.old_memory_ids });
    if (!created.ok) return created;
    for (const oldId of input.old_memory_ids) {
      const old = this.store.getEntry(oldId);
      if (!old || old.status === "forgotten") continue;
      this.store.updateEntry(oldId, {
        status: "superseded",
        superseded_by: created.value.memory_id,
        updated_at: nowIso()
      });
      this.appendAudit({
        memory_id: oldId,
        scope: old.scope,
        project_id: old.project_id,
        event: "superseded",
        actor: "agent",
        reason: input.reason,
        metadata: { superseded_by: created.value.memory_id }
      });
    }
    return ok({ memory_id: created.value.memory_id });
  }

  forgetMemory(id: string, reason: string): Result<{ memory_id: string; released_chars: number }, "not_found"> {
    const current = this.store.getEntry(id);
    if (!current) return err("not_found", "memory not found");
    const released_chars = current.status === "active" ? current.char_count : 0;
    this.store.updateEntry(id, {
      status: "forgotten",
      body: "",
      title: current.title,
      tags: [],
      char_count: 0,
      token_estimate: 0,
      updated_at: nowIso()
    });
    this.appendAudit({
      memory_id: id,
      scope: current.scope,
      project_id: current.project_id,
      event: "forgotten",
      actor: "agent",
      reason,
      metadata: { released_chars }
    });
    return ok({ memory_id: id, released_chars });
  }

  getMemoryBudget(input: { scope: MemoryScope; project_id?: string }) {
    const budget = input.scope === "global"
      ? DEFAULT_GLOBAL_BUDGET
      : this.store.getProjectScope(input.project_id ?? "")?.budget ?? DEFAULT_PROJECT_BUDGET;
    const usage = this.store.getBudgetUsage(input);
    const cleanup_candidates = this.store.listEntries({ ...input, status: "active", limit: 10_000 });
    return { budget, usage, cleanup_candidates };
  }

  private ensureProjectScope(project_id: string, project_path: string, display_name: string): ProjectScope {
    const existing = this.store.getProjectScope(project_id);
    if (existing) return existing;
    return this.configureProjectBudget(project_id, DEFAULT_PROJECT_BUDGET, project_path, display_name);
  }

  private appendAudit(input: Omit<MemoryAuditEvent, "id" | "created_at">): void {
    this.store.appendAudit({
      id: createAuditId(),
      created_at: nowIso(),
      ...input
    });
  }

  private auditRejected(scope: MemoryScope, project_id: string | undefined, reason: string, metadata: unknown): void {
    this.appendAudit({
      scope,
      project_id,
      event: "write_rejected",
      actor: "system",
      reason,
      metadata: typeof metadata === "object" && metadata !== null ? metadata as Record<string, unknown> : {}
    });
  }
}
```

- [ ] **Step 4: Run memory service tests**

Run:

```bash
rtk npm test -- test/memory-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full tests and typecheck**

Run:

```bash
rtk npm test
rtk npm run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 6: Commit service lifecycle**

Run:

```bash
rtk git add src/memory-service.ts test/memory-service.test.ts
rtk git commit -m "feat: add memory lifecycle service"
```

Expected: commit succeeds.

## Task 8: Add Markdown Export and Context Packs

**Files:**
- Create: `src/markdown-exporter.ts`
- Create: `test/markdown-exporter.test.ts`
- Modify: `src/memory-service.ts`
- Modify: `test/memory-service.test.ts`

- [ ] **Step 1: Write markdown exporter tests**

Create `test/markdown-exporter.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MarkdownExporter } from "../src/markdown-exporter.js";
import type { MemoryEntry } from "../src/domain.js";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "mem_001",
    scope: overrides.scope ?? "global",
    type: overrides.type ?? "preference",
    topic: overrides.topic ?? "shell",
    title: overrides.title ?? "Use rtk",
    body: overrides.body ?? "Prefix shell commands with rtk.",
    tags: overrides.tags ?? ["shell"],
    source: overrides.source ?? { kind: "user" },
    importance: overrides.importance ?? 5,
    confidence: overrides.confidence ?? 5,
    status: overrides.status ?? "active",
    created_at: overrides.created_at ?? "2026-06-13T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-06-13T00:00:00.000Z",
    access_count: overrides.access_count ?? 0,
    supersedes: overrides.supersedes ?? [],
    token_estimate: overrides.token_estimate ?? 8,
    char_count: overrides.char_count ?? 32
  };
}

describe("MarkdownExporter", () => {
  it("builds a bounded context pack with memory ids and no forgotten bodies", () => {
    const exporter = new MarkdownExporter(join(mkdtempSync(join(tmpdir(), "lm-export-")), "exports"));
    const markdown = exporter.buildContextPack({
      title: "Context",
      budget_chars: 500,
      entries: [
        entry(),
        entry({ id: "mem_002", status: "forgotten", body: "hidden secret" })
      ]
    });
    expect(markdown).toContain("mem_001");
    expect(markdown).toContain("Use rtk");
    expect(markdown).not.toContain("hidden secret");
  });

  it("writes deterministic global index and topic files", () => {
    const root = join(mkdtempSync(join(tmpdir(), "lm-export-")), "exports");
    const exporter = new MarkdownExporter(root);
    exporter.exportScope({
      scope: "global",
      entries: [entry()],
      budgetStatus: "1 active entries, 32 active chars"
    });
    const index = readFileSync(join(root, "global", "MEMORY.md"), "utf8");
    const topic = readFileSync(join(root, "global", "topics", "shell.md"), "utf8");
    expect(index).toContain("Local Memory MCP Export");
    expect(index).toContain("shell");
    expect(topic).toContain("mem_001");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- test/markdown-exporter.test.ts
```

Expected: FAIL with module resolution error for `../src/markdown-exporter.js`.

- [ ] **Step 3: Implement markdown exporter**

Create `src/markdown-exporter.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, MemoryScope } from "./domain.js";

export type ContextPackInput = {
  title: string;
  budget_chars: number;
  entries: MemoryEntry[];
};

export type ExportScopeInput = {
  scope: MemoryScope;
  project_id?: string;
  entries: MemoryEntry[];
  budgetStatus: string;
};

function safeTopic(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "general";
}

function entrySummary(entry: MemoryEntry): string {
  return `- [${entry.id}] (${entry.type}, importance ${entry.importance}, confidence ${entry.confidence}) ${entry.title}`;
}

function entryDetail(entry: MemoryEntry): string {
  return [
    `### ${entry.title}`,
    "",
    `- id: ${entry.id}`,
    `- type: ${entry.type}`,
    `- status: ${entry.status}`,
    `- tags: ${entry.tags.join(", ") || "none"}`,
    `- source: ${entry.source.kind}${entry.source.ref ? `:${entry.source.ref}` : ""}`,
    "",
    entry.status === "forgotten" ? "_Body removed by forget_memory._" : entry.body,
    ""
  ].join("\n");
}

export class MarkdownExporter {
  constructor(private readonly exportRoot: string) {}

  buildContextPack(input: ContextPackInput): string {
    const lines = [`# ${input.title}`, ""];
    let used = lines.join("\n").length;
    const sorted = [...input.entries]
      .filter((entry) => entry.status !== "forgotten")
      .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence || b.updated_at.localeCompare(a.updated_at));

    for (const entry of sorted) {
      const block = [
        `## ${entry.title}`,
        "",
        `memory_id: ${entry.id}`,
        `scope: ${entry.scope}${entry.project_id ? `/${entry.project_id}` : ""}`,
        `type: ${entry.type}`,
        `topic: ${entry.topic}`,
        `tags: ${entry.tags.join(", ") || "none"}`,
        "",
        entry.body,
        ""
      ].join("\n");
      if (used + block.length > input.budget_chars) break;
      lines.push(block);
      used += block.length;
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  exportScope(input: ExportScopeInput): { indexPath: string; topicPaths: string[] } {
    const dir = input.scope === "global"
      ? join(this.exportRoot, "global")
      : join(this.exportRoot, "projects", input.project_id ?? "unknown-project");
    const topicsDir = join(dir, "topics");
    mkdirSync(topicsDir, { recursive: true });

    const activeEntries = input.entries.filter((entry) => entry.status === "active");
    const topics = [...new Set(activeEntries.map((entry) => entry.topic))].sort();
    const index = [
      "# Local Memory MCP Export",
      "",
      "> Generated from SQLite. SQLite is authoritative; manual edits may be overwritten.",
      "",
      `Scope: ${input.scope}${input.project_id ? `/${input.project_id}` : ""}`,
      `Budget: ${input.budgetStatus}`,
      "",
      "## Topics",
      "",
      ...topics.map((topic) => `- [${topic}](topics/${safeTopic(topic)}.md)`),
      "",
      "## High Importance",
      "",
      ...activeEntries.filter((entry) => entry.importance >= 4).map(entrySummary),
      ""
    ].join("\n");
    const indexPath = join(dir, "MEMORY.md");
    writeFileSync(indexPath, index, "utf8");

    const topicPaths = topics.map((topic) => {
      const path = join(topicsDir, `${safeTopic(topic)}.md`);
      const body = [
        `# ${topic}`,
        "",
        "> Generated from SQLite. SQLite is authoritative; manual edits may be overwritten.",
        "",
        ...activeEntries.filter((entry) => entry.topic === topic).map(entryDetail)
      ].join("\n");
      writeFileSync(path, body, "utf8");
      return path;
    });
    return { indexPath, topicPaths };
  }
}
```

- [ ] **Step 4: Extend memory service with context export and maintenance**

Modify `src/memory-service.ts` by adding this import:

```ts
import { MarkdownExporter } from "./markdown-exporter.js";
```

Extend the constructor and add methods inside `MemoryService`:

```ts
constructor(
  private readonly store: SQLiteMemoryStore,
  private readonly exporter?: MarkdownExporter
) {}

exportMemoryContext(input: {
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  query?: string;
  include_global?: boolean;
  budget_chars: number;
  types?: string[];
  topics?: string[];
}): string {
  const entries = input.query
    ? this.searchMemories({
        query: input.query,
        scope: input.scope,
        project_id: input.project_id,
        include_global: input.include_global,
        limit: 50
      }).items.map((item) => this.store.getEntry(item.id)).filter((entry): entry is MemoryEntry => Boolean(entry))
    : this.store.listEntries({ scope: input.scope, project_id: input.project_id, status: "active", limit: 50 });

  const filtered = entries.filter((entry) => {
    if (input.types?.length && !input.types.includes(entry.type)) return false;
    if (input.topics?.length && !input.topics.includes(entry.topic)) return false;
    return true;
  });

  const exporter = this.exporter ?? new MarkdownExporter(".local-memory-mcp/exports");
  return exporter.buildContextPack({
    title: "Local Memory Context",
    budget_chars: input.budget_chars,
    entries: filtered
  });
}

maintainMemories(input: {
  action: "archive_low_value" | "expire_due" | "rebuild_markdown_index" | "vacuum_fts" | "find_duplicates";
  scope: MemoryScope;
  project_id?: string;
}): { action: string; changed: number; details: unknown } {
  if (input.action === "rebuild_markdown_index") {
    const entries = this.store.listEntries({ scope: input.scope, project_id: input.project_id, limit: 10_000 });
    const usage = this.store.getBudgetUsage({ scope: input.scope, project_id: input.project_id });
    const exporter = this.exporter ?? new MarkdownExporter(".local-memory-mcp/exports");
    const paths = exporter.exportScope({
      scope: input.scope,
      project_id: input.project_id,
      entries,
      budgetStatus: `${usage.active_entries} active entries, ${usage.active_chars} active chars`
    });
    this.appendAudit({
      scope: input.scope,
      project_id: input.project_id,
      event: "markdown_exported",
      actor: "agent",
      metadata: paths
    });
    return { action: input.action, changed: paths.topicPaths.length + 1, details: paths };
  }
  const entries = this.store.listEntries({ scope: input.scope, project_id: input.project_id, status: "active", limit: 10_000 });
  if (input.action === "find_duplicates") {
    const groups = entries
      .map((entry) => ({ key: `${entry.title.toLowerCase()}|${entry.body.toLowerCase()}`, entry }))
      .reduce<Record<string, string[]>>((acc, item) => {
        acc[item.key] = [...(acc[item.key] ?? []), item.entry.id];
        return acc;
      }, {});
    return { action: input.action, changed: 0, details: Object.values(groups).filter((ids) => ids.length > 1) };
  }
  if (input.action === "expire_due") {
    const now = nowIso();
    const expired = entries.filter((entry) => entry.expires_at && entry.expires_at <= now);
    for (const entry of expired) this.forgetMemory(entry.id, "expired by maintain_memories");
    return { action: input.action, changed: expired.length, details: expired.map((entry) => entry.id) };
  }
  if (input.action === "archive_low_value") {
    const lowValue = entries.filter((entry) => entry.importance <= 2 && entry.confidence <= 2 && entry.access_count === 0);
    for (const entry of lowValue) this.updateMemory(entry.id, { status: "archived" });
    return { action: input.action, changed: lowValue.length, details: lowValue.map((entry) => entry.id) };
  }
  return { action: input.action, changed: 0, details: "SQLite FTS vacuum is not required for the current V1 schema" };
}
```

- [ ] **Step 5: Add service tests for context and maintenance**

Append to `test/memory-service.test.ts`:

```ts
it("exports bounded context and rebuilds markdown index", () => {
  const { store, memory } = service();
  const remembered = memory.remember({
    scope: "global",
    type: "preference",
    topic: "shell",
    title: "Use rtk",
    body: "Prefix shell commands with rtk.",
    tags: ["shell"],
    source: { kind: "user" },
    importance: 5,
    confidence: 5
  });
  expect(remembered.ok).toBe(true);
  expect(memory.exportMemoryContext({ scope: "global", query: "rtk", budget_chars: 500 })).toContain("Use rtk");
  const maintained = memory.maintainMemories({ action: "find_duplicates", scope: "global" });
  expect(maintained).toMatchObject({ action: "find_duplicates", changed: 0 });
  store.close();
});
```

- [ ] **Step 6: Run markdown and service tests**

Run:

```bash
rtk npm test -- test/markdown-exporter.test.ts test/memory-service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full tests and typecheck**

Run:

```bash
rtk npm test
rtk npm run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 8: Commit markdown export**

Run:

```bash
rtk git add src/markdown-exporter.ts src/memory-service.ts test/markdown-exporter.test.ts test/memory-service.test.ts
rtk git commit -m "feat: export memory context"
```

Expected: commit succeeds.

## Task 9: Add MCP Tool Schemas and Stdio Entrypoint

**Files:**
- Create: `src/tools/schemas.ts`
- Create: `src/tools/register-tools.ts`
- Modify: `src/index.ts`
- Create: `test/tool-registration.test.ts`

- [ ] **Step 1: Write tool registration tests**

Create `test/tool-registration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rememberSchema, searchSchema } from "../src/tools/schemas.js";
import { createMemoryToolHandlers } from "../src/tools/register-tools.js";

describe("tool schemas", () => {
  it("validates remember and search inputs", () => {
    expect(rememberSchema.parse({
      scope: "global",
      type: "fact",
      topic: "project",
      title: "Uses SQLite",
      body: "The service stores memory in SQLite.",
      tags: ["sqlite"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 5
    })).toMatchObject({ scope: "global" });

    expect(searchSchema.parse({
      query: "sqlite",
      scope: "global"
    })).toMatchObject({ limit: 10 });
  });
});

describe("createMemoryToolHandlers", () => {
  it("wraps service results as MCP text content", async () => {
    const calls: string[] = [];
    const handlers = createMemoryToolHandlers({
      remember(input) {
        calls.push(input.title);
        return { ok: true, value: { memory_id: "mem_123", status: "active", budget_after: {}, warnings: [] } };
      }
    } as never);
    const response = await handlers.remember({
      scope: "global",
      type: "fact",
      topic: "project",
      title: "Uses SQLite",
      body: "The service stores memory in SQLite.",
      tags: ["sqlite"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 5
    });
    expect(calls).toEqual(["Uses SQLite"]);
    expect(response.content[0]?.type).toBe("text");
    expect(response.content[0]?.text).toContain("mem_123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- test/tool-registration.test.ts
```

Expected: FAIL with module resolution errors for tool modules.

- [ ] **Step 3: Add Zod tool schemas**

Create `src/tools/schemas.ts`:

```ts
import * as z from "zod/v4";

const sourceSchema = z.object({
  kind: z.enum(["user", "agent", "tool", "file", "command", "external"]),
  ref: z.string().optional()
});

export const rememberSchema = z.object({
  scope: z.enum(["global", "project"]),
  project_id: z.string().optional(),
  project_path: z.string().optional(),
  type: z.enum(["preference", "procedure", "fact", "decision", "lesson", "debugging", "constraint"]),
  topic: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string()).default([]),
  source: sourceSchema,
  importance: z.number().int().min(1).max(5),
  confidence: z.number().int().min(1).max(5),
  expires_at: z.string().optional(),
  review_after: z.string().optional(),
  supersedes: z.array(z.string()).optional()
});

export const searchSchema = z.object({
  query: z.string().min(1),
  scope: z.enum(["global", "project"]).optional(),
  project_id: z.string().optional(),
  project_path: z.string().optional(),
  include_global: z.boolean().default(false),
  type: z.string().optional(),
  topic: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(10)
});

export const getMemorySchema = z.object({
  id: z.string().min(1)
});

export const listSchema = z.object({
  scope: z.enum(["global", "project"]).optional(),
  project_id: z.string().optional(),
  type: z.string().optional(),
  topic: z.string().optional(),
  status: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0)
});

export const updateSchema = z.object({
  id: z.string().min(1),
  topic: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  confidence: z.number().int().min(1).max(5).optional(),
  expires_at: z.string().optional(),
  review_after: z.string().optional(),
  status: z.enum(["active", "archived"]).optional()
});

export const supersedeSchema = z.object({
  old_memory_ids: z.array(z.string()).min(1),
  replacement: rememberSchema,
  reason: z.string().min(1)
});

export const forgetSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1)
});

export const budgetSchema = z.object({
  scope: z.enum(["global", "project"]),
  project_id: z.string().optional()
});

export const maintainSchema = z.object({
  action: z.enum(["archive_low_value", "expire_due", "rebuild_markdown_index", "vacuum_fts", "find_duplicates"]),
  scope: z.enum(["global", "project"]),
  project_id: z.string().optional()
});

export const exportContextSchema = z.object({
  scope: z.enum(["global", "project"]),
  project_id: z.string().optional(),
  project_path: z.string().optional(),
  query: z.string().optional(),
  include_global: z.boolean().default(false),
  budget_chars: z.number().int().min(100).max(50_000).default(8000),
  types: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional()
});
```

- [ ] **Step 4: Add MCP handler registration**

Create `src/tools/register-tools.ts`:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryService } from "../memory-service.js";
import {
  budgetSchema,
  exportContextSchema,
  forgetSchema,
  getMemorySchema,
  listSchema,
  maintainSchema,
  rememberSchema,
  searchSchema,
  supersedeSchema,
  updateSchema
} from "./schemas.js";

function asText(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function createMemoryToolHandlers(service: MemoryService) {
  return {
    async remember(input: unknown) {
      return asText(service.remember(rememberSchema.parse(input)));
    },
    async search_memories(input: unknown) {
      return asText(service.searchMemories(searchSchema.parse(input)));
    },
    async get_memory(input: unknown) {
      const parsed = getMemorySchema.parse(input);
      return asText(service.getMemory(parsed.id) ?? { error: "not_found" });
    },
    async list_memories(input: unknown) {
      return asText(service.listMemories(listSchema.parse(input)));
    },
    async update_memory(input: unknown) {
      const parsed = updateSchema.parse(input);
      const { id, ...patch } = parsed;
      return asText(service.updateMemory(id, patch));
    },
    async supersede_memory(input: unknown) {
      return asText(service.supersedeMemory(supersedeSchema.parse(input)));
    },
    async forget_memory(input: unknown) {
      const parsed = forgetSchema.parse(input);
      return asText(service.forgetMemory(parsed.id, parsed.reason));
    },
    async get_memory_budget(input: unknown) {
      return asText(service.getMemoryBudget(budgetSchema.parse(input)));
    },
    async maintain_memories(input: unknown) {
      return asText(service.maintainMemories(maintainSchema.parse(input)));
    },
    async export_memory_context(input: unknown) {
      return asText(service.exportMemoryContext(exportContextSchema.parse(input)));
    }
  };
}

export function registerMemoryTools(server: McpServer, service: MemoryService): void {
  const handlers = createMemoryToolHandlers(service);
  server.registerTool("remember", {
    description: "Write one governed memory entry.",
    inputSchema: rememberSchema
  }, handlers.remember);
  server.registerTool("search_memories", {
    description: "Search active memories with SQLite FTS and metadata filters.",
    inputSchema: searchSchema
  }, handlers.search_memories);
  server.registerTool("get_memory", {
    description: "Read one complete memory and its audit summary.",
    inputSchema: getMemorySchema
  }, handlers.get_memory);
  server.registerTool("list_memories", {
    description: "List memories for review and maintenance.",
    inputSchema: listSchema
  }, handlers.list_memories);
  server.registerTool("update_memory", {
    description: "Update mutable fields on an active or archived memory.",
    inputSchema: updateSchema
  }, handlers.update_memory);
  server.registerTool("supersede_memory", {
    description: "Replace old memories with a new memory while preserving history.",
    inputSchema: supersedeSchema
  }, handlers.supersede_memory);
  server.registerTool("forget_memory", {
    description: "Soft-delete a memory and keep an audit tombstone.",
    inputSchema: forgetSchema
  }, handlers.forget_memory);
  server.registerTool("get_memory_budget", {
    description: "Inspect scope capacity and cleanup candidates.",
    inputSchema: budgetSchema
  }, handlers.get_memory_budget);
  server.registerTool("maintain_memories", {
    description: "Run deterministic maintenance actions selected by the agent.",
    inputSchema: maintainSchema
  }, handlers.maintain_memories);
  server.registerTool("export_memory_context", {
    description: "Build a bounded markdown context pack for a task.",
    inputSchema: exportContextSchema
  }, handlers.export_memory_context);
}
```

- [ ] **Step 5: Replace stdio entrypoint**

Replace `src/index.ts` with:

```ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MarkdownExporter } from "./markdown-exporter.js";
import { MemoryService } from "./memory-service.js";
import { SQLiteMemoryStore } from "./sqlite-store.js";
import { registerMemoryTools } from "./tools/register-tools.js";

export function serverName(): string {
  return "local-memory-mcp";
}

export function resolveDataHome(env = process.env): string {
  const configured = env.LOCAL_MEMORY_MCP_HOME;
  if (!configured || configured.trim().length === 0) {
    return join(homedir(), ".local-memory-mcp");
  }
  if (configured.startsWith("~/")) {
    return join(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

export function createService(dataHome = resolveDataHome()): MemoryService {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  return new MemoryService(store, exporter);
}

export async function main(): Promise<void> {
  const server = new McpServer({ name: serverName(), version: "0.1.0" });
  registerMemoryTools(server, createService());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Local Memory MCP running on stdio");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error in local-memory-mcp:", error);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Run tool tests**

Run:

```bash
rtk npm test -- test/tool-registration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Build the server**

Run:

```bash
rtk npm run build
```

Expected: PASS and `dist/index.js` exists.

- [ ] **Step 8: Run full tests and typecheck**

Run:

```bash
rtk npm test
rtk npm run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 9: Commit MCP transport**

Run:

```bash
rtk git add src/index.ts src/tools/schemas.ts src/tools/register-tools.ts test/tool-registration.test.ts
rtk git commit -m "feat: expose memory mcp tools"
```

Expected: commit succeeds.

## Task 10: Add README, End-to-End Verification, and Final Review

**Files:**
- Create: `README.md`
- Create: `test/e2e.test.ts`
- Modify: `docs/superpowers/plans/2026-06-13-local-memory-mcp.md` only if the implementation uncovers a command correction while executing this task.

- [ ] **Step 1: Write end-to-end service test**

Create `test/e2e.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createService, resolveDataHome } from "../src/index.js";

describe("local memory mcp e2e", () => {
  it("uses LOCAL_MEMORY_MCP_HOME when provided", () => {
    expect(resolveDataHome({ LOCAL_MEMORY_MCP_HOME: "C:\\memory-home" })).toBe("C:\\memory-home");
  });

  it("creates a service that can remember and export context", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-e2e-"));
    const service = createService(dataHome);
    const remembered = service.remember({
      scope: "global",
      type: "constraint",
      topic: "memory",
      title: "Do not store secrets",
      body: "Reject secret-looking content before memory storage.",
      tags: ["security"],
      source: { kind: "agent", ref: "e2e" },
      importance: 5,
      confidence: 5
    });
    expect(remembered.ok).toBe(true);
    expect(service.exportMemoryContext({ scope: "global", query: "secrets", budget_chars: 1000 })).toContain("Do not store secrets");
  });
});
```

- [ ] **Step 2: Run e2e test**

Run:

```bash
rtk npm test -- test/e2e.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write README**

Create `README.md`:

```md
# local-memory-mcp

Local-first MCP memory server for coding agents. It stores global and project-scoped memory in SQLite, exposes governed direct-write tools over stdio, and exports human-readable markdown indexes.

## Requirements

- Node.js 24 or newer
- npm
- An MCP-compatible client

## Setup

```bash
npm install
npm run build
```

Optional data directory:

```bash
set LOCAL_MEMORY_MCP_HOME=G:\Projects\MetronX\local-memory-mcp\.local-memory-mcp
```

Default data directory:

```text
~/.local-memory-mcp/
```

## Run

```bash
npm start
```

The server uses stdio transport and should normally be launched by an MCP client.

## MCP Tools

- `remember`: write one governed memory entry.
- `search_memories`: search memories with SQLite FTS and filters.
- `get_memory`: read one memory and audit summary.
- `list_memories`: page through memories for maintenance.
- `update_memory`: update mutable fields on active or archived memories.
- `supersede_memory`: replace old memories while preserving history.
- `forget_memory`: soft-delete memory and keep a tombstone.
- `get_memory_budget`: inspect budget usage and cleanup candidates.
- `maintain_memories`: run deterministic maintenance actions.
- `export_memory_context`: build bounded markdown context for an agent task.

## Memory Hygiene

- Keep memories atomic.
- Search before writing to avoid duplicates.
- Use project scope for project facts and debugging lessons.
- Use global scope only for cross-project preferences and stable constraints.
- When `capacity_exceeded` is returned, run maintenance before retrying the write.
- Never store secrets, private keys, tokens, or raw `.env` content.

## Local Storage

SQLite is authoritative:

```text
~/.local-memory-mcp/memory.sqlite
```

Markdown exports are generated for inspection:

```text
~/.local-memory-mcp/exports/
```

Manual edits to generated markdown may be overwritten by `maintain_memories` with `rebuild_markdown_index`.
```

- [ ] **Step 4: Run full verification**

Run:

```bash
rtk npm test
rtk npm run typecheck
rtk npm run build
```

Expected: all three commands PASS.

- [ ] **Step 5: Inspect Git status**

Run:

```bash
rtk git status --short
```

Expected: shows only intended project files before the final commit.

- [ ] **Step 6: Commit docs and e2e**

Run:

```bash
rtk git add README.md test/e2e.test.ts
rtk git commit -m "docs: document local memory mcp usage"
```

Expected: commit succeeds.

- [ ] **Step 7: Final status check**

Run:

```bash
rtk git status --short
```

Expected: clean worktree or only intentionally uncommitted planning/spec documents if they were not committed earlier.

## Self-Review

Spec coverage:

- Global and project scope separation is implemented in Tasks 4, 5, 7, and 9.
- Direct writes with strict validation are implemented in Tasks 3 and 7.
- No model, embedding, or network dependency is preserved by using deterministic validation, SQLite FTS, and Node's built-in SQLite in Tasks 5 through 9.
- Hard capacity budgets and maintenance suggestions are implemented in Task 6 and enforced in Task 7.
- SQLite source of truth is implemented in Task 5.
- Markdown export and context packs are implemented in Task 8.
- Auditability is implemented in Tasks 5 and 7.
- MCP tool surface is implemented in Task 9.
- README and end-to-end verification are implemented in Task 10.

Placeholder scan:

- The plan does not contain red-flag markers from the prohibited list.
- Each task has concrete file paths, test code, implementation code, commands, expected results, and commit commands.

Type consistency:

- `MemoryEntry`, `MemoryBudget`, `ProjectScope`, and `MemoryAuditEvent` are defined in Task 2 and reused consistently.
- `SQLiteMemoryStore` methods used in Task 7 are defined in Task 5.
- `MemoryService` methods exposed in Task 9 are defined in Tasks 7 and 8.
- Tool names match the approved spec: `remember`, `search_memories`, `get_memory`, `list_memories`, `update_memory`, `supersede_memory`, `forget_memory`, `get_memory_budget`, `maintain_memories`, and `export_memory_context`.
