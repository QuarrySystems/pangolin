export class SecretStoreMismatchError extends Error {
  constructor(
    public readonly bundle: string,
    public readonly bundleKind: string,
    public readonly targetKind: string | undefined,
  ) {
    super(
      `env bundle "${bundle}" was staged for store kind "${bundleKind}" but target uses "${targetKind ?? '(none)'}"`,
    );
    this.name = 'SecretStoreMismatchError';
  }
}

/**
 * Thrown by `fireWork` when `work.dedupeOnDispatchId` is set and a
 * `dispatches/<id>/fired.json` marker already exists for `dispatchId` —
 * i.e. this dispatch id was already fired once. Best-effort dedupe, not a
 * mutex (see the `dedupeOnDispatchId` doc on `DispatchWork`).
 */
export class DispatchAlreadyExistsError extends Error {
  constructor(public readonly dispatchId: string) {
    super(`dispatch "${dispatchId}" was already fired (dedupeOnDispatchId)`);
    this.name = 'DispatchAlreadyExistsError';
  }
}
