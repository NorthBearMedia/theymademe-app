const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

// ─── Layout Constants (calibrated against Blank Tree template) ─────────
const PAGE_WIDTH = 1190.25;
const PAGE_HEIGHT = 842.25;
const CX = PAGE_WIDTH / 2;    // 595.125
const CY = 305;                // vertical center at tree trunk base

// Ring boundaries for each generation (inner/outer radius in points)
const RING_BOUNDS = [
  null,                         // Gen 0 — subject (title area)
  { inner: 193, outer: 227 },   // Gen 1 — parents
  { inner: 227, outer: 268 },   // Gen 2 — grandparents
  { inner: 268, outer: 335 },   // Gen 3 — great-grandparents
  { inner: 335, outer: 400 },   // Gen 4 — 2x great-grandparents
  { inner: 400, outer: 487 },   // Gen 5 — 3x great-grandparents
  { inner: 487, outer: 550 },   // Gen 6 — 4x great-grandparents
];

// Font sizes per generation
const FONT_SIZES = {
  name:  [0, 8.5, 7, 6, 5.5, 4.5, 3.8],
  detail:[0, 5.5, 5, 4.5, 4, 3.5, 3],
};

const TEXT_COLOR = rgb(0.15, 0.22, 0.18);
const TITLE_SIZE = 22;
const SUBTITLE_SIZE = 10;

// ─── Ahnentafel Utilities ──────────────────────────────────────────────

function ahnentafelGeneration(asc) {
  if (asc < 1) return 0;
  return Math.floor(Math.log2(asc));
}

function getSegmentAngle(ascNumber) {
  const gen = ahnentafelGeneration(ascNumber);
  if (gen === 0) return { startAngle: 0, endAngle: 180, midAngle: 90 };

  const segCount = Math.pow(2, gen);
  const segWidth = 180 / segCount;
  const indexInGen = ascNumber - Math.pow(2, gen);

  // Index 0 = leftmost (near 180°), last index = rightmost (near 0°)
  const startAngle = 180 - (indexInGen + 1) * segWidth;
  const endAngle = 180 - indexInGen * segWidth;
  const midAngle = (startAngle + endAngle) / 2;

  return { startAngle, endAngle, midAngle };
}

function polarToPage(radius, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  return {
    x: CX + radius * Math.cos(rad),
    y: CY + radius * Math.sin(rad),
  };
}

// ─── Text Helpers ──────────────────────────────────────────────────────

function extractYear(dateStr) {
  if (!dateStr) return '';
  const match = dateStr.match(/\b(\d{4})\b/);
  return match ? match[1] : dateStr;
}

function formatDates(ancestor) {
  const parts = [];
  if (ancestor.birth_date) {
    const y = extractYear(ancestor.birth_date);
    if (y) parts.push('b. ' + y);
  }
  if (ancestor.death_date) {
    const y = extractYear(ancestor.death_date);
    if (y) parts.push('d. ' + y);
  }
  return parts.join(' - ');
}

function formatPlace(ancestor) {
  const place = ancestor.birth_place || ancestor.death_place || '';
  if (!place) return '';
  const cleaned = place.replace(/[^\x20-\x7E,]/g, '').trim();
  if (!cleaned) return '';
  const parts = cleaned.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length <= 2) return parts.join(', ');
  return parts[0] + ', ' + parts[parts.length - 1];
}

function truncateText(text, font, fontSize, maxWidth) {
  if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) return text;
  let t = text;
  while (t.length > 3 && font.widthOfTextAtSize(t + '..', fontSize) > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '..';
}

// ─── Draw Text in Fan Segment ──────────────────────────────────────────
//
// Text is drawn RADIALLY — the baseline runs along the radius.
// On the right half (0°-90°): text reads from center outward (bottom-to-top)
// On the left half (90°-180°): text is flipped to read from center outward
//
// lineOffset shifts perpendicular to the radius (along the arc) to stack lines.
// Positive offset = shift CCW (toward higher angles)

function drawSegmentText(page, text, font, fontSize, radius, angleDeg, lineOffset, color) {
  const isLeftHalf = angleDeg > 90;
  const radRad = angleDeg * Math.PI / 180;
  const textWidth = font.widthOfTextAtSize(text, fontSize);

  // Unit vectors
  const rx = Math.cos(radRad);  // radial outward
  const ry = Math.sin(radRad);
  const tx = -Math.sin(radRad); // tangential CCW
  const ty = Math.cos(radRad);

  // Base position: center of the ring at this angle
  const baseX = CX + radius * rx;
  const baseY = CY + radius * ry;

  let drawX, drawY, rotation;

  if (!isLeftHalf) {
    // RIGHT HALF (0°-90°): rotation = angle - 90
    // Text baseline points radially outward
    // drawText origin = start of text (inner end)
    // To center: move origin inward by textWidth/2
    rotation = angleDeg - 90;
    drawX = baseX - (textWidth / 2) * rx + lineOffset * tx;
    drawY = baseY - (textWidth / 2) * ry + lineOffset * ty;
  } else {
    // LEFT HALF (90°-180°): rotation = angle + 90
    // Text baseline points radially inward (text reads center→outward)
    // drawText origin = start of text (outer end)
    // To center: move origin outward by textWidth/2
    rotation = angleDeg + 90;
    drawX = baseX + (textWidth / 2) * rx + lineOffset * tx;
    drawY = baseY + (textWidth / 2) * ry + lineOffset * ty;
  }

  page.drawText(text, {
    x: drawX,
    y: drawY,
    size: fontSize,
    font,
    color,
    rotate: degrees(rotation),
  });
}

// ─── Main PDF Generator ────────────────────────────────────────────────

async function generateFanChartPdf(ancestors, familyName, generations = 4) {
  const templatePath = path.join(__dirname, '..', 'templates', 'blank-tree.pdf');
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];

  const fontRegular = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  // Build ancestor lookup
  const ancestorMap = {};
  for (const a of ancestors) {
    ancestorMap[a.ascendancy_number] = a;
  }

  // Draw each ancestor in their segment
  const maxAsc = Math.pow(2, generations + 1) - 1;
  for (let asc = 2; asc <= maxAsc; asc++) {
    const ancestor = ancestorMap[asc];
    if (!ancestor) continue;

    const gen = ahnentafelGeneration(asc);
    if (gen < 1 || gen > 6 || !RING_BOUNDS[gen]) continue;

    const { inner, outer } = RING_BOUNDS[gen];
    const { startAngle, endAngle, midAngle } = getSegmentAngle(asc);
    const textRadius = (inner + outer) / 2;

    const nameFontSize = FONT_SIZES.name[gen];
    const detailFontSize = FONT_SIZES.detail[gen];

    // Max text width ≈ ring width (radial extent of the segment)
    const ringWidth = outer - inner;
    const maxTextWidth = ringWidth * 0.92;

    // Prepare text lines
    const nameText = truncateText(ancestor.name || 'Unknown', fontBold, nameFontSize, maxTextWidth);
    const dateText = formatDates(ancestor);
    const truncDate = dateText ? truncateText(dateText, fontRegular, detailFontSize, maxTextWidth) : '';
    const placeText = formatPlace(ancestor);
    const truncPlace = placeText ? truncateText(placeText, fontItalic, detailFontSize, maxTextWidth) : '';

    // Stack lines perpendicular to the radius (along the arc)
    const lines = [];
    lines.push({ text: nameText, font: fontBold, size: nameFontSize });
    if (truncDate) lines.push({ text: truncDate, font: fontRegular, size: detailFontSize });
    if (truncPlace) lines.push({ text: truncPlace, font: fontItalic, size: detailFontSize });

    // Calculate line offsets to center the block
    const spacing = nameFontSize * 0.85;
    const totalSpan = (lines.length - 1) * spacing;
    const startOffset = totalSpan / 2;

    for (let i = 0; i < lines.length; i++) {
      const offset = startOffset - i * spacing;
      drawSegmentText(
        page,
        lines[i].text,
        lines[i].font,
        lines[i].size,
        textRadius,
        midAngle,
        offset,
        TEXT_COLOR,
      );
    }
  }

  // ─── Title at bottom ───────────────────────────────────────────────
  const subject = ancestorMap[1];
  const titleText = familyName ? `The ${familyName} Family` : (subject ? subject.name : 'Family Tree');
  const titleWidth = fontBold.widthOfTextAtSize(titleText, TITLE_SIZE);
  page.drawText(titleText, {
    x: CX - titleWidth / 2,
    y: 45,
    size: TITLE_SIZE,
    font: fontBold,
    color: TEXT_COLOR,
  });

  if (subject) {
    const sText = subject.name;
    const sWidth = fontRegular.widthOfTextAtSize(sText, SUBTITLE_SIZE);
    page.drawText(sText, {
      x: CX - sWidth / 2,
      y: 80,
      size: SUBTITLE_SIZE,
      font: fontRegular,
      color: TEXT_COLOR,
    });

    const sDate = formatDates(subject);
    if (sDate) {
      const dWidth = fontRegular.widthOfTextAtSize(sDate, SUBTITLE_SIZE - 1);
      page.drawText(sDate, {
        x: CX - dWidth / 2,
        y: 66,
        size: SUBTITLE_SIZE - 1,
        font: fontRegular,
        color: TEXT_COLOR,
      });
    }
  }

  return pdfDoc.save();
}

module.exports = { generateFanChartPdf };
