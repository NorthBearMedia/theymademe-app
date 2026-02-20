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
  `);
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

// Ancestors
function addAncestor(ancestor) {
  getDb().prepare(`
    INSERT INTO ancestors (research_job_id, fs_person_id, name, gender, birth_date, birth_place, death_date, death_place, ascendancy_number, generation, confidence, sources, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ancestor.research_job_id, ancestor.fs_person_id, ancestor.name, ancestor.gender,
    ancestor.birth_date, ancestor.birth_place, ancestor.death_date, ancestor.death_place,
    ancestor.ascendancy_number, ancestor.generation, ancestor.confidence,
    JSON.stringify(ancestor.sources || []), JSON.stringify(ancestor.raw_data || {})
  );
}

function getAncestors(researchJobId) {
  const rows = getDb().prepare('SELECT * FROM ancestors WHERE research_job_id = ? ORDER BY ascendancy_number').all(researchJobId);
  return rows.map(row => {
    if (row.sources) row.sources = JSON.parse(row.sources);
    if (row.raw_data) row.raw_data = JSON.parse(row.raw_data);
    return row;
  });
}

function deleteAncestors(researchJobId) {
  getDb().prepare('DELETE FROM ancestors WHERE research_job_id = ?').run(researchJobId);
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
  createResearchJob, getResearchJob, listResearchJobs, updateResearchJob,
  addAncestor, getAncestors, deleteAncestors,
  getJobStats,
};
