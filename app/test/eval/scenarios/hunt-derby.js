/**
 * Synthetic ground-truth scenario: a 3-generation UK family from Derby.
 *
 * Customer provides: subject + both parents (asc #1-3).
 * The engine must DISCOVER grandparents (#4-7) and great-grandparents (#8-15)
 * by traversing the mock FamilySearch tree, then score them.
 *
 * Decoys (wrong people, same name, distant county) are included to test
 * whether the engine discriminates by location/age.
 */

// Helper: build a FamilySearch person with 2 primary sources + facts.
function P(id, name, gender, byear, place, dyear, fatherId, motherId, extra = {}) {
  const sources = extra.sources || [
    { title: 'England and Wales Birth Registration Index', url: '', citation: `${name} birth ${byear}` },
    { title: '1911 England Census', url: '', citation: `${name} in ${place}` },
  ];
  const facts = extra.facts || {
    birth: [{ type: 'http://gedcomx.org/Birth', date: String(byear), place }],
    census: [{ type: 'http://gedcomx.org/Census', date: '1911', place }],
    death: dyear ? [{ type: 'http://gedcomx.org/Death', date: String(dyear), place }] : [],
    marriage: [], residence: [], baptism: [], burial: [], other: [],
  };
  return {
    id, name, gender,
    birthDate: String(byear), birthPlace: place,
    deathDate: dyear ? String(dyear) : '', deathPlace: dyear ? place : '',
    fatherId, motherId, spouseIds: extra.spouseIds || [],
    sources, facts,
  };
}

const D = 'Derby, Derbyshire, England';

const dataset = [
  // Subject + parents (also present in FS, linked) -----------------
  P('FS_JOHN', 'John Hunt', 'Male', 1960, D, null, 'FS_NORMAN', 'FS_MARY'),
  P('FS_NORMAN', 'Norman Hunt', 'Male', 1931, D, 1998, 'FS_FREDERICK', 'FS_EDITH'),
  P('FS_MARY', 'Mary Smith', 'Female', 1933, D, 2005, 'FS_ALBERT', 'FS_FLORENCE'),

  // Grandparents (#4-7) -------------------------------------------
  P('FS_FREDERICK', 'Frederick Hunt', 'Male', 1903, D, 1971, 'FS_WALTER', 'FS_SARAH'),
  P('FS_EDITH', 'Edith Brown', 'Female', 1906, D, 1980, 'FS_GEORGE', 'FS_ANNIE'),
  P('FS_ALBERT', 'Albert Smith', 'Male', 1905, D, 1975, 'FS_THOMAS', 'FS_EMMA'),
  P('FS_FLORENCE', 'Florence Green', 'Female', 1908, D, 1985, 'FS_CHARLES', 'FS_LUCY'),

  // Great-grandparents (#8-15) ------------------------------------
  P('FS_WALTER', 'Walter Hunt', 'Male', 1876, D, 1945, null, null),
  P('FS_SARAH', 'Sarah Wood', 'Female', 1879, D, 1950, null, null),
  P('FS_GEORGE', 'George Brown', 'Male', 1878, D, 1948, null, null),
  P('FS_ANNIE', 'Annie Hill', 'Female', 1881, D, 1955, null, null),
  P('FS_THOMAS', 'Thomas Smith', 'Male', 1877, D, 1946, null, null),
  P('FS_EMMA', 'Emma Clark', 'Female', 1880, D, 1952, null, null),
  P('FS_CHARLES', 'Charles Green', 'Male', 1879, D, 1949, null, null),
  P('FS_LUCY', 'Lucy Ward', 'Female', 1882, D, 1958, null, null),

  // ── DECOYS: right name, wrong person (distant county / wrong age) ──
  P('DEC_NORMAN', 'Norman Hunt', 'Male', 1931, 'London, Middlesex, England', 2000, null, null),
  P('DEC_FRED', 'Frederick Hunt', 'Male', 1903, 'Truro, Cornwall, England', 1970, null, null),
  P('DEC_ALBERT', 'Albert Smith', 'Male', 1905, 'Newcastle, Northumberland, England', null, null, null,
    { sources: [] }), // no sources — should fail verification
];

const groundTruth = {
  1: { given: 'John', surname: 'Hunt', year: 1960, county: 'Derbyshire' },
  2: { given: 'Norman', surname: 'Hunt', year: 1931, county: 'Derbyshire' },
  3: { given: 'Mary', surname: 'Smith', year: 1933, county: 'Derbyshire' },
  4: { given: 'Frederick', surname: 'Hunt', year: 1903, county: 'Derbyshire' },
  5: { given: 'Edith', surname: 'Brown', year: 1906, county: 'Derbyshire' },
  6: { given: 'Albert', surname: 'Smith', year: 1905, county: 'Derbyshire' },
  7: { given: 'Florence', surname: 'Green', year: 1908, county: 'Derbyshire' },
  8: { given: 'Walter', surname: 'Hunt', year: 1876, county: 'Derbyshire' },
  9: { given: 'Sarah', surname: 'Wood', year: 1879, county: 'Derbyshire' },
  10: { given: 'George', surname: 'Brown', year: 1878, county: 'Derbyshire' },
  11: { given: 'Annie', surname: 'Hill', year: 1881, county: 'Derbyshire' },
  12: { given: 'Thomas', surname: 'Smith', year: 1877, county: 'Derbyshire' },
  13: { given: 'Emma', surname: 'Clark', year: 1880, county: 'Derbyshire' },
  14: { given: 'Charles', surname: 'Green', year: 1879, county: 'Derbyshire' },
  15: { given: 'Lucy', surname: 'Ward', year: 1882, county: 'Derbyshire' },
};

module.exports = {
  name: 'Hunt of Derby (3 generations, synthetic)',
  generations: 3,
  input: {
    customer_name: 'Hunt Test',
    given_name: 'John', surname: 'Hunt',
    birth_date: '1960', birth_place: D,
    father_name: 'Norman Hunt', mother_name: 'Mary Smith',
    notes: '',
  },
  dataset,
  groundTruth,
  opts: { birthTolerance: 6 },
};
