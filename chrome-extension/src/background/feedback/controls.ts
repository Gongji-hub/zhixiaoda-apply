import type { FeedbackReviewItem } from '../feedbackSummary';

export const sendRuntimeMessage = <T = Record<string, unknown>>(
  payload: Record<string, unknown>,
): Promise<T | null> => {
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    return Promise.resolve(null);
  }
  try {
    return Promise.resolve(chrome.runtime.sendMessage(payload))
      .then(res => (res ?? null) as T | null)
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
};

export const inferEffectiveKind = (
  item: FeedbackReviewItem,
  liveEl: Element | null,
): 'text' | 'textarea' | 'select' | 'combobox' | 'checkbox' | 'radio' | 'date' | 'file' | 'unknown' => {
  if (item.kind === 'attachment') return 'file';
  if (item.kind === 'consent') return 'checkbox';
  if (item.controlKind && item.controlKind !== 'unknown') {
    if (item.controlKind === 'toggle') return 'checkbox';
    if (item.controlKind === 'text' && liveEl) {
      if (liveEl.closest('.el-cascader, .ant-cascader, .el-select, .ant-select, [role="combobox"]')) {
        return 'combobox';
      }
      if (liveEl.closest('.el-date-editor, .ant-picker')) {
        return 'date';
      }
    }
    return item.controlKind;
  }
  if (item.options && item.options.length > 0) return 'combobox';
  if (item.dateFormat) return 'date';
  if (!liveEl) return 'text';
  if (liveEl instanceof HTMLSelectElement) return 'select';
  if (liveEl instanceof HTMLTextAreaElement) return 'textarea';
  if (liveEl instanceof HTMLInputElement && liveEl.type === 'file') return 'file';
  if (liveEl instanceof HTMLInputElement && (liveEl.type === 'checkbox' || liveEl.type === 'radio')) {
    return liveEl.type;
  }
  if (
    liveEl.getAttribute('role') === 'combobox' ||
    Boolean(
      liveEl.closest(
        '.el-select, .el-cascader, .ant-select, .ant-cascader, .atsx-select, .ud__select, .phoenix-select, [role="combobox"]',
      ),
    )
  ) {
    return 'combobox';
  }
  if (
    (liveEl instanceof HTMLInputElement && (liveEl.type === 'date' || liveEl.type === 'month')) ||
    Boolean(liveEl.closest('.el-date-editor, .ant-picker, [class*="datepicker" i], [class*="date-picker" i]'))
  ) {
    return 'date';
  }
  return 'text';
};

export const isPureReadOnlyDisplay = (item: FeedbackReviewItem, liveEl: Element | null): boolean => {
  if (item.required || item.kind !== 'missing') return false;
  if (inferEffectiveKind(item, liveEl) !== 'text') return false;
  if (liveEl instanceof HTMLInputElement && liveEl.readOnly) {
    const ph = (liveEl.getAttribute('placeholder') || '').trim();
    if (!/请选择|选择|select/i.test(ph)) return true;
  }
  return false;
};
