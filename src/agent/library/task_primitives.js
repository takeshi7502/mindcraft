export const FailureReason = Object.freeze({
    CANCELLED: 'cancelled',
    TIMED_OUT: 'timed_out',
    INVALID_INPUT: 'invalid_input',
    MISSING_EQUIPMENT: 'missing_equipment',
    UNSAFE: 'unsafe',
    NOT_FOUND: 'not_found',
    UNREACHABLE: 'unreachable',
    ACTION_FAILED: 'action_failed',
    NO_PROGRESS: 'no_progress',
    INTERRUPTED: 'interrupted',
    MISSING_MATERIALS: 'missing_materials',
    BLOCKED: 'blocked',
    BUSY: 'busy',
    OWNERSHIP_LOCKED: 'ownership_locked',
});

function errorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}

export function taskResult(success, options = {}) {
    return {
        success,
        reason: success ? null : (options.reason ?? FailureReason.ACTION_FAILED),
        message: options.message ?? '',
        data: options.data ?? {},
        metrics: options.metrics ?? {},
        attempts: options.attempts ?? 0,
        ...(options.complete === undefined ? {} : { complete: options.complete }),
        ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
        ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
        ...(options.progress === undefined ? {} : { progress: options.progress }),
    };
}

/**
 * Bound an asynchronous operation by both time and the bot interrupt flag.
 * onStop must be synchronous and idempotent; it is called at most once.
 */
export async function withTimeout(operation, timeoutMs, {
    onStop = null,
    isCancelled = null,
    cancellationPollMs = 100,
} = {}) {
    let stopped = false;
    const stop = reason => {
        if (stopped) return;
        stopped = true;
        try {
            onStop?.(reason);
        } catch (error) {
            console.warn('Task cleanup failed:', error);
        }
    };

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        stop(FailureReason.TIMED_OUT);
        const error = new Error('Task deadline expired.');
        error.code = 'TASK_TIMEOUT';
        throw error;
    }

    let timeoutHandle;
    let cancellationHandle;
    const timeout = new Promise((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
            stop(FailureReason.TIMED_OUT);
            const error = new Error(`Task timed out after ${timeoutMs}ms.`);
            error.code = 'TASK_TIMEOUT';
            reject(error);
        }, timeoutMs);
    });
    const cancellation = new Promise((resolve, reject) => {
        if (!isCancelled) return;
        cancellationHandle = setInterval(() => {
            if (!isCancelled()) return;
            stop(FailureReason.CANCELLED);
            const error = new Error('Task was cancelled.');
            error.code = 'TASK_CANCELLED';
            reject(error);
        }, Math.max(25, cancellationPollMs));
    });
    const work = Promise.resolve().then(() =>
        typeof operation === 'function' ? operation() : operation);

    try {
        return await Promise.race([work, timeout, cancellation]);
    } finally {
        clearTimeout(timeoutHandle);
        clearInterval(cancellationHandle);
    }
}

export function createTaskContext(bot, {
    timeoutMs = 60000,
    now = () => Date.now(),
    cancellationPollMs = 100,
} = {}) {
    const startedAt = now();
    const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 60000;
    const deadline = startedAt + boundedTimeout;
    const phases = {};

    return {
        remainingMs: () => Math.max(0, deadline - now()),

        check() {
            if (bot.interrupt_code) {
                return taskResult(false, {
                    reason: FailureReason.CANCELLED,
                    message: 'Task was cancelled.',
                });
            }
            if (now() >= deadline) {
                return taskResult(false, {
                    reason: FailureReason.TIMED_OUT,
                    message: 'Task deadline expired.',
                });
            }
            return null;
        },

        async phase(name, operation, options = {}) {
            if (typeof options === 'number') options = { timeoutMs: options };
            const started = now();
            const record = phases[name] ?? { durationMs: 0, count: 0 };
            phases[name] = record;
            record.count++;

            const stopped = this.check();
            if (stopped) return stopped;

            const phaseTimeout = Math.min(
                options.timeoutMs ?? this.remainingMs(),
                this.remainingMs(),
            );
            try {
                return await withTimeout(operation, phaseTimeout, {
                    onStop: options.onStop,
                    isCancelled: () => Boolean(bot.interrupt_code),
                    cancellationPollMs,
                });
            } catch (error) {
                if (error.code === 'TASK_CANCELLED') {
                    return taskResult(false, {
                        reason: FailureReason.CANCELLED,
                        message: 'Task was cancelled.',
                        data: { phase: name },
                    });
                }
                if (error.code === 'TASK_TIMEOUT') {
                    return taskResult(false, {
                        reason: FailureReason.TIMED_OUT,
                        message: `${name} timed out.`,
                        data: { phase: name },
                    });
                }
                return taskResult(false, {
                    reason: options.errorReason ?? FailureReason.ACTION_FAILED,
                    message: `${name} failed: ${errorMessage(error)}`,
                    data: { phase: name, error: errorMessage(error) },
                });
            } finally {
                record.durationMs += Math.max(0, now() - started);
            }
        },

        finish(success, options = {}) {
            const suppliedMetrics = options.metrics ?? {};
            return taskResult(success, {
                ...options,
                metrics: {
                    ...suppliedMetrics,
                    totalMs: Math.max(0, now() - startedAt),
                    phases: {
                        ...phases,
                        ...(suppliedMetrics.phases ?? {}),
                    },
                },
            });
        },
    };
}

export async function retryBounded(context, operation, {
    attempts = 2,
    retryReasons = [
        FailureReason.TIMED_OUT,
        FailureReason.ACTION_FAILED,
        FailureReason.NO_PROGRESS,
    ],
} = {}) {
    const maxAttempts = Number.isFinite(attempts)
        ? Math.max(1, Math.floor(attempts))
        : 1;
    let result = taskResult(false, {
        reason: FailureReason.NO_PROGRESS,
        message: 'No attempts were made.',
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const stopped = context.check();
        if (stopped) return { ...stopped, attempts: attempt - 1 };

        try {
            result = await operation(attempt);
        } catch (error) {
            result = taskResult(false, {
                reason: FailureReason.ACTION_FAILED,
                message: errorMessage(error),
            });
        }
        result = { ...result, attempts: attempt };
        if (result.success || !retryReasons.includes(result.reason)) return result;
    }
    return result;
}
