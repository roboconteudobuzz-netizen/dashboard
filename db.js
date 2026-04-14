/**
 * db.js — Conexão e setup do banco de dados PostgreSQL
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

// ── Criar tabelas se não existirem ──
async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id                   SERIAL PRIMARY KEY,
      notion_client_id     VARCHAR(100) NOT NULL,
      page_id              VARCHAR(100),
      page_name            VARCHAR(200),
      access_token         TEXT NOT NULL,
      instagram_account_id VARCHAR(100),
      notion_database_id   VARCHAR(100),
      notion_token         TEXT,
      created_at           TIMESTAMP DEFAULT NOW(),
      updated_at           TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Banco de dados pronto');
}

// ── Salvar ou atualizar cliente ──
async function upsertClient({ notionClientId, pageId, pageName, accessToken, instagramAccountId, notionDatabaseId, notionToken }) {
  const existing = await pool.query(
    'SELECT id FROM clients WHERE page_id = $1',
    [pageId]
  );

  if (existing.rows.length) {
    await pool.query(
      `UPDATE clients SET
        notion_client_id = $1, page_name = $2, access_token = $3,
        instagram_account_id = $4, notion_database_id = $5, notion_token = $6,
        updated_at = NOW()
       WHERE page_id = $7`,
      [notionClientId, pageName, accessToken, instagramAccountId, notionDatabaseId, notionToken, pageId]
    );
  } else {
    await pool.query(
      `INSERT INTO clients
        (notion_client_id, page_id, page_name, access_token, instagram_account_id, notion_database_id, notion_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [notionClientId, pageId, pageName, accessToken, instagramAccountId, notionDatabaseId, notionToken]
    );
  }
}

// ── Buscar todos os clientes ──
async function getAllClients() {
  const result = await pool.query('SELECT * FROM clients ORDER BY page_name');
  return result.rows;
}

// ── Buscar cliente por notion_client_id ──
async function getClientByNotionId(notionClientId) {
  const result = await pool.query(
    'SELECT * FROM clients WHERE notion_client_id = $1',
    [notionClientId]
  );
  return result.rows[0] ?? null;
}

module.exports = { setup, upsertClient, getAllClients, getClientByNotionId };
