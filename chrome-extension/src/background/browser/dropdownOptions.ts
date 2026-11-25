import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { DOMElementNode } from './dom/views';
import { scrollDropdown } from './dropdownScroll';
import { applicationSubmitGuard, nearbyOptions, ownedOptions, readLiveControl, writeFormText } from './formControls';
import { explorationStep } from '../controlExploration';
import { dismissControlPopup } from './popupDismissal';
import { popupVisibilityGuard } from './popupVisibility';
import type { PageDriver } from './pageDriver';
import { applicationControl } from './pageInspection';
import { RECRUITING_ADAPTERS, recruitingOptions, type RecruitingOptions } from './recruitingAdapters';

/** 自定义下拉的展开、滚动与收起；选择和列出选项共用同一套归属规则。 */

export async function customDropdown(driver: PageDriver, element: ElementHandle, text: string, signal?: AbortSignal) {
  const searchHandle = await element.evaluateHandle(el => {
    const inputs = el.tagName === 'INPUT' ? [el] : Array.from(el.querySelectorAll('input'));
    const eligible = inputs.filter(
      input =>
        ['text', 'search'].includes((input as HTMLInputElement).type) &&
        !(input as HTMLInputElement).readOnly &&
        !(input as HTMLInputElement).disabled &&
        !input.closest('[hidden], [aria-hidden="true"]'),
    );
    return eligible.length === 1 ? eligible[0] : null;
  });
  const search = searchHandle.asElement() as ElementHandle | null;
  const typable = Boolean(search);
  const adapted = (await element.evaluate(recruitingOptions, RECRUITING_ADAPTERS, text)) as RecruitingOptions;
  // 网页声明了归属就只认声明；位置退路只给完全没有声明的网页。
  const declared = await element.evaluate(el =>
    Boolean(el.getAttribute('aria-controls') || el.getAttribute('aria-owns')),
  );
  const observe = async () => {
    const control = await readLiveControl(element, true);
    const panel = await readListed();
    return { value: control.value, valid: control.valid, error: control.validationMessage,
      open: panel.open, options: panel.options, depth: (panel as RecruitingOptions).cascaderDepth };
  };
  const clickGuarded = async (target: ElementHandle, reveal = true) => {
    await driver.checkTarget();
    if (signal?.aborted) throw new Error('操作已取消。');
    if (reveal) await driver.reveal(target);
    await driver.waitForClickTarget(target, signal);
    const label = await target.evaluate(el => el.getAttribute('aria-label') ?? el.textContent ?? '');
    return explorationStep(signal, `dropdown:click:${label}`, await observe(), async () => {
    signal?.throwIfAborted();
    await target.evaluate(applicationSubmitGuard, 'start' as const);
    let blocked = false;
    try {
      signal?.throwIfAborted();
      await target.click();
    } finally {
      blocked = await target.evaluate(applicationSubmitGuard, 'stop' as const);
    }
    if (blocked) throw new Error('点击会触发表单提交，已阻止。');
    await new Promise(resolve => setTimeout(resolve, 180));
    }, observe, { kind: 'adapter' });
  };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const readListed = async (label = text) => {
    if (adapted.supported)
      return (await element.evaluate(recruitingOptions, RECRUITING_ADAPTERS, label)) as RecruitingOptions;
    const owned = await element.evaluate(ownedOptions, label);
    if (owned.open || declared) {
      const b = owned.bounds;
      return { ...owned, box: b ? { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2, height: b.height } : null };
    }
    return element.evaluate(nearbyOptions, label);
  };
  const revealPopup = popupVisibilityGuard(driver, element, signal, 'dropdown');
  const listed = (label = text) => revealPopup(() => readListed(label));
  const open = async (allowSearch = false) => {
    const current = await listed();
    if (current.open) return current;
    for (let round = 0; round < 2; round++) {
      // 第一次点击可能把正在收起的弹层再次收起；等动画结束再点一次。
      if (round) await wait(500);
      // Search inputs can be covered by their own display label. Click the
      // declared trigger owning exactly this input, not a hidden search box.
      const triggerHandle = await element.evaluateHandle(el => {
        if (el.matches('.mtd-select')) return el.querySelector('.mtd-select-filter[role="button"]');
        if (!el.matches('input')) return null;
        const trigger = el.closest('[role="button"], [role="combobox"]');
        const inputs = trigger?.querySelectorAll('input,select,textarea');
        return trigger && inputs?.length === 1 && inputs[0] === el &&
          !trigger.matches('button,a') ? trigger : null;
      });
      try {
        await clickGuarded((triggerHandle.asElement() as ElementHandle | null) ?? element);
      } finally {
        await triggerHandle.dispose();
      }
      for (let poll = 0; poll < 20; poll++) {
        if (signal?.aborted) throw new Error('操作已取消。');
        await wait(100);
        const state = await listed();
        if (state.open) return state;
        // Remote school searches can render no popup until the first query.
        if (allowSearch && typable) return state;
      }
    }
    throw new Error('点开后没有出现该字段的选项。');
  };
  const move = async (state: Awaited<ReturnType<typeof listed>>, direction: 'start' | 'next', label = text) => {
    if (signal?.aborted) throw new Error('操作已取消。');
    state = await listed(label);
    if (!state.open) return null;
    const box = state.box;
    if (!box) return null;
    signal?.throwIfAborted();
    const movement = await element.evaluate(scrollDropdown, box, direction);
    if (!movement?.moved) return null;
    // Virtual rows arrive after the scroll event. Unchanged text alone does not mean the list ended.
    let next = state;
    for (let poll = 0; poll < 10; poll++) {
      await wait(50);
      if (signal?.aborted) throw new Error('操作已取消。');
      next = await listed(label);
      if (next.options.join('\n') !== state.options.join('\n')) break;
    }
    return next;
  };
  const rewind = async (state: Awaited<ReturnType<typeof listed>>, label = text) =>
    (await move(state, 'start', label)) ?? (await listed(label));
  const scroll = (state: Awaited<ReturnType<typeof listed>>, label = text) => move(state, 'next', label);
  const close = async () => {
    if (signal?.aborted) return;
    // Escape cancels the committed value in some editable selects (including Feishu).
    await element.evaluate(el => {
      const active = el.ownerDocument.activeElement;
      if (active && (active === el || el.contains(active))) (active as HTMLElement).blur();
    });
    if ((await readListed()).open) {
      if (await dismissControlPopup(driver, element, async () => (await readListed()).open, signal)) return;
      signal?.throwIfAborted();
      // Element UI / Popper popups close via v-clickoutside on document mousedown/mouseup rather than blur.
      await element.evaluate(el => {
        const doc = el.ownerDocument;
        const view = doc.defaultView;
        if (!view || !doc.body) return;
        doc.body.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        doc.body.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        doc.body.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    }
    // Blur only starts the closing animation. Do not let the next field click land on this popup.
    await driver.waitForDropdownClosed(readListed, signal);
  };
  return {
    typable,
    search,
    searchHandle,
    adapted: adapted.supported,
    declared,
    peek: readListed,
    listed,
    open,
    rewind,
    scroll,
    close,
    clickGuarded,
    wait,
  };
}

/** 展开自定义下拉并列出全部可选项（只读长列表滚动收集），不做选择，最后收起。 */

export async function listCustomOptions(
  driver: PageDriver,
  node: DOMElementNode,
  signal?: AbortSignal,
): Promise<string[]> {
  const { element } = await applicationControl(driver, node);
  const dropdown = await customDropdown(driver, element, '', signal);
  try {
    let state = await dropdown.rewind(await dropdown.open(true));
    const all = new Set(state.options);
    for (let round = 0; round < 80; round++) {
      const next = await dropdown.scroll(state);
      if (!next) return [...all];
      next.options.forEach(option => all.add(option));
      state = next;
    }
    throw new Error('下拉候选尚未遍历完，不能将部分选项当作完整列表。');
  } finally {
    try {
      await dropdown.close();
    } finally {
      await dropdown.searchHandle.dispose();
    }
  }
}

/** 读取单字段真实下拉可选项（兼容原生 select 与自定义 combobox）。 */

export async function listControlOptions(
  driver: PageDriver,
  node: DOMElementNode,
  signal?: AbortSignal,
): Promise<string[]> {
  if ((node.tagName ?? '').toLowerCase() === 'select') {
    const { element } = await applicationControl(driver, node);
    return element.evaluate(el =>
      Array.from((el as HTMLSelectElement).options)
        .filter(option => !option.disabled && !option.parentElement?.hasAttribute('disabled') && option.value !== '')
        .map(option => option.text.trim())
        .filter(Boolean),
    );
  }
  return driver.page.listCustomOptions(node, signal);
}

/** 按关键字筛选或触发远程搜索下拉选项，收集候选后清空临时查询并收起弹层。 */

export async function searchControlOptions(
  driver: PageDriver,
  node: DOMElementNode,
  query: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const q = query.trim();
  if (!q) return driver.page.listControlOptions(node, signal);
  const needle = q.toLowerCase();
  if ((node.tagName ?? '').toLowerCase() === 'select') {
    const all = await driver.page.listControlOptions(node, signal);
    return all.filter(opt => opt.toLowerCase().includes(needle));
  }
  const { element } = await applicationControl(driver, node);
  const dropdown = await customDropdown(driver, element, q, signal);
  try {
    let state = await dropdown.open(true);
    if (dropdown.typable && dropdown.search) {
      const beforeSig = state.options.join('\n');
      signal?.throwIfAborted();
      await dropdown.search.evaluate(writeFormText, '');
      signal?.throwIfAborted();
      await dropdown.search.type(q, { delay: 20 });
      let prevSig = '';
      for (let poll = 0; poll < 10; poll++) {
        await dropdown.wait(120);
        state = await dropdown.listed(q);
        if (state.matches > 0) break;
        const sig = state.options.join('\n');
        if (poll >= 2 && sig !== beforeSig && sig === prevSig && state.options.length > 0) break;
        prevSig = sig;
      }
      const matched = [...new Set(state.options)];
      signal?.throwIfAborted();
      await dropdown.search.evaluate(writeFormText, '').catch(() => {});
      return matched;
    }
    const all = new Set(state.options);
    for (let round = 0; round < 30; round++) {
      const next = await dropdown.scroll(state, q);
      if (!next) break;
      next.options.forEach(opt => all.add(opt));
      state = next;
    }
    return [...all].filter(opt => opt.toLowerCase().includes(needle));
  } finally {
    try {
      await dropdown.close();
    } finally {
      await dropdown.searchHandle.dispose();
    }
  }
}
