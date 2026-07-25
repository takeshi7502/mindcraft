import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readProfile(name) {
    const url = new URL(`../profiles/defaults/${name}`, import.meta.url);
    return JSON.parse(await readFile(url, 'utf8'));
}

for (const profileName of ['_default.json', 'survival.json']) {
    test(`${profileName} disables automatic hunting but keeps self-defense`, async () => {
        const profile = await readProfile(profileName);

        assert.equal(profile.modes.hunting, false);
        assert.equal(profile.modes.self_defense, true);
    });
}