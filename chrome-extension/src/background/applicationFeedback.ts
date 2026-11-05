import type { AgentEvent } from './agent/event/types';
import { actionProgress } from './applicationProgress';

export interface FeedbackState {
  taskId: string;
  token: string;
  origin: string;
  title: string;
  detail: string;
  mode: 'running' | 'paused' | 'waiting' | 'done';
  step: number;
}

/** Runs in the extension's isolated world; page scripts cannot send its control token. */
export function renderApplicationFeedback(state: FeedbackState | null) {
  const key = '__qzApplicationFeedback';
  const scope = window as unknown as Record<string, { host: HTMLElement; update: (next: FeedbackState) => void }>;
  if (!state || location.origin !== state.origin) {
    scope[key]?.host.remove();
    delete scope[key];
    document.getElementById('qz-agent-field-focus')?.remove();
    return;
  }
  if (state.mode !== 'running') document.getElementById('qz-agent-field-focus')?.remove();
  if (scope[key]?.host.isConnected) return scope[key].update(state);
  const host = document.createElement('div');
  host.id = 'qz-agent-feedback';
  host.style.cssText =
    'all:initial!important;position:fixed!important;bottom:20px!important;right:20px!important;width:min(380px,calc(100vw - 32px))!important;z-index:2147483647!important;pointer-events:none!important;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{color-scheme:light}*{box-sizing:border-box}.card{display:flex;gap:12px;align-items:center;padding:12px 14px;border:1px solid #d6e2f1;border-radius:14px;background:#fffffffa;color:#171717;box-shadow:0 8px 28px #0f172a1f;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;pointer-events:auto}
    .mark{display:grid;place-items:center;width:32px;height:32px;flex-shrink:0;background:#eaf3ff;color:#0869d8;border-radius:10px;font-size:16px;font-weight:700}.copy{flex:1;min-width:0}.brand{font-size:11px;color:#68778b}.title{font-weight:650;font-size:13px;color:#171717}.detail{margin-top:2px;font-size:12px;color:#52647b;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}button{flex-shrink:0;font:600 12px system-ui;border:1px solid #ced9e6;border-radius:9px;padding:7px 11px;background:#fff;color:#374151;cursor:pointer}button:hover:not(:disabled){background:#f4f6f8}button:focus-visible{outline:2px solid #0869d866;outline-offset:2px}button:disabled{cursor:default;opacity:.6}.running .mark{animation:breathe 1.6s ease-in-out infinite}@keyframes breathe{50%{opacity:.55}}@media(prefers-reduced-motion:reduce){.running .mark{animation:none}}
  </style><div class="card"><div class="mark" aria-hidden="true">职</div><div class="copy" role="status" aria-live="polite"><div class="brand">职小搭 · 网申助手</div><div class="title"></div><div class="detail"></div></div><button type="button"></button></div>`;
  const card = root.querySelector('.card')!;
  const title = root.querySelector('.title')!;
  const detail = root.querySelector('.detail')!;
  const button = root.querySelector('button')!;
  let current = state;
  const update = (next: FeedbackState) => {
    current = next;
    card.className = `card ${next.mode}`;
    title.textContent = next.mode === 'running' ? '正在填写，请保持此页面在前台' : next.title;
    detail.textContent = next.detail;
    button.textContent = next.mode === 'running' ? '暂停' : next.mode === 'done' ? '关闭' : next.mode === 'paused' ? '已暂停' : '等待确认';
    button.disabled = next.mode === 'paused' || next.mode === 'waiting';
  };
  button.addEventListener('click', event => {
    if (!event.isTrusted) return;
    if (current.mode === 'done') {
      host.remove();
      delete scope[key];
      return;
    }
    button.disabled = true;
    void chrome.runtime
      .sendMessage({ type: 'application_feedback_pause', taskId: current.taskId, token: current.token })
      .then(response => {
        if (!response?.ok) button.disabled = false;
      })
      .catch(() => {
        title.textContent = '连接已断开';
        detail.textContent = '请回到侧栏检查任务状态。';
      });
  });
  scope[key] = { host, update };
  document.documentElement.append(host);
  update(state);
}

export class ApplicationFeedback {
  private tabId: number | null = null;
  private state: FeedbackState | null = null;
  private beforePause: FeedbackState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private pause: () => Promise<void>) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== 'application_feedback_pause') return false;
      const state = this.state;
      if (
        !state ||
        state.mode !== 'running' ||
        sender.id !== chrome.runtime.id ||
        sender.frameId !== 0 ||
        sender.tab?.id !== this.tabId ||
        message.taskId !== state.taskId ||
        message.token !== state.token ||
        !sender.url ||
        new URL(sender.url).origin !== state.origin
      ) {
        respond({ ok: false });
        return false;
      }
      void this.pause()
        .then(() => respond({ ok: true }))
        .catch(() => respond({ ok: false }));
      return true;
    });
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (tabId === this.tabId && change.status === 'complete' && this.state?.mode !== 'done') this.render();
    });
  }

  start(taskId: string, tabId: number, origin: string) {
    this.clear();
    this.tabId = tabId;
    this.state = {
      taskId,
      token: crypto.randomUUID(),
      origin,
      title: '正在检查申请表',
      detail: '请稍候。',
      mode: 'running',
      step: 0,
    };
    this.render();
  }

  move(tabId: number) {
    if (this.tabId === tabId || !this.state) return;
    this.inject(this.tabId, null);
    this.tabId = tabId;
    this.render();
  }

  setPaused(paused: boolean, background = false) {
    if (!this.state || this.state.mode === 'done') return;
    if (paused) {
      if (this.state.mode !== 'paused') this.beforePause = this.state;
      this.state = {
        ...this.state, mode: 'paused',
        title: background ? '填写已暂停' : '已暂停',
        detail: background ? '请返回申请页面后继续填写。' : '你可以修改网页，再到侧栏继续。',
      };
    } else if (this.beforePause) {
      this.state = this.beforePause;
      this.beforePause = null;
    }
    this.render();
  }

  event(event: AgentEvent) {
    if (!this.state || event.data.taskId !== this.state.taskId) return;
    const terminal = ['task.ok', 'task.partial', 'task.fail', 'task.cancel'].includes(event.state);
    if (this.state.mode === 'done' || (this.state.mode === 'paused' && !terminal)) return;
    const progress = actionProgress(event.data.details);
    const updates: Record<string, [FeedbackState['mode'], string, string]> = {
      'task.start': ['running', '正在检查申请表', '请稍候。'],
      'step.start': ['running', '正在检查申请表', '请稍候。'],
      'act.start': ['running', progress.title, progress.detail],
      'act.fail': ['running', '正在检查操作结果', '当前操作未完成，正在重新检查页面。'],
      'user.question': ['waiting', '等待你确认', '请查看侧栏中的问题。'],
      'task.ok': ['done', '本轮填写结束，请核对', '申请尚未提交，请检查网页中的填写内容。'],
      'task.partial': ['done', '仍有内容需要核对', '请查看右侧面板中的未完成项。'],
      'task.fail': ['done', '操作已停止', '请在右侧面板查看原因，已填写的内容会保留。'],
      'task.cancel': ['done', '操作已停止', '已填写的内容会保留。'],
    };
    const update = updates[event.state];
    if (!update) return;
    const [mode, title, detail] = update;
    this.state = { ...this.state, mode, title, detail: detail.slice(0, 180), step: event.data.step };
    this.render();
  }

  finish() {
    if (!this.state || this.state.mode === 'done') return;
    this.state = {
      ...this.state,
      mode: 'done',
      title: '操作已停止',
      detail: '请在右侧面板查看结果，已填写的内容会保留。',
    };
    this.render();
  }

  clear() {
    this.inject(this.tabId, null);
    this.tabId = null;
    this.state = null;
    this.beforePause = null;
  }
  private render() {
    this.inject(this.tabId, this.state);
  }
  private inject(tabId: number | null, state: FeedbackState | null) {
    if (tabId === null) return;
    // Serialize updates so a slow earlier injection cannot overwrite pause/completion.
    this.queue = this.queue
      .then(() =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: renderApplicationFeedback,
          args: [state],
        }),
      )
      .catch(() => undefined); // Navigation/closed tabs must not break the filling task.
  }
}
