import test from 'node:test';
import assert from 'node:assert/strict';
import {
    approachNearbyBlock,
    fishNearby,
    formatTaskResult,
} from '../src/agent/library/deterministic_tasks.js';
import { FailureReason } from '../src/agent/library/task_primitives.js';

class FakeVec3 {
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    offset(dx, dy, dz) {
        return new FakeVec3(this.x + dx, this.y + dy, this.z + dz);
    }

    distanceTo(other) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    }

    floored() {
        return new FakeVec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
    }
}

function samePosition(left, right) {
    return left.x === right.x && left.y === right.y && left.z === right.z;
}

function createTaskBot({ hasRod = true, gainOnCast = true, targetName = 'water' } = {}) {
    const targetPosition = new FakeVec3(0, 1, 0);
    const standingPosition = new FakeVec3(1, 1, 0);
    const items = hasRod ? [{ name: 'fishing_rod', count: 1 }] : [];
    const bot = {
        health: 20,
        interrupt_code: false,
        heldItem: null,
        fishCalls: 0,
        entity: { position: standingPosition },
        inventory: { items: () => items },
        blockAt(position) {
            const blockPosition = position.floored ? position.floored() : position;
            const name = samePosition(blockPosition, targetPosition) ? targetName : 'air';
            return {
                name,
                position: blockPosition,
                boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block',
            };
        },
        pathfinder: {
            stopped: false,
            setMovements(movements) { this.movements = movements; },
            async goto(goal) { bot.entity.position = goal.position; },
            stop() { this.stopped = true; },
        },
        async equip(item) { bot.heldItem = item; },
        async lookAt(position) { bot.lookTarget = position; },
        async fish() {
            bot.fishCalls++;
            if (!gainOnCast) return;
            const cod = items.find(item => item.name === 'cod');
            if (cod) cod.count++;
            else items.push({ name: 'cod', count: 1 });
        },
        activateItem() { bot.reelCalls = (bot.reelCalls ?? 0) + 1; },
    };
    const target = bot.blockAt(targetPosition);
    const dependencies = {
        observeNearbyBlocks: () => [target],
        findReachableAdjacent: async () => ({
            position: standingPosition,
            goal: { position: standingPosition },
            movements: {},
        }),
        isFishableWater: () => targetName === 'water',
        isSafeStandingPosition: () => true,
    };
    return { bot, dependencies, target, standingPosition };
}

test('fishing validates required equipment before observing', async () => {
    const { bot, dependencies } = createTaskBot({ hasRod: false });
    const result = await fishNearby(bot, {}, dependencies);

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.MISSING_EQUIPMENT);
    assert.equal(bot.fishCalls, 0);
});

test('fishing navigates, aims, and verifies success with inventory delta', async () => {
    const { bot, dependencies } = createTaskBot();
    const result = await fishNearby(bot, { attempts: 2 }, dependencies);

    assert.equal(result.success, true);
    assert.deepEqual(result.data.caught, { cod: 1 });
    assert.equal(result.attempts, 1);
    assert.equal(bot.fishCalls, 1);
    assert.ok(bot.lookTarget);
    assert.equal(result.metrics.phases.cast.count, 1);
    assert.match(formatTaskResult(result), /Task success/);
});

test('fishing retries only the configured number of casts when inventory does not change', async () => {
    const { bot, dependencies } = createTaskBot({ gainOnCast: false });
    const result = await fishNearby(bot, { attempts: 2 }, dependencies);

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.NO_PROGRESS);
    assert.equal(result.attempts, 2);
    assert.equal(bot.fishCalls, 2);
    assert.equal(result.metrics.phases.cast.count, 2);
});

test('fishing reports reachable-water failure separately from water discovery', async () => {
    const { bot, dependencies } = createTaskBot();
    dependencies.findReachableAdjacent = async () => null;
    const result = await fishNearby(bot, {}, dependencies);

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.UNREACHABLE);
    assert.equal(bot.fishCalls, 0);
});

test('cancellation reels in an active cast and returns a structured result', async () => {
    const { bot, dependencies } = createTaskBot();
    bot.fish = () => new Promise(() => {});
    const cancellation = setTimeout(() => { bot.interrupt_code = true; }, 10);
    const result = await fishNearby(bot, { attempts: 1 }, dependencies);
    clearTimeout(cancellation);

    assert.equal(result.success, false);
    assert.equal(result.reason, FailureReason.CANCELLED);
    assert.equal(bot.reelCalls, 1);
});
test('generic safe approach reuses bounded observation and reachability', async () => {
    const { bot, dependencies } = createTaskBot({ targetName: 'oak_log' });
    const result = await approachNearbyBlock(bot, {
        names: ['oak_log'],
        searchRadius: 12,
    }, dependencies);

    assert.equal(result.success, true);
    assert.equal(result.data.block, 'oak_log');
    assert.equal(result.metrics.phases.observe.count, 1);
    assert.equal(result.metrics.phases.reachability.count, 1);
    assert.equal(result.metrics.phases.navigate.count, 1);
});
