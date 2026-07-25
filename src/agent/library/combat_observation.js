import pf from 'mineflayer-pathfinder';
import * as mc from '../../utils/mcdata.js';

const DEFAULT_OPTIONS = Object.freeze({
    maxDistance: 16,
    maxVerticalDifference: 4,
    maxCandidates: 6,
    pathTimeoutMs: 150,
});

function nearbyHostiles(bot, options) {
    return Object.values(bot.entities ?? {})
        .filter(entity => entity && entity !== bot.entity && entity.isValid !== false &&
            entity.position && mc.isHostile(entity) &&
            bot.entity.position.distanceTo(entity.position) <= options.maxDistance)
        .sort((left, right) => bot.entity.position.distanceTo(left.position) -
            bot.entity.position.distanceTo(right.position))
        .slice(0, options.maxCandidates);
}

export async function observeProactiveThreat(bot, overrides = {}) {
    const options = { ...DEFAULT_OPTIONS, ...overrides };
    const observations = [];
    for (const entity of nearbyHostiles(bot, options)) {
        const verticalDifference = Math.abs(entity.position.y - bot.entity.position.y);
        if (verticalDifference > options.maxVerticalDifference) {
            observations.push({ entity, reason: 'vertical_separation' });
            continue;
        }
        const movements = overrides.createMovements
            ? overrides.createMovements(bot)
            : new pf.Movements(bot);
        movements.canDig = false;
        movements.canPlaceOn = false;
        movements.canOpenDoors = false;
        movements.allow1by1towers = false;
        movements.allowParkour = false;
        const goal = overrides.createGoal
            ? overrides.createGoal(entity.position)
            : new pf.goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 1);
        let path;
        try {
            path = await bot.pathfinder.getPathTo(movements, goal, options.pathTimeoutMs);
        } catch (error) {
            observations.push({ entity, reason: 'unreachable', error: error.message });
            continue;
        }
        if (path?.status === 'success' && (path.path ?? []).every(node =>
            (node.toBreak?.length ?? 0) === 0 && (node.toPlace?.length ?? 0) === 0)) {
            return { entity, reason: 'reachable', observations };
        }
        observations.push({ entity, reason: 'unreachable' });
    }
    return { entity: null, reason: 'no_reachable_threat', observations };
}

export { DEFAULT_OPTIONS as PROACTIVE_THREAT_DEFAULTS };
