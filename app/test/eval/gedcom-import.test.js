/**
 * GEDCOM import test.
 *
 *   node app/test/eval/gedcom-import.test.js
 *
 * Covers the parser (BOM / line endings / CONC+CONT / names / events / dates /
 * living), the ancestor walk (Ahnentafel numbering, cycles, pedigree collapse),
 * root suggestion, the intake conversion (seeded vs leads) and a ROUND TRIP of
 * toIntake().notes through the REAL parseNotesForAnchors() from research-engine.
 * Offline, no network, no database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmm-ged-'));
process.env.NODE_ENV = 'test';

const G = require('../../src/services/gedcom-import');
const { parseGedcom, suggestRoots, extractAncestors, toIntake, extractYear, MAX_BYTES } = G;

const FIX = path.join(__dirname, 'fixtures');
const readFix = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `   -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
function throwsMsg(fn, msg) {
  try { fn(); } catch (e) { return e && e.message === msg; }
  return false;
}
const J = (x) => JSON.stringify(x);
function section(t) { console.log(`\n${t}`); }

// Small GEDCOM builder: ged('0 @I1@ INDI', '1 NAME ...') -> full document.
const ged = (...lines) => ['0 HEAD', '1 CHAR UTF-8', ...lines.flat(), '0 TRLR'].join('\n');
const one = (...lines) => parseGedcom(ged(...lines), { currentYear: 2026 }).individuals.get('@I1@');
const NOW = { currentYear: 2026 };

// ─────────────────────────────────────────────────────────────────────
section('1. Guards');
check('MAX_BYTES is 15 MiB', MAX_BYTES === 15 * 1024 * 1024);
check('input over 15MB rejected (string)', throwsMsg(() => parseGedcom('a'.repeat(MAX_BYTES + 1)), 'GEDCOM too large'));
check('input over 15MB rejected (Buffer)', throwsMsg(() => parseGedcom(Buffer.alloc(MAX_BYTES + 1, 97)), 'GEDCOM too large'));
check('multi-byte text over 15MB (by bytes) rejected', throwsMsg(() => parseGedcom('é'.repeat(MAX_BYTES / 2 + 1)), 'GEDCOM too large'));
check('no 0 HEAD -> Not a GEDCOM file', throwsMsg(() => parseGedcom('0 @I1@ INDI\n1 NAME A /B/\n0 TRLR'), 'Not a GEDCOM file'));
check('HEAD but no INDI -> Not a GEDCOM file', throwsMsg(() => parseGedcom('0 HEAD\n1 CHAR UTF-8\n0 TRLR'), 'Not a GEDCOM file'));
check('JSON text -> Not a GEDCOM file', throwsMsg(() => parseGedcom('{"a":1,"b":[1,2,3]}'), 'Not a GEDCOM file'));
check('binary junk -> Not a GEDCOM file', throwsMsg(() => parseGedcom(Buffer.from([0, 1, 2, 3, 255, 254, 10, 13, 0, 9])), 'Not a GEDCOM file'));
check('empty string -> Not a GEDCOM file', throwsMsg(() => parseGedcom(''), 'Not a GEDCOM file'));
check('null / number -> Not a GEDCOM file', throwsMsg(() => parseGedcom(null), 'Not a GEDCOM file') && throwsMsg(() => parseGedcom(42), 'Not a GEDCOM file'));
{
  const srcText = fs.readFileSync(path.join(__dirname, '../../src/services/gedcom-import.js'), 'utf8');
  check('module source has no eval / Function constructor', !/\beval\s*\(/.test(srcText) && !/new\s+Function\s*\(/.test(srcText));
  check('module requires nothing (stdlib only, no I/O modules)', !/require\(/.test(srcText));
}
{
  // Prototype-pollution safety: hostile xrefs and tags are plain Map keys.
  const p = parseGedcom(ged(
    '0 @__proto__@ INDI', '1 NAME Evil /Proto/', '1 __proto__ polluted', '2 constructor x',
    '0 @constructor@ INDI', '1 NAME Ctor /Person/', '1 FAMC @toString@',
    '0 @toString@ FAM', '1 HUSB @__proto__@', '1 CHIL @constructor@',
    '0 @hasOwnProperty@ INDI', '1 NAME Has /Own/'), NOW);
  check('individuals/families are Maps', p.individuals instanceof Map && p.families instanceof Map);
  check('hostile xrefs stored as ordinary keys', p.individuals.has('@__proto__@') && p.individuals.has('@constructor@') && p.individuals.has('@hasOwnProperty@'));
  check('Object.prototype not polluted', ({}).polluted === undefined && ({}).x === undefined && Object.keys(Object.prototype).length === 0);
  check('hostile family links resolve', extractAncestors(p, '@constructor@').length === 2);
}

// ─────────────────────────────────────────────────────────────────────
section('2. Line endings, BOM, continuation, levels');
{
  const body = ['0 HEAD', '0 @I1@ INDI', '1 NAME John /Smith/', '1 SEX M', '1 BIRT', '2 DATE 1900', '0 TRLR'];
  for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r'], ['mixed', null]]) {
    let text;
    if (eol) text = body.join(eol);
    else text = body.map((l, i) => l + ['\n', '\r\n', '\r'][i % 3]).join('');
    const p = parseGedcom(text, NOW);
    const i1 = p.individuals.get('@I1@');
    check(`${label} line endings`, i1 && i1.name === 'John Smith' && i1.birth.year === 1900, i1 && i1.name);
  }
  const bom = parseGedcom('﻿' + body.join('\r\n'), NOW);
  check('UTF-8 BOM (string) + CRLF', bom.individuals.get('@I1@').name === 'John Smith' && bom.warnings.length === 0, bom.warnings);
  const bomBuf = parseGedcom(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body.join('\r\n'), 'utf8')]), NOW);
  check('UTF-8 BOM (Buffer) + CRLF', bomBuf.individuals.get('@I1@').name === 'John Smith');
  const u16 = parseGedcom(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body.join('\r\n'), 'utf16le')]), NOW);
  check('UTF-16LE with BOM (Buffer)', u16.individuals.get('@I1@').name === 'John Smith');
  const ansi = parseGedcom(Buffer.concat([Buffer.from('0 HEAD\r\n1 CHAR ANSI\r\n0 @I1@ INDI\r\n1 NAME Ren', 'latin1'), Buffer.from([0xe9]), Buffer.from(' /Dupont/\r\n0 TRLR\r\n', 'latin1')]), NOW);
  check('ANSI (windows-1252) Buffer decodes accents', ansi.individuals.get('@I1@').name === 'René Dupont', ansi.individuals.get('@I1@').name);
  check('blank lines and leading whitespace tolerated', parseGedcom(ged('', '   ', '  0 @I1@ INDI', '   1 NAME  A  /B/', ''), NOW).individuals.get('@I1@').name === 'A B');
  check('lowercase tags accepted', one('0 @I1@ indi'.replace('indi', 'INDI'), '1 name Jo /Bo/', '1 sex f', '1 birt', '2 date 1901').birth.year === 1901);
}
{
  check('CONC joins with no separator', one('0 @I1@ INDI', '1 NAME John /Smi', '2 CONC th/').surname === 'Smith');
  check('CONC keeps its leading space after the delimiter', one('0 @I1@ INDI', '1 NAME Mary /Van', '2 CONC  Der Berg/').surname === 'Van Der Berg');
  check('CONT becomes a newline, collapsed in a place', one('0 @I1@ INDI', '1 BIRT', '2 DATE 1900', '2 PLAC Leeds,', '3 CONT Yorkshire').birth.place === 'Leeds, Yorkshire');
  check('CONC at a deeper level than its parent line still continues it', one('0 @I1@ INDI', '1 BIRT', '2 DATE 12 MA', '3 CONC R 1850').birth.year === 1850);
  check('CONC then CONT then CONC in one value', one('0 @I1@ INDI', '1 BIRT', '2 PLAC Hull', '3 CONC , East', '3 CONT Yorkshire', '3 CONC , England').birth.place === 'Hull, East Yorkshire, England');
  const orphan = parseGedcom('0 HEAD\n2 CONC dangling\n0 @I1@ INDI\n1 NAME A /B/\n1 NOTE x\n2 CONT y\n0 TRLR', NOW);
  check('orphan CONC and note CONT do not crash', orphan.individuals.size === 1);
  const bad = parseGedcom(ged('0 @I1@ INDI', '1 NAME A /B/', 'garbage line', '12345 TOO MANY DIGITS', '1X NOPE'), NOW);
  check('malformed lines become warnings, not exceptions', bad.individuals.size === 1 && bad.warnings.length >= 3, bad.warnings);
  const many = parseGedcom(ged('0 @I1@ INDI', '1 NAME A /B/', Array.from({ length: 2000 }, () => 'junk')), NOW);
  check('warnings are capped', many.warnings.length <= 202 && /suppressed/.test(many.warnings[many.warnings.length - 1]), many.warnings.length);
  check('xrefs with hyphens / odd characters', parseGedcom(ged('0 @KWQ4-ZDN@ INDI', '1 NAME A /B/', '0 @I-1_x@ INDI', '1 NAME C /D/'), NOW).individuals.size === 2);
  check('deeply nested unknown tags are ignored', one('0 @I1@ INDI', '1 NAME A /B/', '1 _CUSTOM x', '2 DATE 1700', '3 PLAC Nowhere', '1 EVEN', '2 TYPE Birth', '2 DATE 1650').birth.year === null);
}

// ─────────────────────────────────────────────────────────────────────
section('3. Names');
{
  const n = (...l) => one('0 @I1@ INDI', ...l);
  let i = n('1 NAME John /Smith/');
  check("'John /Smith/'", i.given === 'John' && i.surname === 'Smith' && i.name === 'John Smith', i);
  i = n('1 NAME John //');
  check("no surname 'John //'", i.given === 'John' && i.surname === '' && i.name === 'John', i);
  i = n('1 NAME /Smith/');
  check("surname only '/Smith/'", i.given === '' && i.surname === 'Smith' && i.name === 'Smith', i);
  i = n('1 NAME John /Smith/ Jr');
  check('suffix after the surname ignored', i.given === 'John' && i.surname === 'Smith');
  i = n('1 NAME John /Smith');
  check('unclosed surname slash', i.given === 'John' && i.surname === 'Smith');
  i = n('1 NAME Mary Ann /van der Berg/');
  check('multi-word given and surname', i.given === 'Mary Ann' && i.surname === 'van der Berg' && i.name === 'Mary Ann van der Berg');
  i = n('1 NAME Zoë /Müller/');
  check('diacritics preserved', i.name === 'Zoë Müller');
  i = n('1 NAME John /Smith/', '2 GIVN John', '2 SURN Smith', '2 NICK Johnny', '2 _MARNM Jones');
  check('GIVN/SURN/NICK/_MARNM sub-tags do not change the name', i.name === 'John Smith', i);
  i = n('1 NAME John //', '2 GIVN John', '2 SURN Smith');
  check('SURN sub-tag fills a blank slash surname', i.surname === 'Smith');
  i = n('1 NAME John "Jack" /Smith/');
  check('quoted nickname stripped from given', i.given === 'John', i.given);
  i = n('1 NAME John Smith');
  check('no slashes: last word is the surname', i.given === 'John' && i.surname === 'Smith');
  i = n('1 NAME John Smith', '2 GIVN John', '2 SURN Smith');
  check('no slashes + GIVN/SURN: no duplication', i.name === 'John Smith', i.name);
  i = n('1 NAME Mary /Unknown/');
  check("placeholder surname 'Unknown' dropped", i.surname === '' && i.name === 'Mary');
  i = n('1 NAME ? /Smith/');
  check("placeholder given '?' dropped", i.given === '' && i.name === 'Smith');
  i = n('1 SEX M');
  check('INDI without NAME survives', i.name === '' && i.given === '' && i.surname === '');
  // multiple NAME records
  i = n('1 NAME Susan /Hargreaves/', '2 TYPE married', '1 NAME Susan /Whitaker/', '2 TYPE birth');
  check('married first, TYPE birth later -> birth surname', i.surname === 'Whitaker', i);
  i = n('1 NAME Bill /Brookes/', '2 TYPE aka', '1 NAME William /Brookes/');
  check('aka skipped for the first unlabelled name', i.given === 'William', i);
  i = n('1 NAME Susan /Hargreaves/', '2 TYPE married', '1 NAME Sue /Hargreaves/', '2 TYPE aka');
  check('only alt names -> falls back to the first', i.name === 'Susan Hargreaves', i);
  i = n('1 NAME Joan /Parker/', '1 NAME Joan /Hewitt/', '2 TYPE married');
  check('plain first NAME wins when later is married', i.surname === 'Parker');
  i = n('1 NAME Joan /Parker/', '2 TYPE maiden', '1 NAME Joan /Hewitt/');
  check("TYPE maiden counts as a birth name", i.surname === 'Parker');
  i = n('1 NAME Mary //', '2 _MARNM Smith', '1 _MARNM Mary /Smith/');
  check('_MARNM (sub-tag or tag) never supplies the surname', i.surname === '' && i.name === 'Mary');
  // sex
  check('sex M/F/U', n('1 SEX M').sex === 'M' && n('1 SEX F').sex === 'F' && n('1 SEX U').sex === 'U' && n('1 SEX X').sex === 'U' && n('1 NAME A /B/').sex === 'U');
  check('sex lowercase', n('1 SEX f').sex === 'F');
}

// ─────────────────────────────────────────────────────────────────────
section('4. Births, deaths, places');
{
  const n = (...l) => one('0 @I1@ INDI', ...l);
  let i = n('1 BIRT', '2 DATE 23 AUG 1989', '2 PLAC Leeds, Yorkshire, England', '1 DEAT', '2 DATE 1 MAY 2020', '2 PLAC York');
  check('BIRT/DEAT date, year, place', i.birth.date === '23 AUG 1989' && i.birth.year === 1989 && i.birth.place === 'Leeds, Yorkshire, England' &&
    i.death.date === '1 MAY 2020' && i.death.year === 2020 && i.death.place === 'York', i);
  i = n('1 CHR', '2 DATE 12 MAR 1850', '2 PLAC St Mary');
  check('CHR fallback when BIRT missing (date as given)', i.birth.date === '12 MAR 1850' && i.birth.year === 1850 && i.birth.place === 'St Mary' && i.birth.kind === 'CHR', i.birth);
  i = n('1 BAPM', '2 DATE 1851');
  check('BAPM fallback', i.birth.year === 1851 && i.birth.kind === 'BAPM');
  i = n('1 BAPM', '2 DATE 1852', '1 CHR', '2 DATE 1851');
  check('CHR preferred over BAPM', i.birth.year === 1851);
  i = n('1 CHR', '2 DATE 1851', '1 BIRT', '2 DATE 1850');
  check('BIRT preferred over CHR regardless of file order', i.birth.year === 1850 && i.birth.kind === 'BIRT');
  i = n('1 BIRT Y', '1 CHR', '2 DATE 1851');
  check('empty BIRT Y falls back to CHR', i.birth.year === 1851);
  i = n('1 BIRT', '2 DATE Unknown', '2 PLAC Hull', '1 CHR', '2 DATE 1851');
  check('BIRT without a year falls back to CHR year', i.birth.year === 1851);
  i = n('1 BIRT', '2 DATE 1850', '1 BIRT', '2 DATE 1860');
  check('repeated BIRT: first one with data wins', i.birth.year === 1850);
  i = n('1 BIRT', '2 PLAC Hull');
  check('place-only birth kept, year null', i.birth.place === 'Hull' && i.birth.year === null && i.birth.date === '');
  i = n('1 BURI', '2 DATE 1 JAN 1990', '2 PLAC Hanley');
  check('BURI fallback for death', i.death.year === 1990 && i.death.kind === 'BURI' && i.death.place === 'Hanley');
  i = n('1 CREM', '2 DATE 1991');
  check('CREM fallback for death', i.death.year === 1991);
  i = n('1 DEAT', '2 DATE 1980', '1 BURI', '2 DATE 1981');
  check('DEAT preferred over BURI', i.death.year === 1980 && i.death.kind === 'DEAT');
  i = n('1 NAME A /B/');
  check('nothing recorded -> blank date/place, null year', i.birth.date === '' && i.birth.year === null && i.birth.place === '' && i.death.year === null);
  check('PLAC with empty segments tidied', n('1 BIRT', '2 PLAC , Stoke-on-Trent, ,Staffordshire,').birth.place === 'Stoke-on-Trent, Staffordshire');
  check('PLAC sub-tags (MAP/LATI) do not leak into place', n('1 BIRT', '2 PLAC Leeds', '3 MAP', '4 LATI N53.8', '2 DATE 1900').birth.place === 'Leeds');
  check('source-citation DATE under BIRT is not the birth date', n('1 BIRT', '2 SOUR @S1@', '3 DATA', '4 DATE 2001', '2 DATE 1900').birth.year === 1900);
  check('DEAT N is not a death', n('1 BIRT', '2 DATE 1990', '1 DEAT N').living === true);
}

// ─────────────────────────────────────────────────────────────────────
section('5. Date forms');
{
  const cases = [
    ['23 AUG 1989', 1989], ['AUG 1989', 1989], ['1989', 1989], ['ABT 1902', 1902], ['EST 1902', 1902],
    ['BEF 1900', 1900], ['AFT 1900', 1900], ['BET 1900 AND 1905', 1900], ['FROM 1900 TO 1905', 1900],
    ['(1902)', 1902], ['1 JAN 1750/51', 1750], ['@#DJULIAN@ 25 MAR 1700', 1700], ['Abt. 1890', 1890], ['c.1890', 1890],
    ['1890?', 1890], ['INT 1902 (about 1900)', 1902], ['1989-08-23', 1989], ['23/08/1989', 1989], ['Sept 1975', 1975],
    ['BET 1 JAN 1901 AND 31 DEC 1905', 1901], ['  ABT   1902  ', 1902],
    ['', null], ['Unknown', null], ['??', null], ['12', null], ['0000', null], ['99999', null], ['231989', null], ['5 MAY 3000', null], ['abt', null],
  ];
  for (const [d, y] of cases) check(`extractYear(${J(d)}) = ${y}`, extractYear(d, 2026) === y, extractYear(d, 2026));
  const i = one('0 @I1@ INDI', '1 BIRT', '2 DATE BET 1900 AND 1905');
  check('original date string kept in .date, year numeric', i.birth.date === 'BET 1900 AND 1905' && i.birth.year === 1900);
  check('year is a number, not a string', typeof one('0 @I1@ INDI', '1 BIRT', '2 DATE 1900').birth.year === 'number');
}

// ─────────────────────────────────────────────────────────────────────
section('6. Living flag');
{
  const L = (...l) => one('0 @I1@ INDI', ...l).living;
  check('no DEAT, no birth year -> living', L('1 NAME A /B/') === true);
  check('no DEAT, born 2000 -> living', L('1 BIRT', '2 DATE 2000') === true);
  check('no DEAT, born 1920 (<110y) -> living', L('1 BIRT', '2 DATE 1920') === true);
  check('no DEAT, born 1917 (109y) -> living', L('1 BIRT', '2 DATE 1917') === true);
  check('no DEAT, born 1916 (exactly 110y) -> not living', L('1 BIRT', '2 DATE 1916') === false);
  check('no DEAT, born 1850 -> not living', L('1 BIRT', '2 DATE 1850') === false);
  check('DEAT with date -> not living', L('1 BIRT', '2 DATE 2000', '1 DEAT', '2 DATE 2020') === false);
  check('DEAT Y without a date -> not living', L('1 BIRT', '2 DATE 1960', '1 DEAT Y') === false);
  check('DEAT with no birth at all -> not living', L('1 DEAT', '2 DATE 1960') === false);
  check('BURI-only -> not living', L('1 BIRT', '2 DATE 1960', '1 BURI', '2 DATE 2001') === false);
  check('default currentYear used when not injected', parseGedcom(ged('0 @I1@ INDI', '1 BIRT', '2 DATE 2001', '0 @I2@ INDI', '1 BIRT', '2 DATE 1801')).individuals.get('@I1@').living === true &&
    parseGedcom(ged('0 @I1@ INDI', '1 BIRT', '2 DATE 1801')).individuals.get('@I1@').living === false);
}

// ─────────────────────────────────────────────────────────────────────
section('7. Families, FAMC choice, references');
{
  const p = parseGedcom(ged(
    '0 @I1@ INDI', '1 NAME Kid /One/', '1 FAMC @F1@',
    '0 @I2@ INDI', '1 NAME Dad /One/', '1 FAMS @F1@',
    '0 @I3@ INDI', '1 NAME Mum /Two/', '1 FAMS @F1@',
    '0 @F1@ FAM', '1 HUSB @I2@', '1 WIFE @I3@', '1 CHIL @I1@', '1 CHIL @I9@', '1 _UNKNOWN thing',
    '0 @F2@ FAM', '1 WIFE @I3@'), NOW);
  const f1 = p.families.get('@F1@');
  check('family: husb / wife / children in order', f1.id === '@F1@' && f1.husb === '@I2@' && f1.wife === '@I3@' && J(f1.children) === J(['@I1@', '@I9@']), f1);
  check('family without husb/children', p.families.get('@F2@').husb === null && p.families.get('@F2@').wife === '@I3@' && p.families.get('@F2@').children.length === 0);
  check('individual famc / fams lists', J(p.individuals.get('@I1@').famc) === J(['@F1@']) && J(p.individuals.get('@I2@').fams) === J(['@F1@']));
  check('dangling child reference reported once as a summary', p.warnings.some((w) => /family reference/.test(w)) && p.warnings.length === 1, p.warnings);
}
{
  const fam = (id, h, w, c) => [`0 ${id} FAM`, `1 HUSB ${h}`, `1 WIFE ${w}`, `1 CHIL ${c}`];
  const people = ['@H1@', '@W1@', '@H2@', '@W2@'].flatMap((x) => [`0 ${x} INDI`, `1 NAME P${x.slice(1, 3)} /X/`]);
  const mk = (famcLines) => parseGedcom(ged(
    '0 @C@ INDI', '1 NAME Child /Z/', ...famcLines, people, fam('@FA@', '@H1@', '@W1@', '@C@'), fam('@FB@', '@H2@', '@W2@', '@C@')), NOW);
  const father = (p) => extractAncestors(p, '@C@')[1].id;
  let p = mk(['1 FAMC @FA@', '2 PEDI adopted', '1 FAMC @FB@', '2 PEDI birth']);
  check('multiple FAMC: PEDI birth beats an earlier adopted', father(p) === '@H2@');
  check('famc keeps file order', J(p.individuals.get('@C@').famc) === J(['@FA@', '@FB@']));
  p = mk(['1 FAMC @FA@', '1 FAMC @FB@']);
  check('multiple FAMC, no PEDI: first listed', father(p) === '@H1@');
  p = mk(['1 FAMC @FA@', '2 PEDI adopted', '1 FAMC @FB@']);
  check('multiple FAMC: adopted loses to a PEDI-less (default birth) family', father(p) === '@H2@');
  p = mk(['1 FAMC @FA@', '2 PEDI foster', '1 FAMC @FB@', '2 PEDI sealing']);
  check('multiple non-birth FAMC: first listed', father(p) === '@H1@');
  p = mk(['1 FAMC @FA@', '2 PEDI BIRTH']);
  check('PEDI is case-insensitive', father(p) === '@H1@');
  p = mk(['1 FAMC @NOPE@', '1 FAMC @FB@']);
  check('FAMC pointing at a missing family is skipped', father(p) === '@H2@');
  p = parseGedcom(ged('0 @C@ INDI', '1 NAME Child /Z/', '0 @H@ INDI', '1 NAME Dad /Z/', '0 @FX@ FAM', '1 HUSB @H@', '1 CHIL @C@'), NOW);
  check('child listed in CHIL but without FAMC still gets its parents', extractAncestors(p, '@C@').length === 2 && J(p.individuals.get('@C@').famc) === '[]');
  p = parseGedcom(ged('0 @I1@ INDI', '1 NAME First /One/', '0 @I1@ INDI', '1 NAME Second /Two/'), NOW);
  check('duplicate xref: first kept, warned', p.individuals.get('@I1@').given === 'First' && p.warnings.some((w) => /Duplicate/.test(w)));
}

// ─────────────────────────────────────────────────────────────────────
// Fixture-based tests
const ancestryText = readFix('ancestry-hargreaves.ged');
const anc = parseGedcom(ancestryText, NOW);
const fsText = readFix('familysearch-dyson.ged');
const fsp = parseGedcom(fsText, NOW);
const messyText = readFix('messy-edge-cases.ged');
const messy = parseGedcom(messyText, NOW);

section('8. Ancestry-style fixture (4+ generations)');
{
  check('26 individuals / 12 families, no warnings', anc.individuals.size === 26 && anc.families.size === 12 && anc.warnings.length === 0, [anc.individuals.size, anc.families.size, anc.warnings]);
  const emma = anc.individuals.get('@I1@');
  check('subject parsed (Ancestry date case, place, living)', emma.name === 'Emma Louise Hargreaves' && emma.sex === 'F' && emma.birth.date === '23 Aug 1989' &&
    emma.birth.year === 1989 && emma.birth.place === 'Leeds, West Yorkshire, England' && emma.living === true);
  check('married-name second NAME ignored (Susan Whitaker)', anc.individuals.get('@I4@').surname === 'Whitaker');
  check('married-name FIRST NAME ignored when a TYPE birth exists (Margaret Pickles)', anc.individuals.get('@I6@').surname === 'Pickles');
  check('deceased not living (John d. 2009)', anc.individuals.get('@I5@').living === false && anc.individuals.get('@I5@').death.year === 2009);
  check('ancestor with no DEAT, born 1879 -> not living', anc.individuals.get('@I20@').living === false);

  const a = extractAncestors(anc, '@I1@');
  const byAsc = new Map(a.map((x) => [x.asc, x]));
  check('24 ancestors found incl. subject', a.length === 24, a.length);
  check('sorted by asc ascending, asc unique', a.every((x, i) => i === 0 || x.asc > a[i - 1].asc) && new Set(a.map((x) => x.asc)).size === a.length);
  const expectName = { 1: 'Emma Louise Hargreaves', 2: 'David John Hargreaves', 3: 'Susan Jane Whitaker', 4: 'John William Hargreaves', 5: 'Margaret Ann Pickles',
    6: 'Roland Arthur Whitaker', 7: 'Dorothy Mary Holland', 8: 'Frederick Hargreaves', 9: 'Ada Mary Sutcliffe', 10: 'Harold Pickles',
    11: 'Edith Mary Barraclough', 12: 'Walter Whitaker', 13: 'Annie Elizabeth Mitchell', 14: 'Albert Edward Holland', 15: 'Florence Ethel Greenwood',
    16: 'Joseph Hargreaves', 17: 'Hannah Sagar', 18: 'William Sutcliffe', 19: 'Mary Ellen Crabtree', 20: 'Ernest Pickles',
    24: 'George Whitaker', 25: 'Sarah Ann Lister', 28: 'Thomas Holland', 29: 'Eliza Ramsden' };
  const wrong = Object.entries(expectName).filter(([k, v]) => !byAsc.has(+k) || byAsc.get(+k).name !== v).map(([k]) => k);
  check('Ahnentafel numbers: every expected asc holds the right person', wrong.length === 0, wrong);
  check('gaps are simply absent (21,22,23,26,27,30,31)', [21, 22, 23, 26, 27, 30, 31].every((n) => !byAsc.has(n)));
  check('even asc = HUSB, odd asc = WIFE', a.every((x) => x.asc === 1 || (x.asc % 2 === 0 ? x.sex === 'M' : x.sex === 'F')));
  // structural invariant: for each asc N>1, the person at N>>1 descends from that family with this parent in the right slot
  const bad = [];
  for (const x of a) {
    if (x.asc === 1) continue;
    const child = byAsc.get(x.asc >> 1);
    const ci = anc.individuals.get(child.id);
    const ok = ci.famc.some((fid) => { const f = anc.families.get(fid); return (x.asc % 2 === 0 ? f.husb : f.wife) === x.id; });
    if (!ok) bad.push(x.asc);
  }
  check('2N / 2N+1 parent invariant holds for every entry', bad.length === 0, bad);
  check('entry field set', J(Object.keys(a[0]).slice(0, 13)) === J(['asc', 'id', 'name', 'given', 'surname', 'sex', 'birthDate', 'birthYear', 'birthPlace', 'birthKind', 'deathDate', 'deathYear', 'deathPlace']), Object.keys(a[0]));
  check('entry values (John, asc 4)', byAsc.get(4).birthDate === '1 Feb 1934' && byAsc.get(4).birthYear === 1934 && byAsc.get(4).birthPlace === 'Bradford, West Yorkshire, England' &&
    byAsc.get(4).deathDate === '2 Jun 2009' && byAsc.get(4).deathYear === 2009 && byAsc.get(4).deathPlace === 'Leeds, West Yorkshire, England' && byAsc.get(4).living === false);
  check('living subject has no death data', byAsc.get(1).living === true && byAsc.get(1).deathDate === '' && byAsc.get(1).deathYear === null && byAsc.get(1).deathPlace === '');
  check('bare xref accepted (I1)', extractAncestors(anc, 'I1').length === 24);
  check('maxGen=0 -> subject only', extractAncestors(anc, '@I1@', 0).length === 1);
  check('maxGen=2 -> asc 1..7', J(extractAncestors(anc, '@I1@', 2).map((x) => x.asc)) === J([1, 2, 3, 4, 5, 6, 7]));
  check('maxGen=3 -> asc 1..15 (asc < 2^(maxGen+1))', extractAncestors(anc, '@I1@', 3).length === 15 && Math.max(...extractAncestors(anc, '@I1@', 3).map((x) => x.asc)) === 15);
  check('maxGen=4 includes asc 16..31 that exist', extractAncestors(anc, '@I1@', 4).length === 24);
  check('default maxGen is 5', extractAncestors(anc, '@I1@').length === extractAncestors(anc, '@I1@', 5).length);
  check('a mid-tree root renumbers from 1', extractAncestors(anc, '@I3@')[0].asc === 1 && extractAncestors(anc, '@I3@')[1].name === 'John William Hargreaves' && extractAncestors(anc, '@I3@').length === 12);
  check('Unknown root throws', throwsMsg(() => extractAncestors(anc, '@NOPE@'), 'Unknown root') && throwsMsg(() => extractAncestors(anc, ''), 'Unknown root') && throwsMsg(() => extractAncestors(anc, null), 'Unknown root'));
  check('rejects something that is not a parsed GEDCOM', (() => { try { extractAncestors({}, '@I1@'); } catch (e) { return e instanceof TypeError; } return false; })());
}

section('9. suggestRoots');
{
  const r = suggestRoots(anc);
  check('Ancestry: three leaf candidates, ranked', r.length === 3 && J(r.map((x) => x.id)) === J(['@I2@', '@I1@', '@I26@']), r);
  check('ancestorCount = distinct ancestors within maxGen', r[0].ancestorCount === 23 && r[1].ancestorCount === 23 && r[2].ancestorCount === 10, r);
  check('tie on ancestorCount broken by latest birth year (Thomas 1992 before Emma 1989)', r[0].birthYear === 1992 && r[1].birthYear === 1989);
  check('result shape', J(Object.keys(r[0])) === J(['id', 'name', 'birthYear', 'ancestorCount']));
  check('parents and people with no known parents are never suggested', !r.some((x) => ['@I3@', '@I4@', '@I5@', '@I9@', '@I24@'].includes(x.id)));
  const r3 = suggestRoots(anc, 3);
  check('maxGen limits the count (3 -> 14 / 10)', r3[0].ancestorCount === 14 && r3[2].ancestorCount === 10 && r3.length === 3, r3);
  check('maxGen=1 counts parents only', suggestRoots(anc, 1)[0].ancestorCount === 2);
  const fr = suggestRoots(fsp);
  check('FamilySearch: Sarah (full tree) ranks above Colin (2 ancestors)', fr.length === 2 && fr[0].id === '@KWQ4-ZDN@' && fr[0].ancestorCount === 14 && fr[1].id === '@KWQ4-ZF5@' && fr[1].ancestorCount === 2, fr);
  check('adoptive parents are not leaves and not ancestors', !fr.some((x) => /ZF6|ZF7/.test(x.id)));
}
{
  // pedigree collapse counts a shared ancestor once; leaves without birth year sort after dated ones on a tie
  const p = parseGedcom(ged(
    '0 @S@ INDI', '1 NAME Sub /Ject/', '1 BIRT', '2 DATE 2000', '1 FAMC @FS@',
    '0 @T@ INDI', '1 NAME Twin /Ject/', '1 FAMC @FS@',
    '0 @F@ INDI', '1 NAME Dad /Ject/', '1 FAMC @FF@', '1 FAMS @FS@',
    '0 @M@ INDI', '1 NAME Mum /Ject/', '1 FAMC @FM@', '1 FAMS @FS@',
    '0 @G@ INDI', '1 NAME Shared /Grandad/', '1 FAMS @FF@', '1 FAMS @FM@',
    '0 @X@ INDI', '1 NAME Nan /One/', '1 FAMS @FF@',
    '0 @Y@ INDI', '1 NAME Nan /Two/', '1 FAMS @FM@',
    '0 @FS@ FAM', '1 HUSB @F@', '1 WIFE @M@', '1 CHIL @S@', '1 CHIL @T@',
    '0 @FF@ FAM', '1 HUSB @G@', '1 WIFE @X@', '1 CHIL @F@',
    '0 @FM@ FAM', '1 HUSB @G@', '1 WIFE @Y@', '1 CHIL @M@'), NOW);
  const r = suggestRoots(p);
  check('collapsed pedigree: shared grandfather counted once (5 distinct)', r[0].ancestorCount === 5, r);
  check('undated leaf sorts after the dated one on a tie', r[0].id === '@S@' && r[1].id === '@T@' && r[1].birthYear === null, r);
}
{
  // cap at 20: thirty childless siblings
  const kids = Array.from({ length: 30 }, (_, k) => `1 CHIL @K${k + 1}@`);
  const body = ['0 @DAD@ INDI', '1 NAME Dad /Many/', '1 FAMS @FM@', '0 @MUM@ INDI', '1 NAME Mum /Many/', '1 FAMS @FM@'];
  for (let k = 1; k <= 30; k++) body.push(`0 @K${k}@ INDI`, `1 NAME Kid${k} /Many/`, '1 BIRT', `2 DATE ${1950 + k}`, '1 FAMC @FM@');
  body.push('0 @FM@ FAM', '1 HUSB @DAD@', '1 WIFE @MUM@', ...kids);
  const r = suggestRoots(parseGedcom(ged(body), NOW));
  check('at most 20 suggestions', r.length === 20, r.length);
  check('equal counts -> latest birth year first', r[0].id === '@K30@' && r[19].id === '@K11@', [r[0].id, r[19].id]);
  const noKids = parseGedcom(ged('0 @I1@ INDI', '1 NAME Solo /Person/'), NOW);
  check('no candidates -> empty array', J(suggestRoots(noKids)) === '[]');
}

section('10. FamilySearch-style fixture');
{
  check('18 individuals, hyphenated xrefs', fsp.individuals.size === 18 && fsp.individuals.has('@KWQ4-ZDN@'), fsp.individuals.size);
  const a = extractAncestors(fsp, '@KWQ4-ZDN@');
  const byAsc = new Map(a.map((x) => [x.asc, x]));
  check('15 ancestors, Peter via PEDI birth family (not the adoptive Smiths)', a.length === 15 && byAsc.get(4).name === 'Kenneth Dyson' && byAsc.get(5).name === 'Nora Eliza Booth' && !a.some((x) => /Smith/.test(x.name)), a.map((x) => x.name));
  check('asc 6/7 = maternal grandparents', byAsc.get(6).name === 'William Henry Pickersgill' && byAsc.get(7).name === 'Joan Mary Hallam');
  const harry = byAsc.get(8);
  check('CHR + BURI fallbacks (Harry Dyson)', harry.birthYear === 1889 && harry.birthKind === 'CHR' && harry.birthDate === '17 MAR 1889' && harry.deathYear === 1951 && harry.deathKind === 'BURI' && harry.living === false, harry);
  check('BET ... AND ... -> first year; AFT death year', byAsc.get(9).birthYear === 1890 && byAsc.get(9).birthDate === 'BET 1890 AND 1893' && byAsc.get(9).deathYear === 1961);
  check('BAPM + dual date 1890/91 -> 1890; BEF death', byAsc.get(10).birthYear === 1890 && byAsc.get(10).birthKind === 'BAPM' && byAsc.get(10).deathYear === 1939);
  check('EST / FROM..TO / (1896) / ABT', byAsc.get(11).birthYear === 1894 && byAsc.get(12).birthYear === 1890 && byAsc.get(13).birthYear === 1896 && byAsc.get(6).birthYear === 1921);
  check('uppercase FS date kept verbatim', byAsc.get(1).birthDate === '14 FEB 1975');
  check('PLAC with "England, United Kingdom" kept', byAsc.get(4).birthPlace === 'Sheffield, Yorkshire, England, United Kingdom');
}

section('11. Messy edge-case fixture (BOM + mixed line endings)');
{
  check('fixture really starts with a BOM and has CRLF', messyText.charCodeAt(0) === 0xfeff && messyText.includes('\r\n'));
  check('parsed without throwing, 13 individuals', messy.individuals.size === 13, messy.individuals.size);
  const g = (id) => messy.individuals.get(id);
  check('first record after BOM is intact', g('@I1@').name === 'Alice Mary Brookes');
  check('empty PLAC slots tidied; SOUR sub-date ignored', g('@I1@').birth.place === 'Stoke-on-Trent, Staffordshire' && g('@I1@').birth.year === 1975 && g('@I1@').birth.date === 'Sept 1975');
  check('DEAT Y with no date -> not living', g('@I2@').living === false && g('@I2@').birth.year === 1948);
  check("surname-only NAME '/Hewitt/'", g('@I3@').given === '' && g('@I3@').surname === 'Hewitt' && g('@I3@').name === 'Hewitt');
  check('aka + birth NAMEs -> William', g('@I4@').name === 'William Brookes');
  check('CHR + BURI fallbacks', g('@I4@').birth.year === 1920 && g('@I4@').birth.kind === 'CHR' && g('@I4@').death.year === 1990 && g('@I4@').death.kind === 'BURI' && g('@I4@').living === false);
  check("'Edith //' keeps no surname even with _MARNM", g('@I5@').name === 'Edith' && g('@I5@').surname === '');
  check('CONC/CONT note + garbage line did not disturb the record', g('@I6@').name === 'Harold Hewitt' && g('@I6@').birth.year === 1918);
  check('married name first, TYPE birth second -> Parker', g('@I7@').surname === 'Parker');
  check('indented + lowercase lines parse', g('@I11@').birth.year === 1890 && g('@I11@').sex === 'M');
  check("'DATE ?' -> no year; odd xref @I-13_x@", g('@I-13_x@').birth.year === null && g('@I-13_x@').name === 'Mary Ann Lowe');
  check('duplicate xref ignored with a warning', g('@I12@').name === '' && messy.warnings.some((w) => /Duplicate individual @I12@/.test(w)));
  check('malformed line + dangling references reported', messy.warnings.some((w) => /not a valid GEDCOM line/.test(w)) && messy.warnings.some((w) => /point to families/.test(w)) && messy.warnings.some((w) => /point to individuals/.test(w)), messy.warnings);

  const a = extractAncestors(messy, '@I1@');
  const asc = a.map((x) => x.asc);
  check('ancestors of Alice (dangling FAMC leaves asc 6 parentless)', J(asc) === J([1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 28]), asc);
  check('cycle (Leonard <-> Ernest) skipped with a warning', a.warnings.length === 1 && /Cycle detected: @I8@/.test(a.warnings[0]) && !asc.includes(56), a.warnings);
  check('cycle warning also surfaced on parsed.warnings, once', messy.warnings.filter((w) => /Cycle detected/.test(w)).length === 1 && (extractAncestors(messy, '@I1@'), messy.warnings.filter((w) => /Cycle detected/.test(w)).length === 1));
  const intake = toIntake(a);
  check('toIntake on the messy file: unusable people go to leads, nobody seeded wrongly',
    intake.given_name === 'Alice Mary' && intake.surname === 'Brookes' && intake.mother_name === 'Hewitt' && J(intake.seeded_asc) === J([1, 2, 3, 4, 5, 6, 7]) &&
    intake.lead_count === 5 && J(Object.keys(intake.leads)) === J(['8', '9', '14', '15', '28']), intake);
}
{
  // Self-parent and tiny cycles never hang
  const p = parseGedcom(ged('0 @A@ INDI', '1 NAME Self /Parent/', '1 FAMC @F@', '1 FAMS @F@', '0 @F@ FAM', '1 HUSB @A@', '1 CHIL @A@'), NOW);
  const r = extractAncestors(p, '@A@');
  check('person who is their own father: one entry + warning', r.length === 1 && r.warnings.length === 1 && /own ancestor/.test(r.warnings[0]), r.warnings);
  const p2 = parseGedcom(ged('0 @A@ INDI', '1 NAME A /X/', '1 FAMC @FA@', '1 FAMS @FB@', '0 @B@ INDI', '1 NAME B /X/', '1 FAMC @FB@', '1 FAMS @FA@',
    '0 @FA@ FAM', '1 HUSB @B@', '1 CHIL @A@', '0 @FB@ FAM', '1 HUSB @A@', '1 CHIL @B@'), NOW);
  const r2 = extractAncestors(p2, '@A@', 8);
  check('two-person cycle terminates', r2.length === 2 && r2.warnings.length === 1, r2.length);
  check('cyclic tree: suggestRoots terminates (nobody is a leaf)', J(suggestRoots(p2)) === '[]');
}
{
  // Pedigree collapse: same person at several asc numbers, every slot kept
  const p = parseGedcom(ged(
    '0 @S@ INDI', '1 NAME Sub /Ject/', '1 FAMC @FS@',
    '0 @F@ INDI', '1 NAME Dad /Ject/', '1 FAMC @FF@', '1 FAMS @FS@',
    '0 @M@ INDI', '1 NAME Mum /Ject/', '1 FAMC @FM@', '1 FAMS @FS@',
    '0 @G@ INDI', '1 NAME Shared /Grandad/', '1 FAMS @FF@', '1 FAMS @FM@',
    '0 @X@ INDI', '1 NAME Nan /One/', '1 FAMS @FF@',
    '0 @Y@ INDI', '1 NAME Nan /Two/', '1 FAMS @FM@',
    '0 @FS@ FAM', '1 HUSB @F@', '1 WIFE @M@', '1 CHIL @S@',
    '0 @FF@ FAM', '1 HUSB @G@', '1 WIFE @X@', '1 CHIL @F@',
    '0 @FM@ FAM', '1 HUSB @G@', '1 WIFE @Y@', '1 CHIL @M@'), NOW);
  const r = extractAncestors(p, '@S@');
  const g = r.filter((x) => x.id === '@G@').map((x) => x.asc);
  check('same person at asc 4 and asc 6 (both slots kept)', J(g) === J([4, 6]) && r.length === 7, g);
  check('no cycle warning for a mere collapse', r.warnings.length === 0);
  // long single-line chain: depth is bounded by maxGen, huge maxGen cannot explode
  const chain = ['0 @P0@ INDI', '1 NAME P0 /Chain/', '1 FAMC @C0@'];
  for (let k = 0; k < 40; k++) {
    chain.push(`0 @C${k}@ FAM`, `1 HUSB @P${k + 1}@`, `1 CHIL @P${k}@`);
    chain.push(`0 @P${k + 1}@ INDI`, `1 NAME P${k + 1} /Chain/`, `1 FAMC @C${k + 1}@`);
  }
  const cp = parseGedcom(ged(chain), NOW);
  check('maxGen=5 on a 40-generation chain stops at 6 entries', extractAncestors(cp, '@P0@').length === 6 && Math.max(...extractAncestors(cp, '@P0@').map((x) => x.asc)) === 32);
  const t0 = Date.now();
  const big = extractAncestors(cp, '@P0@', 100000);
  check('absurd maxGen is clamped (no blow-up)', big.length <= 8191 + 1 && Date.now() - t0 < 1000, big.length);
}

// ─────────────────────────────────────────────────────────────────────
section('12. toIntake: seeded vs leads');
const emmaAnc = extractAncestors(anc, '@I1@');
{
  const t = toIntake(emmaAnc);
  check('subject fields', t.given_name === 'Emma Louise' && t.surname === 'Hargreaves' && t.birth_date === '23 Aug 1989' && t.birth_place === 'Leeds, West Yorkshire, England' && t.death_date === '' && t.death_place === '', t);
  check('father_name / mother_name are full names', t.father_name === 'David John Hargreaves' && t.mother_name === 'Susan Jane Whitaker');
  check('result keys', J(Object.keys(t)) === J(['given_name', 'surname', 'birth_date', 'birth_place', 'death_date', 'death_place', 'father_name', 'mother_name', 'notes', 'leads', 'seeded_asc', 'lead_count', 'seed_max_asc', 'demoted_asc']), Object.keys(t));
  const lines = t.notes.split('\n');
  check('notes cover asc 4..7 only (default seedMaxAsc=7)', lines.every((l) => /^(Paternal|Maternal) GP:/.test(l)) && !/Great-grand/.test(t.notes), t.notes);
  check('notes name the four grandparents', ['John William Hargreaves', 'Margaret Ann Pickles', 'Roland Arthur Whitaker', 'Dorothy Mary Holland'].every((n) => t.notes.includes(n)));
  check('notes carry birth-death and place', t.notes.includes('John William Hargreaves (1934-2009), Bradford, West Yorkshire, England') && t.notes.includes('Dorothy Mary Holland (1932-2020), Huddersfield'));
  check('parents (asc 2,3) and great-grandparents are NOT in notes', !/David John|Susan Jane|Frederick|Ada Mary|Walter|Albert/.test(t.notes));
  check('leads cover every ancestor above seedMaxAsc', J(Object.keys(t.leads).map(Number).sort((a, b) => a - b)) === J([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24, 25, 28, 29]), Object.keys(t.leads));
  check('lead_count and seeded_asc', t.lead_count === 17 && J(t.seeded_asc) === J([1, 2, 3, 4, 5, 6, 7]) && t.seed_max_asc === 7 && t.demoted_asc.length === 0);
  check('seeded and leads partition the ancestors exactly', J([...t.seeded_asc, ...Object.keys(t.leads).map(Number)].sort((x, y) => x - y)) === J(emmaAnc.map((x) => x.asc)));
  check('lead shape + values', J(Object.keys(t.leads['8'])) === J(['name', 'given', 'surname', 'birthYear', 'birthPlace', 'deathYear']) &&
    t.leads['8'].name === 'Frederick Hargreaves' && t.leads['8'].given === 'Frederick' && t.leads['8'].surname === 'Hargreaves' && t.leads['8'].birthYear === 1905 &&
    t.leads['8'].birthPlace === 'Bradford, West Yorkshire, England' && t.leads['8'].deathYear === 1975);
  check('lead with unknown death year', t.leads['19'].deathYear === null && t.leads['19'].birthYear === 1879 && t.leads['19'].birthPlace === '');
  check('lead keys are strings', Object.keys(t.leads).every((k) => typeof k === 'string' && /^\d+$/.test(k)));

  const t3 = toIntake(emmaAnc, { seedMaxAsc: 3 });
  check('seedMaxAsc=3 -> no notes, everything from asc 4 is a lead', t3.notes === '' && t3.lead_count === 21 && !!t3.leads['4'] && J(t3.seeded_asc) === J([1, 2, 3]));
  const t4 = toIntake(emmaAnc, { seedMaxAsc: 4 });
  check('seedMaxAsc=4 -> only the paternal grandfather in notes', t4.notes.split('\n').length === 1 && /^Paternal GP: John William Hargreaves/.test(t4.notes) && !!t4.leads['5']);
  const t15 = toIntake(emmaAnc, { seedMaxAsc: 15 });
  check('seedMaxAsc=15 -> great-grandparents in notes with lineage labels', /Great-grandfather \(paternal paternal\): Frederick Hargreaves \(1905-1975\)/.test(t15.notes) &&
    /Great-grandmother \(paternal paternal\): Ada Mary Sutcliffe/.test(t15.notes) && /Great-grandfather \(paternal maternal\): Harold Pickles/.test(t15.notes) &&
    /Great-grandmother \(maternal paternal\): Annie Elizabeth Mitchell/.test(t15.notes) && /Great-grandmother \(maternal maternal\): Florence Ethel Greenwood/.test(t15.notes) &&
    t15.lead_count === 9 && !t15.leads['15'] && !!t15.leads['16'], t15.notes);
  check('seedMaxAsc is clamped to 3..15 and defaults to 7', toIntake(emmaAnc, { seedMaxAsc: 99 }).seed_max_asc === 15 && toIntake(emmaAnc, { seedMaxAsc: 0 }).seed_max_asc === 3 && toIntake(emmaAnc, {}).seed_max_asc === 7 && toIntake(emmaAnc, { seedMaxAsc: 'x' }).seed_max_asc === 7);
  check('Roland Whitaker (given name ends "and") + Holland: pair written so neither is mangled', /Maternal GP: \(see next line\) and Dorothy Mary Holland \(1932-2020\)/.test(t.notes) && /Maternal GP: Roland Arthur Whitaker \(1930-1999\)/.test(t.notes), t.notes);
}
{
  // living people: keep the name, never emit death data
  const mk = (asc, name, by, extra) => {
    const toks = name.split(' ');
    return Object.assign({ asc, id: '@X' + asc + '@', name, given: toks.slice(0, -1).join(' '), surname: toks[toks.length - 1], sex: asc % 2 ? 'F' : 'M', birthDate: String(by), birthYear: by,
      birthPlace: '', deathDate: '', deathYear: null, deathPlace: '', living: false }, extra);
  };
  const list = [
    mk(1, 'Liv Subject', 1990, { living: true, deathDate: '1 JAN 2099', deathYear: 2099, deathPlace: 'Nowhere' }),
    mk(2, 'Living Father', 1960, { living: true, deathYear: 2050 }),
    mk(3, 'Mother Dead', 1962, { deathYear: 2001 }),
    mk(4, 'Gran Alive', 1940, { living: true, deathYear: 2030 }),
    mk(5, 'Gran Dead', 1941, { deathYear: 2000 }),
    mk(8, 'Great Alive', 1915, { living: true, deathYear: 2040 }),
  ];
  const t = toIntake(list);
  check('living subject: death_date/death_place blank even if the data had them', t.death_date === '' && t.death_place === '');
  check('living ancestor in notes: no death year, still named', /Paternal GP: Gran Alive \(1940-living\); and Gran Dead \(1941-2000\)/.test(t.notes), t.notes);
  check('living ancestor lead: name kept, deathYear null', t.leads['8'].name === 'Great Alive' && t.leads['8'].deathYear === null);
  check('living father: name kept', t.father_name === 'Living Father');
  const dead = toIntake([mk(1, 'Old Subject', 1900, { deathDate: '1 JAN 1980', deathYear: 1980, deathPlace: 'Leeds' })]);
  check('deceased subject keeps death data', dead.death_date === '1 JAN 1980' && dead.death_place === 'Leeds' && dead.notes === '' && dead.father_name === '' && dead.mother_name === '' && dead.lead_count === 0);
  check('no subject / bad input throws', throwsMsg(() => toIntake([mk(2, 'No Subject', 1900)]), 'No subject (asc 1) in ancestors') && (() => { try { toIntake(null); } catch (e) { return e instanceof TypeError; } return false; })());
  check('empty given handled (surname-only subject)', toIntake([{ asc: 1, name: 'Smith', given: '', surname: 'Smith' }]).surname === 'Smith' && toIntake([{ asc: 1, name: 'Cher', given: '', surname: '' }]).given_name === 'Cher');

  // demotion: ancestors the notes parser cannot carry faithfully become leads, never wrong seeds
  const dem = [
    mk(1, 'Sub Ject', 1990),
    mk(4, 'No Year', null),                       // no birth year
    mk(5, "Mary O'Brien", 1936),                  // apostrophe
    mk(6, 'John Motherwell', 1930),               // would trip the generic father/mother matcher
    mk(7, 'Zoë Müller', 1932),          // diacritics: transliterated, still seeded
    mk(10, 'Anne-Marie Smith-Jones', 1909),       // hyphens -> spaces
  ];
  dem[1].birthYear = null; dem[1].birthDate = '';
  const t2 = toIntake(dem, { seedMaxAsc: 15 });
  check('demoted_asc lists what could not be written to notes', J(t2.demoted_asc) === J([4, 5, 6]), t2.demoted_asc);
  check('demoted people are in leads with their original names', t2.leads['4'].name === 'No Year' && t2.leads['5'].name === "Mary O'Brien" && t2.leads['6'].name === 'John Motherwell');
  check('demoted people are not in seeded_asc or notes', J(t2.seeded_asc) === J([1, 7, 10]) && !/O'Brien|Motherwell|No Year/.test(t2.notes), t2);
  check('diacritics transliterated in notes only; lead keeps the original', /Zoe Muller \(1932-\)/.test(t2.notes) && !t2.leads['7']);
  check('hyphenated names written with spaces', /Anne Marie Smith Jones \(1909-\)/.test(t2.notes), t2.notes);
  check('lead_count counts demoted people', t2.lead_count === 3);
  // injection through a name: collapsed, then refused (':' and digits), no extra note lines
  const inj = toIntake([mk(1, 'Sub Ject', 1990), mk(4, 'Evil\nPaternal GP: Fake Person (1900-1950)', 1930)]);
  check('newline/label injection in a name cannot add note lines', inj.notes === '' && inj.demoted_asc.length === 1 && inj.leads['4'].name === 'Evil Paternal GP: Fake Person (1900-1950)', inj);
  const injPlace = toIntake([mk(1, 'Sub Ject', 1990), mk(4, 'Good Name', 1930, { birthPlace: 'Hull\nMaternal GP: Fake Person (1900-1950)' })]);
  check('newline/label injection in a place cannot add note lines or years', injPlace.notes.split('\n').length === 1 && !/\d{4}-\d{4}/.test(injPlace.notes) && !/[():]\s*Fake/.test(injPlace.notes), injPlace.notes);
  // pedigree collapse: both slots seeded
  const col = toIntake([mk(1, 'Sub Ject', 1990), mk(4, 'Same Person', 1930), mk(6, 'Same Person', 1930)]);
  check('same person at two asc numbers is written twice', /Paternal GP: Same Person \(1930-\)/.test(col.notes) && /Maternal GP: Same Person \(1930-\)/.test(col.notes) && J(col.seeded_asc) === J([1, 4, 6]));
}

// ─────────────────────────────────────────────────────────────────────
section('13. ROUND TRIP: toIntake().notes -> research-engine parseNotesForAnchors()');

// The engine pulls in dotenv / better-sqlite3 at load time; this offline checkout may not have
// node_modules. parseNotesForAnchors is a pure function, so stub only genuinely missing
// third-party modules and say so.
function loadEngine() {
  const target = require.resolve('../../src/services/research-engine');
  try { return { mod: require(target), stubbed: [] }; } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; }
  const orig = Module._load;
  const stubbed = [];
  Module._load = function (request) {
    try { return orig.apply(this, arguments); } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && !request.startsWith('.') && !path.isAbsolute(request) && !request.startsWith('node:')) {
        stubbed.push(request);
        const stub = function () {};
        stub.config = () => ({});
        return stub;
      }
      throw e;
    }
  };
  try { return { mod: require(target), stubbed }; } finally { Module._load = orig; }
}

let engine = null;
try {
  const loaded = loadEngine();
  engine = loaded.mod;
  console.log(`  (research-engine loaded${loaded.stubbed.length ? `; missing deps stubbed for this offline run: ${[...new Set(loaded.stubbed)].join(', ')}` : ''})`);
} catch (e) {
  check('research-engine loads for the round-trip test', false, e.message);
}

if (engine) {
  const parseNotes = engine.parseNotesForAnchors;
  // expected anchor for an ancestor, as the notes carry it
  function compare(label, ancestors, opts, expectOverride) {
    const t = toIntake(ancestors, opts);
    const anchors = parseNotes(t.notes);
    const by = new Map(ancestors.map((x) => [x.asc, x]));
    const problems = [];
    for (const asc of t.seeded_asc) {
      if (asc < 4) continue;
      const a = by.get(asc);
      const exp = (expectOverride && expectOverride[asc]) || { given: a.given, surname: a.surname };
      const got = anchors[asc];
      if (!got) { problems.push(`asc ${asc} missing`); continue; }
      if (got.givenName !== exp.given) problems.push(`asc ${asc} given ${J(got.givenName)} != ${J(exp.given)}`);
      if (got.surname !== exp.surname) problems.push(`asc ${asc} surname ${J(got.surname)} != ${J(exp.surname)}`);
      if (got.birthDate !== String(a.birthYear)) problems.push(`asc ${asc} birth ${J(got.birthDate)} != ${a.birthYear}`);
      const expDeath = a.living || !a.deathYear ? '' : String(a.deathYear);
      if (got.deathDate !== expDeath) problems.push(`asc ${asc} death ${J(got.deathDate)} != ${J(expDeath)}`);
    }
    const extra = Object.keys(anchors).map(Number).filter((n) => !t.seeded_asc.includes(n));
    if (extra.length) problems.push(`parser produced anchors for un-seeded asc ${J(extra)} (asc 2/3 pollution or leak)`);
    check(label, problems.length === 0, problems);
    return { t, anchors };
  }

  // fixtures
  compare('Ancestry fixture: asc 4-7 names + birth/death years survive the parser (seed 7)', emmaAnc, undefined);
  compare('Ancestry fixture: asc 4-15 survive the parser (seed 15)', emmaAnc, { seedMaxAsc: 15 });
  compare('Ancestry fixture: seed 5 (asc 4,5 only)', emmaAnc, { seedMaxAsc: 5 });
  compare('Ancestry fixture: seed 4', emmaAnc, { seedMaxAsc: 4 });
  const fsAnc = extractAncestors(fsp, '@KWQ4-ZDN@');
  compare('FamilySearch fixture: seed 7', fsAnc);
  compare('FamilySearch fixture: seed 15 (ABT/EST/BET years, CHR/BURI fallbacks)', fsAnc, { seedMaxAsc: 15 });
  compare('Messy fixture: seed 7', extractAncestors(messy, '@I1@'), undefined, { 5: { given: 'Edith', surname: '' } });

  // regression guard for the parser sharp edges the chosen layout avoids
  const { anchors: aEm } = compare('(guard) no asc 2/3 pollution from grandparent lines', emmaAnc);
  check('(guard) anchors 2 and 3 are not invented from the grandparent lines', aEm[2] === undefined && aEm[3] === undefined, Object.keys(aEm));

  // synthetic hard names
  const mk = (asc, name, by, dy, place, living) => {
    const toks = name.split(' ');
    return { asc, id: '@H' + asc + '@', name, given: toks.slice(0, -1).join(' '), surname: toks[toks.length - 1], sex: asc % 2 ? 'F' : 'M', birthDate: String(by), birthYear: by,
      birthPlace: place || '', deathDate: dy ? String(dy) : '', deathYear: dy || null, deathPlace: '', living: !!living };
  };
  const subj = mk(1, 'Hard Subject', 1990, null, 'Leeds, England', true);
  const hard = [
    subj, mk(2, 'Peter Holland', 1960, null, '', true), mk(3, 'Wanda Chandler', 1962, null, '', true),
    mk(4, 'Roland Holland', 1934, 2009, 'Sunderland Durham, England'),
    mk(5, 'Amanda Sandford', 1936, 2015, 'Strand London, England'),
    mk(6, 'Ferdinand Smith', 1930, 1999, 'Newcastle and Gateshead, England'),
    mk(7, 'Cassandra Osborne', 1932, null, 'Holland, Lincolnshire', true),
    mk(8, 'Brandon Strand', 1905, 1975, 'Portland, England'),
    mk(9, 'Hildegarde Rowland', 1908, 1990, ''),
    mk(10, 'Leland Garland', 1909, 1980, 'Whitby'),
    mk(11, 'Alexandra Fromm', 1911, 1999),
    mk(12, 'Leonard Aldersey', 1899, 1970),
    mk(13, 'Annie Chandler', 1902, 1988),
    mk(14, 'Gerald Hand', 1903, 1977),
    mk(15, 'Beatrice Sanderson', 1905, 1991),
  ];
  compare('hard names: given names ending/containing "and"/"from"/"born" (seed 7)', hard);
  const hr = compare('hard names: seed 15', hard, { seedMaxAsc: 15 });
  check('hard names: hazardous grandfathers (Roland, Ferdinand) written with the two-line pair form', /Paternal GP: \(see next line\) and Amanda Sandford/.test(hr.t.notes) && /Paternal GP: Roland Holland/.test(hr.t.notes) &&
    /Maternal GP: \(see next line\) and Cassandra Osborne/.test(hr.t.notes) && /Maternal GP: Ferdinand Smith/.test(hr.t.notes), hr.t.notes);
  check('place text neutralised ("and" -> &, "Sunderland Durham" -> comma)', /Sunderland, Durham, England/.test(hr.t.notes) && /Strand, London/.test(hr.t.notes) && /Newcastle & Gateshead/.test(hr.t.notes), hr.t.notes);

  // grandparent presence combinations (only one of a pair, only one side, none)
  const only = (ascList) => [subj, ...hard.filter((x) => ascList.includes(x.asc))];
  for (const set of [[5], [7], [4], [6], [5, 6], [4, 7], [5, 7], [4, 5], [6, 7], [5, 6, 7], [4, 5, 6], [4, 6]]) {
    const list = only(set).map((x) => (x.asc === 6 ? mk(6, 'Fred Smith', 1930, 1999) : x));   // swap the hazard name for a plain one
    compare(`pair combination asc ${J(set)}: only these anchors, in the right slots`, list);
  }
  // lone hazardous grandfather: cannot be written safely -> lead, parser sees nothing
  const loneHazard = toIntake([subj, mk(6, 'Ferdinand Smith', 1930, 1999)]);
  check('lone grandfather whose name trips the pair matcher is demoted to a lead', loneHazard.notes === '' && J(loneHazard.demoted_asc) === J([6]) && loneHazard.leads['6'].name === 'Ferdinand Smith');
  check('...and the real parser agrees there is nothing to find', Object.keys(parseNotes(loneHazard.notes)).length === 0);
  // hazardous grandfather WITH a grandmother is fine (two-line form)
  compare('hazardous grandfather + grandmother: both recovered (two-line form)', [subj, mk(6, 'Ferdinand Smith', 1930, 1999), mk(7, 'Joan Jones', 1932, 2001)]);
  // demoted names are absent from the parser output, others unaffected
  const dm = compare('demotion keeps the rest intact', [subj, mk(4, "Mary O'Brien", 1936), mk(5, 'John Motherwell', 1930), mk(6, 'Plain Person', 1930, 1999), mk(7, 'Another Person', 1932)]);
  check('...apostrophe / Motherwell people are not seeded', J(dm.t.seeded_asc) === J([1, 6, 7]) && dm.anchors[4] === undefined && dm.anchors[5] === undefined);
  check('(guard) a surname containing "mother" does not reach asc 3 of the parser', dm.anchors[3] === undefined);
  // Informational only (not asserted, it documents somebody else's parser): why the per-person layout is not used.
  const legacy = parseNotes('Maternal grandfather: Walter Whitaker (1899-1970), Halifax\nMaternal grandmother: Annie Mitchell (1902-1988), Halifax');
  console.log(`  (info) per-person "Maternal grandfather:" lines parse today as ${J(Object.fromEntries(Object.entries(legacy).map(([k, v]) => [k, `${v.givenName} ${v.surname}`.trim()])))}` +
    ' - asc 4/5 and 2/3 are wrongly populated, which is why toIntake uses the "GP:" layout.');
}

// ─────────────────────────────────────────────────────────────────────
section('14. Performance');
{
  // Ahnentafel-shaped core of 2^14 people (family f = parents 2f,2f+1 of child f) plus
  // leaf children attached to random couples, ~50k people / ~500k lines in total.
  const N_CORE = 1 << 14;
  const N_TOTAL = 50000;
  const nFam = N_CORE >> 1;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed >> 8; };
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN'];
  const places = ['Leeds, West Yorkshire, England', 'Bradford, West Yorkshire, England', 'Halifax, West Yorkshire, England', 'York, North Yorkshire, England'];
  const out = ['0 HEAD', '1 CHAR UTF-8', '1 GEDC', '2 VERS 5.5.1'];
  const kidsOf = new Map();
  const person = (k, famc, fams) => {
    out.push(`0 @I${k}@ INDI`, `1 NAME Given${k % 997} Middle /Surname${k % 1511}/`, `2 GIVN Given${k % 997} Middle`, `2 SURN Surname${k % 1511}`, `1 SEX ${k % 2 ? 'F' : 'M'}`,
      '1 BIRT', `2 DATE ${1 + (k % 28)} ${months[k % 6]} ${1700 + (k % 300)}`, `2 PLAC ${places[k % 4]}`);
    if (k % 3) out.push('1 DEAT', `2 DATE ABT ${1760 + (k % 240)}`, `2 PLAC ${places[(k + 1) % 4]}`);
    if (famc) out.push(`1 FAMC @F${famc}@`);
    if (fams) out.push(`1 FAMS @F${fams}@`);
  };
  for (let k = 1; k < N_CORE; k++) person(k, k < nFam ? k : 0, k >= 2 ? k >> 1 : 0);
  for (let k = N_CORE; k <= N_TOTAL; k++) {
    const f = 1 + (rnd() % (nFam - 1));
    person(k, f, 0);
    if (!kidsOf.has(f)) kidsOf.set(f, []);
    kidsOf.get(f).push(k);
  }
  for (let f = 1; f < nFam; f++) {
    out.push(`0 @F${f}@ FAM`, `1 HUSB @I${2 * f}@`, `1 WIFE @I${2 * f + 1}@`, `1 CHIL @I${f}@`);
    for (const k of kidsOf.get(f) || []) out.push(`1 CHIL @I${k}@`);
  }
  out.push('0 TRLR');
  const text = out.join('\n');
  const lineCount = out.length;
  check(`synthetic file is a legal size (${(text.length / 1048576).toFixed(1)} MB, ${lineCount} lines, ${N_TOTAL} people)`, text.length < MAX_BYTES && lineCount > 200000);
  const t0 = process.hrtime.bigint();
  const p = parseGedcom(text, NOW);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  parse: ${ms.toFixed(0)} ms for ${p.individuals.size} individuals / ${p.families.size} families`);
  check('parse of a 50k-individual GEDCOM takes < 2000 ms', ms < 2000, `${ms.toFixed(0)} ms`);
  check('all 50k individuals and families parsed', p.individuals.size === N_TOTAL && p.families.size === nFam - 1, [p.individuals.size, p.families.size]);

  // 200k-line file specifically
  const small = out.slice(0, 200000);
  const t1 = process.hrtime.bigint();
  let ok = true;
  try { parseGedcom(small.join('\n') + '\n0 TRLR', NOW); } catch (e) { ok = false; }
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`  parse of a 200k-line truncated file: ${ms2.toFixed(0)} ms`);
  check('200k-line file parses well under 2 s', ok && ms2 < 1000, `${ms2.toFixed(0)} ms`);

  const t2 = process.hrtime.bigint();
  const roots = suggestRoots(p);
  const ms3 = Number(process.hrtime.bigint() - t2) / 1e6;
  console.log(`  suggestRoots over ${p.individuals.size} people: ${ms3.toFixed(0)} ms`);
  check('suggestRoots on 50k people returns a ranked top 20 in < 4 s', roots.length === 20 && roots[0].ancestorCount >= roots[19].ancestorCount && ms3 < 4000, `${ms3.toFixed(0)} ms`);
  const t3 = process.hrtime.bigint();
  const big = extractAncestors(p, roots[0].id, 8);
  const ms4 = Number(process.hrtime.bigint() - t3) / 1e6;
  check('extractAncestors(maxGen=8) on the top root is fast', big.length > 1 && ms4 < 500, `${ms4.toFixed(0)} ms, ${big.length} found`);
}

// ─────────────────────────────────────────────────────────────────────
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASSED' : fail + ' FAILED'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
