/**
 * Sex-specific parent–child age-gap rules (the flagship v2 accuracy rule).
 *
 *   node app/test/eval/age-gap.test.js
 *
 * Female fertility ends ~50, so a "mother" >50 years older than her child is
 * almost always a wrong link (often a grandmother). A father at the same gap is
 * unusual but biologically possible. This asserts scoreLocationDate enforces
 * that asymmetry from the master rulebook.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-gap-'));
process.env.NODE_ENV = 'test';

const { ResearchEngine } = require('../../src/services/research-engine');
const { RULES } = require('../../src/rules/genealogy-rules');

const D = 'Derby, Derbyshire, England';
const engine = new ResearchEngine({ getRejectedFsIds: () => [] }, 'gap', {}, 3, []);

// child = subject's father, asc#2, born 1931
const scored = new Map([[2, { name: 'Norman Hunt', birthDate: '1931', birthPlace: D }]]);
// score a candidate parent at a given asc (4 = father slot, 5 = mother slot)
const scoreParent = (asc, parentBirthYear) =>
  engine.scoreLocationDate(asc, { birth_date: String(parentBirthYear), birth_place: D }, scored, null, null);

let pass = 0, fail = 0;
function check(name, cond, extra) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); }

// MOTHER slot (#5): gap 56 (>50) must be rejected; gap 26 must score well.
const momTooOld = scoreParent(5, 1875);   // gap 56
const momOk = scoreParent(5, 1905);       // gap 26
// FATHER slot (#4): gap 56 is unusual-but-allowed; gap 66 (>60) must be rejected.
const dadOld = scoreParent(4, 1875);      // gap 56
const dadTooOld = scoreParent(4, 1865);   // gap 66

console.log('\nSex-specific age gap:');
check('mother gap 56 (>50) is rejected', momTooOld.notes.some(n => n.includes('REJECT') && n.includes('mother')), `pts=${momTooOld.points}`);
check('mother gap 26 scores plausible + sweet spot', momOk.notes.some(n => n.includes('sweet spot')) && momOk.points > 0, `pts=${momOk.points}`);
check('father gap 56 is allowed (unusual, not rejected)', dadOld.notes.some(n => n.includes('unusual')) && !dadOld.notes.some(n => n.includes('REJECT')), `pts=${dadOld.points}`);
check('father gap 66 (>60) is rejected', dadTooOld.notes.some(n => n.includes('REJECT') && n.includes('father')), `pts=${dadTooOld.points}`);
check('rulebook is v2 with sex-specific bounds', RULES.ageGap.mother.hardMax === 50 && RULES.ageGap.father.hardMax === 60);

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
