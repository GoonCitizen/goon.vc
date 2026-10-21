'use strict';

/**
 * Copy the latest GoonCitizen builds into assets/downloads/gooncitizen/ and
 * write index.json (served at /downloads/gooncitizen/index.json).
 *
 *   npm run build:downloads
 *   GOONCITIZEN_ROOT=~/star-citizen-live npm run build:downloads
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.GOONCITIZEN_ROOT || path.join(__dirname, '../../star-citizen-live'));
const OUT_DIR = path.resolve(__dirname, '../assets/downloads/gooncitizen');
const PUBLIC_BASE = '/downloads/gooncitizen';

// Newest match per platform wins; `name` renames on copy so URLs carry no spaces.
const TARGETS = [
  { platform: 'windows', label: 'Windows', dir: 'dist', match: /^GoonCitizen Setup (.+)\.exe$/, name: (v) => `GoonCitizen-Setup-${v}.exe` },
  { platform: 'macos', label: 'macOS (Apple silicon)', dir: 'dist', match: /^GoonCitizen-(.+)-arm64\.dmg$/, name: (v) => `GoonCitizen-${v}-arm64.dmg` },
  { platform: 'linux', label: 'Linux (.deb)', dir: 'dist', match: /^gooncitizen_(.+)_amd64\.deb$/, name: (v) => `gooncitizen_${v}_amd64.deb` },
  { platform: 'android', label: 'Android (test build)', dir: 'android/app/build/outputs/apk/debug', match: /^app-debug\.apk$/, name: (v) => `GoonCitizen-${v}-debug.apk` }
];

function sha256 (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

function newest (target, fallbackVersion) {
  const dir = path.join(ROOT, target.dir);
  if (!fs.existsSync(dir)) return null;
  const hits = fs.readdirSync(dir)
    .map((file) => ({ file, m: target.match.exec(file) }))
    .filter((hit) => hit.m)
    .map((hit) => ({ source: path.join(dir, hit.file), version: hit.m[1] || fallbackVersion, mtime: fs.statSync(path.join(dir, hit.file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return hits[0] || null;
}

async function main () {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  for (const target of TARGETS) {
    const hit = newest(target, pkg.version);
    if (!hit) {
      console.warn(`[DOWNLOADS] no ${target.platform} build under ${path.join(ROOT, target.dir)}`);
      continue;
    }
    const name = target.name(hit.version);
    const dest = path.join(OUT_DIR, name);
    fs.copyFileSync(hit.source, dest);
    const stat = fs.statSync(dest);
    files.push({
      platform: target.platform,
      label: target.label,
      version: hit.version,
      href: `${PUBLIC_BASE}/${encodeURIComponent(name)}`,
      size: stat.size,
      sha256: await sha256(dest),
      builtAt: new Date(hit.mtime).toISOString()
    });
    console.log(`[DOWNLOADS] ${target.platform}: ${name} (${(stat.size / 1048576).toFixed(1)} MiB)`);
  }
  const keep = new Set(files.map((f) => decodeURIComponent(path.basename(f.href))).concat('index.json'));
  for (const stale of fs.readdirSync(OUT_DIR)) {
    if (!keep.has(stale)) fs.rmSync(path.join(OUT_DIR, stale), { force: true });
  }
  const manifest = { name: 'GoonCitizen', version: pkg.version, generatedAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[DOWNLOADS] wrote ${files.length} builds to ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((error) => {
  console.error('[DOWNLOADS]', error.message);
  process.exit(1);
});
