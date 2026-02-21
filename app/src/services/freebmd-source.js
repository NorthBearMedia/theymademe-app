/**
 * They Made Me — FreeBMD Source Adapter
 *
 * Wraps freebmd-client.js with the ResearchSource interface.
 * FreeBMD is CONFIRMATION-only — it has no tree data or person search.
 * Used to confirm births, deaths, and marriages found by other sources.
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
    return [SOURCE_CAPABILITIES.CONFIRMATION];
  }

  isAvailable() {
    return true; // No auth needed — always available
  }

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
