'use strict';

const assert = require('assert');
const poll = require('../functions/schedulePoll');

const NOW = Date.parse('2026-10-30T15:00:00.000Z');
const SNOWFLAKE = /\d{17,}/;

describe('schedule poll', function () {
  it('reads clocks, close times, and zones', function () {
    assert.deepStrictEqual(poll.parseTimes('4pm, 19, 7:30 pm'), [
      { hour: 16, minute: 0 },
      { hour: 19, minute: 0 },
      { hour: 19, minute: 30 }
    ]);
    assert.deepStrictEqual(poll.parseTimes('16 22'), [{ hour: 16, minute: 0 }, { hour: 22, minute: 0 }]);
    assert.deepStrictEqual(poll.parseTimes(''), poll.DEFAULT_HOURS.map((clock) => ({ hour: clock.hour, minute: clock.minute })));
    assert.throws(() => poll.parseTimes('noon'), (error) => error.status === 400);
    assert.strictEqual(poll.parseCloses('in 2 hours', NOW), NOW + 2 * 60 * 60 * 1000);
    assert.strictEqual(poll.parseCloses('', NOW), NOW + poll.DEFAULT_CLOSE_MS);
    assert.throws(() => poll.parseCloses('in 5 minutes', NOW), (error) => error.status === 400 && /15 minutes/.test(error.message));
    assert.strictEqual(poll.resolveZone('', 'America/Chicago'), 'America/Chicago');
    assert.throws(() => poll.resolveZone('Central'), (error) => error.status === 400);
  });

  it('splits names, handles, and mentions', function () {
    const parsed = poll.parseAudience('<@111111111111111111> <@&222222222222222222> Kersa, Rat Grot, @pilot');
    assert.deepStrictEqual(parsed.userIds, ['111111111111111111']);
    assert.deepStrictEqual(parsed.roleIds, ['222222222222222222']);
    assert.deepStrictEqual(parsed.queries, [{ handle: 'Kersa' }, { name: 'Rat Grot' }, { handle: 'pilot' }]);
    assert.deepStrictEqual(poll.parseAudience('@kersa @ratgrot').queries, [{ handle: 'kersa' }, { handle: 'ratgrot' }]);
  });

  it('matches one member and refuses an ambiguous name', function () {
    const members = [
      poll.memberEntry({ user: { id: '1', username: 'kersa', global_name: 'Kersa' } }),
      poll.memberEntry({ user: { id: '2', username: 'ratgrot', global_name: 'Rat' } }),
      poll.memberEntry({ user: { id: '3', username: 'rat2', global_name: 'Rat' } })
    ];
    assert.strictEqual(poll.matchQuery({ handle: 'kersa' }, members).member.id, '1');
    assert.strictEqual(poll.matchQuery({ name: 'Rat Grot' }, [
      poll.memberEntry({ nick: 'Rat Grot', user: { id: '9', username: 'rg' } })
    ]).member.id, '9');
    const ambiguous = poll.matchQuery({ name: 'Rat' }, members);
    assert.strictEqual(ambiguous.ambiguous.length, 2);
    assert.match(poll.ambiguousMessage(ambiguous), /ratgrot/);
    assert.ok(poll.matchQuery({ handle: 'nobody' }, members).missing);
    assert.ok(poll.memberEntry({ user: { id: '8', username: 'bot', bot: true } }).bot);
  });

  it('places 7pm Central before and after the autumn clock change', function () {
    const summer = poll.generateSlots({
      now: NOW,
      zone: 'America/Chicago',
      days: 1,
      hours: [{ hour: 19, minute: 0 }],
      lengthMs: 2 * 60 * 60 * 1000,
      notBefore: NOW
    });
    assert.strictEqual(summer.slots.length, 1);
    assert.strictEqual(summer.slots[0].id, '00');
    assert.strictEqual(summer.slots[0].start, '2026-10-31T00:00:00.000Z');
    assert.strictEqual(summer.slots[0].end, '2026-10-31T02:00:00.000Z');
    assert.match(summer.slots[0].label, /Oct 30/);
    assert.match(summer.slots[0].label, /7:00/);

    const winter = poll.generateSlots({
      now: Date.parse('2026-11-02T15:00:00.000Z'),
      zone: 'America/Chicago',
      days: 1,
      hours: [{ hour: 19, minute: 0 }],
      lengthMs: 2 * 60 * 60 * 1000,
      notBefore: Date.parse('2026-11-02T15:00:00.000Z')
    });
    assert.strictEqual(winter.slots[0].start, '2026-11-03T01:00:00.000Z');
  });

  it('keeps only times after the poll closes, and caps the menu at 25', function () {
    const generated = poll.generateSlots({
      now: NOW,
      zone: 'America/Chicago',
      days: 2,
      hours: [{ hour: 16, minute: 0 }, { hour: 19, minute: 0 }],
      lengthMs: 60 * 60 * 1000,
      notBefore: NOW + 24 * 60 * 60 * 1000
    });
    assert.ok(generated.slots.every((slot) => Date.parse(slot.start) > NOW + 24 * 60 * 60 * 1000));
    assert.ok(!generated.truncated);

    const many = poll.generateSlots({
      now: NOW,
      zone: 'America/Chicago',
      days: 14,
      hours: poll.parseTimes('0 3 6 9 12 15 18 21'),
      lengthMs: 60 * 60 * 1000,
      notBefore: NOW
    });
    assert.strictEqual(many.slots.length, 25);
    assert.strictEqual(many.truncated, true);
  });

  it('ranks the times the most people share, earlier first on a tie', function () {
    const ranked = poll.rankOverlaps({
      slots: [
        { id: '00', start: '2026-11-01T00:00:00.000Z', end: '2026-11-01T02:00:00.000Z', label: 'later' },
        { id: '01', start: '2026-10-31T00:00:00.000Z', end: '2026-10-31T02:00:00.000Z', label: 'earlier' },
        { id: '02', start: '2026-10-31T03:00:00.000Z', end: '2026-10-31T05:00:00.000Z', label: 'alone' }
      ],
      votes: {
        a: { name: 'Kersa', slots: ['00', '01', '01'] },
        b: { name: 'Pilot', slots: ['00'] },
        c: { name: 'Rat', slots: ['02'] }
      }
    });
    assert.deepStrictEqual(ranked.map((slot) => slot.id), ['00', '01', '02']);
    assert.strictEqual(ranked[0].count, 2);
    assert.deepStrictEqual(ranked[0].names, ['Kersa', 'Pilot']);
    assert.strictEqual(ranked[2].count, 1);
  });

  it('lets a named person or a role holder answer, and keeps ids off the messages', function () {
    const record = {
      id: 'abcdef012345',
      title: 'Friday Fights',
      guildName: 'G00N SQUAD',
      creatorName: 'Referee',
      zone: 'America/Chicago',
      lengthMs: 2 * 60 * 60 * 1000,
      closesAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
      people: [{ id: '111111111111111111', name: 'Kersa' }, { id: '222222222222222222', name: 'Rat' }],
      roles: [{ id: '777777777777777777', name: 'Pilots' }],
      slots: [{ id: '00', start: '2026-10-31T00:00:00.000Z', end: '2026-10-31T02:00:00.000Z', label: 'Fri, Oct 30, 7:00 PM CDT' }],
      votes: { '111111111111111111': { name: 'Kersa', slots: ['00'] } },
      result: [{ id: '00', start: '2026-10-31T00:00:00.000Z', end: '2026-10-31T02:00:00.000Z', label: 'Fri, Oct 30, 7:00 PM CDT', count: 1, names: ['Kersa'] }],
      truncated: false
    };
    assert.strictEqual(poll.canVote(record, '111111111111111111', []), true);
    assert.strictEqual(poll.canVote(record, '555555555555555555', ['777777777777777777']), true);
    assert.strictEqual(poll.canVote(record, '333333333333333333', []), false);

    const message = poll.pollMessage(record);
    const offer = poll.offerMessage(record, 'G00N SQUAD');
    const draft = poll.eventDraft(record, record.slots[0]);
    const shown = JSON.stringify(message) + JSON.stringify(offer) + draft.description;
    assert.ok(!SNOWFLAKE.test(shown), shown);
    assert.match(message.content, /Friday Fights/);
    assert.match(message.content, /\*\*Pilots\*\*/);
    assert.strictEqual(message.components[0].components[0].custom_id, 'sched:vote:abcdef012345');
    assert.strictEqual(message.components[0].components[0].options[0].value, '00');
    assert.strictEqual(offer.components[0].components[0].custom_id, 'sched:pick:abcdef012345:00');
    assert.strictEqual(offer.components[0].components[1].custom_id, 'sched:skip:abcdef012345');
    assert.match(offer.content, /Haven’t answered: Rat/);
    assert.match(draft.description, /Can make it: Kersa/);
    assert.strictEqual(draft.entityType, 3);
    assert.strictEqual(draft.location, 'G00N SQUAD');
    assert.strictEqual(poll.eventDraft(Object.assign({}, record, { voice: { id: '4', name: 'Ops', type: 2 } }), record.slots[0]).entityType, 2);
    assert.strictEqual(poll.eventDraft(Object.assign({}, record, { voice: { id: '4', name: 'Stage', type: 13 } }), record.slots[0]).entityType, 1);
  });
});
