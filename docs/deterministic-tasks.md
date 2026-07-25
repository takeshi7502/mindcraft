# Deterministic task foundation

Mindcraft now has a small deterministic task layer for bounded, reusable Mineflayer routines. It does not generate or execute LLM-authored code and it does not change `allow_insecure_coding`; that setting remains `false`.

## Commands

- `!goToNearbyBlockSafely(type, search_range)` scans at most 32 loaded blocks away, evaluates a capped number of safe adjacent positions, rejects paths that dig or place blocks, moves with a task deadline, and revalidates the target after arrival.
- `!fishNearby(search_range, attempts)` requires a fishing rod, rejects low-health or hazardous starts, finds open surface water with a safe reachable shore position, navigates and revalidates, aims at the selected water, and makes at most three casts. Each cast has its own timeout and success is verified by an inventory delta.

Both commands run through the existing `ActionManager`, so `!stop` and action replacement continue to use `bot.interrupt_code` and `pathfinder.stop()`.

## Reusable modules

- `task_primitives.js` defines stable structured results, failure reasons, task deadlines, cancellation polling, phase cleanup, per-phase latency/count metrics, and bounded retry.
- `task_observation.js` provides hard-capped nearby block observation, conservative standing-position checks, open-water validation, and non-destructive adjacent reachability. Its generic interfaces support water, resources, and interactive blocks.
- `deterministic_tasks.js` composes those primitives into reusable safe approach and fishing tasks. Task results include `success`, `reason`, `message`, `data`, `attempts`, and `metrics`.

Representative failure reasons are `missing_equipment`, `unsafe`, `not_found`, `unreachable`, `timed_out`, `cancelled`, `no_progress`, and `action_failed`. Retries occur only for a small allowlist of transient reasons and never exceed the requested bound.

## Safety and limits

Observation is limited to already loaded nearby blocks and never expands into indefinite exploration. Reachability disables digging, block placement, one-by-one towers, and parkour; ordinary door opening remains allowed. Timeout cleanup stops pathfinding and reels in a cast only while a fishing cast is active.

Fishing currently needs an existing rod. It does not craft one, manage hostile mobs, search unloaded chunks, prove Minecraft's open-water treasure conditions, or recover catches when the inventory is full. Reachability is intentionally conservative and may reject a route that would be possible after modifying terrain.

Deterministic construction now builds on these APIs with material preflight, per-block verification, bounded retry, and scheduler checkpoints. The next phase is bounded resource collection and crafting composition, followed by verified interaction and richer safe navigation.

## Verification

Run focused tests with `npm test`. Run lint for the new deterministic modules with `npm run lint` after installing project dependencies.
