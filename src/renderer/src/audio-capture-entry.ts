/**
 * Entry point for the hidden audio capture window.
 * Handles push-to-talk streaming and non-streaming audio capture via IPC.
 */

// PTT Streaming mode state
let pttMediaStream: MediaStream | null = null
let pttAudioContext: AudioContext | null = null
let pttScriptProcessor: ScriptProcessorNode | null = null
let pttSourceNode: MediaStreamAudioSourceNode | null = null

// Non-streaming recording mode state
let recordingMediaStream: MediaStream | null = null
let recordingAudioContext: AudioContext | null = null
let recordingScriptProcessor: ScriptProcessorNode | null = null
let recordingSourceNode: MediaStreamAudioSourceNode | null = null

// Helper to convert float32 audio to int16 PCM
function floatTo16BitPCM(input: Float32Array): Int16Array {
  const int16Data = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16Data
}

// ============ PTT Streaming Mode ============

async function startPttCapture(): Promise<void> {
  try {
    console.log('[AudioCapture] Starting PTT capture')

    pttMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    })

    const audioTracks = pttMediaStream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('No microphone available')
    }

    console.log('[AudioCapture] Got audio track:', audioTracks[0].label)

    pttAudioContext = new AudioContext({ sampleRate: 16000 })
    pttSourceNode = pttAudioContext.createMediaStreamSource(pttMediaStream)

    pttScriptProcessor = pttAudioContext.createScriptProcessor(4096, 1, 1)

    pttScriptProcessor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0)
      const int16Data = floatTo16BitPCM(inputData)
      window.api.sendPttAudioChunk(int16Data.buffer as ArrayBuffer)
    }

    pttSourceNode.connect(pttScriptProcessor)
    pttScriptProcessor.connect(pttAudioContext.destination)

    window.api.notifyPttStarted()
    console.log('[AudioCapture] PTT capture started')
  } catch (error) {
    console.error('[AudioCapture] Failed to start PTT:', error)
    window.api.notifyPttError(error instanceof Error ? error.message : String(error))
  }
}

function stopPttCapture(): void {
  if (pttScriptProcessor) {
    pttScriptProcessor.disconnect()
    pttScriptProcessor = null
  }

  if (pttSourceNode) {
    pttSourceNode.disconnect()
    pttSourceNode = null
  }

  if (pttAudioContext) {
    pttAudioContext.close()
    pttAudioContext = null
  }

  if (pttMediaStream) {
    pttMediaStream.getTracks().forEach((track) => track.stop())
    pttMediaStream = null
  }

  window.api.notifyPttStopped()
  console.log('[AudioCapture] PTT capture stopped')
}

// ============ Non-Streaming Recording Mode ============

async function startRecording(): Promise<void> {
  try {
    console.log('[AudioCapture] Starting recording')

    recordingMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    })

    const audioTracks = recordingMediaStream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('No microphone available')
    }

    console.log('[AudioCapture] Got audio track for recording:', audioTracks[0].label)

    recordingAudioContext = new AudioContext({ sampleRate: 16000 })
    recordingSourceNode = recordingAudioContext.createMediaStreamSource(recordingMediaStream)

    recordingScriptProcessor = recordingAudioContext.createScriptProcessor(4096, 1, 1)

    recordingScriptProcessor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0)
      const int16Data = floatTo16BitPCM(inputData)
      window.api.sendRecordingAudioChunk(int16Data.buffer as ArrayBuffer)
    }

    recordingSourceNode.connect(recordingScriptProcessor)
    recordingScriptProcessor.connect(recordingAudioContext.destination)

    window.api.notifyRecordingStarted()
    console.log('[AudioCapture] Recording started')
  } catch (error) {
    console.error('[AudioCapture] Failed to start recording:', error)
    window.api.notifyRecordingError(error instanceof Error ? error.message : String(error))
  }
}

function stopRecording(): void {
  if (recordingScriptProcessor) {
    recordingScriptProcessor.disconnect()
    recordingScriptProcessor = null
  }

  if (recordingSourceNode) {
    recordingSourceNode.disconnect()
    recordingSourceNode = null
  }

  if (recordingAudioContext) {
    recordingAudioContext.close()
    recordingAudioContext = null
  }

  if (recordingMediaStream) {
    recordingMediaStream.getTracks().forEach((track) => track.stop())
    recordingMediaStream = null
  }

  window.api.notifyRecordingStopped()
  console.log('[AudioCapture] Recording stopped')
}

// ============ IPC Listeners ============

// PTT streaming mode
window.api.onStartPttCapture(() => {
  startPttCapture()
})

window.api.onStopPttCapture(() => {
  stopPttCapture()
})

// Non-streaming recording mode
window.api.onStartRecording(() => {
  startRecording()
})

window.api.onStopRecording(() => {
  stopRecording()
})

console.log('[AudioCapture] Hidden window ready')
