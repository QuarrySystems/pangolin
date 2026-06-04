export class StructuredLogger {
  private readonly secrets = new Set<string>();

  registerSecret(value: string): void {
    if (value.length > 0) this.secrets.add(value);
  }

  log(event: { kind: string; [k: string]: unknown }): void {
    const redacted = this.redact(event);
    process.stdout.write(JSON.stringify(redacted) + '\n');
  }

  /** Redact every registered secret value from a free string — same rule as
   *  log redaction, for content (e.g. a verify report) that is sealed/surfaced
   *  outside the structured log. */
  redactString(value: string): string {
    return this.redact(value) as string;
  }

  private redact(value: unknown): unknown {
    if (typeof value === 'string') {
      let out = value;
      for (const secret of this.secrets) {
        out = out.split(secret).join('<redacted:secret>');
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(v => this.redact(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redact(v);
      return out;
    }
    return value;
  }
}
