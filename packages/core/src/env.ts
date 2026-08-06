// Env:副作用注入边界(架构不变量 2)。
// core 内一切 fs / home / cwd / platform / now / 环境变量 / keychain 都从这里取,
// 严禁在 core 直接 import "node:fs" 或读 process/os —— 这是可测性与跨平台的支点。

import type {
  MutationAuthorizationDomain,
  MutationAuthorizationEnvelope,
  MutationOperation,
} from "./protocol/models.js";

export type Platform = "darwin" | "linux" | "win32" | (string & {});

export type ProcessLiveness = "alive" | "dead" | "unknown";

// 软链类型:POSIX 不区分;Windows 目录用 junction。
export type SymlinkType = "file" | "dir" | "junction";

export interface FileStat {
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileTreeSnapshotNode {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly identity: string;
  readonly data?: Uint8Array;
}

export interface FileTreeSnapshot {
  readonly rootPath: string;
  readonly nodes: readonly FileTreeSnapshotNode[];
}

export type RemoteResourceSourceEvidence =
  | {
      readonly type: "git";
      readonly repositoryUrl: string;
      readonly ref: string;
      readonly commit: string;
      readonly subpath: string;
    }
  | {
      readonly type: "url";
      readonly url: string;
      readonly integrity: string;
      readonly validators?: ResourceUrlValidators;
    };

export interface ResourceUrlValidators {
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface ResourceSourceFetchResult {
  readonly evidence: RemoteResourceSourceEvidence;
  readonly nodes: readonly FileTreeSnapshotNode[];
  readonly cleanup?: () => Promise<void>;
}

// Network/VCS access is a composition-root capability. Core validates every returned byte and
// immutable source field; tests inject deterministic fixtures and never need real network access.
export interface ResourceSourceTransport {
  check(source: RemoteResourceSourceEvidence): Promise<RemoteResourceSourceEvidence>;
  fetch(source: RemoteResourceSourceEvidence): Promise<ResourceSourceFetchResult>;
}

// fs 抽象:只暴露引擎实际用到的最小集合,full real 实现见 createRealEnv。
export interface FsLike {
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  // Portable regular-file capture. Implementations use a no-follow open plus lstat/fstat
  // pre/post identity checks and must not depend on recursive traversal support.
  snapshotFileNoFollow(path: string): Promise<FileTreeSnapshot>;
  verifyFileSnapshot(snapshot: FileTreeSnapshot): Promise<boolean>;
  // Capability-only query used before enumerating any recursive source directory.
  supportsSafeRecursiveSnapshots(): boolean;
  // Capture every node without following links. File kind, mode, identity, and bytes come from
  // one anchored recursive traversal. Implementations must fail closed before reading directory
  // content when handle-relative safety or stable identity cannot be established.
  snapshotTreeNoFollow(path: string): Promise<FileTreeSnapshot>;
  // Identity-only revalidation for an already captured snapshot. This never re-reads content.
  verifyTreeSnapshot(snapshot: FileTreeSnapshot): Promise<boolean>;
  // Capture one descendant relative to a stable no-follow directory anchor. Implementations
  // validate every ancestor before reading bytes and revalidate every opened identity afterward.
  // A descendant proven stably absent returns null.
  snapshotPathNoFollow(anchorRoot: string, path: string): Promise<FileTreeSnapshot | null>;
  writeFile(path: string, data: string, opts?: { mode?: number }): Promise<void>;
  writeFileBytes(path: string, data: Uint8Array, opts?: { mode?: number }): Promise<void>;
  // Publish fully-written owner evidence only when path does not already exist.
  writeFileExclusive(path: string, data: string, opts?: { mode?: number }): Promise<boolean>;
  // Flush content before atomic replacement, then flush the containing directory when supported.
  publishFileAtomically(path: string, data: string, opts?: { mode?: number }): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  access(path: string, mode: "read" | "write"): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean; mode?: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  // lstat 不跟随软链(用于安全校验与漂移检测);stat 跟随。
  lstat(path: string): Promise<FileStat>;
  stat(path: string): Promise<FileStat>;
  // 读软链目标(相对或绝对,原样返回)。
  readlink(path: string): Promise<string>;
  // 建立软链;Windows 目录传 type:"junction"。
  symlink(target: string, path: string, type?: SymlinkType): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  // 拷贝目录(递归);用于 skills 与 copy 回退。
  cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void>;
  // 解析真实路径(跟随软链);路径不存在时抛错。
  realpath(path: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

// keychain 抽象(可选);M2 接 @napi-rs/keyring,经此注入,core 不直接 import。
// get 返回判别式结果:区分「找到真值」/「无此条目」/「keychain 错误(锁定/瞬态故障)」——
// 三态不能塌缩成 string|null,否则调用方无法区分「无条目」与「取不到」,诊断信息丢失(横评 §5.1)。
export type SecretGet = { found: true; value: string } | { found: false } | { error: string };

export interface SecretStore {
  get(service: string, account: string): Promise<SecretGet>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

export interface CurrentUserOnlyPermissions {
  supported(platform: Platform): boolean;
  set(path: string): Promise<void>;
  verify(path: string): Promise<boolean>;
}

export interface MutationAuthorityRequest<
  Domain extends MutationAuthorizationDomain = MutationAuthorizationDomain,
> {
  readonly schemaVersion: 1;
  readonly domain: Domain;
  readonly normalizedStoreRoot: string;
  readonly operation: MutationOperation;
  readonly baseRevision: number;
  readonly canonicalPayload: string;
}

// An authority is an in-memory capability, not data. Implementations expose only scoped
// authorization, lifecycle-currentness, and protected-tip operations; key bytes, signing
// primitives, and general credential access never cross this boundary.
export interface MutationAuthority {
  seal<Domain extends MutationAuthorizationDomain>(
    request: MutationAuthorityRequest<Domain>,
  ): MutationAuthorizationEnvelope<Domain>;
  verify<Domain extends MutationAuthorizationDomain>(
    request: MutationAuthorityRequest<Domain>,
    envelope: MutationAuthorizationEnvelope<Domain>,
  ): boolean;
  // Currentness consults only the protected authority backend. It must not inspect product Store
  // state, and failures are reported as false rather than exposing provider details.
  isCurrent(): Promise<boolean>;
  // The lease serializes authority lifecycle changes with mutation/recovery execution. Holding it
  // never grants access to raw credential material.
  acquireLease(): Promise<MutationAuthorityLease>;
  // The latest journal publication is anchored outside the product Store. Implementations backed
  // by a credential manager persist and verify it there; explicit headless authorities keep it
  // only in the current process. The tip contains authorization metadata, never raw authority or
  // secret material.
  publishJournalTip(tip: ProtectedJournalTip): Promise<void>;
  matchesJournalTip(tip: ProtectedJournalTip): Promise<boolean>;
}

export interface ProtectedJournalTip {
  readonly operationId: string;
  readonly sequence: number;
  readonly seal: string;
}

export interface MutationAuthorityLease {
  isCurrent(): Promise<boolean>;
  release(): Promise<void>;
}

// Headless authority composition needs one owner for the lifetime of the process, but product
// Store bytes are replayable and cannot prove process liveness. This injected capability must be
// backed by a kernel-owned local resource whose ownership disappears automatically at process
// exit. It never connects to an incumbent owner and never exposes authority key material.
export interface HeadlessLifetimeLease {
  isCurrent(): Promise<boolean>;
}

export interface HeadlessLifetimeOwner {
  acquire(normalizedStoreRoot: string): Promise<HeadlessLifetimeLease>;
}

export interface Env {
  fs: FsLike;
  homedir(): string;
  cwd(): string;
  platform: Platform;
  // Store-lock owner identity and receipt ids stay injectable; core business logic never reads
  // process/os/crypto globals directly.
  processId(): number;
  hostname(): string;
  // Caller verifies that lock-owner hostname is local before probing its PID. Only "dead" is
  // affirmative abandonment evidence; permission errors and unsupported probes return "unknown".
  probeProcessLiveness(processId: number): Promise<ProcessLiveness>;
  randomId(): string;
  // 台账时间戳来源;测试注入固定值保证可重现。
  now(): Date;
  // 读环境变量(密钥解析用);非 process.env 直读,测试可注入。
  env: Record<string, string | undefined>;
  secretStore?: SecretStore;
  currentUserOnlyPermissions?: CurrentUserOnlyPermissions;
  // Required only when the protected headless authority environment channel is used. Absence or
  // local kernel-resource contention fails closed; read-only and keychain composition do not use
  // this capability.
  headlessLifetimeOwner?: HeadlessLifetimeOwner;
  // Composition must inject this before any executable mutation is planned or accepted. It stays
  // optional at the type boundary so read-only Core services remain usable when authority is absent.
  mutationAuthority?: MutationAuthority;
  resourceSourceTransport?: ResourceSourceTransport;
}
