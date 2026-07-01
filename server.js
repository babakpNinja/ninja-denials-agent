const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const type = TYPES[path.extname(filePath)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' };
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip && data.length > 1400 && /json|text|javascript|csv/.test(type)) {
      zlib.gzip(data, (e, gz) => {
        if (e) { res.writeHead(200, headers); return res.end(data); }
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(200, headers); res.end(gz);
      });
    } else { res.writeHead(200, headers); res.end(data); }
  });
});
server.listen(PORT, () => console.log(`Aegis denials-agent listening on :${PORT}`));
