import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskScheduler, TaskState, TaskType } from '../src/agent/task_scheduler.js';
import { FailureReason, taskResult } from '../src/agent/library/task_primitives.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForState(scheduler, id, state, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (scheduler.getTask(id)?.state === state) return scheduler.getTask(id);
        await delay(5);
    }
    throw new Error(`Task ${id} did not reach ${state}; current=${scheduler.getTask(id)?.state}.`);
}

function createScheduler() {
    const bot = { interrupt_code: false };
    const agent = {
        bot,
        requestInterrupt() { bot.interrupt_code = true; },
        actions: {
            async runAction(label, actionFn) {
                bot.interrupt_code = false;
                await actionFn();
                return {
                    success: true,
                    message: label,
                    interrupted: bot.interrupt_code,
                    timedout: false,
                };
            },
        },
    };
    return { scheduler: new TaskScheduler(agent), agent };
}

function checkpointRunner(total, events, label) {
    return async (control, record) => {
        let index = record.checkpoint.index ?? 0;
        while (index < total) {
            await delay(5);
            const stopped = control.check();
            if (stopped) {
                events.push(`${label}:paused:${index}`);
                return taskResult(false, {
                    reason: stopped,
                    message: `${label} interrupted`,
                    complete: false,
                    checkpoint: control.record.checkpoint,
                    progress: control.record.progress,
                });
            }
            index++;
            control.checkpoint({ index }, { completed: index, total });
            events.push(`${label}:${index}`);
        }
        return taskResult(true, {
            message: `${label} complete`,
            checkpoint: { index },
            progress: { completed: index, total },
        });
    };
}

test('short fetch interrupts an owner-locked build and build resumes from checkpoint', async () => {
    const { scheduler } = createScheduler();
    const events = [];
    const buildPromise = scheduler.startLongTask({
        name: 'build:house',
        owner: 'player-a',
        target: { blueprint: 'house' },
        checkpoint: { index: 0 },
        terminalConditions: ['completed', 'bot_died'],
    }, checkpointRunner(4, events, 'build'));

    await delay(8);
    const short = await scheduler.runShortTask({
        name: 'fetch:apple',
        owner: 'player-b',
        target: { item: 'apple', count: 1 },
    }, async () => {
        events.push('fetch');
        return taskResult(true, { message: 'delivered apple' });
    });
    await buildPromise;
    await waitForState(scheduler, 'task-1', TaskState.COMPLETED);

    const build = scheduler.listTasks().find(task => task.name === 'build:house');
    assert.equal(short.accepted, true);
    assert.equal(build.state, TaskState.COMPLETED);
    assert.equal(build.checkpoint.index, 4);
    assert.ok(events.some(event => event.startsWith('build:paused:')));
    assert.ok(events.indexOf('fetch') < events.lastIndexOf('build:4'));
    assert.equal(build.owner, 'player-a');
    assert.equal(build.ownerLocked, true);
});

test('another player long task is rejected while owner-locked long task runs', async () => {
    const { scheduler } = createScheduler();
    const events = [];
    const buildPromise = scheduler.startLongTask({
        name: 'build:a',
        owner: 'player-a',
        checkpoint: { index: 0 },
    }, checkpointRunner(5, events, 'build-a'));

    await delay(7);
    const rejected = await scheduler.startLongTask({
        name: 'mine:b',
        owner: 'player-b',
    }, async () => taskResult(true));

    assert.equal(rejected.accepted, false);
    assert.equal(rejected.status.reason, FailureReason.OWNERSHIP_LOCKED);
    assert.match(rejected.status.message, /player-a/);
    await scheduler.requestCancellation('task-1', 'player-a');
    await buildPromise;
    assert.equal(scheduler.getTask('task-1').state, TaskState.CANCELLED);
});

test('only the long-task owner may pause, resume, or cancel it', async () => {
    const { scheduler } = createScheduler();
    const events = [];
    const running = scheduler.startLongTask({
        name: 'gather:stone',
        owner: 'player-a',
        checkpoint: { index: 0 },
    }, checkpointRunner(20, events, 'gather'));

    await delay(7);
    const denied = await scheduler.requestPause('task-1', 'player-b');
    assert.equal(denied.accepted, false);
    assert.equal(denied.status.reason, FailureReason.OWNERSHIP_LOCKED);

    const paused = await scheduler.requestPause('task-1', 'player-a');
    await running;
    assert.equal(paused.accepted, true);
    assert.equal(scheduler.getTask('task-1').state, TaskState.PAUSED);
    assert.equal(scheduler.getTask('task-1').autoResume, false);
    assert.equal(await scheduler.resumePending(), false);

    const resumed = scheduler.requestResume('task-1', 'player-a');
    await delay(7);
    const cancelDenied = await scheduler.requestCancellation('task-1', 'player-b');
    assert.equal(cancelDenied.accepted, false);
    const cancelled = await scheduler.requestCancellation('task-1', 'player-a');
    await resumed;
    assert.equal(cancelled.accepted, true);
    assert.equal(scheduler.getTask('task-1').state, TaskState.CANCELLED);
});

test('new follow replaces the previous follow regardless of requester', async () => {
    const { scheduler } = createScheduler();
    const events = [];
    const first = scheduler.replacePersistentTask({
        name: 'follow:player-a',
        owner: 'player-a',
        target: { player: 'player-a' },
        terminalConditions: ['target_died', 'bot_died', 'explicit_replacement'],
    }, checkpointRunner(20, events, 'follow-a'));

    await delay(7);
    const second = await scheduler.replacePersistentTask({
        name: 'follow:player-b',
        owner: 'player-b',
        target: { player: 'player-b' },
    }, async () => taskResult(true, { message: 'follow quantum', complete: false }));
    await first;

    assert.equal(second.accepted, true);
    assert.equal(scheduler.getTask('task-1').state, TaskState.CANCELLED);
    assert.equal(scheduler.getTask('task-2').state, TaskState.PAUSED);
    assert.equal(scheduler.getTask('task-2').ownerLocked, false);
});

test('persistent follow yields to a short delivery then reasserts', async () => {
    const { scheduler } = createScheduler();
    const events = [];
    let followRuns = 0;
    const followRunner = async (control) => {
        followRuns++;
        if (followRuns === 1) {
            while (!control.check()) await delay(3);
            return taskResult(false, {
                reason: FailureReason.INTERRUPTED,
                message: 'follow paused',
                complete: false,
            });
        }
        events.push('follow:resumed');
        return taskResult(true, { message: 'follow active', complete: false });
    };
    const follow = scheduler.replacePersistentTask({
        name: 'follow:player-a',
        owner: 'player-a',
        target: { player: 'player-a' },
    }, followRunner);

    await delay(7);
    const delivery = await scheduler.runShortTask({
        name: 'deliver:torch',
        owner: 'player-b',
    }, async () => {
        events.push('deliver');
        return taskResult(true, { message: 'delivered' });
    });
    await follow;

    assert.equal(delivery.accepted, true);
    assert.deepEqual(events, ['deliver', 'follow:resumed']);
    assert.equal(scheduler.getTask('task-1').state, TaskState.PAUSED);
    assert.equal(scheduler.getTask('task-1').target.player, 'player-a');
});

test('a long build suspends persistent follow and follow resumes afterward', async () => {
    const { scheduler } = createScheduler();
    const events = [];
    let followRuns = 0;
    const follow = scheduler.replacePersistentTask({
        name: 'follow:player-a',
        owner: 'player-a',
        target: { player: 'player-a' },
    }, async control => {
        followRuns++;
        if (followRuns === 1) {
            while (!control.check()) await delay(3);
            events.push('follow:paused');
            return taskResult(false, {
                reason: FailureReason.INTERRUPTED,
                message: 'follow paused for build',
                complete: false,
            });
        }
        events.push('follow:resumed');
        return taskResult(true, { message: 'following again', complete: false });
    });

    await delay(7);
    const build = await scheduler.startLongTask({
        name: 'build:shelter',
        owner: 'player-b',
    }, async () => {
        events.push('build');
        return taskResult(true, { message: 'shelter complete' });
    });
    await follow;
    await waitForState(scheduler, 'task-1', TaskState.PAUSED);

    assert.equal(build.accepted, true);
    assert.equal(build.task.state, TaskState.COMPLETED);
    assert.deepEqual(events, ['follow:paused', 'build', 'follow:resumed']);
});

test('task records persist structurally across successive session commands', async () => {
    const { scheduler } = createScheduler();
    let attempts = 0;
    const outcome = await scheduler.startLongTask({
        name: 'build:outpost',
        owner: { name: 'player-a' },
        target: { blueprint: 'outpost' },
        checkpoint: { layer: 2, completed: ['0,0,0'] },
        progress: { completed: 1, total: 10 },
        terminalConditions: ['completed', 'bot_died'],
    }, async (control, record) => {
        attempts++;
        if (attempts === 1) {
            return taskResult(false, {
                reason: FailureReason.MISSING_MATERIALS,
                message: 'need stone',
                checkpoint: record.checkpoint,
                progress: record.progress,
            });
        }
        control.checkpoint({ layer: 3, completed: ['0,0,0', '1,0,0'] }, {
            completed: 2,
            total: 10,
        });
        return taskResult(true, { message: 'continued from checkpoint' });
    });

    assert.equal(outcome.task.state, TaskState.WAITING_MATERIALS);
    const remembered = scheduler.getTask(outcome.task.id);
    assert.equal(remembered.taskClass, TaskType.RESUMABLE);
    assert.equal(remembered.owner.name, 'player-a');
    assert.equal(remembered.checkpoint.layer, 2);
    assert.equal(remembered.resumeOrder > 0, true);

    const resumed = await scheduler.requestResume(outcome.task.id, { name: 'player-a' });
    assert.equal(resumed.accepted, true);
    assert.equal(scheduler.getTask(outcome.task.id).state, TaskState.COMPLETED);
    assert.equal(scheduler.getTask(outcome.task.id).checkpoint.layer, 3);
});

test('emergency movement bypasses ownership and then resumes the long task', async () => {
    const { scheduler } = createScheduler();
    const events = [];
    const buildPromise = scheduler.startLongTask({
        name: 'build:bridge',
        owner: 'player-a',
        checkpoint: { index: 0 },
    }, checkpointRunner(3, events, 'bridge'));

    await delay(7);
    const emergency = await scheduler.runEmergencyTask({
        name: 'emergency:moveAway',
        owner: 'player-b',
    }, async () => {
        events.push('retreat');
        return taskResult(true, { message: 'retreated' });
    });
    await buildPromise;
    await waitForState(scheduler, 'task-1', TaskState.COMPLETED);

    assert.equal(emergency.accepted, true);
    assert.equal(scheduler.listTasks().find(task => task.name === 'build:bridge').state,
        TaskState.COMPLETED);
    assert.ok(events.indexOf('retreat') < events.lastIndexOf('bridge:3'));
});

test('terminal condition ends persistent follow without a live server', async () => {
    const { scheduler } = createScheduler();
    let targetAlive = false;
    const outcome = await scheduler.replacePersistentTask({
        name: 'follow:player-a',
        owner: 'player-a',
        target: { player: 'player-a' },
        terminalConditions: ['target_died'],
    }, async () => {
        assert.fail('runner must not execute after terminal condition');
    }, { terminalCheck: () => !targetAlive });

    assert.equal(outcome.task.state, TaskState.COMPLETED);
    assert.match(outcome.status.message, /Terminal condition/);
});