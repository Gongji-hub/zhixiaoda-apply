import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import { explorationStep } from '../controlExploration';

export interface PopupBounds {
  left: number; top: number; right: number; bottom: number; width: number; height: number;
}
export interface PopupGeometry { open: boolean; bounds?: PopupBounds | null }

/** Serialized into the field's document. Scroll its container, never the
 * popup's internal list or the site's fixed toolbar. No website selectors or clicks. */
export function popupViewport(element: Element, panel: PopupBounds, scroll = false) {
  const doc = element.ownerDocument, view = doc.defaultView!;
  let top = 12, bottom = view.innerHeight - 12;
  const feedback = doc.getElementById('qz-agent-feedback')?.getBoundingClientRect();
  if (feedback && feedback.right > panel.left && feedback.left < panel.right)
    top = Math.max(top, feedback.bottom + 12);
  const parents: Element[] = [];
  for (let parent = element.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
    const s = view.getComputedStyle(parent);
    if (!/(auto|scroll)/.test(s.overflowY) || parent.scrollHeight <= parent.clientHeight) continue;
    parents.push(parent);
    const r = parent.getBoundingClientRect();
    top = Math.max(top, r.top + 8);
    bottom = Math.min(bottom, r.bottom - 8);
  }
  // Probe the edges that overlap this popup. A high-z-index sticky footer may
  // cover candidates even though the field and popup header remain clickable.
  const xs = [panel.left + 8, (panel.left + panel.right) / 2, panel.right - 8]
    .map(x => Math.max(1, Math.min(view.innerWidth - 1, x)));
  const ys = [top, bottom, panel.top + 4, panel.bottom - 4]
    .map(y => Math.max(1, Math.min(view.innerHeight - 1, y)));
  for (const x of xs) for (const y of ys) {
    for (let hit = doc.elementFromPoint(x, y); hit && hit !== doc.body; hit = hit.parentElement) {
      if (hit.id.startsWith('qz-agent-') || hit.contains(element)) continue;
      if (!['fixed', 'sticky'].includes(view.getComputedStyle(hit).position)) continue;
      const r = hit.getBoundingClientRect();
      // A fixed-position popup touching an edge is not the page toolbar.
      if (Math.abs(r.left - panel.left) < 1 && Math.abs(r.top - panel.top) < 1 &&
        Math.abs(r.width - panel.width) < 1 && Math.abs(r.height - panel.height) < 1) continue;
      if (r.height > view.innerHeight * 0.4 || r.width < panel.width || r.right <= panel.left || r.left >= panel.right) continue;
      if (r.bottom >= bottom && r.top > top) bottom = Math.min(bottom, r.top - 12);
      else if (r.top <= top && r.bottom < bottom) top = Math.max(top, r.bottom + 12);
    }
  }
  const fits = panel.height <= bottom - top;
  const delta = panel.bottom > bottom ? panel.bottom - bottom : panel.top < top ? panel.top - top : 0;
  let moved = false;
  if (scroll && fits && Math.abs(delta) > 1) {
    for (const parent of parents) {
      const before = parent.scrollTop;
      parent.scrollBy({ top: delta, behavior: 'instant' });
      if (parent.scrollTop !== before) { moved = true; break; }
    }
    if (!moved) {
      const before = view.scrollY;
      view.scrollBy({ top: delta, behavior: 'instant' });
      moved = before !== view.scrollY;
    }
  }
  return { fits, needsMove: Math.abs(delta) > 1, moved };
}

/** Re-observe after opening or changing popup content. All repositioning shares
 * the field budget and is capped even when a portal does not follow scrolling. */
export function popupVisibilityGuard(
  driver: { checkTarget(): Promise<void> }, element: ElementHandle, signal: AbortSignal | undefined,
  kind: 'date' | 'dropdown' | 'control',
) {
  const name = { date: '日期面板', dropdown: '下拉列表', control: '控件弹层' }[kind];
  let moves = 0;
  return async <T extends PopupGeometry>(
    read: () => Promise<T>, canReveal: (state: T) => boolean = () => true,
    canUseVisibleTarget: (state: T) => boolean = () => false,
  ): Promise<T> => {
    signal?.throwIfAborted();
    let panel = await read();
    while (panel.open && panel.bounds && canReveal(panel)) {
      const layout = await element.evaluate(popupViewport, panel.bounds);
      if (!layout.needsMove) return panel;
      if (!layout.fits || moves >= 2) {
        // A calendar may be larger than the visible area; its own hit test still
        // rejects any specific cell or navigation control covered by the page.
        if (canUseVisibleTarget(panel)) return panel;
        throw new Error(`${name}无法完整显示，已停止点击，请调整页面后重试。`);
      }
      await driver.checkTarget();
      moves++;
      await explorationStep(signal, `${kind}:reveal-panel`, { visible: false }, async () => {
        signal?.throwIfAborted();
        const result = await element.evaluate(popupViewport, panel.bounds!, true);
        if (!result.moved) throw new Error(`${name}被底栏或视口截断，无法继续滚动，已停止点击。`);
        // Popper and scroll listeners may reposition asynchronously. Require
        // stable fresh geometry rather than retaining any pre-scroll point.
        let previous = '';
        let stable = false;
        for (let poll = 0; poll < 6; poll++) {
          await new Promise(resolve => setTimeout(resolve, 60));
          signal?.throwIfAborted();
          panel = await read();
          const current = JSON.stringify(panel.bounds);
          if (panel.open && panel.bounds && current === previous) { stable = true; break; }
          previous = current;
        }
        if (!panel.open) throw new Error(`滚动后${name}已收起，旧点击位置已作废，请重新打开。`);
        if (!stable) throw new Error(`${name}位置仍在变化，已停止点击，请稍后重试。`);
      }, async () => ({ visible: Boolean(panel.bounds && !(await element.evaluate(popupViewport, panel.bounds)).needsMove) }), { kind: 'adapter' });
    }
    return panel;
  };
}
