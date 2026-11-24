/**
 * Incremental line reader for append-only JSONL logs.
 *
 * First read starts inside the file (the last `initialBytes`) instead of
 * replaying years of history; later reads continue from the stored offset and
 * keep an incomplete trailing line in a remainder buffer. Truncation or file
 * replacement resets the entry, so log rotation cannot wedge the reader.
 */

import fs from 'node:fs/promises'

export class TailReader {
  constructor() {
    /** @type {Map<string, {offset: number, ino: number, remainder: string}>} */
    this.entries = new Map()
  }

  /**
   * Read newly appended complete lines from one file.
   *
   * @param {string} file
   * @param {object} [options]
   * @param {number} [options.initialBytes] window read on first sight
   * @param {number} [options.maxBytes] hard cap for one read
   * @returns {Promise<{lines: string[], reset: boolean, size: number}>}
   */
  async read(file, options = {}) {
    const { initialBytes = 96 * 1024, maxBytes = 1024 * 1024 } = options
    let st
    try {
      st = await fs.stat(file)
    } catch {
      return { lines: [], reset: false, size: 0 }
    }
    if (!st.isFile()) return { lines: [], reset: false, size: 0 }

    let entry = this.entries.get(file)
    let reset = false
    let start
    if (!entry || st.size < entry.offset || (entry.ino !== 0 && entry.ino !== st.ino)) {
      reset = true
      start = Math.max(0, st.size - initialBytes)
      entry = { offset: start, ino: st.ino, remainder: '' }
      this.entries.set(file, entry)
    } else {
      start = entry.offset
    }
    if (st.size <= start) return { lines: [], reset, size: st.size }

    const end = Math.min(st.size, start + maxBytes)
    const length = end - start
    const buffer = Buffer.alloc(length)
    let handle
    try {
      handle = await fs.open(file, 'r')
      await handle.read(buffer, 0, length, start)
    } catch {
      return { lines: [], reset, size: st.size }
    } finally {
      await handle?.close().catch(() => {})
    }

    let text = entry.remainder + buffer.toString('utf8')
    entry.remainder = ''
    const complete = end >= st.size
    const parts = text.split('\n')
    if (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop()
    } else if (!complete && parts.length > 0) {
      entry.remainder = parts.pop() ?? ''
    }
    if (reset && start > 0 && parts.length > 0) parts.shift()
    entry.offset = end
    return { lines: parts, reset, size: st.size }
  }

  /** Drop all stored offsets, e.g. when monitoring is reconfigured. */
  clear() {
    this.entries.clear()
  }
}

/** Parse one JSONL chunk, skipping blank and malformed lines. */
export function parseJsonLines(lines, onLine) {
  for (const line of lines) {
    const text = line.trim()
    if (text === '') continue
    let value
    try {
      value = JSON.parse(text)
    } catch {
      continue
    }
    onLine(value)
  }
}
