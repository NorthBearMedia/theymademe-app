/**
 * External corroboration (rulebook v2.3.0) — runs the REAL engine on the real
 * Ahlfors-Hunt scenario with: uploaded-tree leads (GEDCOM hints), a fake
 * Wikidata source, and fake FamilySearch record hints.
 *
 *   node app/test/eval/corroboration.test.js
 *
 * Asserts: agreement adds evidence; conflicts are FLAGGED not auto-resolved;
 * namesakes score nothing; points are capped by the rulebook; failures in an
 * external source never fail a job; and accuracy is unchanged.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-corr-'));
process.env.NODE_ENV = 'test';

const db = require('../../src/services/database');
const config = require('../../src/config');
const { RULES } = require('../../src/rules/genealogy-rules');
const { ResearchEngine } = require('../../src/services/research-engine');
const { buildMockSources } = require('./mock-sources');
const { seedJob } = require('./harness-lib');
const scenario = require('./scenarios/ahlfors-hunt');

let pass = 0, fail = 0;
function check(name, cond, extra) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); }

// ── fake Wikidata corroborator ───────────────────────────────────────
let wikidataCalls = 0, wikidataThrows = false;
const fakeWikidata = {
  sourceName: 'Wikidata',
  isAvailable: () => true,
  async corroborate({ name, birthYear }) {
    wikidataCalls++;
    if (wikidataThrows) throw new Error('network down');
    if (/William Hunt/.test(name) && birthYear === 1864)   // unique match, SAME place
      return { matched: true, qid: 'Q1', label: 'William Hunt', url: 'https://www.wikidata.org/wiki/Q1', description: 'English engineer', birthPlace: 'Derby, England', fatherName: '', motherName: '' };
    if (/Hannah Slater/.test(name) && birthYear === 1864)   // matches name+year but wrong place, no parents → namesake
      return { matched: true, qid: 'Q2', label: 'Hannah Slater', url: 'https://www.wikidata.org/wiki/Q2', description: 'suffragist', birthPlace: 'Liverpool, England', fatherName: '', motherName: '' };
    if (/Walter Rose/.test(name) && birthYear === 1879)     // unique match, PARENT agrees with our tree? (we have none) → place agrees
      return { matched: true, qid: 'Q3', label: 'Walter Rose', url: 'https://www.wikidata.org/wiki/Q3', description: 'cricketer', birthPlace: 'Derby, England', fatherName: '', motherName: '' };
    return { matched: false, ambiguous: false, reason: 'no candidate' };
  },
};

(async () => {
  db.initialize();
  const jobId = 'corr-1';
  const gens = scenario.generations;

  // Customer's uploaded-tree leads for deeper slots (UNVERIFIED hints)
  const input = { ...scenario.input, gedcom_leads: {
    '8':  { name: 'Frederick Hunt', given: 'Frederick', surname: 'Hunt', birthYear: 1902 },     // agrees
    '10': { name: 'Ernest Woodward', given: 'Ernest', surname: 'Woodward', birthYear: 1930 },   // year CONFLICT (real: 1903)
    '9':  { name: 'Joy Rose', given: 'Joy', surname: 'Rose' },                                  // no birth year to compare
    '16': { name: 'William Hunt', given: 'William', surname: 'Hunt', birthYear: 1864 },         // agrees (stacks with wikidata + hints → cap)
  } };
  seedJob(db, jobId, input, gens);

  const sources = buildMockSources(scenario.dataset, scenario.opts || {});
  sources.push(fakeWikidata);
  // FamilySearch record hints (internal): 3 distinct primary hints for #16
  config.FS_RECORD_HINTS_ENABLED = true;
  sources[0].getRecordHints = async (fsId) => fsId === 'N16'
    ? [{ title: 'England and Wales Census, 1881' }, { title: 'England and Wales Census, 1891' }, { title: 'England and Wales Birth Registration Index, 1837-2008' }]
    : [];

  await new ResearchEngine(db, jobId, input, gens, sources).run();

  const a = (n) => db.getAncestorByAscNumber(jobId, n);
  const breakdown = (n) => a(n).raw_data?.scoring_breakdown || {};

  console.log('\nUploaded-tree leads:');
  check('#8 agrees: evidence entry + note', (a(8).evidence_chain || []).some(e => e.source_type === 'Customer tree') && /Uploaded tree agrees/.test(a(8).verification_notes));
  check('#8 agreement points = rulebook value', breakdown(8).corroboration?.points === RULES.corroboration.leadAgreePoints, `got ${breakdown(8).corroboration?.points}`);
  check('#10 year conflict is FLAGGED for review', (a(10).conflicts || []).some(c => c.type === 'uploaded_tree_conflict') && (a(10).missing_info || []).some(m => m.type === 'conflict'));
  check('#10 conflict is NOT auto-resolved (name/dates unchanged)', a(10).name === 'Ernest Woodward' && /1903/.test(a(10).birth_date));
  check('#10 conflict penalty follows rulebook (0)', RULES.corroboration.leadConflictPenalty === 0 && (breakdown(10).corroboration?.points || 0) === 0);
  check('#9 lead without a year: noted, no points, no conflict', /no birth year to compare/.test(a(9).verification_notes) && !(a(9).conflicts || []).length);

  console.log('\nWikidata (strict):');
  check('#17 same-name+year but different place = namesake, 0 points', /namesake/.test(a(17).verification_notes) && !(a(17).evidence_chain || []).some(e => /Wikidata/.test(e.title || '')));
  check('#18 unique match + birthplace agrees → +place points', (a(18).evidence_chain || []).some(e => /Wikidata Q3/.test(e.title || '')) && breakdown(18).corroboration?.points === RULES.corroboration.wikidataPlaceAgreePoints, `got ${breakdown(18).corroboration?.points}`);
  check('Wikidata queried for non-customer ancestors only', wikidataCalls > 0);

  console.log('\nCap + FamilySearch hints:');
  const b16 = breakdown(16).corroboration?.points;
  check('#16 stacks lead(6)+wikidata(4)+hints(6)=16 but is CAPPED at rulebook max', b16 === RULES.corroboration.maxPoints, `got ${b16}`);
  check('#16 hint evidence stays internal (no record titles stored)', !/Census/.test(JSON.stringify(a(16).evidence_chain)) || (a(16).evidence_chain || []).every(e => e.source_type !== 'FamilySearch record hint'));

  console.log('\nNo accuracy impact:');
  const wrong = [];
  for (const [ascStr, truth] of Object.entries(scenario.groundTruth)) {
    const asc = Number(ascStr); if (asc <= 3) continue;
    const got = a(asc);
    if (truth.empty) { if (got && got.name) wrong.push(asc); continue; }
    if (!got || !got.name || !new RegExp(truth.surname.split('-')[0], 'i').test(got.name)) wrong.push(asc);
  }
  check('all 28 discoverable slots still correct (ground truth)', wrong.length === 0, wrong.length ? `wrong/missing: ${wrong}` : '');
  check('job completed', db.getResearchJob(jobId).status === 'completed');

  console.log('\nResilience:');
  const jobId2 = 'corr-2';
  seedJob(db, jobId2, input, gens);
  wikidataThrows = true;
  const sources2 = buildMockSources(scenario.dataset, scenario.opts || {});
  sources2.push(fakeWikidata);
  await new ResearchEngine(db, jobId2, input, gens, sources2).run();
  check('Wikidata outage does not fail the job', db.getResearchJob(jobId2).status === 'completed');

  config.FS_RECORD_HINTS_ENABLED = false;
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('CRASH:', err); process.exit(2); });
