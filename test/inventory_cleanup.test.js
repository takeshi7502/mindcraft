import test from 'node:test';
import assert from 'node:assert/strict';
import { planInventoryCleanup } from '../src/agent/library/inventory_cleanup.js';

function bot(items, empty = 0) {
  return { inventory: { emptySlotCount: () => empty, items: () => items } };
}

test('planInventoryCleanup does nothing when enough slots are available', () => {
  assert.deepEqual(planInventoryCleanup(bot([], 4)), { needed: false, actions: [] });
});

test('planInventoryCleanup keeps tools armor food torches and buckets', () => {
  const result = planInventoryCleanup(bot([
    { name: 'diamond_pickaxe', count: 1 }, { name: 'diamond_sword', count: 1 },
    { name: 'bread', count: 8 }, { name: 'torch', count: 64 }, { name: 'water_bucket', count: 1 }
  ], 0));
  assert.equal(result.needed, true);
  assert.deepEqual(result.actions, []);
});

test('planInventoryCleanup marks junk and nonessential items', () => {
  const result = planInventoryCleanup(bot([{ name: 'rotten_flesh', count: 12 }, { name: 'poppy', count: 3 }], 0));
  assert.deepEqual(result.actions.map(a => a.itemName), ['rotten_flesh', 'poppy']);
});

test('planInventoryCleanup keeps capped common blocks and removes overflow', () => {
  const result = planInventoryCleanup(bot([{ name: 'dirt', count: 64 }, { name: 'dirt', count: 32 }], 0));
  assert.deepEqual(result.actions, [{ itemName: 'dirt', count: 32, reason: 'overflow' }]);
});
