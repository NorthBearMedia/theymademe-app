const config = require('../config');
const oauth = require('./familysearch-oauth');

const API_BASE = config.FS_API_BASE;

// Rate limiting — enforce minimum 300ms between API calls
let lastRequestTime = 0;

async function apiRequest(path, options = {}, retryCount = 0) {
  // Use ensureToken() to auto-obtain unauthenticated token if needed
  let tokenData = oauth.getStoredToken();
  if (!tokenData) {
    tokenData = await oauth.ensureToken();
  }
  if (!tokenData) throw new Error('FamilySearch not connected — please authenticate first');

  // Search endpoints use Atom format, everything else uses GEDCOM X
  const accept = path.includes('/search')
    ? 'application/x-gedcomx-atom+json'
    : 'application/x-gedcomx-v1+json';

  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Accept': accept,
      'Authorization': `Bearer ${tokenData.access_token}`,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    // For search endpoints: try refreshing token once
    if (path.includes('/search') && retryCount === 0) {
      const newToken = await oauth.obtainUnauthenticatedToken();
      if (newToken) {
        return apiRequest(path, options, retryCount + 1);
      }
    }
    // For tree endpoints (getParents, getPersonDetails, etc.):
    // Don't clear the token — it may still work for search.
    // Instead, throw a specific error the engine can catch.
    const isTreeEndpoint = path.includes('/parents') || path.includes('/spouses') ||
      (path.includes('/persons/') && !path.includes('/search'));
    if (isTreeEndpoint) {
      throw new Error('FamilySearch tree access requires authenticated token — search still available');
    }
    // For other 401s, clear and fail
    oauth.clearToken();
    throw new Error('FamilySearch token expired — please reconnect');
  }

  if (response.status === 429) {
    if (retryCount < 3) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '2', 10);
      const delay = retryAfter * 1000 * Math.pow(2, retryCount);
      console.log(`Rate limited, retrying in ${delay}ms (attempt ${retryCount + 1}/3)`);
      await new Promise(r => setTimeout(r, delay));
      return apiRequest(path, options, retryCount + 1);
    }
    throw new Error('FamilySearch rate limit exceeded after 3 retries');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FamilySearch API error (${response.status}): ${text}`);
  }

  // Handle 204 No Content (e.g. parents endpoint when no parents exist)
  if (response.status === 204) {
    return {};
  }

  return response.json();
}

// Rate-limited wrapper — all public functions should use this
async function rateLimitedApiRequest(path, options = {}) {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < 300) {
    await new Promise(r => setTimeout(r, 300 - elapsed));
  }
  lastRequestTime = Date.now();
  return apiRequest(path, options);
}

// Extract a 4-digit year from various date formats (e.g. "01 January 1931", "1931", "13.07.1936")
// FS birthLikeDate/deathLikeDate only accepts year format, not full dates
function extractYear(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/\b(\d{4})\b/);
  return m ? m[1] : '';
}

// Shared parser for FamilySearch Atom search feeds (tree search, record search,
// person matches). Entries carry GEDCOM X persons + relationships.
function parseAtomEntries(data) {
  if (!data || !data.entries) return [];
  return data.entries.map(entry => {
    const person = entry.content?.gedcomx?.persons?.[0];
    if (!person) return null;

    const display = person.display || {};

    // Extract parent names from the GEDCOM X response if available
    const allPersons = entry.content?.gedcomx?.persons || [];
    const relationships = entry.content?.gedcomx?.relationships?.filter(r =>
      r.type === 'http://gedcomx.org/ParentChild'
    ) || [];

    // Build a person map for parent name lookup
    const personMap = {};
    for (const p of allPersons) {
      personMap[p.id] = p;
    }

    let fatherName = '';
    let motherName = '';
    let fatherBirthDate = '';
    let motherBirthDate = '';
    let fatherBirthPlace = '';
    let motherBirthPlace = '';
    let fatherDeathDate = '';
    let motherDeathDate = '';
    let fatherDeathPlace = '';
    let motherDeathPlace = '';
    let fatherId = '';
    let motherId = '';

    for (const rel of relationships) {
      // The person in the search result is the child
      if (rel.person2?.resourceId === person.id || rel.person2?.resource?.includes(person.id)) {
        const parentId = rel.person1?.resourceId;
        if (parentId && personMap[parentId]) {
          const parentPerson = personMap[parentId];
          const parentDisplay = parentPerson.display || {};
          const parentGender = (parentDisplay.gender || '').toLowerCase();
          if (parentGender === 'male') {
            fatherName = parentDisplay.name || '';
            fatherBirthDate = parentDisplay.birthDate || '';
            fatherBirthPlace = parentDisplay.birthPlace || '';
            fatherDeathDate = parentDisplay.deathDate || '';
            fatherDeathPlace = parentDisplay.deathPlace || '';
            fatherId = parentId;
          } else if (parentGender === 'female') {
            motherName = parentDisplay.name || '';
            motherBirthDate = parentDisplay.birthDate || '';
            motherBirthPlace = parentDisplay.birthPlace || '';
            motherDeathDate = parentDisplay.deathDate || '';
            motherDeathPlace = parentDisplay.deathPlace || '';
            motherId = parentId;
          }
        }
      }
    }

    return {
      id: person.id,
      // Record/match entries carry a title (e.g. the collection) and source
      // descriptions — used to classify record hints without displaying them.
      entryTitle: (typeof entry.title === 'string' ? entry.title : '') || '',
      sourceTitles: (entry.content?.gedcomx?.sourceDescriptions || [])
        .map(sd => sd.titles?.[0]?.value).filter(Boolean),
      name: display.name || 'Unknown',
      gender: display.gender || 'Unknown',
      birthDate: display.birthDate || '',
      birthPlace: display.birthPlace || '',
      deathDate: display.deathDate || '',
      deathPlace: display.deathPlace || '',
      score: entry.score,
      fatherName,
      motherName,
      // Extended parent data — used for search-based parent discovery
      parentData: {
        father: fatherName ? {
          id: fatherId,
          name: fatherName,
          gender: 'Male',
          birthDate: fatherBirthDate,
          birthPlace: fatherBirthPlace,
          deathDate: fatherDeathDate,
          deathPlace: fatherDeathPlace,
        } : null,
        mother: motherName ? {
          id: motherId,
          name: motherName,
          gender: 'Female',
          birthDate: motherBirthDate,
          birthPlace: motherBirthPlace,
          deathDate: motherDeathDate,
          deathPlace: motherDeathPlace,
        } : null,
      },
      // Full data for scoring
      facts: person.facts || [],
      names: person.names || [],
      display,
      raw: person,
    };
  }).filter(Boolean);
}

// Search for a person in the FamilySearch tree
// Returns full GEDCOM X person data for scoring, not just display fields
async function searchPerson({
  givenName, surname, birthDate, birthPlace, deathDate, deathPlace,
  fatherGivenName, fatherSurname, motherGivenName, motherSurname,
  count
}) {
  const params = new URLSearchParams();
  if (givenName) params.set('q.givenName', givenName);
  if (surname) params.set('q.surname', surname);
  const birthYear = extractYear(birthDate);
  if (birthYear) params.set('q.birthLikeDate', birthYear);
  if (birthPlace) params.set('q.birthLikePlace', birthPlace);
  const deathYear = extractYear(deathDate);
  if (deathYear) params.set('q.deathLikeDate', deathYear);
  if (deathPlace) params.set('q.deathLikePlace', deathPlace);
  if (fatherGivenName) params.set('q.fatherGivenName', fatherGivenName);
  if (fatherSurname) params.set('q.fatherSurname', fatherSurname);
  if (motherGivenName) params.set('q.motherGivenName', motherGivenName);
  if (motherSurname) params.set('q.motherSurname', motherSurname);
  if (count) params.set('count', count);

  const data = await rateLimitedApiRequest(`/platform/tree/search?${params.toString()}`);

  return parseAtomEntries(data);
}

// Get parents for a person — replaces getAncestry() for tree traversal
async function getParents(personId) {
  try {
    const data = await rateLimitedApiRequest(`/platform/tree/persons/${personId}/parents`);

    // Build a person map from the response
    const personMap = {};
    if (data.persons) {
      for (const p of data.persons) {
        personMap[p.id] = p;
      }
    }

    let father = null;
    let mother = null;

    // Parse childAndParentsRelationships
    // API may use either father/mother OR parent1/parent2 keys
    const relationships = data.childAndParentsRelationships || [];
    if (relationships.length > 0) {
      // Prefer biological parent relationship, fall back to first
      const rel = relationships.find(r =>
        !r.type || r.type.includes('Biological') || r.type.includes('Birth')
      ) || relationships[0];

      // Collect parent IDs from either format
      const parentIds = [];
      if (rel.father?.resourceId) parentIds.push(rel.father.resourceId);
      if (rel.mother?.resourceId) parentIds.push(rel.mother.resourceId);
      if (rel.parent1?.resourceId) parentIds.push(rel.parent1.resourceId);
      if (rel.parent2?.resourceId) parentIds.push(rel.parent2.resourceId);

      // Deduplicate and assign by gender
      for (const pid of [...new Set(parentIds)]) {
        const person = personMap[pid];
        if (!person) continue;
        const d = person.display || {};
        const genderType = person.gender?.type || '';
        const isMale = (d.gender || '').toLowerCase() === 'male' || genderType.includes('Male');
        const isFemale = (d.gender || '').toLowerCase() === 'female' || genderType.includes('Female');
        const parentData = {
          id: person.id,
          name: d.name || 'Unknown',
          gender: d.gender || (isMale ? 'Male' : isFemale ? 'Female' : 'Unknown'),
          birthDate: d.birthDate || '',
          birthPlace: d.birthPlace || '',
          deathDate: d.deathDate || '',
          deathPlace: d.deathPlace || '',
          facts: person.facts || [],
          raw: person,
        };
        if (isMale && !father) {
          father = parentData;
        } else if (isFemale && !mother) {
          mother = parentData;
        } else if (!father) {
          father = parentData; // fallback: first unknown goes to father
        } else if (!mother) {
          mother = parentData; // second unknown goes to mother
        }
      }
    }

    return { father, mother };
  } catch (err) {
    // Parents endpoint may 404 if no parents are recorded
    if (err.message.includes('404')) {
      return { father: null, mother: null };
    }
    throw err;
  }
}

// Get spouses for a person — returns array of spouse info objects
// Useful for marriage record triangulation (finding mother via father's spouse)
async function getSpouses(personId) {
  try {
    const data = await rateLimitedApiRequest(`/platform/tree/persons/${personId}/spouses`);

    // Build a person map from the response
    const personMap = {};
    if (data.persons) {
      for (const p of data.persons) {
        personMap[p.id] = p;
      }
    }

    const spouses = [];

    // Parse couple relationships
    const relationships = data.childAndParentsRelationships || data.relationships || [];
    // Also check for direct couple relationships
    const coupleRels = (data.relationships || []).filter(r =>
      r.type === 'http://gedcomx.org/Couple'
    );

    for (const rel of coupleRels) {
      // Find the spouse (the person that isn't our input person)
      const person1Id = rel.person1?.resourceId;
      const person2Id = rel.person2?.resourceId;
      const spouseId = person1Id === personId ? person2Id : person1Id;

      if (spouseId && personMap[spouseId]) {
        const person = personMap[spouseId];
        const d = person.display || {};
        spouses.push({
          id: person.id,
          name: d.name || 'Unknown',
          gender: d.gender || 'Unknown',
          birthDate: d.birthDate || '',
          birthPlace: d.birthPlace || '',
          deathDate: d.deathDate || '',
          deathPlace: d.deathPlace || '',
          facts: person.facts || [],
          raw: person,
          // Extract marriage facts from the relationship
          marriageFacts: (rel.facts || []).map(f => ({
            type: f.type || '',
            date: f.date?.original || '',
            place: f.place?.original || '',
          })),
        });
      }
    }

    return spouses;
  } catch (err) {
    // Spouses endpoint may 404 if no spouses are recorded
    if (err.message.includes('404')) {
      return [];
    }
    throw err;
  }
}

// Get detailed person information
async function getPersonDetails(personId) {
  const data = await rateLimitedApiRequest(`/platform/tree/persons/${personId}`);
  return data.persons?.[0] || null;
}

// Get sources for a person
async function getPersonSources(personId) {
  try {
    const data = await rateLimitedApiRequest(`/platform/tree/persons/${personId}/sources`);

    // GEDCOM X sources endpoint returns sourceDescriptions at top level
    const descriptions = data.sourceDescriptions || [];

    // Also check persons[0].sources which references sourceDescriptions
    const personSources = data.persons?.[0]?.sources || [];

    // Build a map of source description IDs
    const descMap = {};
    for (const desc of descriptions) {
      descMap[desc.id] = desc;
    }

    // If we have person source references, use those to find descriptions
    if (personSources.length > 0 && descriptions.length > 0) {
      return personSources.map(ref => {
        // The reference points to a sourceDescription via description or descriptionId
        // description is typically a URI like "#SD-123" or "https://...#SD-123"
        let descId = ref.descriptionId || '';
        if (!descId && ref.description) {
          // Extract the fragment ID from the URI
          const hashIdx = ref.description.lastIndexOf('#');
          descId = hashIdx >= 0 ? ref.description.substring(hashIdx + 1) : ref.description;
        }
        const desc = descMap[descId] || {};
        return {
          title: desc.titles?.[0]?.value || desc.about || descId || 'Unknown source',
          url: desc.about || '',
          citation: desc.citations?.[0]?.value || '',
        };
      });
    }

    // Fallback: use sourceDescriptions directly
    if (descriptions.length > 0) {
      return descriptions.map(desc => ({
        title: desc.titles?.[0]?.value || desc.about || 'Unknown source',
        url: desc.about || '',
        citation: desc.citations?.[0]?.value || '',
      }));
    }

    return [];
  } catch (err) {
    // Re-throw auth errors so callers can detect auth-unavailable state
    if (err.message && (err.message.includes('authenticated token') || err.message.includes('401'))) {
      throw err;
    }
    return [];
  }
}

// Extract facts by type from a person's GEDCOM X record
// Returns categorized facts useful for evidence triangulation
async function extractFactsByType(personId) {
  const result = { census: [], birth: [], marriage: [], death: [], residence: [], baptism: [], burial: [], other: [] };
  try {
    const person = await getPersonDetails(personId);
    if (!person || !person.facts) return result;

    for (const fact of person.facts) {
      const type = (fact.type || '').toLowerCase();
      const entry = {
        type: fact.type || '',
        date: fact.date?.original || '',
        formalDate: fact.date?.formal || '',
        place: fact.place?.original || '',
        value: fact.value || '',
        qualifiers: (fact.qualifiers || []).map(q => ({ name: q.name, value: q.value })),
      };

      // Parse year from date for convenience
      const yearMatch = entry.date.match(/(\d{4})/);
      if (yearMatch) entry.year = parseInt(yearMatch[1], 10);

      if (type.includes('census')) result.census.push(entry);
      else if (type.includes('birth') || type.includes('christening')) result.birth.push(entry);
      else if (type.includes('marriage')) result.marriage.push(entry);
      else if (type.includes('death')) result.death.push(entry);
      else if (type.includes('residence')) result.residence.push(entry);
      else if (type.includes('baptism')) result.baptism.push(entry);
      else if (type.includes('burial')) result.burial.push(entry);
      else result.other.push(entry);
    }
  } catch (err) {
    console.log(`[FS] extractFactsByType error for ${personId}: ${err.message}`);
  }
  return result;
}


// ─── Pedigree: several generations in ONE call ───────────────────────────
// Recovered from the engine's earlier working implementation (git 7e32d9c^).
// FamilySearch's Read Ancestry endpoint returns the whole pedigree with
// display.ascendancyNumber on every person (1 = the root, father = 2n,
// mother = 2n+1) — one request instead of one getParents() per person.
async function getAncestry(personId, generations = 4) {
  const data = await rateLimitedApiRequest(`/platform/tree/ancestry?person=${encodeURIComponent(personId)}&generations=${generations}`);

  if (!data.persons) return [];

  return data.persons.map(person => {
    const display = person.display || {};
    const ascNum = person.display?.ascendancyNumber;

    // Extract dates/places — try display fields first, then facts, then lifespan
    let birthDate = display.birthDate || '';
    let birthPlace = display.birthPlace || '';
    let deathDate = display.deathDate || '';
    let deathPlace = display.deathPlace || '';

    if (person.facts) {
      for (const fact of person.facts) {
        const type = (fact.type || '').toLowerCase();
        const dateStr = fact.date?.original || '';
        const placeStr = fact.place?.original || '';
        if (type.includes('birth') || type.includes('christening')) {
          if (!birthDate && dateStr) birthDate = dateStr;
          if (!birthPlace && placeStr) birthPlace = placeStr;
        }
        if (type.includes('death') || type.includes('burial')) {
          if (!deathDate && dateStr) deathDate = dateStr;
          if (!deathPlace && placeStr) deathPlace = placeStr;
        }
      }
    }

    // Parse lifespan (e.g. "1875-1958", "1875-", "-1958") for missing dates
    if (display.lifespan && (!birthDate || !deathDate)) {
      const lifespanMatch = display.lifespan.match(/^(\d{4})?\s*[-–]\s*(\d{4})?$/);
      if (lifespanMatch) {
        if (!birthDate && lifespanMatch[1]) birthDate = lifespanMatch[1];
        if (!deathDate && lifespanMatch[2]) deathDate = lifespanMatch[2];
      }
    }

    const asc = ascNum ? parseInt(ascNum, 10) : null;
    return {
      id: person.id,
      fs_person_id: person.id,
      name: display.name || 'Unknown',
      gender: display.gender || 'Unknown',
      birthDate, birthPlace, deathDate, deathPlace,
      ascendancy_number: asc,
      generation: asc ? Math.floor(Math.log2(asc)) : 0,
      facts: person.facts || [],
      raw: person,
    };
  });
}

// ─── Historical RECORDS search (census, civil index, parish …) ────────────
// The record archive is a separate pile from the tree and is where most of
// FamilySearch's billions of UK records live. Same query vocabulary as tree
// search (q.givenName, q.surname, q.birthLikeDate …) plus record metadata
// filters (q.recordCountry, q.collectionId …).
// UNVERIFIED against the live API: sources disagree on the path
// (/platform/search/records vs /platform/records/personas), so it is
// configurable (FS_RECORDS_SEARCH_PATH). Needs a key that includes Records.
async function searchRecords({
  givenName, surname, birthDate, birthPlace, deathDate, deathPlace,
  recordCountry, collectionId, count,
}) {
  const params = new URLSearchParams();
  if (givenName) params.set('q.givenName', givenName);
  if (surname) params.set('q.surname', surname);
  const birthYear = extractYear(birthDate);
  if (birthYear) params.set('q.birthLikeDate', birthYear);
  if (birthPlace) params.set('q.birthLikePlace', birthPlace);
  const deathYear = extractYear(deathDate);
  if (deathYear) params.set('q.deathLikeDate', deathYear);
  if (deathPlace) params.set('q.deathLikePlace', deathPlace);
  if (recordCountry) params.set('q.recordCountry', recordCountry);
  if (collectionId) params.set('q.collectionId', collectionId);
  if (count) params.set('count', count);

  const data = await rateLimitedApiRequest(`${config.FS_RECORDS_SEARCH_PATH}?${params.toString()}`);
  return parseAtomEntries(data);
}

// ─── Person matches / hints (tree person → records & other tree persons) ──
// "Read Person Matches by ID": FamilySearch's own matcher. For a tree person
// it returns record hints from the historical records archive. Usage and
// display of that data is restricted by FamilySearch's terms (records data
// may only be DISPLAYED by FamilySearch products) — keep it internal.
async function getPersonMatches(personId) {
  const data = await rateLimitedApiRequest(`/platform/tree/persons/${encodeURIComponent(personId)}/matches`);
  return parseAtomEntries(data);
}

module.exports = {
  searchPerson,
  getAncestry,
  searchRecords,
  getPersonMatches,
  parseAtomEntries,
  getParents,
  getSpouses,
  getPersonDetails,
  getPersonSources,
  extractFactsByType,
  rateLimitedApiRequest,
};
