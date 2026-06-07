/**
 * Smoke test — proves the real ResearchEngine runs end-to-end OFFLINE
 * (no FamilySearch token, no AI keys, no network) against empty mock sources.
 *
 * Run:  node app/test/eval/smoke.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the DB at a throwaway temp dir BEFORE requiring config/database.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-smoke-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';

const db = require('../../src/services/database');
const fsApi = require('../../src/services/familysearch-api');
const { ResearchEngine, parseNotesForAnchors } = require('../../src/services/research-engine');

// ── Empty mock sources (no discovery) ──────────────────────────────
const emptyFsSource = {
  sourceName: 'FamilySearch',
  isAvailable: () => true,
  hasTreeAccess: () => true,
  async searchPerson() { return []; },
  async getParents() { return { father: null, mother: null }; },
  async getPersonSources() { return []; },
  async getSpouses() { return []; },
  async getPersonDetails() { return null; },
};
// extractFactsByType is called directly on the api module — patch it.
fsApi.extractFactsByType = async () => ({
  census: [], birth: [], marriage: [], death: [], residence: [], baptism: [], burial: [], other: [],
});

(async () => {
  db.initialize();
  const jobId = 'smoke-1';
  const input = {
    given_name: 'John', surname: 'Hunt',
    birth_date: '1960', birth_place: 'Derby, Derbyshire, England',
    father_name: 'Norman Hunt', mother_name: 'Mary Smith',
    notes: '',
  };
  db.createResearchJob({ id: jobId, customer_name: 'Smoke Test', customer_email: '', generations: 3, input_data: input });

  // Seed subject + parents as customer data (mirrors routes/research.js)
  db.addAncestor({ research_job_id: jobId, fs_person_id: '', name: 'John Hunt', gender: 'Unknown',
    birth_date: '1960', birth_place: 'Derby, Derbyshire, England', death_date: '', death_place: '',
    ascendancy_number: 1, generation: 0, confidence: 'customer_data', confidence_score: 100,
    confidence_level: 'Customer Data', accepted: 1, verification_notes: 'Customer-provided data' });
  db.addAncestor({ research_job_id: jobId, fs_person_id: '', name: 'Norman Hunt', gender: 'Male',
    birth_date: '1931', birth_place: 'Derby, Derbyshire, England', death_date: '', death_place: '',
    ascendancy_number: 2, generation: 1, confidence: 'customer_data', confidence_score: 100,
    confidence_level: 'Customer Data', accepted: 1, verification_notes: 'Customer-provided data' });
  db.addAncestor({ research_job_id: jobId, fs_person_id: '', name: 'Mary Smith', gender: 'Female',
    birth_date: '1935', birth_place: 'Derby, Derbyshire, England', death_date: '', death_place: '',
    ascendancy_number: 3, generation: 1, confidence: 'customer_data', confidence_score: 100,
    confidence_level: 'Customer Data', accepted: 1, verification_notes: 'Customer-provided data' });

  const engine = new ResearchEngine(db, jobId, input, 3, [emptyFsSource]);
  await engine.run();

  const job = db.getResearchJob(jobId);
  const ancestors = db.getAncestors(jobId);
  console.log('\n──────── SMOKE RESULT ────────');
  console.log('job.status =', job.status, '| error =', job.error_message || 'none');
  console.log('ancestors  =', ancestors.length);
  for (const a of ancestors) {
    console.log(`  asc#${a.ascendancy_number} ${a.name} [${a.confidence_level} ${a.confidence_score}]`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nSmoke test', job.status === 'completed' ? 'PASSED ✅' : 'FAILED ❌');
  process.exit(job.status === 'completed' ? 0 : 1);
})().catch(err => { console.error('SMOKE CRASH:', err); process.exit(2); });
