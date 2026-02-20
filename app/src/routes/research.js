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

  const gens = parseInt(generations, 10) || 4;

  db.createResearchJob({
    id: jobId,
    customer_name,
    customer_email: customer_email || '',
    generations: gens,
    input_data: inputData,
  });

  // Pre-populate ancestors from customer data so they appear on the fan chart immediately
  // Asc#1 = Subject
  db.addAncestor({
    research_job_id: jobId,
    fs_person_id: '',
    name: `${given_name} ${surname}`,
    gender: 'Unknown',
    birth_date: birth_date || '',
    birth_place: birth_place || '',
    death_date: death_date || '',
    death_place: death_place || '',
    ascendancy_number: 1,
    generation: 0,
    confidence: 'customer_data',
    sources: [],
    raw_data: {},
    confidence_score: 70,
    confidence_level: 'Customer Data',
    evidence_chain: [],
    search_log: [],
    conflicts: [],
    verification_notes: 'Customer-provided data — awaiting verification',
  });

  // Asc#2 = Father (if provided)
  if (father_name) {
    db.addAncestor({
      research_job_id: jobId,
      fs_person_id: '',
      name: father_name,
      gender: 'Male',
      birth_date: '',
      birth_place: '',
      death_date: '',
      death_place: '',
      ascendancy_number: 2,
      generation: 1,
      confidence: 'customer_data',
      sources: [],
      raw_data: {},
      confidence_score: 60,
      confidence_level: 'Customer Data',
      evidence_chain: [],
      search_log: [],
      conflicts: [],
      verification_notes: 'Customer-provided data — awaiting verification',
    });
  }

  // Asc#3 = Mother (if provided)
  if (mother_name) {
    db.addAncestor({
      research_job_id: jobId,
      fs_person_id: '',
      name: mother_name,
      gender: 'Female',
      birth_date: '',
      birth_place: '',
      death_date: '',
      death_place: '',
      ascendancy_number: 3,
      generation: 1,
      confidence: 'customer_data',
      sources: [],
      raw_data: {},
      confidence_score: 60,
      confidence_level: 'Customer Data',
      evidence_chain: [],
      search_log: [],
      conflicts: [],
      verification_notes: 'Customer-provided data — awaiting verification',
    });
  }

  // Run GPS-compliant research engine in background
  const engine = new ResearchEngine(db, jobId, inputData, gens);
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

// JSON endpoint for fan chart polling — lightweight ancestor data
router.get('/:id/ancestors', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const ancestors = db.getAncestors(req.params.id);

  // Return lightweight data for the fan chart (no heavy evidence/search_log/raw_data)
  const lightweight = ancestors.map(a => ({
    id: a.id,
    ascendancy_number: a.ascendancy_number,
    generation: a.generation,
    name: a.name,
    gender: a.gender,
    birth_date: a.birth_date,
    birth_place: a.birth_place,
    death_date: a.death_date,
    death_place: a.death_place,
    fs_person_id: a.fs_person_id,
    confidence_score: a.confidence_score,
    confidence_level: a.confidence_level,
  }));

  res.json({
    status: job.status,
    progress_message: job.progress_message || '',
    progress_current: job.progress_current || 0,
    progress_total: job.progress_total || 0,
    generations: job.generations,
    ancestors: lightweight,
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
