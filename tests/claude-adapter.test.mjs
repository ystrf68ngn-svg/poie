import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Claude Code uses saved subscription, disables tools/hooks, accepts effort and returns measured usage', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tongpin-claude-test-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const binary = join(folder, 'claude');
  await writeFile(binary, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(process.env.ANTHROPIC_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN||process.env.CLAUDE_CODE_OAUTH_TOKEN!=='inherited-token') process.exit(12);
if(args[args.indexOf('--setting-sources')+1]!=='user') process.exit(15);
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:process.env.TONGPIN_TEST_AUTH_METHOD||'claude.ai'}));process.exit(0);}
if(args[args.indexOf('--tools')+1]!==''||args[args.indexOf('--effort')+1]!=='low'||!args.includes('--no-session-persistence')||!args.includes('--strict-mcp-config')||!args.includes('--setting-sources')||!args.includes('--system-prompt')) process.exit(13);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.includes('hello'))process.exit(14);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'你好，来自 Claude 测试桩',usage:{input_tokens:11,output_tokens:5}}));});
`, { mode: 0o755 });
  process.env.TONGPIN_CLAUDE_BIN = binary; process.env.ANTHROPIC_API_KEY = 'inherited-secret'; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-token';
  const { claudeStatus, runClaudeChat, claudeModels } = await import('../scripts/account-connections.mjs');
  assert.equal((await claudeStatus()).authenticated, true); assert.equal((await claudeModels())[0].id, 'sonnet');
  process.env.TONGPIN_TEST_AUTH_METHOD='oauth_token'; assert.equal((await claudeStatus()).authenticated, true);
  process.env.TONGPIN_TEST_AUTH_METHOD='api_key'; assert.equal((await claudeStatus()).authenticated, false);
  process.env.TONGPIN_TEST_AUTH_METHOD='claude.ai';
  const result = await runClaudeChat({ model: 'sonnet', reasoning: 'low', system: '自然聊天', messages: [{ role: 'user', content: 'hello' }], includeUsage: true }, AbortSignal.timeout(5000));
  assert.match(result.text, /你好/); assert.equal(result.usage.totalTokens, 16);
});
