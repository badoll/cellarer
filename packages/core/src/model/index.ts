// 核心域模型类型(M0 定义,贯穿全程)。纯类型,无运行时逻辑。

import type { AppliedReceipt, Capability, Collection, Scope } from "../protocol/client-types.js";

export type {
  AppliedMethod,
  AppliedReceipt,
  Capability,
  Collection,
  DesiredPlacementMethod,
  DesiredTargetEvidence,
  DistributePlan,
  LinkMethod,
  PlanAction,
  Scope,
  SecretGuardFinding,
  SecretReferenceFinding,
  StoreInputEvidence,
  TargetAcknowledgement,
  TargetAcknowledgementKind,
  TargetClassification,
  TargetConflict,
  TargetConflictCode,
  TargetOwnershipEvidence,
  TargetReplacementApproval,
} from "../protocol/client-types.js";

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
  // Present only on a consumer projection of authoritative v3 deployment state.
  deploymentId?: string;
  deploymentRoot?: string;
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
  version: 2 | 3;
  owners: TargetOwner[];
}

export interface DeploymentConsumer {
  agent: string;
  scope: Scope;
  root: string;
  capability: Capability;
  kind: "ad-hoc" | "profile";
  profile?: SyncProfileTargetEvidence;
}

export interface Deployment {
  id: string;
  key: string;
  target: string;
  root: string;
  capability: Capability;
  receipt: AppliedReceipt;
  artifactIds: string[];
  secretRefs?: string[];
  itemAttribution: "unknown";
  consumers: DeploymentConsumer[];
}

export interface DeploymentState {
  version: 3;
  deployments: Deployment[];
}
