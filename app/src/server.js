const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const db = require('./services/database');

// Routes
const adminRoutes = require('./routes/admin');
const familysearchRoutes = require('./routes/familysearch');
const researchRoutes = require('./routes/research');
const exportRoutes = require('./routes/export');

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

// Security headers (relaxed CSP for JotForm iframes on landing page)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: false, // Disable HSTS — we need HTTP to work during SSL bootstrap
}));

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static admin assets
app.use('/admin/static', express.static(path.join(__dirname, 'public')));

// Sessions
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: config.DATA_DIR,
    concurrentDB: true,
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Allow session cookies over HTTP (needed during SSL bootstrap)
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

// Initialize database
db.initialize();

// Hash admin password at startup if plaintext provided (avoids Docker $ escaping issues)
const bcrypt = require('bcrypt');
(async () => {
  if (config.ADMIN_PASSWORD && !config.ADMIN_PASSWORD_HASH?.startsWith('$2')) {
    config.ADMIN_PASSWORD_HASH = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
    console.log('Admin password hashed at startup from ADMIN_PASSWORD env var');
  }
  if (config.ADMIN_PASSWORD_HASH) {
    console.log('Admin password hash loaded, starts with:', config.ADMIN_PASSWORD_HASH.substring(0, 7));
  } else {
    console.warn('WARNING: No admin password configured!');
  }
})();

// Layout render helper — wraps content views in layout.ejs
const ejs = require('ejs');
const fs = require('fs');
const layoutPath = path.join(__dirname, 'views', 'layout.ejs');
const layoutTemplate = fs.readFileSync(layoutPath, 'utf-8');

const originalRender = express.response.render;
app.use((req, res, next) => {
  const _render = res.render.bind(res);
  res.render = function(view, locals = {}) {
    if (view === 'login') {
      return _render(view, locals);
    }
    const viewPath = path.join(__dirname, 'views', view + '.ejs');
    const viewContent = ejs.render(fs.readFileSync(viewPath, 'utf-8'), { ...locals, filename: viewPath });
    const html = ejs.render(layoutTemplate, { ...locals, content: viewContent, filename: layoutPath });
    res.send(html);
  };
  next();
});

// Mount routes
app.use('/admin/familysearch', familysearchRoutes);
app.use('/admin/research', researchRoutes);
app.use('/admin/export', exportRoutes);
app.use('/admin', adminRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).send(config.NODE_ENV === 'production' ? 'Internal server error' : err.stack);
});

const server = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`They Made Me API running on port ${config.PORT}`);
  console.log(`Environment: ${config.NODE_ENV}`);
});

// Graceful shutdown — ensures SQLite databases are closed cleanly
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
