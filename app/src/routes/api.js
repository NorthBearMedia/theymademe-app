const express = require('express');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const db = require('../services/database');
const { ResearchEngine, parseNotesForAnchors, parseNameParts } = require('../services/research-engine');
const { buildSourceRegistry } = require('../services/source-registry');

const router = express.Router();

// ────────────────────────────────────────────────────────────────
// Legacy JotForm Field Mapping (for /api/intake backward compat)
// ────────────────────────────────────────────────────────────────
const FIELD_MAPPING = {
  q1_fullName:       'subject_name',
  q2_subjectName:    'subject_name',
  q3_email:          'customer_email',
  q2_email:          'customer_email',
  q4_customerName:   'customer_name',
  q3_customerName:   'customer_name',
  q5_birthDate:      'birth_date',
  q4_birthDate:      'birth_date',
  q6_birthPlace:     'birth_place',
  q5_birthPlace:     'birth_place',
  q7_deathDate:      'death_date',
  q8_deathPlace:     'death_place',
  q9_fatherName:     'father_name',
  q6_fatherName:     'father_name',
  q10_motherName:    'mother_name',
  q7_motherName:     'mother_name',
  q11_notes:         'notes',
  q8_notes:          'notes',
  q12_additionalInfo:'notes',
  q13_generations:   'generations',
  q9_generations:    'generations',
};

// ────────────────────────────────────────────────────────────────
// Token auth middleware for API endpoints
// ────────────────────────────────────────────────────────────────
function requireToken(req, res, next) {
  const token = req.query.token || req.headers['x-intake-token'];
  if (!config.INTAKE_SECRET) {
    return res.status(500).json({ error: 'INTAKE_SECRET not configured on server' });
  }
  if (!token || token !== config.INTAKE_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing token' });
  }
  next();
}

// ────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────

/**
 * Parse JotForm payload — handles both rawRequest (JSON string) and
 * direct field access formats.
 */
function parseJotFormPayload(body) {
  let fields = {};

  // JotForm sometimes sends everything inside a rawRequest JSON string
  if (body.rawRequest) {
    try {
      const raw = typeof body.rawRequest === 'string'
        ? JSON.parse(body.rawRequest)
        : body.rawRequest;
      fields = { ...raw };
    } catch (e) {
      console.warn('[API/Intake] Failed to parse rawRequest:', e.message);
    }
  }

  // Also merge top-level fields (JotForm sends both in some configs)
  for (const [key, value] of Object.entries(body)) {
    if (key === 'rawRequest') continue;
    if (value !== undefined && value !== null && value !== '') {
      fields[key] = value;
    }
  }

  return fields;
}

/** Safely get a string field value, trimmed. Returns '' if missing/empty. */
function str(fields, key) {
  const v = fields[key];
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/** Build a full name from first + middle + last fields, collapsing whitespace. */
function buildFullName(first, middle, last) {
  return [first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Format a birth/death year string for the notes grandparent lines. */
function formatYearRange(birthYear, birthDate, deathYear, isLiving) {
  // Prefer full date if available, otherwise use year
  const birth = birthDate || birthYear || '';
  const death = deathYear || '';
  const living = isLiving && isLiving.toLowerCase() === 'yes';

  if (!birth && !death) return '(unknown)';
  if (birth && !death && !living) return `(${birth})`;
  if (birth && death) return `(${birth}-${death})`;
  // Has birth, is living or unknown death status
  return `(${birth})`;
}

/** Build place string "town, county" from two fields, omitting empty parts. */
function buildPlace(town, county) {
  return [town, county].filter(Boolean).join(', ');
}


// ════════════════════════════════════════════════════════════════
// NEW FORM SUBMISSION HANDLER (JotForm spec v1.0)
// ════════════════════════════════════════════════════════════════
//
// POST /api/form-submission
//
// Handles the structured intake form with two paths:
//   1. With Children — one research job per child
//   2. Without Children — single root person
//
// Field IDs match the jotform-spec.md Field ID column exactly.
//
// GENERATION MAPPING (from the child / root person outwards):
//   Gen 0 (asc#1):     child or root person      (Stage 2 / Stage 1B)
//   Gen 1 (asc#2-3):   parents                   (Stage 4 / Stage 2B)
//   Gen 2 (asc#4-7):   grandparents              (Stage 5 / Stage 2B — user/partner parents)
//   Gen 3 (asc#8-15):  great-grandparents        (Stage 6 / Stage 3B — user/partner grandparents)
//   Gen 4 (asc#16-31): 2x great-grandparents     (Stage 7 / Stage 4B — optional, stored in notes)
//
// The form's Stage 5 captures the USER's and PARTNER's parents, which
// are the CHILD's grandparents (gen 2). Stage 6 captures the USER's
// and PARTNER's grandparents, which are the CHILD's great-grandparents
// (gen 3). Stage 7 captures the parents of those grandparents (gen 4).
// ════════════════════════════════════════════════════════════════

/**
 * Extract a person block from the flat JotForm fields using a field prefix.
 * Handles the standard person schema: first_name, middle_names, last_name_at_birth,
 * current_last_name, sex_at_birth, birth_date, birth_year, birth_place_town,
 * birth_place_county, is_living, death_year, known.
 */
function extractPerson(fields, prefix) {
  const firstName   = str(fields, `${prefix}_first_name`);
  const middleNames = str(fields, `${prefix}_middle_names`);
  const lastNameBirth = str(fields, `${prefix}_last_name_at_birth`);
  const currentLast = str(fields, `${prefix}_current_last_name`);
  const sexAtBirth  = str(fields, `${prefix}_sex_at_birth`);
  const birthDate   = str(fields, `${prefix}_birth_date`);
  const birthYear   = str(fields, `${prefix}_birth_year`);
  const birthTown   = str(fields, `${prefix}_birth_place_town`);
  const birthCounty = str(fields, `${prefix}_birth_place_county`);
  const isLiving    = str(fields, `${prefix}_is_living`);
  const deathYear   = str(fields, `${prefix}_death_year`);
  const known       = str(fields, `${prefix}_known`);

  const fullName = buildFullName(firstName, middleNames, lastNameBirth);
  const birthPlace = buildPlace(birthTown, birthCounty);

  return {
    firstName,
    middleNames,
    lastNameBirth,
    currentLast,
    sexAtBirth,
    birthDate,
    birthYear,
    birthTown,
    birthCounty,
    birthPlace,
    isLiving,
    deathYear,
    known: known.toLowerCase() !== 'no',   // default to true if not set
    fullName,
    gender: sexAtBirth === 'Female' ? 'Female' : (sexAtBirth === 'Male' ? 'Male' : 'Unknown'),
    hasData: !!firstName,
  };
}

/**
 * Extract a great-grandparent (gen 4) block from Stage 7.
 * These have a simpler schema: {prefix}_ggf_first_name / {prefix}_ggm_first_name etc.
 */
function extractGGParent(fields, prefix, suffix) {
  // suffix is 'ggf' or 'ggm'
  const key = `${prefix}_${suffix}`;
  const firstName   = str(fields, `${key}_first_name`);
  const middleNames = str(fields, `${key}_middle_names`);
  const lastNameBirth = str(fields, `${key}_last_name_at_birth`);
  const birthYear   = str(fields, `${key}_birth_year`);
  const birthTown   = str(fields, `${key}_birth_place_town`);
  const birthCounty = str(fields, `${key}_birth_place_county`);

  const fullName = buildFullName(firstName, middleNames, lastNameBirth);
  const birthPlace = buildPlace(birthTown, birthCounty);
  const gender = suffix === 'ggf' ? 'Male' : 'Female';

  return {
    firstName,
    middleNames,
    lastNameBirth,
    birthYear,
    birthTown,
    birthCounty,
    birthPlace,
    fullName,
    gender,
    hasData: !!firstName,
  };
}

/**
 * Build the notes string for a single research job, formatted exactly as
 * parseNotesForAnchors() expects.
 *
 * Notes format (matching research engine parser):
 *   - "Paternal grandfather: Name (birthYear-deathYear) town, county" -> asc#4
 *   - "Paternal grandmother: Name ..." -> asc#5
 *   - "Maternal grandfather: Name ..." -> asc#6
 *   - "Maternal grandmother: Name ..." -> asc#7
 *   - "Great-grandfather (paternal paternal): Name" -> asc#8
 *   - "Great-grandmother (paternal paternal): Name" -> asc#9
 *   - etc.
 *
 * IMPORTANT: The "grandparent" lines (asc#4-7) are populated from Stage 5
 * data (user_dad, user_mum, partner_dad, partner_mum — the child's
 * grandparents). The "great-grandparent" lines (asc#8-15) are populated
 * from Stage 6 data (user_pat_gf, user_pat_gm, etc. — the child's
 * great-grandparents). Stage 7 data is gen 4 from the child and is
 * appended as additional notes.
 *
 * @param {object} opts
 * @param {object} opts.patGF - asc#4 paternal grandfather (child's perspective)
 * @param {object} opts.patGM - asc#5 paternal grandmother
 * @param {object} opts.matGF - asc#6 maternal grandfather
 * @param {object} opts.matGM - asc#7 maternal grandmother
 * @param {object} opts.greatGPs - { 8: person, 9: person, ... 15: person } for asc#8-15
 * @param {object} opts.gen4 - { 'paternal paternal': { ggf, ggm }, ... } for asc#16-31
 * @param {object} opts.extras - additional notes fields
 */
function buildNotesString(opts) {
  const lines = [];
  const { patGF, patGM, matGF, matGM, greatGPs, gen4, extras } = opts;

  // ── Grandparents (asc#4-7) ──
  // Format: "Paternal grandfather: Full Name (birth-death) town, county"
  if (patGF && patGF.known && patGF.fullName) {
    const yr = formatYearRange(patGF.birthYear, patGF.birthDate, patGF.deathYear, patGF.isLiving);
    const place = patGF.birthPlace ? ` ${patGF.birthPlace}` : '';
    lines.push(`Paternal grandfather: ${patGF.fullName} ${yr}${place}`);
  }
  if (patGM && patGM.known && patGM.fullName) {
    const yr = formatYearRange(patGM.birthYear, patGM.birthDate, patGM.deathYear, patGM.isLiving);
    const place = patGM.birthPlace ? ` ${patGM.birthPlace}` : '';
    lines.push(`Paternal grandmother: ${patGM.fullName} ${yr}${place}`);
  }
  if (matGF && matGF.known && matGF.fullName) {
    const yr = formatYearRange(matGF.birthYear, matGF.birthDate, matGF.deathYear, matGF.isLiving);
    const place = matGF.birthPlace ? ` ${matGF.birthPlace}` : '';
    lines.push(`Maternal grandfather: ${matGF.fullName} ${yr}${place}`);
  }
  if (matGM && matGM.known && matGM.fullName) {
    const yr = formatYearRange(matGM.birthYear, matGM.birthDate, matGM.deathYear, matGM.isLiving);
    const place = matGM.birthPlace ? ` ${matGM.birthPlace}` : '';
    lines.push(`Maternal grandmother: ${matGM.fullName} ${yr}${place}`);
  }

  // ── Great-grandparents (asc#8-15) from Stage 6 data ──
  // Format: "Great-grandfather (paternal paternal): Full Name (birthYear) place"
  // Asc mapping: 8/9 = pat pat, 10/11 = pat mat, 12/13 = mat pat, 14/15 = mat mat
  const ggBranches = [
    { label: 'paternal paternal', fatherAsc: 8,  motherAsc: 9  },
    { label: 'paternal maternal', fatherAsc: 10, motherAsc: 11 },
    { label: 'maternal paternal', fatherAsc: 12, motherAsc: 13 },
    { label: 'maternal maternal', fatherAsc: 14, motherAsc: 15 },
  ];

  for (const branch of ggBranches) {
    const gf = greatGPs[branch.fatherAsc];
    const gm = greatGPs[branch.motherAsc];

    if (gf && gf.known && gf.fullName) {
      let entry = `Great-grandfather (${branch.label}): ${gf.fullName}`;
      const yr = gf.birthDate || gf.birthYear;
      if (yr) {
        const death = gf.deathYear || '';
        entry += death ? ` (${yr}-${death})` : ` (${yr})`;
      }
      if (gf.birthPlace) entry += ` ${gf.birthPlace}`;
      lines.push(entry);
    }
    if (gm && gm.known && gm.fullName) {
      let entry = `Great-grandmother (${branch.label}): ${gm.fullName}`;
      const yr = gm.birthDate || gm.birthYear;
      if (yr) {
        const death = gm.deathYear || '';
        entry += death ? ` (${yr}-${death})` : ` (${yr})`;
      }
      if (gm.birthPlace) entry += ` ${gm.birthPlace}`;
      lines.push(entry);
    }
  }

  // ── Gen 4 data (asc#16-31 from Stage 7) — appended as additional info ──
  // These are beyond what parseNotesForAnchors handles for asc#8-15, but
  // are stored in notes for the research engine and admin reference.
  if (gen4) {
    const gen4Branches = ['paternal paternal', 'paternal maternal', 'maternal paternal', 'maternal maternal'];
    for (const branch of gen4Branches) {
      const pair = gen4[branch];
      if (!pair) continue;
      if (pair.ggf && pair.ggf.hasData) {
        let entry = `2x Great-grandfather (${branch}): ${pair.ggf.fullName}`;
        if (pair.ggf.birthYear) entry += ` (${pair.ggf.birthYear})`;
        if (pair.ggf.birthPlace) entry += ` ${pair.ggf.birthPlace}`;
        lines.push(entry);
      }
      if (pair.ggm && pair.ggm.hasData) {
        let entry = `2x Great-grandmother (${branch}): ${pair.ggm.fullName}`;
        if (pair.ggm.birthYear) entry += ` (${pair.ggm.birthYear})`;
        if (pair.ggm.birthPlace) entry += ` ${pair.ggm.birthPlace}`;
        lines.push(entry);
      }
    }
    // Extra gen4 blocks (grandmother-side parents that don't map to the
    // four primary branches)
    if (gen4._extra && gen4._extra.length > 0) {
      for (const item of gen4._extra) {
        const role = item.role === 'ggf' ? '2x Great-grandfather' : '2x Great-grandmother';
        let entry = `${role} (${item.prefix}): ${item.person.fullName}`;
        if (item.person.birthYear) entry += ` (${item.person.birthYear})`;
        if (item.person.birthPlace) entry += ` ${item.person.birthPlace}`;
        lines.push(entry);
      }
    }
  }

  // ── Extra notes ──
  if (extras.familyTowns) lines.push(`Family locations: ${extras.familyTowns}`);
  if (extras.familyCounties) lines.push(`Family counties: ${extras.familyCounties}`);
  if (extras.knownMoves) lines.push(`Known moves: ${extras.knownMoves}`);
  if (extras.parentsMarriageYear || extras.parentsMarriagePlace) {
    const parts = [];
    if (extras.parentsMarriageYear) parts.push(extras.parentsMarriageYear);
    if (extras.parentsMarriagePlace) parts.push(`at ${extras.parentsMarriagePlace}`);
    lines.push(`Parents married: ${parts.join(' ')}`);
  }
  if (extras.userParentsMarriageYear || extras.userParentsMarriagePlace) {
    const parts = [];
    if (extras.userParentsMarriageYear) parts.push(extras.userParentsMarriageYear);
    if (extras.userParentsMarriagePlace) parts.push(`at ${extras.userParentsMarriagePlace}`);
    lines.push(`Parents married: ${parts.join(' ')}`);
  }
  if (extras.partnerParentsMarriageYear || extras.partnerParentsMarriagePlace) {
    const parts = [];
    if (extras.partnerParentsMarriageYear) parts.push(extras.partnerParentsMarriageYear);
    if (extras.partnerParentsMarriagePlace) parts.push(`at ${extras.partnerParentsMarriagePlace}`);
    lines.push(`Partner's parents married: ${parts.join(' ')}`);
  }
  if (extras.adoptionDetails) lines.push(`Adoption note: ${extras.adoptionDetails}`);
  if (extras.surnameChangeDetails) lines.push(`Surname changes: ${extras.surnameChangeDetails}`);
  if (extras.additionalNotes) lines.push(`Additional: ${extras.additionalNotes}`);

  return lines.join('\n');
}

/**
 * Create ancestor records directly from structured form data.
 * This populates ancestors at the correct Ahnentafel positions without
 * relying on the notes-based parseNotesForAnchors() approach.
 *
 * @param {string} jobId
 * @param {object} subject - { fullName, gender, birthDate, birthPlace, deathDate, deathPlace }
 * @param {object|null} father  - person object for asc#2
 * @param {object|null} mother  - person object for asc#3
 * @param {object} grandparents - { 4: person, 5: person, 6: person, 7: person }
 * @param {object} greatGPs - { 8: person, 9: person, ... 15: person }
 * @returns {number} count of ancestors created
 */
function createAncestorsFromStructuredData(jobId, subject, father, mother, grandparents, greatGPs) {
  const baseAncestor = {
    fs_person_id: '',
    confidence: 'customer_data',
    sources: [],
    raw_data: {},
    confidence_score: 100,
    confidence_level: 'Customer Data',
    evidence_chain: [],
    search_log: [],
    conflicts: [],
    verification_notes: 'Customer-provided data (JotForm intake form v2)',
    accepted: 1,
  };

  let count = 0;

  // Asc#1 = Subject (child or root person)
  db.addAncestor({
    ...baseAncestor,
    research_job_id: jobId,
    name: subject.fullName,
    gender: subject.gender || 'Unknown',
    birth_date: subject.birthDate || '',
    birth_place: subject.birthPlace || '',
    death_date: subject.deathDate || '',
    death_place: subject.deathPlace || '',
    ascendancy_number: 1,
    generation: 0,
  });
  count++;

  // Asc#2 = Father
  if (father && father.fullName) {
    db.addAncestor({
      ...baseAncestor,
      research_job_id: jobId,
      name: father.fullName,
      gender: 'Male',
      birth_date: father.birthDate || '',
      birth_place: father.birthPlace || '',
      death_date: father.deathYear || '',
      death_place: '',
      ascendancy_number: 2,
      generation: 1,
    });
    count++;
  }

  // Asc#3 = Mother
  if (mother && mother.fullName) {
    db.addAncestor({
      ...baseAncestor,
      research_job_id: jobId,
      name: mother.fullName,
      gender: 'Female',
      birth_date: mother.birthDate || '',
      birth_place: mother.birthPlace || '',
      death_date: mother.deathYear || '',
      death_place: '',
      ascendancy_number: 3,
      generation: 1,
    });
    count++;
  }

  // Asc#4-7 = Grandparents (from Stage 5: user/partner parents)
  for (const ascNum of [4, 5, 6, 7]) {
    const gp = grandparents[ascNum];
    if (gp && gp.known && gp.fullName) {
      const gender = ascNum % 2 === 0 ? 'Male' : 'Female';
      console.log(`[API/FormSubmission] Grandparent asc#${ascNum}: ${gp.fullName}`);
      db.addAncestor({
        ...baseAncestor,
        research_job_id: jobId,
        name: gp.fullName,
        gender,
        birth_date: gp.birthDate || gp.birthYear || '',
        birth_place: gp.birthPlace || '',
        death_date: gp.deathYear || '',
        death_place: '',
        ascendancy_number: ascNum,
        generation: 2,
      });
      count++;
    }
  }

  // Asc#8-15 = Great-grandparents (from Stage 6: user/partner grandparents)
  for (const ascNum of [8, 9, 10, 11, 12, 13, 14, 15]) {
    const ggp = greatGPs[ascNum];
    if (ggp && ggp.known && ggp.fullName) {
      const gender = ascNum % 2 === 0 ? 'Male' : 'Female';
      console.log(`[API/FormSubmission] Great-grandparent asc#${ascNum}: ${ggp.fullName}`);
      db.addAncestor({
        ...baseAncestor,
        research_job_id: jobId,
        name: ggp.fullName,
        gender,
        birth_date: ggp.birthDate || ggp.birthYear || '',
        birth_place: ggp.birthPlace || '',
        death_date: ggp.deathYear || '',
        death_place: '',
        ascendancy_number: ascNum,
        generation: 3,
      });
      count++;
    }
  }

  return count;
}


// ────────────────────────────────────────────────────────────────
// POST /api/form-submission — New structured JotForm webhook
// ────────────────────────────────────────────────────────────────
router.post('/form-submission', requireToken, (req, res) => {
  try {
    console.log('[API/FormSubmission] Received webhook payload, content-type:', req.headers['content-type']);

    const fields = parseJotFormPayload(req.body);
    const submissionId = fields.submissionID || fields.submission_id || '';
    const formId = fields.formID || fields.form_id || '';

    console.log(`[API/FormSubmission] FormID: ${formId}, SubmissionID: ${submissionId}, Fields: ${Object.keys(fields).length}`);

    // ── Determine path: with or without children ──
    const hasChildren = str(fields, 'has_children').toLowerCase() === 'yes';

    // ── Contact details (shared across both paths) ──
    const customerName  = str(fields, 'customer_full_name');
    const customerEmail = str(fields, 'customer_email');
    const customerPhone = str(fields, 'customer_phone');
    const orderRef      = str(fields, 'order_reference');

    // ── Extra notes fields (shared) ──
    const extras = {
      familyTowns: str(fields, 'family_towns'),
      familyCounties: str(fields, 'family_counties'),
      knownMoves: str(fields, 'known_moves'),
      adoptionDetails: str(fields, 'has_adoption') === 'Yes' ? str(fields, 'adoption_details') : '',
      surnameChangeDetails: str(fields, 'has_surname_change') === 'Yes' ? str(fields, 'surname_change_details') : '',
      additionalNotes: str(fields, 'additional_notes'),
      userParentsMarriageYear: '',
      userParentsMarriagePlace: '',
      partnerParentsMarriageYear: '',
      partnerParentsMarriagePlace: '',
      parentsMarriageYear: '',
      parentsMarriagePlace: '',
    };

    if (hasChildren) {
      return handleWithChildrenPath(fields, {
        formId, submissionId, customerName, customerEmail, customerPhone, orderRef, extras,
      }, res);
    } else {
      return handleWithoutChildrenPath(fields, {
        formId, submissionId, customerName, customerEmail, customerPhone, orderRef, extras,
      }, res);
    }
  } catch (err) {
    console.error('[API/FormSubmission] Error processing webhook:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});


/**
 * Handle the "With Children" path.
 * Creates one research job per child.
 *
 * Generation mapping (from child's perspective):
 *   Gen 0 (asc#1):    child                  (Stage 2)
 *   Gen 1 (asc#2-3):  user + partner          (Stage 4)
 *   Gen 2 (asc#4-7):  user_dad, user_mum, partner_dad, partner_mum  (Stage 5)
 *   Gen 3 (asc#8-15): user_pat_gf, user_pat_gm, ... (Stage 6)
 *   Gen 4 (asc#16+):  user_pat_gf_ggf, etc.  (Stage 7 — stored in notes only)
 */
function handleWithChildrenPath(fields, ctx, res) {
  const { formId, submissionId, customerName, customerEmail, customerPhone, orderRef, extras } = ctx;

  // ── Role determination ──
  const userRole = str(fields, 'user_role');
  const userIsDad = userRole.toLowerCase().includes('dad');

  console.log(`[API/FormSubmission] With-children path. user_role="${userRole}", userIsDad=${userIsDad}`);

  // ── Extract parent persons (Stage 4 = Gen 1 from child) ──
  const user = extractPerson(fields, 'user');
  const partner = extractPerson(fields, 'partner');

  // Override gender based on role
  user.gender = userIsDad ? 'Male' : 'Female';
  partner.gender = userIsDad ? 'Female' : 'Male';

  // Father and mother assignment (from child's perspective)
  const father = userIsDad ? user : partner;
  const mother = userIsDad ? partner : user;

  // ── Extract child's grandparents (Stage 5 = Gen 2 from child) ──
  // These are the user's and partner's biological parents.
  const userDad = extractPerson(fields, 'user_dad');
  const userMum = extractPerson(fields, 'user_mum');
  const partnerDad = extractPerson(fields, 'partner_dad');
  const partnerMum = extractPerson(fields, 'partner_mum');

  // Map to Ahnentafel positions (from child's perspective):
  //   If user is dad (asc#2): user_dad=asc#4, user_mum=asc#5, partner_dad=asc#6, partner_mum=asc#7
  //   If user is mum (asc#3): partner_dad=asc#4, partner_mum=asc#5, user_dad=asc#6, user_mum=asc#7
  let patGF, patGM, matGF, matGM;
  if (userIsDad) {
    patGF = userDad;     // asc#4 — paternal grandfather
    patGM = userMum;     // asc#5 — paternal grandmother
    matGF = partnerDad;  // asc#6 — maternal grandfather
    matGM = partnerMum;  // asc#7 — maternal grandmother
  } else {
    patGF = partnerDad;  // asc#4
    patGM = partnerMum;  // asc#5
    matGF = userDad;     // asc#6
    matGM = userMum;     // asc#7
  }
  const grandparents = { 4: patGF, 5: patGM, 6: matGF, 7: matGM };

  // ── Extract child's great-grandparents (Stage 6 = Gen 3 from child) ──
  // These are the user's and partner's grandparents.
  // Stage 6A: user_dad's parents = user_pat_gf, user_pat_gm
  // Stage 6B: user_mum's parents = user_mat_gf, user_mat_gm
  // Stage 6C: partner_dad's parents = partner_pat_gf, partner_pat_gm
  // Stage 6D: partner_mum's parents = partner_mat_gf, partner_mat_gm
  const userPatGF  = extractPerson(fields, 'user_pat_gf');
  const userPatGM  = extractPerson(fields, 'user_pat_gm');
  const userMatGF  = extractPerson(fields, 'user_mat_gf');
  const userMatGM  = extractPerson(fields, 'user_mat_gm');
  const partnerPatGF = extractPerson(fields, 'partner_pat_gf');
  const partnerPatGM = extractPerson(fields, 'partner_pat_gm');
  const partnerMatGF = extractPerson(fields, 'partner_mat_gf');
  const partnerMatGM = extractPerson(fields, 'partner_mat_gm');

  // Map to Ahnentafel (from child's perspective):
  //   asc#8  = father's father's father = (when user=dad) user_pat_gf
  //   asc#9  = father's father's mother = (when user=dad) user_pat_gm
  //   asc#10 = father's mother's father = (when user=dad) user_mat_gf
  //   asc#11 = father's mother's mother = (when user=dad) user_mat_gm
  //   asc#12 = mother's father's father = (when user=dad) partner_pat_gf
  //   asc#13 = mother's father's mother = (when user=dad) partner_pat_gm
  //   asc#14 = mother's mother's father = (when user=dad) partner_mat_gf
  //   asc#15 = mother's mother's mother = (when user=dad) partner_mat_gm
  let greatGPs;
  if (userIsDad) {
    greatGPs = {
      8:  userPatGF,      // pat pat GGF
      9:  userPatGM,      // pat pat GGM
      10: userMatGF,      // pat mat GGF
      11: userMatGM,      // pat mat GGM
      12: partnerPatGF,   // mat pat GGF
      13: partnerPatGM,   // mat pat GGM
      14: partnerMatGF,   // mat mat GGF
      15: partnerMatGM,   // mat mat GGM
    };
  } else {
    greatGPs = {
      8:  partnerPatGF,   // pat pat GGF
      9:  partnerPatGM,   // pat pat GGM
      10: partnerMatGF,   // pat mat GGF
      11: partnerMatGM,   // pat mat GGM
      12: userPatGF,      // mat pat GGF
      13: userPatGM,      // mat pat GGM
      14: userMatGF,      // mat mat GGF
      15: userMatGM,      // mat mat GGM
    };
  }

  // ── Extract gen 4 data (Stage 7 — optional, stored in notes only) ──
  // These are the parents of the child's great-grandparents.
  // Block 7A: user_pat_gf's parents = user_pat_gf_ggf, user_pat_gf_ggm
  // Block 7B: user_pat_gm's parents = user_pat_gm_ggf, user_pat_gm_ggm
  // etc.
  const gen4blocks = {};
  const gen4prefixes = ['user_pat_gf', 'user_pat_gm', 'user_mat_gf', 'user_mat_gm',
                        'partner_pat_gf', 'partner_pat_gm', 'partner_mat_gf', 'partner_mat_gm'];
  for (const prefix of gen4prefixes) {
    const ggf = extractGGParent(fields, prefix, 'ggf');
    const ggm = extractGGParent(fields, prefix, 'ggm');
    if (ggf.hasData || ggm.hasData) {
      gen4blocks[prefix] = { ggf, ggm };
    }
  }

  // Map gen4 blocks to branch labels (from child's perspective)
  // When user=dad:
  //   user_pat_gf's parents => fathers of asc#8 = "paternal paternal" branch gen4
  //   user_pat_gm's parents => fathers of asc#9 = still "paternal paternal" branch gen4
  //   Actually, each gen4 block maps to a unique "sub-branch":
  //     user_pat_gf parents = pat-pat-pat/pat-pat-mat
  //     user_pat_gm parents = pat-mat-pat/pat-mat-mat (actually: pat pat = father's father's side)
  //
  // For notes, we use the same two-word branch labels as gen 3, appended to the
  // grandparent name for context. This keeps gen4 data in the notes as free text
  // that the research engine can use.
  let gen4ForNotes;
  if (userIsDad) {
    gen4ForNotes = {
      'paternal paternal': gen4blocks['user_pat_gf']   || null,
      'paternal maternal': gen4blocks['user_mat_gf']   || null,   // Note: user_mat_gf = user's mum's dad
      'maternal paternal': gen4blocks['partner_pat_gf'] || null,
      'maternal maternal': gen4blocks['partner_mat_gf'] || null,
    };
    // Also include the grandmother-side gen4 blocks
    // user_pat_gm = father's father's mother (asc#9) -> parents are asc#18,19
    // These don't have a clean two-word label, so append them as extra blocks
    const extraGen4 = [];
    for (const [prefix, pair] of Object.entries(gen4blocks)) {
      // Skip the ones already mapped
      if (['user_pat_gf', 'user_mat_gf', 'partner_pat_gf', 'partner_mat_gf'].includes(prefix)) continue;
      if (pair.ggf && pair.ggf.hasData) {
        extraGen4.push({ prefix, role: 'ggf', person: pair.ggf });
      }
      if (pair.ggm && pair.ggm.hasData) {
        extraGen4.push({ prefix, role: 'ggm', person: pair.ggm });
      }
    }
    gen4ForNotes._extra = extraGen4;
  } else {
    gen4ForNotes = {
      'paternal paternal': gen4blocks['partner_pat_gf'] || null,
      'paternal maternal': gen4blocks['partner_mat_gf'] || null,
      'maternal paternal': gen4blocks['user_pat_gf']    || null,
      'maternal maternal': gen4blocks['user_mat_gf']    || null,
    };
    const extraGen4 = [];
    for (const [prefix, pair] of Object.entries(gen4blocks)) {
      if (['partner_pat_gf', 'partner_mat_gf', 'user_pat_gf', 'user_mat_gf'].includes(prefix)) continue;
      if (pair.ggf && pair.ggf.hasData) {
        extraGen4.push({ prefix, role: 'ggf', person: pair.ggf });
      }
      if (pair.ggm && pair.ggm.hasData) {
        extraGen4.push({ prefix, role: 'ggm', person: pair.ggm });
      }
    }
    gen4ForNotes._extra = extraGen4;
  }

  // ── Marriage extras ──
  extras.parentsMarriageYear  = str(fields, 'parents_marriage_year');
  extras.parentsMarriagePlace = str(fields, 'parents_marriage_place');
  extras.userParentsMarriageYear    = str(fields, 'user_parents_marriage_year');
  extras.userParentsMarriagePlace   = str(fields, 'user_parents_marriage_place');
  extras.partnerParentsMarriageYear = str(fields, 'partner_parents_marriage_year');
  extras.partnerParentsMarriagePlace = str(fields, 'partner_parents_marriage_place');

  // ── Build the notes string ──
  const notes = buildNotesString({
    patGF, patGM, matGF, matGM,
    greatGPs,
    gen4: gen4ForNotes,
    extras,
  });

  // ── Discover children ──
  const children = [];
  for (let i = 1; i <= 6; i++) {
    const childFirstName = str(fields, `child${i}_first_name`);
    if (!childFirstName) break;

    const child = {
      firstName: childFirstName,
      middleNames: str(fields, `child${i}_middle_names`),
      lastNameBirth: str(fields, `child${i}_last_name_at_birth`),
      sexAtBirth: str(fields, `child${i}_sex_at_birth`),
      birthDate: str(fields, `child${i}_birth_date`),
      birthTown: str(fields, `child${i}_birth_place_town`),
      birthCounty: str(fields, `child${i}_birth_place_county`),
    };
    child.fullName = buildFullName(child.firstName, child.middleNames, child.lastNameBirth);
    child.birthPlace = buildPlace(child.birthTown, child.birthCounty);
    child.gender = child.sexAtBirth === 'Female' ? 'Female' : (child.sexAtBirth === 'Male' ? 'Male' : 'Unknown');

    children.push(child);

    // Check if "add another child" was answered No
    if (i < 6) {
      const addNext = str(fields, `add_child_${i + 1}`);
      if (addNext.toLowerCase() === 'no') break;
    }
  }

  if (children.length === 0) {
    console.warn('[API/FormSubmission] With-children path but no children found');
    return res.status(400).json({
      error: 'No children found',
      detail: 'With-children path selected but no child1_first_name provided',
    });
  }

  if (!father.fullName && !mother.fullName) {
    console.warn('[API/FormSubmission] No parent names found');
    return res.status(400).json({
      error: 'Missing parent data',
      detail: 'At least one parent (user or partner) must have a name',
    });
  }

  // ── Create one research job per child ──
  const jobIds = [];
  const jobSummaries = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const jobId = uuidv4();

    const givenName = [child.firstName, child.middleNames].filter(Boolean).join(' ').trim();
    const inputData = {
      given_name: givenName,
      surname: child.lastNameBirth,
      birth_date: child.birthDate,
      birth_place: child.birthPlace,
      death_date: '',
      death_place: '',
      father_name: father.fullName,
      mother_name: mother.fullName,
      notes: notes,
      _source: 'jotform_v2',
      _form_id: formId,
      _submission_id: submissionId,
      _path: 'with_children',
      _child_index: i + 1,
      _child_count: children.length,
      _user_role: userRole,
      _order_reference: orderRef,
    };

    db.createResearchJob({
      id: jobId,
      customer_name: customerName || father.fullName || mother.fullName,
      customer_email: customerEmail,
      generations: 6,
      input_data: inputData,
    });

    const subject = {
      fullName: child.fullName,
      gender: child.gender,
      birthDate: child.birthDate,
      birthPlace: child.birthPlace,
      deathDate: '',
      deathPlace: '',
    };

    const fatherForAncestors = {
      fullName: father.fullName,
      birthDate: father.birthDate,
      birthPlace: father.birthPlace,
      deathYear: '',
    };
    const motherForAncestors = {
      fullName: mother.fullName,
      birthDate: mother.birthDate,
      birthPlace: mother.birthPlace,
      deathYear: '',
    };

    const ancestorCount = createAncestorsFromStructuredData(
      jobId, subject, fatherForAncestors, motherForAncestors,
      grandparents, greatGPs
    );

    console.log(`[API/FormSubmission] Created job ${jobId} for child "${child.fullName}" (${i + 1}/${children.length}) with ${ancestorCount} ancestors`);

    jobIds.push(jobId);
    jobSummaries.push({
      job_id: jobId,
      child_name: child.fullName,
      child_index: i + 1,
      ancestors_created: ancestorCount,
    });
  }

  res.status(201).json({
    success: true,
    path: 'with_children',
    customer_name: customerName,
    customer_email: customerEmail,
    children_count: children.length,
    jobs_created: jobIds.length,
    jobs: jobSummaries,
    status: 'pending',
    message: `${jobIds.length} research job(s) created, one per child. Awaiting admin approval.`,
  });
}


/**
 * Handle the "Without Children" path.
 * Creates a single research job for the root person.
 *
 * Generation mapping (from root person's perspective):
 *   Gen 0 (asc#1):    root person             (Stage 1B)
 *   Gen 1 (asc#2-3):  root_dad, root_mum      (Stage 2B)
 *   Gen 2 (asc#4-7):  root_pat_gf, etc.       (Stage 3B)
 *   Gen 3 (asc#8-15): root_pat_gf_ggf, etc.   (Stage 4B — stored in notes)
 */
function handleWithoutChildrenPath(fields, ctx, res) {
  const { formId, submissionId, customerName, customerEmail, customerPhone, orderRef, extras } = ctx;

  console.log('[API/FormSubmission] Without-children path');

  // ── Extract root person (Stage 1B = Gen 0) ──
  const root = extractPerson(fields, 'root');

  if (!root.firstName || !root.lastNameBirth) {
    console.warn('[API/FormSubmission] Missing root person data');
    return res.status(400).json({
      error: 'Missing required fields',
      detail: 'root_first_name and root_last_name_at_birth are required',
    });
  }

  // ── Extract root's parents (Stage 2B = Gen 1) ──
  const rootDad = extractPerson(fields, 'root_dad');
  const rootMum = extractPerson(fields, 'root_mum');

  // ── Extract root's grandparents (Stage 3B = Gen 2, asc#4-7) ──
  const rootPatGF = extractPerson(fields, 'root_pat_gf');
  const rootPatGM = extractPerson(fields, 'root_pat_gm');
  const rootMatGF = extractPerson(fields, 'root_mat_gf');
  const rootMatGM = extractPerson(fields, 'root_mat_gm');

  const grandparents = {
    4: rootPatGF,  // paternal grandfather
    5: rootPatGM,  // paternal grandmother
    6: rootMatGF,  // maternal grandfather
    7: rootMatGM,  // maternal grandmother
  };

  // ── For without-children path, the form collects up to gen 2 in Stage 3B ──
  // Stage 4B great-grandparents (gen 3) use the ggf/ggm suffix pattern.
  // These map to asc#8-15.
  const rootPatGF_ggf = extractGGParent(fields, 'root_pat_gf', 'ggf');
  const rootPatGF_ggm = extractGGParent(fields, 'root_pat_gf', 'ggm');
  const rootPatGM_ggf = extractGGParent(fields, 'root_pat_gm', 'ggf');
  const rootPatGM_ggm = extractGGParent(fields, 'root_pat_gm', 'ggm');
  const rootMatGF_ggf = extractGGParent(fields, 'root_mat_gf', 'ggf');
  const rootMatGF_ggm = extractGGParent(fields, 'root_mat_gf', 'ggm');
  const rootMatGM_ggf = extractGGParent(fields, 'root_mat_gm', 'ggf');
  const rootMatGM_ggm = extractGGParent(fields, 'root_mat_gm', 'ggm');

  // For the without-children path, the root person IS the subject.
  // Their grandparents are at Stage 3B = asc#4-7.
  // Stage 4B captures the PARENTS of the grandparents = asc#8-15.
  //
  // asc#8  = root_pat_gf_ggf (paternal grandfather's father)
  // asc#9  = root_pat_gf_ggm (paternal grandfather's mother)
  // asc#10 = root_pat_gm_ggf (paternal grandmother's father)
  // asc#11 = root_pat_gm_ggm (paternal grandmother's mother)
  // asc#12 = root_mat_gf_ggf (maternal grandfather's father)
  // asc#13 = root_mat_gf_ggm (maternal grandfather's mother)
  // asc#14 = root_mat_gm_ggf (maternal grandmother's father)
  // asc#15 = root_mat_gm_ggm (maternal grandmother's mother)
  const greatGPs = {
    8:  { ...rootPatGF_ggf, known: rootPatGF_ggf.hasData },
    9:  { ...rootPatGF_ggm, known: rootPatGF_ggm.hasData },
    10: { ...rootPatGM_ggf, known: rootPatGM_ggf.hasData },
    11: { ...rootPatGM_ggm, known: rootPatGM_ggm.hasData },
    12: { ...rootMatGF_ggf, known: rootMatGF_ggf.hasData },
    13: { ...rootMatGF_ggm, known: rootMatGF_ggm.hasData },
    14: { ...rootMatGM_ggf, known: rootMatGM_ggf.hasData },
    15: { ...rootMatGM_ggm, known: rootMatGM_ggm.hasData },
  };

  // ── Marriage extras ──
  extras.userParentsMarriageYear  = str(fields, 'user_parents_marriage_year');
  extras.userParentsMarriagePlace = str(fields, 'user_parents_marriage_place');

  // ── Build notes ──
  // For the without-children path:
  //   "Paternal grandfather: root_pat_gf" -> asc#4
  //   "Paternal grandmother: root_pat_gm" -> asc#5
  //   "Maternal grandfather: root_mat_gf" -> asc#6
  //   "Maternal grandmother: root_mat_gm" -> asc#7
  //   "Great-grandfather (paternal paternal): root_pat_gf_ggf" -> asc#8
  //   etc.
  const notes = buildNotesString({
    patGF: rootPatGF,   // asc#4
    patGM: rootPatGM,   // asc#5
    matGF: rootMatGF,   // asc#6
    matGM: rootMatGM,   // asc#7
    greatGPs: greatGPs, // asc#8-15
    gen4: null,
    extras,
  });

  // ── Build input_data ──
  const givenName = [root.firstName, root.middleNames].filter(Boolean).join(' ').trim();
  const fatherName = rootDad.known ? rootDad.fullName : '';
  const motherName = rootMum.known ? rootMum.fullName : '';

  const inputData = {
    given_name: givenName,
    surname: root.lastNameBirth,
    birth_date: root.birthDate,
    birth_place: root.birthPlace,
    death_date: '',
    death_place: '',
    father_name: fatherName,
    mother_name: motherName,
    notes: notes,
    _source: 'jotform_v2',
    _form_id: formId,
    _submission_id: submissionId,
    _path: 'without_children',
    _order_reference: orderRef,
  };

  const jobId = uuidv4();

  db.createResearchJob({
    id: jobId,
    customer_name: customerName || root.fullName,
    customer_email: customerEmail,
    generations: 6,
    input_data: inputData,
  });

  const subject = {
    fullName: root.fullName,
    gender: root.gender,
    birthDate: root.birthDate,
    birthPlace: root.birthPlace,
    deathDate: '',
    deathPlace: '',
  };

  const fatherObj = rootDad.known && rootDad.fullName ? {
    fullName: rootDad.fullName,
    birthDate: rootDad.birthDate,
    birthPlace: rootDad.birthPlace,
    deathYear: rootDad.deathYear || '',
  } : null;

  const motherObj = rootMum.known && rootMum.fullName ? {
    fullName: rootMum.fullName,
    birthDate: rootMum.birthDate,
    birthPlace: rootMum.birthPlace,
    deathYear: rootMum.deathYear || '',
  } : null;

  // Grandparents for without-children: root's grandparents are asc#4-7
  const gpForAncestors = {
    4: rootPatGF,
    5: rootPatGM,
    6: rootMatGF,
    7: rootMatGM,
  };

  const ancestorCount = createAncestorsFromStructuredData(
    jobId, subject, fatherObj, motherObj,
    gpForAncestors, greatGPs
  );

  console.log(`[API/FormSubmission] Created job ${jobId} for root "${root.fullName}" with ${ancestorCount} ancestors`);

  res.status(201).json({
    success: true,
    path: 'without_children',
    job_id: jobId,
    customer_name: customerName || root.fullName,
    customer_email: customerEmail,
    subject: root.fullName,
    ancestors_created: ancestorCount,
    status: 'pending',
    message: 'Research job created. Awaiting admin approval to start research.',
  });
}


// ════════════════════════════════════════════════════════════════
// LEGACY ENDPOINTS (kept for backward compatibility)
// ════════════════════════════════════════════════════════════════

/**
 * Apply the legacy field mapping to extract structured data from JotForm fields.
 */
function mapFields(jotFields) {
  const mapped = {
    customer_name: '',
    customer_email: '',
    given_name: '',
    surname: '',
    birth_date: '',
    birth_place: '',
    death_date: '',
    death_place: '',
    father_name: '',
    mother_name: '',
    notes: '',
    generations: 4,
  };

  for (const [jotKey, internalField] of Object.entries(FIELD_MAPPING)) {
    const value = jotFields[jotKey];
    if (value === undefined || value === null || value === '') continue;

    if (internalField === 'subject_name') {
      if (typeof value === 'object' && value.first) {
        mapped.given_name = mapped.given_name || (value.first || '').trim();
        mapped.surname = mapped.surname || (value.last || '').trim();
      } else if (typeof value === 'string') {
        const parts = parseNameParts(value.trim());
        mapped.given_name = mapped.given_name || parts.givenName;
        mapped.surname = mapped.surname || parts.surname;
      }
    } else if (internalField === 'customer_name') {
      if (typeof value === 'object' && value.first) {
        mapped.customer_name = mapped.customer_name || `${value.first} ${value.last || ''}`.trim();
      } else if (typeof value === 'string') {
        mapped.customer_name = mapped.customer_name || value.trim();
      }
    } else if (internalField === 'generations') {
      const g = parseInt(value, 10);
      if (g >= 2 && g <= 7) mapped.generations = g;
    } else if (internalField === 'notes') {
      const noteText = typeof value === 'string' ? value.trim() : '';
      if (noteText) {
        mapped.notes = mapped.notes ? `${mapped.notes}\n${noteText}` : noteText;
      }
    } else {
      if (!mapped[internalField]) {
        mapped[internalField] = typeof value === 'string' ? value.trim() : String(value).trim();
      }
    }
  }

  if (!mapped.customer_name && mapped.given_name) {
    mapped.customer_name = `${mapped.given_name} ${mapped.surname}`.trim();
  }

  return mapped;
}

/**
 * Legacy: Create ancestor records from mapped data (notes-based parsing).
 * Used by the old /api/intake endpoint.
 */
function createAncestorsFromIntake(jobId, mapped) {
  const { given_name, surname, birth_date, birth_place, death_date, death_place, father_name, mother_name, notes } = mapped;
  const noteAnchors = parseNotesForAnchors(notes || '');

  const baseAncestor = {
    fs_person_id: '',
    confidence: 'customer_data',
    sources: [],
    raw_data: {},
    confidence_score: 100,
    confidence_level: 'Customer Data',
    evidence_chain: [],
    search_log: [],
    conflicts: [],
    verification_notes: 'Customer-provided data (JotForm intake)',
    accepted: 1,
  };

  let ancestorCount = 0;

  // Asc#1 = Subject
  db.addAncestor({
    ...baseAncestor,
    research_job_id: jobId,
    name: `${given_name} ${surname}`.trim(),
    gender: 'Unknown',
    birth_date: birth_date || '',
    birth_place: birth_place || '',
    death_date: death_date || '',
    death_place: death_place || '',
    ascendancy_number: 1,
    generation: 0,
  });
  ancestorCount++;

  // Asc#2 = Father
  if (father_name) {
    const fatherAnchor = noteAnchors[2] || {};
    db.addAncestor({
      ...baseAncestor,
      research_job_id: jobId,
      name: father_name,
      gender: 'Male',
      birth_date: fatherAnchor.birthDate || '',
      birth_place: fatherAnchor.birthPlace || birth_place || '',
      death_date: fatherAnchor.deathDate || '',
      death_place: fatherAnchor.deathPlace || '',
      ascendancy_number: 2,
      generation: 1,
    });
    ancestorCount++;
  }

  // Asc#3 = Mother
  if (mother_name) {
    const motherAnchor = noteAnchors[3] || {};
    db.addAncestor({
      ...baseAncestor,
      research_job_id: jobId,
      name: mother_name,
      gender: 'Female',
      birth_date: motherAnchor.birthDate || '',
      birth_place: motherAnchor.birthPlace || birth_place || '',
      death_date: motherAnchor.deathDate || '',
      death_place: motherAnchor.deathPlace || '',
      ascendancy_number: 3,
      generation: 1,
    });
    ancestorCount++;
  }

  // Asc#4-7 = Grandparents (from notes)
  for (const ascNum of [4, 5, 6, 7]) {
    const anchor = noteAnchors[ascNum];
    if (anchor && anchor.givenName) {
      const fullName = `${anchor.givenName} ${anchor.surname || ''}`.trim();
      const gender = ascNum % 2 === 0 ? 'Male' : 'Female';
      console.log(`[API/Intake] Pre-populating grandparent asc#${ascNum}: ${fullName} (${anchor.birthDate || '?'}-${anchor.deathDate || '?'})`);
      db.addAncestor({
        ...baseAncestor,
        research_job_id: jobId,
        name: fullName,
        gender,
        birth_date: anchor.birthDate || '',
        birth_place: anchor.birthPlace || birth_place || '',
        death_date: anchor.deathDate || '',
        death_place: anchor.deathPlace || '',
        ascendancy_number: ascNum,
        generation: 2,
        verification_notes: 'Customer-provided data (JotForm intake, from notes)',
      });
      ancestorCount++;
    }
  }

  // Asc#8-15 = Great-grandparents (from notes)
  for (const ascNum of [8, 9, 10, 11, 12, 13, 14, 15]) {
    const anchor = noteAnchors[ascNum];
    if (anchor && anchor.givenName) {
      const fullName = `${anchor.givenName} ${anchor.surname || ''}`.trim();
      const gender = ascNum % 2 === 0 ? 'Male' : 'Female';
      console.log(`[API/Intake] Pre-populating great-grandparent asc#${ascNum}: ${fullName}`);
      db.addAncestor({
        ...baseAncestor,
        research_job_id: jobId,
        name: fullName,
        gender,
        birth_date: anchor.birthDate || '',
        birth_place: anchor.birthPlace || '',
        death_date: anchor.deathDate || '',
        death_place: anchor.deathPlace || '',
        ascendancy_number: ascNum,
        generation: 3,
        verification_notes: 'Customer-provided data (JotForm intake, from notes)',
      });
      ancestorCount++;
    }
  }

  return ancestorCount;
}


// ────────────────────────────────────────────────────────────────
// POST /api/intake — Legacy JotForm webhook (backward compatible)
// ────────────────────────────────────────────────────────────────
router.post('/intake', requireToken, (req, res) => {
  try {
    console.log('[API/Intake] Received webhook payload, content-type:', req.headers['content-type']);

    const jotFields = parseJotFormPayload(req.body);
    const submissionId = jotFields.submissionID || jotFields.submission_id || '';
    const formId = jotFields.formID || jotFields.form_id || '';

    console.log(`[API/Intake] FormID: ${formId}, SubmissionID: ${submissionId}, Fields: ${Object.keys(jotFields).length}`);

    // Detect new form format and delegate to the new handler
    if (jotFields.has_children !== undefined && jotFields.has_children !== '') {
      console.log('[API/Intake] Detected new form format (has_children field), delegating to form-submission handler');
      const fields = jotFields;
      const hasChildren = str(fields, 'has_children').toLowerCase() === 'yes';
      const customerName  = str(fields, 'customer_full_name');
      const customerEmail = str(fields, 'customer_email');
      const customerPhone = str(fields, 'customer_phone');
      const orderRef      = str(fields, 'order_reference');
      const extras = {
        familyTowns: str(fields, 'family_towns'),
        familyCounties: str(fields, 'family_counties'),
        knownMoves: str(fields, 'known_moves'),
        adoptionDetails: str(fields, 'has_adoption') === 'Yes' ? str(fields, 'adoption_details') : '',
        surnameChangeDetails: str(fields, 'has_surname_change') === 'Yes' ? str(fields, 'surname_change_details') : '',
        additionalNotes: str(fields, 'additional_notes'),
        userParentsMarriageYear: '',
        userParentsMarriagePlace: '',
        partnerParentsMarriageYear: '',
        partnerParentsMarriagePlace: '',
        parentsMarriageYear: '',
        parentsMarriagePlace: '',
      };

      if (hasChildren) {
        return handleWithChildrenPath(fields, { formId, submissionId, customerName, customerEmail, customerPhone, orderRef, extras }, res);
      } else {
        return handleWithoutChildrenPath(fields, { formId, submissionId, customerName, customerEmail, customerPhone, orderRef, extras }, res);
      }
    }

    // Legacy mapping path
    const mapped = mapFields(jotFields);

    if (!mapped.given_name || !mapped.surname) {
      console.warn('[API/Intake] Missing required fields: given_name or surname');
      return res.status(400).json({
        error: 'Missing required fields',
        detail: 'Subject given_name and surname are required',
        received_fields: Object.keys(jotFields),
      });
    }

    const jobId = uuidv4();
    const inputData = {
      given_name: mapped.given_name,
      surname: mapped.surname,
      birth_date: mapped.birth_date,
      birth_place: mapped.birth_place,
      death_date: mapped.death_date,
      death_place: mapped.death_place,
      father_name: mapped.father_name,
      mother_name: mapped.mother_name,
      notes: mapped.notes,
    };

    db.createResearchJob({
      id: jobId,
      customer_name: mapped.customer_name,
      customer_email: mapped.customer_email,
      generations: mapped.generations,
      input_data: {
        ...inputData,
        _source: 'jotform',
        _form_id: formId,
        _submission_id: submissionId,
      },
    });

    const ancestorCount = createAncestorsFromIntake(jobId, mapped);

    console.log(`[API/Intake] Created job ${jobId} for "${mapped.customer_name}" with ${ancestorCount} ancestors (status: pending)`);

    res.status(201).json({
      success: true,
      job_id: jobId,
      customer_name: mapped.customer_name,
      subject: `${mapped.given_name} ${mapped.surname}`,
      ancestors_created: ancestorCount,
      status: 'pending',
      message: 'Research job created. Awaiting admin approval to start research.',
    });
  } catch (err) {
    console.error('[API/Intake] Error processing webhook:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/intake/jobs — List recent intake jobs
// ────────────────────────────────────────────────────────────────
router.get('/intake/jobs', requireToken, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const jobs = db.listResearchJobs(limit, 0);

    const intakeJobs = jobs
      .filter(j => {
        try {
          const data = typeof j.input_data === 'string' ? JSON.parse(j.input_data) : j.input_data;
          return data && (data._source === 'jotform' || data._source === 'jotform_v2');
        } catch {
          return false;
        }
      })
      .map(j => {
        const inputData = typeof j.input_data === 'string' ? JSON.parse(j.input_data) : j.input_data;
        const ancestors = db.getAncestors(j.id);
        return {
          id: j.id,
          customer_name: j.customer_name,
          customer_email: j.customer_email,
          status: j.status,
          generations: j.generations,
          subject: inputData ? `${inputData.given_name || ''} ${inputData.surname || ''}`.trim() : '',
          ancestors_count: ancestors.length,
          form_id: inputData?._form_id || '',
          submission_id: inputData?._submission_id || '',
          path: inputData?._path || 'legacy',
          child_index: inputData?._child_index || null,
          child_count: inputData?._child_count || null,
          created_at: j.created_at,
          completed_at: j.completed_at,
        };
      });

    res.json({
      success: true,
      count: intakeJobs.length,
      jobs: intakeJobs,
    });
  } catch (err) {
    console.error('[API/Intake] Error listing jobs:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// POST /api/intake/:id/approve — Approve and start research
// ────────────────────────────────────────────────────────────────
router.post('/intake/:id/approve', requireToken, async (req, res) => {
  try {
    const job = db.getResearchJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Research job not found' });
    }
    if (job.status !== 'pending') {
      return res.status(409).json({
        error: 'Job is not in pending status',
        current_status: job.status,
      });
    }

    const inputData = job.input_data || {};
    const sources = buildSourceRegistry();
    console.log(`[API/Intake] Approving and starting job ${req.params.id} with ${sources.length} sources: ${sources.map(s => s.sourceName).join(', ')}`);

    const engine = new ResearchEngine(db, req.params.id, inputData, job.generations, sources);
    engine.run().catch(err => {
      console.error(`[API/Intake] Research job ${req.params.id} failed:`, err);
    });

    res.json({
      success: true,
      job_id: req.params.id,
      status: 'running',
      message: 'Research started. Monitor progress via the admin dashboard.',
    });
  } catch (err) {
    console.error('[API/Intake] Error approving job:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/intake/:id — Get job status (convenience endpoint)
// ────────────────────────────────────────────────────────────────
router.get('/intake/:id', requireToken, (req, res) => {
  try {
    const job = db.getResearchJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Research job not found' });
    }

    const ancestors = db.getAncestors(req.params.id);
    const inputData = job.input_data || {};

    res.json({
      success: true,
      job: {
        id: job.id,
        customer_name: job.customer_name,
        customer_email: job.customer_email,
        status: job.status,
        generations: job.generations,
        subject: `${inputData.given_name || ''} ${inputData.surname || ''}`.trim(),
        ancestors_count: ancestors.length,
        accepted_count: ancestors.filter(a => a.accepted || a.confidence_level === 'Customer Data').length,
        progress_message: job.progress_message || '',
        progress_current: job.progress_current || 0,
        progress_total: job.progress_total || 0,
        created_at: job.created_at,
        completed_at: job.completed_at,
        error_message: job.error_message || '',
      },
    });
  } catch (err) {
    console.error('[API/Intake] Error getting job:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

module.exports = router;
