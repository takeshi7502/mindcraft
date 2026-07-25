import process from 'node:process';
import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { prepareIncomingChat, resolveChatGateOptions } from './chat_gate.js';
import { Task } from './tasks/tasks.js';
import { TaskScheduler, TaskType } from './task_scheduler.js';
import {
    clearAttacker,
    clearDamageCorrelator,
    clearPlayerCombatState,
    createDamageCorrelator,
    recordHealthLoss,
    recordHurtSource,
    rememberAttacker,
} from './library/combat_targeting.js';
import { speak } from './speak.js';
import { handleDisconnection, log, validateNameFormat } from './connection_handler.js';
import {
    getDirectTpaTarget,
    isDirectTpaRequest,
    maybeAutoAcceptTpa,
    requestTpaToPlayer,
} from './library/teleport_requests.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this._sameProcessRejoin = false;
        this._replacementStarting = false;
        this._rejoinAttempts = 0;
        this._updateLoopStarted = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.taskScheduler = new TaskScheduler(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        const initialBot = this.bot;
        
        this._bindMinecraftConnection(initialBot);

        initModes(this);

        initialBot.on('login', () => {
            if (initialBot !== this.bot) return;
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                initialBot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                initialBot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            this.taskScheduler.clearForShutdown('initial_spawn_timeout');
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this._activeSpawnTimeout = spawnTimeout;
        initialBot.once('spawn', async () => {
            if (initialBot !== this.bot || this._disconnectHandled) return;
            try {
                clearTimeout(spawnTimeout);
                this._activeSpawnTimeout = null;
                addBrowserViewer(initialBot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message, { bot: initialBot });
                this.startEvents({ bot: initialBot });
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    _worldContext(bot = this.bot) {
        return {
            dimension: bot?.game?.dimension ?? null,
            server: `${String(settings.host)}:${String(settings.port)}`,
        };
    }

    _bindMinecraftConnection(bot) {
        const onDisconnect = (event, reason) => {
            this._handleMinecraftDisconnect(bot, event, reason).catch(error => {
                console.error('Minecraft reconnect handling failed:', error);
                this.taskScheduler.clearForShutdown('reconnect_handler_failed');
                process.exit(1);
            });
        };
        bot.on('playerLeft', player => {
            const entity = player?.entity ?? player;
            clearAttacker(bot, entity);
            clearPlayerCombatState(bot, entity);
        });

        bot.on('kicked', reason => onDisconnect('Kicked', reason));
        bot.once('end', reason => onDisconnect('Disconnected', reason));
        bot.on('error', err => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED'))
                onDisconnect('Error', err);
            else
                log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
        });
    }

    async _handleMinecraftDisconnect(bot, event, reason) {
        if (bot !== this.bot || this._disconnectHandled) return;
        this._disconnectHandled = true;
        clearTimeout(this._activeSpawnTimeout);
        this._activeSpawnTimeout = null;
        const { type } = handleDisconnection(this.name, reason);
        const recoverable = this._sameProcessRejoin ||
            ['network_error', 'server_full', 'maintenance'].includes(type);
        if (!recoverable) {
            this.taskScheduler.clearForShutdown(`process_exit:${type}`);
            process.exit(1);
            return;
        }

        if (!this._sameProcessRejoin) {
            this._sameProcessRejoin = true;
            this._rejoinAttempts = 0;
            await this.taskScheduler.suspendForReconnect(
                `connection_recovery:${type}`,
                this._worldContext(bot),
            );
        }
        console.warn(`${this.name} ${event}; attempting same-process world rejoin.`);
        this._beginReplacementConnection(type);
    }

    _beginReplacementConnection(reason) {
        if (this._replacementStarting) return;
        if (this._rejoinAttempts >= 3) {
            log(this.name, `[TaskRecovery] Rejoin failed after 3 attempts (${reason}).`);
            this.taskScheduler.clearForShutdown('reconnect_retry_exhausted');
            process.exit(1);
            return;
        }
        this._replacementStarting = true;
        const delayMs = Math.min(5000, 1000 * (this._rejoinAttempts + 1));
        setTimeout(() => {
            this._replacementStarting = false;
            this._createReplacementBot();
        }, delayMs);
    }

    _createReplacementBot() {
        this._rejoinAttempts++;
        this._disconnectHandled = false;
        const bot = initBot(this.name);
        this.bot = bot;
        this._bindMinecraftConnection(bot);
        initModes(this);
        this.clearBotLogs();

        bot.on('login', () => {
            if (bot !== this.bot || this._disconnectHandled) return;
            console.log(`${this.name} logged in for recovery attempt ${this._rejoinAttempts}.`);
            serverProxy.login();
            if (this.prompter.profile.skin)
                bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                bot.chat('/skin clear');
        });

        const spawnTimeout = setTimeout(() => {
            log(this.name, `[TaskRecovery] Rejoin attempt ${this._rejoinAttempts} did not spawn in time.`);
            try { bot.quit('Mindcraft rejoin timeout'); } catch (_) {
                this._beginReplacementConnection('spawn_timeout');
            }
        }, settings.spawn_timeout * 1000);
        this._activeSpawnTimeout = spawnTimeout;

        bot.once('spawn', async () => {
            if (bot !== this.bot || this._disconnectHandled) return;
            clearTimeout(spawnTimeout);
            this._activeSpawnTimeout = null;
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);
                await this._setupEventHandlers(null, null, { bot, sessionInit: false });
                this.startEvents({ bot });
                const recovery = await this.taskScheduler.resumeAfterReconnect(
                    this._worldContext(bot),
                );
                this._sameProcessRejoin = false;
                this._rejoinAttempts = 0;
                this._disconnectHandled = false;
                const message = `[TaskRecovery] ${recovery.message}`;
                console.log(message);
                if (settings.chat_ingame) bot.chat(message);
                sendOutputToServer(this.name, message);
            } catch (error) {
                console.error('Error restoring after world rejoin:', error);
                try { bot.quit('Mindcraft recovery validation failed'); } catch (_) {
                    this._beginReplacementConnection('restore_failed');
                }
            }
        });
    }

    async rejoinWorld(reason = 'requested_rejoin') {
        if (this._sameProcessRejoin)
            return 'A same-process world rejoin is already in progress.';
        this._sameProcessRejoin = true;
        this._rejoinAttempts = 0;
        const suspension = await this.taskScheduler.suspendForReconnect(
            reason,
            this._worldContext(),
        );
        try {
            this.bot.quit('Mindcraft same-process task recovery');
        } catch (error) {
            console.warn('Graceful world leave failed; starting replacement connection:', error);
            this._beginReplacementConnection('leave_failed');
        }
        return `${suspension.message} Rejoining now; eligible tasks will be validated after spawn.`;
    }
    async _setupEventHandlers(save_data, init_message, {
        bot = this.bot,
        sessionInit = true,
    } = {}) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message, { inGame = false } = {}) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                const gateOptions = resolveChatGateOptions(this.prompter.profile);
                const incoming = prepareIncomingChat(message, { inGame, ...gateOptions });
                if (!incoming.accepted) return;
                message = incoming.message;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        bot.on('whisper', (username, message) => {
            respondFunc(username, message, { inGame: true });
        });
        
        bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message, { inGame: true });
        });

        // Set up auto-eat
        bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (!sessionInit) return;

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        const bot = this.bot;
        if (!bot) return;
        bot.interrupt_code = true;
        try { bot.stopDigging?.(); } catch (_) { /* The connection may already be closed. */ }
        try { bot.collectBlock?.cancelTask?.(); } catch (_) { /* The connection may already be closed. */ }
        try { bot.pathfinder?.stop?.(); } catch (_) { /* The connection may already be closed. */ }
        try { bot.pvp?.stop?.(); } catch (_) { /* The connection may already be closed. */ }
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        if (!self_prompt)
            this.last_sender = source;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot && isDirectTpaRequest(message)) {
            const target = getDirectTpaTarget(message, source) ?? source;
            const sent = requestTpaToPlayer(this.bot, target);
            this.routeResponse(source, sent
                ? `Sent /tpa ${target}.`
                : `I couldn't send TPA to ${target}; I'll use normal movement if needed.`);
            return sent;
        }

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message, { source });
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot) {
            this.last_sender = source;
        }

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                const commandSource = self_prompt && this.last_sender ? this.last_sender : source;
                let execute_res = await executeCommand(this, res, { source: commandSource });

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents({ bot = this.bot } = {}) {
        // Custom events
        bot.on('time', () => {
            if (bot.time.timeOfDay == 0)
            bot.emit('sunrise');
            else if (bot.time.timeOfDay == 6000)
            bot.emit('noon');
            else if (bot.time.timeOfDay == 12000)
            bot.emit('sunset');
            else if (bot.time.timeOfDay == 18000)
            bot.emit('midnight');
        });

        let prev_health = bot.health;
        bot.lastDamageTime = 0;
        bot.lastDamageTaken = 0;
        bot.retaliationTarget = null;
        bot.playerWarningStrike = null;
        bot.playerRetaliationHistory = new Map();
        bot.damageCorrelator = createDamageCorrelator();
        const commitDamage = correlated => {
            if (!correlated) return;
            const response = rememberAttacker(bot, correlated.source, {
                now: correlated.timestamp,
                playerPolicy: {
                    enabled: settings.allow_player_retaliation,
                },
            });
            if (response.attacker) bot.lastDamageTime = correlated.timestamp;
        };
        bot.on('health', () => {
            if (bot.health < prev_health) {
                const damage = prev_health - bot.health;
                bot.lastDamageTime = Date.now();
                bot.lastDamageTaken = damage;
                commitDamage(recordHealthLoss(bot.damageCorrelator, damage));
            }
            prev_health = bot.health;
        });
        bot.on('entityHurt', (entity, source) => {
            if (entity !== bot.entity || !source) return;
            commitDamage(recordHurtSource(bot.damageCorrelator, source));
        });
        // Logging callbacks
        bot.on('error' , (err) => {
            console.error('Error event!', err);
        });

        bot.on('death', () => {
            clearAttacker(bot);
            clearDamageCorrelator(bot.damageCorrelator);
            clearPlayerCombatState(bot);
            this.taskScheduler.terminateWhere(() => true, 'bot_died');
            this.actions.cancelResume();
            this.actions.stop();
        });
        bot.on('entityDead', entity => {
            clearAttacker(bot, entity);
            clearPlayerCombatState(bot, entity);
            const playerName = entity?.username;
            if (!playerName) return;
            this.taskScheduler.terminateWhere(record =>
                record.type === TaskType.PERSISTENT &&
                record.target?.player === playerName &&
                record.terminalConditions.includes('target_died'), 'follow_target_died');
        });

        bot.on('messagestr', async (message, _, jsonMsg) => {
            if (maybeAutoAcceptTpa(bot, message)) {
                log(this.name, '[TPA] Accepted teleport request.');
            }
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        bot.on('idle', () => {
            bot.clearControlStates();
            bot.pathfinder.stop(); // clear any lingering pathfinder
            bot.modes.unPauseAll();
            setTimeout(async () => {
                if (bot !== this.bot || this._sameProcessRejoin) return;
                if (this.isIdle()) {
                    const resumedScheduledTask = await this.taskScheduler.resumePending();
                    if (!resumedScheduledTask) this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();
        if (this._updateLoopStarted) {
            bot.emit('idle');
            return;
        }
        this._updateLoopStarted = true;

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        bot.emit('idle');
    }

    async update(delta) {
        if (this._sameProcessRejoin) return;
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this._sameProcessRejoin = false;
        this.taskScheduler?.clearForShutdown('process_shutdown');
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
