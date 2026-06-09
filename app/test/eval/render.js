/**
 * Render a scenario's engine output to the real customer fan-chart PDF.
 *   node app/test/eval/render.js <scenario> <outfile.pdf>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-render-'));
process.env.NODE_ENV = 'test';

const db = require('../../src/services/database');
const { ResearchEngine } = require('../../src/services/research-engine');
const { buildMockSources } = require('./mock-sources');
const { seedJob } = require('./harness-lib');
const { generateFanChartPdf } = require('../../src/services/pdf-generator');
const { RULES } = require('../../src/rules/genealogy-rules');

const scenarioName = process.argv[2] || 'ahlfors-hunt';
const outFile = process.argv[3] || `/tmp/${scenarioName}.pdf`;
const scenario = require(`./scenarios/${scenarioName}`);

(async () => {
  db.initialize();
  const jobId = 'render-1';
  const gens = scenario.generations || 4;
  seedJob(db, jobId, scenario.input, gens);
  const sources = buildMockSources(scenario.dataset, scenario.opts || {});
  await new ResearchEngine(db, jobId, scenario.input, gens, sources).run();

  const ancestors = db.getAncestors(jobId)
    .filter(a => a.confidence_score >= RULES.export.minConfidencePercent || a.confidence_level === 'Customer Data')
    .map(a => ({
      ascendancy_number: a.ascendancy_number,
      name: a.name, birth_date: a.birth_date, birth_place: a.birth_place,
      death_date: a.death_date, death_place: a.death_place,
    }));

  const pdfBytes = await generateFanChartPdf(ancestors, scenario.input.customer_name, gens);
  fs.writeFileSync(outFile, Buffer.from(pdfBytes));
  console.log(`wrote ${outFile} (${ancestors.length} ancestors, ${(pdfBytes.length/1024).toFixed(0)} KB)`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
