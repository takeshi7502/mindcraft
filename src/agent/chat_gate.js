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
        String.raw`(?<![\p{L}\p{N}_])@?(?<name>${escapeRegExp(name)})(?![\p{L}\p{N}_])`,
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

    const beforeMention = message.slice(0, match.index);
    // Keep a natural sentence intact when the bot is mentioned in its middle or
    // at its end. For a leading invocation, remove the name as before so the
    // model receives the actual request rather than its own name.
    const request = beforeMention.trim().length > 0
        ? message.trim()
        : stripInvocationDelimiter(message.slice(match[0].length));
    // A player may call only the bot's name ("waku" / "@waku"). Treat that
    // as an invocation too, so the bot can answer instead of silently ignoring it.
    const responseMessage = request || message.trim();
    return {
        accepted: responseMessage.length > 0,
        invoked: true,
        matchedName: match.groups?.name ?? null,
        message: responseMessage,
    };
}
