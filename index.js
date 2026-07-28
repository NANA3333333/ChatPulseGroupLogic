import { chat, chat_metadata, characters, default_avatar, default_user_avatar, event_types, eventSource, generateRaw, getRequestHeaders, getThumbnailUrl, this_chid } from '../../../../script.js';
import { ChatCompletionService } from '../../../../scripts/custom-request.js';
import { is_group_generating } from '../../../../scripts/group-chats.js';
import { user_avatar } from '../../../../scripts/personas.js';
import { power_user } from '../../../../scripts/power-user.js';
import { SECRET_KEYS, deleteSecret, rotateSecret, secret_state, writeSecret } from '../../../../scripts/secrets.js';
import { loadWorldInfo, world_info, world_names } from '../../../../scripts/world-info.js';
import {
    buildProactivePrompt,
    buildRoleApiRequest,
    completeAutomationClaim,
    memberAutomationKey,
    normalizeMemberAutomation,
    resolveGroupApiConfig,
    tryClaimDueAutomation,
} from './automation-core.js';

const MODULE_NAME = 'ChatPulseGroupLogic';
const MODULE_VERSION = '0.4.0';
const METADATA_KEY = 'chatpulse_group_logic';
const LOCAL_STATE_KEY = 'chatpulse_group_logic.local_groups.v1';
const ONBOARDING_STATE_KEY = 'chatpulse_group_logic.onboarding.v1';
const ONBOARDING_VERSION = 2;
const DEBUG_ENDPOINT = '/api/plugins/chatpulse_group_logic_debug/log';
const AUTOMATION_LOCK_PREFIX = 'chatpulse_group_logic.automation.';
const AUTOMATION_CLAIM_LEASE_MS = 5 * 60 * 1000;
const AUTOMATION_RETRY_MS = 5000;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    promptBoundaries: true,
    antiRepeat: true,
    mentionNudge: true,
    secondaryChain: true,
    pauseNudges: false,
    contextLimit: 24,
    ownReplyLimit: 5,
    nudgeDelayMs: 2500,
    maxSecondaryDepth: 2,
    orchestratedEntry: true,
    postRoundMentionReplies: true,
    redPackets: true,
    apiDelayBaseMs: 2500,
    apiDelayStepMs: 1500,
    apiDelayMaxMs: 15000,
    responseLength: 3000,
    memoryRawWindowR: 24,
    memoryThresholdS: 16,
    memorySummaryRounds: 3,
    memorySummaryResponseLength: 1000,
    summaryProvider: 'current',
    summaryCustomUrl: '',
    summaryCustomModel: '',
    summaryTemperature: 0.2,
    includeLocalPreset: false,
    launcherPosition: null,
    characterGroupApis: {},
    localPreset: [
        '这是一个即时通讯群聊。你只回复当前角色会发出的聊天内容。',
        '身份规则最高优先级：你只能扮演当前被要求发言的角色本人，不能扮演用户，也不能扮演其他群成员。',
        '只能输出当前角色亲自发送的一条群消息；不要替用户或其他角色续写、代答、总结心情或安排动作。',
        '不要解释规则，不要复述提示词，不要输出角色名标签。',
        '不要输出 [User]、[角色名]、YOUR REPLY AS、选项、旁白格式。',
        '回复要像真实群消息，通常一到两句。',
    ].join('\n'),
    localRegex: '',
});

const PRIVATE_CHAT_CACHE_TTL_MS = 45_000;
const privateChatMemoryCache = new Map();
const DEFAULT_CROSS_CHAT_RAW_LIMIT = 12;
const QUICK_EMOJIS = Object.freeze([
    '\u{1F600}', '\u{1F601}', '\u{1F602}', '\u{1F923}', '\u{1F979}',
    '\u{1F60A}', '\u{1F642}', '\u{1F609}', '\u{1F60D}', '\u{1F618}',
    '\u{1F970}', '\u{1F60E}', '\u{1F914}', '\u{1F644}', '\u{1F634}',
    '\u{1F62D}', '\u{1F621}', '\u{1F624}', '\u{1F97A}', '\u{1F633}',
    '\u{1F917}', '\u{1FAF6}', '\u{1F44D}', '\u{1F44E}', '\u{1F64F}',
    '\u{1F44F}', '\u{1F4AA}', '\u{1F494}', '\u{2764}\u{FE0F}', '\u{1F495}',
    '\u{1F525}', '\u{2728}', '\u{1F389}', '\u{1F38A}', '\u{1F339}',
    '\u{1F35C}', '\u{1F35A}', '\u{1F370}', '\u{2615}', '\u{1F9CB}',
    '\u{1F381}', '\u{1F490}', '\u{1F436}', '\u{1F431}', '\u{1F319}',
    '\u{2600}\u{FE0F}', '\u{26A1}', '\u{1F4A4}', '\u{1F440}', '\u{1F90D}',
]);

const state = {
    pendingMentionJobs: [],
    nudgeTimer: null,
    lastUserMessageId: -1,
    lastProcessedAssistantId: -1,
    secondaryDepth: 0,
    orchestrator: {
        active: false,
        currentInstruction: '',
        currentSourceIndex: -1,
        postRoundMentions: [],
        activeRedPacketId: null,
        redPacketEvents: [],
        queue: {
            active: false,
            stopped: false,
            skipCurrent: false,
            type: '',
            label: '',
            message: '',
            currentIndex: -1,
            currentName: '',
            startedAt: 0,
            finishedAt: 0,
            items: [],
        },
    },
    createMemberAvatars: new Set(),
    createUserPersonaAvatar: '',
    localGroups: [],
    activeGroupId: null,
    typing: [],
    mention: {
        open: false,
        start: -1,
        filter: '',
        index: 0,
        options: [],
    },
    deleteMode: false,
    selectedMessageIds: new Set(),
    debugLogsByGroup: new Map(),
    apiDelayMs: 2500,
    generationCounter: 0,
    debugTapCounter: 0,
    debugErrorProbeBound: false,
    frontendInitialized: false,
    settingsEventsBound: false,
    summaryModelOptions: [],
    summaryModelOptionsKey: '',
    summaryModelOptionsLoading: false,
    summaryModelOptionsError: '',
    summaryModelMenuOpen: false,
    summaryModelFilterActive: false,
    helpPreviousFocus: null,
    automationTimers: new Map(),
    automationActive: false,
    automationOwnerId: '',
    roleApiModelOptions: new Map(),
    onboarding: {
        active: false,
        stepId: '',
        createdGroupId: '',
        autoPrompted: false,
        previousFocus: null,
        positionFrame: 0,
        hostReadyTimer: 0,
        fallbackRecord: null,
    },
};

function getContext() {
    return SillyTavern.getContext();
}

function cloneDefaultSettings() {
    if (typeof structuredClone === 'function') {
        return structuredClone(DEFAULT_SETTINGS);
    }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function hasOwnValue(object, key) {
    if (Object.hasOwn) return Object.hasOwn(object, key);
    return Object.prototype.hasOwnProperty.call(object, key);
}

function getSettings() {
    const ctx = getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = cloneDefaultSettings();
    }
    const settings = ctx.extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!hasOwnValue(settings, key)) {
            settings[key] = value && typeof value === 'object'
                ? (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)))
                : value;
        }
    }
    if (!settings.characterGroupApis || typeof settings.characterGroupApis !== 'object' || Array.isArray(settings.characterGroupApis)) {
        settings.characterGroupApis = {};
    }
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function getMetadata() {
    const ctx = getContext();
    const meta = ctx.chatMetadata || {};
    if (!meta[METADATA_KEY]) {
        meta[METADATA_KEY] = {
            paused: false,
            noChain: false,
            contextLimit: DEFAULT_SETTINGS.contextLimit,
            lastMentionAt: 0,
            redPackets: [],
        };
    }
    if (!Array.isArray(meta[METADATA_KEY].redPackets)) meta[METADATA_KEY].redPackets = [];
    return meta[METADATA_KEY];
}

async function saveMetadata() {
    const ctx = getContext();
    if (typeof ctx.saveMetadata === 'function') {
        await ctx.saveMetadata();
    }
}

function clampInteger(value, min, max, fallback = min) {
    const number = Number.parseInt(value, 10);
    const safe = Number.isFinite(number) ? number : fallback;
    return Math.max(min, Math.min(max, safe));
}

function getDefaultMemoryPermissions(group = {}) {
    const legacyCrossChatEnabled = Number(group?.injectLimit) > 0;
    return {
        exposeGroupMemoryToPrivate: true,
        allowPrivateMemoryInGroup: legacyCrossChatEnabled,
        allowOtherGroupMemoryInGroup: legacyCrossChatEnabled,
    };
}

function getDefaultGroupMemory() {
    return {
        enabled: true,
        rawWindowR: DEFAULT_SETTINGS.memoryRawWindowR,
        thresholdS: DEFAULT_SETTINGS.memoryThresholdS,
        maxSummaryRounds: DEFAULT_SETTINGS.memorySummaryRounds,
        summaryResponseLength: DEFAULT_SETTINGS.memorySummaryResponseLength,
        cursor: 0,
        rounds: [],
        lastError: '',
        updatedAt: 0,
    };
}

function normalizeGroupMemberAutomation(group) {
    if (!group || typeof group !== 'object') return false;
    const legacy = group.memberAutomationSettings && typeof group.memberAutomationSettings === 'object'
        ? group.memberAutomationSettings
        : {};
    const source = group.memberAutomation && typeof group.memberAutomation === 'object' && !Array.isArray(group.memberAutomation)
        ? group.memberAutomation
        : legacy;
    const memberAvatars = [...new Set((Array.isArray(group.members) ? group.members : [])
        .map(member => typeof member === 'string' ? member : member?.avatar)
        .map(value => String(value || '').trim())
        .filter(Boolean))];
    const normalized = {};
    for (const avatar of memberAvatars) {
        normalized[avatar] = normalizeMemberAutomation(source[avatar]);
    }
    const changed = JSON.stringify(source) !== JSON.stringify(normalized)
        || hasOwnValue(group, 'memberAutomationSettings');
    group.memberAutomation = normalized;
    if (hasOwnValue(group, 'memberAutomationSettings')) delete group.memberAutomationSettings;
    return changed;
}

function getMemberAutomation(group, avatar) {
    if (!group || !avatar) return normalizeMemberAutomation();
    normalizeGroupMemberAutomation(group);
    const key = String(avatar);
    group.memberAutomation[key] = normalizeMemberAutomation(group.memberAutomation[key]);
    return group.memberAutomation[key];
}

function updateMemberAutomation(group, avatar, patch = {}) {
    if (!group || !avatar || !(group.members || []).includes(String(avatar))) return null;
    const next = normalizeMemberAutomation({
        ...getMemberAutomation(group, avatar),
        ...(patch && typeof patch === 'object' ? patch : {}),
    });
    group.memberAutomation[String(avatar)] = next;
    return next;
}

function getCharacterGroupApiConfig(characterOrAvatar) {
    const avatar = typeof characterOrAvatar === 'string'
        ? characterOrAvatar
        : String(characterOrAvatar?.avatar || '');
    const stored = getSettings().characterGroupApis?.[avatar];
    if (!stored || typeof stored !== 'object') {
        return {
            mode: 'st_default',
            endpoint: '',
            model: '',
            secretId: '',
            temperature: 0.9,
            maxTokens: DEFAULT_SETTINGS.responseLength,
        };
    }
    return {
        mode: stored.mode === 'custom' ? 'custom' : 'st_default',
        endpoint: String(stored.endpoint || '').trim(),
        model: String(stored.model || '').trim(),
        secretId: String(stored.secretId || '').trim(),
        temperature: Number.isFinite(Number(stored.temperature))
            ? Math.max(0, Math.min(2, Number(stored.temperature)))
            : 0.9,
        maxTokens: clampInteger(stored.maxTokens, 80, 12000, DEFAULT_SETTINGS.responseLength),
    };
}

function getActiveCustomSecretId() {
    const secrets = secret_state?.[SECRET_KEYS.CUSTOM];
    if (!Array.isArray(secrets)) return '';
    return String(secrets.find(secret => secret?.active)?.id || '');
}

async function saveCharacterGroupApiConfig(characterOrAvatar, draft = {}, {
    apiKey = '',
    clearKey = false,
} = {}) {
    const avatar = typeof characterOrAvatar === 'string'
        ? String(characterOrAvatar)
        : String(characterOrAvatar?.avatar || '');
    if (!avatar) throw new Error('找不到要保存群聊 API 的角色。');
    const previous = getCharacterGroupApiConfig(avatar);
    const next = {
        ...previous,
        mode: draft.mode === 'custom' ? 'custom' : 'st_default',
        endpoint: String(draft.endpoint ?? previous.endpoint ?? '').trim(),
        model: String(draft.model ?? previous.model ?? '').trim(),
        temperature: Number.isFinite(Number(draft.temperature))
            ? Math.max(0, Math.min(2, Number(draft.temperature)))
            : previous.temperature,
        maxTokens: clampInteger(
            draft.maxTokens ?? previous.maxTokens,
            80,
            12000,
            DEFAULT_SETTINGS.responseLength,
        ),
    };
    let newSecretId = '';
    let previousActiveSecretId = '';
    const cleanKey = String(apiKey || '').trim();
    if (next.mode === 'custom' && (!next.endpoint || !next.model)) {
        const missing = [!next.endpoint ? 'Endpoint' : '', !next.model ? 'Model' : ''].filter(Boolean);
        throw new Error(`角色自定义群聊 API 配置不完整：缺少 ${missing.join('、')}。`);
    }
    if (next.mode === 'custom' && !cleanKey && !previous.secretId) {
        throw new Error('角色自定义群聊 API 配置不完整：请填写 API Key。');
    }
    try {
        if (next.mode === 'custom' && cleanKey) {
            previousActiveSecretId = getActiveCustomSecretId();
            newSecretId = String(await writeSecret(
                SECRET_KEYS.CUSTOM,
                cleanKey,
                `ChatPulse Group API · ${getCharacterByAvatar(avatar)?.name || avatar}`,
            ) || '');
            if (!newSecretId) throw new Error('API Key 无法写入 SillyTavern Secrets。');
            next.secretId = newSecretId;
            if (previousActiveSecretId && previousActiveSecretId !== newSecretId) {
                await rotateSecret(SECRET_KEYS.CUSTOM, previousActiveSecretId);
            }
        } else if (clearKey) {
            next.secretId = '';
            next.mode = 'st_default';
        }

        if (next.mode === 'custom') resolveGroupApiConfig(next);
        getSettings().characterGroupApis[avatar] = next;
        saveSettings();

        if (newSecretId && previous.secretId && previous.secretId !== newSecretId) {
            await deleteSecret(SECRET_KEYS.CUSTOM, previous.secretId);
        } else if (clearKey && previous.secretId) {
            await deleteSecret(SECRET_KEYS.CUSTOM, previous.secretId);
        }
    } catch (error) {
        if (newSecretId) await deleteSecret(SECRET_KEYS.CUSTOM, newSecretId);
        if (previousActiveSecretId && previousActiveSecretId !== newSecretId) {
            await rotateSecret(SECRET_KEYS.CUSTOM, previousActiveSecretId);
        }
        throw error;
    }
    return getCharacterGroupApiConfig(avatar);
}

async function loadCharacterGroupApiModels(characterOrAvatar) {
    const config = resolveGroupApiConfig(getCharacterGroupApiConfig(characterOrAvatar));
    if (config.mode !== 'custom') throw new Error('请先为这个角色保存自定义群聊 API。');
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: config.endpoint,
            secret_id: config.secretId,
        }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) {
        throw new Error(data?.message || data?.error?.message || response.statusText || '模型列表读取失败。');
    }
    return extractSummaryModelOptions(data);
}

function normalizeWorldInfoNameList(names) {
    const source = Array.isArray(names) ? names : [];
    return [...new Set(source.map(name => String(name || '').trim()).filter(Boolean))];
}

function getAvailableWorldInfoNames() {
    return normalizeWorldInfoNameList(world_names);
}

function isKnownWorldInfoName(name) {
    const available = getAvailableWorldInfoNames();
    return available.length === 0 || available.includes(String(name || '').trim());
}

function normalizeGroupWorldInfo(group) {
    if (!group || typeof group !== 'object') return;
    group.worldInfoBooks = normalizeWorldInfoNameList(group.worldInfoBooks);
    group.includeCharacterWorldInfo = group.includeCharacterWorldInfo !== false;
}

function getAvailableUserPersonas() {
    const personas = power_user?.personas && typeof power_user.personas === 'object' ? power_user.personas : {};
    const descriptions = power_user?.persona_descriptions && typeof power_user.persona_descriptions === 'object'
        ? power_user.persona_descriptions
        : {};
    return Object.entries(personas)
        .map(([avatar, name]) => ({
            avatar: String(avatar || '').trim(),
            name: normalizeText(name) || String(avatar || '').trim(),
            title: normalizeText(descriptions[avatar]?.title || ''),
            description: String(descriptions[avatar]?.description || '').trim(),
        }))
        .filter(persona => persona.avatar)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function isKnownUserPersonaAvatar(avatar) {
    const personas = power_user?.personas && typeof power_user.personas === 'object' ? power_user.personas : {};
    return !!avatar && hasOwnValue(personas, avatar);
}

function getDefaultUserPersonaAvatar() {
    const candidates = [
        String(user_avatar || '').trim(),
        String(power_user?.default_persona || '').trim(),
    ].filter(Boolean);
    const explicit = candidates.find(isKnownUserPersonaAvatar);
    if (explicit) return explicit;
    return getAvailableUserPersonas()[0]?.avatar || '';
}

function resolveUserPersonaAvatar(avatar) {
    const value = String(avatar || '').trim();
    if (isKnownUserPersonaAvatar(value)) return value;
    return getDefaultUserPersonaAvatar();
}

function normalizeGroupUserPersona(group) {
    if (!group || typeof group !== 'object') return '';
    const legacyAvatar = group.userPersona?.avatar || group.userAvatar || group.personaAvatar || '';
    const avatar = resolveUserPersonaAvatar(group.userPersonaAvatar || legacyAvatar);
    group.userPersonaAvatar = avatar || '';
    return group.userPersonaAvatar;
}

function normalizeGroupMemory(group) {
    if (!group || typeof group !== 'object') return null;
    // Prompts may contain private-memory excerpts. Debug records are session-only;
    // remove any copies written by older versions from persisted group data.
    if (hasOwnValue(group, 'debugLogs')) delete group.debugLogs;
    normalizeGroupUserPersona(group);
    normalizeGroupWorldInfo(group);
    normalizeGroupMemberAutomation(group);
    const defaults = getDefaultGroupMemory();
    if (!group.memory || typeof group.memory !== 'object' || Array.isArray(group.memory)) {
        group.memory = {};
    }
    const memory = group.memory;
    for (const [key, value] of Object.entries(defaults)) {
        if (!hasOwnValue(memory, key)) memory[key] = value;
    }
    memory.enabled = memory.enabled !== false;
    memory.rawWindowR = clampInteger(memory.rawWindowR, 4, 120, DEFAULT_SETTINGS.memoryRawWindowR);
    memory.thresholdS = clampInteger(memory.thresholdS, 4, 80, DEFAULT_SETTINGS.memoryThresholdS);
    memory.maxSummaryRounds = clampInteger(memory.maxSummaryRounds, 1, 6, DEFAULT_SETTINGS.memorySummaryRounds);
    memory.summaryResponseLength = clampInteger(memory.summaryResponseLength, 400, 3000, DEFAULT_SETTINGS.memorySummaryResponseLength);
    memory.cursor = clampInteger(memory.cursor, 0, Math.max(0, (group.messages || []).length), 0);
    memory.lastError = String(memory.lastError || '');
    memory.updatedAt = Number(memory.updatedAt) || 0;
    memory.rounds = Array.isArray(memory.rounds)
        ? memory.rounds
            .map((round, index) => ({
                id: String(round?.id || `mem_${index}`),
                from: Math.max(0, Number(round?.from) || 0),
                to: Math.max(0, Number(round?.to) || 0),
                text: normalizeText(round?.text || ''),
                createdAt: Number(round?.createdAt) || Date.now(),
            }))
            .filter(round => round.text)
        : [];

    const permissionDefaults = getDefaultMemoryPermissions(group);
    if (!group.memoryPermissions || typeof group.memoryPermissions !== 'object' || Array.isArray(group.memoryPermissions)) {
        group.memoryPermissions = {};
    }
    for (const [key, value] of Object.entries(permissionDefaults)) {
        if (!hasOwnValue(group.memoryPermissions, key)) group.memoryPermissions[key] = value;
    }
    group.memoryPermissions.exposeGroupMemoryToPrivate = group.memoryPermissions.exposeGroupMemoryToPrivate !== false;
    group.memoryPermissions.allowPrivateMemoryInGroup = !!group.memoryPermissions.allowPrivateMemoryInGroup;
    group.memoryPermissions.allowOtherGroupMemoryInGroup = !!group.memoryPermissions.allowOtherGroupMemoryInGroup;
    return group.memory;
}

function loadLocalState() {
    try {
        const raw = localStorage.getItem(LOCAL_STATE_KEY);
        const data = raw ? JSON.parse(raw) : {};
        state.localGroups = Array.isArray(data.groups) ? data.groups : [];
        const hadPersistedDebugLogs = state.localGroups.some(group => hasOwnValue(group || {}, 'debugLogs'));
        const hadPersistedMemoryErrors = state.localGroups.some(group => hasOwnValue(group?.memory || {}, 'lastError'));
        const hadAutomationMigration = state.localGroups
            .map(normalizeGroupMemberAutomation)
            .some(Boolean);
        state.localGroups.forEach(normalizeGroupMemory);
        state.localGroups.forEach(group => {
            if (group?.memory) group.memory.lastError = '';
        });
        const requestedGroupId = data.activeGroupId;
        state.activeGroupId = state.localGroups.some(group => String(group?.id) === String(requestedGroupId))
            ? requestedGroupId
            : state.localGroups[0]?.id || null;
        if (hadPersistedDebugLogs || hadPersistedMemoryErrors || hadAutomationMigration) saveLocalState();
    } catch (error) {
        console.warn('[ChatPulseGroupLogic] Failed to load local state:', error);
        state.localGroups = [];
        state.activeGroupId = null;
    }
}

function serializeLocalGroup(group) {
    const persistedGroup = { ...group };
    if (group?.memory && typeof group.memory === 'object' && !Array.isArray(group.memory)) {
        persistedGroup.memory = { ...group.memory };
        delete persistedGroup.memory.lastError;
    }
    delete persistedGroup.debugLogs;
    return persistedGroup;
}

function readPersistedLocalState() {
    try {
        const raw = localStorage.getItem(LOCAL_STATE_KEY);
        const data = raw ? JSON.parse(raw) : {};
        return {
            groups: Array.isArray(data.groups) ? data.groups : [],
            activeGroupId: data.activeGroupId || null,
        };
    } catch (error) {
        console.warn('[ChatPulseGroupLogic] Failed to read persisted local state:', error);
        return { groups: [], activeGroupId: null };
    }
}

function writePersistedLocalState(data) {
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify({
        groups: (Array.isArray(data?.groups) ? data.groups : []).map(serializeLocalGroup),
        activeGroupId: data?.activeGroupId || null,
    }));
}

function hasPersistedAutomationClaim(groupId = null) {
    const now = Date.now();
    return readPersistedLocalState().groups.some(group => {
        if (groupId != null && String(group?.id) !== String(groupId)) return false;
        const records = group?.memberAutomation && typeof group.memberAutomation === 'object'
            ? Object.values(group.memberAutomation)
            : [];
        return records.some(value => {
            const record = normalizeMemberAutomation(value);
            return !!record.claimOwnerId && !!record.claimEventId && record.claimUntil > now;
        });
    });
}

function adoptPersistedLocalState(data, {
    preserveActiveGroup = true,
    preserveTargetReference = null,
} = {}) {
    const previousActiveGroupId = state.activeGroupId;
    const persistedGroups = Array.isArray(data?.groups) ? data.groups : [];
    const targetId = String(preserveTargetReference?.id || '');
    state.localGroups = persistedGroups.map(group => {
        normalizeGroupMemory(group);
        if (targetId && String(group?.id) === targetId) {
            for (const key of Object.keys(preserveTargetReference)) delete preserveTargetReference[key];
            Object.assign(preserveTargetReference, group);
            return preserveTargetReference;
        }
        return group;
    });
    const requestedActiveId = preserveActiveGroup ? previousActiveGroupId : data?.activeGroupId;
    state.activeGroupId = state.localGroups.some(group => String(group?.id) === String(requestedActiveId))
        ? requestedActiveId
        : state.localGroups[0]?.id || null;
}

function saveLocalState() {
    writePersistedLocalState({
        groups: state.localGroups,
        activeGroupId: state.activeGroupId,
    });
}

function createDefaultOnboardingRecord() {
    return {
        version: ONBOARDING_VERSION,
        status: 'new',
        stepId: 'welcome',
        createdGroupId: '',
        draft: {
            name: '',
            personaAvatar: '',
            memberAvatars: [],
        },
        updatedAt: Date.now(),
    };
}

function normalizeOnboardingRecord(record) {
    const source = record && typeof record === 'object' ? record : {};
    if (Number(source.version) !== ONBOARDING_VERSION) return createDefaultOnboardingRecord();
    const validStatuses = new Set(['new', 'active', 'paused', 'completed', 'skipped', 'existing-user']);
    const validSteps = new Set([
        'welcome',
        'entry',
        'create',
        'name',
        'persona',
        'members',
        'confirm',
        'composer',
        'quick-tools',
        'delete-messages',
        'manage',
        'manager-overview',
        'member-automation',
        'member-api',
        'help',
    ]);
    const draft = source.draft && typeof source.draft === 'object' ? source.draft : {};
    return {
        version: ONBOARDING_VERSION,
        status: validStatuses.has(source.status) ? source.status : 'new',
        stepId: validSteps.has(source.stepId) ? source.stepId : 'welcome',
        createdGroupId: String(source.createdGroupId || ''),
        draft: {
            name: String(draft.name || ''),
            personaAvatar: String(draft.personaAvatar || ''),
            memberAvatars: Array.isArray(draft.memberAvatars)
                ? [...new Set(draft.memberAvatars.map(value => String(value || '')).filter(Boolean))]
                : [],
        },
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
}

function readOnboardingRecord() {
    try {
        const raw = localStorage.getItem(ONBOARDING_STATE_KEY);
        if (!raw) return normalizeOnboardingRecord(state.onboarding.fallbackRecord);
        const record = normalizeOnboardingRecord(JSON.parse(raw));
        state.onboarding.fallbackRecord = record;
        return record;
    } catch (error) {
        console.warn('[ChatPulseGroupLogic] Failed to read onboarding state:', error);
        return normalizeOnboardingRecord(state.onboarding.fallbackRecord);
    }
}

function writeOnboardingRecord(patch = {}) {
    const current = readOnboardingRecord();
    const next = normalizeOnboardingRecord({
        ...current,
        ...patch,
        draft: patch.draft ? { ...current.draft, ...patch.draft } : current.draft,
        version: ONBOARDING_VERSION,
        updatedAt: Date.now(),
    });
    state.onboarding.fallbackRecord = next;
    try {
        localStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify(next));
    } catch (error) {
        console.warn('[ChatPulseGroupLogic] Failed to save onboarding state:', error);
    }
    return next;
}

function saveOnboardingDraft() {
    if (!state.onboarding.active) return;
    writeOnboardingRecord({
        status: 'active',
        stepId: state.onboarding.stepId,
        createdGroupId: state.onboarding.createdGroupId,
        draft: {
            name: String($('#cpgl_new_group_name').val() || ''),
            personaAvatar: String($('#cpgl_new_user_persona').val() || state.createUserPersonaAvatar || ''),
            memberAvatars: [...state.createMemberAvatars],
        },
    });
}

function restoreOnboardingDraft() {
    const record = readOnboardingRecord();
    if (!record.draft) return;
    const knownCharacterAvatars = new Set(characters.map(character => String(character?.avatar || '')).filter(Boolean));
    state.createMemberAvatars = new Set(record.draft.memberAvatars.filter(avatar => knownCharacterAvatars.has(avatar)));
    state.createUserPersonaAvatar = resolveUserPersonaAvatar(record.draft.personaAvatar || getDefaultUserPersonaAvatar());
    $('#cpgl_new_group_name').val(record.draft.name || '');
}

function getCurrentGroup() {
    if (!state.activeGroupId) return null;
    const group = state.localGroups.find(group => String(group.id) === String(state.activeGroupId)) || null;
    if (group) normalizeGroupMemory(group);
    return group;
}

function getGroupById(groupId) {
    const group = state.localGroups.find(group => String(group.id) === String(groupId)) || null;
    if (group) normalizeGroupMemory(group);
    return group;
}

function getCharacterIndexFromMember(member) {
    if (typeof member === 'number') return member;
    const avatar = typeof member === 'string' ? member : member?.avatar;
    if (!avatar) return -1;
    return characters.findIndex(character => String(character.avatar) === String(avatar));
}

function getGroupCharacters(group = getCurrentGroup()) {
    if (!group || !Array.isArray(group.members)) return [];
    return group.members
        .map(member => {
            const index = getCharacterIndexFromMember(member);
            const character = characters[index];
            return character ? { index, character } : null;
        })
        .filter(Boolean);
}

function getCharacterByAvatar(avatar) {
    return characters.find(character => String(character.avatar) === String(avatar)) || null;
}

function getCharacterAvatarUrl(character) {
    if (!character?.avatar || character.avatar === 'none') return default_avatar;
    return getThumbnailUrl('avatar', character.avatar);
}

function getUserPersonaByAvatar(avatar) {
    const value = String(avatar || '').trim();
    const persona = getAvailableUserPersonas().find(item => item.avatar === value);
    if (persona) return persona;
    return {
        avatar: value,
        name: normalizeText(power_user?.personas?.[value]) || normalizeText(getContext()?.name1) || 'User',
        title: '',
        description: value ? String(power_user?.persona_descriptions?.[value]?.description || '').trim() : String(power_user?.persona_description || '').trim(),
        missing: !!value,
    };
}

function getGroupUserPersonaAvatar(group = getCurrentGroup()) {
    return group ? normalizeGroupUserPersona(group) : getDefaultUserPersonaAvatar();
}

function getGroupUserPersona(group = getCurrentGroup()) {
    return getUserPersonaByAvatar(getGroupUserPersonaAvatar(group));
}

function getGroupUserName(group = getCurrentGroup()) {
    return getGroupUserPersona(group).name || getUserName();
}

function getGroupUserEntityId(group = getCurrentGroup()) {
    const avatar = getGroupUserPersonaAvatar(group);
    return `user:${avatar || 'default'}`;
}

function getCurrentPrivatePersonaAvatar() {
    const lockedAvatar = String(chat_metadata?.persona || '').trim();
    return isKnownUserPersonaAvatar(lockedAvatar) ? lockedAvatar : '';
}

function hasSameUserPersona(leftGroup, rightGroup) {
    const leftAvatar = String(getGroupUserPersonaAvatar(leftGroup) || '');
    const rightAvatar = String(getGroupUserPersonaAvatar(rightGroup) || '');
    return !!leftAvatar && leftAvatar === rightAvatar;
}

function privateChatHeaderMatchesGroupPersona(header, group) {
    const expectedAvatar = getGroupUserPersonaAvatar(group);
    const lockedAvatar = String(header?.chat_metadata?.persona || '').trim();
    if (!lockedAvatar) return false;
    return String(lockedAvatar) === String(expectedAvatar || '');
}

function getUserClaimIds(group = getCurrentGroup()) {
    return [...new Set(['user', getGroupUserEntityId(group)].filter(Boolean))];
}

function isUserClaimId(value, group = getCurrentGroup()) {
    return getUserClaimIds(group).includes(String(value || ''));
}

function getUserMessageName(message = null, group = getCurrentGroup()) {
    return getMessageSpeaker(message) || getGroupUserName(group);
}

function getUserMessagePersonaAvatar(message = null, group = getCurrentGroup()) {
    const avatar = String(message?.userPersonaAvatar || (message?.avatar && message.avatar !== 'user' ? message.avatar : '') || '').trim();
    return resolveUserPersonaAvatar(avatar || getGroupUserPersonaAvatar(group));
}

function getUserAvatarUrl(group = getCurrentGroup(), message = null) {
    const avatar = getUserMessagePersonaAvatar(message, group);
    return avatar ? getThumbnailUrl('persona', avatar) : default_user_avatar || default_avatar;
}

function getCharacterIndexByAvatar(avatar) {
    return characters.findIndex(character => String(character.avatar) === String(avatar));
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripPipeMetadataTags(value) {
    return String(value || '')
        .replace(/\[(?:群聊消息|group\s*message|chat\s*message)\|[^\]|]*\|[^\]|]*\|([^\]]*?)\]/gi, '$1')
        .replace(/\[[^\]\n]{1,40}\|[^\]\n]{1,40}\|[^\]\n]{1,40}\|([^\]]{1,1200}?)\]/g, '$1');
}

function stripTags(value) {
    return stripPipeMetadataTags(value)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\{\{[^}]+?\}\}/g, '')
        .replace(/\[[A-Z_]+:[^\]]*?\]/g, '')
        .replace(/\[[A-Z_]+\]/g, '')
        .replace(/<\/?[^>]+>/g, '')
        .trim();
}

function compactPreview(value, maxLength = 36) {
    const text = stripTags(value);
    if (!text) return '';
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trim()}...`;
}

function getMessageSpeaker(message) {
    if (!message) return '';
    return String(message.name || message.extra?.display_name || '').trim();
}

function getUserName() {
    const ctx = getContext();
    return String(ctx.name1 || ctx.power_user?.persona?.name || 'User').trim();
}

function getCurrentMessages() {
    return getCurrentGroup()?.messages || [];
}

function appendLocalMessage(group, message) {
    if (!group) return -1;
    if (!Array.isArray(group.messages)) group.messages = [];
    group.messages.push({
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        ...message,
    });
    saveLocalState();
    renderChatMessages();
    renderMessageDeleteList();
    return group.messages.length - 1;
}

function findReusableUserMessageIndex(group, text) {
    const messages = Array.isArray(group?.messages) ? group.messages : [];
    const normalizedText = normalizeText(text);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.is_system) continue;
        if (!message.is_user) return -1;
        return normalizeText(message.mes) === normalizedText ? index : -1;
    }
    return -1;
}

function appendSystemGroupMessage(group, content) {
    return appendLocalMessage(group, {
        is_system: true,
        name: 'System',
        avatar: '',
        mes: `[System] ${content}`,
    });
}

function formatMessageTime(timestamp) {
    const date = timestamp ? new Date(timestamp) : new Date();
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getMessagePreview(message, group = getCurrentGroup()) {
    if (!message) return '';
    const packetId = parseRedPacketMessage(message.mes);
    if (packetId) {
        const packet = getRedPacket(packetId);
        return packet ? `红包：${packet.note || packet.senderName || packet.id}` : '红包消息';
    }
    if (message.is_system) return stripTags(message.mes).replace(/^\[System\]\s*/i, '').trim();
    const speaker = getMessageSpeaker(message) || (message.is_user ? getGroupUserName(group) : 'Unknown');
    return message.is_user ? stripTags(message.mes) : sanitizeLocalReply(message.mes, speaker);
}

function appendDebugLog(group, log) {
    if (!group) return;
    const groupId = String(group.id || '');
    const logs = state.debugLogsByGroup.get(groupId) || [];
    logs.push({
        id: `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        ...log,
    });
    state.debugLogsByGroup.set(groupId, logs.slice(-12));
    renderDebugLogs();
}

function applyLocalRegex(text) {
    const rulesText = getSettings().localRegex || '';
    let output = String(text || '');
    for (const line of rulesText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split('=>');
        if (parts.length < 2) continue;
        const pattern = parts.shift().trim();
        const replacement = parts.join('=>').trim();
        try {
            output = output.replace(new RegExp(pattern, 'g'), replacement);
        } catch {
            // Ignore malformed user-imported regex lines.
        }
    }
    return output.trim();
}

function sanitizeLocalReply(text, characterName = '') {
    let output = extractFinalReplyCandidate(stripTags(text))
        .replace(/<game>/gi, '')
        .replace(/<\/game>/gi, '')
        .replace(/\{\{[^}]+?\}\}/g, '')
        .replace(/\(YOUR REPLY AS[^)]*\)/gi, '')
        .replace(/YOUR REPLY AS[^\n。！？.!?]*/gi, '')
        .replace(/^[\s\S]*?(?:输出消息文本[:：]|最终回复[:：]|回复[:：])\s*/i, '')
        .replace(/^\s*\[(?:User|用户|system|assistant|角色|当前说话角色|最近群聊记录|群聊名称)[^\]]*\]\s*/gmi, '')
        .trim();

    const escapedName = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escapedName) {
        output = output
            .replace(new RegExp(`^\\s*\\[${escapedName}\\]\\s*`, 'gmi'), '')
            .replace(new RegExp(`^\\s*${escapedName}\\s*[:：]\\s*`, 'gmi'), '');
    }

    output = output
        .replace(/^\s*\[[^\]]{1,40}\]\s*/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const hardLeak = /(getvar::prefill|YOUR REPLY AS|生成一条群聊消息|当前说话角色|最近聊天|专用预设|本轮要求|群聊消息\|)/i;
    const lines = output.split('\n')
        .map(line => line.trim())
        .filter(line => line && !hardLeak.test(line));

    return lines.join('\n').trim();
}

function extractFinalReplyCandidate(text) {
    let output = String(text || '').trim();
    if (!output) return '';

    const hasDraftMarkers = /\b(?:Draft|Wait|Let's refine|Refined|Final|final answer|最终|草稿|润色)\b/i.test(output);
    if (hasDraftMarkers) {
        const quoted = [...output.matchAll(/[“"「『](.{2,1200}?)[”"」』]/gs)]
            .map(match => match[1].trim())
            .filter(Boolean);
        if (quoted.length) return quoted[quoted.length - 1];

        const finalMatch = output.match(/(?:Final|最终|成品|回复)[:：]\s*([\s\S]+)$/i);
        if (finalMatch?.[1]) return finalMatch[1].trim();

        const paragraphs = output.split(/\n{2,}|\n(?=(?:Draft|Wait|Let's refine|Refined|Final|最终|草稿|润色)[:：]?)/i)
            .map(item => item.trim())
            .filter(Boolean);
        const candidate = [...paragraphs].reverse().find(item => /[\u4e00-\u9fff]/.test(item) && !/\b(?:Draft|Wait|Let's refine|prompt asks|refine)\b/i.test(item));
        if (candidate) return candidate;
    }

    return output;
}

function shouldRetryLocalReply(raw, sanitized, characterName = '', group = getCurrentGroup()) {
    const value = String(raw || '');
    if (!String(sanitized || '').trim()) return true;
    const leakSignals = [
        /getvar::prefill/i,
        /YOUR REPLY AS/i,
        /生成一条群聊消息/i,
        /\b(?:Draft|Wait|Let's refine|prompt asks|Final answer)\b/i,
        /提示词|系统|模型|后台|请求.*矛盾/i,
    ];
    return leakSignals.some(regex => regex.test(value))
        || isOocOrMetaReply(sanitized)
        || hasSpeakerPrefixLeak(sanitized, characterName, group);
}

function isOocOrMetaReply(text) {
    const value = String(text || '').trim();
    if (!value) return true;
    const compact = value.replace(/\s+/g, ' ');
    const badPatterns = [
        /^直接(?:给出|输出|发)?(?:结果|消息|内容)/i,
        /(?:上一段|上[一1]段|群聊).*聊天记录/i,
        /\[(?:群聊消息|group\s*message|chat\s*message)\|/i,
        /请给我.*(?:聊天记录|内容|结果)/i,
        /如果包含表情|标准的?emoji|心理活动|字数限制|单条常见长度/i,
        /不要(?:写|输出|解释|复述|包含)|只(?:写|输出)|规则|提示词|格式/i,
        /^(?:vibe|soliumbra|draft|final|raw output|sanitized)\.?$/i,
        /^(?:好的|明白|收到)[，,。!！\s]*(?:我会|现在|直接|马上)/i,
    ];
    return badPatterns.some(regex => regex.test(compact));
}

function hasSpeakerPrefixLeak(text, currentCharacterName = '', group = getCurrentGroup()) {
    const value = String(text || '');
    if (!value.trim()) return false;
    const memberNames = getGroupCharacters(group)
        .map(({ character }) => character?.name)
        .filter(Boolean);
    const knownNames = [...new Set([getGroupUserName(group), ...memberNames].filter(Boolean))];
    const escapedCurrent = String(currentCharacterName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixLines = value.split('\n')
        .map(line => line.trim())
        .filter(line => /^[^\s:：]{1,40}\s*[:：]/.test(line));
    if (prefixLines.length >= 2) return true;
    return knownNames.some(name => {
        if (!name || name === currentCharacterName) return false;
        const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:：]`).test(value);
    }) || (escapedCurrent && new RegExp(`(?:^|\\n)\\s*${escapedCurrent}\\s*[:：].*(?:\\n\\s*[^\\s:：]{1,40}\\s*[:：])`, 's').test(value));
}

function limitText(value, maxLength = 6000) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trim()}\n...`;
}

function buildCharacterCardBlock(character) {
    const data = character?.data || {};
    const depthPrompt = data?.extensions?.depth_prompt;
    const parts = [
        ['角色名', character?.name],
        ['角色描述', character?.description || data.description],
        ['性格', character?.personality || data.personality],
        ['场景', character?.scenario || data.scenario],
        ['开场白', character?.first_mes || data.first_mes],
        ['示例对话', character?.mes_example || data.mes_example],
        ['角色系统提示', character?.system_prompt || data.system_prompt],
        ['历史后置指令', character?.post_history_instructions || data.post_history_instructions],
        ['角色深度提示', depthPrompt?.prompt],
        ['创作者备注', data.creator_notes || character?.creatorcomment],
    ]
        .map(([label, value]) => {
            const text = limitText(value, label === '示例对话' ? 2500 : 1600);
            return text ? `【${label}】\n${text}` : '';
        })
        .filter(Boolean);
    return parts.length ? parts.join('\n\n') : '';
}

function buildUserPersonaBlock(group = getCurrentGroup()) {
    const persona = getGroupUserPersona(group);
    const name = persona.name || getUserName();
    const personaDescription = [
        persona.description,
        !persona.avatar ? power_user?.persona_description : '',
    ]
        .map(value => limitText(value, 1800))
        .find(Boolean);
    return [
        '[当前用户人设]',
        `用户名称：${name}`,
        persona.avatar ? `绑定人设：${persona.name} (${persona.avatar})` : '',
        personaDescription ? `用户设定：\n${personaDescription}` : '',
    ].filter(Boolean).join('\n');
}

function applyLocalPromptMacros(value, character, group = getCurrentGroup()) {
    const characterName = normalizeText(character?.name) || 'Character';
    const userName = getGroupUserName(group);
    return String(value || '')
        .replace(/\{\{\s*char\s*\}\}/gi, characterName)
        .replace(/\{\{\s*user\s*\}\}/gi, userName)
        .replace(/<\s*char\s*>/gi, characterName)
        .replace(/<\s*user\s*>/gi, userName);
}

function getCharacterWorldNames(character) {
    const names = [];
    const primary = character?.data?.extensions?.world;
    if (primary) names.push(primary);
    const avatarBase = String(character?.avatar || '').replace(/\.[^.]+$/, '');
    const extra = world_info?.charLore?.find(item => String(item.name) === avatarBase);
    if (extra && Array.isArray(extra.extraBooks)) names.push(...extra.extraBooks);
    return normalizeWorldInfoNameList(names).filter(isKnownWorldInfoName);
}

function getSelectedGroupWorldInfoNames(group) {
    normalizeGroupWorldInfo(group);
    return normalizeWorldInfoNameList(group?.worldInfoBooks).filter(isKnownWorldInfoName);
}

function getGroupWorldInfoSelection(group, character) {
    const groupNames = getSelectedGroupWorldInfoNames(group);
    const characterNames = group?.includeCharacterWorldInfo === false ? [] : getCharacterWorldNames(character);
    return {
        groupNames,
        characterNames,
        worldNames: normalizeWorldInfoNameList([...groupNames, ...characterNames]).filter(isKnownWorldInfoName),
    };
}

function worldEntryMatches(entry, searchText) {
    if (!entry || entry.disable) return false;
    if (entry.constant || entry.alwaysActive) return true;
    const keys = [
        ...(Array.isArray(entry.key) ? entry.key : []),
        ...(Array.isArray(entry.keys) ? entry.keys : []),
    ]
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean);
    if (!keys.length) return false;
    const haystack = String(searchText || '').toLowerCase();
    return keys.some(key => haystack.includes(key));
}

async function buildGroupWorldInfoBlock(group, character, searchText) {
    const selection = getGroupWorldInfoSelection(group, character);
    const { worldNames, groupNames } = selection;
    if (!worldNames.length) return '';
    const lines = [];
    for (const worldName of worldNames) {
        let book;
        try {
            book = await loadWorldInfo(worldName);
        } catch (error) {
            console.warn(`[ChatPulseGroupLogic] Failed to load world info "${worldName}":`, error);
            continue;
        }
        const entries = book?.entries ? Object.values(book.entries) : [];
        for (const entry of entries) {
            if (!worldEntryMatches(entry, searchText)) continue;
            const content = limitText(entry.content || entry.comment || '', 1200);
            if (!content) continue;
            lines.push(`[${worldName}] ${content}`);
            if (lines.length >= 12) break;
        }
        if (lines.length >= 12) break;
    }
    if (!lines.length) return '';
    const hasGroupBooks = groupNames.length > 0;
    return [
        hasGroupBooks ? '[当前群聊/角色世界书]' : '[当前角色绑定世界书]',
        hasGroupBooks
            ? '以下来自当前群聊选择的世界书，以及当前发言角色绑定的世界书（如果启用）。把它当作设定背景，不要复述来源标签。'
            : '以下只来自当前发言角色绑定的世界书。把它当作设定背景，不要复述来源标签。',
        ...lines,
    ].join('\n');
}

function formatMemoryLine(message, fallbackName = 'Unknown', group = getCurrentGroup()) {
    if (message?.is_system) {
        const content = stripTags(message.mes).replace(/^\[System\]\s*/i, '').trim();
        return content ? `[System] ${content}` : '';
    }
    const speaker = getMessageSpeaker(message) || (message.is_user ? getGroupUserName(group) : fallbackName);
    const packetId = parseRedPacketMessage(message.mes);
    if (packetId) {
        const packet = getRedPacket(packetId);
        return packet ? `${speaker}: 发了一个${packet.mode === 'equal' ? '普通' : '拼手气'}红包，${packet.total.toFixed(2)} 元/${packet.count} 份，留言：${packet.note}` : `${speaker}: 发了一个红包`;
    }
    const content = message.is_user ? stripTags(message.mes) : sanitizeLocalReply(message.mes, speaker);
    if (!content || isOocOrMetaReply(content)) return '';
    return `${speaker}: ${content}`;
}

function getGroupActivityAt(group) {
    const messages = Array.isArray(group?.messages) ? group.messages : [];
    const lastMessageAt = getMessageTimestamp(messages[messages.length - 1]);
    return Math.max(
        Number(lastMessageAt) || 0,
        Number(group?.memory?.updatedAt) || 0,
        Number(group?.createdAt) || 0,
    );
}

function getLocalGroupMemoryLines(character, currentGroup, limit) {
    const targetAvatar = character?.avatar;
    if (!targetAvatar || limit <= 0) return [];
    const lines = [];
    const groupsByActivity = [...state.localGroups].sort((left, right) => getGroupActivityAt(left) - getGroupActivityAt(right));
    for (const group of groupsByActivity) {
        if (!group || String(group.id) === String(currentGroup?.id)) continue;
        if (!hasSameUserPersona(group, currentGroup)) continue;
        if (!Array.isArray(group.members) || !group.members.includes(targetAvatar)) continue;
        const recent = (group.messages || [])
            .filter(message => message && !message.is_system && normalizeText(message.mes))
            .slice(-limit);
        for (const message of recent) {
            const line = formatMemoryLine(message, character.name, group);
            if (line) lines.push(`[群:${group.name || group.id}] ${line}`);
        }
    }
    return lines.slice(-limit);
}

function getCurrentPrivateMemoryLines(character, limit, group = getCurrentGroup()) {
    if (!character || limit <= 0 || this_chid === null || this_chid === undefined) return [];
    const currentPersonaAvatar = getCurrentPrivatePersonaAvatar();
    if (!currentPersonaAvatar) return [];
    if (String(currentPersonaAvatar) !== String(getGroupUserPersonaAvatar(group) || '')) return [];
    const activeCharacter = characters[this_chid];
    if (!activeCharacter || String(activeCharacter.avatar) !== String(character.avatar)) return [];
    return (Array.isArray(chat) ? chat : [])
        .filter(message => message && !message.is_system && normalizeText(message.mes))
        .slice(-limit)
        .map(message => {
            const speaker = message.is_user ? getMessageSpeaker(message) || getGroupUserName(group) : character.name;
            const content = message.is_user ? stripTags(message.mes) : sanitizeLocalReply(message.mes, character.name);
            if (!content || isOocOrMetaReply(content)) return '';
            return `[私聊:${character.name}] ${speaker}: ${content}`;
        })
        .filter(Boolean);
}

function getMessageTimestamp(message) {
    if (!message) return 0;
    const raw = message.send_date || message.timestamp || message.extra?.send_date || message.extra?.timestamp;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

function privateChatFileId(file) {
    const raw = String(file?.file_id || file?.file_name || '').trim();
    return raw.replace(/\.jsonl$/i, '');
}

async function fetchPrivateChatFiles(character) {
    if (!character?.avatar) return [];
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar, metadata: false }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data
        .map(file => ({
            id: privateChatFileId(file),
            lastMes: Number(file.last_mes) || Date.parse(file.last_mes) || 0,
            messageCount: Number(file.chat_items) || 0,
        }))
        .filter(file => file.id)
        .sort((a, b) => b.lastMes - a.lastMes || b.messageCount - a.messageCount);
}

async function fetchPrivateChatFile(character, fileId) {
    if (!character?.avatar || !fileId) return { header: {}, messages: [] };
    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar, file_name: fileId }),
    });
    if (!response.ok) return { header: {}, messages: [] };
    const data = await response.json();
    if (!Array.isArray(data)) return { header: {}, messages: [] };
    const header = data.find(item => item?.chat_metadata || item?.user_name || item?.character_name) || {};
    const messages = data.filter(item => item && !item.chat_metadata && (hasOwnValue(item, 'mes') || hasOwnValue(item, 'is_user')));
    return { header, messages };
}

async function getAllPrivateMemoryLines(character, limit, group = getCurrentGroup()) {
    if (!character || limit <= 0) return [];
    const cacheKey = `${character.avatar}:${limit}:${getGroupUserEntityId(group)}`;
    const cached = privateChatMemoryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PRIVATE_CHAT_CACHE_TTL_MS) return cached.lines;

    const collected = [];
    try {
        const files = await fetchPrivateChatFiles(character);
        for (const file of files) {
            const { header, messages } = await fetchPrivateChatFile(character, file.id);
            if (!privateChatHeaderMatchesGroupPersona(header, group)) continue;
            for (const message of messages) {
                if (!message || message.is_system || !normalizeText(message.mes)) continue;
                const speaker = message.is_user ? getMessageSpeaker(message) || normalizeText(header?.user_name) || getGroupUserName(group) : character.name;
                const content = message.is_user ? stripTags(message.mes) : sanitizeLocalReply(message.mes, character.name);
                if (!content || isOocOrMetaReply(content)) continue;
                collected.push({
                    at: getMessageTimestamp(message) || file.lastMes || 0,
                    line: `[私聊:${character.name}/${file.id}] ${speaker}: ${content}`,
                });
            }
        }
    } catch (error) {
        console.warn('[ChatPulseGroupLogic] Failed to load private chat memories:', error);
    }

    const currentLines = getCurrentPrivateMemoryLines(character, limit, group).map((line, index) => ({
        at: Date.now() + index,
        line,
    }));
    const chronological = [...collected, ...currentLines]
        .sort((a, b) => a.at - b.at)
        .map(item => item.line);
    const seen = new Set();
    const lines = [];
    for (let index = chronological.length - 1; index >= 0 && lines.length < limit; index -= 1) {
        const line = chronological[index];
        const semanticKey = line.replace(/^\[私聊:[^\]]+\]\s*/, '');
        if (seen.has(semanticKey)) continue;
        seen.add(semanticKey);
        lines.unshift(line);
    }

    privateChatMemoryCache.set(cacheKey, { at: Date.now(), lines });
    return lines;
}

function clearPrivateMemoryCache() {
    privateChatMemoryCache.clear();
}

function getGroupRawWindowLimit(group) {
    return Math.max(4, Number(group?.contextLimit) || getSettings().contextLimit || DEFAULT_SETTINGS.contextLimit);
}

function getGroupSummaryRounds(group, maxRounds = null) {
    const memory = normalizeGroupMemory(group);
    if (!memory?.enabled || !Array.isArray(memory.rounds)) return [];
    const limit = Math.max(1, Number(maxRounds ?? memory.maxSummaryRounds) || DEFAULT_SETTINGS.memorySummaryRounds);
    return memory.rounds
        .filter(round => normalizeText(round.text))
        .slice(-limit);
}

function buildGroupLongMemoryBlock(group) {
    const memory = normalizeGroupMemory(group);
    const rounds = getGroupSummaryRounds(group, memory?.maxSummaryRounds);
    if (!memory?.enabled || rounds.length === 0) return '';
    return [
        '[当前群长期记忆]',
        '这是当前群聊里公开发生过的长期记忆，所有本群成员都可以知道。它不是当前刚发生的新消息，不要逐字复述。',
        ...rounds.map((round, index) => {
            const range = `${Number(round.from) + 1}-${Number(round.to)}`;
            return `摘要${index + 1}（消息 ${range}）：\n${round.text}`;
        }),
    ].join('\n\n');
}

function getGroupMemoryStatus(group) {
    const memory = normalizeGroupMemory(group);
    const total = Array.isArray(group?.messages) ? group.messages.length : 0;
    const rawWindow = getGroupRawWindowLimit(group);
    const protectedStart = Math.max(0, total - rawWindow);
    const pending = Math.max(0, protectedStart - (Number(memory?.cursor) || 0));
    return {
        total,
        rawWindow,
        protectedStart,
        pending,
        cursor: Number(memory?.cursor) || 0,
        threshold: Number(memory?.thresholdS) || DEFAULT_SETTINGS.memoryThresholdS,
        rounds: Array.isArray(memory?.rounds) ? memory.rounds.length : 0,
    };
}

function getSummarizableGroupChunk(group, force = false) {
    const memory = normalizeGroupMemory(group);
    if (!group || !memory?.enabled) return null;
    const messages = Array.isArray(group.messages) ? group.messages : [];
    const protectedStart = Math.max(0, messages.length - memory.rawWindowR);
    const from = Math.min(Math.max(0, Number(memory.cursor) || 0), messages.length);
    const to = Math.max(0, protectedStart);
    const count = Math.max(0, to - from);
    if (count <= 0) return null;
    if (!force && count < memory.thresholdS) return null;

    const lines = messages
        .slice(from, to)
        .map((message, offset) => {
            const line = formatMemoryLine(message);
            return line ? `${from + offset + 1}. ${line}` : '';
        })
        .filter(Boolean);
    return { from, to, count, lines };
}

function sanitizeMemorySummary(text) {
    return limitText(stripTags(text)
        .replace(/```(?:text|markdown|md)?/gi, '')
        .replace(/```/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim(), 4000);
}

async function generateSummaryWithCurrentModel(prompt, memory) {
    return await generateRawWithBackoff({
        prompt: [
            {
                role: 'system',
                content: '你是 ChatPulse Group Logic 的长期记忆总结器。只依据下面明确提供的群聊记录总结，只输出总结正文，不要寒暄。',
            },
            {
                role: 'user',
                content: prompt,
            },
        ],
        responseLength: memory.summaryResponseLength,
        trimNames: false,
    });
}

async function generateSummaryWithCustomModel(prompt, memory) {
    const settings = getSettings();
    const customUrl = normalizeText(settings.summaryCustomUrl);
    const customModel = normalizeText(settings.summaryCustomModel);
    if (!customUrl) throw new Error('请先填写长期记忆总结 endpoint。');
    if (!customModel) throw new Error('请先填写长期记忆总结 model。');

    const delay = getApiDelayForNextCall();
    if (delay > 0) await wait(delay);
    const result = await ChatCompletionService.processRequest({
        stream: false,
        messages: [
            {
                role: 'system',
                content: '你是 ChatPulse Group Logic 的长期记忆总结器。只输出总结正文，不要寒暄。',
            },
            {
                role: 'user',
                content: prompt,
            },
        ],
        model: customModel,
        chat_completion_source: 'custom',
        custom_url: customUrl,
        max_tokens: memory.summaryResponseLength,
        temperature: Number.isFinite(Number(settings.summaryTemperature))
            ? Math.max(0, Math.min(2, Number(settings.summaryTemperature)))
            : DEFAULT_SETTINGS.summaryTemperature,
    }, {}, true);
    state.apiDelayMs = Math.max(DEFAULT_SETTINGS.apiDelayBaseMs, Math.floor((state.apiDelayMs || DEFAULT_SETTINGS.apiDelayBaseMs) * 0.85));
    return result?.content || '';
}

function getSummaryModelOptionsKey() {
    const settings = getSettings();
    return normalizeText(settings.summaryCustomUrl);
}

function extractSummaryModelId(model) {
    if (typeof model === 'string') return normalizeText(model);
    if (!model || typeof model !== 'object') return '';
    return normalizeText(model.id || model.name || model.slug || model.model || model.value);
}

function extractSummaryModelOptions(data) {
    const candidates = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
            ? data.models
            : Array.isArray(data)
                ? data
                : [];
    return Array.from(new Set(candidates.map(extractSummaryModelId).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b));
}

function renderSummaryModelStatus() {
    const $status = $('#cpgl_summary_model_status');
    if (!$status.length) return;
    if (state.summaryModelOptionsLoading) {
        $status.text('正在读取模型列表...');
        return;
    }
    if (state.summaryModelOptionsError) {
        $status.text(`模型列表读取失败：${state.summaryModelOptionsError}`);
        return;
    }
    if (state.summaryModelOptions.length) {
        $status.text(`已加载 ${state.summaryModelOptions.length} 个模型，可点击下拉选择。`);
        return;
    }
    $status.text('点击输入框或箭头读取 Endpoint 的模型列表。');
}

function closeSummaryModelMenu() {
    state.summaryModelMenuOpen = false;
    state.summaryModelFilterActive = false;
    $('#cpgl_summary_model_menu').hide().empty();
}

function renderSummaryModelMenu() {
    const $menu = $('#cpgl_summary_model_menu');
    if (!$menu.length) return;
    if (!state.summaryModelMenuOpen) {
        $menu.hide().empty();
        return;
    }
    const filter = state.summaryModelFilterActive ? normalizeText($('#cpgl_summary_custom_model').val()).toLowerCase() : '';
    const options = state.summaryModelOptions
        .filter(model => !filter || model.toLowerCase().includes(filter))
        .slice(0, 200);
    if (state.summaryModelOptionsLoading) {
        $menu.html('<div class="cpgl-summary-model-empty">正在读取模型...</div>').show();
        return;
    }
    if (!options.length) {
        const text = state.summaryModelOptions.length ? '没有匹配的模型，仍可手动输入。' : '暂无模型列表，仍可手动输入。';
        $menu.html(`<div class="cpgl-summary-model-empty">${escapeHtml(text)}</div>`).show();
        return;
    }
    const html = options.map(model => `
        <button type="button" class="cpgl-summary-model-option" data-model="${escapeHtml(model)}">
            <span>${escapeHtml(model)}</span>
        </button>
    `).join('');
    $menu.html(html).show();
}

async function loadSummaryCustomModels(force = false) {
    const settings = getSettings();
    const customUrl = normalizeText(settings.summaryCustomUrl);
    if (!customUrl) {
        state.summaryModelOptionsError = '请先填写 Endpoint。';
        renderSummaryModelStatus();
        renderSummaryModelMenu();
        return [];
    }

    const key = getSummaryModelOptionsKey();
    if (!force && state.summaryModelOptionsKey === key && state.summaryModelOptions.length) {
        state.summaryModelOptionsError = '';
        renderSummaryModelStatus();
        renderSummaryModelMenu();
        return state.summaryModelOptions;
    }

    state.summaryModelOptionsError = '';
    renderSummaryModelStatus();
    renderSummaryModelMenu();
    if (state.summaryModelOptionsLoading) return state.summaryModelOptions;

    state.summaryModelOptionsLoading = true;
    renderSummaryModelStatus();
    renderSummaryModelMenu();
    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: customUrl,
            }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || data?.error) {
            throw new Error(data?.message || data?.error?.message || response.statusText || '请求失败');
        }
        const models = extractSummaryModelOptions(data);
        if (!models.length) throw new Error('接口没有返回可用模型。');
        state.summaryModelOptions = models;
        state.summaryModelOptionsKey = key;
        return models;
    } catch (error) {
        state.summaryModelOptions = [];
        state.summaryModelOptionsKey = '';
        state.summaryModelOptionsError = error?.message || String(error);
        toastr.warning(state.summaryModelOptionsError, 'ChatPulse Group Logic');
        return [];
    } finally {
        state.summaryModelOptionsLoading = false;
        renderSummaryModelStatus();
        renderSummaryModelMenu();
    }
}

async function openSummaryModelMenu(force = false) {
    state.summaryModelMenuOpen = true;
    state.summaryModelFilterActive = false;
    renderSummaryModelMenu();
    await loadSummaryCustomModels(force);
    $('#cpgl_summary_custom_model').trigger('focus');
}

async function generateMemorySummaryText(prompt, memory) {
    const provider = getSettings().summaryProvider === 'custom' ? 'custom' : 'current';
    try {
        if (provider === 'custom') return await generateSummaryWithCustomModel(prompt, memory);
        return await generateSummaryWithCurrentModel(prompt, memory);
    } catch (error) {
        if (isRateLimitError(error)) {
            const settings = getSettings();
            state.apiDelayMs = Math.min(Number(settings.apiDelayMaxMs) || DEFAULT_SETTINGS.apiDelayMaxMs, Math.max(state.apiDelayMs * 2, DEFAULT_SETTINGS.apiDelayBaseMs * 2));
            toastr.warning(`总结模型撞到速率限制，下一次请求间隔提高到 ${Math.round(state.apiDelayMs / 1000)} 秒。`, 'ChatPulse Group Logic');
        }
        throw error;
    }
}

async function summarizeGroupMemory(group, chunk) {
    const memory = normalizeGroupMemory(group);
    if (!group || !memory || !chunk) return null;
    if (!chunk.lines.length) {
        memory.cursor = chunk.to;
        memory.lastError = '';
        memory.updatedAt = Date.now();
        saveLocalState();
        renderMemoryPanel();
        return null;
    }

    const previous = getGroupSummaryRounds(group, memory.maxSummaryRounds)
        .map((round, index) => `摘要${index + 1}：\n${round.text}`)
        .join('\n\n');
    const prompt = [
        '你是群聊长期记忆总结器。请只总结公开群聊中已经滑出原文窗口的消息。',
        `群名：${group.name || group.id}`,
        previous ? `已有摘要（用于承接，不要照抄）：\n${previous}` : '',
        `需要总结的原文消息（第 ${chunk.from + 1} 到 ${chunk.to} 条）：`,
        chunk.lines.join('\n'),
        '',
        '请输出中文固定格式，不要 JSON，不要解释规则：',
        '整体摘要：用 2-4 条保留这段公开群聊发生的事。',
        '成员关系：记录角色之间、用户与角色之间在群里公开表现出的关系、态度、梗、冲突或亲近。',
        '重要事实：记录稳定事实、承诺、偏好、红包/事件结果等。',
        '未完成话题：记录之后可能要继续接上的问题、约定、悬念。',
        '要求：只写群里公开可知的信息；不要加入私聊秘密；不要把消息编号当作内容。',
    ].filter(Boolean).join('\n\n');

    const raw = await generateMemorySummaryText(prompt, memory);
    const summary = sanitizeMemorySummary(raw);
    if (!summary) throw new Error('长期记忆总结返回为空。');

    memory.rounds.push({
        id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        from: chunk.from,
        to: chunk.to,
        text: summary,
        createdAt: Date.now(),
    });
    memory.cursor = chunk.to;
    memory.lastError = '';
    memory.updatedAt = Date.now();
    saveLocalState();
    renderMemoryPanel();
    return summary;
}

async function ensureGroupMemoryReady(group, { force = false, silent = false } = {}) {
    const memory = normalizeGroupMemory(group);
    if (!group || !memory?.enabled) return false;
    const chunk = getSummarizableGroupChunk(group, force);
    if (!chunk) {
        if (force && !silent) toastr.info('没有需要总结的窗口外消息。', 'ChatPulse Group Logic');
        renderMemoryPanel();
        return false;
    }
    setQueueStage(`正在总结长期记忆：${chunk.count} 条`);
    try {
        const summary = await summarizeGroupMemory(group, chunk);
        if (summary && !silent) toastr.success('长期记忆已更新。', 'ChatPulse Group Logic');
        return !!summary;
    } catch (error) {
        memory.lastError = `长期记忆总结失败：${sanitizeDebugError(error)}`;
        saveLocalState();
        renderMemoryPanel();
        throw new Error(`${memory.lastError}。请重试本轮。`);
    } finally {
        setQueueStage('');
    }
}

function buildOtherGroupSummaryBlock(character, currentGroup) {
    if (!character?.avatar) return '';
    const blocks = [];
    const groupsByActivity = [...state.localGroups].sort((left, right) => getGroupActivityAt(left) - getGroupActivityAt(right));
    for (const group of groupsByActivity) {
        if (!group || String(group.id) === String(currentGroup?.id)) continue;
        normalizeGroupMemory(group);
        if (!hasSameUserPersona(group, currentGroup)) continue;
        if (!Array.isArray(group.members) || !group.members.includes(character.avatar)) continue;
        const rounds = getGroupSummaryRounds(group, group.memory?.maxSummaryRounds);
        if (!rounds.length) continue;
        blocks.push([
            `[其他群长期记忆：${group.name || group.id}]`,
            ...rounds.map(round => round.text),
        ].join('\n'));
    }
    return blocks.slice(-3).join('\n\n');
}

async function buildCrossChatMemoryBlock(character, currentGroup) {
    normalizeGroupMemory(currentGroup);
    if (!currentGroup || !character) return '';
    const permissions = currentGroup.memoryPermissions || getDefaultMemoryPermissions(currentGroup);
    const limit = Math.max(0, Math.min(30, Number(currentGroup.injectLimit) || 0));
    const sections = [];
    if (permissions.allowPrivateMemoryInGroup && limit > 0) {
        const privateLines = await getAllPrivateMemoryLines(character, limit, currentGroup);
        if (privateLines.length) {
            sections.push([
                `[当前角色私聊记忆：${character.name}]`,
                '这是用户与你私下发生过的记忆。除非你在群里自然主动提起，否则不要假装其他群成员已经知道。',
                ...privateLines.slice(-limit),
            ].join('\n'));
        }
    }
    if (permissions.allowOtherGroupMemoryInGroup) {
        const otherGroupSummary = buildOtherGroupSummaryBlock(character, currentGroup);
        if (otherGroupSummary) sections.push(otherGroupSummary);
        if (limit > 0) {
            const otherGroupLines = getLocalGroupMemoryLines(character, currentGroup, limit);
            if (otherGroupLines.length) {
                sections.push([
                    `[当前角色其他群近期原文：${character.name}]`,
                    '这是其他群聊的背景记忆，不是当前群刚发生的新消息。',
                    ...otherGroupLines.slice(-limit),
                ].join('\n'));
            }
        }
    }
    if (!sections.length) return '';
    return sections.join('\n\n');
}

async function buildPrivateBridgePrompt() {
    if (!getSettings().enabled) return '';
    if (state.orchestrator.active) return '';
    const ctx = getContext();
    if (ctx.groupId) return '';
    const characterId = ctx.characterId ?? this_chid;
    if (characterId === null || characterId === undefined || characterId < 0) return '';
    const character = characters[characterId];
    if (!character?.avatar) return '';
    const currentPersonaAvatar = getCurrentPrivatePersonaAvatar();
    if (!currentPersonaAvatar) return '';

    const blocks = [];
    const groupsByActivity = [...state.localGroups].sort((left, right) => getGroupActivityAt(left) - getGroupActivityAt(right));
    for (const group of groupsByActivity) {
        normalizeGroupMemory(group);
        if (!group.memoryPermissions?.exposeGroupMemoryToPrivate) continue;
        if (String(getGroupUserPersonaAvatar(group) || '') !== String(currentPersonaAvatar || '')) continue;
        if (!Array.isArray(group.members) || !group.members.includes(character.avatar)) continue;
        const rounds = getGroupSummaryRounds(group, group.memory?.maxSummaryRounds);
        if (rounds.length) {
            blocks.push([
                `[群：${group.name || group.id}]`,
                ...rounds.map(round => round.text),
            ].join('\n'));
        }
        const limit = Math.max(0, Math.min(30, Number(group?.injectLimit) || 0));
        if (limit > 0) {
            const cursor = Math.max(0, Number(group.memory?.cursor) || 0);
            const recent = (group.messages || [])
                .filter((message, index) => index >= cursor && message && !message.is_system && normalizeText(message.mes))
                .slice(-limit);
            const lines = recent
                .map(message => formatMemoryLine(message, character.name))
                .filter(Boolean);
            if (lines.length) {
                blocks.push([
                    `[群：${group.name || group.id} 近期记录]`,
                    ...lines,
                ].join('\n'));
            }
        }
    }

    if (!blocks.length) return '';
    return [
        '[ChatPulse 共享群聊记忆]',
        `下面是 ${character.name} 参与过、且允许导出到私聊的 ChatPulse 群聊公开记忆。把它当作背景记忆，不要当成用户刚发来的新消息，也不要逐字复述。`,
        ...blocks.slice(-6),
    ].join('\n');
}

function shuffleArray(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

async function createStGroup(name, memberAvatars, userPersonaAvatar = '') {
    const cleanMembers = [...new Set(memberAvatars)].filter(Boolean);
    if (cleanMembers.length === 0) throw new Error('至少选择一个角色。');
    const selectedUserPersonaAvatar = resolveUserPersonaAvatar(userPersonaAvatar);
    const group = {
        id: `cpgl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: normalizeText(name) || `ChatPulse Group: ${cleanMembers.map(avatar => getCharacterByAvatar(avatar)?.name || avatar).join(', ')}`,
        members: cleanMembers,
        userPersonaAvatar: selectedUserPersonaAvatar,
        avatar_url: getCharacterByAvatar(cleanMembers[0])?.avatar || 'img/ai4.png',
        disabled_members: [],
        messages: [],
        redPackets: [],
        injectLimit: DEFAULT_CROSS_CHAT_RAW_LIMIT,
        contextLimit: getSettings().contextLimit,
        noChain: false,
        worldInfoBooks: [],
        includeCharacterWorldInfo: true,
        memberAutomation: Object.fromEntries(cleanMembers.map(avatar => [avatar, normalizeMemberAutomation()])),
        memory: getDefaultGroupMemory(),
        memoryPermissions: getDefaultMemoryPermissions(),
        createdAt: Date.now(),
    };
    const previousGroups = state.localGroups;
    const previousActiveGroupId = state.activeGroupId;
    state.localGroups = [group, ...state.localGroups];
    state.activeGroupId = group.id;
    try {
        saveLocalState();
    } catch (error) {
        state.localGroups = previousGroups;
        state.activeGroupId = previousActiveGroupId;
        throw new Error(`创建群聊失败，浏览器无法保存数据：${error?.message || error}`);
    }
    return group;
}

async function saveStGroup(group) {
    const index = state.localGroups.findIndex(item => String(item.id) === String(group.id));
    if (index === -1) throw new Error('保存群聊失败。');
    state.localGroups[index] = group;
    saveLocalState();
}

async function addMembersToGroup(groupId, memberAvatars) {
    if (state.automationActive || hasPersistedAutomationClaim(groupId) || state.orchestrator.active || is_group_generating) {
        throw new Error('当前正在生成群聊消息，请等待完成后再添加成员。');
    }
    const group = getGroupById(groupId);
    if (!group) throw new Error('找不到群聊。');
    const before = new Set(group.members || []);
    const added = [...new Set(memberAvatars)].filter(avatar => avatar && !before.has(avatar));
    if (added.length === 0) return group;
    group.members = [...(group.members || []), ...added];
    group.disabled_members = (group.disabled_members || []).filter(avatar => group.members.includes(avatar));
    normalizeGroupMemberAutomation(group);
    for (const avatar of added) {
        const character = getCharacterByAvatar(avatar);
        appendSystemGroupMessage(group, `${character?.name || avatar} 加入了群聊`);
    }
    await saveStGroup(group);
    reconcileGroupAutomationTimers();
    const updated = getGroupById(groupId) || group;
    renderManagerModal();
    toastr.success(`${added.map(avatar => getCharacterByAvatar(avatar)?.name || avatar).join('、')} 加入了群聊。`, 'ChatPulse Group Logic');
    setTimeout(() => {
        runMembershipReactionRound(groupId, {
            type: 'join',
            memberAvatars: added,
            memberName: added.map(avatar => getCharacterByAvatar(avatar)?.name || avatar).join('、'),
        });
    }, 1500);
    return updated;
}

async function removeMemberFromGroup(groupId, avatar) {
    if (state.automationActive || hasPersistedAutomationClaim(groupId) || state.orchestrator.active || is_group_generating) {
        throw new Error('当前正在生成群聊消息，请等待完成后再移除成员。');
    }
    const group = getGroupById(groupId);
    if (!group) throw new Error('找不到群聊。');
    const character = getCharacterByAvatar(avatar);
    if (!(group.members || []).includes(avatar)) return group;
    group.members = (group.members || []).filter(member => member !== avatar);
    group.disabled_members = (group.disabled_members || []).filter(member => member !== avatar);
    normalizeGroupMemberAutomation(group);
    clearGroupMemberAutomationTimer(group.id, avatar);
    appendSystemGroupMessage(group, `${character?.name || avatar} 被移出了群聊`);
    await saveStGroup(group);
    renderManagerModal();
    toastr.info(`${character?.name || avatar} 已移出群聊。`, 'ChatPulse Group Logic');
    setTimeout(() => {
        runMembershipReactionRound(groupId, {
            type: 'leave',
            memberAvatars: [avatar],
            memberName: character?.name || avatar,
        });
    }, 1500);
    return getGroupById(groupId) || group;
}

async function openManagedGroup(groupId) {
    const group = getGroupById(groupId);
    if (!group) throw new Error('找不到群聊。');
    if (state.orchestrator.active && String(state.activeGroupId) !== String(group.id)) {
        toastr.warning('当前群仍在生成，请先停止队列再切换群聊。', 'ChatPulse Group Logic');
        return getCurrentGroup();
    }
    state.activeGroupId = group.id;
    state.deleteMode = false;
    state.selectedMessageIds.clear();
    hideMentionMenu();
    saveLocalState();
    refreshStatus();
}

function getRecentVisibleMessages(limit, group = getCurrentGroup()) {
    const safeLimit = Math.max(1, Number(limit) || DEFAULT_SETTINGS.contextLimit);
    return (Array.isArray(group?.messages) ? group.messages : [])
        .map((message, index) => ({ ...message, _index: index }))
        .filter(message => message && normalizeText(message.mes))
        .slice(-safeLimit);
}

function getMentionedCharacterIndexesInTextOrder(text, { includeAll = false, group = getCurrentGroup() } = {}) {
    const groupChars = getGroupCharacters(group);
    const raw = String(text || '');
    if (includeAll && /@(?:all|everyone|全体|全员|全体成员)/i.test(raw)) {
        return shuffleArray(groupChars.map(item => item.index));
    }

    const mentions = [...raw.matchAll(/@([^\s@,，。.!！？;；:：()（）[\]【】]+)/g)]
        .map(match => String(match[1] || '').toLowerCase().replace(/\s+/g, ''))
        .filter(Boolean);
    const ordered = [];

    for (const mention of mentions) {
        const matched = groupChars.find(({ character }) => {
            const aliases = [
                character.name,
                character.avatar,
                String(character.avatar || '').replace(/\.[^.]+$/, ''),
            ]
                .map(value => String(value || '').toLowerCase().replace(/\s+/g, ''))
                .filter(Boolean);
            return aliases.some(alias => alias.includes(mention) || mention.includes(alias));
        });
        if (matched && !ordered.includes(matched.index)) ordered.push(matched.index);
    }

    return ordered;
}

function parseRedPacketSends(text) {
    const packets = [];
    const regex = /\[REDPACKET_SEND:([^\]|]+)\|([0-9]+(?:\.[0-9]+)?)\|([0-9]+)\|([^\]]*)\]/gi;
    let match;
    while ((match = regex.exec(String(text || ''))) !== null) {
        packets.push({
            mode: normalizeText(match[1]) || 'lucky',
            total: Math.max(0, Number(match[2]) || 0),
            count: Math.max(1, Number.parseInt(match[3], 10) || 1),
            note: normalizeText(match[4]) || '红包',
        });
    }
    return packets;
}

function parseRedPacketMessage(text) {
    const match = String(text || '').trim().match(/^\[REDPACKET:([^\]]+)\]\s*$/i);
    return match ? match[1] : '';
}

function isRedPacketRequestText(text) {
    return /红包|发钱|塞钱|撒钱|打赏|转账/i.test(String(text || ''));
}

function getRedPacketsForGroup(group = getCurrentGroup()) {
    if (!group) return [];
    if (!Array.isArray(group.redPackets)) group.redPackets = [];
    return group.redPackets;
}

function getRedPacketsForCurrentGroup() {
    return getRedPacketsForGroup(getCurrentGroup());
}

function buildRedPacketPacket({
    group,
    senderIndex = -1,
    senderAvatar = 'user',
    senderName = getUserName(),
    sourceMessageId = -1,
    mode = 'lucky',
    total,
    count,
    note,
    feedbackDone = false,
}) {
    const safeCount = Math.max(1, Math.min(Number.parseInt(count, 10) || 1, 99));
    const safeTotal = Number(Math.max(0, Number(total) || 0).toFixed(2));
    if (!group || safeTotal <= 0) return null;
    return {
        id: `rp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        groupId: group.id,
        senderIndex,
        senderAvatar,
        senderName,
        sourceMessageId,
        mode: mode === 'equal' || mode === 'fixed' ? 'equal' : 'lucky',
        total: safeTotal,
        count: safeCount,
        remaining: safeCount,
        remainingAmount: safeTotal,
        note: normalizeText(note) || '红包',
        claims: [],
        createdAt: Date.now(),
        feedbackDone,
    };
}

function createRedPacket(packetData, senderIndex, messageId, group = getCurrentGroup()) {
    const sender = characters[senderIndex];
    if (!group || !sender || packetData.total <= 0) return null;
    const packet = buildRedPacketPacket({
        group,
        senderIndex,
        senderAvatar: sender.avatar,
        senderName: sender.name,
        sourceMessageId: messageId,
        mode: packetData.mode,
        total: packetData.total,
        count: packetData.count,
        note: packetData.note,
        feedbackDone: false,
    });
    if (!packet) return null;
    if (!Array.isArray(group.redPackets)) group.redPackets = [];
    group.redPackets.push(packet);
    saveLocalState();
    return packet;
}

function createCharacterRedPacketMessage(packetData, senderIndex, group = getCurrentGroup()) {
    const sender = characters[senderIndex];
    if (!group || !sender || packetData.total <= 0) return null;
    const packet = buildRedPacketPacket({
        group,
        senderIndex,
        senderAvatar: sender.avatar,
        senderName: sender.name,
        mode: packetData.mode,
        total: packetData.total,
        count: packetData.count,
        note: packetData.note,
        feedbackDone: false,
    });
    if (!packet) return null;
    if (!Array.isArray(group.redPackets)) group.redPackets = [];
    group.redPackets.push(packet);
    const messageId = appendLocalMessage(group, {
        is_user: false,
        name: sender.name,
        avatar: sender.avatar,
        mes: `[REDPACKET:${packet.id}]`,
    });
    packet.sourceMessageId = messageId;
    saveLocalState();
    renderRedPacketList();
    renderChatMessages();
    return packet;
}

function createUserRedPacketMessage(packetData) {
    const group = getCurrentGroup();
    if (!group) return null;
    const userName = getGroupUserName(group);
    const userPersonaAvatar = getGroupUserPersonaAvatar(group);
    const packet = buildRedPacketPacket({
        group,
        senderIndex: -1,
        senderAvatar: getGroupUserEntityId(group),
        senderName: userName,
        mode: packetData.mode,
        total: packetData.total,
        count: packetData.count,
        note: packetData.note,
        feedbackDone: true,
    });
    if (!packet) return null;
    if (!Array.isArray(group.redPackets)) group.redPackets = [];
    group.redPackets.push(packet);
    const messageId = appendLocalMessage(group, {
        is_user: true,
        name: userName,
        avatar: userPersonaAvatar || 'user',
        userPersonaAvatar,
        mes: `[REDPACKET:${packet.id}]`,
    });
    packet.sourceMessageId = messageId;
    saveLocalState();
    renderRedPacketList();
    renderChatMessages();
    return packet;
}

function getRedPacket(packetId) {
    for (const group of state.localGroups) {
        const packet = (group.redPackets || []).find(item => item.id === packetId);
        if (packet) return packet;
    }
    return null;
}

function claimAmount(packet) {
    if (!packet || packet.remaining <= 0 || packet.remainingAmount <= 0) return 0;
    if (packet.remaining === 1) return Number(packet.remainingAmount.toFixed(2));
    if (packet.mode === 'equal') return Number(Math.min(packet.remainingAmount, packet.total / packet.count).toFixed(2));
    const max = Math.max(0.01, (packet.remainingAmount / packet.remaining) * 1.8);
    const min = 0.01;
    return Number(Math.min(packet.remainingAmount - (packet.remaining - 1) * 0.01, min + Math.random() * (max - min)).toFixed(2));
}

function claimRedPacket(packetId, claimer, group = getCurrentGroup()) {
    const packet = getRedPacket(packetId);
    if (!packet || packet.remaining <= 0) return null;
    if (!Array.isArray(packet.claims)) packet.claims = [];
    const claimerId = claimer.avatar || claimer.id || claimer.name || 'user';
    const alreadyClaimed = packet.claims.some(claim => (
        claim.claimerId === claimerId
        || (isUserClaimId(claimerId, group) && isUserClaimId(claim.claimerId, group))
    ));
    if (alreadyClaimed) return null;
    const amount = claimAmount(packet);
    if (amount <= 0) return null;
    packet.claims.push({
        claimerId,
        claimerName: claimer.name || getUserName(),
        amount,
        at: Date.now(),
    });
    packet.remaining -= 1;
    packet.remainingAmount = Number(Math.max(0, packet.remainingAmount - amount).toFixed(2));
    saveLocalState();
    renderRedPacketList();
    renderChatMessages();
    renderMessageDeleteList();
    return { packet, amount };
}

function autoClaimAvailablePackets(characterIndex, group = getCurrentGroup()) {
    const character = characters[characterIndex];
    if (!character) return [];
    const packets = getRedPacketsForGroup(group)
        .filter(packet => packet.remaining > 0)
        .filter(packet => String(packet.senderAvatar) !== String(character.avatar))
        .filter(packet => !packet.claims.some(claim => claim.claimerId === character.avatar));
    return packets.map(packet => claimRedPacket(packet.id, character, group)).filter(Boolean);
}

function redPacketStatusLine(packet) {
    if (!packet) return '';
    const claimNames = packet.claims.map(claim => `${claim.claimerName}(${claim.amount.toFixed(2)})`);
    const claimed = packet.count - packet.remaining;
    if (packet.remaining <= 0) {
        return `你发的红包已经被抢光了，共 ${packet.count} 份，领取人：${claimNames.join('、') || '无'}。`;
    }
    return `你发的红包还剩 ${packet.remaining} 份没人领，已领取 ${claimed} 份${claimNames.length ? `：${claimNames.join('、')}` : ''}。`;
}

function buildRedPacketReactInstruction(packet) {
    if (!packet) return '';
    return [
        '[ChatPulse Red Packet Event]',
        `${packet.senderName} just sent a red packet in this group.`,
        `Packet: ${packet.mode} | total ${packet.total} | ${packet.count} portions | note: ${packet.note}`,
        'React naturally as a group member. If you want to claim it, speak as if you noticed or grabbed it; the extension will record the claim after your successful reply.',
    ].join('\n');
}

function buildRedPacketStatePrompt(group = getCurrentGroup()) {
    const packets = getRedPacketsForGroup(group).filter(packet => packet.remaining > 0);
    if (!packets.length) return '';
    return [
        '[当前红包状态]',
        ...packets.map(packet => `${packet.senderName} 发了 ${packet.total.toFixed(2)} 元/${packet.count} 份红包，剩余 ${packet.remaining} 份，留言：${packet.note}`),
    ].join('\n');
}

function processRedPacketFromLatestMessage(characterIndex, group = getCurrentGroup()) {
    const settings = getSettings();
    if (!settings.redPackets) return [];
    const messages = Array.isArray(group?.messages) ? group.messages : [];
    const messageId = messages.length - 1;
    const message = messages[messageId];
    if (!message || message.is_user || message.is_system) return [];
    const packets = parseRedPacketSends(message.mes)
        .map(packetData => createRedPacket(packetData, characterIndex, messageId, group))
        .filter(Boolean);
    if (packets.length > 0) {
        state.orchestrator.redPacketEvents.push(...packets);
        renderRedPacketList();
    }
    return packets;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getAutomationOwnerId() {
    if (state.automationOwnerId) return state.automationOwnerId;
    const randomPart = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    state.automationOwnerId = `cpgl-window:${randomPart}`;
    return state.automationOwnerId;
}

function getRandomAutomationIntervalMs(record) {
    const normalized = normalizeMemberAutomation(record);
    const min = normalized.intervalMinMinutes;
    const max = Math.max(min, normalized.intervalMaxMinutes);
    const minutes = min + Math.floor(Math.random() * (max - min + 1));
    return Math.max(60_000, minutes * 60_000);
}

function getPersistedAutomationTarget(snapshot, groupId, avatar) {
    const group = (snapshot?.groups || []).find(item => String(item?.id) === String(groupId)) || null;
    if (!group || !(group.members || []).includes(String(avatar))) return { group: null, record: null };
    normalizeGroupMemory(group);
    const record = getMemberAutomation(group, avatar);
    return { group, record };
}

function writeAutomationRecordToSnapshot(snapshot, group, avatar, record) {
    group.memberAutomation[String(avatar)] = normalizeMemberAutomation(record);
    writePersistedLocalState(snapshot);
    const liveGroup = getGroupById(group.id);
    adoptPersistedLocalState(snapshot, {
        preserveActiveGroup: true,
        preserveTargetReference: liveGroup,
    });
}

async function withAutomationLock(groupId, avatar, task) {
    const key = memberAutomationKey(groupId, avatar);
    const lockName = `${AUTOMATION_LOCK_PREFIX}${encodeURIComponent(key)}`;
    if (globalThis.navigator?.locks?.request) {
        return await navigator.locks.request(lockName, { mode: 'exclusive' }, task);
    }
    // Modern Chromium/Firefox builds expose Web Locks. Older WebViews keep the
    // persisted lease checks as a best-effort fallback.
    return await task();
}

function clearGroupMemberAutomationTimer(groupId, avatar) {
    const key = memberAutomationKey(groupId, avatar);
    const timer = state.automationTimers.get(key);
    if (timer) clearTimeout(timer);
    state.automationTimers.delete(key);
}

function clearGroupAutomationTimers(groupId = null) {
    for (const [key, timer] of state.automationTimers.entries()) {
        const [timerGroupId] = String(key).split('\u0000');
        if (groupId != null && String(timerGroupId) !== String(groupId)) continue;
        clearTimeout(timer);
        state.automationTimers.delete(key);
    }
}

function scheduleGroupMemberAutomation(groupOrId, avatar, { delayOverrideMs = null } = {}) {
    const group = typeof groupOrId === 'object' ? groupOrId : getGroupById(groupOrId);
    if (!group || !(group.members || []).includes(String(avatar))) {
        clearGroupMemberAutomationTimer(group?.id || groupOrId, avatar);
        return;
    }
    const record = getMemberAutomation(group, avatar);
    clearGroupMemberAutomationTimer(group.id, avatar);
    if (!record.enabled || !getSettings().enabled || !getSettings().orchestratedEntry) return;

    let changed = false;
    const now = Date.now();
    if (!record.nextTriggerAt) {
        record.nextTriggerAt = now + getRandomAutomationIntervalMs(record);
        changed = true;
    }
    if (changed) saveLocalState();
    const wakeAt = delayOverrideMs != null
        ? now + Math.max(50, Number(delayOverrideMs) || 0)
        : record.claimUntil > now
            ? record.claimUntil + 100
            : record.nextTriggerAt;
    const delay = Math.max(50, Math.min(2_147_000_000, wakeAt - now));
    const key = memberAutomationKey(group.id, avatar);
    const timer = setTimeout(() => {
        state.automationTimers.delete(key);
        executeDueGroupMemberAutomation(group.id, avatar);
    }, delay);
    state.automationTimers.set(key, timer);
}

function reconcileGroupAutomationTimers() {
    clearGroupAutomationTimers();
    for (const group of state.localGroups) {
        normalizeGroupMemberAutomation(group);
        for (const avatar of group.members || []) {
            scheduleGroupMemberAutomation(group, avatar);
        }
    }
}

function findRecentOtherGroupSpeaker(group, avatar) {
    const members = new Set((group?.members || []).map(value => String(value)));
    const messages = Array.isArray(group?.messages) ? group.messages : [];
    let ownLastIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.is_user || message.is_system) continue;
        if (String(message.avatar || '') === String(avatar)) {
            ownLastIndex = index;
            break;
        }
    }
    if (ownLastIndex < 0) return null;
    for (let index = messages.length - 1; index > ownLastIndex; index -= 1) {
        const message = messages[index];
        const speakerAvatar = String(message?.avatar || '');
        if (!message || message.is_user || message.is_system) continue;
        if (!speakerAvatar || speakerAvatar === String(avatar) || !members.has(speakerAvatar)) continue;
        const character = getCharacterByAvatar(speakerAvatar);
        if (!character) continue;
        return { avatar: speakerAvatar, name: character.name || getMessageSpeaker(message) || speakerAvatar };
    }
    return null;
}

function validatePersistedAutomationClaim(groupId, avatar, ownerId, eventId, liveGroup) {
    const snapshot = readPersistedLocalState();
    const { group, record } = getPersistedAutomationTarget(snapshot, groupId, avatar);
    if (!group || !record) return false;
    adoptPersistedLocalState(snapshot, {
        preserveActiveGroup: true,
        preserveTargetReference: liveGroup,
    });
    const refreshed = getMemberAutomation(liveGroup, avatar);
    return refreshed.enabled
        && refreshed.claimOwnerId === ownerId
        && refreshed.claimEventId === eventId
        && refreshed.claimUntil > Date.now()
        && (liveGroup.members || []).includes(String(avatar));
}

async function executeDueGroupMemberAutomation(groupId, avatar) {
    if (state.orchestrator.active || state.automationActive || hasPersistedAutomationClaim(groupId) || is_group_generating) {
        scheduleGroupMemberAutomation(groupId, avatar, { delayOverrideMs: AUTOMATION_RETRY_MS });
        return;
    }
    const ownerId = getAutomationOwnerId();
    const claimed = await withAutomationLock(groupId, avatar, async () => {
        if (state.orchestrator.active || state.automationActive || is_group_generating) {
            return { busy: true, claimed: false };
        }
        const snapshot = readPersistedLocalState();
        const { group, record } = getPersistedAutomationTarget(snapshot, groupId, avatar);
        if (!group || !record) {
            return { missing: true, claimed: false };
        }
        const claim = tryClaimDueAutomation({
            record,
            now: Date.now(),
            ownerId,
            leaseMs: AUTOMATION_CLAIM_LEASE_MS,
        });
        writeAutomationRecordToSnapshot(snapshot, group, avatar, claim.record);
        return {
            claimed: claim.claimed,
            eventId: claim.eventId,
        };
    });
    if (claimed?.busy) {
        scheduleGroupMemberAutomation(groupId, avatar, { delayOverrideMs: AUTOMATION_RETRY_MS });
        return;
    }
    if (claimed?.missing) {
        clearGroupMemberAutomationTimer(groupId, avatar);
        return;
    }
    if (!claimed?.claimed) {
        scheduleGroupMemberAutomation(groupId, avatar);
        return;
    }

    const eventId = claimed.eventId;
    const freshGroup = getGroupById(groupId);
    const characterIndex = getCharacterIndexByAvatar(avatar);
    const character = characters[characterIndex];
    const latestRecord = freshGroup ? getMemberAutomation(freshGroup, avatar) : null;
    state.automationActive = true;
    try {
        if (!freshGroup || !character || !latestRecord) {
            throw new Error('角色卡或群成员已不可用。');
        }
        const recentOtherSpeaker = findRecentOtherGroupSpeaker(freshGroup, avatar);
        const jealousyRollPassed = latestRecord.jealousyEnabled
            && !!recentOtherSpeaker
            && Math.random() * 100 < latestRecord.jealousyChance;
        const proactive = buildProactivePrompt({
            basePrompt: latestRecord.prompt,
            jealousyEnabled: jealousyRollPassed,
            jealousyPrompt: latestRecord.jealousyPrompt,
            recentOtherSpeaker,
        });
        await generateForcedMember(characterIndex, proactive.prompt, {
            groupId,
            standalone: true,
            suppressChains: proactive.suppressChains || proactive.noChain,
            suppressRedPackets: true,
            trackQueue: false,
            validateBeforeCommit: (liveGroup, liveCharacter) => (
                String(liveCharacter?.avatar || '') === String(avatar)
                && validatePersistedAutomationClaim(groupId, avatar, ownerId, eventId, liveGroup)
            ),
        });
    } catch (error) {
        console.error('[ChatPulseGroupLogic] Proactive group message failed:', error);
        if (character && String(state.activeGroupId) === String(groupId)) {
            toastr.error(`${character.name || avatar} 的群聊主动消息失败：${error.message || error}`, 'ChatPulse Group Logic');
        }
    } finally {
        await withAutomationLock(groupId, avatar, async () => {
            const completionSnapshot = readPersistedLocalState();
            const completionTarget = getPersistedAutomationTarget(completionSnapshot, groupId, avatar);
            if (completionTarget.group && completionTarget.record) {
                const completion = completeAutomationClaim({
                    record: completionTarget.record,
                    eventId,
                    ownerId,
                    now: Date.now(),
                    nextIntervalMs: getRandomAutomationIntervalMs(completionTarget.record),
                });
                if (completion.completed) {
                    writeAutomationRecordToSnapshot(
                        completionSnapshot,
                        completionTarget.group,
                        avatar,
                        completion.record,
                    );
                } else {
                    adoptPersistedLocalState(completionSnapshot, { preserveActiveGroup: true });
                }
            }
        });
        state.automationActive = false;
        scheduleGroupMemberAutomation(groupId, avatar);
        refreshStatus();
    }
}

async function testGroupMemberProactiveMessage(groupId, avatar) {
    if (state.orchestrator.active || state.automationActive || hasPersistedAutomationClaim(groupId) || is_group_generating) {
        throw new Error('当前正在生成消息，请等待队列结束后再测试。');
    }
    const group = getGroupById(groupId);
    const characterIndex = getCharacterIndexByAvatar(avatar);
    const character = characters[characterIndex];
    if (!group || !character || !(group.members || []).includes(String(avatar))) {
        throw new Error('这个角色已经不在当前群聊中。');
    }
    const record = getMemberAutomation(group, avatar);
    const recentOtherSpeaker = findRecentOtherGroupSpeaker(group, avatar);
    const proactive = buildProactivePrompt({
        basePrompt: record.prompt,
        jealousyEnabled: record.jealousyEnabled
            && !!recentOtherSpeaker
            && Math.random() * 100 < record.jealousyChance,
        jealousyPrompt: record.jealousyPrompt,
        recentOtherSpeaker,
    });
    state.automationActive = true;
    try {
        return await generateForcedMember(characterIndex, proactive.prompt, {
            groupId,
            standalone: true,
            suppressChains: proactive.suppressChains || proactive.noChain,
            suppressRedPackets: true,
            trackQueue: false,
            validateBeforeCommit: (liveGroup, liveCharacter) => (
                String(liveCharacter?.avatar || '') === String(avatar)
                && (liveGroup.members || []).includes(String(avatar))
            ),
        });
    } finally {
        state.automationActive = false;
        refreshStatus();
    }
}

function getApiDelayForNextCall() {
    const settings = getSettings();
    const base = Math.max(0, Number(settings.apiDelayBaseMs) || DEFAULT_SETTINGS.apiDelayBaseMs);
    const step = Math.max(0, Number(settings.apiDelayStepMs) || DEFAULT_SETTINGS.apiDelayStepMs);
    const max = Math.max(base, Number(settings.apiDelayMaxMs) || DEFAULT_SETTINGS.apiDelayMaxMs);
    const delay = Math.min(max, base + state.generationCounter * step, state.apiDelayMs || max);
    state.generationCounter += 1;
    state.apiDelayMs = Math.min(max, delay + step);
    return delay;
}

function isRateLimitError(error) {
    const text = String(error?.message || error || '');
    return /429|too many requests|rate limit|速率|频率/i.test(text);
}

function sanitizeDebugError(error) {
    return limitText(String(error?.message || error || '生成失败')
        .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_API_KEY]'), 1000);
}

async function runApiCallWithBackoff(call) {
    const delay = getApiDelayForNextCall();
    if (delay > 0) await wait(delay);
    try {
        const result = await call();
        state.apiDelayMs = Math.max(DEFAULT_SETTINGS.apiDelayBaseMs, Math.floor((state.apiDelayMs || DEFAULT_SETTINGS.apiDelayBaseMs) * 0.85));
        return result;
    } catch (error) {
        if (isRateLimitError(error)) {
            const settings = getSettings();
            state.apiDelayMs = Math.min(Number(settings.apiDelayMaxMs) || DEFAULT_SETTINGS.apiDelayMaxMs, Math.max(state.apiDelayMs * 2, DEFAULT_SETTINGS.apiDelayBaseMs * 2));
            toastr.warning(`撞到速率限制，下一次请求间隔提高到 ${Math.round(state.apiDelayMs / 1000)} 秒。`, 'ChatPulse Group Logic');
        }
        throw error;
    }
}

async function generateRawWithBackoff(options) {
    return await runApiCallWithBackoff(() => generateRaw(options));
}

async function generateGroupRoleWithBackoff(character, {
    messages,
    responseLength,
    temperature,
} = {}) {
    const roleConfig = getCharacterGroupApiConfig(character);
    const effectiveResponseLength = roleConfig.mode === 'custom'
        ? Math.min(
            Math.max(80, Number(responseLength) || roleConfig.maxTokens),
            roleConfig.maxTokens,
        )
        : responseLength;
    const route = buildRoleApiRequest({
        roleConfig,
        messages,
        responseLength: effectiveResponseLength,
        temperature,
    });
    if (route.mode === 'st_default') {
        return await generateRawWithBackoff(route.options);
    }
    const result = await runApiCallWithBackoff(
        () => ChatCompletionService.processRequest(route.options, {}, true),
    );
    return String(result?.content || '');
}

async function waitForGroupIdle(timeoutMs = 60000) {
    const started = Date.now();
    while (is_group_generating) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('Timed out waiting for group generation to finish');
        }
        await wait(250);
    }
}

function getCharacterName(index) {
    return characters[index]?.name || `#${index}`;
}

function collectPostRoundMentions(messageId, group = getCurrentGroup()) {
    const settings = getSettings();
    if (group?.noChain) return;
    if (!settings.postRoundMentionReplies || !state.orchestrator.active) return;
    const message = group?.messages?.[messageId];
    if (!message || message.is_user || message.is_system || !normalizeText(message.mes)) return;

    const senderName = getMessageSpeaker(message);
    const senderAvatar = message.avatar || '';
    const targets = getMentionedCharacterIndexesInTextOrder(message.mes, { includeAll: false, group })
        .filter(index => getCharacterName(index) !== senderName)
        .filter(index => String(characters[index]?.avatar || '') !== String(senderAvatar || ''));
    if (targets.length === 0) return;

    for (const targetIndex of targets) {
        state.orchestrator.postRoundMentions.push({
            targetIndex,
            sourceIndex: messageId,
            sourceName: senderName || 'another member',
            sourceText: normalizeText(message.mes),
        });
    }
}

async function generateForcedMember(characterIndex, instruction = '', options = {}) {
    const requestedGroupId = String(options.groupId ?? state.activeGroupId ?? '');
    const standalone = !!options.standalone;
    const suppressChains = standalone || options.suppressChains === true;
    const suppressRedPackets = standalone || options.suppressRedPackets === true;
    const trackQueue = options.trackQueue !== false && !standalone;
    await waitForGroupIdle();
    const group = getGroupById(requestedGroupId);
    const character = characters[characterIndex];
    if (!group || !character || !(group.members || []).includes(character.avatar)) {
        return { dropped: true, reason: 'member_missing' };
    }
    if (trackQueue && String(state.activeGroupId) !== requestedGroupId) {
        return { dropped: true, reason: 'queue_group_changed' };
    }
    if (trackQueue && shouldStopQueue()) return { dropped: true, stopped: true };
    if (trackQueue && consumeQueueSkip(characterIndex)) {
        finishQueueItem(characterIndex, 'skipped', '已跳过');
        return { dropped: true, skipped: true };
    }
    if (trackQueue) state.orchestrator.currentInstruction = instruction;
    const showTyping = !standalone && String(state.activeGroupId) === requestedGroupId;
    if (showTyping) {
        state.typing = [{ id: character.avatar, name: character.name }];
        if (trackQueue) markQueueCurrent(characterIndex, `${character.name} 正在回复`);
        renderTypingIndicator();
    }
    let debugPrompt = instruction ? `发言顺序提示：${instruction}` : '正在准备当前角色的独立群聊提示词。';
    let retried = false;
    try {
        const history = getRecentVisibleMessages(getGroupRawWindowLimit(group), group)
            .map(message => {
                return formatMemoryLine(message, character.name, group);
            })
            .filter(Boolean)
            .join('\n');
        const characterCard = buildCharacterCardBlock(character);
        const userPersona = buildUserPersonaBlock(group);
        const userName = getGroupUserName(group);
        const groupLongMemory = buildGroupLongMemoryBlock(group);
        const worldInfoBlock = await buildGroupWorldInfoBlock(group, character, `${groupLongMemory}\n${history}\n${characterCard}\n${userPersona}\n${instruction}`);
        const crossChatMemory = await buildCrossChatMemoryBlock(character, group);
        const systemPrompt = applyLocalPromptMacros([
            '你将生成一条群聊消息。',
            `群名：${group.name}`,
            `你现在扮演：${character.name}`,
            `群成员：${getGroupCharacters(group).map(({ character: item }) => item.name).join('、')}`,
            characterCard ? `当前角色卡设定：\n${characterCard}` : '',
            userPersona,
            worldInfoBlock,
            groupLongMemory,
            crossChatMemory,
            getSettings().includeLocalPreset ? `附加约束（不要复述这些字）：${getSettings().localPreset || DEFAULT_SETTINGS.localPreset}` : '',
            `身份边界（最高优先级）：你只能作为 ${character.name} 发言。${userName} 是用户，不是你；其他群成员也不是你。`,
            `禁止代言：不要替 ${userName} 写任何话、想法、动作或决定；不要替任何其他群成员写台词、反应、心情或行动。`,
            `只允许输出 ${character.name} 亲自发到群里的这一条消息。最近聊天只是上下文记录，不是剧本续写模板，不要输出“某某: 内容”的多说话人格式。`,
            `你的输出必须像 ${character.name} 在聊天软件里亲自发送的一条消息。`,
            'If the turn note contains [MENTION], someone just @mentioned you directly. Reply to that message naturally; do not ignore it.',
            suppressRedPackets ? '' : '如果用户明确要求你发红包，或者当前角色决定发红包，必须在消息末尾附加隐藏标签：[REDPACKET_SEND:lucky|总金额|份数|留言] 或 [REDPACKET_SEND:equal|总金额|份数|留言]。这个标签只用于系统创建红包，正文里不要解释标签。',
        ].filter(Boolean).join('\n\n'), character, group);
        const turnPrompt = applyLocalPromptMacros([
            instruction ? `发言顺序提示：${instruction}` : '',
            buildRedPacketStatePrompt(group),
            `最近聊天：\n${history || '暂无'}`,
            suppressRedPackets
                ? `只输出 ${character.name} 接下来会发的一条消息正文。不要输出红包标签、其他标签、草稿、分析、英文解释、规则、选项或“YOUR REPLY AS”。`
                : `只输出 ${character.name} 接下来会发的一条消息正文。除必要的 REDPACKET_SEND 隐藏标签外，不要输出其他标签、草稿、分析、英文解释、规则、选项或“YOUR REPLY AS”。`,
        ].filter(Boolean).join('\n\n'), character, group);
        debugPrompt = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${turnPrompt}`;
        const requestOptions = {
            prompt: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: turnPrompt },
            ],
            responseLength: Math.max(
                500,
                Math.min(6000, Number(getSettings().responseLength) || DEFAULT_SETTINGS.responseLength),
            ),
            trimNames: false,
        };
        let raw = await generateGroupRoleWithBackoff(character, {
            messages: requestOptions.prompt,
            responseLength: requestOptions.responseLength,
            temperature: options.temperature,
        });
        if (trackQueue && (shouldStopQueue() || consumeQueueSkip(characterIndex))) {
            finishQueueItem(characterIndex, 'skipped', '结果已丢弃');
            return { dropped: true, skipped: true };
        }
        let redPacketSends = suppressRedPackets ? [] : parseRedPacketSends(raw);
        let sanitized = applyLocalRegex(sanitizeLocalReply(raw, character.name));
        if (redPacketSends.length === 0 && shouldRetryLocalReply(raw, sanitized, character.name, group)) {
            retried = true;
            const retrySystemPrompt = applyLocalPromptMacros([
                `最高优先级身份规则：你只能扮演 ${character.name}。`,
                `${userName} 是用户，不是你。不要用用户口吻说话，不要替用户写想法、动作或回应。`,
                '不要替其他群成员写台词、反应、心情、动作或决定。',
                `角色：${character.name}`,
                characterCard ? `角色卡：\n${characterCard}` : '',
                userPersona,
                worldInfoBlock,
            ].filter(Boolean).join('\n\n'), character, group);
            const retryTurnPrompt = applyLocalPromptMacros([
                `最近聊天：\n${history || '暂无'}`,
                `只写一条 ${character.name} 本人会发出的群聊消息。不要解释，不要草稿，不要自我修订，不要写标签，不要写“名字: 台词”的剧本格式。`,
            ].filter(Boolean).join('\n\n'), character, group);
            const retryMessages = [
                    { role: 'system', content: retrySystemPrompt },
                    { role: 'user', content: retryTurnPrompt },
                ];
            raw = await generateGroupRoleWithBackoff(character, {
                messages: retryMessages,
                responseLength: Math.max(
                    500,
                    Math.floor((Number(getSettings().responseLength) || DEFAULT_SETTINGS.responseLength) / 2),
                ),
                temperature: options.temperature,
            });
            redPacketSends = suppressRedPackets ? [] : parseRedPacketSends(raw);
            sanitized = applyLocalRegex(sanitizeLocalReply(raw, character.name));
        }
        if (trackQueue && (shouldStopQueue() || consumeQueueSkip(characterIndex))) {
            finishQueueItem(characterIndex, 'skipped', '结果已丢弃');
            return { dropped: true, skipped: true };
        }
        const liveGroup = getGroupById(requestedGroupId);
        if (!liveGroup || !(liveGroup.members || []).includes(character.avatar)) {
            if (trackQueue) finishQueueItem(characterIndex, 'skipped', '成员已移出，结果已丢弃');
            return { dropped: true, reason: 'member_removed_during_generation' };
        }
        if (
            typeof options.validateBeforeCommit === 'function'
            && !options.validateBeforeCommit(liveGroup, character)
        ) {
            if (trackQueue) finishQueueItem(characterIndex, 'skipped', '设置已变化，结果已丢弃');
            return { dropped: true, reason: 'invalidated_during_generation' };
        }
        appendDebugLog(liveGroup, {
            character: character.name,
            prompt: debugPrompt,
            raw,
            sanitized,
            retried,
            error: '',
        });
        const dropped = !sanitized
            || isOocOrMetaReply(sanitized)
            || hasSpeakerPrefixLeak(sanitized, character.name, liveGroup);
        const createdPackets = [];
        if (!dropped) {
            const messageId = appendLocalMessage(liveGroup, {
                is_user: false,
                name: character.name,
                avatar: character.avatar,
                mes: sanitized,
            });
            if (!suppressChains) collectPostRoundMentions(messageId, liveGroup);
            if (!suppressRedPackets && String(state.activeGroupId) === requestedGroupId) {
                processRedPacketFromLatestMessage(characterIndex, liveGroup);
                autoClaimAvailablePackets(characterIndex, liveGroup);
            }
        }
        for (const packetData of redPacketSends) {
            const packet = createCharacterRedPacketMessage(packetData, characterIndex, liveGroup);
            if (packet) createdPackets.push(packet);
        }
        if (createdPackets.length > 0) {
            state.orchestrator.redPacketEvents.push(...createdPackets);
        }
        if (dropped && createdPackets.length === 0) {
            toastr.warning(`${character.name} 的输出像 OOC/调试文本，已丢弃。`, 'ChatPulse Group Logic');
        }
        if (trackQueue) finishQueueItem(characterIndex, dropped ? 'failed' : 'done', dropped ? '已丢弃' : '完成');
        return {
            dropped,
            packets: createdPackets,
            message: dropped ? null : liveGroup.messages[liveGroup.messages.length - 1],
        };
    } catch (error) {
        try {
            appendDebugLog(getGroupById(requestedGroupId) || group, {
                character: character.name,
                prompt: debugPrompt,
                raw: '',
                sanitized: '',
                retried,
                error: sanitizeDebugError(error),
            });
        } catch (debugError) {
            console.warn('[ChatPulseGroupLogic] Failed to record generation error:', debugError);
        }
        if (trackQueue) finishQueueItem(characterIndex, 'failed', error?.message || '生成失败');
        throw error;
    } finally {
        if (trackQueue) state.orchestrator.currentInstruction = '';
        if (showTyping) {
            state.typing = [];
            renderTypingIndicator();
        }
    }
}

function buildRoundOrder(userText) {
    const allMembers = getGroupCharacters().map(item => item.index);
    const mentioned = getMentionedCharacterIndexesInTextOrder(userText, { includeAll: true });
    if (mentioned.length === 0) {
        return {
            mentioned: [],
            order: shuffleArray(allMembers),
        };
    }

    const mentionedSet = new Set(mentioned);
    const rest = shuffleArray(allMembers.filter(index => !mentionedSet.has(index)));
    return {
        mentioned,
        order: [...mentioned, ...rest],
    };
}

function buildInstructionForRoundMember(characterIndex, position, mentioned) {
    const wasMentioned = mentioned.includes(characterIndex);
    if (wasMentioned) {
        return [
            '[MENTION]',
            'Someone just @mentioned you directly! You MUST reply to this message — do not ignore it.',
            'Stay in character and answer naturally as part of the current group flow.',
        ].join('\n');
    }
    if (mentioned.length > 0) {
        return 'Someone else was @mentioned in this round. Continue the group flow naturally as a bystander; do not pretend the @ was for you.';
    }
    return 'Speak naturally in the group flow as yourself.';
}

function consumePostRoundMentionJobs(primaryOrder, processedKeys = new Set()) {
    const jobs = [];
    const seen = new Set();
    for (const job of state.orchestrator.postRoundMentions) {
        if (!characters[job.targetIndex]) continue;
        const key = `${job.sourceIndex}:${job.targetIndex}`;
        if (processedKeys.has(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push(job);
    }

    const primarySet = new Set(primaryOrder);
    return jobs.sort((a, b) => {
        const aWasInRound = primarySet.has(a.targetIndex) ? 1 : 0;
        const bWasInRound = primarySet.has(b.targetIndex) ? 1 : 0;
        return bWasInRound - aWasInRound || a.sourceIndex - b.sourceIndex;
    });
}

async function processPostRoundMentionQueue(primaryOrder) {
    if (getCurrentGroup()?.noChain) return;
    const settings = getSettings();
    const processedPostRoundKeys = new Set();
    const maxPostRoundPasses = Math.max(1, Number(settings.maxSecondaryDepth) || DEFAULT_SETTINGS.maxSecondaryDepth) + 1;
    for (let pass = 0; pass < maxPostRoundPasses; pass += 1) {
        if (shouldStopQueue()) break;
        const postRoundJobs = consumePostRoundMentionJobs(primaryOrder, processedPostRoundKeys);
        if (postRoundJobs.length === 0) break;
        for (const job of postRoundJobs) {
            if (shouldStopQueue()) break;
            const key = `${job.sourceIndex}:${job.targetIndex}`;
            processedPostRoundKeys.add(key);
            const instruction = [
                '[MENTION]',
                `${job.sourceName} just @mentioned you directly! You MUST reply to this message — do not ignore it.`,
                pass === 0
                    ? 'Reply naturally to that @mention as part of the current group chat.'
                    : 'This is a secondary @mention from another character. Reply to it naturally, but do not restart the whole group round.',
                `Mentioned message: ${compactPreview(job.sourceText, 220)}`,
                'Output one short in-character group message.',
            ].join('\n');
            await generateForcedMember(job.targetIndex, instruction);
            autoClaimAvailablePackets(job.targetIndex);
            processRedPacketFromLatestMessage(job.targetIndex);
        }
    }
}

async function runRedPacketReactionRound(packet, groupId = state.activeGroupId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.orchestratedEntry || !packet) return;
    const group = getCurrentGroup();
    if (!group || String(group.id) !== String(groupId) || !getGroupById(groupId)) return;
    if (state.orchestrator.active || state.automationActive || hasPersistedAutomationClaim(groupId) || is_group_generating) {
        toastr.warning('当前群聊仍在生成，红包反应会等下一次消息触发。', 'ChatPulse Group Logic');
        return;
    }
    const order = shuffleArray(getGroupCharacters(group)
        .map(item => item.index)
        .filter(index => index >= 0));
    if (order.length === 0) return;

    clearRuntimeState();
    state.generationCounter = 0;
    state.apiDelayMs = Math.max(0, Number(settings.apiDelayBaseMs) || DEFAULT_SETTINGS.apiDelayBaseMs);
    state.orchestrator.active = true;
    state.orchestrator.currentSourceIndex = packet.sourceMessageId ?? -1;
    state.orchestrator.postRoundMentions = [];
    state.orchestrator.redPacketEvents = [];
    state.orchestrator.activeRedPacketId = packet.id;
    beginQueue('redpacket', '红包反应', order, () => '红包反应');

    try {
        await ensureGroupMemoryReady(group, { silent: true });
        for (const characterIndex of order) {
            if (shouldStopQueue()) break;
            const freshPacket = getRedPacket(packet.id) || packet;
            if (!freshPacket || freshPacket.remaining <= 0) break;
            const instruction = [
                '[ChatPulse Red Packet Event]',
                `${freshPacket.senderName || 'User'} 刚刚在群聊里发了红包。红包是当前群聊里的即时事件，不是普通背景信息。`,
                buildRedPacketReactInstruction(freshPacket),
                '现在轮到你立刻对此作出群聊反应：可以抢红包、起哄、道谢、调侃或自然接话，但不要无视红包。',
            ].join('\n\n');
            await generateForcedMember(characterIndex, instruction);
            autoClaimAvailablePackets(characterIndex);
            processRedPacketFromLatestMessage(characterIndex);
        }
        await processPostRoundMentionQueue(order);
    } catch (error) {
        console.error('[ChatPulseGroupLogic] Red packet reaction round failed:', error);
        toastr.error(error.message || String(error), 'ChatPulse Group Logic');
    } finally {
        state.orchestrator.active = false;
        state.orchestrator.currentInstruction = '';
        state.orchestrator.currentSourceIndex = -1;
        state.orchestrator.postRoundMentions = [];
        state.orchestrator.activeRedPacketId = null;
        state.orchestrator.redPacketEvents = [];
        finishQueue(shouldStopQueue() ? '已停止' : '红包反应结束');
        refreshStatus();
    }
}

async function runMembershipReactionRound(groupId, event) {
    const settings = getSettings();
    if (!settings.enabled || !settings.orchestratedEntry) return;
    const group = getCurrentGroup();
    if (!group || String(group.id) !== String(groupId)) return;
    if (state.orchestrator.active || state.automationActive || hasPersistedAutomationClaim(groupId) || is_group_generating) {
        toastr.warning('当前群聊仍在生成，成员变动反应会跳过。', 'ChatPulse Group Logic');
        return;
    }

    const memberIndexes = getGroupCharacters(group).map(item => item.index).filter(index => index >= 0);
    if (!memberIndexes.length) return;
    const focusAvatars = new Set(event?.memberAvatars || []);
    const focusIndexes = memberIndexes.filter(index => focusAvatars.has(characters[index]?.avatar));
    const restIndexes = shuffleArray(memberIndexes.filter(index => !focusIndexes.includes(index)));
    const order = event?.type === 'join'
        ? [...focusIndexes, ...restIndexes]
        : shuffleArray(memberIndexes);

    clearRuntimeState();
    state.generationCounter = 0;
    state.apiDelayMs = Math.max(0, Number(settings.apiDelayBaseMs) || DEFAULT_SETTINGS.apiDelayBaseMs);
    state.orchestrator.active = true;
    state.orchestrator.currentSourceIndex = (group.messages || []).length - 1;
    state.orchestrator.postRoundMentions = [];
    state.orchestrator.redPacketEvents = [];
    state.orchestrator.activeRedPacketId = null;
    beginQueue('membership', event?.type === 'join' ? '成员加入反应' : '成员移出反应', order, (characterIndex) => {
        const character = characters[characterIndex];
        return focusAvatars.has(character?.avatar) ? '成员变动本人' : '成员变动反应';
    });

    try {
        await ensureGroupMemoryReady(group, { silent: true });
        for (const characterIndex of order) {
            if (shouldStopQueue()) break;
            const character = characters[characterIndex];
            const isFocus = focusAvatars.has(character?.avatar);
            const instruction = event?.type === 'join'
                ? [
                    '[Group Member Event]',
                    isFocus
                        ? 'You were just added to this group chat. Say hello naturally in character.'
                        : `${event.memberName || 'Someone'} just joined this group chat. React naturally in character.`,
                    'Keep it short and conversational.',
                ].join('\n')
                : [
                    '[Group Member Event]',
                    `${event.memberName || 'Someone'} was just removed from this group chat.`,
                    'React naturally in character if you would say something. Keep it short and conversational.',
                ].join('\n');
            await generateForcedMember(characterIndex, instruction);
            autoClaimAvailablePackets(characterIndex);
            processRedPacketFromLatestMessage(characterIndex);
        }
        await processPostRoundMentionQueue(order);
    } catch (error) {
        console.error('[ChatPulseGroupLogic] Membership reaction round failed:', error);
        toastr.error(error.message || String(error), 'ChatPulse Group Logic');
    } finally {
        state.orchestrator.active = false;
        state.orchestrator.currentInstruction = '';
        state.orchestrator.currentSourceIndex = -1;
        state.orchestrator.postRoundMentions = [];
        state.orchestrator.activeRedPacketId = null;
        state.orchestrator.redPacketEvents = [];
        finishQueue(shouldStopQueue() ? '已停止' : '成员变动反应结束');
        refreshStatus();
    }
}

async function runOrchestratedRound(userText) {
    const settings = getSettings();
    if (!settings.enabled || !settings.orchestratedEntry) return;
    const group = getCurrentGroup();
    if (!group) {
        toastr.warning('请先打开一个 ChatPulse 群聊。');
        return;
    }
    if (state.orchestrator.active || state.automationActive || hasPersistedAutomationClaim(group.id) || is_group_generating) {
        toastr.warning('当前群聊仍在生成，请等待完成后再发送。', 'ChatPulse Group Logic');
        return false;
    }
    const text = normalizeText(userText);
    if (!text) return;
    const { mentioned, order } = buildRoundOrder(text);
    if (order.length === 0) {
        toastr.warning('当前群聊没有可发言的角色。');
        return;
    }

    clearRuntimeState();
    state.generationCounter = 0;
    state.apiDelayMs = Math.max(0, Number(getSettings().apiDelayBaseMs) || DEFAULT_SETTINGS.apiDelayBaseMs);
    state.orchestrator.active = true;
    const reusableUserMessageIndex = findReusableUserMessageIndex(group, text);
    const userName = getGroupUserName(group);
    const userPersonaAvatar = getGroupUserPersonaAvatar(group);
    state.orchestrator.currentSourceIndex = reusableUserMessageIndex >= 0
        ? reusableUserMessageIndex
        : appendLocalMessage(group, {
            is_user: true,
            name: userName,
            avatar: userPersonaAvatar || 'user',
            userPersonaAvatar,
            mes: text,
        });
    if (reusableUserMessageIndex >= 0) renderManagerModal();
    state.orchestrator.postRoundMentions = [];
    state.orchestrator.redPacketEvents = [];
    state.orchestrator.activeRedPacketId = null;
    beginQueue('round', '群聊轮询', order, (characterIndex) => mentioned.includes(characterIndex) ? '被 @ 点名' : '普通轮询');

    try {
        await ensureGroupMemoryReady(group, { silent: true });
        let activeOrder = [...order];
        let interruptedByRedPacket = false;
        for (let i = 0; i < order.length; i += 1) {
            if (shouldStopQueue()) break;
            const characterIndex = order[i];
            const packet = state.orchestrator.activeRedPacketId ? getRedPacket(state.orchestrator.activeRedPacketId) : null;
            const userAskedForRedPacket = isRedPacketRequestText(text) && (mentioned.length === 0 || mentioned.includes(characterIndex));
            const instruction = [
                buildInstructionForRoundMember(characterIndex, i, mentioned),
                userAskedForRedPacket
                    ? '用户这条消息是在要求/邀请你发红包。如果你同意发红包，必须在回复末尾附加 [REDPACKET_SEND:lucky|金额|份数|留言] 或 [REDPACKET_SEND:equal|金额|份数|留言]，否则系统不会创建红包卡片。'
                    : '',
                packet ? buildRedPacketReactInstruction(packet) : '',
            ].filter(Boolean).join('\n\n');
            const result = await generateForcedMember(characterIndex, instruction);
            autoClaimAvailablePackets(characterIndex);
            const createdPackets = result?.packets || [];
            if (createdPackets.length > 0) {
                const latestPacket = createdPackets[createdPackets.length - 1];
                state.orchestrator.activeRedPacketId = latestPacket.id;
                activeOrder = order.slice(i + 1);
                interruptedByRedPacket = true;
                break;
            }
        }

        if (interruptedByRedPacket && activeOrder.length > 0) {
            const packet = getRedPacket(state.orchestrator.activeRedPacketId);
            for (const characterIndex of shuffleArray(activeOrder)) {
                if (shouldStopQueue()) break;
                const instruction = buildRedPacketReactInstruction(packet);
                await generateForcedMember(characterIndex, instruction);
                autoClaimAvailablePackets(characterIndex);
                processRedPacketFromLatestMessage(characterIndex);
            }
        }

        await processPostRoundMentionQueue(order);

        for (const packet of state.orchestrator.redPacketEvents) {
            if (shouldStopQueue()) break;
            if (packet.feedbackDone) continue;
            const senderIndex = getCharacterIndexByAvatar(packet.senderAvatar);
            if (senderIndex < 0) continue;
            packet.feedbackDone = true;
            saveLocalState();
            const instruction = [
                '[ChatPulse Red Packet Feedback]',
                redPacketStatusLine(packet),
                'React in the group naturally in 1-2 short sentences. Do not output another REDPACKET_SEND tag unless you truly want to send a new red packet.',
            ].join('\n');
            await generateForcedMember(senderIndex, instruction);
        }
    } catch (error) {
        console.error('[ChatPulseGroupLogic] Orchestrated round failed:', error);
        toastr.error(error.message || String(error), 'ChatPulse Group Logic');
    } finally {
        state.orchestrator.active = false;
        state.orchestrator.currentInstruction = '';
        state.orchestrator.currentSourceIndex = -1;
        state.orchestrator.postRoundMentions = [];
        state.orchestrator.activeRedPacketId = null;
        state.orchestrator.redPacketEvents = [];
        finishQueue(shouldStopQueue() ? '已停止' : '群聊轮询结束');
        refreshStatus();
    }
    return true;
}

async function buildGroupLogicPrompt() {
    return await buildPrivateBridgePrompt();
}

function getMentionOptions(filter = '') {
    const group = getCurrentGroup();
    if (!group) return [];
    const query = String(filter || '').toLowerCase().replace(/\s+/g, '');
    const options = [
        { id: 'all', name: '全体成员', avatarUrl: '', all: true },
        ...getGroupCharacters(group).map(({ character }) => ({
            id: character.avatar,
            name: character.name || character.avatar,
            avatarUrl: getCharacterAvatarUrl(character),
            all: false,
        })),
    ];
    return options.filter(option => {
        const name = String(option.name || '').toLowerCase().replace(/\s+/g, '');
        return !query || name.includes(query) || query.includes(name);
    });
}

function hideMentionMenu() {
    state.mention.open = false;
    state.mention.start = -1;
    state.mention.filter = '';
    state.mention.index = 0;
    state.mention.options = [];
    $('#cpgl_mention_menu').hide().empty();
}

function renderMentionMenu() {
    const $menu = $('#cpgl_mention_menu');
    if (!$menu.length) return;
    if (!state.mention.open || !state.mention.options.length) {
        hideMentionMenu();
        return;
    }
    const html = state.mention.options.map((option, index) => `
        <button class="cpgl-mention-item ${index === state.mention.index ? 'active' : ''}" type="button" data-index="${index}">
            ${option.all ? '<span class="cpgl-mention-all">群</span>' : `<img src="${escapeHtml(option.avatarUrl)}" alt="">`}
            <span>${escapeHtml(option.name)}</span>
        </button>
    `).join('');
    $menu.html(html).show();
}

function updateMentionMenuFromInput(textarea = $('#cpgl_entry_text')[0]) {
    if (!textarea) return;
    const value = String(textarea.value || '');
    const cursor = textarea.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    const atIndex = beforeCursor.lastIndexOf('@');
    if (atIndex < 0) {
        hideMentionMenu();
        return;
    }
    const previous = atIndex > 0 ? beforeCursor[atIndex - 1] : '';
    const filter = beforeCursor.slice(atIndex + 1);
    if ((previous && !/\s/.test(previous)) || /[\s@,，。.!！？;；:：()（）[\]【】]/.test(filter)) {
        hideMentionMenu();
        return;
    }
    const options = getMentionOptions(filter);
    if (!options.length) {
        hideMentionMenu();
        return;
    }
    state.mention.open = true;
    state.mention.start = atIndex;
    state.mention.filter = filter;
    state.mention.index = Math.min(state.mention.index, options.length - 1);
    state.mention.options = options;
    renderMentionMenu();
}

function chooseMention(index = state.mention.index) {
    const textarea = $('#cpgl_entry_text')[0];
    const option = state.mention.options[index];
    if (!textarea || !option || state.mention.start < 0) return;
    const value = String(textarea.value || '');
    const cursor = textarea.selectionStart ?? value.length;
    const before = value.slice(0, state.mention.start);
    const after = value.slice(cursor);
    const insert = `@${option.name} `;
    textarea.value = `${before}${insert}${after}`;
    const nextCursor = before.length + insert.length;
    textarea.focus();
    textarea.setSelectionRange(nextCursor, nextCursor);
    syncComposerState(textarea);
    hideMentionMenu();
}

function hideEmojiPicker() {
    $('#cpgl_emoji_picker').hide();
}

function syncComposerState(textarea = $('#cpgl_entry_text')[0]) {
    $('.cpgl-chat-composer').toggleClass('has-text', !!normalizeText(textarea?.value));
}

function renderEmojiPicker() {
    const html = `
        <div class="cpgl-emoji-picker-close">
            <button id="cpgl_emoji_close" type="button" title="关闭"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
        ${QUICK_EMOJIS.map(emoji => `<button class="cpgl-emoji-item" type="button" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)}</button>`).join('')}
    `;
    $('#cpgl_emoji_picker').html(html);
}

function addEmojiToComposer(emoji) {
    const textarea = $('#cpgl_entry_text')[0];
    if (!textarea) return;
    const value = String(textarea.value || '');
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
    const nextCursor = start + emoji.length;
    textarea.focus();
    textarea.setSelectionRange(nextCursor, nextCursor);
    hideEmojiPicker();
    syncComposerState(textarea);
    updateMentionMenuFromInput(textarea);
}

globalThis.chatPulseGroupLogicInterceptor = async function chatPulseGroupLogicInterceptor(interceptedChat) {
    const prompt = await buildGroupLogicPrompt();
    if (!prompt) return;
    interceptedChat.push({
        name: 'ChatPulse Group Logic',
        is_user: false,
        is_system: true,
        mes: prompt,
        extra: {
            type: 'chatpulse_group_logic',
            ephemeral: true,
        },
    });
};

function onUserMessage(messageId) {
    clearPrivateMemoryCache();
    renderChatMessages();
}

function onAssistantMessage(messageId) {
    clearPrivateMemoryCache();
    renderChatMessages();
}

function clearRuntimeState() {
    if (state.nudgeTimer) clearTimeout(state.nudgeTimer);
    state.pendingMentionJobs = [];
    state.nudgeTimer = null;
    state.lastUserMessageId = -1;
    state.lastProcessedAssistantId = -1;
    state.secondaryDepth = 0;
    state.typing = [];
    renderTypingIndicator();
}

function syncLocalStateFromAnotherWindow(event) {
    if (event?.storageArea !== localStorage || event.key !== LOCAL_STATE_KEY) return;
    const previousActiveGroupId = state.activeGroupId;
    loadLocalState();
    if (state.localGroups.some(group => String(group?.id) === String(previousActiveGroupId))) {
        state.activeGroupId = previousActiveGroupId;
    }
    reconcileGroupAutomationTimers();
    clearPrivateMemoryCache();
    refreshStatus();
    recordCpglDebug('localState.synced', {
        groupCount: state.localGroups.length,
        activeGroupId: state.activeGroupId || '',
    });
}

function resetQueueState() {
    state.orchestrator.queue = {
        active: false,
        stopped: false,
        skipCurrent: false,
        type: '',
        label: '',
        message: '',
        currentIndex: -1,
        currentName: '',
        startedAt: 0,
        finishedAt: 0,
        items: [],
    };
}

function beginQueue(type, label, characterIndexes, reasonBuilder = null) {
    state.orchestrator.queue = {
        active: true,
        stopped: false,
        skipCurrent: false,
        type,
        label,
        message: label,
        currentIndex: -1,
        currentName: '',
        startedAt: Date.now(),
        finishedAt: 0,
        items: characterIndexes.map((characterIndex, index) => {
            const character = characters[characterIndex];
            return {
                id: `${character?.avatar || characterIndex}_${index}`,
                characterIndex,
                name: character?.name || `#${characterIndex}`,
                avatar: character?.avatar || '',
                status: 'pending',
                reason: typeof reasonBuilder === 'function' ? reasonBuilder(characterIndex, index) : '',
            };
        }),
    };
    renderQueuePanel();
}

function getQueueItem(characterIndex) {
    let item = state.orchestrator.queue.items.find(entry => entry.characterIndex === characterIndex && entry.status !== 'done' && entry.status !== 'skipped');
    if (!item) {
        const character = characters[characterIndex];
        item = {
            id: `${character?.avatar || characterIndex}_${Date.now()}`,
            characterIndex,
            name: character?.name || `#${characterIndex}`,
            avatar: character?.avatar || '',
            status: 'pending',
            reason: '追加回应',
        };
        state.orchestrator.queue.items.push(item);
    }
    return item;
}

function setQueueStage(message) {
    if (!state.orchestrator.queue) resetQueueState();
    state.orchestrator.queue.message = String(message || state.orchestrator.queue.label || '');
    renderQueuePanel();
}

function markQueueCurrent(characterIndex, message = '') {
    const queue = state.orchestrator.queue;
    if (!queue?.active) return;
    const item = getQueueItem(characterIndex);
    item.status = 'running';
    item.message = message;
    queue.currentIndex = characterIndex;
    queue.currentName = item.name;
    queue.message = message || `${item.name} 正在回复`;
    renderQueuePanel();
}

function finishQueueItem(characterIndex, status = 'done', message = '') {
    const queue = state.orchestrator.queue;
    if (!queue?.items) return;
    const item = queue.items.find(entry => entry.characterIndex === characterIndex && entry.status === 'running')
        || queue.items.find(entry => entry.characterIndex === characterIndex && entry.status === 'pending')
        || queue.items.find(entry => entry.characterIndex === characterIndex);
    if (item) {
        item.status = status;
        item.message = message;
        item.finishedAt = Date.now();
    }
    renderQueuePanel();
}

function finishQueue(message = '本轮结束') {
    const queue = state.orchestrator.queue;
    if (!queue) return;
    queue.active = false;
    queue.finishedAt = Date.now();
    queue.currentIndex = -1;
    queue.currentName = '';
    queue.message = message;
    renderQueuePanel();
}

function shouldStopQueue() {
    return !!state.orchestrator.queue?.stopped;
}

function consumeQueueSkip(characterIndex) {
    const queue = state.orchestrator.queue;
    if (!queue?.skipCurrent) return false;
    if (queue.currentIndex >= 0 && queue.currentIndex !== characterIndex) return false;
    queue.skipCurrent = false;
    return true;
}

function requestStopQueue() {
    const queue = state.orchestrator.queue;
    if (!queue) return;
    queue.stopped = true;
    queue.active = false;
    queue.message = '正在停止，已发出的请求返回后会丢弃结果';
    for (const item of queue.items) {
        if (item.status === 'pending') item.status = 'skipped';
    }
    renderQueuePanel();
}

function requestSkipQueueCurrent() {
    const queue = state.orchestrator.queue;
    if (!queue) return;
    queue.skipCurrent = true;
    queue.message = queue.currentName ? `准备跳过 ${queue.currentName}` : '准备跳过下一位';
    renderQueuePanel();
}

function renderSettings() {
    if (!$('#chatpulse_group_logic_settings').length && $('#extensions_settings').length) {
        const settings = getSettings();
        const html = `
        <div id="chatpulse_group_logic_settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>ChatPulse Group Logic</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cpgl-grid">
                    <label class="checkbox_label">
                        <input id="cpgl_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                        显示 ChatPulse 独立群聊入口
                    </label>
                    <div class="cpgl-row">
                        <label for="cpgl_context_limit">新群默认上下文条数</label>
                        <input id="cpgl_context_limit" type="number" min="4" max="80" step="1" value="${Number(settings.contextLimit) || DEFAULT_SETTINGS.contextLimit}">
                    </div>
                    <button id="cpgl_open_center_settings" class="menu_button cpgl-settings-open" type="button">打开独立群聊</button>
                    <div class="cpgl-hint">群成员、AI 互相接话、私聊注入、API 间隔、预设/正则、红包和清空记录都在独立群聊窗口的“群管理”中。</div>
                    <div id="cpgl_status" class="cpgl-hint"></div>
                </div>
            </div>
        </div>`;
        $('#extensions_settings').append(html);
    }
    renderOrchestratedEntry();
    renderManagerShell();
    bindSettingsEvents();
    bindNativeOpenEntrypoints();
    bindDebugClickProbe();
    bindDraggableLauncher();
    refreshStatus();
}

function renderOrchestratedEntry() {
    const topHolder = $('#top-settings-holder');
    if (topHolder.length && !$('#cpgl_top_launcher').length) {
        const topHtml = `
        <button id="cpgl_top_launcher" class="drawer cpgl-top-launcher" type="button" title="ChatPulse 群聊" aria-label="打开 ChatPulse 群聊">
            <span class="drawer-toggle drawer-header">
                <span class="drawer-icon fa-solid fa-comments fa-fw" aria-hidden="true"></span>
            </span>
        </button>`;
        topHolder.prepend(topHtml);
    }
    if (!$('#cpgl_launcher').length) {
        const html = `
        <button id="cpgl_launcher" type="button" title="ChatPulse 群聊">
            <span class="cpgl-launcher-mark"><i class="fa-solid fa-comments" aria-hidden="true"></i></span>
            <span class="cpgl-launcher-text">群聊</span>
        </button>`;
        $('body').append(html);
    }
    if (shouldShowFloatingLauncher()) {
        $('#cpgl_launcher').show();
        applyLauncherPosition();
    } else {
        $('#cpgl_launcher').hide();
    }
}

function clampNumber(value, min, max) {
    const number = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
}

function getLauncherDefaultPosition() {
    return { xRatio: 0.88, yRatio: 0.82 };
}

function shouldShowFloatingLauncher() {
    const hasTopEntry = $('#cpgl_top_launcher').length > 0;
    if (!hasTopEntry) return true;
    if (isTouchViewport()) return false;
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    return width <= 820;
}

function applyLauncherPosition() {
    const button = document.getElementById('cpgl_launcher');
    if (!button) return;
    const saved = getSettings().launcherPosition || getLauncherDefaultPosition();
    const width = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const height = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const x = clampNumber(saved.xRatio, 0, 1) * width;
    const y = clampNumber(saved.yRatio, 0, 1) * height;
    button.style.left = `${clampNumber(x - (rect.width || 52) / 2, margin, width - (rect.width || 52) - margin)}px`;
    button.style.top = `${clampNumber(y - (rect.height || 52) / 2, margin, height - (rect.height || 52) - margin)}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
    button.style.transform = 'none';
    button.classList.add('is-positioned');
}

function bindDraggableLauncher() {
    const button = document.getElementById('cpgl_launcher');
    if (!button || button.dataset.cpglDragBound === '1') return;
    button.dataset.cpglDragBound = '1';
    let drag = null;

    button.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        if (isTouchViewport()) {
            safeOpenGroupCenter(event, {
                element: button,
                via: 'launcher-pointerdown',
                actualTarget: event.target,
                point: getEventClientPoint(event),
            });
            return;
        }
        const rect = button.getBoundingClientRect();
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            moved: false,
        };
        button.setPointerCapture?.(event.pointerId);
        button.classList.add('is-dragging');
    });

    button.addEventListener('pointermove', event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.hypot(dx, dy) > 5) drag.moved = true;
        if (!drag.moved) return;
        event.preventDefault();
        const width = window.innerWidth || document.documentElement.clientWidth || 1;
        const height = window.innerHeight || document.documentElement.clientHeight || 1;
        const rect = button.getBoundingClientRect();
        const margin = 8;
        button.style.left = `${clampNumber(event.clientX - drag.offsetX, margin, width - rect.width - margin)}px`;
        button.style.top = `${clampNumber(event.clientY - drag.offsetY, margin, height - rect.height - margin)}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
        button.style.transform = 'none';
    }, { passive: false });

    button.addEventListener('pointerup', event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const wasMoved = drag.moved;
        button.releasePointerCapture?.(event.pointerId);
        button.classList.remove('is-dragging');
        drag = null;
        if (wasMoved) {
            const rect = button.getBoundingClientRect();
            getSettings().launcherPosition = {
                xRatio: (rect.left + rect.width / 2) / Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1),
                yRatio: (rect.top + rect.height / 2) / Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1),
            };
            saveSettings();
            event.preventDefault();
            event.stopPropagation();
            button.dataset.cpglSuppressClick = '1';
            setTimeout(() => delete button.dataset.cpglSuppressClick, 0);
        } else {
            safeOpenGroupCenter(event);
        }
    });

    button.addEventListener('pointercancel', event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        button.releasePointerCapture?.(event.pointerId);
        button.classList.remove('is-dragging');
        drag = null;
    });
}

function renderManagerShell() {
    if ($('#cpgl_manager_modal').length) return;
    const html = `
    <div id="cpgl_manager_modal" class="cpgl-modal-backdrop" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="cpgl_chat_title">
        <div class="cpgl-app-shell">
            <nav class="cpgl-sidebar-nav" aria-label="群聊中心导航">
                <div class="cpgl-nav-avatar" aria-hidden="true">
                    <i class="fa-solid fa-user"></i>
                </div>
                <button id="cpgl_group_list_toggle" class="cpgl-nav-item active" type="button" title="群聊列表" aria-label="打开或关闭群聊列表" aria-expanded="false" aria-controls="cpgl_group_list">
                    <i class="fa-solid fa-comment-dots" aria-hidden="true"></i>
                    <em id="cpgl_group_count_badge" aria-hidden="true">0</em>
                </button>
                <div class="cpgl-nav-spacer" aria-hidden="true"></div>
                <span class="cpgl-nav-visual" title="通讯录" aria-hidden="true"><i class="fa-solid fa-address-book"></i></span>
                <span class="cpgl-nav-visual" title="收藏" aria-hidden="true"><i class="fa-solid fa-cube"></i></span>
                <button id="cpgl_manager_close" class="cpgl-nav-item" type="button" title="关闭" aria-label="关闭群聊中心">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </nav>
            <aside class="cpgl-middle-column">
                <div class="cpgl-middle-header">
                    <div class="cpgl-mobile-list-title">微信</div>
                    <label class="cpgl-group-search" for="cpgl_group_search">
                        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                        <input id="cpgl_group_search" type="search" placeholder="搜索" autocomplete="off">
                    </label>
                    <button id="cpgl_show_create" class="cpgl-icon-btn cpgl-create-shortcut" type="button" title="发起群聊" aria-label="发起一个新群聊">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    </button>
                </div>
                <div id="cpgl_group_list" class="cpgl-chat-list"></div>
            </aside>
            <main class="cpgl-right-column">
                <section class="cpgl-chat-window">
                    <header class="cpgl-chat-header">
                        <div class="cpgl-chat-header-title">
                            <button id="cpgl_mobile_back_to_groups" class="cpgl-mobile-back" type="button" title="返回群聊列表" aria-label="返回群聊列表">
                                <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
                            </button>
                            <span class="cpgl-header-icon" aria-hidden="true"><i class="fa-solid fa-user-group"></i></span>
                            <div>
                                <div id="cpgl_chat_title" class="cpgl-chat-header-name">选择或创建一个群聊</div>
                                <div id="cpgl_chat_subtitle" class="cpgl-hint">ChatPulse 轮询逻辑会接管这个窗口里的发送。</div>
                            </div>
                        </div>
                        <div class="cpgl-chat-header-actions">
                            <button id="cpgl_mobile_create_group" type="button" title="发起群聊" aria-label="发起一个新群聊"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
                            <button id="cpgl_header_delete_messages" type="button" title="选择删除对话" aria-label="进入消息选择删除模式" aria-pressed="false"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
                            <button id="cpgl_help_button" type="button" title="使用帮助" aria-label="打开使用帮助"><i class="fa-regular fa-circle-question" aria-hidden="true"></i></button>
                            <button id="cpgl_manage_toggle" type="button" title="群管理" aria-label="打开群管理" aria-expanded="false" aria-controls="cpgl_manage_drawer"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>
                        </div>
                    </header>
                    <div id="cpgl_queue_panel" class="cpgl-queue-panel" style="display:none;" role="status" aria-live="polite"></div>
                    <div id="cpgl_chat_messages" class="cpgl-chat-messages"></div>
                    <div id="cpgl_typing_indicator" class="cpgl-typing-indicator" style="display:none;" role="status" aria-live="polite"></div>
                    <div id="cpgl_delete_mode_bar" class="cpgl-delete-mode-bar" style="display:none;"></div>
                    <div class="cpgl-chat-composer">
                        <div id="cpgl_mention_menu" class="cpgl-mention-menu" style="display:none;"></div>
                        <div class="cpgl-input-toolbar">
                            <button id="cpgl_emoji_toggle" type="button" title="插入表情" aria-label="打开表情选择器"><i class="fa-regular fa-face-smile" aria-hidden="true"></i></button>
                            <button id="cpgl_quick_redpacket" type="button" title="更多（当前可发红包）" aria-label="打开更多功能并发送红包"><i class="fa-solid fa-circle-plus" aria-hidden="true"></i></button>
                        <div id="cpgl_emoji_picker" class="cpgl-emoji-picker" style="display:none;"></div>
                        </div>
                        <label class="cpgl-visually-hidden" for="cpgl_entry_text">群聊消息</label>
                        <textarea id="cpgl_entry_text" rows="3" placeholder="发消息"></textarea>
                        <div class="cpgl-entry-actions">
                            <button id="cpgl_entry_send" class="cpgl-send-button" type="button">发送</button>
                        </div>
                    </div>
                </section>
                <button id="cpgl_manage_scrim" class="cpgl-manage-scrim" type="button" aria-label="关闭群管理" style="display:none;"></button>
                <aside id="cpgl_manage_drawer" class="cpgl-manage-drawer">
                    <div class="cpgl-drawer-header">
                        <strong>聊天信息</strong>
                        <button id="cpgl_manage_close" class="cpgl-icon-btn" type="button" title="关闭" aria-label="关闭群管理">
                            <i class="fa-solid fa-xmark cpgl-drawer-close-desktop" aria-hidden="true"></i>
                            <i class="fa-solid fa-chevron-left cpgl-drawer-close-mobile" aria-hidden="true"></i>
                        </button>
                    </div>
                    <div class="cpgl-drawer-intro">
                        <strong>调整当前群聊</strong>
                        <span>带“所有群共用”的项目会同时影响其他 ChatPulse 群聊。</span>
                    </div>
                    <div class="cpgl-mobile-drawer-tools" aria-label="手机端快捷操作">
                        <button id="cpgl_mobile_open_help" type="button">
                            <i class="fa-regular fa-circle-question" aria-hidden="true"></i>
                            <span>使用帮助</span>
                        </button>
                        <button id="cpgl_mobile_delete_messages" type="button">
                            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
                            <span>选择删除</span>
                        </button>
                    </div>
                    <nav class="cpgl-drawer-jump-nav" aria-label="群管理快速导航">
                        <button type="button" data-target="#cpgl_group_identity_section">基础</button>
                        <button type="button" data-target="#cpgl_group_members_section">成员</button>
                        <button type="button" data-target="#cpgl_world_info_section">世界书</button>
                        <button type="button" data-target="#cpgl_memory_section">记忆</button>
                        <button type="button" data-target="#cpgl_debug_section">调试</button>
                    </nav>
                    <section id="cpgl_group_identity_section" class="cpgl-section">
                        <h4>群名称 <span class="cpgl-scope-badge">当前群</span></h4>
                        <div class="cpgl-group-name-row">
                            <input id="cpgl_group_name_input" type="text" placeholder="群聊名称" aria-label="群聊名称">
                            <button id="cpgl_rename_group" class="cpgl-icon-btn" type="button" title="修改群名">✎</button>
                        </div>
                    </section>
                    <section id="cpgl_group_persona_section" class="cpgl-section">
                        <h4>你在群里的身份 <span class="cpgl-scope-badge">当前群</span></h4>
                        <select id="cpgl_group_user_persona_select" aria-label="当前群使用的 User 人设"></select>
                        <div id="cpgl_group_user_persona_hint" class="cpgl-hint"></div>
                    </section>
                    <section id="cpgl_message_delete_section" class="cpgl-section">
                        <h4>选择删除对话</h4>
                        <div class="cpgl-delete-toolbar">
                            <button id="cpgl_select_all_messages" type="button" class="menu_button">全选</button>
                            <button id="cpgl_select_no_messages" type="button" class="menu_button">取消</button>
                        </div>
                        <div id="cpgl_message_delete_list" class="cpgl-delete-message-list"></div>
                        <button id="cpgl_delete_selected_messages" type="button" class="cpgl-danger-outline" disabled>删除选中</button>
                    </section>
                    <section id="cpgl_group_members_section" class="cpgl-section">
                        <h4>群成员 <span id="cpgl_member_count">(0)</span> <span class="cpgl-scope-badge">当前群</span></h4>
                        <div id="cpgl_current_members" class="cpgl-list"></div>
                        <div class="cpgl-row cpgl-add-row">
                            <select id="cpgl_add_member_select" aria-label="选择要加入当前群的角色"></select>
                            <button id="cpgl_add_member" class="menu_button">拉人</button>
                        </div>
                    </section>
                    <section id="cpgl_queue_section" class="cpgl-section">
                        <h4>运行队列 <span class="cpgl-scope-badge">当前任务</span></h4>
                        <div id="cpgl_queue_drawer" class="cpgl-queue-drawer"></div>
                    </section>
                    <section id="cpgl_group_ai_section" class="cpgl-section">
                        <h4>本群 AI 行为 <span class="cpgl-scope-badge">当前群</span></h4>
                        <label class="cpgl-switch-row">
                            <span>⚡ 禁止 AI 因互相 @ 追加回复</span>
                            <input id="cpgl_drawer_no_chain" type="checkbox">
                            <i></i>
                        </label>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>📥 跨聊原文备用条数</span>
                                <strong id="cpgl_drawer_inject_value">0</strong>
                            </div>
                            <input id="cpgl_drawer_inject_limit" type="range" min="0" max="30" step="1" aria-label="跨聊原文备用条数">
                            <p>只在权限允许且 User persona 相同时读取近期原文。0 = 只用已有摘要。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>🧠 AI 记忆视界（上下文条数）</span>
                                <strong id="cpgl_drawer_context_value">0</strong>
                            </div>
                            <input id="cpgl_drawer_context_limit" type="range" min="4" max="80" step="1" aria-label="群聊上下文条数">
                            <p>AI 在本群能感知的最近消息条数。超出该线的旧消息将被忽略。</p>
                        </div>
                    </section>
                    <section id="cpgl_global_generation_section" class="cpgl-section">
                        <h4>生成节奏 <span class="cpgl-scope-badge is-global">所有群共用</span></h4>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>⏱ API 初始间隔</span>
                                <strong id="cpgl_api_base_value">0s</strong>
                            </div>
                            <input id="cpgl_api_base_delay" type="range" min="0" max="20000" step="500" aria-label="初始 API 间隔">
                            <p>每轮第一个角色请求前等待多久。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>⏳ 每次递增间隔</span>
                                <strong id="cpgl_api_step_value">0s</strong>
                            </div>
                            <input id="cpgl_api_step_delay" type="range" min="0" max="10000" step="500" aria-label="每次递增 API 间隔">
                            <p>同一轮里，每多一个角色，请求间隔增加多少。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>🧯 最大退避间隔</span>
                                <strong id="cpgl_api_max_value">0s</strong>
                            </div>
                            <input id="cpgl_api_max_delay" type="range" min="3000" max="60000" step="1000" aria-label="最大 API 退避间隔">
                            <p>撞到 Too Many Requests 后，间隔会自动提高但不超过这里。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>📏 输出上限</span>
                                <strong id="cpgl_response_length_value">3000</strong>
                            </div>
                            <input id="cpgl_response_length" type="range" min="500" max="6000" step="100" aria-label="单个角色输出上限">
                            <p>单个角色每次生成的最大输出长度。</p>
                        </div>
                    </section>
                    <section id="cpgl_world_info_section" class="cpgl-section">
                        <h4>群聊世界书 <span class="cpgl-scope-badge">当前群</span></h4>
                        <p class="cpgl-hint">可不选择；世界书不是群聊必需项，角色卡本身仍会生效。</p>
                        <label class="cpgl-switch-row">
                            <span>同时读取成员角色卡世界书</span>
                            <input id="cpgl_include_character_world_info" type="checkbox">
                            <i></i>
                        </label>
                        <div id="cpgl_world_info_status" class="cpgl-hint"></div>
                        <div id="cpgl_world_info_books" class="cpgl-world-book-list"></div>
                    </section>
                    <section id="cpgl_memory_section" class="cpgl-section">
                        <h4>长期记忆 <span class="cpgl-scope-badge">当前群</span></h4>
                        <label class="cpgl-switch-row">
                            <span>启用本群共享摘要</span>
                            <input id="cpgl_memory_enabled" type="checkbox">
                            <i></i>
                        </label>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>R 原文窗口</span>
                                <strong id="cpgl_memory_r_value">24</strong>
                            </div>
                            <input id="cpgl_memory_r" type="range" min="4" max="120" step="1" aria-label="长期记忆原文窗口 R">
                            <p>最新 R 条消息保留原文，窗口外消息才会被总结。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>S 触发阈值</span>
                                <strong id="cpgl_memory_s_value">16</strong>
                            </div>
                            <input id="cpgl_memory_s" type="range" min="4" max="80" step="1" aria-label="长期记忆触发阈值 S">
                            <p>窗口外未摘要消息达到 S 条时，回复前先总结；失败则中止本轮。</p>
                        </div>
                        <div class="cpgl-row">
                            <label for="cpgl_summary_provider">总结模型 <span class="cpgl-scope-badge is-global">所有群共用</span></label>
                            <select id="cpgl_summary_provider">
                                <option value="current">当前模型</option>
                                <option value="custom">自定义小模型</option>
                            </select>
                        </div>
                        <div id="cpgl_summary_custom_fields" class="cpgl-summary-custom">
                            <label>
                                <span>Endpoint</span>
                                <input id="cpgl_summary_custom_url" type="text" placeholder="https://api.example.com/v1">
                            </label>
                            <label>
                                <span>Model</span>
                                <div id="cpgl_summary_model_combo" class="cpgl-summary-model-combo">
                                    <input id="cpgl_summary_custom_model" type="text" placeholder="gpt-4o-mini / qwen-turbo / local-model" autocomplete="off">
                                    <button id="cpgl_summary_model_toggle" type="button" title="读取模型列表" aria-label="读取模型列表">⌄</button>
                                    <div id="cpgl_summary_model_menu" class="cpgl-summary-model-menu"></div>
                                </div>
                                <small id="cpgl_summary_model_status" class="cpgl-summary-model-status"></small>
                            </label>
                            <label>
                                <span>Temperature</span>
                                <input id="cpgl_summary_temperature" type="number" min="0" max="2" step="0.1">
                            </label>
                            <p class="cpgl-hint">自定义小模型走 SillyTavern 的 Custom OpenAI-compatible 后端，API Key 使用 ST 全局 Custom API Key。</p>
                        </div>
                        <label class="cpgl-switch-row">
                            <span>私聊可读取本群记忆</span>
                            <input id="cpgl_expose_group_memory_private" type="checkbox">
                            <i></i>
                        </label>
                        <label class="cpgl-switch-row">
                            <span>本群可读取角色私聊记忆</span>
                            <input id="cpgl_allow_private_memory_group" type="checkbox">
                            <i></i>
                        </label>
                        <label class="cpgl-switch-row">
                            <span>本群可读取角色其他群记忆</span>
                            <input id="cpgl_allow_other_group_memory" type="checkbox">
                            <i></i>
                        </label>
                        <div id="cpgl_memory_status" class="cpgl-hint"></div>
                        <div class="cpgl-row">
                            <button id="cpgl_summarize_now" type="button" class="menu_button">立即总结</button>
                            <button id="cpgl_clear_memory" type="button" class="cpgl-danger-outline">清空摘要</button>
                        </div>
                        <div id="cpgl_memory_summaries" class="cpgl-memory-summaries"></div>
                    </section>
                    <section id="cpgl_preset_section" class="cpgl-section">
                        <h4>独立预设 / 正则 <span class="cpgl-scope-badge is-global">所有群共用</span></h4>
                        <textarea id="cpgl_local_preset" rows="6" placeholder="导入或编辑这个弹窗专用的群聊预设"></textarea>
                        <label class="cpgl-switch-row">
                            <span>把上方预设作为附加约束发送</span>
                            <input id="cpgl_include_local_preset" type="checkbox">
                            <i></i>
                        </label>
                        <textarea id="cpgl_local_regex" rows="4" placeholder="每行一个正则：pattern => replacement"></textarea>
                        <div class="cpgl-row">
                            <button id="cpgl_import_preset_regex" type="button" class="cpgl-danger-outline">导入预设/正则</button>
                            <input id="cpgl_import_file" type="file" accept=".json,.txt" style="display:none;">
                        </div>
                    </section>
                    <section id="cpgl_debug_section" class="cpgl-section">
                        <h4>最近输入 / 输出 <span class="cpgl-scope-badge">当前群</span></h4>
                        <p class="cpgl-hint">仅保留在当前页面会话中，刷新后自动清空，避免把私聊原文长期写入浏览器存储。</p>
                        <div id="cpgl_debug_logs" class="cpgl-debug-logs"></div>
                        <button id="cpgl_clear_debug_logs" type="button" class="cpgl-danger-outline">清空调试记录</button>
                    </section>
                    <section id="cpgl_redpacket_history_section" class="cpgl-section">
                        <h4>红包记录 <span class="cpgl-scope-badge">当前群</span></h4>
                        <div id="cpgl_red_packet_list" class="cpgl-list"></div>
                    </section>
                    <section id="cpgl_danger_section" class="cpgl-section cpgl-danger-section">
                        <h4>危险操作</h4>
                        <button id="cpgl_clear_queue_danger" type="button" class="cpgl-danger-outline">清空队列</button>
                        <button id="cpgl_clear_messages_danger" type="button" class="cpgl-danger-outline">删除对话记录</button>
                        <button id="cpgl_delete_group_danger" type="button" class="cpgl-danger-outline cpgl-danger-strong">删除当前群聊</button>
                    </section>
                </aside>
            </main>
        </div>
        <div id="cpgl_create_modal" class="cpgl-create-modal" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="cpgl_create_title">
            <div class="cpgl-create-card">
                <div class="cpgl-create-header">
                    <div>
                        <span class="cpgl-create-eyebrow">创建群聊</span>
                        <strong id="cpgl_create_title">组建你的聊天小队</strong>
                        <small>群名、人设和成员只属于这个群，之后仍可修改。</small>
                    </div>
                    <button id="cpgl_create_modal_close" type="button" class="cpgl-icon-btn" aria-label="关闭创建群聊"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                </div>
                <div class="cpgl-create-body">
                    <label class="cpgl-create-field">
                        <span><b>1</b> 群聊名称 <small>留空会根据成员自动命名</small></span>
                        <input id="cpgl_new_group_name" type="text" maxlength="48" autocomplete="off" placeholder="例如：星港夜话">
                    </label>
                    <label class="cpgl-create-field">
                        <span><b>2</b> 你在这个群中的身份 <small>使用已有 SillyTavern User 人设</small></span>
                        <select id="cpgl_new_user_persona"></select>
                    </label>
                    <section class="cpgl-create-member-section" aria-labelledby="cpgl_create_member_title">
                        <div class="cpgl-create-member-heading">
                            <span id="cpgl_create_member_title"><b>3</b> 选择群成员</span>
                            <strong id="cpgl_create_selected_count">已选择 0 位</strong>
                        </div>
                        <div class="cpgl-search-shell">
                            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                            <label class="cpgl-visually-hidden" for="cpgl_create_search">搜索角色</label>
                            <input id="cpgl_create_search" type="text" autocomplete="off" placeholder="搜索角色...">
                        </div>
                        <div id="cpgl_create_members" class="cpgl-create-members"></div>
                    </section>
                    <div class="cpgl-create-footer">
                        <span id="cpgl_create_validation" role="status" aria-live="polite">至少选择一位角色才能创建。</span>
                        <button id="cpgl_create_group" class="cpgl-send-button" type="button" disabled>
                            创建群聊
                            <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <div id="cpgl_redpacket_modal" class="cpgl-redpacket-modal" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="cpgl_redpacket_title">
            <div class="cpgl-redpacket-card">
                <div class="cpgl-redpacket-header">
                    <strong id="cpgl_redpacket_title"><i class="fa-solid fa-envelope-open-text" aria-hidden="true"></i> 发送红包</strong>
                    <button id="cpgl_redpacket_close" type="button" aria-label="关闭红包窗口"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                </div>
                <div class="cpgl-redpacket-tabs">
                    <button id="cpgl_packet_lucky" class="active" type="button"><i class="fa-solid fa-shuffle" aria-hidden="true"></i> 拼手气</button>
                    <button id="cpgl_packet_fixed" type="button"><i class="fa-solid fa-box" aria-hidden="true"></i> 普通</button>
                </div>
                <div class="cpgl-redpacket-body">
                    <label>
                        <span>红包个数</span>
                        <input id="cpgl_user_packet_count" type="number" min="1" step="1" value="3">
                    </label>
                    <label>
                        <span id="cpgl_packet_amount_label">总金额（元）</span>
                        <input id="cpgl_user_packet_amount" type="number" min="0.01" step="0.01" placeholder="¥">
                    </label>
                    <label>
                        <span>留言（可选）</span>
                        <input id="cpgl_user_packet_note" type="text" placeholder="写点什么...">
                    </label>
                    <div class="cpgl-redpacket-summary">
                        <div><span>合计:</span><strong id="cpgl_packet_total_preview">¥0.00</strong></div>
                    </div>
                    <button id="cpgl_user_packet_send" class="cpgl-redpacket-send" type="button"><i class="fa-solid fa-envelope" aria-hidden="true"></i> 塞钱进红包</button>
                </div>
            </div>
        </div>
        <div id="cpgl_help_modal" class="cpgl-help-modal" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="cpgl_help_title">
            <div class="cpgl-help-card">
                <header class="cpgl-help-header">
                    <div>
                        <span>ChatPulse 使用手册</span>
                        <h2 id="cpgl_help_title">从建群到长期记忆，一次看懂</h2>
                    </div>
                    <button id="cpgl_help_close" type="button" aria-label="关闭使用帮助"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                </header>
                <div class="cpgl-help-body">
                    <section class="cpgl-help-quickstart">
                        <div class="cpgl-help-section-title">
                            <h3>快速开始</h3>
                            <small>第一次只需要完成四件事</small>
                        </div>
                        <ol>
                            <li><b aria-hidden="true">1</b><div><strong>确认 ST 普通私聊可生成</strong><span>群聊直接复用 SillyTavern 当前连接的模型/API。</span></div></li>
                            <li><b aria-hidden="true">2</b><div><strong>发起群聊</strong><span>填写群名，并从 ST 已有 User 人设中选择你在本群的身份。</span></div></li>
                            <li><b aria-hidden="true">3</b><div><strong>选择至少一位角色</strong><span>可以把不同的 SillyTavern 角色卡放进同一个群，之后也能继续拉人或踢人。</span></div></li>
                            <li><b aria-hidden="true">4</b><div><strong>发送第一条消息</strong><span>不写 @ 会随机轮询；@角色 会让对方优先回复。</span></div></li>
                        </ol>
                    </section>
                    <section>
                        <div class="cpgl-help-section-title"><h3>按钮图鉴</h3><small>界面中的核心操作</small></div>
                        <div class="cpgl-help-feature-grid">
                            <article><b aria-hidden="true"><i class="fa-solid fa-plus"></i></b><div><strong>新建群聊</strong><span>电脑端在左侧群列表，手机端先返回群列表，再点标题栏的“＋”。</span></div></article>
                            <article><b aria-hidden="true"><i class="fa-solid fa-comments"></i></b><div><strong>群列表</strong><span>手机端从聊天页左上角返回切换旧群。</span></div></article>
                            <article><b aria-hidden="true"><i class="fa-regular fa-face-smile"></i></b><div><strong>表情</strong><span>把表情插入输入框，不会立刻发送。</span></div></article>
                            <article><b aria-hidden="true"><i class="fa-solid fa-circle-plus"></i></b><div><strong>红包</strong><span>点输入框旁圆形“＋”，发送普通或拼手气红包。</span></div></article>
                            <article><b aria-hidden="true"><i class="fa-regular fa-trash-can"></i></b><div><strong>按条删除</strong><span>电脑端点标题栏垃圾桶；手机端从“··· → 选择删除”进入。</span></div></article>
                            <article><b aria-hidden="true"><i class="fa-solid fa-ellipsis"></i></b><div><strong>群管理</strong><span>成员、世界书、记忆、队列和调试都在这里。</span></div></article>
                            <article><b aria-hidden="true"><i class="fa-regular fa-clock"></i></b><div><strong>成员主动消息</strong><span>群管理 → 群成员 → 点开角色；每个“群 × 角色”都有独立计时与嫉妒设置。</span></div></article>
                            <article><b aria-hidden="true"><i class="fa-solid fa-plug"></i></b><div><strong>角色群聊 API</strong><span>同一成员卡片内配置；该角色在本扩展所有群共用，留空则跟随 ST 当前 API。</span></div></article>
                            <article><b aria-hidden="true"><i class="fa-regular fa-circle-question"></i></b><div><strong>帮助</strong><span>电脑端点“?”；手机端从“··· → 使用帮助”进入。</span></div></article>
                        </div>
                    </section>
                    <section class="cpgl-help-rules">
                        <div class="cpgl-help-section-title"><h3>消息如何触发回复</h3><small>发送前先看这一条</small></div>
                        <div><strong>普通消息</strong><span>所有群成员随机排序，依次自然接话。</span></div>
                        <div><strong>@角色</strong><span>被点名角色优先，其他成员随后继续接话。</span></div>
                        <div><strong>@全体</strong><span>对全体成员发言，成员顺序仍会随机。</span></div>
                        <div><strong>角色主动消息</strong><span>只由该角色向指定微信群聊发送一条消息；嫉妒会并入同一条，不触发 @、红包或其他角色连锁回复。</span></div>
                        <div><strong>Ctrl / ⌘ + Enter</strong><span>电脑端快速发送；单独 Enter 用于换行。</span></div>
                    </section>
                    <section class="cpgl-help-notice">
                        <h3>关于记忆与隐私</h3>
                        <p>每个群默认开启本群长期摘要；“私聊可读取本群记忆”默认开启。角色私聊或其他群的记忆默认不会进入本群，可在群管理中单独授权；即使授权，也只会在同一个 User 人设之间共享。</p>
                        <p>群聊、红包和摘要保存在当前浏览器 localStorage，不会创建 SillyTavern 原生群聊。清除站点数据会丢失；换设备、浏览器或 ST 地址不会自动同步。完整 Prompt 与输出调试只保留在当前页面会话中，刷新后自动清除。</p>
                    </section>
                    <section class="cpgl-help-rules">
                        <div class="cpgl-help-section-title"><h3>常见疑问</h3><small>第一次使用最容易卡住的地方</small></div>
                        <div><strong>User 怎么选？</strong><span>建群时从 SillyTavern 已有 User 人设中选择；若列表没有想要的身份，请先在 ST 创建或启用它，再刷新页面。没有可用人设时会使用 ST 当前用户名显示，但不会启用跨聊记忆。</span></div>
                        <div><strong>还要单独连接 API 吗？</strong><span>不需要：每个角色默认复用 ST 当前模型/API。若希望群聊里的某个角色使用另一套模型，可在“群管理 → 群成员 → 角色群聊 API”填写 Endpoint、Model 和 Key；这套配置按角色在本扩展所有群共用，Key 由 ST Secrets 保存。长期记忆的“小模型总结 API”仍是另一套独立设置。</span></div>
                        <div><strong>主动消息和嫉妒会不会刷屏？</strong><span>不会。每个角色在每个群有独立计时；一次到点最多发送一条。嫉妒只会改变这条主动消息的表达，不会再生成第二条，也不会引发群聊接龙。</span></div>
                        <div><strong>世界书必须挂吗？</strong><span>不必须。没有世界书也会使用角色卡、User 人设和本群上下文正常生成。</span></div>
                        <div><strong>为什么第二个群像“不见了”？</strong><span>两个群都会保留。电脑端看左侧群列表；手机端点聊天页左上角返回箭头。不同角色卡也可以加入同一个群。</span></div>
                        <div><strong>创建按钮为什么是灰色？</strong><span>至少勾选一张角色卡才能创建。若列表为空，请先在 SillyTavern 导入或创建角色卡，再重新打开建群窗口。</span></div>
                    </section>
                    <section class="cpgl-help-troubleshoot">
                        <div class="cpgl-help-section-title"><h3>没有回复时</h3><small>按顺序检查</small></div>
                        <ol>
                            <li>确认 SillyTavern 普通私聊可以正常生成。</li>
                            <li>确认当前群至少有一位有效角色成员。</li>
                            <li>查看运行队列是否正在等待 API 间隔或速率退避。</li>
                            <li>打开群管理里的“最近输入 / 输出”，查看错误、Prompt 与 Raw Output；失败请求也会留下诊断。</li>
                            <li>世界书不是回复的前置条件，无需为了排错临时挂一本。</li>
                        </ol>
                    </section>
                </div>
                <footer class="cpgl-help-footer">
                    <span>完整说明：<a href="https://github.com/NANA3333333/ChatPulseGroupLogic/blob/main/USER_GUIDE.md" target="_blank" rel="noopener noreferrer">USER_GUIDE.md</a></span>
                    <button id="cpgl_help_restart_tour" type="button">重新开始引导（不删除群聊）</button>
                </footer>
            </div>
        </div>
    </div>`;
    $('body').append(html);
    ensureOnboardingRoot();
    renderManagerModal();
}

function characterOptionHtml(character, checked = false) {
    return `
        <label class="cpgl-member-option ${checked ? 'is-selected' : ''}">
            <input type="checkbox" value="${escapeHtml(character.avatar)}" ${checked ? 'checked' : ''}>
            <img src="${escapeHtml(getCharacterAvatarUrl(character))}" alt="">
            <span>${escapeHtml(character.name || character.avatar)}</span>
            <i aria-hidden="true">${checked ? '✓' : ''}</i>
        </label>`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function ensureOnboardingRoot() {
    if ($('#cpgl_tour_root').length) return;
    $('body').append(`
        <div id="cpgl_tour_root" class="cpgl-tour-root" style="display:none;" aria-hidden="true">
            <div id="cpgl_tour_spotlight" class="cpgl-tour-spotlight"></div>
            <svg id="cpgl_tour_arrow" class="cpgl-tour-arrow" aria-hidden="true">
                <defs>
                    <marker id="cpgl_tour_arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z"></path>
                    </marker>
                </defs>
                <path id="cpgl_tour_arrow_path" marker-end="url(#cpgl_tour_arrowhead)"></path>
            </svg>
            <section id="cpgl_tour_card" class="cpgl-tour-card" role="dialog" aria-live="polite" aria-labelledby="cpgl_tour_title" aria-describedby="cpgl_tour_description" tabindex="-1">
                <div class="cpgl-tour-topline">
                    <span id="cpgl_tour_progress">新手任务</span>
                    <button id="cpgl_tour_skip" type="button">跳过引导</button>
                </div>
                <div class="cpgl-tour-progress-track" aria-hidden="true"><i id="cpgl_tour_progress_bar"></i></div>
                <span id="cpgl_tour_kicker" class="cpgl-tour-kicker"></span>
                <h3 id="cpgl_tour_title"></h3>
                <div id="cpgl_tour_description" class="cpgl-tour-description"></div>
                <div id="cpgl_tour_callout" class="cpgl-tour-callout"></div>
                <div class="cpgl-tour-actions">
                    <span id="cpgl_tour_instruction"></span>
                    <button id="cpgl_tour_retry" type="button" class="cpgl-tour-secondary" style="display:none;">重新检测</button>
                    <button id="cpgl_tour_next" type="button">下一步</button>
                </div>
            </section>
        </div>
    `);
}

function getOnboardingSteps() {
    const personaCount = getAvailableUserPersonas().length;
    const characterCount = characters.length;
    const steps = [
        {
            id: 'welcome',
            kicker: '欢迎来到 ChatPulse',
            title: '用一分钟，创建你的第一个群聊',
            description: `
                <p>这不是一篇只能阅读的说明。接下来会用高亮和箭头带你实际创建一个群聊，再认识发送、红包、删除和群管理。</p>
                <div class="cpgl-tour-checklist">
                    <span class="${characterCount ? 'is-ready' : 'is-missing'}"><b>${characterCount ? '✓' : '!'}</b> 已读取 ${characterCount} 张角色卡</span>
                    <span class="${personaCount ? 'is-ready' : ''}"><b>${personaCount ? '✓' : 'i'}</b> 已读取 ${personaCount || 0} 个 User 人设${personaCount ? '' : '，将使用 ST 当前用户名显示并关闭跨聊记忆'}</span>
                    <span><b>i</b> 真正发送消息前，请先确认 ST 普通私聊可以生成</span>
                </div>`,
            callout: characterCount
                ? '引导只会创建群聊，不会替你发送消息或调用模型。'
                : '目前没有角色卡，仍可先浏览界面；到选择成员时会告诉你如何继续。',
            nextLabel: '开始新手任务',
        },
        {
            id: 'entry',
            kicker: '第 1 步',
            title: '打开独立群聊中心',
            description: '<p>这里是 ChatPulse 群聊入口。群聊数据独立保存在浏览器里，不会创建或修改 SillyTavern 原生群聊。</p>',
            callout: '请点击箭头指向的群聊入口。',
            target: () => findFirstVisibleElement(['#cpgl_top_launcher', '#cpgl_launcher', '#cpgl_open_center_settings']),
            waitFor: 'center-opened',
        },
        {
            id: 'create',
            kicker: '第 2 步',
            title: '发起一个新群聊',
            description: '<p>桌面端可以使用左侧群聊列表旁的“＋”，手机端则使用群聊列表标题栏中的“＋”。空白页中央也有同样的入口。</p>',
            callout: '点击高亮的“发起群聊”按钮。',
            target: () => findFirstVisibleElement(['#cpgl_empty_create_group', '#cpgl_show_create', '#cpgl_mobile_create_group']),
            waitFor: 'create-modal-opened',
        },
        {
            id: 'name',
            kicker: '第 3 步',
            title: '先给这个群起一个名字',
            description: '<p>名字只用于区分你的多个群聊。这里要求你填一个名字来完成练习；日常使用时留空也会自动命名。</p>',
            callout: '输入任意群名后，“下一步”会亮起。',
            target: '#cpgl_new_group_name',
            nextLabel: '名字填好了',
        },
        {
            id: 'persona',
            kicker: '第 4 步',
            title: '选择你在这个群中的身份',
            description: '<p>每个群都能绑定不同的 SillyTavern User 人设。你的消息头像、名字、红包身份和注入给角色的用户设定都会使用它。</p>',
            callout: personaCount
                ? '可以保留默认项，也可以换成更适合这个群的人设。'
                : '没有可用人设时会使用 ST 当前用户名显示；为避免串身份，跨聊记忆会保持关闭。',
            target: '#cpgl_new_user_persona',
            nextLabel: '确认这个身份',
        },
        {
            id: 'members',
            kicker: '第 5 步',
            title: '选择至少一位群成员',
            description: '<p>勾选要加入群聊的角色卡。以后仍可以在群管理中拉人或踢人，成员变化还会触发群友的自然反应。</p>',
            callout: characterCount
                ? '至少勾选一位角色，选好后继续。'
                : '这里没有角色卡。请先在 SillyTavern 导入或创建角色，再从帮助中心重新开始引导。',
            target: () => findFirstVisibleElement(['#cpgl_create_members .cpgl-member-option', '#cpgl_create_members']),
            nextLabel: characterCount ? '成员选好了' : '查看解决办法',
        },
        {
            id: 'confirm',
            kicker: '第 6 步',
            title: '正式创建群聊',
            description: '<p>点击后才会写入浏览器 localStorage。创建成功后，这个群会自动成为当前群。</p>',
            callout: '只有创建成功，引导才会进入聊天功能介绍。',
            target: '#cpgl_create_group',
            waitFor: 'group-created',
        },
        {
            id: 'composer',
            kicker: '聊天基础',
            title: '从这里发送第一条消息',
            description: '<p><b>不写 @</b>：成员随机排序、依次接话。<br><b>@角色</b>：被点名角色优先，其他成员随后继续。<br><b>@全体</b>：向所有成员发言。</p>',
            callout: '引导不会强迫你现在发送，避免在 API 尚未配置好时产生请求。',
            target: '#cpgl_entry_text',
            nextLabel: '认识快捷功能',
        },
        {
            id: 'quick-tools',
            kicker: '聊天工具',
            title: '表情和更多功能都在输入框旁',
            description: '<p>“☺”会把表情插入输入框；圆形“＋”会打开更多功能（当前可发红包）。队列空闲时，红包会触发群成员反应；若正在生成，则顺延到下一次消息。</p>',
            callout: '红包和领取记录只保存在当前群。',
            target: '#cpgl_quick_redpacket',
            nextLabel: '继续',
        },
        {
            id: 'delete-messages',
            kicker: '整理记录',
            title: '按条选择并删除消息',
            description: '<p>点击垃圾桶会进入选择模式，然后直接点聊天区中的消息。只有再次确认后才会删除，关联红包也会一起处理。</p>',
            callout: '删除整个群聊在群管理最底部的“危险操作”中。',
            target: '#cpgl_header_delete_messages',
            nextLabel: '继续',
        },
        {
            id: 'manage',
            kicker: '高级功能',
            title: '打开群管理',
            description: '<p>成员、人设、世界书、长期记忆、API 节奏、运行队列和调试记录都集中在这里。</p>',
            callout: '点击右上角“···”，打开当前群的管理抽屉。',
            target: '#cpgl_manage_toggle',
            waitFor: 'manage-opened',
        },
        {
            id: 'manager-overview',
            kicker: '记忆与隐私',
            title: '长期记忆默认开启',
            description: '<p>最新 R 条消息保留原文，窗口外累计到 S 条时先总结。默认允许角色私聊读取本群记忆；本群读取角色私聊或其他群记忆则默认关闭。</p>',
            callout: '带“当前群”的设置只影响这里；带“所有群共用”的模型与生成设置会影响全部 ChatPulse 群。',
            target: '#cpgl_memory_section',
            nextLabel: '认识主动消息',
        },
        {
            id: 'member-automation',
            kicker: '角色主动发言',
            title: '每个角色、每个群都有自己的计时器',
            description: '<p>点开成员后，可以为这个角色在<b>当前群</b>单独设置最短/最长间隔、主动发言要求和嫉妒概率。同一个角色放进另一个群时，会使用那个群自己的计时。</p>',
            callout: '嫉妒只会并入这一条主动消息；主动消息不会触发 @、红包或其他角色接龙。可用“立即测试一条”在不开启计时的情况下试发。',
            target: () => document.querySelector('#cpgl_current_members .cpgl-member-automation-panel'),
            nextLabel: '认识角色 API',
        },
        {
            id: 'member-api',
            kicker: '角色独立模型',
            title: '群聊里的每个角色都可以单独选 API',
            description: '<p>默认“跟随 SillyTavern 当前 API”。切换到“此角色使用专用 API”后，可填写 Endpoint、Model 和 Key。该配置按<b>角色</b>在本扩展所有群共用。</p>',
            callout: 'Key 保存到 SillyTavern Secrets，不写进群聊 localStorage；这里的角色对话 API与长期记忆“小模型总结 API”彼此独立。',
            target: () => document.querySelector('#cpgl_current_members .cpgl-role-api-panel'),
            nextLabel: '最后一步',
        },
        {
            id: 'help',
            kicker: '完成',
            title: isCompactViewport() ? '随时从“聊天信息 → 使用帮助”重新查看' : '随时从“?”重新查看',
            description: isCompactViewport()
                ? '<p>帮助页包含按钮图鉴、回复规则、记忆权限和排错顺序，也能重新启动这套交互式引导。点击高亮的“使用帮助”会完成教程并立即打开帮助；点击下方“完成新手引导”只结束教程。</p>'
                : '<p>帮助页包含按钮图鉴、回复规则、记忆权限和排错顺序，也能重新启动这套交互式引导。点击高亮的“?”会完成教程并立即打开帮助；点击下方“完成新手引导”只结束教程。</p>',
            callout: '两种操作都不会删除刚创建的群。完成后就可以自由聊天。',
            target: () => findFirstVisibleElement(['#cpgl_help_button', '#cpgl_mobile_open_help']),
            nextLabel: '完成新手引导',
        },
    ];
    return isCompactViewport() ? steps.filter(step => step.id !== 'delete-messages') : steps;
}

function findFirstVisibleElement(selectors) {
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && isElementVisible(element)) return element;
    }
    return null;
}

function isElementVisible(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    const rect = element.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
}

function getOnboardingStepIndex(stepId = state.onboarding.stepId) {
    return Math.max(0, getOnboardingSteps().findIndex(step => step.id === stepId));
}

function getCurrentOnboardingStep() {
    const steps = getOnboardingSteps();
    return steps.find(step => step.id === state.onboarding.stepId) || steps[0];
}

function getOnboardingTarget(step = getCurrentOnboardingStep()) {
    if (!step?.target) return null;
    const target = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
    return target && isElementVisible(target) ? target : null;
}

function updateCreateDialogState() {
    const selectedCount = state.createMemberAvatars.size;
    const hasCharacters = characters.length > 0;
    $('#cpgl_create_selected_count').text(`已选择 ${selectedCount} 位`);
    $('#cpgl_create_group').prop('disabled', selectedCount === 0);
    $('#cpgl_create_validation')
        .toggleClass('is-ready', selectedCount > 0)
        .text(
            selectedCount > 0
                ? `已选择 ${selectedCount} 位角色，可以创建。`
                : hasCharacters
                    ? '至少选择一位角色才能创建。'
                    : '没有可用角色卡，请先在 SillyTavern 导入或创建角色。',
        );
    updateOnboardingControls();
}

function openCreateModal({ restoreDraft = state.onboarding.active, notify = true } = {}) {
    if (restoreDraft) restoreOnboardingDraft();
    renderManagerModal();
    $('#cpgl_create_modal').css('display', 'flex');
    updateCreateDialogState();
    if (!state.onboarding.active) $('#cpgl_new_group_name').trigger('focus');
    if (notify) {
        requestAnimationFrame(() => notifyOnboardingEvent('create-modal-opened'));
    }
}

function openHelpModal() {
    state.helpPreviousFocus = document.activeElement;
    $('#cpgl_help_modal').css('display', 'flex');
    $('#cpgl_help_close').trigger('focus');
}

function closeHelpModal({ restoreFocus = true } = {}) {
    $('#cpgl_help_modal').hide();
    const previousFocus = state.helpPreviousFocus;
    state.helpPreviousFocus = null;
    if (restoreFocus && previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
    }
}

function deleteCurrentGroup() {
    const group = getCurrentGroup();
    if (!group) {
        toastr.warning('请先进入一个群聊。');
        return false;
    }
    if (state.automationActive || hasPersistedAutomationClaim(group.id) || state.orchestrator.active || state.orchestrator.queue?.active || state.typing.length || is_group_generating) {
        toastr.warning('当前群仍在生成。请先停止队列，等待当前请求结束后再删除群聊。', 'ChatPulse Group Logic');
        return false;
    }
    const confirmed = window.confirm(`确定删除群聊「${group.name || group.id}」吗？其中的消息、红包和摘要都会一起删除；当前页面会话中的该群调试记录也会清除。`);
    if (!confirmed) return false;
    clearGroupAutomationTimers(group.id);
    const previousGroups = state.localGroups;
    const previousActiveGroupId = state.activeGroupId;
    state.localGroups = state.localGroups.filter(item => String(item.id) !== String(group.id));
    state.activeGroupId = state.localGroups[0]?.id || null;
    try {
        saveLocalState();
    } catch (error) {
        state.localGroups = previousGroups;
        state.activeGroupId = previousActiveGroupId;
        toastr.error(`删除失败，浏览器无法保存数据：${error?.message || error}`, 'ChatPulse Group Logic');
        return false;
    }
    state.debugLogsByGroup.delete(String(group.id || ''));
    clearRuntimeState();
    state.deleteMode = false;
    state.selectedMessageIds.clear();
    const onboardingRecord = readOnboardingRecord();
    if (
        ['active', 'paused'].includes(onboardingRecord.status)
        && String(onboardingRecord.createdGroupId || '') === String(group.id)
    ) {
        writeOnboardingRecord({
            status: state.onboarding.active ? 'active' : 'paused',
            stepId: 'create',
            createdGroupId: '',
            draft: { name: '', personaAvatar: '', memberAvatars: [] },
        });
        state.onboarding.createdGroupId = '';
        if (state.onboarding.active) state.onboarding.stepId = 'create';
    }
    $('#cpgl_manage_drawer').removeClass('is-open');
    $('#cpgl_manage_toggle').attr('aria-expanded', 'false');
    $('#cpgl_manage_scrim').hide();
    renderManagerModal();
    refreshStatus();
    if (state.onboarding.active) renderOnboardingStep();
    toastr.success(`已删除群聊「${group.name || group.id}」。`, 'ChatPulse Group Logic');
    return true;
}

function startOnboarding({ force = false, resume = false } = {}) {
    ensureOnboardingRoot();
    let record = readOnboardingRecord();
    if (force) {
        record = writeOnboardingRecord(createDefaultOnboardingRecord());
        closeHelpModal({ restoreFocus: false });
        $('#cpgl_create_modal').hide();
        $('#cpgl_new_group_name, #cpgl_create_search').val('');
        state.createMemberAvatars.clear();
        state.createUserPersonaAvatar = getDefaultUserPersonaAvatar();
        $('#cpgl_manage_drawer').removeClass('is-open');
        $('#cpgl_manage_toggle').attr('aria-expanded', 'false');
        $('#cpgl_manage_scrim').hide();
        $('#cpgl_manager_modal').hide();
    }
    let stepId = resume && ['active', 'paused'].includes(record.status) ? record.stepId : 'welcome';
    let createdGroupId = record.createdGroupId || '';
    const postCreationSteps = new Set(['composer', 'quick-tools', 'delete-messages', 'manage', 'manager-overview', 'member-automation', 'member-api', 'help']);
    if (postCreationSteps.has(stepId)) {
        const createdGroup = createdGroupId ? getGroupById(createdGroupId) : null;
        if (createdGroup) {
            state.activeGroupId = createdGroup.id;
            try {
                saveLocalState();
            } catch (error) {
                console.warn('[ChatPulseGroupLogic] Failed to restore the onboarding group:', error);
            }
        } else {
            stepId = 'create';
            createdGroupId = '';
            record = writeOnboardingRecord({
                status: 'active',
                stepId,
                createdGroupId,
            });
        }
    }
    state.onboarding.active = true;
    state.onboarding.stepId = stepId;
    state.onboarding.createdGroupId = createdGroupId;
    state.onboarding.previousFocus = document.activeElement;
    writeOnboardingRecord({
        status: 'active',
        stepId,
        createdGroupId: state.onboarding.createdGroupId,
    });

    const creationSteps = new Set(['create', 'name', 'persona', 'members', 'confirm']);
    const inCenterSteps = new Set(['create', 'name', 'persona', 'members', 'confirm', 'composer', 'quick-tools', 'delete-messages', 'manage', 'manager-overview', 'member-automation', 'member-api', 'help']);
    if (inCenterSteps.has(stepId) && !$('#cpgl_manager_modal').is(':visible')) {
        openGroupCenter();
    }
    if (creationSteps.has(stepId) && stepId !== 'create' && !$('#cpgl_create_modal').is(':visible')) {
        openCreateModal({ restoreDraft: true, notify: false });
    }
    if (['manager-overview', 'member-automation', 'member-api'].includes(stepId)) {
        $('#cpgl_manage_drawer').addClass('is-open');
        $('#cpgl_manage_toggle').attr('aria-expanded', 'true');
        syncManageScrim();
    }
    renderOnboardingStep();
}

function isHostFirstRunOnboardingVisible() {
    return [...document.querySelectorAll('.popup .onboarding')].some(element => {
        const popup = element.closest('.popup') || element;
        return isElementVisible(popup);
    });
}

function maybeStartFirstRunOnboarding() {
    if (state.onboarding.active || state.onboarding.autoPrompted) return;
    if (isHostFirstRunOnboardingVisible()) {
        if (state.onboarding.hostReadyTimer) clearTimeout(state.onboarding.hostReadyTimer);
        state.onboarding.hostReadyTimer = window.setTimeout(maybeStartFirstRunOnboarding, 500);
        return;
    }
    if (state.onboarding.hostReadyTimer) clearTimeout(state.onboarding.hostReadyTimer);
    state.onboarding.hostReadyTimer = 0;
    const record = readOnboardingRecord();
    if (['completed', 'skipped', 'existing-user'].includes(record.status)) return;
    if (['active', 'paused'].includes(record.status)) {
        state.onboarding.autoPrompted = true;
        startOnboarding({ resume: true });
        return;
    }
    if (state.localGroups.length > 0) {
        writeOnboardingRecord({ status: 'existing-user', stepId: 'welcome' });
        return;
    }
    state.onboarding.autoPrompted = true;
    startOnboarding();
}

function pauseOnboarding() {
    if (!state.onboarding.active) return;
    saveOnboardingDraft();
    writeOnboardingRecord({
        status: 'paused',
        stepId: state.onboarding.stepId,
        createdGroupId: state.onboarding.createdGroupId,
    });
    $('#cpgl_create_modal').hide();
    $('#cpgl_manage_drawer').removeClass('is-open');
    $('#cpgl_manage_toggle').attr('aria-expanded', 'false');
    $('#cpgl_manage_scrim').hide();
    hideOnboarding();
}

function skipOnboarding() {
    if (!state.onboarding.active) return;
    writeOnboardingRecord({
        status: 'skipped',
        stepId: state.onboarding.stepId,
        createdGroupId: state.onboarding.createdGroupId,
    });
    hideOnboarding();
    toastr.info('已跳过新手引导，可随时从帮助中心重新开始。', 'ChatPulse Group Logic');
}

function completeOnboarding() {
    writeOnboardingRecord({
        status: 'completed',
        stepId: 'help',
        createdGroupId: state.onboarding.createdGroupId,
        draft: { name: '', personaAvatar: '', memberAvatars: [] },
    });
    hideOnboarding();
    toastr.success('新手任务完成。现在可以开始群聊了！', 'ChatPulse Group Logic');
}

function hideOnboarding() {
    state.onboarding.active = false;
    if (state.onboarding.positionFrame) cancelAnimationFrame(state.onboarding.positionFrame);
    state.onboarding.positionFrame = 0;
    document.querySelectorAll('.cpgl-tour-target').forEach(element => element.classList.remove('cpgl-tour-target'));
    document.querySelectorAll('[data-cpgl-tour-described="true"]').forEach(element => {
        element.removeAttribute('data-cpgl-tour-described');
        if (element.getAttribute('aria-describedby') === 'cpgl_tour_description') element.removeAttribute('aria-describedby');
    });
    $('#cpgl_tour_card').css('max-height', '');
    $('#cpgl_tour_root').hide().attr('aria-hidden', 'true');
    const previousFocus = state.onboarding.previousFocus;
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
    }
}

function advanceOnboarding() {
    if (!state.onboarding.active) return;
    const steps = getOnboardingSteps();
    const currentIndex = getOnboardingStepIndex();
    const current = steps[currentIndex];
    if (current.id === 'help') {
        completeOnboarding();
        return;
    }
    if (current.id === 'entry' && !getOnboardingTarget(current)) {
        openGroupCenter();
        return;
    }
    if (current.id === 'name' && !normalizeText($('#cpgl_new_group_name').val())) return;
    if (current.id === 'members') {
        if (!characters.length) {
            skipOnboarding();
            openHelpModal();
            return;
        }
        if (!state.createMemberAvatars.size) return;
    }
    if (current.id === 'member-api' && !isCompactViewport()) {
        $('#cpgl_manage_drawer').removeClass('is-open');
        $('#cpgl_manage_toggle').attr('aria-expanded', 'false');
        $('#cpgl_manage_scrim').hide();
    }
    let next = steps[Math.min(currentIndex + 1, steps.length - 1)];
    if (next.id === 'entry' && $('#cpgl_manager_modal').is(':visible')) {
        next = steps.find(step => step.id === 'create') || next;
    }
    state.onboarding.stepId = next.id;
    saveOnboardingDraft();
    writeOnboardingRecord({
        status: 'active',
        stepId: next.id,
        createdGroupId: state.onboarding.createdGroupId,
    });
    renderOnboardingStep();
}

function notifyOnboardingEvent(eventName, payload = {}) {
    if (!state.onboarding.active) {
        const record = readOnboardingRecord();
        if (eventName === 'center-opened' && record.status === 'paused') {
            startOnboarding({ resume: true });
            if (getCurrentOnboardingStep().waitFor === eventName) advanceOnboarding();
        }
        return;
    }
    const current = getCurrentOnboardingStep();
    if (eventName === 'group-created' && payload.group) {
        state.onboarding.createdGroupId = String(payload.group.id || '');
        writeOnboardingRecord({
            status: 'active',
            stepId: 'composer',
            createdGroupId: state.onboarding.createdGroupId,
            draft: { name: '', personaAvatar: '', memberAvatars: [] },
        });
        state.onboarding.stepId = 'composer';
        renderOnboardingStep();
        return;
    }
    if (current.waitFor === eventName) advanceOnboarding();
}

function renderOnboardingStep() {
    if (!state.onboarding.active) return;
    ensureOnboardingRoot();
    const steps = getOnboardingSteps();
    const index = getOnboardingStepIndex();
    const step = steps[index];
    const root = $('#cpgl_tour_root');
    root.show().attr('aria-hidden', 'false').attr('data-step', step.id);
    $('#cpgl_tour_progress').text(`新手任务 ${index + 1} / ${steps.length}`);
    $('#cpgl_tour_progress_bar').css('width', `${((index + 1) / steps.length) * 100}%`);
    $('#cpgl_tour_kicker').text(step.kicker || '');
    $('#cpgl_tour_title').text(step.title || '');
    $('#cpgl_tour_description').html(step.description || '');
    $('#cpgl_tour_callout').html(step.callout || '').toggle(!!step.callout);
    $('#cpgl_tour_next').text(step.nextLabel || '下一步');
    updateOnboardingControls();

    if (['member-automation', 'member-api'].includes(step.id)) {
        $('#cpgl_manage_drawer').addClass('is-open');
        $('#cpgl_manage_toggle').attr('aria-expanded', 'true');
        const firstMemberCard = document.querySelector('#cpgl_current_members .cpgl-member-settings-card');
        if (firstMemberCard) firstMemberCard.open = true;
        syncManageScrim();
    }
    const target = getOnboardingTarget(step);
    document.querySelectorAll('.cpgl-tour-target').forEach(element => element.classList.remove('cpgl-tour-target'));
    document.querySelectorAll('[data-cpgl-tour-described="true"]').forEach(element => {
        element.removeAttribute('data-cpgl-tour-described');
        if (element.getAttribute('aria-describedby') === 'cpgl_tour_description') element.removeAttribute('aria-describedby');
    });
    if (target) {
        target.classList.add('cpgl-tour-target');
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
            target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        }
    }
    scheduleOnboardingPosition();
    requestAnimationFrame(() => {
        const shouldFocusTarget = !!step.waitFor || ['name', 'persona', 'members', 'composer'].includes(step.id);
        const focusTarget = shouldFocusTarget
            ? (target?.matches?.('button, input, select, textarea, [tabindex]') ? target : target?.querySelector?.('button, input, select, textarea, [tabindex]'))
            : null;
        if (focusTarget) {
            focusTarget.setAttribute('aria-describedby', 'cpgl_tour_description');
            focusTarget.setAttribute('data-cpgl-tour-described', 'true');
            focusTarget.focus?.({ preventScroll: true });
        } else {
            $('#cpgl_tour_card').trigger('focus');
        }
    });
}

function updateOnboardingControls() {
    if (!state.onboarding.active) return;
    const step = getCurrentOnboardingStep();
    const target = getOnboardingTarget(step);
    const targetLabel = limitText(normalizeText(
        target?.getAttribute?.('aria-label')
        || target?.getAttribute?.('title')
        || target?.textContent
        || step.title
        || '当前控件',
    ), 32);
    let enabled = true;
    if (step.id === 'name') enabled = !!normalizeText($('#cpgl_new_group_name').val());
    if (step.id === 'members') enabled = characters.length === 0 || state.createMemberAvatars.size > 0;
    const waitsForAction = !!step.waitFor;
    const canOpenCenterFallback = step.id === 'entry' && !target;
    $('#cpgl_tour_next')
        .toggle(!waitsForAction || canOpenCenterFallback)
        .text(canOpenCenterFallback ? '直接打开群聊中心' : (step.nextLabel || '下一步'))
        .prop('disabled', !enabled);
    $('#cpgl_tour_instruction')
        .toggle(waitsForAction && !canOpenCenterFallback)
        .text(waitsForAction ? `请操作“${targetLabel}”（点击，或聚焦后按 Enter / Space）` : '');
    $('#cpgl_tour_retry').toggle(waitsForAction && !target && !canOpenCenterFallback);
    scheduleOnboardingPosition();
}

function scheduleOnboardingPosition() {
    if (!state.onboarding.active) return;
    if (state.onboarding.positionFrame) cancelAnimationFrame(state.onboarding.positionFrame);
    state.onboarding.positionFrame = requestAnimationFrame(() => {
        state.onboarding.positionFrame = 0;
        positionOnboarding();
    });
}

function positionOnboarding() {
    if (!state.onboarding.active) return;
    const root = document.getElementById('cpgl_tour_root');
    const card = document.getElementById('cpgl_tour_card');
    const spotlight = document.getElementById('cpgl_tour_spotlight');
    const arrow = document.getElementById('cpgl_tour_arrow');
    const path = document.getElementById('cpgl_tour_arrow_path');
    if (!root || !card || !spotlight || !arrow || !path) return;

    const viewport = window.visualViewport;
    const viewportRect = {
        left: Number(viewport?.offsetLeft) || 0,
        top: Number(viewport?.offsetTop) || 0,
        width: Number(viewport?.width) || window.innerWidth || document.documentElement.clientWidth || 1,
        height: Number(viewport?.height) || window.innerHeight || document.documentElement.clientHeight || 1,
    };
    const viewportRight = viewportRect.left + viewportRect.width;
    const viewportBottom = viewportRect.top + viewportRect.height;
    const target = getOnboardingTarget();
    const isCompact = viewportRect.width <= 620;
    root.classList.toggle('is-centered', !target);
    root.classList.toggle('is-compact', isCompact);
    card.style.width = isCompact ? `${Math.max(1, viewportRect.width - 24)}px` : '';
    document.querySelectorAll('.cpgl-tour-target').forEach(element => {
        if (element !== target) element.classList.remove('cpgl-tour-target');
    });
    target?.classList.add('cpgl-tour-target');

    if (!target) {
        spotlight.style.display = 'none';
        arrow.style.display = 'none';
        card.style.visibility = 'visible';
        card.style.maxHeight = `${Math.max(180, viewportRect.height - 24)}px`;
        card.style.left = `${viewportRect.left + viewportRect.width / 2}px`;
        card.style.top = `${viewportRect.top + viewportRect.height / 2}px`;
        card.style.transform = 'translate(-50%, -50%)';
        return;
    }

    const rect = target.getBoundingClientRect();
    const padding = 7;
    const highlight = {
        left: Math.max(viewportRect.left + 4, rect.left - padding),
        top: Math.max(viewportRect.top + 4, rect.top - padding),
        right: Math.min(viewportRight - 4, rect.right + padding),
        bottom: Math.min(viewportBottom - 4, rect.bottom + padding),
    };
    spotlight.style.display = 'block';
    spotlight.style.left = `${highlight.left}px`;
    spotlight.style.top = `${highlight.top}px`;
    spotlight.style.width = `${Math.max(1, highlight.right - highlight.left)}px`;
    spotlight.style.height = `${Math.max(1, highlight.bottom - highlight.top)}px`;
    spotlight.style.borderRadius = `${Math.min(18, Math.max(10, parseFloat(getComputedStyle(target).borderRadius) || 12))}px`;

    card.style.transform = 'none';
    card.style.visibility = 'hidden';
    card.style.left = `${viewportRect.left + 12}px`;
    card.style.top = `${viewportRect.top + 12}px`;
    const gap = 24;
    const margin = 12;
    const roomAbove = highlight.top - viewportRect.top;
    const roomBelow = viewportBottom - highlight.bottom;
    card.style.maxHeight = isCompact
        ? `${Math.max(180, Math.min(viewportRect.height - margin * 2, Math.max(roomAbove, roomBelow) - gap - margin))}px`
        : `${Math.max(180, viewportRect.height - margin * 2)}px`;
    const cardRect = card.getBoundingClientRect();
    let left;
    let top;
    if (isCompact) {
        left = viewportRect.left + margin;
        top = roomAbove >= cardRect.height + gap || roomAbove > roomBelow
            ? viewportRect.top + margin
            : viewportBottom - cardRect.height - margin;
    } else {
        const room = {
            bottom: viewportBottom - highlight.bottom,
            top: highlight.top - viewportRect.top,
            right: viewportRight - highlight.right,
            left: highlight.left - viewportRect.left,
        };
        if (room.bottom >= cardRect.height + gap) {
            left = rect.left + rect.width / 2 - cardRect.width / 2;
            top = highlight.bottom + gap;
        } else if (room.top >= cardRect.height + gap) {
            left = rect.left + rect.width / 2 - cardRect.width / 2;
            top = highlight.top - cardRect.height - gap;
        } else if (room.right >= cardRect.width + gap) {
            left = highlight.right + gap;
            top = rect.top + rect.height / 2 - cardRect.height / 2;
        } else {
            left = highlight.left - cardRect.width - gap;
            top = rect.top + rect.height / 2 - cardRect.height / 2;
        }
        left = Math.max(viewportRect.left + margin, Math.min(left, viewportRight - cardRect.width - margin));
        top = Math.max(viewportRect.top + margin, Math.min(top, viewportBottom - cardRect.height - margin));
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.visibility = 'visible';

    arrow.style.display = 'block';
    arrow.setAttribute('viewBox', `${viewportRect.left} ${viewportRect.top} ${viewportRect.width} ${viewportRect.height}`);
    arrow.setAttribute('width', `${viewportRect.width}`);
    arrow.setAttribute('height', `${viewportRect.height}`);
    arrow.style.left = `${viewportRect.left}px`;
    arrow.style.top = `${viewportRect.top}px`;
    const targetCenter = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    };
    const cardCenter = {
        x: left + cardRect.width / 2,
        y: top + cardRect.height / 2,
    };
    const start = {
        x: Math.max(left, Math.min(targetCenter.x, left + cardRect.width)),
        y: Math.max(top, Math.min(targetCenter.y, top + cardRect.height)),
    };
    const control = {
        x: (start.x + targetCenter.x) / 2 + (Math.abs(start.y - targetCenter.y) > Math.abs(start.x - targetCenter.x) ? 28 : 0),
        y: (start.y + targetCenter.y) / 2 + (Math.abs(start.x - targetCenter.x) >= Math.abs(start.y - targetCenter.y) ? -24 : 0),
    };
    path.setAttribute('d', `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${targetCenter.x} ${targetCenter.y}`);
}

function describeElementForDebug(element) {
    if (!element) return 'unknown';
    const id = element.id ? `#${element.id}` : '';
    const classes = String(element.className || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .map(name => `.${name}`)
        .join('');
    const text = normalizeText(element.textContent || element.title || element.getAttribute?.('aria-label') || '').slice(0, 32);
    return `${element.tagName?.toLowerCase?.() || 'node'}${id}${classes}${text ? ` "${text}"` : ''}`;
}

const OPEN_ENTRY_SELECTOR = '#cpgl_open_center_settings, #cpgl_top_launcher, #cpgl_launcher';

function getEventClientPoint(event) {
    const touch = event?.changedTouches?.[0] || event?.touches?.[0];
    const x = Number(touch?.clientX ?? event?.clientX);
    const y = Number(touch?.clientY ?? event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

function isPointInsideElement(element, point, padding = 0) {
    if (!element || !point) return false;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return point.x >= rect.left - padding
        && point.x <= rect.right + padding
        && point.y >= rect.top - padding
        && point.y <= rect.bottom + padding;
}

function getOpenEntrypointFromEvent(event) {
    const directTarget = event?.target?.closest?.(OPEN_ENTRY_SELECTOR);
    if (directTarget) {
        return {
            element: directTarget,
            via: 'target',
            point: getEventClientPoint(event),
            actualTarget: event.target,
        };
    }

    const point = getEventClientPoint(event);
    const launcher = document.getElementById('cpgl_launcher');
    const launcherVisible = launcher && getComputedStyle(launcher).display !== 'none';
    const hitPadding = isTouchViewport() ? 18 : 4;
    if (launcherVisible && isPointInsideElement(launcher, point, hitPadding)) {
        return {
            element: launcher,
            via: 'launcher-hitbox',
            point,
            actualTarget: event?.target,
            topElement: document.elementFromPoint?.(point.x, point.y),
        };
    }

    return null;
}

function getDebugViewportSnapshot() {
    const modal = document.getElementById('cpgl_manager_modal');
    const shell = modal?.querySelector?.('.cpgl-app-shell');
    const modalRect = modal?.getBoundingClientRect?.();
    const shellRect = shell?.getBoundingClientRect?.();
    return {
        version: MODULE_VERSION,
        touch: isTouchViewport(),
        location: String(location.href || ''),
        visualViewport: window.visualViewport ? {
            width: Math.round(window.visualViewport.width || 0),
            height: Math.round(window.visualViewport.height || 0),
            offsetLeft: Math.round(window.visualViewport.offsetLeft || 0),
            offsetTop: Math.round(window.visualViewport.offsetTop || 0),
            scale: Number(window.visualViewport.scale || 1),
        } : null,
        layoutViewport: {
            width: Math.round(window.innerWidth || 0),
            height: Math.round(window.innerHeight || 0),
        },
        modal: modal ? {
            className: String(modal.className || ''),
            display: getComputedStyle(modal).display,
            dataset: modal.dataset.cpglViewport || '',
            rect: modalRect ? {
                x: Math.round(modalRect.x),
                y: Math.round(modalRect.y),
                width: Math.round(modalRect.width),
                height: Math.round(modalRect.height),
            } : null,
        } : null,
        shell: shell ? {
            rect: shellRect ? {
                x: Math.round(shellRect.x),
                y: Math.round(shellRect.y),
                width: Math.round(shellRect.width),
                height: Math.round(shellRect.height),
            } : null,
        } : null,
        activeGroupId: state.activeGroupId || '',
    };
}

function recordCpglDebug(eventName, details = {}) {
    state.debugTapCounter += 1;
    const payload = {
        index: state.debugTapCounter,
        event: eventName,
        at: new Date().toISOString(),
        details,
        viewport: getDebugViewportSnapshot(),
    };
    const message = `#${payload.index} ${eventName} ${details.element || ''}`.trim();
    console.log('[ChatPulseGroupLogic DEBUG]', payload);
    $('#cpgl_status').text(`DEBUG ${message}`);
    try {
        fetch(DEBUG_ENDPOINT, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
        }).catch(error => {
            console.warn('[ChatPulseGroupLogic DEBUG] Server endpoint unavailable:', error);
        });
    } catch (error) {
        console.warn('[ChatPulseGroupLogic DEBUG] Failed to send debug log:', error);
    }
}

function bindDebugClickProbe() {
    if (document.body?.dataset.cpglDebugProbeBound === '1') return;
    if (document.body) document.body.dataset.cpglDebugProbeBound = '1';
    const selector = [
        '#cpgl_launcher',
        '#cpgl_top_launcher',
        '#cpgl_open_center_settings',
        '#cpgl_manager_modal button',
        '#cpgl_manager_modal input',
        '#cpgl_manager_modal select',
        '#cpgl_manager_modal textarea',
    ].join(', ');
    const handler = event => {
        const entrypoint = getOpenEntrypointFromEvent(event);
        const target = event.target?.closest?.(selector) || entrypoint?.element;
        if (!target) return;
        const sensitiveInput = target.matches?.('input[type="password"], .cpgl-role-api-key');
        recordCpglDebug(`ui.${event.type}`, {
            element: describeElementForDebug(target),
            via: entrypoint?.via || 'target',
            actualTarget: describeElementForDebug(entrypoint?.actualTarget || event.target),
            topElement: describeElementForDebug(entrypoint?.topElement),
            point: entrypoint?.point ? `${Math.round(entrypoint.point.x)},${Math.round(entrypoint.point.y)}` : '',
            id: target.id || '',
            value: sensitiveInput
                ? '[REDACTED]'
                : target.matches?.('input, textarea, select')
                    ? String(target.value || '').slice(0, 80)
                    : '',
        });
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('touchstart', handler, { capture: true, passive: true });
    document.addEventListener('touchend', handler, { capture: true, passive: true });
    document.addEventListener('click', handler, true);
}

function bindDebugErrorProbe() {
    if (state.debugErrorProbeBound) return;
    state.debugErrorProbeBound = true;
    window.addEventListener('error', event => {
        recordCpglDebug('window.error', {
            error: event?.message || 'Unknown error',
            source: event?.filename || '',
            line: event?.lineno || '',
            column: event?.colno || '',
        });
    });
    window.addEventListener('unhandledrejection', event => {
        const reason = event?.reason;
        recordCpglDebug('window.unhandledrejection', {
            error: reason?.message || String(reason || 'Unknown promise rejection'),
            stack: String(reason?.stack || '').slice(0, 500),
        });
    });
}

bindDebugErrorProbe();

function getMemberSettingsContext(target) {
    const card = target?.closest?.('.cpgl-member-settings-card');
    const group = getCurrentGroup();
    const avatar = String(card?.dataset?.avatar || '');
    if (!card || !group || !avatar || !(group.members || []).includes(avatar)) {
        return { card: null, group: null, avatar: '' };
    }
    return { card, group, avatar };
}

function readRoleApiDraft(card) {
    return {
        mode: String(card.querySelector('.cpgl-role-api-mode')?.value || 'st_default'),
        endpoint: String(card.querySelector('.cpgl-role-api-endpoint')?.value || '').trim(),
        model: String(card.querySelector('.cpgl-role-api-model')?.value || '').trim(),
        temperature: Number(card.querySelector('.cpgl-role-api-temperature')?.value),
        maxTokens: Number(card.querySelector('.cpgl-role-api-max-tokens')?.value),
    };
}

function updateMemberAutomationStatusElement(card, record) {
    const status = card?.querySelector?.('.cpgl-member-auto-status');
    if (status) status.textContent = formatMemberAutomationStatus(record);
}

function updateMemberCardSummary(card, automation, api) {
    const summary = card?.querySelector?.('summary small');
    if (!summary) return;
    summary.textContent = `主动：${automation?.enabled ? '已开启' : '未开启'} · API：${api?.mode === 'custom' ? '角色专用' : '跟随 ST'}`;
}

function bindManagerLiveEvents() {
    renderEmojiPicker();
    $(document)
        .off('.cpglManagerLive')
        .on('click.cpglManagerLive', '#cpgl_manager_close', () => {
            if (state.onboarding.active) pauseOnboarding();
            $('#cpgl_manager_modal').hide();
        })
        .on('click.cpglManagerLive', '#cpgl_group_list_toggle', event => {
            event.preventDefault();
            const modal = $('#cpgl_manager_modal');
            const isCompactModal = modal.hasClass('cpgl-touch-modal') || isCompactViewport();
            if (isCompactModal) {
                modal.toggleClass('cpgl-show-group-list');
                const expanded = modal.hasClass('cpgl-show-group-list');
                $('#cpgl_group_list_toggle').attr('aria-expanded', String(expanded));
            } else {
                modal.toggleClass('cpgl-hide-group-list');
                $('#cpgl_group_list_toggle').attr('aria-expanded', String(!modal.hasClass('cpgl-hide-group-list')));
            }
            scheduleOnboardingPosition();
        })
        .on('click.cpglManagerLive', '#cpgl_mobile_back_to_groups', event => {
            event.preventDefault();
            $('#cpgl_manager_modal').addClass('cpgl-show-group-list').removeClass('cpgl-hide-group-list');
            $('#cpgl_group_list_toggle').attr('aria-expanded', 'true');
            scheduleOnboardingPosition();
        })
        .on('input.cpglManagerLive', '#cpgl_group_search', () => {
            renderManagerModal();
        })
        .on('click.cpglManagerLive', '#cpgl_show_create, #cpgl_mobile_create_group, #cpgl_empty_create_group', () => {
            openCreateModal();
        })
        .on('click.cpglManagerLive', '#cpgl_help_button, #cpgl_empty_open_help, #cpgl_mobile_open_help', event => {
            if (event.currentTarget.id === 'cpgl_mobile_open_help') {
                $('#cpgl_manage_drawer').removeClass('is-open');
                $('#cpgl_manage_toggle').attr('aria-expanded', 'false');
                $('#cpgl_manage_scrim').hide();
            }
            if (state.onboarding.active && state.onboarding.stepId === 'help') completeOnboarding();
            openHelpModal();
        })
        .on('click.cpglManagerLive', '#cpgl_help_close', closeHelpModal)
        .on('click.cpglManagerLive', '#cpgl_help_modal', event => {
            if (event.target.id === 'cpgl_help_modal') closeHelpModal();
        })
        .on('click.cpglManagerLive', '#cpgl_help_restart_tour', () => startOnboarding({ force: true }))
        .on('click.cpglManagerLive', '#cpgl_tour_skip', skipOnboarding)
        .on('click.cpglManagerLive', '#cpgl_tour_next', advanceOnboarding)
        .on('click.cpglManagerLive', '#cpgl_tour_retry', renderOnboardingStep)
        .on('click.cpglManagerLive', '.cpgl-drawer-jump-nav button', event => {
            const target = document.querySelector(event.currentTarget.dataset.target || '');
            target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        })
        .on('click.cpglManagerLive', '#cpgl_header_delete_messages, #cpgl_mobile_delete_messages', event => {
            if (!getCurrentGroup()) {
                toastr.warning('请先进入一个群聊。');
                return;
            }
            setDeleteMode(!state.deleteMode);
            if (event.currentTarget.id === 'cpgl_mobile_delete_messages') {
                $('#cpgl_manage_drawer').removeClass('is-open');
                $('#cpgl_manage_toggle').attr('aria-expanded', 'false');
                $('#cpgl_manage_scrim').hide();
            }
        })
        .on('click.cpglManagerLive', '#cpgl_chat_messages .cpgl-message-select', event => {
            event.preventDefault();
            event.stopPropagation();
            toggleMessageSelection(event.currentTarget.dataset.messageId);
        })
        .on('click.cpglManagerLive', '#cpgl_chat_messages .cpgl-message-wrapper.delete-mode, #cpgl_chat_messages .cpgl-system-delete-row.delete-mode', event => {
            if ($(event.target).closest('button, details, summary').length) return;
            toggleMessageSelection(event.currentTarget.dataset.messageId);
        })
        .on('click.cpglManagerLive', '#cpgl_delete_mode_cancel', () => setDeleteMode(false))
        .on('click.cpglManagerLive', '#cpgl_delete_mode_all', () => {
            const group = getCurrentGroup();
            if (!group) return;
            state.selectedMessageIds = new Set((group.messages || []).map((message, index) => getLocalMessageId(message, index)));
            renderChatMessages();
            renderDeleteModeBar();
        })
        .on('click.cpglManagerLive', '#cpgl_delete_mode_delete', () => {
            const group = getCurrentGroup();
            if (!group || !state.selectedMessageIds.size) return;
            const selectedIds = new Set(state.selectedMessageIds);
            const confirmed = window.confirm(`确定删除选中的 ${selectedIds.size} 条对话记录吗？关联红包也会一起删除。`);
            if (!confirmed) return;
            const deleted = deleteSelectedMessagesFromGroup(group, selectedIds);
            clearRuntimeState();
            saveLocalState();
            state.deleteMode = false;
            state.selectedMessageIds.clear();
            renderManagerModal();
            toastr.success(`已删除 ${deleted} 条对话记录。`, 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_create_modal_close', () => {
            saveOnboardingDraft();
            $('#cpgl_create_modal').hide();
            if (state.onboarding.active && ['name', 'persona', 'members', 'confirm'].includes(state.onboarding.stepId)) {
                state.onboarding.stepId = 'create';
                writeOnboardingRecord({ status: 'active', stepId: 'create' });
                renderOnboardingStep();
            }
        })
        .on('click.cpglManagerLive', '#cpgl_create_modal', event => {
            if (event.target.id === 'cpgl_create_modal') $('#cpgl_create_modal_close').trigger('click');
        })
        .on('input.cpglManagerLive', '#cpgl_create_search', renderManagerModal)
        .on('input.cpglManagerLive', '#cpgl_new_group_name', () => {
            saveOnboardingDraft();
            updateOnboardingControls();
        })
        .on('change.cpglManagerLive', '#cpgl_new_user_persona', event => {
            state.createUserPersonaAvatar = String(event.target.value || '');
            saveOnboardingDraft();
            updateOnboardingControls();
        })
        .on('change.cpglManagerLive', '#cpgl_create_members input[type="checkbox"]', event => {
            if (event.target.checked) {
                state.createMemberAvatars.add(event.target.value);
            } else {
                state.createMemberAvatars.delete(event.target.value);
            }
            $(event.target).closest('.cpgl-member-option')
                .toggleClass('is-selected', event.target.checked)
                .find('i')
                .text(event.target.checked ? '✓' : '');
            saveOnboardingDraft();
            updateCreateDialogState();
        })
        .on('click.cpglManagerLive', '#cpgl_manage_toggle', () => {
            const drawer = $('#cpgl_manage_drawer');
            drawer.toggleClass('is-open');
            const expanded = drawer.hasClass('is-open');
            $('#cpgl_manage_toggle').attr('aria-expanded', String(expanded));
            syncManageScrim();
            if (expanded) {
                notifyOnboardingEvent('manage-opened');
                if (!state.onboarding.active) requestAnimationFrame(() => $('#cpgl_manage_close').trigger('focus'));
            }
            scheduleOnboardingPosition();
        })
        .on('click.cpglManagerLive', '#cpgl_manage_close, #cpgl_manage_scrim', () => {
            $('#cpgl_manage_drawer').removeClass('is-open');
            $('#cpgl_manage_toggle').attr('aria-expanded', 'false');
            $('#cpgl_manage_scrim').hide();
            scheduleOnboardingPosition();
        })
        .on('click.cpglManagerLive', '#cpgl_emoji_toggle', () => {
            hideMentionMenu();
            $('#cpgl_emoji_picker').toggle();
        })
        .on('click.cpglManagerLive', '#cpgl_emoji_picker .cpgl-emoji-item', event => {
            addEmojiToComposer(event.currentTarget.dataset.emoji || event.currentTarget.textContent || '');
        })
        .on('click.cpglManagerLive', '#cpgl_emoji_close', hideEmojiPicker)
        .on('click.cpglManagerLive', '#cpgl_quick_redpacket', () => {
            const group = getCurrentGroup();
            if (!group) {
                toastr.warning('请先进入一个群聊。');
                return;
            }
            $('#cpgl_user_packet_count').val(Math.max(1, (group.members || []).length));
            updatePacketPreview();
            $('#cpgl_redpacket_modal').css('display', 'flex');
            $('#cpgl_user_packet_amount').trigger('focus');
        })
        .on('click.cpglManagerLive', '#cpgl_redpacket_close', () => $('#cpgl_redpacket_modal').hide())
        .on('click.cpglManagerLive', '#cpgl_redpacket_modal', event => {
            if (event.target.id === 'cpgl_redpacket_modal') $('#cpgl_redpacket_modal').hide();
        })
        .on('click.cpglManagerLive', '#cpgl_packet_lucky', () => {
            $('#cpgl_packet_lucky').addClass('active');
            $('#cpgl_packet_fixed').removeClass('active');
            updatePacketPreview();
        })
        .on('click.cpglManagerLive', '#cpgl_packet_fixed', () => {
            $('#cpgl_packet_fixed').addClass('active');
            $('#cpgl_packet_lucky').removeClass('active');
            updatePacketPreview();
        })
        .on('input.cpglManagerLive', '#cpgl_user_packet_amount, #cpgl_user_packet_count', updatePacketPreview)
        .on('click.cpglManagerLive', '#cpgl_rename_group', async () => {
            try {
                const group = getCurrentGroup();
                if (!group) return;
                const name = normalizeText($('#cpgl_group_name_input').val());
                if (!name) {
                    toastr.warning('群名不能为空。');
                    return;
                }
                group.name = name;
                await saveStGroup(group);
                renderManagerModal();
                refreshStatus();
            } catch (error) {
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            }
        })
        .on('keydown.cpglManagerLive', '#cpgl_group_name_input', event => {
            if (event.key === 'Enter') $('#cpgl_rename_group').trigger('click');
        })
        .on('change.cpglManagerLive', '#cpgl_group_user_persona_select', event => {
            const group = getCurrentGroup();
            if (!group) return;
            group.userPersonaAvatar = resolveUserPersonaAvatar(event.target.value);
            saveLocalState();
            renderManagerModal();
            refreshStatus();
        })
        .on('change.cpglManagerLive', '#cpgl_drawer_no_chain', event => {
            const group = getCurrentGroup();
            if (!group) return;
            group.noChain = event.target.checked;
            saveLocalState();
            refreshStatus();
        })
        .on('input.cpglManagerLive', '#cpgl_drawer_inject_limit', event => {
            const group = getCurrentGroup();
            if (!group) return;
            group.injectLimit = Math.max(0, Math.min(30, Number(event.target.value) || 0));
            $('#cpgl_drawer_inject_value').text(group.injectLimit);
            saveLocalState();
        })
        .on('input.cpglManagerLive', '#cpgl_drawer_context_limit', event => {
            const group = getCurrentGroup();
            if (!group) return;
            const value = Math.max(4, Math.min(80, Number(event.target.value) || DEFAULT_SETTINGS.contextLimit));
            group.contextLimit = value;
            $('#cpgl_drawer_context_value').text(value);
            saveLocalState();
            refreshStatus();
        })
        .on('change.cpglManagerLive', '#cpgl_memory_enabled', event => {
            const group = getCurrentGroup();
            if (!group) return;
            normalizeGroupMemory(group).enabled = event.target.checked;
            saveLocalState();
            renderMemoryPanel();
        })
        .on('input.cpglManagerLive', '#cpgl_memory_r', event => {
            const group = getCurrentGroup();
            if (!group) return;
            const memory = normalizeGroupMemory(group);
            memory.rawWindowR = clampInteger(event.target.value, 4, 120, DEFAULT_SETTINGS.memoryRawWindowR);
            $('#cpgl_memory_r_value').text(memory.rawWindowR);
            saveLocalState();
            renderMemoryPanel();
        })
        .on('input.cpglManagerLive', '#cpgl_memory_s', event => {
            const group = getCurrentGroup();
            if (!group) return;
            const memory = normalizeGroupMemory(group);
            memory.thresholdS = clampInteger(event.target.value, 4, 80, DEFAULT_SETTINGS.memoryThresholdS);
            $('#cpgl_memory_s_value').text(memory.thresholdS);
            saveLocalState();
            renderMemoryPanel();
        })
        .on('change.cpglManagerLive', '#cpgl_summary_provider', event => {
            getSettings().summaryProvider = event.target.value === 'custom' ? 'custom' : 'current';
            saveSettings();
            renderMemoryPanel();
        })
        .on('input.cpglManagerLive', '#cpgl_summary_custom_url', event => {
            getSettings().summaryCustomUrl = String(event.target.value || '').trim();
            state.summaryModelOptions = [];
            state.summaryModelOptionsKey = '';
            state.summaryModelOptionsError = '';
            saveSettings();
            renderSummaryModelStatus();
            renderSummaryModelMenu();
        })
        .on('input.cpglManagerLive', '#cpgl_summary_custom_model', event => {
            state.summaryModelFilterActive = true;
            getSettings().summaryCustomModel = String(event.target.value || '').trim();
            saveSettings();
            renderSummaryModelMenu();
        })
        .on('click.cpglManagerLive', '#cpgl_summary_custom_model', async () => {
            if (getSettings().summaryProvider !== 'custom') return;
            await openSummaryModelMenu(false);
        })
        .on('keydown.cpglManagerLive', '#cpgl_summary_custom_model', async event => {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                await openSummaryModelMenu(false);
            }
            if (event.key === 'Escape') closeSummaryModelMenu();
        })
        .on('click.cpglManagerLive', '#cpgl_summary_model_toggle', async event => {
            event.preventDefault();
            await openSummaryModelMenu(true);
        })
        .on('mousedown.cpglManagerLive', '#cpgl_summary_model_menu .cpgl-summary-model-option', event => {
            event.preventDefault();
            const model = event.currentTarget.dataset.model || '';
            getSettings().summaryCustomModel = model;
            $('#cpgl_summary_custom_model').val(model);
            saveSettings();
            closeSummaryModelMenu();
        })
        .on('input.cpglManagerLive', '#cpgl_summary_temperature', event => {
            const value = Number(event.target.value);
            getSettings().summaryTemperature = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : DEFAULT_SETTINGS.summaryTemperature;
            saveSettings();
        })
        .on('change.cpglManagerLive', '#cpgl_expose_group_memory_private', event => {
            const group = getCurrentGroup();
            if (!group) return;
            normalizeGroupMemory(group);
            group.memoryPermissions.exposeGroupMemoryToPrivate = event.target.checked;
            saveLocalState();
            renderMemoryPanel();
        })
        .on('change.cpglManagerLive', '#cpgl_allow_private_memory_group', event => {
            const group = getCurrentGroup();
            if (!group) return;
            normalizeGroupMemory(group);
            group.memoryPermissions.allowPrivateMemoryInGroup = event.target.checked;
            if (event.target.checked && Number(group.injectLimit) <= 0) {
                group.injectLimit = DEFAULT_CROSS_CHAT_RAW_LIMIT;
                toastr.info(`已自动把跨聊原文条数设为 ${DEFAULT_CROSS_CHAT_RAW_LIMIT}。`, 'ChatPulse Group Logic');
            }
            saveLocalState();
            renderManagerModal();
            renderMemoryPanel();
        })
        .on('change.cpglManagerLive', '#cpgl_allow_other_group_memory', event => {
            const group = getCurrentGroup();
            if (!group) return;
            normalizeGroupMemory(group);
            group.memoryPermissions.allowOtherGroupMemoryInGroup = event.target.checked;
            if (event.target.checked && Number(group.injectLimit) <= 0) {
                group.injectLimit = DEFAULT_CROSS_CHAT_RAW_LIMIT;
                toastr.info(`已自动把跨聊原文条数设为 ${DEFAULT_CROSS_CHAT_RAW_LIMIT}。`, 'ChatPulse Group Logic');
            }
            saveLocalState();
            renderManagerModal();
            renderMemoryPanel();
        })
        .on('input.cpglManagerLive', '#cpgl_api_base_delay', event => {
            getSettings().apiDelayBaseMs = Math.max(0, Number(event.target.value) || 0);
            $('#cpgl_api_base_value').text(formatSeconds(getSettings().apiDelayBaseMs));
            saveSettings();
        })
        .on('input.cpglManagerLive', '#cpgl_api_step_delay', event => {
            getSettings().apiDelayStepMs = Math.max(0, Number(event.target.value) || 0);
            $('#cpgl_api_step_value').text(formatSeconds(getSettings().apiDelayStepMs));
            saveSettings();
        })
        .on('input.cpglManagerLive', '#cpgl_api_max_delay', event => {
            getSettings().apiDelayMaxMs = Math.max(3000, Number(event.target.value) || DEFAULT_SETTINGS.apiDelayMaxMs);
            $('#cpgl_api_max_value').text(formatSeconds(getSettings().apiDelayMaxMs));
            saveSettings();
        })
        .on('input.cpglManagerLive', '#cpgl_response_length', event => {
            getSettings().responseLength = Math.max(500, Math.min(6000, Number(event.target.value) || DEFAULT_SETTINGS.responseLength));
            $('#cpgl_response_length_value').text(getSettings().responseLength);
            saveSettings();
        })
        .on('change.cpglManagerLive', '#cpgl_include_character_world_info', event => {
            const group = getCurrentGroup();
            if (!group) return;
            normalizeGroupWorldInfo(group);
            group.includeCharacterWorldInfo = event.target.checked;
            saveLocalState();
            renderWorldInfoPanel();
        })
        .on('change.cpglManagerLive', '#cpgl_world_info_books input[type="checkbox"]', () => {
            const group = getCurrentGroup();
            if (!group) return;
            normalizeGroupWorldInfo(group);
            group.worldInfoBooks = normalizeWorldInfoNameList($('#cpgl_world_info_books input[type="checkbox"]:checked').map((_, input) => input.value).get());
            saveLocalState();
            renderWorldInfoPanel();
        })
        .on('input.cpglManagerLive', '#cpgl_local_preset', event => {
            getSettings().localPreset = String(event.target.value || '');
            saveSettings();
        })
        .on('change.cpglManagerLive', '#cpgl_include_local_preset', event => {
            getSettings().includeLocalPreset = event.target.checked;
            saveSettings();
        })
        .on('input.cpglManagerLive', '#cpgl_local_regex', event => {
            getSettings().localRegex = String(event.target.value || '');
            saveSettings();
        })
        .on('click.cpglManagerLive', '#cpgl_import_preset_regex', () => $('#cpgl_import_file').trigger('click'))
        .on('change.cpglManagerLive', '#cpgl_import_file', async event => {
            const file = event.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            try {
                const data = JSON.parse(text);
                if (typeof data.preset === 'string') getSettings().localPreset = data.preset;
                if (typeof data.regex === 'string') getSettings().localRegex = data.regex;
                if (Array.isArray(data.regex)) getSettings().localRegex = data.regex.join('\n');
            } catch {
                getSettings().localPreset = text;
            }
            saveSettings();
            $('#cpgl_local_preset').val(getSettings().localPreset || '');
            $('#cpgl_local_regex').val(getSettings().localRegex || '');
            toastr.success('已导入弹窗专用预设/正则。', 'ChatPulse Group Logic');
            event.target.value = '';
        })
        .on('click.cpglManagerLive', '#cpgl_summarize_now', async () => {
            const group = getCurrentGroup();
            if (!group) {
                toastr.warning('请先进入一个群聊。');
                return;
            }
            beginQueue('memory', '手动长期记忆总结', [], () => '总结');
            try {
                await ensureGroupMemoryReady(group, { force: true });
                finishQueue('长期记忆总结完成');
            } catch (error) {
                finishQueue('长期记忆总结失败');
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            }
        })
        .on('click.cpglManagerLive', '#cpgl_clear_memory', () => {
            const group = getCurrentGroup();
            if (!group) {
                toastr.warning('请先进入一个群聊。');
                return;
            }
            const confirmed = window.confirm(`确定清空「${group.name || '当前群聊'}」的长期摘要吗？原始消息不会删除。`);
            if (!confirmed) return;
            const memory = normalizeGroupMemory(group);
            memory.cursor = 0;
            memory.rounds = [];
            memory.lastError = '';
            memory.updatedAt = 0;
            saveLocalState();
            renderMemoryPanel();
            toastr.success('长期摘要已清空。', 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_clear_queue_danger', () => {
            state.pendingMentionJobs = [];
            state.orchestrator.postRoundMentions = [];
            requestStopQueue();
            toastr.info('队列已清空。', 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_clear_messages_danger', () => {
            const group = getCurrentGroup();
            if (!group) {
                toastr.warning('请先进入一个群聊。');
                return;
            }
            const confirmed = window.confirm(`确定删除「${group.name || '当前群聊'}」的所有对话记录和红包记录吗？`);
            if (!confirmed) return;
            group.messages = [];
            group.redPackets = [];
            state.debugLogsByGroup.delete(String(group.id || ''));
            group.memory = getDefaultGroupMemory();
            clearRuntimeState();
            saveLocalState();
            renderManagerModal();
            toastr.success('对话记录已删除。', 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_delete_group_danger', deleteCurrentGroup)
        .on('click.cpglManagerLive', '#cpgl_clear_debug_logs', () => {
            const group = getCurrentGroup();
            if (!group) return;
            state.debugLogsByGroup.delete(String(group.id || ''));
            renderDebugLogs();
            toastr.info('调试记录已清空。', 'ChatPulse Group Logic');
        })
        .on('change.cpglManagerLive', '#cpgl_message_delete_list input[type="checkbox"]', () => {
            const count = $('#cpgl_message_delete_list input[type="checkbox"]:checked').length;
            $('#cpgl_delete_selected_messages').prop('disabled', count === 0).text(count ? `删除选中 (${count})` : '删除选中');
        })
        .on('click.cpglManagerLive', '#cpgl_select_all_messages', () => {
            $('#cpgl_message_delete_list input[type="checkbox"]').prop('checked', true).trigger('change');
        })
        .on('click.cpglManagerLive', '#cpgl_select_no_messages', () => {
            $('#cpgl_message_delete_list input[type="checkbox"]').prop('checked', false).trigger('change');
        })
        .on('click.cpglManagerLive', '#cpgl_delete_selected_messages', () => {
            const group = getCurrentGroup();
            if (!group) {
                toastr.warning('请先进入一个群聊。');
                return;
            }
            const selectedIds = new Set($('#cpgl_message_delete_list input[type="checkbox"]:checked')
                .map((_, input) => input.value)
                .get());
            if (!selectedIds.size) return;
            const confirmed = window.confirm(`确定删除选中的 ${selectedIds.size} 条对话记录吗？关联红包也会一起删除。`);
            if (!confirmed) return;
            const deleted = deleteSelectedMessagesFromGroup(group, selectedIds);
            clearRuntimeState();
            state.deleteMode = false;
            state.selectedMessageIds.clear();
            saveLocalState();
            renderManagerModal();
            toastr.success(`已删除 ${deleted} 条对话记录。`, 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_interrupt_generation', () => {
            state.typing = [];
            state.pendingMentionJobs = [];
            requestStopQueue();
            renderTypingIndicator();
            toastr.info('已请求停止弹窗内队列。', 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_queue_stop', () => {
            requestStopQueue();
            toastr.info('已请求停止当前队列。', 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_queue_skip', () => {
            requestSkipQueueCurrent();
            toastr.info('当前角色结果返回后会被跳过。', 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_manager_modal', event => {
            if (event.target.id !== 'cpgl_manager_modal') return;
            if (state.onboarding.active) pauseOnboarding();
            $('#cpgl_manager_modal').hide();
        })
        .on('click.cpglManagerLive', '#cpgl_create_group', async () => {
            try {
                const avatars = [...state.createMemberAvatars];
                const userPersonaAvatar = String($('#cpgl_new_user_persona').val() || state.createUserPersonaAvatar || '');
                const createdGroup = await createStGroup(String($('#cpgl_new_group_name').val() || ''), avatars, userPersonaAvatar);
                $('#cpgl_new_group_name').val('');
                $('#cpgl_create_search').val('');
                state.createMemberAvatars.clear();
                state.createUserPersonaAvatar = getDefaultUserPersonaAvatar();
                $('#cpgl_create_modal').hide();
                renderManagerModal();
                refreshStatus();
                toastr.success(`群聊「${createdGroup.name}」已创建。`, 'ChatPulse Group Logic');
                notifyOnboardingEvent('group-created', { group: createdGroup });
            } catch (error) {
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            }
        })
        .on('click.cpglManagerLive', '#cpgl_group_list .cpgl-open-group', async event => {
            try {
                await openGroupConversation(event.currentTarget.dataset.groupId);
            } catch (error) {
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            }
        })
        .on('change.cpglManagerLive', '#cpgl_current_members .cpgl-member-auto-enabled', event => {
            const { card, group, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!card) return;
            const current = getMemberAutomation(group, avatar);
            const enabled = !!event.currentTarget.checked;
            const patch = enabled
                ? {
                    enabled: true,
                    nextTriggerAt: current.enabled && current.nextTriggerAt
                        ? current.nextTriggerAt
                        : Date.now() + getRandomAutomationIntervalMs({ ...current, enabled: true }),
                }
                : {
                    enabled: false,
                    nextTriggerAt: 0,
                    claimOwnerId: '',
                    claimEventId: '',
                    claimUntil: 0,
                };
            const next = updateMemberAutomation(group, avatar, patch);
            saveLocalState();
            scheduleGroupMemberAutomation(group, avatar);
            updateMemberAutomationStatusElement(card, next);
            updateMemberCardSummary(card, next, getCharacterGroupApiConfig(avatar));
        })
        .on('change.cpglManagerLive', '#cpgl_current_members .cpgl-member-interval-min, #cpgl_current_members .cpgl-member-interval-max', event => {
            const { card, group, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!card) return;
            const current = getMemberAutomation(group, avatar);
            const next = updateMemberAutomation(group, avatar, {
                intervalMinMinutes: card.querySelector('.cpgl-member-interval-min')?.value,
                intervalMaxMinutes: card.querySelector('.cpgl-member-interval-max')?.value,
            });
            if (next.enabled) {
                next.nextTriggerAt = Date.now() + getRandomAutomationIntervalMs(next);
                next.claimOwnerId = '';
                next.claimEventId = '';
                next.claimUntil = 0;
            }
            card.querySelector('.cpgl-member-interval-min').value = next.intervalMinMinutes;
            card.querySelector('.cpgl-member-interval-max').value = next.intervalMaxMinutes;
            saveLocalState();
            scheduleGroupMemberAutomation(group, avatar);
            updateMemberAutomationStatusElement(card, next);
            updateMemberCardSummary(card, next, getCharacterGroupApiConfig(avatar));
        })
        .on('input.cpglManagerLive', '#cpgl_current_members .cpgl-member-auto-prompt, #cpgl_current_members .cpgl-member-jealousy-prompt', event => {
            const { group, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!group) return;
            const patch = event.currentTarget.classList.contains('cpgl-member-auto-prompt')
                ? { prompt: event.currentTarget.value }
                : { jealousyPrompt: event.currentTarget.value };
            updateMemberAutomation(group, avatar, patch);
            saveLocalState();
        })
        .on('change.cpglManagerLive', '#cpgl_current_members .cpgl-member-jealousy-enabled, #cpgl_current_members .cpgl-member-jealousy-chance', event => {
            const { group, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!group) return;
            const patch = event.currentTarget.classList.contains('cpgl-member-jealousy-enabled')
                ? { jealousyEnabled: !!event.currentTarget.checked }
                : { jealousyChance: event.currentTarget.value };
            updateMemberAutomation(group, avatar, patch);
            saveLocalState();
        })
        .on('click.cpglManagerLive', '#cpgl_current_members .cpgl-member-proactive-test', async event => {
            const { card, group, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!card) return;
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = '生成中…';
            try {
                const result = await testGroupMemberProactiveMessage(group.id, avatar);
                if (result?.dropped) {
                    toastr.warning('测试结果被安全检查丢弃，请查看“最近输入 / 输出”。', 'ChatPulse Group Logic');
                } else {
                    toastr.success('已向当前群发送一条独立主动消息；不会触发接龙。', 'ChatPulse Group Logic');
                }
            } catch (error) {
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            } finally {
                button.disabled = false;
                button.textContent = '立即测试一条';
            }
        })
        .on('change.cpglManagerLive', '#cpgl_current_members .cpgl-role-api-mode', event => {
            const { card } = getMemberSettingsContext(event.currentTarget);
            if (!card) return;
            const custom = event.currentTarget.value === 'custom';
            $(card).find('.cpgl-role-api-custom').toggle(custom);
            $(card).find('.cpgl-role-api-load-models').prop('disabled', !custom);
        })
        .on('click.cpglManagerLive', '#cpgl_current_members .cpgl-role-api-save', async event => {
            const { card, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!card) return;
            const button = event.currentTarget;
            const keyInput = card.querySelector('.cpgl-role-api-key');
            button.disabled = true;
            button.textContent = '保存中…';
            try {
                const saved = await saveCharacterGroupApiConfig(avatar, readRoleApiDraft(card), {
                    apiKey: keyInput?.value || '',
                });
                if (keyInput) {
                    keyInput.value = '';
                    keyInput.placeholder = saved.secretId ? '已安全保存；留空保留原 Key' : '输入 API Key';
                }
                $(card).find('.cpgl-role-api-status').text(saved.mode === 'custom'
                    ? '角色专用 API 已保存；已通过 SillyTavern Secrets 管理 Key。'
                    : '已改为跟随 SillyTavern 当前 API。');
                $(card).find('.cpgl-role-api-clear-key').prop('disabled', !saved.secretId);
                updateMemberCardSummary(card, getMemberAutomation(getCurrentGroup(), avatar), saved);
                toastr.success('角色群聊 API 设置已保存。', 'ChatPulse Group Logic');
            } catch (error) {
                $(card).find('.cpgl-role-api-status').text(error.message || String(error));
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            } finally {
                button.disabled = false;
                button.textContent = '保存 API';
            }
        })
        .on('click.cpglManagerLive', '#cpgl_current_members .cpgl-role-api-load-models', async event => {
            const { card, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!card) return;
            const button = event.currentTarget;
            const keyInput = card.querySelector('.cpgl-role-api-key');
            button.disabled = true;
            button.textContent = '读取中…';
            try {
                await saveCharacterGroupApiConfig(avatar, readRoleApiDraft(card), {
                    apiKey: keyInput?.value || '',
                });
                if (keyInput) keyInput.value = '';
                const models = await loadCharacterGroupApiModels(avatar);
                state.roleApiModelOptions.set(String(avatar), models);
                const datalist = card.querySelector('datalist');
                if (datalist) datalist.innerHTML = models.map(model => `<option value="${escapeHtml(model)}"></option>`).join('');
                $(card).find('.cpgl-role-api-status').text(`已读取 ${models.length} 个模型；可在 Model 输入框选择。`);
            } catch (error) {
                $(card).find('.cpgl-role-api-status').text(error.message || String(error));
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            } finally {
                button.disabled = false;
                button.textContent = '读取模型';
            }
        })
        .on('click.cpglManagerLive', '#cpgl_current_members .cpgl-role-api-test', async event => {
            const { card, group, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!card) return;
            if (state.orchestrator.active || state.automationActive || hasPersistedAutomationClaim(group.id) || is_group_generating) {
                toastr.warning('当前正在生成消息，请稍后测试 API。', 'ChatPulse Group Logic');
                return;
            }
            const character = getCharacterByAvatar(avatar);
            if (!character) {
                toastr.error('找不到这个角色卡，请先重新导入角色。', 'ChatPulse Group Logic');
                return;
            }
            const button = event.currentTarget;
            const keyInput = card.querySelector('.cpgl-role-api-key');
            button.disabled = true;
            button.textContent = '测试中…';
            try {
                const saved = await saveCharacterGroupApiConfig(avatar, readRoleApiDraft(card), {
                    apiKey: keyInput?.value || '',
                });
                if (keyInput) keyInput.value = '';
                const reply = await generateGroupRoleWithBackoff(character, {
                    messages: [
                        { role: 'system', content: '这是连接测试。只回复“连接正常”，不要输出其他内容。' },
                        { role: 'user', content: '请确认连接。' },
                    ],
                    responseLength: 80,
                    temperature: 0,
                });
                $(card).find('.cpgl-role-api-status').text(`连接成功：${compactPreview(reply, 80) || '模型已返回空内容'}`);
                updateMemberCardSummary(card, getMemberAutomation(getCurrentGroup(), avatar), saved);
                toastr.success('角色群聊 API 连接成功。', 'ChatPulse Group Logic');
            } catch (error) {
                $(card).find('.cpgl-role-api-status').text(`连接失败：${error.message || error}`);
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            } finally {
                button.disabled = false;
                button.textContent = '测试连接';
            }
        })
        .on('click.cpglManagerLive', '#cpgl_current_members .cpgl-role-api-clear-key', async event => {
            const { card, avatar } = getMemberSettingsContext(event.currentTarget);
            if (!card) return;
            if (!window.confirm('确定清除这个角色的专用群聊 API Key，并改回跟随 SillyTavern 当前 API 吗？')) return;
            try {
                const saved = await saveCharacterGroupApiConfig(avatar, { mode: 'st_default' }, { clearKey: true });
                card.querySelector('.cpgl-role-api-mode').value = 'st_default';
                $(card).find('.cpgl-role-api-custom').hide();
                $(card).find('.cpgl-role-api-load-models, .cpgl-role-api-clear-key').prop('disabled', true);
                $(card).find('.cpgl-role-api-status').text('专用 Key 已清除；现在跟随 SillyTavern 当前 API。');
                updateMemberCardSummary(card, getMemberAutomation(getCurrentGroup(), avatar), saved);
                toastr.success('专用 Key 已清除。', 'ChatPulse Group Logic');
            } catch (error) {
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            }
        })
        .on('click.cpglManagerLive', '#cpgl_current_members .cpgl-kick-member', async event => {
            try {
                const group = getCurrentGroup();
                if (!group) return;
                await removeMemberFromGroup(group.id, event.currentTarget.dataset.avatar);
            } catch (error) {
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            }
        })
        .on('click.cpglManagerLive', '#cpgl_add_member', async () => {
            try {
                const group = getCurrentGroup();
                const avatar = String($('#cpgl_add_member_select').val() || '');
                if (!group || !avatar) return;
                await addMembersToGroup(group.id, [avatar]);
            } catch (error) {
                toastr.error(error.message || String(error), 'ChatPulse Group Logic');
            }
        })
        .on('click.cpglManagerLive', '#cpgl_user_packet_send', async () => {
            const group = getCurrentGroup();
            if (!group) {
                toastr.warning('请先进入一个群聊。');
                return;
            }
            if (state.orchestrator.active || state.automationActive || is_group_generating) {
                toastr.warning('当前群聊仍在生成，请等待完成后再发红包。', 'ChatPulse Group Logic');
                return;
            }
            const isFixed = $('#cpgl_packet_fixed').hasClass('active');
            const amount = Math.max(0, Number($('#cpgl_user_packet_amount').val()) || 0);
            const count = Math.max(1, Number.parseInt($('#cpgl_user_packet_count').val(), 10) || 1);
            const packet = {
                mode: isFixed ? 'equal' : 'lucky',
                total: isFixed ? amount * count : amount,
                count,
                note: normalizeText($('#cpgl_user_packet_note').val()) || '恭喜发财',
            };
            if (packet.total <= 0) {
                toastr.warning('红包金额需要大于 0。');
                return;
            }
            const createdPacket = createUserRedPacketMessage(packet);
            $('#cpgl_user_packet_amount').val('');
            $('#cpgl_user_packet_count').val('');
            $('#cpgl_user_packet_note').val('');
            updatePacketPreview();
            $('#cpgl_redpacket_modal').hide();
            toastr.success('红包已发到群聊。', 'ChatPulse Group Logic');
            if (createdPacket) {
                const sourceGroupId = String(group.id);
                setTimeout(() => {
                    runRedPacketReactionRound(createdPacket, sourceGroupId);
                }, 500);
            }
        })
        .on('click.cpglManagerLive', '#cpgl_red_packet_list .cpgl-claim-packet', event => {
            const group = getCurrentGroup();
            const result = claimRedPacket(event.currentTarget.dataset.packetId, { avatar: getGroupUserEntityId(group), name: getGroupUserName(group) });
            if (result) toastr.success(`抢到 ${result.amount.toFixed(2)}`, 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_chat_messages .cpgl-claim-packet', event => {
            event.stopPropagation();
            const group = getCurrentGroup();
            const result = claimRedPacket(event.currentTarget.dataset.packetId, { avatar: getGroupUserEntityId(group), name: getGroupUserName(group) });
            if (result) toastr.success(`抢到 ${result.amount.toFixed(2)}`, 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_entry_send', () => {
            const text = $('#cpgl_entry_text').val();
            const group = getCurrentGroup();
            if (state.orchestrator.active || state.automationActive || hasPersistedAutomationClaim(group?.id) || is_group_generating) {
                toastr.warning('当前群聊仍在生成，请等待完成后再发送。', 'ChatPulse Group Logic');
                return;
            }
            $('#cpgl_entry_text').val('');
            syncComposerState();
            hideMentionMenu();
            hideEmojiPicker();
            runOrchestratedRound(text);
        })
        .on('input.cpglManagerLive click.cpglManagerLive keyup.cpglManagerLive', '#cpgl_entry_text', event => {
            if (event.type === 'keyup' && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
            syncComposerState(event.currentTarget);
            updateMentionMenuFromInput(event.currentTarget);
        })
        .on('keydown.cpglManagerLive', '#cpgl_entry_text', event => {
            if (state.mention.open) {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    state.mention.index = (state.mention.index + 1) % state.mention.options.length;
                    renderMentionMenu();
                    return;
                }
                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    state.mention.index = (state.mention.index - 1 + state.mention.options.length) % state.mention.options.length;
                    renderMentionMenu();
                    return;
                }
                if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
                    event.preventDefault();
                    chooseMention();
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    hideMentionMenu();
                    hideEmojiPicker();
                    return;
                }
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                $('#cpgl_entry_send').trigger('click');
            }
        })
        .on('click.cpglManagerLive', event => {
            if (!$(event.target).closest('#cpgl_summary_model_combo').length) closeSummaryModelMenu();
        })
        .on('mousedown.cpglManagerLive', '#cpgl_mention_menu .cpgl-mention-item', event => {
            event.preventDefault();
            chooseMention(Number(event.currentTarget.dataset.index) || 0);
        });
}

function getLocalMessageId(message, index) {
    return String(message?.id || index);
}

function messageSelectControl(messageId) {
    if (!state.deleteMode) return '';
    const selected = state.selectedMessageIds.has(messageId);
    return `<button class="cpgl-message-select ${selected ? 'selected' : ''}" type="button" data-message-id="${escapeHtml(messageId)}" title="${selected ? '取消选择' : '选择删除'}">${selected ? '✓' : ''}</button>`;
}

function renderChatMessages() {
    if (!$('#cpgl_chat_messages').length) return;
    const group = getCurrentGroup();
    if (!group) {
        $('#cpgl_chat_title').text('选择或创建一个群聊');
        $('#cpgl_chat_subtitle').text('每个群都能使用独立成员、User 人设与长期记忆。');
        $('#cpgl_chat_messages').html(`
            <div class="cpgl-empty-state cpgl-empty-welcome">
                <div class="cpgl-empty-orbit" aria-hidden="true">
                    <i class="fa-solid fa-comments"></i>
                </div>
                <span class="cpgl-empty-eyebrow">第一次使用 · 约 1 分钟</span>
                <h2>创建一个只属于你的群聊</h2>
                <p>选择角色卡和你的 User 人设，ChatPulse 会把消息、红包与记忆分别保存在这个群里。</p>
                <div class="cpgl-empty-steps" aria-label="创建群聊的三个步骤">
                    <div><b>1</b><span><strong>起个群名</strong><small>方便区分不同剧情</small></span></div>
                    <div><b>2</b><span><strong>选择身份</strong><small>绑定本群 User 人设</small></span></div>
                    <div><b>3</b><span><strong>邀请角色</strong><small>至少选择一位成员</small></span></div>
                </div>
                <div class="cpgl-empty-actions">
                    <button id="cpgl_empty_create_group" class="cpgl-send-button cpgl-empty-action" type="button">
                        发起群聊 <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
                    </button>
                    <button id="cpgl_empty_open_help" class="cpgl-empty-help" type="button">先看看完整使用说明</button>
                </div>
            </div>`);
        return;
    }

    const memberCount = (group.members || []).length;
    $('#cpgl_chat_title').text(`${group.name || group.id}${memberCount ? ` (${memberCount})` : ''}`);
    $('#cpgl_chat_subtitle').text(`User: ${getGroupUserName(group)} · 无 @ 随机轮询，@角色 点名优先`);
    let lastDisplayedTimestamp = 0;
    const rows = getRecentVisibleMessages(80).map(message => {
        const messageId = getLocalMessageId(message, message._index);
        const selected = state.selectedMessageIds.has(messageId);
        const messageTimestamp = getMessageTimestamp(message);
        const showTime = messageTimestamp
            && (!lastDisplayedTimestamp || Math.abs(messageTimestamp - lastDisplayedTimestamp) >= 5 * 60 * 1000);
        if (showTime) lastDisplayedTimestamp = messageTimestamp;
        const timeMarker = showTime
            ? `<time class="cpgl-message-time" datetime="${escapeHtml(new Date(messageTimestamp).toISOString())}">${escapeHtml(formatMessageTime(messageTimestamp))}</time>`
            : '';
        if (message.is_system) {
            const systemText = stripTags(message.mes).replace(/^\[System\]\s*/i, '').trim();
            return systemText ? `${timeMarker}
                <div class="cpgl-system-delete-row ${state.deleteMode ? 'delete-mode' : ''} ${selected ? 'selected' : ''}" data-message-id="${escapeHtml(messageId)}">
                    ${messageSelectControl(messageId)}
                    <div class="cpgl-system-message">${escapeHtml(systemText)}</div>
                </div>` : '';
        }
        const isUser = !!message.is_user;
        const speaker = isUser ? getUserMessageName(message, group) : getMessageSpeaker(message) || 'Unknown';
        const character = isUser ? null : characters.find(item => item.name === speaker);
        const avatarUrl = isUser ? getUserAvatarUrl(group, message) : getCharacterAvatarUrl(character);
        const packetId = parseRedPacketMessage(message.mes);
        const packet = packetId ? getRedPacket(packetId) : null;
        const content = isUser ? stripTags(message.mes) : sanitizeLocalReply(message.mes, speaker);
        if (!content && !packet) return '';
        const bubble = packet ? renderRedPacketCard(packet, isUser) : `<div class="cpgl-message-bubble">${escapeHtml(content)}</div>`;
        return `
            ${timeMarker}
            <div class="cpgl-message-wrapper ${isUser ? 'user' : 'character'} ${state.deleteMode ? 'delete-mode' : ''} ${selected ? 'selected' : ''}" data-message-id="${escapeHtml(messageId)}">
                ${messageSelectControl(messageId)}
                <div class="cpgl-message-avatar"><img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(speaker)}"></div>
                <div class="cpgl-message-content">
                    ${isUser ? '' : `<div class="cpgl-message-name">${escapeHtml(speaker)}</div>`}
                    ${bubble}
                </div>
            </div>`;
    }).join('');

    $('#cpgl_chat_messages').html(rows || `
        <div class="cpgl-empty-state">
            <div class="cpgl-empty-icon"><i class="fa-solid fa-comments" aria-hidden="true"></i></div>
            <p>${escapeHtml(group.name || '这个群聊')} 还没有消息</p>
            <span>在下方输入第一条消息。</span>
        </div>`);
    const container = $('#cpgl_chat_messages')[0];
    if (container && !state.deleteMode) container.scrollTop = container.scrollHeight;
}

function renderRedPacketCard(packet, isUser = false) {
    const claims = Array.isArray(packet.claims) ? packet.claims : [];
    const claimed = packet.count - packet.remaining;
    const userClaimed = claims.some(claim => isUserClaimId(claim.claimerId));
    const isExpired = packet.remaining <= 0;
    const claimRows = claims.map(claim => `
        <div class="cpgl-redpacket-claim-row">
            <span>${escapeHtml(claim.claimerName || 'Unknown')}</span>
            <strong>¥${Number(claim.amount || 0).toFixed(2)}</strong>
        </div>
    `).join('');
    const canClaim = !isExpired && !userClaimed && !isUser && !isUserClaimId(packet.senderAvatar);
    return `
        <div class="cpgl-redpacket-message-card" data-packet-id="${escapeHtml(packet.id)}">
            <div class="cpgl-redpacket-message-main">
                <span class="cpgl-redpacket-message-icon"><i class="fa-solid fa-envelope-open-text" aria-hidden="true"></i></span>
                <div>
                    <strong>${escapeHtml(packet.note || '红包')}</strong>
                    <span>${packet.mode === 'equal' ? '普通红包' : '拼手气红包'} · ${claimed}/${packet.count}</span>
                </div>
            </div>
            ${canClaim ? `<button class="cpgl-redpacket-open cpgl-claim-packet" type="button" data-packet-id="${escapeHtml(packet.id)}"><i class="fa-solid fa-envelope-open" aria-hidden="true"></i> 拆红包</button>` : ''}
            ${isExpired || userClaimed || isUser ? `<div class="cpgl-redpacket-status">${userClaimed ? '✅ 已领取' : isExpired ? '已抢完' : '等待群友领取'}</div>` : ''}
            <details class="cpgl-redpacket-detail">
                <summary>领取记录 · ¥${Number(packet.total || 0).toFixed(2)} 总计</summary>
                <div>${claimRows || '<span class="cpgl-hint">暂无人领取</span>'}</div>
            </details>
        </div>
    `;
}

function renderMessageDeleteList() {
    if (!$('#cpgl_message_delete_list').length) return;
    const group = getCurrentGroup();
    const messages = Array.isArray(group?.messages) ? group.messages : [];
    if (!group || messages.length === 0) {
        $('#cpgl_message_delete_list').html('<div class="cpgl-hint">当前群没有可删除的对话记录。</div>');
        $('#cpgl_delete_selected_messages').prop('disabled', true).text('删除选中');
        return;
    }
    const rows = messages.slice().reverse().map((message, reverseIndex) => {
        const index = messages.length - 1 - reverseIndex;
        const speaker = message.is_system
            ? 'System'
            : message.is_user
                ? getUserMessageName(message, group)
                : getMessageSpeaker(message) || 'Unknown';
        const preview = limitText(getMessagePreview(message, group), 120) || '空消息';
        const type = parseRedPacketMessage(message.mes) ? '红包' : message.is_system ? '系统' : message.is_user ? '用户' : '角色';
        return `
            <label class="cpgl-delete-message-row">
                <input type="checkbox" value="${escapeHtml(message.id || String(index))}" data-index="${index}">
                <div>
                    <strong>${escapeHtml(speaker)} <span>${escapeHtml(type)} · ${escapeHtml(formatMessageTime(message.timestamp))}</span></strong>
                    <p>${escapeHtml(preview)}</p>
                </div>
            </label>`;
    }).join('');
    $('#cpgl_message_delete_list').html(rows);
    $('#cpgl_delete_selected_messages').prop('disabled', true).text('删除选中');
}

function renderMemoryPanel() {
    if (!$('#cpgl_memory_status').length) return;
    const group = getCurrentGroup();
    if (!group) {
        $('#cpgl_memory_status').text('当前没有打开群聊。');
        $('#cpgl_memory_summaries').html('');
        return;
    }
    const memory = normalizeGroupMemory(group);
    const status = getGroupMemoryStatus(group);
    $('#cpgl_memory_enabled').prop('checked', !!memory.enabled);
    $('#cpgl_memory_r').val(memory.rawWindowR);
    $('#cpgl_memory_r_value').text(memory.rawWindowR);
    $('#cpgl_memory_s').val(memory.thresholdS);
    $('#cpgl_memory_s_value').text(memory.thresholdS);
    const settings = getSettings();
    const summaryProvider = settings.summaryProvider === 'custom' ? 'custom' : 'current';
    $('#cpgl_summary_provider').val(summaryProvider);
    $('#cpgl_summary_custom_fields').toggle(summaryProvider === 'custom');
    $('#cpgl_summary_custom_url').val(settings.summaryCustomUrl || '');
    $('#cpgl_summary_custom_model').val(settings.summaryCustomModel || '');
    $('#cpgl_summary_temperature').val(Number.isFinite(Number(settings.summaryTemperature)) ? Number(settings.summaryTemperature) : DEFAULT_SETTINGS.summaryTemperature);
    if (summaryProvider !== 'custom') closeSummaryModelMenu();
    renderSummaryModelStatus();
    renderSummaryModelMenu();
    $('#cpgl_expose_group_memory_private').prop('checked', !!group.memoryPermissions.exposeGroupMemoryToPrivate);
    $('#cpgl_allow_private_memory_group').prop('checked', !!group.memoryPermissions.allowPrivateMemoryInGroup);
    $('#cpgl_allow_other_group_memory').prop('checked', !!group.memoryPermissions.allowOtherGroupMemoryInGroup);
    $('#cpgl_memory_status').text([
        memory.enabled ? '已启用' : '已关闭',
        getGroupUserPersonaAvatar(group)
            ? `User persona：${getGroupUserName(group)}（跨聊严格隔离）`
            : `User：${getGroupUserName(group)}（无明确 persona，跨聊关闭）`,
        `跨聊原文 ${Math.max(0, Number(group.injectLimit) || 0)} 条`,
        `已总结到第 ${status.cursor} 条`,
        `当前 ${status.total} 条`,
        `窗口外未摘要 ${status.pending}/${status.threshold} 条`,
        `摘要 ${status.rounds} 轮`,
        memory.lastError ? `上次错误：${memory.lastError}` : '',
    ].filter(Boolean).join(' | '));

    const rounds = getGroupSummaryRounds(group, Math.max(6, memory.maxSummaryRounds));
    const html = rounds.slice().reverse().map(round => `
        <details class="cpgl-memory-item">
            <summary>消息 ${Number(round.from) + 1}-${Number(round.to)} · ${escapeHtml(formatMessageTime(round.createdAt))}</summary>
            <pre>${escapeHtml(round.text)}</pre>
        </details>
    `).join('');
    $('#cpgl_memory_summaries').html(html || '<div class="cpgl-hint">还没有长期摘要。</div>');
}

function renderQueuePanel() {
    const queue = state.orchestrator.queue;
    if (!$('#cpgl_queue_panel').length && !$('#cpgl_queue_drawer').length) return;
    const items = Array.isArray(queue?.items) ? queue.items : [];
    const doneCount = items.filter(item => ['done', 'skipped', 'failed'].includes(item.status)).length;
    const active = !!queue?.active || items.length > 0;
    const statusLabel = queue?.active
        ? `${doneCount}/${items.length || 0}`
        : items.length ? '已结束' : '空闲';
    const rows = items.map(item => {
        const mark = item.status === 'done' ? '✓'
            : item.status === 'running' ? '▶'
                : item.status === 'failed' ? '!'
                    : item.status === 'skipped' ? '↷'
                        : '·';
        return `
            <div class="cpgl-queue-row ${escapeHtml(item.status || 'pending')}">
                <span>${mark}</span>
                <div>
                    <strong>${escapeHtml(item.name || 'Unknown')}</strong>
                    <small>${escapeHtml(item.reason || item.message || '')}</small>
                </div>
            </div>`;
    }).join('');
    const controls = queue?.active ? `
        <div class="cpgl-queue-actions">
            <button id="cpgl_queue_skip" type="button">跳过</button>
            <button id="cpgl_queue_stop" type="button" class="danger">停止</button>
        </div>` : '';
    const body = `
        <div class="cpgl-queue-head">
            <div>
                <strong>${escapeHtml(queue?.label || '运行队列')}</strong>
                <span>${escapeHtml(statusLabel)} · ${escapeHtml(queue?.message || '空闲')}</span>
            </div>
            ${controls}
        </div>
        <div class="cpgl-queue-list">${rows || '<div class="cpgl-hint">当前没有运行中的队列。</div>'}</div>
    `;
    $('#cpgl_queue_drawer').html(body);
    if (queue?.active) {
        $('#cpgl_queue_panel').html(body).css('display', 'block');
    } else {
        $('#cpgl_queue_panel').hide().empty();
    }
}

function renderTypingIndicator() {
    if (!$('#cpgl_typing_indicator').length) return;
    if (!state.typing.length) {
        $('#cpgl_typing_indicator').hide().empty();
        return;
    }
    const names = state.typing.map(item => item.name).join('、');
    $('#cpgl_typing_indicator')
        .html(`<span><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></span><div>${escapeHtml(names)} 正在输入…</div><button id="cpgl_interrupt_generation" type="button">停止</button>`)
        .css('display', 'flex');
}

function openGroupCenter() {
    recordCpglDebug('openGroupCenter.start');
    if (!$('#cpgl_manager_modal').length) {
        renderManagerShell();
    }
    renderEmojiPicker();
    loadLocalState();
    renderManagerModal();
    syncVisibleViewportModal();
    const compactViewport = isCompactViewport();
    $('#cpgl_manager_modal')
        .removeClass('cpgl-show-group-list cpgl-hide-group-list')
        .toggleClass('cpgl-show-group-list', compactViewport)
        .css('display', 'flex');
    $('#cpgl_group_list_toggle').attr('aria-expanded', 'true');
    recordCpglDebug('openGroupCenter.done');
    requestAnimationFrame(() => {
        notifyOnboardingEvent('center-opened');
        scheduleOnboardingPosition();
    });
}

async function openGroupConversation(groupId) {
    await openManagedGroup(groupId);
    $('#cpgl_manager_modal').removeClass('cpgl-show-group-list');
    $('#cpgl_group_list_toggle').attr(
        'aria-expanded',
        String(!isCompactViewport() && !$('#cpgl_manager_modal').hasClass('cpgl-hide-group-list')),
    );
    renderManagerModal();
}

function safeOpenGroupCenter(event, source = null) {
    const directEventTypes = new Set(['touchstart', 'touchend', 'pointerdown', 'pointerup']);
    if (directEventTypes.has(event?.type)) {
        const now = Date.now();
        const lastDirect = Number(safeOpenGroupCenter.lastDirectAt || 0);
        safeOpenGroupCenter.lastDirectAt = now;
        if (now - lastDirect < 350) return;
    } else if (event?.type === 'click') {
        const lastDirectOpen = Number(safeOpenGroupCenter.lastDirectAt || 0);
        if (Date.now() - lastDirectOpen < 350) return;
    }

    event?.preventDefault?.();
    event?.stopPropagation?.();
    try {
        recordCpglDebug('safeOpenGroupCenter.invoke', {
            eventType: event?.type || '',
            element: describeElementForDebug(source?.element || event?.target?.closest?.(OPEN_ENTRY_SELECTOR) || event?.target),
            via: source?.via || 'target',
            actualTarget: describeElementForDebug(source?.actualTarget || event?.target),
            topElement: describeElementForDebug(source?.topElement),
            point: source?.point ? `${Math.round(source.point.x)},${Math.round(source.point.y)}` : '',
        });
        openGroupCenter();
    } catch (error) {
        console.error('[ChatPulseGroupLogic] Failed to open group center:', error);
        recordCpglDebug('safeOpenGroupCenter.error', { error: error?.message || String(error) });
        toastr.error(error?.message || String(error), 'ChatPulse Group Logic');
    }
}

function bindNativeOpenEntrypoints() {
    if (document.body?.dataset.cpglNativeOpenBound === '1') return;
    if (document.body) document.body.dataset.cpglNativeOpenBound = '1';
    const handler = event => {
        const entrypoint = getOpenEntrypointFromEvent(event);
        if (!entrypoint) return;
        if (entrypoint.element.id === 'cpgl_launcher' && entrypoint.element.dataset.cpglSuppressClick === '1') return;
        if (entrypoint.via === 'launcher-hitbox' && $('#cpgl_manager_modal').is(':visible')) return;
        if ((event.type === 'pointerdown' || event.type === 'touchstart') && !isTouchViewport()) return;
        safeOpenGroupCenter(event, entrypoint);
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('touchstart', handler, { capture: true, passive: false });
    document.addEventListener('touchend', handler, { capture: true, passive: false });
    document.addEventListener('click', handler, true);
}

function shouldUseVisibleViewportModal() {
    return !!window.visualViewport && isCompactViewport();
}

function isTouchViewport() {
    const coarsePointer = typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;
    const touchPoints = Number(navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0) > 0;
    const touchEvent = 'ontouchstart' in window;
    return coarsePointer || touchPoints || touchEvent;
}

function isCompactViewport() {
    const width = Number(window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 0);
    return width <= 620 || !!window.matchMedia?.('(max-width: 620px)')?.matches;
}

function syncManageScrim() {
    const width = Number(window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 0);
    $('#cpgl_manage_scrim').toggle($('#cpgl_manage_drawer').hasClass('is-open') && width <= 1100);
}

function clearVisibleViewportModal() {
    const modal = document.getElementById('cpgl_manager_modal');
    if (!modal) return;
    modal.classList.remove('cpgl-visual-viewport');
    modal.classList.remove('cpgl-touch-modal');
    delete modal.dataset.cpglViewport;
    modal.style.left = '';
    modal.style.top = '';
    modal.style.width = '';
    modal.style.height = '';
    modal.style.right = '';
    modal.style.bottom = '';
    modal.style.inset = '';
    modal.style.removeProperty('--cpgl-touch-shell-width');
    modal.style.removeProperty('--cpgl-touch-shell-height');
}

function syncVisibleViewportModal() {
    const modal = document.getElementById('cpgl_manager_modal');
    if (!modal) return;
    if (!shouldUseVisibleViewportModal()) {
        clearVisibleViewportModal();
        $('#cpgl_group_list_toggle').attr('aria-expanded', String(!$('#cpgl_manager_modal').hasClass('cpgl-hide-group-list')));
        syncManageScrim();
        return;
    }
    const viewport = window.visualViewport;
    const width = Number(viewport.width || window.innerWidth || document.documentElement.clientWidth || 0);
    const height = Number(viewport.height || window.innerHeight || document.documentElement.clientHeight || 0);
    const scale = Number(viewport.scale || 1);
    const compactLayout = isCompactViewport();
    const desiredShellWidth = Math.max(280, width - 16);
    const desiredShellHeight = Math.max(360, height - 16);
    modal.classList.add('cpgl-visual-viewport');
    modal.classList.toggle('cpgl-touch-modal', compactLayout);
    $('#cpgl_group_list_toggle').attr('aria-expanded', String(modal.classList.contains('cpgl-show-group-list')));
    modal.dataset.cpglViewport = [
        `touch=${isTouchViewport() ? '1' : '0'}`,
        `vv=${Math.round(viewport.width || 0)}x${Math.round(viewport.height || 0)}`,
        `offset=${Math.round(viewport.offsetLeft || 0)},${Math.round(viewport.offsetTop || 0)}`,
        `used=${Math.round(width)}x${Math.round(height)}`,
        `shell=${Math.round(desiredShellWidth)}x${Math.round(desiredShellHeight)}`,
        `scale=${scale}`,
    ].join(' ');
    modal.style.inset = 'auto';
    modal.style.left = `${viewport.offsetLeft || 0}px`;
    modal.style.top = `${viewport.offsetTop || 0}px`;
    modal.style.width = `${width}px`;
    modal.style.height = `${height}px`;
    modal.style.right = 'auto';
    modal.style.bottom = 'auto';
    modal.style.setProperty('--cpgl-touch-shell-width', `${desiredShellWidth}px`);
    modal.style.setProperty('--cpgl-touch-shell-height', `${desiredShellHeight}px`);
    syncManageScrim();
    recordCpglDebug('syncVisibleViewportModal', {
        shellWidth: Math.round(desiredShellWidth),
        shellHeight: Math.round(desiredShellHeight),
    });
    scheduleOnboardingPosition();
}

function userPersonaOptionsHtml(selectedAvatar = '') {
    const personas = getAvailableUserPersonas();
    const selected = resolveUserPersonaAvatar(selectedAvatar);
    if (!personas.length) {
        return '<option value="">ST 当前用户</option>';
    }
    return personas.map(persona => {
        const title = persona.title ? ` · ${persona.title}` : '';
        return `<option value="${escapeHtml(persona.avatar)}" ${persona.avatar === selected ? 'selected' : ''}>${escapeHtml(persona.name)}${escapeHtml(title)}</option>`;
    }).join('');
}

function renderUserPersonaSelect(selector, selectedAvatar = '') {
    const $select = $(selector);
    if (!$select.length) return resolveUserPersonaAvatar(selectedAvatar);
    const selected = resolveUserPersonaAvatar(selectedAvatar);
    $select.html(userPersonaOptionsHtml(selected));
    $select.val(selected);
    return String($select.val() || selected || '');
}

function formatMemberAutomationStatus(record) {
    const normalized = normalizeMemberAutomation(record);
    if (!normalized.enabled) return '未开启';
    if (normalized.claimUntil > Date.now()) return '正在生成主动消息';
    if (!normalized.nextTriggerAt) return '等待安排下次时间';
    return `下次约 ${new Date(normalized.nextTriggerAt).toLocaleString()}`;
}

function renderMemberSettingsHtml(group, avatar, memberIndex) {
    const character = getCharacterByAvatar(avatar);
    const automation = getMemberAutomation(group, avatar);
    const api = getCharacterGroupApiConfig(avatar);
    const modelOptions = state.roleApiModelOptions.get(String(avatar)) || [];
    const datalistId = `cpgl_role_api_models_${memberIndex}`;
    const hasSecret = !!api.secretId;
    return `
        <details class="cpgl-debug-item cpgl-member-settings-card" data-avatar="${escapeHtml(avatar)}">
            <summary>
                <span class="cpgl-member-line">
                    <img src="${escapeHtml(getCharacterAvatarUrl(character))}" alt="">
                    <span>${escapeHtml(character?.name || avatar)}</span>
                </span>
                <small>主动：${escapeHtml(automation.enabled ? '已开启' : '未开启')} · API：${escapeHtml(api.mode === 'custom' ? '角色专用' : '跟随 ST')}</small>
            </summary>
            <div class="cpgl-summary-custom cpgl-member-automation-panel">
                <strong>群聊主动消息 <span class="cpgl-scope-badge">本群 × 此角色</span></strong>
                <label><span><input class="cpgl-member-auto-enabled" type="checkbox" style="width:auto;min-width:auto;padding:0;" ${automation.enabled ? 'checked' : ''}> 开启此角色在本群主动发言</span></label>
                <div class="cpgl-two-column-fields">
                    <label><span>最短间隔（分钟）</span><input class="cpgl-member-interval-min" type="number" min="1" max="1440" value="${automation.intervalMinMinutes}"></label>
                    <label><span>最长间隔（分钟）</span><input class="cpgl-member-interval-max" type="number" min="1" max="1440" value="${automation.intervalMaxMinutes}"></label>
                </div>
                <label><span>主动发言要求（可留空）</span><textarea class="cpgl-member-auto-prompt" rows="2" placeholder="例如：晚上更喜欢关心大家今天过得怎么样">${escapeHtml(automation.prompt)}</textarea></label>
                <label><span><input class="cpgl-member-jealousy-enabled" type="checkbox" style="width:auto;min-width:auto;padding:0;" ${automation.jealousyEnabled ? 'checked' : ''}> 嫉妒联动：其他角色在自己上次发言后说过话时，有概率表现吃醋</span></label>
                <label><span>嫉妒触发概率（0–100%）</span><input class="cpgl-member-jealousy-chance" type="number" min="0" max="100" value="${automation.jealousyChance}"></label>
                <label><span>嫉妒表现要求（可留空）</span><textarea class="cpgl-member-jealousy-prompt" rows="2" placeholder="例如：克制一点，不要直接承认吃醋">${escapeHtml(automation.jealousyPrompt)}</textarea></label>
                <div class="cpgl-hint">嫉妒会并入这一条主动消息，不会另发第二条；主动消息也不会触发 @、红包或群聊接龙。</div>
                <div class="cpgl-row">
                    <span class="cpgl-member-auto-status">${escapeHtml(formatMemberAutomationStatus(automation))}</span>
                    <button class="menu_button cpgl-member-proactive-test" type="button">立即测试一条</button>
                </div>
            </div>
            <div class="cpgl-summary-custom cpgl-role-api-panel">
                <strong>角色群聊 API <span class="cpgl-scope-badge is-global">该角色在本扩展所有群共用</span></strong>
                <label><span>API 来源</span>
                    <select class="cpgl-role-api-mode">
                        <option value="st_default" ${api.mode === 'custom' ? '' : 'selected'}>跟随 SillyTavern 当前 API（默认）</option>
                        <option value="custom" ${api.mode === 'custom' ? 'selected' : ''}>此角色使用专用 API</option>
                    </select>
                </label>
                <div class="cpgl-role-api-custom" ${api.mode === 'custom' ? '' : 'style="display:none;"'}>
                    <label><span>Endpoint</span><input class="cpgl-role-api-endpoint" type="url" value="${escapeHtml(api.endpoint)}" placeholder="https://api.example.com/v1"></label>
                    <label><span>Model</span><input class="cpgl-role-api-model" type="text" list="${datalistId}" value="${escapeHtml(api.model)}" placeholder="模型名称"></label>
                    <datalist id="${datalistId}">${modelOptions.map(model => `<option value="${escapeHtml(model)}"></option>`).join('')}</datalist>
                    <label><span>API Key</span><input class="cpgl-role-api-key" type="password" autocomplete="new-password" placeholder="${hasSecret ? '已安全保存；留空保留原 Key' : '输入 API Key'}"></label>
                    <div class="cpgl-two-column-fields">
                        <label><span>Temperature</span><input class="cpgl-role-api-temperature" type="number" min="0" max="2" step="0.1" value="${api.temperature}"></label>
                        <label><span>Max tokens</span><input class="cpgl-role-api-max-tokens" type="number" min="80" max="12000" value="${api.maxTokens}"></label>
                    </div>
                </div>
                <div class="cpgl-hint">未配置时使用 ST 当前 API。专用 Key 只写入 SillyTavern Secrets，本页面不保存明文；长期记忆“小模型总结 API”与这里完全独立。</div>
                <div class="cpgl-actions">
                    <button class="menu_button cpgl-role-api-load-models" type="button" ${api.mode === 'custom' ? '' : 'disabled'}>读取模型</button>
                    <button class="menu_button cpgl-role-api-test" type="button">测试连接</button>
                    <button class="menu_button cpgl-role-api-save" type="button">保存 API</button>
                    <button class="cpgl-danger-link cpgl-role-api-clear-key" type="button" ${hasSecret ? '' : 'disabled'}>清除专用 Key</button>
                </div>
                <div class="cpgl-hint cpgl-role-api-status">${escapeHtml(hasSecret ? '已保存专用 Key。' : '尚未保存专用 Key。')}</div>
            </div>
            <div class="cpgl-row" style="padding:8px 10px;">
                <span class="cpgl-hint">移出成员不会删除这个角色在其他群共用的 API 配置。</span>
                <button class="cpgl-danger-link cpgl-kick-member" type="button" data-avatar="${escapeHtml(avatar)}">踢出本群</button>
            </div>
        </details>`;
}

function renderManagerModal() {
    if (!$('#cpgl_manager_modal').length) return;
    const groupSearch = normalizeText($('#cpgl_group_search').val()).toLowerCase();
    const createSearch = String($('#cpgl_create_search').val() || '').toLowerCase();
    const createCandidates = characters.filter(character => (character.name || character.avatar || '').toLowerCase().includes(createSearch));
    const createMemberRows = createCandidates
        .map(character => characterOptionHtml(character, state.createMemberAvatars.has(character.avatar)))
        .join('');
    const createEmptyText = characters.length
        ? '没有找到匹配的角色，试试其他关键词。'
        : '还没有角色卡。请先返回 SillyTavern 导入或创建角色。';
    $('#cpgl_create_members').html(createMemberRows || `<div class="cpgl-create-empty">${escapeHtml(createEmptyText)}</div>`);
    state.createUserPersonaAvatar = renderUserPersonaSelect(
        '#cpgl_new_user_persona',
        String($('#cpgl_new_user_persona').val() || state.createUserPersonaAvatar || getDefaultUserPersonaAvatar()),
    );

    const visibleGroups = state.localGroups.filter(group => {
        if (!groupSearch) return true;
        const memberNames = (group.members || [])
            .map(avatar => getCharacterByAvatar(avatar)?.name || avatar)
            .join(' ');
        return `${group.name || group.id} ${getGroupUserName(group)} ${memberNames}`.toLowerCase().includes(groupSearch);
    });
    const groupRows = visibleGroups.map(group => {
        const firstMember = getCharacterByAvatar((group.members || [])[0]);
        const names = (group.members || []).map(avatar => getCharacterByAvatar(avatar)?.name || avatar).join('、');
        const isActive = getCurrentGroup()?.id === group.id;
        const userName = getGroupUserName(group);
        const memberCount = (group.members || []).length;
        const latestMessage = [...(group.messages || [])].reverse().find(message => message && normalizeText(message.mes));
        const latestSpeaker = latestMessage && !latestMessage.is_system
            ? (latestMessage.is_user ? '我' : getMessageSpeaker(latestMessage))
            : '';
        const latestContent = latestMessage ? getMessagePreview(latestMessage, group) : '';
        const preview = latestContent
            ? `${latestSpeaker ? `${latestSpeaker}: ` : ''}${latestContent}`
            : `以 ${userName} 身份 · ${names || '暂无成员'}`;
        const lastMessageTime = latestMessage ? formatMessageTime(getMessageTimestamp(latestMessage)) : '';
        return `
            <button class="cpgl-chat-list-item cpgl-open-group ${isActive ? 'active' : ''}" type="button" data-group-id="${escapeHtml(group.id)}" ${isActive ? 'aria-current="true"' : ''}>
                <img src="${escapeHtml(getCharacterAvatarUrl(firstMember))}" alt="">
                <div class="cpgl-chat-list-copy">
                    <div class="cpgl-chat-list-title">
                        <strong>${escapeHtml(group.name || group.id)}</strong>
                        <time>${escapeHtml(lastMessageTime)}</time>
                    </div>
                    <div class="cpgl-chat-list-preview">
                        <span>${escapeHtml(preview)}</span>
                        <em>${memberCount}</em>
                    </div>
                </div>
            </button>`;
    }).join('');
    const emptyListText = state.localGroups.length && groupSearch ? '没有匹配的群聊。' : '还没有群聊。';
    $('#cpgl_group_list').html(groupRows || `<div class="cpgl-list-empty">${escapeHtml(emptyListText)}</div>`);
    $('#cpgl_group_count_badge').text(state.localGroups.length > 99 ? '99+' : String(state.localGroups.length));
    $('#cpgl_group_list_toggle').attr('aria-label', `打开或关闭群聊列表，共 ${state.localGroups.length} 个群聊`);

    const group = getCurrentGroup();
    if (!group) {
        $('#cpgl_current_members').html('<div class="cpgl-hint">当前没有打开群聊。</div>');
        $('#cpgl_add_member_select').html('');
        $('#cpgl_group_name_input').val('');
        $('#cpgl_group_user_persona_select').html('');
        $('#cpgl_group_user_persona_hint').text('当前没有打开群聊。');
        $('#cpgl_member_count').text('(0)');
        renderRedPacketList();
        renderChatMessages();
        renderDebugLogs();
        renderMessageDeleteList();
        renderDeleteModeBar();
        renderWorldInfoPanel();
        renderMemoryPanel();
        renderQueuePanel();
        updateCreateDialogState();
        scheduleOnboardingPosition();
        return;
    }
    $('#cpgl_group_name_input').val(group.name || '');
    const groupPersonaAvatar = renderUserPersonaSelect('#cpgl_group_user_persona_select', group.userPersonaAvatar);
    group.userPersonaAvatar = groupPersonaAvatar;
    const groupPersona = getGroupUserPersona(group);
    $('#cpgl_group_user_persona_hint').text(
        groupPersona.avatar
            ? `本群用户消息、红包和提示词会使用「${groupPersona.name}」。`
            : '没有可用 persona 时使用 ST 当前用户名显示；跨聊记忆保持关闭。',
    );
    $('#cpgl_member_count').text(`(${(group.members || []).length})`);
    $('#cpgl_drawer_no_chain').prop('checked', !!group.noChain);
    $('#cpgl_drawer_inject_limit').val(Number(group.injectLimit) || 0);
    $('#cpgl_drawer_inject_value').text(Number(group.injectLimit) || 0);
    $('#cpgl_drawer_context_limit').val(Number(group.contextLimit) || getSettings().contextLimit);
    $('#cpgl_drawer_context_value').text(Number(group.contextLimit) || getSettings().contextLimit);
    $('#cpgl_api_base_delay').val(Number(getSettings().apiDelayBaseMs) || DEFAULT_SETTINGS.apiDelayBaseMs);
    $('#cpgl_api_step_delay').val(Number(getSettings().apiDelayStepMs) || DEFAULT_SETTINGS.apiDelayStepMs);
    $('#cpgl_api_max_delay').val(Number(getSettings().apiDelayMaxMs) || DEFAULT_SETTINGS.apiDelayMaxMs);
    $('#cpgl_api_base_value').text(formatSeconds(getSettings().apiDelayBaseMs));
    $('#cpgl_api_step_value').text(formatSeconds(getSettings().apiDelayStepMs));
    $('#cpgl_api_max_value').text(formatSeconds(getSettings().apiDelayMaxMs));
    $('#cpgl_response_length').val(Number(getSettings().responseLength) || DEFAULT_SETTINGS.responseLength);
    $('#cpgl_response_length_value').text(Number(getSettings().responseLength) || DEFAULT_SETTINGS.responseLength);
    $('#cpgl_local_preset').val(getSettings().localPreset || DEFAULT_SETTINGS.localPreset);
    $('#cpgl_include_local_preset').prop('checked', !!getSettings().includeLocalPreset);
    $('#cpgl_local_regex').val(getSettings().localRegex || '');

    const memberRows = (group.members || [])
        .map((avatar, index) => renderMemberSettingsHtml(group, avatar, index))
        .join('');
    $('#cpgl_current_members').html(memberRows || '<div class="cpgl-hint">当前群没有成员。</div>');

    const existing = new Set(group.members || []);
    const options = characters
        .filter(character => !existing.has(character.avatar))
        .map(character => `<option value="${escapeHtml(character.avatar)}">${escapeHtml(character.name || character.avatar)}</option>`)
        .join('');
    $('#cpgl_add_member_select').html(options);
    renderRedPacketList();
    renderChatMessages();
    renderDebugLogs();
    renderMessageDeleteList();
    renderDeleteModeBar();
    renderWorldInfoPanel();
    renderMemoryPanel();
    renderQueuePanel();
    updateCreateDialogState();
    scheduleOnboardingPosition();
}

function updatePacketPreview() {
    const total = Math.max(0, Number($('#cpgl_user_packet_amount').val()) || 0);
    const count = Math.max(1, Number.parseInt($('#cpgl_user_packet_count').val(), 10) || 1);
    const isFixed = $('#cpgl_packet_fixed').hasClass('active');
    const totalCost = isFixed ? total * count : total;
    $('#cpgl_packet_amount_label').text(isFixed ? '每人金额（元）' : '总金额（元）');
    $('#cpgl_packet_total_preview').text(`¥${totalCost.toFixed(2)}`);
}

function formatSeconds(ms) {
    return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1).replace(/\.0$/, '')}s`;
}

function renderRedPacketList() {
    if (!$('#cpgl_red_packet_list').length) return;
    const packets = getRedPacketsForCurrentGroup().slice().reverse();
    const html = packets.map(packet => {
        const claimsList = Array.isArray(packet.claims) ? packet.claims : [];
        const claims = claimsList.map(claim => `${claim.claimerName} ${claim.amount.toFixed(2)}`).join('、') || '暂无领取';
        const canUserClaim = packet.remaining > 0
            && !isUserClaimId(packet.senderAvatar)
            && !claimsList.some(claim => isUserClaimId(claim.claimerId));
        return `
            <div class="cpgl-list-row cpgl-redpacket-row">
                <div>
                    <strong>${escapeHtml(packet.senderName)} 的红包：${packet.total.toFixed(2)} / ${packet.count} 份</strong>
                    <div class="cpgl-hint">${escapeHtml(packet.note)} | 剩余 ${packet.remaining} 份 | ${escapeHtml(claims)}</div>
                </div>
                <button class="menu_button cpgl-claim-packet" data-packet-id="${escapeHtml(packet.id)}" ${canUserClaim ? '' : 'disabled'}>抢</button>
            </div>`;
    }).join('');
    $('#cpgl_red_packet_list').html(html || '<div class="cpgl-hint">当前群没有红包。</div>');
}

function renderDebugLogs() {
    if (!$('#cpgl_debug_logs').length) return;
    const group = getCurrentGroup();
    const logs = (state.debugLogsByGroup.get(String(group?.id || '')) || []).slice().reverse();
    const html = logs.map(log => `
        <details class="cpgl-debug-item">
            <summary>${escapeHtml(log.character || 'unknown')} · ${new Date(log.at || Date.now()).toLocaleTimeString()}${log.retried ? ' · retry' : ''}${log.error ? ' · failed' : ''}</summary>
            <label>Prompt</label>
            <pre>${escapeHtml(log.prompt || '')}</pre>
            <label>Raw Output</label>
            <pre>${escapeHtml(log.raw || '')}</pre>
            <label>Sanitized</label>
            <pre>${escapeHtml(log.sanitized || '')}</pre>
            ${log.error ? `<label>Error</label><pre>${escapeHtml(log.error)}</pre>` : ''}
        </details>
    `).join('');
    $('#cpgl_debug_logs').html(html || '<div class="cpgl-hint">还没有新的输入输出记录。成功或失败的生成都会记录在本次页面会话里。</div>');
}

function renderWorldInfoPanel() {
    if (!$('#cpgl_world_info_books').length) return;
    const group = getCurrentGroup();
    if (!group) {
        $('#cpgl_include_character_world_info').prop('checked', true);
        $('#cpgl_world_info_status').text('当前没有打开群聊。');
        $('#cpgl_world_info_books').html('');
        return;
    }

    normalizeGroupWorldInfo(group);
    const availableNames = getAvailableWorldInfoNames();
    const availableSet = new Set(availableNames);
    const selectedNames = normalizeWorldInfoNameList(group.worldInfoBooks);
    const selectedSet = new Set(selectedNames);
    const activeSelectedNames = availableNames.length
        ? selectedNames.filter(name => availableSet.has(name))
        : selectedNames;
    const missingNames = availableNames.length
        ? selectedNames.filter(name => !availableSet.has(name))
        : [];

    $('#cpgl_include_character_world_info').prop('checked', group.includeCharacterWorldInfo !== false);
    const rows = availableNames.map(name => `
        <label class="cpgl-world-book-row">
            <input type="checkbox" value="${escapeHtml(name)}" ${selectedSet.has(name) ? 'checked' : ''}>
            <span>${escapeHtml(name)}</span>
        </label>
    `).join('');
    $('#cpgl_world_info_books').html(rows || '<div class="cpgl-hint">没有可用世界书；可直接群聊，不影响角色卡生效。</div>');

    const modeText = group.includeCharacterWorldInfo === false ? '只读上面选中的世界书' : '会叠加成员角色卡世界书';
    const missingText = missingNames.length
        ? `；已忽略 ${missingNames.length} 个不存在的选择：${missingNames.slice(0, 3).join('、')}${missingNames.length > 3 ? '…' : ''}`
        : '';
    $('#cpgl_world_info_status').text(`已选择 ${activeSelectedNames.length} 个群聊世界书，${modeText}${missingText}。`);
}

function deleteSelectedMessagesFromGroup(group, selectedIds) {
    if (!group || !Array.isArray(group.messages) || !selectedIds?.size) return 0;
    const oldMessages = group.messages;
    const oldIndexToNewIndex = new Map();
    const deletedPacketIds = new Set();
    const keptMessages = [];

    oldMessages.forEach((message, oldIndex) => {
        const id = message?.id || String(oldIndex);
        if (selectedIds.has(id)) {
            const packetId = parseRedPacketMessage(message?.mes);
            if (packetId) deletedPacketIds.add(packetId);
            return;
        }
        oldIndexToNewIndex.set(oldIndex, keptMessages.length);
        keptMessages.push(message);
    });

    group.messages = keptMessages;
    group.redPackets = (group.redPackets || [])
        .filter(packet => !deletedPacketIds.has(packet.id) && oldIndexToNewIndex.has(packet.sourceMessageId))
        .map(packet => ({ ...packet, sourceMessageId: oldIndexToNewIndex.get(packet.sourceMessageId) }));
    const deletedCount = oldMessages.length - keptMessages.length;
    if (deletedCount > 0) {
        // Existing summaries refer to old message indices/content and can no
        // longer be trusted after selective deletion.
        const memory = normalizeGroupMemory(group);
        memory.cursor = 0;
        memory.rounds = [];
        memory.lastError = '';
        memory.updatedAt = Date.now();
    }
    return deletedCount;
}

function renderDeleteModeBar() {
    if (!$('#cpgl_delete_mode_bar').length) return;
    $('#cpgl_header_delete_messages')
        .toggleClass('active', !!state.deleteMode)
        .attr('aria-pressed', String(!!state.deleteMode));
    if (!state.deleteMode || !getCurrentGroup()) {
        $('#cpgl_delete_mode_bar').hide().empty();
        return;
    }
    const count = state.selectedMessageIds.size;
    $('#cpgl_delete_mode_bar')
        .html(`
            <button id="cpgl_delete_mode_all" type="button">全选</button>
            <span>已选 ${count} 条，直接点聊天区消息选择</span>
            <div>
                <button id="cpgl_delete_mode_cancel" type="button">取消</button>
                <button id="cpgl_delete_mode_delete" class="danger" type="button" ${count ? '' : 'disabled'}>删除</button>
            </div>
        `)
        .css('display', 'flex');
}

function setDeleteMode(enabled) {
    state.deleteMode = !!enabled;
    if (!state.deleteMode) state.selectedMessageIds.clear();
    renderChatMessages();
    renderDeleteModeBar();
}

function toggleMessageSelection(messageId) {
    if (!messageId || !state.deleteMode) return;
    if (state.selectedMessageIds.has(messageId)) {
        state.selectedMessageIds.delete(messageId);
    } else {
        state.selectedMessageIds.add(messageId);
    }
    renderChatMessages();
    renderDeleteModeBar();
}

function bindSettingsEvents() {
    if (state.settingsEventsBound) return;
    state.settingsEventsBound = true;
    $(document)
        .off('change.cpglSettings input.cpglSettings click.cpglOpen touchend.cpglOpen')
        .on('change.cpglSettings', '#cpgl_enabled', event => {
            getSettings().enabled = event.target.checked;
            getSettings().orchestratedEntry = event.target.checked;
            saveSettings();
            reconcileGroupAutomationTimers();
            refreshStatus();
        })
        .on('input.cpglSettings', '#cpgl_context_limit', event => {
            getSettings().contextLimit = Math.max(4, Math.min(80, Number(event.target.value) || DEFAULT_SETTINGS.contextLimit));
            getMetadata().contextLimit = getSettings().contextLimit;
            saveSettings();
            saveMetadata();
            refreshStatus();
        })
        .on('click.cpglOpen touchend.cpglOpen', '#cpgl_open_center_settings, #cpgl_top_launcher, #cpgl_launcher', event => {
            if (event.currentTarget?.id === 'cpgl_launcher' && event.currentTarget.dataset.cpglSuppressClick === '1') return;
            safeOpenGroupCenter(event);
        });
    bindManagerLiveEvents();
    return;
}

function refreshStatus() {
    const meta = getMetadata();
    const group = getCurrentGroup();
    const settings = getSettings();
    const lines = [
        `版本：${MODULE_VERSION}`,
        `入口：${settings.enabled && settings.orchestratedEntry ? '显示' : '隐藏'}`,
        group ? `当前独立群：${group.name || group.id}` : '未打开独立群聊',
        `默认上下文：${Number(settings.contextLimit) || DEFAULT_SETTINGS.contextLimit} 条`,
    ];
    $('#cpgl_status').text(lines.join(' | '));
    const visible = !!settings.enabled && !!settings.orchestratedEntry;
    const hasTopEntry = $('#cpgl_top_launcher').length > 0;
    const showFloatingEntry = visible && shouldShowFloatingLauncher();
    $('#cpgl_top_launcher').toggle(visible);
    $('#cpgl_launcher').toggle(showFloatingEntry);
    if (showFloatingEntry) applyLauncherPosition();
    syncVisibleViewportModal();
    renderManagerModal();
}

function initializeFrontend(reason = 'unknown') {
    if (!document.body) return;
    loadLocalState();
    renderSettings();
    renderOrchestratedEntry();
    renderManagerShell();
    bindSettingsEvents();
    bindNativeOpenEntrypoints();
    bindDebugClickProbe();
    bindDraggableLauncher();
    reconcileGroupAutomationTimers();
    refreshStatus();
    if (!state.frontendInitialized) {
        state.frontendInitialized = true;
        recordCpglDebug('frontend.initialized', { reason });
        setTimeout(maybeStartFirstRunOnboarding, 700);
    }
}

function trapHelpModalFocus(event) {
    const modal = document.getElementById('cpgl_help_modal');
    if (!modal || !isElementVisible(modal)) return;
    const focusable = [...modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(isElementVisible);
    if (!focusable.length) {
        event.preventDefault();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !modal.contains(active))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (active === last || !modal.contains(active))) {
        event.preventDefault();
        first.focus();
    }
}

function handleGlobalKeydown(event) {
    if (event.key === 'Tab' && $('#cpgl_help_modal').is(':visible')) {
        trapHelpModalFocus(event);
        return;
    }
    if (event.key !== 'Escape') return;
    if (state.onboarding.active) {
        event.preventDefault();
        pauseOnboarding();
        return;
    }
    if ($('#cpgl_help_modal').is(':visible')) {
        event.preventDefault();
        closeHelpModal();
        return;
    }
    if ($('#cpgl_redpacket_modal').is(':visible')) {
        event.preventDefault();
        $('#cpgl_redpacket_modal').hide();
        return;
    }
    if ($('#cpgl_create_modal').is(':visible')) {
        event.preventDefault();
        $('#cpgl_create_modal_close').trigger('click');
        return;
    }
    if ($('#cpgl_manage_drawer').hasClass('is-open')) {
        event.preventDefault();
        $('#cpgl_manage_close').trigger('click');
        return;
    }
    if ($('#cpgl_manager_modal').is(':visible')) {
        event.preventDefault();
        $('#cpgl_manager_close').trigger('click');
    }
}

function guardOnboardingPointer(event) {
    if (!state.onboarding.active) return;
    const eventTarget = event.target;
    if (eventTarget?.closest?.('#cpgl_tour_card')) return;

    const step = getCurrentOnboardingStep();
    const target = getOnboardingTarget(step);
    const targetIsInteractive = !!step.waitFor || ['name', 'persona', 'members', 'composer', 'delete-messages', 'help'].includes(step.id);
    const withinTarget = target && (eventTarget === target || target.contains?.(eventTarget));
    const withinMemberPicker = step.id === 'members' && eventTarget?.closest?.('#cpgl_create_members');
    if (targetIsInteractive && (withinTarget || withinMemberPicker)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
}

function registerEvents() {
    const refreshLayout = () => {
        refreshStatus();
        scheduleOnboardingPosition();
    };
    const syncViewportLayout = () => {
        syncVisibleViewportModal();
        scheduleOnboardingPosition();
    };
    window.addEventListener('resize', refreshLayout);
    window.addEventListener('orientationchange', () => setTimeout(refreshLayout, 250));
    window.addEventListener('storage', syncLocalStateFromAnotherWindow);
    window.visualViewport?.addEventListener('resize', syncViewportLayout);
    window.visualViewport?.addEventListener('scroll', syncViewportLayout);
    document.addEventListener('keydown', handleGlobalKeydown);
    document.addEventListener('pointerdown', guardOnboardingPointer, true);
    document.addEventListener('touchstart', guardOnboardingPointer, { capture: true, passive: false });
    document.addEventListener('click', guardOnboardingPointer, true);
    document.addEventListener('scroll', scheduleOnboardingPosition, true);
    eventSource.on(event_types.MESSAGE_SENT, onUserMessage);
    eventSource.on(event_types.MESSAGE_RECEIVED, onAssistantMessage);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearPrivateMemoryCache();
        clearRuntimeState();
        setTimeout(refreshStatus, 250);
    });
    eventSource.on(event_types.WORLDINFO_UPDATED, renderWorldInfoPanel);
    eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, renderWorldInfoPanel);
    eventSource.on(event_types.APP_READY, () => initializeFrontend('APP_READY'));
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initializeFrontend('DOMContentLoaded'), { once: true });
    } else {
        initializeFrontend('document-ready');
    }
    setTimeout(() => initializeFrontend('boot-timeout-500'), 500);
    setTimeout(() => initializeFrontend('boot-timeout-2000'), 2000);
}

registerEvents();

console.log('[ChatPulseGroupLogic] loaded');
