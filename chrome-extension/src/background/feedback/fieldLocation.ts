import type { FeedbackReviewItem } from '../feedbackSummary';
import { recoverApplicationClickTarget } from '../browser/clickTarget';
import { centerApplicationField } from '../browser/fieldViewport';

export function createFieldLocation(highlightCSS: string) {
  const cssEscape = (s: string) =>
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');

  const highlightTargetElement = (element: Element, badgeText: string) => {
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    if (!view || !element.isConnected) return;
    let target: Element = element;
    const rootRect = doc.documentElement.getBoundingClientRect();
    const hasLayout = rootRect.width > 0 || rootRect.height > 0;
    if (hasLayout) {
      for (let depth = 0; depth < 6 && target.parentElement; depth++) {
        const r = target.getBoundingClientRect();
        if (r.width >= 6 && r.height >= 6) break;
        target = target.parentElement;
      }
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      centerApplicationField(target);
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = target.getBoundingClientRect();
        if (!recoverApplicationClickTarget(target, { x: r.width / 2, y: r.height / 2 })) break;
      }
    }
    if (element instanceof view.HTMLElement) {
      element.focus?.({ preventScroll: true });
    }
    doc.getElementById('qz-agent-field-focus')?.remove();
    const focusHost = doc.createElement('div');
    focusHost.id = 'qz-agent-field-focus';
    focusHost.style.cssText =
      'all:initial!important;position:fixed!important;pointer-events:none!important;z-index:2147483646!important;';
    const focusRoot = focusHost.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = highlightCSS;
    const ring = doc.createElement('div');
    ring.className = 'ring';
    const badge = doc.createElement('div');
    badge.className = 'badge';
    const dot = doc.createElement('span');
    dot.className = 'dot';
    const txt = doc.createElement('span');
    txt.textContent = badgeText.slice(0, 32);
    badge.append(dot, txt);
    ring.append(badge);
    focusRoot.append(style, ring);
    doc.documentElement.append(focusHost);
    const until = Date.now() + 3800;
    const syncPos = () => {
      if (!focusHost.isConnected || !target.isConnected || Date.now() > until) {
        focusHost.remove();
        return;
      }
      const box = target.getBoundingClientRect();
      focusHost.style.setProperty('left', `${box.left - 4}px`, 'important');
      focusHost.style.setProperty('top', `${box.top - 4}px`, 'important');
      focusHost.style.setProperty('width', `${box.width + 8}px`, 'important');
      focusHost.style.setProperty('height', `${box.height + 8}px`, 'important');
      if (typeof view.requestAnimationFrame === 'function') view.requestAnimationFrame(syncPos);
    };
    syncPos();
  };

  const resolveFieldElement = (item: FeedbackReviewItem): Element | null => {
    try {
      const parsed = JSON.parse(item.key);
      if (Array.isArray(parsed) && parsed[1] === 'data-qz-field' && typeof parsed[2] === 'string' && parsed[2]) {
        const byAttr = document.querySelector(`[data-qz-field="${cssEscape(parsed[2])}"]`);
        if (byAttr) return byAttr;
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof parsed.id === 'string' &&
        parsed.id
      ) {
        const byObjId = document.getElementById(parsed.id);
        if (byObjId) return byObjId;
      }
    } catch {
      /* Continue to legacy key lookup. */
    }
    const rawLegacy = item.legacyKey || item.key;
    try {
      const legacy = JSON.parse(rawLegacy);
      if (Array.isArray(legacy) && legacy.length >= 9) {
        const [, , xpath, id, name, , , ariaLabel, placeholder] = legacy as string[];
        if (id) {
          const byId = document.getElementById(id);
          if (byId) return byId;
        }
        if (xpath && typeof xpath === 'string') {
          try {
            const expr = xpath.startsWith('/') ? xpath : `/${xpath}`;
            const node = document.evaluate(
              expr,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            ).singleNodeValue;
            if (node instanceof Element) return node;
          } catch {
            /* Ignore malformed XPath. */
          }
        }
        if (name) {
          const byName = document.querySelector(`[name="${cssEscape(name)}"]`);
          if (byName) return byName;
        }
        if (ariaLabel) {
          const byAria = document.querySelector(`[aria-label="${cssEscape(ariaLabel)}"]`);
          if (byAria) return byAria;
        }
        if (placeholder) {
          const byPh = document.querySelector(`[placeholder="${cssEscape(placeholder)}"]`);
          if (byPh) return byPh;
        }
      }
    } catch {
      /* Continue to label text search. */
    }
    const cleanLabel = item.label.replace(/\s*\*+\s*$/, '').trim();
    if (!cleanLabel) return null;
    const candidates = Array.from(
      document.querySelectorAll('label, .ant-form-item, .el-form-item, [class*="form-item" i], [class*="field" i]'),
    );
    for (const el of candidates) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text === cleanLabel || (text.includes(cleanLabel) && text.length <= cleanLabel.length + 36)) {
        const control = el.querySelector(
          'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="checkbox"]',
        );
        return control || el;
      }
    }
    return null;
  };

  const checkConsentOnPage = (target?: Element | null): boolean => {
    if (!target) return false;
    const checkElement = (el: Element): boolean => {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        if (!el.checked) {
          const label =
            el.closest('label') || (el.id ? document.querySelector(`label[for="${cssEscape(el.id)}"]`) : null);
          if (label instanceof HTMLElement) label.click();
          else el.click();
        }
        return el.checked;
      }
      const nested = el.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
      if (nested) return checkElement(nested);
      if (el.getAttribute('role') === 'checkbox' && el instanceof HTMLElement) {
        if (el.getAttribute('aria-checked') !== 'true') el.click();
        return el.getAttribute('aria-checked') === 'true';
      }
      return false;
    };
    return checkElement(target);
  };

  const isConsentCheckedOnPage = (item: FeedbackReviewItem): boolean => {
    const isElementChecked = (el: Element): boolean => {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        if (el.checked) return true;
      }
      const nested = el.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
      if (nested?.checked) return true;
      if (el.getAttribute('aria-checked') === 'true') return true;
      const wrapper = el.closest(
        '[role="checkbox"], [role="switch"], label, .ant-checkbox-wrapper, .ant-checkbox, .ud__checkbox, .atsx-checkbox-wrapper, .atsx-checkbox, .el-checkbox',
      );
      if (
        wrapper &&
        (wrapper.getAttribute('aria-checked') === 'true' ||
          wrapper.matches(
            '.ant-checkbox-wrapper-checked, .ant-checkbox-checked, .ud__checkbox-checked, .atsx-checkbox-wrapper-checked, .atsx-checkbox-checked, .el-checkbox.is-checked, .is-checked',
          ) ||
          Boolean(
            wrapper.querySelector(
              '.ant-checkbox-checked, .ud__checkbox-checked, .atsx-checkbox-checked, .el-checkbox__input.is-checked, [aria-checked="true"]',
            ),
          ))
      ) {
        return true;
      }
      return false;
    };
    const target = resolveFieldElement(item);
    if (target && isElementChecked(target)) return true;
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
    for (const box of boxes) {
      const wrapper = box.closest('label, div, p, span') || box.parentElement;
      const text = (wrapper?.textContent || '').replace(/\s+/g, ' ').trim();
      if (/同意|已阅读|隐私|协议|条款|承诺|知情|授权/.test(text) && isElementChecked(box)) {
        return true;
      }
    }
    return false;
  };
  return { highlightTargetElement, resolveFieldElement, checkConsentOnPage, isConsentCheckedOnPage };
}
