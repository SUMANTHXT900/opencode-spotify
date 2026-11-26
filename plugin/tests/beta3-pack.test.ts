// B19/B20 manifest invariant: the packed tree must resolve its own TUI
// runtime. Loader verdict (on-disk SDK/host code): the host does NOT inject
// @opentui/* or solid-js into TUI module scope — bare specifiers resolve
// importer-relative from the plugin's own node_modules. Beta.2 failed this
// (optional peers skipped by consumer installs); the fix pins exact hard
// dependencies. Policy-based (no hard-coded versions) so scratch candidates
// with exact newer pins pass; the beta.2 failure modes (optional peer,
// range prefix, core/solid mismatch) still fail.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
)

test("TUI runtime is a pinned hard dependency, never an optional peer", () => {
  for (const dep of ["@opentui/core", "@opentui/solid", "solid-js"]) {
    const pin = manifest.dependencies?.[dep]
    assert.match(String(pin ?? ""), /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
      `${dep} must be pinned exact in dependencies (got ${JSON.stringify(pin)}); scratch candidates may use newer exact pins`)
    assert.equal(manifest.peerDependencies?.[dep], undefined,
      `${dep} must not be a peer at all (required-peers-plus-real-deps risks duplicate/confused resolution)`)
    assert.equal(manifest.peerDependenciesMeta?.[dep], undefined,
      `${dep} must not linger in peerDependenciesMeta (the optional-peer fiction is what broke beta.2 consumers)`)
    assert.equal(manifest.optionalDependencies?.[dep], undefined,
      `${dep} must not be optional: the TUI cannot run without it`)
  }
  assert.equal(manifest.dependencies?.["@opentui/core"], manifest.dependencies?.["@opentui/solid"],
    "@opentui/core and @opentui/solid must stay a matching pair (exact transitive and native lockstep)")
})
