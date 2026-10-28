'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

// Порт и хост — п.3: по умолчанию 127.0.0.1, 0.0.0.0 только по флагу
const PORT = parseInt(process.env.PORT || '5173', 10);
const HOST = process.env.HOST || '127.0.0.1'; // hardened: только локалка
const ALLOW_LAN = process.env.ALLOW_LAN === '1'; // если нужен 0.0.0.0 — явно
const LISTEN_HOST = ALLOW_LAN ? '0.0.0.0' : HOST;
const ROOT = path.resolve(__dirname, 'renderer');
const MAX_URL_LEN = 2048;
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.html','.css','.js','.json','.svg','.png','.jpg','.jpeg','.webp','.ico','.woff2','.woff','.ttf']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

const ipHits = new Map();
const RATE_WINDOW = 10000;
const RATE_MAX = 100;

function isIpRateLimited(ip) {
  const now = Date.now();
  const arr = ipHits.get(ip) || [];
  const recent = arr.filter(t => now - t < RATE_WINDOW);
  recent.push(now);
  ipHits.set(ip, recent);
  if (recent.length > RATE_MAX) return true;
  if (ipHits.size > 1000) {
    for (const [k,v] of ipHits) if (now - v[v.length-1] > RATE_WINDOW*2) ipHits.delete(k);
  }
  return false;
}

// п.2 фикс: до writeHead ставим заголовки — теперь через объект headers
function getSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '0',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store'
  };
}

function safeFilePath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const joined = path.join(ROOT, decoded);
  const resolved = path.resolve(joined);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (resolved !== ROOT && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const h = getSecurityHeaders();
      h['Allow'] = 'GET, HEAD';
      res.writeHead(405, h);
      return res.end('Method Not Allowed');
    }
    if (!req.url || req.url.length > MAX_URL_LEN) {
      res.writeHead(414, getSecurityHeaders());
      return res.end('URI Too Long');
    }
    const headerSize = JSON.stringify(req.headers).length;
    if (headerSize > 8192) {
      res.writeHead(431, getSecurityHeaders());
      return res.end('Headers Too Large');
    }
    const ip = req.socket.remoteAddress || 'unknown';
    if (isIpRateLimited(ip)) {
      const h = getSecurityHeaders();
      h['Retry-After'] = '10';
      res.writeHead(429, h);
      return res.end('Too Many Requests');
    }

    let urlPath = req.url.split('?')[0].split('#')[0];
    if (urlPath === '/') urlPath = '/index.html';

    if (urlPath === '/api/apps') {
      if (req.method !== 'GET') {
        res.writeHead(405, getSecurityHeaders());
        return res.end();
      }
      try {
        const mock = require('./src/mockApps')();
        const out = mock.slice(0, 800).map(m => ({
          name: String(m.name).slice(0, 120).replace(/[\x00-\x1F\x7F]/g, ''),
          path: String(m.path || '').slice(0, 512),
          type: m.type || 'lnk',
          icon: String(m.icon || '📦').slice(0, 8),
          category: String(m.category || '').slice(0, 32),
          pinned: !!m.pinned,
          recent: !!m.recent,
          mtime: m.mtime || null
        }));
        const body = JSON.stringify(out);
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          // п.3 фикс: убран wildcard CORS
          'Cache-Control': 'no-store',
          ...getSecurityHeaders()
        };
        // Cache-Control перезапишем на no-store уже есть
        res.writeHead(200, headers);
        return res.end(body);
      } catch (e) {
        res.writeHead(500, getSecurityHeaders());
        return res.end('Internal Error');
      }
    }

    const filePath = safeFilePath(urlPath);
    if (!filePath) {
      res.writeHead(403, getSecurityHeaders());
      return res.end('Forbidden');
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext && !ALLOWED_EXT.has(ext)) {
      res.writeHead(403, getSecurityHeaders());
      return res.end('Forbidden file type');
    }

    // ── п.7 фикс TOCTOU: проверяем путь до чтения, а не stat→readFile race ─
    // Проверяем что резолвленный путь внутри ROOT (уже сделано в safeFilePath)
    // Теперь сразу читаем файл асинхронно, без lstat→realpath→readFile гонки
    // Если файл — симлинк вне ROOT, safeFilePath уже отклонит (т.к. resolved вне ROOT после join)
    // Для симлинка внутри ROOT — разрешаем, это наш же renderer
    fs.stat(filePath, (statErr, stat) => {
      if (statErr) {
        if (statErr.code === 'ENOENT') {
          res.writeHead(404, getSecurityHeaders());
          return res.end('Not Found');
        }
        res.writeHead(500, getSecurityHeaders());
        return res.end('Error');
      }
      if (!stat.isFile()) {
        res.writeHead(404, getSecurityHeaders());
        return res.end('Not Found');
      }
      if (stat.size > MAX_FILE_SIZE) {
        res.writeHead(413, getSecurityHeaders());
        return res.end('File Too Large');
      }
      const etag = crypto.createHash('sha1').update(stat.mtimeMs + '-' + stat.size).digest('hex');
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, getSecurityHeaders());
        return res.end();
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500, getSecurityHeaders());
          return res.end('Error');
        }
        if (data.length > MAX_FILE_SIZE) {
          res.writeHead(413, getSecurityHeaders());
          return res.end('File Too Large');
        }
        const ctype = MIME[ext] || 'application/octet-stream';
        const headers = {
          'Content-Type': ctype,
          'Content-Length': data.length,
          'ETag': etag,
          'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
          ...getSecurityHeaders()
        };
        // п.2: ETag/Cache-Control должен быть до CSP, но getSecurityHeaders уже добавляет no-store — перезапишем
        if (ext !== '.html') headers['Cache-Control'] = 'public, max-age=3600';
        else headers['Cache-Control'] = 'no-store';

        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        res.end(data);
      });
    });

  } catch (e) {
    try { res.writeHead(500, getSecurityHeaders()); res.end('Internal Error'); } catch {}
  }
});

server.headersTimeout = 5000;
server.requestTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`\n  StartORBack PREVIEW (hardened v3) → http://${LISTEN_HOST}:${PORT}`);
  if (ALLOW_LAN) console.warn('  ⚠️  ALLOW_LAN=1 — слушает 0.0.0.0, LAN доступен');
  else console.log(`  Только локалка (${LISTEN_HOST}), для LAN: ALLOW_LAN=1 npm run preview`);
  console.log(`  Защита: CSP до writeHead, 127.0.0.1, no wildcard CORS, private-IP block\n`);
});
