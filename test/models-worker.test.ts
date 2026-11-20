import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomServer } from "../src/room-server.js";
import { Worker } from "../src/worker.js";
import { testTimeout } from "./waits.js";

for (const supported of [false, true]) test(`worker models are capability-gated and outside registration (${supported ? "new" : "old"} server)`, { timeout: testTimeout(30000) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sideband-worker-models-")), fixture = join(directory, "fixture.mjs"), gate = join(directory, "gate"), queries = join(directory, "queries");
  await writeFile(fixture, `import{existsSync,appendFileSync}from'node:fs';import{createInterface}from'node:readline';
const [gate,queries,...args]=process.argv.slice(2);if(args.includes('--version')){console.log('fixture 1');process.exit(0);}
appendFileSync(queries,'query\\n');let frames=[];createInterface({input:process.stdin}).on('line',l=>frames.push(JSON.parse(l)));
let done=false;setInterval(()=>{if(!existsSync(gate))return;
 if(args.includes('--mode')){if(!done){done=true;process.stderr.write('SIDEBAND_MODELS '+JSON.stringify({models:[{selector:'custom/model',name:'Test'}]})+'\\n');}return;}
 for(const v of frames.splice(0)){if(v.method==='initialize')console.log(JSON.stringify({id:v.id,result:{}}));if(v.method==='model/list')console.log(JSON.stringify({id:v.id,result:{data:[{model:'gpt-test'}]}}));if(v.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{request_id:v.request_id,subtype:'success',response:{models:[{value:'sonnet'}]}}}));}
},10);`);
  const server = await RoomServer.start({ host: "127.0.0.1", port: 0 });
  const executable = { command: process.execPath, args: [fixture, gate, queries] };
  const worker = new Worker({ profile: { server: `127.0.0.1:${server.port}`, password: server.password }, root: directory, entry: resolve("dist/src/cli.js"), omp: executable, codex: executable, claude: executable });
  const request = worker.client.request.bind(worker.client); const published: any[] = [];
  worker.client.request = async (method, params) => { if (method === "control.models") published.push(params); const result = await request(method, params); return (method === "control.worker" && !supported ? { registered: true } : result) as never; };
  try {
    await worker.start(); assert.equal(worker.client.state, "on"); assert.equal(published.length, 0, "model queries cannot block registration");
    if (supported) {
      await writeFile(gate, "open"); const end = Date.now() + testTimeout(10000); while (published.length < 3) { if (Date.now() > end) throw new Error("Models were not published"); await new Promise(r => setTimeout(r, 10)); }
      assert.deepEqual(published.map(p => p.harness).sort(), ["claude", "codex", "omp"]); assert.ok(published.every(p => p.catalog.models.length === 1));
    } else { assert.equal(await readFile(queries, "utf8").catch(() => ""), "", "old server receives neither probes nor new requests"); }
    assert.equal(worker.client.state, "on");
  } finally { await worker.close(); await server.close(); assert.ok(directory.startsWith(join(tmpdir(), "sideband-worker-models-"))); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
