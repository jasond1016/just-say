import Database from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'
import type { Transcript } from './types'

let db: Database.Database | null = null

export function initDatabase(): Database.Database {
  if (db) {
    return db
  }

  const dbPath = join(app.getPath('userData'), 'transcripts.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  // Enable foreign keys
  db.pragma('foreign_keys = ON')

  // Create tables
  db.exec(`
    -- Transcript records main table
    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      note TEXT,
      duration_seconds INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      translation_enabled INTEGER DEFAULT 0,
      target_language TEXT,
      include_microphone INTEGER DEFAULT 0
    );

    -- Speaker segments table
    CREATE TABLE IF NOT EXISTS transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id TEXT NOT NULL,
      speaker INTEGER NOT NULL,
      text TEXT NOT NULL,
      translated_text TEXT,
      segment_order INTEGER NOT NULL,
      FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
    );

    -- Sentence pairs table (aligned translation)
    CREATE TABLE IF NOT EXISTS sentence_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id INTEGER NOT NULL,
      original TEXT NOT NULL,
      translated TEXT,
      pair_order INTEGER NOT NULL,
      FOREIGN KEY (segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE
    );

    -- Full-text search (FTS5)
    CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
      transcript_id,
      title,
      note,
      content,
      content_translated,
      tokenize = 'porter'
    );
  `)

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transcripts_created_at ON transcripts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transcript_segments_transcript_id ON transcript_segments(transcript_id);
    CREATE INDEX IF NOT EXISTS idx_sentence_pairs_segment_id ON sentence_pairs(segment_id);
  `)

  console.log('[Database] Initialized at:', dbPath)
  return db
}

export function getDatabase(): Database.Database {
  if (!db) {
    return initDatabase()
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    console.log('[Database] Closed')
  }
}

// Helper functions for typed queries
export function getAllTranscripts(limit = 50, offset = 0): Transcript[] {
  const database = getDatabase()
  return database
    .prepare(
      `
    SELECT * FROM transcripts
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(limit, offset) as Transcript[]
}

export function getTranscriptCount(): number {
  const database = getDatabase()
  const result = database.prepare('SELECT COUNT(*) as count FROM transcripts').get() as {
    count: number
  }
  return result.count
}

export function searchTranscriptsFTS(query: string, limit = 50, offset = 0): Transcript[] {
  const database = getDatabase()
  // Search in FTS index
  return database
    .prepare(
      `
    SELECT DISTINCT t.* FROM transcripts t
    JOIN transcripts_fts fts ON t.id = fts.transcript_id
    WHERE transcripts_fts MATCH ?
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(`${query}*`, limit, offset) as Transcript[]
}

export function searchTranscriptsCount(query: string): number {
  const database = getDatabase()
  const result = database
    .prepare(
      `
    SELECT COUNT(DISTINCT t.id) as count FROM transcripts t
    JOIN transcripts_fts fts ON t.id = fts.transcript_id
    WHERE transcripts_fts MATCH ?
  `
    )
    .get(`${query}*`) as { count: number }
  return result.count
}
