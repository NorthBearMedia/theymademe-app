const express = require('express');
const db = require('../services/database');
const { generateGedcom } = require('../services/gedcom-export');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Download GEDCOM file
router.get('/gedcom/:id', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestors = db.getAncestors(req.params.id);
  if (ancestors.length === 0) return res.status(400).send('No ancestors found — research may still be running.');

  const gedcom = generateGedcom(job, ancestors);
  const filename = `${(job.customer_name || 'family-tree').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-')}-family-tree.ged`;

  res.setHeader('Content-Type', 'text/x-gedcom; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(gedcom);
});

module.exports = router;
