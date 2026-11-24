/**
 * Text hygiene shared by every adapter: one-line summaries, secret redaction,
 * timestamps, stable identifiers, and provider-neutral content extraction.
 */

import crypto from 'node:crypto'

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***'],
  [/-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g, '[private key]'],
  [/\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b(\s*[:=]\s*)['"]?[^\s'"]{6,}/gi, '$1$2***'],
]

/** Collapse whitespace so a summary always occupies one line. */
export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Remove recognizable credentials before text reaches storage or the UI. */
export function redact(value) {
  let text = String(value ?? '')
  if (text.length > 20000) text = text.slice(0, 20000)
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  return text
}

/** One-line, redacted, length-bounded summary text. */
export function summarize(value, max = 180) {
  const text = oneLine(redact(value))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Parse an ISO string, epoch seconds, or epoch milliseconds. */
export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value !== '') {
    const numeric = Number(value)
    if (!Number.isNaN(numeric) && numeric > 1e9 && numeric < 1e13) {
      return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric)
    }
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

/** ISO string for a timestamp, or null when unknown. */
export function iso(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null
}

/** Short stable id from arbitrary parts. */
export function stableId(...parts) {
  return crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex').slice(0, 16)
}

/**
 * Extract readable text from provider content blocks.
 * Handles plain strings, Codex `input_text`/`output_text`, Claude `text`,
 * and tool markers.
 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.content === 'string') parts.push(block.content)
    else if (block.type === 'tool_use') parts.push(`[tool ${block.name ?? 'tool'}]`)
    else if (block.type === 'tool_result') parts.push('[tool result]')
  }
  return parts.join(' ').trim()
}

/** Whether a user message is really agent boilerplate, not a title. */
export function isBoilerplatePrompt(text) {
  const value = oneLine(text)
  if (value === '') return true
  if (value.startsWith('<')) return true
  if (/^\[?@/.test(value)) return true
  if (/^#\s*(applications|environment)\b/i.test(value)) return true
  if (/^\[Request interrupted by user/i.test(value)) return true
  return false
}

/** First line that looks like a human prompt, used as a fallback title. */
export function titleFromPrompt(text) {
  const summary = summarize(text, 90)
  return summary === '' ? '' : summary
}
