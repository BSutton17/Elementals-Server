import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every test file that spawns a server must use its own port.
 *
 * ⚠️ THIS EXISTS BECAUSE THE FAILURE IT CATCHES IS ALMOST UNREADABLE. `node
 * --test` runs files in parallel, so two files sharing a port means whichever
 * binds second never starts and never logs that it is listening. That surfaces
 * as a start-up TIMEOUT — which looks like slowness, tempts you to raise the
 * timeout, and passes every time you run the file on its own.
 *
 * A named assertion here turns twenty minutes of confusion into one line.
 */

// `fileURLToPath`, not `url.pathname` — this project lives under "Coding
// Projects", and a raw pathname leaves the space percent-encoded.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** This file's own name — its example below would otherwise match itself. */
const SELF = "portsUnique.test.ts";

test("no two test files use the same server port", async () => {
  const files = (await readdir(TEST_DIR)).filter(
    (f) => f.endsWith(".test.ts") && f !== SELF,
  );
  const byPort = new Map<string, string[]>();

  for (const file of files) {
    const source = await readFile(join(TEST_DIR, file), "utf8");
    // Matches the `const PORT` declaration every spawning file uses.
    const match = source.match(/const PORT\s*=\s*["'](\d+)["']/);
    if (!match) continue;
    const port = match[1]!;
    byPort.set(port, [...(byPort.get(port) ?? []), file]);
  }

  assert.ok(byPort.size > 0, "the scan should find some ports, or it is not working");

  const clashes = [...byPort.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(
    clashes,
    [],
    `these files share a port and will intermittently fail to start:\n` +
      clashes.map(([port, f]) => `  ${port}: ${f.join(", ")}`).join("\n"),
  );
});
