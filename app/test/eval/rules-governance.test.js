/**
 * Governance / integrity test for the master rulebook.
 *
 *   node app/test/eval/rules-governance.test.js
 *
 * Asserts:
 *  1. The rulebook is deep-frozen — the running system cannot mutate it.
 *  2. The engine's confidence levels track the rulebook cutoffs (no drift).
 *  3. The AI reviewer's prompt actually embeds the rulebook (version + text).
 *  4. The narrative is generated FROM the values (can't state a different number).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-gov-'));
process.env.NODE_ENV = 'test';

const rulesMod = require('../../src/rules/genealogy-rules');
const { RULES, RULES_HASH, RULES_TEXT, RULES_VERSION } = rulesMod;
const { ResearchEngine } = require('../../src/services/research-engine');
const { SYSTEM_PROMPT } = require('../../src/services/ai-reviewer');

let pass = 0, fail = 0;
function check(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); }

// 1. Deep-frozen — mutation attempts are no-ops.
const before = RULES.ageGap.hardMinYears;
try { RULES.ageGap.hardMinYears = 999; } catch (e) { /* strict mode throws — also fine */ }
try { RULES.confidence.levelCutoffs.verified = 1; } catch (e) {}
check('RULES is deep-frozen (top level)', Object.isFrozen(RULES));
check('RULES is deep-frozen (nested objects)', Object.isFrozen(RULES.ageGap) && Object.isFrozen(RULES.confidence.levelCutoffs));
check('rule value unchanged after mutation attempt', RULES.ageGap.hardMinYears === before);

// 2. Engine confidence levels track the rulebook cutoffs (drift guard).
const stubDb = { getRejectedFsIds: () => [] };
const engine = new ResearchEngine(stubDb, 'gov', {}, 2, []);
const L = RULES.confidence.levelCutoffs;
check('getConfidenceLevel(verified cutoff) = Verified', engine.getConfidenceLevel(L.verified) === 'Verified');
check('getConfidenceLevel(just below verified) = Probable', engine.getConfidenceLevel(L.verified - 1) === 'Probable');
check('getConfidenceLevel(probable cutoff) = Probable', engine.getConfidenceLevel(L.probable) === 'Probable');
check('getConfidenceLevel(possible cutoff) = Possible', engine.getConfidenceLevel(L.possible) === 'Possible');
check('getConfidenceLevel(below suggested) = Not Found', engine.getConfidenceLevel(L.suggested - 1) === 'Not Found');

// 2b. The unified minimum-primary-sources ladder tracks the rulebook.
const S = RULES.sources;
check('ladder: shallow gen + common surname = base+surcharge',
  engine.minPrimarySourcesFor(2, 1900, 'smith', false, false) === S.minPrimaryShallowGen + S.commonSurnameExtraPrimary);
check('ladder: deep gen + common surname = deep base+surcharge',
  engine.minPrimarySourcesFor(4, 1900, 'smith', false, false) === S.minPrimaryDeepGen + S.commonSurnameExtraPrimary);
check('ladder: very deep gen drops the common-surname surcharge',
  engine.minPrimarySourcesFor(5, 1900, 'smith', false, false) === S.minPrimaryDeepGen);
check('ladder: pre-civil-registration needs none',
  engine.minPrimarySourcesFor(2, 1800, 'smith', false, false) === 0);
check('ladder: distant county raises the floor',
  engine.minPrimarySourcesFor(2, 1900, 'wood', true, true) === S.distantLocationMinPrimary);

// 3. AI prompt embeds the rulebook.
check('AI system prompt embeds the rulebook text', SYSTEM_PROMPT.includes(RULES_TEXT));
check('AI system prompt references the rulebook version+hash', SYSTEM_PROMPT.includes(`v${RULES_VERSION}`) && SYSTEM_PROMPT.includes(RULES_HASH));

// 4. Narrative is generated from values (states the real numbers).
check('narrative states the real mother fertility ceiling', RULES_TEXT.includes(String(RULES.ageGap.mother.hardMax)));
check('narrative states the real father gap ceiling', RULES_TEXT.includes(String(RULES.ageGap.father.hardMax)));
check('narrative states the real unsourced-era cap', RULES_TEXT.includes(String(RULES.gates.unsourcedCivilEraMaxPercent)));

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
