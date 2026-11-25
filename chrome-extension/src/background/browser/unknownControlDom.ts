import type { PopupBounds } from './popupVisibility';
import type { ChoicePolicy } from './controlState';

/** Serialized into the target frame. Only observed, field-owned elements receive action IDs. */
export interface UnknownObservation {
  revision: string;
  fieldText: string;
  values: string[];
  invalid: string[];
  popupOpen: boolean;
  choicePolicy?: ChoicePolicy;
  selectionConfirmed?: boolean;
  targets: Array<{ id: string; text: string; tag: string; role: string; editable: boolean; region: 'field' | 'panel' }>;
  screenshot?: string;
}
export type UnknownAction = { action: 'click' | 'type' | 'scroll'; target: string; value?: string | null };

export function unknownControlDom(
  root: Element,
  command: 'start' | 'observe' | 'panel' | 'locate' | 'target' | 'stop',
  data?: { revision?: string; target?: string },
) {
  type Scope = {
    originalVisible: Set<Element>;
    panels: Set<Element>;
    targets: Map<string, Element>;
    revision: string;
    fingerprint: string;
    originalOpen: typeof window.open;
    originalSend: typeof WebSocket.prototype.send;
    blocked: boolean;
    openGuard: typeof window.open;
    sendGuard: typeof WebSocket.prototype.send;
  };
  const host = root as Element & { __qzUnknown?: Scope };
  const doc = root.ownerDocument,
    view = doc.defaultView!;
  const visible = (el: Element) => {
    if (!el.isConnected || el.closest('[hidden],[aria-hidden="true"],[inert],[id^="qz-agent-"]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const s = view.getComputedStyle(el),
      r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const elements = () => {
    const out: Element[] = [],
      roots: ParentNode[] = [doc];
    for (let i = 0; i < roots.length && out.length < 6000; i++)
      for (const el of Array.from(roots[i].querySelectorAll('*'))) {
        if (out.length >= 6000) break;
        out.push(el);
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    return out;
  };
  const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const text = (el: Element) => clean((el as HTMLElement).innerText ?? el.textContent).slice(0, 300);
  if (command === 'stop') {
    const s = host.__qzUnknown;
    if (s) {
      if (view.open === s.openGuard) view.open = s.originalOpen;
      if (view.WebSocket.prototype.send === s.sendGuard) view.WebSocket.prototype.send = s.originalSend;
      delete host.__qzUnknown;
    }
    return null;
  }
  if (command === 'start') {
    if (host.__qzUnknown) throw new Error('该控件已有探索操作。');
    if (root.matches('html,body,form,button,a,input[type=password],input[type=file],input[type=submit]'))
      throw new Error('探索入口不是可安全限定的字段。');
    const r = root.getBoundingClientRect();
    if (!visible(root) || r.width > 1200 || r.height > 500 || root.querySelectorAll('input,select,textarea').length > 2)
      throw new Error('无法将探索范围限定到单个可见字段。');
    const s: Scope = {
      originalVisible: new Set(elements().filter(visible)),
      panels: new Set(),
      targets: new Map(),
      revision: '',
      fingerprint: '',
      originalOpen: view.open,
      originalSend: view.WebSocket.prototype.send,
      blocked: false,
      openGuard: null!,
      sendGuard: null!,
    };
    s.openGuard = (() => {
      s.blocked = true;
      return null;
    }) as typeof window.open;
    s.sendGuard = (() => {
      s.blocked = true;
      throw new Error('探索期间禁止发送外部消息。');
    }) as typeof WebSocket.prototype.send;
    view.open = s.openGuard;
    view.WebSocket.prototype.send = s.sendGuard;
    host.__qzUnknown = s;
    return null;
  }
  const s = host.__qzUnknown;
  if (!s || !root.isConnected) throw new Error('字段已重绘或探索已结束，请手动核对。');
  if (s.blocked) throw new Error('探索触发外部操作，已阻止并停止该字段。');
  const all = elements();
  const rr = root.getBoundingClientRect();
  const declared = new Set<string>();
  for (const el of [root, ...Array.from(root.querySelectorAll('[aria-controls],[aria-owns]'))])
    for (const id of `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/))
      if (id) declared.add(id);
  for (const el of all) {
    if (!visible(el) || el === root || el.contains(root) || el.matches('html,body,form,[role=dialog],dialog')) continue;
    const r = el.getBoundingClientRect();
    const near = r.left < rr.right + 80 && r.right > rr.left - 80 && r.top < rr.bottom + 450 && r.bottom > rr.top - 450;
    const sized = r.width >= 50 && r.width <= 1000 && r.height >= 20 && r.height <= 800;
    const popupStyle = ['absolute', 'fixed'].includes(view.getComputedStyle(el).position);
    const semanticPanel = el.matches('[role=listbox],[role=tree],[role=grid]');
    if (
      sized &&
      ((root.contains(el) && semanticPanel) ||
        declared.has(el.id) ||
        (near && !s.originalVisible.has(el) && (popupStyle || semanticPanel)))
    )
      s.panels.add(el);
  }
  const panels = [...s.panels]
    .filter(visible)
    .filter(el => ![...s.panels].some(other => other !== el && visible(other) && other.contains(el)));
  if (command === 'panel') {
    const r = panels.length === 1 ? panels[0].getBoundingClientRect() : null;
    const bounds: PopupBounds | undefined = r ? {
      left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
    } : undefined;
    return { open: panels.length > 0, bounds };
  }
  const values: string[] = [],
    invalid: string[] = [];
  const fieldNodes = [root, ...Array.from(root.querySelectorAll('*'))].filter(
    el => visible(el) && !panels.some(panel => panel === el || panel.contains(el)),
  );
  for (const el of fieldNodes) {
    if (el.getAttribute('aria-invalid') && el.getAttribute('aria-invalid') !== 'false')
      invalid.push(text(el) || 'aria-invalid');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (
        el instanceof HTMLInputElement &&
        ['password', 'file', 'hidden', 'button', 'submit', 'checkbox', 'radio'].includes(el.type)
      )
        continue;
      if (el.validationMessage) invalid.push(el.validationMessage);
      values.push(
        el instanceof HTMLSelectElement
          ? Array.from(el.selectedOptions)
              .map(o => o.text)
              .join(' / ')
          : el.value,
      );
    } else if (!el.children.length && text(el) && !el.closest('label,button,a')) values.push(text(el));
  }
  for (const el of fieldNodes)
    for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/)) {
      const message = doc.getElementById(id);
      if (message && visible(message) && message.getAttribute('role') === 'alert') invalid.push(text(message));
    }
  const eligible = (el: Element) => {
    if (
      !visible(el) ||
      el.closest('[disabled],[aria-disabled=true],a[href],button:not([type=button]),[role=dialog],dialog')
    )
      return false;
    if (
      el.matches('input[type=submit],input[type=reset],input[type=file],input[type=password],input[type=hidden],iframe')
    )
      return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.top < view.innerHeight && r.bottom > 0;
  };
  const candidates = new Map<Element, 'field' | 'panel'>();
  for (const container of [root, ...panels]) {
    const region = container === root ? 'field' : 'panel';
    for (const el of [container, ...Array.from(container.querySelectorAll('*'))]) {
      if (candidates.size >= 160) break;
      if (
        eligible(el) &&
        (el === container ||
          !el.children.length ||
          el.matches('input,textarea,button,[role=option],[role=button],[tabindex]'))
      )
        candidates.set(el, region);
    }
  }
  const targets = [...candidates].map(([el, region], i) => ({
    id: `e${i}`,
    text: text(el),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') ?? '',
    editable: el.matches('input:not([readonly]):not([type=checkbox]):not([type=radio]),textarea:not([readonly])'),
    region,
  }));
  const state = {
    fieldText: text(root),
    values: [...new Set(values.map(clean).filter(Boolean))],
    invalid: [...new Set(invalid)],
    popupOpen: panels.length > 0 || fieldNodes.some(el => el.getAttribute('aria-expanded') === 'true'),
    targets,
  };
  const fingerprint = JSON.stringify(state);
  if (command === 'target' || command === 'locate') {
    if (data?.revision !== s.revision || fingerprint !== s.fingerprint) throw new Error('页面已变化，旧操作已作废。');
    const el = s.targets.get(data?.target ?? '');
    if (!el || !eligible(el) || !candidates.has(el)) throw new Error('操作不属于当前字段或所属弹层。');
    // Locate first so the driver can scroll past an edge toolbar or relocate
    // its own card. The caller must run target again before any operation.
    if (command === 'locate') return el;
    const r = el.getBoundingClientRect();
    const tree = el.getRootNode() as Document | ShadowRoot;
    const hit = tree.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || (hit !== el && !el.contains(hit))) throw new Error('控件被遮挡，已停止探索，请先处理遮挡。');
    return el;
  }
  s.revision = crypto.randomUUID();
  s.fingerprint = fingerprint;
  s.targets = new Map([...candidates.keys()].map((el, i) => [`e${i}`, el]));
  return { revision: s.revision, ...state };
}
