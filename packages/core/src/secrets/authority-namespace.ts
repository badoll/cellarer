export const MUTATION_AUTHORITY_CREDENTIAL_SERVICE = "dev.cellarer.mutation-authority.v1";
export const MUTATION_AUTHORITY_ACCOUNT_PREFIX = "__cellarer_internal__:mutation-authority:v1:";

const AUTHORITY_ACCOUNT_RE = new RegExp(
  `^${escapeRegExp(MUTATION_AUTHORITY_ACCOUNT_PREFIX)}[0-9a-f]{64}$`,
);

export function isMutationAuthorityCredentialTarget(service: string, account: string): boolean {
  return (
    service === MUTATION_AUTHORITY_CREDENTIAL_SERVICE ||
    account.startsWith(MUTATION_AUTHORITY_ACCOUNT_PREFIX)
  );
}

export function assertOrdinarySecretCredentialTarget(service: string, account: string): void {
  if (isMutationAuthorityCredentialTarget(service, account)) {
    throw new TypeError("reserved mutation authority credential namespace");
  }
}

export function assertMutationAuthorityCredentialTarget(service: string, account: string): void {
  if (service !== MUTATION_AUTHORITY_CREDENTIAL_SERVICE || !AUTHORITY_ACCOUNT_RE.test(account)) {
    throw new TypeError("invalid mutation authority credential namespace");
  }
}

export function isReservedMutationAuthorityAccount(name: string): boolean {
  return name.startsWith(MUTATION_AUTHORITY_ACCOUNT_PREFIX);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
