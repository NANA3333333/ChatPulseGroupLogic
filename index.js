import { chat, characters, default_avatar, default_user_avatar, event_types, eventSource, generateQuietPrompt, getRequestHeaders, getThumbnailUrl, this_chid } from '../../../../script.js';
import { ChatCompletionService } from '../../../../scripts/custom-request.js';
import { is_group_generating } from '../../../../scripts/group-chats.js';
import { user_avatar } from '../../../../scripts/personas.js';
import { power_user } from '../../../../scripts/power-user.js';
import { loadWorldInfo, world_info, world_names } from '../../../../scripts/world-info.js';

const MODULE_NAME = 'ChatPulseGroupLogic';
const MODULE_VERSION = '0.1.22';
const METADATA_KEY = 'chatpulse_group_logic';
const LOCAL_STATE_KEY = 'chatpulse_group_logic.local_groups.v1';
const DEBUG_ENDPOINT = '/api/plugins/chatpulse_group_logic_debug/log';

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
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!hasOwnValue(settings, key)) settings[key] = DEFAULT_SETTINGS[key];
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
    normalizeGroupUserPersona(group);
    normalizeGroupWorldInfo(group);
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
        state.localGroups.forEach(normalizeGroupMemory);
        state.activeGroupId = data.activeGroupId || state.localGroups[0]?.id || null;
    } catch (error) {
        console.warn('[ChatPulseGroupLogic] Failed to load local state:', error);
        state.localGroups = [];
        state.activeGroupId = null;
    }
}

function saveLocalState() {
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify({
        groups: state.localGroups,
        activeGroupId: state.activeGroupId,
    }));
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
    if (!Array.isArray(group.debugLogs)) group.debugLogs = [];
    group.debugLogs.push({
        id: `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        ...log,
    });
    group.debugLogs = group.debugLogs.slice(-12);
    saveLocalState();
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

function shouldRetryLocalReply(raw, sanitized, characterName = '') {
    const value = String(raw || '');
    if (!String(sanitized || '').trim()) return true;
    const leakSignals = [
        /getvar::prefill/i,
        /YOUR REPLY AS/i,
        /生成一条群聊消息/i,
        /\b(?:Draft|Wait|Let's refine|prompt asks|Final answer)\b/i,
        /提示词|系统|模型|后台|请求.*矛盾/i,
    ];
    return leakSignals.some(regex => regex.test(value)) || isOocOrMetaReply(sanitized) || hasSpeakerPrefixLeak(sanitized, characterName);
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

function hasSpeakerPrefixLeak(text, currentCharacterName = '') {
    const value = String(text || '');
    if (!value.trim()) return false;
    const memberNames = getGroupCharacters()
        .map(({ character }) => character?.name)
        .filter(Boolean);
    const knownNames = [...new Set([getGroupUserName(), ...memberNames].filter(Boolean))];
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
    const parts = [
        ['角色名', character?.name],
        ['角色描述', character?.description || data.description],
        ['性格', character?.personality || data.personality],
        ['场景', character?.scenario || data.scenario],
        ['开场白', character?.first_mes || data.first_mes],
        ['示例对话', character?.mes_example || data.mes_example],
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

function getLocalGroupMemoryLines(character, currentGroup, limit) {
    const targetAvatar = character?.avatar;
    if (!targetAvatar || limit <= 0) return [];
    const lines = [];
    for (const group of state.localGroups) {
        if (!group || String(group.id) === String(currentGroup?.id)) continue;
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
    if (!character?.avatar || !fileId) return [];
    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar, file_name: fileId }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
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
            const messages = await fetchPrivateChatFile(character, file.id);
            for (const message of messages) {
                if (!message || message.is_system || !normalizeText(message.mes)) continue;
                const speaker = message.is_user ? getMessageSpeaker(message) || getGroupUserName(group) : character.name;
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
    const lines = [...collected, ...currentLines]
        .sort((a, b) => a.at - b.at)
        .map(item => item.line)
        .filter((line, index, array) => array.indexOf(line) === index)
        .slice(-limit);

    privateChatMemoryCache.set(cacheKey, { at: Date.now(), lines });
    return lines;
}

function clearPrivateMemoryCache() {
    privateChatMemoryCache.clear();
}

function getGroupRawWindowLimit(group) {
    const memory = normalizeGroupMemory(group);
    if (memory?.enabled) return memory.rawWindowR;
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
    return await generateQuietPromptWithBackoff({
        quietPrompt: prompt,
        responseLength: memory.summaryResponseLength,
        skipWIAN: true,
        removeReasoning: true,
        trimToSentence: false,
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
        memory.lastError = `长期记忆总结失败：${error?.message || String(error)}`;
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
    for (const group of state.localGroups) {
        if (!group || String(group.id) === String(currentGroup?.id)) continue;
        normalizeGroupMemory(group);
        if (!group.memoryPermissions?.allowOtherGroupMemoryInGroup) continue;
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
        const privateLines = await getAllPrivateMemoryLines(character, limit, group);
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
    if (state.orchestrator.active) return '';
    const ctx = getContext();
    if (ctx.groupId) return '';
    const characterId = ctx.characterId ?? this_chid;
    if (characterId === null || characterId === undefined || characterId < 0) return '';
    const character = characters[characterId];
    if (!character?.avatar) return '';

    const blocks = [];
    for (const group of state.localGroups) {
        normalizeGroupMemory(group);
        if (!group.memoryPermissions?.exposeGroupMemoryToPrivate) continue;
        if (!Array.isArray(group.members) || !group.members.includes(character.avatar)) continue;
        const rounds = getGroupSummaryRounds(group, group.memory?.maxSummaryRounds);
        if (rounds.length) {
            blocks.push([
                `[群：${group.name || group.id}]`,
                ...rounds.map(round => round.text),
            ].join('\n'));
            continue;
        }
        const limit = Math.max(0, Math.min(30, Number(group?.injectLimit) || 0));
        if (limit > 0) {
            const recent = (group.messages || [])
                .filter(message => message && !message.is_system && normalizeText(message.mes))
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
        debugLogs: [],
        injectLimit: 0,
        contextLimit: getSettings().contextLimit,
        noChain: false,
        worldInfoBooks: [],
        includeCharacterWorldInfo: true,
        memory: getDefaultGroupMemory(),
        memoryPermissions: getDefaultMemoryPermissions(),
        createdAt: Date.now(),
    };
    state.localGroups.unshift(group);
    state.activeGroupId = group.id;
    saveLocalState();
    return group;
}

async function saveStGroup(group) {
    const index = state.localGroups.findIndex(item => String(item.id) === String(group.id));
    if (index === -1) throw new Error('保存群聊失败。');
    state.localGroups[index] = group;
    saveLocalState();
}

async function addMembersToGroup(groupId, memberAvatars) {
    const group = getGroupById(groupId);
    if (!group) throw new Error('找不到群聊。');
    const before = new Set(group.members || []);
    const added = [...new Set(memberAvatars)].filter(avatar => avatar && !before.has(avatar));
    if (added.length === 0) return group;
    group.members = [...(group.members || []), ...added];
    group.disabled_members = (group.disabled_members || []).filter(avatar => group.members.includes(avatar));
    for (const avatar of added) {
        const character = getCharacterByAvatar(avatar);
        appendSystemGroupMessage(group, `${character?.name || avatar} 加入了群聊`);
    }
    await saveStGroup(group);
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
    const group = getGroupById(groupId);
    if (!group) throw new Error('找不到群聊。');
    const character = getCharacterByAvatar(avatar);
    if (!(group.members || []).includes(avatar)) return group;
    group.members = (group.members || []).filter(member => member !== avatar);
    group.disabled_members = (group.disabled_members || []).filter(member => member !== avatar);
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
    state.activeGroupId = group.id;
    state.deleteMode = false;
    state.selectedMessageIds.clear();
    hideMentionMenu();
    saveLocalState();
    refreshStatus();
}

function getRecentVisibleMessages(limit) {
    const safeLimit = Math.max(1, Number(limit) || DEFAULT_SETTINGS.contextLimit);
    return getCurrentMessages()
        .map((message, index) => ({ ...message, _index: index }))
        .filter(message => message && normalizeText(message.mes))
        .slice(-safeLimit);
}

function getMentionedCharacterIndexesInTextOrder(text, { includeAll = false } = {}) {
    const groupChars = getGroupCharacters();
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

function getRedPacketsForCurrentGroup() {
    const group = getCurrentGroup();
    if (!group) return [];
    if (!Array.isArray(group.redPackets)) group.redPackets = [];
    return group.redPackets;
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

function createRedPacket(packetData, senderIndex, messageId) {
    const group = getCurrentGroup();
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

function createCharacterRedPacketMessage(packetData, senderIndex) {
    const group = getCurrentGroup();
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

function claimRedPacket(packetId, claimer) {
    const packet = getRedPacket(packetId);
    if (!packet || packet.remaining <= 0) return null;
    if (!Array.isArray(packet.claims)) packet.claims = [];
    const claimerId = claimer.avatar || claimer.id || claimer.name || 'user';
    const alreadyClaimed = packet.claims.some(claim => (
        claim.claimerId === claimerId
        || (isUserClaimId(claimerId) && isUserClaimId(claim.claimerId))
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

function autoClaimAvailablePackets(characterIndex) {
    const character = characters[characterIndex];
    if (!character) return [];
    const packets = getRedPacketsForCurrentGroup()
        .filter(packet => packet.remaining > 0)
        .filter(packet => String(packet.senderAvatar) !== String(character.avatar))
        .filter(packet => !packet.claims.some(claim => claim.claimerId === character.avatar));
    return packets.map(packet => claimRedPacket(packet.id, character)).filter(Boolean);
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

function buildRedPacketStatePrompt() {
    const packets = getRedPacketsForCurrentGroup().filter(packet => packet.remaining > 0);
    if (!packets.length) return '';
    return [
        '[当前红包状态]',
        ...packets.map(packet => `${packet.senderName} 发了 ${packet.total.toFixed(2)} 元/${packet.count} 份红包，剩余 ${packet.remaining} 份，留言：${packet.note}`),
    ].join('\n');
}

function processRedPacketFromLatestMessage(characterIndex) {
    const settings = getSettings();
    if (!settings.redPackets) return [];
    const messages = getCurrentMessages();
    const messageId = messages.length - 1;
    const message = messages[messageId];
    if (!message || message.is_user || message.is_system) return [];
    const packets = parseRedPacketSends(message.mes)
        .map(packetData => createRedPacket(packetData, characterIndex, messageId))
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

async function generateQuietPromptWithBackoff(options) {
    const delay = getApiDelayForNextCall();
    if (delay > 0) await wait(delay);
    try {
        const result = await generateQuietPrompt(options);
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

function collectPostRoundMentions(messageId) {
    const settings = getSettings();
    if (!settings.postRoundMentionReplies || !state.orchestrator.active) return;
    const message = getCurrentMessages()[messageId];
    if (!message || message.is_user || message.is_system || !normalizeText(message.mes)) return;

    const senderName = getMessageSpeaker(message);
    const senderAvatar = message.avatar || '';
    const targets = getMentionedCharacterIndexesInTextOrder(message.mes, { includeAll: false })
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

async function generateForcedMember(characterIndex, instruction = '') {
    await waitForGroupIdle();
    const group = getCurrentGroup();
    const character = characters[characterIndex];
    if (!group || !character) return;
    if (shouldStopQueue()) return { dropped: true, stopped: true };
    if (consumeQueueSkip(characterIndex)) {
        finishQueueItem(characterIndex, 'skipped', '已跳过');
        return { dropped: true, skipped: true };
    }
    state.orchestrator.currentInstruction = instruction;
    state.typing = [{ id: character.avatar, name: character.name }];
    markQueueCurrent(characterIndex, `${character.name} 正在回复`);
    renderTypingIndicator();
    try {
        const history = getRecentVisibleMessages(getGroupRawWindowLimit(group))
            .map(message => {
                return formatMemoryLine(message);
            })
            .filter(Boolean)
            .join('\n');
        const characterCard = buildCharacterCardBlock(character);
        const userPersona = buildUserPersonaBlock(group);
        const userName = getGroupUserName(group);
        const groupLongMemory = buildGroupLongMemoryBlock(group);
        const worldInfoBlock = await buildGroupWorldInfoBlock(group, character, `${groupLongMemory}\n${history}\n${characterCard}\n${userPersona}\n${instruction}`);
        const crossChatMemory = await buildCrossChatMemoryBlock(character, group);
        const prompt = [
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
            instruction ? `发言顺序提示：${instruction}` : '',
            buildRedPacketStatePrompt(),
            `最近聊天：\n${history || '暂无'}`,
            '',
            `身份边界（最高优先级）：你只能作为 ${character.name} 发言。${userName} 是用户，不是你；其他群成员也不是你。`,
            `禁止代言：不要替 ${userName} 写任何话、想法、动作或决定；不要替任何其他群成员写台词、反应、心情或行动。`,
            `只允许输出 ${character.name} 亲自发到群里的这一条消息。最近聊天只是上下文记录，不是剧本续写模板，不要输出“某某: 内容”的多说话人格式。`,
            `你的输出必须像 ${character.name} 在聊天软件里亲自发送的一条消息。`,
            'If the turn note contains [MENTION], someone just @mentioned you directly. Reply to that message naturally; do not ignore it.',
            '如果用户明确要求你发红包，或者当前角色决定发红包，必须在消息末尾附加隐藏标签：[REDPACKET_SEND:lucky|总金额|份数|留言] 或 [REDPACKET_SEND:equal|总金额|份数|留言]。这个标签只用于系统创建红包，正文里不要解释标签。',
            `只输出 ${character.name} 接下来会发的一条消息正文。除必要的 REDPACKET_SEND 隐藏标签外，不要输出其他标签、草稿、分析、英文解释、规则、选项或“YOUR REPLY AS”。`,
        ].filter(Boolean).join('\n');
        const requestOptions = {
            quietPrompt: prompt,
            forceChId: characterIndex,
            responseLength: Math.max(3000, Number(getSettings().responseLength) || DEFAULT_SETTINGS.responseLength),
            skipWIAN: true,
            removeReasoning: true,
            trimToSentence: false,
        };
        let raw = await generateQuietPromptWithBackoff(requestOptions);
        if (shouldStopQueue() || consumeQueueSkip(characterIndex)) {
            finishQueueItem(characterIndex, 'skipped', '结果已丢弃');
            return { dropped: true, skipped: true };
        }
        let redPacketSends = parseRedPacketSends(raw);
        let sanitized = applyLocalRegex(sanitizeLocalReply(raw, character.name));
        let retried = false;
        if (redPacketSends.length === 0 && shouldRetryLocalReply(raw, sanitized, character.name)) {
            retried = true;
            const retryPrompt = [
                `最高优先级身份规则：你只能扮演 ${character.name}。`,
                `${userName} 是用户，不是你。不要用用户口吻说话，不要替用户写想法、动作或回应。`,
                '不要替其他群成员写台词、反应、心情、动作或决定。',
                `角色：${character.name}`,
                characterCard ? `角色卡：\n${characterCard}` : '',
                userPersona,
                worldInfoBlock,
                `最近聊天：\n${history || '暂无'}`,
                `只写一条 ${character.name} 本人会发出的群聊消息。不要解释，不要草稿，不要自我修订，不要写标签，不要写“名字: 台词”的剧本格式。`,
            ].filter(Boolean).join('\n');
            raw = await generateQuietPromptWithBackoff({
                ...requestOptions,
                quietPrompt: retryPrompt,
                responseLength: Math.max(1200, Math.floor((Number(getSettings().responseLength) || DEFAULT_SETTINGS.responseLength) / 2)),
            });
            redPacketSends = parseRedPacketSends(raw);
            sanitized = applyLocalRegex(sanitizeLocalReply(raw, character.name));
        }
        if (shouldStopQueue() || consumeQueueSkip(characterIndex)) {
            finishQueueItem(characterIndex, 'skipped', '结果已丢弃');
            return { dropped: true, skipped: true };
        }
        appendDebugLog(group, {
            character: character.name,
            prompt,
            raw,
            sanitized,
            retried,
        });
        const dropped = !sanitized || isOocOrMetaReply(sanitized) || hasSpeakerPrefixLeak(sanitized, character.name);
        const createdPackets = [];
        if (!dropped) {
            const messageId = appendLocalMessage(group, {
                is_user: false,
                name: character.name,
                avatar: character.avatar,
                mes: sanitized,
            });
            collectPostRoundMentions(messageId);
            processRedPacketFromLatestMessage(characterIndex);
            autoClaimAvailablePackets(characterIndex);
        }
        for (const packetData of redPacketSends) {
            const packet = createCharacterRedPacketMessage(packetData, characterIndex);
            if (packet) createdPackets.push(packet);
        }
        if (createdPackets.length > 0) {
            state.orchestrator.redPacketEvents.push(...createdPackets);
        }
        if (dropped && createdPackets.length === 0) {
            toastr.warning(`${character.name} 的输出像 OOC/调试文本，已丢弃。`, 'ChatPulse Group Logic');
        }
        finishQueueItem(characterIndex, dropped ? 'failed' : 'done', dropped ? '已丢弃' : '完成');
        return {
            dropped,
            packets: createdPackets,
        };
    } catch (error) {
        finishQueueItem(characterIndex, 'failed', error?.message || '生成失败');
        throw error;
    } finally {
        state.orchestrator.currentInstruction = '';
        state.typing = [];
        renderTypingIndicator();
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

async function runRedPacketReactionRound(packet) {
    const settings = getSettings();
    if (!settings.enabled || !settings.orchestratedEntry || !packet) return;
    const group = getCurrentGroup();
    if (!group) return;
    if (state.orchestrator.active) {
        toastr.warning('当前群聊轮询还在进行，红包反应会等下一次消息触发。', 'ChatPulse Group Logic');
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
    if (state.orchestrator.active) {
        toastr.warning('当前群聊轮询还在进行，成员变动反应会跳过。', 'ChatPulse Group Logic');
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
    hideMentionMenu();
}

function hideEmojiPicker() {
    $('#cpgl_emoji_picker').hide();
}

function renderEmojiPicker() {
    const html = `
        <div class="cpgl-emoji-picker-close">
            <button id="cpgl_emoji_close" type="button" title="关闭">×</button>
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
                    <div class="cpgl-hint">群成员、AI 互相接话、私聊注入、API 间隔、预设/正则、红包和清空记录都在独立群聊弹窗右侧管理。</div>
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
        <div id="cpgl_top_launcher" class="drawer cpgl-top-launcher" title="ChatPulse 群聊">
            <div class="drawer-toggle drawer-header">
                <div class="drawer-icon fa-solid fa-comments fa-fw" title="ChatPulse 群聊"></div>
            </div>
        </div>`;
        topHolder.prepend(topHtml);
    }
    if (!$('#cpgl_launcher').length) {
        const html = `
        <button id="cpgl_launcher" type="button" title="ChatPulse 群聊">
            <span class="cpgl-launcher-mark">群</span>
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
    if (isTouchViewport()) return false;
    const hasTopEntry = $('#cpgl_top_launcher').length > 0;
    if (!hasTopEntry) return true;
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    return width <= 820 || isTouchViewport();
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
    <div id="cpgl_manager_modal" class="cpgl-modal-backdrop" style="display:none;">
        <div class="cpgl-app-shell">
            <nav class="cpgl-sidebar-nav">
                <button id="cpgl_group_list_toggle" class="cpgl-nav-item active" type="button" title="群聊列表">群</button>
                <button id="cpgl_manager_close" class="cpgl-nav-item" type="button" title="关闭">×</button>
            </nav>
            <aside class="cpgl-middle-column">
                <div class="cpgl-middle-header">
                    <div>
                        <div class="cpgl-middle-title">群聊</div>
                        <div class="cpgl-hint">ChatPulse Group</div>
                    </div>
                    <button id="cpgl_show_create" class="cpgl-icon-btn" type="button" title="发起群聊">＋</button>
                </div>
                <div id="cpgl_group_list" class="cpgl-chat-list"></div>
            </aside>
            <main class="cpgl-right-column">
                <section class="cpgl-chat-window">
                    <header class="cpgl-chat-header">
                        <div class="cpgl-chat-header-title">
                            <span class="cpgl-header-icon">群</span>
                            <div>
                                <div id="cpgl_chat_title" class="cpgl-chat-header-name">选择或创建一个群聊</div>
                                <div id="cpgl_chat_subtitle" class="cpgl-hint">ChatPulse 轮询逻辑会接管这个窗口里的发送。</div>
                            </div>
                        </div>
                        <div class="cpgl-chat-header-actions">
                            <button id="cpgl_mobile_create_group" type="button" title="发起群聊">＋</button>
                            <button id="cpgl_header_delete_messages" type="button" title="选择删除对话">🗑</button>
                            <button id="cpgl_manage_toggle" type="button" title="群管理">⚙</button>
                        </div>
                    </header>
                    <div id="cpgl_queue_panel" class="cpgl-queue-panel" style="display:none;"></div>
                    <div id="cpgl_chat_messages" class="cpgl-chat-messages"></div>
                    <div id="cpgl_typing_indicator" class="cpgl-typing-indicator" style="display:none;"></div>
                    <div id="cpgl_delete_mode_bar" class="cpgl-delete-mode-bar" style="display:none;"></div>
                    <div class="cpgl-chat-composer">
                        <div id="cpgl_mention_menu" class="cpgl-mention-menu" style="display:none;"></div>
                        <div class="cpgl-input-toolbar">
                            <button id="cpgl_emoji_toggle" type="button" title="插入表情">☺</button>
                            <button id="cpgl_quick_redpacket" type="button" title="发红包">🧧</button>
                            <div id="cpgl_emoji_picker" class="cpgl-emoji-picker" style="display:none;"></div>
                        </div>
                        <textarea id="cpgl_entry_text" rows="3" placeholder="在这里发群消息。无 @ 随机轮询；@角色 则点名优先。"></textarea>
                        <div class="cpgl-entry-actions">
                            <button id="cpgl_entry_send" class="cpgl-send-button" type="button">发送</button>
                        </div>
                    </div>
                </section>
                <aside id="cpgl_manage_drawer" class="cpgl-manage-drawer">
                    <div class="cpgl-drawer-header">
                        <strong><span>⚙</span> 群管理</strong>
                        <button id="cpgl_manage_close" class="cpgl-icon-btn" type="button" title="关闭">×</button>
                    </div>
                    <section class="cpgl-section">
                        <h4>群名称</h4>
                        <div class="cpgl-group-name-row">
                            <input id="cpgl_group_name_input" type="text" placeholder="群聊名称">
                            <button id="cpgl_rename_group" class="cpgl-icon-btn" type="button" title="修改群名">✎</button>
                        </div>
                    </section>
                    <section class="cpgl-section">
                        <h4>User 人设</h4>
                        <select id="cpgl_group_user_persona_select"></select>
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
                    <section class="cpgl-section">
                        <h4>群成员 <span id="cpgl_member_count">(0)</span></h4>
                        <div id="cpgl_current_members" class="cpgl-list"></div>
                        <div class="cpgl-row cpgl-add-row">
                            <select id="cpgl_add_member_select"></select>
                            <button id="cpgl_add_member" class="menu_button">拉人</button>
                        </div>
                    </section>
                    <section class="cpgl-section">
                        <h4>运行队列</h4>
                        <div id="cpgl_queue_drawer" class="cpgl-queue-drawer"></div>
                    </section>
                    <section class="cpgl-section">
                        <h4>AI 控制</h4>
                        <label class="cpgl-switch-row">
                            <span>⚡ 禁止AI互相接话</span>
                            <input id="cpgl_drawer_no_chain" type="checkbox">
                            <i></i>
                        </label>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>📥 跨聊原文备用条数</span>
                                <strong id="cpgl_drawer_inject_value">0</strong>
                            </div>
                            <input id="cpgl_drawer_inject_limit" type="range" min="0" max="30" step="1">
                            <p>只在权限允许时读取私聊或其他群的近期原文。0 = 只用摘要。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>🧠 AI 记忆视界（上下文条数）</span>
                                <strong id="cpgl_drawer_context_value">0</strong>
                            </div>
                            <input id="cpgl_drawer_context_limit" type="range" min="4" max="80" step="1">
                            <p>AI 在本群能感知的最近消息条数。超出该线的旧消息将被忽略。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>⏱ API 初始间隔</span>
                                <strong id="cpgl_api_base_value">0s</strong>
                            </div>
                            <input id="cpgl_api_base_delay" type="range" min="0" max="20000" step="500">
                            <p>每轮第一个角色请求前等待多久。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>⏳ 每次递增间隔</span>
                                <strong id="cpgl_api_step_value">0s</strong>
                            </div>
                            <input id="cpgl_api_step_delay" type="range" min="0" max="10000" step="500">
                            <p>同一轮里，每多一个角色，请求间隔增加多少。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>🧯 最大退避间隔</span>
                                <strong id="cpgl_api_max_value">0s</strong>
                            </div>
                            <input id="cpgl_api_max_delay" type="range" min="3000" max="60000" step="1000">
                            <p>撞到 Too Many Requests 后，间隔会自动提高但不超过这里。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>📏 输出上限</span>
                                <strong id="cpgl_response_length_value">3000</strong>
                            </div>
                            <input id="cpgl_response_length" type="range" min="500" max="6000" step="100">
                            <p>单个角色每次生成的最大输出长度。</p>
                        </div>
                    </section>
                    <section class="cpgl-section">
                        <h4>群聊世界书</h4>
                        <label class="cpgl-switch-row">
                            <span>同时读取成员角色卡世界书</span>
                            <input id="cpgl_include_character_world_info" type="checkbox">
                            <i></i>
                        </label>
                        <div id="cpgl_world_info_status" class="cpgl-hint"></div>
                        <div id="cpgl_world_info_books" class="cpgl-world-book-list"></div>
                    </section>
                    <section class="cpgl-section">
                        <h4>长期记忆</h4>
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
                            <input id="cpgl_memory_r" type="range" min="4" max="120" step="1">
                            <p>最新 R 条消息保留原文，窗口外消息才会被总结。</p>
                        </div>
                        <div class="cpgl-slider-row">
                            <div>
                                <span>S 触发阈值</span>
                                <strong id="cpgl_memory_s_value">16</strong>
                            </div>
                            <input id="cpgl_memory_s" type="range" min="4" max="80" step="1">
                            <p>窗口外未摘要消息达到 S 条时，回复前先总结；失败则中止本轮。</p>
                        </div>
                        <div class="cpgl-row">
                            <label for="cpgl_summary_provider">总结模型</label>
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
                            <span>私聊可读取本群摘要</span>
                            <input id="cpgl_expose_group_memory_private" type="checkbox">
                            <i></i>
                        </label>
                        <label class="cpgl-switch-row">
                            <span>本群可读取角色私聊记忆</span>
                            <input id="cpgl_allow_private_memory_group" type="checkbox">
                            <i></i>
                        </label>
                        <label class="cpgl-switch-row">
                            <span>本群可读取角色其他群摘要</span>
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
                    <section class="cpgl-section">
                        <h4>独立预设 / 正则</h4>
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
                    <section class="cpgl-section">
                        <h4>最近输入 / 输出</h4>
                        <div id="cpgl_debug_logs" class="cpgl-debug-logs"></div>
                        <button id="cpgl_clear_debug_logs" type="button" class="cpgl-danger-outline">清空调试记录</button>
                    </section>
                    <section class="cpgl-section">
                        <h4>红包记录</h4>
                        <div id="cpgl_red_packet_list" class="cpgl-list"></div>
                    </section>
                    <section class="cpgl-section cpgl-danger-section">
                        <h4>危险操作</h4>
                        <button id="cpgl_clear_queue_danger" type="button" class="cpgl-danger-outline">清空队列</button>
                        <button id="cpgl_clear_messages_danger" type="button" class="cpgl-danger-outline">删除对话记录</button>
                    </section>
                </aside>
            </main>
        </div>
        <div id="cpgl_create_modal" class="cpgl-create-modal" style="display:none;">
            <div class="cpgl-create-card">
                <div class="cpgl-create-header">
                    <strong>发起群聊</strong>
                    <button id="cpgl_create_modal_close" type="button" class="cpgl-icon-btn">×</button>
                </div>
                <div class="cpgl-create-body">
                    <input id="cpgl_new_group_name" type="text" placeholder="群聊名称">
                    <label class="cpgl-create-field">
                        <span>User 人设</span>
                        <select id="cpgl_new_user_persona"></select>
                    </label>
                    <div class="cpgl-search-shell">
                        <span>⌕</span>
                        <input id="cpgl_create_search" type="text" placeholder="搜索角色...">
                    </div>
                    <div id="cpgl_create_members" class="cpgl-create-members"></div>
                    <button id="cpgl_create_group" class="cpgl-send-button" type="button">创建</button>
                </div>
            </div>
        </div>
        <div id="cpgl_redpacket_modal" class="cpgl-redpacket-modal" style="display:none;">
            <div class="cpgl-redpacket-card">
                <div class="cpgl-redpacket-header">
                    <strong>🧧 发送红包</strong>
                    <button id="cpgl_redpacket_close" type="button">×</button>
                </div>
                <div class="cpgl-redpacket-tabs">
                    <button id="cpgl_packet_lucky" class="active" type="button">🎲 拼手气</button>
                    <button id="cpgl_packet_fixed" type="button">📦 普通</button>
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
                    <button id="cpgl_user_packet_send" class="cpgl-redpacket-send" type="button">🧧 塞钱进红包</button>
                </div>
            </div>
        </div>
    </div>`;
    $('body').append(html);
    renderManagerModal();
}

function characterOptionHtml(character, checked = false) {
    return `
        <label class="cpgl-member-option">
            <input type="checkbox" value="${escapeHtml(character.avatar)}" ${checked ? 'checked' : ''}>
            <img src="${escapeHtml(getCharacterAvatarUrl(character))}" alt="">
            <span>${escapeHtml(character.name || character.avatar)}</span>
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
        recordCpglDebug(`ui.${event.type}`, {
            element: describeElementForDebug(target),
            via: entrypoint?.via || 'target',
            actualTarget: describeElementForDebug(entrypoint?.actualTarget || event.target),
            topElement: describeElementForDebug(entrypoint?.topElement),
            point: entrypoint?.point ? `${Math.round(entrypoint.point.x)},${Math.round(entrypoint.point.y)}` : '',
            id: target.id || '',
            value: target.matches?.('input, textarea, select') ? String(target.value || '').slice(0, 80) : '',
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

function bindManagerLiveEvents() {
    renderEmojiPicker();
    $(document)
        .off('.cpglManagerLive')
        .on('click.cpglManagerLive', '#cpgl_manager_close', () => $('#cpgl_manager_modal').hide())
        .on('click.cpglManagerLive', '#cpgl_group_list_toggle', event => {
            event.preventDefault();
            const modal = $('#cpgl_manager_modal');
            const isCompactModal = modal.hasClass('cpgl-touch-modal') || !!window.matchMedia?.('(max-width: 620px)')?.matches;
            if (isCompactModal) {
                modal.toggleClass('cpgl-show-group-list');
            }
        })
        .on('click.cpglManagerLive', '#cpgl_show_create, #cpgl_mobile_create_group, #cpgl_empty_create_group', () => $('#cpgl_create_modal').css('display', 'flex'))
        .on('click.cpglManagerLive', '#cpgl_header_delete_messages', () => {
            if (!getCurrentGroup()) {
                toastr.warning('请先进入一个群聊。');
                return;
            }
            setDeleteMode(!state.deleteMode);
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
        .on('click.cpglManagerLive', '#cpgl_create_modal_close', () => $('#cpgl_create_modal').hide())
        .on('click.cpglManagerLive', '#cpgl_create_modal', event => {
            if (event.target.id === 'cpgl_create_modal') $('#cpgl_create_modal').hide();
        })
        .on('input.cpglManagerLive', '#cpgl_create_search', renderManagerModal)
        .on('change.cpglManagerLive', '#cpgl_new_user_persona', event => {
            state.createUserPersonaAvatar = String(event.target.value || '');
        })
        .on('change.cpglManagerLive', '#cpgl_create_members input[type="checkbox"]', event => {
            if (event.target.checked) {
                state.createMemberAvatars.add(event.target.value);
            } else {
                state.createMemberAvatars.delete(event.target.value);
            }
        })
        .on('click.cpglManagerLive', '#cpgl_manage_toggle', () => $('#cpgl_manage_drawer').toggleClass('is-open'))
        .on('click.cpglManagerLive', '#cpgl_manage_close', () => $('#cpgl_manage_drawer').removeClass('is-open'))
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
            saveLocalState();
            renderMemoryPanel();
        })
        .on('change.cpglManagerLive', '#cpgl_allow_other_group_memory', event => {
            const group = getCurrentGroup();
            if (!group) return;
            normalizeGroupMemory(group);
            group.memoryPermissions.allowOtherGroupMemoryInGroup = event.target.checked;
            saveLocalState();
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
            group.debugLogs = [];
            group.memory = getDefaultGroupMemory();
            clearRuntimeState();
            saveLocalState();
            renderManagerModal();
            toastr.success('对话记录已删除。', 'ChatPulse Group Logic');
        })
        .on('click.cpglManagerLive', '#cpgl_clear_debug_logs', () => {
            const group = getCurrentGroup();
            if (!group) return;
            group.debugLogs = [];
            saveLocalState();
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
            if (event.target.id === 'cpgl_manager_modal') $('#cpgl_manager_modal').hide();
        })
        .on('click.cpglManagerLive', '#cpgl_create_group', async () => {
            try {
                const avatars = [...state.createMemberAvatars];
                const userPersonaAvatar = String($('#cpgl_new_user_persona').val() || state.createUserPersonaAvatar || '');
                await createStGroup(String($('#cpgl_new_group_name').val() || ''), avatars, userPersonaAvatar);
                $('#cpgl_new_group_name').val('');
                $('#cpgl_create_search').val('');
                state.createMemberAvatars.clear();
                $('#cpgl_create_modal').hide();
                renderManagerModal();
                refreshStatus();
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
                setTimeout(() => {
                    runRedPacketReactionRound(createdPacket);
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
            $('#cpgl_entry_text').val('');
            hideMentionMenu();
            hideEmojiPicker();
            runOrchestratedRound(text);
        })
        .on('input.cpglManagerLive click.cpglManagerLive keyup.cpglManagerLive', '#cpgl_entry_text', event => {
            if (event.type === 'keyup' && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
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
        $('#cpgl_chat_subtitle').text('左侧创建群聊，或进入已有群聊。');
        $('#cpgl_chat_messages').html(`
            <div class="cpgl-empty-state">
                <div class="cpgl-empty-icon">群</div>
                <p>从这里开始一个群聊</p>
                <span>左侧点 ＋ 发起群聊，或者进入已有群聊。</span>
                <button id="cpgl_empty_create_group" class="menu_button cpgl-empty-action" type="button">发起群聊</button>
            </div>`);
        return;
    }

    $('#cpgl_chat_title').text(group.name || group.id);
    $('#cpgl_chat_subtitle').text(`${(group.members || []).length} 个成员 | User: ${getGroupUserName(group)} | 无 @ 随机轮询，@角色 点名优先`);
    const rows = getRecentVisibleMessages(80).map(message => {
        const messageId = getLocalMessageId(message, message._index);
        const selected = state.selectedMessageIds.has(messageId);
        if (message.is_system) {
            const systemText = stripTags(message.mes).replace(/^\[System\]\s*/i, '').trim();
            return systemText ? `
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
            <div class="cpgl-message-wrapper ${isUser ? 'user' : 'character'} ${state.deleteMode ? 'delete-mode' : ''} ${selected ? 'selected' : ''}" data-message-id="${escapeHtml(messageId)}">
                ${messageSelectControl(messageId)}
                <div class="cpgl-message-avatar"><img src="${escapeHtml(avatarUrl)}" alt=""></div>
                <div class="cpgl-message-content">
                    ${isUser ? '' : `<div class="cpgl-message-name">${escapeHtml(speaker)}</div>`}
                    ${bubble}
                </div>
            </div>`;
    }).join('');

    $('#cpgl_chat_messages').html(rows || `
        <div class="cpgl-empty-state">
            <div class="cpgl-empty-icon">群</div>
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
                <span class="cpgl-redpacket-message-icon">🧧</span>
                <div>
                    <strong>${escapeHtml(packet.note || '红包')}</strong>
                    <span>${packet.mode === 'equal' ? '普通红包' : '拼手气红包'} · ${claimed}/${packet.count}</span>
                </div>
            </div>
            ${canClaim ? `<button class="cpgl-redpacket-open cpgl-claim-packet" type="button" data-packet-id="${escapeHtml(packet.id)}">🧧 拆红包</button>` : ''}
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
        .html(`<span>✨</span><div>${escapeHtml(names)} 正在思考...</div><button id="cpgl_interrupt_generation" type="button">打断</button>`)
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
    $('#cpgl_manager_modal').removeClass('cpgl-show-group-list').css('display', 'flex');
    recordCpglDebug('openGroupCenter.done');
}

async function openGroupConversation(groupId) {
    await openManagedGroup(groupId);
    $('#cpgl_manager_modal').removeClass('cpgl-show-group-list');
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
    return !!window.visualViewport && isTouchViewport();
}

function isTouchViewport() {
    const coarsePointer = typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;
    const touchPoints = Number(navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0) > 0;
    const touchEvent = 'ontouchstart' in window;
    const viewport = window.visualViewport;
    const narrowVisibleViewport = viewport
        ? Math.min(viewport.width || 0, viewport.height || 0) <= 900
        : false;
    return coarsePointer || touchPoints || touchEvent || narrowVisibleViewport;
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
        return;
    }
    const viewport = window.visualViewport;
    const width = Number(viewport.width || window.innerWidth || document.documentElement.clientWidth || 0);
    const height = Number(viewport.height || window.innerHeight || document.documentElement.clientHeight || 0);
    const scale = Number(viewport.scale || 1);
    const desktopScaledTouch = width > 620 && isTouchViewport();
    const desiredShellWidth = desktopScaledTouch
        ? Math.max(320, width - 16)
        : Math.min(Math.max(320, width - 16), Math.max(320, 430 / Math.max(scale, 0.4)));
    const desiredShellHeight = desktopScaledTouch
        ? Math.max(520, height - 16)
        : Math.min(Math.max(520, height - 16), Math.max(520, 720 / Math.max(scale, 0.4)));
    modal.classList.add('cpgl-visual-viewport');
    modal.classList.add('cpgl-touch-modal');
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
    recordCpglDebug('syncVisibleViewportModal', {
        shellWidth: Math.round(desiredShellWidth),
        shellHeight: Math.round(desiredShellHeight),
    });
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

function renderManagerModal() {
    if (!$('#cpgl_manager_modal').length) return;
    const createSearch = String($('#cpgl_create_search').val() || '').toLowerCase();
    const createCandidates = characters.filter(character => (character.name || character.avatar || '').toLowerCase().includes(createSearch));
    $('#cpgl_create_members').html(createCandidates.map(character => characterOptionHtml(character, state.createMemberAvatars.has(character.avatar))).join(''));
    state.createUserPersonaAvatar = renderUserPersonaSelect(
        '#cpgl_new_user_persona',
        String($('#cpgl_new_user_persona').val() || state.createUserPersonaAvatar || getDefaultUserPersonaAvatar()),
    );

    const groupRows = state.localGroups.map(group => {
        const firstMember = getCharacterByAvatar((group.members || [])[0]);
        const names = (group.members || []).map(avatar => getCharacterByAvatar(avatar)?.name || avatar).join('、');
        const isActive = getCurrentGroup()?.id === group.id;
        const userName = getGroupUserName(group);
        return `
            <button class="cpgl-chat-list-item cpgl-open-group ${isActive ? 'active' : ''}" type="button" data-group-id="${escapeHtml(group.id)}">
                <img src="${escapeHtml(getCharacterAvatarUrl(firstMember))}" alt="">
                <div>
                    <strong>${escapeHtml(group.name || group.id)}</strong>
                    <span>${escapeHtml(`User: ${userName} | ${names || '无成员'}`)}</span>
                </div>
            </button>`;
    }).join('');
    $('#cpgl_group_list').html(groupRows || '<div class="cpgl-list-empty">还没有群聊。</div>');

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
        return;
    }
    $('#cpgl_group_name_input').val(group.name || '');
    const groupPersonaAvatar = renderUserPersonaSelect('#cpgl_group_user_persona_select', group.userPersonaAvatar);
    group.userPersonaAvatar = groupPersonaAvatar;
    const groupPersona = getGroupUserPersona(group);
    $('#cpgl_group_user_persona_hint').text(
        groupPersona.avatar
            ? `本群用户消息、红包和提示词会使用「${groupPersona.name}」。`
            : '没有可用 persona 时，会回退到 ST 当前用户。',
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

    const memberRows = (group.members || []).map(avatar => {
        const character = getCharacterByAvatar(avatar);
        return `
            <div class="cpgl-list-row">
                <div class="cpgl-member-line">
                    <img src="${escapeHtml(getCharacterAvatarUrl(character))}" alt="">
                    <span>${escapeHtml(character?.name || avatar)}</span>
                </div>
                <button class="cpgl-danger-link cpgl-kick-member" type="button" data-avatar="${escapeHtml(avatar)}">踢出</button>
            </div>`;
    }).join('');
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
    const logs = (group?.debugLogs || []).slice().reverse();
    const html = logs.map(log => `
        <details class="cpgl-debug-item">
            <summary>${escapeHtml(log.character || 'unknown')} · ${new Date(log.at || Date.now()).toLocaleTimeString()}${log.retried ? ' · retry' : ''}</summary>
            <label>Prompt</label>
            <pre>${escapeHtml(log.prompt || '')}</pre>
            <label>Raw Output</label>
            <pre>${escapeHtml(log.raw || '')}</pre>
            <label>Sanitized</label>
            <pre>${escapeHtml(log.sanitized || '')}</pre>
        </details>
    `).join('');
    $('#cpgl_debug_logs').html(html || '<div class="cpgl-hint">还没有新的输入输出记录。之后每次生成都会记录。</div>');
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
    $('#cpgl_world_info_books').html(rows || '<div class="cpgl-hint">没有可用世界书。</div>');

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
    return oldMessages.length - keptMessages.length;
}

function renderDeleteModeBar() {
    if (!$('#cpgl_delete_mode_bar').length) return;
    $('#cpgl_header_delete_messages').toggleClass('active', !!state.deleteMode);
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
    refreshStatus();
    if (!state.frontendInitialized) {
        state.frontendInitialized = true;
        recordCpglDebug('frontend.initialized', { reason });
    }
}

function registerEvents() {
    window.addEventListener('resize', refreshStatus);
    window.addEventListener('orientationchange', () => setTimeout(refreshStatus, 250));
    window.visualViewport?.addEventListener('resize', syncVisibleViewportModal);
    window.visualViewport?.addEventListener('scroll', syncVisibleViewportModal);
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
