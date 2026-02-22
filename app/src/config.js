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

  // Geni.com OAuth
  GENI_CLIENT_ID: process.env.GENI_CLIENT_ID || '',
  GENI_CLIENT_SECRET: process.env.GENI_CLIENT_SECRET || '',
  GENI_API_URL: process.env.GENI_API_URL || 'https://www.geni.com',
  GENI_AUTH_URL: process.env.GENI_AUTH_URL || 'https://www.geni.com/platform/oauth/authorize',
  GENI_TOKEN_URL: process.env.GENI_TOKEN_URL || 'https://www.geni.com/platform/oauth/request_token',
  GENI_REDIRECT_URI: process.env.GENI_REDIRECT_URI || 'https://theymademe.co.uk/admin/geni/callback',

  // FreeBMD
  FREEBMD_BASE_URL: process.env.FREEBMD_BASE_URL || 'https://www.freebmd.org.uk',

  // AI Review
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',

  // Paths
  DATA_DIR: process.env.DATA_DIR || '/app/data',
};
