import { FailureReason, taskResult } from './library/task_primitives.js';

export const TaskType = Object.freeze({
    PERSISTENT: 'persistent',
    RESUMABLE: 'resumable',
    SHORT: 'short',
});

export const TaskState = Object.freeze({
    QUEUED: 'queued',
    RUNNING: 'running',
    PAUSED: 'paused',
    WAITING_MATERIALS: 'waiting_materials',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    FAILED: 'failed',
});

const DEFAULT_PRIORITY = Object.freeze({
    [TaskType.PERSISTENT]: 10,
    [TaskType.RESUMABLE]: 50,
    [TaskType.SHORT]: 100,
});
const TERMINAL_STATES = new Set([
    TaskState.COMPLETED,
    TaskState.CANCELLED,
    TaskState.FAILED,
]);

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function validateType(type) {
    if (!Object.values(TaskType).includes(type))
        throw new Error(`Unknown task type: ${type}`);
    return type;
}

function ownerIdentity(owner) {
    if (owner == null) return null;
    if (typeof owner === 'string' || typeof owner === 'number') return String(owner);
    if (owner.id != null) return String(owner.id);
    if (owner.name != null) return String(owner.name);
    return null;
}

export class TaskScheduler {
    constructor(agent, { now = () => Date.now() } = {}) {
        this.agent = agent;
        this.now = now;
        this.records = new Map();
        this.runtimes = new Map();
        this.queue = [];
        this.interruptionStack = [];
        this.activeTaskId = null;
        this.activePromise = null;
        this.sequence = 0;
        this.resumeSequence = 0;
        this.pauseRequests = new Set();
        this.cancelRequests = new Set();
        this.manualPauseRequests = new Set();
        this.reconnectCandidates = new Map();
        this.reconnectContext = null;
    }

    getTask(id) {
        const record = this.records.get(id);
        return record ? clone(record) : null;
    }

    listTasks({ includeTerminal = true } = {}) {
        return [...this.records.values()]
            .filter(record => includeTerminal || !TERMINAL_STATES.has(record.state))
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
            .map(clone);
    }

    getLongLock() {
        const active = [...this.records.values()]
            .filter(record => record.ownerLocked && !TERMINAL_STATES.has(record.state))
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        return active.length > 0 ? clone(active[0]) : null;
    }

    canAccept({ type, owner = null }) {
        const taskType = validateType(type);
        const lock = this.getLongLock();
        if (!lock || taskType === TaskType.SHORT)
            return { accepted: true, lock: null, supersedesTaskId: null };

        const requester = ownerIdentity(owner);
        const lockOwner = ownerIdentity(lock.owner);
        if (requester !== lockOwner) {
            return {
                accepted: false,
                lock,
                status: taskResult(false, {
                    reason: FailureReason.OWNERSHIP_LOCKED,
                    message: `Busy with ${lock.name}; only ${lockOwner ?? 'its owner'} may replace or cancel it.`,
                    data: { lockTaskId: lock.id, owner: clone(lock.owner), requestedType: taskType },
                }),
            };
        }
        return { accepted: true, lock, supersedesTaskId: lock.id };
    }

    createTask({
        id = null,
        name,
        type,
        owner = null,
        target = null,
        priority = null,
        progress = {},
        checkpoint = {},
        terminalConditions = [],
        parentTaskId = null,
    }, runner, { terminalCheck = null, reconnectCheck = null, timeout = 10 } = {}) {
        if (typeof runner !== 'function') throw new Error('Task runner is required.');
        const taskType = validateType(type);
        const taskId = id ?? `task-${++this.sequence}`;
        if (this.records.has(taskId)) throw new Error(`Task ${taskId} already exists.`);
        const timestamp = this.now();
        const record = {
            id: taskId,
            name: String(name || taskId),
            type: taskType,
            taskClass: taskType,
            owner: clone(owner),
            ownerLocked: taskType === TaskType.RESUMABLE,
            target: clone(target),
            state: TaskState.QUEUED,
            priority: Number.isFinite(priority) ? priority : DEFAULT_PRIORITY[taskType],
            progress: clone(progress) ?? {},
            checkpoint: clone(checkpoint) ?? {},
            terminalConditions: clone(terminalConditions) ?? [],
            parentTaskId,
            interruptedBy: null,
            resumeOrder: ++this.resumeSequence,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastResult: null,
            autoResume: true,
            pauseReason: null,
        };
        this.records.set(taskId, record);
        this.runtimes.set(taskId, { runner, terminalCheck, reconnectCheck, timeout });
        this._enqueue(taskId);
        return this.getTask(taskId);
    }

    updateCheckpoint(id, checkpoint, progress = null) {
        const record = this._requireRecord(id);
        record.checkpoint = clone(checkpoint) ?? {};
        if (progress != null) record.progress = clone(progress) ?? {};
        record.updatedAt = this.now();
        return this.getTask(id);
    }

    async startManagedTask(definition, runner, runtime = {}) {
        const taskType = validateType(definition.type);
        const policy = this.canAccept(definition);
        if (!policy.accepted) return policy;

        if (policy.supersedesTaskId)
            await this.cancelTask(policy.supersedesTaskId, 'superseded_by_owner');
        if (taskType === TaskType.PERSISTENT)
            await this._replacePersistentTasks('superseded_by_follow');

        const parentTaskId = this._selectParentFor(taskType);
        const task = this.createTask({ ...definition, parentTaskId }, runner, runtime);
        if (parentTaskId) await this._pauseForChild(parentTaskId, task.id);

        const result = await this.startTask(task.id);
        if (TERMINAL_STATES.has(result.state) || result.state === TaskState.WAITING_MATERIALS)
            await this.resumePending();
        return {
            accepted: true,
            task: result,
            status: result.lastResult ?? taskResult(true, { message: `Accepted task ${result.id}.` }),
        };
    }

    runShortTask(definition, runner, runtime = {}) {
        return this.startManagedTask({ ...definition, type: TaskType.SHORT }, runner, runtime);
    }

    async runEmergencyTask(definition, runner, runtime = {}) {
        const parentTaskId = this.activeTaskId;
        const task = this.createTask({
            ...definition,
            type: TaskType.SHORT,
            priority: 1000,
            parentTaskId,
        }, runner, runtime);
        if (parentTaskId) await this._pauseForChild(parentTaskId, task.id);
        const result = await this.startTask(task.id);
        await this.resumePending();
        return { accepted: true, task: result, status: result.lastResult };
    }

    startLongTask(definition, runner, runtime = {}) {
        return this.startManagedTask({ ...definition, type: TaskType.RESUMABLE }, runner, runtime);
    }

    replacePersistentTask(definition, runner, runtime = {}) {
        return this.startManagedTask({ ...definition, type: TaskType.PERSISTENT }, runner, runtime);
    }

    startTask(id) {
        const record = this._requireRecord(id);
        if (TERMINAL_STATES.has(record.state)) return this.getTask(id);
        this._enqueue(id);
        return this._drain(id);
    }

    async resumePending({ wait = false } = {}) {
        if (this.activeTaskId) return false;
        const next = this._takeInterruptedTask() ??
            this._takeNextQueuedTask() ??
            this._takePausedTask();
        if (!next) return false;
        const execution = this._execute(next);
        if (wait) await execution;
        else execution.catch(error => console.error('Scheduled task resume failed:', error));
        return true;
    }

    async requestCancellation(id, requester, reason = 'cancelled_by_user') {
        const authorized = this._authorizeControl(id, requester);
        if (!authorized.accepted) return authorized;
        const task = await this.cancelTask(id, reason);
        await this.resumePending();
        return {
            accepted: true,
            task,
            status: taskResult(true, { message: `Cancelled ${id}.` }),
        };
    }

    async requestPause(id, requester) {
        const authorized = this._authorizeControl(id, requester);
        if (!authorized.accepted) return authorized;
        const record = this._requireRecord(id);
        if (TERMINAL_STATES.has(record.state)) {
            return { accepted: false, task: this.getTask(id), status: taskResult(false, {
                reason: FailureReason.ACTION_FAILED,
                message: `Task ${id} is already ${record.state}.`,
            }) };
        }
        if (this.activeTaskId === id) {
            this.pauseRequests.add(id);
            this.manualPauseRequests.add(id);
            record.pauseReason = 'owner_pause';
            record.autoResume = false;
            this.agent?.requestInterrupt?.();
            await this.activePromise;
        } else {
            record.state = TaskState.PAUSED;
            record.pauseReason = 'owner_pause';
            record.autoResume = false;
            record.updatedAt = this.now();
            this._removeQueuedOnly(id);
        }
        await this.resumePending();
        return { accepted: true, task: this.getTask(id), status: taskResult(true, {
            message: `Paused ${id}.`,
        }) };
    }

    async requestResume(id, requester) {
        const authorized = this._authorizeControl(id, requester);
        if (!authorized.accepted) return authorized;
        const record = this._requireRecord(id);
        if (![TaskState.PAUSED, TaskState.WAITING_MATERIALS].includes(record.state)) {
            return { accepted: false, task: this.getTask(id), status: taskResult(false, {
                reason: FailureReason.ACTION_FAILED,
                message: `Task ${id} cannot resume from ${record.state}.`,
            }) };
        }
        record.state = TaskState.QUEUED;
        record.autoResume = true;
        record.pauseReason = null;
        record.resumeOrder = ++this.resumeSequence;
        record.updatedAt = this.now();
        const parentTaskId = this._selectParentFor(TaskType.RESUMABLE);
        if (parentTaskId && parentTaskId !== id)
            await this._pauseForChild(parentTaskId, id);
        const task = await this.startTask(id);
        if (TERMINAL_STATES.has(task.state) || task.state === TaskState.WAITING_MATERIALS)
            await this.resumePending();
        return { accepted: true, task, status: task.lastResult };
    }

    async emergencyStop(reason = 'emergency_stop') {
        const tasks = this.listTasks({ includeTerminal: false });
        for (const task of tasks) await this.cancelTask(task.id, reason);
        this.reconnectCandidates.clear();
        this.reconnectContext = null;
        return taskResult(true, { message: `Stopped ${tasks.length} scheduled task(s).` });
    }

    async suspendForReconnect(reason = 'world_reconnect', context = {}) {
        if (this.reconnectContext) {
            return {
                success: true,
                reason: null,
                message: 'Task recovery is already suspended for reconnect.',
                candidates: [...this.reconnectCandidates.keys()],
            };
        }

        this.reconnectContext = clone(context) ?? {};
        for (const record of this.records.values()) {
            if (TERMINAL_STATES.has(record.state)) continue;
            if (record.type === TaskType.SHORT) {
                this.cancelRequests.add(record.id);
                record.state = TaskState.CANCELLED;
                record.lastResult = taskResult(false, {
                    reason: FailureReason.CANCELLED,
                    message: 'Transient task was cancelled by world reconnect.',
                });
                record.updatedAt = this.now();
                this._removeQueued(record.id);
                continue;
            }
            this.reconnectCandidates.set(record.id, {
                state: record.state,
                autoResume: record.autoResume,
                pauseReason: record.pauseReason,
            });
            record.pauseReason = reason;
            if (record.state !== TaskState.WAITING_MATERIALS) {
                record.state = TaskState.PAUSED;
                record.autoResume = false;
            }
            record.updatedAt = this.now();
            this._removeQueuedOnly(record.id);
        }

        if (this.activeTaskId) {
            const activeId = this.activeTaskId;
            if (this.reconnectCandidates.has(activeId))
                this.pauseRequests.add(activeId);
            this.agent?.requestInterrupt?.();
            await Promise.race([
                this.activePromise,
                new Promise(resolve => setTimeout(resolve, 3000)),
            ]);
        }
        this.agent?.bot?.pathfinder?.stop?.();
        return {
            success: true,
            reason: null,
            message: `Suspended ${this.reconnectCandidates.size} recoverable task(s) for reconnect.`,
            candidates: [...this.reconnectCandidates.keys()],
        };
    }

    async resumeAfterReconnect(context = {}) {
        const previousContext = this.reconnectContext;
        if (!previousContext) {
            return {
                success: true,
                reason: null,
                message: 'No suspended reconnect tasks.',
                tasks: [],
            };
        }
        if (this.activeTaskId) {
            return {
                success: false,
                reason: FailureReason.BUSY,
                message: 'The pre-reconnect action has not stopped safely.',
                tasks: [],
            };
        }

        const reports = [];
        const ordered = [...this.reconnectCandidates.entries()]
            .sort(([, left], [, right]) =>
                (left.state === TaskState.RUNNING ? -1 : 0) -
                (right.state === TaskState.RUNNING ? -1 : 0));
        for (const [id, previous] of ordered) {
            const record = this.records.get(id);
            const runtime = this.runtimes.get(id);
            if (!record || !runtime || TERMINAL_STATES.has(record.state)) continue;

            let validation = {
                eligible: false,
                state: TaskState.PAUSED,
                reason: 'reconnect_validation_unavailable',
                message: 'This task has no safe same-process reconnect validator.',
            };
            try {
                if (runtime.reconnectCheck) {
                    validation = await runtime.reconnectCheck(
                        this.getTask(id),
                        { previousContext: clone(previousContext), currentContext: clone(context) },
                    );
                }
            } catch (error) {
                validation = {
                    eligible: false,
                    state: TaskState.FAILED,
                    reason: 'reconnect_validation_error',
                    message: error.message ?? String(error),
                };
            }

            if (validation?.eligible) {
                const shouldResume = previous.autoResume !== false &&
                    previous.state !== TaskState.WAITING_MATERIALS;
                record.state = shouldResume ? TaskState.QUEUED : previous.state;
                record.autoResume = shouldResume;
                record.pauseReason = shouldResume ? null : previous.pauseReason;
                record.resumeOrder = ++this.resumeSequence;
                record.lastResult = taskResult(true, {
                    message: validation.message ?? 'Task validated after reconnect.',
                });
                if (shouldResume) this._enqueue(id);
                reports.push({ id, state: record.state, reason: validation.reason ?? 'restored' });
            } else {
                const state = validation?.state === TaskState.WAITING_MATERIALS
                    ? TaskState.WAITING_MATERIALS
                    : (validation?.state === TaskState.FAILED ? TaskState.FAILED : TaskState.PAUSED);
                record.state = state;
                record.autoResume = false;
                record.pauseReason = validation?.reason ?? 'reconnect_not_safe';
                record.lastResult = taskResult(false, {
                    reason: validation?.failureReason ?? FailureReason.UNSAFE,
                    message: validation?.message ?? 'Task was not safe to resume after reconnect.',
                });
                this._removeQueued(record.id);
                reports.push({ id, state, reason: record.pauseReason });
            }
            record.updatedAt = this.now();
        }

        this.reconnectCandidates.clear();
        this.reconnectContext = null;
        const resumed = reports.filter(report => report.state === TaskState.QUEUED).length;
        if (resumed > 0) await this.resumePending();
        return {
            success: reports.every(report => report.state !== TaskState.FAILED),
            reason: reports.some(report => report.state === TaskState.FAILED)
                ? FailureReason.UNSAFE
                : null,
            message: `Reconnect recovery: ${resumed} resumed, ` +
                `${reports.filter(report => report.state === TaskState.PAUSED).length} paused, ` +
                `${reports.filter(report => report.state === TaskState.WAITING_MATERIALS).length} waiting, ` +
                `${reports.filter(report => report.state === TaskState.FAILED).length} failed.`,
            tasks: reports,
        };
    }

    clearForShutdown(reason = 'process_shutdown') {
        this.terminateWhere(() => true, reason);
        this.records.clear();
        this.runtimes.clear();
        this.queue = [];
        this.interruptionStack = [];
        this.reconnectCandidates.clear();
        this.reconnectContext = null;
    }

    async cancelTask(id, reason = 'cancelled_by_user') {
        const record = this._requireRecord(id);
        if (TERMINAL_STATES.has(record.state)) return this.getTask(id);
        this.cancelRequests.add(id);
        record.lastResult = taskResult(false, {
            reason: FailureReason.CANCELLED,
            message: reason,
        });
        record.updatedAt = this.now();
        if (this.activeTaskId === id) {
            this.agent?.requestInterrupt?.();
            await this.activePromise;
        } else {
            record.state = TaskState.CANCELLED;
            this._removeQueued(id);
            this.cancelRequests.delete(id);
        }
        return this.getTask(id);
    }

    cancelActive(reason = 'cancelled_by_user') {
        if (!this.activeTaskId) return null;
        return this.cancelTask(this.activeTaskId, reason);
    }

    terminateWhere(predicate, reason = 'terminal_condition') {
        for (const record of this.records.values()) {
            if (TERMINAL_STATES.has(record.state) || !predicate(record)) continue;
            this.cancelRequests.add(record.id);
            record.state = TaskState.CANCELLED;
            record.lastResult = taskResult(false, {
                reason: FailureReason.CANCELLED,
                message: reason,
            });
            record.updatedAt = this.now();
            this._removeQueued(record.id);
        }
        if (this.activeTaskId && this.cancelRequests.has(this.activeTaskId))
            this.agent?.requestInterrupt?.();
    }

    describe() {
        const tasks = this.listTasks({ includeTerminal: false });
        if (tasks.length === 0) return 'No active scheduled tasks.';
        return tasks.map(task => {
            const owner = task.owner == null ? 'none' : JSON.stringify(task.owner);
            const target = task.target == null ? '' : ` target=${JSON.stringify(task.target)}`;
            const progress = Object.keys(task.progress ?? {}).length === 0
                ? ''
                : ` progress=${JSON.stringify(task.progress)}`;
            const pause = task.pauseReason ? ` pause=${task.pauseReason}` : '';
            const reason = task.lastResult?.reason ? ` reason=${task.lastResult.reason}` : '';
            return `${task.id}: ${task.name} [${task.taskClass}/${task.state}] ` +
                `owner=${owner}${target}${progress}${pause}${reason}`;
        }).join('\n');
    }

    _authorizeControl(id, requester) {
        const record = this._requireRecord(id);
        if (!record.ownerLocked || ownerIdentity(record.owner) === ownerIdentity(requester))
            return { accepted: true, task: this.getTask(id) };
        return {
            accepted: false,
            task: this.getTask(id),
            status: taskResult(false, {
                reason: FailureReason.OWNERSHIP_LOCKED,
                message: `Only ${ownerIdentity(record.owner) ?? 'the task owner'} may control ${record.name}.`,
                data: { taskId: id, owner: clone(record.owner) },
            }),
        };
    }

    _selectParentFor(taskType) {
        if (this.activeTaskId) {
            const active = this.records.get(this.activeTaskId);
            if (taskType === TaskType.SHORT) return active?.id ?? null;
            if (taskType === TaskType.RESUMABLE && active?.type === TaskType.PERSISTENT)
                return active.id;
        }
        if (taskType === TaskType.SHORT || taskType === TaskType.RESUMABLE) {
            const paused = [...this.records.values()]
                .filter(record => record.type === TaskType.PERSISTENT && record.state === TaskState.PAUSED)
                .sort((a, b) => a.resumeOrder - b.resumeOrder);
            return paused[0]?.id ?? null;
        }
        return null;
    }

    async _pauseForChild(parentId, childId) {
        const parent = this.records.get(parentId);
        if (!parent || TERMINAL_STATES.has(parent.state)) return;
        parent.interruptedBy = childId;
        parent.autoResume = true;
        parent.pauseReason = 'interrupted_by:' + childId;
        parent.resumeOrder = ++this.resumeSequence;
        parent.updatedAt = this.now();
        if (!this.interruptionStack.includes(parentId)) this.interruptionStack.push(parentId);
        if (this.activeTaskId === parentId) {
            this.pauseRequests.add(parentId);
            this.agent?.requestInterrupt?.();
            await this.activePromise;
        } else {
            parent.state = TaskState.PAUSED;
            this._removeQueuedOnly(parentId);
        }
    }

    async _replacePersistentTasks(reason) {
        const tasks = [...this.records.values()]
            .filter(record => record.type === TaskType.PERSISTENT && !TERMINAL_STATES.has(record.state));
        for (const task of tasks) await this.cancelTask(task.id, reason);
    }

    _requireRecord(id) {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown task: ${id}`);
        return record;
    }

    _enqueue(id) {
        const record = this._requireRecord(id);
        if (TERMINAL_STATES.has(record.state) || this.queue.includes(id)) return;
        if (record.state !== TaskState.RUNNING) record.state = TaskState.QUEUED;
        this.queue.push(id);
        this.queue.sort((leftId, rightId) => {
            const left = this.records.get(leftId);
            const right = this.records.get(rightId);
            return right.priority - left.priority || left.resumeOrder - right.resumeOrder;
        });
    }

    _removeQueuedOnly(id) {
        this.queue = this.queue.filter(taskId => taskId !== id);
    }

    _removeQueued(id) {
        this._removeQueuedOnly(id);
        this.interruptionStack = this.interruptionStack.filter(taskId => taskId !== id);
    }

    _takeNextQueuedTask() {
        while (this.queue.length > 0) {
            const id = this.queue.shift();
            const record = this.records.get(id);
            if (record && !TERMINAL_STATES.has(record.state)) return id;
        }
        return null;
    }

    _takeInterruptedTask() {
        while (this.interruptionStack.length > 0) {
            const id = this.interruptionStack.pop();
            const record = this.records.get(id);
            if (record && record.state === TaskState.PAUSED && record.autoResume !== false) return id;
        }
        return null;
    }

    _takePausedTask() {
        const paused = [...this.records.values()]
            .filter(record => record.state === TaskState.PAUSED && record.autoResume !== false)
            .sort((a, b) => b.priority - a.priority || a.resumeOrder - b.resumeOrder);
        return paused[0]?.id ?? null;
    }

    async _drain(requestedId) {
        while (true) {
            if (this.activeTaskId && this.activeTaskId !== requestedId)
                await this.activePromise;
            const requested = this.records.get(requestedId);
            if (!requested || TERMINAL_STATES.has(requested.state) || requested.state === TaskState.PAUSED)
                return this.getTask(requestedId);
            const next = this._takeNextQueuedTask();
            if (!next) return this.getTask(requestedId);
            await this._execute(next);
            if (next === requestedId) return this.getTask(requestedId);
        }
    }

    async _execute(id) {
        if (this.activeTaskId) throw new Error('Scheduler execution conflict.');
        const record = this._requireRecord(id);
        const runtime = this.runtimes.get(id);
        if (!runtime) throw new Error(`Task ${id} has no runtime.`);
        if (runtime.terminalCheck?.(this.getTask(id))) {
            record.state = TaskState.COMPLETED;
            record.lastResult = taskResult(true, { message: 'Terminal condition reached.', terminal: true });
            record.updatedAt = this.now();
            return this.getTask(id);
        }

        this.activeTaskId = id;
        record.state = TaskState.RUNNING;
        record.interruptedBy = null;
        record.updatedAt = this.now();
        let runnerResult = null;
        const control = {
            taskId: id,
            get record() { return clone(record); },
            checkpoint: (checkpoint, progress = null) => {
                this.updateCheckpoint(id, checkpoint, progress);
                return control.check();
            },
            check: () => {
                if (this.cancelRequests.has(id)) return FailureReason.CANCELLED;
                if (this.pauseRequests.has(id)) return FailureReason.INTERRUPTED;
                return null;
            },
        };

        this.activePromise = (async () => {
            const actionResult = await this.agent.actions.runAction(
                `task:${record.name}`,
                async () => { runnerResult = await runtime.runner(control, this.getTask(id)); },
                { timeout: runtime.timeout },
            );
            this._settle(record, runnerResult, actionResult, runtime);
            return this.getTask(id);
        })();

        try {
            return await this.activePromise;
        } finally {
            this.activeTaskId = null;
            this.activePromise = null;
            this.pauseRequests.delete(id);
            this.cancelRequests.delete(id);
            this.manualPauseRequests.delete(id);
        }
    }

    _settle(record, runnerResult, actionResult, runtime) {
        const cancelled = this.cancelRequests.has(record.id);
        const paused = this.pauseRequests.has(record.id) || actionResult?.interrupted;
        const result = runnerResult ?? taskResult(false, {
            reason: paused ? FailureReason.INTERRUPTED : FailureReason.ACTION_FAILED,
            message: paused ? 'Task was interrupted.' : 'Task produced no result.',
        });
        record.lastResult = clone(result);
        if (result.checkpoint) record.checkpoint = clone(result.checkpoint);
        if (result.progress) record.progress = clone(result.progress);

        if (cancelled) {
            record.state = TaskState.CANCELLED;
        } else if (paused && record.type !== TaskType.SHORT) {
            record.state = TaskState.PAUSED;
            record.autoResume = !this.manualPauseRequests.has(record.id);
            record.pauseReason = record.autoResume ? 'interrupted' : 'owner_pause';
            record.resumeOrder = ++this.resumeSequence;
        } else if (runtime.terminalCheck?.(this.getTask(record.id)) || result.terminal) {
            record.state = TaskState.COMPLETED;
        } else if (result.reason === FailureReason.MISSING_MATERIALS) {
            record.state = TaskState.WAITING_MATERIALS;
        } else if (result.success === false) {
            record.state = TaskState.FAILED;
        } else if (record.type === TaskType.PERSISTENT || result.complete === false) {
            record.state = TaskState.PAUSED;
            record.autoResume = true;
            record.pauseReason = 'yielded';
            record.resumeOrder = ++this.resumeSequence;
        } else {
            record.state = TaskState.COMPLETED;
        }
        record.updatedAt = this.now();
    }
}