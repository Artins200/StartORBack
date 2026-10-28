const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5173;
const ROOT = path.join(__dirname, 'renderer');

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
  '.mp3': 'audio/mpeg'
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  // API mock for browser preview
  if (url === '/api/apps') {
    const mock = require('./src/mockApps')();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(mock));
  }
  const filePath = path.join(ROOT, decodeURIComponent(url));
  // security: must be inside ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // fallback to index.html for SPA
        fs.readFile(path.join(ROOT, 'index.html'), (e, d) => {
          if (e) { res.writeHead(404); res.end('Not found'); }
          else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d); }
        });
      } else {
        res.writeHead(500); res.end('Error');
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  StartORBack PREVIEW запущен → http://0.0.0.0:${PORT}`);
  console.log(`  Локально: http://localhost:${PORT}`);
  console.log(`  Для предпросмотра в Arena открой Live Preview`);
  console.log(`\n  Это браузерная версия того же меню Пуск.`);
  console.log(`  На Windows запускай Electron: npm start\n`);
});
