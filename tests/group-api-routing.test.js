import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildRoleApiRequest,
    resolveGroupApiConfig,
} from '../automation-core.js';

const messages = [
    { role: 'system', content: '你是沈砚秋，只输出你本人的一条群聊消息。' },
    { role: 'user', content: '检查旧报纸上的墨迹。' },
];

test('an unconfigured role explicitly falls back to the current SillyTavern API', () => {
    const config = resolveGroupApiConfig(null);
    const request = buildRoleApiRequest({
        roleConfig: null,
        messages,
        responseLength: 640,
    });

    assert.equal(config.mode, 'st_default');
    assert.equal(request.mode, 'st_default');
    assert.deepEqual(request.options.prompt, messages);
    assert.equal(request.options.responseLength, 640);
    assert.equal(request.options.trimNames, false);
    assert.equal(Object.hasOwn(request.options, 'custom_url'), false);
    assert.equal(Object.hasOwn(request.options, 'secret_id'), false);
});

test('a complete role API config routes through that role endpoint, model, and secret id', () => {
    const roleConfig = {
        mode: 'custom',
        endpoint: 'http://127.0.0.1:8787/v1',
        model: 'airp-shen-flash',
        secretId: 'secret-shen',
        temperature: 0.35,
        maxTokens: 900,
    };
    const config = resolveGroupApiConfig(roleConfig);
    const request = buildRoleApiRequest({
        roleConfig,
        messages,
        responseLength: 720,
    });

    assert.deepEqual(config, roleConfig);
    assert.equal(request.mode, 'custom');
    assert.equal(request.options.chat_completion_source, 'custom');
    assert.equal(request.options.custom_url, roleConfig.endpoint);
    assert.equal(request.options.model, roleConfig.model);
    assert.equal(request.options.secret_id, roleConfig.secretId);
    assert.equal(request.options.temperature, roleConfig.temperature);
    assert.equal(request.options.max_tokens, 720);
    assert.deepEqual(request.options.messages, messages);
    assert.equal(Object.hasOwn(request.options, 'apiKey'), false);
    assert.equal(Object.hasOwn(request.options, 'api_key'), false);
});

test('different roles keep independent custom routes', () => {
    const shen = buildRoleApiRequest({
        roleConfig: {
            mode: 'custom',
            endpoint: 'https://provider-a.example/v1',
            model: 'shen-model',
            secretId: 'secret-a',
        },
        messages,
    });
    const mira = buildRoleApiRequest({
        roleConfig: {
            mode: 'custom',
            endpoint: 'https://provider-b.example/v1',
            model: 'mira-model',
            secretId: 'secret-b',
        },
        messages,
    });

    assert.notEqual(shen.options.custom_url, mira.options.custom_url);
    assert.notEqual(shen.options.model, mira.options.model);
    assert.notEqual(shen.options.secret_id, mira.options.secret_id);
    assert.equal(shen.options.custom_url, 'https://provider-a.example/v1');
    assert.equal(mira.options.custom_url, 'https://provider-b.example/v1');
});

test('partial custom API settings fail explicitly instead of silently using the ST API', () => {
    const incompleteConfigs = [
        {
            mode: 'custom',
            endpoint: '',
            model: 'role-model',
            secretId: 'secret-role',
        },
        {
            mode: 'custom',
            endpoint: 'https://provider.example/v1',
            model: '',
            secretId: 'secret-role',
        },
        {
            mode: 'custom',
            endpoint: 'https://provider.example/v1',
            model: 'role-model',
            secretId: '',
        },
        {
            endpoint: 'https://provider.example/v1',
        },
    ];

    for (const roleConfig of incompleteConfigs) {
        assert.throws(
            () => resolveGroupApiConfig(roleConfig),
            error => {
                assert.equal(error?.code, 'GROUP_API_CONFIG_INCOMPLETE');
                assert.ok(Array.isArray(error?.missing));
                assert.ok(error.missing.length > 0);
                return true;
            },
        );
        assert.throws(
            () => buildRoleApiRequest({ roleConfig, messages }),
            error => error?.code === 'GROUP_API_CONFIG_INCOMPLETE',
        );
    }
});

test('an explicit ST-default role never inherits stale custom fields', () => {
    const request = buildRoleApiRequest({
        roleConfig: {
            mode: 'st_default',
            endpoint: '',
            model: '',
            secretId: '',
            temperature: 1.2,
            maxTokens: 500,
        },
        messages,
    });

    assert.equal(request.mode, 'st_default');
    assert.deepEqual(request.options.prompt, messages);
    assert.equal(Object.hasOwn(request.options, 'custom_url'), false);
    assert.equal(Object.hasOwn(request.options, 'model'), false);
    assert.equal(Object.hasOwn(request.options, 'secret_id'), false);
});

