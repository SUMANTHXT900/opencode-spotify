/**
 * Snapshot generator/checker for the Ink fixtures.
 *
 * Run with Ink installed:
 *   node tests/fixtures/ink/generate.ts            # check stored snapshots
 *   node tests/fixtures/ink/generate.ts --write    # rewrite them
 *   node tests/fixtures/ink/generate.ts --write <dir>
 *
 * The C14 probe copies this fixture directory next to a throwaway node_modules;
 * the repository itself is never installed into.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ALLOWED_NON_ASCII } from "./glyphs.ts"
import { frameProblems } from "./normalize.ts"
import { createScene, SCENE_CASES } from "./scenes.ts"
import type { SceneCase } from "./scenes.ts"
import { loadInkHarness, renderToString } from "./runtime.ts"

export const SNAPSHOT_ROOT = fileURLToPath(new URL("./snapshots/", import.meta.url))

export interface GeneratedSnapshot {
  scene: SceneCase
  file: string
  frame: string
}

export class SnapshotGenerationError extends Error {}

export async function generateSnapshots(): Promise<GeneratedSnapshot[]> {
  const result = await loadInkHarness()
  if (!result.ok) throw new SnapshotGenerationError(`Ink is unavailable: ${result.reason}`)
  const harness = result.harness
  const output: GeneratedSnapshot[] = []
  try {
    for (const scene of SCENE_CASES) {
      const first = renderToString(harness, createScene(scene, harness.ink))
      const second = renderToString(harness, createScene(scene, harness.ink))
      if (first !== second) {
        throw new SnapshotGenerationError(`${scene.file} is not deterministic across renders`)
      }
      const problems = frameProblems(first, {
        width: scene.width,
        ascii: scene.breakpoint === "narrow",
        allowedNonAscii: scene.breakpoint === "wide" ? ALLOWED_NON_ASCII : undefined,
      })
      if (problems.length > 0) {
        throw new SnapshotGenerationError(`${scene.file} is invalid:\n${problems.join("\n")}`)
      }
      output.push({ scene, file: scene.file, frame: first })
    }
  } finally {
    harness.cleanup()
  }
  return output
}

function snapshotPath(root: string, relative: string): string {
  return join(root, relative)
}

export async function writeSnapshots(snapshots: GeneratedSnapshot[], root = SNAPSHOT_ROOT): Promise<void> {
  for (const snapshot of snapshots) {
    const path = snapshotPath(root, snapshot.file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${snapshot.frame}\n`, "utf8")
  }
}

export async function checkSnapshots(snapshots: GeneratedSnapshot[], root = SNAPSHOT_ROOT): Promise<string[]> {
  const mismatches: string[] = []
  for (const snapshot of snapshots) {
    const path = snapshotPath(root, snapshot.file)
    let stored: string
    try {
      stored = await readFile(path, "utf8")
    } catch {
      mismatches.push(`${snapshot.file}: missing stored snapshot`)
      continue
    }
    const normalized = stored.replace(/\r\n?/g, "\n").replace(/\n+$/g, "")
    if (normalized !== snapshot.frame) mismatches.push(`${snapshot.file}: frame differs from stored snapshot`)
  }
  return mismatches
}

async function main(argv: string[]): Promise<number> {
  const writeIndex = argv.indexOf("--write")
  const write = writeIndex >= 0
  const root = writeIndex >= 0 && argv[writeIndex + 1] && !argv[writeIndex + 1]!.startsWith("--")
    ? resolve(argv[writeIndex + 1]!)
    : SNAPSHOT_ROOT

  let snapshots: GeneratedSnapshot[]
  try {
    snapshots = await generateSnapshots()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  if (write) {
    await writeSnapshots(snapshots, root)
    console.log(`wrote ${snapshots.length} snapshots to ${root}`)
    return 0
  }

  const mismatches = await checkSnapshots(snapshots, root)
  if (mismatches.length > 0) {
    console.error(mismatches.join("\n"))
    return 1
  }
  console.log(`ok: ${snapshots.length} Ink snapshots match`)
  return 0
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (invoked && import.meta.url === invoked) {
  process.exitCode = await main(process.argv.slice(2))
}
