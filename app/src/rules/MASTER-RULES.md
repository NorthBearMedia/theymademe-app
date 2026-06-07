# They Made Me — Master Genealogy Rulebook

This is the **single, human-owned source of truth** for how the tree is built and
scored. The running system **reads** these rules on every job but **must never
change them**.

- **The rules live in [`genealogy-rules.js`](./genealogy-rules.js)** — one
  well-commented, deep-frozen object. To change accuracy behaviour, change a
  number *there* (not in the engine), bump `version`, and commit.
- The values are `Object.freeze`d at load, so nothing in the code can mutate
  them at runtime. The **AI "learning memory" is subordinate** to this rulebook:
  it may inform per-job *suggestions*, but it cannot change a rule.
- **Only a human maintainer changes a rule.**

## How it is enforced (referenced every run)

| Mechanism | Where |
|---|---|
| Engine reads thresholds from `RULES` | `research-engine.js` (confidence, age gaps, sources, location, gates, candidate scoring, estimation, tolerances) |
| AI reviewer embeds the rules in its prompt every call | `ai-reviewer.js` → `SYSTEM_PROMPT` includes the auto-generated `RULES_TEXT` |
| Both log the version + content hash on every run | `[Engine] Rulebook: … v1.0.0 (ref …)` / `[AI-Review] Rulebook: …` |
| Drift guard | `app/test/eval/rules-governance.test.js` asserts the engine's behaviour matches the rulebook and that the rulebook is frozen |

Run the guard: `node app/test/eval/rules-governance.test.js`

## What the rules cover (snapshot — `genealogy-rules.js` is authoritative)

- **Age gap** parent→child: accept 12–55 yrs; typical 22–35; parent-after-child = impossible (−50).
- **Birth-year tolerance** when matching: ±5 yrs (±8 for great-grandparents+).
- **Birth-year estimation** when unknown: father −28, mother −26.
- **Sources**: primary = Civil Registration, Census, 1939 Register, Parish Register; points & per-category caps; minimum primary sources by generation / common surname / distant location; pre-1837 accepts tree leads.
- **Confidence**: points→% mapping; Verified 90+, Probable 75+, Possible 50+, Suggested 25+; auto-accept at 75%.
- **Confidence gates**: no surname → ≤49; no identifying data → ≤35; born 1837+ with no records → ≤74 ("Possible").
- **Location**: same county +5, town +3, adjacent +2, distant −15.
- **Candidate scoring**: prefer the customer's stated year, capped source bonus, FamilySearch relevance tiebreaker.
- **Surname**: father's surname must match the child's (−15 mismatch).
- **FreeBMD** confirmation score thresholds; **AI auto-correction** consensus bar.

---

## ⚠ REVIEW — sense-check findings for a human to decide on

These are inconsistencies/values the audit flagged. They are **left at their
current behaviour** in `genealogy-rules.js`; change the number only if you agree.

- **R1 — Age-gap floor disagreement.** Tree validation rejects gaps below
  **12 yrs**, but the *scoring* penalises gaps below **15 yrs**
  (`ageGap.scoringPenaltyBelowYears = 15`). So a real 13–14-year gap passes
  validation yet is penalised −30 in scoring. **Recommend:** set
  `scoringPenaltyBelowYears` to `12` to match the floor.
- **R2 — Father estimate not unified everywhere.** The fallback estimate is
  now `estimation.fatherGapYears = 28` (rulebook-governed), but a few discovery
  paths still use a hard-coded **−25**. **Recommend:** wire those to the rulebook
  so the father gap is 28 everywhere (or pick one value).
- **R3 — Distant-location minimum sources = 4.** People did migrate; requiring
  4 primary sources may drop correct ancestors. **Consider** 2–3.
- **R4 — Common-surname source escalation is uneven** across Phase 1 / Phase 2 /
  direct search. **Consider** routing all of it through
  `sources.commonSurnameExtraPrimary` for one consistent policy.
- **R5 — Not every constant is rulebook-governed yet.** Wired so far: confidence
  cutoffs & gates, age-gap & location scoring, source points/categories,
  candidate scoring, estimation fallback, year tolerance, surname/discovery
  bonuses, AI auto-correction. **Still hard-coded (to migrate next):** Strategy-2
  direct-search `minSources` ladder, FreeBMD client score weights, and the −25
  estimate in R2.

To action any of these, tell the maintainer which value to change — or edit
`genealogy-rules.js` directly and bump the version.
