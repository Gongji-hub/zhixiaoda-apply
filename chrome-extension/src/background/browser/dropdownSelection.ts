import { createLogger } from '@src/background/log';
import type { DOMElementNode } from './dom/views';
import { cascaderLeafMatch, chooseOption } from './dropdownChoice';
import { customDropdown } from './dropdownOptions';
import type { FormControlState } from './formControls';
import { readLiveControl, rememberFormSelection, writeFormText } from './formControls';
import {
    formValuesEquivalent,
    MissingFormInformationError,
    writeVerifiedControl,
    type FormWriteRequest,
    type FormWriteResult,
} from './formFill';
import type { ApplicationControlOptions } from './page';
import type { PageDriver } from './pageDriver';
import { applicationControl } from './pageInspection';
import { selectNativeOption } from './textControls';

const logger = createLogger('Page');

export async function getDropdownOptions(
  driver: PageDriver,
  index: number,
): Promise<Array<{ index: number; text: string; value: string }>> {
  const selectorMap = driver.page.getSelectorMap();
  const element = selectorMap?.get(index);

  if (!element || !driver.puppeteer) {
    throw new Error('Element not found or puppeteer is not connected');
  }

  try {
    // Get the element handle using the element's selector
    const elementHandle = await driver.page.locateElement(element);
    if (!elementHandle) {
      throw new Error('Dropdown element not found');
    }

    // Evaluate the select element to get all options
    const options = await elementHandle.evaluate(select => {
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error('Element is not a select element');
      }

      return Array.from(select.options).map(option => ({
        index: option.index,
        text: option.text, // Not trimming to maintain exact match for selection
        value: option.value,
      }));
    });

    if (!options.length) {
      throw new Error('No options found in dropdown');
    }

    return options;
  } catch (error) {
    throw new Error(`Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function selectDropdownOption(
  driver: PageDriver,
  index: number,
  text: string,
  options: ApplicationControlOptions = {},
): Promise<string | FormWriteResult> {
  const selectorMap = driver.page.getSelectorMap();
  const element = selectorMap?.get(index);

  if (!element || !driver.puppeteer) {
    throw new Error('Element not found or puppeteer is not connected');
  }

  if (driver.config.applyTargetOrigin) return selectNativeOption(driver, element, text, options);

  logger.debug(`Attempting to select '${text}' from dropdown`);
  logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
  logger.debug(`Element tag: ${element.tagName}`);

  // Validate that we're working with a select element
  if (element.tagName?.toLowerCase() !== 'select') {
    const msg = `Cannot select option: Element with index ${index} is a ${element.tagName}, not a SELECT`;
    logger.error(msg);
    throw new Error(msg);
  }

  try {
    // Get the element handle using the element's selector
    const elementHandle = await driver.page.locateElement(element);
    if (!elementHandle) {
      throw new Error(`Dropdown element with index ${index} not found`);
    }

    // Verify dropdown and select option in one call
    const result = await elementHandle.evaluate(
      (select, optionText, elementIndex) => {
        if (!(select instanceof HTMLSelectElement)) {
          return {
            found: false,
            message: `Element with index ${elementIndex} is not a SELECT`,
          };
        }

        const options = Array.from(select.options);
        const option = options.find(opt => opt.text.trim() === optionText);

        if (!option) {
          const availableOptions = options.map(o => o.text.trim()).join('", "');
          return {
            found: false,
            message: `Option "${optionText}" not found in dropdown element with index ${elementIndex}. Available options: "${availableOptions}"`,
          };
        }

        // Set the value and dispatch events
        const previousValue = select.value;
        select.value = option.value;

        // Only dispatch events if the value actually changed
        if (previousValue !== option.value) {
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
        }

        return {
          found: true,
          message: `Selected option "${optionText}" with value "${option.value}"`,
        };
      },
      text,
      index,
    );

    logger.debug('Selection result:', result);
    // whether found or not, return the message
    return result.message;
  } catch (error) {
    const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }
}

/**
 * 多选：逐个选中 items 里还没选上的项，最后回读控件框，确认每一项都在。只增加，不取消已有选择；
 * 已有选择里有资料之外的内容时不改动，交给用户确认。
 */

export async function selectCustomOptions(
  driver: PageDriver,
  node: DOMElementNode,
  items: string[],
  options: ApplicationControlOptions = {},
): Promise<FormWriteResult> {
  const { element } = await applicationControl(driver, node);
  const read = async () => {
    await driver.checkTarget();
    return readLiveControl(element, true);
  };
  const norm = (value: string) => value.replace(/\s*[×✕✖](?=\s*(?:[,，、\n]|$))/gu, '').replace(/\s+/g, '');
  const resolvedItems = [...items];
  const desiredValue = items.join('、');
  const initial = await read();
  const result = (
    status: FormWriteResult['status'],
    code: string,
    message: string,
    actualValue: string,
    attempts: number,
  ): FormWriteResult => ({
    status,
    code,
    message,
    adapter: 'popup-multi-click',
    attempts,
    actualValue,
    desiredValue,
    ...(status === 'failed' ? { observedValue: initial.value, fieldText: initial.context ?? '' } : {}),
  });
  if (initial.disabled) return result('failed', 'READ_ONLY_CONTROL', '控件已禁用。', initial.value, 0);
  const contains = (state: FormControlState, item: string) =>
    state.selectionConfirmed !== false &&
    (state.selectedValues
      ? state.selectedValues.some(value => norm(value) === norm(item))
      : norm(state.value).includes(norm(item)));
  const missing = items.filter(item => !contains(initial, item));
  // 核对清单以控件实际显示的样子为准（标签之间的分隔各网站不同）。
  if (!missing.length && initial.valid)
    return {
      ...result('verified', 'ALREADY_MATCHED', '这些选项都已选中。', initial.value, 0),
      desiredValue: initial.value,
    };
  if (options.observedValue !== undefined && initial.value !== options.observedValue)
    return result('failed', 'VALUE_CHANGED', '选项在观察后已变化，保留当前选择。', initial.value, 0);
  const others =
    initial.selectionConfirmed === false
      ? ''
      : items.reduce((rest, item) => rest.split(norm(item)).join(''), norm(initial.value));
  if (/[^\s×xX+\d,，、|/]/.test(others) && !options.allowReplace)
    return result(
      'preserved',
      'EXISTING_VALUE_PRESERVED',
      '字段里已有资料之外的选择，未改动。需要时先 ask_user 确认。',
      initial.value,
      0,
    );
  let attempts = 0;
  try {
    for (const item of missing) {
      if (options.signal?.aborted) throw new Error('操作已取消。');
      attempts++;
      let selected: string;
      if (node.tagName?.toLowerCase() === 'select') {
        const choices = await element.evaluate(el =>
          Array.from((el as HTMLSelectElement).options)
            .filter(
              option =>
                !option.disabled &&
                !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) &&
                option.value !== '',
            )
            .map(option => ({ text: option.text.trim(), value: option.value, selected: option.selected })),
        );
        selected =
          choices.find(option => formValuesEquivalent(option.text, item))?.text ??
          (await options.resolveOption?.({
            requested: item,
            candidates: choices.map(option => option.text),
            fieldText: initial.context ?? '',
          })) ??
          '';
        const match = choices.find(option => option.text === selected);
        if (!match) throw new Error('没有找到适用的选项。');
        options.signal?.throwIfAborted();
        await element.select(
          ...new Set([...choices.filter(option => option.selected).map(option => option.value), match.value]),
        );
      } else {
        selected = await chooseOption(driver, element, item, options.signal, options.resolveOption, options.traceDropdown);
      }
      resolvedItems[items.indexOf(item)] = selected;
      await new Promise(resolve => setTimeout(resolve, Math.max(200, initial.settleMs ?? 0)));
    }
  } catch (error) {
    if (error instanceof MissingFormInformationError)
      return {
        ...result('failed', 'MISSING_INFORMATION', error.message, (await read()).value, attempts),
        options: error.options,
      };
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('CLICK_TARGET_OBSCURED'))
      return result(
        'failed',
        'CLICK_TARGET_OBSCURED',
        errorMessage.replace(/^CLICK_TARGET_OBSCURED:\s*/, ''),
        (await read()).value,
        attempts,
      );
    return result('failed', 'WRITE_FAILED', errorMessage, (await read()).value, attempts);
  }
  const after = await read();
  const absent = resolvedItems.filter(item => !contains(after, item));
  if (!after.valid) return result('failed', 'VALIDATION_REJECTED', after.validationMessage, after.value, attempts);
  return absent.length
    ? result('failed', 'VERIFY_FAILED', `回读控件里没有：${absent.join('、')}。`, after.value, attempts)
    : {
        ...result('verified', 'VERIFIED', '每个选项都已出现在控件里。', after.value, attempts),
        desiredValue: after.value,
      };
}

/**
 * 一步选完自定义下拉：在写入核验流程内点开字段、找到选项、真实点击，再回读。
 * 选项归属优先用网页声明的 aria-controls/aria-owns；未声明时只认点开后新出现、紧贴该字段的选项。
 * 能输入的下拉先输入文字筛选，只读的长列表在弹层内有限次滚动。没有同名项时由注入的 Agent 判断真实候选。
 */

export async function selectCustomOption(
  driver: PageDriver,
  node: DOMElementNode,
  text: string,
  options: ApplicationControlOptions = {},
): Promise<FormWriteResult> {
  const { element, identity } = await applicationControl(driver, node);
  if ((await readLiveControl(element, false)).datePicker)
    return driver.page.pickApplicationDate(node, text, options);
  await element.evaluate(rememberFormSelection, null);
  // 选择后的值常显示在输入框旁边：一律读控件框里显示的值。
  const read = async () => {
    await driver.checkTarget();
    return readLiveControl(element, true);
  };
  const initial = await read();
  if (initial.valueKnown === false || !['custom', 'text'].includes(initial.kind))
    return {
      status: 'failed',
      code: 'UNVERIFIABLE_CUSTOM_CONTROL',
      message: '无法可靠读取字段值。',
      adapter: '',
      attempts: 0,
      actualValue: initial.value,
      desiredValue: text,
    };
  // 没有下拉标记的输入框也可以从紧贴它弹出的列表里选；多选需要另外的交互，不在这里处理。
  if (initial.multiple)
    return {
      status: 'failed',
      code: 'UNVERIFIABLE_CUSTOM_CONTROL',
      message: '这是多选控件，请改用多选方式（select_multiple_options / how=choose_many）。',
      adapter: '',
      attempts: 0,
      actualValue: initial.value,
      desiredValue: text,
    };
  const request: FormWriteRequest = {
    kind: initial.kind,
    expectedIdentity: identity,
    observedValue: options.observedValue ?? initial.value,
    desiredValue: text,
    allowReplace: options.allowReplace,
    allowReadOnly: true,
    signal: options.signal,
    maxAttempts: 1,
  };
  let collectedOptions: string[] | undefined;
  if (
    initial.selectionConfirmed !== false &&
    initial.value.trim() !== '' &&
    cascaderLeafMatch(initial.value, text) &&
    !options.allowReplace
  ) {
    request.desiredValue = initial.value;
  }
  // Align with native <select>: inspect candidates before flagging EXISTING_VALUE_PRESERVED so official aliases match without mutating initial.value.
  if (
    initial.selectionConfirmed !== false &&
    initial.value.trim() !== '' &&
    !formValuesEquivalent(initial.value, request.desiredValue) &&
    !options.allowReplace &&
    options.resolveOption
  ) {
    const dropdown = await customDropdown(driver, element, text, options.signal);
    let wasOpen = false;
    let openedDropdown = false;
    let typedQuery = false;
    try {
      const before = await dropdown.listed();
      wasOpen = before.open;
      if (wasOpen || initial.popup || dropdown.adapted || dropdown.declared) {
        const canFilterSafely =
          dropdown.typable && (await dropdown.search!.evaluate(s => (s as HTMLInputElement).value === ''));
        if (!wasOpen) openedDropdown = true;
        let state = wasOpen ? before : await dropdown.open(canFilterSafely);
        const candidates = new Set(state.options);
        if (!state.matches && canFilterSafely) {
          typedQuery = true;
          options.signal?.throwIfAborted();
          await dropdown.search!.evaluate(writeFormText, '');
          options.signal?.throwIfAborted();
          await dropdown.search!.type(text, { delay: 20 });
          for (let poll = 0; poll < 15 && !state.matches; poll++) {
            await dropdown.wait(150);
            state = await dropdown.listed();
            state.options.forEach(option => candidates.add(option));
          }
          if (!state.matches && !state.options.length) {
            options.signal?.throwIfAborted();
            await dropdown.search!.evaluate(writeFormText, '');
            await dropdown.wait(200);
            state = await dropdown.listed();
            state.options.forEach(option => candidates.add(option));
          }
        }
        if (!state.matches) {
          state = await dropdown.rewind(state);
          state.options.forEach(option => candidates.add(option));
        }
        for (let round = 0; round < 40 && !state.matches; round++) {
          const next = await dropdown.scroll(state);
          if (!next) break;
          state = next;
          state.options.forEach(option => candidates.add(option));
        }
        if (candidates.size > 0 && ![...candidates].some(candidate => formValuesEquivalent(candidate, text))) {
          collectedOptions = [...candidates];
          const selected = await options.resolveOption({
            requested: text,
            candidates: [...candidates],
            fieldText: initial.context ?? '',
          });
          if (selected !== null && candidates.has(selected)) {
            request.desiredValue = selected;
          }
        }
      }
    } catch {
      /* Pre-inspection is best-effort; preserve existing value via writeVerifiedControl on failure. */
    } finally {
      if (typedQuery && dropdown.search && !options.signal?.aborted) {
        options.signal?.throwIfAborted();
        await dropdown.search.evaluate(writeFormText, '').catch(() => undefined);
      }
      if (openedDropdown && !wasOpen) {
        await dropdown.close().catch(() => undefined);
      } else if (wasOpen && !options.signal?.aborted) {
        await element
          .evaluate(el => {
            const active = el.ownerDocument.activeElement;
            if (active && (active === el || el.contains(active))) (active as HTMLElement).blur();
          })
          .catch(() => undefined);
      }
      await dropdown.searchHandle.dispose();
    }
  }
  const res = await writeVerifiedControl(
    {
      read,
      adapters: ['popup-option-click'],
      write: async () => {
        try {
          request.desiredValue = await chooseOption(
            driver,
            element,
            text,
            options.signal,
            options.resolveOption
              ? async evidence => {
                  collectedOptions = evidence.candidates;
                  const selected = await options.resolveOption!(evidence);
                  if (selected !== null && evidence.candidates.includes(selected)) request.desiredValue = selected;
                  return selected;
                }
              : undefined,
            options.traceDropdown,
          );
        } catch (err) {
          const opts = (err as { options?: string[] })?.options;
          if (opts?.length) collectedOptions = opts;
          throw err;
        }
      },
    },
    request,
  );
  options.traceDropdown?.('最终核验', `${res.status === 'verified' ? '通过' : res.status === 'preserved' ? '保留当前值' : '未通过'} · ${res.code}`);
  return collectedOptions?.length ? { ...res, options: collectedOptions } : res;
}
