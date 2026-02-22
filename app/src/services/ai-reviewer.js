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
  const maxAsc = Math.pow(2, job.generations + 1) - 1;
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
  };
}

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert genealogist AI reviewer working for "They Made Me", a professional genealogy research service based in the UK.

## THE BIG PICTURE

"They Made Me" creates personalised family tree products for customers. A customer provides their name, date of birth, birthplace, and parents' names. Our automated research engine then:

1. Searches the FamilySearch.org database (the world's largest free genealogy repository) to link the customer's known ancestors to existing records
2. Traverses the FamilySearch family tree to discover earlier generations (grandparents, great-grandparents, etc.)
3. Where tree traversal fails, uses direct search strategies (searching by surname + birth year + location) to find parent candidates
4. Scores each ancestor's confidence based on record evidence (birth/death records, census entries, marriage records, etc.)

The engine produces a tree of ancestors using the Ahnentafel numbering system:
- #1 = Subject (the customer)
- #2 = Father, #3 = Mother
- #4-7 = Grandparents
- #8-15 = Great-grandparents
- For any person N: their father is 2N, their mother is 2N+1

The tree typically covers 4-5 generations (up to 31 ancestors for 5 generations).

## YOUR ROLE

You are the AI quality reviewer. After the automated engine completes, you review the ENTIRE tree for:

1. **Errors & Inconsistencies**: Dates that don't make sense, impossible parent-child relationships, wrong genders, mismatched surnames, geographically impossible connections
2. **FreeBMD Cross-Reference Assessment**: The tree data has been independently checked against FreeBMD (England & Wales civil registration indexes, 1837-1983). Assess whether the FreeBMD results confirm or contradict the tree data
3. **Confidence Calibration**: The engine assigns confidence scores (0-100). Recommend adjustments (-10 to +10) where you think the score is too high or too low based on evidence quality
4. **Gap Analysis**: Identify empty slots in the tree and suggest SPECIFIC search strategies to fill them (which free databases to search, what names/dates/places to use)
5. **Manual Lookup Suggestions**: For each ancestor, suggest specific actions the human reviewer should take on paid genealogy sites (Ancestry, FindMyPast) or in physical archives

## IMPORTANT CONTEXT

- This is primarily a UK genealogy service — most ancestors will be from England, Wales, Scotland, or Ireland
- FreeBMD only covers England & Wales from 1837 onwards — pre-1837 ancestors won't have FreeBMD data
- FamilySearch data quality varies enormously — some records are well-sourced, others are speculative
- Discovery methods matter: "tree_parents_verified" (found via tree traversal with source-verified parents) is much more reliable than "direct_search_verified" (found by surname search)
- The human admin does the FINAL review before sending results to the customer — your job is to flag issues and suggest actions, not to make final decisions

## OUTPUT FORMAT

Respond with ONLY valid JSON (no markdown, no explanation) matching this exact schema:

{
  "reviewer": "<your model name>",
  "overall": {
    "tree_consistency": "good|fair|poor",
    "summary": "<2-3 sentence overview of the tree quality>",
    "critical_issues": ["<list of any showstopper problems>"]
  },
  "ancestor_reviews": [
    {
      "asc": <ahnentafel number>,
      "name": "<ancestor name>",
      "flags": [
        {
          "type": "error|warning|info|confirmation",
          "message": "<specific finding>",
          "suggested_correction": "<if applicable, null otherwise>"
        }
      ],
      "freebmd_assessment": "<assessment of FreeBMD cross-reference results>",
      "confidence_adjustment": <number from -10 to +10>,
      "manual_lookup_suggestions": ["<specific actionable suggestions>"]
    }
  ],
  "gap_analysis": [
    {
      "asc": <missing slot number>,
      "role": "<e.g. Janet's father>",
      "suggestion": "<specific search strategy using free databases>"
    }
  ]
}

RULES:
- Include an entry in ancestor_reviews for EVERY ancestor in the tree (not just ones with problems)
- Be specific in suggestions — don't say "search for more records", say "Search FreeBMD deaths for Hunt in Derby district 1985-1995"
- Flag genuine issues, don't invent problems where none exist
- For empty slots, consider what information we DO have about the missing person (from their children's records) to suggest targeted searches
- confidence_adjustment of 0 means you agree with the current score
`;

// ─── Run AI Reviews ─────────────────────────────────────────────────

/**
 * Call GPT-4o and Claude Sonnet in parallel with the same input.
 * Each produces an independent structured review.
 */
async function runAIReviews(aiInput) {
  const userPrompt = JSON.stringify(aiInput, null, 2);
  const results = { gpt: null, claude: null, errors: [] };

  // Run both in parallel — they're independent reviews
  const promises = [];

  if (openaiClient.isAvailable()) {
    promises.push(
      openaiClient.reviewTree(SYSTEM_PROMPT, userPrompt)
        .then(r => { results.gpt = r; })
        .catch(e => {
          console.error(`[AI-Review] GPT-4o error: ${e.message}`);
          results.errors.push({ model: 'gpt-4o', error: e.message });
        })
    );
  } else {
    console.log('[AI-Review] OpenAI not configured, skipping GPT-4o review');
  }

  if (claudeClient.isAvailable()) {
    promises.push(
      claudeClient.reviewTree(SYSTEM_PROMPT, userPrompt)
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

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Run the full AI review pipeline for a completed research job.
 *
 * 1. FreeBMD cross-reference (~90s for 4-gen tree, 3s rate limit)
 * 2. Build structured AI input payload
 * 3. GPT-4o + Claude Sonnet review (parallel, ~10-20s)
 * 4. Store all results in database
 */
async function runFullReview(jobId) {
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
  }
}

module.exports = {
  runFullReview,
  runFreeBMDCrossReference,
  buildAIInput,
  runAIReviews,
  storeReviewResults,
  SYSTEM_PROMPT,
};
