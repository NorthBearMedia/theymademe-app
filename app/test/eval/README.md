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
```

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

The same scorer works against live data — swap the mock sources for the real
`buildSourceRegistry()` and provide a FamilySearch token (+ optional AI keys).
This is the only way to measure true real-world accuracy; the mock proves the
*logic*, not the messiness of real records.
