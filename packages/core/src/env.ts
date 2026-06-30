// Env:副作用注入边界(架构不变量 2)。
// core 内一切 fs / home / cwd / platform / now / 环境变量 / keychain 都从这里取,
// 严禁在 core 直接 import "node:fs" 或读 process/os —— 这是可测性与跨平台的支点。

export type Platform = "darwin" | "linux" | "win32" | (string & {});

// 软链类型:POSIX 不区分;Windows 目录用 junction。
export type SymlinkType = "file" | "dir" | "junction";

export interface FileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

// fs 抽象:只暴露引擎实际用到的最小集合,full real 实现见 createRealEnv。
export interface FsLike {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
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
export interface SecretStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

export interface Env {
  fs: FsLike;
  homedir(): string;
  cwd(): string;
  platform: Platform;
  // 台账时间戳来源;测试注入固定值保证可重现。
  now(): Date;
  // 读环境变量(密钥解析用);非 process.env 直读,测试可注入。
  env: Record<string, string | undefined>;
  secretStore?: SecretStore;
}
