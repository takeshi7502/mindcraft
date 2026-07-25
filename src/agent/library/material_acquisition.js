import * as mc from '../../utils/mcdata.js';
import * as skills from './skills.js';
import { FailureReason, taskResult } from './task_primitives.js';

const DEFAULT_LIMITS = Object.freeze({
    chestRange: 32,
    gatherRange: 64,
    maxCollectedBlocks: 256,
    maxRounds: 8,
    maxRecipeDepth: 4,
    timeoutMs: 20 * 60 * 1000,
});

function inventoryCounts(bot) {
    const counts = {};
    for (const item of bot.inventory?.items?.() ?? [])
        counts[item.name] = (counts[item.name] ?? 0) + item.count;
    return counts;
}

function countOf(bot, name) {
    return inventoryCounts(bot)[name] ?? 0;
}

function normalizeShortages(shortages = {}) {
    const result = {};
    for (const [name, value] of Object.entries(shortages)) {
        const missing = Number.isFinite(value) ? value : value?.missing;
        if (Number.isFinite(missing) && missing > 0)
            result[name] = Math.ceil(missing);
    }
    return result;
}

function remainingShortages(bot, targets) {
    const counts = inventoryCounts(bot);
    return Object.fromEntries(Object.entries(targets)
        .map(([name, target]) => [name, Math.max(0, target - (counts[name] ?? 0))])
        .filter(([, missing]) => missing > 0));
}

function positionKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

function makeProtectedSet(positions = []) {
    return new Set(positions.map(positionKey));
}

function chooseRecipe(name, dependencies) {
    const recipes = dependencies.getRecipes(name) ?? [];
    return recipes
        .filter(([ingredients, output]) => ingredients && Object.keys(ingredients).length > 0 &&
            Number.isFinite(output?.craftedCount) && output.craftedCount > 0)
        .sort((left, right) => {
            const leftCost = Object.values(left[0]).reduce((sum, count) => sum + count, 0);
            const rightCost = Object.values(right[0]).reduce((sum, count) => sum + count, 0);
            return leftCost - rightCost;
        })[0] ?? null;
}

/**
 * Acquire exact inventory targets through bounded chest withdrawal, crafting and gathering.
 * Every step is accepted only when inventory increases; skill booleans are never trusted alone.
 */
export async function acquireMaterials(bot, shortages, {
    protectedPositions = [],
    onProgress = null,
    checkpoint = {},
    limits = {},
} = {}, dependencyOverrides = {}) {
    const bounded = { ...DEFAULT_LIMITS, ...limits };
    const dependencies = {
        getRecipes: mc.getItemCraftingRecipes,
        getBlockSources: mc.getItemBlockSources,
        withdraw: (activeBot, name, quantity) => skills.takeFromChest(activeBot, name, quantity),
        craft: (activeBot, name, crafts) => skills.craftRecipe(activeBot, name, crafts),
        collect: (activeBot, source, quantity, excluded) =>
            skills.collectBlock(activeBot, source, quantity, excluded),
        ...dependencyOverrides,
    };
    const requested = normalizeShortages(shortages);
    const initial = inventoryCounts(bot);
    const targets = Object.fromEntries(Object.entries(requested)
        .map(([name, missing]) => [name, (initial[name] ?? 0) + missing]));
    const startedAt = Date.now();
    const steps = [...(checkpoint.steps ?? [])];
    let collectedBlocks = checkpoint.collectedBlocks ?? 0;
    let rounds = 0;
    const priorRounds = checkpoint.rounds ?? 0;
    const protectedSet = makeProtectedSet(protectedPositions);

    const stopped = () => {
        if (bot.interrupt_code) return FailureReason.CANCELLED;
        if (Date.now() - startedAt >= bounded.timeoutMs) return FailureReason.TIMED_OUT;
        return null;
    };
    const report = (phase, data = {}) => onProgress?.({
        type: 'material_acquisition', phase,
        rounds: priorRounds + rounds,
        collectedBlocks,
        remaining: remainingShortages(bot, targets), ...data,
    });
    const recordStep = (action, item, before, after, data = {}) => {
        const step = { action, item, before, after, gained: Math.max(0, after - before), ...data };
        steps.push(step);
        report(action, { item, gained: step.gained });
        return step.gained;
    };

    async function tryWithdraw(name, quantity) {
        if (quantity <= 0 || stopped()) return 0;
        const before = countOf(bot, name);
        try {
            await dependencies.withdraw(bot, name, quantity, { range: bounded.chestRange });
        } catch (error) {
            steps.push({ action: 'withdraw', item: name, error: error.message ?? String(error) });
        }
        return recordStep('withdraw', name, before, countOf(bot, name));
    }

    async function tryCraft(name, crafts) {
        if (crafts <= 0 || stopped()) return 0;
        const before = countOf(bot, name);
        try {
            await dependencies.craft(bot, name, crafts);
        } catch (error) {
            steps.push({ action: 'craft', item: name, error: error.message ?? String(error) });
        }
        return recordStep('craft', name, before, countOf(bot, name), { crafts });
    }

    async function tryCollect(name, quantity) {
        if (quantity <= 0 || stopped() || collectedBlocks >= bounded.maxCollectedBlocks) return 0;
        const sources = dependencies.getBlockSources(name) ?? [];
        for (const source of sources) {
            const quota = Math.min(quantity, bounded.maxCollectedBlocks - collectedBlocks);
            if (quota <= 0) break;
            const before = countOf(bot, name);
            try {
                await dependencies.collect(bot, source, quota, [...protectedSet].map(key => {
                    const [x, y, z] = key.split(',').map(Number);
                    return { x, y, z };
                }), { range: bounded.gatherRange });
            } catch (error) {
                steps.push({ action: 'gather', item: name, source, error: error.message ?? String(error) });
            }
            const gained = recordStep('gather', name, before, countOf(bot, name), { source });
            collectedBlocks += gained;
            if (gained > 0) return gained;
        }
        return 0;
    }

    async function ensure(name, targetCount, depth, ancestry = new Set()) {
        if (countOf(bot, name) >= targetCount) return true;
        if (stopped() || depth > bounded.maxRecipeDepth || ancestry.has(name)) return false;
        const nextAncestry = new Set(ancestry).add(name);

        await tryWithdraw(name, targetCount - countOf(bot, name));
        if (countOf(bot, name) >= targetCount) return true;

        const recipe = chooseRecipe(name, dependencies);
        if (recipe) {
            const [ingredients, output] = recipe;
            const crafts = Math.ceil((targetCount - countOf(bot, name)) / output.craftedCount);
            for (const [ingredient, perCraft] of Object.entries(ingredients)) {
                const needed = countOf(bot, ingredient) + perCraft * crafts;
                await ensure(ingredient, needed, depth + 1, nextAncestry);
                if (stopped()) return false;
            }
            await tryCraft(name, crafts);
            if (countOf(bot, name) >= targetCount) return true;
        }

        await tryCollect(name, targetCount - countOf(bot, name));
        return countOf(bot, name) >= targetCount;
    }

    let previousRemaining = null;
    while (rounds < bounded.maxRounds) {
        const reason = stopped();
        if (reason) {
            return taskResult(false, {
                reason,
                message: reason === FailureReason.CANCELLED
                    ? 'Material acquisition was interrupted.'
                    : 'Material acquisition reached its deadline.',
                data: { remaining: remainingShortages(bot, targets), steps, collectedBlocks },
                checkpoint: { rounds: priorRounds + rounds, steps, collectedBlocks },
                progress: { phase: 'acquiring_materials', rounds, collectedBlocks },
                complete: false,
            });
        }
        const remaining = remainingShortages(bot, targets);
        if (Object.keys(remaining).length === 0) {
            return taskResult(true, {
                message: `Acquired all requested construction materials in ${rounds} round(s).`,
                data: { acquired: inventoryDelta(initial, inventoryCounts(bot)), steps, collectedBlocks },
                checkpoint: { rounds: priorRounds + rounds, steps, collectedBlocks },
                progress: { phase: 'materials_ready', rounds, collectedBlocks },
            });
        }
        const signature = JSON.stringify(remaining);
        if (signature === previousRemaining) break;
        previousRemaining = signature;
        rounds++;
        report('planning');
        for (const [name, missing] of Object.entries(remaining))
            await ensure(name, countOf(bot, name) + missing, 0);
    }

    const remaining = remainingShortages(bot, targets);
    return taskResult(false, {
        reason: FailureReason.MISSING_MATERIALS,
        message: `Could not acquire: ${Object.entries(remaining).map(([name, count]) =>
            `${count} ${name}`).join(', ')}.`,
        data: { remaining, steps, collectedBlocks },
        checkpoint: { rounds: priorRounds + rounds, steps, collectedBlocks },
        progress: { phase: 'waiting_materials', rounds, collectedBlocks, remaining },
        complete: false,
    });
}

export function inventoryDelta(before, after) {
    return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
        .map(name => [name, (after[name] ?? 0) - (before[name] ?? 0)])
        .filter(([, change]) => change !== 0));
}

export { DEFAULT_LIMITS as MATERIAL_ACQUISITION_LIMITS };
