import type { AuditLocation } from '../browser/formAudit';
import type { PageState } from '../browser/views';
import type { DOMElementNode } from '../browser/dom/views';
import type { FormControlState } from '../browser/formControls';
import { hasCommittedControlValue } from '../browser/controlState';
import { formValuesEquivalent, type FormWriteResult } from '../browser/formFill';
import { reviewIssue, type ReviewIssue } from '../auditStatus';

export interface FormFieldReference {
  key: string;
  legacyKey?: string;
  label: string;
  url: string;
  index: number;
  group?: string;
  auditLocation?: AuditLocation;
}

export interface FormReviewEntry extends FormFieldReference {
  status: 'filled' | 'preserved' | 'skipped' | 'deferred' | 'failed' | 'pending';
  expectedValue: string;
  /** 资料原始拟填值（仅在官网下拉词库适配为不同标准名时记录，如「中国科学院大学」→「中国科学院」）。 */
  requestedValue?: string;
  actualValue: string;
  message: string;
  required: boolean;
  hasExpectation?: boolean;
  ai_inferred?: boolean;
  /** 写入方式；从列表或面板选出的值要读控件框里显示的文字核对。 */
  adapter?: string;
  /** 自动填写已失败，先处理其他字段；只能由真实回读或用户重试解除。 */
  autoDeferred?: boolean;
  failureCode?: string;
  issue?: ReviewIssue;
  options?: string[];
  controlKind?: 'text' | 'textarea' | 'select' | 'combobox' | 'date' | 'toggle';
  typable?: boolean;
  multiple?: boolean;
  readOnly?: boolean;
  dateFormat?: string;
}

export type ReviewControlMeta = Pick<
  FormReviewEntry,
  'controlKind' | 'typable' | 'multiple' | 'readOnly' | 'dateFormat' | 'options'
>;

export function controlMetaFromState(state: FormControlState): ReviewControlMeta {
  const tag = (state.identity?.tagName ?? '').toLowerCase();
  const controlKind: FormReviewEntry['controlKind'] = state.datePicker
    ? 'date'
    : state.kind === 'select'
      ? 'select'
      : state.popup || state.kind === 'custom'
        ? 'combobox'
        : state.kind === 'toggle'
          ? 'toggle'
          : tag === 'textarea'
            ? 'textarea'
            : 'text';
  return {
    controlKind,
    ...(state.typable !== undefined ? { typable: state.typable } : {}),
    ...(state.multiple !== undefined ? { multiple: state.multiple } : {}),
    ...(controlKind === 'text' || controlKind === 'textarea' ? { readOnly: state.readOnly } : {}),
    ...(state.requirements?.dateFormats?.[0] ? { dateFormat: state.requirements.dateFormats[0] } : {}),
  };
}

function mergeControlMeta(previous?: FormReviewEntry, meta?: ReviewControlMeta): ReviewControlMeta {
  const controlKind = meta?.controlKind ?? previous?.controlKind;
  const typable = meta?.typable ?? previous?.typable;
  const multiple = meta?.multiple ?? previous?.multiple;
  const readOnly = meta?.readOnly ?? previous?.readOnly;
  const dateFormat = meta?.dateFormat ?? previous?.dateFormat;
  const options = meta?.options?.length ? [...meta.options] : previous?.options;
  return {
    ...(controlKind ? { controlKind } : {}),
    ...(typable !== undefined ? { typable } : {}),
    ...(multiple !== undefined ? { multiple } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(dateFormat ? { dateFormat } : {}),
    ...(options?.length ? { options } : {}),
  };
}

type TreeNode = DOMElementNode['children'][number];
const isElement = (node: TreeNode): node is DOMElementNode => 'children' in node;
const treeText = (node: TreeNode): string =>
  isElement(node) ? node.children.map(treeText).join(' ') : node.isVisible && 'text' in node ? String(node.text) : '';
const FORM_ROLES = ['combobox', 'listbox', 'textbox', 'checkbox', 'radio', 'switch', 'spinbutton'];
const isFormControl = (node: DOMElementNode) => {
  if (node.attributes['data-qz-control-part'] === 'true') return false;
  if (node.attributes['data-qz-control'] === 'combobox') return true;
  const tag = (node.tagName ?? '').toLowerCase();
  return (
    (tag === 'input' && (node.attributes.type ?? '').toLowerCase() !== 'hidden') ||
    tag === 'select' ||
    tag === 'textarea' ||
    FORM_ROLES.includes(node.attributes.role ?? '') ||
    ['', 'true'].includes(node.attributes.contenteditable ?? 'false')
  );
};
const hasFormControl = (node: TreeNode): boolean =>
  isElement(node) && (isFormControl(node) || node.children.some(hasFormControl));
const labelElement = (node: TreeNode): DOMElementNode | null => {
  if (!isElement(node)) return null;
  if ((node.tagName ?? '').toLowerCase() === 'label') return node;
  for (const child of node.children) {
    const found = labelElement(child);
    if (found) return found;
  }
  return null;
};
const MEANINGFUL = /[^\s\-–—~～·:：,，.。、/|()（）*＊]/;
const controlCount = (node: TreeNode): number =>
  isElement(node) ? (isFormControl(node) ? 1 : 0) + node.children.reduce((sum, child) => sum + controlCount(child), 0) : 0;

/** 勾选项的说明写在包住它的元素里（常是 <label> 或其外层）：取最近一层只含这一个控件且有文字的祖先。 */
function toggleLabel(node: DOMElementNode): string {
  let current = node.parent;
  for (let depth = 0; current && depth < 4; depth++, current = current.parent) {
    if (controlCount(current) > 1) break;
    const text = treeText(current).replace(/\s+/g, ' ').trim();
    if (MEANINGFUL.test(text)) return text.slice(0, 80);
  }
  return '';
}

/**
 * 结构上的字段标签：很多表单的字段名与输入框隔多层，也不用 for/aria 关联。
 * 自下而上在每层前置兄弟里找最近的 <label>（HTML 语义，主流组件库都用）；遇到别的表单控件就换上一层。
 * 网页不用 <label> 时退回最近一段有意义的文字。下拉自身显示的当前值不在 <label> 里，不会被误认。
 */
function precedingLabel(node: DOMElementNode, mode: 'label' | 'text'): string {
  let current: DOMElementNode | null = node;
  for (let depth = 0; current?.parent && depth < 10; depth++, current = current.parent) {
    const siblings = current.parent.children;
    for (let i = siblings.indexOf(current) - 1; i >= 0; i--) {
      if (hasFormControl(siblings[i])) break;
      const source = mode === 'label' ? labelElement(siblings[i]) : siblings[i];
      if (mode === 'label' && source && isElement(source) && source.attributes.for &&
          source.attributes.for !== node.attributes.id) continue;
      const text = source ? treeText(source).replace(/\s+/g, ' ').trim() : '';
      if (MEANINGFUL.test(text)) return text.replace(/\s*\*+\s*$/, '').slice(0, 80);
    }
  }
  return '';
}

/** Specific input instructions can identify a field even without a separate label. */
function placeholderFieldLabel(placeholder: string | undefined): string {
  const text = placeholder?.trim() ?? '';
  const prompt = /^(?:请(?:输入|填写|选择|搜索)|(?:please\s+)?(?:enter|select|choose|search(?:\s+for)?)\b)\s*[:：]?\s*/iu;
  if (!prompt.test(text)) return '';
  const label = text.replace(prompt, '').trim();
  return MEANINGFUL.test(label) ? label : '';
}

/** Identity comes from observed structure, never a company or field-name dictionary. */
export function formFieldReference(
  state: Pick<PageState, 'url'>,
  node: DOMElementNode,
  index: number,
): FormFieldReference {
  const role = node.attributes.role;
  // 勾选类控件的说明通常紧跟其后；其余控件旁边的文字可能是当前值，不能当标签。
  const toggle = (!role && node.attributes['data-qz-control'] !== 'combobox') || ['checkbox', 'radio', 'switch'].includes(role);
  const tag = (node.tagName ?? '').toLowerCase();
  const checkable =
    (tag === 'input' && ['checkbox', 'radio'].includes((node.attributes.type ?? '').toLowerCase())) ||
    ['checkbox', 'radio', 'switch'].includes(role ?? '');
  const label =
    node.attributes['aria-label'] ||
    (checkable ? toggleLabel(node) : '') ||
    precedingLabel(node, 'label') ||
    placeholderFieldLabel(node.attributes.placeholder) ||
    precedingLabel(node, 'text') ||
    node.attributes.placeholder ||
    (toggle ? meaningfulText(node.parent?.getAllTextTillNextClickableElement(2) ?? '') : '') ||
    (role ? node.attributes['aria-labelledby'] || node.attributes.name || node.attributes.id || role : '') ||
    node.attributes.name ||
    node.tagName ||
    '控件';
  let form = node.parent;
  while (form && form.tagName !== 'form') form = form.parent;
  const group =
    node.attributes.type === 'radio'
      ? JSON.stringify([state.url, node.attributes.form ?? form?.xpath ?? '', node.attributes.name || node.xpath])
      : undefined;
  const legacyKey = JSON.stringify([
    state.url, node.tagName, node.xpath,
    ...['id', 'name', 'type', 'role', 'aria-label', 'placeholder'].map(key => node.attributes[key] ?? ''),
    label,
  ]);
  const stableId = node.attributes['data-qz-field'];
  return {
    key: stableId ? JSON.stringify([state.url, 'data-qz-field', stableId]) : legacyKey,
    legacyKey: stableId ? legacyKey : undefined,
    label: label.slice(0, 180),
    url: state.url,
    index,
    group,
  };
}

function meaningfulText(text: string): string {
  return MEANINGFUL.test(text) ? text : '';
}

export class FormReview {
  private entries = new Map<string, FormReviewEntry>();

  /** Only migrate the same observed control, never merge repeated labels across experience rows. */
  entry(field: FormFieldReference): FormReviewEntry | undefined {
    const current = this.entries.get(field.key);
    const legacy = field.legacyKey ? this.entries.get(field.legacyKey) : undefined;
    if (legacy && !legacy.legacyKey && field.legacyKey !== field.key) {
      this.entries.delete(field.legacyKey!);
      if (!current) this.entries.set(field.key, { ...legacy, ...field });
    }
    return this.entries.get(field.key);
  }

  snapshot(): FormReviewEntry[] {
    return [...this.entries.values()].map(entry => ({ ...entry }));
  }
  restore(entries: FormReviewEntry[]): void {
    this.entries = new Map(entries.map(entry => [entry.key, { ...entry }]));
  }

  recordWrite(
    field: FormFieldReference,
    expectedValue: string,
    result: FormWriteResult,
    required: boolean,
    meta?: ReviewControlMeta,
  ): void {
    const previous = this.entry(field);
    if (field.group && result.status === 'verified' && result.desiredValue === 'true') {
      for (const entry of this.entries.values())
        if (entry.group === field.group && entry.key !== field.key && entry.hasExpectation)
          entry.expectedValue = 'false';
    }
    const resolvedExpected = result.desiredValue ?? expectedValue;
    const semanticAdapted =
      result.status === 'verified' &&
      Boolean(expectedValue.trim()) &&
      Boolean(result.desiredValue?.trim()) &&
      !formValuesEquivalent(expectedValue, result.desiredValue!);
    const requestedValue = semanticAdapted
      ? expectedValue
      : previous?.requestedValue && formValuesEquivalent(resolvedExpected, previous.expectedValue)
        ? previous.requestedValue
        : undefined;
    const baseMessage = semanticAdapted ? `已匹配官网选项「${resolvedExpected}」。` : result.message;
    this.entries.set(field.key, {
      ...mergeControlMeta(previous, { ...meta, options: result.options?.length ? result.options : meta?.options }),
      ...field,
      expectedValue: resolvedExpected,
      ...(requestedValue ? { requestedValue } : {}),
      actualValue: result.actualValue,
      required,
      message: result.ai_inferred ? `按默认规则填写，待核对。${baseMessage}` : baseMessage,
      ai_inferred: result.ai_inferred === true,
      // 年月不足以约束用户后来补充的完整日期，补填后以网页校验为准。
      hasExpectation: !['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(result.code),
      adapter: result.adapter,
      // A field blocked by another field's open popup was never operated; once that
      // popup closes it must stay eligible for the later repair and profile passes.
      autoDeferred:
        ![
          'MISSING_INFORMATION',
          'DATE_PRECISION_REQUIRED',
          'DATE_RANGE_INCOMPLETE',
          'CLICK_TARGET_OBSCURED',
          'PREVIOUS_POPUP_OPEN',
        ].includes(result.code) &&
        result.status !== 'verified' &&
        !(result.status === 'preserved' && formValuesEquivalent(result.actualValue, resolvedExpected)),
      failureCode: result.code,
      issue: result.status === 'verified' ? undefined : reviewIssue({ failureCode: result.code }) ?? 'unverified',
      status:
        result.status === 'verified'
          ? 'filled'
          : result.status === 'preserved' && formValuesEquivalent(result.actualValue, resolvedExpected)
            ? 'preserved'
            : 'failed',
    });
  }

  recordSkip(field: FormFieldReference): void {
    if (field.group)
      for (const entry of this.entries.values())
        if (entry.group === field.group) {
          entry.status = 'skipped';
          entry.message = '用户明确选择跳过该组选项，本轮保留现状。';
        }
    const previous =
      this.entry(field) ??
      (field.group
        ? [...this.entries.values()].find(entry => entry.group === field.group && entry.status === 'skipped')
        : undefined);
    this.entries.set(field.key, {
      ...mergeControlMeta(previous),
      ...field,
      expectedValue: previous?.expectedValue ?? '',
      actualValue: previous?.actualValue ?? '',
      required: previous?.required ?? false,
      status: 'skipped',
      message: '用户明确选择跳过，本轮保留现状。',
    });
  }

  /** 用户选择稍后亲自处理的项：不阻断本轮完成，在报告中提醒。 */
  recordDeferred(
    field: FormFieldReference,
    options?: { adapter?: string; failureCode?: string; message?: string },
  ): void {
    const previous = this.entry(field);
    this.entries.set(field.key, {
      ...mergeControlMeta(previous),
      ...field,
      expectedValue: previous?.expectedValue ?? '',
      actualValue: previous?.actualValue ?? '',
      required: previous?.required ?? false,
      status: 'deferred',
      adapter: options?.adapter ?? previous?.adapter,
      failureCode: options?.failureCode ?? previous?.failureCode,
      message: options?.message ?? '你选择稍后在官网亲自处理。',
    });
  }

  reconcile(field: FormFieldReference, state: FormControlState, required: boolean): void {
    const stateMeta = controlMetaFromState(state);
    const existingEntry = this.entry(field);
    if (existingEntry?.status === 'deferred') {
      const satisfied =
        state.kind === 'toggle'
          ? state.value === 'true'
          : state.kind !== 'unsupported' &&
            hasCommittedControlValue(state) &&
            state.value.trim() !== '';
      if (satisfied) {
        this.entries.set(field.key, {
          ...existingEntry,
          ...mergeControlMeta(existingEntry, stateMeta),
          ...field,
          status: 'filled',
          actualValue: state.value,
          required,
          autoDeferred: false,
          message: state.kind === 'toggle' ? '已确认勾选。' : '已在网页完成填写。',
        });
        return;
      }
      this.entries.set(field.key, {
        ...existingEntry,
        ...mergeControlMeta(existingEntry, stateMeta),
        ...field,
        actualValue: state.value,
        required,
      });
      return;
    }
    const previous =
      this.entry(field) ??
      (field.group
        ? [...this.entries.values()].find(entry => entry.group === field.group && entry.status === 'skipped')
        : undefined);
    const groupSkipped =
      field.group &&
      [...this.entries.values()].some(entry => entry.group === field.group && entry.status === 'skipped');
    if (previous?.status === 'skipped' || groupSkipped) {
      this.entries.set(field.key, {
        ...previous!,
        ...mergeControlMeta(previous, stateMeta),
        ...field,
        status: 'skipped',
        actualValue: state.value,
        required,
      });
      return;
    }
    if (state.kind === 'unsupported' && (state.valid || state.disabled)) {
      if (previous)
        this.entries.set(field.key, {
          ...previous,
          ...field,
          status: 'preserved',
          actualValue: '',
          required: false,
          hasExpectation: false,
          autoDeferred: false,
          message: state.valid ? '用户操作后，控件的原生校验已通过；请核对官网内容。' : '此控件当前不参与必填校验。',
        });
      return;
    }
    const expected = previous?.hasExpectation ? previous.expectedValue : undefined;
    if (state.disabled) {
      if (previous) this.entries.set(field.key, { ...previous, ...field, actualValue: state.value,
        status: 'preserved', required: false, hasExpectation: false, autoDeferred: false,
        message: '此控件当前已禁用，不参与填写；保留网页现状。' });
      return;
    }
    // Pure read-only display inputs without a popup or date picker (e.g. auto-computed major category or age) are not user-editable.
    if (state.kind === 'text' && state.readOnly && !state.popup && !state.datePicker && !required) {
      if (state.value.trim() !== '' && state.valid) {
        this.entries.set(field.key, {
          ...mergeControlMeta(previous, stateMeta),
          ...field,
          status: 'preserved',
          expectedValue: expected ?? '',
          actualValue: state.value,
          required: false,
          hasExpectation: false,
          autoDeferred: false,
          message: '网页自动生成的只读内容，保留现状。',
        });
      } else if (previous?.failureCode === 'OPTIONAL_MISSING') {
        this.entries.delete(field.key);
      }
      return;
    }
    const needsValue = required && !state.disabled;
    const missing = state.kind === 'toggle' ? !state.valid : state.value === '';
    let status: FormReviewEntry['status'] = previous?.status ?? (missing ? 'pending' : 'preserved');
    let message = previous?.message ?? (missing ? '当前未填写。' : '保留网页已有内容，请核对。');
    let issue: ReviewIssue | undefined;
    if (expected === undefined && hasCommittedControlValue(state) && !missing) {
      status = 'preserved';
      message = '已回读当前网页内容，保留用户已有值，请核对。';
    }
    if (!state.valid && (state.pageValidationMessage || (state.valueKnown !== false && state.selectionConfirmed !== false))) {
      status = 'failed';
      issue = needsValue && state.kind !== 'unsupported' && state.valueKnown !== false && state.selectionConfirmed !== false &&
        (state.value === '' || (state.kind === 'toggle' && state.value === 'false')) ? 'missing' : 'invalid';
      message = state.pageValidationMessage || state.validationMessage || '网页原生校验未通过。';
    } else if (state.selectionConfirmed === false && !state.disabled) {
      status = 'failed';
      issue = 'unverified';
      message = '文字尚未对应到已选选项，请完成选择后再核对。';
    } else if (state.valueKnown === false) {
      status = 'failed';
      issue = 'unverified';
      message = '网页尚未提供可确认的控件值，请核对。';
    } else if (expected !== undefined && previous?.status !== 'preserved') {
      if (formValuesEquivalent(state.value, expected)) {
        status = 'filled';
        message = '已按当前网页真实值重新核对。';
      } else {
        status = 'failed';
        issue = state.value === '' ? 'missing' : 'mismatch';
        message = '实际值与拟填写值不一致，需要处理或明确跳过。';
      }
    } else if (needsValue && missing) {
      status = 'pending';
      issue = 'missing';
      message = '网页标记为必填，尚未填写或明确跳过。';
    }
    this.entries.set(field.key, {
      ...mergeControlMeta(previous, stateMeta),
      ...field,
      status,
      issue,
      expectedValue: expected && formValuesEquivalent(state.value, expected) ? state.value : (expected ?? ''),
      ...(status === 'filled' && previous?.requestedValue ? { requestedValue: previous.requestedValue } : {}),
      actualValue: state.value,
      required: needsValue,
      message: (previous?.autoDeferred || ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED', 'OPTIONAL_MISSING'].includes(previous?.failureCode ?? '')) &&
        ['pending', 'failed'].includes(status) && formValuesEquivalent(state.value, previous?.actualValue ?? '')
        ? previous?.message ?? message
        : previous?.ai_inferred && !message.includes('按默认规则填写') ? `按默认规则填写，待核对。${message}` : message,
      ai_inferred: previous?.ai_inferred,
      hasExpectation: expected !== undefined,
      adapter: previous?.adapter,
      autoDeferred: previous?.autoDeferred && !['filled', 'preserved'].includes(status),
      failureCode: ['filled', 'preserved'].includes(status) ? undefined : previous?.failureCode,
    });
  }

  isAutoDeferred(field: FormFieldReference): boolean {
    return this.entry(field)?.autoDeferred === true;
  }

  verifyManualEdit(field: FormFieldReference, state: FormControlState, required: boolean): void {
    const previous = this.entry(field);
    const missing = state.kind === 'toggle' ? !state.valid : state.value === '';
    if (previous && !state.disabled && hasCommittedControlValue(state) && !missing) {
      this.entries.set(field.key, {
        ...previous,
        ...field,
        status: 'filled',
        expectedValue: state.value,
        actualValue: state.value,
        hasExpectation: true,
        autoDeferred: false,
        failureCode: undefined,
      });
    }
    this.reconcile(field, state, required);
  }

  requestRetry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.autoDeferred = false;
    entry.status = 'pending';
    entry.message = '已请求重试，将重新观察后尝试填写。';
  }

  deferFailure(field: FormFieldReference): void {
    const entry = this.entry(field);
    if (entry && entry.status === 'failed') entry.autoDeferred = true;
  }

  unresolved(): FormReviewEntry[] {
    return this.snapshot().filter(entry => entry.status === 'failed' || (entry.required && entry.status === 'pending'));
  }

  /** 该字段上次是从列表或日期面板选出来的。 */
  chosen(field: FormFieldReference): boolean {
    return ['popup-option-click', 'popup-multi-click', 'date-panel'].includes(this.entry(field)?.adapter ?? '');
  }

  isSkipped(field: FormFieldReference): boolean {
    const status = this.entry(field)?.status;
    return (
      status === 'skipped' ||
      status === 'deferred' ||
      Boolean(
        field.group &&
          [...this.entries.values()].some(entry => entry.group === field.group && entry.status === 'skipped'),
      )
    );
  }

  recordFailure(
    field: FormFieldReference,
    message: string,
    required = false,
    options?: string[],
    meta?: { failureCode?: string; autoDeferred?: boolean; issue?: ReviewIssue } & ReviewControlMeta,
  ): void {
    // A later model plan cannot revoke the user's skip/defer decision, including after restore.
    if (this.isSkipped(field)) return;
    const previous = this.entry(field);
    this.entries.set(field.key, {
      ...mergeControlMeta(previous, { ...meta, options: options?.length ? options : meta?.options }),
      ...field,
      status: 'failed',
      required,
      actualValue: previous?.actualValue ?? '',
      expectedValue: previous?.expectedValue ?? '',
      hasExpectation: previous?.hasExpectation,
      adapter: previous?.adapter,
      message,
      autoDeferred: meta?.autoDeferred ?? previous?.autoDeferred,
      failureCode: meta && 'failureCode' in meta ? meta.failureCode : previous?.failureCode,
      issue: meta?.issue ?? reviewIssue({ failureCode: meta?.failureCode }) ?? 'unverified',
    });
  }

  requestInformation(
    field: FormFieldReference,
    message: string,
    required: boolean,
    options?: string[],
    meta?: ReviewControlMeta,
  ): void {
    if (this.isSkipped(field)) return;
    const previous = this.entry(field);
    if (previous?.status === 'filled' && previous.actualValue.trim() !== '' && previous.actualValue !== 'false') {
      return;
    }
    this.recordFailure(field, message, required, options, meta);
    const entry = this.entry(field)!;
    entry.failureCode = 'MISSING_INFORMATION';
    entry.autoDeferred = false;
    entry.hasExpectation = false;
  }

  /** Optional field left blank due to unset profile data: shown as non-blocking reminder without modal prompt. */
  recordOptionalMissing(
    field: FormFieldReference,
    message = '选填项资料未设置，可不填。',
    meta?: ReviewControlMeta,
  ): void {
    if (this.isSkipped(field)) return;
    const previous = this.entry(field);
    if (previous && (previous.status === 'filled' || previous.status === 'preserved')) return;
    this.entries.set(field.key, {
      ...mergeControlMeta(previous, meta),
      ...field,
      status: 'pending',
      required: false,
      actualValue: previous?.actualValue ?? '',
      expectedValue: '',
      hasExpectation: false,
      autoDeferred: false,
      failureCode: 'OPTIONAL_MISSING',
      message,
    });
  }

  /** Remove review state for fields inside an optional section that was expanded and then retracted. */
  removeField(field: FormFieldReference): void {
    this.entries.delete(field.key);
    if (field.legacyKey) this.entries.delete(field.legacyKey);
  }

  /** Drop stale execution failures from controls that the page unmounted on the current URL. */
  pruneDisconnected(url: string, liveKeys: ReadonlySet<string>): void {
    if (!url || !liveKeys.size) return;
    for (const [mapKey, entry] of [...this.entries]) {
      if (entry.url !== url) continue;
      if (liveKeys.has(entry.key) || (entry.legacyKey && liveKeys.has(entry.legacyKey))) continue;
      if (entry.status !== 'failed') continue;
      if (['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED', 'USER_ANSWER_PENDING'].includes(entry.failureCode ?? '')) continue;
      if (
        entry.key.includes('"data-qz-field"') ||
        entry.failureCode === 'STALE_CONTROL' ||
        /控件已移除|控件已变化或移除/.test(entry.message ?? '')
      ) {
        this.entries.delete(mapKey);
      }
    }
  }
}

/** Exact per-field grants survive a failed transport attempt and expire after a verified write. */
export class ReplacementApprovals {
  private grants: { tabId: number; key: string; from: string; to: string }[] = [];
  confirm(tabId: number, key: string, from: string, to: string): void {
    this.grants = this.grants.filter(grant => grant.tabId !== tabId || grant.key !== key);
    this.grants.push({ tabId, key, from, to });
  }
  permits(tabId: number, key: string, from: string, to: string): boolean {
    return this.confirmedFrom(tabId, key, to) === from;
  }
  confirmedFrom(tabId: number, key: string, to: string): string | undefined {
    return this.grants.find(grant => grant.tabId === tabId && grant.key === key && grant.to === to)?.from;
  }
  clearResolved(key: string): void {
    this.grants = this.grants.filter(grant => grant.key !== key);
  }
}
