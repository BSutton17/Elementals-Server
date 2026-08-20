import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { cpSync, existsSync, globSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Packages the exported repository will not have.
 *
 * Relative-import analysis alone is not enough to decide what can come across.
 * A test that does `import { io } from "socket.io-client"` has no relative
 * dependency on the transport layer at all, so a walker that only follows `./`
 * specifiers waves it through — and it then fails at module load on the runner.
 * That is exactly how eight transport tests reached the first export.
 */
const EXPORTED_PACKAGES = new Set(["tsx", "typescript", "@types/node"]);

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * Comments are stripped before scanning for imports.
 *
 * Otherwise prose is read as code: the phrase `"decide what to run" from
 * "run it"` in a doc comment parses as an import of a package named "run it",
 * and the file is condemned for a dependency that does not exist.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function specifiersOf(text) {
  const src = stripComments(text);
  const out = [];
  const patterns = [
    /^[ \t]*import\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^[ \t]*import\s*["']([^"']+)["']/gm,
    /^[ \t]*export\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}

const packageOf = (spec) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

/** Files reached, plus the packages required along the way. */
function closureOf(entries) {
  const files = new Set();
  const packages = new Map();
  const queue = entries.map((f) => resolve(root, f));
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!existsSync(file)) continue;
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (spec[0] !== ".") {
        const name = packageOf(spec);
        if (!BUILTIN.has(spec) && !BUILTIN.has(name) && !packages.has(name)) {
          packages.set(name, relative(root, file).split(sep).join("/"));
        }
        continue;
      }
      const base = resolve(dirname(file), spec);
      for (const c of [base.replace(/[.]js$/, ".ts"), base + ".ts", base, base + "/index.ts"]) {
        if (existsSync(c)) { queue.push(c); break; }
      }
    }
    // A fixture named as a string is still a dependency. Following it here is
    // what lets `config.test.ts` be judged on what its fixture imports —
    // src/config and src/util — rather than on its own three clean imports.
    const rel = relative(root, file).split(sep).join("/");
    if (rel.startsWith("test/")) {
      for (const referenced of referencedPaths(rel)) {
        const target = resolve(root, referenced);
        if (existsSync(target)) queue.push(target);
      }
    }
  }
  return {
    files: [...files].map((f) => relative(root, f).split(sep).join("/")).sort(),
    packages,
  };
}

function closure(entries) {
  return closureOf(entries).files;
}

/**
 * Files a test names as a STRING rather than importing.
 *
 * `runFixture("test/fixtures/printConfig.ts")` is invisible to every form of
 * import analysis, so the fixture stayed behind while the test came across. On
 * the runner it failed with a missing-file error that pointed nowhere near the
 * real cause.
 */
function referencedPaths(file) {
  const text = readFileSync(resolve(root, file), "utf8");
  return [...text.matchAll(/["'](test\/[a-zA-Z0-9_./-]+\.(?:ts|json))["']/g)].map((m) => m[1]);
}

/**
 * Test helpers that boot production infrastructure.
 *
 * `test/helpers/server.ts` imports nothing but `node:child_process`, so it
 * passes every static check — and then spawns `src/index.ts`, which does not
 * exist in the export. Detected by what it launches rather than by name.
 */
function bootsTheServer(file) {
  if (!/^test\/helpers\//.test(file)) return false;
  const text = readFileSync(resolve(root, file), "utf8");
  return /src\/index\.ts/.test(text);
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
for (const t of globSync("test/**/*.test.ts").map((f) => f.split(sep).join("/")).sort()) {
  const { files, packages } = closureOf([t]);
  const reasons = [];

  const outside = [...new Set(files.filter((f) => !allowedForTests(f)))];
  if (outside.length > 0) {
    reasons.push(`imports ${[...new Set(outside.map((f) => f.split("/").slice(0, 2).join("/")))].join(", ")}`);
  }

  const unavailable = [...packages.keys()].filter((p) => !EXPORTED_PACKAGES.has(p));
  if (unavailable.length > 0) reasons.push(`needs ${unavailable.join(", ")}`);

  const booting = files.filter(bootsTheServer);
  if (booting.length > 0) reasons.push(`boots the production server via ${booting.join(", ")}`);

  const dangling = files
    .filter((f) => f.startsWith("test/"))
    .flatMap(referencedPaths)
    .filter((p) => !existsSync(resolve(root, p)));
  if (dangling.length > 0) reasons.push(`references missing ${[...new Set(dangling)].join(", ")}`);

  if (reasons.length === 0) testFiles.push(t);
  else excludedTests.push({ test: t, why: reasons.join("; ") });
}
// Everything the kept tests reach for — support files AND engine modules.
//
// The engine closure cannot be taken from the simulator alone. src/engine's
// roulette, slotMachine and GameLoop are exercised by tests but imported by no
// simulation module, so a sim-only closure leaves them behind and four test
// files die at module resolution on the runner. They are ordinary engine files
// well inside the boundary; the mistake was asking the wrong question about
// which files "the engine" means.
const testClosure = closure(testFiles);
const testSupport = testClosure.filter((f) => f.startsWith("test/") && !f.endsWith(".test.ts"));
const testEngineFiles = testClosure.filter((f) => f.startsWith("src/"));

// --- 3. lay down the tree ---------------------------------------------------
/**
 * Paths the export repository owns and this script must never destroy.
 *
 * `--clean` wipes `src/`, `simulation/` and `test/` so anything deleted
 * upstream does not linger downstream. Two kinds of thing must survive that.
 *
 * The boundary guard asserts properties that are FALSE upstream, where src/net
 * and socket.io legitimately exist, so it can only live downstream.
 *
 * The AI subsystem is developed IN the export repository — that is where the
 * distributed infrastructure and the training environment live — so upstream
 * has no copy to restore it from. Without these entries the first re-export
 * would silently delete the entire subsystem and its tests.
 *
 * A trailing `/` marks a directory: everything beneath it is preserved.
 */
const REPO_OWNED = [
  "test/boundary.test.ts",
  // The AI runtime and (from Phase 2) the NEAT algorithm and training loop.
  "simulation/src/ai/",
  "simulation/src/neat/",
  "simulation/src/training/",
  // Their tests.
  "test/aiBoundary.test.ts",
  "test/aiVisibility.test.ts",
  "test/aiObservation.test.ts",
  "test/aiActions.test.ts",
  "test/aiLegality.test.ts",
  "test/aiModel.test.ts",
  "test/aiRuntime.test.ts",
  // The balance search and its distributed coordinator. These live ONLY
  // downstream — this repository has no CMA-ES — so every export was
  // overwriting them with whatever stale copy the upstream tree happened to
  // carry, silently reverting work. It cost a manual `git checkout` after each
  // of the last three exports before it was worth fixing properly.
  "simulation/src/search/",
  "simulation/src/evaluation/",
  "simulation/src/distributed/",
  "simulation/src/tools/",
  "simulation/src/kaggleSearch.ts",
  // Downstream carries profiling work on the heuristic controller that upstream
  // does not have; exporting it reverted a measured optimisation.
  "simulation/src/personality.ts",
  "test/checkpoint.test.ts",
  "test/evaluation.test.ts",
  "test/evaluationParallel.test.ts",
  "test/distributedProtocol.test.ts",
  "test/distributedQueue.test.ts",
  "test/distributedEquivalence.test.ts",
];

/** Every file beneath a repo-owned path that currently exists downstream. */
const collectOwned = (rel) => {
  const path = join(out, rel);
  if (!existsSync(path)) return [];
  if (!rel.endsWith("/")) return [[rel, readFileSync(path, "utf8")]];
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      const childRel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(child, `${childRel}/`);
      else found.push([childRel, readFileSync(child, "utf8")]);
    }
  };
  walk(path, rel);
  return found;
};

/**
 * A module and a directory of the same name resolve differently under NodeNext
 * (`./ai.js` vs `./ai/index.js`) and are a trap worth refusing outright. The
 * export repository moved `simulation/src/ai.ts` into `simulation/src/ai/
 * baseline.ts`; if upstream has not made the same move, exporting would drop
 * the old module back in beside the directory and leave two live definitions of
 * the same factory.
 *
 * Refuse rather than pick a winner: this is a divergence between the two
 * repositories that a person has to resolve.
 */
const ownedDirs = REPO_OWNED.filter((r) => r.endsWith("/"));
for (const dir of ownedDirs) {
  const sibling = `${dir.slice(0, -1)}.ts`;
  if (existsSync(resolve(root, sibling)) && existsSync(join(out, dir))) {
    console.error(
      `REFUSING TO EXPORT — upstream still has ${sibling}, but the export repo owns ${dir}.`,
    );
    console.error(
      "  Under NodeNext those are different modules and both would be live downstream.",
    );
    console.error(`  Resolve by making the same move upstream: ${sibling} -> ${dir}baseline.ts`);
    process.exit(1);
  }
}

if (clean && existsSync(out)) {
  const preserved = new Map();
  for (const rel of REPO_OWNED) {
    for (const [path, contents] of collectOwned(rel)) preserved.set(path, contents);
  }
  for (const entry of ["src", "simulation", "test"]) rmSync(join(out, entry), { recursive: true, force: true });
  for (const [rel, contents] of preserved) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), contents, "utf8");
  }
}
mkdirSync(out, { recursive: true });

/**
 * Does the export repository own this path?
 *
 * Ownership used to be honoured ONLY under `--clean`, where the preserve/wipe/
 * restore dance consults REPO_OWNED. A plain export skipped that path entirely
 * and copied straight over the top, so every ordinary export silently reverted
 * the downstream-only work — the balance search, the distributed coordinator,
 * PersonalityAI's profiling — and it had to be found and undone by hand
 * afterwards. Checked here so it holds for every export, clean or not.
 */
const isOwned = (rel) =>
  REPO_OWNED.some((owned) => (owned.endsWith("/") ? rel.startsWith(owned) : rel === owned));

const skippedOwned = [];
const copy = (rel) => {
  if (isOwned(rel)) {
    skippedOwned.push(rel);
    return;
  }
  const target = join(out, rel);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(root, rel), target);
};

const simFiles = simClosure.filter((f) => f.startsWith("simulation/"));
const allEngineFiles = [...new Set([...engineFiles, ...testEngineFiles])].sort();
const strayFromTests = allEngineFiles.filter((f) => !ALLOWED_SRC.some((p) => f.startsWith(p)));
if (strayFromTests.length > 0) {
  console.error("REFUSING TO EXPORT — a kept test pulls engine code from outside the boundary:");
  for (const f of strayFromTests) console.error(`  ${f}`);
  process.exit(1);
}
for (const f of [...allEngineFiles, ...simFiles, ...testFiles, ...testSupport]) copy(f);
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

if (skippedOwned.length > 0) {
  console.log(`  kept ${skippedOwned.length} export-repo-owned file(s) untouched`);
}
console.log(`exported to ${out}`);
console.log(`  engine  ${allEngineFiles.length} files  (${sha ?? "unknown"}${dirty ? ", DIRTY" : ""})`);
console.log(`  sim     ${simFiles.length} files`);
console.log(`  tests   ${testFiles.length} kept, ${excludedTests.length} excluded`);
for (const t of excludedTests) console.log(`            - ${t.test.padEnd(30)} ${t.why}`);
