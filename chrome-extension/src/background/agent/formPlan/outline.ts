import { Actors, ExecutionState } from '../event/types';
import type { BrowserState } from '../../browser/views';
import { DOMElementNode, DOMTextNode, type DOMBaseNode } from '../../browser/dom/views';
import type { FormControlState } from '../../browser/formControls';
import { waitForApplicationDialog, waitForApplicationResume } from '../applicationDialog';
import type { AgentContext } from '../types';
import { formFieldReference, type FormFieldReference } from '../formReview';

export { waitForApplicationResume } from '../applicationDialog';

export type FieldKind = 'text' | 'textarea' | 'select' | 'combobox' | 'checkbox' | 'radio' | 'switch' | 'editable';

export interface OutlineField {
  type: 'field';
  id: string;
  node: DOMElementNode;
  kind: FieldKind;
  label: string;
  field: FormFieldReference;
  value: string;
  valueKnown: boolean;
  selectionConfirmed?: boolean;
  choicePolicy?: FormControlState['choicePolicy'];
  valid: boolean;
  message: string;
  context: string;
  required: boolean;
  multiple?: boolean;
  typable: boolean;
  readOnly: boolean;
  datePicker?: boolean;
  dateRange?: FormControlState['dateRange'];
  options?: string[];
  requirements?: FormControlState['requirements'];
}

export interface OutlineButton {
  type: 'button';
  id: string;
  node: DOMElementNode;
  text: string;
  hint: string;
}

export type OutlineItem = OutlineField | OutlineButton | { type: 'text'; text: string };

export interface FormOutline {
  state: BrowserState;
  items: OutlineItem[];
  fields: Map<string, OutlineField>;
  buttons: Map<string, OutlineButton>;
}

const KIND_LABEL: Record<FieldKind, string> = {
  text: '文本',
  textarea: '多行文本',
  select: '下拉',
  combobox: '下拉',
  checkbox: '勾选',
  radio: '单选',
  switch: '开关',
  editable: '文本',
};
const BUTTON_ROLES = ['button', 'link', 'tab', 'menuitem'];

/** 结构判断：只看标签、类型和 ARIA 角色，不看文字含义。 */
export function fieldKind(node: DOMElementNode): FieldKind | null {
  if (node.attributes['data-qz-control-part'] === 'true') return null;
  if (node.attributes['data-qz-control'] === 'combobox') return 'combobox';
  const tag = (node.tagName ?? '').toLowerCase();
  const type = (node.attributes.type ?? '').toLowerCase();
  const role = node.attributes.role ?? '';
  if (tag === 'input') {
    if (['hidden', 'file', 'password', 'submit', 'button', 'image', 'reset'].includes(type)) return null;
    if (type === 'checkbox' || type === 'radio') return type;
    return role === 'combobox' ? 'combobox' : 'text';
  }
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (role === 'combobox' || role === 'listbox') return 'combobox';
  if (role === 'checkbox' || role === 'radio' || role === 'switch') return role;
  if (['', 'true', 'plaintext-only'].includes(node.attributes.contenteditable ?? 'false')) return 'editable';
  return null;
}

const clean = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

const ICON_ACTION_LABEL_RE = /^(?:删除|移除|添加|新增|delete|remove|trash|add|plus)$/i;
const ROW_REMOVAL_TEXT = /^(?:删除|移除)(?:这|该|本)(?:一)?(?:段|条|行)(?:信息|经历|记录)?$|^(?:delete|remove)\s+(?:this\s+)?(?:row|entry|record)$/i;

const isButtonLike = (node: DOMElementNode) =>
  ['button', 'a'].includes((node.tagName ?? '').toLowerCase()) ||
  BUTTON_ROLES.includes(node.attributes.role ?? '') ||
  Boolean(node.attributes.hint) ||
  ICON_ACTION_LABEL_RE.test((node.attributes['aria-label'] ?? node.attributes.title ?? '').trim());

const containsField = (node: DOMElementNode): boolean =>
  node.children.some(child => child instanceof DOMElementNode && (fieldKind(child) !== null || containsField(child)));

/** 文字属于按钮、字段或 label 时已体现在它们的名字里；其余（区块标题、格式提示）单独保留。 */
function ownedText(node: DOMBaseNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.highlightIndex !== null && (fieldKind(parent) || isButtonLike(parent) || (parent.tagName ?? '').toLowerCase() === 'label'))
      return true;
  return false;
}
const MEANINGFUL = /[^\s\-–—~～·:：,，.。、/|()（）*]/;

export interface RawItem {
  node: DOMElementNode | null;
  kind: 'field' | 'button' | 'text';
  text: string;
}

/** 按页面顺序收集控件、按钮和说明文字；只保留第一个到最后一个控件之间的部分。 */
export function collectOutline(root: DOMElementNode): RawItem[] {
  const out: RawItem[] = [];
  const visit = (node: DOMBaseNode) => {
    if (node instanceof DOMTextNode) {
      if (node.isVisible && !ownedText(node)) {
        const text = clean(node.text, 80);
        if (MEANINGFUL.test(text)) out.push({ node: null, kind: 'text', text });
      }
      return;
    }
    if (!(node instanceof DOMElementNode)) return;
    if (node.isVisible && node.xpath && !fieldKind(node)) {
      const directText = clean(node.children.filter(child => child instanceof DOMTextNode).map(child => child.text).join(' '), 60);
      if (ROW_REMOVAL_TEXT.test(directText) && !containsField(node)) {
        out.push({ node, kind: 'button', text: directText });
        return;
      }
    }
    if (node.highlightIndex !== null) {
      const text = clean(node.getAllTextTillNextClickableElement(2), 60);
      if (fieldKind(node)) out.push({ node, kind: 'field', text });
      // 包着输入框的“按钮”其实是该字段的控件框，不单列。
      else if (isButtonLike(node) && !containsField(node)) out.push({ node, kind: 'button', text });
    }
    for (const child of node.children) visit(child);
  };
  // 范围：包住所有字段的最小容器（表单本身），区块末尾只有添加入口的部分也在里面；退化成整页时只取首尾字段之间。
  const fields: DOMElementNode[] = [];
  const find = (node: DOMBaseNode) => {
    if (!(node instanceof DOMElementNode)) return;
    if (node.highlightIndex !== null && fieldKind(node)) fields.push(node);
    node.children.forEach(find);
  };
  find(root);
  if (!fields.length) return [];
  const chain = (node: DOMElementNode) => {
    const list: DOMElementNode[] = [];
    for (let current: DOMElementNode | null = node; current; current = current.parent) list.push(current);
    return list;
  };
  let scope: DOMElementNode | null = null;
  for (const candidate of chain(fields[0]))
    if (fields.every(field => chain(field).includes(candidate))) {
      scope = candidate;
      break;
    }
  const tag = (scope?.tagName ?? '').toLowerCase();
  if (scope && !['body', 'html'].includes(tag)) {
    visit(scope);
    return out;
  }
  visit(root);
  const first = out.findIndex(item => item.kind === 'field');
  const last = out.map(item => item.kind).lastIndexOf('field');
  return out.slice(first, last + 1);
}

/** 读取当前页面的表单概览：给控件和按钮打稳定标记，并批量读出真实值。 */
export async function readFormOutline(context: AgentContext): Promise<FormOutline> {
  const state = await context.browserContext.getState();
  const page = await context.browserContext.getCurrentPage();
  const raw = collectOutline(state.elementTree);
  const tagged = raw.filter(item => item.node);
  const ids = await page.tagApplicationElements(
    tagged.map(item => item.node!.xpath ?? ''),
    tagged.map(item => item.node!),
  );
  tagged.forEach((item, i) => {
    if (ids[i]) item.node!.attributes['data-qz-field'] = ids[i]!;
  });
  return assembleOutline(state, raw, await page.readTaggedControls());
}

/** 由收集结果和真实控件状态组装概览；标记已写进节点属性。 */
export function assembleOutline(
  state: BrowserState,
  raw: RawItem[],
  live: Map<string, FormControlState & { options?: string[] }>,
): FormOutline {
  const items: OutlineItem[] = [];
  const fields = new Map<string, OutlineField>();
  const buttons = new Map<string, OutlineButton>();
  for (const item of raw) {
    const id = item.node?.attributes['data-qz-field'];
    if (item.kind === 'text') {
      const previous = items[items.length - 1];
      if (!(previous?.type === 'text' && previous.text === item.text)) items.push({ type: 'text', text: item.text });
    } else if (item.kind === 'button' && id) {
      const button: OutlineButton = { type: 'button', id, node: item.node!, text: item.text, hint: item.node!.attributes.hint ?? '' };
      buttons.set(id, button);
      items.push(button);
    } else if (item.kind === 'field' && id && live.has(id)) {
      const node = item.node!;
      const control: FormControlState & { options?: string[] } = live.get(id)!;
      const reference = formFieldReference(state, node, node.highlightIndex ?? -1);
      const kind = fieldKind(node)!;
      const field: OutlineField = {
        type: 'field',
        id,
        node,
        kind: kind === 'text' && control.popup ? 'combobox' : kind,
        label: reference.label,
        field: reference,
        value: control.value,
        valueKnown: control.valueKnown !== false,
        selectionConfirmed: control.selectionConfirmed,
        choicePolicy: control.choicePolicy,
        valid: control.valid,
        message: control.validationMessage,
        context: control.context ?? '',
        requirements: control.requirements,
        required: control.required ?? (node.attributes.required !== undefined || node.attributes['aria-required'] === 'true'),
        multiple: control.multiple,
        typable: control.typable ?? ((node.tagName ?? '').toLowerCase() === 'input' && node.attributes.readonly !== 'true'),
        readOnly: control.readOnly || node.attributes.readonly === 'true',
        datePicker: control.datePicker,
        dateRange: control.dateRange,
        options: control.options,
      };
      fields.set(id, field);
      items.push(field);
    }
  }
  // 相邻同名同类字段（如起止时间的两个框）按顺序编号。
  const list = [...fields.values()];
  const key = list.map(field => `${field.kind}\u0000${field.label}`);
  list.forEach((field, i) => {
    let start = i;
    while (start > 0 && key[start - 1] === key[i]) start--;
    let end = i;
    while (end < list.length - 1 && key[end + 1] === key[i]) end++;
    if (end > start) field.label = `${field.label}（${i - start + 1}/${end - start + 1}）`;
  });
  // 与紧随其后的字段标签相同的说明文字是重复的标签，去掉。
  const deduped = items.filter((item, i) => {
    if (item.type !== 'text') return true;
    const next = items.slice(i + 1, i + 3).find(other => other.type === 'field') as OutlineField | undefined;
    return clean(next?.label ?? '', 80) !== item.text.replace(/\s*\*+\s*$/, '');
  });
  return { state, items: deduped, fields, buttons };
}

/** 为空的下拉字段展开取选项，供方案或用户直接从真实选项里选。 */
export async function loadDropdownOptions(context: AgentContext, outline: FormOutline, only?: Set<string>): Promise<boolean> {
  const page = await context.browserContext.getCurrentPage();
  let inspected = false;
  for (const field of outline.fields.values()) {
    if (only && !only.has(field.id)) continue;
    if (context.review.isSkipped(field.field) || context.review.isAutoDeferred(field.field)) continue;
    if (field.datePicker || !['combobox', 'select'].includes(field.kind) || (field.value.trim() && field.selectionConfirmed !== false)) continue;
    await waitForApplicationResume(context);
    await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `正在读取选项 · ${field.label}`);
    await waitForApplicationResume(context);
    await waitForApplicationDialog(context);
    inspected = true;
    try {
      field.options = await context.controlExploration.run(field.field, context.controller.signal, signal =>
        typeof page.listControlOptions === 'function'
          ? page.listControlOptions(field.node, signal)
          : page.listCustomOptions(field.node, signal));
    } catch {
      /* 展不开的下拉留给填写时的反馈处理。 */
    }
  }
  return inspected;
}

const shown = (value: string) =>
  value.length > 40 ? `${JSON.stringify(value.slice(0, 40))}…（共${value.length}字）` : JSON.stringify(value);

/** 给模型看的紧凑概览：每行一个元素，按页面顺序。 */
export function outlineText(outline: FormOutline): string {
  return outline.items
    .map(item => {
      if (item.type === 'text') return `· ${item.text}`;
      if (item.type === 'button')
        return `${item.id} [按钮] ${item.text || '(无文字)'}${item.hint ? ` 图标:${item.hint}` : ''}`;
      const toggle = ['checkbox', 'radio', 'switch'].includes(item.kind);
      const value = !item.valueKnown ? '无法读取' : toggle ? (item.value === 'true' ? '已勾选' : '未勾选')
        : item.selectionConfirmed === false ? `未确认选择（当前搜索文字 ${shown(item.value)}）` : shown(item.value);
      const options = item.options?.length
        ? ` 选项：${item.options.slice(0, 50).join(' | ')}${item.typable ? '（可输入筛选，列表可能不全）' : ''}`
        : '';
      const choice = item.choicePolicy ? ` 输入方式：${{
        free_text: '允许自由输入，仍须失焦后核验', options_only: '只允许选择已有候选，输入仅用于搜索',
        custom_option: '允许创建新候选，必须完成创建确认', unknown: '尚未确认是否允许自定义，不能把搜索文字当成已选值',
      }[item.choicePolicy]}` : '';
      const problem = !item.valid && item.message ? ` ⚠${clean(item.message, 60)}` : '';
      const multiple = item.multiple || item.node.attributes['aria-multiselectable'] === 'true' || item.node.attributes.multiple !== undefined;
      const datePlaceholder = item.node.attributes.placeholder?.trim() ?? '';
      const dateRole = /^(?:开始(?:日期|时间)|起始(?:日期|时间)|start date)$/iu.test(datePlaceholder) ? '·开始'
        : /^(?:结束(?:日期|时间)|截止(?:日期|时间)|end date)$/iu.test(datePlaceholder) ? '·结束' : '';
      const kindLabel = item.datePicker ? `日期${dateRole}` : KIND_LABEL[item.kind];
      const kind = `${kindLabel}${item.readOnly && (item.kind === 'text' || item.datePicker) ? '·只读' : ''}${multiple ? '·多选' : ''}`;
      const rawPlaceholder = (item.node.attributes.placeholder ?? '').replace(/\s+/g, ' ').trim();
      const placeholder =
        rawPlaceholder &&
        rawPlaceholder !== item.label &&
        !item.label.includes(rawPlaceholder) &&
        !/^请(?:输入|填写|选择)$/.test(rawPlaceholder)
          ? ` 占位提示=${JSON.stringify(rawPlaceholder.slice(0, 60))}`
          : '';
      const requirements = item.requirements ? ` 控件约束=${JSON.stringify(item.requirements)}` : '';
      return `${item.id} [${kind}] ${item.label}${item.required ? ' *必填' : ' 选填'} = ${value}${placeholder}${choice}${options}${problem}${requirements}`;
    })
    .join('\n');
}
