/**
 * They Made Me — FamilySearch Source Adapter
 *
 * Thin wrapper around the existing familysearch-api.js that implements
 * the ResearchSource interface. Zero changes to the underlying FS code.
 */

const fsApi = require('./familysearch-api');
const oauth = require('./familysearch-oauth');
const { ResearchSource, SOURCE_CAPABILITIES } = require('./source-interface');

class FamilySearchSource extends ResearchSource {
  get sourceName() { return 'FamilySearch'; }

  get capabilities() {
    return [SOURCE_CAPABILITIES.SEARCH, SOURCE_CAPABILITIES.SOURCES];
  }

  isAvailable() {
    return !!oauth.getStoredToken();
  }

  async searchPerson(query) {
    return fsApi.searchPerson(query);
  }

  async getParents(personId) {
    return fsApi.getParents(personId);
  }

  async getPersonDetails(personId) {
    return fsApi.getPersonDetails(personId);
  }

  async getPersonSources(personId) {
    return fsApi.getPersonSources(personId);
  }
}

module.exports = { FamilySearchSource };
