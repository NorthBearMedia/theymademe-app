const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const { ResearchEngine, parseNotesForAnchors, parseNameParts } = require('../services/research-engine');
const { buildSourceRegistry } = require('../services/source-registry');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Helpers for AI feedback capture
function extractFeedbackFields(ancestor) {
  const nameParts = (ancestor.name || '').split(' ');
  const surname = nameParts[nameParts.length - 1] || '';
  const birthYear = ancestor.birth_date ? parseInt(String(ancestor.birth_date).match(/\d{4}/)?.[0]) : null;
  return {
    ancestor_name: ancestor.name,
    ancestor_surname: surname,
    ancestor_birth_year: birthYear,
    ancestor_location: ancestor.birth_place || '',
  };
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
  return m ? parseInt(m[1]) : null;
}

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
    accepted: 1,
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
      accepted: 1,
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
      accepted: 1,
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
        accepted: 1,
      });
    }
  }

  res.redirect(`/admin/research/${jobId}`);
});

// Begin research (manually triggered)
router.post('/:id/begin', requireAuth, async (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');
  if (job.status !== 'pending') return res.redirect(`/admin/research/${req.params.id}`);

  const inputData = job.input_data || {};
  const sources = buildSourceRegistry();
  console.log(`[Research] Starting job ${req.params.id} with ${sources.length} sources: ${sources.map(s => s.sourceName).join(', ')}`);
  const engine = new ResearchEngine(db, req.params.id, inputData, job.generations, sources);
  engine.run().catch(err => {
    console.error(`Research job ${req.params.id} failed:`, err);
  });

  res.redirect(`/admin/research/${req.params.id}`);
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

  // Return lightweight data for tree cards + fan chart (no heavy evidence/search_log/raw_data)
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
    accepted: a.accepted || 0,
    missing_info: a.missing_info || [],
    corrections_log: a.corrections_log || [],
  }));

  // Completion counter: total slots in the tree and accepted count
  const totalSlots = Math.pow(2, (job.generations || 4) + 1) - 1;
  const acceptedCount = ancestors.filter(a => a.accepted || a.confidence_level === 'Customer Data').length;

  res.json({
    status: job.status,
    progress_message: job.progress_message || '',
    progress_current: job.progress_current || 0,
    progress_total: job.progress_total || 0,
    generations: job.generations,
    ancestors: lightweight,
    total_slots: totalSlots,
    accepted_count: acceptedCount,
  });
});

// Accept an ancestor (manually)
router.post('/:id/ancestor/:ancestorId/accept', requireAuth, async (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestor = db.getAncestorById(parseInt(req.params.ancestorId, 10));
  if (!ancestor) return res.status(404).send('Ancestor not found');

  // Capture AI learning feedback
  db.addAIFeedback({
    job_id: req.params.id, asc_number: ancestor.ascendancy_number, action_type: 'accept',
    ...extractFeedbackFields(ancestor),
    original_data: { name: ancestor.name, birth_date: ancestor.birth_date, birth_place: ancestor.birth_place, death_date: ancestor.death_date, death_place: ancestor.death_place, confidence_score: ancestor.confidence_score, fs_person_id: ancestor.fs_person_id },
    corrected_data: {},
  });

  // Mark as accepted
  db.updateAncestorById(parseInt(req.params.ancestorId, 10), { accepted: 1 });
  console.log(`[Accept] Accepted asc#${ancestor.ascendancy_number}: ${ancestor.name} for job ${req.params.id}`);

  // Check if parent positions exist — if not and we have an FS ID, trigger parent research
  if (ancestor.fs_person_id) {
    const fatherAsc = ancestor.ascendancy_number * 2;
    const motherAsc = ancestor.ascendancy_number * 2 + 1;
    const maxAsc = Math.pow(2, (job.generations || 4) + 1) - 1;

    const fatherExists = db.getAncestorByAscNumber(req.params.id, fatherAsc);
    const motherExists = db.getAncestorByAscNumber(req.params.id, motherAsc);

    if ((!fatherExists || !motherExists) && fatherAsc <= maxAsc) {
      console.log(`[Accept] Parents missing for asc#${ancestor.ascendancy_number}, triggering research...`);
      const inputData = job.input_data || {};
      const sources = buildSourceRegistry();
      const engine = new ResearchEngine(db, req.params.id, inputData, job.generations, sources);

      db.updateResearchJob(req.params.id, {
        status: 'running',
        progress_message: `Researching parents of ${ancestor.name}...`,
      });

      engine.run().catch(err => {
        console.error(`Parent research for job ${req.params.id} failed:`, err);
      });
    }
  }

  res.redirect(`/admin/research/${req.params.id}`);
});

// Update ancestor info (manual key info update)
router.post('/:id/ancestor/:ancestorId/update-info', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestor = db.getAncestorById(parseInt(req.params.ancestorId, 10));
  if (!ancestor) return res.status(404).send('Ancestor not found');

  const { birth_date, birth_place, death_date, death_place } = req.body;
  const updates = {};

  if (birth_date !== undefined && birth_date !== ancestor.birth_date) updates.birth_date = birth_date;
  if (birth_place !== undefined && birth_place !== ancestor.birth_place) updates.birth_place = birth_place;
  if (death_date !== undefined && death_date !== ancestor.death_date) updates.death_date = death_date;
  if (death_place !== undefined && death_place !== ancestor.death_place) updates.death_place = death_place;

  if (Object.keys(updates).length > 0) {
    // Capture AI learning feedback
    db.addAIFeedback({
      job_id: req.params.id, asc_number: ancestor.ascendancy_number, action_type: 'correct',
      ...extractFeedbackFields(ancestor),
      original_data: { birth_date: ancestor.birth_date, birth_place: ancestor.birth_place, death_date: ancestor.death_date, death_place: ancestor.death_place },
      corrected_data: updates,
    });

    // Clear resolved missing_info items
    let missingInfo = ancestor.missing_info || [];
    if (typeof missingInfo === 'string') {
      try { missingInfo = JSON.parse(missingInfo); } catch (e) { missingInfo = []; }
    }

    if (updates.birth_place) missingInfo = missingInfo.filter(m => m.type !== 'location');
    if (updates.birth_date) missingInfo = missingInfo.filter(m => m.type !== 'date');

    updates.missing_info = missingInfo;

    db.updateAncestorById(parseInt(req.params.ancestorId, 10), updates);
    console.log(`[Update-Info] Updated asc#${ancestor.ascendancy_number}: ${ancestor.name} — ${JSON.stringify(updates)}`);
  }

  res.redirect(`/admin/research/${req.params.id}/ancestor/${req.params.ancestorId}`);
});

// Delete entire research job
router.post('/:id/delete', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  db.deleteResearchJob(req.params.id);
  res.redirect('/admin');
});

// Reject ancestor and re-research (deeper search)
router.post('/:id/ancestor/:ancestorId/reresearch', requireAuth, async (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestor = db.getAncestorById(parseInt(req.params.ancestorId, 10));
  if (!ancestor) return res.status(404).send('Ancestor not found');

  const ascNumber = ancestor.ascendancy_number;

  // Capture AI learning feedback
  db.addAIFeedback({
    job_id: req.params.id, asc_number: ascNumber, action_type: 'reject',
    ...extractFeedbackFields(ancestor),
    original_data: { name: ancestor.name, birth_date: ancestor.birth_date, birth_place: ancestor.birth_place, death_date: ancestor.death_date, death_place: ancestor.death_place, confidence_score: ancestor.confidence_score, fs_person_id: ancestor.fs_person_id },
    corrected_data: {},
  });

  // Mark current ancestor's FS ID as rejected in search_candidates
  if (ancestor.fs_person_id) {
    const existingCandidates = db.getSearchCandidates(req.params.id, ascNumber);
    const alreadyTracked = existingCandidates.some(c => c.fs_person_id === ancestor.fs_person_id);
    if (!alreadyTracked) {
      db.addSearchCandidate({
        research_job_id: req.params.id,
        target_asc_number: ascNumber,
        fs_person_id: ancestor.fs_person_id,
        name: ancestor.name,
        search_pass: 0,
        search_query: 'Previously selected',
        fs_score: 0,
        computed_score: ancestor.confidence_score || 0,
        selected: 0,
        rejection_reason: 'Manually rejected by admin',
        raw_data: { display: { birthDate: ancestor.birth_date, birthPlace: ancestor.birth_place, deathDate: ancestor.death_date, deathPlace: ancestor.death_place } },
      });
    } else {
      // Update existing candidate to mark as rejected
      db.updateSearchCandidateStatus(req.params.id, ascNumber, ancestor.fs_person_id, {
        selected: 0,
        rejection_reason: 'Manually rejected by admin',
      });
    }
  }

  // Delete this ancestor AND all their descendants (children in the tree are further out)
  const deleted = db.deleteDescendantAncestors(req.params.id, ascNumber);
  console.log(`[Re-research] Rejected asc#${ascNumber}: ${ancestor.name} (${ancestor.fs_person_id || 'no FS ID'}) — deleted ${deleted.length} positions`);

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

// Select an alternative candidate for an ancestor position
router.post('/:id/ancestor/:ascNumber/select-candidate', requireAuth, async (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ascNumber = parseInt(req.params.ascNumber, 10);
  const { candidate_id } = req.body;
  if (!candidate_id) return res.status(400).send('No candidate specified');

  // Get the candidate from search_candidates
  const candidates = db.getSearchCandidates(req.params.id, ascNumber);
  const candidate = candidates.find(c => c.id === parseInt(candidate_id, 10));
  if (!candidate) return res.status(404).send('Candidate not found');

  // Delete existing ancestor at this position (if any — e.g. a "not found" placeholder)
  const existing = db.getAncestorByAscNumber(req.params.id, ascNumber);

  // Capture AI learning feedback
  if (existing) {
    db.addAIFeedback({
      job_id: req.params.id, asc_number: ascNumber, action_type: 'select_alternative',
      ...extractFeedbackFields(existing),
      original_data: { name: existing.name, birth_date: existing.birth_date, birth_place: existing.birth_place, death_date: existing.death_date, death_place: existing.death_place, confidence_score: existing.confidence_score, fs_person_id: existing.fs_person_id },
      corrected_data: { name: candidate.name, fs_person_id: candidate.fs_person_id, computed_score: candidate.computed_score },
    });
  }
  if (existing) {
    db.deleteDescendantAncestors(req.params.id, ascNumber);
  }

  // Create ancestor record from the selected candidate
  const generation = Math.floor(Math.log2(ascNumber));
  const gender = ascNumber % 2 === 0 ? 'Male' : 'Female';
  const rawData = candidate.raw_data || {};

  const ancestorId = db.addAncestor({
    research_job_id: req.params.id,
    fs_person_id: candidate.fs_person_id || '',
    name: candidate.name,
    gender: ascNumber === 1 ? 'Unknown' : gender,
    birth_date: rawData.display?.birthDate || '',
    birth_place: rawData.display?.birthPlace || '',
    death_date: rawData.display?.deathDate || '',
    death_place: rawData.display?.deathPlace || '',
    ascendancy_number: ascNumber,
    generation,
    confidence: 'selected',
    sources: ['FamilySearch'],
    raw_data: rawData,
    confidence_score: candidate.computed_score || 0,
    confidence_level: candidate.computed_score >= 90 ? 'Verified' : candidate.computed_score >= 75 ? 'Probable' : candidate.computed_score >= 50 ? 'Possible' : 'Suggested',
    evidence_chain: [],
    search_log: [],
    conflicts: [],
    verification_notes: 'Manually selected from alternative candidates by admin.',
    accepted: candidate.computed_score > 50 ? 1 : 0,
    missing_info: [],
  });

  // Mark this candidate as selected, unmark others
  db.updateSearchCandidateStatus(req.params.id, ascNumber, candidate.fs_person_id, {
    selected: 1,
    rejection_reason: '',
  });

  console.log(`[Select-Candidate] Selected ${candidate.name} (${candidate.fs_person_id}) for asc#${ascNumber} in job ${req.params.id}`);

  // If the selected candidate has an FS ID, trigger parent research (like accept does)
  if (candidate.fs_person_id) {
    const fatherAsc = ascNumber * 2;
    const maxAsc = Math.pow(2, (job.generations || 4) + 1) - 1;

    if (fatherAsc <= maxAsc) {
      const inputData = job.input_data || {};
      const sources = buildSourceRegistry();
      const engine = new ResearchEngine(db, req.params.id, inputData, job.generations, sources);

      db.updateResearchJob(req.params.id, {
        status: 'running',
        progress_message: `Researching parents of ${candidate.name}...`,
      });

      engine.run().catch(err => {
        console.error(`Parent research after candidate selection failed:`, err);
      });
    }
  }

  res.redirect(`/admin/research/${req.params.id}/ancestor/${ancestorId}`);
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

// ─── AI Review Routes ──────────────────────────────────────────────

// AI Review page
router.get('/:id/ai-review', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestors = db.getAncestors(req.params.id);
  res.render('ai-review', { job, ancestors });
});

// Manually trigger/re-run AI review
router.post('/:id/ai-review/run', requireAuth, async (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  if (job.ai_review_status === 'running') {
    return res.redirect(`/admin/research/${req.params.id}/ai-review`);
  }

  const aiReviewer = require('../services/ai-reviewer');
  db.updateResearchJob(req.params.id, { ai_review_status: 'running' });

  // Fire-and-forget
  aiReviewer.runFullReview(req.params.id).catch(err => {
    console.error(`AI review for ${req.params.id} failed:`, err);
  });

  res.redirect(`/admin/research/${req.params.id}/ai-review`);
});

// AI review status polling (JSON)
router.get('/:id/ai-review/status', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  res.json({
    ai_review_status: job.ai_review_status || 'none',
    ai_review_summary: job.ai_review_summary || {},
    progress_message: job.progress_message || '',
    progress_current: job.progress_current || 0,
    progress_total: job.progress_total || 0,
  });
});

// Undo an AI auto-correction
router.post('/:id/ancestor/:ascNumber/undo-correction', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ascNumber = parseInt(req.params.ascNumber, 10);
  const ancestor = db.getAncestorByAscNumber(req.params.id, ascNumber);
  if (!ancestor) return res.status(404).send('Ancestor not found');

  const { correction_index } = req.body;
  const idx = parseInt(correction_index, 10);
  const log = ancestor.corrections_log || [];

  if (idx < 0 || idx >= log.length || log[idx].undone) {
    return res.status(400).send('Invalid or already undone correction');
  }

  const entry = log[idx];

  // Revert the value
  if (entry.type === 'confidence_adjustment') {
    db.updateAncestorByAscNumber(req.params.id, ascNumber, {
      confidence_score: entry.old_value,
    });
  } else if (entry.type === 'field_correction' && entry.field) {
    db.updateAncestorByAscNumber(req.params.id, ascNumber, {
      [entry.field]: entry.old_value,
    });
  }

  // Mark as undone in log
  log[idx].undone = true;
  log[idx].undone_at = new Date().toISOString();
  db.updateAncestorByAscNumber(req.params.id, ascNumber, { corrections_log: log });

  // Record feedback so the AI learns this correction was wrong
  db.addAIFeedback({
    job_id: req.params.id,
    asc_number: ascNumber,
    action_type: 'reject',
    ...extractFeedbackFields(ancestor),
    original_data: { corrected_to: entry.new_value, correction_type: entry.type },
    corrected_data: { reverted_to: entry.old_value },
    admin_notes: 'Undid AI auto-correction',
  });

  console.log(`[Undo] Reverted correction #${idx} for asc#${ascNumber}: ${ancestor.name}`);

  // Redirect back to referring page
  const referer = req.get('Referer') || `/admin/research/${req.params.id}/ai-review`;
  res.redirect(referer);
});

// Apply an AI suggestion (one-click)
router.post('/:id/ancestor/:ascNumber/apply-suggestion', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ascNumber = parseInt(req.params.ascNumber, 10);
  const ancestor = db.getAncestorByAscNumber(req.params.id, ascNumber);
  if (!ancestor) return res.status(404).send('Ancestor not found');

  const { suggestion_type, field, value, gpt_adj, claude_adj } = req.body;

  const log = ancestor.corrections_log || [];

  if (suggestion_type === 'confidence_adjustment') {
    const gAdj = parseInt(gpt_adj) || 0;
    const cAdj = parseInt(claude_adj) || 0;
    const avgAdj = Math.round((gAdj + cAdj) / 2);
    const oldScore = ancestor.confidence_score || 0;
    const newScore = Math.max(0, Math.min(100, oldScore + avgAdj));

    db.updateAncestorByAscNumber(req.params.id, ascNumber, { confidence_score: newScore });

    log.push({
      type: 'confidence_adjustment',
      source: 'admin_applied_suggestion',
      old_value: oldScore,
      new_value: newScore,
      gpt_adj: gAdj,
      claude_adj: cAdj,
      applied_at: new Date().toISOString(),
      undone: false,
    });
  } else if (suggestion_type === 'field_correction' && field && value) {
    const { parseCorrection } = require('../services/ai-reviewer');
    const oldValue = ancestor[field] || '';

    db.updateAncestorByAscNumber(req.params.id, ascNumber, { [field]: value });

    log.push({
      type: 'field_correction',
      source: 'admin_applied_suggestion',
      field,
      old_value: oldValue,
      new_value: value,
      applied_at: new Date().toISOString(),
      undone: false,
    });
  }

  db.updateAncestorByAscNumber(req.params.id, ascNumber, { corrections_log: log });

  // Record feedback so AI learns from admin applying the suggestion
  db.addAIFeedback({
    job_id: req.params.id,
    asc_number: ascNumber,
    action_type: 'correct',
    ...extractFeedbackFields(ancestor),
    original_data: { [field || 'confidence']: ancestor[field] || ancestor.confidence_score },
    corrected_data: { [field || 'confidence']: value || req.body.value },
    admin_notes: 'Applied AI suggestion',
  });

  console.log(`[Apply-Suggestion] Applied ${suggestion_type} for asc#${ascNumber}: ${ancestor.name}`);

  const referer = req.get('Referer') || `/admin/research/${req.params.id}/ai-review`;
  res.redirect(referer);
});

// View research results
router.get('/:id', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestors = db.getAncestors(req.params.id);
  res.render('research-view', { job, ancestors });
});

module.exports = router;
