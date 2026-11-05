(function (root) {
  // Both UI surfaces use the same copy; keep human-readable action intent, not execution metadata.
  function actionProgress(raw) {
    const source = typeof raw === 'string' ? raw.trim() : '';
    if (source === 'done') return { title: '正在核对填写结果', detail: '请稍候。' };
    const fallback = { title: '正在填写表单', detail: '请稍候。' };
    const detail = source
      .replace(/[（(]\s*(?:index|字段索引|索引)\s*[:：=]?\s*\d+\s*[）)]/gi, '')
      .replace(/(?:index\s*[:=]\s*|字段索引\s*[:：]?\s*)\d+/gi, '')
      .trim();
    // Reject tool names, code, selectors and errors instead of exposing them as progress.
    if (!/[\u3400-\u9fff]/.test(detail) || /[a-z][a-z0-9]*_[a-z0-9_]+|\b(?:index|Error|Exception|undefined|null)\b|https?:\/\/|[{}<>`]|(?:xpath|selector)\s*[:=]/i.test(detail)) return fallback;
    const readable = detail
      .replace(/^正在读取选项\s*·\s*(.+)$/, '正在读取「$1」的选项')
      .replace(/^正在判断候选\s*·\s*(.+)$/, '正在选择「$1」的合适选项')
      .replace(/^正在补充区块\s*·\s*(.+)$/, '正在添加「$1」')
      .replace(/^正在(填写|展开)\s*·\s*(.+)$/, '正在$1「$2」');
    return { title: '正在填写表单', detail: readable.length > 160 ? `${readable.slice(0, 160)}…` : readable };
  }
  const copy = { actionProgress };
  root.JobApplyProgressCopy = copy;
})(globalThis);
