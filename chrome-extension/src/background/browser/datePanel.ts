import { CALENDAR_ADAPTERS, type CalendarAdapters, type CalendarDismiss, type CalendarFamily } from './calendarAdapters';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
interface DatePanelPoint {
  x: number;
  y: number;
  obscured?: boolean;
}

export interface DatePanelState {
  open: boolean;
  bounds?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  view: 'day' | 'month' | 'year' | 'unknown';
  year: number | null;
  month: number | null;
  cells: (DatePanelPoint & { value: number; disabled: boolean })[];
  /** 表头左侧箭头（从外到内）与右侧箭头（从内到外），按横坐标排列。 */
  prev: DatePanelPoint[];
  next: DatePanelPoint[];
  header: DatePanelPoint | null;
  monthHeader?: DatePanelPoint | null;
  input?: { x: number; y: number; value: string; invalid: boolean; active: boolean; formats: string[] } | null;
  formats?: string[];
  /** Component family that owns this popup; absent for an unrecognized calendar. */
  family?: CalendarFamily;
  /** The family's declared, verified way to close the popup without choosing. */
  dismiss: CalendarDismiss;
  focused?: boolean;
  range?: boolean;
  allowClippedPanel?: boolean;
  /** This day grid commits by choosing a day; its month header only navigates. */
  daySelectionOnly?: boolean;
  /** This picker represents a month even when the source has day precision. */
  monthSelectionOnly?: boolean;
}

/**
 * 紧贴字段弹出的日期面板。嵌套日历优先使用当前子面板，避免把被覆盖的日期网格一起解析。
 * evaluate 会序列化本函数，不能引用外部变量。
 */
export function datePanel(
  element: Element,
  target?: { year: number; month: number },
  calendars: CalendarAdapters = CALENDAR_ADAPTERS,
): DatePanelState {
  const empty: DatePanelState = {
    open: false,
    view: 'unknown',
    year: null,
    month: null,
    cells: [],
    prev: [],
    next: [],
    header: null,
    dismiss: { kind: 'escalate' },
  };
  const doc = element.ownerDocument;
  const view = doc.defaultView!;
  const bounds = (el: Element) => {
    const { left, top, right, bottom, width, height } = el.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  };
  const { ant, antLegacy, element: elementCalendar, meituan, lixiang } = calendars;
  // Every family branch reports its owner so dismissal uses the declared, verified method.
  const owned = (family: CalendarFamily, state: DatePanelState): DatePanelState =>
    ({ ...state, family, dismiss: calendars[family].dismiss });
  const picker = element.closest([ant.root, antLegacy.root, elementCalendar.root, meituan.root].join(', '));
  const anchor = (picker ?? element).getBoundingClientRect();
  type ElPickerVm = {
    valueFormat?: unknown;
    format?: unknown;
    type?: unknown;
    pickerVisible?: unknown;
    mountPicker?: unknown;
    picker?: { $el?: unknown } | null;
    $parent?: ElPickerVm;
  };
  const rawElVm = (picker as unknown as { __vue__?: ElPickerVm })?.__vue__;
  const elVm =
    rawElVm &&
    !rawElVm.picker &&
    !('pickerVisible' in rawElVm) &&
    typeof rawElVm.mountPicker !== 'function' &&
    rawElVm.$parent
      ? rawElVm.$parent
      : rawElVm;
  const visible = (el: Element) => {
    if (
      el.closest(
        '[hidden], [aria-hidden="true"], .ant-picker-dropdown-hidden, .ant-slide-up-leave, .ant-slide-down-leave, .el-zoom-in-top-leave-active, .el-zoom-in-bottom-leave-active',
      )
    )
      return false;
    for (let parent: Element | null = el; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true });
  };
  const point = (el: Element | null): DatePanelPoint | null => {
    if (!el || !visible(el)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = doc.elementFromPoint(x, y);
    return { x, y, obscured: !hit || !(hit === el || el.contains(hit)) };
  };
  // This widget owns its year/month panel inside the control instead of a portal.
  // Its displayed year is provisional until a month is chosen and the panel closes.
  if (element.matches(lixiang.root)) {
    const panel = element.querySelector(lixiang.popup);
    if (!panel || !visible(panel)) return empty;
    const options = Array.from(panel.querySelectorAll('.options')).filter(visible);
    const years = options.every(option => /^\d{4}$/.test(option.textContent?.trim() ?? ''));
    const months = options.every(option => /^(0?[1-9]|1[0-2])月$/.test(option.textContent?.trim() ?? ''));
    const cells = options.flatMap(option => {
      const at = point(option.querySelector('.text') ?? option);
      const value = Number(option.textContent?.trim().match(/^\d+/)?.[0]);
      return at && value ? [{ ...at, value, disabled: option.matches('[disabled], [aria-disabled="true"]') }] : [];
    });
    const year = years ? cells[0]?.value ?? null
      : Number(element.querySelector('.value-container .value .text')?.textContent?.match(/^\d{4}/)?.[0]) || null;
    const older = point(panel.querySelector('.next-btn.show'));
    const newer = point(panel.querySelector('.prev-btn.show'));
    return owned('lixiang', { ...empty, open: true, bounds: bounds(panel), formats: ['YYYY-MM'],
      view: options.length && years ? 'year' : options.length && months ? 'month' : 'unknown',
      year, cells, prev: older ? [older] : [], next: newer ? [newer] : [] });
  }
  if (picker?.matches(meituan.root)) {
    const popups = Array.from(doc.querySelectorAll(meituan.popup)).filter(popup => {
      const r = bounds(popup);
      return visible(popup) && r.width > 0 && r.height > 0;
    });
    const aligned = popups.filter(popup => {
      const r = bounds(popup);
      return r.right > anchor.left && r.left < anchor.right &&
        (Math.abs(r.top - anchor.bottom) <= 28 || Math.abs(r.bottom - anchor.top) <= 28);
    });
    const focused = picker.contains(doc.activeElement);
    const popup = focused && popups.length === 1 ? popups[0] : aligned.length === 1 ? aligned[0] : undefined;
    if (!popup) return empty;
    const panel = popup.querySelector('.mtd-month-calendar-content.active');
    const popupState = owned('meituan', { ...empty, open: true, focused, bounds: bounds(popup) });
    if (!panel) return popupState;
    const yearView = Boolean(panel.querySelector('.mtd-year-panel'));
    const yearHeader = panel.querySelector('.mtd-month-calendar-year-btn');
    const yearText = yearHeader?.textContent ?? panel.querySelector('.mtd-month-calendar-year-header-range')?.textContent;
    const prev = point(panel.querySelector('.left-switcher'));
    const next = point(panel.querySelector('.right-switcher'));
    return {
      ...popupState, view: yearView ? 'year' : 'month', year: Number(yearText?.match(/\d{4}/)?.[0]) || null,
      formats: ['YYYY-MM'], monthSelectionOnly: true, header: point(yearHeader),
      prev: prev ? [prev] : [], next: next ? [next] : [],
      cells: Array.from(panel.querySelectorAll(yearView ? '.mtd-year-panel-list-data' : '.mtd-month-panel-list-data'))
        .flatMap(cell => {
          const value = Number(cell.textContent?.trim().match(/^\d+/)?.[0]);
          const at = point(cell);
          return at && value ? [{ ...at, value, disabled: Boolean(cell.closest('.disabled-year, .disabled-month, [aria-disabled="true"]')) }] : [];
        }),
    };
  }
  const calendarRoots = [antLegacy.popup, ant.popup, elementCalendar.popup].join(', ');
  let root: Element | undefined;
  if (
    picker?.matches(elementCalendar.root) &&
    elVm &&
    ('pickerVisible' in elVm || typeof elVm.mountPicker === 'function' || 'picker' in elVm)
  ) {
    const panelEl = elVm.picker?.$el as Element | undefined;
    if (!panelEl || typeof panelEl.getBoundingClientRect !== 'function' || elVm.pickerVisible === false || !visible(panelEl))
      return empty;
    const box = panelEl.getBoundingClientRect();
    if (box.width < 120 || box.height < 100) return empty;
    root = panelEl;
  } else {
    const roots = Array.from(doc.body.querySelectorAll('*')).filter(el => {
      if (el.contains(element) || el.closest('#qz-agent-feedback')) return false;
      const box = el.getBoundingClientRect();
      if (box.width < 120 || box.height < 100) return false;
      const aligned = box.right > anchor.left - 40 && box.left < anchor.right + 40;
      const below = box.top >= anchor.bottom - 6 && box.top <= anchor.bottom + 30;
      const above = box.bottom <= anchor.top + 6 && box.bottom >= anchor.top - 30;
      // Portals inside scrolling forms can overlap the input when the popup is
      // clamped to available space. Only known calendar roots may use this case.
      const overlayInput =
        el.matches(calendarRoots) &&
        box.top <= anchor.bottom && box.bottom >= anchor.top;
      if (!aligned || !(below || above || overlayInput)) return false;
      const position = view.getComputedStyle(el).position;
      return (position === 'absolute' || position === 'fixed') && visible(el);
    });
    root = roots.sort((a, b) => {
      const preferCalendar = Number(b.matches(calendarRoots)) - Number(a.matches(calendarRoots));
      if (preferCalendar) return preferCalendar;
      if (picker?.matches(antLegacy.root)) {
        const preferLegacy = Number(b.matches(antLegacy.popup)) - Number(a.matches(antLegacy.popup));
        if (preferLegacy) return preferLegacy;
      }
      const aBox = a.getBoundingClientRect();
      const bBox = b.getBoundingClientRect();
      const aAlign = Math.min(Math.abs(aBox.left - anchor.left), Math.abs(aBox.right - anchor.right));
      const bAlign = Math.min(Math.abs(bBox.left - anchor.left), Math.abs(bBox.right - anchor.right));
      if (Math.abs(aAlign - bAlign) > 16) return aAlign - bAlign;
      return bBox.height - aBox.height;
    })[0];
  }
  if (!root) return empty;
  const popup = root;
  empty.bounds = bounds(popup);
  const focused =
    popup.contains(doc.activeElement) || doc.activeElement === element || Boolean(picker?.contains(doc.activeElement));
  if (popup.matches(elementCalendar.popup)) {
    const enMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const parseElMonth = (raw: string) => {
      const cleaned = raw.replace(/\s+/g, '');
      const num = cleaned.match(/^(1[0-2]|0?[1-9])月$/);
      if (num) return Number(num[1]);
      const zhIdx = [
        '一月',
        '二月',
        '三月',
        '四月',
        '五月',
        '六月',
        '七月',
        '八月',
        '九月',
        '十月',
        '十一月',
        '十二月',
      ].indexOf(cleaned);
      if (zhIdx >= 0) return zhIdx + 1;
      const enIdx = enMonths.indexOf(cleaned.slice(0, 3).toLowerCase());
      return /^[a-z]{3,9}\.?$/i.test(cleaned) && enIdx >= 0 ? enIdx + 1 : null;
    };
    const rangePanels = Array.from(popup.querySelectorAll('.el-date-range-picker__content')).filter(visible);
    const scope =
      rangePanels.length > 1
        ? (() => {
            const parsed = rangePanels.map(panel => {
              const title = panel.querySelector('.el-date-range-picker__header')?.textContent ?? '';
              const yr = Number(title.match(/\d{4}/)?.[0]) || null;
              const mo = Number(title.match(/(\d{1,2})\s*月/)?.[1]) || null;
              return { panel, yr, mo };
            });
            const exact = parsed.find(p => target && p.yr === target.year && p.mo === target.month);
            if (exact) return exact.panel;
            const forward =
              target && parsed[0]?.yr && target.year * 12 + target.month >= parsed[0].yr * 12 + (parsed[0].mo ?? 1);
            return (forward ? parsed[parsed.length - 1] : parsed[0])!.panel;
          })()
        : popup;
    const headerLabels = Array.from(
      scope.querySelectorAll('.el-date-picker__header-label, .el-date-range-picker__header div'),
    ).filter(visible);
    const yearEl = headerLabels.find(el => /\d{4}/.test(el.textContent ?? '')) ?? null;
    const year = Number(yearEl?.textContent?.match(/\d{4}/)?.[0]) || null;
    const monthEl = headerLabels.find(el => el !== yearEl && parseElMonth(el.textContent ?? '') !== null) ?? null;
    const rangeHeaderMonth =
      !monthEl && yearEl ? Number(yearEl.textContent?.match(/\d{4}\D+(\d{1,2})\s*月/)?.[1]) || null : null;
    const month = (monthEl ? parseElMonth(monthEl.textContent ?? '') : null) ?? rangeHeaderMonth;
    const yearTable = Array.from(scope.querySelectorAll('.el-year-table')).find(visible);
    const monthTable = Array.from(scope.querySelectorAll('.el-month-table')).find(visible);
    const dateTable = Array.from(scope.querySelectorAll('.el-date-table')).find(visible);
    let viewKind: DatePanelState['view'] = 'unknown';
    let cells: DatePanelState['cells'] = [];
    if (yearTable) {
      viewKind = 'year';
      cells = Array.from(yearTable.querySelectorAll('td'))
        .filter(td => visible(td) && /\d{4}/.test(td.textContent ?? ''))
        .flatMap(td => {
          const val = Number(td.textContent!.match(/\d{4}/)![0]);
          const at = point(td.querySelector('.cell')) ?? point(td);
          return val && at ? [{ ...at, value: val, disabled: td.classList.contains('disabled') }] : [];
        });
    } else if (monthTable) {
      viewKind = 'month';
      cells = Array.from(monthTable.querySelectorAll('td'))
        .filter(visible)
        .flatMap((td, idx) => {
          const val = parseElMonth(td.textContent ?? '') ?? (idx < 12 ? idx + 1 : null);
          const at = point(td.querySelector('.cell')) ?? point(td);
          return val && at ? [{ ...at, value: val, disabled: td.classList.contains('disabled') }] : [];
        });
    } else if (dateTable) {
      viewKind = 'day';
      cells = Array.from(dateTable.querySelectorAll('td'))
        .filter(td => visible(td) && !td.classList.contains('prev-month') && !td.classList.contains('next-month'))
        .flatMap(td => {
          const val = Number((td.textContent ?? '').trim().match(/^([12]\d|3[01]|0?[1-9])$/)?.[1]);
          const at = point(td.querySelector('span, .cell, div')) ?? point(td);
          return val && at ? [{ ...at, value: val, disabled: td.classList.contains('disabled') }] : [];
        });
    }
    const prevYear = point(popup.querySelector('.el-icon-d-arrow-left, .d-arrow-left'));
    const prevMonth = point(popup.querySelector('.el-icon-arrow-left, .arrow-left'));
    const nextMonth = point(popup.querySelector('.el-icon-arrow-right, .arrow-right'));
    const nextYear = point(popup.querySelector('.el-icon-d-arrow-right, .d-arrow-right'));
    const elFmt =
      typeof elVm?.valueFormat === 'string' && elVm.valueFormat
        ? elVm.valueFormat
        : typeof elVm?.format === 'string' && elVm.format
          ? elVm.format
          : '';
    const elFormats = elFmt
      ? [elFmt]
      : picker?.matches('.el-date-editor--year') || elVm?.type === 'year'
        ? ['YYYY']
        : picker?.matches('.el-date-editor--month, .el-date-editor--monthrange') || elVm?.type === 'month'
          ? ['YYYY-MM']
          : picker?.matches(
                '.el-date-editor--date, .el-date-editor--daterange, .el-date-editor--datetime, .el-date-editor--datetimerange',
              ) || elVm?.type === 'date'
            ? ['YYYY-MM-DD']
            : [];
    return owned('element', {
      ...empty,
      open: true,
      focused,
      formats: elFormats,
      range:
        rangePanels.length > 1 ||
        Boolean(
          picker?.matches('.el-date-editor--daterange, .el-date-editor--monthrange, .el-date-editor--datetimerange'),
        ),
      daySelectionOnly: viewKind === 'day' && !picker?.matches('.el-date-editor--month, .el-date-editor--monthrange'),
      view: viewKind,
      year,
      month,
      cells,
      prev: [prevYear, prevMonth].filter((p): p is { x: number; y: number } => p !== null),
      next: [nextMonth, nextYear].filter((p): p is { x: number; y: number } => p !== null),
      header: headerLabels.some(el => el.matches('a, button, [role="button"]')) ? point(yearEl) : null,
      monthHeader: monthEl?.matches('a, button, [role="button"]') ? point(monthEl) : null,
    });
  }
  // Modern Ant range pickers render two independent calendars in one popup.
  // Select one panel before parsing, otherwise years and duplicate month cells mix.
  if (popup.matches(ant.popup)) {
    const panels = Array.from(popup.querySelectorAll('.ant-picker-panel')).filter(visible);
    const describe = (panel: Element) => {
      const body = panel.querySelector('.ant-picker-year-panel, .ant-picker-month-panel, .ant-picker-date-panel');
      const kind: DatePanelState['view'] =
        body?.classList.contains('ant-picker-year-panel') || Boolean(panel.querySelector('.ant-picker-decade-btn'))
          ? 'year'
          : body?.classList.contains('ant-picker-month-panel') ||
              (!body &&
                Boolean(panel.querySelector('.ant-picker-year-btn')) &&
                !panel.querySelector('.ant-picker-month-btn'))
            ? 'month'
            : body?.classList.contains('ant-picker-date-panel') || Boolean(panel.querySelector('.ant-picker-month-btn'))
              ? 'day'
              : 'unknown';
      const year =
        Number(
          panel.querySelector('.ant-picker-year-btn')?.textContent?.match(/\d{4}/)?.[0] ??
            panel.querySelector('.ant-picker-decade-btn')?.textContent?.match(/\d{4}/)?.[0],
        ) || null;
      const cells = Array.from(panel.querySelectorAll('td.ant-picker-cell')).filter(
        cell => visible(cell) && cell.classList.contains('ant-picker-cell-in-view'),
      );
      const sample = cells[0]?.getAttribute('title');
      const month = kind === 'day' && sample ? Number(sample.split('-')[1]) : null;
      return { panel, kind, year, month, cells };
    };
    const choices = panels.map(describe);
    const first = choices[0];
    const drilled =
      choices.find(p => p.kind === 'year') ??
      (choices.some(p => p.kind === 'day') ? choices.find(p => p.kind === 'month') : undefined);
    const forward = target && first?.year && target.year * 12 + target.month >= first.year * 12 + (first.month ?? 1);
    const selected =
      drilled ??
      choices.find(p => target && p.year === target.year && (p.kind !== 'day' || p.month === target.month)) ??
      (forward ? choices[choices.length - 1] : first);
    if (!selected) return owned('ant', { ...empty, open: true, focused });
    const { panel, kind, year, month, cells } = selected;
    const arrowScope = !drilled && choices.length > 1 ? popup : panel;
    const points = (selector: string) =>
      Array.from(arrowScope.querySelectorAll(selector))
        .map(point)
        .filter((value): value is { x: number; y: number } => value !== null)
        .sort((a, b) => a.x - b.x);
    return owned('ant', {
      ...empty,
      open: true,
      focused,
      range: Boolean(picker?.matches(ant.range)) || panels.length > 1,
      daySelectionOnly: kind === 'day',
      view: kind,
      year,
      month,
      cells: cells.flatMap(cell => {
        const title = (cell.getAttribute('title') || cell.textContent || '').trim();
        const value =
          kind === 'year'
            ? Number(title.match(/^\d{4}/)?.[0])
            : kind === 'month'
              ? Number(title.match(/^\d{4}-(\d{1,2})$/)?.[1] ?? title.match(/^(1[0-2]|0?[1-9])\s*月$/)?.[1])
              : Number(title.match(/^\d{4}-\d{1,2}-(\d{1,2})$/)?.[1] ?? title.match(/^([12]\d|3[01]|0?[1-9])$/)?.[1]);
        const at = point(cell.querySelector('.ant-picker-cell-inner') ?? cell);
        return value && at
          ? [
              {
                ...at,
                value,
                disabled:
                  cell.classList.contains('ant-picker-cell-disabled') || cell.getAttribute('aria-disabled') === 'true',
              },
            ]
          : [];
      }),
      prev: points('.ant-picker-header-super-prev-btn, .ant-picker-header-prev-btn'),
      next: points('.ant-picker-header-next-btn, .ant-picker-header-super-next-btn'),
      header: point(panel.querySelector('.ant-picker-year-btn, .ant-picker-decade-btn')),
      monthHeader: point(panel.querySelector('.ant-picker-month-btn')),
    });
  }
  const legacy = popup.matches(antLegacy.popup) ? antLegacy : undefined;
  // Calendars parsed by the generic reader still close with their family's method when known.
  const family: CalendarFamily | undefined = legacy
    ? 'antLegacy'
    : popup.matches(elementCalendar.popup)
      ? 'element'
      : picker?.matches(calendars.feishu.root)
        ? 'feishu'
        : undefined;
  const ownedBy = (state: DatePanelState) => (family ? owned(family, state) : state);
  const edit = legacy
    ? popup.querySelector<HTMLInputElement>(antLegacy.edit)
    : null;
  const editBox = edit?.getBoundingClientRect();
  // 只读当前输入框所属 rc-calendar DateInput 的格式属性，不猜测站点/字段名称，
  // 不修改 React 状态。无法确认组件归属时，保留未知格式。
  let formats: string[] = [];
  if (edit) {
    type Owner = {
      return?: Owner;
      memoizedProps?: { onChange?: unknown };
      stateNode?: { onInputChange?: unknown; props?: { format?: unknown } };
    };
    const key = Object.keys(edit).find(
      key => key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$'),
    );
    const host = key ? (edit as unknown as Record<string, Owner>)[key] : undefined;
    const handler = host?.memoizedProps?.onChange;
    for (let owner = host?.return, depth = 0; owner && depth < 8; owner = owner.return, depth++) {
      if (handler && owner.stateNode?.onInputChange === handler) {
        const format = owner.stateNode.props?.format;
        if (typeof format === 'string') formats = [format];
        else if (Array.isArray(format) && format.every(value => typeof value === 'string')) formats = format;
        break;
      }
    }
  }
  const input =
    edit && editBox && visible(edit) && editBox.width > 0 && editBox.height > 0
      ? {
          x: editBox.left + editBox.width / 2,
          y: editBox.top + editBox.height / 2,
          value: edit.value,
          invalid:
            edit.matches(antLegacy.invalid),
          active: doc.activeElement === edit,
          formats,
        }
      : null;
  // Ant 3 day, month and year grids contain duplicates outside the current period.
  // Parse the visible calendar's own grid and navigation controls before generic text discovery.
  if (legacy) {
    const get = (selector: string) => Array.from(popup.querySelectorAll(selector)).find(visible) ?? null;
    const yearGrid = get(antLegacy.panels.year);
    const monthGrid = get(antLegacy.panels.month);
    const dayGrid = get(antLegacy.panels.day);
    const grid = yearGrid ?? monthGrid ?? dayGrid;
    if (grid) {
      const kind = yearGrid ? 'year' : monthGrid ? 'month' : 'day';
      const yearButton = grid.querySelector(antLegacy.yearHeader);
      const monthButton = grid.querySelector(antLegacy.monthHeader);
      const year = Number(yearButton?.textContent?.match(/\d{4}/)?.[0]) || null;
      const month = Number(monthButton?.textContent?.match(/\d{1,2}/)?.[0]) ||
        (['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(monthButton?.textContent?.trim().slice(0,3).toLowerCase() ?? '') + 1) || null;
      const cellElements = Array.from(grid.querySelectorAll(antLegacy.cells[kind])).filter(visible);
      const cells = cellElements.flatMap((el, index) => {
        const cell = el.closest('td') ?? el;
        if (cell.matches(antLegacy.outsidePeriod)) return [];
        const value = kind === 'month' ? index + 1 : Number(el.textContent?.trim());
        const p = point(el);
        return p && value ? [{ ...p, value, disabled: !!el.closest(antLegacy.disabled) }] : [];
      });
      const points = (selectors: string[]) => selectors.flatMap(selector => {
        const p = point(grid.querySelector(selector));
        return p ? [p] : [];
      });
      if (year && cells.length && (kind !== 'day' || month)) return owned('antLegacy', {
        ...empty, open: true, allowClippedPanel: legacy.allowClippedPanel, focused, input, formats,
        daySelectionOnly: kind === 'day', view: kind, year, month, cells,
        prev: points(antLegacy.prev), next: points(antLegacy.next),
        header: point(yearButton), monthHeader: point(monthButton),
      });
    }
  }
  // Ant Calendar 的年/月视图叠在日视图上；底层节点仍有尺寸且 checkVisibility 为真。
  // 仅在已经按输入框位置定位的弹层内选子面板，不搜索其他字段的日历。
  for (const selector of ['.ant-calendar-decade-panel', '.ant-calendar-year-panel', '.ant-calendar-month-panel']) {
    const panel = Array.from(root.querySelectorAll(selector)).find(visible);
    if (panel) {
      root = panel;
      break;
    }
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthOf = (text: string) => {
    const zh = text.match(/^(1[0-2]|0?[1-9])\s*月$/);
    if (zh) return Number(zh[1]);
    const chinese = [
      '一月',
      '二月',
      '三月',
      '四月',
      '五月',
      '六月',
      '七月',
      '八月',
      '九月',
      '十月',
      '十一月',
      '十二月',
    ].indexOf(text.replace(/\s+/g, ''));
    if (chinese >= 0) return chinese + 1;
    const en = MONTHS.indexOf(text.slice(0, 3).toLowerCase());
    return /^[a-z]{3,9}\.?$/i.test(text) && en >= 0 ? en + 1 : null;
  };
  const items = Array.from(root.querySelectorAll('*'))
    .filter(el => visible(el))
    .map(el => {
      const own = Array.from(el.childNodes)
        .filter(child => child.nodeType === 3)
        .map(child => child.textContent ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const rect = el.getBoundingClientRect();
      const disabled =
        view.getComputedStyle(el).cursor === 'not-allowed' ||
        Boolean(el.closest('[class*="disabled"], [aria-disabled="true"], [disabled]'));
      return { el, own, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, disabled };
    })
    .filter(item => item.width > 0);
  const titled = items.filter(item => /(?:^|\D)(1[89]\d{2}|2\d{3})(?:\D|$)/.test(item.own)).sort((a, b) => a.y - b.y);
  const head = titled[0];
  if (!head) return popup.matches(calendarRoots)
    ? ownedBy({ ...empty, open: true, input, focused, allowClippedPanel: legacy?.allowClippedPanel })
    : empty;
  const headerRow = items.filter(item => Math.abs(item.y - head.y) < 12);
  const headYear = Number(head.own.match(/(1[89]\d{2}|2\d{3})/)![1]);
  const headMonthText = headerRow.map(item => item.own).join(' ');
  const headMonthMatch = headMonthText.match(/(?:^|[^\d])(1[0-2]|0?[1-9])\s*月/) ?? null;
  const headMonthEn = headerRow.map(item => monthOf(item.own)).find(value => value !== null) ?? null;
  const below = items.filter(item => item.y > head.y + 12 && item.own);
  const months = below.map(item => ({ item, value: monthOf(item.own) })).filter(entry => entry.value !== null);
  const years = below
    .map(item => ({ item, value: /^(1[89]\d{2}|2\d{3})\s*年?$/.test(item.own) ? Number(item.own.slice(0, 4)) : null }))
    .filter(entry => entry.value !== null);
  const days = below
    .map(item => ({ item, value: /^([1-9]|[12]\d|3[01])$/.test(item.own) ? Number(item.own) : null }))
    .filter(entry => entry.value !== null);
  const toCell = (entry: { item: (typeof items)[number]; value: number | null }) => ({
    ...point(entry.item.el)!,
    value: entry.value!,
    x: entry.item.x,
    y: entry.item.y,
    disabled: entry.item.disabled,
  });
  let viewKind: DatePanelState['view'] = 'unknown';
  let cells: DatePanelState['cells'] = [];
  if (months.length >= 6) {
    viewKind = 'month';
    cells = months.map(toCell);
  } else if (years.length >= 8) {
    viewKind = 'year';
    cells = years.map(toCell);
  } else if (days.length >= 28) {
    viewKind = 'day';
    // 当月格子：从第一个“1”开始连续递增的一段，前后的上月/下月格子不算。
    const start = days.findIndex(entry => entry.value === 1);
    const run = [];
    for (let i = start; i >= 0 && i < days.length && days[i].value === run.length + 1; i++) run.push(days[i]);
    cells = run.map(toCell);
  }
  // Proximity alone also matches navigation cards and other floating UI. An
  // unrecognized component needs an actual date grid before it counts as open.
  if (viewKind === 'unknown' && !popup.matches(calendarRoots)) return empty;
  // 箭头：表头行里不含数字、宽度不大的元素（图标、‹ › « »）。
  const arrows = headerRow
    .filter(item => !/\d/.test(item.own) && item.width < 48 && item.el.childElementCount <= 1)
    .sort((a, b) => a.x - b.x);
  const dedup = arrows.filter((item, i) => i === 0 || Math.abs(item.x - arrows[i - 1].x) > 6);
  const itemPoint = (item: (typeof items)[number]) => point(item.el)!;
  const monthHeader = headerRow.find(
    item => monthOf(item.own) !== null && item.el.matches('a, button, [role="button"]'),
  );
  return ownedBy({
    open: true,
    bounds: empty.bounds,
    dismiss: empty.dismiss,
    view: viewKind,
    year: headYear,
    month: headMonthMatch ? Number(headMonthMatch[1]) : headMonthEn,
    cells,
    prev: dedup.filter(item => item.x < head.x - head.width / 2).map(itemPoint),
    next: dedup.filter(item => item.x > head.x + head.width / 2).map(itemPoint),
    header: itemPoint(head),
    monthHeader: monthHeader ? itemPoint(monthHeader) : null,
    input,
    focused,
    allowClippedPanel: legacy?.allowClippedPanel,
  });
}

export function readCalendarPanel(element: ElementHandle, target?: { year: number; month: number }): Promise<DatePanelState> {
  return element.evaluate(datePanel, target, CALENDAR_ADAPTERS);
}
