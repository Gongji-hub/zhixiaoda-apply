import type { FormControlKind, FormControlState } from './formControls';

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
  const strip = (value: string) => value.replace(/[\s\-./:：]/g, '');
  if (strip(actual) !== '' && strip(actual) === strip(desired)) return true;
  const date = (value: string) =>
    /^\s*\d{4}\D{1,3}\d{1,2}(?:\D{1,3}\d{1,2})?\D{0,2}\s*$/.test(value)
      ? value.match(/\d+/g)!.map((group, i) => (i ? group.padStart(2, '0') : group)).join('-')
      : null;
  return date(actual) !== null && date(actual) === date(desired);
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
  let blocked = preflight();
  if (blocked) return blocked;
  if (state.value !== request.observedValue && state.value !== request.desiredValue)
    return result('failed', 'VALUE_CHANGED', '控件内容在观察后已变化，未覆盖新内容。请重新观察。');
  if (state.value === request.desiredValue && state.selectionConfirmed !== false)
    return result(
      state.valid ? 'verified' : 'failed',
      state.valid ? 'ALREADY_MATCHED' : 'VALIDATION_REJECTED',
      state.valid ? '当前真实值已匹配，无需重复写入。' : state.validationMessage,
    );
  if (state.valid && reformatted(state.value, request.desiredValue))
    return { ...result('verified', 'ALREADY_MATCHED', '当前真实值与拟写入值只有写法不同，无需重复写入。'), desiredValue: state.value };
  if (request.preserveExisting !== false && state.selectionConfirmed !== false && state.value !== '' && state.value !== request.desiredValue && !request.allowReplace)
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
      const firstValue = state.value;
      await checkpoint(request.signal);
      blocked = preflight();
      if (blocked) return blocked;
      state = await driver.read();
      blocked = preflight();
      if (blocked) return blocked;
      if (state.value === firstValue && state.valid && reformatted(state.value, request.desiredValue))
        return { ...result('verified', 'VERIFIED', `网页把写入值规整为「${state.value}」，内容一致。`), desiredValue: state.value };
      if (state.value === request.desiredValue && firstValue === request.desiredValue)
        return result(
          state.valid ? 'verified' : 'failed',
          state.valid ? 'VERIFIED' : 'VALIDATION_REJECTED',
          state.valid ? '写入后两次回读真实值一致。' : state.validationMessage || '网页校验未通过。',
        );
      // A changing value is not a stable target for an automatic retry.
      if (state.value !== firstValue)
        return result('failed', 'VALUE_CHANGED', '写入后控件值仍在变化，已停止重试。请重新观察。');
    } catch (error) {
      if (request.signal?.aborted) return result('failed', 'CANCELLED', '操作已取消。');
      state = await driver.read();
      blocked = preflight();
      if (blocked) return blocked;
      // Never repeat a write that already committed despite a transport error.
      if (state.value === request.desiredValue) {
        await checkpoint(request.signal, state.settleMs);
        blocked = preflight();
        if (blocked) return blocked;
        state = await driver.read();
        blocked = preflight();
        if (blocked) return blocked;
        if (state.value === request.desiredValue && state.valid)
          return result('verified', 'VERIFIED', '写入响应异常，但两次回读真实值已匹配。');
      }
      if (attempt === maxAttempts - 1)
        return result('failed', 'WRITE_FAILED', error instanceof Error ? error.message : '控件写入失败。');
    }
    if (state.value !== request.observedValue && state.value !== request.desiredValue)
      return result('failed', 'VALUE_CHANGED', '写入后出现新的实际内容，未用备用方式覆盖。请重新观察。');
    const lastValue = state.value;
    state = await driver.read();
    blocked = preflight();
    if (blocked) return blocked;
    if (state.value !== lastValue && state.value !== request.desiredValue)
      return result('failed', 'VALUE_CHANGED', '重试前控件内容已变化，未覆盖新内容。请重新观察。');
    if (state.value === request.desiredValue && state.valid)
      return result('verified', 'VERIFIED', '控件真实值已匹配。');
  }
  // 回读仍是写入前的值：网页没有接受这个值（常见于格式或选项限制），原因交给模型结合 fieldText 判断。
  return state.value === request.observedValue
    ? result('failed', 'NOT_ACCEPTED', '网页没有保留写入的值，回读仍为写入前的内容，已停止当前批次。')
    : result('failed', 'VERIFY_FAILED', '写入后回读与拟写入值不一致，已停止当前批次。');
}
