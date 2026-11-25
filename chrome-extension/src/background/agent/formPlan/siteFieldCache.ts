import type { AgentContext } from '../types';
import { applicationEvidence } from '../applicationEvidence';
import { formValuesEquivalent } from '../../browser/formFill';
import type { FormOutline, OutlineField, FieldKind } from './outline';

const STORAGE_KEY = 'jobAgentSiteFieldCache';
const MAX_SITES = 100;
const MAX_FIELDS_PER_SITE = 80;

const REPEATABLE_SECTION_RE =
  /教育经历|工作经历|实习经历|项目经历|培训经历|获奖|荣誉|证书|语言能力|家庭成员|社会实践|校园经历|发表论文|专利|education|work\s*experience|internship|project|award|certificate|publication/i;
const REPEATED_LABEL_SUFFIX_RE = /（\d+\/\d+）$/;

const STANDARD_FIELD_ALIASES: ReadonlyArray<{ labelRe: RegExp; keyRe: RegExp }> = [
  { labelRe: /^(姓名|名字|中文名|真实姓名|full\s*name|name)$/i, keyRe: /(^|\.|^raw:|^answer:)(name|fullName|姓名|名字|中文名)$/i },
  { labelRe: /^(邮箱|电子邮箱|联系邮箱|联系电邮|电邮|email|e-mail)$/i, keyRe: /(^|\.|^raw:|^answer:)(email|邮箱|电子邮箱|联系邮箱|联系电邮)$/i },
  { labelRe: /^(手机|手机号|手机号码|电话|联系电话|移动电话|phone|mobile)$/i, keyRe: /(^|\.|^raw:|^answer:)(phone|mobile|手机|手机号|手机号码|电话|联系电话)$/i },
  { labelRe: /^(性别|gender|sex)$/i, keyRe: /(^|\.|^raw:|^answer:)(gender|sex|性别)$/i },
  { labelRe: /^(民族|ethnicity)$/i, keyRe: /(^|\.|^raw:|^answer:)(ethnicity|民族)$/i },
  { labelRe: /^(政治面貌|political\s*status)$/i, keyRe: /(^|\.|^raw:|^answer:)(politicalStatus|政治面貌)$/i },
  { labelRe: /^(籍贯|native\s*place|hometown)$/i, keyRe: /(^|\.|^raw:|^answer:)(nativePlace|hometown|籍贯)$/i },
  { labelRe: /^(现居地|居住地|当前城市|所在城市|通讯地址|current\s*city|location|address)$/i, keyRe: /(^|\.|^raw:|^answer:)(currentCity|city|location|address|现居地|居住地|当前城市|所在城市|通讯地址)$/i },
  { labelRe: /^(最高学历|学历|highest\s*degree|degree)$/i, keyRe: /(^|\.|^raw:|^answer:)(highestDegree|degree|最高学历|学历)$/i },
  { labelRe: /^(微信|微信号|wechat)$/i, keyRe: /(^|\.|^raw:|^answer:)(wechat|微信|微信号)$/i },
];

export type CachedWriteHow = 'type' | 'choose' | 'choose_many' | 'date' | 'check' | null;

export interface CachedFieldRule {
  signature: string;
  kind: FieldKind;
  label: string;
  factKey: string;
  itemFactKeys?: string[];
  how: CachedWriteHow;
  updatedAt: number;
}

interface SiteCacheStore {
  sites: Record<string, { updatedAt: number; rules: Record<string, CachedFieldRule> }>;
}

let memoryStore: SiteCacheStore | null = null;
let useMemoryStoreInTests = false;

/** 测试环境显式开启或重置内存级站点字段规则缓存。 */
export function setSiteFieldMemoryCacheForTest(enabled: boolean): void {
  useMemoryStoreInTests = enabled;
  memoryStore = enabled ? { sites: {} } : null;
}

/** 将动态路径段（纯数字、UUID、长哈希）归一为 :id，使同一站点的不同职位共享表单映射。 */
export function sitePatternKey(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname
      .split('/')
      .map(segment => {
        if (!segment) return '';
        if (/^\d+$/.test(segment)) return ':id';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':id';
        if (/^[0-9a-f]{16,}$/i.test(segment)) return ':id';
        return segment;
      });
    return `${parsed.origin}${segments.join('/')}`;
  } catch {
    return url;
  }
}

export function fieldRuleSignature(
  kind: string,
  label: string,
  nameAttr = '',
): string {
  const normLabel = label.replace(/\s+/g, ' ').trim();
  const normName = nameAttr.trim();
  return `${kind}\u0000${normLabel}\u0000${normName}`;
}

export function fieldFallbackSignature(kind: string, label: string): string {
  return `${kind}\u0000${label.replace(/\s+/g, ' ').trim()}\u0000`;
}

function collectObjectFacts(value: unknown, prefix: string, out: Map<string, string>, depth = 0): void {
  if (depth > 5 || value == null) return;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (text && text.length <= 200) out.set(prefix, text);
    return;
  }
  if (Array.isArray(value)) {
    // 多段经历数组（如 educations、workExperiences）条目数与顺序随简历变化，不作为静态单值规则缓存；
    // 仅提取明确具有 { label, value/text } 结构的网申补充与问答项。
    value.forEach(item => {
      if (item && typeof item === 'object' && 'label' in item && ('text' in item || 'value' in item)) {
        const label = String((item as { label?: unknown }).label ?? '').trim();
        const text = String((item as { text?: unknown; value?: unknown }).text ?? (item as { value?: unknown }).value ?? '').trim();
        if (label && label !== '__md__' && text && text.length <= 200) {
          out.set(`supplement:${label}`, text);
        }
      }
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (['hash', 'materialId', 'resumeId', 'userId', 'version', 'profileVersion', 'preparedAt', 'rawText', 'supplement_markdown'].includes(k)) {
        if (k === 'supplement_markdown' && typeof v === 'string') {
          for (const line of v.split('\n')) {
            const m =
              /^\s*[-*+]\s+\*\*([^*\n]{1,120})\*\*\s*[：:]\s*(.+)$/u.exec(line) ??
              /^\s*([^：:*#\n-][^：:*#\n]{0,59})\s*[：:](?!\/\/)\s*(.+)$/u.exec(line);
            if (m) {
              const label = m[1].trim();
              const val = m[2].trim();
              if (label && val && val.length <= 200) out.set(`supplement:${label}`, val);
            }
          }
        }
        continue;
      }
      collectObjectFacts(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  }
}

function collectRawTextFacts(rawText: string, out: Map<string, string>): void {
  const segments = rawText.split(/[；;\n。]+/);
  const duplicateKeys = new Set<string>();
  for (const segment of segments) {
    const match = segment.match(/^\s*([^：:；;\n]{1,24}?)\s*[：:]\s*([^\n]{1,120}?)\s*$/);
    if (!match) continue;
    const key = match[1].trim();
    const val = match[2].trim();
    if (!key || !val) continue;
    const factKey = `raw:${key}`;
    if (duplicateKeys.has(factKey)) continue;
    const existing = out.get(factKey);
    if (existing !== undefined && existing !== val && !formValuesEquivalent(existing, val)) {
      out.delete(factKey);
      duplicateKeys.add(factKey);
      continue;
    }
    out.set(factKey, val);
  }
}

/** 从当前任务的简历快照与已接受回答中提取原子标准事实映射（factKey -> value）。 */
export function extractEvidenceFacts(context: AgentContext): Map<string, string> {
  const facts = new Map<string, string>();
  try {
    const evidenceRaw = applicationEvidence(context);
    const parsed = JSON.parse(evidenceRaw) as {
      launchProfileAndResume?: string;
      acceptedAnswers?: string[];
    };
    const launch = parsed.launchProfileAndResume ?? '';
    if (launch) {
      try {
        const launchObj = JSON.parse(launch) as Record<string, unknown>;
        if (launchObj.profile && typeof launchObj.profile === 'object') {
          collectObjectFacts(launchObj.profile, 'profile', facts);
        }
        const rawText =
          typeof launchObj.rawText === 'string'
            ? launchObj.rawText
            : typeof (launchObj.source as { rawText?: unknown } | null)?.rawText === 'string'
              ? String((launchObj.source as { rawText: string }).rawText)
              : '';
        if (rawText) collectRawTextFacts(rawText, facts);
      } catch {
        collectRawTextFacts(launch, facts);
      }
    }
    for (const entry of parsed.acceptedAnswers ?? []) {
      const jsonMatch = entry.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      try {
        const item = JSON.parse(jsonMatch[0]) as {
          user_question?: { question?: string; field?: { label?: string } };
          user_answer?: { decision?: string; text?: string };
        };
        if (item.user_answer?.decision === 'answer' && item.user_answer.text?.trim()) {
          const label = (item.user_question?.field?.label || item.user_question?.question || '').trim();
          if (label) facts.set(`answer:${label}`, item.user_answer.text.trim());
        }
      } catch {
        /* Ignore malformed answer snippet. */
      }
    }
  } catch {
    /* Ignore unparseable evidence. */
  }
  return facts;
}

function findFactKeyForValue(facts: Map<string, string>, value: string, fieldLabel: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  const cleanLabel = fieldLabel.replace(/（\d+\/\d+）$/, '').replace(/（提示：.*）$/, '').trim();
  const candidates: string[] = [];
  for (const [key, factValue] of facts.entries()) {
    if (factValue === trimmed || formValuesEquivalent(factValue, trimmed)) {
      candidates.push(key);
    }
  }
  if (!candidates.length) return null;
  const exactLabelMatch = candidates.find(
    key =>
      key === `raw:${cleanLabel}` ||
      key === `answer:${cleanLabel}` ||
      key === `answer:${fieldLabel.trim()}` ||
      key.toLowerCase().endsWith(`.${cleanLabel.toLowerCase()}`),
  );
  if (exactLabelMatch) return exactLabelMatch;
  for (const alias of STANDARD_FIELD_ALIASES) {
    if (alias.labelRe.test(cleanLabel)) {
      const aliasMatches = candidates.filter(key => alias.keyRe.test(key));
      if (aliasMatches.length === 1) return aliasMatches[0];
    }
  }
  // 标签与标准别名均未命中时不按值相等猜测绑定，防止“否/是”等短值造成跨字段污染。
  return null;
}

function collectNonUniqueSignatures(outline: FormOutline): Set<string> {
  const counts = new Map<string, number>();
  for (const field of outline.fields.values()) {
    const primarySig = fieldRuleSignature(field.kind, field.label, field.node.attributes.name ?? '');
    const fallbackSig = fieldFallbackSignature(field.kind, field.label);
    counts.set(primarySig, (counts.get(primarySig) ?? 0) + 1);
    if (fallbackSig !== primarySig) {
      counts.set(fallbackSig, (counts.get(fallbackSig) ?? 0) + 1);
    }
  }
  const nonUnique = new Set<string>();
  for (const [sig, count] of counts.entries()) {
    if (count > 1) nonUnique.add(sig);
  }
  return nonUnique;
}

function isRepeatableField(field: OutlineField, nonUnique: Set<string>): boolean {
  if (REPEATED_LABEL_SUFFIX_RE.test(field.label)) return true;
  if (field.context && REPEATABLE_SECTION_RE.test(field.context)) return true;
  const primarySig = fieldRuleSignature(field.kind, field.label, field.node.attributes.name ?? '');
  return nonUnique.has(primarySig);
}

async function readStore(): Promise<SiteCacheStore | null> {
  const hasChromeStorage = typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local?.get);
  if (!hasChromeStorage && !useMemoryStoreInTests) return null;
  if (hasChromeStorage) {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const raw = data?.[STORAGE_KEY] as SiteCacheStore | undefined;
      if (raw && typeof raw === 'object' && raw.sites && typeof raw.sites === 'object') {
        memoryStore = raw;
        return raw;
      }
    } catch {
      /* Fall back to in-memory store. */
    }
  }
  if (!memoryStore) memoryStore = { sites: {} };
  return memoryStore;
}

async function writeStore(store: SiteCacheStore): Promise<void> {
  const siteEntries = Object.entries(store.sites);
  if (siteEntries.length > MAX_SITES) {
    siteEntries
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(MAX_SITES)
      .forEach(([key]) => delete store.sites[key]);
  }
  memoryStore = store;
  if (typeof chrome !== 'undefined' && chrome?.storage?.local?.set) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: store });
    } catch {
      /* Ignore storage quota or permission errors. */
    }
  }
}

function inferDefaultHow(field: OutlineField): CachedWriteHow {
  if (field.datePicker) return 'date';
  if (field.multiple) return 'choose_many';
  if (field.kind === 'combobox' || field.kind === 'select') return 'choose';
  if (field.kind === 'checkbox' || field.kind === 'radio' || field.kind === 'switch') return 'check';
  return 'type';
}

/**
 * 匹配当前站点已缓存的标准字段规则，并用当前用户的简历事实解析出待填值。
 * 只返回在当前用户资料中有明确非空值、且当前控件为空的字段。
 */
export async function matchCachedSiteRules(
  context: AgentContext,
  outline: FormOutline,
): Promise<{ id: string; value: string | null; how: CachedWriteHow; items: string[] | null }[]> {
  const url =
    outline.state?.url ||
    (await context.browserContext?.getCachedState?.().catch(() => null))?.url ||
    '';
  if (!url) return [];
  const store = await readStore();
  if (!store) return [];
  const siteKey = sitePatternKey(url);
  const site = store.sites[siteKey];
  if (!site?.rules) return [];
  const facts = extractEvidenceFacts(context);
  if (!facts.size) return [];
  const nonUnique = collectNonUniqueSignatures(outline);

  const matched: { id: string; value: string | null; how: CachedWriteHow; items: string[] | null }[] = [];
  for (const field of outline.fields.values()) {
    if (context.review.isSkipped(field.field) || context.review.isAutoDeferred(field.field)) continue;
    if (field.value.trim() && field.selectionConfirmed !== false && field.valid) continue;
    if (isRepeatableField(field, nonUnique)) continue;

    const primarySig = fieldRuleSignature(field.kind, field.label, field.node.attributes.name ?? '');
    const fallbackSig = fieldFallbackSignature(field.kind, field.label);
    const rule = site.rules[primarySig] ?? (!nonUnique.has(fallbackSig) ? site.rules[fallbackSig] : undefined);
    if (!rule) continue;

    if (rule.itemFactKeys?.length) {
      const resolvedItems = rule.itemFactKeys.map(k => facts.get(k)?.trim() ?? '').filter(Boolean);
      if (resolvedItems.length === rule.itemFactKeys.length) {
        matched.push({
          id: field.id,
          value: resolvedItems.join('、'),
          how: 'choose_many',
          items: resolvedItems,
        });
      }
      continue;
    }

    const resolvedValue = facts.get(rule.factKey)?.trim();
    if (!resolvedValue) continue;

    if (field.kind === 'select' && field.options?.length) {
      const hasOption = field.options.some(opt => opt === resolvedValue || formValuesEquivalent(opt, resolvedValue));
      if (!hasOption) continue;
    }

    matched.push({
      id: field.id,
      value: resolvedValue,
      how: rule.how ?? inferDefaultHow(field),
      items: null,
    });
  }
  return matched;
}

/** 将整页填写中已通过回读核验的字段映射写入站点规则缓存。 */
export async function recordVerifiedSiteRules(
  context: AgentContext,
  outline: FormOutline,
  planned: { id: string; value: string | null; how: CachedWriteHow; items: string[] | null }[],
  writtenIds: Set<string>,
): Promise<void> {
  const url =
    outline.state?.url ||
    (await context.browserContext?.getCachedState?.().catch(() => null))?.url ||
    '';
  if (!url || !writtenIds.size) return;
  const store = await readStore();
  if (!store) return;
  const facts = extractEvidenceFacts(context);
  if (!facts.size) return;
  const nonUnique = collectNonUniqueSignatures(outline);

  const siteKey = sitePatternKey(url);
  const site = (store.sites[siteKey] ??= { updatedAt: Date.now(), rules: {} });
  let changed = false;

  for (const item of planned) {
    if (!writtenIds.has(item.id)) continue;
    const field = outline.fields.get(item.id);
    if (!field || isRepeatableField(field, nonUnique)) continue;

    const primarySig = fieldRuleSignature(field.kind, field.label, field.node.attributes.name ?? '');
    const fallbackSig = fieldFallbackSignature(field.kind, field.label);

    if (item.items?.length) {
      const itemKeys = item.items.map(sub => findFactKeyForValue(facts, sub, field.label));
      if (itemKeys.every((k): k is string => Boolean(k))) {
        const rule: CachedFieldRule = {
          signature: primarySig,
          kind: field.kind,
          label: field.label,
          factKey: itemKeys[0],
          itemFactKeys: itemKeys,
          how: 'choose_many',
          updatedAt: Date.now(),
        };
        site.rules[primarySig] = rule;
        if (!nonUnique.has(fallbackSig)) site.rules[fallbackSig] = rule;
        changed = true;
      }
      continue;
    }

    const rawVal = item.value?.trim() ?? '';
    if (!rawVal) continue;
    const factKey = findFactKeyForValue(facts, rawVal, field.label);
    if (!factKey) continue;

    const rule: CachedFieldRule = {
      signature: primarySig,
      kind: field.kind,
      label: field.label,
      factKey,
      how: item.how ?? inferDefaultHow(field),
      updatedAt: Date.now(),
    };
    site.rules[primarySig] = rule;
    if (!nonUnique.has(fallbackSig)) site.rules[fallbackSig] = rule;
    changed = true;
  }

  if (changed) {
    site.updatedAt = Date.now();
    const ruleEntries = Object.entries(site.rules);
    if (ruleEntries.length > MAX_FIELDS_PER_SITE) {
      ruleEntries
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(MAX_FIELDS_PER_SITE)
        .forEach(([k]) => delete site.rules[k]);
    }
    await writeStore(store);
  }
}

/** 单步动作（如用户回答后逐项写入）核验成功时，同步记录到站点规则缓存。 */
export async function recordVerifiedFieldWrite(
  context: AgentContext,
  url: string | undefined,
  kind: FieldKind,
  label: string,
  nameAttr: string,
  value: string,
  how: CachedWriteHow,
): Promise<void> {
  if (!url || !value.trim()) return;
  if (REPEATED_LABEL_SUFFIX_RE.test(label) || REPEATABLE_SECTION_RE.test(label)) return;
  const store = await readStore();
  if (!store) return;
  const facts = extractEvidenceFacts(context);
  if (!facts.size) return;
  const factKey = findFactKeyForValue(facts, value, label);
  if (!factKey) return;

  const siteKey = sitePatternKey(url);
  const site = (store.sites[siteKey] ??= { updatedAt: Date.now(), rules: {} });
  const primarySig = fieldRuleSignature(kind, label, nameAttr);
  const fallbackSig = fieldFallbackSignature(kind, label);
  const rule: CachedFieldRule = {
    signature: primarySig,
    kind,
    label,
    factKey,
    how,
    updatedAt: Date.now(),
  };
  site.rules[primarySig] = rule;
  site.rules[fallbackSig] = rule;
  site.updatedAt = Date.now();
  await writeStore(store);
}
