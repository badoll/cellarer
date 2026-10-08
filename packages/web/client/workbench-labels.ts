export type WorkbenchLocale = "zh-CN" | "en";
export type PrimaryPage = "dashboard" | "library" | "sync" | "agents" | "history" | "settings";

const labels = {
  en: {
    navigation: {
      dashboard: "Overview",
      library: "Agent Config Library",
      sync: "Sync",
      agents: "Agents",
      history: "Operation History",
      settings: "Settings",
      inventory: "Find existing configuration",
      profiles: "Profiles",
    },
    details: {
      dashboard: "Current evidence",
      library: "Skills · MCP · Rules",
      sync: "Review target plan",
      agents: "Targets and Profiles",
      history: "Receipts and recovery",
      settings: "Defaults",
    },
    subtitles: {
      dashboard: "Current configuration and next actions from observed evidence.",
      library: "Review stored Skills, MCP servers, and Rules before selecting an action.",
      sync: "Choose the target and configuration, then review the Core plan.",
      agents: "Registered adapters, detected roots, and capability coverage.",
      history: "Inspect recorded operations and follow-up actions.",
      settings: "Store defaults, groups, adapters, and secret references.",
      inventory: "Read-only candidates across bounded registered user and project sources.",
      profiles: "Desired selections, reviewed reconciliation and consumer uninstall.",
    },
    actions: {
      find: "Find existing configuration",
      add: "Add configuration",
      sync: "Sync to Agents",
      verify: "Verify configuration",
      recover: "Review recovery",
    },
    intent: {
      ids: "Selected configurations",
      group: "Group",
      profile: "Profile",
      defaults: "Store defaults",
    },
    status: {
      unknown: "Unknown",
      pending: "Pending sync",
      configured: "Configured files",
      nativeUnverified: "Native loading unverified",
      updateAvailable: "Update available",
    },
  },
  "zh-CN": {
    navigation: {
      dashboard: "概览",
      library: "Agent 配置库",
      sync: "同步",
      agents: "Agent",
      history: "操作记录",
      settings: "设置",
      inventory: "查找已有配置",
      profiles: "配置方案",
    },
    details: {
      dashboard: "当前证据",
      library: "Skills · MCP · Rules",
      sync: "审阅目标计划",
      agents: "目标与配置方案",
      history: "回执与恢复",
      settings: "默认设置",
    },
    subtitles: {
      dashboard: "根据当前观测查看配置状态和下一步操作。",
      library: "查看 Store 中的 Skills、MCP 服务器和 Rules，再选择操作。",
      sync: "选择目标与配置，确认 Core 计划后再应用。",
      agents: "查看已注册适配器、检测到的目录和能力覆盖。",
      history: "查看操作记录、回执及后续动作。",
      settings: "管理 Store 默认设置、分组、适配器和密钥引用。",
      inventory: "只读扫描已注册的用户与工程来源；完整结果确认后才可导入。",
      profiles: "保存期望资源选择，并分别审查下发与验证目标。",
    },
    actions: {
      find: "查找已有配置",
      add: "添加配置",
      sync: "同步到 Agent",
      verify: "验证配置",
      recover: "查看恢复操作",
    },
    intent: {
      ids: "所选配置",
      group: "分组",
      profile: "配置方案",
      defaults: "Store 默认选择",
    },
    status: {
      unknown: "未知",
      pending: "待同步",
      configured: "文件已配置",
      nativeUnverified: "原生加载未验证",
      updateAvailable: "可更新",
    },
  },
} as const;

export function workbenchLocale(language: string | undefined): WorkbenchLocale {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function browserWorkbenchLocale(): WorkbenchLocale {
  if (typeof location !== "undefined") {
    const requested = new URLSearchParams(location.search).get("lang");
    if (requested === "zh-CN" || requested === "en") return requested;
  }
  return workbenchLocale(typeof navigator === "undefined" ? undefined : navigator.language);
}

export function workbenchLabels(locale: WorkbenchLocale) {
  return labels[locale];
}

export const PRIMARY_PAGES: readonly PrimaryPage[] = [
  "dashboard",
  "library",
  "sync",
  "agents",
  "history",
  "settings",
];
