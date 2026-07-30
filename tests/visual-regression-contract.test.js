import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styleSource = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('the red-packet header keeps its visible red treatment', () => {
    const redHeaderRule = styleSource.match(/\.cpgl-redpacket-header\s*\{([^}]*)\}/);

    assert.ok(redHeaderRule, 'the red-packet header rule must exist');
    assert.match(
        redHeaderRule[1],
        /background:\s*linear-gradient\([^;]*#d63031[^;]*#c0392b\)/,
        'the red-packet header must retain its red gradient',
    );
    assert.match(redHeaderRule[1], /color:\s*#fff/, 'the white title needs a red background');
    assert.doesNotMatch(
        styleSource,
        /\.cpgl-create-header,\s*\.cpgl-help-header,\s*\.cpgl-redpacket-header\s*\{[^}]*background:\s*#ffffff/,
        'a later shared-header rule must not overwrite the red-packet background',
    );
});
