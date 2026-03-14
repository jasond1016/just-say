export interface TextCorrectionEntry {
  target: string
  aliases?: string[]
}

export interface TextCorrectionConfig {
  enabled?: boolean
  entries?: TextCorrectionEntry[]
}

export function normalizeTextCorrectionConfig(
  config?: TextCorrectionConfig | null
): TextCorrectionConfig | undefined {
  if (!config || config.enabled === false || !Array.isArray(config.entries)) {
    return undefined
  }

  const entries: TextCorrectionEntry[] = []
  for (const entry of config.entries) {
    const target = typeof entry?.target === 'string' ? entry.target.trim() : ''
    if (!target) {
      continue
    }

    const aliases = Array.isArray(entry.aliases)
      ? Array.from(
          new Set(
            entry.aliases
              .map((alias) => (typeof alias === 'string' ? alias.trim() : ''))
              .filter((alias) => alias && alias !== target)
          )
        )
      : []

    if (aliases.length === 0) {
      continue
    }

    entries.push({
      target,
      aliases
    })
  }

  if (entries.length === 0) {
    return undefined
  }

  return {
    enabled: true,
    entries
  }
}

export function serializeTextCorrectionConfig(
  config?: TextCorrectionConfig | null
): string | undefined {
  const normalized = normalizeTextCorrectionConfig(config)
  if (!normalized) {
    return undefined
  }

  return JSON.stringify(normalized)
}
