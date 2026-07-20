// test/helpers/request-context.ts
//
// Stage 10 PR1: shared helper for the release-gate P0
// regression tests. Builds a minimal RequestContext-like
// shape that maps to the actor string the spec requires once
// the actor-propagation PRs (Stage 10 PR3) land. While
// those PRs are not yet implemented, this helper still
// produces a usable, structured actor string that existing
// code path can pass through.
//
// Intentionally tiny: just enough to construct a request
// context object the maintenance / write / read services
// can carry. The full RequestContext type arrives in PR3.

import { randomBytes } from "node:crypto";

export type TestActor =
  | { kind: "agent"; name: string }
  | { kind: "user"; name: string }
  | { kind: "system"; name: string };

export type TestRequestContext = {
  request_id: string;
  actor_id: string;
  client_name?: string;
  client_version?: string;
  session_id?: string;
  tool_call_id?: string;
  project_id?: string;
};

function actorToString(actor: TestActor): string {
  return `${actor.kind}:${actor.name}`;
}

export function makeRequestContext(input: {
  actor: TestActor;
  client_name?: string;
  client_version?: string;
  project_id?: string;
}): TestRequestContext {
  return {
    request_id: `req_${randomBytes(6).toString("hex")}`,
    actor_id: actorToString(input.actor),
    client_name: input.client_name,
    client_version: input.client_version,
    session_id: `sess_${randomBytes(6).toString("hex")}`,
    project_id: input.project_id
  };
}

/** Returns the bare actor string ("agent:claude-code" style) the
 *  tests use to assert the post-PR3 behavior. */
export function actorString(actor: TestActor): string {
  return actorToString(actor);
}
