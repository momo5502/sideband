/** Loaded only by the worker's no-session metadata probe; never installed globally. */
export function projectOmpModels(available: any[]): object[] {
  return available.slice(0, 1000).map(model => ({ selector: `${model.provider}/${model.id}`, name: model.name,
    thinking: model.reasoning && !model.thinking?.unverified && Array.isArray(model.thinking?.efforts) ? model.thinking.efforts : model.thinking || !model.reasoning ? [] : undefined }));
}
export default function probe(api: any): void {
  api.on("session_start", async (_event: unknown, ctx: any) => {
    try {
      const registry = ctx.modelRegistry;
      await registry.awaitBackgroundRefresh?.();
      const available = registry.getAvailable();
      const models = projectOmpModels(available);
      // stdout belongs to OMP's RPC transport. Never serialize full provider/auth objects.
      process.stderr.write(`\nSIDEBAND_MODELS ${JSON.stringify({ models })}\n`);
    } catch { process.stderr.write('\nSIDEBAND_MODELS {"error":true}\n'); }
  });
}
