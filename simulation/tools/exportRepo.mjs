import { execFileSync } from "node:child_process";
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Exports the simulator into a standalone, cloneable repository.
 *
 * The simulator imports 54 modules from the game's `src/` tree and nothing at
 * all from `src/net/` — the package boundary already exists, it has simply
 * never been cut. This walks the real import graph rather than trusting that
 * observation to stay true: if someone adds an import to the transport layer,
 * the export fails loudly instead of shipping a repo that cannot install.
 *
 * The engine travels as a vendored copy with its upstream commit recorded in
 * `engine-source.json`. That marker is what keeps a cloud reading comparable to
 * a local one — without it, provenance would stamp the EXPORT repo's commit and
 * the two would refuse to be compared despite describing the identical game.
 *
 *   node simulation/tools/exportRepo.mjs --out ../../Simulation
 */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const root = process.cwd();
const out = resolve(root, arg("out", "../Simulation"));
const clean = argv.includes("--clean");

/** Directories of the game engine the simulator is allowed to depend on. */
const ALLOWED_SRC = ["src/data/", "src/engine/", "src/match/"];

const IMPORT_RE = /(?:from|import)\s+["']([^"']+)["']/g;

function closure(entries) {
  const seen = new Set();
  const queue = entries.map((f) => resolve(root, f));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1];
      if (!spec || spec[0] !== ".") continue;
      const base = resolve(dirname(file), spec);
      for (const c of [base.replace(/[.]js$/, ".ts"), base + ".ts", base, base + "/index.ts"]) {
        if (existsSync(c)) { queue.push(c); break; }
      }
    }
  }
  return [...seen].map((f) => relative(root, f).split(sep).join("/")).sort();
}

// --- 1. what the simulator needs -------------------------------------------
const simEntries = [
  ...globSync("simulation/src/**/*.ts"),
  ...globSync("simulation/src/**/*.mjs"),
].map((f) => f.split(sep).join("/"));

const simClosure = closure(simEntries);
const engineFiles = simClosure.filter((f) => f.startsWith("src/"));
const stray = engineFiles.filter((f) => !ALLOWED_SRC.some((p) => f.startsWith(p)));
if (stray.length > 0) {
  console.error("REFUSING TO EXPORT — the simulator now imports outside the engine boundary:");
  for (const f of stray) console.error(`  ${f}`);
  console.error("\nEither remove the dependency or widen ALLOWED_SRC deliberately.");
  process.exit(1);
}

// --- 2. tests that stay inside the boundary --------------------------------
const allowedForTests = (f) =>
  f.startsWith("simulation/") || f.startsWith("test/") || ALLOWED_SRC.some((p) => f.startsWith(p));

const testFiles = [];
const excludedTests = [];
for (const t of globSync("test/**/*.test.ts").map((f) => f.split(sep).join("/"))) {
  const outside = closure([t]).filter((f) => !allowedForTests(f));
  if (outside.length === 0) testFiles.push(t);
  else excludedTests.push(t);
}
// Support files the kept tests reach for.
const testSupport = closure(testFiles).filter(
  (f) => f.startsWith("test/") && !f.endsWith(".test.ts"),
);

// --- 3. lay down the tree ---------------------------------------------------
if (clean && existsSync(out)) {
  for (const entry of ["src", "simulation", "test"]) rmSync(join(out, entry), { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

const copy = (rel) => {
  const target = join(out, rel);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(root, rel), target);
};

const simFiles = simClosure.filter((f) => f.startsWith("simulation/"));
for (const f of [...engineFiles, ...simFiles, ...testFiles, ...testSupport]) copy(f);
// The worker bootstrap is loaded by URL at runtime, so it never appears in the
// static import graph. Missing it would break every parallel evaluation.
for (const f of globSync("simulation/src/**/*.mjs").map((x) => x.split(sep).join("/"))) copy(f);

// --- 4. engine identity -----------------------------------------------------
const git = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const sha = git(["rev-parse", "HEAD"]);
const dirty = (git(["status", "--porcelain"]) ?? "").length > 0;
if (dirty) {
  console.warn("WARNING: exporting from a dirty working tree — engineDirty will be recorded as true.");
}
mkdirSync(join(out, "simulation"), { recursive: true });
writeFileSync(
  join(out, "simulation", "engine-source.json"),
  JSON.stringify(
    {
      engineSha: sha ?? "unknown",
      engineDirty: dirty,
      exportedAt: new Date().toISOString(),
      upstream: "elementals/Server",
      note:
        "Identity of the game engine vendored into this repository. Provenance " +
        "reads this instead of this repo's own commit, so readings taken here " +
        "stay comparable with readings taken upstream.",
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(`exported to ${out}`);
console.log(`  engine  ${engineFiles.length} files  (${sha ?? "unknown"}${dirty ? ", DIRTY" : ""})`);
console.log(`  sim     ${simFiles.length} files`);
console.log(`  tests   ${testFiles.length} kept, ${excludedTests.length} excluded (transport-dependent)`);
for (const t of excludedTests) console.log(`            - ${t}`);
