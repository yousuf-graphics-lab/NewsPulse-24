// Tiny static server for the @yousuf_lab promo animatic preview.
// - HTTP/1.1 keep-alive, no caching (always fresh content for the preview iframe)
// - SPA-style fallback: any path serves index.html
// - No frame-blocking headers, works behind the e2b preview proxy
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.join(ROOT, path.normalize(urlPath));
    if (!filePath.startsWith(ROOT)) filePath = path.join(ROOT, 'index.html');
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(ROOT, 'index.html'); // SPA fallback
    }
    const ext = path.extname(filePath).toLowerCase();
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store, max-age=0',
      'Connection': 'keep-alive',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error: ' + err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Animatic preview serving on http://0.0.0.0:${PORT}`);
});
