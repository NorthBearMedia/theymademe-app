'use strict';
/**
 * GEDCOM import (customer upload from Ancestry / MyHeritage / FamilySearch / ...).
 *
 * Pure functions, stdlib only, no I/O. Pipeline:
 *
 *   parseGedcom(text)               -> { individuals, families, warnings }
 *   suggestRoots(parsed)            -> candidate "subject" people, best first
 *   extractAncestors(parsed, root)  -> flat Ahnentafel list (subject = 1, father = 2N, mother = 2N+1)
 *   toIntake(ancestors, opts)       -> fields for the existing intake flow
 *
 * TRUST MODEL: everything in an uploaded GEDCOM is UNVERIFIED customer data.
 * toIntake() therefore splits the tree in two:
 *   - asc 1..seedMaxAsc  : seeded into the intake (fields + `notes`), the same
 *                          way a customer typing them into the form would be;
 *   - asc > seedMaxAsc   : returned as `leads` (hints for later cross-checking),
 *                          NEVER seeded as truth.
 *
 * NOTES FORMAT (read before editing toIntake): `notes` is consumed by
 * parseNotesForAnchors() in research-engine.js, whose regexes have sharp edges
 * that the api.js buildNotesString() layout ("Paternal grandfather: Name (y-y)
 * Town") trips over. Verified against the real function (see the round-trip
 * test), the layout below is the one that survives:
 *
 *   - asc 4-7 use the combined "Paternal GP: A (b-d) and B (b-d)" line that the
 *     parser documents. The per-person "Paternal grandfather:" label is NOT used
 *     because (1) its terminator list contains "and"/"from"/"born" with no word
 *     boundary, so "Holland"/"Chandler"/"Alexander" are truncated to "Holl"/
 *     "Ch"/"Alex", (2) its optional "paternal " prefix lets "Maternal
 *     grandfather:" be read as asc 4 when the paternal one is absent, and
 *     (3) the generic father/mother matcher fires on "grandfather: Name (y-y)"
 *     and overwrites asc 2/3 with the grandparent's data.
 *   - asc 8-15 use "Great-grandfather (paternal paternal): Name (b-d), Place".
 *   - every emitted person has a 4-digit birth year (the parsers need it);
 *     people who cannot be carried safely (no birth year, characters the parser
 *     cannot match such as apostrophes, a name containing "father"/"mother")
 *     are demoted to `leads` and listed in `demoted_asc` instead of being
 *     seeded wrongly.
 */

const MAX_BYTES = 15 * 1024 * 1024;

const MAX_WARNINGS = 200;      // cap the warnings array (hostile / garbage files)
const MAX_GEN_CAP = 12;        // 2^13 slots max for extractAncestors
const MAX_ROOT_GEN_CAP = 10;   // suggestRoots does a BFS per candidate
const MAX_ROOTS = 20;
const MAX_RECORDS = 500000;    // INDI / FAM count cap: a 15MB file can hold ~1M bare records (hundreds of MB once parsed)
const LIVING_WINDOW_YEARS = 110;

const BIRTH_TAGS = ['BIRT', 'CHR', 'BAPM', 'CHRA'];
const DEATH_TAGS = ['DEAT', 'BURI', 'CREM'];

const PLACEHOLDER_RE = /^(?:unknown|unk|\?+|\[unknown\]|<unknown>|\(unknown\)|_+|-+|n\.?\s*n\.?|no name|unnamed)$/i;

// ─── small helpers ───────────────────────────────────────────────────

/** Collapse all whitespace / control characters (incl. CONT newlines) to single spaces. */
function clean(s) {
  return s ? String(s).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim() : '';
}

function cleanPlace(s) {
  if (!s) return '';
  return String(s).split(',').map(clean).filter(Boolean).join(', ');
}

/** "@I1@" -> "@I1@"; anything else -> null. */
function pointer(value) {
  const v = value.trim();
  const n = v.length;
  if (n < 3 || v.charCodeAt(0) !== 64 || v.charCodeAt(n - 1) !== 64) return null;
  if (v.indexOf('@', 1) !== n - 1 || /\s/.test(v)) return null;
  return v;
}

function clampGen(g, dflt, cap) {
  const n = Number(g);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(cap, Math.floor(n)));
}

/**
 * Extract a 4-digit year from a GEDCOM date phrase. First year wins:
 * '23 AUG 1989', 'ABT 1902', 'BET 1900 AND 1905', 'FROM 1900 TO 1905', '(1902)',
 * '@#DJULIAN@ 1 JAN 1750/51' (-> 1750, the year as written).
 * Returns null when there is none, or when it is implausible (<1000 or in the future).
 */
function extractYear(dateStr, currentYear) {
  if (!dateStr) return null;
  const m = /(?:^|[^0-9])([0-9]{4})(?![0-9])/.exec(String(dateStr));
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const maxY = currentYear || new Date().getFullYear();
  return y >= 1000 && y <= maxY ? y : null;
}

// ─── input decoding / guards ─────────────────────────────────────────

/**
 * Optional helper for upload handlers: decode raw bytes to text, honouring
 * UTF-8 / UTF-16 BOMs and the legacy ANSI/ASCII `1 CHAR` declaration.
 * parseGedcom() also accepts a Buffer and calls this itself.
 */
function decodeGedcom(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || !ArrayBuffer.isView(input)) throw new Error('Not a GEDCOM file');
  if (input.byteLength > MAX_BYTES) throw new Error('GEDCOM too large');
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    if (swapped.length % 2) return buf.toString('utf8');
    return swapped.swap16().toString('utf16le');
  }
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0 && buf[0] !== 0) return buf.toString('utf16le'); // BOM-less UTF-16LE
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  const head = buf.toString('latin1', 0, Math.min(buf.length, 4096));
  const cs = /^\s*1\s+CHAR\s+(\S+)/im.exec(head);
  const charset = cs ? cs[1].toUpperCase() : '';
  if (/^(ANSI|ASCII|IBM|WINDOWS|CP12|ISO|LATIN|ANSEL)/.test(charset)) {
    try { return new TextDecoder('windows-1252').decode(buf); } catch (e) { return buf.toString('latin1'); }
  }
  return buf.toString('utf8');
}

function toText(input) {
  let text = input;
  if (typeof text !== 'string') text = decodeGedcom(text);
  if (text.length > MAX_BYTES) throw new Error('GEDCOM too large');
  if (text.length * 3 > MAX_BYTES && Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('GEDCOM too large');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

// ─── names ───────────────────────────────────────────────────────────

function stripNick(given) {
  return clean(given.replace(/["“”][^"“”]*["“”]/g, ' ').replace(/\([^)]*\)/g, ' '));
}

function isBirthNameType(t) { return t === 'birth' || t === 'maiden'; }
function isAltNameType(t) {
  return !!t && /married|marriage|aka|also|alias|immigra|religio|nick|adopt|other|chang|anglic|profess|stage|pen/.test(t);
}

/** Prefer TYPE birth (or maiden); else the first name that is not a married/aka-style name; else the first. */
function pickName(names) {
  let firstUsable = null;
  let firstAny = null;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (!n.value && !n.givn && !n.surn) continue;
    if (isBirthNameType(n.type)) return n;
    if (!firstAny) firstAny = n;
    if (!firstUsable && !isAltNameType(n.type)) firstUsable = n;
  }
  return firstUsable || firstAny;
}

function resolveName(n) {
  if (!n) return { given: '', surname: '' };
  let given = '';
  let surname = '';
  const v = n.value;
  const s1 = v.indexOf('/');
  if (s1 >= 0) {
    const s2 = v.indexOf('/', s1 + 1);
    given = v.slice(0, s1);
    surname = s2 >= 0 ? v.slice(s1 + 1, s2) : v.slice(s1 + 1);
  } else if (n.givn || n.surn) {
    given = n.givn || v;
    surname = n.surn;
    if (!n.givn && surname && given.toLowerCase().endsWith(surname.toLowerCase())) {
      given = given.slice(0, given.length - surname.length);
    }
  } else {
    // No slashes at all (hand-edited / non-conforming export): treat the last word as the surname.
    given = v;
    const toks = clean(v).split(' ');
    if (toks.length >= 2) { surname = toks.pop(); given = toks.join(' '); }
  }
  given = stripNick(given);
  surname = clean(surname);
  if (!given && n.givn) given = stripNick(n.givn);
  if (!surname && n.surn) surname = clean(n.surn);
  if (PLACEHOLDER_RE.test(given)) given = '';
  if (PLACEHOLDER_RE.test(surname)) surname = '';
  return { given, surname };
}

// ─── parse ───────────────────────────────────────────────────────────

function pickEvent(evs, order, currentYear) {
  let firstData = null;
  for (let i = 0; i < order.length; i++) {
    const e = evs[order[i]];
    if (!e || (!e.date && !e.place)) continue;
    const year = extractYear(e.date, currentYear);
    if (year !== null) return { date: e.date, year, place: e.place, kind: order[i] };
    if (!firstData) firstData = { date: e.date, year: null, place: e.place, kind: order[i] };
  }
  return firstData || { date: '', year: null, place: '', kind: null };
}

function hasEventRecord(evs, order) {
  for (let i = 0; i < order.length; i++) {
    const e = evs[order[i]];
    if (e && !(e.neg && !e.date && !e.place)) return true; // "1 DEAT N" with nothing else is not a death
  }
  return false;
}

/**
 * Parse GEDCOM text (or a Buffer) into Maps of individuals and families.
 * @param {string|Buffer} text
 * @param {{currentYear?: number}} [opts] currentYear is injectable for deterministic `living` tests.
 */
function parseGedcom(text, opts) {
  text = toText(text);
  const currentYear = (opts && Number.isInteger(opts.currentYear)) ? opts.currentYear : new Date().getFullYear();

  const individuals = new Map();
  const families = new Map();
  const warnings = [];
  let suppressed = 0;
  const warn = (msg) => { if (warnings.length < MAX_WARNINGS) warnings.push(msg); else suppressed++; };

  let sawHead = false;
  let rec = null;      // current level-0 record being filled (INDI or FAM)
  let recType = 0;     // 1 = INDI, 2 = FAM
  let c1Kind = 0;      // what the current level-1 line is: 1 name, 2 event, 3 famc
  let c1 = null;       // the name / event object for the current level-1 line

  function newIndi(id) {
    return {
      id, names: [], sex: '',
      ev: { BIRT: null, CHR: null, BAPM: null, CHRA: null, DEAT: null, BURI: null, CREM: null },
      famc: [], pedi: [], fams: [],
    };
  }

  function finishRecord() {
    if (!rec) return;
    if (recType === 1) {
      if (individuals.has(rec.id)) { warn(`Duplicate individual ${rec.id} ignored`); return; }
      const nm = resolveName(pickName(rec.names));
      const birth = pickEvent(rec.ev, BIRTH_TAGS, currentYear);
      const death = pickEvent(rec.ev, DEATH_TAGS, currentYear);
      const living = !hasEventRecord(rec.ev, DEATH_TAGS) &&
        (birth.year === null || birth.year > currentYear - LIVING_WINDOW_YEARS);
      if (individuals.size >= MAX_RECORDS) throw new Error('GEDCOM too large');
      individuals.set(rec.id, {
        id: rec.id,
        given: nm.given,
        surname: nm.surname,
        name: nm.given && nm.surname ? `${nm.given} ${nm.surname}` : (nm.given || nm.surname),
        sex: rec.sex === 'M' || rec.sex === 'F' ? rec.sex : 'U',
        birth, death,
        famc: rec.famc,
        famcPedi: rec.pedi,   // parallel to famc: 'birth' | 'adopted' | ... | ''
        fams: rec.fams,
        living,
      });
    } else if (recType === 2) {
      if (families.has(rec.id)) { warn(`Duplicate family ${rec.id} ignored`); return; }
      if (families.size >= MAX_RECORDS) throw new Error('GEDCOM too large');
      families.set(rec.id, { id: rec.id, husb: rec.husb, wife: rec.wife, children: rec.children });
    }
  }

  function handle(level, xref, tag, value) {
    if (level === 0) {
      finishRecord();
      rec = null; recType = 0; c1 = null; c1Kind = 0;
      if (tag === 'HEAD') { sawHead = true; return; }
      if (tag === 'INDI' || tag === 'FAM') {
        if (!xref) { warn(`${tag} record without an xref ignored`); return; }
        if (tag === 'INDI') { rec = newIndi(xref); recType = 1; }
        else { rec = { id: xref, husb: null, wife: null, children: [] }; recType = 2; }
      }
      return;
    }
    if (!rec) return;

    if (recType === 1) {
      if (level === 1) {
        c1 = null; c1Kind = 0;
        switch (tag) {
          case 'NAME':
            if (rec.names.length < 20) {
              const n = { value: clean(value), type: '', givn: '', surn: '' };
              rec.names.push(n); c1 = n; c1Kind = 1;
            }
            break;
          case 'SEX':
            rec.sex = value.trim().charAt(0).toUpperCase();
            break;
          case 'BIRT': case 'CHR': case 'BAPM': case 'CHRA':
          case 'DEAT': case 'BURI': case 'CREM': {
            let e = rec.ev[tag];
            if (!e) { e = { date: '', place: '', neg: value.trim().toUpperCase() === 'N' }; rec.ev[tag] = e; }
            else if (e.date || e.place) e = { date: '', place: '', neg: false }; // repeat of an event we already have data for: discard
            c1 = e; c1Kind = 2;
            break;
          }
          case 'FAMC': {
            const p = pointer(value);
            if (p && rec.famc.length < 20) { rec.famc.push(p); rec.pedi.push(''); c1Kind = 3; }
            else if (!p) warn(`${rec.id}: bad FAMC pointer ignored`);
            break;
          }
          case 'FAMS': {
            const p = pointer(value);
            if (p && rec.fams.length < 50) rec.fams.push(p);
            else if (!p) warn(`${rec.id}: bad FAMS pointer ignored`);
            break;
          }
          default: break; // unknown tags ignored (with all their sub-lines)
        }
      } else if (level === 2) {
        if (c1Kind === 1) {
          if (tag === 'GIVN') { if (!c1.givn) c1.givn = clean(value); }
          else if (tag === 'SURN') { if (!c1.surn) c1.surn = clean(value); }
          else if (tag === 'TYPE') { if (!c1.type) c1.type = clean(value).toLowerCase(); }
          // NICK, _MARNM and everything else deliberately ignored
        } else if (c1Kind === 2) {
          if (tag === 'DATE') { if (!c1.date) c1.date = clean(value); }
          else if (tag === 'PLAC') { if (!c1.place) c1.place = cleanPlace(value); }
        } else if (c1Kind === 3 && tag === 'PEDI') {
          rec.pedi[rec.pedi.length - 1] = clean(value).toLowerCase();
        }
      }
    } else if (level === 1) {
      if (tag === 'HUSB' || tag === 'WIFE') {
        const p = pointer(value);
        if (!p) warn(`${rec.id}: bad ${tag} pointer ignored`);
        else if (tag === 'HUSB') { if (!rec.husb) rec.husb = p; }
        else if (!rec.wife) rec.wife = p;
      } else if (tag === 'CHIL') {
        const p = pointer(value);
        if (!p) warn(`${rec.id}: bad CHIL pointer ignored`);
        else if (rec.children.length < 200) rec.children.push(p);
      }
    }
  }

  const lines = text.split(/\r\n|\r|\n/);
  // One logical line is held back so that following CONC/CONT lines can be appended to it.
  let hasPending = false;
  let pLevel = 0;
  let pXref = '';
  let pTag = '';
  let pValue = '';

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const len = raw.length;
    if (len === 0) continue;
    let i = 0;
    let c;
    while (i < len && ((c = raw.charCodeAt(i)) === 32 || c === 9)) i++;
    if (i >= len) continue;

    let level = 0;
    const ds = i;
    while (i < len && i - ds < 3 && (c = raw.charCodeAt(i)) >= 48 && c <= 57) { level = level * 10 + (c - 48); i++; }
    if (i === ds || (i < len && raw.charCodeAt(i) > 32)) {
      // No level number: some broken exports wrap long values without CONT. Treat as a continuation.
      if (hasPending) pValue += '\n' + raw;
      warn(`Line ${li + 1}: not a valid GEDCOM line${hasPending ? ' (appended to previous value)' : ' (ignored)'}`);
      continue;
    }
    while (i < len && ((c = raw.charCodeAt(i)) === 32 || c === 9)) i++;

    let xref = '';
    if (level === 0 && i < len && raw.charCodeAt(i) === 64) {
      const j = raw.indexOf('@', i + 1);
      if (j > 0) {
        xref = raw.slice(i, j + 1);
        i = j + 1;
        while (i < len && ((c = raw.charCodeAt(i)) === 32 || c === 9)) i++;
      }
    }

    const ts = i;
    while (i < len && (c = raw.charCodeAt(i)) !== 32 && c !== 9) i++;
    const tag = raw.slice(ts, i).toUpperCase();
    const value = i < len ? raw.slice(i + 1) : '';   // exactly one delimiter char is skipped; CONC keeps the rest verbatim

    if (tag === 'CONC' || tag === 'CONT') {
      if (hasPending) pValue += (tag === 'CONT' ? '\n' : '') + value;
      continue;
    }
    if (hasPending) handle(pLevel, pXref, pTag, pValue);
    hasPending = true; pLevel = level; pXref = xref; pTag = tag; pValue = value;
  }
  if (hasPending) handle(pLevel, pXref, pTag, pValue);
  finishRecord();

  if (!sawHead || individuals.size === 0) throw new Error('Not a GEDCOM file');

  // Dangling references: one summary line each rather than a warning per reference.
  let badFam = 0;
  let badInd = 0;
  for (const f of families.values()) {
    if (f.husb && !individuals.has(f.husb)) badInd++;
    if (f.wife && !individuals.has(f.wife)) badInd++;
    for (let k = 0; k < f.children.length; k++) if (!individuals.has(f.children[k])) badInd++;
  }
  for (const p of individuals.values()) {
    for (let k = 0; k < p.famc.length; k++) if (!families.has(p.famc[k])) badFam++;
    for (let k = 0; k < p.fams.length; k++) if (!families.has(p.fams[k])) badFam++;
  }
  if (badInd) warn(`${badInd} family reference(s) point to individuals that are not in the file`);
  if (badFam) warn(`${badFam} individual reference(s) point to families that are not in the file`);
  if (suppressed) warnings.push(`... ${suppressed} more warning(s) suppressed`);

  return { individuals, families, warnings };
}

// ─── graph helpers (shared by suggestRoots / extractAncestors) ───────

const indexCache = new WeakMap();

function checkParsed(parsed) {
  if (!parsed || !(parsed.individuals instanceof Map) || !(parsed.families instanceof Map)) {
    throw new TypeError('Expected the result of parseGedcom()');
  }
}

function getIndex(parsed) {
  checkParsed(parsed);
  const { individuals, families } = parsed;
  let ix = indexCache.get(parsed);
  if (ix && ix.nI === individuals.size && ix.nF === families.size) return ix;
  const childToFams = new Map();      // child xref -> [fam xref]  (fallback when FAMC is missing)
  const parentsWithKids = new Set();  // xrefs that are HUSB/WIFE of a family with a real child
  for (const fam of families.values()) {
    const kids = fam.children || [];
    let real = false;
    for (let k = 0; k < kids.length; k++) {
      if (individuals.has(kids[k])) real = true;
      let a = childToFams.get(kids[k]);
      if (!a) { a = []; childToFams.set(kids[k], a); }
      a.push(fam.id);
    }
    if (real) {
      if (fam.husb) parentsWithKids.add(fam.husb);
      if (fam.wife) parentsWithKids.add(fam.wife);
    }
  }
  ix = { nI: individuals.size, nF: families.size, childToFams, parentsWithKids, parentCache: new Map() };
  indexCache.set(parsed, ix);
  return ix;
}

/**
 * The family a person descends from. Multiple FAMC: PEDI 'birth' first, then
 * no PEDI (the GEDCOM default is birth), then adopted/foster/sealing; ties go
 * to the first listed. Families with no resolvable parent are skipped.
 * Returns { fam, father, mother } or null.
 */
function resolveParents(parsed, ix, indi) {
  let r = ix.parentCache.get(indi.id);
  if (r !== undefined) return r;
  r = null;
  let bestRank = 99;
  const { individuals, families } = parsed;
  const consider = (famId, rank) => {
    const fam = families.get(famId);
    if (!fam) return;
    const father = fam.husb ? individuals.get(fam.husb) : undefined;
    const mother = fam.wife ? individuals.get(fam.wife) : undefined;
    if (!father && !mother) return;
    if (rank < bestRank) { bestRank = rank; r = { fam, father: father || null, mother: mother || null }; }
  };
  const famc = indi.famc || [];
  const pedi = indi.famcPedi || [];
  for (let k = 0; k < famc.length; k++) {
    const p = pedi[k] || '';
    consider(famc[k], p === 'birth' ? 0 : (p === '' ? 1 : 2));
  }
  if (!r) {
    const extra = ix.childToFams.get(indi.id);   // FAM lists them as CHIL but the person has no FAMC
    if (extra) for (let k = 0; k < extra.length; k++) consider(extra[k], 1);
  }
  ix.parentCache.set(indi.id, r);
  return r;
}

function hasChildren(parsed, ix, indi) {
  if (ix.parentsWithKids.has(indi.id)) return true;
  const fams = indi.fams || [];
  for (let k = 0; k < fams.length; k++) {
    const f = parsed.families.get(fams[k]);
    if (f && (f.children || []).some((c) => parsed.individuals.has(c))) return true;
  }
  return false;
}

function countAncestors(parsed, ix, root, maxGen) {
  const seen = new Set([root.id]);
  let frontier = [root];
  let count = 0;
  for (let g = 1; g <= maxGen && frontier.length; g++) {
    const next = [];
    for (let k = 0; k < frontier.length; k++) {
      const r = resolveParents(parsed, ix, frontier[k]);
      if (!r) continue;
      if (r.father && !seen.has(r.father.id)) { seen.add(r.father.id); next.push(r.father); count++; }
      if (r.mother && !seen.has(r.mother.id)) { seen.add(r.mother.id); next.push(r.mother); count++; }
    }
    frontier = next;
  }
  return count;
}

function normXref(x) {
  const s = String(x == null ? '' : x).trim();
  return s && s.charCodeAt(0) !== 64 ? `@${s}@` : s;
}

// ─── suggestRoots ────────────────────────────────────────────────────

/**
 * Candidate subjects: people with no children who have at least one known
 * parent, ranked by how many distinct ancestors sit within maxGen generations
 * (desc), then by latest birth year. At most 20.
 */
function suggestRoots(parsed, maxGen = 5) {
  const gens = clampGen(maxGen, 5, MAX_ROOT_GEN_CAP);
  const ix = getIndex(parsed);
  const out = [];
  for (const indi of parsed.individuals.values()) {
    if (hasChildren(parsed, ix, indi)) continue;
    if (!resolveParents(parsed, ix, indi)) continue;
    out.push({
      id: indi.id,
      name: indi.name,
      birthYear: indi.birth ? indi.birth.year : null,
      ancestorCount: countAncestors(parsed, ix, indi, gens),
    });
  }
  out.sort((a, b) =>
    (b.ancestorCount - a.ancestorCount) ||
    ((b.birthYear === null ? -Infinity : b.birthYear) - (a.birthYear === null ? -Infinity : a.birthYear) || 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, MAX_ROOTS);
}

// ─── extractAncestors ────────────────────────────────────────────────

function ancestorRecord(indi, asc) {
  const b = indi.birth || {};
  const d = indi.death || {};
  return {
    asc,
    id: indi.id,
    name: indi.name || '',
    given: indi.given || '',
    surname: indi.surname || '',
    sex: indi.sex || 'U',
    birthDate: b.date || '',
    birthYear: b.year == null ? null : b.year,
    birthPlace: b.place || '',
    birthKind: b.kind || null,      // 'BIRT' | 'CHR' | 'BAPM' | 'CHRA' (null when nothing recorded)
    deathDate: d.date || '',
    deathYear: d.year == null ? null : d.year,
    deathPlace: d.place || '',
    deathKind: d.kind || null,      // 'DEAT' | 'BURI' | 'CREM'
    living: !!indi.living,
  };
}

/**
 * Walk FAMC -> HUSB (asc 2N) / WIFE (asc 2N+1) from the root (asc 1) down to
 * maxGen generations (asc < 2^(maxGen+1)). A person who appears as their own
 * ancestor has that branch skipped with a warning; the same person at several
 * asc numbers (pedigree collapse) keeps every slot. Missing parents leave gaps.
 * The returned array also carries `.warnings` (and they are appended, de-duplicated, to parsed.warnings).
 */
function extractAncestors(parsed, rootXref, maxGen = 5) {
  const ix = getIndex(parsed);
  const root = parsed.individuals.get(normXref(rootXref));
  if (!root) throw new Error('Unknown root');
  const gens = clampGen(maxGen, 5, MAX_GEN_CAP);
  const limit = Math.pow(2, gens + 1);

  const out = [];
  const warnings = [];
  const path = [];

  const visit = (indi, asc) => {
    out.push(ancestorRecord(indi, asc));
    if (asc * 2 >= limit) return;
    const r = resolveParents(parsed, ix, indi);
    if (!r) return;
    path.push(indi.id);
    const pairs = [[r.father, asc * 2], [r.mother, asc * 2 + 1]];
    for (let k = 0; k < pairs.length; k++) {
      const parent = pairs[k][0];
      if (!parent) continue;
      if (path.indexOf(parent.id) !== -1) {
        warnings.push(`Cycle detected: ${parent.id} (${parent.name || 'unnamed'}) is their own ancestor; branch skipped at asc ${pairs[k][1]}`);
        continue;
      }
      visit(parent, pairs[k][1]);
    }
    path.pop();
  };
  visit(root, 1);

  out.sort((a, b) => a.asc - b.asc);
  out.warnings = warnings;
  if (Array.isArray(parsed.warnings)) {
    for (const w of warnings) {
      if (parsed.warnings.length < MAX_WARNINGS + 1 && parsed.warnings.indexOf(w) === -1) parsed.warnings.push(w);
    }
  }
  return out;
}

// ─── toIntake ────────────────────────────────────────────────────────

const LINEAGES = ['paternal paternal', 'paternal maternal', 'maternal paternal', 'maternal maternal'];

const DIACRITIC_MAP = { 'ø': 'o', 'Ø': 'O', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
  'ß': 'ss', 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L', 'þ': 'th', 'ð': 'd' };

function stripDiacritics(s) {
  return s.replace(/[ØøÆæŒœßĐđŁłÞþð]/g, (ch) => DIACRITIC_MAP[ch] || ch)
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * A name in the only shape the notes parser can carry: letters and spaces.
 * Zoe-with-diaeresis -> Zoe, "Mary-Ann" -> "Mary Ann", "J." -> "J". Returns null
 * when it cannot be carried faithfully (apostrophes, digits, ...) or when it
 * would trip the parser's generic father/mother matcher ("Motherwell").
 */
function notesName(name) {
  let n = stripDiacritics(clean(name)).replace(/[-‐-―_]+/g, ' ').replace(/\./g, '');
  n = n.replace(/\s+/g, ' ').trim();
  if (!n || n.length > 80 || !/^[A-Za-z][A-Za-z ]*$/.test(n)) return null;
  if (/father|mother/i.test(n)) return null;
  return n;
}

/** Place text that cannot be mistaken for structure by the notes parser; '' when unusable. */
function notesPlace(place) {
  let p = stripDiacritics(cleanPlace(place)).replace(/[^A-Za-z ,.'&-]/g, ' ');
  p = p.replace(/\band\b/gi, '&')            // a bare "and" would be read as the grandparent separator
    .replace(/(and)(\s)/gi, '$1,$2')         // "Sunderland Durham" -> "Sunderland, Durham"
    .replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  p = p.replace(/^[,\s]+|[,\s]+$/g, '');
  if (!p || p.length > 120 || /father|mother/i.test(p)) return '';
  return p;
}

function describeForNotes(a) {
  const name = notesName(a.name || [a.given, a.surname].filter(Boolean).join(' '));
  const by = a.birthYear;
  if (!name || !Number.isInteger(by) || by < 1000 || by > 9999) return null;
  const living = !!a.living;
  const dy = !living && Number.isInteger(a.deathYear) && a.deathYear >= 1000 && a.deathYear <= 9999 ? a.deathYear : '';
  return {
    asc: a.asc,
    name,
    text: `${name} (${by}-${living ? 'living' : dy})${notesPlace(a.birthPlace) ? `, ${notesPlace(a.birthPlace)}` : ''}`,
    // "Ferdinand Smith (1900-1950)": the parser's lazy `.*?and\s+Name2 (y-y)` would take "Smith" as the grandmother.
    hazard: /and\s+[a-z]/i.test(name),
  };
}

function leadFor(a) {
  const living = !!a.living;
  return {
    name: clean(a.name || [a.given, a.surname].filter(Boolean).join(' ')).slice(0, 120),
    given: clean(a.given).slice(0, 120),
    surname: clean(a.surname).slice(0, 120),
    birthYear: Number.isInteger(a.birthYear) ? a.birthYear : null,
    birthPlace: clean(a.birthPlace).slice(0, 200),
    deathYear: !living && Number.isInteger(a.deathYear) ? a.deathYear : null,
  };
}

/**
 * Convert an extractAncestors() result into intake fields.
 * @param {Array} ancestors
 * @param {{seedMaxAsc?: number}} [opts]  seedMaxAsc 3..15, default 7
 * @returns {{given_name, surname, birth_date, birth_place, death_date, death_place,
 *            father_name, mother_name, notes, leads, seeded_asc, lead_count,
 *            seed_max_asc, demoted_asc}}
 *   seeded_asc  - sorted asc numbers seeded (1..seedMaxAsc that made it into fields/notes)
 *   leads       - { "<asc>": {name, given, surname, birthYear, birthPlace, deathYear} } for
 *                 asc > seed_max_asc plus anything in 4..seed_max_asc that could not be
 *                 carried safely in notes (listed in demoted_asc). UNVERIFIED hints only.
 */
function toIntake(ancestors, opts) {
  if (!Array.isArray(ancestors)) throw new TypeError('toIntake expects the array returned by extractAncestors()');
  const o = opts || {};
  const seedMax = Number.isInteger(o.seedMaxAsc) ? Math.max(3, Math.min(15, o.seedMaxAsc)) : 7;

  const byAsc = new Map();
  for (const a of ancestors) {
    if (a && Number.isInteger(a.asc) && a.asc >= 1 && !byAsc.has(a.asc)) byAsc.set(a.asc, a);
  }
  const subject = byAsc.get(1);
  if (!subject) throw new Error('No subject (asc 1) in ancestors');

  const fullName = (a) => (a ? clean(a.name || [a.given, a.surname].filter(Boolean).join(' ')).slice(0, 120) : '');
  const sLiving = !!subject.living;

  const seeded = [1];
  if (byAsc.has(2)) seeded.push(2);
  if (byAsc.has(3)) seeded.push(3);

  // Which of asc 4..seedMax can be written into notes?
  const desc = new Map();
  const demoted = [];
  for (let asc = 4; asc <= seedMax; asc++) {
    const a = byAsc.get(asc);
    if (!a) continue;
    const d = describeForNotes(a);
    if (d) desc.set(asc, d); else demoted.push(asc);
  }
  // A lone grandparent whose name trips the pair matcher cannot be written safely.
  for (const [pairA, pairB] of [[4, 5], [6, 7]]) {
    const A = desc.get(pairA);
    if (A && A.hazard && !desc.get(pairB)) { desc.delete(pairA); demoted.push(pairA); }
  }

  const lines = [];
  const gpLine = (label, A, B) => {
    if (A && B) {
      return A.hazard
        ? [`${label}: (see next line) and ${B.text}`, `${label}: ${A.text}`]
        : [`${label}: ${A.text}; and ${B.text}`];
    }
    if (A) return [`${label}: ${A.text}`];
    if (B) return [`${label}: (unknown) and ${B.text}`];
    return [];
  };
  if (seedMax >= 4) lines.push(...gpLine('Paternal GP', desc.get(4), desc.get(5)));
  if (seedMax >= 6) lines.push(...gpLine('Maternal GP', desc.get(6), desc.get(7)));
  for (let asc = 8; asc <= seedMax; asc++) {
    const d = desc.get(asc);
    if (!d) continue;
    lines.push(`Great-grand${asc % 2 === 0 ? 'father' : 'mother'} (${LINEAGES[(asc >> 1) - 4]}): ${d.text}`);
  }
  for (const asc of desc.keys()) seeded.push(asc);
  seeded.sort((x, y) => x - y);

  const leads = {};
  const leadAsc = [];
  for (const asc of byAsc.keys()) if (asc > seedMax || demoted.indexOf(asc) !== -1) leadAsc.push(asc);
  leadAsc.sort((x, y) => x - y);
  for (const asc of leadAsc) leads[String(asc)] = leadFor(byAsc.get(asc));
  demoted.sort((x, y) => x - y);

  return {
    given_name: clean(subject.given) || (clean(subject.surname) ? '' : fullName(subject)),
    surname: clean(subject.surname),
    birth_date: clean(subject.birthDate),
    birth_place: clean(subject.birthPlace),
    death_date: sLiving ? '' : clean(subject.deathDate),
    death_place: sLiving ? '' : clean(subject.deathPlace),
    father_name: fullName(byAsc.get(2)),
    mother_name: fullName(byAsc.get(3)),
    notes: lines.join('\n'),
    leads,
    seeded_asc: seeded,
    lead_count: leadAsc.length,
    seed_max_asc: seedMax,
    demoted_asc: demoted,
  };
}

module.exports = {
  MAX_BYTES,
  parseGedcom,
  suggestRoots,
  extractAncestors,
  toIntake,
  // helpers worth reusing / testing directly
  extractYear,
  decodeGedcom,
};
