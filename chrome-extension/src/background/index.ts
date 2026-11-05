import 'webextension-polyfill';
import { siteFor } from './sitePolicy';
import { ApplicationFeedback } from './applicationFeedback';
import { ApplicationForeground } from './applicationForeground';
import { generalSettingsStore } from '@extension/storage';
import { t } from '@extension/i18n';
import BrowserContext from './browser/context';
import { Executor } from './agent/executor';
import { createLogger } from './log';
import { ModelDecisionClient } from './decisionClient';
import { readConfig } from '../settings/config';
import { ExecutionState } from './agent/event/types';
import {
  readApplicationCheckpoint,
  saveApplicationCheckpoint,
  discardApplicationCheckpoint,
  canRestoreApplication,
  type ApplicationCheckpoint,
} from './applicationSession';

const logger = createLogger('background');

const browserContext = new BrowserContext({});
let currentExecutor: Executor | null = null;
let taskRunning = false;
let pauseRequested = false;
// Every window has its own side panel. A run belongs to the panel that started it, so other
// windows opening or closing their panels can neither receive its events nor cancel it.
let taskPort: chrome.runtime.Port | null = null;
const panelWindows = new WeakMap<chrome.runtime.Port, number>();
const sessionMetadata = new WeakMap<Executor, Omit<ApplicationCheckpoint, 'progress' | 'updatedAt' | 'status'>>();
const SIDE_PANEL_URL = chrome.runtime.getURL('job-panel/index.html');
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const applicationFeedback = new ApplicationFeedback(async () => {
  if (!taskRunning) throw new Error('任务已结束。');
  await setApplicationPaused(true);
});

const applicationForeground = new ApplicationForeground(state => {
  if (!taskRunning || !currentExecutor) return;
  // pause()/resume() change the execution flag synchronously; do not delay behind UI injection.
  if (state.paused) void currentExecutor.pause();
  else void currentExecutor.resume();
  applicationFeedback.setPaused(state.paused, state.background);
  taskPort?.postMessage({ type: 'task_control', taskId: currentExecutor.taskId, ...state });
});

async function setApplicationPaused(paused: boolean) {
  pauseRequested = paused;
  await applicationForeground.setManual(paused);
}

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

// Listen for debugger detached event
// if canceled_by_user, remove the tab from the browser context
chrome.debugger.onDetach.addListener(async (source, reason) => {
  console.log('Debugger detached:', source, reason);
  if (reason === 'canceled_by_user') {
    if (source.tabId) {
      currentExecutor?.cancel();
      await browserContext.cleanup();
    }
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  if (taskRunning && tabId === browserContext.getConfig().applyTargetTabId) {
    applicationForeground.stop();
    void currentExecutor?.cancel();
  }
  browserContext.removeAttachedPage(tabId);
});

logger.info('background loaded');

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'side-panel-connection') {
    const senderUrl = port.sender?.url;
    const senderId = port.sender?.id;

    if (!senderUrl || senderId !== chrome.runtime.id || senderUrl !== SIDE_PANEL_URL) {
      logger.warning('Blocked unauthorized side-panel-connection', senderId, senderUrl);
      port.disconnect();
      return;
    }

    port.onMessage.addListener(async message => {
      if (
        ![
          'hello',
          'heartbeat',
          'new_task',
          'restore_task',
          'get_checkpoint',
          'discard_checkpoint',
          'answer_user',
          'pause_task',
          'resume_task',
          'return_to_application',
          'application_field_action',
          'cancel_task',
        ].includes(message?.type)
      )
        return;
      if (['answer_user', 'pause_task', 'resume_task', 'cancel_task', 'return_to_application'].includes(message.type) && port !== taskPort)
        return;
      if (message.type === 'application_field_action' && taskRunning && port !== taskPort)
        return;
      try {
        switch (message.type) {
          case 'hello':
            if (Number.isInteger(message.windowId)) panelWindows.set(port, message.windowId);
            port.postMessage({ type: 'agent_ready', protocol: 10 });
            break;
          case 'get_checkpoint': {
            // The running task keeps rewriting this snapshot; other windows must not offer to restore it.
            const candidate = taskRunning && port !== taskPort ? null : await readApplicationCheckpoint();
            const { applyConfig } = await chrome.storage.local.get('applyConfig');
            const saved = candidate?.target.windowId === panelWindows.get(port) &&
              candidate?.source.hash === applyConfig?.resume.revision ? candidate : null;
            port.postMessage({
              type: 'checkpoint',
              checkpoint: saved
                ? {
                    taskId: saved.taskId,
                    updatedAt: saved.updatedAt,
                    status: saved.status,
                    target: saved.target,
                    source: saved.source,
                    review: saved.progress.review,
                  }
                : null,
            });
            break;
          }
          case 'discard_checkpoint':
            if (taskRunning) throw new Error('请先停止当前操作后再清除进度。');
            await discardApplicationCheckpoint();
            port.postMessage({ type: 'checkpoint', checkpoint: null });
            break;
          case 'heartbeat':
            // Acknowledge heartbeat
            port.postMessage({ type: 'heartbeat_ack' });
            break;

          case 'answer_user': {
            if (message.taskId !== currentExecutor?.taskId || !currentExecutor?.answerUserQuestion(message.answer)) {
              port.postMessage({ type: 'answer_rejected', error: '问题已过期或回答为空，请重新检查。' });
            } else {
              await persistProgress(currentExecutor!, 'user.answer');
              port.postMessage({ type: 'answer_accepted', questionId: message.answer.questionId });

            }
            break;
          }
          case 'restore_task':
          case 'new_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_newTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            logger.info('new_task', message.tabId);
            if (taskRunning) {
              if (port !== taskPort) return port.postMessage({ type: 'task_busy' });
              throw new Error('已有任务正在执行，请先暂停或关闭当前侧栏。');
            }
            taskRunning = true;
            taskPort = port;
            currentExecutor = null;
            pauseRequested = false;
            browserContext.updateCurrentTabId(message.tabId);
            try {
              const saved = message.type === 'restore_task' ? await readApplicationCheckpoint() : null;
              if (message.type === 'restore_task' && (!saved || saved.taskId !== message.checkpointId))
                throw new Error('保存的进度已变化，请刷新侧栏后重试。');
              currentExecutor = await setupExecutor(
                message.taskId,
                message.task,
                browserContext,
                message.tabId,
                saved,
                message.rebind === true,
              );
              if (taskPort !== port) {
                await currentExecutor.cancel();
                return;
              }
              applicationFeedback.start(
                message.taskId,
                browserContext.getConfig().applyTargetTabId!,
                browserContext.getConfig().applyTargetOrigin!,
              );
              await applicationForeground.start(browserContext.getConfig().applyTargetTabId!, pauseRequested);
              await persistProgress(currentExecutor, 'task.start');
              subscribeToExecutorEvents(currentExecutor);
              await currentExecutor.execute();
            } finally {
              applicationForeground.stop();
              await currentExecutor?.cleanup();
              applicationFeedback.finish();
              taskRunning = false;
            }
            break;
          }

          case 'cancel_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            await currentExecutor.cancel();
            break;
          }

          case 'return_to_application': {
            if (taskRunning && currentExecutor) await applicationForeground.returnToTarget();
            break;
          }

          case 'application_field_action': {
            if (typeof message.key !== 'string' || !['locate', 'retry', 'check', 'skip'].includes(message.action)) return;
            const replyTaskId = message.taskId ?? currentExecutor?.taskId;
            try {
              if (!currentExecutor || (message.taskId && message.taskId !== currentExecutor.taskId)) {
                if (taskRunning) return;
                const saved = await readApplicationCheckpoint();
                if (
                  !saved ||
                  (message.taskId && saved.taskId !== message.taskId) ||
                  (saved.target?.windowId !== undefined && panelWindows.get(port) !== saved.target.windowId)
                ) {
                  port.postMessage({
                    type: 'field_action_result',
                    taskId: replyTaskId,
                    key: message.key,
                    action: message.action,
                    error: '当前页面无法核对这个字段，请重新检查表单后再试。',
                  });
                  return;
                }
                currentExecutor = await restoreCheckpointExecutor(saved);
                taskPort = port;
              }
              if (taskRunning) await setApplicationPaused(true);
              await currentExecutor.handleFieldAction(message.key, message.action);
              await persistProgress(currentExecutor, taskRunning ? 'task.pause' : 'task.partial');
              port.postMessage({
                type: 'field_action_result',
                taskId: currentExecutor.taskId,
                key: message.key,
                action: message.action,
                review: currentExecutor.exportApplicationProgress().review,
              });
            } catch {
              port.postMessage({
                type: 'field_action_result',
                taskId: currentExecutor?.taskId ?? replyTaskId,
                key: message.key,
                action: message.action,
                error: '当前页面无法核对这个字段，请回到它所在的表单页面后再试。',
              });
            } finally {
              if (!taskRunning) await currentExecutor?.cleanup();
            }
            break;
          }

          case 'resume_task': {
            pauseRequested = false;
            if (!currentExecutor && taskRunning) return port.postMessage({ type: 'success' });
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_cmd_resumeTask_noTask') });
            await setApplicationPaused(false);
            return port.postMessage({ type: 'success' });
          }

          case 'pause_task': {
            pauseRequested = true;
            if (!currentExecutor && taskRunning) return port.postMessage({ type: 'success' });
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            await setApplicationPaused(true);
            return port.postMessage({ type: 'success' });
          }

          default:
            return port.postMessage({ type: 'error', error: t('errors_cmd_unknown', [message.type]) });
        }
      } catch (error) {
        console.error('Error handling port message:', error);
        port.postMessage({ type: 'error', error: error instanceof Error ? error.message : t('errors_unknown') });
      }
    });
    port.onDisconnect.addListener(() => {
      console.log('Side panel disconnected');
      if (taskPort === port) {
        taskPort = null;
        applicationForeground.stop();
        currentExecutor?.cancel();
        applicationFeedback.clear();
      }

    });
  }
});

async function restoreCheckpointExecutor(saved: ApplicationCheckpoint): Promise<Executor> {
  const targetTab = await chrome.tabs.get(saved.target.tabId);
  const site = siteFor(targetTab.url || '');
  if (!site) throw new Error('请等待目标招聘网页加载完成后继续。');
  if (!(await chrome.permissions.contains({ origins: [site.pattern] })))
    throw new Error('请在扩展管理页启用网站访问权限，然后重试。');
  const target = {
    tabId: saved.target.tabId,
    windowId: targetTab.windowId,
    origin: site.origin,
    jobId: saved.target.jobId ?? null,
    url: targetTab.url || '',
  };
  if (saved.target.url !== target.url || saved.source.hash !== (await readConfig()).resume.revision || !canRestoreApplication(saved, target, false))
    throw new Error('此进度属于另一岗位、窗口或网站，请回到原目标页面恢复。');
  browserContext.updateConfig({
    allowedUrls: [site.host],
    deniedUrls: [],
    applyTargetOrigin: site.origin,
    applyTargetTabId: saved.target.tabId,
    applyTargetWindowId: targetTab.windowId,
  });
  browserContext.updateCurrentTabId(saved.target.tabId);
  const executor = new Executor(saved.progress.task || '填写当前岗位网申', saved.taskId, browserContext, {} as never, {
    agentOptions: {
      targetTabId: saved.target.tabId,
      targetOrigin: site.origin,
    },
  });
  executor.restoreApplicationProgress(saved.progress);
  sessionMetadata.set(executor, { version: 1, taskId: saved.taskId, target, source: saved.source });
  return executor;
}

async function setupExecutor(
  taskId: string,
  task: string,
  browserContext: BrowserContext,
  tabId: number,
  saved: ApplicationCheckpoint | null = null,
  explicitlyRebind = false,
): Promise<Executor> {
  const targetTab = await chrome.tabs.get(tabId);
  const site = siteFor(targetTab.url || '');
  if (!site) throw new Error('请等待目标招聘网页加载完成后继续。');
  if (!(await chrome.permissions.contains({ origins: [site.pattern] })))
    throw new Error('请在扩展管理页启用网站访问权限，然后重试。');
  const targetOrigin = site.origin;
  const config = await readConfig();
  if (saved && saved.source.hash !== config.resume.revision) throw new Error('简历已更换，请重新开始填写。');
  const target = {
    tabId,
    windowId: targetTab.windowId,
    origin: targetOrigin,
    jobId: saved?.target.jobId ?? targetTab.url ?? null,
    url: targetTab.url || '',
  };
  if (saved && (saved.target.url !== target.url || !canRestoreApplication(saved, target, explicitlyRebind)))
    throw new Error('此进度属于另一岗位、窗口或网站，请回到原目标页面恢复。');
  // Apply the target policy before Page captures it.
  browserContext.updateConfig({
    allowedUrls: [site.host],
    deniedUrls: [],
    applyTargetOrigin: site.origin,
    applyTargetTabId: tabId,
    applyTargetWindowId: targetTab.windowId,
  });
  browserContext.updateCurrentTabId(tabId);
  browserContext.onApplyTargetChanged = async newTabId => {
    applicationFeedback.move(newTabId);
    await applicationForeground.move(newTabId);
    taskPort?.postMessage({ type: 'target_changed', taskId, tabId: newTabId });
    const tab = await chrome.tabs.get(newTabId);
    if (currentExecutor) {
      const metadata = sessionMetadata.get(currentExecutor);
      if (metadata) metadata.target = { ...metadata.target, tabId: newTabId, url: tab.url || metadata.target.url };
    }
  };
  const page = await browserContext.getCurrentPage();
  const source = { name: config.resume.name, hash: config.resume.revision };
  // Key and endpoint stay in the transport. Only the reviewed text enters model history and checkpoints.
  task = saved?.progress.task ?? '<resume_evidence>\n' +
    JSON.stringify({ confirmedResumeText: config.resume.text }).replaceAll('<', '\\u003c') + '\n</resume_evidence>';
  const navigatorLLM = new ModelDecisionClient(config);

  const generalSettings = {
    ...(await generalSettingsStore.getSettings()),
    maxSteps: 100,
    replayHistoricalTasks: false,
    maxActionsPerStep: 8,
    useVision: false,
    useVisionForPlanner: false,
    planningInterval: 4,
    displayHighlights: false,
  };
  browserContext.updateConfig({
    minimumWaitPageLoadTime: generalSettings.minWaitPageLoad / 1000.0,
    displayHighlights: generalSettings.displayHighlights,
    viewportExpansion: -1,
  });

  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: navigatorLLM,
    agentOptions: {
      targetTabId: page.tabId,
      targetOrigin,
      maxSteps: generalSettings.maxSteps,
      maxFailures: generalSettings.maxFailures,
      maxActionsPerStep: generalSettings.maxActionsPerStep,
      useVision: generalSettings.useVision,
      useVisionForPlanner: false,
      planningInterval: generalSettings.planningInterval,
      debug: false,
    },
    generalSettings: generalSettings,
  });
  if (saved) executor.restoreApplicationProgress(saved.progress);
  sessionMetadata.set(executor, { version: 1, taskId, target, source });

  return executor;
}

// Update subscribeToExecutorEvents to use port
async function subscribeToExecutorEvents(executor: Executor) {
  // Clear previous event listeners to prevent multiple subscriptions
  executor.clearExecutionEvents();

  // Subscribe to new events
  executor.subscribeExecutionEvents(async event => {
    if (currentExecutor === executor) applicationFeedback.event(event);
    if (event.state !== ExecutionState.DEBUG_TRACE) {
      await persistProgress(executor, event.state);
    }
    try {
      taskPort?.postMessage(event);
    } catch (error) {
      logger.error('Failed to send message to side panel:', error);
    }
  });
}

async function persistProgress(executor: Executor, status: string) {
  const metadata = sessionMetadata.get(executor);
  if (!metadata || currentExecutor !== executor) return;
  try {
    const progress = executor.exportApplicationProgress();
    await saveApplicationCheckpoint({ ...metadata, updatedAt: Date.now(), status, progress });
  } catch (error) {
    taskPort?.postMessage({
      type: 'checkpoint_error',
      error: error instanceof Error ? error.message : '进度保存失败',
    });
  }
}
