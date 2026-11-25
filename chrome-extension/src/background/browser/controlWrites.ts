import { type SelectChoice } from './controlState';

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
    const previousValue = (element as HTMLInputElement | HTMLTextAreaElement).value;
    const tracker = (element as unknown as { _valueTracker?: { setValue?(v: string): void } })._valueTracker;
    setter.call(element, value);
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(previousValue);
    }
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
  const previousValue = select.value;
  const tracker = (select as unknown as { _valueTracker?: { setValue?(v: string): void } })._valueTracker;
  setter.call(select, value);
  if (tracker && typeof tracker.setValue === 'function') {
    tracker.setValue(previousValue);
  }
  select.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
}

/**
 * 在页面 MAIN 世界通过 React Fiber / Props 或 Vue 实例触发受控组件的 onChange / onSelect / v-model 更新。
 * 仅调用组件自身的框架回调，不直接篡改无框架节点的 DOM 值；最终是否生效仍由回读核验决定。
 * evaluate 会序列化本函数，不能引用外部变量。
 */
export function writeMainWorldComponentState(element: Element, value: string, optionElement?: Element | null): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected) return false;
  let triggered = false;

  const controlSelector =
    'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [contenteditable=""], ' +
    '[role="combobox"], [role="listbox"], [role="textbox"], [role="radiogroup"], [role="checkbox"], [role="radio"], [role="switch"]';
  const scopes: Element[] = [element];
  for (
    let parent = element.parentElement, depth = 0;
    parent && parent !== element.ownerDocument.body && depth < 3;
    parent = parent.parentElement, depth++
  ) {
    if (parent.querySelectorAll(controlSelector).length > 1) break;
    scopes.push(parent);
  }

  const syntheticEvent = (target: Element, val: string) => ({
    target: {
      value: val,
      name: (target as HTMLInputElement).name ?? '',
      id: target.id ?? '',
      type: (target as HTMLInputElement).type ?? '',
      checked: (target as HTMLInputElement).checked ?? false,
      getAttribute: (attr: string) => target.getAttribute(attr),
    },
    currentTarget: target,
    type: 'change',
    nativeEvent: new view.Event('change', { bubbles: true }),
    preventDefault() {},
    stopPropagation() {},
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    persist() {},
  });

  if (optionElement && optionElement.isConnected) {
    const optRecord = optionElement as unknown as Record<string, unknown>;
    const optPropsKey = Object.keys(optRecord).find(k => k.startsWith('__reactProps$'));
    const optProps = optPropsKey ? (optRecord[optPropsKey] as Record<string, unknown>) : null;
    if (optProps && typeof optProps.onClick === 'function') {
      try {
        (optProps.onClick as (e: unknown) => void)(syntheticEvent(optionElement, value));
        triggered = true;
      } catch {
        /* Ignore framework handler errors; readback verifies final state. */
      }
    }
    const optFiberKey = Object.keys(optRecord).find(
      k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (optFiberKey) {
      type OptFiber = { memoizedProps?: Record<string, unknown>; return?: OptFiber };
      for (let f = optRecord[optFiberKey] as OptFiber | undefined, d = 0; f && d < 4; f = f.return, d++) {
        if (typeof f.memoizedProps?.onClick === 'function') {
          try {
            (f.memoizedProps.onClick as (e: unknown) => void)(syntheticEvent(optionElement, value));
            triggered = true;
            break;
          } catch {
            /* Ignore. */
          }
        }
      }
    }
  }

  for (const node of scopes) {
    const record = node as unknown as Record<string, unknown>;
    const propsKey = Object.keys(record).find(k => k.startsWith('__reactProps$'));
    if (propsKey && record[propsKey] && typeof record[propsKey] === 'object') {
      const props = record[propsKey] as Record<string, unknown>;
      if (typeof props.onChange === 'function') {
        try {
          const isNativeInput =
            node instanceof view.HTMLInputElement ||
            node instanceof view.HTMLTextAreaElement ||
            node instanceof view.HTMLSelectElement;
          (props.onChange as (arg: unknown) => void)(isNativeInput ? syntheticEvent(node, value) : value);
          triggered = true;
        } catch {
          /* Ignore and continue. */
        }
      }
      if (typeof props.onSelect === 'function') {
        try {
          (props.onSelect as (arg: unknown) => void)(value);
          triggered = true;
        } catch {
          /* Ignore and continue. */
        }
      }
    }

    const fiberKey = Object.keys(record).find(
      k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (fiberKey) {
      type FiberNode = {
        memoizedProps?: Record<string, unknown>;
        stateNode?: { props?: Record<string, unknown> } | Element | null;
        return?: FiberNode;
      };
      let fiber = record[fiberKey] as FiberNode | undefined;
      for (let depth = 0; fiber && depth < 6; fiber = fiber.return, depth++) {
        const props =
          fiber.memoizedProps ??
          (fiber.stateNode && !(fiber.stateNode instanceof view.Element) ? fiber.stateNode.props : undefined);
        if (props && typeof props === 'object') {
          if (typeof props.onChange === 'function') {
            try {
              const isNativeInput =
                node instanceof view.HTMLInputElement ||
                node instanceof view.HTMLTextAreaElement ||
                node instanceof view.HTMLSelectElement;
              if (isNativeInput && depth === 0) {
                (props.onChange as (arg: unknown) => void)(syntheticEvent(node, value));
              } else {
                (props.onChange as (arg: unknown) => void)(value);
              }
              triggered = true;
            } catch {
              try {
                (props.onChange as (arg: unknown) => void)(syntheticEvent(node, value));
                triggered = true;
              } catch {
                /* Ignore. */
              }
            }
          }
          if (typeof props.onSelect === 'function') {
            try {
              (props.onSelect as (arg: unknown) => void)(value);
              triggered = true;
            } catch {
              /* Ignore. */
            }
          }
        }
      }
    }

    const isCascaderScope = Boolean(node.closest('.el-cascader, .ant-cascader, .ant-cascader-picker'));
    const vue2 = record.__vue__ as
      | {
          value?: unknown;
          $emit?: (event: string, ...args: unknown[]) => void;
        }
      | undefined;
    if (!isCascaderScope && vue2 && typeof vue2.$emit === 'function' && !Array.isArray(vue2.value)) {
      try {
        vue2.$emit('input', value);
        vue2.$emit('change', value);
        triggered = true;
      } catch {
        /* Ignore. */
      }
    }

    const vue3 = record.__vueParentComponent as
      | {
          emit?: (event: string, ...args: unknown[]) => void;
          props?: Record<string, unknown>;
        }
      | undefined;
    if (!isCascaderScope && vue3) {
      try {
        if (typeof vue3.props?.['onUpdate:modelValue'] === 'function') {
          (vue3.props['onUpdate:modelValue'] as (v: unknown) => void)(value);
          triggered = true;
        }
        if (typeof vue3.emit === 'function') {
          vue3.emit('update:modelValue', value);
          vue3.emit('change', value);
          triggered = true;
        }
      } catch {
        /* Ignore. */
      }
    }
  }

  return triggered;
}
