/**
 * They Made Me — Source Merger
 *
 * Merges search results from multiple sources and handles cross-source
 * deduplication and confidence boosting.
 *
 * Ported from Python merger.py.
 */

/**
 * Merge search results from multiple sources into a deduplicated list.
 * Candidates with similar names and birth years are merged.
 *
 * @param {Array} allResults - Array of result objects from different sources
 * @returns {Array} - Deduplicated merged results
 */
function mergeSearchResults(allResults) {
  const merged = new Map(); // key -> result

  for (const result of allResults) {
    const key = ancestorKey(result);

    if (merged.has(key)) {
      const existing = merged.get(key);
      // Merge: keep the one with more data, track both sources
      existing._sources = existing._sources || [existing._source || 'FamilySearch'];
      if (result._source && !existing._sources.includes(result._source)) {
        existing._sources.push(result._source);
      }
      // Fill gaps
      if (!existing.birthDate && result.birthDate) existing.birthDate = result.birthDate;
      if (!existing.birthPlace && result.birthPlace) existing.birthPlace = result.birthPlace;
      if (!existing.deathDate && result.deathDate) existing.deathDate = result.deathDate;
      if (!existing.deathPlace && result.deathPlace) existing.deathPlace = result.deathPlace;
      if (!existing.fatherName && result.fatherName) existing.fatherName = result.fatherName;
      if (!existing.motherName && result.motherName) existing.motherName = result.motherName;
      // Track all IDs
      existing._sourceIds = existing._sourceIds || { [existing._source || 'FamilySearch']: existing.id };
      if (result._source) existing._sourceIds[result._source] = result.id;
    } else {
      const fuzzyKey = findFuzzyMatch(result, merged);
      if (fuzzyKey) {
        const existing = merged.get(fuzzyKey);
        existing._sources = existing._sources || [existing._source || 'FamilySearch'];
        if (result._source && !existing._sources.includes(result._source)) {
          existing._sources.push(result._source);
        }
        existing._sourceIds = existing._sourceIds || { [existing._source || 'FamilySearch']: existing.id };
        if (result._source) existing._sourceIds[result._source] = result.id;
      } else {
        merged.set(key, { ...result, _sources: [result._source || 'FamilySearch'] });
      }
    }
  }

  return Array.from(merged.values());
}

/**
 * Create a deduplication key from a result.
 */
function ancestorKey(result) {
  const name = (result.name || '').toLowerCase().trim();
  const parts = name.split(/\s+/);
  const first = parts[0] || '';
  const last = parts[parts.length - 1] || '';
  const year = extractYear(result.birthDate) || '?';
  return `${first}|${last}|${year}`;
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Find a fuzzy match in the existing merged set.
 */
function findFuzzyMatch(result, merged) {
  const rName = (result.name || '').toLowerCase().trim().split(/\s+/);
  const rFirst = rName[0] || '';
  const rLast = rName[rName.length - 1] || '';
  const rYear = extractYear(result.birthDate);

  for (const [key, existing] of merged) {
    const eName = (existing.name || '').toLowerCase().trim().split(/\s+/);
    const eFirst = eName[0] || '';
    const eLast = eName[eName.length - 1] || '';
    const eYear = extractYear(existing.birthDate);

    if (nameSimilar(rFirst, eFirst) && nameSimilar(rLast, eLast)) {
      if (rYear && eYear && Math.abs(rYear - eYear) <= 3) return key;
      if (!rYear || !eYear) return key;
    }
  }

  return null;
}

/**
 * Check if two names are similar (exact, prefix, or first-3-chars).
 */
function nameSimilar(a, b) {
  if (!a || !b) return false;
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (a.length >= 3 && b.length >= 3 && a.substring(0, 3) === b.substring(0, 3)) return true;
  return false;
}

/**
 * Calculate multi-source confidence bonus.
 * Returns bonus points to add to confidence score.
 */
function multiSourceBonus(sources) {
  if (!sources || sources.length <= 1) return 0;
  // +10 for being found in 2 sources, +15 for 3+
  return sources.length >= 3 ? 15 : 10;
}

module.exports = { mergeSearchResults, ancestorKey, nameSimilar, multiSourceBonus };
