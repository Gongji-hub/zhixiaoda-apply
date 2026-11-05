/** Runs in the page, at Puppeteer's actual clickable point (including viewport clipping). */
export function isApplicationClickTarget(element: Element, offset: { x: number; y: number }): boolean {
  if (!element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const point = { x: rect.left + offset.x, y: rect.top + offset.y };
  let hit = element.ownerDocument.elementFromPoint(point.x, point.y);
  // Walk open shadow roots without ignoring an overlay outside the target's shadow host.
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit !== null && (hit === element || element.contains(hit));
}
