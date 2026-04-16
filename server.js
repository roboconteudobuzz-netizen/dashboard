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

// ── Helpers HTTP ──
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

// ── Helpers de sessão ──
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

async function getSessionAgency(req) {
  if (!db) return null;
  const cookies = parseCookies(req);
  const sessionToken = cookies['session'];
  if (!sessionToken) return null;
  return db.getAgencyBySession(sessionToken);
}

function setSessionCookie(res, sessionToken) {
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
  const secure = BASE_URL.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expires}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    const url = new URL(req.url, BASE_URL);

    // ── Dashboard principal: requer sessão ──
    if (req.method === 'GET' && url.pathname === '/') {
      const agency = await getSessionAgency(req);
      if (!agency) {
        res.writeHead(302, { Location: '/onboarding' });
        return res.end();
      }
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ── Página de configurações: requer sessão ──
    if (req.method === 'GET' && url.pathname === '/configuracoes') {
      const agency = await getSessionAgency(req);
      if (!agency) {
        res.writeHead(302, { Location: '/onboarding' });
        return res.end();
      }
      const html = fs.readFileSync(path.join(__dirname, 'configuracoes.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ── Onboarding: página de login ──
    if (req.method === 'GET' && url.pathname === '/onboarding') {
      const html = fs.readFileSync(path.join(__dirname, 'onboarding.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ── Logout ──
    if (req.method === 'GET' && url.pathname === '/logout') {
      clearSessionCookie(res);
      res.writeHead(302, { Location: '/onboarding' });
      return res.end();
    }

    // ── OAUTH: redirecionar para o Facebook ──
    if (req.method === 'GET' && url.pathname === '/auth/instagram') {
      const scope = 'pages_show_list,instagram_basic,instagram_manage_insights,pages_read_engagement,business_management';
      const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=${scope}&response_type=code`;
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

      // 2. Buscar ID e nome do usuário
      const meData = await httpsGet(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${userToken}`);
      const facebookUserId = meData.id;
      const facebookUserName = meData.name;

      // 3. Buscar páginas — tenta via /me/businesses primeiro, cai em /me/accounts como fallback
      const allPages = new Map(); // pageId → page (deduplicado)

      // 3a. Via Business Manager (/me/businesses)
      try {
        const businessesData = await httpsGet(`https://graph.facebook.com/v21.0/me/businesses?access_token=${userToken}`);
        if (businessesData.data?.length) {
          for (const business of businessesData.data) {
            const ownedPages = await httpsGet(
              `https://graph.facebook.com/v21.0/${business.id}/owned_pages?fields=id,name,access_token&access_token=${userToken}`
            );
            for (const page of (ownedPages.data || [])) {
              if (page.access_token) allPages.set(page.id, page);
            }
            // Páginas de clientes gerenciadas pelo Business Manager
            const clientPages = await httpsGet(
              `https://graph.facebook.com/v21.0/${business.id}/client_pages?fields=id,name,access_token&access_token=${userToken}`
            );
            for (const page of (clientPages.data || [])) {
              if (page.access_token) allPages.set(page.id, page);
            }
          }
        }
      } catch (e) {
        console.log('   ⚠️  /me/businesses indisponível, usando /me/accounts:', e.message);
      }

      // 3b. Via /me/accounts (fallback ou complemento)
      const accountsData = await httpsGet(`https://graph.facebook.com/v21.0/me/accounts?access_token=${userToken}`);
      for (const page of (accountsData.data || [])) {
        if (!allPages.has(page.id)) allPages.set(page.id, page);
      }

      if (!allPages.size) {
        res.writeHead(302, { Location: '/onboarding?erro=Nenhuma+Página+do+Facebook+encontrada' });
        return res.end();
      }

      // 4. Para cada página, verificar se tem Instagram vinculado
      const pagesWithIg = [];
      for (const page of allPages.values()) {
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

      // 5. Criar sessão e salvar agência
      const sessionToken = require('crypto').randomBytes(24).toString('hex');
      if (db) {
        await db.upsertAgency(facebookUserId, facebookUserName, sessionToken);

        // Filtrar páginas que já estão mapeadas no banco
        const alreadyMapped = await db.getClientsByAgency(facebookUserId);
        const mappedPageIds = new Set(alreadyMapped.map(c => c.page_id));
        const newPages = pagesWithIg.filter(p => !mappedPageIds.has(p.pageId));

        if (newPages.length) {
          const pendingToken = require('crypto').randomBytes(24).toString('hex');
          await db.savePendingForAgency(facebookUserId, pendingToken, newPages);
        } else {
          // Sem páginas novas — limpa pendentes antigos
          await db.deletePendingByAgency(facebookUserId);
        }
      }

      setSessionCookie(res, sessionToken);
      res.writeHead(302, { Location: '/configuracoes' });
      return res.end();
    }

    // ══════════════════════════════════════════
    //  API: AGENCY
    // ══════════════════════════════════════════

    // GET /api/agency/settings — retorna configurações da agência logada
    if (req.method === 'GET' && url.pathname === '/api/agency/settings') {
      const agency = await getSessionAgency(req);
      if (!agency) { res.writeHead(401); return res.end(JSON.stringify({ error: 'unauthorized' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: agency.facebook_user_name,
        notionDatabaseId: agency.notion_database_id || '',
        hasNotion: !!(agency.notion_token && agency.notion_database_id),
      }));
    }

    // POST /api/agency/settings — salva configurações do Notion
    if (req.method === 'POST' && url.pathname === '/api/agency/settings') {
      const agency = await getSessionAgency(req);
      if (!agency) { res.writeHead(401); return res.end(JSON.stringify({ error: 'unauthorized' })); }
      const body = JSON.parse(await readBody(req));
      const { notionToken, notionDatabaseId } = body;
      if (!notionToken || !notionDatabaseId) {
        res.writeHead(400); return res.end(JSON.stringify({ error: 'Campos obrigatórios faltando' }));
      }
      // Validar token consultando o banco do Notion
      const testResult = await httpsGet(
        `https://api.notion.com/v1/databases/${notionDatabaseId.trim()}`
      ).catch(() => null);
      // Fazemos via fetch com auth header — reescrevendo com https
      const notionCheck = await new Promise(resolve => {
        const r = https.request({
          hostname: 'api.notion.com',
          path: `/v1/databases/${notionDatabaseId.trim()}`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${notionToken.trim()}`, 'Notion-Version': '2022-06-28' },
        }, resp => {
          let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        });
        r.on('error', () => resolve(null));
        r.end();
      });
      if (!notionCheck || notionCheck.object === 'error') {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: notionCheck?.message || 'Token ou Database ID inválido' }));
      }
      await db.updateAgencyNotion(agency.facebook_user_id, notionToken.trim(), notionDatabaseId.trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /api/agency/pages — retorna páginas pendentes + já mapeadas
    if (req.method === 'GET' && url.pathname === '/api/agency/pages') {
      const agency = await getSessionAgency(req);
      if (!agency) { res.writeHead(401); return res.end(JSON.stringify({ error: 'unauthorized' })); }

      // Páginas ainda não mapeadas (pendentes do OAuth)
      const pending = await db.getPendingByAgency(agency.facebook_user_id);
      const pendingPages = pending?.pages || [];

      // Páginas já mapeadas
      const mapped = await db.getClientsByAgency(agency.facebook_user_id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        pendingToken: pending?.token || null,
        pending: pendingPages.map(p => ({
          pageId: p.pageId,
          pageName: p.pageName,
          instagramAccountId: p.instagramAccountId,
          // accessToken nunca é enviado ao cliente
        })),
        mapped: mapped.map(c => ({
          pageId: c.page_id,
          pageName: c.page_name,
          instagramAccountId: c.instagram_account_id,
          notionClientId: c.notion_client_id,
        })),
      }));
    }

    // DELETE /api/agency/pages/:pageId — desvincula uma página
    if (req.method === 'POST' && url.pathname === '/api/agency/unlink') {
      const agency = await getSessionAgency(req);
      if (!agency) { res.writeHead(401); return res.end(JSON.stringify({ error: 'unauthorized' })); }
      const body = JSON.parse(await readBody(req));
      const { pageId } = body;
      if (!pageId) { res.writeHead(400); return res.end(JSON.stringify({ error: 'pageId obrigatório' })); }
      await db.deleteClientByPageId(pageId, agency.facebook_user_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /api/notion/clients — retorna opções de ID CLIENTE do Notion (para dropdown)
    if (req.method === 'GET' && url.pathname === '/api/notion/clients') {
      const agency = await getSessionAgency(req);
      const nToken = agency?.notion_token || NOTION_TOKEN;
      const nDbId  = agency?.notion_database_id || DATABASE_ID;
      if (!nToken || !nDbId) { res.writeHead(400); return res.end(JSON.stringify({ error: 'notion_not_configured' })); }

      const schema = await new Promise(resolve => {
        const r = https.request({
          hostname: 'api.notion.com', path: `/v1/databases/${nDbId}`, method: 'GET',
          headers: { 'Authorization': `Bearer ${nToken}`, 'Notion-Version': '2022-06-28' },
        }, resp => {
          let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        });
        r.on('error', () => resolve(null));
        r.end();
      });

      if (!schema || schema.object === 'error') {
        res.writeHead(500); return res.end(JSON.stringify({ error: 'Erro ao buscar schema do Notion' }));
      }

      // Procura a propriedade de tipo select que tem o ID do cliente
      let clients = [];
      for (const [name, prop] of Object.entries(schema.properties || {})) {
        if (prop.type === 'select' && (name.includes('CLIENTE') || name.includes('Cliente') || name.includes('cliente') || name === 'ID CLIENTE')) {
          clients = (prop.select?.options || []).map(o => ({ id: o.name, name: o.name }));
          break;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(clients));
    }

    // ── API: confirmar mapeamento e salvar clientes ──
    if (req.method === 'POST' && url.pathname === '/api/confirm-mapping') {
      if (!db) { res.writeHead(503); return res.end(JSON.stringify({ error: 'db_not_available' })); }

      const agency = await getSessionAgency(req);
      const body = await readBody(req);
      const { token, mappings } = JSON.parse(body);

      const pages = await db.getPending(token);
      if (!pages) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not_found_or_expired' })); }

      const nToken = agency?.notion_token || NOTION_TOKEN;
      const nDbId  = agency?.notion_database_id || (process.env.NOTION_DATABASE_ID || DATABASE_ID);

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
          notionDatabaseId: nDbId,
          notionToken: nToken,
          facebookUserId: agency?.facebook_user_id || null,
        });
        saved++;
      }

      await db.deletePending(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ saved }));
    }

    // ── API: listar clientes conectados (requer sessão) ──
    if (req.method === 'GET' && url.pathname === '/api/clients') {
      if (!db) { res.writeHead(503); return res.end(JSON.stringify({ error: 'db_not_available' })); }
      const agency = await getSessionAgency(req);
      if (!agency) { res.writeHead(401); return res.end(JSON.stringify({ error: 'unauthorized' })); }
      const clients = await db.getClientsByAgency(agency.facebook_user_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(clients.map(c => ({ id: c.notion_client_id, name: c.page_name }))));
    }

    // ── API Notion schema ──
    if (req.method === 'GET' && url.pathname.startsWith('/api/notion/schema')) {
      const agency = await getSessionAgency(req);
      const nToken = agency?.notion_token || NOTION_TOKEN;
      const nDbId  = url.searchParams.get('databaseId') || agency?.notion_database_id || DATABASE_ID;
      if (!nToken) { res.writeHead(500); return res.end(JSON.stringify({ error: 'missing_env' })); }
      return proxy(res, {
        hostname: 'api.notion.com', path: `/v1/databases/${nDbId}`, method: 'GET',
        headers: { 'Authorization': `Bearer ${nToken}`, 'Notion-Version': '2022-06-28' },
      });
    }

    // ── API Notion query ──
    if (req.method === 'POST' && url.pathname === '/api/notion') {
      const agency = await getSessionAgency(req);
      const nToken = agency?.notion_token || NOTION_TOKEN;
      if (!nToken) { res.writeHead(500); return res.end(JSON.stringify({ error: 'missing_env' })); }
      const raw = await readBody(req);
      let parsed = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400); return res.end(JSON.stringify({ error: 'invalid_json' })); }
      const nDbId = parsed.databaseId || agency?.notion_database_id || DATABASE_ID;
      delete parsed.databaseId;
      const forward = JSON.stringify(parsed);
      return proxy(res, {
        hostname: 'api.notion.com', path: `/v1/databases/${nDbId}/query`, method: 'POST',
        headers: { 'Authorization': `Bearer ${nToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(forward) },
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
    console.error('Server error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'server_error', message: e.message }));
  }
});

server.listen(PORT, () => console.log(`Dashboard rodando em http://localhost:${PORT}`));
