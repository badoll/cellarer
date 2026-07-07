import type { Capability, ScanItem, ScanPlan, ScanSelection } from "@cellarer/core";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { resourceKindLabel } from "./product-model.js";

interface ImportPayload {
  agent: string;
  destination: "user";
  capabilities?: Capability[];
  selectItems?: ScanSelection[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ImportDialog(props: {
  open: boolean;
  kind?: Capability;
  onClose(): void;
  onImported(): void;
}) {
  const [agent, setAgent] = useState("codex");
  const [plan, setPlan] = useState<ScanPlan | null>(null);
  const [plannedPayload, setPlannedPayload] = useState<ImportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const latestPayloadKey = useRef("");

  useEffect(() => {
    if (!props.open) return;
    setPlan(null);
    setPlannedPayload(null);
    setError(null);
  }, [props.open, props.kind]);

  if (!props.open) return null;

  const currentKind = props.kind ? resourceKindLabel(props.kind) : "All resources";
  const canPreview = agent.trim().length > 0 && !previewing && !applying;
  const canApply = canPreview && plan !== null && plannedPayload !== null;

  function payload(): ImportPayload {
    return {
      agent: agent.trim(),
      destination: "user",
      capabilities: props.kind ? [props.kind] : undefined,
    };
  }

  latestPayloadKey.current = JSON.stringify(payload());

  async function preview() {
    setError(null);
    setPreviewing(true);
    const request = payload();
    const requestKey = JSON.stringify(request);
    try {
      const response = await apiFetch("/api/import/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const nextPlan = await readApiJson<ScanPlan>(response);
      if (requestKey !== latestPayloadKey.current) return;
      setPlan(nextPlan);
      setPlannedPayload(request);
    } catch (err) {
      setPlan(null);
      setPlannedPayload(null);
      setError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function applyImport() {
    if (!plan || !plannedPayload) return;
    setError(null);
    setApplying(true);
    try {
      const response = await apiFetch("/api/import/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...plannedPayload,
          selectItems: selectItemsForPlan(plan),
        }),
      });
      await readApiJson<unknown>(response);
      props.onImported();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-label="Import existing setup">
        <div className="panel-header modal-header">
          <div>
            <h3>Import existing setup</h3>
            <p>
              Preview {currentKind.toLowerCase()} from an existing agent setup before adding it to
              the user library.
            </p>
          </div>
          <button type="button" className="link-button" onClick={props.onClose}>
            Close
          </button>
        </div>

        <div className="import-dialog-grid">
          <label className="field-row stacked">
            <span>Agent</span>
            <input
              type="text"
              value={agent}
              onChange={(event) => {
                setAgent(event.target.value);
                setPlan(null);
                setPlannedPayload(null);
              }}
            />
          </label>
          <div className="destination-summary">
            <span>Destination</span>
            <strong>User-level library</strong>
            <p>{currentKind}</p>
          </div>
        </div>

        <div className="button-row">
          <button type="button" className="action secondary" disabled={!canPreview} onClick={preview}>
            {previewing ? "Previewing..." : "Preview"}
          </button>
          <button type="button" className="action" disabled={!canApply} onClick={applyImport}>
            {applying ? "Importing..." : "Import"}
          </button>
        </div>

        {error && (
          <section className="api-error compact">
            <strong>Local API error</strong>
            <p>{error}</p>
          </section>
        )}

        {plan && <ImportPlanTable plan={plan} />}
      </section>
    </div>
  );
}

export function selectItemsForPlan(plan: ScanPlan): ScanSelection[] {
  return plan.items
    .filter((item) => item.action === "import")
    .map((item) => ({ kind: item.kind, name: item.name, source: item.source }));
}

function ImportPlanTable(props: { plan: ScanPlan }) {
  return (
    <section className="import-plan">
      <div className="section-header">
        <h3>Preview</h3>
        <span className="tag neutral">{props.plan.items.length} resources</span>
      </div>
      {props.plan.items.length === 0 ? (
        <p className="empty-state">No resources discovered for this import.</p>
      ) : (
        <div className="table-wrap resource-table-wrap">
          <table className="resource-table import-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Status</th>
                <th>Action</th>
                <th>Source</th>
                <th>Secret refs</th>
              </tr>
            </thead>
            <tbody>
              {props.plan.items.map((item) => (
                <ImportPlanRow item={item} key={`${item.kind}:${item.name}:${item.source}`} />
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
    </section>
  );
}

function ImportPlanRow(props: { item: ScanItem }) {
  return (
    <tr>
      <td>{resourceKindLabel(props.item.kind)}</td>
      <td className="mono">{props.item.name}</td>
      <td>
        <span className={props.item.status === "new" ? "tag green" : "tag amber"}>
          {props.item.status}
        </span>
      </td>
      <td>
        <span className={props.item.action === "import" ? "tag blue" : "tag neutral"}>
          {props.item.action}
        </span>
      </td>
      <td className="path-cell mono">{props.item.source}</td>
      <td>
        {props.item.secretRefs && props.item.secretRefs.length > 0 ? (
          props.item.secretRefs.map((ref) => (
            <span className="tag amber mono" key={ref}>
              {ref}
            </span>
          ))
        ) : (
          <span className="muted">none</span>
        )}
      </td>
    </tr>
  );
}
