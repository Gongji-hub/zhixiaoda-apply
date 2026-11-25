import type { FormControlKind, FormControlState } from './formControls';
import { hasCommittedControlValue } from './controlState';
import { ExplorationStopped } from '../controlExploration';

/** A semantic decision needs a user fact; retrying the control cannot supply it. */
export class MissingFormInformationError extends Error {
  constructor(message: string, public readonly options: string[]) {
    super(message);
    this.name = 'MissingFormInformationError';
  }
}

export interface FormWriteResult {
  status: 'verified' | 'preserved' | 'failed';
  ai_inferred?: boolean;
  code: string;
  message: string;
  adapter: string;
  attempts: number;
  actualValue: string;
  desiredValue?: string;
  /** 失败时附带：写入前的值和字段所在表单项的文字，供模型自行判断原因。 */
  observedValue?: string;
  fieldText?: string;
  options?: string[];
  dateDiagnostic?: { formats: string[]; inputPresent: boolean; inputInvalid: boolean; inputMatches: boolean };
}

export interface FormControlDriver {
  read(): Promise<FormControlState>;
  write(attempt: number): Promise<void>;
  adapters: string[];
}

export interface FormWriteRequest {
  kind: FormControlKind;
  expectedIdentity: Record<string, string>;
  observedValue: string;
  desiredValue: string;
  allowReplace?: boolean;
  /** 从列表或日期面板选择时，输入框只读不妨碍写入。 */
  allowReadOnly?: boolean;
  preserveExisting?: boolean;
  signal?: AbortSignal;
  maxAttempts?: number;
}

function checkpoint(signal?: AbortSignal, settleMs = 60): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const abort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, Math.max(60, Math.min(1000, settleMs)));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Two read checkpoints and at most two writes; no semantic field/value inference. */
/** 网页只改了写法（空白、分隔符、日期的年月日写法和补零），内容不变，视为同一个值。 */
function reformatted(actual: string, desired: string): boolean {
  if (actual === desired) return false;
  const strip = (value: string) =>
    value
      .replace(/\s*[×✕✖](?=\s*(?:[,，、\n]|$))/gu, '')
      .replace(/[\s\-./:：]/g, '');
  if (strip(actual) !== '' && strip(actual) === strip(desired)) return true;
  // Number inputs often display thousands groups ("300,000"). Only exact 3-digit
  // groups count, so a list such as "1,2" or a truncated "30,000" never matches.
  const number = (value: string) =>
    /^\s*[+-]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?\s*$/.test(value) ? value.replace(/[\s,，]/g, '') : null;
  if (number(actual) !== null && number(actual) === number(desired)) return true;
  const date = (value: string) =>
    /^\s*\d{4}\D{1,3}\d{1,2}(?:\D{1,3}\d{1,2})?\D{0,2}\s*$/.test(value)
      ? value.match(/\d+/g)!.map((group, i) => (i ? group.padStart(2, '0') : group)).join('-')
      : null;
  return date(actual) !== null && date(actual) === date(desired);
}

export function formValuesEquivalent(actual: string, desired: string): boolean {
  return actual === desired || reformatted(actual, desired);
}

/** A hierarchical picker shows the selected path ("中国 / 北京") while the plan names
 * the chosen leaf. The separator must have spaces so URLs and dates are never split. */
export function displayedValueMatches(actual: string, desired: string): boolean {
  if (formValuesEquivalent(actual, desired)) return true;
  const path = actual.split(/\s+[/／>›]\s+/).map(part => part.trim()).filter(Boolean);
  return path.length > 1 && formValuesEquivalent(path[path.length - 1], desired);
}

export async function writeVerifiedControl(
  driver: FormControlDriver,
  request: FormWriteRequest,
): Promise<FormWriteResult> {
  let state = await driver.read();
  let attempts = 0;
  const result = (status: FormWriteResult['status'], code: string, message: string): FormWriteResult => ({
    status,
    code,
    message: status === 'failed' ? `${message}（拟写入「${request.desiredValue}」，回读为「${state.value || '空'}」）` : message,
    adapter: driver.adapters[Math.max(0, attempts - 1)] ?? '',
    attempts,
    actualValue: state.value,
    desiredValue: request.desiredValue,
    ...(status === 'failed' ? { observedValue: request.observedValue, fieldText: state.context ?? '' } : {}),
  });
  const preflight = (): FormWriteResult | null => {
    if (request.signal?.aborted) return result('failed', 'CANCELLED', '操作已取消。');
    if (
      !state.connected ||
      state.kind !== request.kind ||
      Object.entries(request.expectedIdentity).some(([key, value]) => state.identity[key] !== value)
    )
      return result('failed', 'STALE_CONTROL', '控件已变化或移除，已停止写入。请重新观察页面。');
    return null;
  };
  const writable = (): FormWriteResult | null =>
    state.disabled || (state.readOnly && !request.allowReadOnly)
      ? result('failed', 'READ_ONLY_CONTROL', '控件禁用或只读，请观察其实际可用的交互入口。')
      : null;
  const matchesTarget = (control: FormControlState) => formValuesEquivalent(control.value, request.desiredValue);
  const settled = (first: FormControlState, message: string): FormWriteResult | null => {
    if (!matchesTarget(first) || !matchesTarget(state)) return null;
    if (state.selectionConfirmed === false || state.valueKnown === false)
      return result('failed', 'SELECTION_UNCONFIRMED', '已读到拟填写的内容，但网页尚未确认保存或选中。');
    if (!state.valid) return result('failed', 'VALIDATION_REJECTED', state.validationMessage || '网页校验未通过。');
    if (!hasCommittedControlValue(first)) return null;
    return { ...result('verified', 'VERIFIED', message), desiredValue: state.value };
  };
  let blocked = preflight();
  if (blocked) return blocked;
  if (!formValuesEquivalent(state.value, request.observedValue) && !formValuesEquivalent(state.value, request.desiredValue))
    return result('failed', 'VALUE_CHANGED', '控件内容在观察后已变化，未覆盖新内容。请重新观察。');
  if (hasCommittedControlValue(state) && reformatted(state.value, request.desiredValue))
    return { ...result('verified', 'ALREADY_MATCHED', '当前真实值与拟写入值只有写法不同，无需重复写入。'), desiredValue: state.value };
  if (matchesTarget(state) && state.valueKnown !== false && state.selectionConfirmed !== false)
    return result(
      state.valid ? 'verified' : 'failed',
      state.valid ? 'ALREADY_MATCHED' : 'VALIDATION_REJECTED',
      state.valid ? '当前真实值已匹配，无需重复写入。' : state.validationMessage,
    );
  if (request.preserveExisting !== false && state.selectionConfirmed !== false && state.value !== '' && !formValuesEquivalent(state.value, request.desiredValue) && !request.allowReplace)
    return result(
      'preserved',
      'EXISTING_VALUE_PRESERVED',
      '控件已有真实内容，未覆盖。请先 ask_user 确认，确认后才可替换。',
    );
  blocked = writable();
  if (blocked) return blocked;
  const maxAttempts = Math.min(2, request.maxAttempts ?? 2);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts = attempt + 1;
    try {
      blocked = preflight();
      if (blocked) return blocked;
      blocked = writable();
      if (blocked) return blocked;
      await driver.write(attempt);
      if (state.settleMs) await checkpoint(request.signal, state.settleMs);
      state = await driver.read();
      blocked = preflight();
      if (blocked) return blocked;
      const first = state;
      await checkpoint(request.signal);
      blocked = preflight();
      if (blocked) return blocked;
      state = await driver.read();
      blocked = preflight();
      if (blocked) return blocked;
      const verified = settled(first, '写入后两次回读真实值一致。');
      if (verified) return verified;
      // A changing value is not a stable target for an automatic retry.
      if (!formValuesEquivalent(state.value, first.value))
        return result('failed', 'VALUE_CHANGED', '写入后控件值仍在变化，已停止重试。请重新观察。');
    } catch (error) {
      if (error instanceof ExplorationStopped) return result('failed', error.code, error.message);
      if (request.signal?.aborted) return result('failed', 'CANCELLED', '操作已取消。');
      state = await driver.read();
      blocked = preflight();
      if (blocked) return blocked;
      if (error instanceof MissingFormInformationError)
        return { ...result('failed', 'MISSING_INFORMATION', error.message), options: error.options };
      const errorMessage = error instanceof Error ? error.message : '控件写入失败。';
      if (errorMessage.includes('CLICK_TARGET_OBSCURED'))
        return result('failed', 'CLICK_TARGET_OBSCURED', errorMessage.replace(/^CLICK_TARGET_OBSCURED:\s*/, ''));
      // Never repeat a write that already committed despite a transport error.
      if (matchesTarget(state)) {
        const first = state;
        await checkpoint(request.signal, state.settleMs);
        blocked = preflight();
        if (blocked) return blocked;
        state = await driver.read();
        blocked = preflight();
        if (blocked) return blocked;
        const verified = settled(first, '写入响应异常，但两次回读真实值已匹配。');
        if (verified) return verified;
      }
      if (attempt === maxAttempts - 1)
        return result('failed', 'WRITE_FAILED', error instanceof Error ? error.message : '控件写入失败。');
    }
    if (!formValuesEquivalent(state.value, request.observedValue) && !formValuesEquivalent(state.value, request.desiredValue)) {
      // Our write changed the field and two reads agree, but the site shows another
      // wording (e.g. a formatter). Whether it is the same fact is a semantic judgement
      // for the Agent, not a failure to retry or explore.
      if (state.valid && hasCommittedControlValue(state) && state.value.trim())
        return result('failed', 'READBACK_DIFFERS', '已写入，网页显示的写法与拟填写值不同，待判定是否等同。');
      return result('failed', 'VALUE_CHANGED', '写入后出现新的实际内容，未用备用方式覆盖。请重新观察。');
    }
    const beforeRetry = state;
    state = await driver.read();
    blocked = preflight();
    if (blocked) return blocked;
    if (!formValuesEquivalent(state.value, beforeRetry.value) && !matchesTarget(state))
      return result('failed', 'VALUE_CHANGED', '重试前控件内容已变化，未覆盖新内容。请重新观察。');
    const verified = settled(beforeRetry, '控件真实值已匹配。');
    if (verified) return verified;
    if (matchesTarget(state)) {
      // A delayed commitment or a provisional matching value never authorizes a second click.
      const first = state;
      await checkpoint(request.signal, state.settleMs);
      state = await driver.read();
      return preflight() ?? settled(first, '网页延迟保存后，两次回读真实值一致。') ??
        result('failed', 'VERIFY_FAILED', '网页尚未稳定保存本次填写，请核对。');
    }
  }
  // 回读仍是写入前的值：网页没有接受这个值（常见于格式或选项限制），原因交给模型结合 fieldText 判断。
  return formValuesEquivalent(state.value, request.observedValue)
    ? result('failed', 'NOT_ACCEPTED', '网页没有保留写入的值，回读仍为写入前的内容，已停止当前批次。')
    : result('failed', 'VERIFY_FAILED', '写入后回读与拟写入值不一致，已停止当前批次。');
}
