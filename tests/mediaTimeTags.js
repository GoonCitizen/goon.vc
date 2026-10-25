'use strict';

const assert = require('assert');
const { isoDateTime, containerTimeTags, exifTimeTags, imageTimeTags } = require('../functions/mediaTimeTags');

// A little-endian TIFF: IFD0 (its entries plus the Exif IFD pointer), then the Exif IFD.
function tiff (ifd0, exif) {
  const ifd0Size = 2 + (ifd0.length + 1) * 12 + 4;
  const exifStart = 8 + ifd0Size;
  let dataAt = exifStart + 2 + exif.length * 12 + 4;
  const buf = Buffer.alloc(dataAt + 256);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  const writeIfd = (start, entries) => {
    buf.writeUInt16LE(entries.length, start);
    entries.forEach((e, i) => {
      const at = start + 2 + i * 12;
      buf.writeUInt16LE(e.tag, at);
      if (e.long !== undefined) {
        buf.writeUInt16LE(4, at + 2);
        buf.writeUInt32LE(1, at + 4);
        buf.writeUInt32LE(e.long, at + 8);
        return;
      }
      const bytes = Buffer.from(e.ascii + '\0', 'latin1');
      buf.writeUInt16LE(2, at + 2);
      buf.writeUInt32LE(bytes.length, at + 4);
      if (bytes.length <= 4) {
        bytes.copy(buf, at + 8);
      } else {
        bytes.copy(buf, dataAt);
        buf.writeUInt32LE(dataAt, at + 8);
        dataAt += bytes.length;
      }
    });
    buf.writeUInt32LE(0, start + 2 + entries.length * 12);
  };
  writeIfd(8, ifd0.concat([{ tag: 0x8769, long: exifStart }]));
  writeIfd(exifStart, exif);
  return buf.subarray(0, dataAt);
}

const CAMERA = tiff([{ tag: 0x0132, ascii: '2026:10:19 22:00:00' }], [
  { tag: 0x9003, ascii: '2026:10:19 21:38:40' },
  { tag: 0x9011, ascii: '-05:00' },
  { tag: 0x9291, ascii: '12' }
]);

function pngChunk (type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('mediaTimeTags', function () {
  describe('isoDateTime', function () {
    it('normalizes the shapes media tags use', function () {
      assert.strictEqual(isoDateTime('2026-10-20T02:33:12.000000Z'), '2026-10-20T02:33:12.000Z');
      assert.strictEqual(isoDateTime('2026-10-19T21:33:12-0500'), '2026-10-19T21:33:12-05:00');
      assert.strictEqual(isoDateTime('2026:10:19 21:33:12', { subsec: '5', offset: '+09:30' }), '2026-10-19T21:33:12.500+09:30');
      assert.strictEqual(isoDateTime('2026:10:19 21:33:12'), '2026-10-19T21:33:12');
      assert.strictEqual(isoDateTime('2026-10-20T02:33:12.000000Z;2026-10-20T02:33:12Z'), '2026-10-20T02:33:12.000Z', 'ffprobe joins a tag set twice');
      assert.strictEqual(isoDateTime('Tue, 20 Oct 2026 02:33:12 GMT'), '2026-10-20T02:33:12.000Z');
    });

    it('drops values that are not a date-time', function () {
      for (const value of ['', null, 'yesterday', '0000:00:00 00:00:00', 'Tue, 20 Oct 2026 02:33:12']) {
        assert.strictEqual(isoDateTime(value), null, String(value));
      }
    });
  });

  describe('containerTimeTags', function () {
    it('reads QuickTime and container tags, most telling first, format before stream', function () {
      const hints = containerTimeTags(
        { creation_time: '2026-10-20T02:33:12.000000Z', 'com.apple.quicktime.creationdate': '2026-10-19T21:33:12-0500', encoder: 'Lavf' },
        { creation_time: '2026-10-20T02:33:13.000000Z', DATE_RECORDED: '2026-10-19' }
      );
      assert.deepStrictEqual(hints, [
        { field: 'com.apple.quicktime.creationdate', value: '2026-10-19T21:33:12-05:00' },
        { field: 'creation_time', value: '2026-10-20T02:33:12.000Z' }
      ]);
      assert.deepStrictEqual(containerTimeTags(undefined, null), []);
    });
  });

  describe('exifTimeTags', function () {
    it('reads the original, digitized, and modified times with their offset and fraction', function () {
      assert.deepStrictEqual(exifTimeTags(CAMERA), [
        { field: 'exif:DateTimeOriginal', value: '2026-10-19T21:38:40.120-05:00' },
        { field: 'exif:DateTime', value: '2026-10-19T22:00:00' }
      ]);
    });

    it('survives truncated or foreign data', function () {
      assert.deepStrictEqual(exifTimeTags(CAMERA.subarray(0, 30)), []);
      assert.deepStrictEqual(exifTimeTags(Buffer.from('not a tiff at all')), []);
    });
  });

  describe('imageTimeTags', function () {
    it('reads a PNG\'s tIME, text, eXIf, and XMP chunks', function () {
      const xmp = '<x:xmpmeta><rdf:Description xmp:CreateDate="2026-10-19T21:38:40-05:00"/></x:xmpmeta>';
      const png = Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('tIME', Buffer.from([0x07, 0xea, 10, 20, 2, 38, 41])),
        pngChunk('tEXt', Buffer.from('Creation Time\0Tue, 20 Oct 2026 02:38:40 GMT', 'latin1')),
        pngChunk('eXIf', CAMERA),
        pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(xmp, 'utf8')])),
        pngChunk('IEND', Buffer.alloc(0))
      ]);
      assert.deepStrictEqual(imageTimeTags(png), [
        { field: 'png:tIME', value: '2026-10-20T02:38:41Z' },
        { field: 'png:Creation Time', value: '2026-10-20T02:38:40.000Z' },
        { field: 'exif:DateTimeOriginal', value: '2026-10-19T21:38:40.120-05:00' },
        { field: 'exif:DateTime', value: '2026-10-19T22:00:00' },
        { field: 'xmp:xmp:CreateDate', value: '2026-10-19T21:38:40-05:00' }
      ]);
    });

    it('reads EXIF from a JPEG and a WebP', function () {
      const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), CAMERA]);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(app1.length + 2);
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, app1, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
      assert.strictEqual(imageTimeTags(jpeg)[0].value, '2026-10-19T21:38:40.120-05:00');

      const size = Buffer.alloc(4);
      size.writeUInt32LE(CAMERA.length);
      const exif = Buffer.concat([Buffer.from('EXIF', 'latin1'), size, CAMERA, Buffer.alloc(CAMERA.length % 2)]);
      const vp8 = Buffer.concat([Buffer.from('VP8 ', 'latin1'), Buffer.from([2, 0, 0, 0, 0, 0])]);
      const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8, exif]);
      const riff = Buffer.alloc(4);
      riff.writeUInt32LE(body.length);
      const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), riff, body]);
      assert.strictEqual(imageTimeTags(webp)[0].value, '2026-10-19T21:38:40.120-05:00');
    });

    it('finds nothing in images without times, or in other bytes', function () {
      assert.deepStrictEqual(imageTimeTags(Buffer.concat([PNG_SIGNATURE, pngChunk('IEND', Buffer.alloc(0))])), []);
      assert.deepStrictEqual(imageTimeTags(Buffer.from('IMAGE-BYTES-NOT-AN-IMAGE')), []);
      assert.deepStrictEqual(imageTimeTags(null), []);
    });
  });
});
