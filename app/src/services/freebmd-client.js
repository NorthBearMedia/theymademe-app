/**
 * They Made Me — FreeBMD Client
 *
 * Cross-references births, marriages, and deaths from 1837-1983.
 * No API — uses respectful web scraping with rate limiting.
 *
 * FreeBMD renders results using JavaScript (searchData array).
 * We extract that array from the response and parse it.
 *
 * FreeBMD is used for CONFIRMATION only, not primary discovery
 * (it has no relationship data, just index entries).
 *
 * Ported from Python freebmd.py with identical logic.
 */

const config = require('../config');

const BASE_URL = config.FREEBMD_BASE_URL || 'https://www.freebmd.org.uk';
const RATE_LIMIT = config.FREEBMD_RATE_LIMIT || 3000; // ms between requests

// Quarter index -> name mapping
const QUARTER_NAMES = { 0: 'Mar', 1: 'Jun', 2: 'Sep', 3: 'Dec' };

// Nearby registration districts — for geographic scoring
const NEARBY_DISTRICTS = {
  // Derbyshire / East Staffordshire
  'derby': new Set(['shardlow', 'belper', 'repton', 'burton upon trent', 'ashby de la zouch', 'ashbourne', 'bakewell', 'basford', 'ilkeston', 'chesterfield']),
  'shardlow': new Set(['derby', 'belper', 'repton', 'burton upon trent', 'ashby de la zouch']),
  'belper': new Set(['derby', 'shardlow', 'bakewell', 'ashbourne', 'basford', 'chesterfield']),
  'repton': new Set(['derby', 'shardlow', 'burton upon trent', 'ashby de la zouch']),
  'burton upon trent': new Set(['repton', 'shardlow', 'derby', 'ashby de la zouch', 'lichfield', 'tamworth']),
  'ashby de la zouch': new Set(['repton', 'burton upon trent', 'shardlow', 'derby', 'leicester']),
  'ashbourne': new Set(['derby', 'belper', 'bakewell', 'chapel en le frith']),
  'bakewell': new Set(['ashbourne', 'belper', 'derby', 'chapel en le frith', 'chesterfield']),
  'basford': new Set(['derby', 'belper', 'ilkeston', 'nottingham', 'shardlow']),
  'ilkeston': new Set(['derby', 'basford', 'belper', 'shardlow', 'nottingham']),
  'chesterfield': new Set(['derby', 'belper', 'bakewell', 'basford', 'worksop', 'glossop']),
  // London
  'westminster': new Set(['st george hanover square', 'marylebone', 'paddington', 'kensington', 'chelsea', 'holborn', 'pancras', 'lambeth', 'islington']),
  'marylebone': new Set(['westminster', 'paddington', 'st george hanover square', 'pancras', 'holborn', 'islington', 'hampstead']),
  'kensington': new Set(['westminster', 'chelsea', 'fulham', 'paddington', 'hammersmith', 'st george hanover square']),
  'chelsea': new Set(['kensington', 'westminster', 'fulham', 'wandsworth']),
  'holborn': new Set(['pancras', 'islington', 'marylebone', 'westminster']),
  'pancras': new Set(['holborn', 'islington', 'marylebone', 'hampstead', 'westminster']),
  'islington': new Set(['pancras', 'holborn', 'hackney', 'shoreditch']),
  'paddington': new Set(['marylebone', 'kensington', 'westminster', 'hampstead', 'st george hanover square']),
  'lambeth': new Set(['westminster', 'camberwell', 'wandsworth', 'southwark', 'newington']),
  // Leicestershire
  'leicester': new Set(['blaby', 'billesdon', 'market harborough', 'hinckley', 'lutterworth', 'ashby de la zouch', 'melton mowbray', 'barrow upon soar']),
  // Nottinghamshire
  'nottingham': new Set(['basford', 'ilkeston', 'bingham', 'southwell']),
};

function districtMatches(target, candidate) {
  const t = target.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (!t || !c) return false;
  if (t === c) return true;
  const nearby = NEARBY_DISTRICTS[t];
  return nearby ? nearby.has(c) : false;
}

// ─── BMD Entry ───────────────────────────────────────────────────────

class BMDEntry {
  constructor({ entryType = '', surname = '', forenames = '', spouseSurname = '',
    year = null, quarter = '', district = '', volume = '', page = '' } = {}) {
    this.entryType = entryType;
    this.surname = surname;
    this.forenames = forenames;
    this.spouseSurname = spouseSurname;
    this.year = year;
    this.quarter = quarter;
    this.district = district;
    this.volume = volume;
    this.page = page;
    this.source = 'FreeBMD';
  }

  get display() {
    const parts = [this.entryType.charAt(0).toUpperCase() + this.entryType.slice(1)];
    if (this.forenames && this.surname) parts.push(`${this.forenames} ${this.surname}`);
    if (this.spouseSurname) parts.push(`married ${this.spouseSurname}`);
    if (this.year) parts.push(String(this.year));
    if (this.quarter) parts.push(`Q${this.quarter}`);
    if (this.district) parts.push(this.district);
    return parts.join(' \u2014 ');
  }
}

// ─── FreeBMD Client ──────────────────────────────────────────────────

class FreeBMDClient {
  constructor() {
    this.baseUrl = BASE_URL;
    this.rateLimit = RATE_LIMIT;
    this._lastRequestTime = 0;
    this._vToken = '';
    this._districtIds = {};
    this._districtIdsLoaded = false;
  }

  async _rateLimitWait() {
    const elapsed = Date.now() - this._lastRequestTime;
    if (elapsed < this.rateLimit) {
      await new Promise(r => setTimeout(r, this.rateLimit - elapsed));
    }
    this._lastRequestTime = Date.now();
  }

  async _requestWithRetry(method, url, options = {}, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this._rateLimitWait();

      try {
        const response = await fetch(url, {
          method,
          ...options,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            ...(options.headers || {}),
          },
          signal: AbortSignal.timeout(30000),
        });

        if (response.status === 429) {
          const backoff = this.rateLimit * Math.pow(2, attempt + 1);
          console.warn(`[FreeBMD] 429 rate limited, backing off ${backoff}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, backoff));
          this._vToken = '';
          continue;
        }

        if (!response.ok) {
          throw new Error(`FreeBMD HTTP ${response.status}`);
        }

        return await response.text();
      } catch (err) {
        if (attempt === maxRetries - 1) throw err;
        console.warn(`[FreeBMD] Request error, retrying: ${err.message}`);
      }
    }
  }

  async _getVToken() {
    if (this._vToken) return this._vToken;

    try {
      const html = await this._requestWithRetry('GET', `${this.baseUrl}/cgi/search.pl`);

      // Extract hidden 'v' field
      const match = html.match(/name=["']v["'][^>]*value=["']([^"']+)["']/);
      if (match) {
        this._vToken = match[1];
      } else {
        console.warn('[FreeBMD] Could not extract v-token');
      }

      // Load district IDs from same page
      if (!this._districtIdsLoaded) {
        this._loadDistrictIds(html);
      }
    } catch (err) {
      console.error(`[FreeBMD] Failed to fetch v-token: ${err.message}`);
    }

    return this._vToken;
  }

  _loadDistrictIds(html = '') {
    if (this._districtIdsLoaded) return;

    const selectMatch = html.match(/<select[^>]*name=["']?district["']?[^>]*>([\s\S]*?)<\/select>/i);
    if (!selectMatch) {
      console.warn('[FreeBMD] Could not find district <select>');
      return;
    }

    const optionPattern = /<option[^>]*value=["']?([^"'>]+)["']?[^>]*>(.*?)<\/option>/gi;
    let m;
    while ((m = optionPattern.exec(selectMatch[1])) !== null) {
      const val = m[1];
      const text = m[2].trim();
      if (val.toLowerCase() === 'all') continue;

      const full = text.toLowerCase();
      this._districtIds[full] = val;

      // Also store without date-range parenthetical
      const clean = text.replace(/\s*\(.*?\)\s*$/, '').trim().toLowerCase();
      if (clean && clean !== full && !this._districtIds[clean]) {
        this._districtIds[clean] = val;
      }
    }

    this._districtIdsLoaded = true;
    console.log(`[FreeBMD] Loaded ${Object.keys(this._districtIds).length} district IDs`);
  }

  _resolveDistrictId(districtName) {
    if (!districtName) return '';
    if (!this._districtIdsLoaded) return '';

    const name = districtName.toLowerCase().trim();

    // Direct lookup
    if (this._districtIds[name]) return this._districtIds[name];

    // Common abbreviations
    const abbrevs = {
      'ashby z.': 'ashby de la zouch', 'ashby z': 'ashby de la zouch',
      'burton': 'burton upon trent', 'b. upon trent': 'burton upon trent',
      'st. geo h sq': 'st george hanover square', 'st geo h sq': 'st george hanover square',
    };
    const expanded = abbrevs[name];
    if (expanded && this._districtIds[expanded]) return this._districtIds[expanded];

    // Prefix match
    for (const [key, val] of Object.entries(this._districtIds)) {
      if (key.startsWith(name) || name.startsWith(key)) return val;
    }

    console.warn(`[FreeBMD] Could not resolve district '${districtName}'`);
    return '';
  }

  // ─── Search Methods ──────────────────────────────────────────────

  async searchBirths(surname, forenames = '', yearFrom = null, yearTo = null, district = '') {
    return this._search('births', surname, forenames, yearFrom, yearTo, district);
  }

  async searchDeaths(surname, forenames = '', yearFrom = null, yearTo = null, district = '') {
    return this._search('deaths', surname, forenames, yearFrom, yearTo, district);
  }

  async searchMarriages(surname, forenames = '', yearFrom = null, yearTo = null, district = '') {
    return this._search('marriages', surname, forenames, yearFrom, yearTo, district);
  }

  async _search(recordType, surname, forenames = '', yearFrom = null, yearTo = null, district = '') {
    const vToken = await this._getVToken();
    await this._rateLimitWait();

    const typeMap = { births: 'Births', deaths: 'Deaths', marriages: 'Marriages' };
    const bmdType = typeMap[recordType] || 'Births';

    const formData = new URLSearchParams({
      type: bmdType,
      surname,
      given: forenames,
      v: vToken,
      jsexec: '1',
      'find.x': '50',
      'find.y': '10',
    });

    if (yearFrom) formData.set('start', String(yearFrom));
    if (yearTo) formData.set('end', String(yearTo));

    if (district) {
      const districtId = this._resolveDistrictId(district);
      if (districtId) formData.set('district', districtId);
    }

    console.log(`[FreeBMD] Search: ${recordType} for ${forenames} ${surname}, years=${yearFrom}-${yearTo}${district ? `, district=${district}` : ''}`);

    try {
      const html = await this._requestWithRetry('POST', `${this.baseUrl}/cgi/search.pl`, {
        body: formData.toString(),
        headers: {
          'Referer': `${this.baseUrl}/cgi/search.pl`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      // v-token is one-use
      this._vToken = '';

      // Check for overflow
      if (html.includes('maximum number that can be displayed')) {
        const overflow = html.match(/found (\d+) matches/);
        console.warn(`[FreeBMD] Too many matches (${overflow ? overflow[1] : 'many'}) for ${forenames} ${surname}`);
        return [];
      }

      return this._parseSearchData(html, recordType.replace(/s$/, ''));
    } catch (err) {
      console.error(`[FreeBMD] Search failed: ${err.message}`);
      this._vToken = '';
      return [];
    }
  }

  _parseSearchData(html, entryType) {
    const match = html.match(/var\s+searchData\s*=\s*new\s+Array\s*\(([\s\S]*?)\)\s*;/);
    if (!match) {
      console.log('[FreeBMD] No searchData found, trying table fallback');
      return this._parseHtmlTable(html, entryType);
    }

    const raw = match[1];
    const entries = [];
    let currentYear = null;
    let currentQuarter = null;

    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim().replace(/^,|,$/g, '').replace(/^"|"$/g, '').trim();
      if (!line) continue;

      const parts = line.split(';');

      // Header line: starts with empty/space, has quarter in pos 2, year in pos 3
      if (parts.length >= 4 && parts[0].trim() === '') {
        try { currentQuarter = parseInt(parts[2], 10); } catch (e) { currentQuarter = null; }
        try { currentYear = parseInt(parts[3], 10); } catch (e) { currentYear = null; }
        continue;
      }

      // Data line: flags;surname;forenames;spouse;age;district;vol;page;cite
      if (parts.length < 6) continue;

      const surnameVal = parts[1] || '';
      const forenamesEncoded = parts[2] || '';
      const forenamesVal = decodeURIComponent(forenamesEncoded.replace(/\+/g, ' ')).trim();
      const spouseRaw = (parts[3] || '').trim();
      const spouseVal = decodeURIComponent(spouseRaw.replace(/\+/g, ' ')).trim();
      const districtVal = decodeURIComponent((parts[5] || '').replace(/\+/g, ' ')).trim();
      const volumeVal = parts[6] || '';
      const pageVal = parts[7] || '';

      const quarterName = QUARTER_NAMES[currentQuarter] || '';

      if (forenamesVal || spouseVal) {
        entries.push(new BMDEntry({
          entryType,
          surname: surnameVal,
          forenames: forenamesVal,
          spouseSurname: spouseVal && spouseVal !== ' ' ? spouseVal : '',
          year: currentYear,
          quarter: quarterName,
          district: districtVal,
          volume: volumeVal,
          page: pageVal,
        }));
      }
    }

    console.log(`[FreeBMD] Parsed ${entries.length} ${entryType} entries from searchData`);
    return entries;
  }

  _parseHtmlTable(html, entryType) {
    const entries = [];
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const cells = [];
      const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      if (cells.length < 4) continue;
      if (['surname', 'type', ''].includes(cells[0].toLowerCase())) continue;

      const entry = new BMDEntry({ entryType, surname: cells[0], forenames: cells[1] || '' });

      for (const cell of cells.slice(2)) {
        const yearMatch = cell.match(/^(\d{4})$/);
        if (yearMatch) { entry.year = parseInt(yearMatch[1], 10); continue; }
        if (['Mar', 'Jun', 'Sep', 'Dec'].includes(cell.trim())) { entry.quarter = cell.trim(); continue; }
        if (/^\d+[a-z]?$/i.test(cell.trim())) {
          if (!entry.volume) entry.volume = cell.trim();
          else entry.page = cell.trim();
          continue;
        }
        if (cell.trim() && !entry.district) entry.district = cell.trim();
      }

      if (entry.surname) entries.push(entry);
    }

    console.log(`[FreeBMD] Parsed ${entries.length} ${entryType} entries from HTML table`);
    return entries;
  }

  // ─── Confirmation Methods ────────────────────────────────────────

  async confirmBirth(firstName, lastName, birthYear, birthPlace) {
    if (!birthYear || birthYear < 1837 || birthYear > 1983) return null;

    const entries = await this.searchBirths(lastName, firstName, birthYear - 1, birthYear + 1);
    if (!entries.length) return null;

    let best = null;
    let bestScore = 0;

    for (const entry of entries) {
      let score = 0;
      if (entry.surname.toLowerCase() === lastName.toLowerCase()) score += 40;
      else if (!entry.surname) score += 35;

      if (entry.forenames && firstName) {
        if (entry.forenames.toLowerCase().startsWith(firstName.toLowerCase())) score += 30;
        else if (firstName.toLowerCase().includes(entry.forenames.toLowerCase()) ||
                 entry.forenames.toLowerCase().includes(firstName.toLowerCase())) score += 20;
      }

      if (entry.year === birthYear) score += 20;
      else if (entry.year && Math.abs(entry.year - birthYear) <= 1) score += 10;

      if (birthPlace && entry.district) {
        const bp = birthPlace.toLowerCase();
        const dist = entry.district.toLowerCase();
        if (bp.includes(dist) || dist.includes(bp)) score += 10;
      }

      if (score > bestScore) { bestScore = score; best = entry; }
    }

    return bestScore >= 50 ? best : null;
  }

  async confirmDeath(firstName, lastName, deathYear) {
    if (!deathYear || deathYear < 1837 || deathYear > 1983) return null;

    const entries = await this.searchDeaths(lastName, firstName, deathYear - 1, deathYear + 1);
    if (!entries.length) return null;

    let best = null;
    let bestScore = 0;

    for (const entry of entries) {
      let score = 0;
      if (entry.surname.toLowerCase() === lastName.toLowerCase()) score += 40;
      else if (!entry.surname) score += 35;
      if (entry.forenames && firstName) {
        if (entry.forenames.toLowerCase().startsWith(firstName.toLowerCase())) score += 30;
      }
      if (entry.year === deathYear) score += 20;

      if (score > bestScore) { bestScore = score; best = entry; }
    }

    return bestScore >= 50 ? best : null;
  }

  async findMarriage(surname, firstName, spouseSurname = '', yearFrom = null, yearTo = null, district = '') {
    const entries = await this.searchMarriages(surname, firstName, yearFrom, yearTo, district);
    if (!entries.length) return null;

    let best = null;
    let bestScore = 0;

    for (const entry of entries) {
      let score = 0;

      if (entry.surname.toLowerCase() === surname.toLowerCase()) score += 30;
      else if (!entry.surname) score += 25;

      if (entry.forenames && firstName) {
        if (entry.forenames.toLowerCase().startsWith(firstName.toLowerCase())) score += 25;
        else if (firstName.toLowerCase().includes(entry.forenames.toLowerCase())) score += 15;
      }

      // Spouse surname match — very strong signal
      if (spouseSurname && entry.spouseSurname) {
        if (entry.spouseSurname.toLowerCase() === spouseSurname.toLowerCase()) score += 50;
        else if (spouseSurname.toLowerCase().includes(entry.spouseSurname.toLowerCase())) score += 25;
      }

      // District match
      if (district && entry.district) {
        if (districtMatches(district, entry.district)) score += 20;
      }

      if (score > bestScore) { bestScore = score; best = entry; }
    }

    return bestScore >= 45 ? best : null;
  }
}

module.exports = { FreeBMDClient, BMDEntry, NEARBY_DISTRICTS, districtMatches };
