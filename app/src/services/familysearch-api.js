const config = require('../config');
const oauth = require('./familysearch-oauth');

const API_BASE = config.FS_API_BASE;

// Rate limiting — enforce minimum 300ms between API calls
let lastRequestTime = 0;

async function apiRequest(path, options = {}, retryCount = 0) {
  const tokenData = oauth.getStoredToken();
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
  if (birthDate) params.set('q.birthLikeDate', birthDate);
  if (birthPlace) params.set('q.birthLikePlace', birthPlace);
  if (deathDate) params.set('q.deathLikeDate', deathDate);
  if (deathPlace) params.set('q.deathLikePlace', deathPlace);
  if (fatherGivenName) params.set('q.fatherGivenName', fatherGivenName);
  if (fatherSurname) params.set('q.fatherSurname', fatherSurname);
  if (motherGivenName) params.set('q.motherGivenName', motherGivenName);
  if (motherSurname) params.set('q.motherSurname', motherSurname);
  if (count) params.set('count', count);

  const data = await rateLimitedApiRequest(`/platform/tree/search?${params.toString()}`);

  if (!data.entries) return [];

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
    for (const rel of relationships) {
      // The person in the search result is the child
      if (rel.person2?.resourceId === person.id || rel.person2?.resource?.includes(person.id)) {
        const parentId = rel.person1?.resourceId;
        if (parentId && personMap[parentId]) {
          const parentDisplay = personMap[parentId].display || {};
          const parentGender = (parentDisplay.gender || '').toLowerCase();
          if (parentGender === 'male') {
            fatherName = parentDisplay.name || '';
          } else if (parentGender === 'female') {
            motherName = parentDisplay.name || '';
          }
        }
      }
    }

    return {
      id: person.id,
      name: display.name || 'Unknown',
      gender: display.gender || 'Unknown',
      birthDate: display.birthDate || '',
      birthPlace: display.birthPlace || '',
      deathDate: display.deathDate || '',
      deathPlace: display.deathPlace || '',
      score: entry.score,
      fatherName,
      motherName,
      // Full data for scoring
      facts: person.facts || [],
      names: person.names || [],
      display,
      raw: person,
    };
  }).filter(Boolean);
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
    const relationships = data.childAndParentsRelationships || [];
    if (relationships.length > 0) {
      // Prefer biological parent relationship, fall back to first
      const rel = relationships.find(r =>
        !r.type || r.type.includes('Biological') || r.type.includes('Birth')
      ) || relationships[0];

      if (rel.father?.resourceId) {
        const fatherPerson = personMap[rel.father.resourceId];
        if (fatherPerson) {
          const d = fatherPerson.display || {};
          father = {
            id: fatherPerson.id,
            name: d.name || 'Unknown',
            gender: d.gender || 'Male',
            birthDate: d.birthDate || '',
            birthPlace: d.birthPlace || '',
            deathDate: d.deathDate || '',
            deathPlace: d.deathPlace || '',
            facts: fatherPerson.facts || [],
            raw: fatherPerson,
          };
        }
      }

      if (rel.mother?.resourceId) {
        const motherPerson = personMap[rel.mother.resourceId];
        if (motherPerson) {
          const d = motherPerson.display || {};
          mother = {
            id: motherPerson.id,
            name: d.name || 'Unknown',
            gender: d.gender || 'Female',
            birthDate: d.birthDate || '',
            birthPlace: d.birthPlace || '',
            deathDate: d.deathDate || '',
            deathPlace: d.deathPlace || '',
            facts: motherPerson.facts || [],
            raw: motherPerson,
          };
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

// Get ancestry (pedigree) for a person — DEPRECATED, kept for backward compatibility
async function getAncestry(personId, generations = 4) {
  const data = await rateLimitedApiRequest(`/platform/tree/ancestry?person=${personId}&generations=${generations}`);

  if (!data.persons) return [];

  return data.persons.map(person => {
    const display = person.display || {};
    const ascNum = person.display?.ascendancyNumber;

    // Extract dates/places — try display fields first, then facts, then lifespan
    let birthDate = display.birthDate || '';
    let birthPlace = display.birthPlace || '';
    let deathDate = display.deathDate || '';
    let deathPlace = display.deathPlace || '';

    // Extract from facts if available
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

    return {
      fs_person_id: person.id,
      name: display.name || 'Unknown',
      gender: display.gender || 'Unknown',
      birthDate,
      birthPlace,
      deathDate,
      deathPlace,
      ascendancy_number: ascNum ? parseInt(ascNum, 10) : null,
      generation: ascNum ? Math.floor(Math.log2(parseInt(ascNum, 10))) : 0,
      raw_data: person,
    };
  });
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
  } catch {
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

module.exports = {
  searchPerson,
  getParents,
  getAncestry,
  getPersonDetails,
  getPersonSources,
  extractFactsByType,
  rateLimitedApiRequest,
};
