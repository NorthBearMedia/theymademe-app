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

## Changelog — v2.2.0 (validated against the customer's REAL family tree)

The engine was tested against the real Ahlfors-Hunt fan-chart PDF (both
halves, 56 discoverable ancestors + planted decoys) and fixed until it scored
**100% precision / 100% recall on both halves**. Three rules were learned from
real failures:

- **Tree-linked ≠ direct-search evidence.** A tree LINK is itself relationship
  evidence, so a distant-county tree parent needs `distantTreeParentMinPrimary`
  (2) documentary sources, not the direct-search escalation (3). The old rule
  silently erased a whole real London→Derby migration branch (8 of 28 real
  ancestors).
- **Immigrant ancestors are real.** A non-UK-born TREE-LINKED parent (e.g. the
  real Hans Jonsson Ahlfors, b. Anderslöv, Sweden) is accepted with
  `immigrantTreeParentMinPrimary` (2) primary sources instead of being
  hard-rejected by the UK filter. Direct-search candidates with non-UK
  birthplaces are still rejected.
- **Genealogical Linkage Rule (illegitimacy protection).** A direct-search
  FATHER may only be accepted when name evidence links him to the child (known
  given name or FreeBMD triangulation). Surname + era + place alone is NEVER
  sufficient — the real tree has an illegitimate ancestor (father genuinely
  unknown) and the engine must leave that slot empty, not fabricate a stranger.

## Changelog — v2.1.0 (full-stack governance pass)

Every stage now reads the rulebook — no duplicated thresholds anywhere:

- **One source ladder.** The minimum-primary-sources policy (by generation,
  common surname, distant county, pre-1837) is now a single rulebook-driven
  helper (`minPrimarySourcesFor`) used by direct search (father + mother) and
  spouse triangulation — previously three separately hard-coded ladders.
- **Estimates unified** (resolves R2): father −28 / mother −26 everywhere;
  marriage-based father estimates use `fatherAgeAtMarriageYears` (25). Phase 1
  estimates are now sex-specific.
- **Exports governed**: PDF + GEDCOM include only `export.minConfidencePercent`
  (50, "Possible or better") — was hard-coded in three places.
- **Admin UI governed**: confidence badges, legends, fan chart and tree-card
  colours read the injected rulebook cutoffs — labels can no longer drift.
- **Manual candidate selection** now uses the rulebook's level cutoffs and
  `autoAcceptPercent` (75) instead of a looser `>50` auto-accept.
- **Dead code removed** (~1,600 lines): the superseded 6-step discovery
  pipeline (processAncestor et al.) was unreachable from `run()` and has been
  deleted — one engine, one pipeline (resolves R5's ambiguity).
- **Ops**: production refuses to boot with the default SESSION_SECRET; running
  jobs now have a progress heartbeat and are flagged "stalled" in the admin UI
  if the engine dies silently.

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

- **R4 (residual) — Phase 1 common-surname check.** Phase 1 linking requires a
  flat 2+ primary sources for common surnames; Phase 2 uses the governed ladder.
  These now agree numerically (shallow base 2), but Phase 1 doesn't apply the
  +1 surcharge. Acceptable: Phase 1 links *customer-stated* people (identity is
  already known), so the surcharge is less necessary there.
- **R6 — FreeBMD client internal match weights** (surname +40, forenames +30,
  etc.) remain in freebmd-client.js; the confirmation *thresholds* are governed.
  Migrate the weights only if you intend to tune them.

(R1, R2, R3, R5 — resolved in v2.0.0/v2.1.0.)

To change any value, edit `genealogy-rules.js` and bump `version` — you own the rules.
