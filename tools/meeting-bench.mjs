#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import fs from 'fs/promises'
import http from 'http'
import https from 'https'
import path from 'path'
import { performance } from 'perf_hooks'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const DEFAULTS = {
  wsUrl: 'ws://127.0.0.1:8766/stream',
  httpUrl: 'http://127.0.0.1:8765',
  runs: 5,
  chunkMs: 256,
  speed: 1,
  flushWaitMs: 900,
  closeTimeoutMs: 15000
}

function printUsage() {
  console.log(`
Usage:
  pnpm meeting:bench -- --audio <wav> --ref <ref.json> [options]

Required:
  --audio <path>            输入 WAV 文件路径（16-bit PCM）
  --ref <path>              参考文本 JSON 路径

Options:
  --ws-url <url>            WS 地址（default: ${DEFAULTS.wsUrl}）
  --http-url <url>          HTTP 地址，用于整段 full-context baseline（default: ${DEFAULTS.httpUrl}）
  --runs <n>                重复运行次数（default: ${DEFAULTS.runs}）
  --skip-full-context       跳过整段一次性识别 baseline
  --chunk-ms <n>            音频分片毫秒（default: ${DEFAULTS.chunkMs}）
  --speed <n>               回放速度（1=实时，2=2x，default: ${DEFAULTS.speed}）
  --flush-wait-ms <n>       发送 flush 后等待毫秒（default: ${DEFAULTS.flushWaitMs}）
  --close-timeout-ms <n>    会话关闭超时毫秒（default: ${DEFAULTS.closeTimeoutMs}）
  --out-dir <path>          输出目录（默认 out/meeting-bench/<case>-<timestamp>）
  --text-corrections-file <path>
                            纠偏词表 JSON 文件（会编码到 text_corrections query）

WS Query（会覆盖 ref.json 的 wsParams）:
  --engine <value>
  --model <value>
  --sensevoice-model-id <value>
  --sensevoice-use-itn <true|false>
  --sensevoice-vad-model <value>
  --sensevoice-vad-merge <true|false>
  --sensevoice-vad-merge-length-s <n>
  --sensevoice-vad-max-single-segment-time-ms <n>
  --device <value>
  --compute-type <value>
  --language <value>
  --sample-rate <n>
  --return-word-timestamps <true|false>
  --preview-interval-ms <n>
  --preview-min-audio-ms <n>
  --preview-min-new-audio-ms <n>
  --preview-window-ms <n>
  --min-chunk-ms <n>
  --silence-ms <n>
  --max-chunk-ms <n>
  --overlap-ms <n>
`)
}

function parseArgs(argv) {
  const args = {
    queryParams: {}
  }

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) {
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      args[key.slice(2)] = true
      continue
    }
    args[key.slice(2)] = value
    i += 1
  }

  const queryArgToParam = {
    engine: 'engine',
    model: 'model',
    'sensevoice-model-id': 'sensevoice_model_id',
    'sensevoice-use-itn': 'sensevoice_use_itn',
    'sensevoice-vad-model': 'sensevoice_vad_model',
    'sensevoice-vad-merge': 'sensevoice_vad_merge',
    'sensevoice-vad-merge-length-s': 'sensevoice_vad_merge_length_s',
    'sensevoice-vad-max-single-segment-time-ms': 'sensevoice_vad_max_single_segment_time_ms',
    device: 'device',
    'compute-type': 'compute_type',
    language: 'language',
    'sample-rate': 'sample_rate',
    'return-word-timestamps': 'return_word_timestamps',
    'preview-interval-ms': 'preview_interval_ms',
    'preview-min-audio-ms': 'preview_min_audio_ms',
    'preview-min-new-audio-ms': 'preview_min_new_audio_ms',
    'preview-window-ms': 'preview_window_ms',
    'min-chunk-ms': 'min_chunk_ms',
    'silence-ms': 'silence_ms',
    'max-chunk-ms': 'max_chunk_ms',
    'overlap-ms': 'overlap_ms'
  }
  for (const [argKey, paramKey] of Object.entries(queryArgToParam)) {
    if (args[argKey] !== undefined) {
      args.queryParams[paramKey] = args[argKey]
    }
  }

  return args
}

function resolveNumber(value, fallback, minValue = 1) {
  const num = Number(value)
  if (!Number.isFinite(num) || num < minValue) {
    return fallback
  }
  return Math.floor(num)
}

function resolveFloat(value, fallback, minValue = 0.0001) {
  const num = Number(value)
  if (!Number.isFinite(num) || num < minValue) {
    return fallback
  }
  return num
}

function normalizeBoolString(value) {
  if (typeof value !== 'string') return value
  const lower = value.trim().toLowerCase()
  if (lower === 'true' || lower === '1' || lower === 'yes') return 'true'
  if (lower === 'false' || lower === '0' || lower === 'no') return 'false'
  return value
}

function applyNormalizationReplacements(text, replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    return text
  }

  let value = text
  for (const rule of replacements) {
    if (!rule || typeof rule.from !== 'string' || rule.from.length === 0) {
      continue
    }

    const replacement = typeof rule.to === 'string' ? rule.to : ''
    if (rule.regex === true) {
      const flags = typeof rule.flags === 'string' && rule.flags ? rule.flags : 'gu'
      try {
        value = value.replace(new RegExp(rule.from, flags), replacement)
      } catch {
        // Ignore invalid replacement rules so one bad case config does not break bench.
      }
      continue
    }

    value = value.split(rule.from).join(replacement)
  }

  return value
}

async function loadJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(raw)
}

function toTimestampLabel(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function buildWsUrl(baseUrl, params) {
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function buildHttpTranscribeParams(params) {
  const allowedKeys = new Set([
    'engine',
    'model',
    'sensevoice_model_id',
    'sensevoice_use_itn',
    'sensevoice_vad_model',
    'sensevoice_vad_merge',
    'sensevoice_vad_merge_length_s',
    'sensevoice_vad_max_single_segment_time_ms',
    'device',
    'compute_type',
    'language',
    'text_corrections',
    'download_root',
    'offline_segmented',
    'offline_segment_silence_ms',
    'offline_segment_min_speech_rms',
    'offline_segment_window_ms',
    'offline_segment_padding_ms',
    'offline_segment_max_segment_ms',
    'offline_segment_overlap_ms'
  ])
  const filtered = {}
  for (const [key, value] of Object.entries(params || {})) {
    if (!allowedKeys.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    filtered[key] = value
  }
  return filtered
}

function parseWav(buffer) {
  if (buffer.length < 44) {
    throw new Error('WAV 文件太短，无法解析')
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 RIFF/WAVE 文件')
  }

  let offset = 12
  let fmt = null
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkDataStart = offset + 8
    const chunkDataEnd = chunkDataStart + chunkSize
    if (chunkDataEnd > buffer.length) {
      break
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error('WAV fmt chunk 长度非法')
      }
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkDataStart),
        numChannels: buffer.readUInt16LE(chunkDataStart + 2),
        sampleRate: buffer.readUInt32LE(chunkDataStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkDataStart + 14)
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart
      dataSize = chunkSize
      break
    }

    offset = chunkDataEnd + (chunkSize % 2)
  }

  if (!fmt) throw new Error('WAV 缺少 fmt chunk')
  if (dataOffset < 0) throw new Error('WAV 缺少 data chunk')
  if (fmt.audioFormat !== 1) throw new Error(`仅支持 PCM WAV，当前 format=${fmt.audioFormat}`)
  if (fmt.bitsPerSample !== 16) throw new Error(`仅支持 16-bit PCM，当前 bits=${fmt.bitsPerSample}`)

  const rawData = buffer.slice(dataOffset, dataOffset + dataSize)
  if (fmt.numChannels === 1) {
    return { sampleRate: fmt.sampleRate, pcmMono: rawData }
  }

  if (fmt.numChannels <= 0) {
    throw new Error(`WAV 声道数非法: ${fmt.numChannels}`)
  }

  const frameCount = Math.floor(rawData.length / (fmt.numChannels * 2))
  const mono = Buffer.alloc(frameCount * 2)
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0
    for (let ch = 0; ch < fmt.numChannels; ch += 1) {
      const sampleOffset = (i * fmt.numChannels + ch) * 2
      sum += rawData.readInt16LE(sampleOffset)
    }
    const mixed = Math.max(-32768, Math.min(32767, Math.round(sum / fmt.numChannels)))
    mono.writeInt16LE(mixed, i * 2)
  }

  return { sampleRate: fmt.sampleRate, pcmMono: mono }
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mergeText(left, right) {
  if (!left) return right
  if (!right) return left
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right
  if (shouldInsertSpace(left, right)) return `${left} ${right}`
  return `${left}${right}`
}

function shouldInsertSpace(left, right) {
  const tail = left[left.length - 1]
  const head = right[0]
  if (!tail || !head) return false
  if (isCjkChar(tail) || isCjkChar(head)) return false
  const tailWord = /[\p{L}\p{N}]/u.test(tail)
  const headWord = /[\p{L}\p{N}]/u.test(head)
  if (tailWord && headWord) return true
  if (/[.!?;:]/.test(tail) && headWord) return true
  return false
}

function isCjkChar(char) {
  return /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char)
}

function normalizeForComparison(text, normalization = {}) {
  let value = String(text || '')
  if (normalization.unicodeForm) {
    value = value.normalize(normalization.unicodeForm)
  }
  if (normalization.toLower === true) {
    value = value.toLowerCase()
  }
  value = applyNormalizationReplacements(value, normalization.replacements)
  if (normalization.removePunctuation === true) {
    value = value.replace(/\p{P}+/gu, '')
  }
  if (normalization.removeSymbols === true) {
    value = value.replace(/\p{S}+/gu, '')
  }
  if (normalization.removeWhitespace !== false) {
    value = value.replace(/\s+/gu, '')
  }
  return value.trim()
}

function getBaselineNormalization(normalization = {}) {
  return {
    unicodeForm: normalization.unicodeForm,
    toLower: normalization.toLower,
    removeWhitespace: normalization.removeWhitespace
  }
}

function usesAdvancedNormalization(normalization = {}) {
  return normalization.removePunctuation === true || normalization.removeSymbols === true
}

function levenshteinDistanceByChars(left, right) {
  const a = Array.from(left)
  const b = Array.from(right)
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0))

  for (let i = 0; i < rows; i += 1) dp[i][0] = i
  for (let j = 0; j < cols; j += 1) dp[0][j] = j

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[rows - 1][cols - 1]
}

function percentile(values, q) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))
  return sorted[idx]
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?])/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

function toMeaningfulCharLength(text) {
  return Array.from(String(text || '').replace(/\s+/gu, '')).length
}

function getCommonPrefixCharLength(left, right) {
  const a = Array.from(String(left || ''))
  const b = Array.from(String(right || ''))
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) {
    index += 1
  }
  return index
}

function findBoundaryOverlap(left, right, maxChars = 200) {
  const a = Array.from(String(left || ''))
  const b = Array.from(String(right || ''))
  const max = Math.min(a.length, b.length, maxChars)
  for (let size = max; size > 0; size -= 1) {
    let matched = true
    for (let i = 0; i < size; i += 1) {
      if (a[a.length - size + i] !== b[i]) {
        matched = false
        break
      }
    }
    if (matched) {
      return size
    }
  }
  return 0
}

function summarizeStreamingMetrics(events, audioEndedMs) {
  const interimTexts = events
    .filter((event) => event.type === 'interim' && typeof event.pendingText === 'string')
    .map((event) => String(event.pendingText || ''))
    .filter((text) => text.trim().length > 0)
  const previewLengths = interimTexts.map((text) => toMeaningfulCharLength(text))

  let maxPreviewRollbackChars = 0
  for (let i = 1; i < interimTexts.length; i += 1) {
    const previousText = interimTexts[i - 1]
    const nextText = interimTexts[i]
    const commonPrefixCharLength = getCommonPrefixCharLength(previousText, nextText)
    const rollbackText = Array.from(previousText).slice(commonPrefixCharLength).join('')
    maxPreviewRollbackChars = Math.max(
      maxPreviewRollbackChars,
      toMeaningfulCharLength(rollbackText)
    )
  }

  const finalChunkTexts = events
    .filter((event) => event.type === 'final_chunk' && typeof event.text === 'string')
    .map((event) => String(event.text || '').trim())
    .filter((text) => text.length > 0)

  let accumulatedFinalText = ''
  let duplicateCharsAcrossChunkBoundaries = 0
  for (const chunkText of finalChunkTexts) {
    const overlapChars = findBoundaryOverlap(accumulatedFinalText, chunkText)
    duplicateCharsAcrossChunkBoundaries += overlapChars
    accumulatedFinalText = mergeText(accumulatedFinalText, chunkText)
  }

  const totalFinalChunkChars = finalChunkTexts.reduce(
    (sum, text) => sum + toMeaningfulCharLength(text),
    0
  )
  const commitEventAfterAudio = events.find(
    (event) =>
      (event.type === 'final_chunk' || event.type === 'final') &&
      typeof event.atMs === 'number' &&
      typeof audioEndedMs === 'number' &&
      event.atMs >= audioEndedMs
  )

  return {
    finalChunkCount: finalChunkTexts.length,
    avgPreviewLengthChars:
      previewLengths.length > 0
        ? Number(
            (previewLengths.reduce((sum, value) => sum + value, 0) / previewLengths.length).toFixed(
              2
            )
          )
        : null,
    maxPreviewRollbackChars,
    commitDelayAfterSilenceMs:
      typeof audioEndedMs === 'number' && commitEventAfterAudio
        ? Math.max(0, commitEventAfterAudio.atMs - audioEndedMs)
        : null,
    duplicateCharsAcrossChunkBoundaries,
    duplicateRatioAcrossChunkBoundaries:
      totalFinalChunkChars > 0
        ? Number((duplicateCharsAcrossChunkBoundaries / totalFinalChunkChars).toFixed(4))
        : 0
  }
}

function summarizeNumericMetric(values) {
  if (!values.length) return null
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length
  }
}

async function transcribeFullContext({ httpUrl, wavBuffer, queryParams }) {
  const baseUrl = new URL(httpUrl)
  const transcribeUrl = new URL('/transcribe', baseUrl)
  for (const [key, value] of Object.entries(buildHttpTranscribeParams(queryParams))) {
    transcribeUrl.searchParams.set(key, String(value))
  }

  const transport = transcribeUrl.protocol === 'https:' ? https : http
  const startedAt = performance.now()

  return new Promise((resolve, reject) => {
    const req = transport.request(
      transcribeUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': wavBuffer.length
        }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            const data = JSON.parse(body)
            resolve({
              durationMs: Math.round(performance.now() - startedAt),
              statusCode: res.statusCode || 0,
              ...data
            })
          } catch {
            reject(new Error(`Invalid JSON response: ${body}`))
          }
        })
      }
    )

    req.on('error', reject)
    req.setTimeout(120000, () => {
      req.destroy()
      reject(new Error('Full-context transcribe timeout'))
    })
    req.write(wavBuffer)
    req.end()
  })
}

async function runSingleCase({
  runIndex,
  wsUrl,
  pcmMono,
  sampleRate,
  chunkMs,
  speed,
  flushWaitMs,
  closeTimeoutMs
}) {
  const bytesPerChunk = Math.max(2, Math.floor((sampleRate * 2 * chunkMs) / 1000 / 2) * 2)
  const chunkDelayMs = chunkMs / speed
  const runStart = performance.now()
  const events = []
  let finalTextFromFinalEvent = ''
  let mergedFinalChunkText = ''
  let firstVisibleMs = null
  let wsErrorMessage = null
  let closedByTimeout = false
  let bytesSent = 0
  let chunksSent = 0
  let audioEndedMs = null

  const ws = new WebSocket(wsUrl)
  const openPromise = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const closePromise = new Promise((resolve) => {
    ws.once('close', (code, reason) => {
      resolve({
        code,
        reason: Buffer.isBuffer(reason) ? reason.toString('utf-8') : String(reason || '')
      })
    })
  })

  ws.on('error', (err) => {
    wsErrorMessage = err instanceof Error ? err.message : String(err)
  })

  ws.on('message', (payload, isBinary) => {
    if (isBinary) return
    const nowMs = Math.round(performance.now() - runStart)
    let data = null
    try {
      data = JSON.parse(payload.toString('utf-8'))
    } catch {
      data = { type: 'invalid_json', raw: payload.toString('utf-8') }
    }
    events.push({
      atMs: nowMs,
      ...data
    })

    const text =
      data.type === 'interim'
        ? typeof data.pendingText === 'string'
          ? data.pendingText.trim()
          : ''
        : typeof data.text === 'string'
          ? data.text.trim()
          : ''
    if (
      firstVisibleMs === null &&
      text &&
      (data.type === 'interim' || data.type === 'final_chunk' || data.type === 'final')
    ) {
      firstVisibleMs = nowMs
    }
    if (data.type === 'final_chunk' && text) {
      mergedFinalChunkText = mergeText(mergedFinalChunkText, text)
    }
    if (data.type === 'final' && text) {
      finalTextFromFinalEvent = text
    }
  })

  await openPromise

  for (let offset = 0; offset < pcmMono.length; offset += bytesPerChunk) {
    if (ws.readyState !== WebSocket.OPEN) break
    const chunk = pcmMono.slice(offset, Math.min(offset + bytesPerChunk, pcmMono.length))
    ws.send(chunk, { binary: true })
    bytesSent += chunk.length
    chunksSent += 1
    await sleep(chunkDelayMs)
  }
  audioEndedMs = Math.round(performance.now() - runStart)

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'flush' }))
    await sleep(flushWaitMs)
    ws.send(JSON.stringify({ type: 'close' }))
  }

  const closeResult = await Promise.race([
    closePromise,
    sleep(closeTimeoutMs).then(async () => {
      closedByTimeout = true
      try {
        ws.terminate()
      } catch {
        // ignore
      }
      return closePromise
    })
  ])

  const durationMs = Math.round(performance.now() - runStart)
  const finalText = (finalTextFromFinalEvent || mergedFinalChunkText).trim()
  const eventTypeCounts = {}
  for (const event of events) {
    const eventType = typeof event.type === 'string' ? event.type : 'unknown'
    eventTypeCounts[eventType] = (eventTypeCounts[eventType] || 0) + 1
  }

  return {
    runIndex,
    wsUrl,
    durationMs,
    sampleRate,
    bytesSent,
    chunksSent,
    audioEndedMs,
    firstVisibleMs,
    finalText,
    closeResult,
    closedByTimeout,
    wsErrorMessage,
    eventTypeCounts,
    events
  }
}

function buildTextComparisonSummary(finalText, reference) {
  const comparisonNormalization = reference.normalization || {}
  const normalizedExpected = normalizeForComparison(reference.expectedText, comparisonNormalization)
  const normalizedFinal = normalizeForComparison(finalText, comparisonNormalization)
  const charDistance = levenshteinDistanceByChars(normalizedExpected, normalizedFinal)
  const expectedChars = Array.from(normalizedExpected).length
  const cer =
    expectedChars > 0 ? charDistance / expectedChars : normalizedFinal.length === 0 ? 0 : 1
  const baselineNormalization = getBaselineNormalization(comparisonNormalization)
  const baselineNormalizedExpected = normalizeForComparison(
    reference.expectedText,
    baselineNormalization
  )
  const baselineNormalizedFinal = normalizeForComparison(finalText, baselineNormalization)
  const baselineCharDistance = levenshteinDistanceByChars(
    baselineNormalizedExpected,
    baselineNormalizedFinal
  )
  const baselineExpectedChars = Array.from(baselineNormalizedExpected).length
  const baselineCer =
    baselineExpectedChars > 0
      ? baselineCharDistance / baselineExpectedChars
      : baselineNormalizedFinal.length === 0
        ? 0
        : 1

  const expectedSentences = Array.isArray(reference.expectedSentences)
    ? reference.expectedSentences
    : []
  const finalSentences = splitSentences(finalText)
  const sentenceStats =
    expectedSentences.length > 0
      ? {
          expectedSentenceCount: expectedSentences.length,
          finalSentenceCount: finalSentences.length,
          sentenceCountDiff: finalSentences.length - expectedSentences.length
        }
      : undefined

  const cerThreshold =
    typeof reference.cerThreshold === 'number' ? reference.cerThreshold : undefined
  const passedByCer = typeof cerThreshold === 'number' ? cer <= cerThreshold : undefined

  return {
    comparisonNormalization,
    normalizedExpected,
    normalizedFinal,
    charDistance,
    expectedChars,
    cer,
    baselineNormalization,
    baselineNormalizedExpected,
    baselineNormalizedFinal,
    baselineCharDistance,
    baselineExpectedChars,
    baselineCer,
    usesAdvancedNormalization: usesAdvancedNormalization(comparisonNormalization),
    exactMatch: normalizedExpected === normalizedFinal,
    cerThreshold,
    passedByCer,
    sentenceStats
  }
}

function buildRunSummary(runResult, reference) {
  const comparison = buildTextComparisonSummary(runResult.finalText, reference)
  const wordTimingStats = summarizeWordTimingStats(runResult.events)
  const streamingMetrics = summarizeStreamingMetrics(runResult.events, runResult.audioEndedMs)

  return {
    ...runResult,
    ...comparison,
    wordTimingStats,
    streamingMetrics
  }
}

function summarizeWordTimingStats(events) {
  const byType = {}
  let totalTimedEvents = 0
  let totalItems = 0
  let maxItemsPerEvent = 0

  for (const event of events) {
    const eventType = typeof event.type === 'string' ? event.type : 'unknown'
    const timings = Array.isArray(event.wordTimings) ? event.wordTimings : []
    const itemCount = timings.length
    if (!byType[eventType]) {
      byType[eventType] = {
        timedEvents: 0,
        totalItems: 0,
        maxItemsPerEvent: 0
      }
    }
    if (itemCount <= 0) {
      continue
    }
    byType[eventType].timedEvents += 1
    byType[eventType].totalItems += itemCount
    byType[eventType].maxItemsPerEvent = Math.max(byType[eventType].maxItemsPerEvent, itemCount)
    totalTimedEvents += 1
    totalItems += itemCount
    maxItemsPerEvent = Math.max(maxItemsPerEvent, itemCount)
  }

  if (totalTimedEvents === 0) {
    return undefined
  }

  for (const stats of Object.values(byType)) {
    if (stats.timedEvents > 0) {
      stats.avgItemsPerEvent = Number((stats.totalItems / stats.timedEvents).toFixed(2))
    }
  }

  return {
    timedEventCount: totalTimedEvents,
    totalItems,
    avgItemsPerTimedEvent: Number((totalItems / totalTimedEvents).toFixed(2)),
    maxItemsPerEvent,
    byType
  }
}

function buildAggregateReport(runSummaries) {
  const cerList = runSummaries.map((run) => run.cer)
  const baselineCerList = runSummaries.map((run) => run.baselineCer)
  const firstVisibleList = runSummaries
    .map((run) => run.firstVisibleMs)
    .filter((value) => typeof value === 'number')
  const durationList = runSummaries.map((run) => run.durationMs)
  const cerThreshold =
    typeof runSummaries[0]?.cerThreshold === 'number' ? runSummaries[0].cerThreshold : undefined
  const passCount =
    typeof cerThreshold === 'number'
      ? runSummaries.filter((run) => run.passedByCer === true).length
      : 0
  const exactMatchCount = runSummaries.filter((run) => run.exactMatch === true).length
  const finalChunkCountStats = summarizeNumericMetric(
    runSummaries
      .map((run) => run.streamingMetrics?.finalChunkCount)
      .filter((value) => typeof value === 'number')
  )
  const avgPreviewLengthStats = summarizeNumericMetric(
    runSummaries
      .map((run) => run.streamingMetrics?.avgPreviewLengthChars)
      .filter((value) => typeof value === 'number')
  )
  const maxPreviewRollbackStats = summarizeNumericMetric(
    runSummaries
      .map((run) => run.streamingMetrics?.maxPreviewRollbackChars)
      .filter((value) => typeof value === 'number')
  )
  const commitDelayAfterSilenceStats = summarizeNumericMetric(
    runSummaries
      .map((run) => run.streamingMetrics?.commitDelayAfterSilenceMs)
      .filter((value) => typeof value === 'number')
  )
  const duplicateRatioStats = summarizeNumericMetric(
    runSummaries
      .map((run) => run.streamingMetrics?.duplicateRatioAcrossChunkBoundaries)
      .filter((value) => typeof value === 'number')
  )

  return {
    runCount: runSummaries.length,
    cerThreshold,
    passCount: typeof cerThreshold === 'number' ? passCount : undefined,
    passRate: typeof cerThreshold === 'number' ? passCount / runSummaries.length : undefined,
    exactMatchCount,
    exactMatchRate: exactMatchCount / runSummaries.length,
    cer: {
      min: Math.min(...cerList),
      max: Math.max(...cerList),
      p50: percentile(cerList, 0.5),
      p95: percentile(cerList, 0.95),
      avg: cerList.reduce((sum, v) => sum + v, 0) / cerList.length
    },
    baselineCer: {
      min: Math.min(...baselineCerList),
      max: Math.max(...baselineCerList),
      p50: percentile(baselineCerList, 0.5),
      p95: percentile(baselineCerList, 0.95),
      avg: baselineCerList.reduce((sum, v) => sum + v, 0) / baselineCerList.length
    },
    firstVisibleMs:
      firstVisibleList.length > 0
        ? {
            min: Math.min(...firstVisibleList),
            max: Math.max(...firstVisibleList),
            p50: percentile(firstVisibleList, 0.5),
            p95: percentile(firstVisibleList, 0.95),
            avg: firstVisibleList.reduce((sum, v) => sum + v, 0) / firstVisibleList.length
          }
        : null,
    durationMs: {
      min: Math.min(...durationList),
      max: Math.max(...durationList),
      p50: percentile(durationList, 0.5),
      p95: percentile(durationList, 0.95),
      avg: durationList.reduce((sum, v) => sum + v, 0) / durationList.length
    },
    streaming: {
      finalChunkCount: finalChunkCountStats,
      avgPreviewLengthChars: avgPreviewLengthStats,
      maxPreviewRollbackChars: maxPreviewRollbackStats,
      commitDelayAfterSilenceMs: commitDelayAfterSilenceStats,
      duplicateRatioAcrossChunkBoundaries: duplicateRatioStats
    }
  }
}

function buildFullContextSummary(fullContextResult, reference, profile) {
  const finalText = typeof fullContextResult?.text === 'string' ? fullContextResult.text.trim() : ''
  const comparison = buildTextComparisonSummary(finalText, reference)

  return {
    profile,
    success: fullContextResult?.success === true,
    durationMs:
      typeof fullContextResult?.durationMs === 'number' ? fullContextResult.durationMs : null,
    processingTimeMs:
      typeof fullContextResult?.processing_time === 'number'
        ? Math.round(fullContextResult.processing_time * 1000)
        : null,
    finalText,
    language: fullContextResult?.language,
    transcriptionProfile: fullContextResult?.transcription_profile || profile,
    offlineSegmentCount: Array.isArray(fullContextResult?.offline_segments)
      ? fullContextResult.offline_segments.length
      : null,
    error: fullContextResult?.error,
    ...comparison
  }
}

function buildMarkdownReport({
  caseId,
  audioPath,
  referencePath,
  wsUrl,
  httpUrl,
  outputDir,
  warnings,
  runSummaries,
  aggregate,
  fullContext
}) {
  const lines = []
  const singleShot = fullContext?.singleShot || null
  const offlineSegmented = fullContext?.offlineSegmented || null
  lines.push(`# Meeting Benchmark Report - ${caseId}`)
  lines.push('')
  lines.push(`- Audio: \`${audioPath}\``)
  lines.push(`- Reference: \`${referencePath}\``)
  lines.push(`- WS URL: \`${wsUrl}\``)
  if (httpUrl) {
    lines.push(`- HTTP URL: \`${httpUrl}\``)
  }
  lines.push(`- Runs: ${runSummaries.length}`)
  lines.push(`- Output: \`${outputDir}\``)
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push(`- Warnings: ${warnings.join(' | ')}`)
  }
  lines.push('')
  lines.push('## Aggregate')
  lines.push('')
  if (singleShot) {
    lines.push(
      `- Full-context single-shot CER: ${(singleShot.cer * 100).toFixed(2)}%${singleShot.success ? '' : ' (failed)'}`
    )
    if (typeof singleShot.durationMs === 'number') {
      lines.push(`- Full-context single-shot request duration ms: ${singleShot.durationMs}`)
    }
    if (typeof singleShot.processingTimeMs === 'number') {
      lines.push(`- Full-context single-shot server processing ms: ${singleShot.processingTimeMs}`)
    }
  }
  if (offlineSegmented) {
    lines.push(
      `- Full-context offline-segmented CER: ${(offlineSegmented.cer * 100).toFixed(2)}%${offlineSegmented.success ? '' : ' (failed)'}`
    )
    if (typeof offlineSegmented.durationMs === 'number') {
      lines.push(
        `- Full-context offline-segmented request duration ms: ${offlineSegmented.durationMs}`
      )
    }
    if (typeof offlineSegmented.processingTimeMs === 'number') {
      lines.push(
        `- Full-context offline-segmented server processing ms: ${offlineSegmented.processingTimeMs}`
      )
    }
    if (typeof offlineSegmented.offlineSegmentCount === 'number') {
      lines.push(
        `- Full-context offline-segmented segment count: ${offlineSegmented.offlineSegmentCount}`
      )
    }
  }
  if (singleShot) {
    lines.push(
      `- Streaming vs full-context single-shot CER gap: ${((aggregate.cer.avg - singleShot.cer) * 100).toFixed(2)} pp`
    )
  }
  if (offlineSegmented) {
    lines.push(
      `- Streaming vs full-context offline-segmented CER gap: ${((aggregate.cer.avg - offlineSegmented.cer) * 100).toFixed(2)} pp`
    )
  }
  if (singleShot && offlineSegmented) {
    lines.push(
      `- Offline-segmented vs single-shot CER delta: ${((offlineSegmented.cer - singleShot.cer) * 100).toFixed(2)} pp`
    )
  }
  lines.push(
    `- CER avg/p50/p95: ${(aggregate.cer.avg * 100).toFixed(2)}% / ${(aggregate.cer.p50 * 100).toFixed(2)}% / ${(aggregate.cer.p95 * 100).toFixed(2)}%`
  )
  if (
    runSummaries.some((run) => run.usesAdvancedNormalization) &&
    aggregate.baselineCer?.avg !== aggregate.cer.avg
  ) {
    lines.push(
      `- Baseline CER avg/p50/p95: ${(aggregate.baselineCer.avg * 100).toFixed(2)}% / ${(aggregate.baselineCer.p50 * 100).toFixed(2)}% / ${(aggregate.baselineCer.p95 * 100).toFixed(2)}%`
    )
  }
  if (typeof aggregate.cerThreshold === 'number') {
    lines.push(
      `- CER pass rate (<= ${(aggregate.cerThreshold * 100).toFixed(2)}%): ${aggregate.passCount}/${aggregate.runCount} (${(aggregate.passRate * 100).toFixed(1)}%)`
    )
  }
  lines.push(
    `- Exact match rate (normalized): ${aggregate.exactMatchCount}/${aggregate.runCount} (${(aggregate.exactMatchRate * 100).toFixed(1)}%)`
  )
  if (aggregate.firstVisibleMs) {
    lines.push(
      `- First visible ms avg/p50/p95: ${aggregate.firstVisibleMs.avg.toFixed(0)} / ${aggregate.firstVisibleMs.p50} / ${aggregate.firstVisibleMs.p95}`
    )
  }
  lines.push(
    `- Run duration ms avg/p50/p95: ${aggregate.durationMs.avg.toFixed(0)} / ${aggregate.durationMs.p50} / ${aggregate.durationMs.p95}`
  )
  if (aggregate.streaming.finalChunkCount) {
    lines.push(
      `- Final chunk count avg/p50/p95: ${aggregate.streaming.finalChunkCount.avg.toFixed(2)} / ${aggregate.streaming.finalChunkCount.p50} / ${aggregate.streaming.finalChunkCount.p95}`
    )
  }
  if (aggregate.streaming.avgPreviewLengthChars) {
    lines.push(
      `- Avg preview chars avg/p50/p95: ${aggregate.streaming.avgPreviewLengthChars.avg.toFixed(2)} / ${aggregate.streaming.avgPreviewLengthChars.p50} / ${aggregate.streaming.avgPreviewLengthChars.p95}`
    )
  }
  if (aggregate.streaming.maxPreviewRollbackChars) {
    lines.push(
      `- Max preview rollback chars avg/p50/p95: ${aggregate.streaming.maxPreviewRollbackChars.avg.toFixed(2)} / ${aggregate.streaming.maxPreviewRollbackChars.p50} / ${aggregate.streaming.maxPreviewRollbackChars.p95}`
    )
  }
  if (aggregate.streaming.commitDelayAfterSilenceMs) {
    lines.push(
      `- Commit delay after silence ms avg/p50/p95: ${aggregate.streaming.commitDelayAfterSilenceMs.avg.toFixed(0)} / ${aggregate.streaming.commitDelayAfterSilenceMs.p50} / ${aggregate.streaming.commitDelayAfterSilenceMs.p95}`
    )
  }
  if (aggregate.streaming.duplicateRatioAcrossChunkBoundaries) {
    lines.push(
      `- Duplicate ratio across chunk boundaries avg/p50/p95: ${(aggregate.streaming.duplicateRatioAcrossChunkBoundaries.avg * 100).toFixed(2)}% / ${(aggregate.streaming.duplicateRatioAcrossChunkBoundaries.p50 * 100).toFixed(2)}% / ${(aggregate.streaming.duplicateRatioAcrossChunkBoundaries.p95 * 100).toFixed(2)}%`
    )
  }
  lines.push('')
  lines.push('## Run Results')
  lines.push('')
  lines.push(
    '| Run | CER | FirstVisible(ms) | Duration(ms) | Events(interim/final_chunk/final/error) |'
  )
  lines.push('| --- | --- | --- | --- | --- |')
  for (const run of runSummaries) {
    const counts = run.eventTypeCounts || {}
    const timedInterim = run.wordTimingStats?.byType?.interim?.timedEvents || 0
    const timedFinalChunk = run.wordTimingStats?.byType?.final_chunk?.timedEvents || 0
    const timedFinal = run.wordTimingStats?.byType?.final?.timedEvents || 0
    lines.push(
      `| ${run.runIndex} | ${(run.cer * 100).toFixed(2)}% | ${run.firstVisibleMs ?? '-'} | ${run.durationMs} | ${counts.interim || 0}/${counts.final_chunk || 0}/${counts.final || 0}/${counts.error || 0} |`
    )
    if (run.wordTimingStats) {
      lines.push(
        `Word timings: events=${run.wordTimingStats.timedEventCount}, avgItems=${run.wordTimingStats.avgItemsPerTimedEvent}, maxItems=${run.wordTimingStats.maxItemsPerEvent}, byType(interim/final_chunk/final)=${timedInterim}/${timedFinalChunk}/${timedFinal}`
      )
    }
    if (run.streamingMetrics) {
      lines.push(
        `Streaming: finalChunks=${run.streamingMetrics.finalChunkCount}, avgPreviewChars=${run.streamingMetrics.avgPreviewLengthChars ?? '-'}, maxRollback=${run.streamingMetrics.maxPreviewRollbackChars}, silenceCommitMs=${run.streamingMetrics.commitDelayAfterSilenceMs ?? '-'}, duplicateRatio=${(run.streamingMetrics.duplicateRatioAcrossChunkBoundaries * 100).toFixed(2)}%`
      )
    }
  }
  lines.push('')
  return lines.join('\n')
}

async function writeJsonl(filePath, rows) {
  const content = rows.map((row) => JSON.stringify(row)).join('\n')
  await fs.writeFile(filePath, content ? `${content}\n` : '', 'utf-8')
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2))
  if (rawArgs.help || rawArgs.h) {
    printUsage()
    return
  }

  const audioArg = rawArgs.audio
  const refArg = rawArgs.ref
  if (!audioArg || !refArg) {
    printUsage()
    throw new Error('必须提供 --audio 和 --ref')
  }

  const audioPath = path.resolve(process.cwd(), audioArg)
  const referencePath = path.resolve(process.cwd(), refArg)
  const reference = await loadJson(referencePath)
  if (typeof reference.expectedText !== 'string') {
    throw new Error('ref.json 必须包含字符串字段 expectedText')
  }
  const wavBuffer = await fs.readFile(audioPath)
  const { sampleRate: wavSampleRate, pcmMono } = parseWav(wavBuffer)

  const caseId =
    rawArgs.case ||
    reference.id ||
    path.basename(audioPath, path.extname(audioPath)) ||
    `case-${toTimestampLabel()}`
  const warnings = []
  const audioBaseName = path.basename(audioPath, path.extname(audioPath))
  const referenceBaseName = path
    .basename(referencePath, path.extname(referencePath))
    .replace(/\.ref$/i, '')
  if (
    typeof reference.id === 'string' &&
    reference.id &&
    !reference.id.startsWith(audioBaseName) &&
    !reference.id.startsWith(referenceBaseName)
  ) {
    warnings.push(
      `reference.id (${reference.id}) does not align with audio/ref basename (${audioBaseName}/${referenceBaseName}); output directory may be misleading`
    )
  }
  const outputDir =
    rawArgs['out-dir'] ||
    path.join(projectRoot, 'out', 'meeting-bench', `${caseId}-${toTimestampLabel()}`)
  await fs.mkdir(outputDir, { recursive: true })

  const runs = resolveNumber(rawArgs.runs, DEFAULTS.runs, 1)
  const chunkMs = resolveNumber(rawArgs['chunk-ms'], DEFAULTS.chunkMs, 20)
  const speed = resolveFloat(rawArgs.speed, DEFAULTS.speed, 0.1)
  const flushWaitMs = resolveNumber(rawArgs['flush-wait-ms'], DEFAULTS.flushWaitMs, 0)
  const closeTimeoutMs = resolveNumber(rawArgs['close-timeout-ms'], DEFAULTS.closeTimeoutMs, 1000)
  const wsBaseUrl = rawArgs['ws-url'] || DEFAULTS.wsUrl
  const httpUrl = rawArgs['http-url'] || DEFAULTS.httpUrl
  const shouldRunFullContext = rawArgs['skip-full-context'] !== true

  const refWsParams =
    typeof reference.wsParams === 'object' && reference.wsParams ? reference.wsParams : {}
  const argWsParams = rawArgs.queryParams || {}
  const mergedWsParams = { ...refWsParams, ...argWsParams }
  // Backward compatibility for camelCase wsParams in old ref.json files.
  if (
    mergedWsParams.sensevoiceModelId !== undefined &&
    mergedWsParams.sensevoice_model_id === undefined
  ) {
    mergedWsParams.sensevoice_model_id = mergedWsParams.sensevoiceModelId
    delete mergedWsParams.sensevoiceModelId
  }
  if (
    mergedWsParams.sensevoiceUseItn !== undefined &&
    mergedWsParams.sensevoice_use_itn === undefined
  ) {
    mergedWsParams.sensevoice_use_itn = mergedWsParams.sensevoiceUseItn
    delete mergedWsParams.sensevoiceUseItn
  }
  if (
    mergedWsParams.sensevoiceVadModel !== undefined &&
    mergedWsParams.sensevoice_vad_model === undefined
  ) {
    mergedWsParams.sensevoice_vad_model = mergedWsParams.sensevoiceVadModel
    delete mergedWsParams.sensevoiceVadModel
  }
  if (
    mergedWsParams.sensevoiceVadMerge !== undefined &&
    mergedWsParams.sensevoice_vad_merge === undefined
  ) {
    mergedWsParams.sensevoice_vad_merge = mergedWsParams.sensevoiceVadMerge
    delete mergedWsParams.sensevoiceVadMerge
  }
  if (
    mergedWsParams.sensevoiceVadMergeLengthS !== undefined &&
    mergedWsParams.sensevoice_vad_merge_length_s === undefined
  ) {
    mergedWsParams.sensevoice_vad_merge_length_s = mergedWsParams.sensevoiceVadMergeLengthS
    delete mergedWsParams.sensevoiceVadMergeLengthS
  }
  if (
    mergedWsParams.sensevoiceVadMaxSingleSegmentTimeMs !== undefined &&
    mergedWsParams.sensevoice_vad_max_single_segment_time_ms === undefined
  ) {
    mergedWsParams.sensevoice_vad_max_single_segment_time_ms =
      mergedWsParams.sensevoiceVadMaxSingleSegmentTimeMs
    delete mergedWsParams.sensevoiceVadMaxSingleSegmentTimeMs
  }
  if (mergedWsParams.computeType !== undefined && mergedWsParams.compute_type === undefined) {
    mergedWsParams.compute_type = mergedWsParams.computeType
    delete mergedWsParams.computeType
  }
  if (mergedWsParams.sampleRate !== undefined && mergedWsParams.sample_rate === undefined) {
    mergedWsParams.sample_rate = mergedWsParams.sampleRate
    delete mergedWsParams.sampleRate
  }
  if (
    mergedWsParams.textCorrections !== undefined &&
    mergedWsParams.text_corrections === undefined &&
    typeof mergedWsParams.textCorrections !== 'string'
  ) {
    mergedWsParams.text_corrections = JSON.stringify(mergedWsParams.textCorrections)
    delete mergedWsParams.textCorrections
  }
  if (typeof rawArgs['text-corrections-file'] === 'string' && rawArgs['text-corrections-file']) {
    const textCorrectionsPath = path.resolve(process.cwd(), rawArgs['text-corrections-file'])
    const textCorrectionsJson = await fs.readFile(textCorrectionsPath, 'utf8')
    mergedWsParams.text_corrections = JSON.stringify(JSON.parse(textCorrectionsJson))
  }
  const desiredSampleRate = Number(
    mergedWsParams.sample_rate || rawArgs['sample-rate'] || wavSampleRate
  )
  mergedWsParams.sample_rate = Number.isFinite(desiredSampleRate)
    ? Math.floor(desiredSampleRate)
    : wavSampleRate
  if (mergedWsParams.sensevoice_use_itn !== undefined) {
    mergedWsParams.sensevoice_use_itn = normalizeBoolString(
      String(mergedWsParams.sensevoice_use_itn)
    )
  }
  if (mergedWsParams.sensevoice_vad_merge !== undefined) {
    mergedWsParams.sensevoice_vad_merge = normalizeBoolString(
      String(mergedWsParams.sensevoice_vad_merge)
    )
  }

  const wsUrl = buildWsUrl(wsBaseUrl, mergedWsParams)
  const audioDurationMs = Math.round((pcmMono.length / 2 / wavSampleRate) * 1000)
  let fullContext = null

  if (shouldRunFullContext) {
    console.log(`[Bench] Full-context single-shot baseline started: http=${httpUrl}`)
    const singleShotResult = await transcribeFullContext({
      httpUrl,
      wavBuffer,
      queryParams: mergedWsParams
    })
    const singleShot = buildFullContextSummary(singleShotResult, reference, 'single_shot')
    await fs.writeFile(
      path.join(outputDir, 'full-context.single-shot.summary.json'),
      `${JSON.stringify(singleShot, null, 2)}\n`,
      'utf-8'
    )
    await fs.writeFile(
      path.join(outputDir, 'full-context.single-shot.final.txt'),
      `${singleShot.finalText}\n`,
      'utf-8'
    )
    console.log(
      `[Bench] Full-context single-shot done: CER=${(singleShot.cer * 100).toFixed(2)}%, duration=${singleShot.durationMs ?? '-'}ms`
    )

    console.log(`[Bench] Full-context offline-segmented baseline started: http=${httpUrl}`)
    const offlineSegmentedResult = await transcribeFullContext({
      httpUrl,
      wavBuffer,
      queryParams: {
        ...mergedWsParams,
        offline_segmented: 'true'
      }
    })
    const offlineSegmented = buildFullContextSummary(
      offlineSegmentedResult,
      reference,
      'offline_segmented'
    )
    fullContext = {
      singleShot,
      offlineSegmented
    }
    await fs.writeFile(
      path.join(outputDir, 'full-context.offline-segmented.summary.json'),
      `${JSON.stringify(offlineSegmented, null, 2)}\n`,
      'utf-8'
    )
    await fs.writeFile(
      path.join(outputDir, 'full-context.offline-segmented.final.txt'),
      `${offlineSegmented.finalText}\n`,
      'utf-8'
    )
    await fs.writeFile(
      path.join(outputDir, 'full-context.summary.json'),
      `${JSON.stringify(fullContext, null, 2)}\n`,
      'utf-8'
    )
    console.log(
      `[Bench] Full-context offline-segmented done: CER=${(offlineSegmented.cer * 100).toFixed(2)}%, duration=${offlineSegmented.durationMs ?? '-'}ms, segments=${offlineSegmented.offlineSegmentCount ?? '-'}`
    )
  }

  console.log(
    `[Bench] case=${caseId}, runs=${runs}, audio=${audioPath}, duration=${audioDurationMs}ms, ws=${wsUrl}`
  )

  const runSummaries = []
  for (let i = 0; i < runs; i += 1) {
    const runIndex = i + 1
    console.log(`[Bench] Run ${runIndex}/${runs} started`)
    const runResult = await runSingleCase({
      runIndex,
      wsUrl,
      pcmMono,
      sampleRate: Number(mergedWsParams.sample_rate) || wavSampleRate,
      chunkMs,
      speed,
      flushWaitMs,
      closeTimeoutMs
    })
    const runSummary = buildRunSummary(runResult, reference)
    runSummaries.push(runSummary)

    const runPrefix = `run-${String(runIndex).padStart(2, '0')}`
    await writeJsonl(path.join(outputDir, `${runPrefix}.events.jsonl`), runSummary.events)
    await fs.writeFile(
      path.join(outputDir, `${runPrefix}.summary.json`),
      `${JSON.stringify(runSummary, null, 2)}\n`,
      'utf-8'
    )
    await fs.writeFile(
      path.join(outputDir, `${runPrefix}.final.txt`),
      `${runSummary.finalText}\n`,
      'utf-8'
    )

    console.log(
      `[Bench] Run ${runIndex}/${runs} done: CER=${(runSummary.cer * 100).toFixed(2)}%, firstVisible=${runSummary.firstVisibleMs ?? '-'}ms, rollback=${runSummary.streamingMetrics.maxPreviewRollbackChars}, duplicateRatio=${(runSummary.streamingMetrics.duplicateRatioAcrossChunkBoundaries * 100).toFixed(2)}%`
    )
  }

  const aggregate = buildAggregateReport(runSummaries)
  const report = {
    caseId,
    generatedAt: new Date().toISOString(),
    audioPath,
    referencePath,
    outputDir,
    warnings,
    wsUrl,
    httpUrl,
    config: {
      runs,
      chunkMs,
      speed,
      flushWaitMs,
      closeTimeoutMs,
      sampleRate: Number(mergedWsParams.sample_rate) || wavSampleRate,
      audioDurationMs,
      fullContextEnabled: shouldRunFullContext,
      fullContextProfiles: shouldRunFullContext ? ['single_shot', 'offline_segmented'] : []
    },
    fullContext,
    aggregate,
    runs: runSummaries.map((run) => {
      const runWithoutEvents = { ...run }
      delete runWithoutEvents.events
      return runWithoutEvents
    })
  }

  await fs.writeFile(
    path.join(outputDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf-8'
  )
  await fs.writeFile(
    path.join(outputDir, 'report.md'),
    `${buildMarkdownReport({
      caseId,
      audioPath,
      referencePath,
      wsUrl,
      httpUrl,
      outputDir,
      warnings,
      runSummaries,
      aggregate,
      fullContext
    })}\n`,
    'utf-8'
  )

  console.log(`[Bench] Report written to: ${outputDir}`)
  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`[Bench] Warning: ${warning}`)
    }
  }
  console.log(
    `[Bench] Aggregate CER avg/p50/p95 = ${(aggregate.cer.avg * 100).toFixed(2)}% / ${(aggregate.cer.p50 * 100).toFixed(2)}% / ${(aggregate.cer.p95 * 100).toFixed(2)}%`
  )
  if (runSummaries.some((run) => run.usesAdvancedNormalization)) {
    console.log(
      `[Bench] Baseline CER avg/p50/p95 = ${(aggregate.baselineCer.avg * 100).toFixed(2)}% / ${(aggregate.baselineCer.p50 * 100).toFixed(2)}% / ${(aggregate.baselineCer.p95 * 100).toFixed(2)}%`
    )
  }
  console.log(
    `[Bench] Exact match rate (normalized) = ${aggregate.exactMatchCount}/${aggregate.runCount} (${(aggregate.exactMatchRate * 100).toFixed(1)}%)`
  )
  if (typeof aggregate.cerThreshold === 'number') {
    console.log(
      `[Bench] CER pass rate (<= ${(aggregate.cerThreshold * 100).toFixed(2)}%) = ${aggregate.passCount}/${aggregate.runCount} (${(aggregate.passRate * 100).toFixed(1)}%)`
    )
  }
}

main().catch((error) => {
  console.error('[Bench] Failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
