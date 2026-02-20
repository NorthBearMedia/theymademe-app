function formatGedcomName(name) {
  if (!name) return '//';
  // Strip "(not found)" suffix from rejected ancestors
  name = name.replace(/\s*\(not found\)\s*$/, '');
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return `${parts[0]} //`;
  const surname = parts.pop();
  return `${parts.join(' ')} /${surname}/`;
}

function formatGedcomDate(dateStr) {
  if (!dateStr) return null;
  // Pass through — FamilySearch dates are already in GEDCOM-friendly formats
  return dateStr.toUpperCase();
}

function generateGedcom(job, ancestors) {
  // Filter: only include ancestors with confidence_score >= 50 (Possible or better)
  const verifiedAncestors = ancestors.filter(a => (a.confidence_score || 0) >= 50);

  const lines = [];
  const now = new Date();
  const dateStr = `${now.getDate()} ${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][now.getMonth()]} ${now.getFullYear()}`;

  // HEADER
  lines.push('0 HEAD');
  lines.push('1 SOUR TheyMadeMe');
  lines.push('2 VERS 2.0');
  lines.push('2 NAME They Made Me - AI Family Tree Builder');
  lines.push('1 DEST ANSTFILE');
  lines.push(`1 DATE ${dateStr}`);
  lines.push(`1 FILE ${(job.customer_name || 'family-tree').replace(/[^a-zA-Z0-9 ]/g, '')}.ged`);
  lines.push('1 GEDC');
  lines.push('2 VERS 5.5.1');
  lines.push('2 FORM LINEAGE-LINKED');
  lines.push('1 CHAR UTF-8');
  lines.push('1 SUBM @SUBM1@');
  lines.push('0 @SUBM1@ SUBM');
  lines.push('1 NAME They Made Me');

  // Build a map of verified ancestors by ascendancy number
  const byNum = new Map();
  for (const a of verifiedAncestors) {
    if (a.ascendancy_number) byNum.set(a.ascendancy_number, a);
  }

  // Track family units we need to create
  const families = new Map();

  // INDIVIDUAL records
  for (const a of verifiedAncestors) {
    const num = a.ascendancy_number;
    if (!num) continue;

    lines.push(`0 @I${num}@ INDI`);
    lines.push(`1 NAME ${formatGedcomName(a.name)}`);
    if (a.gender) lines.push(`1 SEX ${a.gender === 'Male' ? 'M' : a.gender === 'Female' ? 'F' : 'U'}`);

    if (a.birth_date || a.birth_place) {
      lines.push('1 BIRT');
      const bd = formatGedcomDate(a.birth_date);
      if (bd) lines.push(`2 DATE ${bd}`);
      if (a.birth_place) lines.push(`2 PLAC ${a.birth_place}`);
    }

    if (a.death_date || a.death_place) {
      lines.push('1 DEAT');
      const dd = formatGedcomDate(a.death_date);
      if (dd) lines.push(`2 DATE ${dd}`);
      if (a.death_place) lines.push(`2 PLAC ${a.death_place}`);
    }

    // Confidence note
    const level = a.confidence_level || 'Unknown';
    const score = a.confidence_score || 0;
    const sourceCount = (a.sources || []).length;
    lines.push(`1 NOTE Confidence: ${score}% (${level}) — ${sourceCount} source(s), verified via GPS methodology`);

    // Source references
    if (a.sources && a.sources.length > 0) {
      for (let i = 0; i < a.sources.length; i++) {
        lines.push(`1 SOUR @S${num}_${i}@`);
      }
    }

    // Family links — person N is child of family where father=2N, mother=2N+1
    if (num > 1) {
      const isEven = num % 2 === 0;
      const spouseNum = isEven ? num + 1 : num - 1;
      const childNum = Math.floor(num / 2);
      const famKey = `${Math.min(num, spouseNum)}_${Math.max(num, spouseNum)}`;

      if (!families.has(famKey)) {
        families.set(famKey, {
          husband: isEven ? num : spouseNum,
          wife: isEven ? spouseNum : num,
          children: [childNum],
        });
      }
      lines.push(`1 FAMS @F${famKey}@`);
    }

    if (num >= 1) {
      const parentFatherNum = num * 2;
      const parentMotherNum = num * 2 + 1;
      if (byNum.has(parentFatherNum) || byNum.has(parentMotherNum)) {
        const parentFamKey = `${parentFatherNum}_${parentMotherNum}`;
        lines.push(`1 FAMC @F${parentFamKey}@`);
      }
    }
  }

  // FAMILY records
  for (const [famKey, fam] of families) {
    lines.push(`0 @F${famKey}@ FAM`);
    if (byNum.has(fam.husband)) lines.push(`1 HUSB @I${fam.husband}@`);
    if (byNum.has(fam.wife)) lines.push(`1 WIFE @I${fam.wife}@`);
    for (const childNum of fam.children) {
      if (byNum.has(childNum)) lines.push(`1 CHIL @I${childNum}@`);
    }
  }

  // SOURCE records
  for (const a of verifiedAncestors) {
    if (!a.sources || !a.ascendancy_number) continue;
    for (let i = 0; i < a.sources.length; i++) {
      const src = a.sources[i];
      lines.push(`0 @S${a.ascendancy_number}_${i}@ SOUR`);
      if (src.title) lines.push(`1 TITL ${src.title}`);
      if (src.citation) lines.push(`1 TEXT ${src.citation}`);
      if (src.url) lines.push(`1 _URL ${src.url}`);
      if (src.source_type) lines.push(`1 NOTE Source type: ${src.source_type}, Evidence weight: ${src.weight || 0}`);
    }
  }

  lines.push('0 TRLR');

  return lines.join('\r\n');
}

module.exports = { generateGedcom };
