/**
 * Mock FamilySearch + FreeBMD sources backed by an in-memory dataset.
 *
 * Lets the REAL ResearchEngine run offline (no token, no network) so we can
 * measure accuracy against a known ground truth. The data shapes mirror
 * familysearch-api.js exactly (searchPerson/getParents/getSpouses/
 * getPersonSources) and freebmd-client.js (searchBirths/searchMarriages/…).
 *
 * A dataset entry (one FamilySearch "person"):
 *   {
 *     id, name, gender: 'Male'|'Female',
 *     birthDate, birthPlace, deathDate, deathPlace,
 *     fatherId, motherId,            // tree links (optional)
 *     spouseIds: [],                 // optional
 *     sources: [{title,url,citation}],
 *     facts: { census:[], birth:[], marriage:[], death:[], residence:[],
 *              baptism:[], burial:[], other:[] }   // optional
 *   }
 */

const fsApi = require('../../src/services/familysearch-api');

function year(s) {
  if (!s) return null;
  const m = String(s).match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : null;
}
function firstToken(name) { return (name || '').trim().split(/\s+/)[0] || ''; }
function lastToken(name) {
  const p = (name || '').trim().split(/\s+/);
  return p[p.length - 1] || '';
}
const EMPTY_FACTS = () => ({ census: [], birth: [], marriage: [], death: [], residence: [], baptism: [], burial: [], other: [] });

function buildMockSources(dataset, opts = {}) {
  const byId = {};
  for (const p of dataset) byId[p.id] = p;

  const display = (p) => ({
    name: p.name, gender: p.gender,
    birthDate: p.birthDate || '', birthPlace: p.birthPlace || '',
    deathDate: p.deathDate || '', deathPlace: p.deathPlace || '',
  });
  const parentObj = (id) => {
    const p = byId[id];
    if (!p) return null;
    return {
      id: p.id, name: p.name, gender: p.gender,
      birthDate: p.birthDate || '', birthPlace: p.birthPlace || '',
      deathDate: p.deathDate || '', deathPlace: p.deathPlace || '',
      facts: p.factsRaw || [], raw: { id: p.id, display: display(p) },
    };
  };

  // ── FamilySearch search: surname must match (incl. simple variants),
  //    given-name first token must match, birth year within tolerance. ──
  const BIRTH_TOL = opts.birthTolerance != null ? opts.birthTolerance : 6;
  function searchPerson(query) {
    const qGiven = (query.givenName || '').toLowerCase();
    const qSur = (query.surname || '').toLowerCase();
    const qYear = year(query.birthDate);
    const out = [];
    for (const p of dataset) {
      const pGiven = firstToken(p.name).toLowerCase();
      const pSur = lastToken(p.name).toLowerCase();
      if (qSur && pSur !== qSur && !pSur.startsWith(qSur.slice(0, 4)) && !qSur.startsWith(pSur.slice(0, 4))) continue;
      if (qGiven && pGiven !== qGiven && !pGiven.startsWith(qGiven.slice(0, 3))) continue;
      const pYear = year(p.birthDate);
      let score = 100;
      if (qYear && pYear) {
        const diff = Math.abs(qYear - pYear);
        if (diff > BIRTH_TOL) continue;
        score -= diff * 4;
      }
      if (qGiven && pGiven === qGiven) score += 10;
      out.push({
        id: p.id,
        name: p.name,
        gender: p.gender || 'Unknown',
        birthDate: p.birthDate || '',
        birthPlace: p.birthPlace || '',
        deathDate: p.deathDate || '',
        deathPlace: p.deathPlace || '',
        score,
        fatherName: byId[p.fatherId]?.name || '',
        motherName: byId[p.motherId]?.name || '',
        parentData: {
          father: p.fatherId ? parentObj(p.fatherId) : null,
          mother: p.motherId ? parentObj(p.motherId) : null,
        },
        facts: p.factsRaw || [],
        names: [],
        display: display(p),
        raw: { id: p.id, display: display(p), facts: p.factsRaw || [] },
      });
    }
    out.sort((a, b) => b.score - a.score);
    const count = query.count || 10;
    return out.slice(0, count);
  }

  const fsSource = {
    sourceName: 'FamilySearch',
    isAvailable: () => true,
    hasTreeAccess: () => true,
    async searchPerson(query) { return searchPerson(query); },
    async getParents(personId) {
      const p = byId[personId];
      if (!p) return { father: null, mother: null };
      return { father: p.fatherId ? parentObj(p.fatherId) : null, mother: p.motherId ? parentObj(p.motherId) : null };
    },
    async getSpouses(personId) {
      const p = byId[personId];
      if (!p || !p.spouseIds) return [];
      return p.spouseIds.map(sid => {
        const s = byId[sid];
        if (!s) return null;
        return {
          id: s.id, name: s.name, gender: s.gender,
          birthDate: s.birthDate || '', birthPlace: s.birthPlace || '',
          deathDate: s.deathDate || '', deathPlace: s.deathPlace || '',
          facts: s.factsRaw || [], raw: { id: s.id, display: display(s) },
          marriageFacts: s.marriageFacts || [],
        };
      }).filter(Boolean);
    },
    async getPersonSources(personId) { return byId[personId]?.sources || []; },
    async getPersonDetails(personId) {
      const p = byId[personId];
      return p ? { id: p.id, display: display(p), facts: p.factsRaw || [] } : null;
    },
  };

  // Phase 3b scoring + some discovery paths call these directly on the api
  // module (bypassing this.fsSource), so patch them to read the fixture too.
  fsApi.extractFactsByType = async (personId) => {
    const p = byId[personId];
    return Object.assign(EMPTY_FACTS(), (p && p.facts) || {});
  };
  fsApi.getPersonSources = async (personId) => byId[personId]?.sources || [];

  // ── FreeBMD mock (optional) ──────────────────────────────────────
  const fb = opts.freebmd || {};
  const freebmdSource = {
    sourceName: 'FreeBMD',
    isAvailable: () => !!opts.freebmdEnabled,
    async searchBirths() { return fb.births || []; },
    async searchMarriages() { return fb.marriages || []; },
    async searchDeaths() { return fb.deaths || []; },
    async confirmBirth() { return null; },
    async confirmDeath() { return null; },
    async findMarriage() { return null; },
  };

  const sources = [fsSource];
  if (opts.freebmdEnabled) sources.push(freebmdSource);
  return sources;
}

module.exports = { buildMockSources };
