const PASSABLE = new Set([
    'air',
    'cave_air',
    'void_air',
    'short_grass',
    'tall_grass',
    'fern',
    'large_fern',
    'snow',
]);
const LIQUIDS = new Set(['water', 'lava', 'bubble_column']);
const HAZARDS = new Set([
    'lava',
    'fire',
    'soul_fire',
    'cactus',
    'magma_block',
    'sweet_berry_bush',
    'powder_snow',
    'campfire',
    'soul_campfire',
]);
const HORIZONTAL_OFFSETS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
];

function clampInteger(value, minimum, maximum) {
    const number = Number.isFinite(value) ? Math.floor(value) : minimum;
    return Math.min(Math.max(number, minimum), maximum);
}

function isPassableSpace(block) {
    if (!block || LIQUIDS.has(block.name) || HAZARDS.has(block.name)) return false;
    return PASSABLE.has(block.name) || block.boundingBox === 'empty';
}

function blockIsSolidFloor(block) {
    return Boolean(
        block &&
        block.boundingBox !== 'empty' &&
        !LIQUIDS.has(block.name) &&
        !HAZARDS.has(block.name)
    );
}

export function isSafeStandingPosition(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const floor = bot.blockAt(position.offset(0, -1, 0));
    if (!isPassableSpace(feet) || !isPassableSpace(head) || !blockIsSolidFloor(floor))
        return false;

    return !HORIZONTAL_OFFSETS.slice(0, 4).some(([dx, dz]) => {
        const besideFeet = bot.blockAt(position.offset(dx, 0, dz));
        const besideFloor = bot.blockAt(position.offset(dx, -1, dz));
        return HAZARDS.has(besideFeet?.name) || HAZARDS.has(besideFloor?.name);
    });
}

export function isFishableWater(bot, block) {
    if (!block || block.name !== 'water') return false;
    const above = bot.blockAt(block.position.offset(0, 1, 0));
    return isPassableSpace(above);
}

/**
 * Scan only loaded blocks within a hard-capped task radius and result count.
 */
export function observeNearbyBlocks(bot, {
    names,
    predicate = null,
    maxDistance = 16,
    count = 32,
} = {}) {
    const wanted = new Set(names ?? []);
    const boundedDistance = clampInteger(maxDistance, 1, 32);
    const boundedCount = clampInteger(count, 1, 128);
    const positions = bot.findBlocks({
        matching: block =>
            Boolean(block) &&
            (wanted.size === 0 || wanted.has(block.name)) &&
            (!predicate || predicate(block)),
        maxDistance: boundedDistance,
        count: boundedCount,
    }) ?? [];

    return positions
        .slice(0, boundedCount)
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position));
}

export function findSafeAdjacentPositions(bot, target, {
    maxCandidates = 8,
    verticalOffsets = [0],
} = {}) {
    const candidates = [];
    const seen = new Set();
    const boundedCandidates = clampInteger(maxCandidates, 1, 24);

    for (const dy of verticalOffsets.slice(0, 3)) {
        for (const [dx, dz] of HORIZONTAL_OFFSETS) {
            const position = target.position.offset(dx, dy, dz);
            const key = `${position.x},${position.y},${position.z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (isSafeStandingPosition(bot, position)) candidates.push(position);
            if (candidates.length >= boundedCandidates) break;
        }
        if (candidates.length >= boundedCandidates) break;
    }

    return candidates.sort((a, b) =>
        a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
}

function pathIsNonDestructive(path) {
    return (path.path ?? []).every(node =>
        (node.toBreak?.length ?? 0) === 0 &&
        (node.toPlace ?? []).every(action => action.useOne === true));
}

async function createPathingObjects(bot, position, options) {
    if (options.createMovements && options.createGoal) {
        return {
            movements: options.createMovements(bot),
            goal: options.createGoal(position),
        };
    }

    const imported = await import('mineflayer-pathfinder');
    const pathfinder = imported.default ?? imported;
    return {
        movements: new pathfinder.Movements(bot),
        goal: new pathfinder.goals.GoalBlock(position.x, position.y, position.z),
    };
}

/**
 * Find a nearby standing position using a non-destructive path policy.
 */
export async function findReachableAdjacent(bot, target, {
    maxCandidates = 8,
    pathTimeoutMs = 1500,
    verticalOffsets = [0],
    createMovements = null,
    createGoal = null,
} = {}) {
    const candidates = findSafeAdjacentPositions(bot, target, {
        maxCandidates,
        verticalOffsets,
    });

    for (const position of candidates) {
        if (bot.interrupt_code) return null;
        const { movements, goal } = await createPathingObjects(bot, position, {
            createMovements,
            createGoal,
        });
        movements.canDig = false;
        movements.canPlaceOn = false;
        movements.allow1by1towers = false;
        movements.allowParkour = false;
        movements.canOpenDoors = true;

        const path = await bot.pathfinder.getPathTo(
            movements,
            goal,
            clampInteger(pathTimeoutMs, 100, 5000),
        );
        if (path?.status === 'success' && pathIsNonDestructive(path))
            return { position, goal, movements };
    }
    return null;
}

export async function findNearbyTargetWithReachableAdjacent(bot, options = {}) {
    const targets = observeNearbyBlocks(bot, options)
        .slice(0, clampInteger(options.maxTargets ?? 8, 1, 16));
    for (const target of targets) {
        if (bot.interrupt_code) return null;
        const reachable = await findReachableAdjacent(bot, target, options);
        if (reachable) return { target, ...reachable };
    }
    return null;
}
