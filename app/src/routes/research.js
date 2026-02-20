const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const fsApi = require('../services/familysearch-api');
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

  // Run research in background (don't await)
  fsApi.runResearch(inputData, parseInt(generations, 10) || 4, db, jobId).catch(err => {
    console.error(`Research job ${jobId} failed:`, err);
  });

  res.redirect(`/admin/research/${jobId}`);
});

// View research results
router.get('/:id', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestors = db.getAncestors(req.params.id);
  res.render('research-view', { job, ancestors });
});

module.exports = router;
