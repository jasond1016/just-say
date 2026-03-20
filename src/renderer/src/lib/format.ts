/**
 * Format total seconds as M:SS (e.g. 0:00, 1:05, 12:30).
 * Shared across meeting timer, status bar, and indicator.
 */
export function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
