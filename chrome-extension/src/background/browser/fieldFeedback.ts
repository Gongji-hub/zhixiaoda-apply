export const fieldHighlightCSS = `
    @keyframes qzFieldPulse {
      0%, 100% { box-shadow: 0 0 0 4px rgba(8, 105, 216, 0.20), 0 8px 24px rgba(8, 105, 216, 0.16); border-color: #0869d8; }
      50% { box-shadow: 0 0 0 7px rgba(16, 185, 129, 0.24), 0 10px 28px rgba(16, 185, 129, 0.20); border-color: #0d9488; }
    }
    .ring {
      position: absolute;
      inset: 0;
      border: 2px solid #0869d8;
      border-radius: 9px;
      background: linear-gradient(135deg, rgba(8, 105, 216, 0.05), rgba(16, 185, 129, 0.04));
      box-sizing: border-box;
      animation: qzFieldPulse 1.5s ease-in-out infinite;
    }
    .badge {
      position: absolute;
      top: -24px;
      left: 0;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 9px;
      border-radius: 999px;
      background: linear-gradient(135deg, #0869d8, #0d9488);
      color: #fff;
      font: 600 11px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(8, 105, 216, 0.25);
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #fff;
    }
  `;

/** Self-contained because Puppeteer serializes this function into the target frame. */
export function revealApplicationField(element: Element, highlightCSS: string, labelText?: string) {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view || !element.isConnected) return;
  let target: Element = element;
  for (let depth = 0; depth < 6 && target.parentElement; depth++) {
    const r = target.getBoundingClientRect();
    if (r.width >= 6 && r.height >= 6) break;
    target = target.parentElement;
  }
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // Keep already-visible fields still; the click guard handles fixed obstructions.
  if (rect.top < 0 || rect.bottom > view.innerHeight || rect.left < 0 || rect.right > view.innerWidth)
    target.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
  doc.getElementById('qz-agent-field-focus')?.remove();
  const host = doc.createElement('div');
  host.id = 'qz-agent-field-focus';
  host.style.cssText =
    'all:initial!important;position:fixed!important;pointer-events:none!important;z-index:2147483646!important;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = highlightCSS;
  const ring = doc.createElement('div');
  ring.className = 'ring';
  if (labelText) {
    const badge = doc.createElement('div');
    badge.className = 'badge';
    const dot = doc.createElement('span');
    dot.className = 'dot';
    const text = doc.createElement('span');
    text.textContent = labelText.slice(0, 32);
    badge.append(dot, text);
    ring.append(badge);
  }
  root.append(style, ring);
  doc.documentElement.append(host);
  const until = Date.now() + (labelText ? 3800 : 2600);
  const position = () => {
    if (!host.isConnected || !target.isConnected || Date.now() > until) {
      host.remove();
      return;
    }
    const box = target.getBoundingClientRect();
    host.style.setProperty('left', `${box.left - 4}px`, 'important');
    host.style.setProperty('top', `${box.top - 4}px`, 'important');
    host.style.setProperty('width', `${box.width + 8}px`, 'important');
    host.style.setProperty('height', `${box.height + 8}px`, 'important');
    view.requestAnimationFrame(position);
  };
  position();
}
