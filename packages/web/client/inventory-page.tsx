import type {
  InventoryCandidate,
  InventoryCandidateState,
  InventoryRefreshResult,
  InventorySecretAdoptionOffer,
  InventoryStreamEvent,
} from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import {
  applyInventorySecretAdoption,
  applyInventoryStoreImport,
  type InventorySecretAdoptionPlanResult,
  planInventorySecretAdoption,
  planInventoryStoreImport,
  streamInventory,
} from "./api.js";
import { DashboardIcon } from "./dashboard-icons.js";
import {
  canPlanInventoryImport,
  createInventoryOnboardingState,
  EMPTY_INVENTORY_FILTERS,
  filterInventoryCandidates,
  type InventoryFilters,
  type InventoryOnboardingState,
  inventoryAdapterOptions,
  inventoryImportApplying,
  inventoryImportDeclined,
  inventoryImportFailed,
  inventoryImportPlanned,
  inventoryImportSucceeded,
  inventoryLoaded,
  inventoryLoadFailed,
  inventoryLoading,
  inventoryPlanning,
  inventorySelectionChanged,
  inventorySourceOptions,
} from "./inventory-onboarding.js";
import type { Page } from "./product-model.js";

const STATE_LABELS: Record<InventoryCandidateState, string> = {
  ready: "Ready",
  "needs-attention": "Needs attention",
  "in-store": "In Store",
};

export type InventorySecretAdoptionViewState =
  | "idle"
  | "planning"
  | "review"
  | "applying"
  | "applied"
  | "failed";

export function InventoryPage(props: { readonly onNavigate?: (page: Page) => void }) {
  const [onboarding, setOnboarding] = useState<InventoryOnboardingState>(() =>
    createInventoryOnboardingState(),
  );
  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_INVENTORY_FILTERS);
  const [reloadKey, setReloadKey] = useState(0);
  const [scan, setScan] = useState<{
    readonly completed: number;
    readonly total: number;
    readonly candidates: Extract<InventoryStreamEvent, { type: "progress" }>["candidates"];
    readonly findingCodes: readonly string[];
  } | null>(null);
  const [adoptionProvider, setAdoptionProvider] = useState<"vault" | "keychain">("vault");
  const [adoption, setAdoption] = useState<{
    readonly candidateId: string | null;
    readonly state: InventorySecretAdoptionViewState;
    readonly plan: InventorySecretAdoptionPlanResult | null;
    readonly message?: string;
  }>({ candidateId: null, state: "idle", plan: null });

  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    setScan(null);
    setOnboarding((current) => inventoryLoading(current));
    setAdoption({ candidateId: null, state: "idle", plan: null });
    streamInventory((event) => {
      if (!alive) return;
      if (event.type === "started")
        setScan({ completed: 0, total: event.totalSources, candidates: [], findingCodes: [] });
      if (event.type === "progress")
        setScan({
          completed: event.completedSources,
          total: event.totalSources,
          candidates: event.candidates,
          findingCodes: event.findingCodes,
        });
      if (event.type === "reset" || event.type === "completed" || event.type === "failed")
        setScan(null);
    }, abort.signal)
      .then((result) => {
        if (alive) setOnboarding((current) => inventoryLoaded(current, result));
      })
      .catch(() => {
        if (alive) {
          setScan(null);
          setOnboarding((current) => inventoryLoadFailed(current));
        }
      });
    return () => {
      alive = false;
      abort.abort();
    };
  }, [reloadKey]);

  function refreshInventory() {
    setOnboarding((current) => inventoryLoading(current));
    setReloadKey((value) => value + 1);
  }

  async function planSelectedImport() {
    if (!canPlanInventoryImport(onboarding)) return;
    const candidateIds = [...onboarding.selectedCandidateIds].sort();
    setOnboarding((current) => inventoryPlanning(current));
    try {
      const planned = await planInventoryStoreImport({ candidateIds });
      setOnboarding((current) => inventoryImportPlanned(current, planned));
    } catch (error) {
      setOnboarding((current) => inventoryImportFailed(current, error));
    }
  }

  async function confirmImport() {
    const pending = onboarding.pendingPlan;
    if (pending === null) return;
    setOnboarding((current) => inventoryImportApplying(current));
    try {
      const applied = await applyInventoryStoreImport(pending.mutationPlan);
      if (!applied.operation.ok) throw new Error("Inventory import did not complete");
      setOnboarding((current) =>
        inventoryImportSucceeded(current, {
          candidateIds: applied.candidateIds,
          resourceIds: applied.resourceIds,
        }),
      );
    } catch (error) {
      setOnboarding((current) => inventoryImportFailed(current, error));
    }
  }

  async function reviewSecretAdoption(
    candidate: InventoryCandidate,
    offer: InventorySecretAdoptionOffer,
  ) {
    setAdoption({ candidateId: candidate.id, state: "planning", plan: null });
    try {
      const plan = await planInventorySecretAdoption({
        candidateId: candidate.id,
        selector: offer.selector,
        provider: adoptionProvider,
      });
      setAdoption({ candidateId: candidate.id, state: "review", plan });
    } catch {
      setAdoption({
        candidateId: candidate.id,
        state: "failed",
        plan: null,
        message: "Adoption planning failed. Refresh Inventory and review the candidate again.",
      });
    }
  }

  async function confirmSecretAdoption() {
    if (!adoption.plan) return;
    setAdoption((current) => ({ ...current, state: "applying" }));
    try {
      const applied = await applyInventorySecretAdoption(adoption.plan.mutationPlan);
      if (!applied.operation.ok || applied.status !== "applied") {
        const cleanup = applied.orphan?.cleanupCommand;
        setAdoption({
          candidateId: adoption.candidateId,
          state: "failed",
          plan: adoption.plan,
          message: cleanup
            ? `Store publication failed. Review the typed orphan evidence and run: ${cleanup}`
            : "Secret adoption was rejected. Refresh Inventory before replanning.",
        });
        return;
      }
      setAdoption({
        candidateId: adoption.candidateId,
        state: "applied",
        plan: null,
        message: "Reference-only adoption completed. Refresh Inventory to review Store state.",
      });
    } catch {
      setAdoption({
        candidateId: adoption.candidateId,
        state: "failed",
        plan: adoption.plan,
        message: "Secret adoption failed. Review recovery status before retrying.",
      });
    }
  }

  const result = onboarding.result;
  const visibleCandidates = result ? filterInventoryCandidates(result.candidates, filters) : [];
  const busy =
    onboarding.phase === "loading" ||
    onboarding.phase === "planning" ||
    onboarding.phase === "applying";
  const stale =
    onboarding.result !== null && (onboarding.phase === "loading" || onboarding.phase === "failed");

  return (
    <div className="page-stack">
      <div className="top-actions">
        <button
          type="button"
          className="action secondary"
          onClick={refreshInventory}
          disabled={busy}
        >
          <DashboardIcon name="scan" />
          {onboarding.phase === "loading" ? "Refreshing..." : "Refresh Inventory"}
        </button>
        {result ? (
          <button
            type="button"
            className="action"
            onClick={planSelectedImport}
            disabled={!canPlanInventoryImport(onboarding)}
          >
            {onboarding.phase === "planning"
              ? "Planning..."
              : `Review import (${onboarding.selectedCandidateIds.length})`}
          </button>
        ) : null}
      </div>

      {onboarding.message ? (
        <p className={onboarding.phase === "imported" ? "ok-state" : "warning-banner"}>
          {onboarding.message}
        </p>
      ) : null}

      {scan ? (
        <section className="panel" aria-label="Inventory scan progress" aria-live="polite">
          <h3>
            Scanning sources · {scan.completed}/{scan.total}
          </h3>
          <p>
            Pending candidates are provisional. Review and import are available after the final
            result.
          </p>
          {scan.findingCodes.length > 0 ? (
            <p className="warning-banner">Source findings: {scan.findingCodes.join(", ")}</p>
          ) : null}
          <ul>
            {scan.candidates.map((candidate) => (
              <li key={candidate.id}>
                {candidate.kind} · {candidate.id.slice(-12)} · {candidate.sourceCount} source(s) ·
                Pending
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {stale ? (
        <p className="warning-banner">
          Previous Inventory result is stale while refresh is incomplete. Review it only; refresh
          again before taking action.
        </p>
      ) : null}

      {result?.completeness !== "complete" && result ? (
        <p className="warning-banner">
          Inventory is {result.completeness}. Review the preserved candidates and findings, then
          refresh before planning an import.
        </p>
      ) : null}

      {result ? (
        <>
          <InventoryFilterBar filters={filters} result={result} onChange={setFilters} />
          <InventoryResultView
            result={result}
            candidates={visibleCandidates}
            selectedCandidateIds={onboarding.selectedCandidateIds}
            selectionDisabled={
              busy ||
              onboarding.phase === "failed" ||
              onboarding.phase === "confirmation" ||
              result.completeness !== "complete"
            }
            adoptionDisabled={
              busy ||
              onboarding.phase === "failed" ||
              onboarding.phase === "confirmation" ||
              result.completeness !== "complete"
            }
            onSelectionChange={(candidateId, selected) =>
              setOnboarding((current) => inventorySelectionChanged(current, candidateId, selected))
            }
            adoptionProvider={adoptionProvider}
            adoptionCandidateId={adoption.candidateId}
            adoptionState={adoption.state}
            adoptionMessage={adoption.message}
            onAdoptionProviderChange={setAdoptionProvider}
            onPlanAdoption={reviewSecretAdoption}
            onApplyAdoption={confirmSecretAdoption}
          />
        </>
      ) : onboarding.phase === "failed" ? (
        <p className="error-banner">Inventory refresh failed. Use Refresh Inventory to retry.</p>
      ) : (
        <p className="empty-state">Loading bounded registered sources...</p>
      )}

      {onboarding.phase === "confirmation" && onboarding.pendingPlan ? (
        <section className="panel inventory-confirmation" aria-label="Confirm Inventory import">
          <div className="panel-header">
            <div>
              <h3>Confirm exact Store import</h3>
              <p>
                Apply the unchanged plan for {onboarding.pendingPlan.candidateIds.length} reviewed
                candidate(s). This does not sync any agent target.
              </p>
            </div>
          </div>
          <div className="receipt-list">
            {onboarding.pendingPlan.candidateIds.map((candidateId) => (
              <code key={candidateId}>{candidateId}</code>
            ))}
          </div>
          <div className="button-row">
            <button type="button" className="action" onClick={confirmImport}>
              Confirm Store import
            </button>
            <button
              type="button"
              className="action secondary"
              onClick={() => setOnboarding((current) => inventoryImportDeclined(current))}
            >
              Decline
            </button>
          </div>
        </section>
      ) : null}

      {onboarding.phase === "imported" ? (
        <section className="panel" aria-label="Inventory import next actions">
          <div className="panel-header">
            <div>
              <h3>Import complete</h3>
              <p>Review the Library first. Sync remains a separate authorized journey.</p>
            </div>
          </div>
          <div className="button-row">
            <button type="button" className="action" onClick={() => props.onNavigate?.("skills")}>
              Open Library
            </button>
            <button
              type="button"
              className="action secondary"
              onClick={() => props.onNavigate?.("agents")}
            >
              Review Sync targets
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function InventoryFilterBar(props: {
  readonly filters: InventoryFilters;
  readonly result: InventoryRefreshResult;
  readonly onChange: (filters: InventoryFilters) => void;
}) {
  const { filters, result } = props;
  const update = <Key extends keyof InventoryFilters>(key: Key, value: InventoryFilters[Key]) =>
    props.onChange({ ...filters, [key]: value });
  return (
    <section className="panel inventory-filter-grid" aria-label="Inventory filters">
      <div className="inventory-filter-field">
        <label htmlFor="inventory-filter-kind">Kind</label>
        <select
          id="inventory-filter-kind"
          value={filters.kind}
          onChange={(event) =>
            update("kind", event.currentTarget.value as InventoryFilters["kind"])
          }
        >
          <option value="all">All kinds</option>
          <option value="skills">Skills</option>
          <option value="mcp">MCP</option>
          <option value="rules">Rules</option>
        </select>
      </div>
      <div className="inventory-filter-field">
        <label htmlFor="inventory-filter-source">Source</label>
        <select
          id="inventory-filter-source"
          value={filters.sourceId}
          onChange={(event) => update("sourceId", event.currentTarget.value)}
        >
          <option value="all">All sources</option>
          {inventorySourceOptions(result).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="inventory-filter-field">
        <label htmlFor="inventory-filter-adapter">Adapter</label>
        <select
          id="inventory-filter-adapter"
          value={filters.adapterId}
          onChange={(event) => update("adapterId", event.currentTarget.value)}
        >
          <option value="all">All adapters</option>
          {inventoryAdapterOptions(result).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="inventory-filter-field">
        <label htmlFor="inventory-filter-state">State</label>
        <select
          id="inventory-filter-state"
          value={filters.state}
          onChange={(event) =>
            update("state", event.currentTarget.value as InventoryFilters["state"])
          }
        >
          <option value="all">All states</option>
          <option value="ready">Ready</option>
          <option value="needs-attention">Needs attention</option>
          <option value="in-store">In Store</option>
        </select>
      </div>
    </section>
  );
}

export function InventoryResultView(props: {
  readonly result: InventoryRefreshResult;
  readonly candidates?: readonly InventoryCandidate[];
  readonly selectedCandidateIds?: readonly string[];
  readonly selectionDisabled?: boolean;
  readonly adoptionDisabled?: boolean;
  readonly onSelectionChange?: (candidateId: string, selected: boolean) => void;
  readonly adoptionProvider?: "vault" | "keychain";
  readonly adoptionCandidateId?: string | null;
  readonly adoptionState?: InventorySecretAdoptionViewState;
  readonly adoptionMessage?: string;
  readonly onAdoptionProviderChange?: (provider: "vault" | "keychain") => void;
  readonly onPlanAdoption?: (
    candidate: InventoryCandidate,
    offer: InventorySecretAdoptionOffer,
  ) => void;
  readonly onApplyAdoption?: () => void;
}) {
  const { result } = props;
  const candidates = props.candidates ?? result.candidates;
  const selected = new Set(props.selectedCandidateIds ?? []);
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
              {result.counts.failedSources} failed. {candidates.length} candidate(s) match filters.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Import</th>
                <th>Resource</th>
                <th>State</th>
                <th>Sources</th>
                <th>Adapters</th>
                <th>Findings</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${candidate.name}`}
                      checked={selected.has(candidate.id)}
                      disabled={props.selectionDisabled || candidate.state !== "ready"}
                      onChange={(event) =>
                        props.onSelectionChange?.(candidate.id, event.currentTarget.checked)
                      }
                    />
                  </td>
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
                      {candidate.defaultSelected ? "Core default" : "Not a Core default"}
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
                    {result.effectiveResources
                      ?.filter((row) => row.candidateId === candidate.id)
                      .map((row) => (
                        <span
                          className="muted-row"
                          key={`${row.adapterId}:${row.sourceId}`}
                          title={row.evidence}
                        >
                          {row.adapterId} · {row.scope} · {row.state}: {row.reason}
                        </span>
                      ))}
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
                        <div key={`${finding.code}:${finding.sourceId ?? "candidate"}`}>
                          <span className="muted-row">
                            {finding.code} · {finding.remediation}
                          </span>
                          {finding.adoption ? (
                            <InventorySecretAdoptionView
                              candidate={candidate}
                              offer={finding.adoption}
                              provider={props.adoptionProvider ?? "vault"}
                              state={
                                props.adoptionCandidateId === candidate.id
                                  ? (props.adoptionState ?? "idle")
                                  : "idle"
                              }
                              message={
                                props.adoptionCandidateId === candidate.id
                                  ? props.adoptionMessage
                                  : undefined
                              }
                              onProviderChange={props.onAdoptionProviderChange}
                              onPlan={() => {
                                if (finding.adoption) {
                                  props.onPlanAdoption?.(candidate, finding.adoption);
                                }
                              }}
                              onApply={props.onApplyAdoption}
                              disabled={props.adoptionDisabled}
                            />
                          ) : null}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.coverage ? (
          <details>
            <summary>
              Discovery coverage · bounded {result.resolutionContext ?? "user"} scope
            </summary>
            {result.coverage.map((coverage) => (
              <p
                className="muted-row"
                key={`${coverage.adapterId}:${coverage.dimension}:${coverage.sourceId ?? "-"}`}
              >
                {coverage.adapterId} · {coverage.dimension} · {coverage.sourceId ?? ""} ·{" "}
                {coverage.status} · {coverage.mode}: {coverage.location}{" "}
                {coverage.bounds
                  ? `depth ${coverage.bounds.maxDepth}, entries ${coverage.bounds.maxEntries}, bytes ${coverage.bounds.maxBytes}`
                  : ""}{" "}
                {coverage.reason}
              </p>
            ))}
          </details>
        ) : null}
        {result.findings.map((finding) => (
          <p className="warning-banner" key={`${finding.code}:${finding.sourceId ?? "refresh"}`}>
            {finding.code} · {finding.remediation}
          </p>
        ))}
      </section>
    </>
  );
}

export function InventorySecretAdoptionView(props: {
  readonly candidate: InventoryCandidate;
  readonly offer?: InventorySecretAdoptionOffer;
  readonly provider: "vault" | "keychain";
  readonly state: InventorySecretAdoptionViewState;
  readonly message?: string;
  readonly onProviderChange?: (provider: "vault" | "keychain") => void;
  readonly onPlan?: () => void;
  readonly onApply?: () => void;
  readonly disabled?: boolean;
}) {
  const offer =
    props.offer ?? props.candidate.findings.find((finding) => finding.adoption)?.adoption;
  if (!offer) return null;
  const busy = props.state === "planning" || props.state === "applying";
  return (
    <section
      className="inventory-adoption"
      aria-label={`Adopt secret reference for ${props.candidate.name}`}
    >
      <strong>Adopt secret reference</strong>
      <span className="muted-row mono">
        {offer.selector.kind}:{offer.selector.name} → {offer.targetName}
      </span>
      <label>
        Provider
        <select
          aria-label={`Provider for ${props.candidate.name}`}
          value={props.provider}
          disabled={props.disabled || busy || props.state === "review"}
          onChange={(event) =>
            props.onProviderChange?.(event.currentTarget.value as "vault" | "keychain")
          }
        >
          <option value="vault">Vault</option>
          <option value="keychain">Keychain</option>
        </select>
      </label>
      {props.state === "review" ? (
        <button type="button" className="action" disabled={props.disabled} onClick={props.onApply}>
          Confirm exact adoption
        </button>
      ) : (
        <button
          type="button"
          className="action secondary"
          disabled={props.disabled || busy}
          onClick={props.onPlan}
        >
          {props.state === "planning" ? "Planning..." : "Review adoption plan"}
        </button>
      )}
      {props.message ? <span className="muted-row">{props.message}</span> : null}
    </section>
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
