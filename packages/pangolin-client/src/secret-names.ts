// The staged-secret naming contract (KNOWN-ISSUES 10).
//
// `fireWork` stages two kinds of per-dispatch secret, and until now the names
// it chose were an undeclared internal convention: correct, stable, and
// discoverable only by reading the dispatch path. A caller writing a
// least-privilege IAM policy had to hardcode string shapes it had no promise
// about — the same coupling problem as the undeclared `inputs.*` carriers.
//
// Declaring it is the fix. The names are DETERMINISTIC given `dispatchId`,
// which a caller may supply on `DispatchWork`, so a policy bounded to a single
// dispatch is expressible — see `dispatchSecretPolicyPatterns`.
//
// Worth stating plainly, because the original report argued otherwise: the
// six random characters Secrets Manager appends to every secret ARN are NOT
// what blocks least-privilege scoping. An IAM resource wildcard covers them,
// which is why the patterns below end in `*`. What was missing was a promise
// about the name, not a way to predict the ARN.

/** Prefix under which each dispatch's per-dispatch callback HMAC key is staged. */
export const CALLBACK_HMAC_NAME_PREFIX = 'pangolin/callback-hmac';

/**
 * Name of the secret holding a dispatch's inline `secrets:` entry for
 * `envName`. Stable across releases; safe to build IAM policies against.
 */
export function dispatchSecretName(dispatchId: string, envName: string): string {
  return `${dispatchId}/${envName}`;
}

/**
 * Name of the secret holding a dispatch's callback HMAC key — the credential
 * that authenticates that dispatch's callbacks, and therefore the one whose
 * over-broad grant matters most.
 */
export function callbackHmacSecretName(
  dispatchId: string,
  namePrefix: string = CALLBACK_HMAC_NAME_PREFIX,
): string {
  return `${namePrefix}/${dispatchId}`;
}

/**
 * The two Secrets Manager resource patterns covering exactly one dispatch's
 * staged secrets — the tightest grant that still works, for a caller building
 * a per-dispatch task role (see `FargateProviderOpts.taskRoleArn`).
 *
 * Two patterns rather than one because the inline secrets and the callback key
 * do not share a prefix. The trailing `*` absorbs Secrets Manager's random
 * six-character ARN suffix.
 *
 * ```
 * arn:aws:secretsmanager:<region>:<account>:secret:<dispatchId>/*
 * arn:aws:secretsmanager:<region>:<account>:secret:pangolin/callback-hmac/<dispatchId>-*
 * ```
 *
 * Returns the resource-name portion only; the caller prepends its own
 * `arn:aws:secretsmanager:<region>:<account>:secret:`.
 */
export function dispatchSecretPolicyPatterns(
  dispatchId: string,
  namePrefix: string = CALLBACK_HMAC_NAME_PREFIX,
): string[] {
  return [`${dispatchId}/*`, `${namePrefix}/${dispatchId}-*`];
}
