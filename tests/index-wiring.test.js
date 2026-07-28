import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

function wordCount(word) {
    return [...indexSource.matchAll(new RegExp(`\\b${word}\\b`, 'g'))].length;
}

test('the browser entrypoint wires the tested automation core instead of only importing it', () => {
    const productionHelpers = [
        'normalizeMemberAutomation',
        'memberAutomationKey',
        'buildProactivePrompt',
        'tryClaimDueAutomation',
        'completeAutomationClaim',
        'resolveGroupApiConfig',
        'buildRoleApiRequest',
    ];

    for (const helper of productionHelpers) {
        assert.ok(
            wordCount(helper) >= 2,
            `${helper} must be called by index.js, not merely imported`,
        );
    }
});

test('cross-window claims run under a Web Lock and proactive delivery consumes no-chain flags', () => {
    assert.ok(
        /navigator\.locks(?:\?|)\.request|navigator\.locks\?\.request/.test(indexSource),
        'the read/claim/write transition must be serialized across same-origin SillyTavern tabs',
    );
    assert.ok(
        wordCount('suppressChains') >= 2,
        'the proactive prompt no-chain result must be consumed by the browser delivery path',
    );
});

test('role group generation is routed through the fallback/custom API dispatcher', () => {
    assert.ok(
        /async function generateGroupRoleWithBackoff[\s\S]*?buildRoleApiRequest\(/.test(indexSource),
        'group role generation must use the tested role API dispatcher',
    );
    assert.ok(
        /route\.mode === ['"]st_default['"]/.test(indexSource),
        'unconfigured roles must keep using the SillyTavern generation route',
    );
    assert.ok(
        /ChatCompletionService\.processRequest\(route\.options/.test(indexSource),
        'configured roles must use their custom group API request',
    );
    assert.ok(
        /#cpgl_current_members \.cpgl-role-api-test[\s\S]*?const \{ card, group, avatar \} = getMemberSettingsContext/.test(indexSource),
        'the role API test button must resolve its target group before checking group automation claims',
    );
});
