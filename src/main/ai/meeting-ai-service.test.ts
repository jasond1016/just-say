import { describe, it, expect } from 'vitest'

// Test the parseActionItemsResponse logic by importing the module internals.
// Since parseActionItemsResponse is private, we test via generateActionItems's
// parsing behavior indirectly. Here we test the JSON parsing patterns directly.

function parseActionItemsResponse(raw: string): Array<{ content: string; assignee?: string }> {
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
    return raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*•\d.)\]]+\s*/, '').trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ content: line }))
  }
}

// Mirror the detection logic from meeting-ai-service.ts for unit testing.
type DetectedLanguage = 'zh' | 'ja' | 'ko' | 'en'

function detectDominantLanguage(text: string): DetectedLanguage {
  let cjCommon = 0
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
  if (kana > 0 && kana + cjCommon > latin && kana + cjCommon > hangul) return 'ja'
  if (hangul > cjCommon && hangul > latin) return 'ko'
  if (cjCommon > latin) return 'zh'
  return 'en'
}

describe('detectDominantLanguage', () => {
  it('detects Chinese text', () => {
    expect(detectDominantLanguage('今天的会议讨论了季度目标和预算分配')).toBe('zh')
  })

  it('detects Japanese text with kanji and kana', () => {
    expect(detectDominantLanguage('今日の会議ではプロジェクトの進捗を確認しました')).toBe('ja')
  })

  it('detects Japanese even with mostly kanji when kana is present', () => {
    expect(detectDominantLanguage('皆さん、お元気ですか？今日は大事な話があります')).toBe('ja')
  })

  it('detects Korean text', () => {
    expect(detectDominantLanguage('오늘 회의에서 프로젝트 진행 상황을 확인했습니다')).toBe('ko')
  })

  it('detects English text', () => {
    expect(
      detectDominantLanguage('Today we discussed the quarterly goals and budget allocation')
    ).toBe('en')
  })

  it('detects Chinese when mixed with some English terms', () => {
    expect(
      detectDominantLanguage('我们需要把这个 API 的 endpoint 改一下，然后部署到生产环境')
    ).toBe('zh')
  })

  it('defaults to English for empty or symbol-only text', () => {
    expect(detectDominantLanguage('')).toBe('en')
    expect(detectDominantLanguage('123 !@# ...')).toBe('en')
  })
})

describe('parseActionItemsResponse', () => {
  it('parses clean JSON array with content and assignee', () => {
    const input = JSON.stringify([
      { content: 'Finish the report', assignee: 'Alice' },
      { content: 'Review PR #42' }
    ])
    const result = parseActionItemsResponse(input)
    expect(result).toEqual([
      { content: 'Finish the report', assignee: 'Alice' },
      { content: 'Review PR #42', assignee: undefined }
    ])
  })

  it('parses JSON wrapped in markdown fences', () => {
    const input = '```json\n[{"content":"Task A"},{"content":"Task B","assignee":"Bob"}]\n```'
    const result = parseActionItemsResponse(input)
    expect(result).toEqual([
      { content: 'Task A', assignee: undefined },
      { content: 'Task B', assignee: 'Bob' }
    ])
  })

  it('parses array of plain strings', () => {
    const input = JSON.stringify(['Do X', 'Do Y'])
    const result = parseActionItemsResponse(input)
    expect(result).toEqual([{ content: 'Do X' }, { content: 'Do Y' }])
  })

  it('falls back to line-based parsing for non-JSON', () => {
    const input = '- Finish the report\n- Review PR #42\n- Deploy to staging'
    const result = parseActionItemsResponse(input)
    expect(result).toEqual([
      { content: 'Finish the report' },
      { content: 'Review PR #42' },
      { content: 'Deploy to staging' }
    ])
  })

  it('filters out empty content entries', () => {
    const input = JSON.stringify([{ content: 'Real task' }, { content: '' }, { content: '  ' }])
    const result = parseActionItemsResponse(input)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Real task')
  })

  it('handles "task" and "description" as content aliases', () => {
    const input = JSON.stringify([
      { task: 'From task field' },
      { description: 'From description field' }
    ])
    const result = parseActionItemsResponse(input)
    expect(result).toEqual([
      { content: 'From task field', assignee: undefined },
      { content: 'From description field', assignee: undefined }
    ])
  })

  it('returns empty array for empty JSON array', () => {
    const result = parseActionItemsResponse('[]')
    expect(result).toEqual([])
  })
})
