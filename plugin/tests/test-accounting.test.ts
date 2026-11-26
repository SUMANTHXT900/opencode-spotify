import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accountTests, inventoryTests, parseBucket } from "../scripts/check-test-accounting.mjs"

const files = ["a.test.ts", "nested/b.test.mjs", "vt.test.ts"]
const scripts = {
  test: "npm run test:fast",
  "test:fast": "node --test tests/a.test.ts",
  "test:bun": "node --test tests/nested/b.test.mjs",
  "test:vt": "node --test tests/vt.test.ts",
}

test("test accounting inventories nested suites and excludes fixtures", () => {
  const dir = mkdtempSync(join(tmpdir(), "spotify-test-inventory-"))
  try {
    mkdirSync(join(dir, "nested"))
    for (const file of [...files, "nested/fixture.ts"]) writeFileSync(join(dir, file), "")
    assert.deepEqual(inventoryTests(dir), files)
    assert.equal(accountTests(files, scripts).size, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("test accounting rejects commands that depend on shell expansion or implicit discovery", () => {
  for (const script of [
    "", "node --test", "node --test tests/*.test.ts", "node --test tests/../a.test.ts",
    "node --test \"tests/a.test.ts\"", "node --test tests/fixture.ts",
    "node --test tests/a.test.ts && node --test tests/b.test.ts",
  ]) assert.throws(() => parseBucket("test:fast", script), /explicit test paths/)
})

test("test accounting detects omitted, duplicate and stale paths", () => {
  assert.throws(() => accountTests(files, { ...scripts, "test:bun": scripts["test:fast"] }),
    /"duplicates":\["a.test.ts"\].*"missing":\["nested\/b.test.mjs"\]/)
  assert.throws(() => accountTests(files, { ...scripts, "test:vt": "node --test tests/stale.test.ts" }),
    /"missing":\["vt.test.ts"\].*"unknown":\["stale.test.ts"\]/)
  assert.throws(() => accountTests(files, { ...scripts, test: "node --test" }), /delegate/)
})
