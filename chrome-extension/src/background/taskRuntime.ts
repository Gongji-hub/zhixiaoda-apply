import 'webextension-polyfill';
import type { Executor } from './agent/executor';
import { type ApplicationCheckpoint } from './applicationSession';
import BrowserContext from './browser/context';
import { createLogger } from './log';

export const logger = createLogger('background');
export const browserContext = new BrowserContext({});
export const sessionMetadata = new WeakMap<
  Executor,
  Omit<ApplicationCheckpoint, 'progress' | 'updatedAt' | 'status'>
>();

// Track the active application and its short-lived field review session.
interface TaskRuntime {
  currentExecutor: Executor | null;
  postTaskExecutor: Executor | null;
  postTaskIdleTimer: ReturnType<typeof setTimeout> | null;
  taskRunning: boolean;
  pauseRequested: boolean;
  questionAskedUrl: string;
}
export const run: TaskRuntime = {
  currentExecutor: null,
  postTaskExecutor: null,
  postTaskIdleTimer: null,
  taskRunning: false,
  pauseRequested: false,
  questionAskedUrl: '',
};
