import type { ResourceSourceDescriptor } from "../../src/resources/model.js";

export const LOCAL_SNAPSHOT_SOURCE = {
  type: "local-snapshot",
  capturedFrom: "/tmp/source/example-skill",
} as const satisfies ResourceSourceDescriptor;

export const GIT_SOURCE = {
  type: "git",
  repositoryUrl: "https://github.com/example/skills.git",
  ref: "main",
  commit: "0123456789abcdef0123456789abcdef01234567",
  subpath: "skills/example-skill",
} as const satisfies ResourceSourceDescriptor;

export const URL_SOURCE = {
  type: "url",
  url: "https://example.test/example-skill.tar.gz",
  integrity: `sha256:${"a".repeat(64)}`,
} as const satisfies ResourceSourceDescriptor;

export const UNPROVABLE_LEGACY_PROVENANCE = {
  kind: "skills",
  name: "legacy-skill",
  source: "example/skills",
  resolvedUrl: "https://github.com/example/skills.git",
  vcs: "git",
  ref: "main",
  commit: null,
  subpath: "skills/legacy-skill",
  collection: null,
  importedAt: "2026-06-30T08:00:00.000Z",
  frontmatter: null,
  internal: false,
  warnings: [],
} as const;

export const FIRST_CONTENT_FINGERPRINT = `sha256:${"1".repeat(64)}`;
export const SECOND_CONTENT_FINGERPRINT = `sha256:${"2".repeat(64)}`;
