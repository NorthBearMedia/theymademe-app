const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

// ─── Layout ─────────────────────────────────────────────────────
const PW = 1190, PH = 842;
const CX = PW / 2, CY = PH / 2 + 15;
const CENTER_R = 48;

const RINGS = [
  null,
  { inner: 52, outer: 114 },   // gen 1: 62pt (parents need room)
  { inner: 114, outer: 168 },  // gen 2: 54pt
  { inner: 168, outer: 220 },  // gen 3: 52pt
  { inner: 220, outer: 270 },  // gen 4: 50pt
  { inner: 270, outer: 318 },  // gen 5: 48pt
  { inner: 318, outer: 364 },  // gen 6: 46pt
];

const NAME_SZ   = [0, 7, 6, 5.5, 4.8, 4, 3.5];
const DETAIL_SZ = [0, 5, 4.5, 4, 3.5, 3, 2.6];

const WHITE = rgb(1, 1, 1);
const CREAM = rgb(0.98, 0.96, 0.92);
const DARK  = rgb(0.12, 0.18, 0.14);
const EMPTY_CLR = rgb(0.90, 0.88, 0.84);

// ─── Ahnentafel ─────────────────────────────────────────────────
function gen(asc) { return asc < 1 ? 0 : Math.floor(Math.log2(asc)); }

function isPaternal(asc) {
  let n = asc;
  while (n > 3) n = Math.floor(n / 2);
  return n === 2;
}

function segColor(asc) {
  const g = gen(asc);
  const pat = isPaternal(asc);
  const b = pat ? [0.10, 0.23, 0.16] : [0.10, 0.18, 0.25];
  const s = 0.055;
  return rgb(b[0] + g * s, b[1] + g * s, b[2] + g * s);
}

function segAngle(asc) {
  const g = gen(asc);
  const count = Math.pow(2, g);
  const w = 360 / count;
  const idx = asc - count;
  const st = 90 + idx * w;
  return { start: st, end: st + w, mid: st + w / 2 };
}

// ─── Text helpers ───────────────────────────────────────────────
function extractYear(d) {
  if (!d) return '';
  const m = d.match(/\b(\d{4})\b/);
  return m ? m[1] : d;
}

function fmtDates(a) {
  const p = [];
  if (a.birth_date) { const y = extractYear(a.birth_date); if (y) p.push('b.' + y); }
  if (a.death_date) { const y = extractYear(a.death_date); if (y) p.push('d.' + y); }
  return p.join(' \u2013 ');
}

function fmtPlace(a) {
  const place = a.birth_place || a.death_place || '';
  if (!place) return '';
  const cl = place.replace(/[^\x20-\x7E,]/g, '').trim();
  if (!cl) return '';
  const parts = cl.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length <= 2) return parts.join(', ');
  const last = parts[parts.length - 1].toLowerCase();
  const countries = ['england','wales','scotland','ireland','united kingdom','uk','united states','usa'];
  if (parts.length >= 3 && countries.includes(last)) return parts[0] + ', ' + parts[parts.length - 2];
  return parts[0] + ', ' + parts[parts.length - 1];
}

function truncate(text, font, sz, maxW) {
  if (font.widthOfTextAtSize(text, sz) <= maxW) return text;
  let t = text;
  while (t.length > 3 && font.widthOfTextAtSize(t + '..', sz) > maxW) t = t.slice(0, -1);
  return t + '..';
}

// ─── Drawing: filled arc segment ────────────────────────────────
function drawArc(page, inner, outer, startDeg, endDeg, color) {
  const steps = Math.max(12, Math.ceil((endDeg - startDeg) / 2));
  const toRad = Math.PI / 180;
  const pts = [];

  for (let i = 0; i <= steps; i++) {
    const a = (startDeg + (endDeg - startDeg) * i / steps) * toRad;
    pts.push(`${(inner * Math.cos(a)).toFixed(2)} ${(-inner * Math.sin(a)).toFixed(2)}`);
  }
  for (let i = steps; i >= 0; i--) {
    const a = (startDeg + (endDeg - startDeg) * i / steps) * toRad;
    pts.push(`${(outer * Math.cos(a)).toFixed(2)} ${(-outer * Math.sin(a)).toFixed(2)}`);
  }

  const d = `M ${pts[0]} ` + pts.slice(1).map(p => `L ${p}`).join(' ') + ' Z';
  page.drawSvgPath(d, { x: CX, y: CY, color, borderColor: WHITE, borderWidth: 0.6, borderOpacity: 0.7 });
}

// ─── Drawing: radial text ───────────────────────────────────────
function drawRadial(page, text, font, sz, midR, angleDeg, lineOff, color) {
  const theta = ((angleDeg % 360) + 360) % 360;
  const rad = angleDeg * Math.PI / 180;
  const tw = font.widthOfTextAtSize(text, sz);
  const rx = Math.cos(rad), ry = Math.sin(rad);
  const tx = -Math.sin(rad), ty = Math.cos(rad);
  const flip = theta > 90 && theta < 270;
  const eff = flip ? -lineOff : lineOff;

  let x, y, rot;
  if (!flip) {
    rot = angleDeg;
    x = CX + (midR - tw / 2) * rx + eff * tx;
    y = CY + (midR - tw / 2) * ry + eff * ty;
  } else {
    rot = angleDeg + 180;
    x = CX + (midR + tw / 2) * rx + eff * tx;
    y = CY + (midR + tw / 2) * ry + eff * ty;
  }

  page.drawText(text, { x, y, size: sz, font, color, rotate: degrees(rot) });
}

// ─── Main generator ─────────────────────────────────────────────
async function generateFanChartPdf(ancestors, familyName, generations = 6) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PW, PH]);
  const fontR = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontB = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontI = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: CREAM });

  const map = {};
  for (const a of ancestors) map[a.ascendancy_number] = a;
  const maxAsc = Math.pow(2, generations + 1) - 1;

  // Draw segments
  for (let asc = 2; asc <= maxAsc; asc++) {
    const g = gen(asc);
    if (g < 1 || g > 6 || !RINGS[g]) continue;
    const { inner, outer } = RINGS[g];
    const { start, end } = segAngle(asc);
    drawArc(page, inner, outer, start, end, map[asc] ? segColor(asc) : EMPTY_CLR);
  }

  // Center circle
  page.drawCircle({ x: CX, y: CY, size: CENTER_R, color: CREAM, borderColor: rgb(0.14, 0.28, 0.20), borderWidth: 2 });

  // Subject in center
  const subj = map[1];
  if (subj) {
    const np = (subj.name || 'Subject').split(' ');
    const first = np.slice(0, -1).join(' ') || np[0];
    const sur = np.length > 1 ? np[np.length - 1].toUpperCase() : '';
    const fW = fontR.widthOfTextAtSize(first, 8);
    page.drawText(first, { x: CX - fW / 2, y: CY + 10, size: 8, font: fontR, color: DARK });
    if (sur) {
      const sW = fontB.widthOfTextAtSize(sur, 9);
      page.drawText(sur, { x: CX - sW / 2, y: CY - 2, size: 9, font: fontB, color: DARK });
    }
    const bY = extractYear(subj.birth_date);
    if (bY) {
      const bt = 'b. ' + bY;
      const bW = fontI.widthOfTextAtSize(bt, 6);
      page.drawText(bt, { x: CX - bW / 2, y: CY - 14, size: 6, font: fontI, color: DARK });
    }
    const bp = fmtPlace(subj);
    if (bp) {
      const pW = fontI.widthOfTextAtSize(bp, 5.5);
      page.drawText(bp, { x: CX - pW / 2, y: CY - 24, size: 5.5, font: fontI, color: DARK });
    }
  }

  // Ancestor text
  for (let asc = 2; asc <= maxAsc; asc++) {
    const anc = map[asc];
    if (!anc) continue;
    const g = gen(asc);
    if (g < 1 || g > 6 || !RINGS[g]) continue;
    const { inner, outer } = RINGS[g];
    const { mid } = segAngle(asc);
    const midR = (inner + outer) / 2;
    // Gen 1 parents have 180° segments — text is nearly horizontal, use generous width
    // Gen 2 also gets extra room since segments are 90°
    const maxTW = g === 1 ? 140 : g === 2 ? (outer - inner) * 0.95 : (outer - inner) * 0.88;
    const nSz = NAME_SZ[g], dSz = DETAIL_SZ[g];

    const np = (anc.name || 'Unknown').split(' ');
    const fmt = np.length > 1 ? np.slice(0, -1).join(' ') + ' ' + np[np.length - 1].toUpperCase() : np[0].toUpperCase();
    const nameT = truncate(fmt, fontB, nSz, maxTW);
    const dateT = fmtDates(anc);
    const truncD = dateT ? truncate(dateT, fontR, dSz, maxTW) : '';
    const placeT = fmtPlace(anc);
    const truncP = placeT ? truncate(placeT, fontI, dSz, maxTW) : '';

    const lines = [{ t: nameT, f: fontB, s: nSz }];
    if (truncD) lines.push({ t: truncD, f: fontR, s: dSz });
    if (truncP) lines.push({ t: truncP, f: fontI, s: dSz });

    const sp = nSz * 0.9;
    const totalSpan = (lines.length - 1) * sp;
    const startOff = totalSpan / 2;

    for (let i = 0; i < lines.length; i++) {
      drawRadial(page, lines[i].t, lines[i].f, lines[i].s, midR, mid, startOff - i * sp, WHITE);
    }
  }

  // Title
  const surParts = familyName ? familyName.split(' ') : (subj ? subj.name.split(' ') : ['Family']);
  const dSur = surParts[surParts.length - 1];
  const titleT = `The ${dSur} Family`;
  const titleW = fontB.widthOfTextAtSize(titleT, 24);
  page.drawText(titleT, { x: CX - titleW / 2, y: 35, size: 24, font: fontB, color: DARK });

  // Legend
  page.drawRectangle({ x: CX - 110, y: 58, width: 10, height: 10, color: segColor(2) });
  page.drawText('Paternal', { x: CX - 97, y: 59, size: 7, font: fontR, color: DARK });
  page.drawRectangle({ x: CX + 35, y: 58, width: 10, height: 10, color: segColor(3) });
  page.drawText('Maternal', { x: CX + 48, y: 59, size: 7, font: fontR, color: DARK });

  return pdfDoc.save();
}

module.exports = { generateFanChartPdf };
