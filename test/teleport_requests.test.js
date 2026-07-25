import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptTpa, getDirectTpaTarget, isDirectTpaRequest, maybeAutoAcceptTpa, parseTpaRequest, requestTpaToPlayer } from '../src/agent/library/teleport_requests.js';

test('requestTpaToPlayer sends a safe tpa command', () => {
  const sent = [];
  assert.equal(requestTpaToPlayer({ chat: msg => sent.push(msg), players: { '.Phune2304': {} } }, '.Phune2304'), true);
  assert.deepEqual(sent, ['/tpa .Phune2304']);
});

test('requestTpaToPlayer resolves partial online player names', () => {
  const sent = [];
  assert.equal(requestTpaToPlayer({ chat: msg => sent.push(msg), players: { '.Phune2304': {} } }, 'phune'), true);
  assert.deepEqual(sent, ['/tpa .Phune2304']);
});

test('direct TPA target parser chooses sender or named player', () => {
  assert.equal(getDirectTpaTarget('tpa đến tôi', '.BedrockUser'), '.BedrockUser');
  assert.equal(getDirectTpaTarget('tpa đến .Phune2304', 'Caller'), '.Phune2304');
  assert.equal(getDirectTpaTarget('tpa to Phune2304', 'Caller'), 'Phune2304');
});

test('direct Vietnamese TPA requests are detected without the LLM', () => {
  assert.equal(isDirectTpaRequest('tp đến tôi'), true);
  assert.equal(isDirectTpaRequest('tpa đến đây'), true);
  assert.equal(isDirectTpaRequest('tp until evening'), false);
});

test('requestTpaToPlayer rejects invalid player names', () => {
  const sent = [];
  assert.equal(requestTpaToPlayer({ chat: msg => sent.push(msg) }, 'bad;op'), false);
  assert.deepEqual(sent, []);
});

test('acceptTpa sends tpaccept', () => {
  const sent = [];
  acceptTpa({ chat: msg => sent.push(msg) });
  assert.deepEqual(sent, ['/tpaccept']);
});

test('parseTpaRequest detects common request messages and rejects injection', () => {
  assert.equal(parseTpaRequest('Steve has requested to teleport to you. Type /tpaccept').detected, true);
  assert.equal(parseTpaRequest('teleport request from Alex').requester, 'Alex');
  assert.equal(parseTpaRequest('Type /tpaccept to accept the teleport request').detected, true);
  assert.equal(parseTpaRequest('teleport request from bad;op').detected, false);
});

test('maybeAutoAcceptTpa rate limits accept commands', () => {
  const sent = [];
  const bot = { chat: msg => sent.push(msg) };
  assert.equal(maybeAutoAcceptTpa(bot, 'Steve has requested to teleport to you', { now: 1000 }), true);
  assert.equal(maybeAutoAcceptTpa(bot, 'Alex has requested to teleport to you', { now: 2000 }), false);
  assert.equal(maybeAutoAcceptTpa(bot, 'Alex has requested to teleport to you', { now: 5000 }), true);
  assert.deepEqual(sent, ['/tpaccept', '/tpaccept']);
});
