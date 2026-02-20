const express = require('express');
const db = require('../services/database');
const { generateGedcom } = require('../services/gedcom-export');
const { generateFanChartPdf } = require('../services/pdf-generator');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Download PDF fan chart
router.get('/pdf/:id', requireAuth, async (req, res) => {
  try {
    const job = db.getResearchJob(req.params.id);
    if (!job) return res.status(404).send('Research job not found');

    const ancestors = db.getAncestors(req.params.id);
    if (ancestors.length === 0) return res.status(400).send('No ancestors found — research may still be running.');

    // Map DB ancestors to the format expected by the PDF generator
    const pdfAncestors = ancestors.filter(a => a.confidence_score >= 50 || a.confidence_level === 'Customer Data').map(a => ({
      ascendancy_number: a.ascendancy_number,
      name: a.name,
      birth_date: a.birth_date,
      birth_place: a.birth_place,
      death_date: a.death_date,
      death_place: a.death_place,
    }));

    const familyName = job.customer_name || '';
    const pdfBytes = await generateFanChartPdf(pdfAncestors, familyName, job.generations || 4);

    const filename = `${(job.customer_name || 'family-tree').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-')}-family-tree.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).send('Failed to generate PDF: ' + err.message);
  }
});

// Preview PDF in browser (inline, not download)
router.get('/pdf/:id/preview', requireAuth, async (req, res) => {
  try {
    const job = db.getResearchJob(req.params.id);
    if (!job) return res.status(404).send('Research job not found');

    const ancestors = db.getAncestors(req.params.id);
    if (ancestors.length === 0) return res.status(400).send('No ancestors found — research may still be running.');

    const pdfAncestors = ancestors.filter(a => a.confidence_score >= 50 || a.confidence_level === 'Customer Data').map(a => ({
      ascendancy_number: a.ascendancy_number,
      name: a.name,
      birth_date: a.birth_date,
      birth_place: a.birth_place,
      death_date: a.death_date,
      death_place: a.death_place,
    }));

    const familyName = job.customer_name || '';
    const pdfBytes = await generateFanChartPdf(pdfAncestors, familyName, job.generations || 4);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('PDF preview error:', err);
    res.status(500).send('Failed to generate PDF: ' + err.message);
  }
});

// Download GEDCOM file
router.get('/gedcom/:id', requireAuth, (req, res) => {
  const job = db.getResearchJob(req.params.id);
  if (!job) return res.status(404).send('Research job not found');

  const ancestors = db.getAncestors(req.params.id);
  if (ancestors.length === 0) return res.status(400).send('No ancestors found — research may still be running.');

  const gedcom = generateGedcom(job, ancestors);
  const filename = `${(job.customer_name || 'family-tree').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-')}-family-tree.ged`;

  res.setHeader('Content-Type', 'text/x-gedcom; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(gedcom);
});

module.exports = router;
