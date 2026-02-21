module.exports = function requireAuth(req, res, next) {
  console.log(`[AUTH] ${req.method} ${req.url} | cookie: ${req.headers.cookie || 'NONE'} | session.isAdmin: ${req.session?.isAdmin} | sessionID: ${req.sessionID?.substring(0,12)}`);
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.redirect('/admin/login');
};
