import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskScheduler, TaskState } from '../src/agent/task_scheduler.js';
import { FailureReason, taskResult } from '../src/agent/library/task_primitives.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForState(scheduler, id, state, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (scheduler.getTask(id)?.state === state) return scheduler.getTask(id);
        await delay(5);
    }
    throw new Error(`Task ${id} did not reach ${state}.`);
}

function createHarness() {
    const bot = {
        interrupt_code: false,
        health: 20,
        game: { dimension: 'overworld' },
        players: {},
        pathfinder: { stop() {} },
    };
    const agent = {
        bot,
        requestInterrupt() { this.bot.interrupt_code = true; },
        actions: {
            async runAction(label, actionFn) {
                agent.bot.interrupt_code = false;
                await actionFn();
                return {
                    success: true,
                    message: label,
                    interrupted: agent.bot.interrupt_code,
                    timedout: false,
                };
            },
        },
    };
    return { agent, scheduler: new TaskScheduler(agent) };
}

test('same-process reconnect resumes a long task from its in-memory checkpoint', async () => {
    const { agent, scheduler } = createHarness();
    let runs = 0;
    const runner = async (control, record) => {
        runs++;
        let index = record.checkpoint.index ?? 0;
        while (index < 3) {
            await delay(5);
            const stopped = control.check();
            if (stopped) {
                return taskResult(false, {
                    reason: stopped,
                    complete: false,
                    checkpoint: control.record.checkpoint,
                });
            }
            index++;
            control.checkpoint({ index }, { completed: index, total: 3 });
        }
        return taskResult(true, { checkpoint: { index } });
    };
    const started = scheduler.startLongTask({
        name: 'build:fixture',
        owner: 'alice',
        checkpoint: { index: 0 },
    }, runner, {
        reconnectCheck: record => ({
            eligible: record.checkpoint.index > 0,
            reason: 'checkpoint_verified',
        }),
    });

    await delay(8);
    await scheduler.suspendForReconnect('test_disconnect', {
        dimension: 'overworld',
    });
    await started;
    const checkpoint = scheduler.getTask('task-1').checkpoint.index;
    assert.ok(checkpoint > 0 && checkpoint < 3);

    agent.bot = {
        ...agent.bot,
        interrupt_code: false,
        pathfinder: { stop() {} },
    };
    const recovery = await scheduler.resumeAfterReconnect({ dimension: 'overworld' });
    await waitForState(scheduler, 'task-1', TaskState.COMPLETED);

    assert.equal(recovery.success, true);
    assert.equal(scheduler.getTask('task-1').checkpoint.index, 3);
    assert.equal(runs, 2);
});

test('follow resumes only when its target is present and alive after rejoin', async () => {
    const { agent, scheduler } = createHarness();
    let runs = 0;
    const followRunner = async control => {
        runs++;
        if (runs === 1) {
            while (!control.check()) await delay(3);
            return taskResult(false, {
                reason: FailureReason.INTERRUPTED,
                complete: false,
            });
        }
        return taskResult(true, { complete: false });
    };
    const started = scheduler.replacePersistentTask({
        name: 'follow:alice',
        owner: 'alice',
        target: { player: 'alice' },
    }, followRunner, {
        reconnectCheck: record => {
            const target = agent.bot.players[record.target.player]?.entity;
            return target?.isValid !== false && Boolean(target)
                ? { eligible: true, reason: 'follow_target_verified' }
                : {
                    eligible: false,
                    state: TaskState.PAUSED,
                    reason: 'follow_target_unavailable',
                };
        },
    });

    await delay(7);
    await scheduler.suspendForReconnect();
    await started;
    agent.bot.players = {};
    let recovery = await scheduler.resumeAfterReconnect();
    assert.equal(recovery.tasks[0].reason, 'follow_target_unavailable');
    assert.equal(scheduler.getTask('task-1').state, TaskState.PAUSED);
    assert.equal(runs, 1);

    const secondHarness = createHarness();
    let secondRuns = 0;
    const secondStarted = secondHarness.scheduler.replacePersistentTask({
        name: 'follow:alice',
        owner: 'alice',
        target: { player: 'alice' },
    }, async control => {
        secondRuns++;
        if (secondRuns === 1) {
            while (!control.check()) await delay(3);
            return taskResult(false, { reason: FailureReason.INTERRUPTED, complete: false });
        }
        return taskResult(true, { complete: false });
    }, {
        reconnectCheck: record => ({
            eligible: Boolean(secondHarness.agent.bot.players[record.target.player]?.entity),
            reason: 'follow_target_verified',
        }),
    });
    await delay(7);
    await secondHarness.scheduler.suspendForReconnect();
    await secondStarted;
    secondHarness.agent.bot.players.alice = { entity: { isValid: true } };
    recovery = await secondHarness.scheduler.resumeAfterReconnect();
    await waitForState(secondHarness.scheduler, 'task-1', TaskState.PAUSED);
    assert.equal(recovery.tasks[0].reason, 'follow_target_verified');
    assert.equal(secondRuns, 2);
});

test('world context changes keep a resumable task paused', async () => {
    const { scheduler } = createHarness();
    const started = scheduler.startLongTask({
        name: 'build:dimension-check',
        owner: 'alice',
    }, async control => {
        while (!control.check()) await delay(3);
        return taskResult(false, { reason: FailureReason.INTERRUPTED, complete: false });
    }, {
        reconnectCheck: (record, { previousContext, currentContext }) => ({
            eligible: previousContext.dimension === currentContext.dimension,
            state: TaskState.PAUSED,
            reason: 'world_dimension_changed',
        }),
    });
    await delay(7);
    await scheduler.suspendForReconnect('disconnect', { dimension: 'overworld' });
    await started;
    const recovery = await scheduler.resumeAfterReconnect({ dimension: 'the_nether' });

    assert.equal(scheduler.getTask('task-1').state, TaskState.PAUSED);
    assert.equal(recovery.tasks[0].reason, 'world_dimension_changed');
});
test('short tasks are cancelled on reconnect and emergency stop prevents resurrection', async () => {
    const { scheduler } = createHarness();
    const short = scheduler.runShortTask({
        name: 'deliver:apple',
        owner: 'bob',
    }, async control => {
        while (!control.check()) await delay(3);
        return taskResult(false, { reason: FailureReason.INTERRUPTED });
    });
    await delay(7);
    await scheduler.suspendForReconnect();
    await short;
    assert.equal(scheduler.getTask('task-1').state, TaskState.CANCELLED);

    await scheduler.emergencyStop();
    const recovery = await scheduler.resumeAfterReconnect();
    assert.deepEqual(recovery.tasks, []);
    assert.equal(scheduler.getTask('task-1').state, TaskState.CANCELLED);
});

test('emergency stop clears a suspended long task so reconnect cannot revive it', async () => {
    const { scheduler } = createHarness();
    const started = scheduler.startLongTask({
        name: 'build:cancelled',
        owner: 'alice',
    }, async control => {
        while (!control.check()) await delay(3);
        return taskResult(false, {
            reason: FailureReason.INTERRUPTED,
            complete: false,
        });
    }, {
        reconnectCheck: () => ({ eligible: true, reason: 'should_not_run' }),
    });
    await delay(7);
    await scheduler.suspendForReconnect();
    await started;
    await scheduler.emergencyStop('emergency_stop');
    const recovery = await scheduler.resumeAfterReconnect();

    assert.equal(scheduler.getTask('task-1').state, TaskState.CANCELLED);
    assert.deepEqual(recovery.tasks, []);
});
test('owner cancellation during reconnect prevents the long task from returning', async () => {
    const { scheduler } = createHarness();
    const started = scheduler.startLongTask({
        name: 'build:owner-cancelled',
        owner: 'alice',
    }, async control => {
        while (!control.check()) await delay(3);
        return taskResult(false, { reason: FailureReason.INTERRUPTED, complete: false });
    }, {
        reconnectCheck: () => ({ eligible: true, reason: 'should_not_run' }),
    });
    await delay(7);
    await scheduler.suspendForReconnect();
    await started;
    const cancelled = await scheduler.requestCancellation('task-1', 'alice');
    const recovery = await scheduler.resumeAfterReconnect();

    assert.equal(cancelled.accepted, true);
    assert.equal(scheduler.getTask('task-1').state, TaskState.CANCELLED);
    assert.deepEqual(recovery.tasks, []);
});
test('a long task without a reconnect validator remains safely paused', async () => {
    const { scheduler } = createHarness();
    const started = scheduler.startLongTask({
        name: 'mine:legacy',
        owner: 'alice',
    }, async control => {
        while (!control.check()) await delay(3);
        return taskResult(false, {
            reason: FailureReason.INTERRUPTED,
            complete: false,
        });
    });
    await delay(7);
    await scheduler.suspendForReconnect();
    await started;
    const recovery = await scheduler.resumeAfterReconnect();

    assert.equal(scheduler.getTask('task-1').state, TaskState.PAUSED);
    assert.equal(recovery.tasks[0].reason, 'reconnect_validation_unavailable');
});
test('a true process restart starts with a fresh scheduler and no old task records', async () => {
    const original = createHarness();
    await original.scheduler.startLongTask({
        name: 'build:old',
        owner: 'alice',
    }, () => taskResult(false, {
        reason: FailureReason.MISSING_MATERIALS,
    }));
    assert.equal(original.scheduler.listTasks().length, 1);

    const restarted = createHarness();
    assert.deepEqual(restarted.scheduler.listTasks(), []);
    assert.equal(restarted.scheduler.reconnectContext, null);
});
