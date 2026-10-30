'use strict';

/**
 * Never log or persist Fabric key material (or common private-key shapes).
 * Federation / apps should require this module before serializing state or env dumps.
 */

const REPLACEMENT = '[REDACTED]';

const EXACT_SENSITIVE_KEYS = new Set([
  'FABRIC_SEED',
  'FABRIC_XPRV',
  'FABRIC_PASSPHRASE',
  'FABRIC_MNEMONIC',
  'FABRIC_WIF',
  'FABRIC_PRIVKEY',
  'FABRIC_PRIVATE_KEY'
]);

function isSensitiveKeyName (name) {
  if (typeof name !== 'string') return false;
  const u = name.toUpperCase();
  if (EXACT_SENSITIVE_KEYS.has(u)) return true;
  if (/^FABRIC_.*(SEED|XPRV|PASSPHRASE|MNEMONIC|PRIV|KEY|WIF)/i.test(name)) return true;
  return false;
}

function looksLikePrivateKeyMaterial (s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 8) return false;
  if (/^xprv[a-zA-Z0-9]+$/i.test(t)) return true;
  if (/^xpriv[a-zA-Z0-9]+$/i.test(t)) return true;
  if (/^(5|K|L)[1-9A-HJ-NP-Za-km-z]{50,}$/.test(t)) return true;
  return false;
}

/**
 * Deep-clone-like redaction for logging / API responses. Does not mutate input.
 */
function redactDeep (value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return looksLikePrivateKeyMaterial(value) ? REPLACEMENT : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((x) => redactDeep(x));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKeyName(k)) out[k] = REPLACEMENT;
    else out[k] = redactDeep(v);
  }
  return out;
}

/**
 * Walk nested objects/arrays; throw before writing disk if structure would store secrets.
 */
function assertSafeToPersist (value, path = 'root') {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === 'string') {
    if (looksLikePrivateKeyMaterial(value)) {
      throw new Error(`secrets-guard: refuse to persist value at ${path} (private key material)`);
    }
    return;
  }
  if (t !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSafeToPersist(item, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKeyName(k)) {
      throw new Error(`secrets-guard: refuse to persist sensitive key ${path}.${k}`);
    }
    assertSafeToPersist(v, `${path}.${k}`);
  }
}

module.exports = {
  REPLACEMENT,
  EXACT_SENSITIVE_KEYS,
  isSensitiveKeyName,
  looksLikePrivateKeyMaterial,
  redactDeep,
  assertSafeToPersist
};
