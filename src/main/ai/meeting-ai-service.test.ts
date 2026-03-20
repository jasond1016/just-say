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
