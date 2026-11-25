/** Serialized into the field's document. Center a new field in the space below
 * the status card and above fixed toolbars, without moving either overlay. */
export function centerApplicationField(element: Element): void {
  const doc = element.ownerDocument, view = doc.defaultView;
  if (!view || !element.isConnected) return;
  let target = element;
  for (let depth = 0; depth < 6 && target.parentElement; depth++) {
    const r = target.getBoundingClientRect();
    if (r.width >= 6 && r.height >= 6) break;
    target = target.parentElement;
  }
  const initial = target.getBoundingClientRect();
  if (!initial.width || !initial.height) return;
  const parents: Element[] = [];
  for (let parent = target.parentElement; parent && parent !== doc.body && parent !== doc.documentElement; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(view.getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight)
      parents.push(parent);
  }
  const usableCenter = () => {
    let top = 12, bottom = view.innerHeight - 12;
    const card = doc.getElementById('qz-agent-feedback')?.getBoundingClientRect();
    if (card && card.height > 0) top = Math.max(top, card.bottom + 16);
    for (const parent of parents) {
      const r = parent.getBoundingClientRect();
      top = Math.max(top, r.top + 12);
      bottom = Math.min(bottom, r.bottom - 12);
    }
    const field = target.getBoundingClientRect();
    const xs = [field.left + 2, (field.left + field.right) / 2, field.right - 2]
      .map(x => Math.max(1, Math.min(view.innerWidth - 1, x)));
    const ys = [1, top, bottom, view.innerHeight - 1];
    for (const x of xs) for (const y of ys) {
      for (let hit = doc.elementFromPoint(x, y); hit && hit !== doc.body; hit = hit.parentElement) {
        if (hit.contains(target) || hit.id.startsWith('qz-agent-') ||
          hit.closest('[role="dialog"], [aria-modal="true"], dialog') ||
          !['fixed', 'sticky'].includes(view.getComputedStyle(hit).position)) continue;
        const r = hit.getBoundingClientRect();
        if (r.height > view.innerHeight * 0.4 || r.width < field.width || r.right <= field.left || r.left >= field.right) continue;
        if (r.top <= top && r.bottom > top && r.bottom < bottom) top = r.bottom + 12;
        else if (r.bottom >= bottom && r.top < bottom && r.top > top) bottom = r.top - 12;
      }
    }
    return bottom - top >= field.height + 24 ? (top + bottom) / 2 : null;
  };
  // Inner containers may hit their scroll limit. Continue through the outer
  // containers with the remaining offset; one final pass handles sticky bars.
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const parent of [...parents, null]) {
      const center = usableCenter();
      if (center === null) return;
      const r = target.getBoundingClientRect();
      const delta = (r.top + r.bottom) / 2 - center;
      if (Math.abs(delta) <= 4) return;
      if (parent) {
        const before = parent.scrollTop;
        parent.scrollBy({ top: delta, behavior: 'instant' });
        moved ||= parent.scrollTop !== before;
      } else if (Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) > view.innerHeight) {
        const before = view.scrollY;
        view.scrollBy({ top: delta, behavior: 'instant' });
        moved ||= view.scrollY !== before;
      }
    }
    if (!moved) return;
  }
}
