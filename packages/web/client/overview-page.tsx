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
  return (
    <div className="page-stack overview-page">
      {errors.map((error) => (
        <p role="alert" className="api-error" key={error}>
          {error}
        </p>
      ))}
      <section className="overview-cards" aria-label={zh ? "当前证据" : "Current evidence"}>
        <article className="panel">
          <h3>{zh ? "Store 配置" : "Stored configuration"}</h3>
          <strong>{evidence.storedCount ?? labels.status.unknown}</strong>
          <p>{zh ? "当前 Store 列表" : "Current Store list"}</p>
          <button type="button" onClick={() => onOpenResource()}>
            {labels.navigation.library}
          </button>
        </article>
        <article className="panel">
          <h3>{zh ? "检测到的 Agent" : "Detected Agents"}</h3>
          <strong>{evidence.detectedAgents ?? labels.status.unknown}</strong>
          <p>{zh ? "当前 Agent 汇总" : "Current Agent summary"}</p>
          <button type="button" onClick={onSync}>
            {zh ? "查看同步目标" : "Review sync targets"}
          </button>
        </article>
        <article className="panel">
          <h3>{zh ? "匹配的目标文件" : "Matching target files"}</h3>
          <strong>{evidence.matchingTargets ?? labels.status.unknown}</strong>
          <p>
            {zh ? "仅代表文件状态；原生加载未验证" : "File status only; native loading unverified"}
          </p>
          <button type="button" onClick={onHistory}>
            {labels.actions.verify}
          </button>
        </article>
      </section>
      <section className="panel">
        <h3>{zh ? "下一步" : "Next actions"}</h3>
        <p>
          {zh
            ? "来源更新：未检查。请在配置库中检查单项；来源更新与目标同步分开。"
            : "Source updates: not checked. Check an individual resource in the library; this is separate from target sync."}
        </p>
        <p>
          {zh ? "目标待同步或缺失" : "Pending or missing targets"}:{" "}
          {evidence.pendingTargets ?? labels.status.unknown}.{" "}
          {zh ? "冲突：此汇总未提供" : "Conflicts: unavailable in this summary"}.{" "}
          {zh ? "覆盖阻塞" : "Blocked coverage"}:{" "}
          {evidence.blockedCoverage ?? labels.status.unknown}.
        </p>
        <div className="button-row">
          <button type="button" onClick={onDiscover}>
            {labels.actions.find}
          </button>
          <button type="button" onClick={() => onOpenResource()}>
            {zh ? "查看 Store 版本" : "Review Store revisions"}
          </button>
          <button type="button" onClick={onSync}>
            {zh ? "预览目标同步" : "Preview target sync"}
          </button>
          <button type="button" onClick={onHistory}>
            {labels.navigation.history}
          </button>
        </div>
      </section>
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
