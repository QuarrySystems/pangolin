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
