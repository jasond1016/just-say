import React, { useState, useEffect, useRef, useCallback } from 'react'
import './MeetingTranscription.css'
import {
    startSystemAudioCapture,
    stopSystemAudioCapture
} from '../system-audio-capture'
import {
    startMicrophoneCapture,
    stopMicrophoneCapture
} from '../microphone-capture'

interface SentencePair {
    original: string
    translated?: string
}

interface SpeakerSegment {
    speaker: number
    text: string
    translatedText?: string
    sentencePairs?: SentencePair[]
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

    // Start transcription
    const startTranscription = async (): Promise<void> => {
        try {
            // First start the recognition service in main process
            await window.api.startMeetingTranscription({
                includeMicrophone: includeMic,
                translationEnabled: enableTranslation,
                targetLanguage: enableTranslation ? targetLanguage : undefined
            })

            // Start system audio capture in renderer process
            // Audio data will be sent to main process via IPC
            await startSystemAudioCapture(null)

            // Start microphone capture if enabled
            if (includeMic) {
                await startMicrophoneCapture()
            }

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
            // Clean up if start failed
            stopSystemAudioCapture()
            stopMicrophoneCapture()
        }
    }

    // Stop transcription
    const stopTranscription = async (): Promise<void> => {
        // Stop audio captures in renderer process
        stopSystemAudioCapture()
        stopMicrophoneCapture()

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
            // Final segment: merge currentSegment into segments before clearing
            setSegments((prev) => {
                // If there's a currentSpeakerSegment with content, add it to segments
                if (segment.currentSpeakerSegment && segment.currentSpeakerSegment.text.trim()) {
                    return [...prev, segment.currentSpeakerSegment]
                }
                return prev
            })
            setCurrentSegment(null)
            return
        }

        const speakerSegments = segment.speakerSegments || []

        if (speakerSegments.length > 0) {
            setSegments((prev) => {
                const newSegments = speakerSegments.slice(prev.length)
                return [...prev, ...newSegments.filter((s) => s.text.trim())]
            })
        }

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
    const hasContent = segments.length > 0 || currentSegment

    return (
        <div className="content-view meeting-view">
            {/* Transcript Area - Primary Focus */}
            <div className="meeting-transcript">
                <div className="meeting-transcript__header">
                    <div className="meeting-transcript__header-left">
                        <span className="card__title">实时转录</span>
                        {isTranscribing && (
                            <>
                                <span className="meeting-timer-inline">{formatDuration(seconds)}</span>
                                <button className="stop-btn-inline" onClick={stopTranscription} title="停止转录">
                                    ⏹
                                </button>
                            </>
                        )}
                    </div>
                    <div className="meeting-transcript__header-right">
                        {hasContent && !isTranscribing && (
                            <button className="btn btn--ghost btn--sm" onClick={clearTranscript}>
                                清空
                            </button>
                        )}
                    </div>
                </div>
                <div className="meeting-transcript__content" ref={transcriptRef}>
                    {segments.length === 0 && !currentSegment ? (
                        <div className="meeting-transcript__placeholder">
                            <div className="placeholder-icon">📝</div>
                            <div className="placeholder-text">
                                {isTranscribing ? '等待语音输入...' : '点击下方按钮开始转录'}
                            </div>
                        </div>
                    ) : (
                        <>
                            {segments.map((seg, idx) => {
                                // Use sentencePairs if available (aligned by <end> tokens), otherwise fallback
                                const pairs = seg.sentencePairs || (seg.text ? [{ original: seg.text, translated: seg.translatedText }] : [])
                                return (
                                    <div key={idx} className={`transcript-segment ${getSpeakerClass(seg.speaker)}`}>
                                        <div className="transcript-segment__meta">
                                            <span className={`transcript-segment__speaker ${getSpeakerClass(seg.speaker)}`}>
                                                说话人 {seg.speaker + 1}
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
                            {currentSegment && (() => {
                                const pairs = currentSegment.sentencePairs || (currentSegment.text ? [{ original: currentSegment.text, translated: currentSegment.translatedText }] : [])
                                return (
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
                            })()}
                        </>
                    )}
                </div>
            </div>

            {/* Bottom Control Bar - Only shown when NOT transcribing */}
            {!isTranscribing && (
                <div className="meeting-control-bar">
                    <div className="meeting-control-bar__primary">
                        <button className="btn btn--primary" onClick={startTranscription}>
                            <span className="btn-icon">▶️</span>
                            开始转录
                        </button>
                    </div>

                    <div className="meeting-control-bar__settings">
                        <label className="checkbox">
                            <input
                                type="checkbox"
                                className="checkbox__input"
                                checked={includeMic}
                                onChange={(e) => setIncludeMic(e.target.checked)}
                            />
                            <span>🎤 麦克风</span>
                        </label>

                        <div className="control-divider" />

                        <label className="checkbox">
                            <input
                                type="checkbox"
                                className="checkbox__input"
                                checked={enableTranslation}
                                onChange={(e) => setEnableTranslation(e.target.checked)}
                            />
                            <span>🌐 翻译</span>
                        </label>

                        {enableTranslation && (
                            <select
                                className="form-input form-select form-select--compact"
                                value={targetLanguage}
                                onChange={(e) => setTargetLanguage(e.target.value)}
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
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
