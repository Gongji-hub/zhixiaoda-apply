import { ActionResult, type AgentContext } from '@src/background/agent/types';
import type { DOMElementNode } from '@src/background/browser/dom/views';
import { t } from '@extension/i18n';
import {
  clickElementActionSchema,
  doneActionSchema,
  goBackActionSchema,
  goToUrlActionSchema,
  inputTextActionSchema,
  openTabActionSchema,
  searchGoogleActionSchema,
  switchTabActionSchema,
  type ActionSchema,
  sendKeysActionSchema,
  scrollToTextActionSchema,
  cacheContentActionSchema,
  selectDropdownOptionActionSchema,
  selectCustomOptionActionSchema,
  fillApplicationFormActionSchema,
  clickTextActionSchema,
  pickDateActionSchema,
  selectMultipleOptionsActionSchema,
  getDropdownOptionsActionSchema,
  closeTabActionSchema,
  waitActionSchema,
  previousPageActionSchema,
  scrollToPercentActionSchema,
  nextPageActionSchema,
  scrollToTopActionSchema,
  scrollToBottomActionSchema,
} from './schemas';
import { z } from 'zod';
import { createLogger } from '@src/background/log';
import { ExecutionState, Actors } from '../event/types';
import type { DecisionClient } from '../../decisionClient';
import { URLNotAllowedError } from '../../browser/views';
import { needsUserInteraction } from './interactionPolicy';
import { wrapUntrustedContent } from '../messages/utils';
import { containsSanitizationPlaceholder, isSanitizationPlaceholder } from '../../services/guardrails/patterns';
import type { FormWriteResult } from '../../browser/formFill';
import type Page from '../../browser/page';
import { formFieldReference, type FormFieldReference } from '../formReview';
import { formStructureKey } from './formBatch';
import type { UserQuestion } from '../userInput';
import { reviewApplicationPage } from '../reviewPage';
import { fillApplicationForm } from '../formPlan/fill';
import { optionResolver } from '../formPlan/optionResolver';

const logger = createLogger('Action');

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/** 链接（含所在的 a 祖先）会把当前标签页带到别的文档，或另开页面。页内锚点不算。 */
function leavesPage(node: DOMElementNode, current: string): boolean {
  let link: DOMElementNode | null = node;
  while (link && !((link.tagName ?? '').toLowerCase() === 'a' && link.attributes.href)) link = link.parent;
  if (!link) return false;
  try {
    const to = new URL(link.attributes.href, current);
    const from = new URL(current);
    return link.attributes.target === '_blank' || to.origin + to.pathname + to.search !== from.origin + from.pathname + from.search;
  } catch {
    return false;
  }
}

async function assertApplyTab(context: AgentContext, tabId: number): Promise<void> {
  await context.browserContext.assertApplyTarget(tabId);
}

export async function formWriteActionResult(
  context: AgentContext,
  result: FormWriteResult,
  field?: FormFieldReference,
  expectedValue = '',
  required = false,
): Promise<ActionResult> {
  const succeeded = result.status === 'verified' ||
    (result.status === 'preserved' && result.actualValue === (result.desiredValue ?? expectedValue));
  if (field) {
    if (succeeded) {
      context.formRetries.clearResolved(field.key);
      context.replacements.clearResolved(field.key);
    }
    if (!succeeded && (result.attempts > 0 || result.code === 'EXISTING_VALUE_PRESERVED') && !context.stopped) {
      const state = await context.browserContext.getState();
      context.formRetries.record(
        field.key,
        expectedValue || result.desiredValue || '',
        result.actualValue,
        formStructureKey(state),
      );
    }
    context.review.recordWrite(field, expectedValue, result, required);
    void context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(context.review.snapshot()));
  }
  const details = wrapUntrustedContent(
    JSON.stringify({ control_write: result }),
    true,
    Boolean(context.options.targetOrigin),
  );
  context.emitEvent(
    Actors.NAVIGATOR,
    succeeded ? ExecutionState.ACT_OK : ExecutionState.ACT_FAIL,
    `${result.code}: ${result.message}`,
  );
  return new ActionResult({
    success: succeeded,
    fieldFailure: !succeeded && Boolean(field && context.options.targetOrigin),
    extractedContent: details,
    error: succeeded ? null : `${result.code}: ${result.message} ${result.code === 'DATE_PRECISION_REQUIRED'
      ? '先处理其他独立字段，随后 ask_user 询问缺少的具体日期，不得猜测。'
      : result.code === 'EXISTING_VALUE_PRESERVED' ? '请先按字段请求替换确认；未确认前停止重试。' : SELF_CORRECT}`,
    includeInMemory: true,
  });
}

/** 失败后的统一下一步：先自己判断、换做法，确实解决不了才交给用户。 */
const SELF_CORRECT = '此字段已记入侧栏待处理项，先继续其他独立字段；依赖此字段的项暂缓。不要反复操作该字段或弹出问题。其他可填写项处理完后以部分完成结束。';

function recordFormFailure(context: AgentContext, field: FormFieldReference, message: string): void {
  if (!context.options.targetOrigin) return;
  context.review.recordFailure(field, message);
  void context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(context.review.snapshot()));
}

/**
 * An action is a function that takes an input and returns an ActionResult
 */
export class Action {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly handler: (input: any) => Promise<ActionResult>,
    public readonly schema: ActionSchema,
    // Whether this action has an index argument
    public readonly hasIndex: boolean = false,
  ) {}

  async call(input: unknown): Promise<ActionResult> {
    // Validate input before calling the handler
    const schema = this.schema.schema;

    // check if the schema is schema: z.object({}), if so, ignore the input
    const isEmptySchema =
      schema instanceof z.ZodObject &&
      Object.keys((schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape || {}).length === 0;

    if (isEmptySchema) {
      return await this.handler({});
    }

    const parsedArgs = this.schema.schema.safeParse(input);
    if (!parsedArgs.success) {
      const errorMessage = parsedArgs.error.message;
      throw new InvalidInputError(errorMessage);
    }
    return await this.handler(parsedArgs.data);
  }

  name() {
    return this.schema.name;
  }

  /**
   * Returns the prompt for the action
   * @returns {string} The prompt for the action
   */
  prompt() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaShape = (this.schema.schema as z.ZodObject<any>).shape || {};
    const schemaProperties = Object.entries(schemaShape).map(([key, value]) => {
      const zodValue = value as z.ZodTypeAny;
      return `'${key}': {'type': '${zodValue.description}', ${zodValue.isOptional() ? "'optional': true" : "'required': true"}}`;
    });

    const schemaStr =
      schemaProperties.length > 0 ? `{${this.name()}: {${schemaProperties.join(', ')}}}` : `{${this.name()}: {}}`;

    return `${this.schema.description}:\n${schemaStr}`;
  }

  /**
   * Get the index argument from the input if this action has an index
   * @param input The input to extract the index from
   * @returns The index value if found, null otherwise
   */
  getIndexArg(input: unknown): number | null {
    if (!this.hasIndex) {
      return null;
    }
    if (input && typeof input === 'object' && 'index' in input) {
      return (input as { index: number }).index;
    }
    return null;
  }

  /**
   * Set the index argument in the input if this action has an index
   * @param input The input to update the index in
   * @param newIndex The new index value to set
   * @returns Whether the index was set successfully
   */
  setIndexArg(input: unknown, newIndex: number): boolean {
    if (!this.hasIndex) {
      return false;
    }
    if (input && typeof input === 'object') {
      (input as { index: number }).index = newIndex;
      return true;
    }
    return false;
  }
}

// TODO: can not make every action optional, don't know why
export function buildDynamicActionSchema(actions: Action[]): z.ZodType {
  let schema = z.object({});
  for (const action of actions) {
    // create a schema for the action, it could be action.schema.schema or null
    // but don't use default: null as it causes issues with Google Generative AI
    const actionSchema = action.schema.schema;
    schema = schema.extend({
      [action.name()]: actionSchema.nullable().optional(),
    });
  }
  return schema;
}

export class ActionBuilder {
  private readonly context: AgentContext;
  private readonly extractorLLM: DecisionClient;

  constructor(context: AgentContext, extractorLLM: DecisionClient) {
    this.context = context;
    this.extractorLLM = extractorLLM;
  }

  buildDefaultActions() {
    const actions = [];
    const askUserSchema = {
      name: 'ask_user',
      description:
        '',
      schema: z.object({
        kind: z
          .enum(['information', 'manual_action'])
          .default('information'),
        question: z.string().min(1).max(300),
        reason: z
          .string()
          .min(1)
          .max(600),
        options: z
          .array(z.string().min(1).max(120))
          .max(8),
        index: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        proposed_value: z
          .string()
          .max(12000)
          .optional(),
        replacements: z.array(z.object({
          index: z.number().int().nonnegative(),
          proposed_value: z.string().max(12000),
        })).min(1).max(20).optional(),
        review_key: z
          .string()
          .max(8000)
          .optional(),
      }),
    };
    actions.push(
      new Action(async (input: z.infer<typeof askUserSchema.schema>) => {
        const questionInput: Omit<UserQuestion, 'id'> = {
          kind: input.kind,
          question: input.question,
          reason: input.reason,
          options: input.options,
        };
        if (
          this.context.options.targetOrigin &&
          input.kind === 'information' &&
          input.index === undefined &&
          input.review_key === undefined &&
          input.replacements === undefined
        ) {
          return new ActionResult({
            error:
              '信息问题必须绑定已观察字段 index 或已有核对项 review_key。先观察实际表单，不能为推测出的隐藏字段提问。',
            includeInMemory: true,
          });
        }
        if (input.replacements !== undefined) {
          if (input.kind !== 'information' || input.index !== undefined || input.proposed_value !== undefined || input.review_key !== undefined ||
            new Set(input.replacements.map(item => item.index)).size !== input.replacements.length)
            return new ActionResult({ error: '批量替换确认需要唯一的字段列表，不能混用单字段参数。', includeInMemory: true });
          const indices = input.replacements.map(item => item.index);
          const observed = await this.context.browserContext.getCachedState();
          const structure = formStructureKey(observed, indices);
          const fresh = await this.context.browserContext.getState();
          if (formStructureKey(fresh, indices) !== structure)
            return new ActionResult({ error: '页面已变化，请重新观察后再询问这些字段。', includeInMemory: true });
          const page = await this.context.browserContext.getCurrentPage();
          const replacements: NonNullable<UserQuestion['replacements']> = [];
          for (const item of input.replacements) {
            const node = fresh.selectorMap.get(item.index);
            if (!node) return new ActionResult({ error: '当前字段不存在，请重新观察。', includeInMemory: true });
            const field = formFieldReference(fresh, node, item.index);
            if (this.context.review.isSkipped(field)) continue;
            const live = await page.readApplicationControl(node);
            if (live.valueKnown === false)
              return new ActionResult({ error: '无法可靠读取当前值，请重新观察或请求用户在官网处理。', includeInMemory: true });
            replacements.push({ field, tabId: fresh.tabId, currentValue: live.value, proposedValue: item.proposed_value });
          }
          if (!replacements.length) return new ActionResult({ success: true, extractedContent: '这些字段已跳过，本轮不再询问。', includeInMemory: true });
          questionInput.replacements = replacements;
          questionInput.field = replacements[0].field;
          questionInput.replacement = replacements[0];
        }
        if (input.review_key !== undefined) {
          const entry = this.context.review.snapshot().find(entry => entry.key === input.review_key);
          if (!entry || input.index !== undefined || input.proposed_value !== undefined || input.kind !== 'information')
            return new ActionResult({
              error: '核对项不存在或参数冲突，请根据当前清单重新观察。',
              includeInMemory: true,
            });
          questionInput.field = entry;
          if (this.context.review.isSkipped(entry))
            return new ActionResult({ success: true, includeInMemory: true,
              extractedContent: '用户已跳过或选择稍后处理此字段，本轮不再提问。继续其他项目。' });
        }
        if (input.proposed_value !== undefined && (input.index === undefined || input.kind !== 'information')) {
          return new ActionResult({
            error: '替换确认必须指定当前字段 index，并使用 information。',
            includeInMemory: true,
          });
        }
        if (input.index !== undefined) {
          const observed = await this.context.browserContext.getCachedState();
          const structure = formStructureKey(observed, [input.index]);
          const fresh = await this.context.browserContext.getState();
          if (formStructureKey(fresh, [input.index]) !== structure)
            return new ActionResult({ error: '页面已变化，请重新观察后再询问该字段。', includeInMemory: true });
          const node = fresh.selectorMap.get(input.index);
          if (!node) return new ActionResult({ error: '当前字段不存在，请重新观察。', includeInMemory: true });
          questionInput.field = formFieldReference(fresh, node, input.index);
          if (this.context.review.isSkipped(questionInput.field))
            return new ActionResult({
              extractedContent: '用户已明确跳过此字段，本轮不再提问或填写。请继续其他项目。',
              includeInMemory: true,
            });
          if (input.proposed_value !== undefined) {
            const page = await this.context.browserContext.getCurrentPage();
            const live = await page.readApplicationControl(node);
            if (live.valueKnown === false)
              return new ActionResult({ error: '无法可靠读取当前值，请使用 manual_action 请求用户在官网处理。', includeInMemory: true });
            questionInput.replacement = {
              tabId: fresh.tabId,
              currentValue: live.value,
              proposedValue: input.proposed_value,
            };
          }
        }
        if (questionInput.replacement && questionInput.field) {
          questionInput.replacements ??= [{ ...questionInput.replacement, field: questionInput.field }];
          questionInput.question = `是否替换以下 ${questionInput.replacements.length} 处字段？`;
          questionInput.reason = '确认仅适用于下方列出的字段及替换值。';
        }
        const answer = await this.context.userInput.ask(questionInput, this.context.controller.signal, question =>
          this.context.emitEvent(Actors.SYSTEM, ExecutionState.USER_QUESTION, JSON.stringify(question)),
        );
        return new ActionResult({
          success: true,
          includeInMemory: true,
          extractedContent: JSON.stringify({
            question: questionInput.question,
            replacements: questionInput.replacements,
            userResponse: answer,
            instruction:
              answer.decision === 'skip'
                ? 'Leave this unresolved. Do not ask again this run. Continue other fields.'
                : answer.decision === 'defer'
                  ? 'The user will handle this item later (fill it or complete the step on the website). Leave it unchanged; it is recorded as a reminder. Do not ask again this run. Continue every other fillable item, then call done and remind the user in the report.'
                  : 'User supplied this answer for this question only. Interpret natural language and convert unambiguous facts into the format required by the website; do not ask the user to reformat them. Clarify if meaning is ambiguous. Observe the current page again before acting.',
          }),
        });
      }, askUserSchema),
    );

    const done = new Action(async (input: z.infer<typeof doneActionSchema.schema>) => {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, doneActionSchema.name);
      const unresolved = await reviewApplicationPage(this.context);
      const missing = this.context.review.snapshot().filter(entry =>
        ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(entry.failureCode ?? '') &&
        ['pending', 'failed'].includes(entry.status));
      if (missing.length) return new ActionResult({
        error: `USER_INFORMATION_REQUIRED: 还有资料缺失项尚未向用户询问。先完成其他有依据的字段，再逐项 ask_user(index 或 review_key)，不能猜测或直接结束。${wrapUntrustedContent(JSON.stringify(missing.map(({ key, index, label, message }) => ({ review_key: key, index, label, message }))), true, true)}`,
        includeInMemory: true,
      });
      if (unresolved.length && unresolved.every(entry => entry.autoDeferred)) {
        const entries = this.context.review.snapshot();
        return new ActionResult({ isDone: true, success: false,
          extractedContent: `本轮已处理 ${entries.filter(entry => ['filled', 'preserved'].includes(entry.status)).length} 项，剩余 ${unresolved.length} 项待处理，请查看侧栏提醒。申请尚未提交。` });
      }
      if (input.success && unresolved.length) {
        return new ActionResult({
          error: `FINAL_REVIEW_INCOMPLETE: ${wrapUntrustedContent(JSON.stringify(unresolved.map(({ key, label, message, index, url }) => ({ key, label, message, index, url }))), true, true)}。逐项重新观察，结合网页提示和简历原文自行判断原因并修复；自己确实无法解决的才 ask_user(index=当前字段) 请求用户处理或明确跳过；早前页面的核对项用 review_key 绑定。不得宣称完成。`,
          includeInMemory: true,
        });
      }
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, input.text);
      return new ActionResult({
        isDone: true,
        success: input.success,
        extractedContent: input.text,
      });
    }, doneActionSchema);
    actions.push(done);

    const searchGoogle = new Action(async (input: z.infer<typeof searchGoogleActionSchema.schema>) => {
      const context = this.context;
      const intent = input.intent || t('act_searchGoogle_start', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await context.browserContext.navigateTo(`https://www.google.com/search?q=${input.query}`);

      const msg2 = t('act_searchGoogle_ok', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, searchGoogleActionSchema);
    actions.push(searchGoogle);

    const goToUrl = new Action(async (input: z.infer<typeof goToUrlActionSchema.schema>) => {
      const intent = input.intent || t('act_goToUrl_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await this.context.browserContext.navigateTo(input.url);
      const msg2 = t('act_goToUrl_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goToUrlActionSchema);
    actions.push(goToUrl);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const goBack = new Action(async (input: z.infer<typeof goBackActionSchema.schema>) => {
      const intent = input.intent || t('act_goBack_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.goBack();
      const msg2 = t('act_goBack_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goBackActionSchema);
    actions.push(goBack);

    const wait = new Action(async (input: z.infer<typeof waitActionSchema.schema>) => {
      const seconds = input.seconds || 3;
      const intent = input.intent || t('act_wait_start', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      const msg = t('act_wait_ok', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, waitActionSchema);
    actions.push(wait);

    // Element Interaction Actions
    const clickElement = new Action(
      async (input: z.infer<typeof clickElementActionSchema.schema>) => {
        const intent = input.intent || t('act_click_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        await assertApplyTab(this.context, page.tabId);
        const state = this.context.options.targetOrigin ? page.getCachedState() : await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }
        if (input.effect === 'accept_terms') return new ActionResult({
          error: 'CONSENT_CONFIRMATION_REQUIRED: 不再默认同意协议。请用户确认并在页面勾选，随后重新核对；不要更改 effect 绕过。',
          includeInMemory: true,
        });
        if (needsUserInteraction(elementNode, input.effect)) {
          const toggle =
            elementNode.tagName?.toLowerCase() === 'input' &&
            ['checkbox', 'radio'].includes(elementNode.attributes.type?.toLowerCase() ?? '');
          return new ActionResult({
            error: toggle && input.effect !== 'edit_application'
              ? 'MANUAL_ACTION_REQUIRED: 勾选或取消勾选属于填写表单。普通表单选项只有具备用户事实依据时才用 effect=edit_application；资料没有必须 ask_user。协议、授权、隐私声明请用户确认并在页面勾选。'
              : 'MANUAL_ACTION_REQUIRED: 此动作属于需要用户操作的效果或受保护的控件。自定义选项请改用 select_custom_option 绑定所属字段；确实需要用户才能继续时才 ask_user(kind=manual_action)，不要改报 effect 绕过。最终提交不执行，也不要求用户提交来结束本轮。',
            includeInMemory: true,
          });
        }

        if (this.context.options.targetOrigin && this.context.review.snapshot().length && leavesPage(elementNode, state!.url))
          return new ActionResult({
            error:
              'LEAVE_PAGE_BLOCKED: 这个链接会离开正在填写的网申页面，已填内容可能丢失，已阻止。继续处理本页剩余字段，本页处理完就调用 done 汇报；确需用户去别的页面才 ask_user(kind=manual_action)。',
            includeInMemory: true,
          });

        // Check if element is a file uploader
        if (page.isFileUploader(elementNode)) {
          const msg = t('act_click_fileUploader', [input.index.toString()]);
          logger.info(msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        }

        try {
          if (
            this.context.options.targetOrigin &&
            input.effect === 'edit_application' &&
            ((elementNode.tagName?.toLowerCase() === 'input' &&
              ['checkbox', 'radio'].includes(elementNode.attributes.type?.toLowerCase() ?? '')) ||
              ['checkbox', 'radio', 'switch'].includes(elementNode.attributes.role))
          ) {
            const field = formFieldReference(state!, elementNode, input.index);
            if (this.context.review.isSkipped(field))
              return new ActionResult({ extractedContent: '用户已跳过此字段，本轮保留现状。', includeInMemory: true });
            const result = await page.clickApplicationToggle(elementNode, this.context.controller.signal);
            return formWriteActionResult(
              this.context,
              result,
              field,
              '',
              Boolean(elementNode.attributes.required) || elementNode.attributes['aria-required'] === 'true',
            );
          }
          await page.clickElementNode(this.context.options.useVision, elementNode, this.context.controller.signal);
          let msg = t('act_click_ok', [input.index.toString(), elementNode.getAllTextTillNextClickableElement(2)]);
          logger.info(msg);

          const currentPage = await this.context.browserContext.getCurrentPage();
          if (currentPage.tabId !== page.tabId) msg += ' 已切换到此操作打开的新页面，请重新观察后继续。';
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        } catch (error) {
          if (error instanceof URLNotAllowedError) throw error;
          const msg = t('act_errors_elementNoLongerAvailable', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({
            error: error instanceof Error ? error.message : String(error),
            includeInMemory: true,
          });
        }
      },
      clickElementActionSchema,
      true,
    );
    actions.push(clickElement);

    const inputText = new Action(
      async (input: z.infer<typeof inputTextActionSchema.schema>) => {
        const intent = input.intent || t('act_inputText_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        if (this.context.options.targetOrigin && containsSanitizationPlaceholder(input.text)) {
          const error =
            '填写值包含内部脱敏占位符，已阻止写入。请从简历原文或用户回答取真实值；没有证据时 ask_user，不能把占位符当成个人事实。';
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
          const observed = await this.context.browserContext.getCachedState();
          const node = observed.selectorMap.get(input.index);
          if (node) recordFormFailure(this.context, formFieldReference(observed, node, input.index), error);
          return new ActionResult({ error, includeInMemory: true });
        }

        const page = await this.context.browserContext.getCurrentPage();
        await assertApplyTab(this.context, page.tabId);
        const state = this.context.options.targetOrigin ? page.getCachedState() : await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }
        if (needsUserInteraction(elementNode, input.effect, 'input')) {
          return new ActionResult({
            extractedContent:
              '该动作会提交表单或需要用户接手。调用 ask_user(kind=manual_action) 说明当前需要完成的操作；不要反复尝试，也不能改报 effect 绕过。',
            includeInMemory: true,
          });
        }

        const currentValue = elementNode.attributes.value ?? '';
        const repairPlaceholder = this.context.options.targetOrigin && isSanitizationPlaceholder(currentValue);
        if (
          !this.context.options.targetOrigin &&
          currentValue.trim() &&
          !input.replace_existing &&
          !repairPlaceholder
        ) {
          return new ActionResult({
            extractedContent:
              currentValue === input.text
                ? '此字段已有相同内容，保留并继续。'
                : '此字段已有真实内容，与拟填写值不同，未执行覆盖。必须先 ask_user 请用户确认；确认后才可使用 replace_existing=true。不要重复尝试输入。',
            includeInMemory: true,
          });
        }

        try {
          const result = await page.inputTextElementNode(this.context.options.useVision, elementNode, input.text, {
            allowReplace: Boolean(
              repairPlaceholder ||
                (input.replace_existing &&
                  this.context.replacements.permits(
                    page.tabId,
                    formFieldReference(state!, elementNode, input.index).key,
                    currentValue,
                    input.text,
                  )),
            ),
            observedValue: currentValue,
            signal: this.context.controller.signal,
          });
          if (result)
            return formWriteActionResult(
              this.context,
              result,
              formFieldReference(state!, elementNode, input.index),
              input.text,
              Boolean(elementNode.attributes.required),
            );
        } catch (error) {
          if (error instanceof URLNotAllowedError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          recordFormFailure(this.context, formFieldReference(state!, elementNode, input.index), message);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
          return new ActionResult({ error: message, includeInMemory: true });
        }
        const msg = t('act_inputText_ok', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      },
      inputTextActionSchema,
      true,
    );
    actions.push(inputText);

    // Tab Management Actions
    const switchTab = new Action(async (input: z.infer<typeof switchTabActionSchema.schema>) => {
      const intent = input.intent || t('act_switchTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.switchTab(input.tab_id);
      const msg = t('act_switchTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, switchTabActionSchema);
    actions.push(switchTab);

    const openTab = new Action(async (input: z.infer<typeof openTabActionSchema.schema>) => {
      const intent = input.intent || t('act_openTab_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.openTab(input.url);
      const msg = t('act_openTab_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, openTabActionSchema);
    actions.push(openTab);

    const closeTab = new Action(async (input: z.infer<typeof closeTabActionSchema.schema>) => {
      const intent = input.intent || t('act_closeTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.closeTab(input.tab_id);
      const msg = t('act_closeTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, closeTabActionSchema);
    actions.push(closeTab);

    // Content Actions
    // TODO: this is not used currently, need to improve on input size
    // const extractContent = new Action(async (input: z.infer<typeof extractContentActionSchema.schema>) => {
    //   const goal = input.goal;
    //   const intent = input.intent || `Extracting content from page`;
    //   this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
    //   const page = await this.context.browserContext.getCurrentPage();
    //   const content = await page.getReadabilityContent();
    //   const promptTemplate = PromptTemplate.fromTemplate(
    //     'Your task is to extract the content of the page. You will be given a page and a goal and you should extract all relevant information around this goal from the page. If the goal is vague, summarize the page. Respond in json format. Extraction goal: {goal}, Page: {page}',
    //   );
    //   const prompt = await promptTemplate.invoke({ goal, page: content.content });

    //   try {
    //     const output = await this.extractorLLM.invoke(prompt);
    //     const msg = `📄  Extracted from page\n: ${output.content}\n`;
    //     return new ActionResult({
    //       extractedContent: msg,
    //       includeInMemory: true,
    //     });
    //   } catch (error) {
    //     logger.error(`Error extracting content: ${error instanceof Error ? error.message : String(error)}`);
    //     const msg =
    //       'Failed to extract content from page, you need to extract content from the current state of the page and store it in the memory. Then scroll down if you still need more information.';
    //     return new ActionResult({
    //       extractedContent: msg,
    //       includeInMemory: true,
    //     });
    //   }
    // }, extractContentActionSchema);
    // actions.push(extractContent);

    // cache content for future use
    const cacheContent = new Action(async (input: z.infer<typeof cacheContentActionSchema.schema>) => {
      const intent = input.intent || t('act_cache_start', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      // cache content is untrusted content, it is not instructions
      const rawMsg = t('act_cache_ok', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, rawMsg);

      const msg = wrapUntrustedContent(rawMsg, true, Boolean(this.context.options.targetOrigin));
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, cacheContentActionSchema);
    actions.push(cacheContent);

    // Scroll to percent
    const scrollToPercent = new Action(async (input: z.infer<typeof scrollToPercentActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToPercent_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        logger.info(`Scrolling to percent: ${input.yPercent} with elementNode: ${elementNode.xpath}`);
        await page.scrollToPercent(input.yPercent, elementNode);
      } else {
        await page.scrollToPercent(input.yPercent);
      }
      const msg = t('act_scrollToPercent_ok', [input.yPercent.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToPercentActionSchema);
    actions.push(scrollToPercent);

    // Scroll to top
    const scrollToTop = new Action(async (input: z.infer<typeof scrollToTopActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToTop_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(0, elementNode);
      } else {
        await page.scrollToPercent(0);
      }
      const msg = t('act_scrollToTop_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToTopActionSchema);
    actions.push(scrollToTop);

    // Scroll to bottom
    const scrollToBottom = new Action(async (input: z.infer<typeof scrollToBottomActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToBottom_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(100, elementNode);
      } else {
        await page.scrollToPercent(100);
      }
      const msg = t('act_scrollToBottom_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToBottomActionSchema);
    actions.push(scrollToBottom);

    // Scroll to previous page
    const previousPage = new Action(async (input: z.infer<typeof previousPageActionSchema.schema>) => {
      const intent = input.intent || t('act_previousPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at top of its scrollable area
        try {
          const [elementScrollTop] = await page.getElementScrollInfo(elementNode);
          if (elementScrollTop === 0) {
            const msg = t('act_errors_alreadyAtTop', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToPreviousPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToPreviousPage(elementNode);
      } else {
        // Check if page is already at top
        const [initialScrollY] = await page.getScrollInfo();
        if (initialScrollY === 0) {
          const msg = t('act_errors_pageAlreadyAtTop');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToPreviousPage();
      }
      const msg = t('act_previousPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, previousPageActionSchema);
    actions.push(previousPage);

    // Scroll to next page
    const nextPage = new Action(async (input: z.infer<typeof nextPageActionSchema.schema>) => {
      const intent = input.intent || t('act_nextPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at bottom of its scrollable area
        try {
          const [elementScrollTop, elementClientHeight, elementScrollHeight] =
            await page.getElementScrollInfo(elementNode);
          if (elementScrollTop + elementClientHeight >= elementScrollHeight) {
            const msg = t('act_errors_alreadyAtBottom', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToNextPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToNextPage(elementNode);
      } else {
        // Check if page is already at bottom
        const [initialScrollY, initialVisualViewportHeight, initialScrollHeight] = await page.getScrollInfo();
        if (initialScrollY + initialVisualViewportHeight >= initialScrollHeight) {
          const msg = t('act_errors_pageAlreadyAtBottom');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToNextPage();
      }
      const msg = t('act_nextPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, nextPageActionSchema);
    actions.push(nextPage);

    // Scroll to text
    const scrollToText = new Action(async (input: z.infer<typeof scrollToTextActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToText_start', [input.text, input.nth.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      try {
        const scrolled = await page.scrollToText(input.text, input.nth);
        const msg = scrolled
          ? t('act_scrollToText_ok', [input.text, input.nth.toString()])
          : t('act_scrollToText_notFound', [input.text, input.nth.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (error) {
        const msg = t('act_scrollToText_failed', [error instanceof Error ? error.message : String(error)]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        return new ActionResult({ error: msg, includeInMemory: true });
      }
    }, scrollToTextActionSchema);
    actions.push(scrollToText);

    // Keyboard Actions
    const sendKeys = new Action(async (input: z.infer<typeof sendKeysActionSchema.schema>) => {
      const intent = input.intent || t('act_sendKeys_start', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.sendKeys(input.keys);
      const msg = t('act_sendKeys_ok', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, sendKeysActionSchema);
    actions.push(sendKeys);

    // Get all options from a native dropdown
    const getDropdownOptions = new Action(
      async (input: z.infer<typeof getDropdownOptionsActionSchema.schema>) => {
        const intent = input.intent || t('act_getDropdownOptions_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = this.context.options.targetOrigin ? page.getCachedState() : await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        try {
          if (this.context.options.targetOrigin && elementNode.tagName?.toLowerCase() !== 'select') {
            const choices = await page.listCustomOptions(elementNode, this.context.controller.signal);
            return new ActionResult({
              extractedContent: choices.length
                ? `${wrapUntrustedContent(JSON.stringify({ dropdown_options: choices }), true, true)}\n用 select_custom_option(index=${input.index}, text=其中一个精确文本) 选择；没有合适项就按简历判断或 ask_user。`
                : '展开后没有出现选项。',
              includeInMemory: true,
            });
          }
          // Use the existing getDropdownOptions method
          const options = await page.getDropdownOptions(input.index);

          if (options && options.length > 0) {
            // Format options for display
            const formattedOptions: string[] = options.map(opt => {
              // Encoding ensures AI uses the exact string in select_dropdown_option
              const encodedText = JSON.stringify(opt.text);
              return `${opt.index}: text=${encodedText}`;
            });

            let msg = formattedOptions.join('\n');
            msg += '\n' + t('act_getDropdownOptions_useExactText');
            this.context.emitEvent(
              Actors.NAVIGATOR,
              ExecutionState.ACT_OK,
              t('act_getDropdownOptions_ok', [options.length.toString()]),
            );
            return new ActionResult({
              extractedContent: msg,
              includeInMemory: true,
            });
          }

          // This code should not be reached as getDropdownOptions throws an error when no options found
          // But keeping as fallback
          const msg = t('act_getDropdownOptions_noOptions');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_getDropdownOptions_failed', [error instanceof Error ? error.message : String(error)]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      getDropdownOptionsActionSchema,
      true,
    );
    actions.push(getDropdownOptions);

    // Select dropdown option for interactive element index by the text of the option you want to select'
    const selectDropdownOption = new Action(
      async (input: z.infer<typeof selectDropdownOptionActionSchema.schema>) => {
        const intent = input.intent || t('act_selectDropdownOption_start', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = this.context.options.targetOrigin ? page.getCachedState() : await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        // Validate that we're working with a select element
        if (!elementNode.tagName || elementNode.tagName.toLowerCase() !== 'select') {
          const errorMsg = t('act_selectDropdownOption_notSelect', [
            input.index.toString(),
            elementNode.tagName || 'unknown',
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        logger.debug(`Attempting to select '${input.text}' using xpath: ${elementNode.xpath}`);

        try {
          const result = await page.selectDropdownOption(input.index, input.text, {
            resolveOption: optionResolver(this.context, this.extractorLLM, formFieldReference(state!, elementNode, input.index).label),
            allowReplace: Boolean(
              input.replace_existing &&
                this.context.replacements.permits(
                  page.tabId,
                  formFieldReference(state!, elementNode, input.index).key,
                  elementNode.attributes.value ?? '',
                  input.text,
                ),
            ),
            observedValue: elementNode.attributes.value ?? '',
            signal: this.context.controller.signal,
          });
          if (typeof result !== 'string')
            return formWriteActionResult(
              this.context,
              result,
              formFieldReference(state!, elementNode, input.index),
              input.text,
              Boolean(elementNode.attributes.required),
            );
          const msg = t('act_selectDropdownOption_ok', [input.text, input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: result,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_selectDropdownOption_failed', [
            error instanceof Error ? error.message : String(error),
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      selectDropdownOptionActionSchema,
      true,
    );
    actions.push(selectDropdownOption);

    actions.push(new Action(async (input: z.infer<typeof selectCustomOptionActionSchema.schema>) => {
      const page = await this.context.browserContext.getCurrentPage();
      const state = page.getCachedState();
      const node = state?.selectorMap.get(input.index);
      if (!node) return new ActionResult({ error: '字段索引无效，请重新观察。', includeInMemory: true });
      const field = formFieldReference(state!, node, input.index);
      try {
        const live = await page.readApplicationControl(node);
        const result = await page.selectCustomOption(node, input.text, {
          resolveOption: optionResolver(this.context, this.extractorLLM, field.label),
          observedValue: live.value,
          allowReplace: Boolean(input.replace_existing && this.context.replacements.permits(page.tabId, field.key, live.value, input.text)),
          signal: this.context.controller.signal,
        });
        return formWriteActionResult(this.context, result, field, input.text,
          node.attributes.required !== undefined || node.attributes['aria-required'] === 'true');
      } catch (error) {
        if (error instanceof URLNotAllowedError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        recordFormFailure(this.context, field, message);
        return new ActionResult({ error: message, includeInMemory: true });
      }
    }, selectCustomOptionActionSchema, true));

    actions.push(
      new Action(async (input: z.infer<typeof clickTextActionSchema.schema>) => {
        if (!this.context.options.targetOrigin)
          return new ActionResult({ error: '按文字点击只用于网申任务。', includeInMemory: true });
        if (input.effect !== 'open_interface' && input.effect !== 'edit_application' && input.effect !== 'advance_form')
          return new ActionResult({
            error: 'MANUAL_ACTION_REQUIRED: 该点击属于需要用户完成的效果（登录、上传、提交或非勾选形式的协议等），请 ask_user(kind=manual_action)。',
            includeInMemory: true,
          });
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || `点击「${input.text}」`);
        const page = await this.context.browserContext.getCurrentPage();
        await assertApplyTab(this.context, page.tabId);
        try {
          const clicked = await page.clickApplicationText(input.text, input.after ?? null, this.context.controller.signal);
          if (!clicked)
            return new ActionResult({
              error: `没找到可点击的「${input.text}」：文字要与页面完全一致；同名的有多处时用 after 写它前面的区块标题。会离开页面或提交的元素不会点。`,
              includeInMemory: true,
            });
          const msg = `已点击「${input.text}」。请重新观察页面变化。`;
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        } catch (error) {
          if (error instanceof URLNotAllowedError) throw error;
          return new ActionResult({ error: error instanceof Error ? error.message : String(error), includeInMemory: true });
        }
      }, clickTextActionSchema),
    );

    const fieldWrite = (
      schema: ActionSchema,
      expected: (input: Record<string, unknown>) => string,
      run: (page: Page, node: DOMElementNode, input: Record<string, unknown>, live: { value: string }, allowReplace: boolean) => Promise<FormWriteResult>,
    ) =>
      new Action(async (input: Record<string, unknown> & { index: number; replace_existing?: boolean }) => {
        const page = await this.context.browserContext.getCurrentPage();
        const state = page.getCachedState();
        const node = state?.selectorMap.get(input.index);
        if (!node) return new ActionResult({ error: '字段索引无效，请重新观察。', includeInMemory: true });
        const field = formFieldReference(state!, node, input.index);
        if (this.context.review.isSkipped(field))
          return new ActionResult({ extractedContent: '用户已明确跳过此字段，本轮保留现状。', includeInMemory: true });
        try {
          const live = await page.readApplicationControl(node);
          const allowReplace = Boolean(
            input.replace_existing && this.context.replacements.permits(page.tabId, field.key, live.value, expected(input)),
          );
          return formWriteActionResult(
            this.context,
            await run(page, node, input, live, allowReplace),
            field,
            expected(input),
            node.attributes.required !== undefined || node.attributes['aria-required'] === 'true',
          );
        } catch (error) {
          if (error instanceof URLNotAllowedError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          recordFormFailure(this.context, field, message);
          return new ActionResult({ error: message, includeInMemory: true });
        }
      }, schema, true);

    actions.push(
      fieldWrite(
        pickDateActionSchema,
        input => String(input.value),
        (page, node, input, live, allowReplace) =>
          page.pickApplicationDate(node, String(input.value), { observedValue: live.value, allowReplace, signal: this.context.controller.signal }),
      ),
    );
    actions.push(
      fieldWrite(
        selectMultipleOptionsActionSchema,
        input => (input.texts as string[]).join('、'),
        (page, node, input, _live, allowReplace) =>
          page.selectCustomOptions(node, input.texts as string[], { allowReplace, signal: this.context.controller.signal,
            resolveOption: optionResolver(this.context, this.extractorLLM, node.attributes['aria-label'] ?? '多选字段') }),
      ),
    );

    actions.push(
      new Action(async () => {
        if (!this.context.options.targetOrigin)
          return new ActionResult({ error: '整页填写只用于网申任务。', includeInMemory: true });
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, '整页读取并填写表单');
        try {
          const summary = await fillApplicationForm(this.context, this.extractorLLM, formWriteActionResult);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, '整页填写完成');
          return new ActionResult({ extractedContent: summary, includeInMemory: true });
        } catch (error) {
          if (error instanceof URLNotAllowedError) throw error;
          const message = `整页填写中断：${error instanceof Error ? error.message : String(error)}。已写入的内容保留，可重新观察后用逐项工具继续。`;
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
          return new ActionResult({ error: message, includeInMemory: true });
        }
      }, fillApplicationFormActionSchema),
    );

    const allowed = new Set([
      'fill_application_form',
      'click_text',
      'pick_date',
      'select_multiple_options',
      'ask_user',
      'done',
      'click_element',
      'input_text',
      'cache_content',
      'scroll_to_percent',
      'scroll_to_top',
      'scroll_to_bottom',
      'previous_page',
      'next_page',
      'scroll_to_text',
      'get_dropdown_options',
      'select_dropdown_option',
      'select_custom_option',
      'wait',
    ]);
    return actions
      .filter(action => allowed.has(action.name()))
      .map(
        action =>
          new Action(
            async input => {
              if (this.context.stopped || this.context.controller.signal.aborted)
                throw new InvalidInputError('操作已停止');
              while (this.context.paused && !this.context.stopped)
                await new Promise(resolve => setTimeout(resolve, 150));
              if (this.context.stopped) throw new InvalidInputError('操作已停止');
              const page = await this.context.browserContext.getCurrentPage();
              await assertApplyTab(this.context, page.tabId);
              if (action.hasIndex && !page.getCachedState()) {
                throw new InvalidInputError('目标已切换到新页面，请重新观察后再使用元素索引。');
              }
              if (
                this.context.options.targetOrigin &&
                action.hasIndex &&
                (['input_text', 'select_dropdown_option', 'select_custom_option', 'pick_date', 'select_multiple_options'].includes(action.name()) ||
                  (action.name() === 'click_element' && input.effect === 'edit_application'))
              ) {
                const state = page.getCachedState();
                const node = state?.selectorMap.get(input.index);
                if (node && this.context.review.isSkipped(formFieldReference(state!, node, input.index)))
                  return new ActionResult({
                    extractedContent: '用户已明确跳过此字段，本轮保留现状，不再填写。',
                    includeInMemory: true,
                  });
                if (node) {
                  const field = formFieldReference(state!, node, input.index);
                  if (this.context.review.isAutoDeferred(field)) {
                    const live = await page.readApplicationControl(node, this.context.review.chosen(field));
                    this.context.review.reconcile(field, live, live.required ?? (node.attributes.required !== undefined || node.attributes['aria-required'] === 'true'));
                    if (this.context.review.isAutoDeferred(field))
                      return new ActionResult({ error: `REPEATED_WRITE_BLOCKED: 此字段已暂缓。${SELF_CORRECT}`, includeInMemory: true });
                    void this.context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(this.context.review.snapshot()));
                  }
                  const toggle =
                    action.name() === 'click_element' &&
                    ((node.tagName?.toLowerCase() === 'input' &&
                      ['checkbox', 'radio'].includes(node.attributes.type?.toLowerCase() ?? '')) ||
                      ['checkbox', 'radio', 'switch'].includes(node.attributes.role));
                  const checked = node.attributes.checked === 'true' || node.attributes['aria-checked'] === 'true';
                  const radio = node.attributes.type?.toLowerCase() === 'radio' || node.attributes.role === 'radio';
                  const desired = toggle
                    ? radio ? 'true' : String(!checked)
                    : action.name() === 'pick_date'
                      ? input.value
                      : action.name() === 'select_multiple_options'
                        ? (input.texts as string[]).join('、')
                        : input.text;
                  const live = ['select_custom_option', 'pick_date', 'select_multiple_options'].includes(action.name())
                    ? await page.readApplicationControl(node) : null;
                  const actual = live
                    ? live.value
                    : toggle ? String(checked) : (node.attributes.value ?? '');
                  // Fresh committed state supersedes an earlier failed write, even if its text is unchanged.
                  if (live?.valid && live.selectionConfirmed !== false && live.value === desired)
                    this.context.formRetries.clearResolved(formFieldReference(state!, node, input.index).key);
                  if (
                    this.context.formRetries.blocked(
                      formFieldReference(state!, node, input.index).key,
                      desired,
                      actual,
                      formStructureKey(state!),
                    )
                  ) {
                    const message =
                      `REPEATED_WRITE_BLOCKED: 此字段用同一个值写入已失败过，页面和值都没有变化，重复只会再失败。${SELF_CORRECT}`;
                    void this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
                    return new ActionResult({ error: message, includeInMemory: true });
                  }
                }
              }
              if (this.context.options.targetOrigin && input.effect === 'advance_form' &&
                  ['click_element', 'click_text'].includes(action.name())) {
                const original = page.getCachedState()?.selectorMap.get(input.index);
                await reviewApplicationPage(this.context);
                const current = page.getCachedState();
                const pending = this.context.review.snapshot().filter(entry => entry.url === current?.url && entry.required &&
                  !['filled', 'preserved'].includes(entry.status));
                if (pending.length) return new ActionResult({
                  error: `FORM_PREREQUISITES_PENDING: 当前表单仍有 ${pending.length} 项必填内容未完成，已阻止保存或进入下一步。继续填写其他独立字段；缺资料的项必须 ask_user，用户跳过或稍后处理后才以部分完成结束。技术失败项保留侧栏提醒，不要重复保存。${wrapUntrustedContent(JSON.stringify(pending.map(({ label, message }) => ({ label, message }))), true, true)}`,
                  includeInMemory: true,
                });
                if (original && current?.selectorMap.get(input.index)?.xpath !== original.xpath)
                  return new ActionResult({ error: 'STALE_CONTROL: 核对表单后按钮位置已变化，请重新观察。', includeInMemory: true });
              }
              const result = await action.call(input);
              // 只有绑定真实表单字段的写入错误可以局部暂缓；导航、连接和安全错误仍由执行器处理。
              if (result.error && this.context.options.targetOrigin &&
                  ['input_text', 'select_dropdown_option', 'select_custom_option', 'pick_date', 'select_multiple_options'].includes(action.name())) {
                const state = page.getCachedState();
                const node = state?.selectorMap.get(input.index);
                if (node) {
                  const field = formFieldReference(state!, node, input.index);
                  if (!this.context.review.isAutoDeferred(field) && !['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(this.context.review.snapshot().find(entry => entry.key === field.key)?.failureCode ?? '')) {
                    this.context.review.recordFailure(field, result.error, node.attributes.required !== undefined || node.attributes['aria-required'] === 'true');
                    this.context.review.deferFailure(field);
                  }
                  result.fieldFailure = true;
                  result.error += this.context.review.snapshot().find(entry => entry.key === field.key)?.failureCode === 'DATE_PRECISION_REQUIRED'
                    ? ' 请在其他独立字段处理后询问用户补充日期。' : ` ${SELF_CORRECT}`;
                  await this.context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(this.context.review.snapshot()));
                }
              }
              return result;
            },
            action.schema,
            action.hasIndex,
          ),
      );
  }
}
