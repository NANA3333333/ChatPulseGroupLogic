import assert from 'node:assert/strict';
import test from 'node:test';

import * as automation from '../automation-core.js';

const REQUIRED_EXPORTS = [
    'normalizeMemberAutomation',
    'memberAutomationKey',
    'buildProactivePrompt',
    'tryClaimDueAutomation',
    'completeAutomationClaim',
    'resolveGroupApiConfig',
    'buildRoleApiRequest',
];

test('automation core exposes the small, browser-independent contract', () => {
    for (const name of REQUIRED_EXPORTS) {
        assert.equal(
            typeof automation[name],
            'function',
            `automation-core.js must export ${name}()`,
        );
    }
});
