import React, { useState, useEffect, useRef, useCallback } from 'react'
import './MeetingTranscription.css'

interface SpeakerSegment {
    speaker: number
    text: string
    translatedText?: string
}

interface TranscriptSegment {
    text: string
    timestamp: number
    isFinal: boolean
    speakerSegments?: SpeakerSegment[]
    currentSpeakerSegment?: SpeakerSegment
}

type TranscriptionStatus = 'idle' | 'transcribing' | 'error'

export function MeetingTranscription(): React.JSX.Element {
    const [status, setStatus] = useState<TranscriptionStatus>('idle')
    const [includeMic, setIncludeMic] = useState(false)
    const [enableTranslation, setEnableTranslation] = useState(false)
    const [targetLanguage, setTargetLanguage] = useState('en')
    const [seconds, setSeconds] = useState(0)
    const [segments, setSegments] = useState<SpeakerSegment[]>([])
    const [currentSegment, setCurrentSegment] = useState<SpeakerSegment | null>(null)

    const transcriptRef = useRef<HTMLDivElement>(null)
    const timerRef = useRef<NodeJS.Timeout | null>(null)

    // Format duration as HH:MM:SS
    const formatDuration = (s: number): string => {
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const sec = s % 60
        return [h, m, sec].map((v) => v.toString().padStart(2, '0')).join(':')
    }

    // Get speaker color class
    const getSpeakerClass = (speaker: number): string => {
        return `speaker-${speaker % 8}`
    }

    // Format text with line breaks after sentences
    const formatText = (text: string): string => {
        if (!text) return ''
        return text.replace(/([.!?。！？]["']?\s)/g, '$1<br>').replace(/([.!?。！？]["']?)$/g, '$1')
    }

    // Start transcription
    const startTranscription = async (): Promise<void> => {
        try {
            await window.api.startMeetingTranscription({
                includeMicrophone: includeMic,
                translationEnabled: enableTranslation,
                targetLanguage: enableTranslation ? targetLanguage : undefined
            })

            setStatus('transcribing')
            setSegments([])
            setCurrentSegment(null)
            setSeconds(0)

            // Start timer
            timerRef.current = setInterval(() => {
                setSeconds((s) => s + 1)
            }, 1000)
        } catch (err) {
            console.error('Start error:', err)
            setStatus('error')
        }
    }

    // Stop transcription
    const stopTranscription = async (): Promise<void> => {
        try {
            await window.api.stopMeetingTranscription()
        } catch (err) {
            console.error('Stop error:', err)
        }

        setStatus('idle')
        setCurrentSegment(null)

        if (timerRef.current) {
            clearInterval(timerRef.current)
            timerRef.current = null
        }
    }

    // Clear transcript
    const clearTranscript = (): void => {
        setSegments([])
        setCurrentSegment(null)
    }

    // Handle transcript segment
    const handleTranscript = useCallback((segment: TranscriptSegment) => {
        if (segment.isFinal) {
            // Finalize current segment if any
            setCurrentSegment(null)
            return
        }

        const speakerSegments = segment.speakerSegments || []

        // Add new completed segments
        if (speakerSegments.length > 0) {
            setSegments((prev) => {
                // Only add segments we haven't added yet
                const newSegments = speakerSegments.slice(prev.length)
                return [...prev, ...newSegments.filter((s) => s.text.trim())]
            })
        }

        // Update current partial segment
        if (segment.currentSpeakerSegment && segment.currentSpeakerSegment.text.trim()) {
            setCurrentSegment(segment.currentSpeakerSegment)
        } else {
            setCurrentSegment(null)
        }
    }, [])

    // Listen for transcript and status events
    useEffect(() => {
        window.api.onMeetingTranscript(handleTranscript)

        window.api.onMeetingStatus((s: string) => {
            if (s === 'idle' && status === 'transcribing') {
                stopTranscription()
            } else if (s === 'error') {
                setStatus('error')
            }
        })

        return () => {
            window.api.removeAllListeners?.('meeting-transcript')
            window.api.removeAllListeners?.('meeting-status')
        }
    }, [handleTranscript, status])

    // Auto-scroll to bottom
    useEffect(() => {
        if (transcriptRef.current) {
            transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
        }
    }, [segments, currentSegment])

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current)
            }
        }
    }, [])

    const isTranscribing = status === 'transcribing'

    return (
        <div className="content-view meeting-view">
            <div className="content-header">
                <div className="content-header__title">
                    <span className="content-header__title-icon">📝</span>
                    <h1>会议转录</h1>
                </div>
                <div className={`status-badge status-badge--${status === 'transcribing' ? 'active' : status}`}>
                    <span className="status-dot" />
                    <span>
                        {status === 'idle' ? '就绪' : status === 'transcribing' ? '转录中' : '错误'}
                    </span>
                </div>
            </div>

            {/* Controls */}
            <div className="meeting-controls">
                {!isTranscribing ? (
                    <button className="btn btn--primary" onClick={startTranscription}>
                        <span className="btn-icon">▶️</span>
                        开始转录
                    </button>
                ) : (
                    <button className="btn btn--danger" onClick={stopTranscription}>
                        <span className="btn-icon">⏹️</span>
                        停止转录
                    </button>
                )}

                <label className="checkbox">
                    <input
                        type="checkbox"
                        className="checkbox__input"
                        checked={includeMic}
                        onChange={(e) => setIncludeMic(e.target.checked)}
                        disabled={isTranscribing}
                    />
                    <span>录麦克风</span>
                </label>

                <div className="meeting-controls__divider" />

                <label className="checkbox">
                    <input
                        type="checkbox"
                        className="checkbox__input"
                        checked={enableTranslation}
                        onChange={(e) => setEnableTranslation(e.target.checked)}
                        disabled={isTranscribing}
                    />
                    <span>实时翻译</span>
                </label>

                <select
                    className="form-input form-select"
                    style={{ width: 130, padding: '6px 12px' }}
                    value={targetLanguage}
                    onChange={(e) => setTargetLanguage(e.target.value)}
                    disabled={!enableTranslation || isTranscribing}
                >
                    <option value="en">英语</option>
                    <option value="zh">中文</option>
                    <option value="ja">日语</option>
                    <option value="ko">韩语</option>
                    <option value="fr">法语</option>
                    <option value="de">德语</option>
                    <option value="es">西班牙语</option>
                    <option value="ru">俄语</option>
                </select>
            </div>

            {/* Timer */}
            <div className={`meeting-timer ${isTranscribing ? 'recording' : ''}`}>
                {formatDuration(seconds)}
            </div>

            {/* Transcript Area */}
            <div className="meeting-transcript">
                <div className="meeting-transcript__header">
                    <span className="card__title">实时转录</span>
                    <button className="btn btn--ghost btn--sm" onClick={clearTranscript}>
                        清空
                    </button>
                </div>
                <div className="meeting-transcript__content" ref={transcriptRef}>
                    {segments.length === 0 && !currentSegment ? (
                        <div className="meeting-transcript__placeholder">
                            点击"开始转录"捕获系统音频并实时转录...
                        </div>
                    ) : (
                        <>
                            {segments.map((seg, idx) => (
                                <div key={idx} className={`transcript-segment ${getSpeakerClass(seg.speaker)}`}>
                                    <div className="transcript-segment__meta">
                                        <span className={`transcript-segment__speaker ${getSpeakerClass(seg.speaker)}`}>
                                            说话人 {seg.speaker + 1}
                                        </span>
                                    </div>
                                    <div
                                        className="transcript-segment__text"
                                        dangerouslySetInnerHTML={{ __html: formatText(seg.text) }}
                                    />
                                    {seg.translatedText && (
                                        <div className="transcript-segment__translation">
                                            <span className="translation-label">译文:</span>
                                            <span dangerouslySetInnerHTML={{ __html: formatText(seg.translatedText) }} />
                                        </div>
                                    )}
                                </div>
                            ))}
                            {currentSegment && (
                                <div
                                    className={`transcript-segment transcript-segment--partial ${getSpeakerClass(currentSegment.speaker)}`}
                                >
                                    <div className="transcript-segment__meta">
                                        <span
                                            className={`transcript-segment__speaker ${getSpeakerClass(currentSegment.speaker)}`}
                                        >
                                            说话人 {currentSegment.speaker + 1}
                                        </span>
                                    </div>
                                    <div className="transcript-segment__text">{currentSegment.text}</div>
                                    {currentSegment.translatedText && (
                                        <div className="transcript-segment__translation">
                                            <span className="translation-label">译文:</span>
                                            <span>{currentSegment.translatedText}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
