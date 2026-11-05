import type { RecruitingAdapter } from './recruitingAdapters';

export type FormControlKind = 'text' | 'contenteditable' | 'select' | 'toggle' | 'custom' | 'unsupported';

export interface FormControlState {
  requirements?: { inputType: string; pattern: string; min: string; max: string; dateFormats: string[] };
  kind: FormControlKind;
  identity: Record<string, string>;
  value: string;
  connected: boolean;
  disabled: boolean;
  readOnly: boolean;
  required?: boolean;
  multiple?: boolean;
  selectedValues?: string[];
  valid: boolean;
  validationMessage: string;
  valueKnown?: boolean;
  /** Editable dropdown text can be a query rather than a committed selection. */
  selectionConfirmed?: boolean;
  /** 字段所在表单项的可见文字（标签、格式提示、错误文案），只作事实交给模型判断。 */
  context?: string;
  /** 控件框带下拉/弹层标记（combobox、role=button、aria-haspopup）：值要从列表里选。 */
  popup?: boolean;
  /** Wait for component validation/state updates before the second verification read. */
  settleMs?: number;
}

export interface SelectChoice {
  found: boolean;
  code?: string;
  message?: string;
  value?: string;
}

/** Check native HTML constraints on an off-document clone without altering the form. */
export function validateFormText(element: Element, value: string): { valid: boolean; message: string } {
  const tag = element.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return { valid: true, message: '' };
  const clone = element.cloneNode(false) as HTMLInputElement;
  clone.disabled = false;
  clone.readOnly = false;
  clone.value = value;
  const lengthValid =
    (clone.maxLength < 0 || value.length <= clone.maxLength) &&
    (clone.minLength < 0 || value.length === 0 || value.length >= clone.minLength);
  const valid = clone.value === value && lengthValid && clone.validity.valid;
  return { valid, message: valid ? '' : clone.validationMessage || '拟填写值不符合网页控件的格式或长度约束，未写入。' };
}

/** Remember only an option click whose value and natural popup closure were verified by the caller. */
export function rememberFormSelection(element: Element, selected: string | null): void {
  if (element.tagName !== 'INPUT') {
    const inputs = Array.from(element.querySelectorAll<HTMLInputElement>('input'))
      .filter(input => ['text', 'search'].includes(input.type));
    if (inputs.length !== 1) return;
    element = inputs[0];
  }
  if (element.tagName !== 'INPUT') return;
  const holder = element.ownerDocument.defaultView as Window & {
    __qzSelections?: WeakMap<Element, { value: string | null }>;
    __qzDropdownInputs?: WeakSet<Element>;
  };
  (holder.__qzDropdownInputs ??= new WeakSet()).add(element);
  if (selected === null || (element as HTMLInputElement).value !== selected) return;
  const selections = holder.__qzSelections ??= new WeakMap();
  if (!selections.has(element)) {
    const entry = { value: selected as string | null };
    selections.set(element, entry);
    const clear = () => { entry.value = null; };
    element.addEventListener('input', clear);
    element.addEventListener('change', () => {
      if ((element as HTMLInputElement).value !== entry.value) clear();
    });
  }
  selections.get(element)!.value = selected;
}

/** Self-contained DOM functions: Puppeteer evaluates these in the control's frame. */
/** display 为 true 时强制读控件框里显示的值（从列表选择后的回读）。 */
export function readFormControl(element: Element, display = false, adapters: RecruitingAdapter[] = []): FormControlState {
  const adapter = adapters.find(rule => rule.root && element.matches(rule.root)) ??
    adapters.find(rule => element.closest(rule.item));
  const component = Boolean(adapter?.root && element.matches(adapter.root));
  const visible = (node: Element) => {
    if (node.closest('[hidden], [aria-hidden="true"]')) return false;
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = element.ownerDocument.defaultView!.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return typeof node.checkVisibility !== 'function' || node.checkVisibility({ visibilityProperty: true });
  };
  const tag = element.tagName.toLowerCase();
  const input = element as HTMLInputElement;
  const type = tag === 'input' ? input.type.toLowerCase() : '';
  const role = element.getAttribute('role') || '';
  const editable =
    (element as HTMLElement).isContentEditable ||
    ['', 'true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? 'false');
  let kind: FormControlKind = 'unsupported';
  if (component) kind = 'custom';
  else if (
    tag === 'textarea' ||
    (tag === 'input' &&
      ['text', 'search', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'time', 'week'].includes(
        type,
      ))
  )
    kind = 'text';
  else if (tag === 'input' && ['checkbox', 'radio'].includes(type)) kind = 'toggle';
  else if (tag === 'select' && !(element as HTMLSelectElement).multiple) kind = 'select';
  else if (editable) kind = 'contenteditable';
  else if (['combobox', 'listbox', 'radiogroup', 'checkbox', 'radio', 'switch', 'textbox', 'spinbutton', 'slider'].includes(role))
    kind = 'custom';
  let value =
    kind === 'unsupported'
      ? ''
      : kind === 'toggle'
        ? String(input.checked)
        : kind === 'contenteditable'
          ? (element.textContent ?? '')
          : input.value;
  let valueKnown = true;
  let selectionConfirmed: boolean | undefined;
  const multiple = element.getAttribute('aria-multiselectable') === 'true' || element.hasAttribute('multiple') ||
    Boolean(component && adapter?.multiple && (element.matches(adapter.multiple) || element.querySelector(adapter.multiple)));
  let selectedValues: string[] | undefined;
  // 控件框：输入框外面高度和它差不多、不含别的控件和别的 <label> 的几层祖先。
  const own = element.getBoundingClientRect();
  const height = Math.max(own.height, 24);
  const box: Element[] = [];
  for (let container = element.parentElement, depth = 0; container && depth < 5; depth++, container = container.parentElement) {
    if (container.getBoundingClientRect().height > height * 1.8 + 4) break;
    if (Array.from(container.querySelectorAll('input, select, textarea, [role="combobox"]')).some(other => other !== element)) break;
    if (Array.from(container.querySelectorAll('label')).some(label => !label.contains(element))) break;
    box.push(container);
  }
  const holder = element.ownerDocument.defaultView as Window & {
    __qzSelections?: WeakMap<Element, { value: string | null }>;
    __qzDropdownInputs?: WeakSet<Element>;
  };
  const popup =
    component || role === 'combobox' ||
    Boolean(holder.__qzDropdownInputs?.has(element)) ||
    [element, ...box].some(node => ['button', 'combobox'].includes(node.getAttribute('role') ?? '') || node.hasAttribute('aria-haspopup'));
  // 自定义下拉常把选中项显示在输入框旁边，输入框本身为空：读控件框里显示的文字，去掉占位/提示、隐藏和弹层内容。
  if (tag === 'input' && (popup || display)) {
    const selected = element.getAttribute('aria-valuetext');
    selectionConfirmed = Boolean(input.readOnly && input.value.trim()) || selected !== null ||
      (holder.__qzSelections?.get(element)?.value === input.value && element.getAttribute('aria-expanded') !== 'true');
    if (selected !== null) value = selected;
    // 只取和输入框同一行的可见文字：标签和说明在上下方，几何上排除；占位/提示、隐藏和弹层内容按标记排除。
    const doc = element.ownerDocument;
    const skip = '[class*="placeholder"], [class*="hint"], [aria-hidden="true"], [role="listbox"], [role="option"], input, textarea, label';
    const sameRow = (node: Node) => {
      const range = doc.createRange();
      range.selectNodeContents(node);
      if (typeof range.getBoundingClientRect !== 'function') return true;
      const rect = range.getBoundingClientRect();
      const middle = (rect.top + rect.bottom) / 2;
      return (!rect.width && !rect.height) || (middle >= own.top - 2 && middle <= own.bottom + 2);
    };
    for (const container of selectionConfirmed ? [] : box) {
      const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest(skip) || !node.textContent?.trim()) continue;
        if (typeof parent.checkVisibility === 'function' && !parent.checkVisibility({ visibilityProperty: true })) continue;
        if (sameRow(node)) parts.push(node.textContent);
      }
      // 必填星号不是值。
      const shown = parts.join(' ').replace(/\s+/g, ' ').replace(/(^|\s)\*+(?=\s|$)/g, ' ').trim();
      if (shown) {
        value = shown;
        selectionConfirmed = true;
        break;
      }
    }
  }
  if (component && adapter) {
    // The search input is not the selected value. Read visible text outside inputs,
    // placeholder/clear/arrow controls and the popup; do not mutate React internals.
    const skip = ['input', 'textarea', 'button', 'svg', '[role="listbox"]', '[role="option"]',
      adapter.popup, adapter.omit].filter(Boolean).join(', ');
    const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && !parent.closest(skip) && visible(parent) && node.textContent?.trim()) parts.push(node.textContent.trim());
    }
    value = element.getAttribute('aria-valuetext') ?? parts.join(' ').replace(/\s+/g, ' ').trim();
    // Some components keep both the query and the committed value in one input.
    // Retain its text, but only a verified option click can confirm an editable input.
    if (!value) {
      const displays = Array.from(element.querySelectorAll<HTMLInputElement>('input'))
        .filter(input => ['text', 'search'].includes(input.type) && visible(input));
      if (displays.length === 1) {
        const displayInput = displays[0];
        const selected = displayInput.getAttribute('aria-valuetext');
        value = selected ?? displayInput.value;
        selectionConfirmed = Boolean(displayInput.readOnly && value.trim()) || selected !== null ||
          (holder.__qzSelections?.get(displayInput)?.value === value &&
            displayInput.getAttribute('aria-expanded') !== 'true' && element.getAttribute('aria-expanded') !== 'true');
      }
    } else {
      selectionConfirmed = true;
    }
    if (multiple && adapter.selectedItems) {
      selectedValues = Array.from(element.querySelectorAll(adapter.selectedItems)).filter(visible)
        .map(item => item.textContent?.trim() ?? '').filter(Boolean);
      // A multi-select's search input never represents a selected option.
      value = selectedValues.join('、');
      selectionConfirmed = true;
    }
  } else if (kind === 'custom') {
    const ariaValue = element.getAttribute('aria-valuetext') ?? element.getAttribute('aria-valuenow');
    if (['checkbox', 'radio', 'switch'].includes(role)) {
      value = element.getAttribute('aria-checked') ?? '';
      valueKnown = ['true', 'false', 'mixed'].includes(value);
    } else if (role === 'listbox' || role === 'radiogroup') {
      const selected = Array.from(element.querySelectorAll(role === 'listbox' ? '[role="option"][aria-selected="true"]' : '[role="radio"][aria-checked="true"]'));
      value = selected.map(option => option.getAttribute('aria-label') || option.textContent?.trim() || '').join('\n');
      valueKnown = selected.every(option => Boolean(option.getAttribute('aria-label') || option.textContent?.trim()));
    } else if (ariaValue !== null) value = ariaValue;
    else if (role === 'combobox' || role === 'textbox') {
      // Exclude the popup and its choices; they are not the selected field value.
      const clone = element.cloneNode(true) as Element;
      clone.querySelectorAll('[role="listbox"], [role="option"], [aria-hidden="true"]').forEach(child => child.remove());
      value = clone.textContent?.trim() || '';
      if (value === element.getAttribute('aria-placeholder')) value = '';
    } else { value = ''; valueKnown = false; }
  }
  // 字段所在表单项：往上直到再上一层就会包含 3 个以上表单控件为止，框住标签、控件和提示文字。
  const formSelector = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="listbox"], [role="textbox"], [contenteditable="true"]';
  let item: Element = element;
  for (let depth = 0; depth < 10; depth++) {
    const parent = item.parentElement;
    if (!parent || parent === element.ownerDocument.body || parent.querySelectorAll(formSelector).length > 3) break;
    item = parent;
  }
  const scopedItem = adapter ? element.closest(adapter.item) : null;
  if (scopedItem) item = scopedItem;
  const context = (((item as HTMLElement).innerText ?? item.textContent ?? '') as string).replace(/\s+/g, ' ').trim().slice(0, 300);
  const errorId = element.getAttribute('aria-errormessage');
  const errorText = errorId ? (element.ownerDocument.getElementById(errorId)?.textContent ?? '').trim() : '';
  // Only errors in this exact form item count, never a sibling field's error.
  const componentErrors = adapter && scopedItem
    ? Array.from(scopedItem.querySelectorAll(adapter.error))
      .filter(node => node.closest(adapter.item) === scopedItem && visible(node))
      .map(node => node.textContent?.trim() ?? '').filter(Boolean).join(' ')
    : '';
  const componentInvalid = Boolean(adapter && (
    element.matches(adapter.invalid) || scopedItem?.matches(adapter.invalid) ||
    (scopedItem && Array.from(scopedItem.querySelectorAll(adapter.invalid)).some(node =>
      (node === element || node.contains(element)) && visible(node)))
  ));
  const identity = Object.fromEntries(
    ['id', 'name', 'type', 'role', 'aria-label', 'placeholder', 'contenteditable'].map(key => [
      key,
      element.getAttribute(key) ?? '',
    ]),
  );
  identity.tagName = tag;
  const disabled = Boolean(input.disabled || element.matches(':disabled') || element.closest('[aria-disabled="true"]') ||
    (adapter?.disabled && element.matches(adapter.disabled)));
  // 只读的 combobox 输入框只是不能打字，选项仍可选择，不算只读字段。
  const readOnly = Boolean((input.readOnly && !(tag === 'input' && role === 'combobox')) || element.closest('[aria-readonly="true"]'));
  const maxLength = typeof input.maxLength === 'number' ? input.maxLength : -1;
  const minLength = typeof input.minLength === 'number' ? input.minLength : -1;
  const lengthValid =
    kind !== 'text' ||
    ((maxLength < 0 || value.length <= maxLength) &&
      (minLength < 0 || value.length === 0 || value.length >= minLength));
  // Read markers belonging to this field, never stars from nearby values or another form item.
  const labels = Array.from(input.labels ?? []);
  if (scopedItem) labels.push(...Array.from(scopedItem.querySelectorAll<HTMLLabelElement>('label'))
    .filter(label => label.closest(adapter!.item) === scopedItem && !label.querySelector('input, select, textarea')));
  // Unassociated labels and a separate star are common. Stay within the preceding
  // label run; never borrow a star from a previous field or a value inside this control.
  const controls = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="textbox"], [contenteditable="true"]';
  const visibleText = (node: Node): string => node.nodeType === 3 ? node.textContent ?? ''
    : node.nodeType === 1 && visible(node as Element) ? Array.from(node.childNodes).map(visibleText).join('') : '';
  let precedingRequired = false;
  for (let current: Element | null = element, depth = 0; current?.parentElement && depth < 5; current = current.parentElement, depth++) {
    let star = false;
    let foundLabel = false;
    let crossedControl = false;
    for (let sibling = current.previousElementSibling; sibling; sibling = sibling?.previousElementSibling ?? null) {
      if (!visible(sibling)) continue;
      if (sibling.matches(controls) || sibling.querySelector(controls)) { crossedControl = true; break; }
      const text = visibleText(sibling).trim();
      if (!text) continue;
      if (/^[*＊\s]+$/.test(text)) { star = true; continue; }
      foundLabel = true;
      precedingRequired = star || /[*＊]\s*$/.test(text);
      break;
    }
    if (foundLabel || crossedControl || current.parentElement.matches('form, body')) break;
  }
  const labelRequired = precedingRequired || labels.some(label => /[*＊]/.test(visibleText(label)));
  const markedRequired = Boolean(adapter?.required && scopedItem && (
    scopedItem.matches(adapter.required) || Array.from(scopedItem.querySelectorAll(adapter.required))
      .some(marker => marker.closest(adapter.item) === scopedItem && visible(marker))
  ));
  const required = element.getAttribute('aria-required') === 'true' || Boolean(input.required) ||
    scopedItem?.getAttribute('aria-required') === 'true' || labelRequired || markedRequired ||
    Boolean(component && element.querySelector('input[required], [aria-required="true"]'));
  const customMissing = kind === 'custom' && required &&
    (['checkbox', 'radio', 'switch'].includes(role) ? value !== 'true' : !value.trim());
  const ariaInvalid = element.closest('[aria-invalid]:not([aria-invalid="false"])') !== null ||
    Boolean(component && element.querySelector('[aria-invalid]:not([aria-invalid="false"])'));
  const requirements = { inputType: input.type ?? '', pattern: input.pattern ?? '', min: input.min ?? '', max: input.max ?? '', dateFormats: [] as string[] };
  if (input.type === 'date') requirements.dateFormats = ['YYYY-MM-DD'];
  if (input.type === 'month') requirements.dateFormats = ['YYYY-MM'];
  // Read the owning Ant picker, even when its popup is closed. Its mode is a view,
  // not the accepted precision. Never infer a format from a label or a selected day.
  const picker = element.closest('.ant-calendar-picker');
  if (picker) {
    type Owner = { return?: Owner; stateNode?: { input?: unknown; props?: { format?: unknown } } };
    const key = Object.keys(element).find(key => key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$'));
    const host = key ? (element as unknown as Record<string, Owner>)[key] : undefined;
    for (let owner = host?.return, depth = 0; owner && depth < 12; owner = owner?.return, depth++) {
      if (owner.stateNode?.input !== element) continue;
      const format = owner.stateNode.props?.format;
      if (typeof format === 'string') requirements.dateFormats = [format];
      else if (Array.isArray(format) && format.every(value => typeof value === 'string')) requirements.dateFormats = format;
      break;
    }
  }
  return {
    requirements,
    kind,
    identity,
    value,
    connected: element.isConnected,
    disabled,
    readOnly,
    required,
    multiple,
    selectedValues,
    valueKnown,
    selectionConfirmed,
    valid: selectionConfirmed !== false && valueKnown && !customMissing && lengthValid && input.validity?.valid !== false && !ariaInvalid && !componentInvalid && !componentErrors &&
      !(kind === 'unsupported' && required && !input.validity),
    validationMessage:
      input.validationMessage ||
      componentErrors || (componentInvalid ? '网页将此表单项标记为无效，见字段附近文字。' : '') ||
      (selectionConfirmed === false ? '输入框内容尚未确认为已选项，请从候选列表选择。' : '') ||
      (ariaInvalid
        ? errorText || '网页将此控件标记为无效，见字段附近文字。'
        : !valueKnown || (kind === 'unsupported' && required && !input.validity)
          ? '无法可靠读取此控件的实际值。'
        : customMissing
          ? '此自定义必填控件尚未填写。'
        : lengthValid
          ? ''
          : '填写内容长度不符合网页控件约束。'),
    context,
    popup,
    settleMs: adapter?.settleMs,
  };
}

/**
 * 模型常点到自定义控件的外框、显示层或箭头：自身不是表单控件时，取它内部唯一的控件，
 * 或往上几层唯一包住的控件；遇到包含多个控件的层就停，找不到唯一的返回 null。
 */
export function soleFormControl(element: Element, adapters: RecruitingAdapter[] = []): Element | null {
  for (const adapter of adapters) {
    const root = adapter.root ? element.closest(adapter.root) : null;
    if (root) return root === element ? null : root;
  }
  const roots = adapters.map(adapter => adapter.root).filter(Boolean).join(', ');
  const nestedRoots = roots ? element.querySelectorAll(roots) : [];
  if (nestedRoots.length === 1 && !Array.from(element.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]')).some(control => !nestedRoots[0].contains(control))) return nestedRoots[0];
  if (nestedRoots.length > 1) return null;
  const selector =
    'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [contenteditable=""], ' +
    '[role="combobox"], [role="listbox"], [role="textbox"], [role="radiogroup"], [role="checkbox"], [role="radio"], [role="switch"]';
  if (element.matches(selector)) return null;
  let scope: Element | null = element;
  for (let depth = 0; scope && scope !== element.ownerDocument.body && depth < 4; depth++, scope = scope.parentElement) {
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
): { valid: boolean; reason: string; open: boolean; options: string[]; matches: number } {
  const role = element.getAttribute('role');
  // Option discovery is shared by single- and multi-select tools; selection mode is checked by their callers.
  if (!['combobox', 'listbox'].includes(role || ''))
    return { valid: false, reason: '此控件不是 combobox/listbox；请观察它自身的交互方式。', open: false, options: [], matches: 0 };
  const root = element.getRootNode() as Document | ShadowRoot;
  const ids = `${element.getAttribute('aria-controls') || ''} ${element.getAttribute('aria-owns') || ''}`.trim().split(/\s+/).filter(Boolean);
  const owners = [element, ...ids.map(id => root.getElementById(id)).filter((owner): owner is HTMLElement => Boolean(owner))];
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const seen = new Set<Element>();
  const visible = owners
    .flatMap(owner => Array.from(owner.querySelectorAll('[role="option"]')))
    .filter(option => {
      if (seen.has(option)) return false;
      seen.add(option);
      const shown = typeof option.checkVisibility === 'function' ? option.checkVisibility({ visibilityProperty: true }) : true;
      return shown && !option.closest('[aria-disabled="true"], [hidden]');
    });
  const options = visible.map(option => norm(option.getAttribute('aria-label') || option.textContent || ''));
  return { valid: true, reason: '', open: visible.length > 0, options: options.slice(0, 60), matches: options.filter(text => text === norm(label)).length };
}

/** 返回唯一精确匹配的归属选项元素，供真实鼠标点击；规则与 ownedOptions 一致。 */
export function pickOwnedOption(element: Element, label: string): Element | null {
  const root = element.getRootNode() as Document | ShadowRoot;
  const ids = `${element.getAttribute('aria-controls') || ''} ${element.getAttribute('aria-owns') || ''}`.trim().split(/\s+/).filter(Boolean);
  const owners = [element, ...ids.map(id => root.getElementById(id)).filter((owner): owner is HTMLElement => Boolean(owner))];
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const matches = Array.from(new Set(owners.flatMap(owner => Array.from(owner.querySelectorAll('[role="option"]'))))).filter(
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
): { open: boolean; options: string[]; matches: number; box: { x: number; y: number; height: number } | null } {
  const doc = element.ownerDocument;
  const view = doc.defaultView!;
  const anchor = element.getBoundingClientRect();
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const anchored = (leaf: Element) => {
    for (let node = leaf.parentElement; node && node !== doc.body; node = node.parentElement) {
      const position = view.getComputedStyle(node).position;
      if (position !== 'absolute' && position !== 'fixed') continue;
      if (node.contains(element)) return false;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const aligned = box.right > anchor.left - 8 && box.left < anchor.right + 8;
      const below = box.top >= anchor.bottom - 4 && box.top <= anchor.bottom + 24;
      const above = box.bottom <= anchor.top + 4 && box.bottom >= anchor.top - 24;
      if (aligned && (below || above)) return true;
    }
    return false;
  };
  const leaves = Array.from(doc.body.querySelectorAll('*')).filter(leaf => {
    if (leaf.childElementCount || element.contains(leaf) || !norm(leaf.textContent || '')) return false;
    if (typeof leaf.checkVisibility === 'function' && !leaf.checkVisibility({ visibilityProperty: true })) return false;
    return anchored(leaf);
  });
  const options = Array.from(new Set(leaves.map(leaf => norm(leaf.textContent || ''))));
  let box = null;
  if (leaves.length) {
    const rects = leaves.map(leaf => leaf.getBoundingClientRect());
    const top = Math.min(...rects.map(rect => rect.top));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    const left = Math.min(...rects.map(rect => rect.left));
    const right = Math.max(...rects.map(rect => rect.right));
    box = { x: (left + right) / 2, y: (top + bottom) / 2, height: bottom - top };
  }
  return { open: leaves.length > 0, options: options.slice(0, 60), matches: leaves.filter(leaf => norm(leaf.textContent || '') === norm(label)).length, box };
}

/** 与 nearbyOptions 同一规则，返回唯一精确匹配的选项节点供真实鼠标点击。 */
export function pickNearbyOption(element: Element, label: string): Element | null {
  const doc = element.ownerDocument;
  const view = doc.defaultView!;
  const anchor = element.getBoundingClientRect();
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const anchored = (leaf: Element) => {
    for (let node = leaf.parentElement; node && node !== doc.body; node = node.parentElement) {
      const position = view.getComputedStyle(node).position;
      if (position !== 'absolute' && position !== 'fixed') continue;
      if (node.contains(element)) return false;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const aligned = box.right > anchor.left - 8 && box.left < anchor.right + 8;
      const below = box.top >= anchor.bottom - 4 && box.top <= anchor.bottom + 24;
      const above = box.bottom <= anchor.top + 4 && box.bottom >= anchor.top - 24;
      if (aligned && (below || above)) return true;
    }
    return false;
  };
  const matches = Array.from(doc.body.querySelectorAll('*')).filter(leaf => {
    if (leaf.childElementCount || element.contains(leaf) || norm(leaf.textContent || '') !== norm(label)) return false;
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
  const roots = adapters.map(adapter => adapter.root).filter(Boolean).join(', ');
  const popups = adapters.map(adapter => adapter.popup).filter(Boolean).join(', ');
  const keys = ['id', 'name', 'type', 'role', 'aria-label', 'aria-labelledby', 'aria-controls', 'aria-owns', 'aria-required',
    'aria-multiselectable', 'placeholder', 'title', 'disabled', 'readonly', 'required', 'aria-disabled', 'aria-readonly',
    'contenteditable', 'min', 'max', 'minlength', 'maxlength', 'step', 'pattern'];
  const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const nodes = Array.from(body.querySelectorAll('input, select, textarea, button, a[href], [role], [contenteditable], [tabindex]' + (roots ? `, ${roots}` : ''))).filter(
    node =>
      !node.closest('[role="listbox"], [role="option"], [role="tooltip"]' + (popups ? `, ${popups}` : '')) &&
      (!roots || !node.parentElement?.closest(roots)) &&
      (typeof node.checkVisibility !== 'function' || node.checkVisibility({ visibilityProperty: true })),
  );
  return JSON.stringify(
    nodes.map(node => {
      const component = Boolean(roots && node.matches(roots));
      const control = node.matches('input, select, textarea');
      const labels = control ? Array.from((node as HTMLInputElement).labels ?? []).map(text).join('|') : component ? '' : text(node);
      return [node.tagName, ...keys.map(key => node.getAttribute(key)), labels || text(node.closest('label'))];
    }),
  );
}

/** Block native form submission only while an automated click is executing. */
export function applicationSubmitGuard(element: Element, command: 'start' | 'stop' | 'status'): boolean {
  const doc = element.ownerDocument as Document & {
    __jobAgentSubmitGuard?: {
      blocked: boolean;
      listener: EventListener;
      original: typeof HTMLFormElement.prototype.submit;
      replacement: typeof HTMLFormElement.prototype.submit;
    };
  };
  const view = doc.defaultView;
  if (!view) return false;
  if (command === 'start' && !doc.__jobAgentSubmitGuard) {
    const guard = {
      blocked: false,
      listener: null as unknown as EventListener,
      original: view.HTMLFormElement.prototype.submit,
      replacement: null as unknown as typeof HTMLFormElement.prototype.submit,
    };
    guard.listener = event => {
      guard.blocked = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    guard.replacement = function () {
      guard.blocked = true;
    };
    doc.__jobAgentSubmitGuard = guard;
    doc.addEventListener('submit', guard.listener, true);
    view.HTMLFormElement.prototype.submit = guard.replacement;
  }
  const guard = doc.__jobAgentSubmitGuard;
  if (command === 'stop' && guard) {
    doc.removeEventListener('submit', guard.listener, true);
    if (view.HTMLFormElement.prototype.submit === guard.replacement)
      view.HTMLFormElement.prototype.submit = guard.original;
    delete doc.__jobAgentSubmitGuard;
  }
  return guard?.blocked ?? false;
}

/** Native prototype setters bypass framework value trackers; events notify the app. */
export function writeFormText(element: Element, value: string): void {
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error('控件所属页面已关闭。');
  const tag = element.tagName.toLowerCase();
  const control = element as HTMLInputElement;
  if (
    !element.isConnected ||
    control.disabled ||
    control.readOnly ||
    element.matches(':disabled') ||
    element.closest('[aria-disabled="true"], [aria-readonly="true"]')
  )
    throw new Error('控件已移除、禁用或只读。');
  (element as HTMLElement).focus({ preventScroll: true });
  if (tag === 'input' || tag === 'textarea') {
    const prototype = tag === 'input' ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('网页控件没有可用的原生赋值方法。');
    setter.call(element, value);
  } else if (
    (element as HTMLElement).isContentEditable ||
    ['', 'true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? 'false')
  ) {
    element.textContent = value;
  } else throw new Error('当前控件不能使用文本输入，请观察其真实交互方式。');
  element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
}

export function commitFormControl(element: Element, notify = true): void {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected) return;
  if (notify) element.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
  (element as HTMLElement).blur();
}

export function resolveSelectChoice(element: Element, label: string): SelectChoice {
  if (element.tagName.toLowerCase() !== 'select' || (element as HTMLSelectElement).multiple)
    return { found: false, code: 'UNSUPPORTED_CONTROL', message: '此工具仅适用于原生单选下拉框。' };
  const options = Array.from((element as HTMLSelectElement).options).filter(
    option => option.text.trim() === label.trim(),
  );
  if (options.length !== 1)
    return {
      found: false,
      code: options.length ? 'AMBIGUOUS_OPTION' : 'OPTION_NOT_FOUND',
      message: options.length
        ? '存在多个同名选项，不能确定目标。请重新观察或询问用户。'
        : '网页中没有这个选项，请根据实际选项重新规划。',
    };
  const option = options[0];
  if (
    option.disabled ||
    (option.parentElement?.tagName.toLowerCase() === 'optgroup' &&
      (option.parentElement as HTMLOptGroupElement).disabled)
  )
    return { found: false, code: 'DISABLED_OPTION', message: '目标选项已禁用。' };
  return { found: true, value: option.value };
}

export function writeFormSelect(element: Element, value: string): void {
  const view = element.ownerDocument.defaultView;
  const select = element as HTMLSelectElement;
  if (
    !view ||
    !select.isConnected ||
    select.disabled ||
    select.matches(':disabled') ||
    select.multiple ||
    select.closest('[aria-disabled="true"], [aria-readonly="true"]')
  )
    throw new Error('下拉框已移除、禁用或不支持此操作。');
  select.focus({ preventScroll: true });
  const setter = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) throw new Error('下拉框没有可用的原生赋值方法。');
  setter.call(select, value);
  select.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
}

export interface DatePanelState {
  open: boolean;
  view: 'day' | 'month' | 'year' | 'unknown';
  year: number | null;
  month: number | null;
  cells: { value: number; x: number; y: number; disabled: boolean }[];
  /** 表头左侧箭头（从外到内）与右侧箭头（从内到外），按横坐标排列。 */
  prev: { x: number; y: number }[];
  next: { x: number; y: number }[];
  header: { x: number; y: number } | null;
  monthHeader?: { x: number; y: number } | null;
  input?: { x: number; y: number; value: string; invalid: boolean; active: boolean; formats: string[] } | null;
  focused?: boolean;
}

/**
 * 紧贴字段弹出的日期面板。嵌套日历优先使用当前子面板，避免把被覆盖的日期网格一起解析。
 * evaluate 会序列化本函数，不能引用外部变量。
 */
export function datePanel(element: Element): DatePanelState {
  const empty: DatePanelState = { open: false, view: 'unknown', year: null, month: null, cells: [], prev: [], next: [], header: null };
  const doc = element.ownerDocument;
  const view = doc.defaultView!;
  const anchor = element.getBoundingClientRect();
  const visible = (el: Element) => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : true);
  const roots = Array.from(doc.body.querySelectorAll('*')).filter(el => {
    const position = view.getComputedStyle(el).position;
    if ((position !== 'absolute' && position !== 'fixed') || el.contains(element) || !visible(el)) return false;
    const box = el.getBoundingClientRect();
    if (box.width < 120 || box.height < 100) return false;
    const aligned = box.right > anchor.left - 40 && box.left < anchor.right + 40;
    const below = box.top >= anchor.bottom - 6 && box.top <= anchor.bottom + 30;
    const above = box.bottom <= anchor.top + 6 && box.bottom >= anchor.top - 30;
    // Ant 3 会覆盖触发输入框；空间不足时向上展开，改为与输入框底部对齐。
    const overlayInput = el.matches('.ant-calendar-picker-container') &&
      (Math.abs(box.top - anchor.top) <= 12 || Math.abs(box.bottom - anchor.bottom) <= 12);
    return aligned && (below || above || overlayInput);
  });
  let root = roots.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
  if (!root) return empty;
  const popup = root;
  const focused = popup.contains(doc.activeElement);
  const edit = popup.matches('.ant-calendar-picker-container')
    ? popup.querySelector<HTMLInputElement>('input.ant-calendar-input:not([readonly]):not([disabled])') : null;
  const editBox = edit?.getBoundingClientRect();
  // 只读当前输入框所属 rc-calendar DateInput 的格式属性，不猜测站点/字段名称，
  // 不修改 React 状态。无法确认组件归属时，保留未知格式。
  let formats: string[] = [];
  if (edit) {
    type Owner = { return?: Owner; memoizedProps?: { onChange?: unknown };
      stateNode?: { onInputChange?: unknown; props?: { format?: unknown } } };
    const key = Object.keys(edit).find(key => key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$'));
    const host = key ? (edit as unknown as Record<string, Owner>)[key] : undefined;
    const handler = host?.memoizedProps?.onChange;
    for (let owner = host?.return, depth = 0; owner && depth < 8; owner = owner.return, depth++) {
      if (handler && owner.stateNode?.onInputChange === handler) {
        const format = owner.stateNode.props?.format;
        if (typeof format === 'string') formats = [format];
        else if (Array.isArray(format) && format.every(value => typeof value === 'string')) formats = format;
        break;
      }
    }
  }
  const input = edit && editBox && visible(edit) && editBox.width > 0 && editBox.height > 0 ? {
    x: editBox.left + editBox.width / 2, y: editBox.top + editBox.height / 2, value: edit.value,
    invalid: edit.classList.contains('ant-calendar-input-invalid') || edit.getAttribute('aria-invalid') === 'true',
    active: doc.activeElement === edit,
    formats,
  } : null;
  // Ant Calendar 的年/月视图叠在日视图上；底层节点仍有尺寸且 checkVisibility 为真。
  // 仅在已经按输入框位置定位的弹层内选子面板，不搜索其他字段的日历。
  for (const selector of ['.ant-calendar-decade-panel', '.ant-calendar-year-panel', '.ant-calendar-month-panel']) {
    const panel = Array.from(root.querySelectorAll(selector)).find(visible);
    if (panel) { root = panel; break; }
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthOf = (text: string) => {
    const zh = text.match(/^(1[0-2]|0?[1-9])\s*月$/);
    if (zh) return Number(zh[1]);
    const chinese = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'].indexOf(text.replace(/\s+/g, ''));
    if (chinese >= 0) return chinese + 1;
    const en = MONTHS.indexOf(text.slice(0, 3).toLowerCase());
    return /^[a-z]{3,9}\.?$/i.test(text) && en >= 0 ? en + 1 : null;
  };
  const items = Array.from(root.querySelectorAll('*'))
    .filter(el => visible(el))
    .map(el => {
      const own = Array.from(el.childNodes)
        .filter(child => child.nodeType === 3)
        .map(child => child.textContent ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const rect = el.getBoundingClientRect();
      const disabled =
        view.getComputedStyle(el).cursor === 'not-allowed' ||
        Boolean(el.closest('[class*="disabled"], [aria-disabled="true"], [disabled]'));
      return { el, own, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, disabled };
    })
    .filter(item => item.width > 0);
  const titled = items.filter(item => /(?:^|\D)(1[89]\d{2}|2\d{3})(?:\D|$)/.test(item.own)).sort((a, b) => a.y - b.y);
  const head = titled[0];
  if (!head) return { ...empty, open: true, input, focused };
  const headerRow = items.filter(item => Math.abs(item.y - head.y) < 12);
  const headYear = Number(head.own.match(/(1[89]\d{2}|2\d{3})/)![1]);
  const headMonthText = headerRow.map(item => item.own).join(' ');
  const headMonthMatch = headMonthText.match(/(?:^|[^\d])(1[0-2]|0?[1-9])\s*月/) ?? null;
  const headMonthEn = headerRow.map(item => monthOf(item.own)).find(value => value !== null) ?? null;
  const below = items.filter(item => item.y > head.y + 12 && item.own);
  const months = below.map(item => ({ item, value: monthOf(item.own) })).filter(entry => entry.value !== null);
  const years = below.map(item => ({ item, value: /^(1[89]\d{2}|2\d{3})\s*年?$/.test(item.own) ? Number(item.own.slice(0, 4)) : null })).filter(entry => entry.value !== null);
  const days = below.map(item => ({ item, value: /^([1-9]|[12]\d|3[01])$/.test(item.own) ? Number(item.own) : null })).filter(entry => entry.value !== null);
  const toCell = (entry: { item: (typeof items)[number]; value: number | null }) => ({ value: entry.value!, x: entry.item.x, y: entry.item.y, disabled: entry.item.disabled });
  let viewKind: DatePanelState['view'] = 'unknown';
  let cells: DatePanelState['cells'] = [];
  if (months.length >= 6) {
    viewKind = 'month';
    cells = months.map(toCell);
  } else if (years.length >= 8) {
    viewKind = 'year';
    cells = years.map(toCell);
  } else if (days.length >= 28) {
    viewKind = 'day';
    // 当月格子：从第一个“1”开始连续递增的一段，前后的上月/下月格子不算。
    const start = days.findIndex(entry => entry.value === 1);
    const run = [];
    for (let i = start; i >= 0 && i < days.length && days[i].value === run.length + 1; i++) run.push(days[i]);
    cells = run.map(toCell);
  }
  // 箭头：表头行里不含数字、宽度不大的元素（图标、‹ › « »）。
  const arrows = headerRow
    .filter(item => !/\d/.test(item.own) && item.width < 48 && item.el.childElementCount <= 1)
    .sort((a, b) => a.x - b.x);
  const dedup = arrows.filter((item, i) => i === 0 || Math.abs(item.x - arrows[i - 1].x) > 6);
  const point = (item: { x: number; y: number }) => ({ x: item.x, y: item.y });
  const monthHeader = headerRow.find(item => monthOf(item.own) !== null && item.el.matches('a, button, [role="button"]'));
  return {
    open: true,
    view: viewKind,
    year: headYear,
    month: headMonthMatch ? Number(headMonthMatch[1]) : headMonthEn,
    cells,
    prev: dedup.filter(item => item.x < head.x - head.width / 2).map(point),
    next: dedup.filter(item => item.x > head.x + head.width / 2).map(point),
    header: point(head),
    monthHeader: monthHeader ? point(monthHeader) : null,
    input,
    focused,
  };
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
  const matches = all.filter(
    el => norm(el.textContent ?? '') === norm(args.text) && !Array.from(el.children).some(child => norm(child.textContent ?? '') === norm(args.text)),
  );
  const anchor = args.after ? all.find(el => norm(el.textContent ?? '') === norm(args.after!)) : null;
  const target = anchor
    ? matches.find(el => anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    : matches.length === 1
      ? matches[0]
      : null;
  if (!target || target.closest('button[type="submit"], input[type="submit"], a[href]:not([href^="#"]):not([href^="javascript"])')) return false;
  target.setAttribute('data-qz-click', args.mark);
  return true;
}
