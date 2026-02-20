const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const { ResearchEngine } = require('../services/research-engine');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// List all research jobs
router.get('/', requireAuth, (req, res) => {
  const jobs = db.listResearchJobs(100, 0);
  res.render('research-list', { jobs });
});

// New research form
router.get('/new', requireAuth, (req, res) => {
  res.render('research-new', { error: null });
});

// Start research
router.post('/start', requireAuth, async (req, res) => {
  const {
    customer_name, customer_email, generations,
    given_name, surname, birth_date, birth_place,
    death_date, death_place,
    father_name, mother_name, notes,
  } = req.body;

  if (!customer_name || !given_name || !surname) {
    return res.render('research-new', { error: 'Customer name, given name, and surname are required.' });
  }

  const jobId = uuidv4();
  const inputData = {
    given_name, surname, birth_date, birth_place,
    death_date, death_place,
    father_name, mother_name, notes,
  };

  db.createResearchJob({
    id: jobId,
    customer_name,
    customer_email: customer_email || '',
    generations: parseInt(generations, 10) || 4,
    input_data: inputData,
  });

  // Run GPS-compliant research engine in background
  const engine = new ResearchEngine(db, jobId, inputData, parseInt(generations, 10) || 4);
  engine.run().catch(err => {
    console.error(`Research job ${jobId} failed:`, err);
  });

  res.redirect(`/admin/research/${jobId}`);
});

// Progress polling endpoint (JSON)
router.get('/:id/progress', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: job.status,
    progress_message: job.progress_message || '',
    progress_current: job.progress_current || 0,
    progress_total: job.progress_total || 0,
  });
});

// Ancestor detail view
router.get('/:id/ancestor/:ancestorId', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestor = db.getAncestorById(parseInt(req.params.ancestorId, 10));
  if (!ancestor) return res.status(404).send('Ancestor not found');

  const candidates = db.getSearchCandidates(req.params.id, ancestor.ascendancy_number);
  res.render('ancestor-detail', { job, ancestor, candidates });
});

// View research results
router.get('/:id', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestors = db.getAncestors(req.params.id);
  res.render('research-view', { job, ancestors });
});

module.exports = router;
