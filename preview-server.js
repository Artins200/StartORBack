'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '5173', 10);
const ROOT = path.resolve(__dirname, 'renderer');
const MAX_URL_LEN = 2048;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB лимит для статики
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

// Rate limit: IP -> timestamps
const ipHits = new Map();
const RATE_WINDOW = 10000; // 10s
const RATE_MAX = 100;

function isIpRateLimited(ip) {
  const now = Date.now();
  const arr = ipHits.get(ip) || [];
  const recent = arr.filter(t => now - t < RATE_WINDOW);
  recent.push(now);
  ipHits.set(ip, recent);
  if (recent.length > RATE_MAX) return true;
  // cleanup
  if (ipHits.size > 1000) {
    for (const [k,v] of ipHits) if (now - v[v.length-1] > RATE_WINDOW*2) ipHits.delete(k);
  }
  return false;
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  res.setHeader('Cache-Control', 'no-store');
}

function safeFilePath(urlPath) {
  // urlPath уже без query, декодируем безопасно
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  // Нормализуем и резолвим
  const joined = path.join(ROOT, decoded);
  const resolved = path.resolve(joined);
  // Строгая проверка что внутри ROOT
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (resolved !== ROOT && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  // Базовые защиты
  try {
    // Только GET/HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Allow': 'GET, HEAD' });
      setSecurityHeaders(res);
      return res.end('Method Not Allowed');
    }
    if (!req.url || req.url.length > MAX_URL_LEN) {
      res.writeHead(414);
      setSecurityHeaders(res);
      return res.end('URI Too Long');
    }
    // Проверка размера заголовков (защита от large headers DoS)
    const headerSize = JSON.stringify(req.headers).length;
    if (headerSize > 8192) {
      res.writeHead(431);
      setSecurityHeaders(res);
      return res.end('Headers Too Large');
    }

    const ip = req.socket.remoteAddress || 'unknown';
    if (isIpRateLimited(ip)) {
      res.writeHead(429, { 'Retry-After': '10' });
      setSecurityHeaders(res);
      return res.end('Too Many Requests');
    }

    let urlPath = req.url.split('?')[0].split('#')[0];
    if (urlPath === '/') urlPath = '/index.html';

    // API mock — строго валидируем путь
    if (urlPath === '/api/apps') {
      if (req.method !== 'GET') {
        res.writeHead(405); setSecurityHeaders(res); return res.end();
      }
      try {
        const mock = require('./src/mockApps')();
        // Санитизируем вывод: только нужные поля, лимиты
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
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        });
        setSecurityHeaders(res);
        return res.end(body);
      } catch (e) {
        res.writeHead(500); setSecurityHeaders(res); return res.end('Internal Error');
      }
    }

    const filePath = safeFilePath(urlPath);
    if (!filePath) {
      res.writeHead(403); setSecurityHeaders(res); return res.end('Forbidden');
    }

    const ext = path.extname(filePath).toLowerCase();
    // Разрешаем только файлы с безопасными расширениями или без расширения (но тогда 404)
    if (ext && !ALLOWED_EXT.has(ext)) {
      res.writeHead(403); setSecurityHeaders(res); return res.end('Forbidden file type');
    }

    // Проверка существования и что это файл, не директория, не симлинк вне ROOT
    let stat;
    try {
      stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        // Проверяем куда ведёт симлинк
        const real = fs.realpathSync(filePath);
        const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
        if (real !== ROOT && !real.startsWith(rootWithSep)) {
          res.writeHead(403); setSecurityHeaders(res); return res.end('Forbidden');
        }
        stat = fs.statSync(filePath);
      }
      if (!stat.isFile()) {
        res.writeHead(404); setSecurityHeaders(res); return res.end('Not Found');
      }
      if (stat.size > MAX_FILE_SIZE) {
        res.writeHead(413); setSecurityHeaders(res); return res.end('File Too Large');
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        res.writeHead(404); setSecurityHeaders(res); return res.end('Not Found');
      } else {
        res.writeHead(500); setSecurityHeaders(res); return res.end('Error');
      }
    }

    // ETag для кэша (но всё равно no-store для безопасности, можно сменить на immutable для статики)
    const etag = crypto.createHash('sha1').update(stat.mtimeMs + '-' + stat.size).digest('hex');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304); setSecurityHeaders(res); return res.end();
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500); setSecurityHeaders(res); return res.end('Error');
      }
      // Двойная проверка размера после чтения
      if (data.length > MAX_FILE_SIZE) {
        res.writeHead(413); setSecurityHeaders(res); return res.end('File Too Large');
      }
      const ctype = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': ctype,
        'Content-Length': data.length,
        'ETag': etag,
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
      });
      setSecurityHeaders(res);
      // HEAD не должен отдавать тело
      if (req.method === 'HEAD') return res.end();
      res.end(data);
    });

  } catch (e) {
    try { res.writeHead(500); setSecurityHeaders(res); res.end('Internal Error'); } catch {}
  }
});

// Защита от Slowloris / keep-alive abuse
server.headersTimeout = 5000;
server.requestTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  StartORBack PREVIEW (hardened) → http://0.0.0.0:${PORT}`);
  console.log(`  Локально: http://localhost:${PORT}`);
  console.log(`  Защита: CSP, rate-limit, path traversal guard, no symlink escape\n`);
});
