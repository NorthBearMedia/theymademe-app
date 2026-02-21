const express = require('express');
const oauth = require('../services/geni-oauth');
const config = require('../config');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Initiate Geni OAuth
router.get('/connect', requireAuth, (req, res) => {
  if (!config.GENI_CLIENT_ID) {
    return res.status(400).send('Geni not configured — set GENI_CLIENT_ID and GENI_CLIENT_SECRET environment variables.');
  }
  const authUrl = oauth.getAuthorizationUrl(req.session);
  res.redirect(authUrl);
});

// OAuth callback
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/admin?geniError=' + encodeURIComponent(error));
  }

  // Verify CSRF state
  if (!state || state !== req.session.geniOauthState) {
    return res.status(400).send('Invalid OAuth state — possible CSRF attack. Please try connecting again from the dashboard.');
  }

  try {
    await oauth.exchangeCodeForToken(code);
    delete req.session.geniOauthState;
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send(`Failed to connect to Geni: ${err.message}`);
  }
});

// Disconnect
router.post('/disconnect', requireAuth, (req, res) => {
  oauth.clearToken();
  res.redirect('/admin');
});

// Status (JSON)
router.get('/status', requireAuth, (req, res) => {
  const tokenData = oauth.getStoredToken();
  res.json({ connected: !!tokenData, ...(tokenData || {}) });
});

// Manual token injection
router.post('/set-token', requireAuth, (req, res) => {
  const { token, refresh_token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  const db = require('../services/database');
  db.setSetting('geni_access_token', token);
  db.setSetting('geni_refresh_token', refresh_token || '');
  db.setSetting('geni_token_obtained_at', new Date().toISOString());
  console.log('[Geni] Token set manually via /set-token endpoint');
  res.json({ success: true, message: 'Geni token stored' });
});

module.exports = router;
