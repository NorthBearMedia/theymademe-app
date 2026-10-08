/**
 * Identity-linking rules (rulebook v2.4.0) — reproduces the failure found on the
 * FIRST LIVE RUN against FamilySearch:
 *
 *   customer typed  "Janet Mary Woodward, b. August 1935, Burton"
 *   engine linked   "Mary Jane Woodward, b. 21 Apr 1939, Liverpool"   ← WRONG PERSON
 *
 * because a match on the MIDDLE name counted as a first-name match. The candidate
 * list below is what FamilySearch actually returned for that search.
 *
 *   node app/test/eval/linking.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-link-'));
process.env.NODE_ENV = 'test';

const db = require('../../src/services/database');
const { ResearchEngine } = require('../../src/services/research-engine');
const { buildMockSources } = require('./mock-sources');
const { seedJob } = require('./harness-lib');
const { RULES } = require('../../src/rules/genealogy-rules');

let pass = 0, fail = 0;
function check(name, cond, extra) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); }

// FamilySearch-shaped candidate (as returned by searchPerson)
const cand = (id, name, birthDate, birthPlace, score = 4) => ({
  id, name, gender: 'Female', birthDate, birthPlace, deathDate: '', deathPlace: '', score,
  fatherName: '', motherName: '', parentData: { father: null, mother: null },
  facts: [], names: [], display: { name, birthDate, birthPlace }, raw: { id },
});

// ── what the live search for "Janet Mary Woodward b.1935 Burton" really returned ──
const LIVE = [
  cand('KJ2W-L8B', 'Mary Jane Woodward', '', ''),
  cand('LTNK-18Q', 'Mary Jean Woodward', '4 June 1914', 'Seattle, King, Washington, United States'),
  cand('MVQ7-9MP', 'Mary Ann Jane Woodward', '8 August 1797', ''),
  cand('MVQ7-9SQ', 'Mary Jane Woodward', '', ''),
  cand('LCCY-T88', 'Mary Jane Woodward', 'about 1840', 'Saint Helier, Jersey'),
  cand('PQD7-YQ1', 'Mary Jean Woodward', '1937', 'Oklahoma, United States'),
  cand('GXC1-YLM', 'Janet Marie Woodward', '1932', ''),                       // right first name, wrong year, NO place
  cand('G8KJ-X56', 'Mary Jean Woodward', '7 January 1932', 'California, United States'),
  cand('G11T-G2Q', 'Mary Jane Woodward', '21 April 1939', 'Liverpool North, Lancashire, England, United Kingdom'), // the wrong link that won
];
const TRUE_PERSON = cand('TRUE-JMW', 'Janet Mary Woodward', '21 August 1935', 'Burton upon Trent, Staffordshire, England, United Kingdom', 3);

const baseInput = {
  customer_name: 'Link Test', given_name: 'Norton Gregory', surname: 'Ahlfors-Hunt',
  birth_date: '23 August 1989', birth_place: 'Derby, Derbyshire, England',
  father_name: 'Lance Alan Hunt', mother_name: 'Jane Elizabeth Ahlfors', notes: '',
};

async function run(jobId, janetBirth, candidates) {
  const input = { ...baseInput, seed_ancestors: [
    { asc: 5, name: 'Janet Mary Woodward', birth_date: janetBirth, birth_place: 'Burton' } ] };
  seedJob(db, jobId, input, 3);
  const sources = buildMockSources([], {});
  sources[0].searchPerson = async (q) => /janet/i.test(q.givenName || '') ? candidates : [];
  await new ResearchEngine(db, jobId, input, 3, sources).run();
  return db.getAncestorByAscNumber(jobId, 5);
}

(async () => {
  db.initialize();
  const eng = new ResearchEngine({ getRejectedFsIds: () => [] }, 'unit', {}, 3, []);

  console.log('\nfirstGivenMatches (unit):');
  check('exact', eng.firstGivenMatches('Janet', 'Janet'));
  check('middle name only is NOT a match (the live bug)', !eng.firstGivenMatches('Mary', 'Janet Mary'));
  check('...and the reverse', !eng.firstGivenMatches('Janet Mary', 'Mary'));
  check('first name matches even if middle names differ', eng.firstGivenMatches('Janet Marie', 'Janet Mary'));
  check('diminutive (Bill ↔ William)', eng.firstGivenMatches('Bill', 'William') && eng.firstGivenMatches('William', 'Bill'));
  check('spelling variant (Jan ↔ Janet)', eng.firstGivenMatches('Jan', 'Janet'));
  check('initial', eng.firstGivenMatches('J', 'Janet') && eng.firstGivenMatches('Janet', 'J.'));
  check('substring alone is not enough (Ann vs Joann)', !eng.firstGivenMatches('Ann', 'Joann'));
  check('empty never matches', !eng.firstGivenMatches('', 'Janet') && !eng.firstGivenMatches('Janet', ''));

  console.log('\nThe live failure (the real FamilySearch candidate list):');
  const wrong = await run('link-1', 'August 1935', LIVE);
  check('NO link is made to a wrong person', !wrong.fs_person_id, `linked to: ${wrong.fs_person_id || '(none)'}`);
  check('customer data is untouched', wrong.name === 'Janet Mary Woodward' && wrong.confidence_level === 'Customer Data');
  check('no ancestors invented behind an unlinked person', !db.getAncestorByAscNumber('link-1', 10) && !db.getAncestorByAscNumber('link-1', 11));

  console.log('\nControls (legitimate matches still link):');
  const right = await run('link-2', 'August 1935', [...LIVE, TRUE_PERSON]);
  check('the TRUE person is chosen over every decoy', right.fs_person_id === 'TRUE-JMW', `linked to: ${right.fs_person_id}`);

  console.log('\nPrecise vs approximate dates:');
  const near = cand('NEAR-JMW', 'Janet Mary Woodward', '1938', 'Burton upon Trent, Staffordshire, England, United Kingdom', 3);
  const precise = await run('link-3', 'August 1935', [near]);      // customer typed month+year → ±2
  check('precise date ("August 1935") rejects a candidate 3 years out', !precise.fs_person_id);
  const approx = await run('link-4', '1935', [near]);               // bare year → normal tolerance
  check('bare year ("1935") still allows ±5 (candidate 3 years out)', approx.fs_person_id === 'NEAR-JMW', `linked to: ${approx.fs_person_id}`);

  console.log('\nRulebook:');
  check('rules are in the rulebook and frozen', RULES.linking.requireFirstGivenNameMatch === true && RULES.linking.preciseDateYearTolerance === 2 && Object.isFrozen(RULES.linking));

  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('CRASH:', err); process.exit(2); });
