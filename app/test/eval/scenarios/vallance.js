/**
 * REAL ground truth: Cally Ashton Vallance's ancestry (the right half of the
 * Ahlfors-Hunt family fan chart PDF). The PDF is the answer key.
 *
 * Real-world hazards from the actual chart:
 *  - Subject born MANSFIELD (Notts); whole family in Derbyshire — adjacency.
 *  - #24 George Thomas Jackson b. CAMBRIDGE — long-distance migrant into
 *    Pinxton (Derbyshire); planted decoy "George Jackson" of London.
 *  - Jackson, Taylor, Andrews, Skinner are common surnames; John Taylor
 *    (b.1877) is about as generic as UK names get — decoy planted 1yr off.
 *  - Bertha Garner + parents in LEICESTER (adjacent county).
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

const BELPER = 'Belper, Derbyshire, England';
const ALDER = 'Alderwasley, Derbyshire, England';
const PINXTON = 'Pinxton, Derbyshire, England';
const ALFRETON = 'Alfreton, Derbyshire, England';

const dataset = [
  // ── Subject + parents ───────────────────────────────────────────
  P('V1', 'Cally Ashton Vallance', 'Female', 1990, 'Mansfield, Nottinghamshire, England', null, 'V2', 'V3',
    { birthDate: '8 August 1990' }),
  P('V2', 'David Bryan Vallance', 'Male', 1959, BELPER, null, 'V4', 'V5', { birthDate: '13 December 1959' }),
  P('V3', 'Julie Jackson', 'Female', 1962, BELPER, null, 'V6', 'V7', { birthDate: '30 December 1962' }),

  // ── Grandparents ────────────────────────────────────────────────
  P('V4', 'Bryan Arthur Vallance', 'Male', 1932, 'Bakewell, Derbyshire, England', 1998, 'V8', 'V9'),
  P('V5', 'Dorothy Rowland', 'Female', 1932, ALDER, 1999, 'V10', 'V11'),
  P('V6', 'Brian Jackson', 'Male', 1940, PINXTON, 2021, 'V12', 'V13'),
  P('V7', 'Jean Grundy', 'Female', 1942, BELPER, null, 'V14', 'V15', { birthDate: '9 November 1942' }),

  // ── Great-grandparents ──────────────────────────────────────────
  P('V8', 'John Albert Frederick Vallance', 'Male', 1894, 'Bakewell, Derbyshire, England', 1958, 'V16', 'V17'),
  P('V9', 'Bertha Garner', 'Female', 1898, 'Leicester, Leicestershire, England', 1952, 'V18', 'V19'),
  P('V10', 'James William Rowland', 'Male', 1901, ALDER, 1974, 'V20', 'V21'),
  P('V11', 'Gladys Beresford', 'Female', 1905, ALDER, 1973, 'V22', 'V23'),
  P('V12', 'Charles Herbert Jackson', 'Male', 1909, PINXTON, 1963, 'V24', 'V25'),
  P('V13', 'Ethel Skinner', 'Female', 1911, ALFRETON, 2004, 'V26', 'V27'),
  P('V14', 'Cyril Grundy', 'Male', 1911, 'Riddings, Derbyshire, England', 1975, 'V28', 'V29'),
  P('V15', 'Mary Taylor', 'Female', 1917, ALFRETON, 2000, 'V30', 'V31'),

  // ── Great-great-grandparents ────────────────────────────────────
  P('V16', 'Leo Vallance', 'Male', 1872, 'Bakewell, Derbyshire, England', 1940, null, null),
  P('V17', 'Hannah Elizabeth Bollington', 'Female', 1870, 'Crich, Derbyshire, England', 1947, null, null),
  P('V18', 'Isaac Garner', 'Male', 1876, 'Leicester, Leicestershire, England', 1960, null, null),
  P('V19', 'Rebecca Bertha Baxter', 'Female', 1867, 'Leicester, Leicestershire, England', 1939, null, null),
  P('V20', 'Joseph Thomas Rowland', 'Male', 1877, 'Wirksworth, Derbyshire, England', 1948, null, null),
  P('V21', 'Hannah Slater', 'Female', 1873, 'Wirksworth, Derbyshire, England', 1953, null, null),
  P('V22', 'John Henry Beresford', 'Male', 1880, ALDER, 1918, null, null),
  P('V23', 'Esther Millward', 'Female', 1878, 'Bonsall, Derbyshire, England', 1959, null, null),
  // Long-distance migrant: Cambridge → Pinxton. 3 primary sources (documented).
  P('V24', 'George Thomas Jackson', 'Male', 1875, 'Cambridge, Cambridgeshire, England', 1958, null, null, {
    sources: [
      { title: 'England and Wales Birth Registration Index', url: '', citation: 'Jackson 1875 Cambridge' },
      { title: '1911 England Census', url: '', citation: 'Jackson, Pinxton, Derbyshire' },
      { title: '1939 England and Wales Register', url: '', citation: 'Jackson, Pinxton' },
    ],
  }),
  P('V25', 'Emily Andrews', 'Female', 1879, 'Codnor, Derbyshire, England', 1942, null, null),
  P('V26', 'Hedley Skinner', 'Male', 1889, 'Riddings, Derbyshire, England', 1938, null, null),
  P('V27', 'Louisa Manton', 'Female', 1888, 'Ironville, Derbyshire, England', 1966, null, null),
  P('V28', 'John Grundy', 'Male', 1879, 'Somercotes, Derbyshire, England', 1946, null, null),
  P('V29', 'Kate Hannah Compton', 'Female', 1881, 'Somercotes, Derbyshire, England', 1957, null, null),
  P('V30', 'John Taylor', 'Male', 1877, 'Ironville, Derbyshire, England', 1953, null, null),
  P('V31', 'Priscilla Staniland', 'Female', 1890, ALFRETON, 1932, null, null),

  // ── DECOYS (must all be rejected) ───────────────────────────────
  P('DEC_JULIE', 'Julie Jackson', 'Female', 1963, 'Liverpool, Lancashire, England', null, null, null),
  P('DEC_JTAYLOR', 'John Taylor', 'Male', 1878, 'Maidstone, Kent, England', 1950, null, null),
  P('DEC_GJACKSON', 'George Jackson', 'Male', 1875, 'Hackney, London, England', 1955, null, null),
  P('DEC_JGRUNDY', 'John Grundy', 'Male', 1880, 'Leeds, Yorkshire, England', 1949, null, null),
  P('DEC_BRYAN', 'Bryan Vallance', 'Male', 1933, 'Bristol, Gloucestershire, England', 1995, null, null),
];

const groundTruth = {
  1:  { given: 'Cally', surname: 'Vallance', year: 1990, county: 'Nottinghamshire' },
  2:  { given: 'David', surname: 'Vallance', year: 1959, county: 'Derbyshire' },
  3:  { given: 'Julie', surname: 'Jackson', year: 1962, county: 'Derbyshire' },
  4:  { given: 'Bryan', surname: 'Vallance', year: 1932, county: 'Derbyshire' },
  5:  { given: 'Dorothy', surname: 'Rowland', year: 1932, county: 'Derbyshire' },
  6:  { given: 'Brian', surname: 'Jackson', year: 1940, county: 'Derbyshire' },
  7:  { given: 'Jean', surname: 'Grundy', year: 1942, county: 'Derbyshire' },
  8:  { given: 'John', surname: 'Vallance', year: 1894, county: 'Derbyshire' },
  9:  { given: 'Bertha', surname: 'Garner', year: 1898, county: 'Leicestershire' },
  10: { given: 'James', surname: 'Rowland', year: 1901, county: 'Derbyshire' },
  11: { given: 'Gladys', surname: 'Beresford', year: 1905, county: 'Derbyshire' },
  12: { given: 'Charles', surname: 'Jackson', year: 1909, county: 'Derbyshire' },
  13: { given: 'Ethel', surname: 'Skinner', year: 1911, county: 'Derbyshire' },
  14: { given: 'Cyril', surname: 'Grundy', year: 1911, county: 'Derbyshire' },
  15: { given: 'Mary', surname: 'Taylor', year: 1917, county: 'Derbyshire' },
  16: { given: 'Leo', surname: 'Vallance', year: 1872, county: 'Derbyshire' },
  17: { given: 'Hannah', surname: 'Bollington', year: 1870, county: 'Derbyshire' },
  18: { given: 'Isaac', surname: 'Garner', year: 1876, county: 'Leicestershire' },
  19: { given: 'Rebecca', surname: 'Baxter', year: 1867, county: 'Leicestershire' },
  20: { given: 'Joseph', surname: 'Rowland', year: 1877, county: 'Derbyshire' },
  21: { given: 'Hannah', surname: 'Slater', year: 1873, county: 'Derbyshire' },
  22: { given: 'John', surname: 'Beresford', year: 1880, county: 'Derbyshire' },
  23: { given: 'Esther', surname: 'Millward', year: 1878, county: 'Derbyshire' },
  24: { given: 'George', surname: 'Jackson', year: 1875, county: 'Cambridgeshire' },
  25: { given: 'Emily', surname: 'Andrews', year: 1879, county: 'Derbyshire' },
  26: { given: 'Hedley', surname: 'Skinner', year: 1889, county: 'Derbyshire' },
  27: { given: 'Louisa', surname: 'Manton', year: 1888, county: 'Derbyshire' },
  28: { given: 'John', surname: 'Grundy', year: 1879, county: 'Derbyshire' },
  29: { given: 'Kate', surname: 'Compton', year: 1881, county: 'Derbyshire' },
  30: { given: 'John', surname: 'Taylor', year: 1877, county: 'Derbyshire' },
  31: { given: 'Priscilla', surname: 'Staniland', year: 1890, county: 'Derbyshire' },
};

module.exports = {
  name: 'Vallance (REAL tree from customer PDF — Cally\'s half)',
  generations: 4,
  input: {
    customer_name: 'Cally Vallance',
    given_name: 'Cally Ashton', surname: 'Vallance',
    birth_date: '8 August 1990', birth_place: 'Mansfield, Nottinghamshire, England',
    father_name: 'David Bryan Vallance', mother_name: 'Julie Jackson',
    notes: 'Father: David Bryan Vallance (1959-); Mother: Julie Jackson (1962-)',
  },
  dataset,
  groundTruth,
  opts: { birthTolerance: 6 },
};
