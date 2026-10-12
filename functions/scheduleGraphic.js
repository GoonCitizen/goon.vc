'use strict';

/**
 * Week-ops infographic (SVG + standalone HTML) for G00N SQUAD or PERMAFLEET.
 * Same board as GoonCitizen `star-citizen-live/functions/goonSquadScheduleGraphic.js`.
 *
 * Regenerated from Discord Guild Scheduled Events:
 *   npm run build:schedule
 *   npm run build:schedule -- --brand goon
 *   npm run build:schedule -- --from-json FILE
 *
 * Dark industrial red/black — not the Fabric purple lettermark.
 * PERMAFLEET brand is the same board with alliance org mentions.
 * Narrow viewports get a second, stacked board (see `boardResponsiveCss`).
 */

const {
  DEFAULT_TIME_ZONE,
  WEEKDAY,
  buildWeekSchedule,
  formatEventTimes,
  normalizeTimeZone
} = require('./discordScheduledEvents');

const WIDTH = 1920;
const HEIGHT = 1080;
/** Stacked week, sized so type stays readable near a phone width. */
const VERTICAL_WIDTH = 440;
/**
 * Viewport width where the stacked board replaces the 7-column poster.
 * The calendar element uses the same query (`assets/scripts/fabric-calendar.js`).
 */
const VERTICAL_MAX_WIDTH = 760;

const INK = {
  bg: '#0c0c0d',
  panel: '#161618',
  panelAlt: '#1c1c1f',
  line: '#2c2c30',
  ink: '#f4f1ea',
  muted: '#9a9488',
  faint: '#6b665c',
  red: '#c81e1e',
  redDark: '#6e1010',
  redMid: '#9b1616',
  cream: '#e8dcc8',
  chip: '#241111',
  chipStroke: '#6e1010'
};

/**
 * Alliance member orgs called out on the PERMAFLEET board
 * (contracts/org.dot + Turtle Brigade rank path).
 * @type {readonly string[]}
 */
const PERMAFLEET_ORGS = Object.freeze([
  'G00N SQUAD',
  'Infinity Industries',
  'RAT',
  'Transgalactic Trade',
  'LEGACY',
  'Black Exodus',
  'Turtle Brigade',
  'STARJUMP'
]);

/**
 * @typedef {object} ScheduleBrand
 * @property {string} id
 * @property {string} title
 * @property {string} subtitle
 * @property {string} baseName
 * @property {string} probeTitle
 * @property {string[]} [orgs]
 */

/** @type {Record<string, ScheduleBrand>} */
const BRANDS = Object.freeze({
  goon: {
    id: 'goon',
    title: 'G00N SQUAD',
    subtitle: 'PERMAFLEET · day theme + afternoon / evening blocks · Discord scheduled events',
    baseName: 'goon-squad-schedule',
    probeTitle: 'G00N SQUAD weekly ops infographic'
  },
  permafleet: {
    id: 'permafleet',
    title: 'PERMAFLEET',
    subtitle: 'Alliance weekly ops · day theme + afternoon / evening blocks · Discord scheduled events',
    baseName: 'permafleet-schedule',
    probeTitle: 'PERMAFLEET weekly ops infographic',
    orgs: PERMAFLEET_ORGS.slice()
  }
});

/**
 * @param {string} [raw]
 * @returns {ScheduleBrand}
 */
function resolveBrand (raw) {
  const key = String(raw || 'goon').trim().toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '-');
  if (key === 'permafleet' || key === 'pf' || key === 'alliance') {
    return BRANDS.permafleet;
  }
  if (key === 'goon' || key === 'goonsquad' || key === 'g00n' || key === 'g00nsquad') {
    return BRANDS.goon;
  }
  return BRANDS.goon;
}

const DAY_SHORT = Object.freeze({
  Monday: 'MON',
  Tuesday: 'TUE',
  Wednesday: 'WED',
  Thursday: 'THU',
  Friday: 'FRI',
  Saturday: 'SAT',
  Sunday: 'SUN'
});

/**
 * @param {*} value
 * @returns {string}
 */
function escapeXml (value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @param {number} [maxLines]
 * @returns {string[]}
 */
function wrapWords (text, maxChars, maxLines = 3) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? (cur + ' ' + word) : word;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = word;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length > 3 ? (last.replace(/[,:;]+$/, '') + '…') : last;
  }
  return lines;
}

/**
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
function clockCt (iso, timeZone = DEFAULT_TIME_ZONE) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(d);
  } catch (_) {
    const times = formatEventTimes(iso);
    return times ? times.ct : '';
  }
}

/**
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
function dateCt (iso, timeZone = DEFAULT_TIME_ZONE) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric'
    }).format(d);
  } catch (_) {
    return '';
  }
}

/**
 * "Central Time", "Coordinated Universal Time", … (falls back to the IANA id).
 * @param {string} timeZone
 * @param {Date} [at]
 * @returns {string}
 */
function zoneLabel (timeZone, at = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    if (part && part.value) return part.value;
  } catch (_) { /* fall through */ }
  return timeZone;
}

/**
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
function asOfLabel (iso, timeZone = DEFAULT_TIME_ZONE) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    }).format(d);
  } catch (_) {
    return String(iso);
  }
}

/**
 * @param {string} desc
 * @param {number} [max]
 * @returns {string}
 */
function oneLine (desc, max = 46) {
  const s = String(desc || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>]/g, '')
    .replace(/:[a-z0-9_+]+:/gi, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

/**
 * @param {object} row categorizeEvent-shaped
 * @returns {string|null}
 */
function badgeFor (row) {
  if (!row) return null;
  const cadence = String(row.cadence || '').toLowerCase();
  const status = String(row.statusName || '').toLowerCase();
  const reason = String(row.reason || '').toLowerCase();
  if (status === 'active') return 'LIVE';
  if (cadence.indexOf('monthly') !== -1) return 'MONTHLY';
  if (cadence.indexOf('every 2') !== -1 || cadence.indexOf('biweek') !== -1) return 'BIWEEKLY';
  if (row.kind === 'timed') return 'TRAIN';
  if (reason.indexOf('tournament') !== -1) return 'PVP';
  if (row.kind === 'special') return 'OPS';
  return null;
}

/**
 * @param {object} day buildWeekSchedule.days[name]
 * @returns {object[]}
 */
function overlaySlots (day) {
  if (!day) return [];
  return []
    .concat(day.timed || [])
    .concat(day.special || [])
    .concat(day.other || []);
}

/**
 * Copy RSVP counts from the raw event list onto categorized rows.
 * @param {object} schedule
 * @param {Array<object>} events
 * @returns {object}
 */
function enrichSchedule (schedule, events) {
  const byId = new Map();
  for (const e of events || []) {
    if (e && e.id != null) byId.set(String(e.id), e);
  }
  const bump = (row) => {
    if (!row) return row;
    const src = byId.get(String(row.id)) || {};
    const userCount = row.userCount != null ? row.userCount : src.userCount;
    return Object.assign({}, row, {
      url: row.url || src.url || null,
      userCount: userCount != null ? Number(userCount) : null,
      statusName: row.statusName || src.statusName || null,
      description: row.description != null ? row.description : src.description
    });
  };
  const days = {};
  for (const name of WEEKDAY) {
    const src = (schedule && schedule.days && schedule.days[name]) || {
      theme: null, timed: [], special: [], other: []
    };
    days[name] = {
      theme: bump(src.theme),
      timed: (src.timed || []).map(bump),
      special: (src.special || []).map(bump),
      other: (src.other || []).map(bump)
    };
  }
  return Object.assign({}, schedule, { days });
}

function tspans (lines, x, startY, lineHeight) {
  return lines.map((line, i) => (
    `<tspan x="${x}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`
  )).join('');
}

function roundRect (x, y, w, h, r, fill, extra) {
  const rr = Math.min(r, h / 2, w / 2);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rr}" ry="${rr}" fill="${fill}"${extra ? ' ' + extra : ''}/>`;
}

/**
 * Wrap everything pushed since `start` in a link (only works when the SVG is inline).
 * @param {string[]} parts
 * @param {number} start
 * @param {string} [url]
 */
function linkBlock (parts, start, url) {
  if (!url) return;
  parts.splice(start, 0, `<a href="${escapeXml(url)}" target="_blank" rel="noopener">`);
  parts.push('</a>');
}

/**
 * Show the stacked board on a short, narrow viewport.
 * `min-height` keeps a 16:9 `<img>` on the wide poster: that box cannot be
 * both ≤760px wide and ≥480px tall. Inline calendars switch with their own
 * `@media (max-width)` rule, which does not need the height guard.
 * @returns {string}
 * @private
 */
function boardResponsiveCss () {
  return [
    '.layout-wide { display: block; }',
    '.layout-tall { display: none; }',
    `@media (max-width: ${VERTICAL_MAX_WIDTH}px) and (min-height: 480px) {`,
    '  .layout-wide { display: none !important; }',
    '  .layout-tall { display: block !important; }',
    '  .schedule-root {',
    '    width: 100vw;',
    '    height: calc(100vw * var(--board-vertical-h) / var(--board-vertical-w));',
    '  }',
    '}'
  ].join('\n');
}

/**
 * One full-width day after another, for a narrow viewport.
 * Hooks are `data-hook` (the wide board keeps the element ids).
 * `data-wrap` / `data-line` / `data-max-lines` tell `<fabric-calendar>` how to
 * reflow a label when it replaces the text.
 * @param {object} opts
 * @returns {{svg:string, width:number, height:number}}
 * @private
 */
function renderVerticalBoard (opts) {
  const W = VERTICAL_WIDTH;
  const M = 16;
  const inner = W - M * 2;
  const timeZone = opts.timeZone;
  const schedule = opts.schedule;
  const SANS = 'Helvetica Neue, Helvetica, Arial, sans-serif';
  const DISPLAY = 'Arial Black, Helvetica Neue, Helvetica, Arial, sans-serif';
  const parts = [];
  const bgAt = 0;
  parts.push('');
  parts.push(`<rect x="0" y="0" width="${W}" height="6" fill="${INK.red}"/>`);

  const guildName = String(opts.guildName || '');
  const titleSize = guildName.length > 18 ? 16 : 22;
  let y = M + titleSize + 8;
  parts.push(`<text data-hook="schedule-title" x="${M}" y="${y}" fill="${INK.ink}" font-family="${DISPLAY}" font-size="${titleSize}" letter-spacing="1.2">${escapeXml(guildName)}</text>`);

  y += 22;
  parts.push(`<text x="${M}" y="${y}" fill="${INK.red}" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="3">WEEKLY OPS</text>`);

  const subLine = 14;
  const subMax = 3;
  const subY = y + 20;
  const subLines = wrapWords(opts.subtitle || '', 40, subMax);
  const subSpans = (subLines.length ? subLines : ['']).map((line, i) => (
    `<tspan x="${M}" y="${subY + i * subLine}">${escapeXml(line)}</tspan>`
  )).join('');
  parts.push(`<text data-hook="schedule-subtitle" x="${M}" y="${subY}" data-wrap="40" data-line="${subLine}" data-max-lines="${subMax}" fill="${INK.muted}" font-family="${SANS}" font-size="12">${subSpans}</text>`);
  y = subY + subLine * (subMax - 1) + 24;

  parts.push(`<text data-hook="schedule-timezone" x="${M}" y="${y}" fill="${INK.cream}" font-family="${SANS}" font-size="14" font-weight="700">${escapeXml(timeZone.replace(/_/g, ' ').toUpperCase())}</text>`);

  const asLine = 13;
  const asMax = 2;
  const asY = y + 22;
  const asText = 'As of ' + asOfLabel(opts.fetchedAt, timeZone);
  parts.push(`<text data-hook="schedule-asof" x="${M}" y="${asY}" data-wrap="64" data-line="${asLine}" data-max-lines="${asMax}" fill="${INK.muted}" font-family="${SANS}" font-size="11">${escapeXml(asText)}</text>`);
  y = asY + asLine * (asMax - 1) + 14;

  if (opts.showOrgs && opts.orgs && opts.orgs.length) {
    const chipH = 24;
    let cx = M + 48;
    let cy = y;
    parts.push(`<text x="${M}" y="${cy + 16}" fill="${INK.faint}" font-family="${SANS}" font-size="10" font-weight="700" letter-spacing="1.4">ORGS</text>`);
    for (const org of opts.orgs) {
      const label = String(org).toUpperCase();
      const bw = Math.round(label.length * 6.6 + 16);
      if (cx + bw > W - M) {
        cx = M;
        cy += chipH + 6;
      }
      parts.push(roundRect(cx, cy, bw, chipH, 4, INK.chip, `stroke="${INK.chipStroke}" stroke-width="1"`));
      parts.push(`<rect x="${cx}" y="${cy}" width="4" height="${chipH}" fill="${INK.red}" rx="1"/>`);
      parts.push(`<text x="${cx + bw / 2 + 1}" y="${cy + 16}" text-anchor="middle" fill="${INK.cream}" font-family="${SANS}" font-size="10" font-weight="700" letter-spacing="0.4">${escapeXml(label)}</text>`);
      cx += bw + 6;
    }
    y = cy + chipH + 14;
  }

  const themeH = 100;
  const emptyThemeH = 68;
  const slotH = 108;
  const slotGap = 8;
  const dayGap = 12;

  for (const name of WEEKDAY) {
    const day = schedule.days[name];
    const theme = day.theme;
    const slots = overlaySlots(day);
    const monthly = slots.some((slot) => String(slot.cadence || '').toLowerCase().indexOf('monthly') !== -1);
    const blockH = theme ? themeH : emptyThemeH;
    const slotsBlock = slots.length
      ? (8 + slots.length * slotH + (slots.length - 1) * slotGap)
      : 0;
    const cardH = 30 + blockH + slotsBlock + 10;
    const stroke = monthly
      ? `stroke="${INK.red}" stroke-width="2"`
      : `stroke="${INK.line}" stroke-width="1"`;
    parts.push(roundRect(M, y, inner, cardH, 10, INK.panel, stroke));

    const dateSource = (theme && theme.scheduledStartTime) || (slots[0] && slots[0].scheduledStartTime);
    const dateLabel = dateCt(dateSource, timeZone);
    parts.push(`<text x="${M + 12}" y="${y + 20}" fill="${INK.faint}" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="2">${DAY_SHORT[name]}</text>`);
    if (dateLabel) {
      parts.push(`<text x="${M + inner - 12}" y="${y + 20}" text-anchor="end" fill="${INK.muted}" font-family="${SANS}" font-size="11">${escapeXml(dateLabel)}</text>`);
    }

    const tx = M + 10;
    const tw = inner - 20;
    const ty = y + 30;
    if (theme) {
      const themeStart = parts.length;
      parts.push(roundRect(tx, ty, tw, themeH, 8, INK.redDark));
      parts.push(`<rect x="${tx}" y="${ty}" width="6" height="${themeH}" fill="${INK.red}" rx="2"/>`);
      const themeLines = wrapWords(theme.name, 24, 2);
      parts.push(`<text fill="${INK.ink}" font-family="${DISPLAY}" font-size="16">${tspans(themeLines, tx + 16, ty + 28, 20)}</text>`);
      if (String(theme.statusName || '').toLowerCase() === 'active') {
        const bw = 40;
        const bx = tx + tw - 10 - bw;
        parts.push(roundRect(bx, ty + 8, bw, 18, 3, INK.red));
        parts.push(`<text x="${bx + bw / 2}" y="${ty + 21}" text-anchor="middle" fill="${INK.ink}" font-family="${SANS}" font-size="9" font-weight="700" letter-spacing="0.8">LIVE</text>`);
      }
      const tClock = clockCt(theme.scheduledStartTime, timeZone);
      parts.push(`<text x="${tx + 16}" y="${ty + themeH - 16}" fill="${INK.cream}" font-family="${SANS}" font-size="13" font-weight="700">${escapeXml(tClock || 'All day')}<tspan fill="${INK.muted}" font-weight="400"> · ${escapeXml(theme.cadence || 'weekly')}</tspan></text>`);
      linkBlock(parts, themeStart, theme.url);
    } else {
      parts.push(roundRect(tx, ty, tw, emptyThemeH, 8, INK.panelAlt, `stroke="${INK.line}" stroke-width="1" stroke-dasharray="4 4"`));
      parts.push(`<text x="${tx + 16}" y="${ty + 28}" fill="${INK.faint}" font-family="${DISPLAY}" font-size="14">NO THEME</text>`);
      parts.push(`<text x="${tx + 16}" y="${ty + 48}" fill="${INK.muted}" font-family="${SANS}" font-size="12">Open play / training only</text>`);
    }

    slots.forEach((slot, si) => {
      const sy = ty + blockH + 8 + si * (slotH + slotGap);
      const slotStart = parts.length;
      const badge = badgeFor(slot);
      const isMonthly = badge === 'MONTHLY';
      const fill = isMonthly ? '#241111' : INK.panelAlt;
      const extra = isMonthly
        ? `stroke="${INK.red}" stroke-width="1.5"`
        : `stroke="${INK.line}" stroke-width="1"`;
      parts.push(roundRect(tx, sy, tw, slotH, 8, fill, extra));
      const edge = slot.kind === 'timed' ? '#3f7d4e' : INK.red;
      parts.push(`<rect x="${tx}" y="${sy}" width="5" height="${slotH}" fill="${edge}" rx="2"/>`);
      parts.push(`<text x="${tx + 16}" y="${sy + 22}" fill="${INK.cream}" font-family="${SANS}" font-size="13" font-weight="700">${escapeXml(clockCt(slot.scheduledStartTime, timeZone))}</text>`);
      if (badge) {
        const bw = Math.round(badge.length * 7.2 + 12);
        const bx = tx + tw - 10 - bw;
        const badgeFill = badge === 'TRAIN'
          ? '#3f7d4e'
          : (badge === 'MONTHLY' || badge === 'LIVE' ? INK.red : INK.redMid);
        parts.push(roundRect(bx, sy + 8, bw, 18, 3, badgeFill));
        parts.push(`<text x="${bx + bw / 2}" y="${sy + 21}" text-anchor="middle" fill="${INK.ink}" font-family="${SANS}" font-size="9" font-weight="700" letter-spacing="0.8">${escapeXml(badge)}</text>`);
      }
      const nameLines = wrapWords(slot.name, 28, 2);
      parts.push(`<text fill="${INK.ink}" font-family="${SANS}" font-size="14" font-weight="700">${tspans(nameLines, tx + 16, sy + 46, 18)}</text>`);
      const blurb = oneLine(slot.description, 48);
      const meta = [
        dateCt(slot.scheduledStartTime, timeZone),
        slot.userCount != null && Number.isFinite(Number(slot.userCount))
          ? (slot.userCount + ' in')
          : ''
      ].filter(Boolean).join(' · ');
      if (blurb) {
        parts.push(`<text x="${tx + 16}" y="${sy + slotH - 30}" fill="${INK.muted}" font-family="${SANS}" font-size="11">${escapeXml(blurb)}</text>`);
      }
      if (meta) {
        parts.push(`<text x="${tx + 16}" y="${sy + slotH - 14}" fill="${INK.faint}" font-family="${SANS}" font-size="10">${escapeXml(meta)}</text>`);
      }
      linkBlock(parts, slotStart, slot.url);
    });

    y += cardH + dayGap;
  }

  y += 4;
  parts.push(`<rect x="${M}" y="${y}" width="${inner}" height="1" fill="${INK.line}"/>`);
  y += 20;
  parts.push(`<text data-hook="schedule-legend" x="${M}" y="${y}" fill="${INK.muted}" font-family="${SANS}" font-size="11"><tspan fill="${INK.red}">&#9608;</tspan> Theme   <tspan fill="#3f7d4e">&#9608;</tspan> Training   <tspan fill="${INK.redMid}">&#9608;</tspan> Special</text>`);
  y += M;

  parts[bgAt] = `<rect width="${W}" height="${y}" fill="${INK.bg}"/>`;
  return {
    svg: `<svg class="layout-tall" x="0" y="0" width="100%" height="100%" viewBox="0 0 ${W} ${y}" preserveAspectRatio="xMidYMid meet" style="display:none">\n${parts.join('\n')}\n</svg>`,
    width: W,
    height: y
  };
}

/**
 * Render the week board as SVG.
 * The root holds the 1920×1080 poster (`.layout-wide`) and a stacked week
 * (`.layout-tall`). A stylesheet media query picks the stacked board when the
 * SVG is opened on a narrow, tall viewport; `<fabric-calendar>` does the same
 * from its own stylesheet so the page box matches.
 * @param {object} [opts]
 * @param {object} [opts.schedule]
 * @param {Array<object>} [opts.events]
 * @param {string} [opts.fetchedAt]
 * @param {string} [opts.guildName]
 * @param {string} [opts.brand] goon | permafleet
 * @param {string[]} [opts.orgs] override alliance org labels (permafleet)
 * @param {string} [opts.subtitle] override the brand subtitle
 * @param {string} [opts.regenerateCommand] footer hint for rebuilding the board ('' hides it)
 * @param {string} [opts.timeZone] IANA zone for days and clocks (default America/Chicago)
 * @returns {{svg:string, width:number, height:number, verticalWidth:number, verticalHeight:number, brand:ScheduleBrand, timeZone:string}}
 */
function renderWeekScheduleSvg (opts = {}) {
  const events = opts.events || [];
  const timeZone = normalizeTimeZone(opts.timeZone);
  const schedule = enrichSchedule(
    opts.schedule || buildWeekSchedule(events, { timeZone }),
    events
  );
  const fetchedAt = opts.fetchedAt || schedule.generatedAt || new Date().toISOString();
  const brand = resolveBrand(opts.brand || (opts.guildName === 'PERMAFLEET' ? 'permafleet' : 'goon'));
  const guildName = opts.guildName || brand.title;
  const orgs = Array.isArray(opts.orgs) && opts.orgs.length
    ? opts.orgs.map(String).filter(Boolean)
    : (brand.orgs || []);
  const showOrgs = orgs.length > 0;

  const margin = 28;
  const headerH = showOrgs ? 148 : 112;
  const footerH = 64;
  const gap = 14;
  const inner = WIDTH - margin * 2;
  const colW = Math.floor((inner - gap * 6) / 7);
  const used = colW * 7 + gap * 6;
  const originX = margin + Math.floor((inner - used) / 2);
  // Columns start 28px above originY (weekday label row), below the header.
  const originY = margin + headerH + 36;
  const bodyH = HEIGHT - margin * 2 - headerH - footerH - 36;
  const themeH = 168;
  let maxSlots = 1;
  for (const name of WEEKDAY) {
    maxSlots = Math.max(maxSlots, overlaySlots(schedule.days[name]).length);
  }
  const slotGap = 10;
  const slotArea = bodyH - themeH - slotGap;
  const slotH = Math.max(
    108,
    Math.min(148, Math.floor((slotArea - (maxSlots - 1) * slotGap) / maxSlots))
  );

  const parts = [];
  parts.push(`<svg class="layout-wide" x="0" y="0" width="100%" height="100%" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid meet">`);
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${INK.bg}"/>`);
  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="6" fill="${INK.red}"/>`);

  parts.push(`<text id="schedule-title" x="${margin + 4}" y="${margin + 42}" fill="${INK.ink}" font-family="Arial Black, Helvetica Neue, Helvetica, Arial, sans-serif" font-size="38" letter-spacing="4">${escapeXml(guildName)}</text>`);
  parts.push(`<text x="${margin + 4}" y="${margin + 74}" fill="${INK.red}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="6">WEEKLY OPS</text>`);
  parts.push(`<text id="schedule-subtitle" x="${margin + 4}" y="${margin + 98}" fill="${INK.muted}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="13">${escapeXml(opts.subtitle || brand.subtitle)}</text>`);

  if (showOrgs) {
    const chipY = margin + 114;
    const chipH = 26;
    let chipX = margin + 4;
    parts.push(`<text x="${chipX}" y="${chipY + 18}" fill="${INK.faint}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="2">ORGS</text>`);
    chipX += 52;
    for (const org of orgs) {
      const label = String(org).toUpperCase();
      const bw = Math.round(label.length * 7.4 + 20);
      if (chipX + bw > WIDTH - margin - 280) break;
      parts.push(roundRect(chipX, chipY, bw, chipH, 4, INK.chip, `stroke="${INK.chipStroke}" stroke-width="1"`));
      parts.push(`<rect x="${chipX}" y="${chipY}" width="4" height="${chipH}" fill="${INK.red}" rx="1"/>`);
      parts.push(`<text x="${chipX + bw / 2 + 1}" y="${chipY + 17}" text-anchor="middle" fill="${INK.cream}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="0.6">${escapeXml(label)}</text>`);
      chipX += bw + 8;
    }
  }

  parts.push(`<text id="schedule-timezone" x="${WIDTH - margin}" y="${margin + 48}" text-anchor="end" fill="${INK.cream}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="16" font-weight="700">${escapeXml(timeZone.replace(/_/g, ' ').toUpperCase())}</text>`);
  parts.push(`<text id="schedule-asof" x="${WIDTH - margin}" y="${margin + 72}" text-anchor="end" fill="${INK.muted}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="13">As of ${escapeXml(asOfLabel(fetchedAt, timeZone))}</text>`);

  WEEKDAY.forEach((name, i) => {
    const x = originX + i * (colW + gap);
    const day = schedule.days[name];
    const theme = day.theme;
    const slots = overlaySlots(day);
    const monthly = slots.some((s) => String(s.cadence || '').toLowerCase().indexOf('monthly') !== -1);
    const colStroke = monthly ? `stroke="${INK.red}" stroke-width="2"` : `stroke="${INK.line}" stroke-width="1"`;

    parts.push(roundRect(x, originY - 28, colW, bodyH + 28, 10, INK.panel, colStroke));

    parts.push(`<text x="${x + 14}" y="${originY - 8}" fill="${INK.faint}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="12" font-weight="700" letter-spacing="3">${DAY_SHORT[name]}</text>`);

    const ty = originY + 8;
    const themeStart = parts.length;
    if (theme) {
      parts.push(roundRect(x + 10, ty, colW - 20, themeH, 8, INK.redDark));
      parts.push(`<rect x="${x + 10}" y="${ty}" width="6" height="${themeH}" fill="${INK.red}" rx="2"/>`);
      const themeLines = wrapWords(theme.name, 14, 3);
      parts.push(`<text fill="${INK.ink}" font-family="Arial Black, Helvetica Neue, Helvetica, Arial, sans-serif" font-size="18">${tspans(themeLines, x + 24, ty + 36, 22)}</text>`);
      const tClock = clockCt(theme.scheduledStartTime, timeZone);
      const tDate = dateCt(theme.scheduledStartTime, timeZone);
      if (String(theme.statusName || '').toLowerCase() === 'active') {
        const bw = 40;
        const bx = x + colW - 22 - bw;
        parts.push(roundRect(bx, ty + 10, bw, 18, 3, INK.red));
        parts.push(`<text x="${bx + bw / 2}" y="${ty + 23}" text-anchor="middle" fill="${INK.ink}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="9" font-weight="700" letter-spacing="0.8">LIVE</text>`);
      }
      parts.push(`<text x="${x + 24}" y="${ty + themeH - 36}" fill="${INK.cream}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="14" font-weight="700">${escapeXml(tClock || 'All day')}</text>`);
      parts.push(`<text x="${x + 24}" y="${ty + themeH - 16}" fill="${INK.muted}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="11">${escapeXml(theme.cadence || 'weekly')}${tDate ? ' · ' + escapeXml(tDate) : ''}</text>`);
      linkBlock(parts, themeStart, theme.url);
    } else {
      parts.push(roundRect(x + 10, ty, colW - 20, themeH, 8, INK.panelAlt, `stroke="${INK.line}" stroke-width="1" stroke-dasharray="4 4"`));
      parts.push(`<text x="${x + 24}" y="${ty + 48}" fill="${INK.faint}" font-family="Arial Black, Helvetica Neue, Helvetica, Arial, sans-serif" font-size="16">NO THEME</text>`);
      parts.push(`<text x="${x + 24}" y="${ty + 72}" fill="${INK.muted}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="12">Open play / training only</text>`);
    }

    slots.forEach((slot, si) => {
      const sy = ty + themeH + slotGap + si * (slotH + slotGap);
      const slotStart = parts.length;
      const badge = badgeFor(slot);
      const isMonthly = badge === 'MONTHLY';
      const fill = isMonthly ? '#241111' : INK.panelAlt;
      const extra = isMonthly
        ? `stroke="${INK.red}" stroke-width="1.5"`
        : `stroke="${INK.line}" stroke-width="1"`;
      parts.push(roundRect(x + 10, sy, colW - 20, slotH, 8, fill, extra));
      const edge = slot.kind === 'timed' ? '#3f7d4e' : INK.red;
      parts.push(`<rect x="${x + 10}" y="${sy}" width="5" height="${slotH}" fill="${edge}" rx="2"/>`);

      const clock = clockCt(slot.scheduledStartTime, timeZone);
      parts.push(`<text x="${x + 24}" y="${sy + 22}" fill="${INK.cream}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="12" font-weight="700">${escapeXml(clock)}</text>`);
      if (badge) {
        const bw = Math.round(badge.length * 7.2 + 12);
        const bx = x + colW - 20 - bw;
        const badgeFill = badge === 'TRAIN'
          ? '#3f7d4e'
          : (badge === 'MONTHLY' || badge === 'LIVE' ? INK.red : INK.redMid);
        parts.push(roundRect(bx, sy + 8, bw, 18, 3, badgeFill));
        parts.push(`<text x="${bx + bw / 2}" y="${sy + 21}" text-anchor="middle" fill="${INK.ink}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="9" font-weight="700" letter-spacing="0.8">${escapeXml(badge)}</text>`);
      }

      const nameLines = wrapWords(slot.name, 16, 2);
      parts.push(`<text fill="${INK.ink}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="14" font-weight="700">${tspans(nameLines, x + 24, sy + 46, 18)}</text>`);

      const blurb = oneLine(slot.description, 40);
      const meta = [
        dateCt(slot.scheduledStartTime, timeZone),
        slot.userCount != null && Number.isFinite(Number(slot.userCount))
          ? (slot.userCount + ' in')
          : ''
      ].filter(Boolean).join(' · ');
      const yDesc = sy + slotH - (blurb ? 32 : 16);
      if (blurb) {
        parts.push(`<text x="${x + 24}" y="${yDesc}" fill="${INK.muted}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="11">${escapeXml(blurb)}</text>`);
      }
      if (meta) {
        parts.push(`<text x="${x + 24}" y="${sy + slotH - 14}" fill="${INK.faint}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="10">${escapeXml(meta)}</text>`);
      }
      linkBlock(parts, slotStart, slot.url);
    });
  });

  const fy = HEIGHT - margin - 18;
  const orgFooter = showOrgs
    ? '   ·   Alliance orgs on the board'
    : '';
  const regenerateCommand = opts.regenerateCommand != null
    ? opts.regenerateCommand
    : `npm run build:schedule -- --brand ${brand.id}`;
  parts.push(`<rect x="${margin}" y="${HEIGHT - footerH - margin + 16}" width="${WIDTH - margin * 2}" height="1" fill="${INK.line}"/>`);
  parts.push(`<text id="schedule-legend" x="${margin + 4}" y="${fy}" fill="${INK.muted}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="12"><tspan fill="${INK.red}">&#9608;</tspan> Day theme   <tspan fill="#3f7d4e">&#9608;</tspan> Training   <tspan fill="${INK.redMid}">&#9608;</tspan> Special / ops / monthly   ·   Times in ${escapeXml(zoneLabel(timeZone))}${escapeXml(orgFooter)}${regenerateCommand ? '   ·   ' + escapeXml(regenerateCommand) : ''}</text>`);

  parts.push('</svg>');

  const vertical = renderVerticalBoard({
    schedule,
    timeZone,
    guildName,
    subtitle: opts.subtitle || brand.subtitle,
    orgs,
    showOrgs,
    fetchedAt
  });
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" class="schedule-root" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${escapeXml(guildName)} weekly ops" style="--board-wide-w:${WIDTH};--board-wide-h:${HEIGHT};--board-vertical-w:${vertical.width};--board-vertical-h:${vertical.height}">`,
    `<title>${escapeXml(guildName)} Weekly Ops</title>`,
    '<style type="text/css">',
    boardResponsiveCss(),
    '</style>',
    parts.join('\n'),
    vertical.svg,
    '</svg>'
  ].join('\n');
  return {
    svg: svg + '\n',
    width: WIDTH,
    height: HEIGHT,
    verticalWidth: vertical.width,
    verticalHeight: vertical.height,
    brand,
    timeZone
  };
}

/**
 * Self-contained HTML page wrapping the SVG (open, screenshot, or attach).
 * @param {object} [opts]
 * @returns {string}
 */
function renderWeekScheduleHtml (opts = {}) {
  const rendered = opts.svg
    ? { svg: opts.svg, width: opts.width || WIDTH, height: opts.height || HEIGHT, brand: opts.brand }
    : renderWeekScheduleSvg(opts);
  const brand = rendered.brand || resolveBrand(opts.brand);
  const title = (opts.guildName || brand.title) + ' Weekly Ops';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=${rendered.width}"/>
  <title>${escapeXml(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; background: ${INK.bg}; }
    body { display: flex; justify-content: center; }
    .board { width: ${rendered.width}px; height: ${rendered.height}px; }
    .board > svg { display: block; width: ${rendered.width}px; height: ${rendered.height}px; }
  </style>
</head>
<body>
  <div class="board">${rendered.svg.trim()}</div>
</body>
</html>
`;
}

/**
 * @param {object} [opts]
 * @returns {{svg:string, html:string, width:number, height:number, baseName:string, brand:ScheduleBrand}}
 */
function renderWeekScheduleGraphic (opts = {}) {
  const svgDoc = renderWeekScheduleSvg(opts);
  const html = renderWeekScheduleHtml(Object.assign({}, opts, svgDoc));
  return {
    svg: svgDoc.svg,
    html,
    width: svgDoc.width,
    height: svgDoc.height,
    baseName: svgDoc.brand.baseName,
    brand: svgDoc.brand
  };
}

module.exports = {
  WIDTH,
  HEIGHT,
  VERTICAL_WIDTH,
  VERTICAL_MAX_WIDTH,
  INK,
  BRANDS,
  PERMAFLEET_ORGS,
  resolveBrand,
  escapeXml,
  wrapWords,
  clockCt,
  dateCt,
  zoneLabel,
  oneLine,
  badgeFor,
  overlaySlots,
  enrichSchedule,
  renderWeekScheduleSvg,
  renderWeekScheduleHtml,
  renderWeekScheduleGraphic
};
