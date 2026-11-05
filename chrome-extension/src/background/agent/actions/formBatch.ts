import type { BrowserState } from '@src/background/browser/views';

/**
 * Exclude field values so typing can continue; retain index, labels and control identity.
 * 传入 indices 时只比这些目标：页面别处的无关变动不该作废本批，目标索引错位仍会被 xpath 识别。
 */
export function formStructureKey(
  state: Pick<BrowserState, 'tabId' | 'url' | 'selectorMap'>,
  indices?: Iterable<number>,
): string {
  const entries = indices
    ? [...new Set(indices)].sort((a, b) => a - b).map(index => [index, state.selectorMap.get(index)] as const)
    : [...state.selectorMap];
  return JSON.stringify([
    state.tabId,
    state.url,
    entries.map(([index, node]) => !node ? [index, null] : [
      index,
      node.tagName,
      node.xpath,
      [
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
      ].map(key => node.attributes[key] ?? null),
      node.getAllTextTillNextClickableElement(2),
      node.parent?.getAllTextTillNextClickableElement(2) ?? '',
    ]),
  ]);
}

export interface FormObservation {
  tabId: number;
  url: string;
  controls: Map<string, { index: number; structure: string }>;
}

export function observeFormStructure(state: BrowserState): FormObservation {
  return {
    tabId: state.tabId,
    url: state.url,
    controls: new Map(
      [...state.selectorMap].map(([index, node]) => {
        const key = JSON.stringify([node.tagName, node.xpath, node.attributes.id ?? '', node.attributes.name ?? '']);
        const structure = formStructureKey({ ...state, selectorMap: new Map([[0, node]]) });
        return [key, { index, structure }];
      }),
    ),
  };
}

/** Indices describe only this observation; removed indices refer to the previous one. */
export function describeFormChanges(previous: FormObservation | undefined, current: FormObservation): string {
  if (!previous) return '';
  if (previous.tabId !== current.tabId || previous.url !== current.url)
    return '目标标签页或网址已变化，请按当前页面重新规划。';
  const added = [...current.controls].filter(([key]) => !previous.controls.has(key)).map(([, value]) => value.index);
  const removed = [...previous.controls].filter(([key]) => !current.controls.has(key)).map(([, value]) => value.index);
  const changed = [...current.controls]
    .filter(([key, value]) => previous.controls.has(key) && previous.controls.get(key)?.structure !== value.structure)
    .map(([, value]) => value.index);
  if (!added.length && !removed.length && !changed.length) return '';
  return `页面结构变化：新增当前控件 ${JSON.stringify(added)}；上轮控件已移除 ${JSON.stringify(removed)}；当前标签或限制变化 ${JSON.stringify(changed)}。旧索引不可沿用。`;
}

/**
 * 可共享一次观察的独立填写：纯文本输入，以及一步完成并回读核验的下拉选择。
 * 下拉选择自己展开、核对归属，写入前还有控件身份核对，所以不必为它结束本批。
 */
export function isPlainFormInput(action: Record<string, unknown>, state: BrowserState): boolean {
  if (Object.keys(action).length !== 1) return false;
  if (action.select_custom_option || action.select_dropdown_option || action.pick_date || action.select_multiple_options) return true;
  if (!action.input_text) return false;
  const input = action.input_text as { index?: number; effect?: string };
  if (input.effect !== 'edit_application' || typeof input.index !== 'number') return false;
  const node = state.selectorMap.get(input.index);
  if (!node || node.attributes.role === 'combobox' || node.attributes['aria-haspopup']) return false;
  const tagName = (node.tagName ?? '').toLowerCase();
  return (
    tagName === 'textarea' ||
    (tagName === 'input' &&
      ['text', 'email', 'tel', 'url', 'number', ''].includes((node.attributes.type ?? '').toLowerCase()))
  );
}
