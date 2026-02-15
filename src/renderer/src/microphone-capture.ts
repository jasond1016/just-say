/**
 * Microphone capture using Web Audio API.
 * This runs in the renderer process and captures microphone audio without requiring ffmpeg.
 */

let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let scriptProcessor: ScriptProcessorNode | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null

const DEFAULT_SAMPLE_RATE = 16000

interface AudioSettings {
  deviceId?: string
  sampleRate: number
}

async function loadAudioSettings(): Promise<AudioSettings> {
  try {
    const config = (await window.api.getConfig()) as {
      audio?: { device?: string; sampleRate?: number }
    }
    const device = config?.audio?.device
    const sampleRate = config?.audio?.sampleRate
    return {
      deviceId: device && device !== 'default' ? device : undefined,
      sampleRate:
        typeof sampleRate === 'number' && Number.isFinite(sampleRate)
          ? sampleRate
          : DEFAULT_SAMPLE_RATE
    }
  } catch (error) {
    console.warn('[MicrophoneCapture] Failed to read audio config:', error)
    return { sampleRate: DEFAULT_SAMPLE_RATE }
  }
}

/**
 * Get available microphone devices
 */
export async function getMicrophoneDevices(): Promise<
  Array<{ id: string; name: string; isDefault?: boolean }>
> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const audioInputs = devices.filter((d) => d.kind === 'audioinput')

  return audioInputs.map((device, index) => ({
    id: device.deviceId,
    name: device.label || `Microphone ${index + 1}`,
    isDefault: device.deviceId === 'default' || index === 0
  }))
}

/**
 * Start capturing microphone audio.
 * Audio data is sent to main process via IPC.
 */
export async function startMicrophoneCapture(
  deviceId?: string,
  sampleRate?: number
): Promise<void> {
  try {
    const settings = await loadAudioSettings()
    const resolvedDeviceId =
      deviceId !== undefined ? (deviceId !== 'default' ? deviceId : undefined) : settings.deviceId
    const resolvedSampleRate =
      typeof sampleRate === 'number' && Number.isFinite(sampleRate)
        ? sampleRate
        : settings.sampleRate

    console.log(
      '[MicrophoneCapture] Requesting microphone access, deviceId:',
      resolvedDeviceId,
      'sampleRate:',
      resolvedSampleRate
    )

    const constraints: MediaStreamConstraints = {
      audio: resolvedDeviceId ? { deviceId: { exact: resolvedDeviceId } } : true,
      video: false
    }

    mediaStream = await navigator.mediaDevices.getUserMedia(constraints)

    const audioTracks = mediaStream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('No microphone available')
    }

    console.log('[MicrophoneCapture] Got audio track:', audioTracks[0].label)

    // Create audio context using configured sample rate
    audioContext = new AudioContext({ sampleRate: resolvedSampleRate })
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
      window.api.sendMicrophoneAudioChunk(int16Data.buffer)
    }

    sourceNode.connect(scriptProcessor)
    scriptProcessor.connect(audioContext.destination)

    // Notify main process that microphone capture started
    window.api.notifyMicrophoneStarted()

    console.log('[MicrophoneCapture] Started capturing microphone audio')
  } catch (error) {
    console.error('[MicrophoneCapture] Failed to start:', error)
    window.api.notifyMicrophoneError(error instanceof Error ? error.message : String(error))
    throw error
  }
}

/**
 * Stop capturing microphone audio
 */
export function stopMicrophoneCapture(): void {
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

  // Notify main process that microphone capture stopped
  window.api.notifyMicrophoneStopped()

  console.log('[MicrophoneCapture] Stopped')
}

/**
 * Check if currently capturing
 */
export function isMicrophoneCapturing(): boolean {
  return mediaStream !== null && audioContext !== null
}
