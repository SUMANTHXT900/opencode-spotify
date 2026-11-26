import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MANUAL_INSTRUCTIONS_URL,
  OFFICIAL_INSTALLER,
  OFFICIAL_INSTALLER_EFFECTS,
  PINNED_INSTALLER_REVISION,
  PINNED_INSTALLER_SHA256,
  PINNED_INSTALLER_SIZE_BYTES,
  approveOfficialInstall,
  buildApprovalRequest,
  buildSelectionRequest,
  formatInstallerSize,
  hasReviewedInstallerDigest,
  installerVerificationEffect,
  officialInstallPlan,
  officialInstallerEffects,
  renderManualInstructions,
  renderOfficialInstallerExplanation,
  renderPlanPreview,
  renderPostManualInstructions,
  renderResultScreen,
  renderSelectionScreen,
  resolveInstallTarget,
  resultExitCode,
  runInstallWizard,
  selectInstallMethod,
  type OfficialInstallerPin,
} from "../src/cli/ui/install-wizard.ts"
import { fakePrompt, fakeUi } from "./cli-fixture.ts"

const text = (ui: ReturnType<typeof fakeUi>) => ui.lines.join("\n")

test("official installer record matches the shared A02 evidence and has no static target", () => {
  assert.equal(PINNED_INSTALLER_REVISION, "f4a824f")
  assert.match(PINNED_INSTALLER_SHA256, /^e65d1651[0-9a-f]{56}$/)
  assert.equal(PINNED_INSTALLER_SIZE_BYTES, 8307)
  assert.equal(OFFICIAL_INSTALLER.revision, "f4a824f")
  assert.equal(OFFICIAL_INSTALLER.sizeBytes, 8307)
  assert.equal(OFFICIAL_INSTALLER.targetVersion, null, "the target is resolved dynamically, never baked in")
  assert.ok(OFFICIAL_INSTALLER.url.includes("/f4a824fbbe07233adeab889328e6fefdc274660b/install.ps1"))
  assert.ok(OFFICIAL_INSTALLER.effects.length >= 4)
  assert.ok(OFFICIAL_INSTALLER.effects.some((line) => /pinned installer script is verified \(size and SHA-256\) before execution/i.test(line)))
  assert.ok(OFFICIAL_INSTALLER.nots.some((line) => /spicetify apply/.test(line)))
  assert.ok(OFFICIAL_INSTALLER.nots.some((line) => /administrator|system-wide PATH/.test(line)))
  // The existing-install prompt still defaults to Yes and must be answered No.
  assert.ok(OFFICIAL_INSTALLER.nots.some((line) => /defaults to Yes/.test(line)))
  assert.ok(OFFICIAL_INSTALLER.nots.some((line) => /answer No/.test(line)))
  assert.ok(OFFICIAL_INSTALLER.nots.some((line) => /spicetify update/.test(line)))
  // The stale "answer No to the Marketplace prompt" instruction is gone: the
  // reviewed patch removes that branch entirely.
  assert.ok(OFFICIAL_INSTALLER.nots.every((line) => !/Marketplace prompt/i.test(line)))
  assert.ok(OFFICIAL_INSTALLER.nots.every((line) => !/answer No at both/i.test(line)))
  assert.ok(OFFICIAL_INSTALLER.nots.every((line) => !/Choosing Yes to Marketplace/i.test(line)))
  // Move-OldSpicetifyFolder can delete the legacy folder; disclosed explicitly.
  assert.ok(OFFICIAL_INSTALLER.nots.some((line) => /Move-OldSpicetifyFolder/.test(line) && /delete/.test(line) && /spicetify-cli/.test(line)))
  // No artifact digest claim unless the resolved target has a reviewed entry.
  assert.ok(OFFICIAL_INSTALLER.nots.some((line) => /Does not claim a reviewed artifact size or SHA-256/i.test(line)))
  assert.match(OFFICIAL_INSTALLER_EFFECTS.join("\n"), /Authenticode \+ exact version only/)
})

test("verification wording is ledger-conditional: size/SHA-256 only for a reviewed target", () => {
  assert.equal(hasReviewedInstallerDigest("2.46.7"), true)
  assert.equal(hasReviewedInstallerDigest("v2.46.7"), true)
  assert.equal(hasReviewedInstallerDigest("9.9.9"), false)
  assert.equal(hasReviewedInstallerDigest("latest stable release"), false)
  assert.equal(hasReviewedInstallerDigest(null), false)

  const reviewed = officialInstallerEffects("2.46.7").join("\n")
  assert.match(reviewed, /size and SHA-256 against the reviewed ledger entry/)
  assert.doesNotMatch(reviewed, /Authenticode \+ exact version only/)

  const unreviewed = officialInstallerEffects("9.9.9").join("\n")
  assert.match(unreviewed, /Authenticode \+ exact version only/)
  assert.doesNotMatch(unreviewed, /size and SHA-256 against the reviewed ledger/)
  assert.match(installerVerificationEffect(null), /Authenticode \+ exact version only/)

  // The static pin has no target, so it must not claim a reviewed digest.
  assert.match(OFFICIAL_INSTALLER.effects.join("\n"), /Authenticode \+ exact version only/)

  // The explanation screen follows the resolved target, not the static pin.
  const unreviewedUi = fakeUi()
  renderOfficialInstallerExplanation(unreviewedUi, OFFICIAL_INSTALLER, { installedVersion: null, latestVersion: "9.9.9" })
  assert.match(text(unreviewedUi), /Authenticode \+ exact version only/)
  assert.doesNotMatch(text(unreviewedUi), /size and SHA-256 against the reviewed ledger entry/)

  const reviewedUi = fakeUi()
  renderOfficialInstallerExplanation(reviewedUi, OFFICIAL_INSTALLER, { installedVersion: null, latestVersion: "2.46.7" })
  assert.match(text(reviewedUi), /size and SHA-256 against the reviewed ledger entry/)
  assert.doesNotMatch(text(reviewedUi), /Authenticode \+ exact version only, with no per-release size\/SHA-256 pin/)

  // A caller-supplied pin (setup scopes digests per architecture) keeps its
  // own effects; the wizard never broadens a narrower claim.
  const scoped: OfficialInstallerPin = {
    ...OFFICIAL_INSTALLER,
    effects: [...OFFICIAL_INSTALLER_EFFECTS, "architecture-scoped: no reviewed digest on this host"],
  }
  const scopedUi = fakeUi()
  renderOfficialInstallerExplanation(scopedUi, scoped, { installedVersion: null, latestVersion: "2.46.7" })
  assert.match(text(scopedUi), /architecture-scoped: no reviewed digest/)
})

test("the wizard never instructs answering a Marketplace prompt; it discloses the real side effects", () => {
  const all = [...OFFICIAL_INSTALLER.effects, ...OFFICIAL_INSTALLER.nots].join("\n")
  assert.doesNotMatch(all, /Marketplace prompt/i)
  assert.doesNotMatch(all, /answer No at both/i)
  assert.doesNotMatch(all, /Choosing Yes to Marketplace/i)
  assert.match(all, /Move-OldSpicetifyFolder/)
  assert.match(all, /permanently delete/)
  assert.match(all, /spicetify-cli/)
  assert.match(all, /defaults to Yes/)
  assert.match(all, /answer No/)
  assert.match(all, /spicetify update/)

  // Rendering shows the same truthful text, with no Marketplace-prompt step.
  const ui = fakeUi()
  renderOfficialInstallerExplanation(ui, OFFICIAL_INSTALLER, { installedVersion: "2.46.0", latestVersion: "9.9.9" })
  assert.doesNotMatch(text(ui), /Marketplace prompt/i)
  assert.match(text(ui), /Move-OldSpicetifyFolder/)
  assert.match(text(ui), /Authenticode \+ exact version only/)
})

test("resolveInstallTarget prefers an explicit target, then a pinned one, then latest", () => {
  assert.equal(resolveInstallTarget({ target: "2.47.0", latestVersion: "2.46.7" }), "2.47.0")
  assert.equal(resolveInstallTarget({ target: "v2.47.0", latestVersion: null }), "2.47.0")
  assert.equal(resolveInstallTarget({ latestVersion: "2.46.7" }), "2.46.7")
  assert.equal(resolveInstallTarget({ latestVersion: null }), null)
  assert.equal(resolveInstallTarget({ target: "  ", latestVersion: "" }), null)
  const pinned = { ...OFFICIAL_INSTALLER, targetVersion: "2.45.0" }
  assert.equal(resolveInstallTarget({ pin: pinned, latestVersion: "2.46.7" }), "2.45.0")
})

test("selection request uses the shared prompt contract and offers three paths", () => {
  const request = buildSelectionRequest({ installedVersion: "2.46.0", latestVersion: "2.46.8", target: "2.46.7" })
  assert.equal(request.id, "install-method")
  assert.equal(request.kind, "choose")
  assert.equal(request.defaultIndex, 0)
  assert.deepEqual(request.choices.map((choice) => choice.value), ["official", "manual", "cancel"])
  assert.match(request.choices[0]!.label, /f4a824f/)
  assert.match(request.choices[0]!.label, /target 2\.46\.7/)
  assert.ok(request.choices[0]!.hint?.includes(PINNED_INSTALLER_SHA256))
  assert.match(request.choices[1]!.label, /manually/i)
})

test("selection refuses to offer the official installer without a verified target", () => {
  const request = buildSelectionRequest({ installedVersion: null, latestVersion: null })
  assert.deepEqual(request.choices.map((choice) => choice.value), ["manual", "cancel"])
  assert.ok(!request.choices.some((choice) => choice.value === "official"))
  assert.match(request.choices[0]!.hint ?? "", /only manual installation is offered/)
})

test("selection and explanation screens show latest, installed, target, effects and NOTs", () => {
  const ui = fakeUi()
  const input = { installedVersion: "2.46.0", latestVersion: "2.46.8", target: "2.46.7" }
  renderSelectionScreen(ui, input)
  renderOfficialInstallerExplanation(ui, OFFICIAL_INSTALLER, input)
  const out = text(ui)

  assert.match(out, /Installed Spicetify: 2\.46\.0/)
  assert.match(out, /Latest detected: 2\.46\.8/)
  assert.match(out, /Installer target: 2\.46\.7/)
  assert.match(out, /Revision: f4a824f/)
  assert.match(out, new RegExp(`Script SHA-256: ${PINNED_INSTALLER_SHA256}`))
  assert.match(out, /Size: 8,307 B/)
  assert.match(out, /What it does:/)
  assert.match(out, /What it does NOT do:/)
  assert.match(out, /Does not run `spicetify apply`/)
  assert.match(out, /Does not touch OpenCode configuration/)
  assert.match(out, /warn: Latest detected 2\.46\.8 is newer than the install target 2\.46\.7/)
  assert.match(out, /manual installation/i)
})

test("explanation degrades unknown versions without inventing one", () => {
  const ui = fakeUi()
  renderOfficialInstallerExplanation(ui, OFFICIAL_INSTALLER, { installedVersion: null, latestVersion: null })
  const out = text(ui)
  assert.match(out, /Installed Spicetify: not detected/)
  assert.match(out, /Latest detected: unknown \(offline or lookup failed\)/)
  assert.match(out, /Target version: unknown \(not verified; official install refused\)/)
  assert.doesNotMatch(out, /newer than the install target/)
})

test("plan preview exposes exactly one mutating step and is presented before approval", () => {
  const steps = officialInstallPlan(OFFICIAL_INSTALLER, "2.46.7")
  assert.equal(steps.filter((step) => step.mutates).length, 1)
  assert.equal(steps.find((step) => step.mutates)?.id, "run-installer")
  assert.ok(steps.some((step) => step.description.includes(PINNED_INSTALLER_SHA256)))

  const ui = fakeUi()
  renderPlanPreview(ui, steps)
  const out = text(ui)
  assert.match(out, /Official installer plan/)
  assert.match(out, /changes the system/)
  assert.match(out, /verification only/)
  assert.match(out, /No step runs without an explicit approval/)
})

test("approval contract is a single confirm with the safe default", () => {
  const request = buildApprovalRequest("2.46.7")
  assert.equal(request.kind, "confirm")
  assert.equal(request.defaultYes, false)
  assert.equal(request.phrase, undefined)
  assert.match(request.question, /Run the pinned official installer/)
  assert.match(request.question, /2\.46\.7/)

  // No target: still safe, and never claims a version.
  const unknown = buildApprovalRequest()
  assert.equal(unknown.defaultYes, false)
  assert.doesNotMatch(unknown.question, /\d+\.\d+\.\d+/)
})

test("approval never happens without a target, for dry runs, or unattended runs", async () => {
  const noTarget = fakePrompt()
  assert.equal(await approveOfficialInstall(noTarget, OFFICIAL_INSTALLER), "unavailable")
  assert.equal(noTarget.asked.length, 0, "no installer prompt without a verified target")

  const dryPrompt = fakePrompt()
  assert.equal(await approveOfficialInstall(dryPrompt, OFFICIAL_INSTALLER, { dryRun: true }), "dry-run")
  assert.equal(dryPrompt.asked.length, 0)

  const unattended = fakePrompt()
  assert.equal(
    await approveOfficialInstall(unattended, OFFICIAL_INSTALLER, { nonInteractive: true, target: "2.46.7" }),
    "confirmation-required",
  )
  assert.equal(unattended.asked.length, 0)
})

test("approval waits for an explicit yes and treats no as declined", async () => {
  const yes = fakePrompt({ confirms: [true] })
  assert.equal(await approveOfficialInstall(yes, OFFICIAL_INSTALLER, { target: "2.46.7" }), "approved")
  assert.equal(yes.asked.length, 1)

  const no = fakePrompt({ confirms: [false] })
  assert.equal(await approveOfficialInstall(no, OFFICIAL_INSTALLER, { target: "2.46.7" }), "declined")
  assert.equal(no.asked.length, 1)

  // EOF (no mocked answer) is a no, never a silent approval.
  const closed = fakePrompt()
  assert.equal(await approveOfficialInstall(closed, OFFICIAL_INSTALLER, { target: "2.46.7" }), "declined")
})

test("selectInstallMethod maps EOF and unknown values to cancel", async () => {
  assert.equal(await selectInstallMethod(fakePrompt({ choices: ["official"] }), { installedVersion: null, latestVersion: null }), "official")
  assert.equal(await selectInstallMethod(fakePrompt({ choices: ["manual"] }), { installedVersion: null, latestVersion: null }), "manual")
  assert.equal(await selectInstallMethod(fakePrompt({ choices: ["cancel"] }), { installedVersion: null, latestVersion: null }), "cancel")
  assert.equal(await selectInstallMethod(fakePrompt({ choices: ["other"] }), { installedVersion: null, latestVersion: null }), "cancel")
  assert.equal(await selectInstallMethod(fakePrompt(), { installedVersion: null, latestVersion: null }), "cancel")
})

test("manual path shows instructions and post-manual recheck without executing anything", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt({ choices: ["manual"], confirms: [true] })
  let installCalls = 0
  const result = await runInstallWizard({
    ui,
    prompt,
    latestVersion: () => "2.46.8",
    installedVersion: "2.46.0",
    installOfficial: () => {
      installCalls++
      return { code: 0 }
    },
  })

  assert.equal(result.status, "manual")
  assert.equal(result.method, "manual")
  assert.equal(installCalls, 0)
  assert.equal(prompt.asked.length, 1, "only the method selection may prompt")

  const out = text(ui)
  assert.match(out, new RegExp(MANUAL_INSTRUCTIONS_URL.replace(/[.]/g, "\\.")))
  assert.match(out, /winget install --id Spicetify\.Spicetify -e/)
  assert.match(out, /Target version: 2\.46\.8/)
  assert.match(out, /After manual installation/)
  assert.match(out, /Re-run setup and choose "Recheck now"/)
  assert.match(out, /No installer command was run/)
  assert.doesNotMatch(out, /What it does NOT do/)
})

test("manual path is allowed unattended and never prompts or executes", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt()
  const result = await runInstallWizard({
    ui,
    prompt,
    method: "manual",
    nonInteractive: true,
    latestVersion: () => "2.46.8",
    installOfficial: () => ({ code: 0 }),
  })
  assert.equal(result.status, "manual")
  assert.equal(prompt.asked.length, 0)
  assert.match(text(ui), /Manual Spicetify installation/)
  assert.match(text(ui), /After manual installation/)
})

test("a failed latest-version lookup refuses the official installer without inventing a target", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt({ choices: ["official"], confirms: [false] })
  let installCalls = 0
  const result = await runInstallWizard({
    ui,
    prompt,
    latestVersion: () => {
      throw new Error("registry offline")
    },
    installOfficial: () => {
      installCalls += 1
      return { code: 0 }
    },
  })
  assert.equal(result.status, "failed")
  assert.equal(result.method, "official")
  assert.equal(installCalls, 0)
  assert.equal(prompt.asked.length, 1, "the method selection may prompt; approval must not")
  const out = text(ui)
  assert.match(out, /Latest detected: unknown \(offline or lookup failed\)/)
  assert.match(out, /No verified Spicetify target version is known; refusing the official installer/)
  assert.match(out, /Installer target: unknown \(official installer refused\)/)
  assert.doesNotMatch(out, /newer than the install target/)
})

test("cancelled selection makes no changes and never calls the install adapter", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt({ choices: ["cancel"] })
  let installCalls = 0
  const result = await runInstallWizard({
    ui,
    prompt,
    latestVersion: () => "2.46.8",
    installOfficial: () => {
      installCalls++
      return { code: 0 }
    },
  })
  assert.equal(result.status, "cancelled")
  assert.equal(installCalls, 0)
  assert.equal(prompt.asked.length, 1)
  assert.match(text(ui), /Cancelled\. No changes were made\./)

  const closedUi = fakeUi()
  const closed = await runInstallWizard({
    ui: closedUi,
    prompt: fakePrompt(),
    latestVersion: () => null,
    installOfficial: () => ({ code: 0 }),
  })
  assert.equal(closed.status, "cancelled")
  assert.match(text(closedUi), /Cancelled\. No changes were made\./)
})

test("approved official install asks exactly once and passes the pin to the adapter", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt({ choices: ["official"], confirms: [true] })
  const seenPins: OfficialInstallerPin[] = []
  let installCalls = 0
  const result = await runInstallWizard({
    ui,
    prompt,
    latestVersion: () => "2.46.7",
    installedVersion: "2.46.0",
    installOfficial: (pin) => {
      installCalls++
      seenPins.push(pin)
      return { code: 0, version: "2.46.7" }
    },
  })

  assert.equal(result.status, "installed")
  assert.equal(result.version, "2.46.7")
  assert.equal(installCalls, 1)
  assert.equal(seenPins.length, 1)
  assert.equal(seenPins[0]!.revision, "f4a824f")
  assert.equal(seenPins[0]!.sha256, PINNED_INSTALLER_SHA256)
  assert.deepEqual(prompt.asked, [
    "How do you want to install Spicetify?",
    "Run the pinned official installer to install Spicetify 2.46.7?",
  ])

  const out = text(ui)
  assert.match(out, /Official Spicetify installer \(pinned\)/)
  assert.match(out, /What it does NOT do:/)
  assert.match(out, /Official installer plan/)
  assert.match(out, /Installation result/)
  assert.match(out, /ok: Spicetify 2\.46\.7 completed with the pinned official installer\./)
  assert.match(out, /`spicetify apply` remains pending/)
})

test("declining the single approval performs no install and reports no changes", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt({ choices: ["official"], confirms: [false] })
  let installCalls = 0
  const result = await runInstallWizard({
    ui,
    prompt,
    latestVersion: () => "2.46.7",
    installOfficial: () => {
      installCalls++
      return { code: 0 }
    },
  })
  assert.equal(result.status, "declined")
  assert.equal(installCalls, 0)
  assert.equal(prompt.asked.length, 2)
  assert.match(text(ui), /Approval was not given\. Nothing was downloaded, executed, or changed\./)
  assert.doesNotMatch(text(ui), /completed with the pinned official installer/)
})

test("safe dry-run renders the plan but skips approval and execution", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt()
  let installCalls = 0
  const result = await runInstallWizard({
    ui,
    prompt,
    method: "official",
    dryRun: true,
    latestVersion: () => "2.46.7",
    installOfficial: () => {
      installCalls++
      return { code: 0 }
    },
  })

  assert.equal(result.status, "dry-run")
  assert.equal(installCalls, 0)
  assert.equal(prompt.asked.length, 0)
  const out = text(ui)
  assert.match(out, /Official installer plan/)
  assert.match(out, /Dry run: the installer was not downloaded or executed/)
  assert.match(out, /No changes were made|no changes were made/)
})

test("noninteractive official runs require explicit approval rather than assuming yes", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt()
  let installCalls = 0
  const result = await runInstallWizard({
    ui,
    prompt,
    method: "official",
    nonInteractive: true,
    latestVersion: () => "2.46.7",
    installOfficial: () => {
      installCalls++
      return { code: 0 }
    },
  })

  assert.equal(result.status, "confirmation-required")
  assert.equal(resultExitCode(result.status), 2)
  assert.equal(installCalls, 0)
  assert.equal(prompt.asked.length, 0)
  assert.match(text(ui), /Explicit approval is required\. Noninteractive mode never approves silently; no changes were made\./)

  const noMethodUi = fakeUi()
  const noMethod = await runInstallWizard({
    ui: noMethodUi,
    prompt: fakePrompt(),
    nonInteractive: true,
    latestVersion: () => "2.46.7",
    installOfficial: () => ({ code: 0 }),
  })
  assert.equal(noMethod.status, "confirmation-required")
  assert.equal(noMethod.method, null)
  assert.match(text(noMethodUi), /no changes were made/i)
})

test("a missing or failing install adapter is reported as failure, never success", async () => {
  const missingUi = fakeUi()
  const missing = await runInstallWizard({
    ui: missingUi,
    prompt: fakePrompt({ choices: ["official"], confirms: [true] }),
    latestVersion: () => "2.46.7",
  })
  assert.equal(missing.status, "failed")
  assert.equal(missing.version, null)
  assert.match(text(missingUi), /refusing to report success/)
  assert.doesNotMatch(text(missingUi), /completed with the pinned official installer/)

  const failedUi = fakeUi()
  const failed = await runInstallWizard({
    ui: failedUi,
    prompt: fakePrompt({ choices: ["official"], confirms: [true] }),
    latestVersion: () => "2.46.7",
    installOfficial: () => ({ code: 1, stderr: "installer exited 1" }),
  })
  assert.equal(failed.status, "failed")
  assert.equal(failed.detail, "installer exited 1")
  assert.match(text(failedUi), /Installation failed: installer exited 1/)
  assert.match(text(failedUi), /A nonzero result is never reported as success/)

  const secret = "a".repeat(64)
  const thrownUi = fakeUi()
  const thrown = await runInstallWizard({
    ui: thrownUi,
    prompt: fakePrompt({ choices: ["official"], confirms: [true] }),
    latestVersion: () => "2.46.7",
    installOfficial: () => {
      throw new Error(`failed with secret=${secret}`)
    },
  })
  assert.equal(thrown.status, "failed")
  assert.ok(thrown.detail?.includes("[redacted]"))
  assert.equal(thrown.detail?.includes(secret), false)
  assert.equal(text(thrownUi).includes(secret), false)

  const invalidUi = fakeUi()
  const invalid = await runInstallWizard({
    ui: invalidUi,
    prompt: fakePrompt({ choices: ["official"], confirms: [true] }),
    latestVersion: () => "2.46.7",
    installOfficial: (() => undefined) as unknown as () => { code: number },
  })
  assert.equal(invalid.status, "failed")
  assert.match(invalid.detail ?? "", /returned no result/)
  assert.doesNotMatch(text(invalidUi), /completed with the pinned official installer/)
})

test("manual instructions and result screen cover cancellation, failure and exit codes", () => {
  const ui = fakeUi()
  renderManualInstructions(ui, { pin: OFFICIAL_INSTALLER, details: "Resolved version: 2.46.7\nAsset: spicetify.zip" })
  renderPostManualInstructions(ui)
  const manual = text(ui)
  assert.match(manual, /Resolved version: 2\.46\.7/)
  assert.match(manual, /Asset: spicetify\.zip/)
  assert.match(manual, /spicetify -v/)
  assert.match(manual, /OpenCode TUI/)

  const resultUi = fakeUi()
  renderResultScreen(resultUi, { status: "failed", method: "official", version: null, detail: "boom" })
  assert.match(text(resultUi), /error: Installation failed: boom/)

  assert.equal(formatInstallerSize(8307), "8,307 B")
  assert.equal(resultExitCode("installed"), 0)
  assert.equal(resultExitCode("manual"), 0)
  assert.equal(resultExitCode("dry-run"), 0)
  assert.equal(resultExitCode("cancelled"), 130)
  assert.equal(resultExitCode("declined"), 130)
  assert.equal(resultExitCode("confirmation-required"), 2)
  assert.equal(resultExitCode("failed"), 1)
})
