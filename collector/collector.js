/**
 * collector.js — Lógica principal de coleta
 * Orquestra a busca de dados no Meta e inserção no Notion
 *
 * Uso:
 *   node collector.js                     → coleta o mês anterior (modo cron)
 *   node collector.js --mes "Março 2026"  → coleta um mês específico
 *   node collector.js --agencia buzz-media → coleta só uma agência
 */

const meta   = require('./meta');
const notion = require('./notion');
const path   = require('path');

// ── Carregar agências ──
async function loadAgencies() {
  // Modo banco de dados (Railway com OAuth configurado)
  if (process.env.DATABASE_URL) {
    const db = require(path.join(__dirname, '..', 'db'));
    const clients = await db.getAllClients();
    if (clients.length) {
      console.log(`   📋 ${clients.length} cliente(s) carregado(s) do banco`);
      // Agrupar por notion_database_id (uma "agência" por database)
      const agencyMap = {};
      for (const c of clients) {
        const key = c.notion_database_id;
        if (!agencyMap[key]) {
          agencyMap[key] = {
            id: key,
            name: 'Agência',
            notionToken: c.notion_token,
            notionDatabaseId: c.notion_database_id,
            clients: [],
          };
        }
        agencyMap[key].clients.push({
          id: c.notion_client_id,
          metaAccessToken: c.access_token,
          instagramAccountId: c.instagram_account_id,
        });
      }
      return Object.values(agencyMap);
    }
  }

  // Modo local — lê do agencies.json
  try {
    return require('./agencies.json');
  } catch {
    console.error('❌ Nenhuma configuração de agência encontrada.');
    process.exit(1);
  }
}

// ── Mapear nome do mês para número ──
const MESES = {
  'Janeiro':   1, 'Fevereiro': 2, 'Março':    3, 'Abril':    4,
  'Maio':      5, 'Junho':     6, 'Julho':    7, 'Agosto':   8,
  'Setembro':  9, 'Outubro':  10, 'Novembro': 11, 'Dezembro': 12,
};

function parseMes(mesStr) {
  // Ex: "Março 2026" → { month: 3, year: 2026, label: "Março 2026" }
  const [nome, ano] = mesStr.split(' ');
  return { month: MESES[nome], year: parseInt(ano), label: mesStr };
}

function getMesAnterior() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const nomeMes = Object.keys(MESES).find(k => MESES[k] === d.getMonth() + 1);
  return `${nomeMes} ${d.getFullYear()}`;
}

// ── Formatar dados demográficos ──
function formatDemographics(accountInsights) {
  let segSexo = '', segIdade = '', segCidades = '';

  accountInsights.forEach(metric => {
    if (metric.name === 'follower_demographics') {
      const breakdown = metric.total_value?.breakdowns?.[0];
      if (!breakdown) return;

      const results = breakdown.results || [];
      const dimensionKeys = breakdown.dimension_keys || [];

      if (dimensionKeys.includes('gender')) {
        const genders = {};
        results.forEach(r => {
          const gender = r.dimension_values?.[dimensionKeys.indexOf('gender')];
          if (gender) genders[gender] = (genders[gender] || 0) + r.value;
        });
        const total = Object.values(genders).reduce((a, b) => a + b, 0);
        if (total > 0) {
          segSexo = Object.entries(genders)
            .map(([g, v]) => `${g}: ${((v / total) * 100).toFixed(1)}%`)
            .join(' | ');
        }
      }

      if (dimensionKeys.includes('age')) {
        const ages = {};
        results.forEach(r => {
          const age = r.dimension_values?.[dimensionKeys.indexOf('age')];
          if (age) ages[age] = (ages[age] || 0) + r.value;
        });
        const total = Object.values(ages).reduce((a, b) => a + b, 0);
        if (total > 0) {
          segIdade = Object.entries(ages)
            .sort((a, b) => b[1] - a[1])
            .map(([a, v]) => `${a}: ${((v / total) * 100).toFixed(1)}%`)
            .join(' | ');
        }
      }

      if (dimensionKeys.includes('city')) {
        const cities = {};
        results.forEach(r => {
          const city = r.dimension_values?.[dimensionKeys.indexOf('city')];
          if (city) cities[city] = (cities[city] || 0) + r.value;
        });
        segCidades = Object.entries(cities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([c]) => c)
          .join(' | ');
      }
    }
  });

  return { segSexo, segIdade, segCidades };
}

// ── Coletar dados de um cliente específico (com token próprio) ──
async function collectClient(client, agency, mesConfig) {
  const token = client.metaAccessToken || agency.metaAccessToken;

  // Se o cliente já tem igAccountId salvo no banco, usa direto
  let igAccountId, pageAccessToken;
  if (client.instagramAccountId) {
    igAccountId = client.instagramAccountId;
    pageAccessToken = token;
  } else {
    const result = await meta.getInstagramAccountId(token);
    igAccountId = result.igAccountId;
    pageAccessToken = result.pageAccessToken;
  }

  return { igAccountId, pageAccessToken };
}

// ── Coletar dados de uma agência ──
async function collectAgency(agency, mesConfig, dryRun = false) {
  console.log(`\n📦 Agência: ${agency.name}`);
  console.log(`   Mês: ${mesConfig.label}`);

  // Se cada cliente tem token próprio (modo banco), coletar por cliente
  const hasPerClientTokens = agency.clients.some(c => c.metaAccessToken);

  if (hasPerClientTokens) {
    let created = 0, updated = 0, errors = 0;
    for (const client of agency.clients) {
      console.log(`\n   👤 Cliente: ${client.id}`);
      try {
        const { igAccountId, pageAccessToken } = await collectClient(client, agency, mesConfig);
        console.log(`   ✅ Instagram ID: ${igAccountId}`);

        const [{ followersCount }, accountInsights] = await Promise.all([
          meta.getFollowersCount(igAccountId, pageAccessToken),
          meta.getAccountInsights(igAccountId, pageAccessToken, mesConfig.year, mesConfig.month),
        ]);
        const demographics = formatDemographics(accountInsights);

        const posts = await meta.getPostsByMonth(igAccountId, pageAccessToken, mesConfig.year, mesConfig.month);
        console.log(`   ✅ ${posts.length} posts encontrados`);

        for (const post of posts) {
          process.stdout.write(`   📊 Post ${post.id}... `);
          try {
            const insights = await meta.getPostInsights(post.id, post.media_type, pageAccessToken);
            const enriched = { ...post, insights, followersCount, ...demographics };
            if (dryRun) {
              console.log(`\n      [DRY-RUN] Seria gravado no Notion:`);
              console.log(`        Cliente: ${client.id} | Mês: ${mesConfig.label}`);
              console.log(`        Post ID: ${post.id} | Tipo: ${post.media_type}`);
              console.log(`        Curtidas: ${insights.like_count ?? '-'} | Comentários: ${insights.comments_count ?? '-'} | Alcance: ${insights.reach ?? '-'}`);
              console.log(`        Seguidores: ${followersCount}`);
              created++;
            } else {
              const result = await notion.upsertPost(agency.notionDatabaseId, agency.notionToken, enriched, client.id, mesConfig.label);
              if (result.action === 'created') created++; else updated++;
            }
            console.log('✅');
          } catch (e) { console.log(`❌ ${e.message}`); errors++; }
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) {
        console.error(`   ❌ Erro no cliente ${client.id}: ${e.message}`);
        errors++;
      }
    }
    console.log(`\n   📈 Resultado: ${created} criados | ${updated} atualizados | ${errors} erros`);
    return;
  }

  // Modo token único da agência (variáveis de ambiente)
  // 1. Buscar conta Instagram
  console.log('   🔍 Buscando conta Instagram...');
  const { igAccountId, pageAccessToken } = await meta.getInstagramAccountId(agency.metaAccessToken);
  console.log(`   ✅ Instagram ID: ${igAccountId}`);

  // 2. Buscar seguidores e demografia
  console.log('   👥 Buscando dados da conta...');
  const [{ followersCount }, accountInsights] = await Promise.all([
    meta.getFollowersCount(igAccountId, pageAccessToken),
    meta.getAccountInsights(igAccountId, pageAccessToken, mesConfig.year, mesConfig.month),
  ]);
  const demographics = formatDemographics(accountInsights);
  console.log(`   ✅ Seguidores: ${followersCount}`);

  // 3. Buscar posts do mês
  console.log(`   📸 Buscando posts de ${mesConfig.label}...`);
  const posts = await meta.getPostsByMonth(igAccountId, pageAccessToken, mesConfig.year, mesConfig.month);
  console.log(`   ✅ ${posts.length} posts encontrados`);

  if (!posts.length) {
    console.log('   ⚠️  Nenhum post encontrado para este mês.');
    return;
  }

  // 4. Para cada post: buscar insights e inserir no Notion
  let created = 0, updated = 0, errors = 0;

  for (const post of posts) {
    process.stdout.write(`   📊 Post ${post.id} (${post.media_type})... `);
    try {
      const insights = await meta.getPostInsights(post.id, post.media_type, pageAccessToken);
      const enriched = {
        ...post,
        insights,
        followersCount,
        ...demographics,
      };

      // Para cada cliente da agência no Notion
      for (const client of agency.clients) {
        if (dryRun) {
          console.log(`\n      [DRY-RUN] Seria gravado no Notion:`);
          console.log(`        Cliente: ${client.id} | Mês: ${mesConfig.label}`);
          console.log(`        Post ID: ${post.id} | Tipo: ${post.media_type}`);
          console.log(`        Curtidas: ${insights.like_count ?? '-'} | Comentários: ${insights.comments_count ?? '-'} | Alcance: ${insights.reach ?? '-'}`);
          console.log(`        Seguidores: ${followersCount}`);
          created++;
        } else {
          const result = await notion.upsertPost(
            agency.notionDatabaseId,
            agency.notionToken,
            enriched,
            client.id,
            mesConfig.label,
          );
          if (result.action === 'created') created++;
          else updated++;
        }
      }
      console.log('✅');
    } catch (e) {
      console.log(`❌ ${e.message}`);
      errors++;
    }

    // Pequena pausa para não bater rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n   📈 Resultado: ${created} criados | ${updated} atualizados | ${errors} erros`);
}

// ── Entry point ──
async function main() {
  const args = process.argv.slice(2);

  // Parsear argumentos
  const mesArg     = args[args.indexOf('--mes') + 1];
  const agenciaArg = args[args.indexOf('--agencia') + 1];
  const dryRun     = args.includes('--dry-run');

  if (dryRun) {
    console.log('🧪 MODO DRY-RUN — nenhum dado será gravado no Notion\n');
  }

  const mesStr = mesArg || getMesAnterior();
  const mesConfig = parseMes(mesStr);

  if (!mesConfig.month || !mesConfig.year) {
    console.error(`❌ Mês inválido: "${mesStr}". Use o formato "Março 2026"`);
    process.exit(1);
  }

  // Carregar e filtrar agências
  const agencies = await loadAgencies();
  const targets = agenciaArg
    ? agencies.filter(a => a.id === agenciaArg)
    : agencies;

  if (!targets.length) {
    console.error(`❌ Nenhuma agência encontrada${agenciaArg ? ` com id "${agenciaArg}"` : ''}`);
    process.exit(1);
  }

  console.log(`🚀 Iniciando coleta — ${mesConfig.label}`);
  console.log(`   ${targets.length} agência(s) para processar\n`);

  for (const agency of targets) {
    try {
      await collectAgency(agency, mesConfig, dryRun);
    } catch (e) {
      console.error(`\n❌ Erro na agência ${agency.name}: ${e.message}`);
    }
  }

  console.log('\n✅ Coleta finalizada!');
}

main().catch(e => {
  console.error('Erro fatal:', e);
  process.exit(1);
});
