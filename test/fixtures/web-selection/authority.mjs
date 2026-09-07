// Test-only in-memory authority; never loads user credentials.
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../../../packages/core/dist/index.js";
export function deterministicMutationAuthority(options = {}) {
  const authorityId = "web-test-authority";
  const authorityEpoch = 1;
  const key = "cellarer-web-test-authority";
  const mac = (request, envelope) =>
    `hmac-sha256:${createHmac("sha256", key)
      .update(
        `cellarer-mutation-authority\0${request.domain}\0${canonicalJson({ request, envelope })}`,
      )
      .digest("hex")}`;
  const seal = (request) => {
    const envelope = {
      schemaVersion: 1,
      domain: request.domain,
      algorithm: "HMAC-SHA-256",
      authorityId,
      authorityEpoch,
    };
    return { ...envelope, seal: mac(request, envelope) };
  };
  const verify = (request, envelope) => {
    if (
      envelope.schemaVersion !== 1 ||
      envelope.domain !== request.domain ||
      envelope.algorithm !== "HMAC-SHA-256" ||
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
  let journalTip;
  const publishJournalTip = async (tip) => {
    journalTip = { ...tip };
  };
  const matchesJournalTip = async (tip) =>
    journalTip?.operationId === tip.operationId &&
    journalTip.sequence === tip.sequence &&
    journalTip.seal === tip.seal;
  const acquireLease = async () => {
    let released = false;
    return Object.freeze({
      isCurrent: async () => !released && (await isCurrent()),
      release: async () => {
        released = true;
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
  );
}
