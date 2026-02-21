const fsApi = require('./familysearch-api');
const { SOURCE_CAPABILITIES } = require('./source-interface');
const { districtMatches } = require('./freebmd-client');

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
  // Strip "(not found)" marker before parsing — prevents extracting "found)" as surname
  const cleaned = fullName.replace(/\s*\(not found\)\s*$/i, '').trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') return { givenName: '', surname: '' };
  const parts = cleaned.split(/\s+/);
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
// FamilySearch returns place names in the user's locale (Mongolian, Cyrillic, etc.)
// We must translate country/region names BEFORE stripping non-Latin to preserve geographic signals.
const NON_LATIN_PLACE_MAP = {
  // Mongolian (FamilySearch's Mongolian locale translations)
  'Англи': 'England', 'Нэгдсэн Вант Улс': 'United Kingdom',
  'Америкийн Нэгдсэн Улс': 'United States', 'Шотланд': 'Scotland',
  'Уэльс': 'Wales', 'Ирланд': 'Ireland',
  'Laustralän': 'Australia', 'Норвеги': 'Norway',
  'Канад': 'Canada', 'Франц': 'France', 'Герман': 'Germany',
  // Mongolian US states
  'Оригон': 'Oregon', 'Огайо': 'Ohio', 'Индиана': 'Indiana',
  'Нью-Йорк': 'New York', 'Калифорни': 'California',
  'Иллинойс': 'Illinois', 'Мичиган': 'Michigan', 'Техас': 'Texas',
  'Флорида': 'Florida', 'Пенсильвани': 'Pennsylvania',
  'Виржиниа': 'Virginia', 'Массачусетс': 'Massachusetts',
  // Cyrillic / Russian
  'Англия': 'England', 'Великобритания': 'United Kingdom',
  'Соединённые Штаты': 'United States', 'Шотландия': 'Scotland',
  'Уэлс': 'Wales', 'Ирландия': 'Ireland',
  'Австралия': 'Australia', 'Канада': 'Canada',
  'Норвегия': 'Norway', 'Франция': 'France', 'Германия': 'Germany',
};

function sanitizePlaceName(place) {
  if (!place) return '';
  // Step 1: Translate known non-Latin place/country names BEFORE stripping
  let translated = place;
  for (const [nonLatin, english] of Object.entries(NON_LATIN_PLACE_MAP)) {
    if (translated.includes(nonLatin)) {
      translated = translated.replace(new RegExp(nonLatin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), english);
    }
  }
  // Step 2: Strip remaining non-Latin characters
  let cleaned = translated
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
    'eoferwic': 'Yorkshire',
    'eoferwicscir': 'Yorkshire',
    'lindesig': 'Lincolnshire',
    'snotingahamscir': 'Nottinghamshire',
    'ligracesterscir': 'Leicestershire',
    'scrobbesbyrigscir': 'Shropshire',
    'wigraceasterscir': 'Worcestershire',
    'warewickscir': 'Warwickshire',
    'grantabrycgscir': 'Cambridgeshire',
    'huntandunscir': 'Huntingdonshire',
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

// ─── Evidence-Based Research Engine ──────────────────────────────────
// Every ancestor must be proven by a closed evidence loop.
// Birth record + Marriage record + Census/Household must agree.
// FamilySearch trees are LEADS only — never evidence.
// The engine eliminates wrong people until only one identity remains.

class ResearchEngine {
  constructor(db, jobId, inputData, generations, sources) {
    this.db = db;
    this.jobId = jobId;
    this.inputData = inputData;
    this.generations = generations;
    this.processedCount = 0;
    this.maxAncestors = Math.pow(2, generations + 1) - 2;
    this.knownAnchors = {};
    this.rejectedFsIds = new Set(db.getRejectedFsIds(jobId));

    // Categorize sources
    this.sources = sources || [];
    this.freebmdSource = this.sources.find(s => s.sourceName === 'FreeBMD' && s.isAvailable());
    this.fsSource = this.sources.find(s => s.sourceName === 'FamilySearch' && s.isAvailable());
    this.confirmationSources = this.sources.filter(s =>
      s.capabilities.includes(SOURCE_CAPABILITIES.CONFIRMATION) && s.isAvailable()
    );

    console.log(`[Engine] Evidence-based mode. FreeBMD=${!!this.freebmdSource}, FS=${!!this.fsSource}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  getExpectedGender(ascNumber) {
    if (ascNumber === 1) return null; // Subject can be any gender
    return ascNumber % 2 === 0 ? 'Male' : 'Female';
  }

  getConfidenceLevel(score) {
    if (score >= 90) return 'Verified';
    if (score >= 75) return 'Probable';
    if (score >= 50) return 'Possible';
    if (score >= 25) return 'Flagged';
    return 'Not Found';
  }

  storeOrUpdateAncestor(ascNumber, generation, data) {
    const existing = this.db.getAncestorByAscNumber(this.jobId, ascNumber);
    if (existing) {
      // NEVER overwrite Customer Data with a lower-confidence result
      if (existing.confidence_level === 'Customer Data' && data.confidence_level !== 'Customer Data') {
        console.log(`[Engine] asc#${ascNumber}: PROTECTED — not overwriting Customer Data (${existing.name}) with ${data.confidence_level || 'engine'} result`);
        return;
      }
      this.db.updateAncestorByAscNumber(this.jobId, ascNumber, data);
    } else {
      this.db.addAncestor({
        research_job_id: this.jobId,
        ascendancy_number: ascNumber,
        generation,
        ...data,
      });
    }
  }

  getSurnameVariants(surname) {
    if (!surname) return [];
    const s = surname.toLowerCase();
    const variants = [];
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

  // Extract district from a place string (e.g. "Derby, Derbyshire, England" → "Derby")
  extractDistrict(place) {
    if (!place) return '';
    const parts = place.split(',').map(p => p.trim()).filter(Boolean);
    // First part is usually the most specific (town/district)
    return parts[0] || '';
  }

  // Check if two names are similar enough
  namesSimilar(a, b) {
    if (!a || !b) return false;
    const na = a.toLowerCase().trim();
    const nb = b.toLowerCase().trim();
    if (na === nb) return true;
    // Check if one contains the other (handles middle names)
    if (na.includes(nb) || nb.includes(na)) return true;
    // Check first name only
    const fa = na.split(/\s+/)[0];
    const fb = nb.split(/\s+/)[0];
    if (fa === fb) return true;
    // Common diminutives
    const DIMINUTIVES = {
      'william': ['will', 'wm', 'bill', 'billy'],
      'elizabeth': ['eliz', 'eliza', 'beth', 'betty', 'lizzie', 'liz'],
      'margaret': ['maggie', 'margt', 'peggy', 'meg'],
      'thomas': ['thos', 'tom', 'tommy'],
      'robert': ['robt', 'rob', 'bob', 'bobby'],
      'richard': ['richd', 'rich', 'dick'],
      'james': ['jas', 'jim', 'jimmy'],
      'john': ['jno', 'jack', 'johnny'],
      'charles': ['chas', 'charlie'],
      'edward': ['edwd', 'ed', 'ted', 'teddy', 'eddie'],
      'henry': ['harry'],
      'harry': ['henry'],
      'frederick': ['fred', 'freddy', 'fredk'],
      'george': ['geo'],
      'joseph': ['joe', 'jos'],
      'samuel': ['sam', 'saml'],
      'catherine': ['kate', 'katie', 'kitty', 'cath'],
      'kathleen': ['kate', 'katie', 'kath'],
      'mary': ['maria', 'marie'],
      'sarah': ['sally'],
      'ann': ['anne', 'annie', 'anna'],
      'dorothy': ['dot', 'dolly'],
      'ethel': ['eth'],
      'florence': ['flo', 'florrie'],
      'alfred': ['alf', 'alfie'],
      'albert': ['bert', 'bertie'],
      'herbert': ['herb', 'bert', 'bertie'],
      'ernest': ['ernie'],
      'arthur': ['art'],
      'joan': ['joanie'],
      'julie': ['julia'],
    };
    for (const [name, dims] of Object.entries(DIMINUTIVES)) {
      if ((fa === name && dims.includes(fb)) || (fb === name && dims.includes(fa))) return true;
    }
    return false;
  }

  // ─── STEP 1: Build Candidate Birth Set ─────────────────────────────

  async buildCandidateBirthSet(personInfo, ascNumber) {
    const hypotheses = [];
    const searchLog = [];

    if (!this.freebmdSource) {
      searchLog.push({ step: 1, note: 'FreeBMD not available — cannot search civil records' });
      return { hypotheses, searchLog };
    }

    const { givenName, surname, birthYear, birthPlace, motherMaidenSurname } = personInfo;
    if (!surname) {
      searchLog.push({ step: 1, note: 'No surname — cannot search births' });
      return { hypotheses, searchLog };
    }

    // Determine year range — birth year ±5
    const yearFrom = birthYear ? birthYear - 5 : null;
    const yearTo = birthYear ? birthYear + 5 : null;

    // If no year at all, we can't meaningfully search FreeBMD
    if (!yearFrom) {
      searchLog.push({ step: 1, note: 'No birth year — cannot search FreeBMD births' });
      return { hypotheses, searchLog };
    }

    // Primary search
    const district = this.extractDistrict(birthPlace);
    console.log(`[Step1] asc#${ascNumber}: Searching births for ${givenName || '?'} ${surname}, ${yearFrom}-${yearTo}, district="${district}"`);

    try {
      const results = await this.freebmdSource.searchBirths(surname, givenName || '', yearFrom, yearTo, district);
      searchLog.push({
        step: 1, pass: 1, query: `births: ${surname}, ${givenName || '*'}, ${yearFrom}-${yearTo}, ${district}`,
        results_count: results.length,
      });
      console.log(`[Step1] asc#${ascNumber}: FreeBMD returned ${results.length} birth results`);

      for (const entry of results) {
        hypotheses.push({
          surname: entry.surname,
          forenames: entry.forenames,
          year: entry.year,
          quarter: entry.quarter,
          district: entry.district,
          volume: entry.volume,
          page: entry.page,
          motherMaidenSurname: entry.spouseSurname || '', // on birth entries, spouseSurname = mother's maiden name
          source: 'FreeBMD',
          status: 'hypothesis',
          score: 0,
          evidenceChain: [{
            record_type: 'birth',
            source: 'FreeBMD',
            is_independent: true,
            year: entry.year,
            quarter: entry.quarter,
            district: entry.district,
            volume: entry.volume,
            page: entry.page,
            details: `Birth: ${entry.forenames} ${entry.surname}, Q${entry.quarter} ${entry.year}, ${entry.district}`,
            parent_mother_maiden: entry.spouseSurname || '',
            supports: ['identity'],
            weight: 25,
          }],
        });
      }
    } catch (err) {
      console.error(`[Step1] asc#${ascNumber}: FreeBMD search error:`, err.message);
      searchLog.push({ step: 1, pass: 1, error: err.message });
    }

    // Also search without district if we got few results
    if (hypotheses.length < 3 && district) {
      try {
        const broadResults = await this.freebmdSource.searchBirths(surname, givenName || '', yearFrom, yearTo, '');
        searchLog.push({
          step: 1, pass: 2, query: `births (broad): ${surname}, ${givenName || '*'}, ${yearFrom}-${yearTo}`,
          results_count: broadResults.length,
        });

        for (const entry of broadResults) {
          // De-duplicate by volume+page
          const dupe = hypotheses.find(h => h.volume === entry.volume && h.page === entry.page && h.volume);
          if (!dupe) {
            hypotheses.push({
              surname: entry.surname,
              forenames: entry.forenames,
              year: entry.year,
              quarter: entry.quarter,
              district: entry.district,
              volume: entry.volume,
              page: entry.page,
              motherMaidenSurname: entry.spouseSurname || '',
              source: 'FreeBMD',
              status: 'hypothesis',
              score: 0,
              evidenceChain: [{
                record_type: 'birth',
                source: 'FreeBMD',
                is_independent: true,
                year: entry.year,
                quarter: entry.quarter,
                district: entry.district,
                volume: entry.volume,
                page: entry.page,
                details: `Birth: ${entry.forenames} ${entry.surname}, Q${entry.quarter} ${entry.year}, ${entry.district}`,
                parent_mother_maiden: entry.spouseSurname || '',
                supports: ['identity'],
                weight: 25,
              }],
            });
          }
        }
      } catch (err) {
        searchLog.push({ step: 1, pass: 2, error: err.message });
      }
    }

    // Also try surname variants if no results
    if (hypotheses.length === 0) {
      const variants = this.getSurnameVariants(surname);
      for (const variant of variants.slice(0, 2)) {
        try {
          const varResults = await this.freebmdSource.searchBirths(variant, givenName || '', yearFrom, yearTo, '');
          searchLog.push({
            step: 1, pass: 3, query: `births (variant): ${variant}, ${givenName || '*'}, ${yearFrom}-${yearTo}`,
            results_count: varResults.length,
          });
          for (const entry of varResults) {
            const dupe = hypotheses.find(h => h.volume === entry.volume && h.page === entry.page && h.volume);
            if (!dupe) {
              hypotheses.push({
                surname: entry.surname,
                forenames: entry.forenames,
                year: entry.year,
                quarter: entry.quarter,
                district: entry.district,
                volume: entry.volume,
                page: entry.page,
                motherMaidenSurname: entry.spouseSurname || '',
                source: 'FreeBMD',
                status: 'hypothesis',
                score: 0,
                evidenceChain: [{
                  record_type: 'birth',
                  source: 'FreeBMD',
                  is_independent: true,
                  year: entry.year,
                  quarter: entry.quarter,
                  district: entry.district,
                  volume: entry.volume,
                  page: entry.page,
                  details: `Birth: ${entry.forenames} ${entry.surname} (variant), Q${entry.quarter} ${entry.year}, ${entry.district}`,
                  parent_mother_maiden: entry.spouseSurname || '',
                  supports: ['identity'],
                  weight: 20,
                }],
              });
            }
          }
        } catch (err) {
          searchLog.push({ step: 1, pass: 3, error: err.message });
        }
      }
    }

    // Score hypotheses against known info
    for (const h of hypotheses) {
      let score = 0;

      // Name match
      if (givenName && h.forenames) {
        if (this.namesSimilar(h.forenames, givenName)) score += 20;
        else if (h.forenames.toLowerCase().startsWith(givenName.toLowerCase().split(' ')[0])) score += 15;
      }

      // Year match
      if (birthYear && h.year) {
        const diff = Math.abs(h.year - birthYear);
        if (diff === 0) score += 20;
        else if (diff === 1) score += 15;
        else if (diff <= 3) score += 10;
        else if (diff <= 5) score += 5;
      }

      // District match
      if (district && h.district) {
        const dLower = district.toLowerCase();
        const hLower = h.district.toLowerCase();
        if (dLower === hLower) score += 15;
        else if (dLower.includes(hLower) || hLower.includes(dLower)) score += 10;
        else if (districtMatches(district, h.district)) score += 8;
      }

      // Mother maiden name match (very strong — linchpin of evidence)
      if (motherMaidenSurname && h.motherMaidenSurname) {
        if (h.motherMaidenSurname.toLowerCase() === motherMaidenSurname.toLowerCase()) score += 30;
        else if (h.motherMaidenSurname.toLowerCase().includes(motherMaidenSurname.toLowerCase()) ||
                 motherMaidenSurname.toLowerCase().includes(h.motherMaidenSurname.toLowerCase())) score += 15;
      }

      h.score = score;
    }

    // Sort by score descending
    hypotheses.sort((a, b) => b.score - a.score);

    // Store top candidates in search_candidates table
    for (let i = 0; i < Math.min(hypotheses.length, 15); i++) {
      const h = hypotheses[i];
      this.db.addSearchCandidate({
        research_job_id: this.jobId,
        target_asc_number: ascNumber,
        fs_person_id: '',
        name: `${h.forenames} ${h.surname}`,
        search_pass: 1,
        search_query: `FreeBMD birth: ${h.surname}, ${h.forenames}`,
        fs_score: 0,
        computed_score: h.score,
        selected: false,
        rejection_reason: '',
        raw_data: h,
      });
    }

    console.log(`[Step1] asc#${ascNumber}: ${hypotheses.length} birth hypotheses (top score: ${hypotheses[0]?.score || 0})`);
    return { hypotheses, searchLog };
  }

  // ─── STEP 2: Build Household Identity (Census/Household Filter) ────

  async buildHouseholdIdentity(hypothesis, personInfo, ascNumber) {
    if (!this.fsSource) {
      console.log(`[Step2] asc#${ascNumber}: FamilySearch not available — skipping household check`);
      return { ...hypothesis, fsPersonId: null, householdScore: 0 };
    }

    const { givenName, surname, birthYear, birthPlace, fatherSurname, motherMaidenSurname } = personInfo;
    const searchLog = [];

    // Search FamilySearch for person matching this hypothesis
    const query = {
      givenName: hypothesis.forenames || givenName || '',
      surname: hypothesis.surname || surname || '',
      birthDate: String(hypothesis.year || birthYear || ''),
      birthPlace: hypothesis.district || this.extractDistrict(birthPlace) || '',
    };

    // Add parent hints if known
    if (fatherSurname) query.fatherSurname = fatherSurname;
    if (motherMaidenSurname) {
      query.motherGivenName = '';
      query.motherSurname = hypothesis.motherMaidenSurname || motherMaidenSurname;
    }

    console.log(`[Step2] asc#${ascNumber}: Searching FS for ${query.givenName} ${query.surname} b.${query.birthDate}`);

    let fsCandidates = [];
    try {
      fsCandidates = await this.fsSource.searchPerson({ ...query, count: 5 });
      searchLog.push({
        step: 2, query: `FS: ${query.givenName} ${query.surname} b.${query.birthDate}`,
        results_count: fsCandidates.length,
      });
    } catch (err) {
      console.log(`[Step2] asc#${ascNumber}: FS search error: ${err.message}`);
      searchLog.push({ step: 2, error: err.message });
    }

    if (fsCandidates.length === 0) {
      console.log(`[Step2] asc#${ascNumber}: No FS candidates found`);
      return { ...hypothesis, fsPersonId: null, householdScore: 0, searchLog };
    }

    // Evaluate each FS candidate against the hypothesis
    let bestMatch = null;
    let bestScore = 0;

    for (const candidate of fsCandidates) {
      // Skip non-UK candidates
      const candidatePlace = sanitizePlaceName(candidate.birthPlace || candidate.deathPlace || '');
      if (isNonUkPlace(candidatePlace) && !isUkPlace(candidatePlace)) {
        console.log(`[Step2] asc#${ascNumber}: Skipping non-UK candidate ${candidate.name} (${candidatePlace})`);
        continue;
      }

      // Skip already-rejected FS IDs
      if (this.rejectedFsIds.has(candidate.id)) continue;

      let hScore = 0;

      // Child name similar to hypothesis forenames?
      if (this.namesSimilar(candidate.name?.split(' ')[0], hypothesis.forenames)) hScore += 20;

      // Birthplace consistent with district?
      const candBirthPlace = sanitizePlaceName(candidate.birthPlace || '');
      if (hypothesis.district && candBirthPlace) {
        const distLower = hypothesis.district.toLowerCase();
        if (candBirthPlace.toLowerCase().includes(distLower)) hScore += 15;
        else if (districtMatches(hypothesis.district, this.extractDistrict(candBirthPlace))) hScore += 10;
      }

      // Age within ±2 years?
      const candBirthYear = normalizeDate(candidate.birthDate)?.year;
      if (candBirthYear && hypothesis.year) {
        const diff = Math.abs(candBirthYear - hypothesis.year);
        if (diff <= 1) hScore += 15;
        else if (diff <= 2) hScore += 10;
        else if (diff <= 3) hScore += 5;
      }

      // Father surname matches hypothesis surname?
      if (candidate.fatherName) {
        const fatherParts = parseNameParts(candidate.fatherName);
        if (fatherParts.surname && hypothesis.surname) {
          if (fatherParts.surname.toLowerCase() === hypothesis.surname.toLowerCase()) hScore += 15;
        }
      }

      // Mother's maiden name compatible with hypothesis motherMaidenSurname?
      if (candidate.motherName && hypothesis.motherMaidenSurname) {
        const motherParts = parseNameParts(candidate.motherName);
        if (motherParts.surname && hypothesis.motherMaidenSurname) {
          if (motherParts.surname.toLowerCase() === hypothesis.motherMaidenSurname.toLowerCase()) hScore += 25;
          else if (motherParts.givenName && motherParts.surname.toLowerCase().includes(hypothesis.motherMaidenSurname.toLowerCase().substring(0, 3))) hScore += 10;
        }
      }

      // Now try to get census facts for additional household evidence
      try {
        const facts = await fsApi.extractFactsByType(candidate.id);
        if (facts.census.length > 0) {
          // Look for census entries when person was age 0-10
          const childCensus = facts.census.filter(c => {
            if (!c.year || !hypothesis.year) return false;
            const age = c.year - hypothesis.year;
            return age >= 0 && age <= 15;
          });
          if (childCensus.length > 0) {
            hScore += 10; // Found in childhood census
            hypothesis.evidenceChain.push({
              record_type: 'census',
              source: 'FamilySearch-Census',
              is_independent: false,
              year: childCensus[0].year,
              place: childCensus[0].place,
              details: `Census ${childCensus[0].year}: ${candidate.name} at ${childCensus[0].place}`,
              supports: ['identity', 'location'],
              weight: 15,
            });
          }
        }
      } catch (err) {
        console.log(`[Step2] asc#${ascNumber}: Facts extraction error for ${candidate.id}: ${err.message}`);
      }

      if (hScore > bestScore) {
        bestScore = hScore;
        bestMatch = {
          fsPersonId: candidate.id,
          fsName: candidate.name,
          fsBirthDate: candidate.birthDate,
          fsBirthPlace: candidate.birthPlace,
          fsDeathDate: candidate.deathDate,
          fsDeathPlace: candidate.deathPlace,
          fsFatherName: candidate.fatherName,
          fsMotherName: candidate.motherName,
          householdScore: hScore,
        };
      }
    }

    // Classify
    if (bestScore >= 60) {
      hypothesis.status = 'primary';
      console.log(`[Step2] asc#${ascNumber}: PRIMARY match — ${bestMatch.fsName} (score ${bestScore})`);
    } else if (bestScore >= 30) {
      hypothesis.status = 'alternate';
      console.log(`[Step2] asc#${ascNumber}: ALTERNATE match — ${bestMatch?.fsName} (score ${bestScore})`);
    } else {
      hypothesis.status = 'discarded';
      console.log(`[Step2] asc#${ascNumber}: No strong household match (best score ${bestScore})`);
    }

    if (bestMatch) {
      Object.assign(hypothesis, bestMatch);
    }
    hypothesis.searchLog = [...(hypothesis.searchLog || []), ...searchLog];

    return hypothesis;
  }

  // ─── STEP 3: Identify Parent Couple (Marriage Record Search) ──────

  async identifyParentCouple(hypothesis, personInfo, ascNumber) {
    if (!this.freebmdSource) {
      console.log(`[Step3] asc#${ascNumber}: FreeBMD not available — cannot search marriages`);
      return null;
    }

    // We need father surname and mother maiden surname
    const fatherSurname = hypothesis.surname || personInfo.fatherSurname || personInfo.surname || '';
    const motherMaidenSurname = hypothesis.motherMaidenSurname || personInfo.motherMaidenSurname || '';

    // Try to get parent first names from FS data
    let fatherFirstName = personInfo.fatherGivenName || '';
    let motherFirstName = personInfo.motherGivenName || '';
    if (hypothesis.fsFatherName) {
      const fp = parseNameParts(hypothesis.fsFatherName);
      if (!fatherFirstName && fp.givenName) fatherFirstName = fp.givenName;
    }
    if (hypothesis.fsMotherName) {
      const mp = parseNameParts(hypothesis.fsMotherName);
      if (!motherFirstName && mp.givenName) motherFirstName = mp.givenName;
    }

    if (!fatherSurname || !motherMaidenSurname) {
      console.log(`[Step3] asc#${ascNumber}: Missing father surname or mother maiden name — cannot search marriages`);
      return null;
    }

    const childBirthYear = hypothesis.year || personInfo.birthYear;
    if (!childBirthYear) {
      console.log(`[Step3] asc#${ascNumber}: No child birth year — cannot constrain marriage search`);
      return null;
    }

    // Marriage should be 0-15 years before child's birth
    const marriageYearFrom = childBirthYear - 15;
    const marriageYearTo = childBirthYear;
    const district = hypothesis.district || this.extractDistrict(personInfo.birthPlace) || '';

    console.log(`[Step3] asc#${ascNumber}: Searching marriages ${fatherFirstName || '?'} ${fatherSurname} × ${motherMaidenSurname}, ${marriageYearFrom}-${marriageYearTo}`);

    let bestMarriage = null;
    let bestScore = 0;

    // Search by groom (father)
    try {
      const results = await this.freebmdSource.searchMarriages(
        fatherSurname, fatherFirstName, marriageYearFrom, marriageYearTo, district
      );
      console.log(`[Step3] asc#${ascNumber}: ${results.length} marriage results for groom ${fatherSurname}`);

      for (const entry of results) {
        let score = 0;

        // Father surname matches
        if (entry.surname.toLowerCase() === fatherSurname.toLowerCase()) score += 25;

        // Mother maiden surname matches (from spouseSurname field)
        if (entry.spouseSurname && motherMaidenSurname) {
          if (entry.spouseSurname.toLowerCase() === motherMaidenSurname.toLowerCase()) score += 30;
        }

        // Groom first name matches
        if (fatherFirstName && entry.forenames) {
          if (this.namesSimilar(entry.forenames, fatherFirstName)) score += 15;
        }

        // Marriage year plausible (0-10 years before birth is ideal)
        if (entry.year && childBirthYear) {
          const gap = childBirthYear - entry.year;
          if (gap >= 0 && gap <= 5) score += 20;
          else if (gap >= 0 && gap <= 10) score += 15;
          else if (gap >= 0 && gap <= 15) score += 10;
        }

        // District match
        if (district && entry.district) {
          if (entry.district.toLowerCase() === district.toLowerCase()) score += 10;
          else if (districtMatches(district, entry.district)) score += 5;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMarriage = entry;
        }
      }
    } catch (err) {
      console.log(`[Step3] asc#${ascNumber}: Marriage search error (groom): ${err.message}`);
    }

    // Also search by bride (mother) if we have her first name
    if (motherFirstName && bestScore < 60) {
      try {
        const brideResults = await this.freebmdSource.searchMarriages(
          motherMaidenSurname, motherFirstName, marriageYearFrom, marriageYearTo, district
        );
        console.log(`[Step3] asc#${ascNumber}: ${brideResults.length} marriage results for bride ${motherMaidenSurname}`);

        for (const entry of brideResults) {
          let score = 0;

          // Bride maiden surname matches mother
          if (entry.surname.toLowerCase() === motherMaidenSurname.toLowerCase()) score += 25;

          // Spouse (groom) surname matches father
          if (entry.spouseSurname && fatherSurname) {
            if (entry.spouseSurname.toLowerCase() === fatherSurname.toLowerCase()) score += 30;
          }

          // Bride first name matches mother
          if (entry.forenames) {
            if (this.namesSimilar(entry.forenames, motherFirstName)) score += 15;
          }

          // Year plausibility
          if (entry.year && childBirthYear) {
            const gap = childBirthYear - entry.year;
            if (gap >= 0 && gap <= 5) score += 20;
            else if (gap >= 0 && gap <= 10) score += 15;
            else if (gap >= 0 && gap <= 15) score += 10;
          }

          // District
          if (district && entry.district) {
            if (entry.district.toLowerCase() === district.toLowerCase()) score += 10;
            else if (districtMatches(district, entry.district)) score += 5;
          }

          if (score > bestScore) {
            bestScore = score;
            bestMarriage = entry;
          }
        }
      } catch (err) {
        console.log(`[Step3] asc#${ascNumber}: Marriage search error (bride): ${err.message}`);
      }
    }

    if (!bestMarriage || bestScore < 40) {
      console.log(`[Step3] asc#${ascNumber}: No marriage found (best score: ${bestScore})`);
      return null;
    }

    console.log(`[Step3] asc#${ascNumber}: Marriage found — ${bestMarriage.forenames} ${bestMarriage.surname} × ${bestMarriage.spouseSurname}, ${bestMarriage.year} Q${bestMarriage.quarter} ${bestMarriage.district} (score ${bestScore})`);

    return {
      record_type: 'marriage',
      source: 'FreeBMD',
      is_independent: true,
      year: bestMarriage.year,
      quarter: bestMarriage.quarter,
      district: bestMarriage.district,
      volume: bestMarriage.volume,
      page: bestMarriage.page,
      details: `Marriage: ${bestMarriage.forenames} ${bestMarriage.surname} × ${bestMarriage.spouseSurname}, Q${bestMarriage.quarter} ${bestMarriage.year}, ${bestMarriage.district}`,
      groomSurname: bestMarriage.surname,
      groomForenames: bestMarriage.forenames,
      brideSurname: bestMarriage.spouseSurname,
      supports: ['parents', 'location'],
      weight: 30,
      score: bestScore,
    };
  }

  // ─── STEP 4: Verify Family Unit (Cross-Check) ────────────────────

  verifyFamilyUnit(hypothesis, marriageEvidence) {
    if (!marriageEvidence) return { verified: false, crossCheckScore: 0 };

    let crossCheckScore = 0;

    // Same father surname in birth record and marriage record?
    if (hypothesis.surname && marriageEvidence.groomSurname) {
      if (hypothesis.surname.toLowerCase() === marriageEvidence.groomSurname.toLowerCase()) {
        crossCheckScore += 15;
      }
    }

    // Same mother maiden surname in birth record and marriage record?
    if (hypothesis.motherMaidenSurname && marriageEvidence.brideSurname) {
      if (hypothesis.motherMaidenSurname.toLowerCase() === marriageEvidence.brideSurname.toLowerCase()) {
        crossCheckScore += 15;
      }
    }

    // Marriage location consistent with birth district?
    if (hypothesis.district && marriageEvidence.district) {
      if (hypothesis.district.toLowerCase() === marriageEvidence.district.toLowerCase()) {
        crossCheckScore += 10;
      } else if (districtMatches(hypothesis.district, marriageEvidence.district)) {
        crossCheckScore += 5;
      }
    }

    // Marriage year plausible for child's birth year?
    if (marriageEvidence.year && hypothesis.year) {
      const gap = hypothesis.year - marriageEvidence.year;
      if (gap >= 0 && gap <= 15) crossCheckScore += 10;
    }

    const verified = crossCheckScore >= 25;
    console.log(`[Step4] Cross-check score: ${crossCheckScore} — ${verified ? 'VERIFIED' : 'FAILED'}`);

    return { verified, crossCheckScore };
  }

  // ─── STEP 5: Reinforcement Checks ────────────────────────────────

  async reinforcementChecks(hypothesis, personInfo, ascNumber) {
    const reinforcements = [];

    // 5a. Sibling births — search for other births with same mother maiden surname in same district
    if (hypothesis.motherMaidenSurname && hypothesis.district && this.freebmdSource) {
      try {
        const yearFrom = (hypothesis.year || personInfo.birthYear || 0) - 8;
        const yearTo = (hypothesis.year || personInfo.birthYear || 0) + 8;
        const siblingResults = await this.freebmdSource.searchBirths(
          hypothesis.surname, '', yearFrom, yearTo, hypothesis.district
        );
        // Filter for siblings (same mother maiden surname, different year or forenames)
        const siblings = siblingResults.filter(entry => {
          if (entry.spouseSurname && hypothesis.motherMaidenSurname) {
            if (entry.spouseSurname.toLowerCase() === hypothesis.motherMaidenSurname.toLowerCase()) {
              // Different person (different year or different forenames)
              return entry.year !== hypothesis.year ||
                     entry.forenames.toLowerCase() !== (hypothesis.forenames || '').toLowerCase();
            }
          }
          return false;
        });

        if (siblings.length > 0) {
          console.log(`[Step5] asc#${ascNumber}: Found ${siblings.length} potential siblings`);
          reinforcements.push({
            record_type: 'sibling_birth',
            source: 'FreeBMD',
            is_independent: true,
            year: siblings[0].year,
            quarter: siblings[0].quarter,
            district: siblings[0].district,
            volume: siblings[0].volume,
            page: siblings[0].page,
            details: `Sibling: ${siblings[0].forenames} ${siblings[0].surname}, Q${siblings[0].quarter} ${siblings[0].year}, same mother ${hypothesis.motherMaidenSurname}`,
            supports: ['parents', 'identity'],
            weight: 15,
          });
        }
      } catch (err) {
        console.log(`[Step5] asc#${ascNumber}: Sibling search error: ${err.message}`);
      }
    }

    // 5b. Death record confirmation
    if (hypothesis.fsPersonId && this.freebmdSource) {
      try {
        const deathDate = hypothesis.fsDeathDate;
        if (deathDate) {
          const deathYear = normalizeDate(deathDate)?.year;
          if (deathYear) {
            const nameParts = parseNameParts(hypothesis.fsName || `${hypothesis.forenames} ${hypothesis.surname}`);
            const deathResult = await this.freebmdSource.confirmDeath(
              nameParts.givenName?.split(' ')[0] || '', nameParts.surname || hypothesis.surname, deathYear
            );
            if (deathResult) {
              console.log(`[Step5] asc#${ascNumber}: Death confirmed — ${deathResult.year}`);
              reinforcements.push({
                record_type: 'death',
                source: 'FreeBMD',
                is_independent: true,
                year: deathResult.year,
                quarter: deathResult.quarter,
                district: deathResult.district,
                volume: deathResult.volume,
                page: deathResult.page,
                details: `Death: ${nameParts.givenName || ''} ${nameParts.surname || hypothesis.surname}, Q${deathResult.quarter} ${deathResult.year}, ${deathResult.district}`,
                supports: ['identity'],
                weight: 10,
              });
            }
          }
        }
      } catch (err) {
        console.log(`[Step5] asc#${ascNumber}: Death confirmation error: ${err.message}`);
      }
    }

    // 5c. Second census year from FS facts
    if (hypothesis.fsPersonId && this.fsSource) {
      try {
        const facts = await fsApi.extractFactsByType(hypothesis.fsPersonId);
        const censusYears = facts.census.map(c => c.year).filter(Boolean);
        // Check for census in a different decade than any we already have
        const existingCensusYears = hypothesis.evidenceChain
          .filter(e => e.record_type === 'census')
          .map(e => e.year)
          .filter(Boolean);

        for (const cy of censusYears) {
          const inDifferentDecade = !existingCensusYears.some(ey => Math.abs(ey - cy) < 8);
          if (inDifferentDecade) {
            const censusFact = facts.census.find(c => c.year === cy);
            reinforcements.push({
              record_type: 'census',
              source: 'FamilySearch-Census',
              is_independent: false,
              year: cy,
              place: censusFact?.place || '',
              details: `Census ${cy}: ${hypothesis.fsName || hypothesis.forenames + ' ' + hypothesis.surname} at ${censusFact?.place || '?'}`,
              supports: ['identity', 'location'],
              weight: 10,
            });
            break; // One additional census is enough
          }
        }
      } catch (err) {
        console.log(`[Step5] asc#${ascNumber}: Census fact extraction error: ${err.message}`);
      }
    }

    return reinforcements;
  }

  // ─── Score and Store Final Result ──────────────────────────────────

  scoreAndStore(hypothesis, marriageEvidence, crossCheckResult, reinforcements, personInfo, ascNumber, generation, searchLog) {
    // Build complete evidence chain
    const evidenceChain = [...(hypothesis.evidenceChain || [])];
    if (marriageEvidence) {
      evidenceChain.push(marriageEvidence);
    }
    for (const r of reinforcements) {
      evidenceChain.push(r);
    }

    // Calculate total evidence weight
    const totalWeight = evidenceChain.reduce((sum, e) => sum + (e.weight || 0), 0);
    const independentCount = evidenceChain.filter(e => e.is_independent).length;
    const hasTriangle = evidenceChain.some(e => e.record_type === 'birth' && e.is_independent) &&
                        evidenceChain.some(e => e.record_type === 'marriage' && e.is_independent) &&
                        (evidenceChain.some(e => e.record_type === 'census') ||
                         evidenceChain.some(e => e.record_type === 'sibling_birth'));

    // Determine confidence score
    let confidenceScore;
    if (hasTriangle && reinforcements.length > 0) {
      // Full triangle + reinforcement = Verified
      confidenceScore = Math.min(100, 85 + Math.min(15, totalWeight - 55));
    } else if (hasTriangle) {
      // Triangle only = Probable
      confidenceScore = Math.min(89, 75 + Math.min(14, totalWeight - 40));
    } else if (independentCount >= 2) {
      // Two independent records = Possible
      confidenceScore = Math.min(74, 50 + Math.min(24, totalWeight - 25));
    } else if (independentCount >= 1) {
      // One independent record
      confidenceScore = Math.min(49, 25 + Math.min(24, totalWeight - 10));
    } else {
      // Nothing = Not Found
      confidenceScore = 0;
    }

    // If cross-check failed but we had evidence, cap it
    if (marriageEvidence && crossCheckResult && !crossCheckResult.verified) {
      confidenceScore = Math.min(confidenceScore, 60); // Can't be higher than Possible
    }

    const confidenceLevel = this.getConfidenceLevel(confidenceScore);

    // Build the stored ancestor record
    const name = hypothesis.fsName || `${hypothesis.forenames || personInfo.givenName || 'Unknown'} ${hypothesis.surname || personInfo.surname || ''}`.trim();
    const gender = this.getExpectedGender(ascNumber) || 'Unknown';

    const birthDate = hypothesis.fsBirthDate || String(hypothesis.year || personInfo.birthYear || '');
    const birthPlace = sanitizePlaceName(hypothesis.fsBirthPlace || hypothesis.district || personInfo.birthPlace || '');
    const deathDate = hypothesis.fsDeathDate || '';
    const deathPlace = sanitizePlaceName(hypothesis.fsDeathPlace || '');

    // Build verification notes
    const notes = [];
    if (hypothesis.status === 'primary') notes.push('Primary household match');
    if (marriageEvidence) notes.push(`Parents marriage: ${marriageEvidence.details}`);
    if (crossCheckResult?.verified) notes.push(`Cross-check passed (score ${crossCheckResult.crossCheckScore})`);
    for (const r of reinforcements) notes.push(`Reinforcement: ${r.details}`);
    notes.push(`Evidence weight: ${totalWeight}, Independent records: ${independentCount}`);

    // Build parent info for tree extension
    const fatherName = hypothesis.fsFatherName || '';
    const motherName = hypothesis.fsMotherName || '';

    const ancestorData = {
      fs_person_id: hypothesis.fsPersonId || '',
      name,
      gender,
      birth_date: birthDate,
      birth_place: birthPlace,
      death_date: deathDate,
      death_place: deathPlace,
      confidence: confidenceLevel.toLowerCase(),
      sources: evidenceChain.map(e => e.source).filter((v, i, a) => a.indexOf(v) === i),
      raw_data: {
        hypothesis,
        marriageEvidence,
        crossCheckResult,
        fatherName,
        motherName,
        motherMaidenSurname: hypothesis.motherMaidenSurname || personInfo.motherMaidenSurname || '',
      },
      confidence_score: confidenceScore,
      confidence_level: confidenceLevel,
      evidence_chain: evidenceChain,
      search_log: searchLog,
      conflicts: [],
      verification_notes: notes.join(' | '),
    };

    this.storeOrUpdateAncestor(ascNumber, generation, ancestorData);

    console.log(`[Engine] asc#${ascNumber}: ${name} — ${confidenceLevel} ${confidenceScore}% (${independentCount} independent records)`);

    return {
      verified: confidenceScore >= 75,
      personInfo: {
        name,
        givenName: hypothesis.forenames || personInfo.givenName || parseNameParts(name).givenName,
        surname: hypothesis.surname || personInfo.surname || parseNameParts(name).surname,
        birthYear: hypothesis.year || personInfo.birthYear,
        birthPlace: birthPlace,
        deathDate,
        deathPlace,
        fsPersonId: hypothesis.fsPersonId || '',
        fatherName,
        motherName,
        motherMaidenSurname: hypothesis.motherMaidenSurname || personInfo.motherMaidenSurname || '',
      },
      confidenceScore,
      confidenceLevel,
    };
  }

  // ─── Process One Ancestor Through Full 6-Step Pipeline ────────────

  async processAncestor(personInfo, ascNumber, generation) {
    console.log(`\n[Engine] ═══════════════════════════════════════════════════`);
    console.log(`[Engine] Processing asc#${ascNumber} (gen ${generation}): ${personInfo.givenName || '?'} ${personInfo.surname || '?'} b.${personInfo.birthYear || '?'}`);
    console.log(`[Engine] ═══════════════════════════════════════════════════`);

    const allSearchLog = [];

    // ── STEP 1: Build candidate birth set ──
    this.db.updateJobProgress(this.jobId,
      `Searching births for ${personInfo.givenName || '?'} ${personInfo.surname || '?'}...`,
      this.processedCount, this.maxAncestors);

    const { hypotheses, searchLog: step1Log } = await this.buildCandidateBirthSet(personInfo, ascNumber);
    allSearchLog.push(...step1Log);

    if (hypotheses.length === 0) {
      // No birth records — try FS as lead-only fallback
      console.log(`[Engine] asc#${ascNumber}: No FreeBMD births found — trying FS as lead generator`);
      return await this.processFsLeadOnly(personInfo, ascNumber, generation, allSearchLog);
    }

    // ── Process top hypotheses through Steps 2-5 ──
    // Try up to 5 hypotheses — stop when we find a verified one
    const maxToTry = Math.min(5, hypotheses.length);

    for (let i = 0; i < maxToTry; i++) {
      const hypothesis = hypotheses[i];

      // ── STEP 2: Household identity check ──
      this.db.updateJobProgress(this.jobId,
        `Checking household for ${hypothesis.forenames || '?'} ${hypothesis.surname} (${i + 1}/${maxToTry})...`,
        this.processedCount, this.maxAncestors);

      const enrichedHypothesis = await this.buildHouseholdIdentity(hypothesis, personInfo, ascNumber);
      if (enrichedHypothesis.searchLog) allSearchLog.push(...enrichedHypothesis.searchLog);

      // Skip discarded hypotheses
      if (enrichedHypothesis.status === 'discarded') continue;

      // ── STEP 3: Marriage record search ──
      this.db.updateJobProgress(this.jobId,
        `Searching marriages for parents of ${hypothesis.forenames || '?'} ${hypothesis.surname}...`,
        this.processedCount, this.maxAncestors);

      const marriageEvidence = await this.identifyParentCouple(enrichedHypothesis, personInfo, ascNumber);
      if (marriageEvidence) {
        allSearchLog.push({ step: 3, found: true, score: marriageEvidence.score, details: marriageEvidence.details });
      } else {
        allSearchLog.push({ step: 3, found: false });
      }

      // ── STEP 4: Cross-check ──
      const crossCheckResult = this.verifyFamilyUnit(enrichedHypothesis, marriageEvidence);
      allSearchLog.push({ step: 4, verified: crossCheckResult.verified, score: crossCheckResult.crossCheckScore });

      // ── STEP 5: Reinforcement checks ──
      const reinforcements = await this.reinforcementChecks(enrichedHypothesis, personInfo, ascNumber);
      allSearchLog.push({ step: 5, reinforcements: reinforcements.length });

      // ── Score and store ──
      const result = this.scoreAndStore(
        enrichedHypothesis, marriageEvidence, crossCheckResult,
        reinforcements, personInfo, ascNumber, generation, allSearchLog
      );

      this.processedCount++;

      // If verified or probable, return — we're done with this ancestor
      if (result.confidenceScore >= 50) {
        return result;
      }
    }

    // If we exhausted all hypotheses and none verified, store the best one
    if (hypotheses.length > 0) {
      const best = hypotheses[0];
      // Do a minimal store for the best hypothesis
      const result = this.scoreAndStore(
        best, null, null, [], personInfo, ascNumber, generation, allSearchLog
      );
      this.processedCount++;
      return result;
    }

    // Nothing at all
    this.processedCount++;
    return this.storeNotFound(personInfo, ascNumber, generation, allSearchLog);
  }

  // ─── FS Lead-Only Fallback (pre-1837 or FreeBMD gaps) ────────────

  async processFsLeadOnly(personInfo, ascNumber, generation, existingLog) {
    if (!this.fsSource) {
      this.processedCount++;
      return this.storeNotFound(personInfo, ascNumber, generation, existingLog);
    }

    const { givenName, surname, birthYear, birthPlace, fatherSurname, motherMaidenSurname } = personInfo;

    const query = {
      givenName: givenName || '',
      surname: surname || '',
      birthDate: birthYear ? String(birthYear) : '',
      birthPlace: birthPlace || '',
      count: 5,
    };
    if (fatherSurname) query.fatherSurname = fatherSurname;
    if (motherMaidenSurname) query.motherSurname = motherMaidenSurname;

    try {
      const results = await this.fsSource.searchPerson(query);
      existingLog.push({ step: 'fs_fallback', query: `FS: ${givenName} ${surname}`, results_count: results.length });

      if (results.length === 0) {
        this.processedCount++;
        return this.storeNotFound(personInfo, ascNumber, generation, existingLog);
      }

      // Find best UK match
      let bestCandidate = null;
      let bestScore = 0;

      for (const candidate of results) {
        const candidatePlace = sanitizePlaceName(candidate.birthPlace || candidate.deathPlace || '');
        if (isNonUkPlace(candidatePlace) && !isUkPlace(candidatePlace)) continue;
        if (this.rejectedFsIds.has(candidate.id)) continue;

        let score = 0;
        if (this.namesSimilar(candidate.name?.split(' ')[0], givenName)) score += 20;
        const candYear = normalizeDate(candidate.birthDate)?.year;
        if (candYear && birthYear && Math.abs(candYear - birthYear) <= 3) score += 15;
        if (candidatePlace && birthPlace) {
          if (candidatePlace.toLowerCase().includes(this.extractDistrict(birthPlace).toLowerCase())) score += 10;
        }
        // Parent name match
        if (candidate.fatherName && fatherSurname) {
          const fp = parseNameParts(candidate.fatherName);
          if (fp.surname?.toLowerCase() === fatherSurname.toLowerCase()) score += 15;
        }
        if (candidate.motherName && motherMaidenSurname) {
          const mp = parseNameParts(candidate.motherName);
          if (mp.surname?.toLowerCase() === motherMaidenSurname.toLowerCase()) score += 20;
        }

        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }

      if (!bestCandidate || bestScore < 25) {
        this.processedCount++;
        return this.storeNotFound(personInfo, ascNumber, generation, existingLog);
      }

      // Store as Flagged — FS lead only, no civil records
      const evidenceChain = [{
        record_type: 'fs_tree_lead',
        source: 'FamilySearch',
        is_independent: false,
        details: `FS tree lead: ${bestCandidate.name} (${bestCandidate.id})`,
        supports: ['identity'],
        weight: 10,
      }];

      const confidenceScore = Math.min(49, 25 + bestScore);
      const confidenceLevel = this.getConfidenceLevel(confidenceScore);

      const name = bestCandidate.name || `${givenName || 'Unknown'} ${surname || ''}`.trim();
      const ancestorData = {
        fs_person_id: bestCandidate.id || '',
        name,
        gender: this.getExpectedGender(ascNumber) || bestCandidate.gender || 'Unknown',
        birth_date: bestCandidate.birthDate || String(birthYear || ''),
        birth_place: sanitizePlaceName(bestCandidate.birthPlace || birthPlace || ''),
        death_date: bestCandidate.deathDate || '',
        death_place: sanitizePlaceName(bestCandidate.deathPlace || ''),
        confidence: confidenceLevel.toLowerCase(),
        sources: ['FamilySearch'],
        raw_data: {
          fatherName: bestCandidate.fatherName || '',
          motherName: bestCandidate.motherName || '',
          motherMaidenSurname: personInfo.motherMaidenSurname || '',
          lead_only: true,
        },
        confidence_score: confidenceScore,
        confidence_level: confidenceLevel,
        evidence_chain: evidenceChain,
        search_log: existingLog,
        conflicts: [],
        verification_notes: 'FS tree lead only — no civil records found. Max status: Flagged.',
      };

      this.storeOrUpdateAncestor(ascNumber, generation, ancestorData);
      this.processedCount++;

      console.log(`[Engine] asc#${ascNumber}: ${name} — ${confidenceLevel} ${confidenceScore}% (FS lead only)`);

      return {
        verified: false,
        personInfo: {
          name,
          givenName: givenName || parseNameParts(name).givenName,
          surname: surname || parseNameParts(name).surname,
          birthYear: normalizeDate(bestCandidate.birthDate)?.year || birthYear,
          birthPlace: sanitizePlaceName(bestCandidate.birthPlace || birthPlace || ''),
          deathDate: bestCandidate.deathDate || '',
          deathPlace: sanitizePlaceName(bestCandidate.deathPlace || ''),
          fsPersonId: bestCandidate.id,
          fatherName: bestCandidate.fatherName || '',
          motherName: bestCandidate.motherName || '',
          motherMaidenSurname: personInfo.motherMaidenSurname || '',
        },
        confidenceScore,
        confidenceLevel,
      };
    } catch (err) {
      console.log(`[Engine] asc#${ascNumber}: FS fallback error: ${err.message}`);
      existingLog.push({ step: 'fs_fallback', error: err.message });
      this.processedCount++;
      return this.storeNotFound(personInfo, ascNumber, generation, existingLog);
    }
  }

  // ─── Store Not Found ──────────────────────────────────────────────

  storeNotFound(personInfo, ascNumber, generation, searchLog) {
    const existing = this.db.getAncestorByAscNumber(this.jobId, ascNumber);
    if (existing && existing.confidence_level === 'Customer Data') {
      return { verified: false, personInfo, confidenceScore: 0, confidenceLevel: 'Not Found' };
    }

    const name = (personInfo.givenName && personInfo.surname)
      ? `${personInfo.givenName} ${personInfo.surname} (not found)`
      : 'Unknown (not found)';

    this.storeOrUpdateAncestor(ascNumber, generation, {
      fs_person_id: '',
      name,
      gender: this.getExpectedGender(ascNumber) || 'Unknown',
      birth_date: String(personInfo.birthYear || personInfo.birthDate || ''),
      birth_place: sanitizePlaceName(personInfo.birthPlace || ''),
      death_date: personInfo.deathDate || '',
      death_place: sanitizePlaceName(personInfo.deathPlace || ''),
      confidence: 'not_found',
      sources: [],
      raw_data: {},
      confidence_score: 0,
      confidence_level: 'Not Found',
      evidence_chain: [],
      search_log: searchLog || [],
      conflicts: [],
      verification_notes: 'No matching records found',
    });

    return { verified: false, personInfo, confidenceScore: 0, confidenceLevel: 'Not Found' };
  }

  // ─── Enrich Customer Data With Evidence (never lower confidence) ──

  async enrichCustomerAncestor(ascNumber, generation, personInfo) {
    const existing = this.db.getAncestorByAscNumber(this.jobId, ascNumber);
    if (!existing || existing.confidence_level !== 'Customer Data') return null;

    console.log(`[Engine] Enriching customer data for asc#${ascNumber}: ${existing.name}`);
    const evidenceChain = [];
    const notes = ['Customer-provided data'];

    // Try to confirm birth via FreeBMD
    if (this.freebmdSource && personInfo.birthYear) {
      try {
        const nameParts = parseNameParts(existing.name);
        const birthResults = await this.freebmdSource.searchBirths(
          nameParts.surname || personInfo.surname, nameParts.givenName || personInfo.givenName || '',
          personInfo.birthYear - 2, personInfo.birthYear + 2,
          this.extractDistrict(personInfo.birthPlace || existing.birth_place) || ''
        );

        // Look for a matching birth
        for (const entry of birthResults) {
          if (this.namesSimilar(entry.forenames, nameParts.givenName || personInfo.givenName)) {
            const yearDiff = Math.abs((entry.year || 0) - personInfo.birthYear);
            if (yearDiff <= 2) {
              evidenceChain.push({
                record_type: 'birth',
                source: 'FreeBMD',
                is_independent: true,
                year: entry.year,
                quarter: entry.quarter,
                district: entry.district,
                volume: entry.volume,
                page: entry.page,
                details: `Birth: ${entry.forenames} ${entry.surname}, Q${entry.quarter} ${entry.year}, ${entry.district}`,
                parent_mother_maiden: entry.spouseSurname || '',
                supports: ['identity'],
                weight: 25,
              });
              notes.push(`Birth confirmed by FreeBMD: vol.${entry.volume} p.${entry.page}`);
              console.log(`[Engine] asc#${ascNumber}: Customer birth confirmed — ${entry.forenames} ${entry.surname} Q${entry.quarter} ${entry.year}`);
              break;
            }
          }
        }
      } catch (err) {
        console.log(`[Engine] asc#${ascNumber}: Birth enrichment error: ${err.message}`);
      }
    }

    // Try to find FS person for tree traversal (but NOT as evidence)
    let fsPersonId = null;
    if (this.fsSource) {
      try {
        const query = {
          givenName: personInfo.givenName || '',
          surname: personInfo.surname || '',
          birthDate: personInfo.birthYear ? String(personInfo.birthYear) : '',
          birthPlace: personInfo.birthPlace || '',
          count: 3,
        };
        if (personInfo.fatherGivenName) query.fatherGivenName = personInfo.fatherGivenName;
        if (personInfo.fatherSurname) query.fatherSurname = personInfo.fatherSurname;
        if (personInfo.motherGivenName) query.motherGivenName = personInfo.motherGivenName;
        if (personInfo.motherSurname) query.motherSurname = personInfo.motherSurname;

        const results = await this.fsSource.searchPerson(query);
        for (const candidate of results) {
          const candidatePlace = sanitizePlaceName(candidate.birthPlace || '');
          if (isNonUkPlace(candidatePlace) && !isUkPlace(candidatePlace)) continue;
          if (this.rejectedFsIds.has(candidate.id)) continue;

          // Basic sanity check — name + date roughly match
          if (this.namesSimilar(candidate.name?.split(' ')[0], personInfo.givenName)) {
            const candYear = normalizeDate(candidate.birthDate)?.year;
            if (!candYear || !personInfo.birthYear || Math.abs(candYear - personInfo.birthYear) <= 5) {
              fsPersonId = candidate.id;
              notes.push(`FS person linked: ${candidate.id} (lead only, not evidence)`);
              break;
            }
          }
        }
      } catch (err) {
        console.log(`[Engine] asc#${ascNumber}: FS enrichment error: ${err.message}`);
      }
    }

    // Update the customer data record with evidence (keep confidence at 100%)
    if (evidenceChain.length > 0 || fsPersonId) {
      const updates = {};
      if (evidenceChain.length > 0) updates.evidence_chain = evidenceChain;
      if (fsPersonId) updates.fs_person_id = fsPersonId;
      updates.verification_notes = notes.join(' | ');
      this.db.updateAncestorByAscNumber(this.jobId, ascNumber, updates);
    }

    return fsPersonId;
  }

  // ─── Build Known Anchors From Input ───────────────────────────────

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

  // ─── STEP 6: Advance Generation — Build Parent PersonInfo ────────

  buildParentPersonInfo(result, parentType, childAscNumber) {
    if (!result || !result.personInfo) return null;

    const { personInfo } = result;
    const rawData = this.db.getAncestorByAscNumber(this.jobId, childAscNumber)?.raw_data;
    let fatherName = '', motherName = '', motherMaidenSurname = '';

    if (rawData) {
      fatherName = rawData.fatherName || personInfo.fatherName || '';
      motherName = rawData.motherName || personInfo.motherName || '';
      motherMaidenSurname = rawData.motherMaidenSurname || personInfo.motherMaidenSurname || '';
    }

    if (parentType === 'father') {
      if (!fatherName) return null;
      const fp = parseNameParts(fatherName);
      return {
        givenName: fp.givenName || '',
        surname: fp.surname || personInfo.surname || '',
        birthYear: personInfo.birthYear ? personInfo.birthYear - 28 : null,
        birthPlace: personInfo.birthPlace || '',
        fatherSurname: fp.surname || personInfo.surname || '',
        motherMaidenSurname: motherMaidenSurname,
        motherGivenName: motherName ? parseNameParts(motherName).givenName : '',
        fatherGivenName: fp.givenName || '',
      };
    }

    if (parentType === 'mother') {
      if (!motherName) return null;
      const mp = parseNameParts(motherName);
      // Mother's maiden surname is the key — comes from birth record
      const maidenSurname = motherMaidenSurname || mp.surname || '';
      return {
        givenName: mp.givenName || '',
        surname: maidenSurname,
        birthYear: personInfo.birthYear ? personInfo.birthYear - 25 : null,
        birthPlace: personInfo.birthPlace || '',
        fatherSurname: maidenSurname, // mother's father's surname = her maiden name
        motherMaidenSurname: '', // we don't know mother's mother's maiden name yet
        motherGivenName: '',
        fatherGivenName: '',
      };
    }

    return null;
  }

  // ─── Search Marriage Between a Known Couple ────────────────────────
  // This is the KEY operation: for a known couple (e.g. Charles Herbert Jackson × Ethel Skinner),
  // search FreeBMD for their marriage. The marriage record gives us:
  // - Groom's surname → confirms father's surname
  // - Bride's maiden surname → critical for next generation
  // - District → location anchor
  // The marriage is evidence, and it links the couple, enabling us to advance to THEIR parents.

  async searchCoupleMarriage(husbandAsc, wifeAsc, generation) {
    const husband = this.db.getAncestorByAscNumber(this.jobId, husbandAsc);
    const wife = this.db.getAncestorByAscNumber(this.jobId, wifeAsc);

    if (!husband || !wife) return null;

    const hp = parseNameParts(husband.name);
    const wp = parseNameParts(wife.name);

    if (!hp.surname) {
      console.log(`[CoupleMarriage] asc#${husbandAsc}×${wifeAsc}: No husband surname — skipping`);
      return null;
    }

    // Calculate year range: marriage should be before their first child's birth
    // Use husband's birth year + 18 to husband's birth year + 45 as range
    const hBirthYear = normalizeDate(husband.birth_date)?.year;
    const wBirthYear = normalizeDate(wife.birth_date)?.year;
    const childAsc = Math.floor(husbandAsc / 2);
    const child = this.db.getAncestorByAscNumber(this.jobId, childAsc);
    const childBirthYear = child ? normalizeDate(child.birth_date)?.year : null;

    let yearFrom, yearTo;
    if (childBirthYear) {
      yearFrom = childBirthYear - 15;
      yearTo = childBirthYear;
    } else if (hBirthYear) {
      yearFrom = hBirthYear + 18;
      yearTo = hBirthYear + 45;
    } else {
      console.log(`[CoupleMarriage] asc#${husbandAsc}×${wifeAsc}: No usable year range — skipping`);
      return null;
    }

    const district = this.extractDistrict(husband.birth_place || wife.birth_place || '');
    console.log(`[CoupleMarriage] Searching: ${hp.givenName || '?'} ${hp.surname} × ${wp.surname || '?'}, ${yearFrom}-${yearTo}, district="${district}"`);

    this.db.updateJobProgress(this.jobId,
      `Searching marriage: ${hp.givenName || '?'} ${hp.surname} × ${wp.givenName || '?'} ${wp.surname || '?'}...`,
      this.processedCount, this.maxAncestors);

    let bestMarriage = null;
    let bestScore = 0;

    // Search by groom
    if (this.freebmdSource) {
      try {
        const results = await this.freebmdSource.searchMarriages(
          hp.surname, hp.givenName || '', yearFrom, yearTo, district
        );
        console.log(`[CoupleMarriage] ${results.length} groom results for ${hp.surname}`);

        for (const entry of results) {
          let score = 0;

          // Groom surname match
          if (entry.surname.toLowerCase() === hp.surname.toLowerCase()) score += 20;

          // Groom first name match
          if (hp.givenName && entry.forenames) {
            if (this.namesSimilar(entry.forenames, hp.givenName)) score += 20;
          }

          // Bride surname matches wife's maiden surname
          if (wp.surname && entry.spouseSurname) {
            if (entry.spouseSurname.toLowerCase() === wp.surname.toLowerCase()) score += 30;
          }

          // Year plausibility
          if (entry.year && childBirthYear) {
            const gap = childBirthYear - entry.year;
            if (gap >= 0 && gap <= 5) score += 15;
            else if (gap >= 0 && gap <= 10) score += 10;
            else if (gap >= 0 && gap <= 15) score += 5;
          } else if (entry.year && hBirthYear) {
            const age = entry.year - hBirthYear;
            if (age >= 20 && age <= 35) score += 10;
          }

          // District match
          if (district && entry.district) {
            if (entry.district.toLowerCase() === district.toLowerCase()) score += 10;
            else if (districtMatches(district, entry.district)) score += 5;
          }

          if (score > bestScore) {
            bestScore = score;
            bestMarriage = entry;
          }
        }
      } catch (err) {
        console.log(`[CoupleMarriage] Groom search error: ${err.message}`);
      }

      // Also search by bride if groom search didn't find a strong match
      if (bestScore < 50 && wp.surname) {
        try {
          const brideResults = await this.freebmdSource.searchMarriages(
            wp.surname, wp.givenName || '', yearFrom, yearTo, district
          );
          console.log(`[CoupleMarriage] ${brideResults.length} bride results for ${wp.surname}`);

          for (const entry of brideResults) {
            let score = 0;

            // Bride maiden surname matches wife
            if (entry.surname.toLowerCase() === wp.surname.toLowerCase()) score += 20;

            // Bride first name matches wife
            if (wp.givenName && entry.forenames) {
              if (this.namesSimilar(entry.forenames, wp.givenName)) score += 20;
            }

            // Spouse (groom) surname matches husband
            if (hp.surname && entry.spouseSurname) {
              if (entry.spouseSurname.toLowerCase() === hp.surname.toLowerCase()) score += 30;
            }

            // Year + district scoring same as above
            if (entry.year && childBirthYear) {
              const gap = childBirthYear - entry.year;
              if (gap >= 0 && gap <= 5) score += 15;
              else if (gap >= 0 && gap <= 10) score += 10;
            } else if (entry.year && wBirthYear) {
              const age = entry.year - wBirthYear;
              if (age >= 18 && age <= 35) score += 10;
            }

            if (district && entry.district) {
              if (entry.district.toLowerCase() === district.toLowerCase()) score += 10;
              else if (districtMatches(district, entry.district)) score += 5;
            }

            if (score > bestScore) {
              bestScore = score;
              bestMarriage = entry;
            }
          }
        } catch (err) {
          console.log(`[CoupleMarriage] Bride search error: ${err.message}`);
        }
      }
    }

    if (!bestMarriage || bestScore < 40) {
      console.log(`[CoupleMarriage] No marriage found (best score: ${bestScore})`);
      return null;
    }

    console.log(`[CoupleMarriage] FOUND: ${bestMarriage.forenames} ${bestMarriage.surname} × ${bestMarriage.spouseSurname}, Q${bestMarriage.quarter} ${bestMarriage.year}, ${bestMarriage.district} (score ${bestScore})`);

    // Update both spouses' evidence chains with the marriage record
    const marriageEvidence = {
      record_type: 'marriage',
      source: 'FreeBMD',
      is_independent: true,
      year: bestMarriage.year,
      quarter: bestMarriage.quarter,
      district: bestMarriage.district,
      volume: bestMarriage.volume,
      page: bestMarriage.page,
      details: `Marriage: ${bestMarriage.forenames} ${bestMarriage.surname} × ${bestMarriage.spouseSurname}, Q${bestMarriage.quarter} ${bestMarriage.year}, ${bestMarriage.district}`,
      groomSurname: bestMarriage.surname,
      groomForenames: bestMarriage.forenames,
      brideSurname: bestMarriage.spouseSurname,
      supports: ['couple', 'parents'],
      weight: 30,
    };

    // Store marriage evidence on both husband and wife records
    for (const asc of [husbandAsc, wifeAsc]) {
      const existing = this.db.getAncestorByAscNumber(this.jobId, asc);
      if (existing) {
        const existingChain = existing.evidence_chain || [];
        existingChain.push(marriageEvidence);
        const existingNotes = existing.verification_notes || '';
        this.db.updateAncestorByAscNumber(this.jobId, asc, {
          evidence_chain: existingChain,
          verification_notes: existingNotes + ` | Marriage: vol.${bestMarriage.volume} p.${bestMarriage.page}`,
        });
      }
    }

    return {
      marriageYear: bestMarriage.year,
      marriageDistrict: bestMarriage.district,
      groomSurname: bestMarriage.surname,
      groomForenames: bestMarriage.forenames,
      brideMaidenSurname: bestMarriage.spouseSurname,
      volume: bestMarriage.volume,
      page: bestMarriage.page,
    };
  }

  // ─── Main Run Method ──────────────────────────────────────────────

  async run() {
    try {
      this.db.updateResearchJob(this.jobId, { status: 'running' });
      this.db.deleteSearchCandidates(this.jobId);
      this.buildAnchors();

      const totalPossible = Math.pow(2, this.generations + 1) - 1;
      this.db.updateJobProgress(this.jobId, 'Starting evidence-based research...', 0, totalPossible);

      console.log(`\n[Engine] ════════════════════════════════════════════════`);
      console.log(`[Engine] Evidence-Based Research Engine — ${this.generations} generations`);
      console.log(`[Engine] Subject: ${this.inputData.given_name} ${this.inputData.surname}`);
      console.log(`[Engine] FreeBMD: ${!!this.freebmdSource}, FamilySearch: ${!!this.fsSource}`);
      console.log(`[Engine] ════════════════════════════════════════════════\n`);

      // ── Phase 1: Enrich customer-provided data (asc#1-7) with FS links ──
      // We do NOT re-prove customer ancestors. We only link them to FS IDs
      // for tree traversal leads, and optionally confirm births.

      const subjectBirthYear = normalizeDate(this.inputData.birth_date)?.year;

      const subjectInfo = {
        givenName: this.inputData.given_name,
        surname: this.inputData.surname,
        birthYear: subjectBirthYear,
        birthDate: this.inputData.birth_date,
        birthPlace: this.inputData.birth_place,
        deathDate: this.inputData.death_date || '',
        deathPlace: this.inputData.death_place || '',
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

      // Enrich subject
      await this.enrichCustomerAncestor(1, 0, subjectInfo);

      // Enrich father
      if (this.knownAnchors[2]) {
        const fatherRec = this.db.getAncestorByAscNumber(this.jobId, 2);
        const fatherInfo = {
          givenName: this.knownAnchors[2].givenName || '',
          surname: this.knownAnchors[2].surname || this.inputData.surname,
          birthYear: fatherRec ? normalizeDate(fatherRec.birth_date)?.year : (subjectBirthYear ? subjectBirthYear - 28 : null),
          birthPlace: fatherRec?.birth_place || subjectInfo.birthPlace,
          fatherGivenName: '',
          fatherSurname: this.knownAnchors[2].surname || this.inputData.surname,
        };
        await this.enrichCustomerAncestor(2, 1, fatherInfo);
      }

      // Enrich mother
      if (this.knownAnchors[3]) {
        const motherRec = this.db.getAncestorByAscNumber(this.jobId, 3);
        const motherInfo = {
          givenName: this.knownAnchors[3].givenName || '',
          surname: this.knownAnchors[3].surname || '',
          birthYear: motherRec ? normalizeDate(motherRec.birth_date)?.year : (subjectBirthYear ? subjectBirthYear - 25 : null),
          birthPlace: motherRec?.birth_place || subjectInfo.birthPlace,
        };
        await this.enrichCustomerAncestor(3, 1, motherInfo);
      }

      // Enrich grandparents
      for (const asc of [4, 5, 6, 7]) {
        if (this.knownAnchors[asc]) {
          const anchor = this.knownAnchors[asc];
          const grandRec = this.db.getAncestorByAscNumber(this.jobId, asc);
          const parentAsc = Math.floor(asc / 2);
          const parentRec = this.db.getAncestorByAscNumber(this.jobId, parentAsc);
          const parentBirthYear = parentRec ? normalizeDate(parentRec.birth_date)?.year : null;

          const info = {
            givenName: anchor.givenName || '',
            surname: anchor.surname || '',
            birthYear: grandRec ? normalizeDate(grandRec.birth_date)?.year : (parentBirthYear ? parentBirthYear - 28 : null),
            birthPlace: grandRec?.birth_place || anchor.birthPlace || parentRec?.birth_place || subjectInfo.birthPlace || '',
          };
          await this.enrichCustomerAncestor(asc, 2, info);
        }
      }

      // ── Phase 2: Search marriages between known couples ──
      // For each pair of customer-provided spouses, search for their marriage.
      // This gives us the bride's maiden surname = the key to the next generation.

      console.log(`\n[Engine] ── Phase 2: Couple Marriages (known pairs) ──\n`);

      // Known couples from customer data:
      // asc#2 (father) × asc#3 (mother) — parents of subject
      // asc#4 × asc#5 — paternal grandparents
      // asc#6 × asc#7 — maternal grandparents

      const coupleResults = {};
      const couples = [
        [2, 3],   // father × mother
        [4, 5],   // paternal grandfather × grandmother
        [6, 7],   // maternal grandfather × grandmother
      ];

      for (const [husbandAsc, wifeAsc] of couples) {
        const husband = this.db.getAncestorByAscNumber(this.jobId, husbandAsc);
        const wife = this.db.getAncestorByAscNumber(this.jobId, wifeAsc);
        if (husband && wife) {
          const gen = husband.generation || Math.floor(Math.log2(husbandAsc));
          const result = await this.searchCoupleMarriage(husbandAsc, wifeAsc, gen);
          if (result) {
            coupleResults[`${husbandAsc}x${wifeAsc}`] = result;
          }
        }
      }

      // ── Phase 3: Advance from known grandparents to great-grandparents ──
      // For each grandparent couple (asc#4×5, asc#6×7), we now know the wife's maiden
      // surname from the marriage search. Use that to find their parents (gen 3+).

      console.log(`\n[Engine] ── Phase 3: Discover unknown ancestors ──\n`);

      const queue = [];
      const processed = new Set();

      // Mark all customer-provided ancestors as processed (asc#1-7)
      for (let i = 1; i <= 7; i++) {
        processed.add(i);
        this.processedCount++;
      }

      // For each known grandparent, build parent search info and queue their parents
      for (const asc of [4, 5, 6, 7]) {
        const ancestor = this.db.getAncestorByAscNumber(this.jobId, asc);
        if (!ancestor) continue;

        const fatherAsc = asc * 2;
        const motherAsc = asc * 2 + 1;
        const nextGen = (ancestor.generation || 2) + 1;
        if (nextGen > this.generations) continue;

        const ap = parseNameParts(ancestor.name);
        const birthYear = normalizeDate(ancestor.birth_date)?.year;
        const birthPlace = ancestor.birth_place || '';

        // Get FS person data for parent names
        let fatherName = '', motherName = '', motherMaidenSurname = '';
        if (ancestor.fs_person_id && this.fsSource) {
          try {
            const parents = await fsApi.getParents(ancestor.fs_person_id);
            if (parents.father) {
              fatherName = parents.father.name || '';
              console.log(`[Engine] asc#${asc}: FS tree father lead → ${fatherName}`);
            }
            if (parents.mother) {
              motherName = parents.mother.name || '';
              console.log(`[Engine] asc#${asc}: FS tree mother lead → ${motherName}`);
            }
          } catch (err) {
            console.log(`[Engine] asc#${asc}: FS parent lookup error: ${err.message}`);
          }
        }

        // Get marriage info for this couple — the wife's maiden surname
        // asc#4's wife is asc#5, asc#6's wife is asc#7
        if (asc % 2 === 0) {
          const coupleKey = `${asc}x${asc + 1}`;
          const marriage = coupleResults[coupleKey];
          if (marriage) {
            // The bride's maiden surname is the mother's (wife's) birth surname
            // which gives us THEIR father's surname
            const wifeRec = this.db.getAncestorByAscNumber(this.jobId, asc + 1);
            if (wifeRec) {
              motherMaidenSurname = parseNameParts(wifeRec.name).surname || '';
            }
          }
        }

        // Queue father of this ancestor
        if (fatherName || ap.surname) {
          const fp = fatherName ? parseNameParts(fatherName) : { givenName: '', surname: ap.surname };
          queue.push({
            ascNumber: fatherAsc,
            generation: nextGen,
            personInfo: {
              givenName: fp.givenName || '',
              surname: fp.surname || ap.surname || '',
              birthYear: birthYear ? birthYear - 28 : null,
              birthPlace: birthPlace,
              fatherSurname: fp.surname || ap.surname || '',
              motherMaidenSurname: motherMaidenSurname,
              fatherGivenName: '',
              motherGivenName: motherName ? parseNameParts(motherName).givenName : '',
            },
          });
        }

        // Queue mother of this ancestor
        if (motherName || motherMaidenSurname) {
          const mp = motherName ? parseNameParts(motherName) : { givenName: '', surname: motherMaidenSurname };
          const maidenSurname = motherMaidenSurname || mp.surname || '';
          queue.push({
            ascNumber: motherAsc,
            generation: nextGen,
            personInfo: {
              givenName: mp.givenName || '',
              surname: maidenSurname,
              birthYear: birthYear ? birthYear - 25 : null,
              birthPlace: birthPlace,
              fatherSurname: maidenSurname,
              motherMaidenSurname: '',
              fatherGivenName: '',
              motherGivenName: '',
            },
          });
        }
      }

      // Also add parents of father (asc#2) and mother (asc#3) if we don't already have them
      // from customer data (asc#4-7). This handles the case where customer provided parents
      // but no grandparents.
      for (const asc of [2, 3]) {
        const ancestor = this.db.getAncestorByAscNumber(this.jobId, asc);
        if (!ancestor) continue;
        const fatherAsc = asc * 2;
        const motherAsc = asc * 2 + 1;
        // Only if grandparents aren't already customer-provided
        if (this.db.getAncestorByAscNumber(this.jobId, fatherAsc)) continue;

        const ap = parseNameParts(ancestor.name);
        const birthYear = normalizeDate(ancestor.birth_date)?.year;
        const birthPlace = ancestor.birth_place || '';

        let fatherName = '', motherName = '';
        if (ancestor.fs_person_id && this.fsSource) {
          try {
            const parents = await fsApi.getParents(ancestor.fs_person_id);
            if (parents.father) fatherName = parents.father.name || '';
            if (parents.mother) motherName = parents.mother.name || '';
          } catch (err) {}
        }

        // Get wife's maiden surname from couple marriage
        let motherMaidenSurname = '';
        if (asc === 2) {
          const marriage = coupleResults['2x3'];
          if (marriage) motherMaidenSurname = marriage.brideMaidenSurname || '';
        }

        if (fatherName || ap.surname) {
          const fp = fatherName ? parseNameParts(fatherName) : { givenName: '', surname: ap.surname };
          if (!processed.has(fatherAsc)) {
            queue.push({
              ascNumber: fatherAsc,
              generation: 2,
              personInfo: {
                givenName: fp.givenName || '',
                surname: fp.surname || ap.surname || '',
                birthYear: birthYear ? birthYear - 28 : null,
                birthPlace: birthPlace,
                fatherSurname: fp.surname || ap.surname || '',
                motherMaidenSurname: motherMaidenSurname,
                fatherGivenName: '',
                motherGivenName: '',
              },
            });
          }
        }

        if (motherName) {
          const mp = parseNameParts(motherName);
          if (!processed.has(motherAsc)) {
            queue.push({
              ascNumber: motherAsc,
              generation: 2,
              personInfo: {
                givenName: mp.givenName || '',
                surname: motherMaidenSurname || mp.surname || '',
                birthYear: birthYear ? birthYear - 25 : null,
                birthPlace: birthPlace,
                fatherSurname: motherMaidenSurname || mp.surname || '',
                motherMaidenSurname: '',
                fatherGivenName: '',
                motherGivenName: '',
              },
            });
          }
        }
      }

      // Process the queue — evidence pipeline for each unknown ancestor
      while (queue.length > 0) {
        const { ascNumber, generation, personInfo } = queue.shift();

        if (processed.has(ascNumber)) continue;
        if (generation > this.generations) continue;
        processed.add(ascNumber);

        if (!personInfo.givenName && !personInfo.surname) continue;
        if (personInfo.givenName && personInfo.givenName.includes('(not found)')) continue;

        const result = await this.processAncestor(personInfo, ascNumber, generation);

        // Only advance if at least Possible
        if (result && result.confidenceScore >= 50) {
          const fatherAsc = ascNumber * 2;
          const motherAsc = ascNumber * 2 + 1;
          const nextGen = generation + 1;

          if (nextGen <= this.generations) {
            const fatherInfo = this.buildParentFromResult(result, 'father', ascNumber, nextGen);
            if (fatherInfo && !processed.has(fatherAsc)) {
              queue.push({ ascNumber: fatherAsc, generation: nextGen, personInfo: fatherInfo });
            }

            const motherInfo = this.buildParentFromResult(result, 'mother', ascNumber, nextGen);
            if (motherInfo && !processed.has(motherAsc)) {
              queue.push({ ascNumber: motherAsc, generation: nextGen, personInfo: motherInfo });
            }
          }
        } else {
          console.log(`[Engine] asc#${ascNumber}: Score too low (${result?.confidenceScore || 0}%) — NOT advancing to parents`);
        }
      }

      // ── Complete ──
      const ancestors = this.db.getAncestors(this.jobId);
      const verified = ancestors.filter(a => a.confidence_level === 'Verified' || a.confidence_level === 'Customer Data').length;
      const probable = ancestors.filter(a => a.confidence_level === 'Probable').length;
      const possible = ancestors.filter(a => a.confidence_level === 'Possible').length;
      const flagged = ancestors.filter(a => a.confidence_level === 'Flagged').length;

      this.db.updateResearchJob(this.jobId, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        results: {
          total_ancestors: ancestors.length,
          verified,
          probable,
          possible,
          flagged,
        },
      });
      this.db.updateJobProgress(this.jobId, 'Research complete', ancestors.length, ancestors.length);

      console.log(`\n[Engine] ════════════════════════════════════════════════`);
      console.log(`[Engine] COMPLETE: ${ancestors.length} ancestors`);
      console.log(`[Engine] Verified/Customer: ${verified}, Probable: ${probable}, Possible: ${possible}, Flagged: ${flagged}`);
      console.log(`[Engine] ════════════════════════════════════════════════\n`);

    } catch (err) {
      console.error(`Research engine error for job ${this.jobId}:`, err);
      this.db.updateResearchJob(this.jobId, {
        status: 'failed',
        error_message: err.message,
      });
    }
  }

  // ─── Build parent info from customer data + evidence result ───────

  buildParentFromCustomerOrEvidence(ascNumber, generation, childResult, childInputInfo) {
    const anchor = this.knownAnchors[ascNumber];
    const isFather = ascNumber % 2 === 0;

    // Start from customer-provided data if available
    let givenName = anchor?.givenName || '';
    let surname = anchor?.surname || '';
    let birthYear = null;
    let birthPlace = childInputInfo.birthPlace || '';

    // Fill in from evidence result if available
    if (childResult?.personInfo) {
      const resultData = childResult.personInfo;
      if (isFather) {
        if (!givenName && resultData.fatherName) {
          const fp = parseNameParts(resultData.fatherName);
          givenName = fp.givenName || givenName;
          surname = fp.surname || surname;
        }
        if (!surname) surname = childInputInfo.surname || '';
      } else {
        if (!givenName && resultData.motherName) {
          const mp = parseNameParts(resultData.motherName);
          givenName = mp.givenName || givenName;
          if (!surname) surname = resultData.motherMaidenSurname || mp.surname || '';
        }
      }
    }

    // Estimate birth year
    const childBirthYear = normalizeDate(childInputInfo.birthDate || childInputInfo.birth_date)?.year;
    if (childBirthYear) {
      birthYear = isFather ? childBirthYear - 28 : childBirthYear - 25;
    }

    if (!givenName && !surname) return null;

    const motherMaidenSurname = isFather
      ? (childResult?.personInfo?.motherMaidenSurname || (this.knownAnchors[3]?.surname) || '')
      : ''; // For the mother's own parents, we don't yet know her mother's maiden name

    return {
      givenName,
      surname,
      birthYear,
      birthPlace,
      fatherSurname: surname, // parent's father surname = their own surname
      motherMaidenSurname,
      fatherGivenName: '',
      motherGivenName: '',
    };
  }

  // ─── Build parent info from a processed result ────────────────────

  buildParentFromResult(result, parentType, childAscNumber, nextGeneration) {
    if (!result || !result.personInfo) return null;

    const { personInfo } = result;
    const childAncestor = this.db.getAncestorByAscNumber(this.jobId, childAscNumber);
    const rawData = childAncestor?.raw_data || {};

    const fatherName = rawData.fatherName || personInfo.fatherName || '';
    const motherName = rawData.motherName || personInfo.motherName || '';
    const motherMaidenSurname = rawData.motherMaidenSurname || personInfo.motherMaidenSurname || '';

    if (parentType === 'father') {
      if (!fatherName && !personInfo.surname) return null;
      const fp = fatherName ? parseNameParts(fatherName) : { givenName: '', surname: personInfo.surname };

      // Check if we already have customer data for this position
      const fatherAsc = childAscNumber * 2;
      const existingAncestor = this.db.getAncestorByAscNumber(this.jobId, fatherAsc);
      if (existingAncestor && existingAncestor.confidence_level === 'Customer Data') {
        // Use customer data as base but augment with evidence
        const cp = parseNameParts(existingAncestor.name);
        return {
          givenName: cp.givenName || fp.givenName || '',
          surname: cp.surname || fp.surname || personInfo.surname || '',
          birthYear: normalizeDate(existingAncestor.birth_date)?.year || (personInfo.birthYear ? personInfo.birthYear - 28 : null),
          birthPlace: existingAncestor.birth_place || personInfo.birthPlace || '',
          fatherSurname: cp.surname || fp.surname || personInfo.surname || '',
          motherMaidenSurname: motherMaidenSurname,
          fatherGivenName: '',
          motherGivenName: '',
        };
      }

      return {
        givenName: fp.givenName || '',
        surname: fp.surname || personInfo.surname || '',
        birthYear: personInfo.birthYear ? personInfo.birthYear - 28 : null,
        birthPlace: personInfo.birthPlace || '',
        fatherSurname: fp.surname || personInfo.surname || '',
        motherMaidenSurname: motherMaidenSurname,
        fatherGivenName: '',
        motherGivenName: '',
      };
    }

    if (parentType === 'mother') {
      if (!motherName && !motherMaidenSurname) return null;
      const mp = motherName ? parseNameParts(motherName) : { givenName: '', surname: motherMaidenSurname };
      const maidenSurname = motherMaidenSurname || mp.surname || '';

      // Check if we already have customer data for this position
      const motherAsc = childAscNumber * 2 + 1;
      const existingAncestor = this.db.getAncestorByAscNumber(this.jobId, motherAsc);
      if (existingAncestor && existingAncestor.confidence_level === 'Customer Data') {
        const cp = parseNameParts(existingAncestor.name);
        return {
          givenName: cp.givenName || mp.givenName || '',
          surname: cp.surname || maidenSurname || '',
          birthYear: normalizeDate(existingAncestor.birth_date)?.year || (personInfo.birthYear ? personInfo.birthYear - 25 : null),
          birthPlace: existingAncestor.birth_place || personInfo.birthPlace || '',
          fatherSurname: cp.surname || maidenSurname || '',
          motherMaidenSurname: '',
          fatherGivenName: '',
          motherGivenName: '',
        };
      }

      return {
        givenName: mp.givenName || '',
        surname: maidenSurname,
        birthYear: personInfo.birthYear ? personInfo.birthYear - 25 : null,
        birthPlace: personInfo.birthPlace || '',
        fatherSurname: maidenSurname,
        motherMaidenSurname: '',
        fatherGivenName: '',
        motherGivenName: '',
      };
    }

    return null;
  }
}

module.exports = { ResearchEngine, parseNotesForAnchors, parseNameParts };
