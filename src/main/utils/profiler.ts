/**
 * Profiler for measuring real user-perceived latency in meeting transcription.
 * Uses time-window based approach since Soniox returns batched responses.
 */

export interface AudioWindow {
  startTime: number // When audio capture started for this window
  endTime: number // When audio capture ended
  bytesSent: number // Total bytes sent in this window
}

export interface ResponseEvent {
  timestamp: number // When response was received
  textLength: number // Length of recognized text at this point
  isNew: boolean // Whether this contains new text
  type: ResponseType // Response category
}

export type ResponseType = 'asr' | 'translation' | 'other'

export interface LatencyStats {
  avgMs: number
  minMs: number
  maxMs: number
  p50Ms: number
  p95Ms: number
  count: number
}

class TranscriptionProfiler {
  private enabled = true
  private sessionStartTime: number | null = null

  // Time-window tracking
  private audioWindowStart: number | null = null
  private totalBytesSent = 0
  private totalResponsesReceived = 0
  private totalAsrResponses = 0
  private totalTranslationResponses = 0
  private totalOtherResponses = 0

  // Latency measurements (time between last audio sent and response received)
  private responseLatencies: number[] = []
  private firstAsrLatency: number | null = null
  private firstVisibleLatency: number | null = null

  // For detailed timeline
  private audioEvents: { timestamp: number; bytes: number }[] = []
  private responseEvents: ResponseEvent[] = []

  // Connection timing
  private connectionStartTime: number | null = null
  private connectionEstablishedTime: number | null = null
  private sessionBackend: string | null = null

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  startSession(backend?: string): void {
    this.sessionStartTime = performance.now()
    this.audioWindowStart = null
    this.totalBytesSent = 0
    this.totalResponsesReceived = 0
    this.totalAsrResponses = 0
    this.totalTranslationResponses = 0
    this.totalOtherResponses = 0
    this.responseLatencies = []
    this.firstAsrLatency = null
    this.firstVisibleLatency = null
    this.audioEvents = []
    this.responseEvents = []
    this.connectionStartTime = null
    this.connectionEstablishedTime = null
    this.sessionBackend = backend || null
    console.log('[Profiler] Session started')
  }

  endSession(): void {
    if (this.sessionStartTime) {
      const duration = performance.now() - this.sessionStartTime
      console.log(`[Profiler] Session ended after ${Math.round(duration)}ms`)
    }
    this.sessionStartTime = null
  }

  /**
   * Mark WebSocket connection start
   */
  markConnectionStart(): void {
    if (!this.enabled) return
    this.connectionStartTime = performance.now()
  }

  /**
   * Mark WebSocket connection established
   */
  markConnectionEstablished(): void {
    if (!this.enabled) return
    this.connectionEstablishedTime = performance.now()
  }

  /**
   * Record audio chunk being captured/sent
   */
  markAudioSent(bytes: number): void {
    if (!this.enabled) return

    const now = performance.now()

    // Track first audio of current "window"
    if (this.audioWindowStart === null) {
      this.audioWindowStart = now
    }

    this.totalBytesSent += bytes
    this.audioEvents.push({ timestamp: now, bytes })
  }

  /**
   * Record response received from server
   */
  markResponseReceived(
    textLength: number,
    previousTextLength: number,
    type: ResponseType = 'asr'
  ): void {
    if (!this.enabled) return

    const now = performance.now()
    const isNew = textLength > previousTextLength

    this.responseEvents.push({
      timestamp: now,
      textLength,
      isNew,
      type
    })

    if (type === 'asr') {
      this.totalAsrResponses++

      // Calculate latency from last audio to this ASR response with new text.
      if (this.audioWindowStart !== null && isNew) {
        const latency = now - this.audioWindowStart
        this.responseLatencies.push(latency)
        if (this.firstAsrLatency === null) {
          this.firstAsrLatency = latency
        }
        if (this.firstVisibleLatency === null) {
          this.firstVisibleLatency = latency
        }

        // Reset window for next measurement
        this.audioWindowStart = null
      }
    } else if (type === 'translation') {
      this.totalTranslationResponses++
      if (this.firstVisibleLatency === null && this.audioWindowStart !== null) {
        this.firstVisibleLatency = now - this.audioWindowStart
      }
    } else {
      this.totalOtherResponses++
    }

    this.totalResponsesReceived++
  }

  /**
   * Get connection latency
   */
  getConnectionLatency(): number | null {
    if (this.connectionStartTime && this.connectionEstablishedTime) {
      return Math.round(this.connectionEstablishedTime - this.connectionStartTime)
    }
    return null
  }

  /**
   * Calculate response latency statistics
   */
  getResponseLatencyStats(): LatencyStats | null {
    if (this.responseLatencies.length === 0) return null

    const sorted = [...this.responseLatencies].sort((a, b) => a - b)
    const sum = sorted.reduce((a, b) => a + b, 0)

    return {
      avgMs: Math.round(sum / sorted.length),
      minMs: Math.round(sorted[0]),
      maxMs: Math.round(sorted[sorted.length - 1]),
      p50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
      p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
      count: sorted.length
    }
  }

  /**
   * Calculate inter-response time (time between consecutive responses)
   */
  getInterResponseStats(type?: ResponseType): LatencyStats | null {
    const events = type
      ? this.responseEvents.filter((event) => event.type === type)
      : this.responseEvents
    if (events.length < 2) return null

    const intervals: number[] = []
    for (let i = 1; i < events.length; i++) {
      intervals.push(events[i].timestamp - events[i - 1].timestamp)
    }

    const sorted = intervals.sort((a, b) => a - b)
    const sum = sorted.reduce((a, b) => a + b, 0)

    return {
      avgMs: Math.round(sum / sorted.length),
      minMs: Math.round(sorted[0]),
      maxMs: Math.round(sorted[sorted.length - 1]),
      p50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
      p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
      count: sorted.length
    }
  }

  /**
   * Get audio throughput stats
   */
  getAudioStats(): { totalBytes: number; avgChunkSize: number; chunksPerSecond: number } | null {
    if (this.audioEvents.length === 0) return null

    const duration =
      (this.audioEvents[this.audioEvents.length - 1].timestamp - this.audioEvents[0].timestamp) /
      1000

    return {
      totalBytes: this.totalBytesSent,
      avgChunkSize: Math.round(this.totalBytesSent / this.audioEvents.length),
      chunksPerSecond: duration > 0 ? Math.round(this.audioEvents.length / duration) : 0
    }
  }

  /**
   * Print comprehensive report
   */
  printReport(): void {
    console.log('\n========== TRANSCRIPTION LATENCY REPORT ==========\n')
    if (this.sessionBackend) {
      console.log(`[*] Backend: ${this.sessionBackend}`)
    }

    // Startup timing
    const connLatency = this.getConnectionLatency()
    if (connLatency !== null) {
      console.log(`[*] Session Startup Latency: ${connLatency}ms`)
    }
    if (this.firstVisibleLatency !== null) {
      console.log(`[*] First Visible Text Latency: ${Math.round(this.firstVisibleLatency)}ms`)
    }

    // Audio stats
    const audioStats = this.getAudioStats()
    if (audioStats) {
      console.log(`\n[Audio Stats]`)
      console.log(`   Total sent: ${(audioStats.totalBytes / 1024).toFixed(1)} KB`)
      console.log(`   Avg chunk: ${audioStats.avgChunkSize} bytes`)
      console.log(`   Rate: ${audioStats.chunksPerSecond} chunks/sec`)
    }

    // Response latency (time from audio capture to recognition result)
    const respLatency = this.getResponseLatencyStats()
    if (respLatency) {
      console.log(`\n[Audio -> Recognition Latency]`)
      console.log(`   Avg: ${respLatency.avgMs}ms`)
      console.log(`   P50: ${respLatency.p50Ms}ms`)
      console.log(`   P95: ${respLatency.p95Ms}ms`)
      console.log(`   Min: ${respLatency.minMs}ms | Max: ${respLatency.maxMs}ms`)
      console.log(`   Samples: ${respLatency.count}`)
    }

    // Inter-response cadence for ASR results only.
    const interResp = this.getInterResponseStats('asr')
    if (interResp) {
      console.log(`\n[Time Between ASR Responses]`)
      console.log(`   Avg: ${interResp.avgMs}ms`)
      console.log(`   P50: ${interResp.p50Ms}ms`)
      console.log(`   P95: ${interResp.p95Ms}ms`)
    }

    // Summary
    const asrNewResponses = this.responseEvents.filter(
      (event) => event.type === 'asr' && event.isNew
    ).length
    console.log(`\n[Summary]`)
    console.log(`   Audio chunks sent: ${this.audioEvents.length}`)
    console.log(`   Responses received: ${this.totalResponsesReceived}`)
    console.log(`   ASR responses: ${this.totalAsrResponses} (new text: ${asrNewResponses})`)
    console.log(`   Translation updates: ${this.totalTranslationResponses}`)
    if (this.totalOtherResponses > 0) {
      console.log(`   Other updates: ${this.totalOtherResponses}`)
    }
    if (this.firstAsrLatency !== null) {
      console.log(`   First ASR latency: ${Math.round(this.firstAsrLatency)}ms`)
    }
    if (asrNewResponses > 0) {
      console.log(
        `   Avg chunks per ASR update: ${(this.audioEvents.length / asrNewResponses).toFixed(2)}`
      )
    }

    console.log('\n====================================================\n')
  }

  clear(): void {
    this.audioEvents = []
    this.responseEvents = []
    this.responseLatencies = []
  }
}

export const profiler = new TranscriptionProfiler()
