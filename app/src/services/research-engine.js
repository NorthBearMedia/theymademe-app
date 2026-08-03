const fsApi = require('./familysearch-api');
const { districtMatches } = require('./freebmd-client'); // used by legacy methods
const { RULES, RULES_VERSION, RULES_HASH } = require('../rules/genealogy-rules');
const { resolveCounty, countyProximity, placeProximity } = require('./county-data');

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
  'finland', 'iceland', 'portugal', 'poland', 'czech', 'hungary', 'romania',
  'nula-seleän', 'tāmaki-makau-rau',
  // FamilySearch Old English / localized country names
  'svedän', 'sveþjóð', 'suomi', 'finnland', 'danmark', 'danmǫrk',
  'deutschland', 'þýskaland', 'frankreich', 'frankrike',
  'nederland', 'belgien', 'schweiz', 'österreich', 'ísland',
  'irland', 'italia', 'españa', 'espanha', 'skåne',
  // Indian states (FS uses these without 'India')
  'uttar pradesh', 'madhya pradesh', 'andhra pradesh', 'tamil nadu', 'karnataka',
  'maharashtra', 'gujarat', 'rajasthan', 'bihar', 'west bengal', 'punjab',
  'kerala', 'odisha', 'jharkhand', 'assam', 'himachal pradesh',
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
  // FamilySearch Old English county names
  'sūþrīge', 'heorotfordscír', 'centlond', 'bro an hañv',
  'oxenaford', 'north hamtunscire', 'stæffordscīr',
  'dēfnascīr', 'dorseteschyre', 'glēawceasterscīr',
  'èirinn a tuath', 'daire',
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
  // Irish Gaelic
  'Èirinn a Tuath': 'Northern Ireland',
  // Swedish (FS also uses Swedish locale)
  'Svedän': 'Sweden', 'Sverige': 'Sweden',
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
    // Additional Old English forms found in FS search results
    'bearrucscīr': 'Berkshire',
    'bearrucscir': 'Berkshire',
    'stæffordscīr': 'Staffordshire',
    'staeffordscir': 'Staffordshire',
    'roteland': 'Rutland',
    'north hamtunscire': 'Northamptonshire',
    'north hamtūnscīr': 'Northamptonshire',
    'daire': 'Londonderry',
    'heorotfordscír': 'Hertfordshire',
    'heorotfordscir': 'Hertfordshire',
    'dorseteschyre': 'Dorset',
    'ratae coritanorum': 'Leicestershire',
    // Additional forms found in FS Beta search results (Feb 2026)
    'sūþrīge': 'Surrey',
    'suþrige': 'Surrey',
    'wæringscīr': 'Warwickshire',
    'waeringscir': 'Warwickshire',
    'legeceasterscir': 'Cheshire',
    'legaceasterscir': 'Cheshire',
    'middleseaxon': 'Middlesex',
    'lancasterscir': 'Lancashire',
    'cumberland': 'Cumberland',
    'cornwealas': 'Cornwall',
    'norðhamtūnscīr': 'Northamptonshire',
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

// ─── Common UK Surnames (require stricter matching) ──────────────────
// Top 100 UK surnames — direct search with these needs more evidence
const COMMON_UK_SURNAMES = new Set([
  'smith', 'jones', 'taylor', 'brown', 'williams', 'wilson', 'johnson', 'davies',
  'robinson', 'wright', 'thompson', 'evans', 'walker', 'white', 'roberts', 'green',
  'hall', 'wood', 'jackson', 'clarke', 'harris', 'clark', 'turner', 'hill', 'scott',
  'cooper', 'morris', 'ward', 'moore', 'king', 'watson', 'baker', 'allen', 'martin',
  'james', 'lee', 'young', 'lewis', 'cook', 'thomas', 'morgan', 'bell', 'bennett',
  'edwards', 'harrison', 'hughes', 'hunt', 'carter', 'campbell', 'mitchell', 'shaw',
  'parker', 'phillips', 'collins', 'price', 'kelly', 'mason', 'cox', 'richardson',
  'fox', 'gray', 'rose', 'chapman', 'hunt', 'marshall', 'simpson', 'anderson',
  'adams', 'reid', 'campbell', 'stewart', 'murphy', 'kennedy', 'watts', 'holmes',
  'palmer', 'mills', 'barnes', 'owen', 'powell', 'webb', 'butler', 'fisher',
  'russell', 'ford', 'stone', 'cole', 'west', 'knight', 'griffin', 'murray',
  'barker', 'harvey', 'berry', 'grant', 'perkins', 'poole', 'dixon', 'warren',
]);

function isCommonSurname(surname) {
  return COMMON_UK_SURNAMES.has((surname || '').toLowerCase());
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

// ─── Record-Based Points Scoring System ─────────────────────────────
// Classifies FS source records and scores ancestors based on actual
// historical records, person facts, family context, and plausibility.

function classifySourceRecord(title) {
  const t = (title || '').toLowerCase();

  // Civil Registration: birth/marriage/death AND registration/index/register/certificate, NOT parish
  if (!t.includes('parish')) {
    const civilIndicators = ['registration', 'index', 'register', 'certificate'];
    if (t.includes('birth') && civilIndicators.some(ind => t.includes(ind))) {
      return { category: 'Civil Registration', subType: 'birth', key: 'civil_birth' };
    }
    if (t.includes('marriage') && civilIndicators.some(ind => t.includes(ind))) {
      return { category: 'Civil Registration', subType: 'marriage', key: 'civil_marriage' };
    }
    if (t.includes('death') && civilIndicators.some(ind => t.includes(ind))) {
      return { category: 'Civil Registration', subType: 'death', key: 'civil_death' };
    }
  }

  // Census — extract year for dedup
  if (t.includes('census')) {
    const yearMatch = t.match(/(\d{4})/);
    const year = yearMatch ? yearMatch[1] : 'unknown';
    return { category: 'Census', subType: year, key: `census_${year}` };
  }

  // 1939 Register
  if (t.includes('1939 register') || t.includes('national register')) {
    return { category: '1939 Register', subType: '1939', key: '1939_register' };
  }

  // Parish Register
  if (t.includes('parish register') || t.includes('christening') ||
      t.includes('baptism') || t.includes('burial') || t.includes('banns')) {
    const yearMatch = t.match(/(\d{4})/);
    const yearKey = yearMatch ? yearMatch[1] : '';
    return { category: 'Parish Register', subType: 'parish', key: `parish_${yearKey}_${t.substring(0, 40)}` };
  }

  // Military
  if (['military', 'army', 'navy', 'air force', 'war', 'medal', 'conscription'].some(w => t.includes(w))) {
    return { category: 'Military', subType: 'military', key: `military_${t.substring(0, 40)}` };
  }

  // Probate/Will
  if (t.includes('probate') || (t.includes('will') && (t.includes('proved') || t.includes('grant'))) || t.includes('administration')) {
    return { category: 'Probate', subType: 'probate', key: 'probate' };
  }

  return { category: 'Other', subType: 'other', key: `other_${t.substring(0, 40)}` };
}

// Section 1: Score source records from getPersonSources()
// Returns {points, notes[], evidenceChain[]}
function scoreSourceRecords(sources) {
  if (!sources || sources.length === 0) {
    return { points: 0, notes: ['Sources: none found'], evidenceChain: [] };
  }

  // Deduplicate by title
  const seen = new Set();
  const unique = [];
  for (const s of sources) {
    const normTitle = (s.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(normTitle)) {
      seen.add(normTitle);
      unique.push(s);
    }
  }

  // Classify and deduplicate by key
  const byKey = new Map();
  for (const s of unique) {
    const classification = classifySourceRecord(s.title);
    if (!byKey.has(classification.key)) {
      byKey.set(classification.key, { source: s, classification });
    }
  }

  // Apply points with caps per category
  let points = 0;
  const noteItems = [];
  const evidenceChain = [];
  const categoryCounts = {};

  // Points and caps per category — defined in the master rulebook.
  const CATEGORY_POINTS = RULES.sources.categoryPoints;

  for (const [key, { source, classification }] of byKey) {
    const cat = classification.category;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    const config = CATEGORY_POINTS[cat] || CATEGORY_POINTS['Other'];

    if (categoryCounts[cat] <= config.maxRecords) {
      points += config.points;
      const yearSuffix = classification.subType && classification.subType !== cat.toLowerCase() && /^\d{4}$/.test(classification.subType)
        ? `, ${classification.subType}` : '';
      noteItems.push(`${source.title || cat}${yearSuffix} (+${config.points})`);
      evidenceChain.push({
        source_type: cat,
        title: source.title || cat,
        url: source.url || '',
        citation: source.citation || '',
        weight: config.points,
      });
    }
  }

  const notes = noteItems.length > 0
    ? [`Sources: ${noteItems.join(', ')}`]
    : ['Sources: none found'];

  return { points, notes, evidenceChain };
}

// Section 2: Score person facts from extractFactsByType()
// Returns {points, notes[]}
function scorePersonFacts(facts) {
  if (!facts) return { points: 0, notes: ['Facts: none available'] };

  let points = 0;
  const noteItems = [];

  // Birth/christening date
  const birthFact = (facts.birth || []).find(f => f.date) || (facts.baptism || []).find(f => f.date);
  if (birthFact && birthFact.date) {
    points += 5;
    noteItems.push(`birth date ${birthFact.date} (+5)`);
  }

  // Birth/christening place
  const birthPlaceFact = (facts.birth || []).find(f => f.place) || (facts.baptism || []).find(f => f.place);
  if (birthPlaceFact && birthPlaceFact.place) {
    points += 5;
    noteItems.push(`birth place ${birthPlaceFact.place} (+5)`);
  }

  // Death date (non-empty, non-placeholder)
  const deathFact = (facts.death || []).find(f => f.date && f.date.trim().length > 0);
  if (deathFact) {
    points += 3;
    noteItems.push(`death date ${deathFact.date} (+3)`);
  }

  // Death place
  const deathPlaceFact = (facts.death || []).find(f => f.place && f.place.trim().length > 0);
  if (deathPlaceFact) {
    points += 3;
    noteItems.push(`death place ${deathPlaceFact.place} (+3)`);
  }

  // Marriage fact
  if (facts.marriage && facts.marriage.length > 0) {
    points += 5;
    const mf = facts.marriage[0];
    noteItems.push(`marriage${mf.date ? ' ' + mf.date : ''}${mf.place ? ' ' + mf.place : ''} (+5)`);
  }

  // Residence facts with place, max 2
  const resFacts = (facts.residence || []).filter(f => f.place && f.place.trim().length > 0);
  const resCount = Math.min(resFacts.length, 2);
  for (let i = 0; i < resCount; i++) {
    points += 3;
    noteItems.push(`residence ${resFacts[i].date || ''} ${resFacts[i].place || ''} (+3)`.trim());
  }

  // Census facts, max 2
  const censusFacts = (facts.census || []).filter(f => f.date || f.place);
  const censusCount = Math.min(censusFacts.length, 2);
  for (let i = 0; i < censusCount; i++) {
    points += 3;
    noteItems.push(`census ${censusFacts[i].date || ''} ${censusFacts[i].place || ''} (+3)`.trim());
  }

  const notes = noteItems.length > 0
    ? [`Facts: ${noteItems.join(', ')}`]
    : ['Facts: none recorded'];

  return { points: Math.min(points, RULES.confidence.sectionCaps.facts), notes };
}

// Section 5 mapping: total points → percentage. Thresholds come from the
// master rulebook (RULES.confidence) so the engine and the rules never drift.
function computeFinalScore(points) {
  const c = RULES.confidence;
  if (points >= c.verifiedMinPoints) return Math.min(95, c.levelCutoffs.verified + Math.min(5, points - c.verifiedMinPoints));   // Verified
  if (points >= c.probableMinPoints) return Math.min(89, c.levelCutoffs.probable + Math.min(14, points - c.probableMinPoints));  // Probable
  if (points >= c.possibleMinPoints) return Math.min(74, c.levelCutoffs.possible + Math.min(24, points - c.possibleMinPoints));  // Possible
  if (points >= c.suggestedMinPoints) return Math.min(49, 30 + Math.min(19, points - c.suggestedMinPoints));                     // Suggested
  if (points <= c.heavyPenaltyMaxPoints) return 0;                                                                               // Heavily penalized
  return c.defaultPercent;
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

  // Helper: clean death date — "living"/"present" → empty string
  const cleanDeathDate = (d) => (d && !['present', 'living'].includes(d.toLowerCase())) ? d : '';

  // ─── Paternal Grandparents ─── (asc#4 = grandfather, asc#5 = grandmother)
  // Patterns: "Paternal GP:", "Paternal grandparents:", "grandfather was Name"
  const pgMatch = notes.match(/(?:paternal\s+(?:gp|grandparents?)\s*[:\-–]\s*)([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\)/i)
    || notes.match(/(?:paternal\s+)?grandfather\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\))?(?:,|\.|born|from|and|$)/i);
  if (pgMatch) {
    anchors[4] = { ...parseNameParts(pgMatch[1].trim()), birthDate: pgMatch[2] || '', deathDate: cleanDeathDate(pgMatch[3]) };
  }

  // Second person after "and" for grandmother (Paternal GP: Name1 (y-y) and Name2 (y-y))
  const pgmMatch = notes.match(/(?:paternal\s+(?:gp|grandparents?)\s*[:\-–].*?and\s+)([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\)/i)
    || notes.match(/(?:paternal\s+)?grandmother\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\))?(?:,|\.|born|from|$)/i);
  if (pgmMatch) {
    anchors[5] = { ...parseNameParts(pgmMatch[1].trim()), birthDate: pgmMatch[2] || '', deathDate: cleanDeathDate(pgmMatch[3]) };
  }

  // ─── Maternal Grandparents ─── (asc#6 = grandfather, asc#7 = grandmother)
  const mgMatch = notes.match(/(?:maternal\s+(?:gp|grandparents?)\s*[:\-–]\s*)([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\)/i)
    || notes.match(/maternal\s+grandfather\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\))?(?:,|\.|born|from|and|$)/i);
  if (mgMatch) {
    anchors[6] = { ...parseNameParts(mgMatch[1].trim()), birthDate: mgMatch[2] || '', deathDate: cleanDeathDate(mgMatch[3]) };
  }

  const mgmMatch = notes.match(/(?:maternal\s+(?:gp|grandparents?)\s*[:\-–].*?and\s+)([A-Z][a-zA-Z\s]+?)\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\)/i)
    || notes.match(/maternal\s+grandmother\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\))?(?:,|\.|born|from|$)/i);
  if (mgmMatch) {
    anchors[7] = { ...parseNameParts(mgmMatch[1].trim()), birthDate: mgmMatch[2] || '', deathDate: cleanDeathDate(mgmMatch[3]) };
  }

  // ─── Great-Grandparents (asc#8-15) ───
  // Format: "Great-grandfather (paternal paternal): Frederick Hunt"
  // or "Great-grandmother (maternal maternal): Gertrude May Griffin"
  // Mapping: paternal paternal = asc 8/9, paternal maternal = 10/11,
  //          maternal paternal = 12/13, maternal maternal = 14/15
  const ggpLineageMap = {
    'paternal paternal': { father: 8, mother: 9 },
    'paternal maternal': { father: 10, mother: 11 },
    'maternal paternal': { father: 12, mother: 13 },
    'maternal maternal': { father: 14, mother: 15 },
  };

  // Match patterns like:
  //   Great-grandfather (paternal paternal): Name (birth-death)
  //   Great-grandmother (maternal maternal): Name
  //   Great grandfather (paternal maternal): Name (birth-death)
  const ggpPattern = /great[- ]?grand(father|mother)\s*\(([^)]+)\)\s*[:\-–]\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\))?(?:\s*$|\s*\n|,|\.|;)/gim;
  let ggpMatch;
  while ((ggpMatch = ggpPattern.exec(notes)) !== null) {
    const role = ggpMatch[1].toLowerCase(); // 'father' or 'mother'
    const lineage = ggpMatch[2].trim().toLowerCase(); // e.g. 'paternal paternal'
    const name = ggpMatch[3].trim();
    const birthYear = ggpMatch[4] || '';
    const deathYear = cleanDeathDate(ggpMatch[5]);

    const mapping = ggpLineageMap[lineage];
    if (mapping) {
      const ascNum = role === 'father' ? mapping.father : mapping.mother;
      anchors[ascNum] = {
        ...parseNameParts(name),
        birthDate: birthYear,
        deathDate: deathYear,
      };
    }
  }

  // Match prefix-lineage format:
  //   "Paternal paternal great-grandfather: Frederick Hunt"
  //   "Maternal maternal great-grandmother: Gertrude May Griffin"
  //   "Paternal maternal great-grandmother: Jessie Priscilla Mayne"
  const ggpPrefixPattern = /(paternal|maternal)\s+(paternal|maternal)\s+great[- ]?grand(father|mother)\s*[:\-–]\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\))?(?:\s*$|\s*\n|,|\.|;)/gim;
  let ggpPrefixMatch;
  while ((ggpPrefixMatch = ggpPrefixPattern.exec(notes)) !== null) {
    const lineage = `${ggpPrefixMatch[1].toLowerCase()} ${ggpPrefixMatch[2].toLowerCase()}`;
    const role = ggpPrefixMatch[3].toLowerCase(); // 'father' or 'mother'
    const name = ggpPrefixMatch[4].trim();
    const birthYear = ggpPrefixMatch[5] || '';
    const deathYear = cleanDeathDate(ggpPrefixMatch[6]);

    const mapping = ggpLineageMap[lineage];
    if (mapping) {
      const ascNum = role === 'father' ? mapping.father : mapping.mother;
      if (!anchors[ascNum]) { // Don't overwrite if already set by parenthesized format
        anchors[ascNum] = {
          ...parseNameParts(name),
          birthDate: birthYear,
          deathDate: deathYear,
        };
      }
    }
  }

  // Also match simpler "Great-grandparents:" list format without explicit lineage qualifier
  // e.g. "GGP8: Frederick Hunt (1900-1970)" or "asc#8: Frederick Hunt"
  const ggpAscPattern = /(?:GGP|asc\s*#?)(\d{1,2})\s*[:\-–]\s*([A-Z][a-zA-Z\s]+?)(?:\s*\((\d{4})\s*[-–]\s*(\d{4}|present|living)?\))?(?:\s*$|\s*\n|,|\.|;)/gim;
  let ggpAscMatch;
  while ((ggpAscMatch = ggpAscPattern.exec(notes)) !== null) {
    const ascNum = parseInt(ggpAscMatch[1], 10);
    if (ascNum >= 8 && ascNum <= 15) {
      const name = ggpAscMatch[2].trim();
      anchors[ascNum] = {
        ...parseNameParts(name),
        birthDate: ggpAscMatch[3] || '',
        deathDate: cleanDeathDate(ggpAscMatch[4]),
      };
    }
  }

  // ─── Enhanced Date/Place Extraction: Parse data on same line as name ───
  // This is the PRIMARY extraction method. Handles:
  //   "Norman Hunt, b. 01.01.1931, Derby Derbyshire, d. 20.02.1991"
  //   "Frederick Hunt, born 1900, died 1970"
  // Must run FIRST so we get accurate per-line data before fallback
  for (const [asc, anchor] of Object.entries(anchors)) {
    if (!anchor.givenName) continue;
    // Build a regex for this ancestor's full name (given + surname)
    const nameParts = [anchor.givenName];
    if (anchor.surname) nameParts.push(anchor.surname);
    const escapedName = nameParts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const nameRegex = new RegExp(escapedName + '(.*)$', 'im');
    const lineMatch = notes.match(nameRegex);
    if (!lineMatch) continue;
    const restOfLine = lineMatch[1] || '';

    // Extract birth date: "b. 01.01.1931" or "b 1931" or "born 1931" or ", b. Dec 1938"
    if (!anchor.birthDate) {
      const bMatch = restOfLine.match(/(?:,\s*)?(?:born|b\.?)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}|(?:\d{1,2}\s+)?[A-Z][a-z]+\s+\d{4})/i);
      if (bMatch) anchors[asc].birthDate = bMatch[1];
    }

    // Extract death date: "d. 20.02.1991" or "d 1991" or "died 1991"
    if (!anchor.deathDate) {
      const dMatch = restOfLine.match(/(?:,\s*)?(?:died|d\.?)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}|(?:\d{1,2}\s+)?[A-Z][a-z]+\s+\d{4})/i);
      if (dMatch) anchors[asc].deathDate = dMatch[1];
    }

    // Extract birth place — text between birth date and death/end-of-line
    if (!anchor.birthPlace) {
      const pMatch = restOfLine.match(/(?:born|b\.?)\s+[\d./-]+\s*,\s*([A-Z][a-zA-Z\s,]+?)(?:\s*,\s*(?:d\.|died)|$)/i);
      if (pMatch) anchors[asc].birthPlace = pMatch[1].trim();
    }
  }

  // ─── Surname-based fallback for remaining empty dates ───
  // Only fills in dates when the FULL name (given + surname) is found in context, not just surname
  // This prevents "Hunt" in Alan's line from being applied to Norman's record
  const datePattern = /(?:born|b\.?)\s+(?:(?:on|in)\s+)?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}|(?:\d{1,2}\s+)?[A-Z][a-z]+\s+\d{4})/gi;
  let dateMatch;
  while ((dateMatch = datePattern.exec(notes)) !== null) {
    const context = notes.substring(Math.max(0, dateMatch.index - 100), dateMatch.index);
    for (const [asc, anchor] of Object.entries(anchors)) {
      // Require FULL name match (given + surname), not just surname, to prevent cross-contamination
      if (anchor.givenName && anchor.surname && !anchor.birthDate) {
        const fullName = `${anchor.givenName} ${anchor.surname}`.toLowerCase();
        if (context.toLowerCase().includes(fullName)) {
          anchors[asc].birthDate = dateMatch[1];
        }
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
    this.fsSource = this.sources.find(s => s.sourceName === 'FamilySearch' && s.isAvailable());
    this.freebmdSource = this.sources.find(s => s.sourceName === 'FreeBMD' && s.isAvailable());
    this.freebmdFailCount = 0;

    console.log(`[Engine] Sources: FamilySearch=${!!this.fsSource}, FreeBMD=${!!this.freebmdSource}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  getExpectedGender(ascNumber) {
    if (ascNumber === 1) return null; // Subject can be any gender
    return ascNumber % 2 === 0 ? 'Male' : 'Female';
  }

  getConfidenceLevel(score) {
    const L = RULES.confidence.levelCutoffs;
    if (score >= L.verified) return 'Verified';
    if (score >= L.probable) return 'Probable';
    if (score >= L.possible) return 'Possible';
    if (score >= L.suggested) return 'Suggested';
    return 'Not Found';
  }

  /**
   * Minimum PRIMARY sources required to accept a discovered parent —
   * the single policy ladder, defined by the master rulebook:
   * pre-1837 needs none (no civil records exist); deep generations need fewer
   * (records are sparser); common surnames without a known given name need one
   * more; a distant-county candidate needs the distant minimum on top.
   */
  minPrimarySourcesFor(parentGen, candYear, surname, hasKnownGivenName, isDistant) {
    const s = RULES.sources;
    if (candYear && candYear < s.preCivilRegistrationYear) return 0;
    let min = parentGen >= s.deepFromGen ? s.minPrimaryDeepGen : s.minPrimaryShallowGen;
    if (parentGen < s.veryDeepFromGen && isCommonSurname(surname) && !hasKnownGivenName) {
      min += s.commonSurnameExtraPrimary;
    }
    if (isDistant) {
      min = Math.max(min, parentGen >= s.deepFromGen ? s.distantLocationMinPrimaryDeepGen : s.distantLocationMinPrimary);
    }
    return min;
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

  // ─── Adaptive Birth Year Estimation ─────────────────────────────────
  // Instead of fixed childBirth-28, use known parent-child gaps from the same family
  // to estimate birth years more accurately.
  estimateParentBirthYear(childAsc, childBirthYear, isFather) {
    if (!childBirthYear) return null;

    // Strategy 1: Check if we know the actual birth year of this parent from knownAnchors
    const parentAsc = isFather ? childAsc * 2 : childAsc * 2 + 1;
    const knownParent = this.knownAnchors[parentAsc];
    if (knownParent?.birthDate) {
      const knownYear = normalizeDate(knownParent.birthDate)?.year;
      if (knownYear) return knownYear;
    }

    // Strategy 2: Use known gaps from same-generation ancestors in this family
    // Look at siblings (other children in same generation) who have known parent birth years
    const childGen = Math.floor(Math.log2(childAsc));
    const genStart = Math.pow(2, childGen);
    const genEnd = Math.pow(2, childGen + 1) - 1;
    const gaps = [];

    for (let sibAsc = genStart; sibAsc <= genEnd; sibAsc++) {
      const sibRec = this.db.getAncestorByAscNumber(this.jobId, sibAsc);
      if (!sibRec || !sibRec.birth_date) continue;
      const sibYear = normalizeDate(sibRec.birth_date)?.year;
      if (!sibYear) continue;

      // Check both parents (father = sibAsc*2, mother = sibAsc*2+1)
      for (const pAsc of [sibAsc * 2, sibAsc * 2 + 1]) {
        const pRec = this.db.getAncestorByAscNumber(this.jobId, pAsc);
        if (pRec && pRec.birth_date) {
          const pYear = normalizeDate(pRec.birth_date)?.year;
          if (pYear && sibYear > pYear) {
            gaps.push(sibYear - pYear);
          }
        }
        // Also check knownAnchors
        const pAnchor = this.knownAnchors[pAsc];
        if (pAnchor?.birthDate) {
          const pYear = normalizeDate(pAnchor.birthDate)?.year;
          if (pYear && sibYear > pYear) {
            gaps.push(sibYear - pYear);
          }
        }
      }
    }

    // If we found known gaps, use the average
    if (gaps.length > 0) {
      const avgGap = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      return childBirthYear - avgGap;
    }

    // Strategy 3: Fallback to default (28 for fathers, 26 for mothers)
    return childBirthYear - (isFather ? RULES.estimation.fatherGapYears : RULES.estimation.motherGapYears);
  }

  // ─── Section 3: Family Context Scoring ──────────────────────────────
  // Points based on relationship to already-scored child + surname match
  scoreFamilyContext(asc, scoredAncestors, ancestorRecord) {
    let points = 0;
    const notes = [];

    if (asc <= 1) {
      // Subject has no child in tree
      notes.push('Subject (no parent-child link to score)');
      return { points: 0, notes };
    }

    const childAsc = Math.floor(asc / 2);
    const child = scoredAncestors.get(childAsc);
    const isFather = asc % 2 === 0;
    const relationship = isFather ? 'Father' : 'Mother';

    if (child) {
      const childName = child.name || 'unknown';
      const childLevel = child.level || 'Unknown';
      const childScore = child.score || 0;

      // Points based on child's confidence — cutoffs from the master rulebook
      const L = RULES.confidence.levelCutoffs;
      let childPoints = 0;
      if (childLevel === 'Customer Data') { childPoints = 10; }
      else if (childScore >= L.verified) { childPoints = 8; }
      else if (childScore >= L.probable) { childPoints = 6; }
      else if (childScore >= L.possible) { childPoints = 3; }
      else { childPoints = 1; }

      points += childPoints;
      notes.push(`${relationship} of ${childName} (${childLevel}, +${childPoints})`);

      // Surname match
      const ancestorParts = parseNameParts(ancestorRecord.name || '');
      const childParts = parseNameParts(child.name || '');

      if (isFather && ancestorParts.surname && childParts.surname) {
        if (ancestorParts.surname.toLowerCase() === childParts.surname.toLowerCase()) {
          points += RULES.surname.fatherSurnameMatchBonus;
          notes.push(`Surname: ${ancestorParts.surname} matches child ${childParts.surname} (+${RULES.surname.fatherSurnameMatchBonus})`);
        } else {
          // Father surname MUST match child's — strong penalty
          points += RULES.surname.fatherSurnameMismatchPenalty;
          notes.push(`REJECT: Father surname ${ancestorParts.surname} ≠ child ${childParts.surname} (${RULES.surname.fatherSurnameMismatchPenalty})`);
        }
      } else if (!isFather && ancestorParts.surname) {
        // Mother — maiden name match is worth less (less certain further back)
        // We can check if the child record has a known mother maiden name
        points += RULES.surname.motherMaidenPresentBonus;
        notes.push(`Maiden name: ${ancestorParts.surname} (+${RULES.surname.motherMaidenPresentBonus})`);
      }
    } else {
      notes.push(`${relationship} of asc#${childAsc} (child not yet scored, +0)`);
    }

    // Discovery method bonus — tree parents with verified sources get extra points
    const rawData = ancestorRecord.raw_data || {};
    const discoveryMethod = rawData.discoveryMethod || '';
    if (discoveryMethod === 'tree_parents_verified') {
      points += RULES.discovery.treeParentsVerifiedBonus;
      notes.push(`Discovery: tree_parents_verified (+${RULES.discovery.treeParentsVerifiedBonus})`);
    } else if (discoveryMethod === 'direct_search_verified') {
      points += RULES.discovery.directSearchVerifiedBonus;
      notes.push(`Discovery: direct_search_verified (+${RULES.discovery.directSearchVerifiedBonus})`);
    } else if (discoveryMethod === 'tree_parents_unverified') {
      points += RULES.discovery.treeParentsUnverifiedBonus;
      notes.push(`Discovery: tree_parents_unverified (+${RULES.discovery.treeParentsUnverifiedBonus})`);
    }

    return { points: Math.min(points, RULES.confidence.sectionCaps.family), notes };
  }

  // ─── Section 4: Location & Date Plausibility Scoring ────────────────
  // Compares ancestor's data to their child's data for sanity checks.
  // Uses facts and source citations to find location data when birth_place is empty.
  scoreLocationDate(asc, ancestorRecord, scoredAncestors, facts, sources) {
    let points = 0;
    const notes = [];

    if (asc <= 1) {
      notes.push('Location: subject (no child to compare)');
      return { points: 0, notes };
    }

    const childAsc = Math.floor(asc / 2);
    const child = scoredAncestors.get(childAsc);

    if (!child) {
      notes.push('Location: no child data to compare');
      return { points: 0, notes };
    }

    // Resolve best location for this ancestor — try birth_place first,
    // then fall back to facts (birth place, residence, burial, census)
    // then source citations
    let ancestorLocationStr = ancestorRecord.birth_place || '';

    if (!ancestorLocationStr && facts) {
      // Try birth/christening place from facts
      const birthFact = (facts.birth || []).find(f => f.place) || (facts.baptism || []).find(f => f.place);
      if (birthFact) ancestorLocationStr = birthFact.place;

      // Fall back to residence
      if (!ancestorLocationStr) {
        const resFact = (facts.residence || []).find(f => f.place);
        if (resFact) ancestorLocationStr = resFact.place;
      }

      // Fall back to burial
      if (!ancestorLocationStr) {
        const burialFact = (facts.burial || []).find(f => f.place);
        if (burialFact) ancestorLocationStr = burialFact.place;
      }

      // Fall back to census
      if (!ancestorLocationStr) {
        const censusFact = (facts.census || []).find(f => f.place);
        if (censusFact) ancestorLocationStr = censusFact.place;
      }
    }

    // Last resort: extract location from source citations
    if (!ancestorLocationStr && sources && sources.length > 0) {
      for (const s of sources) {
        const citation = (s.citation || '').toLowerCase();
        const title = (s.title || '').toLowerCase();
        const text = citation + ' ' + title;
        // Look for UK county names in the citation/title
        const allText = text.replace(/<[^>]+>/g, ''); // strip HTML tags from citations
        const foundCounty = [...UK_COUNTIES].find(c => allText.includes(c));
        if (foundCounty) {
          ancestorLocationStr = foundCounty;
          break;
        }
      }
    }

    // Similarly resolve child location
    let childLocationStr = child.birthPlace || '';
    if (!childLocationStr && child.allPlaces) {
      childLocationStr = child.allPlaces; // from extended scoring data
    }

    // Parse places — use both parsePlaceParts and resolveCounty for best coverage
    const ancestorPlace = parsePlaceParts((ancestorLocationStr || '').toLowerCase());
    const childPlace = parsePlaceParts((childLocationStr || '').toLowerCase());
    // Fallback: use resolveCounty (which knows town→county mappings) if parsePlaceParts missed the county
    if (!ancestorPlace.county && ancestorLocationStr) {
      const resolved = resolveCounty(ancestorLocationStr);
      if (resolved) ancestorPlace.county = resolved;
    }
    if (!childPlace.county && childLocationStr) {
      const resolved = resolveCounty(childLocationStr);
      if (resolved) childPlace.county = resolved;
    }

    // County match — now uses full proximity check (same, adjacent, distant).
    // All point values come from the master rulebook (RULES.location).
    const loc = RULES.location;
    if (ancestorPlace.county && childPlace.county) {
      const prox = countyProximity(ancestorPlace.county, childPlace.county);
      if (prox === 'same') {
        points += loc.sameCountyPoints;
        notes.push(`Location: birth county ${ancestorPlace.county} matches child's county (+${loc.sameCountyPoints})`);

        // Town match (bonus on top of county)
        if (ancestorPlace.town && childPlace.town && ancestorPlace.town === childPlace.town) {
          points += loc.sameTownBonus;
          notes.push(`Location: birth town ${ancestorPlace.town} matches child's town (+${loc.sameTownBonus})`);
        }
      } else if (prox === 'adjacent') {
        points += loc.adjacentCountyPoints;
        notes.push(`Location: adjacent county ${ancestorPlace.county} ↔ ${childPlace.county} (+${loc.adjacentCountyPoints})`);
      } else {
        // Distant county — significant penalty
        points += loc.distantCountyPenalty;
        notes.push(`Location: DISTANT county ${ancestorPlace.county} vs ${childPlace.county} — unlikely relative (${loc.distantCountyPenalty})`);
      }
    } else if (!ancestorPlace.county && !childPlace.county) {
      notes.push('Location: no birth counties to compare');
    } else {
      notes.push(`Location: ${ancestorPlace.county || 'unknown county'} vs child ${childPlace.county || 'unknown county'}`);
    }

    // Birth year plausibility
    const ancestorYear = normalizeDate(ancestorRecord.birth_date || '')?.year;
    const childYear = normalizeDate(child.birthDate || '')?.year;

    if (ancestorYear && childYear) {
      // Sex-specific age-gap bounds from the master rulebook (even asc = father,
      // odd asc = mother). Female fertility ends ~50, so the bounds differ.
      const ag = RULES.ageGap;
      const isMother = asc % 2 === 1;
      const b = isMother ? ag.mother : ag.father;
      const who = isMother ? 'mother' : 'father';
      const gap = childYear - ancestorYear;
      if (gap < 0) {
        // Parent born AFTER child — impossible
        points += ag.parentAfterChildPenalty;
        notes.push(`REJECT: ${who} born ${Math.abs(gap)}yrs AFTER child — impossible (${ag.parentAfterChildPenalty})`);
      } else if (gap < b.hardMin || gap > b.hardMax) {
        // Outside the plausible range for this sex
        points += ag.implausibleGapPenalty;
        notes.push(`REJECT: ${gap}yr ${who} gap — outside ${b.hardMin}-${b.hardMax} (${ag.implausibleGapPenalty})`);
      } else if (gap >= b.plausibleMin && gap <= b.plausibleMax) {
        points += ag.plausiblePoints;
        notes.push(`Age: ${who} ~${gap}yrs before child — plausible (+${ag.plausiblePoints})`);
        if (gap >= b.sweetMin && gap <= b.sweetMax) {
          points += ag.sweetSpotPoints;
          notes.push(`Age: sweet spot (+${ag.sweetSpotPoints})`);
        }
      } else {
        // unusual but not impossible
        notes.push(`Age: ${who} ~${gap}yrs before child — unusual but possible`);
      }
    } else {
      notes.push('Age: no birth years to compare');
    }

    // Generational county match — does this ancestor's county match any other in same generation?
    if (ancestorPlace.county) {
      const myGen = Math.floor(Math.log2(asc));
      const genStart = Math.pow(2, myGen);
      const genEnd = Math.pow(2, myGen + 1) - 1;
      for (let otherAsc = genStart; otherAsc <= genEnd; otherAsc++) {
        if (otherAsc === asc) continue;
        const other = scoredAncestors.get(otherAsc);
        const otherPlaceStr = (other && (other.allPlaces || other.birthPlace)) || '';
        if (other && otherPlaceStr) {
          const otherPlace = parsePlaceParts(otherPlaceStr.toLowerCase());
          if (otherPlace.county === ancestorPlace.county) {
            points += loc.sameGenerationCountyBonus;
            notes.push(`Location: county matches ${other.name} in same generation (+${loc.sameGenerationCountyBonus})`);
            break; // Only award once
          }
        }
      }
    }

    return { points: Math.min(points, RULES.confidence.sectionCaps.location), notes };
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

  // ─── Tree-Based Parent Discovery Helpers ────────────────────────────

  /**
   * Find a child ancestor in the FS tree, returning their FS person ID.
   * Uses existing fs_person_id if already linked (Phase 1), otherwise
   * does a strict tree search with UK filtering.
   */
  /**
   * Find a child ancestor in the FS tree via search.
   * Returns { fsId, parentData } where parentData contains parent names from search results.
   * parentData is used as fallback when getParents() fails (unauthenticated token).
   */
  async findChildInTree(childRec) {
    // Already linked from Phase 1?
    if (childRec.fs_person_id) {
      // Still try a search to get parent data from GEDCOM X response
      // (useful as fallback when getParents() fails due to auth)
      let parentData = null;
      if (this.fsSource) {
        try {
          const np = parseNameParts(childRec.name || '');
          if (np.givenName && np.surname) {
            let birthYear = normalizeDate(childRec.birth_date)?.year;
            // If no birth year, estimate from the child's own child (grandchild)
            // e.g. Frederick Hunt (#8) has no birth date, but his child Norman (#4) was born 1931
            if (!birthYear && childRec.ascendancy_number >= 2) {
              const grandchildAsc = Math.floor(childRec.ascendancy_number / 2);
              const grandchildRec = this.db.getAncestorByAscNumber(this.jobId, grandchildAsc);
              if (grandchildRec) {
                const gcYear = normalizeDate(grandchildRec.birth_date)?.year;
                if (gcYear) {
                  birthYear = gcYear - RULES.estimation.grandchildFallbackGapYears;
                  console.log(`[Engine] findChildInTree: estimated birth ~${birthYear} for ${childRec.name} from grandchild asc#${grandchildAsc} (b.${gcYear})`);
                }
              }
            }
            const query = { givenName: np.givenName, surname: np.surname, count: 5 };
            if (birthYear) query.birthDate = String(birthYear);
            if (childRec.birth_place) query.birthPlace = childRec.birth_place;
            const results = await this.fsSource.searchPerson(query);
            // Find the matching result by FS person ID
            const match = results.find(r => r.id === childRec.fs_person_id);
            if (match && match.parentData && (match.parentData.father || match.parentData.mother)) {
              parentData = match.parentData;
              console.log(`[Engine] findChildInTree: Got parent data from search for linked ${childRec.name} (${childRec.fs_person_id}): father=${match.parentData.father?.name || 'none'}, mother=${match.parentData.mother?.name || 'none'}`);
            }
          }
        } catch (err) {
          // Search failed — that's OK, we still have the fsId
          console.log(`[Engine] findChildInTree: search for parent data failed for ${childRec.name}: ${err.message}`);
        }
      }
      return { fsId: childRec.fs_person_id, parentData };
    }

    // Otherwise search the tree
    if (!this.fsSource) return { fsId: null, parentData: null };

    const np = parseNameParts(childRec.name || '');
    if (!np.givenName || !np.surname) return { fsId: null, parentData: null };

    let birthYear = normalizeDate(childRec.birth_date)?.year;
    // Estimate birth year from grandchild if missing
    if (!birthYear && childRec.ascendancy_number >= 2) {
      const grandchildAsc = Math.floor(childRec.ascendancy_number / 2);
      const grandchildRec = this.db.getAncestorByAscNumber(this.jobId, grandchildAsc);
      if (grandchildRec) {
        const gcYear = normalizeDate(grandchildRec.birth_date)?.year;
        if (gcYear) birthYear = gcYear - RULES.estimation.grandchildFallbackGapYears;
      }
    }
    const birthPlace = childRec.birth_place || '';

    const query = {
      givenName: np.givenName,
      surname: np.surname,
      count: 5,
    };
    if (birthYear) query.birthDate = String(birthYear);
    if (birthPlace) query.birthPlace = birthPlace;

    try {
      const candidates = await this.fsSource.searchPerson(query);
      for (const cand of candidates) {
        // Strict UK filter
        const candPlace = sanitizePlaceName(cand.birthPlace || cand.deathPlace || '');
        if (candPlace && isNonUkPlace(candPlace) && !isUkPlace(candPlace)) continue;
        if (this.rejectedFsIds.has(cand.id)) continue;

        // Name must match
        const candParts = parseNameParts(cand.name || '');
        if (!this.namesSimilar(np.givenName, candParts.givenName)) continue;
        if (np.surname && candParts.surname) {
          const s1 = np.surname.toLowerCase();
          const s2 = candParts.surname.toLowerCase();
          if (s1 !== s2 && !s1.includes(s2) && !s2.includes(s1)) continue;
        }

        // Birth year within ±5
        const candYear = normalizeDate(cand.birthDate)?.year;
        if (birthYear && candYear && Math.abs(birthYear - candYear) > 5) continue;

        // Reject undated candidates for post-1837 people
        if (birthYear && birthYear >= 1837 && !candYear) continue;

        // Geographic proximity — reject distant candidates when we know the child's location
        if (birthPlace && candPlace) {
          const prox = placeProximity(candPlace, birthPlace);
          if (prox.proximity === 'distant') {
            console.log(`[Engine] findChildInTree: ${cand.name} (${cand.id}) — distant (${prox.county1} vs ${prox.county2}), skipping`);
            continue;
          }
        }

        return { fsId: cand.id, parentData: cand.parentData || null };
      }
    } catch (err) {
      console.log(`[Engine] findChildInTree error for ${childRec.name}: ${err.message}`);
    }
    return { fsId: null, parentData: null };
  }

  /**
   * Verify a parent from the FS tree by checking their attached sources.
   * Returns { sources, primaryCount, totalPoints, classifications }.
   * primaryCount > 0 means "source-verified".
   */
  async verifyParentSources(parentFsId) {
    if (!this.fsSource) return { sources: [], primaryCount: 0, totalPoints: 0, classifications: [], authFailed: false };

    try {
      const sources = await this.fsSource.getPersonSources(parentFsId);
      const classifications = [];
      let primaryCount = 0;
      let totalPoints = 0;

      // Primary source categories (strong evidence) — from the master rulebook.
      const PRIMARY_CATS = new Set(RULES.sources.primaryCategories);

      for (const src of sources) {
        const cls = classifySourceRecord(src.title);
        classifications.push({ title: src.title, ...cls });
        if (PRIMARY_CATS.has(cls.category)) {
          primaryCount++;
        }
        // Points per category — from the master rulebook.
        totalPoints += (RULES.sources.categoryPoints[cls.category]?.points)
          ?? RULES.sources.categoryPoints['Other'].points;
      }

      return { sources, primaryCount, totalPoints, classifications, authFailed: false };
    } catch (err) {
      const isAuthError = err.message.includes('authenticated token') || err.message.includes('401');
      if (isAuthError) {
        console.log(`[Engine] verifyParentSources: auth required for ${parentFsId} — sources unavailable`);
      } else {
        console.log(`[Engine] verifyParentSources error for ${parentFsId}: ${err.message}`);
      }
      return { sources: [], primaryCount: 0, totalPoints: 0, classifications: [], authFailed: isAuthError };
    }
  }

  /**
   * Validate a parent candidate from the FS tree against the child record.
   * Returns { valid, reasons } — reasons list why it failed or passed.
   */
  validateTreeParent(parent, childRec, expectedGender) {
    const reasons = [];
    let valid = true;

    // Gender check
    const pg = (parent.gender || '').toLowerCase();
    const eg = expectedGender.toLowerCase();
    if (pg && eg && pg !== eg) {
      reasons.push(`Gender mismatch: ${pg} ≠ ${eg}`);
      valid = false;
    } else {
      reasons.push(`Gender: ${pg || 'unknown'} (expected ${eg})`);
    }

    // Birth year gap: parent should be 12-55 years older than child
    const childYear = normalizeDate(childRec.birth_date)?.year;
    const parentYear = normalizeDate(parent.birthDate)?.year;
    if (childYear && parentYear) {
      // Sex-specific bounds from the master rulebook (eg = expected parent gender).
      const b = (eg === 'Female') ? RULES.ageGap.mother : RULES.ageGap.father;
      const gap = childYear - parentYear;
      if (gap < b.hardMin || gap > b.hardMax) {
        reasons.push(`Birth gap ${gap} years (expected ${b.hardMin}-${b.hardMax} for ${eg === 'Female' ? 'mother' : 'father'})`);
        valid = false;
      } else {
        reasons.push(`Birth gap: ${gap} years`);
      }
    }

    // Parent must not have died before child was born
    const parentDeathYear = normalizeDate(parent.deathDate)?.year;
    if (parentDeathYear && childYear && parentDeathYear < childYear - 1) {
      reasons.push(`Parent died ${parentDeathYear}, before child born ${childYear}`);
      valid = false;
    }

    // UK location check. A non-UK birthplace on a TREE-LINKED parent is not an
    // automatic rejection — immigrant ancestors are real (rulebook: a non-UK
    // tree parent needs immigrantTreeParentMinPrimary documentary sources).
    // We flag it here and let the caller apply the source gate.
    let nonUk = false;
    const parentPlace = sanitizePlaceName(parent.birthPlace || parent.deathPlace || '');
    if (parentPlace && isNonUkPlace(parentPlace) && !isUkPlace(parentPlace)) {
      nonUk = true;
      reasons.push(`Non-UK location: ${parentPlace} — immigrant ancestor, needs documentary sources`);
    } else if (parentPlace) {
      reasons.push(`Location: ${parentPlace}`);
    }

    // ── GEOGRAPHIC PROXIMITY CHECK ──
    // Parents should be in the same or adjacent county as the child.
    // This is the user's "playbook": if a child is born in Derby, parents were
    // likely married in Derby and born in the same region.
    // People DID move, but it was rare — distant parents need much stronger evidence.
    const childPlace = sanitizePlaceName(childRec.birth_place || childRec.death_place || '');
    let locationProximity = null;
    if (parentPlace && childPlace) {
      const prox = placeProximity(parentPlace, childPlace);
      locationProximity = prox.proximity;
      if (prox.proximity === 'same') {
        reasons.push(`Geographic: same county (${prox.county1}) ✓`);
      } else if (prox.proximity === 'adjacent') {
        reasons.push(`Geographic: adjacent counties (${prox.county1} ↔ ${prox.county2}) ✓`);
      } else if (prox.proximity === 'distant') {
        reasons.push(`Geographic: DISTANT (${prox.county1 || 'unknown'} vs ${prox.county2 || 'unknown'}) — needs strong evidence`);
        // Don't hard-reject here — people did move. But flag it so callers can
        // require extra evidence (more sources) for distant parents.
      } else {
        // Could not resolve counties — allow but note
        reasons.push(`Geographic: could not resolve counties (${parentPlace} / ${childPlace})`);
      }
    }

    return { valid, reasons, locationProximity, nonUk };
  }

  // ─── Build Known Anchors From Input ───────────────────────────────

  buildAnchors() {
    // Father (asc#2)
    if (this.inputData.father_name) {
      const fp = parseNameParts(this.inputData.father_name);
      this.knownAnchors[2] = { givenName: fp.givenName, surname: fp.surname };
    }
    // Also check structured father input
    if (this.inputData.father?.name) {
      const fp = parseNameParts(this.inputData.father.name);
      if (!this.knownAnchors[2]) {
        this.knownAnchors[2] = { givenName: fp.givenName, surname: fp.surname };
      }
    }

    // Mother (asc#3)
    if (this.inputData.mother_name) {
      const mp = parseNameParts(this.inputData.mother_name);
      this.knownAnchors[3] = { givenName: mp.givenName, surname: mp.surname };
    }
    if (this.inputData.mother?.name) {
      const mp = parseNameParts(this.inputData.mother.name);
      if (!this.knownAnchors[3]) {
        this.knownAnchors[3] = { givenName: mp.givenName, surname: mp.surname };
      }
    }

    // Grandparents (#4-7) from structured input
    const gpMappings = {
      paternal_grandfather: 4, paternal_grandmother: 5,
      maternal_grandfather: 6, maternal_grandmother: 7,
    };
    for (const [key, asc] of Object.entries(gpMappings)) {
      if (this.inputData[key]?.name && !this.knownAnchors[asc]) {
        const np = parseNameParts(this.inputData[key].name);
        this.knownAnchors[asc] = {
          givenName: np.givenName, surname: np.surname,
          birthDate: this.inputData[key].birth_date || '',
          deathDate: this.inputData[key].death_date || '',
          birthPlace: this.inputData[key].birth_place || '',
        };
      }
    }

    // Great-grandparents (#8-15) from structured input
    // Format: inputData.great_grandparents = { "8": { name, birth_date, ... }, "9": { ... }, ... }
    if (this.inputData.great_grandparents) {
      for (const [asc, info] of Object.entries(this.inputData.great_grandparents)) {
        const ascNum = parseInt(asc, 10);
        if (isNaN(ascNum) || ascNum < 8 || ascNum > 15) continue;
        if (info.name && !this.knownAnchors[ascNum]) {
          const np = parseNameParts(info.name);
          this.knownAnchors[ascNum] = {
            givenName: np.givenName, surname: np.surname,
            birthDate: info.birth_date || '',
            deathDate: info.death_date || '',
            birthPlace: info.birth_place || '',
          };
        }
      }
    }

    // Parse notes for grandparent and great-grandparent info
    if (this.inputData.notes) {
      const noteAnchors = parseNotesForAnchors(this.inputData.notes);
      for (const [asc, info] of Object.entries(noteAnchors)) {
        this.knownAnchors[parseInt(asc, 10)] = {
          ...(this.knownAnchors[parseInt(asc, 10)] || {}),
          ...info,
        };
      }
    }

    // Backfill knownAnchors from existing DB records (for re-runs or pre-populated data)
    // This ensures that Customer Data records for asc#4-15+ are available as search anchors
    const maxAsc = Math.pow(2, this.generations + 1) - 1;
    for (let asc = 4; asc <= maxAsc; asc++) {
      if (this.knownAnchors[asc]) continue; // already have it from notes/input
      const rec = this.db.getAncestorByAscNumber(this.jobId, asc);
      if (rec && rec.name && rec.confidence_level === 'Customer Data') {
        const np = parseNameParts(rec.name);
        if (np.givenName) {
          this.knownAnchors[asc] = {
            givenName: np.givenName,
            surname: np.surname || '',
            birthDate: rec.birth_date || '',
            deathDate: rec.death_date || '',
            birthPlace: rec.birth_place || '',
            deathPlace: rec.death_place || '',
          };
        }
      }
    }

    console.log(`[Engine] Known anchors: ${Object.keys(this.knownAnchors).sort((a, b) => a - b).map(a => `asc#${a}`).join(', ')}`);
  }

  // ─── Ensure customer data ancestors exist in DB ─────────────────
  // Safety net: if ancestors weren't pre-populated by the route handler,
  // create them from inputData so the engine can function correctly.
  ensureCustomerDataStored() {
    const d = this.inputData;
    const ensure = (asc, gen, name, gender, birthDate, birthPlace, deathDate, deathPlace) => {
      if (!name) return;
      const existing = this.db.getAncestorByAscNumber(this.jobId, asc);
      if (existing) return;
      console.log(`[Engine] Storing missing customer data: asc#${asc} ${name}`);
      this.db.addAncestor({
        research_job_id: this.jobId, fs_person_id: '', name, gender,
        birth_date: birthDate || '', birth_place: birthPlace || '',
        death_date: deathDate || '', death_place: deathPlace || '',
        ascendancy_number: asc, generation: gen, confidence: 'customer_data',
        sources: [], raw_data: {}, confidence_score: 100, confidence_level: 'Customer Data',
        evidence_chain: [], search_log: [], conflicts: [],
        verification_notes: 'Customer-provided data', accepted: 1,
      });
    };

    // Subject (#1) — supports both flat and structured input
    const subjectName = d.subject?.name || `${d.given_name || ''} ${d.surname || ''}`.trim();
    const subjectBirthDate = d.subject?.birth_date || d.birth_date || '';
    const subjectBirthPlace = d.subject?.birth_place || d.birth_place || '';
    const subjectDeathDate = d.subject?.death_date || d.death_date || '';
    const subjectDeathPlace = d.subject?.death_place || d.death_place || '';
    const subjectGender = d.subject?.gender || 'Unknown';
    ensure(1, 0, subjectName, subjectGender,
      subjectBirthDate, subjectBirthPlace, subjectDeathDate, subjectDeathPlace);

    // Father (#2) — supports both flat and structured input
    const fatherName = d.father?.name || d.father_name || '';
    if (fatherName) {
      ensure(2, 1, fatherName, 'Male',
        d.father?.birth_date || '', d.father?.birth_place || subjectBirthPlace,
        d.father?.death_date || '', d.father?.death_place || '');
    }

    // Mother (#3)
    const motherName = d.mother?.name || d.mother_name || '';
    if (motherName) {
      ensure(3, 1, motherName, 'Female',
        d.mother?.birth_date || '', d.mother?.birth_place || subjectBirthPlace,
        d.mother?.death_date || '', d.mother?.death_place || '');
    }

    // Grandparents (#4-7) from structured input
    const gpKeys = {
      paternal_grandfather: [4, 'Male'], paternal_grandmother: [5, 'Female'],
      maternal_grandfather: [6, 'Male'], maternal_grandmother: [7, 'Female'],
    };
    for (const [key, [asc, gender]] of Object.entries(gpKeys)) {
      if (d[key]?.name) {
        ensure(asc, 2, d[key].name, gender,
          d[key].birth_date || '', d[key].birth_place || subjectBirthPlace,
          d[key].death_date || '', d[key].death_place || '');
      }
    }

    // Great-grandparents (#8-15) from structured input
    if (d.great_grandparents) {
      for (const [asc, info] of Object.entries(d.great_grandparents)) {
        const ascNum = parseInt(asc, 10);
        if (isNaN(ascNum) || ascNum < 8 || ascNum > 15) continue;
        if (info.name) {
          const gender = ascNum % 2 === 0 ? 'Male' : 'Female';
          const parentAsc = Math.floor(ascNum / 2);
          const parentAnchor = this.knownAnchors[parentAsc];
          const fallbackPlace = parentAnchor?.birthPlace || subjectBirthPlace;
          ensure(ascNum, 3, info.name, gender,
            info.birth_date || '', info.birth_place || fallbackPlace,
            info.death_date || '', info.death_place || '');
        }
      }
    }

    // Grandparents (#4-7) from knownAnchors (parsed from notes)
    for (const ascNum of [4, 5, 6, 7]) {
      const anchor = this.knownAnchors[ascNum];
      if (anchor && anchor.givenName) {
        const fullName = `${anchor.givenName} ${anchor.surname || ''}`.trim();
        const gender = ascNum % 2 === 0 ? 'Male' : 'Female';
        ensure(ascNum, 2, fullName, gender,
          anchor.birthDate || '', anchor.birthPlace || d.birth_place || '',
          anchor.deathDate || '', anchor.deathPlace || '');
      }
    }

    // Great-grandparents (#8-15) from knownAnchors (parsed from notes)
    for (const ascNum of [8, 9, 10, 11, 12, 13, 14, 15]) {
      const anchor = this.knownAnchors[ascNum];
      if (anchor && anchor.givenName) {
        const fullName = `${anchor.givenName} ${anchor.surname || ''}`.trim();
        const gender = ascNum % 2 === 0 ? 'Male' : 'Female';
        // Great-grandparents are generation 3
        // Inherit birthPlace from their child grandparent if available
        const parentAsc = Math.floor(ascNum / 2); // grandparent asc number
        const parentAnchor = this.knownAnchors[parentAsc];
        const fallbackPlace = parentAnchor?.birthPlace || d.birth_place || '';
        ensure(ascNum, 3, fullName, gender,
          anchor.birthDate || '', anchor.birthPlace || fallbackPlace,
          anchor.deathDate || '', anchor.deathPlace || '');
      }
    }
  }

  // ─── Confirm an ancestor with FreeBMD civil records ────────────────
  // Given a person from FS tree traversal, try to confirm with FreeBMD.
  // Returns evidence chain entries and a confidence boost.

  async confirmWithFreeBMD(name, birthYear, birthPlace, deathYear, ascNumber) {
    const evidenceChain = [];
    const notes = [];
    if (!this.freebmdSource) return { evidenceChain, notes, bonusScore: 0 };

    // Skip FreeBMD if too many consecutive failures (rate limiting)
    if (this.freebmdFailCount >= 3) {
      console.log(`[FreeBMD] asc#${ascNumber}: Skipping — too many recent failures (${this.freebmdFailCount})`);
      return { evidenceChain, notes, bonusScore: 0 };
    }

    const nameParts = parseNameParts(name);
    if (!nameParts.surname) return { evidenceChain, notes, bonusScore: 0 };

    let bonusScore = 0;
    const district = this.extractDistrict(birthPlace);

    // Confirm birth
    if (birthYear && birthYear >= 1837 && birthYear <= 1983) {
      try {
        const results = await this.freebmdSource.searchBirths(
          nameParts.surname, nameParts.givenName || '', birthYear - 2, birthYear + 2, district
        );
        // Find best match
        let bestBirth = null;
        let bestScore = 0;
        for (const entry of results) {
          let score = 0;
          if (this.namesSimilar(entry.forenames, nameParts.givenName)) score += 30;
          if (entry.year === birthYear) score += 20;
          else if (Math.abs(entry.year - birthYear) <= 1) score += 15;
          if (district && entry.district) {
            if (entry.district.toLowerCase() === district.toLowerCase()) score += 15;
            else if (districtMatches(district, entry.district)) score += 10;
          }
          if (score > bestScore) { bestScore = score; bestBirth = entry; }
        }
        if (bestBirth && bestScore >= 40) {
          evidenceChain.push({
            record_type: 'birth', source: 'FreeBMD', is_independent: true,
            year: bestBirth.year, quarter: bestBirth.quarter, district: bestBirth.district,
            volume: bestBirth.volume, page: bestBirth.page,
            details: `Birth: ${bestBirth.forenames} ${bestBirth.surname}, Q${bestBirth.quarter} ${bestBirth.year}, ${bestBirth.district}`,
            parent_mother_maiden: bestBirth.spouseSurname || '',
            supports: ['identity'], weight: 25,
          });
          bonusScore += 15;
          notes.push(`Birth confirmed: vol.${bestBirth.volume} p.${bestBirth.page}`);
          console.log(`[FreeBMD] asc#${ascNumber}: Birth confirmed — ${bestBirth.forenames} ${bestBirth.surname} Q${bestBirth.quarter} ${bestBirth.year} ${bestBirth.district}`);
          this.freebmdFailCount = 0; // reset on success
        }
      } catch (err) {
        console.log(`[FreeBMD] asc#${ascNumber}: Birth search error: ${err.message}`);
        this.freebmdFailCount = (this.freebmdFailCount || 0) + 1;
      }
    }

    // Confirm death
    if (deathYear && deathYear >= 1837 && deathYear <= 1983) {
      try {
        const deathResult = await this.freebmdSource.confirmDeath(
          nameParts.givenName?.split(' ')[0] || '', nameParts.surname, deathYear
        );
        if (deathResult) {
          evidenceChain.push({
            record_type: 'death', source: 'FreeBMD', is_independent: true,
            year: deathResult.year, quarter: deathResult.quarter, district: deathResult.district,
            volume: deathResult.volume, page: deathResult.page,
            details: `Death: ${nameParts.givenName || ''} ${nameParts.surname}, Q${deathResult.quarter} ${deathResult.year}, ${deathResult.district}`,
            supports: ['identity'], weight: 10,
          });
          bonusScore += 10;
          notes.push(`Death confirmed: Q${deathResult.quarter} ${deathResult.year}`);
          console.log(`[FreeBMD] asc#${ascNumber}: Death confirmed — ${deathResult.year}`);
          this.freebmdFailCount = 0;
        }
      } catch (err) {
        console.log(`[FreeBMD] asc#${ascNumber}: Death search error: ${err.message}`);
        this.freebmdFailCount = (this.freebmdFailCount || 0) + 1;
      }
    }

    return { evidenceChain, notes, bonusScore };
  }

  // ─── Main Run Method ──────────────────────────────────────────────
  //
  // Strategy: Records-based discovery (no FS tree traversal).
  // 1. Link customer ancestors to FS persons (grandparents first)
  // 2. Search for unknown ancestors independently using records
  // 3. Score all ancestors bottom-up using record-based evidence
  //

  async run() {
    try {
      this.db.updateResearchJob(this.jobId, { status: 'running' });
      this.db.deleteSearchCandidates(this.jobId, true); // preserve rejection history
      this.buildAnchors();

      // Safety net: ensure customer data ancestors exist in DB
      // (normally created by the route handler, but may be missing if job was created directly)
      this.ensureCustomerDataStored();

      const totalPossible = Math.pow(2, this.generations + 1) - 1;
      this.db.updateJobProgress(this.jobId, 'Starting research...', 0, totalPossible);

      console.log(`\n[Engine] ════════════════════════════════════════════════`);
      console.log(`[Engine] FS-Primary Engine — ${this.generations} generations`);
      console.log(`[Engine] Subject: ${this.inputData.given_name} ${this.inputData.surname}`);
      console.log(`[Engine] FamilySearch: ${!!this.fsSource}`);
      console.log(`[Engine] Rulebook: master genealogy rules v${RULES_VERSION} (ref ${RULES_HASH}) — human-owned, enforced this run`);
      console.log(`[Engine] ════════════════════════════════════════════════\n`);

      // ── Phase 1: Link customer-provided ancestors to FS ──
      // Search FS for each customer ancestor (asc#1-7), starting with grandparents.
      // Grandparents (asc#4-7) are usually dead with full dates, so they're the best entry points.

      const maxAsc = Math.pow(2, this.generations + 1) - 1;

      this.db.updateJobProgress(this.jobId, 'Linking ancestors to FamilySearch...', 0, totalPossible);

      // Helper: search FS for a customer ancestor and return the best match FS person ID
      const findFsPersonForAncestor = async (asc) => {
        const rec = this.db.getAncestorByAscNumber(this.jobId, asc);
        if (!rec || !rec.name || rec.fs_person_id) return rec?.fs_person_id || null;

        const np = parseNameParts(rec.name);
        if (!np.givenName && !np.surname) return null;

        const query = { givenName: np.givenName || '', surname: np.surname || '', count: 10 };
        if (rec.birth_date) query.birthDate = formatDateForApi(rec.birth_date);
        if (rec.birth_place) query.birthPlace = rec.birth_place;

        // ── ESTIMATE BIRTH YEAR FROM CHILD ──
        // When customer data has no birth date, estimate from the child's birth year.
        // This dramatically improves search accuracy (e.g. "Frederick Hunt Derby" returns
        // the wrong person, but "Frederick Hunt Derby ~1902" returns the correct one).
        let estimatedBirthYear = null;
        if (!query.birthDate && asc >= 2) {
          const childAsc = Math.floor(asc / 2);
          const childRec = this.db.getAncestorByAscNumber(this.jobId, childAsc);
          if (childRec) {
            const childYear = normalizeDate(childRec.birth_date)?.year;
            if (childYear) {
              // Sex-specific estimate from the rulebook (even asc = father, odd = mother)
              estimatedBirthYear = childYear - (asc % 2 === 0
                ? RULES.estimation.fatherGapYears : RULES.estimation.motherGapYears);
              query.birthDate = String(estimatedBirthYear);
              console.log(`[Engine] asc#${asc}: no birth date, estimated ~${estimatedBirthYear} from child asc#${childAsc} (b.${childYear})`);
            }
          }
        }

        const recBirthYear = normalizeDate(rec.birth_date)?.year;

        // Determine reference place for geographic checks (ancestor's own or child's)
        let refPlace = rec.birth_place || '';
        if (!refPlace && asc >= 2) {
          const childAsc = Math.floor(asc / 2);
          const childRec = this.db.getAncestorByAscNumber(this.jobId, childAsc);
          if (childRec) refPlace = childRec.birth_place || '';
        }

        try {
          let results = await this.fsSource.searchPerson(query);
          console.log(`[Engine] FS search for asc#${asc} (${rec.name}): ${results.length} candidates`);

          // ── RETRY WITHOUT LOCATION if 0 results (location may be too specific) ──
          if (results.length === 0 && query.birthPlace) {
            const retryQuery = { ...query };
            delete retryQuery.birthPlace;
            results = await this.fsSource.searchPerson(retryQuery);
            console.log(`[Engine] asc#${asc}: Retry without birthPlace → ${results.length} candidates`);
          }

          // ── SCORE ALL CANDIDATES instead of accepting first match ──
          const passingCandidates = [];

          for (const cand of results) {
            const place = sanitizePlaceName(cand.birthPlace || '');
            console.log(`[Engine]   candidate: ${cand.name} (${cand.id}), b.${cand.birthDate} ${place}`);
            if (isNonUkPlace(place) && !isUkPlace(place) && place) { console.log(`[Engine]     → non-UK`); continue; }
            if (this.rejectedFsIds.has(cand.id)) continue;

            const candFirst = (cand.name || '').split(' ')[0];
            if (!this.namesSimilar(candFirst, np.givenName)) continue;

            // Surname must match (exact or very close) — prevents matching wrong family
            const candParts = parseNameParts(cand.name || '');
            if (np.surname && candParts.surname) {
              const recSur = np.surname.toLowerCase();
              const candSur = candParts.surname.toLowerCase();
              if (recSur !== candSur && !recSur.includes(candSur) && !candSur.includes(recSur)) {
                console.log(`[Engine]     → surname mismatch: ${candParts.surname} ≠ ${np.surname}`);
                continue;
              }
            }

            const candYear = normalizeDate(cand.birthDate)?.year;
            // Wider tolerance for gen 3+ (great-grandparents and beyond): ±8 years
            const yearTolerance = rec.generation >= RULES.birthYearTolerance.olderGenerationFromGen
              ? RULES.birthYearTolerance.olderGenerationYears : RULES.birthYearTolerance.defaultYears;
            if (recBirthYear && candYear && Math.abs(recBirthYear - candYear) > yearTolerance) continue;

            // If WE know the birth year but the candidate has none, reject for
            // post-1837 people with COMMON surnames. Uncommon surnames are safe with location match.
            if (recBirthYear && recBirthYear >= 1837 && !candYear) {
              if (isCommonSurname(np.surname)) {
                console.log(`[Engine]     → rejected: known b.${recBirthYear} but candidate has no birth date (common surname)`);
                continue;
              }
              // For uncommon surnames, allow if candidate has a matching place
              const candPlaceCheck = sanitizePlaceName(cand.birthPlace || '');
              if (!candPlaceCheck || !refPlace) {
                console.log(`[Engine]     → rejected: known b.${recBirthYear} but candidate has no birth date or place`);
                continue;
              }
              console.log(`[Engine]     → allowing dateless candidate for uncommon surname '${np.surname}' with place match`);
            }

            // If candidate has a birth year in a completely different century, reject
            if (recBirthYear && candYear && Math.abs(recBirthYear - candYear) > 50) {
              console.log(`[Engine]     → rejected: birth ${candYear} too far from ${recBirthYear}`);
              continue;
            }

            // ── GENERATIONAL ERA CHECK ──
            // When customer provides no birth date, use estimated year or subject-generation estimate.
            const effectiveExpectedYear = estimatedBirthYear || (rec.generation >= 1 ? (() => {
              const subjectRec = this.db.getAncestorByAscNumber(this.jobId, 1);
              const sy = subjectRec ? normalizeDate(subjectRec.birth_date)?.year : null;
              return sy ? sy - (rec.generation * 28) : null;
            })() : null);

            if (!recBirthYear && candYear && effectiveExpectedYear) {
              if (Math.abs(candYear - effectiveExpectedYear) > 35) {
                console.log(`[Engine]     → rejected: candidate b.${candYear}, expected ~${effectiveExpectedYear} for gen ${rec.generation} (±35yr)`);
                continue;
              }
            }

            // ── REJECT DATELESS STUBS for estimated-era searches ──
            // When WE don't have a birth year AND the candidate also has none,
            // the candidate is likely a stub record. For common surnames, this is very risky.
            if (!recBirthYear && !candYear && estimatedBirthYear) {
              if (isCommonSurname(np.surname)) {
                console.log(`[Engine]     → rejected: no birth date on either side + common surname '${np.surname}' = too risky`);
                continue;
              }
              // For uncommon surnames, allow but note the risk
              if (!place) {
                console.log(`[Engine]     → rejected: stub record (no birth date, no birth place) for estimated-era search`);
                continue;
              }
            }

            // ── GEOGRAPHIC PROXIMITY CHECK ──
            if (refPlace && place) {
              const prox = placeProximity(place, refPlace);
              if (prox.proximity === 'distant') {
                console.log(`[Engine]     → rejected: distant location (${prox.county1 || place} vs ref ${prox.county2 || refPlace})`);
                continue;
              }
              if (prox.proximity === null && prox.county2 && !prox.county1) {
                console.log(`[Engine]     → rejected: candidate county unresolvable (${place}) but customer is ${prox.county2}`);
                continue;
              }
              if (prox.proximity) {
                console.log(`[Engine]     → location: ${prox.proximity} (${prox.county1} / ${prox.county2})`);
              }
            }

            // ── COMMON SURNAME SOURCE CHECK ──
            let sourceScore = 0;
            if (isCommonSurname(np.surname)) {
              try {
                const srcVerify = await this.verifyParentSources(cand.id);
                if (srcVerify.authFailed) {
                  console.log(`[Engine]     → common surname source check skipped (auth unavailable), proceeding with name/location match`);
                } else if (srcVerify.primaryCount < 2) {
                  console.log(`[Engine]     → rejected: common surname '${np.surname}' with only ${srcVerify.primaryCount} primary sources (need 2+)`);
                  continue;
                } else {
                  sourceScore = srcVerify.primaryCount;
                  console.log(`[Engine]     → common surname check passed: ${srcVerify.primaryCount} primary sources`);
                }
              } catch (e) {
                console.log(`[Engine]     → source check error: ${e.message}, skipping link`);
                continue;
              }
            }

            // ── SCORE THIS CANDIDATE ── (all weights from the master rulebook)
            const cs = RULES.candidateScoring;
            let score = cs.base; // base score for passing all filters
            // Birth year proximity bonus.
            // Prefer the customer's STATED birth year over a generation estimate:
            // an exact match to what the customer actually told us is the
            // strongest identity signal we have, so weight it the most.
            if (candYear && recBirthYear) {
              const yearDiff = Math.abs(candYear - recBirthYear);
              score += Math.max(0, cs.customerYearExactBonus - yearDiff * cs.customerYearPenaltyPerYear);
            } else if (candYear && effectiveExpectedYear) {
              const yearDiff = Math.abs(candYear - effectiveExpectedYear);
              score += Math.max(0, cs.estimateYearBonus - yearDiff * cs.estimateYearPenaltyPerYear);
            }
            // Having a birth date at all (not a stub)
            if (candYear) score += cs.hasBirthDateBonus;
            // Having a birth place
            if (place) score += cs.hasBirthPlaceBonus;
            // Location match quality
            if (refPlace && place) {
              const prox = placeProximity(place, refPlace);
              if (prox.proximity === 'same') score += cs.sameLocationBonus;
              else if (prox.proximity === 'nearby') score += cs.nearbyLocationBonus;
            }
            // Source count bonus — CAPPED so a wrong person who simply has many
            // attached records cannot out-rank a correct identity/date match.
            score += Math.min(sourceScore, cs.sourceBonusCapPrimaries) * cs.sourceBonusPerPrimary;
            // FamilySearch's own relevance rank — a useful tiebreaker between
            // otherwise-similar candidates.
            score += Math.min(cs.fsRelevanceCap, Math.round((cand.score || 0) * cs.fsRelevanceFactor));
            // Parent data available bonus (useful for downstream tree traversal)
            if (cand.parentData && (cand.parentData.father || cand.parentData.mother)) score += cs.parentDataBonus;

            console.log(`[Engine]     → passed filters, score: ${score}`);
            passingCandidates.push({ cand, score, place });
          }

          // Pick the best candidate
          if (passingCandidates.length === 0) {
            console.log(`[Engine] asc#${asc}: no candidates passed all filters`);
            return null;
          }

          passingCandidates.sort((a, b) => b.score - a.score);
          const best = passingCandidates[0];

          // If multiple candidates passed and scores are close, log a warning
          if (passingCandidates.length > 1) {
            const second = passingCandidates[1];
            console.log(`[Engine] asc#${asc}: ${passingCandidates.length} candidates passed. Best: ${best.cand.name} (${best.score}), Runner-up: ${second.cand.name} (${second.score})`);
          }

          console.log(`[Engine]   ✓ asc#${asc} matched: ${best.cand.name} (${best.cand.id}) [score: ${best.score}]`);
          this.db.updateAncestorByAscNumber(this.jobId, asc, {
            fs_person_id: best.cand.id,
            verification_notes: (rec.verification_notes || 'Customer-provided data') + ` | FS linked: ${best.cand.id}`,
          });
          return best.cand.id;
        } catch (err) {
          console.log(`[Engine] FS search error for asc#${asc}: ${err.message}`);
        }
        return null;
      };

      // Search great-grandparents first (asc#8-15, most likely dead with full records),
      // then grandparents (asc#4-7), then parents (asc#2-3), then subject (asc#1)
      const searchOrder = [8, 9, 10, 11, 12, 13, 14, 15, 4, 5, 6, 7, 2, 3, 1];
      const linkedFsIds = new Map(); // asc → FS person ID

      if (this.fsSource) {
        for (const asc of searchOrder) {
          const rec = this.db.getAncestorByAscNumber(this.jobId, asc);
          if (!rec) continue;
          const fsId = await findFsPersonForAncestor(asc);
          if (fsId) linkedFsIds.set(asc, fsId);
        }
        console.log(`[Engine] Linked ${linkedFsIds.size} customer ancestors to FS`);
      }

      // ── Phase 2: Tree Traversal + Source-Verified Parent Discovery ──
      // For each child (generation by generation), find them in the FS tree,
      // get their parents via the /parents endpoint, then verify each parent
      // has actual record citations (birth certs, census, marriage records).

      console.log(`\n[Engine] ── Phase 2: Tree-Based Parent Discovery ──\n`);

      const storedAscNumbers = new Set();
      // Track all FS person IDs already used in the tree to prevent the same
      // person being assigned as parent of both husband AND wife (impossible).
      const usedFsPersonIds = new Set();

      // First, mark all existing customer data and collect their FS IDs
      for (let asc = 1; asc <= maxAsc; asc++) {
        const existing = this.db.getAncestorByAscNumber(this.jobId, asc);
        if (existing && existing.confidence_level === 'Customer Data') {
          storedAscNumbers.add(asc);
          if (existing.fs_person_id) usedFsPersonIds.add(existing.fs_person_id);
        }
      }

      // Process by CHILD — one getParents call yields both father and mother.
      // Work generation by generation so children are resolved before we look for their parents.
      for (let gen = 1; gen <= this.generations; gen++) {
        // Children in this generation are at asc numbers 2^(gen-1) to 2^gen - 1
        // But we iterate over the children whose parents we're discovering
        const childGenStart = Math.pow(2, gen - 1);
        const childGenEnd = Math.pow(2, gen) - 1;

        for (let childAsc = childGenStart; childAsc <= childGenEnd; childAsc++) {
          const fatherAsc = childAsc * 2;
          const motherAsc = childAsc * 2 + 1;

          // Skip if both parent slots already have customer data
          if (storedAscNumbers.has(fatherAsc) && storedAscNumbers.has(motherAsc)) continue;
          // Skip if parent slots are beyond max
          if (fatherAsc > maxAsc) continue;

          const childRec = this.db.getAncestorByAscNumber(this.jobId, childAsc);
          if (!childRec) {
            console.log(`[Engine] Skipping parents of asc#${childAsc} — no child data`);
            continue;
          }

          this.db.updateJobProgress(this.jobId,
            `Finding parents of ${childRec.name} (asc#${childAsc})...`,
            this.processedCount, totalPossible);

          // Step 1: Find the child in the FS tree
          console.log(`[Engine] asc#${childAsc}: Finding ${childRec.name} in FS tree...`);
          const childResult = await this.findChildInTree(childRec);
          const childFsId = childResult.fsId;
          const searchParentData = childResult.parentData;

          if (!childFsId) {
            console.log(`[Engine] asc#${childAsc}: ${childRec.name} NOT found in FS tree — skipping parent slots ${fatherAsc},${motherAsc}`);
            this.processedCount += 2;
            continue;
          }
          console.log(`[Engine] asc#${childAsc}: Found in tree as ${childFsId}`);

          // Step 2: Get parents from tree (may fail if token is unauthenticated)
          let treeParents;
          try {
            treeParents = await this.fsSource.getParents(childFsId);
          } catch (err) {
            console.log(`[Engine] asc#${childAsc}: getParents error: ${err.message}`);
            // Fallback: use parent data extracted from search results
            if (searchParentData && (searchParentData.father || searchParentData.mother)) {
              console.log(`[Engine] asc#${childAsc}: Using parent names from search results as fallback`);
              treeParents = { father: searchParentData.father, mother: searchParentData.mother };
            } else {
              this.processedCount += 2;
              continue;
            }
          }

          // Process father
          if (treeParents.father && !storedAscNumbers.has(fatherAsc) && fatherAsc <= maxAsc) {
            const father = treeParents.father;
            console.log(`[Engine] asc#${fatherAsc}: Tree father = ${father.name} (${father.id}) b.${father.birthDate} ${father.birthPlace}`);

            // Duplicate FS person check — same person can't be two different ancestors
            if (usedFsPersonIds.has(father.id)) {
              console.log(`[Engine] asc#${fatherAsc}: REJECTED — FS person ${father.id} already used in tree (duplicate parent)`);
            } else {

            // Step 3: Validate
            const validation = this.validateTreeParent(father, childRec, 'Male');
            console.log(`[Engine] asc#${fatherAsc}: Validation: ${validation.valid ? 'PASS' : 'FAIL'} — ${validation.reasons.join('; ')}`);

            if (validation.valid) {
              // Step 4: Verify sources
              const srcVerify = await this.verifyParentSources(father.id);
              const discoveryMethod = srcVerify.primaryCount > 0 ? 'tree_parents_verified' : 'tree_parents_unverified';
              const srcSummary = srcVerify.classifications.map(c => `${c.category}: ${c.title}`).join(' | ');
              console.log(`[Engine] asc#${fatherAsc}: Sources: ${srcVerify.sources.length} total, ${srcVerify.primaryCount} primary → ${discoveryMethod}`);

              // A tree LINK is relationship evidence, so distant/foreign-born
              // tree parents need documentary proof but not the full
              // direct-search escalation (rulebook: distantTreeParentMinPrimary /
              // immigrantTreeParentMinPrimary). Families really did migrate.
              if (validation.locationProximity === 'distant' && srcVerify.primaryCount < RULES.sources.distantTreeParentMinPrimary) {
                console.log(`[Engine] asc#${fatherAsc}: REJECTED — distant location with only ${srcVerify.primaryCount} primary sources (need ${RULES.sources.distantTreeParentMinPrimary}+)`);
              } else if (validation.nonUk && srcVerify.primaryCount < RULES.sources.immigrantTreeParentMinPrimary) {
                console.log(`[Engine] asc#${fatherAsc}: REJECTED — non-UK birthplace with only ${srcVerify.primaryCount} primary sources (need ${RULES.sources.immigrantTreeParentMinPrimary}+ for an immigrant ancestor)`);
              } else {

              storedAscNumbers.add(fatherAsc);
              usedFsPersonIds.add(father.id);
              this.storeOrUpdateAncestor(fatherAsc, gen, {
                fs_person_id: father.id,
                name: father.name || 'Unknown',
                gender: father.gender || 'Male',
                birth_date: father.birthDate || '',
                birth_place: sanitizePlaceName(father.birthPlace || ''),
                death_date: father.deathDate || '',
                death_place: sanitizePlaceName(father.deathPlace || ''),
                confidence: 'pending',
                sources: ['FamilySearch'],
                raw_data: {
                  discoveryMethod,
                  treeParentOf: childRec.name,
                  childFsId,
                  sourceCount: srcVerify.sources.length,
                  primarySourceCount: srcVerify.primaryCount,
                  sourcePoints: srcVerify.totalPoints,
                  sourceClassifications: srcVerify.classifications,
                  validationReasons: validation.reasons,
                },
                confidence_score: 0,
                confidence_level: 'Pending',
                evidence_chain: srcVerify.classifications.map(c => ({
                  type: 'source_record',
                  category: c.category,
                  title: c.title,
                })),
                search_log: [{ step: 'tree_parents', childFsId, parentId: father.id, sources: srcVerify.sources.length }],
                conflicts: [],
                verification_notes: `Tree parent of ${childRec.name} (${discoveryMethod}). ${srcVerify.primaryCount} primary sources: ${srcSummary || 'none'}`,
              });
              } // end else (distant location check)
            } else {
              console.log(`[Engine] asc#${fatherAsc}: REJECTED — validation failed`);
            }
            } // end else (duplicate FS person check)
          } else if (!treeParents.father && !storedAscNumbers.has(fatherAsc)) {
            console.log(`[Engine] asc#${fatherAsc}: No father in FS tree for ${childRec.name}`);
          }

          // Process mother
          if (treeParents.mother && !storedAscNumbers.has(motherAsc) && motherAsc <= maxAsc) {
            const mother = treeParents.mother;
            console.log(`[Engine] asc#${motherAsc}: Tree mother = ${mother.name} (${mother.id}) b.${mother.birthDate} ${mother.birthPlace}`);

            // Duplicate FS person check — same person can't be two different ancestors
            if (usedFsPersonIds.has(mother.id)) {
              console.log(`[Engine] asc#${motherAsc}: REJECTED — FS person ${mother.id} already used in tree (duplicate parent)`);
            } else {

            // Step 3: Validate
            const validation = this.validateTreeParent(mother, childRec, 'Female');
            console.log(`[Engine] asc#${motherAsc}: Validation: ${validation.valid ? 'PASS' : 'FAIL'} — ${validation.reasons.join('; ')}`);

            if (validation.valid) {
              // Step 4: Verify sources
              const srcVerify = await this.verifyParentSources(mother.id);
              const discoveryMethod = srcVerify.primaryCount > 0 ? 'tree_parents_verified' : 'tree_parents_unverified';
              const srcSummary = srcVerify.classifications.map(c => `${c.category}: ${c.title}`).join(' | ');
              console.log(`[Engine] asc#${motherAsc}: Sources: ${srcVerify.sources.length} total, ${srcVerify.primaryCount} primary → ${discoveryMethod}`);

              // Tree link = relationship evidence: distant/foreign-born tree
              // parents need documentary proof, not the direct-search escalation.
              if (validation.locationProximity === 'distant' && srcVerify.primaryCount < RULES.sources.distantTreeParentMinPrimary) {
                console.log(`[Engine] asc#${motherAsc}: REJECTED — distant location with only ${srcVerify.primaryCount} primary sources (need ${RULES.sources.distantTreeParentMinPrimary}+)`);
              } else if (validation.nonUk && srcVerify.primaryCount < RULES.sources.immigrantTreeParentMinPrimary) {
                console.log(`[Engine] asc#${motherAsc}: REJECTED — non-UK birthplace with only ${srcVerify.primaryCount} primary sources (need ${RULES.sources.immigrantTreeParentMinPrimary}+ for an immigrant ancestor)`);
              } else {

              storedAscNumbers.add(motherAsc);
              usedFsPersonIds.add(mother.id);
              this.storeOrUpdateAncestor(motherAsc, gen, {
                fs_person_id: mother.id,
                name: mother.name || 'Unknown',
                gender: mother.gender || 'Female',
                birth_date: mother.birthDate || '',
                birth_place: sanitizePlaceName(mother.birthPlace || ''),
                death_date: mother.deathDate || '',
                death_place: sanitizePlaceName(mother.deathPlace || ''),
                confidence: 'pending',
                sources: ['FamilySearch'],
                raw_data: {
                  discoveryMethod,
                  treeParentOf: childRec.name,
                  childFsId,
                  sourceCount: srcVerify.sources.length,
                  primarySourceCount: srcVerify.primaryCount,
                  sourcePoints: srcVerify.totalPoints,
                  sourceClassifications: srcVerify.classifications,
                  validationReasons: validation.reasons,
                },
                confidence_score: 0,
                confidence_level: 'Pending',
                evidence_chain: srcVerify.classifications.map(c => ({
                  type: 'source_record',
                  category: c.category,
                  title: c.title,
                })),
                search_log: [{ step: 'tree_parents', childFsId, parentId: mother.id, sources: srcVerify.sources.length }],
                conflicts: [],
                verification_notes: `Tree parent of ${childRec.name} (${discoveryMethod}). ${srcVerify.primaryCount} primary sources: ${srcSummary || 'none'}`,
              });
              } // end else (distant location check)
            } else {
              console.log(`[Engine] asc#${motherAsc}: REJECTED — validation failed`);
            }
            } // end else (duplicate FS person check)
          } else if (!treeParents.mother && !storedAscNumbers.has(motherAsc)) {
            console.log(`[Engine] asc#${motherAsc}: No mother in FS tree for ${childRec.name}`);
          }

          this.processedCount += 2;
        }
      }

      // ── Strategy 2: Direct parent search for unfilled slots ──
      // When tree traversal failed (child not in tree, or parents not linked),
      // try searching FS directly for the parent using the child's surname,
      // estimated birth year, and location. Only accept if source-verified.

      console.log(`\n[Engine] ── Strategy 2: Direct Parent Search (fallback) ──\n`);

      for (let gen = 1; gen <= this.generations; gen++) {
        const childGenStart = Math.pow(2, gen - 1);
        const childGenEnd = Math.pow(2, gen) - 1;

        for (let childAsc = childGenStart; childAsc <= childGenEnd; childAsc++) {
          const fatherAsc = childAsc * 2;
          const motherAsc = childAsc * 2 + 1;
          if (fatherAsc > maxAsc) continue;

          const childRec = this.db.getAncestorByAscNumber(this.jobId, childAsc);
          if (!childRec) continue;

          const childNameParts = parseNameParts(childRec.name || '');
          const childBirthYear = normalizeDate(childRec.birth_date)?.year;
          const childBirthPlace = childRec.birth_place || '';

          // Try to fill unfilled father slot
          if (!storedAscNumbers.has(fatherAsc) && this.fsSource) {
            const fatherSurname = childNameParts.surname || '';
            // For hyphenated names, try each part
            const surnamesToTry = fatherSurname.includes('-')
              ? fatherSurname.split('-').map(s => s.trim()).filter(Boolean)
              : [fatherSurname];

            // Check if we have a known given name for this parent (from knownAnchors / customer data)
            const knownFather = this.knownAnchors[fatherAsc];
            const knownGivenName = knownFather?.givenName || '';

            for (const tryName of surnamesToTry) {
              if (!tryName) continue;
              const estBirthYear = this.estimateParentBirthYear(childAsc, childBirthYear, true);
              const query = { surname: tryName, count: 15 };
              if (estBirthYear) query.birthDate = String(estBirthYear);
              // If we know the given name, include it in the search for much better matches
              if (knownGivenName) query.givenName = knownGivenName;
              // Use child's birth place, or fallback to 'England' to filter out non-UK results
              if (childBirthPlace) {
                query.birthPlace = childBirthPlace;
              } else {
                query.birthPlace = 'England';
              }

              console.log(`[Engine] asc#${fatherAsc}: Direct search for father — ${knownGivenName ? knownGivenName + ' ' : ''}${tryName}, ~b.${estBirthYear || '?'}, ${query.birthPlace}`);

              try {
                const candidates = await this.fsSource.searchPerson(query);
                for (const cand of candidates) {
                  // STRICT UK filtering: if candidate has a place, it must be UK-recognizable
                  const candPlace = sanitizePlaceName(cand.birthPlace || cand.deathPlace || '');
                  if (candPlace) {
                    if (isNonUkPlace(candPlace)) continue;
                    if (!isUkPlace(candPlace)) {
                      console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — non-UK: ${candPlace}`);
                      continue;
                    }
                  }
                  if (this.rejectedFsIds.has(cand.id)) continue;
                  // Duplicate FS person check — same person can't appear twice in the tree
                  if (usedFsPersonIds.has(cand.id)) {
                    console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — SKIP: already used in tree`);
                    continue;
                  }

                  // Gender check
                  const candGender = (cand.gender || '').toLowerCase();
                  if (candGender && candGender !== 'male') continue;

                  // Surname must match
                  const candParts = parseNameParts(cand.name || '');
                  if (candParts.surname) {
                    const s1 = tryName.toLowerCase();
                    const s2 = candParts.surname.toLowerCase();
                    if (s1 !== s2 && !s1.includes(s2) && !s2.includes(s1)) continue;
                  }

                  // Birth year check
                  const candYear = normalizeDate(cand.birthDate)?.year;
                  if (childBirthYear && candYear) {
                    const gap = childBirthYear - candYear;
                    if (gap < RULES.ageGap.absolute.hardMin || gap > RULES.ageGap.absolute.hardMax) continue;
                  }
                  // Must have a birth date for post-1837 people
                  if (childBirthYear && childBirthYear >= 1837 && !candYear) continue;

                  // *** KEY: Only accept if source-verified (or auth-unavailable with strong match) ***
                  // The minimum-primary-sources ladder is defined by the master
                  // rulebook (RULES.sources) via minPrimarySourcesFor().
                  const parentGen = Math.floor(Math.log2(fatherAsc));
                  const candPlaceFull = sanitizePlaceName(cand.birthPlace || cand.deathPlace || '');
                  const candProximity = childBirthPlace ? placeProximity(candPlaceFull, childBirthPlace) : { proximity: null };
                  const minSources = this.minPrimarySourcesFor(
                    parentGen, candYear, tryName, !!knownGivenName, candProximity.proximity === 'distant');
                  if (candProximity.proximity === 'distant') {
                    console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — DISTANT (${candProximity.county1} vs ${candProximity.county2}), need ${minSources}+ sources`);
                  }
                  const srcVerify = await this.verifyParentSources(cand.id);
                  if (srcVerify.authFailed) {
                    // Can't verify sources due to auth — use secondary evidence instead
                    const candBirthYear = normalizeDate(cand.birthDate)?.year;

                    if (knownGivenName) {
                      // We have a known given name — verify it matches
                      const candParts2 = parseNameParts(cand.name || '');
                      if (!this.namesSimilar(candParts2.givenName, knownGivenName)) {
                        console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, given name '${candParts2.givenName}' doesn't match known '${knownGivenName}', SKIP`);
                        continue;
                      }
                      if (candProximity.proximity === 'distant') {
                        console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — auth unavailable + distant location, SKIP`);
                        continue;
                      }
                      // Try FreeBMD cross-verification as secondary check
                      if (candBirthYear && candBirthYear >= 1837 && candBirthYear <= 1983) {
                        const freebmdCheck = await this.confirmWithFreeBMD(
                          cand.name, candBirthYear, cand.birthPlace || childBirthPlace, null, fatherAsc
                        );
                        if (freebmdCheck.bonusScore > 0) {
                          console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — auth unavailable but FreeBMD confirms birth`);
                        }
                      }
                      console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, accepting: known given name '${knownGivenName}' matches`);
                    } else {
                      // No known given name — try secondary evidence (FreeBMD, location, surname rarity)
                      if (candProximity.proximity === 'distant') {
                        console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, no known name, distant location, SKIP`);
                        continue;
                      }
                      // For common surnames without known name: still too risky unless FreeBMD confirms
                      let freebmdConfirmed = false;
                      if (candBirthYear && candBirthYear >= 1837 && candBirthYear <= 1983) {
                        try {
                          const freebmdCheck = await this.confirmWithFreeBMD(
                            cand.name, candBirthYear, cand.birthPlace || childBirthPlace, null, fatherAsc
                          );
                          freebmdConfirmed = freebmdCheck.bonusScore > 0;
                        } catch (e) { /* ignore FreeBMD errors */ }
                      }
                      const parentGen = Math.floor(Math.log2(fatherAsc));
                      if (isCommonSurname(tryName) && !freebmdConfirmed) {
                        console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, common surname, no known name, no FreeBMD confirm, SKIP`);
                        continue;
                      }
                      if (!freebmdConfirmed && parentGen < 4) {
                        console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, no known name, gen ${parentGen} needs verification, SKIP`);
                        continue;
                      }
                      // Accept: uncommon surname OR FreeBMD-confirmed OR deep generation
                      const reason = freebmdConfirmed ? 'FreeBMD confirmed' : `uncommon surname at gen ${parentGen}`;
                      console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, accepting without known name: ${reason}`);
                    }
                  } else if (srcVerify.primaryCount < minSources) {
                    console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — ${srcVerify.primaryCount} primary sources, SKIP (need ${minSources}+)`);
                    continue;
                  }

                  // GENEALOGICAL LINKAGE RULE (rulebook): a direct-search father
                  // must be LINKED to the child by name evidence (known given
                  // name from customer/notes/child's record) or a FreeBMD
                  // triangulation. Surname + era + place alone is never enough —
                  // that is how a stranger gets fabricated into the slot of an
                  // illegitimate child's genuinely-unknown father.
                  if (RULES.discovery.fatherDirectSearchRequiresNameEvidence && !knownGivenName && !srcVerify.authFailed) {
                    let freebmdLinked = false;
                    const candLinkBY = normalizeDate(cand.birthDate)?.year;
                    if (this.freebmdSource && candLinkBY && candLinkBY >= 1837 && candLinkBY <= 1983) {
                      try {
                        freebmdLinked = (await this.confirmWithFreeBMD(cand.name, candLinkBY, cand.birthPlace || childBirthPlace, null, fatherAsc)).bonusScore > 0;
                      } catch (e) { /* FreeBMD unavailable — no link */ }
                    }
                    if (!freebmdLinked) {
                      console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — no name evidence links him to ${childRec.name} (linkage rule), SKIP`);
                      continue;
                    }
                  }

                  // Validate
                  const validation = this.validateTreeParent(
                    { ...cand, birthDate: cand.birthDate, deathDate: cand.deathDate, birthPlace: cand.birthPlace, deathPlace: cand.deathPlace },
                    childRec, 'Male'
                  );
                  if (!validation.valid) {
                    console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — validation failed: ${validation.reasons.join('; ')}`);
                    continue;
                  }
                  if (validation.nonUk) {
                    console.log(`[Engine] asc#${fatherAsc}:   ${cand.name} (${cand.id}) — non-UK birthplace on a direct-search candidate, SKIP`);
                    continue;
                  }

                  const discoveryMethod = srcVerify.authFailed ? 'direct_search_unverified' : 'direct_search_verified';
                  const srcSummary = srcVerify.classifications.map(c => `${c.category}: ${c.title}`).join(' | ');
                  console.log(`[Engine] asc#${fatherAsc}: FOUND via direct search: ${cand.name} (${cand.id}) — ${srcVerify.authFailed ? 'auth unavailable' : srcVerify.primaryCount + ' primary sources'}`);

                  storedAscNumbers.add(fatherAsc);
                  usedFsPersonIds.add(cand.id);
                  this.storeOrUpdateAncestor(fatherAsc, gen, {
                    fs_person_id: cand.id,
                    name: cand.name || 'Unknown',
                    gender: cand.gender || 'Male',
                    birth_date: cand.birthDate || '',
                    birth_place: sanitizePlaceName(cand.birthPlace || ''),
                    death_date: cand.deathDate || '',
                    death_place: sanitizePlaceName(cand.deathPlace || ''),
                    confidence: 'pending',
                    sources: ['FamilySearch'],
                    raw_data: {
                      discoveryMethod,
                      searchedAsParentOf: childRec.name,
                      sourceCount: srcVerify.sources.length,
                      primarySourceCount: srcVerify.primaryCount,
                      sourcePoints: srcVerify.totalPoints,
                      sourceClassifications: srcVerify.classifications,
                      validationReasons: validation.reasons,
                    },
                    confidence_score: 0,
                    confidence_level: 'Pending',
                    evidence_chain: srcVerify.classifications.map(c => ({ type: 'source_record', category: c.category, title: c.title })),
                    search_log: [{ step: 'direct_search', surname: tryName, estBirthYear, sources: srcVerify.sources.length }],
                    conflicts: [],
                    verification_notes: `Direct search for father of ${childRec.name} (${discoveryMethod}). ${srcVerify.primaryCount} primary sources: ${srcSummary || 'none'}`,
                  });
                  break; // Found father, stop searching
                }
              } catch (err) {
                console.log(`[Engine] asc#${fatherAsc}: Direct search error: ${err.message}`);
              }
              if (storedAscNumbers.has(fatherAsc)) break; // Found with this surname variant
            }
          }

          // Try to fill unfilled mother slot
          // For mothers, we need a maiden name hint. Check if child's FS search gave parent names.
          if (!storedAscNumbers.has(motherAsc) && motherAsc <= maxAsc && this.fsSource) {
            let motherSurname = '';
            let motherGiven = '';

            // Check knownAnchors first (from customer-provided notes)
            const knownMother = this.knownAnchors[motherAsc];
            if (knownMother?.givenName) motherGiven = knownMother.givenName;
            if (knownMother?.surname) motherSurname = knownMother.surname;

            // Try to get mother name from Phase 1 FS search (fsPerson.motherName in raw_data)
            const childRawData = childRec.raw_data || {};
            if (!motherSurname && childRawData.fsPerson?.motherName) {
              const mp = parseNameParts(childRawData.fsPerson.motherName);
              motherSurname = mp.surname || '';
              if (!motherGiven) motherGiven = mp.givenName || '';
            }

            // Also try: if the child was linked to FS, search results may have included parent names
            if (!motherSurname && childRec.fs_person_id) {
              try {
                const searchResults = await this.fsSource.searchPerson({
                  givenName: childNameParts.givenName,
                  surname: childNameParts.surname,
                  birthDate: childRec.birth_date ? String(normalizeDate(childRec.birth_date)?.year || '') : '',
                  count: 1,
                });
                if (searchResults.length > 0 && searchResults[0].id === childRec.fs_person_id) {
                  if (searchResults[0].motherName) {
                    const mp = parseNameParts(searchResults[0].motherName);
                    motherSurname = mp.surname || '';
                    motherGiven = mp.givenName || '';
                  }
                }
              } catch (e) { /* ignore */ }
            }

            if (motherSurname) {
              const estBirthYear = this.estimateParentBirthYear(childAsc, childBirthYear, false);
              const query = { surname: motherSurname, count: 15 };
              if (motherGiven) query.givenName = motherGiven;
              if (estBirthYear) query.birthDate = String(estBirthYear);
              if (childBirthPlace) {
                query.birthPlace = childBirthPlace;
              } else {
                query.birthPlace = 'England';
              }

              console.log(`[Engine] asc#${motherAsc}: Direct search for mother — ${motherGiven ? motherGiven + ' ' : ''}${motherSurname}, ~b.${estBirthYear || '?'}, ${query.birthPlace}`);

              try {
                const candidates = await this.fsSource.searchPerson(query);
                for (const cand of candidates) {
                  // STRICT UK filtering: if candidate has a place, it must be UK-recognizable
                  const candPlace = sanitizePlaceName(cand.birthPlace || cand.deathPlace || '');
                  if (candPlace) {
                    if (isNonUkPlace(candPlace)) continue;
                    if (!isUkPlace(candPlace)) {
                      console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — non-UK: ${candPlace}`);
                      continue;
                    }
                  }
                  if (this.rejectedFsIds.has(cand.id)) continue;
                  // Duplicate FS person check
                  if (usedFsPersonIds.has(cand.id)) {
                    console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — SKIP: already used in tree`);
                    continue;
                  }

                  const candGender = (cand.gender || '').toLowerCase();
                  if (candGender && candGender !== 'female') continue;

                  const candYear = normalizeDate(cand.birthDate)?.year;
                  if (childBirthYear && candYear) {
                    const gap = childBirthYear - candYear;
                    if (gap < RULES.ageGap.absolute.hardMin || gap > RULES.ageGap.absolute.hardMax) continue;
                  }
                  if (childBirthYear && childBirthYear >= 1837 && !candYear) continue;

                  // Source verification required — the minimum-primary-sources
                  // ladder is defined by the master rulebook via minPrimarySourcesFor().
                  const motherGenNum = Math.floor(Math.log2(motherAsc));
                  const motherCandPlace = sanitizePlaceName(cand.birthPlace || cand.deathPlace || '');
                  const motherCandProx = childBirthPlace ? placeProximity(motherCandPlace, childBirthPlace) : { proximity: null };
                  const motherMinSources = this.minPrimarySourcesFor(
                    motherGenNum, candYear, motherSurname, !!motherGiven, motherCandProx.proximity === 'distant');
                  if (motherCandProx.proximity === 'distant') {
                    console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — DISTANT (${motherCandProx.county1} vs ${motherCandProx.county2}), need ${motherMinSources}+ sources`);
                  }
                  const srcVerify = await this.verifyParentSources(cand.id);
                  if (srcVerify.authFailed) {
                    // Can't verify sources due to auth — use secondary evidence instead
                    const candMotherBirthYear = normalizeDate(cand.birthDate)?.year;

                    if (motherGiven) {
                      // We have a known given name — verify it matches
                      const candMotherParts = parseNameParts(cand.name || '');
                      if (!this.namesSimilar(candMotherParts.givenName, motherGiven)) {
                        console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, given name '${candMotherParts.givenName}' doesn't match known '${motherGiven}', SKIP`);
                        continue;
                      }
                      if (motherCandProx.proximity === 'distant') {
                        console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — auth unavailable + distant location, SKIP`);
                        continue;
                      }
                      // Try FreeBMD cross-verification
                      if (candMotherBirthYear && candMotherBirthYear >= 1837 && candMotherBirthYear <= 1983) {
                        try {
                          const freebmdCheck = await this.confirmWithFreeBMD(
                            cand.name, candMotherBirthYear, cand.birthPlace || childBirthPlace, null, motherAsc
                          );
                          if (freebmdCheck.bonusScore > 0) {
                            console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — auth unavailable but FreeBMD confirms birth`);
                          }
                        } catch (e) { /* ignore FreeBMD errors */ }
                      }
                      console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, accepting: known given name '${motherGiven}' matches`);
                    } else {
                      // No known given name — try secondary evidence
                      if (motherCandProx.proximity === 'distant') {
                        console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, no known name, distant location, SKIP`);
                        continue;
                      }
                      let freebmdConfirmed = false;
                      if (candMotherBirthYear && candMotherBirthYear >= 1837 && candMotherBirthYear <= 1983) {
                        try {
                          const freebmdCheck = await this.confirmWithFreeBMD(
                            cand.name, candMotherBirthYear, cand.birthPlace || childBirthPlace, null, motherAsc
                          );
                          freebmdConfirmed = freebmdCheck.bonusScore > 0;
                        } catch (e) { /* ignore FreeBMD errors */ }
                      }
                      if (isCommonSurname(motherSurname) && !freebmdConfirmed) {
                        console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, common surname, no known name, no FreeBMD confirm, SKIP`);
                        continue;
                      }
                      if (!freebmdConfirmed && motherGenNum < 4) {
                        console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, no known name, gen ${motherGenNum} needs verification, SKIP`);
                        continue;
                      }
                      const reason = freebmdConfirmed ? 'FreeBMD confirmed' : `uncommon surname at gen ${motherGenNum}`;
                      console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — auth unavailable, accepting without known name: ${reason}`);
                    }
                  } else if (srcVerify.primaryCount < motherMinSources) {
                    console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — ${srcVerify.primaryCount} primary sources, SKIP (need ${motherMinSources}+)`);
                    continue;
                  }

                  const validation = this.validateTreeParent(
                    { ...cand, birthDate: cand.birthDate, deathDate: cand.deathDate, birthPlace: cand.birthPlace, deathPlace: cand.deathPlace },
                    childRec, 'Female'
                  );
                  if (!validation.valid) {
                    console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — validation failed: ${validation.reasons.join('; ')}`);
                    continue;
                  }
                  if (validation.nonUk) {
                    console.log(`[Engine] asc#${motherAsc}:   ${cand.name} (${cand.id}) — non-UK birthplace on a direct-search candidate, SKIP`);
                    continue;
                  }

                  const discoveryMethod = srcVerify.authFailed ? 'direct_search_unverified' : 'direct_search_verified';
                  const srcSummary = srcVerify.classifications.map(c => `${c.category}: ${c.title}`).join(' | ');
                  console.log(`[Engine] asc#${motherAsc}: FOUND via direct search: ${cand.name} (${cand.id}) — ${srcVerify.primaryCount} primary sources`);

                  storedAscNumbers.add(motherAsc);
                  usedFsPersonIds.add(cand.id);
                  this.storeOrUpdateAncestor(motherAsc, gen, {
                    fs_person_id: cand.id,
                    name: cand.name || 'Unknown',
                    gender: cand.gender || 'Female',
                    birth_date: cand.birthDate || '',
                    birth_place: sanitizePlaceName(cand.birthPlace || ''),
                    death_date: cand.deathDate || '',
                    death_place: sanitizePlaceName(cand.deathPlace || ''),
                    confidence: 'pending',
                    sources: ['FamilySearch'],
                    raw_data: {
                      discoveryMethod,
                      searchedAsParentOf: childRec.name,
                      sourceCount: srcVerify.sources.length,
                      primarySourceCount: srcVerify.primaryCount,
                      sourcePoints: srcVerify.totalPoints,
                      sourceClassifications: srcVerify.classifications,
                      validationReasons: validation.reasons,
                    },
                    confidence_score: 0,
                    confidence_level: 'Pending',
                    evidence_chain: srcVerify.classifications.map(c => ({ type: 'source_record', category: c.category, title: c.title })),
                    search_log: [{ step: 'direct_search', surname: motherSurname, estBirthYear, sources: srcVerify.sources.length }],
                    conflicts: [],
                    verification_notes: `Direct search for mother of ${childRec.name} (${discoveryMethod}). ${srcVerify.primaryCount} primary sources: ${srcSummary || 'none'}`,
                  });
                  break;
                }
              } catch (err) {
                console.log(`[Engine] asc#${motherAsc}: Direct search error: ${err.message}`);
              }
            } else {
              // ── Strategy 2b: Marriage record triangulation for mothers ──
              // When we have no maiden name for the mother, try to find her via the father's spouse info.
              // If the father is in FS (with an fsId), query the spouses endpoint.
              // If the father is NOT in FS but we know his name, search FS for him and check spouse info in results.
              console.log(`[Engine] asc#${motherAsc}: No mother surname — trying marriage triangulation...`);

              const fatherRec = this.db.getAncestorByAscNumber(this.jobId, fatherAsc);
              let foundMotherViaSpouse = false;

              if (fatherRec && this.fsSource) {
                let spouseResults = [];

                // Approach A: Father has an FS ID — use the spouses endpoint directly
                if (fatherRec.fs_person_id) {
                  try {
                    spouseResults = await this.fsSource.getSpouses(fatherRec.fs_person_id);
                    console.log(`[Engine] asc#${motherAsc}: Father ${fatherRec.name} (${fatherRec.fs_person_id}) has ${spouseResults.length} spouse(s) in FS`);
                  } catch (err) {
                    console.log(`[Engine] asc#${motherAsc}: getSpouses error: ${err.message}`);
                  }
                }

                // Approach B: Father has no FS ID — search for him and check if results contain spouse info
                if (spouseResults.length === 0 && !fatherRec.fs_person_id && fatherRec.name) {
                  const fNp = parseNameParts(fatherRec.name);
                  if (fNp.givenName && fNp.surname) {
                    try {
                      const fatherSearchResults = await this.fsSource.searchPerson({
                        givenName: fNp.givenName,
                        surname: fNp.surname,
                        birthDate: fatherRec.birth_date ? String(normalizeDate(fatherRec.birth_date)?.year || '') : '',
                        birthPlace: fatherRec.birth_place || childBirthPlace || 'England',
                        count: 3,
                      });

                      // For each matching father candidate, try to get their spouses
                      for (const fCand of fatherSearchResults) {
                        if (this.rejectedFsIds.has(fCand.id)) continue;
                        const candPlace = sanitizePlaceName(fCand.birthPlace || '');
                        if (candPlace && isNonUkPlace(candPlace) && !isUkPlace(candPlace)) continue;

                        // Verify this is the right person (name + birth year match)
                        const candFirst = (fCand.name || '').split(' ')[0];
                        if (!this.namesSimilar(candFirst, fNp.givenName)) continue;
                        const candYear = normalizeDate(fCand.birthDate)?.year;
                        const fatherYear = normalizeDate(fatherRec.birth_date)?.year;
                        if (fatherYear && candYear && Math.abs(fatherYear - candYear) > 5) continue;

                        try {
                          const candidateSpouses = await this.fsSource.getSpouses(fCand.id);
                          if (candidateSpouses.length > 0) {
                            spouseResults = candidateSpouses;
                            console.log(`[Engine] asc#${motherAsc}: Found ${candidateSpouses.length} spouse(s) for father candidate ${fCand.name} (${fCand.id})`);
                            break;
                          }
                        } catch (e) { /* ignore */ }
                      }
                    } catch (err) {
                      console.log(`[Engine] asc#${motherAsc}: Father search for spouse triangulation error: ${err.message}`);
                    }
                  }
                }

                // Process spouse results — find a female spouse with the right dates
                for (const spouse of spouseResults) {
                  if (storedAscNumbers.has(motherAsc)) break;
                  const spouseGender = (spouse.gender || '').toLowerCase();
                  if (spouseGender && spouseGender !== 'female') continue;

                  const spousePlace = sanitizePlaceName(spouse.birthPlace || spouse.deathPlace || '');
                  if (spousePlace && isNonUkPlace(spousePlace) && !isUkPlace(spousePlace)) continue;
                  if (this.rejectedFsIds.has(spouse.id)) continue;
                  // Duplicate FS person check
                  if (usedFsPersonIds.has(spouse.id)) {
                    console.log(`[Engine] asc#${motherAsc}:   spouse ${spouse.name} (${spouse.id}) — SKIP: already used in tree`);
                    continue;
                  }

                  // Verify birth year is plausible as mother of the child
                  const spouseYear = normalizeDate(spouse.birthDate)?.year;
                  if (childBirthYear && spouseYear) {
                    const gap = childBirthYear - spouseYear;
                    if (gap < RULES.ageGap.absolute.hardMin || gap > RULES.ageGap.absolute.hardMax) continue;
                  }

                  // Source verification — ladder from the master rulebook. The
                  // marriage link itself is identity evidence, so the common-
                  // surname surcharge does not apply (hasKnownGivenName=true).
                  const motherGen = Math.floor(Math.log2(motherAsc));
                  const spouseBirthYr = normalizeDate(spouse.birthDate)?.year;
                  const spouseProx = childBirthPlace ? placeProximity(spousePlace, childBirthPlace) : { proximity: null };
                  const spouseMinSources = this.minPrimarySourcesFor(
                    motherGen, spouseBirthYr, '', true, spouseProx.proximity === 'distant');
                  if (spouseProx.proximity === 'distant') {
                    console.log(`[Engine] asc#${motherAsc}:   spouse ${spouse.name} (${spouse.id}) — DISTANT (${spouseProx.county1} vs ${spouseProx.county2}), need ${spouseMinSources}+ sources`);
                  }
                  const srcVerify = await this.verifyParentSources(spouse.id);
                  if (srcVerify.authFailed) {
                    if (spouseProx.proximity === 'distant') {
                      console.log(`[Engine] asc#${motherAsc}:   spouse ${spouse.name} (${spouse.id}) — auth unavailable + distant, SKIP`);
                      continue;
                    }
                    // Spouse triangulation is more reliable than direct search
                    // (marriage link is evidence), but still try FreeBMD verification
                    const spouseBirthYear = normalizeDate(spouse.birthDate)?.year;
                    if (spouseBirthYear && spouseBirthYear >= 1837 && spouseBirthYear <= 1983) {
                      const freebmdCheck = await this.confirmWithFreeBMD(
                        spouse.name, spouseBirthYear, spouse.birthPlace || childBirthPlace, null, motherAsc
                      );
                      if (freebmdCheck.bonusScore > 0) {
                        console.log(`[Engine] asc#${motherAsc}:   spouse ${spouse.name} (${spouse.id}) — auth unavailable but FreeBMD confirms birth`);
                      }
                    }
                    console.log(`[Engine] asc#${motherAsc}:   spouse ${spouse.name} (${spouse.id}) — auth unavailable, accepting based on marriage match`);
                  } else if (srcVerify.primaryCount < spouseMinSources) {
                    console.log(`[Engine] asc#${motherAsc}:   spouse ${spouse.name} (${spouse.id}) — ${srcVerify.primaryCount} primary sources, SKIP (need ${spouseMinSources}+)`);
                    continue;
                  }

                  const validation = this.validateTreeParent(
                    { ...spouse, birthDate: spouse.birthDate, deathDate: spouse.deathDate, birthPlace: spouse.birthPlace, deathPlace: spouse.deathPlace },
                    childRec, 'Female'
                  );
                  if (!validation.valid) {
                    console.log(`[Engine] asc#${motherAsc}:   spouse ${spouse.name} (${spouse.id}) — validation failed: ${validation.reasons.join('; ')}`);
                    continue;
                  }
                  // Marriage link = relationship evidence — a non-UK-born spouse
                  // is acceptable as a documented immigrant if source-backed.
                  if (validation.nonUk && srcVerify.primaryCount < RULES.sources.immigrantTreeParentMinPrimary) {
                    console.log(`[Engine] asc#${motherAsc}:   spouse ${spouse.name} (${spouse.id}) — non-UK birthplace with only ${srcVerify.primaryCount} primary sources, SKIP`);
                    continue;
                  }

                  const discoveryMethod = 'spouse_triangulation';
                  const srcSummary = srcVerify.classifications.map(c => `${c.category}: ${c.title}`).join(' | ');
                  console.log(`[Engine] asc#${motherAsc}: FOUND via spouse triangulation: ${spouse.name} (${spouse.id}) — ${srcVerify.primaryCount} primary sources`);

                  storedAscNumbers.add(motherAsc);
                  usedFsPersonIds.add(spouse.id);
                  foundMotherViaSpouse = true;
                  this.storeOrUpdateAncestor(motherAsc, gen, {
                    fs_person_id: spouse.id,
                    name: spouse.name || 'Unknown',
                    gender: spouse.gender || 'Female',
                    birth_date: spouse.birthDate || '',
                    birth_place: sanitizePlaceName(spouse.birthPlace || ''),
                    death_date: spouse.deathDate || '',
                    death_place: sanitizePlaceName(spouse.deathPlace || ''),
                    confidence: 'pending',
                    sources: ['FamilySearch'],
                    raw_data: {
                      discoveryMethod,
                      spouseOf: fatherRec.name,
                      fatherFsId: fatherRec.fs_person_id || '',
                      sourceCount: srcVerify.sources.length,
                      primarySourceCount: srcVerify.primaryCount,
                      sourcePoints: srcVerify.totalPoints,
                      sourceClassifications: srcVerify.classifications,
                      validationReasons: validation.reasons,
                    },
                    confidence_score: 0,
                    confidence_level: 'Pending',
                    evidence_chain: srcVerify.classifications.map(c => ({ type: 'source_record', category: c.category, title: c.title })),
                    search_log: [{ step: 'spouse_triangulation', fatherName: fatherRec.name, spouseId: spouse.id, sources: srcVerify.sources.length }],
                    conflicts: [],
                    verification_notes: `Found as spouse of ${fatherRec.name} (${discoveryMethod}). ${srcVerify.primaryCount} primary sources: ${srcSummary || 'none'}`,
                  });
                  break;
                }

                if (!foundMotherViaSpouse) {
                  console.log(`[Engine] asc#${motherAsc}: Marriage triangulation failed — no suitable spouse found`);
                }
              }

              if (!foundMotherViaSpouse) {
                console.log(`[Engine] asc#${motherAsc}: No mother surname hint and no spouse data — slot left empty`);
              }
            }
          }
        }
      }

      console.log(`[Engine] Stored ${storedAscNumbers.size} ancestors after Strategies 1-2`);

      // ── Strategy 3: FreeBMD Civil Records Discovery ──
      // When tree traversal (Strategy 1) and direct FS search (Strategy 2) both fail,
      // use FreeBMD birth records (post-1911) to discover mother's maiden surname,
      // and marriage records to discover both parents' full names.
      // Then re-search FS with the newly discovered names.

      if (this.freebmdSource) {
        console.log(`\n[Engine] ── Strategy 3: FreeBMD Civil Records Discovery ──\n`);

        const strategy3Discoveries = []; // { asc, name, surname, isMother, maidenSurname, discoveryMethod, evidence }

        for (let gen = 1; gen <= this.generations; gen++) {
          const childGenStart = Math.pow(2, gen - 1);
          const childGenEnd = Math.pow(2, gen) - 1;

          for (let childAsc = childGenStart; childAsc <= childGenEnd; childAsc++) {
            const fatherAsc = childAsc * 2;
            const motherAsc = childAsc * 2 + 1;
            if (fatherAsc > maxAsc) continue;

            const childRec = this.db.getAncestorByAscNumber(this.jobId, childAsc);
            if (!childRec) continue;

            const hasFather = storedAscNumbers.has(fatherAsc);
            const hasMother = storedAscNumbers.has(motherAsc);
            if (hasFather && hasMother) continue; // both already found

            const childNameParts = parseNameParts(childRec.name || '');
            const childBirthYear = normalizeDate(childRec.birth_date)?.year;
            const childBirthPlace = childRec.birth_place || '';

            // ── 3A: FreeBMD Birth Record → Mother's Maiden Surname ──
            // Post-1911 GRO index includes mother's maiden surname in the birth entry.
            let discoveredMaidenSurname = null;

            if (!hasMother && childBirthYear && childBirthYear >= 1911 && childBirthYear <= 1983) {
              try {
                const birthResults = await this.freebmdSource.searchBirths(
                  childNameParts.surname || '', childNameParts.givenName || '',
                  childBirthYear - 1, childBirthYear + 1,
                  this.extractDistrict(childBirthPlace) || ''
                );

                // Find best match for this child
                for (const entry of birthResults) {
                  if (!entry.spouseSurname) continue;
                  const sMatch = entry.surname?.toLowerCase() === childNameParts.surname?.toLowerCase();
                  const fMatch = entry.forenames && childNameParts.givenName &&
                    (entry.forenames.toLowerCase().startsWith(childNameParts.givenName.toLowerCase()) ||
                     this.namesSimilar(entry.forenames.split(' ')[0], childNameParts.givenName));
                  const yMatch = entry.year && Math.abs(entry.year - childBirthYear) <= 2;

                  if (sMatch && fMatch && yMatch) {
                    discoveredMaidenSurname = entry.spouseSurname;
                    console.log(`[Strategy3] asc#${childAsc} (${childRec.name}): FreeBMD birth found → mother's maiden surname = ${discoveredMaidenSurname}`);
                    break;
                  }
                }
              } catch (err) {
                console.log(`[Strategy3] asc#${childAsc}: FreeBMD birth search error: ${err.message}`);
              }
            }

            // ── 3B: FreeBMD Marriage Record → Both Parents' Names ──
            // Search for the parents' marriage to discover father's first name and mother's maiden name.
            const fatherSurname = childNameParts.surname || '';
            const motherMaiden = discoveredMaidenSurname || '';

            // Also check if we know the other parent's maiden name from customer data or previous discovery
            let knownMotherMaiden = motherMaiden;
            if (!knownMotherMaiden && hasMother) {
              const motherRec = this.db.getAncestorByAscNumber(this.jobId, motherAsc);
              if (motherRec) {
                const mp = parseNameParts(motherRec.name || '');
                knownMotherMaiden = mp.surname || '';
              }
            }
            if (!knownMotherMaiden) {
              const anchor = this.knownAnchors[motherAsc];
              if (anchor?.surname) knownMotherMaiden = anchor.surname;
            }

            // Estimate parents' marriage year: ~2 years before child's birth
            const estMarriageYear = childBirthYear ? childBirthYear - 2 : null;

            if ((!hasFather || !hasMother) && fatherSurname && estMarriageYear) {
              try {
                // Search marriages for the father's surname around the estimated marriage year
                const marriageResults = await this.freebmdSource.searchMarriages(
                  fatherSurname, '', // no given name — we may not know it
                  Math.max(estMarriageYear - 5, 1837), estMarriageYear + 3,
                  this.extractDistrict(childBirthPlace) || ''
                );

                // Common female first names — for gender filtering marriage entries
                const femaleNames = new Set(['mary','jane','elizabeth','sarah','ann','alice','emily','emma','charlotte','margaret',
                  'dorothy','florence','ethel','edith','ellen','harriet','isabella','catherine','agnes','annie','beatrice',
                  'caroline','clara','eliza','esther','fanny','frances','gertrude','hannah','helen','ida','jessie','josephine',
                  'kate','laura','lilian','lillian','louisa','lucy','mabel','maria','martha','matilda','maud','maude','may',
                  'millie','minnie','nellie','olive','phyllis','rachel','rosa','rose','ruth','sophia','susan','violet','winifred',
                  'alma','bertha','betty','brenda','celia','daisy','daphne','deborah','diana','doris','dulcie','edna','eileen',
                  'elsie','enid','evelyn','gladys','grace','gwendoline','hilda','irene','iris','ivy','joan','joyce','kathleen',
                  'lena','lily','lois','lydia','maisie','marjorie','muriel','nora','norah','pamela','patricia','peggy','ruby',
                  'sheila','stella','sylvia','vera','vivian','wendy','priscilla','constance','janet','jean','hester','gladys']);

                for (const entry of marriageResults) {
                  if (!entry.forenames || !entry.spouseSurname) continue;
                  if (entry.surname?.toLowerCase() !== fatherSurname.toLowerCase()) continue;

                  // Gender filter: skip entries where the forenames look female
                  // (these are brides born with fatherSurname who married OUT, not grooms)
                  const firstName = (entry.forenames || '').split(' ')[0].toLowerCase();
                  if (femaleNames.has(firstName)) {
                    console.log(`[Strategy3] asc#${childAsc}: Skipping female marriage entry: ${entry.forenames} ${entry.surname} × ${entry.spouseSurname} (${firstName} is female)`);
                    continue;
                  }

                  // If we know mother's maiden name, filter by it
                  if (knownMotherMaiden && entry.spouseSurname.toLowerCase() !== knownMotherMaiden.toLowerCase()) continue;

                  // If we DON'T know maiden name but discovered it from birth record, filter by that
                  if (discoveredMaidenSurname && entry.spouseSurname.toLowerCase() !== discoveredMaidenSurname.toLowerCase()) continue;

                  const groomFullName = `${entry.forenames} ${entry.surname}`.trim();
                  console.log(`[Strategy3] asc#${childAsc}: FreeBMD marriage → father = ${groomFullName}, mother maiden = ${entry.spouseSurname}, ${entry.year} ${entry.district}`);

                  // ── DISCOVER FATHER from marriage record ──
                  if (!hasFather && !storedAscNumbers.has(fatherAsc)) {
                    const fatherGeneration = gen;
                    const fatherBirthEst = (entry.year || estMarriageYear) - RULES.estimation.fatherAgeAtMarriageYears;

                    // Try to find this person in FS
                    let fatherFsId = null;
                    try {
                      const fsResults = await this.fsSource.searchPerson({
                        givenName: entry.forenames.split(' ')[0] || '',
                        surname: entry.surname || '',
                        birthDate: String(fatherBirthEst),
                        birthPlace: childBirthPlace || 'England',
                        count: 5,
                      });

                      for (const cand of fsResults) {
                        if (this.rejectedFsIds.has(cand.id)) continue;
                        if (usedFsPersonIds.has(cand.id)) continue;
                        const candFirst = (cand.name || '').split(' ')[0];
                        if (!this.namesSimilar(candFirst, entry.forenames.split(' ')[0])) continue;
                        const candParts = parseNameParts(cand.name || '');
                        if (candParts.surname?.toLowerCase() !== fatherSurname.toLowerCase()) continue;
                        fatherFsId = cand.id;
                        console.log(`[Strategy3] asc#${fatherAsc}: FS match for father → ${cand.name} (${cand.id})`);
                        break;
                      }
                    } catch (err) {
                      console.log(`[Strategy3] asc#${fatherAsc}: FS search error: ${err.message}`);
                    }

                    // Store the discovered father
                    const evidence = [{
                      record_type: 'marriage',
                      source: 'FreeBMD',
                      is_independent: true,
                      details: `Marriage: ${entry.forenames} ${entry.surname} × ${entry.spouseSurname}, ${entry.year} ${entry.district}`,
                      year: entry.year,
                      quarter: entry.quarter,
                      district: entry.district,
                      volume: entry.volume,
                      page: entry.page,
                      supports: ['identity', 'couple'],
                      weight: 25,
                    }];

                    this.storeOrUpdateAncestor(fatherAsc, fatherGeneration, {
                      name: groomFullName,
                      gender: 'Male',
                      birth_date: String(fatherBirthEst),
                      birth_place: childBirthPlace || '',
                      death_date: '',
                      death_place: '',
                      fs_person_id: fatherFsId || '',
                      confidence: 'suggested',
                      sources: ['FreeBMD'],
                      raw_data: { discoveryMethod: 'freebmd_marriage_discovery', marriageYear: entry.year, marriageDistrict: entry.district },
                      confidence_score: 0,
                      confidence_level: 'Suggested',
                      evidence_chain: evidence,
                      search_log: [{ step: 'freebmd_marriage_discovery', marriage: `${groomFullName} × ${entry.spouseSurname}`, year: entry.year }],
                      verification_notes: `FreeBMD marriage discovery: ${groomFullName} married ${entry.spouseSurname} in ${entry.year}`,
                      discovery_method: 'freebmd_marriage_discovery',
                    });

                    storedAscNumbers.add(fatherAsc);
                    if (fatherFsId) usedFsPersonIds.add(fatherFsId);
                    console.log(`[Strategy3] ✓ Stored father asc#${fatherAsc}: ${groomFullName}`);
                  }

                  // ── DISCOVER MOTHER maiden name for future FS search ──
                  if (!hasMother && !storedAscNumbers.has(motherAsc) && entry.spouseSurname) {
                    if (!discoveredMaidenSurname) discoveredMaidenSurname = entry.spouseSurname;
                  }

                  break; // Use first matching marriage
                }
              } catch (err) {
                console.log(`[Strategy3] asc#${childAsc}: FreeBMD marriage search error: ${err.message}`);
              }
            }

            // ── 3C: FS Search with discovered maiden surname for mother ──
            if (!hasMother && !storedAscNumbers.has(motherAsc) && discoveredMaidenSurname && this.fsSource) {
              const motherBirthEst = childBirthYear ? childBirthYear - RULES.estimation.motherGapYears : null;

              try {
                const fsResults = await this.fsSource.searchPerson({
                  surname: discoveredMaidenSurname,
                  birthDate: motherBirthEst ? String(motherBirthEst) : '',
                  birthPlace: childBirthPlace || 'England',
                  count: 10,
                });

                for (const cand of fsResults) {
                  if (this.rejectedFsIds.has(cand.id)) continue;
                  if (usedFsPersonIds.has(cand.id)) continue;
                  const candPlace = sanitizePlaceName(cand.birthPlace || '');
                  if (isNonUkPlace(candPlace) && !isUkPlace(candPlace) && candPlace) continue;

                  const candParts = parseNameParts(cand.name || '');
                  if (candParts.surname?.toLowerCase() !== discoveredMaidenSurname.toLowerCase()) continue;

                  const candYear = normalizeDate(cand.birthDate)?.year;
                  if (motherBirthEst && candYear && Math.abs(candYear - motherBirthEst) > 15) continue;

                  // Check geographic proximity
                  if (childBirthPlace && candPlace) {
                    const prox = placeProximity(candPlace, childBirthPlace);
                    if (prox.proximity === 'distant') continue;
                  }

                  // Gender check
                  const expectedGender = this.getExpectedGender(motherAsc);
                  if (expectedGender && cand.gender && cand.gender !== expectedGender) continue;

                  const motherGeneration = gen;
                  const evidence = [{
                    record_type: 'birth',
                    source: 'FreeBMD',
                    is_independent: true,
                    details: `Mother's maiden surname ${discoveredMaidenSurname} discovered from child's FreeBMD birth record`,
                    supports: ['identity'],
                    weight: 20,
                  }];

                  this.storeOrUpdateAncestor(motherAsc, motherGeneration, {
                    name: cand.name || `? ${discoveredMaidenSurname}`,
                    gender: 'Female',
                    birth_date: cand.birthDate || String(motherBirthEst || ''),
                    birth_place: sanitizePlaceName(cand.birthPlace || childBirthPlace || ''),
                    death_date: cand.deathDate || '',
                    death_place: sanitizePlaceName(cand.deathPlace || ''),
                    fs_person_id: cand.id || '',
                    confidence: 'suggested',
                    sources: ['FreeBMD', 'FamilySearch'],
                    raw_data: { discoveryMethod: 'freebmd_maiden_fs_search', maidenSurname: discoveredMaidenSurname, fsPersonId: cand.id },
                    confidence_score: 0,
                    confidence_level: 'Suggested',
                    evidence_chain: evidence,
                    search_log: [{ step: 'freebmd_maiden_fs_search', maidenSurname: discoveredMaidenSurname, fsId: cand.id }],
                    verification_notes: `FreeBMD maiden name + FS match: ${cand.name} (${cand.id})`,
                    discovery_method: 'freebmd_maiden_fs_search',
                  });

                  storedAscNumbers.add(motherAsc);
                  usedFsPersonIds.add(cand.id);
                  console.log(`[Strategy3] ✓ Stored mother asc#${motherAsc}: ${cand.name} (maiden ${discoveredMaidenSurname})`);
                  break;
                }
              } catch (err) {
                console.log(`[Strategy3] asc#${motherAsc}: FS search for mother error: ${err.message}`);
              }

              // If no FS match, still store the maiden surname as a placeholder
              if (!storedAscNumbers.has(motherAsc) && discoveredMaidenSurname) {
                const motherGeneration = gen;
                const evidence = [{
                  record_type: 'birth',
                  source: 'FreeBMD',
                  is_independent: true,
                  details: `Mother's maiden surname ${discoveredMaidenSurname} from child's birth index`,
                  supports: ['identity'],
                  weight: 15,
                }];

                this.storeOrUpdateAncestor(motherAsc, motherGeneration, {
                  name: `? ${discoveredMaidenSurname}`,
                  gender: 'Female',
                  birth_date: childBirthYear ? String(childBirthYear - RULES.estimation.motherGapYears) : '',
                  birth_place: childBirthPlace || '',
                  death_date: '',
                  death_place: '',
                  fs_person_id: '',
                  confidence: 'suggested',
                  sources: ['FreeBMD'],
                  raw_data: { discoveryMethod: 'freebmd_maiden_discovery', maidenSurname: discoveredMaidenSurname },
                  confidence_score: 0,
                  confidence_level: 'Suggested',
                  evidence_chain: evidence,
                  search_log: [{ step: 'freebmd_maiden_discovery', maidenSurname: discoveredMaidenSurname }],
                  verification_notes: `FreeBMD birth discovery: mother's maiden surname ${discoveredMaidenSurname}`,
                  discovery_method: 'freebmd_maiden_discovery',
                });

                storedAscNumbers.add(motherAsc);
                console.log(`[Strategy3] ✓ Stored mother asc#${motherAsc}: ? ${discoveredMaidenSurname} (maiden name only)`);
              }
            }
          }
        }

        // ── Strategy 3D: UNKNOWN father discovery via marriage of known parents ──
        // Special case: when father is listed as UNKNOWN but we know the child's
        // surname AND mother's maiden name, search FreeBMD marriages to find the father.
        // Strategy: try both surnames (father's and mother's maiden) to avoid "too many matches"
        // on common surnames. Also try findMarriage() for best-match scoring.
        for (let asc = 2; asc <= maxAsc; asc += 2) {
          if (storedAscNumbers.has(asc)) continue; // father already found
          const motherAsc = asc + 1;
          const childAsc = Math.floor(asc / 2);
          const childRec = this.db.getAncestorByAscNumber(this.jobId, childAsc);
          if (!childRec) continue;

          const childNP = parseNameParts(childRec.name || '');
          const childBirthYear = normalizeDate(childRec.birth_date)?.year;
          const childBirthPlace = childRec.birth_place || '';

          // We need the mother's maiden name (from customer data, knownAnchors, or stored record)
          let motherMaidenName = '';
          const motherRec = this.db.getAncestorByAscNumber(this.jobId, motherAsc);
          if (motherRec) {
            const mp = parseNameParts(motherRec.name || '');
            motherMaidenName = mp.surname || '';
          }
          if (!motherMaidenName) {
            const anchor = this.knownAnchors[motherAsc];
            if (anchor?.surname) motherMaidenName = anchor.surname;
          }
          if (!motherMaidenName || !childNP.surname || !childBirthYear) continue;

          const fatherSurname = childNP.surname;
          const yearFrom = Math.max(childBirthYear - 10, 1837);
          const yearTo = childBirthYear + 2;
          const district = this.extractDistrict(childBirthPlace) || '';

          console.log(`[Strategy3D] asc#${asc}: Searching marriage of ${fatherSurname} × ${motherMaidenName} near ${childBirthYear}`);

          let foundEntry = null;
          let searchedBy = '';

          try {
            // Approach 1: Use findMarriage() with father's surname + spouse matching
            let entry = await this.freebmdSource.findMarriage(
              fatherSurname, '', motherMaidenName, yearFrom, yearTo, district
            );
            if (entry && entry.forenames && entry.spouseSurname?.toLowerCase() === motherMaidenName.toLowerCase()) {
              foundEntry = entry;
              searchedBy = 'father_surname';
              console.log(`[Strategy3D] asc#${asc}: findMarriage(${fatherSurname}) → ${entry.forenames} ${entry.surname} × ${entry.spouseSurname} in ${entry.year}`);
            }

            // Approach 2: If father's surname failed, try mother's maiden name (less common)
            // In FreeBMD marriage index, both parties are listed — search bride's entry to find groom
            if (!foundEntry) {
              const brideEntries = await this.freebmdSource.searchMarriages(
                motherMaidenName, '', yearFrom, yearTo, district
              );
              for (const be of brideEntries) {
                if (!be.spouseSurname) continue;
                // The bride's entry: surname = maiden name, spouseSurname = groom's surname
                if (be.surname?.toLowerCase() !== motherMaidenName.toLowerCase()) continue;
                if (be.spouseSurname.toLowerCase() !== fatherSurname.toLowerCase()) continue;
                // Now search the groom's entry to get his forenames
                const groomEntries = await this.freebmdSource.searchMarriages(
                  fatherSurname, '', be.year ? be.year : yearFrom, be.year ? be.year : yearTo, be.district || ''
                );
                for (const ge of groomEntries) {
                  if (!ge.forenames) continue;
                  if (ge.surname?.toLowerCase() !== fatherSurname.toLowerCase()) continue;
                  if (ge.spouseSurname?.toLowerCase() !== motherMaidenName.toLowerCase()) continue;
                  if (be.year && ge.year && be.year !== ge.year) continue;
                  if (be.volume && ge.volume && be.volume !== ge.volume) continue;
                  foundEntry = ge;
                  searchedBy = 'mother_maiden_name';
                  console.log(`[Strategy3D] asc#${asc}: Bride search(${motherMaidenName}) → ${ge.forenames} ${ge.surname} × ${ge.spouseSurname} in ${ge.year}`);
                  break;
                }
                if (foundEntry) break;
              }
            }

            // Approach 3: Try without district filter if nothing found
            if (!foundEntry && district) {
              let entry = await this.freebmdSource.findMarriage(
                fatherSurname, '', motherMaidenName, yearFrom, yearTo, ''
              );
              if (entry && entry.forenames && entry.spouseSurname?.toLowerCase() === motherMaidenName.toLowerCase()) {
                foundEntry = entry;
                searchedBy = 'father_surname_no_district';
                console.log(`[Strategy3D] asc#${asc}: findMarriage(${fatherSurname}, no district) → ${entry.forenames} ${entry.surname} × ${entry.spouseSurname} in ${entry.year}`);
              }
            }

            if (foundEntry) {
              const entry = foundEntry;
              const fatherFullName = `${entry.forenames} ${entry.surname}`.trim();
              const fatherBirthEst = (entry.year || childBirthYear) - RULES.estimation.fatherAgeAtMarriageYears;

              console.log(`[Strategy3D] asc#${asc}: Found marriage → ${fatherFullName} married ${entry.spouseSurname} in ${entry.year} ${entry.district}`);

              // Try FS search
              let fatherFsId = null;
              if (this.fsSource) {
                try {
                  const fsResults = await this.fsSource.searchPerson({
                    givenName: entry.forenames.split(' ')[0] || '',
                    surname: entry.surname || '',
                    birthDate: String(fatherBirthEst),
                    birthPlace: childBirthPlace || entry.district || 'England',
                    count: 5,
                  });
                  for (const cand of fsResults) {
                    if (this.rejectedFsIds.has(cand.id) || usedFsPersonIds.has(cand.id)) continue;
                    const candFirst = (cand.name || '').split(' ')[0];
                    if (!this.namesSimilar(candFirst, entry.forenames.split(' ')[0])) continue;
                    fatherFsId = cand.id;
                    console.log(`[Strategy3D] asc#${asc}: FS match → ${cand.name} (${cand.id})`);
                    break;
                  }
                } catch (err) {
                  console.log(`[Strategy3D] asc#${asc}: FS search error: ${err.message}`);
                }
              }

              const evidence = [{
                record_type: 'marriage',
                source: 'FreeBMD',
                is_independent: true,
                details: `Marriage: ${fatherFullName} × ${entry.spouseSurname}, ${entry.year} ${entry.district}`,
                year: entry.year, quarter: entry.quarter, district: entry.district,
                volume: entry.volume, page: entry.page,
                supports: ['identity', 'couple'],
                weight: 25,
              }];

              const gen = Math.floor(Math.log2(asc));
              this.storeOrUpdateAncestor(asc, gen, {
                name: fatherFullName,
                gender: 'Male',
                birth_date: String(fatherBirthEst),
                birth_place: entry.district || childBirthPlace || '',
                death_date: '', death_place: '',
                fs_person_id: fatherFsId || '',
                confidence: 'suggested',
                sources: ['FreeBMD'],
                raw_data: { discoveryMethod: 'freebmd_unknown_father_discovery', searchedBy, marriageYear: entry.year, marriageDistrict: entry.district },
                confidence_score: 0,
                confidence_level: 'Suggested',
                evidence_chain: evidence,
                search_log: [{ step: 'freebmd_unknown_father_discovery', marriage: `${fatherFullName} × ${motherMaidenName}`, year: entry.year }],
                verification_notes: `FreeBMD marriage: ${fatherFullName} × ${motherMaidenName} in ${entry.year}`,
                discovery_method: 'freebmd_unknown_father_discovery',
              });

              storedAscNumbers.add(asc);
              if (fatherFsId) usedFsPersonIds.add(fatherFsId);
              console.log(`[Strategy3D] ✓ Discovered UNKNOWN father asc#${asc}: ${fatherFullName}`);
            } else {
              console.log(`[Strategy3D] asc#${asc}: No matching marriage found for ${fatherSurname} × ${motherMaidenName}`);
            }
          } catch (err) {
            console.log(`[Strategy3D] asc#${asc}: FreeBMD marriage search error: ${err.message}`);
          }
        }

        console.log(`[Engine] After Strategy 3: ${storedAscNumbers.size} ancestors stored`);

        // ── Strategy 3 Second Pass: Re-run tree traversal for newly discovered ancestors ──
        // Ancestors discovered by FreeBMD may now have FS person IDs, enabling tree traversal
        // for THEIR parents (next generation).
        const newlyDiscovered = [...storedAscNumbers].filter(asc => {
          const rec = this.db.getAncestorByAscNumber(this.jobId, asc);
          return rec && rec.fs_person_id && rec.discovery_method?.includes('freebmd');
        });

        if (newlyDiscovered.length > 0) {
          console.log(`\n[Engine] ── Strategy 3 Second Pass: Tree traversal for ${newlyDiscovered.length} FreeBMD discoveries ──\n`);

          for (const childAsc of newlyDiscovered) {
            const fatherAsc = childAsc * 2;
            const motherAsc = childAsc * 2 + 1;
            if (fatherAsc > maxAsc) continue;
            if (storedAscNumbers.has(fatherAsc) && storedAscNumbers.has(motherAsc)) continue;

            const childRec = this.db.getAncestorByAscNumber(this.jobId, childAsc);
            if (!childRec?.fs_person_id) continue;

            try {
              const treeParents = await this.fsSource.getParents(childRec.fs_person_id);
              if (!treeParents) continue;

              const childGen = Math.floor(Math.log2(childAsc));
              const parentGen = childGen + 1;

              if (treeParents.father && !storedAscNumbers.has(fatherAsc) && fatherAsc <= maxAsc) {
                const father = treeParents.father;
                const validation = this.validateTreeParent(father, childRec, 'Male');
                if (validation.valid && !validation.nonUk) {
                  this.storeOrUpdateAncestor(fatherAsc, parentGen, {
                    name: father.name || '', gender: 'Male',
                    birth_date: father.birthDate || '', birth_place: sanitizePlaceName(father.birthPlace || ''),
                    death_date: father.deathDate || '', death_place: sanitizePlaceName(father.deathPlace || ''),
                    fs_person_id: father.id || '',
                    confidence: 'suggested',
                    sources: ['FamilySearch'],
                    raw_data: { discoveryMethod: 'tree_parents_second_pass', treeParentOf: childAsc },
                    confidence_score: 0,
                    confidence_level: 'Suggested',
                    evidence_chain: [{ record_type: 'fs_tree_lead', source: 'FamilySearch', details: `Tree parent: ${father.name} (${father.id})`, supports: ['identity'], weight: 20 }],
                    search_log: [{ step: 'tree_parents_second_pass', childAsc, parentId: father.id }],
                    verification_notes: `Tree parent of FreeBMD-discovered asc#${childAsc}`,
                    discovery_method: 'tree_parents_second_pass',
                  });
                  storedAscNumbers.add(fatherAsc);
                  if (father.id) usedFsPersonIds.add(father.id);
                  console.log(`[Strategy3 2ndPass] ✓ asc#${fatherAsc}: ${father.name} (${father.id})`);
                }
              }

              if (treeParents.mother && !storedAscNumbers.has(motherAsc) && motherAsc <= maxAsc) {
                const mother = treeParents.mother;
                const validation = this.validateTreeParent(mother, childRec, 'Female');
                if (validation.valid && !validation.nonUk) {
                  this.storeOrUpdateAncestor(motherAsc, parentGen, {
                    name: mother.name || '', gender: 'Female',
                    birth_date: mother.birthDate || '', birth_place: sanitizePlaceName(mother.birthPlace || ''),
                    death_date: mother.deathDate || '', death_place: sanitizePlaceName(mother.deathPlace || ''),
                    fs_person_id: mother.id || '',
                    confidence: 'suggested',
                    sources: ['FamilySearch'],
                    raw_data: { discoveryMethod: 'tree_parents_second_pass', treeParentOf: childAsc },
                    confidence_score: 0,
                    confidence_level: 'Suggested',
                    evidence_chain: [{ record_type: 'fs_tree_lead', source: 'FamilySearch', details: `Tree parent: ${mother.name} (${mother.id})`, supports: ['identity'], weight: 20 }],
                    search_log: [{ step: 'tree_parents_second_pass', childAsc, parentId: mother.id }],
                    verification_notes: `Tree parent of FreeBMD-discovered asc#${childAsc}`,
                    discovery_method: 'tree_parents_second_pass',
                  });
                  storedAscNumbers.add(motherAsc);
                  if (mother.id) usedFsPersonIds.add(mother.id);
                  console.log(`[Strategy3 2ndPass] ✓ asc#${motherAsc}: ${mother.name} (${mother.id})`);
                }
              }
            } catch (err) {
              console.log(`[Strategy3 2ndPass] asc#${childAsc}: getParents error: ${err.message}`);
            }
          }

          console.log(`[Engine] After Strategy 3 second pass: ${storedAscNumbers.size} ancestors stored`);
        }
      }

      // ── Phase 3b: Score ancestors bottom-up using record-based points ──
      // Score generation by generation (children first, then parents) so family
      // context points can reference already-scored children.

      console.log(`\n[Engine] ── Phase 3b: Record-Based Scoring ──\n`);

      const scoredAncestors = new Map(); // asc → { score, level, name, surname, birthPlace, birthDate }
      this.processedCount = 0;

      // Build scoring order: gen 0, gen 1, gen 2, ... (children before parents)
      const scoringOrder = [];
      for (let gen = 0; gen <= this.generations; gen++) {
        const genStart = Math.pow(2, gen);
        const genEnd = Math.pow(2, gen + 1) - 1;
        for (let asc = genStart; asc <= genEnd && asc <= maxAsc; asc++) {
          const rec = this.db.getAncestorByAscNumber(this.jobId, asc);
          if (rec) scoringOrder.push(asc);
        }
      }

      for (const asc of scoringOrder) {
        const rec = this.db.getAncestorByAscNumber(this.jobId, asc);
        if (!rec) continue;

        this.processedCount++;
        const generation = Math.floor(Math.log2(asc));

        // Customer Data — always 100%, skip API calls
        if (rec.confidence_level === 'Customer Data') {
          scoredAncestors.set(asc, {
            score: 100, level: 'Customer Data',
            name: rec.name, surname: parseNameParts(rec.name).surname,
            birthPlace: rec.birth_place || '', birthDate: rec.birth_date || '',
            allPlaces: rec.birth_place || '', // Customer data uses birth_place directly
          });
          this.db.updateJobProgress(this.jobId,
            `Customer: ${rec.name}`, this.processedCount, totalPossible);
          console.log(`[Engine] asc#${asc}: ${rec.name} — Customer Data 100%`);
          continue;
        }

        // Score this ancestor using the 4-section points system
        this.db.updateJobProgress(this.jobId,
          `Scoring ${rec.name}...`, this.processedCount, totalPossible);

        let sourceResult = { points: 0, notes: ['Sources: no FS ID'], evidenceChain: [] };
        let factResult = { points: 0, notes: ['Facts: no FS ID'] };
        let fetchedSources = [];
        let fetchedFacts = null;

        // Sections 1 & 2: Fetch sources and facts from FS (if we have a person ID)
        if (rec.fs_person_id) {
          try {
            // Prefer the pluggable source abstraction; fall back to the raw api module
            fetchedSources = this.fsSource
              ? await this.fsSource.getPersonSources(rec.fs_person_id)
              : await fsApi.getPersonSources(rec.fs_person_id);
            sourceResult = scoreSourceRecords(fetchedSources);
          } catch (err) {
            console.log(`[Engine] asc#${asc}: getPersonSources error: ${err.message}`);
            sourceResult = { points: 0, notes: [`Sources: error fetching (${err.message})`], evidenceChain: [] };
          }

          try {
            fetchedFacts = await fsApi.extractFactsByType(rec.fs_person_id);
            factResult = scorePersonFacts(fetchedFacts);
          } catch (err) {
            console.log(`[Engine] asc#${asc}: extractFactsByType error: ${err.message}`);
            factResult = { points: 0, notes: [`Facts: error fetching (${err.message})`] };
          }
        }

        // Section 3: Family context
        const familyResult = this.scoreFamilyContext(asc, scoredAncestors, rec);

        // Section 4: Location & date plausibility (pass facts + sources for location resolution)
        const locationResult = this.scoreLocationDate(asc, rec, scoredAncestors, fetchedFacts, fetchedSources);

        // Sum all points
        const totalPoints = sourceResult.points + factResult.points + familyResult.points + locationResult.points;
        let confidenceScore = computeFinalScore(totalPoints);
        let confidenceLevel = this.getConfidenceLevel(confidenceScore);

        // Build verification notes (period-separated for bullet display in UI)
        const allNotes = [
          ...familyResult.notes,
          ...sourceResult.notes,
          ...factResult.notes,
          ...locationResult.notes,
          `Total: ${totalPoints}pts — ${confidenceLevel} ${confidenceScore}%`,
        ];
        const verificationNotes = allNotes.join('. ');

        // Build scoring breakdown for UI
        const scoringBreakdown = {
          sources: { points: sourceResult.points, details: sourceResult.notes },
          facts: { points: factResult.points, details: factResult.notes },
          family: { points: familyResult.points, details: familyResult.notes },
          location: { points: locationResult.points, details: locationResult.notes },
          total_points: totalPoints,
          final_score: confidenceScore,
        };

        // Resolve best known location for this ancestor (for child comparisons downstream)
        let resolvedPlace = rec.birth_place || '';
        if (!resolvedPlace && fetchedFacts) {
          const bp = (fetchedFacts.birth || []).find(f => f.place) || (fetchedFacts.baptism || []).find(f => f.place);
          if (bp) resolvedPlace = bp.place;
          if (!resolvedPlace) { const rf = (fetchedFacts.residence || []).find(f => f.place); if (rf) resolvedPlace = rf.place; }
          if (!resolvedPlace) { const bf = (fetchedFacts.burial || []).find(f => f.place); if (bf) resolvedPlace = bf.place; }
          if (!resolvedPlace) { const cf = (fetchedFacts.census || []).find(f => f.place); if (cf) resolvedPlace = cf.place; }
        }
        if (!resolvedPlace && fetchedSources.length > 0) {
          for (const s of fetchedSources) {
            const text = ((s.citation || '') + ' ' + (s.title || '')).toLowerCase().replace(/<[^>]+>/g, '');
            const fc = [...UK_COUNTIES].find(c => text.includes(c));
            if (fc) { resolvedPlace = fc; break; }
          }
        }

        // ── Data quality gate: cap confidence for poorly identified ancestors ──
        const ancestorNameParts = parseNameParts(rec.name || '');
        const hasSurname = !!(ancestorNameParts.surname && ancestorNameParts.surname.trim().length > 1);
        const hasLocation = !!(rec.birth_place || resolvedPlace);
        const hasBirthYear = !!(rec.birth_date);
        const hasSourceRecords = sourceResult.points > 0;

        // Confidence caps come from the master rulebook (RULES.gates).
        if (!hasSurname) {
          // No surname (e.g. just "Sarah") — insufficient to verify identity
          confidenceScore = Math.min(confidenceScore, RULES.gates.noSurnameMaxPercent);
          confidenceLevel = this.getConfidenceLevel(confidenceScore);
        }
        if (!hasSurname && !hasBirthYear && !hasLocation) {
          // Virtually no identifying data
          confidenceScore = Math.min(confidenceScore, RULES.gates.noIdentityMaxPercent);
          confidenceLevel = this.getConfidenceLevel(confidenceScore);
        }
        // No documentary source records for someone born in the civil-registration
        // era. FamilySearch tree facts are LEADS, not proof, so an unsourced
        // 19th/20th-century match must not be auto-accepted as Probable/Verified.
        const gateBirthYear = normalizeDate(rec.birth_date)?.year || null;
        if (!hasSourceRecords && rec.fs_person_id && (!gateBirthYear || gateBirthYear >= RULES.gates.civilRegistrationYear)) {
          confidenceScore = Math.min(confidenceScore, RULES.gates.unsourcedCivilEraMaxPercent);
          confidenceLevel = this.getConfidenceLevel(confidenceScore);
        }

        // Auto-accept only at the rulebook's auto-accept threshold — below it stays for manual review
        const autoAccepted = confidenceScore >= RULES.confidence.autoAcceptPercent ? 1 : 0;

        // Detect missing info \u2014 thresholds from the master rulebook
        const missingInfo = [];

        if (!hasLocation && confidenceScore < RULES.confidence.levelCutoffs.probable) {
          missingInfo.push({ type: 'location', message: 'Birth location unknown \u2014 adding a county would improve accuracy.' });
        }
        if (!hasBirthYear && confidenceScore < RULES.confidence.levelCutoffs.probable) {
          missingInfo.push({ type: 'date', message: 'Birth year unknown \u2014 an approximate year would help.' });
        }
        if (!hasSourceRecords && rec.fs_person_id) {
          missingInfo.push({ type: 'records', message: 'No source records found \u2014 may need manual lookup on Ancestry.' });
        }
        if (confidenceScore < RULES.confidence.levelCutoffs.possible) {
          missingInfo.push({ type: 'confidence', message: 'Low confidence \u2014 additional details about parents or locations would help.' });
        }

        // Update ancestor in DB
        const existingRaw = rec.raw_data || {};
        this.db.updateAncestorByAscNumber(this.jobId, asc, {
          confidence_score: confidenceScore,
          confidence_level: confidenceLevel,
          confidence: confidenceLevel.toLowerCase(),
          evidence_chain: sourceResult.evidenceChain,
          verification_notes: verificationNotes,
          raw_data: { ...existingRaw, scoring_breakdown: scoringBreakdown },
          accepted: autoAccepted,
          missing_info: missingInfo,
        });

        // Store in scored map for downstream parents
        scoredAncestors.set(asc, {
          score: confidenceScore, level: confidenceLevel,
          name: rec.name, surname: parseNameParts(rec.name).surname,
          birthPlace: rec.birth_place || '', birthDate: rec.birth_date || '',
          allPlaces: resolvedPlace, // resolved location for child comparisons
        });

        console.log(`[Engine] asc#${asc}: ${rec.name} — ${totalPoints}pts → ${confidenceLevel} ${confidenceScore}% (src=${sourceResult.points} fact=${factResult.points} fam=${familyResult.points} loc=${locationResult.points})`);
      }

      // ── Complete ──
      const ancestors = this.db.getAncestors(this.jobId);
      const verified = ancestors.filter(a => a.confidence_level === 'Verified' || a.confidence_level === 'Customer Data').length;
      const probable = ancestors.filter(a => a.confidence_level === 'Probable').length;
      const possible = ancestors.filter(a => a.confidence_level === 'Possible').length;
      const suggested = ancestors.filter(a => a.confidence_level === 'Suggested').length;

      // Refund-guarantee tracking: the site promises "at least 3 generations of
      // ancestors" or a refund. Compute the deepest generation where every slot
      // is filled to export quality (Possible-or-better, or customer data).
      const byAscMap = new Map(ancestors.map(a => [a.ascendancy_number, a]));
      const solid = (a) => a && (a.confidence_score >= RULES.export.minConfidencePercent || a.confidence_level === 'Customer Data');
      let generationsComplete = 0;
      for (let g = 1; g <= this.generations; g++) {
        let allSolid = true;
        for (let asc = Math.pow(2, g); asc < Math.pow(2, g + 1); asc++) {
          if (!solid(byAscMap.get(asc))) { allSolid = false; break; }
        }
        if (!allSolid) break;
        generationsComplete = g;
      }
      const guaranteeMet = generationsComplete >= 3;

      this.db.updateResearchJob(this.jobId, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        results: {
          total_ancestors: ancestors.length,
          verified,
          probable,
          possible,
          suggested,
          generations_complete: generationsComplete,
          guarantee_met: guaranteeMet,
        },
      });
      if (!guaranteeMet) {
        console.log(`[Engine] ⚠ GUARANTEE: only ${generationsComplete} complete generation(s) — below the 3-generation refund promise`);
      }
      this.db.updateJobProgress(this.jobId, 'Research complete', ancestors.length, ancestors.length);

      console.log(`\n[Engine] ════════════════════════════════════════════════`);
      console.log(`[Engine] COMPLETE: ${ancestors.length} ancestors`);
      console.log(`[Engine] Verified/Customer: ${verified}, Probable: ${probable}, Possible: ${possible}, Suggested: ${suggested}`);
      console.log(`[Engine] ════════════════════════════════════════════════\n`);

      // ── Phase 4: AI Review Pipeline (fire-and-forget) ──
      const aiReviewer = require('./ai-reviewer');
      const openaiAvail = require('./openai-client').isAvailable();
      const claudeAvail = require('./claude-client').isAvailable();
      if (openaiAvail || claudeAvail) {
        console.log(`[Engine] ── Phase 4: AI Review Pipeline ──`);
        console.log(`[Engine] GPT-4o: ${openaiAvail ? 'YES' : 'NO'}, Claude: ${claudeAvail ? 'YES' : 'NO'}`);
        // Run async — don't block the completed status
        aiReviewer.runFullReview(this.jobId).then(result => {
          if (result.success) {
            console.log(`[Engine] AI review completed successfully`);
          } else {
            console.log(`[Engine] AI review failed: ${result.error}`);
          }
        }).catch(err => {
          console.error(`[Engine] AI review error: ${err.message}`);
        });
      } else {
        console.log(`[Engine] No AI API keys configured — skipping Phase 4`);
      }

    } catch (err) {
      console.error(`Research engine error for job ${this.jobId}:`, err);
      this.db.updateResearchJob(this.jobId, {
        status: 'failed',
        error_message: err.message,
      });
    }
  }

}

module.exports = { ResearchEngine, parseNotesForAnchors, parseNameParts };
