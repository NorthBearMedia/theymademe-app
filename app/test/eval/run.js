/**
 * Offline accuracy harness.
 *
 *   node app/test/eval/run.js [scenario]      (default: hunt-derby)
 *
 * Seeds a research job exactly like routes/research.js, runs the REAL engine
 * against mock FamilySearch/FreeBMD sources, then scores the discovered
 * ancestors against the scenario's ground truth.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-eval-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';

const db = require('../../src/services/database');
const { ResearchEngine, parseNotesForAnchors, parseNameParts } = require('../../src/services/research-engine');
const { buildMockSources } = require('./mock-sources');

const scenarioName = process.argv[2] || 'hunt-derby';
const scenario = require(`./scenarios/${scenarioName}`);

// ── Seed a job exactly like routes/research.js POST /start ──────────
function seedJob(jobId, input, generations) {
  db.createResearchJob({ id: jobId, customer_name: input.customer_name || 'Eval',
    customer_email: '', generations, input_data: input });
  const cd = (o) => ({ confidence: 'customer_data', confidence_score: 100,
    confidence_level: 'Customer Data', accepted: 1, verification_notes: 'Customer-provided data', ...o });
  const anchors = parseNotesForAnchors(input.notes || '');
  db.addAncestor(cd({ research_job_id: jobId, fs_person_id: '', name: `${input.given_name} ${input.surname}`,
    gender: 'Unknown', birth_date: input.birth_date || '', birth_place: input.birth_place || '',
    death_date: input.death_date || '', death_place: input.death_place || '', ascendancy_number: 1, generation: 0 }));
  if (input.father_name) db.addAncestor(cd({ research_job_id: jobId, fs_person_id: '', name: input.father_name,
    gender: 'Male', birth_date: anchors[2]?.birthDate || '', birth_place: anchors[2]?.birthPlace || input.birth_place || '',
    death_date: anchors[2]?.deathDate || '', death_place: anchors[2]?.deathPlace || '', ascendancy_number: 2, generation: 1 }));
  if (input.mother_name) db.addAncestor(cd({ research_job_id: jobId, fs_person_id: '', name: input.mother_name,
    gender: 'Female', birth_date: anchors[3]?.birthDate || '', birth_place: anchors[3]?.birthPlace || input.birth_place || '',
    death_date: anchors[3]?.deathDate || '', death_place: anchors[3]?.deathPlace || '', ascendancy_number: 3, generation: 1 }));
  for (const ascNum of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
    const a = anchors[ascNum];
    if (a && a.givenName) {
      db.addAncestor(cd({ research_job_id: jobId, fs_person_id: '', name: `${a.givenName} ${a.surname || ''}`.trim(),
        gender: ascNum % 2 === 0 ? 'Male' : 'Female', birth_date: a.birthDate || '', birth_place: a.birthPlace || '',
        death_date: a.deathDate || '', death_place: a.deathPlace || '', ascendancy_number: ascNum,
        generation: Math.floor(Math.log2(ascNum)) }));
    }
  }
}

// ── Scoring ────────────────────────────────────────────────────────
function yr(s) { const m = String(s || '').match(/\b(\d{4})\b/); return m ? parseInt(m[1], 10) : null; }
function countyOf(place) {
  const parts = String(place || '').split(',').map(s => s.trim()).filter(Boolean);
  return (parts[1] || parts[0] || '').toLowerCase();
}
function nameMatch(got, truth) {
  const np = parseNameParts(got.name || '');
  const g = (np.givenName || '').toLowerCase().split(/\s+/)[0];
  const s = (np.surname || '').toLowerCase();
  return g === truth.given.toLowerCase() && s === truth.surname.toLowerCase();
}

(async () => {
  db.initialize();
  const jobId = 'eval-1';
  const gens = scenario.generations || 3;
  seedJob(jobId, scenario.input, gens);

  const sources = buildMockSources(scenario.dataset, scenario.opts || {});
  const engine = new ResearchEngine(db, jobId, scenario.input, gens, sources);
  await engine.run();

  const ancestors = db.getAncestors(jobId);
  const byAsc = {};
  for (const a of ancestors) byAsc[a.ascendancy_number] = a;

  console.log(`\n════════ ACCURACY REPORT — ${scenario.name} ════════\n`);
  let correct = 0, wrong = 0, missing = 0, discoveredTotal = 0;
  const wrongRows = [], scoresCorrect = [], scoresWrong = [];

  const rows = [];
  for (const asc of Object.keys(scenario.groundTruth).map(Number).sort((a, b) => a - b)) {
    const truth = scenario.groundTruth[asc];
    const got = byAsc[asc];
    const isCustomer = asc <= 3;
    let status, detail = '';
    if (!got || !got.name) { status = 'MISSING'; }
    else {
      const nm = nameMatch(got, truth);
      const gy = yr(got.birth_date);
      const ym = !truth.year || !gy || Math.abs(gy - truth.year) <= 2;
      const cm = countyOf(got.birth_place).includes(truth.county.toLowerCase()) || !got.birth_place;
      status = (nm && ym) ? 'CORRECT' : 'WRONG';
      detail = `${got.name} b.${got.birth_date || '?'} ${got.birth_place || '?'} [${got.confidence_level} ${got.confidence_score}]`;
      if (status === 'WRONG') detail += `  (nameMatch=${nm} yearMatch=${ym} countyMatch=${cm})`;
    }
    rows.push(`  #${String(asc).padStart(2)} ${status.padEnd(8)} want ${truth.given} ${truth.surname} b.${truth.year} → ${detail}`);

    if (!isCustomer) {
      discoveredTotal++;
      if (status === 'CORRECT') { correct++; if (got) scoresCorrect.push(got.confidence_score); }
      else if (status === 'WRONG') { wrong++; wrongRows.push({ asc, got, truth }); if (got) scoresWrong.push(got.confidence_score); }
      else missing++;
    }
  }
  console.log(rows.join('\n'));

  const filled = correct + wrong;
  const precision = filled ? (100 * correct / filled) : 0;
  const recall = discoveredTotal ? (100 * correct / discoveredTotal) : 0;
  const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

  console.log(`\n──────── METRICS (discovered slots #4-#${Math.pow(2, gens + 1) - 1}) ────────`);
  console.log(`  Discoverable slots : ${discoveredTotal}`);
  console.log(`  Correct            : ${correct}`);
  console.log(`  Wrong (false match): ${wrong}`);
  console.log(`  Missing (not found): ${missing}`);
  console.log(`  Precision          : ${precision.toFixed(0)}%  (correct / filled)`);
  console.log(`  Recall             : ${recall.toFixed(0)}%  (correct / discoverable)`);
  console.log(`  Avg confidence — correct: ${avg(scoresCorrect)}  | wrong: ${avg(scoresWrong)}`);
  if (wrong) {
    console.log(`\n  ⚠ FALSE MATCHES (engine confidently wrong = worst failure):`);
    for (const w of wrongRows) console.log(`     #${w.asc}: got "${w.got.name}" (${w.got.birth_place}) — should be ${w.truth.given} ${w.truth.surname} of Derbyshire`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  // Machine-readable line for diffing across runs
  console.log(`\nRESULT ${JSON.stringify({ scenario: scenarioName, discoverable: discoveredTotal, correct, wrong, missing, precision: Math.round(precision), recall: Math.round(recall) })}`);
})().catch(err => { console.error('EVAL CRASH:', err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(2); });
