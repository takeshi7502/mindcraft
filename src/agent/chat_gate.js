function normalizeName(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/^@/, '');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function invocationPattern(name) {
    if (!name) return null;
    return new RegExp(
        `^\\s*@?\\s*(?<name>${escapeRegExp(name)})(?![\\p{L}\\p{N}_])` +
        String.raw`(?=$|[\s,.:;!?/()-])`,
        'iu',
    );
}

function stripInvocationDelimiter(message) {
    let request = message.trim();
    if (request.startsWith('(') && request.endsWith(')'))
        return request.slice(1, -1).trim();
    request = request.replace(/^[,.:;?/()-]+\s*/, '');
    request = request.replace(/^!+(?:\s+|$)/, '');
    return request.trim();
}

export function resolveChatGateOptions(profile = {}) {
    return {
        botName: normalizeName(profile.name),
    };
}

/**
 * Prepare chat before translation or Agent.handleMessage. Internal callers bypass
 * the gate by leaving inGame=false, preserving system and MindServer control paths.
 */
export function prepareIncomingChat(message, {
    inGame = false,
    botName = '',
} = {}) {
    if (typeof message !== 'string' || message.length === 0) {
        return { accepted: false, invoked: false, message: '' };
    }
    if (!inGame) {
        return { accepted: true, invoked: false, message };
    }

    const pattern = invocationPattern(normalizeName(botName));
    const match = pattern?.exec(message);
    if (!match) {
        return { accepted: false, invoked: false, message: '' };
    }

    const request = stripInvocationDelimiter(message.slice(match[0].length));
    return {
        accepted: request.length > 0,
        invoked: true,
        matchedName: match.groups?.name ?? null,
        message: request,
    };
}
