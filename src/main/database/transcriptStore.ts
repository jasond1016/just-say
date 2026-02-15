import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDatabase, searchTranscriptsFTS, searchTranscriptsCount } from './index'
import type {
  Transcript,
  TranscriptSegment,
  SentencePair,
  TranscriptWithSegments,
  SaveTranscriptRequest,
  ListTranscriptsOptions,
  SearchTranscriptsOptions,
  PaginatedResult
} from './types'

// Create a new transcript with all segments
export function createTranscript(data: SaveTranscriptRequest): Transcript {
  const db = getDatabase()
  const now = new Date().toISOString()
  const id = uuidv4()

  const title = data.title || formatDefaultTitle(now)

  const stmt = db.prepare(`
    INSERT INTO transcripts (
      id, title, note, duration_seconds, created_at, updated_at, translation_enabled, target_language, include_microphone, source_mode
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    id,
    title,
    data.note || null,
    data.duration_seconds,
    now,
    now,
    data.translation_enabled ? 1 : 0,
    data.target_language || null,
    data.include_microphone ? 1 : 0,
    data.source_mode || 'meeting'
  )

  // Insert segments
  if (data.segments.length > 0) {
    insertSegments(db, id, data.segments)
  }

  // Update FTS index
  updateFTSIndex(db, id, title, data.note || '', data.segments)

  console.log(`[TranscriptStore] Created transcript: ${id}`)
  return getTranscriptById(id)!
}

// Get transcript by ID
export function getTranscriptById(id: string): Transcript | null {
  const db = getDatabase()
  const result = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(id) as
    | Transcript
    | undefined
  return result || null
}

// Get transcript with all segments and sentence pairs
export function getTranscriptWithSegments(id: string): TranscriptWithSegments | null {
  const db = getDatabase()

  const transcript = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(id) as
    | Transcript
    | undefined
  if (!transcript) return null

  const segments = db
    .prepare(
      `
    SELECT * FROM transcript_segments
    WHERE transcript_id = ?
    ORDER BY segment_order
  `
    )
    .all(id) as TranscriptSegment[]

  // Get sentence pairs for each segment
  const segmentsWithPairs = segments.map((segment) => {
    const pairs = db
      .prepare(
        `
      SELECT * FROM sentence_pairs
      WHERE segment_id = ?
      ORDER BY pair_order
    `
      )
      .all(segment.id) as SentencePair[]

    return {
      ...segment,
      sentence_pairs: pairs
    }
  })

  return {
    ...transcript,
    segments: segmentsWithPairs
  }
}

// List transcripts with pagination
export function listTranscripts(options: ListTranscriptsOptions = {}): PaginatedResult<Transcript> {
  const page = options.page || 1
  const pageSize = options.pageSize || 20
  const orderBy = options.orderBy || 'created_at'
  const order = options.order || 'DESC'

  const db = getDatabase()
  const offset = (page - 1) * pageSize

  const items = db
    .prepare(
      `
    SELECT * FROM transcripts
    ORDER BY ${orderBy} ${order}
    LIMIT ? OFFSET ?
  `
    )
    .all(pageSize, offset) as Transcript[]

  const total = db.prepare('SELECT COUNT(*) as count FROM transcripts').get() as { count: number }

  return {
    items,
    total: total.count,
    page,
    pageSize,
    totalPages: Math.ceil(total.count / pageSize)
  }
}

// Search transcripts with full-text search
export function searchTranscripts(options: SearchTranscriptsOptions): PaginatedResult<Transcript> {
  const page = options.page || 1
  const pageSize = options.pageSize || 20
  const offset = (page - 1) * pageSize

  const items = searchTranscriptsFTS(options.query, pageSize, offset)
  const total = searchTranscriptsCount(options.query)

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  }
}

// Update transcript title and note
export function updateTranscript(id: string, data: { title?: string; note?: string }): boolean {
  const db = getDatabase()

  const updates: string[] = []
  const values: (string | null)[] = []

  if (data.title !== undefined) {
    updates.push('title = ?')
    values.push(data.title)
  }
  if (data.note !== undefined) {
    updates.push('note = ?')
    values.push(data.note)
  }

  if (updates.length === 0) return false

  updates.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(id)

  const stmt = db.prepare(`
    UPDATE transcripts
    SET ${updates.join(', ')}
    WHERE id = ?
  `)

  const result = stmt.run(...values)

  // Update FTS index
  if (data.title !== undefined || data.note !== undefined) {
    const transcript = getTranscriptById(id)
    if (transcript) {
      updateFTSIndex(db, id, transcript.title, transcript.note || '', [])
    }
  }

  return result.changes > 0
}

// Delete transcript and all related data
export function deleteTranscript(id: string): boolean {
  const db = getDatabase()

  // Delete from FTS first
  db.prepare('DELETE FROM transcripts_fts WHERE transcript_id = ?').run(id)

  // Delete transcript (segments and sentence pairs will be deleted by CASCADE)
  const result = db.prepare('DELETE FROM transcripts WHERE id = ?').run(id)

  console.log(`[TranscriptStore] Deleted transcript: ${id}`)
  return result.changes > 0
}

// Export transcript as JSON
export function exportTranscript(id: string): string | null {
  const transcript = getTranscriptWithSegments(id)
  if (!transcript) return null

  return JSON.stringify(transcript, null, 2)
}

// Helper: Insert segments and sentence pairs
function insertSegments(
  db: Database.Database,
  transcriptId: string,
  segments: SaveTranscriptRequest['segments']
): void {
  const segmentStmt = db.prepare(`
    INSERT INTO transcript_segments (transcript_id, speaker, text, translated_text, segment_order)
    VALUES (?, ?, ?, ?, ?)
  `)

  const pairStmt = db.prepare(`
    INSERT INTO sentence_pairs (segment_id, original, translated, pair_order)
    VALUES (?, ?, ?, ?)
  `)

  const insertTransaction = db.transaction((segs: SaveTranscriptRequest['segments']) => {
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const result = segmentStmt.run(
        transcriptId,
        seg.speaker,
        seg.text,
        seg.translated_text || null,
        i
      )

      // Insert sentence pairs if available
      if (seg.sentence_pairs && seg.sentence_pairs.length > 0) {
        for (let j = 0; j < seg.sentence_pairs.length; j++) {
          const pair = seg.sentence_pairs[j]
          pairStmt.run(result.lastInsertRowid, pair.original, pair.translated || null, j)
        }
      }
    }
  })

  insertTransaction(segments)
}

// Helper: Update FTS index
function updateFTSIndex(
  db: Database.Database,
  transcriptId: string,
  title: string,
  note: string,
  segments: SaveTranscriptRequest['segments']
): void {
  // Delete old entry
  db.prepare('DELETE FROM transcripts_fts WHERE transcript_id = ?').run(transcriptId)

  // Build content strings
  const content = segments.map((s) => s.text).join(' ')
  const contentTranslated = segments
    .filter((s) => s.translated_text)
    .map((s) => s.translated_text!)
    .join(' ')

  // Insert new entry
  db.prepare(
    `
    INSERT INTO transcripts_fts (transcript_id, title, note, content, content_translated)
    VALUES (?, ?, ?, ?, ?)
  `
  ).run(transcriptId, title, note, content, contentTranslated)
}

// Helper: Format default title from date
function formatDefaultTitle(isoString: string): string {
  const date = new Date(isoString)
  return `转录 ${formatDateTime(date)}`
}

// Helper: Format date time for display
function formatDateTime(date: Date): string {
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}
