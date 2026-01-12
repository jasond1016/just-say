/**
 * System audio capture using Electron's desktopCapturer API.
 * This runs in the renderer process and captures system audio without requiring ffmpeg.
 */

let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let scriptProcessor: ScriptProcessorNode | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null

/**
 * Get available system audio sources using desktopCapturer
 */
export async function getSystemAudioSources(): Promise<
  Array<{ id: string; name: string; isDefault?: boolean }>
> {
  const sources = await window.desktopCapturer.getSources({
    types: ['screen'],
    fetchWindowIcons: false
  })

  return sources.map((source, index) => ({
    id: source.id,
    name: source.name || `Screen ${index + 1}`,
    isDefault: index === 0
  }))
}

/**
 * Start capturing system audio from a screen source.
 * Audio data is sent to main process via IPC.
 */
export async function startSystemAudioCapture(sourceId: string | null): Promise<void> {
  try {
    // If no source specified, get the first screen
    let targetSourceId = sourceId
    if (!targetSourceId) {
      const sources = await getSystemAudioSources()
      if (sources.length === 0) {
        throw new Error('No screen sources available for audio capture')
      }
      targetSourceId = sources[0].id
    }

    console.log('[SystemAudioCapture] Requesting audio for source:', targetSourceId)

    // Request system audio using getUserMedia with chromeMediaSource
    // Note: We need video track to get system audio in Electron, but we'll stop it after getting audio
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // @ts-expect-error - Electron-specific constraints
        mandatory: {
          chromeMediaSource: 'desktop'
        }
      },
      video: {
        // @ts-expect-error - Electron-specific constraints
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: targetSourceId,
          minWidth: 320,
          maxWidth: 320,
          minHeight: 240,
          maxHeight: 240,
          maxFrameRate: 5
        }
      }
    })

    // Stop video track immediately - we only need audio
    mediaStream.getVideoTracks().forEach((track) => track.stop())

    const audioTracks = mediaStream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('No audio track available. System audio capture may not be supported.')
    }

    console.log('[SystemAudioCapture] Got audio track:', audioTracks[0].label)

    // Create audio context at 16kHz for speech recognition
    audioContext = new AudioContext({ sampleRate: 16000 })
    sourceNode = audioContext.createMediaStreamSource(mediaStream)

    // Use ScriptProcessorNode (deprecated but reliable across all Electron versions)
    // Buffer size 4096 at 16kHz = 256ms chunks
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1)

    scriptProcessor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0)
      // Convert Float32 to Int16 PCM
      const int16Data = new Int16Array(inputData.length)
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]))
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      // Send audio chunk to main process
      window.api.sendSystemAudioChunk(int16Data.buffer)
    }

    sourceNode.connect(scriptProcessor)
    scriptProcessor.connect(audioContext.destination)

    // Notify main process that audio capture started
    window.api.notifySystemAudioStarted()

    console.log('[SystemAudioCapture] Started capturing system audio')
  } catch (error) {
    console.error('[SystemAudioCapture] Failed to start:', error)
    window.api.notifySystemAudioError(error instanceof Error ? error.message : String(error))
    throw error
  }
}

/**
 * Stop capturing system audio
 */
export function stopSystemAudioCapture(): void {
  if (scriptProcessor) {
    scriptProcessor.disconnect()
    scriptProcessor = null
  }

  if (sourceNode) {
    sourceNode.disconnect()
    sourceNode = null
  }

  if (audioContext) {
    audioContext.close()
    audioContext = null
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }

  // Notify main process that audio capture stopped
  window.api.notifySystemAudioStopped()

  console.log('[SystemAudioCapture] Stopped')
}

/**
 * Check if currently capturing
 */
export function isCapturing(): boolean {
  return mediaStream !== null && audioContext !== null
}
