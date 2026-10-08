import type { ActivityEvent, Scope } from "@cellarer/core/client-api";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { browserWorkbenchLocale } from "./workbench-labels.js";
import {
  type WorkflowAction,
  WorkflowDialog,
  workflowError,
  workflowPost,
} from "./workflow-dialog.js";

interface OperationSummary {
  operationId: string;
  operation: string;
  outcome: string;
  actionCount: number;
  startedAt: string;
  completedAt: string;
}
interface OperationDetail {
  operation:
    | (OperationSummary & {
        recoveryStatus: "clean" | "manual-recovery-required";
        actionReceipts: { actionId: string; target: string; outcome: string }[];
      })
    | null;
}
interface RecoveryDiagnosis {
  status: "clean" | "incomplete" | "completed-pending-cleanup" | "manual-recovery-required";
  journal: { operationId: string } | null;
  message: string;
}
interface Verification {
  configuration: string;
  healthy: boolean;
  runtime: { observation?: string };
  recovery: { status?: string };
}

export function OperationHistoryPage() {
  const zh = browserWorkbenchLocale() === "zh-CN";
  const [operations, setOperations] = useState<OperationSummary[] | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
  const [recovery, setRecovery] = useState<RecoveryDiagnosis | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<OperationDetail["operation"]>(null);
  const [detailLoaded, setDetailLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "success" | "other">("all");
  const [reload, setReload] = useState(0);
  const [recoverConfirmation, setRecoverConfirmation] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoverBusy = useRef(false);
  const [agents, setAgents] = useState("");
  const [scope, setScope] = useState<Scope>("global");
  const [dir, setDir] = useState("");
  const [artifactIds, setArtifactIds] = useState("");
  const [verification, setVerification] = useState<Verification | null>(null);
  const verificationGeneration = useRef(0);
  const [revertAction, setRevertAction] = useState<WorkflowAction | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    Promise.allSettled([
      apiFetch("/api/v1/operations?limit=50").then(readApiJson<{ operations: OperationSummary[] }>),
      apiFetch("/api/v1/activity?limit=50").then(readApiJson<{ events: ActivityEvent[] }>),
      apiFetch("/api/v1/recovery").then(readApiJson<RecoveryDiagnosis>),
    ]).then(([receipts, events, diagnosis]) => {
      if (!alive) return;
      setOperations(receipts.status === "fulfilled" ? receipts.value.operations : null);
      setActivity(events.status === "fulfilled" ? events.value.events : null);
      setRecovery(diagnosis.status === "fulfilled" ? diagnosis.value : null);
      setLoaded(true);
      setError(
        [receipts, events, diagnosis]
          .filter((result) => result.status === "rejected")
          .map((result) => workflowError(result.reason))
          .join(" · "),
      );
    });
    return () => {
      alive = false;
    };
  }, [reload]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailLoaded(false);
    if (!selectedId) return;
    apiFetch(`/api/v1/operations/${encodeURIComponent(selectedId)}`)
      .then(readApiJson<OperationDetail>)
      .then((result) => {
        if (alive) {
          setDetail(result.operation);
          setDetailLoaded(true);
        }
      })
      .catch((cause) => {
        if (alive) {
          setError(workflowError(cause));
          setDetailLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [selectedId, reload]);

  const selectedAgents = uniqueList(agents);
  const visibleOperations = (operations ?? []).filter((operation) => {
    const matchesText = `${operation.operation} ${operation.operationId} ${operation.outcome}`
      .toLowerCase()
      .includes(query.toLowerCase());
    const success = operation.outcome === "success" || operation.outcome === "completed";
    return (
      matchesText && (outcomeFilter === "all" || (outcomeFilter === "success" ? success : !success))
    );
  });
  const selectedArtifacts = uniqueList(artifactIds);
  const contextReady = selectedAgents.length > 0 && (scope === "global" || !!dir.trim());
  const targetContext = {
    agents: selectedAgents,
    scope,
    ...(scope === "project" ? { dir: dir.trim() } : {}),
  };

  async function verifyCurrent() {
    const token = ++verificationGeneration.current;
    setVerification(null);
    setError("");
    try {
      const result = await workflowPost<Verification>("/api/v1/verify", {
        ...targetContext,
        capabilities: ["skills", "mcp", "rules"],
      });
      if (token === verificationGeneration.current) setVerification(result);
    } catch (cause) {
      if (token === verificationGeneration.current) setError(workflowError(cause));
    }
  }

  function invalidateVerification() {
    verificationGeneration.current++;
    setVerification(null);
    setRevertAction(null);
  }

  function reviewRevert() {
    if (!contextReady || selectedArtifacts.length === 0) return;
    const input = { ...targetContext, artifactIds: selectedArtifacts };
    setRevertAction({
      title: zh ? "审阅历史回滚" : "Review historical revert",
      description: zh
        ? `为 ${selectedAgents.join(", ")} 上的精确资源 ${selectedArtifacts.join(", ")} 请求新的 Core 回滚计划。历史回执不代表当前目标状态。`
        : `Request a fresh Core revert plan for exact resources ${selectedArtifacts.join(", ")} on ${selectedAgents.join(", ")}. The historical receipt does not describe current target state.`,
      planPath: "/api/v1/revert/plan",
      applyPath: "/api/v1/revert/apply",
      input,
      applyInput: input,
      success: zh
        ? "已按新审阅的计划回滚；请单独验证当前配置。"
        : "Historical revert applied from the fresh reviewed plan. Verify current configuration separately.",
    });
  }

  async function recover() {
    const operationId = recovery?.journal?.operationId;
    if (!operationId || !recoverConfirmation || recoverBusy.current) return;
    recoverBusy.current = true;
    setRecovering(true);
    setRecoverConfirmation(false);
    try {
      await workflowPost("/api/v1/recovery/apply", { operationId });
      setMessage(
        zh
          ? `操作 ${operationId} 的恢复已返回；请检查回执并验证当前目标。`
          : `Recovery returned for ${operationId}. Inspect its receipt and verify current targets.`,
      );
      setReload((value) => value + 1);
    } catch (cause) {
      setError(workflowError(cause));
    } finally {
      recoverBusy.current = false;
      setRecovering(false);
    }
  }

  return (
    <div className="page-stack">
      {error && (
        <p role="alert" className="api-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="history-workbench">
        <section className="panel" aria-label={zh ? "操作回执" : "Operation receipts"}>
          <div className="history-tabs">
            <button
              type="button"
              aria-pressed={outcomeFilter === "all"}
              onClick={() => setOutcomeFilter("all")}
            >
              全部 {operations?.length ?? 0}
            </button>
            <button
              type="button"
              aria-pressed={outcomeFilter === "other"}
              onClick={() => setOutcomeFilter("other")}
            >
              其他结果
            </button>
            <button
              type="button"
              aria-pressed={outcomeFilter === "success"}
              onClick={() => setOutcomeFilter("success")}
            >
              已完成
            </button>
          </div>
          <label className="field-row stacked">
            <span>{zh ? "搜索操作" : "Search operations"}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={zh ? "操作类型或 ID" : "Operation type or ID"}
            />
          </label>
          <p>
            {zh
              ? "以下是历史结果；当前目标需单独验证。"
              : "These are historical outcomes. Verify the current target separately."}
          </p>
          {!operations && (
            <p>
              {loaded
                ? zh
                  ? "操作回执不可用。"
                  : "Operation receipts unavailable."
                : zh
                  ? "正在加载操作…"
                  : "Loading operations..."}
            </p>
          )}
          {operations?.length === 0 && (
            <p>{zh ? "暂无操作回执。" : "No operation receipts yet."}</p>
          )}
          {operations && (
            <div className="table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>{zh ? "时间" : "Time"}</th>
                    <th>{zh ? "操作类型" : "Operation"}</th>
                    <th>ID</th>
                    <th>{zh ? "结果" : "Outcome"}</th>
                    <th>{zh ? "文件动作" : "Actions"}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOperations.map((operation) => (
                    <tr
                      key={operation.operationId}
                      className={selectedId === operation.operationId ? "selected" : ""}
                    >
                      <td>{operation.completedAt}</td>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setSelectedId(operation.operationId)}
                        >
                          {operation.operation} · {operation.outcome}
                        </button>
                      </td>
                      <td className="mono">{operation.operationId}</td>
                      <td>
                        <span
                          className={`tag ${operation.outcome === "success" || operation.outcome === "completed" ? "green" : "amber"}`}
                        >
                          {operation.outcome}
                        </span>
                      </td>
                      <td>{operation.actionCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selectedId && !detailLoaded && (
            <p>{zh ? "正在加载回执…" : "Loading selected receipt..."}</p>
          )}
          {selectedId && detailLoaded && !detail && (
            <p>{zh ? "未找到所选回执。" : "Selected receipt was not found."}</p>
          )}
        </section>
        <aside className="panel history-side" aria-label={zh ? "回执详情" : "Receipt detail"}>
          {detail ? (
            <>
              <span className={`tag ${detail.recoveryStatus === "clean" ? "green" : "amber"}`}>
                {detail.recoveryStatus === "clean"
                  ? zh
                    ? "已完成"
                    : "Complete"
                  : zh
                    ? "需人工处理"
                    : "Needs attention"}
              </span>
              <h3>{zh ? `回执 ${detail.operationId}` : `Receipt ${detail.operationId}`}</h3>
              <p>
                {zh
                  ? "历史操作的执行结果与恢复证据"
                  : "Historical operation result and recovery evidence"}
              </p>
              <dl>
                <dt>{zh ? "操作时间" : "Completed"}</dt>
                <dd>{detail.completedAt}</dd>
                <dt>{zh ? "操作类型" : "Operation"}</dt>
                <dd>{detail.operation}</dd>
                <dt>ID</dt>
                <dd className="mono">{detail.operationId}</dd>
                <dt>{zh ? "结果" : "Outcome"}</dt>
                <dd>{detail.outcome}</dd>
                <dt>{zh ? "恢复状态" : "Recovery status"}</dt>
                <dd>{detail.recoveryStatus}</dd>
              </dl>
              <h4>{zh ? "文件动作回执" : "Action receipts"}</h4>
              {detail.actionReceipts.length ? (
                detail.actionReceipts.map((action) => (
                  <p className="mono" key={action.actionId}>
                    {action.outcome} · {action.target}
                  </p>
                ))
              ) : (
                <p>{zh ? "没有文件动作。" : "No file actions."}</p>
              )}
              <p className="history-evidence-note">
                {zh
                  ? "回执不代表当前目标健康；请在下方按明确 Agent 与范围重新验证。"
                  : "A receipt does not prove current target health. Verify the exact Agent and scope below."}
              </p>
            </>
          ) : (
            <p className="empty-state">
              {zh ? "选择一条操作查看回执。" : "Select an operation to inspect its receipt."}
            </p>
          )}
        </aside>
      </div>
      <section className="panel" aria-label={zh ? "活动" : "Activity"}>
        <h3>{zh ? "活动" : "Activity"}</h3>
        {!activity && (
          <p>
            {loaded
              ? zh
                ? "活动记录不可用。"
                : "Activity unavailable."
              : zh
                ? "正在加载活动…"
                : "Loading activity..."}
          </p>
        )}
        {activity?.map((event) => (
          <p key={event.id}>
            {event.time} · {event.action} · {event.summary} · {event.agents.join(", ")} ·{" "}
            {event.affectedCount} {zh ? "项受影响" : "affected"}
          </p>
        ))}
        {activity?.length === 0 && <p>{zh ? "暂无活动记录。" : "No activity recorded yet."}</p>}
      </section>
      <section className="panel" aria-label={zh ? "恢复" : "Recovery"}>
        <h3>{zh ? "恢复" : "Recovery"}</h3>
        <p>
          {recovery
            ? `${recovery.status}: ${recovery.message}`
            : loaded
              ? zh
                ? "恢复状态不可用。"
                : "Recovery status unavailable."
              : zh
                ? "正在加载恢复状态…"
                : "Loading recovery state..."}
        </p>
        {recovery?.journal && (
          <p>
            {zh ? "日志操作" : "Journal operation"}: {recovery.journal.operationId}
          </p>
        )}
        {recovery?.journal &&
          recovery.status !== "clean" &&
          recovery.status !== "manual-recovery-required" && (
            <div className="button-row">
              <button type="button" onClick={() => setRecoverConfirmation(true)}>
                {zh ? "审阅恢复操作" : "Review recovery action"}
              </button>
              {recoverConfirmation && (
                <button type="button" className="action" disabled={recovering} onClick={recover}>
                  {recovering
                    ? zh
                      ? "正在恢复…"
                      : "Recovering..."
                    : `${zh ? "恢复" : "Recover"} ${recovery.journal.operationId}`}
                </button>
              )}
            </div>
          )}
        {recovery?.status === "manual-recovery-required" && (
          <p>
            {zh
              ? "需要人工恢复。先检查日志并遵循 Core 恢复指引，再执行其他变更。可运行 "
              : "Manual recovery is required. Inspect the journal and follow Core recovery guidance before another mutation. For this operation, run "}
            <code>cellarer operation recover {recovery.journal?.operationId} --dry-run</code>
            {zh ? " 查看持久证据。" : " to inspect durable evidence."}
          </p>
        )}
      </section>
      <section
        className="panel workflow-panel"
        aria-label={zh ? "当前目标和历史回滚" : "Current target and historical revert"}
      >
        <h3>{zh ? "当前目标和历史回滚" : "Current target and historical revert"}</h3>
        <p>
          {zh
            ? "输入精确 Agent 和资源 ID。验证读取当前目标；历史回滚始终请求新计划。"
            : "Enter exact Agent and resource IDs. Verification reads the current target; historical revert always requests a new plan."}
        </p>
        <label className="field-row stacked">
          <span>{zh ? "Agent ID，逗号分隔" : "Agent IDs, comma separated"}</span>
          <input
            value={agents}
            onChange={(event) => {
              invalidateVerification();
              setAgents(event.target.value);
            }}
          />
        </label>
        <label className="field-row stacked">
          <span>{zh ? "范围" : "Scope"}</span>
          <select
            value={scope}
            onChange={(event) => {
              invalidateVerification();
              setScope(event.target.value as Scope);
            }}
          >
            <option value="global">{zh ? "用户" : "User"}</option>
            <option value="project">{zh ? "项目" : "Project"}</option>
          </select>
        </label>
        {scope === "project" && (
          <label className="field-row stacked">
            <span>{zh ? "项目根目录" : "Project root"}</span>
            <input
              value={dir}
              onChange={(event) => {
                invalidateVerification();
                setDir(event.target.value);
              }}
            />
          </label>
        )}
        <button
          type="button"
          className="action secondary"
          disabled={!contextReady}
          onClick={verifyCurrent}
        >
          {zh ? "验证当前配置" : "Verify current configuration"}
        </button>
        {verification && (
          <p role="status">
            {zh ? "当前配置" : "Current configuration"}: {verification.configuration};{" "}
            {zh ? "原生加载" : "native loading"}:{" "}
            {verification.runtime.observation ?? (zh ? "未知" : "unknown")};{" "}
            {zh ? "恢复" : "recovery"}: {verification.recovery.status ?? (zh ? "未知" : "unknown")}.
          </p>
        )}
        <label className="field-row stacked">
          <span>{zh ? "精确资源 ID，逗号分隔" : "Exact resource IDs, comma separated"}</span>
          <input
            value={artifactIds}
            onChange={(event) => {
              invalidateVerification();
              setArtifactIds(event.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="action"
          disabled={!contextReady || selectedArtifacts.length === 0}
          onClick={reviewRevert}
        >
          {zh ? "预览历史回滚" : "Preview historical revert"}
        </button>
      </section>
      {revertAction && (
        <WorkflowDialog
          action={revertAction}
          onClose={() => setRevertAction(null)}
          onApplied={(result) => {
            setRevertAction(null);
            setMessage(result);
            setReload((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

function uniqueList(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
}
