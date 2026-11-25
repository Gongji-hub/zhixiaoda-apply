import { AUDIT_FINDING, INCOMPLETE_REVIEW_PREFIX, isIncompleteAudit, reviewIssue, type ReviewIssue } from './auditStatus';

export interface FeedbackReviewItem {
  manualOnly?: boolean;
  key: string;
  legacyKey?: string;
  label: string;
  rawLabel?: string;
  reason: string;
  kind: 'missing' | 'consent' | 'attachment' | 'failed' | 'verify' | 'audit';
  required?: boolean;
  index?: number;
  controlKind?: 'text' | 'textarea' | 'select' | 'combobox' | 'checkbox' | 'radio' | 'date' | 'file' | 'toggle' | 'unknown';
  options?: string[];
  typable?: boolean;
  multiple?: boolean;
  dateFormat?: string;
  expectedValue?: string;
  actualValue?: string;
}

export function feedbackReviewCounts(items: FeedbackReviewItem[]) {
  const optionalCount = items.filter(item => item.kind === 'missing' && !item.required).length;
  const auditCount = items.filter(item => item.kind === 'audit').length;
  const verifyCount = items.filter(item => item.kind === 'verify').length;
  return {
    optionalCount, verifyCount,
    actionableCount: items.length - optionalCount - auditCount - verifyCount,
    auditIncomplete: auditCount > 0,
  };
}

interface RawReviewEntry {
  key?: string;
  legacyKey?: string;
  label?: string;
  url?: string;
  index?: number;
  status?: string;
  expectedValue?: string;
  requestedValue?: string;
  actualValue?: string;
  message?: string;
  required?: boolean;
  autoDeferred?: boolean;
  failureCode?: string;
  issue?: ReviewIssue;
  adapter?: string;
  options?: string[];
  controlKind?: FeedbackReviewItem['controlKind'];
  typable?: boolean;
  multiple?: boolean;
  readOnly?: boolean;
  dateFormat?: string;
}

const SECTION_TITLES = /^(个人信息|基本信息|教育背景|教育经历|工作经历|实习经历|项目经历|获奖经历|语言能力|游戏经历|其他信息|附件信息)$/;
const ANCHOR_LABELS = /^(学校名称|院校名称|毕业院校|毕业学校|学校|公司名称|单位名称|公司\/单位名称|企业名称|工作单位|项目名称|语种|语言|语言种类)$/;
const ANCHOR_RESET_LABELS = /^(宣讲城市|意向工作地点|意向城市|期望工作城市|期望工作地点|获知渠道|最低期望|最高期望|是否在|公司内是否有|特长爱好)/;
const EXPERIENCE_SUBFIELD =
  /^(学院|学院名称|院系|校区所在地址|研究方向|专业|专业名称|学历|学位|起止时间|开始时间|结束时间|入学时间|毕业时间|在职时间|工作地点|职位|职位名称|岗位|岗位名称|所属部门|部门|工作内容|工作职责|项目角色|项目职责|项目描述)/;

function parseEntryIdentity(entry: RawReviewEntry): {
  tagName: string;
  xpath: string;
  fieldTag: string;
  domId: string;
} {
  let tagName = '';
  let xpath = '';
  let fieldTag = '';
  let domId = '';
  for (const rawKey of [entry.key, entry.legacyKey]) {
    if (!rawKey) continue;
    try {
      const parsed = JSON.parse(rawKey);
      if (Array.isArray(parsed)) {
        if (parsed[1] === 'data-qz-field' && typeof parsed[2] === 'string') {
          fieldTag = parsed[2];
        } else {
          if (typeof parsed[1] === 'string') tagName = parsed[1].toLowerCase();
          if (typeof parsed[2] === 'string' && parsed[2].startsWith('/')) xpath = parsed[2];
          if (typeof parsed[3] === 'string' && parsed[3]) domId = parsed[3];
        }
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.xpath === 'string') xpath = obj.xpath;
        if (typeof obj.fieldTag === 'string') fieldTag = obj.fieldTag;
        if (typeof obj.id === 'string') domId = obj.id;
      }
    } catch {
      /* Ignore unparseable key. */
    }
  }
  return { tagName, xpath, fieldTag, domId };
}

export function summarizeReviewEntries(entries: unknown[]): {
  filledCount: number;
  unfilledItems: FeedbackReviewItem[];
  adaptedItems: { label: string; actualValue: string }[];
} {
  const normalized: {
    entry: RawReviewEntry;
    key: string;
    label: string;
    anchor: string;
    targetId: string;
  }[] = [];
  let currentAnchor = '';
  const byTarget = new Map<string, number>();

  const orderedEntries = [...entries];
  const slotsByUrl = new Map<string, { slot: number; index: number; raw: unknown }[]>();
  orderedEntries.forEach((raw, slot) => {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as RawReviewEntry;
    if (e.url && typeof e.index === 'number' && e.index >= 0) {
      const bucket = slotsByUrl.get(e.url) ?? [];
      bucket.push({ slot, index: e.index, raw });
      slotsByUrl.set(e.url, bucket);
    }
  });
  for (const bucket of slotsByUrl.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => a.index - b.index || a.slot - b.slot);
    bucket.forEach(({ slot }, i) => {
      orderedEntries[slot] = sorted[i].raw;
    });
  }

  for (const raw of orderedEntries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as RawReviewEntry;
    const key = typeof entry.key === 'string' ? entry.key : '';
    if (!key || key.startsWith('unobserved:')) continue;
    const label = (typeof entry.label === 'string' ? entry.label : '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const { tagName, xpath, fieldTag, domId } = parseEntryIdentity(entry);
    if (tagName === 'label') continue;

    const actual = typeof entry.actualValue === 'string' ? entry.actualValue.trim() : '';
    const expected = typeof entry.expectedValue === 'string' ? entry.expectedValue.trim() : '';
    if (ANCHOR_RESET_LABELS.test(label)) {
      currentAnchor = '';
    } else if (ANCHOR_LABELS.test(label) && (actual || expected)) {
      const rawAnchor = actual || expected;
      const leaf = rawAnchor.includes(' / ') ? rawAnchor.split(/\s+\/\s+/).pop()!.trim() : rawAnchor;
      currentAnchor = (leaf || rawAnchor).slice(0, 24);
    }

    const targetId = xpath || fieldTag || domId || key;
    const existingIdx = byTarget.get(targetId);
    if (existingIdx !== undefined) {
      const prev = normalized[existingIdx];
      const isActionable = (e: RawReviewEntry) =>
        e.status === 'failed' || e.status === 'deferred' || Boolean(e.required && e.status === 'pending');
      // Prefer specific field labels over generic section headings, and actionable failures over benign entries.
      if (
        (SECTION_TITLES.test(prev.label) && !SECTION_TITLES.test(label)) ||
        (!isActionable(prev.entry) && isActionable(entry) && !SECTION_TITLES.test(label))
      ) {
        normalized[existingIdx] = { entry, key, label, anchor: currentAnchor, targetId };
      }
      continue;
    }
    byTarget.set(targetId, normalized.length);
    normalized.push({ entry, key, label, anchor: currentAnchor, targetId });
  }

  const labelCounts = new Map<string, number>();
  for (const item of normalized) {
    labelCounts.set(item.label, (labelCounts.get(item.label) ?? 0) + 1);
  }

  let filledCount = 0;
  const unfilledItems: FeedbackReviewItem[] = [];
  const adaptedItems: { label: string; actualValue: string }[] = [];
  const seenTargets = new Set<string>();
  const stripComparable = (v: string) =>
    v.replace(/\s*[×✕✖](?=\s*(?:[,，、\n]|$))/gu, '').replace(/[\s\-./:：]/g, '');

  for (const { entry, key, label, anchor, targetId } of normalized) {
    const status = entry.status || '';
    const actual = typeof entry.actualValue === 'string' ? entry.actualValue.trim() : '';
    if (status === 'filled' || status === 'preserved' || (status === 'skipped' && actual && actual !== 'false')) {
      if (status === 'filled' && actual) {
        const requested = typeof entry.requestedValue === 'string' ? entry.requestedValue.trim() : '';
        if (requested && stripComparable(requested) !== stripComparable(actual)) {
          adaptedItems.push({ label, actualValue: actual });
        }
      }
      filledCount++;
      continue;
    }
    const expected = typeof entry.expectedValue === 'string' ? entry.expectedValue.trim() : '';
    const isConsent = /同意|已阅读|隐私|协议|条款|承诺|知情|授权/.test(label);
    if (isConsent && /^(true|同意|已同意|1)$/i.test(actual)) {
      filledCount++;
      continue;
    }
    const isTextAttributeLabel =
      !/上传|附件|文件/.test(label) &&
      /名称|名字|编号|号码|等级|分数|成绩(?!单)|时间|日期|链接|网址|地址|描述|说明|机构|单位/.test(label);
    const hasFileControlIdentity =
      entry.adapter === 'file-upload' ||
      entry.failureCode === 'MANUAL_ATTACHMENT' ||
      [entry.key, entry.legacyKey].some(raw => typeof raw === 'string' && raw.includes('"file"'));
    const isAttachment =
      hasFileControlIdentity ||
      (!isTextAttributeLabel && !expected && /上传|附件|简历|作品|成绩单|证书|照片|头像/.test(label));
    // Drop generic section-title entries that have no expected value and are not consent/attachment controls.
    if (SECTION_TITLES.test(label) && !expected && !isConsent && !isAttachment) continue;

    const isOptionalMissing = entry.failureCode === 'OPTIONAL_MISSING';
    const issue = reviewIssue(entry);
    const auditIncomplete = isIncompleteAudit(entry);
    const manualCheck = auditIncomplete || [AUDIT_FINDING, 'UNKNOWN_CONTROL_MANUAL'].includes(entry.failureCode ?? '');
    if (
      !manualCheck &&
      !entry.required &&
      !actual &&
      entry.readOnly === true &&
      (!entry.controlKind || entry.controlKind === 'text' || entry.controlKind === 'textarea')
    ) {
      continue;
    }
    const shouldReport =
      status === 'failed' ||
      status === 'deferred' ||
      isOptionalMissing ||
      (status === 'skipped' && (!actual || actual === 'false')) ||
      (status === 'pending' && (entry.required || isConsent || isAttachment));
    if (!shouldReport) continue;

    if (seenTargets.has(targetId)) continue;
    seenTargets.add(targetId);

    const isRepeated = (labelCounts.get(label) ?? 0) > 1;
    const isDialCodeSibling =
      isRepeated &&
      /手机|电话|联系方式/.test(label) &&
      !/区号|国际|国家/.test(label) &&
      (expected.startsWith('+') ||
        (Array.isArray(entry.options) && entry.options.some(opt => /^\s*\+\d+/.test(String(opt)))));
    const displayLabel = isDialCodeSibling
      ? `${label}（区号）`
      : (isRepeated || EXPERIENCE_SUBFIELD.test(label)) && anchor && !label.includes(anchor)
        ? `${label}（${anchor}）`
        : label;

    let kind: FeedbackReviewItem['kind'] = 'missing';
    let reason = entry.required ? '必填 · 个人资料未提供' : '资料未设置，可不填';
    if (manualCheck) {
      kind = auditIncomplete ? 'audit' : issue === 'missing' ? 'missing' : 'failed';
      reason = entry.message || '请在网页核对后重新检查。';
    } else if (isConsent) {
      kind = 'consent';
      reason = '待确认并勾选协议';
    } else if (isAttachment) {
      kind = 'attachment';
      reason = '待上传附件';
    } else if (issue === 'invalid') {
      kind = 'failed';
      reason = entry.message || '网页提示此项未通过校验，请检查填写内容。';
    } else if (
      issue === 'missing' ||
      entry.failureCode === 'MISSING_INFORMATION' ||
      entry.failureCode === 'DATE_PRECISION_REQUIRED' ||
      entry.failureCode === 'OPTIONAL_MISSING' ||
      status === 'skipped' ||
      status === 'pending' ||
      (!expected && !actual)
    ) {
      kind = 'missing';
      reason = issue === 'missing' && entry.failureCode !== 'MISSING_INFORMATION' &&
        entry.failureCode !== 'DATE_PRECISION_REQUIRED' && entry.failureCode !== 'OPTIONAL_MISSING'
        ? (entry.message || '网页必填项尚未填写。') :
        entry.failureCode === 'DATE_PRECISION_REQUIRED'
          ? entry.required
            ? '必填 · 资料仅有年月，需补充具体日'
            : '资料仅有年月，需补充具体日'
          : entry.required
            ? '必填 · 个人资料未提供'
            : '资料未设置，可不填';
    } else if (issue === 'mismatch' && actual && expected && actual !== expected) {
      kind = 'verify';
      reason = `网页当前为「${actual}」，拟填写值为「${expected}」。`;
    } else {
      kind = 'audit';
      reason = '部分字段未能读取或确认，尚不能确认是否存在问题。';
    }

    const entryOptions = Array.isArray(entry.options)
      ? entry.options.filter((opt): opt is string => typeof opt === 'string' && Boolean(opt.trim()))
      : [];
    const { tagName } = parseEntryIdentity(entry);
    const inferredControlKind: FeedbackReviewItem['controlKind'] =
      entry.controlKind ??
      (isConsent
        ? 'toggle'
        : entryOptions.length > 0
          ? 'combobox'
          : tagName === 'select'
            ? 'select'
            : tagName === 'textarea'
              ? 'textarea'
              : entry.adapter === 'date-panel' || entry.failureCode === 'DATE_PRECISION_REQUIRED'
                ? 'date'
                : 'text');

    unfilledItems.push({
      manualOnly: manualCheck || kind === 'audit',
      key,
      legacyKey: typeof entry.legacyKey === 'string' ? entry.legacyKey : undefined,
      label: displayLabel.slice(0, 64),
      rawLabel: label.slice(0, 64),
      reason,
      kind,
      required: Boolean(entry.required),
      index: typeof entry.index === 'number' ? entry.index : undefined,
      controlKind: inferredControlKind,
      ...(entryOptions.length > 0 ? { options: entryOptions } : {}),
      ...(entry.typable !== undefined ? { typable: entry.typable } : {}),
      ...(entry.multiple !== undefined ? { multiple: entry.multiple } : {}),
      ...(typeof entry.dateFormat === 'string' && entry.dateFormat ? { dateFormat: entry.dateFormat } : {}),
      ...(expected ? { expectedValue: expected } : {}),
      ...(actual ? { actualValue: actual } : {}),
    });
  }

  // Failure to inspect is one check status, not a separate user task per field.
  const incomplete = unfilledItems.filter(item => item.kind === 'audit');
  if (incomplete.length) {
    const representative = incomplete.find(item => item.key.startsWith('audit-incomplete:')) ?? incomplete[0];
    for (let i = unfilledItems.length - 1; i >= 0; i--) if (unfilledItems[i].kind === 'audit') unfilledItems.splice(i, 1);
    unfilledItems.push({ ...representative, key: INCOMPLETE_REVIEW_PREFIX + representative.key,
      label: '检查未完成', rawLabel: '检查未完成',
      reason: '部分页面内容尚未确认，已填写内容保留。可重新检查。', manualOnly: true });
  }

  // If any unfilled items still share an identical label, number them (1), (2) for clarity.
  const unfilledLabelCounts = new Map<string, number>();
  for (const item of unfilledItems) {
    unfilledLabelCounts.set(item.label, (unfilledLabelCounts.get(item.label) ?? 0) + 1);
  }
  const unfilledLabelSeq = new Map<string, number>();
  for (const item of unfilledItems) {
    if ((unfilledLabelCounts.get(item.label) ?? 0) > 1) {
      const seq = (unfilledLabelSeq.get(item.label) ?? 0) + 1;
      unfilledLabelSeq.set(item.label, seq);
      item.label = `${item.label}（${seq}）`;
    }
  }

  unfilledItems.sort((a, b) => {
    const aOptional = a.kind === 'missing' && !a.required ? 1 : 0;
    const bOptional = b.kind === 'missing' && !b.required ? 1 : 0;
    return aOptional - bOptional;
  });

  return { filledCount, unfilledItems, adaptedItems };
}
