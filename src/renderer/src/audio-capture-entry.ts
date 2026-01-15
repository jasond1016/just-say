/**
 * Entry point for the hidden audio capture window.
 * Handles push-to-talk audio capture via IPC.
 */

let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let scriptProcessor: ScriptProcessorNode | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null

async function startCapture(): Promise<void> {
  try {
    console.log('[AudioCapture] Starting capture')

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    })

    const audioTracks = mediaStream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('No microphone available')
    }

    console.log('[AudioCapture] Got audio track:', audioTracks[0].label)

    audioContext = new AudioContext({ sampleRate: 16000 })
    sourceNode = audioContext.createMediaStreamSource(mediaStream)

    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1)

    scriptProcessor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0)
      const int16Data = new Int16Array(inputData.length)
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]))
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      window.api.sendPttAudioChunk(int16Data.buffer)
    }

    sourceNode.connect(scriptProcessor)
    scriptProcessor.connect(audioContext.destination)

    window.api.notifyPttStarted()
    console.log('[AudioCapture] Capture started')
  } catch (error) {
    console.error('[AudioCapture] Failed to start:', error)
    window.api.notifyPttError(error instanceof Error ? error.message : String(error))
  }
}

function stopCapture(): void {
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

  window.api.notifyPttStopped()
  console.log('[AudioCapture] Capture stopped')
}

window.api.onStartPttCapture(() => {
  startCapture()
})

window.api.onStopPttCapture(() => {
  stopCapture()
})

console.log('[AudioCapture] Hidden window ready')
