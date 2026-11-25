/** Runs in the page, at Puppeteer's actual clickable point (including viewport clipping). */
export function isApplicationClickTarget(element: Element, offset: { x: number; y: number }): boolean {
  if (!element.isConnected) return false;
  const doc = element.ownerDocument;
  const rect = element.getBoundingClientRect();
  const point = { x: rect.left + offset.x, y: rect.top + offset.y };
  let hit = doc.elementFromPoint(point.x, point.y);
  // Walk open shadow roots without ignoring an overlay outside the target's shadow host.
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit !== null && (hit === element || element.contains(hit));
}

/** Scroll past an edge-fixed toolbar; never dismiss or click the obstruction. */
export function recoverApplicationClickTarget(element: Element, offset: { x: number; y: number }): boolean {
  const doc = element.ownerDocument, view = doc.defaultView;
  if (!view || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const hit = doc.elementFromPoint(rect.left + offset.x, rect.top + offset.y);
  if (!hit || hit === element || element.contains(hit)) return false;
  if (hit.closest('[role="dialog"], [aria-modal="true"], dialog')) return false;
  let bar: Element | null = hit;
  for (; bar && bar !== doc.body; bar = bar?.parentElement ?? null) {
    if (!['fixed', 'sticky'].includes(view.getComputedStyle(bar).position)) continue;
    const box = bar.getBoundingClientRect();
    const feedback = bar.id === 'qz-agent-feedback';
    if (bar.contains(element) || (!feedback && (box.width < view.innerWidth / 2 || box.height > view.innerHeight * 0.4))) continue;
    const bottom = !feedback && box.bottom >= view.innerHeight - 2, top = feedback || box.top <= 2;
    if (!bottom && !top) continue;
    // Keep the status card in place. Move only enough to expose the target,
    // and never synthesize a click through the card's own controls.
    const delta = bottom ? rect.bottom - box.top + 16 : rect.top - box.bottom - 16;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll)/.test(view.getComputedStyle(parent).overflowY)) continue;
      const before = parent.scrollTop;
      parent.scrollBy({ top: delta, behavior: 'instant' });
      if (parent.scrollTop !== before) return true;
    }
    const before = view.scrollY;
    view.scrollBy({ top: delta, behavior: 'instant' });
    return view.scrollY !== before;
  }
  return false;
}

/** Self-contained helper serialized into the page to explain what overlay is blocking a click target. */
export function describeClickObstruction(element: Element, offset: { x: number; y: number }): string {
  if (!element.isConnected) return '目标元素已脱离文档';
  const doc = element.ownerDocument;
  const rect = element.getBoundingClientRect();
  const point = { x: rect.left + offset.x, y: rect.top + offset.y };
  const hit = doc.elementFromPoint(point.x, point.y);
  if (!hit) return '点击坐标超出当前视口';
  const container =
    hit.closest('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="drawer" i], [class*="tour" i], [class*="guide" i], [class*="popover" i], [class*="mask" i], [class*="overlay" i]') ||
    hit;
  const containerText = (container.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const topControls: string[] = [];
  const candidates = Array.from(
    doc.querySelectorAll('button, [role="button"], a, [class*="close" i], [aria-label*="关闭"], [aria-label*="close" i]'),
  );
  for (const el of candidates) {
    if (el === element || element.contains(el) || el.closest('#qz-agent-feedback')) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) continue;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    if (cx < 0 || cy < 0 || cx > (doc.defaultView?.innerWidth || 0) || cy > (doc.defaultView?.innerHeight || 0)) continue;
    const topHit = doc.elementFromPoint(cx, cy);
    if (!topHit || (topHit !== el && !el.contains(topHit))) continue;
    const label = (
      el.textContent ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (label && !topControls.includes(label)) {
      topControls.push(label);
      if (topControls.length >= 5) break;
    }
  }
  const parts: string[] = [];
  if (containerText) parts.push(`遮挡层内容：“${containerText}”`);
  if (topControls.length) parts.push(`当前最上层可点击按钮：${topControls.map(t => `“${t}”`).join('、')}`);
  return parts.join('；') || `被 <${hit.tagName.toLowerCase()}> 遮挡`;
}
