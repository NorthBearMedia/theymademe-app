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

  // Wikidata (CC0) — open corroboration for notable people; no auth needed.
  // Registered even when absent on disk: the engine only uses it if isAvailable().
  try {
    const { WikidataSource } = require('./wikidata-source');
    sources.push(new WikidataSource());
  } catch (err) {
    // Wikidata adapter not installed — skip silently
  }

  // FreeBMD — registered, but isAvailable() stays false unless FREEBMD_ENABLED=true
  // (FreeBMD's terms require written permission for automated use).
  try {
    const { FreeBMDSource } = require('./freebmd-source');
    sources.push(new FreeBMDSource());
  } catch (err) {
    // FreeBMD not yet installed — skip silently
  }

  return sources;
}

module.exports = { buildSourceRegistry };
