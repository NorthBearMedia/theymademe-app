const express = require('express');
const bcrypt = require('bcrypt');
const config = require('../config');
const db = require('../services/database');
const oauth = require('../services/familysearch-oauth');
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
        return res.redirect('/admin');
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
  const stats = db.getJobStats();
  const recentJobs = db.listResearchJobs(10, 0);

  res.render('dashboard', {
    fsConnected: !!tokenData,
    tokenData,
    stats,
    recentJobs,
  });
});

module.exports = router;
