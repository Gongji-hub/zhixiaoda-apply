import type { FormFieldReference } from './formReview';

export interface UserQuestion {
  kind?: 'information' | 'manual_action';
  id: string;
  question: string;
  reason: string;
  options: string[];
  field?: FormFieldReference;
  replacement?: { currentValue: string; proposedValue: string; tabId: number };
  replacements?: { field: FormFieldReference; currentValue: string; proposedValue: string; tabId: number }[];
}
export interface UserAnswer {
  questionId: string;
  /** defer：用户稍后亲自处理这一项（补填或网页操作），记为待办，本轮继续处理其余内容。 */
  decision: 'answer' | 'skip' | 'confirm_replace' | 'defer';
  text: string;
}

/** One question at a time. An unanswered question blocks the action, not a polling loop. */
export class UserInputGate {
  pending: UserQuestion | null = null;
  interrupted: UserQuestion | null = null;
  onAccepted?: (question: UserQuestion, answer: UserAnswer) => void;
  private settle: ((answer: UserAnswer) => void) | null = null;

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
        this.pending = null;
        this.settle = null;
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
      signal.addEventListener('abort', abort, { once: true });
      publish(pending).catch(error => {
        clear();
        reject(error);
      });
    });
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
    const accepted = { ...answer, text: answer.text.trim() };
    this.onAccepted?.(this.pending, accepted);
    this.settle(accepted);
    return true;
  }
}
