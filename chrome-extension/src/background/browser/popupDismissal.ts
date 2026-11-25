import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import { applicationSubmitGuard } from './formControls';
import { explorationStep } from '../controlExploration';
import type { DatePanelState } from './datePanel';

/** Escape is sent only to the calendar element a family declared, never to the page:
 * the same key would also close a site modal that hosts the whole application form. */
async function focusCalendar(element: ElementHandle, state: DatePanelState): Promise<boolean> {
  const target = state.dismiss.kind === 'escape' ? state.dismiss : null;
  if (!target || !state.bounds) return state.focused === true;
  return element.evaluate((owner, bounds, target) => {
    const doc = owner.ownerDocument;
    const matching = Array.from(doc.querySelectorAll(target.popup)).filter(panel => {
      const r = panel.getBoundingClientRect();
      return Math.abs(r.left - bounds.left) < 2 && Math.abs(r.top - bounds.top) < 2 &&
        Math.abs(r.width - bounds.width) < 2 && Math.abs(r.height - bounds.height) < 2;
    });
    if (matching.length !== 1) return false;
    const calendar = matching[0].querySelector<HTMLElement>(target.selector);
    calendar?.focus({ preventScroll: true });
    return doc.activeElement === (calendar ?? owner);
  }, state.bounds, { popup: target.popup, selector: target.selector });
}

export async function dismissCalendarOutside(element: ElementHandle): Promise<void> {
  await element.evaluate(el => {
    const doc = el.ownerDocument;
    const view = doc.defaultView;
    if (doc.activeElement instanceof HTMLElement) doc.activeElement.blur();
    if (!view || !doc.body) return;
    for (const event of ['mousedown', 'mouseup', 'click'])
      doc.body.dispatchEvent(new view.MouseEvent(event, { bubbles: true, cancelable: true }));
  });
}

/** rc-picker closes on the blur of its own input. Once a selection moved focus away,
 * outside clicks no longer reach it; returning focus first restores that close path. */
export async function dismissCalendarBlur(element: ElementHandle): Promise<void> {
  await element.evaluate(el => {
    if (!(el instanceof HTMLElement)) return;
    el.focus({ preventScroll: true });
    el.blur();
  });
}

/** Non-clicking cleanup after a budget stop: no step budget remains for a caption click. */
export async function releaseCalendarPopup(element: ElementHandle, state: DatePanelState): Promise<void> {
  if (!state.open) return;
  if (state.dismiss.kind === 'outside') return dismissCalendarOutside(element);
  await dismissCalendarBlur(element);
  if (state.dismiss.kind !== 'blur') await dismissCalendarOutside(element);
}

/** Close only the panel owned by this field: the family's declared method first, then
 * the generic safe sequence (blur, outside press, the field's own caption). */
export async function dismissCalendarPopup(
  driver: { checkTarget(): Promise<void>; waitForClickTarget(element: ElementHandle, signal?: AbortSignal): Promise<void> },
  element: ElementHandle, read: () => Promise<DatePanelState>, signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const state = await read();
  if (!state.open) return true;
  await driver.checkTarget();
  signal?.throwIfAborted();
  const waitClosed = async () => {
    for (let poll = 0; poll < 20; poll++) {
      signal?.throwIfAborted();
      if (!(await read()).open) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
  const escape = async () => {
    if (!(await focusCalendar(element, state))) return false;
    signal?.throwIfAborted();
    await element.frame.page().keyboard.press('Escape');
    return waitClosed();
  };
  const declared = state.dismiss;
  if (declared.kind === 'toggle') {
    const handle = await element.evaluateHandle((el, selector) => el.querySelector(selector), declared.selector);
    try {
      const trigger = handle.asElement() as ElementHandle | null;
      if (trigger) {
        await driver.waitForClickTarget(trigger, signal);
        signal?.throwIfAborted();
        await trigger.click();
        if (await waitClosed()) return true;
      }
    } finally { await handle.dispose(); }
  }
  if (declared.kind === 'escape' && await escape()) return true;
  for (const method of declared.kind === 'outside' ? ['outside', 'blur'] as const : ['blur', 'outside'] as const) {
    if (method === 'blur') await dismissCalendarBlur(element);
    else await dismissCalendarOutside(element);
    if (await waitClosed()) return true;
  }
  if (await dismissControlPopup(driver, element, async () => (await read()).open, signal)) return true;
  // Last resort keeps the previous behaviour: Escape only while focus is inside this calendar.
  return declared.kind === 'escalate' && await escape();
}

/** Return only a non-interactive caption belonging to this small field group.
 * A real outside pointer event closes widgets that ignore Escape/body dispatch.
 * This function is serialized into the page. */
export function controlDismissCaption(element: Element): Element | null {
  const doc = element.ownerDocument, view = doc.defaultView;
  if (!view) return null;
  const interactive = 'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex],[onclick],[contenteditable="true"]';
  for (let group = element.parentElement, depth = 0; group && group !== doc.body && depth < 8; group = group.parentElement, depth++) {
    if (group.matches('form,section,main')) break;
    const controls = group.querySelectorAll('input:not([type="hidden"]),select,textarea');
    if (controls.length > 2) break;
    const labels = Array.from(group.querySelectorAll('label,.label,.mtd-form-item-label,[class$="-label"],[class$="__label"]')).filter(label => {
      if (label.contains(element) || element.contains(label) || label.closest(interactive) || label.querySelector(interactive)) return false;
      if (label instanceof HTMLLabelElement && label.control) return false;
      if (label.closest('[hidden],[aria-hidden="true"],[role="listbox"],[role="grid"]')) return false;
      const r = label.getBoundingClientRect(), s = view.getComputedStyle(label);
      return r.width > 0 && r.height > 0 && r.height < 100 && s.display !== 'none' && s.visibility !== 'hidden' &&
        s.cursor !== 'pointer' && (label.textContent?.trim().length ?? 0) > 0 && (label.textContent?.length ?? 0) < 160;
    });
    if (labels.length === 1) return labels[0];
    if (labels.length > 1) return null;
  }
  return null;
}

export async function dismissControlPopup(
  driver: { checkTarget(): Promise<void>; waitForClickTarget(element: ElementHandle, signal?: AbortSignal): Promise<void> },
  element: ElementHandle,
  isOpen: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!(await isOpen())) return true;
  const handle = await element.evaluateHandle(controlDismissCaption);
  try {
    const caption = handle.asElement() as ElementHandle | null;
    if (!caption) return false;
    await driver.checkTarget();
    await driver.waitForClickTarget(caption, signal);
    return await explorationStep(signal, 'popup:close-caption', { open: true }, async () => {
      signal?.throwIfAborted();
      await caption.evaluate(applicationSubmitGuard, 'start' as const);
      let blocked = false;
      try {
        signal?.throwIfAborted();
        await caption.click();
      } finally {
        blocked = await caption.evaluate(applicationSubmitGuard, 'stop' as const);
      }
      if (blocked) throw new Error('已阻止表单提交。');
      for (let poll = 0; poll < 10; poll++) {
        signal?.throwIfAborted();
        if (!(await isOpen())) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    }, async () => ({ open: await isOpen() }), { kind: 'adapter' });
  } finally {
    await handle.dispose();
  }
}
