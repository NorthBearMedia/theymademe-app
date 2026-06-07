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

- **Age gap** parent→child, **sex-specific**: mother **14–50** (female fertility ends ~50), father **16–60**; typical mother 20–35 / father 24–40; parent-after-child = impossible (−50).
- **Birth-year tolerance** when matching: ±5 yrs (±8 for great-grandparents+).
- **Birth-year estimation** when unknown: father −28, mother −26.
- **Sources**: primary = Civil Registration, Census, 1939 Register, Parish Register; points & per-category caps; minimum primary sources by generation / common surname; **distant county needs 3** (industrial-era migration was common); pre-1837 accepts tree leads.
- **Confidence**: points→% mapping; Verified 90+, Probable 75+, Possible 50+, Suggested 25+; auto-accept at 75%.
- **Confidence gates**: no surname → ≤49; no identifying data → ≤35; born 1837+ with no records → ≤74 ("Possible").
- **Location**: same county +5, town +3, adjacent +2, **distant −18** ("right name, wrong county" is the #1 false match).
- **Candidate scoring**: prefer the customer's stated year, capped source bonus, FamilySearch relevance tiebreaker.
- **Surname**: father's surname must match the child's (**−25 mismatch** — near-disqualifying).
- **FreeBMD** confirmation score thresholds; **AI auto-correction** consensus bar.

---

## Changelog — v2.0.0 (oracle pass)

Values authored from genealogical first principles (demography, the Genealogical
Proof Standard, UK records reality):

- **Age gap is now sex-specific** — mother 14–50 (hard female-fertility ceiling),
  father 16–60. This catches the most common false match: a grandmother
  mislabelled as a mother. (Resolves old R1 — scoring floor now equals the
  sex-specific hard minimum, so there is no longer a 12-vs-15 conflict.)
- **Distant-county minimum sources 4 → 3** (resolves old R3) — 19th-century
  migration to industrial towns was common; 4 over-rejected real ancestors.
- **Father-surname mismatch −15 → −25** — surname continuity father→child is one
  of the most reliable signals; a mismatch should be near-disqualifying.
- **Distant-county scoring penalty −15 → −18** — strengthens the geography signal.

## ⚠ REVIEW — remaining items for a human to decide on

- **R2 — Father/mother estimate not unified in every inline path.** The
  governed fallback is father −28 / mother −26, but a few discovery paths still
  inline −25. Low impact (the estimate is only a search centre with a ±5–8yr
  window), but worth tidying for consistency.
- **R4 — Common-surname source escalation is uneven** across Phase 1 / Phase 2 /
  direct search. Consider routing all of it through
  `sources.commonSurnameExtraPrimary` for one consistent policy.
- **R5 — Not every constant is rulebook-governed yet.** Still hard-coded:
  Strategy-2 direct-search `minSources` ladder, FreeBMD client score weights,
  and the inline −25 estimate in R2.

To change any value, edit `genealogy-rules.js` and bump `version` — you own the rules.
