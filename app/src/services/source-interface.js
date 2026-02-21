/**
 * They Made Me — Research Source Interface
 *
 * All research sources (FamilySearch, Geni, FreeBMD) implement this interface.
 * Provides a uniform API so the research engine can work with any source.
 */

const SOURCE_CAPABILITIES = {
  SEARCH: 'search',             // Can search for people by name/dates
  TREE_TRAVERSAL: 'tree',       // Can walk parent relationships
  CONFIRMATION: 'confirmation', // Can confirm birth/death/marriage records
  SOURCES: 'sources',           // Can provide source citations
};

class ResearchSource {
  /** Human-readable name of this source (e.g. "FamilySearch", "Geni", "FreeBMD") */
  get sourceName() { throw new Error('Must implement sourceName'); }

  /** Array of SOURCE_CAPABILITIES this source supports */
  get capabilities() { throw new Error('Must implement capabilities'); }

  /** Check if this source is currently available/configured */
  isAvailable() { return false; }

  // ─── Tree/Search methods (same data shapes as familysearch-api.js) ─────

  /**
   * Search for a person. Returns array of candidates:
   * [{ id, name, gender, birthDate, birthPlace, deathDate, deathPlace,
   *    score, fatherName, motherName, facts, names, display, raw }]
   */
  async searchPerson(query) { return []; }

  /**
   * Get parents for a person by source-specific ID.
   * Returns { father: {id, name, gender, birthDate, birthPlace, ...} | null,
   *           mother: {id, name, gender, birthDate, birthPlace, ...} | null }
   */
  async getParents(personId) { return { father: null, mother: null }; }

  /**
   * Get ancestry pedigree for a person.
   * Returns array of ancestors with ascendancy numbers.
   */
  async getAncestry(personId, generations) { return []; }

  /**
   * Get detailed person information by source-specific ID.
   */
  async getPersonDetails(personId) { return null; }

  /**
   * Get source citations for a person.
   * Returns [{ title, url, citation }]
   */
  async getPersonSources(personId) { return []; }

  // ─── Confirmation methods (FreeBMD) ────────────────────────────────────

  /**
   * Try to confirm a birth record.
   * Returns matching entry or null.
   */
  async confirmBirth(firstName, lastName, birthYear, birthPlace) { return null; }

  /**
   * Try to confirm a death record.
   * Returns matching entry or null.
   */
  async confirmDeath(firstName, lastName, deathYear) { return null; }

  /**
   * Try to find a marriage record.
   * Returns matching entry or null.
   */
  async findMarriage(surname, firstName, spouseSurname, yearFrom, yearTo, district) { return null; }
}

module.exports = { ResearchSource, SOURCE_CAPABILITIES };
