// 核心域模型类型(M0 定义,贯穿全程)。纯类型,无运行时逻辑。

export type Scope = "global" | "project";
export type LinkMethod = "symlink" | "copy";
export type Capability = "rules" | "mcp" | "skills";

export type TargetClassification =
  | "absent"
  | "owned-current"
  | "owned-drifted"
  | "unowned-existing"
  | "invalid-owner";

// 实际落地方式:计划用 LinkMethod;落地可能因 Windows 回退为 junction/copy,记台账。
export type AppliedMethod = "write" | "symlink" | "junction" | "copy";
export type DesiredPlacementMethod = "write" | "symlink" | "copy";

export interface DesiredTargetEvidence {
  method: DesiredPlacementMethod;
  // Exact target fingerprint for rendered file outputs. The rendered content itself is never
  // published as verification evidence.
  contentFingerprint?: string;
  // Skills compare source state independently from the placement node fingerprint.
  sourceFingerprint?: string;
  // Opaque no-follow node identity captured with the source fingerprint. Replacing a path with
  // byte-identical content still invalidates an already prepared apply plan.
  sourceIdentity?: string;
}

export interface StoreInputEvidence {
  artifactId: string;
  path: string;
  fingerprint: string;
}

// Collection:制品的场景标签(default / internal / 自定义)。
export type Collection = string;

// 制品类型(v1:rule 片段;M2 起扩展 mcp / skill)。
export type ArtifactKind = "rules" | "mcp" | "skills";

// 库房中的一个可分发单元。
export interface Artifact {
  // 形如 "rules/coding-style":kind/name。
  id: string;
  kind: ArtifactKind;
  name: string;
  // 库房内绝对路径(rule = .md 文件;skill = 目录)。
  sourcePath: string;
  collections: Collection[];
}

// 下发计划中的单个动作(纯描述,plan 阶段产出,不含真值密钥)。
export interface PlanAction {
  artifact: string; // "rules/coding-style"
  artifactIds?: string[]; // 实际参与该物理 target 的 concrete artifacts（owner provenance）
  agent: string;
  scope: Scope;
  capability: Capability;
  target: string; // 绝对路径
  source?: string; // 库房真源绝对路径(skills 软链/拷贝用;rules/mcp 为渲染写入无 source)
  method: LinkMethod; // 计划方式(实际落地见台账)
  op: "write" | "symlink" | "copy" | "merge" | "overwrite" | "skip";
  reason?: string; // skip / 告警原因
  preview?: { before?: string; after?: string }; // dry-run diff
  secretRefs?: string[]; // 涉及的密钥引用名(不含真值)
  // 结构化字段探测出「意外明文」(库房脏数据:非占位符却命中高置信密钥规则,如按字段名 API_KEY 判定)。
  // 通用文本扫描只认厂商格式,看不到字段名,故由 planner 标记;护栏对其无条件拦截、无逃生通道。
  accidentalPlaintext?: boolean;
  desiredEvidence?: DesiredTargetEvidence;
  // Signed source preconditions let exact sealed-plan apply validate Store inputs without
  // replanning. Skills use their stronger no-follow recursive source evidence instead.
  storeInputs?: StoreInputEvidence[];
  ownership?: TargetOwnershipEvidence;
  replacement?: TargetReplacementApproval;
}

export interface DistributePlan {
  actions: PlanAction[];
  warnings: string[];
  conflicts: TargetConflict[];
  // Non-disclosing evidence from the final staged-tree secret guard.
  secretFindings?: SecretGuardFinding[];
  // Presence-only evidence for required references. It contains provider/name status, never value.
  secretReferenceFindings?: SecretReferenceFinding[];
  // Duplicate canonical owner keys invalidate the mutation ledger even when no selected action
  // happens to target that key. Apply uses this flag rather than broad action-level conflicts.
  invalidLedger?: true;
}

export interface SecretReferenceFinding {
  reference: string;
  provider: "environment" | "vault" | "keychain";
  status: "missing" | "unavailable";
}

export interface SecretGuardFinding {
  artifact: string;
  // Store-relative source path when attributable, otherwise the staged target path.
  source: string;
  line: number;
  rule: string;
  patternVersion?: number;
}

export interface TargetOwnershipEvidence {
  key: string;
  classification: TargetClassification;
  target: string;
  currentFingerprint: string | null;
  expectedReceipt: AppliedReceipt | null;
}

export type TargetAcknowledgementKind =
  | "replace-unowned"
  | "override-drift"
  | "revert-drift"
  | "uninstall-drift";

export interface TargetAcknowledgement {
  kind: TargetAcknowledgementKind;
  token: string;
}

export type TargetConflictCode =
  | "UNOWNED_TARGET"
  | "OWNED_TARGET_DRIFTED"
  | "INVALID_TARGET_OWNER"
  | "SNAPSHOT_ENCRYPTION_REQUIRED"
  | "REVERT_TARGET_DRIFTED"
  | "REVERT_SNAPSHOT_UNAVAILABLE";

export interface TargetConflict {
  code: TargetConflictCode;
  target: string;
  message: string;
  ownership: TargetOwnershipEvidence;
  acknowledgement?: TargetAcknowledgement;
}

export interface TargetReplacementApproval {
  acknowledgement: TargetAcknowledgement;
  snapshotRequired: true;
}

// 物理目标的最近一次成功落地凭据。fingerprint 同时覆盖文件 checksum 与目录 fingerprint。
export interface AppliedReceipt {
  method: AppliedMethod;
  fingerprint: string;
  // Semantic rendered-input evidence for generated file content. This is intentionally separate
  // from fingerprint, which proves the complete target bytes for applied-versus-disk checks.
  contentFingerprint?: string;
  sourceFingerprint?: string;
  backup: string | null;
  generated: boolean;
  appliedAt: string;
}

export interface SyncProfileTargetEvidence {
  profileId: string;
  profileRevision: string;
  resolvedResources: Array<{
    resourceId: string;
    revision: string;
    capability: Capability;
  }>;
}

// state.json v2 以物理目标而非输入制品为 owner 身份。artifactIds 只记录该目标的来源集合。
export interface TargetOwner {
  agent: string;
  scope: Scope;
  capability: Capability;
  target: string;
  // Project owners retain their canonical project root separately from physical target identity.
  // It is required for project scope and absent for global scope.
  projectRoot?: string;
  artifactIds: string[];
  syncProfile?: SyncProfileTargetEvidence;
  receipt: AppliedReceipt;
  secretRefs?: string[];
}

// Apply/Revert 结果仍沿用 LedgerEntry 这个公共类型名，但内容已经是 target owner。
export type LedgerEntry = TargetOwner;

export interface Ledger {
  version: 2;
  owners: TargetOwner[];
}
