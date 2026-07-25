import { Vec3 } from 'vec3';
import * as skills from './skills.js';
import { findReachableAdjacent } from './task_observation.js';
import {
    createTaskContext,
    FailureReason,
    retryBounded,
    taskResult,
} from './task_primitives.js';
import { blockSatisfied as npcBlockSatisfied, getTypeOfGeneric } from '../npc/utils.js';
import { loadBlueprint } from './blueprint_catalog.js';

const MAX_BLUEPRINT_CELLS = 4096;
const REPLACEABLE_BLOCKS = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'grass',
    'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'glow_lichen',
]);
const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'powder_snow', 'water']);
const ATTACHMENT_PATTERN = /(torch|ladder|button|lever|rail|tripwire|door|bed|carpet|sign|banner)$/;

function clampInteger(value, minimum, maximum, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

function coordinate(value, label) {
    if (!Number.isFinite(value)) throw new Error(`${label} must be a finite coordinate.`);
    return Math.floor(value);
}

function normalizeOrigin(origin) {
    if (!origin) return new Vec3(0, 0, 0);
    return new Vec3(
        coordinate(origin.x ?? origin[0], 'origin.x'),
        coordinate(origin.y ?? origin[1], 'origin.y'),
        coordinate(origin.z ?? origin[2], 'origin.z'),
    );
}

function positionData(position) {
    return { x: position.x, y: position.y, z: position.z };
}

function positionKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

function rotateLocal(x, z, orientation, sizeX, sizeZ) {
    if (orientation === 0) return [x, z];
    if (orientation === 1) return [sizeZ - z - 1, x];
    if (orientation === 2) return [sizeX - x - 1, sizeZ - z - 1];
    return [z, sizeX - x - 1];
}

function sourceCells(blueprint) {
    if (Array.isArray(blueprint?.blocks)) {
        const cells = [];
        const sourceOffset = Number.isFinite(blueprint.offset) ? Math.floor(blueprint.offset) : 0;
        let sizeX = 0;
        let sizeZ = 0;
        for (let y = 0; y < blueprint.blocks.length; y++) {
            const layer = blueprint.blocks[y];
            if (!Array.isArray(layer)) throw new Error(`Blueprint layer ${y} must be an array.`);
            sizeZ = Math.max(sizeZ, layer.length);
            for (let z = 0; z < layer.length; z++) {
                const row = layer[z];
                if (!Array.isArray(row)) throw new Error(`Blueprint row ${y}/${z} must be an array.`);
                sizeX = Math.max(sizeX, row.length);
                for (let x = 0; x < row.length; x++)
                    cells.push({ x, y: y + sourceOffset, z, raw: row[x] });
            }
        }
        return {
            cells,
            sizeX,
            sizeY: blueprint.blocks.length,
            sizeZ,
            suggestedOrigin: null,
            sourceOffset,
        };
    }

    if (Array.isArray(blueprint?.levels)) {
        const absolute = [];
        for (const [levelIndex, level] of blueprint.levels.entries()) {
            if (!Array.isArray(level.coordinates) || level.coordinates.length !== 3)
                throw new Error(`Blueprint level ${levelIndex} requires [x, y, z] coordinates.`);
            if (!Array.isArray(level.placement))
                throw new Error(`Blueprint level ${levelIndex} placement must be an array.`);
            const [baseX, baseY, baseZ] = level.coordinates.map((value, index) =>
                coordinate(value, `level ${levelIndex} coordinate ${index}`));
            for (let z = 0; z < level.placement.length; z++) {
                const row = level.placement[z];
                if (!Array.isArray(row)) throw new Error(`Blueprint level ${levelIndex} row ${z} must be an array.`);
                for (let x = 0; x < row.length; x++)
                    absolute.push({ x: baseX + x, y: baseY, z: baseZ + z, raw: row[x] });
            }
        }
        if (absolute.length === 0) throw new Error('Blueprint has no cells.');
        const minX = Math.min(...absolute.map(cell => cell.x));
        const minY = Math.min(...absolute.map(cell => cell.y));
        const minZ = Math.min(...absolute.map(cell => cell.z));
        const cells = absolute.map(cell => ({
            ...cell,
            x: cell.x - minX,
            y: cell.y - minY,
            z: cell.z - minZ,
        }));
        return {
            cells,
            sizeX: Math.max(...cells.map(cell => cell.x)) + 1,
            sizeY: Math.max(...cells.map(cell => cell.y)) + 1,
            sizeZ: Math.max(...cells.map(cell => cell.z)) + 1,
            suggestedOrigin: new Vec3(minX, minY, minZ),
            sourceOffset: 0,
        };
    }

    throw new Error('Blueprint must contain either blocks[y][z][x] or levels[].placement.');
}

export function normalizeBlueprint(blueprint, {
    bot = null,
    origin = null,
    orientation = 0,
    resolveBlockName = (unusedBot, name) => name,
} = {}) {
    const normalizedOrientation = coordinate(orientation, 'orientation');
    if (normalizedOrientation < 0 || normalizedOrientation > 3)
        throw new Error('Orientation must be 0, 1, 2, or 3.');
    const source = sourceCells(blueprint);
    const buildOrigin = normalizeOrigin(origin ?? source.suggestedOrigin);
    const entries = [];

    for (const cell of source.cells) {
        if (cell.raw == null || cell.raw === '') continue;
        if (typeof cell.raw !== 'string') throw new Error('Blueprint block names must be strings, null, or empty.');
        const raw = cell.raw.trim().toLowerCase();
        if (!raw) continue;
        const block = raw === 'air' ? 'air' : resolveBlockName(bot, raw);
        if (typeof block !== 'string' || !block)
            throw new Error(`Could not resolve blueprint material ${raw}.`);
        const [localX, localZ] = rotateLocal(
            cell.x,
            cell.z,
            normalizedOrientation,
            source.sizeX,
            source.sizeZ,
        );
        const local = new Vec3(localX, cell.y, localZ);
        entries.push({
            raw,
            block,
            local,
            position: buildOrigin.plus(local),
            source: { x: cell.x, y: cell.y, z: cell.z },
        });
    }
    if (entries.length === 0) throw new Error('Blueprint has no actionable cells.');
    if (entries.length > MAX_BLUEPRINT_CELLS)
        throw new Error(`Blueprint exceeds the ${MAX_BLUEPRINT_CELLS}-cell safety limit.`);

    return {
        name: String(blueprint.name ?? 'blueprint'),
        orientation: normalizedOrientation,
        origin: buildOrigin,
        suggestedOrigin: source.suggestedOrigin,
        sourceOffset: source.sourceOffset,
        size: {
            x: normalizedOrientation % 2 === 0 ? source.sizeX : source.sizeZ,
            y: source.sizeY,
            z: normalizedOrientation % 2 === 0 ? source.sizeZ : source.sizeX,
        },
        entries,
    };
}

export function translateBlueprint(plan, origin) {
    const buildOrigin = normalizeOrigin(origin);
    return {
        ...plan,
        origin: buildOrigin,
        entries: plan.entries.map(entry => ({
            ...entry,
            position: buildOrigin.plus(entry.local),
        })),
    };
}

function attachmentPriority(entry) {
    if (entry.raw === 'air') return 3;
    if (ATTACHMENT_PATTERN.test(entry.raw) || ATTACHMENT_PATTERN.test(entry.block)) return 2;
    if (/(sand|gravel|concrete_powder|anvil)$/.test(entry.block)) return 1;
    return 0;
}

function stablePositionSort(left, right) {
    return left.local.z - right.local.z || left.local.x - right.local.x;
}

export function orderBlueprintPlacements(entries) {
    const nonAir = entries.filter(entry => entry.raw !== 'air');
    const expected = new Set(nonAir.map(entry => positionKey(entry.local)));
    const layers = new Map();
    for (const entry of nonAir) {
        if (!layers.has(entry.local.y)) layers.set(entry.local.y, []);
        layers.get(entry.local.y).push(entry);
    }
    const ordered = [];
    const minimumLayer = Math.min(...layers.keys());
    for (const y of [...layers.keys()].sort((a, b) => a - b)) {
        const layer = layers.get(y);
        const structural = layer.filter(entry => attachmentPriority(entry) < 2);
        const attachments = layer.filter(entry => attachmentPriority(entry) >= 2);
        const remaining = new Map(structural.map(entry => [positionKey(entry.local), entry]));
        const frontier = structural
            .filter(entry => y === minimumLayer || expected.has(positionKey(entry.local.offset(0, -1, 0))))
            .sort((a, b) => attachmentPriority(a) - attachmentPriority(b) || stablePositionSort(a, b));

        while (frontier.length > 0) {
            const entry = frontier.shift();
            const key = positionKey(entry.local);
            if (!remaining.delete(key)) continue;
            ordered.push(entry);
            for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
                const neighbor = remaining.get(positionKey(entry.local.offset(dx, 0, dz)));
                if (neighbor) frontier.push(neighbor);
            }
        }
        ordered.push(...[...remaining.values()].sort(stablePositionSort));
        ordered.push(...attachments.sort((a, b) =>
            attachmentPriority(a) - attachmentPriority(b) || stablePositionSort(a, b)));
    }
    return ordered;
}

function isReplaceable(block) {
    return Boolean(block) && REPLACEABLE_BLOCKS.has(block.name);
}

function isSolid(block) {
    return Boolean(block) && !REPLACEABLE_BLOCKS.has(block.name) && !HAZARDS.has(block.name) &&
        (block.boundingBox === 'block' || block.name !== 'air');
}

function satisfies(entry, block, checker = npcBlockSatisfied) {
    if (!block) return false;
    if (entry.raw === 'air') return isReplaceable(block);
    return block.name === entry.block || checker(entry.raw, block);
}

export function validateBuildSite(bot, plan, { blockSatisfied = npcBlockSatisfied } = {}) {
    const conflicts = [];
    const expectedPositions = new Set(plan.entries
        .filter(entry => entry.raw !== 'air')
        .map(entry => positionKey(entry.position)));

    for (const entry of plan.entries) {
        const current = bot.blockAt(entry.position);
        if (!current) {
            conflicts.push({ position: positionData(entry.position), actual: 'unloaded', expected: entry.raw });
        } else if (!satisfies(entry, current, blockSatisfied) && !isReplaceable(current)) {
            conflicts.push({ position: positionData(entry.position), actual: current.name, expected: entry.raw });
        }
        if (conflicts.length >= 8) break;
    }

    if (conflicts.length === 0) {
        const structural = plan.entries.filter(entry => entry.raw !== 'air');
        const minimumLayer = Math.min(...structural.map(entry => entry.local.y));
        for (const entry of structural) {
            if (entry.local.y !== minimumLayer) continue;
            const below = entry.position.offset(0, -1, 0);
            if (expectedPositions.has(positionKey(below))) continue;
            if (!isSolid(bot.blockAt(below))) {
                conflicts.push({
                    position: positionData(entry.position),
                    actual: 'unsupported',
                    expected: entry.raw,
                });
                if (conflicts.length >= 8) break;
            }
        }
    }
    return { safe: conflicts.length === 0, conflicts };
}

export function findSafeBuildOrigin(bot, plan, {
    searchRadius = 16,
    maxCandidates = 96,
    blockSatisfied = npcBlockSatisfied,
} = {}) {
    if (typeof bot.findBlocks !== 'function') return null;
    const positions = bot.findBlocks({
        matching: block => block?.name === 'air',
        maxDistance: clampInteger(searchRadius, 4, 32, 16),
        count: clampInteger(maxCandidates, 8, 128, 96),
    }) ?? [];
    const candidates = positions
        .map(position => normalizeOrigin(position))
        .sort((left, right) =>
            left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position));

    const minimumLayer = Math.min(...plan.entries.map(entry => entry.local.y));
    for (const basePosition of candidates) {
        const origin = basePosition.offset(0, -minimumLayer, 0);
        const candidate = translateBlueprint(plan, origin);
        if (validateBuildSite(bot, candidate, { blockSatisfied }).safe) return origin;
    }
    return null;
}

function inventoryCounts(bot) {
    const counts = {};
    const items = typeof bot.inventory?.items === 'function'
        ? bot.inventory.items()
        : (bot.inventory?.slots ?? []).filter(Boolean);
    for (const item of items)
        counts[item.name] = (counts[item.name] ?? 0) + item.count;
    return counts;
}

function materialName(entry) {
    if (entry.block === 'redstone_wire') return 'redstone';
    if (entry.block === 'water') return 'water_bucket';
    if (entry.block === 'lava') return 'lava_bucket';
    if (entry.block.startsWith('wall_') && entry.block.endsWith('torch'))
        return entry.block.replace('wall_', '');
    return entry.block;
}

function materialUnitKey(entry, entriesByPosition) {
    const name = materialName(entry);
    if (name.endsWith('_door')) {
        for (const dy of [-1, 1]) {
            const neighbor = entriesByPosition.get(positionKey(entry.position.offset(0, dy, 0)));
            if (neighbor && materialName(neighbor) === name) {
                const lowY = Math.min(entry.position.y, neighbor.position.y);
                return `${name}:door:${entry.position.x},${lowY},${entry.position.z}`;
            }
        }
    }
    if (name.endsWith('_bed')) {
        const neighbors = [[1, 0], [0, 1], [-1, 0], [0, -1]]
            .map(([dx, dz]) => entriesByPosition.get(positionKey(entry.position.offset(dx, 0, dz))))
            .filter(neighbor => neighbor && materialName(neighbor) === name);
        if (neighbors.length > 0) {
            const pair = [entry, neighbors[0]].sort((a, b) =>
                a.position.x - b.position.x || a.position.z - b.position.z);
            return `${name}:bed:${positionKey(pair[0].position)}`;
        }
    }
    return `${name}:cell:${positionKey(entry.position)}`;
}

export function preflightBlueprint(bot, plan, {
    blockSatisfied = npcBlockSatisfied,
} = {}) {
    const site = validateBuildSite(bot, plan, { blockSatisfied });
    if (!site.safe) {
        return taskResult(false, {
            reason: FailureReason.BLOCKED,
            message: 'Build site is obstructed, hazardous, unloaded, or unsupported.',
            data: { conflicts: site.conflicts },
        });
    }

    const requiredUnits = new Map();
    const entriesByPosition = new Map(plan.entries.map(entry => [positionKey(entry.position), entry]));
    let alreadyCorrect = 0;
    let clearanceCells = 0;
    for (const entry of plan.entries) {
        const current = bot.blockAt(entry.position);
        if (entry.raw === 'air') {
            clearanceCells++;
            continue;
        }
        if (satisfies(entry, current, blockSatisfied)) {
            alreadyCorrect++;
            continue;
        }
        const item = materialName(entry);
        if (!requiredUnits.has(item)) requiredUnits.set(item, new Set());
        requiredUnits.get(item).add(materialUnitKey(entry, entriesByPosition));
    }

    const requirements = Object.fromEntries(
        [...requiredUnits.entries()].map(([name, units]) => [name, units.size]));
    const available = inventoryCounts(bot);
    const creative = bot.game?.gameMode === 'creative' && !bot.restrict_to_inventory;
    const shortages = {};
    if (!creative) {
        for (const [name, required] of Object.entries(requirements)) {
            const count = available[name] ?? 0;
            if (count < required)
                shortages[name] = { required, available: count, missing: required - count };
        }
    }
    if (Object.keys(shortages).length > 0) {
        return taskResult(false, {
            reason: FailureReason.MISSING_MATERIALS,
            message: `Missing materials: ${Object.entries(shortages)
                .map(([name, value]) => `${value.missing} ${name}`)
                .join(', ')}.`,
            data: { requirements, available, shortages, alreadyCorrect, clearanceCells },
        });
    }
    return taskResult(true, {
        message: 'Blueprint preflight passed.',
        data: { requirements, available, shortages, alreadyCorrect, clearanceCells },
    });
}

export function validateNamedBlueprintReconnect(bot, name, {
    orientation = 0,
    checkpoint = {},
} = {}, {
    resolveBlockName = getTypeOfGeneric,
    blockSatisfied = npcBlockSatisfied,
} = {}) {
    try {
        const blueprint = loadBlueprint(name);
        if (checkpoint.completedKeys != null && !Array.isArray(checkpoint.completedKeys)) {
            return {
                eligible: false,
                state: 'failed',
                reason: 'invalid_build_checkpoint',
                failureReason: FailureReason.INVALID_INPUT,
                message: 'Build checkpoint completedKeys must be an array.',
            };
        }
        const completedKeys = checkpoint.completedKeys ?? [];
        if (completedKeys.length > MAX_BLUEPRINT_CELLS ||
            completedKeys.some(key => typeof key !== 'string')) {
            return {
                eligible: false,
                state: 'failed',
                reason: 'invalid_build_checkpoint',
                failureReason: FailureReason.INVALID_INPUT,
                message: 'Build checkpoint completedKeys are invalid or exceed the safety limit.',
            };
        }
        if (!checkpoint.origin) {
            if (completedKeys.length === 0) {
                return {
                    eligible: true,
                    reason: 'build_not_started',
                    message: 'Build had not selected an origin; safe preflight will run again.',
                };
            }
            return {
                eligible: false,
                state: 'paused',
                reason: 'invalid_build_checkpoint',
                failureReason: FailureReason.INVALID_INPUT,
                message: 'Build checkpoint contains progress without a saved origin.',
            };
        }

        const plan = translateBlueprint(normalizeBlueprint(blueprint, {
            bot,
            origin: { x: 0, y: 0, z: 0 },
            orientation,
            resolveBlockName,
        }), checkpoint.origin);
        const expected = new Map(plan.entries
            .filter(entry => entry.raw !== 'air')
            .map(entry => [positionKey(entry.position), entry]));
        for (const key of completedKeys) {
            const entry = expected.get(key);
            if (!entry || !satisfies(entry, bot.blockAt(entry.position), blockSatisfied)) {
                return {
                    eligible: false,
                    state: 'paused',
                    reason: 'build_checkpoint_world_mismatch',
                    failureReason: FailureReason.BLOCKED,
                    message: `Saved build progress no longer matches the world at ${key}.`,
                };
            }
        }

        const preflight = preflightBlueprint(bot, plan, { blockSatisfied });
        if (!preflight.success) {
            return {
                eligible: false,
                state: preflight.reason === FailureReason.MISSING_MATERIALS
                    ? 'waiting_materials'
                    : 'paused',
                reason: preflight.reason === FailureReason.MISSING_MATERIALS
                    ? 'reconnect_missing_materials'
                    : 'reconnect_build_site_invalid',
                failureReason: preflight.reason,
                message: preflight.message,
            };
        }
        return {
            eligible: true,
            reason: 'build_checkpoint_verified',
            message: `Verified ${completedKeys.length} saved build placement(s).`,
        };
    } catch (error) {
        return {
            eligible: false,
            state: 'failed',
            reason: 'invalid_blueprint_context',
            failureReason: FailureReason.INVALID_INPUT,
            message: error.message ?? String(error),
        };
    }
}
function placementSide(entry) {
    if (entry.raw.includes('torch') || entry.block.includes('torch')) return 'side';
    return 'bottom';
}

async function ensureReachable(bot, context, entry, dependencies, options) {
    if (bot.entity.position.distanceTo(entry.position) <= 4.25) return true;
    const target = bot.blockAt(entry.position) ?? { name: 'air', position: entry.position };
    const reachable = await context.phase('placement_reachability', () =>
        dependencies.findReachableAdjacent(bot, target, {
            maxCandidates: 8,
            pathTimeoutMs: 1200,
            verticalOffsets: [0, -1, -2],
            ...options.navigation,
        }), {
        timeoutMs: Math.min(6000, context.remainingMs()),
        onStop: () => bot.pathfinder?.stop(),
        errorReason: FailureReason.UNREACHABLE,
    });
    if (reachable?.success === false) return reachable;
    if (!reachable) {
        return taskResult(false, {
            reason: FailureReason.UNREACHABLE,
            message: `No safe non-destructive path near ${positionKey(entry.position)}.`,
        });
    }
    const moved = await context.phase('placement_navigate', async () => {
        bot.pathfinder.setMovements(reachable.movements);
        await bot.pathfinder.goto(reachable.goal);
        return true;
    }, {
        timeoutMs: Math.min(15000, context.remainingMs()),
        onStop: () => bot.pathfinder?.stop(),
        errorReason: FailureReason.UNREACHABLE,
    });
    return moved?.success === false ? moved : true;
}

function buildProgress(plan, placed, alreadyCorrect, failed = 0) {
    const total = plan.entries.filter(entry => entry.raw !== 'air').length;
    return {
        total,
        placed,
        alreadyCorrect,
        failed,
        completed: placed + alreadyCorrect,
        remaining: Math.max(0, total - placed - alreadyCorrect),
    };
}

export async function buildBlueprint(bot, blueprint, {
    origin = null,
    orientation = 0,
    searchRadius = 16,
    retries = 2,
    timeoutMs = 900000,
    checkpoint = {},
    onCheckpoint = null,
    onProgress = null,
    navigation = {},
} = {}, dependencyOverrides = {}) {
    const boundedTimeout = clampInteger(timeoutMs, 30000, 1200000, 900000);
    const context = createTaskContext(bot, { timeoutMs: boundedTimeout });
    const dependencies = {
        resolveBlockName: getTypeOfGeneric,
        blockSatisfied: npcBlockSatisfied,
        findBuildOrigin: findSafeBuildOrigin,
        findReachableAdjacent,
        placeBlock: skills.placeBlock,
        ...dependencyOverrides,
    };

    try {
        let plan = await context.phase('normalize_blueprint', () => normalizeBlueprint(blueprint, {
            bot,
            origin: { x: 0, y: 0, z: 0 },
            orientation,
            resolveBlockName: dependencies.resolveBlockName,
        }), { timeoutMs: 3000, errorReason: FailureReason.INVALID_INPUT });
        if (plan?.success === false) return context.finish(false, plan);

        let buildOrigin = origin ?? checkpoint.origin ?? plan.suggestedOrigin;
        if (!buildOrigin) {
            buildOrigin = await context.phase('select_origin', () => dependencies.findBuildOrigin(bot, plan, {
                searchRadius,
                blockSatisfied: dependencies.blockSatisfied,
            }), { timeoutMs: 12000, errorReason: FailureReason.NOT_FOUND });
            if (buildOrigin?.success === false) return context.finish(false, buildOrigin);
            if (!buildOrigin) {
                return context.finish(false, {
                    reason: FailureReason.NOT_FOUND,
                    message: `No safe flat build origin found within ${searchRadius} blocks.`,
                });
            }
        }
        plan = translateBlueprint(plan, buildOrigin);
        onCheckpoint?.({
            origin: positionData(plan.origin),
            orientation: plan.orientation,
            currentLayer: checkpoint.currentLayer ?? null,
            completedKeys: checkpoint.completedKeys ?? [],
        });

        const preflight = await context.phase('preflight', () => preflightBlueprint(bot, plan, {
            blockSatisfied: dependencies.blockSatisfied,
        }), { timeoutMs: 10000 });
        if (preflight?.success === false) {
            return context.finish(false, {
                ...preflight,
                data: {
                    ...preflight.data,
                    blueprint: plan.name,
                    origin: positionData(plan.origin),
                    orientation: plan.orientation,
                    protectedPositions: plan.entries.map(entry => positionData(entry.position)),
                },
            });
        }

        const ordered = orderBlueprintPlacements(plan.entries);
        const completedKeys = new Set(checkpoint.completedKeys ?? []);
        let placed = 0;
        let alreadyCorrect = 0;
        let currentLayer = null;
        const maxAttempts = clampInteger(retries, 1, 3, 2);

        onProgress?.({
            type: 'preflight_complete',
            blueprint: plan.name,
            origin: positionData(plan.origin),
            orientation: plan.orientation,
            requirements: preflight.data.requirements,
            ...buildProgress(plan, placed, alreadyCorrect),
        });

        for (const entry of ordered) {
            const stopped = context.check();
            if (stopped) {
                return context.finish(false, {
                    ...stopped,
                    data: {
                        blueprint: plan.name,
                        origin: positionData(plan.origin),
                        orientation: plan.orientation,
                        progress: buildProgress(plan, placed, alreadyCorrect),
                        checkpoint: { origin: positionData(plan.origin), orientation, completedKeys: [...completedKeys] },
                    },
                });
            }

            if (currentLayer !== null && entry.local.y !== currentLayer) {
                onProgress?.({
                    type: 'layer_complete',
                    layer: currentLayer,
                    ...buildProgress(plan, placed, alreadyCorrect),
                });
            }
            currentLayer = entry.local.y;
            const key = positionKey(entry.position);
            const before = bot.blockAt(entry.position);
            if (satisfies(entry, before, dependencies.blockSatisfied)) {
                alreadyCorrect++;
                completedKeys.add(key);
                onCheckpoint?.({
                    origin: positionData(plan.origin),
                    orientation: plan.orientation,
                    currentLayer,
                    completedKeys: [...completedKeys],
                }, buildProgress(plan, placed, alreadyCorrect));
                continue;
            }
            if (!isReplaceable(before)) {
                const progress = buildProgress(plan, placed, alreadyCorrect, 1);
                return context.finish(false, {
                    reason: FailureReason.BLOCKED,
                    message: `${before?.name ?? 'unloaded'} blocks placement at ${key}.`,
                    data: { placement: key, expected: entry.raw, progress },
                });
            }

            const reachable = await ensureReachable(bot, context, entry, dependencies, { navigation });
            if (reachable?.success === false) {
                return context.finish(false, {
                    ...reachable,
                    data: {
                        ...reachable.data,
                        placement: key,
                        progress: buildProgress(plan, placed, alreadyCorrect, 1),
                    },
                });
            }

            const placement = await retryBounded(context, async () => {
                const refreshed = bot.blockAt(entry.position);
                if (satisfies(entry, refreshed, dependencies.blockSatisfied))
                    return taskResult(true, { message: 'Block became correct before placement.' });
                if (!isReplaceable(refreshed)) {
                    return taskResult(false, {
                        reason: FailureReason.BLOCKED,
                        message: `${refreshed?.name ?? 'unloaded'} blocks placement at ${key}.`,
                    });
                }
                const action = await context.phase('place_block', () => dependencies.placeBlock(
                    bot,
                    entry.block,
                    entry.position.x,
                    entry.position.y,
                    entry.position.z,
                    placementSide(entry),
                    true,
                ), {
                    timeoutMs: Math.min(10000, context.remainingMs()),
                    onStop: () => bot.pathfinder?.stop(),
                });
                if (action?.success === false) return action;
                const verified = await context.phase('verify_block', () =>
                    satisfies(entry, bot.blockAt(entry.position), dependencies.blockSatisfied), {
                    timeoutMs: Math.min(2500, context.remainingMs()),
                });
                if (verified?.success === false) return verified;
                return verified
                    ? taskResult(true, { message: `Verified ${entry.block} at ${key}.` })
                    : taskResult(false, {
                        reason: FailureReason.NO_PROGRESS,
                        message: `Placement at ${key} did not match ${entry.block}.`,
                    });
            }, { attempts: maxAttempts });

            if (!placement.success) {
                return context.finish(false, {
                    ...placement,
                    data: {
                        placement: key,
                        expected: entry.block,
                        progress: buildProgress(plan, placed, alreadyCorrect, 1),
                        checkpoint: { origin: positionData(plan.origin), orientation, completedKeys: [...completedKeys] },
                    },
                });
            }
            placed++;
            completedKeys.add(key);
            onCheckpoint?.({
                origin: positionData(plan.origin),
                orientation: plan.orientation,
                currentLayer,
                completedKeys: [...completedKeys],
            }, buildProgress(plan, placed, alreadyCorrect));
        }

        if (currentLayer !== null) {
            onProgress?.({
                type: 'layer_complete',
                layer: currentLayer,
                ...buildProgress(plan, placed, alreadyCorrect),
            });
        }
        const mismatches = await context.phase('final_verify', () => plan.entries
            .filter(entry => !satisfies(entry, bot.blockAt(entry.position), dependencies.blockSatisfied))
            .slice(0, 16)
            .map(entry => ({
                position: positionData(entry.position),
                expected: entry.raw,
                actual: bot.blockAt(entry.position)?.name ?? 'unloaded',
            })), { timeoutMs: Math.min(10000, context.remainingMs()) });
        if (mismatches?.success === false) return context.finish(false, mismatches);
        if (mismatches.length > 0) {
            return context.finish(false, {
                reason: FailureReason.NO_PROGRESS,
                message: `${mismatches.length} blueprint cells failed final verification.`,
                data: { mismatches, progress: buildProgress(plan, placed, alreadyCorrect) },
            });
        }

        const progress = buildProgress(plan, placed, alreadyCorrect);
        return context.finish(true, {
            message: `Built ${plan.name}: ${progress.completed}/${progress.total} blocks verified across ${plan.size.y} layers.`,
            data: {
                blueprint: plan.name,
                origin: positionData(plan.origin),
                orientation: plan.orientation,
                requirements: preflight.data.requirements,
                progress,
                checkpoint: { origin: positionData(plan.origin), orientation, completedKeys: [...completedKeys] },
            },
        });
    } catch (error) {
        bot.pathfinder?.stop();
        return context.finish(false, {
            reason: FailureReason.ACTION_FAILED,
            message: `Blueprint build failed: ${error.message ?? String(error)}`,
        });
    }
}

export function buildNamedBlueprint(bot, name, options = {}, dependencyOverrides = {}) {
    let blueprint;
    try {
        blueprint = loadBlueprint(name);
    } catch (error) {
        return taskResult(false, {
            reason: FailureReason.INVALID_INPUT,
            message: error.message,
        });
    }
    return buildBlueprint(bot, blueprint, options, dependencyOverrides);
}

export function formatBlueprintProgress(progress) {
    if (progress.type === 'preflight_complete') {
        const materials = Object.entries(progress.requirements ?? {})
            .map(([name, count]) => `${count} ${name}`)
            .join(', ');
        return `Blueprint preflight passed at ${progress.origin.x},${progress.origin.y},${progress.origin.z}; ` +
            `orientation=${progress.orientation}; materials=${materials || 'none'}.`;
    }
    return `Blueprint layer ${progress.layer} complete: ${progress.completed}/${progress.total} verified, ` +
        `${progress.remaining} remaining.`;
}