/**
 * They Made Me — FreeBMD Source Adapter
 *
 * Wraps freebmd-client.js with the ResearchSource interface.
 * FreeBMD provides UK birth, marriage, and death index records (1837-1983).
 * Used for both discovery (searchBirths/searchMarriages/searchDeaths)
 * and confirmation (confirmBirth/confirmDeath/findMarriage).
 */

const { FreeBMDClient } = require('./freebmd-client');
const { ResearchSource, SOURCE_CAPABILITIES } = require('./source-interface');

// Singleton client instance (maintains rate limit state and cached v-tokens)
let clientInstance = null;

function getClient() {
  if (!clientInstance) clientInstance = new FreeBMDClient();
  return clientInstance;
}

class FreeBMDSource extends ResearchSource {
  get sourceName() { return 'FreeBMD'; }

  get capabilities() {
    return [SOURCE_CAPABILITIES.SEARCH, SOURCE_CAPABILITIES.CONFIRMATION];
  }

  isAvailable() {
    return true; // No auth needed — always available
  }

  // --- Raw search methods (return full result sets for discovery) ---

  async searchBirths(surname, forenames = '', yearFrom = null, yearTo = null, district = '') {
    try {
      return await getClient().searchBirths(surname, forenames, yearFrom, yearTo, district);
    } catch (err) {
      console.error(`[FreeBMDSource] searchBirths error:`, err.message);
      return [];
    }
  }

  async searchMarriages(surname, forenames = '', yearFrom = null, yearTo = null, district = '') {
    try {
      return await getClient().searchMarriages(surname, forenames, yearFrom, yearTo, district);
    } catch (err) {
      console.error(`[FreeBMDSource] searchMarriages error:`, err.message);
      return [];
    }
  }

  async searchDeaths(surname, forenames = '', yearFrom = null, yearTo = null, district = '') {
    try {
      return await getClient().searchDeaths(surname, forenames, yearFrom, yearTo, district);
    } catch (err) {
      console.error(`[FreeBMDSource] searchDeaths error:`, err.message);
      return [];
    }
  }

  // --- Confirmation methods (return best match or null) ---

  async confirmBirth(firstName, lastName, birthYear, birthPlace) {
    try {
      return await getClient().confirmBirth(firstName, lastName, birthYear, birthPlace);
    } catch (err) {
      console.error(`[FreeBMDSource] confirmBirth error:`, err.message);
      return null;
    }
  }

  async confirmDeath(firstName, lastName, deathYear) {
    try {
      return await getClient().confirmDeath(firstName, lastName, deathYear);
    } catch (err) {
      console.error(`[FreeBMDSource] confirmDeath error:`, err.message);
      return null;
    }
  }

  async findMarriage(surname, firstName, spouseSurname, yearFrom, yearTo, district) {
    try {
      return await getClient().findMarriage(surname, firstName, spouseSurname, yearFrom, yearTo, district);
    } catch (err) {
      console.error(`[FreeBMDSource] findMarriage error:`, err.message);
      return null;
    }
  }
}

module.exports = { FreeBMDSource };
