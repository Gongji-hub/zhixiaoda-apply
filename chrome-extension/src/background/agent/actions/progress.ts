import type { BrowserState } from '../../browser/views';
import { DOMElementNode, DOMTextNode, type DOMBaseNode } from '../../browser/dom/views';

/** Compare observable page state, not successful mouse dispatch or the model's intent text. */
export function applicationProgressKey(state: BrowserState): string {
  const rows: unknown[] = [];
  const visit = (node: DOMBaseNode) => {
    if (node instanceof DOMTextNode) {
      if (node.isVisible && node.text.trim()) rows.push(node.text.replace(/\s+/g, ' ').trim());
      return;
    }
    if (!(node instanceof DOMElementNode)) return;
    if (['qz-agent-feedback', 'qz-agent-field-focus', 'playwright-highlight-container'].includes(node.attributes.id)) return;
    if (node.isVisible) rows.push([node.tagName, node.xpath,
      ['id', 'name', 'type', 'role', 'value', 'checked', 'disabled', 'required', 'href',
        'aria-invalid', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-valuetext', 'aria-busy']
        .map(key => node.attributes[key] ?? null)]);
    node.children.forEach(visit);
  };
  visit(state.elementTree);
  return JSON.stringify([state.tabId, state.url, state.scrollY, rows]);
}

/** Ignore intent wording and volatile element indices when identifying a repeated action. */
export function applicationActionKey(name: string, args: Record<string, unknown>, state: BrowserState): string | null {
  if (!['click_element', 'click_text'].includes(name)) return null;
  const node = typeof args.index === 'number' ? state.selectorMap.get(args.index) : undefined;
  return JSON.stringify([name, node?.xpath, node?.attributes.id, args.text, args.after]);
}
