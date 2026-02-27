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

  async getParents(personId) {
    return fsApi.getParents(personId);
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
