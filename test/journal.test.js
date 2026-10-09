import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../core/journal.js';

test('records, filters, and exports entries with sequence numbers', () => {
  const j = new Journal();
  j.record({ t: 1, type: 'state', to: 'stable' });
  j.record({ t: 2, type: 'action', kind: 'audio' });
  assert.equal(j.size, 2);
  assert.equal(j.byType('action').length, 1);
  const exported = j.export();
  assert.equal(exported.entries[0].seq, 1);
  assert.equal(exported.entries[1].seq, 2);
});

test('capacity bounds memory, keeping the newest entries', () => {
  const j = new Journal({ capacity: 3 });
  for (let i = 0; i < 10; i += 1) j.record({ t: i, type: 'x' });
  assert.equal(j.size, 3);
  assert.equal(j.entries[0].t, 7);
  assert.equal(j.entries[2].t, 9);
});

test('clear resets entries and sequence', () => {
  const j = new Journal();
  j.record({ t: 1, type: 'x' });
  j.clear();
  j.record({ t: 2, type: 'y' });
  assert.equal(j.size, 1);
  assert.equal(j.entries[0].seq, 1);
});
