'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const events = require('../functions/discordScheduledEvents');
const graphic = require('../functions/scheduleGraphic');
const resolveDiscordToken = require('../functions/resolveDiscordToken');

const FIXTURE = [
  {
    id: '1',
    guild_id: '1190527980120850493',
    name: 'MINING MONDAY',
    scheduled_start_time: '2026-10-05T18:00:00.000Z',
    entity_type: 2,
    status: 1,
    recurrence_rule: { frequency: 2, interval: 1, by_weekday: [0] }
  },
  {
    id: '2',
    guild_id: '1190527980120850493',
    name: 'TRAINING WEDNESDAY',
    scheduled_start_time: '2026-10-08T00:00:00.000Z',
    entity_type: 2,
    status: 1,
    user_count: 7
  },
  {
    id: '3',
    guild_id: '1190527980120850493',
    name: 'CAPITAL COMBAT',
    scheduled_start_time: '2026-10-10T20:00:00.000Z',
    entity_type: 3,
    status: 1,
    recurrence_rule: { frequency: 1, interval: 1, by_n_weekday: [{ n: 2, day: 5 }] }
  }
];

describe('PERMAFLEET schedule', function () {
  it('categorizes themes, training, and specials onto weekdays', function () {
    const rows = FIXTURE.map(events.serializeScheduledEvent);
    const schedule = events.buildWeekSchedule(rows);
    assert.strictEqual(schedule.days.Monday.theme.name, 'MINING MONDAY');
    assert.strictEqual(schedule.days.Wednesday.timed[0].name, 'TRAINING WEDNESDAY');
    assert.strictEqual(schedule.days.Saturday.special[0].name, 'CAPITAL COMBAT');
    assert.deepStrictEqual(schedule.counts, { theme: 1, timed: 1, special: 1, total: 3 });
  });

  it('renders the PERMAFLEET board with org chips and goon.vc footer', function () {
    const rows = FIXTURE.map(events.serializeScheduledEvent);
    const rendered = graphic.renderWeekScheduleGraphic({ events: rows, brand: 'permafleet' });
    assert.strictEqual(rendered.baseName, 'permafleet-schedule');
    assert.ok(rendered.svg.includes('WEEKLY OPS'));
    assert.ok(rendered.svg.includes('TURTLE BRIGADE'));
    assert.ok(rendered.svg.includes('npm run build:schedule -- --brand permafleet'));
    assert.ok(rendered.html.startsWith('<!DOCTYPE html>'));
  });

  it('resolves the bot token from env, then secrets files', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-discord-'));
    const file = path.join(dir, 'discord.secrets.json');
    fs.writeFileSync(file, JSON.stringify({ token: 'from-file' }));
    try {
      assert.deepStrictEqual(
        resolveDiscordToken({ token: 'from-settings' }, { env: {}, candidates: [file] }),
        { token: 'from-settings', source: 'env' }
      );
      assert.deepStrictEqual(
        resolveDiscordToken({}, { env: {}, candidates: [file] }),
        { token: 'from-file', source: file }
      );
      assert.deepStrictEqual(
        resolveDiscordToken({}, { env: {}, candidates: [] }),
        { token: null, source: null }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
