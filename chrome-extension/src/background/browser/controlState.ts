import { CALENDAR_ADAPTERS, type CalendarAdapters } from './calendarAdapters';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import { RECRUITING_ADAPTERS, type RecruitingAdapter } from './recruitingAdapters';

export type FormControlKind = 'text' | 'contenteditable' | 'select' | 'toggle' | 'custom' | 'unsupported';
export type ChoicePolicy = 'free_text' | 'options_only' | 'custom_option' | 'unknown';

/** A visible string can be a search query or calendar preview rather than a saved value. */
export function hasCommittedControlValue(state: { valid: boolean; selectionConfirmed?: boolean; valueKnown?: boolean }): boolean {
  return state.valid && state.selectionConfirmed !== false && state.valueKnown !== false;
}

export interface FormControlState {
  /** A DOM calendar widget; editability does not imply text is its commit path. */
  datePicker?: boolean;
  dateRange?: { index: number; ids: string[] };
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
  /** Native/component error evidence, excluding the extension's uncertainty diagnostics. */
  pageValidationMessage?: string;
  valueKnown?: boolean;
  /** Editable dropdown text can be a query rather than a committed selection. */
  selectionConfirmed?: boolean;
  /** Whether text is a final value, a query, or a new option requiring confirmation. */
  choicePolicy?: ChoicePolicy;
  /** 字段所在表单项的可见文字（标签、格式提示、错误文案），只作事实交给模型判断。 */
  context?: string;
  /** 控件框带下拉/弹层标记；是否允许自由输入由 choicePolicy 区分。 */
  popup?: boolean;
  /** 控件内含可输入搜索框（或为多级级联入口），顶层可见项未必是完整终选列表。 */
  typable?: boolean;
  /** Wait for component validation/state updates before the second verification read. */
  settleMs?: number;
}

export interface SelectChoice {
  found: boolean;
  code?: string;
  message?: string;
  value?: string;
}

/** Remember only an option click whose value and natural popup closure were verified by the caller. */
export function rememberFormSelection(element: Element, selected: string | null): void {
  if (element.tagName !== 'INPUT') {
    const inputs = Array.from(element.querySelectorAll<HTMLInputElement>('input')).filter(input =>
      ['text', 'search'].includes(input.type),
    );
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
  const selections = (holder.__qzSelections ??= new WeakMap());
  if (!selections.has(element)) {
    const entry = { value: selected as string | null };
    selections.set(element, entry);
    const clear = () => {
      entry.value = null;
    };
    element.addEventListener('input', clear);
    element.addEventListener('change', () => {
      if ((element as HTMLInputElement).value !== entry.value) clear();
    });
  }
  selections.get(element)!.value = selected;
}

export function readLiveControl(element: ElementHandle, display = false): Promise<FormControlState> {
  return element.evaluate(readFormControl, display, RECRUITING_ADAPTERS, CALENDAR_ADAPTERS);
}

/** Self-contained DOM functions: Puppeteer evaluates these in the control's frame. */
/** display 为 true 时强制读控件框里显示的值（从列表选择后的回读）。 */
export function readFormControl(
  element: Element,
  display = false,
  adapters: RecruitingAdapter[] = [],
  calendars: CalendarAdapters = CALENDAR_ADAPTERS,
): FormControlState {
  const adapter =
    adapters.find(rule => rule.root && element.matches(rule.root)) ?? adapters.find(rule => element.closest(rule.item));
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
  const calendar = element.closest(Object.values(calendars).map(rule => rule.root).join(', '));
  const datePicker = element.matches(calendars.lixiang.root) || (
    tag === 'input' &&
    Boolean(calendar) &&
    !calendar!.matches(calendars.element.timeOnly) &&
    !calendar!.querySelector('.anticon-clock-circle, .el-icon-time'));
  const rangeInputs = Array.from(
    element.closest(calendars.ant.range)?.querySelectorAll<HTMLInputElement>('input') ?? [],
  );
  const rangeIds = rangeInputs.map(input => input.getAttribute('data-qz-field') ?? '');
  const dateRange =
    datePicker && rangeInputs.length === 2 && rangeIds.every(Boolean)
      ? { index: rangeInputs.indexOf(input), ids: rangeIds }
      : undefined;
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
  else if (
    ['combobox', 'listbox', 'radiogroup', 'checkbox', 'radio', 'switch', 'textbox', 'spinbutton', 'slider'].includes(
      role,
    )
  )
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
  const multiple =
    element.getAttribute('aria-multiselectable') === 'true' ||
    element.hasAttribute('multiple') ||
    Boolean(
      component && adapter?.multiple && (element.matches(adapter.multiple) || element.querySelector(adapter.multiple)),
    );
  let selectedValues: string[] | undefined =
    tag === 'select' && multiple
      ? Array.from((element as HTMLSelectElement).selectedOptions)
          .filter(option => option.value !== '')
          .map(option => option.text.trim())
      : undefined;
  // 控件框：输入框外面高度和它差不多、不含别的控件和别的 <label> 的几层祖先。
  const own = element.getBoundingClientRect();
  const height = Math.max(own.height, 24);
  const box: Element[] = [];
  for (
    let container = element.parentElement, depth = 0;
    container && depth < 5;
    depth++, container = container.parentElement
  ) {
    if (container.getBoundingClientRect().height > height * 1.8 + 4) break;
    if (
      Array.from(container.querySelectorAll('input, select, textarea, [role="combobox"]')).some(
        other => other !== element,
      )
    )
      break;
    if (Array.from(container.querySelectorAll('label')).some(label => !label.contains(element))) break;
    box.push(container);
  }
  const holder = element.ownerDocument.defaultView as Window & {
    __qzSelections?: WeakMap<Element, { value: string | null }>;
    __qzDropdownInputs?: WeakSet<Element>;
  };
  const popup =
    !datePicker &&
    (component ||
      role === 'combobox' ||
      Boolean(holder.__qzDropdownInputs?.has(element)) ||
      [element, ...box].some(
        node => ['button', 'combobox'].includes(node.getAttribute('role') ?? '') || node.hasAttribute('aria-haspopup'),
      ));
  // Editability and aria-autocomplete describe interaction, not permission to
  // invent an option. Only explicit component flags/native contracts allow it.
  type ChoiceProps = { allowCreate?: unknown; freeSolo?: unknown; mode?: unknown; $props?: ChoiceProps };
  const owner = component ? element : element.closest(adapters.map(a => a.root).filter(Boolean).join(', ') || ':not(*)');
  const vue = (owner as (Element & { __vue__?: ChoiceProps }) | null)?.__vue__;
  const props = vue?.$props ?? vue;
  const nativeSuggestions = tag === 'input' && Boolean(input.list);
  const choicePolicy: ChoicePolicy | undefined = datePicker ? undefined : tag === 'select' ? 'options_only'
    : nativeSuggestions || props?.freeSolo === true ? 'free_text'
    : props?.allowCreate === true || props?.mode === 'tags' ? 'custom_option'
    : popup ? (input.readOnly || (component && !element.matches('.el-autocomplete')) ? 'options_only' : 'unknown')
    : ['text', 'contenteditable'].includes(kind) ? 'free_text' : 'unknown';
  // 自定义下拉常把选中项显示在输入框旁边，输入框本身为空：读控件框里显示的文字，去掉占位/提示、隐藏和弹层内容。
  if (tag === 'input' && kind === 'text' && !datePicker && (popup || display)) {
    const selected = element.getAttribute('aria-valuetext');
    const rawValue = selected ?? input.value;
    selectionConfirmed = !rawValue.trim()
      ? undefined
      : Boolean(input.readOnly) ||
        selected !== null ||
        (holder.__qzSelections?.get(element)?.value === input.value &&
          element.getAttribute('aria-expanded') !== 'true');
    if (selected !== null) value = selected;
    // 只取和输入框同一行的可见文字：标签和说明在上下方，几何上排除；占位/提示、隐藏和弹层内容按标记排除。
    const doc = element.ownerDocument;
    const skip =
      '[class*="placeholder"], [class*="hint"], [aria-hidden="true"], [role="listbox"], [role="option"], input, textarea, label';
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
        const rawText = node.textContent?.trim() ?? '';
        if (!parent || parent.closest(skip) || !rawText || /^[×✕✖]+$/u.test(rawText)) continue;
        if (typeof parent.checkVisibility === 'function' && !parent.checkVisibility({ visibilityProperty: true }))
          continue;
        if (sameRow(node)) parts.push(node.textContent!);
      }
      // 必填星号不是值。
      const shown = parts
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/(^|\s)\*+(?=\s|$)/g, ' ')
        .replace(/\s*[×✕✖]\s*$/u, '')
        .trim();
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
    const skip = [
      'input',
      'textarea',
      'button',
      'svg',
      '[role="listbox"]',
      '[role="option"]',
      adapter.popup,
      adapter.omit,
    ]
      .filter(Boolean)
      .join(', ');
    const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const rawText = node.textContent?.trim() ?? '';
      if (parent && !parent.closest(skip) && visible(parent) && rawText && !/^[×✕✖]+$/u.test(rawText)) {
        parts.push(rawText);
      }
    }
    value = (element.getAttribute('aria-valuetext') ?? parts.join(' '))
      .replace(/\s+/g, ' ')
      .replace(/\s*[×✕✖]\s*$/u, '')
      .trim();
    // Some components keep both the query and the committed value in one input.
    // Retain its text, but only a verified option click can confirm an editable input.
    if (!value) {
      const displays = Array.from(element.querySelectorAll<HTMLInputElement>('input')).filter(
        input => ['text', 'search'].includes(input.type) && visible(input),
      );
      if (displays.length === 1) {
        const displayInput = displays[0];
        const selected = displayInput.getAttribute('aria-valuetext');
        value = selected ?? displayInput.value;
        type VueDisplayVm = {
          $el?: unknown;
          presentText?: unknown;
          selectedLabel?: unknown;
          $children?: VueDisplayVm[];
        };
        let vueCommitted = false;
        for (
          let vm = (element as unknown as { __vue__?: VueDisplayVm }).__vue__, depth = 0;
          vm && depth < 4;
          vm = vm.$children?.find(child => child.$el === element), depth++
        ) {
          if (
            (typeof vm.presentText === 'string' && vm.presentText.trim() !== '' && vm.presentText === value) ||
            (typeof vm.selectedLabel === 'string' && vm.selectedLabel.trim() !== '' && vm.selectedLabel === value)
          ) {
            vueCommitted = true;
            break;
          }
        }
        selectionConfirmed = !value.trim()
          ? undefined
          : Boolean(displayInput.readOnly) ||
            selected !== null ||
            vueCommitted ||
            (holder.__qzSelections?.get(displayInput)?.value === value &&
              displayInput.getAttribute('aria-expanded') !== 'true' &&
              element.getAttribute('aria-expanded') !== 'true');
      }
    } else {
      selectionConfirmed = true;
    }
    if (multiple && adapter.selectedItems) {
      selectedValues = Array.from(element.querySelectorAll(adapter.selectedItems))
        .filter(visible)
        .map(item => (item.textContent ?? '').replace(/\s*[×✕✖]\s*$/u, '').trim())
        .filter(Boolean);
      // A multi-select's search input never represents a selected option.
      value = selectedValues.join('、');
      selectionConfirmed = true;
    }
  } else if (kind === 'custom' && tag !== 'select') {
    const ariaValue = element.getAttribute('aria-valuetext') ?? element.getAttribute('aria-valuenow');
    if (['checkbox', 'radio', 'switch'].includes(role)) {
      value = element.getAttribute('aria-checked') ?? '';
      valueKnown = ['true', 'false', 'mixed'].includes(value);
    } else if (role === 'listbox' || role === 'radiogroup') {
      const selected = Array.from(
        element.querySelectorAll(
          role === 'listbox' ? '[role="option"][aria-selected="true"]' : '[role="radio"][aria-checked="true"]',
        ),
      );
      value = selected.map(option => option.getAttribute('aria-label') || option.textContent?.trim() || '').join('\n');
      valueKnown = selected.every(option => Boolean(option.getAttribute('aria-label') || option.textContent?.trim()));
    } else if (ariaValue !== null) value = ariaValue;
    else if (role === 'combobox' || role === 'textbox') {
      // Exclude the popup and its choices; they are not the selected field value.
      const clone = element.cloneNode(true) as Element;
      clone
        .querySelectorAll('[role="listbox"], [role="option"], [aria-hidden="true"]')
        .forEach(child => child.remove());
      value = clone.textContent?.trim() || '';
      if (value === element.getAttribute('aria-placeholder')) value = '';
    } else {
      value = '';
      valueKnown = false;
    }
  }
  if (element.matches(calendars.lixiang.root) && value.trim()) {
    const panel = element.querySelector(calendars.lixiang.popup);
    // Choosing a year only previews it; dismissing the panel restores the old value.
    selectionConfirmed = !(panel && visible(panel)) && /^\d{4}\D+\d{1,2}\D*$/.test(value.trim());
  }
  if (!datePicker && choicePolicy === 'free_text') selectionConfirmed = undefined;
  // 字段所在表单项：往上直到再上一层就会包含 3 个以上表单控件为止，框住标签、控件和提示文字。
  const formSelector =
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="listbox"], [role="textbox"], [contenteditable="true"]';
  let item: Element = element;
  for (let depth = 0; depth < 10; depth++) {
    const parent = item.parentElement;
    if (!parent || parent === element.ownerDocument.body || parent.querySelectorAll(formSelector).length > 3) break;
    item = parent;
  }
  const scopedItem = adapter ? element.closest(adapter.item) : null;
  if (scopedItem) item = scopedItem;
  const context = (((item as HTMLElement).innerText ?? item.textContent ?? '') as string)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const errorId = element.getAttribute('aria-errormessage');
  const errorText = errorId ? (element.ownerDocument.getElementById(errorId)?.textContent ?? '').trim() : '';
  // Only errors in this exact form item count, never a sibling field's error.
  const componentErrors =
    adapter && scopedItem
      ? Array.from(scopedItem.querySelectorAll(adapter.error))
          .filter(node => node.closest(adapter.item) === scopedItem && visible(node))
          .map(node => node.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ')
      : '';
  const componentInvalid = Boolean(
    adapter &&
      (element.matches(adapter.invalid) ||
        scopedItem?.matches(adapter.invalid) ||
        (scopedItem &&
          Array.from(scopedItem.querySelectorAll(adapter.invalid)).some(
            node => (node === element || node.contains(element)) && visible(node),
          ))),
  );
  const identity = Object.fromEntries(
    ['data-qz-field', 'id', 'name', 'type', 'role', 'contenteditable'].map(key => [
      key,
      element.getAttribute(key) ?? '',
    ]),
  );
  identity.tagName = tag;
  const disabled = Boolean(
    input.disabled ||
      element.matches(':disabled') ||
      element.closest('[aria-disabled="true"]') ||
      (adapter?.disabled && element.matches(adapter.disabled)),
  );
  // 只读的 combobox 输入框只是不能打字，选项仍可选择，不算只读字段。
  const readOnly = Boolean(
    (input.readOnly && !(tag === 'input' && role === 'combobox')) || element.closest('[aria-readonly="true"]'),
  );
  const typable = component
    ? element.matches('.el-cascader, .ant-cascader, .ant-cascader-picker') ||
      Array.from(element.querySelectorAll<HTMLInputElement>('input')).some(
        inp => ['text', 'search'].includes(inp.type) && !inp.readOnly && !inp.disabled && visible(inp),
      )
    : tag === 'input' && !disabled && !input.readOnly && ['text', 'search'].includes(type);
  const maxLength = typeof input.maxLength === 'number' ? input.maxLength : -1;
  const minLength = typeof input.minLength === 'number' ? input.minLength : -1;
  const lengthValid =
    kind !== 'text' ||
    ((maxLength < 0 || value.length <= maxLength) &&
      (minLength < 0 || value.length === 0 || value.length >= minLength));
  // Read markers belonging to this field, never stars from nearby values or another form item.
  const labels = Array.from(input.labels ?? []);
  if (scopedItem)
    labels.push(
      ...Array.from(scopedItem.querySelectorAll<HTMLLabelElement>('label')).filter(
        label => label.closest(adapter!.item) === scopedItem && !label.querySelector('input, select, textarea'),
      ),
    );
  // Unassociated labels and a separate star are common. Stay within the preceding
  // label run; never borrow a star from a previous field or a value inside this control.
  const controls =
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="textbox"], [contenteditable="true"]';
  const visibleText = (node: Node): string =>
    node.nodeType === 3
      ? (node.textContent ?? '')
      : node.nodeType === 1 && visible(node as Element)
        ? Array.from(node.childNodes).map(visibleText).join('')
        : '';
  const hasPseudoStar = (el: Element): boolean => {
    const view = element.ownerDocument.defaultView;
    if (!view?.getComputedStyle || view.navigator?.userAgent?.includes('jsdom')) return false;
    for (const pseudo of ['::before', '::after'] as const) {
      const content = view.getComputedStyle(el, pseudo).content ?? '';
      if (content !== 'none' && content !== 'normal' && /[*＊]/.test(content)) return true;
    }
    return false;
  };
  let precedingRequired = false;
  for (
    let current: Element | null = element, depth = 0;
    current?.parentElement && depth < 5;
    current = current.parentElement, depth++
  ) {
    let star = false;
    let foundLabel = false;
    let crossedControl = false;
    for (let sibling = current.previousElementSibling; sibling; sibling = sibling?.previousElementSibling ?? null) {
      if (!visible(sibling)) continue;
      if (sibling.matches(controls) || sibling.querySelector(controls)) {
        crossedControl = true;
        break;
      }
      const text = visibleText(sibling).trim();
      if (!text && !hasPseudoStar(sibling)) continue;
      if (text && /^[*＊\s]+$/.test(text)) {
        star = true;
        continue;
      }
      foundLabel = true;
      precedingRequired = star || /[*＊]\s*$/.test(text) || hasPseudoStar(sibling);
      break;
    }
    if (foundLabel || crossedControl || current.parentElement.matches('form, body')) break;
  }
  const labelRequired =
    precedingRequired || labels.some(label => /[*＊]/.test(visibleText(label)) || hasPseudoStar(label));
  const markedRequired = Boolean(
    adapter?.required &&
      scopedItem &&
      (scopedItem.matches(adapter.required) ||
        Array.from(scopedItem.querySelectorAll(adapter.required)).some(
          marker => marker.closest(adapter.item) === scopedItem && visible(marker),
        )),
  );
  const required =
    element.getAttribute('aria-required') === 'true' ||
    Boolean(input.required) ||
    scopedItem?.getAttribute('aria-required') === 'true' ||
    labelRequired ||
    markedRequired ||
    Boolean(component && element.querySelector('input[required], [aria-required="true"]'));
  const customMissing =
    kind === 'custom' &&
    required &&
    (['checkbox', 'radio', 'switch'].includes(role) ? value !== 'true' : !value.trim());
  const ariaInvalid =
    element.closest('[aria-invalid]:not([aria-invalid="false"])') !== null ||
    Boolean(component && element.querySelector('[aria-invalid]:not([aria-invalid="false"])'));
  const requirements = {
    inputType: input.type ?? '',
    pattern: input.pattern ?? '',
    min: input.min ?? '',
    max: input.max ?? '',
    dateFormats: [] as string[],
  };
  if (input.type === 'date') requirements.dateFormats = ['YYYY-MM-DD'];
  if (input.type === 'month') requirements.dateFormats = ['YYYY-MM'];
  if (element.matches(calendars.lixiang.root)) requirements.dateFormats = ['YYYY-MM'];
  const elDateEditor = element.closest(calendars.element.root);
  if (elDateEditor && !requirements.dateFormats.length) {
    type ElPickerVm = {
      valueFormat?: unknown;
      format?: unknown;
      type?: unknown;
      picker?: unknown;
      $parent?: ElPickerVm;
    };
    const rawVm = (elDateEditor as unknown as { __vue__?: ElPickerVm }).__vue__;
    const elVm =
      rawVm && !rawVm.picker && !rawVm.valueFormat && !rawVm.format && rawVm.$parent ? rawVm.$parent : rawVm;
    const rawFormat =
      typeof elVm?.valueFormat === 'string' && elVm.valueFormat
        ? elVm.valueFormat
        : typeof elVm?.format === 'string' && elVm.format
          ? elVm.format
          : '';
    if (rawFormat) {
      requirements.dateFormats = [rawFormat.replace(/y+/g, 'YYYY').replace(/d+/g, 'DD')];
    } else if (elDateEditor.matches('.el-date-editor--year')) {
      requirements.dateFormats = ['YYYY'];
    } else if (elDateEditor.matches('.el-date-editor--month, .el-date-editor--monthrange')) {
      requirements.dateFormats = ['YYYY-MM'];
    } else if (
      elDateEditor.matches(
        '.el-date-editor--date, .el-date-editor--daterange, .el-date-editor--datetime, .el-date-editor--datetimerange',
      )
    ) {
      requirements.dateFormats = ['YYYY-MM-DD'];
    }
  }
  // Read the owning Ant picker, even when its popup is closed. Its mode is a view,
  // not the accepted precision. Never infer a format from a label or a selected day.
  const picker = element.closest(calendars.antLegacy.root);
  if (picker) {
    type Owner = { return?: Owner; stateNode?: { input?: unknown; props?: { format?: unknown } } };
    const key = Object.keys(element).find(
      key => key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$'),
    );
    const host = key ? (element as unknown as Record<string, Owner>)[key] : undefined;
    for (let owner = host?.return, depth = 0; owner && depth < 12; owner = owner?.return, depth++) {
      if (owner.stateNode?.input !== element) continue;
      const format = owner.stateNode.props?.format;
      if (typeof format === 'string') requirements.dateFormats = [format];
      else if (Array.isArray(format) && format.every(value => typeof value === 'string'))
        requirements.dateFormats = format;
      break;
    }
  }
  const pageValidationMessage = input.validationMessage || componentErrors ||
    (componentInvalid ? '网页将此表单项标记为无效，见字段附近文字。' : '') ||
    (ariaInvalid ? errorText || '网页将此控件标记为无效，见字段附近文字。' : '');
  return {
    datePicker,
    dateRange,
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
    choicePolicy,
    pageValidationMessage,
    valid:
      selectionConfirmed !== false &&
      valueKnown &&
      !customMissing &&
      lengthValid &&
      input.validity?.valid !== false &&
      !ariaInvalid &&
      !componentInvalid &&
      !componentErrors &&
      !(kind === 'unsupported' && required && !input.validity),
    validationMessage:
      pageValidationMessage ||
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
    typable,
    settleMs: adapter?.settleMs,
  };
}
