// src/cli/commands/external-refs.ts
//
// v1.2.0-alpha.2 (issue #54): the
// `agent-recall external-refs ...` subcommand. Three
// verbs:
//
//   list   [--provider-kind <k>] [--allowed-scope <s>] [--project-id <id>]
//   create <flags>             # the most-required flags
//   verify  <asset_id>
//
// The CLI surface is intentionally narrow — the
// `external_reference` is a metadata pointer. There
// is no `update` / `delete` verb in v1.2-alpha.2:
// a re-`create` is the documented migration path
// for changing a provider or URI. (An `appendVersion`
// helper is exposed programmatically; the CLI does
// not surface it yet.)

import { flagBool, flagString } from "../arg-parser.js";
import { jsonOut } from "../format.js";
import type { CliContext, CliResult } from "../index.js";
import { ExternalReferenceService } from "../../external-refs/service.js";
import type {
  ExternalReferenceResourceKind,
  ExternalReferenceRow
} from "../../sqlite-store.js";
import type { ExternalReferenceCapability } from "../../external-refs/service.js";

const HELP = `agent-recall external-refs — manage typed external_reference assets

Usage:
  agent-recall external-refs list
    [--provider-kind <k>] [--allowed-scope <s>] [--project-id <id>] [--json]
  agent-recall external-refs create
    --provider-kind <k>
    --provider-instance-id <id>
    --resource-kind <wiki|code_index|repository_context|document_set|custom>
    --resource-ref <ref>
    --uri <uri>
    --allowed-scope <global|project> [--project-id <id>]
    [--retrieval-contract-version <v>] [--capability <c>]...
    [--sensitivity <normal|private|restricted>]
    [--trust <user_confirmed|agent_observed|inferred>]
    [--refresh-policy-kind <manual|on_session_start|interval>]
    [--refresh-interval-seconds <n>]
    [--json]
  agent-recall external-refs verify <asset_id> [--json]

Subcommands:
  list     List external_reference payloads (newest head first).
  create   Append a new external_reference asset.
  verify   Refresh last_verified_at on the head version of an asset.

Flags:
  --provider-kind <k>           Provider discriminator (e.g. fastcontext,
                                agentic-rag, wiki, custom).
  --provider-instance-id <id>   Stable instance id within the provider.
  --resource-kind <k>           wiki | code_index | repository_context
                                | document_set | custom.
  --resource-ref <ref>          Provider-side resource ref.
  --uri <uri>                   Stable URI the caller can use to reach
                                the resource.
  --retrieval-contract-version <v>
                                Retrieval contract version. Default "1".
  --capability <c>              Repeatable. search | fetch | graph
                                | symbols | citations.
  --allowed-scope <s>           global | project.
  --project-id <id>             Required when --allowed-scope=project.
  --sensitivity <s>             Default "normal".
  --trust <t>                   Default "user_confirmed".
  --refresh-policy-kind <k>     Default "manual".
  --refresh-interval-seconds <n>
                                Required when --refresh-policy-kind=interval.
  --json                        Emit JSON.
`;

const RESOURCE_KINDS: ReadonlyArray<ExternalReferenceResourceKind> = [
  "wiki",
  "code_index",
  "repository_context",
  "document_set",
  "custom"
];

const CAPABILITIES: ReadonlyArray<ExternalReferenceCapability> = [
  "search",
  "fetch",
  "graph",
  "symbols",
  "citations"
];

function service(ctx: CliContext): ExternalReferenceService {
  return new ExternalReferenceService(ctx.store);
}

function parseResourceKind(value: string): ExternalReferenceResourceKind {
  if (RESOURCE_KINDS.includes(value as ExternalReferenceResourceKind)) {
    return value as ExternalReferenceResourceKind;
  }
  throw new Error(
    `[usage_error] invalid --resource-kind '${value}' (expected ${RESOURCE_KINDS.join("|")})`
  );
}

function parseCapability(value: string): ExternalReferenceCapability {
  if (CAPABILITIES.includes(value as ExternalReferenceCapability)) {
    return value as ExternalReferenceCapability;
  }
  throw new Error(
    `[usage_error] invalid --capability '${value}' (expected ${CAPABILITIES.join("|")})`
  );
}

function parseRefreshKind(value: string): "manual" | "on_session_start" | "interval" {
  if (value === "manual" || value === "on_session_start" || value === "interval") {
    return value;
  }
  throw new Error(
    `[usage_error] invalid --refresh-policy-kind '${value}' (expected manual|on_session_start|interval)`
  );
}

function rowToJson(row: ExternalReferenceRow): Record<string, unknown> {
  return {
    asset_id: row.asset_id,
    version: row.version,
    provider_kind: row.provider_kind,
    provider_instance_id: row.provider_instance_id,
    resource_kind: row.resource_kind,
    resource_ref: row.resource_ref,
    uri: row.uri,
    source_version: row.source_version,
    source_digest: row.source_digest,
    retrieval_contract_version: row.retrieval_contract_version,
    capabilities: JSON.parse(row.capabilities_json) as unknown,
    allowed_scope: row.allowed_scope,
    project_id: row.project_id,
    sensitivity: row.sensitivity,
    refresh_policy: JSON.parse(row.refresh_policy_json) as unknown,
    last_verified_at: row.last_verified_at,
    metadata: JSON.parse(row.metadata_json) as unknown
  };
}

export async function externalRefsCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0] ?? "help";
  switch (sub) {
    case "list":
      return externalRefsList(ctx);
    case "create":
      return externalRefsCreate(ctx);
    case "verify":
      return externalRefsVerify(ctx);
    case "help":
    case "--help":
    case "-h":
      return { exitCode: 0, stdout: HELP, stderr: "" };
    default:
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[usage_error] unknown external-refs subcommand: ${sub}\n\n${HELP}`
      };
  }
}

function externalRefsList(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const providerKind = flagString(ctx.args, "provider-kind");
  const allowedScope = flagString(ctx.args, "allowed-scope") as
    | "global" | "project" | undefined;
  const projectId = flagString(ctx.args, "project-id");
  const rows = service(ctx).list({
    ...(providerKind !== undefined ? { provider_kind: providerKind } : {}),
    ...(allowedScope !== undefined ? { allowed_scope: allowedScope } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {})
  });
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ references: rows.map(rowToJson) }), stderr: "" };
  }
  const lines: string[] = [];
  lines.push("ASSET_ID                        PROVIDER           RESOURCE          REF                  LAST_VERIFIED");
  for (const r of rows) {
    const id = r.asset_id.padEnd(32);
    const prov = r.provider_kind.padEnd(18);
    const rk = r.resource_kind.padEnd(17);
    const ref = r.resource_ref.slice(0, 20).padEnd(20);
    const ver = r.last_verified_at ?? "—";
    lines.push(`${id} ${prov} ${rk} ${ref} ${ver}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function externalRefsCreate(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const providerKind = flagString(ctx.args, "provider-kind");
  const providerInstanceId = flagString(ctx.args, "provider-instance-id");
  const resourceKindRaw = flagString(ctx.args, "resource-kind");
  const resourceRef = flagString(ctx.args, "resource-ref");
  const uri = flagString(ctx.args, "uri");
  const allowedScope = flagString(ctx.args, "allowed-scope") as
    | "global" | "project" | undefined;
  const projectId = flagString(ctx.args, "project-id");
  const retrievalContractVersion =
    flagString(ctx.args, "retrieval-contract-version") ?? "1";
  const sensitivity = flagString(ctx.args, "sensitivity") as
    | "normal" | "private" | "restricted" | undefined;
  const trust = flagString(ctx.args, "trust") as
    | "user_confirmed" | "agent_observed" | "inferred" | undefined;
  const refreshPolicyKind = flagString(ctx.args, "refresh-policy-kind");
  const refreshIntervalRaw = flagString(ctx.args, "refresh-interval-seconds");
  const capabilitiesRaw = flagString(ctx.args, "capability");
  if (providerKind === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --provider-kind is required" };
  }
  if (providerInstanceId === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --provider-instance-id is required" };
  }
  if (resourceKindRaw === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --resource-kind is required" };
  }
  if (resourceRef === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --resource-ref is required" };
  }
  if (uri === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --uri is required" };
  }
  if (allowedScope === undefined) {
    return { exitCode: 1, stdout: "", stderr: "[usage_error] --allowed-scope is required" };
  }
  let resourceKind: ExternalReferenceResourceKind;
  let capabilities: ExternalReferenceCapability[] = [];
  let refreshKind: "manual" | "on_session_start" | "interval" = "manual";
  let refreshIntervalSeconds: number | undefined;
  try {
    resourceKind = parseResourceKind(resourceKindRaw);
    if (capabilitiesRaw !== undefined) {
      capabilities = capabilitiesRaw
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .map(parseCapability);
    }
    if (refreshPolicyKind !== undefined) {
      refreshKind = parseRefreshKind(refreshPolicyKind);
    }
    if (refreshIntervalRaw !== undefined) {
      const parsed = Number(refreshIntervalRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "[usage_error] --refresh-interval-seconds must be a positive integer"
        };
      }
      refreshIntervalSeconds = parsed;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
  if (refreshKind === "interval" && refreshIntervalSeconds === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] --refresh-policy-kind=interval requires --refresh-interval-seconds"
    };
  }
  try {
    const result = service(ctx).create({
      provider_kind: providerKind,
      provider_instance_id: providerInstanceId,
      resource_kind: resourceKind,
      resource_ref: resourceRef,
      uri,
      retrieval_contract_version: retrievalContractVersion,
      capabilities,
      allowed_scope: allowedScope,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      sensitivity: sensitivity ?? "normal",
      ...(trust !== undefined ? { trust_level: trust } : {}),
      refresh_policy:
        refreshKind === "interval" && refreshIntervalSeconds !== undefined
          ? { kind: "interval", interval_seconds: refreshIntervalSeconds }
          : { kind: refreshKind },
      owner_actor_id: "user:cli"
    });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout:
        `asset_id=${result.asset_id} version=${result.version} ` +
        `content_hash=${result.content_hash}\n`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}

function externalRefsVerify(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const assetId = ctx.args.positional[1];
  if (assetId === undefined || assetId === "") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] external-refs verify requires <asset_id>"
    };
  }
  const view = service(ctx).show(assetId);
  if (view === undefined) {
    return { exitCode: 1, stdout: "", stderr: `[asset_not_found] no asset with id ${assetId}` };
  }
  try {
    const result = service(ctx).verify(assetId, view.head.version);
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `asset_id=${result.asset_id} last_verified_at=${result.last_verified_at}\n`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}
