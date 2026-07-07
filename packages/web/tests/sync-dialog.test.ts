import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildSyncRequest,
  isProjectDirMissing,
  SyncDialog,
  syncRequestKey,
} from "../client/sync-dialog.js";

describe("SyncDialog", () => {
  it("requires a preview before applying a sync", () => {
    const html = renderToStaticMarkup(
      createElement(SyncDialog, {
        open: true,
        kinds: ["rules"],
        onClose: () => undefined,
        onApplied: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="Sync to Agents"');
    expect(html).toContain("Preview");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply<\/button>/);
  });

  it("guards project-level sync until a project root is provided", () => {
    expect(isProjectDirMissing("project", " ")).toBe(true);
    expect(isProjectDirMissing("project", "/tmp/project")).toBe(false);
    expect(isProjectDirMissing("user", "")).toBe(false);
  });

  it("keys the apply request to the previewed selection", () => {
    const previewed = buildSyncRequest({
      agents: "codex, claude-code",
      destination: "project",
      dir: "/workspace/app",
      kinds: ["rules"],
      collections: ["default"],
    });
    const changed = buildSyncRequest({
      agents: "codex, claude-code",
      destination: "project",
      dir: "/workspace/app",
      kinds: ["mcp"],
      collections: ["default"],
    });

    expect(previewed).toEqual({
      agents: ["codex", "claude-code"],
      destination: "project",
      dir: "/workspace/app",
      resources: { kinds: ["rules"], collections: ["default"] },
    });
    expect(syncRequestKey(previewed)).not.toBe(syncRequestKey(changed));
  });
});
