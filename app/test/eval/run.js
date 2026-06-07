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
const { ResearchEngine } = require('../../src/services/research-engine');
const { buildMockSources } = require('./mock-sources');
const { seedJob, reportAccuracy } = require('./harness-lib');

const scenarioName = process.argv[2] || 'hunt-derby';
const scenario = require(`./scenarios/${scenarioName}`);

(async () => {
  db.initialize();
  const jobId = 'eval-1';
  const gens = scenario.generations || 3;
  seedJob(db, jobId, scenario.input, gens);

  const sources = buildMockSources(scenario.dataset, scenario.opts || {});
  const engine = new ResearchEngine(db, jobId, scenario.input, gens, sources);
  await engine.run();

  reportAccuracy(db, jobId, scenario.groundTruth, gens, scenario.name);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(err => { console.error('EVAL CRASH:', err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(2); });
