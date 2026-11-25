import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { DOMElementNode } from './dom/views';
import type { ApplicationControlOptions } from './page';
import { hasCommittedControlValue, readLiveControl, readCalendarPanel, commitFormControl, writeFormText } from './formControls';
import { CALENDAR_ADAPTERS } from './calendarAdapters';
import { formValuesEquivalent, writeVerifiedControl, type FormWriteResult, type FormWriteRequest } from './formFill';
import { explorationStep } from '../controlExploration';
import { dismissCalendarPopup, releaseCalendarPopup } from './popupDismissal';
import { isApplicationClickTarget } from './clickTarget';
import { calendarVisibilityGuard } from './calendarVisibility';

interface DateDriver {
  page: PuppeteerPage | null;
  resolve(node: DOMElementNode): Promise<{ element: ElementHandle; identity: Record<string, string> }>;
  checkTarget(): Promise<void>;
  reveal(element: ElementHandle): Promise<void>;
  waitForClickTarget(element: ElementHandle, signal?: AbortSignal): Promise<void>;
}

/**
 * 日期面板选择：点开字段旁的面板，按表头年月用箭头翻页（大跨度先点表头切到年/月视图），再点目标格子。
 * 值写成 YYYY-MM 或 YYYY-MM-DD；面板只给年月时选到月即可。
 */
export async function pickApplicationDate(driver: DateDriver, node: DOMElementNode, value: string, options: ApplicationControlOptions = {}): Promise<FormWriteResult> {
  const { element } = await driver.resolve(node);
  const incompleteRange = await element.evaluate((el, range) => {
    const inputs = Array.from(el.closest(range)?.querySelectorAll<HTMLInputElement>('input') ?? []);
    return inputs.length === 2 && inputs.some(input => input !== el && !input.value.trim());
  }, CALENDAR_ADAPTERS.ant.range);
  if (incompleteRange) {
    const state = await readLiveControl(element, false);
    return { status: 'failed', code: 'DATE_RANGE_INCOMPLETE', message: '此起止时间需要两端一起选择，本次尚未修改。',
      adapter: 'date-panel', attempts: 0, actualValue: state.value, desiredValue: value };
  }
  return pickDate(driver, node, value, options);
}

/** Range calendars commit both endpoints together. Keep the popup open between them,
 * then verify both fields after closure rather than accepting a provisional start. */
export async function pickApplicationDateRange(
  driver: DateDriver,
  nodes: [DOMElementNode, DOMElementNode], values: [string, string],
  options: [ApplicationControlOptions, ApplicationControlOptions],
): Promise<[FormWriteResult, FormWriteResult]> {
  const controls = await Promise.all(nodes.map(node => driver.resolve(node)));
  const read = async () => {
    await driver.checkTarget();
    return Promise.all(controls.map(({ element }) => readLiveControl(element, false)));
  };
  const initial = await read();
  const sameRange = await controls[0].element.evaluate((first, second, selector) => {
    const range = first.closest(selector);
    const inputs = Array.from(range?.querySelectorAll('input') ?? []);
    return Boolean(range && second.closest(selector) === range && inputs.length === 2 && inputs[0] === first && inputs[1] === second);
  }, controls[1].element, CALENDAR_ADAPTERS.ant.range);
  const blocked = initial.map((state, i): FormWriteResult | null => {
    const fail = (code: string, message: string, status: FormWriteResult['status'] = 'failed'): FormWriteResult => ({
      status, code, message, adapter: 'date-panel', attempts: 0, actualValue: state.value, desiredValue: values[i],
    });
    if (!sameRange || !state.connected || Object.entries(controls[i].identity).some(([key, value]) => state.identity[key] !== value))
      return fail('STALE_CONTROL', '起止日期控件已变化，请重新观察。');
    if (options[i].signal?.aborted || state.disabled) return fail('CANCELLED', '日期填写已停止。');
    if (state.value !== (options[i].observedValue ?? state.value) && !formValuesEquivalent(state.value, values[i]))
      return fail('VALUE_CHANGED', '日期已被修改，请重新观察后填写。');
    if (state.value && !formValuesEquivalent(state.value, values[i]) && !options[i].allowReplace)
      return fail('EXISTING_VALUE_PRESERVED', '起止日期已有内容，请先确认替换。', 'preserved');
    if (!/^\d{4}-\d{1,2}(?:-\d{1,2})?$/.test(values[i])) return fail('DATE_FORMAT', '日期请提供年月或年月日。');
    return null;
  });
  if (blocked.some(Boolean)) return initial.map((state, i) => blocked[i] ?? {
    status: 'failed', code: 'DATE_RANGE_INCOMPLETE', message: '另一端日期尚未确认，本次未修改起止日期。',
    adapter: 'date-panel', attempts: 0, actualValue: state.value, desiredValue: values[i],
  }) as [FormWriteResult, FormWriteResult];
  // Shared validation may reject a correct start only because its end is empty.
  // Preserve that start and complete the pair before deciding whether it is valid.
  const first: FormWriteResult = formValuesEquivalent(initial[0].value, values[0]) ? {
    status: 'failed', code: 'DATE_RANGE_PENDING', message: '开始日期已匹配，等待结束日期核对。',
    adapter: 'date-panel', attempts: 0, actualValue: initial[0].value, desiredValue: values[0],
  } : await pickDate(driver, nodes[0], values[0], options[0], true);
  if (first.status !== 'verified' && first.code !== 'DATE_RANGE_PENDING') return [first, {
    status: 'failed', code: 'DATE_RANGE_INCOMPLETE', message: '开始日期未选定，结束日期尚未修改。',
    adapter: 'date-panel', attempts: 0, actualValue: initial[1].value, desiredValue: values[1],
  }];
  let second = await pickDate(driver, nodes[1], values[1], options[1]);
  // A preflight refusal on the second endpoint may leave the first provisional
  // selection open. Close only this range before reading either final value.
  const owner = controls[0].element;
  const readPanel = () => readCalendarPanel(owner);
  if ((await readPanel()).open &&
    (options[1].signal?.aborted || !(await dismissCalendarPopup(driver, owner, readPanel, options[1].signal))))
    second = { ...second, status: 'failed', code: 'DATE_PANEL_STILL_OPEN' };
  const before = await read();
  await new Promise(resolve => setTimeout(resolve, Math.max(180, ...before.map(state => state.settleMs ?? 0))));
  const after = await read();
  return after.map((state, i) => {
    const stable = state.connected && state.value === before[i].value && hasCommittedControlValue(state) && hasCommittedControlValue(before[i]) &&
      formValuesEquivalent(state.value, values[i]) &&
      Object.entries(controls[i].identity).every(([key, value]) => state.identity[key] === value);
    if (stable && second.code !== 'DATE_PANEL_STILL_OPEN' && !options[i].signal?.aborted) return {
      status: 'verified', code: 'VERIFIED', message: '起止日期选择完成，收起日历后两次回读一致。',
      adapter: 'date-panel', attempts: 1, actualValue: state.value, desiredValue: state.value,
    };
    return { ...(i === 1 ? second : first), status: 'failed', code: second.code === 'DATE_PANEL_STILL_OPEN' ? second.code : 'DATE_RANGE_INCOMPLETE',
      message: '起止日期尚未完整保存，请核对两端日期。', actualValue: state.value, desiredValue: values[i] };
  }) as [FormWriteResult, FormWriteResult];
}

async function pickDate(driver: DateDriver, node: DOMElementNode, value: string, options: ApplicationControlOptions = {}, continueRange = false): Promise<FormWriteResult> {
  const { element, identity } = await driver.resolve(node);
  const read = async () => {
    await driver.checkTarget();
    return readLiveControl(element, true);
  };
  const initial = await read();
  const parts = value.match(/^\s*(\d{4})(?:\D+(\d{1,2})(?:\D+(\d{1,2}))?)?\D*$/);
  if (!parts || !driver.page)
    return { status: 'failed', code: 'DATE_FORMAT', message: '日期请写成 YYYY-MM 或 YYYY-MM-DD。',
      adapter: '', attempts: 0, actualValue: initial.value, desiredValue: value };
  const year = Number(parts[1]);
  const month = parts[2] ? Number(parts[2]) : null;
  let day = parts[3] ? Number(parts[3]) : null;
  const page = driver.page;
  const visiblePanel = calendarVisibilityGuard(driver, element, options.signal);
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const observe = async () => {
    const panel = await readCalendarPanel(element);
    const control = await read();
    return { value: control.value, valid: control.valid, error: control.validationMessage,
      open: panel.open, view: panel.view, year: panel.year, month: panel.month,
      cells: panel.cells.map(cell => [cell.value, cell.disabled]) };
  };
  const press = async (point: { x: number; y: number; obscured?: boolean }) => {
    if (options.signal?.aborted) throw new Error('操作已取消。');
    await driver.checkTarget();
    const state = await readCalendarPanel(element);
    const at = (p: { x: number; y: number }) => p.x === point.x && p.y === point.y;
    const action = state.prev.some(at) ? 'earlier' : state.next.some(at) ? 'later'
      : state.cells.find(at)?.value ?? (state.header && at(state.header) ? 'year-header' : 'month-header');
    if (point.obscured) {
      const offset = await element.evaluate((el, at) => {
        const r = el.getBoundingClientRect();
        return { x: at.x - r.left, y: at.y - r.top };
      }, point);
      // This helper only relocates our own card. Re-read the calendar target
      // afterwards; no click may pass through an unrelated website overlay.
      await element.evaluate(isApplicationClickTarget, offset);
      const fresh = await readCalendarPanel(element);
      const nextPoint = typeof action === 'number' ? fresh.cells.find(cell => cell.value === action)
        : action === 'year-header' ? fresh.header : action === 'month-header' ? fresh.monthHeader
          : action === 'earlier' ? fresh.prev[state.prev.findIndex(at)] : fresh.next[state.next.findIndex(at)];
      if (!nextPoint || nextPoint.obscured || fresh.view !== state.view || fresh.year !== state.year || fresh.month !== state.month)
        throw new Error('日期面板被浮层遮挡，请先收起悬浮卡或关闭遮挡层后重试。');
      point = nextPoint;
    }
    // Calendar paging and cell clicks follow a deterministic path: adapter budget.
    await explorationStep(options.signal, `date:${action}`, await observe(), async () => {
      options.signal?.throwIfAborted();
      await page.mouse.click(point.x, point.y);
      await wait(180);
    }, observe, { kind: 'adapter' });
  };
  const target = { year, month: month ?? 1 };
  let selected = false;
  let rangePending = false;
  let popupCloseError = '';
  let dateFailure: { code: string; message: string } | undefined;
  let dateDiagnostic: FormWriteResult['dateDiagnostic'];
  const failDate = (code: string, message: string): never => { dateFailure = { code, message }; throw new Error(message); };
  const closeFailure = (message: string): never => { popupCloseError = message; throw new Error(message); };
  const request: FormWriteRequest = {
    kind: initial.kind, expectedIdentity: identity,
    observedValue: options.observedValue ?? initial.value, desiredValue: value,
    allowReplace: options.allowReplace, allowReadOnly: true, signal: options.signal, maxAttempts: 1,
  };
  const requiresDayPrecision = (formats: string[]) =>
    formats.length > 0 &&
    formats.every(format => {
      const tokens = format.replace(/\[[^\]]*\]|\\./g, '');
      return /[yY]/.test(tokens) && /[mM]/.test(tokens) && /[dD]/.test(tokens);
    });
  const result = await writeVerifiedControl({
    read,
    adapters: ['date-panel'],
    write: async () => {
      let state = await readCalendarPanel(element, target);
      if (!state.open) {
        const reqFormats = initial.requirements?.dateFormats ?? [];
        if (day === null && requiresDayPrecision(reqFormats)) {
          dateDiagnostic = { formats: reqFormats, inputPresent: true, inputInvalid: false, inputMatches: false };
          failDate('DATE_PRECISION_REQUIRED', '网页要求完整的年、月、日，当前资料只有年月，请补充具体日期。已暂缓此项，不会自动补造日期。');
        }
        await driver.reveal(element);
      }
      try {
        state = await readCalendarPanel(element, target);
        if (!state.open) {
          await driver.waitForClickTarget(element, options.signal);
          await explorationStep(options.signal, 'date:open', await observe(), async () => {
            options.signal?.throwIfAborted();
            await element.click();
            await wait(180);
          }, observe, { kind: 'adapter' });
          for (let poll = 0; poll < 15 && !state.open; poll++) {
            await wait(120);
            state = await readCalendarPanel(element, target);
          }
          for (let settle = 0; settle < 4 && state.open; settle++) {
            const prevPt = state.header ?? state.cells[0];
            await wait(60);
            const nextState = await readCalendarPanel(element, target);
            const nextPt = nextState.header ?? nextState.cells[0];
            state = nextState;
            if (prevPt && nextPt && Math.abs(prevPt.x - nextPt.x) < 1 && Math.abs(prevPt.y - nextPt.y) < 1) break;
          }
        }
        if (!state.open) {
          if (month === null) failDate('DATE_SELECTION_UNAVAILABLE', '未发现可确认年份的日期面板，请在网页核对。');
          const reqFormats = initial.requirements?.dateFormats ?? [];
          if (day === null && requiresDayPrecision(reqFormats)) {
            dateDiagnostic = { formats: reqFormats, inputPresent: true, inputInvalid: false, inputMatches: false };
            failDate('DATE_PRECISION_REQUIRED', '网页要求完整的年、月、日，当前资料只有年月，请补充具体日期。已暂缓此项，不会自动补造日期。');
          }
          // Some portals wrap a plain editable text input in a date-editor class without mounting a calendar popup.
          if (!initial.readOnly && initial.kind === 'text') {
            const formatted = day === null
              ? `${year}-${String(month).padStart(2, '0')}`
              : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            options.signal?.throwIfAborted();
            await element.evaluate(writeFormText, formatted);
            options.signal?.throwIfAborted();
            await element.evaluate(commitFormControl, true);
            await wait(150);
            request.desiredValue = formatted;
            return;
          }
          throw new Error('点开后没有出现日期面板。');
        }
        if (state.range && !(await element.evaluate(el => el.ownerDocument.activeElement === el))) {
          options.signal?.throwIfAborted();
          await element.click();
          await wait(180);
        }
        let headerTried = false;
        let monthHeaderTried = false;
        for (let step = 0; step < 60; step++) {
          state = await visiblePanel(target);
          if (!state.open) return;
          if (state.monthSelectionOnly && day !== null && month !== null) {
            day = null;
            value = `${year}-${String(month).padStart(2, '0')}`;
            request.desiredValue = value;
          }
          if (selected) {
            for (let poll = 0; poll < 5; poll++) {
              if (formValuesEquivalent((await read()).value, value)) {
                rangePending = Boolean(state.range && continueRange);
                return;
              }
              await wait(60);
            }
            throw new Error(`已点击目标日期，但回读值「${(await read()).value || '空'}」与目标「${value}」不一致，已停止重复点击。`);
          }
          const formats = state.formats ?? state.input?.formats ?? [];
          if (day === null && requiresDayPrecision(formats)) {
            dateDiagnostic = { formats, inputPresent: true, inputInvalid: false, inputMatches: false };
            failDate('DATE_PRECISION_REQUIRED', '网页要求完整的年、月、日，当前资料只有年月，请补充具体日期。已暂缓此项，不会自动补造日期。');
          }
          if (state.view === 'unknown' || state.year === null) throw new Error('认不出日期面板的结构。');
          const outerPrev = state.prev[0];
          const outerNext = state.next[state.next.length - 1];
          if (state.view === 'year') {
            const cell = state.cells.find(entry => entry.value === year);
            if (cell) {
              if (cell.disabled) throw new Error(`面板上 ${year} 年不可选。`);
              await press(cell);
              const afterYear = await readCalendarPanel(element, target);
              if (!afterYear.open && (await read()).value.trim() === String(year)) {
                // The widget itself committed a year and closed. Restrict this
                // precision conversion to that observed interaction.
                request.desiredValue = String(year);
                selected = true;
                return;
              }
              if (month === null && afterYear.open && afterYear.view !== 'year')
                failDate('DATE_PRECISION_REQUIRED', '此日历还需要月份，当前资料只有年份，请补充月份。');
              continue;
            }
            const lowest = Math.min(...state.cells.map(entry => entry.value));
            const arrow = year < lowest ? outerPrev : outerNext;
            if (!arrow) throw new Error('日期面板没有翻页箭头。');
            await press(arrow);
            continue;
          }
          if (state.view === 'month') {
            if (month === null) failDate('DATE_PRECISION_REQUIRED', '此日历还需要月份，当前资料只有年份，请补充月份。');
            if (state.year === year) {
              const cell = state.cells.find(entry => entry.value === month);
              if (!cell || cell.disabled) throw new Error(`面板上 ${year} 年 ${month} 月不可选。`);
              await press(cell);
              selected = day === null;
              continue;
            }
            if (state.header && Math.abs(year - state.year) >= 2 && !headerTried) {
              headerTried = true;
              await press(state.header);
              continue;
            }
            const arrow = year < state.year ? outerPrev : outerNext;
            if (!arrow) throw new Error('日期面板没有翻页箭头。');
            await press(arrow);
            continue;
          }
          // Month-only data must never select an invented day. Use the panel's month entry;
          // if it cannot commit a month, report that limitation instead of typing into the popup.
          if (day === null) {
            if (state.daySelectionOnly)
              failDate('DATE_PRECISION_REQUIRED', '当前日历需要选择具体日，资料只有年月，请补充或在网页确认日期。');
            if (state.monthHeader && !monthHeaderTried) {
              monthHeaderTried = true;
              await press(state.monthHeader);
              continue;
            }
            failDate('DATE_SELECTION_UNAVAILABLE', '此日历无法直接保存年月，已停止；请在网页确认日期，不会补造具体日。');
          }
          // 日视图
          if (state.year === year && state.month === month) {
            const cell = state.cells.find(entry => entry.value === day);
            if (!cell || cell.disabled) throw new Error(`面板上 ${value} 不可选。`);
            await press(cell);
            selected = true;
            continue;
          }
          if (month === null) failDate('DATE_PRECISION_REQUIRED', '此日历需要完整日期，当前资料只有年份。');
          const gap = (year - state.year) * 12 + (month! - (state.month ?? month!));
          const twoEach = state.prev.length >= 2 && state.next.length >= 2;
          if (
            year !== state.year &&
            state.header &&
            !headerTried &&
            (Math.abs(year - state.year) >= 2 || !twoEach)
          ) {
            headerTried = true;
            await press(state.header);
            continue;
          }
          if (
            state.year === year &&
            state.month !== null &&
            Math.abs(month! - state.month) >= 3 &&
            state.monthHeader &&
            !monthHeaderTried
          ) {
            monthHeaderTried = true;
            await press(state.monthHeader);
            continue;
          }
          const arrow =
            year !== state.year && twoEach
              ? gap < 0 ? outerPrev : outerNext
              : gap < 0 ? state.prev[state.prev.length - 1] : state.next[0];
          if (!arrow) throw new Error('日期面板没有翻页箭头。');
          await press(arrow);
        }
        throw new Error('日期面板翻页次数过多，已停止。');
      } finally {
        if (!rangePending) {
          const readPanel = () => readCalendarPanel(element, target);
          if (!options.signal?.aborted) {
            // Let a successful selection's closing animation finish first.
            for (let poll = 0; selected && poll < 9 && (await readPanel()).open; poll++) await wait(50);
            if (!(await dismissCalendarPopup(driver, element, readPanel, options.signal)))
              closeFailure('日期弹层尚未收起，请手动关闭后重试。');
          } else {
            try {
              await releaseCalendarPopup(element, await readPanel());
            } catch {
              // Best-effort cleanup when a date step budget aborts mid-selection.
            }
          }
        }
      }
    },
  }, request);
  if (rangePending && !options.signal?.aborted) return { ...result, status: 'failed', code: 'DATE_RANGE_PENDING', message: '开始日期已选择，等待同组结束日期确认。' };
  if (popupCloseError) return { ...result, status: 'failed', code: 'DATE_PANEL_STILL_OPEN', message: popupCloseError, dateDiagnostic };
  return dateFailure && result.status === 'failed' ? { ...result, ...dateFailure, dateDiagnostic } : result;
}

/** 按显示文字点击页面没做成按钮的元素（after 用来限定在某段文字之后）；会离开页面或提交的不点。 */
