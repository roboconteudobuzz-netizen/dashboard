const https = require('https');

function proxy(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.DATABASE_ID;

  if (!NOTION_TOKEN) return res.status(500).json({ error: 'missing_env', message: 'NOTION_TOKEN não configurado' });

  const parsed = req.body || {};
  const dbId = parsed.databaseId || DATABASE_ID;
  if (!dbId) return res.status(400).json({ error: 'missing_database_id' });

  delete parsed.databaseId;
  const forward = JSON.stringify(parsed);

  try {
    const result = await proxy({
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

    res.status(result.statusCode).setHeader('Content-Type', 'application/json').end(result.body);
  } catch (err) {
    res.status(502).json({ error: 'upstream_error', message: err.message });
  }
};
