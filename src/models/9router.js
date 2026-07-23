import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class NineRouter {
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;

        this.openai = new OpenAIApi({
            baseURL: url || 'http://localhost:20128/v1',
            apiKey: getKey('NINEROUTER_API_KEY'),
            defaultHeaders: {
                'User-Agent': 'Mindcraft/1.0',
            },
        });
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        const messages = strictFormat([
            { role: 'system', content: systemMessage },
            ...turns,
        ]);
        const pack = {
            model: this.model_name,
            messages,
            stop: stop_seq,
            ...(this.params || {}),
        };

        try {
            console.log('Awaiting 9router api response from model', this.model_name);
            const completion = await this.openai.chat.completions.create(pack);
            if (!completion?.choices?.[0]) {
                throw new Error('No completion or choices returned');
            }
            if (completion.choices[0].finish_reason === 'length') {
                throw new Error('Context length exceeded');
            }
            console.log('Received.');
            return completion.choices[0].message.content;
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            }
            if (err.message?.includes('image_url')) {
                console.log(err);
                return 'Vision is only supported by certain models.';
            }
            console.error('Error while awaiting 9router response:', err);
            return 'My brain disconnected, try again.';
        }
    }

    sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image_url',
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
                    },
                },
            ],
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    embed() {
        throw new Error('Embeddings are not supported by the 9Router adapter.');
    }
}

NineRouter.prefix = '9router';
