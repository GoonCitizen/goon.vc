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

  it('groups days and clocks by the requested time zone', function () {
    const rows = FIXTURE.map(events.serializeScheduledEvent);
    const tokyo = events.buildWeekSchedule(rows, { timeZone: 'Asia/Tokyo' });
    assert.strictEqual(tokyo.days.Sunday.special[0].name, 'CAPITAL COMBAT', 'Sat 3 PM Central is Sun 5 AM Tokyo');
    assert.strictEqual(tokyo.days.Wednesday.timed[0].name, 'TRAINING WEDNESDAY', 'named weekday wins');
    assert.strictEqual(events.normalizeTimeZone('not/a_zone'), 'America/Chicago');
    assert.strictEqual(events.normalizeTimeZone('utc'), 'UTC');

    const svg = graphic.renderWeekScheduleSvg({ events: rows, timeZone: 'Asia/Tokyo' }).svg;
    assert.ok(/<text id="schedule-timezone"[^>]*>ASIA\/TOKYO<\/text>/.test(svg));
    assert.ok(svg.includes('5:00 AM'));
    assert.ok(svg.includes('Times in Japan'));
    for (const hook of ['schedule-title', 'schedule-subtitle', 'schedule-timezone', 'schedule-asof', 'schedule-legend']) {
      assert.ok(svg.includes(`<text id="${hook}"`), `<fabric-calendar> hook #${hook}`);
    }
    const central = graphic.renderWeekScheduleSvg({ events: rows }).svg;
    assert.ok(central.includes('>AMERICA/CHICAGO</text>') && central.includes('3:00 PM'));
  });

  it('stacks the week for a narrow viewport', function () {
    const rows = FIXTURE.map(events.serializeScheduledEvent);
    const rendered = graphic.renderWeekScheduleSvg({ events: rows, brand: 'permafleet' });
    const svg = rendered.svg;
    assert.strictEqual(rendered.verticalWidth, graphic.VERTICAL_WIDTH);
    assert.ok(rendered.verticalHeight > rendered.verticalWidth, 'stacked board is taller than it is wide');
    assert.ok(svg.includes(`@media (max-width: ${graphic.VERTICAL_MAX_WIDTH}px)`));
    assert.ok(svg.includes('class="layout-wide"'));
    assert.ok(/class="layout-tall"[^>]*viewBox="0 0 440 \d+"/.test(svg));
    assert.strictEqual(svg.split('id="schedule-title"').length, 2, 'wide board keeps the single title id');
    const tall = svg.slice(svg.indexOf('class="layout-tall"'), svg.lastIndexOf('</svg>'));
    assert.ok(tall.includes('MINING MONDAY'));
    assert.ok(tall.includes('data-hook="schedule-title"'));
    assert.ok(tall.includes('data-hook="schedule-timezone"'));
    assert.ok(tall.includes('data-hook="schedule-legend"'));
    assert.ok(!tall.includes('id="schedule-title"'));
    const calendar = fs.readFileSync(path.join(__dirname, '../assets/scripts/fabric-calendar.js'), 'utf8');
    assert.ok(calendar.includes(`const NARROW_MEDIA = '(max-width: ${graphic.VERTICAL_MAX_WIDTH}px)'`));
    assert.ok(calendar.includes('.layout-tall { display: block !important; }'));
  });

  it('renders the PERMAFLEET board with org chips and goon.vc footer', function () {
    const rows = FIXTURE.map(events.serializeScheduledEvent);
    const rendered = graphic.renderWeekScheduleGraphic({ events: rows, brand: 'permafleet' });
    assert.strictEqual(rendered.baseName, 'permafleet-schedule');
    assert.ok(rendered.svg.includes('WEEKLY OPS'));
    const members = require('../contracts/organizations.json').organizations.map((org) => org.displayName);
    assert.deepStrictEqual(graphic.PERMAFLEET_ORGS, members, 'chips are the PERMAFLEET member orgs');
    for (const name of members) assert.ok(rendered.svg.includes(`>${graphic.escapeXml(name.toUpperCase())}</text>`), name);
    assert.ok(!rendered.svg.includes('TURTLE BRIGADE') && !rendered.svg.includes('BLACK EXODUS'));
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
