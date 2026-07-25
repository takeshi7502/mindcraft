# Same-process world rejoin recovery

Mindcraft keeps scheduled task records in memory while the current Node.js agent process is alive. `!rejoinWorld` safely interrupts current work, leaves the Minecraft connection, reconnects with the same agent object, and validates suspended work after the new `spawn` event.

Recoverable state includes the task class, owner/target, lifecycle state, progress, checkpoint, interruption order, and the existing registered runner. Nothing is written to disk. A real process restart, normal shutdown, fatal login failure, or exhausted reconnect retry starts fresh and forgets all tasks.

Recovery policy:

- Short/transient tasks are cancelled and are never replayed.
- Manual pauses remain paused; material-waiting tasks remain waiting.
- Follow resumes only when the bot is alive, the configured server and dimension are unchanged, and the target player is present with a valid entity.
- Blueprint builds resume from their in-memory origin and completed-block checkpoint only when the configured server and dimension are unchanged, every completed block still matches, the catalog blueprint remains valid, the site is safe, and remaining materials are available.
- Other long tasks without a dedicated reconnect validator stay paused with `reconnect_validation_unavailable`; they are not resumed blindly.
- `!stop` cancels all candidates, and `!cancelTask("task-id")` prevents that task from returning.

Recoverable network disconnects use the same path automatically and retry at most three times. The unstuck mode also requests this recovery if its bounded move-away attempt does not finish. After rejoin, chat and the MindServer output show counts for resumed, paused, material-waiting, and failed tasks. Use `!taskStatus` for the exact task reason.
