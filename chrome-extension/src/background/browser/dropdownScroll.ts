/** Runs in the page. Scroll only inside the already identified popup, never the document. */
export function scrollDropdown(
  element: Element,
  box: { x: number; y: number; height: number },
  direction: 'start' | 'next',
): { moved: boolean; top: number; max: number } | null {
  const doc = element.ownerDocument;
  const tree = element.getRootNode() as Document | ShadowRoot;
  let hit = tree.elementFromPoint?.(box.x, box.y) ?? doc.elementFromPoint?.(box.x, box.y);
  for (; hit && hit !== doc.body && hit !== doc.documentElement; hit = hit?.parentElement ?? null) {
    if (hit === element || hit.contains(element)) break;
    const rect = hit.getBoundingClientRect();
    // rc-virtual-list deliberately uses overflow:hidden and manages its own scrollbar.
    if (hit.clientHeight <= 0 || hit.scrollHeight <= hit.clientHeight + 1 ||
      rect.height > box.height + 4 || !/auto|scroll|hidden/.test(doc.defaultView!.getComputedStyle(hit).overflowY)) continue;
    const before = hit.scrollTop;
    const max = hit.scrollHeight - hit.clientHeight;
    hit.scrollTop = direction === 'start' ? 0 : Math.min(max, before + Math.max(1, hit.clientHeight * 0.8));
    return { moved: Math.abs(hit.scrollTop - before) > 0.5, top: hit.scrollTop, max };
  }
  return null;
}
