// Fixture: imports the config system and prints the resolved config as JSON so
// tests can assert environment-dependent loading in an isolated process.
// Only JSON is written to stdout; any config warnings go to stderr.
import { config } from "../../src/config/index.js";

process.stdout.write(JSON.stringify(config));
