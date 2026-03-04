export interface MeetingTranslationRateControlConfig {
  enabled: boolean
  maxRequestsPerMinute: number
  maxTokensPerMinute: number
  minRequestIntervalMs: number
  maxQueueSize: number
  maxQueueWaitMs: number
  dropPolicy: 'drop_oldest' | 'drop_newest'
}

export interface MeetingTranslationRateLimiterSnapshot {
  queueLength: number
  maxQueueLength: number
  totalEnqueued: number
  totalExecuted: number
  totalDroppedOverflow: number
  totalDroppedTimeout: number
  totalWaitEvents: number
  totalWaitMs: number
  intervalWaitEvents: number
  intervalWaitMs: number
  rpmWaitEvents: number
  rpmWaitMs: number
  tpmWaitEvents: number
  tpmWaitMs: number
  totalEstimatedTokens: number
}

export class MeetingTranslationRateLimitError extends Error {
  readonly code: 'queue_overflow' | 'queue_timeout'

  constructor(code: 'queue_overflow' | 'queue_timeout', message: string) {
    super(message)
    this.name = 'MeetingTranslationRateLimitError'
    this.code = code
  }
}

interface QueueItem<T> {
  enqueuedAt: number
  estimatedTokens: number
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

interface WaitSignal {
  totalWaitMs: number
  intervalWaitMs: number
  rpmWaitMs: number
  tpmWaitMs: number
}

/**
 * Shared queue for meeting translation requests.
 * Keeps ASR and translation loosely coupled under provider TPM/RPM limits.
 */
export class MeetingTranslationRateLimiter {
  private config: MeetingTranslationRateControlConfig
  private queue: QueueItem<unknown>[] = []
  private running = false
  private pumpTimer: NodeJS.Timeout | null = null
  private lastRequestAt = 0
  private requestTimestamps: number[] = []
  private tokenUsageEvents: Array<{ at: number; tokens: number }> = []

  // Telemetry counters for M7 observability.
  private maxQueueLength = 0
  private totalEnqueued = 0
  private totalExecuted = 0
  private totalDroppedOverflow = 0
  private totalDroppedTimeout = 0
  private totalWaitEvents = 0
  private totalWaitMs = 0
  private intervalWaitEvents = 0
  private intervalWaitMs = 0
  private rpmWaitEvents = 0
  private rpmWaitMs = 0
  private tpmWaitEvents = 0
  private tpmWaitMs = 0
  private totalEstimatedTokens = 0

  constructor(config: MeetingTranslationRateControlConfig) {
    this.config = { ...config }
  }

  updateConfig(config: MeetingTranslationRateControlConfig): void {
    this.config = { ...config }
  }

  getSnapshot(): MeetingTranslationRateLimiterSnapshot {
    return {
      queueLength: this.queue.length,
      maxQueueLength: this.maxQueueLength,
      totalEnqueued: this.totalEnqueued,
      totalExecuted: this.totalExecuted,
      totalDroppedOverflow: this.totalDroppedOverflow,
      totalDroppedTimeout: this.totalDroppedTimeout,
      totalWaitEvents: this.totalWaitEvents,
      totalWaitMs: this.totalWaitMs,
      intervalWaitEvents: this.intervalWaitEvents,
      intervalWaitMs: this.intervalWaitMs,
      rpmWaitEvents: this.rpmWaitEvents,
      rpmWaitMs: this.rpmWaitMs,
      tpmWaitEvents: this.tpmWaitEvents,
      tpmWaitMs: this.tpmWaitMs,
      totalEstimatedTokens: this.totalEstimatedTokens
    }
  }

  getSnapshotAndReset(): MeetingTranslationRateLimiterSnapshot {
    const snapshot = this.getSnapshot()
    this.resetStats()
    return snapshot
  }

  async enqueue<T>(estimatedTokens: number, task: () => Promise<T>): Promise<T> {
    const normalizedTokens = this.normalizeEstimatedTokens(estimatedTokens)

    return new Promise<T>((resolve, reject) => {
      this.totalEnqueued += 1

      if (this.queue.length >= this.config.maxQueueSize) {
        this.totalDroppedOverflow += 1
        if (this.config.dropPolicy === 'drop_newest') {
          reject(
            new MeetingTranslationRateLimitError(
              'queue_overflow',
              'Meeting translation queue overflow: dropped newest request'
            )
          )
          return
        }

        const dropped = this.queue.shift()
        dropped?.reject(
          new MeetingTranslationRateLimitError(
            'queue_overflow',
            'Meeting translation queue overflow: dropped oldest request'
          )
        )
      }

      this.queue.push({
        enqueuedAt: Date.now(),
        estimatedTokens: normalizedTokens,
        task: async () => task(),
        resolve: (value: unknown) => resolve(value as T),
        reject
      })
      this.maxQueueLength = Math.max(this.maxQueueLength, this.queue.length)
      this.schedulePump(0)
    })
  }

  private schedulePump(delayMs: number): void {
    if (this.running) {
      return
    }
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = null
    }
    this.pumpTimer = setTimeout(
      () => {
        this.pumpTimer = null
        void this.pump()
      },
      Math.max(0, Math.floor(delayMs))
    )
  }

  private async pump(): Promise<void> {
    if (this.running || this.queue.length === 0) {
      return
    }

    const now = Date.now()
    this.pruneWindow(now)

    const head = this.queue[0]
    if (!head) {
      return
    }

    if (now - head.enqueuedAt > this.config.maxQueueWaitMs) {
      this.queue.shift()
      this.totalDroppedTimeout += 1
      head.reject(
        new MeetingTranslationRateLimitError(
          'queue_timeout',
          `Meeting translation queued longer than ${this.config.maxQueueWaitMs}ms`
        )
      )
      this.schedulePump(0)
      return
    }

    const waitSignal = this.computeWaitSignal(now, head.estimatedTokens)
    if (waitSignal.totalWaitMs > 0) {
      this.recordWaitSignal(waitSignal)
      this.schedulePump(waitSignal.totalWaitMs)
      return
    }

    this.queue.shift()
    this.running = true
    this.recordQuotaUsage(Date.now(), head.estimatedTokens)

    try {
      const result = await head.task()
      head.resolve(result)
    } catch (error) {
      head.reject(error)
    } finally {
      this.running = false
      this.schedulePump(0)
    }
  }

  private computeWaitSignal(now: number, estimatedTokens: number): WaitSignal {
    let intervalWaitMs = 0
    let rpmWaitMs = 0
    let tpmWaitMs = 0

    if (this.config.minRequestIntervalMs > 0 && this.lastRequestAt > 0) {
      intervalWaitMs = Math.max(0, this.lastRequestAt + this.config.minRequestIntervalMs - now)
    }

    if (this.requestTimestamps.length >= this.config.maxRequestsPerMinute) {
      const oldestRequestAt = this.requestTimestamps[0]
      rpmWaitMs = Math.max(0, oldestRequestAt + 60_000 - now)
    }

    const limitedEstimate = Math.min(estimatedTokens, this.config.maxTokensPerMinute)
    let tokenSum = 0
    for (const entry of this.tokenUsageEvents) {
      tokenSum += entry.tokens
    }

    if (tokenSum + limitedEstimate > this.config.maxTokensPerMinute) {
      let releasable = tokenSum
      for (const entry of this.tokenUsageEvents) {
        releasable -= entry.tokens
        if (releasable + limitedEstimate <= this.config.maxTokensPerMinute) {
          tpmWaitMs = Math.max(0, entry.at + 60_000 - now)
          break
        }
      }
    }

    return {
      totalWaitMs: Math.max(intervalWaitMs, rpmWaitMs, tpmWaitMs),
      intervalWaitMs,
      rpmWaitMs,
      tpmWaitMs
    }
  }

  private pruneWindow(now: number): void {
    const windowStart = now - 60_000
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] <= windowStart) {
      this.requestTimestamps.shift()
    }
    while (this.tokenUsageEvents.length > 0 && this.tokenUsageEvents[0].at <= windowStart) {
      this.tokenUsageEvents.shift()
    }
  }

  private recordQuotaUsage(at: number, estimatedTokens: number): void {
    this.lastRequestAt = at
    this.requestTimestamps.push(at)
    this.totalExecuted += 1
    this.totalEstimatedTokens += estimatedTokens
    this.tokenUsageEvents.push({
      at,
      tokens: Math.min(estimatedTokens, this.config.maxTokensPerMinute)
    })
  }

  private recordWaitSignal(signal: WaitSignal): void {
    if (signal.totalWaitMs <= 0) {
      return
    }
    this.totalWaitEvents += 1
    this.totalWaitMs += signal.totalWaitMs

    if (signal.intervalWaitMs > 0) {
      this.intervalWaitEvents += 1
      this.intervalWaitMs += signal.intervalWaitMs
    }
    if (signal.rpmWaitMs > 0) {
      this.rpmWaitEvents += 1
      this.rpmWaitMs += signal.rpmWaitMs
    }
    if (signal.tpmWaitMs > 0) {
      this.tpmWaitEvents += 1
      this.tpmWaitMs += signal.tpmWaitMs
    }
  }

  private normalizeEstimatedTokens(estimatedTokens: number): number {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
      return 1
    }
    return Math.max(1, Math.floor(estimatedTokens))
  }

  private resetStats(): void {
    this.maxQueueLength = this.queue.length
    this.totalEnqueued = 0
    this.totalExecuted = 0
    this.totalDroppedOverflow = 0
    this.totalDroppedTimeout = 0
    this.totalWaitEvents = 0
    this.totalWaitMs = 0
    this.intervalWaitEvents = 0
    this.intervalWaitMs = 0
    this.rpmWaitEvents = 0
    this.rpmWaitMs = 0
    this.tpmWaitEvents = 0
    this.tpmWaitMs = 0
    this.totalEstimatedTokens = 0
  }
}
