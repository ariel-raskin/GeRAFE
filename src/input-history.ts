export type InputHistory = Record<string, string[]>

export function parseInputHistory(raw: string | null): InputHistory {
  try {
    const value = JSON.parse(raw ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([key, entries]) => Array.isArray(entries)
      ? [[key, entries.filter((entry): entry is string => typeof entry === 'string').slice(0, 20)]] : []))
  } catch { return {} }
}

export function addInputHistory(history: InputHistory, key: string, rawValue: string): InputHistory {
  const value = rawValue.trim()
  if (!value) return history
  return {
    ...history,
    [key]: [value, ...(history[key] ?? []).filter((entry) => entry.toLocaleLowerCase() !== value.toLocaleLowerCase())].slice(0, 20),
  }
}

export function matchingInputHistory(history: InputHistory, key: string, rawQuery: string): string[] {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return []
  return (history[key] ?? [])
    .filter((entry) => entry.toLocaleLowerCase().includes(query) && entry.toLocaleLowerCase() !== query)
    .slice(0, 8)
}
