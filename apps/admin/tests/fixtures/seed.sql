-- Manual-verification fixture for the AgentRecall Admin v0.1 app.
--
-- Schema mirrors the real `memory_entries` table from
-- `src/sqlite-store.ts:805-830` (with the v4+ additive columns added by
-- later migrations; current `SCHEMA_VERSION` is 13 — see
-- `apps/admin/src-tauri/src/reader/schema_version.rs`).
--
-- This file is a plain SQL seed: **30 rows** across 7 topics (4 project
-- scopes, 3 global topics), 3 projects. It is designed for the PR
-- template's manual "copy-to-data-home" step (no JS generator, no new
-- dependency) and for the v0.1 graph view, where per-topic node counts
-- were previously 20+20, exploding the co_topic edge set to ~380 and
-- hiding the graph behind a wall of dashed lines. Each topic here has
-- 3–5 nodes (C(5,2) = 10 max edges per topic), so the canvas stays
-- readable while still exercising the topic-cluster, supersede edge,
-- and status filter paths.
--
-- Columns are listed in the same order as the production CREATE TABLE so
-- the file is easy to diff against `src/sqlite-store.ts` if the schema
-- drifts.

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
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'superseded', 'forgotten')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  last_accessed_by TEXT,
  access_count INTEGER NOT NULL,
  expires_at TEXT,
  review_after TEXT,
  supersedes_json TEXT NOT NULL,
  superseded_by TEXT,
  token_estimate INTEGER NOT NULL,
  char_count INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  writer_actor_id TEXT NOT NULL DEFAULT 'agent:test',
  content_hash TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  trust_level TEXT NOT NULL DEFAULT 'agent_observed',
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  valid_from TEXT,
  valid_until TEXT,
  deleted_at TEXT,
  tier TEXT NOT NULL DEFAULT 'working',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

-- Real production is at v13. The reader rejects any other value.
PRAGMA user_version = 13;

-- ────────────────────────────────────────────────────────────────────────────
-- 5× `auth` (project p1) — exercises topic-cluster co_topic edges.
-- Includes 1 superseded (mTLS) and 1 importance-5 entry to cover the
-- supersede edge and the largest circle size.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000001-0000-4000-8000-000000000001', 'project', 'p1', '/tmp/p1', 'decision',  'auth', 'Use JWT for session tokens',           'Use signed JWTs (RS256) for short-lived session tokens.',                 '["jwt","session"]',       '{"kind":"user"}', 5, 4, 'active',     '2026-08-24T10:00:00.000Z', '2026-08-24T10:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  54),
  ('00000002-0000-4000-8000-000000000002', 'project', 'p1', '/tmp/p1', 'procedure', 'auth', 'Refresh token rotation',                'Rotate refresh tokens on every use; revoke family on reuse.',             '["jwt","refresh"]',       '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T10:01:00.000Z', '2026-08-24T10:01:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  9,  60),
  ('00000003-0000-4000-8000-000000000003', 'project', 'p1', '/tmp/p1', 'fact',      'auth', 'OAuth2 PKCE required for public clients','Public clients must use PKCE; never allow implicit grant.',              '["oauth2"]',              '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T10:03:00.000Z', '2026-08-24T10:03:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000004-0000-4000-8000-000000000004', 'project', 'p1', '/tmp/p1', 'procedure', 'auth', 'Password hashing with argon2id',         'Hash passwords with argon2id, m=64MB, t=3, p=1.',                         '["crypto","password"]',   '{"kind":"user"}', 3, 4, 'active',     '2026-08-24T10:04:00.000Z', '2026-08-24T10:04:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL, 10,  64),
  ('00000005-0000-4000-8000-000000000005', 'project', 'p1', '/tmp/p1', 'fact',      'auth', 'mTLS for service-to-service',           'Use mTLS between services; rotate certs every 30 days.',                 '["mtls"]',                '{"kind":"user"}', 3, 3, 'superseded', '2026-08-24T10:15:00.000Z', '2026-08-24T10:15:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', '00000006-0000-4000-8000-000000000006', 7, 48),
  ('00000006-0000-4000-8000-000000000006', 'project', 'p1', '/tmp/p1', 'decision',  'auth', 'SPIFFE for workload identity',           'Use SPIFFE/SPIRE instead of static mTLS certs for dynamic workloads.',   '["spiffe","mtls"]',       '{"kind":"user"}', 3, 4, 'active',     '2026-08-24T10:16:00.000Z', '2026-08-24T10:16:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  9,  60);

-- ────────────────────────────────────────────────────────────────────────────
-- 5× `cache` (project p2) — second topic cluster, exercise project filter.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000007-0000-4000-8000-000000000007', 'project', 'p2', '/tmp/p2', 'decision',  'cache', 'Use Redis as the cache backend',        'Redis with AOF every-second and snapshot every 5 min.',                    '["redis"]',               '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T11:00:00.000Z', '2026-08-24T11:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  46),
  ('00000008-0000-4000-8000-000000000008', 'project', 'p2', '/tmp/p2', 'procedure', 'cache', 'Cache-aside pattern',                   'Read-through cache-aside: read cache, miss → DB → set cache.',             '["pattern"]',             '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T11:01:00.000Z', '2026-08-24T11:01:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  52),
  ('00000009-0000-4000-8000-000000000009', 'project', 'p2', '/tmp/p2', 'fact',      'cache', 'Default session TTL = 5 min',           'Set TTL on session keys; never rely on manual eviction.',                  '["redis","ttl"]',         '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:03:00.000Z', '2026-08-24T11:03:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  40),
  ('00000010-0000-4000-8000-000000000010', 'project', 'p2', '/tmp/p2', 'debugging', 'cache', 'Cache stampede fix',                    'Use a single-flight mutex per key to avoid stampede on miss.',             '["redis","perf"]',        '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:04:00.000Z', '2026-08-24T11:04:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000011-0000-4000-8000-000000000011', 'project', 'p2', '/tmp/p2', 'decision',  'cache', 'Tag-based invalidation for content',    'Tag every cached object with its `type:id`; invalidate by tag scan.',      '["invalidation"]',        '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T11:09:00.000Z', '2026-08-24T11:09:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  9,  60);

-- ────────────────────────────────────────────────────────────────────────────
-- 5× `logging` (project p3) — small topic cluster, variety of types.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000012-0000-4000-8000-000000000012', 'project', 'p3', '/tmp/p3', 'decision',  'logging', 'Use structured JSON logs',             'All services emit JSON logs with `level`, `ts`, `service`, `trace_id`.',   '["structured"]',          '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T12:00:00.000Z', '2026-08-24T12:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  50),
  ('00000013-0000-4000-8000-000000000013', 'project', 'p3', '/tmp/p3', 'fact',      'logging', 'Never log PII at info level',            'PII is debug-only; sample/aggregate at info to avoid leak.',               '["pii","policy"]',        '{"kind":"user"}', 5, 4, 'active',     '2026-08-24T12:02:00.000Z', '2026-08-24T12:02:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000014-0000-4000-8000-000000000014', 'project', 'p3', '/tmp/p3', 'debugging', 'logging', 'Log line lost in async race',            'Await all writes before resolving the request to avoid lost logs.',        '["async"]',               '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T12:03:00.000Z', '2026-08-24T12:03:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000015-0000-4000-8000-000000000015', 'project', 'p3', '/tmp/p3', 'lesson',    'logging', 'Sampling can hide 1% errors',            'Always log errors at 100%; sample only info and below.',                   '["sampling"]',            '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T12:04:00.000Z', '2026-08-24T12:04:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000016-0000-4000-8000-000000000016', 'project', 'p3', '/tmp/p3', 'decision',  'logging', 'Standard trace_id propagation',          'Propagate `traceparent` (W3C) across every service hop.',                  '["tracing"]',             '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T12:05:00.000Z', '2026-08-24T12:05:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  46);

-- ────────────────────────────────────────────────────────────────────────────
-- 5× `observability` (project p3) — type/decision mix; smallest importance
-- entry in the seed (1) to exercise the small circle size.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000017-0000-4000-8000-000000000017', 'project', 'p3', '/tmp/p3', 'decision',  'observability', 'Use RED metrics per service',         'Per service: Rate, Errors, Duration. Expose as Prometheus.',               '["metrics","red"]',       '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T12:10:00.000Z', '2026-08-24T12:10:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  46),
  ('00000018-0000-4000-8000-000000000018', 'project', 'p3', '/tmp/p3', 'fact',      'observability', 'p99 latency is the right SLO',        'SLOs on p50 hide tail incidents; measure p99 or p99.9.',                   '["slo"]',                 '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T12:11:00.000Z', '2026-08-24T12:11:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000019-0000-4000-8000-000000000019', 'project', 'p3', '/tmp/p3', 'procedure', 'observability', 'Alert on burn rate, not single window','Use 1h + 6h burn rate windows to catch both fast and slow regressions.',   '["alerting"]',            '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T12:12:00.000Z', '2026-08-24T12:12:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  56),
  ('00000020-0000-4000-8000-000000000020', 'project', 'p3', '/tmp/p3', 'lesson',    'observability', 'Dashboards without owners rot',       'Every dashboard must have a `team:` and `oncall:` tag, or it gets deleted.','["policy"]',              '{"kind":"user"}', 2, 3, 'active',     '2026-08-24T12:13:00.000Z', '2026-08-24T12:13:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000021-0000-4000-8000-000000000021', 'project', 'p3', '/tmp/p3', 'fact',      'observability', 'SLO error budget halves on incident',  'Pause non-critical deploys while error budget is exhausted.',              '["policy"]',              '{"kind":"user"}', 1, 3, 'active',     '2026-08-24T12:14:00.000Z', '2026-08-24T12:14:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42);

-- ────────────────────────────────────────────────────────────────────────────
-- 4× `security` (scope=global) — exercise the global filter. Includes 1
-- archived entry for the status filter path and 1 importance-2 entry.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000022-0000-4000-8000-000000000022', 'global', NULL, NULL, 'constraint', 'security','Never commit secrets to the repo',     'Even in `.env.example`; use placeholders + a comment.',                    '["security"]',            '{"kind":"user"}', 5, 5, 'active',     '2026-08-24T13:01:00.000Z', '2026-08-24T13:01:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000023-0000-4000-8000-000000000023', 'global', NULL, NULL, 'lesson',     'security','Defense in depth beats single wall',     'Layered controls: authn, authz, audit, rate limit, encryption at rest.',   '["policy"]',              '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T13:02:00.000Z', '2026-08-24T13:02:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000024-0000-4000-8000-000000000024', 'global', NULL, NULL, 'fact',       'security','Zero-trust assumes breached network',   'Every request is authenticated, authorized, and logged independently.',    '["zerotrust"]',           '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T13:03:00.000Z', '2026-08-24T13:03:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000025-0000-4000-8000-000000000025', 'global', NULL, NULL, 'preference', 'security','Prefer passphrase + 2FA for admin',     'Single-factor admin logins are a regression; use 2FA + a passphrase.',     '["policy"]',              '{"kind":"user"}', 2, 3, 'archived',   '2026-08-24T13:04:00.000Z', '2026-08-24T13:04:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44);

-- ────────────────────────────────────────────────────────────────────────────
-- 3× `general` (scope=global) — exercise global filter + project_id NULL.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000026-0000-4000-8000-000000000026', 'global', NULL, NULL, 'preference', 'general', 'Default to TypeScript strict mode',    'All new TS projects use `strict: true` and `noUncheckedIndexedAccess`.',   '["typescript","policy"]', '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T13:10:00.000Z', '2026-08-24T13:10:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000027-0000-4000-8000-000000000027', 'global', NULL, NULL, 'procedure',  'general', 'Prefer small, focused commits',         'One logical change per commit; split unrelated edits into follow-ups.',    '["git"]',                 '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T13:11:00.000Z', '2026-08-24T13:11:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000028-0000-4000-8000-000000000028', 'global', NULL, NULL, 'fact',       'general', 'Use semantic versioning',               'Bump MAJOR on breaking changes, MINOR on features, PATCH on fixes.',       '["policy"]',              '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T13:12:00.000Z', '2026-08-24T13:12:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42);

-- ────────────────────────────────────────────────────────────────────────────
-- 3× `performance` (scope=global) — exercise the second project=NULL path.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000029-0000-4000-8000-000000000029', 'global', NULL, NULL, 'decision',   'performance','Default to incremental builds',        'For any toolchain > 30s cold build, enable incremental / cache mode.',    '["policy"]',              '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T13:20:00.000Z', '2026-08-24T13:20:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000030-0000-4000-8000-000000000030', 'global', NULL, NULL, 'fact',       'performance','p99 budget is the contract',          'Treat p99 latency budget as a user-facing SLO, not an internal target.',   '["slo"]',                 '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T13:21:00.000Z', '2026-08-24T13:21:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000031-0000-4000-8000-000000000031', 'global', NULL, NULL, 'lesson',     'performance','Preallocate buffers in hot paths',    'Avoid growing slices in tight loops; size once, reuse forever.',           '["perf"]',                '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T13:22:00.000Z', '2026-08-24T13:22:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42);
