import { createHmac, timingSafeEqual } from "node:crypto";
import type { MutationAuthority, MutationAuthorityRequest } from "../../src/env.js";
import { canonicalJson } from "../../src/protocol/canonical.js";
import {
  MUTATION_AUTHORIZATION_ALGORITHM,
  MUTATION_AUTHORIZATION_SCHEMA_VERSION,
  type MutationAuthorizationDomain,
  type MutationAuthorizationEnvelope,
} from "../../src/protocol/models.js";

export interface DeterministicMutationAuthorityOptions {
  readonly authorityId?: string;
  readonly authorityEpoch?: number;
  readonly key?: string;
  readonly isCurrent?: () => Promise<boolean>;
  readonly onAcquireLease?: () => void;
  readonly onReleaseLease?: () => void | Promise<void>;
  readonly journalTipState?: DeterministicJournalTipState;
}

export interface DeterministicJournalTip {
  readonly operationId: string;
  readonly sequence: number;
  readonly seal: string;
}

export interface DeterministicJournalTipState {
  tip?: DeterministicJournalTip;
  readUnavailable?: boolean;
  writeUnavailable?: boolean;
}

export function deterministicMutationAuthority(
  options: DeterministicMutationAuthorityOptions = {},
): MutationAuthority {
  const authorityId = options.authorityId ?? "test-authority";
  const authorityEpoch = options.authorityEpoch ?? 1;
  const key = options.key ?? "cellarer-deterministic-test-authority";

  const mac = <Domain extends MutationAuthorizationDomain>(
    request: MutationAuthorityRequest<Domain>,
    envelope: Omit<MutationAuthorizationEnvelope<Domain>, "seal">,
  ): string =>
    `hmac-sha256:${createHmac("sha256", key)
      .update(
        `cellarer-mutation-authority\0${request.domain}\0${canonicalJson({ request, envelope })}`,
      )
      .digest("hex")}`;

  const seal = <Domain extends MutationAuthorizationDomain>(
    request: MutationAuthorityRequest<Domain>,
  ): MutationAuthorizationEnvelope<Domain> => {
    const envelope = {
      schemaVersion: MUTATION_AUTHORIZATION_SCHEMA_VERSION,
      domain: request.domain,
      algorithm: MUTATION_AUTHORIZATION_ALGORITHM,
      authorityId,
      authorityEpoch,
    };
    return { ...envelope, seal: mac(request, envelope) };
  };

  const verify = <Domain extends MutationAuthorizationDomain>(
    request: MutationAuthorityRequest<Domain>,
    envelope: MutationAuthorizationEnvelope<Domain>,
  ): boolean => {
    if (
      envelope.schemaVersion !== MUTATION_AUTHORIZATION_SCHEMA_VERSION ||
      envelope.domain !== request.domain ||
      envelope.algorithm !== MUTATION_AUTHORIZATION_ALGORITHM ||
      envelope.authorityId !== authorityId ||
      envelope.authorityEpoch !== authorityEpoch
    ) {
      return false;
    }
    const { seal: _seal, ...metadata } = envelope;
    const expected = Buffer.from(mac(request, metadata));
    const actual = Buffer.from(envelope.seal);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  const isCurrent = options.isCurrent ?? (async () => true);
  const journalTipState = options.journalTipState ?? {};
  const publishJournalTip = async (tip: DeterministicJournalTip) => {
    if (journalTipState.writeUnavailable) {
      throw new Error("protected journal tip publication failed");
    }
    journalTipState.tip = { ...tip };
  };
  const matchesJournalTip = async (tip: DeterministicJournalTip) => {
    if (journalTipState.readUnavailable) return false;
    return (
      journalTipState.tip?.operationId === tip.operationId &&
      journalTipState.tip.sequence === tip.sequence &&
      journalTipState.tip.seal === tip.seal
    );
  };
  const acquireLease = async () => {
    options.onAcquireLease?.();
    let released = false;
    return Object.freeze({
      isCurrent: async () => !released && (await isCurrent()),
      release: async () => {
        if (released) return;
        released = true;
        await options.onReleaseLease?.();
      },
    });
  };

  return Object.freeze(
    Object.defineProperties(
      {},
      {
        seal: { value: seal, enumerable: false },
        verify: { value: verify, enumerable: false },
        isCurrent: { value: isCurrent, enumerable: false },
        acquireLease: { value: acquireLease, enumerable: false },
        publishJournalTip: { value: publishJournalTip, enumerable: false },
        matchesJournalTip: { value: matchesJournalTip, enumerable: false },
      },
    ),
  ) as MutationAuthority;
}
