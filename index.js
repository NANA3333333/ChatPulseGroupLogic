import { chat, characters, default_avatar, event_types, eventSource, generateQuietPrompt, getRequestHeaders, getThumbnailUrl, this_chid } from '../../../../script.js';
import { is_group_generating } from '../../../../scripts/group-chats.js';
import { power_user } from '../../../../scripts/power-user.js';
import { loadWorldInfo, world_info } from '../../../../scripts/world-info.js';

const MODULE_NAME = 'ChatPulseGroupLogic';
const METADATA_KEY = 'chatpulse_group_logic';
const LOCAL_STATE_KEY = 'chatpulse_group_logic.local_groups.v1';

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
    includeLocalPreset: false,
    localPreset: [
        '这是一个即时通讯群聊。你只回复当前角色会发出的聊天内容。',
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
    },
    createMemberAvatars: new Set(),
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
    apiDelayMs: 2500,
    generationCounter: 0,
};

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const ctx = getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = ctx.extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) settings[key] = DEFAULT_SETTINGS[key];
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

function loadLocalState() {
    try {
        const raw = localStorage.getItem(LOCAL_STATE_KEY);
        const data = raw ? JSON.parse(raw) : {};
        state.localGroups = Array.isArray(data.groups) ? data.groups : [];
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
    return state.localGroups.find(group => String(group.id) === String(state.activeGroupId)) || null;
}

function getGroupById(groupId) {
    return state.localGroups.find(group => String(group.id) === String(groupId)) || null;
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

function getUserAvatarUrl() {
    return default_avatar;
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
    return group.messages.length - 1;
}

function appendSystemGroupMessage(group, content) {
    return appendLocalMessage(group, {
        is_system: true,
        name: 'System',
        avatar: '',
        mes: `[System] ${content}`,
    });
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
    const knownNames = [...new Set([getUserName(), ...memberNames].filter(Boolean))];
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

function buildUserPersonaBlock() {
    const name = getUserName();
    const personaDescription = [
        power_user?.persona_description,
        power_user?.default_persona ? power_user?.persona_descriptions?.[power_user.default_persona]?.description : '',
    ]
        .map(value => limitText(value, 1800))
        .find(Boolean);
    return [
        '[当前用户人设]',
        `用户名称：${name}`,
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
    return [...new Set(names.filter(Boolean))];
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

async function buildCharacterWorldInfoBlock(character, searchText) {
    const worldNames = getCharacterWorldNames(character);
    if (!worldNames.length) return '';
    const lines = [];
    for (const worldName of worldNames) {
        const book = await loadWorldInfo(worldName);
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
    return [
        '[当前角色绑定世界书]',
        '以下只来自当前发言角色绑定的世界书。把它当作设定背景，不要复述来源标签。',
        ...lines,
    ].join('\n');
}

function formatMemoryLine(message, fallbackName = 'Unknown') {
    if (message?.is_system) {
        const content = stripTags(message.mes).replace(/^\[System\]\s*/i, '').trim();
        return content ? `[System] ${content}` : '';
    }
    const speaker = getMessageSpeaker(message) || (message.is_user ? getUserName() : fallbackName);
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
            const line = formatMemoryLine(message, character.name);
            if (line) lines.push(`[群:${group.name || group.id}] ${line}`);
        }
    }
    return lines.slice(-limit);
}

function getCurrentPrivateMemoryLines(character, limit) {
    if (!character || limit <= 0 || this_chid === null || this_chid === undefined) return [];
    const activeCharacter = characters[this_chid];
    if (!activeCharacter || String(activeCharacter.avatar) !== String(character.avatar)) return [];
    return (Array.isArray(chat) ? chat : [])
        .filter(message => message && !message.is_system && normalizeText(message.mes))
        .slice(-limit)
        .map(message => {
            const speaker = message.is_user ? getUserName() : character.name;
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

async function getAllPrivateMemoryLines(character, limit) {
    if (!character || limit <= 0) return [];
    const cacheKey = `${character.avatar}:${limit}`;
    const cached = privateChatMemoryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PRIVATE_CHAT_CACHE_TTL_MS) return cached.lines;

    const collected = [];
    try {
        const files = await fetchPrivateChatFiles(character);
        for (const file of files) {
            const messages = await fetchPrivateChatFile(character, file.id);
            for (const message of messages) {
                if (!message || message.is_system || !normalizeText(message.mes)) continue;
                const speaker = message.is_user ? getUserName() : character.name;
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

    const currentLines = getCurrentPrivateMemoryLines(character, limit).map((line, index) => ({
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

async function buildCrossChatMemoryBlock(character, currentGroup) {
    const limit = Math.max(0, Math.min(30, Number(currentGroup?.injectLimit) || 0));
    if (!limit || !character) return '';
    const lines = [
        ...await getAllPrivateMemoryLines(character, limit),
        ...getLocalGroupMemoryLines(character, currentGroup, limit),
    ].slice(-limit);
    if (!lines.length) return '';
    return [
        '可参考的私聊/其他群聊记录（只是记忆，不是当前刚发生的新消息，不要逐字复述）：',
        ...lines,
    ].join('\n');
}

async function buildPrivateBridgePrompt() {
    if (state.orchestrator.active) return '';
    const ctx = getContext();
    if (ctx.groupId) return '';
    const characterId = ctx.characterId ?? this_chid;
    if (characterId === null || characterId === undefined || characterId < 0) return '';
    const character = characters[characterId];
    if (!character?.avatar) return '';

    const lines = [];
    for (const group of state.localGroups) {
        const limit = Math.max(0, Math.min(30, Number(group?.injectLimit) || 0));
        if (!limit || !Array.isArray(group.members) || !group.members.includes(character.avatar)) continue;
        const recent = (group.messages || [])
            .filter(message => message && !message.is_system && normalizeText(message.mes))
            .slice(-limit);
        for (const message of recent) {
            const line = formatMemoryLine(message, character.name);
            if (line) lines.push(`[${group.name || group.id}] ${line}`);
        }
    }

    if (!lines.length) return '';
    return [
        '[ChatPulse 共享群聊记忆]',
        `下面是 ${character.name} 参与过的 ChatPulse 独立群聊最近记录。把它当作背景记忆，不要当成用户刚发来的新消息，也不要逐字复述。`,
        ...lines.slice(-30),
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

async function createStGroup(name, memberAvatars) {
    const cleanMembers = [...new Set(memberAvatars)].filter(Boolean);
    if (cleanMembers.length === 0) throw new Error('至少选择一个角色。');
    const group = {
        id: `cpgl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: normalizeText(name) || `ChatPulse Group: ${cleanMembers.map(avatar => getCharacterByAvatar(avatar)?.name || avatar).join(', ')}`,
        members: cleanMembers,
        avatar_url: getCharacterByAvatar(cleanMembers[0])?.avatar || 'img/ai4.png',
        disabled_members: [],
        messages: [],
        redPackets: [],
        debugLogs: [],
        injectLimit: 0,
        contextLimit: getSettings().contextLimit,
        noChain: false,
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
    const packet = buildRedPacketPacket({
        group,
        senderIndex: -1,
        senderAvatar: 'user',
        senderName: getUserName(),
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
        name: getUserName(),
        avatar: 'user',
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
    const claimerId = claimer.avatar || claimer.id || claimer.name || 'user';
    if (packet.claims.some(claim => claim.claimerId === claimerId)) return null;
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
    state.orchestrator.currentInstruction = instruction;
    state.typing = [{ id: character.avatar, name: character.name }];
    renderTypingIndicator();
    try {
        const history = getRecentVisibleMessages(group.contextLimit || getSettings().contextLimit)
            .map(message => {
                return formatMemoryLine(message);
            })
            .filter(Boolean)
            .join('\n');
        const characterCard = buildCharacterCardBlock(character);
        const userPersona = buildUserPersonaBlock();
        const worldInfoBlock = await buildCharacterWorldInfoBlock(character, `${history}\n${characterCard}\n${userPersona}\n${instruction}`);
        const crossChatMemory = await buildCrossChatMemoryBlock(character, group);
        const prompt = [
            '你将生成一条群聊消息。',
            `群名：${group.name}`,
            `你现在扮演：${character.name}`,
            `群成员：${getGroupCharacters(group).map(({ character: item }) => item.name).join('、')}`,
            characterCard ? `当前角色卡设定：\n${characterCard}` : '',
            userPersona,
            worldInfoBlock,
            crossChatMemory,
            getSettings().includeLocalPreset ? `附加约束（不要复述这些字）：${getSettings().localPreset || DEFAULT_SETTINGS.localPreset}` : '',
            instruction ? `发言顺序提示：${instruction}` : '',
            buildRedPacketStatePrompt(),
            `最近聊天：\n${history || '暂无'}`,
            '',
            `身份边界：你只能作为 ${character.name} 发言。${getUserName()} 是用户，不是你；其他群成员也不是你。`,
            '最近聊天只是上下文记录，不是剧本续写模板。不要替用户或其他角色写台词，不要输出“某某: 内容”的多说话人格式。',
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
        let redPacketSends = parseRedPacketSends(raw);
        let sanitized = applyLocalRegex(sanitizeLocalReply(raw, character.name));
        let retried = false;
        if (redPacketSends.length === 0 && shouldRetryLocalReply(raw, sanitized, character.name)) {
            retried = true;
            const retryPrompt = [
                `你只能扮演：${character.name}`,
                `${getUserName()} 是用户，不是你。不要用用户口吻说话。不要替其他群成员写台词。`,
                `角色：${character.name}`,
                characterCard ? `角色卡：\n${characterCard}` : '',
                userPersona,
                worldInfoBlock,
                `最近聊天：\n${history || '暂无'}`,
                '只写一条这个角色会发出的群聊消息。不要解释，不要草稿，不要自我修订，不要写标签，不要写“名字: 台词”的剧本格式。',
            ].filter(Boolean).join('\n');
            raw = await generateQuietPromptWithBackoff({
                ...requestOptions,
                quietPrompt: retryPrompt,
                responseLength: Math.max(1200, Math.floor((Number(getSettings().responseLength) || DEFAULT_SETTINGS.responseLength) / 2)),
            });
            redPacketSends = parseRedPacketSends(raw);
            sanitized = applyLocalRegex(sanitizeLocalReply(raw, character.name));
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
        return {
            dropped,
            packets: createdPackets,
        };
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
        const postRoundJobs = consumePostRoundMentionJobs(primaryOrder, processedPostRoundKeys);
        if (postRoundJobs.length === 0) break;
        for (const job of postRoundJobs) {
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

    try {
        for (const characterIndex of order) {
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

    try {
        for (const characterIndex of order) {
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
    state.orchestrator.currentSourceIndex = appendLocalMessage(group, {
        is_user: true,
        name: getUserName(),
        avatar: 'user',
        mes: text,
    });
    state.orchestrator.postRoundMentions = [];
    state.orchestrator.redPacketEvents = [];
    state.orchestrator.activeRedPacketId = null;

    try {
        let activeOrder = [...order];
        let interruptedByRedPacket = false;
        for (let i = 0; i < order.length; i += 1) {
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
                const instruction = buildRedPacketReactInstruction(packet);
                await generateForcedMember(characterIndex, instruction);
                autoClaimAvailablePackets(characterIndex);
                processRedPacketFromLatestMessage(characterIndex);
            }
        }

        await processPostRoundMentionQueue(order);

        for (const packet of state.orchestrator.redPacketEvents) {
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

function renderSettings() {
    if ($('#chatpulse_group_logic_settings').length) return;
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
    renderOrchestratedEntry();
    renderManagerShell();
    bindSettingsEvents();
    refreshStatus();
}

function renderOrchestratedEntry() {
    if ($('#cpgl_launcher').length) return;
    const html = `
    <button id="cpgl_launcher" type="button" title="ChatPulse 群聊">
        <span class="cpgl-launcher-mark">群</span>
        <span class="cpgl-launcher-text">群聊</span>
    </button>`;
    $('body').append(html);
}

function renderManagerShell() {
    if ($('#cpgl_manager_modal').length) return;
    const html = `
    <div id="cpgl_manager_modal" class="cpgl-modal-backdrop" style="display:none;">
        <div class="cpgl-app-shell">
            <nav class="cpgl-sidebar-nav">
                <button class="cpgl-nav-item active" type="button" title="群聊">群</button>
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
                            <button id="cpgl_manage_toggle" type="button" title="群管理">⚙</button>
                        </div>
                    </header>
                    <div id="cpgl_chat_messages" class="cpgl-chat-messages"></div>
                    <div id="cpgl_typing_indicator" class="cpgl-typing-indicator" style="display:none;"></div>
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
                        <h4>群成员 <span id="cpgl_member_count">(0)</span></h4>
                        <div id="cpgl_current_members" class="cpgl-list"></div>
                        <div class="cpgl-row cpgl-add-row">
                            <select id="cpgl_add_member_select"></select>
                            <button id="cpgl_add_member" class="menu_button">拉人</button>
                        </div>
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
                                <span>📥 注入私聊/其他群的消息条数</span>
                                <strong id="cpgl_drawer_inject_value">0</strong>
                            </div>
                            <input id="cpgl_drawer_inject_limit" type="range" min="0" max="30" step="1">
                            <p>本群消息注入私聊和其他群聊的条数。0 = 关闭注入。</p>
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
    $('#cpgl_chat_subtitle').text(`${(group.members || []).length} 个成员 | 无 @ 随机轮询，@角色 点名优先`);
    const rows = getRecentVisibleMessages(80).map(message => {
        if (message.is_system) {
            const systemText = stripTags(message.mes).replace(/^\[System\]\s*/i, '').trim();
            return systemText ? `<div class="cpgl-system-message">${escapeHtml(systemText)}</div>` : '';
        }
        const isUser = !!message.is_user;
        const speaker = isUser ? getUserName() : getMessageSpeaker(message) || 'Unknown';
        const character = isUser ? null : characters.find(item => item.name === speaker);
        const avatarUrl = isUser ? getUserAvatarUrl() : getCharacterAvatarUrl(character);
        const packetId = parseRedPacketMessage(message.mes);
        const packet = packetId ? getRedPacket(packetId) : null;
        const content = isUser ? stripTags(message.mes) : sanitizeLocalReply(message.mes, speaker);
        if (!content && !packet) return '';
        const bubble = packet ? renderRedPacketCard(packet, isUser) : `<div class="cpgl-message-bubble">${escapeHtml(content)}</div>`;
        return `
            <div class="cpgl-message-wrapper ${isUser ? 'user' : 'character'}">
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
    if (container) container.scrollTop = container.scrollHeight;
}

function renderRedPacketCard(packet, isUser = false) {
    const claims = Array.isArray(packet.claims) ? packet.claims : [];
    const claimed = packet.count - packet.remaining;
    const userClaimed = claims.some(claim => claim.claimerId === 'user');
    const isExpired = packet.remaining <= 0;
    const claimRows = claims.map(claim => `
        <div class="cpgl-redpacket-claim-row">
            <span>${escapeHtml(claim.claimerName || 'Unknown')}</span>
            <strong>¥${Number(claim.amount || 0).toFixed(2)}</strong>
        </div>
    `).join('');
    const canClaim = !isExpired && !userClaimed && !isUser;
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
    loadLocalState();
    renderManagerModal();
    $('#cpgl_manager_modal').css('display', 'flex');
}

async function openGroupConversation(groupId) {
    await openManagedGroup(groupId);
    renderManagerModal();
}

function renderManagerModal() {
    if (!$('#cpgl_manager_modal').length) return;
    const createSearch = String($('#cpgl_create_search').val() || '').toLowerCase();
    const createCandidates = characters.filter(character => (character.name || character.avatar || '').toLowerCase().includes(createSearch));
    $('#cpgl_create_members').html(createCandidates.map(character => characterOptionHtml(character, state.createMemberAvatars.has(character.avatar))).join(''));

    const groupRows = state.localGroups.map(group => {
        const firstMember = getCharacterByAvatar((group.members || [])[0]);
        const names = (group.members || []).map(avatar => getCharacterByAvatar(avatar)?.name || avatar).join('、');
        const isActive = getCurrentGroup()?.id === group.id;
        return `
            <button class="cpgl-chat-list-item cpgl-open-group ${isActive ? 'active' : ''}" type="button" data-group-id="${escapeHtml(group.id)}">
                <img src="${escapeHtml(getCharacterAvatarUrl(firstMember))}" alt="">
                <div>
                    <strong>${escapeHtml(group.name || group.id)}</strong>
                    <span>${escapeHtml(names || '无成员')}</span>
                </div>
            </button>`;
    }).join('');
    $('#cpgl_group_list').html(groupRows || '<div class="cpgl-list-empty">还没有群聊。</div>');

    const group = getCurrentGroup();
    if (!group) {
        $('#cpgl_current_members').html('<div class="cpgl-hint">当前没有打开群聊。</div>');
        $('#cpgl_add_member_select').html('');
        $('#cpgl_group_name_input').val('');
        $('#cpgl_member_count').text('(0)');
        renderRedPacketList();
        renderChatMessages();
        renderDebugLogs();
        return;
    }
    $('#cpgl_group_name_input').val(group.name || '');
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
        const claims = packet.claims.map(claim => `${claim.claimerName} ${claim.amount.toFixed(2)}`).join('、') || '暂无领取';
        const canUserClaim = packet.remaining > 0 && !packet.claims.some(claim => claim.claimerId === 'user');
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

function bindSettingsEvents() {
    $('#cpgl_enabled').on('change', event => {
        getSettings().enabled = event.target.checked;
        getSettings().orchestratedEntry = event.target.checked;
        saveSettings();
        refreshStatus();
    });
    $('#cpgl_context_limit').on('input', event => {
        getSettings().contextLimit = Math.max(4, Math.min(80, Number(event.target.value) || DEFAULT_SETTINGS.contextLimit));
        getMetadata().contextLimit = getSettings().contextLimit;
        saveSettings();
        saveMetadata();
        refreshStatus();
    });
    $('#cpgl_open_center_settings').on('click', openGroupCenter);
    $('#cpgl_launcher').on('click', openGroupCenter);
    $('#cpgl_manager_close').on('click', () => $('#cpgl_manager_modal').hide());
    $('#cpgl_show_create').on('click', () => $('#cpgl_create_modal').css('display', 'flex'));
    $('#cpgl_mobile_create_group').on('click', () => $('#cpgl_create_modal').css('display', 'flex'));
    $('#cpgl_chat_messages').on('click', '#cpgl_empty_create_group', () => $('#cpgl_create_modal').css('display', 'flex'));
    $('#cpgl_create_modal_close').on('click', () => $('#cpgl_create_modal').hide());
    $('#cpgl_create_modal').on('click', event => {
        if (event.target.id === 'cpgl_create_modal') $('#cpgl_create_modal').hide();
    });
    $('#cpgl_create_search').on('input', renderManagerModal);
    $('#cpgl_create_members').on('change', 'input[type="checkbox"]', event => {
        if (event.target.checked) {
            state.createMemberAvatars.add(event.target.value);
        } else {
            state.createMemberAvatars.delete(event.target.value);
        }
    });
    $('#cpgl_manage_toggle').on('click', () => $('#cpgl_manage_drawer').toggleClass('is-open'));
    $('#cpgl_manage_close').on('click', () => $('#cpgl_manage_drawer').removeClass('is-open'));
    renderEmojiPicker();
    $('#cpgl_emoji_toggle').on('click', () => {
        hideMentionMenu();
        $('#cpgl_emoji_picker').toggle();
    });
    $('#cpgl_emoji_picker').on('click', '.cpgl-emoji-item', event => {
        addEmojiToComposer(event.currentTarget.dataset.emoji || event.currentTarget.textContent || '');
    });
    $('#cpgl_emoji_picker').on('click', '#cpgl_emoji_close', hideEmojiPicker);
    $('#cpgl_quick_redpacket').on('click', () => {
        const group = getCurrentGroup();
        if (!group) {
            toastr.warning('请先进入一个群聊。');
            return;
        }
        $('#cpgl_user_packet_count').val(Math.max(1, (group.members || []).length));
        updatePacketPreview();
        $('#cpgl_redpacket_modal').css('display', 'flex');
        $('#cpgl_user_packet_amount').trigger('focus');
    });
    $('#cpgl_redpacket_close').on('click', () => $('#cpgl_redpacket_modal').hide());
    $('#cpgl_redpacket_modal').on('click', event => {
        if (event.target.id === 'cpgl_redpacket_modal') $('#cpgl_redpacket_modal').hide();
    });
    $('#cpgl_packet_lucky').on('click', () => {
        $('#cpgl_packet_lucky').addClass('active');
        $('#cpgl_packet_fixed').removeClass('active');
        updatePacketPreview();
    });
    $('#cpgl_packet_fixed').on('click', () => {
        $('#cpgl_packet_fixed').addClass('active');
        $('#cpgl_packet_lucky').removeClass('active');
        updatePacketPreview();
    });
    $('#cpgl_user_packet_amount').on('input', updatePacketPreview);
    $('#cpgl_user_packet_count').on('input', updatePacketPreview);
    $('#cpgl_rename_group').on('click', async () => {
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
    });
    $('#cpgl_group_name_input').on('keydown', event => {
        if (event.key === 'Enter') $('#cpgl_rename_group').trigger('click');
    });
    $('#cpgl_drawer_no_chain').on('change', async event => {
        const group = getCurrentGroup();
        if (!group) return;
        group.noChain = event.target.checked;
        saveLocalState();
        refreshStatus();
    });
    $('#cpgl_drawer_inject_limit').on('input', async event => {
        const group = getCurrentGroup();
        if (!group) return;
        group.injectLimit = Math.max(0, Math.min(30, Number(event.target.value) || 0));
        $('#cpgl_drawer_inject_value').text(group.injectLimit);
        saveLocalState();
    });
    $('#cpgl_drawer_context_limit').on('input', async event => {
        const group = getCurrentGroup();
        if (!group) return;
        const value = Math.max(4, Math.min(80, Number(event.target.value) || DEFAULT_SETTINGS.contextLimit));
        group.contextLimit = value;
        $('#cpgl_drawer_context_value').text(value);
        saveLocalState();
        refreshStatus();
    });
    $('#cpgl_api_base_delay').on('input', event => {
        getSettings().apiDelayBaseMs = Math.max(0, Number(event.target.value) || 0);
        $('#cpgl_api_base_value').text(formatSeconds(getSettings().apiDelayBaseMs));
        saveSettings();
    });
    $('#cpgl_api_step_delay').on('input', event => {
        getSettings().apiDelayStepMs = Math.max(0, Number(event.target.value) || 0);
        $('#cpgl_api_step_value').text(formatSeconds(getSettings().apiDelayStepMs));
        saveSettings();
    });
    $('#cpgl_api_max_delay').on('input', event => {
        getSettings().apiDelayMaxMs = Math.max(3000, Number(event.target.value) || DEFAULT_SETTINGS.apiDelayMaxMs);
        $('#cpgl_api_max_value').text(formatSeconds(getSettings().apiDelayMaxMs));
        saveSettings();
    });
    $('#cpgl_response_length').on('input', event => {
        getSettings().responseLength = Math.max(500, Math.min(6000, Number(event.target.value) || DEFAULT_SETTINGS.responseLength));
        $('#cpgl_response_length_value').text(getSettings().responseLength);
        saveSettings();
    });
    $('#cpgl_local_preset').on('input', event => {
        getSettings().localPreset = String(event.target.value || '');
        saveSettings();
    });
    $('#cpgl_include_local_preset').on('change', event => {
        getSettings().includeLocalPreset = event.target.checked;
        saveSettings();
    });
    $('#cpgl_local_regex').on('input', event => {
        getSettings().localRegex = String(event.target.value || '');
        saveSettings();
    });
    $('#cpgl_import_preset_regex').on('click', () => $('#cpgl_import_file').trigger('click'));
    $('#cpgl_import_file').on('change', async event => {
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
    });
    $('#cpgl_clear_queue_danger').on('click', () => {
        state.pendingMentionJobs = [];
        state.orchestrator.postRoundMentions = [];
        toastr.info('队列已清空。', 'ChatPulse Group Logic');
    });
    $('#cpgl_clear_messages_danger').on('click', () => {
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
        clearRuntimeState();
        saveLocalState();
        renderManagerModal();
        toastr.success('对话记录已删除。', 'ChatPulse Group Logic');
    });
    $('#cpgl_clear_debug_logs').on('click', () => {
        const group = getCurrentGroup();
        if (!group) return;
        group.debugLogs = [];
        saveLocalState();
        renderDebugLogs();
        toastr.info('调试记录已清空。', 'ChatPulse Group Logic');
    });
    $('#cpgl_typing_indicator').on('click', '#cpgl_interrupt_generation', () => {
        state.typing = [];
        state.pendingMentionJobs = [];
        renderTypingIndicator();
        toastr.info('已打断弹窗内队列。', 'ChatPulse Group Logic');
    });
    $('#cpgl_manager_modal').on('click', event => {
        if (event.target.id === 'cpgl_manager_modal') $('#cpgl_manager_modal').hide();
    });
    $('#cpgl_create_group').on('click', async () => {
        try {
            const avatars = [...state.createMemberAvatars];
            await createStGroup(String($('#cpgl_new_group_name').val() || ''), avatars);
            $('#cpgl_new_group_name').val('');
            $('#cpgl_create_search').val('');
            state.createMemberAvatars.clear();
            $('#cpgl_create_modal').hide();
            renderManagerModal();
            refreshStatus();
        } catch (error) {
            toastr.error(error.message || String(error), 'ChatPulse Group Logic');
        }
    });
    $('#cpgl_group_list').on('click', '.cpgl-open-group', async event => {
        try {
            await openGroupConversation(event.currentTarget.dataset.groupId);
        } catch (error) {
            toastr.error(error.message || String(error), 'ChatPulse Group Logic');
        }
    });
    $('#cpgl_current_members').on('click', '.cpgl-kick-member', async event => {
        try {
            const group = getCurrentGroup();
            if (!group) return;
            await removeMemberFromGroup(group.id, event.currentTarget.dataset.avatar);
        } catch (error) {
            toastr.error(error.message || String(error), 'ChatPulse Group Logic');
        }
    });
    $('#cpgl_add_member').on('click', async () => {
        try {
            const group = getCurrentGroup();
            const avatar = String($('#cpgl_add_member_select').val() || '');
            if (!group || !avatar) return;
            await addMembersToGroup(group.id, [avatar]);
        } catch (error) {
            toastr.error(error.message || String(error), 'ChatPulse Group Logic');
        }
    });
    $('#cpgl_user_packet_send').on('click', async () => {
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
    });
    $('#cpgl_red_packet_list').on('click', '.cpgl-claim-packet', event => {
        const result = claimRedPacket(event.currentTarget.dataset.packetId, { avatar: 'user', name: getUserName() });
        if (result) toastr.success(`抢到 ${result.amount.toFixed(2)}`, 'ChatPulse Group Logic');
    });
    $('#cpgl_chat_messages').on('click', '.cpgl-claim-packet', event => {
        event.stopPropagation();
        const result = claimRedPacket(event.currentTarget.dataset.packetId, { avatar: 'user', name: getUserName() });
        if (result) toastr.success(`抢到 ${result.amount.toFixed(2)}`, 'ChatPulse Group Logic');
    });
    $('#cpgl_entry_send').on('click', () => {
        const text = $('#cpgl_entry_text').val();
        $('#cpgl_entry_text').val('');
        hideMentionMenu();
        hideEmojiPicker();
        runOrchestratedRound(text);
    });
    $('#cpgl_entry_text').on('input click keyup', event => {
        if (event.type === 'keyup' && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
        updateMentionMenuFromInput(event.currentTarget);
    });
    $('#cpgl_entry_text').on('keydown', event => {
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
    });
    $('#cpgl_mention_menu').on('mousedown', '.cpgl-mention-item', event => {
        event.preventDefault();
        chooseMention(Number(event.currentTarget.dataset.index) || 0);
    });
}

function refreshStatus() {
    const meta = getMetadata();
    const group = getCurrentGroup();
    const settings = getSettings();
    const lines = [
        `入口：${settings.enabled && settings.orchestratedEntry ? '显示' : '隐藏'}`,
        group ? `当前独立群：${group.name || group.id}` : '未打开独立群聊',
        `默认上下文：${Number(settings.contextLimit) || DEFAULT_SETTINGS.contextLimit} 条`,
    ];
    $('#cpgl_status').text(lines.join(' | '));
    $('#cpgl_launcher').toggle(!!settings.enabled && !!settings.orchestratedEntry);
    renderManagerModal();
}

function registerEvents() {
    eventSource.on(event_types.MESSAGE_SENT, onUserMessage);
    eventSource.on(event_types.MESSAGE_RECEIVED, onAssistantMessage);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearPrivateMemoryCache();
        clearRuntimeState();
        setTimeout(refreshStatus, 250);
    });
    eventSource.on(event_types.APP_READY, () => {
        renderSettings();
        refreshStatus();
    });
}

registerEvents();

console.log('[ChatPulseGroupLogic] loaded');
