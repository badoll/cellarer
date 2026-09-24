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
  syncRequestKey,
} from "./sync-selection.js";
import { browserWorkbenchLocale } from "./workbench-labels.js";

export { buildSyncRequest, isProjectDirMissing, syncRequestKey } from "./sync-selection.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SyncDialog(props: {
  open: boolean;
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

  const selection = buildSyncSelection({
    agents,
    destination,
    dir,
    kinds: props.kinds,
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
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal sync-modal"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? "同步到 Agent" : "Sync to Agents"}
      >
        <div className="panel-header modal-header">
          <div>
            <h3>{zh ? "同步到 Agent" : "Sync to Agents"}</h3>
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

        <AgentPicker
          value={request.agents}
          onChange={(ids) => setAgents(ids.join(", "))}
          scope={destination === "project" ? "project" : "global"}
          dir={dir}
          kinds={props.kinds ?? ["rules", "mcp", "skills"]}
          disabled={applying}
        />
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

        {dirMissing && (
          <p className="warn">
            {zh ? "项目同步需要项目根目录。" : "Project-level sync requires a project root path."}
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
      </section>
    </div>
  );
}

function SyncPlanTable(props: { plan: DistributePlan; zh: boolean }) {
  return (
    <section className="sync-plan">
      <div className="section-header">
        <h3>{props.zh ? "计划预览" : "Preview"}</h3>
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
                  <td className="path-cell mono">{action.target}</td>
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
      {props.plan.actions
        .filter((action) => action.consumerAgents?.length)
        .map((action) => (
          <p className="muted" key={`${action.agent}:${action.target}:consumers`}>
            {props.zh ? "共享目标" : "Shared target"} {action.target}:{" "}
            {props.zh ? "使用方" : "consumers"} {action.consumerAgents?.join(", ")}.
          </p>
        ))}
    </section>
  );
}
