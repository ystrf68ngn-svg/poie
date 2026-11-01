export function isStopRequest(text: string): boolean {
  const input = text.trim().replace(/^(@[^\s，,。:：]+[\s，,。:：]*)+/u, '').replace(/[\s。！!.,，?？]+$/u, '').toLowerCase();
  return /^(?:(?:请|麻烦)?(?:大家|你们|所有人)?(?:先)?\s*)?(?:停|停下|停下来|停一停|停一下|停止|暂停|结束讨论|停止讨论|暂停讨论|停止聊天|停止协作|停止全部|全部停止|别聊了|不要再聊了|不要继续了|stop(?:\s+(?:now|discussion|all))?)(?:吧|一下)?$/u.test(input);
}
export function discussionDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('已停止', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function runDiscussion(options: {
  members: string[]; rounds: number | null; signal: AbortSignal;
  speak: (memberId: string, turn: number, round: number) => Promise<void>;
  between?: (signal: AbortSignal) => Promise<void>;
}) {
  const members = [...new Set(options.members)];
  if (members.length < 2) throw new Error('自由讨论至少需要两位已连接的成员。');
  if (options.rounds !== null && (!Number.isInteger(options.rounds) || options.rounds < 1 || options.rounds > 20)) throw new Error('讨论轮数应为 1–20，或选择直到停止。');
  const total = options.rounds === null ? Infinity : options.rounds * members.length;
  for (let i = 0; i < total; i++) {
    options.signal.throwIfAborted();
    await options.speak(members[i % members.length], i + 1, Math.floor(i / members.length) + 1);
    options.signal.throwIfAborted();
    if (i + 1 < total) await (options.between || (signal => discussionDelay(1500, signal)))(options.signal);
  }
}
