import { getConfig } from '../config'
import { getApiKey } from '../secureStore'

export interface MeetingSummaryResult {
  summary: string
  generatedAt: string
  model: string
}

export interface ActionItem {
  content: string
  assignee?: string
}

export interface MeetingActionItemsResult {
  items: ActionItem[]
  generatedAt: string
  model: string
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
}

function resolveChatCompletionsUrl(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) {
    return normalized
  }
  return `${normalized}/chat/completions`
}

function resolveEndpointAndKey(): { endpoint: string; apiKey: string; model: string } {
  const config = getConfig()
  const translation = config.recognition?.translation
  const ai = config.ai

  const endpoint = (ai?.endpoint || translation?.endpoint || 'https://api.openai.com/v1').trim()
  const model = (ai?.model || translation?.model || 'gpt-4o-mini').trim()
  const apiKey = getApiKey('openai') || config.recognition?.api?.apiKey || ''

  if (!apiKey) {
    throw new Error('Missing API key. Please configure a translation API key in Settings.')
  }

  return { endpoint, apiKey, model }
}

async function callChatCompletion(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 60_000
): Promise<string> {
  const { endpoint, apiKey, model } = resolveEndpointAndKey()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(resolveChatCompletionsUrl(endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3
      }),
      signal: controller.signal
    })

    const payload = (await response.json()) as ChatCompletionResponse
    if (!response.ok) {
      const errorMessage = payload.error?.message || `HTTP ${response.status}`
      throw new Error(errorMessage)
    }

    const content = payload.choices?.[0]?.message?.content?.trim() || ''
    if (!content) {
      throw new Error('Empty response from LLM')
    }
    return content
  } finally {
    clearTimeout(timeout)
  }
}

function buildTranscriptText(
  segments: Array<{ speaker: number; source?: string | null; text: string }>
): string {
  return segments
    .map((seg) => {
      const label =
        seg.source === 'microphone'
          ? '[Me]'
          : seg.source === 'system'
            ? '[Remote]'
            : `[Speaker ${seg.speaker + 1}]`
      return `${label}: ${seg.text.trim()}`
    })
    .filter((line) => line.length > 0)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Language detection – used to align output language with transcript content
// ---------------------------------------------------------------------------

type DetectedLanguage = 'zh' | 'ja' | 'ko' | 'en'

/** Count characters that belong to each script family. */
function detectDominantLanguage(text: string): DetectedLanguage {
  let cjCommon = 0 // CJK Unified ideographs (shared by zh/ja)
  let hiragana = 0
  let katakana = 0
  let hangul = 0
  let latin = 0

  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjCommon++
    } else if (code >= 0x3040 && code <= 0x309f) {
      hiragana++
    } else if (code >= 0x30a0 && code <= 0x30ff) {
      katakana++
    } else if (code >= 0xac00 && code <= 0xd7af) {
      hangul++
    } else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0xc0 && code <= 0x24f)
    ) {
      latin++
    }
  }

  const kana = hiragana + katakana
  // Japanese uses a mix of kanji + kana; if kana present it's almost certainly Japanese.
  if (kana > 0 && kana + cjCommon > latin && kana + cjCommon > hangul) return 'ja'
  if (hangul > cjCommon && hangul > latin) return 'ko'
  if (cjCommon > latin) return 'zh'
  return 'en'
}

interface LanguageLabels {
  name: string
  keyTopics: string
  keyDecisions: string
  discussionHighlights: string
  summaryInstruction: string
  actionItemsInstruction: string
}

const LANGUAGE_LABELS: Record<DetectedLanguage, LanguageLabels> = {
  zh: {
    name: '中文',
    keyTopics: '主要议题',
    keyDecisions: '关键决策',
    discussionHighlights: '讨论要点',
    summaryInstruction: '请用中文总结以下会议转录内容：',
    actionItemsInstruction: '请用中文从以下会议转录中提取待办事项：'
  },
  ja: {
    name: '日本語',
    keyTopics: '主なトピック',
    keyDecisions: '主な決定事項',
    discussionHighlights: '議論のハイライト',
    summaryInstruction: '以下の会議の文字起こしを日本語で要約してください：',
    actionItemsInstruction:
      '以下の会議の文字起こしからアクションアイテムを日本語で抽出してください：'
  },
  ko: {
    name: '한국어',
    keyTopics: '주요 주제',
    keyDecisions: '주요 결정 사항',
    discussionHighlights: '논의 하이라이트',
    summaryInstruction: '다음 회의 녹취록을 한국어로 요약해 주세요:',
    actionItemsInstruction: '다음 회의 녹취록에서 한국어로 액션 아이템을 추출해 주세요:'
  },
  en: {
    name: 'English',
    keyTopics: 'Key Topics',
    keyDecisions: 'Key Decisions',
    discussionHighlights: 'Discussion Highlights',
    summaryInstruction: 'Please summarize the following meeting transcript:',
    actionItemsInstruction: 'Extract action items from the following meeting transcript:'
  }
}

// Rough token estimation (Chinese ~1.5 tok/char, English ~1.3 tok/word)
function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length
  const nonCjk = text.length - cjkChars
  return Math.ceil(cjkChars * 1.5 + nonCjk * 0.4)
}

const MAX_INPUT_TOKENS = 100_000

function truncateToTokenBudget(text: string, budget: number): string {
  const tokens = estimateTokens(text)
  if (tokens <= budget) {
    return text
  }
  // Rough truncation: keep ratio of budget/tokens of the text
  const ratio = budget / tokens
  const charLimit = Math.floor(text.length * ratio * 0.95) // 5% margin
  return text.slice(0, charLimit) + '\n\n[... transcript truncated due to length ...]'
}

export async function generateSummary(
  segments: Array<{ speaker: number; source?: string | null; text: string }>
): Promise<MeetingSummaryResult> {
  const transcript = buildTranscriptText(segments)
  if (!transcript.trim()) {
    throw new Error('Transcript is empty, cannot generate summary.')
  }

  const truncated = truncateToTokenBudget(transcript, MAX_INPUT_TOKENS)
  const { model } = resolveEndpointAndKey()
  const lang = detectDominantLanguage(transcript)
  const l = LANGUAGE_LABELS[lang]

  const systemPrompt = [
    'You are a professional meeting-notes assistant.',
    'Given a meeting transcript, produce a clear, structured summary.',
    'The transcript may contain minor speech recognition errors — ignore them and focus on meaning.',
    `You MUST write your ENTIRE output in ${l.name}.`,
    '',
    'Format:',
    `## ${l.keyTopics}`,
    '- Bullet points of main topics discussed',
    '',
    `## ${l.keyDecisions}`,
    '- Bullet points of decisions made (if any)',
    '',
    `## ${l.discussionHighlights}`,
    '- Brief summary of important points, context, or outcomes',
    '',
    'Be concise. Do NOT fabricate information that is not in the transcript.'
  ].join('\n')

  const userPrompt = `${l.summaryInstruction}\n\n${truncated}`

  const summary = await callChatCompletion(systemPrompt, userPrompt)

  return {
    summary,
    generatedAt: new Date().toISOString(),
    model
  }
}

export async function generateActionItems(
  segments: Array<{ speaker: number; source?: string | null; text: string }>
): Promise<MeetingActionItemsResult> {
  const transcript = buildTranscriptText(segments)
  if (!transcript.trim()) {
    throw new Error('Transcript is empty, cannot extract action items.')
  }

  const truncated = truncateToTokenBudget(transcript, MAX_INPUT_TOKENS)
  const { model } = resolveEndpointAndKey()
  const lang = detectDominantLanguage(transcript)
  const l = LANGUAGE_LABELS[lang]

  const systemPrompt = [
    'You are a professional meeting-notes assistant.',
    'Given a meeting transcript, extract all explicit and clearly implied action items / to-dos.',
    'The transcript may contain minor speech recognition errors — ignore them.',
    '',
    'Rules:',
    '- Only include genuinely actionable tasks that were discussed or agreed upon.',
    '- If an assignee is mentioned or can be clearly inferred, include it.',
    '- Do NOT invent tasks that are not in the transcript.',
    `- The "content" field MUST be written in ${l.name}.`,
    '- Output strict JSON only, no markdown fences, no extra text.',
    '',
    'Output format (JSON array):',
    '[',
    '  { "content": "task description", "assignee": "person or null" },',
    '  ...',
    ']',
    '',
    'If there are no action items, return an empty array: []'
  ].join('\n')

  const userPrompt = `${l.actionItemsInstruction}\n\n${truncated}`

  const raw = await callChatCompletion(systemPrompt, userPrompt)
  const items = parseActionItemsResponse(raw)

  return {
    items,
    generatedAt: new Date().toISOString(),
    model
  }
}

function parseActionItemsResponse(raw: string): ActionItem[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array')
    }
    return parsed
      .map((item: unknown) => {
        if (typeof item === 'string') {
          return { content: item }
        }
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>
          return {
            content: String(obj.content || obj.task || obj.description || ''),
            assignee: obj.assignee ? String(obj.assignee) : undefined
          }
        }
        return { content: String(item) }
      })
      .filter((item) => item.content.trim().length > 0)
  } catch {
    // Fallback: treat each non-empty line as an action item
    return raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*•\d.)\]]+\s*/, '').trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ content: line }))
  }
}
