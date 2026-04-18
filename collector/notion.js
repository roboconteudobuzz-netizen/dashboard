/**
 * notion.js — Cliente do Notion
 * Responsável por inserir e atualizar registros no banco de métricas
 */

const https = require('https');

const NOTION_VERSION = '2022-06-28';

// ── Requisição genérica ao Notion ──
function notionRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      path: `/v1/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.object === 'error') return reject(new Error(`Notion: ${parsed.message}`));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Erro ao parsear resposta Notion: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Verificar se um post já existe no Notion (pelo Link do post) ──
async function findExistingPost(databaseId, token, permalink) {
  const data = await notionRequest('POST', `databases/${databaseId}/query`, token, {
    filter: { property: 'Link do post', url: { equals: permalink } },
    page_size: 1,
  });
  return data.results?.[0] ?? null;
}

// ── Montar propriedades para o Notion ──
function buildProperties(post, clientId, mes) {
  const props = {};

  // Título (legenda resumida)
  const titulo = (post.caption || post.permalink || '—').substring(0, 100);
  props['Conteúdo (métrica)'] = { title: [{ text: { content: titulo } }] };

  // Selects
  props['ID CLIENTE']     = { select: { name: clientId } };
  props['Plataforma']     = { select: { name: 'Instagram' } };
  props['Mês postagem']   = { select: { name: mes } };

  // Tipo de conteúdo
  const tipoMap = { IMAGE: 'Foto', VIDEO: 'Reels', CAROUSEL_ALBUM: 'Carrossel', REELS: 'Reels' };
  const tipo = tipoMap[post.media_type] || 'Foto';
  props['Tipo de conteúdo'] = { select: { name: tipo } };

  // URL e datas
  if (post.permalink) props['Link do post'] = { url: post.permalink };
  if (post.timestamp) props['Data da coleta'] = { date: { start: new Date().toISOString().split('T')[0] } };
  if (post.timestamp) props['Horário publicação'] = { date: { start: post.timestamp } };

  // Capa (thumbnail ou imagem)
  const capaUrl = post.thumbnail_url || post.media_url;
  if (capaUrl) props['Capa'] = { files: [{ name: 'capa', external: { url: capaUrl } }] };

  // Métricas numéricas
  const ins = post.insights || {};
  if (ins.reach         != null) props['Alcance']              = { number: ins.reach };
  if (ins.impressions   != null) props['Impressões']           = { number: ins.impressions };
  const curtidas = ins.likes ?? post.like_count;
  const comentarios = ins.comments ?? post.comments_count;
  if (curtidas   != null) props['Curtidas']    = { number: curtidas };
  if (comentarios != null) props['Comentários'] = { number: comentarios };
  if (ins.shares        != null) props['Compartilhamentos']    = { number: ins.shares };
  if (ins.saved         != null) props['Salvamentos']          = { number: ins.saved };
  if (ins.plays != null || ins.video_views != null) {
    props['Views'] = { number: ins.plays ?? ins.video_views ?? 0 };
  }
  if (ins.total_interactions != null) {
    props['Engajamento total'] = { number: ins.total_interactions };
  }

  // Seguidores
  if (post.followersCount != null) props['Seguidores totais'] = { number: post.followersCount };

  // Dados demográficos (nível de conta)
  if (post.segSexo)    props['Distribuição sexo'] = { rich_text: [{ text: { content: post.segSexo } }] };
  if (post.segIdade)   props['Faixa etária']      = { rich_text: [{ text: { content: post.segIdade } }] };
  if (post.segCidades) props['Top cidades']       = { rich_text: [{ text: { content: post.segCidades } }] };

  return props;
}

// ── Criar página no Notion ──
async function createPost(databaseId, token, post, clientId, mes) {
  const properties = buildProperties(post, clientId, mes);
  return notionRequest('POST', 'pages', token, {
    parent: { database_id: databaseId },
    properties,
  });
}

// ── Atualizar página existente no Notion ──
async function updatePost(pageId, token, post, clientId, mes) {
  const properties = buildProperties(post, clientId, mes);
  return notionRequest('PATCH', `pages/${pageId}`, token, { properties });
}

// ── Upsert: cria ou atualiza ──
async function upsertPost(databaseId, token, post, clientId, mes) {
  if (!post.permalink) {
    console.warn('  ⚠️  Post sem permalink, pulando...');
    return;
  }
  const existing = await findExistingPost(databaseId, token, post.permalink);
  if (existing) {
    await updatePost(existing.id, token, post, clientId, mes);
    return { action: 'updated', id: existing.id };
  } else {
    const created = await createPost(databaseId, token, post, clientId, mes);
    return { action: 'created', id: created.id };
  }
}

module.exports = { upsertPost };
