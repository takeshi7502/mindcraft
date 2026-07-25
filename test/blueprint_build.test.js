import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    buildBlueprint,
    findSafeBuildOrigin,
    normalizeBlueprint,
    orderBlueprintPlacements,
    preflightBlueprint,
    validateNamedBlueprintReconnect,
} from '../src/agent/library/blueprint_build.js';
import { loadBlueprint } from '../src/agent/library/blueprint_catalog.js';
import { FailureReason, taskResult } from '../src/agent/library/task_primitives.js';
import {
    getCommand,
    parseCommandMessage,
    executeCommand,
} from '../src/agent/commands/index.js';

function key(position) {
    return `${position.x},${position.y},${position.z}`;
}

function createBuildBot({ inventory = {}, initial = {} } = {}) {
    const blocks = new Map(Object.entries(initial));
    const items = Object.entries(inventory).map(([name, count]) => ({ name, count }));
    const bot = {
        health: 20,
        interrupt_code: false,
        restrict_to_inventory: false,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 0, 0) },
        inventory: {
            items: () => items,
            slots: items,
        },
        blockAt(position) {
            const positionKey = key(position);
            const name = blocks.get(positionKey) ?? (position.y === -1 ? 'stone' : 'air');
            return {
                name,
                position: new Vec3(position.x, position.y, position.z),
                boundingBox: name === 'air' ? 'empty' : 'block',
            };
        },
        findBlocks() { return []; },
        pathfinder: {
            setMovements(movements) { this.movements = movements; },
            async goto(goal) { bot.entity.position = goal.position ?? bot.entity.position; },
            stop() { this.stopped = true; },
        },
    };
    return {
        bot,
        blocks,
        setBlock(x, y, z, name) { blocks.set(`${x},${y},${z}`, name); },
    };
}

const exactDependencies = {
    resolveBlockName: (bot, name) => name,
    blockSatisfied: (name, block) => block?.name === name,
};

test('material preflight reports all shortages before placing anything', async () => {
    const { bot } = createBuildBot({ inventory: { stone: 1 } });
    let placeCalls = 0;
    const blueprint = { name: 'foundation', blocks: [[['stone', 'stone', 'stone']]] };
    const result = await buildBlueprint(bot, blueprint, {
        origin: { x: 0, y: 0, z: 0 },
    }, {
        ...exactDependencies,
        placeBlock: async () => { placeCalls++; },
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.MISSING_MATERIALS);
    assert.deepEqual(result.data.shortages.stone, { required: 3, available: 1, missing: 2 });
    assert.equal(placeCalls, 0);
});

test('dependency ordering is stable by layer and places attachments after structure', () => {
    const blueprint = {
        name: 'layered',
        blocks: [
            [['stone', 'stone']],
            [['torch', 'stone']],
            [['stone', 'stone']],
        ],
    };
    const plan = normalizeBlueprint(blueprint, {
        origin: { x: 0, y: 0, z: 0 },
        resolveBlockName: exactDependencies.resolveBlockName,
    });
    const ordered = orderBlueprintPlacements(plan.entries);

    assert.deepEqual(ordered.map(entry => entry.local.y), [0, 0, 1, 1, 2, 2]);
    const layerOne = ordered.filter(entry => entry.local.y === 1);
    assert.deepEqual(layerOne.map(entry => entry.raw), ['stone', 'torch']);
});

test('successful construction verifies each placement and reports layer progress', async () => {
    const { bot, setBlock } = createBuildBot({ inventory: { stone: 4 } });
    const progress = [];
    const blueprint = {
        name: 'sample_arch',
        blocks: [
            [['stone', 'stone']],
            [['stone', 'stone']],
        ],
    };
    const result = await buildBlueprint(bot, blueprint, {
        origin: { x: 0, y: 0, z: 0 },
        onProgress: update => progress.push(update),
    }, {
        ...exactDependencies,
        placeBlock: async (unusedBot, name, x, y, z) => {
            setBlock(x, y, z, name);
            return true;
        },
    });

    assert.equal(result.success, true);
    assert.equal(result.data.progress.placed, 4);
    assert.equal(result.data.progress.completed, 4);
    assert.deepEqual(progress.filter(update => update.type === 'layer_complete')
        .map(update => update.layer), [0, 1]);
    assert.equal(result.metrics.phases.verify_block.count, 4);
});

test('already-correct blocks are revalidated and skipped without consuming placement calls', async () => {
    const { bot, setBlock } = createBuildBot({
        inventory: { stone: 1 },
        initial: { '0,0,0': 'stone' },
    });
    let placeCalls = 0;
    const result = await buildBlueprint(bot, {
        name: 'repairable',
        blocks: [[['stone', 'stone']]],
    }, { origin: { x: 0, y: 0, z: 0 } }, {
        ...exactDependencies,
        placeBlock: async (unusedBot, name, x, y, z) => {
            placeCalls++;
            setBlock(x, y, z, name);
            return true;
        },
    });

    assert.equal(result.success, true);
    assert.equal(result.data.progress.alreadyCorrect, 1);
    assert.equal(result.data.progress.placed, 1);
    assert.equal(placeCalls, 1);
});

test('placement retries are bounded and recover after one no-progress attempt', async () => {
    const { bot, setBlock } = createBuildBot({ inventory: { stone: 1 } });
    let placeCalls = 0;
    const result = await buildBlueprint(bot, {
        name: 'retry',
        blocks: [[['stone']]],
    }, { origin: { x: 0, y: 0, z: 0 }, retries: 2 }, {
        ...exactDependencies,
        placeBlock: async (unusedBot, name, x, y, z) => {
            placeCalls++;
            if (placeCalls === 2) setBlock(x, y, z, name);
            return placeCalls === 2;
        },
    });

    assert.equal(result.success, true);
    assert.equal(placeCalls, 2);
    assert.equal(result.metrics.phases.place_block.count, 2);
});

test('repeated placement failure stops with structured no-progress reason', async () => {
    const { bot } = createBuildBot({ inventory: { stone: 1 } });
    let placeCalls = 0;
    const result = await buildBlueprint(bot, {
        name: 'failure',
        blocks: [[['stone']]],
    }, { origin: { x: 0, y: 0, z: 0 }, retries: 2 }, {
        ...exactDependencies,
        placeBlock: async () => { placeCalls++; return false; },
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.NO_PROGRESS);
    assert.equal(result.attempts, 2);
    assert.equal(placeCalls, 2);
    assert.equal(result.data.progress.failed, 1);
});

test('cancellation stops an in-flight placement and preserves a checkpoint', async () => {
    const { bot } = createBuildBot({ inventory: { stone: 1 } });
    const cancellation = setTimeout(() => { bot.interrupt_code = true; }, 10);
    const result = await buildBlueprint(bot, {
        name: 'cancel',
        blocks: [[['stone']]],
    }, { origin: { x: 0, y: 0, z: 0 }, retries: 2 }, {
        ...exactDependencies,
        placeBlock: () => new Promise(() => {}),
    });
    clearTimeout(cancellation);

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.CANCELLED);
    assert.deepEqual(result.data.checkpoint.origin, { x: 0, y: 0, z: 0 });
    assert.deepEqual(result.data.checkpoint.completedKeys, []);
});

test('safe-origin selection rejects an obstructed candidate and keeps terrain intact', () => {
    const { bot, setBlock } = createBuildBot();
    bot.findBlocks = () => [new Vec3(0, 0, 0), new Vec3(5, 0, 0)];
    setBlock(0, 0, 0, 'dirt');
    const plan = normalizeBlueprint({
        name: 'site',
        blocks: [[['stone']]],
    }, { resolveBlockName: exactDependencies.resolveBlockName });
    const origin = findSafeBuildOrigin(bot, plan);

    assert.deepEqual({ x: origin.x, y: origin.y, z: origin.z }, { x: 5, y: 0, z: 0 });
    assert.equal(bot.blockAt(new Vec3(0, 0, 0)).name, 'dirt');
});

test('existing non-trivial large-house fixture remains compatible at all orientations', () => {
    const blueprint = loadBlueprint('large_house');
    const plan = normalizeBlueprint(blueprint, {
        origin: { x: 10, y: 64, z: 10 },
        orientation: 1,
        resolveBlockName: (bot, name) => ({
            planks: 'oak_planks',
            log: 'oak_log',
            door: 'oak_door',
            bed: 'white_bed',
        })[name] ?? name,
    });

    assert.equal(blueprint.blocks.length, 14);
    assert.ok(plan.entries.length > 1000);
    assert.deepEqual(plan.size, { x: 14, y: 14, z: 11 });
    assert.equal(orderBlueprintPlacements(plan.entries).length,
        plan.entries.filter(entry => entry.raw !== 'air').length);
});

test('catalog offset is preserved relative to the selected reference origin', () => {
    const plan = normalizeBlueprint({
        name: 'offset_fixture',
        offset: -2,
        blocks: [[['stone']], [['stone']]],
    }, {
        origin: { x: 4, y: 10, z: 6 },
        resolveBlockName: exactDependencies.resolveBlockName,
    });

    assert.deepEqual(plan.entries.map(entry => entry.position.y), [8, 9]);
    assert.equal(plan.sourceOffset, -2);
});

test('legacy construction-task levels are normalized without a new schema', () => {
    const plan = normalizeBlueprint({
        name: 'legacy_levels',
        levels: [
            { level: 0, coordinates: [20, 70, 30], placement: [['stone', 'stone']] },
            { level: 1, coordinates: [20, 71, 30], placement: [['air', 'stone']] },
        ],
    }, { resolveBlockName: exactDependencies.resolveBlockName });

    assert.deepEqual({ x: plan.origin.x, y: plan.origin.y, z: plan.origin.z },
        { x: 20, y: 70, z: 30 });
    assert.equal(plan.entries.length, 4);
    assert.equal(plan.entries.find(entry => entry.source.y === 1 && entry.source.x === 1).position.y, 71);
});

test('preflight reports paired door cells as one material item', () => {
    const { bot } = createBuildBot({ inventory: { oak_door: 1 } });
    const plan = normalizeBlueprint({
        name: 'door_pair',
        blocks: [[['oak_door']], [['oak_door']]],
    }, {
        origin: { x: 0, y: 0, z: 0 },
        resolveBlockName: exactDependencies.resolveBlockName,
    });
    const result = preflightBlueprint(bot, plan, {
        blockSatisfied: exactDependencies.blockSatisfied,
    });

    assert.equal(result.success, true);
    assert.equal(result.data.requirements.oak_door, 1);
});
test('reconnect validation accepts a build checkpoint only while completed blocks still match', () => {
    const { bot, setBlock } = createBuildBot();
    bot.game.gameMode = 'creative';
    const checkpoint = {
        origin: { x: 0, y: 2, z: 0 },
        orientation: 0,
        completedKeys: ['1,0,1'],
    };
    setBlock(1, 0, 1, 'dirt');
    const valid = validateNamedBlueprintReconnect(bot, 'dirt_shelter', {
        orientation: 0,
        checkpoint,
    }, exactDependencies);
    assert.equal(valid.eligible, true);
    assert.equal(valid.reason, 'build_checkpoint_verified');

    setBlock(1, 0, 1, 'air');
    const changed = validateNamedBlueprintReconnect(bot, 'dirt_shelter', {
        orientation: 0,
        checkpoint,
    }, exactDependencies);
    assert.equal(changed.eligible, false);
    assert.equal(changed.reason, 'build_checkpoint_world_mismatch');
    assert.equal(changed.state, 'paused');
});

test('reconnect validation leaves a build waiting when remaining materials are missing', () => {
    const { bot } = createBuildBot();
    const result = validateNamedBlueprintReconnect(bot, 'dirt_shelter', {
        checkpoint: {
            origin: { x: 0, y: 2, z: 0 },
            orientation: 0,
            completedKeys: [],
        },
    }, exactDependencies);

    assert.equal(result.eligible, false);
    assert.equal(result.state, 'waiting_materials');
    assert.equal(result.reason, 'reconnect_missing_materials');
});
test('reconnect validation rejects progress without a build origin', () => {
    const { bot } = createBuildBot();
    const result = validateNamedBlueprintReconnect(bot, 'dirt_shelter', {
        checkpoint: { completedKeys: ['1,0,1'] },
    }, exactDependencies);

    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'invalid_build_checkpoint');
});
test('explicit blueprint and scheduler control commands are registered safely', () => {
    const parsed = parseCommandMessage('!buildBlueprint("large_house", 3)');
    assert.deepEqual(parsed, { commandName: '!buildBlueprint', args: ['large_house', 3] });
    assert.ok(getCommand('!taskStatus'));
    assert.ok(getCommand('!pauseTask'));
    assert.ok(getCommand('!resumeTask'));
    assert.ok(getCommand('!cancelTask'));
    assert.ok(getCommand('!rejoinWorld'));
});

test('scheduler controls use the invoking player as owner across async commands', async () => {
    const calls = [];
    const agent = {
        taskScheduler: {
            async requestPause(taskId, owner) {
                await new Promise(resolve => setTimeout(resolve, taskId === 'slow' ? 10 : 1));
                calls.push({ taskId, owner });
                return { status: taskResult(true, { message: `Paused ${taskId}.` }) };
            },
        },
    };

    await Promise.all([
        executeCommand(agent, '!pauseTask("slow")', { source: 'player-a' }),
        executeCommand(agent, '!pauseTask("fast")', { source: 'player-b' }),
    ]);

    assert.deepEqual(calls.sort((a, b) => a.taskId.localeCompare(b.taskId)), [
        { taskId: 'fast', owner: 'player-b' },
        { taskId: 'slow', owner: 'player-a' },
    ]);
});

test('internal scheduler controls default to system ownership', async () => {
    const calls = [];
    const agent = {
        taskScheduler: {
            requestPause(taskId, owner) {
                calls.push({ taskId, owner });
                return Promise.resolve({
                    status: taskResult(true, { message: `Paused ${taskId}.` }),
                });
            },
        },
    };

    await executeCommand(agent, '!pauseTask("task-2")');

    assert.deepEqual(calls, [{ taskId: 'task-2', owner: 'system' }]);
});