import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findReachableAdjacent,
    findSafeAdjacentPositions,
    isFishableWater,
    isSafeStandingPosition,
    observeNearbyBlocks,
} from '../src/agent/library/task_observation.js';

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

function key(position) {
    return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function createWorld(overrides = {}, entityPosition = new FakeVec3(4, 1, 0)) {
    const blocks = new Map(Object.entries(overrides));
    const bot = {
        interrupt_code: false,
        entity: { position: entityPosition },
        blockAt(position) {
            const blockPosition = position.floored ? position.floored() :
                new FakeVec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
            const configured = blocks.get(key(blockPosition));
            const name = configured ?? (blockPosition.y <= 0 ? 'stone' : 'air');
            return {
                name,
                position: blockPosition,
                boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block',
            };
        },
    };
    return { bot, blocks };
}

test('safe standing positions reject hazards and liquid feet', () => {
    const { bot } = createWorld({
        '0,1,0': 'water',
        '1,1,0': 'cactus',
    });
    const target = bot.blockAt(new FakeVec3(0, 1, 0));
    const candidates = findSafeAdjacentPositions(bot, target);

    assert.equal(isSafeStandingPosition(bot, new FakeVec3(1, 1, 0)), false);
    assert.equal(isSafeStandingPosition(bot, new FakeVec3(0, 1, 0)), false);
    assert.equal(candidates.some(position => key(position) === '1,1,0'), false);
    assert.ok(candidates.length > 0);
});

test('fishable water requires an open block above the surface', () => {
    const { bot, blocks } = createWorld({ '0,1,0': 'water' });
    const water = bot.blockAt(new FakeVec3(0, 1, 0));
    assert.equal(isFishableWater(bot, water), true);

    blocks.set('0,2,0', 'stone');
    assert.equal(isFishableWater(bot, water), false);
});

test('nearby observation hard-caps scan radius and result count', () => {
    const { bot } = createWorld({
        '0,1,0': 'water',
        '2,1,0': 'water',
        '3,1,0': 'stone',
    }, new FakeVec3(0, 1, 0));
    let received;
    const positions = [
        new FakeVec3(0, 1, 0),
        new FakeVec3(2, 1, 0),
        new FakeVec3(3, 1, 0),
    ];
    bot.findBlocks = options => {
        received = options;
        return positions.filter(position => options.matching(bot.blockAt(position)));
    };

    const result = observeNearbyBlocks(bot, {
        names: ['water'],
        maxDistance: 999,
        count: 999,
    });

    assert.equal(received.maxDistance, 32);
    assert.equal(received.count, 128);
    assert.deepEqual(result.map(block => block.name), ['water', 'water']);
});

test('reachability skips destructive paths and configures conservative movements', async () => {
    const { bot } = createWorld({ '0,1,0': 'water' });
    const target = bot.blockAt(new FakeVec3(0, 1, 0));
    const movementObjects = [];
    let calls = 0;
    bot.pathfinder = {
        getPathTo(movements) {
            movementObjects.push(movements);
            calls++;
            if (calls === 1) {
                return {
                    status: 'success',
                    path: [{ toBreak: [new FakeVec3(1, 0, 0)], toPlace: [] }],
                };
            }
            return { status: 'success', path: [{ toBreak: [], toPlace: [] }] };
        },
    };

    const result = await findReachableAdjacent(bot, target, {
        createMovements: () => ({}),
        createGoal: position => ({ position }),
    });

    assert.ok(result);
    assert.equal(calls, 2);
    assert.equal(movementObjects[0].canDig, false);
    assert.equal(movementObjects[0].canPlaceOn, false);
    assert.equal(movementObjects[0].allow1by1towers, false);
    assert.equal(movementObjects[0].allowParkour, false);
});
