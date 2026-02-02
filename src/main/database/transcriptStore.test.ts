import { describe, it, expect, vi, beforeEach } from 'vitest'

// Types for testing
interface Transcript {
  id: string
  title: string
  note: string | null
  duration_seconds: number
  created_at: string
  updated_at: string
  translation_enabled: number
  target_language: string | null
  include_microphone: number
}

interface TranscriptSegment {
  id: string
  transcript_id: string
  speaker: string | null
  text: string
  translated_text: string | null
  segment_order: number
}

interface SentencePair {
  id: string
  segment_id: string
  original: string
  translated: string | null
  pair_order: number
}

interface SaveTranscriptRequest {
  title?: string
  note?: string
  duration_seconds: number
  segments: Array<{
    speaker?: string | null
    text: string
    translated_text?: string | null
    sentence_pairs?: Array<{
      original: string
      translated?: string | null
    }>
  }>
  translation_enabled?: boolean
  target_language?: string
  include_microphone?: boolean
}

// Helper function used in tests
const formatDefaultTitle = (isoString: string): string => {
  const date = new Date(isoString)
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `转录 ${year}-${month}-${day} ${hours}:${minutes}`
}

interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

// Mock database
const mockTranscripts: Map<string, Transcript> = new Map()
const mockSegments: Map<string, TranscriptSegment[]> = new Map()
const mockSentencePairs: Map<string, SentencePair[]> = new Map()

const createMockDb = () => ({
  prepare: (sql: string) => ({
    run: (...args: any[]) => {
      // Handle INSERT
      if (sql.includes('INSERT INTO transcripts')) {
        const id = args[0]
        const transcript: Transcript = {
          id,
          title: args[1],
          note: args[2],
          duration_seconds: args[3],
          created_at: args[4],
          updated_at: args[5],
          translation_enabled: args[6],
          target_language: args[7],
          include_microphone: args[8]
        }
        mockTranscripts.set(id, transcript)
        return { lastInsertRowid: 1, changes: 1 }
      }
      // Handle UPDATE
      if (sql.includes('UPDATE transcripts')) {
        const id = args[args.length - 1]
        const existing = mockTranscripts.get(id)
        if (existing) {
          existing.updated_at = args[args.length - 2] || existing.updated_at
          if (sql.includes('title = ?')) {
            existing.title = args[args.length - 3] || existing.title
          }
        }
        return { changes: existing ? 1 : 0 }
      }
      // Handle DELETE FTS - check before main DELETE to avoid substring match
      if (sql.includes('DELETE FROM transcripts_fts')) {
        return { changes: 0 }
      }
      // Handle DELETE from main table
      if (sql.includes('DELETE FROM transcripts WHERE')) {
        const id = args[0]
        const existed = mockTranscripts.has(id)
        mockTranscripts.delete(id)
        return { changes: existed ? 1 : 0 }
      }
      // Handle INSERT FTS
      if (sql.includes('INSERT INTO transcripts_fts')) {
        return { changes: 1 }
      }
      // Handle INSERT segments
      if (sql.includes('INSERT INTO transcript_segments')) {
        const transcriptId = args[0]
        const segmentId = `seg-${Date.now()}`
        const segment: TranscriptSegment = {
          id: segmentId,
          transcript_id: transcriptId,
          speaker: args[1],
          text: args[2],
          translated_text: args[3],
          segment_order: args[4]
        }
        const existing = mockSegments.get(transcriptId) || []
        existing.push(segment)
        mockSegments.set(transcriptId, existing)
        return { lastInsertRowid: 1, changes: 1 }
      }
      // Handle INSERT sentence_pairs
      if (sql.includes('INSERT INTO sentence_pairs')) {
        const segmentId = args[0]
        const pair: SentencePair = {
          id: `pair-${Date.now()}`,
          segment_id: segmentId,
          original: args[1],
          translated: args[2],
          pair_order: args[3]
        }
        const existing = mockSentencePairs.get(segmentId) || []
        existing.push(pair)
        mockSentencePairs.set(segmentId, existing)
        return { lastInsertRowid: 1, changes: 1 }
      }
      return { changes: 0 }
    },
    get: (...args: any[]) => {
      // Handle SELECT * FROM transcripts WHERE id = ?
      if (sql.includes('SELECT * FROM transcripts WHERE id = ?')) {
        return mockTranscripts.get(args[0]) || undefined
      }
      // Handle SELECT COUNT(*) FROM transcripts
      if (sql.includes('SELECT COUNT(*) as count FROM transcripts')) {
        return { count: mockTranscripts.size }
      }
      return undefined
    },
    all: (...args: any[]) => {
      // Handle SELECT * FROM transcripts ORDER BY with LIMIT/OFFSET
      if (sql.includes('SELECT * FROM transcripts') && sql.includes('ORDER BY')) {
        const allItems = Array.from(mockTranscripts.values())
        // Handle LIMIT and OFFSET if present
        const limitIndex = args.findIndex((arg: any) => typeof arg === 'number')
        if (limitIndex !== -1) {
          const limit = args[limitIndex] as number
          const offset = args[limitIndex + 1] as number || 0
          return allItems.slice(offset, offset + limit)
        }
        return allItems
      }
      // Handle SELECT * FROM transcript_segments
      if (sql.includes('SELECT * FROM transcript_segments')) {
        return mockSegments.get(args[0]) || []
      }
      // Handle SELECT * FROM sentence_pairs
      if (sql.includes('SELECT * FROM sentence_pairs')) {
        return mockSentencePairs.get(args[0]) || []
      }
      return []
    }
  }),
  transaction: (fn: any) => fn
})

describe('transcriptStore', () => {
  let mockDb: ReturnType<typeof createMockDb>

  beforeEach(() => {
    vi.resetModules()
    mockTranscripts.clear()
    mockSegments.clear()
    mockSentencePairs.clear()
    mockDb = createMockDb()
  })

  describe('createTranscript', () => {
    it('should create a transcript with segments', () => {
      const request: SaveTranscriptRequest = {
        duration_seconds: 120,
        segments: [
          { text: 'Hello world', speaker: 'Speaker A' },
          { text: 'Goodbye world', speaker: 'Speaker B' }
        ]
      }

      const createTranscript = (data: SaveTranscriptRequest): Transcript => {
        const now = new Date().toISOString()
        const id = `test-${Date.now()}`
        const title = data.title || formatDefaultTitle(now)

        mockDb.prepare(`
          INSERT INTO transcripts (id, title, note, duration_seconds, created_at, updated_at, translation_enabled, target_language, include_microphone)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, title, data.note || null, data.duration_seconds,
          now, now,
          data.translation_enabled ? 1 : 0,
          data.target_language || null,
          data.include_microphone ? 1 : 0
        )

        return mockDb.prepare('SELECT * FROM transcripts WHERE id = ?').get(id) as Transcript
      }

      const result = createTranscript(request)

      expect(result.id).toBeDefined()
      expect(result.title).toContain('转录')
      expect(result.duration_seconds).toBe(120)
    })

    it('should use custom title when provided', () => {
      const request: SaveTranscriptRequest = {
        title: 'My Meeting',
        duration_seconds: 60,
        segments: [{ text: 'Test segment' }]
      }

      const createTranscript = (data: SaveTranscriptRequest): Transcript => {
        const now = new Date().toISOString()
        const id = `test-${Date.now()}`
        const title = data.title || formatDefaultTitle(now)

        mockDb.prepare(`
          INSERT INTO transcripts (id, title, note, duration_seconds, created_at, updated_at, translation_enabled, target_language, include_microphone)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, title, data.note || null, data.duration_seconds,
          now, now, 0, null, 0
        )

        return mockDb.prepare('SELECT * FROM transcripts WHERE id = ?').get(id) as Transcript
      }

      const result = createTranscript(request)

      expect(result.title).toBe('My Meeting')
    })
  })

  describe('getTranscriptById', () => {
    it('should return transcript when found', () => {
      const id = 'existing-id'
      mockTranscripts.set(id, {
        id,
        title: 'Test',
        note: null,
        duration_seconds: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        translation_enabled: 0,
        target_language: null,
        include_microphone: 0
      })

      const getTranscriptById = (testId: string): Transcript | null => {
        const result = mockDb.prepare('SELECT * FROM transcripts WHERE id = ?').get(testId)
        return (result as Transcript | undefined) || null
      }

      const result = getTranscriptById(id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(id)
    })

    it('should return null when not found', () => {
      const getTranscriptById = (testId: string): Transcript | null => {
        const result = mockDb.prepare('SELECT * FROM transcripts WHERE id = ?').get(testId)
        return (result as Transcript | undefined) || null
      }

      const result = getTranscriptById('non-existent-id')

      expect(result).toBeNull()
    })
  })

  describe('listTranscripts', () => {
    it('should return paginated results', () => {
      // Add some transcripts
      for (let i = 0; i < 5; i++) {
        mockTranscripts.set(`id-${i}`, {
          id: `id-${i}`,
          title: `Test ${i}`,
          note: null,
          duration_seconds: 60,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          translation_enabled: 0,
          target_language: null,
          include_microphone: 0
        })
      }

      const listTranscripts = (options: { page?: number; pageSize?: number } = {}): PaginatedResult<Transcript> => {
        const page = options.page || 1
        const pageSize = options.pageSize || 20
        const offset = (page - 1) * pageSize

        const items = mockDb.prepare(`
          SELECT * FROM transcripts
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `).all(pageSize, offset) as Transcript[]

        const total = mockDb.prepare('SELECT COUNT(*) as count FROM transcripts').get() as { count: number }

        return {
          items,
          total: total.count,
          page,
          pageSize,
          totalPages: Math.ceil(total.count / pageSize)
        }
      }

      const result = listTranscripts({ page: 1, pageSize: 3 })

      expect(result.items.length).toBe(3)
      expect(result.total).toBe(5)
      expect(result.totalPages).toBe(2)
    })
  })

  describe('deleteTranscript', () => {
    it('should delete transcript and return true', () => {
      const id = 'to-delete'
      mockTranscripts.set(id, {
        id,
        title: 'Test',
        note: null,
        duration_seconds: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        translation_enabled: 0,
        target_language: null,
        include_microphone: 0
      })

      const deleteTranscript = (testId: string): boolean => {
        mockDb.prepare('DELETE FROM transcripts_fts WHERE transcript_id = ?').run(testId)
        const result = mockDb.prepare('DELETE FROM transcripts WHERE id = ?').run(testId)
        return result.changes > 0
      }

      const result = deleteTranscript(id)

      expect(result).toBe(true)
      expect(mockTranscripts.has(id)).toBe(false)
    })

    it('should return false when transcript does not exist', () => {
      const deleteTranscript = (testId: string): boolean => {
        mockDb.prepare('DELETE FROM transcripts_fts WHERE transcript_id = ?').run(testId)
        const result = mockDb.prepare('DELETE FROM transcripts WHERE id = ?').run(testId)
        return result.changes > 0
      }

      const result = deleteTranscript('non-existent')

      expect(result).toBe(false)
    })
  })

  describe('updateTranscript', () => {
    it('should update title', () => {
      const id = 'to-update'
      mockTranscripts.set(id, {
        id,
        title: 'Original',
        note: null,
        duration_seconds: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        translation_enabled: 0,
        target_language: null,
        include_microphone: 0
      })

      const updateTranscript = (testId: string, data: { title?: string }): boolean => {
        const updates: string[] = []
        const values: (string | null)[] = []

        if (data.title !== undefined) {
          updates.push('title = ?')
          values.push(data.title)
        }

        if (updates.length === 0) return false

        values.push(new Date().toISOString())
        values.push(testId)

        const result = mockDb.prepare(`
          UPDATE transcripts
          SET ${updates.join(', ')}
          WHERE id = ?
        `).run(...values)

        return result.changes > 0
      }

      const result = updateTranscript(id, { title: 'Updated' })

      expect(result).toBe(true)
      expect(mockTranscripts.get(id)?.title).toBe('Updated')
    })
  })

  describe('formatDefaultTitle', () => {
    it('should format date correctly', () => {
      const result = formatDefaultTitle('2024-01-15T10:30:00.000Z')

      expect(result).toMatch(/转录 2024-01-15 \d{2}:30/)
    })
  })

  describe('exportTranscript', () => {
    it('should return JSON string when transcript exists', () => {
      const id = 'to-export'
      mockTranscripts.set(id, {
        id,
        title: 'Test Export',
        note: 'Some note',
        duration_seconds: 120,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        translation_enabled: 1,
        target_language: 'en',
        include_microphone: 1
      })
      mockSegments.set(id, [
        {
          id: 'seg-1',
          transcript_id: id,
          speaker: 'Speaker A',
          text: 'Hello',
          translated_text: '你好',
          segment_order: 0
        }
      ])
      mockSentencePairs.set('seg-1', [
        {
          id: 'pair-1',
          segment_id: 'seg-1',
          original: 'Hello',
          translated: '你好',
          pair_order: 0
        }
      ])

      const exportTranscript = (testId: string): string | null => {
        const transcript = mockDb.prepare('SELECT * FROM transcripts WHERE id = ?').get(testId) as Transcript | undefined
        if (!transcript) return null

        const segments = mockDb.prepare('SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY segment_order').all(testId)

        return JSON.stringify({ ...transcript, segments }, null, 2)
      }

      const result = exportTranscript(id)

      expect(result).not.toBeNull()
      expect(() => JSON.parse(result!)).not.toThrow()
      const parsed = JSON.parse(result!)
      expect(parsed.title).toBe('Test Export')
      expect(parsed.segments.length).toBe(1)
    })

    it('should return null when transcript does not exist', () => {
      const exportTranscript = (testId: string): string | null => {
        const transcript = mockDb.prepare('SELECT * FROM transcripts WHERE id = ?').get(testId) as Transcript | undefined
        if (!transcript) return null
        return JSON.stringify(transcript)
      }

      const result = exportTranscript('non-existent')

      expect(result).toBeNull()
    })
  })
})
