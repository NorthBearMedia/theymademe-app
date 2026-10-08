/**
 * They Made Me — FamilySearch Source Adapter
 *
 * Thin wrapper around the existing familysearch-api.js that implements
 * the ResearchSource interface. Zero changes to the underlying FS code.
 */

const config = require('../config');
const fsApi = require('./familysearch-api');
const oauth = require('./familysearch-oauth');
const { ResearchSource, SOURCE_CAPABILITIES } = require('./source-interface');

class FamilySearchSource extends ResearchSource {
  constructor() {
    super();
    // personId -> { father, mother } filled from a single Read-Ancestry call
    this._pedigree = new Map();
    this._pedigreeFailed = false;
  }

  get sourceName() { return 'FamilySearch'; }

  get capabilities() {
    return [SOURCE_CAPABILITIES.SEARCH, SOURCE_CAPABILITIES.SOURCES, 'records', 'pedigree'];
  }

  isAvailable() {
    // Check stored token synchronously first
    if (oauth.getStoredToken()) return true;
    // If no stored token, we'll try to obtain one lazily on first API call
    // Mark as available — the API layer will auto-obtain an unauthenticated token
    return true;
  }

  /**
   * Whether the current token has full tree access (authenticated via OAuth).
   * When false, search works but getParents/getSpouses will fail with 401.
   */
  hasTreeAccess() {
    return oauth.isAuthenticated();
  }

  async searchPerson(query) {
    return fsApi.searchPerson(query);
  }

  /**
   * Parents of a tree person. With FS_USE_PEDIGREE=true ONE Read-Ancestry call
   * (4 generations) answers for every person in that pedigree, instead of one
   * request per person. Any failure falls back — permanently for this run — to
   * the per-person call, so behaviour is never worse than before.
   */
  async getParents(personId) {
    if (config.FS_USE_PEDIGREE && !this._pedigreeFailed) {
      const cached = this._pedigree.get(personId);
      if (cached) return cached;
      try {
        await this._loadPedigree(personId, 4);
        const hit = this._pedigree.get(personId);
        if (hit) return hit;
      } catch (err) {
        console.log(`[FamilySearch] pedigree fetch failed (${err.message}) — falling back to per-person parent lookups`);
        this._pedigreeFailed = true;
      }
    }
    return fsApi.getParents(personId);
  }

  async _loadPedigree(rootId, generations) {
    const persons = await fsApi.getAncestry(rootId, generations);
    const byAsc = new Map();
    for (const p of persons) if (p.ascendancy_number) byAsc.set(p.ascendancy_number, p);
    const asParent = (p) => p ? {
      id: p.id, name: p.name, gender: p.gender,
      birthDate: p.birthDate, birthPlace: p.birthPlace,
      deathDate: p.deathDate, deathPlace: p.deathPlace,
      facts: p.facts || [], raw: p.raw,
    } : null;
    const limit = Math.pow(2, generations);
    for (const [asc, person] of byAsc) {
      // Only people whose parents fall INSIDE the fetched range can be answered
      // authoritatively (absence there means "no parents"); the outermost
      // generation falls through to a fresh pedigree rooted at them.
      if (asc * 2 + 1 < limit) {
        this._pedigree.set(person.id, {
          father: asParent(byAsc.get(asc * 2)),
          mother: asParent(byAsc.get(asc * 2 + 1)),
        });
      }
    }
  }

  async getAncestry(personId, generations) {
    return fsApi.getAncestry(personId, generations);
  }

  /** Historical-records search (census, civil index, parish …). */
  async searchRecords(query) {
    return fsApi.searchRecords(query);
  }

  /**
   * Record hints for a tree person, summarised for INTERNAL corroboration.
   * FamilySearch's terms restrict DISPLAYING historical-records data to its own
   * products, so callers get titles for classification only — never persist
   * them into customer-facing output.
   */
  async getRecordHints(personId) {
    const entries = await fsApi.getPersonMatches(personId);
    return entries.map(e => ({
      title: e.entryTitle || e.sourceTitles?.[0] || '',
      sourceTitles: e.sourceTitles || [],
      score: e.score,
    })).filter(h => h.title || h.sourceTitles.length);
  }

  async getPersonDetails(personId) {
    return fsApi.getPersonDetails(personId);
  }

  async getPersonSources(personId) {
    return fsApi.getPersonSources(personId);
  }

  async getSpouses(personId) {
    return fsApi.getSpouses(personId);
  }
}

module.exports = { FamilySearchSource };
