/** Failed writes need changed page evidence or a field-specific human action before another attempt. */
export class FormRetries {
  private readonly failed = new Map<string, { desired: string; actual: string; structure: string }>();

  record(key: string, desired: string, actual: string, structure: string): void {
    this.failed.set(key, { desired, actual, structure });
  }

  blocked(key: string, desired: string, actual: string, structure: string): boolean {
    const previous = this.failed.get(key);
    return Boolean(
      previous && previous.desired === desired && previous.actual === actual && previous.structure === structure,
    );
  }

  allowAfterHumanAction(key: string): void {
    this.failed.delete(key);
  }

  clearResolved(key: string): void {
    this.failed.delete(key);
  }
}
