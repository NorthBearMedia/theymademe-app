/**
 * REAL ground truth: Norton Gregory Ahlfors-Hunt's ancestry, transcribed from
 * the customer's verified 6-generation Ancestry fan chart PDF (Jan 2023).
 * The PDF is the answer key — the engine must reproduce it exactly.
 *
 * Real-world hazards baked into this family (all from the actual chart):
 *  - Subject has a DOUBLE-BARRELLED surname (Ahlfors-Hunt); father is plain Hunt.
 *  - #20 is EMPTY: Ernest Woodward (#10) was illegitimate — he carries his
 *    mother's surname (Annie Elizabeth Woodward, #21). The engine must NOT
 *    fabricate a father (a decoy "Arthur Woodward" is planted as bait).
 *  - #24 Hans Jonsson Ahlfors was born in SWEDEN (Anderslöv, Skåne) — a
 *    documented immigrant ancestor that a naive UK-only filter would reject.
 *  - TWO different "Hannah Slater"s exist (b.1864 Derby — correct for #17;
 *    b.1873 Wirksworth — a different person, planted as a decoy).
 *  - #28-31 are in Leicestershire/Middlesex (migration), #25 in London.
 */

function P(id, name, gender, byear, place, dyear, fatherId, motherId, opts = {}) {
  const sources = opts.sources !== undefined ? opts.sources : [
    { title: 'England and Wales Birth Registration Index', url: '', citation: `${name} birth ${byear}` },
    { title: '1911 England Census', url: '', citation: `${name} in ${place}` },
  ];
  return {
    id, name, gender,
    birthDate: opts.birthDate || String(byear), birthPlace: place,
    deathDate: dyear ? String(dyear) : '', deathPlace: dyear ? place : '',
    fatherId, motherId, spouseIds: opts.spouseIds || [],
    sources,
    facts: {
      birth: [{ type: 'Birth', date: String(byear), place }],
      census: byear < 1911 ? [{ type: 'Census', date: '1911', place }] : [],
      death: dyear ? [{ type: 'Death', date: String(dyear), place }] : [],
      marriage: [], residence: [], baptism: [], burial: [], other: [],
    },
  };
}

const DERBY = 'Derby, Derbyshire, England';
const BURTON = 'Burton upon Trent, Staffordshire, England';

const dataset = [
  // ── Subject + parents ───────────────────────────────────────────
  P('N1', 'Norton Gregory Ahlfors-Hunt', 'Male', 1989, DERBY, null, 'N2', 'N3',
    { birthDate: '23 August 1989' }),
  P('N2', 'Lance Alan Hunt', 'Male', 1959, DERBY, null, 'N4', 'N5', { birthDate: '1 September 1959' }),
  P('N3', 'Jane Elizabeth Ahlfors', 'Female', 1964, 'Ripley, Derbyshire, England', null, 'N6', 'N7', { birthDate: '20 April 1964' }),

  // ── Grandparents ────────────────────────────────────────────────
  P('N4', 'Norman Hunt', 'Male', 1931, DERBY, 1991, 'N8', 'N9'),
  P('N5', 'Janet Mary Woodward', 'Female', 1935, BURTON, 2017, 'N10', 'N11'),
  P('N6', 'Carl William Leslie Ahlfors', 'Male', 1936, 'Westminster, London, England', 2002, 'N12', 'N13'),
  P('N7', 'Alma May Jelley', 'Female', 1940, 'Shardlow, Derbyshire, England', null, 'N14', 'N15',
    { birthDate: '11 January 1940' }),

  // ── Great-grandparents ──────────────────────────────────────────
  P('N8', 'Frederick Hunt', 'Male', 1902, DERBY, 1999, 'N16', 'N17'),
  P('N9', 'Joy Winifred Rose', 'Female', 1904, DERBY, 1980, 'N18', 'N19'),
  P('N10', 'Ernest Woodward', 'Male', 1903, BURTON, 1968, null, 'N21'), // illegitimate — NO father
  P('N11', 'Jessie Priscilla Mayne', 'Female', 1911, BURTON, 1995, 'N22', 'N23'),
  P('N12', 'Hans Edgar Thomas Ahlfors', 'Male', 1899, 'St James, London, England', 1951, 'N24', 'N25'),
  P('N13', 'Winifred Barlow', 'Female', 1901, 'Chesterfield, Derbyshire, England', 1990, 'N26', 'N27'),
  P('N14', 'Albert Bernard Jelley', 'Male', 1915, DERBY, 1981, 'N28', 'N29'),
  P('N15', 'Gertrude May Griffin', 'Female', 1919, 'Shardlow, Derbyshire, England', 1993, 'N30', 'N31'),

  // ── Great-great-grandparents ────────────────────────────────────
  P('N16', 'William Hunt', 'Male', 1864, DERBY, 1939, null, null),
  P('N17', 'Hannah Slater', 'Female', 1864, DERBY, 1935, null, null),
  P('N18', 'Walter Rose', 'Male', 1879, DERBY, 1969, null, null),
  P('N19', 'Sarah Ann Pickering', 'Female', 1880, DERBY, 1944, null, null),
  // N20 deliberately DOES NOT EXIST — Ernest's father is unknown
  P('N21', 'Annie Elizabeth Woodward', 'Female', 1883, BURTON, 1950, null, null),
  P('N22', 'Joseph Mayne', 'Male', 1868, BURTON, 1938, null, null),
  P('N23', 'Alice Jane Renshaw', 'Female', 1879, 'Cannock Wood, Staffordshire, England', 1965, null, null),
  // Swedish immigrant: born in Sweden, lived/died in England (census + marriage there)
  P('N24', 'Hans Jonsson Ahlfors', 'Male', 1860, 'Anderslöv, Skåne, Sweden', 1937, null, null, {
    sources: [
      { title: 'Sweden, Church Records (Skåne), 1500-1941', url: '', citation: 'Hans Jonsson birth 1860 Anderslöv' },
      { title: '1911 England Census', url: '', citation: 'Hans Ahlfors, St James, London' },
      { title: 'England and Wales Marriage Registration Index', url: '', citation: 'Ahlfors-Wakefield 1898 London' },
    ],
  }),
  P('N25', 'Ada Helena Wakefield', 'Female', 1878, 'West End, London, England', 1944, null, null),
  P('N26', 'William Bernard Barlow', 'Male', 1870, 'Cannock, Staffordshire, England', 1925, null, null),
  P('N27', 'Amelia Byatt', 'Female', 1868, 'Chesterfield, Derbyshire, England', 1939, null, null),
  P('N28', 'Albert Bernard Jelley', 'Male', 1876, 'Market Harborough, Leicestershire, England', 1953, null, null, {
    sources: [
      { title: 'England and Wales Birth Registration Index', url: '', citation: 'Jelley 1876 Market Harborough' },
      { title: '1911 England Census', url: '', citation: 'Jelley, Derby' },
      { title: '1939 England and Wales Register', url: '', citation: 'Jelley, Derby' },
    ],
  }),
  P('N29', 'Priscilla Maud Fleet', 'Female', 1875, 'Middlesex, England', 1963, null, null),
  P('N30', 'Sylvanus Griffin', 'Male', 1882, DERBY, 1956, null, null),
  P('N31', 'Elizabeth Gregory', 'Female', 1882, DERBY, 1949, null, null),

  // ── DECOYS (must all be rejected) ───────────────────────────────
  P('DEC_NORMAN', 'Norman Hunt', 'Male', 1931, 'London, Middlesex, England', 2001, null, null),
  P('DEC_FRED', 'Frederick Hunt', 'Male', 1903, 'Truro, Cornwall, England', 1980, null, null),
  P('DEC_WHUNT', 'William Hunt', 'Male', 1866, 'Nottingham, Nottinghamshire, England', 1940, null, null),
  // Bait for the EMPTY #20: plausible Woodward male of the right era/place
  P('DEC_ARTHURW', 'Arthur Woodward', 'Male', 1879, BURTON, 1944, null, null),
  // Swedish emigrant cousin who went to the USA instead
  P('DEC_HANSUSA', 'Hans Ahlfors', 'Male', 1861, 'Minneapolis, Minnesota, United States', 1930, null, null),
  // The OTHER Hannah Slater (real person — she belongs to Cally's tree, not here)
  P('DEC_HSLATER', 'Hannah Slater', 'Female', 1873, 'Wirksworth, Derbyshire, England', 1953, null, null),
  P('DEC_JANE', 'Jane Ahlfors', 'Female', 1965, 'Hackney, London, England', null, null, null),
];

const groundTruth = {
  1:  { given: 'Norton', surname: 'Ahlfors-Hunt', year: 1989, county: 'Derbyshire' },
  2:  { given: 'Lance', surname: 'Hunt', year: 1959, county: 'Derbyshire' },
  3:  { given: 'Jane', surname: 'Ahlfors', year: 1964, county: 'Derbyshire' },
  4:  { given: 'Norman', surname: 'Hunt', year: 1931, county: 'Derbyshire' },
  5:  { given: 'Janet', surname: 'Woodward', year: 1935, county: 'Staffordshire' },
  6:  { given: 'Carl', surname: 'Ahlfors', year: 1936, county: 'London' },
  7:  { given: 'Alma', surname: 'Jelley', year: 1940, county: 'Derbyshire' },
  8:  { given: 'Frederick', surname: 'Hunt', year: 1902, county: 'Derbyshire' },
  9:  { given: 'Joy', surname: 'Rose', year: 1904, county: 'Derbyshire' },
  10: { given: 'Ernest', surname: 'Woodward', year: 1903, county: 'Staffordshire' },
  11: { given: 'Jessie', surname: 'Mayne', year: 1911, county: 'Staffordshire' },
  12: { given: 'Hans', surname: 'Ahlfors', year: 1899, county: 'London' },
  13: { given: 'Winifred', surname: 'Barlow', year: 1901, county: 'Derbyshire' },
  14: { given: 'Albert', surname: 'Jelley', year: 1915, county: 'Derbyshire' },
  15: { given: 'Gertrude', surname: 'Griffin', year: 1919, county: 'Derbyshire' },
  16: { given: 'William', surname: 'Hunt', year: 1864, county: 'Derbyshire' },
  17: { given: 'Hannah', surname: 'Slater', year: 1864, county: 'Derbyshire' },
  18: { given: 'Walter', surname: 'Rose', year: 1879, county: 'Derbyshire' },
  19: { given: 'Sarah', surname: 'Pickering', year: 1880, county: 'Derbyshire' },
  20: { empty: true }, // Ernest Woodward's father is UNKNOWN — do not fabricate
  21: { given: 'Annie', surname: 'Woodward', year: 1883, county: 'Staffordshire' },
  22: { given: 'Joseph', surname: 'Mayne', year: 1868, county: 'Staffordshire' },
  23: { given: 'Alice', surname: 'Renshaw', year: 1879, county: 'Staffordshire' },
  24: { given: 'Hans', surname: 'Ahlfors', year: 1860, county: 'Skåne' },
  25: { given: 'Ada', surname: 'Wakefield', year: 1878, county: 'London' },
  26: { given: 'William', surname: 'Barlow', year: 1870, county: 'Staffordshire' },
  27: { given: 'Amelia', surname: 'Byatt', year: 1868, county: 'Derbyshire' },
  28: { given: 'Albert', surname: 'Jelley', year: 1876, county: 'Leicestershire' },
  29: { given: 'Priscilla', surname: 'Fleet', year: 1875, county: 'Middlesex' },
  30: { given: 'Sylvanus', surname: 'Griffin', year: 1882, county: 'Derbyshire' },
  31: { given: 'Elizabeth', surname: 'Gregory', year: 1882, county: 'Derbyshire' },
};

module.exports = {
  name: 'Ahlfors-Hunt (REAL tree from customer PDF — Norton\'s half)',
  generations: 4,
  input: {
    customer_name: 'Norton Ahlfors-Hunt',
    given_name: 'Norton Gregory', surname: 'Ahlfors-Hunt',
    birth_date: '23 August 1989', birth_place: DERBY,
    father_name: 'Lance Alan Hunt', mother_name: 'Jane Elizabeth Ahlfors',
    notes: 'Father: Lance Alan Hunt (1959-); Mother: Jane Elizabeth Ahlfors (1964-)',
  },
  dataset,
  groundTruth,
  opts: { birthTolerance: 6 },
};
