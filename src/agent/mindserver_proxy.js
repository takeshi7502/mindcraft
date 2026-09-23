import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        this.agents = [];
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        
        this.name = name;
        this.socket = io(`http://localhost:${port}`);

        await new Promise((resolve, reject) => {
            this.socket.on('connect', resolve);
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');

        this.socket.on('disconnect', () => {
            console.log('Disconnected from MindServer');
            this.connected = false;
            if (this.agent) {
                this.agent.cleanKill('Disconnected from MindServer. Killing agent process.');
            }
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('bot-chat', (data, callback) => {
            const message = typeof data?.message === 'string' ? data.message.trim() : '';
            try {
                if (!message || message.length > 256 || message.startsWith('/')) {
                    callback?.({ success: false, error: 'Only normal chat messages are allowed.' });
                    return;
                }
                this.agent.bot.chat(message);
                callback?.({ success: true, message: 'Chat sent.' });
            } catch (error) {
                console.error('Bot chat failed:', error);
                callback?.({ success: false, error: 'Could not send bot chat.' });
            }
        });

        this.socket.on('inventory-action', async (data, callback) => {
            const action = data?.action;
            const itemName = typeof data?.itemName === 'string' ? data.itemName.trim() : '';
            const bot = this.agent?.bot;
            const total = () => (bot?.inventory?.slots || []).reduce(
                (sum, item) => sum + (item?.name === itemName ? item.count : 0), 0);
            try {
                if (!bot || !['delete', 'drop'].includes(action) || !/^[a-z0-9_:-]+$/i.test(itemName)) {
                    callback?.({ success: false, error: 'Invalid inventory action.' });
                    return;
                }
                const before = total();
                if (before === 0) {
                    callback?.({ success: false, error: `No ${itemName} in inventory.` });
                    return;
                }

                if (action === 'delete') {
                    // Mineflayer cannot delete survival items client-side. This exact,
                    // generated command is safe from command injection and needs OP.
                    bot.chat(`/clear @s minecraft:${itemName.replace(/^minecraft:/, '')}`);
                    await new Promise(resolve => setTimeout(resolve, 750));
                    const removed = before - total();
                    if (removed <= 0) {
                        callback?.({ success: false, error: 'Could not clear item. Give the bot OP for /clear.' });
                        return;
                    }
                    callback?.({ success: true, message: `Deleted ${removed} ${itemName}.` });
                    return;
                }

                // Close a chest/crafting window first so each item's inventory slot is
                // valid, then toss every matching stack at the bot's current position.
                if (bot.currentWindow && bot.currentWindow !== bot.inventory) bot.closeWindow(bot.currentWindow);
                let dropped = 0;
                while (true) {
                    const item = (bot.inventory.slots || []).find(entry => entry?.name === itemName);
                    if (!item) break;
                    dropped += item.count;
                    await bot.tossStack(item);
                }
                callback?.({ success: dropped > 0, message: `Dropped ${dropped} ${itemName} at the bot's feet.` });
            } catch (error) {
                console.error('Inventory action failed:', error);
                callback?.({ success: false, error: 'Could not complete inventory action.' });
            }
        });

        this.socket.on('get-full-state', (callback) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        // Request settings and wait for response
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for chatting with other bots
export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
export function sendOutputToServer(agentName, message) {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}
