import type { Capability, DistributePlan, MutationPlan } from "@cellarer/core/client-api";
import { useLayoutEffect, useRef, useState } from "react";
import { AgentPicker } from "./agent-picker.js";
import { apiFetch } from "./api.js";
import { ClientApiError, isClientReplanRequired, readApiJson } from "./api-state.js";
import { type Destination, destinationLabel, resourceKindLabel } from "./product-model.js";
import {
  buildSyncSelection,
  isProjectDirMissing,
  type SyncRequest,
  syncKindsForIntent,
  syncRequestKey,
} from "./sync-selection.js";
import { browserWorkbenchLocale } from "./workbench-labels.js";

export { buildSyncRequest, isProjectDirMissing, syncRequestKey } from "./sync-selection.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSharedTarget(action: DistributePlan["actions"][number]): boolean {
  return (action.consumerAgents?.filter((agent) => agent !== action.agent).length ?? 0) > 0;
}

export function SyncDialog(props: {
  open: boolean;
  presentation?: "dialog" | "page";
  kinds?: Capability[];
  collections?: string[];
  resourceIds?: string[];
  onClose(): void;
  onApplied(): void;
}) {
  const zh = browserWorkbenchLocale() === "zh-CN";
  const [agents, setAgents] = useState("codex");
  const [destination, setDestination] = useState<Destination>("user");
  const [dir, setDir] = useState("");
  const [plan, setPlan] = useState<DistributePlan | null>(null);
  const [mutationPlan, setMutationPlan] = useState<MutationPlan | null>(null);
  const [plannedRequest, setPlannedRequest] = useState<SyncRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const kinds = syncKindsForIntent(props.resourceIds, props.kinds);

  const selection = buildSyncSelection({
    agents,
    destination,
    dir,
    kinds,
    collections: props.collections,
    resourceIds: props.resourceIds,
  });
  const { request, key: currentRequestKey } = selection;
  // Bind authority to committed normalized input and a dialog session, not array identity.
  useLayoutEffect(() => {
    generation.current += 1;
    setPlan(null);
    setMutationPlan(null);
    setPlannedRequest(null);
    setError(null);
    setPreviewing(false);
    return () => {
      generation.current += 1;
    };
  }, [props.open, currentRequestKey]);

  if (!props.open) return null;
  const dirMissing = isProjectDirMissing(destination, dir);
  const hasAgents = request.agents.length > 0;
  const hasCurrentPreview =
    plan !== null &&
    mutationPlan !== null &&
    plannedRequest !== null &&
    syncRequestKey(plannedRequest) === currentRequestKey;
  const canPreview =
    props.resourceIds?.length !== 0 && hasAgents && !dirMissing && !previewing && !applying;
  const hasBlockers =
    !!plan &&
    (!!plan.conflicts?.length ||
      !!plan.invalidLedger ||
      !!plan.secretFindings?.length ||
      !!plan.secretReferenceFindings?.length ||
      plan.actions.some((action) => !!action.replacement));
  const canApply = canPreview && hasCurrentPreview && !hasBlockers;

  function resetPlan() {
    generation.current += 1;
    setPlan(null);
    setMutationPlan(null);
    setPlannedRequest(null);
  }

  async function preview() {
    if (!canPreview || busy.current) return;
    resetPlan();
    setError(null);
    setPreviewing(true);
    const requestGeneration = ++generation.current;
    try {
      const response = await apiFetch("/api/v1/sync/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const nextPlan = await readApiJson<{ plan: DistributePlan; mutationPlan: MutationPlan }>(
        response,
      );
      if (requestGeneration !== generation.current) return;
      setPlan(nextPlan.plan);
      setMutationPlan(nextPlan.mutationPlan);
      setPlannedRequest(request);
    } catch (err) {
      if (requestGeneration !== generation.current) return;
      setPlan(null);
      setMutationPlan(null);
      setPlannedRequest(null);
      const message =
        err instanceof ClientApiError ? `${err.code}: ${err.message}` : errorMessage(err);
      setError(
        isClientReplanRequired(err) ? `${message}. Preview again to review a fresh plan.` : message,
      );
    } finally {
      if (requestGeneration === generation.current) setPreviewing(false);
    }
  }

  async function applySync() {
    if (!canApply || !plannedRequest || !mutationPlan || busy.current) return;
    busy.current = true;
    const requestGeneration = generation.current;
    setError(null);
    setApplying(true);
    try {
      const response = await apiFetch("/api/v1/sync/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mutationPlan }),
      });
      await readApiJson<unknown>(response);
      if (requestGeneration !== generation.current) return;
      resetPlan();
      props.onApplied();
    } catch (err) {
      if (requestGeneration !== generation.current) return;
      resetPlan();
      const message =
        err instanceof ClientApiError ? `${err.code}: ${err.message}` : errorMessage(err);
      setError(
        isClientReplanRequired(err) ? `${message}. Preview again to review a fresh plan.` : message,
      );
    } finally {
      busy.current = false;
      setApplying(false);
    }
  }

  return (
    <div
      className={props.presentation === "page" ? "sync-review-page" : "modal-backdrop"}
      role="presentation"
    >
      <section
        className={props.presentation === "page" ? "sync-review-surface" : "modal sync-modal"}
        role={props.presentation === "page" ? "region" : "dialog"}
        aria-label={zh ? "同步到 Agent" : "Sync to Agents"}
      >
        <div className="panel-header modal-header">
          <div>
            <h3>{zh ? "选择目标并审查计划" : "Select target and review plan"}</h3>
            <p>
              {zh
                ? "应用所选资源前，先预览写入 Agent 目标的计划。"
                : "Preview writes to agent targets before applying the selected resources."}
            </p>
          </div>
          <button type="button" className="link-button" disabled={applying} onClick={props.onClose}>
            {zh ? "关闭" : "Close"}
          </button>
        </div>

        {props.presentation === "page" && (
          <div className="sync-selection-return">
            <button
              type="button"
              className="link-button"
              disabled={applying}
              onClick={props.onClose}
            >
              {zh ? "更改资源选择" : "Change selection"}
            </button>
          </div>
        )}

        <div className="sync-review-layout">
          <div className="sync-review-main">
            <div className="sync-dialog-grid">
              <label className="field-row stacked">
                <span>{zh ? "目标 Agent" : "Target agents"}</span>
                <input
                  type="text"
                  disabled={applying}
                  value={agents}
                  onChange={(event) => {
                    setAgents(event.target.value);
                  }}
                />
              </label>
              <div className="sync-resource-summary">
                <span>{zh ? "资源" : "Resources"}</span>
                <strong>
                  {zh
                    ? props.resourceIds
                      ? `精确资源：${props.resourceIds.join(", ")}`
                      : props.collections?.length
                        ? `分组：${props.collections.join(", ")}`
                        : "Store 默认选择"
                    : selection.resourceSummary}
                </strong>
                <p>
                  {zh
                    ? props.collections?.length
                      ? `所选分组：${props.collections.join(", ")}`
                      : "不隐式扩展筛选结果"
                    : selection.collectionSummary}
                </p>
                <p>
                  {zh
                    ? "仅同步匹配的 Store 资源；发现的配置须先导入。"
                    : "Syncs matching Store resources. Discovered resources must be imported first."}
                </p>
              </div>
            </div>

            <fieldset className="segmented sync-destination" disabled={applying}>
              <legend className="visually-hidden">{zh ? "目标位置" : "Destination"}</legend>
              {(["user", "project"] as Destination[]).map((item) => (
                <label className={destination === item ? "selected" : ""} key={item}>
                  <input
                    type="radio"
                    checked={destination === item}
                    onChange={() => {
                      setDestination(item);
                    }}
                  />
                  {zh ? (item === "user" ? "用户" : "项目") : destinationLabel(item)}
                </label>
              ))}
            </fieldset>

            {destination === "project" && (
              <label className="field-row stacked project-dir-row">
                <span>{zh ? "项目根目录" : "Project root"}</span>
                <input
                  className="dir-input"
                  type="text"
                  placeholder={zh ? "项目根目录绝对路径" : "Project root absolute path"}
                  disabled={applying}
                  value={dir}
                  onChange={(event) => {
                    setDir(event.target.value);
                  }}
                />
              </label>
            )}

            <details className="sync-agent-options">
              <summary>
                {zh ? "选择已注册 Agent 目标" : "Choose registered agent targets"} ·{" "}
                {request.agents.join(", ") || (zh ? "未选择" : "None")}
              </summary>
              <AgentPicker
                value={request.agents}
                onChange={(ids) => setAgents(ids.join(", "))}
                scope={destination === "project" ? "project" : "global"}
                dir={dir}
                kinds={kinds ?? []}
                disabled={applying}
              />
            </details>
            {props.presentation !== "page" && (
              <div className="button-row">
                <button
                  type="button"
                  className="action secondary"
                  disabled={!canPreview}
                  onClick={preview}
                >
                  {previewing ? (zh ? "正在预览…" : "Previewing...") : zh ? "预览" : "Preview"}
                </button>
                <button type="button" className="action" disabled={!canApply} onClick={applySync}>
                  {applying ? (zh ? "正在应用…" : "Applying...") : zh ? "应用" : "Apply"}
                </button>
              </div>
            )}

            {dirMissing && (
              <p className="warn">
                {zh
                  ? "项目同步需要项目根目录。"
                  : "Project-level sync requires a project root path."}
              </p>
            )}
            {!hasAgents && (
              <p className="warn">
                {zh ? "至少输入一个目标 Agent。" : "Enter at least one target agent."}
              </p>
            )}
            {error && (
              <section className="api-error compact">
                <strong>{zh ? "本地 API 错误" : "Local API error"}</strong>
                <p>{error}</p>
              </section>
            )}
            {plan && <SyncPlanTable plan={plan} zh={zh} />}
          </div>
          <aside className="sync-review-aside" aria-label={zh ? "审查摘要" : "Review summary"}>
            <h3>{zh ? "审查摘要" : "Review summary"}</h3>
            <dl className="review-facts">
              <div>
                <dt>Agent</dt>
                <dd>{request.agents.join(", ") || (zh ? "未选择" : "Not selected")}</dd>
              </div>
              <div>
                <dt>{zh ? "范围" : "Scope"}</dt>
                <dd>
                  {destination === "project"
                    ? zh
                      ? "当前工程"
                      : "Project"
                    : zh
                      ? "用户范围"
                      : "User"}
                </dd>
              </div>
              {destination === "project" && (
                <div>
                  <dt>{zh ? "工程目录" : "Project root"}</dt>
                  <dd className="mono">{dir || (zh ? "未填写" : "Missing")}</dd>
                </div>
              )}
              <div>
                <dt>{zh ? "选择" : "Selection"}</dt>
                <dd className="mono">
                  {props.resourceIds?.length
                    ? props.resourceIds.join(", ")
                    : props.collections?.length
                      ? `${zh ? "分组" : "Group"}: ${props.collections.join(", ")}`
                      : zh
                        ? "Store 默认选择"
                        : "Store defaults"}
                </dd>
              </div>
              <div>
                <dt>{zh ? "计划版本" : "Plan revision"}</dt>
                <dd>
                  {mutationPlan
                    ? `Store r${mutationPlan.baseRevision}`
                    : zh
                      ? "预览后显示"
                      : "Shown after preview"}
                </dd>
              </div>
            </dl>
            {plan && (
              <>
                <div className="review-aside-section">
                  <h4>{zh ? "文件操作" : "File actions"}</h4>
                  <p>
                    {zh ? "写入" : "Writes"}{" "}
                    {plan.actions.filter((action) => action.op !== "skip").length} ·{" "}
                    {zh ? "跳过" : "Skips"}{" "}
                    {plan.actions.filter((action) => action.op === "skip").length} ·{" "}
                    {zh ? "冲突" : "Conflicts"} {plan.conflicts?.length ?? 0}
                  </p>
                </div>
                {plan.actions.some(isSharedTarget) && (
                  <div className="review-aside-section">
                    <h4>{zh ? "共享目标影响" : "Shared targets"}</h4>
                    {plan.actions.filter(isSharedTarget).map((action) => (
                      <p className="mono" key={`${action.target}:${action.agent}`}>
                        {action.target} · {action.consumerAgents?.join(", ")}
                      </p>
                    ))}
                  </div>
                )}
                <div className="review-aside-section">
                  <h4>{zh ? "确认前" : "Before confirmation"}</h4>
                  <p>
                    {zh
                      ? "确认后只提交当前审查过的原始计划。应用后仍需单独验证文件状态与原生 Agent 加载。"
                      : "Confirmation submits this reviewed plan. Verify files and native loading separately."}
                  </p>
                </div>
              </>
            )}
            <div className="review-aside-actions">
              <button
                type="button"
                className="action secondary"
                disabled={!canPreview}
                onClick={preview}
              >
                {mutationPlan ? (zh ? "重新预览" : "Preview again") : zh ? "预览计划" : "Preview"}
              </button>
              <button type="button" className="action" disabled={!canApply} onClick={applySync}>
                {applying
                  ? zh
                    ? "正在应用…"
                    : "Applying..."
                  : zh
                    ? "确认并应用当前计划"
                    : "Confirm and apply current plan"}
              </button>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function SyncPlanTable(props: { plan: DistributePlan; zh: boolean }) {
  return (
    <section className="sync-plan">
      <div className="sync-metrics">
        <div>
          <strong>{props.plan.actions.filter((action) => action.op !== "skip").length}</strong>
          <span>{props.zh ? "将写入" : "Writes"}</span>
        </div>
        <div>
          <strong>{props.plan.actions.filter((action) => action.op === "skip").length}</strong>
          <span>{props.zh ? "跳过" : "Skips"}</span>
        </div>
        <div>
          <strong>{props.plan.conflicts?.length ?? 0}</strong>
          <span>{props.zh ? "冲突" : "Conflicts"}</span>
        </div>
        <div>
          <strong>{props.plan.actions.filter(isSharedTarget).length}</strong>
          <span>{props.zh ? "共享目标" : "Shared targets"}</span>
        </div>
      </div>
      <div className="section-header">
        <h3>{props.zh ? "文件级变更计划" : "File action plan"}</h3>
        <span className="tag neutral">
          {props.plan.actions.length} {props.zh ? "项操作" : "actions"}
        </span>
      </div>
      {props.plan.actions.length === 0 ? (
        <p className="empty-state">
          {props.zh ? "本次选择无需同步操作。" : "No sync actions are needed for this selection."}
        </p>
      ) : (
        <div className="table-wrap resource-table-wrap">
          <table className="resource-table sync-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>{props.zh ? "资源" : "Resource"}</th>
                <th>{props.zh ? "操作" : "Operation"}</th>
                <th>{props.zh ? "目标" : "Target"}</th>
                <th>{props.zh ? "原因" : "Reason"}</th>
              </tr>
            </thead>
            <tbody>
              {props.plan.actions.map((action) => (
                <tr
                  key={`${action.agent}:${action.capability}:${action.artifact}:${action.target}`}
                >
                  <td className="mono">{action.agent}</td>
                  <td>
                    <strong>{resourceKindLabel(action.capability)}</strong>
                    <span className="muted-row mono">{action.artifact}</span>
                  </td>
                  <td>
                    <span className={action.op === "skip" ? "tag amber" : "tag blue"}>
                      {action.op}
                    </span>
                  </td>
                  <td className="path-cell mono">
                    {action.target}
                    {action.preview && (
                      <details className="action-diff">
                        <summary>{props.zh ? "查看差异" : "Inspect difference"}</summary>
                        <div className="diff-columns">
                          <div>
                            <strong>{props.zh ? "当前" : "Before"}</strong>
                            <pre>{action.preview.before ?? (props.zh ? "无文件" : "No file")}</pre>
                          </div>
                          <div>
                            <strong>{props.zh ? "计划写入" : "After"}</strong>
                            <pre>{action.preview.after ?? (props.zh ? "无文件" : "No file")}</pre>
                          </div>
                        </div>
                      </details>
                    )}
                  </td>
                  <td>
                    {action.reason ?? (props.zh ? "可执行" : "Ready")}
                    {action.ownership && (
                      <span className="muted-row">
                        {props.zh ? "归属" : "Ownership"}: {action.ownership.classification}
                      </span>
                    )}
                    {action.replacement && (
                      <span className="muted-row">
                        {props.zh
                          ? "替换目标需要明确的 Core 确认与快照。"
                          : "Target replacement needs an explicit Core acknowledgement and snapshot."}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.plan.warnings.length > 0 && (
        <div className="warning-list compact">
          {props.plan.warnings.map((warning) => (
            <p className="warn" key={warning}>
              {warning}
            </p>
          ))}
        </div>
      )}
      {props.plan.conflicts?.map((conflict) => (
        <p className="warn" key={`${conflict.code}:${conflict.target}`}>
          {conflict.code}: {conflict.message} · {conflict.target}
        </p>
      ))}
      {props.plan.invalidLedger && (
        <p className="warn">
          {props.zh
            ? "目标归属证据不可用。请先处理账本阻断，再应用。"
            : "Target ownership evidence is unavailable. Resolve the ledger blocker before applying."}
        </p>
      )}
      {props.plan.secretFindings?.map((finding) => (
        <p className="warn" key={`${finding.artifact}:${finding.rule}:${finding.line}`}>
          {props.zh ? "密钥保护阻断" : "Secret guard blocked"} {finding.artifact}{" "}
          {props.zh ? "第" : "at line"} {finding.line} {props.zh ? "行" : ""} ({finding.rule}).
        </p>
      ))}
      {props.plan.secretReferenceFindings?.map((finding) => (
        <p className="warn" key={`${finding.provider}:${finding.reference}`}>
          {props.zh ? "密钥引用" : "Secret reference"} {finding.reference}{" "}
          {props.zh ? "状态" : "is"} {finding.status} {props.zh ? "提供方" : "in"}{" "}
          {finding.provider}.
        </p>
      ))}
      {props.plan.actions.filter(isSharedTarget).map((action) => (
        <p className="muted" key={`${action.agent}:${action.target}:consumers`}>
          {props.zh ? "共享目标" : "Shared target"} {action.target}:{" "}
          {props.zh ? "使用方" : "consumers"} {action.consumerAgents?.join(", ")}.
        </p>
      ))}
    </section>
  );
}
