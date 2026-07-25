const TPA_REQUEST_PATTERNS = [
    /(?:has requested|wants) to teleport to you/i,
    /type\s+\/tpaccept/i,
    /teleport request (?:from|by)\s+([A-Za-z0-9_]{1,16})/i,
    /([A-Za-z0-9_]{1,16})\s+(?:has requested|wants).*teleport/i,
];
const PLAYER_NAME = /^\.?[A-Za-z0-9_]{1,16}$/;
const ACCEPT_COOLDOWN_MS = 3000;
const DIRECT_TPA_KEYWORDS = /(?:^|\s)(?:tp|tpa|teleport)(?:\s|$)/i;
const DIRECT_TPA_SELF_TARGET = /(?:tôi|toi|me|here|đây|day)/i;
const DIRECT_TPA_NAMED_TARGET = /(?:đến|toi|tới|to)\s+(\.?[A-Za-z0-9_]{1,16})/i;

function normalizePlayerName(bot, playerName) {
    const raw = String(playerName ?? '').trim();
    const cleaned = raw.replace(/^[^A-Za-z0-9_.]+/, '');
    if (!cleaned) return null;
    const onlineNames = Object.keys(bot.players ?? {});
    const exact = onlineNames.find(name => name.toLowerCase() === cleaned.toLowerCase());
    if (exact) return exact;
    const withoutDot = cleaned.startsWith('.') ? cleaned.slice(1) : cleaned;
    const exactWithoutDot = onlineNames.find(name =>
        name.replace(/^\./, '').toLowerCase() === withoutDot.toLowerCase());
    if (exactWithoutDot) return exactWithoutDot;
    const prefix = onlineNames.find(name =>
        name.replace(/^\./, '').toLowerCase().startsWith(withoutDot.toLowerCase()));
    if (prefix) return prefix;
    return PLAYER_NAME.test(cleaned) ? cleaned : null;
}

export function requestTpaToPlayer(bot, playerName) {
    const normalized = normalizePlayerName(bot, playerName);
    if (!normalized) return false;
    bot.chat(`/tpa ${normalized}`);
    return true;
}

export function getDirectTpaTarget(message, source) {
    const normalized = String(message ?? '').trim().toLowerCase();
    if (!DIRECT_TPA_KEYWORDS.test(normalized)) return null;
    if (DIRECT_TPA_SELF_TARGET.test(normalized)) return source;
    const named = DIRECT_TPA_NAMED_TARGET.exec(String(message ?? ''))?.[1];
    if (named) return named;
    return null;
}

export function isDirectTpaRequest(message) {
    return getDirectTpaTarget(message, 'self') !== null;
}

export function acceptTpa(bot) {
    bot.chat('/tpaccept');
    return true;
}

export function parseTpaRequest(message) {
    if (!message || /[;\n\r]/.test(message)) return { detected: false };
    for (const pattern of TPA_REQUEST_PATTERNS) {
        const match = pattern.exec(message);
        if (!match) continue;
        const requester = match[1];
        if (requester && !PLAYER_NAME.test(requester)) return { detected: false };
        return { detected: true, requester: requester ?? null };
    }
    return { detected: false };
}

export function maybeAutoAcceptTpa(bot, message, { now = Date.now() } = {}) {
    const parsed = parseTpaRequest(message);
    if (!parsed.detected) return false;
    if (bot.lastTpaAcceptAt && now - bot.lastTpaAcceptAt < ACCEPT_COOLDOWN_MS) return false;
    bot.lastTpaAcceptAt = now;
    return acceptTpa(bot);
}
