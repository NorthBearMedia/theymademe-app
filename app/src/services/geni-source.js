/**
 * They Made Me — Geni Source Adapter
 *
 * Wraps geni-api.js with the ResearchSource interface.
 * Handles data format normalization from Geni format to the unified
 * format expected by the research engine.
 */

const geniApi = require('./geni-api');
const geniOauth = require('./geni-oauth');
const { ResearchSource, SOURCE_CAPABILITIES } = require('./source-interface');

class GeniSource extends ResearchSource {
  get sourceName() { return 'Geni'; }

  get capabilities() {
    return [SOURCE_CAPABILITIES.SEARCH, SOURCE_CAPABILITIES.TREE_TRAVERSAL];
  }

  isAvailable() {
    return !!geniOauth.getStoredToken();
  }

  /**
   * Search Geni for a person. The geni-api already returns unified format.
   * We tag results with _source: 'Geni' for tracking.
   */
  async searchPerson(query) {
    try {
      const results = await geniApi.searchPerson(query);
      // Ensure all results are tagged with source
      return results.map(r => ({ ...r, _source: 'Geni' }));
    } catch (err) {
      console.error(`[GeniSource] Search error:`, err.message);
      return [];
    }
  }

  /**
   * Get parents for a Geni profile ID.
   * Returns { father, mother } in same format as FamilySearch.
   */
  async getParents(personId) {
    try {
      return await geniApi.getParents(personId);
    } catch (err) {
      console.error(`[GeniSource] getParents error:`, err.message);
      return { father: null, mother: null };
    }
  }

  /**
   * Get ancestry tree from Geni.
   */
  async getAncestry(personId, generations) {
    try {
      const ancestors = await geniApi.getAncestors(personId, generations);
      // Transform to the format expected by the engine
      return ancestors.map(a => ({
        fs_person_id: a.sourceId || a.id,
        name: a.name || [a.firstName, a.middleName, a.lastName].filter(Boolean).join(' ') || 'Unknown',
        gender: a.gender || 'Unknown',
        birthDate: a.birthDate || '',
        birthPlace: a.birthPlace || '',
        deathDate: a.deathDate || '',
        deathPlace: a.deathPlace || '',
        raw_data: a.raw || a,
        _source: 'Geni',
      }));
    } catch (err) {
      console.error(`[GeniSource] getAncestry error:`, err.message);
      return [];
    }
  }

  /**
   * Get person details from Geni.
   */
  async getPersonDetails(personId) {
    try {
      return await geniApi.getPersonDetails(personId);
    } catch (err) {
      console.error(`[GeniSource] getPersonDetails error:`, err.message);
      return null;
    }
  }

  /**
   * Geni does not provide source citations in the same way as FamilySearch.
   */
  async getPersonSources(personId) {
    return [];
  }
}

module.exports = { GeniSource };
