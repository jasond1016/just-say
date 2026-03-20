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

  const systemPrompt = [
    'You are a professional meeting-notes assistant.',
    'Given a meeting transcript, produce a clear, structured summary.',
    'The transcript may contain minor speech recognition errors — ignore them and focus on meaning.',
    'Output in the SAME language as the majority of the transcript.',
    '',
    'Format:',
    '## Key Topics',
    '- Bullet points of main topics discussed',
    '',
    '## Key Decisions',
    '- Bullet points of decisions made (if any)',
    '',
    '## Discussion Highlights',
    '- Brief summary of important points, context, or outcomes',
    '',
    'Be concise. Do NOT fabricate information that is not in the transcript.'
  ].join('\n')

  const userPrompt = `Please summarize the following meeting transcript:\n\n${truncated}`

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

  const systemPrompt = [
    'You are a professional meeting-notes assistant.',
    'Given a meeting transcript, extract all explicit and clearly implied action items / to-dos.',
    'The transcript may contain minor speech recognition errors — ignore them.',
    '',
    'Rules:',
    '- Only include genuinely actionable tasks that were discussed or agreed upon.',
    '- If an assignee is mentioned or can be clearly inferred, include it.',
    '- Do NOT invent tasks that are not in the transcript.',
    '- Output strict JSON only, no markdown fences, no extra text.',
    '',
    'Output format (JSON array):',
    '[',
    '  { "content": "task description", "assignee": "person or null" },',
    '  ...',
    ']',
    '',
    'If there are no action items, return an empty array: []',
    'The "content" field should be in the SAME language as the transcript.'
  ].join('\n')

  const userPrompt = `Extract action items from the following meeting transcript:\n\n${truncated}`

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
