import { test } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../src/util/logger.js";

/** Captures everything the logger writes to the console during `fn`. */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const sink = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  console.log = sink as typeof console.log;
  console.warn = sink as typeof console.warn;
  console.error = sink as typeof console.error;
  try {
    fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines;
}

test("suppresses messages below the configured level", () => {
  logger.setLevel("warn");
  const out = capture(() => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
  });
  assert.equal(out.length, 2, "only warn and error should be emitted");
  assert.match(out[0], /\[WARN\]/);
  assert.match(out[1], /\[ERROR\]/);
});

test("emits every level when set to debug", () => {
  logger.setLevel("debug");
  const out = capture(() => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
  });
  assert.equal(out.length, 4);
});

test("formats lines with a timestamp, level, and app prefix", () => {
  logger.setLevel("info");
  const out = capture(() => logger.info("hello world"));
  assert.equal(out.length, 1);
  assert.match(out[0], /^\d{4}-\d{2}-\d{2}T.*\[INFO\] \[Kingdoms\] hello world/);
});
