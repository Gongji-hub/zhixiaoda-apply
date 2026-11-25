/** Per-field limits. `steps` caps model-chosen exploration actions, where each step
 * is an unproven guess. Deterministic adapter operations (calendar paging, option
 * clicks, dismissal, recorded-recipe replay) follow a known path that can legitimately
 * be long, e.g. ~9 clicks for a birth date three decades back, so they count against
 * the larger `adapterOps` backstop. Both share the time budget and cycle/stall checks. */
export const EXPLORATION_LIMITS = { steps: 8, adapterOps: 30, totalMs: 30_000, browserMs: 5_000, modelMs: 15_000 };
export type ExplorationStepKind = 'model' | 'adapter';
export type ExplorationCode =
  | 'EXPLORATION_STEPS'
  | 'EXPLORATION_TIMEOUT'
  | 'EXPLORATION_CYCLE'
  | 'EXPLORATION_NO_PROGRESS';
export class ExplorationStopped extends Error {
  constructor(readonly code: ExplorationCode) {
    super(
      {
        EXPLORATION_STEPS: '此字段已达到自动尝试次数上限，请手动补充。',
        EXPLORATION_TIMEOUT: '此字段自动处理超时，请手动补充。',
        EXPLORATION_CYCLE: '此字段反复回到相同状态，已停止自动尝试，请手动补充。',
        EXPLORATION_NO_PROGRESS: '此操作连续两次未改变字段，已阻止重复操作。请换一种操作或手动补充。',
      }[code],
    );
    this.name = 'ExplorationStopped';
  }
}
export const explorationPaused = Symbol('exploration paused');

interface Entry {
  aliases: string[];
  steps: number;
  /** Absent in checkpoints written before adapter operations were counted separately. */
  adapterOps?: number;
  usedMs: number;
  history: string[];
  stalls: Record<string, number>;
  halt?: ExplorationCode;
  activeAt?: number;
}
export type ExplorationSnapshot = Entry[];
type FieldIdentity = { key: string; legacyKey?: string };
// Only fingerprints are checkpointed: field values/candidate lists do not need another stored copy.
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${a >>> 0}:${b >>> 0}`;
}
const scopes = new WeakMap<AbortSignal, ExplorationScope>();
class ExplorationScope {
  readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  get signal() {
    return this.controller.signal;
  }
  constructor(
    readonly entry: Entry,
    readonly limits: typeof EXPLORATION_LIMITS,
  ) {
    scopes.set(this.signal, this);
  }
  assertActive() {
    this.signal.throwIfAborted();
  }
  async settle() {
    await Promise.allSettled(this.pending);
  }
  stop(code: ExplorationCode): never {
    const error = new ExplorationStopped(code);
    if (code !== 'EXPLORATION_NO_PROGRESS') {
      this.entry.halt = code;
      this.controller.abort(error);
    }
    throw error;
  }
  observe(state: unknown) {
    const hash = fingerprint(state);
    const h = this.entry.history;
    // Polling the same state is not progress and does not create a cycle by itself.
    if (h.at(-1) !== hash) h.push(hash);
    if (h.length > 4) h.shift();
    if (h.length === 4 && h[0] === h[2] && h[1] === h[3]) this.stop('EXPLORATION_CYCLE');
    return hash;
  }
  async bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    this.assertActive();
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => {
      if (this.signal.aborted) return;
      this.entry.halt = 'EXPLORATION_TIMEOUT';
      this.controller.abort(new ExplorationStopped('EXPLORATION_TIMEOUT'));
    }, timeoutMs);
    const operation = Promise.resolve().then(() => {
      this.assertActive();
      return work();
    });
    this.pending.add(operation);
    const settled = () => { this.pending.delete(operation); };
    void operation.then(settled, settled);
    try {
      const result = await Promise.race([operation, cancelled]);
      this.assertActive();
      return result;
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', rejectAbort);
    }
  }
  async step<T>(
    action: string,
    before: unknown,
    work: () => Promise<T>,
    after: () => Promise<unknown>,
    kind: ExplorationStepKind = 'model',
  ): Promise<T> {
    this.assertActive();
    const state = this.observe(before);
    const signature = fingerprint([action, state]);
    if ((this.entry.stalls[signature] ?? 0) >= 2) this.stop('EXPLORATION_NO_PROGRESS');
    const counter = kind === 'adapter' ? 'adapterOps' : 'steps';
    const used = this.entry[counter] ?? 0;
    if (used >= this.limits[counter]) this.stop('EXPLORATION_STEPS');
    this.entry[counter] = used + 1;
    try {
      return await this.bounded(async () => {
        const result = await work();
        this.assertActive();
        const observed = await after();
        this.assertActive();
        const next = this.observe(observed);
        this.entry.stalls[signature] = state === next ? (this.entry.stalls[signature] ?? 0) + 1 : 0;
        return result;
      }, this.limits.browserMs);
    } catch (error) {
      if (error === explorationPaused) this.entry[counter] = used;
      throw error;
    }
  }
}
export class ControlExploration {
  private entries: Entry[] = [];
  private readonly active = new Set<ExplorationScope>();
  private paused?: AbortController;
  constructor(private readonly limits = EXPLORATION_LIMITS) {}

  setPaused(paused: boolean) {
    if (paused && !this.paused) {
      this.paused = new AbortController();
      for (const scope of this.active) scope.controller.abort(explorationPaused);
    } else if (!paused && this.paused) {
      const previous = this.paused;
      this.paused = undefined;
      previous.abort();
    }
  }

  private entry(field: FieldIdentity) {
    const aliases = [field.key, field.legacyKey].filter((key): key is string => Boolean(key));
    let entry = this.entries.find(item => aliases.some(key => item.aliases.includes(key)));
    if (!entry) {
      entry = { aliases, steps: 0, usedMs: 0, history: [], stalls: {} };
      this.entries.push(entry);
    } else entry.aliases = [...new Set([...entry.aliases, ...aliases])];
    return entry;
  }
  async run<T>(field: FieldIdentity, parent: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    parent.throwIfAborted();
    const entry = this.entry(field);
    let unfinished: Promise<void> | undefined;
    for (;;) {
      while (this.paused) {
        const resume = this.paused.signal;
        await new Promise<void>(resolve => {
          const ready = () => {
            parent.removeEventListener('abort', ready);
            resume.removeEventListener('abort', ready);
            resolve();
          };
          parent.addEventListener('abort', ready);
          resume.addEventListener('abort', ready);
        });
        parent.throwIfAborted();
      }
      let started = false;
      const scope = new ExplorationScope(entry, this.limits);
      try {
        return await this.runAttempt(scope, parent, async signal => {
          // A CDP click already sent cannot be cancelled by aborting its wrapper.
          // Let it settle before reading the page and starting the field again.
          const preceding = unfinished;
          if (preceding) await scope.bounded(() => preceding, this.limits.browserMs);
          signal.throwIfAborted();
          started = true;
          return work(signal);
        });
      } catch (error) {
        if (error !== explorationPaused) throw error;
        if (started) unfinished = scope.settle();
      }
    }
  }

  private async runAttempt<T>(
    scope: ExplorationScope,
    parent: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    parent.throwIfAborted();
    const { entry } = scope;
    if (entry.halt) throw new ExplorationStopped(entry.halt);
    if (entry.activeAt !== undefined) throw new Error('此字段仍有操作进行中。');
    if (entry.usedMs >= this.limits.totalMs) throw new ExplorationStopped('EXPLORATION_TIMEOUT');
    // Opening a popup in a later pass is intentional, not an A/B loop in one exploration.
    // Attempts, elapsed time and stalled actions still survive every pass.
    entry.history = [];
    const abort = () => scope.controller.abort(parent.reason);
    parent.addEventListener('abort', abort, { once: true });
    entry.activeAt = Date.now();
    this.active.add(scope);
    try {
      return await scope.bounded(() => work(scope.signal), this.limits.totalMs - entry.usedMs);
    } finally {
      entry.usedMs += Math.max(0, Date.now() - entry.activeAt);
      delete entry.activeAt;
      this.active.delete(scope);
      parent.removeEventListener('abort', abort);
      // Retire the lease even after success: detached continuations may never issue another operation.
      scope.controller.abort(new Error('此字段操作已结束，旧结果已失效。'));
    }
  }
  snapshot(): ExplorationSnapshot {
    return structuredClone(this.entries);
  }
  restore(saved: ExplorationSnapshot = []) {
    this.entries = structuredClone(saved).map(entry => {
      if (entry.activeAt !== undefined) entry.usedMs += Math.max(0, Date.now() - entry.activeAt);
      delete entry.activeAt;
      return entry;
    });
  }
}
export async function explorationStep<T>(
  signal: AbortSignal | undefined,
  action: string,
  before: unknown,
  work: () => Promise<T>,
  after: () => Promise<unknown>,
  /** Unmarked callers get the strict model budget, so a new adapter cannot loop unnoticed. */
  options: { kind?: ExplorationStepKind } = {},
): Promise<T> {
  signal?.throwIfAborted();
  const scope = signal && scopes.get(signal);
  if (scope) return scope.step(action, before, work, after, options.kind);
  const result = await work();
  signal?.throwIfAborted();
  return result;
}
export async function explorationModel<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const scope = scopes.get(signal);
  if (scope) return scope.bounded(work, scope.limits.modelMs);
  const result = await work();
  signal.throwIfAborted();
  return result;
}
