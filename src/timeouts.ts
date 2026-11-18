// Completion/ready signals finish work immediately. These are load-tolerant backstops.
export const STARTUP_TIMEOUT_MS = 5 * 60_000;
export const HANDSHAKE_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 2 * 60_000;
export const CONTROL_TIMEOUT_MS = 6 * 60_000;
export const COMMAND_TIMEOUT_MS = 10 * 60_000;
export const INSTALL_TIMEOUT_MS = 20 * 60_000;
export const SHUTDOWN_TIMEOUT_MS = 30_000;
export const ROLLOUT_TIMEOUT_MS = 2 * 60 * 60_000;
