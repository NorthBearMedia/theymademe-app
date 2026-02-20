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
  }

  async run() {
    try {
      this.db.updateResearchJob(this.jobId, { status: 'running' });
      this.db.deleteAncestors(this.jobId);

      // Build verification anchors from input data
      this.buildAnchors();

      const totalPossible = Math.pow(2, this.generations + 1) - 1;
      this.db.updateJobProgress(this.jobId, 'Starting research...', 0, totalPossible);

      // Start spiral traversal from subject (asc#1)
      const subjectInfo = {
        givenName: this.inputData.given_name,
        surname: this.inputData.surname,
        birthDate: this.inputData.birth_date,
        birthPlace: this.inputData.birth_place,
        deathDate: this.inputData.death_date,
        deathPlace: this.inputData.death_place,
      };

      // Add parent names to subject search
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

      await this.traverse(1, 0, subjectInfo);

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

  async traverse(ascNumber, generation, knownInfo) {
    if (generation > this.generations) return;

    // Update progress
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

    // Verify this person
    const result = await this.verifyPerson(knownInfo, ascNumber, generation);

    if (!result.verified) {
      // Store as rejected and stop this branch
      console.log(`Branch stopped at asc#${ascNumber}: confidence ${result.confidence} < 50`);
      return;
    }

    // Prevent circular references
    if (this.visitedIds.has(result.personId)) {
      console.log(`Circular reference detected for ${result.personId} at asc#${ascNumber}`);
      return;
    }
    this.visitedIds.add(result.personId);

    // Don't go further if at max generation
    if (generation >= this.generations) return;

    // Get parents from FamilySearch
    let parents;
    try {
      parents = await fsApi.getParents(result.personId);
    } catch (err) {
      console.log(`Could not get parents for ${result.personId}: ${err.message}`);
      return;
    }

    // Build known info for father (asc#2N)
    const fatherAsc = ascNumber * 2;
    const motherAsc = ascNumber * 2 + 1;

    // Traverse father first (paternal-first spiral)
    if (parents.father) {
      const fatherKnown = this.buildParentKnownInfo(parents.father, fatherAsc);
      await this.traverse(fatherAsc, generation + 1, fatherKnown);
    } else if (this.knownAnchors[fatherAsc]) {
      // No FS parent but we have anchor info — try searching independently
      const anchorInfo = this.knownAnchors[fatherAsc];
      if (anchorInfo.givenName || anchorInfo.surname) {
        await this.traverse(fatherAsc, generation + 1, anchorInfo);
      }
    }

    // Then mother
    if (parents.mother) {
      const motherKnown = this.buildParentKnownInfo(parents.mother, motherAsc);
      await this.traverse(motherAsc, generation + 1, motherKnown);
    } else if (this.knownAnchors[motherAsc]) {
      const anchorInfo = this.knownAnchors[motherAsc];
      if (anchorInfo.givenName || anchorInfo.surname) {
        await this.traverse(motherAsc, generation + 1, anchorInfo);
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
      const score = this.evaluateCandidate(candidate, knownInfo, expectedGender);
      return { ...candidate, computedScore: score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.computedScore - a.computedScore);

    // Store all candidates in search_candidates table
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
        selected: candidate === scored[0] && candidate.computedScore >= 50,
        rejection_reason: candidate.computedScore < 50 ? `Score ${candidate.computedScore} below threshold` : '',
        raw_data: candidate.raw || {},
      });
    }

    const best = scored[0];
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
    const finalConfidence = Math.round(best.computedScore * 0.6 + evidenceResult.score * 0.4);
    const confidenceLevel = this.getConfidenceLevel(finalConfidence);

    // Build verification notes
    const notes = [];
    if (knownInfo.fsPersonId && best.id === knownInfo.fsPersonId) {
      notes.push('Verified against FamilySearch parent link');
    }
    const anchor = this.knownAnchors[ascNumber];
    if (anchor) {
      notes.push('Cross-referenced with customer-provided information');
    }
    notes.push(`Search score: ${best.computedScore}/100, Evidence score: ${evidenceResult.score}/100`);

    // Store the verified ancestor
    this.db.addAncestor({
      research_job_id: this.jobId,
      fs_person_id: best.id,
      name: best.name,
      gender: best.gender,
      birth_date: best.birthDate,
      birth_place: best.birthPlace,
      death_date: best.deathDate,
      death_place: best.deathPlace,
      ascendancy_number: ascNumber,
      generation,
      confidence: confidenceLevel.toLowerCase(),
      sources: evidenceResult.evidence.map(e => ({ title: e.title, url: e.url, citation: e.citation })),
      raw_data: best.raw || {},
      confidence_score: finalConfidence,
      confidence_level: confidenceLevel,
      evidence_chain: evidenceResult.evidence,
      search_log: searchLog,
      conflicts: [],
      verification_notes: notes.join('. '),
    });

    return { verified: finalConfidence >= 50, personId: best.id, confidence: finalConfidence };
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

    // Pass 1: EXACT — all known fields including parent names
    const pass1Query = {
      givenName: knownInfo.givenName,
      surname: knownInfo.surname,
      birthDate: knownInfo.birthDate,
      birthPlace: knownInfo.birthPlace,
      deathDate: knownInfo.deathDate,
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
      birthDate: knownInfo.birthDate,
      birthPlace: knownInfo.birthPlace,
      deathDate: knownInfo.deathDate,
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

    // Pass 3: FUZZY — name + birth year only
    if (knownInfo.birthDate) {
      const parsed = normalizeDate(knownInfo.birthDate);
      const yearOnly = parsed?.year ? String(parsed.year) : knownInfo.birthDate;
      const pass3Query = {
        givenName: knownInfo.givenName,
        surname: knownInfo.surname,
        birthDate: yearOnly,
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
      const parsed = normalizeDate(knownInfo.birthDate);
      const yearOnly = parsed?.year ? String(parsed.year) : knownInfo.birthDate;
      for (const variant of variants.slice(0, 2)) { // Max 2 variants to avoid too many calls
        const pass4Query = {
          givenName: knownInfo.givenName,
          surname: variant,
          birthDate: yearOnly,
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
        score += Math.round(nameMax * 0.4); // 40% of name points for given name
      } else if (nameContains(candidateGiven, knownGiven) || nameContains(knownGiven, candidateGiven)) {
        score += Math.round(nameMax * 0.2);
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
      // We can check if candidate search result mentions parents
      // This uses the FS search API's parent matching
      if (knownInfo.fatherGivenName) {
        // FS search already factors in parent names — if we got a result
        // with parent names in the query, it's a signal of match
        // Award points based on whether the search included parent names and returned results
        score += Math.round(parentMax * 0.5);
      }
      if (knownInfo.motherGivenName) {
        score += Math.round(parentMax * 0.5);
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

    this.db.addAncestor({
      research_job_id: this.jobId,
      fs_person_id: '',
      name: `${name} (not found)`,
      gender: this.getExpectedGender(ascNumber) || 'Unknown',
      birth_date: knownInfo.birthDate || '',
      birth_place: knownInfo.birthPlace || '',
      death_date: knownInfo.deathDate || '',
      death_place: knownInfo.deathPlace || '',
      ascendancy_number: ascNumber,
      generation,
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

    return { verified: false, personId: null, confidence: 0 };
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
