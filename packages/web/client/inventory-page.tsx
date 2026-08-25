import type { InventoryCandidateState, InventoryRefreshResult } from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { fetchInventory } from "./api.js";
import { DashboardIcon } from "./dashboard-icons.js";

interface InventoryPageState {
  readonly result: InventoryRefreshResult | null;
  readonly error: string | null;
  readonly loading: boolean;
}

const STATE_LABELS: Record<InventoryCandidateState, string> = {
  ready: "Ready",
  "needs-attention": "Needs attention",
  "in-store": "In Store",
};

export function InventoryPage() {
  const [state, setState] = useState<InventoryPageState>({
    result: null,
    error: null,
    loading: true,
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((current) => ({ ...current, error: null, loading: true }));
    fetchInventory()
      .then((result) => {
        if (alive) setState({ result, error: null, loading: false });
      })
      .catch(() => {
        if (alive) {
          setState({
            result: null,
            error: "Inventory refresh failed",
            loading: false,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  return (
    <div className="page-stack">
      <div className="top-actions">
        <button
          type="button"
          className="action secondary"
          onClick={() => setReloadKey((value) => value + 1)}
          disabled={state.loading}
        >
          <DashboardIcon name="scan" />
          {state.loading ? "Refreshing..." : "Refresh Inventory"}
        </button>
      </div>
      {state.error ? <p className="error-banner">{state.error}</p> : null}
      {state.result ? (
        <InventoryResultView result={state.result} />
      ) : (
        <p className="empty-state">Loading bounded registered sources...</p>
      )}
    </div>
  );
}

export function InventoryResultView(props: { readonly result: InventoryRefreshResult }) {
  const { result } = props;
  return (
    <>
      <section className="stat-grid" aria-label="Inventory summary">
        <InventoryMetric label="Candidates" value={result.counts.total} />
        <InventoryMetric label="Ready" value={result.counts.ready} />
        <InventoryMetric label="Needs attention" value={result.counts.needsAttention} />
        <InventoryMetric label="In Store" value={result.counts.inStore} />
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h3>
              <DashboardIcon name="artifacts" /> Unified Inventory
            </h3>
            <p>
              Inventory is {result.completeness}; {result.counts.observedSources} sources observed,{" "}
              {result.counts.failedSources} failed.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Resource</th>
                <th>State</th>
                <th>Sources</th>
                <th>Adapters</th>
                <th>Findings</th>
              </tr>
            </thead>
            <tbody>
              {result.candidates.map((candidate) => (
                <tr key={candidate.id}>
                  <td>
                    <strong>{candidate.name}</strong>
                    <span className="muted-row mono">{candidate.kind}</span>
                    {candidate.managedMatch ? (
                      <span className="muted-row mono">
                        {candidate.managedMatch.resourceId}@{candidate.managedMatch.revisionId}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <span className={`tag ${stateTone(candidate.state)}`}>
                      {STATE_LABELS[candidate.state]}
                    </span>
                    <span className="muted-row">
                      {candidate.defaultSelected ? "Default selected" : "Not selected"}
                    </span>
                  </td>
                  <td>
                    {candidate.sources.map((source) => (
                      <span className="muted-row mono" key={source.id}>
                        {source.location}
                      </span>
                    ))}
                  </td>
                  <td>
                    {candidate.relatedAdapters.map((adapter) => (
                      <span className="muted-row" key={adapter.id}>
                        {adapter.displayName} ({adapter.id})
                      </span>
                    ))}
                  </td>
                  <td>
                    {candidate.findings.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      candidate.findings.map((finding) => (
                        <span
                          className="muted-row"
                          key={`${finding.code}:${finding.sourceId ?? "candidate"}`}
                        >
                          {finding.code} · {finding.remediation}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.findings.map((finding) => (
          <p className="warning-banner" key={`${finding.code}:${finding.sourceId ?? "refresh"}`}>
            {finding.code} · {finding.remediation}
          </p>
        ))}
      </section>
    </>
  );
}

function InventoryMetric(props: { readonly label: string; readonly value: number }) {
  return (
    <article className="stat-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </article>
  );
}

function stateTone(state: InventoryCandidateState): string {
  if (state === "ready") return "green";
  if (state === "needs-attention") return "amber";
  return "blue";
}
