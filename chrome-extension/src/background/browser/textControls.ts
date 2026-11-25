import { createLogger } from '@src/background/log';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { DOMElementNode } from './dom/views';
import { cascaderLeafMatch } from './dropdownChoice';
import { waitForElementStability } from './elementLocation';
import {
    applicationSubmitGuard,
    commitFormControl,
    nearbyOptions,
    ownedOptions,
    pickNearbyOption,
    pickOwnedOption,
    readLiveControl,
    rememberFormSelection,
    resolveSelectChoice,
    validateFormText,
    writeFormSelect,
    writeFormText,
    writeMainWorldComponentState,
} from './formControls';
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
import { popupVisibilityGuard } from './popupVisibility';

const logger = createLogger('Page');

export async function inputTextElementNode(
  driver: PageDriver,
  useVision: boolean,
  elementNode: DOMElementNode,
  text: string,
  options: ApplicationControlOptions = {},
): Promise<void | FormWriteResult> {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer is not connected');
  }

  if (driver.config.applyTargetOrigin) return inputApplicationText(driver, elementNode, text, options);

  try {
    // Highlight before typing
    // if (elementNode.highlightIndex != null) {
    //   await driver.refreshState(useVision, elementNode.highlightIndex);
    // }

    const element = await driver.page.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Ensure element is ready for input
    try {
      // First wait for element stability
      await waitForElementStability(element, 1500);

      // Then check visibility and scroll into view if needed
      const isHidden = await element.isHidden();
      if (!isHidden) {
        await driver.scrollIntoView(element, 1500);
      }
    } catch (e) {
      // Continue even if these operations fail
      logger.debug(`Non-critical error preparing element: ${e}`);
    }

    // Get element properties to determine input method
    const tagName = await element.evaluate(el => el.tagName.toLowerCase());
    const isContentEditable = await element.evaluate(el => {
      if (el instanceof HTMLElement) {
        return el.isContentEditable;
      }
      return false;
    });
    const isReadOnly = await element.evaluate(el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return el.readOnly;
      }
      return false;
    });
    const isDisabled = await element.evaluate(el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return el.disabled;
      }
      return false;
    });

    // Choose appropriate input method based on element properties
    if ((isContentEditable || tagName === 'input') && !isReadOnly && !isDisabled) {
      // Clear content and set value directly
      await element.evaluate(el => {
        if (el instanceof HTMLElement) {
          el.textContent = '';
        }
        if ('value' in el) {
          (el as HTMLInputElement).value = '';
        }
        // Dispatch events
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Type the text with a small delay between keypresses
      await element.type(text, { delay: driver.config.applyTargetOrigin ? 0 : 50 });
    } else {
      // Use direct value setting for other types of elements
      await element.evaluate((el, value) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = value;
        } else if (el instanceof HTMLElement && el.isContentEditable) {
          el.textContent = value;
        }
        // Dispatch events
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, text);
    }

    // Wait for page stability after input
    await driver.page.waitForPageAndFramesLoad();
  } catch (error) {
    const errorMsg = `Failed to input text into element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
}

export async function inputApplicationText(
  driver: PageDriver,
  node: DOMElementNode,
  text: string,
  options: ApplicationControlOptions,
): Promise<FormWriteResult> {
  const { element, identity } = await applicationControl(driver, node);
  const read = async () => {
    await driver.checkTarget();
    return readLiveControl(element, false);
  };
  const initial = await read();
  if (initial.datePicker) return driver.page.pickApplicationDate(node, text, options);
  if (initial.popup && initial.choicePolicy !== 'free_text')
    return driver.page.selectCustomOption(node, text, options);
  if (!['text', 'contenteditable'].includes(initial.kind) && !(initial.kind === 'custom' && initial.choicePolicy === 'free_text'))
    return {
      status: 'failed',
      code: 'UNSUPPORTED_CONTROL',
      message: '此控件不支持文本赋值，请观察其真实交互方式。',
      adapter: '',
      attempts: 0,
      actualValue: '',
    };
  const inputHandle = initial.kind === 'custom' ? await element.evaluateHandle(el => {
    const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('input')).filter(input =>
      ['text', 'search'].includes(input.type) && !input.disabled && !input.readOnly);
    return inputs.length === 1 ? inputs[0] : null;
  }) : null;
  const textElement = (inputHandle?.asElement() as ElementHandle | null) ?? (inputHandle ? null : element);
  if (!textElement) {
    await inputHandle?.dispose();
    return { status: 'failed', code: 'UNSUPPORTED_CONTROL', message: '没有唯一可输入的控件。', adapter: '', attempts: 0, actualValue: initial.value };
  }
  const validation = await textElement.evaluate(validateFormText, text);
  if (!validation.valid) {
    await inputHandle?.dispose();
    return {
      status: 'failed',
      code: 'VALIDATION_REJECTED',
      message: validation.message,
      adapter: 'native-setter',
      attempts: 0,
      actualValue: initial.value,
    };
  }
  const isLookupCandidate =
    initial.kind === 'text' &&
    (node.tagName ?? '').toLowerCase() === 'input' &&
    ['', 'text', 'search'].includes((initial.requirements?.inputType ?? 'text').toLowerCase());
  const declaredLookup = isLookupCandidate
    ? await element.evaluate(el => Boolean(el.getAttribute('aria-controls') || el.getAttribute('aria-owns')))
    : false;
  const revealPopup = popupVisibilityGuard(driver, element, options.signal, 'dropdown');
  const lookup = async (label: string) => {
    const owned = await element.evaluate(ownedOptions, label);
    if (owned.open || declaredLookup) return { kind: 'owned' as const, ...owned };
    const nearby = await element.evaluate(nearbyOptions, label);
    return { kind: 'nearby' as const, ...nearby };
  };
  const readLookupPopup = async (label = text) => {
    const popup = await lookup(label);
    if (popup.open && !(initial.popup && initial.choicePolicy === 'free_text') &&
      !(await textElement.evaluate(el => Boolean((el as HTMLInputElement).list))))
      // Mark the query before layout recovery: a scrolling/transport failure
      // must never turn this temporary input value into a verified write.
      await element.evaluate(rememberFormSelection, null);
    return revealPopup(() => lookup(label));
  };
  const request: FormWriteRequest = {
    kind: initial.kind,
    expectedIdentity: identity,
    observedValue: options.observedValue ?? node.attributes.value ?? '',
    desiredValue: text,
    allowReplace: options.allowReplace,
    signal: options.signal,
  };
  return writeVerifiedControl(
    {
      read,
      adapters: ['native-setter', 'keyboard'],
      write: async attempt => {
        await driver.checkTarget();
        if (options.signal?.aborted) throw new Error('操作已取消。');
        await driver.reveal(element);
        // A popup may already be open before typing. It still constrains the value.
        if (attempt === 0) await textElement.evaluate(writeFormText, text);
        else {
          await textElement.evaluate(writeFormText, '');
          if (options.signal?.aborted) throw new Error('操作已取消。');
          await textElement.type(text, { delay: 0 });
          if ((await read()).choicePolicy === 'free_text')
            await textElement.evaluate(writeMainWorldComponentState, text).catch(() => false);
        }
        if (options.signal?.aborted) throw new Error('操作已取消。');
        // Plain inputs without role="combobox" can still spawn a mandatory suggestion popup on input and clear on blur.
        let clickedSuggestion = false;
        if (isLookupCandidate && text.trim() !== '') {
          await new Promise(resolve => setTimeout(resolve, 120));
          if (options.signal?.aborted) throw new Error('操作已取消。');
          const popupAfter = await readLookupPopup(text);
          if (popupAfter.open && popupAfter.options.length > 0) {
            // Seeing a popup proves this is more than an ordinary text input.
            // A native datalist or explicit free-input component keeps its contract.
            const freeInput = (initial.popup && initial.choicePolicy === 'free_text') ||
              await textElement.evaluate(el => Boolean((el as HTMLInputElement).list));
            if (!freeInput) await element.evaluate(rememberFormSelection, null);
            const eq = popupAfter.options.filter(candidate => formValuesEquivalent(candidate, text));
            const leaf =
              eq.length === 1 ? [] : popupAfter.options.filter(candidate => cascaderLeafMatch(candidate, text));
            let chosen: string | null =
              popupAfter.matches === 1 ? text : eq.length === 1 ? eq[0] : leaf.length === 1 ? leaf[0] : null;
            if (chosen === null && options.resolveOption) {
              chosen = await options.resolveOption({
                requested: text,
                candidates: popupAfter.options,
                fieldText: initial.context ?? '',
              });
              if (options.signal?.aborted) throw new Error('操作已取消。');
            }
            if (chosen !== null && popupAfter.options.includes(chosen)) {
              const fresh = await readLookupPopup(chosen);
              if (fresh.matches !== 1) throw new Error('候选已变化，请重新观察。');
              const finder = popupAfter.kind === 'owned' ? pickOwnedOption : pickNearbyOption;
              const handle = await element.evaluateHandle(finder, chosen);
              const optEl = handle.asElement() as ElementHandle | null;
              if (optEl) {
                try {
                  await driver.waitForClickTarget(optEl, options.signal);
                  await optEl.evaluate(applicationSubmitGuard, 'start' as const);
                  let blocked = false;
                  try {
                    await optEl.click();
                  } finally {
                    blocked = await optEl.evaluate(applicationSubmitGuard, 'stop' as const);
                  }
                  if (blocked) throw new Error('点击会触发表单提交，已阻止。');
                  await new Promise(resolve => setTimeout(resolve, 150));
                  const live = await readLiveControl(element, true);
                  if (formValuesEquivalent(live.value, chosen) && !(await readLookupPopup()).open) {
                    await element.evaluate(rememberFormSelection, live.value);
                    request.desiredValue = live.value;
                  }
                  clickedSuggestion = true;
                } finally {
                  await optEl.dispose();
                }
              } else {
                await handle.dispose();
              }
            }
            if (!clickedSuggestion && !freeInput) {
              await textElement.evaluate(commitFormControl, false);
              throw new MissingFormInformationError('没有确认到可用候选，也没有允许自定义输入的依据，请核对此字段。', popupAfter.options);
            }
          }
        }
        if (!clickedSuggestion) {
          await textElement.evaluate(commitFormControl, attempt === 0);
          if (isLookupCandidate && text.trim() !== '') {
            await new Promise(resolve => setTimeout(resolve, 220));
          }
        }
      },
    },
    request,
  ).finally(() => inputHandle?.dispose());
}

export async function selectNativeOption(
  driver: PageDriver,
  node: DOMElementNode,
  text: string,
  options: ApplicationControlOptions,
): Promise<FormWriteResult> {
  const { element, identity } = await applicationControl(driver, node);
  let choice = await element.evaluate(resolveSelectChoice, text);
  let collectedOptions: string[] | undefined;
  if (!choice.found) {
    const candidates = await element.evaluate(el =>
      Array.from((el as HTMLSelectElement).options)
        .filter(option => !option.disabled && !option.parentElement?.hasAttribute('disabled'))
        .map(option => option.text.trim())
        .filter(Boolean),
    );
    if (candidates.length) collectedOptions = candidates;
    const equivalent = candidates.filter(candidate => formValuesEquivalent(candidate, text));
    if (equivalent.length === 1) {
      choice = await element.evaluate(resolveSelectChoice, equivalent[0]);
    } else if (options.resolveOption && candidates.length) {
      const control = await readLiveControl(element, false);
      let selected: string | null;
      try {
        selected = await options.resolveOption({ requested: text, candidates, fieldText: control.context ?? '' });
      } catch (error) {
        if (!(error instanceof MissingFormInformationError)) throw error;
        return {
          status: 'failed',
          code: 'MISSING_INFORMATION',
          message: error.message,
          options: error.options,
          adapter: 'native-select',
          attempts: 0,
          actualValue: control.value,
          desiredValue: text,
        };
      }
      if (options.signal?.aborted) throw new Error('操作已取消。');
      if (selected !== null && candidates.includes(selected))
        choice = await element.evaluate(resolveSelectChoice, selected);
    }
  }
  if (!choice.found || choice.value === undefined)
    return {
      status: 'failed',
      code: choice.code ?? 'OPTION_NOT_FOUND',
      message: choice.message ?? '没有找到目标选项。',
      adapter: 'native-select',
      attempts: 0,
      actualValue: '',
      ...(collectedOptions?.length ? { options: collectedOptions } : {}),
    };
  const value = choice.value;
  return writeVerifiedControl(
    {
      read: async () => {
        await driver.checkTarget();
        return readLiveControl(element, false);
      },
      adapters: ['native-select', 'puppeteer-select'],
      write: async attempt => {
        await driver.checkTarget();
        if (options.signal?.aborted) throw new Error('操作已取消。');
        await driver.reveal(element);
        if (attempt === 0) await element.evaluate(writeFormSelect, value);
        else {
          await element.select(value);
          await element.evaluate(writeMainWorldComponentState, value).catch(() => false);
        }
        if (options.signal?.aborted) throw new Error('操作已取消。');
        await element.evaluate(commitFormControl, attempt === 0);
      },
    },
    {
      kind: 'select',
      expectedIdentity: identity,
      observedValue: options.observedValue ?? node.attributes.value ?? '',
      desiredValue: value,
      allowReplace: options.allowReplace,
      signal: options.signal,
    },
  );
}

export async function clickApplicationToggle(
  driver: PageDriver,
  node: DOMElementNode,
  signal?: AbortSignal,
  checked?: boolean,
): Promise<FormWriteResult> {
  const { element, identity } = await applicationControl(driver, node);
  // 目标值按模型观察到的状态定：观察后用户自己改过的，写入核验会判为已匹配，不会被翻回去。
  const { kind } = await readLiveControl(element, false);
  const observedValue =
    node.attributes.checked === 'true' || node.attributes['aria-checked'] === 'true' ? 'true' : 'false';
  const radio = node.attributes.type?.toLowerCase() === 'radio' || node.attributes.role === 'radio';
  const desiredValue = checked !== undefined ? String(checked) : radio ? 'true' : String(observedValue !== 'true');
  return writeVerifiedControl(
    {
      read: async () => {
        await driver.checkTarget();
        return readLiveControl(element, false);
      },
      adapters: ['native-click', 'dom-click'],
      write: async attempt => {
        await driver.checkTarget();
        if (signal?.aborted) throw new Error('操作已取消。');
        await driver.reveal(element);
        await driver.waitForClickTarget(element, signal);
        await element.evaluate(applicationSubmitGuard, 'start' as const);
        let blocked = false;
        try {
          if (attempt === 0) await element.click();
          else await element.evaluate(el => (el as HTMLElement).click());
        } finally {
          blocked = await element.evaluate(applicationSubmitGuard, 'stop' as const);
        }
        if (blocked) throw new Error('勾选会触发表单提交，已阻止。');
      },
    },
    {
      kind,
      expectedIdentity: identity,
      observedValue,
      desiredValue,
      preserveExisting: false,
      signal,
    },
  );
}
