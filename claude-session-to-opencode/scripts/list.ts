#!/usr/bin/env bun
/**
 * Enumerate Claude Code project directories, or the sessions inside one.
 *
 * Reading `cwd` out of the transcript beats decoding the directory name: Claude Code
 * encodes a path by replacing every "/" with "-", so a real directory containing a
 * dash is indistinguishable from a path separator. The transcript records the true
 * working directory on every conversational line.
 *
 *   bun list.ts                       # every project directory
 *   bun list.ts <projectDir|cwd>      # sessions inside one project
 *   bun list.ts --json ...            # machine-readable
 */

import { readdirSync, statSync } from "fs"
import { homedir } from "os"
import path from "path"
import { activeChain, firstPrompt, loadJsonl, oneline } from "./lib"

const args = process.argv.slice(2)
const json = args.includes("--json")
const target = args.find((arg) => !arg.startsWith("--"))
const root = path.join(homedir(), ".claude", "projects")

function firstCwd(file: string) {
  const { lines } = loadJsonl(file)
  return lines.find((line) => typeof line.cwd === "string")?.cwd
}

function decodeName(name: string) {
  return name.replace(/^-/, "/").replaceAll("-", "/")
}

function projects() {
  return readdirSync(root)
    .filter((name) => statSync(path.join(root, name)).isDirectory())
    .map((name) => {
      const dir = path.join(root, name)
      const files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"))
      const times = files.map((file) => statSync(path.join(dir, file)).mtimeMs)
      const sample = files.map((file) => path.join(dir, file)).find(Boolean)
      return {
        name,
        dir,
        cwd: (sample && firstCwd(sample)) ?? decodeName(name),
        sessions: files.length,
        modified: times.length ? Math.max(...times) : statSync(dir).mtimeMs,
      }
    })
    .filter((item) => item.sessions > 0)
    .sort((a, b) => b.modified - a.modified)
}

function resolveProject(input: string) {
  const direct = path.isAbsolute(input) && input.includes(".claude") ? input : path.join(root, input)
  if (direct !== root && statSync(direct, { throwIfNoEntry: false })?.isDirectory()) return direct
  const match = projects().find((item) => item.cwd === input || item.name === input || item.dir === input)
  if (!match) {
    console.error(`No Claude Code project directory matches: ${input}`)
    console.error(`Run without arguments to list the available projects.`)
    process.exit(1)
  }
  return match.dir
}

function sessions(dir: string) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => {
      const full = path.join(dir, file)
      const { lines, corrupt } = loadJsonl(full)
      const conversational = lines.filter((line) => line.type === "user" || line.type === "assistant")
      const stamps = lines.map((line) => line.timestamp).filter((value): value is string => !!value)
      const title = lines.filter((line) => line.type === "ai-title").at(-1)?.aiTitle
      return {
        id: path.basename(file, ".jsonl"),
        file: full,
        cwd: lines.find((line) => typeof line.cwd === "string")?.cwd ?? decodeName(path.basename(dir)),
        title: title ?? firstPrompt(lines),
        prompt: firstPrompt(lines),
        messages: conversational.length,
        active: activeChain(lines).chain.filter((line) => line.type === "user" || line.type === "assistant").length,
        corrupt: corrupt.length,
        start: stamps.at(0),
        end: stamps.at(-1),
        bytes: statSync(full).size,
      }
    })
    .sort((a, b) => (a.end ?? "").localeCompare(b.end ?? ""))
    .reverse()
}

if (!target) {
  const items = projects()
  if (json) {
    console.log(JSON.stringify(items, null, 2))
  } else {
    console.log(`${items.length} Claude Code project directories under ${root}\n`)
    items.forEach((item, index) => {
      console.log(`${String(index + 1).padStart(3)}. ${item.cwd}`)
      console.log(
        `     ${item.sessions} session(s) · last active ${new Date(item.modified).toLocaleString()} · ${item.name}`,
      )
    })
  }
} else {
  const dir = resolveProject(target)
  const items = sessions(dir)
  if (json) {
    console.log(JSON.stringify({ dir, sessions: items }, null, 2))
  } else {
    console.log(`${items.length} session(s) in ${dir}\n`)
    items.forEach((item, index) => {
      console.log(`${String(index + 1).padStart(3)}. ${item.id}`)
      console.log(`     ${oneline(item.title || "(no prompt found)")}`)
      const range = [item.start, item.end].filter(Boolean).map((value) => new Date(value!).toLocaleString())
      console.log(
        `     ${item.messages} message(s) (${item.active} on the active branch) · ${(item.bytes / 1024).toFixed(0)} KiB` +
          (range.length ? ` · ${range.join(" → ")}` : "") +
          (item.corrupt ? ` · ${item.corrupt} unparsable line(s)` : ""),
      )
    })
  }
}
