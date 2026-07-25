# In-game chat invocation gate

Mindcraft ignores player chat and whispers unless the message starts with the bot's configured `profile.name`. Matching is case-insensitive, accepts an optional `@` and normal punctuation, and removes the invocation before translation, command parsing, or LLM prompting.

For a profile with `"name": "Waku"`:

- `Waku, fish nearby` processes `fish nearby`.
- `@waku: !stop` processes the existing `!stop` command.
- `WAKU! come here` processes `come here`.
- `hello Waku` and `Wakuland is nearby` are ignored.

The invocation name is always `profile.name`. There is no separate trigger or enable/disable setting: renaming the bot automatically changes the required invocation name, and name-gating remains active for in-game chat.

The gate applies only to Mineflayer `chat` and `whisper` events. `only_chat_with` filtering remains active. MindServer/UI messages, internal system events, self-prompts, and bot-to-bot control traffic bypass the gate. A message rejected by the gate is discarded before translation and never reaches `Agent.handleMessage`, so it cannot call the LLM or produce a reply.

This feature does not change `allow_insecure_coding`.
