const express = require('express');
const bcrypt = require('bcrypt');
const config = require('../config');
const db = require('../services/database');
const oauth = require('../services/familysearch-oauth');
const geniOauth = require('../services/geni-oauth');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Login page
router.get('/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('login', { error: null });
});

// Login handler
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (username === config.ADMIN_USERNAME && config.ADMIN_PASSWORD_HASH) {
    try {
      const match = await bcrypt.compare(password, config.ADMIN_PASSWORD_HASH);
      if (match) {
        req.session.isAdmin = true;
        // Explicitly save session before redirecting — ensures cookie is set
        return req.session.save((err) => {
          if (err) console.error('[LOGIN] Session save error:', err);
          console.log(`[LOGIN] Success. SID: ${req.sessionID?.substring(0,12)} | Set-Cookie will be sent`);
          // Use JavaScript redirect instead of 302 — gives browser time to store the cookie
          res.send(`<html><head><meta http-equiv="refresh" content="0;url=/admin"></head><body><p>Logging in...</p><script>document.cookie && window.location.replace('/admin');</script></body></html>`);
        });
      }
    } catch (err) {
      console.error('bcrypt compare error:', err.message);
      console.error('Hash starts with:', config.ADMIN_PASSWORD_HASH.substring(0, 10));
    }
  }

  res.render('login', { error: 'Invalid username or password' });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// Dashboard
router.get('/', requireAuth, (req, res) => {
  const tokenData = oauth.getStoredToken();
  const geniToken = geniOauth.getStoredToken();
  const stats = db.getJobStats();
  const recentJobs = db.listResearchJobs(10, 0);

  // Add completion counter to each job
  for (const j of recentJobs) {
    const totalSlots = Math.pow(2, (j.generations || 4) + 1) - 1;
    const ancestors = db.getAncestors(j.id);
    const acceptedCount = ancestors.filter(a => a.accepted || (a.confidence_level === 'Customer Data')).length;
    j.completion = { accepted: acceptedCount, total: totalSlots };
  }

  res.render('dashboard', {
    fsConnected: !!tokenData,
    tokenData,
    geniConnected: !!geniToken,
    geniConfigured: !!(config.GENI_CLIENT_ID && config.GENI_CLIENT_SECRET),
    stats,
    recentJobs,
  });
});

module.exports = router;
