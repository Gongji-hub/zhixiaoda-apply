import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { HTTPRequest } from 'puppeteer-core/lib/esm/puppeteer/api/HTTPRequest.js';
import type { DOMElementNode } from './dom/views';
import type { PageDriver } from './pageDriver';
import type { AuditLocation } from './formAudit';
import { applicationControl } from './pageInspection';
import { applicationSubmitGuard, commitFormControl, readLiveControl, rememberFormSelection, soleFormControl, writeFormText } from './formControls';
import { RECRUITING_ADAPTERS } from './recruitingAdapters';
import { formValuesEquivalent } from './formFill';
import { unknownControlDom, type UnknownAction, type UnknownObservation } from './unknownControlDom';
import { readCalendarPanel } from './datePanel';
import { dismissCalendarPopup } from './popupDismissal';
import { popupVisibilityGuard, type PopupGeometry } from './popupVisibility';

const activePages = new WeakSet<object>();

export type UnknownTarget = { node: DOMElementNode } | { location: AuditLocation };
export interface UnknownControlSession {
  observe(): Promise<UnknownObservation>;
  act(observation: UnknownObservation, action: UnknownAction): Promise<void>;
  close(): Promise<void>;
}

export async function openUnknownControl(
  driver: PageDriver,
  target: UnknownTarget,
  signal: AbortSignal,
): Promise<UnknownControlSession> {
  signal.throwIfAborted();
  await driver.checkTarget();
  const page = driver.puppeteer;
  if (!page) throw new Error('页面连接不可用。');
  const url = page.url();
  let root: ElementHandle;
  if ('node' in target) root = (await applicationControl(driver, target.node)).element;
  else {
    const frame = page.frames()[target.location.frame];
    if (!frame || frame.url() !== target.location.frameUrl) throw new Error('待探索区域已变化，请重新扫描。');
    const handle = await frame.evaluateHandle((anchor: string) => {
      const roots: ParentNode[] = [document];
      for (let i = 0; i < roots.length; i++)
        for (const el of Array.from(roots[i].querySelectorAll('*'))) {
          if (el.getAttribute('data-qz-audit') === anchor) return el;
          if (el.shadowRoot) roots.push(el.shadowRoot);
        }
      return null;
    }, target.location.anchor);
    const element = handle.asElement() as ElementHandle<Element> | null;
    if (!element) {
      await handle.dispose();
      throw new Error('待探索字段已移除。');
    }
    root = element;
  }
  // Audits can point at a field wrapper. Read its sole actual control so a
  // search input cannot masquerade as a separately committed display value.
  const controlHandle = await root.evaluateHandle(soleFormControl, RECRUITING_ADAPTERS);
  const controlElement = controlHandle.asElement() as ElementHandle | null;
  const isField = controlElement && await controlElement.evaluate((el, adapters) =>
    el.matches('input, textarea, [contenteditable], [role="combobox"]') ||
    adapters.some(adapter => adapter.root && el.matches(adapter.root)), RECRUITING_ADAPTERS);
  if (controlElement && isField) { await root.dispose(); root = controlElement; }
  else await controlHandle.dispose();
  let blocked = false,
    closed = false,
    intercepting = false,
    started = false,
    listening = false,
    acquired = false;
  let cleanup: Promise<void> | undefined;
  const onAbort = () => {
    void close();
  };
  const stopRequest = (request: HTTPRequest) => {
    if (request.isInterceptResolutionHandled()) return;
    blocked = true;
    void request.abort('blockedbyclient').catch(() => {});
  };
  const close = () => {
    if (cleanup) return cleanup;
    closed = true;
    signal.removeEventListener('abort', onAbort);
    cleanup = (async () => {
      try {
        if (started) {
          await root.evaluate(unknownControlDom, 'stop' as const).catch(() => {});
          await root.evaluate(applicationSubmitGuard, 'stop' as const).catch(() => {});
        }
      } finally {
        if (intercepting) {
          await page.setRequestInterception(false).catch(() => {});
        }
        if (listening) page.off('request', stopRequest);
        if (acquired) activePages.delete(page);
        await root.dispose().catch(() => {});
      }
    })();
    return cleanup;
  };
  try {
    // The explorer is the sole request-interception owner; loading observers keep their listeners.
    if (activePages.has(page)) throw new Error('此页面已有控件探索，请稍后再试。');
    activePages.add(page);
    acquired = true;
    await driver.reveal(root);
    signal.throwIfAborted();
    // A leftover calendar predates the exploration snapshot and cannot be
    // treated as a newly opened, field-owned panel. Close it before observing.
    if (!(await dismissCalendarPopup(driver, root, () => readCalendarPanel(root), signal)))
      throw new Error('残留日期弹层无法安全收起，请手动关闭后重试。');
    await root.evaluate(unknownControlDom, 'start' as const);
    started = true;
    signal.throwIfAborted();
    await root.evaluate(applicationSubmitGuard, 'start' as const);
    signal.throwIfAborted();
    page.on('request', stopRequest);
    listening = true;
    await page.setRequestInterception(true);
    intercepting = true;
    signal.throwIfAborted();
    signal.addEventListener('abort', onAbort, { once: true });
  } catch (error) {
    await close();
    throw error;
  }
  const check = async () => {
    signal.throwIfAborted();
    if (closed || page.url() !== url) throw new Error('页面发生跳转，已停止控件探索。');
    await driver.checkTarget();
    signal.throwIfAborted();
    if (blocked || (await root.evaluate(applicationSubmitGuard, 'status' as const)))
      throw new Error('探索触发了网络请求或提交，已阻止；此控件请手动处理。');
  };
  const revealPopup = popupVisibilityGuard(driver, root, signal, 'control');
  return {
    async observe() {
      await check();
      await revealPopup(async () => (await root.evaluate(unknownControlDom, 'panel' as const)) as PopupGeometry);
      const observation = (await root.evaluate(unknownControlDom, 'observe' as const)) as UnknownObservation;
      let control = await readLiveControl(root, true);
      if (observation.popupOpen && control.kind === 'text' && !control.popup &&
        !(await root.evaluate(el => Boolean((el as HTMLInputElement).list)))) {
        await root.evaluate(rememberFormSelection, null);
        control = await readLiveControl(root, true);
      }
      observation.choicePolicy = control.choicePolicy;
      observation.selectionConfirmed = control.selectionConfirmed;
      if (control.kind !== 'unsupported' && control.valueKnown !== false)
        observation.values = control.value.trim() ? [control.value] : [];
      else if (observation.targets.some(target => target.region === 'field' && target.editable))
        observation.selectionConfirmed = false;
      signal.throwIfAborted();
      // A viewport screenshot accompanies live DOM IDs; no model-supplied coordinates are executed.
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 25,
        encoding: 'base64',
        captureBeyondViewport: false,
      });
      signal.throwIfAborted();
      if (screenshot.length > 240_000) throw new Error('当前截图超过单次探索范围，请手动处理此字段。');
      return { ...observation, screenshot: `data:image/jpeg;base64,${screenshot}` };
    },
    async act(observation, action) {
      await check();
      const handle = await root.evaluateHandle(unknownControlDom, 'locate' as const, {
        revision: observation.revision,
        target: action.target,
      });
      try {
        const element = handle.asElement() as ElementHandle<Element> | null;
        if (!element) throw new Error('无法定位当前观察中的控件。');
        await driver.waitForClickTarget(element, signal);
        // Validate again after the asynchronous hit test: never execute a stale model target.
        await root.evaluate(unknownControlDom, 'target' as const, {
          revision: observation.revision,
          target: action.target,
        });
        signal.throwIfAborted();
        if (action.action === 'type') {
          const candidate = observation.targets.find(item => item.id === action.target);
          if (!candidate?.editable) throw new Error('此元素不是可输入控件。');
          await element.evaluate(writeFormText, action.value ?? '');
        } else if (action.action === 'scroll') {
          await element.evaluate(el => {
            if (el.scrollHeight > el.clientHeight) el.scrollTop += Math.max(80, el.clientHeight * 0.7);
          });
        } else await element.click();
        await new Promise(resolve => setTimeout(resolve, 180));
        await check();
        const panel = (await root.evaluate(unknownControlDom, 'panel' as const)) as PopupGeometry;
        const control = await readLiveControl(root, true);
        if (action.action === 'click' && !panel.open && control.value.trim()) {
          const candidate = observation.targets.find(item => item.id === action.target);
          if (candidate?.region === 'panel' && formValuesEquivalent(candidate.text, control.value))
            await root.evaluate(rememberFormSelection, control.value);
        } else if (action.action === 'type' && !panel.open && control.choicePolicy === 'free_text') {
          signal.throwIfAborted();
          await element.evaluate(commitFormControl);
        }
      } finally {
        await handle.dispose();
      }
    },
    close,
  };
}
