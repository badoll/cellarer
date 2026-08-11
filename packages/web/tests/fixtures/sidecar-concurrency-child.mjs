import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson, createRealEnv } from "../../../core/dist/index.js";
import { startServer } from "../../dist/server.js";

const [storeRoot, staticRoot, tipPath, collectionName] = process.argv.slice(2);
if (!storeRoot || !staticRoot || !tipPath || !collectionName) {
  throw new Error("missing sidecar concurrency fixture arguments");
}

const env = {
  ...createRealEnv(),
  mutationAuthority: crossProcessMutationAuthority(tipPath),
};
const token = `child-${process.pid}-token`;
const handle = await startServer({
  port: 0,
  auth: { mode: "bearer", token },
  staticRoot,
  env,
  storeRoot,
});
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

try {
  const plannedResponse = await fetch(`${handle.ready.baseUrl}/api/v1/collections/plan`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "create", collectionName, resourceIds: [] }),
  });
  const planned = await plannedResponse.json();
  if (!plannedResponse.ok) {
    protocolLine({ type: "plan-error", status: plannedResponse.status, body: planned });
    process.exitCode = 1;
  } else {
    protocolLine({ type: "ready", ready: handle.ready });
    await waitForGo();
    const appliedResponse = await fetch(`${handle.ready.baseUrl}/api/v1/mutations/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mutationPlan: planned.data.plan }),
    });
    protocolLine({
      type: "result",
      status: appliedResponse.status,
      body: await appliedResponse.json(),
    });
  }
} finally {
  await handle.close();
}

function protocolLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForGo() {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    if (chunk.includes("go")) return;
  }
  throw new Error("concurrency coordinator closed before go");
}

function crossProcessMutationAuthority(sharedTipPath) {
  const authorityId = "web-cross-process-test-authority";
  const authorityEpoch = 1;
  const key = "cellarer-web-cross-process-test-authority";
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
  return Object.freeze({
    seal,
    verify,
    isCurrent: async () => true,
    acquireLease: async () => ({
      isCurrent: async () => true,
      release: async () => undefined,
    }),
    publishJournalTip: async (tip) => {
      await writeFile(sharedTipPath, JSON.stringify(tip), { mode: 0o600 });
    },
    matchesJournalTip: async (tip) => {
      const stored = await readFile(sharedTipPath, "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined);
      return (
        stored?.operationId === tip.operationId &&
        stored.sequence === tip.sequence &&
        stored.seal === tip.seal
      );
    },
  });
}
