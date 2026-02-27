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

  // Store token — mark as authenticated (can access tree data)
  db.setSetting('fs_access_token', data.access_token);
  db.setSetting('fs_token_type', data.token_type || 'bearer');
  db.setSetting('fs_token_obtained_at', new Date().toISOString());
  db.setSetting('fs_token_scope', 'authenticated'); // full tree access

  return data;
}

/**
 * Get stored token. If the authenticated token has expired, automatically
 * obtain an unauthenticated session token (search-only, no tree access).
 * Returns { access_token, token_type, obtained_at, hours_remaining, scope }
 * scope: 'authenticated' (full tree + search) or 'unauthenticated' (search only)
 */
function getStoredToken() {
  const token = db.getSetting('fs_access_token');
  const obtainedAt = db.getSetting('fs_token_obtained_at');
  const scope = db.getSetting('fs_token_scope') || 'authenticated';

  if (!token || !obtainedAt) return null;

  const obtainedDate = new Date(obtainedAt);
  const hoursElapsed = (Date.now() - obtainedDate.getTime()) / (1000 * 60 * 60);

  // Authenticated tokens last 24h (use 23h safety margin)
  // Unauthenticated tokens last ~1h (use 50min safety margin)
  const maxHours = scope === 'authenticated' ? 23 : 0.83;

  if (hoursElapsed > maxHours) return null;

  return {
    access_token: token,
    token_type: db.getSetting('fs_token_type') || 'bearer',
    obtained_at: obtainedAt,
    hours_remaining: Math.max(0, (scope === 'authenticated' ? 24 : 1) - hoursElapsed).toFixed(1),
    scope,
  };
}

/**
 * Obtain an unauthenticated session token from FamilySearch.
 * This gives search capability but NOT tree data access (getParents, etc.).
 * Useful as a fallback when the authenticated token has expired.
 */
async function obtainUnauthenticatedToken() {
  try {
    const response = await fetch(config.FS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'unauthenticated_session',
        client_id: config.FS_CLIENT_ID,
        ip_address: '1.1.1.1',
      }),
    });

    if (!response.ok) {
      console.log(`[FS-OAuth] Unauthenticated token request failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (!data.access_token) return null;

    // Store as unauthenticated (search-only)
    db.setSetting('fs_access_token', data.access_token);
    db.setSetting('fs_token_type', data.token_type || 'family_search');
    db.setSetting('fs_token_obtained_at', new Date().toISOString());
    db.setSetting('fs_token_scope', 'unauthenticated');

    console.log(`[FS-OAuth] Obtained unauthenticated session token (search-only)`);
    return {
      access_token: data.access_token,
      token_type: data.token_type || 'family_search',
      obtained_at: new Date().toISOString(),
      hours_remaining: '1.0',
      scope: 'unauthenticated',
    };
  } catch (err) {
    console.log(`[FS-OAuth] Failed to obtain unauthenticated token: ${err.message}`);
    return null;
  }
}

/**
 * Get a working token — tries stored token first, falls back to unauthenticated.
 * This is the main function the API layer should call.
 */
async function ensureToken() {
  let tokenData = getStoredToken();
  if (tokenData) return tokenData;

  // Stored token expired — try getting an unauthenticated one
  return obtainUnauthenticatedToken();
}

function clearToken() {
  db.setSetting('fs_access_token', '');
  db.setSetting('fs_token_obtained_at', '');
  db.setSetting('fs_token_scope', '');
}

/**
 * Check if the current token has full tree access (authenticated).
 */
function isAuthenticated() {
  const tokenData = getStoredToken();
  return tokenData && tokenData.scope === 'authenticated';
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getStoredToken,
  ensureToken,
  obtainUnauthenticatedToken,
  clearToken,
  isAuthenticated,
};
