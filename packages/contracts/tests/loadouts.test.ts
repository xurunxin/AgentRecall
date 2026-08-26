// packages/contracts/tests/loadouts.test.ts
//
// v1.2.0-alpha.2 (issue #52): schema tests for the
// loadout + context-assembly contracts.

import { describe, it, expect } from "vitest";

import {
  LoadoutV1Schema,
  LoadoutRuleV1Schema,
  LoadoutBindingV1Schema,
  AssembledChannelV1Schema,
  AssembledContextV1Schema,
  LoadoutResolutionV1Schema,
  LoadoutLifecycleStateSchema,
  LoadoutChannelSchema,
  LoadoutScopeSchema,
  LoadoutTierSchema
} from "../src/loadouts.js";

const baseLoadout = {
  schema_version: "1" as const,
  loadout_id: "loadout-1",
  name: "Test Loadout",
  version: 1,
  lifecycle_state: "active" as const,
  match_actor_id: null,
  match_client_name: null,
  scope: "global" as const,
  project_id: null,
  task_mode: null,
  created_by_actor_id: "user:dev",
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z"
};

const baseRule = {
  schema_version: "1" as const,
  loadout_id: "loadout-1",
  version: 1,
  channel: "bootstrap" as const,
  include_asset_ids: [],
  include_memory_ids: [],
  include_types: [],
  include_tiers: [],
  include_tags: [],
  include_topics: [],
  exclude_asset_ids: [],
  exclude_memory_ids: [],
  exclude_tags: [],
  required_refs: [],
  max_items: 32,
  max_chars: 8000,
  max_tokens: null,
  timeout_ms: 5000,
  ordering_policy: "rule_then_score" as const
};

const baseBinding = {
  schema_version: "1" as const,
  binding_id: "binding-1",
  loadout_id: "loadout-1",
  loadout_version: 1,
  actor_id: "agent:claude-code",
  client_name: "opencode",
  project_id: null,
  task_mode: null,
  priority: 0,
  created_at: "2026-08-26T00:00:00.000Z"
};

const baseChannel = {
  schema_version: "1" as const,
  channel: "bootstrap" as const,
  text: "## Core\n- one",
  selected_ids: ["mem_1"],
  excluded_ids: [],
  required_refs_unavailable: [],
  risk_injection_filtered: 0,
  hash: "sha256:" + "0".repeat(64),
  budget: { used_items: 1, used_chars: 9, max_items: 32, max_chars: 8000 }
};

describe("Loadout contracts (v1.2.0-alpha.2, issue #52)", () => {
  // ───────── happy path ─────────
  it("accepts a minimal loadout (global scope)", () => {
    const parsed = LoadoutV1Schema.parse(baseLoadout);
    expect(parsed.loadout_id).toBe("loadout-1");
    expect(parsed.scope).toBe("global");
    expect(parsed.project_id).toBeNull();
  });

  it("accepts a minimal rule (bootstrap channel, defaults applied)", () => {
    const parsed = LoadoutRuleV1Schema.parse(baseRule);
    expect(parsed.channel).toBe("bootstrap");
    expect(parsed.max_items).toBe(32);
    expect(parsed.max_chars).toBe(8000);
    expect(parsed.ordering_policy).toBe("rule_then_score");
  });

  it("accepts a minimal binding", () => {
    const parsed = LoadoutBindingV1Schema.parse(baseBinding);
    expect(parsed.binding_id).toBe("binding-1");
    expect(parsed.priority).toBe(0);
  });

  it("accepts a fully-populated channel", () => {
    const parsed = AssembledChannelV1Schema.parse(baseChannel);
    expect(parsed.channel).toBe("bootstrap");
    expect(parsed.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("accepts a fully-populated assembled context with all three channels", () => {
    const payload = {
      schema_version: "1" as const,
      loadout_id: "loadout-1",
      loadout_version: 1,
      policy_version: "v1.2.0-alpha.2",
      channels: {
        bootstrap: baseChannel,
        query: { ...baseChannel, channel: "query" as const },
        tool_only: { ...baseChannel, channel: "tool_only" as const }
      },
      bootstrap_hash: "sha256:" + "1".repeat(64),
      explanation: ["resolved via actor_project_task"]
    };
    const parsed = AssembledContextV1Schema.parse(payload);
    expect(parsed.channels.bootstrap?.channel).toBe("bootstrap");
    expect(parsed.channels.query?.channel).toBe("query");
    expect(parsed.channels.tool_only?.channel).toBe("tool_only");
  });

  it("accepts a loadout resolution (with binding)", () => {
    const payload = {
      schema_version: "1" as const,
      loadout: baseLoadout,
      rules: [baseRule],
      binding: baseBinding,
      matched_rule: "actor_project_task" as const
    };
    const parsed = LoadoutResolutionV1Schema.parse(payload);
    expect(parsed.matched_rule).toBe("actor_project_task");
    expect(parsed.binding?.binding_id).toBe("binding-1");
  });

  // ───────── rejection paths ─────────
  it("rejects an unknown lifecycle_state", () => {
    const result = LoadoutLifecycleStateSchema.safeParse("live");
    expect(result.success).toBe(false);
  });

  it("rejects an unknown channel name", () => {
    const result = LoadoutChannelSchema.safeParse("warmup");
    expect(result.success).toBe(false);
  });

  it("rejects scope=project without project_id", () => {
    const result = LoadoutV1Schema.safeParse({
      ...baseLoadout,
      scope: "project",
      project_id: null
    });
    expect(result.success).toBe(false);
  });

  it("rejects scope=global with a project_id", () => {
    const result = LoadoutV1Schema.safeParse({
      ...baseLoadout,
      scope: "global",
      project_id: "proj_x"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a channel hash that is not sha256:hex64", () => {
    const result = AssembledChannelV1Schema.safeParse({
      ...baseChannel,
      hash: "md5:abc"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a loadout resolution with an unknown matched_rule", () => {
    const result = LoadoutResolutionV1Schema.safeParse({
      schema_version: "1",
      loadout: baseLoadout,
      rules: [],
      binding: null,
      matched_rule: "best_guess"
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid tier name", () => {
    const result = LoadoutTierSchema.safeParse("essential");
    expect(result.success).toBe(false);
  });

  it("rejects an unknown scope name", () => {
    const result = LoadoutScopeSchema.safeParse("org");
    expect(result.success).toBe(false);
  });
});
