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
    return {
      fs_person_id: person.id,
      name: display.name || 'Unknown',
      gender: display.gender || 'Unknown',
      birthDate: display.birthDate || '',
      birthPlace: display.birthPlace || '',
      deathDate: display.deathDate || '',
      deathPlace: display.deathPlace || '',
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
    if (!data.persons?.[0]?.sources) return [];

    return data.persons[0].sources.map(source => ({
      title: source.description?.titles?.[0]?.value || source.about || 'Unknown source',
      url: source.about || '',
      citation: source.description?.citations?.[0]?.value || '',
    }));
  } catch {
    return [];
  }
}

module.exports = {
  searchPerson,
  getParents,
  getAncestry,
  getPersonDetails,
  getPersonSources,
  rateLimitedApiRequest,
};
