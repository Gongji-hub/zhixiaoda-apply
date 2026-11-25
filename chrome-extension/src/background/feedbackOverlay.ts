import type { FeedbackReviewItem } from './feedbackSummary';

export interface FeedbackQuestion {
  id: string;
  kind: 'information' | 'manual_action';
  blockingDialog?: boolean;
  question: string;
  options?: string[];
  multiple?: boolean;
  replacement?: boolean;
  field?: {
    key: string;
    legacyKey?: string;
    label: string;
    index?: number;
  };
}

export interface FeedbackState {
  taskId: string;
  token: string;
  origin: string;
  title: string;
  detail: string;
  mode: 'running' | 'paused' | 'waiting' | 'done' | 'connect';
  stage?: 0 | 1 | 2 | 3;
  warn?: boolean;
  step: number;
  canCopyTrace?: boolean;
  question?: FeedbackQuestion | null;
  buttonText?: string;
  filledCount?: number;
  unfilledItems?: FeedbackReviewItem[];
  adaptedItems?: { label: string; actualValue: string }[];
}

export interface FeedbackFieldFillResponse {
  ok: boolean;
  status?: 'filled' | 'cascader_next' | 'failed';
  actualValue?: string;
  options?: string[];
  typable?: boolean;
  multiple?: boolean;
  pathPrefix?: string;
  message?: string;
  error?: string;
  rawLabel?: string;
}

export interface FeedbackIssueReport {
  reportedAt: string;
  taskId: string;
  pageHost: string;
  pageUrl: string;
  mode: 'done' | 'paused';
  stage: number | null;
  filledCount: number;
  unfilledFields: { label: string; kind: string }[];
  reasons: string[];
}

export interface FeedbackIssueReportResult {
  ok: boolean;
  savedLocally?: boolean;
  delivered?: boolean;
  summaryText?: string;
  error?: string;
}
export { renderApplicationFloatingEntry } from './feedback/floatingEntry';

/** Serialized by chrome.scripting; all rendering dependencies live in the installed script. */
export function renderApplicationFeedback(state: FeedbackState | null, highlightCSS: string): boolean {
  const render = (
    globalThis as typeof globalThis & {
      __qzRenderFeedback?: (state: FeedbackState | null, css: string) => void;
    }
  ).__qzRenderFeedback;
  if (!render) return state === null;
  render(state, highlightCSS);
  return true;
}
