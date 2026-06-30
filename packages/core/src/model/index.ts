// 核心域模型类型(M0 定义,贯穿全程)。纯类型,无运行时逻辑。

export type Scope = "global" | "project";
export type LinkMethod = "symlink" | "copy";
export type Capability = "rules" | "mcp" | "skills";

// 实际落地方式:计划用 LinkMethod;落地可能因 Windows 回退为 junction/copy,记台账。
export type AppliedMethod = "write" | "symlink" | "junction" | "copy";

// 通道:制品的场景标签(common / internal / 自定义)。
export type Channel = string;

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
  channels: Channel[];
}

// 下发计划中的单个动作(纯描述,plan 阶段产出,不含真值密钥)。
export interface PlanAction {
  artifact: string; // "rules/coding-style"
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
  // 该动作的明文是「故意解析注入」(vault/keychain 模式,§10.2 必须明文的 agent),
  // 故 global scope 下通用 secret-scan 护栏放行;project(git 跟踪)仍拦。缺省视为不允许明文。
  allowResolvedPlaintext?: boolean;
  // 结构化字段探测出「意外明文」(库房脏数据:非占位符却命中高置信密钥规则,如按字段名 API_KEY 判定)。
  // 通用文本扫描只认厂商格式,看不到字段名,故由 planner 标记;护栏对其无条件拦截、无逃生通道。
  accidentalPlaintext?: boolean;
}

export interface DistributePlan {
  actions: PlanAction[];
  warnings: string[];
}

// 台账条目(state.json):记录实际落地,支撑 revert 与漂移检测。
export interface LedgerEntry {
  artifact: string;
  agent: string;
  scope: Scope;
  capability: Capability;
  target: string;
  method: AppliedMethod; // 实际落地方式
  checksum: string; // sha256:… 写入内容指纹(软链则为指向目标的指纹)
  backup: string | null; // .bak 路径(无则 null)
  // 该 target 是否由 cellarer 整体生成(可整体删除);false 表示 merge 进既有文件。
  generated: boolean;
  appliedAt: string; // ISO 时间戳
  secretRefs?: string[];
}

export interface Ledger {
  version: 1;
  entries: LedgerEntry[];
}
