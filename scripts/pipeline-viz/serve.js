#!/usr/bin/env node
/**
 * Tiny static server for the pipeline visualizer.
 *
 * - Serves files from dev-tools/pipeline-viz on http://localhost:4321
 * - SSE endpoint at /events streams "graph-updated" when pipeline-graph.json
 *   changes on disk, so the UI auto-reloads the graph without a page refresh.
 *
 * Zero dependencies on purpose — uses only node stdlib.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'dev-tools', 'pipeline-viz');
const GRAPH = path.join(ROOT, 'pipeline-graph.json');
const PORT = Number(process.env.VIZ_PORT) || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* ignored */ }
  }
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/trace' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 64_000) req.destroy(); });
    req.on('end', () => {
      try {
        const span = JSON.parse(body);
        broadcast('trace', span);
        res.writeHead(204);
        res.end();
      } catch {
        res.writeHead(400);
        res.end('bad json');
      }
    });
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // default to index.html
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // path-traversal guard
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  sendFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`[viz] serving ${path.relative(process.cwd(), ROOT)} → http://localhost:${PORT}`);
  if (!fs.existsSync(GRAPH)) {
    console.log('[viz] pipeline-graph.json not found yet — run "npm run viz:build" or "npm run viz:watch"');
  }
});

// Watch the graph file and notify connected clients
let debounceT = null;
fs.watch(ROOT, { persistent: true }, (_evt, filename) => {
  if (filename !== 'pipeline-graph.json') return;
  if (debounceT) clearTimeout(debounceT);
  debounceT = setTimeout(() => {
    broadcast('graph-updated', { at: new Date().toISOString() });
  }, 100);
});
