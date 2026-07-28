const DEFAULT_AUTOMATION = Object.freeze({
    enabled: false,
    intervalMinMinutes: 10,
    intervalMaxMinutes: 60,
    prompt: '',
    jealousyEnabled: false,
    jealousyChance: 50,
    jealousyPrompt: '',
    nextTriggerAt: 0,
    lastTriggerAt: 0,
    claimOwnerId: '',
    claimEventId: '',
    claimUntil: 0,
    lastCompletedEventId: '',
});

function hasOwn(object, key) {
    return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function firstDefined(object, keys, fallback) {
    for (const key of keys) {
        if (hasOwn(object, key)) return object[key];
    }
    return fallback;
}

function asBoolean(value) {
    if (typeof value === 'string') {
        return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    }
    return value === true || value === 1;
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    const number = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, number));
}

function safeTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function limitedText(value, maxLength = 4000) {
    return String(value || '').trim().slice(0, maxLength);
}

/**
 * Normalize one `(group, member)` automation record.
 *
 * Legacy snake_case aliases are accepted so the browser-only extension can
 * import settings produced by older ChatPulse experiments without coupling
 * its persisted schema to those experiments.
 */
export function normalizeMemberAutomation(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const intervalMinMinutes = clampInteger(
        firstDefined(source, ['intervalMinMinutes', 'interval_min'], DEFAULT_AUTOMATION.intervalMinMinutes),
        1,
        1440,
        DEFAULT_AUTOMATION.intervalMinMinutes,
    );
    const intervalMaxMinutes = Math.max(intervalMinMinutes, clampInteger(
        firstDefined(source, ['intervalMaxMinutes', 'interval_max'], DEFAULT_AUTOMATION.intervalMaxMinutes),
        1,
        1440,
        DEFAULT_AUTOMATION.intervalMaxMinutes,
    ));

    return {
        enabled: asBoolean(firstDefined(source, ['enabled', 'proactiveEnabled', 'proactive_enabled'], false)),
        intervalMinMinutes,
        intervalMaxMinutes,
        prompt: limitedText(firstDefined(source, ['prompt', 'proactivePrompt', 'proactive_prompt'], '')),
        jealousyEnabled: asBoolean(firstDefined(source, ['jealousyEnabled', 'jealousy_enabled'], false)),
        jealousyChance: clampInteger(
            firstDefined(source, ['jealousyChance', 'jealousy_chance'], DEFAULT_AUTOMATION.jealousyChance),
            0,
            100,
            DEFAULT_AUTOMATION.jealousyChance,
        ),
        jealousyPrompt: limitedText(firstDefined(source, ['jealousyPrompt', 'jealousy_prompt'], '')),
        nextTriggerAt: safeTimestamp(firstDefined(source, ['nextTriggerAt', 'next_trigger_at'], 0)),
        lastTriggerAt: safeTimestamp(firstDefined(source, ['lastTriggerAt', 'last_trigger_at'], 0)),
        claimOwnerId: limitedText(firstDefined(source, ['claimOwnerId', 'claim_owner_id'], ''), 200),
        claimEventId: limitedText(firstDefined(source, ['claimEventId', 'claim_event_id'], ''), 300),
        claimUntil: safeTimestamp(firstDefined(source, ['claimUntil', 'claim_until'], 0)),
        lastCompletedEventId: limitedText(
            firstDefined(source, ['lastCompletedEventId', 'last_completed_event_id'], ''),
            300,
        ),
    };
}

export function memberAutomationKey(groupId, memberAvatar) {
    return `${String(groupId || '').trim()}\u0000${String(memberAvatar || '').trim()}`;
}

/**
 * Build one instruction for one proactive generation. Jealousy is folded into
 * this same instruction and the returned flags explicitly forbid every chain.
 */
export function buildProactivePrompt({
    basePrompt = '',
    jealousyEnabled = false,
    jealousyPrompt = '',
    recentOtherSpeaker = null,
} = {}) {
    const speakerName = typeof recentOtherSpeaker === 'string'
        ? recentOtherSpeaker.trim()
        : String(recentOtherSpeaker?.name || recentOtherSpeaker?.speaker || '').trim();
    const jealousyApplied = Boolean(jealousyEnabled && speakerName);
    const proactiveInstruction = limitedText(basePrompt)
        || '结合当前时间、角色人设和群聊上下文，自然地主动开启或延续一个话题。';
    const jealousyInstruction = jealousyApplied
        ? [
            '[群聊嫉妒联动]',
            `自从你上次发言后，${speakerName}又在群里说了话。`,
            limitedText(jealousyPrompt)
                || '请按照你的人设自然表现一点吃醋、在意或占有欲，但不要解释这是系统要求。',
        ].join(' ')
        : '';
    const prompt = [
        '[ChatPulse 群成员主动消息]',
        proactiveInstruction,
        jealousyInstruction,
        '只输出当前角色本人会发送的一条简短群消息。',
        '这是独立主动消息：不要替其他成员说话，不要模拟多人接龙，不要因 @、红包或任何内容追加第二条消息。',
    ].filter(Boolean).join('\n\n');

    return {
        prompt,
        jealousyApplied,
        suppressChains: true,
        noChain: true,
    };
}

/**
 * Pure claim transition used inside a cross-tab Web Lock.
 *
 * Missed intervals are represented by one stable event id based on the
 * persisted due timestamp. Claiming never manufactures catch-up events.
 */
export function tryClaimDueAutomation({
    record,
    now = Date.now(),
    ownerId,
    leaseMs = 5 * 60 * 1000,
    eventId = '',
} = {}) {
    const normalized = normalizeMemberAutomation(record);
    const safeNow = safeTimestamp(now) || Date.now();
    const owner = String(ownerId || '').trim();
    const dueEventId = String(eventId || `due:${normalized.nextTriggerAt}`).trim();
    const result = {
        claimed: false,
        eventId: dueEventId,
        record: normalized,
        reason: '',
    };

    if (!owner) {
        result.reason = 'owner_missing';
        return result;
    }
    if (!normalized.enabled) {
        result.reason = 'disabled';
        return result;
    }
    if (!normalized.nextTriggerAt || normalized.nextTriggerAt > safeNow) {
        result.reason = 'not_due';
        return result;
    }
    if (normalized.lastCompletedEventId === dueEventId) {
        result.reason = 'already_completed';
        return result;
    }
    if (normalized.claimEventId === dueEventId && normalized.claimUntil > safeNow) {
        result.reason = 'already_claimed';
        return result;
    }

    result.claimed = true;
    result.reason = 'claimed';
    result.record = {
        ...normalized,
        claimOwnerId: owner,
        claimEventId: dueEventId,
        claimUntil: safeNow + Math.max(1000, Number(leaseMs) || 0),
    };
    return result;
}

export function completeAutomationClaim({
    record,
    eventId,
    ownerId,
    now = Date.now(),
    nextIntervalMs,
} = {}) {
    const normalized = normalizeMemberAutomation(record);
    const completedEventId = String(eventId || '').trim();
    const completingOwnerId = String(ownerId || '').trim();
    if (
        !completedEventId
        || !completingOwnerId
        || normalized.claimEventId !== completedEventId
        || normalized.claimOwnerId !== completingOwnerId
    ) {
        return {
            completed: false,
            reason: 'claim_mismatch',
            record: normalized,
        };
    }
    const safeNow = safeTimestamp(now) || Date.now();
    const safeIntervalMs = Math.max(1000, Math.trunc(Number(nextIntervalMs) || 0));
    return {
        completed: true,
        reason: 'completed',
        record: {
            ...normalized,
            nextTriggerAt: safeNow + safeIntervalMs,
            lastTriggerAt: safeNow,
            claimOwnerId: '',
            claimEventId: '',
            claimUntil: 0,
            lastCompletedEventId: completedEventId,
        },
    };
}

export function resolveGroupApiConfig(roleConfig = null) {
    const source = roleConfig && typeof roleConfig === 'object' && !Array.isArray(roleConfig)
        ? roleConfig
        : {};
    const endpoint = String(source.endpoint || source.apiEndpoint || source.api_endpoint || '').trim();
    const model = String(source.model || source.modelName || source.model_name || '').trim();
    const secretId = String(source.secretId || source.secret_id || '').trim();
    const explicitMode = String(source.mode || source.groupApiMode || source.group_api_mode || '').trim().toLowerCase();
    const hasAnyCustomField = Boolean(endpoint || model || secretId);
    const mode = explicitMode === 'custom' || (!explicitMode && hasAnyCustomField)
        ? 'custom'
        : 'st_default';

    if (mode === 'st_default') {
        return {
            mode,
            endpoint: '',
            model: '',
            secretId: '',
            temperature: Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : 0.9,
            maxTokens: clampInteger(source.maxTokens ?? source.max_tokens, 80, 12000, 3000),
        };
    }

    const missing = [
        !endpoint ? 'endpoint' : '',
        !model ? 'model' : '',
        !secretId ? 'secretId' : '',
    ].filter(Boolean);
    if (missing.length) {
        const error = new Error(`角色自定义群聊 API 配置不完整：缺少 ${missing.join('、')}。`);
        error.code = 'GROUP_API_CONFIG_INCOMPLETE';
        error.missing = missing;
        throw error;
    }

    return {
        mode,
        endpoint,
        model,
        secretId,
        temperature: Math.max(0, Math.min(2, Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : 0.9)),
        maxTokens: clampInteger(source.maxTokens ?? source.max_tokens, 80, 12000, 3000),
    };
}

export function buildRoleApiRequest({
    roleConfig = null,
    messages = [],
    responseLength = 3000,
    temperature,
} = {}) {
    const config = resolveGroupApiConfig(roleConfig);
    const safeMessages = Array.isArray(messages) ? messages : [];
    const maxTokens = clampInteger(
        responseLength,
        80,
        12000,
        config.maxTokens,
    );

    if (config.mode === 'st_default') {
        return {
            mode: 'st_default',
            options: {
                prompt: safeMessages,
                responseLength: maxTokens,
                trimNames: false,
            },
        };
    }

    return {
        mode: 'custom',
        options: {
            stream: false,
            messages: safeMessages,
            model: config.model,
            chat_completion_source: 'custom',
            custom_url: config.endpoint,
            secret_id: config.secretId,
            max_tokens: maxTokens,
            temperature: Number.isFinite(Number(temperature))
                ? Math.max(0, Math.min(2, Number(temperature)))
                : config.temperature,
        },
    };
}
