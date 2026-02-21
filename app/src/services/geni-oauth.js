/**
 * They Made Me — Geni.com OAuth2 Service
 *
 * Handles OAuth2 authorization code flow for Geni.com.
 * Geni requires client_secret on token exchange (unlike FamilySearch).
 * Geni provides a refresh_token for long-lived access.
 *
 * Tokens stored in the same settings table as FS tokens, with geni_ prefix.
 */

const crypto = require('crypto');
const config = require('../config');
const db = require('./database');

function getAuthorizationUrl(session) {
  const state = crypto.randomBytes(16).toString('hex');
  session.geniOauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.GENI_CLIENT_ID,
    redirect_uri: config.GENI_REDIRECT_URI,
    state,
  });

  return `${config.GENI_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const response = await fetch(config.GENI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.GENI_CLIENT_ID,
      client_secret: config.GENI_CLIENT_SECRET,
      redirect_uri: config.GENI_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Geni token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // Store tokens
  db.setSetting('geni_access_token', data.access_token);
  db.setSetting('geni_refresh_token', data.refresh_token || '');
  db.setSetting('geni_token_obtained_at', new Date().toISOString());

  return data;
}

async function refreshAccessToken() {
  const refreshToken = db.getSetting('geni_refresh_token');
  if (!refreshToken) return false;

  try {
    const response = await fetch(config.GENI_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.GENI_CLIENT_ID,
        client_secret: config.GENI_CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) return false;

    const data = await response.json();
    if (!data.access_token) return false;

    db.setSetting('geni_access_token', data.access_token);
    if (data.refresh_token) {
      db.setSetting('geni_refresh_token', data.refresh_token);
    }
    db.setSetting('geni_token_obtained_at', new Date().toISOString());

    console.log('[Geni] Access token refreshed successfully');
    return true;
  } catch (err) {
    console.error('[Geni] Token refresh failed:', err.message);
    return false;
  }
}

function getStoredToken() {
  const token = db.getSetting('geni_access_token');
  const obtainedAt = db.getSetting('geni_token_obtained_at');

  if (!token || !obtainedAt) return null;

  return {
    access_token: token,
    refresh_token: db.getSetting('geni_refresh_token') || '',
    obtained_at: obtainedAt,
  };
}

function clearToken() {
  db.setSetting('geni_access_token', '');
  db.setSetting('geni_refresh_token', '');
  db.setSetting('geni_token_obtained_at', '');
}

module.exports = { getAuthorizationUrl, exchangeCodeForToken, refreshAccessToken, getStoredToken, clearToken };
