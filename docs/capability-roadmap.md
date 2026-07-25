# Staged capability roadmap

## 1. Construction foundation — implemented

Named multi-layer blueprints, orientation, safe-origin selection, material preflight, dependency ordering, per-block verification, bounded retry, structured progress, and in-session checkpoint/resume are implemented. Next construction work should add directional block-state planning, scaffolding, and optional explicit site preparation.

## 2. Bounded construction materials — implemented

Blueprint builds now compose inventory verification, nearest-chest withdrawal, bounded recipe dependency traversal, safe block-source gathering, inventory-delta verification, protected construction footprints, structured shortages, and checkpointed resume. Acquisition is capped by rounds, gathered blocks, recipe depth, and time. Owner `!stop`, pause/resume, and same-process reconnect retain build context.

## 3. General resource collection and crafting — next

Expand the construction-specific pipeline into reusable owner-locked gather/craft task graphs with return/delivery checkpoints, multiple whitelisted storage locations, deterministic crafting-station transactions, smelting/fuel planning, tool durability planning, and explicit chest ownership policy.

## 4. Interaction

Add verified door, chest, furnace, villager, bed, button, and lever transactions with explicit target selection and postcondition checks.

## 5. Navigation

Expand conservative reachability to multi-stop route planning, return-to-origin, vertical construction access, and reusable safe travel corridors without enabling terrain destruction by default.

## 6. Safety

Add shared hazard budgets, health/food/equipment gates, terminal-condition events, stuck detection with bounded recovery, and clear escalation. Keep `!stop`, `!goToPlayer`, and `!moveAway` as emergency scheduler overrides.

All stages should remain deterministic command/skill paths. Vision and insecure LLM-generated code execution are outside this roadmap.