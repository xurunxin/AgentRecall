-- Test fixture for `SQLiteReader::get_graph` unit tests.
--
-- Schema mirrors the real `memory_entries` table from
-- `src/sqlite-store.ts:805-830` (with the v4+ additive columns added by
-- later migrations). This fixture is self-contained: `CREATE TABLE IF
-- NOT EXISTS` so a stale or empty file still gets a valid schema.
--
-- The reader only opens the file in read-only mode and only queries a
-- subset of columns, but matching the real shape keeps the fixture
-- honest and catches drift early.

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

-- Real production is at v13 (see `reader/schema_version.rs::SCHEMA_VERSION`).
-- The fixture must match, otherwise `SQLiteReader::open` would reject it.
PRAGMA user_version = 13;

-- Seed: 10 active entries. 7 `cache` + 3 `auth` so co_topic edges
-- resolve to C(7,2) + C(3,2) = 21 + 3 = 24.
INSERT INTO memory_entries (
  id, scope, project_id, project_path, type, topic, title, body,
  tags_json, source_json, importance, confidence, status,
  created_at, updated_at, last_accessed_at, last_accessed_by,
  access_count, expires_at, review_after,
  supersedes_json, superseded_by, token_estimate, char_count
) VALUES
  ('11111111-1111-1111-1111-111111111111', 'project', 'p1', '/tmp/p1', 'decision',  'auth',  'Use JWT',                'Use JWT for auth tokens.',                 '[]',                '{"kind":"user"}', 5, 4, 'active', '2026-08-24T10:00:00.000Z', '2026-08-24T10:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 5,  25),
  ('22222222-2222-2222-2222-222222222222', 'project', 'p1', '/tmp/p1', 'procedure', 'auth',  'Refresh token',          'Implement refresh token rotation.',       '[]',                '{"kind":"user"}', 4, 3, 'active', '2026-08-24T11:00:00.000Z', '2026-08-24T11:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 6,  34),
  ('33333333-3333-3333-3333-333333333333', 'project', 'p1', '/tmp/p1', 'lesson',    'auth',  'JWT pitfall',            'Watch for clock skew when validating JWT.','[]',               '{"kind":"user"}', 3, 3, 'active', '2026-08-24T12:00:00.000Z', '2026-08-24T12:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 7,  42),
  ('44444444-4444-4444-4444-444444444444', 'project', 'p1', '/tmp/p1', 'decision',  'cache', 'Use Redis',              'Use Redis as the cache backend.',         '[]',                '{"kind":"user"}', 4, 3, 'active', '2026-08-24T13:00:00.000Z', '2026-08-24T13:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 5,  26),
  ('55555555-5555-5555-5555-555555555555', 'project', 'p1', '/tmp/p1', 'procedure', 'cache', 'Cache invalidation',     'Invalidate on write, not on read.',       '["redis"]',         '{"kind":"user"}', 4, 3, 'active', '2026-08-24T14:00:00.000Z', '2026-08-24T14:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 6,  36),
  ('66666666-6666-6666-6666-666666666666', 'project', 'p1', '/tmp/p1', 'fact',      'cache', 'Redis TTL',              'Default TTL is 5 minutes for sessions.',  '[]',                '{"kind":"user"}', 3, 3, 'active', '2026-08-24T15:00:00.000Z', '2026-08-24T15:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 6,  40),
  ('77777777-7777-7777-7777-777777777777', 'project', 'p1', '/tmp/p1', 'debugging', 'cache', 'Cache stampede',         'Use a mutex to avoid cache stampede.',    '["redis","perf"]',  '{"kind":"user"}', 3, 3, 'active', '2026-08-24T16:00:00.000Z', '2026-08-24T16:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 7,  37),
  ('88888888-8888-8888-8888-888888888888', 'project', 'p1', '/tmp/p1', 'fact',      'cache', 'LRU eviction',           'Redis uses approximate LRU eviction.',    '["redis"]',         '{"kind":"user"}', 3, 3, 'active', '2026-08-24T17:00:00.000Z', '2026-08-24T17:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 5,  35),
  ('99999999-9999-9999-9999-999999999999', 'project', 'p1', '/tmp/p1', 'fact',      'cache', 'Cache warming',          'Warm the cache after deploys.',           '[]',                '{"kind":"user"}', 3, 3, 'active', '2026-08-24T18:00:00.000Z', '2026-08-24T18:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 5,  30),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'project', 'p1', '/tmp/p1', 'fact',      'cache', 'Cache patterns',         'Cache-aside is the default pattern.',     '[]',                '{"kind":"user"}', 3, 3, 'active', '2026-08-24T19:00:00.000Z', '2026-08-24T19:00:00.000Z', NULL, NULL, 0, NULL, NULL, '[]',                NULL, 5,  33);
