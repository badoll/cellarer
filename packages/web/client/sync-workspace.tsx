import type { ControlPlaneResourceListDto } from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { storedResources } from "./library-model.js";
import { ProfilesPage } from "./profiles-page.js";
import { SyncDialog } from "./sync-dialog.js";
import { browserWorkbenchLocale, workbenchLabels } from "./workbench-labels.js";

type SyncIntent = "none" | "ids" | "group" | "profile" | "defaults";

export function SyncWorkspace({ onApplied }: { onApplied(): void }) {
  const labels = workbenchLabels(browserWorkbenchLocale());
  const zh = browserWorkbenchLocale() === "zh-CN";
  const [intent, setIntent] = useState<SyncIntent>("none");
  const [resources, setResources] = useState<ControlPlaneResourceListDto | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [group, setGroup] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([
      apiFetch("/api/v1/resources?includeDiscovered=false").then(
        readApiJson<ControlPlaneResourceListDto>,
      ),
      apiFetch("/api/v1/collections").then(readApiJson<{ collections: { name: string }[] }>),
    ])
      .then(([result, collectionList]) => {
        if (alive) {
          setResources(result);
          setGroups(collectionList.collections.map((item) => item.name).sort());
        }
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  const stored = storedResources(resources?.resources ?? []);
  const exactIds = [...new Set(ids)]
    .filter((id) => stored.some((resource) => resource.id === id))
    .sort();
  const ready =
    intent === "defaults" ||
    (intent === "ids" && exactIds.length > 0) ||
    (intent === "group" && !!group);

  return (
    <div className="page-stack">
      <section className="panel workflow-panel">
        <h3>{zh ? "选择要同步的配置" : "Choose configuration to sync"}</h3>
        <p>
          {zh
            ? "先明确选择资源意图，再审阅目标 Agent、位置、项目根目录与 Core 计划。"
            : "Pick one explicit intent. The target Agent, destination, project root, and Core plan are reviewed next."}
        </p>
        <fieldset className="library-kind-tabs">
          <legend>{zh ? "资源意图" : "Resource intent"}</legend>
          {(["ids", "group", "profile", "defaults"] as const).map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={intent === item}
              onClick={() => {
                setIntent(item);
                setOpen(false);
              }}
            >
              {labels.intent[item]}
            </button>
          ))}
        </fieldset>
        {intent === "ids" && (
          <fieldset>
            <legend>{zh ? "精确 Store 配置" : "Exact stored configuration"}</legend>
            {stored.map((resource) => (
              <label className="field-row" key={resource.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(resource.id)}
                  onChange={() =>
                    setIds((current) =>
                      current.includes(resource.id)
                        ? current.filter((id) => id !== resource.id)
                        : [...current, resource.id],
                    )
                  }
                />
                {resource.kind} · {resource.id}
              </label>
            ))}
            {stored.length === 0 && (
              <p>{zh ? "Store 中尚无配置。" : "No stored configuration is available yet."}</p>
            )}
          </fieldset>
        )}
        {intent === "group" && (
          <label className="field-row stacked">
            <span>{labels.intent.group}</span>
            <select value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value="">{zh ? "选择分组" : "Choose a group"}</option>
              {groups.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        )}
        {intent === "profile" && (
          <p>
            {zh
              ? "下方的配置方案协调使用独立 Core 合同。"
              : "Profile reconciliation uses its separate Core contract below."}
          </p>
        )}
        {intent !== "profile" && (
          <button type="button" className="action" disabled={!ready} onClick={() => setOpen(true)}>
            {zh ? "选择目标并预览" : "Choose target and preview"}
          </button>
        )}
        {error && (
          <p role="alert" className="api-error">
            {error}
          </p>
        )}
      </section>
      {intent === "profile" && <ProfilesPage />}
      <SyncDialog
        open={open && ready}
        resourceIds={intent === "ids" ? exactIds : undefined}
        collections={intent === "group" ? [group] : undefined}
        onClose={() => setOpen(false)}
        onApplied={() => {
          setOpen(false);
          onApplied();
        }}
      />
    </div>
  );
}
