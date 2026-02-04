/**
 * Lightweight VAD (Voice Activity Detection) utilities
 * Based on RMS energy detection for real-time audio processing
 */

/**
 * Calculate RMS (Root Mean Square) energy of 16-bit PCM audio
 * @param pcmBuffer 16-bit signed little-endian PCM audio data
 * @returns Normalized RMS value (0-1 range)
 */
export function calculateRMS(pcmBuffer: Buffer): number {
  if (pcmBuffer.length < 2) return 0

  const samples = pcmBuffer.length / 2 // 16-bit = 2 bytes per sample
  let sumOfSquares = 0

  for (let i = 0; i < pcmBuffer.length; i += 2) {
    // Read 16-bit signed little-endian sample
    const sample = pcmBuffer.readInt16LE(i)
    // Normalize to -1 to 1 range
    const normalized = sample / 32768
    sumOfSquares += normalized * normalized
  }

  return Math.sqrt(sumOfSquares / samples)
}

/**
 * VAD state machine with debounce logic
 * Tracks consecutive silent/speech chunks to avoid false triggers
 */
export class VADState {
  private consecutiveSilentChunks = 0
  private readonly silenceThreshold: number
  private readonly debounceChunks: number

  /**
   * @param silenceThreshold RMS threshold below which audio is considered silent (default 0.01)
   * @param debounceChunks Number of consecutive silent chunks required to confirm silence (default 3)
   */
  constructor(silenceThreshold = 0.01, debounceChunks = 3) {
    this.silenceThreshold = silenceThreshold
    this.debounceChunks = debounceChunks
  }

  /**
   * Process an audio chunk and determine if it contains speech
   * @returns true if speech detected, false if silent
   */
  processChunk(chunk: Buffer): boolean {
    const rms = calculateRMS(chunk)
    if (rms >= this.silenceThreshold) {
      this.consecutiveSilentChunks = 0
      return true // Speech detected
    } else {
      this.consecutiveSilentChunks++
      return false // Silent
    }
  }

  /**
   * Check if currently in confirmed silence state (after debounce)
   */
  isInSilence(): boolean {
    return this.consecutiveSilentChunks >= this.debounceChunks
  }

  /**
   * Get the count of consecutive silent chunks
   */
  getSilentChunkCount(): number {
    return this.consecutiveSilentChunks
  }

  /**
   * Reset VAD state
   */
  reset(): void {
    this.consecutiveSilentChunks = 0
  }
}
