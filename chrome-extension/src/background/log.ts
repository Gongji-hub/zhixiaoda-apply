/// <reference types="vite/client" />

type LogLevel = 'debug' | 'info' | 'warning' | 'error';

interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warning: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  group: (label: string) => void;
  groupEnd: () => void;
}

const createLogger = (namespace: string): Logger => {
  const prefix = `[${namespace}]`;

  // The inherited debug arguments may contain complete resumes and field values.
  // UI progress events are separate and remain available during execution.
  const quiet = () => {};
  return {
    debug: quiet, info: quiet, warning: quiet, group: quiet, groupEnd: quiet,
    error: () => console.error(prefix, '操作失败，请查看侧栏。'),
  };
};

// Create default logger
const logger = createLogger('Agent');

export type { Logger, LogLevel };
export { createLogger, logger };
