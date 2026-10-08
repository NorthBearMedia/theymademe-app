/**
 * GEDCOM import — end to end: parser → trust policy → admin upload flow.
 *
 *   node app/test/eval/gedcom-flow.test.js
 *
 * Boots the REAL server, logs in, uploads a real fixture, picks the subject,
 * creates the job, and verifies what landed in the database. Also checks the
 * security edges (auth, path traversal, expired upload, non-GEDCOM, oversize).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-gedflow-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
const FIX = path.join(__dirname, 'fixtures');
const PORT = 3793;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, extra) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); }

(async () => {
  // ── Part A: parser + trust policy against a temp DB ─────────────────
  console.log('\nTrust policy (module level):');
  const db = require('../../src/services/database');
  db.initialize();
  const g = require('../../src/services/gedcom-import');
  const { createJobFromUploadedTree } = require('../../src/services/job-seeding');
  const text = fs.readFileSync(path.join(FIX, 'ancestry-hargreaves.ged'), 'utf8');
  const parsed = g.parseGedcom(text);
  const root = g.suggestRoots(parsed, 5)[0];
  const anc = g.extractAncestors(parsed, root.id, 4);

  const intake3 = g.toIntake(anc, { seedMaxAsc: 3 });
  const r3 = createJobFromUploadedTree(db, { customer_name: 'T', generations: 4, ancestors: anc, intake: intake3, seedMaxAsc: 3 });
  const rows3 = db.getAncestors(r3.jobId);
  const job3 = db.getResearchJob(r3.jobId);
  check('default policy seeds ONLY subject + parents', rows3.length === 3 && rows3.every(a => a.ascendancy_number <= 3));
  check('seeded rows are trusted Customer Data', rows3.every(a => a.confidence_level === 'Customer Data' && a.confidence_score === 100));
  check('deeper ancestors stored only as hints (all asc > 3)', Object.keys(job3.input_data.gedcom_leads).length > 10 && Object.keys(job3.input_data.gedcom_leads).every(k => Number(k) > 3));
  check('notes left empty (engine cannot re-promote hints)', job3.input_data.notes === '');
  check('genders follow ahnentafel parity', rows3.find(a => a.ascendancy_number === 2).gender === 'Male' && rows3.find(a => a.ascendancy_number === 3).gender === 'Female');
  check('hint entries carry name/year for cross-checking', (() => { const l = job3.input_data.gedcom_leads['4']; return !!l && !!l.name && !!l.surname && Number.isInteger(l.birthYear); })());

  const intake7 = g.toIntake(anc, { seedMaxAsc: 7 });
  const r7 = createJobFromUploadedTree(db, { customer_name: 'T', generations: 4, ancestors: anc, intake: intake7, seedMaxAsc: 7 });
  check('"grandparents" option seeds up to asc 7, hints start at 8', db.getAncestors(r7.jobId).length === 7 && Object.keys(db.getResearchJob(r7.jobId).input_data.gedcom_leads).every(k => Number(k) >= 8));
  let threw = false;
  try { createJobFromUploadedTree(db, { customer_name: 'x', generations: 4, ancestors: [], intake: {} }); } catch (e) { threw = true; }
  check('refuses an upload with no usable subject', threw);

  // ── Part B: the admin web flow against the real server ──────────────
  console.log('\nAdmin upload flow (real server):');
  const server = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), NODE_ENV: 'test', ADMIN_PASSWORD: 'pw', INTAKE_SECRET: 's' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await new Promise(r => setTimeout(r, 300)); try { up = (await fetch(`${BASE}/api/health`)).ok; } catch (e) {} }
  if (!up) { console.error('server failed to boot\n' + log); server.kill(); process.exit(2); }

  try {
    const unauth = await fetch(`${BASE}/admin/research/import`, { redirect: 'manual' });
    check('unauthenticated import page redirects to login', unauth.status === 302);

    const login = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'pw' }) });
    const cookie = (login.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
    check('admin login yields a session', !!cookie);
    const H = { Cookie: cookie };

    const page = await fetch(`${BASE}/admin/research/import`, { headers: H });
    check('import form renders', page.status === 200 && /Upload &amp; preview/.test(await page.text()));

    const upload = async (name, content) => {
      const fd = new FormData(); fd.append('gedcom', new Blob([content]), name);
      return fetch(`${BASE}/admin/research/import`, { method: 'POST', headers: H, body: fd });
    };

    const good = await upload('hargreaves.ged', text);
    const html = await good.text();
    check('valid GEDCOM → subject-choice preview', good.status === 200 && /Choose the subject/.test(html) && /Thomas James Hargreaves/.test(html));
    const uploadId = (html.match(/name="upload_id" value="([0-9a-f-]{36})"/) || [])[1];
    const rootXref = (html.match(/name="root_xref" value="([^"]+)"/) || [])[1];
    check('preview carries an upload id + a suggested subject', !!uploadId && !!rootXref);
    check('upload held in a temp file (not the session)', fs.existsSync(path.join(tmp, 'uploads', `${uploadId}.ged`)));

    const bad = await upload('notes.ged', 'this is just a text file, not a family tree');
    check('non-GEDCOM rejected with a clear message', bad.status === 400 && /Could not read that file/.test(await bad.text()));
    const big = await upload('big.ged', Buffer.alloc(16 * 1024 * 1024, 'x'));
    check('oversize (>15MB) rejected', big.status === 400);

    const traversal = await fetch(`${BASE}/admin/research/import/confirm`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ upload_id: '../../etc/passwd', root_xref: rootXref, customer_name: 'x' }) });
    check('path-traversal upload id rejected (400)', traversal.status === 400);

    const confirm = await fetch(`${BASE}/admin/research/import/confirm`, { method: 'POST', redirect: 'manual', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ upload_id: uploadId, root_xref: rootXref, customer_name: 'Thomas Hargreaves', customer_email: 't@example.com', generations: '5', trust: 'parents' }) });
    const loc = confirm.headers.get('location') || '';
    check('confirm creates the job and redirects to it', confirm.status === 302 && /\/admin\/research\/[0-9a-f-]{36}$/.test(loc), loc);
    check('temp upload deleted after use', !fs.existsSync(path.join(tmp, 'uploads', `${uploadId}.ged`)));

    const jobId = loc.split('/').pop();
    const Database = require('better-sqlite3');
    const conn = new Database(path.join(tmp, 'theymademe.sqlite'), { readonly: true });
    const job = conn.prepare('SELECT * FROM research_jobs WHERE id = ?').get(jobId);
    const inp = job ? JSON.parse(job.input_data) : {};
    const rows = job ? conn.prepare('SELECT ascendancy_number, name, confidence_level FROM ancestors WHERE research_job_id = ? ORDER BY ascendancy_number').all(jobId) : [];
    conn.close();
    check('job stored with the chosen generations + customer email', !!job && job.generations === 5 && job.customer_email === 't@example.com');
    check('only subject + parents seeded as Customer Data', rows.length === 3 && rows.every(r => r.confidence_level === 'Customer Data'), rows.map(r => `#${r.ascendancy_number} ${r.name}`).join(' | '));
    check('job records its origin', inp._source === 'gedcom_upload' && inp.gedcom_leads && Object.keys(inp.gedcom_leads).length > 0);

    const replay = await fetch(`${BASE}/admin/research/import/confirm`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ upload_id: uploadId, root_xref: rootXref, customer_name: 'x' }) });
    check('replaying a used upload id → 410 expired', replay.status === 410);
  } finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('CRASH:', err); process.exit(2); });
