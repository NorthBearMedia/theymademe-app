/**
 * They Made Me — Geni.com API Client
 *
 * Searches Geni's World Family Tree (~180M profiles). Requires OAuth2 user token.
 *
 * API docs: https://www.geni.com/platform/developer/help
 * Endpoint: https://www.geni.com/api
 * Rate limit: 40 requests per 10 seconds (unapproved apps)
 *
 * Ported from Python geni.py with identical logic.
 */

const config = require('../config');
const geniOauth = require('./geni-oauth');

const API_URL = config.GENI_API_URL || 'https://www.geni.com/api';

// ─── Rate Limiting ───────────────────────────────────────────────────
// Conservative rate limiting — new/unapproved apps may have lower limits
// Start at 10 req per 10s (1 per second) to avoid WAF/Incapsula blocks
const RATE_WINDOW = 10000;       // 10 seconds in ms
const RATE_MAX_REQUESTS = 10;    // conservative for unapproved apps
const RATE_429_BACKOFF = 15000;  // 15 seconds on 429
const RATE_MAX_RETRIES = 3;
const MIN_REQUEST_INTERVAL = 1000; // minimum 1 second between requests

const requestTimes = [];         // timestamps of recent requests
let rateRemaining = null;        // from X-API-Rate-Remaining header

async function rateLimit() {
  const now = Date.now();

  // Prune requests older than the window
  while (requestTimes.length && (now - requestTimes[0]) > RATE_WINDOW) {
    requestTimes.shift();
  }

  // Enforce minimum interval between requests
  if (requestTimes.length > 0) {
    const lastReq = requestTimes[requestTimes.length - 1];
    const elapsed = now - lastReq;
    if (elapsed < MIN_REQUEST_INTERVAL) {
      await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - elapsed));
    }
  }

  // If at limit, wait for oldest to expire
  if (requestTimes.length >= RATE_MAX_REQUESTS) {
    const oldest = requestTimes[0];
    const wait = RATE_WINDOW - (Date.now() - oldest) + 200; // 200ms safety
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // Slow down if API says we're getting low
  if (rateRemaining !== null && rateRemaining <= 5) {
    await new Promise(r => setTimeout(r, 1500));
  }

  requestTimes.push(Date.now());
}

function updateRateInfo(headers) {
  const remaining = headers.get('X-API-Rate-Remaining');
  if (remaining !== null) {
    try { rateRemaining = parseInt(remaining, 10); } catch (e) { /* ignore */ }
  }
}

// ─── Core API Request ────────────────────────────────────────────────

async function apiGet(path, params = {}, retryAuth = true, retryCount = 0) {
  const tokenData = geniOauth.getStoredToken();
  if (!tokenData) {
    console.log('[Geni] No access token available');
    return {};
  }

  await rateLimit();

  const url = path.startsWith('http') ? path : `${API_URL}/${path}`;
  const searchParams = new URLSearchParams({ access_token: tokenData.access_token, ...params });
  const fullUrl = `${url}?${searchParams.toString()}`;

  try {
    const response = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'TheyMadeMe/1.0 (genealogy research tool)',
      },
      signal: AbortSignal.timeout(30000),
    });

    updateRateInfo(response.headers);

    // 401 — try refreshing token once
    if (response.status === 401 && retryAuth) {
      console.log('[Geni] 401 received, attempting token refresh...');
      const refreshed = await geniOauth.refreshAccessToken();
      if (refreshed) {
        return apiGet(path, params, false, retryCount);
      }
      console.error('[Geni] Token refresh failed');
      return {};
    }

    // 429 — rate limited, backoff and retry
    if (response.status === 429 && retryCount < RATE_MAX_RETRIES) {
      requestTimes.length = 0;
      rateRemaining = 0;
      const wait = RATE_429_BACKOFF * (retryCount + 1);
      console.log(`[Geni] 429 rate limited, waiting ${wait}ms (retry ${retryCount + 1}/${RATE_MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, wait));
      return apiGet(path, params, retryAuth, retryCount + 1);
    }

    if (response.status === 429) {
      console.warn('[Geni] 429 exhausted after retries');
      return {};
    }

    // 403 — profile not in Big Tree
    if (response.status === 403) {
      console.log(`[Geni] 403 for ${path} (may not be in Big Tree)`);
      return {};
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Geni] API error ${response.status}: ${text.substring(0, 200)}`);
      return {};
    }

    // Guard against HTML responses (CDN/proxy errors, captchas, etc.)
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      const text = await response.text();
      console.warn(`[Geni] Non-JSON response (${contentType}): ${text.substring(0, 150)}`);
      return {};
    }

    return await response.json();
  } catch (err) {
    console.error(`[Geni] Request error (${path}):`, err.message);
    return {};
  }
}

// ─── Profile Parsing ─────────────────────────────────────────────────

function extractNodeId(ref) {
  if (!ref) return '';
  ref = String(ref);
  if (ref.includes('/')) return ref.replace(/\/$/, '').split('/').pop();
  return ref;
}

function extractYearFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const dateVal = event.date;
  if (!dateVal) return null;

  if (typeof dateVal === 'object') {
    const year = dateVal.year;
    if (year && typeof year === 'number' && year >= 1000 && year <= 2100) return year;
  } else if (typeof dateVal === 'string') {
    const m = String(dateVal).match(/(\d{4})/);
    if (m) {
      const year = parseInt(m[1], 10);
      if (year >= 1000 && year <= 2100) return year;
    }
  }
  return null;
}

function extractPlaceFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const location = event.location;
  if (!location) return '';
  if (typeof location === 'object') {
    const parts = [];
    for (const key of ['city', 'state', 'country']) {
      if (location[key] && !parts.includes(location[key])) parts.push(location[key]);
    }
    return parts.join(', ');
  }
  return typeof location === 'string' ? location : '';
}

function extractDateStr(event) {
  if (!event || typeof event !== 'object') return '';
  const dateVal = event.date;
  if (!dateVal) return '';
  if (typeof dateVal === 'object') {
    const { year, month, day } = dateVal;
    if (day && month && year) return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    if (month && year) return `${String(month).padStart(2, '0')}/${year}`;
    if (year) return String(year);
    return '';
  }
  return typeof dateVal === 'string' ? dateVal : '';
}

function parseGender(raw) {
  if (!raw) return '';
  const g = String(raw).trim().toLowerCase();
  if (g === 'male' || g === 'm') return 'Male';
  if (g === 'female' || g === 'f') return 'Female';
  return g.charAt(0).toUpperCase() + g.slice(1);
}

function parseProfile(data) {
  return {
    sourceId: String(data.id || ''),
    source: 'Geni',
    firstName: data.first_name || '',
    middleName: data.middle_name || '',
    lastName: data.last_name || '',
    maidenName: data.maiden_name || '',
    birthDate: extractDateStr(data.birth),
    birthYear: extractYearFromEvent(data.birth),
    deathDate: extractDateStr(data.death),
    deathYear: extractYearFromEvent(data.death),
    birthPlace: extractPlaceFromEvent(data.birth),
    deathPlace: extractPlaceFromEvent(data.death),
    gender: parseGender(data.gender),
    fatherId: '',
    motherId: '',
    raw: data,
  };
}

// ─── Parent Map Builder ──────────────────────────────────────────────

function buildParentMap(unions, profiles) {
  const parentMap = {};

  for (const [unionId, union] of Object.entries(unions)) {
    if (!union || typeof union !== 'object') continue;

    let partnerIds = [];
    let childIds = [];

    // Try edges format (current Geni API)
    const edges = union.edges;
    if (edges && typeof edges === 'object') {
      for (const [edgeProfileId, edgeInfo] of Object.entries(edges)) {
        if (!edgeInfo || typeof edgeInfo !== 'object') continue;
        const rel = edgeInfo.rel || '';
        const nodeId = extractNodeId(edgeProfileId);
        if (rel === 'partner') partnerIds.push(nodeId);
        else if (rel === 'child') childIds.push(nodeId);
      }
    }

    // Fallback: partners/children arrays (older format)
    if (!partnerIds.length && !childIds.length) {
      partnerIds = (union.partners || []).filter(Boolean).map(extractNodeId);
      childIds = (union.children || []).filter(Boolean).map(extractNodeId);
    }

    if (!partnerIds.length || !childIds.length) continue;

    // Determine father/mother from partner genders
    let fatherId = null;
    let motherId = null;
    for (const pId of partnerIds) {
      const profile = profiles[pId] || {};
      const g = parseGender(profile.gender || '');
      if (g === 'Male' && !fatherId) fatherId = pId;
      else if (g === 'Female' && !motherId) motherId = pId;
    }

    // Link each child to parents
    for (const cId of childIds) {
      if (!parentMap[cId]) parentMap[cId] = {};
      if (fatherId) parentMap[cId].father = fatherId;
      if (motherId) parentMap[cId].mother = motherId;
    }
  }

  return parentMap;
}

// ─── Public API Functions ────────────────────────────────────────────

/**
 * Search Geni for a person by name and optional birth details.
 * Returns array of results in unified format (matching FS searchPerson output).
 */
async function searchPerson({ givenName, surname, birthDate, birthPlace }) {
  if (!geniOauth.getStoredToken()) return [];

  const names = [givenName, surname].filter(Boolean).join(' ');
  if (!names) return [];

  console.log(`[Geni] Search: ${names}, birth=${birthDate || '?'}, place=${birthPlace || '?'}`);

  const data = await apiGet('profile/search', { names });
  if (!data || Object.keys(data).length === 0) return [];

  // Geni quirk: single result returns bare object with "id" field, not an array
  let searchResults = data.results || [];
  if (!searchResults.length && data.id) {
    searchResults = [data];
  }
  // Handle dict-format results
  if (!Array.isArray(searchResults) && typeof searchResults === 'object') {
    searchResults = Object.values(searchResults);
  }

  const results = [];
  for (const item of searchResults.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue;

    const profile = parseProfile(item);
    const fullName = [profile.firstName, profile.middleName, profile.lastName]
      .filter(Boolean).join(' ') || profile.maidenName || 'Unknown';

    // Transform to unified candidate format (same as familysearch-api.js)
    results.push({
      id: profile.sourceId,
      name: fullName,
      gender: profile.gender || 'Unknown',
      birthDate: profile.birthDate || '',
      birthPlace: profile.birthPlace || '',
      deathDate: profile.deathDate || '',
      deathPlace: profile.deathPlace || '',
      score: 0, // Will be computed by the engine's evaluateCandidate()
      fatherName: '',
      motherName: '',
      facts: [],
      names: [],
      display: {
        name: fullName,
        gender: profile.gender,
        birthDate: profile.birthDate,
        birthPlace: profile.birthPlace,
        deathDate: profile.deathDate,
        deathPlace: profile.deathPlace,
      },
      raw: profile.raw,
      _source: 'Geni',
    });
  }

  console.log(`[Geni] Found ${results.length} results for ${names}`);
  return results;
}

/**
 * Get parents for a Geni profile using /immediate-family endpoint.
 * Returns { father, mother } in same format as fsApi.getParents().
 */
async function getParents(personId) {
  if (!geniOauth.getStoredToken()) return { father: null, mother: null };

  const pid = personId.startsWith('profile') ? personId : `profile-${personId}`;
  const data = await apiGet(`${pid}/immediate-family`);

  if (!data || !data.nodes) return { father: null, mother: null };

  const nodes = data.nodes || {};
  const focusRaw = data.focus;
  let focus = '';
  if (typeof focusRaw === 'string') focus = extractNodeId(focusRaw);
  else if (typeof focusRaw === 'object' && focusRaw) focus = String(focusRaw.id || '');

  // Separate profiles and unions
  const profiles = {};
  const unions = {};
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue;
    if (nodeId.startsWith('union-')) unions[nodeId] = node;
    else if (nodeId.startsWith('profile-')) profiles[nodeId] = node;
  }

  const parentMap = buildParentMap(unions, profiles);
  const links = parentMap[focus] || parentMap[pid] || parentMap[personId] || {};

  let father = null;
  let mother = null;

  if (links.father && profiles[links.father]) {
    const p = parseProfile(profiles[links.father]);
    const name = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');
    father = {
      id: p.sourceId,
      name: name || 'Unknown',
      gender: p.gender || 'Male',
      birthDate: p.birthDate,
      birthPlace: p.birthPlace,
      deathDate: p.deathDate,
      deathPlace: p.deathPlace,
      facts: [],
      raw: p.raw,
      _source: 'Geni',
    };
  }

  if (links.mother && profiles[links.mother]) {
    const p = parseProfile(profiles[links.mother]);
    const name = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');
    mother = {
      id: p.sourceId,
      name: name || 'Unknown',
      gender: p.gender || 'Female',
      birthDate: p.birthDate,
      birthPlace: p.birthPlace,
      deathDate: p.deathDate,
      deathPlace: p.deathPlace,
      facts: [],
      raw: p.raw,
      _source: 'Geni',
    };
  }

  return { father, mother };
}

/**
 * Get ancestors using /ancestors endpoint (full tree in one call, up to 20 gens).
 * Falls back to immediate-family BFS walk if /ancestors fails.
 */
async function getAncestors(personId, generations = 4) {
  if (!geniOauth.getStoredToken()) return [];

  const pid = personId.startsWith('profile') ? personId : `profile-${personId}`;
  const data = await apiGet(`${pid}/ancestors`, { generations });

  if (!data || data.error || !data.nodes) {
    return getAncestorsViaImmediateFamily(personId, generations);
  }

  const nodes = data.nodes || {};
  const profiles = {};
  const unions = {};

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue;
    if (nodeId.startsWith('union-')) unions[nodeId] = node;
    else if (nodeId.startsWith('profile-')) profiles[nodeId] = node;
  }

  const parentMap = buildParentMap(unions, profiles);
  const ancestors = [];

  for (const [nodeId, profile] of Object.entries(profiles)) {
    const p = parseProfile(profile);
    const links = parentMap[nodeId] || {};
    p.fatherId = links.father || '';
    p.motherId = links.mother || '';
    ancestors.push(p);
  }

  console.log(`[Geni] /ancestors returned ${ancestors.length} profiles for ${personId}`);
  return ancestors;
}

/**
 * Fallback: BFS walk via /immediate-family when /ancestors fails (e.g. 403).
 */
async function getAncestorsViaImmediateFamily(personId, depth) {
  if (depth <= 0) return [];

  console.log(`[Geni] Fallback: walking via immediate-family for ${personId}`);

  const ancestors = [];
  const queue = [{ id: personId, depth: 0 }];
  const visited = new Set();

  while (queue.length) {
    const { id, depth: currentDepth } = queue.shift();
    if (visited.has(id) || currentDepth > depth) continue;
    visited.add(id);

    const parents = await getParents(id);

    if (parents.father) {
      ancestors.push({
        sourceId: parents.father.id,
        source: 'Geni',
        ...parents.father,
        _source: 'Geni',
      });
      if (currentDepth + 1 < depth) {
        queue.push({ id: parents.father.id, depth: currentDepth + 1 });
      }
    }

    if (parents.mother) {
      ancestors.push({
        sourceId: parents.mother.id,
        source: 'Geni',
        ...parents.mother,
        _source: 'Geni',
      });
      if (currentDepth + 1 < depth) {
        queue.push({ id: parents.mother.id, depth: currentDepth + 1 });
      }
    }
  }

  console.log(`[Geni] Immediate-family walk returned ${ancestors.length} ancestors`);
  return ancestors;
}

/**
 * Get a single person's details.
 */
async function getPersonDetails(personId) {
  if (!geniOauth.getStoredToken()) return null;

  const pid = personId.startsWith('profile') ? personId : `profile-${personId}`;
  const data = await apiGet(`${pid}/immediate-family`);

  if (data && data.nodes) {
    const focusRaw = data.focus;
    let focus = '';
    if (typeof focusRaw === 'string') focus = extractNodeId(focusRaw);
    else if (typeof focusRaw === 'object' && focusRaw) focus = String(focusRaw.id || '');

    const focusProfile = data.nodes[focus] || data.nodes[pid];
    if (focusProfile) return focusProfile;
  }

  // Fallback: plain profile fetch
  const plain = await apiGet(pid);
  return plain && plain.id ? plain : null;
}

module.exports = {
  searchPerson,
  getParents,
  getAncestors,
  getPersonDetails,
};
