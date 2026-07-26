import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

// OpenCode Zen (https://opencode.ai/docs/zen/) is an OpenAI-compatible AI gateway.
// Base URL: https://opencode.ai/zen/v1  (exposes /chat/completions and /models)
export class OpenCode {
    static prefix = 'opencode';
    constructor(model_name, url) {
        this.model_name = model_name;

        let config = {};
        config.baseURL = url || 'https://opencode.ai/zen/v1';

        // The key is OPTIONAL: OpenCode Zen "*-free" models work without any key.
        // If a key exists, use it normally. Otherwise strip the Authorization header
        // completely (the OpenAI SDK would otherwise send an invalid "Bearer" and get 401).
        if (hasKey('OPENCODE_API_KEY')) {
            config.apiKey = getKey('OPENCODE_API_KEY');
        } else {
            config.apiKey = 'sk-no-key';
            config.defaultHeaders = { Authorization: null };
        }

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='*') {
        let messages = [{ role: 'system', content: systemMessage }, ...turns];
        messages = strictFormat(messages);

        const pack = {
            model: this.model_name,
            messages,
            stop: stop_seq
        };

        let res = null;
        try {
            console.log('Awaiting opencode api response...');
            let completion = await this.openai.chat.completions.create(pack);
            if (!completion?.choices?.[0]) {
                console.error('No completion or choices returned:', completion);
                return 'No response received.';
            }
            if (completion.choices[0].finish_reason === 'length') {
                throw new Error('Context length exceeded');
            }
            console.log('Received.');
            res = completion.choices[0].message.content;
        } catch (err) {
            console.error('Error while awaiting response:', err);
            res = 'My brain disconnected, try again.';
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by OpenCode Zen.');
    }
}
