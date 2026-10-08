/**
 * Offline tests for the Wikidata source adapter.
 *
 *   node app/test/eval/wikidata-source.test.js
 *
 * NO network: every call goes through an injected fake fetch that serves the
 * Action API-shaped JSON in ./fixtures/wikidata/, keyed by URL parameters.
 * The clock and sleep are injected too, so rate limiting / retries run instantly.
 *
 * The fixture people are synthetic. Their QIDs (Q9990000xx) are far beyond the
 * highest real Wikidata item, so they cannot collide with a real person. Places
 * (Q84 London, Q2256 Birmingham, Q23436 Edinburgh) use their real ids.
 *
 * Asserts:
 *  1. Identifying User-Agent, Action API only, maxlag on every call.
 *  2. Throttling via injected sleep; retries on 429 / 5xx / maxlag with capped Retry-After.
 *  3. searchPerson field mapping, human filter, +-2 year filter.
 *  4. Date handling: BCE, coarse precision, somevalue/novalue, ranks, conflicts, missing claims.
 *  5. getParents (P22/P25), adoptive + conflicting parents ignored.
 *  6. corroborate: strict match, ambiguity, near-misses, initials, aliases, diacritics.
 *  7. Failure modes never throw: network errors, timeouts, API errors, disabled via config.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

// The sandbox has no node_modules; config.js only needs dotenv to load a .env file.
try { require.resolve('dotenv'); } catch (e) {
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'dotenv') return { config() { return {}; } };
    return origLoad.call(this, request, ...rest);
  };
}

const config = require('../../src/config');
const { WikidataSource } = require('../../src/services/wikidata-source');
const { ResearchSource, SOURCE_CAPABILITIES } = require('../../src/services/source-interface');

let pass = 0, fail = 0;
function check(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); }
function section(title) { console.log(`\n${title}`); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = arr => arr.slice().sort();

// ─── Fixtures + fake Wikidata ───────────────────────────────────────────────

const FIX = path.join(__dirname, 'fixtures', 'wikidata');
const load = f => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

const normKey = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// wbsearchentities fixtures by (normalised) search string; unknown terms return no results.
const SEARCH_INDEX = {
  'edmund fairweather': 'search-edmund-fairweather.json',
  'edmund fairweathe': 'search-edmund-fairweather.json', // prefix-ish near miss
  'e fairweather': 'search-e-fairweather.json',
  'f fairweather': 'search-f-fairweather.json',
  'agnes moore': 'search-agnes-moore.json',
  'robert quill': 'search-robert-quill.json',
  'john ashdown': 'search-john-ashdown.json',
  'john pennington': 'search-john-pennington.json',
  'zoe marlowe': 'search-zoe-marlowe.json',
};
const ENTITY_FILES = ['entities-fairweather.json', 'entities-quill.json', 'entities-ashdown.json',
  'entities-pennington.json', 'entities-marlowe.json', 'entities-places.json'];
const POOL = {};
for (const f of ENTITY_FILES) Object.assign(POOL, load(f).entities);

function respond(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => (lower[String(k).toLowerCase()] !== undefined ? lower[String(k).toLowerCase()] : null) },
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return JSON.parse(JSON.stringify(body));
    },
    text: async () => JSON.stringify(body),
  };
}

function filterProps(entity, props) {
  const want = new Set(String(props || '').split('|'));
  const out = { type: entity.type, id: entity.id };
  for (const k of ['labels', 'descriptions', 'aliases', 'claims']) if (want.has(k) && entity[k] !== undefined) out[k] = entity[k];
  return out;
}

function route(params) {
  if (params.action === 'wbsearchentities') {
    return load(SEARCH_INDEX[normKey(params.search)] || 'search-no-results.json');
  }
  if (params.action === 'wbgetentities') {
    const ids = String(params.ids || '').split('|').filter(Boolean);
    if (ids.length > 50) return { error: { code: 'too-many-ids', info: 'Too many ids (max 50).' } };
    const entities = {};
    for (const id of ids) entities[id] = POOL[id] ? filterProps(POOL[id], params.props) : { id, missing: '' };
    return { entities, success: 1 };
  }
  return { error: { code: 'unknown_action', info: `Unrecognized value for parameter "action": ${params.action}.` } };
}

/** A fake world: fetch + clock + sleep + call log, with a script of one-off overrides. */
function makeWorld() {
  let t = 1700000000000; // multiple of 1000 so HTTP-date Retry-After is exact
  const w = {
    calls: [],
    sleeps: [],
    script: [],            // queued (call, init) => response|throws, consumed one per fetch
    logs: [],
    now: () => t,
    sleep: async ms => { w.sleeps.push(ms); t += ms; },
    advance: ms => { t += ms; },
    logger: { error: m => w.logs.push(['error', m]), warn: m => w.logs.push(['warn', m]) },
  };
  w.fetchImpl = async (url, init) => {
    const u = new URL(url);
    const call = { url, origin: u.origin + u.pathname, params: Object.fromEntries(u.searchParams), headers: init.headers, at: t, signal: init.signal, method: init.method };
    w.calls.push(call);
    if (w.script.length) return w.script.shift()(call, init);
    return respond(200, route(call.params));
  };
  w.make = (opts = {}) => new WikidataSource({
    fetchImpl: w.fetchImpl, sleep: w.sleep, now: w.now, logger: w.logger, ...opts,
  });
  return w;
}

async function withConfig(overrides, fn) {
  const had = {};
  for (const k of Object.keys(overrides)) had[k] = Object.prototype.hasOwnProperty.call(config, k) ? config[k] : undefined;
  Object.assign(config, overrides);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(had)) { if (v === undefined) delete config[k]; else config[k] = v; }
  }
}

const actions = w => w.calls.map(c => c.params.action);

// ─── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  // Baseline: ignore whatever the environment configured.
  const savedCfg = { e: config.WIKIDATA_ENABLED, c: config.WIKIDATA_CONTACT };
  delete config.WIKIDATA_ENABLED;
  delete config.WIKIDATA_CONTACT;

  // ── 0. Interface ──────────────────────────────────────────────────────────
  section('Interface');
  {
    const s = new WikidataSource();
    check('is a ResearchSource', s instanceof ResearchSource);
    check("sourceName is 'Wikidata'", s.sourceName === 'Wikidata');
    check('capabilities = search + tree + corroboration',
      same(s.capabilities, [SOURCE_CAPABILITIES.SEARCH, SOURCE_CAPABILITIES.TREE_TRAVERSAL, 'corroboration']));
    check('available by default (WIKIDATA_ENABLED unset)', s.isAvailable() === true);
    check("available when WIKIDATA_ENABLED='true'", await withConfig({ WIKIDATA_ENABLED: 'true' }, () => s.isAvailable()) === true);
    check("unavailable when WIKIDATA_ENABLED='false'", await withConfig({ WIKIDATA_ENABLED: 'false' }, () => s.isAvailable()) === false);
    check('defaults: 1100ms interval, 3 retries, 15s timeout, global fetch',
      s.minIntervalMs === 1100 && s.maxRetries === 3 && s.timeoutMs === 15000 && s.fetchImpl === global.fetch);
  }

  // ── 1. Request shape ──────────────────────────────────────────────────────
  section('Request shape: User-Agent, Action API only, maxlag');
  {
    const w = makeWorld();
    const s = w.make();
    await s.searchPerson({ givenName: 'Edmund', surname: 'Fairweather', birthDate: '1902' });
    const ua = w.calls[0].headers['User-Agent'];
    check('User-Agent identifies app, site and contact',
      /^TheyMadeMe\/1\.0 \(https:\/\/theymademe\.co\.uk; info@northbearmedia\.co\.uk\) node-fetch$/.test(ua));
    check('Accept: application/json', w.calls[0].headers['Accept'] === 'application/json');
    check('every call carries the User-Agent', w.calls.every(c => c.headers['User-Agent'] === ua));
    check('every call is a GET to https://www.wikidata.org/w/api.php',
      w.calls.every(c => c.origin === 'https://www.wikidata.org/w/api.php' && c.method === 'GET'));
    check('every call has maxlag=5 and format=json', w.calls.every(c => c.params.maxlag === '5' && c.params.format === 'json'));
    check('only wbsearchentities / wbgetentities are used', actions(w).every(a => a === 'wbsearchentities' || a === 'wbgetentities'));

    const sc = w.calls[0].params;
    check('search params: term, language, uselang, type, limit',
      sc.action === 'wbsearchentities' && sc.search === 'Edmund Fairweather' && sc.language === 'en' &&
      sc.uselang === 'en' && sc.type === 'item' && sc.limit === '20');
    const gc = w.calls[1].params;
    check('getentities params: pipe-joined ids, props, languages',
      gc.action === 'wbgetentities' && gc.ids === 'Q999000001|Q999000060|Q999000061' &&
      gc.props === 'labels|descriptions|aliases|claims' && gc.languages === 'en');

    // Contact comes from config; userAgent option overrides everything.
    const w2 = makeWorld();
    await withConfig({ WIKIDATA_CONTACT: 'ops@example.org' }, () => w2.make().searchPerson({ givenName: 'Nobody', surname: 'Atall' }));
    check('WIKIDATA_CONTACT is used in the User-Agent', /; ops@example\.org\) node-fetch$/.test(w2.calls[0].headers['User-Agent']));
    const w3 = makeWorld();
    await w3.make({ userAgent: 'Custom/9.9 (me@example.org)' }).searchPerson({ givenName: 'Nobody', surname: 'Atall' });
    check('userAgent option overrides the generated one', w3.calls[0].headers['User-Agent'] === 'Custom/9.9 (me@example.org)');

    // Batching: wbgetentities is limited to 50 ids per call.
    const w4 = makeWorld();
    const many = Array.from({ length: 120 }, (_, i) => `Q${900000000 + i}`);
    await w4.make()._getEntities(many);
    check('ids are batched 50 per wbgetentities call', same(w4.calls.map(c => c.params.ids.split('|').length), [50, 50, 20]));
  }

  // ── 2. Rate limiting ──────────────────────────────────────────────────────
  section('Rate limiting (injected sleep / clock)');
  {
    const w = makeWorld();
    const s = w.make();
    await s.getParents('Q999000001'); // 3 sequential calls
    check('3 calls made', w.calls.length === 3);
    check('first call is not delayed, later calls sleep minIntervalMs via injected sleep',
      same(w.sleeps, [1100, 1100]));
    check('request starts are >= 1100ms apart', w.calls.every((c, i) => i === 0 || c.at - w.calls[i - 1].at >= 1100));

    const before = w.sleeps.length;
    w.advance(5000);
    await s.getParents('Q999000023');
    check('no sleep when the interval has already elapsed', w.sleeps.length === before);

    const w2 = makeWorld();
    const s2 = w2.make({ minIntervalMs: 250 });
    await s2.getParents('Q999000001');
    check('minIntervalMs option is honoured', same(w2.sleeps, [250, 250]));

    const w3 = makeWorld();
    const s3 = w3.make();
    await Promise.all([
      s3.searchPerson({ givenName: 'Robert', surname: 'Quill' }),
      s3.searchPerson({ givenName: 'John', surname: 'Ashdown' }),
      s3.getParents('Q999000001'),
    ]);
    check('concurrent callers are serialised and still spaced',
      w3.calls.length >= 6 && w3.calls.every((c, i) => i === 0 || c.at - w3.calls[i - 1].at >= 1100));
  }

  // ── 3. Retries ────────────────────────────────────────────────────────────
  section('Retries: 429 / 5xx / maxlag, Retry-After capped');
  {
    const w = makeWorld();
    w.script.push(() => respond(429, undefined, { 'Retry-After': '2' }));
    const r = await w.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather', birthDate: '1902' });
    check('429 then success: result returned', r.length === 1 && r[0].id === 'Q999000001');
    check('429: slept for Retry-After (2000ms)', w.sleeps.includes(2000));
    check('429: same URL retried', w.calls[0].url === w.calls[1].url && w.calls.length === 4);

    const w2 = makeWorld();
    w2.script.push(() => respond(503, undefined), () => respond(502, undefined));
    const r2 = await w2.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather', birthDate: '1902' });
    check('5xx retried with exponential backoff (1000ms then 2000ms)', r2.length === 1 && w2.sleeps.includes(1000) && w2.sleeps.includes(2000));

    const w3 = makeWorld();
    w3.script.push(() => respond(429, undefined, { 'Retry-After': '3600' }));
    await w3.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather' });
    check('Retry-After is capped (3600s -> 30000ms)', w3.sleeps.includes(30000) && !w3.sleeps.includes(3600000));

    const w4 = makeWorld();
    w4.script.push(() => respond(429, undefined, { 'Retry-After': new Date(w4.now() + 4000).toUTCString() }));
    await w4.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather' });
    check('Retry-After as an HTTP date is honoured', w4.sleeps.includes(4000));

    const w5 = makeWorld();
    for (let i = 0; i < 6; i++) w5.script.push(() => respond(429, undefined, { 'Retry-After': '1' }));
    const r5 = await w5.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather' });
    check('retries exhausted: 1 + maxRetries(3) attempts, then [] (no throw)', r5.length === 0 && w5.calls.length === 4);
    check('retries exhausted: error logged', w5.logs.some(l => l[0] === 'error' && /gave up after 4 attempts/.test(l[1])));

    const w6 = makeWorld();
    for (let i = 0; i < 6; i++) w6.script.push(() => respond(500, undefined));
    await w6.make({ maxRetries: 1 }).searchPerson({ givenName: 'Edmund', surname: 'Fairweather' });
    check('maxRetries option is honoured', w6.calls.length === 2);

    // maxlag: HTTP 200 with an error body and a Retry-After header.
    const w7 = makeWorld();
    w7.script.push(() => respond(200, load('error-maxlag.json'), { 'Retry-After': '3' }));
    const r7 = await w7.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather', birthDate: '1902' });
    check('maxlag error body is retried after Retry-After and then succeeds', r7.length === 1 && w7.sleeps.includes(3000));

    const w8 = makeWorld();
    w8.script.push(() => respond(200, load('error-maxlag.json')));
    await w8.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather' });
    check('maxlag without Retry-After waits a default 5000ms', w8.sleeps.includes(5000));

    const w9 = makeWorld();
    for (let i = 0; i < 6; i++) w9.script.push(() => respond(200, load('error-maxlag.json'), { 'Retry-After': '1' }));
    const c9 = await w9.make().corroborate({ name: 'Edmund Fairweather', birthYear: 1902 });
    check('persistent maxlag: corroborate returns matched:false with a maxlag reason',
      c9.matched === false && /maxlag/.test(c9.reason));

    // Non-retryable failures
    const w10 = makeWorld();
    w10.script.push(() => respond(200, load('error-badvalue.json')));
    const r10 = await w10.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather' });
    check('other API error bodies are not retried; search returns []', r10.length === 0 && w10.calls.length === 1);
    check('other API error is logged with its code', w10.logs.some(l => /no-such-entity/.test(l[1])));

    const w11 = makeWorld();
    w11.script.push(() => respond(403, undefined));
    const r11 = await w11.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather' });
    check('HTTP 403 is not retried', r11.length === 0 && w11.calls.length === 1);

    const w12 = makeWorld();
    w12.script.push(() => respond(200, undefined)); // json() throws
    const r12 = await w12.make().searchPerson({ givenName: 'Edmund', surname: 'Fairweather' });
    check('invalid JSON is not retried and does not throw', r12.length === 0 && w12.calls.length === 1);
  }

  // ── 4. searchPerson ───────────────────────────────────────────────────────
  section('searchPerson: mapping + filters');
  {
    const w = makeWorld();
    const s = w.make();
    const r = await s.searchPerson({ givenName: 'Edmund', surname: 'Fairweather', birthDate: '17 May 1902' });
    check('only the exact-name human is returned (hyphenated surname and disambiguation page dropped)',
      same(r.map(c => c.id), ['Q999000001']));
    const c = r[0] || {};
    check('maps id, name, gender', c.id === 'Q999000001' && c.name === 'Edmund Fairweather' && c.gender === 'Male');
    check('maps birth (day precision) + place', c.birthDate === '17 May 1902' && c.birthPlace === 'London');
    check('maps death + place', c.deathDate === '3 November 1971' && c.deathPlace === 'Edinburgh');
    check('maps father/mother names', c.fatherName === 'Henry Fairweather' && c.motherName === 'Agnes Fairweather');
    check('parentData has ids, names and role genders',
      same(c.parentData, {
        father: { id: 'Q999000002', name: 'Henry Fairweather', gender: 'Male' },
        mother: { id: 'Q999000003', name: 'Agnes Fairweather', gender: 'Female' },
      }));
    check('display block mirrors the flat fields',
      same(c.display, { name: 'Edmund Fairweather', gender: 'Male', birthDate: '17 May 1902', birthPlace: 'London', deathDate: '3 November 1971', deathPlace: 'Edinburgh' }));
    check('description, url and source tags', c.description === 'English civil engineer' &&
      c.url === 'https://www.wikidata.org/wiki/Q999000001' && c.source === 'Wikidata' && c._source === 'Wikidata');
    check('score is a number (Wikidata gives no relevance rank)', typeof c.score === 'number');
    check('exactly 3 calls: search, entities, ONE batched label call', same(actions(w), ['wbsearchentities', 'wbgetentities', 'wbgetentities']));
    check('label call asks for places + parents of survivors in one batch',
      w.calls[2].params.props === 'labels' && same(sorted(w.calls[2].params.ids.split('|')), sorted(['Q84', 'Q23436', 'Q999000002', 'Q999000003'])));

    // Year filter (Quill set: 1902 preferred / 1904 / 1905 + unknowns)
    const q = async (extra) => (await makeWorld().make().searchPerson({ givenName: 'Robert', surname: 'Quill', ...extra })).map(x => x.id);
    check('birthDate 1902: keeps 1902 and 1904, drops 1905 (3 years out) and unknown-year people',
      same(sorted(await q({ birthDate: '1902' })), ['Q999000025', 'Q999000027']));
    check('birthDate 1903: +-2 is inclusive (1905 kept)',
      same(sorted(await q({ birthDate: '1903' })), ['Q999000025', 'Q999000027', 'Q999000028']));
    check('birthDate given as a full date string uses its year', same(sorted(await q({ birthDate: '4 March 1904' })), ['Q999000025', 'Q999000027', 'Q999000028']));
    check('no birthDate: no year filter, but the non-human is still dropped',
      same(sorted(await q({})), ['Q999000020', 'Q999000021', 'Q999000022', 'Q999000023', 'Q999000025', 'Q999000026', 'Q999000027', 'Q999000028']));
    check('count limits the number of candidates', (await q({ count: 2 })).length === 2);

    // Date edge cases, read back with no year filter
    const all = await makeWorld().make().searchPerson({ givenName: 'Robert', surname: 'Quill' });
    const by = id => all.find(x => x.id === id);
    check('decade precision (8) is ignored', by('Q999000020').birthDate === '');
    check('BCE date is ignored', by('Q999000021').birthDate === '');
    check('somevalue birth / novalue death / somevalue place give empty strings, no throw',
      by('Q999000022').birthDate === '' && by('Q999000022').deathDate === '' && by('Q999000022').birthPlace === '');
    check('missing claims: empty dates/places, gender Unknown, no parents',
      by('Q999000023').birthDate === '' && by('Q999000023').gender === 'Unknown' && by('Q999000023').parentData.father === null && by('Q999000023').parentData.mother === null);
    check("rank: 'preferred' beats 'normal'; 'deprecated' ignored", by('Q999000025').birthDate === '17 May 1902');
    check('month precision (10) renders month + year; death place resolved', by('Q999000025').deathDate === 'January 1968' && by('Q999000025').deathPlace === 'Edinburgh');
    check('adoptive father (P1039 qualifier) is ignored; biological father used',
      by('Q999000025').fatherName === 'Alfred Quill' && by('Q999000025').motherName === 'Beatrice Quill');
    check('conflicting birth years at the same rank give no birth date', by('Q999000026').birthDate === '');
    check('conflicting fathers give no father (mother still found)',
      by('Q999000027').fatherName === '' && by('Q999000027').parentData.father === null && by('Q999000027').motherName === 'Beatrice Quill');

    // Degenerate input
    const w2 = makeWorld();
    check('no surname -> [] without any call', same(await w2.make().searchPerson({ givenName: 'Edmund' }), []) && w2.calls.length === 0);
    check('empty query -> [] without throwing', same(await w2.make().searchPerson(), []) && w2.calls.length === 0);
    const w3 = makeWorld();
    check('no search hits -> [] after a single call', same(await w3.make().searchPerson({ givenName: 'Nobody', surname: 'Atall' }), []) && w3.calls.length === 1);
    const w4 = makeWorld();
    const r4 = await w4.make().searchPerson({ givenName: 'John', surname: 'Ashdown', birthDate: '1950' });
    check('all candidates filtered out -> [] and no label call', r4.length === 0 && w4.calls.length === 2);
    const s5 = makeWorld().make({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    check('network failure in searchPerson -> [] (no throw)', same(await s5.searchPerson({ givenName: 'Edmund', surname: 'Fairweather' }), []));
  }

  // ── 5. getParents ─────────────────────────────────────────────────────────
  section('getParents');
  {
    const w = makeWorld();
    const p = await w.make().getParents('Q999000001');
    check('father mapped with dates + places (month precision, year precision)',
      same(p.father, { id: 'Q999000002', name: 'Henry Fairweather', gender: 'Male', birthDate: 'February 1871', birthPlace: 'Birmingham', deathDate: '1940', deathPlace: '', _source: 'Wikidata' }));
    check('mother mapped (year-only birth, no death)',
      same(p.mother, { id: 'Q999000003', name: 'Agnes Fairweather', gender: 'Female', birthDate: '1875', birthPlace: '', deathDate: '', deathPlace: '', _source: 'Wikidata' }));
    check('3 calls: child, parents (one batch), places (one batch)',
      same(actions(w), ['wbgetentities', 'wbgetentities', 'wbgetentities']) &&
      same(sorted(w.calls[1].params.ids.split('|')), ['Q999000002', 'Q999000003']) && w.calls[2].params.ids === 'Q2256');

    const p2 = await makeWorld().make().getParents('q999000025');
    check('lowercase id accepted; adoptive father ignored',
      p2.father && p2.father.name === 'Alfred Quill' && p2.father.deathDate === '1 June 1935' && p2.father.birthPlace === 'London' &&
      p2.mother && p2.mother.name === 'Beatrice Quill' && p2.mother.birthDate === '12 September 1874');
    const p3 = await makeWorld().make().getParents('Q999000027');
    check('conflicting fathers -> father null, mother kept', p3.father === null && p3.mother && p3.mother.name === 'Beatrice Quill');

    const none = { father: null, mother: null };
    for (const [label, id] of [['item with only P31', 'Q999000023'], ['item with claims: []', 'Q999000029'],
      ['somevalue/novalue claims', 'Q999000022'], ['nonexistent item', 'Q999999999']]) {
      let r, threw = false;
      try { r = await makeWorld().make().getParents(id); } catch (e) { threw = true; }
      check(`${label} -> {father:null, mother:null}, no throw`, !threw && same(r, none));
    }
    const wBad = makeWorld();
    check('malformed id -> nulls without any call', same(await wBad.make().getParents('not-a-qid'), none) && same(await wBad.make().getParents(), none) && wBad.calls.length === 0);
    check('network failure -> nulls, no throw',
      same(await new WikidataSource({ fetchImpl: async () => { throw new Error('boom'); }, sleep: async () => {}, logger: makeWorld().logger }).getParents('Q999000001'), none));
  }

  // ── 6. corroborate ────────────────────────────────────────────────────────
  section('corroborate: strict rules');
  {
    const w = makeWorld();
    const c = await w.make().corroborate({ name: 'Edmund Fairweather', birthYear: 1902, deathYear: 1971, birthPlace: 'London' });
    check('strict match: matched, not ambiguous', c.matched === true && c.ambiguous === false);
    check('strict match: qid/url/label/description',
      c.qid === 'Q999000001' && c.url === 'https://www.wikidata.org/wiki/Q999000001' && c.label === 'Edmund Fairweather' && c.description === 'English civil engineer');
    check('strict match: years, place, parents', c.birthYear === 1902 && c.deathYear === 1971 && c.birthPlace === 'London' &&
      c.fatherName === 'Henry Fairweather' && c.motherName === 'Agnes Fairweather');
    check('strict match: reason is a non-empty string', typeof c.reason === 'string' && c.reason.length > 0);
    check('strict match: 3 calls (search, entities, labels)', same(actions(w), ['wbsearchentities', 'wbgetentities', 'wbgetentities']));
    check('hyphenated surname and disambiguation page with the same birth year did not cause ambiguity', c.ambiguous === false);

    const ok = async (args) => makeWorld().make().corroborate(args);
    check('birthYear as string works', (await ok({ name: 'Edmund Fairweather', birthYear: '1902' })).matched === true);
    check('birthYear as full date string uses its year', (await ok({ name: 'Edmund Fairweather', birthYear: '1902-05-17' })).matched === true);
    check('no deathYear supplied: still matches', (await ok({ name: 'Edmund Fairweather', birthYear: 1902 })).matched === true);
    check('deathYear within 1 year matches (1972 vs 1971)', (await ok({ name: 'Edmund Fairweather', birthYear: 1902, deathYear: 1972 })).matched === true);
    const d = await ok({ name: 'Edmund Fairweather', birthYear: 1902, deathYear: 1975 });
    check('deathYear 4 years out: no match, reason says death', d.matched === false && d.ambiguous === false && /death/i.test(d.reason));
    check('candidate with no death year + supplied deathYear: allowed', (await ok({ name: 'Agnes Moore', birthYear: 1875, deathYear: 1950 })).matched === true);

    // Birth year must be EXACT
    for (const y of [1901, 1903, 1900]) {
      const r = await ok({ name: 'Edmund Fairweather', birthYear: y });
      check(`name matches but birth year ${y} != 1902: no match`, r.matched === false && r.ambiguous === false && r.qid === null && /born in/.test(r.reason));
    }

    // Ambiguity
    const a = await ok({ name: 'John Ashdown', birthYear: 1888 });
    check('two Johns born 1888: ambiguous, not matched', a.matched === false && a.ambiguous === true && a.qid === null);
    check('ambiguity reason names both candidates', /Q999000040/.test(a.reason) && /Q999000041/.test(a.reason));
    const a2 = await ok({ name: 'John Ashdown', birthYear: 1890 });
    check('two Johns, neither born 1890: plain no-match (not ambiguous)', a2.matched === false && a2.ambiguous === false);

    // Initials (either direction), aliases, diacritics
    const i1 = await ok({ name: 'E. Fairweather', birthYear: 1902 });
    check('requested initial matches the full given name', i1.matched === true && i1.qid === 'Q999000001');
    const i2 = await ok({ name: 'F. Fairweather', birthYear: 1902 });
    check('wrong initial does not match', i2.matched === false);
    const i3 = await ok({ name: 'John Pennington', birthYear: 1860 });
    check("full requested name matches a label stored with an initial ('J. Pennington')", i3.matched === true && i3.qid === 'Q999000050' && i3.label === 'J. Pennington');
    const al = await ok({ name: 'Agnes Moore', birthYear: 1875 });
    check('English alias match (label differs)', al.matched === true && al.qid === 'Q999000003' && al.label === 'Agnes Fairweather');
    const z = await ok({ name: 'Zoe Marlowe', birthYear: 1950 });
    check("diacritics: 'Zoe' matches label 'Zoë'", z.matched === true && z.qid === 'Q999000070' && z.label === 'Zoë Marlowe');
    check("diacritics: 'ZOË MARLOWE' matches too", (await ok({ name: 'ZOË MARLOWE', birthYear: 1950 })).matched === true);
    check('extra spaces/punctuation are normalised', (await ok({ name: '  Edmund   Fairweather. ', birthYear: 1902 })).matched === true);
    check('surname must match exactly (near-miss surname)', (await ok({ name: 'Edmund Fairweathe', birthYear: 1902 })).matched === false);

    // Middle names
    const wm = makeWorld();
    const m = await wm.make().corroborate({ name: 'Edmund Arthur Fairweather', birthYear: 1902 });
    check('a requested middle name absent from Wikidata is compatible; also searched as "First Last"',
      m.matched === true && wm.calls.filter(c2 => c2.params.action === 'wbsearchentities').map(c2 => c2.params.search).join('|') === 'Edmund Arthur Fairweather|Edmund Fairweather');

    // Preferred / deprecated / conflicting data
    check('birth year from the preferred-rank statement (1902)', (await ok({ name: 'Robert Quill', birthYear: 1902 })).qid === 'Q999000025');
    check('normal-rank 1905 on the same item is shadowed by preferred; the real 1905 item is the one found',
      (await ok({ name: 'Robert Quill', birthYear: 1905 })).qid === 'Q999000028');
    check('deprecated birth year (1890) never matches', (await ok({ name: 'Robert Quill', birthYear: 1890 })).matched === false);
    check('decade-precision birth (1900) never matches', (await ok({ name: 'Robert Quill', birthYear: 1900 })).matched === false);
    const q4 = await ok({ name: 'Robert Quill', birthYear: 1904 });
    check('match with conflicting fathers: father name left null, mother kept',
      q4.matched === true && q4.qid === 'Q999000027' && q4.fatherName === null && q4.motherName === 'Beatrice Quill');

    // No birth year -> never a match, and no network traffic
    const wn = makeWorld();
    const sn = wn.make();
    const noYear = [await sn.corroborate({ name: 'Edmund Fairweather' }), await sn.corroborate({ name: 'Edmund Fairweather', birthYear: null }),
      await sn.corroborate({ name: 'Edmund Fairweather', birthYear: '' }), await sn.corroborate({ name: 'Edmund Fairweather', birthYear: 'abc' }),
      await sn.corroborate({ name: 'Edmund Fairweather', birthYear: -100 }), await sn.corroborate({ name: 'Edmund Fairweather', deathYear: 1971 })];
    check('missing/invalid birthYear: never matches, with a reason', noYear.every(r => r.matched === false && r.ambiguous === false && /birthYear/.test(r.reason)));
    check('missing birthYear makes no network calls', wn.calls.length === 0);
    check('result shape is stable on no-match', same(Object.keys(noYear[0]).sort(),
      ['ambiguous', 'birthPlace', 'birthYear', 'deathYear', 'description', 'fatherName', 'label', 'matched', 'motherName', 'qid', 'reason', 'url']));

    // Name problems
    const wnm = makeWorld();
    const single = await wnm.make().corroborate({ name: 'Fairweather', birthYear: 1902 });
    const blank = await wnm.make().corroborate({});
    check('single-token / missing name: no match without network calls', single.matched === false && blank.matched === false && wnm.calls.length === 0);
    const none = await ok({ name: 'Nobody Atall', birthYear: 1900 });
    check('no search results: no match with a reason', none.matched === false && none.ambiguous === false && /No Wikidata search results/.test(none.reason));
    const nonHuman = await makeWorld().make().corroborate({ name: 'John Ashdown', birthYear: 1950 });
    check('a non-human with the same label is never a candidate (locomotive)', nonHuman.matched === false);
  }

  // ── 7. Failure modes + config ─────────────────────────────────────────────
  section('Failure modes: network errors, timeouts, disabled');
  {
    const logs = [];
    const s = new WikidataSource({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, sleep: async () => {},
      logger: { error: m => logs.push(m), warn: m => logs.push(m) } });
    let r, threw = false;
    try { r = await s.corroborate({ name: 'Edmund Fairweather', birthYear: 1902 }); } catch (e) { threw = true; }
    check('fetch throws: corroborate does not throw', threw === false);
    check('fetch throws: matched:false with a reason', r && r.matched === false && r.ambiguous === false && /failed/i.test(r.reason) && /fetch failed/.test(r.reason));
    check('fetch throws: failure is logged', logs.length > 0);

    // Real timeout path: fetch never answers until aborted.
    const hang = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e); });
    });
    const st = new WikidataSource({ fetchImpl: hang, timeoutMs: 25, sleep: async () => {}, logger: { error() {}, warn() {} } });
    const rt = await st.corroborate({ name: 'Edmund Fairweather', birthYear: 1902 });
    check('timeout aborts the request and corroborate returns matched:false', rt.matched === false && /timed out/.test(rt.reason));

    // Disabled via config: no network, empty answers
    const w = makeWorld();
    await withConfig({ WIKIDATA_ENABLED: 'false' }, async () => {
      const s2 = w.make();
      const c = await s2.corroborate({ name: 'Edmund Fairweather', birthYear: 1902 });
      check('disabled: corroborate -> matched:false with a reason', c.matched === false && /disabled/i.test(c.reason));
      check('disabled: searchPerson -> []', same(await s2.searchPerson({ givenName: 'Edmund', surname: 'Fairweather' }), []));
      check('disabled: getParents -> nulls', same(await s2.getParents('Q999000001'), { father: null, mother: null }));
    });
    check('disabled: no network calls at all', w.calls.length === 0);

    // Re-enabled at runtime (config is read lazily)
    const c2 = await w.make().corroborate({ name: 'Edmund Fairweather', birthYear: 1902 });
    check('re-enabled at runtime: works again', c2.matched === true && w.calls.length > 0);
  }

  // ── 8. Fixtures look like the real API ────────────────────────────────────
  section('Fixture realism');
  {
    const srch = load('search-edmund-fairweather.json');
    const h = srch.search[0];
    check('search fixture has searchinfo, success and hit fields',
      srch.searchinfo && srch.success === 1 && h.id && h.title === h.id && h.pageid && h.concepturi && h.url.startsWith('//www.wikidata.org/wiki/') &&
      h.display.label.language === 'en' && h.match.type === 'label');
    const alias = load('search-agnes-moore.json').search[0];
    check("alias hit carries match.type 'alias' and aliases[]", alias.match.type === 'alias' && alias.aliases[0] === 'Agnes Moore');
    const e = load('entities-fairweather.json').entities.Q999000001;
    const birth = e.claims.P569[0];
    check('entity fixture: time datavalue with precision + calendarmodel',
      birth.mainsnak.datavalue.type === 'time' && birth.mainsnak.datavalue.value.time === '+1902-05-17T00:00:00Z' &&
      birth.mainsnak.datavalue.value.precision === 11 && /wikidata\.org\/entity\/Q1985727$/.test(birth.mainsnak.datavalue.value.calendarmodel));
    check('entity fixture: item datavalue is a wikibase-entityid', e.claims.P22[0].mainsnak.datavalue.type === 'wikibase-entityid' && e.claims.P22[0].mainsnak.datavalue.value.id === 'Q999000002');
    const quill = load('entities-quill.json').entities;
    check('fixtures include somevalue/novalue snaks, ranks, qualifiers and claims:[]',
      quill.Q999000022.claims.P569[0].mainsnak.snaktype === 'somevalue' && quill.Q999000022.claims.P570[0].mainsnak.snaktype === 'novalue' &&
      quill.Q999000025.claims.P569.some(x => x.rank === 'preferred') && quill.Q999000025.claims.P569.some(x => x.rank === 'deprecated') &&
      quill.Q999000025.claims.P22.some(x => x.qualifiers && x.qualifiers.P1039) && Array.isArray(quill.Q999000029.claims));
    check('maxlag fixture has the real error envelope', load('error-maxlag.json').error.code === 'maxlag' && typeof load('error-maxlag.json').error.lag === 'number');
  }

  // Restore config
  if (savedCfg.e !== undefined) config.WIKIDATA_ENABLED = savedCfg.e;
  if (savedCfg.c !== undefined) config.WIKIDATA_CONTACT = savedCfg.c;
}

main().then(() => {
  console.log(`\n${fail === 0 ? 'ALL PASSED ✅' : fail + ' FAILED ❌'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}).catch(err => {
  console.error('UNEXPECTED ERROR in test run:', err);
  process.exit(2);
});
