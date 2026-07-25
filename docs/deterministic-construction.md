# Deterministic blueprint construction

Use `!buildBlueprint("small_wood_house", 0)` to build a catalog blueprint. Orientation is a quarter turn: `0`, `1`, `2`, or `3`. Current catalog names are `dirt_shelter`, `large_house`, `small_stone_house`, and `small_wood_house`.

The executor reuses both existing Mindcraft formats:

1. NPC catalog format: `{ "name", "offset", "blocks": blocks[y][z][x] }`.
2. Construction-task format: `{ "levels": [{ "coordinates": [x,y,z], "placement": rows[z][x] }] }`.

It does not introduce a third schema. In catalog matrices, `null` or `""` means “ignore this cell”; `"air"` requires clear/passable space. Generic existing names such as `planks`, `log`, `door`, `bed`, and `torch` resolve through the existing inventory-aware material convention.

Before building, Mindcraft selects a bounded nearby flat origin, honors the catalog `offset`, applies orientation, verifies support/clearance, and calculates remaining inventory requirements. Solid conflicts, hazards, unloaded cells, and shortages are reported before the first placement; the executor does not clear or level terrain by default.

Blocks are ordered by stable layers. Supported structural blocks seed each layer, connected blocks follow, and dependency-sensitive attachments are placed later. Every block is checked before placement and verified afterward. Already-correct blocks are skipped; failed placements retry at most three times. Navigation to a placement uses conservative non-digging reachability. Cancellation, timeout, obstruction, and retry exhaustion return structured progress and a checkpoint.

The executor supports moderately detailed blueprints up to 4,096 actionable cells. The existing `large_house` fixture exercises 14 layers, rotated dimensions, generic materials, furnishings, glass, and repeated wall/roof patterns.

## Adding a simple house

Add a JSON file under `src/agent/npc/construction/`, for example `starter_house.json`:

```json
{
  "name": "starter_house",
  "offset": -1,
  "blocks": [
    [["stone", "stone", "stone"], ["stone", "stone", "stone"], ["stone", "stone", "stone"]],
    [["oak_planks", "oak_door", "oak_planks"], ["oak_planks", "air", "oak_planks"], ["oak_planks", "oak_planks", "oak_planks"]],
    [["oak_planks", "oak_door", "oak_planks"], ["oak_planks", "torch", "oak_planks"], ["oak_planks", "oak_planks", "oak_planks"]],
    [["oak_slab", "oak_slab", "oak_slab"], ["oak_slab", "oak_slab", "oak_slab"], ["oak_slab", "oak_slab", "oak_slab"]]
  ]
}
```

Restart the process so the catalog is reread, then use `!buildBlueprint("starter_house", 0)`.

## Autonomous material acquisition

When preflight reports shortages, the owner-locked build task now attempts a bounded pipeline before entering `waiting_materials`:

1. Recheck current inventory.
2. Withdraw the exact missing amount from the nearest chest within 32 blocks.
3. Craft outputs whose recipes and ingredients can be resolved safely.
4. Gather block sources for missing outputs or recipe ingredients within the existing collection range.
5. Re-run blueprint preflight and resume from the saved origin and completed-block checkpoint.

Every substep is verified through inventory delta. A skill returning success without an actual inventory increase is treated as no progress. Recipe traversal is cycle/depth bounded; acquisition stops after 8 rounds, 256 gathered blocks, or 20 minutes. The build footprint and known NPC construction positions are excluded from gathering, so the bot will not dismantle its current or registered builds for materials. `!stop` interrupts acquisition and preserves both build and acquisition checkpoints.

If the bot cannot find enough material, the task remains `waiting_materials` with exact remaining shortages. After the owner supplies materials, `!resumeTask("task-id")` rechecks real inventory and continues.

## Current constraints

The command builds predefined blueprints, not vague free-form architecture. Direction-sensitive block metadata (complex stairs, redstone, and some multi-block furnishing orientations) still relies on the existing physical placement skill and may fail verification cleanly. Terrain clearing, scaffolding for extreme height/overhangs, automatic smelting/hunting, chest ownership policies, rollback, and cross-process task persistence are not implemented. Chest withdrawal currently assumes the nearest chest is permitted for the bot. A same-process `!rejoinWorld` can resume a verified in-memory checkpoint; a real process restart intentionally forgets it. Vision and insecure free-form code generation are not used.