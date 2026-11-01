import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findCodex, codexEnv, codexStatus, resetCodexConnection } from '../scripts/codex-chat.mjs';
import { findClaude, claudeEnv, claudeStatus, resetClaudeConnection } from '../scripts/account-connections.mjs';
export function allowedAuthUrl(value, provider) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && (provider === 'codex' ? ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'] : ['claude.ai', 'console.anthropic.com', 'platform.claude.com', 'auth.anthropic.com']).includes(u.hostname); } catch { return false; }
}
export function createAccountLogin({ openExternal, update }) {
  const sessions = new Map();
  return {
    async start(provider) {
      if (!['codex', 'claude-code'].includes(provider)) throw new Error('未知账号。');
      if (sessions.has(provider)) throw new Error('这个账号正在登录，请先完成或取消。');
      const binary = provider === 'codex' ? await findCodex() : await findClaude();
      const cwd = await mkdtemp(join(tmpdir(), 'tongpin-login-'));
      const env = provider === 'codex' ? codexEnv() : claudeEnv(); delete env.CLAUDE_CODE_OAUTH_TOKEN;
      const args = provider === 'codex' ? ['login'] : ['--setting-sources', 'user', 'auth', 'login'];
      const child = spawn(binary, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const entry = { child, cwd }; sessions.set(provider, entry); let buffer = '', opened = false;
      const timer = setTimeout(() => child.kill('SIGTERM'), 600000);
      const notify = (state, message) => update({ kind: provider, state, message });
      notify('running', '正在打开官方登录页面，请在浏览器完成授权…');
      const data = bytes => {
        buffer = (buffer + bytes.toString()).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-12000);
        // Do not persist or forward raw CLI logs, which may contain authentication material.
        for (const match of buffer.matchAll(/https:\/\/[^\s<>"'\x00-\x1f]+(?=[\s<>"'\x00-\x1f])/g)) if (!opened && allowedAuthUrl(match[0], provider)) { opened = true; void openExternal(match[0]).catch(() => notify('error', '无法打开默认浏览器，请重试登录。')); }
        if (provider === 'claude-code' && /paste.*code|enter.*code|粘贴.*码/i.test(buffer)) notify('code', '浏览器授权后，如显示授权码，请粘贴到下方完成登录。');
      };
      child.stdout.on('data', data); child.stderr.on('data', data); child.stdin.on('error', () => {});
      child.once('error', () => notify('error', '登录组件无法启动，请先准备对应组件。'));
      child.once('close', async code => {
        clearTimeout(timer); sessions.delete(provider); await rm(cwd, { recursive: true, force: true });
        if (provider === 'codex') resetCodexConnection(); else resetClaudeConnection();
        const result = await (provider === 'codex' ? codexStatus() : claudeStatus());
        notify(code === 0 && result.authenticated ? 'done' : 'error', code === 0 && result.authenticated ? '账号登录成功，回到模型连接点击检测连接。' : '登录未完成或已取消。原有账号信息未被poie删除。');
      });
      return { message: '已开始官方账号登录，请在浏览器完成。无需输入终端命令。' };
    },
    submit(provider, code) { if (typeof code !== 'string' || code.length > 2000 || /[\r\n]/.test(code)) throw new Error('授权码格式不正确。'); const s = sessions.get(provider); if (!s) throw new Error('登录已结束，请重新开始。'); s.child.stdin.write(code + '\n'); },
    cancel(provider) { sessions.get(provider)?.child.kill('SIGTERM'); },
    stop() { for (const s of sessions.values()) s.child.kill('SIGTERM'); },
  };
}
