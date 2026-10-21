'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Same-origin Hub API paths the public site (Passport / GoonCitizen login,
 * device-link, JSON-RPC, identity cluster) needs. Everything else stays
 * HTML or 404 — not a Hub, not LiveRelay.
 */
const HUB_API_PREFIXES = Object.freeze([
  '/sessions',
  '/device-links',
  '/services/rpc',
  '/identity/cluster',
  '/identity/cross-sign'
]);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host'
]);

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 1024 * 1024;

// The request never reached this Hub, so another may safely take it.
const UNREACHABLE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

function parsePathname (req) {
  const raw = (req && (req.originalUrl || req.url)) || '/';
  try {
    return new URL(raw, 'http://localhost').pathname || '/';
  } catch (_) {
    const q = String(raw).indexOf('?');
    return q === -1 ? String(raw) : String(raw).slice(0, q);
  }
}

function isHubApiPath (pathname) {
  const p = String(pathname || '');
  for (let i = 0; i < HUB_API_PREFIXES.length; i++) {
    const prefix = HUB_API_PREFIXES[i];
    if (p === prefix || p.startsWith(prefix + '/')) return true;
  }
  return false;
}

function wantsHtmlNavigation (req) {
  const a = req && req.headers && req.headers.accept;
  if (typeof a !== 'string') return false;
  const first = a.split(',')[0].trim().toLowerCase().split(';')[0];
  return first === 'text/html';
}

/**
 * Browser GET /sessions (and /device-links) should render GoonSPA, not Hub JSON.
 * JSON polls and all mutating methods still proxy.
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function shouldProxyHubApi (req) {
  const pathname = parsePathname(req);
  if (!isHubApiPath(pathname)) return false;
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    if ((pathname === '/sessions' || pathname === '/device-links') && wantsHtmlNavigation(req)) {
      return false;
    }
  }
  return true;
}

function normalizeHubOrigin (raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

/**
 * Ordered Hubs: requests go to the Hub that answered last, then the others in
 * order. One list is shared by everything that talks to the Hub, so a member's
 * Passport session is polled where it was created.
 * @param {string|string[]} origins
 * @returns {{ origins: string[], order: function(): string[], answered: function(string): void }}
 */
function createHubList (origins) {
  const list = [...new Set([].concat(origins || []).map(normalizeHubOrigin).filter(Boolean))];
  let preferred = 0;
  return {
    origins: list,
    order () {
      return list.slice(preferred).concat(list.slice(0, preferred));
    },
    answered (origin) {
      const index = list.indexOf(origin);
      if (index >= 0) preferred = index;
    }
  };
}

function isHubList (value) {
  return !!value && Array.isArray(value.origins) && typeof value.order === 'function';
}

function toHubList (hubs) {
  return isHubList(hubs) ? hubs : createHubList(hubs);
}

function isUnreachable (err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  return UNREACHABLE_CODES.has(code);
}

function requestBodyBuffer (req) {
  if (!req) return null;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && req.body) return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const keys = Object.keys(req.body);
    if (!keys.length) return null;
    return Buffer.from(JSON.stringify(req.body));
  }
  return null;
}

function forwardedProto (req) {
  const xf = req && req.headers && req.headers['x-forwarded-proto'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  if (req && req.secure) return 'https';
  return 'http';
}

function forwardedFor (req) {
  const existing = req && req.headers && req.headers['x-forwarded-for'];
  const remote = (req && req.socket && req.socket.remoteAddress) || '';
  if (typeof existing === 'string' && existing.trim()) {
    return remote ? `${existing.trim()}, ${remote}` : existing.trim();
  }
  return remote || '';
}

function sendError (res, status, error, detail) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(detail ? { error, detail } : { error }));
}

/**
 * The request body, read once so it can be sent to another Hub.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Buffer|null>}
 */
function readRequestBody (req) {
  const parsed = requestBodyBuffer(req);
  if (parsed || !req || !req.readable || req.readableEnded) return Promise.resolve(parsed);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('Request body too large');
        err.code = 'EBODYTOOLARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

/**
 * Send one request to one Hub. Resolves `{ unreachable }` when the Hub could
 * not be reached at all (nothing was written to `res`), otherwise `{}`.
 * @returns {Promise<{ unreachable?: Error }>}
 */
function forwardToHub (origin, req, res, body, timeout) {
  const target = new URL(origin);
  const rawUrl = (req && (req.originalUrl || req.url)) || '/';
  let pathWithQuery = '/';
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    pathWithQuery = parsed.pathname + parsed.search;
  } catch (_) {
    pathWithQuery = String(rawUrl);
  }

  const headers = {};
  const src = (req && req.headers) || {};
  for (const name of Object.keys(src)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    const value = src[name];
    if (value == null || value === '') continue;
    headers[name] = value;
  }
  headers.host = target.host;
  const xf = forwardedFor(req);
  if (xf) headers['x-forwarded-for'] = xf;
  headers['x-forwarded-host'] = (src.host || src['x-forwarded-host'] || '').toString();
  headers['x-forwarded-proto'] = forwardedProto(req);

  if (body) {
    headers['content-length'] = String(body.length);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const lib = target.protocol === 'https:' ? https : http;
    const upstream = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: String((req && req.method) || 'GET').toUpperCase(),
      path: pathWithQuery,
      headers,
      timeout
    }, (incoming) => {
      settle({});
      res.statusCode = incoming.statusCode || 502;
      const outHeaders = incoming.headers || {};
      for (const name of Object.keys(outHeaders)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        const value = outHeaders[name];
        if (value == null) continue;
        try { res.setHeader(name, value); } catch (_) { /* skip invalid */ }
      }
      incoming.pipe(res);
    });

    upstream.on('timeout', () => {
      if (settled) return upstream.destroy();
      settle({});
      upstream.destroy();
      sendError(res, 504, 'Hub request timed out');
    });

    upstream.on('error', (err) => {
      if (settled) return;
      if (isUnreachable(err)) return settle({ unreachable: err });
      settle({});
      sendError(res, 502, 'Hub unreachable', err && err.message ? err.message : String(err));
    });

    upstream.end(body || undefined);
  });
}

/**
 * Reverse-proxy an allowlisted Hub API request. Does not follow client-supplied
 * URLs. Tries each Hub in order until one can be reached; a Hub that answers
 * (any status) or times out ends the request, since it may have acted on it.
 * @param {string|string[]|Object} hubs Origins (`https://hub.fabric.pub`, no
 *   path) or a list from {@link createHubList}.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
async function proxyHubApiRequest (hubs, req, res, opts = {}) {
  const list = toHubList(hubs);
  if (!list.origins.length) return sendError(res, 502, 'Hub origin is not configured');

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    if (err && err.code === 'EBODYTOOLARGE') return sendError(res, 413, 'Request body too large');
    return sendError(res, 400, 'Could not read request body');
  }

  const timeoutMs = Number(opts.timeoutMs);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  let last = null;
  for (const origin of list.order()) {
    const outcome = await forwardToHub(origin, req, res, body, timeout);
    if (!outcome.unreachable) {
      list.answered(origin);
      return;
    }
    last = outcome.unreachable;
  }
  sendError(res, 502, 'Hub unreachable', last && last.message ? last.message : undefined);
}

/**
 * Express middleware: proxy Hub API paths, otherwise `next()`.
 * @param {string|string[]|Object} hubs Origins or a list from {@link createHubList}.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {function}
 */
function createHubApiMiddleware (hubs, opts = {}) {
  const list = toHubList(hubs);
  return function hubApiMiddleware (req, res, next) {
    if (!shouldProxyHubApi(req)) return next();
    return proxyHubApiRequest(list, req, res, opts)
      .catch((err) => sendError(res, 502, 'Hub unreachable', err && err.message));
  };
}

module.exports = {
  HUB_API_PREFIXES,
  DEFAULT_TIMEOUT_MS,
  parsePathname,
  isHubApiPath,
  wantsHtmlNavigation,
  shouldProxyHubApi,
  normalizeHubOrigin,
  createHubList,
  isHubList,
  isUnreachable,
  proxyHubApiRequest,
  createHubApiMiddleware
};
