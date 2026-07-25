import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTaskContext,
    FailureReason,
    retryBounded,
    taskResult,
    withTimeout,
} from '../src/agent/library/task_primitives.js';

test('task context records phase count, phase latency, and total latency', async () => {
    let now = 10;
    const context = createTaskContext(
        { interrupt_code: false },
        { timeoutMs: 100, now: () => now },
    );
    const value = await context.phase('observe', () => {
        now += 7;
        return 42;
    });
    now += 3;

    assert.equal(value, 42);
    assert.deepEqual(context.finish(true).metrics, {
        totalMs: 10,
        phases: { observe: { durationMs: 7, count: 1 } },
    });
});

test('task context converts cancellation into a structured failure', () => {
    const context = createTaskContext({ interrupt_code: 'stop' });
    assert.equal(context.check().reason, FailureReason.CANCELLED);
});

test('bounded retry stops after configured attempts', async () => {
    const context = createTaskContext({ interrupt_code: false });
    const result = await retryBounded(context, () =>
        taskResult(false, { reason: FailureReason.NO_PROGRESS }), { attempts: 2 });
    assert.equal(result.attempts, 2);
    assert.equal(result.reason, FailureReason.NO_PROGRESS);
});

test('bounded retry does not retry non-retryable failures', async () => {
    const context = createTaskContext({ interrupt_code: false });
    let calls = 0;
    const result = await retryBounded(context, () => {
        calls++;
        return taskResult(false, { reason: FailureReason.MISSING_EQUIPMENT });
    }, { attempts: 3 });

    assert.equal(calls, 1);
    assert.equal(result.attempts, 1);
});

test('withTimeout rejects and runs cleanup once', async () => {
    let cleanups = 0;
    await assert.rejects(
        withTimeout(new Promise(() => {}), 5, { onStop: () => { cleanups++; } }),
        error => error.code === 'TASK_TIMEOUT',
    );
    assert.equal(cleanups, 1);
});

test('withTimeout captures synchronous operation errors without cleanup', async () => {
    let cleaned = false;
    await assert.rejects(
        withTimeout(() => { throw new Error('boom'); }, 50, {
            onStop: () => { cleaned = true; },
        }),
        /boom/,
    );
    assert.equal(cleaned, false);
});
