import { AsyncLocalStorage } from 'node:async_hooks';
import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { approachNearbyBlock, fishNearby, formatTaskResult } from '../library/deterministic_tasks.js';
import {
    buildNamedBlueprint,
    formatBlueprintProgress,
    validateNamedBlueprintReconnect,
} from '../library/blueprint_build.js';
import { listBlueprintNames } from '../library/blueprint_catalog.js';
import { acquireMaterials } from '../library/material_acquisition.js';
import { FailureReason, taskResult } from '../library/task_primitives.js';
import { acceptTpa, requestTpaToPlayer } from '../library/teleport_requests.js';
import { cleanupInventory } from '../library/inventory_cleanup.js';

const commandContext = new AsyncLocalStorage();

export function runWithCommandSource(agent, source, operation) {
    const normalizedSource = typeof source === 'string' && source.trim()
        ? source.trim()
        : 'system';
    return commandContext.run({ agent, source: normalizedSource }, operation);
}

function getCommandSource(agent) {
    const context = commandContext.getStore();
    return context?.agent === agent ? context.source : 'system';
}


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

function runDeterministicTask(actionLabel, taskFn, timeout = 2) {
    return async function(agent, ...args) {
        let result;
        const action = await agent.actions.runAction(`action:${actionLabel}`, async () => {
            result = await taskFn(agent, ...args);
            skills.log(agent.bot, formatTaskResult(result));
        }, { timeout });
        if (result) return formatTaskResult(result);
        if (action.interrupted && !action.timedout) return;
        return action.message;
    };
}

function taskOwner(agent) {
    return getCommandSource(agent);
}

function runEmergencyTask(actionLabel, actionFn, timeout = 2) {
    return async function(agent, ...args) {
        if (!agent.taskScheduler)
            return runAsAction(actionFn, false, timeout)(agent, ...args);
        const outcome = await agent.taskScheduler.runEmergencyTask({
            name: `emergency:${actionLabel}`,
            owner: taskOwner(agent),
            target: { arguments: args },
            terminalConditions: ['command_completed'],
        }, async () => {
            await actionFn(agent, ...args);
            return taskResult(true, { message: `${actionLabel} completed.` });
        }, { timeout });
        return formatTaskResult(outcome.status);
    };
}

function runOwnerLockedTask(actionLabel, actionFn, timeout = 10) {
    return async function(agent, ...args) {
        const outcome = await agent.taskScheduler.startLongTask({
            name: `${actionLabel}:${args.join(':')}`,
            owner: taskOwner(agent),
            target: { command: actionLabel, arguments: args },
            terminalConditions: ['command_completed', 'bot_died'],
            checkpoint: { arguments: args },
        }, async (control, record) => {
            const result = await actionFn(agent, ...args);
            const stopped = control.check();
            if (stopped) {
                return taskResult(false, {
                    reason: stopped,
                    message: `${actionLabel} was interrupted.`,
                    complete: false,
                    checkpoint: record.checkpoint,
                    progress: record.progress,
                });
            }
            if (result?.success !== undefined) {
                return {
                    ...result,
                    checkpoint: result.data?.checkpoint ?? record.checkpoint,
                    progress: result.data?.progress ?? record.progress,
                };
            }
            if (result === false) {
                return taskResult(false, {
                    message: `${actionLabel} did not complete.`,
                    checkpoint: record.checkpoint,
                });
            }
            return taskResult(true, {
                message: `${actionLabel} completed.`,
                checkpoint: record.checkpoint,
            });
        }, { timeout });
        return formatTaskResult(outcome.status);
    };
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.taskScheduler?.emergencyStop('emergency_stop');
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!goToNearbyBlockSafely',
        description: 'Find a nearby block and move to a safe adjacent position without digging or placing.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to approach.' },
            'search_range': { type: 'int', description: 'Maximum bounded search range.', domain: [1, 33] },
        },
        perform: async function(agent, type, search_range) {
            const outcome = await agent.taskScheduler.runShortTask({
                name: `approach:${type}`,
                owner: taskOwner(agent),
                target: { block: type, searchRange: search_range },
                terminalConditions: ['command_completed', 'bot_died'],
            }, () => approachNearbyBlock(agent.bot, {
                names: [type],
                searchRadius: search_range,
            }), { timeout: 1 });
            return formatTaskResult(outcome.status);
        }
    },
    {
        name: '!fishNearby',
        description: 'Safely find reachable nearby water and fish with bounded retries. Requires a fishing rod.',
        params: {
            'search_range': { type: 'int', description: 'Maximum nearby water search range.', domain: [4, 33] },
            'attempts': { type: 'int', description: 'Maximum number of casts.', domain: [1, 4] },
        },
        perform: runOwnerLockedTask('fishNearby', async (agent, search_range, attempts) =>
            fishNearby(agent.bot, { searchRadius: search_range, attempts }), 2)
    },
    {
        name: '!buildBlueprint',
        description: `Deterministically build a predefined blueprint. Available: ${listBlueprintNames().join(', ')}.`,
        params: {
            'name': { type: 'string', description: 'Blueprint catalog name.' },
            'orientation': { type: 'int', description: 'Quarter-turn orientation: 0, 1, 2, or 3.', domain: [0, 4] },
        },
        perform: async function(agent, name, orientation) {
            const outcome = await agent.taskScheduler.startLongTask({
                name: `build:${name}`,
                owner: taskOwner(agent),
                target: { blueprint: name, orientation },
                terminalConditions: ['blueprint_verified', 'bot_died'],
                progress: { total: 0, completed: 0, remaining: 0 },
                checkpoint: { orientation, completedKeys: [] },
            }, async (control, record) => {
                let buildCheckpoint = record.checkpoint.build ?? record.checkpoint;
                let acquisitionCheckpoint = record.checkpoint.acquisition ?? {};
                const maxAcquisitionRounds = 8;

                for (let round = 0; round <= maxAcquisitionRounds; round++) {
                    const result = await buildNamedBlueprint(agent.bot, name, {
                        orientation,
                        checkpoint: buildCheckpoint,
                        onCheckpoint: (nextCheckpoint, progress) => {
                            buildCheckpoint = nextCheckpoint;
                            return control.checkpoint({
                                build: buildCheckpoint,
                                acquisition: acquisitionCheckpoint,
                            }, { phase: 'building', ...progress });
                        },
                        onProgress: progress => skills.log(
                            agent.bot,
                            formatBlueprintProgress(progress),
                        ),
                    });
                    if (result.success || result.reason !== FailureReason.MISSING_MATERIALS) {
                        return {
                            ...result,
                            checkpoint: {
                                build: result.data?.checkpoint ?? buildCheckpoint,
                                acquisition: acquisitionCheckpoint,
                            },
                            progress: result.data?.progress ?? control.record.progress,
                        };
                    }

                    buildCheckpoint = {
                        ...buildCheckpoint,
                        origin: result.data.origin ?? buildCheckpoint.origin,
                        orientation: result.data.orientation ?? orientation,
                    };
                    const acquisition = await acquireMaterials(agent.bot, result.data.shortages, {
                        protectedPositions: [
                            ...(result.data.protectedPositions ?? []),
                            ...(agent.npc?.getBuiltPositions?.() ?? []),
                        ],
                        checkpoint: acquisitionCheckpoint,
                        onProgress: progress => {
                            skills.log(agent.bot,
                                `Materials ${progress.phase}: ${JSON.stringify(progress.remaining)}.`);
                            control.checkpoint({
                                build: buildCheckpoint,
                                acquisition: acquisitionCheckpoint,
                            }, { phase: progress.phase, ...progress });
                        },
                    });
                    acquisitionCheckpoint = acquisition.checkpoint ?? acquisitionCheckpoint;
                    control.checkpoint({
                        build: buildCheckpoint,
                        acquisition: acquisitionCheckpoint,
                    }, acquisition.progress);
                    if (!acquisition.success) {
                        return {
                            ...acquisition,
                            data: {
                                ...acquisition.data,
                                blueprint: name,
                                buildCheckpoint,
                            },
                            checkpoint: {
                                build: buildCheckpoint,
                                acquisition: acquisitionCheckpoint,
                            },
                        };
                    }
                }

                return taskResult(false, {
                    reason: FailureReason.MISSING_MATERIALS,
                    message: 'Material acquisition round limit reached.',
                    checkpoint: { build: buildCheckpoint, acquisition: acquisitionCheckpoint },
                    progress: { phase: 'waiting_materials' },
                    complete: false,
                });
            }, {
                timeout: 20,
                reconnectCheck: (record, { previousContext, currentContext }) => {
                    if (agent.bot.health <= 0) {
                        return {
                            eligible: false,
                            state: 'failed',
                            reason: 'bot_not_alive',
                            message: 'The bot is not alive after reconnect.',
                        };
                    }
                    if ((previousContext.server && currentContext.server &&
                        previousContext.server !== currentContext.server) ||
                        (previousContext.dimension && currentContext.dimension &&
                        previousContext.dimension !== currentContext.dimension)) {
                        return {
                            eligible: false,
                            state: 'paused',
                            reason: 'world_dimension_changed',
                            message: 'Build paused because the bot rejoined a different server or dimension.',
                        };
                    }
                    return validateNamedBlueprintReconnect(agent.bot, name, {
                        orientation,
                        checkpoint: record.checkpoint.build ?? record.checkpoint,
                    });
                },
            });
            return formatTaskResult(outcome.status);
        }
    },
    {
        name: '!taskStatus',
        description: 'Show structured scheduled-task state, owner, target, progress, and lifecycle.',
        perform: function(agent) {
            return agent.taskScheduler.describe();
        }
    },
    {
        name: '!pauseTask',
        description: 'Pause an owned long task at its latest checkpoint.',
        params: { 'task_id': { type: 'string', description: 'Scheduled task id.' } },
        perform: async function(agent, task_id) {
            const outcome = await agent.taskScheduler.requestPause(task_id, taskOwner(agent));
            return formatTaskResult(outcome.status);
        }
    },
    {
        name: '!resumeTask',
        description: 'Resume an owned paused or material-waiting long task.',
        params: { 'task_id': { type: 'string', description: 'Scheduled task id.' } },
        perform: async function(agent, task_id) {
            const outcome = await agent.taskScheduler.requestResume(task_id, taskOwner(agent));
            return formatTaskResult(outcome.status);
        }
    },
    {
        name: '!cancelTask',
        description: 'Cancel a scheduled task. Long tasks are owner-controlled.',
        params: { 'task_id': { type: 'string', description: 'Scheduled task id.' } },
        perform: async function(agent, task_id) {
            const outcome = await agent.taskScheduler.requestCancellation(
                task_id,
                taskOwner(agent),
                'cancelled_by_owner',
            );
            return formatTaskResult(outcome.status);
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!rejoinWorld',
        description: 'Safely leave and rejoin the Minecraft world in the same process, then validate and resume eligible scheduled work.',
        perform: function (agent) {
            return agent.rejoinWorld('explicit_rejoin_command');
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process. In-memory scheduled tasks are intentionally forgotten.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runEmergencyTask('goToPlayer', async (agent, player_name, closeness) => {
            requestTpaToPlayer(agent.bot, player_name);
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!tpaToPlayer',
        description: 'Best-effort request to teleport to a player using server TPA plugins such as SimpleTPA. Use this first when a player asks the bot to teleport to them; fall back to goToPlayer/follow if the server does not support TPA.',
        params: {'player_name': {type: 'string', description: 'The player to request teleporting to.'}},
        perform: async function(agent, player_name) {
            return requestTpaToPlayer(agent.bot, player_name)
                ? `Sent /tpa ${player_name}. If the server lacks TPA support, use movement fallback.`
                : `Invalid player name ${player_name}.`;
        }
    },
    {
        name: '!tpAccept',
        description: 'Accept a pending teleport request using /tpaccept.',
        perform: async function(agent) {
            acceptTpa(agent.bot);
            return 'Sent /tpaccept.';
        }
    },
    {
        name: '!cleanupInventory',
        description: 'Clean a full inventory by depositing nonessential items into a nearby chest first, then discarding safe junk/overflow if no chest is available.',
        perform: runEmergencyTask('cleanupInventory', async (agent) => {
            const result = await cleanupInventory(agent.bot);
            skills.log(agent.bot, `Inventory cleanup: deposited=${result.deposited}, discarded=${result.discarded}. ${result.message ?? ''}`);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: async function(agent, player_name, follow_dist) {
            const outcome = await agent.taskScheduler.replacePersistentTask({
                name: `follow:${player_name}`,
                owner: taskOwner(agent),
                target: { player: player_name, distance: follow_dist },
                terminalConditions: ['target_died', 'bot_died', 'explicit_replacement'],
                checkpoint: { player: player_name, distance: follow_dist },
            }, async (control) => {
                await skills.followPlayer(agent.bot, player_name, follow_dist);
                const stopped = control.check();
                if (stopped) {
                    return taskResult(false, {
                        reason: stopped,
                        message: `Follow ${player_name} was interrupted.`,
                        complete: false,
                        checkpoint: control.record.checkpoint,
                    });
                }
                return taskResult(true, {
                    message: `Follow ${player_name} reached a terminal condition.`,
                    terminal: true,
                    checkpoint: control.record.checkpoint,
                });
            }, {
                timeout: -1,
                terminalCheck: () => agent.bot.health <= 0,
                reconnectCheck: (record, { previousContext, currentContext }) => {
                    if (agent.bot.health <= 0) {
                        return {
                            eligible: false,
                            state: 'failed',
                            reason: 'bot_not_alive',
                            message: 'Follow cannot resume because the bot is not alive.',
                        };
                    }
                    if ((previousContext.server && currentContext.server &&
                        previousContext.server !== currentContext.server) ||
                        (previousContext.dimension && currentContext.dimension &&
                        previousContext.dimension !== currentContext.dimension)) {
                        return {
                            eligible: false,
                            state: 'paused',
                            reason: 'world_dimension_changed',
                            message: 'Follow paused because the bot rejoined a different server or dimension.',
                        };
                    }
                    const target = agent.bot.players[record.target.player]?.entity;
                    if (!target || target.isValid === false) {
                        return {
                            eligible: false,
                            state: 'paused',
                            reason: 'follow_target_unavailable',
                            message: `Follow target ${record.target.player} is not present and alive.`,
                        };
                    }
                    return {
                        eligible: true,
                        reason: 'follow_target_verified',
                        message: `Follow target ${record.target.player} is present.`,
                    };
                },
            });
            return formatTaskResult(outcome.status);
        }
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!mineNearestBlock',
        description: 'Find, move to, and actually break/mine the nearest block of the given type. Use this for requests like mining diamonds, ancient debris, ores, or blocks; unlike searchForBlock, this breaks the block.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to mine.' },
            'search_range': { type: 'float', description: 'The range to search for the block.', domain: [4, 128] }
        },
        perform: runOwnerLockedTask('mineNearestBlock', async (agent, block_type, range) => {
            const mined = await skills.mineNearestBlock(agent.bot, block_type, range);
            return taskResult(Boolean(mined), {
                message: mined ? `Mined nearest ${block_type}.` : `Could not mine ${block_type}.`,
            });
        }, 5)
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runEmergencyTask('moveAway', async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runOwnerLockedTask('collectBlocks', async (agent, type, num) => {
            return skills.collectBlock(agent.bot, type, num);
        }, 10)
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runOwnerLockedTask('craftRecipe', async (agent, recipe_name, num) => {
            return skills.craftRecipe(agent.bot, recipe_name, num);
        }, 5)
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runOwnerLockedTask('smeltItem', async (agent, item_name, num) => {
            const success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
            return success;
        }, 10)
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
