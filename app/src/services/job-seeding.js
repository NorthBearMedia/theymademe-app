/**
 * They Made Me — create a research job from an UPLOADED FAMILY TREE (GEDCOM).
 *
 * TRUST POLICY (deliberate): an uploaded tree is someone else's — usually
 * unsourced — claim. Only the first `seedMaxAsc` positions become "Customer
 * Data" (100%, never overwritten). Everything deeper is stored as a LEAD in
 * input_data.gedcom_leads: the engine researches those slots independently and
 * then cross-checks (agreement = small capped bonus; disagreement = flagged for
 * human review, never auto-resolved). See RULES.corroboration.
 *
 * Rows are written DIRECTLY (not via the free-text notes parser) and `notes` is
 * left empty on purpose: the engine's ensureCustomerDataStored() would otherwise
 * re-create anything it can parse out of notes as trusted Customer Data.
 */
const { v4: uuidv4 } = require('uuid');

const DEFAULT_SEED_MAX_ASC = 3; // subject + parents

function ancestorRow(jobId, a) {
  const asc = a.asc;
  return {
    research_job_id: jobId,
    fs_person_id: '',
    name: a.name || [a.given, a.surname].filter(Boolean).join(' '),
    gender: asc === 1 ? 'Unknown' : (asc % 2 === 0 ? 'Male' : 'Female'),
    birth_date: a.birthDate || (a.birthYear ? String(a.birthYear) : ''),
    birth_place: a.birthPlace || '',
    death_date: a.living ? '' : (a.deathDate || (a.deathYear ? String(a.deathYear) : '')),
    death_place: a.living ? '' : (a.deathPlace || ''),
    ascendancy_number: asc,
    generation: Math.floor(Math.log2(asc)),
    confidence: 'customer_data',
    sources: [],
    raw_data: { origin: 'gedcom_upload' },
    confidence_score: 100,
    confidence_level: 'Customer Data',
    evidence_chain: [],
    search_log: [],
    conflicts: [],
    verification_notes: 'Customer-provided data (from uploaded family tree)',
    accepted: 1,
  };
}

/**
 * @param db            the database service
 * @param opts.ancestors  output of gedcom-import.extractAncestors()
 * @param opts.intake     output of gedcom-import.toIntake(ancestors, { seedMaxAsc })
 * @returns {{ jobId, seeded, leads }}
 */
function createJobFromUploadedTree(db, { customer_name, customer_email, generations, ancestors, intake, seedMaxAsc = DEFAULT_SEED_MAX_ASC, meta = {} }) {
  if (!ancestors || !ancestors.length || ancestors[0].asc !== 1) {
    throw new Error('Uploaded tree has no usable subject');
  }
  const jobId = uuidv4();
  const input = {
    given_name: intake.given_name,
    surname: intake.surname,
    birth_date: intake.birth_date,
    birth_place: intake.birth_place,
    death_date: intake.death_date || '',
    death_place: intake.death_place || '',
    father_name: seedMaxAsc >= 2 ? intake.father_name : '',
    mother_name: seedMaxAsc >= 3 ? intake.mother_name : '',
    notes: '',                       // see header: never seed deeper ancestors via notes
    gedcom_leads: intake.leads || {},
    _source: 'gedcom_upload',
    ...meta,
  };

  db.createResearchJob({
    id: jobId,
    customer_name,
    customer_email: customer_email || '',
    generations: parseInt(generations, 10) || 6,
    input_data: input,
  });

  let seeded = 0;
  for (const a of ancestors) {
    if (a.asc > seedMaxAsc) continue;
    db.addAncestor(ancestorRow(jobId, a));
    seeded++;
  }
  return { jobId, seeded, leads: Object.keys(input.gedcom_leads).length };
}

module.exports = { createJobFromUploadedTree, ancestorRow, DEFAULT_SEED_MAX_ASC };
