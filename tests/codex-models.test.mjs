import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('Codex model/list handshake returns real model IDs, default and supported effort metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tongpin-models-test-')), binary = join(dir, 'codex'); const previous = process.env.TONGPIN_CODEX_BIN;
  t.after(async () => { if (previous === undefined) delete process.env.TONGPIN_CODEX_BIN; else process.env.TONGPIN_CODEX_BIN = previous; await rm(dir, { recursive: true, force: true }); });
  await writeFile(binary, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nif(process.argv[2]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}\nlet initialized=false;createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);if(req.method==='initialize') console.log(JSON.stringify({id:req.id,result:{}}));if(req.method==='initialized') initialized=true;if(req.method==='model/list'){if(!initialized)process.exit(2);console.log(JSON.stringify({id:req.id,result:{data:[{model:'actual-model',displayName:'Actual Model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],nextCursor:null}}));}});\n`);
  await chmod(binary, 0o700); process.env.TONGPIN_CODEX_BIN = binary;
  const { codexModels } = await import('../scripts/codex-chat.mjs');
  const models = await codexModels(); assert.equal(models[0].id, 'actual-model'); assert.deepEqual(models[0].reasoningEfforts, ['low', 'high']); assert.equal(models[0].isDefault, true);
});
