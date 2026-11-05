/** Self-contained because Puppeteer serializes this function into the target frame. */
export function revealApplicationField(element: Element) {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view || !element.isConnected) return;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // Centering leaves space for both the site's sticky header and our status card.
  if (rect.top < 150 || rect.bottom > view.innerHeight * 0.75 || rect.left < 0 || rect.right > view.innerWidth)
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  if (element instanceof view.HTMLElement) element.focus({ preventScroll: true });
  doc.getElementById('qz-agent-field-focus')?.remove();
  const host = doc.createElement('div');
  host.id = 'qz-agent-field-focus';
  host.style.cssText =
    'all:initial!important;position:fixed!important;pointer-events:none!important;z-index:2147483646!important;';
  const root = host.attachShadow({ mode: 'closed' });
  const ring = doc.createElement('div');
  ring.style.cssText =
    'position:absolute;inset:0;border:2px solid #369b79;border-radius:7px;box-shadow:0 0 0 4px #369b7926;box-sizing:border-box;';
  root.append(ring);
  doc.documentElement.append(host);
  const until = Date.now() + 2400;
  const position = () => {
    if (!host.isConnected || !element.isConnected || Date.now() > until) {
      host.remove();
      return;
    }
    const box = element.getBoundingClientRect();
    host.style.setProperty('left', `${box.left - 3}px`, 'important');
    host.style.setProperty('top', `${box.top - 3}px`, 'important');
    host.style.setProperty('width', `${box.width + 6}px`, 'important');
    host.style.setProperty('height', `${box.height + 6}px`, 'important');
    view.requestAnimationFrame(position);
  };
  position();
}
