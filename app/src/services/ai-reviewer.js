/**
 * They Made Me — AI Review Pipeline Orchestrator
 *
 * Phase 4 of the research process:
 * 1. FreeBMD cross-reference (independent civil registration confirmation)
 * 2. GPT-4o review (AI analysis of tree data)
 * 3. Claude Sonnet review (independent second AI opinion)
 *
 * Both AI models receive the same structured input and produce
 * per-ancestor flags, confidence adjustments, and manual lookup suggestions.
 */

const db = require('./database');
const openaiClient = require('./openai-client');
const claudeClient = require('./claude-client');
const { FreeBMDClient } = require('./freebmd-client');

const freebmd = new FreeBMDClient();

// ─── Ahnentafel helpers ─────────────────────────────────────────────

function ascRole(asc) {
  if (asc === 1) return 'Subject';
  if (asc === 2) return 'Father';
  if (asc === 3) return 'Mother';
  const gen = Math.floor(Math.log2(asc));
  const labels = {
    2: asc % 2 === 0 ? 'Grandfather' : 'Grandmother',
    3: asc % 2 === 0 ? 'Great-Grandfather' : 'Great-Grandmother',
    4: asc % 2 === 0 ? '2x Great-Grandfather' : '2x Great-Grandmother',
    5: asc % 2 === 0 ? '3x Great-Grandfather' : '3x Great-Grandmother',
  };
  let role = labels[gen] || (asc % 2 === 0 ? `${gen-1}x Great-Grandfather` : `${gen-1}x Great-Grandmother`);

  // Build lineage path
  const path = [];
  let n = asc;
  while (n > 1) {
    path.unshift(n % 2 === 0 ? 'father' : 'mother');
    n = Math.floor(n / 2);
  }
  return `${role} (${path.join(' → ')})`;
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
  return m ? parseInt(m[1]) : null;
}

function parentAsc(asc) {
  return { father: asc * 2, mother: asc * 2 + 1 };
}

// ─── FreeBMD Cross-Reference ────────────────────────────────────────

/**
 * Cross-reference each ancestor against FreeBMD civil registration indexes.
 * FreeBMD covers England & Wales BMD records 1837-1983.
 */
async function runFreeBMDCrossReference(jobId) {
  const ancestors = db.getAncestors(jobId);
  const total = ancestors.length;
  let processed = 0;

  console.log(`[AI-Review] FreeBMD cross-reference: ${total} ancestors`);
  db.updateJobProgress(jobId, 'FreeBMD cross-reference...', 0, total);

  for (const anc of ancestors) {
    if (anc.ascendancy_number === 1) {
      // Skip the subject — they're the customer, not a historical person
      processed++;
      continue;
    }

    const birthYear = extractYear(anc.birth_date);
    const deathYear = extractYear(anc.death_date);
    const results = { birth: null, death: null, marriage: null };

    // Only search FreeBMD for post-1837 UK ancestors
    const tooEarly = birthYear && birthYear < 1837;
    if (tooEarly) {
      results.note = 'Pre-1837: outside FreeBMD civil registration range';
      db.updateAncestorByAscNumber(jobId, anc.ascendancy_number, {
        freebmd_results: results,
      });
      processed++;
      db.updateJobProgress(jobId, `FreeBMD: ${anc.name}...`, processed, total);
      continue;
    }

    const nameParts = (anc.name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts[nameParts.length - 1] || '';

    // Birth confirmation
    if (birthYear && firstName && lastName) {
      try {
        const birthMatch = await freebmd.confirmBirth(
          firstName, lastName, birthYear, anc.birth_place || ''
        );
        if (birthMatch) {
          results.birth = {
            matched: true,
            entry: birthMatch.display || `${birthMatch.forenames} ${birthMatch.surname}, Q${birthMatch.quarter + 1} ${birthMatch.year}, ${birthMatch.district}`,
            year: birthMatch.year,
            quarter: birthMatch.quarter,
            district: birthMatch.district,
          };
        } else {
          results.birth = { matched: false, searched: `${firstName} ${lastName} ~${birthYear}` };
        }
      } catch (e) {
        console.log(`[AI-Review] FreeBMD birth error for ${anc.name}: ${e.message}`);
        results.birth = { matched: false, error: e.message };
      }
    }

    // Death confirmation
    if (deathYear && firstName && lastName) {
      try {
        const deathMatch = await freebmd.confirmDeath(firstName, lastName, deathYear);
        if (deathMatch) {
          results.death = {
            matched: true,
            entry: deathMatch.display || `${deathMatch.forenames} ${deathMatch.surname}, Q${deathMatch.quarter + 1} ${deathMatch.year}, ${deathMatch.district}`,
            year: deathMatch.year,
            quarter: deathMatch.quarter,
            district: deathMatch.district,
          };
        } else {
          results.death = { matched: false, searched: `${firstName} ${lastName} ~${deathYear}` };
        }
      } catch (e) {
        console.log(`[AI-Review] FreeBMD death error for ${anc.name}: ${e.message}`);
        results.death = { matched: false, error: e.message };
      }
    }

    // Marriage — check if we have spouse info from child record
    // Parent at asc N married parent at asc N^1 (XOR last bit)
    const spouseAsc = anc.ascendancy_number % 2 === 0
      ? anc.ascendancy_number + 1   // father's spouse = mother
      : anc.ascendancy_number - 1;  // mother's spouse = father
    const spouse = ancestors.find(a => a.ascendancy_number === spouseAsc);

    if (spouse && birthYear) {
      const spouseLastName = (spouse.name || '').split(' ').pop();
      try {
        const marriageMatch = await freebmd.findMarriage(
          lastName, firstName, spouseLastName,
          Math.max(birthYear + 16, (extractYear(spouse.birth_date) || birthYear) + 16),
          Math.min(birthYear + 45, deathYear || birthYear + 45),
          ''
        );
        if (marriageMatch) {
          results.marriage = {
            matched: true,
            entry: marriageMatch.display || `${marriageMatch.forenames} ${marriageMatch.surname} / ${marriageMatch.spouseSurname}, Q${marriageMatch.quarter + 1} ${marriageMatch.year}, ${marriageMatch.district}`,
            year: marriageMatch.year,
            district: marriageMatch.district,
            spouseSurname: marriageMatch.spouseSurname,
          };
        } else {
          results.marriage = { matched: false, searched: `${lastName} / ${spouseLastName}` };
        }
      } catch (e) {
        console.log(`[AI-Review] FreeBMD marriage error for ${anc.name}: ${e.message}`);
        results.marriage = { matched: false, error: e.message };
      }
    }

    db.updateAncestorByAscNumber(jobId, anc.ascendancy_number, {
      freebmd_results: results,
    });

    processed++;
    db.updateJobProgress(jobId, `FreeBMD: ${anc.name}...`, processed, total);
  }

  console.log(`[AI-Review] FreeBMD cross-reference complete`);
}

// ─── Build AI Input Payload ─────────────────────────────────────────

/**
 * Assemble structured payload for AI review.
 * Includes all found ancestors, their evidence, FreeBMD results,
 * and empty slots for missing ancestors.
 */
function buildAIInput(jobId) {
  const job = db.getResearchJob(jobId);
  const ancestors = db.getAncestors(jobId);

  // Build ancestor map by asc number
  const byAsc = {};
  for (const a of ancestors) byAsc[a.ascendancy_number] = a;

  // Calculate expected slots based on generations
  const maxAsc = Math.pow(2, job.generations) - 1;
  const ancestorEntries = [];
  const emptySlots = [];

  for (let asc = 1; asc <= maxAsc; asc++) {
    const a = byAsc[asc];
    if (a) {
      ancestorEntries.push({
        asc: a.ascendancy_number,
        role: ascRole(a.ascendancy_number),
        name: a.name,
        gender: a.gender,
        birth_date: a.birth_date || null,
        birth_place: a.birth_place || null,
        death_date: a.death_date || null,
        death_place: a.death_place || null,
        confidence_score: a.confidence_score,
        confidence_level: a.confidence_level,
        fs_person_id: a.fs_person_id,
        evidence_chain: a.evidence_chain || [],
        freebmd: a.freebmd_results || {},
        source_count: (a.sources || []).length,
        discovery_method: a.raw_data?.discovery_method || 'unknown',
      });
    } else if (asc > 1) {
      // Check if parent slot is expected (i.e. the child exists)
      const childAsc = Math.floor(asc / 2);
      if (byAsc[childAsc]) {
        emptySlots.push({
          asc,
          role: ascRole(asc),
          expected_parent_of: byAsc[childAsc].name,
          expected_parent_of_asc: childAsc,
        });
      }
    }
  }

  // ── Learning Memory: fetch relevant admin feedback ──
  const surnames = [...new Set(ancestors.map(a => {
    const parts = (a.name || '').split(' ');
    return parts[parts.length - 1];
  }).filter(Boolean))];

  const locations = [...new Set(ancestors.map(a => a.birth_place).filter(Boolean))];

  const birthYears = ancestors.map(a => extractYear(a.birth_date)).filter(Boolean);
  const era = birthYears.length > 0
    ? { min: Math.min(...birthYears), max: Math.max(...birthYears) }
    : {};

  const feedbackHistory = db.getRelevantFeedback(surnames, locations, era, 50);

  // Compact format for token efficiency
  const adminFeedback = feedbackHistory.map(f => ({
    action: f.action_type,
    name: f.ancestor_name,
    surname: f.ancestor_surname,
    location: f.ancestor_location,
    birth_year: f.ancestor_birth_year,
    original: f.original_data,
    corrected: f.corrected_data,
    date: f.created_at,
  }));

  return {
    job: {
      id: job.id,
      customer_name: job.customer_name,
      generations: job.generations,
      status: job.status,
    },
    ancestors: ancestorEntries,
    empty_slots: emptySlots,
    statistics: {
      total_found: ancestors.length,
      total_expected: maxAsc,
      by_confidence: {
        verified: ancestors.filter(a => a.confidence_level === 'Verified').length,
        probable: ancestors.filter(a => a.confidence_level === 'Probable').length,
        possible: ancestors.filter(a => a.confidence_level === 'Possible').length,
        uncertain: ancestors.filter(a => a.confidence_level === 'Uncertain' || a.confidence_level === 'Unknown').length,
      },
    },
    admin_feedback_history: adminFeedback,
  };
}

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert genealogist AI reviewer working for "They Made Me", a professional genealogy research service based in the UK.

## THE BIG PICTURE

"They Made Me" creates personalised family tree products for customers. A customer provides their name, date of birth, birthplace, and parents' names. Our automated research engine then:

1. Searches the FamilySearch.org database to link the customer's known ancestors to existing records
2. Traverses the FamilySearch family tree to discover earlier generations
3. Where tree traversal fails, uses direct search strategies (searching by surname + birth year + location) to find parent candidates — THIS IS THE MOST ERROR-PRONE STEP
4. Scores each ancestor's confidence based on record evidence

The engine produces a tree using the Ahnentafel numbering system:
- #1 = Subject (the customer), #2 = Father, #3 = Mother
- #4-7 = Grandparents, #8-15 = Great-grandparents
- For any person N: their father is 2N, their mother is 2N+1

## YOUR CRITICAL ROLE

You are NOT just a reviewer — you are an ACTIVE quality checker and gap-filler. You must:

### 1. CATCH WRONG PEOPLE (Most Important)
The direct search strategy often picks the WRONG person. Common failures:
- **Common surnames** (Hunt, Smith, Taylor, Jones): The engine finds the first person with 2+ sources matching the surname + approximate birth year — but in a common surname, this is often a DIFFERENT family entirely
- **Location mismatch**: Parent born in completely different region from their child — huge red flag
- **Name mismatch**: Engine found "Walter Hunt" but the child's records might indicate "Frederick Hunt" as father
- **Foreign matches**: Engine occasionally matches to American, Australian, or Scandinavian records instead of UK ones
- **Era mismatch**: Birth year gap between parent and child should be 20-35 years typically (12-55 is technically possible but extremes are suspicious)

For EVERY engine-discovered ancestor (not Customer Data), actively check:
- Does this person's birth location make geographic sense relative to their child?
- Is there any evidence in the child's records (census, birth cert) that names the actual parent?
- Does the FreeBMD data CONFIRM or CONTRADICT this match?
- Could this be a different person with the same surname who happens to live nearby?

If you suspect a wrong match, your flag MUST include:
- type: "error"
- message explaining WHY you think it's wrong
- suggested_correction: "LIKELY WRONG PERSON — search for [specific alternative]"
- confidence_adjustment: -30 to -50 (wrong person should have LOW confidence)

### 2. FILL GAPS ACTIVELY
For EVERY empty slot, don't just say "search for records". Instead:
- Work out what we KNOW about the missing person from their children's data
- The child's birth certificate names both parents — if the child is in FamilySearch, their record may contain parent names
- Marriage records name the bride's father — check if we have the marriage
- Census records list household members — suggest searching specific census years
- For mothers: the maiden name is KEY. Check if the father's marriage record is on FreeBMD — the bride's surname IS the mother's maiden name

Provide SPECIFIC suggestions like:
- "Search FreeBMD marriages for Hunt in Derby district 1955-1960 — the bride's surname will be the mother's maiden name"
- "Search 1939 Register for Norman Hunt at Derby — this should list his parents in the same household"
- "The child (Norman Hunt, b.1931) was born in Derby — search FreeBMD births Q1 1931 Derby district for Hunt to find the exact registration which names both parents"

### 3. CROSS-REFERENCE EVERYTHING
- FreeBMD birth district should match the birth place — if it doesn't, the person may be wrong
- If FreeBMD finds a marriage, check the spouse surname matches the other parent
- Check death dates: a parent cannot die before their child is born
- Check locations: a family in Derby, Derbyshire should NOT have a parent from Cornwall unless there's evidence of migration

### 4. CONFIDENCE CALIBRATION (Aggressive)
- Customer Data: ALWAYS 100, never adjust
- Engine-discovered with tree traversal + verified sources + FreeBMD confirms: keep at 95
- Engine-discovered via direct search + FreeBMD confirms location: 80-90
- Engine-discovered via direct search but FreeBMD district mismatch: 40-60 (flag as probable error)
- Engine-discovered via direct search with NO FreeBMD confirmation: 50-70
- Engine-discovered via direct search with evidence of being WRONG person: 10-30 (flag as error)

Use confidence_adjustment freely: -50 to +10. A wrong person at 95% confidence is far worse than being harsh.

## IMPORTANT CONTEXT

- UK genealogy service — ancestors should be from England, Wales, Scotland, or Ireland
- FreeBMD covers England & Wales 1837-1983
- Discovery method "direct_search_verified" is MUCH less reliable than "tree_parents_verified" — be skeptical of direct search results, especially for common surnames
- The engine's biggest weakness: for common surnames (Hunt, Smith, etc.), it takes the first person with 2+ sources, NOT necessarily the RIGHT person. Scrutinise these heavily.
- Unusual surnames (Ahlfors, Jelley) are more likely correct because fewer false matches exist

## ADMIN FEEDBACK HISTORY (Learning Memory)

The input may include "admin_feedback_history". Use patterns from past admin decisions:
- **accept**: Engine was right — be more trusting of similar matches
- **reject**: Engine was WRONG — be MORE skeptical of similar surname/location combos
- **correct**: Admin fixed data — learn the correction pattern
- **select_alternative**: Admin chose a different person — the engine's selection criteria failed here

## OUTPUT FORMAT

Respond with ONLY valid JSON (no markdown, no code fences) matching this schema:

{
  "reviewer": "<your model name>",
  "overall": {
    "tree_consistency": "good|fair|poor",
    "summary": "<2-3 sentence assessment focusing on accuracy>",
    "critical_issues": ["<showstopper problems — wrong people, impossible dates, etc>"]
  },
  "ancestor_reviews": [
    {
      "asc": <number>,
      "name": "<name>",
      "flags": [
        {
          "type": "error|warning|info|confirmation",
          "message": "<specific finding with reasoning>",
          "suggested_correction": "<what should be done — be specific, or null>"
        }
      ],
      "freebmd_assessment": "<does FreeBMD confirm or contradict?>",
      "confidence_adjustment": <-50 to +10>,
      "manual_lookup_suggestions": ["<SPECIFIC actionable suggestions with database names, search terms, date ranges>"]
    }
  ],
  "gap_analysis": [
    {
      "asc": <missing slot number>,
      "role": "<whose parent and which side>",
      "what_we_know": "<everything we can deduce about this missing person>",
      "search_strategy": "<step-by-step approach to find them>",
      "suggested_name": "<if deducible from records, e.g. from marriage records>"
    }
  ]
}

RULES:
- Include ancestor_reviews for EVERY ancestor (not just problematic ones)
- For engine-discovered ancestors, ALWAYS assess whether it could be a wrong match
- Be HARSH on confidence for direct_search_verified ancestors with common surnames
- For gap_analysis, suggest concrete databases and search terms (FreeBMD, 1939 Register, Ancestry, FindMyPast)
- If you can deduce a missing person's likely name from available records, include it in suggested_name
- confidence_adjustment of 0 means you agree with current score — use this rarely for direct search results
- Do NOT pad your response — keep flags concise but specific
`;

// ─── Run AI Reviews ─────────────────────────────────────────────────

/**
 * Call GPT-4o and Claude Sonnet in parallel with the same input.
 * Each produces an independent structured review.
 */
function trimAncestor(a) {
  return {
    asc: a.asc,
    role: a.role,
    name: a.name,
    gender: a.gender,
    birth_date: a.birth_date,
    birth_place: a.birth_place,
    death_date: a.death_date,
    death_place: a.death_place,
    confidence_score: a.confidence_score,
    confidence_level: a.confidence_level,
    fs_person_id: a.fs_person_id,
    source_count: a.source_count,
    discovery_method: a.discovery_method,
    evidence_chain: (a.evidence_chain || []).slice(0, 3),
    freebmd_match: a.freebmd?.birth_match ? 'yes' : a.freebmd?.death_match ? 'death_only' : 'no',
  };
}

/**
 * Run GPT-4o review in batches to stay within 30K TPM limit.
 * Each batch contains ~25 ancestors with full context.
 * Batches run sequentially with a delay between them.
 */
async function runGPTBatched(trimmedAncestors, baseInput) {
  const GPT_BATCH_SIZE = 25;
  const batches = [];
  for (let i = 0; i < trimmedAncestors.length; i += GPT_BATCH_SIZE) {
    batches.push(trimmedAncestors.slice(i, i + GPT_BATCH_SIZE));
  }

  console.log(`[AI-Review] GPT-4o: ${trimmedAncestors.length} ancestors → ${batches.length} batch(es) of ~${GPT_BATCH_SIZE}`);

  const allAncestorReviews = [];
  const allGapAnalysis = [];
  let overall = null;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchAscNumbers = new Set(batch.map(a => a.asc));

    // Include empty slots that are children of ancestors in this batch
    const relevantSlots = (baseInput.empty_slots || []).filter(s =>
      batchAscNumbers.has(s.expected_parent_of_asc) || batchAscNumbers.has(Math.floor(s.asc / 2))
    );

    const batchInput = {
      ...baseInput,
      ancestors: batch,
      empty_slots: relevantSlots,
      _batch_info: {
        batch_number: i + 1,
        total_batches: batches.length,
        ancestor_range: `asc#${batch[0].asc}-${batch[batch.length - 1].asc}`,
        total_ancestors: trimmedAncestors.length,
      },
    };

    const batchPrompt = JSON.stringify(batchInput, null, 2);
    console.log(`[AI-Review] GPT-4o batch ${i + 1}/${batches.length}: ${batch.length} ancestors, ~${Math.round(batchPrompt.length / 4)} tokens`);

    try {
      const result = await openaiClient.reviewTree(SYSTEM_PROMPT, batchPrompt);
      if (result.ancestor_reviews) allAncestorReviews.push(...result.ancestor_reviews);
      if (result.gap_analysis) allGapAnalysis.push(...result.gap_analysis);
      if (!overall && result.overall) overall = result.overall;
    } catch (e) {
      console.error(`[AI-Review] GPT-4o batch ${i + 1} error: ${e.message}`);
      // Continue with remaining batches
    }

    // Wait 65s between batches to respect TPM limit (tokens reset per minute)
    if (i < batches.length - 1) {
      console.log(`[AI-Review] GPT-4o: waiting 65s for TPM reset...`);
      await new Promise(r => setTimeout(r, 65000));
    }
  }

  return {
    reviewer: 'gpt-4o',
    overall: overall || { tree_consistency: 'unknown', summary: 'Batched review', critical_issues: [] },
    ancestor_reviews: allAncestorReviews,
    gap_analysis: allGapAnalysis,
  };
}

async function runAIReviews(aiInput) {
  // Trim verbose fields from AI input to stay within token limits
  const trimmedAncestors = aiInput.ancestors.map(trimAncestor);
  const trimmedEmptySlots = (aiInput.empty_slots || []).slice(0, 30);
  const trimmedFeedback = (aiInput.admin_feedback_history || []).slice(0, 20);

  // Full trimmed input for Claude (handles 200K context)
  const fullTrimmedInput = {
    ...aiInput,
    ancestors: trimmedAncestors,
    empty_slots: trimmedEmptySlots,
    admin_feedback_history: trimmedFeedback,
  };
  const fullPrompt = JSON.stringify(fullTrimmedInput, null, 2);
  const estimatedTokens = Math.round(fullPrompt.length / 4);
  console.log(`[AI-Review] Full trimmed input: ~${estimatedTokens} tokens (${fullPrompt.length} chars), ${trimmedAncestors.length} ancestors`);

  const results = { gpt: null, claude: null, errors: [] };
  const promises = [];

  // GPT-4o: batch if input is too large (>20K estimated tokens)
  if (openaiClient.isAvailable()) {
    if (estimatedTokens > 20000) {
      // Batched mode for large trees
      promises.push(
        runGPTBatched(trimmedAncestors, {
          job: aiInput.job,
          statistics: aiInput.statistics,
          empty_slots: trimmedEmptySlots,
          admin_feedback_history: trimmedFeedback,
        })
          .then(r => { results.gpt = r; })
          .catch(e => {
            console.error(`[AI-Review] GPT-4o batched error: ${e.message}`);
            results.errors.push({ model: 'gpt-4o', error: e.message });
          })
      );
    } else {
      // Small tree — send all at once
      promises.push(
        openaiClient.reviewTree(SYSTEM_PROMPT, fullPrompt)
          .then(r => { results.gpt = r; })
          .catch(e => {
            console.error(`[AI-Review] GPT-4o error: ${e.message}`);
            results.errors.push({ model: 'gpt-4o', error: e.message });
          })
      );
    }
  } else {
    console.log('[AI-Review] OpenAI not configured, skipping GPT-4o review');
  }

  // Claude: always send full input (200K context window)
  if (claudeClient.isAvailable()) {
    promises.push(
      claudeClient.reviewTree(SYSTEM_PROMPT, fullPrompt)
        .then(r => { results.claude = r; })
        .catch(e => {
          console.error(`[AI-Review] Claude error: ${e.message}`);
          results.errors.push({ model: 'claude-sonnet', error: e.message });
        })
    );
  } else {
    console.log('[AI-Review] Anthropic not configured, skipping Claude review');
  }

  if (promises.length === 0) {
    throw new Error('No AI API keys configured — cannot run review');
  }

  await Promise.all(promises);
  return results;
}

// ─── Store Review Results ───────────────────────────────────────────

/**
 * Merge AI review results into the database.
 * Per-ancestor flags go into ancestors.ai_review column.
 * Overall summary goes into research_jobs.ai_review_summary.
 */
function storeReviewResults(jobId, aiResults) {
  const { gpt, claude } = aiResults;

  // Build per-ancestor merged review
  const ancestorReviews = {};

  // Process GPT-4o results
  if (gpt && gpt.ancestor_reviews) {
    for (const review of gpt.ancestor_reviews) {
      if (!ancestorReviews[review.asc]) ancestorReviews[review.asc] = {};
      ancestorReviews[review.asc].gpt = {
        flags: review.flags || [],
        freebmd_assessment: review.freebmd_assessment || '',
        confidence_adjustment: review.confidence_adjustment || 0,
        manual_lookup_suggestions: review.manual_lookup_suggestions || [],
      };
    }
  }

  // Process Claude results
  if (claude && claude.ancestor_reviews) {
    for (const review of claude.ancestor_reviews) {
      if (!ancestorReviews[review.asc]) ancestorReviews[review.asc] = {};
      ancestorReviews[review.asc].claude = {
        flags: review.flags || [],
        freebmd_assessment: review.freebmd_assessment || '',
        confidence_adjustment: review.confidence_adjustment || 0,
        manual_lookup_suggestions: review.manual_lookup_suggestions || [],
      };
    }
  }

  // Store per-ancestor reviews
  for (const [ascStr, review] of Object.entries(ancestorReviews)) {
    const asc = parseInt(ascStr);
    db.updateAncestorByAscNumber(jobId, asc, { ai_review: review });
  }

  // Store overall summary
  const summary = {
    completed_at: new Date().toISOString(),
    gpt: gpt ? {
      reviewer: gpt.reviewer || 'gpt-4o',
      overall: gpt.overall || {},
      gap_analysis: gpt.gap_analysis || [],
    } : null,
    claude: claude ? {
      reviewer: claude.reviewer || 'claude-sonnet',
      overall: claude.overall || {},
      gap_analysis: claude.gap_analysis || [],
    } : null,
    errors: aiResults.errors || [],
  };

  db.updateResearchJob(jobId, { ai_review_summary: summary });
}

// ─── Auto-Correction Helpers ────────────────────────────────────

/**
 * Normalized fuzzy match between two AI suggestion strings.
 * Returns true if they're recommending the same correction.
 */
function fuzzyMatchCorrection(a, b) {
  if (!a || !b) return false;
  const normA = a.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const normB = b.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

  // Exact match
  if (normA === normB) return true;

  // One contains the other
  if (normA.includes(normB) || normB.includes(normA)) return true;

  // Extract year from both — if same year mentioned, likely same correction
  const yearA = normA.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
  const yearB = normB.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
  if (yearA && yearB && yearA[1] === yearB[1]) {
    // Same year + some word overlap
    const wordsA = new Set(normA.split(/\s+/));
    const wordsB = new Set(normB.split(/\s+/));
    const overlap = [...wordsA].filter(w => wordsB.has(w) && w.length > 2).length;
    if (overlap >= 2) return true;
  }

  return false;
}

/**
 * Check if a FreeBMD result confirms an AI-suggested correction.
 * E.g. if AI suggests birth year should be 1909, check FreeBMD birth.year === 1909.
 */
function checkFreeBMDConfirms(suggestion, freebmdData) {
  if (!suggestion || !freebmdData) return false;
  const suggestedYear = suggestion.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
  if (!suggestedYear) return false;
  const year = parseInt(suggestedYear[1]);

  // Check birth
  if (freebmdData.birth?.matched && freebmdData.birth.year === year) return true;
  // Check death
  if (freebmdData.death?.matched && freebmdData.death.year === year) return true;

  return false;
}

/**
 * Parse a suggested correction string into a field update.
 * Conservative — better to miss than misinterpret.
 *
 * Returns { field, value } or null if can't parse.
 */
function parseCorrection(suggestion) {
  if (!suggestion) return null;

  // "birth year should be 1909" or "birth date: 1909"
  const birthYearMatch = suggestion.match(/birth\s*(?:year|date)\s*(?:should\s*be|:|-|→|to)\s*~?\s*(1[6-9]\d{2}|20[0-2]\d)/i);
  if (birthYearMatch) return { field: 'birth_date', value: birthYearMatch[1] };

  // "death year should be 1963"
  const deathYearMatch = suggestion.match(/death\s*(?:year|date)\s*(?:should\s*be|:|-|→|to)\s*~?\s*(1[6-9]\d{2}|20[0-2]\d)/i);
  if (deathYearMatch) return { field: 'death_date', value: deathYearMatch[1] };

  // "birth place should be Derby, Derbyshire"
  const birthPlaceMatch = suggestion.match(/birth\s*place\s*(?:should\s*be|:|-|→|to)\s*["']?([^"'\n]+?)["']?\s*$/i);
  if (birthPlaceMatch) return { field: 'birth_place', value: birthPlaceMatch[1].trim() };

  // "death place should be Pinxton, Derbyshire"
  const deathPlaceMatch = suggestion.match(/death\s*place\s*(?:should\s*be|:|-|→|to)\s*["']?([^"'\n]+?)["']?\s*$/i);
  if (deathPlaceMatch) return { field: 'death_place', value: deathPlaceMatch[1].trim() };

  return null;
}

/**
 * Compare GPT and Claude reviews, apply auto-corrections where both agree,
 * and generate suggestions where partial agreement.
 */
function applyAICorrections(jobId, gptResult, claudeResult) {
  const ancestors = db.getAncestors(jobId);
  const corrections = [];  // auto-applied
  const suggestions = [];  // for admin one-click

  for (const anc of ancestors) {
    const asc = anc.ascendancy_number;

    // NEVER auto-correct: Subject (#1) or Customer Data ancestors
    if (asc === 1 || anc.confidence_level === 'Customer Data') continue;

    const gptReview = gptResult?.ancestor_reviews?.find(r => r.asc === asc);
    const claudeReview = claudeResult?.ancestor_reviews?.find(r => r.asc === asc);
    if (!gptReview && !claudeReview) continue;

    // ── Confidence adjustments ──
    const gptAdj = gptReview?.confidence_adjustment || 0;
    const claudeAdj = claudeReview?.confidence_adjustment || 0;

    // Agreement threshold scales with magnitude: small adjustments need ±2, large ones need ±10
    const adjDiff = Math.abs(gptAdj - claudeAdj);
    const avgMag = Math.abs((gptAdj + claudeAdj) / 2);
    const threshold = avgMag >= 20 ? 15 : avgMag >= 10 ? 8 : 2;

    if (gptAdj !== 0 && claudeAdj !== 0 && adjDiff <= threshold && Math.sign(gptAdj) === Math.sign(claudeAdj)) {
      // Both models agree on direction and roughly same magnitude → auto-apply average
      const avgAdj = Math.round((gptAdj + claudeAdj) / 2);
      if (avgAdj !== 0) {
        const oldScore = anc.confidence_score || 0;
        const newScore = Math.max(0, Math.min(100, oldScore + avgAdj));

        if (newScore !== oldScore) {
          // Apply
          db.updateAncestorByAscNumber(jobId, asc, { confidence_score: newScore });

          // Log in corrections_log
          const log = anc.corrections_log || [];
          log.push({
            type: 'confidence_adjustment',
            source: 'ai_auto',
            old_value: oldScore,
            new_value: newScore,
            gpt_adj: gptAdj,
            claude_adj: claudeAdj,
            applied_at: new Date().toISOString(),
            undone: false,
          });
          db.updateAncestorByAscNumber(jobId, asc, { corrections_log: log });

          corrections.push({
            asc,
            name: anc.name,
            type: 'confidence_adjustment',
            old_value: oldScore,
            new_value: newScore,
            gpt_adj: gptAdj,
            claude_adj: claudeAdj,
          });
        }
      }
    } else if ((gptAdj !== 0 || claudeAdj !== 0) && Math.abs(gptAdj - claudeAdj) > 2) {
      // Models disagree on direction/magnitude → suggest
      suggestions.push({
        asc,
        name: anc.name,
        type: 'confidence_adjustment',
        gpt_adj: gptAdj,
        claude_adj: claudeAdj,
        current: anc.confidence_score || 0,
      });
    }

    // ── Field corrections (from flags with suggested_correction) ──
    const gptFlags = (gptReview?.flags || []).filter(f => f.suggested_correction);
    const claudeFlags = (claudeReview?.flags || []).filter(f => f.suggested_correction);

    for (const gFlag of gptFlags) {
      // Find matching Claude flag
      const matchingClaude = claudeFlags.find(cf =>
        fuzzyMatchCorrection(gFlag.suggested_correction, cf.suggested_correction)
      );

      const parsed = parseCorrection(gFlag.suggested_correction);
      if (!parsed) continue;

      if (matchingClaude) {
        // Both models agree on this correction
        const freebmdConfirms = checkFreeBMDConfirms(gFlag.suggested_correction, anc.freebmd_results);

        if (freebmdConfirms) {
          // Triple confirmation: GPT + Claude + FreeBMD → auto-apply
          const oldValue = anc[parsed.field] || '';
          db.updateAncestorByAscNumber(jobId, asc, { [parsed.field]: parsed.value });

          const log = anc.corrections_log || [];
          log.push({
            type: 'field_correction',
            source: 'ai_auto',
            field: parsed.field,
            old_value: oldValue,
            new_value: parsed.value,
            gpt_flag: gFlag.message,
            claude_flag: matchingClaude.message,
            freebmd_confirmed: true,
            applied_at: new Date().toISOString(),
            undone: false,
          });
          db.updateAncestorByAscNumber(jobId, asc, { corrections_log: log });

          corrections.push({
            asc,
            name: anc.name,
            type: 'field_correction',
            field: parsed.field,
            old_value: oldValue,
            new_value: parsed.value,
            freebmd_confirmed: true,
          });
        } else {
          // Both agree but no FreeBMD confirmation → suggest
          suggestions.push({
            asc,
            name: anc.name,
            type: 'field_correction',
            field: parsed.field,
            current_value: anc[parsed.field] || '',
            suggested_value: parsed.value,
            gpt_message: gFlag.message,
            claude_message: matchingClaude.message,
            freebmd_confirmed: false,
          });
        }
      } else {
        // Only GPT flags this → suggest (lower confidence)
        suggestions.push({
          asc,
          name: anc.name,
          type: 'field_correction',
          field: parsed.field,
          current_value: anc[parsed.field] || '',
          suggested_value: parsed.value,
          gpt_message: gFlag.message,
          claude_message: null,
          freebmd_confirmed: false,
          single_model: true,
        });
      }
    }

    // Check Claude-only flags (not matched by GPT)
    for (const cFlag of claudeFlags) {
      const alreadyMatched = gptFlags.some(gf =>
        fuzzyMatchCorrection(gf.suggested_correction, cFlag.suggested_correction)
      );
      if (alreadyMatched) continue;

      const parsed = parseCorrection(cFlag.suggested_correction);
      if (!parsed) continue;

      suggestions.push({
        asc,
        name: anc.name,
        type: 'field_correction',
        field: parsed.field,
        current_value: anc[parsed.field] || '',
        suggested_value: parsed.value,
        gpt_message: null,
        claude_message: cFlag.message,
        freebmd_confirmed: false,
        single_model: true,
      });
    }
  }

  console.log(`[AI-Review] Auto-corrections: ${corrections.length}, Suggestions: ${suggestions.length}`);
  return { corrections, suggestions };
}

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Run the full AI review pipeline for a completed research job.
 *
 * 1. FreeBMD cross-reference (~90s for 4-gen tree, 3s rate limit)
 * 2. Build structured AI input payload
 * 3. GPT-4o + Claude Sonnet review (parallel, ~10-20s)
 * 4. Store all results in database
 */
const _runningReviews = new Set();

async function runFullReview(jobId) {
  // Guard against parallel runs for the same job
  if (_runningReviews.has(jobId)) {
    console.log(`[AI-Review] Already running for job ${jobId}, skipping duplicate`);
    return { success: false, error: 'Already running' };
  }
  _runningReviews.add(jobId);

  console.log(`[AI-Review] Starting full review for job ${jobId}`);

  try {
    db.updateResearchJob(jobId, { ai_review_status: 'running' });
    db.updateJobProgress(jobId, 'Running AI review pipeline...', 0, 3);

    // Step 1: FreeBMD cross-reference
    console.log('[AI-Review] Step 1/3: FreeBMD cross-reference');
    await runFreeBMDCrossReference(jobId);

    // Step 2: Build AI input (includes FreeBMD results from step 1)
    console.log('[AI-Review] Step 2/3: Building AI input');
    db.updateJobProgress(jobId, 'Preparing AI review data...', 1, 3);
    const aiInput = buildAIInput(jobId);
    console.log(`[AI-Review] AI input: ${aiInput.ancestors.length} ancestors, ${aiInput.empty_slots.length} empty slots`);

    // Step 3: Run AI reviews in parallel
    console.log('[AI-Review] Step 3/3: Running AI reviews (GPT-4o + Claude Sonnet)');
    db.updateJobProgress(jobId, 'AI models reviewing tree...', 2, 3);
    const aiResults = await runAIReviews(aiInput);

    // Step 4: Store results
    console.log('[AI-Review] Storing review results');
    storeReviewResults(jobId, aiResults);

    // Step 5: Apply auto-corrections where both models agree
    console.log('[AI-Review] Step 5: Applying auto-corrections');
    const correctionResults = applyAICorrections(jobId, aiResults.gpt, aiResults.claude);

    // Store correction/suggestion summary alongside AI review
    const existingJob = db.getResearchJob(jobId);
    const summary = existingJob.ai_review_summary || {};
    summary.ai_corrections = correctionResults.corrections;
    summary.ai_suggestions = correctionResults.suggestions;
    db.updateResearchJob(jobId, { ai_review_summary: summary });

    db.updateResearchJob(jobId, { ai_review_status: 'completed' });
    db.updateJobProgress(jobId, 'AI review complete', 3, 3);
    console.log(`[AI-Review] Full review complete for job ${jobId}`);

    return { success: true, summary: aiResults };
  } catch (error) {
    console.error(`[AI-Review] Pipeline error: ${error.message}`);
    db.updateResearchJob(jobId, {
      ai_review_status: 'failed',
    });
    db.updateJobProgress(jobId, `AI review failed: ${error.message}`, 0, 0);
    return { success: false, error: error.message };
  } finally {
    _runningReviews.delete(jobId);
  }
}

module.exports = {
  runFullReview,
  runFreeBMDCrossReference,
  buildAIInput,
  runAIReviews,
  storeReviewResults,
  applyAICorrections,
  parseCorrection,
  SYSTEM_PROMPT,
};
