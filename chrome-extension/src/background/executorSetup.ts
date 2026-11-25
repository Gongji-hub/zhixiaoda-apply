import { generalSettingsStore } from '@extension/storage';
import { readConfig } from '../settings/config';
import { Executor } from './agent/executor';
import { canRestoreApplication, type ApplicationCheckpoint } from './applicationSession';
import { ModelDecisionClient } from './decisionClient';
import { siteFor } from './sitePolicy';
import { browserContext, sessionMetadata } from './taskRuntime';

export async function setupExecutor(taskId: string, tabId: number, saved?: ApplicationCheckpoint): Promise<Executor> {
  const [tab, config] = await Promise.all([chrome.tabs.get(tabId), readConfig()]);
  const site = siteFor(tab.url || '');
  if (!site) throw new Error('请等待目标招聘网页加载完成后继续。');
  if (!(await chrome.permissions.contains({ origins: [site.pattern] }))) {
    throw new Error('请在扩展管理页启用网站访问权限，然后重试。');
  }
  const target = { tabId, windowId: tab.windowId, origin: site.origin, jobId: saved?.target.jobId ?? site.url, url: site.url };
  if (saved && (saved.target.url !== target.url || !canRestoreApplication(saved, target))) {
    throw new Error('此进度属于另一岗位、窗口或网站，请回到原目标页面恢复。');
  }
  if (saved && saved.source.hash !== config.resume.revision) throw new Error('简历已更换，请重新开始填写。');

  const task = '<resume_evidence>\n' +
    JSON.stringify({ confirmedResumeText: config.resume.text }).replaceAll('<', '\\u003c') + '\n</resume_evidence>';
  const model = new ModelDecisionClient({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey });
  const generalSettings = {
    ...(await generalSettingsStore.getSettings()),
    planningInterval: 0,
    maxSteps: 100,
    maxActionsPerStep: 8,
    useVision: false,
    useVisionForPlanner: false,
    displayHighlights: false,
    replayHistoricalTasks: false,
  };
  browserContext.updateConfig({
    applyTargetTabId: tabId,
    applyTargetWindowId: tab.windowId,
    applyTargetOrigin: site.origin,
    allowedUrls: [],
    deniedUrls: [],
    displayHighlights: false,
    viewportExpansion: -1,
    minimumWaitPageLoadTime: generalSettings.minWaitPageLoad / 1000,
  });
  browserContext.updateCurrentTabId(tabId);
  const executor = new Executor(task, taskId, browserContext, model, {
    generalSettings,
    agentOptions: {
      ...generalSettings,
      targetTabId: tabId,
      targetOrigin: site.origin,
      debug: false,
      resumeFile: config.autoUploadResume === false ? null : config.resumeFile ?? null,
    },
  });
  if (saved) executor.restoreApplicationProgress(saved.progress);
  sessionMetadata.set(executor, { version: 1, taskId, target, source: { name: config.resume.name, hash: config.resume.revision } });
  return executor;
}

export function restoreCheckpointExecutor(saved: ApplicationCheckpoint): Promise<Executor> {
  return setupExecutor(saved.taskId, saved.target.tabId, saved);
}
