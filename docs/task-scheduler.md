# In-session task scheduler

Mindcraft stores active task information in `TaskScheduler` records instead of relying on chat history. Records persist across successive commands and a same-process `!rejoinWorld`, but are intentionally never saved to disk. A real Node.js process restart starts with no scheduled tasks.

Each record stores:

- `taskClass`: `persistent`, `resumable`, or `short`;
- `owner`, `ownerLocked`, and `target`;
- `state`, structured `progress`, and a resumable `checkpoint`;
- terminal-condition names;
- `parentTaskId`, `interruptedBy`, and deterministic `resumeOrder`.

## Lifecycles and ownership

- Persistent follow: `!followPlayer("Alice", 3)` remains active until replacement, cancellation, the target dying, or the bot dying. A new follow from any player replaces the old follow. Persistent follow is suspended while a long or short movement task owns the action slot, then reasserts when safe.
- Long/resumable: `!buildBlueprint(...)`, `!fishNearby(...)`, `!collectBlocks(...)`, `!craftRecipe(...)`, and `!smeltItem(...)` are owner-locked. Only the player who started one may pause, resume, cancel, or replace it. A long request from another player is rejected immediately with `ownership_locked`; it is not silently queued.
- Short/transient: scheduler callers may accept a short request from another player. It temporarily interrupts a long task, runs exclusively, then resumes the parent from its stored checkpoint. The mock harness demonstrates fetch/deliver; a production item-delivery command is a later extension.

Only one scheduler runner may use movement/actions at a time. Priorities are short (100), resumable (50), and persistent (10); emergency tasks use 1000. The interruption stack restores the correct parent deterministically.

## Visible states

Records expose `queued`, `running`, `paused`, `waiting_materials`, `failed`, `completed`, and `cancelled`. An owner pause sets `autoResume=false`; interruption pauses remain auto-resumable. Missing build materials enter `waiting_materials` and retain the selected origin/checkpoint.

Commands:

- `!taskStatus`
- `!pauseTask("task-1")`
- `!resumeTask("task-1")`
- `!cancelTask("task-1")`
- `!rejoinWorld`

During a same-process rejoin, short tasks are cancelled and recoverable long/persistent tasks are paused. After the replacement bot spawns, Follow and blueprint Build use task-specific world validators before the scheduler may resume them. Tasks without a validator stay paused rather than replaying blindly. `!stop` clears reconnect candidates, so cancelled work cannot reappear.

## Emergency overrides

The minimal integrated emergency set is:

- `!stop` — cancels all scheduled work regardless of owner;
- `!goToPlayer("name", distance)` — temporarily preempts, moves to the player, then resumes eligible work;
- `!moveAway(distance)` — temporarily preempts, retreats, then resumes eligible work.

These overrides bypass long-task ownership. Ordinary long commands do not.

Runners receive a control object with `checkpoint()` and `check()`. They must checkpoint after bounded units of work and stop on interruption. Timeouts remain enforced by `ActionManager`; deterministic operations also use task-primitive deadlines and bounded retries.

Construction has fine-grained per-block/layer checkpoints. The scheduled legacy fishing, collection, crafting, and smelting commands currently retain structured command arguments and rely on their existing skill postconditions; finer quantity/stage checkpoints for those capabilities are roadmap work.