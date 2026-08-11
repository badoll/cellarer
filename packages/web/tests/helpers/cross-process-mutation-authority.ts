import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  canonicalJson,
  type MutationAuthority,
  type MutationAuthorityRequest,
  type MutationAuthorizationEnvelope,
  type ProtectedJournalTip,
} from "@cellarer/core";

const AUTHORITY_ID = "web-cross-process-test-authority";
const AUTHORITY_EPOCH = 1;
const AUTHORITY_KEY = "cellarer-web-cross-process-test-authority";

export function crossProcessMutationAuthority(tipPath: string): MutationAuthority {
  const mac = <Domain extends MutationAuthorizationEnvelope["domain"]>(
    request: MutationAuthorityRequest<Domain>,
    envelope: Omit<MutationAuthorizationEnvelope<Domain>, "seal">,
  ): string =>
    `hmac-sha256:${createHmac("sha256", AUTHORITY_KEY)
      .update(
        `cellarer-mutation-authority\0${request.domain}\0${canonicalJson({ request, envelope })}`,
      )
      .digest("hex")}`;

  const seal = <Domain extends MutationAuthorizationEnvelope["domain"]>(
    request: MutationAuthorityRequest<Domain>,
  ): MutationAuthorizationEnvelope<Domain> => {
    const envelope = {
      schemaVersion: 1 as const,
      domain: request.domain,
      algorithm: "HMAC-SHA-256" as const,
      authorityId: AUTHORITY_ID,
      authorityEpoch: AUTHORITY_EPOCH,
    };
    return { ...envelope, seal: mac(request, envelope) };
  };

  const verify = <Domain extends MutationAuthorizationEnvelope["domain"]>(
    request: MutationAuthorityRequest<Domain>,
    envelope: MutationAuthorizationEnvelope<Domain>,
  ): boolean => {
    if (
      envelope.schemaVersion !== 1 ||
      envelope.domain !== request.domain ||
      envelope.algorithm !== "HMAC-SHA-256" ||
      envelope.authorityId !== AUTHORITY_ID ||
      envelope.authorityEpoch !== AUTHORITY_EPOCH
    ) {
      return false;
    }
    const { seal: _seal, ...metadata } = envelope;
    const expected = Buffer.from(mac(request, metadata));
    const actual = Buffer.from(envelope.seal);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };

  return Object.freeze({
    seal,
    verify,
    isCurrent: async () => true,
    acquireLease: async () => ({
      isCurrent: async () => true,
      release: async () => undefined,
    }),
    publishJournalTip: async (tip: ProtectedJournalTip) => {
      await writeFile(tipPath, JSON.stringify(tip), { mode: 0o600 });
    },
    matchesJournalTip: async (tip: ProtectedJournalTip) => {
      const stored = await readFile(tipPath, "utf8")
        .then((text) => JSON.parse(text) as ProtectedJournalTip)
        .catch(() => undefined);
      return (
        stored?.operationId === tip.operationId &&
        stored.sequence === tip.sequence &&
        stored.seal === tip.seal
      );
    },
  });
}
