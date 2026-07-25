import { readdirSync, readFileSync } from 'node:fs';

const BLUEPRINT_DIRECTORY = new URL('../npc/construction/', import.meta.url);
const SAFE_NAME = /^[a-z0-9_-]+$/;

export function listBlueprintNames() {
    return readdirSync(BLUEPRINT_DIRECTORY)
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -5))
        .filter(name => SAFE_NAME.test(name))
        .sort();
}

export function loadBlueprint(name) {
    const normalized = String(name ?? '').trim().toLowerCase();
    if (!SAFE_NAME.test(normalized) || !listBlueprintNames().includes(normalized))
        throw new Error(`Unknown blueprint "${name}". Available: ${listBlueprintNames().join(', ')}.`);

    const url = new URL(`${normalized}.json`, BLUEPRINT_DIRECTORY);
    const blueprint = JSON.parse(readFileSync(url, 'utf8'));
    if (!blueprint.name) blueprint.name = normalized;
    return blueprint;
}