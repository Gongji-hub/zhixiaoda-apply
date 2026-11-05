import type { MessageCheckpoint } from './agent/messages/service';
import type { FormReviewEntry } from './agent/formReview';
import type { UserQuestion } from './agent/userInput';
import type { ActionResult } from './agent/types';

export interface ApplicationProgress {
  task: string;
  messages: MessageCheckpoint;
  review: FormReviewEntry[];
  actionResults: Partial<ActionResult>[];
  nSteps: number;
  pendingQuestion: UserQuestion | null;
}
export interface ApplicationCheckpoint {
  version: 1;
  taskId: string;
  updatedAt: number;
  status: string;
  target: { tabId: number; windowId: number; origin: string; jobId: string | null; url: string };
  source: { name: string; hash: string; userId?: string; profileVersion?: number };
  progress: ApplicationProgress;
}
const KEY = 'jobAgentApplicationCheckpoint';
let writes: Promise<void> = Promise.resolve();

export function canRestoreApplication(
  saved: ApplicationCheckpoint,
  target: ApplicationCheckpoint['target'],
  explicitlyRebind = false,
): boolean {
  return (
    saved.version === 1 &&
    saved.target.windowId === target.windowId &&
    saved.target.jobId === target.jobId &&
    (explicitlyRebind || (saved.target.tabId === target.tabId && saved.target.origin === target.origin))
  );
}

/** Only the extension's trusted surfaces may read personal application context. */
export async function readApplicationCheckpoint(): Promise<ApplicationCheckpoint | null> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await writes;
  const saved = (await chrome.storage.local.get(KEY))[KEY] as ApplicationCheckpoint | undefined;
  if (saved?.updatedAt && Date.now() - saved.updatedAt > 7 * 86400000) {
    await chrome.storage.local.remove(KEY);
    return null;
  }
  if (
    !saved ||
    saved.version !== 1 ||
    !saved.progress?.messages?.messages?.length ||
    !saved.target ||
    !saved.source ||
    !Number.isFinite(saved.updatedAt) ||
    Date.now() - saved.updatedAt > 7 * 86400000
  )
    return null;
  return saved;
}

export async function saveApplicationCheckpoint(saved: ApplicationCheckpoint): Promise<void> {
  if (new TextEncoder().encode(JSON.stringify(saved)).length > 1500000)
    throw new Error('本轮上下文超过进度保存上限，请结束后开始新一轮。');
  const next = writes
    .catch(() => {})
    .then(async () => {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      await chrome.storage.local.set({ [KEY]: saved });
    });
  writes = next;
  await next;
}

export async function discardApplicationCheckpoint(): Promise<void> {
  writes = writes.catch(() => {}).then(() => chrome.storage.local.remove(KEY));
  await writes;
}
