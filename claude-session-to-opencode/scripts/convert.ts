#!/usr/bin/env bun
/**
 * Convert one Claude Code session transcript into opencode's session export format.
 *
 *   bun convert.ts <session.jsonl> [--out <file.json>] [options]
 *
 * The output is the exact shape `opencode import` consumes ({ info, messages: [{ info, parts }] }),
 * which is why this script never touches opencode's SQLite database directly: `opencode import`
 * decodes every record through opencode's own Effect schemas and binds the session to the right
 * project/directory from its working directory. Writing rows by hand would skip that validation
 * and silently produce sessions the UI can't render.
 *
 * Options:
 *   --out <file>            Where to write the JSON (default: ~/.local/share/opencode/claude-import/)
 *   --provider <id>         providerID to record (default: resolved from the local model catalog)
 *   --model <id>            modelID override (default: the model named in the transcript)
 *   --agent <name>          agent recorded on messages (default: build)
 *   --version <string>      version stamped on the session (default: the Claude Code version)
 *   --all-branches          Convert every line, not just the active parent chain
 *   --attachments <mode>    full (default) | summary — how much injected context to carry
 *   --report <file>         Write a JSON conversion report (counts, downgrades, warnings)
 *   --no-verify-model       Skip the `opencode models` lookup (offline or bulk runs)
 *
 * Exit codes: 0 ok, 1 bad arguments or unreadable input, 2 the transcript holds no conversation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import path from "path"
import { activeChain, firstPrompt, loadJsonl, oneline, stableID, type Line } from "./lib"

const argv = process.argv.slice(2)
const VALUED = new Set(["out", "provider", "model", "agent", "version", "attachments", "report"])

const positionals: string[] = []
const flags = new Map<string, string>()
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!
  if (!arg.startsWith("--")) {
    positionals.push(arg)
    continue
  }
  const name = arg.slice(2)
  if (VALUED.has(name)) {
    flags.set(name, argv[++index] ?? "")
    continue
  }
  flags.set(name, "true")
}

function flag(name: string, fallback?: string) {
  return flags.get(name) ?? fallback
}

const USAGE = [
  "usage: bun convert.ts <session.jsonl> [options]",
  "",
  "  --out <file>          output path (default: ~/.local/share/opencode/claude-import/)",
  "  --provider <id>       providerID to record (default: resolved from the local model catalog)",
  "  --model <id>          modelID override (default: the model named in the transcript)",
  "  --agent <name>        agent recorded on messages (default: build)",
  "  --version <string>    version stamped on the session (default: the Claude Code version)",
  "  --all-branches        convert every line, not just the active parent chain",
  "  --attachments <mode>  full (default) | summary — how much injected context to carry",
  "  --report <file>       write a JSON conversion report",
  "  --no-verify-model     skip the `opencode models` lookup",
].join("\n")

if (flags.has("help") || flags.has("h")) {
  console.log(USAGE)
  process.exit(0)
}

const source = positionals[0]
if (!source) {
  console.error(USAGE)
  process.exit(1)
}
if (!existsSync(source)) {
  console.error(`Transcript not found: ${source}`)
  console.error(`Run "bun list.ts" to see the available projects and sessions.`)
  process.exit(1)
}

const attachments = flag("attachments", "full")!
if (attachments !== "full" && attachments !== "summary") {
  console.error(`--attachments must be "full" or "summary", got "${attachments}"`)
  process.exit(1)
}

/**
 * Default output lands in opencode's own data directory rather than next to the transcript: the
 * Claude Code history directory stays untouched, and the converted payload sits somewhere durable
 * (not a temp dir) so a failed import can be retried or inspected later.
 */
function defaultOut() {
  const base = path.join(
    process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"),
    "opencode",
    "claude-import",
  )
  mkdirSync(base, { recursive: true })
  return path.join(base, path.basename(source, ".jsonl") + ".opencode.json")
}

const options = {
  out: flag("out") ?? defaultOut(),
  provider: flag("provider"),
  model: flag("model"),
  agent: flag("agent", "build")!,
  version: flag("version"),
  allBranches: flags.has("all-branches"),
  attachments,
  report: flag("report"),
}

const warnings: string[] = []
const notes: string[] = []
const downgrades = new Map<string, number>()
function downgrade(kind: string) {
  downgrades.set(kind, (downgrades.get(kind) ?? 0) + 1)
}

/* ------------------------------------------------------------------ ids & time */

/**
 * opencode orders messages and parts by id, and 40 of the transcripts in this corpus have
 * timestamps that step backwards (a compaction can rewrite a turn minutes after the fact).
 * Clamping to a running maximum keeps generated ids ascending in transcript order, which is
 * what `MessageV2.latest` and the part queries rely on. Called once per line, so every line also
 * ends up with a strictly greater timestamp than the line before it.
 */
let clock = 0
function monotonic(timestamp?: string) {
  const parsed = timestamp ? Date.parse(timestamp) : NaN
  clock = Math.max(clock + 1, Number.isNaN(parsed) ? 0 : parsed)
  return clock
}

/**
 * The low 12 bits of an id are a counter that breaks ties when two ids share a timestamp. Both
 * counters below are derived from local, per-message facts rather than a running global sequence,
 * because a global one made ids depend on how many records came before — convert the same
 * transcript with `--all-branches` and an untouched message would get a different id, so
 * re-importing added a second copy of it instead of updating the existing row.
 *
 * Messages: `monotonic` gives each line a distinct ascending timestamp, so a counter is only needed
 * for the one case where two messages share a timestamp — a synthesized user parent minted
 * alongside its assistant turn. Ordering user before assistant is enough.
 *
 * Parts: `message.parts.length` is already a per-message ascending counter, and parts only need to
 * ascend within their own message (opencode indexes them as `(message_id, id)`).
 */
function messageID(seed: string, time: number, role: "user" | "assistant") {
  return stableID("msg", time, seed, role === "user" ? 0 : 1)
}
function partID(seed: string, time: number, position: number) {
  return stableID("prt", time, seed, position)
}

/* ------------------------------------------------------------------ tool naming */

/**
 * Claude Code names tools in PascalCase; opencode registers lowercase ids (see
 * packages/opencode/src/tool/registry.ts). Mapping them means a converted transcript renders
 * with opencode's real tool renderers instead of the generic fallback. Unknown names — MCP
 * tools, plugin tools — pass through untouched, because guessing would be worse than showing
 * the original name.
 */
const TOOL_NAMES: Record<string, string> = {
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  PowerShell: "bash",
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  NotebookEdit: "edit",
  MultiEdit: "edit",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
  TodoWrite: "todowrite",
  Task: "task",
  Agent: "task",
  Skill: "skill",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  AskUserQuestion: "question",
  ExitPlanMode: "plan_exit",
}

/** opencode's schemas use camelCase where Claude Code uses snake_case. */
const TOOL_INPUT_KEYS: Record<string, string> = {
  file_path: "filePath",
  old_string: "oldString",
  new_string: "newString",
  replace_all: "replaceAll",
  notebook_path: "filePath",
  new_source: "newString",
  subagent_type: "subagent_type",
}

function toolName(name: string) {
  const mapped = TOOL_NAMES[name]
  if (!mapped) downgrade(`tool-name-passthrough:${name}`)
  return mapped ?? name
}

function toolInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [TOOL_INPUT_KEYS[key] ?? key, item]),
  )
}

/* ------------------------------------------------------------------ content blocks */

interface Block {
  type: string
  [key: string]: unknown
}

function blocks(line: Line): Block[] {
  const content = line.message?.content
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content as Block[]
}

/** Flatten a tool_result payload into the single output string opencode's ToolStateCompleted wants. */
function resultText(block: Block): { text: string; images: { mime: string; url: string }[] } {
  const images: { mime: string; url: string }[] = []
  const content = block.content
  if (typeof content === "string") return { text: content, images }
  if (!Array.isArray(content)) return { text: content === undefined ? "" : JSON.stringify(content), images }
  const parts: string[] = []
  for (const item of content as Block[]) {
    if (item.type === "text") {
      parts.push(String(item.text ?? ""))
      continue
    }
    if (item.type === "image") {
      const source = item.source as { media_type?: string; data?: string; url?: string } | undefined
      const mime = source?.media_type ?? "image/png"
      const url = source?.data ? `data:${mime};base64,${source.data}` : (source?.url ?? "")
      if (url) images.push({ mime, url })
      parts.push(`[image ${mime}]`)
      continue
    }
    // tool_reference and any future block kind: keep the raw JSON rather than drop data.
    downgrade(`tool-result-block:${item.type}`)
    parts.push(JSON.stringify(item))
  }
  return { text: parts.join("\n"), images }
}

/**
 * Injected context (hook output, skill listings, task reminders) lives on `attachment` lines in
 * Claude Code. opencode has no equivalent record, so they become synthetic+ignored text parts on
 * the following user message: `synthetic` keeps them out of the prompt-history UI and `ignored`
 * keeps them out of what gets replayed to the model, so resuming the session doesn't re-inject a
 * stale environment. Setting `--attachments summary` records only a one-line marker instead.
 */
function attachmentText(line: Line) {
  const attachment = line.attachment ?? {}
  const kind = String(attachment.type ?? "unknown")
  if (options.attachments === "summary") return `[claude-code attachment: ${kind}]`
  const body =
    typeof attachment.content === "string" && attachment.content.trim()
      ? attachment.content
      : typeof attachment.stdout === "string" && attachment.stdout.trim()
        ? attachment.stdout
        : JSON.stringify(attachment)
  return `[claude-code attachment: ${kind}]\n${body}`
}

/* ------------------------------------------------------------------ load & select */

const loaded = loadJsonl(source)
if (loaded.corrupt.length) {
  warnings.push(`${loaded.corrupt.length} unparsable line(s) skipped: ${loaded.corrupt.map((c) => c.index).join(", ")}`)
}
if (!loaded.lines.length) {
  console.error(`No usable records in ${source}`)
  process.exit(1)
}

const selected = options.allBranches ? loaded.lines : activeChain(loaded.lines).chain
const kept = new Set(selected)
const abandoned = loaded.lines.filter(
  (line) => (line.type === "user" || line.type === "assistant") && !kept.has(line),
).length
if (abandoned && !options.allBranches) {
  warnings.push(
    `${abandoned} conversational line(s) are on abandoned branches (retries/edits) and were skipped; rerun with --all-branches to include them`,
  )
}

const sessionUuid = loaded.lines.find((line) => line.sessionId)?.sessionId ?? path.basename(source, ".jsonl")
const cwd = loaded.lines.find((line) => typeof line.cwd === "string")?.cwd ?? process.cwd()
const claudeVersion = loaded.lines.filter((line) => line.version).at(-1)?.version
const aiTitle = loaded.lines.filter((line) => line.type === "ai-title").at(-1)?.aiTitle

/**
 * Model identity plays two different roles, so it is resolved two different ways.
 *
 * On an assistant message, `providerID`/`modelID` is a historical record of what produced that
 * text — 19 of the 252 transcripts here switch models mid-session, so each turn keeps its own.
 * On the session (and on user messages) the model is forward-looking configuration: opencode's
 * `currentModel` reads `session.model` first when you continue a session, and a name the local
 * install doesn't serve makes that lookup fail. So the session-level model always resolves to
 * something this machine can actually run, even when the transcript names a model it can't.
 *
 * Claude Code records a bare model name (`claude-opus-5`, `glm-5.2`) with no provider, which is
 * why we ask the local install which providers serve it rather than assuming "anthropic": these
 * transcripts routinely name third-party models reached through a proxy.
 */
function catalog() {
  if (flags.has("no-verify-model")) return undefined
  const result = Bun.spawnSync(["opencode", "models"])
  if (!result.success) return undefined
  const entries = result.stdout
    .toString()
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("/"))
  return entries.length ? entries : undefined
}

const available = catalog()
if (!available && !flags.has("no-verify-model")) {
  warnings.push(`Could not read the opencode model list; provider ids are guessed from the model name`)
}

function providersFor(name: string) {
  return (available ?? []).filter((entry) => entry.slice(entry.indexOf("/") + 1) === name)
}

function guessProvider(name: string) {
  return options.provider ?? (name.startsWith("claude-") ? "anthropic" : "opencode")
}

const historyCache = new Map<string, { providerID: string; modelID: string }>()

/**
 * What actually produced a given assistant turn. Keeps the transcript's model name verbatim, even
 * when `--model` asks the session to continue with something else — and that difference is load
 * bearing: opencode compares the session model against each assistant message and, when they
 * differ, replays reasoning as plain text instead of as a signed thinking block
 * (`message-v2.ts:362-376`). Rewriting history to match the new model would defeat that and send
 * signatures to a provider that can't validate them.
 */
function historyModel(name: string | undefined) {
  const wanted = name && name !== "<synthetic>" ? name : transcriptModel
  if (!wanted) return forwardModel
  const cached = historyCache.get(wanted)
  if (cached) return cached
  const matches = providersFor(wanted)
  const chosen = options.provider
    ? { providerID: options.provider, modelID: wanted }
    : matches.length
      ? { providerID: matches[0]!.slice(0, matches[0]!.indexOf("/")), modelID: wanted }
      : { providerID: guessProvider(wanted), modelID: wanted }
  if (matches.length > 1) notes.push(`Model "${wanted}" is served by ${matches.join(", ")}; used ${matches[0]}`)
  historyCache.set(wanted, chosen)
  return chosen
}

/** opencode's own fallback order when no model is configured: most recent, then anything available. */
function localDefault() {
  const recent = ((): { providerID: string; modelID: string }[] => {
    const file = path.join(
      process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"),
      "opencode",
      "model.json",
    )
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { recent?: { providerID?: string; modelID?: string }[] }
    return (parsed.recent ?? []).flatMap((item) =>
      item.providerID && item.modelID ? [{ providerID: item.providerID, modelID: item.modelID }] : [],
    )
  })()
  for (const entry of recent) {
    if (!available || available.includes(`${entry.providerID}/${entry.modelID}`)) return entry
  }
  const first = available?.[0]
  if (first) return { providerID: first.slice(0, first.indexOf("/")), modelID: first.slice(first.indexOf("/") + 1) }
  return undefined
}

/** The last real model in the transcript — what a resume should continue with, if it exists here. */
const transcriptModel = loaded.lines
  .filter((line) => line.type === "assistant" && line.message?.model && line.message.model !== "<synthetic>")
  .at(-1)?.message?.model

const forwardModel = (() => {
  // An explicit --model/--provider is the user's decision; honour it even if this install can't
  // serve it (they may be importing on one machine and continuing on another) and just warn.
  if (options.model || options.provider) {
    const name = options.model ?? transcriptModel
    if (!name) {
      warnings.push(`--provider was given without --model and the transcript names none; recorded "unknown"`)
      return { providerID: options.provider!, modelID: "unknown" }
    }
    const matches = providersFor(name)
    const chosen = options.provider ?? (matches[0]?.slice(0, matches[0].indexOf("/")) ?? guessProvider(name))
    if (available && !available.includes(`${chosen}/${name}`)) {
      warnings.push(`${chosen}/${name} is not available in this opencode install; recorded it as requested`)
    }
    return { providerID: chosen, modelID: name }
  }

  if (transcriptModel && (!available || providersFor(transcriptModel).length)) {
    const matches = providersFor(transcriptModel)
    return matches.length
      ? { providerID: matches[0]!.slice(0, matches[0]!.indexOf("/")), modelID: transcriptModel }
      : { providerID: guessProvider(transcriptModel), modelID: transcriptModel }
  }

  const fallback = localDefault()
  if (!fallback) {
    warnings.push(`No usable model found; recorded "unknown" — pass --provider/--model before importing`)
    return { providerID: "anthropic", modelID: "unknown" }
  }
  warnings.push(
    transcriptModel
      ? `Model "${transcriptModel}" is not available in this opencode install; the session will continue with ${fallback.providerID}/${fallback.modelID} (assistant messages keep the original name)`
      : `No model recorded in the transcript; the session will use ${fallback.providerID}/${fallback.modelID}`,
  )
  return fallback
})()

const modelID = forwardModel.modelID
const providerID = forwardModel.providerID

/* ------------------------------------------------------------------ assemble */

type Part = Record<string, unknown>
type Message = { info: Record<string, unknown>; parts: Part[] }

/**
 * The session id is derived from the Claude Code session uuid, so converting the same transcript
 * twice produces the same id and `opencode import` updates the existing row instead of adding a
 * duplicate. `stableID` still puts a descending time prefix in front so the session sorts by age.
 */
const firstTime = Date.parse(loaded.lines.find((line) => line.timestamp)?.timestamp ?? "") || Date.now()
const sessionID = stableID("ses", firstTime, `claude-session:${sessionUuid}`, 0)

const messages: Message[] = []
const stats = { user: 0, assistant: 0, text: 0, reasoning: 0, tool: 0, file: 0, attachment: 0, orphanResults: 0 }

/** Injected-context text waiting to ride along on the next user message. */
let pendingAttachments: string[] = []
/** The most recent user message id — every assistant message needs it as `parentID`. */
let parentID: string | undefined
/**
 * Tool parts keyed by Claude Code tool_use id, so a later tool_result line can complete them in
 * place. The stored object is the same reference that was pushed onto its message, which is what
 * makes cross-line mutation work — and why `attach` mutates instead of copying.
 */
const pendingTools = new Map<string, { part: Part; start: number }>()

/**
 * Stamps ids onto parts as they are attached, then pushes the same object references so a tool part
 * can still be promoted from running to completed when its result line arrives later.
 *
 * Minting the id here rather than where the part is built is the point: part ids double as the sort
 * key (opencode orders parts by id alone — `part_message_id_id_idx`, with no sequence column), so
 * they have to ascend in insertion order. Building them at construction time made that depend on
 * evaluation order, and injected-context parts — built last but inserted first — ended up sorting
 * after the parts they precede.
 */
function attach(message: Message, parts: Part[], time: number) {
  for (const part of parts) {
    const seed = String(part.seed)
    delete part.seed
    part.id = partID(seed, time, message.parts.length)
    part.sessionID = sessionID
    part.messageID = message.info.id
    message.parts.push(part)
  }
}

function drainAttachments(): Part[] {
  // Seed from the content plus its position in this batch, not from a running total: seeds must
  // depend only on the record itself, or ids shift when a different set of lines is selected.
  const parts = pendingAttachments.map((text, index) => ({
    seed: `attach:${index}:${text}`,
    type: "text",
    text,
    // synthetic keeps these out of the prompt-history UI; ignored keeps them out of the replayed
    // context, so resuming the session doesn't re-inject a stale environment snapshot.
    synthetic: true,
    ignored: true,
  }))
  stats.attachment += parts.length
  pendingAttachments = []
  return parts
}

function pushUser(time: number, seed: string, parts: Part[]) {
  const id = messageID(seed, time, "user")
  const message: Message = {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: time },
      agent: options.agent,
      model: { providerID, modelID },
    },
    parts: [],
  }
  attach(message, [...drainAttachments(), ...parts], time)
  messages.push(message)
  parentID = id
  stats.user++
  return message
}

/**
 * Claude Code splits one model turn across several JSONL lines that share `message.id`, with the
 * tool results interleaved as `user` lines as each tool finishes. opencode models the same thing
 * as a single assistant message holding step/text/reasoning/tool parts, so we group by
 * `message.id` and let tool results complete the tool parts already in that group.
 */
let current: { apiID: string; message: Message; start: number; end: number; line: Line } | undefined

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool-calls",
  max_tokens: "length",
  pause_turn: "other",
  refusal: "other",
}

function usageOf(line: Line) {
  const usage = (line.message?.usage ?? {}) as Record<string, number | undefined>
  const read = usage.cache_read_input_tokens ?? 0
  const write = usage.cache_creation_input_tokens ?? 0
  return {
    // Anthropic reports `input_tokens` excluding cached tokens, which is already the
    // "non-cached input" number opencode stores separately from cache read/write.
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    // Claude Code does not break reasoning out of output_tokens, so opencode's reasoning
    // counter stays 0 rather than double-counting thinking against output.
    reasoning: 0,
    cache: { read, write },
  }
}

function closeAssistant() {
  if (!current) return
  // Every line of a turn repeats the same cumulative `usage`, so the last one is the turn's total.
  const tokens = usageOf(current.line)
  const total = tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
  const stop = String(current.line.message?.stop_reason ?? "")
  Object.assign(current.message.info, {
    time: { created: current.start, completed: current.end },
    tokens: { total, ...tokens },
    finish: FINISH[stop] ?? (stop ? "other" : undefined),
  })
  // Any tool still open when the turn ends was interrupted; opencode needs a terminal state or
  // the replayed request would carry a tool_use with no matching tool_result.
  for (const [callID, pending] of pendingTools) {
    stats.orphanResults++
    downgrade("tool-without-result")
    pending.part.state = {
      status: "error",
      input: (pending.part.state as { input: unknown }).input,
      error: "[Tool result missing from the Claude Code transcript]",
      time: { start: pending.start, end: current.end },
    }
    pendingTools.delete(callID)
  }
  attach(
    current.message,
    [
      {
        seed: `${current.apiID}:step-finish`,
        type: "step-finish",
        reason: String(current.message.info.finish ?? "stop"),
        cost: 0,
        tokens: { total, ...tokens },
      },
    ],
    current.end,
  )
  current = undefined
}

function openAssistant(line: Line, time: number) {
  const apiID = line.message?.id ?? `line-${line.index}`
  if (current?.apiID === apiID) return current
  closeAssistant()
  if (!parentID) {
    // A transcript can open with an assistant turn (a resumed or hook-started session).
    // opencode requires every assistant message to point at a user message, so synthesize one.
    pushUser(time, `${apiID}:synthetic-parent`, [
      {
        seed: `${apiID}:synthetic-parent:text`,
        type: "text",
        text: "[Converted from Claude Code: the original prompt for this turn is not in the transcript]",
        synthetic: true,
        ignored: true,
      },
    ])
    downgrade("synthesized-user-parent")
  }
  const id = messageID(apiID, time, "assistant")
  const turnModel = historyModel(line.message?.model)
  const message: Message = {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID,
      mode: options.agent,
      agent: options.agent,
      providerID: turnModel.providerID,
      modelID: turnModel.modelID,
      path: { cwd, root: cwd },
      cost: 0,
      time: { created: time },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  }
  messages.push(message)
  stats.assistant++
  current = { apiID, message, start: time, end: time, line }
  attach(message, [{ seed: `${apiID}:step-start`, type: "step-start" }], time)
  return current
}

/**
 * Promote a running tool part to its terminal state. Returns false when the matching tool_use is
 * not in scope (skipped branch, truncated transcript) so the caller can preserve the output rather
 * than drop it.
 */
function completeTool(block: Block, time: number) {
  const callID = String(block.tool_use_id ?? "")
  const pending = pendingTools.get(callID)
  const { text, images } = resultText(block)
  if (!pending) return { ok: false as const, callID, text }
  pendingTools.delete(callID)
  const input = (pending.part.state as { input: Record<string, unknown> }).input
  pending.part.state =
    block.is_error === true
      ? { status: "error", input, error: text, time: { start: pending.start, end: time } }
      : {
          status: "completed",
          input,
          output: text,
          title: String((pending.part as { tool: string }).tool),
          metadata: {},
          time: { start: pending.start, end: time },
          ...(images.length
            ? {
                // Nested inside the tool state rather than attached as parts, so these get their id
                // directly — they're not in the part ordering.
                attachments: images.map((image, index) => ({
                  id: partID(`${callID}:attachment:${index}`, time, index),
                  sessionID,
                  messageID: pending.part.messageID,
                  type: "file",
                  mime: image.mime,
                  url: image.url,
                })),
              }
            : {}),
        }
  return { ok: true as const, callID, text }
}

/* ------------------------------------------------------------------ main loop */

for (const line of selected) {
  const time = monotonic(line.timestamp)

  if (line.type === "attachment") {
    pendingAttachments.push(attachmentText(line))
    continue
  }

  if (line.type === "system" && typeof line.content === "string" && line.content.trim()) {
    // System notices (slash-command output, compaction markers, hook summaries) are context, not
    // conversation. Same treatment as attachments: preserved, but flagged so they don't replay.
    pendingAttachments.push(`[claude-code ${line.subtype ?? "system"}]\n${line.content}`)
    continue
  }

  if (line.type !== "user" && line.type !== "assistant") continue

  const items = blocks(line)
  if (!items.length) continue

  if (line.type === "user") {
    // A user line that only carries tool results is the transport for tool output, not a new turn.
    const results = items.filter((block) => block.type === "tool_result")
    if (results.length && results.length === items.length) {
      for (const block of results) {
        const outcome = completeTool(block, time)
        if (!outcome.ok) {
          // The matching tool_use is on a branch we skipped, or the transcript is truncated.
          stats.orphanResults++
          downgrade("tool-result-without-call")
          pendingAttachments.push(`[claude-code orphan tool result ${outcome.callID}]\n${outcome.text}`)
          continue
        }
        if (current) current.end = time
      }
      continue
    }

    closeAssistant()
    const parts: Part[] = []
    items.forEach((block, index) => {
      if (block.type === "text") {
        const text = String(block.text ?? "")
        if (!text.trim()) return
        stats.text++
        parts.push({
          seed: `${line.uuid}:text:${index}`,
          type: "text",
          text,
          // isMeta marks context Claude Code injected on the user's behalf, not something they typed.
          ...(line.isMeta ? { synthetic: true, ignored: true } : {}),
        })
        return
      }
      if (block.type === "image") {
        const image = block.source as { media_type?: string; data?: string; url?: string } | undefined
        const mime = image?.media_type ?? "image/png"
        const url = image?.data ? `data:${mime};base64,${image.data}` : (image?.url ?? "")
        if (!url) return
        stats.file++
        parts.push({ seed: `${line.uuid}:image:${index}`, type: "file", mime, url, filename: "pasted-image" })
        return
      }
      if (block.type === "tool_result") {
        // Mixed content: a tool result sharing a line with real user text. Complete the tool part
        // if we still have it, otherwise keep the output visible as ignored text.
        const outcome = completeTool(block, time)
        if (outcome.ok) return
        downgrade("tool-result-inlined-as-text")
        parts.push({
          seed: `${line.uuid}:mixed-result:${index}`,
          type: "text",
          text: outcome.text,
          synthetic: true,
          ignored: true,
        })
        return
      }
      downgrade(`user-block-as-text:${block.type}`)
      parts.push({
        seed: `${line.uuid}:raw:${index}`,
        type: "text",
        text: JSON.stringify(block),
        synthetic: true,
        ignored: true,
      })
    })
    if (parts.length || pendingAttachments.length) pushUser(time, String(line.uuid), parts)
    continue
  }

  // assistant
  const turn = openAssistant(line, time)!
  turn.end = time
  turn.line = line
  const parts: Part[] = []
  items.forEach((block, index) => {
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      const text = String(block.thinking ?? block.data ?? "")
      stats.reasoning++
      parts.push({
        seed: `${line.uuid}:reasoning:${index}`,
        type: "reasoning",
        text,
        time: { start: time, end: time },
        // The signature is Anthropic's proof the thinking block is unmodified. Carrying it in the
        // same metadata slot opencode uses lets a resumed Anthropic session replay it; other
        // providers ignore it, and opencode drops unsigned empty reasoning on its own.
        ...(block.signature ? { metadata: { anthropic: { signature: block.signature } } } : {}),
      })
      return
    }
    if (block.type === "text") {
      const text = String(block.text ?? "")
      if (!text.trim()) return
      stats.text++
      parts.push({ seed: `${line.uuid}:text:${index}`, type: "text", text })
      return
    }
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      const callID = String(block.id ?? `${line.uuid}:${index}`)
      const name = toolName(String(block.name ?? "unknown"))
      const part: Part = {
        seed: `${callID}:tool`,
        type: "tool",
        tool: name,
        callID,
        // Starts as running; the tool_result line below promotes it to completed or error.
        state: { status: "running", input: toolInput(block.input), time: { start: time } },
        ...(block.type === "server_tool_use" ? { metadata: { providerExecuted: true } } : {}),
      }
      stats.tool++
      parts.push(part)
      pendingTools.set(callID, { part, start: time })
      return
    }
    if (block.type === "tool_result") {
      // A provider-executed tool (server_tool_use) returns its result inside the assistant turn.
      const outcome = completeTool(block, time)
      if (outcome.ok) return
      downgrade("tool-result-without-call")
      stats.orphanResults++
      parts.push({
        seed: `${line.uuid}:orphan-result:${index}`,
        type: "text",
        text: outcome.text,
        synthetic: true,
      })
      return
    }
    downgrade(`assistant-block-as-text:${block.type}`)
    parts.push({ seed: `${line.uuid}:raw:${index}`, type: "text", text: JSON.stringify(block) })
  })
  attach(turn.message, parts, time)
}

closeAssistant()

if (pendingAttachments.length) {
  // Injected context with no following turn — a session that was opened and abandoned. Keep it on a
  // trailing user message so a transcript that consists only of hook output still round-trips.
  pushUser(clock + 1, `${sessionUuid}:trailing-attachments`, [])
}

if (!messages.length) {
  console.error(`Nothing to convert: ${path.basename(source)} has no conversational records.`)
  console.error(`This happens with sessions that were opened and closed without a prompt.`)
  process.exit(2)
}

/* ------------------------------------------------------------------ session envelope */

const times = messages
  .map((message) => (message.info.time as { created: number }).created)
  .filter((value) => Number.isFinite(value))
const created = times.length ? Math.min(...times) : firstTime
const updated = times.length ? Math.max(...times) : firstTime

const tokens = messages.reduce(
  (accumulator, message) => {
    if (message.info.role !== "assistant") return accumulator
    const value = message.info.tokens as {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    accumulator.input += value.input
    accumulator.output += value.output
    accumulator.reasoning += value.reasoning
    accumulator.cache.read += value.cache.read
    accumulator.cache.write += value.cache.write
    return accumulator
  },
  { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
)

/**
 * `projectID`, `directory` and `path` are deliberately left as the transcript's cwd: `opencode
 * import` overwrites all three from the directory it runs in, which is how the session gets bound
 * to the right project. Guessing a projectID here would just be discarded.
 */
const info = {
  id: sessionID,
  slug: `claude-${sessionUuid.slice(0, 8)}`,
  projectID: "global",
  directory: cwd,
  title: aiTitle || oneline(firstPrompt(selected), 80) || `Claude Code ${sessionUuid.slice(0, 8)}`,
  version: options.version ?? claudeVersion ?? "claude-code",
  agent: options.agent,
  model: { id: modelID, providerID },
  cost: 0,
  tokens,
  time: { created, updated },
  metadata: {
    claudeCode: {
      sessionID: sessionUuid,
      transcript: path.resolve(source),
      cwd,
      version: claudeVersion,
      branch: loaded.lines.filter((line) => line.gitBranch).at(-1)?.gitBranch,
      convertedAt: new Date().toISOString(),
    },
  },
}

const report = {
  source: path.resolve(source),
  output: path.resolve(options.out),
  sessionID,
  claudeSessionID: sessionUuid,
  cwd,
  title: info.title,
  model: { providerID, modelID },
  lines: { total: loaded.lines.length, selected: selected.length, corrupt: loaded.corrupt.length, abandoned },
  messages: messages.length,
  parts: messages.reduce((sum, message) => sum + message.parts.length, 0),
  stats,
  downgrades: Object.fromEntries([...downgrades.entries()].sort((a, b) => b[1] - a[1])),
  notes,
  warnings,
}

mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
writeFileSync(options.out, JSON.stringify({ info, messages }, null, 2))
if (options.report) {
  mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true })
  writeFileSync(options.report, JSON.stringify(report, null, 2))
}

console.log(`Converted ${path.basename(source)} → ${options.out}`)
console.log(`  session   ${sessionID}  (${info.title})`)
console.log(`  cwd       ${cwd}`)
console.log(`  model     ${providerID}/${modelID}`)
console.log(`  messages  ${messages.length} (${stats.user} user, ${stats.assistant} assistant), ${report.parts} parts`)
console.log(
  `  parts     ${stats.text} text, ${stats.reasoning} reasoning, ${stats.tool} tool, ${stats.file} file, ${stats.attachment} injected-context`,
)
if (Object.keys(report.downgrades).length) {
  console.log(`  downgrades`)
  for (const [kind, count] of Object.entries(report.downgrades)) console.log(`    ${kind}: ${count}`)
}
for (const note of notes) console.log(`  note      ${note}`)
for (const warning of warnings) console.log(`  warning   ${warning}`)
console.log(``)
console.log(`Next: run this from the directory the session should belong to`)
console.log(`  cd ${cwd} && opencode import ${path.resolve(options.out)}`)
