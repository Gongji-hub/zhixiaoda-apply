(() => {
  const { siteFor } = globalThis.JobApplySitePolicy;
  const { actionProgress } = globalThis.JobApplyProgressCopy;
  const $ = id => document.getElementById(id);
  const motion = globalThis.JobPanelMotion;
  const ui = {
    connection: $('connection'), resumeName: $('resume-name'), resumeMeta: $('resume-meta'),
    fileCheck: $('file-check'), stepCounter: $('step-counter'), statusTitle: $('status-title'),
    statusMessage: $('status-message'), flowPulse: $('flow-pulse'), progress: $('progress-fill'),
    events: $('event-list'), start: $('start-button'), stop: $('stop-button'),
  };
  // Only locally authored messages may be shown as errors; transport/model details stay in diagnostics.
  class PanelError extends Error {}
  let startAction = 'begin';
  function setStep(step) {
    document.body.dataset.step = String(step);
    for (const n of [1, 2, 3]) {
      const node = $(`step-${n}`);
      if (!node) continue;
      node.dataset.state = n < step ? 'done' : n === step ? 'active' : 'upcoming';
      const num = node.querySelector('.step-num');
      if (num) num.textContent = n < step ? '✓' : String(n);
    }
  }
  let settings;
  let activeTabId;
  let running = false;
  let panelWindowId;
  let preparing = false;
  let readinessTimer;
  let preparationNumber = 0;
  let readinessAttempts = 0;
  let checkpoint;
  let restoring = false;
  let checkpointResolve;
  let rebindTarget;
  let restoreCheckpoint;
  let stepNumber = 0;
  let reviewFinished = false;
  let fieldActionPending;
  let resumeFieldRetry = false;
  let lastReview = [];
  let openCompletedOnUpdate = false;
  let feedbackAction;
  let feedbackKind;
  let previewNumber = 0;
  async function refreshMaterials() {
    if (running || preparing || restoring) return;
    const current = ++previewNumber;
    const [{ applyConfig }, tabs] = await Promise.all([
      chrome.storage.local.get('applyConfig'),
      chrome.tabs.query({ active: true, windowId: panelWindowId }),
    ]);
    if (current !== previewNumber || running || preparing || restoring) return;
    const tab = tabs[0];
    const ready = Boolean(applyConfig?.resume?.text && applyConfig?.model && applyConfig?.baseUrl);
    const site = siteFor(tab?.url || '');
    if (reviewFinished && ready && tab?.id === activeTabId) return;
    reviewFinished = false;
    setStep(1);
    activeTabId = tab?.id;
    const hero = document.querySelector('.hero-job');
    hero.hidden = !site;
    if (site) {
      hero.querySelector('strong').textContent = tab.title || site.host;
      hero.querySelector('small').textContent = site.host;
    }
    ui.resumeName.textContent = applyConfig?.resume?.name || '尚未导入简历';
    ui.resumeMeta.textContent = ready ? '模型：' + applyConfig.model : '导入简历并设置模型 API 后即可开始。';
    ui.fileCheck.textContent = ready ? '✓' : '—';
    connection(ready ? 'ready' : '', ready ? '资料已就绪' : '待设置');
    if (!ready) {
      status('准备申请资料', '在设置中导入或粘贴简历，并填写模型地址。');
      setButton('导入简历与配置模型', false, 'settings');
      showReview([]);
      return;
    }
    if (checkpoint && tab && checkpoint.target.tabId === tab.id && checkpoint.target.url === tab.url &&
        checkpoint.source.hash === applyConfig.resume.revision && !['task.ok','task.partial'].includes(checkpoint.status)) {
      showReview(checkpoint.review);
      status('可继续上次填写', '恢复后会重新观察当前页面。');
      setButton('继续上次填写', false, 'restore');
      return;
    }
    showReview([]);
    status(site ? '准备开始' : '打开招聘页面', site ? '点击开始后，简历与表单内容将发送至已配置的模型。' : '请切换到要填写的 HTTPS 招聘官网。');
    setButton('开始自动填写', !site);
  }
  $('profile-link').addEventListener('click', () => chrome.runtime.openOptionsPage());
  function clearFeedback(kind) {
    if (kind && kind !== feedbackKind) return;
    $('panel-feedback').hidden = true;
    $('panel-feedback-text').textContent = '';
    feedbackAction = undefined; feedbackKind = undefined;
  }
  function showFeedback(text, label, action, kind) {
    const wasHidden = $('panel-feedback').hidden;
    feedbackKind = kind; feedbackAction = action;
    $('panel-feedback-text').textContent = text;
    $('panel-feedback-retry').textContent = label || '';
    $('panel-feedback-retry').hidden = !action;
    $('panel-feedback').hidden = false;
    if (wasHidden) motion?.enter($('panel-feedback')); else motion?.update($('panel-feedback-text'));
  }
  $('panel-feedback-dismiss').addEventListener('click', () => clearFeedback());
  $('panel-feedback-retry').addEventListener('click', () => { if (feedbackAction) void feedbackAction(); });

  function updateStepCounter() {
    const step = stepNumber > 0 ? `第 ${stepNumber} 步` : '准备中';
    ui.stepCounter.textContent = running ? `${step}${paused ? ' · 已暂停' : question ? ' · 待确认' : ''}` : ui.stepCounter.textContent;
  }

  // 本地调试日志：各阶段耗时与错误栈。只有配对配置 debug=true 时后台才发 debug.trace。
  const debugLines = [];
  const debugTotals = { 模型: 0, 观察: 0, 动作: 0, 保存: 0 };
  const debugBucket = { 模型决策: '模型', 规划: '模型', 观察页面: '观察', 批量前重扫页面: '观察', 本步动作合计: '动作', 保存进度: '保存' };
  function resetDebug() {
    debugLines.length = 0; for (const key of Object.keys(debugTotals)) debugTotals[key] = 0;
    $('debug-list').replaceChildren(); $('debug-summary').textContent = ''; $('debug-card').hidden = true;
  }
  function addDebug(step, raw) {
    if (settings?.debug !== true) return;
    let entry; try { entry = JSON.parse(raw); } catch { return; }
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `${time} 第${step}步 ${entry.phase} ${entry.ms}ms${entry.detail ? ` · ${entry.detail}` : ''}`;
    debugLines.push(line); if (debugLines.length > 2000) debugLines.shift();
    const item = document.createElement('li'); item.textContent = line;
    if (entry.ms >= 3000 || /异常|出错/.test(entry.phase)) item.className = 'slow';
    const list = $('debug-list'); list.append(item); while (list.children.length > 400) list.firstChild.remove();
    const bucket = debugBucket[entry.phase];
    if (bucket) debugTotals[bucket] += entry.ms;
    $('debug-summary').textContent = Object.entries(debugTotals).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(' · ');
    $('debug-card').hidden = false;
  }

  function diagnostic(phase, detail, step = 0) {
    if (settings?.debug && detail) addDebug(step, JSON.stringify({ phase, ms: 0, detail: String(detail) }));
  }

  function showReview(entries) {
    const list = $('review-list'), completedList = $('review-completed-list'), completed = $('review-completed');
    const wasVisible = !completed.hidden, wasOpen = completed.open;
    const existing = new Map([...list.children, ...completedList.children].map(node => [node.dataset.reviewKey, node]));
    const positions = motion?.captureRows(existing.values());
    const added = [], changed = [], retained = new Set();
    const wasHidden = $('review-card').hidden;
    const cardHeight = wasHidden ? 0 : $('review-card').getBoundingClientRect().height;
    const labels = { filled: '已填写', preserved: '已保留', skipped: '已跳过', deferred: '待你完成', failed: '待核对', pending: '待处理' };
    const reviewEntries = (entries || []).filter(entry => !(entry.status === 'pending' && entry.required === false));
    lastReview = reviewEntries;
    document.body.dataset.result = String(reviewFinished);
    const history = $('event-history');
    const review = $('review-card');
    if (reviewFinished) {
      if (review.nextElementSibling !== history) history.before(review);
    } else if (review.parentElement !== document.querySelector('.task-workspace')) document.querySelector('.task-workspace').append(review);
    const doneStates = new Set(['filled', 'preserved', 'skipped']);
    const pendingCount = reviewEntries.filter(entry => !doneStates.has(entry.status)).length;
    const doneCount = reviewEntries.length - pendingCount;
    $('review-card').dataset.pending = String(pendingCount > 0);
    $('review-count').textContent = reviewFinished ? (pendingCount ? `还有 ${pendingCount} 项需处理` : `已处理 ${doneCount} 项`) : `待处理 ${pendingCount} · 共 ${reviewEntries.length} 项`;
    $('review-card').querySelector('.review-heading + p').textContent = reviewFinished ? (pendingCount ? `已处理 ${doneCount} 项，剩余 ${pendingCount} 项待处理。手动补填后可点击「已处理，核对」，非必填项可直接点击「跳过」。` : '请逐项核对以下内容，确认无误后到官网提交。') : pendingCount ? `有 ${pendingCount} 项需要处理，其他内容${paused ? '已暂停' : '继续填写中'}。` : '已处理内容可展开核对。';
    $('review-completed-count').textContent = `已处理 ${doneCount} 项`;
    reviewEntries.forEach((entry, index) => {
      const key = String(entry.key ?? `${entry.label}:${index}`);
      let item = existing.get(key);
      const isNew = !item;
      if (!item) {
        item = document.createElement('li'); item.dataset.reviewKey = key;
        const copy = document.createElement('div'); copy.className = 'review-field';
        copy.append(document.createElement('strong'), document.createElement('span'));
        const badge = document.createElement('span'); badge.className = 'review-state';
        item.append(copy, badge);
      }
      const copy = item.querySelector('.review-field'), badge = item.querySelector('.review-state');
      const value = entry.actualValue === '' || entry.actualValue == null ? '尚未填写' : String(entry.actualValue);
      const nextState = entry.status || 'pending';
      const didChange = !isNew && (item.dataset.state !== nextState || copy.lastElementChild.textContent !== value || copy.firstElementChild.textContent !== entry.label);
      item.dataset.state = nextState;
      copy.firstElementChild.textContent = entry.label;
      copy.lastElementChild.textContent = value;
      badge.textContent = labels[entry.status] || '待核对';
      let reason = item.querySelector('.review-reason');
      if (!doneStates.has(entry.status) && (entry.autoDeferred || entry.failureCode || entry.status === 'deferred')) {
        if (!reason) { reason = document.createElement('p'); reason.className = 'review-reason'; item.append(reason); }
        const reasons = { EXISTING_VALUE_PRESERVED: '已有内容与资料不同，需要确认后才能替换。', READ_ONLY_CONTROL: '暂时无法操作这个控件，请手动选择或稍后重试。', STALE_CONTROL: '网页控件已变化，暂时无法填写。', VALUE_CHANGED: '网页内容发生变化，已保留当前内容。', MISSING_INFORMATION: '简历或个人资料中暂无此项信息，请手动填写或跳过。' };
        Object.assign(reasons, {
          DATE_PRECISION_REQUIRED: '网页要求年、月、日，当前资料只有年月，请补充具体日期。',
          DATE_INPUT_REJECTED: '网页未接受日期，请核对要求的格式或日期范围后补填。',
          DATE_INPUT_MISMATCH: '日期输入未被完整保留，请手动核对并补填。',
          DATE_INPUT_MISSING: '日期弹层已变化，请核对网页中的实际日期。',
        });
        reason.textContent = reasons[entry.failureCode] || (entry.status === 'deferred' ? '你选择稍后亲自处理此项，也可以直接跳过。' : entry.adapter === 'date-panel' ? '日期控件暂时无法完成选择，请手动选择或稍后重试。' : '自动填写未完成，已先跳过此项，当前内容会保留。');
      } else reason?.remove();
      item.querySelector('.review-action')?.remove();
      let controls = item.querySelector('.review-controls');
      if (!doneStates.has(entry.status)) {
        copy.style.cursor = 'pointer';
        copy.onclick = () => {
          if (fieldActionPending) return;
          fieldActionPending = { key, mode: 'locate' };
          showReview(lastReview);
          connectAgent().postMessage({ type: 'application_field_action', taskId, key, action: 'locate' });
        };
        if (!controls) { controls = document.createElement('div'); controls.className = 'review-controls'; item.append(controls); }
        controls.replaceChildren();
        for (const [mode, label] of [['locate', '定位字段'], ['retry', '重试'], ['check', '已处理，核对'], ['skip', '跳过']]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'review-field-action';
          button.textContent = label; button.disabled = Boolean(fieldActionPending);
          button.setAttribute('aria-label', `${label}：${entry.label}`);
          button.onclick = () => {
            if (fieldActionPending) return;
            fieldActionPending = { key, mode };
            showReview(lastReview);
            connectAgent().postMessage({ type: 'application_field_action', taskId, key, action: mode });
          };
          controls.append(button);
        }
      } else { copy.style.cursor = ''; copy.onclick = null; controls?.remove(); }
      retained.add(key);
      (doneStates.has(entry.status) ? completedList : list).append(item);
      if (isNew) added.push(item); else if (didChange) changed.push(item);
    });
    for (const [key, node] of existing) if (!retained.has(key)) node.remove();
    completed.hidden = doneCount === 0;
    completed.open = doneCount > 0 && (openCompletedOnUpdate || (wasVisible ? wasOpen : pendingCount === 0));
    if (doneCount > 0) openCompletedOnUpdate = false;
    list.hidden = pendingCount === 0;
    $('review-card').hidden = reviewEntries.length === 0;
    if (wasHidden && reviewEntries.length) motion?.enter($('review-card'));
    else {
      if (reviewEntries.length) motion?.resize($('review-card'), cardHeight);
      if (positions) motion?.moveRows(positions);
      added.slice(0, 8).forEach((node, index) => motion?.enter(node, index * 20));
      changed.forEach(node => { motion?.flash(node); motion?.update(node.querySelector('.review-state')); });
    }
  }

  function showCheckpoint(saved) {
    checkpoint = saved;
    if (!saved || (!running && !reviewFinished)) return;
    if (!taskId) taskId = saved.taskId;
    showReview(saved.review);
  }

  function status(title, message, mode = '') {
    if (mode === 'running') lastProgress = { title, message };
    $('foreground-hint').hidden = !running || paused || Boolean(question);
    if (backgroundPaused && running) {
      title = '填写已暂停';
      message = manualPaused ? '请返回申请页面，再点击继续填写。' : '请返回申请标签页，回来后会自动继续。';
      mode = '';
    }
    const changed = ui.statusTitle.textContent !== title || ui.statusMessage.textContent !== message;
    const previousFlow = document.body.dataset.flow;
    const previousActive = document.body.dataset.active;
    const changingContext = previousActive && previousActive !== String(running || reviewFinished);
    const contextSizes = changingContext ? ['.step-bar', '.application-sheet'].map(selector => document.querySelector(selector)).filter(Boolean).map(node => [node, node.getBoundingClientRect().height]) : [];
    ui.statusTitle.textContent = title;
    ui.statusMessage.textContent = message;
    ui.flowPulse.className = `flow-pulse ${mode}`;
    document.body.dataset.active = String(running || reviewFinished);
    document.body.dataset.flow = paused ? 'paused' : question ? 'waiting' : mode || 'idle';
    updateStepCounter();
    if (changed) motion?.update(ui.statusTitle.parentElement);
    if (previousFlow !== document.body.dataset.flow) motion?.update(ui.flowPulse);
    if (changingContext) { contextSizes.forEach(([node, height]) => motion?.resize(node, height)); motion?.enter(document.querySelector('.task-workspace'), 35); }
  }

  function connection(mode, label) {
    const changed = ui.connection.querySelector('span').textContent !== label;
    ui.connection.className = `connection ${mode}`;
    ui.connection.querySelector('span').textContent = label;
    if (changed) motion?.update(ui.connection);
  }

  function addEvent(text) {
    if (!text) return;
    ui.events.querySelector('.empty-event')?.remove();
    const item = document.createElement('li');
    item.textContent = text.length > 145 ? `${text.slice(0, 145)}…` : text;
    const positions = motion?.captureRows(ui.events.children);
    ui.events.prepend(item);
    if (positions) motion?.moveRows(positions);
    motion?.enter(item);
    while (ui.events.children.length > 7) ui.events.lastElementChild.remove();
  }

  function setButton(text, disabled = false, action = 'begin') {
    startAction = action;
    const previousStartHidden = ui.start.hidden, previousStatusHidden = $('action-status').hidden;
    const textChanged = ui.start.querySelector('span').textContent !== text;
    ui.start.querySelector('span').textContent = text;
    ui.start.disabled = disabled;
    const passive = disabled && (running || preparing) && !paused;
    ui.start.hidden = passive;
    $('action-status').hidden = !passive;
    $('action-status').textContent = passive ? text.replace(/[…]+$/, '') : '';
    if (paused) ui.stop.hidden = true;
    else if (running || preparing) ui.stop.hidden = false;
    if (previousStartHidden && !ui.start.hidden) motion?.enter(ui.start);
    else if (textChanged && !ui.start.hidden) motion?.update(ui.start.querySelector('span'));
    if (previousStatusHidden && !$('action-status').hidden) motion?.enter($('action-status'));
  }

  async function activeTab() {
    if (activeTabId) return chrome.tabs.get(activeTabId);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new PanelError('请先打开目标招聘岗位页面');
    activeTabId = tab.id;
    return tab;
  }

  let port;
  let agentReady;
  let resolveReady;
  let protocolReady = false;
  let taskId;
  let paused = false;
  let backgroundPaused = false;
  let manualPaused = false;
  let lastProgress;
  let question;
  let answering = false;
  const dialog = $('question-dialog');
  const answerInput = $('question-answer');

  function showQuestion(value) {
    const previousQuestionId = question?.id;
    const wasOpen = dialog.open;
    if (previousQuestionId === value.id) {
      if (backgroundPaused) { setButton('返回申请页面'); return; }
      if (!dialog.open) dialog.showModal();
      (value.kind === 'manual_action' || value.replacement ? $('question-submit') : answerInput).focus();
      return;
    }
    clearFeedback('answer');
    question = value;
    answering = false;
    for (const id of ['question-submit', 'question-skip', 'question-defer']) $(id).disabled = false;
    dialog.dataset.kind = value.kind === 'manual_action' ? 'manual' : value.replacement ? 'replacement' : 'question';
    dialog.querySelector('.question-kicker').textContent = value.kind === 'manual_action' ? '需要你完成' : value.replacement ? '确认资料修改' : '补充申请信息';
    const manual = value.kind === 'manual_action';
    const replacement = Boolean(value.replacement);
    status(manual ? '等待你在网页操作' : replacement ? '请确认修改' : '等待你补充信息', value.question || value.field?.label || '请确认待修改的资料。', 'waiting');
    const replacements = value.replacements?.length ? value.replacements : replacement ? [{ ...value.replacement, field: value.field }] : [];
    $('question-title').textContent = replacement ? `确认修改 ${replacements.length} 项资料` : value.question;
    // reason is agent context, not user-facing copy. Only replacement details need a second paragraph.
    $('question-reason').hidden = !replacement && !manual;
    const comparison = $('question-reason'); comparison.replaceChildren();
    if (manual) comparison.textContent = '请切换到招聘页面完成操作，再回到这里继续填写。';
    for (const item of replacement ? replacements : []) {
      const row = document.createElement('div'); row.className = 'replacement-item';
      const field = document.createElement('strong'); field.textContent = item.field?.label || '当前内容'; row.append(field);
      for (const [label, text, className] of [['原内容', item.currentValue, 'old-value'], ['新内容', item.proposedValue, 'new-value']]) {
        const valueRow = document.createElement('div'); valueRow.className = className;
        const tag = document.createElement('span'); tag.textContent = label;
        const content = document.createElement('p'); content.textContent = text ?? '未填写';
        valueRow.append(tag, content); row.append(valueRow);
      }
      comparison.append(row);
    }
    $('question-answer-label').hidden = manual || replacement;
    answerInput.hidden = manual || replacement;
    $('question-options').hidden = manual || replacement;
    $('question-skip').hidden = manual;
    $('question-open-page').hidden = !manual;
    $('question-submit').textContent = replacement ? '确认替换并继续' : manual ? '我已完成，继续' : '继续填写';
    $('question-help').textContent = replacement ? '仅替换以上内容。' : manual ? '' : '补充回答仅用于本次填写。';
    $('question-help').hidden = manual;
    $('question-error').textContent = '';
    answerInput.value = '';
    $('question-options').replaceChildren();
    for (const option of value.options || []) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'answer-option'; button.textContent = option;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        $('question-options').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        answerInput.value = option; syncAnswerOptions(); answerInput.focus();
      });
      $('question-options').append(button);
    }
    setButton('重新打开问题');
    if (backgroundPaused) { setButton('返回申请页面'); return; }
    if (!dialog.open) dialog.showModal();
    else if (wasOpen && previousQuestionId !== value.id) motion?.update($('question-form'));
    (manual || replacement ? $('question-submit') : answerInput).focus();
  }

  function syncAnswerOptions() {
    const value = answerInput.value.trim();
    $('question-options').querySelectorAll('button').forEach(button => {
      const next = String(button.textContent.trim() === value);
      if (button.getAttribute('aria-pressed') !== next) { button.setAttribute('aria-pressed', next); motion?.update(button); }
    });
  }
  answerInput.addEventListener('input', syncAnswerOptions);

  function connectAgent() {
    if (port) return port;
    protocolReady = false;
    agentReady = new Promise(resolve => { resolveReady = resolve; });
    port = chrome.runtime.connect({ name: 'side-panel-connection' });
    port.onDisconnect.addListener(() => {
      port = undefined;
      if (fieldActionPending) { fieldActionPending = undefined; showReview(lastReview); }
      if (running) finish(false, '连接已断开，自动操作已停止。请重新开始，已填写的内容会保留。', 'failed');
    });
    port.onMessage.addListener(event => {
      if (event.type === 'agent_ready' && event.protocol === 10) { protocolReady = true; resolveReady(true); return; }
      if (event.type === 'checkpoint') {
        showCheckpoint(event.checkpoint); checkpointResolve?.(); checkpointResolve = undefined;
        if (resumeFieldRetry) {
          resumeFieldRetry = false;
          if (checkpoint?.taskId === taskId && !running) {
            activeTabId = checkpoint.target.tabId;
            restoreCheckpoint = checkpoint; restoring = true; void begin();
          }
        }
        return;
      }
      if (event.type === 'field_action_result' && event.taskId === taskId && fieldActionPending?.key === event.key) {
        fieldActionPending = undefined;
        showReview(event.review || lastReview);
        if (event.error) { showFeedback(event.error); return; }
        if (event.action === 'locate') {
          void openRecruitingPage();
          showFeedback('已定位字段。你可以手动补填，再点击「已处理，核对」。填写已暂停。', undefined, undefined, 'field');
        } else if (event.action === 'retry') {
          clearFeedback();
          if (running) port.postMessage({ type: 'resume_task' });
          else { resumeFieldRetry = true; port.postMessage({ type: 'get_checkpoint' }); }
        } else if (event.action === 'skip') {
          clearFeedback('field');
          showFeedback('已跳过该字段。');
        } else {
          const entry = lastReview.find(entry => entry.key === event.key);
          const pending = entry && !['filled', 'preserved', 'skipped'].includes(entry.status);
          showFeedback(pending ? '该字段仍未通过核对，请检查网页内容。' : '已回读网页并更新核对结果。');
        }
        return;
      }
      if (event.type === 'checkpoint_error') { diagnostic('保存进度异常', event.error); addEvent('进度暂未保存，请保持当前页面打开。'); return; }
      if (event.type === 'heartbeat_ack') return;
      if (event.type === 'task_busy') {
        const message = '请等它结束，或关闭那个窗口的侧栏后再试。';
        finish(false, message, 'failed'); status('另一个窗口正在辅助填写', message); return;
      }
      if (event.type === 'task_control' && event.taskId === taskId && running) {
        paused = event.paused;
        if (!paused) clearFeedback('field');
        backgroundPaused = event.background === true;
        manualPaused = event.manual ?? (paused && !backgroundPaused);
        $('return-to-application').hidden = !backgroundPaused;
        ui.stepCounter.textContent = paused ? '已暂停' : question ? '等待补充' : '填写中';
        ui.progress.classList.toggle('indeterminate', !paused && !question);
        ui.stop.hidden = backgroundPaused;
        ui.stop.textContent = paused ? '继续操作' : '暂停操作';
        setButton(backgroundPaused ? '返回申请页面' : paused ? (question ? '重新打开问题' : '继续填写') : '正在辅助填写…', !paused && !question);
        if (backgroundPaused && dialog.open) dialog.close();
        if (!backgroundPaused && question && !dialog.open) dialog.showModal();
        const progress = lastProgress || { title: '正在检查申请表', message: '请稍候。' };
        status(paused ? '已暂停' : question ? '请处理待办信息' : progress.title,
          paused ? '你可以修改网页，再继续填写。' : question ? '请处理问题后继续。' : progress.message,
          paused || question ? '' : 'running');
        return;
      }
      if (event.type === 'target_changed' && event.taskId === taskId && running) {
        activeTabId = event.tabId;
        addEvent('已进入新的申请页面。');
        return;
      }
      if (event.type === 'answer_rejected') {
        if (!question || !answering || (event.questionId && event.questionId !== question.id)) return;
        answering = false; $('question-defer').disabled = false; $('question-submit').disabled = false;
        $('question-skip').disabled = false;
        diagnostic('回答异常', event.error);
        $('question-error').textContent = '回答未被接受，请检查后重试。'; motion?.update($('question-error'));
        const rejectedId = question.id;
        showFeedback('回答未被接受，草稿已保留。请检查后重试。', '检查回答', () => { if (question?.id === rejectedId) showQuestion(question); else clearFeedback('answer'); }, 'answer');
        if (dialog.open) (question.kind === 'manual_action' || question.replacement ? $('question-submit') : answerInput).focus();
        return;
      }
      if (event.type === 'answer_accepted') {
        if (event.questionId !== question?.id) return;
        clearFeedback('answer');
        question = undefined; answering = false;
        $('question-submit').disabled = false; $('question-skip').disabled = false;
        dialog.close(); setButton('正在辅助填写…', true);
        if (paused && !backgroundPaused) port.postMessage({ type: 'resume_task' });
        $('question-defer').disabled = false;
        ui.stop.textContent = '暂停操作';
        if (backgroundPaused) { setButton('返回申请页面'); ui.stop.hidden = true; }
        status('继续填写', '正在根据你的回答继续填写。', 'running'); return;
      }
      if (event.type === 'error') {
        if (!protocolReady) { resolveReady(false); return; }
        diagnostic('连接异常', event.error);
        finish(false, '暂时无法继续，请稍后重试。已填写的内容会保留。', 'failed'); return;
      }
      if (event.data?.taskId !== taskId || !running) return;
      const details = event.data.details;
      if (event.state === 'debug.trace') { addDebug(event.data.step, details); return; }
      if (Number.isInteger(event.data.step) && event.data.step > 0) stepNumber = Math.max(stepNumber, event.data.step);
      updateStepCounter();
      if (event.state === 'review.updated') {
        try { showReview(JSON.parse(details)); } catch { addEvent('核对清单读取失败，请核对官网表单。'); }
      } else if (event.state === 'user.question') {
        try { showQuestion(JSON.parse(details)); } catch { finish(false, '暂时无法显示问题，请重新开始。', 'failed'); }
      } else if (event.state === 'act.start' && !paused && !question) {
        diagnostic('操作开始', details, event.data.step);
        const progress = actionProgress(details);
        status(progress.title, progress.detail, 'running');
      } else if (event.state === 'act.ok' || event.state === 'act.fail' || event.state === 'step.fail') {
        diagnostic(event.state, details, event.data.step);
        if (event.state !== 'act.ok') addEvent('这一步未完成，正在重新检查。');
      } else if (event.state === 'step.start' && !question && !paused) {
        status('正在检查申请表', '请稍候。', 'running');
      } else if (event.state === 'task.ok') {
        diagnostic('填写结束', details, event.data.step);
        finish(true, '请核对填写结果，再到官网提交。');
      } else if (event.state === 'task.partial') {
        diagnostic('未完成项', details, event.data.step);
        finish(false, '请查看下方清单，补充或核对未完成项。', 'partial');
      } else if (event.state === 'task.fail' || event.state === 'task.cancel') {
        diagnostic(event.state, details, event.data.step);
        finish(false, event.state === 'task.cancel' ? '已填写的内容会保留。' : '暂时无法继续，已填写的内容会保留。你可以稍后重试。', event.state === 'task.cancel' ? 'stopped' : 'failed');
        void chrome.tabs.get(activeTabId).then(tab => {
          const site = siteFor(tab.url || '');
          if (site) { setButton('继续自动填写'); }
        }).catch(() => {});
      }
    });
    port.postMessage({ type: 'hello', windowId: panelWindowId });
    return port;
  }
  setInterval(() => { if (port) port.postMessage({ type: 'heartbeat' }); }, 20000);

  function finish(success, details, outcome = success ? 'done' : 'stopped') {
    clearFeedback('answer');
    running = false; preparing = false; paused = false; backgroundPaused = false; manualPaused = false; lastProgress = undefined; question = undefined; answering = false;
    $('return-to-application').hidden = true;
    preparationNumber++; clearTimeout(readinessTimer);
    restoring = false; rebindTarget = undefined; restoreCheckpoint = undefined; readinessAttempts = 0;
    reviewFinished = true; openCompletedOnUpdate = false;
    setStep(outcome === 'done' || outcome === 'partial' || lastReview.length > 0 ? 3 : 2);
    const completed = $('review-completed');
    if (dialog.open) dialog.close();
    $('event-history').open = false;
    showReview(lastReview);
    if (!completed.hidden) completed.open = $('review-list').hidden;
    motion?.enter($('review-card'));
    document.querySelector('main').scrollTo?.({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    ui.stop.hidden = true;
    ui.stepCounter.textContent = outcome === 'partial' || outcome === 'done' ? '本轮结束' : outcome === 'failed' ? '未能完成' : '已停止';
    ui.progress.classList.remove('indeterminate');
    ui.progress.style.width = success ? '100%' : '0%';
    status(outcome === 'partial' ? '本轮尚有未完成项' : outcome === 'done' ? '本轮填写结束，请核对' : outcome === 'failed' ? '暂时无法继续' : '操作已停止', String(details || '').slice(0, 1000), outcome === 'done' || outcome === 'partial' ? outcome : '');
    addEvent(success ? '申请尚未提交，请检查官网表单。' : details);
    setButton('重新检查表单');
    if (port) port.postMessage({ type: 'get_checkpoint' });
  }

  async function begin() {
    if (running && backgroundPaused) { connectAgent().postMessage({ type: 'return_to_application' }); return; }
    if (question) { showQuestion(question); return; }
    if (running) {
      if (paused) {
        connectAgent().postMessage({ type: 'resume_task' });
      }
      return;
    }
    if (preparing) return;
    clearFeedback();
    preparing = true;
    setStep(2);
    const currentPreparation = ++preparationNumber;
    let waitingForPage = false;
    try {
      if (!restoring) {
        const [target] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
        activeTabId = target?.id;
      }
      const tab = rebindTarget ? await chrome.tabs.get(rebindTarget.id) : await activeTab();
      if (currentPreparation !== preparationNumber) return;
      activeTabId = tab.id;
      const site = siteFor(tab.url || '');
      // A newly-created tab can report no URL / about:blank while navigation commits.
      // Wait for its actual URL; do not read or control a guessed pending destination.
      if (!site && (tab.status === 'loading' || !tab.url || tab.url === 'about:blank')) {
        status('正在打开招聘网页', '页面就绪后会继续，请稍候。', 'running');
        setButton('等待网页打开…', true); ui.stop.hidden = false;
        if (++readinessAttempts > 30) throw new PanelError('网页仍未打开，请检查官网后点击重试。');
        clearTimeout(readinessTimer);
        waitingForPage = true;
        readinessTimer = setTimeout(() => { if (currentPreparation === preparationNumber) void begin(); }, 1000);
        return;
      }
      if (!site) throw new PanelError('请选择使用 HTTPS 的招聘官网链接。');
      readinessAttempts = 0;
      const granted = await chrome.permissions.contains({ origins: [site.pattern] });
      if (currentPreparation !== preparationNumber) return;
      if (!granted) {
        throw new PanelError('扩展的网站访问权限尚未启用。请在扩展管理页重新加载或启用扩展，并将网站访问权限设为“在所有网站上”，然后重试。');
      }
      // The target is fixed for the whole run; changing the active tab cannot redirect it.
      taskId = crypto.randomUUID();
      running = true; paused = false; stepNumber = 0; reviewFinished = false; openCompletedOnUpdate = false;
      setStep(2);
      if (restoring && restoreCheckpoint) {
        ui.resumeName.textContent = restoreCheckpoint.source.name;
        ui.resumeMeta.textContent = '继续使用上次的资料';
        ui.fileCheck.textContent = '✓';
      }
      $('event-history').open = true;
      showReview(restoring ? restoreCheckpoint?.review || lastReview : []);
      ui.events.replaceChildren(); resetDebug(); ui.stop.hidden = false; ui.stop.textContent = '暂停操作';
      ui.progress.classList.add('indeterminate');
      ui.progress.style.width = '35%';
      setButton('正在辅助填写…', true);
      status('正在准备填写', '正在读取简历和申请表。', 'running');
      connectAgent();
      const ready = await Promise.race([agentReady, new Promise(resolve => setTimeout(() => resolve(false), 4000))]);
      if (currentPreparation !== preparationNumber || !running) return;
      if (!ready) throw new PanelError('插件未响应，请在扩展管理页重新加载，再打开侧栏。');
      port.postMessage({ type: restoring ? 'restore_task' : 'new_task', task: '填写当前岗位网申', taskId, tabId: tab.id,
        checkpointId: restoring ? restoreCheckpoint?.taskId : undefined, rebind: Boolean(rebindTarget) });
    } catch (error) {
      if (currentPreparation !== preparationNumber) return;
      diagnostic('启动异常', error?.message);
      finish(false, error instanceof PanelError ? error.message : '暂时无法开始，请检查招聘页面后重试。', 'failed');
    }
    finally {
      if (currentPreparation === preparationNumber) {
        preparing = false;
        if (!waitingForPage) { restoring = false; rebindTarget = undefined; restoreCheckpoint = undefined; }
      }
    }
  }

  function sendAnswer(decision) {
    if (!question || answering) return;
    if (decision === 'answer' && question.replacement) decision = 'confirm_replace';
    const text = question.replacement || decision === 'defer' ? '' : question.kind === 'manual_action' ? '我已完成网页操作，请重新观察页面确认是否可以继续。' : answerInput.value.trim();
    if (decision === 'answer' && !text) {
      $('question-error').textContent = '请补充信息，或选择跳过这一项。'; motion?.update($('question-error')); answerInput.focus(); return;
    }
    clearFeedback('answer');
    answering = true; $('question-defer').disabled = true; $('question-submit').disabled = true; $('question-skip').disabled = true;
    connectAgent().postMessage({ type: 'answer_user', taskId, 
      answer: { questionId: question.id, decision, text } });
  }
  $('question-form').addEventListener('submit', event => { event.preventDefault(); sendAnswer('answer'); });
  $('question-skip').addEventListener('click', () => sendAnswer('skip'));
  function later() {
    // 留到最后由用户处理：记为待办，Agent 继续处理其余内容，不原地等待。
    if (question && !answering) { addEvent(`已记为待你完成：${question.question}`); sendAnswer('defer'); }
  }
  $('question-close').addEventListener('click', () => dialog.close());
  $('question-defer').addEventListener('click', later);
  async function openRecruitingPage() {
    const targetId = activeTabId ?? checkpoint?.target.tabId;
    try {
      if (!targetId) throw new Error('missing target');
      const target = await chrome.tabs.get(targetId);
      if (!siteFor(target.url || '')) throw new Error('invalid target');
      await chrome.tabs.update(target.id, { active: true });
      await chrome.windows.update(target.windowId, { focused: true });
      clearFeedback('page');
      return true;
    } catch {
      const text = '无法打开原招聘页面，请确认该页面仍然打开。';
      if (question && dialog.open) $('question-error').textContent = text;
      showFeedback(text, '重试打开', openRecruitingPage, 'page');
      addEvent(text);
      return false;
    }
  }
  $('question-open-page').addEventListener('click', () => { void openRecruitingPage(); });
  $('debug-copy').addEventListener('click', () => { void navigator.clipboard.writeText(debugLines.join('\n')).then(() => addEvent('调试日志已复制')); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  $('return-to-application').addEventListener('click', () => { connectAgent().postMessage({ type: 'return_to_application' }); });
  ui.start.addEventListener('click', () => {
    if (startAction === 'settings') { void chrome.runtime.openOptionsPage(); return; }
    if (startAction === 'restore' && checkpoint && !running && !preparing && !restoring) {
      activeTabId = checkpoint.target.tabId;
      restoreCheckpoint = checkpoint; restoring = true; void begin();
      return;
    }
    void begin();
  });
  ui.stop.addEventListener('click', () => {
    if (!running) { finish(false, '已停止等待，你可以稍后重试。'); return; }
    if (paused) { void begin(); return; }
    connectAgent().postMessage({ type: 'pause_task' }); paused = true;
    status('已暂停', '当前操作结束后暂停。你可以稍后继续。');
    ui.stop.textContent = '继续操作'; setButton(question ? '重新打开问题' : '继续填写');
  });

  function refreshIdlePanel() {
    if (panelWindowId !== undefined && !running && !preparing)
      void refreshMaterials().catch(() => status('读取失败', '请重新打开侧栏。'));
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.applyConfig) {
      reviewFinished = false; checkpoint = undefined;
      refreshIdlePanel();
    }
  });
  chrome.tabs.onActivated.addListener(info => { if (info.windowId === panelWindowId) refreshIdlePanel(); });
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.active && tab.windowId === panelWindowId && (change.url || change.status === 'complete')) refreshIdlePanel();
  });

  async function init() {
    try {
      panelWindowId = (await chrome.windows.getCurrent()).id;
      connectAgent();
      await Promise.race([agentReady, new Promise(resolve => setTimeout(resolve, 4000))]);
      const received = new Promise(resolve => { checkpointResolve = resolve; });
      port.postMessage({ type: 'get_checkpoint' });
      await Promise.race([received, new Promise(resolve => setTimeout(resolve, 300))]);
      await refreshMaterials();
    } catch (error) {
      setStep(1);
      connection('error', '需要检查');
      diagnostic('连接异常', error?.message);
      const msg = error instanceof PanelError ? error.message : '暂时无法读取资料，请稍后重试。';
      ui.resumeName.textContent = '资料尚未就绪';
      ui.resumeMeta.textContent = msg;
      ui.fileCheck.textContent = '—';
      status('资料尚未就绪', msg);
      setButton('打开设置', false, 'settings');
    }
  }

  void init();
})();
