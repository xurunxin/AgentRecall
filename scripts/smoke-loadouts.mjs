import { SQLiteMemoryStore } from '../src/sqlite-store.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'lt-'));
const store = new SQLiteMemoryStore(join(dir, 'memory.sqlite'), 'read_write_auto_migrate');
console.log('user_version after migrate:', store.getUserVersion());
const li = store.insertLoadout({
  loadout_id: 'loadout_test_1',
  name: 'Test',
  version: 1,
  lifecycle_state: 'draft',
  match_actor_id: null,
  match_client_name: null,
  scope: 'global',
  project_id: null,
  task_mode: null,
  created_by_actor_id: 'user:dev',
  created_at: '2026-08-26T00:00:00.000Z',
  updated_at: '2026-08-26T00:00:00.000Z'
});
console.log('insertLoadout:', li);
const g = store.getLoadout('loadout_test_1');
console.log('getLoadout found:', g !== undefined);
console.log('name:', g?.name);
store.close();
rmSync(dir, { recursive: true });
console.log('done');
