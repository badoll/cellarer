import type {
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
} from "@cellarer/core/client-api";
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

type ResourceInspection =
  | {
      kind: "dependencies";
      report: {
        collections: readonly { collectionId: string }[];
        profiles: readonly { profileId: string }[];
        desiredSelections: readonly { collectionId: string }[];
        ownedTargets: readonly { agent: string; scope: string; target: string }[];
      };
    }
  | {
      kind: "update";
      check: {
        status: "uncheckable" | "current" | "update-available";
        currentRevisionId: string;
        checkedAt?: string;
      };
    };

export function ResourceWorkflows({
  resource,
  onChanged,
}: {
  resource: ControlPlaneResourceDto;
  onChanged(message: string): void;
}) {
  const zh = browserWorkbenchLocale() === "zh-CN";
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [evidence, setEvidence] = useState<ResourceInspection | null>(null);
  const inspectionGeneration = useRef(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const resourceId = resource.id;
  const input = { resourceId };
  async function inspect(kind: "dependencies" | "update/check") {
    const token = ++inspectionGeneration.current;
    setError("");
    setEvidence(null);
    try {
      if (kind === "dependencies") {
        const report = await workflowPost<
          Extract<ResourceInspection, { kind: "dependencies" }>["report"]
        >("/api/v1/resources/dependencies", input);
        if (token === inspectionGeneration.current) setEvidence({ kind: "dependencies", report });
      } else {
        const check = await workflowPost<Extract<ResourceInspection, { kind: "update" }>["check"]>(
          "/api/v1/resources/update/check",
          input,
        );
        if (token === inspectionGeneration.current) setEvidence({ kind: "update", check });
      }
    } catch (error) {
      if (token === inspectionGeneration.current) setError(workflowError(error));
    }
  }
  if (resource.discovered)
    return (
      <p>
        {zh
          ? "先从 Inventory 导入，再管理该资源。"
          : "Import from Inventory before managing this resource."}
      </p>
    );
  return (
    <section>
      <div className="button-row">
        <button type="button" onClick={() => inspect("dependencies")}>
          {zh ? "查看依赖" : "Show dependencies"}
        </button>
        <button type="button" onClick={() => inspect("update/check")}>
          {zh ? "检查来源更新" : "Check source update"}
        </button>
        <button
          type="button"
          onClick={() =>
            setAction({
              title: zh ? "更新 Store 资源" : "Update Store resource",
              description: zh
                ? `暂存并审阅 ${resourceId} 的来源更新；Agent 目标保持不变。`
                : `Stage and review a source update for ${resourceId}. Agent targets stay unchanged.`,
              planPath: "/api/v1/resources/update/plan",
              applyPath: "/api/v1/resources/update/apply",
              input,
              success: zh
                ? "Store 更新完成。目标可能待同步，请单独预览协调。"
                : "Store update completed. Deployments may be pending; preview reconciliation separately.",
            })
          }
        >
          {zh ? "预览来源更新" : "Preview source update"}
        </button>
        <button
          type="button"
          onClick={() =>
            setAction({
              title: zh ? "从 Store 移除" : "Remove from Store",
              description: zh
                ? `仅移除 ${resourceId}。被引用资源会阻断；不会级联删除、卸载目标或回滚历史。`
                : `Remove only ${resourceId}. Referenced resources are blocked. No cascade, target uninstall or historical revert.`,
              planPath: "/api/v1/resources/remove/plan",
              applyPath: "/api/v1/resources/remove/apply",
              input: { ...input, cascade: false },
              applyInput: { ...input, cascade: false },
              success: zh
                ? "已从 Store 移除资源；未卸载任何目标。"
                : "Resource removed from Store. No target was uninstalled.",
            })
          }
        >
          {zh ? "从 Store 移除" : "Remove from Store"}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="api-error">
          {error}
        </p>
      )}
      {evidence?.kind === "update" && (
        <section role="status" className="panel">
          <strong>
            {evidence.check.status === "update-available"
              ? zh
                ? "可更新"
                : "Update available"
              : evidence.check.status === "current"
                ? zh
                  ? "来源版本未变化"
                  : "Source is current"
                : zh
                  ? "无法检查来源更新"
                  : "Source update cannot be checked"}
          </strong>
          <p>
            {zh ? "当前 Store 版本" : "Current Store revision"}: {evidence.check.currentRevisionId}
          </p>
          {evidence.check.checkedAt && (
            <p>
              {zh ? "检查时间" : "Checked at"}: {evidence.check.checkedAt}
            </p>
          )}
          <p>
            {zh
              ? "来源更新与目标同步是不同操作。"
              : "A source update is separate from target sync."}
          </p>
        </section>
      )}
      {evidence?.kind === "dependencies" && (
        <section role="status" className="panel">
          <strong>{zh ? "依赖证据" : "Dependency evidence"}</strong>
          <p>
            {zh ? "分组" : "Groups"}:{" "}
            {evidence.report.collections.map((item) => item.collectionId).join(", ") ||
              (zh ? "无" : "None")}
          </p>
          <p>
            {zh ? "配置方案" : "Profiles"}:{" "}
            {evidence.report.profiles.map((item) => item.profileId).join(", ") ||
              (zh ? "无" : "None")}
          </p>
          <p>
            {zh ? "默认选择" : "Default selections"}:{" "}
            {evidence.report.desiredSelections.map((item) => item.collectionId).join(", ") ||
              (zh ? "无" : "None")}
          </p>
          <p>
            {zh ? "受管目标" : "Owned targets"}: {evidence.report.ownedTargets.length}
          </p>
          {evidence.report.ownedTargets.map((item) => (
            <p key={`${item.agent}:${item.scope}:${item.target}`}>
              {item.agent}/{item.scope} · {item.target}
            </p>
          ))}
        </section>
      )}
      {action && (
        <WorkflowDialog
          action={action}
          onClose={() => setAction(null)}
          onApplied={(message) => {
            setAction(null);
            setMessage(message);
            onChanged(message);
          }}
        />
      )}
    </section>
  );
}

interface Collection {
  name: string;
  resourceIds: string[];
  description?: string;
}
export function CollectionEditor({ onChanged }: { onChanged?: () => void } = {}) {
  const zh = browserWorkbenchLocale() === "zh-CN";
  const [loading, setLoading] = useState(true);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [resources, setResources] = useState<readonly ControlPlaneResourceDto[]>([]);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setName("");
    setMembers([]);
    Promise.all([
      apiFetch("/api/v1/collections").then(readApiJson<{ collections: Collection[] }>),
      apiFetch("/api/v1/resources?includeDiscovered=false").then(
        readApiJson<ControlPlaneResourceListDto>,
      ),
    ])
      .then(([data, library]) => {
        if (!alive) return;
        setCollections(data.collections);
        setResources(library.resources);
        setLoading(false);
      })
      .catch((error) => {
        if (alive) {
          setError(workflowError(error));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [reload]);
  const existing = collections.find((collection) => collection.name === name);
  function plan() {
    setAction({
      title: existing
        ? zh
          ? "编辑分组成员"
          : "Edit Collection members"
        : zh
          ? "创建分组"
          : "Create Collection",
      description: existing
        ? zh
          ? `将 ${name} 的成员精确替换为 ${members.join(", ") || "无资源"}；目标保持不变。`
          : `Replace ${name} membership with exactly ${members.join(", ") || "no resources"}. Targets stay unchanged.`
        : zh
          ? `创建空分组 ${name}；再单独编辑成员。`
          : `Create the empty Collection ${name}; edit its members separately.`,
      planPath: "/api/v1/collections/plan",
      applyPath: "/api/v1/mutations/apply",
      input: existing
        ? { action: "set-members", collectionName: name, resourceIds: members }
        : { action: "create", collectionName: name, resourceIds: [] },
      success: zh
        ? "分组已保存。既有目标可能待同步；请单独预览配置方案协调。"
        : "Collection saved. Existing deployments may be pending; preview Profile reconciliation separately.",
    });
  }
  return (
    <section className="panel workflow-panel">
      <h3>{zh ? "分组" : "Collections"}</h3>
      <p>
        {zh
          ? "修改 Store 成员不会同步或卸载目标。"
          : "Store membership changes do not sync or uninstall targets."}
      </p>
      <label className="field-row stacked">
        <span>{zh ? "分组名称" : "Collection name"}</span>
        <input
          type="text"
          disabled={loading}
          list="workflow-collections"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setMembers(
              collections.find((collection) => collection.name === event.target.value)
                ?.resourceIds ?? [],
            );
          }}
        />
        <datalist id="workflow-collections">
          {collections.map((collection) => (
            <option key={collection.name} value={collection.name} />
          ))}
        </datalist>
      </label>
      {existing && (
        <fieldset>
          <legend>{zh ? "精确成员" : "Exact members"}</legend>
          {resources.map((resource) => (
            <label className="field-row" key={resource.id}>
              <input
                type="checkbox"
                checked={members.includes(resource.id)}
                onChange={() =>
                  setMembers((current) =>
                    current.includes(resource.id)
                      ? current.filter((id) => id !== resource.id)
                      : [...current, resource.id],
                  )
                }
              />
              {resource.id}
            </label>
          ))}
        </fieldset>
      )}
      <button className="action secondary" type="button" disabled={!name.trim()} onClick={plan}>
        {existing
          ? zh
            ? "审阅成员变更"
            : "Review membership"
          : zh
            ? "审阅新分组"
            : "Review new Collection"}
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {action && (
        <WorkflowDialog
          action={action}
          onClose={() => setAction(null)}
          onApplied={(message) => {
            setMessage(message);
            setAction(null);
            setLoading(true);
            setReload((value) => value + 1);
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}
