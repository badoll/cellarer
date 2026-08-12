import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/engine/apply.js";
import { verify } from "../src/engine/verification.js";
import type {
  FileTreeSnapshotNode,
  MutationAuthority,
  ResourceSourceTransport,
} from "../src/env.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { operationJournalPath } from "../src/protocol/journal.js";
import { createRealEnv } from "../src/real-env.js";
import { resourceCatalog } from "../src/resources/catalog.js";
import { createResourceRecord, resourceRevisionContentPath } from "../src/resources/model.js";
import {
  applyResourceUpdatePlan,
  checkResourceUpdate,
  discardResourceUpdateStage,
  planAvailableResourceUpdate,
  planResourceUpdate,
  stageResourceUpdate,
} from "../src/resources/update.js";
import { sha256 } from "../src/store/checksum.js";
import { initStore, skillProvenancePath, writeSkillProvenance } from "../src/store/store.js";
import { GIT_SOURCE, LOCAL_SNAPSHOT_SOURCE } from "./fixtures/resource-lifecycle.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

const NEXT_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const OLD_SKILL = `---\nname: example-skill\ndescription: old\n---\n\n# Old\n`;
const NEW_SKILL = `---\nname: example-skill\ndescription: new\n---\n\n# New\n`;
let cleanupCalls = 0;

describe("resource update check, private staging, and Store-only apply", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: sequenceIds() });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await installCurrentSkill(t, storeRoot, GIT_SOURCE);
    cleanupCalls = 0;
  });

  afterEach(() => t.cleanup());

  it("composes a built-in Git and URL source transport for explicit lifecycle commands", () => {
    expect(createRealEnv().resourceSourceTransport).toBeDefined();
  });

  it("executes built-in Git and URL transports through injected effects and pins immutable evidence", async () => {
    const gitEnv = createRealEnv({
      resourceSourceExec: async (command, args) => {
        expect(command).toBe("git");
        if (args[0] === "ls-remote") return `${NEXT_COMMIT}\trefs/heads/main\n`;
        if (args[0] === "-C" && args[2] === "checkout") {
          const checkout = args[1];
          if (!checkout) throw new Error("missing checkout");
          const root = join(checkout, "skills", "example-skill");
          await nodeFs.mkdir(root, { recursive: true });
          await nodeFs.writeFile(join(root, "SKILL.md"), NEW_SKILL);
        }
        if (args[0] === "-C" && args[2] === "rev-parse") return `${NEXT_COMMIT}\n`;
        return "";
      },
    });
    const gitTransport = gitEnv.resourceSourceTransport;
    if (!gitTransport) throw new Error("expected Git transport");
    const gitEvidence = await gitTransport.check(GIT_SOURCE);
    expect(gitEvidence).toMatchObject({ type: "git", commit: NEXT_COMMIT });
    const gitFetched = await gitTransport.fetch(gitEvidence);
    expect(gitFetched.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "SKILL.md", kind: "file" })]),
    );
    await gitFetched.cleanup?.();

    const movedGitEnv = createRealEnv({
      resourceSourceExec: async (_command, args) => {
        if (args[0] === "ls-remote") return `${NEXT_COMMIT}\trefs/heads/main\n`;
        if (args[0] === "-C" && args[2] === "rev-parse") {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
        }
        return "";
      },
    });
    const movedGitTransport = movedGitEnv.resourceSourceTransport;
    if (!movedGitTransport) throw new Error("expected moved-ref transport");
    await expect(
      movedGitTransport.fetch(await movedGitTransport.check(GIT_SOURCE)),
    ).rejects.toMatchObject({ code: "SOURCE_EVIDENCE_CHANGED" });

    const etag = '"candidate-v2"';
    let urlFetches = 0;
    const urlEnv = createRealEnv({
      resourceSourceFetch: async (_url, init) => {
        const headers = new Headers(init.headers);
        if (urlFetches === 0) {
          expect(headers.has("if-match")).toBe(false);
          expect(headers.has("if-unmodified-since")).toBe(false);
        } else {
          expect(headers.get("if-match")).toBe(etag);
        }
        urlFetches += 1;
        return new Response(urlFetches === 1 ? "# URL rule\n" : "# moved URL rule\n", {
          status: 200,
          headers: { etag, "content-type": "text/markdown" },
        });
      },
    });
    const urlTransport = urlEnv.resourceSourceTransport;
    if (!urlTransport) throw new Error("expected URL transport");
    const urlSource = {
      type: "url" as const,
      url: "https://example.test/rule.md",
      integrity: `sha256:${"0".repeat(64)}`,
      validators: { etag: '"candidate-v1"' },
    };
    const urlEvidence = await urlTransport.check(urlSource);
    expect(urlEvidence).toMatchObject({
      type: "url",
      validators: { etag },
      integrity: expect.stringMatching(/^sha256:/),
    });
    await expect(urlTransport.fetch(urlEvidence)).rejects.toMatchObject({
      code: "SOURCE_EVIDENCE_CHANGED",
    });
  });

  it("fails closed on URL redirects, declared oversize payloads, and archive traversal", async () => {
    const source = {
      type: "url" as const,
      url: "https://example.test/resource.tar",
      integrity: `sha256:${"0".repeat(64)}`,
    };
    const redirected = new Response("redirected", { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    const redirectTransport = createRealEnv({
      resourceSourceFetch: async () => redirected,
    }).resourceSourceTransport;
    if (!redirectTransport) throw new Error("expected redirect transport");
    await expect(redirectTransport.check(source)).rejects.toMatchObject({
      code: "SOURCE_URL_FAILED",
    });

    const oversizedTransport = createRealEnv({
      resourceSourceFetch: async () =>
        new Response("small", {
          status: 200,
          headers: { "content-length": String(224 * 1024 * 1024 + 1) },
        }),
    }).resourceSourceTransport;
    if (!oversizedTransport) throw new Error("expected oversize transport");
    await expect(oversizedTransport.check(source)).rejects.toMatchObject({
      code: "SOURCE_PAYLOAD_TOO_LARGE",
    });

    const traversalTransport = createRealEnv({
      resourceSourceFetch: async () => new Response(tarFile("../escape", "blocked")),
    }).resourceSourceTransport;
    if (!traversalTransport) throw new Error("expected archive transport");
    await expect(traversalTransport.check(source)).rejects.toMatchObject({
      code: "SOURCE_PAYLOAD_INVALID",
    });
  });

  it("aborts streamed URL reads at an injected download limit", async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(6).fill(pulls));
        if (pulls === 3) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = createRealEnv({
      resourceSourceFetch: async () => new Response(stream),
      resourceSourceLimits: { maxDownloadBytes: 8 },
    }).resourceSourceTransport;
    if (!transport) throw new Error("expected URL transport");

    await expect(
      transport.check({
        type: "url",
        url: "https://example.test/rule.md",
        integrity: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_PAYLOAD_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("bounds gzip output and every tar expansion dimension with small injected limits", async () => {
    const source = {
      type: "url" as const,
      url: "https://example.test/resource.tar.gz",
      integrity: `sha256:${"0".repeat(64)}`,
    };
    const compressed = createRealEnv({
      resourceSourceFetch: async () => new Response(gzipSync(tarFile("root/file", "ok"))),
      resourceSourceLimits: { maxExpandedBytes: 1_024 },
    }).resourceSourceTransport;
    if (!compressed) throw new Error("expected URL transport");
    await expect(compressed.check(source)).rejects.toMatchObject({
      code: "SOURCE_PAYLOAD_TOO_LARGE",
    });

    const cases = [
      {
        archive: tarFile("root/file", "blocked"),
        limits: { maxSingleFileBytes: 4 },
        code: "SOURCE_PAYLOAD_TOO_LARGE",
      },
      {
        archive: tarArchive([
          { path: "root/a", content: "a" },
          { path: "root/b", content: "b" },
        ]),
        limits: { maxArchiveNodes: 1 },
        code: "SOURCE_PAYLOAD_TOO_LARGE",
      },
      {
        archive: tarFile("root/too-long", "x"),
        limits: { maxPathBytes: 8 },
        code: "SOURCE_PAYLOAD_TOO_LARGE",
      },
      {
        archive: tarFile("root/a/b/c", "x"),
        limits: { maxPathDepth: 2 },
        code: "SOURCE_PAYLOAD_TOO_LARGE",
      },
      {
        archive: tarArchive([
          { path: "root/a", content: "12345" },
          { path: "root/b", content: "67890" },
        ]),
        limits: { maxTotalFileBytes: 8 },
        code: "SOURCE_PAYLOAD_TOO_LARGE",
      },
      {
        archive: tarArchive([{ path: "root/link", content: "target", type: "2" }]),
        limits: {},
        code: "SOURCE_PAYLOAD_INVALID",
      },
    ] as const;
    for (const testCase of cases) {
      const transport = createRealEnv({
        resourceSourceFetch: async () => new Response(testCase.archive),
        resourceSourceLimits: testCase.limits,
      }).resourceSourceTransport;
      if (!transport) throw new Error("expected URL transport");
      await expect(transport.check(source)).rejects.toMatchObject({ code: testCase.code });
    }
  });

  it("checks immutable Git evidence read-only and reports local snapshots as uncheckable", async () => {
    let writes = 0;
    const originalPublish = t.env.fs.publishFileAtomically;
    t.env.fs.publishFileAtomically = async (...args) => {
      writes += 1;
      return originalPublish(...args);
    };
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });

    const result = await checkResourceUpdate(t.env, {
      storeRoot,
      resourceId: "skills/example-skill",
    });

    expect(result).toMatchObject({
      status: "update-available",
      resourceId: "skills/example-skill",
      currentRevisionId: expect.stringMatching(/^sha256:/),
      evidence: {
        type: "git",
        repositoryUrl: GIT_SOURCE.repositoryUrl,
        ref: GIT_SOURCE.ref,
        commit: NEXT_COMMIT,
        subpath: GIT_SOURCE.subpath,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(writes).toBe(0);

    await installCurrentSkill(t, storeRoot, LOCAL_SNAPSHOT_SOURCE, "local-skill");
    const local = await checkResourceUpdate(t.env, {
      storeRoot,
      resourceId: "skills/local-skill",
    });
    expect(local).toMatchObject({
      status: "uncheckable",
      reason: "no-verifiable-remote-source",
    });
    expect(writes).toBe(0);
  });

  it("keeps staged bytes outside inventory and emits a digest-only typed redacted diff", async () => {
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const checked = await checkedUpdate(t, storeRoot);
    const staged = await stageResourceUpdate(t.env, { storeRoot, check: checked });

    expect(staged.validation.checks).toEqual([
      "content-fingerprint",
      "manifest",
      "adapter-compatibility",
      "secret-scan",
    ]);
    expect(staged.diff).toMatchObject({
      type: "resource-content",
      resourceId: "skills/example-skill",
      redacted: true,
      files: [
        {
          path: "SKILL.md",
          change: "modified",
          beforeFingerprint: expect.stringMatching(/^sha256:/),
          afterFingerprint: expect.stringMatching(/^sha256:/),
        },
      ],
    });
    expect(JSON.stringify(staged.diff)).not.toContain("# New");
    expect(await t.env.fs.readFile(staged.stagePath)).toContain(staged.stagedContentDigest);

    const inventory = await resourceCatalog(t.env, { storeRoot, includeDiscovered: false });
    expect(inventory.resources.map((resource) => resource.id)).toEqual(["skills/example-skill"]);
    expect(
      inventory.resources.some((resource) => JSON.stringify(resource).includes("staging")),
    ).toBe(false);
    expect(cleanupCalls).toBe(1);

    await discardResourceUpdateStage(t.env, { storeRoot, candidate: staged });
    await expect(t.env.fs.readFile(staged.stagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks project adapters against the ledger owner root after cwd changes", async () => {
    const repoA = t.path("repo-a");
    const repoB = t.path("repo-b");
    await t.env.fs.mkdir(repoA, { recursive: true });
    await t.env.fs.mkdir(repoB, { recursive: true });
    await t.env.fs.writeFile(
      join(storeRoot, "config.json"),
      JSON.stringify({
        version: 1,
        customAdapters: {
          "project-only": {
            displayName: "Project Only",
            skills: { project: join(repoA, ".project-agent", "skills") },
          },
        },
      }),
    );

    const deployed = await apply(t.env, {
      storeRoot,
      scope: "project",
      dir: repoA,
      agents: ["project-only"],
      capabilities: ["skills"],
      method: "copy",
    });
    expect(deployed.failures).toEqual([]);
    expect(deployed.entries).toEqual([
      expect.objectContaining({ scope: "project", projectRoot: repoA }),
    ]);

    t.env.cwd = () => repoB;
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const staged = await stageResourceUpdate(t.env, {
      storeRoot,
      check: await checkedUpdate(t, storeRoot),
    });
    const planned = await planResourceUpdate(t.env, { storeRoot, candidate: staged });
    const updated = await applyResourceUpdatePlan(t.env, planned.plan, { storeRoot });

    expect(updated.operation.ok).toBe(true);
  });

  it.each([
    ["repository URL", { repositoryUrl: "https://example.test/forged.git" }],
    ["Git ref", { ref: "refs/heads/forged" }],
    ["Git subpath", { subpath: "skills/forged" }],
  ] as const)("rejects a caller-supplied check with a forged %s before transport or catalog mutation", async (_label, forgedLocator) => {
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const checked = await checkedUpdate(t, storeRoot);
    const before = await resourceCatalog(t.env, { storeRoot, includeDiscovered: false });
    let fetchCalls = 0;
    t.env.resourceSourceTransport = {
      check: async () => {
        throw new Error("unexpected transport check");
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("unexpected transport fetch");
      },
    };

    await expect(
      stageResourceUpdate(t.env, {
        storeRoot,
        check: {
          ...checked,
          evidence: { ...checked.evidence, ...forgedLocator },
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_LOCATOR_CHANGED" });

    expect(fetchCalls).toBe(0);
    await expect(resourceCatalog(t.env, { storeRoot, includeDiscovered: false })).resolves.toEqual(
      before,
    );
  });

  it("rejects a caller-supplied URL check for another locator before transport or catalog mutation", async () => {
    const source = {
      type: "url" as const,
      url: "https://example.test/example-skill.tar.gz",
      integrity: `sha256:${"a".repeat(64)}`,
    };
    await installCurrentSkill(t, storeRoot, source, "url-skill");
    t.env.resourceSourceTransport = urlTransport({
      integrity: `sha256:${"b".repeat(64)}`,
      content: NEW_SKILL.replaceAll("example-skill", "url-skill"),
    });
    const checked = await checkResourceUpdate(t.env, {
      storeRoot,
      resourceId: "skills/url-skill",
    });
    if (checked.status !== "update-available") throw new Error("expected URL update");
    const before = await resourceCatalog(t.env, { storeRoot, includeDiscovered: false });
    let fetchCalls = 0;
    t.env.resourceSourceTransport = {
      check: async () => {
        throw new Error("unexpected transport check");
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("unexpected transport fetch");
      },
    };

    await expect(
      stageResourceUpdate(t.env, {
        storeRoot,
        check: {
          ...checked,
          evidence: { ...checked.evidence, url: "https://example.test/forged.tar.gz" },
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_LOCATOR_CHANGED" });

    expect(fetchCalls).toBe(0);
    await expect(resourceCatalog(t.env, { storeRoot, includeDiscovered: false })).resolves.toEqual(
      before,
    );
  });

  it("rejects a remote check forged for a local snapshot before transport or catalog mutation", async () => {
    await installCurrentSkill(t, storeRoot, LOCAL_SNAPSHOT_SOURCE, "local-skill");
    const record = JSON.parse(
      await t.env.fs.readFile(skillProvenancePath(storeRoot, "local-skill")),
    ) as ReturnType<typeof createResourceRecord>;
    const before = await resourceCatalog(t.env, { storeRoot, includeDiscovered: false });
    let fetchCalls = 0;
    t.env.resourceSourceTransport = {
      check: async () => {
        throw new Error("unexpected transport check");
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("unexpected transport fetch");
      },
    };

    await expect(
      stageResourceUpdate(t.env, {
        storeRoot,
        check: {
          status: "update-available",
          resourceId: record.resourceId,
          currentRevisionId: record.currentRevision.id,
          currentContentFingerprint: record.currentRevision.contentFingerprint,
          checkedAt: "2026-08-06T00:00:00.000Z",
          evidence: { ...GIT_SOURCE, commit: NEXT_COMMIT },
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_LOCATOR_CHANGED" });

    expect(fetchCalls).toBe(0);
    await expect(resourceCatalog(t.env, { storeRoot, includeDiscovered: false })).resolves.toEqual(
      before,
    );
  });

  it.each([
    ["missing", undefined],
    ["stale", deterministicMutationAuthority({ isCurrent: async () => false })],
  ] as const)("gates resource update stage and plan before %s authority can observe product state", async (_label, mutationAuthority) => {
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const checked = await checkedUpdate(t, storeRoot);
    const staged = await stageResourceUpdate(t.env, { storeRoot, check: checked });
    const productEffects: string[] = [];
    let transportCalls = 0;
    let clockReads = 0;
    const originalFs = t.env.fs;
    t.env.fs = new Proxy(originalFs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (..._args: unknown[]) => {
          productEffects.push(String(property));
          throw new Error(`unexpected product effect: ${String(property)}`);
        };
      },
    });
    t.env.resourceSourceTransport = {
      check: async () => {
        transportCalls += 1;
        throw new Error("unexpected transport check");
      },
      fetch: async () => {
        transportCalls += 1;
        throw new Error("unexpected transport fetch");
      },
    };
    t.env.now = () => {
      clockReads += 1;
      throw new Error("unexpected clock read");
    };
    t.env.mutationAuthority = mutationAuthority;

    await expect(stageResourceUpdate(t.env, { storeRoot, check: checked })).rejects.toThrow(
      /mutation authority/i,
    );
    await expect(planResourceUpdate(t.env, { storeRoot, candidate: staged })).rejects.toThrow(
      /mutation authority/i,
    );
    expect(productEffects).toEqual([]);
    expect(transportCalls).toBe(0);
    expect(clockReads).toBe(0);
  });

  it("holds one non-reentrant authority lease across standalone resource update planning", async () => {
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const staged = await stageResourceUpdate(t.env, {
      storeRoot,
      check: await checkedUpdate(t, storeRoot),
    });
    const authority = installNonReentrantAuthority(t);

    await expect(
      planResourceUpdate(t.env, { storeRoot, candidate: staged }),
    ).resolves.toBeDefined();

    expect(authority.acquisitions).toBe(1);
    expect(authority.releases).toBe(1);
    expect(authority.leaseHeld).toBe(false);
    authority.restoreFs();

    const failed = installNonReentrantAuthority(t);
    await expect(
      planResourceUpdate(t.env, {
        storeRoot,
        candidate: { ...staged, stageFileDigest: `sha256:${"0".repeat(64)}` },
      }),
    ).rejects.toBeDefined();
    expect(failed.acquisitions).toBe(1);
    expect(failed.releases).toBe(1);
    expect(failed.leaseHeld).toBe(false);
  });

  it("holds one non-reentrant authority lease across available resource update planning", async () => {
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const authority = installNonReentrantAuthority(t);

    await expect(
      planAvailableResourceUpdate(t.env, { storeRoot, resourceId: "skills/example-skill" }),
    ).resolves.toBeDefined();

    expect(authority.acquisitions).toBe(1);
    expect(authority.releases).toBe(1);
    expect(authority.leaseHeld).toBe(false);
    authority.restoreFs();

    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const failed = installNonReentrantAuthority(t);
    t.env.resourceSourceTransport.fetch = async () => {
      throw new Error("simulated fetch failure");
    };
    await expect(
      planAvailableResourceUpdate(t.env, { storeRoot, resourceId: "skills/example-skill" }),
    ).rejects.toThrow("simulated fetch failure");
    expect(failed.acquisitions).toBe(1);
    expect(failed.releases).toBe(1);
    expect(failed.leaseHeld).toBe(false);
  });

  it("fails closed on moved refs, URL integrity failure, and recursive plaintext secrets", async () => {
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const checked = await checkedUpdate(t, storeRoot);
    t.env.resourceSourceTransport = transport({
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      content: NEW_SKILL,
    });
    await expect(stageResourceUpdate(t.env, { storeRoot, check: checked })).rejects.toMatchObject({
      code: "SOURCE_EVIDENCE_CHANGED",
    });
    expect(cleanupCalls).toBe(1);

    t.env.resourceSourceTransport = transport({
      commit: NEXT_COMMIT,
      content: NEW_SKILL,
      extraNodes: [file("nested/config.json", '{"token":"ghp_abcdefghijklmnopqrstuvwxyz123456"}')],
    });
    await expect(stageResourceUpdate(t.env, { storeRoot, check: checked })).rejects.toMatchObject({
      code: "CANDIDATE_SECRET_BLOCKED",
      findings: expect.arrayContaining([{ path: "nested/config.json", rule: expect.any(String) }]),
    });
    expect(cleanupCalls).toBe(2);

    const urlSource = {
      type: "url" as const,
      url: "https://example.test/example-skill.tar.gz",
      integrity: `sha256:${"a".repeat(64)}`,
    };
    await installCurrentSkill(t, storeRoot, urlSource, "url-skill");
    t.env.resourceSourceTransport = urlTransport({
      integrity: `sha256:${"b".repeat(64)}`,
      content: NEW_SKILL.replaceAll("example-skill", "url-skill"),
    });
    const urlCheck = await checkResourceUpdate(t.env, {
      storeRoot,
      resourceId: "skills/url-skill",
    });
    await expect(stageResourceUpdate(t.env, { storeRoot, check: urlCheck })).rejects.toMatchObject({
      code: "CANDIDATE_INTEGRITY_FAILED",
    });
  });

  it("rejects current-revision TOCTOU and a re-sealed plan that substitutes another candidate", async () => {
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const checked = await checkedUpdate(t, storeRoot);
    await installCurrentSkill(
      t,
      storeRoot,
      { ...GIT_SOURCE, commit: NEXT_COMMIT },
      "example-skill",
      NEW_SKILL,
    );
    await expect(stageResourceUpdate(t.env, { storeRoot, check: checked })).rejects.toMatchObject({
      code: "CURRENT_REVISION_CHANGED",
    });

    await installCurrentSkill(t, storeRoot, GIT_SOURCE);
    const first = await stageResourceUpdate(t.env, {
      storeRoot,
      check: await checkedUpdate(t, storeRoot),
    });
    const firstPlan = await planResourceUpdate(t.env, { storeRoot, candidate: first });
    const alternateContent = NEW_SKILL.replace("# New", "# Alternate candidate");
    t.env.resourceSourceTransport = transport({
      commit: NEXT_COMMIT,
      content: alternateContent,
    });
    const alternate = await stageResourceUpdate(t.env, {
      storeRoot,
      check: await checkedUpdate(t, storeRoot),
    });
    const alternatePlan = await planResourceUpdate(t.env, { storeRoot, candidate: alternate });
    const forged = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: alternatePlan.plan.schemaVersion,
      planId: "plan-resealed-candidate-substitution",
      operation: alternatePlan.plan.operation,
      baseRevision: alternatePlan.plan.baseRevision,
      normalizedInputs: {
        ...alternatePlan.plan.normalizedInputs,
        stagePath: first.stagePath,
        stageFileDigest: first.stageFileDigest,
        storeProvenance: firstPlan.plan.normalizedInputs.storeProvenance,
      },
      targetPreconditions: alternatePlan.plan.targetPreconditions,
      actions: alternatePlan.plan.actions,
      expires: alternatePlan.plan.expires,
    });

    const rejected = await applyResourceUpdatePlan(t.env, forged, { storeRoot });
    expect(rejected.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    expect(await t.env.fs.readFile(first.stagePath)).toContain(first.stagedContentDigest);
    await discardResourceUpdateStage(t.env, { storeRoot, candidate: first });
    await discardResourceUpdateStage(t.env, { storeRoot, candidate: alternate });
  });

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("pins candidate bytes and revision evidence, applies only Store state, and reports desired divergence", async () => {
    const deployed = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      capabilities: ["skills"],
      method: "symlink",
    });
    expect(deployed.failures).toEqual([]);
    const target = t.path("home", ".codex", "skills", "example-skill", "SKILL.md");
    expect(await t.env.fs.readFile(target)).toBe(OLD_SKILL);

    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const staged = await stageResourceUpdate(t.env, {
      storeRoot,
      check: await checkedUpdate(t, storeRoot),
    });
    const planned = await planResourceUpdate(t.env, { storeRoot, candidate: staged });

    expect(planned.plan.normalizedInputs).toMatchObject({
      mutationKind: "resource-update",
      resourceId: "skills/example-skill",
      currentRevisionId: staged.currentRevisionId,
      sourceEvidence: staged.sourceEvidence,
      stagedContentDigest: staged.stagedContentDigest,
      stagedBytes: staged.stagedBytes,
      desiredStateEffect: "diverged-until-distributed",
    });
    expect(planned.plan.actions.map((action) => action.kind)).toEqual([
      "install-resource-revision",
      "publish-resource-metadata",
    ]);
    expect(planned.plan.actions.every((action) => action.target.startsWith(storeRoot))).toBe(true);
    expect(planned.plan.actions.some((action) => action.target.includes(".codex"))).toBe(false);

    const applied = await applyResourceUpdatePlan(t.env, planned.plan, { storeRoot });
    expect(applied.operation.ok).toBe(true);
    if (!applied.resource) throw new Error("expected applied resource evidence");
    expect(applied.resource.resourceId).toBe("skills/example-skill");
    expect(applied.resource.currentRevision.source).toMatchObject({ commit: NEXT_COMMIT });
    expect(await t.env.fs.readFile(target)).toBe(OLD_SKILL);
    expect(
      await t.env.fs.readFile(
        join(
          resourceRevisionContentPath(
            storeRoot,
            "skills/example-skill",
            applied.resource.currentRevision.contentFingerprint,
          ),
          "SKILL.md",
        ),
      ),
    ).toBe(NEW_SKILL);

    const report = await verify(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      capabilities: ["skills"],
    });
    expect(report.desiredVsApplied.status).toBe("diverged");
    expect(report.desiredVsApplied.items).toContainEqual(
      expect.objectContaining({ status: "content-mismatch" }),
    );
    expect(report.appliedVsDisk.status).toBe("converged");
  }, 30_000);

  it("retains a private stage and recoverable journal when metadata publication is interrupted", async () => {
    t.env.resourceSourceTransport = transport({ commit: NEXT_COMMIT, content: NEW_SKILL });
    const staged = await stageResourceUpdate(t.env, {
      storeRoot,
      check: await checkedUpdate(t, storeRoot),
    });
    const planned = await planResourceUpdate(t.env, { storeRoot, candidate: staged });
    const originalPublish = t.env.fs.publishFileAtomically;
    t.env.fs.publishFileAtomically = async (path, data, opts) => {
      if (path === skillProvenancePath(storeRoot, "example-skill")) {
        throw Object.assign(new Error("simulated interruption"), { code: "EIO" });
      }
      return originalPublish(path, data, opts);
    };

    const applied = await applyResourceUpdatePlan(t.env, planned.plan, { storeRoot });
    expect(applied.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: { status: "recovery-required" },
    });
    expect(await t.env.fs.readFile(staged.stagePath)).toContain(staged.stagedContentDigest);
    expect(await t.env.fs.readFile(operationJournalPath(storeRoot))).toContain("recovery-required");
    expect((await currentRecord(t, storeRoot)).currentRevision.source).toEqual(GIT_SOURCE);
  });
});

async function checkedUpdate(t: TmpEnv, storeRoot: string) {
  const result = await checkResourceUpdate(t.env, {
    storeRoot,
    resourceId: "skills/example-skill",
  });
  if (result.status !== "update-available") throw new Error("expected update");
  return result;
}

async function installCurrentSkill(
  t: TmpEnv,
  storeRoot: string,
  source: Parameters<typeof createResourceRecord>[0]["source"],
  name = "example-skill",
  contentOverride?: string,
): Promise<void> {
  const path = join(storeRoot, "store", "skills", name);
  const content = (contentOverride ?? OLD_SKILL).replaceAll("example-skill", name);
  await t.env.fs.mkdir(path, { recursive: true });
  await t.env.fs.writeFile(join(path, "SKILL.md"), content);
  const snapshot = await t.env.fs.snapshotTreeNoFollow(path);
  const fingerprint = treeFingerprint(snapshot.nodes);
  await writeSkillProvenance(
    t.env,
    storeRoot,
    name,
    createResourceRecord({
      resourceId: `skills/${name}`,
      kind: "skills",
      name,
      contentFingerprint: fingerprint,
      validation: {
        status: "validated",
        checkedAt: t.env.now().toISOString(),
        checks: ["content-fingerprint", "manifest", "secret-scan"],
      },
      source,
    }),
  );
}

async function currentRecord(t: TmpEnv, storeRoot: string) {
  const raw = await t.env.fs.readFile(skillProvenancePath(storeRoot, "example-skill"));
  return JSON.parse(raw) as ReturnType<typeof createResourceRecord>;
}

function transport(options: {
  commit: string;
  content: string;
  extraNodes?: FileTreeSnapshotNode[];
}): ResourceSourceTransport {
  return {
    async check(source) {
      if (source.type !== "git") throw new Error("expected git source");
      return { ...source, commit: options.commit };
    },
    async fetch(source) {
      if (source.type !== "git") throw new Error("expected git source");
      return {
        evidence: { ...source, commit: options.commit },
        nodes: directoryNodes(options.content, options.extraNodes),
        cleanup: async () => {
          cleanupCalls += 1;
        },
      };
    },
  };
}

function urlTransport(options: { integrity: string; content: string }): ResourceSourceTransport {
  return {
    async check(source) {
      if (source.type !== "url") throw new Error("expected URL source");
      return { ...source, integrity: options.integrity };
    },
    async fetch(source) {
      if (source.type !== "url") throw new Error("expected URL source");
      return {
        evidence: { ...source, integrity: options.integrity },
        nodes: directoryNodes(options.content),
        cleanup: async () => {
          cleanupCalls += 1;
        },
      };
    },
  };
}

function installNonReentrantAuthority(t: TmpEnv): {
  readonly acquisitions: number;
  readonly releases: number;
  readonly leaseHeld: boolean;
  readonly restoreFs: () => void;
} {
  const base = deterministicMutationAuthority();
  let acquisitions = 0;
  let releases = 0;
  let leaseHeld = false;
  const authority: MutationAuthority = {
    seal: base.seal,
    verify: base.verify,
    isCurrent: base.isCurrent,
    publishJournalTip: base.publishJournalTip,
    matchesJournalTip: base.matchesJournalTip,
    acquireLease: async () => {
      if (leaseHeld) {
        throw Object.assign(new Error("non-reentrant authority lock conflict"), {
          code: "LOCK_CONFLICT",
        });
      }
      acquisitions += 1;
      leaseHeld = true;
      const lease = await base.acquireLease();
      return {
        isCurrent: () => lease.isCurrent(),
        release: async () => {
          releases += 1;
          leaseHeld = false;
          await lease.release();
        },
      };
    },
  };
  t.env.mutationAuthority = authority;
  const originalFs = t.env.fs;
  t.env.fs = new Proxy(originalFs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (!leaseHeld)
          throw new Error(`product access outside authority lease: ${String(property)}`);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return {
    get acquisitions() {
      return acquisitions;
    },
    get releases() {
      return releases;
    },
    get leaseHeld() {
      return leaseHeld;
    },
    restoreFs() {
      t.env.fs = originalFs;
    },
  };
}

function directoryNodes(
  content: string,
  extraNodes: FileTreeSnapshotNode[] = [],
): FileTreeSnapshotNode[] {
  const directories = new Set<string>([""]);
  for (const node of extraNodes) {
    const segments = node.relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return [
    ...[...directories].sort().map((relativePath) => directory(relativePath)),
    file("SKILL.md", content),
    ...extraNodes,
  ];
}

function directory(relativePath: string): FileTreeSnapshotNode {
  return {
    relativePath,
    kind: "directory",
    mode: 0o755,
    identity: `dir:${relativePath}`,
  };
}

function file(relativePath: string, content: string): FileTreeSnapshotNode {
  return {
    relativePath,
    kind: "file",
    mode: 0o644,
    identity: `file:${relativePath}`,
    data: new TextEncoder().encode(content),
  };
}

function treeFingerprint(nodes: readonly FileTreeSnapshotNode[]): string {
  const manifest = [...nodes]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((node) =>
      node.kind === "directory"
        ? { path: node.relativePath, kind: "directory" as const, mode: node.mode }
        : {
            path: node.relativePath,
            kind: "file" as const,
            mode: node.mode,
            digest: sha256Bytes(node.data ?? new Uint8Array()),
          },
    );
  return sha256(JSON.stringify(manifest));
}

function sha256Bytes(bytes: Uint8Array): string {
  return sha256(bytes);
}

function tarFile(path: string, content: string): Uint8Array {
  return tarArchive([{ path, content }]);
}

function tarArchive(
  entries: readonly { path: string; content: string; type?: string }[],
): Uint8Array {
  const encoded = entries.map((entry) => ({
    ...entry,
    body: new TextEncoder().encode(entry.content),
  }));
  const archive = new Uint8Array(
    encoded.reduce((total, entry) => total + 512 + Math.ceil(entry.body.length / 512) * 512, 0) +
      1024,
  );
  const write = (offset: number, length: number, value: string) => {
    archive.set(new TextEncoder().encode(value).slice(0, length), offset);
  };
  let offset = 0;
  for (const entry of encoded) {
    write(offset, 100, entry.path);
    write(offset + 100, 8, "0000644\0");
    write(offset + 124, 12, `${entry.body.length.toString(8).padStart(11, "0")}\0`);
    archive[offset + 156] = (entry.type ?? "0").charCodeAt(0);
    archive.set(entry.body, offset + 512);
    offset += 512 + Math.ceil(entry.body.length / 512) * 512;
  }
  return archive;
}

function sequenceIds(): () => string {
  let next = 0;
  return () => `resource-update-${++next}`;
}
