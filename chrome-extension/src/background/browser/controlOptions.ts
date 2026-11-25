import type { RecruitingAdapter } from './recruitingAdapters';
import type { PopupBounds } from './popupVisibility';

/**
 * 模型常点到自定义控件的外框、显示层或箭头：自身不是表单控件时，取它内部唯一的控件，
 * 或往上几层唯一包住的控件；遇到包含多个控件的层就停，找不到唯一的返回 null。
 */
export function soleFormControl(element: Element, adapters: RecruitingAdapter[] = []): Element | null {
  for (const adapter of adapters) {
    const root = adapter.root ? element.closest(adapter.root) : null;
    if (root) return root === element ? null : root;
  }
  const roots = adapters
    .map(adapter => adapter.root)
    .filter(Boolean)
    .join(', ');
  const nestedRoots = roots ? element.querySelectorAll(roots) : [];
  if (
    nestedRoots.length === 1 &&
    !Array.from(element.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]')).some(
      control => !nestedRoots[0].contains(control),
    )
  )
    return nestedRoots[0];
  if (nestedRoots.length > 1) return null;
  const selector =
    'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [contenteditable=""], ' +
    '[role="combobox"], [role="listbox"], [role="textbox"], [role="radiogroup"], [role="checkbox"], [role="radio"], [role="switch"]';
  if (element.matches(selector)) return null;
  let scope: Element | null = element;
  for (
    let depth = 0;
    scope && scope !== element.ownerDocument.body && depth < 4;
    depth++, scope = scope.parentElement
  ) {
    const controls = scope.querySelectorAll(selector);
    if (controls.length === 1) return controls[0];
    if (controls.length > 1) return null;
  }
  return null;
}

/**
 * 列出 combobox/listbox 声明归属（自身包含或 aria-controls/aria-owns）的可见选项，按文本精确匹配。
 * 只规整空白，不做语义匹配：对不上就把实际选项交回模型选择。evaluate 会序列化本函数，不能引用外部变量。
 */
export function ownedOptions(
  element: Element,
  label: string,
): { valid: boolean; reason: string; open: boolean; options: string[]; matches: number; bounds?: PopupBounds } {
  const role = element.getAttribute('role');
  // Option discovery is shared by single- and multi-select tools; selection mode is checked by their callers.
  if (!['combobox', 'listbox'].includes(role || ''))
    return {
      valid: false,
      reason: '此控件不是 combobox/listbox；请观察它自身的交互方式。',
      open: false,
      options: [],
      matches: 0,
    };
  const root = element.getRootNode() as Document | ShadowRoot;
  const ids = `${element.getAttribute('aria-controls') || ''} ${element.getAttribute('aria-owns') || ''}`
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const owners = [
    element,
    ...ids.map(id => root.getElementById(id)).filter((owner): owner is HTMLElement => Boolean(owner)),
  ];
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const seen = new Set<Element>();
  const visible = owners
    .flatMap(owner => Array.from(owner.querySelectorAll('[role="option"]')))
    .filter(option => {
      if (seen.has(option)) return false;
      seen.add(option);
      const shown =
        typeof option.checkVisibility === 'function' ? option.checkVisibility({ visibilityProperty: true }) : true;
      return shown && !option.closest('[aria-disabled="true"], [hidden]');
    });
  const options = visible.map(option => norm(option.getAttribute('aria-label') || option.textContent || ''));
  // Measure the owned list's viewport, not the union of all offscreen rows.
  let panel: Element | null = visible[0]?.parentElement ?? null;
  while (panel && !visible.every(option => panel!.contains(option))) panel = panel.parentElement;
  const ownedPanels = owners.filter(owner => owner !== element && !owner.contains(element) &&
    visible.length > 0 && visible.every(option => owner.contains(option)));
  if (ownedPanels.length === 1) panel = ownedPanels[0];
  // Some ARIA owners are content inside an independently clipped scroll viewport.
  for (let parent = panel?.parentElement; parent && !parent.contains(element); parent = parent.parentElement) {
    const style = element.ownerDocument.defaultView!.getComputedStyle(parent);
    if (/(auto|scroll|hidden)/.test(style.overflowY) && parent.clientHeight > 0 && parent.scrollHeight > parent.clientHeight) {
      panel = parent;
      break;
    }
    if (['absolute', 'fixed'].includes(style.position)) break;
  }
  const rect = panel && panel !== element && !panel.contains(element) ? panel.getBoundingClientRect() : null;
  const bounds = rect && rect.width > 0 && rect.height > 0 ? {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
  } : undefined;
  return {
    valid: true,
    reason: '',
    open: visible.length > 0,
    options: options.slice(0, 60),
    matches: options.filter(text => text === norm(label)).length,
    ...(bounds ? { bounds } : {}),
  };
}

/** 返回唯一精确匹配的归属选项元素，供真实鼠标点击；规则与 ownedOptions 一致。 */
export function pickOwnedOption(element: Element, label: string): Element | null {
  const root = element.getRootNode() as Document | ShadowRoot;
  const ids = `${element.getAttribute('aria-controls') || ''} ${element.getAttribute('aria-owns') || ''}`
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const owners = [
    element,
    ...ids.map(id => root.getElementById(id)).filter((owner): owner is HTMLElement => Boolean(owner)),
  ];
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const matches = Array.from(
    new Set(owners.flatMap(owner => Array.from(owner.querySelectorAll('[role="option"]')))),
  ).filter(
    option =>
      (typeof option.checkVisibility === 'function' ? option.checkVisibility({ visibilityProperty: true }) : true) &&
      !option.closest('[aria-disabled="true"], [hidden]') &&
      norm(option.getAttribute('aria-label') || option.textContent || '') === norm(label),
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 网页未声明选项归属时的退路：只认紧贴该控件弹出的浮层里的文字叶节点——
 * 链上某个有尺寸的绝对/固定定位祖先，上沿贴住控件下沿（或下沿贴住上沿）且左右重叠。
 * 页面上的普通文字和别的字段的弹层都贴不上这个控件。返回可见选项、精确匹配数和选项区域中心。
 * evaluate 会序列化本函数，不能引用外部变量。
 */
export function nearbyOptions(
  element: Element,
  label: string,
): { open: boolean; options: string[]; matches: number; box: { x: number; y: number; height: number } | null; bounds?: PopupBounds } {
  const doc = element.ownerDocument;
  const view = doc.defaultView!;
  const anchor = element.getBoundingClientRect();
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const anchored = (leaf: Element) => {
    for (let node = leaf.parentElement; node && node !== doc.body; node = node.parentElement) {
      if (node.contains(element)) return null;
      const foreignControl = node.closest(
        'label, .el-input, .el-textarea, .el-input__count, .el-form-item__error, .ant-input-affix-wrapper, .ant-form-item-explain',
      );
      if (foreignControl && !foreignControl.contains(element)) continue;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const aligned = box.right > anchor.left - 8 && box.left < anchor.right + 8;
      const below = box.top >= anchor.bottom - 4 && box.top <= anchor.bottom + 24;
      const above = box.bottom <= anchor.top + 4 && box.bottom >= anchor.top - 24;
      if (!aligned || !(below || above)) continue;
      const position = view.getComputedStyle(node).position;
      if (position === 'absolute' || position === 'fixed') return node;
    }
    return null;
  };
  const leaves = Array.from(doc.body.querySelectorAll('*')).filter(leaf => {
    if (leaf.childElementCount || element.contains(leaf) || !norm(leaf.textContent || '')) return false;
    if (leaf.closest('[hidden], [aria-hidden="true"]')) return false;
    if (typeof leaf.checkVisibility === 'function' && !leaf.checkVisibility({ visibilityProperty: true })) return false;
    return anchored(leaf);
  });
  const options = Array.from(new Set(leaves.map(leaf => norm(leaf.textContent || ''))));
  const panels = [...new Set(leaves.map(anchored).filter((panel): panel is HTMLElement => Boolean(panel)))];
  const rect = panels.length === 1 ? panels[0].getBoundingClientRect() : null;
  const bounds = rect && rect.width > 0 && rect.height > 0 ? {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
  } : undefined;
  let box = null;
  if (leaves.length) {
    const rects = leaves.map(leaf => leaf.getBoundingClientRect());
    const top = Math.min(...rects.map(rect => rect.top));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    const left = Math.min(...rects.map(rect => rect.left));
    const right = Math.max(...rects.map(rect => rect.right));
    box = { x: (left + right) / 2, y: (top + bottom) / 2, height: bottom - top };
  }
  if (bounds) box = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2, height: bounds.height };
  return {
    open: leaves.length > 0,
    options: options.slice(0, 60),
    matches: leaves.filter(leaf => norm(leaf.textContent || '') === norm(label)).length,
    box,
    ...(bounds ? { bounds } : {}),
  };
}

/** 与 nearbyOptions 同一规则，返回唯一精确匹配的选项节点供真实鼠标点击。 */
export function pickNearbyOption(element: Element, label: string): Element | null {
  const doc = element.ownerDocument;
  const view = doc.defaultView!;
  const anchor = element.getBoundingClientRect();
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const anchored = (leaf: Element) => {
    for (let node = leaf.parentElement; node && node !== doc.body; node = node.parentElement) {
      if (node.contains(element)) return false;
      const foreignControl = node.closest(
        'label, .el-input, .el-textarea, .el-input__count, .el-form-item__error, .ant-input-affix-wrapper, .ant-form-item-explain',
      );
      if (foreignControl && !foreignControl.contains(element)) continue;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const aligned = box.right > anchor.left - 8 && box.left < anchor.right + 8;
      const below = box.top >= anchor.bottom - 4 && box.top <= anchor.bottom + 24;
      const above = box.bottom <= anchor.top + 4 && box.bottom >= anchor.top - 24;
      if (!aligned || !(below || above)) continue;
      const position = view.getComputedStyle(node).position;
      if (position === 'absolute' || position === 'fixed') return true;
    }
    return false;
  };
  const matches = Array.from(doc.body.querySelectorAll('*')).filter(leaf => {
    if (leaf.childElementCount || element.contains(leaf) || norm(leaf.textContent || '') !== norm(label)) return false;
    if (leaf.closest('[hidden], [aria-hidden="true"]')) return false;
    if (typeof leaf.checkVisibility === 'function' && !leaf.checkVisibility({ visibilityProperty: true })) return false;
    return anchored(leaf);
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 批量填写途中的轻量结构指纹：可见可交互元素的标签名、结构属性和关联 <label> 文字，不含输入值。
 * 只在页面里查一遍元素，几毫秒；下拉弹层与提示浮层不计入，避免选完后弹层收起期间误判。
 */
export function formFingerprint(body: Element, adapters: RecruitingAdapter[] = []): string {
  const roots = adapters
    .map(adapter => adapter.root)
    .filter(Boolean)
    .join(', ');
  const popups = adapters
    .map(adapter => adapter.popup)
    .filter(Boolean)
    .join(', ');
  const keys = [
    'id',
    'name',
    'type',
    'role',
    'aria-label',
    'aria-labelledby',
    'aria-controls',
    'aria-owns',
    'aria-required',
    'aria-multiselectable',
    'placeholder',
    'title',
    'disabled',
    'readonly',
    'required',
    'aria-disabled',
    'aria-readonly',
    'contenteditable',
    'min',
    'max',
    'minlength',
    'maxlength',
    'step',
    'pattern',
  ];
  const text = (node: Element | null | undefined) =>
    (node?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const nodes = Array.from(
    body.querySelectorAll(
      'input, select, textarea, button, a[href], [role], [contenteditable], [tabindex]' + (roots ? `, ${roots}` : ''),
    ),
  ).filter(
    node =>
      !node.closest('[role="listbox"], [role="option"], [role="tooltip"]' + (popups ? `, ${popups}` : '')) &&
      (!roots || !node.parentElement?.closest(roots)) &&
      (typeof node.checkVisibility !== 'function' || node.checkVisibility({ visibilityProperty: true })),
  );
  return JSON.stringify(
    nodes.map(node => {
      const component = Boolean(roots && node.matches(roots));
      const control = node.matches('input, select, textarea');
      const labels = control
        ? Array.from((node as HTMLInputElement).labels ?? [])
            .map(text)
            .join('|')
        : component
          ? ''
          : text(node);
      return [node.tagName, ...keys.map(key => node.getAttribute(key)), labels || text(node.closest('label'))];
    }),
  );
}

/**
 * 按显示文字找可点击的元素（页面没把它做成按钮、只靠脚本响应点击时）：取文字完全一致的最内层元素，
 * 给了 after 时取 after 文字之后的第一个。打上标记供真实鼠标点击；会离开页面或提交的不选。
 */
export function markTextTarget(root: Element, args: { text: string; after: string | null; mark: string }): boolean {
  const norm = (value: string) => value.replace(/\s+/g, '');
  const all = Array.from(root.querySelectorAll('*')).filter(
    el => typeof (el as HTMLElement).checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }),
  );
  const lookup = (reference: string, leaf: boolean) => {
    const matching = (expected: string) => all.filter(
      el =>
        norm(el.textContent ?? '') === expected &&
        (!leaf || !Array.from(el.children).some(child => norm(child.textContent ?? '') === expected)),
    );
    const exact = matching(norm(reference));
    // The form outline prefixes standalone text with a bullet for display.
    // Try the literal label first in case the website itself includes it.
    const label = reference.trim().replace(/^·\s+/u, '');
    return exact.length || label === reference.trim() ? exact : matching(norm(label));
  };
  const matches = lookup(args.text, true);
  const anchor = args.after ? lookup(args.after, false)[0] : null;
  const target = anchor
    ? matches.find(el => anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    : matches.length === 1
      ? matches[0]
      : null;
  if (
    !target ||
    target.closest('button[type="submit"], input[type="submit"], a[href]:not([href^="#"]):not([href^="javascript"])')
  )
    return false;
  target.setAttribute('data-qz-click', args.mark);
  return true;
}
