import type { FeedbackReviewItem } from '../feedbackSummary';
import { createRowRecord } from './fieldRow';
import { type OverlayUI } from './model';

export const renderUnfilledList = (ui: OverlayUI, items: FeedbackReviewItem[]) => {
  const incomingKeys = new Set(items.map(i => i.key));
  for (const [key, rec] of ui.model.rowRecords) {
    if (!incomingKeys.has(key)) {
      rec.row.remove();
      ui.model.rowRecords.delete(key);
      if (ui.model.openDrawerKey === key) ui.model.openDrawerKey = '';
    }
  }
  let cursor: ChildNode | null = ui.view.unfilledList.firstChild;
  for (const item of items) {
    let rec = ui.model.rowRecords.get(item.key);
    if (rec) {
      rec.syncItem(item);
    } else {
      rec = createRowRecord(ui, item);
      ui.model.rowRecords.set(item.key, rec);
    }
    if (rec.row !== cursor) {
      ui.view.unfilledList.insertBefore(rec.row, cursor);
    } else {
      cursor = cursor.nextSibling;
    }
  }
};
