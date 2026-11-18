// Backstops, not sleeps: ready/completion signals still finish tests immediately.
const scale = Number(process.env.SIDEBAND_TEST_TIMEOUT_SCALE ?? "4");
if (!Number.isFinite(scale) || scale < 1 || scale > 60) throw new Error("SIDEBAND_TEST_TIMEOUT_SCALE must be between 1 and 60.");
export const testTimeout = (milliseconds: number) => Math.ceil(milliseconds * scale);
