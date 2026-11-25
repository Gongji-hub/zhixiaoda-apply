export type ProgressStage = 0 | 1 | 2;

export function actionProgress(value: string): { title: string; detail: string; stage: ProgressStage } {
  const source = value.trim();
  if (source === '正在独立检查整张表的遗漏') {
    return { title: '正在检查遗漏', detail: '正在独立核对页面必填项和校验提示…', stage: 2 };
  }
  if (source === '正在识别特殊控件' || source.startsWith('正在尝试特殊控件 · ')) {
    return { title: '正在补填特殊控件', detail: source, stage: 1 };
  }
  if (source === 'done') {
    return { title: '正在核对填写结果', detail: '正在逐项核对必填状态与页面校验提示…', stage: 2 };
  }
  if (source === '整页读取并填写表单') {
    return { title: '正在读取页面结构', detail: '正在识别页面表单字段与模块关系…', stage: 0 };
  }
  if (/^正在分析结构方案/.test(source)) {
    return { title: '正在读取页面结构', detail: '正在梳理经历模块与表单结构…', stage: 0 };
  }
  if (/^正在分析填写方案/.test(source)) {
    return { title: '正在填入个人资料', detail: '正在结合个人资料生成填写方案…', stage: 1 };
  }
  if (/^正在分析修复方案/.test(source)) {
    return { title: '正在复核全页字段', detail: '正在复核未通过项并尝试修正…', stage: 2 };
  }
  const fallback = { title: '正在填写表单', detail: '请稍候。', stage: 1 as const };
  const detail = source
    .replace(/[（(]\s*(?:index|字段索引|索引)\s*[:：=]?\s*\d+\s*[）)]/gi, '')
    .replace(/(?:index\s*[:=]\s*|字段索引\s*[:：]?\s*)\d+/gi, '')
    .trim();
  // Reject tool names, code, selectors and errors instead of exposing them as progress.
  if (!/[\u3400-\u9fff]/.test(detail) || /[a-z][a-z0-9]*_[a-z0-9_]+|\b(?:index|Error|Exception|undefined|null)\b|https?:\/\/|[{}<>`]|(?:xpath|selector)\s*[:=]/i.test(detail)) return fallback;
  if (/^正在展开\s*·\s*(.+)$/.test(detail)) {
    const target = detail.replace(/^正在展开\s*·\s*/, '');
    return { title: '正在展开经历模块', detail: `正在展开「${target}」`, stage: 0 };
  }
  if (/^正在补充区块\s*·\s*(.+)$/.test(detail)) {
    const target = detail.replace(/^正在补充区块\s*·\s*/, '');
    return { title: '正在展开经历模块', detail: `正在添加「${target}」`, stage: 0 };
  }
  const readable = detail
    .replace(/^正在读取选项\s*·\s*(.+)$/, '正在读取「$1」的选项')
    .replace(/^正在判断候选\s*·\s*(.+)$/, '正在选择「$1」的合适选项')
    .replace(/^正在填写\s*·\s*(.+)$/, '正在填写「$1」');
  const trimmed = readable.length > 160 ? `${readable.slice(0, 160)}…` : readable;
  if (/^(?:点击|打开|进入|前往|切换)/.test(trimmed) && !/填写|输入|选择.*选项|勾选/.test(trimmed)) {
    return { title: '正在读取页面结构', detail: trimmed, stage: 0 };
  }
  return { title: '正在填入个人资料', detail: trimmed, stage: 1 };
}
