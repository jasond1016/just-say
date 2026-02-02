import React from 'react'
import type { Transcript } from '../../hooks/useTranscripts'
import './TranscriptCard.css'

interface TranscriptCardProps {
  transcript: Transcript
  onClick: () => void
  onDelete?: () => void
}

export function TranscriptCard({ transcript, onClick, onDelete }: TranscriptCardProps): React.JSX.Element {
  const formatDuration = (seconds: number): string => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    }
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const formatDate = (isoString: string): string => {
    const date = new Date(isoString)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()

    if (isToday) {
      return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
    }

    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (date.toDateString() === yesterday.toDateString()) {
      return `昨天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
    }

    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
  }

  const truncateTitle = (title: string, maxLength = 30): string => {
    if (title.length <= maxLength) return title
    return title.slice(0, maxLength) + '...'
  }

  return (
    <div className="transcript-card" onClick={onClick}>
      <div className="transcript-card__header">
        <h3 className="transcript-card__title" title={transcript.title}>
          {truncateTitle(transcript.title)}
        </h3>
        <span className="transcript-card__date">{formatDate(transcript.created_at)}</span>
      </div>

      {transcript.note && (
        <p className="transcript-card__note">{truncateTitle(transcript.note, 50)}</p>
      )}

      <div className="transcript-card__footer">
        <span className="transcript-card__duration">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {formatDuration(transcript.duration_seconds)}
        </span>

        <div className="transcript-card__badges">
          {transcript.translation_enabled === 1 && (
            <span className="transcript-card__badge transcript-card__badge--translation">
              翻译
            </span>
          )}
          {transcript.include_microphone === 1 && (
            <span className="transcript-card__badge transcript-card__badge--mic">
              麦克风
            </span>
          )}
        </div>

        {onDelete && (
          <button
            className="transcript-card__delete"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title="删除"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
