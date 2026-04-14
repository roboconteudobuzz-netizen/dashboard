const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

try { require('fs').readFileSync('.env', 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = process.env[m[1]] || m[2];
}); } catch {}

const PORT          = process.env.PORT || 3000;
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const DATABASE_ID   = process.env.DATABASE_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GEMINI_KEY    = process.env.GEMINI_KEY;
const META_APP_ID     = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL        = process.env.BASE_URL || `http://localhost:${PORT}`;
const CALLBACK_URL    = `${BASE_URL}/auth/callback`;

// ── Banco de dados ──
let db = null;
if (process.env.DATABASE_URL) {
  db = require('./db');
  db.setup().catch(e => console.error('Erro ao iniciar banco:', e.message));
}

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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    const url = new URL(req.url, BASE_URL);

    // ── ONBOARDING: página HTML ──
    if (req.method === 'GET' && url.pathname === '/onboarding') {
      const html = fs.readFileSync(path.join(__dirname, 'onboarding.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ── OAUTH: redirecionar para o Facebook ──
    if (req.method === 'GET' && url.pathname === '/auth/instagram') {
      const notionClientId = url.searchParams.get('cliente') || '';
      const scope = 'pages_show_list,instagram_basic,instagram_manage_insights,pages_read_engagement';
      const state = Buffer.from(JSON.stringify({ notionClientId })).toString('base64');
      const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=${scope}&state=${state}&response_type=code`;
      res.writeHead(302, { Location: authUrl });
      return res.end();
    }

    // ── OAUTH: callback do Facebook ──
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(302, { Location: `/onboarding?erro=${encodeURIComponent(url.searchParams.get('error_description') || error)}` });
        return res.end();
      }

      if (!code) {
        res.writeHead(302, { Location: '/onboarding?erro=Código+não+encontrado' });
        return res.end();
      }

      // 1. Trocar código por token de usuário
      const tokenData = await httpsPost('graph.facebook.com',
        `/v21.0/oauth/access_token`,
        { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: CALLBACK_URL, code }
      );

      if (tokenData.error) {
        res.writeHead(302, { Location: `/onboarding?erro=${encodeURIComponent(tokenData.error.message)}` });
        return res.end();
      }

      const userToken = tokenData.access_token;

      // 2. Buscar páginas com tokens permanentes
      const pagesData = await httpsGet(`https://graph.facebook.com/v21.0/me/accounts?access_token=${userToken}`);

      if (!pagesData.data?.length) {
        res.writeHead(302, { Location: '/onboarding?erro=Nenhuma+Página+do+Facebook+encontrada' });
        return res.end();
      }

      // 3. Para cada página, verificar se tem Instagram vinculado
      const pagesWithIg = [];
      for (const page of pagesData.data) {
        const igData = await httpsGet(
          `https://graph.facebook.com/v21.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
        );
        const igId = igData.instagram_business_account?.id;
        if (!igId) continue;
        pagesWithIg.push({
          pageId: page.id,
          pageName: page.name,
          accessToken: page.access_token,
          instagramAccountId: igId,
        });
      }

      if (!pagesWithIg.length) {
        res.writeHead(302, { Location: '/onboarding?erro=Nenhuma+conta+Instagram+Business+vinculada+encontrada' });
        return res.end();
      }

      // 4. Salvar como pendente e redirecionar para mapeamento
      const token = require('crypto').randomBytes(24).toString('hex');
      if (db) await db.savePending(token, pagesWithIg);

      res.writeHead(302, { Location: `/onboarding?step=mapping&token=${token}` });
      return res.end();
    }

    // ── API: buscar páginas pendentes para mapeamento ──
    if (req.method === 'GET' && url.pathname === '/api/pending') {
      const token = url.searchParams.get('token');
      if (!token || !db) { res.writeHead(400); return res.end(JSON.stringify({ error: 'invalid' })); }
      const pages = await db.getPending(token);
      if (!pages) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not_found_or_expired' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(pages));
    }

    // ── API: confirmar mapeamento e salvar clientes ──
    if (req.method === 'POST' && url.pathname === '/api/confirm-mapping') {
      if (!db) { res.writeHead(503); return res.end(JSON.stringify({ error: 'db_not_available' })); }
      const body = await readBody(req);
      const { token, mappings } = JSON.parse(body);
      // mappings = [{ pageId, notionClientId }]

      const pages = await db.getPending(token);
      if (!pages) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not_found_or_expired' })); }

      let saved = 0;
      for (const mapping of mappings) {
        if (!mapping.notionClientId?.trim()) continue;
        const page = pages.find(p => p.pageId === mapping.pageId);
        if (!page) continue;
        await db.upsertClient({
          notionClientId: mapping.notionClientId.trim(),
          pageId: page.pageId,
          pageName: page.pageName,
          accessToken: page.accessToken,
          instagramAccountId: page.instagramAccountId,
          notionDatabaseId: process.env.NOTION_DATABASE_ID || DATABASE_ID,
          notionToken: NOTION_TOKEN,
        });
        saved++;
      }

      await db.deletePending(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ saved }));
    }

    // ── API: listar clientes conectados ──
    if (req.method === 'GET' && url.pathname === '/api/clients') {
      if (!db) { res.writeHead(503); return res.end(JSON.stringify({ error: 'db_not_available' })); }
      const clients = await db.getAllClients();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(clients.map(c => ({ id: c.notion_client_id, name: c.page_name }))));
    }

    // ── API Notion schema ──
    if (req.method === 'GET' && url.pathname.startsWith('/api/notion/schema')) {
      if (!NOTION_TOKEN) { res.writeHead(500); return res.end(JSON.stringify({ error: 'missing_env' })); }
      const dbId = url.searchParams.get('databaseId') || DATABASE_ID;
      return proxy(res, {
        hostname: 'api.notion.com', path: `/v1/databases/${dbId}`, method: 'GET',
        headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
      });
    }

    // ── API Notion query ──
    if (req.method === 'POST' && url.pathname === '/api/notion') {
      if (!NOTION_TOKEN) { res.writeHead(500); return res.end(JSON.stringify({ error: 'missing_env' })); }
      const raw = await readBody(req);
      let parsed = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400); return res.end(JSON.stringify({ error: 'invalid_json' })); }
      const dbId = parsed.databaseId || DATABASE_ID;
      delete parsed.databaseId;
      const forward = JSON.stringify(parsed);
      return proxy(res, {
        hostname: 'api.notion.com', path: `/v1/databases/${dbId}/query`, method: 'POST',
        headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(forward) },
      }, forward);
    }

    // ── API Claude ──
    if (req.method === 'POST' && url.pathname === '/api/claude') {
      if (!ANTHROPIC_KEY) { res.writeHead(500); return res.end(JSON.stringify({ error: 'missing_env' })); }
      const body = await readBody(req);
      return proxy(res, {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body || '{}') },
      }, body || '{}');
    }

    // ── API Gemini ──
    if (req.method === 'POST' && url.pathname === '/api/gemini') {
      if (!GEMINI_KEY) { res.writeHead(500); return res.end(JSON.stringify({ error: 'missing_env' })); }
      const body = await readBody(req);
      const { prompt } = JSON.parse(body);
      const forward = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
      return proxy(res, {
        hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(forward) },
      }, forward);
    }

    // ── Arquivos estáticos ──
    if (req.method === 'GET') {
      let urlPath = decodeURIComponent(url.pathname);
      if (urlPath === '/') urlPath = '/index.html';
      const safePath = path.normalize(path.join(__dirname, urlPath));
      if (!safePath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
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
