const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
export const projectPiModels = (models) => models.slice(0, 1000).map((model) => ({ selector: `${model.provider}/${model.id}`, name: model.name,
    efforts: model.reasoning ? levels.filter(level => model.thinkingLevelMap?.[level] !== null) : [] }));
export default function piModels(api) {
    api.on("session_start", async (_event, ctx) => {
        try {
            const models = projectPiModels(await ctx.modelRegistry.getAvailable());
            process.stderr.write(`\nSIDEBAND_MODELS ${JSON.stringify({ models })}\n`);
        }
        catch {
            process.stderr.write('\nSIDEBAND_MODELS {"error":true}\n');
        }
    });
}
//# sourceMappingURL=pi-model-probe.js.map