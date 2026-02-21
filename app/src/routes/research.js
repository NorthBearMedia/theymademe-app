const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const { ResearchEngine, parseNotesForAnchors, parseNameParts } = require('../services/research-engine');
const { buildSourceRegistry } = require('../services/source-registry');
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

  // Parse notes for anchor data (birth/death dates for father/mother/grandparents)
  const noteAnchors = parseNotesForAnchors(notes || '');

  // Pre-populate ancestors from customer data — 100% confidence (customer is always right)
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
    confidence_score: 100,
    confidence_level: 'Customer Data',
    evidence_chain: [],
    search_log: [],
    conflicts: [],
    verification_notes: 'Customer-provided data',
  });

  // Asc#2 = Father (if provided)
  if (father_name) {
    const fatherAnchor = noteAnchors[2] || {};
    db.addAncestor({
      research_job_id: jobId,
      fs_person_id: '',
      name: father_name,
      gender: 'Male',
      birth_date: fatherAnchor.birthDate || '',
      birth_place: fatherAnchor.birthPlace || birth_place || '',
      death_date: fatherAnchor.deathDate || '',
      death_place: fatherAnchor.deathPlace || '',
      ascendancy_number: 2,
      generation: 1,
      confidence: 'customer_data',
      sources: [],
      raw_data: {},
      confidence_score: 100,
      confidence_level: 'Customer Data',
      evidence_chain: [],
      search_log: [],
      conflicts: [],
      verification_notes: 'Customer-provided data',
    });
  }

  // Asc#3 = Mother (if provided)
  if (mother_name) {
    const motherAnchor = noteAnchors[3] || {};
    db.addAncestor({
      research_job_id: jobId,
      fs_person_id: '',
      name: mother_name,
      gender: 'Female',
      birth_date: motherAnchor.birthDate || '',
      birth_place: motherAnchor.birthPlace || birth_place || '',
      death_date: motherAnchor.deathDate || '',
      death_place: motherAnchor.deathPlace || '',
      ascendancy_number: 3,
      generation: 1,
      confidence: 'customer_data',
      sources: [],
      raw_data: {},
      confidence_score: 100,
      confidence_level: 'Customer Data',
      evidence_chain: [],
      search_log: [],
      conflicts: [],
      verification_notes: 'Customer-provided data',
    });
  }

  // Asc#4-7 = Grandparents (if provided in notes) — also pre-populate as customer data
  for (const ascNum of [4, 5, 6, 7]) {
    const anchor = noteAnchors[ascNum];
    if (anchor && anchor.givenName) {
      const fullName = `${anchor.givenName} ${anchor.surname || ''}`.trim();
      const gender = ascNum % 2 === 0 ? 'Male' : 'Female';
      console.log(`[Research] Pre-populating grandparent asc#${ascNum}: ${fullName} (${anchor.birthDate || '?'}-${anchor.deathDate || '?'})`);
      db.addAncestor({
        research_job_id: jobId,
        fs_person_id: '',
        name: fullName,
        gender,
        birth_date: anchor.birthDate || '',
        birth_place: anchor.birthPlace || birth_place || '',
        death_date: anchor.deathDate || '',
        death_place: anchor.deathPlace || '',
        ascendancy_number: ascNum,
        generation: 2,
        confidence: 'customer_data',
        sources: [],
        raw_data: {},
        confidence_score: 100,
        confidence_level: 'Customer Data',
        evidence_chain: [],
        search_log: [],
        conflicts: [],
        verification_notes: 'Customer-provided data (from notes)',
      });
    }
  }

  // Run GPS-compliant research engine in background with all available sources
  const sources = buildSourceRegistry();
  console.log(`[Research] Starting job ${jobId} with ${sources.length} sources: ${sources.map(s => s.sourceName).join(', ')}`);
  const engine = new ResearchEngine(db, jobId, inputData, gens, sources);
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

// Delete entire research job
router.post('/:id/delete', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  db.deleteResearchJob(req.params.id);
  res.redirect('/admin/dashboard');
});

// Reject ancestor and re-research (deeper search)
router.post('/:id/ancestor/:ancestorId/reresearch', requireAuth, async (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestor = db.getAncestorById(parseInt(req.params.ancestorId, 10));
  if (!ancestor) return res.status(404).send('Ancestor not found');

  const ascNumber = ancestor.ascendancy_number;

  // Delete this ancestor AND all their descendants (children in the tree are further out)
  const deleted = db.deleteDescendantAncestors(req.params.id, ascNumber);
  console.log(`[Re-research] Deleted asc#${ascNumber} and ${deleted.length - 1} descendants for job ${req.params.id}`);

  // Rebuild input data from the job
  const inputData = job.input_data || {};

  // Re-run research engine — it will pick up from where ancestors are missing
  const sources = buildSourceRegistry();
  const engine = new ResearchEngine(db, req.params.id, inputData, job.generations, sources);

  // Mark job as running again
  db.updateResearchJob(req.params.id, { status: 'running', progress_message: `Re-researching ancestor #${ascNumber}...` });

  engine.run().catch(err => {
    console.error(`Re-research for job ${req.params.id} failed:`, err);
  });

  res.redirect(`/admin/research/${req.params.id}`);
});

// Ancestor detail view
router.get('/:id/ancestor/:ancestorId', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestor = db.getAncestorById(parseInt(req.params.ancestorId, 10));
  if (!ancestor) return res.status(404).send('Ancestor not found');

  // Look up the child (the person this ancestor is a parent of)
  let parentName = '';
  if (ancestor.ascendancy_number > 1) {
    const childAsc = Math.floor(ancestor.ascendancy_number / 2);
    const child = db.getAncestorByAscNumber(req.params.id, childAsc);
    if (child) parentName = child.name;
  }

  const candidates = db.getSearchCandidates(req.params.id, ancestor.ascendancy_number);
  res.render('ancestor-detail', { job, ancestor, candidates, parentName });
});

// View research results
router.get('/:id', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestors = db.getAncestors(req.params.id);
  res.render('research-view', { job, ancestors });
});

module.exports = router;
