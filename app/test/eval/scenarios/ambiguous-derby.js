/**
 * Adversarial scenario: candidate disambiguation for the father (#2).
 *
 * Customer states: father = Norman Hunt, b.1931, Derby.
 * FamilySearch returns TWO "Norman Hunt" of Derby:
 *   - FS_NORMAN  b.1931 (EXACT match to customer), 2 sources, FS-rank #1,
 *                linked to the REAL grandparents (Frederick Hunt / Edith Brown).
 *   - DEC_NORMAN b.1936 (5 yrs off, still in tolerance), SIX census records
 *                (more raw "source points"), FS-rank lower, linked to the
 *                WRONG grandparents (Herbert Hunt / Ada Jones, also of Derby).
 *
 * The correct answer is unambiguous to a human: pick the man whose birth year
 * matches what the customer told us. The pre-fix engine ranks candidates by raw
 * source count and a generic year ESTIMATE (ignoring the customer's stated year
 * and FamilySearch's own relevance rank), so it picks DEC_NORMAN and corrupts
 * the entire paternal line.
 */
const D = 'Derby, Derbyshire, England';

function P(id, name, gender, byear, place, dyear, fatherId, motherId, sources) {
  return {
    id, name, gender,
    birthDate: String(byear), birthPlace: place,
    deathDate: dyear ? String(dyear) : '', deathPlace: dyear ? place : '',
    fatherId, motherId, spouseIds: [],
    sources: sources || [
      { title: 'England and Wales Birth Registration Index', url: '', citation: `${name} ${byear}` },
      { title: '1911 England Census', url: '', citation: `${name} ${place}` },
    ],
    facts: {
      birth: [{ type: 'Birth', date: String(byear), place }],
      census: [{ type: 'Census', date: '1911', place }],
      death: dyear ? [{ type: 'Death', date: String(dyear), place }] : [],
      marriage: [], residence: [], baptism: [], burial: [], other: [],
    },
  };
}
// Six census records → 6 "primary" sources (inflates the raw source bonus).
const sixCensus = [2001, 1911, 1921, 1939, 1881, 1891].map(y => ({
  title: `${y} England Census`, url: '', citation: 'decoy',
}));

const dataset = [
  P('FS_JOHN', 'John Hunt', 'Male', 1960, D, null, 'FS_NORMAN', 'FS_MARY'),

  // The two competing fathers --------------------------------------
  P('FS_NORMAN', 'Norman Hunt', 'Male', 1931, D, 1998, 'FS_FRED', 'FS_EDITH'),       // CORRECT
  P('DEC_NORMAN', 'Norman Hunt', 'Male', 1936, D, 2001, 'DEC_HERBERT', 'DEC_ADA', sixCensus), // DECOY

  // Correct paternal grandparents ----------------------------------
  P('FS_FRED', 'Frederick Hunt', 'Male', 1903, D, 1971, null, null),
  P('FS_EDITH', 'Edith Brown', 'Female', 1906, D, 1980, null, null),

  // Decoy's WRONG grandparents (also Derby, so they pass validation)
  P('DEC_HERBERT', 'Herbert Hunt', 'Male', 1908, D, 1979, null, null),
  P('DEC_ADA', 'Ada Jones', 'Female', 1911, D, 1985, null, null),

  // Mother side (clean, single correct candidate) ------------------
  P('FS_MARY', 'Mary Smith', 'Female', 1933, D, 2005, 'FS_ALBERT', 'FS_FLO'),
  P('FS_ALBERT', 'Albert Smith', 'Male', 1905, D, 1975, null, null),
  P('FS_FLO', 'Florence Green', 'Female', 1908, D, 1985, null, null),
];

const groundTruth = {
  1: { given: 'John', surname: 'Hunt', year: 1960, county: 'Derbyshire' },
  2: { given: 'Norman', surname: 'Hunt', year: 1931, county: 'Derbyshire' },
  3: { given: 'Mary', surname: 'Smith', year: 1933, county: 'Derbyshire' },
  4: { given: 'Frederick', surname: 'Hunt', year: 1903, county: 'Derbyshire' },  // paternal grandfather
  5: { given: 'Edith', surname: 'Brown', year: 1906, county: 'Derbyshire' },     // paternal grandmother
  6: { given: 'Albert', surname: 'Smith', year: 1905, county: 'Derbyshire' },
  7: { given: 'Florence', surname: 'Green', year: 1908, county: 'Derbyshire' },
};

module.exports = {
  name: 'Ambiguous father — Norman Hunt of Derby (adversarial)',
  generations: 2,
  input: {
    customer_name: 'Ambiguity Test',
    given_name: 'John', surname: 'Hunt',
    birth_date: '1960', birth_place: D,
    father_name: 'Norman Hunt', mother_name: 'Mary Smith',
    notes: 'Father: Norman Hunt (1931-1998); Mother: Mary Smith (1933-2005)',
  },
  dataset,
  groundTruth,
  opts: { birthTolerance: 6 },
};
