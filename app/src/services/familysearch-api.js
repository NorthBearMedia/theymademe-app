const config = require('../config');
const oauth = require('./familysearch-oauth');

const API_BASE = config.FS_API_BASE;

async function apiRequest(path, options = {}) {
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
    throw new Error('FamilySearch rate limit exceeded — please wait and try again');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FamilySearch API error (${response.status}): ${text}`);
  }

  return response.json();
}

// Search for a person in the FamilySearch tree
async function searchPerson({ givenName, surname, birthDate, birthPlace, deathDate, deathPlace }) {
  const params = new URLSearchParams();
  if (givenName) params.set('q.givenName', givenName);
  if (surname) params.set('q.surname', surname);
  if (birthDate) params.set('q.birthLikeDate', birthDate);
  if (birthPlace) params.set('q.birthLikePlace', birthPlace);
  if (deathDate) params.set('q.deathLikeDate', deathDate);
  if (deathPlace) params.set('q.deathLikePlace', deathPlace);

  const data = await apiRequest(`/platform/tree/search?${params.toString()}`);

  if (!data.entries) return [];

  return data.entries.map(entry => {
    const person = entry.content?.gedcomx?.persons?.[0];
    if (!person) return null;

    const display = person.display || {};
    return {
      id: person.id,
      name: display.name || 'Unknown',
      gender: display.gender || 'Unknown',
      birthDate: display.birthDate || '',
      birthPlace: display.birthPlace || '',
      deathDate: display.deathDate || '',
      deathPlace: display.deathPlace || '',
      score: entry.score,
    };
  }).filter(Boolean);
}

// Get ancestry (pedigree) for a person
async function getAncestry(personId, generations = 4) {
  const data = await apiRequest(`/platform/tree/ancestry?person=${personId}&generations=${generations}`);

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
  const data = await apiRequest(`/platform/tree/persons/${personId}`);
  return data.persons?.[0] || null;
}

// Get sources for a person
async function getPersonSources(personId) {
  try {
    const data = await apiRequest(`/platform/tree/persons/${personId}/sources`);
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

// Run full research pipeline
async function runResearch(inputData, generations, db, jobId) {
  try {
    db.updateResearchJob(jobId, { status: 'running' });

    // Step 1: Search for the starting person
    const searchResults = await searchPerson({
      givenName: inputData.given_name,
      surname: inputData.surname,
      birthDate: inputData.birth_date,
      birthPlace: inputData.birth_place,
      deathDate: inputData.death_date,
      deathPlace: inputData.death_place,
    });

    if (searchResults.length === 0) {
      db.updateResearchJob(jobId, {
        status: 'failed',
        error_message: 'No matching person found in FamilySearch. Try adjusting the search details.',
      });
      return;
    }

    // Use best match
    const startPerson = searchResults[0];
    db.updateResearchJob(jobId, { person_id: startPerson.id });

    // Step 2: Get ancestry tree
    const ancestors = await getAncestry(startPerson.id, generations);

    // Step 3: For each ancestor, get sources (with rate limiting)
    db.deleteAncestors(jobId);
    for (const ancestor of ancestors) {
      // Brief delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 300));

      let sources = [];
      try {
        sources = await getPersonSources(ancestor.fs_person_id);
      } catch {
        // Sources are optional, don't fail the whole job
      }

      db.addAncestor({
        research_job_id: jobId,
        fs_person_id: ancestor.fs_person_id,
        name: ancestor.name,
        gender: ancestor.gender,
        birth_date: ancestor.birthDate,
        birth_place: ancestor.birthPlace,
        death_date: ancestor.deathDate,
        death_place: ancestor.deathPlace,
        ascendancy_number: ancestor.ascendancy_number,
        generation: ancestor.generation,
        confidence: ancestor.fs_person_id ? 'high' : 'low',
        sources,
        raw_data: ancestor.raw_data,
      });
    }

    // Step 4: Mark complete
    db.updateResearchJob(jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      results: { total_ancestors: ancestors.length, search_match: startPerson },
    });
  } catch (err) {
    db.updateResearchJob(jobId, {
      status: 'failed',
      error_message: err.message,
    });
  }
}

module.exports = { searchPerson, getAncestry, getPersonDetails, getPersonSources, runResearch };
