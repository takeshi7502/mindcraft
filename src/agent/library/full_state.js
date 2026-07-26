import { 
    getPosition,
    getBiomeName,
    getNearbyPlayerNames,
    getInventoryCounts,
    getNearbyEntityTypes,
    getBlockAtPosition,
    getFirstBlockAboveHead
} from "./world.js";
import convoManager from '../conversation.js';

// Resolve an enchantment id (number or 'minecraft:sharpness') to a readable name/displayName.
function resolveEnchant(bot, id, level) {
    let key = id;
    let displayName = null;
    try {
        const reg = bot.registry?.enchantments;
        if (reg) {
            if (typeof id === 'number' && reg[id]) {
                key = reg[id].name;
                displayName = reg[id].displayName;
            } else if (typeof id === 'string') {
                const short = id.replace('minecraft:', '');
                const found = Object.values(reg).find(e => e.name === short);
                key = short;
                displayName = found ? found.displayName : short;
            }
        }
    } catch (e) { /* registry may be missing */ }
    if (!displayName) displayName = String(key).replace('minecraft:', '').replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    return { name: String(key).replace('minecraft:', ''), displayName, level };
}

// Read component data from a prismarine-item on MC 1.20.5+ (components) with NBT fallback.
function getComponent(item, type) {
    // item.components can be an array of { type, data } or a Map-like structure depending on version.
    const comps = item.components;
    if (!comps) return undefined;
    if (Array.isArray(comps)) {
        const c = comps.find(c => c && (c.type === type || c.type === 'minecraft:' + type));
        return c ? c.data : undefined;
    }
    if (typeof comps.get === 'function') {
        return comps.get(type) ?? comps.get('minecraft:' + type);
    }
    return comps[type] ?? comps['minecraft:' + type];
}

// Build an in-game-like description of a single inventory item.
function describeItem(bot, item) {
    if (!item) return null;
    const detail = {
        name: item.name,
        displayName: item.displayName,
        count: item.count,
        slot: item.slot,
        durability: null,
        enchants: [],
        storedEnchants: [],
        potion: null,
        customName: null,
        lore: null,
    };

    // --- Durability ---
    try {
        if (item.maxDurability && item.maxDurability > 0) {
            const used = item.durabilityUsed ?? 0;
            detail.durability = { current: Math.max(0, item.maxDurability - used), max: item.maxDurability };
        }
    } catch (e) { /* ignore */ }

    // --- Enchantments applied to the item (weapons/armor/tools) ---
    try {
        if (Array.isArray(item.enchants) && item.enchants.length) {
            detail.enchants = item.enchants.map(e => resolveEnchant(bot, e.name ?? e.id, e.lvl ?? e.level));
        }
    } catch (e) { /* ignore */ }

    // --- Components (MC 1.20.5+, incl. Paper 1.21.x) ---
    try {
        const ench = getComponent(item, 'enchantments');
        if (ench && detail.enchants.length === 0) {
            const levels = ench.levels ?? ench;
            if (levels) {
                for (const [id, lvl] of Object.entries(levels)) {
                    detail.enchants.push(resolveEnchant(bot, isNaN(Number(id)) ? id : Number(id), lvl));
                }
            }
        }
        const stored = getComponent(item, 'stored_enchantments');
        if (stored) {
            const levels = stored.levels ?? stored;
            for (const [id, lvl] of Object.entries(levels)) {
                detail.storedEnchants.push(resolveEnchant(bot, isNaN(Number(id)) ? id : Number(id), lvl));
            }
        }
        const potion = getComponent(item, 'potion_contents');
        if (potion) {
            const pid = potion.potion ?? potion.potionId ?? potion;
            if (typeof pid === 'string') detail.potion = pid.replace('minecraft:', '');
        }
        const custom = getComponent(item, 'custom_name');
        if (custom) {
            detail.customName = typeof custom === 'string' ? custom : (custom.text ?? JSON.stringify(custom));
        }
        const lore = getComponent(item, 'lore');
        if (Array.isArray(lore) && lore.length) {
            detail.lore = lore.map(l => (typeof l === 'string' ? l : (l.text ?? ''))).filter(Boolean);
        }
    } catch (e) { /* ignore component parse errors */ }

    // --- Legacy NBT fallback (older servers) ---
    try {
        const nbt = item.nbt && item.nbt.value;
        if (nbt) {
            if (detail.storedEnchants.length === 0 && nbt.StoredEnchantments) {
                detail.storedEnchants = nbt.StoredEnchantments.value.value.map(e =>
                    resolveEnchant(bot, e.id.value, e.lvl.value));
            }
            if (detail.enchants.length === 0 && nbt.ench) {
                detail.enchants = nbt.ench.value.value.map(e => resolveEnchant(bot, e.id.value, e.lvl.value));
            }
            if (!detail.potion && nbt.Potion) {
                detail.potion = String(nbt.Potion.value).replace('minecraft:', '');
            }
            if (!detail.customName && nbt.display && nbt.display.value && nbt.display.value.Name) {
                let raw = nbt.display.value.Name.value;
                try { raw = JSON.parse(raw).text ?? raw; } catch (e) { /* plain */ }
                detail.customName = raw;
            }
        }
    } catch (e) { /* ignore */ }

    return detail;
}

export function getFullState(agent) {
    const bot = agent.bot;

    const pos = getPosition(bot);
    const position = pos ? {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2))
    } : null;

    let weather = 'Clear';
    if (bot.thunderState > 0) weather = 'Thunderstorm';
    else if (bot.rainState > 0) weather = 'Rain';

    let timeLabel = 'Night';
    if (bot.time.timeOfDay < 6000) timeLabel = 'Morning';
    else if (bot.time.timeOfDay < 12000) timeLabel = 'Afternoon';

    const below = getBlockAtPosition(bot, 0, -1, 0).name;
    const legs = getBlockAtPosition(bot, 0, 0, 0).name;
    const head = getBlockAtPosition(bot, 0, 1, 0).name;

    let players = getNearbyPlayerNames(bot);
    let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
    players = players.filter(p => !bots.includes(p));

    const helmet = bot.inventory.slots[5];
    const chestplate = bot.inventory.slots[6];
    const leggings = bot.inventory.slots[7];
    const boots = bot.inventory.slots[8];
    const offhand = bot.inventory.slots[45]; // off-hand slot

    // Richer activity than a bare "Idle": a bot counts as idle (no action executing) even while
    // chatting, deciding its next move, or stopped. Surface those so the dashboard is meaningful.
    let activity;
    if (!agent.isIdle()) {
        activity = { current: agent.actions.currentActionLabel || 'Acting', kind: 'acting' };
    } else if (convoManager.inConversation()) {
        const who = convoManager.activeConversation?.name;
        activity = { current: who ? `Chatting with ${who}` : 'Chatting', kind: 'chatting' };
    } else if (agent.self_prompter.isStopped()) {
        activity = { current: 'Stopped', kind: 'stopped' };   // self-prompter OFF: won't act on its own
    } else if (agent.self_prompter.isPaused()) {
        activity = { current: 'Chatting', kind: 'chatting' };
    } else if (agent.self_prompter.isActive()) {
        activity = { current: 'Thinking', kind: 'thinking' }; // self-prompting between actions
    } else {
        activity = { current: 'Idle', kind: 'idle' };
    }

    const state = {
        name: agent.name,
        gameplay: {
            position,
            dimension: bot.game.dimension,
            gamemode: bot.game.gameMode,
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            biome: getBiomeName(bot),
            weather,
            timeOfDay: bot.time.timeOfDay,
            timeLabel
        },
        action: {
            current: activity.current,
            kind: activity.kind,
            isIdle: agent.isIdle()
        },
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: getFirstBlockAboveHead(bot, null, 32)
        },
        inventory: {
            counts: getInventoryCounts(bot),
            stacksUsed: bot.inventory.items().length,
            totalSlots: bot.inventory.slots.length,
            // Full per-stack detail so the UI can show in-game-like tooltips.
            items: bot.inventory.items().map(i => describeItem(bot, i)),
            equipment: {
                helmet: helmet ? helmet.name : null,
                chestplate: chestplate ? chestplate.name : null,
                leggings: leggings ? leggings.name : null,
                boots: boots ? boots.name : null,
                mainHand: bot.heldItem ? bot.heldItem.name : null,
                offHand: offhand ? offhand.name : null,
                // Detailed versions (durability/enchants) for each equipped slot.
                helmetDetail: describeItem(bot, helmet),
                chestplateDetail: describeItem(bot, chestplate),
                leggingsDetail: describeItem(bot, leggings),
                bootsDetail: describeItem(bot, boots),
                mainHandDetail: describeItem(bot, bot.heldItem),
                offHandDetail: describeItem(bot, offhand)
            }
        },
        nearby: {
            humanPlayers: players,
            botPlayers: bots,
            entityTypes: getNearbyEntityTypes(bot).filter(t => t !== 'player' && t !== 'item'),
        },
        modes: {
            summary: bot.modes.getMiniDocs()
        }
    };

    return state;
}