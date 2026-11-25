import 'webextension-polyfill';
import { hasReadyConfig } from '../settings/config';
import { ExecutionState } from './agent/event/types';
import type { Executor } from './agent/executor';
import type { UserAnswer } from './agent/userInput';
import { ApplicationForeground } from './applicationForeground';
import { discardApplicationCheckpoint, readApplicationCheckpoint, saveApplicationCheckpoint } from './applicationSession';
import { restoreCheckpointExecutor, setupExecutor } from './executorSetup';
import { ApplicationFeedback } from './feedbackController';
import type { FeedbackIssueReport, FeedbackIssueReportResult } from './feedbackOverlay';
import { siteFor, type Site } from './sitePolicy';
import { browserContext, logger, run, sessionMetadata } from './taskRuntime';

let clearingData = false;
let activeTask: Promise<void> | null = null;
let restoreInProgress: Promise<Executor | null> | null = null;

async function cleanupPostTaskExecutor() {
  if (run.postTaskIdleTimer !== null) clearTimeout(run.postTaskIdleTimer);
  run.postTaskIdleTimer = null;
  const previous = run.postTaskExecutor;
  run.postTaskExecutor = null;
  await previous?.cleanup();
}

function armPostTaskExecutor(executor: Executor) {
  if (run.postTaskIdleTimer !== null) clearTimeout(run.postTaskIdleTimer);
  run.postTaskExecutor = executor;
  run.postTaskIdleTimer = setTimeout(() => void cleanupPostTaskExecutor(), 5 * 60_000);
}

async function acquireFeedbackExecutor(tabId: number): Promise<Executor | null> {
  if (clearingData) return null;
  if (run.taskRunning) return run.currentExecutor;
  if (!run.postTaskExecutor) {
    restoreInProgress ??= (async () => {
      const saved = await readApplicationCheckpoint();
      if (run.taskRunning || saved?.target.tabId !== tabId) return null;
      const restored = await restoreCheckpointExecutor(saved);
      subscribeToExecutorEvents(restored);
      armPostTaskExecutor(restored);
      return restored;
    })().finally(() => { restoreInProgress = null; });
    await restoreInProgress;
  }
  const executor = run.postTaskExecutor;
  const target = executor && sessionMetadata.get(executor)?.target;
  if (!executor || target?.tabId !== tabId || run.taskRunning) return null;
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== target.url || tab.windowId !== target.windowId || run.postTaskExecutor !== executor) return null;
  armPostTaskExecutor(executor);
  return executor;
}

async function acceptFeedbackAnswer(executor: Executor, answer: UserAnswer) {
  await browserContext.reconcileApplyTarget(true).catch(() => {});
  if (executor !== run.currentExecutor || !executor.answerUserQuestion(answer)) return false;
  run.questionAskedUrl = '';
  applicationFeedback.answered();
  await persistProgress(executor, 'user.answer');
  return true;
}

const ADAPTATION_FEEDBACK_STORAGE_KEY = 'jobAgentAdaptationFeedbacks';
let feedbackWrites = Promise.resolve();

async function persistAdaptationFeedback(report: FeedbackIssueReport, summaryText: string): Promise<FeedbackIssueReportResult> {
  if (clearingData) throw new Error('本地数据正在清除。');
  const write = feedbackWrites.then(async () => {
    const existing = (await chrome.storage.local.get(ADAPTATION_FEEDBACK_STORAGE_KEY))[ADAPTATION_FEEDBACK_STORAGE_KEY];
    const reports = Array.isArray(existing) ? existing : [];
    await chrome.storage.local.set({ [ADAPTATION_FEEDBACK_STORAGE_KEY]: [report, ...reports].slice(0, 50) });
  });
  feedbackWrites = write.catch(() => {});
  await write;
  return { ok: true, savedLocally: true, delivered: false, summaryText };
}

const applicationFeedback = new ApplicationFeedback(
  async () => {
    if (!run.taskRunning) throw new Error('任务已结束。');
    await setApplicationPaused(true);
  },
  {
    resume: async () => {
      if (!run.taskRunning) throw new Error('任务已结束。');
      await setApplicationPaused(false);
    },
    answer: async payload => run.currentExecutor ? acceptFeedbackAnswer(run.currentExecutor, payload) : false,
    openWorkbench: () => chrome.runtime.openOptionsPage(),
    launchFromFloating: async tab => { void handleActionClick(tab).catch(() => {}); },
    reportIssue: persistAdaptationFeedback,
    dismiss: async tabId => {
      await restoreInProgress?.catch(() => {});
      if (tabId === browserContext.getConfig().applyTargetTabId) await cleanupPostTaskExecutor();
    },
    fieldAction: async (key, action, tabId) => {
      const executor = await acquireFeedbackExecutor(tabId);
      if (!executor) throw new Error('填写会话已结束，请重新扫描页面。');
      if (run.taskRunning) await setApplicationPaused(true);
      await executor.handleFieldAction(key, action);
      await persistProgress(executor, run.taskRunning ? 'task.pause' : 'task.partial');
    },
    listFieldOptions: async ({ key, query }, tabId) => {
      const executor = await acquireFeedbackExecutor(tabId);
      if (!executor) return { ok: false, options: [], error: '填写会话已结束，请重新点击插件图标扫描页面。' };
      return executor.listFieldOptions(key, query);
    },
    fillField: async ({ key, value, selectedOptions }, tabId) => {
      const executor = await acquireFeedbackExecutor(tabId);
      if (!executor) return { ok: false, error: '填写会话已结束，请重新点击插件图标扫描页面。' };
      if (run.taskRunning) await setApplicationPaused(true);
      const result = await executor.fillFieldValue(key, value, selectedOptions);
      await persistProgress(executor, run.taskRunning ? 'task.pause' : 'task.partial');
      return result;
    },
  },
);

const applicationForeground = new ApplicationForeground(state => {
  if (!run.taskRunning || !run.currentExecutor) return;
  if (state.paused) void run.currentExecutor.pause();
  else void run.currentExecutor.resume();
  applicationFeedback.setPaused(state.paused, state.background);
  if (state.background) void browserContext.reconcileApplyTarget(true).catch(() => {});
});

async function setApplicationPaused(paused: boolean) {
  run.pauseRequested = paused;
  await applicationForeground.setManual(paused);
}

async function handleActionClick(tab: chrome.tabs.Tab) {
  if (clearingData) return;
  if (run.taskRunning) {
    if (tab.id === browserContext.getConfig().applyTargetTabId) applicationFeedback.show();
    else await applicationForeground.returnToTarget().catch(() => {});
    return;
  }
  const site = siteFor(tab.url || '');
  if (!site || tab.id === undefined) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  const { applyConfig } = await chrome.storage.local.get('applyConfig');
  if (clearingData || run.taskRunning) return;
  if (!hasReadyConfig(applyConfig)) {
    applicationFeedback.showConnectPrompt(tab.id, site.origin,
      '请先导入本地简历并配置模型 API，保存后即可在招聘网页一键自动填写。',
      '尚未配置简历与模型', '打开简历与模型设置 ↗');
    return;
  }
  const task = startHeadlessTask(tab.id, site);
  activeTask = task;
  try {
    await task;
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

async function startHeadlessTask(tabId: number, site: Site) {
  if (run.taskRunning) return;
  run.taskRunning = true;
  run.pauseRequested = false;
  run.questionAskedUrl = '';
  const taskId = crypto.randomUUID();
  let readySite = site;
  let feedbackStarted = false;
  try {
    await restoreInProgress?.catch(() => {});
    await cleanupPostTaskExecutor();
    const deadline = Date.now() + 15_000;
    while (!clearingData && Date.now() < deadline) {
      const tab = await chrome.tabs.get(tabId);
      const candidate = siteFor(tab.url || '');
      if (candidate) {
        readySite = candidate;
        if (!tab.status || tab.status === 'complete') break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (clearingData) return;
    applicationFeedback.start(taskId, tabId, readySite.origin);
    feedbackStarted = true;
    const executor = await setupExecutor(taskId, tabId);
    run.currentExecutor = executor;
    if (clearingData) return;
    const target = sessionMetadata.get(executor)!.target;
    applicationFeedback.move(target.tabId, target.origin);
    await applicationForeground.start(target.tabId, run.pauseRequested);
    if (clearingData) return;
    await persistProgress(executor, 'task.start');
    if (clearingData) return;
    subscribeToExecutorEvents(executor);
    await executor.execute();
  } catch (error) {
    if (!feedbackStarted) applicationFeedback.start(taskId, tabId, readySite.origin);
    applicationFeedback.finish(error instanceof Error ? error.message : '暂时无法开始填写，请刷新页面后重试。');
  } finally {
    applicationForeground.stop();
    const finished = run.currentExecutor;
    run.currentExecutor = null;
    try {
      if (finished?.exportApplicationProgress().review.some(item => !['filled', 'skipped', 'preserved'].includes(item.status))) {
        armPostTaskExecutor(finished);
      } else {
        await finished?.cleanup();
      }
    } finally {
      run.taskRunning = false;
      applicationFeedback.finish();
    }
  }
}

async function autoResumeManualActionOnNavigation(fromUrl: string, tabId: number) {
  const executor = run.currentExecutor;
  if (!run.taskRunning || !executor || !/login|passport|sso|signin|auth/i.test(fromUrl)) return;
  const pending = executor.exportApplicationProgress().pendingQuestion;
  if (pending?.kind !== 'manual_action') return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (run.currentExecutor !== executor || !tab.url || (tab.status && tab.status !== 'complete')) return;
    if (!siteFor(tab.url) || /login|passport|sso|signin|auth/i.test(tab.url)) return;
    if (executor.answerUserQuestion({ questionId: pending.id, decision: 'answer', text: '我已完成网页操作，请重新观察页面确认是否可以继续。' })) {
      run.questionAskedUrl = '';
      applicationFeedback.answered();
      await persistProgress(executor, 'user.answer');
    }
  } catch {
    // The tab may have closed while checking its URL.
  }
}

browserContext.onApplyTargetChanged = async tabId => {
  const executor = run.currentExecutor;
  if (!executor) return;
  const tab = await chrome.tabs.get(tabId);
  if (run.currentExecutor !== executor || tabId !== browserContext.getConfig().applyTargetTabId) return;
  const origin = browserContext.getConfig().applyTargetOrigin;
  const metadata = sessionMetadata.get(executor);
  if (metadata) metadata.target = { ...metadata.target, tabId, origin: origin || metadata.target.origin, url: tab.url || metadata.target.url };
  applicationFeedback.move(tabId, origin);
  await applicationForeground.move(tabId);
  await autoResumeManualActionOnNavigation(run.questionAskedUrl, tabId);
};

chrome.action.onClicked.addListener(tab => { void handleActionClick(tab).catch(() => {}); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'standalone_clear_local_data' || sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('settings/index.html')) return false;
  if (clearingData) {
    respond({ ok: false });
    return false;
  }
  clearingData = true;
  void (async () => {
    try {
      await run.currentExecutor?.cancel();
      await activeTask?.catch(() => {});
      await restoreInProgress?.catch(() => {});
      await cleanupPostTaskExecutor();
      applicationFeedback.clear();
      await feedbackWrites;
      await discardApplicationCheckpoint();
      await chrome.storage.local.clear();
      respond({ ok: true });
    } catch {
      respond({ ok: false });
    } finally {
      clearingData = false;
    }
  })();
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!run.taskRunning && change.status === 'complete' && siteFor(tab.url || '')) {
    void chrome.storage.local.get('applyConfig').then(({ applyConfig }) => {
      if (!clearingData && !run.taskRunning && hasReadyConfig(applyConfig)) applicationFeedback.syncFloatingEntry(tabId, true, applyConfig.resume.name);
    }).catch(() => {});
  }
  if (!run.currentExecutor || tab.windowId !== browserContext.getConfig().applyTargetWindowId || (!change.url && change.status !== 'complete')) return;
  void (async () => {
    await browserContext.reconcileApplyTarget(true).catch(() => {});
    if (tabId !== browserContext.getConfig().applyTargetTabId) return;
    const executor = run.currentExecutor;
    const metadata = executor && sessionMetadata.get(executor);
    if (metadata && tab.url && siteFor(tab.url)) metadata.target.url = tab.url;
    if (change.status === 'complete') await autoResumeManualActionOnNavigation(run.questionAskedUrl, tabId);
  })();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.applyConfig || run.taskRunning) return;
  const config: unknown = changes.applyConfig.newValue;
  void chrome.tabs.query({}).then(tabs => {
    if (run.taskRunning) return;
    for (const tab of tabs) {
      if (tab.id === undefined || !siteFor(tab.url || '')) continue;
      if (hasReadyConfig(config)) applicationFeedback.syncFloatingEntry(tab.id, true, config.resume.name);
      else applicationFeedback.syncFloatingEntry(tab.id, false);
    }
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  browserContext.removeAttachedPage(tabId);
  if (tabId !== browserContext.getConfig().applyTargetTabId) return;
  if (!run.taskRunning) {
    void cleanupPostTaskExecutor();
    return;
  }
  void (async () => {
    try {
      await browserContext.reconcileApplyTarget(true);
      const next = browserContext.getConfig().applyTargetTabId;
      if (next !== undefined) await autoResumeManualActionOnNavigation(run.questionAskedUrl || 'https://login.local/', next);
    } catch {
      applicationForeground.stop();
      void run.currentExecutor?.cancel();
    }
  })();
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (reason !== 'canceled_by_user' || source.tabId !== browserContext.getConfig().applyTargetTabId) return;
  run.currentExecutor?.cancel();
  await cleanupPostTaskExecutor();
  await browserContext.cleanup();
});

function subscribeToExecutorEvents(executor: Executor) {
  executor.clearExecutionEvents();
  executor.subscribeExecutionEvents(async event => {
    if (run.currentExecutor !== executor && run.postTaskExecutor !== executor) return;
    if (event.state === ExecutionState.USER_QUESTION) {
      const tabId = browserContext.getConfig().applyTargetTabId;
      if (tabId !== undefined) run.questionAskedUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
    }
    if (event.state === ExecutionState.USER_QUESTION_DISMISSED && !executor.exportApplicationProgress().pendingQuestion) {
      run.questionAskedUrl = '';
    }
    applicationFeedback.event(event);
    if (event.state !== ExecutionState.DEBUG_TRACE) await persistProgress(executor, event.state);
  });
}

async function persistProgress(executor: Executor, status: string) {
  const metadata = sessionMetadata.get(executor);
  if (clearingData || !metadata || (run.currentExecutor !== executor && run.postTaskExecutor !== executor)) return;
  try {
    const progress = executor.exportApplicationProgress();
    await saveApplicationCheckpoint({ ...metadata, updatedAt: Date.now(), status, progress });
  } catch {
    logger.warning('填写进度未能保存到本地');
  }
}
