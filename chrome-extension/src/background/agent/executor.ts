import type { DecisionClient } from '../decisionClient';
import { ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager, { MessageManagerSettings } from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig } from '@extension/storage';
import { analytics } from '../services/analytics';
import { describeAgentFailure } from './failureDetails';
import { reviewApplicationPage } from './reviewPage';
import type { ApplicationProgress } from '../applicationSession';
import type { UserAnswer } from './userInput';
import { formFieldReference } from './formReview';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: DecisionClient;
  extractorLLM?: DecisionClient;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: DecisionClient,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager(
      new MessageManagerSettings({ preserveEmail: Boolean(extraArgs?.agentOptions?.targetOrigin) }),
    );

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    this.context.applicationTask = task;
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  exportApplicationProgress(): ApplicationProgress {
    return {
      task: this.tasks[0],
      messages: this.context.messageManager.exportCheckpoint(),
      review: this.context.review.snapshot(),
      actionResults: this.context.actionResults,
      nSteps: this.context.nSteps,
      pendingQuestion: this.context.userInput.pending ?? this.context.userInput.interrupted,
    };
  }

  restoreApplicationProgress(saved: ApplicationProgress): void {
    this.tasks = [saved.task];
    this.context.applicationTask = saved.task;
    this.context.messageManager.restoreCheckpoint(saved.messages);
    this.context.review.restore(saved.review);
    for (const entry of saved.review) {
      if (entry.status === 'pending' && entry.autoDeferred === false) {
        this.context.formRetries.allowAfterHumanAction(entry.key);
      }
    }
    this.context.actionResults = saved.actionResults.map(result => new ActionResult({ ...result, isDone: false }));
    this.context.nSteps = saved.nSteps;
    this.context.options.maxSteps += saved.nSteps;
    const lastContent = String(saved.messages?.messages?.at(-1)?.message?.data?.content || '');
    const retryPrompt = lastContent.match(/用户请求重新尝试字段[\s\S]*?保持暂缓。/)?.[0];
    this.context.messageManager.addNewTask(
      `用户选择恢复本轮填写。沿用本轮原始资料、用户回答和明确跳过记录；先重新观察当前网页，不能重放旧动作或使用旧索引。历史替换确认不构成新的覆盖授权，冲突时重新 ask_user(index, proposed_value)。未回答的问题也不是许可。${saved.pendingQuestion ? `中断时待处理问题：${JSON.stringify(saved.pendingQuestion)}` : ''}${retryPrompt ? ` ${retryPrompt}` : ''}`,
    );
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    const allowedMaxSteps = Math.max(0, this.context.options.maxSteps - context.nSteps);

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;
      let completionVerified = false;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        // Run planner periodically for guidance
        if (this.planner && (context.nSteps % context.options.planningInterval === 0 || navigatorDone)) {
          const verifiedByNavigator = navigatorDone;
          navigatorDone = false;
          latestPlanOutput = await this.runPlanner();

          // Check if task is complete after planner run
          if (verifiedByNavigator && this.checkTaskCompletion(latestPlanOutput)) {
            const unresolved = await reviewApplicationPage(context);
            if (!unresolved.length) {
              completionVerified = true;
              break;
            }
            context.completionSuccess = null;
            context.messageManager.addFormReview(unresolved);
          }
        }

        // Execute navigator
        navigatorDone = await this.navigate();
        if (navigatorDone && context.completionSuccess === false) break;
        if (navigatorDone && context.options.targetOrigin && context.completionSuccess === true) {
          // Application done already read back the live form and rejected unresolved fields.
          // A second model approval can disagree or fail forever; it must not reopen a completed run.
          completionVerified = true;
          context.trace?.('本轮结束', 0, 'done 已通过当前页面核对，停止后续规划和填写。');
          break;
        }

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // Determine task completion status
      const isCompleted = completionVerified;

      if (isCompleted) {
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        await this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (context.completionSuccess === false) {
        await this.context.emitEvent(
          Actors.SYSTEM,
          ExecutionState.TASK_PARTIAL,
          this.context.finalAnswer || '本轮仍有未完成项，请核对清单。',
        );
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      if (context.stateMessageAdded) {
        context.messageManager.removeLastStateMessage();
        context.stateMessageAdded = false;
      }
      await this.navigator.addStateMessageToMemory();
      const positionForPlan = this.context.messageManager.length() - 1;

      // Execute planner
      const planOutput = await this.planner.execute();
      if (planOutput.error) throw new Error(planOutput.error);
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(
          `${t('exec_errors_maxFailuresReached')} ${describeAgentFailure('规划失败', error)}`,
        );
      }
      return null;
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(
          `${t('exec_errors_maxFailuresReached')} ${describeAgentFailure('执行失败', error)}`,
        );
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  get taskId(): string {
    return this.context.taskId;
  }

  answerUserQuestion(answer: UserAnswer): boolean {
    return this.context.userInput.answer(answer);
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async handleFieldAction(key: string, action: 'locate' | 'retry' | 'check' | 'skip'): Promise<void> {
    const entry = this.context.review.snapshot().find(item => item.key === key);
    if (!entry) throw new Error('待处理项已变化，请重新检查表单。');
    if (action === 'skip') {
      this.context.review.recordSkip(entry);
      await this.context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(this.context.review.snapshot()));
      return;
    }
    const page = await this.context.browserContext.getCurrentPage();
    await this.context.browserContext.assertApplyTarget(page.tabId);
    const state = await this.context.browserContext.getState();
    const match = [...state.selectorMap].find(([index, node]) => formFieldReference(state, node, index).key === key);
    if (!match) throw new Error('当前页面未找到该字段，请回到它所在的表单页面再处理。');
    const [index, node] = match;
    const field = formFieldReference(state, node, index);
    if (entry.legacyKey && field.legacyKey !== entry.legacyKey)
      throw new Error('字段结构已变化，请重新检查表单后再处理。');
    const live = await page.readApplicationControl(node, this.context.review.chosen(field));
    if (action === 'check') this.context.review.verifyManualEdit(field, live, live.required ?? entry.required);
    else this.context.review.reconcile(field, live, live.required ?? entry.required);
    if (action === 'locate') await page.revealApplicationControl(node);
    if (action === 'retry') {
      this.context.review.requestRetry(key);
      this.context.formRetries.allowAfterHumanAction(key);
      this.context.messageManager.addNewTask(`用户请求重新尝试字段 ${JSON.stringify({ key, label: field.label })}。先重新观察该字段；此请求不授权覆盖已有不同内容，仍需精确替换确认。其他自动暂缓字段保持暂缓。`);
    }
    await this.context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(this.context.review.snapshot()));
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
