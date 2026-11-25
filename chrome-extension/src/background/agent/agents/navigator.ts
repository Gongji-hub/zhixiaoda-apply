import { HumanMessage } from '@langchain/core/messages';
import { HistoryTreeProcessor } from '@src/background/browser/dom/history/service';
import { type DOMHistoryElement } from '@src/background/browser/dom/history/view';
import { calcBranchPathHashSet } from '@src/background/browser/dom/views';
import { type BrowserState, BrowserStateHistory, URLNotAllowedError } from '@src/background/browser/views';
import { createLogger } from '@src/background/log';
import { repairJsonString } from '@src/background/utils';
import { z } from 'zod';
import type { Action } from '../actions/builder';
import { buildDynamicActionSchema } from '../actions/builder';
import { formStructureKey, isPlainFormInput } from '../actions/formBatch';
import { applicationActionKey, applicationProgressKey } from '../actions/progress';
import { Actors, ExecutionState } from '../event/types';
import { describeAgentFailure } from '../failureDetails';
import { collectOutline } from '../formPlan/outline';
import { AgentStepRecord } from '../history';
import { ActionResult, agentBrainSchema, type AgentOutput } from '../types';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import {
    ChatModelAuthError,
    ChatModelBadRequestError,
    ChatModelForbiddenError,
    EXTENSION_CONFLICT_ERROR_MESSAGE,
    ExtensionConflictError,
    isAbortedError,
    isAuthenticationError,
    isBadRequestError,
    isExtensionConflictError,
    isForbiddenError,
    LLM_FORBIDDEN_ERROR_MESSAGE,
    RequestCancelledError,
    ResponseParseError,
} from './errors';
import { replayHistoryStep, updateActionIndices } from './navigatorHistory';

const logger = createLogger('NavigatorAgent');
export class NavigatorActionRegistry {
  private actions: Record<string, Action> = {};

  constructor(actions: Action[]) {
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  registerAction(action: Action): void {
    this.actions[action.name()] = action;
  }

  unregisterAction(name: string): void {
    delete this.actions[name];
  }

  getAction(name: string): Action | undefined {
    return this.actions[name];
  }

  setupModelOutputSchema(): z.ZodType {
    const actionSchema = buildDynamicActionSchema(Object.values(this.actions));
    return z.object({
      current_state: agentBrainSchema,
      action: z.array(actionSchema),
    });
  }
}

export interface NavigatorResult {
  done: boolean;
  success?: boolean;
}

export class NavigatorAgent extends BaseAgent<z.ZodType, NavigatorResult> {
  private actionRegistry: NavigatorActionRegistry;
  private _stateHistory: BrowserStateHistory | null = null;
  private noProgressActions?: Map<string, number>;
  private lastReviewSnapshot = '';

  constructor(
    actionRegistry: NavigatorActionRegistry,
    options: BaseAgentOptions,
    extraOptions?: Partial<ExtraAgentOptions>,
  ) {
    super(actionRegistry.setupModelOutputSchema(), options, { ...extraOptions, id: 'navigator' });

    this.actionRegistry = actionRegistry;
  }

  async execute(): Promise<AgentOutput<NavigatorResult>> {
    const agentOutput: AgentOutput<NavigatorResult> = {
      id: this.id,
    };

    let cancelled = false;
    let modelOutputString: string | null = null;
    let browserStateHistory: BrowserStateHistory | null = null;
    let actionResults: ActionResult[] = [];

    try {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...');

      const messageManager = this.context.messageManager;
      // add the browser state message
      let started = Date.now();
      await this.addStateMessageToMemory();
      const deferred = this.context.review.snapshot().filter(entry => entry.autoDeferred);
      const reviewSnapshot = JSON.stringify(deferred);
      if (deferred.length && reviewSnapshot !== this.lastReviewSnapshot) messageManager.addFormReview(deferred);
      this.lastReviewSnapshot = reviewSnapshot;
      this.context.trace?.('观察页面', Date.now() - started);
      const currentState = await this.context.browserContext.getCachedState();
      browserStateHistory = new BrowserStateHistory(currentState);

      // check if the task is paused or stopped
      if (this.context.stopped || (this.context.paused && actionResults.length === 0)) {
        cancelled = true;
        return agentOutput;
      }

      // call the model to get the actions to take
      const inputMessages = messageManager.getMessages();
      // logger.info('Navigator input message', inputMessages[inputMessages.length - 1]);

      started = Date.now();
      const modelOutput = await this.invoke(inputMessages);
      const promptChars = inputMessages.reduce(
        (sum, message) =>
          sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length),
        0,
      );
      const goal = modelOutput?.current_state?.next_goal;
      this.context.trace?.(
        '模型决策',
        Date.now() - started,
        `页面与历史约 ${promptChars} 字符${goal ? `\n打算：${goal}` : ''}`,
      );

      // check if the task is paused or stopped
      if (this.context.stopped || (this.context.paused && actionResults.length === 0)) {
        cancelled = true;
        return agentOutput;
      }

      const actions = this.fixActions(modelOutput);
      if (!actions.length) {
        const raw = JSON.stringify(modelOutput);
        this.context.trace?.(
          '模型未给动作',
          0,
          `字段：${Object.keys(modelOutput ?? {}).join(', ')} · 末尾：${raw.slice(-300)}`,
        );
        throw new ResponseParseError('模型未返回可执行动作；请依据当前观察选择工具，完成时显式调用 done。');
      }
      modelOutput.action = actions;
      modelOutputString = JSON.stringify(modelOutput);

      // remove the last state message from memory before adding the model output
      this.removeLastStateMessageFromMemory();
      this.addModelOutputToMemory(modelOutput);

      // take the actions
      started = Date.now();
      actionResults = await this.doMultiAction(actions);
      this.context.trace?.(
        '本步动作合计',
        Date.now() - started,
        actions.map(action => Object.keys(action)[0]).join(', '),
      );
      // logger.info('Action results', JSON.stringify(actionResults, null, 2));

      this.context.actionResults = actionResults;

      // check if the task is paused or stopped
      if (this.context.stopped || (this.context.paused && actionResults.length === 0)) {
        cancelled = true;
        return agentOutput;
      }
      // 工具把可恢复错误作为 ActionResult 返回；仍须让执行器累计失败，不能记为 STEP_OK。
      // 保留完整 actionResults/history，供下一轮修正及停止后的恢复使用。
      const actionError = actionResults.find(result => result.error && !result.fieldFailure)?.error;
      if (actionError) {
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, actionError);
        agentOutput.error = actionError;
        return agentOutput;
      }
      // emit event
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, 'Navigation done');
      let done = false;
      if (actionResults.length > 0 && actionResults[actionResults.length - 1].isDone) {
        done = true;
      }
      const finalAction = done ? actionResults[actionResults.length - 1] : null;
      if (finalAction) {
        this.context.completionSuccess = finalAction.success;
        this.context.finalAnswer = finalAction.extractedContent;
      }
      agentOutput.result = { done, success: finalAction?.success };
      return agentOutput;
    } catch (error) {
      this.removeLastStateMessageFromMemory();
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.trace?.('步骤出错', 0, error instanceof Error ? error.stack || error.message : String(error));
      // Check if this is an authentication error
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isExtensionConflictError(error)) {
        throw new ExtensionConflictError(EXTENSION_CONFLICT_ERROR_MESSAGE, error);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      } else if (error instanceof URLNotAllowedError) {
        throw error;
      }

      const errorString = `Navigation failed: ${errorMessage}`;
      logger.error(errorString);
      this.context.actionResults = [
        new ActionResult({ error: describeAgentFailure('执行失败', error), includeInMemory: true }),
      ];
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, describeAgentFailure('执行失败', error));
      agentOutput.error = errorMessage;
      return agentOutput;
    } finally {
      // if the task is cancelled, remove the last state message from memory and emit event
      if (cancelled) {
        this.removeLastStateMessageFromMemory();
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_CANCEL, 'Navigation cancelled');
      }
      if (browserStateHistory) {
        // Create a copy of actionResults to store in history
        const actionResultsCopy = actionResults.map(result => {
          return new ActionResult({
            isDone: result.isDone,
            success: result.success,
            extractedContent: result.extractedContent,
            error: result.error,
            includeInMemory: result.includeInMemory,
            interactedElement: result.interactedElement,
          });
        });

        const history = new AgentStepRecord(modelOutputString, actionResultsCopy, browserStateHistory);
        this.context.history.history.push(history);

        // logger.info('All history', JSON.stringify(this.context.history, null, 2));
      }
    }
  }

  /** 首屏已在网申表单页时直接执行整页填写，省去首轮 Planner 与 Navigator 空转。 */
  async executeInitialFormFill(): Promise<AgentOutput<NavigatorResult> | null> {
    if (
      Object.prototype.hasOwnProperty.call(this, 'invoke') ||
      !this.actionRegistry.getAction('fill_application_form')
    ) {
      return null;
    }

    const started = Date.now();
    const currentState = await this.context.browserContext.getState(this.context.options.useVision);
    const raw = collectOutline(currentState.elementTree);
    const fieldCount = raw.filter(item => item.kind === 'field').length;
    const hasPasswordInput = [...(currentState.selectorMap?.values() ?? [])].some(
      node =>
        (node.tagName ?? '').toLowerCase() === 'input' && (node.attributes.type ?? '').toLowerCase() === 'password',
    );
    if (fieldCount < 2 || (hasPasswordInput && fieldCount <= 4)) {
      return null;
    }

    const agentOutput: AgentOutput<NavigatorResult> = { id: this.id };
    let cancelled = false;
    let modelOutputString: string | null = null;
    const browserStateHistory = new BrowserStateHistory(currentState);
    let actionResults: ActionResult[] = [];

    try {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...');
      this.context.trace?.('观察页面', Date.now() - started, `首屏检测到 ${fieldCount} 个表单字段，直接进入整页填写`);

      if (this.context.stopped || this.context.paused) {
        cancelled = true;
        return agentOutput;
      }

      const actions = [{ fill_application_form: { intent: '整页读取并填写当前表单' } }];
      const modelOutput = {
        current_state: {
          evaluation_previous_goal: 'Unknown - Initial form observation',
          memory: `当前页面检测到 ${fieldCount} 个表单字段，直接执行整页填写。`,
          next_goal: '整页读取并填写当前表单',
        },
        action: actions,
      };
      modelOutputString = JSON.stringify(modelOutput);
      this.addModelOutputToMemory(modelOutput);

      const actionStarted = Date.now();
      actionResults = await this.doMultiAction(actions);
      this.context.trace?.('本步动作合计', Date.now() - actionStarted, 'fill_application_form');
      this.context.actionResults = actionResults;

      if (this.context.stopped || (this.context.paused && actionResults.length === 0)) {
        cancelled = true;
        return agentOutput;
      }

      const actionError = actionResults.find(result => result.error && !result.fieldFailure)?.error;
      if (actionError) {
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, actionError);
        agentOutput.error = actionError;
        return agentOutput;
      }

      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, 'Navigation done');
      agentOutput.result = { done: false };
      return agentOutput;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.trace?.('步骤出错', 0, error instanceof Error ? error.stack || error.message : String(error));
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isExtensionConflictError(error)) {
        throw new ExtensionConflictError(EXTENSION_CONFLICT_ERROR_MESSAGE, error);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      } else if (error instanceof URLNotAllowedError) {
        throw error;
      }

      logger.error(`Navigation failed: ${errorMessage}`);
      this.context.actionResults = [
        new ActionResult({ error: describeAgentFailure('执行失败', error), includeInMemory: true }),
      ];
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, describeAgentFailure('执行失败', error));
      agentOutput.error = errorMessage;
      return agentOutput;
    } finally {
      if (cancelled) {
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_CANCEL, 'Navigation cancelled');
      }
      const actionResultsCopy = actionResults.map(
        result =>
          new ActionResult({
            isDone: result.isDone,
            success: result.success,
            extractedContent: result.extractedContent,
            error: result.error,
            includeInMemory: result.includeInMemory,
            interactedElement: result.interactedElement,
          }),
      );
      this.context.history.history.push(new AgentStepRecord(modelOutputString, actionResultsCopy, browserStateHistory));
    }
  }

  /**
   * Add the state message to the memory
   */
  public async addStateMessageToMemory() {
    if (this.context.stateMessageAdded) {
      return;
    }

    const messageManager = this.context.messageManager;
    // Handle results that should be included in memory
    if (this.context.actionResults.length > 0) {
      let index = 0;
      for (const r of this.context.actionResults) {
        if (r.includeInMemory) {
          if (r.extractedContent) {
            const msg = new HumanMessage(`Action result: ${r.extractedContent}`);
            // logger.info('Adding action result to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          if (r.error) {
            // Get error text and convert to string
            const errorText = r.error.toString().trim();

            // Get only the last line of the error
            const lastLine = errorText.split('\n').pop() || '';

            const msg = new HumanMessage(`Action error: ${lastLine}`);
            logger.info('Adding action error to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          // reset this action result to empty, we dont want to add it again in the state message
          // NOTE: in python version, all action results are reset to empty, but in ts version, only those included in memory are reset to empty
          this.context.actionResults[index] = new ActionResult();
        }
        index++;
      }
    }

    const state = await this.prompt.getUserMessage(this.context);
    messageManager.addStateMessage(state);
    this.context.stateMessageAdded = true;
  }

  /**
   * Remove the last state message from the memory
   */
  protected async removeLastStateMessageFromMemory() {
    if (!this.context.stateMessageAdded) return;
    const messageManager = this.context.messageManager;
    messageManager.removeLastStateMessage();
    this.context.stateMessageAdded = false;
  }

  private async addModelOutputToMemory(modelOutput: this['ModelOutput']) {
    const messageManager = this.context.messageManager;
    messageManager.addModelOutput(modelOutput);
  }

  /**
   * Fix the actions to be an array of objects, sometimes the action is a string or an object
   * @param response
   * @returns
   */
  private fixActions(response: this['ModelOutput']): Record<string, unknown>[] {
    let actions: Record<string, unknown>[] = [];
    // 模型偶尔把 action 写进 current_state 里，挪回来而不是整步作废。
    const nested = (response.current_state as { action?: unknown } | undefined)?.action;
    if (response.action == null && nested != null) {
      response.action = nested as typeof response.action;
      delete (response.current_state as { action?: unknown }).action;
    }
    if (Array.isArray(response.action)) {
      actions = response.action;
    } else if (typeof response.action === 'string') {
      try {
        logger.warning('Unexpected action format', response.action);
        // First try to parse the action string directly
        actions = JSON.parse(response.action);
      } catch (parseError) {
        try {
          // If direct parsing fails, try to fix the JSON first
          const fixedAction = repairJsonString(response.action);
          logger.info('Fixed action string', fixedAction);
          actions = JSON.parse(fixedAction);
        } catch (error) {
          logger.error('Invalid action format even after repair attempt', response.action);
          throw new Error('Invalid action output format');
        }
      }
    } else {
      actions = [response.action];
    }
    // 模型偶尔返回 action: null 或空项；只保留形如 {动作名: 参数} 的对象，其余视为没给动作。
    actions = (Array.isArray(actions) ? actions : [actions]).filter(
      (item: unknown) =>
        item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0,
    );
    if (actions.length === 0) logger.warning('No valid actions found', response.action);
    return actions;
  }

  private async doMultiAction(actions: Record<string, unknown>[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let errCount = 0;
    const formBatch = Boolean(this.context.options.targetOrigin);
    actions = actions.slice(0, this.context.options.maxActionsPerStep);
    logger.info('Actions', actions);

    const browserContext = this.context.browserContext;
    const browserState = formBatch
      ? await browserContext.getCachedState(this.context.options.useVision)
      : await browserContext.getState(this.context.options.useVision);
    const targets = actions.flatMap(action => {
      const [name] = Object.keys(action);
      const index = this.actionRegistry.getAction(name)?.getIndexArg(action[name]);
      return typeof index === 'number' ? [index] : [];
    });
    const structureKey = formBatch ? formStructureKey(browserState, targets) : null;
    const cachedPathHashes = await calcBranchPathHashSet(browserState);

    await browserContext.removeHighlight();
    let fingerprint: string | null = null;

    for (const [i, action] of actions.entries()) {
      const actionName = Object.keys(action)[0];
      const actionArgs = action[actionName];
      try {
        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }

        const actionInstance = this.actionRegistry.getAction(actionName);
        if (actionInstance === undefined) {
          throw new Error(`Action ${actionName} not exists`);
        }

        const indexArg = actionInstance.getIndexArg(actionArgs);
        // 批量中结构变化必须停下。首个动作前完整重扫（模型思考期间页面可能变化）并取轻量指纹；
        // 之后只比指纹。拿不到指纹的环境仍每次完整重扫。
        if (formBatch && indexArg !== null && fingerprint !== null) {
          const checkStarted = Date.now();
          const current = await browserContext.formFingerprint?.();
          this.context.trace?.('批量结构指纹', Date.now() - checkStarted);
          if (current !== fingerprint) {
            results.push(
              new ActionResult({
                extractedContent: '页面结构或目标已变化，已停止剩余批量动作。请根据新观察重新规划。',
                includeInMemory: true,
              }),
            );
            break;
          }
        } else if (formBatch && indexArg !== null) {
          const scanStarted = Date.now();
          const freshState = await browserContext.getState(this.context.options.useVision);
          this.context.trace?.('批量前重扫页面', Date.now() - scanStarted);
          if (formStructureKey(freshState, targets) !== structureKey) {
            this.context.trace?.('批量中止', 0, '要填写的控件在模型思考期间发生了变化');
            results.push(
              new ActionResult({
                extractedContent: '页面结构或目标已变化，已停止剩余批量动作。请根据新观察重新规划。',
                includeInMemory: true,
              }),
            );
            break;
          }
          fingerprint = (await browserContext.formFingerprint?.()) ?? null;
        } else if (!formBatch && i > 0 && indexArg !== null) {
          const newState = await browserContext.getState(this.context.options.useVision);
          const newPathHashes = await calcBranchPathHashSet(newState);
          // next action requires index but there are new elements on the page
          if (![...newPathHashes].every(hash => cachedPathHashes.has(hash))) {
            const msg = `Something new appeared after action ${i} / ${actions.length}`;
            logger.info(msg);
            results.push(
              new ActionResult({
                extractedContent: msg,
                includeInMemory: true,
              }),
            );
            break;
          }
        }

        if (formBatch) {
          const observed = await browserContext.getCachedState(this.context.options.useVision);
          const actionKey = applicationActionKey(actionName, actionArgs as Record<string, unknown>, observed);
          if (actionKey) {
            const key = `${applicationProgressKey(observed)}\n${actionKey}`;
            const attempts = (this.noProgressActions ??= new Map());
            const count = attempts.get(key) ?? 0;
            if (count >= 2) {
              results.push(
                new ActionResult({
                  error:
                    'NO_PAGE_PROGRESS: 同一页面状态下该动作已经执行两次，未观察到变化，已阻止重复点击。请处理页面校验提示或其他独立字段；只剩暂缓项时以部分完成结束，不要反复保存或切换同一入口。',
                  includeInMemory: true,
                }),
              );
              break;
            }
            attempts.set(key, count + 1);
            if (attempts.size > 64) attempts.delete(attempts.keys().next().value!);
          }
        }
        const actionStarted = Date.now();
        const result = await actionInstance.call(actionArgs);
        const intent = (actionArgs as { intent?: unknown } | undefined)?.intent;
        this.context.trace?.(
          `动作 ${actionName}`,
          Date.now() - actionStarted,
          [typeof intent === 'string' ? intent : '', result?.error ? `失败：${result.error}` : '']
            .filter(Boolean)
            .join(' · '),
        );
        if (result === undefined) {
          throw new Error(`Action ${actionName} returned undefined`);
        }

        // if the action has an index argument, record the interacted element to the result
        if (indexArg !== null) {
          const domElement = browserState.selectorMap.get(indexArg);
          if (domElement) {
            const interactedElement = HistoryTreeProcessor.convertDomElementToHistoryElement(domElement);
            result.interactedElement = interactedElement;
            logger.info('Interacted element', interactedElement);
            logger.info('Result', result);
          }
        }
        results.push(result);
        if (
          formBatch &&
          ((result.error && !result.fieldFailure) || result.isDone || !isPlainFormInput(action, browserState))
        )
          break;

        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }
        // Page input/navigation already waits for browser readiness.
        if (!formBatch) await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          'doAction error',
          actionName,
          JSON.stringify(actionArgs, null, 2),
          JSON.stringify(errorMessage, null, 2),
        );
        this.context.trace?.(
          `动作 ${actionName} 异常`,
          0,
          `${JSON.stringify(actionArgs)}\n${error instanceof Error ? error.stack || errorMessage : errorMessage}`,
        );
        // unexpected error, emit event
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMessage);
        errCount++;
        if (errCount > 3) {
          throw new Error('Too many errors in actions');
        }
        results.push(
          new ActionResult({
            error: errorMessage,
            isDone: false,
            includeInMemory: true,
          }),
        );
        if (formBatch) break;
      }
    }
    return results;
  }

  executeHistoryStep(
    historyItem: AgentStepRecord,
    stepIndex: number,
    totalSteps: number,
    maxRetries = 3,
    delay = 1000,
    skipFailures = true,
  ) {
    return replayHistoryStep(
      {
        context: this.context,
        executeActions: actions => this.doMultiAction(actions),
        updateIndices: (element, action, state) => this.updateActionIndices(element, action, state),
      },
      historyItem,
      stepIndex,
      totalSteps,
      maxRetries,
      delay,
      skipFailures,
    );
  }

  updateActionIndices(element: DOMHistoryElement, action: Record<string, unknown>, state: BrowserState) {
    return updateActionIndices(this.actionRegistry, element, action, state);
  }
}
