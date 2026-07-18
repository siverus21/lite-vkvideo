/**
 * lite-vkvideo poster proxy — Node.js (stdlib only, no Express).
 *
 * Contract:
 *   GET /vk-poster?oid=-123&id=456&hash=abc
 *   → 200 { "url": "https://…" }
 *   → 400/404/502 { "error": "…" } or { "url": null }
 *
 * Use as a module:
 *   import { resolvePoster, handlePosterRequest } from '@siverus21/lite-vkvideo/vk-poster';
 *
 * Or run standalone:
 *   node vk-poster.mjs              # /vk-poster only
 *   node vk-poster.mjs --demo       # + static demo (local)
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TRUSTED_POSTER_HOST_SUFFIXES = [
  'vk.ru',
  'vk.com',
  'vk.me',
  'vkuservideo.net',
  'userapi.com',
  'okcdn.ru',
  'mycdn.me',
  'vkvideo.ru',
];

export function isTrustedPosterUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return TRUSTED_POSTER_HOST_SUFFIXES.some(
      suffix => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

export function extractPoster(html) {
  if (typeof html !== 'string' || html.length > 2_000_000) return '';
  const urls = [
    ...html.matchAll(/"url":"(https:\\\/\\\/[^"]+getVideoPreview[^"]+)"/g),
  ]
    .map(m => m[1].replace(/\\\//g, '/'))
    .filter(isTrustedPosterUrl);
  if (!urls.length) return '';
  return (
    urls.find(u => u.includes('fn=vid_w')) ||
    urls.find(u => u.includes('fn=vid_x')) ||
    urls[urls.length - 1] ||
    ''
  );
}

export function validateParams(oid, id, hash) {
  if (!/^-?\d{1,16}$/.test(String(oid || ''))) {
    return { ok: false, error: 'invalid oid' };
  }
  if (!/^\d{1,16}$/.test(String(id || ''))) {
    return { ok: false, error: 'invalid id' };
  }
  if (hash && !/^[a-zA-Z0-9]{1,64}$/.test(String(hash))) {
    return { ok: false, error: 'invalid hash' };
  }
  return { ok: true };
}

/**
 * @param {{ oid: string, id: string, hash?: string }} params
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function resolvePoster({ oid, id, hash = '' } = {}) {
  const check = validateParams(oid, id, hash);
  if (!check.ok) {
    return { status: 400, body: { error: check.error } };
  }

  const qs = new URLSearchParams({ oid: String(oid), id: String(id) });
  if (hash) qs.set('hash', String(hash));

  try {
    const vkRes = await fetch(`https://vk.ru/video_ext.php?${qs}`, {
      headers: { 'User-Agent': 'lite-vkvideo-poster/1.0' },
    });
    const html = await vkRes.text();
    const poster = extractPoster(html);
    if (!poster) {
      return { status: 404, body: { url: null, error: 'poster not found' } };
    }
    return { status: 200, body: { url: poster } };
  } catch (err) {
    return {
      status: 502,
      body: { error: String(err?.message || err) },
    };
  }
}

/** Write JSON response for Node's http.ServerResponse. */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store',
  });
  res.end(payload);
}

/**
 * Handle a request if path is /vk-poster (or ends with it).
 * @returns {Promise<boolean>} true if handled
 */
export async function handlePosterRequest(req, res, { pathname } = {}) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  const pathName = pathname ?? url.pathname;
  if (pathName !== '/vk-poster' && !pathName.endsWith('/vk-poster')) {
    return false;
  }

  const result = await resolvePoster({
    oid: url.searchParams.get('oid') || '',
    id: url.searchParams.get('id') || '',
    hash: url.searchParams.get('hash') || '',
  });
  sendJson(res, result.status, result.body);
  return true;
}

function serveStatic(res, urlPath, root) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/demo/index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(file);
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function main() {
  const demo = process.argv.includes('--demo');
  const PORT = Number(process.env.PORT) || (demo ? 8001 : 8002);
  const root = pathResolve(__dirname);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (await handlePosterRequest(req, res, { pathname: url.pathname })) {
      return;
    }
    if (demo) {
      serveStatic(res, url.pathname, root);
      return;
    }
    sendJson(res, 404, {
      error: 'not found — use GET /vk-poster?oid=&id=&hash=',
    });
  });

  server.listen(PORT, () => {
    if (demo) {
      console.log(`demo:        http://localhost:${PORT}/demo/`);
    }
    console.log(`vk-poster:   http://localhost:${PORT}/vk-poster?oid=&id=&hash=`);
  });
}

const entry = process.argv[1] ? pathResolve(process.argv[1]) : '';
if (entry && fileURLToPath(import.meta.url) === entry) {
  main();
}
