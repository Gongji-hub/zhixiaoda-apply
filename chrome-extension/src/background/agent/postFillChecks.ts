import type { DOMElementNode } from '../browser/dom/views';
import { type BrowserState } from '../browser/views';
import { formFieldReference, type FormReviewEntry } from './formReview';
import { type AgentContext } from './types';

export function isAbortStopError(context: AgentContext, error: unknown): boolean {
  if (context.stopped || context.controller.signal.aborted) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return msg === '操作已取消' || msg === '操作已取消。' || msg === '操作已停止。';
}

export function findLiveControlNode(
  state: BrowserState,
  entry: FormReviewEntry,
): { node: DOMElementNode; index: number } | null {
  const matchesEntry = (idx: number, candidate: DOMElementNode): boolean => {
    const ref = formFieldReference(state, candidate, idx);
    return (
      ref.key === entry.key ||
      ref.legacyKey === entry.key ||
      Boolean(entry.legacyKey && (ref.key === entry.legacyKey || ref.legacyKey === entry.legacyKey))
    );
  };
  const byIndex = state.selectorMap.get(entry.index);
  if (byIndex && matchesEntry(entry.index, byIndex)) {
    return { node: byIndex, index: entry.index };
  }
  for (const [idx, candidate] of state.selectorMap.entries()) {
    if (matchesEntry(idx, candidate)) {
      return { node: candidate, index: idx };
    }
  }
  return null;
}

export function isObscuredWriteResult(result: { code?: string; message?: string } | null | undefined): boolean {
  if (!result) return false;
  return result.code === 'CLICK_TARGET_OBSCURED' || Boolean(result.message?.includes('CLICK_TARGET_OBSCURED'));
}
