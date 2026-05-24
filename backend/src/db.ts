import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'career-pilot.db');

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  dbInstance = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await dbInstance.run('PRAGMA foreign_keys = ON');

  return dbInstance;
}

export async function initDb() {
  const db = await getDb();

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      is_bootstrapped INTEGER DEFAULT 0,
      last_sync_time TEXT
    );

    CREATE TABLE IF NOT EXISTS candidate_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT,
      target_roles TEXT,
      preferences TEXT,
      resume_text TEXT
    );

    CREATE TABLE IF NOT EXISTS job_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'BOOKMARKED')),
      source TEXT,
      url TEXT,
      raw_posting TEXT,
      tailored_resume TEXT,
      tailored_cover_letter TEXT,
      applied_date TEXT,
      updated_date TEXT
    );

    CREATE TABLE IF NOT EXISTS interviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_application_id INTEGER,
      scheduled_time TEXT NOT NULL,
      notes TEXT,
      prep_notes TEXT,
      FOREIGN KEY(job_application_id) REFERENCES job_applications(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
      input_data TEXT,
      output_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS google_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT,
      refresh_token TEXT,
      expiry_date INTEGER
    );
  `);

  // Insert default settings row if not exists
  const settings = await db.get('SELECT * FROM system_settings WHERE id = 1');
  if (!settings) {
    await db.run('INSERT INTO system_settings (id, is_bootstrapped) VALUES (1, 0)');
  }
}
