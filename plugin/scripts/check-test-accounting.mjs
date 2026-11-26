import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = join(dirname(here), "..");
const buckets = ["test:fast", "test:bun", "test:vt"];
const testFile = /\.test\.(?:[cm]?[jt]s|[jt]sx)$/;
// No shell syntax, glob, quoting, or path traversal: npm invokes these files
// directly by their exact names on Windows.
const explicitPath = /^tests\/(?:[a-z0-9_-]+\/)*[a-z0-9_-][a-z0-9_.-]*$/i;

export function inventoryTests(base = join(root, "tests")) {
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && testFile.test(entry.name))
    .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

export function parseBucket(name, script) {
  const [node, flag, ...paths] = (script ?? "").trim().split(/[ \t]+/);
  if (node !== "node" || flag !== "--test" || paths.length === 0 ||
      paths.some((path) => !explicitPath.test(path) || !testFile.test(path))) {
    throw new Error(`${name} must be a single 'node --test' command listing explicit test paths`);
  }
  return paths.map((path) => path.slice("tests/".length));
}

export function accountTests(files, scripts) {
  if (scripts?.test !== "npm run test:fast") {
    throw new Error("npm test must delegate to test:fast");
  }
  const counts = new Map(buckets.map((name) => [name, parseBucket(name, scripts[name])]));
  const entries = [...counts.values()].flat();
  const actual = new Set(files);
  const assigned = new Set(entries);
  const duplicates = entries.filter((file, index) => entries.indexOf(file) !== index);
  const missing = files.filter((file) => !assigned.has(file));
  const unknown = [...assigned].filter((file) => !actual.has(file));
  if (duplicates.length || missing.length || unknown.length) {
    throw new Error(JSON.stringify({ duplicates, missing, unknown }));
  }
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  try {
    const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const files = inventoryTests();
    const counts = accountTests(files, scripts);
    const summary = buckets.map((name) => `${name.slice(5)}=${counts.get(name).length}`);
    console.log(`test accounting ok: ${files.length} suites, ${summary.join(" ")}`);
  } catch (error) {
    console.error(`test accounting failed: ${error.message}`);
    process.exitCode = 1;
  }
}
