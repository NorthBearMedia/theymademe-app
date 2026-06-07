/**
 * Shared harness helpers — used by both the offline (mock) runner and the
 * live (real FamilySearch) runner so they measure accuracy identically.
 */
const { parseNotesForAnchors, parseNameParts } = require('../../src/services/research-engine');

// Seed a research job + customer-data ancestors exactly like the real
// routes/research.js POST /admin/research/start handler.
function seedJob(db, jobId, input, generations) {
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

// Compare discovered ancestors to ground truth and print a report.
function reportAccuracy(db, jobId, groundTruth, generations, name) {
  const ancestors = db.getAncestors(jobId);
  const byAsc = {};
  for (const a of ancestors) byAsc[a.ascendancy_number] = a;

  console.log(`\n════════ ACCURACY REPORT — ${name} ════════\n`);
  let correct = 0, wrong = 0, missing = 0, discoverableTotal = 0;
  const wrongRows = [], scoresCorrect = [], scoresWrong = [];
  const rows = [];

  for (const asc of Object.keys(groundTruth).map(Number).sort((a, b) => a - b)) {
    const truth = groundTruth[asc];
    const got = byAsc[asc];
    const isCustomer = asc <= 3;
    let status, detail = '';
    if (!got || !got.name) { status = 'MISSING'; }
    else {
      const nm = nameMatch(got, truth);
      const gy = yr(got.birth_date);
      const ym = !truth.year || !gy || Math.abs(gy - truth.year) <= 2;
      status = (nm && ym) ? 'CORRECT' : 'WRONG';
      detail = `${got.name} b.${got.birth_date || '?'} ${got.birth_place || '?'} [${got.confidence_level} ${got.confidence_score}]`;
      if (status === 'WRONG') detail += `  (nameMatch=${nm} yearMatch=${ym})`;
    }
    rows.push(`  #${String(asc).padStart(2)} ${status.padEnd(8)} want ${truth.given} ${truth.surname} b.${truth.year} → ${detail}`);
    if (!isCustomer) {
      discoverableTotal++;
      if (status === 'CORRECT') { correct++; if (got) scoresCorrect.push(got.confidence_score); }
      else if (status === 'WRONG') { wrong++; wrongRows.push({ asc, got, truth }); if (got) scoresWrong.push(got.confidence_score); }
      else missing++;
    }
  }
  console.log(rows.join('\n'));

  const filled = correct + wrong;
  const precision = filled ? Math.round(100 * correct / filled) : 0;
  const recall = discoverableTotal ? Math.round(100 * correct / discoverableTotal) : 0;
  const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

  console.log(`\n──────── METRICS (discovered slots #4-#${Math.pow(2, generations + 1) - 1}) ────────`);
  console.log(`  Discoverable slots : ${discoverableTotal}`);
  console.log(`  Correct            : ${correct}`);
  console.log(`  Wrong (false match): ${wrong}`);
  console.log(`  Missing (not found): ${missing}`);
  console.log(`  Precision          : ${precision}%  (correct / filled)`);
  console.log(`  Recall             : ${recall}%  (correct / discoverable)`);
  console.log(`  Avg confidence — correct: ${avg(scoresCorrect)}  | wrong: ${avg(scoresWrong)}`);
  if (wrong) {
    console.log(`\n  ⚠ FALSE MATCHES (engine confidently wrong = worst failure):`);
    for (const w of wrongRows) console.log(`     #${w.asc}: got "${w.got.name}" (${w.got.birth_place}) — should be ${w.truth.given} ${w.truth.surname}`);
  }
  const result = { discoverable: discoverableTotal, correct, wrong, missing, precision, recall };
  console.log(`\nRESULT ${JSON.stringify(result)}`);
  return result;
}

module.exports = { seedJob, reportAccuracy };
