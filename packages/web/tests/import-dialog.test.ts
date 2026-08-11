import type { MutationPlan } from "@cellarer/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildImportApplyRequest,
  buildImportRequest,
  ImportDialog,
  importRequestKey,
  isImportProjectDirMissing,
} from "../client/import-dialog.js";

describe("ImportDialog", () => {
  it("requires a preview before applying an import", () => {
    const html = renderToStaticMarkup(
      createElement(ImportDialog, {
        open: true,
        kind: "rules",
        onClose: () => undefined,
        onImported: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="Import existing setup"');
    expect(html).toContain("Preview");
    expect(html).toContain("User-level");
    expect(html).toContain("Project-level");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Import<\/button>/);
  });

  it("guards project-level import until a project root is provided", () => {
    expect(isImportProjectDirMissing("project", " ")).toBe(true);
    expect(isImportProjectDirMissing("project", "/tmp/project")).toBe(false);
    expect(isImportProjectDirMissing("user", "")).toBe(false);
  });

  it("keys the apply request to the previewed import destination", () => {
    const previewed = buildImportRequest({
      agent: "codex",
      destination: "project",
      dir: "/workspace/app",
      capabilities: ["rules"],
    });
    const changed = buildImportRequest({
      agent: "codex",
      destination: "user",
      dir: "/workspace/app",
      capabilities: ["rules"],
    });

    expect(previewed).toEqual({
      agent: "codex",
      destination: "project",
      dir: "/workspace/app",
      capabilities: ["rules"],
    });
    expect(importRequestKey(previewed)).not.toBe(importRequestKey(changed));
  });

  it("submits the exact mutation plan returned by preview without rebuilding selection", () => {
    const mutationPlan = { schemaVersion: 1, planId: "plan-import" } as MutationPlan;

    expect(buildImportApplyRequest(mutationPlan)).toEqual({ mutationPlan });
    expect(buildImportApplyRequest(mutationPlan).mutationPlan).toBe(mutationPlan);
  });
});
