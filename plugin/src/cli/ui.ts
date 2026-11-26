import { createInterface } from "node:readline/promises"
import type { Logger, Prompter, Ui } from "./types.ts"

const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
}

function paint(color: boolean, code: string, text: string): string {
  return color ? `${code}${text}${ansi.reset}` : text
}

export function createUi(log: Logger, options: { color: boolean; json: boolean }): Ui {
  const color = options.color && !!process.stdout.isTTY
  const silent = options.json
  const write = (text = "") => { if (!silent) log.out(text) }
  const badge = (kind: "ok" | "missing" | "warn" | "fail" | "info") => {
    switch (kind) {
      case "ok": return paint(color, ansi.green, "[OK]")
      case "missing": return paint(color, ansi.dim, "[--]")
      case "warn": return paint(color, ansi.yellow, "[!!]")
      case "fail": return paint(color, ansi.red, "[XX]")
      default: return paint(color, ansi.cyan, "[..] ")
    }
  }
  return {
    banner(version, windows) {
      const platform = windows ? "Windows" : "Non-Windows (unsupported for live use)"
      write("")
      write(paint(color, ansi.bold, "  OpenCode Spotify"))
      write(paint(color, ansi.dim, `  Installer v${version} - ${platform}`))
      write("")
    },
    title: (text) => write(paint(color, ansi.bold, text)),
    section: (text) => { write(""); write(paint(color, ansi.bold, text)) },
    line: (text) => write(text),
    kv: (key, value) => write(`  ${key.padEnd(22)} ${value}`),
    status: (kind, text) => write(`  ${badge(kind)} ${text}`),
    bullet: (text) => write(`   - ${text}`),
    warn: (text) => write(`  ${paint(color, ansi.yellow, "[!!]")} ${text}`),
    error: (text) => write(`  ${paint(color, ansi.red, "[XX]")} ${text}`),
    success: (text) => write(`  ${paint(color, ansi.green, "[OK]")} ${text}`),
    json(value) { log.out(JSON.stringify(value, null, 2)) },
    dryRun: (step) => write(`  ${paint(color, ansi.cyan, "[dry-run]")} ${step}`),
    // Plain output owns no alternate screen or live region: terminal
    // suspend/resume and close are deliberate no-ops so callers can use the
    // same lifecycle around interactive children in every presentation mode.
    async suspend() {},
    async resume() {},
    async close() {},
  }
}

export function createPrompter(log: Logger): Prompter {
  // Lazy readline creation: importing the prompter or constructing it must not
  // open stdin/stdout handles. The interface is created on first prompt so
  // --help/--version, JSON mode and tests never hold the terminal.
  let rl: ReturnType<typeof createInterface> | undefined
  let closed = false
  const ensureRl = () => {
    if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
    return rl
  }
  const ask = async (question: string) => {
    if (closed) return undefined
    try {
      const answer = await ensureRl().question(question)
      return answer.trim()
    } catch {
      return undefined
    }
  }
  return {
    ask,
    async choose(question, choices, defaultIndex = 0) {
      log.out("")
      log.out(question)
      choices.forEach((choice, index) => log.out(`  ${index + 1}. ${choice.label}`))
      while (true) {
        const answer = await ask(`Select [${defaultIndex + 1}]: `)
        if (answer === undefined) return undefined
        if (!answer) return choices[defaultIndex]?.value
        const index = Number(answer)
        if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1]!.value
        log.out(`Enter a number from 1 to ${choices.length}.`)
      }
    },
    async confirm(question, options = {}) {
      if (options.phrase) {
        const answer = await ask(`${question}\nType ${options.phrase} to continue: `)
        return answer === options.phrase
      }
      while (true) {
        const answer = await ask(`${question} ${options.defaultYes ? "[Y/n]" : "[y/N]"}: `)
        if (answer === undefined) return false
        if (!answer) return options.defaultYes === true
        if (/^y(es)?$/i.test(answer)) return true
        if (/^n(o)?$/i.test(answer)) return false
        // B07: invalid input explains accepted values and reprompts instead
        // of silently cancelling. Safe default stays "no".
        log.out(`Please answer y/yes or n/no (default ${options.defaultYes ? "yes" : "no"}), or leave empty for the default.`)
      }
    },
    close() {
      if (closed) return
      closed = true
      try { rl?.close() } catch { /* already closed */ }
    },
  }
}
