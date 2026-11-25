import type { AgentContext } from './types';

const CONSENT_LABEL_RE =
  /(隐私政策|隐私条款|隐私声明|隐私保护|同意隐私|个人信息保护|用户协议|服务协议|使用条款|同意协议|申请须知|投递须知|我已阅读|阅读并同意|本人承诺|真实性声明|信息真实|知情同意)/u;
const NON_TERMS_CONSENT_RE =
  /(不同意|拒绝|没有|暂无|调剂|服从|分配|背景调查|背调|人才库|推荐其他|消息推送|营销|订阅)/u;
const CONSENT_VALUE_RE = /^(同意|已同意|是|确认|true|1)$/iu;

/** Matches only genuine recruiting privacy/terms/authenticity agreements, excluding job-reassignment or background-check choices. */
export function isStrictPrivacyTermsLabel(text: string): boolean {
  return CONSENT_LABEL_RE.test(text) && !NON_TERMS_CONSENT_RE.test(text);
}

/** Every filling decision sees the launch facts and the same accepted, field-bound answers. */
export function applicationEvidence(context: AgentContext): string {
  const task = context.applicationTask ?? '';
  const snapshot = task.match(/<resume_evidence>([\s\S]*?)<\/resume_evidence>/)?.[1] ?? task;
  return JSON.stringify({ launchProfileAndResume: snapshot, acceptedAnswers: context.messageManager.getUserAnswers() });
}

/** True when the user's profile supplement or accepted session answers confirm recruiting privacy/terms consent. */
export function hasConfirmedPrivacyConsent(context: AgentContext): boolean {
  const task = context.applicationTask ?? '';
  const snapshot = task.match(/<resume_evidence>([\s\S]*?)<\/resume_evidence>/)?.[1] ?? task;
  if (snapshot) {
    try {
      const parsed = JSON.parse(snapshot) as {
        rawText?: string;
        profile?: {
          custom_fields?: Array<{ label?: string; value?: string }>;
          supplement_markdown?: string;
          applicationInfo?: {
            custom_fields?: Array<{ label?: string; value?: string }>;
            supplement_markdown?: string;
          };
        };
      };
      const customFields =
        parsed?.profile?.applicationInfo?.custom_fields ?? parsed?.profile?.custom_fields ?? [];
      for (const field of customFields) {
        if (isStrictPrivacyTermsLabel(field.label ?? '') && CONSENT_VALUE_RE.test((field.value ?? '').trim())) {
          return true;
        }
      }
      const supplement =
        parsed?.profile?.applicationInfo?.supplement_markdown ??
        parsed?.profile?.supplement_markdown ??
        parsed?.rawText ??
        '';
      for (const line of supplement.split(/\r?\n/)) {
        const kv = /^\s*(?:[-*+]\s+)?(?:\*\*)?([^：:*\n]{1,80})(?:\*\*)?\s*[：:]\s*(.+?)\s*$/u.exec(line);
        if (kv && isStrictPrivacyTermsLabel(kv[1]) && CONSENT_VALUE_RE.test(kv[2])) {
          return true;
        }
      }
    } catch {
      /* Ignore non-JSON task strings. */
    }
  }
  const answers = context.messageManager?.getUserAnswers?.() ?? [];
  for (const raw of answers) {
    const body = raw
      .replace(/^[\s\S]*?<nano_untrusted_content>\s*/u, '')
      .replace(/\s*<\/nano_untrusted_content>[\s\S]*$/u, '');
    try {
      const parsed = JSON.parse(body) as {
        user_question?: { question?: string; field?: { label?: string } };
        user_answer?: { decision?: string; text?: string };
      };
      const qText = `${parsed.user_question?.question ?? ''} ${parsed.user_question?.field?.label ?? ''}`;
      const aText = (parsed.user_answer?.text ?? '').trim();
      if (
        parsed.user_answer?.decision === 'answer' &&
        isStrictPrivacyTermsLabel(qText) &&
        (CONSENT_VALUE_RE.test(aText) || aText.includes('已完成网页操作'))
      ) {
        return true;
      }
    } catch {
      /* Ignore unparseable answer entries. */
    }
  }
  return false;
}
