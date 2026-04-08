#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from 'child_process'
import fs from 'fs/promises'
import http from 'http'
import https from 'https'
import path from 'path'
import { performance } from 'perf_hooks'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const fixturesDir = path.join(projectRoot, 'fixtures')

const DEFAULTS = {
  httpUrl: 'http://127.0.0.1:8765',
  sampleRate: 16000,
  cerThreshold: 0.15
}

function printUsage() {
  console.log(`
Usage:
  pnpm meeting:prepare -- --audio <path> [options]

Required:
  --audio <path>            输入音频文件路径（任意格式，ffmpeg 支持即可）

Options:
  --case-id <id>            Case ID（默认从文件名推导）
  --language <lang>         语言代码（不指定时由服务器自动检测）
  --http-url <url>          HTTP 服务地址（default: ${DEFAULTS.httpUrl}）
  --engine <value>          识别引擎
  --device <value>          设备（cuda/cpu）
  --compute-type <value>    计算精度
  --sample-rate <n>         目标采样率（default: ${DEFAULTS.sampleRate}）
  --cer-threshold <n>       CER 阈值（default: ${DEFAULTS.cerThreshold}）
  --force                   覆盖已存在的输出文件
  --help, -h                显示帮助
`)
}

function parseArgs(argv) {
  const args = {}

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) {
      if (key === '-h') {
        args.help = true
        continue
      }
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

  return args
}

function convertAudioWithFfmpeg(inputPath, outputPath, sampleRate) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i',
      inputPath,
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-sample_fmt',
      's16',
      '-f',
      'wav',
      '-y',
      outputPath
    ]

    execFile('ffmpeg', args, { timeout: 120000 }, (error, _stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          reject(new Error('ffmpeg 未安装或不在 PATH 中。请先安装 ffmpeg。'))
          return
        }
        reject(new Error(`ffmpeg 转换失败: ${error.message}\n${stderr}`))
        return
      }
      resolve()
    })
  })
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
    'download_root'
  ])
  const filtered = {}
  for (const [key, value] of Object.entries(params || {})) {
    if (!allowedKeys.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    filtered[key] = value
  }
  return filtered
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

    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(
          new Error(
            `无法连接到 whisper server (${httpUrl})。请确认服务已启动。\n` +
              `启动命令: cd python && python whisper_server.py`
          )
        )
        return
      }
      reject(err)
    })
    req.setTimeout(300000, () => {
      req.destroy()
      reject(new Error('转录请求超时（5分钟）'))
    })
    req.write(wavBuffer)
    req.end()
  })
}

function splitSentences(text, language) {
  const str = String(text || '')
  if (language && language.startsWith('en')) {
    return str
      .split(/(?<=[.!?])\s+/u)
      .map((line) => line.trim())
      .filter(Boolean)
  }
  return str
    .split(/(?<=[。！？!?])/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

function buildNormalization(language) {
  const base = {
    unicodeForm: 'NFKC',
    removeWhitespace: true,
    removePunctuation: true,
    removeSymbols: true
  }

  if (language && language.startsWith('en')) {
    return { ...base, toLower: true }
  }

  if (language === 'ja') {
    return {
      ...base,
      toLower: false,
      replacements: [
        { from: '1つ', to: '一つ' },
        { from: '2つ', to: '二つ' },
        { from: '3つ', to: '三つ' }
      ]
    }
  }

  return { ...base, toLower: false }
}

function buildWsParams(args, sampleRate) {
  const params = { sample_rate: sampleRate }
  if (args.language) params.language = args.language
  if (args.engine) params.engine = args.engine
  if (args.device) params.device = args.device
  if (args['compute-type']) params.compute_type = args['compute-type']
  return params
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2))
  if (rawArgs.help || rawArgs.h) {
    printUsage()
    return
  }

  const audioArg = rawArgs.audio
  if (!audioArg) {
    printUsage()
    throw new Error('必须提供 --audio')
  }

  const audioPath = path.resolve(process.cwd(), audioArg)
  try {
    await fs.access(audioPath)
  } catch {
    throw new Error(`音频文件不存在: ${audioPath}`)
  }

  const httpUrl = rawArgs['http-url'] || DEFAULTS.httpUrl
  const sampleRate = Number(rawArgs['sample-rate']) || DEFAULTS.sampleRate
  const cerThreshold = Number(rawArgs['cer-threshold']) || DEFAULTS.cerThreshold

  const audioBaseName = path.basename(audioPath, path.extname(audioPath))
  const caseId = rawArgs['case-id'] || audioBaseName
  const wavOutputPath = path.join(fixturesDir, `${caseId}.wav`)
  const refOutputPath = path.join(fixturesDir, `${caseId}.ref.json`)

  if (!rawArgs.force) {
    const existingFiles = []
    try {
      await fs.access(wavOutputPath)
      existingFiles.push(wavOutputPath)
    } catch {
      // file doesn't exist, ok
    }
    try {
      await fs.access(refOutputPath)
      existingFiles.push(refOutputPath)
    } catch {
      // file doesn't exist, ok
    }
    if (existingFiles.length > 0) {
      throw new Error(
        `输出文件已存在:\n${existingFiles.map((f) => `  ${f}`).join('\n')}\n使用 --force 覆盖`
      )
    }
  }

  // Step 1: Convert audio to WAV
  console.log(`[Prepare] 转换音频: ${audioPath}`)
  console.log(`[Prepare] 目标格式: ${sampleRate}Hz, mono, 16-bit PCM`)
  await convertAudioWithFfmpeg(audioPath, wavOutputPath, sampleRate)
  console.log(`[Prepare] WAV 已生成: ${wavOutputPath}`)

  // Step 2: Transcribe
  const wavBuffer = await fs.readFile(wavOutputPath)
  const queryParams = buildWsParams(rawArgs, sampleRate)

  console.log(`[Prepare] 开始 full-context 转录: ${httpUrl}`)
  const result = await transcribeFullContext({ httpUrl, wavBuffer, queryParams })

  if (result.success === false) {
    throw new Error(`转录失败: ${result.error || 'unknown error'}`)
  }

  const transcribedText = String(result.text || '').trim()
  if (!transcribedText) {
    throw new Error('转录结果为空')
  }

  const detectedLanguage = result.language || rawArgs.language || undefined
  console.log(`[Prepare] 转录完成 (${result.durationMs}ms)`)
  if (detectedLanguage) {
    console.log(`[Prepare] 语言: ${detectedLanguage}`)
  }
  console.log(
    `[Prepare] 转录文本: ${transcribedText.slice(0, 100)}${transcribedText.length > 100 ? '...' : ''}`
  )

  // Step 3: Build ref.json
  const languageForConfig = rawArgs.language || detectedLanguage
  const sentences = splitSentences(transcribedText, languageForConfig)
  const normalization = buildNormalization(languageForConfig)
  const wsParams = buildWsParams(rawArgs, sampleRate)

  const refJson = {
    id: caseId,
    expectedText: transcribedText,
    expectedSentences: sentences,
    baselineSource: 'auto-transcribed',
    cerThreshold,
    normalization,
    wsParams
  }

  await fs.writeFile(refOutputPath, `${JSON.stringify(refJson, null, 2)}\n`, 'utf-8')
  console.log(`[Prepare] ref.json 已生成: ${refOutputPath}`)

  // Summary
  console.log('')
  console.log(`[Prepare] ✅ Case "${caseId}" 准备完成`)
  console.log(`[Prepare]   WAV: ${path.relative(projectRoot, wavOutputPath)}`)
  console.log(`[Prepare]   REF: ${path.relative(projectRoot, refOutputPath)}`)
  console.log(`[Prepare]   文本长度: ${transcribedText.length} 字符, ${sentences.length} 句`)
  console.log(`[Prepare]   baselineSource: auto-transcribed`)
  console.log('')
  console.log(`[Prepare] 下一步运行 benchmark:`)
  console.log(
    `  pnpm meeting:bench -- --audio fixtures/${caseId}.wav --ref fixtures/${caseId}.ref.json`
  )
}

main().catch((error) => {
  console.error('[Prepare] Failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
