/**
 * Confidence-calibration test.
 *
 *   node app/test/eval/confidence-gating.test.js
 *
 * A 20th-century ancestor discovered from the FamilySearch tree but with NO
 * attached source records (civil/census/parish) should NOT be presented as
 * "Verified" — per the engine's own rule that tree data is a LEAD, not proof.
 * An otherwise-identical ancestor that DOES have source records should stay
 * "Verified". This guards against confidently-wrong output.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-gate-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';

const db = require('../../src/services/database');
const { ResearchEngine } = require('../../src/services/research-engine');
const { buildMockSources } = require('./mock-sources');
const { seedJob } = require('./harness-lib');

const D = 'Derby, Derbyshire, England';
function person(id, name, gender, byear, fatherId, motherId, sources) {
  return {
    id, name, gender, birthDate: String(byear), birthPlace: D,
    deathDate: String(byear + 68), deathPlace: D, fatherId, motherId, spouseIds: [],
    sources: sources, // [] = no documentary records
    facts: {
      birth: [{ type: 'Birth', date: String(byear), place: D }],
      census: [{ type: 'Census', date: '1911', place: D }],
      death: [{ type: 'Death', date: String(byear + 68), place: D }],
      marriage: [], residence: [], baptism: [], burial: [], other: [],
    },
  };
}
const twoSources = [
  { title: 'England and Wales Birth Registration Index', url: '', citation: 'x' },
  { title: '1911 England Census', url: '', citation: 'x' },
];

const dataset = [
  person('FS_JOHN', 'John Hunt', 'Male', 1960, 'FS_NORMAN', 'FS_MARY', twoSources),
  person('FS_NORMAN', 'Norman Hunt', 'Male', 1931, 'FS_FRED', 'FS_EDITH', twoSources),
  person('FS_MARY', 'Mary Smith', 'Female', 1933, 'FS_ALBERT', 'FS_FLO', twoSources),
  person('FS_FRED', 'Frederick Hunt', 'Male', 1903, null, null, []),        // #4 NO sources
  person('FS_EDITH', 'Edith Brown', 'Female', 1906, null, null, []),        // #5 NO sources
  person('FS_ALBERT', 'Albert Smith', 'Male', 1905, null, null, twoSources),// #6 has sources
  person('FS_FLO', 'Florence Green', 'Female', 1908, null, null, twoSources),// #7 has sources
];

const input = {
  customer_name: 'Gating Test', given_name: 'John', surname: 'Hunt',
  birth_date: '1960', birth_place: D, father_name: 'Norman Hunt', mother_name: 'Mary Smith',
  notes: 'Father: Norman Hunt (1931-1998); Mother: Mary Smith (1933-2005)',
};

let pass = 0, fail = 0;
function check(name, cond, extra) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); }

(async () => {
  db.initialize();
  const jobId = 'gate-1';
  seedJob(db, jobId, input, 2);
  const sources = buildMockSources(dataset, {});
  await new ResearchEngine(db, jobId, input, 2, sources).run();

  const a4 = db.getAncestorByAscNumber(jobId, 4); // unsourced
  const a6 = db.getAncestorByAscNumber(jobId, 6); // sourced
  console.log('\nConfidence calibration:');
  console.log(`  #4 ${a4.name} (no sources): ${a4.confidence_level} ${a4.confidence_score}`);
  console.log(`  #6 ${a6.name} (2 sources):  ${a6.confidence_level} ${a6.confidence_score}`);
  check('#4 unsourced post-1837 ancestor is NOT Verified', a4.confidence_score < 75, `(got ${a4.confidence_score})`);
  check('#6 sourced ancestor stays Verified', a6.confidence_score >= 90, `(got ${a6.confidence_score})`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('CRASH:', err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(2); });
