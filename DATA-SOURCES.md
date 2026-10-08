# Data sources — what is on, what is gated, and why

Status as of the v2.3.0 rulebook. Nothing here has been validated against the
live APIs yet: the build environment cannot reach them, so adapters are proven
against recorded-shape fixtures only. **The first live run is the real test.**

| Source | Default | Switch | Notes |
|---|---|---|---|
| FamilySearch tree (search, parents, spouses, sources) | on | `FS_*` | Beta endpoints until a production key is approved. |
| FamilySearch **pedigree** (Read Ancestry, 1 call for 4 generations) | **off** | `FS_USE_PEDIGREE=true` | Falls back to per-person lookups on any error. Turn on after one live comparison run. |
| FamilySearch **record hints** (internal corroboration) | **off** | `FS_RECORD_HINTS_ENABLED=true` | Needs a key that includes Records. Never displayed to customers. |
| FamilySearch **records search** | adapter only | `FS_RECORDS_SEARCH_PATH` | Path UNVERIFIED (`/platform/search/records` vs `/personas`). Not yet called by the engine. |
| Wikidata (CC0) | **on** | `WIKIDATA_ENABLED=false` to disable | Notable people only; strict unique-match corroboration. |
| Uploaded GEDCOM | on (admin) | — | Admin → Research → Import GEDCOM. Parents trusted, deeper = hints. |
| FreeBMD | **off** | `FREEBMD_ENABLED=true` | Terms forbid automated searches without written permission. Draft request is in Gmail. |
| Geni | unused | — | Wired but never queried by the engine; commercial use needs written approval. |
| Riksarkivet (Sweden) | not built | — | Endpoint exists (`data.riksarkivet.se/api/records`); parameters and church-record coverage unconfirmed. Verify with one request first. |

## Applications / permissions drafted (Gmail drafts, NOT sent)
FamilySearch third-party-provider application · Free UK Genealogy (FreeBMD) · Geni · WikiTree.

## Not usable (checked)
Ancestry (no API; community tools reverse-engineer internals — don't), MyHeritage
(API retired), Findmypast (Hints API docs archived), GRO index / FreeCEN / FreeREG
(no API; automation barred), Irish civil records (bulk barred), Old Bailey /
London Lives (non-commercial), TNA Discovery (catalogue entries only).
