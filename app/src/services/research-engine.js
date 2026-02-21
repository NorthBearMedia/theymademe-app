const fsApi = require('./familysearch-api');
const { SOURCE_CAPABILITIES } = require('./source-interface');
const { mergeSearchResults, multiSourceBonus } = require('./source-merger');

// ─── Utility Functions ───────────────────────────────────────────────

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function normalizeDate(str) {
  if (!str) return null;
  str = str.trim().replace(/^(abt|about|circa|c\.?|~)\s*/i, '');

  // "1959" — year only
  if (/^\d{4}$/.test(str)) {
    return { year: parseInt(str, 10), month: null, day: null };
  }

  // "01.09.59" or "01/09/59" or "01-09-59" — DD.MM.YY (British)
  const ddmmyy = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/);
  if (ddmmyy) {
    let year = parseInt(ddmmyy[3], 10);
    year = year > 25 ? 1900 + year : 2000 + year;
    return { year, month: parseInt(ddmmyy[2], 10), day: parseInt(ddmmyy[1], 10) };
  }

  // "01.09.1959" or "01/09/1959" — DD.MM.YYYY
  const ddmmyyyy = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (ddmmyyyy) {
    return { year: parseInt(ddmmyyyy[3], 10), month: parseInt(ddmmyyyy[2], 10), day: parseInt(ddmmyyyy[1], 10) };
  }

  // "1 September 1959" or "15 March 1920" or "September 1959"
  const textDate = str.match(/^(?:(\d{1,2})\s+)?([a-z]+)\s+(\d{4})$/i);
  if (textDate) {
    const month = MONTH_NAMES[textDate[2].toLowerCase()];
    if (month) {
      return { year: parseInt(textDate[3], 10), month, day: textDate[1] ? parseInt(textDate[1], 10) : null };
    }
  }

  // "Aug 1935" or "July 1936"
  const monthYear = str.match(/^([a-z]+)\s+(\d{4})$/i);
  if (monthYear) {
    const month = MONTH_NAMES[monthYear[1].toLowerCase()];
    if (month) {
      return { year: parseInt(monthYear[2], 10), month, day: null };
    }
  }

  // FamilySearch format: "15 January 1959" already covered above
  // Also handle "January 1959"
  return null;
}

function normalizeName(str) {
  if (!str) return '';
  return str.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/\bnee\b\s*/i, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNameParts(fullName) {
  if (!fullName) return { givenName: '', surname: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { givenName: parts[0], surname: '' };
  const surname = parts.pop();
  return { givenName: parts.join(' '), surname };
}

function placeContains(candidatePlace, knownPlace) {
  if (!candidatePlace || !knownPlace) return false;
  const a = candidatePlace.toLowerCase().replace(/[,.\s]+/g, ' ').trim();
  const b = knownPlace.toLowerCase().replace(/[,.\s]+/g, ' ').trim();
  if (a === b) return true;
  // Check if any significant word from known place appears in candidate
  const knownWords = b.split(' ').filter(w => w.length > 2);
  return knownWords.some(w => a.includes(w));
}

// ─── Geographic Detection ─────────────────────────────────────────────
// Detect if a place is clearly in a non-UK country (primarily USA)

const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas',
  'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming',
]);

const US_STATE_ABBREVS = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi',
  'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi',
  'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc',
  'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut',
  'vt', 'va', 'wa', 'wv', 'wi', 'wy',
]);

const NON_UK_COUNTRIES = new Set([
  'united states', 'united states of america', 'usa', 'us', 'america',
  'canada', 'australia', 'new zealand', 'south africa',
  'france', 'germany', 'italy', 'spain', 'netherlands', 'belgium',
  'sweden', 'norway', 'denmark', 'switzerland', 'austria',
  'india', 'china', 'japan', 'brazil', 'mexico', 'russia',
]);

const UK_INDICATORS = new Set([
  'england', 'wales', 'scotland', 'ireland', 'united kingdom',
  'great britain', 'uk', 'gb',
  // English counties
  'derbyshire', 'nottinghamshire', 'yorkshire', 'lancashire', 'cheshire',
  'staffordshire', 'leicestershire', 'warwickshire', 'lincolnshire',
  'norfolk', 'suffolk', 'essex', 'kent', 'sussex', 'surrey', 'hampshire',
  'dorset', 'devon', 'cornwall', 'somerset', 'wiltshire', 'gloucestershire',
  'oxfordshire', 'berkshire', 'buckinghamshire', 'hertfordshire', 'bedfordshire',
  'cambridgeshire', 'northamptonshire', 'rutland', 'shropshire', 'herefordshire',
  'worcestershire', 'middlesex', 'london', 'westmorland', 'cumberland',
  'northumberland', 'durham', 'westmoreland', 'monmouthshire',
  // Major UK cities
  'birmingham', 'manchester', 'liverpool', 'leeds', 'sheffield', 'bristol',
  'newcastle', 'nottingham', 'leicester', 'derby', 'coventry', 'cardiff',
  'edinburgh', 'glasgow', 'belfast', 'dublin', 'bradford', 'stoke',
  'wolverhampton', 'sunderland', 'portsmouth', 'southampton', 'brighton',
  'plymouth', 'reading', 'hull', 'blackpool', 'preston', 'bolton',
]);

function isNonUkPlace(place) {
  if (!place) return false;
  const lower = place.toLowerCase().replace(/[,.\s]+/g, ' ').trim();
  const parts = lower.split(' ').filter(p => p.length > 0);

  // Check for US states (full name)
  for (const state of US_STATES) {
    if (lower.includes(state)) return true;
  }
  // Check for US state abbreviations at end of place string (e.g., "Springfield, IL")
  const lastPart = parts[parts.length - 1];
  if (lastPart && US_STATE_ABBREVS.has(lastPart) && parts.length >= 2) return true;

  // Check for non-UK country names
  for (const country of NON_UK_COUNTRIES) {
    if (lower.includes(country)) return true;
  }

  return false;
}

function isUkPlace(place) {
  if (!place) return false;
  const lower = place.toLowerCase().replace(/[,.\s]+/g, ' ').trim();
  for (const indicator of UK_INDICATORS) {
    if (lower.includes(indicator)) return true;
  }
  return false;
}

// ─── Place Specificity Scoring ────────────────────────────────────────
// Graduated place matching: town > county > country > partial

const UK_COUNTIES = new Set([
  'derbyshire', 'nottinghamshire', 'yorkshire', 'lancashire', 'cheshire',
  'staffordshire', 'leicestershire', 'warwickshire', 'lincolnshire',
  'norfolk', 'suffolk', 'essex', 'kent', 'sussex', 'surrey', 'hampshire',
  'dorset', 'devon', 'cornwall', 'somerset', 'wiltshire', 'gloucestershire',
  'oxfordshire', 'berkshire', 'buckinghamshire', 'hertfordshire', 'bedfordshire',
  'cambridgeshire', 'northamptonshire', 'rutland', 'shropshire', 'herefordshire',
  'worcestershire', 'middlesex', 'northumberland', 'durham', 'westmorland',
  'cumberland', 'monmouthshire',
]);

const UK_COUNTRIES = new Set(['england', 'wales', 'scotland', 'ireland', 'united kingdom', 'great britain']);

function parsePlaceParts(place) {
  if (!place) return { town: null, county: null, country: null };
  const parts = place.toLowerCase()
    .replace(/[^a-z\s,]/g, '') // strip non-latin
    .replace(/[,]+/g, ',').split(',').map(p => p.trim()).filter(Boolean);
  let town = null, county = null, country = null;
  for (const part of parts) {
    if (UK_COUNTRIES.has(part) || part === 'uk' || part === 'gb') {
      country = part;
    } else if (UK_COUNTIES.has(part)) {
      county = part;
    } else if (!town && part.length > 1) {
      town = part;
    }
  }
  return { town, county, country };
}

// Returns specificity level: 'town', 'county', 'country', 'partial', or null
function placeSpecificityScore(candidatePlace, knownPlace) {
  if (!candidatePlace || !knownPlace) return null;
  const c = parsePlaceParts(candidatePlace);
  const k = parsePlaceParts(knownPlace);

  // Town/parish match (highest specificity)
  if (c.town && k.town && c.town === k.town) return 'town';

  // County match
  if (c.county && k.county && c.county === k.county) return 'county';

  // Country match only
  if (c.country && k.country && c.country === k.country) return 'country';

  // Fallback: use existing placeContains for partial matches
  if (placeContains(candidatePlace, knownPlace)) return 'partial';

  return null;
}

// Sanitize FamilySearch place names — strip non-Latin scripts (Cyrillic, Old English, etc.)
// and clean up resulting artifacts (extra commas, spaces)
function sanitizePlaceName(place) {
  if (!place) return '';
  // Strip characters outside Basic Latin, Latin Extended, and common punctuation
  // This removes Cyrillic (U+0400-04FF), Mongolian, Old English runes, etc.
  let cleaned = place
    .replace(/[^\u0000-\u024F\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\s,.\-'()0-9]/g, '')
    .replace(/,\s*,/g, ',')       // collapse double commas
    .replace(/,\s*$/g, '')         // trailing comma
    .replace(/^\s*,/g, '')         // leading comma
    .replace(/\s{2,}/g, ' ')       // collapse multiple spaces
    .trim();
  // Also replace Old English place names with modern equivalents
  const oldEnglishMap = {
    'deorbyscir': 'Derbyshire',
    'beadafordscir': 'Bedfordshire',
    'beadafordscīr': 'Bedfordshire',
    'sūþseaxe': 'Sussex',
    'hamtūnscīr': 'Hampshire',
    'glēawecæsterscīr': 'Gloucestershire',
    'oxnafordscīr': 'Oxfordshire',
    'wiltūnscīr': 'Wiltshire',
    'sumorsǣte': 'Somerset',
    'norðfolc': 'Norfolk',
    'sūðfolc': 'Suffolk',
    'cent': 'Kent',
    'defnascīr': 'Devon',
    'dornsǣte': 'Dorset',
    'hēortfordscīr': 'Hertfordshire',
    'buccingahamscīr': 'Buckinghamshire',
    'ēastseaxe': 'Essex',
    'norþhymbra land': 'Northumberland',
    'westmoringaland': 'Westmorland',
  };
  // Replace Old English county names (case insensitive)
  const parts = cleaned.split(',').map(p => p.trim());
  const modernParts = parts.map(part => {
    const lower = part.toLowerCase().replace(/[\u0100-\u024F]/g, function(c) {
      return c.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    });
    for (const [old, modern] of Object.entries(oldEnglishMap)) {
      const oldNorm = old.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (lower === oldNorm || lower === old) {
        return modern;
      }
    }
    return part;
  }).filter(p => p.length > 0);
  return modernParts.join(', ');
}

function nameContains(candidateName, knownName) {
  if (!candidateName || !knownName) return false;
  const a = normalizeName(candidateName);
  const b = normalizeName(knownName);
  if (a === b) return true;
  // Check if all parts of the known name appear in the candidate
  const knownParts = b.split(' ').filter(w => w.length > 1);
  return knownParts.every(part => a.includes(part));
}

function yearDiff(date1, date2) {
  if (!date1?.year || !date2?.year) return null;
  return Math.abs(date1.year - date2.year);
}

// Format a date string for the FamilySearch API (q.birthLikeDate / q.deathLikeDate)
// FamilySearch beta API ONLY accepts year-only format (e.g., "1959").
// Any other format ("1 September 1959", "Sep 1959") causes 400 errors.
function formatDateForApi(dateStr) {
  if (!dateStr) return null;
  const parsed = normalizeDate(dateStr);
  if (!parsed) return null; // Don't pass unparseable dates
  return String(parsed.year);
}

// Alias for clarity — both produce year-only for the beta API
function formatYearOnly(dateStr) {
  return formatDateForApi(dateStr);
}

// ─── Given Name Variants (UK/English) ────────────────────────────────

const GIVEN_NAME_VARIANTS = {
  william: ['bill', 'will', 'wm', 'billy', 'willie'],
  elizabeth: ['betty', 'bess', 'liz', 'eliza', 'beth', 'lizzie', 'betsy'],
  margaret: ['peggy', 'maggie', 'meg', 'marge', 'madge', 'margie'],
  james: ['jim', 'jas', 'jimmy', 'jamie'],
  robert: ['bob', 'rob', 'bert', 'bobby', 'robbie'],
  richard: ['dick', 'rick', 'richie'],
  thomas: ['tom', 'thos', 'tommy'],
  henry: ['harry', 'hal'],
  edward: ['ted', 'ned', 'ed', 'eddie', 'teddy'],
  frederick: ['fred', 'freddy', 'freddie'],
  janet: ['jan', 'janice', 'jennet'],
  catherine: ['kate', 'kathy', 'katherine', 'kathryn', 'kitty'],
  john: ['jack', 'jno', 'johnny', 'jon'],
  charles: ['charlie', 'chas', 'chuck'],
  walter: ['walt', 'wally', 'wat'],
  george: ['geo'],
  joseph: ['joe', 'jos'],
  samuel: ['sam', 'saml'],
  benjamin: ['ben', 'benj'],
  alexander: ['alex', 'alec', 'sandy'],
  andrew: ['drew', 'andy'],
  dorothy: ['dot', 'dolly', 'dora'],
  florence: ['flo', 'flossie'],
  mary: ['polly', 'molly', 'may', 'mamie'],
  sarah: ['sally', 'sadie'],
  ann: ['annie', 'anna', 'nan', 'nancy', 'anne'],
  alice: ['ally', 'allie'],
  frances: ['fanny', 'fran'],
  helen: ['nell', 'nellie', 'ellen', 'ella'],
  martha: ['patty', 'matty'],
  eleanor: ['nell', 'nelly', 'nora'],
  susannah: ['susan', 'sue', 'sukey'],
  harriet: ['hattie', 'hetty'],
  albert: ['bert', 'al'],
  arthur: ['art'],
  leonard: ['len', 'lenny'],
  alfred: ['alf', 'alfie'],
  ernest: ['ernie'],
  harold: ['harry', 'hal'],
  reginald: ['reg', 'reggie'],
  ronald: ['ron', 'ronnie'],
  donald: ['don', 'donnie'],
  gerald: ['gerry', 'jerry'],
  norman: ['norm'],
  alan: ['al', 'allan', 'allen'],
};

// Build reverse lookup: variant → canonical names
const VARIANT_REVERSE = {};
for (const [canonical, variants] of Object.entries(GIVEN_NAME_VARIANTS)) {
  for (const v of variants) {
    if (!VARIANT_REVERSE[v]) VARIANT_REVERSE[v] = [];
    VARIANT_REVERSE[v].push(canonical);
  }
  // Also map canonical to itself for bidirectional lookup
  if (!VARIANT_REVERSE[canonical]) VARIANT_REVERSE[canonical] = [];
}

function getGivenNameVariants(givenName) {
  if (!givenName) return [];
  const first = givenName.trim().split(/\s+/)[0].toLowerCase();
  const variants = new Set();
  // Forward: canonical → variants
  if (GIVEN_NAME_VARIANTS[first]) {
    for (const v of GIVEN_NAME_VARIANTS[first]) variants.add(v);
  }
  // Reverse: variant → canonical
  if (VARIANT_REVERSE[first]) {
    for (const c of VARIANT_REVERSE[first]) {
      variants.add(c);
      if (GIVEN_NAME_VARIANTS[c]) {
        for (const v of GIVEN_NAME_VARIANTS[c]) variants.add(v);
      }
    }
  }
  variants.delete(first); // Remove self
  return [...variants];
}

function isNameVariant(name1, name2) {
  if (!name1 || !name2) return false;
  const a = name1.toLowerCase().split(/\s+/)[0];
  const b = name2.toLowerCase().split(/\s+/)[0];
  if (a === b) return true;
  const aVariants = getGivenNameVariants(a);
  return aVariants.includes(b);
}

// ─── Source Classification ───────────────────────────────────────────

function classifySource(source) {
  const title = (source.title || '').toLowerCase();
  const citation = (source.citation || '').toLowerCase();
  const text = title + ' ' + citation;

  if (/\bbirth\b|\bchrist(en|in)/.test(text)) return { type: 'birth_record', weight: 25 };
  if (/\bmarriage\b|\bmarri/.test(text)) return { type: 'marriage_record', weight: 20 };
  if (/\bdeath\b|\bburial\b|\bprobate\b/.test(text)) return { type: 'death_record', weight: 20 };
  if (/\bcensus\b/.test(text)) return { type: 'census', weight: 15 };
  if (/\bparish\b|\bchurch\b|\bbaptis/.test(text)) return { type: 'parish_record', weight: 18 };
  if (/\bmilitary\b|\barmy\b|\bnavy\b|\braf\b/.test(text)) return { type: 'military_record', weight: 10 };
  if (/\bimmigra|\bpassenger\b|\bemigra/.test(text)) return { type: 'immigration', weight: 10 };
  return { type: 'other', weight: 5 };
}

function scoreEvidence(sources) {
  if (!sources || sources.length === 0) return { score: 0, evidence: [], sourceTypes: new Set() };

  const evidence = [];
  const sourceTypes = new Set();
  let totalWeight = 0;

  for (const source of sources) {
    const { type, weight } = classifySource(source);
    sourceTypes.add(type);
    totalWeight += weight;
    evidence.push({
      source_type: type,
      weight,
      title: source.title,
      url: source.url,
      citation: source.citation,
    });
  }

  let score = Math.min(totalWeight, 100);

  // Bonus for multiple independent source types
  if (sourceTypes.size >= 3) score = Math.min(score + 10, 100);

  return { score, evidence, sourceTypes };
}

// ─── Notes Parser ────────────────────────────────────────────────────

function parseNotesForAnchors(notes) {
  if (!notes) return {};
  const anchors = {};

  // ─── Pattern: "Name (birth-death)" for any person mentioned ───
  // Matches: "Brian Jackson (1940-2021)", "Charles Herbert Jackson (1909-1963)"
  const nameYearPattern = /([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\)/g;
  const allPersons = [];
  let m;
  while ((m = nameYearPattern.exec(notes)) !== null) {
    allPersons.push({
      name: m[1].trim(),
      ...parseNameParts(m[1].trim()),
      birthDate: m[2],
      deathDate: m[3] && !['present', 'living'].includes(m[3].toLowerCase()) ? m[3] : '',
      matchIndex: m.index,
    });
  }

  // ─── Father / Mother ─── (assign to asc#2 / asc#3)
  // Match "Father Name (year-year)" or "Father: Name (year-year)"
  const fatherMatch = notes.match(/father\s*[:\-–]?\s*([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\)/i);
  if (fatherMatch) {
    anchors[2] = { ...parseNameParts(fatherMatch[1].trim()), birthDate: fatherMatch[2], deathDate: fatherMatch[3] && !['present', 'living'].includes(fatherMatch[3].toLowerCase()) ? fatherMatch[3] : '' };
  }
  const motherMatch = notes.match(/mother\s*[:\-–]?\s*([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\)/i);
  if (motherMatch) {
    anchors[3] = { ...parseNameParts(motherMatch[1].trim()), birthDate: motherMatch[2], deathDate: motherMatch[3] && !['present', 'living'].includes(motherMatch[3].toLowerCase()) ? motherMatch[3] : '' };
  }

  // ─── Paternal Grandparents ─── (asc#4 = grandfather, asc#5 = grandmother)
  // Patterns: "Paternal GP:", "Paternal grandparents:", "grandfather was Name"
  const pgMatch = notes.match(/(?:paternal\s+(?:gp|grandparents?)\s*[:\-–]\s*)([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4})?\)/i)
    || notes.match(/(?:paternal\s+)?grandfather\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4})?\))?(?:,|\.|born|from|and|$)/i);
  if (pgMatch) {
    anchors[4] = { ...parseNameParts(pgMatch[1].trim()), birthDate: pgMatch[2] || '', deathDate: pgMatch[3] || '' };
  }

  // Second person after "and" for grandmother (Paternal GP: Name1 (y-y) and Name2 (y-y))
  const pgmMatch = notes.match(/(?:paternal\s+(?:gp|grandparents?)\s*[:\-–].*?and\s+)([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4})?\)/i)
    || notes.match(/(?:paternal\s+)?grandmother\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4})?\))?(?:,|\.|born|from|$)/i);
  if (pgmMatch) {
    anchors[5] = { ...parseNameParts(pgmMatch[1].trim()), birthDate: pgmMatch[2] || '', deathDate: pgmMatch[3] || '' };
  }

  // ─── Maternal Grandparents ─── (asc#6 = grandfather, asc#7 = grandmother)
  const mgMatch = notes.match(/(?:maternal\s+(?:gp|grandparents?)\s*[:\-–]\s*)([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4})?\)/i)
    || notes.match(/maternal\s+grandfather\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4})?\))?(?:,|\.|born|from|and|$)/i);
  if (mgMatch) {
    anchors[6] = { ...parseNameParts(mgMatch[1].trim()), birthDate: mgMatch[2] || '', deathDate: mgMatch[3] || '' };
  }

  const mgmMatch = notes.match(/(?:maternal\s+(?:gp|grandparents?)\s*[:\-–].*?and\s+)([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4})?\)/i)
    || notes.match(/maternal\s+grandmother\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4})?\))?(?:,|\.|born|from|$)/i);
  if (mgmMatch) {
    anchors[7] = { ...parseNameParts(mgmMatch[1].trim()), birthDate: mgmMatch[2] || '', deathDate: mgmMatch[3] || '' };
  }

  // ─── Fallback: Extract dates near ancestor mentions ───
  const datePattern = /born\s+(?:(?:on|in)\s+)?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}|[A-Z][a-z]+\s+\d{4})/gi;
  let dateMatch;
  while ((dateMatch = datePattern.exec(notes)) !== null) {
    const context = notes.substring(Math.max(0, dateMatch.index - 50), dateMatch.index);
    for (const [asc, anchor] of Object.entries(anchors)) {
      if (anchor.surname && !anchor.birthDate && context.toLowerCase().includes(anchor.surname.toLowerCase())) {
        anchors[asc].birthDate = dateMatch[1];
      }
    }
  }

  // Extract places: "from Placename" or "in Placename"
  const placePattern = /(?:from|in|of)\s+([A-Z][a-zA-Z\s,]+?)(?:\.|;|born|$)/gi;
  let placeMatch;
  while ((placeMatch = placePattern.exec(notes)) !== null) {
    const context = notes.substring(Math.max(0, placeMatch.index - 50), placeMatch.index);
    for (const [asc, anchor] of Object.entries(anchors)) {
      if (anchor.surname && context.toLowerCase().includes(anchor.surname.toLowerCase())) {
        anchors[asc].birthPlace = placeMatch[1].trim();
      }
    }
  }

  return anchors;
}

// ─── Research Engine ─────────────────────────────────────────────────

class ResearchEngine {
  constructor(db, jobId, inputData, generations, sources) {
    this.db = db;
    this.jobId = jobId;
    this.inputData = inputData;
    this.generations = generations;
    this.visitedIds = new Set();
    this.processedCount = 0;
    this.maxAncestors = Math.pow(2, generations + 1) - 2; // max possible (excluding subject for gen count)
    this.knownAnchors = {}; // Map<ascNumber, partialKnownInfo>
    // Blacklist: FS person IDs that were previously selected but rejected by admin
    this.rejectedFsIds = new Set(db.getRejectedFsIds(jobId));
    if (this.rejectedFsIds.size > 0) {
      console.log(`[Engine] Loaded ${this.rejectedFsIds.size} rejected FS IDs: ${[...this.rejectedFsIds].join(', ')}`);
    }

    // Multi-source support — categorize injected sources by capability
    this.sources = sources || [];
    this.searchSources = this.sources.filter(s =>
      s.capabilities.includes(SOURCE_CAPABILITIES.SEARCH) && s.isAvailable()
    );
    this.treeSources = this.sources.filter(s =>
      s.capabilities.includes(SOURCE_CAPABILITIES.TREE_TRAVERSAL) && s.isAvailable()
    );
    this.confirmationSources = this.sources.filter(s =>
      s.capabilities.includes(SOURCE_CAPABILITIES.CONFIRMATION) && s.isAvailable()
    );
    // Track which source owns each person ID (e.g., 'FamilySearch' or 'Geni')
    this.sourceOriginMap = new Map(); // personId → sourceName

    if (this.sources.length > 0) {
      console.log(`[Engine] Sources: search=[${this.searchSources.map(s => s.sourceName).join(',')}], tree=[${this.treeSources.map(s => s.sourceName).join(',')}], confirmation=[${this.confirmationSources.map(s => s.sourceName).join(',')}]`);
    }
  }

  // Get a tree source by name (for routing parent lookups to the correct source)
  getTreeSourceByName(name) {
    return this.treeSources.find(s => s.sourceName === name) || null;
  }

  // Track which source found a person ID
  trackSourceOrigin(personId, sourceName) {
    if (personId) this.sourceOriginMap.set(personId, sourceName);
  }

  // Get the source that owns a person ID
  getSourceOrigin(personId) {
    return this.sourceOriginMap.get(personId) || 'FamilySearch';
  }

  // Search across all available search sources, merge results
  async multiSourceSearch(query) {
    const allResults = [];

    for (const source of this.searchSources) {
      try {
        const results = await source.searchPerson(query);
        // Tag each result with its source
        for (const r of results) {
          r._source = source.sourceName;
          this.trackSourceOrigin(r.id, source.sourceName);
        }
        allResults.push(...results);
      } catch (err) {
        console.log(`[MultiSource] ${source.sourceName} search failed: ${err.message}`);
      }
    }

    // Merge and deduplicate across sources
    if (allResults.length > 0) {
      return mergeSearchResults(allResults);
    }
    return allResults;
  }

  // Get parents from the appropriate tree source based on who found the person
  async getParentsFromSource(personId) {
    const sourceName = this.getSourceOrigin(personId);
    const source = this.getTreeSourceByName(sourceName);

    if (source) {
      try {
        const parents = await source.getParents(personId);
        // Tag parent IDs with the same source origin
        if (parents.father?.id) this.trackSourceOrigin(parents.father.id, sourceName);
        if (parents.mother?.id) this.trackSourceOrigin(parents.mother.id, sourceName);
        return parents;
      } catch (err) {
        console.log(`[MultiSource] ${sourceName}.getParents(${personId}) failed: ${err.message}`);
      }
    }

    // Fallback to direct fsApi if source lookup fails
    try {
      return await fsApi.getParents(personId);
    } catch (err) {
      console.log(`[MultiSource] fsApi.getParents fallback failed for ${personId}: ${err.message}`);
      return { father: null, mother: null };
    }
  }

  // Run FreeBMD confirmation for a verified ancestor
  async runFreeBMDConfirmation(ancestorData, ascNumber) {
    if (this.confirmationSources.length === 0) return { birthConfirmed: false, deathConfirmed: false, bonusPoints: 0 };

    const nameParts = parseNameParts(ancestorData.name || '');
    const birthYear = normalizeDate(ancestorData.birth_date || ancestorData.birthDate)?.year;
    const deathYear = normalizeDate(ancestorData.death_date || ancestorData.deathDate)?.year;
    const birthPlace = ancestorData.birth_place || ancestorData.birthPlace || '';

    let birthConfirmed = false;
    let deathConfirmed = false;
    let bonusPoints = 0;
    const confirmations = [];

    for (const source of this.confirmationSources) {
      try {
        // Confirm birth
        if (birthYear && nameParts.givenName) {
          const birthResult = await source.confirmBirth(
            nameParts.givenName.split(' ')[0], nameParts.surname, birthYear, birthPlace
          );
          if (birthResult) {
            birthConfirmed = true;
            bonusPoints += 15;
            confirmations.push(`${source.sourceName}: birth confirmed (${birthResult.year} Q${birthResult.quarter || '?'} ${birthResult.district || ''})`);
            console.log(`[FreeBMD] asc#${ascNumber}: Birth confirmed — ${nameParts.givenName} ${nameParts.surname} ${birthYear}`);
          }
        }

        // Confirm death
        if (deathYear && nameParts.surname) {
          const deathResult = await source.confirmDeath(
            nameParts.givenName ? nameParts.givenName.split(' ')[0] : '', nameParts.surname, deathYear
          );
          if (deathResult) {
            deathConfirmed = true;
            bonusPoints += 10;
            confirmations.push(`${source.sourceName}: death confirmed (${deathResult.year} Q${deathResult.quarter || '?'})`);
            console.log(`[FreeBMD] asc#${ascNumber}: Death confirmed — ${nameParts.givenName} ${nameParts.surname} ${deathYear}`);
          }
        }
      } catch (err) {
        console.log(`[FreeBMD] ${source.sourceName} confirmation error for asc#${ascNumber}: ${err.message}`);
      }
    }

    return { birthConfirmed, deathConfirmed, bonusPoints, confirmations };
  }

  async run() {
    try {
      this.db.updateResearchJob(this.jobId, { status: 'running' });
      // Do NOT deleteAncestors — pre-populated customer data records must stay
      // Clear only search candidates from any previous run
      this.db.deleteSearchCandidates(this.jobId);

      // Build verification anchors from input data
      this.buildAnchors();

      const totalPossible = Math.pow(2, this.generations + 1) - 1;
      this.db.updateJobProgress(this.jobId, 'Starting research...', 0, totalPossible);

      // Start from customer-provided positions and work outward
      // Subject (asc#1) — try to verify in FS, update pre-populated record
      const subjectInfo = {
        givenName: this.inputData.given_name,
        surname: this.inputData.surname,
        birthDate: this.inputData.birth_date,
        birthPlace: this.inputData.birth_place,
        deathDate: this.inputData.death_date,
        deathPlace: this.inputData.death_place,
      };

      if (this.inputData.father_name) {
        const fp = parseNameParts(this.inputData.father_name);
        subjectInfo.fatherGivenName = fp.givenName;
        subjectInfo.fatherSurname = fp.surname;
      }
      if (this.inputData.mother_name) {
        const mp = parseNameParts(this.inputData.mother_name);
        subjectInfo.motherGivenName = mp.givenName;
        subjectInfo.motherSurname = mp.surname;
      }

      // For customer-provided positions (asc#1/2/3): search FS to find FS person ID
      // for tree traversal. Enrich the record but NEVER lower confidence — customer = 100%.

      // Subject (asc#1)
      const subjectFsId = await this.enrichCustomerAncestor(1, 0, subjectInfo);

      // Father (asc#2)
      let fatherFsId = null;
      if (this.knownAnchors[2]) {
        const fatherInfo = {
          givenName: this.knownAnchors[2].givenName || '',
          surname: this.knownAnchors[2].surname || this.inputData.surname,
          birthDate: this.knownAnchors[2].birthDate || '',
          birthPlace: subjectInfo.birthPlace,
        };
        if (!fatherInfo.birthDate) {
          const subjectBirth = normalizeDate(subjectInfo.birthDate);
          if (subjectBirth?.year) fatherInfo.birthDate = String(subjectBirth.year - 28);
        }
        fatherFsId = await this.enrichCustomerAncestor(2, 1, fatherInfo);
      }

      // Mother (asc#3)
      let motherFsId = null;
      if (this.knownAnchors[3]) {
        const motherInfo = {
          givenName: this.knownAnchors[3].givenName || '',
          surname: this.knownAnchors[3].surname || '',
          birthDate: this.knownAnchors[3].birthDate || '',
          birthPlace: subjectInfo.birthPlace,
        };
        if (!motherInfo.birthDate) {
          const subjectBirth = normalizeDate(subjectInfo.birthDate);
          if (subjectBirth?.year) motherInfo.birthDate = String(subjectBirth.year - 28);
        }
        motherFsId = await this.enrichCustomerAncestor(3, 1, motherInfo);
      }

      // Traverse outward from matched FS persons to find grandparents and beyond
      if (fatherFsId) {
        console.log(`[Engine] Traversing father's parents from ${fatherFsId}`);
        await this.traverseParents(fatherFsId, 2, 1);
      } else if (this.knownAnchors[2]) {
        // Father had no FS match — search for grandparents directly using anchors
        console.log(`[Engine] Father not matched in FS — searching for grandparents directly`);
        await this.searchParentsDirectly(2, 1);
      }
      if (motherFsId) {
        console.log(`[Engine] Traversing mother's parents from ${motherFsId}`);
        await this.traverseParents(motherFsId, 3, 1);
      } else if (this.knownAnchors[3]) {
        // Mother had no FS match — search for grandparents directly using anchors
        console.log(`[Engine] Mother not matched in FS — searching for grandparents directly`);
        await this.searchParentsDirectly(3, 1);
      }
      // Also traverse subject's FS parents (may discover parents not provided by customer)
      if (subjectFsId) {
        console.log(`[Engine] Traversing subject's FS parents from ${subjectFsId}`);
        await this.traverseParents(subjectFsId, 1, 0);
      }
      // If subject also had no FS match but has customer-provided parents, still search outward
      if (!subjectFsId && !fatherFsId && !motherFsId) {
        console.log(`[Engine] No FS matches at all — attempting direct parent searches from subject`);
        await this.searchParentsDirectly(1, 0);
      }

      // Complete
      const ancestors = this.db.getAncestors(this.jobId);
      const verified = ancestors.filter(a => a.confidence_score >= 90).length;
      const probable = ancestors.filter(a => a.confidence_score >= 75 && a.confidence_score < 90).length;
      const possible = ancestors.filter(a => a.confidence_score >= 50 && a.confidence_score < 75).length;
      const rejected = ancestors.filter(a => a.confidence_score < 50).length;

      this.db.updateResearchJob(this.jobId, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        results: {
          total_ancestors: ancestors.length,
          verified,
          probable,
          possible,
          rejected,
        },
      });
      this.db.updateJobProgress(this.jobId, 'Research complete', ancestors.length, ancestors.length);
    } catch (err) {
      console.error(`Research engine error for job ${this.jobId}:`, err);
      this.db.updateResearchJob(this.jobId, {
        status: 'failed',
        error_message: err.message,
      });
    }
  }

  buildAnchors() {
    // Father (asc#2)
    if (this.inputData.father_name) {
      const fp = parseNameParts(this.inputData.father_name);
      this.knownAnchors[2] = { givenName: fp.givenName, surname: fp.surname };
    }

    // Mother (asc#3)
    if (this.inputData.mother_name) {
      const mp = parseNameParts(this.inputData.mother_name);
      this.knownAnchors[3] = { givenName: mp.givenName, surname: mp.surname };
    }

    // Parse notes for grandparent info
    if (this.inputData.notes) {
      const noteAnchors = parseNotesForAnchors(this.inputData.notes);
      for (const [asc, info] of Object.entries(noteAnchors)) {
        this.knownAnchors[parseInt(asc, 10)] = {
          ...(this.knownAnchors[parseInt(asc, 10)] || {}),
          ...info,
        };
      }
    }
  }

  // For customer-provided positions: search FS to find the FS person ID,
  // enrich the pre-populated record with FS data, but keep confidence at 100%.
  // Returns the FS person ID if found (for tree traversal), or null.
  async enrichCustomerAncestor(ascNumber, generation, knownInfo) {
    this.processedCount++;
    const name = knownInfo.givenName
      ? `${knownInfo.givenName} ${knownInfo.surname || ''}`.trim()
      : `Ancestor #${ascNumber}`;
    const sourceNames = this.searchSources.map(s => s.sourceName).join(' + ') || 'FamilySearch';
    this.db.updateJobProgress(
      this.jobId,
      `Looking up ${name} in ${sourceNames} (generation ${generation})`,
      this.processedCount,
      Math.pow(2, this.generations + 1) - 1
    );

    // Run the multi-pass search to find candidates
    const searchLog = [];
    let allCandidates = [];

    if (knownInfo.givenName || knownInfo.surname) {
      allCandidates = await this.multiPassSearch(knownInfo, ascNumber, searchLog);
    }

    if (allCandidates.length === 0) {
      console.log(`[Engine] asc#${ascNumber}: no FS candidates found — keeping customer data at 100%`);
      this.db.updateAncestorByAscNumber(this.jobId, ascNumber, {
        verification_notes: 'Customer-provided data — no matching person found in FamilySearch',
        search_log: searchLog,
      });
      return null;
    }

    // Score candidates
    const expectedGender = this.getExpectedGender(ascNumber);
    const scored = allCandidates.map(c => ({
      ...c,
      computedScore: this.evaluateCandidate(c, knownInfo, expectedGender),
    }));
    scored.sort((a, b) => b.computedScore - a.computedScore);

    // Store all candidates
    for (const candidate of scored) {
      this.db.addSearchCandidate({
        research_job_id: this.jobId,
        target_asc_number: ascNumber,
        fs_person_id: candidate.id,
        name: candidate.name,
        search_pass: candidate.searchPass || 0,
        search_query: candidate.searchQuery || '',
        fs_score: candidate.score || 0,
        computed_score: candidate.computedScore,
        selected: candidate === scored[0] && candidate.computedScore >= 40,
        rejection_reason: candidate.computedScore < 40 ? `Score ${candidate.computedScore} below threshold` : '',
        raw_data: candidate.raw || {},
      });
    }

    const best = scored[0];
    console.log(`[Engine] asc#${ascNumber}: best FS match "${best.name}" score=${best.computedScore}, FS ID=${best.id}`);

    // Enrichment threshold — must be confident it's the right person before linking.
    // HIGHER than verification (65 vs 55) because a wrong FS link cascades through
    // tree traversal, producing entire branches of wrong ancestors.
    if (best.computedScore < 65) {
      console.log(`[Engine] asc#${ascNumber}: best score ${best.computedScore} too low for FS link (need 65) — keeping customer data`);
      this.db.updateAncestorByAscNumber(this.jobId, ascNumber, {
        verification_notes: `Customer-provided data — best FS match "${best.name}" scored ${best.computedScore}/100 (too low to link)`,
        search_log: searchLog,
      });
      return null;
    }

    // GEOGRAPHIC SAFETY CHECK: If the best match is from a non-UK country and this
    // service primarily researches UK genealogy, reject the match even if score is ok.
    const bestBirthPlace = best.birthPlace || '';
    const bestDeathPlace = best.deathPlace || '';
    if ((isNonUkPlace(bestBirthPlace) || isNonUkPlace(bestDeathPlace)) &&
        !isUkPlace(bestBirthPlace) && !isUkPlace(bestDeathPlace)) {
      console.log(`[Engine] asc#${ascNumber}: best match "${best.name}" from non-UK place "${bestBirthPlace || bestDeathPlace}" — rejecting enrichment`);
      this.db.updateAncestorByAscNumber(this.jobId, ascNumber, {
        verification_notes: `Customer-provided data — best FS match "${best.name}" from non-UK place (${bestBirthPlace || bestDeathPlace}) — skipped`,
        search_log: searchLog,
      });
      return null;
    }

    // Enrich: add FS person ID, update dates/places from FS, keep name & confidence at 100%
    const enrichData = {
      fs_person_id: best.id,
      search_log: searchLog,
      verification_notes: `Customer-provided data — linked to FamilySearch person ${best.id} (match score: ${best.computedScore}/100)`,
    };
    // Add FS dates/places only if customer didn't provide them
    const existing = this.db.getAncestorByAscNumber(this.jobId, ascNumber);
    if (existing) {
      if (!existing.birth_date && best.birthDate) enrichData.birth_date = best.birthDate;
      if (!existing.birth_place && best.birthPlace) enrichData.birth_place = sanitizePlaceName(best.birthPlace);
      if (!existing.death_date && best.deathDate) enrichData.death_date = best.deathDate;
      if (!existing.death_place && best.deathPlace) enrichData.death_place = sanitizePlaceName(best.deathPlace);
      // NEVER overwrite gender from FS — it can be wrong. Gender for customer-provided
      // ancestors should come from the form/notes or the asc number (even=Male, odd=Female).
      // Only set gender if it's currently Unknown AND the asc number tells us definitively.
      if (existing.gender === 'Unknown' && ascNumber > 1) {
        enrichData.gender = ascNumber % 2 === 0 ? 'Male' : 'Female';
      }
      this.db.updateAncestorByAscNumber(this.jobId, ascNumber, enrichData);
      console.log(`[Engine] asc#${ascNumber}: enriched with FS ID ${best.id} — confidence stays at 100%`);
    } else {
      // No existing record — create one with FS data
      const fullName = `${knownInfo.givenName || ''} ${knownInfo.surname || ''}`.trim();
      const gender = ascNumber <= 1 ? 'Unknown' : (ascNumber % 2 === 0 ? 'Male' : 'Female');
      this.storeOrUpdateAncestor(ascNumber, generation, {
        name: fullName || best.name,
        gender,
        fs_person_id: best.id,
        birth_date: best.birthDate || knownInfo.birthDate || '',
        birth_place: best.birthPlace ? sanitizePlaceName(best.birthPlace) : (knownInfo.birthPlace || ''),
        death_date: best.deathDate || knownInfo.deathDate || '',
        death_place: best.deathPlace ? sanitizePlaceName(best.deathPlace) : '',
        confidence_score: 100,
        confidence_level: 'Customer Data',
        verification_notes: `Customer-provided data — linked to FamilySearch person ${best.id} (match score: ${best.computedScore}/100)`,
        search_log: searchLog,
      });
      console.log(`[Engine] asc#${ascNumber}: created with FS ID ${best.id} — confidence 100% Customer Data`);
    }

    return best.id;
  }

  // Wrapper used by traverseParents — verify a person in FS and store/update the ancestor record
  async verifyAndUpdate(ascNumber, generation, knownInfo) {
    this.processedCount++;
    const name = knownInfo.givenName
      ? `${knownInfo.givenName} ${knownInfo.surname || ''}`.trim()
      : `Ancestor #${ascNumber}`;
    this.db.updateJobProgress(
      this.jobId,
      `Verifying ${name} (generation ${generation})`,
      this.processedCount,
      Math.pow(2, this.generations + 1) - 1
    );
    return this.verifyPerson(knownInfo, ascNumber, generation);
  }

  // From a verified person, get their parents from FS and traverse each branch
  // Search for parents directly when we have no FS person ID for the child.
  // Uses known anchors (grandparent names from notes) and child's surname/birthplace.
  // Anchor ancestors are CUSTOMER DATA — stored at 100% confidence, then we try to
  // find their FS person ID for tree traversal (same as father/mother treatment).
  async searchParentsDirectly(fromAsc, fromGen) {
    if (fromGen >= this.generations) return;

    const childRecord = this.db.getAncestorByAscNumber(this.jobId, fromAsc);
    if (!childRecord) return;

    const childBirth = normalizeDate(childRecord.birth_date);
    const estimatedParentBirth = childBirth?.year ? String(childBirth.year - 28) : null;
    const childSurname = parseNameParts(childRecord.name).surname;
    const childBirthPlace = childRecord.birth_place || '';

    const fatherAsc = fromAsc * 2;
    const motherAsc = fromAsc * 2 + 1;
    const nextGen = fromGen + 1;

    // --- Father ---
    const fatherAnchor = this.knownAnchors[fatherAsc];
    if ((fatherAnchor?.givenName || childSurname) && nextGen <= this.generations) {
      const existingFather = this.db.getAncestorByAscNumber(this.jobId, fatherAsc);

      if (fatherAnchor?.givenName && !existingFather) {
        // Customer gave us this person's name — pre-populate as Customer Data at 100%
        const fullName = `${fatherAnchor.givenName} ${fatherAnchor.surname || ''}`.trim();
        console.log(`[DirectSearch] Pre-populating father (asc#${fatherAsc}): ${fullName} as Customer Data`);
        this.db.addAncestor({
          research_job_id: this.jobId,
          fs_person_id: '',
          name: fullName,
          gender: 'Male',
          birth_date: fatherAnchor.birthDate || '',
          birth_place: fatherAnchor.birthPlace || childBirthPlace,
          death_date: fatherAnchor.deathDate || '',
          death_place: fatherAnchor.deathPlace || '',
          ascendancy_number: fatherAsc,
          generation: nextGen,
          confidence: 'customer_data',
          sources: [],
          raw_data: {},
          confidence_score: 100,
          confidence_level: 'Customer Data',
          evidence_chain: [],
          search_log: [],
          conflicts: [],
          verification_notes: 'Customer-provided data (from notes)',
        });
        // Now try to find their FS person ID (enrichment only — stays at 100%)
        const fatherInfo = {
          givenName: fatherAnchor.givenName,
          surname: fatherAnchor.surname || childSurname,
          birthDate: fatherAnchor.birthDate || estimatedParentBirth || '',
          birthPlace: fatherAnchor.birthPlace || childBirthPlace,
          deathDate: fatherAnchor.deathDate || '',
        };
        const fsId = await this.enrichCustomerAncestor(fatherAsc, nextGen, fatherInfo);
        if (fsId) {
          await this.traverseParents(fsId, fatherAsc, nextGen);
        } else {
          // No FS match — still search for THEIR parents if we have anchor data
          await this.searchParentsDirectly(fatherAsc, nextGen);
        }
      } else if (!existingFather && !fatherAnchor?.givenName) {
        // No anchor data, just guessing from child's surname — use verify (not customer data)
        const fatherSearch = {
          givenName: '',
          surname: childSurname,
          birthDate: estimatedParentBirth || '',
          birthPlace: childBirthPlace,
          deathDate: '',
        };
        console.log(`[DirectSearch] Searching for unknown father (asc#${fatherAsc}): ${fatherSearch.surname}, b.${fatherSearch.birthDate}`);
        const fResult = await this.verifyAndUpdate(fatherAsc, nextGen, fatherSearch);
        if (fResult.verified && fResult.personId) {
          await this.traverseParents(fResult.personId, fatherAsc, nextGen);
        }
      } else if (existingFather?.fs_person_id) {
        await this.traverseParents(existingFather.fs_person_id, fatherAsc, nextGen);
      } else if (existingFather && existingFather.confidence_level === 'Customer Data' && fatherAnchor?.givenName) {
        // Customer Data record with no FS ID — try to enrich first, then traverse
        const fatherInfo = {
          givenName: fatherAnchor.givenName,
          surname: fatherAnchor.surname || childSurname,
          birthDate: fatherAnchor.birthDate || existingFather.birth_date || estimatedParentBirth || '',
          birthPlace: fatherAnchor.birthPlace || existingFather.birth_place || childBirthPlace,
          deathDate: fatherAnchor.deathDate || existingFather.death_date || '',
        };
        console.log(`[DirectSearch] Enriching pre-populated father (asc#${fatherAsc}): ${existingFather.name}`);
        const fsId = await this.enrichCustomerAncestor(fatherAsc, nextGen, fatherInfo);
        if (fsId) {
          await this.traverseParents(fsId, fatherAsc, nextGen);
        } else {
          await this.searchParentsDirectly(fatherAsc, nextGen);
        }
      } else if (existingFather) {
        // Record exists but no FS ID — still search for their parents
        await this.searchParentsDirectly(fatherAsc, nextGen);
      }
    }

    // --- Mother --- only if we have anchor data (can't guess mother's maiden name)
    const motherAnchor = this.knownAnchors[motherAsc];
    if (motherAnchor?.givenName && nextGen <= this.generations) {
      const existingMother = this.db.getAncestorByAscNumber(this.jobId, motherAsc);

      if (!existingMother) {
        // Customer gave us this person's name — pre-populate as Customer Data at 100%
        const fullName = `${motherAnchor.givenName} ${motherAnchor.surname || ''}`.trim();
        console.log(`[DirectSearch] Pre-populating mother (asc#${motherAsc}): ${fullName} as Customer Data`);
        this.db.addAncestor({
          research_job_id: this.jobId,
          fs_person_id: '',
          name: fullName,
          gender: 'Female',
          birth_date: motherAnchor.birthDate || '',
          birth_place: motherAnchor.birthPlace || childBirthPlace,
          death_date: motherAnchor.deathDate || '',
          death_place: motherAnchor.deathPlace || '',
          ascendancy_number: motherAsc,
          generation: nextGen,
          confidence: 'customer_data',
          sources: [],
          raw_data: {},
          confidence_score: 100,
          confidence_level: 'Customer Data',
          evidence_chain: [],
          search_log: [],
          conflicts: [],
          verification_notes: 'Customer-provided data (from notes)',
        });
        // Now try to find their FS person ID (enrichment only — stays at 100%)
        const motherInfo = {
          givenName: motherAnchor.givenName,
          surname: motherAnchor.surname || '',
          birthDate: motherAnchor.birthDate || estimatedParentBirth || '',
          birthPlace: motherAnchor.birthPlace || childBirthPlace,
          deathDate: motherAnchor.deathDate || '',
        };
        const fsId = await this.enrichCustomerAncestor(motherAsc, nextGen, motherInfo);
        if (fsId) {
          await this.traverseParents(fsId, motherAsc, nextGen);
        } else {
          await this.searchParentsDirectly(motherAsc, nextGen);
        }
      } else if (existingMother.fs_person_id) {
        await this.traverseParents(existingMother.fs_person_id, motherAsc, nextGen);
      } else if (existingMother && existingMother.confidence_level === 'Customer Data' && motherAnchor?.givenName) {
        // Customer Data record with no FS ID — try to enrich first, then traverse
        const motherInfo = {
          givenName: motherAnchor.givenName,
          surname: motherAnchor.surname || '',
          birthDate: motherAnchor.birthDate || existingMother.birth_date || estimatedParentBirth || '',
          birthPlace: motherAnchor.birthPlace || existingMother.birth_place || childBirthPlace,
          deathDate: motherAnchor.deathDate || existingMother.death_date || '',
        };
        console.log(`[DirectSearch] Enriching pre-populated mother (asc#${motherAsc}): ${existingMother.name}`);
        const fsId = await this.enrichCustomerAncestor(motherAsc, nextGen, motherInfo);
        if (fsId) {
          await this.traverseParents(fsId, motherAsc, nextGen);
        } else {
          await this.searchParentsDirectly(motherAsc, nextGen);
        }
      } else {
        // Record exists but no FS ID — still search for their parents
        await this.searchParentsDirectly(motherAsc, nextGen);
      }
    }
  }

  async traverseParents(personId, fromAsc, fromGen) {
    console.log(`[Traverse] traverseParents(${personId}, asc#${fromAsc}, gen${fromGen}) — maxGen=${this.generations}`);
    if (fromGen >= this.generations) {
      console.log(`[Traverse] Stopping: gen ${fromGen} >= maxGen ${this.generations}`);
      return;
    }

    // Prevent circular references
    if (this.visitedIds.has(personId)) {
      console.log(`[Traverse] Already visited ${personId}`);
      return;
    }
    this.visitedIds.add(personId);

    let parents;
    const sourceOrigin = this.getSourceOrigin(personId);
    try {
      parents = await this.getParentsFromSource(personId);
      // Mark getParents results as tree-sourced (they're linked in a tree)
      if (parents.father) {
        parents.father._fromTree = true;
        this.trackSourceOrigin(parents.father.id, sourceOrigin);
      }
      if (parents.mother) {
        parents.mother._fromTree = true;
        this.trackSourceOrigin(parents.mother.id, sourceOrigin);
      }
      console.log(`[Traverse] Parents for ${personId} (${sourceOrigin}): father=${parents.father?.id || 'none'}, mother=${parents.mother?.id || 'none'}`);
    } catch (err) {
      console.log(`Could not get parents for ${personId}: ${err.message}`);
      parents = { father: null, mother: null };
    }

    // GEOGRAPHIC FILTER: Reject tree-linked parents from clearly wrong countries.
    // FamilySearch trees are user-submitted and can link to wrong people.
    if (parents.father) {
      const fPlace = parents.father.birthPlace || parents.father.deathPlace || '';
      if (isNonUkPlace(fPlace) && !isUkPlace(fPlace)) {
        console.log(`[Traverse] REJECTED tree father "${parents.father.name}" — non-UK place: ${fPlace}`);
        parents.father = null;
      }
    }
    if (parents.mother) {
      const mPlace = parents.mother.birthPlace || parents.mother.deathPlace || '';
      if (isNonUkPlace(mPlace) && !isUkPlace(mPlace)) {
        console.log(`[Traverse] REJECTED tree mother "${parents.mother.name}" — non-UK place: ${mPlace}`);
        parents.mother = null;
      }
    }

    // GENERATION PLAUSIBILITY: parent's birth should be ~12-55 years before child
    const childRecord = this.db.getAncestorByAscNumber(this.jobId, fromAsc);
    const childBirthYear = childRecord ? normalizeDate(childRecord.birth_date)?.year : null;

    if (childBirthYear && parents.father) {
      const fatherBirthYear = normalizeDate(parents.father.birthDate)?.year;
      if (fatherBirthYear) {
        const gap = childBirthYear - fatherBirthYear;
        if (gap < 12 || gap > 55) {
          console.log(`[Traverse] REJECTED tree father "${parents.father.name}" — implausible gap: child born ${childBirthYear}, father born ${fatherBirthYear} (gap=${gap})`);
          parents.father = null;
        }
      }
    }
    if (childBirthYear && parents.mother) {
      const motherBirthYear = normalizeDate(parents.mother.birthDate)?.year;
      if (motherBirthYear) {
        const gap = childBirthYear - motherBirthYear;
        if (gap < 12 || gap > 50) {
          console.log(`[Traverse] REJECTED tree mother "${parents.mother.name}" — implausible gap: child born ${childBirthYear}, mother born ${motherBirthYear} (gap=${gap})`);
          parents.mother = null;
        }
      }
    }

    // Fallback 1: If getParents returned nothing, try the ancestry/pedigree endpoint
    // Try each tree source for ancestry data
    if (!parents.father && !parents.mother) {
      for (const treeSource of this.treeSources) {
        if (parents.father || parents.mother) break; // Found something, stop trying
        try {
          console.log(`[Traverse] getParents empty — trying ${treeSource.sourceName} ancestry for ${personId}`);
          const ancestry = await treeSource.getAncestry(personId, 1);
          for (const p of ancestry) {
            const ascNum = p.ascendancy_number;
            if (ascNum === 2 && !parents.father) {
              parents.father = {
                id: p.fs_person_id || p.id,
                name: p.name,
                gender: p.gender || 'Male',
                birthDate: p.birthDate || '',
                birthPlace: p.birthPlace || '',
                deathDate: p.deathDate || '',
                deathPlace: p.deathPlace || '',
                _fromTree: true,
              };
              this.trackSourceOrigin(parents.father.id, treeSource.sourceName);
              console.log(`[Traverse] ${treeSource.sourceName} ancestry found father: ${p.name} (${parents.father.id})`);
            }
            if (ascNum === 3 && !parents.mother) {
              parents.mother = {
                id: p.fs_person_id || p.id,
                name: p.name,
                gender: p.gender || 'Female',
                birthDate: p.birthDate || '',
                birthPlace: p.birthPlace || '',
                deathDate: p.deathDate || '',
                deathPlace: p.deathPlace || '',
                _fromTree: true,
              };
              this.trackSourceOrigin(parents.mother.id, treeSource.sourceName);
              console.log(`[Traverse] ${treeSource.sourceName} ancestry found mother: ${p.name} (${parents.mother.id})`);
            }
          }
        } catch (err) {
          console.log(`[Traverse] ${treeSource.sourceName} ancestry failed for ${personId}: ${err.message}`);
        }
      }
    }

    // Fallback 2: If still no parents, SEARCH for them using child's data
    if (!parents.father && !parents.mother) {
      console.log(`[Traverse] Both fallbacks empty — searching for parents of asc#${fromAsc}`);
      const childRecord = this.db.getAncestorByAscNumber(this.jobId, fromAsc);
      if (childRecord) {
        const childBirth = normalizeDate(childRecord.birth_date);
        const estimatedParentBirth = childBirth?.year ? String(childBirth.year - 28) : null;
        const childSurname = parseNameParts(childRecord.name).surname;

        // Synthesize parent objects from search so the main logic below can handle them
        const fatherAscNum = fromAsc * 2;
        const motherAscNum = fromAsc * 2 + 1;
        const fatherAnchor = this.knownAnchors[fatherAscNum];
        const motherAnchor = this.knownAnchors[motherAscNum];

        // Search for father — use multi-source search
        if (fatherAnchor?.givenName || childSurname) {
          const fatherSearch = {
            givenName: fatherAnchor?.givenName || '',
            surname: fatherAnchor?.surname || childSurname,
            birthDate: fatherAnchor?.birthDate || estimatedParentBirth || '',
            birthPlace: fatherAnchor?.birthPlace || childRecord.birth_place || '',
          };
          console.log(`[Traverse] Multi-source searching for father: ${fatherSearch.givenName} ${fatherSearch.surname}`);
          try {
            const results = await this.multiSourceSearch({ ...fatherSearch, count: 5 });
            if (results.length > 0) {
              const expectedGender = 'Male';
              const scored = results.map(c => ({
                ...c,
                computedScore: this.evaluateCandidate(c, fatherSearch, expectedGender),
              }));
              scored.sort((a, b) => b.computedScore - a.computedScore);
              if (scored[0].computedScore >= 55) {
                parents.father = {
                  id: scored[0].id,
                  name: scored[0].name,
                  gender: scored[0].gender || 'Male',
                  birthDate: scored[0].birthDate || '',
                  birthPlace: scored[0].birthPlace || '',
                  deathDate: scored[0].deathDate || '',
                  deathPlace: scored[0].deathPlace || '',
                };
                this.trackSourceOrigin(scored[0].id, scored[0]._source || 'FamilySearch');
                console.log(`[Traverse] Search found father: ${scored[0].name} (${scored[0].id}) score=${scored[0].computedScore} [${scored[0]._source || 'FS'}]`);
              }
            }
          } catch (err) {
            console.log(`[Traverse] Father search failed: ${err.message}`);
          }
        }

        // Search for mother — use multi-source search
        if (motherAnchor?.givenName || motherAnchor?.surname) {
          const motherSearch = {
            givenName: motherAnchor?.givenName || '',
            surname: motherAnchor?.surname || '',
            birthDate: motherAnchor?.birthDate || estimatedParentBirth || '',
            birthPlace: motherAnchor?.birthPlace || childRecord.birth_place || '',
          };
          console.log(`[Traverse] Multi-source searching for mother: ${motherSearch.givenName} ${motherSearch.surname}`);
          try {
            const results = await this.multiSourceSearch({ ...motherSearch, count: 5 });
            if (results.length > 0) {
              const expectedGender = 'Female';
              const scored = results.map(c => ({
                ...c,
                computedScore: this.evaluateCandidate(c, motherSearch, expectedGender),
              }));
              scored.sort((a, b) => b.computedScore - a.computedScore);
              if (scored[0].computedScore >= 55) {
                parents.mother = {
                  id: scored[0].id,
                  name: scored[0].name,
                  gender: scored[0].gender || 'Female',
                  birthDate: scored[0].birthDate || '',
                  birthPlace: scored[0].birthPlace || '',
                  deathDate: scored[0].deathDate || '',
                  deathPlace: scored[0].deathPlace || '',
                };
                this.trackSourceOrigin(scored[0].id, scored[0]._source || 'FamilySearch');
                console.log(`[Traverse] Search found mother: ${scored[0].name} (${scored[0].id}) score=${scored[0].computedScore} [${scored[0]._source || 'FS'}]`);
              }
            }
          } catch (err) {
            console.log(`[Traverse] Mother search failed: ${err.message}`);
          }
        }
      }
    }

    const fatherAsc = fromAsc * 2;
    const motherAsc = fromAsc * 2 + 1;
    const nextGen = fromGen + 1;

    // Father
    if (parents.father && nextGen <= this.generations) {
      const fatherKnown = this.buildParentKnownInfo(parents.father, fatherAsc);

      // Check if this position already has a record (e.g., pre-populated)
      const existingFather = this.db.getAncestorByAscNumber(this.jobId, fatherAsc);
      if (!existingFather) {
        const fResult = await this.verifyAndUpdate(fatherAsc, nextGen, fatherKnown);
        if (fResult.verified && fResult.personId) {
          await this.traverseParents(fResult.personId, fatherAsc, nextGen);
        }
      } else if (existingFather.confidence_level === 'Customer Data') {
        // Customer Data — enrich (preserve 100% confidence), don't verify
        if (!existingFather.fs_person_id) {
          console.log(`[Traverse] Customer Data at asc#${fatherAsc} — enriching, not overwriting`);
          const fsId = await this.enrichCustomerAncestor(fatherAsc, nextGen, fatherKnown);
          if (fsId) {
            await this.traverseParents(fsId, fatherAsc, nextGen);
          }
        } else {
          await this.traverseParents(existingFather.fs_person_id, fatherAsc, nextGen);
        }
      }
    } else if (this.knownAnchors[fatherAsc] && nextGen <= this.generations) {
      const anchorInfo = this.knownAnchors[fatherAsc];
      if (anchorInfo.givenName || anchorInfo.surname) {
        const existingFather = this.db.getAncestorByAscNumber(this.jobId, fatherAsc);
        if (existingFather?.confidence_level === 'Customer Data' && !existingFather.fs_person_id) {
          const fsId = await this.enrichCustomerAncestor(fatherAsc, nextGen, anchorInfo);
          if (fsId) await this.traverseParents(fsId, fatherAsc, nextGen);
        } else if (!existingFather) {
          const fResult = await this.verifyAndUpdate(fatherAsc, nextGen, anchorInfo);
          if (fResult.verified && fResult.personId) {
            await this.traverseParents(fResult.personId, fatherAsc, nextGen);
          }
        } else if (existingFather?.fs_person_id) {
          await this.traverseParents(existingFather.fs_person_id, fatherAsc, nextGen);
        }
      }
    }

    // Mother
    if (parents.mother && nextGen <= this.generations) {
      const motherKnown = this.buildParentKnownInfo(parents.mother, motherAsc);

      const existingMother = this.db.getAncestorByAscNumber(this.jobId, motherAsc);
      if (!existingMother) {
        const mResult = await this.verifyAndUpdate(motherAsc, nextGen, motherKnown);
        if (mResult.verified && mResult.personId) {
          await this.traverseParents(mResult.personId, motherAsc, nextGen);
        }
      } else if (existingMother.confidence_level === 'Customer Data') {
        // Customer Data — enrich (preserve 100% confidence), don't verify
        if (!existingMother.fs_person_id) {
          console.log(`[Traverse] Customer Data at asc#${motherAsc} — enriching, not overwriting`);
          const fsId = await this.enrichCustomerAncestor(motherAsc, nextGen, motherKnown);
          if (fsId) {
            await this.traverseParents(fsId, motherAsc, nextGen);
          }
        } else {
          await this.traverseParents(existingMother.fs_person_id, motherAsc, nextGen);
        }
      }
    } else if (this.knownAnchors[motherAsc] && nextGen <= this.generations) {
      const anchorInfo = this.knownAnchors[motherAsc];
      if (anchorInfo.givenName || anchorInfo.surname) {
        const existingMother = this.db.getAncestorByAscNumber(this.jobId, motherAsc);
        if (existingMother?.confidence_level === 'Customer Data' && !existingMother.fs_person_id) {
          const fsId = await this.enrichCustomerAncestor(motherAsc, nextGen, anchorInfo);
          if (fsId) await this.traverseParents(fsId, motherAsc, nextGen);
        } else if (!existingMother) {
          const mResult = await this.verifyAndUpdate(motherAsc, nextGen, anchorInfo);
          if (mResult.verified && mResult.personId) {
            await this.traverseParents(mResult.personId, motherAsc, nextGen);
          }
        } else if (existingMother?.fs_person_id) {
          await this.traverseParents(existingMother.fs_person_id, motherAsc, nextGen);
        }
      }
    }
  }

  buildParentKnownInfo(fsParent, ascNumber) {
    const knownInfo = {
      givenName: '',
      surname: '',
      birthDate: fsParent.birthDate || '',
      birthPlace: fsParent.birthPlace || '',
      deathDate: fsParent.deathDate || '',
      deathPlace: fsParent.deathPlace || '',
      fsPersonId: fsParent.id, // FS already has a candidate — we'll verify them
      fromFsTree: !!fsParent._fromTree, // True only when linked in FS tree (getParents/ancestry)
    };

    // Parse the FS parent name
    if (fsParent.name) {
      const parts = parseNameParts(fsParent.name);
      knownInfo.givenName = parts.givenName;
      knownInfo.surname = parts.surname;
    }

    // Merge with any customer-provided anchor data (anchors take priority)
    const anchor = this.knownAnchors[ascNumber];
    if (anchor) {
      if (anchor.givenName) knownInfo.givenName = anchor.givenName;
      if (anchor.surname) knownInfo.surname = anchor.surname;
      if (anchor.birthDate) knownInfo.birthDate = anchor.birthDate;
      if (anchor.birthPlace) knownInfo.birthPlace = anchor.birthPlace;
    }

    // Add child's birth year for generation plausibility scoring
    const childAsc = Math.floor(ascNumber / 2);
    const childRecord = this.db.getAncestorByAscNumber(this.jobId, childAsc);
    if (childRecord) {
      const childBirth = normalizeDate(childRecord.birth_date);
      if (childBirth?.year) knownInfo._childBirthYear = childBirth.year;
    }

    return knownInfo;
  }

  storeOrUpdateAncestor(ascNumber, generation, data) {
    const existing = this.db.getAncestorByAscNumber(this.jobId, ascNumber);
    if (existing) {
      // NEVER overwrite Customer Data with a lower-confidence result.
      // Customer-provided data is always authoritative. Only enrichCustomerAncestor
      // (which preserves 100% confidence) should touch these records.
      if (existing.confidence_level === 'Customer Data' && data.confidence_level !== 'Customer Data') {
        console.log(`[Engine] asc#${ascNumber}: PROTECTED — not overwriting Customer Data (${existing.name}) with ${data.confidence_level || 'engine'} result (${data.name || '?'})`);
        return;
      }
      // Update existing record
      // updateAncestorByAscNumber handles JSON serialization for objects/arrays
      this.db.updateAncestorByAscNumber(this.jobId, ascNumber, data);
    } else {
      // Insert new record
      this.db.addAncestor({
        research_job_id: this.jobId,
        ascendancy_number: ascNumber,
        generation,
        ...data,
      });
    }
  }

  async verifyPerson(knownInfo, ascNumber, generation) {
    const searchLog = [];
    let allCandidates = [];

    // If we already have an FS person ID from the parent lookup, verify that person directly
    if (knownInfo.fsPersonId) {
      const directCandidate = await this.verifyDirectCandidate(knownInfo, ascNumber);
      if (directCandidate) {
        allCandidates.push(directCandidate);
        searchLog.push({ pass: 0, strategy: 'direct_parent', query: `Person ID: ${knownInfo.fsPersonId}`, results_count: 1 });
      }
    }

    // Multi-pass search to find additional/better candidates
    if (!knownInfo.givenName && !knownInfo.surname) {
      // Nothing to search for
      if (allCandidates.length === 0) {
        return this.storeRejected(ascNumber, generation, knownInfo, searchLog, 'No name information available');
      }
    } else {
      const searchCandidates = await this.multiPassSearch(knownInfo, ascNumber, searchLog);
      // Merge and deduplicate
      for (const c of searchCandidates) {
        if (!allCandidates.find(existing => existing.id === c.id)) {
          allCandidates.push(c);
        }
      }
    }

    if (allCandidates.length === 0) {
      return this.storeRejected(ascNumber, generation, knownInfo, searchLog, 'No candidates found in any search pass');
    }

    // Score all candidates
    const expectedGender = this.getExpectedGender(ascNumber);
    const scored = allCandidates.map(candidate => {
      let score = this.evaluateCandidate(candidate, knownInfo, expectedGender);

      // Tree-link bonus: GRADUATED based on supporting evidence quality.
      // FS user-submitted trees are unreliable — the bonus must be earned.
      if (knownInfo.fromFsTree && knownInfo.fsPersonId && candidate.id === knownInfo.fsPersonId) {
        const treeCandidatePlace = candidate.birthPlace || candidate.deathPlace || '';
        if (isNonUkPlace(treeCandidatePlace) && !isUkPlace(treeCandidatePlace)) {
          console.log(`[Score] asc#${ascNumber}: Tree-link from non-UK place "${treeCandidatePlace}" — NO bonus AND -10 penalty for ${candidate.name}`);
          score = Math.max(0, score - 10);
        } else {
          // Graduated bonus based on corroborating evidence
          const cb = normalizeDate(candidate.birthDate);
          const kb = normalizeDate(knownInfo.birthDate);
          const bDiff = yearDiff(cb, kb);
          const hasDateMatch = bDiff !== null && bDiff <= 3;
          const hasPlaceMatch = candidate.birthPlace && knownInfo.birthPlace &&
            placeSpecificityScore(candidate.birthPlace, knownInfo.birthPlace) !== null;

          let bonus;
          if (hasDateMatch && hasPlaceMatch) {
            bonus = 20;  // Strong evidence: tree + date + place
          } else if (hasDateMatch) {
            bonus = 12;  // Medium: tree + date
          } else if (hasPlaceMatch) {
            bonus = 10;  // Medium: tree + place
          } else {
            bonus = 5;   // Weak: tree link alone, no corroboration
          }
          score = Math.min(100, score + bonus);
          console.log(`[Score] asc#${ascNumber}: Tree-link bonus +${bonus} (date=${hasDateMatch}, place=${hasPlaceMatch}) for ${candidate.name} → ${score}`);
        }
      }

      // Blacklist check: if this FS person was previously rejected by admin, zero their score
      const isBlacklisted = this.rejectedFsIds.has(candidate.id);
      if (isBlacklisted) {
        console.log(`[Score] asc#${ascNumber}: BLACKLISTED ${candidate.name} (${candidate.id}) — previously rejected by admin`);
      }

      return { ...candidate, computedScore: isBlacklisted ? 0 : score, blacklisted: isBlacklisted };
    });

    // Sort by score descending
    scored.sort((a, b) => b.computedScore - a.computedScore);

    // Store all candidates in search_candidates table
    for (const candidate of scored) {
      let rejReason = '';
      if (candidate.blacklisted) {
        rejReason = 'Previously rejected by admin — blacklisted';
      } else if (candidate.computedScore < 55) {
        rejReason = `Score ${candidate.computedScore} below threshold`;
      }
      this.db.addSearchCandidate({
        research_job_id: this.jobId,
        target_asc_number: ascNumber,
        fs_person_id: candidate.id,
        name: candidate.name,
        search_pass: candidate.searchPass || 0,
        search_query: candidate.searchQuery || '',
        fs_score: candidate.score || 0,
        computed_score: candidate.computedScore,
        selected: candidate === scored[0] && candidate.computedScore >= 55 && !candidate.blacklisted,
        rejection_reason: rejReason,
        raw_data: candidate.raw || {},
      });
    }

    const best = scored[0];
    console.log(`[Score] asc#${ascNumber}: ${scored.length} candidates. Best: "${best.name}" score=${best.computedScore}, FS score=${best.score}`);
    if (scored.length > 1) {
      console.log(`[Score] asc#${ascNumber}: Runner-up: "${scored[1].name}" score=${scored[1].computedScore}`);
    }

    if (best.computedScore < 55) {
      // If tree-linked and below 40, don't even store — they're from a wrong tree
      if (knownInfo.fromFsTree && knownInfo.fsPersonId && best.id === knownInfo.fsPersonId && best.computedScore < 40) {
        console.log(`[Score] asc#${ascNumber}: Tree-linked "${best.name}" scored ${best.computedScore} < 40 — wrong tree, skipping entirely`);
        return { verified: false, personId: null, confidence: 0, searchLog };
      }
      return this.storeRejected(ascNumber, generation, knownInfo, searchLog,
        `Best candidate score ${best.computedScore} below threshold of 55`);
    }

    // Fetch and score evidence
    let evidenceResult = { score: 0, evidence: [], sourceTypes: new Set() };
    try {
      const sources = await fsApi.getPersonSources(best.id);
      evidenceResult = scoreEvidence(sources);
    } catch {
      // Sources are optional
    }

    // Calculate final confidence
    let finalConfidence = Math.round(best.computedScore * 0.6 + evidenceResult.score * 0.4);

    // Tree-linked parents: adjust floor based on evidence quality.
    // Better corroboration (dates/places match) = higher floor.
    if (knownInfo.fromFsTree && knownInfo.fsPersonId && best.id === knownInfo.fsPersonId) {
      const cb = normalizeDate(best.birthDate);
      const kb = normalizeDate(knownInfo.birthDate);
      const bDiff = yearDiff(cb, kb);
      const hasDateCorr = bDiff !== null && bDiff <= 3;
      const hasPlaceCorr = best.birthPlace && knownInfo.birthPlace &&
        placeSpecificityScore(best.birthPlace, knownInfo.birthPlace) !== null;

      const floorPct = (hasDateCorr && hasPlaceCorr) ? 0.85 :
                       (hasDateCorr || hasPlaceCorr) ? 0.80 :
                       0.70; // Weak evidence = lower floor
      const treeFloor = Math.round(best.computedScore * floorPct);
      if (treeFloor > finalConfidence) {
        finalConfidence = treeFloor;
      }
    }

    // Multi-source bonus: if this person was found in multiple sources (FS + Geni)
    const candidateSources = best._sources || [best._source || 'FamilySearch'];
    const msBonus = multiSourceBonus(candidateSources);
    if (msBonus > 0) {
      finalConfidence = Math.min(100, finalConfidence + msBonus);
      console.log(`[Score] asc#${ascNumber}: Multi-source bonus +${msBonus} (found in ${candidateSources.join(', ')}) → ${finalConfidence}`);
    }

    // FreeBMD confirmation — run in parallel for birth and death
    let freebmdConfirmations = [];
    try {
      const confirmation = await this.runFreeBMDConfirmation({
        name: best.name,
        birth_date: best.birthDate,
        birth_place: best.birthPlace,
        death_date: best.deathDate,
        death_place: best.deathPlace,
      }, ascNumber);

      if (confirmation.bonusPoints > 0) {
        finalConfidence = Math.min(100, finalConfidence + confirmation.bonusPoints);
        freebmdConfirmations = confirmation.confirmations;
        console.log(`[Score] asc#${ascNumber}: FreeBMD confirmation bonus +${confirmation.bonusPoints} → ${finalConfidence}`);
      }
    } catch (err) {
      console.log(`[Score] asc#${ascNumber}: FreeBMD confirmation failed (non-blocking): ${err.message}`);
    }

    const confidenceLevel = this.getConfidenceLevel(finalConfidence);

    // Build verification notes
    const notes = [];
    if (knownInfo.fromFsTree && knownInfo.fsPersonId && best.id === knownInfo.fsPersonId) {
      notes.push('Linked in FamilySearch tree (parent relationship) — high trust');
    } else if (knownInfo.fsPersonId && best.id === knownInfo.fsPersonId) {
      notes.push('Verified against FamilySearch parent link');
    }
    if (candidateSources.length > 1) {
      notes.push(`Found in multiple sources: ${candidateSources.join(', ')}`);
    }
    if (freebmdConfirmations.length > 0) {
      notes.push(...freebmdConfirmations);
    }
    const anchor = this.knownAnchors[ascNumber];
    if (anchor) {
      notes.push('Cross-referenced with customer-provided information');
    }
    notes.push(`Search score: ${best.computedScore}/100, Evidence score: ${evidenceResult.score}/100`);

    // Build confirmed_by list for the ancestor record
    const confirmedBy = [...candidateSources];
    if (freebmdConfirmations.length > 0 && !confirmedBy.includes('FreeBMD')) {
      confirmedBy.push('FreeBMD');
    }

    // Store or update the verified ancestor
    const ancestorData = {
      fs_person_id: best.id,
      name: best.name,
      gender: best.gender,
      birth_date: best.birthDate,
      birth_place: sanitizePlaceName(best.birthPlace),
      death_date: best.deathDate,
      death_place: sanitizePlaceName(best.deathPlace),
      confidence: confidenceLevel.toLowerCase(),
      sources: evidenceResult.evidence.map(e => ({ title: e.title, url: e.url, citation: e.citation })),
      raw_data: best.raw || {},
      confidence_score: finalConfidence,
      confidence_level: confidenceLevel,
      evidence_chain: evidenceResult.evidence,
      search_log: searchLog,
      conflicts: [],
      verification_notes: notes.join('. '),
      source_origin: best._source || this.getSourceOrigin(best.id) || 'FamilySearch',
      confirmed_by: confirmedBy,
    };

    this.storeOrUpdateAncestor(ascNumber, generation, ancestorData);

    return { verified: finalConfidence >= 55, personId: best.id, confidence: finalConfidence, searchLog };
  }

  async verifyDirectCandidate(knownInfo, ascNumber) {
    try {
      const person = await fsApi.getPersonDetails(knownInfo.fsPersonId);
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
        score: 0,
        facts: person.facts || [],
        raw: person,
        searchPass: 0,
        searchQuery: 'Direct parent lookup',
      };
    } catch {
      return null;
    }
  }

  async multiPassSearch(knownInfo, ascNumber, searchLog) {
    const allCandidates = [];
    const seenIds = new Set();

    const addResults = (results, pass, query) => {
      for (const r of results) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          allCandidates.push({ ...r, searchPass: pass, searchQuery: query });
        }
      }
    };

    // Normalize dates for API — FS expects "1 September 1959", not "01.09.59"
    const apiBirthDate = formatDateForApi(knownInfo.birthDate);
    const apiDeathDate = formatDateForApi(knownInfo.deathDate);
    const apiBirthYear = formatYearOnly(knownInfo.birthDate);

    console.log(`[Search] asc#${ascNumber}: name="${knownInfo.givenName} ${knownInfo.surname}", birthDate="${knownInfo.birthDate}" → API: "${apiBirthDate}", year: "${apiBirthYear}"`);
    if (knownInfo.fatherGivenName) console.log(`[Search] asc#${ascNumber}: father="${knownInfo.fatherGivenName} ${knownInfo.fatherSurname || ''}", mother="${knownInfo.motherGivenName || ''} ${knownInfo.motherSurname || ''}"`);

    // Pass 1: EXACT — all known fields including parent names
    const pass1Query = {
      givenName: knownInfo.givenName,
      surname: knownInfo.surname,
      birthDate: apiBirthDate,
      birthPlace: knownInfo.birthPlace,
      deathDate: apiDeathDate,
      deathPlace: knownInfo.deathPlace,
      fatherGivenName: knownInfo.fatherGivenName,
      fatherSurname: knownInfo.fatherSurname,
      motherGivenName: knownInfo.motherGivenName,
      motherSurname: knownInfo.motherSurname,
      count: 10,
    };
    try {
      const results = await fsApi.searchPerson(pass1Query);
      addResults(results, 1, JSON.stringify(pass1Query));
      searchLog.push({ pass: 1, strategy: 'exact', query: pass1Query, results_count: results.length });

      // If we got a strong match (80+), skip remaining passes
      if (results.length > 0) {
        const expectedGender = this.getExpectedGender(ascNumber);
        const topScore = this.evaluateCandidate(results[0], knownInfo, expectedGender);
        if (topScore >= 80) {
          return allCandidates;
        }
      }
    } catch (err) {
      searchLog.push({ pass: 1, strategy: 'exact', error: err.message, results_count: 0 });
    }

    // Pass 2: RELAXED — name + dates + places (drop parent names)
    const pass2Query = {
      givenName: knownInfo.givenName,
      surname: knownInfo.surname,
      birthDate: apiBirthDate,
      birthPlace: knownInfo.birthPlace,
      deathDate: apiDeathDate,
      deathPlace: knownInfo.deathPlace,
      count: 10,
    };
    try {
      const results = await fsApi.searchPerson(pass2Query);
      addResults(results, 2, JSON.stringify(pass2Query));
      searchLog.push({ pass: 2, strategy: 'relaxed', query: pass2Query, results_count: results.length });
    } catch (err) {
      searchLog.push({ pass: 2, strategy: 'relaxed', error: err.message, results_count: 0 });
    }

    // Pass 2.5: FIRST_NAME_ONLY — use only the first given name (drop middle names)
    const firstGivenName = knownInfo.givenName ? knownInfo.givenName.split(/\s+/)[0] : '';
    if (firstGivenName && firstGivenName !== knownInfo.givenName) {
      const pass25Query = {
        givenName: firstGivenName,
        surname: knownInfo.surname,
        birthDate: apiBirthDate,
        birthPlace: knownInfo.birthPlace,
        count: 10,
      };
      try {
        const results = await fsApi.searchPerson(pass25Query);
        addResults(results, 2, JSON.stringify(pass25Query));
        searchLog.push({ pass: 2.5, strategy: 'first_name_only', query: pass25Query, results_count: results.length });
      } catch (err) {
        searchLog.push({ pass: 2.5, strategy: 'first_name_only', error: err.message, results_count: 0 });
      }
    }

    // Pass 2.7: INITIAL_VARIANT — "Alan Lance" → search "Alan L" (FS often stores middle names as initials)
    if (knownInfo.givenName && knownInfo.givenName.includes(' ')) {
      const givenParts = knownInfo.givenName.trim().split(/\s+/);
      // Build initial variant: first name + first letter of each subsequent name
      const initialVariant = givenParts[0] + ' ' + givenParts.slice(1).map(p => p.charAt(0)).join(' ');
      if (initialVariant !== knownInfo.givenName && initialVariant !== firstGivenName) {
        const pass27Query = {
          givenName: initialVariant,
          surname: knownInfo.surname,
          birthDate: apiBirthDate,
          birthPlace: knownInfo.birthPlace,
          count: 10,
        };
        try {
          const results = await fsApi.searchPerson(pass27Query);
          addResults(results, 2.7, JSON.stringify(pass27Query));
          searchLog.push({ pass: 2.7, strategy: 'initial_variant', query: pass27Query, results_count: results.length });
        } catch (err) {
          searchLog.push({ pass: 2.7, strategy: 'initial_variant', error: err.message, results_count: 0 });
        }
      }
    }

    // Pass 3: FUZZY — name + birth year only
    if (knownInfo.birthDate) {
      const pass3Query = {
        givenName: knownInfo.givenName,
        surname: knownInfo.surname,
        birthDate: apiBirthYear,
        count: 10,
      };
      try {
        const results = await fsApi.searchPerson(pass3Query);
        addResults(results, 3, JSON.stringify(pass3Query));
        searchLog.push({ pass: 3, strategy: 'fuzzy', query: pass3Query, results_count: results.length });
      } catch (err) {
        searchLog.push({ pass: 3, strategy: 'fuzzy', error: err.message, results_count: 0 });
      }
    }

    // Pass 4: VARIANTS — first name + surname variant + birth year
    // Common UK surname variants
    const variants = this.getSurnameVariants(knownInfo.surname);
    if (variants.length > 0 && knownInfo.birthDate) {
      for (const variant of variants.slice(0, 2)) { // Max 2 variants to avoid too many calls
        const pass4Query = {
          givenName: knownInfo.givenName,
          surname: variant,
          birthDate: apiBirthYear,
          count: 5,
        };
        try {
          const results = await fsApi.searchPerson(pass4Query);
          addResults(results, 4, JSON.stringify(pass4Query));
          searchLog.push({ pass: 4, strategy: `variant:${variant}`, query: pass4Query, results_count: results.length });
        } catch (err) {
          searchLog.push({ pass: 4, strategy: `variant:${variant}`, error: err.message, results_count: 0 });
        }
      }
    }

    // Pass 5: BROAD — surname + place only
    if (knownInfo.birthPlace && allCandidates.length < 3) {
      const pass5Query = {
        surname: knownInfo.surname,
        birthPlace: knownInfo.birthPlace,
        count: 10,
      };
      try {
        const results = await fsApi.searchPerson(pass5Query);
        addResults(results, 5, JSON.stringify(pass5Query));
        searchLog.push({ pass: 5, strategy: 'broad', query: pass5Query, results_count: results.length });
      } catch (err) {
        searchLog.push({ pass: 5, strategy: 'broad', error: err.message, results_count: 0 });
      }
    }

    // Pass 6: NICKNAME — search using common name variants (William→Bill, etc.)
    if (knownInfo.givenName && allCandidates.length < 5) {
      const nicknames = getGivenNameVariants(knownInfo.givenName);
      for (const nick of nicknames.slice(0, 2)) { // Max 2 nickname searches
        const pass6Query = {
          givenName: nick.charAt(0).toUpperCase() + nick.slice(1),
          surname: knownInfo.surname,
          birthDate: apiBirthDate,
          birthPlace: knownInfo.birthPlace,
          count: 5,
        };
        try {
          const results = await fsApi.searchPerson(pass6Query);
          addResults(results, 6, JSON.stringify(pass6Query));
          searchLog.push({ pass: 6, strategy: `nickname:${nick}`, query: pass6Query, results_count: results.length });
        } catch (err) {
          searchLog.push({ pass: 6, strategy: `nickname:${nick}`, error: err.message, results_count: 0 });
        }
      }
    }

    // Pass 7: MULTI-SOURCE — only if FS didn't produce enough good candidates.
    // FamilySearch is the priority source. Other sources supplement when FS is thin.
    const otherSearchSources = this.searchSources.filter(s => s.sourceName !== 'FamilySearch');
    const expectedGenderForPass7 = this.getExpectedGender(ascNumber);
    const fsStrongCandidates = allCandidates.filter(c =>
      this.evaluateCandidate(c, knownInfo, expectedGenderForPass7) >= 40
    ).length;
    if (otherSearchSources.length > 0 && fsStrongCandidates < 3 && (knownInfo.givenName || knownInfo.surname)) {
      const pass7Query = {
        givenName: knownInfo.givenName,
        surname: knownInfo.surname,
        birthDate: apiBirthDate,
        birthPlace: knownInfo.birthPlace,
        count: 10,
      };

      for (const source of otherSearchSources) {
        try {
          console.log(`[Search] asc#${ascNumber}: Querying ${source.sourceName}...`);
          const results = await source.searchPerson(pass7Query);
          // Tag results with source name and track origin
          for (const r of results) {
            r._source = source.sourceName;
            this.trackSourceOrigin(r.id, source.sourceName);
          }
          // Merge with existing candidates (may deduplicate with FS results)
          const mergedNew = mergeSearchResults([...allCandidates, ...results]);
          // Only add truly new candidates (not already in seenIds)
          for (const r of results) {
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              allCandidates.push({ ...r, searchPass: 7, searchQuery: `${source.sourceName}: ${JSON.stringify(pass7Query)}` });
            }
          }
          searchLog.push({ pass: 7, strategy: `source:${source.sourceName}`, query: pass7Query, results_count: results.length });
          console.log(`[Search] asc#${ascNumber}: ${source.sourceName} returned ${results.length} results`);
        } catch (err) {
          searchLog.push({ pass: 7, strategy: `source:${source.sourceName}`, error: err.message, results_count: 0 });
          console.log(`[Search] asc#${ascNumber}: ${source.sourceName} search failed: ${err.message}`);
        }
      }
    }

    return allCandidates;
  }

  evaluateCandidate(candidate, knownInfo, expectedGender) {
    let score = 0;
    let penalties = 0;
    const hasParentInfo = !!(knownInfo.fatherGivenName || knownInfo.motherGivenName);

    // Point distribution: dates & places are the dominant factors.
    // Dates are objective facts; names are common; places discriminate at county level.
    // With parents: name=20, date=30, place=25, parent=15, gender=10
    // No parents:   name=22, date=35, place=28, gender=10 (bonus: geo consistency)
    const nameMax = hasParentInfo ? 20 : 22;
    const dateMax = hasParentInfo ? 30 : 35;
    const placeMax = hasParentInfo ? 25 : 28;
    const parentMax = 15;
    const genderMax = 10;

    // NAME MATCH (up to nameMax)
    const candidateSurname = normalizeName(parseNameParts(candidate.name).surname);
    const knownSurname = normalizeName(knownInfo.surname);
    const candidateGiven = normalizeName(parseNameParts(candidate.name).givenName);
    const knownGiven = normalizeName(knownInfo.givenName);

    let surnameMatched = false;
    let givenNameMatched = false;

    if (knownSurname) {
      if (candidateSurname === knownSurname) {
        score += Math.round(nameMax * 0.6);
        surnameMatched = true;
      } else if (candidateSurname.includes(knownSurname) || knownSurname.includes(candidateSurname)) {
        score += Math.round(nameMax * 0.32);
        surnameMatched = true;
      }
    }

    if (knownGiven) {
      if (candidateGiven === knownGiven) {
        score += Math.round(nameMax * 0.4);
        givenNameMatched = true;
      } else {
        const candidateFirst = candidateGiven.split(' ')[0] || '';
        const knownFirst = knownGiven.split(' ')[0] || '';
        if (candidateFirst && knownFirst && candidateFirst === knownFirst) {
          const candidateRest = candidateGiven.split(' ').slice(1);
          const knownRest = knownGiven.split(' ').slice(1);
          const initialMatch = candidateRest.length > 0 && knownRest.length > 0 &&
            candidateRest.every((cp, i) => {
              if (!knownRest[i]) return false;
              return cp === knownRest[i] || (cp.length === 1 && knownRest[i].startsWith(cp)) ||
                     (knownRest[i].length === 1 && cp.startsWith(knownRest[i]));
            });
          if (initialMatch) {
            score += Math.round(nameMax * 0.38);
          } else if (candidateRest.length > 0 && knownRest.length > 0 &&
                     candidateRest[0].length > 1 && knownRest[0].length > 1 &&
                     candidateRest[0] !== knownRest[0]) {
            score += Math.round(nameMax * 0.15);
          } else {
            score += Math.round(nameMax * 0.3);
          }
          givenNameMatched = true;
        } else if (isNameVariant(candidateGiven, knownGiven)) {
          score += Math.round(nameMax * 0.25);
          givenNameMatched = true;
        } else if (nameContains(candidateGiven, knownGiven) || nameContains(knownGiven, candidateGiven)) {
          score += Math.round(nameMax * 0.12);
        }
      }
    }

    // DATE MATCH (up to dateMax)
    const candidateBirth = normalizeDate(candidate.birthDate);
    const knownBirth = normalizeDate(knownInfo.birthDate);
    const birthDiff = yearDiff(candidateBirth, knownBirth);
    let birthYearMatched = false;

    if (birthDiff !== null) {
      if (birthDiff === 0) { score += Math.round(dateMax * 0.7); birthYearMatched = true; }
      else if (birthDiff === 1) { score += Math.round(dateMax * 0.55); birthYearMatched = true; }
      else if (birthDiff <= 2) { score += Math.round(dateMax * 0.4); birthYearMatched = true; }
      else if (birthDiff <= 5) score += Math.round(dateMax * 0.2);
      else if (birthDiff > 10) penalties += 20; // Birth year way off — strong negative signal
    }

    const candidateDeath = normalizeDate(candidate.deathDate);
    const knownDeath = normalizeDate(knownInfo.deathDate);
    const deathDiff = yearDiff(candidateDeath, knownDeath);

    if (deathDiff !== null) {
      if (deathDiff === 0) score += Math.round(dateMax * 0.3);
      else if (deathDiff <= 2) score += Math.round(dateMax * 0.2);
      else if (deathDiff <= 5) score += Math.round(dateMax * 0.1);
      else if (deathDiff > 10) penalties += 15; // Death year way off
    }

    // GENERATION PLAUSIBILITY: if evaluating a parent, check generation gap
    if (knownInfo._childBirthYear && candidateBirth?.year) {
      const gap = knownInfo._childBirthYear - candidateBirth.year;
      if (gap < 12 || gap > 55) {
        penalties += 25; // Impossible generation gap
      } else if (gap > 45 || gap < 15) {
        penalties += 10; // Unlikely but possible
      }
    }

    // PLACE MATCH (up to placeMax) — specificity-based scoring
    if (knownInfo.birthPlace) {
      const specificity = placeSpecificityScore(candidate.birthPlace, knownInfo.birthPlace);
      if (specificity === 'town') {
        score += Math.round(placeMax * 0.65); // Same town/parish: strongest
      } else if (specificity === 'county') {
        score += Math.round(placeMax * 0.45); // Same county: strong
      } else if (specificity === 'country') {
        score += Math.round(placeMax * 0.2);  // Same country only: weak
      } else if (specificity === 'partial') {
        score += Math.round(placeMax * 0.35); // Partial match
      }

      // County mismatch penalty: both UK but different counties is a negative signal
      const kParts = parsePlaceParts(knownInfo.birthPlace);
      const cParts = parsePlaceParts(candidate.birthPlace || '');
      if (kParts.county && cParts.county && kParts.county !== cParts.county) {
        penalties += 8;
      }
    }

    if (knownInfo.deathPlace && candidate.deathPlace) {
      const deathSpec = placeSpecificityScore(candidate.deathPlace, knownInfo.deathPlace);
      if (deathSpec === 'town' || deathSpec === 'county') {
        score += Math.round(placeMax * 0.35);
      } else if (deathSpec === 'country' || deathSpec === 'partial') {
        score += Math.round(placeMax * 0.15);
      }
    }

    // GEOGRAPHIC PENALTY — wrong country is a strong disqualifier
    // This is the key fix: if the customer's data suggests UK ancestry (which is the
    // primary use case), heavily penalize candidates from the USA or other countries.
    const candidateBirthPlace = candidate.birthPlace || '';
    const candidateDeathPlace = candidate.deathPlace || '';
    const knownBirthPlace = knownInfo.birthPlace || '';

    // Determine if this research is UK-focused
    // UK focus if: known place is UK, OR no place given (default assumption for this service),
    // OR any known anchor has a UK place
    const knownIsUk = isUkPlace(knownBirthPlace) || isUkPlace(knownInfo.deathPlace || '');
    const candidateIsNonUk = isNonUkPlace(candidateBirthPlace) || isNonUkPlace(candidateDeathPlace);
    const candidateIsUk = isUkPlace(candidateBirthPlace) || isUkPlace(candidateDeathPlace);

    if (candidateIsNonUk && !candidateIsUk) {
      // Candidate is from a non-UK country
      if (knownIsUk) {
        // We KNOW we want UK — heavy penalty
        penalties += 40;
        console.log(`[Geo] Candidate "${candidate.name}" from non-UK place "${candidateBirthPlace || candidateDeathPlace}" — heavy penalty (-40)`);
      } else if (!knownBirthPlace) {
        // No birth place known — still penalize non-UK (this service focuses on UK genealogy)
        penalties += 30;
        console.log(`[Geo] Candidate "${candidate.name}" from non-UK place "${candidateBirthPlace || candidateDeathPlace}" — moderate penalty (-30, no place constraint)`);
      }
    } else if (candidateIsUk && knownIsUk) {
      // Both UK — graduated geographic consistency bonus
      const kp = parsePlaceParts(knownBirthPlace);
      const cp = parsePlaceParts(candidateBirthPlace);
      if (kp.county && cp.county && kp.county === cp.county) {
        score += 8; // Same county — strong consistency
      } else {
        score += 3; // Both UK but different/unknown counties
      }
    }

    // PARENT MATCH (up to parentMax, only if parent info is known)
    if (hasParentInfo) {
      const fatherDisplay = candidate.fatherName || '';
      const motherDisplay = candidate.motherName || '';

      if (knownInfo.fatherGivenName || knownInfo.fatherSurname) {
        const knownFather = normalizeName(`${knownInfo.fatherGivenName || ''} ${knownInfo.fatherSurname || ''}`);
        if (fatherDisplay && nameContains(fatherDisplay, knownFather)) {
          score += Math.round(parentMax * 0.5);
        } else if (fatherDisplay && knownFather) {
          // Father name is known AND candidate has a father — but they DON'T match
          // This is a strong negative signal (wrong family)
          penalties += 15;
          console.log(`[Parent] Candidate "${candidate.name}": father "${fatherDisplay}" does NOT match expected "${knownInfo.fatherGivenName} ${knownInfo.fatherSurname || ''}"`);
        } else if (candidate.searchPass === 1 && fatherDisplay === '') {
          score += Math.round(parentMax * 0.25);
        }
      }

      if (knownInfo.motherGivenName || knownInfo.motherSurname) {
        const knownMother = normalizeName(`${knownInfo.motherGivenName || ''} ${knownInfo.motherSurname || ''}`);
        if (motherDisplay && nameContains(motherDisplay, knownMother)) {
          score += Math.round(parentMax * 0.5);
        } else if (motherDisplay && knownMother) {
          // Mother name is known AND candidate has a mother — but they DON'T match
          penalties += 15;
          console.log(`[Parent] Candidate "${candidate.name}": mother "${motherDisplay}" does NOT match expected "${knownInfo.motherGivenName} ${knownInfo.motherSurname || ''}"`);
        } else if (candidate.searchPass === 1 && motherDisplay === '') {
          score += Math.round(parentMax * 0.25);
        }
      }
    }

    // ANCHOR CROSS-VALIDATION: If we have known anchors (customer-provided family data),
    // cross-validate candidate's parents against the expected grandparents.
    // E.g., if searching for asc#5 (Ethel Skinner), and we know asc#10 and #11 should be
    // her parents, check if the FS tree's parent names match those anchors.
    if (this.knownAnchors && candidate._treeParents) {
      const { treeFatherName, treeMotherName } = candidate._treeParents;
      const childAsc = candidate._targetAsc;
      if (childAsc) {
        const expectedFatherAsc = childAsc * 2;
        const expectedMotherAsc = childAsc * 2 + 1;
        const expectedFather = this.knownAnchors[expectedFatherAsc];
        const expectedMother = this.knownAnchors[expectedMotherAsc];

        if (expectedFather?.givenName && treeFatherName) {
          const expected = normalizeName(`${expectedFather.givenName} ${expectedFather.surname || ''}`);
          if (nameContains(treeFatherName, expected)) {
            score += 10; // Grandparent name matches — strong confirmation
          } else {
            penalties += 20; // Grandparent name CONFLICT — wrong family line
            console.log(`[Anchor] Candidate "${candidate.name}" tree father "${treeFatherName}" conflicts with expected asc#${expectedFatherAsc} "${expectedFather.givenName} ${expectedFather.surname || ''}"`);
          }
        }
        if (expectedMother?.givenName && treeMotherName) {
          const expected = normalizeName(`${expectedMother.givenName} ${expectedMother.surname || ''}`);
          if (nameContains(treeMotherName, expected)) {
            score += 10;
          } else {
            penalties += 20;
            console.log(`[Anchor] Candidate "${candidate.name}" tree mother "${treeMotherName}" conflicts with expected asc#${expectedMotherAsc} "${expectedMother.givenName} ${expectedMother.surname || ''}"`);
          }
        }
      }
    }

    // GENDER MATCH (up to genderMax)
    if (expectedGender) {
      const candidateGender = (candidate.gender || '').toLowerCase();
      if (candidateGender === expectedGender.toLowerCase()) {
        score += genderMax;
      } else if (candidateGender && candidateGender !== 'unknown') {
        penalties += 20; // Hard penalty for wrong gender
      }
    }

    // MINIMUM QUALITY GATES
    // Gate 1: No name AND no date match → very low cap
    if (!surnameMatched && !givenNameMatched && !birthYearMatched) {
      score = Math.min(score, 15);
    }
    // Gate 2: Name matched but birth year DIDN'T match when we have one to compare.
    // Names alone are insufficient — many people share the same name.
    if ((surnameMatched || givenNameMatched) && !birthYearMatched && knownBirth?.year) {
      score = Math.min(score, 50);
    }

    const finalScore = Math.max(0, Math.min(100, score - penalties));
    return finalScore;
  }

  getExpectedGender(ascNumber) {
    if (ascNumber === 1) return null; // Subject can be any gender
    return ascNumber % 2 === 0 ? 'Male' : 'Female';
  }

  getConfidenceLevel(score) {
    if (score >= 90) return 'Verified';
    if (score >= 75) return 'Probable';
    if (score >= 55) return 'Possible';
    return 'Rejected';
  }

  storeRejected(ascNumber, generation, knownInfo, searchLog, reason) {
    const name = knownInfo.givenName
      ? `${knownInfo.givenName} ${knownInfo.surname || ''}`.trim()
      : 'Unknown';

    // Check if a pre-populated record exists — if so, don't overwrite it
    const existing = this.db.getAncestorByAscNumber(this.jobId, ascNumber);
    if (existing && existing.confidence_level === 'Customer Data') {
      // Don't store rejected over customer data — handled by verifyAndUpdate
      return { verified: false, personId: null, confidence: 0, searchLog };
    }

    this.storeOrUpdateAncestor(ascNumber, generation, {
      fs_person_id: '',
      name: `${name} (not found)`,
      gender: this.getExpectedGender(ascNumber) || 'Unknown',
      birth_date: knownInfo.birthDate || '',
      birth_place: sanitizePlaceName(knownInfo.birthPlace) || '',
      death_date: knownInfo.deathDate || '',
      death_place: sanitizePlaceName(knownInfo.deathPlace) || '',
      confidence: 'rejected',
      sources: [],
      raw_data: {},
      confidence_score: 0,
      confidence_level: 'Rejected',
      evidence_chain: [],
      search_log: searchLog,
      conflicts: [],
      verification_notes: reason,
    });

    return { verified: false, personId: null, confidence: 0, searchLog };
  }

  getSurnameVariants(surname) {
    if (!surname) return [];
    const s = surname.toLowerCase();
    const variants = [];

    // Common UK surname spelling variants
    const rules = [
      [/^mac/, 'mc'], [/^mc/, 'mac'],
      [/e$/, ''], [/$/, 'e'],
      [/son$/, 'sen'], [/sen$/, 'son'],
      [/y$/, 'ey'], [/ey$/, 'y'],
      [/th/, 't'], [/(?<!t)t(?!h)/, 'th'],
      [/ph/, 'f'], [/f/, 'ph'],
      [/oo/, 'ou'], [/ou/, 'oo'],
    ];

    for (const [pattern, replacement] of rules) {
      const variant = s.replace(pattern, replacement);
      if (variant !== s && variant.length > 2) {
        variants.push(variant.charAt(0).toUpperCase() + variant.slice(1));
      }
    }

    return [...new Set(variants)];
  }
}

module.exports = { ResearchEngine, parseNotesForAnchors, parseNameParts };
