const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config');

const dbPath = path.join(config.DATA_DIR, 'theymademe.sqlite');
let db;

function getDb() {
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initialize() {
  const conn = getDb();

  conn.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS research_jobs (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_email TEXT,
      status TEXT DEFAULT 'pending',
      generations INTEGER DEFAULT 4,
      input_data TEXT,
      results TEXT,
      person_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS ancestors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      research_job_id TEXT REFERENCES research_jobs(id) ON DELETE CASCADE,
      fs_person_id TEXT,
      name TEXT,
      gender TEXT,
      birth_date TEXT,
      birth_place TEXT,
      death_date TEXT,
      death_place TEXT,
      ascendancy_number INTEGER,
      generation INTEGER,
      confidence TEXT,
      sources TEXT,
      raw_data TEXT
    );

    CREATE TABLE IF NOT EXISTS search_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      research_job_id TEXT REFERENCES research_jobs(id) ON DELETE CASCADE,
      target_asc_number INTEGER,
      fs_person_id TEXT,
      name TEXT,
      search_pass INTEGER,
      search_query TEXT,
      fs_score REAL,
      computed_score INTEGER,
      selected INTEGER DEFAULT 0,
      rejection_reason TEXT,
      raw_data TEXT
    );
  `);

  // Migrations — add new columns to existing tables
  const hasColumn = (table, column) => {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some(c => c.name === column);
  };

  // research_jobs: progress tracking columns
  if (!hasColumn('research_jobs', 'progress_message')) {
    conn.exec(`ALTER TABLE research_jobs ADD COLUMN progress_message TEXT`);
  }
  if (!hasColumn('research_jobs', 'progress_current')) {
    conn.exec(`ALTER TABLE research_jobs ADD COLUMN progress_current INTEGER DEFAULT 0`);
  }
  if (!hasColumn('research_jobs', 'progress_total')) {
    conn.exec(`ALTER TABLE research_jobs ADD COLUMN progress_total INTEGER DEFAULT 0`);
  }

  // ancestors: GPS verification columns
  if (!hasColumn('ancestors', 'confidence_score')) {
    conn.exec(`ALTER TABLE ancestors ADD COLUMN confidence_score INTEGER DEFAULT 0`);
  }
  if (!hasColumn('ancestors', 'confidence_level')) {
    conn.exec(`ALTER TABLE ancestors ADD COLUMN confidence_level TEXT DEFAULT 'Unknown'`);
  }
  if (!hasColumn('ancestors', 'evidence_chain')) {
    conn.exec(`ALTER TABLE ancestors ADD COLUMN evidence_chain TEXT DEFAULT '[]'`);
  }
  if (!hasColumn('ancestors', 'search_log')) {
    conn.exec(`ALTER TABLE ancestors ADD COLUMN search_log TEXT DEFAULT '[]'`);
  }
  if (!hasColumn('ancestors', 'conflicts')) {
    conn.exec(`ALTER TABLE ancestors ADD COLUMN conflicts TEXT DEFAULT '[]'`);
  }
  if (!hasColumn('ancestors', 'verification_notes')) {
    conn.exec(`ALTER TABLE ancestors ADD COLUMN verification_notes TEXT DEFAULT ''`);
  }
}

// Settings
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

// Research Jobs
function createResearchJob(job) {
  getDb().prepare(`
    INSERT INTO research_jobs (id, customer_name, customer_email, status, generations, input_data)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(job.id, job.customer_name, job.customer_email, job.generations, JSON.stringify(job.input_data));
  return job;
}

function getResearchJob(id) {
  const row = getDb().prepare('SELECT * FROM research_jobs WHERE id = ?').get(id);
  if (row && row.input_data) row.input_data = JSON.parse(row.input_data);
  if (row && row.results) row.results = JSON.parse(row.results);
  return row;
}

function listResearchJobs(limit = 50, offset = 0) {
  return getDb().prepare('SELECT * FROM research_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function updateResearchJob(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(typeof val === 'object' ? JSON.stringify(val) : val);
  }
  values.push(id);
  getDb().prepare(`UPDATE research_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function updateJobProgress(jobId, message, current, total) {
  getDb().prepare(`
    UPDATE research_jobs SET progress_message = ?, progress_current = ?, progress_total = ? WHERE id = ?
  `).run(message, current, total, jobId);
}

// Ancestors
function addAncestor(ancestor) {
  const result = getDb().prepare(`
    INSERT INTO ancestors (
      research_job_id, fs_person_id, name, gender,
      birth_date, birth_place, death_date, death_place,
      ascendancy_number, generation, confidence, sources, raw_data,
      confidence_score, confidence_level, evidence_chain, search_log, conflicts, verification_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ancestor.research_job_id, ancestor.fs_person_id, ancestor.name, ancestor.gender,
    ancestor.birth_date, ancestor.birth_place, ancestor.death_date, ancestor.death_place,
    ancestor.ascendancy_number, ancestor.generation, ancestor.confidence || '',
    JSON.stringify(ancestor.sources || []), JSON.stringify(ancestor.raw_data || {}),
    ancestor.confidence_score || 0, ancestor.confidence_level || 'Unknown',
    JSON.stringify(ancestor.evidence_chain || []), JSON.stringify(ancestor.search_log || []),
    JSON.stringify(ancestor.conflicts || []), ancestor.verification_notes || ''
  );
  return result.lastInsertRowid;
}

function getAncestors(researchJobId) {
  const rows = getDb().prepare('SELECT * FROM ancestors WHERE research_job_id = ? ORDER BY ascendancy_number').all(researchJobId);
  return rows.map(row => {
    if (row.sources) row.sources = JSON.parse(row.sources);
    if (row.raw_data) row.raw_data = JSON.parse(row.raw_data);
    if (row.evidence_chain) row.evidence_chain = JSON.parse(row.evidence_chain);
    if (row.search_log) row.search_log = JSON.parse(row.search_log);
    if (row.conflicts) row.conflicts = JSON.parse(row.conflicts);
    return row;
  });
}

function getAncestorById(id) {
  const row = getDb().prepare('SELECT * FROM ancestors WHERE id = ?').get(id);
  if (!row) return null;
  if (row.sources) row.sources = JSON.parse(row.sources);
  if (row.raw_data) row.raw_data = JSON.parse(row.raw_data);
  if (row.evidence_chain) row.evidence_chain = JSON.parse(row.evidence_chain);
  if (row.search_log) row.search_log = JSON.parse(row.search_log);
  if (row.conflicts) row.conflicts = JSON.parse(row.conflicts);
  return row;
}

function deleteAncestors(researchJobId) {
  getDb().prepare('DELETE FROM search_candidates WHERE research_job_id = ?').run(researchJobId);
  getDb().prepare('DELETE FROM ancestors WHERE research_job_id = ?').run(researchJobId);
}

// Search Candidates
function addSearchCandidate(candidate) {
  getDb().prepare(`
    INSERT INTO search_candidates (
      research_job_id, target_asc_number, fs_person_id, name,
      search_pass, search_query, fs_score, computed_score,
      selected, rejection_reason, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.research_job_id, candidate.target_asc_number,
    candidate.fs_person_id, candidate.name,
    candidate.search_pass, candidate.search_query,
    candidate.fs_score, candidate.computed_score,
    candidate.selected ? 1 : 0, candidate.rejection_reason || '',
    JSON.stringify(candidate.raw_data || {})
  );
}

function getSearchCandidates(researchJobId, ascNumber) {
  const rows = getDb().prepare(
    'SELECT * FROM search_candidates WHERE research_job_id = ? AND target_asc_number = ? ORDER BY computed_score DESC'
  ).all(researchJobId, ascNumber);
  return rows.map(row => {
    if (row.raw_data) row.raw_data = JSON.parse(row.raw_data);
    return row;
  });
}

function getJobStats() {
  const conn = getDb();
  return {
    total: conn.prepare('SELECT COUNT(*) as c FROM research_jobs').get().c,
    completed: conn.prepare("SELECT COUNT(*) as c FROM research_jobs WHERE status = 'completed'").get().c,
    pending: conn.prepare("SELECT COUNT(*) as c FROM research_jobs WHERE status = 'pending'").get().c,
    running: conn.prepare("SELECT COUNT(*) as c FROM research_jobs WHERE status = 'running'").get().c,
  };
}

module.exports = {
  initialize,
  getSetting, setSetting,
  createResearchJob, getResearchJob, listResearchJobs, updateResearchJob, updateJobProgress,
  addAncestor, getAncestors, getAncestorById, deleteAncestors,
  addSearchCandidate, getSearchCandidates,
  getJobStats,
};
