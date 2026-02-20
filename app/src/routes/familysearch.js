const express = require('express');
const oauth = require('../services/familysearch-oauth');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Initiate FamilySearch OAuth
router.get('/connect', requireAuth, (req, res) => {
  const authUrl = oauth.getAuthorizationUrl(req.session);
  res.redirect(authUrl);
});

// OAuth callback — FamilySearch redirects here after user grants permission
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.render('dashboard', {
      fsConnected: false,
      tokenData: null,
      stats: require('../services/database').getJobStats(),
      recentJobs: require('../services/database').listResearchJobs(10, 0),
      flashError: `FamilySearch authorization failed: ${error}`,
    });
  }

  // Verify CSRF state
  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('Invalid OAuth state — possible CSRF attack. Please try connecting again from the dashboard.');
  }

  try {
    await oauth.exchangeCodeForToken(code);
    delete req.session.oauthState;
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send(`Failed to connect to FamilySearch: ${err.message}`);
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

// Manual token injection — for when OAuth redirect can't reach the server (e.g. no SSL)
// POST /admin/familysearch/set-token with { token: "..." }
router.post('/set-token', requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  const db = require('../services/database');
  db.setSetting('fs_access_token', token);
  db.setSetting('fs_token_type', 'bearer');
  db.setSetting('fs_token_obtained_at', new Date().toISOString());
  console.log('[FS] Token set manually via /set-token endpoint');
  res.json({ success: true, message: 'Token stored' });
});

module.exports = router;
