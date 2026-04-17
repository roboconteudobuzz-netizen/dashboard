/**
 * meta.js — Cliente da Meta Graph API
 * Responsável por buscar posts e métricas do Instagram
 */

const https = require('https');

const BASE_URL = 'graph.facebook.com';
const API_VERSION = 'v21.0';

// ── Requisição genérica à Graph API ──
function graphRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();
    const options = {
      hostname: BASE_URL,
      path: `/${API_VERSION}/${path}?${query}`,
      method: 'GET',
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Graph API: ${parsed.error.message}`));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Erro ao parsear resposta: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

// ── Buscar ID da conta do Instagram vinculada ao token ──
async function getInstagramAccountId(accessToken) {
  const data = await graphRequest('me/accounts', { access_token: accessToken });
  if (!data.data?.length) throw new Error('Nenhuma Página do Facebook encontrada para este token.');

  // Busca a página que tem Instagram vinculado
  for (const page of data.data) {
    const ig = await graphRequest(`${page.id}`, {
      fields: 'instagram_business_account',
      access_token: page.access_token || accessToken,
    });
    if (ig.instagram_business_account?.id) {
      return {
        igAccountId: ig.instagram_business_account.id,
        pageAccessToken: page.access_token || accessToken,
      };
    }
  }
  throw new Error('Nenhuma conta Instagram Business encontrada vinculada às páginas do Facebook.');
}

// ── Buscar posts de um determinado mês ──
async function getPostsByMonth(igAccountId, accessToken, year, month) {
  const since = new Date(year, month - 1, 1);
  const until = new Date(year, month, 1);

  const sinceTs = Math.floor(since.getTime() / 1000);
  const untilTs = Math.floor(until.getTime() / 1000);

  let posts = [];
  let url = `${igAccountId}/media`;
  let params = {
    fields: 'id,timestamp,media_type,permalink,thumbnail_url,media_url,caption,like_count,comments_count',
    since: sinceTs,
    until: untilTs,
    limit: 50,
    access_token: accessToken,
  };

  // Paginação
  while (url) {
    const data = await graphRequest(url.replace(`/${API_VERSION}/`, ''), params);
    if (data.data) posts = posts.concat(data.data);
    url = data.paging?.next ? null : null; // Graph API retorna URL completa no next
    params = null; // nas próximas páginas usa o cursor
    if (data.paging?.cursors?.after && data.paging?.next) {
      url = `${igAccountId}/media`;
      params = {
        fields: 'id,timestamp,media_type,permalink,thumbnail_url,media_url,caption,like_count,comments_count',
        since: sinceTs,
        until: untilTs,
        limit: 50,
        access_token: accessToken,
        after: data.paging.cursors.after,
      };
    } else {
      break;
    }
  }

  // Filtrar Stories
  return posts.filter(p => p.media_type !== 'STORY');
}

// ── Buscar métricas de um post ──
async function getPostInsights(mediaId, mediaType, accessToken) {
  // Métricas variam por tipo de mídia
  const isReel = mediaType === 'VIDEO' || mediaType === 'REELS';

  const baseMetrics = ['reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];
  const extraMetrics = isReel ? ['video_views'] : ['impressions'];

  const result = {};

  // Buscar métricas base
  try {
    const data = await graphRequest(`${mediaId}/insights`, {
      metric: baseMetrics.join(','),
      access_token: accessToken,
    });
    (data.data || []).forEach(m => {
      result[m.name] = m.values?.[0]?.value ?? m.value ?? 0;
    });
  } catch (e) {
    console.warn(`  ⚠️  Não foi possível buscar insights do post ${mediaId}: ${e.message}`);
  }

  // Buscar métricas extras (podem não estar disponíveis para todos os tipos)
  try {
    const data = await graphRequest(`${mediaId}/insights`, {
      metric: extraMetrics.join(','),
      access_token: accessToken,
    });
    (data.data || []).forEach(m => {
      result[m.name] = m.values?.[0]?.value ?? m.value ?? 0;
    });
  } catch (_) {
    // silencioso — nem todos os tipos suportam essas métricas
  }

  return result;
}

// ── Buscar dados demográficos da conta (mês) ──
async function getAccountInsights(igAccountId, accessToken, year, month) {
  const since = new Date(year, month - 1, 1);
  const until = new Date(year, month, 1);

  const sinceTs = Math.floor(since.getTime() / 1000);
  const untilTs = Math.floor(until.getTime() / 1000);

  try {
    const data = await graphRequest(`${igAccountId}/insights`, {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      breakdown: 'gender,age,city',
      since: sinceTs,
      until: untilTs,
      access_token: accessToken,
    });
    return data.data ?? [];
  } catch (e) {
    console.warn(`  ⚠️  Não foi possível buscar demographics: ${e.message}`);
    return [];
  }
}

// ── Buscar total de seguidores ──
async function getFollowersCount(igAccountId, accessToken) {
  const data = await graphRequest(`${igAccountId}`, {
    fields: 'followers_count,username',
    access_token: accessToken,
  });
  return {
    followersCount: data.followers_count ?? 0,
    username: data.username ?? '',
  };
}

module.exports = {
  getInstagramAccountId,
  getPostsByMonth,
  getPostInsights,
  getAccountInsights,
  getFollowersCount,
};
