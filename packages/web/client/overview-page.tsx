import type {
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
  DashboardSummaryResult,
} from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { storedResources } from "./library-model.js";
import { browserWorkbenchLocale, workbenchLabels } from "./workbench-labels.js";

export function overviewEvidence(
  summary: DashboardSummaryResult | null,
  library: ControlPlaneResourceListDto | null,
) {
  return {
    storedCount: library ? storedResources(library.resources).length : null,
    detectedAgents: summary?.agentCounts.detected ?? null,
    matchingTargets: summary?.driftCounts.ok ?? null,
    targetIssues: summary?.driftItems ?? null,
    pendingTargets: summary
      ? summary.driftCounts.drifted +
        summary.driftCounts.missing +
        summary.driftCounts["broken-link"]
      : null,
    conflicts: null,
    blockedCoverage: summary
      ? summary.distributionCoverage.reduce((count, group) => count + group.blockedCount, 0)
      : null,
    nativeLoading: "unverified",
    sourceUpdates: "not checked",
  } as const;
}

export function OverviewPage({
  onDiscover,
  onOpenResource,
  onSync,
  onHistory,
}: {
  onDiscover(): void;
  onOpenResource(id?: string): void;
  onSync(): void;
  onHistory(): void;
}) {
  const [summary, setSummary] = useState<DashboardSummaryResult | null>(null);
  const [library, setLibrary] = useState<ControlPlaneResourceListDto | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const labels = workbenchLabels(browserWorkbenchLocale());
  const zh = browserWorkbenchLocale() === "zh-CN";
  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      apiFetch("/api/v1/summary").then(readApiJson<DashboardSummaryResult>),
      apiFetch("/api/v1/resources?includeDiscovered=false").then(
        readApiJson<ControlPlaneResourceListDto>,
      ),
    ]).then(([summaryResult, libraryResult]) => {
      if (!alive) return;
      setSummary(summaryResult.status === "fulfilled" ? summaryResult.value : null);
      setLibrary(libraryResult.status === "fulfilled" ? libraryResult.value : null);
      setErrors(
        [summaryResult, libraryResult]
          .filter((result) => result.status === "rejected")
          .map((result) =>
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          ),
      );
    });
    return () => {
      alive = false;
    };
  }, []);

  const evidence = overviewEvidence(summary, library);
  const resources: readonly ControlPlaneResourceDto[] = library
    ? storedResources(library.resources)
    : [];
  const counts = {
    skills: resources.filter((resource) => resource.kind === "skills").length,
    mcp: resources.filter((resource) => resource.kind === "mcp").length,
    rules: resources.filter((resource) => resource.kind === "rules").length,
  };
  const desired = summary?.distributionCoverage.reduce(
    (count, group) => count + (group.desiredCount ?? 0),
    0,
  );
  const applied = summary?.distributionCoverage.reduce(
    (count, group) => count + (group.appliedCount ?? 0),
    0,
  );
  return (
    <div className="page-stack overview-page">
      {errors.map((error) => (
        <p role="alert" className="api-error" key={error}>
          {error}
        </p>
      ))}
      <div className="overview-context-bar">
        <span>
          <strong>Store</strong> · {zh ? "本机" : "This device"}
        </span>
        <span>
          <strong>{zh ? "当前范围" : "Current scope"}</strong> ·{" "}
          {summary?.scope === "project"
            ? (summary.dir ?? (zh ? "项目目录未返回" : "Project path unavailable"))
            : zh
              ? "用户范围"
              : "User scope"}
        </span>
        <span>
          {zh ? "最近汇总" : "Summary at"} · {summary?.generatedAt ?? (zh ? "正在加载" : "Loading")}
        </span>
      </div>
      <section className="overview-cards" aria-label={zh ? "当前证据" : "Current evidence"}>
        <article className="panel">
          <h3>{zh ? "已观察来源" : "Observed sources"}</h3>
          <p>{zh ? "只读扫描与来源覆盖" : "Read-only Inventory coverage"}</p>
          <strong>{zh ? "待查看" : "Inspect"}</strong>
          <p>
            {zh
              ? "打开 Inventory 查看最新完整度与候选；这里不将历史扫描当作当前结果。"
              : "Open Inventory for current completeness and candidates."}
          </p>
          <button type="button" className="link-button" onClick={onDiscover}>
            {labels.actions.find} →
          </button>
        </article>
        <article className="panel">
          <h3>{zh ? "Store 中的配置" : "Store configuration"}</h3>
          <p>{zh ? "本地已入库配置资源" : "Locally stored resources"}</p>
          <strong>{evidence.storedCount ?? labels.status.unknown}</strong>
          <div className="overview-kind-list">
            <span>
              Skills <b>{counts.skills}</b>
            </span>
            <span>
              MCP <b>{counts.mcp}</b>
            </span>
            <span>
              Rules <b>{counts.rules}</b>
            </span>
          </div>
          <button type="button" className="link-button" onClick={() => onOpenResource()}>
            {labels.navigation.library} →
          </button>
        </article>
        <article className="panel">
          <h3>{zh ? "目标配置" : "Target configuration"}</h3>
          <p>{zh ? "期望、已应用与磁盘对比" : "Desired, applied, and disk evidence"}</p>
          <strong>
            {desired ?? labels.status.unknown} <small>{zh ? "期望" : "desired"}</small>
          </strong>
          <div className="overview-target-list">
            <span>
              {zh ? "已应用" : "Applied"} <b>{applied ?? labels.status.unknown}</b>
            </span>
            <span>
              {zh ? "磁盘一致" : "Disk matching"}{" "}
              <b>{evidence.matchingTargets ?? labels.status.unknown}</b>
            </span>
            <span>
              {zh ? "待检查" : "Needs review"}{" "}
              <b>{evidence.pendingTargets ?? labels.status.unknown}</b>
            </span>
          </div>
          <button type="button" className="link-button" onClick={onSync}>
            {zh ? "查看差异" : "Review differences"} →
          </button>
        </article>
        <article className="panel">
          <h3>{zh ? "原生运行状态" : "Native runtime"}</h3>
          <p>{zh ? "Agent 的实际加载与生效" : "Actual Agent loading"}</p>
          <strong className="overview-unverified">{zh ? "未验证" : "Unverified"}</strong>
          <p>
            {zh
              ? "文件一致不能确认 Agent 已加载。请查看运行时证据。"
              : "Files can match while native loading unverified."}
          </p>
          <button type="button" className="link-button" onClick={onHistory}>
            {labels.actions.verify} →
          </button>
        </article>
      </section>
      <section className="overview-next">
        <div>
          <h3>
            {evidence.pendingTargets ?? labels.status.unknown}{" "}
            {zh ? "个目标待检查" : "targets need review"}
          </h3>
          <p>
            {zh
              ? "目标文件状态以最新验证为准；来源版本更新须在配置库单独检查。"
              : "Current verification determines target status; check source revisions separately. Conflicts: unavailable in this summary."}
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="action" onClick={onSync}>
            {zh ? "预览同步" : "Preview sync"}
          </button>
          <button type="button" className="action secondary" onClick={onHistory}>
            {zh ? "验证配置" : "Verify"}
          </button>
          <button type="button" className="action secondary" onClick={onHistory}>
            {labels.navigation.history}
          </button>
        </div>
      </section>
      <div className="overview-bottom">
        <section className="panel">
          <h3>{zh ? "最近操作记录" : "Recent activity"}</h3>
          <p>
            {zh
              ? "历史结果；当前目标状态需单独验证。"
              : "Historical outcomes; verify current targets separately."}
          </p>
          {summary?.latestActivity?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{zh ? "时间" : "Time"}</th>
                    <th>{zh ? "操作" : "Action"}</th>
                    <th>{zh ? "对象" : "Target"}</th>
                    <th>{zh ? "说明" : "Summary"}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.latestActivity.slice(0, 5).map((event) => (
                    <tr key={event.id}>
                      <td>{event.time}</td>
                      <td>{event.action}</td>
                      <td>{event.agents.join(", ") || "—"}</td>
                      <td>{event.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">{zh ? "暂无操作记录" : "No activity yet"}</p>
          )}
        </section>
        <div className="overview-explain">
          <section className="panel">
            <h3>{zh ? "关于配置与原生运行" : "Configuration and runtime"}</h3>
            <p>
              {zh
                ? "Store 中的配置是期望内容；磁盘目标是已写入结果；两者各自需要证据。原生 Agent 是否加载仍须单独观察。"
                : "Store intent, target files, and native loading require separate evidence."}
            </p>
          </section>
          <section className="panel">
            <h3>{zh ? "待处理事项" : "Next steps"}</h3>
            <button type="button" className="link-button" onClick={onDiscover}>
              {labels.actions.find} →
            </button>
            <button type="button" className="link-button" onClick={onSync}>
              {zh ? "审查目标计划" : "Review target plan"} →
            </button>
          </section>
        </div>
      </div>
      {evidence.targetIssues && evidence.targetIssues.length > 0 && (
        <section className="panel" aria-label={zh ? "受影响目标" : "Affected targets"}>
          <h3>{zh ? "待检查目标" : "Targets needing review"}</h3>
          {evidence.targetIssues.map((item) => (
            <p key={`${item.agent}:${item.scope}:${item.artifact}:${item.target}`}>
              {item.status} · {item.agent}/{item.scope} · {item.artifact} · {item.target}{" "}
              <button type="button" onClick={() => onOpenResource(item.artifact)}>
                {zh ? "查看对应配置" : "Inspect exact resource"}
              </button>
            </p>
          ))}
        </section>
      )}
      {summary?.warnings.length ? (
        <section className="panel">
          <h3>{zh ? "当前提示" : "Current warnings"}</h3>
          {summary.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </section>
      ) : null}
      {resources.length > 0 && (
        <section className="panel">
          <h3>{zh ? "Store 版本" : "Store revisions"}</h3>
          {resources.slice(0, 5).map((resource) => (
            <p key={resource.id}>
              <button type="button" onClick={() => onOpenResource(resource.id)}>
                {resource.id}
              </button>{" "}
              · {resource.currentRevision?.id ?? labels.status.unknown}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
