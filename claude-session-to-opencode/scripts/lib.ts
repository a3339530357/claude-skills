/**
 * Shared helpers for reading Claude Code transcripts and minting opencode IDs.
 *
 * Claude Code stores one JSONL file per session under ~/.claude/projects/<encoded-cwd>/.
 * Every line is an event; conversational events (`user` / `assistant`) form a linked
 * list through `parentUuid`, which is how Claude Code models edits and retries: a
 * retried turn gets a new uuid pointing at the same parent, leaving the abandoned
 * branch in the file. Reconstructing "the conversation as it stands" therefore means
 * walking parents backwards from the newest line, not reading the file top to bottom.
 */

import { createHash } from "crypto"
import { readFileSync } from "fs"

export interface Line {
  index: number
  type: string
  subtype?: string
  uuid?: string
  parentUuid?: string | null
  logicalParentUuid?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  isApiErrorMessage?: boolean
  isAbortedMidStream?: boolean
  interruptedMessageId?: string
  cwd?: string
  sessionId?: string
  version?: string
  gitBranch?: string
  promptSource?: string
  origin?: { kind?: string }
  attachment?: { type?: string; content?: unknown; stdout?: string; [key: string]: unknown }
  content?: unknown
  toolUseResult?: unknown
  aiTitle?: string
  message?: {
    id?: string
    role?: string
    model?: string
    stop_reason?: string | null
    content?: unknown
    usage?: Record<string, unknown>
  }
  [key: string]: unknown
}

export interface LoadResult {
  lines: Line[]
  /** Lines that failed to parse, kept so callers can report instead of silently dropping. */
  corrupt: { index: number; preview: string }[]
}

export function loadJsonl(file: string): LoadResult {
  const lines: Line[] = []
  const corrupt: { index: number; preview: string }[] = []
  const raw = readFileSync(file, "utf8").split("\n")
  raw.forEach((text, index) => {
    if (!text.trim()) return
    // A partially flushed final line is normal for a live session; report, never throw.
    try {
      lines.push({ ...(JSON.parse(text) as Record<string, unknown>), index } as Line)
    } catch {
      corrupt.push({ index, preview: text.slice(0, 120) })
    }
  })
  return { lines, corrupt }
}

/**
 * The set of lines reachable by walking parents from the newest line that has a uuid.
 * `logicalParentUuid` is the fallback Claude Code writes across a compaction boundary.
 */
export function activeChain(lines: Line[]) {
  const byUuid = new Map<string, Line>()
  for (const line of lines) if (line.uuid) byUuid.set(line.uuid, line)
  const tail = lines.filter((line) => line.uuid).at(-1)
  const keep = new Set<string>()
  let cursor = tail
  while (cursor?.uuid && !keep.has(cursor.uuid)) {
    keep.add(cursor.uuid)
    const parent = cursor.parentUuid ?? cursor.logicalParentUuid
    cursor = parent ? byUuid.get(parent) : undefined
  }
  return { keep, chain: lines.filter((line) => line.uuid && keep.has(line.uuid)) }
}

/**
 * opencode ids are `<prefix>_<12 hex><14 base62>`, where the hex is a big-endian encoding of
 * `timestamp * 0x1000 + counter`, bitwise-inverted for descending order (see
 * packages/schema/src/identifier.ts). Sessions are descending so the newest sorts first; messages
 * and parts are ascending, and opencode depends on that: `MessageV2.latest` picks the newest turn
 * by max id, and parts are ordered by id alone with no sequence column. A converted transcript
 * whose ids don't ascend imports fine and then binds the wrong "current" message on resume.
 *
 * The 14 trailing characters come from a hash of a seed rather than randomness, which is what makes
 * conversion idempotent: rerunning on the same transcript reproduces every id, so `opencode import`
 * updates the existing rows instead of creating a second copy of the session.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function stableSuffix(seed: string) {
  const digest = createHash("sha1").update(seed).digest()
  return Array.from(digest.subarray(0, 14), (byte) => BASE62[byte % 62]).join("")
}

export function stableID(prefix: "ses" | "msg" | "prt", timestamp: number, seed: string, order: number) {
  // The counter occupies the low 12 bits, so it wraps at 0xfff; ordering within one millisecond
  // then depends on the timestamp advancing, which `monotonic()` in convert.ts guarantees.
  const current = BigInt(timestamp) * 0x1000n + BigInt((order % 0xfff) + 1)
  const value = prefix === "ses" ? ~current : current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  return `${prefix}_${time}${stableSuffix(seed)}`
}

export function textOf(line: Line) {
  const content = line.message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return (content as { type?: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
}

/**
 * The first thing a human actually asked, used to title a session when Claude Code never wrote an
 * `ai-title` line. Worth the filtering: the raw first user line is often a slash-command envelope
 * (`<command-name>/clear</command-name>`) or injected context, which makes for a useless title.
 * A command's real payload lives in `<command-args>`, so that counts as a prompt.
 */
export function firstPrompt(lines: Line[]) {
  for (const line of lines) {
    if (line.type !== "user" || line.isMeta) continue
    const text = textOf(line).trim()
    if (!text) continue
    if (text.startsWith("<local-command-caveat>")) continue
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
    if (args?.[1]?.trim()) return args[1].trim()
    if (text.startsWith("<command-")) continue
    return text
  }
  return ""
}

export function oneline(value: string, width = 70) {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > width ? flat.slice(0, width - 1) + "…" : flat
}
