/**
 * FamilySearch adapter additions — offline (fake fetch, fixture payloads).
 *
 *   node app/test/eval/fs-adapter.test.js
 *
 * Covers: the refactored Atom parser (regression guard for searchPerson),
 * Read-Ancestry parsing, the pedigree cache + fallback in FamilySearchSource,
 * records search, and record-hint summarisation.
 *
 * NOTE: payload shapes follow FamilySearch's GEDCOM X / Atom conventions as used
 * by the engine's existing code. The records-search PATH and matches payloads are
 * UNVERIFIED against the live API — this proves our parsing, not the endpoint.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-fsad-'));
process.env.NODE_ENV = 'test';

const db = require('../../src/services/database');
const config = require('../../src/config');
db.initialize();
// Authenticated token so apiRequest() doesn't try the network for one
db.setSetting('fs_access_token', 'test-token');
db.setSetting('fs_token_obtained_at', new Date().toISOString());
db.setSetting('fs_token_scope', 'authenticated');

const fsApi = require('../../src/services/familysearch-api');
const { FamilySearchSource } = require('../../src/services/familysearch-source');

let pass = 0, fail = 0;
function check(name, cond, extra) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); }

// ── fixtures ──────────────────────────────────────────────────────────
const person = (id, name, gender, birthDate, birthPlace, asc) => ({
  id, display: { name, gender, birthDate, birthPlace, ...(asc ? { ascendancyNumber: String(asc) } : {}) },
});
const pedigree = (rootId, n) => ({
  persons: Array.from({ length: n }, (_, i) => {
    const asc = i + 1;
    return person(asc === 1 ? rootId : `${rootId}_a${asc}`, `Person ${asc}`, asc % 2 === 0 ? 'Male' : 'Female', String(1990 - asc * 5), 'Derby, Derbyshire, England', asc);
  }),
});
const treeSearch = { entries: [{ score: 3.2, content: { gedcomx: {
  persons: [
    person('C1', 'Norman Hunt', 'Male', '1931', 'Derby, Derbyshire, England'),
    person('F1', 'Frederick Hunt', 'Male', '1902', 'Derby, Derbyshire, England'),
    person('M1', 'Joy Rose', 'Female', '1904', 'Derby, Derbyshire, England'),
  ],
  relationships: [
    { type: 'http://gedcomx.org/ParentChild', person1: { resourceId: 'F1' }, person2: { resourceId: 'C1' } },
    { type: 'http://gedcomx.org/ParentChild', person1: { resourceId: 'M1' }, person2: { resourceId: 'C1' } },
  ],
} } }] };
const recordEntry = (title) => ({ title, score: 2.1, content: { gedcomx: {
  persons: [person('R1', 'Frederick Hunt', 'Male', '1902', 'Derby')],
  sourceDescriptions: [{ titles: [{ value: title }] }],
} } });

// ── fake fetch ────────────────────────────────────────────────────────
let calls = [];
let lastAccept = {};
let ancestryMode = 'ok';
global.fetch = async (url, opts) => {
  calls.push(String(url));
  lastAccept[String(url).split('?')[0]] = (opts && opts.headers && opts.headers.Accept) || '';
  const u = String(url);
  const json = (obj, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.includes('/platform/tree/ancestry')) {
    if (ancestryMode === 'fail') return json({ error: 'boom' }, 500);
    if (ancestryMode === '401') return json({ error: 'unauthorized' }, 401);
    const root = new URL(u).searchParams.get('person');
    return json(pedigree(root, 15));
  }
  if (u.includes('/parents')) return json({ persons: [], childAndParentsRelationships: [] });
  if (u.includes('/matches')) return json({ entries: [recordEntry('England and Wales Census, 1911'), recordEntry('England and Wales Birth Registration Index, 1837-2008')] });
  if (u.includes(config.FS_RECORDS_SEARCH_PATH)) return json({ entries: [recordEntry('England and Wales Census, 1911')] });
  if (u.includes('/platform/tree/search')) return json(treeSearch);
  return json({}, 404);
};

(async () => {
  console.log('\nAtom parser (refactor regression guard):');
  const found = await fsApi.searchPerson({ givenName: 'Norman', surname: 'Hunt', birthDate: '1931' });
  check('searchPerson still maps candidate', found.length === 1 && found[0].name === 'Norman Hunt');
  check('searchPerson still extracts father/mother', found[0].fatherName === 'Frederick Hunt' && found[0].motherName === 'Joy Rose');
  check('parentData populated', found[0].parentData.father?.id === 'F1' && found[0].parentData.mother?.birthDate === '1904');
  check('FS relevance score preserved', found[0].score === 3.2);

  console.log('\nRead Ancestry:');
  const anc = await fsApi.getAncestry('ROOT', 4);
  check('request uses ancestry endpoint with generations', calls.some(c => c.includes('/platform/tree/ancestry?person=ROOT&generations=4')));
  check('15 persons parsed', anc.length === 15);
  check('ascendancy numbers + generations', anc[0].ascendancy_number === 1 && anc[0].generation === 0 && anc[14].ascendancy_number === 15 && anc[14].generation === 3);
  check('display dates/places mapped', anc[1].birthPlace === 'Derby, Derbyshire, England' && anc[1].gender === 'Male');

  console.log('\nPedigree cache in FamilySearchSource:');
  config.FS_USE_PEDIGREE = false;
  let src = new FamilySearchSource();
  calls = [];
  await src.getParents('ROOT');
  check('flag OFF: uses per-person /parents (no ancestry call)', calls.some(c => c.includes('/parents')) && !calls.some(c => c.includes('/ancestry')));

  config.FS_USE_PEDIGREE = true;
  src = new FamilySearchSource();
  calls = [];
  const p1 = await src.getParents('ROOT');
  check('flag ON: father/mother from asc 2/3', p1.father?.name === 'Person 2' && p1.mother?.name === 'Person 3');
  const p2 = await src.getParents('ROOT_a2');   // asc 2 — inside the cached range
  const p4 = await src.getParents('ROOT_a4');   // asc 4 — inside the cached range
  check('grandparents answered from cache (asc 2→4/5, 4→8/9)', p2.father?.name === 'Person 4' && p2.mother?.name === 'Person 5' && p4.father?.name === 'Person 8');
  check('ONE network call served 3 lookups', calls.filter(c => c.includes('/ancestry')).length === 1 && !calls.some(c => c.includes('/parents')));
  calls = [];
  await src.getParents('ROOT_a8');              // asc 8 — outermost gen: needs a fresh pedigree rooted there
  check('outermost generation triggers a new pedigree (leapfrog)', calls.some(c => c.includes('person=ROOT_a8')));

  console.log('\nPedigree failure → permanent per-person fallback:');
  ancestryMode = 'fail';
  src = new FamilySearchSource();
  calls = [];
  await src.getParents('X1');
  await src.getParents('X2');
  check('falls back to /parents after pedigree error', calls.filter(c => c.includes('/parents')).length === 2);
  check('does not retry the failing pedigree endpoint', calls.filter(c => c.includes('/ancestry')).length === 1);
  ancestryMode = 'ok';
  config.FS_USE_PEDIGREE = false;

  console.log('\nLive-test regressions (found against the real beta API):');
  ancestryMode = '401';
  let msg = '';
  try { await fsApi.getAncestry('ROOT', 4); } catch (e) { msg = e.message; }
  check('ancestry 401 = "needs authenticated token", NOT "token expired"', /authenticated token/.test(msg) && !/expired/.test(msg), msg.slice(0, 60));
  check('ancestry 401 does NOT clear the stored FamilySearch token', db.getSetting('fs_access_token') === 'test-token');
  config.FS_USE_PEDIGREE = true;
  const srcA = new FamilySearchSource();
  const pa = await srcA.getParents('X9');
  check('pedigree 401 falls back safely and the token survives', !!pa && db.getSetting('fs_access_token') === 'test-token');
  config.FS_USE_PEDIGREE = false; ancestryMode = 'ok';

  console.log('\nRecords search + hints:');
  calls = [];
  const recs = await new FamilySearchSource().searchRecords({ givenName: 'Frederick', surname: 'Hunt', birthDate: '1902', recordCountry: 'England' });
  const recCall = calls.find(c => c.includes(config.FS_RECORDS_SEARCH_PATH)) || '';
  check('records search hits the configured path', !!recCall);
  check('record query uses q.* vocabulary + country filter', /q\.givenName=Frederick/.test(recCall) && /q\.birthLikeDate=1902/.test(recCall) && /q\.recordCountry=England/.test(recCall));
  check('records search asks for the Atom media type (live API answers 406 otherwise)', /atom/.test(lastAccept[Object.keys(lastAccept).find(k => k.includes(config.FS_RECORDS_SEARCH_PATH))] || ''));
  check('default records path is the one that exists on the live API', config.FS_RECORDS_SEARCH_PATH === '/platform/records/personas');
  check('records parsed', recs.length === 1 && recs[0].entryTitle === 'England and Wales Census, 1911');
  const hints = await new FamilySearchSource().getRecordHints('F1');
  check('hint titles summarised for internal classification', hints.length === 2 && hints[0].title === 'England and Wales Census, 1911');

  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('CRASH:', err); process.exit(2); });
