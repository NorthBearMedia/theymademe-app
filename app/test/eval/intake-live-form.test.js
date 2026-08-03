/**
 * End-to-end intake test: boots the REAL server, POSTs a faithful replica of
 * an actual live JotForm submission (multipart/form-data, real field names,
 * messy customer dates), and asserts a correctly-populated research job.
 *
 *   node app/test/eval/intake-live-form.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-intake-'));
const PORT = 3791;
const TOKEN = 'test-intake-secret';

// The rawRequest payload replicates the REAL submission from form 260414001149039
// (field names and answer shapes taken verbatim from the live JotForm API).
const rawRequest = {
  q3_fullname1: { first: 'Norton', middle: 'Gregory', last: 'Ahlfors-Hunt' },
  q5_textbox3: 'Derby, Derbyshire',
  q6_dropdown4: 'Male',
  yourDate: '23/08/89',                       // 2-digit year!
  q8_fullname6: { first: 'Lance', middle: 'Alan', last: 'Hunt' },
  fathersDate: '01.09.59',                    // dots + 2-digit year
  q10_textbox8: 'Derby',
  q12_fullname10: { first: 'Jane', middle: 'Elizabeth', last: 'Ahlfors' },
  mothersDate: '20.4.64',                     // single-digit month
  q15_textbox13: 'Ripley',
  q17_fullname15: { first: 'Norman', middle: '', last: 'Hunt' },
  paternalGrandfathers: '01.01.1931',
  q19_textbox17: 'Derby',
  q20_fullname18: { first: 'Janet', middle: 'Mary', last: 'Woodward' },
  paternalGrandmothers: 'August 1935',        // month-name format
  q23_textbox21: 'Burton',
  q25_fullname23: { first: 'Carl', middle: 'William Leslie', last: 'Ahlfors' },
  maternalGrandfathers: 'July 1936',
  q27_textbox25: 'Westminster, London',
  q28_fullname26: { first: 'Alma', middle: 'May', last: 'Jelley' },
  maternalGrandmothers: '11.1.40',
  q31_textbox29: 'Shardlow, Derbyshire',
  q32_textarea30: 'Family were railway workers in Derby.',
  q33_email31: 'hunty1989@hotmail.com',
  q34_phone32: { full: '' },
  whichPackage: '6 Generations — £149 (up to 62 ancestors, 5–7 days)',
};

let pass = 0, fail = 0;
function check(name, cond, extra) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); }

(async () => {
  // Boot the real server
  const server = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), NODE_ENV: 'test', INTAKE_SECRET: TOKEN, ADMIN_PASSWORD: 'x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  // Wait for health
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await new Promise(r => setTimeout(r, 300));
    try { up = (await fetch(`http://localhost:${PORT}/api/health`)).ok; } catch (e) {}
  }
  if (!up) { console.error('Server failed to boot:\n' + serverLog); server.kill(); process.exit(2); }

  try {
    // POST the webhook as multipart/form-data, exactly like JotForm does
    const form = new FormData();
    form.append('formID', '260414001149039');
    form.append('submissionID', 'test-submission-1');
    form.append('rawRequest', JSON.stringify(rawRequest));

    const resp = await fetch(`http://localhost:${PORT}/api/form-submission?token=${TOKEN}`, {
      method: 'POST', body: form,
    });
    const body = await resp.json().catch(() => ({}));
    check('webhook accepted (HTTP 2xx)', resp.ok, `status=${resp.status} ${JSON.stringify(body).slice(0, 120)}`);

    // Wrong-token rejection
    const bad = await fetch(`http://localhost:${PORT}/api/form-submission?token=WRONG`, { method: 'POST', body: (() => { const f = new FormData(); f.append('rawRequest', '{}'); return f; })() });
    check('wrong token rejected (401)', bad.status === 401);

    // Inspect the created job via the token API
    const jobs = await (await fetch(`http://localhost:${PORT}/api/intake/jobs?token=${TOKEN}`)).json();
    const list = jobs.jobs || jobs || [];
    check('exactly one job created', Array.isArray(list) && list.length === 1, `got ${Array.isArray(list) ? list.length : typeof list}`);

    // Read the DB directly for full detail
    process.env.DATA_DIR = tmp;
    const Database = require('better-sqlite3');
    const conn = new Database(path.join(tmp, 'theymademe.sqlite'));
    const job = conn.prepare('SELECT * FROM research_jobs').get();
    const input = JSON.parse(job.input_data);
    const ancestors = conn.prepare('SELECT * FROM ancestors ORDER BY ascendancy_number').all();
    const byAsc = Object.fromEntries(ancestors.map(a => [a.ascendancy_number, a]));

    console.log('\nJob mapping:');
    check('customer email captured', job.customer_email === 'hunty1989@hotmail.com', job.customer_email);
    check('customer name from form', /Norton Gregory Ahlfors-Hunt/.test(job.customer_name), job.customer_name);
    check('generations = 6 from package choice', job.generations === 6, `got ${job.generations}`);
    check('subject given name', input.given_name === 'Norton Gregory', input.given_name);
    check('subject surname', input.surname === 'Ahlfors-Hunt', input.surname);
    check('subject birth date year expanded (89 → 1989)', /1989/.test(input.birth_date), input.birth_date);
    check('father name mapped', input.father_name === 'Lance Alan Hunt', input.father_name);
    check('mother maiden name mapped', input.mother_name === 'Jane Elizabeth Ahlfors', input.mother_name);
    check('subject ancestor (asc#1) seeded', !!byAsc[1] && /Norton/.test(byAsc[1].name));
    check('father (asc#2) seeded with 1959 date', !!byAsc[2] && /1959/.test(byAsc[2].birth_date || ''), byAsc[2] && byAsc[2].birth_date);
    check('mother (asc#3) seeded with 1964 date', !!byAsc[3] && /1964/.test(byAsc[3].birth_date || ''), byAsc[3] && byAsc[3].birth_date);
    check('paternal grandfather (asc#4) seeded', !!byAsc[4] && /Norman Hunt/.test(byAsc[4].name), byAsc[4] && byAsc[4].name);
    check('paternal grandmother (asc#5) = Janet Mary Woodward', !!byAsc[5] && /Woodward/.test(byAsc[5].name), byAsc[5] && byAsc[5].name);
    check('maternal grandfather (asc#6) = Carl Ahlfors', !!byAsc[6] && /Ahlfors/.test(byAsc[6].name), byAsc[6] && byAsc[6].name);
    check('maternal grandmother (asc#7) = Alma May Jelley', !!byAsc[7] && /Jelley/.test(byAsc[7].name), byAsc[7] && byAsc[7].name);
    check('grandparent date "August 1935" preserved in notes/anchors', /1935/.test(input.notes || '') || (byAsc[5] && /1935/.test(byAsc[5].birth_date || '')), (byAsc[5] && byAsc[5].birth_date) || '');
    check('customer notes captured', /railway/.test(input.notes || ''), (input.notes || '').slice(0, 80));
    check('job status pending (awaits admin approval)', job.status === 'pending', job.status);
    conn.close();

    // Date normalizer unit checks (via a fresh require of the api module's logic is
    // not exported; test through observed effects above + spot checks here)
    console.log('\nDate normalization observed: 23/08/89→' + input.birth_date + ', 01.09.59→' + (byAsc[2] ? byAsc[2].birth_date : '?') + ', 20.4.64→' + (byAsc[3] ? byAsc[3].birth_date : '?'));
  } finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('CRASH:', err); process.exit(2); });
