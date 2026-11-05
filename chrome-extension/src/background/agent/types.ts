import { z } from 'zod';
import { UserInputGate } from './userInput';
import type BrowserContext from '../browser/context';
import { DEFAULT_INCLUDE_ATTRIBUTES } from '../browser/dom/views';
import type { DOMHistoryElement } from '../browser/dom/history/view';
import type MessageManager from './messages/service';
import type { EventManager } from './event/manager';
import { Actors, ExecutionState, AgentEvent } from './event/types';
import { AgentStepHistory } from './history';
import { FormReview, ReplacementApprovals } from './formReview';
import { FormRetries } from './formRetries';

export interface AgentOptions {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  retryDelay: number;
  maxInputTokens: number;
  maxErrorLength: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  includeAttributes: string[];
  planningInterval: number;
  targetTabId?: number;
  targetOrigin?: string;
  /** 本地调试配置开启时，向面板发送各阶段耗时；上线构建不开启。 */
  debug?: boolean;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  maxSteps: 100,
  maxActionsPerStep: 10,
  maxFailures: 3,
  retryDelay: 10,
  maxInputTokens: 128000,
  maxErrorLength: 400,
  useVision: false,
  useVisionForPlanner: true,
  includeAttributes: DEFAULT_INCLUDE_ATTRIBUTES,
  planningInterval: 3,
};

export class AgentContext {
  readonly userInput = new UserInputGate();
  readonly review = new FormReview();
  readonly replacements = new ReplacementApprovals();
  readonly formRetries = new FormRetries();
  completionSuccess: boolean | null = null;
  controller: AbortController;
  taskId: string;
  browserContext: BrowserContext;
  messageManager: MessageManager;
  eventManager: EventManager;
  options: AgentOptions;
  paused: boolean;
  stopped: boolean;
  consecutiveFailures: number;
  nSteps: number;
  stepInfo: AgentStepInfo | null;
  actionResults: ActionResult[];
  stateMessageAdded: boolean;
  history: AgentStepHistory;
  finalAnswer: string | null;
  /** 本轮原始任务（含资料与简历原文），整页填写据此出方案。 */
  applicationTask?: string;

  constructor(
    taskId: string,
    browserContext: BrowserContext,
    messageManager: MessageManager,
    eventManager: EventManager,
    options: Partial<AgentOptions>,
  ) {
    this.controller = new AbortController();
    this.taskId = taskId;
    this.browserContext = browserContext;
    this.messageManager = messageManager;
    this.eventManager = eventManager;
    this.options = { ...DEFAULT_AGENT_OPTIONS, ...options };

    this.paused = false;
    this.stopped = false;
    this.nSteps = 0;
    this.consecutiveFailures = 0;
    this.stepInfo = null;
    this.actionResults = [];
    this.stateMessageAdded = false;
    this.history = new AgentStepHistory();
    this.finalAnswer = null;
    this.userInput.onAccepted = (question, answer) => {
      this.messageManager.addUserAnswer(question, answer);
      const reference = question.field ?? {
        key: `question:${question.question}`,
        label: question.question,
        index: -1,
        url: this.options.targetOrigin ?? '',
      };
      const replacements = question.replacements ?? (question.field && question.replacement
        ? [{ ...question.replacement, field: question.field }] : []);
      const fields = replacements.length ? replacements.map(item => item.field) : [reference];
      for (const field of fields) {
        if (answer.decision === 'answer' || answer.decision === 'confirm_replace') {
          this.formRetries.allowAfterHumanAction(field.key);
          this.review.requestRetry(field.key);
        }
        if (answer.decision === 'skip') this.review.recordSkip(field);
        if (answer.decision === 'defer') this.review.recordDeferred(field);
      }
      if (answer.decision === 'confirm_replace')
        for (const replacement of replacements)
          this.replacements.confirm(replacement.tabId, replacement.field.key, replacement.currentValue, replacement.proposedValue);
      void this.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(this.review.snapshot()));
    };
  }

  /** 调试计时：phase 为阶段名，ms 为耗时，detail 为简短补充（动作名、提示长度、错误栈）。 */
  trace(phase: string, ms: number, detail = ''): void {
    if (!this.options.debug) return;
    void this.emitEvent(Actors.SYSTEM, ExecutionState.DEBUG_TRACE, JSON.stringify({ phase, ms: Math.round(ms), detail: detail.slice(0, 2000) }));
  }

  async emitEvent(actor: Actors, state: ExecutionState, eventDetails: string) {
    const event = new AgentEvent(actor, state, {
      taskId: this.taskId,
      step: this.nSteps,
      maxSteps: this.options.maxSteps,
      details: eventDetails,
    });
    await this.eventManager.emit(event);
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
  }

  async stop() {
    this.stopped = true;
    this.controller.abort();
  }
}

export class AgentStepInfo {
  stepNumber: number;
  maxSteps: number;

  constructor(params: { stepNumber: number; maxSteps: number }) {
    this.stepNumber = params.stepNumber;
    this.maxSteps = params.maxSteps;
  }
}

export class ActionResult {
  /** 新增字段待办是可继续的结果；重复访问同一失败字段仍计入整体无进展次数。 */
  fieldFailure: boolean;
  isDone: boolean;
  success: boolean;
  extractedContent: string | null;
  error: string | null;
  includeInMemory: boolean;
  interactedElement: DOMHistoryElement | null;

  constructor(params: Partial<ActionResult> = {}) {
    this.fieldFailure = params.fieldFailure ?? false;
    this.isDone = params.isDone ?? false;
    this.success = params.success ?? false;
    this.interactedElement = params.interactedElement ?? null;
    this.extractedContent = params.extractedContent ?? null;
    this.error = params.error ?? null;
    this.includeInMemory = params.includeInMemory ?? false;
  }
}

export type WrappedActionResult = ActionResult & {
  toolCallId: string;
};

export class StepMetadata {
  stepStartTime: number;
  stepEndTime: number;
  inputTokens: number;
  stepNumber: number;

  constructor(stepStartTime: number, stepEndTime: number, inputTokens: number, stepNumber: number) {
    this.stepStartTime = stepStartTime;
    this.stepEndTime = stepEndTime;
    this.inputTokens = inputTokens;
    this.stepNumber = stepNumber;
  }

  /**
   * Calculate step duration in seconds
   */
  get durationSeconds(): number {
    return this.stepEndTime - this.stepStartTime;
  }
}

export const agentBrainSchema = z
  .object({
    evaluation_previous_goal: z.string(),
    memory: z.string(),
    next_goal: z.string(),
  });

export type AgentBrain = z.infer<typeof agentBrainSchema>;

// Make AgentOutput generic with Zod schema
export interface AgentOutput<T = unknown> {
  /**
   * The unique identifier for the agent
   */
  id: string;

  /**
   * The result of the agent's step
   */
  result?: T;
  /**
   * The error that occurred during the agent's action
   */
  error?: string;
}
