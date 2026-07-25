import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { observeProactiveThreat } from '../src/agent/library/combat_observation.js';

function entity(id, name, position) {
    return { id, name, type: 'hostile', position, isValid: true };
}

function botWith(entities, paths) {
    const self = { id: 1, name: 'bot', type: 'player', position: new Vec3(0, 64, 0) };
    return {
        entity: self,
        entities: Object.fromEntries([self, ...entities].map(value => [value.id, value])),
        pathfinder: {
            getPathTo: async (movements, goal) => {
                assert.equal(movements.canDig, false);
                assert.equal(movements.canPlaceOn, false);
                return paths.shift();
            },
        },
    };
}

const options = {
    createMovements: () => ({}),
    createGoal: position => ({ position }),
};

test('proactive threat selector chooses a reachable surface hostile', async () => {
    const zombie = entity(2, 'zombie', new Vec3(3, 64, 0));
    const bot = botWith([zombie], [{ status: 'success', path: [] }]);
    const result = await observeProactiveThreat(bot, options);
    assert.equal(result.entity, zombie);
    assert.equal(result.reason, 'reachable');
});

test('proactive threat selector ignores a hostile deep underground', async () => {
    const zombie = entity(2, 'zombie', new Vec3(2, 54, 0));
    const bot = botWith([zombie], []);
    const result = await observeProactiveThreat(bot, options);
    assert.equal(result.entity, null);
    assert.equal(result.observations[0].reason, 'vertical_separation');
});

test('proactive threat selector ignores paths that require breaking blocks', async () => {
    const zombie = entity(2, 'zombie', new Vec3(3, 64, 0));
    const path = { status: 'success', path: [{ toBreak: [{ x: 1 }], toPlace: [] }] };
    const result = await observeProactiveThreat(botWith([zombie], [path]), options);
    assert.equal(result.entity, null);
    assert.equal(result.observations[0].reason, 'unreachable');
});

test('proactive threat selector skips enclosed nearest mob and selects next reachable mob', async () => {
    const nearest = entity(2, 'zombie', new Vec3(2, 64, 0));
    const second = entity(3, 'skeleton', new Vec3(5, 64, 0));
    const paths = [
        { status: 'noPath', path: [] },
        { status: 'success', path: [] },
    ];
    const result = await observeProactiveThreat(botWith([nearest, second], paths), options);
    assert.equal(result.entity, second);
    assert.equal(result.observations[0].entity, nearest);
});
