#!/usr/bin/env bun
/**
 * Check a converted payload against the invariants opencode relies on, before importing.
 *
 *   bun validate.ts <converted.json> [more.json ...]
 *
 * `opencode import` decodes everything through opencode's schemas and will reject malformed
 * records, but it fails on the first bad record with a schema error that doesn't say which message
 * caused it. This script front-runs that with checks that name the offending id, and additionally
 * verifies the ordering and pairing rules that are not encoded in the schema at all — an id that
 * sorts out of order or a tool_use with no terminal state imports cleanly and then misbehaves when
 * the session is resumed.
 */

import { existsSync, readFileSync } from "fs"

const files = process.argv.slice(2)
if (!files.length) {
  console.error("usage: bun validate.ts <converted.json> [more.json ...]")
  process.exit(1)
}

const missing = files.filter((file) => !existsSync(file))
if (missing.length) {
  for (const file of missing) console.error(`File not found: ${file}`)
  process.exit(1)
}

const PART_TYPES = new Set([
  "text",
  "reasoning",
  "file",
  "tool",
  "step-start",
  "step-finish",
  "snapshot",
  "patch",
  "agent",
  "retry",
  "compaction",
  "subtask",
])

function check(file: string) {
  const problems: string[] = []
  const parsed = ((): { info?: Record<string, any>; messages?: { info: Record<string, any>; parts: Record<string, any>[] }[] } | undefined => {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      problems.push(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  })()
  if (!parsed) return { file, messages: 0, problems }
  if (!parsed.info || !Array.isArray(parsed.messages)) {
    problems.push(`expected { info, messages: [...] } — this does not look like a converted session`)
    return { file, messages: 0, problems }
  }
  const data = parsed as {
    info: Record<string, any>
    messages: { info: Record<string, any>; parts: Record<string, any>[] }[]
  }
  const fail = (message: string) => problems.push(message)

  const info = data.info
  if (!info?.id?.startsWith("ses_")) fail(`session id must start with "ses_": ${info?.id}`)
  if (typeof info?.title !== "string" || !info.title) fail(`session title is required`)
  if (typeof info?.version !== "string" || !info.version) fail(`session version is required`)
  if (!Number.isInteger(info?.time?.created) || !Number.isInteger(info?.time?.updated)) {
    fail(`session time.created/updated must be integers`)
  }

  const ids = new Set<string>()
  const partIDs = new Set<string>()
  let previous = ""
  const openTools: string[] = []

  for (const message of data.messages ?? []) {
    const id = message.info?.id
    if (!id?.startsWith("msg_")) fail(`message id must start with "msg_": ${id}`)
    if (ids.has(id)) fail(`duplicate message id: ${id}`)
    ids.add(id)
    // opencode pages messages by (time_created, id) and derives "the latest turn" from max id,
    // so ids must ascend in transcript order or a resumed session binds the wrong message.
    if (previous && id <= previous) fail(`message ids must ascend: ${previous} then ${id}`)
    previous = id
    if (message.info?.sessionID !== info.id) fail(`${id}: sessionID does not match the session`)

    if (message.info?.role === "assistant") {
      if (!ids.has(message.info.parentID)) fail(`${id}: parentID ${message.info.parentID} is not an earlier message`)
      for (const field of ["modelID", "providerID", "mode", "agent"]) {
        if (typeof message.info[field] !== "string" || !message.info[field]) fail(`${id}: ${field} is required`)
      }
      if (typeof message.info.path?.cwd !== "string" || typeof message.info.path?.root !== "string") {
        fail(`${id}: path.cwd and path.root are required`)
      }
      const tokens = message.info.tokens
      for (const field of ["input", "output", "reasoning"]) {
        if (!Number.isFinite(tokens?.[field])) fail(`${id}: tokens.${field} must be a number`)
      }
      if (!Number.isFinite(tokens?.cache?.read) || !Number.isFinite(tokens?.cache?.write)) {
        fail(`${id}: tokens.cache.read/write must be numbers`)
      }
    } else if (message.info?.role === "user") {
      if (!Number.isInteger(message.info.time?.created)) fail(`${id}: time.created must be an integer`)
      if (typeof message.info.agent !== "string") fail(`${id}: agent is required`)
      if (typeof message.info.model?.providerID !== "string" || typeof message.info.model?.modelID !== "string") {
        fail(`${id}: model.providerID and model.modelID are required`)
      }
    } else {
      fail(`${id}: role must be "user" or "assistant", got ${message.info?.role}`)
    }

    let previousPart = ""
    for (const part of message.parts ?? []) {
      if (!part.id?.startsWith("prt_")) fail(`${id}: part id must start with "prt_": ${part.id}`)
      if (partIDs.has(part.id)) fail(`${id}: duplicate part id: ${part.id}`)
      partIDs.add(part.id)
      // Parts are ordered by id alone (part_message_id_id_idx), with no separate sequence column.
      if (previousPart && part.id <= previousPart) fail(`${id}: part ids must ascend: ${previousPart} then ${part.id}`)
      previousPart = part.id
      if (part.messageID !== id) fail(`${part.id}: messageID does not match its message`)
      if (part.sessionID !== info.id) fail(`${part.id}: sessionID does not match the session`)
      if (!PART_TYPES.has(part.type)) fail(`${part.id}: unknown part type "${part.type}"`)

      if (part.type === "tool") {
        if (typeof part.callID !== "string" || !part.callID) fail(`${part.id}: tool callID is required`)
        if (typeof part.tool !== "string" || !part.tool) fail(`${part.id}: tool name is required`)
        const status = part.state?.status
        // A tool left pending/running replays as a tool_use with no tool_result, which Anthropic
        // rejects outright; opencode papers over it with an error placeholder, but a converted
        // transcript should not need that rescue.
        if (status !== "completed" && status !== "error") openTools.push(`${part.id} (${status})`)
        if (status === "completed") {
          if (typeof part.state.output !== "string") fail(`${part.id}: completed tool needs a string output`)
          if (typeof part.state.title !== "string") fail(`${part.id}: completed tool needs a title`)
          if (!Number.isFinite(part.state.time?.start) || !Number.isFinite(part.state.time?.end)) {
            fail(`${part.id}: completed tool needs time.start and time.end`)
          }
        }
        if (status === "error" && typeof part.state.error !== "string") {
          fail(`${part.id}: errored tool needs a string error`)
        }
      }
      if (part.type === "text" && typeof part.text !== "string") fail(`${part.id}: text part needs a string text`)
      if (part.type === "reasoning") {
        if (typeof part.text !== "string") fail(`${part.id}: reasoning part needs a string text`)
        if (!Number.isFinite(part.time?.start)) fail(`${part.id}: reasoning part needs time.start`)
      }
      if (part.type === "file") {
        if (typeof part.mime !== "string" || typeof part.url !== "string") fail(`${part.id}: file part needs mime+url`)
      }
      if (part.type === "step-finish") {
        if (!Number.isFinite(part.cost)) fail(`${part.id}: step-finish needs a numeric cost`)
        if (!Number.isFinite(part.tokens?.input)) fail(`${part.id}: step-finish needs tokens`)
      }
    }
  }

  if (openTools.length) fail(`${openTools.length} tool part(s) left without a terminal state: ${openTools.slice(0, 5).join(", ")}`)

  return { file, messages: data.messages?.length ?? 0, problems }
}

let failed = 0
for (const file of files) {
  const result = check(file)
  if (!result.problems.length) {
    if (files.length === 1) console.log(`OK  ${file} (${result.messages} messages)`)
    continue
  }
  failed++
  console.log(`BAD ${file} (${result.messages} messages)`)
  for (const problem of result.problems.slice(0, 20)) console.log(`      ${problem}`)
  if (result.problems.length > 20) console.log(`      … and ${result.problems.length - 20} more`)
}

if (files.length > 1) console.log(`\n${files.length - failed}/${files.length} file(s) passed`)
process.exit(failed ? 1 : 0)
