import type { FormFieldReference } from './formReview';

export interface UserQuestion {
  kind?: 'information' | 'manual_action';
  blockingDialog?: boolean;
  id: string;
  question: string;
  reason: string;
  options: string[];
  multiple?: boolean;
  field?: FormFieldReference;
  replacement?: { currentValue: string; proposedValue: string; tabId: number };
  replacements?: { field: FormFieldReference; currentValue: string; proposedValue: string; tabId: number }[];
}
export interface UserAnswer {
  questionId: string;
  /** defer：用户稍后亲自处理这一项（补填或网页操作），记为待办，本轮继续处理其余内容。 */
  decision: 'answer' | 'skip' | 'confirm_replace' | 'defer';
  text: string;
  selectedOptions?: string[];
}

/** The page resolved a blocking condition; this is not a user answer or approval. */
export class UserQuestionWithdrawn extends Error {
  constructor() {
    super('网页状态已改变，撤回等待提示');
    this.name = 'UserQuestionWithdrawn';
  }
}

/** One question at a time. An unanswered question blocks the action, not a polling loop. */
export class UserInputGate {
  pending: UserQuestion | null = null;
  interrupted: UserQuestion | null = null;
  onAccepted?: (question: UserQuestion, answer: UserAnswer) => void;
  private settle: ((answer: UserAnswer) => void) | null = null;
  private withdrawPending: (() => void) | null = null;

  async ask(
    question: Omit<UserQuestion, 'id'>,
    signal: AbortSignal,
    publish: (question: UserQuestion) => Promise<void>,
  ): Promise<UserAnswer> {
    if (this.pending) throw new Error('已有问题正在等待用户回答');
    if (signal.aborted) throw new Error('操作已取消');
    const pending = { ...question, id: crypto.randomUUID() };
    this.pending = pending;
    return new Promise<UserAnswer>((resolve, reject) => {
      const clear = () => {
        signal.removeEventListener('abort', abort);
        if (this.pending === pending) {
          this.pending = null;
          this.settle = null;
          this.withdrawPending = null;
        }
      };
      const abort = () => {
        this.interrupted = pending;
        clear();
        reject(new Error('操作已取消'));
      };
      this.settle = answer => {
        this.interrupted = null;
        clear();
        resolve(answer);
      };
      this.withdrawPending = () => {
        this.interrupted = null;
        clear();
        reject(new UserQuestionWithdrawn());
      };
      signal.addEventListener('abort', abort, { once: true });
      publish(pending).catch(error => {
        clear();
        reject(error);
      });
    });
  }

  withdraw(questionId: string): boolean {
    if (this.pending?.id !== questionId || !this.withdrawPending) return false;
    this.withdrawPending();
    return true;
  }

  answer(answer: UserAnswer): boolean {
    if (!this.pending || answer.questionId !== this.pending.id || !this.settle) return false;
    if (
      !['answer', 'skip', 'confirm_replace', 'defer'].includes(answer.decision) ||
      typeof answer.text !== 'string' ||
      answer.text.length > 4000 ||
      (answer.decision === 'answer' && !answer.text.trim())
    )
      return false;
    if ((answer.decision === 'confirm_replace') !== Boolean(this.pending.replacement) && !['skip', 'defer'].includes(answer.decision))
      return false;
    let text = answer.text.trim();
    if (answer.decision === 'answer' && this.pending.kind !== 'manual_action' && this.pending.options.length) {
      if (this.pending.multiple) {
        if (!Array.isArray(answer.selectedOptions) || !answer.selectedOptions.length ||
          new Set(answer.selectedOptions).size !== answer.selectedOptions.length ||
          answer.selectedOptions.some(option => !this.pending!.options.includes(option))) return false;
        text = answer.selectedOptions.join('、');
      } else if (!this.pending.options.includes(text)) return false;
    }
    const accepted = { ...answer, text };
    this.onAccepted?.(this.pending, accepted);
    this.settle(accepted);
    return true;
  }
}
