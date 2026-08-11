import type {
  Capability,
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
} from "@cellarer/core/client-api";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { DashboardIcon } from "./dashboard-icons.js";
import { ImportDialog } from "./import-dialog.js";
import {
  destinationLabel,
  type ResourceState,
  resourceKindLabel,
  summarizeResourceCounts,
} from "./product-model.js";
import { SyncDialog } from "./sync-dialog.js";

interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const RESOURCE_STATE_LABELS: Record<ResourceState, string> = {
  managed: "Managed",
  discovered: "Discovered",
  synced: "Synced",
  drifted: "Drifted",
  missing: "Missing",
  blocked: "Blocked",
};

const RESOURCE_STATE_TONES: Record<ResourceState, "green" | "blue" | "amber" | "red" | "neutral"> =
  {
    managed: "green",
    discovered: "blue",
    synced: "green",
    drifted: "amber",
    missing: "red",
    blocked: "amber",
  };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ResourcePage(props: { kind: Capability }) {
  const [state, setState] = useState<ApiState<ControlPlaneResourceListDto>>({
    data: null,
    error: null,
    loading: true,
  });
  const [collection, setCollection] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const title = resourceKindLabel(props.kind);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    if (collection.trim()) params.set("collections", collection.trim());

    setState((current) => ({ ...current, error: null, loading: true }));
    apiFetch(`/api/v1/resources/${props.kind}?${params.toString()}`)
      .then((response) => readApiJson<ControlPlaneResourceListDto>(response))
      .then((data) => {
        if (alive) setState({ data, error: null, loading: false });
      })
      .catch((err) => {
        if (alive) setState({ data: null, error: errorMessage(err), loading: false });
      });

    return () => {
      alive = false;
    };
  }, [props.kind, collection, reloadKey]);

  const counts =
    state.data?.counts ?? (state.data ? summarizeResourceCounts(state.data.resources) : null);
  const collections = useMemo(() => {
    const names = new Set<string>();
    for (const resource of state.data?.resources ?? []) {
      for (const item of resource.membership.collections) names.add(item);
    }
    return [...names].sort();
  }, [state.data]);

  return (
    <div className="page-stack">
      <section className="resource-toolbar">
        <div className="resource-toolbar-main">
          <div className="resource-title-block">
            <p className="eyebrow">Library resources</p>
            <h3>{title}</h3>
            <p>
              {state.data
                ? `${state.data.resources.length} resources generated at ${formatTime(state.data.generatedAt)}`
                : `Loading ${title.toLowerCase()} resources`}
            </p>
          </div>
          <div className="resource-actions">
            <label className="field-row stacked resource-filter">
              <span>Collection</span>
              <input
                type="text"
                value={collection}
                list={`${props.kind}-collections`}
                placeholder="Any collection"
                onChange={(event) => setCollection(event.target.value)}
              />
              <datalist id={`${props.kind}-collections`}>
                {collections.map((item) => (
                  <option value={item} key={item} />
                ))}
              </datalist>
            </label>
            <button type="button" className="action" onClick={() => setImportOpen(true)}>
              <DashboardIcon name="scan" />
              Import existing setup
            </button>
            <button type="button" className="action" onClick={() => setSyncOpen(true)}>
              <DashboardIcon name="apply" />
              Sync to Agents
            </button>
          </div>
        </div>
        <ResourceCountGrid counts={counts} compact />
      </section>

      {state.error && (
        <section className="api-error">
          <strong>Local API error</strong>
          <p>{state.error}</p>
        </section>
      )}
      {state.loading && !state.data ? (
        <p className="empty-state">Loading {title.toLowerCase()} resources...</p>
      ) : state.data?.resources.length === 0 ? (
        <p className="empty-state">No resources in this view.</p>
      ) : state.data ? (
        <ResourceTable resources={state.data.resources} />
      ) : null}
      {state.data && state.data.warnings.length > 0 && (
        <WarningList warnings={state.data.warnings} />
      )}

      <ImportDialog
        open={importOpen}
        kind={props.kind}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          setReloadKey((value) => value + 1);
        }}
      />
      <SyncDialog
        open={syncOpen}
        kinds={[props.kind]}
        onClose={() => setSyncOpen(false)}
        onApplied={() => {
          setSyncOpen(false);
          setReloadKey((value) => value + 1);
        }}
      />
    </div>
  );
}

function ResourceTable(props: { resources: readonly ControlPlaneResourceDto[] }) {
  return (
    <div className="table-wrap resource-table-wrap">
      <table className="resource-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>State</th>
            <th>Collections</th>
            <th>Source</th>
            <th>Sync targets</th>
            <th>Secret refs</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {props.resources.map((resource) => (
            <ResourceRow resource={resource} key={resource.id} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResourceRow(props: { resource: ControlPlaneResourceDto }) {
  return (
    <tr>
      <td>
        <strong>{props.resource.name}</strong>
        <span className="muted-row mono">
          {props.resource.discovered
            ? `${props.resource.discovered.agent} · not imported`
            : props.resource.id}
        </span>
      </td>
      <td>
        <ResourceStateBadge state={props.resource.state} />
      </td>
      <td>
        {props.resource.discovered ? (
          <span className="tag neutral">not imported</span>
        ) : props.resource.membership.collections.length === 0 ? (
          <span className="muted">default</span>
        ) : (
          props.resource.membership.collections.map((item) => (
            <span className="tag blue" key={item}>
              {item}
            </span>
          ))
        )}
      </td>
      <td className="path-cell mono">{resourceSource(props.resource)}</td>
      <td>
        {props.resource.usage.applied.length === 0 ? (
          <span className="muted">{props.resource.discovered ? "import first" : "none"}</span>
        ) : (
          <div className="table-chip-list">
            {props.resource.usage.applied.map((target) => (
              <span
                className={`tag ${RESOURCE_STATE_TONES[target.state]} sync-target-chip`}
                title={target.target}
                key={`${target.agent}:${target.destination}:${target.target}`}
              >
                {target.agent} {destinationLabel(target.destination)}{" "}
                {RESOURCE_STATE_LABELS[target.state]}
              </span>
            ))}
          </div>
        )}
      </td>
      <td>
        {props.resource.secretReferenceNames.length === 0 ? (
          <span className="muted">none</span>
        ) : (
          props.resource.secretReferenceNames.map((ref) => (
            <span className="tag amber mono" key={ref}>
              {ref}
            </span>
          ))
        )}
      </td>
      <td>
        {props.resource.lastActivityAt
          ? formatTime(props.resource.lastActivityAt)
          : props.resource.discovered
            ? "not imported"
            : "none"}
      </td>
    </tr>
  );
}

function ResourceCountGrid(props: {
  counts: Record<ResourceState, number> | null;
  compact?: boolean;
}) {
  return (
    <div className={props.compact ? "resource-count-grid compact" : "resource-count-grid"}>
      {Object.entries(RESOURCE_STATE_LABELS).map(([state, label]) => (
        <div className="resource-count" key={state}>
          <span>{label}</span>
          <strong>{props.counts?.[state as ResourceState] ?? "..."}</strong>
        </div>
      ))}
    </div>
  );
}

function ResourceStateBadge(props: { state: ResourceState }) {
  return (
    <span className={`tag status-badge ${RESOURCE_STATE_TONES[props.state]}`}>
      {RESOURCE_STATE_LABELS[props.state]}
    </span>
  );
}

function WarningList(props: { warnings: readonly string[] }) {
  if (props.warnings.length === 0) return null;
  return (
    <section className="warning-list">
      {props.warnings.map((warning) => (
        <p className="warn" key={warning}>
          {warning}
        </p>
      ))}
    </section>
  );
}

function resourceSource(resource: ControlPlaneResourceDto): string {
  return resource.source;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
