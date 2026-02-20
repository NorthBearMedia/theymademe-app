const crypto = require('crypto');
const config = require('../config');
const db = require('./database');

function getAuthorizationUrl(session) {
  const state = crypto.randomBytes(16).toString('hex');
  session.oauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.FS_CLIENT_ID,
    redirect_uri: config.FS_REDIRECT_URI,
    state,
  });

  return `${config.FS_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const response = await fetch(config.FS_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.FS_CLIENT_ID,
      redirect_uri: config.FS_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // Store token
  db.setSetting('fs_access_token', data.access_token);
  db.setSetting('fs_token_type', data.token_type || 'bearer');
  db.setSetting('fs_token_obtained_at', new Date().toISOString());

  return data;
}

function getStoredToken() {
  const token = db.getSetting('fs_access_token');
  const obtainedAt = db.getSetting('fs_token_obtained_at');

  if (!token || !obtainedAt) return null;

  const obtainedDate = new Date(obtainedAt);
  const hoursElapsed = (Date.now() - obtainedDate.getTime()) / (1000 * 60 * 60);

  // FamilySearch tokens last up to 24h — we use 23h as a safety margin
  if (hoursElapsed > 23) return null;

  return {
    access_token: token,
    token_type: db.getSetting('fs_token_type') || 'bearer',
    obtained_at: obtainedAt,
    hours_remaining: Math.max(0, 24 - hoursElapsed).toFixed(1),
  };
}

function clearToken() {
  db.setSetting('fs_access_token', '');
  db.setSetting('fs_token_obtained_at', '');
}

module.exports = { getAuthorizationUrl, exchangeCodeForToken, getStoredToken, clearToken };
