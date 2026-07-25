import * as mc from '../../utils/mcdata.js';

const DEFAULT_TTL_MS = 15000;
const DAMAGE_CORRELATION_MS = 500;
const DEFAULT_PLAYER_POLICY = Object.freeze({
    enabled: true,
    windowMs: 8000,
    warningHitCount: 2,
    lethalHitCount: 3,
    duplicateEventMs: 100,
});
export const PlayerResponseLevel = Object.freeze({
    NONE: 'none',
    WARNING_STRIKE: 'warning_strike',
    LETHAL: 'lethal',
});
const NON_COMBAT_TYPES = new Set([
    'object', 'orb', 'global', 'item', 'projectile', 'other',
]);
const PROJECTILE_NAMES = new Set([
    'arrow', 'spectral_arrow', 'trident', 'fireball', 'small_fireball',
    'dragon_fireball', 'wither_skull', 'snowball', 'egg', 'llama_spit',
]);

function entityId(entity) {
    return entity?.id ?? entity?.entityId ?? null;
}

function isTracked(bot, entity) {
    const id = entityId(entity);
    if (id == null) return false;
    return bot.entities?.[id] === entity || bot.entities?.[String(id)] === entity;
}

export function isCombatEntity(bot, entity) {
    if (!entity || entity === bot.entity || entity.isValid === false || !entity.name)
        return false;
    if (PROJECTILE_NAMES.has(entity.name) || NON_COMBAT_TYPES.has(entity.type))
        return false;
    return entity.type === 'mob' || entity.type === 'hostile' ||
        entity.type === 'player' || Boolean(entity.username);
}

function resolveOwner(bot, source) {
    const owner = source?.owner ?? source?.shooter;
    if (isCombatEntity(bot, owner)) return owner;
    const ownerId = source?.ownerId ?? source?.shooterId ?? source?.ownerEntityId;
    if (ownerId != null) {
        const entity = bot.entities?.[ownerId] ?? bot.entities?.[String(ownerId)];
        if (isCombatEntity(bot, entity)) return entity;
    }
    return null;
}

export function identifyAttacker(bot, source) {
    if (isCombatEntity(bot, source)) return source;
    const owner = resolveOwner(bot, source);
    if (owner) return owner;

    if (!source?.position) return null;
    const candidates = Object.values(bot.entities ?? {})
        .filter(entity => isCombatEntity(bot, entity) && mc.canRetaliateAgainst(entity))
        .sort((left, right) =>
            left.position.distanceTo(source.position) - right.position.distanceTo(source.position));
    return candidates[0]?.position.distanceTo(source.position) <= 6 ? candidates[0] : null;
}

export function createDamageCorrelator() {
    return { pendingSources: [], pendingDamage: [], nextId: 1 };
}

function pruneDamageCorrelator(state, now, windowMs) {
    state.pendingSources = state.pendingSources.filter(event => now - event.timestamp <= windowMs);
    state.pendingDamage = state.pendingDamage.filter(event => now - event.timestamp <= windowMs);
}

function consumeCorrelatedDamage(state) {
    if (state.pendingSources.length === 0 || state.pendingDamage.length === 0) return null;
    const sourceEvent = state.pendingSources.shift();
    const damageEvent = state.pendingDamage.shift();
    return {
        id: state.nextId++,
        source: sourceEvent.source,
        damage: damageEvent.damage,
        timestamp: Math.max(sourceEvent.timestamp, damageEvent.timestamp),
    };
}

export function recordHurtSource(state, source, {
    now = Date.now(),
    windowMs = DAMAGE_CORRELATION_MS,
} = {}) {
    pruneDamageCorrelator(state, now, windowMs);
    state.pendingSources.push({ source, timestamp: now });
    return consumeCorrelatedDamage(state);
}

export function recordHealthLoss(state, damage, {
    now = Date.now(),
    windowMs = DAMAGE_CORRELATION_MS,
} = {}) {
    pruneDamageCorrelator(state, now, windowMs);
    if (!Number.isFinite(damage) || damage <= 0) return null;
    state.pendingDamage.push({ damage, timestamp: now });
    return consumeCorrelatedDamage(state);
}

export function clearDamageCorrelator(state) {
    state.pendingSources = [];
    state.pendingDamage = [];
}

function isPlayer(entity) {
    return entity?.type === 'player' || Boolean(entity?.username);
}

function playerKey(entity) {
    return entity?.uuid ?? entity?.username ?? String(entityId(entity));
}

function normalizePlayerPolicy(policy = {}) {
    const numberOr = (value, fallback) => Number.isFinite(value) && value > 0
        ? value
        : fallback;
    const warningHitCount = Math.floor(numberOr(
        policy.warningHitCount,
        DEFAULT_PLAYER_POLICY.warningHitCount,
    ));
    const lethalHitCount = Math.max(
        warningHitCount + 1,
        Math.floor(numberOr(policy.lethalHitCount, DEFAULT_PLAYER_POLICY.lethalHitCount)),
    );
    return {
        enabled: policy.enabled !== false,
        windowMs: numberOr(policy.windowMs, DEFAULT_PLAYER_POLICY.windowMs),
        warningHitCount,
        lethalHitCount,
        duplicateEventMs: numberOr(
            policy.duplicateEventMs,
            DEFAULT_PLAYER_POLICY.duplicateEventMs,
        ),
    };
}

function getPlayerHistory(bot) {
    if (!(bot.playerRetaliationHistory instanceof Map))
        bot.playerRetaliationHistory = new Map();
    return bot.playerRetaliationHistory;
}

export function recordPlayerAttack(bot, player, {
    now = Date.now(),
    policy = {},
} = {}) {
    const resolved = normalizePlayerPolicy(policy);
    if (!resolved.enabled || !isPlayer(player))
        return { level: PlayerResponseLevel.NONE, hitCount: 0, player };

    const history = getPlayerHistory(bot);
    const key = playerKey(player);
    const previous = history.get(key);
    if (previous && now - previous.lastEventAt < resolved.duplicateEventMs)
        return { level: PlayerResponseLevel.NONE, hitCount: previous.hitCount, player, duplicate: true };
    const inWindow = previous && now - previous.lastHitAt <= resolved.windowMs;
    const hitCount = inWindow ? previous.hitCount + 1 : 1;
    const record = { hitCount, lastHitAt: now, lastEventAt: now, entityId: entityId(player) };
    history.set(key, record);

    let level = PlayerResponseLevel.NONE;
    if (hitCount >= resolved.lethalHitCount)
        level = PlayerResponseLevel.LETHAL;
    else if (hitCount === resolved.warningHitCount && previous?.warnedAt !== now) {
        level = PlayerResponseLevel.WARNING_STRIKE;
        record.warnedAt = now;
    }
    return { level, hitCount, player, key };
}

export function rememberAttacker(bot, source, { now = Date.now(), playerPolicy = {} } = {}) {
    const attacker = identifyAttacker(bot, source);
    if (!attacker || !mc.canRetaliateAgainst(attacker))
        return { level: PlayerResponseLevel.NONE, attacker: null, hitCount: 0 };
    if (isPlayer(attacker)) {
        const response = recordPlayerAttack(bot, attacker, { now, policy: playerPolicy });
        if (response.level === PlayerResponseLevel.WARNING_STRIKE) {
            bot.playerWarningStrike = { entityId: entityId(attacker), timestamp: now };
        } else if (response.level === PlayerResponseLevel.LETHAL) {
            bot.playerWarningStrike = null;
            bot.retaliationTarget = { entityId: entityId(attacker), timestamp: now };
        }
        return { ...response, attacker };
    }
    bot.retaliationTarget = { entityId: entityId(attacker), timestamp: now };
    return { level: PlayerResponseLevel.LETHAL, attacker, hitCount: 1 };
}

export function getRecentAttacker(bot, {
    now = Date.now(),
    ttlMs = DEFAULT_TTL_MS,
} = {}) {
    const remembered = bot.retaliationTarget;
    if (!remembered || now - remembered.timestamp > ttlMs) {
        bot.retaliationTarget = null;
        return null;
    }
    const attacker = bot.entities?.[remembered.entityId] ??
        bot.entities?.[String(remembered.entityId)];
    if (!isTracked(bot, attacker) || !isCombatEntity(bot, attacker) ||
        !mc.canRetaliateAgainst(attacker)) {
        bot.retaliationTarget = null;
        return null;
    }
    return attacker;
}

export function consumeWarningStrike(bot, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    const warning = bot.playerWarningStrike;
    bot.playerWarningStrike = null;
    if (!warning || now - warning.timestamp > ttlMs) return null;
    const player = bot.entities?.[warning.entityId] ?? bot.entities?.[String(warning.entityId)];
    return isTracked(bot, player) && isCombatEntity(bot, player) ? player : null;
}

export function clearPlayerCombatState(bot, player = null) {
    if (!player) {
        bot.playerRetaliationHistory = new Map();
        bot.playerWarningStrike = null;
        return;
    }
    bot.playerRetaliationHistory?.delete(playerKey(player));
    if (bot.playerWarningStrike?.entityId === entityId(player))
        bot.playerWarningStrike = null;
}

export function clearAttacker(bot, entity = null) {
    if (!bot.retaliationTarget) return;
    if (!entity || bot.retaliationTarget.entityId === entityId(entity))
        bot.retaliationTarget = null;
}

export { DAMAGE_CORRELATION_MS };
export { DEFAULT_PLAYER_POLICY as PLAYER_RETALIATION_DEFAULTS };
export { DEFAULT_TTL_MS as RETALIATION_TTL_MS };
