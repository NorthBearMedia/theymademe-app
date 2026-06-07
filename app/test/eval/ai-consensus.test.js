/**
 * Offline unit test for the AI reviewer's confidence-adjustment consensus logic
 * (ai-reviewer.applyAICorrections). No API keys / network needed.
 *
 *   node app/test/eval/ai-consensus.test.js
 *
 * Asserts the asymmetric auto-apply policy:
 *   - skeptical DOWNGRADES auto-apply when both models agree (capped at -40)
 *   - only tiny, tightly-agreed UPGRADES auto-apply; larger ones are suggested
 *   - disagreement / loose agreement → suggested, never auto-applied
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-ai-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';

const db = require('../../src/services/database');
const ai = require('../../src/services/ai-reviewer');

let pass = 0, fail = 0;
function check(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); }

// Each case: an ancestor slot + the two models' confidence_adjustment, and what we expect.
const cases = [
  { asc: 4, start: 80, gpt: -35, claude: -30, expect: 'auto', expectScore: 48 },  // agree big downgrade → avg -32
  { asc: 5, start: 80, gpt: -50, claude: -50, expect: 'auto', expectScore: 40 },  // agree huge downgrade → capped -40
  { asc: 6, start: 70, gpt: 4, claude: 4, expect: 'auto', expectScore: 74 },      // tiny agreed upgrade → +4
  { asc: 7, start: 70, gpt: 10, claude: 8, expect: 'suggest', expectScore: 70 },  // large upgrade → suggest, no change
  { asc: 8, start: 80, gpt: -20, claude: 10, expect: 'suggest', expectScore: 80 },// opposite directions → suggest
  { asc: 9, start: 80, gpt: -30, claude: -10, expect: 'suggest', expectScore: 80 },// downgrade but loose (diff 20) → suggest
];

(async () => {
  db.initialize();
  const jobId = 'ai-test';
  db.createResearchJob({ id: jobId, customer_name: 'AI Test', customer_email: '', generations: 3, input_data: {} });
  for (const c of cases) {
    db.addAncestor({ research_job_id: jobId, fs_person_id: 'X', name: `Person ${c.asc}`, gender: 'Male',
      ascendancy_number: c.asc, generation: 2, confidence: 'probable',
      confidence_score: c.start, confidence_level: 'Probable', accepted: 0 });
  }

  const mk = (which) => ({ ancestor_reviews: cases.map(c => ({ asc: c.asc, confidence_adjustment: c[which], flags: [] })) });
  const { corrections, suggestions } = ai.applyAICorrections(jobId, mk('gpt'), mk('claude'));

  console.log('\nAI consensus logic:');
  for (const c of cases) {
    const anc = db.getAncestorByAscNumber(jobId, c.asc);
    const wasAuto = corrections.some(x => x.asc === c.asc);
    const wasSuggest = suggestions.some(x => x.asc === c.asc);
    check(`#${c.asc} gpt=${c.gpt} claude=${c.claude} → ${c.expect}`,
      (c.expect === 'auto' ? wasAuto : wasSuggest));
    check(`#${c.asc} score = ${c.expectScore}`, anc.confidence_score === c.expectScore);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('CRASH:', err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(2); });
