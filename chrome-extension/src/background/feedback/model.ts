import type { FeedbackState } from '../feedbackOverlay';
import type { FeedbackReviewItem } from '../feedbackSummary';

import type { createCardLayout } from './cardLayout';
import type { createFieldLocation } from './fieldLocation';
export type RowRecord = {
  item: FeedbackReviewItem;
  row: HTMLDivElement;
  syncItem: (nextItem: FeedbackReviewItem) => void;
  closeDrawer: () => void;
};
export function createOverlayModel(state: FeedbackState) {
  return {
    current: state,
    lastTaskId: state.taskId,
    lastMode: state.mode,
    expandedOverride: null as boolean | null,
    isExpanded: false,
    collapsible: true,
    lastQuestionId: '',
    selectedOptions: new Set<string>(),
    feedbackOpen: false,
    feedbackSubmitted: false,
    feedbackBusy: false,
    feedbackReasons: new Set<string>(),
    lastFeedbackSummary: '',
    lastTrackSig: '',
    lastDetailText: '',
    lastFilledCount: state.filledCount || 0,
    resolvedKeys: new Set<string>(),
    resolvedValues: new Map<string, string>(),
    optionCache: new Map<string, { options: string[]; typable?: boolean; multiple?: boolean; pathPrefix?: string }>(),
    openDrawerKey: '',
    currentUnfilled: [] as FeedbackReviewItem[],
    rowRecords: new Map<string, RowRecord>(),
  };
}
export interface OverlayUI {
  model: ReturnType<typeof createOverlayModel>;
  fields: ReturnType<typeof createFieldLocation>;
  view: ReturnType<typeof createCardLayout>;
}
