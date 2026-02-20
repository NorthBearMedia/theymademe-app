const fsApi = require('./familysearch-api');

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

  // Pattern: "paternal grandfather: Name" or "grandfather was Name"
  const pgMatch = notes.match(/(?:paternal\s+)?grandfather\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:,|\.|born|from|$)/i);
  if (pgMatch) {
    anchors[4] = { ...parseNameParts(pgMatch[1].trim()) }; // asc#4 = paternal grandfather
  }

  const pgmMatch = notes.match(/(?:paternal\s+)?grandmother\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:,|\.|born|from|$)/i);
  if (pgmMatch) {
    anchors[5] = { ...parseNameParts(pgmMatch[1].trim()) }; // asc#5 = paternal grandmother
  }

  const mgMatch = notes.match(/maternal\s+grandfather\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:,|\.|born|from|$)/i);
  if (mgMatch) {
    anchors[6] = { ...parseNameParts(mgMatch[1].trim()) }; // asc#6 = maternal grandfather
  }

  const mgmMatch = notes.match(/maternal\s+grandmother\s*(?:was|:|-)\s*([A-Z][a-zA-Z\s]+?)(?:,|\.|born|from|$)/i);
  if (mgmMatch) {
    anchors[7] = { ...parseNameParts(mgmMatch[1].trim()) }; // asc#7 = maternal grandmother
  }

  // Extract dates near ancestor mentions
  const datePattern = /born\s+(?:(?:on|in)\s+)?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}|[A-Z][a-z]+\s+\d{4})/gi;
  let dateMatch;
  while ((dateMatch = datePattern.exec(notes)) !== null) {
    // Associate with nearest ancestor if context allows
    const context = notes.substring(Math.max(0, dateMatch.index - 50), dateMatch.index);
    for (const [asc, anchor] of Object.entries(anchors)) {
      if (anchor.surname && context.toLowerCase().includes(anchor.surname.toLowerCase())) {
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
  constructor(db, jobId, inputData, generations) {
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
      }
      if (motherFsId) {
        console.log(`[Engine] Traversing mother's parents from ${motherFsId}`);
        await this.traverseParents(motherFsId, 3, 1);
      }
      // Also traverse subject's FS parents (may discover parents not provided by customer)
      if (subjectFsId) {
        console.log(`[Engine] Traversing subject's FS parents from ${subjectFsId}`);
        await this.traverseParents(subjectFsId, 1, 0);
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
    this.db.updateJobProgress(
      this.jobId,
      `Looking up ${name} in FamilySearch (generation ${generation})`,
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

    // Use a lower threshold (40) for enrichment — we're not verifying, just linking
    if (best.computedScore < 40) {
      console.log(`[Engine] asc#${ascNumber}: best score ${best.computedScore} too low for FS link — keeping customer data`);
      this.db.updateAncestorByAscNumber(this.jobId, ascNumber, {
        verification_notes: `Customer-provided data — best FS match "${best.name}" scored ${best.computedScore}/100 (too low to link)`,
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
    if (!existing.birth_date && best.birthDate) enrichData.birth_date = best.birthDate;
    if (!existing.birth_place && best.birthPlace) enrichData.birth_place = sanitizePlaceName(best.birthPlace);
    if (!existing.death_date && best.deathDate) enrichData.death_date = best.deathDate;
    if (!existing.death_place && best.deathPlace) enrichData.death_place = sanitizePlaceName(best.deathPlace);
    if (existing.gender === 'Unknown' && best.gender && best.gender !== 'Unknown') enrichData.gender = best.gender;

    this.db.updateAncestorByAscNumber(this.jobId, ascNumber, enrichData);
    console.log(`[Engine] asc#${ascNumber}: enriched with FS ID ${best.id} — confidence stays at 100%`);

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
    try {
      parents = await fsApi.getParents(personId);
      // Mark getParents results as tree-sourced (they're linked in FS tree)
      if (parents.father) parents.father._fromTree = true;
      if (parents.mother) parents.mother._fromTree = true;
      console.log(`[Traverse] Parents for ${personId}: father=${parents.father?.id || 'none'}, mother=${parents.mother?.id || 'none'}`);
    } catch (err) {
      console.log(`Could not get parents for ${personId}: ${err.message}`);
      parents = { father: null, mother: null };
    }

    // Fallback 1: If getParents returned nothing, try the ancestry/pedigree endpoint
    if (!parents.father && !parents.mother) {
      try {
        console.log(`[Traverse] getParents empty — trying ancestry endpoint for ${personId}`);
        const ancestry = await fsApi.getAncestry(personId, 1);
        for (const p of ancestry) {
          const ascNum = p.ascendancy_number;
          if (ascNum === 2 && !parents.father) {
            parents.father = {
              id: p.fs_person_id,
              name: p.name,
              gender: p.gender || 'Male',
              birthDate: p.birthDate || '',
              birthPlace: p.birthPlace || '',
              deathDate: p.deathDate || '',
              deathPlace: p.deathPlace || '',
              _fromTree: true, // Linked in FS tree
            };
            console.log(`[Traverse] Ancestry found father: ${p.name} (${p.fs_person_id})`);
          }
          if (ascNum === 3 && !parents.mother) {
            parents.mother = {
              id: p.fs_person_id,
              name: p.name,
              gender: p.gender || 'Female',
              birthDate: p.birthDate || '',
              birthPlace: p.birthPlace || '',
              deathDate: p.deathDate || '',
              deathPlace: p.deathPlace || '',
              _fromTree: true, // Linked in FS tree
            };
            console.log(`[Traverse] Ancestry found mother: ${p.name} (${p.fs_person_id})`);
          }
        }
      } catch (err) {
        console.log(`[Traverse] Ancestry endpoint also failed for ${personId}: ${err.message}`);
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

        // Search for father
        if (fatherAnchor?.givenName || childSurname) {
          const fatherSearch = {
            givenName: fatherAnchor?.givenName || '',
            surname: fatherAnchor?.surname || childSurname,
            birthDate: fatherAnchor?.birthDate || estimatedParentBirth || '',
            birthPlace: fatherAnchor?.birthPlace || childRecord.birth_place || '',
          };
          console.log(`[Traverse] Searching for father: ${fatherSearch.givenName} ${fatherSearch.surname}`);
          try {
            const results = await fsApi.searchPerson({ ...fatherSearch, count: 5 });
            if (results.length > 0) {
              const expectedGender = 'Male';
              const scored = results.map(c => ({
                ...c,
                computedScore: this.evaluateCandidate(c, fatherSearch, expectedGender),
              }));
              scored.sort((a, b) => b.computedScore - a.computedScore);
              if (scored[0].computedScore >= 50) {
                parents.father = {
                  id: scored[0].id,
                  name: scored[0].name,
                  gender: scored[0].gender || 'Male',
                  birthDate: scored[0].birthDate || '',
                  birthPlace: scored[0].birthPlace || '',
                  deathDate: scored[0].deathDate || '',
                  deathPlace: scored[0].deathPlace || '',
                };
                console.log(`[Traverse] Search found father: ${scored[0].name} (${scored[0].id}) score=${scored[0].computedScore}`);
              }
            }
          } catch (err) {
            console.log(`[Traverse] Father search failed: ${err.message}`);
          }
        }

        // Search for mother
        if (motherAnchor?.givenName || motherAnchor?.surname) {
          const motherSearch = {
            givenName: motherAnchor?.givenName || '',
            surname: motherAnchor?.surname || '',
            birthDate: motherAnchor?.birthDate || estimatedParentBirth || '',
            birthPlace: motherAnchor?.birthPlace || childRecord.birth_place || '',
          };
          console.log(`[Traverse] Searching for mother: ${motherSearch.givenName} ${motherSearch.surname}`);
          try {
            const results = await fsApi.searchPerson({ ...motherSearch, count: 5 });
            if (results.length > 0) {
              const expectedGender = 'Female';
              const scored = results.map(c => ({
                ...c,
                computedScore: this.evaluateCandidate(c, motherSearch, expectedGender),
              }));
              scored.sort((a, b) => b.computedScore - a.computedScore);
              if (scored[0].computedScore >= 50) {
                parents.mother = {
                  id: scored[0].id,
                  name: scored[0].name,
                  gender: scored[0].gender || 'Female',
                  birthDate: scored[0].birthDate || '',
                  birthPlace: scored[0].birthPlace || '',
                  deathDate: scored[0].deathDate || '',
                  deathPlace: scored[0].deathPlace || '',
                };
                console.log(`[Traverse] Search found mother: ${scored[0].name} (${scored[0].id}) score=${scored[0].computedScore}`);
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
        // Update pre-populated record with FS data
        const fResult = await this.verifyAndUpdate(fatherAsc, nextGen, fatherKnown);
        if (fResult.verified && fResult.personId) {
          await this.traverseParents(fResult.personId, fatherAsc, nextGen);
        }
      }
    } else if (this.knownAnchors[fatherAsc] && nextGen <= this.generations) {
      const anchorInfo = this.knownAnchors[fatherAsc];
      if (anchorInfo.givenName || anchorInfo.surname) {
        const fResult = await this.verifyAndUpdate(fatherAsc, nextGen, anchorInfo);
        if (fResult.verified && fResult.personId) {
          await this.traverseParents(fResult.personId, fatherAsc, nextGen);
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
        const mResult = await this.verifyAndUpdate(motherAsc, nextGen, motherKnown);
        if (mResult.verified && mResult.personId) {
          await this.traverseParents(mResult.personId, motherAsc, nextGen);
        }
      }
    } else if (this.knownAnchors[motherAsc] && nextGen <= this.generations) {
      const anchorInfo = this.knownAnchors[motherAsc];
      if (anchorInfo.givenName || anchorInfo.surname) {
        const mResult = await this.verifyAndUpdate(motherAsc, nextGen, anchorInfo);
        if (mResult.verified && mResult.personId) {
          await this.traverseParents(mResult.personId, motherAsc, nextGen);
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

    return knownInfo;
  }

  storeOrUpdateAncestor(ascNumber, generation, data) {
    const existing = this.db.getAncestorByAscNumber(this.jobId, ascNumber);
    if (existing) {
      // Update existing record (e.g., pre-populated customer data → verified FS data)
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

      // Tree-link bonus: if this candidate came from FS's own tree (getParents/ancestry)
      // and matches the expected person ID, they're already linked as a parent in the tree.
      // This is strong structural evidence worth a significant bonus.
      if (knownInfo.fromFsTree && knownInfo.fsPersonId && candidate.id === knownInfo.fsPersonId) {
        const bonus = 30;
        score = Math.min(100, score + bonus);
        console.log(`[Score] asc#${ascNumber}: Tree-link bonus +${bonus} for ${candidate.name} (${candidate.id}) → ${score}`);
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
      } else if (candidate.computedScore < 50) {
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
        selected: candidate === scored[0] && candidate.computedScore >= 50 && !candidate.blacklisted,
        rejection_reason: rejReason,
        raw_data: candidate.raw || {},
      });
    }

    const best = scored[0];
    console.log(`[Score] asc#${ascNumber}: ${scored.length} candidates. Best: "${best.name}" score=${best.computedScore}, FS score=${best.score}`);
    if (scored.length > 1) {
      console.log(`[Score] asc#${ascNumber}: Runner-up: "${scored[1].name}" score=${scored[1].computedScore}`);
    }

    if (best.computedScore < 50) {
      return this.storeRejected(ascNumber, generation, knownInfo, searchLog,
        `Best candidate score ${best.computedScore} below threshold of 50`);
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

    // Tree-linked parents: the tree relationship itself is evidence.
    // Don't let low evidence scores drag down a tree-linked match.
    if (knownInfo.fromFsTree && knownInfo.fsPersonId && best.id === knownInfo.fsPersonId) {
      const treeFloor = Math.round(best.computedScore * 0.85);
      if (treeFloor > finalConfidence) {
        finalConfidence = treeFloor;
      }
    }

    const confidenceLevel = this.getConfidenceLevel(finalConfidence);

    // Build verification notes
    const notes = [];
    if (knownInfo.fromFsTree && knownInfo.fsPersonId && best.id === knownInfo.fsPersonId) {
      notes.push('Linked in FamilySearch tree (parent relationship) — high trust');
    } else if (knownInfo.fsPersonId && best.id === knownInfo.fsPersonId) {
      notes.push('Verified against FamilySearch parent link');
    }
    const anchor = this.knownAnchors[ascNumber];
    if (anchor) {
      notes.push('Cross-referenced with customer-provided information');
    }
    notes.push(`Search score: ${best.computedScore}/100, Evidence score: ${evidenceResult.score}/100`);

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
    };

    this.storeOrUpdateAncestor(ascNumber, generation, ancestorData);

    return { verified: finalConfidence >= 50, personId: best.id, confidence: finalConfidence, searchLog };
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

    return allCandidates;
  }

  evaluateCandidate(candidate, knownInfo, expectedGender) {
    let score = 0;
    const hasParentInfo = !!(knownInfo.fatherGivenName || knownInfo.motherGivenName);

    // Determine point redistribution when parent names are unknown
    // Normal: name=25, date=25, place=20, parent=20, gender=10
    // No parents known: name=32, date=32, place=26, gender=10
    const nameMax = hasParentInfo ? 25 : 32;
    const dateMax = hasParentInfo ? 25 : 32;
    const placeMax = hasParentInfo ? 20 : 26;
    const parentMax = 20;
    const genderMax = 10;

    // NAME MATCH (up to nameMax)
    const candidateSurname = normalizeName(parseNameParts(candidate.name).surname);
    const knownSurname = normalizeName(knownInfo.surname);
    const candidateGiven = normalizeName(parseNameParts(candidate.name).givenName);
    const knownGiven = normalizeName(knownInfo.givenName);

    if (knownSurname) {
      if (candidateSurname === knownSurname) {
        score += Math.round(nameMax * 0.6); // 60% of name points for surname
      } else if (candidateSurname.includes(knownSurname) || knownSurname.includes(candidateSurname)) {
        score += Math.round(nameMax * 0.32);
      }
    }

    if (knownGiven) {
      if (candidateGiven === knownGiven) {
        score += Math.round(nameMax * 0.4); // 40% of name points for full given name match
      } else {
        // Check first given name specifically (most important for identity)
        const candidateFirst = candidateGiven.split(' ')[0] || '';
        const knownFirst = knownGiven.split(' ')[0] || '';
        if (candidateFirst && knownFirst && candidateFirst === knownFirst) {
          // First names match — check for initial matching on subsequent names
          // e.g., "alan l" vs "alan lance" — "l" matches start of "lance"
          const candidateRest = candidateGiven.split(' ').slice(1);
          const knownRest = knownGiven.split(' ').slice(1);
          const initialMatch = candidateRest.length > 0 && knownRest.length > 0 &&
            candidateRest.every((cp, i) => {
              if (!knownRest[i]) return false;
              return cp === knownRest[i] || (cp.length === 1 && knownRest[i].startsWith(cp)) ||
                     (knownRest[i].length === 1 && cp.startsWith(knownRest[i]));
            });
          if (initialMatch) {
            score += Math.round(nameMax * 0.38); // Near-full given name match (first + initials)
          } else if (candidateRest.length > 0 && knownRest.length > 0 &&
                     candidateRest[0].length > 1 && knownRest[0].length > 1 &&
                     candidateRest[0] !== knownRest[0]) {
            // Explicit middle name conflict (e.g., "Janet Ruth" vs "Janet Mary")
            score += Math.round(nameMax * 0.15);
          } else {
            score += Math.round(nameMax * 0.3); // First name exact match, no middle name conflict
          }
        } else if (isNameVariant(candidateGiven, knownGiven)) {
          score += Math.round(nameMax * 0.25); // Nickname/variant match (e.g., William→Bill)
        } else if (nameContains(candidateGiven, knownGiven) || nameContains(knownGiven, candidateGiven)) {
          score += Math.round(nameMax * 0.12); // Partial — shared names but different order/first name
        }
      }
    }

    // DATE MATCH (up to dateMax)
    const candidateBirth = normalizeDate(candidate.birthDate);
    const knownBirth = normalizeDate(knownInfo.birthDate);
    const birthDiff = yearDiff(candidateBirth, knownBirth);

    if (birthDiff !== null) {
      if (birthDiff === 0) score += Math.round(dateMax * 0.6);
      else if (birthDiff <= 2) score += Math.round(dateMax * 0.4);
      else if (birthDiff <= 5) score += Math.round(dateMax * 0.2);
    }

    const candidateDeath = normalizeDate(candidate.deathDate);
    const knownDeath = normalizeDate(knownInfo.deathDate);
    const deathDiff = yearDiff(candidateDeath, knownDeath);

    if (deathDiff !== null) {
      if (deathDiff === 0) score += Math.round(dateMax * 0.4);
      else if (deathDiff <= 2) score += Math.round(dateMax * 0.28);
      else if (deathDiff <= 5) score += Math.round(dateMax * 0.12);
    }

    // PLACE MATCH (up to placeMax)
    if (knownInfo.birthPlace) {
      if (placeContains(candidate.birthPlace, knownInfo.birthPlace)) {
        // Check if it's an exact match or partial
        const cPlace = (candidate.birthPlace || '').toLowerCase();
        const kPlace = knownInfo.birthPlace.toLowerCase();
        if (cPlace.includes(kPlace) || kPlace.includes(cPlace)) {
          score += Math.round(placeMax * 0.6);
        } else {
          score += Math.round(placeMax * 0.35);
        }
      }
    }

    if (knownInfo.deathPlace && candidate.deathPlace) {
      if (placeContains(candidate.deathPlace, knownInfo.deathPlace)) {
        score += Math.round(placeMax * 0.4);
      }
    }

    // PARENT MATCH (up to parentMax, only if parent info is known)
    if (hasParentInfo) {
      // Check candidate's parent names against known parent names
      // The candidate.raw may have parent info from the search result's relationships
      const fatherDisplay = candidate.fatherName || '';
      const motherDisplay = candidate.motherName || '';

      if (knownInfo.fatherGivenName || knownInfo.fatherSurname) {
        const knownFather = normalizeName(`${knownInfo.fatherGivenName || ''} ${knownInfo.fatherSurname || ''}`);
        if (fatherDisplay && nameContains(fatherDisplay, knownFather)) {
          score += Math.round(parentMax * 0.5);
        } else if (candidate.searchPass === 1 && fatherDisplay === '') {
          // Pass 1 included parent names in query — FS already filtered by parent match
          // Give partial credit
          score += Math.round(parentMax * 0.25);
        }
      }

      if (knownInfo.motherGivenName || knownInfo.motherSurname) {
        const knownMother = normalizeName(`${knownInfo.motherGivenName || ''} ${knownInfo.motherSurname || ''}`);
        if (motherDisplay && nameContains(motherDisplay, knownMother)) {
          score += Math.round(parentMax * 0.5);
        } else if (candidate.searchPass === 1 && motherDisplay === '') {
          score += Math.round(parentMax * 0.25);
        }
      }
    }

    // GENDER MATCH (up to genderMax)
    if (expectedGender) {
      const candidateGender = (candidate.gender || '').toLowerCase();
      if (candidateGender === expectedGender.toLowerCase()) {
        score += genderMax;
      } else if (candidateGender && candidateGender !== 'unknown') {
        score -= 20; // Hard penalty for wrong gender
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  getExpectedGender(ascNumber) {
    if (ascNumber === 1) return null; // Subject can be any gender
    return ascNumber % 2 === 0 ? 'Male' : 'Female';
  }

  getConfidenceLevel(score) {
    if (score >= 90) return 'Verified';
    if (score >= 75) return 'Probable';
    if (score >= 50) return 'Possible';
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

module.exports = { ResearchEngine };
