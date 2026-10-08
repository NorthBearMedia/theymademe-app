require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  SITE_URL: process.env.SITE_URL || 'https://theymademe.co.uk',

  // Admin auth
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, // plaintext fallback — hashed at startup
  SESSION_SECRET: process.env.SESSION_SECRET || 'change-me-in-production',

  // FamilySearch OAuth
  FS_CLIENT_ID: process.env.FS_CLIENT_ID || 'b00CM36K81ADFVOS60K8',
  FS_REDIRECT_URI: process.env.FS_REDIRECT_URI || 'https://theymademe.co.uk/admin/familysearch/callback',
  FS_AUTH_URL: process.env.FS_AUTH_URL || 'https://identbeta.familysearch.org/cis-web/oauth2/v3/authorization',
  FS_TOKEN_URL: process.env.FS_TOKEN_URL || 'https://identbeta.familysearch.org/cis-web/oauth2/v3/token',
  FS_API_BASE: process.env.FS_API_BASE || 'https://apibeta.familysearch.org',
  // New FamilySearch capabilities — OFF until validated against the live API
  // with a key that includes them (see GO-LIVE-CHECKLIST / MASTER-RULES).
  FS_USE_PEDIGREE: process.env.FS_USE_PEDIGREE === 'true',           // one Read-Ancestry call instead of per-person getParents
  FS_RECORD_HINTS_ENABLED: process.env.FS_RECORD_HINTS_ENABLED === 'true', // record hints as internal corroboration
  FS_RECORDS_SEARCH_PATH: process.env.FS_RECORDS_SEARCH_PATH || '/platform/records/personas', // exists on the live API (406 without Atom Accept) — results still unverified

  // Geni.com OAuth
  GENI_CLIENT_ID: process.env.GENI_CLIENT_ID || '',
  GENI_CLIENT_SECRET: process.env.GENI_CLIENT_SECRET || '',
  GENI_API_URL: process.env.GENI_API_URL || 'https://www.geni.com',
  GENI_AUTH_URL: process.env.GENI_AUTH_URL || 'https://www.geni.com/platform/oauth/authorize',
  GENI_TOKEN_URL: process.env.GENI_TOKEN_URL || 'https://www.geni.com/platform/oauth/request_token',
  GENI_REDIRECT_URI: process.env.GENI_REDIRECT_URI || 'https://theymademe.co.uk/admin/geni/callback',

  // JotForm Intake Webhook
  INTAKE_SECRET: process.env.INTAKE_SECRET || '',

  // FreeBMD — DISABLED by default. FreeBMD's published terms limit use to
  // personal research and forbid programs that submit searches without prior
  // written permission. Set FREEBMD_ENABLED=true ONLY after Free UK Genealogy
  // has granted permission.
  FREEBMD_BASE_URL: process.env.FREEBMD_BASE_URL || 'https://www.freebmd.org.uk',
  FREEBMD_ENABLED: process.env.FREEBMD_ENABLED === 'true',

  // Wikidata (CC0) — notable-person corroboration. On by default; set
  // WIKIDATA_ENABLED=false to disable. WIKIDATA_CONTACT goes in the User-Agent
  // (Wikimedia policy requires an identifying contact).
  WIKIDATA_ENABLED: process.env.WIKIDATA_ENABLED || 'true',
  WIKIDATA_CONTACT: process.env.WIKIDATA_CONTACT || 'info@northbearmedia.co.uk',

  // AI Review
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',

  // Email (transactional — order confirmation + tree delivery)
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  MAIL_FROM: process.env.MAIL_FROM || 'They Made Me <hello@theymademe.co.uk>',

  // Paths
  DATA_DIR: process.env.DATA_DIR || '/app/data',
};
