// ─── County Adjacency & Town-to-County Data ─────────────────────────────────
// Historic (pre-1974) English & Welsh counties for genealogy research.
// Used to validate geographic proximity — parents should be born in
// the same or adjacent county as their child.
//
// All keys and values are lowercase. Adjacency is bidirectional.
// ─────────────────────────────────────────────────────────────────────────────

const COUNTY_NEIGHBORS = {
  // ── English Historic Counties ───────────────────────────────────────────

  'bedfordshire': [
    'buckinghamshire', 'cambridgeshire', 'hertfordshire', 'huntingdonshire', 'northamptonshire'
  ],
  'berkshire': [
    'buckinghamshire', 'gloucestershire', 'hampshire', 'middlesex', 'oxfordshire', 'surrey', 'wiltshire'
  ],
  'buckinghamshire': [
    'bedfordshire', 'berkshire', 'hertfordshire', 'middlesex', 'northamptonshire', 'oxfordshire'
  ],
  'cambridgeshire': [
    'bedfordshire', 'essex', 'hertfordshire', 'huntingdonshire', 'lincolnshire', 'norfolk', 'northamptonshire', 'suffolk'
  ],
  'cheshire': [
    'denbighshire', 'derbyshire', 'flintshire', 'lancashire', 'shropshire', 'staffordshire', 'yorkshire'
  ],
  'cornwall': [
    'devon'
  ],
  'cumberland': [
    'durham', 'lancashire', 'northumberland', 'scotland', 'westmorland'
  ],
  'derbyshire': [
    'cheshire', 'leicestershire', 'lincolnshire', 'nottinghamshire', 'staffordshire', 'warwickshire', 'yorkshire'
  ],
  'devon': [
    'cornwall', 'dorset', 'somerset'
  ],
  'dorset': [
    'devon', 'hampshire', 'somerset', 'wiltshire'
  ],
  'durham': [
    'cumberland', 'northumberland', 'westmorland', 'yorkshire'
  ],
  'essex': [
    'cambridgeshire', 'hertfordshire', 'kent', 'london', 'middlesex', 'suffolk', 'surrey'
  ],
  'gloucestershire': [
    'berkshire', 'herefordshire', 'monmouthshire', 'oxfordshire', 'somerset', 'warwickshire', 'wiltshire', 'worcestershire'
  ],
  'hampshire': [
    'berkshire', 'dorset', 'surrey', 'sussex', 'wiltshire'
  ],
  'herefordshire': [
    'breconshire', 'gloucestershire', 'monmouthshire', 'radnorshire', 'shropshire', 'worcestershire'
  ],
  'hertfordshire': [
    'bedfordshire', 'buckinghamshire', 'cambridgeshire', 'essex', 'london', 'middlesex'
  ],
  'huntingdonshire': [
    'bedfordshire', 'cambridgeshire', 'northamptonshire', 'rutland'
  ],
  'kent': [
    'essex', 'london', 'middlesex', 'surrey', 'sussex'
  ],
  'lancashire': [
    'cheshire', 'cumberland', 'westmorland', 'yorkshire'
  ],
  'leicestershire': [
    'derbyshire', 'lincolnshire', 'northamptonshire', 'nottinghamshire', 'rutland', 'staffordshire', 'warwickshire'
  ],
  'lincolnshire': [
    'cambridgeshire', 'derbyshire', 'leicestershire', 'norfolk', 'northamptonshire', 'nottinghamshire', 'rutland', 'yorkshire'
  ],
  'london': [
    'essex', 'hertfordshire', 'kent', 'middlesex', 'surrey'
  ],
  'middlesex': [
    'berkshire', 'buckinghamshire', 'essex', 'hertfordshire', 'kent', 'london', 'surrey'
  ],
  'norfolk': [
    'cambridgeshire', 'lincolnshire', 'suffolk'
  ],
  'northamptonshire': [
    'bedfordshire', 'buckinghamshire', 'cambridgeshire', 'huntingdonshire', 'leicestershire', 'lincolnshire', 'oxfordshire', 'rutland', 'warwickshire'
  ],
  'northumberland': [
    'cumberland', 'durham', 'scotland'
  ],
  'nottinghamshire': [
    'derbyshire', 'leicestershire', 'lincolnshire', 'yorkshire'
  ],
  'oxfordshire': [
    'berkshire', 'buckinghamshire', 'gloucestershire', 'northamptonshire', 'warwickshire', 'wiltshire'
  ],
  'rutland': [
    'huntingdonshire', 'leicestershire', 'lincolnshire', 'northamptonshire'
  ],
  'shropshire': [
    'cheshire', 'denbighshire', 'flintshire', 'herefordshire', 'montgomeryshire', 'radnorshire', 'staffordshire', 'worcestershire'
  ],
  'somerset': [
    'devon', 'dorset', 'gloucestershire', 'wiltshire'
  ],
  'staffordshire': [
    'cheshire', 'derbyshire', 'leicestershire', 'shropshire', 'warwickshire', 'worcestershire'
  ],
  'suffolk': [
    'cambridgeshire', 'essex', 'norfolk'
  ],
  'surrey': [
    'berkshire', 'essex', 'hampshire', 'kent', 'london', 'middlesex', 'sussex'
  ],
  'sussex': [
    'hampshire', 'kent', 'surrey'
  ],
  'warwickshire': [
    'derbyshire', 'gloucestershire', 'leicestershire', 'northamptonshire', 'oxfordshire', 'staffordshire', 'worcestershire'
  ],
  'westmorland': [
    'cumberland', 'durham', 'lancashire', 'scotland', 'yorkshire'
  ],
  'wiltshire': [
    'berkshire', 'dorset', 'gloucestershire', 'hampshire', 'oxfordshire', 'somerset'
  ],
  'worcestershire': [
    'gloucestershire', 'herefordshire', 'shropshire', 'staffordshire', 'warwickshire'
  ],
  'yorkshire': [
    'cheshire', 'derbyshire', 'durham', 'lancashire', 'lincolnshire', 'nottinghamshire', 'westmorland'
  ],

  // ── Welsh Historic Counties ─────────────────────────────────────────────

  'anglesey': [
    'caernarvonshire'
  ],
  'breconshire': [
    'carmarthenshire', 'glamorgan', 'herefordshire', 'monmouthshire', 'radnorshire'
  ],
  'caernarvonshire': [
    'anglesey', 'denbighshire', 'merionethshire'
  ],
  'cardiganshire': [
    'carmarthenshire', 'merionethshire', 'montgomeryshire', 'pembrokeshire', 'radnorshire'
  ],
  'carmarthenshire': [
    'breconshire', 'cardiganshire', 'glamorgan', 'pembrokeshire'
  ],
  'denbighshire': [
    'caernarvonshire', 'cheshire', 'flintshire', 'merionethshire', 'montgomeryshire', 'shropshire'
  ],
  'flintshire': [
    'cheshire', 'denbighshire', 'shropshire'
  ],
  'glamorgan': [
    'breconshire', 'carmarthenshire', 'monmouthshire'
  ],
  'merionethshire': [
    'caernarvonshire', 'cardiganshire', 'denbighshire', 'montgomeryshire'
  ],
  'monmouthshire': [
    'breconshire', 'glamorgan', 'gloucestershire', 'herefordshire'
  ],
  'montgomeryshire': [
    'cardiganshire', 'denbighshire', 'merionethshire', 'radnorshire', 'shropshire'
  ],
  'pembrokeshire': [
    'cardiganshire', 'carmarthenshire'
  ],
  'radnorshire': [
    'breconshire', 'cardiganshire', 'herefordshire', 'montgomeryshire', 'shropshire'
  ],

  // ── Scotland (broad mapping) ────────────────────────────────────────────

  'scotland': [
    'cumberland', 'northumberland', 'westmorland'
  ],
};


// ─── Town/City to County Mapping ────────────────────────────────────────────
// Maps major towns, cities, and registration districts to their historic
// (pre-1974) county. Used to resolve place names that don't include a county.
// ─────────────────────────────────────────────────────────────────────────────

const TOWN_TO_COUNTY = {
  // ── Derbyshire ──────────────────────────────────────────────────────────
  'derby': 'derbyshire',
  'pinxton': 'derbyshire',
  'belper': 'derbyshire',
  'alfreton': 'derbyshire',
  'riddings': 'derbyshire',
  'borrowash': 'derbyshire',
  'chesterfield': 'derbyshire',
  'buxton': 'derbyshire',
  'matlock': 'derbyshire',
  'ilkeston': 'derbyshire',
  'long eaton': 'derbyshire',
  'ripley': 'derbyshire',
  'heanor': 'derbyshire',
  'swadlincote': 'derbyshire',
  'glossop': 'derbyshire',
  'bakewell': 'derbyshire',
  'ashbourne': 'derbyshire',
  'bolsover': 'derbyshire',
  'dronfield': 'derbyshire',
  'eckington': 'derbyshire',
  'staveley': 'derbyshire',
  'clay cross': 'derbyshire',
  'south normanton': 'derbyshire',
  'somercotes': 'derbyshire',
  'wirksworth': 'derbyshire',
  'duffield': 'derbyshire',

  // ── Nottinghamshire ─────────────────────────────────────────────────────
  'nottingham': 'nottinghamshire',
  'mansfield': 'nottinghamshire',
  'newark': 'nottinghamshire',
  'worksop': 'nottinghamshire',
  'retford': 'nottinghamshire',
  'beeston': 'nottinghamshire',
  'arnold': 'nottinghamshire',
  'hucknall': 'nottinghamshire',
  'sutton in ashfield': 'nottinghamshire',
  'kirkby in ashfield': 'nottinghamshire',
  'basford': 'nottinghamshire',
  'bingham': 'nottinghamshire',
  'southwell': 'nottinghamshire',
  'eastwood': 'nottinghamshire',
  'carlton': 'nottinghamshire',

  // ── Yorkshire ───────────────────────────────────────────────────────────
  'sheffield': 'yorkshire',
  'leeds': 'yorkshire',
  'york': 'yorkshire',
  'hull': 'yorkshire',
  'bradford': 'yorkshire',
  'halifax': 'yorkshire',
  'huddersfield': 'yorkshire',
  'wakefield': 'yorkshire',
  'doncaster': 'yorkshire',
  'rotherham': 'yorkshire',
  'barnsley': 'yorkshire',
  'scarborough': 'yorkshire',
  'harrogate': 'yorkshire',
  'middlesbrough': 'yorkshire',
  'dewsbury': 'yorkshire',
  'keighley': 'yorkshire',
  'whitby': 'yorkshire',
  'beverley': 'yorkshire',
  'bridlington': 'yorkshire',
  'skipton': 'yorkshire',
  'selby': 'yorkshire',
  'richmond': 'yorkshire',    // NB: also a town in Surrey; context decides
  'ripon': 'yorkshire',
  'thirsk': 'yorkshire',
  'pontefract': 'yorkshire',
  'batley': 'yorkshire',
  'goole': 'yorkshire',
  'todmorden': 'yorkshire',
  'kingston upon hull': 'yorkshire',

  // ── Lancashire ──────────────────────────────────────────────────────────
  'manchester': 'lancashire',
  'liverpool': 'lancashire',
  'preston': 'lancashire',
  'bolton': 'lancashire',
  'blackburn': 'lancashire',
  'burnley': 'lancashire',
  'oldham': 'lancashire',
  'rochdale': 'lancashire',
  'wigan': 'lancashire',
  'bury': 'lancashire',
  'salford': 'lancashire',
  'blackpool': 'lancashire',
  'lancaster': 'lancashire',
  'accrington': 'lancashire',
  'ashton under lyne': 'lancashire',
  'barrow in furness': 'lancashire',
  'chorley': 'lancashire',
  'nelson': 'lancashire',
  'colne': 'lancashire',
  'leigh': 'lancashire',
  'warrington': 'lancashire',
  'st helens': 'lancashire',
  'bootle': 'lancashire',
  'southport': 'lancashire',
  'eccles': 'lancashire',
  'stretford': 'lancashire',
  'stockport': 'cheshire',    // Stockport is historically Cheshire

  // ── Cheshire ────────────────────────────────────────────────────────────
  'chester': 'cheshire',
  'macclesfield': 'cheshire',
  'crewe': 'cheshire',
  'nantwich': 'cheshire',
  'congleton': 'cheshire',
  'northwich': 'cheshire',
  'runcorn': 'cheshire',
  'altrincham': 'cheshire',
  'birkenhead': 'cheshire',
  'wallasey': 'cheshire',
  'hyde': 'cheshire',
  'stalybridge': 'cheshire',
  'dukinfield': 'cheshire',
  'wilmslow': 'cheshire',
  'knutsford': 'cheshire',
  'ellesmere port': 'cheshire',
  'sale': 'cheshire',

  // ── Staffordshire ───────────────────────────────────────────────────────
  'burton upon trent': 'staffordshire',
  'burton on trent': 'staffordshire',
  'stoke': 'staffordshire',
  'stoke on trent': 'staffordshire',
  'stoke upon trent': 'staffordshire',
  'wolverhampton': 'staffordshire',
  'walsall': 'staffordshire',
  'west bromwich': 'staffordshire',
  'stafford': 'staffordshire',
  'tamworth': 'staffordshire',
  'lichfield': 'staffordshire',
  'cannock': 'staffordshire',
  'leek': 'staffordshire',
  'uttoxeter': 'staffordshire',
  'rugeley': 'staffordshire',
  'newcastle under lyme': 'staffordshire',
  'smethwick': 'staffordshire',
  'tipton': 'staffordshire',
  'wednesbury': 'staffordshire',
  'bilston': 'staffordshire',
  'burslem': 'staffordshire',
  'hanley': 'staffordshire',
  'longton': 'staffordshire',
  'tunstall': 'staffordshire',
  'stone': 'staffordshire',

  // ── Leicestershire ──────────────────────────────────────────────────────
  'leicester': 'leicestershire',
  'loughborough': 'leicestershire',
  'hinckley': 'leicestershire',
  'melton mowbray': 'leicestershire',
  'coalville': 'leicestershire',
  'market harborough': 'leicestershire',
  'ashby de la zouch': 'leicestershire',
  'wigston': 'leicestershire',
  'oadby': 'leicestershire',
  'lutterworth': 'leicestershire',
  'market bosworth': 'leicestershire',

  // ── Warwickshire ────────────────────────────────────────────────────────
  'birmingham': 'warwickshire',
  'coventry': 'warwickshire',
  'warwick': 'warwickshire',
  'leamington': 'warwickshire',
  'leamington spa': 'warwickshire',
  'nuneaton': 'warwickshire',
  'rugby': 'warwickshire',
  'stratford upon avon': 'warwickshire',
  'stratford on avon': 'warwickshire',
  'solihull': 'warwickshire',
  'sutton coldfield': 'warwickshire',
  'bedworth': 'warwickshire',
  'atherstone': 'warwickshire',
  'kenilworth': 'warwickshire',
  'aston': 'warwickshire',

  // ── Worcestershire ──────────────────────────────────────────────────────
  'worcester': 'worcestershire',
  'dudley': 'worcestershire',
  'kidderminster': 'worcestershire',
  'redditch': 'worcestershire',
  'bromsgrove': 'worcestershire',
  'malvern': 'worcestershire',
  'evesham': 'worcestershire',
  'stourbridge': 'worcestershire',
  'halesowen': 'worcestershire',
  'droitwich': 'worcestershire',
  'pershore': 'worcestershire',
  'bewdley': 'worcestershire',
  'tenbury': 'worcestershire',
  'upton upon severn': 'worcestershire',

  // ── Shropshire ──────────────────────────────────────────────────────────
  'shrewsbury': 'shropshire',
  'telford': 'shropshire',
  'oswestry': 'shropshire',
  'bridgnorth': 'shropshire',
  'ludlow': 'shropshire',
  'wellington': 'shropshire',
  'whitchurch': 'shropshire',
  'market drayton': 'shropshire',
  'newport': 'shropshire',     // NB: also a town in Monmouthshire
  'bishops castle': 'shropshire',
  'church stretton': 'shropshire',
  'much wenlock': 'shropshire',
  'wem': 'shropshire',
  'shifnal': 'shropshire',
  'cleobury mortimer': 'shropshire',
  'ellesmere': 'shropshire',

  // ── Herefordshire ───────────────────────────────────────────────────────
  'hereford': 'herefordshire',
  'leominster': 'herefordshire',
  'ross on wye': 'herefordshire',
  'ledbury': 'herefordshire',
  'bromyard': 'herefordshire',
  'kington': 'herefordshire',
  'weobley': 'herefordshire',

  // ── Gloucestershire ─────────────────────────────────────────────────────
  'gloucester': 'gloucestershire',
  'bristol': 'gloucestershire',
  'cheltenham': 'gloucestershire',
  'stroud': 'gloucestershire',
  'tewkesbury': 'gloucestershire',
  'cirencester': 'gloucestershire',
  'dursley': 'gloucestershire',
  'thornbury': 'gloucestershire',
  'stow on the wold': 'gloucestershire',
  'winchcombe': 'gloucestershire',
  'nailsworth': 'gloucestershire',
  'moreton in marsh': 'gloucestershire',
  'tetbury': 'gloucestershire',
  'chipping sodbury': 'gloucestershire',
  'lydney': 'gloucestershire',
  'coleford': 'gloucestershire',
  'cinderford': 'gloucestershire',

  // ── Oxfordshire ─────────────────────────────────────────────────────────
  'oxford': 'oxfordshire',
  'banbury': 'oxfordshire',
  'bicester': 'oxfordshire',
  'witney': 'oxfordshire',
  'thame': 'oxfordshire',
  'henley on thames': 'oxfordshire',
  'woodstock': 'oxfordshire',
  'chipping norton': 'oxfordshire',
  'abingdon': 'berkshire',     // Abingdon was historically in Berkshire
  'wantage': 'berkshire',
  'faringdon': 'berkshire',

  // ── Berkshire ───────────────────────────────────────────────────────────
  'reading': 'berkshire',
  'windsor': 'berkshire',
  'newbury': 'berkshire',
  'maidenhead': 'berkshire',
  'wallingford': 'berkshire',
  'hungerford': 'berkshire',
  'wokingham': 'berkshire',
  'bracknell': 'berkshire',
  'slough': 'buckinghamshire',  // Slough was historically in Buckinghamshire
  'eton': 'buckinghamshire',

  // ── Buckinghamshire ─────────────────────────────────────────────────────
  'aylesbury': 'buckinghamshire',
  'high wycombe': 'buckinghamshire',
  'buckingham': 'buckinghamshire',
  'amersham': 'buckinghamshire',
  'chesham': 'buckinghamshire',
  'marlow': 'buckinghamshire',
  'beaconsfield': 'buckinghamshire',
  'princes risborough': 'buckinghamshire',
  'newport pagnell': 'buckinghamshire',
  'olney': 'buckinghamshire',
  'wolverton': 'buckinghamshire',
  'bletchley': 'buckinghamshire',
  'winslow': 'buckinghamshire',

  // ── Hertfordshire ───────────────────────────────────────────────────────
  'barnet': 'hertfordshire',
  'st albans': 'hertfordshire',
  'watford': 'hertfordshire',
  'hertford': 'hertfordshire',
  'stevenage': 'hertfordshire',
  'hemel hempstead': 'hertfordshire',
  'hitchin': 'hertfordshire',
  'bishop stortford': 'hertfordshire',
  'bishops stortford': 'hertfordshire',
  'ware': 'hertfordshire',
  'royston': 'hertfordshire',
  'berkhamsted': 'hertfordshire',
  'hatfield': 'hertfordshire',
  'welwyn': 'hertfordshire',
  'hoddesdon': 'hertfordshire',
  'letchworth': 'hertfordshire',
  'baldock': 'hertfordshire',
  'tring': 'hertfordshire',
  'harpenden': 'hertfordshire',
  'cheshunt': 'hertfordshire',
  'rickmansworth': 'hertfordshire',
  'bushey': 'hertfordshire',

  // ── Bedfordshire ────────────────────────────────────────────────────────
  'bedford': 'bedfordshire',
  'luton': 'bedfordshire',
  'dunstable': 'bedfordshire',
  'leighton buzzard': 'bedfordshire',
  'biggleswade': 'bedfordshire',
  'ampthill': 'bedfordshire',
  'sandy': 'bedfordshire',
  'woburn': 'bedfordshire',
  'shefford': 'bedfordshire',

  // ── Huntingdonshire ─────────────────────────────────────────────────────
  'huntingdon': 'huntingdonshire',
  'st neots': 'huntingdonshire',
  'st ives': 'huntingdonshire',
  'ramsey': 'huntingdonshire',
  'godmanchester': 'huntingdonshire',
  'kimbolton': 'huntingdonshire',

  // ── Cambridgeshire ──────────────────────────────────────────────────────
  'cambridge': 'cambridgeshire',
  'ely': 'cambridgeshire',
  'wisbech': 'cambridgeshire',
  'march': 'cambridgeshire',
  'whittlesey': 'cambridgeshire',
  'chatteris': 'cambridgeshire',
  'newmarket': 'cambridgeshire',
  'soham': 'cambridgeshire',
  'linton': 'cambridgeshire',

  // ── Northamptonshire ────────────────────────────────────────────────────
  'northampton': 'northamptonshire',
  'peterborough': 'northamptonshire',
  'kettering': 'northamptonshire',
  'wellingborough': 'northamptonshire',
  'corby': 'northamptonshire',
  'rushden': 'northamptonshire',
  'daventry': 'northamptonshire',
  'towcester': 'northamptonshire',
  'brackley': 'northamptonshire',
  'oundle': 'northamptonshire',
  'thrapston': 'northamptonshire',
  'higham ferrers': 'northamptonshire',

  // ── Rutland ─────────────────────────────────────────────────────────────
  'oakham': 'rutland',
  'uppingham': 'rutland',

  // ── Lincolnshire ────────────────────────────────────────────────────────
  'lincoln': 'lincolnshire',
  'grimsby': 'lincolnshire',
  'scunthorpe': 'lincolnshire',
  'grantham': 'lincolnshire',
  'boston': 'lincolnshire',
  'stamford': 'lincolnshire',
  'spalding': 'lincolnshire',
  'louth': 'lincolnshire',
  'skegness': 'lincolnshire',
  'gainsborough': 'lincolnshire',
  'sleaford': 'lincolnshire',
  'horncastle': 'lincolnshire',
  'brigg': 'lincolnshire',
  'bourne': 'lincolnshire',
  'holbeach': 'lincolnshire',
  'caistor': 'lincolnshire',
  'crowle': 'lincolnshire',
  'barton upon humber': 'lincolnshire',
  'cleethorpes': 'lincolnshire',
  'market rasen': 'lincolnshire',

  // ── Norfolk ─────────────────────────────────────────────────────────────
  'norwich': 'norfolk',
  'kings lynn': 'norfolk',
  'king\'s lynn': 'norfolk',
  'great yarmouth': 'norfolk',
  'thetford': 'norfolk',
  'dereham': 'norfolk',
  'east dereham': 'norfolk',
  'swaffham': 'norfolk',
  'downham market': 'norfolk',
  'aylsham': 'norfolk',
  'north walsham': 'norfolk',
  'wymondham': 'norfolk',
  'attleborough': 'norfolk',
  'diss': 'norfolk',
  'fakenham': 'norfolk',
  'cromer': 'norfolk',
  'wells next the sea': 'norfolk',
  'holt': 'norfolk',

  // ── Suffolk ─────────────────────────────────────────────────────────────
  'ipswich': 'suffolk',
  'bury st edmunds': 'suffolk',
  'lowestoft': 'suffolk',
  'sudbury': 'suffolk',
  'woodbridge': 'suffolk',
  'stowmarket': 'suffolk',
  'haverhill': 'suffolk',
  'felixstowe': 'suffolk',
  'aldeburgh': 'suffolk',
  'beccles': 'suffolk',
  'bungay': 'suffolk',
  'halesworth': 'suffolk',
  'framlingham': 'suffolk',
  'saxmundham': 'suffolk',
  'eye': 'suffolk',
  'mildenhall': 'suffolk',
  'brandon': 'suffolk',
  'clare': 'suffolk',
  'hadleigh': 'suffolk',
  'leiston': 'suffolk',

  // ── Essex ───────────────────────────────────────────────────────────────
  'colchester': 'essex',
  'chelmsford': 'essex',
  'southend': 'essex',
  'southend on sea': 'essex',
  'romford': 'essex',
  'ilford': 'essex',
  'east ham': 'essex',
  'west ham': 'essex',
  'barking': 'essex',
  'dagenham': 'essex',
  'walthamstow': 'essex',
  'leyton': 'essex',
  'leytonstone': 'essex',
  'wanstead': 'essex',
  'chingford': 'essex',
  'woodford': 'essex',
  'stratford': 'essex',       // Stratford in East London is historically Essex
  'harwich': 'essex',
  'clacton': 'essex',
  'braintree': 'essex',
  'witham': 'essex',
  'maldon': 'essex',
  'saffron walden': 'essex',
  'dunmow': 'essex',
  'great dunmow': 'essex',
  'halstead': 'essex',
  'rayleigh': 'essex',
  'grays': 'essex',
  'thurrock': 'essex',
  'tilbury': 'essex',
  'billericay': 'essex',
  'brentwood': 'essex',
  'epping': 'essex',
  'ongar': 'essex',
  'rochford': 'essex',
  'burnham on crouch': 'essex',

  // ── Middlesex (inc. Inner London north of Thames) ───────────────────────
  'london': 'middlesex',
  'westminster': 'middlesex',
  'kensington': 'middlesex',
  'chelsea': 'middlesex',
  'paddington': 'middlesex',
  'islington': 'middlesex',
  'holborn': 'middlesex',
  'stepney': 'middlesex',
  'hackney': 'middlesex',
  'shoreditch': 'middlesex',
  'bethnal green': 'middlesex',
  'poplar': 'middlesex',
  'whitechapel': 'middlesex',
  'mile end': 'middlesex',
  'clerkenwell': 'middlesex',
  'finsbury': 'middlesex',
  'st pancras': 'middlesex',
  'marylebone': 'middlesex',
  'hampstead': 'middlesex',
  'st marylebone': 'middlesex',
  'brentford': 'middlesex',
  'ealing': 'middlesex',
  'enfield': 'middlesex',
  'tottenham': 'middlesex',
  'willesden': 'middlesex',
  'hendon': 'middlesex',
  'hornsey': 'middlesex',
  'edmonton': 'middlesex',
  'acton': 'middlesex',
  'hammersmith': 'middlesex',
  'fulham': 'middlesex',
  'staines': 'middlesex',
  'uxbridge': 'middlesex',
  'feltham': 'middlesex',
  'twickenham': 'middlesex',
  'hounslow': 'middlesex',
  'southgate': 'middlesex',
  'wood green': 'middlesex',
  'muswell hill': 'middlesex',
  'highgate': 'middlesex',
  'finchley': 'middlesex',
  'friern barnet': 'middlesex',
  'wembley': 'middlesex',
  'harrow': 'middlesex',
  'ruislip': 'middlesex',
  'hayes': 'middlesex',
  'southall': 'middlesex',
  'hanwell': 'middlesex',
  'greenford': 'middlesex',
  'heston': 'middlesex',
  'isleworth': 'middlesex',
  'teddington': 'middlesex',
  'sunbury': 'middlesex',
  'ashford': 'middlesex',     // Ashford in Middlesex (not Kent)
  'totteridge': 'middlesex',

  // ── Surrey (inc. Inner London south of Thames) ──────────────────────────
  'bermondsey': 'surrey',
  'southwark': 'surrey',
  'camberwell': 'surrey',
  'lambeth': 'surrey',
  'wandsworth': 'surrey',
  'battersea': 'surrey',
  'richmond': 'surrey',       // Richmond upon Thames, historically Surrey
  'kingston': 'surrey',
  'kingston upon thames': 'surrey',
  'guildford': 'surrey',
  'croydon': 'surrey',
  'wimbledon': 'surrey',
  'merton': 'surrey',
  'mitcham': 'surrey',
  'sutton': 'surrey',
  'epsom': 'surrey',
  'reigate': 'surrey',
  'redhill': 'surrey',
  'dorking': 'surrey',
  'woking': 'surrey',
  'farnham': 'surrey',
  'godalming': 'surrey',
  'haslemere': 'surrey',
  'chertsey': 'surrey',
  'weybridge': 'surrey',
  'esher': 'surrey',
  'walton on thames': 'surrey',
  'leatherhead': 'surrey',
  'banstead': 'surrey',
  'carshalton': 'surrey',
  'beddington': 'surrey',
  'peckham': 'surrey',
  'dulwich': 'surrey',
  'brixton': 'surrey',
  'clapham': 'surrey',
  'streatham': 'surrey',
  'norwood': 'surrey',
  'tooting': 'surrey',
  'putney': 'surrey',
  'barnes': 'surrey',
  'rotherhithe': 'surrey',
  'newington': 'surrey',
  'kennington': 'surrey',
  'walworth': 'surrey',

  // ── Kent ────────────────────────────────────────────────────────────────
  'woolwich': 'kent',
  'greenwich': 'kent',
  'lewisham': 'kent',
  'deptford': 'kent',
  'eltham': 'kent',
  'plumstead': 'kent',
  'erith': 'kent',
  'bexley': 'kent',
  'bromley': 'kent',
  'beckenham': 'kent',
  'penge': 'kent',
  'canterbury': 'kent',
  'maidstone': 'kent',
  'dover': 'kent',
  'folkestone': 'kent',
  'margate': 'kent',
  'chatham': 'kent',
  'rochester': 'kent',
  'gillingham': 'kent',
  'gravesend': 'kent',
  'dartford': 'kent',
  'tunbridge wells': 'kent',
  'tonbridge': 'kent',
  'sevenoaks': 'kent',
  'ashford': 'kent',          // Ashford in Kent
  'ramsgate': 'kent',
  'broadstairs': 'kent',
  'deal': 'kent',
  'sandwich': 'kent',
  'hythe': 'kent',
  'faversham': 'kent',
  'sittingbourne': 'kent',
  'sheerness': 'kent',
  'whitstable': 'kent',
  'herne bay': 'kent',
  'tenterden': 'kent',
  'cranbrook': 'kent',
  'westerham': 'kent',
  'swanley': 'kent',
  'northfleet': 'kent',
  'orpington': 'kent',
  'sidcup': 'kent',
  'chislehurst': 'kent',
  'lee': 'kent',
  'blackheath': 'kent',

  // ── Sussex ──────────────────────────────────────────────────────────────
  'brighton': 'sussex',
  'chichester': 'sussex',
  'hastings': 'sussex',
  'lewes': 'sussex',
  'worthing': 'sussex',
  'eastbourne': 'sussex',
  'horsham': 'sussex',
  'crawley': 'sussex',
  'bognor': 'sussex',
  'bognor regis': 'sussex',
  'littlehampton': 'sussex',
  'arundel': 'sussex',
  'shoreham': 'sussex',
  'hove': 'sussex',
  'rye': 'sussex',
  'battle': 'sussex',
  'bexhill': 'sussex',
  'midhurst': 'sussex',
  'petworth': 'sussex',
  'steyning': 'sussex',
  'cuckfield': 'sussex',
  'east grinstead': 'sussex',
  'haywards heath': 'sussex',
  'uckfield': 'sussex',
  'newhaven': 'sussex',
  'seaford': 'sussex',

  // ── Hampshire ───────────────────────────────────────────────────────────
  'portsmouth': 'hampshire',
  'southampton': 'hampshire',
  'winchester': 'hampshire',
  'bournemouth': 'hampshire',
  'basingstoke': 'hampshire',
  'andover': 'hampshire',
  'aldershot': 'hampshire',
  'farnborough': 'hampshire',
  'gosport': 'hampshire',
  'fareham': 'hampshire',
  'havant': 'hampshire',
  'petersfield': 'hampshire',
  'lymington': 'hampshire',
  'christchurch': 'hampshire',
  'ringwood': 'hampshire',
  'romsey': 'hampshire',
  'eastleigh': 'hampshire',
  'alton': 'hampshire',
  'fordingbridge': 'hampshire',
  'hartley wintney': 'hampshire',
  'isle of wight': 'hampshire',
  'newport iow': 'hampshire',
  'ryde': 'hampshire',
  'cowes': 'hampshire',
  'ventnor': 'hampshire',
  'sandown': 'hampshire',
  'shanklin': 'hampshire',

  // ── Dorset ──────────────────────────────────────────────────────────────
  'dorchester': 'dorset',
  'poole': 'dorset',
  'weymouth': 'dorset',
  'bridport': 'dorset',
  'blandford': 'dorset',
  'blandford forum': 'dorset',
  'wimborne': 'dorset',
  'wimborne minster': 'dorset',
  'wareham': 'dorset',
  'swanage': 'dorset',
  'sherborne': 'dorset',
  'shaftesbury': 'dorset',
  'sturminster newton': 'dorset',
  'lyme regis': 'dorset',
  'beaminster': 'dorset',

  // ── Wiltshire ───────────────────────────────────────────────────────────
  'salisbury': 'wiltshire',
  'swindon': 'wiltshire',
  'trowbridge': 'wiltshire',
  'chippenham': 'wiltshire',
  'devizes': 'wiltshire',
  'warminster': 'wiltshire',
  'marlborough': 'wiltshire',
  'melksham': 'wiltshire',
  'calne': 'wiltshire',
  'corsham': 'wiltshire',
  'bradford on avon': 'wiltshire',
  'amesbury': 'wiltshire',
  'highworth': 'wiltshire',
  'westbury': 'wiltshire',
  'malmesbury': 'wiltshire',
  'pewsey': 'wiltshire',
  'mere': 'wiltshire',
  'tisbury': 'wiltshire',
  'wilton': 'wiltshire',

  // ── Somerset ────────────────────────────────────────────────────────────
  'bath': 'somerset',
  'taunton': 'somerset',
  'bridgwater': 'somerset',
  'yeovil': 'somerset',
  'frome': 'somerset',
  'weston super mare': 'somerset',
  'wells': 'somerset',
  'glastonbury': 'somerset',
  'chard': 'somerset',
  'minehead': 'somerset',
  'wellington': 'somerset',   // NB: also in Shropshire
  'crewkerne': 'somerset',
  'langport': 'somerset',
  'ilminster': 'somerset',
  'shepton mallet': 'somerset',
  'midsomer norton': 'somerset',
  'keynsham': 'somerset',
  'clevedon': 'somerset',
  'portishead': 'somerset',
  'nailsea': 'somerset',
  'axbridge': 'somerset',
  'dulverton': 'somerset',
  'williton': 'somerset',

  // ── Devon ───────────────────────────────────────────────────────────────
  'exeter': 'devon',
  'plymouth': 'devon',
  'barnstaple': 'devon',
  'torquay': 'devon',
  'paignton': 'devon',
  'tiverton': 'devon',
  'newton abbot': 'devon',
  'bideford': 'devon',
  'ilfracombe': 'devon',
  'crediton': 'devon',
  'honiton': 'devon',
  'okehampton': 'devon',
  'tavistock': 'devon',
  'totnes': 'devon',
  'dartmouth': 'devon',
  'teignmouth': 'devon',
  'dawlish': 'devon',
  'sidmouth': 'devon',
  'exmouth': 'devon',
  'axminster': 'devon',
  'south molton': 'devon',
  'great torrington': 'devon',
  'holsworthy': 'devon',
  'kingsbridge': 'devon',

  // ── Cornwall ────────────────────────────────────────────────────────────
  'truro': 'cornwall',
  'penzance': 'cornwall',
  'falmouth': 'cornwall',
  'st austell': 'cornwall',
  'camborne': 'cornwall',
  'redruth': 'cornwall',
  'bodmin': 'cornwall',
  'newquay': 'cornwall',
  'launceston': 'cornwall',
  'liskeard': 'cornwall',
  'helston': 'cornwall',
  'saltash': 'cornwall',
  'st ives': 'cornwall',      // NB: also in Huntingdonshire
  'padstow': 'cornwall',
  'bude': 'cornwall',
  'wadebridge': 'cornwall',
  'lostwithiel': 'cornwall',
  'camelford': 'cornwall',
  'stratton': 'cornwall',
  'hayle': 'cornwall',

  // ── Northumberland ──────────────────────────────────────────────────────
  'newcastle': 'northumberland',
  'newcastle upon tyne': 'northumberland',
  'newcastle on tyne': 'northumberland',
  'tynemouth': 'northumberland',
  'berwick': 'northumberland',
  'berwick upon tweed': 'northumberland',
  'alnwick': 'northumberland',
  'morpeth': 'northumberland',
  'hexham': 'northumberland',
  'blyth': 'northumberland',
  'ashington': 'northumberland',
  'wallsend': 'northumberland',
  'bedlington': 'northumberland',
  'prudhoe': 'northumberland',
  'ponteland': 'northumberland',
  'haltwhistle': 'northumberland',
  'bellingham': 'northumberland',
  'amble': 'northumberland',
  'rothbury': 'northumberland',
  'wooler': 'northumberland',

  // ── Durham ──────────────────────────────────────────────────────────────
  'sunderland': 'durham',
  'gateshead': 'durham',
  'hartlepool': 'durham',
  'darlington': 'durham',
  'durham': 'durham',
  'south shields': 'durham',
  'stockton': 'durham',
  'stockton on tees': 'durham',
  'bishop auckland': 'durham',
  'consett': 'durham',
  'chester le street': 'durham',
  'jarrow': 'durham',
  'washington': 'durham',
  'seaham': 'durham',
  'houghton le spring': 'durham',
  'spennymoor': 'durham',
  'shildon': 'durham',
  'barnard castle': 'durham',
  'sedgefield': 'durham',
  'stanhope': 'durham',
  'teesdale': 'durham',
  'weardale': 'durham',
  'lanchester': 'durham',

  // ── Cumberland ──────────────────────────────────────────────────────────
  'carlisle': 'cumberland',
  'workington': 'cumberland',
  'whitehaven': 'cumberland',
  'penrith': 'cumberland',
  'cockermouth': 'cumberland',
  'maryport': 'cumberland',
  'keswick': 'cumberland',
  'wigton': 'cumberland',
  'cleator moor': 'cumberland',
  'egremont': 'cumberland',
  'brampton': 'cumberland',
  'longtown': 'cumberland',
  'aspatria': 'cumberland',
  'silloth': 'cumberland',

  // ── Westmorland ─────────────────────────────────────────────────────────
  'kendal': 'westmorland',
  'appleby': 'westmorland',
  'appleby in westmorland': 'westmorland',
  'windermere': 'westmorland',
  'ambleside': 'westmorland',
  'kirkby lonsdale': 'westmorland',
  'kirkby stephen': 'westmorland',
  'shap': 'westmorland',
  'orton': 'westmorland',
  'brough': 'westmorland',
  'bowness': 'westmorland',
  'grasmere': 'westmorland',

  // ── Monmouthshire ───────────────────────────────────────────────────────
  'newport': 'monmouthshire',   // Newport, Gwent — historically Monmouthshire
  'abergavenny': 'monmouthshire',
  'monmouth': 'monmouthshire',
  'pontypool': 'monmouthshire',
  'chepstow': 'monmouthshire',
  'tredegar': 'monmouthshire',
  'ebbw vale': 'monmouthshire',
  'abertillery': 'monmouthshire',
  'blaina': 'monmouthshire',
  'usk': 'monmouthshire',
  'caldicot': 'monmouthshire',
  'risca': 'monmouthshire',
  'bedwas': 'monmouthshire',

  // ── Glamorgan ───────────────────────────────────────────────────────────
  'cardiff': 'glamorgan',
  'swansea': 'glamorgan',
  'merthyr tydfil': 'glamorgan',
  'merthyr': 'glamorgan',
  'neath': 'glamorgan',
  'port talbot': 'glamorgan',
  'pontypridd': 'glamorgan',
  'bridgend': 'glamorgan',
  'barry': 'glamorgan',
  'aberdare': 'glamorgan',
  'rhondda': 'glamorgan',
  'llantrisant': 'glamorgan',
  'cowbridge': 'glamorgan',
  'penarth': 'glamorgan',
  'maesteg': 'glamorgan',
  'mountain ash': 'glamorgan',
  'caerphilly': 'glamorgan',
  'gelligaer': 'glamorgan',

  // ── Carmarthenshire ─────────────────────────────────────────────────────
  'carmarthen': 'carmarthenshire',
  'llanelli': 'carmarthenshire',
  'llandeilo': 'carmarthenshire',
  'ammanford': 'carmarthenshire',
  'llandovery': 'carmarthenshire',
  'kidwelly': 'carmarthenshire',
  'whitland': 'carmarthenshire',
  'laugharne': 'carmarthenshire',
  'burry port': 'carmarthenshire',

  // ── Pembrokeshire ───────────────────────────────────────────────────────
  'pembroke': 'pembrokeshire',
  'haverfordwest': 'pembrokeshire',
  'milford haven': 'pembrokeshire',
  'tenby': 'pembrokeshire',
  'fishguard': 'pembrokeshire',
  'narberth': 'pembrokeshire',
  'pembroke dock': 'pembrokeshire',
  'st davids': 'pembrokeshire',
  'neyland': 'pembrokeshire',

  // ── Cardiganshire ───────────────────────────────────────────────────────
  'aberystwyth': 'cardiganshire',
  'cardigan': 'cardiganshire',
  'lampeter': 'cardiganshire',
  'tregaron': 'cardiganshire',
  'new quay': 'cardiganshire',
  'aberaeron': 'cardiganshire',

  // ── Breconshire ─────────────────────────────────────────────────────────
  'brecon': 'breconshire',
  'builth wells': 'breconshire',
  'hay on wye': 'breconshire',
  'crickhowell': 'breconshire',
  'talgarth': 'breconshire',
  'ystradgynlais': 'breconshire',

  // ── Radnorshire ─────────────────────────────────────────────────────────
  'presteigne': 'radnorshire',
  'llandrindod wells': 'radnorshire',
  'knighton': 'radnorshire',
  'rhayader': 'radnorshire',
  'new radnor': 'radnorshire',

  // ── Montgomeryshire ─────────────────────────────────────────────────────
  'welshpool': 'montgomeryshire',
  'newtown': 'montgomeryshire',
  'montgomery': 'montgomeryshire',
  'llanfyllin': 'montgomeryshire',
  'machynlleth': 'montgomeryshire',
  'llanidloes': 'montgomeryshire',

  // ── Merionethshire ──────────────────────────────────────────────────────
  'dolgellau': 'merionethshire',
  'bala': 'merionethshire',
  'barmouth': 'merionethshire',
  'corwen': 'merionethshire',
  'ffestiniog': 'merionethshire',
  'harlech': 'merionethshire',
  'tywyn': 'merionethshire',

  // ── Caernarvonshire ─────────────────────────────────────────────────────
  'caernarfon': 'caernarvonshire',
  'bangor': 'caernarvonshire',
  'conway': 'caernarvonshire',
  'llandudno': 'caernarvonshire',
  'pwllheli': 'caernarvonshire',
  'bethesda': 'caernarvonshire',
  'porthmadog': 'caernarvonshire',
  'criccieth': 'caernarvonshire',
  'nefyn': 'caernarvonshire',
  'llanberis': 'caernarvonshire',

  // ── Denbighshire ────────────────────────────────────────────────────────
  'wrexham': 'denbighshire',
  'denbigh': 'denbighshire',
  'ruthin': 'denbighshire',
  'llangollen': 'denbighshire',
  'colwyn bay': 'denbighshire',
  'abergele': 'denbighshire',
  'chirk': 'denbighshire',

  // ── Flintshire ──────────────────────────────────────────────────────────
  'flint': 'flintshire',
  'mold': 'flintshire',
  'holywell': 'flintshire',
  'buckley': 'flintshire',
  'connah\'s quay': 'flintshire',
  'shotton': 'flintshire',
  'hawarden': 'flintshire',
  'prestatyn': 'flintshire',
  'rhyl': 'flintshire',
  'st asaph': 'flintshire',

  // ── Anglesey ────────────────────────────────────────────────────────────
  'holyhead': 'anglesey',
  'llangefni': 'anglesey',
  'beaumaris': 'anglesey',
  'amlwch': 'anglesey',
  'menai bridge': 'anglesey',
};


// ─── Registration District Aliases ──────────────────────────────────────────
// Common BMD registration district names that map to county names.
// These handle cases where a place string says e.g. "Derby" meaning the
// registration district (i.e. county of Derbyshire), not the town.
// ─────────────────────────────────────────────────────────────────────────────

const DISTRICT_TO_COUNTY = {
  'derby': 'derbyshire',
  'nottingham': 'nottinghamshire',
  'lincoln': 'lincolnshire',
  'leicester': 'leicestershire',
  'stafford': 'staffordshire',
  'warwick': 'warwickshire',
  'worcester': 'worcestershire',
  'chester': 'cheshire',
  'lancaster': 'lancashire',
  'york': 'yorkshire',
  'northampton': 'northamptonshire',
  'bedford': 'bedfordshire',
  'cambridge': 'cambridgeshire',
  'oxford': 'oxfordshire',
  'gloucester': 'gloucestershire',
  'hereford': 'herefordshire',
  'huntingdon': 'huntingdonshire',
  'kent': 'kent',
  'surrey': 'surrey',
  'sussex': 'sussex',
  'hampshire': 'hampshire',
  'dorset': 'dorset',
  'devon': 'devon',
  'cornwall': 'cornwall',
  'somerset': 'somerset',
  'wiltshire': 'wiltshire',
  'norfolk': 'norfolk',
  'suffolk': 'suffolk',
  'essex': 'essex',
  'london': 'middlesex',
  'middlesex': 'middlesex',
  'durham': 'durham',
  'cumberland': 'cumberland',
  'westmorland': 'westmorland',
  'northumberland': 'northumberland',
  'rutland': 'rutland',
  'shropshire': 'shropshire',
  'salop': 'shropshire',
  'berks': 'berkshire',
  'bucks': 'buckinghamshire',
  'cambs': 'cambridgeshire',
  'derbys': 'derbyshire',
  'glos': 'gloucestershire',
  'hants': 'hampshire',
  'herts': 'hertfordshire',
  'hunts': 'huntingdonshire',
  'lancs': 'lancashire',
  'leics': 'leicestershire',
  'lincs': 'lincolnshire',
  'middx': 'middlesex',
  'northants': 'northamptonshire',
  'notts': 'nottinghamshire',
  'oxon': 'oxfordshire',
  'staffs': 'staffordshire',
  'warks': 'warwickshire',
  'worcs': 'worcestershire',
  'wilts': 'wiltshire',
  'yorks': 'yorkshire',
};


// ─── FamilySearch Old English County Names ──────────────────────────────────
// FamilySearch uses Old English / localized county names in birth/death places
const FS_OLD_ENGLISH_COUNTIES = {
  'sūþrīge': 'surrey',
  'heorotfordscír': 'hertfordshire',
  'centlond': 'kent',
  'bro an hañv': 'somerset',
  'oxenaford': 'oxfordshire',
  'north hamtunscire': 'northamptonshire',
  'stæffordscīr': 'staffordshire',
  'dēfnascīr': 'devon',
  'dorseteschyre': 'dorset',
  'glēawceasterscīr': 'gloucestershire',
  'hamtunscir': 'hampshire',
  'wiltunscīr': 'wiltshire',
  'bearrucscīr': 'berkshire',
  'buccingehamscīr': 'buckinghamshire',
  'bedanfordscīr': 'bedfordshire',
  'grantabrycgscīr': 'cambridgeshire',
  'sūþsēaxe': 'sussex',
  'ēastsēaxe': 'essex',
  'norðfolc': 'norfolk',
  'sūðfolc': 'suffolk',
  'lǣgrecæsterscīr': 'leicestershire',
  'snottingahamscīr': 'nottinghamshire',
  'lincolnscīr': 'lincolnshire',
  'ēoferwīcscīr': 'yorkshire',
  'lancasterscīr': 'lancashire',
  'ceasterscīr': 'cheshire',
  'scrobbesbyrigscīr': 'shropshire',
  'herefordscīr': 'herefordshire',
  'wigrecæsterscīr': 'worcestershire',
  'wealesc': 'wales',
};

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Resolve a place string to a county name.
 * Tries: direct county name → town lookup → district alias → FS Old English → partial match.
 * Returns lowercase county name or null.
 */
function resolveCounty(place) {
  if (!place) return null;
  const p = place.toLowerCase().trim();

  // Direct county name
  if (COUNTY_NEIGHBORS[p]) return p;

  // Town lookup
  if (TOWN_TO_COUNTY[p]) return TOWN_TO_COUNTY[p];

  // District alias
  if (DISTRICT_TO_COUNTY[p]) return DISTRICT_TO_COUNTY[p];

  // FamilySearch Old English county name
  if (FS_OLD_ENGLISH_COUNTIES[p]) return FS_OLD_ENGLISH_COUNTIES[p];

  // Check if any county name appears as a substring (e.g. "Pinxton, Derbyshire, England")
  const parts = p.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (COUNTY_NEIGHBORS[part]) return part;
    if (TOWN_TO_COUNTY[part]) return TOWN_TO_COUNTY[part];
    if (DISTRICT_TO_COUNTY[part]) return DISTRICT_TO_COUNTY[part];
    if (FS_OLD_ENGLISH_COUNTIES[part]) return FS_OLD_ENGLISH_COUNTIES[part];
  }

  return null;
}

/**
 * Check if two counties are neighbors (or the same county).
 * Returns: 'same', 'adjacent', or 'distant'.
 */
function countyProximity(county1, county2) {
  if (!county1 || !county2) return null;
  const c1 = county1.toLowerCase().trim();
  const c2 = county2.toLowerCase().trim();

  if (c1 === c2) return 'same';

  const neighbors = COUNTY_NEIGHBORS[c1];
  if (neighbors && neighbors.includes(c2)) return 'adjacent';

  return 'distant';
}

/**
 * Check if two places are geographically proximate.
 * Resolves towns/districts to counties first, then checks adjacency.
 * Returns: { proximity: 'same'|'adjacent'|'distant'|null, county1, county2 }
 */
function placeProximity(place1, place2) {
  const county1 = resolveCounty(place1);
  const county2 = resolveCounty(place2);
  const proximity = countyProximity(county1, county2);
  return { proximity, county1, county2 };
}


module.exports = {
  COUNTY_NEIGHBORS,
  TOWN_TO_COUNTY,
  DISTRICT_TO_COUNTY,
  resolveCounty,
  countyProximity,
  placeProximity,
};
