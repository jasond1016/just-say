import React, { useEffect, useCallback, useState } from 'react'
import { useTranscripts } from '../hooks/useTranscripts'
import { TranscriptCard } from '../components/TranscriptHistory/TranscriptCard'
import { SearchBar } from '../components/TranscriptHistory/SearchBar'
import './TranscriptHistory.css'

interface TranscriptHistoryProps {
  onNavigateToDetail: (id: string) => void
  onBack?: () => void
}

export function TranscriptHistory({ onNavigateToDetail, onBack }: TranscriptHistoryProps): React.JSX.Element {
  const {
    transcripts,
    loading,
    error,
    pagination,
    listTranscripts,
    searchTranscripts,
    deleteTranscript
  } = useTranscripts()

  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Load initial data
  useEffect(() => {
    listTranscripts(1)
  }, [])

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query)
    if (query.trim()) {
      setSearchMode(true)
      searchTranscripts(query, 1)
    }
  }, [searchTranscripts])

  const handleClearSearch = useCallback(() => {
    setSearchMode(false)
    setSearchQuery('')
    listTranscripts(1)
  }, [listTranscripts])

  const handlePageChange = useCallback((page: number) => {
    if (searchMode) {
      searchTranscripts(searchQuery, page)
    } else {
      listTranscripts(page)
    }
  }, [searchMode, searchQuery, searchTranscripts, listTranscripts])

  const handleDelete = useCallback(async (id: string) => {
    if (window.confirm('确定要删除这条转录记录吗？此操作不可恢复。')) {
      await deleteTranscript(id)
    }
  }, [deleteTranscript])

  const handleCardClick = useCallback((id: string) => {
    onNavigateToDetail(id)
  }, [onNavigateToDetail])

  return (
    <div className="content-view transcript-history">
      <div className="transcript-history__header">
        <div className="transcript-history__header-top">
          {onBack && (
            <button className="btn btn--ghost btn--sm" onClick={onBack}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m15 18-6-6 6-6" />
              </svg>
              返回
            </button>
          )}
          <h1 className="transcript-history__title">转录历史</h1>
          <span className="transcript-history__count">
            {searchMode ? `搜索结果: ${pagination.total} 条` : `共 ${pagination.total} 条`}
          </span>
        </div>

        <SearchBar
          onSearch={handleSearch}
          onClear={handleClearSearch}
          placeholder="搜索标题、备注或内容..."
        />
      </div>

      {error && (
        <div className="transcript-history__error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
        </div>
      )}

      {loading ? (
        <div className="transcript-history__loading">
          <div className="loading-spinner" />
          <span>加载中...</span>
        </div>
      ) : transcripts.length === 0 ? (
        <div className="transcript-history__empty">
          <div className="transcript-history__empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <h3>{searchMode ? '未找到相关转录' : '暂无转录记录'}</h3>
          <p>{searchMode ? '尝试其他搜索关键词' : '开始一次会议转录后，记录将自动保存到这里'}</p>
        </div>
      ) : (
        <>
          <div className="transcript-history__list">
            {transcripts.map((transcript) => (
              <TranscriptCard
                key={transcript.id}
                transcript={transcript}
                onClick={() => handleCardClick(transcript.id)}
                onDelete={() => handleDelete(transcript.id)}
              />
            ))}
          </div>

          {pagination.totalPages > 1 && (
            <div className="transcript-history__pagination">
              <button
                className="pagination-btn"
                disabled={pagination.page <= 1}
                onClick={() => handlePageChange(pagination.page - 1)}
              >
                上一页
              </button>
              <span className="pagination-info">
                第 {pagination.page} / {pagination.totalPages} 页，共 {pagination.total} 条
              </span>
              <button
                className="pagination-btn"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => handlePageChange(pagination.page + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
