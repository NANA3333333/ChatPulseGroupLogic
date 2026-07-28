import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildProactivePrompt,
    completeAutomationClaim,
    memberAutomationKey,
    normalizeMemberAutomation,
    tryClaimDueAutomation,
} from '../automation-core.js';

function countOccurrences(text, needle) {
    if (!needle) return 0;
    return String(text).split(needle).length - 1;
}

function dueRecord(overrides = {}) {
    return normalizeMemberAutomation({
        enabled: true,
        intervalMinMinutes: 10,
        intervalMaxMinutes: 60,
        prompt: '继续当前群聊场景。',
        jealousyEnabled: false,
        jealousyChance: 50,
        jealousyPrompt: '',
        nextTriggerAt: 1_000,
        lastTriggerAt: 0,
        claimOwnerId: '',
        claimEventId: '',
        claimUntil: 0,
        lastCompletedEventId: '',
        ...overrides,
    });
}

test('group × member keys isolate the same role in different groups and different roles in one group', () => {
    const groupACharacterA = memberAutomationKey('group-A', '沈砚秋.png');
    const groupACharacterB = memberAutomationKey('group-A', '弥拉·周.png');
    const groupBCharacterA = memberAutomationKey('group-B', '沈砚秋.png');

    assert.equal(groupACharacterA, memberAutomationKey('group-A', '沈砚秋.png'));
    assert.notEqual(groupACharacterA, groupACharacterB);
    assert.notEqual(groupACharacterA, groupBCharacterA);
    assert.notEqual(groupACharacterB, groupBCharacterA);

    const records = new Map([
        [groupACharacterA, dueRecord({ intervalMinMinutes: 12, intervalMaxMinutes: 18 })],
        [groupACharacterB, dueRecord({ intervalMinMinutes: 35, intervalMaxMinutes: 50 })],
        [groupBCharacterA, dueRecord({ enabled: false, intervalMinMinutes: 90, intervalMaxMinutes: 120 })],
    ]);

    assert.deepEqual(
        [
            records.get(groupACharacterA).intervalMinMinutes,
            records.get(groupACharacterA).intervalMaxMinutes,
        ],
        [12, 18],
    );
    assert.deepEqual(
        [
            records.get(groupACharacterB).intervalMinMinutes,
            records.get(groupACharacterB).intervalMaxMinutes,
        ],
        [35, 50],
    );
    assert.equal(records.get(groupBCharacterA).enabled, false);
    assert.deepEqual(
        [
            records.get(groupBCharacterA).intervalMinMinutes,
            records.get(groupBCharacterA).intervalMaxMinutes,
        ],
        [90, 120],
    );
});

test('normalization returns independent records and never shares nested claim state', () => {
    const first = dueRecord();
    const second = dueRecord();

    first.prompt = '只属于第一个群成员';
    first.claimOwnerId = 'window-A';

    assert.notStrictEqual(first, second);
    assert.equal(second.prompt, '继续当前群聊场景。');
    assert.equal(second.claimOwnerId, '');
});

test('group jealousy is folded into one proactive prompt exactly once', () => {
    const basePrompt = '根据当前聊天主动发一条消息。';
    const jealousyPrompt = '你有一点吃醋，但不要指责用户。';
    const result = buildProactivePrompt({
        basePrompt,
        jealousyEnabled: true,
        jealousyPrompt,
        recentOtherSpeaker: '弥拉·周',
    });

    assert.equal(result.jealousyApplied, true);
    assert.equal(result.suppressChains, true);
    assert.equal(result.noChain, true);
    assert.equal(countOccurrences(result.prompt, basePrompt), 1);
    assert.equal(countOccurrences(result.prompt, jealousyPrompt), 1);
    assert.match(result.prompt, /弥拉·周/);
    assert.equal(Array.isArray(result.messages), false, 'one proactive turn must not expand into a message chain');
});

test('a proactive message containing an @ mention still suppresses follow-up chains', () => {
    const result = buildProactivePrompt({
        basePrompt: '主动提醒 @弥拉·周 检查配电室，只发这一条。',
        jealousyEnabled: false,
        jealousyPrompt: '',
        recentOtherSpeaker: '',
    });

    assert.equal(result.jealousyApplied, false);
    assert.equal(result.suppressChains, true);
    assert.equal(result.noChain, true);
    assert.match(result.prompt, /@弥拉·周/);
});

test('jealousy is not injected without both an enabled setting and another recent speaker', () => {
    const disabled = buildProactivePrompt({
        basePrompt: '普通主动消息',
        jealousyEnabled: false,
        jealousyPrompt: '不应出现的嫉妒提示',
        recentOtherSpeaker: '弥拉·周',
    });
    const noOtherSpeaker = buildProactivePrompt({
        basePrompt: '普通主动消息',
        jealousyEnabled: true,
        jealousyPrompt: '也不应出现的嫉妒提示',
        recentOtherSpeaker: '',
    });

    assert.equal(disabled.jealousyApplied, false);
    assert.doesNotMatch(disabled.prompt, /不应出现的嫉妒提示/);
    assert.equal(noOtherSpeaker.jealousyApplied, false);
    assert.doesNotMatch(noOtherSpeaker.prompt, /也不应出现的嫉妒提示/);
});

test('a due event can be claimed by only one window while its lease is active', () => {
    const now = 20_000;
    const first = tryClaimDueAutomation({
        record: dueRecord(),
        now,
        ownerId: 'window-A',
        leaseMs: 30_000,
        eventId: 'group-A::shen::1000',
    });

    assert.equal(first.claimed, true);
    assert.equal(first.eventId, 'group-A::shen::1000');
    assert.equal(first.record.claimOwnerId, 'window-A');
    assert.equal(first.record.claimEventId, 'group-A::shen::1000');
    assert.ok(first.record.claimUntil > now);

    const second = tryClaimDueAutomation({
        record: first.record,
        now: now + 1,
        ownerId: 'window-B',
        leaseMs: 30_000,
        eventId: 'group-A::shen::1000',
    });

    assert.equal(second.claimed, false);
    assert.equal(second.record.claimOwnerId, 'window-A');
    assert.equal(second.record.claimEventId, 'group-A::shen::1000');
});

test('disabled, future, and already-completed events cannot be claimed', () => {
    const now = 20_000;
    const disabled = tryClaimDueAutomation({
        record: dueRecord({ enabled: false }),
        now,
        ownerId: 'window-A',
        leaseMs: 10_000,
        eventId: 'disabled-event',
    });
    const future = tryClaimDueAutomation({
        record: dueRecord({ nextTriggerAt: now + 1 }),
        now,
        ownerId: 'window-A',
        leaseMs: 10_000,
        eventId: 'future-event',
    });
    const completed = tryClaimDueAutomation({
        record: dueRecord({ lastCompletedEventId: 'completed-event' }),
        now,
        ownerId: 'window-A',
        leaseMs: 10_000,
        eventId: 'completed-event',
    });

    assert.equal(disabled.claimed, false);
    assert.equal(future.claimed, false);
    assert.equal(completed.claimed, false);
});

test('a heavily overdue timer emits one claim, then schedules only one future turn from completion time', () => {
    const now = 7_200_000;
    const result = tryClaimDueAutomation({
        record: dueRecord({
            intervalMinMinutes: 10,
            intervalMaxMinutes: 10,
            nextTriggerAt: 1_000,
        }),
        now,
        ownerId: 'window-A',
        leaseMs: 30_000,
        eventId: 'overdue-once',
    });

    assert.equal(result.claimed, true);
    assert.equal(result.eventId, 'overdue-once');
    assert.equal(result.record.nextTriggerAt, 1_000, 'claiming must preserve the stable due timestamp');
    assert.equal(Array.isArray(result.events), false, 'claim must represent one event, never a catch-up batch');

    const duplicate = tryClaimDueAutomation({
        record: result.record,
        now: now + 1,
        ownerId: 'window-B',
        leaseMs: 30_000,
        eventId: 'overdue-once',
    });
    assert.equal(duplicate.claimed, false);

    const completed = completeAutomationClaim({
        record: result.record,
        eventId: 'overdue-once',
        ownerId: 'window-A',
        now: now + 5_000,
        nextIntervalMs: 10 * 60 * 1_000,
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.record.lastCompletedEventId, 'overdue-once');
    assert.equal(completed.record.lastTriggerAt, now + 5_000);
    assert.equal(completed.record.nextTriggerAt, now + 5_000 + (10 * 60 * 1_000));
    assert.equal(completed.record.claimOwnerId, '');
    assert.equal(completed.record.claimEventId, '');
    assert.equal(completed.record.claimUntil, 0);

    const noBackfill = tryClaimDueAutomation({
        record: completed.record,
        now: now + 5_001,
        ownerId: 'window-B',
        leaseMs: 30_000,
        eventId: 'another-missed-slot',
    });
    assert.equal(noBackfill.claimed, false);
    assert.equal(noBackfill.reason, 'not_due');
});

test('completion rejects a mismatched event id without mutating the active claim', () => {
    const claimed = tryClaimDueAutomation({
        record: dueRecord(),
        now: 20_000,
        ownerId: 'window-A',
        leaseMs: 30_000,
        eventId: 'expected-event',
    });
    const completed = completeAutomationClaim({
        record: claimed.record,
        eventId: 'wrong-event',
        ownerId: 'window-A',
        now: 21_000,
        nextIntervalMs: 60_000,
    });

    assert.equal(completed.completed, false);
    assert.equal(completed.reason, 'claim_mismatch');
    assert.equal(completed.record.claimEventId, 'expected-event');
    assert.equal(completed.record.claimOwnerId, 'window-A');
});

test('an expired lease can be reclaimed, and the stale owner cannot complete the new claim', () => {
    const first = tryClaimDueAutomation({
        record: dueRecord(),
        now: 20_000,
        ownerId: 'window-A',
        leaseMs: 1_000,
        eventId: 'recoverable-event',
    });
    assert.equal(first.claimed, true);

    const takeover = tryClaimDueAutomation({
        record: first.record,
        now: first.record.claimUntil + 1,
        ownerId: 'window-B',
        leaseMs: 30_000,
        eventId: 'recoverable-event',
    });
    assert.equal(takeover.claimed, true);
    assert.equal(takeover.record.claimOwnerId, 'window-B');

    const staleCompletion = completeAutomationClaim({
        record: takeover.record,
        eventId: 'recoverable-event',
        ownerId: 'window-A',
        now: takeover.record.claimUntil - 1,
        nextIntervalMs: 60_000,
    });
    assert.equal(staleCompletion.completed, false);
    assert.equal(staleCompletion.reason, 'claim_mismatch');
    assert.equal(staleCompletion.record.claimOwnerId, 'window-B');

    const currentCompletion = completeAutomationClaim({
        record: takeover.record,
        eventId: 'recoverable-event',
        ownerId: 'window-B',
        now: takeover.record.claimUntil - 1,
        nextIntervalMs: 60_000,
    });
    assert.equal(currentCompletion.completed, true);
    assert.equal(currentCompletion.record.lastCompletedEventId, 'recoverable-event');
});
