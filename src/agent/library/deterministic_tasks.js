import {
    createTaskContext,
    FailureReason,
    retryBounded,
    taskResult,
} from './task_primitives.js';
import {
    findReachableAdjacent,
    isFishableWater,
    isSafeStandingPosition,
    observeNearbyBlocks,
} from './task_observation.js';

const DEFAULT_DEPENDENCIES = {
    findReachableAdjacent,
    isFishableWater,
    isSafeStandingPosition,
    observeNearbyBlocks,
};

function dependenciesWith(overrides = {}) {
    return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function clampInteger(value, minimum, maximum, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

function positionData(position) {
    return { x: position.x, y: position.y, z: position.z };
}

function isFailure(value) {
    return value?.success === false;
}

export function inventoryCounts(bot) {
    const counts = {};
    for (const item of bot.inventory.items())
        counts[item.name] = (counts[item.name] ?? 0) + item.count;
    return counts;
}

export function inventoryDelta(before, after) {
    const delta = {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const change = (after[name] ?? 0) - (before[name] ?? 0);
        if (change) delta[name] = change;
    }
    return delta;
}

function basicSafetyFailure(bot) {
    if (!bot?.entity?.position || !bot?.inventory)
        return 'The bot is not ready for deterministic tasks.';
    if (bot.health != null && bot.health <= 6)
        return 'Health is too low for this task.';
    if (bot.entity.isInLava)
        return 'The bot is currently in lava.';

    const feet = bot.blockAt(bot.entity.position);
    if (feet && ['lava', 'fire', 'soul_fire', 'powder_snow'].includes(feet.name))
        return 'The bot is currently in a hazardous block.';
    return null;
}

function stopNavigation(bot) {
    bot.pathfinder?.stop();
}

function stopActiveCast(bot, castState) {
    if (!castState.active || bot.heldItem?.name !== 'fishing_rod') return;
    try {
        bot.activateItem();
    } catch (error) {
        console.warn('Failed to reel in timed-out fishing cast:', error);
    }
}

async function locateReachableTarget(bot, context, {
    names,
    predicate,
    searchRadius,
    maxTargets,
    maxCandidates,
    pathTimeoutMs,
    verticalOffsets,
    navigation,
}, dependencies) {
    const targets = await context.phase('observe', () =>
        dependencies.observeNearbyBlocks(bot, {
            names,
            predicate,
            maxDistance: searchRadius,
            count: Math.max(maxTargets * 2, maxTargets),
        }), { timeoutMs: 5000 });
    if (isFailure(targets)) return targets;
    if (targets.length === 0) {
        return taskResult(false, {
            reason: FailureReason.NOT_FOUND,
            message: `No matching target found within ${searchRadius} blocks.`,
        });
    }

    const location = await context.phase('reachability', async () => {
        for (const target of targets.slice(0, maxTargets)) {
            const reachable = await dependencies.findReachableAdjacent(bot, target, {
                maxCandidates,
                pathTimeoutMs,
                verticalOffsets,
                ...navigation,
            });
            if (reachable) return { target, ...reachable };
            if (bot.interrupt_code) break;
        }
        return null;
    }, {
        timeoutMs: Math.min(12000, context.remainingMs()),
        onStop: () => stopNavigation(bot),
    });
    if (isFailure(location)) return location;
    if (!location) {
        return taskResult(false, {
            reason: FailureReason.UNREACHABLE,
            message: `Targets were found, but no safe non-destructive path was available.`,
        });
    }
    return location;
}

function navigateToLocation(bot, context, location, timeoutMs = 20000) {
    return context.phase('navigate', async () => {
        bot.pathfinder.setMovements(location.movements);
        await bot.pathfinder.goto(location.goal);
        return true;
    }, {
        timeoutMs: Math.min(timeoutMs, context.remainingMs()),
        onStop: () => stopNavigation(bot),
        errorReason: FailureReason.UNREACHABLE,
    });
}

/**
 * Conservative reusable navigation for resources and interactive blocks.
 */
export async function approachNearbyBlock(bot, {
    names,
    searchRadius = 16,
    timeoutMs = 45000,
    maxTargets = 8,
    maxCandidates = 8,
    pathTimeoutMs = 1200,
    predicate = null,
    verticalOffsets = [0, 1, -1],
    navigation = {},
} = {}, dependencyOverrides = {}) {
    const boundedTimeout = clampInteger(timeoutMs, 5000, 120000, 45000);
    const context = createTaskContext(bot, { timeoutMs: boundedTimeout });
    const dependencies = dependenciesWith(dependencyOverrides);
    const requestedNames = typeof names === 'string' ? [names] : names;
    if (!Array.isArray(requestedNames) || requestedNames.length === 0) {
        return context.finish(false, {
            reason: FailureReason.INVALID_INPUT,
            message: 'At least one target block name is required.',
        });
    }
    const unsafe = basicSafetyFailure(bot);
    if (unsafe)
        return context.finish(false, { reason: FailureReason.UNSAFE, message: unsafe });

    try {
        const location = await locateReachableTarget(bot, context, {
            names: requestedNames,
            predicate,
            searchRadius: clampInteger(searchRadius, 1, 32, 16),
            maxTargets: clampInteger(maxTargets, 1, 16, 8),
            maxCandidates: clampInteger(maxCandidates, 1, 24, 8),
            pathTimeoutMs: clampInteger(pathTimeoutMs, 100, 5000, 1200),
            verticalOffsets,
            navigation,
        }, dependencies);
        if (isFailure(location)) return context.finish(false, location);

        const moved = await navigateToLocation(bot, context, location);
        if (isFailure(moved)) return context.finish(false, moved);

        const refreshed = bot.blockAt(location.target.position);
        if (!refreshed || !requestedNames.includes(refreshed.name)) {
            return context.finish(false, {
                reason: FailureReason.NO_PROGRESS,
                message: 'The target changed before arrival.',
            });
        }
        return context.finish(true, {
            message: `Reached a safe position beside ${refreshed.name}.`,
            data: {
                target: positionData(refreshed.position),
                standing: positionData(location.position),
                block: refreshed.name,
            },
        });
    } catch (error) {
        return context.finish(false, {
            reason: FailureReason.ACTION_FAILED,
            message: `Approach task failed: ${error.message ?? String(error)}`,
        });
    }
}

export async function fishNearby(bot, {
    searchRadius = 16,
    attempts = 2,
    timeoutMs = 90000,
    castTimeoutMs = 35000,
    navigation = {},
} = {}, dependencyOverrides = {}) {
    const boundedRadius = clampInteger(searchRadius, 4, 32, 16);
    const boundedAttempts = clampInteger(attempts, 1, 3, 2);
    const boundedTimeout = clampInteger(timeoutMs, 10000, 120000, 90000);
    const boundedCastTimeout = clampInteger(castTimeoutMs, 5000, 45000, 35000);
    const context = createTaskContext(bot, { timeoutMs: boundedTimeout });
    const dependencies = dependenciesWith(dependencyOverrides);

    const rod = bot.inventory?.items().find(item => item.name === 'fishing_rod');
    if (!rod) {
        return context.finish(false, {
            reason: FailureReason.MISSING_EQUIPMENT,
            message: 'A fishing rod is required.',
        });
    }
    const unsafe = basicSafetyFailure(bot);
    if (unsafe)
        return context.finish(false, { reason: FailureReason.UNSAFE, message: unsafe });

    try {
        const location = await locateReachableTarget(bot, context, {
            names: ['water'],
            predicate: block => dependencies.isFishableWater(bot, block),
            searchRadius: boundedRadius,
            maxTargets: 6,
            maxCandidates: 6,
            pathTimeoutMs: 1000,
            verticalOffsets: [0],
            navigation,
        }, dependencies);
        if (isFailure(location)) {
            if (location.reason === FailureReason.NOT_FOUND) {
                location.message = `No fishable surface water found within ${boundedRadius} blocks.`;
            }
            return context.finish(false, location);
        }

        const moved = await navigateToLocation(bot, context, location);
        if (isFailure(moved)) return context.finish(false, moved);

        const revalidated = await context.phase('revalidate', () => {
            const water = bot.blockAt(location.target.position);
            const currentPosition = bot.entity.position.floored();
            return Boolean(
                dependencies.isFishableWater(bot, water) &&
                dependencies.isSafeStandingPosition(bot, currentPosition) &&
                currentPosition.distanceTo(location.position) <= 1
            );
        }, { timeoutMs: 2000 });
        if (isFailure(revalidated)) return context.finish(false, revalidated);
        if (!revalidated) {
            return context.finish(false, {
                reason: FailureReason.NO_PROGRESS,
                message: 'Water or the standing position was no longer safe after moving.',
            });
        }

        const equipped = await context.phase('equip', () => bot.equip(rod, 'hand'), {
            timeoutMs: 5000,
        });
        if (isFailure(equipped)) return context.finish(false, equipped);

        const result = await retryBounded(context, async () => {
            const currentRod = bot.inventory.items()
                .find(item => item.name === 'fishing_rod');
            if (!currentRod) {
                return taskResult(false, {
                    reason: FailureReason.MISSING_EQUIPMENT,
                    message: 'The fishing rod is no longer available.',
                });
            }

            const aimed = await context.phase('aim', () =>
                bot.lookAt(location.target.position.offset(0.5, 0.65, 0.5), true), {
                timeoutMs: 3000,
            });
            if (isFailure(aimed)) return aimed;

            const before = inventoryCounts(bot);
            const castState = { active: false };
            const cast = await context.phase('cast', async () => {
                castState.active = true;
                try {
                    await bot.fish();
                    return inventoryDelta(before, inventoryCounts(bot));
                } finally {
                    castState.active = false;
                }
            }, {
                timeoutMs: Math.min(boundedCastTimeout, context.remainingMs()),
                onStop: () => stopActiveCast(bot, castState),
            });
            if (isFailure(cast)) return cast;

            const caught = Object.entries(cast)
                .filter(([name, count]) => count > 0 && name !== 'fishing_rod');
            if (caught.length === 0) {
                return taskResult(false, {
                    reason: FailureReason.NO_PROGRESS,
                    message: 'Cast completed without an inventory gain.',
                });
            }
            return taskResult(true, {
                message: `Fishing succeeded: ${caught.map(([name, count]) =>
                    `${count} ${name}`).join(', ')}.`,
                data: {
                    caught: Object.fromEntries(caught),
                    water: positionData(location.target.position),
                    standing: positionData(location.position),
                },
            });
        }, { attempts: boundedAttempts });
        return context.finish(result.success, result);
    } catch (error) {
        stopNavigation(bot);
        return context.finish(false, {
            reason: FailureReason.ACTION_FAILED,
            message: `Fishing task failed: ${error.message ?? String(error)}`,
        });
    }
}

export function formatTaskResult(result) {
    const status = result.success ? 'success' : `failed (${result.reason})`;
    const phases = Object.entries(result.metrics?.phases ?? {})
        .map(([name, metric]) =>
            `${name}=${metric.durationMs}ms${metric.count > 1 ? `x${metric.count}` : ''}`)
        .join(', ');
    const total = Number.isFinite(result.metrics?.totalMs)
        ? ` Total=${result.metrics.totalMs}ms.`
        : '';
    return `Task ${status}: ${result.message}` +
        `${result.attempts ? ` Attempts: ${result.attempts}.` : ''}` +
        `${phases ? ` Timing: ${phases}.` : ''}${total}`;
}
