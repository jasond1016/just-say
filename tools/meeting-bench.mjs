#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import fs from 'fs/promises'
import path from 'path'
import { performance } from 'perf_hooks'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const DEFAULTS = {
  wsUrl: 'ws://127.0.0.1:8766/stream',
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
  --runs <n>                重复运行次数（default: ${DEFAULTS.runs}）
  --chunk-ms <n>            音频分片毫秒（default: ${DEFAULTS.chunkMs}）
  --speed <n>               回放速度（1=实时，2=2x，default: ${DEFAULTS.speed}）
  --flush-wait-ms <n>       发送 flush 后等待毫秒（default: ${DEFAULTS.flushWaitMs}）
  --close-timeout-ms <n>    会话关闭超时毫秒（default: ${DEFAULTS.closeTimeoutMs}）
  --out-dir <path>          输出目录（默认 out/meeting-bench/<case>-<timestamp>）

WS Query（会覆盖 ref.json 的 wsParams）:
  --engine <value>
  --model <value>
  --sensevoice-model-id <value>
  --sensevoice-use-itn <true|false>
  --device <value>
  --compute-type <value>
  --language <value>
  --sample-rate <n>
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
    device: 'device',
    'compute-type': 'compute_type',
    language: 'language',
    'sample-rate': 'sample_rate',
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
  if (normalization.removeWhitespace !== false) {
    value = value.replace(/\s+/gu, '')
  }
  return value.trim()
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

    const text = typeof data.text === 'string' ? data.text.trim() : ''
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
    firstVisibleMs,
    finalText,
    closeResult,
    closedByTimeout,
    wsErrorMessage,
    eventTypeCounts,
    events
  }
}

function buildRunSummary(runResult, reference) {
  const normalizedExpected = normalizeForComparison(reference.expectedText, reference.normalization)
  const normalizedFinal = normalizeForComparison(runResult.finalText, reference.normalization)
  const charDistance = levenshteinDistanceByChars(normalizedExpected, normalizedFinal)
  const expectedChars = Array.from(normalizedExpected).length
  const cer =
    expectedChars > 0 ? charDistance / expectedChars : normalizedFinal.length === 0 ? 0 : 1

  const expectedSentences = Array.isArray(reference.expectedSentences)
    ? reference.expectedSentences
    : []
  const finalSentences = splitSentences(runResult.finalText)
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
    ...runResult,
    normalizedExpected,
    normalizedFinal,
    charDistance,
    expectedChars,
    cer,
    exactMatch: normalizedExpected === normalizedFinal,
    cerThreshold,
    passedByCer,
    sentenceStats
  }
}

function buildAggregateReport(runSummaries) {
  const cerList = runSummaries.map((run) => run.cer)
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
    }
  }
}

function buildMarkdownReport({
  caseId,
  audioPath,
  referencePath,
  wsUrl,
  outputDir,
  runSummaries,
  aggregate
}) {
  const lines = []
  lines.push(`# Meeting Benchmark Report - ${caseId}`)
  lines.push('')
  lines.push(`- Audio: \`${audioPath}\``)
  lines.push(`- Reference: \`${referencePath}\``)
  lines.push(`- WS URL: \`${wsUrl}\``)
  lines.push(`- Runs: ${runSummaries.length}`)
  lines.push(`- Output: \`${outputDir}\``)
  lines.push('')
  lines.push('## Aggregate')
  lines.push('')
  lines.push(
    `- CER avg/p50/p95: ${(aggregate.cer.avg * 100).toFixed(2)}% / ${(aggregate.cer.p50 * 100).toFixed(2)}% / ${(aggregate.cer.p95 * 100).toFixed(2)}%`
  )
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
  lines.push('')
  lines.push('## Run Results')
  lines.push('')
  lines.push(
    '| Run | CER | FirstVisible(ms) | Duration(ms) | Events(interim/final_chunk/final/error) |'
  )
  lines.push('| --- | --- | --- | --- | --- |')
  for (const run of runSummaries) {
    const counts = run.eventTypeCounts || {}
    lines.push(
      `| ${run.runIndex} | ${(run.cer * 100).toFixed(2)}% | ${run.firstVisibleMs ?? '-'} | ${run.durationMs} | ${counts.interim || 0}/${counts.final_chunk || 0}/${counts.final || 0}/${counts.error || 0} |`
    )
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
  if (mergedWsParams.computeType !== undefined && mergedWsParams.compute_type === undefined) {
    mergedWsParams.compute_type = mergedWsParams.computeType
    delete mergedWsParams.computeType
  }
  if (mergedWsParams.sampleRate !== undefined && mergedWsParams.sample_rate === undefined) {
    mergedWsParams.sample_rate = mergedWsParams.sampleRate
    delete mergedWsParams.sampleRate
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

  const wsUrl = buildWsUrl(wsBaseUrl, mergedWsParams)
  const audioDurationMs = Math.round((pcmMono.length / 2 / wavSampleRate) * 1000)

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
      `[Bench] Run ${runIndex}/${runs} done: CER=${(runSummary.cer * 100).toFixed(2)}%, firstVisible=${runSummary.firstVisibleMs ?? '-'}ms`
    )
  }

  const aggregate = buildAggregateReport(runSummaries)
  const report = {
    caseId,
    generatedAt: new Date().toISOString(),
    audioPath,
    referencePath,
    outputDir,
    wsUrl,
    config: {
      runs,
      chunkMs,
      speed,
      flushWaitMs,
      closeTimeoutMs,
      sampleRate: Number(mergedWsParams.sample_rate) || wavSampleRate,
      audioDurationMs
    },
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
      outputDir,
      runSummaries,
      aggregate
    })}\n`,
    'utf-8'
  )

  console.log(`[Bench] Report written to: ${outputDir}`)
  console.log(
    `[Bench] Aggregate CER avg/p50/p95 = ${(aggregate.cer.avg * 100).toFixed(2)}% / ${(aggregate.cer.p50 * 100).toFixed(2)}% / ${(aggregate.cer.p95 * 100).toFixed(2)}%`
  )
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
