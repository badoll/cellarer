import type { Capability, MutationPlan, ScanItem, ScanPlan } from "@cellarer/core/client-api";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { type Destination, destinationLabel, resourceKindLabel } from "./product-model.js";

interface ImportPayload {
  agent: string;
  destination: Destination;
  dir?: string;
  capabilities?: Capability[];
}

interface ImportRequestInput {
  agent: string;
  destination: Destination;
  dir: string;
  capabilities?: Capability[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isImportProjectDirMissing(destination: Destination, dir: string): boolean {
  return destination === "project" && dir.trim() === "";
}

export function buildImportRequest(input: ImportRequestInput): ImportPayload {
  return {
    agent: input.agent.trim(),
    destination: input.destination,
    dir: input.destination === "project" ? input.dir.trim() : undefined,
    capabilities: input.capabilities,
  };
}

export function importRequestKey(request: ImportPayload): string {
  return JSON.stringify({
    agent: request.agent,
    destination: request.destination,
    dir: request.dir ?? "",
    capabilities: request.capabilities ?? [],
  });
}

export function ImportDialog(props: {
  open: boolean;
  kind?: Capability;
  onClose(): void;
  onImported(): void;
}) {
  const [agent, setAgent] = useState("codex");
  const [destination, setDestination] = useState<Destination>("user");
  const [dir, setDir] = useState("");
  const [plan, setPlan] = useState<ScanPlan | null>(null);
  const [mutationPlan, setMutationPlan] = useState<MutationPlan | null>(null);
  const [plannedPayload, setPlannedPayload] = useState<ImportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const latestPayloadKey = useRef("");

  useEffect(() => {
    if (!props.open) return;
    setPlan(null);
    setMutationPlan(null);
    setPlannedPayload(null);
    setError(null);
  }, [props.open, props.kind]);

  if (!props.open) return null;

  const currentKind = props.kind ? resourceKindLabel(props.kind) : "All resources";
  const request = buildImportRequest({
    agent,
    destination,
    dir,
    capabilities: props.kind ? [props.kind] : undefined,
  });
  const currentRequestKey = importRequestKey(request);
  latestPayloadKey.current = currentRequestKey;
  const dirMissing = isImportProjectDirMissing(destination, dir);
  const hasAgent = request.agent.length > 0;
  const hasCurrentPreview =
    plan !== null &&
    mutationPlan !== null &&
    plannedPayload !== null &&
    importRequestKey(plannedPayload) === currentRequestKey;
  const canPreview = hasAgent && !dirMissing && !previewing && !applying;
  const canApply = canPreview && hasCurrentPreview;

  function resetPlan() {
    setPlan(null);
    setMutationPlan(null);
    setPlannedPayload(null);
  }

  async function preview() {
    if (!canPreview) return;
    setError(null);
    setPreviewing(true);
    try {
      const response = await apiFetch("/api/v1/import/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const nextPlan = await readApiJson<{
        readonly plan: ScanPlan;
        readonly mutationPlan: MutationPlan;
      }>(response);
      if (currentRequestKey !== latestPayloadKey.current) return;
      setPlan(nextPlan.plan);
      setMutationPlan(nextPlan.mutationPlan);
      setPlannedPayload(request);
    } catch (err) {
      resetPlan();
      setError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function applyImport() {
    if (!plan || !mutationPlan || !plannedPayload) return;
    setError(null);
    setApplying(true);
    try {
      const response = await apiFetch("/api/v1/import/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildImportApplyRequest(mutationPlan)),
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
              the selected library.
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
                resetPlan();
              }}
            />
          </label>
          <div className="destination-summary">
            <span>Destination</span>
            <strong>{destinationLabel(destination)} library</strong>
            <p>{currentKind}</p>
          </div>
        </div>

        <fieldset className="segmented import-destination">
          <legend className="visually-hidden">Destination</legend>
          {(["user", "project"] as Destination[]).map((item) => (
            <label className={destination === item ? "selected" : ""} key={item}>
              <input
                type="radio"
                checked={destination === item}
                onChange={() => {
                  setDestination(item);
                  resetPlan();
                }}
              />
              {destinationLabel(item)}
            </label>
          ))}
        </fieldset>

        {destination === "project" && (
          <label className="field-row stacked project-dir-row">
            <span>Project root</span>
            <input
              className="dir-input"
              type="text"
              placeholder="Project root absolute path"
              value={dir}
              onChange={(event) => {
                setDir(event.target.value);
                resetPlan();
              }}
            />
          </label>
        )}

        <div className="button-row">
          <button
            type="button"
            className="action secondary"
            disabled={!canPreview}
            onClick={preview}
          >
            {previewing ? "Previewing..." : "Preview"}
          </button>
          <button type="button" className="action" disabled={!canApply} onClick={applyImport}>
            {applying ? "Importing..." : "Import"}
          </button>
        </div>

        {dirMissing && <p className="warn">Project-level import requires a project root path.</p>}
        {!hasAgent && <p className="warn">Enter an agent to import from.</p>}
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

export function buildImportApplyRequest(mutationPlan: MutationPlan): {
  readonly mutationPlan: MutationPlan;
} {
  return { mutationPlan };
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
