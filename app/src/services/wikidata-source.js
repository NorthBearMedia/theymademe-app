/**
 * They Made Me — Wikidata Source Adapter
 *
 * Wikidata (CC0) is an open knowledge base of NOTABLE people. Most of a
 * customer's ancestors will never be in it, so this adapter exists to:
 *
 *   (a) corroborate an ancestor when there is a strict, unambiguous match, and
 *   (b) walk parents (P22 father / P25 mother) for the occasional notable lineage.
 *
 * PRECISION OVER RECALL: whenever there is doubt (several candidates, an
 * unknown or conflicting birth year, a name that is only "close"), the answer
 * is "no match". A wrongly corroborated ancestor is far worse than a missed one.
 *
 * Network policy (Wikimedia):
 *   - Action API only (https://www.wikidata.org/w/api.php), never SPARQL / Special:Search.
 *   - Identifying User-Agent with a contact address.
 *   - Serial requests, minimum interval between calls (default 1100 ms).
 *   - maxlag=5 on every call; HTTP 429 / 5xx and maxlag errors are retried,
 *     honouring a (capped) Retry-After.
 *
 * Config (read lazily, so it can change at runtime):
 *   config.WIKIDATA_ENABLED  string; anything other than 'false' means enabled
 *   config.WIKIDATA_CONTACT  string for the User-Agent (default info@northbearmedia.co.uk)
 */

const config = require('../config');
const { ResearchSource, SOURCE_CAPABILITIES } = require('./source-interface');

const API_URL = 'https://www.wikidata.org/w/api.php';
const ENTITY_URL = 'https://www.wikidata.org/wiki/';
const DEFAULT_CONTACT = 'info@northbearmedia.co.uk';

const SEARCH_LIMIT = 20;
const MAX_IDS_PER_CALL = 50;       // wbgetentities hard limit for non-bots
const MAXLAG_SECONDS = 5;
const MAX_RETRY_AFTER_MS = 30000;  // never sleep longer than this on a retry
const DEFAULT_MAXLAG_WAIT_MS = 5000;
const BIRTH_YEAR_TOLERANCE = 2;    // searchPerson only; corroborate is exact
const DEATH_YEAR_TOLERANCE = 1;    // corroborate only
const ENTITY_PROPS = 'labels|descriptions|aliases|claims';

const Q_HUMAN = 'Q5';
const Q_MALE = 'Q6581097';
const Q_FEMALE = 'Q6581072';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

class WikidataError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'WikidataError';
    this.status = status;
    this.code = code;
  }
}

// ─── Pure helpers: names ────────────────────────────────────────────────────

const CHAR_FOLD = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ı': 'i', 'þ': 'th', 'ð': 'd' };

/**
 * Lowercase, strip diacritics, drop apostrophes / periods / hyphens, turn any
 * other punctuation into a space, collapse whitespace.
 */
function normaliseName(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[øłđæœßıþð]/g, ch => CHAR_FOLD[ch])
    .replace(/['’‘`´.\-‐‑–—]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  const n = normaliseName(s);
  return n ? n.split(' ') : [];
}

/** Build a requested-name descriptor: { first, middles[], surname[] } (normalised tokens). */
function requestedName(givenNames, surname) {
  const g = tokens(givenNames);
  return { first: g[0] || '', middles: g.slice(1), surname: tokens(surname) };
}

/** "John Smith" / "John William Smith" -> surname is the final token. */
function requestedNameFromFull(fullName) {
  const t = tokens(fullName);
  if (t.length < 2) return null;
  return { first: t[0], middles: t.slice(1, -1), surname: [t[t.length - 1]] };
}

/** Equal, or one side is a single-letter initial of the other. */
function givenCompatible(a, b) {
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

/**
 * Strict name check of ONE candidate name against the request:
 *   - candidate must end with exactly the requested surname tokens;
 *   - what precedes it must start with a given name that equals the requested
 *     first given name or is its initial (either direction);
 *   - middle names, where BOTH sides have them, must agree position by position
 *     (equal or initial). A name with no middle names is compatible with one that has them.
 */
function nameMatchesOne(req, candidateName) {
  const c = tokens(candidateName);
  const sn = req.surname.length;
  if (sn === 0 || c.length <= sn) return false;
  const tail = c.slice(c.length - sn);
  for (let i = 0; i < sn; i++) if (tail[i] !== req.surname[i]) return false;
  const head = c.slice(0, c.length - sn);
  if (req.first) {
    if (!givenCompatible(req.first, head[0])) return false;
  }
  const candMiddles = head.slice(1);
  const n = Math.min(candMiddles.length, req.middles.length);
  for (let i = 0; i < n; i++) {
    if (!givenCompatible(req.middles[i], candMiddles[i])) return false;
  }
  return true;
}

/** label OR any English alias must satisfy the strict name check. */
function nameMatches(req, names) {
  return names.some(n => nameMatchesOne(req, n));
}

// ─── Pure helpers: claims ───────────────────────────────────────────────────

/** Non-deprecated statements for a property; if any are 'preferred', only those. */
function bestStatements(claims, prop) {
  const list = claims && Array.isArray(claims[prop]) ? claims[prop] : [];
  const live = list.filter(s => s && s.rank !== 'deprecated');
  const preferred = live.filter(s => s.rank === 'preferred');
  return preferred.length ? preferred : live;
}

function hasQualifier(statement, prop) {
  const q = statement && statement.qualifiers;
  return !!(q && Array.isArray(q[prop]) && q[prop].length);
}

/**
 * Distinct item ids from the best-ranked statements of a property.
 * 'somevalue' / 'novalue' snaks carry no id and are skipped.
 * skipKinship drops statements that carry a P1039 "kinship to subject"
 * qualifier (adoptive / step / foster parents), which are not biological lineage.
 */
function itemIds(claims, prop, { skipKinship = false } = {}) {
  const out = [];
  for (const s of bestStatements(claims, prop)) {
    if (skipKinship && hasQualifier(s, 'P1039')) continue;
    const snak = s.mainsnak;
    if (!snak || snak.snaktype !== 'value') continue;
    const v = snak.datavalue && snak.datavalue.value;
    if (v && typeof v.id === 'string' && /^Q\d+$/.test(v.id) && !out.includes(v.id)) out.push(v.id);
  }
  return out;
}

/** Exactly one distinct id, else null (zero = unknown, several = conflicting). */
function singleItemId(claims, prop, opts) {
  const ids = itemIds(claims, prop, opts);
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Parse a Wikidata 'time' datavalue ("+1902-05-17T00:00:00Z").
 * Only CE years at year precision (9) or finer are trusted.
 * Returns { year, text } or null.
 */
function parseWikidataTime(value) {
  if (!value || typeof value.time !== 'string') return null;
  const m = /^([+-])(\d{1,16})-(\d{2})-(\d{2})T/.exec(value.time);
  if (!m || m[1] === '-') return null;                       // BCE / malformed
  const precision = Number(value.precision);
  if (!Number.isInteger(precision) || precision < 9) return null; // decade, century...
  const year = parseInt(m[2], 10);
  if (!(year >= 1 && year <= 9999)) return null;
  const month = parseInt(m[3], 10);
  const day = parseInt(m[4], 10);
  let text = String(year);
  if (precision >= 10 && month >= 1 && month <= 12) {
    text = `${MONTHS[month - 1]} ${year}`;
    if (precision >= 11 && day >= 1 && day <= 31) text = `${day} ${MONTHS[month - 1]} ${year}`;
  }
  return { year, text, precision: Math.min(precision, 11) };
}

const NO_DATE = Object.freeze({ year: null, text: '', conflict: false });

/**
 * Year/text for a date property (P569 / P570).
 * Unknown (somevalue), absent (novalue), BCE, coarse-precision or missing
 * statements give NO_DATE. Several best-rank statements that disagree on the
 * year are a conflict and also give no date (with conflict:true).
 */
function dateInfo(claims, prop) {
  const found = [];
  for (const s of bestStatements(claims, prop)) {
    const snak = s.mainsnak;
    if (!snak || snak.snaktype !== 'value') continue;
    const parsed = parseWikidataTime(snak.datavalue && snak.datavalue.value);
    if (parsed) found.push(parsed);
  }
  if (!found.length) return NO_DATE;
  if (new Set(found.map(f => f.year)).size > 1) return { year: null, text: '', conflict: true };
  const best = found.reduce((a, b) => (b.precision > a.precision ? b : a));
  return { year: best.year, text: best.text, conflict: false };
}

function genderOf(claims) {
  const ids = itemIds(claims, 'P21');
  if (ids.length !== 1) return 'Unknown';
  if (ids[0] === Q_MALE) return 'Male';
  if (ids[0] === Q_FEMALE) return 'Female';
  return 'Unknown';
}

/** Flatten a wbgetentities entity into the facts the adapter uses. */
function summarise(entity) {
  const claims = (entity && entity.claims) || {};
  const label = (entity && entity.labels && entity.labels.en && entity.labels.en.value) || '';
  const description = (entity && entity.descriptions && entity.descriptions.en && entity.descriptions.en.value) || '';
  const aliasList = entity && entity.aliases && entity.aliases.en;
  const aliases = Array.isArray(aliasList) ? aliasList.map(a => a && a.value).filter(Boolean) : [];
  return {
    id: entity.id,
    label,
    description,
    aliases,
    names: [label, ...aliases].filter(Boolean),
    human: itemIds(claims, 'P31').includes(Q_HUMAN),
    gender: genderOf(claims),
    birth: dateInfo(claims, 'P569'),
    death: dateInfo(claims, 'P570'),
    birthPlaceId: singleItemId(claims, 'P19'),
    deathPlaceId: singleItemId(claims, 'P20'),
    fatherId: singleItemId(claims, 'P22', { skipKinship: true }),
    motherId: singleItemId(claims, 'P25', { skipKinship: true }),
  };
}

// ─── Pure helpers: misc ─────────────────────────────────────────────────────

function unique(arr) { return Array.from(new Set(arr)); }

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

/** First 4-digit year in a date string / number, as an integer, else null. */
function extractYear(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 9999 ? v : null;
  const m = String(v).match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function qidUrl(qid) { return `${ENTITY_URL}${qid}`; }

function headerValue(res, name) {
  try {
    return res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
  } catch (e) {
    return null;
  }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

class WikidataSource extends ResearchSource {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.fetchImpl]       fetch-compatible function (default global fetch)
   * @param {number}   [opts.minIntervalMs]   minimum gap between request starts (default 1100)
   * @param {string}   [opts.userAgent]       override the generated User-Agent
   * @param {number}   [opts.maxRetries]      retries after the first attempt (default 3)
   * @param {number}   [opts.timeoutMs]       per-request timeout (default 15000)
   * @param {Function} [opts.sleep]           async (ms) => void   (injectable for tests)
   * @param {Function} [opts.now]             () => ms             (injectable for tests)
   * @param {object}   [opts.logger]          { error, warn } (default console)
   */
  constructor(opts = {}) {
    super();
    this.fetchImpl = opts.fetchImpl || global.fetch;
    this.minIntervalMs = opts.minIntervalMs != null ? opts.minIntervalMs : 1100;
    this.userAgentOverride = opts.userAgent || null;
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
    this.timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 15000;
    this.maxRetryAfterMs = opts.maxRetryAfterMs != null ? opts.maxRetryAfterMs : MAX_RETRY_AFTER_MS;
    this._sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this._now = opts.now || (() => Date.now());
    this._logger = opts.logger || console;
    this._lastCallAt = null;
    this._gate = Promise.resolve();
  }

  get sourceName() { return 'Wikidata'; }

  get capabilities() {
    return [SOURCE_CAPABILITIES.SEARCH, SOURCE_CAPABILITIES.TREE_TRAVERSAL, 'corroboration'];
  }

  isAvailable() {
    return String(config.WIKIDATA_ENABLED).trim().toLowerCase() !== 'false';
  }

  // ─── Network layer (the only code that touches the network) ──────────────

  _userAgent() {
    if (this.userAgentOverride) return this.userAgentOverride;
    const contact = clean(config.WIKIDATA_CONTACT).replace(/[()]/g, '') || DEFAULT_CONTACT;
    return `TheyMadeMe/1.0 (https://theymademe.co.uk; ${contact}) node-fetch`;
  }

  /** Serialise callers and keep at least minIntervalMs between request starts. */
  _throttle() {
    const run = async () => {
      if (this._lastCallAt != null) {
        const wait = this._lastCallAt + this.minIntervalMs - this._now();
        if (wait > 0) await this._sleep(wait);
      }
      this._lastCallAt = this._now();
    };
    const p = this._gate.then(run, run);
    this._gate = p.catch(() => {});
    return p;
  }

  /** Milliseconds to wait before a retry: Retry-After (seconds or date), else fallback; capped. */
  _retryDelay(retryAfter, fallbackMs) {
    let ms = fallbackMs;
    if (retryAfter != null && String(retryAfter).trim() !== '') {
      const asNumber = Number(retryAfter);
      if (Number.isFinite(asNumber)) {
        ms = asNumber * 1000;
      } else {
        const when = Date.parse(retryAfter);
        if (!Number.isNaN(when)) ms = when - this._now();
      }
    }
    return Math.max(0, Math.min(ms, this.maxRetryAfterMs));
  }

  /** One HTTP attempt (timeout covers headers + body). Never retries. */
  async _attempt(url) {
    if (typeof this.fetchImpl !== 'function') {
      throw new WikidataError('no fetch implementation available', { code: 'no-fetch' });
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': this._userAgent(), 'Accept': 'application/json' },
        signal: ctrl ? ctrl.signal : undefined,
      });
      const out = {
        status: res.status,
        ok: !!res.ok,
        retryAfter: headerValue(res, 'retry-after'),
        body: undefined,
        badJson: false,
      };
      if (out.ok) {
        try { out.body = await res.json(); } catch (e) { out.badJson = true; }
      }
      return out;
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      throw new WikidataError(timedOut ? `request timed out after ${this.timeoutMs}ms` : `network error: ${err && err.message}`,
        { code: timedOut ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET the Action API with throttling and retries. Returns parsed JSON.
   * Retries HTTP 429, HTTP 5xx and `maxlag` error bodies (HTTP 200).
   * Throws WikidataError on anything else (network, timeout, 4xx, other API errors).
   */
  async _request(params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    qs.set('format', 'json');
    qs.set('maxlag', String(MAXLAG_SECONDS));
    const url = `${API_URL}?${qs.toString()}`;

    const attempts = Math.max(1, this.maxRetries + 1);
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this._throttle();
      const res = await this._attempt(url);

      let failure = null;
      let delay = 0;
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        failure = new WikidataError(`HTTP ${res.status}`, { status: res.status });
        delay = this._retryDelay(res.retryAfter, 1000 * Math.pow(2, attempt));
      } else if (!res.ok) {
        throw new WikidataError(`HTTP ${res.status}`, { status: res.status });
      } else if (res.badJson || !res.body || typeof res.body !== 'object') {
        throw new WikidataError('response was not valid JSON', { code: 'bad-json' });
      } else if (res.body.error) {
        const code = res.body.error.code || 'unknown';
        const info = res.body.error.info || '';
        if (code !== 'maxlag') throw new WikidataError(`API error ${code}: ${info}`, { code });
        failure = new WikidataError(`maxlag: ${info}`, { code: 'maxlag' });
        delay = this._retryDelay(res.retryAfter, DEFAULT_MAXLAG_WAIT_MS);
      } else {
        return res.body;
      }

      if (attempt === attempts - 1) {
        failure.message += ` (gave up after ${attempts} attempts)`;
        throw failure;
      }
      await this._sleep(delay);
    }
    throw new WikidataError('unreachable', { code: 'unreachable' });
  }

  // ─── Action API wrappers ─────────────────────────────────────────────────

  /** wbsearchentities -> array of hits ({ id, label, description, ... }). */
  async _searchEntities(term) {
    const body = await this._request({
      action: 'wbsearchentities',
      search: term,
      language: 'en',
      uselang: 'en',
      type: 'item',
      limit: SEARCH_LIMIT,
    });
    const hits = Array.isArray(body.search) ? body.search : [];
    return hits.filter(h => h && typeof h.id === 'string' && /^Q\d+$/.test(h.id));
  }

  /** wbgetentities, batched 50 per call. Returns { QID: entity } (missing items omitted). */
  async _getEntities(ids, props = ENTITY_PROPS) {
    const wanted = unique((ids || []).filter(id => typeof id === 'string' && /^Q\d+$/.test(id)));
    const out = {};
    for (let i = 0; i < wanted.length; i += MAX_IDS_PER_CALL) {
      const chunk = wanted.slice(i, i + MAX_IDS_PER_CALL);
      const body = await this._request({
        action: 'wbgetentities',
        ids: chunk.join('|'),
        props,
        languages: 'en',
      });
      const entities = body.entities && typeof body.entities === 'object' ? body.entities : {};
      for (const [key, ent] of Object.entries(entities)) {
        if (!ent || typeof ent !== 'object' || 'missing' in ent) continue;
        out[ent.id || key] = ent;
        if (ent.redirects && ent.redirects.from) out[ent.redirects.from] = ent;
      }
    }
    return out;
  }

  /** One batched call resolving English labels for a set of QIDs -> { QID: label }. */
  async _labelsFor(ids) {
    const ents = await this._getEntities(ids, 'labels');
    const out = {};
    for (const [id, ent] of Object.entries(ents)) {
      const l = ent.labels && ent.labels.en && ent.labels.en.value;
      if (l) out[id] = l;
    }
    return out;
  }

  // ─── ResearchSource: search ──────────────────────────────────────────────

  /**
   * Search Wikidata for a person. Returns FamilySearch-shaped candidates.
   * Only humans (P31 = Q5) whose English label/alias strictly matches the
   * requested name; when birthDate is given, birth year must be known and
   * within +/-2. Errors are logged and yield [] (adapter convention).
   */
  async searchPerson(query = {}) {
    if (!this.isAvailable()) return [];
    try {
      return await this._searchPerson(query || {});
    } catch (err) {
      this._logger.error(`[WikidataSource] Search error: ${err.message}`);
      return [];
    }
  }

  async _searchPerson(query) {
    const given = clean(query.givenName);
    const surname = clean(query.surname);
    if (!surname) return [];

    const wantYear = extractYear(query.birthDate);
    const count = Number(query.count) > 0 ? Math.floor(Number(query.count)) : Infinity;
    const req = requestedName(given, surname);

    const hits = await this._searchEntities([given, surname].filter(Boolean).join(' '));
    if (!hits.length) return [];
    const entities = await this._getEntities(hits.map(h => h.id));

    const survivors = [];
    const seen = new Set();
    for (const hit of hits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      const ent = entities[hit.id];
      if (!ent) continue;
      const info = summarise(ent);
      if (!info.human) continue;
      if (!nameMatches(req, info.names)) continue;
      if (wantYear !== null) {
        if (info.birth.year === null) continue;
        if (Math.abs(info.birth.year - wantYear) > BIRTH_YEAR_TOLERANCE) continue;
      }
      survivors.push({ hit, info });
      if (survivors.length >= count) break;
    }
    if (!survivors.length) return [];

    // ONE batched call for place + parent labels of every surviving candidate.
    const labelIds = [];
    for (const { info } of survivors) {
      for (const id of [info.birthPlaceId, info.deathPlaceId, info.fatherId, info.motherId]) {
        if (id) labelIds.push(id);
      }
    }
    let labels = {};
    if (labelIds.length) {
      try {
        labels = await this._labelsFor(labelIds);
      } catch (err) {
        this._logger.warn(`[WikidataSource] label lookup failed, returning candidates without places/parents: ${err.message}`);
      }
    }

    return survivors.map(({ hit, info }) => {
      const fatherName = (info.fatherId && labels[info.fatherId]) || '';
      const motherName = (info.motherId && labels[info.motherId]) || '';
      const birthPlace = (info.birthPlaceId && labels[info.birthPlaceId]) || '';
      const deathPlace = (info.deathPlaceId && labels[info.deathPlaceId]) || '';
      const name = info.label || 'Unknown';
      return {
        id: info.id,
        name,
        gender: info.gender,
        birthDate: info.birth.text,
        birthPlace,
        deathDate: info.death.text,
        deathPlace,
        // Wikidata gives no relevance rank; the engine's own scoring decides.
        score: 0,
        fatherName,
        motherName,
        parentData: {
          father: fatherName ? { id: info.fatherId, name: fatherName, gender: 'Male' } : null,
          mother: motherName ? { id: info.motherId, name: motherName, gender: 'Female' } : null,
        },
        display: {
          name,
          gender: info.gender,
          birthDate: info.birth.text,
          birthPlace,
          deathDate: info.death.text,
          deathPlace,
        },
        description: info.description || clean(hit.description),
        url: qidUrl(info.id),
        source: 'Wikidata',
        _source: 'Wikidata', // read by source-merger.js
      };
    });
  }

  // ─── ResearchSource: tree traversal ──────────────────────────────────────

  /**
   * Parents of a Wikidata item via P22 (father) / P25 (mother).
   * Adoptive/step parents (P1039 qualifier) and conflicting values are ignored;
   * a parent must itself be a human with an English label. Never throws.
   */
  async getParents(qid) {
    const none = { father: null, mother: null };
    if (!this.isAvailable()) return none;
    const id = clean(qid).toUpperCase();
    if (!/^Q\d+$/.test(id)) return none;
    try {
      const child = (await this._getEntities([id]))[id];
      if (!child) return none;
      const c = summarise(child);
      if (!c.fatherId && !c.motherId) return none;
      if (c.fatherId && c.fatherId === c.motherId) return none; // corrupt data

      const parentEnts = await this._getEntities([c.fatherId, c.motherId].filter(Boolean));
      const father = c.fatherId && parentEnts[c.fatherId] ? summarise(parentEnts[c.fatherId]) : null;
      const mother = c.motherId && parentEnts[c.motherId] ? summarise(parentEnts[c.motherId]) : null;
      const usable = (p, oppositeGender) => !!(p && p.human && p.label && p.gender !== oppositeGender);
      const f = usable(father, 'Female') ? father : null;
      const m = usable(mother, 'Male') ? mother : null;

      const placeIds = [];
      for (const p of [f, m]) {
        if (p) for (const pid of [p.birthPlaceId, p.deathPlaceId]) if (pid) placeIds.push(pid);
      }
      let labels = {};
      if (placeIds.length) {
        try {
          labels = await this._labelsFor(placeIds);
        } catch (err) {
          this._logger.warn(`[WikidataSource] place lookup failed, returning parents without places: ${err.message}`);
        }
      }

      const shape = (p, gender) => (p ? {
        id: p.id,
        name: p.label,
        gender,
        birthDate: p.birth.text,
        birthPlace: (p.birthPlaceId && labels[p.birthPlaceId]) || '',
        deathDate: p.death.text,
        deathPlace: (p.deathPlaceId && labels[p.deathPlaceId]) || '',
        _source: 'Wikidata',
      } : null);
      return { father: shape(f, 'Male'), mother: shape(m, 'Female') };
    } catch (err) {
      this._logger.error(`[WikidataSource] getParents error: ${err.message}`);
      return none;
    }
  }

  // ─── Corroboration ───────────────────────────────────────────────────────

  /**
   * Strictly corroborate an ancestor against Wikidata.
   *
   * matched:true only if ALL hold:
   *   - exactly ONE human candidate survives every filter below;
   *   - English label or alias equals the requested name after normalisation
   *     (surname exact; first given name exact or as an initial);
   *   - candidate birth year EQUALS birthYear exactly (never matches without birthYear);
   *   - if deathYear is supplied and the candidate has a death year, they are within 1 year.
   * 2+ survivors -> ambiguous:true, matched:false. Never throws.
   *
   * birthPlace is accepted for interface symmetry but deliberately not used to
   * match (place strings are too fuzzy); the candidate's birthPlace is returned
   * so the caller can compare.
   */
  async corroborate({ name, birthYear, deathYear, birthPlace } = {}) { // eslint-disable-line no-unused-vars
    const noMatch = (reason, ambiguous = false) => ({
      matched: false, ambiguous, reason,
      qid: null, url: null, label: null, description: null,
      birthYear: null, deathYear: null, birthPlace: null, fatherName: null, motherName: null,
    });

    if (!this.isAvailable()) return noMatch('Wikidata source is disabled (WIKIDATA_ENABLED=false)');

    const nameTokens = clean(name).split(' ').filter(Boolean);
    const req = requestedNameFromFull(name);
    if (!req) return noMatch('A given name and surname are required to corroborate against Wikidata');

    const by = extractYear(birthYear);
    if (by === null) return noMatch('birthYear is required: Wikidata is never matched on name alone');
    const dy = extractYear(deathYear);

    try {
      // Wikidata search is label-prefix based, so a name with middle names is
      // also tried as "First Last".
      const terms = [nameTokens.join(' ')];
      if (nameTokens.length > 2) terms.push(`${nameTokens[0]} ${nameTokens[nameTokens.length - 1]}`);
      const ids = [];
      for (const term of terms) {
        for (const hit of await this._searchEntities(term)) if (!ids.includes(hit.id)) ids.push(hit.id);
      }
      if (!ids.length) return noMatch(`No Wikidata search results for "${nameTokens.join(' ')}"`);

      const entities = await this._getEntities(ids);
      let humans = 0;
      const nameMatched = [];
      const survivors = [];
      let deathRejected = 0;
      for (const id of ids) {
        if (!entities[id]) continue;
        const info = summarise(entities[id]);
        if (!info.human) continue;
        humans++;
        if (!nameMatches(req, info.names)) continue;
        nameMatched.push(info);
        if (info.birth.year !== by) continue; // unknown (null) never equals
        if (dy !== null && info.death.year !== null && Math.abs(info.death.year - dy) > DEATH_YEAR_TOLERANCE) {
          deathRejected++;
          continue;
        }
        survivors.push(info);
      }

      if (survivors.length > 1) {
        return noMatch(`Ambiguous: ${survivors.length} Wikidata people match name and birth year ${by} (${survivors.map(s => s.id).join(', ')}); not matching`, true);
      }
      if (survivors.length === 0) {
        if (humans === 0) return noMatch(`No human (Q5) among ${ids.length} Wikidata search result(s) for "${nameTokens.join(' ')}"`);
        if (nameMatched.length === 0) return noMatch(`${humans} human result(s) found but none with a name matching "${nameTokens.join(' ')}"`);
        if (deathRejected > 0) return noMatch(`Name and birth year ${by} match, but the death year differs from ${dy} by more than ${DEATH_YEAR_TOLERANCE}`);
        const years = nameMatched.map(n => (n.birth.year === null ? 'unknown' : n.birth.year)).join(', ');
        return noMatch(`Name matches ${nameMatched.length} candidate(s) (${nameMatched.map(n => n.id).join(', ')}) but none was born in ${by} (birth years: ${years})`);
      }

      const c = survivors[0];
      let labels = {};
      const labelIds = [c.birthPlaceId, c.fatherId, c.motherId].filter(Boolean);
      let reason = `Unique strict match on name and birth year ${by}`;
      if (labelIds.length) {
        try {
          labels = await this._labelsFor(labelIds);
        } catch (err) {
          reason += ' (place/parent lookup failed)';
          this._logger.warn(`[WikidataSource] label lookup failed after match: ${err.message}`);
        }
      }
      return {
        matched: true,
        ambiguous: false,
        reason,
        qid: c.id,
        url: qidUrl(c.id),
        label: c.label,
        description: c.description || null,
        birthYear: c.birth.year,
        deathYear: c.death.year,
        birthPlace: (c.birthPlaceId && labels[c.birthPlaceId]) || null,
        fatherName: (c.fatherId && labels[c.fatherId]) || null,
        motherName: (c.motherId && labels[c.motherId]) || null,
      };
    } catch (err) {
      this._logger.error(`[WikidataSource] corroborate error: ${err.message}`);
      return noMatch(`Wikidata lookup failed: ${err.message}`);
    }
  }
}

module.exports = { WikidataSource };
