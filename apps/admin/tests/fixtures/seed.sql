-- Manual-verification fixture for the AgentRecall Admin v0.1 app.
--
-- Schema mirrors the real `memory_entries` table from
-- `src/sqlite-store.ts:805-830` (with the v4+ additive columns added by
-- later migrations; current `SCHEMA_VERSION` is 13 — see
-- `apps/admin/src-tauri/src/reader/schema_version.rs`).
--
-- This file is a plain SQL seed: 56 rows across 6 topics and 3 projects,
-- plus a small global set. It is designed for the PR template's manual
-- "copy-to-data-home" step (no JS generator, no new dependency).
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
-- 20× `auth` (project p1) — exercises topic-cluster co_topic edges.
-- 1 superseded + 1 archived mixed in to exercise status filtering.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000001-0000-4000-8000-000000000001', 'project', 'p1', '/tmp/p1', 'decision',  'auth', 'Use JWT for session tokens',           'Use signed JWTs (RS256) for short-lived session tokens.',                 '["jwt","session"]',       '{"kind":"user"}', 5, 4, 'active',     '2026-08-24T10:00:00.000Z', '2026-08-24T10:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  54),
  ('00000002-0000-4000-8000-000000000002', 'project', 'p1', '/tmp/p1', 'procedure', 'auth', 'Refresh token rotation',                'Rotate refresh tokens on every use; revoke family on reuse.',             '["jwt","refresh"]',       '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T10:01:00.000Z', '2026-08-24T10:01:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  9,  60),
  ('00000003-0000-4000-8000-000000000003', 'project', 'p1', '/tmp/p1', 'lesson',    'auth', 'JWT clock-skew gotcha',                 'Allow ±60s clock skew when validating exp/nbf, no more.',                  '["jwt","pitfall"]',       '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T10:02:00.000Z', '2026-08-24T10:02:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  46),
  ('00000004-0000-4000-8000-000000000004', 'project', 'p1', '/tmp/p1', 'fact',      'auth', 'OAuth2 PKCE required for public clients','Public clients must use PKCE; never allow implicit grant.',              '["oauth2"]',              '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T10:03:00.000Z', '2026-08-24T10:03:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000005-0000-4000-8000-000000000005', 'project', 'p1', '/tmp/p1', 'procedure', 'auth', 'Password hashing with argon2id',         'Hash passwords with argon2id, m=64MB, t=3, p=1.',                         '["crypto","password"]',   '{"kind":"user"}', 5, 4, 'active',     '2026-08-24T10:04:00.000Z', '2026-08-24T10:04:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL, 10,  64),
  ('00000006-0000-4000-8000-000000000006', 'project', 'p1', '/tmp/p1', 'debugging', 'auth', 'Cookie SameSite regression',            'Default to SameSite=Lax; only None when cross-site + Secure required.',    '["cookies"]',             '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T10:05:00.000Z', '2026-08-24T10:05:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000007-0000-4000-8000-000000000007', 'project', 'p1', '/tmp/p1', 'decision',  'auth', 'Use short-lived access tokens',         'Access tokens live 15 min; refresh tokens live 7 days.',                    '["jwt","policy"]',        '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T10:06:00.000Z', '2026-08-24T10:06:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  52),
  ('00000008-0000-4000-8000-000000000008', 'project', 'p1', '/tmp/p1', 'fact',      'auth', 'JWT alg=none is rejected',              'Verify server rejects `alg: none`; only HS256/RS256 allowed.',              '["jwt","security"]',      '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T10:07:00.000Z', '2026-08-24T10:07:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  40),
  ('00000009-0000-4000-8000-000000000009', 'project', 'p1', '/tmp/p1', 'lesson',    'auth', 'CSRF token must rotate per session',    'Single rotating CSRF token > one-shot per request.',                        '["csrf"]',                '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T10:08:00.000Z', '2026-08-24T10:08:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  44),
  ('00000010-0000-4000-8000-000000000010', 'project', 'p1', '/tmp/p1', 'procedure', 'auth', 'OIDC discovery via .well-known',         'Fetch `/.well-known/openid-configuration` then validate issuer.',          '["oidc"]',                '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T10:09:00.000Z', '2026-08-24T10:09:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  50),
  ('00000011-0000-4000-8000-000000000011', 'project', 'p1', '/tmp/p1', 'debugging', 'auth', 'Session fixation via login redirect',   'Regenerate session id on successful login to prevent fixation.',           '["session"]',             '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T10:10:00.000Z', '2026-08-24T10:10:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000012-0000-4000-8000-000000000012', 'project', 'p1', '/tmp/p1', 'fact',      'auth', 'JWKS cache TTL = 10 min',               'Cache JWKS for 10 minutes; refresh on unknown `kid`.',                     '["jwt","jwks"]',          '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T10:11:00.000Z', '2026-08-24T10:11:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000013-0000-4000-8000-000000000013', 'project', 'p1', '/tmp/p1', 'decision',  'auth', 'Rate-limit login endpoint',             '5 failed logins / 15 min / IP; lock account after 50.',                    '["ratelimit"]',           '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T10:12:00.000Z', '2026-08-24T10:12:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  46),
  ('00000014-0000-4000-8000-000000000014', 'project', 'p1', '/tmp/p1', 'procedure', 'auth', 'Logout must invalidate refresh token',  'Server-side: revoke refresh on logout; clear cookies client-side.',        '["session","policy"]',    '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T10:13:00.000Z', '2026-08-24T10:13:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  54),
  ('00000015-0000-4000-8000-000000000015', 'project', 'p1', '/tmp/p1', 'lesson',    'auth', 'Replay attack via stale token',         'Bind JWT to jti and track one-time-use for sensitive ops.',                 '["jwt","replay"]',        '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T10:14:00.000Z', '2026-08-24T10:14:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  40),
  ('00000016-0000-4000-8000-000000000016', 'project', 'p1', '/tmp/p1', 'fact',      'auth', 'mTLS for service-to-service',           'Use mTLS between services; rotate certs every 30 days.',                   '["mtls"]',                '{"kind":"user"}', 4, 3, 'superseded', '2026-08-24T10:15:00.000Z', '2026-08-24T10:15:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', '00000017-0000-4000-8000-000000000017', 7, 48),
  ('00000017-0000-4000-8000-000000000017', 'project', 'p1', '/tmp/p1', 'decision',  'auth', 'SPIFFE for workload identity',           'Use SPIFFE/SPIRE instead of static mTLS certs for dynamic workloads.',     '["spiffe","mtls"]',       '{"kind":"user"}', 5, 4, 'active',     '2026-08-24T10:16:00.000Z', '2026-08-24T10:16:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  9,  60),
  ('00000018-0000-4000-8000-000000000018', 'project', 'p1', '/tmp/p1', 'preference','auth', 'Prefer standard library crypto',        'Reach for stdlib crypto before pulling a third-party SDK.',                '["crypto","policy"]',     '{"kind":"user"}', 3, 3, 'archived',   '2026-08-24T10:17:00.000Z', '2026-08-24T10:17:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000019-0000-4000-8000-000000000019', 'project', 'p1', '/tmp/p1', 'debugging', 'auth', 'Token bucket edge case',                'Bucket refill must use monotonic clock, not wall clock.',                  '["ratelimit","clock"]',   '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T10:18:00.000Z', '2026-08-24T10:18:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000020-0000-4000-8000-000000000020', 'project', 'p1', '/tmp/p1', 'fact',      'auth', 'WebAuthn for high-value operations',    'Require WebAuthn step-up for password reset and wire transfers.',          '["webauthn"]',            '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T10:19:00.000Z', '2026-08-24T10:19:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48);

-- ────────────────────────────────────────────────────────────────────────────
-- 20× `cache` (project p2) — second topic cluster, exercise project filter.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000021-0000-4000-8000-000000000021', 'project', 'p2', '/tmp/p2', 'decision',  'cache', 'Use Redis as the cache backend',        'Redis with AOF every-second and snapshot every 5 min.',                    '["redis"]',               '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T11:00:00.000Z', '2026-08-24T11:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  46),
  ('00000022-0000-4000-8000-000000000022', 'project', 'p2', '/tmp/p2', 'procedure', 'cache', 'Cache-aside pattern',                   'Read-through cache-aside: read cache, miss → DB → set cache.',             '["pattern"]',             '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T11:01:00.000Z', '2026-08-24T11:01:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  52),
  ('00000023-0000-4000-8000-000000000023', 'project', 'p2', '/tmp/p2', 'procedure', 'cache', 'Write-through pattern',                 'For strong consistency: write to DB and cache synchronously.',             '["pattern","consistency"]','{"kind":"user"}', 4, 3, 'active',     '2026-08-24T11:02:00.000Z', '2026-08-24T11:02:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  54),
  ('00000024-0000-4000-8000-000000000024', 'project', 'p2', '/tmp/p2', 'fact',      'cache', 'Default session TTL = 5 min',           'Set TTL on session keys; never rely on manual eviction.',                  '["redis","ttl"]',         '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:03:00.000Z', '2026-08-24T11:03:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  40),
  ('00000025-0000-4000-8000-000000000025', 'project', 'p2', '/tmp/p2', 'debugging', 'cache', 'Cache stampede fix',                    'Use a single-flight mutex per key to avoid stampede on miss.',             '["redis","perf"]',        '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:04:00.000Z', '2026-08-24T11:04:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000026-0000-4000-8000-000000000026', 'project', 'p2', '/tmp/p2', 'fact',      'cache', 'Approximate LRU eviction',              'Redis uses sampled LRU; do not assume precise eviction semantics.',        '["redis","lru"]',         '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:05:00.000Z', '2026-08-24T11:05:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  50),
  ('00000027-0000-4000-8000-000000000027', 'project', 'p2', '/tmp/p2', 'procedure', 'cache', 'Cache warming after deploy',            'Pre-warm top-100 hot keys in a background job after each deploy.',        '["warmup"]',              '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:06:00.000Z', '2026-08-24T11:06:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  54),
  ('00000028-0000-4000-8000-000000000028', 'project', 'p2', '/tmp/p2', 'lesson',    'cache', 'Negative caching prevents DB stampede',  'Cache `null` results for a short TTL to stop repeated DB hits for misses.', '["pattern"]',             '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:07:00.000Z', '2026-08-24T11:07:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000029-0000-4000-8000-000000000029', 'project', 'p2', '/tmp/p2', 'debugging', 'cache', 'Connection pool exhaustion',            'Pool size = (cpu × 2) + spindle count; monitor p99 wait time.',           '["pool","perf"]',         '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T11:08:00.000Z', '2026-08-24T11:08:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  56),
  ('00000030-0000-4000-8000-000000000030', 'project', 'p2', '/tmp/p2', 'decision',  'cache', 'Tag-based invalidation for content',    'Tag every cached object with its `type:id`; invalidate by tag scan.',      '["invalidation"]',        '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T11:09:00.000Z', '2026-08-24T11:09:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  9,  60),
  ('00000031-0000-4000-8000-000000000031', 'project', 'p2', '/tmp/p2', 'fact',      'cache', 'Memcached vs Redis',                    'Memcached = pure cache, multi-threaded, no persistence; Redis = swiss army.', '["comparison"]',        '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:10:00.000Z', '2026-08-24T11:10:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000032-0000-4000-8000-000000000032', 'project', 'p2', '/tmp/p2', 'procedure', 'cache', 'Use lazy expiration in addition to TTL','Combine TTL with periodic sweep to free memory even if TTL is wrong.',    '["redis","ttl"]',         '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:11:00.000Z', '2026-08-24T11:11:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  52),
  ('00000033-0000-4000-8000-000000000033', 'project', 'p2', '/tmp/p2', 'lesson',    'cache', 'Beware of large keys',                  'A single 1MB key can block the Redis event loop for ms; shard it.',        '["redis","perf"]',        '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:12:00.000Z', '2026-08-24T11:12:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  50),
  ('00000034-0000-4000-8000-000000000034', 'project', 'p2', '/tmp/p2', 'debugging', 'cache', 'Hot key skew',                          'Detect hot keys with `redis-cli --hotkeys`; replicate or shard them.',     '["redis","hotkey"]',      '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T11:13:00.000Z', '2026-08-24T11:13:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  56),
  ('00000035-0000-4000-8000-000000000035', 'project', 'p2', '/tmp/p2', 'fact',      'cache', 'Use jitter on TTLs',                    'Add ±10% jitter to TTLs to prevent synchronized expiration at the minute.', '["ttl","pattern"]',     '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:14:00.000Z', '2026-08-24T11:14:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000036-0000-4000-8000-000000000036', 'project', 'p2', '/tmp/p2', 'decision',  'cache', 'Read replica for hot reads',            'Route read-heavy cache misses to a read replica to offload primary.',     '["scaling"]',             '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T11:15:00.000Z', '2026-08-24T11:15:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  56),
  ('00000037-0000-4000-8000-000000000037', 'project', 'p2', '/tmp/p2', 'procedure', 'cache', 'Bulk get vs pipeline',                  'Use MGET / pipelining for many keys; never N round-trips in a loop.',       '["redis","perf"]',        '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T11:16:00.000Z', '2026-08-24T11:16:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  56),
  ('00000038-0000-4000-8000-000000000038', 'project', 'p2', '/tmp/p2', 'lesson',    'cache', 'Serialization cost dominates',          'JSON.stringify on a 10KB value can be 80% of cache-miss latency.',         '["perf","serialization"]','{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:17:00.000Z', '2026-08-24T11:17:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000039-0000-4000-8000-000000000039', 'project', 'p2', '/tmp/p2', 'debugging', 'cache', 'Memory fragmentation in long-running daemons','Restart periodically or use jemalloc when RSS grows unbounded.',      '["perf","memory"]',       '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:18:00.000Z', '2026-08-24T11:18:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000040-0000-4000-8000-000000000040', 'project', 'p2', '/tmp/p2', 'preference','cache', 'Prefer structured logging around cache hits','Log cache hit/miss with key prefix to enable per-prefix dashboards.', '["observability"]',      '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T11:19:00.000Z', '2026-08-24T11:19:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44);

-- ────────────────────────────────────────────────────────────────────────────
-- 6× `logging` (project p3) — small topic cluster to verify edge counts.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000041-0000-4000-8000-000000000041', 'project', 'p3', '/tmp/p3', 'decision',  'logging', 'Use structured JSON logs',             'All services emit JSON logs with `level`, `ts`, `service`, `trace_id`.',   '["structured"]',          '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T12:00:00.000Z', '2026-08-24T12:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  50),
  ('00000042-0000-4000-8000-000000000042', 'project', 'p3', '/tmp/p3', 'procedure', 'logging', 'Log levels = debug/info/warn/error',     'No `trace` or `fatal`; reserve `warn` for recoverable anomalies.',         '["policy"]',              '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T12:01:00.000Z', '2026-08-24T12:01:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000043-0000-4000-8000-000000000043', 'project', 'p3', '/tmp/p3', 'fact',      'logging', 'Never log PII at info level',            'PII is debug-only; sample/aggregate at info to avoid leak.',               '["pii","policy"]',        '{"kind":"user"}', 5, 4, 'active',     '2026-08-24T12:02:00.000Z', '2026-08-24T12:02:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000044-0000-4000-8000-000000000044', 'project', 'p3', '/tmp/p3', 'debugging', 'logging', 'Log line lost in async race',            'Await all writes before resolving the request to avoid lost logs.',        '["async"]',               '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T12:03:00.000Z', '2026-08-24T12:03:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000045-0000-4000-8000-000000000045', 'project', 'p3', '/tmp/p3', 'lesson',    'logging', 'Sampling can hide 1% errors',            'Always log errors at 100%; sample only info and below.',                   '["sampling"]',            '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T12:04:00.000Z', '2026-08-24T12:04:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000046-0000-4000-8000-000000000046', 'project', 'p3', '/tmp/p3', 'decision',  'logging', 'Standard trace_id propagation',          'Propagate `traceparent` (W3C) across every service hop.',                  '["tracing"]',             '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T12:05:00.000Z', '2026-08-24T12:05:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  46);

-- ────────────────────────────────────────────────────────────────────────────
-- 4× `observability` (project p3) — exercise type=fact/decision mix.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000047-0000-4000-8000-000000000047', 'project', 'p3', '/tmp/p3', 'decision',  'observability', 'Use RED metrics per service',         'Per service: Rate, Errors, Duration. Expose as Prometheus.',               '["metrics","red"]',       '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T12:10:00.000Z', '2026-08-24T12:10:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  46),
  ('00000048-0000-4000-8000-000000000048', 'project', 'p3', '/tmp/p3', 'fact',      'observability', 'p99 latency is the right SLO',        'SLOs on p50 hide tail incidents; measure p99 or p99.9.',                   '["slo"]',                 '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T12:11:00.000Z', '2026-08-24T12:11:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000049-0000-4000-8000-000000000049', 'project', 'p3', '/tmp/p3', 'procedure', 'observability', 'Alert on burn rate, not single window','Use 1h + 6h burn rate windows to catch both fast and slow regressions.',   '["alerting"]',            '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T12:12:00.000Z', '2026-08-24T12:12:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  8,  56),
  ('00000050-0000-4000-8000-000000000050', 'project', 'p3', '/tmp/p3', 'lesson',    'observability', 'Dashboards without owners rot',       'Every dashboard must have a `team:` and `oncall:` tag, or it gets deleted.','["policy"]',              '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T12:13:00.000Z', '2026-08-24T12:13:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44);

-- ────────────────────────────────────────────────────────────────────────────
-- 6× `global` (scope=global, no project) — exercise global filter,
-- verify the project_id column tolerates NULL.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO memory_entries (id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count) VALUES
  ('00000051-0000-4000-8000-000000000051', 'global', NULL, NULL, 'preference', 'general', 'Default to TypeScript strict mode',    'All new TS projects use `strict: true` and `noUncheckedIndexedAccess`.',   '["typescript","policy"]', '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T13:00:00.000Z', '2026-08-24T13:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  7,  48),
  ('00000052-0000-4000-8000-000000000052', 'global', NULL, NULL, 'constraint', 'general', 'Never commit secrets to the repo',     'Even in `.env.example`; use placeholders + a comment.',                    '["security"]',            '{"kind":"user"}', 5, 5, 'active',     '2026-08-24T13:01:00.000Z', '2026-08-24T13:01:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000053-0000-4000-8000-000000000053', 'global', NULL, NULL, 'lesson',     'security','Defense in depth beats single wall',     'Layered controls: authn, authz, audit, rate limit, encryption at rest.', '["policy"]',              '{"kind":"user"}', 4, 4, 'active',     '2026-08-24T13:02:00.000Z', '2026-08-24T13:02:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000054-0000-4000-8000-000000000054', 'global', NULL, NULL, 'fact',       'security','Zero-trust assumes breached network',   'Every request is authenticated, authorized, and logged independently.',    '["zerotrust"]',           '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T13:03:00.000Z', '2026-08-24T13:03:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  42),
  ('00000055-0000-4000-8000-000000000055', 'global', NULL, NULL, 'lesson',     'security','Rotate signing keys quarterly',         'Use a key id (`kid`) header so verifiers can track rollover safely.',      '["crypto","policy"]',     '{"kind":"user"}', 4, 3, 'active',     '2026-08-24T13:04:00.000Z', '2026-08-24T13:04:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44),
  ('00000056-0000-4000-8000-000000000056', 'global', NULL, NULL, 'decision',   'performance','Default to incremental builds',        'For any toolchain > 30s cold build, enable incremental / cache mode.',    '["policy"]',              '{"kind":"user"}', 3, 3, 'active',     '2026-08-24T13:05:00.000Z', '2026-08-24T13:05:00.000Z', NULL, NULL, 0, NULL, NULL, '[]', NULL,  6,  44);
