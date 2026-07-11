// Fixture: registers the global error handlers, then triggers both an unhandled
// promise rejection and an uncaught exception. If the safety net works, the
// process stays alive, prints STILL_ALIVE, and exits cleanly (code 0).
import { registerGlobalErrorHandlers } from "../../src/util/errorHandler.js";

registerGlobalErrorHandlers();

setImmediate(() => {
  Promise.reject(new Error("test-rejection"));
});

setImmediate(() => {
  throw new Error("test-uncaught");
});

setTimeout(() => {
  console.log("STILL_ALIVE");
  process.exit(0);
}, 1000);

