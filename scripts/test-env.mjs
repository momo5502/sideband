import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Never let test workers write SQLite metadata into the developer's real profile.
const testState = mkdtempSync(join(tmpdir(), "sideband-test-state-"));
process.env.SIDEBAND_STATE_DIR = testState;
process.once("exit", () => {
  if (!testState.startsWith(join(tmpdir(), "sideband-test-state-"))) return;
  try { rmSync(testState, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* An owned child may still be closing after a failed test. */ }
});
// Tests use local fixtures, never a developer/CI machine's authenticated external proxy.
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
  delete process.env[name]; delete process.env[name.toLowerCase()];
}
