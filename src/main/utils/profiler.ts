/**
 * Profiler for measuring real user-perceived latency in meeting transcription.
 * Uses time-window based approach since Soniox returns batched responses.
 */

export interface AudioWindow {
  startTime: number    // When audio capture started for this window
  endTime: number      // When audio capture ended
  bytesSent: number    // Total bytes sent in this window
}

export interface ResponseEvent {
  timestamp: number    // When response was received
  textLength: number   // Length of recognized text at this point
  isNew: boolean       // Whether this contains new text
}

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
  
  // Latency measurements (time between last audio sent and response received)
  private responseLatencies: number[] = []
  
  // For detailed timeline
  private audioEvents: { timestamp: number; bytes: number }[] = []
  private responseEvents: ResponseEvent[] = []
  
  // Connection timing
  private connectionStartTime: number | null = null
  private connectionEstablishedTime: number | null = null

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  startSession(): void {
    this.sessionStartTime = performance.now()
    this.audioWindowStart = null
    this.totalBytesSent = 0
    this.totalResponsesReceived = 0
    this.responseLatencies = []
    this.audioEvents = []
    this.responseEvents = []
    this.connectionStartTime = null
    this.connectionEstablishedTime = null
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
  markResponseReceived(textLength: number, previousTextLength: number): void {
    if (!this.enabled) return
    
    const now = performance.now()
    const isNew = textLength > previousTextLength
    
    this.responseEvents.push({
      timestamp: now,
      textLength,
      isNew
    })
    
    // Calculate latency from last audio to this response
    if (this.audioWindowStart !== null && isNew) {
      const latency = now - this.audioWindowStart
      this.responseLatencies.push(latency)
      
      // Reset window for next measurement
      this.audioWindowStart = null
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
  getInterResponseStats(): LatencyStats | null {
    if (this.responseEvents.length < 2) return null
    
    const intervals: number[] = []
    for (let i = 1; i < this.responseEvents.length; i++) {
      intervals.push(this.responseEvents[i].timestamp - this.responseEvents[i - 1].timestamp)
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
    
    const duration = (this.audioEvents[this.audioEvents.length - 1].timestamp - 
                     this.audioEvents[0].timestamp) / 1000
    
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

    // Connection
    const connLatency = this.getConnectionLatency()
    if (connLatency !== null) {
      console.log(`🔌 Connection Latency: ${connLatency}ms`)
    }

    // Audio stats
    const audioStats = this.getAudioStats()
    if (audioStats) {
      console.log(`\n📊 Audio Stats:`)
      console.log(`   Total sent: ${(audioStats.totalBytes / 1024).toFixed(1)} KB`)
      console.log(`   Avg chunk: ${audioStats.avgChunkSize} bytes`)
      console.log(`   Rate: ${audioStats.chunksPerSecond} chunks/sec`)
    }

    // Response latency (time from audio capture to recognition result)
    const respLatency = this.getResponseLatencyStats()
    if (respLatency) {
      console.log(`\n⏱️  Audio → Recognition Latency:`)
      console.log(`   Avg: ${respLatency.avgMs}ms`)
      console.log(`   P50: ${respLatency.p50Ms}ms`)
      console.log(`   P95: ${respLatency.p95Ms}ms`)
      console.log(`   Min: ${respLatency.minMs}ms | Max: ${respLatency.maxMs}ms`)
      console.log(`   Samples: ${respLatency.count}`)
    }

    // Inter-response time
    const interResp = this.getInterResponseStats()
    if (interResp) {
      console.log(`\n🔄 Time Between Responses:`)
      console.log(`   Avg: ${interResp.avgMs}ms`)
      console.log(`   P50: ${interResp.p50Ms}ms`)
      console.log(`   P95: ${interResp.p95Ms}ms`)
    }

    // Summary
    console.log(`\n📈 Summary:`)
    console.log(`   Audio chunks sent: ${this.audioEvents.length}`)
    console.log(`   Responses received: ${this.totalResponsesReceived}`)
    console.log(`   Response ratio: ${(this.totalResponsesReceived / this.audioEvents.length * 100).toFixed(1)}%`)

    console.log('\n====================================================\n')
  }

  clear(): void {
    this.audioEvents = []
    this.responseEvents = []
    this.responseLatencies = []
  }
}

export const profiler = new TranscriptionProfiler()
