import type { AgentEvent } from './agent/event/types';
import { actionProgress } from './applicationProgress';

import { fieldHighlightCSS } from './browser/fieldFeedback';
import {
    renderApplicationFeedback,
    renderApplicationFloatingEntry,
    type FeedbackFieldFillResponse,
    type FeedbackIssueReport,
    type FeedbackIssueReportResult,
    type FeedbackQuestion,
    type FeedbackState,
} from './feedbackOverlay';
import { feedbackReviewCounts, summarizeReviewEntries } from './feedbackSummary';

export interface ApplicationFeedbackAnswerPayload {
  questionId: string;
  decision: 'answer' | 'confirm_replace' | 'skip' | 'defer';
  text: string;
  selectedOptions?: string[];
}

export interface FeedbackFieldFillPayload {
  key: string;
  value: string;
  selectedOptions?: string[];
}

export interface ApplicationFeedbackHandlers {
  resume?: () => Promise<void>;
  answer?: (payload: ApplicationFeedbackAnswerPayload) => Promise<boolean>;
  openWorkbench?: () => Promise<void>;
  launchFromFloating?: (tab: chrome.tabs.Tab) => Promise<void>;
  listFieldOptions?: (payload: {
    key: string;
    query?: string;
  }, tabId: number) => Promise<{ ok?: boolean; options: string[]; typable?: boolean; multiple?: boolean; error?: string }>;
  fillField?: (payload: FeedbackFieldFillPayload, tabId: number) => Promise<FeedbackFieldFillResponse>;
  fieldAction?: (key: string, action: 'locate' | 'check', tabId: number) => Promise<void>;
  reportIssue?: (report: FeedbackIssueReport, summaryText: string) => Promise<FeedbackIssueReportResult>;
  dismiss?: (tabId: number) => Promise<void> | void;
}

const ALLOWED_ISSUE_REASONS = new Set(['控件填不进去', '日期/下拉选错', '漏填必填项', '字段识别错位', '其他问题']);

function sanitizeReportUrl(rawUrl: string, fallbackOrigin: string): { pageHost: string; pageUrl: string } {
  try {
    const parsed = new URL(rawUrl || fallbackOrigin);
    const path = parsed.pathname.split('/').map(segment => {
      const decoded = decodeURIComponent(segment);
      return /@|\d{7,}|^[\w-]{28,}$/.test(decoded) ? '[redacted]' : segment;
    }).join('/');
    const pageUrl = (parsed.origin + path).slice(0, 300);
    return { pageHost: parsed.host.slice(0, 120), pageUrl };
  } catch {
    return { pageHost: fallbackOrigin.replace(/^https?:\/\//, '').slice(0, 120), pageUrl: fallbackOrigin.slice(0, 300) };
  }
}

function formatIssueReportSummary(report: FeedbackIssueReport): string {
  const lines = [
    `[职小搭网申适配反馈] ${report.pageUrl}`,
    `状态：${report.mode === 'done' ? '已结束' : '已暂停'} · 已填 ${report.filledCount} 项 · 未填/待核对 ${report.unfilledFields.length} 项`,
  ];
  if (report.reasons.length > 0) lines.push(`问题类型：${report.reasons.join('、')}`);
  if (report.unfilledFields.length > 0) {
    const fields = report.unfilledFields
      .slice(0, 12)
      .map(item => item.label)
      .join('；');
    lines.push(`相关字段：${fields}`);
  }
  return lines.join('\n');
}

export class ApplicationFeedback {
  private tabId: number | null = null;
  private state: FeedbackState | null = null;
  private beforePause: FeedbackState | null = null;
  private traceLines: string[] | null = null;
  private pageStageFloor: 0 | 1 | 2 = 0;
  private batchFillDone = false;
  private lastTabUrl = '';
  private queue: Promise<unknown> = Promise.resolve();

  private advanceStage(candidate: 0 | 1 | 2): 0 | 1 | 2 {
    if (candidate > this.pageStageFloor) this.pageStageFloor = candidate;
    return this.pageStageFloor;
  }

  constructor(
    private pause: () => Promise<void>,
    private handlers: ApplicationFeedbackHandlers = {},
  ) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      const type = message?.type;
      if (type === 'application_floating_launch' || type === 'application_floating_open_settings') {
        if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id) {
          respond({ ok: false });
          return false;
        }
        const action = type === 'application_floating_open_settings'
          ? this.handlers.openWorkbench?.()
          : this.handlers.launchFromFloating?.(sender.tab);
        void Promise.resolve(action)
          .then(() => respond({ ok: true }))
          .catch(() => respond({ ok: false }));
        return true;
      }
      if (
        type !== 'application_feedback_pause' &&
        type !== 'application_feedback_resume' &&
        type !== 'application_feedback_answer' &&
        type !== 'application_feedback_open_workbench' &&
        type !== 'application_feedback_list_options' &&
        type !== 'application_feedback_fill_field' &&
        type !== 'application_feedback_field_action' &&
        type !== 'application_feedback_copy_trace' &&
        type !== 'application_feedback_report_issue' &&
        type !== 'application_feedback_dismiss'
      )
        return false;
      const state = this.state;
      const postTaskAction =
        type === 'application_feedback_field_action' ||
        type === 'application_feedback_dismiss' ||
        type === 'application_feedback_list_options' ||
        type === 'application_feedback_fill_field' ||
        type === 'application_feedback_open_workbench';
      if (
        sender.id !== chrome.runtime.id ||
        sender.frameId !== 0 ||
        !sender.tab?.id ||
        !sender.url ||
        (state
          ? sender.tab.id !== this.tabId ||
            message.taskId !== state.taskId ||
            message.token !== state.token ||
            new URL(sender.url).origin !== state.origin
          : !postTaskAction)
      ) {
        respond({ ok: false });
        return false;
      }
      if (type === 'application_feedback_copy_trace') {
        const trace = this.traceLines?.join('\n') ?? '';
        respond({ ok: Boolean(trace), trace });
        return false;
      }
      if (type === 'application_feedback_report_issue') {
        if (!state || (state.mode !== 'done' && state.mode !== 'paused')) {
          respond({ ok: false, error: '当前状态暂不支持提交适配反馈' });
          return false;
        }
        const { pageHost, pageUrl } = sanitizeReportUrl(sender.url, state.origin);
        const reasons = Array.isArray(message.reasons)
          ? message.reasons
              .filter((v: unknown): v is string => typeof v === 'string' && ALLOWED_ISSUE_REASONS.has(v))
              .slice(0, 6)
          : [];
        const report: FeedbackIssueReport = {
          reportedAt: new Date().toISOString(),
          taskId: state.taskId,
          pageHost,
          pageUrl,
          mode: state.mode,
          stage: typeof state.stage === 'number' ? state.stage : null,
          filledCount: state.filledCount || 0,
          unfilledFields: (state.unfilledItems || []).slice(0, 40).map(item => ({
            label: String(item.label || '').slice(0, 80),
            kind: String(item.kind || 'missing').slice(0, 24),
          })),
          reasons,
        };
        const summaryText = formatIssueReportSummary(report);
        if (!this.handlers.reportIssue) {
          respond({ ok: true, savedLocally: false, delivered: false, summaryText });
          return false;
        }
        void this.handlers
          .reportIssue(report, summaryText)
          .then(result =>
            respond({
              ...result,
              summaryText: result.summaryText || summaryText,
            }),
          )
          .catch(() => respond({ ok: false, error: '诊断保存失败，请稍后重试', summaryText }));
        return true;
      }
      if (type === 'application_feedback_field_action') {
        if (!this.handlers.fieldAction || typeof message.key !== 'string' || !['locate', 'check'].includes(message.action)) {
          respond({ ok: false });
          return false;
        }
        void this.handlers.fieldAction(message.key, message.action, sender.tab.id)
          .then(() => respond({ ok: true }))
          .catch(error => respond({ ok: false, error: error instanceof Error ? error.message : '核查失败' }));
        return true;
      }
      if (type === 'application_feedback_dismiss') {
        void Promise.resolve(this.handlers.dismiss?.(sender.tab.id)).catch(() => {}).then(() => {
          if (this.state === state) this.clear();
          respond({ ok: true });
        });
        return true;
      }
      if (type === 'application_feedback_list_options') {
        if (!this.handlers.listFieldOptions || typeof message.key !== 'string' || !message.key) {
          respond({ ok: false, options: [] });
          return false;
        }
        void this.handlers
          .listFieldOptions({
            key: message.key,
            query: typeof message.query === 'string' ? message.query : undefined,
          }, sender.tab.id)
          .then(res => respond(res))
          .catch(err =>
            respond({
              ok: false,
              options: [],
              error: err instanceof Error ? err.message : '读取候选项失败',
            }),
          );
        return true;
      }
      if (type === 'application_feedback_fill_field') {
        if (!this.handlers.fillField || typeof message.key !== 'string' || !message.key) {
          respond({ ok: false, error: '无效字段标识' });
          return false;
        }
        void this.handlers
          .fillField({
            key: message.key,
            value: typeof message.value === 'string' ? message.value : '',
            selectedOptions: Array.isArray(message.selectedOptions)
              ? message.selectedOptions.filter((v: unknown): v is string => typeof v === 'string')
              : undefined,
          }, sender.tab.id)
          .then(res => respond(res))
          .catch(err =>
            respond({
              ok: false,
              error: err instanceof Error ? err.message : '写入失败',
            }),
          );
        return true;
      }
      if (type === 'application_feedback_open_workbench') {
        void Promise.resolve(this.handlers.openWorkbench?.())
          .then(() => {
            this.clear();
            respond({ ok: true });
          })
          .catch(() => respond({ ok: false }));
        return true;
      }
      if (type === 'application_feedback_pause') {
        if (state?.mode !== 'running') {
          respond({ ok: false });
          return false;
        }
        void this.pause()
          .then(() => respond({ ok: true }))
          .catch(() => respond({ ok: false }));
        return true;
      }
      if (type === 'application_feedback_resume') {
        if (state?.mode !== 'paused' || !this.handlers.resume) {
          respond({ ok: false });
          return false;
        }
        void this.handlers
          .resume()
          .then(() => respond({ ok: true }))
          .catch(() => respond({ ok: false }));
        return true;
      }
      if (type === 'application_feedback_answer') {
        if (state?.mode !== 'waiting' || !this.handlers.answer) {
          respond({ ok: false });
          return false;
        }
        void this.handlers
          .answer({
            questionId: String(message.questionId || state.question?.id || ''),
            decision: message.decision,
            text: typeof message.text === 'string' ? message.text : '',
            selectedOptions: message.selectedOptions,
          })
          .then(ok => respond({ ok }))
          .catch(() => respond({ ok: false }));
        return true;
      }
      return false;
    });
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (tabId !== this.tabId) return;
      if (typeof change.url === 'string' && change.url) {
        if (this.lastTabUrl && change.url !== this.lastTabUrl) {
          this.pageStageFloor = 0;
          this.batchFillDone = false;
          if (this.state?.mode === 'running') {
            this.state = {
              ...this.state,
              stage: 0,
              title: '正在读取页面结构',
              detail: '已进入新页面，正在识别表单控件…',
            };
          }
        }
        this.lastTabUrl = change.url;
      }
      if (change.status === 'complete' && this.state?.mode !== 'done') this.render();
    });
  }

  start(taskId: string, tabId: number, origin: string, detail = '正在识别页面中的表单控件…', debug = false) {
    this.clear();
    if (debug) this.traceLines = [];
    this.tabId = tabId;
    this.pageStageFloor = 0;
    this.batchFillDone = false;
    this.lastTabUrl = '';
    this.state = {
      taskId,
      token: crypto.randomUUID(),
      origin,
      title: '正在读取页面结构',
      detail,
      mode: 'running',
      stage: 0,
      step: 0,
      canCopyTrace: debug,
      question: null,
      filledCount: 0,
      unfilledItems: [],
    };
    this.render();
  }

  showConnectPrompt(tabId: number, origin: string, detail?: string, title = '尚未配置简历与模型', buttonText = '打开简历与模型设置 ↗') {
    this.clear();
    this.tabId = tabId;
    this.state = {
      taskId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      origin,
      title,
      detail: detail || '请先导入本地简历并配置模型 API，保存后在招聘网页点击插件图标或右下角浮标即可一键填写。',
      mode: 'connect',
      step: 0,
      question: null,
      buttonText,
    };
    this.render();
  }

  syncFloatingEntry(tabId: number, enabled: boolean, resumeName?: string) {
    if (this.tabId === tabId && this.state) return;
    void chrome.scripting
      ?.executeScript?.({
        target: { tabId },
        func: renderApplicationFloatingEntry,
        args: [{ enabled, resumeName }],
      })
      ?.catch?.(() => undefined);
  }

  show() {
    if (this.tabId !== null && this.state) this.render();
  }

  move(tabId: number, origin?: string) {
    if (!this.state) return;
    const nextOrigin = origin || this.state.origin;
    if (this.tabId === tabId && this.state.origin === nextOrigin) return;
    if (this.tabId !== tabId) {
      this.inject(this.tabId, null);
      this.pageStageFloor = 0;
      this.batchFillDone = false;
      this.lastTabUrl = '';
    }
    this.tabId = tabId;
    this.state = { ...this.state, origin: nextOrigin };
    if (this.beforePause) {
      this.beforePause = { ...this.beforePause, origin: nextOrigin };
    }
    this.render();
  }

  setPaused(paused: boolean, background = false) {
    if (!this.state || this.state.mode === 'done') return;
    if (paused) {
      if (this.state.mode !== 'paused') this.beforePause = this.state;
      this.state = {
        ...this.state,
        mode: 'paused',
        stage: this.pageStageFloor,
        title: background ? '填写已暂停' : '已暂停',
        detail: background ? '请返回申请页面后继续填写。' : '你可以先在网页操作，随时点击右侧「继续填写」。',
      };
    } else if (this.beforePause) {
      this.state = this.beforePause;
      this.beforePause = null;
    }
    this.render();
  }

  answered() {
    if (!this.state || this.state.mode === 'done') return;
    const stage = this.pageStageFloor;
    this.state = {
      ...this.state,
      mode: 'running',
      stage,
      title: stage >= 2 ? '正在复核全页字段' : stage === 1 ? '正在填入个人资料' : '正在读取页面结构',
      detail: '已收到确认，正在继续处理当前页面…',
      question: null,
    };
    this.render();
  }

  event(event: AgentEvent) {
    if (!this.state || event.data.taskId !== this.state.taskId) return;
    if (event.state === 'user.question.dismissed') {
      try {
        const { questionId } = JSON.parse(event.data.details);
        const waiting = this.state.mode === 'paused' ? this.beforePause : this.state;
        if (waiting?.mode !== 'waiting' || waiting.question?.id !== questionId || !waiting.question?.blockingDialog) return;
        const stage = this.pageStageFloor;
        const resumed: FeedbackState = {
          ...waiting,
          mode: 'running',
          stage,
          question: null,
          title: stage >= 2 ? '正在复核全页字段' : stage === 1 ? '正在填入个人资料' : '正在读取页面结构',
          detail: '网页弹窗已关闭，继续处理当前页面。',
        };
        if (this.state.mode === 'paused') {
          this.beforePause = resumed;
          this.state = { ...this.state, question: null };
        } else this.state = resumed;
        this.render();
      } catch {
        /* A stale or malformed dismissal cannot clear another question. */
      }
      return;
    }
    if (
      this.traceLines &&
      ['task.start', 'task.ok', 'task.partial', 'task.fail', 'task.cancel', 'act.start', 'act.fail', 'step.fail'].includes(event.state)
    ) {
      this.appendTrace(event.data.step, event.state, event.data.details, event.timestamp);
    }
    if (event.state === 'review.updated') {
      try {
        const parsed = JSON.parse(event.data.details || '[]');
        if (Array.isArray(parsed)) {
          const { filledCount, unfilledItems, adaptedItems } = summarizeReviewEntries(parsed);
          if (filledCount > 0) this.advanceStage(1);
          const nextStage =
            this.state.mode === 'done'
              ? this.state.stage
              : (Math.max(this.state.stage ?? 0, this.pageStageFloor) as 0 | 1 | 2);
          let nextTitle = this.state.title;
          let nextDetail = this.state.detail;
          let nextWarn = this.state.warn;
          if (
            this.state.mode === 'done' &&
            (this.state.stage ?? 3) >= 3 &&
            ((this.state.unfilledItems?.length || 0) > 0 || unfilledItems.length > 0)
          ) {
            const { optionalCount: optCount, actionableCount: actCount, auditIncomplete, verifyCount } = feedbackReviewCounts(unfilledItems);
            nextWarn = actCount > 0 || verifyCount > 0 || auditIncomplete;
            nextTitle =
              actCount > 0
                ? optCount > 0
                  ? `仍有 ${actCount} 项信息未填写（另有 ${optCount} 项选填）`
                  : `仍有 ${actCount} 项信息未填写`
                : verifyCount > 0 ? `有 ${verifyCount} 项待核对`
                : auditIncomplete ? '整表核查未完成' : '填写完成，请核对后提交';
            nextDetail =
              actCount > 0
                ? '可在下方报备列表直接补填，或点击下方报备列表中的定位按钮核对网页位置。'
                : verifyCount > 0 ? '可定位到网页查看当前内容。'
                : auditIncomplete ? '已填写的内容已保留，可在下方重新核查。'
                : optCount > 0
                  ? `已自动填写 ${filledCount} 项；下方 ${optCount} 项为网页选填项，可直接在面板补填或留空。`
                  : '申请尚未提交，请核对网页中的填写内容后手动提交。';
          }
          this.state = {
            ...this.state,
            stage: nextStage,
            warn: nextWarn,
            title: nextTitle,
            detail: nextDetail,
            filledCount,
            unfilledItems,
            adaptedItems,
          };
          if (this.beforePause) {
            this.beforePause = {
              ...this.beforePause,
              stage: nextStage,
              filledCount,
              unfilledItems,
              adaptedItems,
            };
          }
          this.render();
        }
      } catch {
        /* Ignore malformed review snapshot. */
      }
      return;
    }
    if (event.state === 'debug.trace') {
      try {
        const trace = JSON.parse(event.data.details || '{}') as { phase?: string; ms?: number; detail?: string };
        if (this.traceLines && typeof trace.phase === 'string' && typeof trace.ms === 'number') {
          this.appendTrace(event.data.step, `${trace.phase} ${trace.ms}ms`, trace.detail, event.timestamp);
        }
        if (this.state.mode !== 'running') return;
        let title = this.state.title;
        let detail = '';
        let stage = this.pageStageFloor;
        if (trace.phase === '整页填写 · 读取表单' && stage === 0) {
          const countMatch = typeof trace.detail === 'string' ? trace.detail.match(/(\d+)\s*个字段/) : null;
          title = '正在读取页面结构';
          detail = countMatch ? `已发现 ${countMatch[1]} 个表单控件，正在梳理模块关系…` : '正在识别页面中的表单控件…';
        } else if (trace.phase === '整页填写 · 缓存快填') {
          stage = this.advanceStage(1);
          title = '正在填入个人资料';
          detail = '正在匹配常用资料并快速填入…';
        } else if (trace.phase === '整页填写 · 写入') {
          this.batchFillDone = true;
          stage = this.advanceStage(2);
          title = '正在复核全页字段';
          detail = '主要字段已写入，正在复核页面必填与校验状态…';
        } else if (trace.phase === '观察页面') {
          if (this.batchFillDone || (stage >= 1 && (this.state.filledCount || 0) > 0 && event.data.step > 0)) {
            stage = this.advanceStage(2);
            title = '正在复核全页字段';
            detail = '正在逐项核对必填状态与页面校验提示…';
          } else if (stage >= 1) {
            title = '正在填入个人资料';
            detail = '正在确认表单最新控件状态…';
          } else {
            title = '正在读取页面结构';
            detail = '正在识别页面中的表单控件…';
          }
        } else if (trace.phase === '规划') {
          if (stage >= 2) {
            title = '正在复核全页字段';
            detail = '正在梳理剩余核查项…';
          } else if (stage === 1) {
            title = '正在填入个人资料';
            detail = '正在规划下一步填写内容…';
          } else {
            title = '正在读取页面结构';
            detail = '正在规划当前页面步骤…';
          }
        } else if (trace.phase === '模型决策' && typeof trace.detail === 'string') {
          const match = trace.detail.match(/打算：([^\n]+)/);
          if (match?.[1]) {
            const cleaned = match[1]
              .replace(/\([a-z_]+\)/gi, '')
              .replace(/\[\d+\]/g, '')
              .trim();
            if (cleaned) {
              if (stage >= 1 && /核对|结束|完成/.test(cleaned) && !/填写|展开|添加/.test(cleaned)) {
                stage = this.advanceStage(2);
                title = '正在复核全页字段';
              }
              detail = `下一步：${cleaned}`;
            }
          }
        } else if (trace.phase === '批量中止') {
          detail = '页面内容发生变化，正在重新扫描…';
        }
        if ((detail && detail !== this.state.detail) || title !== this.state.title || stage !== this.state.stage) {
          this.state = {
            ...this.state,
            stage,
            title,
            detail: (detail || this.state.detail).slice(0, 180),
          };
          this.render();
        }
      } catch {
        /* Ignore malformed trace payloads. */
      }
      return;
    }
    const terminal = ['task.ok', 'task.partial', 'task.fail', 'task.cancel'].includes(event.state);
    if (this.state.mode === 'done' || (this.state.mode === 'paused' && !terminal)) return;
    if (event.state === 'user.question') {
      let title = '等待你确认';
      let detail = '请根据提示在网页完成操作或确认。';
      let question: FeedbackQuestion | null = null;
      if (event.data.details) {
        try {
          const parsed = JSON.parse(event.data.details);
          if (parsed && typeof parsed.question === 'string' && parsed.question.trim()) {
            const isReplacement = Boolean(
              parsed.replacement || (Array.isArray(parsed.replacements) && parsed.replacements.length),
            );
            const kind = parsed.kind === 'manual_action' ? 'manual_action' : 'information';
            title =
              kind === 'manual_action'
                ? '请先在网页完成操作'
                : isReplacement
                  ? '请确认是否替换已有内容'
                  : '请补充申请信息';
            if (isReplacement && Array.isArray(parsed.replacements) && parsed.replacements.length) {
              const items = parsed.replacements
                .slice(0, 2)
                .map(
                  (r: { field?: { label?: string }; currentValue?: string; proposedValue?: string }) =>
                    `${r.field?.label || '字段'}：「${r.currentValue || ''}」→「${r.proposedValue || ''}」`,
                )
                .join('；');
              detail = `${parsed.question} ${items}`;
            } else {
              detail = parsed.question.trim();
            }
            const rawField = parsed.field && typeof parsed.field === 'object' ? parsed.field : null;
            question = {
              id: String(parsed.id || ''),
              kind,
              blockingDialog: kind === 'manual_action' && parsed.blockingDialog === true,
              question: parsed.question.trim(),
              options: Array.isArray(parsed.options)
                ? parsed.options.filter((o: unknown): o is string => typeof o === 'string')
                : [],
              multiple: parsed.multiple === true,
              replacement: isReplacement,
              ...(rawField && typeof rawField.key === 'string'
                ? {
                    field: {
                      key: rawField.key,
                      ...(typeof rawField.legacyKey === 'string' ? { legacyKey: rawField.legacyKey } : {}),
                      label: typeof rawField.label === 'string' ? rawField.label : '',
                      ...(typeof rawField.index === 'number' ? { index: rawField.index } : {}),
                    },
                  }
                : {}),
            };
          }
        } catch {
          /* Keep fallback text when details is not JSON. */
        }
      }
      this.state = {
        ...this.state,
        mode: 'waiting',
        stage: this.pageStageFloor,
        title,
        detail: detail.slice(0, 220),
        step: event.data.step,
        question,
      };
      this.render();
      return;
    }
    const progress = actionProgress(event.data.details);
    const items = this.state.unfilledItems || [];
    const { optionalCount, actionableCount, auditIncomplete, verifyCount } = feedbackReviewCounts(items);
    const unfilledCount = items.length;
    const filledCount = this.state.filledCount || 0;
    const hasProgress = filledCount > 0 || unfilledCount > 0;
    const doneTitle =
      actionableCount > 0
        ? optionalCount > 0
          ? `本轮填写结束 · 有 ${actionableCount} 项信息未填写（另有 ${optionalCount} 项选填）`
          : `本轮填写结束 · 有 ${actionableCount} 项信息未填写`
        : verifyCount > 0 ? `有 ${verifyCount} 项待核对`
                : auditIncomplete ? '整表核查未完成' : '填写完成，请核对后提交';
    const adaptedItems = this.state.adaptedItems || [];
    const adaptedSummary =
      adaptedItems.length > 0
        ? `（已按官网词库匹配：${adaptedItems
            .slice(0, 2)
            .map(item => `${item.label}「${item.actualValue}」`)
            .join('、')}${adaptedItems.length > 2 ? ` 等 ${adaptedItems.length} 项` : ''}）`
        : '';
    const doneDetail =
      actionableCount > 0
        ? `已自动填写 ${filledCount} 项，可在下方报备列表直接补填，或点击定位到对应位置核对。`
        : verifyCount > 0 ? '可定位到网页查看当前内容。'
                : auditIncomplete ? '已填写的内容已保留，可在下方重新核查。'
        : optionalCount > 0
          ? `已自动填写 ${filledCount} 项；下方 ${optionalCount} 项为网页选填项，可直接在面板补填或留空。`
          : adaptedSummary
            ? `申请尚未提交，请核对网页中的填写内容后手动提交${adaptedSummary}。`
            : '申请尚未提交，请核对网页中的填写内容后手动提交。';

    let nextStage: 0 | 1 | 2 | 3 = this.pageStageFloor;
    let stepTitle = '正在读取页面结构';
    let stepDetail = '正在识别页面中的表单控件…';
    if (event.state === 'step.start') {
      if (this.batchFillDone || (this.pageStageFloor >= 1 && filledCount > 0 && event.data.step > 0)) {
        nextStage = this.advanceStage(2);
        stepTitle = '正在复核全页字段';
        stepDetail = '正在逐项核对必填状态与页面校验提示…';
      } else if (this.pageStageFloor === 1) {
        nextStage = 1;
        stepTitle = '正在填入个人资料';
        stepDetail = '正在继续检查并填写表单…';
      }
    } else if (event.state === 'act.start') {
      const rawStage = (typeof progress.stage === 'number' ? progress.stage : 1) as 0 | 1 | 2;
      nextStage = this.advanceStage(rawStage);
      if (rawStage === 0 && nextStage > 0) {
        stepTitle = nextStage >= 2 ? '正在复核全页字段' : '正在填入个人资料';
      } else {
        stepTitle = progress.title;
      }
      stepDetail = progress.detail;
    } else if (event.state === 'task.ok') {
      nextStage = 3;
    } else if (event.state === 'task.partial' || event.state === 'task.fail') {
      nextStage = hasProgress ? 3 : this.pageStageFloor;
    }

    const rawEventDetail = (event.data.details || '').replace(/\s+/g, ' ').trim();
    const partialFallbackDetail =
      rawEventDetail && rawEventDetail !== '本轮仍有未完成项，请核对清单。'
        ? rawEventDetail
        : '请检查网页未完成项或补充后继续。';

    const updates: Record<string, [FeedbackState['mode'], string, string, boolean?]> = {
      'task.start': ['running', '正在读取页面结构', '正在识别页面中的表单控件…'],
      'step.start': ['running', stepTitle, stepDetail],
      'act.start': ['running', stepTitle, stepDetail],
      'act.fail': [
        'running',
        this.pageStageFloor >= 2 ? '正在复核全页字段' : '正在调整填写方式',
        '当前项需进一步确认，正在继续处理其余内容…',
      ],
      'step.fail': [
        'running',
        this.pageStageFloor >= 2 ? '正在复核全页字段' : '正在重新检查页面',
        '上一操作未完成，正在调整处理方式…',
      ],
      'task.ok': ['done', doneTitle, doneDetail, actionableCount > 0 || verifyCount > 0 || auditIncomplete],
      'task.partial': [
        'done',
        actionableCount > 0
          ? optionalCount > 0
            ? `仍有 ${actionableCount} 项信息未填写（另有 ${optionalCount} 项选填）`
            : `仍有 ${actionableCount} 项信息未填写`
          : verifyCount > 0 ? `有 ${verifyCount} 项待核对`
                : auditIncomplete ? '整表核查未完成'
          : optionalCount > 0
            ? '填写完成，请核对后提交'
            : '仍有内容需要核对',
        actionableCount > 0
          ? '可在下方报备列表直接补填，或点击下方报备列表中的定位按钮核对网页位置。'
          : auditIncomplete || verifyCount > 0 || optionalCount > 0
            ? doneDetail
            : partialFallbackDetail,
        actionableCount > 0 || verifyCount > 0 || auditIncomplete || optionalCount === 0,
      ],
      'task.fail': [
        'done',
        hasProgress ? doneTitle : '未能完成自动填写',
        hasProgress ? doneDetail : '请检查网页或稍后重试。',
        !hasProgress || actionableCount > 0 || verifyCount > 0 || auditIncomplete,
      ],
      'task.cancel': ['done', '已停止填写', '已填写的内容会保留。', true],
    };
    const update = updates[event.state];
    if (!update) return;
    const [mode, title, detail, warn] = update;
    this.state = {
      ...this.state,
      mode,
      stage: nextStage,
      warn: mode === 'done' ? Boolean(warn) : false,
      title,
      detail: detail.slice(0, 180),
      step: event.data.step,
      question: null,
    };
    this.render();
  }

  finish(detail?: string) {
    if (!this.state || this.state.mode === 'done') return;
    if (detail) this.appendTrace(this.state.step, 'task.fail', detail);
    const items = this.state.unfilledItems || [];
    const { optionalCount, actionableCount, auditIncomplete, verifyCount } = feedbackReviewCounts(items);
    const unfilledCount = items.length;
    const filledCount = this.state.filledCount || 0;
    const hasProgress = filledCount > 0 || unfilledCount > 0;
    this.state = {
      ...this.state,
      mode: 'done',
      stage: hasProgress ? 3 : this.pageStageFloor,
      warn: !hasProgress || actionableCount > 0 || verifyCount > 0 || auditIncomplete,
      title: hasProgress
        ? actionableCount > 0
          ? optionalCount > 0
            ? `本轮填写结束 · 有 ${actionableCount} 项信息未填写（另有 ${optionalCount} 项选填）`
            : `本轮填写结束 · 有 ${actionableCount} 项信息未填写`
          : verifyCount > 0 ? `有 ${verifyCount} 项待核对`
                : auditIncomplete ? '整表核查未完成' : '填写完成，请核对后提交'
        : '已停止填写',
      detail: (
        detail ||
        (hasProgress
          ? actionableCount > 0
            ? `已自动填写 ${filledCount} 项，可在下方报备列表直接补填，或点击定位到对应位置核对。`
            : verifyCount > 0 ? '可定位到网页查看当前内容。'
                : auditIncomplete ? '已填写的内容已保留，可在下方重新核查。'
            : optionalCount > 0
              ? `已自动填写 ${filledCount} 项；下方 ${optionalCount} 项为网页选填项，可直接在面板补填或留空。`
              : '申请尚未提交，请核对网页中的填写内容后手动提交。'
          : '已填写的内容会保留，请检查网页或再次点击插件图标继续。')
      ).slice(0, 180),
    };
    this.render();
  }

  clear() {
    this.inject(this.tabId, null);
    this.tabId = null;
    this.state = null;
    this.beforePause = null;
    this.traceLines = null;
    this.pageStageFloor = 0;
    this.batchFillDone = false;
    this.lastTabUrl = '';
  }
  private appendTrace(step: number, phase: string, detail?: string, timestamp = Date.now()) {
    if (!this.traceLines) return;
    const time = new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    const suffix = typeof detail === 'string' && detail ? ` · ${detail.slice(0, 2000)}` : '';
    this.traceLines.push(`${time} 第${step}步 ${phase}${suffix}`);
    if (this.traceLines.length > 2000) this.traceLines.shift();
  }

  private render() {
    this.inject(this.tabId, this.state);
  }
  private inject(tabId: number | null, state: FeedbackState | null) {
    if (tabId === null) return;
    // Serialize updates so a slow earlier injection cannot overwrite pause/completion.
    this.queue = this.queue
      .then(async () => {
        const args: [FeedbackState | null, string] = [state, fieldHighlightCSS];
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: renderApplicationFeedback,
          args,
        });
        const document = results?.[0];
        if (document?.result !== false) return;
        // Never install a renderer in a different document if navigation wins this race.
        const target = { tabId, documentIds: [document.documentId] };
        await chrome.scripting.executeScript({ target, files: ['feedback-overlay.js'] });
        await chrome.scripting.executeScript({ target, func: renderApplicationFeedback, args });
      })
      .catch(() => undefined); // Navigation/closed tabs must not break the filling task.
  }
}
