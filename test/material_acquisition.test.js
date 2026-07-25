import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireMaterials } from '../src/agent/library/material_acquisition.js';
import { FailureReason } from '../src/agent/library/task_primitives.js';

function createBot(initial = {}) {
    const counts = { ...initial };
    const bot = {
        interrupt_code: false,
        inventory: {
            items: () => Object.entries(counts).filter(([, count]) => count > 0)
                .map(([name, count]) => ({ name, count })),
        },
    };
    return { bot, counts };
}

const noSources = {
    getRecipes: () => null,
    getBlockSources: () => [],
    withdraw: () => false,
    craft: () => false,
    collect: () => false,
};

test('material acquisition performs no actions when inventory already satisfies the request', async () => {
    const { bot } = createBot({ stone: 4 });
    let calls = 0;
    const result = await acquireMaterials(bot, { stone: { missing: 0 } }, {}, {
        ...noSources,
        withdraw: () => { calls++; },
    });

    assert.equal(result.success, true);
    assert.equal(calls, 0);
});

test('material acquisition prefers nearby chest inventory', async () => {
    const { bot, counts } = createBot();
    const actions = [];
    const result = await acquireMaterials(bot, { stone: { missing: 3 } }, {}, {
        ...noSources,
        withdraw: (unusedBot, name, quantity) => {
            actions.push(`withdraw:${name}:${quantity}`);
            counts[name] = (counts[name] ?? 0) + quantity;
        },
        collect: () => { actions.push('collect'); },
    });

    assert.equal(result.success, true);
    assert.deepEqual(actions, ['withdraw:stone:3']);
});

test('material acquisition gathers ingredients then crafts the requested output', async () => {
    const { bot, counts } = createBot();
    const actions = [];
    const result = await acquireMaterials(bot, { oak_planks: { missing: 8 } }, {}, {
        ...noSources,
        getRecipes: name => name === 'oak_planks'
            ? [[{ oak_log: 1 }, { craftedCount: 4 }]]
            : null,
        getBlockSources: name => name === 'oak_log' ? ['oak_log'] : [],
        collect: (unusedBot, source, quantity) => {
            actions.push(`gather:${source}:${quantity}`);
            counts.oak_log = (counts.oak_log ?? 0) + quantity;
        },
        craft: (unusedBot, name, crafts) => {
            actions.push(`craft:${name}:${crafts}`);
            counts.oak_log -= crafts;
            counts.oak_planks = (counts.oak_planks ?? 0) + crafts * 4;
        },
    });

    assert.equal(result.success, true);
    assert.equal(counts.oak_planks, 8);
    assert.deepEqual(actions, ['gather:oak_log:2', 'craft:oak_planks:2']);
});

test('material acquisition passes protected build positions to collection', async () => {
    const { bot, counts } = createBot();
    let excluded;
    const result = await acquireMaterials(bot, { dirt: 1 }, {
        protectedPositions: [{ x: 1, y: 2, z: 3 }],
    }, {
        ...noSources,
        getBlockSources: () => ['dirt'],
        collect: (unusedBot, source, quantity, positions) => {
            excluded = positions;
            counts.dirt = quantity;
        },
    });

    assert.equal(result.success, true);
    assert.deepEqual(excluded, [{ x: 1, y: 2, z: 3 }]);
});

test('material acquisition stops after no progress with precise shortages', async () => {
    const { bot } = createBot();
    const result = await acquireMaterials(bot, { glass: 5 }, { limits: { maxRounds: 3 } }, noSources);

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.MISSING_MATERIALS);
    assert.deepEqual(result.data.remaining, { glass: 5 });
    assert.ok(result.checkpoint.rounds <= 2);
});

test('material acquisition interruption returns a resumable checkpoint', async () => {
    const { bot } = createBot();
    bot.interrupt_code = true;
    const result = await acquireMaterials(bot, { stone: 2 }, {}, noSources);

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.CANCELLED);
    assert.equal(result.complete, false);
    assert.deepEqual(result.data.remaining, { stone: 2 });
});

test('skill success without inventory delta is not treated as acquisition progress', async () => {
    const { bot } = createBot();
    const result = await acquireMaterials(bot, { stone: 1 }, {}, {
        ...noSources,
        withdraw: () => true,
        collect: () => true,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.MISSING_MATERIALS);
    assert.deepEqual(result.data.remaining, { stone: 1 });
});
