export type DesktopTask = { kind: string; state: 'running' | 'done' | 'error' | 'code'; message: string };
type Secrets = { keys: Record<string, string>; hy: unknown };
declare global {
  interface Window {
    tongpinDesktop?: {
      preview(source: string): Promise<string>;
      releasePreview(url: string): Promise<void>;
      createPdf(html: string, title: string, jobId: string): Promise<import('./task-results').StoredDeliverable>;
      cancelPdf(jobId: string): Promise<void>;
      saveDeliverable(id: string, filename: string): Promise<{ saved: boolean }>;
      info(): Promise<{ version: string; platform: string; arch: string; tasks: Record<string, DesktopTask> }>;
      prepare(kind: string): Promise<{ message: string }>;
      login(provider: string): Promise<{ message: string }>;
      submitCode(provider: string, code: string): Promise<void>;
      cancelLogin(provider: string): Promise<void>;
      openData(): Promise<string>;
      loadSecrets(): Promise<Secrets | null>;
      saveSecrets(value: Secrets | null): Promise<void>;
      onTask(listener: (task: DesktopTask) => void): () => void;
    };
  }
}
export function isDesktop() { return typeof window !== 'undefined' && !!window.tongpinDesktop; }
export async function saveDesktopSecrets() {
  if (!isDesktop() || sessionStorage.getItem('tongpin.remember-device') !== 'true') return;
  await window.tongpinDesktop!.saveSecrets({ keys: JSON.parse(sessionStorage.getItem('tongpin.api-keys.v1') || '{}'), hy: JSON.parse(sessionStorage.getItem('tongpin.hy-memory.v1') || 'null') });
}
