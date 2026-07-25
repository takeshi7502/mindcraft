import test from 'node:test';
import assert from 'node:assert/strict';
import {
    prepareIncomingChat,
    resolveChatGateOptions,
} from '../src/agent/chat_gate.js';

function gate(message, botName = 'waku') {
    return prepareIncomingChat(message, {
        inGame: true,
        botName,
    });
}

test('profile name triggers case-insensitively and is removed', () => {
    const result = gate('WAKU, please fish nearby');
    assert.equal(result.accepted, true);
    assert.equal(result.invoked, true);
    assert.equal(result.message, 'please fish nearby');
});

test('common leading invocation punctuation is accepted', () => {
    const cases = new Map([
        ['waku: build a shelter', 'build a shelter'],
        ['@WaKu, follow me', 'follow me'],
        ['  waku - mine stone', 'mine stone'],
        ['waku! hello', 'hello'],
        ['waku? status', 'status'],
        ['waku(look around)', 'look around'],
    ]);
    for (const [input, expected] of cases) {
        assert.equal(gate(input).message, expected, input);
    }
});

test('untriggered ordinary chat is rejected', () => {
    for (const message of ['hello everyone', 'can someone fish?', 'say hi to waku']) {
        assert.equal(gate(message).accepted, false, message);
    }
});

test('bot name is not matched inside unrelated words', () => {
    for (const message of ['wakuland is nice', 'waku_bot move', 'prewaku hello', "waku's house"]) {
        assert.equal(gate(message).accepted, false, message);
    }
});

test('commands retain their leading exclamation mark after invocation removal', () => {
    const cases = new Map([
        ['waku !stop', '!stop'],
        ['waku: !fishNearby(8, 1)', '!fishNearby(8, 1)'],
        ['waku!stop', '!stop'],
    ]);
    for (const [input, expected] of cases) {
        assert.equal(gate(input).message, expected, input);
    }
});

test('renaming the profile automatically changes the invocation name', () => {
    const options = resolveChatGateOptions({ name: 'Builder' });
    assert.deepEqual(options, { botName: 'Builder' });
    assert.equal(prepareIncomingChat('builder, come here', {
        inGame: true,
        ...options,
    }).message, 'come here');
    assert.equal(prepareIncomingChat('waku, come here', {
        inGame: true,
        ...options,
    }).accepted, false);
});

test('internal and control messages bypass the in-game gate', () => {
    const result = prepareIncomingChat('!stop', {
        inGame: false,
        botName: 'waku',
    });
    assert.equal(result.accepted, true);
    assert.equal(result.message, '!stop');
});

test('a bare invocation with no remaining request is ignored', () => {
    const result = gate('waku,');
    assert.equal(result.invoked, true);
    assert.equal(result.accepted, false);
});
