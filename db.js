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
    CREATE TABLE IF NOT EXISTS agencies (
      id                   SERIAL PRIMARY KEY,
      facebook_user_id     VARCHAR(100) UNIQUE NOT NULL,
      facebook_user_name   VARCHAR(200),
      notion_token         TEXT,
      notion_database_id   VARCHAR(100),
      session_token        VARCHAR(64),
      session_expires_at   TIMESTAMP,
      created_at           TIMESTAMP DEFAULT NOW(),
      updated_at           TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clients (
      id                   SERIAL PRIMARY KEY,
      notion_client_id     VARCHAR(100) NOT NULL,
      page_id              VARCHAR(100),
      page_name            VARCHAR(200),
      access_token         TEXT NOT NULL,
      instagram_account_id VARCHAR(100),
      notion_database_id   VARCHAR(100),
      notion_token         TEXT,
      facebook_user_id     VARCHAR(100),
      created_at           TIMESTAMP DEFAULT NOW(),
      updated_at           TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pending_connections (
      token              VARCHAR(64) PRIMARY KEY,
      pages              JSONB NOT NULL,
      facebook_user_id   VARCHAR(100),
      created_at         TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migrações seguras para tabelas já existentes
  await pool.query(`
    ALTER TABLE pending_connections ADD COLUMN IF NOT EXISTS facebook_user_id VARCHAR(100);
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS facebook_user_id VARCHAR(100);
    ALTER TABLE agencies ADD COLUMN IF NOT EXISTS user_access_token TEXT;
    ALTER TABLE agencies ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP;
    ALTER TABLE clients DROP COLUMN IF EXISTS notion_token;
    ALTER TABLE clients DROP COLUMN IF EXISTS notion_database_id;
  `);

  console.log('✅ Banco de dados pronto');
}

// ══════════════════════════════════════════
//  AGENCIES
// ══════════════════════════════════════════

async function upsertAgency(facebookUserId, name, sessionToken, userAccessToken, tokenExpiresAt) {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias (sessão)
  await pool.query(
    `INSERT INTO agencies (facebook_user_id, facebook_user_name, session_token, session_expires_at, user_access_token, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (facebook_user_id) DO UPDATE SET
       facebook_user_name = $2,
       session_token = $3,
       session_expires_at = $4,
       user_access_token = COALESCE($5, agencies.user_access_token),
       token_expires_at  = COALESCE($6, agencies.token_expires_at),
       updated_at = NOW()`,
    [facebookUserId, name, sessionToken, expiresAt, userAccessToken || null, tokenExpiresAt || null]
  );
}

async function getAgencyBySession(sessionToken) {
  if (!sessionToken) return null;
  const result = await pool.query(
    `SELECT * FROM agencies
     WHERE session_token = $1 AND session_expires_at > NOW()`,
    [sessionToken]
  );
  return result.rows[0] ?? null;
}

async function updateAgencyNotion(facebookUserId, notionToken, notionDatabaseId) {
  await pool.query(
    `UPDATE agencies SET notion_token = $1, notion_database_id = $2, updated_at = NOW()
     WHERE facebook_user_id = $3`,
    [notionToken, notionDatabaseId, facebookUserId]
  );
}

// ══════════════════════════════════════════
//  PENDING CONNECTIONS
// ══════════════════════════════════════════

async function savePendingForAgency(facebookUserId, token, pages) {
  await pool.query(
    `INSERT INTO pending_connections (token, pages, facebook_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET pages = $2, facebook_user_id = $3, created_at = NOW()`,
    [token, JSON.stringify(pages), facebookUserId]
  );
}

// mantido por compatibilidade
async function savePending(token, pages) {
  await pool.query(
    `INSERT INTO pending_connections (token, pages) VALUES ($1, $2)
     ON CONFLICT (token) DO UPDATE SET pages = $2, created_at = NOW()`,
    [token, JSON.stringify(pages)]
  );
}

async function getPending(token) {
  const result = await pool.query(
    `SELECT pages FROM pending_connections
     WHERE token = $1 AND created_at > NOW() - INTERVAL '60 minutes'`,
    [token]
  );
  return result.rows[0]?.pages ?? null;
}

async function getPendingByAgency(facebookUserId) {
  const result = await pool.query(
    `SELECT token, pages FROM pending_connections
     WHERE facebook_user_id = $1 AND created_at > NOW() - INTERVAL '60 minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [facebookUserId]
  );
  return result.rows[0] ?? null;
}

async function deletePending(token) {
  await pool.query('DELETE FROM pending_connections WHERE token = $1', [token]);
}

async function deletePendingByAgency(facebookUserId) {
  await pool.query('DELETE FROM pending_connections WHERE facebook_user_id = $1', [facebookUserId]);
}

// ══════════════════════════════════════════
//  CLIENTS
// ══════════════════════════════════════════

async function upsertClient({ notionClientId, pageId, pageName, accessToken, instagramAccountId, facebookUserId }) {
  const existing = await pool.query('SELECT id FROM clients WHERE page_id = $1', [pageId]);

  if (existing.rows.length) {
    await pool.query(
      `UPDATE clients SET
        notion_client_id = $1, page_name = $2, access_token = $3,
        instagram_account_id = $4, facebook_user_id = $5, updated_at = NOW()
       WHERE page_id = $6`,
      [notionClientId, pageName, accessToken, instagramAccountId, facebookUserId, pageId]
    );
  } else {
    await pool.query(
      `INSERT INTO clients
        (notion_client_id, page_id, page_name, access_token, instagram_account_id, facebook_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [notionClientId, pageId, pageName, accessToken, instagramAccountId, facebookUserId]
    );
  }
}

async function getAllClients() {
  const result = await pool.query(`
    SELECT c.*, a.notion_token, a.notion_database_id
    FROM clients c
    JOIN agencies a ON c.facebook_user_id = a.facebook_user_id
    ORDER BY c.page_name
  `);
  return result.rows;
}

async function getClientsByAgency(facebookUserId) {
  const result = await pool.query(`
    SELECT c.*, a.notion_token, a.notion_database_id
    FROM clients c
    JOIN agencies a ON c.facebook_user_id = a.facebook_user_id
    WHERE c.facebook_user_id = $1
    ORDER BY c.page_name
  `, [facebookUserId]);
  return result.rows;
}

async function deleteClientByPageId(pageId, facebookUserId) {
  await pool.query(
    'DELETE FROM clients WHERE page_id = $1 AND facebook_user_id = $2',
    [pageId, facebookUserId]
  );
}

async function getClientByNotionId(notionClientId) {
  const result = await pool.query(
    'SELECT * FROM clients WHERE notion_client_id = $1',
    [notionClientId]
  );
  return result.rows[0] ?? null;
}

module.exports = {
  setup,
  // agencies
  upsertAgency, getAgencyBySession, updateAgencyNotion,
  // pending
  savePending, savePendingForAgency, getPending, getPendingByAgency, deletePending, deletePendingByAgency,
  // clients
  upsertClient, getAllClients, getClientsByAgency, deleteClientByPageId, getClientByNotionId,
};
