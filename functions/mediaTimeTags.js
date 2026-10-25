'use strict';

/**
 * Times a media file says about itself, as hints for when it was recorded:
 * `{ field, value }` with `value` an ISO 8601 date-time. A value ending in `Z`
 * is a UTC instant whose local zone is unknown, one with `±hh:mm` also names
 * the zone, and one with neither is local wall time. Hints come most telling
 * first. Videos read the container tags ffprobe reports; images are parsed
 * here (PNG `tIME` / text / `eXIf`, JPEG and WebP EXIF, XMP in any of them).
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const XMP_FIELDS = ['exif:DateTimeOriginal', 'photoshop:DateCreated', 'xmp:CreateDate'];
const PNG_TEXT_KEYS = /^(creation time|create-date|date:create)$/i;

// ffprobe tag names, most telling first; matched without regard to case.
const CONTAINER_FIELDS = [
  'com.apple.quicktime.creationdate',
  'creation_time',
  'date_recorded',
  'date'
];

const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * ISO 8601 form of a date-time string in the shapes media tags use
 * (`2026-10-19T21:38:40Z`, `2026:10:19 21:38:40`, `…-0500`, `… +00:00`).
 * Strings in other shapes are read by `Date.parse` only when they name a zone.
 * @param {string} text
 * @param {Object} [extra]
 * @param {string} [extra.subsec] EXIF SubSecTime digits.
 * @param {string} [extra.offset] EXIF OffsetTime (`-05:00`).
 * @returns {string|null}
 */
function isoDateTime (text, extra = {}) {
  // ffprobe joins a tag set twice as "first;second".
  const s = String(text || '').split(';')[0].trim().replace(/\0+$/, '');
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) {
    if (!/(Z|GMT|UTC|[+-]\d{2}:?\d{2})\b/i.test(s)) return null;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const [, y, mo, d, h, mi, sec = '00', frac, zone] = m;
  if (Number(y) < 1970 || Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;
  const digits = (frac || String(extra.subsec || '').replace(/\D/g, '')).slice(0, 3);
  const fraction = digits ? `.${digits.padEnd(3, '0')}` : '';
  let tz = zone ? zone.toUpperCase() : '';
  if (!tz && extra.offset && /^[+-]\d{2}:?\d{2}$/.test(String(extra.offset).trim())) tz = String(extra.offset).trim();
  if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${sec}${fraction}${tz}`;
}

function push (hints, field, value) {
  if (value && !hints.some((h) => h.field === field)) hints.push({ field, value });
}

/**
 * Hints from the tags ffprobe reports for a container and its streams.
 * @param {...Object} tagSets format tags first, then stream tags
 * @returns {Array<{ field: string, value: string }>}
 */
function containerTimeTags (...tagSets) {
  const hints = [];
  for (const name of CONTAINER_FIELDS) {
    for (const tags of tagSets) {
      if (!tags || typeof tags !== 'object') continue;
      const key = Object.keys(tags).find((k) => k.toLowerCase() === name);
      if (!key) continue;
      push(hints, name, isoDateTime(tags[key]));
    }
  }
  return hints;
}

/**
 * Date-times in an EXIF (TIFF) block.
 * @param {Buffer} buf starting at the TIFF header, or at `Exif\0\0`
 * @returns {Array<{ field: string, value: string }>}
 */
function exifTimeTags (buf) {
  if (buf.length >= 6 && buf.toString('latin1', 0, 6) === 'Exif\0\0') buf = buf.subarray(6);
  if (buf.length < 8) return [];
  const order = buf.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return [];
  const le = order === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(2) !== 42) return [];

  const readIfd = (offset) => {
    const tags = new Map();
    if (!offset || offset + 2 > buf.length) return tags;
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > buf.length) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const n = u32(entry + 4);
      if (type === 2) {
        const at = n <= 4 ? entry + 8 : u32(entry + 8);
        if (at + n <= buf.length) tags.set(tag, buf.toString('latin1', at, at + n).replace(/\0.*$/s, ''));
      } else if (type === 4 || type === 13) {
        tags.set(tag, u32(entry + 8));
      }
    }
    return tags;
  };

  try {
    const ifd0 = readIfd(u32(4));
    const exif = ifd0.has(0x8769) ? readIfd(ifd0.get(0x8769)) : new Map();
    const hints = [];
    push(hints, 'exif:DateTimeOriginal', isoDateTime(exif.get(0x9003), { subsec: exif.get(0x9291), offset: exif.get(0x9011) }));
    push(hints, 'exif:DateTimeDigitized', isoDateTime(exif.get(0x9004), { subsec: exif.get(0x9292), offset: exif.get(0x9012) }));
    push(hints, 'exif:DateTime', isoDateTime(ifd0.get(0x0132), { subsec: exif.get(0x9290), offset: exif.get(0x9010) }));
    return hints;
  } catch (_) {
    return [];
  }
}

/**
 * Date-times in an XMP packet.
 * @param {string} xml
 * @returns {Array<{ field: string, value: string }>}
 */
function xmpTimeTags (xml) {
  const hints = [];
  for (const field of XMP_FIELDS) {
    const name = field.replace(':', '\\:');
    const m = new RegExp(`${name}\\s*=\\s*"([^"]+)"|<${name}>([^<]+)</${name}>`).exec(xml);
    if (m) push(hints, `xmp:${field}`, isoDateTime(m[1] || m[2]));
  }
  return hints;
}

function pngTimeTags (buf) {
  const hints = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, Math.min(buf.length, offset + 8 + length));
    if (type === 'IEND') break;
    if (type === 'tIME' && data.length >= 7) {
      push(hints, 'png:tIME', isoDateTime(`${pad(data.readUInt16BE(0), 4)}-${pad(data[2])}-${pad(data[3])}T${pad(data[4])}:${pad(data[5])}:${pad(data[6])}Z`));
    } else if (type === 'eXIf') {
      for (const hint of exifTimeTags(data)) push(hints, hint.field, hint.value);
    } else if (type === 'tEXt' || type === 'iTXt') {
      const nul = data.indexOf(0);
      const keyword = nul > 0 ? data.toString('latin1', 0, nul) : '';
      let text = null;
      if (type === 'tEXt') {
        text = data.toString('latin1', nul + 1);
      } else if (data[nul + 1] === 0) {
        const lang = data.indexOf(0, nul + 3);
        const translated = lang >= 0 ? data.indexOf(0, lang + 1) : -1;
        if (translated >= 0) text = data.toString('utf8', translated + 1);
      }
      if (text !== null && PNG_TEXT_KEYS.test(keyword)) push(hints, `png:${keyword}`, isoDateTime(text));
      if (text !== null && keyword === 'XML:com.adobe.xmp') for (const hint of xmpTimeTags(text)) push(hints, hint.field, hint.value);
    }
    offset += 12 + length;
  }
  return hints;
}

function jpegTimeTags (buf) {
  const hints = [];
  let offset = 2;
  while (offset + 4 <= buf.length && buf[offset] === 0xff) {
    const marker = buf[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    const data = buf.subarray(offset + 4, Math.min(buf.length, offset + 2 + length));
    if (marker === 0xe1) {
      if (data.toString('latin1', 0, 6) === 'Exif\0\0') {
        for (const hint of exifTimeTags(data)) push(hints, hint.field, hint.value);
      } else if (data.toString('latin1', 0, 29) === 'http://ns.adobe.com/xap/1.0/\0') {
        for (const hint of xmpTimeTags(data.toString('utf8', 29))) push(hints, hint.field, hint.value);
      }
    }
    offset += 2 + length;
  }
  return hints;
}

function webpTimeTags (buf) {
  const hints = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const type = buf.toString('latin1', offset, offset + 4);
    const length = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, Math.min(buf.length, offset + 8 + length));
    if (type === 'EXIF') for (const hint of exifTimeTags(data)) push(hints, hint.field, hint.value);
    if (type === 'XMP ') for (const hint of xmpTimeTags(data.toString('utf8'))) push(hints, hint.field, hint.value);
    offset += 8 + length + (length % 2);
  }
  return hints;
}

/**
 * Hints from the bytes of a PNG, JPEG, or WebP image.
 * @param {Buffer} buf
 * @returns {Array<{ field: string, value: string }>}
 */
function imageTimeTags (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return [];
  try {
    if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return pngTimeTags(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegTimeTags(buf);
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return webpTimeTags(buf);
  } catch (_) {}
  return [];
}

module.exports = {
  CONTAINER_FIELDS,
  isoDateTime,
  containerTimeTags,
  exifTimeTags,
  xmpTimeTags,
  imageTimeTags
};
