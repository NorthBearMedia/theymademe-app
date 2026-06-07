/**
 * LIVE accuracy harness — runs the REAL engine against the REAL FamilySearch
 * (and FreeBMD) APIs and scores the result against your known family tree.
 * This is the true real-world accuracy benchmark.
 *
 *   FS_ACCESS_TOKEN=<authenticated token> \
 *   FS_CLIENT_ID=<your client id> \
 *   [OPENAI_API_KEY=… ANTHROPIC_API_KEY=…] \
 *   node app/test/eval/run-live.js path/to/my-family.json
 *
 * The JSON file:  { "generations": N, "input": {...}, "groundTruth": {...} }
 *   - Put in input.notes ONLY what a real customer would know (subject + parents,
 *     maybe grandparents). Everything you DON'T feed it, the engine must DISCOVER.
 *   - Put the FULL correct tree in groundTruth (the answer key). Slots #4+ are
 *     scored as "discovered".
 *
 * Get an authenticated FS_ACCESS_TOKEN by logging in via the app's
 * /admin/familysearch/connect flow and copying the stored token, or from the
 * FamilySearch developer console. A plain unauthenticated token only allows
 * search (no tree traversal), so discovery will be limited.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.argv[2]) { console.error('Usage: node run-live.js path/to/my-family.json'); process.exit(1); }
const familyPath = path.resolve(process.argv[2]);
const family = JSON.parse(fs.readFileSync(familyPath, 'utf-8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-live-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const db = require('../../src/services/database');
const { ResearchEngine } = require('../../src/services/research-engine');
const { buildSourceRegistry } = require('../../src/services/source-registry');
const { seedJob, reportAccuracy } = require('./harness-lib');

(async () => {
  db.initialize();

  // Inject the FamilySearch token (if provided) so tree traversal works.
  if (process.env.FS_ACCESS_TOKEN) {
    db.setSetting('fs_access_token', process.env.FS_ACCESS_TOKEN);
    db.setSetting('fs_token_type', 'bearer');
    db.setSetting('fs_token_obtained_at', new Date().toISOString());
    db.setSetting('fs_token_scope', 'authenticated');
    console.log('[live] FamilySearch token injected (authenticated scope).');
  } else {
    console.log('[live] No FS_ACCESS_TOKEN — engine will try an unauthenticated session (search only, limited discovery).');
  }

  const gens = family.generations || 4;
  const jobId = 'live-1';
  seedJob(db, jobId, family.input, gens);

  const sources = buildSourceRegistry();
  console.log(`[live] Sources: ${sources.map(s => s.sourceName).join(', ')}`);

  const engine = new ResearchEngine(db, jobId, family.input, gens, sources);
  await engine.run();

  reportAccuracy(db, jobId, family.groundTruth, gens, family.input.customer_name || 'Live run');
  console.log(`\n(DB kept at ${tmp} for inspection; delete when done.)`);
})().catch(err => { console.error('LIVE CRASH:', err); process.exit(2); });
