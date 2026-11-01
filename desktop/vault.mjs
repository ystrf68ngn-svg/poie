import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function createVault(path, crypto) {
  let queue = Promise.resolve();
  const save = value => {
    queue = queue.catch(() => {}).then(async () => {
      if (value === null) { await rm(path, { force: true }); return; }
      const text = JSON.stringify(value);
      if (!value || typeof value !== 'object' || text.length > 32000) throw new Error('连接配置格式无效。');
      if (!await crypto.isAsyncEncryptionAvailable()) throw new Error('系统加密存储不可用，密钥仅在本次使用期间保留。');
      const encrypted = await crypto.encryptStringAsync(text), temp = path + '.' + randomUUID();
      try { await writeFile(temp, encrypted, { mode: 0o600 }); await rename(temp, path); }
      finally { await rm(temp, { force: true }); }
    });
    return queue;
  };
  return {
    save,
    async load() {
      let bytes;
      try { bytes = await readFile(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      // Never touch Keychain/DPAPI on startup unless the user previously chose to save keys.
      if (!await crypto.isAsyncEncryptionAvailable()) throw new Error('请解锁系统密钥存储后重试。');
      const decrypted = await crypto.decryptStringAsync(bytes), value = JSON.parse(decrypted.result);
      if (decrypted.shouldReEncrypt) await save(value);
      return value;
    },
  };
}
