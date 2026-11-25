import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelDiscovery, modelEntries } from "../src/model-discovery.js";
import { modelCatalog, launchSpec } from "../src/orchestration-protocol.js";
import { testTimeout } from "./waits.js";
import { projectOmpModels } from "../src/omp-model-probe.js";

test("model metadata is projected, bounded and preserves per-model reasoning levels", () => {
  assert.deepEqual(modelEntries("codex", [{ id: "internal", model: "gpt-test", displayName: "GPT test", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "none" }, { reasoningEffort: "ultra" }], defaultReasoningEffort: "ultra", secret: "not forwarded" }, { model: "hidden", hidden: true }]),
    [{ id: "gpt-test", label: "GPT test", efforts: ["off", "ultra"], defaultEffort: "ultra", isDefault: true }]);
  assert.deepEqual(modelEntries("claude", [{ value: "default" }, { value: "haiku", displayName: "Haiku", supportedEffortLevels: [] }]), [{ id: "haiku", label: "Haiku", efforts: [] }]);
  assert.deepEqual(modelEntries("omp", [{ provider: "custom", id: "model", name: "Custom", thinking: ["low", "high"] }]), [{ id: "custom/model", label: "Custom", efforts: ["low", "high"] }]);
  assert.deepEqual(modelEntries("omp", projectOmpModels([{ provider: "custom", id: "reasoning", name: "Reasoning", reasoning: true, thinking: { efforts: ["high", "max"] } }, { provider: "custom", id: "unverified", reasoning: true, thinking: { unverified: true, efforts: ["high"] } }])),
    [{ id: "custom/reasoning", label: "Reasoning", efforts: ["high", "max"] }, { id: "custom/unverified", label: "custom/unverified", efforts: [] }]);
  assert.equal(launchSpec({ name: "test", harness: "codex", effort: "ultra" }).effort, "ultra");
  assert.throws(() => launchSpec({ name: "test", harness: "omp", effort: "ultra" }));
  const bounded = modelEntries("omp", Array.from({ length: 2000 }, (_, i) => ({ selector: `provider/${i}`.padEnd(250, "m"), name: "Model".repeat(32) })));
  assert.ok(bounded.length < 1000); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 200 * 1024);
  assert.doesNotThrow(() => modelCatalog({ models: bounded, at: Date.now() }));
  assert.throws(() => modelCatalog({ models: [{ id: "bad", label: "bad", token: "secret" }], at: Date.now() }));
});

test("no-prompt probes use native protocols, paginate, discard account data and retain cache on failure", { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-model-probes-")), fixture = join(directory, "cli.mjs"), log = join(directory, "requests.jsonl"), fail = join(directory, "fail");
  await writeFile(fixture, `import{appendFileSync,existsSync}from'node:fs';import{createInterface}from'node:readline';
const[harness,log,fail,...args]=process.argv.slice(2);appendFileSync(log,JSON.stringify({harness,args})+'\\n');
if(existsSync(fail))process.exit(1);
if(harness==='omp'||harness==='pi'){process.stderr.write('noise\\nSIDEBAND_MODELS '+JSON.stringify({models:[{selector:'custom/model',name:'OMP',thinking:['low','high']}]})+'\\n');}
createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);appendFileSync(log,JSON.stringify({harness,frame:v})+'\\n');
 if(v.type==='user'||v.method==='turn/start')throw Error('must never prompt');
 if(harness==='claude')console.log(JSON.stringify({type:'control_response',response:{request_id:v.request_id,subtype:'success',response:{models:[{value:'sonnet',displayName:'Sonnet',supportedEffortLevels:['low','high']}],account:{email:'must-not-leak'},commands:['private']}}}));
 if(harness==='codex'&&v.id==='initialize')console.log(JSON.stringify({id:v.id,result:{}}));
 if(harness==='codex'&&v.method==='model/list')console.log(JSON.stringify({id:v.id,result:{data:[{model:v.params.cursor?'second':'first',displayName:'Codex',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]}],nextCursor:v.params.cursor?null:'page2'}}));
});`);
  const discovery = new ModelDiscovery(harness => ({ command: process.execPath, args: [fixture, harness, log, fail] }), directory, resolve("dist/src/cli.js"));
  try {
    const [omp, claude, codex, pi] = await Promise.all([discovery.refresh("omp"), discovery.refresh("claude"), discovery.refresh("codex"), discovery.refresh("pi")]);
    assert.deepEqual(pi.models.map(m => m.id), ["custom/model"]);
    assert.deepEqual(omp.models.map(m => m.id), ["custom/model"]); assert.deepEqual(claude.models.map(m => m.id), ["sonnet"]); assert.deepEqual(codex.models.map(m => m.id), ["first", "second"]);
    assert.doesNotMatch(JSON.stringify([omp, claude, codex]), /must-not-leak|private|account|commands/);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(l => JSON.parse(l));
    assert.ok(requests.find(r => r.harness === "omp" && r.args?.includes("--no-session") && r.args?.includes("-e")));
    assert.ok(requests.find(r => r.harness === "claude" && r.args?.includes("--strict-mcp-config")));
    assert.equal(requests.filter(r => r.frame?.method === "model/list").length, 2);
    const piArgs = requests.find(r => r.harness === "pi" && r.args)?.args; assert.ok(piArgs.includes("--no-session")); assert.ok(!piArgs.includes("--no-ui"));
    await writeFile(fail, "yes"); const retry = discovery.refresh("claude"); assert.equal(retry, discovery.refresh("claude"), "concurrent probes coalesce");
    const failed = await retry; assert.deepEqual(failed.models, claude.models); assert.match(failed.error!, /discovery failed/);
  } finally { await discovery.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-model-probes-"))); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
