/**
 * ════════════════════════════════════════════════════════════════════════
 *  THEY MADE ME — MASTER GENEALOGY RULEBOOK  (single source of truth)
 * ════════════════════════════════════════════════════════════════════════
 *
 *  HUMAN-OWNED. The running system READS these rules on every job but MUST
 *  NEVER modify them. The "AI learning memory" may inform per-job SUGGESTIONS,
 *  but it is SUBORDINATE to this rulebook and cannot change the values here.
 *
 *  Only a human maintainer changes a rule — by editing the number below,
 *  bumping `version`, and committing. The values are deep-frozen at load time,
 *  so nothing in the codebase can mutate them at runtime. An integrity test
 *  (app/test/eval/rules-governance.test.js) asserts the engine's behaviour
 *  matches these values so the two can never silently drift apart.
 *
 *  Every value below is documented. To change accuracy behaviour, change the
 *  number here — not in the engine.
 * ════════════════════════════════════════════════════════════════════════
 */
const crypto = require('crypto');

const RULES = {
  version: '1.0.0',

  // ── Parent→child birth-year gap ────────────────────────────────────────
  // A parent is born this many years before their child. Used to reject
  // impossible relationships and to reward plausible ones.
  ageGap: {
    hardMinYears: 12,           // below this = reject (biological floor)
    hardMaxYears: 55,           // above this = reject (after accounting for late parenthood)
    plausibleMinYears: 18,      // gap in [plausible..] earns the plausibility bonus
    plausibleMaxYears: 45,
    sweetSpotMinYears: 22,      // typical gap — earns an extra bonus
    sweetSpotMaxYears: 35,
    plausiblePoints: 5,         // points for a plausible gap
    sweetSpotPoints: 2,         // extra points for a typical gap
    parentAfterChildPenalty: -50, // parent born after the child = impossible
    implausibleGapPenalty: -30, // gap outside the plausible range but not flatly impossible
    // NOTE: scoreLocationDate currently penalises gaps below this value. It is
    // 15, which conflicts with hardMinYears (12). See MASTER-RULES.md → REVIEW R1.
    scoringPenaltyBelowYears: 15,
  },

  // ── Birth-year tolerance when matching a candidate to a known person ────
  birthYearTolerance: {
    defaultYears: 5,            // ± window for parents/grandparents
    olderGenerationYears: 8,    // wider ± window for great-grandparents and beyond
    olderGenerationFromGen: 3,  // generation index at which the wider window applies
    differentCenturyRejectYears: 50, // reject if candidate is this far off
  },

  // ── Default gaps used to ESTIMATE a parent's birth year when unknown ────
  estimation: {
    fatherGapYears: 28,         // father ≈ child birth − 28
    motherGapYears: 26,         // mother ≈ child birth − 26
    grandchildFallbackGapYears: 28,
  },

  // ── Source records ─────────────────────────────────────────────────────
  // Which record categories count as documentary "primary" proof, the points
  // each is worth, and the per-category record caps (dedup-aware).
  sources: {
    primaryCategories: ['Civil Registration', 'Census', '1939 Register', 'Parish Register'],
    categoryPoints: {
      'Civil Registration': { points: 15, maxRecords: 3 },
      'Census':             { points: 12, maxRecords: 99 },
      'Parish Register':    { points: 10, maxRecords: 2 },
      '1939 Register':      { points: 10, maxRecords: 1 },
      'Military':           { points: 8,  maxRecords: 2 },
      'Probate':            { points: 8,  maxRecords: 1 },
      'Other':              { points: 3,  maxRecords: 3 },
    },
    // Minimum PRIMARY sources to accept a tree/direct-search parent.
    minPrimaryShallowGen: 2,    // generations < deepFromGen
    minPrimaryDeepGen: 1,       // generations >= deepFromGen
    deepFromGen: 4,
    commonSurnameExtraPrimary: 1, // common surnames need one MORE than the base
    distantLocationMinPrimary: 4, // a parent in a distant county needs this many
    preCivilRegistrationYear: 1837, // before this, civil records don't exist — accept tree leads
  },

  // ── Confidence calibration ─────────────────────────────────────────────
  // Total evidence points map to a percentage; the percentage maps to a level.
  // These cutoffs are the SAME everywhere (engine + UI) so they can't drift.
  confidence: {
    verifiedMinPoints: 60,
    probableMinPoints: 45,
    possibleMinPoints: 25,
    suggestedMinPoints: 10,
    heavyPenaltyMaxPoints: -10,
    defaultPercent: 25,
    levelCutoffs: { verified: 90, probable: 75, possible: 50, suggested: 25 },
    autoAcceptPercent: 75,      // ancestors at/above this are auto-accepted
    sectionCaps: { facts: 33, family: 23, location: 17 },
  },

  // ── Hard confidence caps for poorly-evidenced ancestors ────────────────
  gates: {
    noSurnameMaxPercent: 49,           // can't verify identity without a surname
    noIdentityMaxPercent: 35,          // no surname + no year + no location
    unsourcedCivilEraMaxPercent: 74,   // born 1837+ but zero documentary records
    civilRegistrationYear: 1837,
  },

  // ── Location / geography scoring ───────────────────────────────────────
  location: {
    sameCountyPoints: 5,
    sameTownBonus: 3,
    adjacentCountyPoints: 2,
    distantCountyPenalty: -15,
    sameGenerationCountyBonus: 2,
  },

  // ── Candidate scoring weights (Phase 1: link a known person to a record) ─
  candidateScoring: {
    base: 50,
    customerYearExactBonus: 40,     // matching the customer's STATED birth year
    customerYearPenaltyPerYear: 5,
    estimateYearBonus: 30,          // matching an ESTIMATED year (weaker signal)
    estimateYearPenaltyPerYear: 3,
    hasBirthDateBonus: 15,
    hasBirthPlaceBonus: 10,
    sameLocationBonus: 20,
    nearbyLocationBonus: 10,
    sourceBonusPerPrimary: 5,
    sourceBonusCapPrimaries: 3,     // raw record count can't dominate identity
    fsRelevanceFactor: 0.1,         // weight on FamilySearch's own relevance rank
    fsRelevanceCap: 15,
    parentDataBonus: 10,
  },

  // ── Name / surname matching ────────────────────────────────────────────
  surname: {
    fatherSurnameMatchBonus: 5,        // father's surname matches the child's
    fatherSurnameMismatchPenalty: -15, // father's surname must match the child's
    motherMaidenPresentBonus: 3,
  },

  // ── Family-context discovery-method bonuses (Section 3 scoring) ─────────
  discovery: {
    treeParentsVerifiedBonus: 8,
    directSearchVerifiedBonus: 8,
    treeParentsUnverifiedBonus: 3,
  },

  // ── FreeBMD confirmation score thresholds ──────────────────────────────
  freebmd: {
    birthConfirmMinScore: 50,
    deathConfirmMinScore: 50,
    marriageConfirmMinScore: 45,
  },

  // ── AI reviewer auto-correction consensus ──────────────────────────────
  // The bar for AUTOMATICALLY applying a confidence change without admin sign-off.
  autoCorrection: {
    downgradeAgreementMaxDiff: 10,  // both models within this → auto-apply a downgrade
    downgradeApplyCap: -40,         // a single auto-downgrade can't exceed this
    upgradeMaxAutoApply: 5,         // only tiny upgrades auto-apply…
    upgradeAgreementMaxDiff: 2,     // …and only with very tight agreement
  },
};

// ── Deep-freeze so the running system can never mutate the rules ──────────
function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}
deepFreeze(RULES);

// Content hash — logged on every run so a changed rulebook is auditable.
const RULES_HASH = crypto.createHash('sha256')
  .update(JSON.stringify(RULES)).digest('hex').slice(0, 12);

/**
 * Human/AI-readable narrative of the operational rules, generated FROM the
 * values above so it can never state a different number than the engine uses.
 * Injected verbatim into the AI reviewer's system prompt every run.
 */
function renderRulesText() {
  const a = RULES.ageGap, s = RULES.sources, c = RULES.confidence, g = RULES.gates;
  return `THEY MADE ME — MASTER GENEALOGY RULES (v${RULES.version}, ref ${RULES_HASH})
These rules are HUMAN-OWNED and authoritative. Apply them exactly. You may
suggest, but you may NOT invent looser rules or override these thresholds.

1. PARENT–CHILD AGE GAP: a parent is born ${a.hardMinYears}–${a.hardMaxYears} years before their child.
   - A parent born the same year as or AFTER the child is IMPOSSIBLE — flag "error", confidence_adjustment ${a.parentAfterChildPenalty}.
   - A gap below ${a.hardMinYears} or above ${a.hardMaxYears} years is near-impossible — flag "error", ${a.implausibleGapPenalty} or worse.
   - The typical gap is ${a.sweetSpotMinYears}–${a.sweetSpotMaxYears} years.
2. UK SCOPE: ancestors are from England, Wales, Scotland or Ireland. Foreign matches are errors unless migration is documented.
3. LOCATION: a parent's county should match or be adjacent to the child's. A DISTANT county is a strong red flag unless ${s.distantLocationMinPrimary}+ primary sources confirm it.
4. DOCUMENTARY PROOF (FamilySearch trees are LEADS, not evidence):
   - Primary record types: ${s.primaryCategories.join(', ')}.
   - A person born ${g.civilRegistrationYear}+ with ZERO primary records cannot exceed ${g.unsourcedCivilEraMaxPercent}% ("Possible") — never call them Verified.
   - Common surnames need MORE evidence; be especially skeptical of direct-search matches for them.
5. SURNAMES: a father's surname must match the child's. A mismatch is a red flag.
6. CONFIDENCE CALIBRATION (apply, don't inflate):
   - Verified (${c.levelCutoffs.verified}%+): tree-verified or direct-search WITH primary sources AND FreeBMD agreement.
   - Probable (${c.levelCutoffs.probable}–${c.levelCutoffs.verified - 1}%): solid but with a gap.
   - Possible (${c.levelCutoffs.possible}–${c.levelCutoffs.probable - 1}%): plausible, unverified — needs manual review.
   - A wrong person at high confidence is far worse than being cautious.
7. CROSS-REFERENCE: a parent cannot die before their child is born; FreeBMD district should match the birthplace; a marriage spouse surname should match the other parent's maiden name.`;
}

const RULES_TEXT = renderRulesText();

module.exports = {
  RULES,
  RULES_VERSION: RULES.version,
  RULES_HASH,
  RULES_TEXT,
};
