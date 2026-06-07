# Engine accuracy harness

Runs the **real** `ResearchEngine` fully offline — no FamilySearch token, no AI
keys, no network — against a mock FamilySearch/FreeBMD dataset and scores the
discovered ancestors against a known ground truth. This is how we measure
whether a change to the engine makes accuracy better or worse.

> Lives under `app/test/` and is **not** copied into the production Docker image
> (the Dockerfile only copies `src/`).

## Run it

```bash
cd app
node test/eval/smoke.js                 # proves the engine runs end-to-end offline
node test/eval/run.js hunt-derby        # clean 3-generation family  (expect 100%)
node test/eval/run.js ambiguous-derby   # adversarial: two same-name fathers
node test/eval/ai-consensus.test.js     # unit test for AI auto-correction consensus
node test/eval/confidence-gating.test.js # unsourced civil-era ancestors capped
node test/eval/rules-governance.test.js  # master rulebook is frozen + referenced
```

The master rulebook (single source of truth for all thresholds) lives at
`app/src/rules/genealogy-rules.js` with `app/src/rules/MASTER-RULES.md`.

Each `run.js` prints a per-slot CORRECT / WRONG / MISSING table plus
precision / recall and a machine-readable `RESULT {...}` line for diffing runs.

## How it works

- `mock-sources.js` — a fake FamilySearch source (`searchPerson`, `getParents`,
  `getSpouses`, `getPersonSources`) + a FreeBMD mock, backed by a fixture
  dataset. It also patches the two functions the engine calls directly on the
  api module (`extractFactsByType`, `getPersonSources`).
- `scenarios/*.js` — each exports `{ input, generations, dataset, groundTruth }`.
  `input` is seeded exactly like the real `POST /admin/research/start` route.
- `run.js` — seeds a temp SQLite job, runs `engine.run()`, compares to truth.

## Add a scenario

Copy a file in `scenarios/`, edit the FamilySearch `dataset` (correct people +
decoys), set the customer `input`, and fill in `groundTruth` (the answer key).
Decoys with the right name but wrong county/age/sources are how we test that the
engine discriminates correctly.

## To run against a REAL family + live FamilySearch

`run-live.js` runs the real engine against the real FamilySearch/FreeBMD APIs
and scores against your known tree — the true real-world benchmark.

```bash
cp test/eval/scenarios/my-family.example.json test/eval/scenarios/my-family.json
# edit my-family.json: input = what a customer would know; groundTruth = the answer key

FS_ACCESS_TOKEN=<authenticated token> FS_CLIENT_ID=<client id> \
  node test/eval/run-live.js test/eval/scenarios/my-family.json
```

Put in `input.notes` only what a real customer provides (parents, maybe
grandparents); put the FULL correct tree in `groundTruth`. The engine must
DISCOVER slots #4+, and the harness scores how well it did. An *authenticated*
token is required for tree traversal (an unauthenticated session only allows
search). The mock harness proves the *logic*; only a live run proves accuracy
against the messiness of real records.
