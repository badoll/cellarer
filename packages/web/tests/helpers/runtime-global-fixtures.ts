export const aggregatedRuntimeGlobalMutations = [
  ["nested process member", "export const mutation = globalThis.process.platform;"],
  ["computed Buffer member", 'export const mutation = globalThis["Buffer"];'],
  ["const computed key", 'const key = "process"; export const mutation = globalThis[key];'],
  ["alias", "const runtime = globalThis; export const mutation = runtime.process;"],
  [
    "destructure",
    "const { process: runtimeProcess } = globalThis; export const mutation = runtimeProcess.platform;",
  ],
  ["assignment", "let runtime; runtime = globalThis; export const mutation = runtime.process;"],
  ["rest", "const { ...runtime } = globalThis; export const mutation = runtime.process;"],
  [
    "nested destructure",
    "const { runtime: { process: runtimeProcess } } = { runtime: globalThis }; export const mutation = runtimeProcess.platform;",
  ],
  ["array", "const [runtime] = [globalThis]; export const mutation = runtime.process;"],
  [
    "container",
    "const container = { runtime: globalThis }; export const mutation = container.runtime.process;",
  ],
  [
    "wrapper return",
    "function runtime() { return globalThis; } export const mutation = runtime().process;",
  ],
  ["Object.assign", "export const mutation = Object.assign({}, globalThis).process;"],
  [
    "class field",
    "class Runtime { runtime = globalThis; } export const mutation = new Runtime().runtime.process;",
  ],
  ["array member chain", 'export const mutation = [globalThis][0].require("node:path");'],
  [
    "object member chain",
    'export const mutation = ({ runtime: globalThis }).runtime.require("node:path");',
  ],
] as const;

export const lexicalRuntimeGlobalShadows = [
  [
    "local global object name",
    'const globalThis = { process: { platform: "browser" } }; export const mutation = globalThis.process.platform;',
  ],
  [
    "function parameter",
    'function platform(process = { platform: "browser" }) { return process.platform; } export const mutation = platform();',
  ],
  [
    "block binding",
    'let mutation; { const Buffer = { from: () => "browser" }; mutation = Buffer.from(); } export { mutation };',
  ],
  [
    "class declaration",
    'class module { static value = "browser"; } export const mutation = module.value;',
  ],
  [
    "named class expression",
    "const RuntimeClass = class require { static value = require; }; export const mutation = RuntimeClass.value;",
  ],
] as const;
