import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    clearAttacker,
    createDamageCorrelator,
    getRecentAttacker,
    identifyAttacker,
    isCombatEntity,
    recordHealthLoss,
    recordHurtSource,
    rememberAttacker,
} from '../src/agent/library/combat_targeting.js';
import * as mc from '../src/utils/mcdata.js';

function entity(id, name, type, x = 0) {
    return { id, name, type, isValid: true, position: new Vec3(x, 0, 0) };
}

function createBot(...entities) {
    const self = entity(1, 'bot', 'player');
    const map = Object.fromEntries([self, ...entities].map(value => [value.id, value]));
    return { entity: self, entities: map, retaliationTarget: null };
}

test('a distant skeleton that hurts the bot becomes the retaliation target', () => {
    const skeleton = entity(2, 'skeleton', 'hostile', 30);
    const bot = createBot(skeleton);

    const response = rememberAttacker(bot, skeleton, { now: 100 });

    assert.equal(response.attacker, skeleton);
    assert.equal(response.level, 'lethal');
    assert.equal(getRecentAttacker(bot, { now: 101 }), skeleton);
    assert.equal(bot.entity.position.distanceTo(skeleton.position), 30);
});

test('projectile owner is attributed as attacker instead of the projectile', () => {
    const skeleton = entity(2, 'skeleton', 'hostile', 20);
    const arrow = entity(3, 'arrow', 'object', 2);
    arrow.ownerId = skeleton.id;
    const bot = createBot(skeleton, arrow);

    assert.equal(identifyAttacker(bot, arrow), skeleton);
    assert.equal(isCombatEntity(bot, arrow), false);
});

test('projectile fallback chooses a retaliatable entity near the projectile', () => {
    const skeleton = entity(2, 'skeleton', 'hostile', 21);
    const arrow = entity(3, 'arrow', 'object', 20);
    const bot = createBot(skeleton, arrow);

    assert.equal(identifyAttacker(bot, arrow), skeleton);
});

test('stale, dead, or expired retaliation targets are cleared', () => {
    const skeleton = entity(2, 'skeleton', 'hostile', 20);
    const bot = createBot(skeleton);
    rememberAttacker(bot, skeleton, { now: 100 });

    assert.equal(getRecentAttacker(bot, { now: 20000, ttlMs: 1000 }), null);
    rememberAttacker(bot, skeleton, { now: 20000 });
    delete bot.entities[skeleton.id];
    assert.equal(getRecentAttacker(bot, { now: 20001 }), null);
});

test('clearAttacker only clears the matching remembered entity', () => {
    const skeleton = entity(2, 'skeleton', 'hostile');
    const zombie = entity(3, 'zombie', 'hostile');
    const bot = createBot(skeleton, zombie);
    rememberAttacker(bot, skeleton, { now: 100 });

    clearAttacker(bot, zombie);
    assert.equal(getRecentAttacker(bot, { now: 101 }), skeleton);
    clearAttacker(bot, skeleton);
    assert.equal(getRecentAttacker(bot, { now: 102 }), null);
});

test('vanilla neutral mobs are not proactive hostiles but may be retaliated against', () => {
    for (const name of ['enderman', 'zombified_piglin', 'piglin', 'wolf', 'bee', 'iron_golem']) {
        const mob = entity(2, name, 'mob');
        assert.equal(mc.isNeutralMob(mob), true, name);
        assert.equal(mc.isHostile(mob), false, name);
        assert.equal(mc.canRetaliateAgainst(mob), true, name);
        assert.equal(mc.isIgnoredMob(mob), false, name);
    }
});

test('normal hostile mobs remain proactive threats', () => {
    const skeleton = entity(2, 'skeleton', 'hostile');
    assert.equal(mc.isNeutralMob(skeleton), false);
    assert.equal(mc.isHostile(skeleton), true);
    assert.equal(mc.canRetaliateAgainst(skeleton), true);
});

test('player retaliation ignores first hit, warns on second, and becomes lethal on third', () => {
    const player = { ...entity(2, 'player', 'player'), username: 'alice', uuid: 'alice-uuid' };
    const bot = createBot(player);

    const first = rememberAttacker(bot, player, { now: 1000 });
    assert.equal(first.level, 'none');
    assert.equal(getRecentAttacker(bot, { now: 1001 }), null);

    const second = rememberAttacker(bot, player, { now: 2000 });
    assert.equal(second.level, 'warning_strike');
    assert.equal(bot.playerWarningStrike.entityId, player.id);
    assert.equal(getRecentAttacker(bot, { now: 2001 }), null);

    const third = rememberAttacker(bot, player, { now: 3000 });
    assert.equal(third.level, 'lethal');
    assert.equal(getRecentAttacker(bot, { now: 3001 }), player);
    assert.equal(bot.playerWarningStrike, null);
});

test('isolated player hits outside the window never escalate', () => {
    const player = { ...entity(2, 'player', 'player'), username: 'alice' };
    const bot = createBot(player);
    const policy = { windowMs: 8000 };

    assert.equal(rememberAttacker(bot, player, { now: 1000, playerPolicy: policy }).hitCount, 1);
    assert.equal(rememberAttacker(bot, player, { now: 10000, playerPolicy: policy }).hitCount, 1);
    assert.equal(rememberAttacker(bot, player, { now: 20000, playerPolicy: policy }).level, 'none');
});

test('player hit counters are independent', () => {
    const alice = { ...entity(2, 'player', 'player'), username: 'alice' };
    const bob = { ...entity(3, 'player', 'player'), username: 'bob' };
    const bot = createBot(alice, bob);

    rememberAttacker(bot, alice, { now: 1000 });
    rememberAttacker(bot, bob, { now: 1500 });
    assert.equal(rememberAttacker(bot, alice, { now: 2000 }).level, 'warning_strike');
    assert.equal(rememberAttacker(bot, bob, { now: 2500 }).level, 'warning_strike');
});

test('disabled player retaliation never creates warning or lethal targets', () => {
    const player = { ...entity(2, 'player', 'player'), username: 'alice' };
    const bot = createBot(player);
    for (let hit = 0; hit < 5; hit++) {
        const response = rememberAttacker(bot, player, {
            now: 1000 + hit * 500,
            playerPolicy: { enabled: false },
        });
        assert.equal(response.level, 'none');
    }
    assert.equal(bot.playerWarningStrike, undefined);
    assert.equal(bot.retaliationTarget, null);
});

test('duplicate player damage events are debounced', () => {
    const player = { ...entity(2, 'player', 'player'), username: 'alice' };
    const bot = createBot(player);

    assert.equal(rememberAttacker(bot, player, { now: 1000 }).hitCount, 1);
    const duplicate = rememberAttacker(bot, player, { now: 1050 });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.hitCount, 1);
});

test('hurt source without health loss never confirms retaliation', () => {
    const correlator = createDamageCorrelator();
    const skeleton = entity(2, 'skeleton', 'hostile');
    assert.equal(recordHurtSource(correlator, skeleton, { now: 1000 }), null);
    assert.equal(recordHealthLoss(correlator, 0, { now: 1100 }), null);
});

test('source then health loss confirms exactly one damage instance', () => {
    const correlator = createDamageCorrelator();
    const skeleton = entity(2, 'skeleton', 'hostile');
    assert.equal(recordHurtSource(correlator, skeleton, { now: 1000 }), null);
    const confirmed = recordHealthLoss(correlator, 3, { now: 1100 });
    assert.equal(confirmed.source, skeleton);
    assert.equal(confirmed.damage, 3);
    assert.equal(recordHealthLoss(correlator, 1, { now: 1150 }), null);
});

test('health loss then source also confirms within the correlation window', () => {
    const correlator = createDamageCorrelator();
    const skeleton = entity(2, 'skeleton', 'hostile');
    assert.equal(recordHealthLoss(correlator, 2, { now: 1000 }), null);
    const confirmed = recordHurtSource(correlator, skeleton, { now: 1200 });
    assert.equal(confirmed.source, skeleton);
    assert.equal(confirmed.damage, 2);
});

test('stale source is not paired with a later health loss', () => {
    const correlator = createDamageCorrelator();
    const skeleton = entity(2, 'skeleton', 'hostile');
    recordHurtSource(correlator, skeleton, { now: 1000 });
    assert.equal(recordHealthLoss(correlator, 2, { now: 2000 }), null);
});
