import type { Capability, DistributePlan, MutationPlan } from "@cellarer/core/client-api";
import { useLayoutEffect, useRef, useState } from "react";
import { apiFetch } from "./api.js";
import { ClientApiError, isClientReplanRequired, readApiJson } from "./api-state.js";
import { type Destination, destinationLabel, resourceKindLabel } from "./product-model.js";

import {
  buildSyncSelection,
  isProjectDirMissing,
  type SyncRequest,
  syncRequestKey,
} from "./sync-selection.js";

export { buildSyncRequest, isProjectDirMissing, syncRequestKey } from "./sync-selection.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SyncDialog(props: {
  open: boolean;
  kinds?: Capability[];
  collections?: string[];
  onClose(): void;
  onApplied(): void;
}) {
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
  const canPreview = hasAgents && !dirMissing && !previewing && !applying;
  const canApply = canPreview && hasCurrentPreview;

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
      setError(errorMessage(err));
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
        aria-label="Sync to Agents"
      >
        <div className="panel-header modal-header">
          <div>
            <h3>Sync to Agents</h3>
            <p>Preview writes to agent targets before applying the selected resources.</p>
          </div>
          <button type="button" className="link-button" disabled={applying} onClick={props.onClose}>
            Close
          </button>
        </div>

        <div className="sync-dialog-grid">
          <label className="field-row stacked">
            <span>Target agents</span>
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
            <span>Resources</span>
            <strong>{selection.resourceSummary}</strong>
            <p>{selection.collectionSummary}</p>
            <p>Syncs matching Store resources. Discovered resources must be imported first.</p>
          </div>
        </div>

        <fieldset className="segmented sync-destination" disabled={applying}>
          <legend className="visually-hidden">Destination</legend>
          {(["user", "project"] as Destination[]).map((item) => (
            <label className={destination === item ? "selected" : ""} key={item}>
              <input
                type="radio"
                checked={destination === item}
                onChange={() => {
                  setDestination(item);
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
              disabled={applying}
              value={dir}
              onChange={(event) => {
                setDir(event.target.value);
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
          <button type="button" className="action" disabled={!canApply} onClick={applySync}>
            {applying ? "Applying..." : "Apply"}
          </button>
        </div>

        {dirMissing && <p className="warn">Project-level sync requires a project root path.</p>}
        {!hasAgents && <p className="warn">Enter at least one target agent.</p>}
        {error && (
          <section className="api-error compact">
            <strong>Local API error</strong>
            <p>{error}</p>
          </section>
        )}
        {plan && <SyncPlanTable plan={plan} />}
      </section>
    </div>
  );
}

function SyncPlanTable(props: { plan: DistributePlan }) {
  return (
    <section className="sync-plan">
      <div className="section-header">
        <h3>Preview</h3>
        <span className="tag neutral">{props.plan.actions.length} actions</span>
      </div>
      {props.plan.actions.length === 0 ? (
        <p className="empty-state">No sync actions are needed for this selection.</p>
      ) : (
        <div className="table-wrap resource-table-wrap">
          <table className="resource-table sync-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Resource</th>
                <th>Operation</th>
                <th>Target</th>
                <th>Reason</th>
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
                  <td>{action.reason ?? "Ready"}</td>
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
    </section>
  );
}
