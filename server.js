const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

try { require('fs').readFileSync('.env', 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = process.env[m[1]] || m[2];
}); } catch {}

const PORT = process.env.PORT || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GEMINI_KEY = process.env.GEMINI_KEY;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function proxy(res, options, body) {
  const upstream = https.request(options, up => {
    res.writeHead(up.statusCode, { 'Content-Type': 'application/json' });
    up.pipe(res);
  });
  upstream.on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_error', message: err.message }));
  });
  if (body) upstream.write(body);
  upstream.end();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try {
    // CORS básico (mesma origem, mas útil pra dev)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    if (req.method === 'GET' && req.url.startsWith('/api/notion/schema')) {
      if (!NOTION_TOKEN) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing_env', message: 'NOTION_TOKEN não configurado' }));
      }
      const dbId = new URL(req.url, 'http://localhost').searchParams.get('databaseId') || DATABASE_ID;
      if (!dbId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing_database_id' }));
      }
      return proxy(res, {
        hostname: 'api.notion.com',
        path: `/v1/databases/${dbId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
        },
      });
    }

    if (req.method === 'POST' && req.url === '/api/notion') {
      if (!NOTION_TOKEN) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing_env', message: 'NOTION_TOKEN não configurado' }));
      }
      const raw = await readBody(req);
      let parsed = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_json' }));
      }
      const dbId = parsed.databaseId || DATABASE_ID;
      if (!dbId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing_database_id' }));
      }
      delete parsed.databaseId;
      const forward = JSON.stringify(parsed);
      return proxy(res, {
        hostname: 'api.notion.com',
        path: `/v1/databases/${dbId}/query`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(forward),
        },
      }, forward);
    }

    if (req.method === 'POST' && req.url === '/api/claude') {
      if (!ANTHROPIC_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing_env', message: 'ANTHROPIC_KEY não configurado' }));
      }
      const body = await readBody(req);
      return proxy(res, {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body || '{}'),
        },
      }, body || '{}');
    }

    if (req.method === 'POST' && req.url === '/api/gemini') {
      if (!GEMINI_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing_env', message: 'GEMINI_KEY não configurado' }));
      }
      const body = await readBody(req);
      const { prompt } = JSON.parse(body);
      const forward = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
      return proxy(res, {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(forward),
        },
      }, forward);
    }

    // Static: serve index.html na raiz e demais arquivos estáticos com segurança
    if (req.method === 'GET') {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const safePath = path.normalize(path.join(__dirname, urlPath));
      if (!safePath.startsWith(__dirname)) {
        res.writeHead(403); return res.end('Forbidden');
      }
      fs.readFile(safePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        const ext = path.extname(safePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'server_error', message: e.message }));
  }
});

server.listen(PORT, () => console.log(`Dashboard rodando em http://localhost:${PORT}`));
