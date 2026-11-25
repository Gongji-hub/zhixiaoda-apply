type LogLevel = 'debug' | 'info' | 'warning' | 'error';

interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warning: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  group: (label: string) => void;
  groupEnd: () => void;
}

let debugMode = false;

const setLoggerDebugEnabled = (enabled: boolean): void => {
  debugMode = enabled;
};

const createLogger = (namespace: string): Logger => {
  const prefix = `[${namespace}]`;

  // Bind console methods directly to preserve call stack and show correct line numbers
  const boundDebug = console.debug.bind(console, prefix);
  const boundInfo = console.info.bind(console, prefix);
  const boundWarn = console.warn.bind(console, prefix);
  const boundError = console.error.bind(console, prefix);
  const boundGroup = console.group.bind(console);
  const boundGroupEnd = console.groupEnd.bind(console);

  return {
    debug: (...args: unknown[]) => {
      if (debugMode) boundDebug(...args);
    },
    info: (...args: unknown[]) => {
      if (debugMode) boundInfo(...args);
    },
    warning: boundWarn,
    error: boundError,
    group: (label: string) => {
      if (debugMode) boundGroup(`${prefix} ${label}`);
    },
    groupEnd: () => {
      if (debugMode) boundGroupEnd();
    },
  };
};

// Create default logger
const logger = createLogger('Agent');

export type { Logger, LogLevel };
export { createLogger, logger, setLoggerDebugEnabled };
