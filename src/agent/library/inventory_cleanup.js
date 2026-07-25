import * as world from './world.js';
import { goToPosition } from './skills.js';

const KEEP_EXACT = new Set(['water_bucket','bucket','shield','bow','crossbow','arrow','torch','crafting_table','furnace','chest','bed','bread','cooked_beef','cooked_porkchop','cooked_chicken','golden_apple']);
const KEEP_PARTIAL = ['sword','pickaxe','axe','shovel','hoe','helmet','chestplate','leggings','boots','map','compass'];
const JUNK_EXACT = new Set(['rotten_flesh','poisonous_potato','spider_eye','bone','string','egg','feather']);
const JUNK_PARTIAL = ['flower','tulip','sapling','seed','bush'];
const COMMON_CAPS = new Map([['dirt',64],['cobblestone',128],['gravel',32],['sand',64],['oak_planks',128],['oak_log',64]]);

function isKeep(name) { return KEEP_EXACT.has(name) || KEEP_PARTIAL.some(part => name.includes(part)); }
function isJunk(name) { return JUNK_EXACT.has(name) || JUNK_PARTIAL.some(part => name.includes(part)); }
function inventoryItems(bot) { return bot.inventory.items?.() ?? bot.inventory.slots.filter(Boolean); }

export function planInventoryCleanup(bot, { targetFreeSlots = 3 } = {}) {
    const empty = bot.inventory.emptySlotCount?.() ?? 0;
    if (empty >= targetFreeSlots) return { needed: false, actions: [] };
    const actions = [];
    const seen = new Map();
    for (const item of inventoryItems(bot)) {
        const current = seen.get(item.name) ?? 0;
        seen.set(item.name, current + item.count);
        if (isKeep(item.name)) continue;
        if (isJunk(item.name)) actions.push({ itemName: item.name, count: item.count, reason: 'junk' });
        else if (COMMON_CAPS.has(item.name)) {
            const cap = COMMON_CAPS.get(item.name);
            const overflow = Math.max(0, current + item.count - cap);
            if (overflow > 0) actions.push({ itemName: item.name, count: Math.min(overflow, item.count), reason: 'overflow' });
        }
        else actions.push({ itemName: item.name, count: item.count, reason: 'nonessential' });
    }
    return { needed: true, actions };
}

async function depositItems(bot, actions) {
    const chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) return { deposited: 0, usedChest: false };
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const container = await bot.openContainer(chest);
    let deposited = 0;
    try {
        for (const action of actions) {
            let remaining = action.count;
            while (remaining > 0) {
                const item = bot.inventory.findInventoryItem(action.itemName);
                if (!item) break;
                const amount = Math.min(remaining, item.count);
                await container.deposit(item.type, null, amount);
                deposited += amount;
                remaining -= amount;
            }
        }
    } finally {
        await container.close();
    }
    return { deposited, usedChest: true };
}

async function discardItems(bot, actions, targetFreeSlots) {
    let discarded = 0;
    for (const action of actions) {
        let remaining = action.count;
        while (remaining > 0 && (bot.inventory.emptySlotCount?.() ?? 0) < targetFreeSlots) {
            const item = bot.inventory.findInventoryItem(action.itemName);
            if (!item) break;
            const amount = Math.min(remaining, item.count);
            await bot.toss(item.type, null, amount);
            discarded += amount;
            remaining -= amount;
        }
        if ((bot.inventory.emptySlotCount?.() ?? 0) >= targetFreeSlots) break;
    }
    if (discarded > 0 && bot.entity?.position) {
        try {
            const { moveAway } = await import('./skills.js');
            await moveAway(bot, 4);
        } catch (_) { /* best-effort: avoid immediately re-picking discarded items */ }
    }
    return discarded;
}

export async function cleanupInventory(bot, options = {}) {
    const targetFreeSlots = options.targetFreeSlots ?? 3;
    const plan = planInventoryCleanup(bot, { targetFreeSlots });
    if (!plan.needed) return { success: true, deposited: 0, discarded: 0, message: 'Inventory has enough free slots.' };
    if (plan.actions.length === 0) return { success: false, deposited: 0, discarded: 0, message: 'No safe cleanup candidates.' };
    let deposited = 0;
    try { ({ deposited } = await depositItems(bot, plan.actions)); } catch (_) { deposited = 0; }
    const discarded = (bot.inventory.emptySlotCount?.() ?? 0) < targetFreeSlots
        ? await discardItems(bot, plan.actions, targetFreeSlots) : 0;
    const success = (bot.inventory.emptySlotCount?.() ?? 0) >= targetFreeSlots;
    return {
        success,
        deposited,
        discarded,
        planned: plan.actions,
        message: success ? 'Inventory cleanup completed.' : 'Inventory cleanup could not free enough slots.',
    };
}
