/**
 * They Made Me — Source Registry
 *
 * Builds the list of available research sources.
 * Called at research job start time so sources reflect current connection state.
 */

const { FamilySearchSource } = require('./familysearch-source');

function buildSourceRegistry() {
  const sources = [];

  // FamilySearch — always registered, isAvailable() checks token
  sources.push(new FamilySearchSource());

  // Geni — only if module exists and configured
  try {
    const { GeniSource } = require('./geni-source');
    sources.push(new GeniSource());
  } catch (err) {
    // Geni not yet installed or configured — skip silently
  }

  // FreeBMD — always available, no auth needed
  try {
    const { FreeBMDSource } = require('./freebmd-source');
    sources.push(new FreeBMDSource());
  } catch (err) {
    // FreeBMD not yet installed — skip silently
  }

  return sources;
}

module.exports = { buildSourceRegistry };
