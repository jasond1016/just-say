import { useState, useCallback, type Dispatch, type SetStateAction } from 'react'

export interface Transcript {
  id: string
  title: string
  note: string | null
  duration_seconds: number
  created_at: string
  updated_at: string
  translation_enabled: 0 | 1
  target_language: string | null
  include_microphone: 0 | 1
  source_mode?: 'ptt' | 'meeting'
}

export interface TranscriptSegment {
  id: number
  transcript_id: string
  speaker: number
  text: string
  translated_text: string | null
  segment_order: number
  sentence_pairs?: {
    id: number
    segment_id: number
    original: string
    translated: string | null
    pair_order: number
  }[]
}

export interface TranscriptWithSegments extends Transcript {
  segments: TranscriptSegment[]
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface SearchResult extends PaginatedResult<Transcript> {}

interface UseTranscriptsResult {
  transcripts: Transcript[]
  currentTranscript: TranscriptWithSegments | null
  loading: boolean
  error: string | null
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
  listTranscripts: (page?: number) => Promise<void>
  searchTranscripts: (query: string, page?: number) => Promise<void>
  getTranscript: (id: string) => Promise<TranscriptWithSegments | null>
  updateTranscript: (id: string, data: { title?: string; note?: string }) => Promise<boolean>
  deleteTranscript: (id: string) => Promise<boolean>
  exportTranscript: (id: string) => Promise<string | null>
  setCurrentTranscript: Dispatch<SetStateAction<TranscriptWithSegments | null>>
}

export function useTranscripts(): UseTranscriptsResult {
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [currentTranscript, setCurrentTranscript] = useState<TranscriptWithSegments | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0
  })

  // Load transcripts list
  const listTranscripts = useCallback(
    async (page = 1) => {
      setLoading(true)
      setError(null)
      try {
        const result = await window.api.listTranscripts({
          page,
          pageSize: pagination.pageSize
        })
        setTranscripts(result.items as Transcript[])
        setPagination({
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages
        })
      } catch (err) {
        setError('Failed to load transcripts')
        console.error(err)
      } finally {
        setLoading(false)
      }
    },
    [pagination.pageSize]
  )

  // Search transcripts
  const searchTranscripts = useCallback(
    async (query: string, page = 1) => {
      setLoading(true)
      setError(null)
      try {
        const result = await window.api.searchTranscripts({
          query,
          page,
          pageSize: pagination.pageSize
        })
        setTranscripts(result.items as Transcript[])
        setPagination({
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages
        })
      } catch (err) {
        setError('Search failed')
        console.error(err)
      } finally {
        setLoading(false)
      }
    },
    [pagination.pageSize]
  )

  // Get single transcript with segments
  const getTranscript = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.getTranscript(id)
      if (result) {
        setCurrentTranscript(result as TranscriptWithSegments)
        return result as TranscriptWithSegments
      }
      return null
    } catch (err) {
      setError('Failed to load transcript')
      console.error(err)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  // Update transcript
  const updateTranscript = useCallback(
    async (id: string, data: { title?: string; note?: string }) => {
      setLoading(true)
      setError(null)
      try {
        const success = await window.api.updateTranscript(id, data)
        if (success) {
          // Update local state
          setCurrentTranscript((prev) => {
            if (prev && prev.id === id) {
              return { ...prev, ...data } as TranscriptWithSegments
            }
            return prev
          })
          setTranscripts((prev) => prev.map((t) => (t.id === id ? { ...t, ...data } : t)))
        }
        return success
      } catch (err) {
        setError('Failed to update transcript')
        console.error(err)
        return false
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // Delete transcript
  const deleteTranscript = useCallback(
    async (id: string) => {
      setLoading(true)
      setError(null)
      try {
        const success = await window.api.deleteTranscript(id)
        if (success) {
          setTranscripts((prev) => prev.filter((t) => t.id !== id))
          if (currentTranscript?.id === id) {
            setCurrentTranscript(null)
          }
          setPagination((prev) => ({ ...prev, total: prev.total - 1 }))
        }
        return success
      } catch (err) {
        setError('Failed to delete transcript')
        console.error(err)
        return false
      } finally {
        setLoading(false)
      }
    },
    [currentTranscript]
  )

  // Export transcript as JSON
  const exportTranscript = useCallback(async (id: string): Promise<string | null> => {
    try {
      const json = await window.api.exportTranscript(id)
      if (json) {
        // Trigger download
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `transcript-${id.slice(0, 8)}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
      return json
    } catch (err) {
      setError('Failed to export transcript')
      console.error(err)
      return null
    }
  }, [])

  return {
    transcripts,
    currentTranscript,
    loading,
    error,
    pagination,
    listTranscripts,
    searchTranscripts,
    getTranscript,
    updateTranscript,
    deleteTranscript,
    exportTranscript,
    setCurrentTranscript
  }
}
