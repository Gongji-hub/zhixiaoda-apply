/**
 * How a calendar popup is closed without choosing a value. Every family must declare
 * the method verified against the real component: the antd5 picker ignores synthetic
 * outside clicks once its input has lost focus, and an undeclared method left that
 * popup open and blocked every later field. Use `escalate` only when no method has
 * been verified; dismissal then tries the generic safe sequence.
 */
export type CalendarDismiss =
  /** Return focus to the owning input, then blur it (rc-picker: antd 4/5). */
  | { kind: 'blur' }
  /** Synthetic mousedown/click outside the input and popup. */
  | { kind: 'outside' }
  /** Escape on the focused calendar element itself, never on the page. */
  | { kind: 'escape'; popup: string; selector: string }
  /** Click the field's own toggle element. */
  | { kind: 'toggle'; selector: string }
  | { kind: 'escalate' };

/** Browser-side calendar selectors, keyed by component family rather than hostname. */
export const CALENDAR_ADAPTERS = {
  antLegacy: {
    root: '.ant-calendar-picker',
    popup: '.ant-calendar-picker-container',
    dismiss: { kind: 'escape', popup: '.ant-calendar-picker-container', selector: '.ant-calendar[tabindex]:not(input)' },
    allowClippedPanel: true,
    edit: 'input.ant-calendar-input:not([readonly]):not([disabled])',
    invalid: '.ant-calendar-input-invalid, [aria-invalid="true"]',
    panels: { year: '.ant-calendar-year-panel', month: '.ant-calendar-month-panel', day: '.ant-calendar-date-panel' },
    cells: { year: '.ant-calendar-year-panel-year', month: '.ant-calendar-month-panel-month', day: '.ant-calendar-date' },
    outsidePeriod: '.ant-calendar-last-month-cell, .ant-calendar-next-month-btn-day, .ant-calendar-year-panel-last-decade-cell, .ant-calendar-year-panel-next-decade-cell',
    disabled: '[class*="disabled"], [aria-disabled="true"]',
    yearHeader: '.ant-calendar-year-select, .ant-calendar-month-panel-year-select, .ant-calendar-year-panel-decade-select',
    monthHeader: '.ant-calendar-month-select',
    prev: ['.ant-calendar-prev-year-btn, .ant-calendar-month-panel-prev-year-btn, .ant-calendar-year-panel-prev-decade-btn', '.ant-calendar-prev-month-btn'],
    next: ['.ant-calendar-next-month-btn', '.ant-calendar-next-year-btn, .ant-calendar-month-panel-next-year-btn, .ant-calendar-year-panel-next-decade-btn'],
  },
  // Verified in the component lab on antd 4.24.16 and 5.29.3.
  ant: { root: '.ant-picker', popup: '.ant-picker-dropdown', range: '.ant-picker-range', dismiss: { kind: 'blur' } },
  element: { root: '.el-date-editor', popup: '.el-picker-panel', timeOnly: '.el-date-editor--time, .el-date-editor--timerange', dismiss: { kind: 'outside' } },
  feishu: { root: '.ud__date-picker, .ud__date-picker__range', dismiss: { kind: 'escalate' } },
  meituan: { root: '.mtd-date-picker', popup: '.mtd-datepicker-pop', dismiss: { kind: 'outside' } },
  lixiang: { root: '.date-picker-pc', popup: '.panel-container', toggle: '.value-container', dismiss: { kind: 'toggle', selector: '.value-container' } },
} satisfies Record<string, { root: string; dismiss: CalendarDismiss; [selector: string]: unknown }>;

export type CalendarAdapters = typeof CALENDAR_ADAPTERS;
export type CalendarFamily = keyof CalendarAdapters;
