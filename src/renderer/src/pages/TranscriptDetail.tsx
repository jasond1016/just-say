import React, { useEffect, useState, useCallback } from 'react'
import { useTranscripts } from '../hooks/useTranscripts'
import './TranscriptDetail.css'

interface TranscriptDetailProps {
  id: string
  onBack: () => void
}

export function TranscriptDetail({ id, onBack }: TranscriptDetailProps): React.JSX.Element {
  const {
    currentTranscript,
    loading,
    error,
    getTranscript,
    updateTranscript,
    exportTranscript
  } = useTranscripts()

  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editNote, setEditNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Load transcript on mount
  useEffect(() => {
    getTranscript(id)
  }, [id])

  // Update edit state when transcript loads
  useEffect(() => {
    if (currentTranscript) {
      setEditTitle(currentTranscript.title)
      setEditNote(currentTranscript.note || '')
    }
  }, [currentTranscript])

  const handleSave = useCallback(async () => {
    if (!currentTranscript) return

    setSaving(true)
    try {
      await updateTranscript(id, {
        title: editTitle.trim() || currentTranscript.title,
        note: editNote.trim() || undefined
      })
      setIsEditing(false)
    } catch (err) {
      console.error('Failed to save:', err)
    } finally {
      setSaving(false)
    }
  }, [currentTranscript, id, editTitle, editNote, updateTranscript])

  const handleCancel = useCallback(() => {
    if (currentTranscript) {
      setEditTitle(currentTranscript.title)
      setEditNote(currentTranscript.note || '')
    }
    setIsEditing(false)
  }, [currentTranscript])

  const handleExport = useCallback(async () => {
    await exportTranscript(id)
  }, [id, exportTranscript])

  const formatDuration = (seconds: number): string => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h > 0) {
      return `${h}小时 ${m}分 ${s}秒`
    }
    return `${m}分 ${s}秒`
  }

  const formatDate = (isoString: string): string => {
    const date = new Date(isoString)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const getSpeakerClass = (speaker: number): string => {
    return `speaker-${speaker % 8}`
  }

  if (loading) {
    return (
      <div className="content-view transcript-detail">
        <div className="transcript-detail__loading">
          <div className="loading-spinner" />
          <span>加载中...</span>
        </div>
      </div>
    )
  }

  if (error || !currentTranscript) {
    return (
      <div className="content-view transcript-detail">
        <div className="transcript-detail__error">
          <h3>加载失败</h3>
          <p>{error || '未找到转录记录'}</p>
          <button className="btn btn--primary" onClick={onBack}>
            返回
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="content-view transcript-detail">
      <div className="transcript-detail__header">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m15 18-6-6 6-6" />
          </svg>
          返回
        </button>

        <div className="transcript-detail__actions">
          <button className="btn btn--ghost" onClick={handleExport}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            导出 JSON
          </button>
          {!isEditing && (
            <button className="btn btn--ghost" onClick={() => setIsEditing(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              编辑
            </button>
          )}
        </div>
      </div>

      <div className="transcript-detail__meta">
        {isEditing ? (
          <div className="transcript-detail__edit-form">
            <input
              type="text"
              className="form-input"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="输入标题"
            />
            <textarea
              className="form-textarea"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              placeholder="添加备注..."
              rows={3}
            />
            <div className="transcript-detail__edit-actions">
              <button className="btn btn--ghost" onClick={handleCancel} disabled={saving}>
                取消
              </button>
              <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <h1 className="transcript-detail__title">{currentTranscript.title}</h1>
            {currentTranscript.note && (
              <p className="transcript-detail__note">{currentTranscript.note}</p>
            )}
          </>
        )}

        <div className="transcript-detail__info">
          <span className="transcript-detail__info-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            {formatDuration(currentTranscript.duration_seconds)}
          </span>
          <span className="transcript-detail__info-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            {formatDate(currentTranscript.created_at)}
          </span>
          {currentTranscript.translation_enabled === 1 && (
            <span className="transcript-detail__badge transcript-detail__badge--translation">
              翻译
            </span>
          )}
          {currentTranscript.include_microphone === 1 && (
            <span className="transcript-detail__badge transcript-detail__badge--mic">
              麦克风
            </span>
          )}
        </div>
      </div>

      <div className="transcript-detail__content">
        {currentTranscript.segments.map((segment, idx) => {
          const pairs = segment.sentence_pairs?.length
            ? segment.sentence_pairs
            : [{ original: segment.text, translated: segment.translated_text, pair_order: 0 }]

          return (
            <div key={segment.id || idx} className={`transcript-segment ${getSpeakerClass(segment.speaker)}`}>
              <div className="transcript-segment__meta">
                <span className={`transcript-segment__speaker ${getSpeakerClass(segment.speaker)}`}>
                  说话人 {segment.speaker + 1}
                </span>
              </div>
              <div className="transcript-segment__sentences">
                {pairs.map((pair, sentIdx) => (
                  <div key={sentIdx} className="sentence-pair">
                    <div className="sentence-original">{pair.original}</div>
                    {pair.translated && (
                      <div className="sentence-translated">{pair.translated}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
