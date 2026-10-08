import type {
  Capability,
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
} from "@cellarer/core/client-api";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { BundleImport } from "./bundle-import.js";
import {
  filterLibrary,
  type LibraryFilters,
  librarySelection,
  storedResources,
} from "./library-model.js";
import type { Page } from "./product-model.js";
import { CollectionEditor, ResourceWorkflows } from "./resource-workflows.js";
import { SyncDialog } from "./sync-dialog.js";
import { browserWorkbenchLocale, workbenchLabels } from "./workbench-labels.js";

const KINDS: readonly (Capability | "all")[] = ["all", "skills", "mcp", "rules"];

export function LibraryPage({
  onNavigate,
  initialDetailId,
}: {
  onNavigate(page: Page): void;
  initialDetailId?: string;
}) {
  const labels = workbenchLabels(browserWorkbenchLocale());
  const zh = browserWorkbenchLocale() === "zh-CN";
  const [data, setData] = useState<ControlPlaneResourceListDto | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>({ kind: "all", query: "", group: "" });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(initialDetailId ?? null);
  const [showGroups, setShowGroups] = useState(false);
  const [showBundleImport, setShowBundleImport] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    apiFetch("/api/v1/resources?includeDiscovered=false")
      .then(readApiJson<ControlPlaneResourceListDto>)
      .then((result) => {
        if (alive) {
          setData(result);
          setError("");
        }
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  const resources = data?.resources ?? [];
  const stored = useMemo(() => storedResources(resources), [resources]);
  const visible = useMemo(() => filterLibrary(resources, filters), [resources, filters]);
  const selection = useMemo(
    () => librarySelection(resources, visible, selectedIds),
    [resources, visible, selectedIds],
  );
  const detail = stored.find((resource) => resource.id === detailId) ?? stored[0] ?? null;
  const groups = [...new Set(stored.flatMap((resource) => resource.membership.collections))].sort();

  return (
    <div className="page-stack">
      <section className="panel library-toolbar">
        <div className="resource-actions">
          <button
            type="button"
            className="action secondary"
            onClick={() => onNavigate("inventory")}
          >
            {labels.actions.find}
          </button>
          <button
            type="button"
            className="action secondary"
            onClick={() => setShowBundleImport((value) => !value)}
          >
            {labels.actions.add}
          </button>
          <button
            type="button"
            className="action secondary"
            onClick={() => setShowGroups((value) => !value)}
          >
            {labels.intent.group}
          </button>
          <button
            type="button"
            className="action"
            disabled={selection.exactIds.length === 0}
            onClick={() => setSyncOpen(true)}
          >
            {labels.actions.sync}
          </button>
        </div>
        <search className="resource-actions">
          <label className="field-row stacked">
            <span>{zh ? "搜索" : "Search"}</span>
            <input
              type="search"
              value={filters.query}
              onChange={(event) =>
                setFilters((current) => ({ ...current, query: event.target.value }))
              }
              placeholder={zh ? "名称、来源或 ID" : "Name, source, or ID"}
            />
          </label>
          <label className="field-row stacked">
            <span>{labels.intent.group}</span>
            <select
              value={filters.group}
              onChange={(event) =>
                setFilters((current) => ({ ...current, group: event.target.value }))
              }
            >
              <option value="">{zh ? "全部分组" : "All groups"}</option>
              {groups.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </label>
        </search>
        <fieldset className="library-kind-tabs">
          <legend>{zh ? "配置类型" : "Configuration type"}</legend>
          {KINDS.map((kind) => (
            <button
              type="button"
              key={kind}
              aria-pressed={filters.kind === kind}
              onClick={() => setFilters((current) => ({ ...current, kind }))}
            >
              {kind === "all"
                ? zh
                  ? "全部"
                  : "All"
                : kind === "skills"
                  ? "Skills"
                  : kind === "mcp"
                    ? "MCP"
                    : "Rules"}
            </button>
          ))}
        </fieldset>
        <p role="status">
          {zh
            ? `已选 ${selection.exactIds.length} 项 · 筛选隐藏 ${selection.hiddenIds.length} 项`
            : `${selection.exactIds.length} selected · ${selection.hiddenIds.length} hidden by filters`}
        </p>
        {selection.exactIds.length > 0 && (
          <button type="button" onClick={() => setSelectedIds([])}>
            {zh ? "清除选择" : "Clear selection"}
          </button>
        )}
      </section>
      {error && (
        <p role="alert" className="api-error">
          {error}
        </p>
      )}
      {!data && !error && (
        <p className="empty-state">
          {zh ? "正在加载 Store 配置…" : "Loading stored configuration..."}
        </p>
      )}
      {data && stored.length === 0 && (
        <section className="panel empty-state">
          <h3>{zh ? "Store 中还没有配置" : "No configuration in Store"}</h3>
          <p>
            {zh
              ? "先查找已有本地配置，审阅精确导入，再单独同步目标。"
              : "Find existing local configuration, then review an exact import before syncing a target."}
          </p>
          <button type="button" className="action" onClick={() => onNavigate("inventory")}>
            {labels.actions.find}
          </button>
          <button
            type="button"
            className="action secondary"
            onClick={() => setShowBundleImport(true)}
          >
            {labels.actions.add}
          </button>
        </section>
      )}
      {data && stored.length > 0 && (
        <div className="library-layout">
          <section className="panel" aria-label={zh ? "Store 配置" : "Stored configuration"}>
            {visible.length === 0 ? (
              <p className="empty-state">
                {zh ? "没有匹配的 Store 配置。" : "No matching stored configuration."}
              </p>
            ) : (
              <div>
                <p className="table-scroll-hint">
                  {zh ? "横向滚动查看全部列" : "Scroll horizontally to see all columns"}
                </p>
                <section
                  className="table-wrap"
                  aria-label={
                    zh ? "配置列表，可横向滚动" : "Configuration list, horizontally scrollable"
                  }
                >
                  <table className="resource-table library-table">
                    <thead>
                      <tr>
                        <th>{zh ? "名称" : "Name"}</th>
                        <th>{zh ? "类型" : "Type"}</th>
                        <th>ID</th>
                        <th>{zh ? "来源" : "Source"}</th>
                        <th>{zh ? "Store 版本" : "Store revision"}</th>
                        <th>{zh ? "状态" : "State"}</th>
                        <th>{zh ? "操作" : "Action"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((resource) => (
                        <tr key={resource.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`${zh ? "选择" : "Select"} ${resource.id}`}
                              checked={selection.exactIds.includes(resource.id)}
                              onChange={() =>
                                setSelectedIds((ids) =>
                                  ids.includes(resource.id)
                                    ? ids.filter((id) => id !== resource.id)
                                    : [...ids, resource.id],
                                )
                              }
                            />
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => setDetailId(resource.id)}
                            >
                              {resource.name}
                            </button>
                          </td>
                          <td>
                            <span
                              className={`tag ${resource.kind === "skills" ? "blue" : resource.kind === "mcp" ? "neutral" : "amber"}`}
                            >
                              {resource.kind === "skills"
                                ? "Skills"
                                : resource.kind === "mcp"
                                  ? "MCP"
                                  : "Rules"}
                            </span>
                          </td>
                          <td className="mono">{resource.id}</td>
                          <td>{resource.source}</td>
                          <td>{resource.currentRevision?.id ?? labels.status.unknown}</td>
                          <td>
                            <span
                              className={`tag ${resource.validation.status === "invalid" ? "red" : resource.usage.applied.length ? "green" : "blue"}`}
                            >
                              {resource.validation.status === "invalid"
                                ? zh
                                  ? "需关注"
                                  : "Needs attention"
                                : resource.usage.applied.length
                                  ? zh
                                    ? "已入库 · 有目标"
                                    : "Stored · used"
                                  : zh
                                    ? "已入库 · 未观察到目标"
                                    : "Stored · no target observed"}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => setDetailId(resource.id)}
                            >
                              {zh ? "详情" : "Details"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              </div>
            )}
          </section>
          {detail && (
            <LibraryDetail
              resource={detail}
              zh={zh}
              onChanged={() => setReload((value) => value + 1)}
            />
          )}
        </div>
      )}
      {showGroups && <CollectionEditor onChanged={() => setReload((value) => value + 1)} />}
      {showBundleImport && <BundleImport onImported={() => setReload((value) => value + 1)} />}
      <SyncDialog
        open={syncOpen}
        resourceIds={selection.exactIds}
        onClose={() => setSyncOpen(false)}
        onApplied={() => {
          setSyncOpen(false);
          setReload((value) => value + 1);
        }}
      />
    </div>
  );
}

function LibraryDetail({
  resource,
  zh,
  onChanged,
}: {
  resource: ControlPlaneResourceDto;
  zh: boolean;
  onChanged(): void;
}) {
  return (
    <section
      className="panel library-detail"
      aria-label={zh ? "配置详情" : "Configuration details"}
    >
      <h3>{resource.name}</h3>
      <p>
        {zh
          ? "Store 中的精确资源及当前使用证据"
          : "Exact stored resource and current usage evidence"}
      </p>
      <dl>
        <dt>ID</dt>
        <dd className="mono">{resource.id}</dd>
        <dt>{zh ? "类型" : "Type"}</dt>
        <dd>{resource.kind}</dd>
        <dt>{zh ? "来源" : "Source"}</dt>
        <dd>{resource.source}</dd>
        <dt>{zh ? "Store 版本" : "Store revision"}</dt>
        <dd>{resource.currentRevision?.id ?? (zh ? "未知" : "Unknown")}</dd>
        <dt>{zh ? "分组" : "Groups"}</dt>
        <dd>{resource.membership.collections.join(", ") || (zh ? "默认" : "Default")}</dd>
        <dt>{zh ? "密钥引用" : "Secret references"}</dt>
        <dd>{resource.secretReferenceNames.join(", ") || (zh ? "无" : "None")}</dd>
        <dt>{zh ? "目标使用情况" : "Target usage"}</dt>
        <dd>
          {resource.usage.applied.length === 0
            ? zh
              ? "未观察到目标使用"
              : "No observed target usage"
            : resource.usage.applied.map((target) => (
                <p key={`${target.agent}:${target.target}`}>
                  {target.agent} · {target.destination}/{target.scope} · {target.state}
                  {target.reason ? ` · ${target.reason}` : ""}
                </p>
              ))}
        </dd>
      </dl>
      <p className="library-detail-note">
        {zh
          ? "Store 记录与目标文件、原生 Agent 加载分别验证。"
          : "Store, target files, and native loading require separate checks."}
      </p>
      <ResourceWorkflows key={resource.id} resource={resource} onChanged={onChanged} />
    </section>
  );
}
