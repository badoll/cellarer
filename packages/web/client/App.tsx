import type {
  ActivityEvent,
  AgentInspection,
  Capability,
  ConflictStrategy,
  DashboardAgentReadiness,
  DashboardCoverageGroup,
  DashboardSummaryResult,
  DiagnosticCheck,
  DoctorReport,
  LedgerEntry,
  ScanSelection,
  Scope,
} from "@cellarer/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { client } from "./api.js";
import { readApiJson } from "./api-state.js";
import {
  type AgentInfo,
  type ArtifactRow,
  type ArtifactsResponse as Artifacts,
  buildDistributionMatrix,
  DASHBOARD_CAPABILITIES,
  type DriftStatus,
  type MatrixCell,
  type MatrixCellState,
  type PlanAction,
  type StatusItem,
} from "./dashboard-model.js";

type Page =
  | "dashboard"
  | "artifacts"
  | "distribute"
  | "scan"
  | "diagnostics"
  | "revert"
  | "secrets";

interface NavItem {
  page: Page;
  label: string;
  detail: string;
}

const NAV_ITEMS: NavItem[] = [
  { page: "dashboard", label: "Dashboard", detail: "Overview" },
  { page: "artifacts", label: "Artifacts", detail: "Store" },
  { page: "distribute", label: "Distribute", detail: "Plan / apply" },
  { page: "scan", label: "Scan", detail: "Dry-run import" },
  { page: "diagnostics", label: "Diagnostics", detail: "Inspect / doctor" },
  { page: "revert", label: "Revert", detail: "Dry-run rollback" },
  { page: "secrets", label: "Secrets", detail: "References" },
];

const PAGE_META: Record<Page, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Unified management of local agent configuration artifacts.",
  },
  artifacts: {
    title: "Artifacts",
    subtitle: "Rules, MCP servers, skills, and collection tags in the cellarer store.",
  },
  distribute: {
    title: "Distribute",
    subtitle: "Preview a plan first, then apply the generated changes through core.",
  },
  scan: {
    title: "Scan Preview",
    subtitle: "Read native agent files and preview import candidates without writing.",
  },
  diagnostics: {
    title: "Diagnostics",
    subtitle: "Inspect agent paths and run local doctor checks through core.",
  },
  revert: {
    title: "Revert",
    subtitle: "Preview ledger rollback first, then revert managed entries safely.",
  },
  secrets: {
    title: "Secret References",
    subtitle: "Reference names only. Secret values are not returned by the Web API.",
  },
};

const CAPABILITIES = DASHBOARD_CAPABILITIES;
const CAPABILITY_LABELS: Record<Capability, string> = {
  rules: "Rules",
  mcp: "MCP",
  skills: "Skills",
};
const STATUS_LABELS: Record<DriftStatus, string> = {
  ok: "ok",
  drifted: "drifted",
  missing: "missing",
  "broken-link": "broken link",
};
const MATRIX_LABELS: Record<MatrixCellState, string> = {
  applied: "applied",
  pending: "pending",
  partial: "partial",
  drifted: "drifted",
  missing: "missing",
  "broken-link": "broken link",
  unsupported: "unsupported",
  skipped: "skipped",
  empty: "no ledger",
};
const CONFLICT_LABELS: Record<ConflictStrategy, string> = {
  "keep-theirs": "keep theirs",
  "keep-mine": "keep mine",
  copy: "copy",
};

interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface SessionScanPreview {
  plan: ScanPlanResponse;
  capturedAt: string;
  requestKey: string;
}

type DashboardDriftItem = DashboardSummaryResult["driftItems"][number];

// scope 选择控件:global/project 单选 + project 时的 dir 输入框(必填)。
// 下发页与扫描页共用,避免两处各写一份(与后端 app.ts「project 必须带 dir 否则 400」对齐)。
function ScopePicker(props: {
  scope: Scope;
  dir: string;
  onScope: (s: Scope) => void;
  onDir: (d: string) => void;
}) {
  return (
    <div className="scope-picker">
      <fieldset className="segmented">
        <legend className="visually-hidden">Scope</legend>
        <label className={props.scope === "global" ? "selected" : ""}>
          <input
            type="radio"
            name="scope"
            checked={props.scope === "global"}
            onChange={() => props.onScope("global")}
          />
          global
        </label>
        <label className={props.scope === "project" ? "selected" : ""}>
          <input
            type="radio"
            name="scope"
            checked={props.scope === "project"}
            onChange={() => props.onScope("project")}
          />
          project
        </label>
      </fieldset>
      {props.scope === "project" && (
        <input
          type="text"
          className="dir-input"
          placeholder="Project root absolute path"
          value={props.dir}
          onChange={(e) => props.onDir(e.target.value)}
        />
      )}
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [scanPreview, setScanPreview] = useState<SessionScanPreview | null>(null);
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
          </div>
          <div>
            <h1>cellarer</h1>
            <p>Unified agent config store</p>
          </div>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item.page}
              className={page === item.page ? "active" : ""}
              onClick={() => setPage(item.page)}
            >
              <span className="nav-label">{item.label}</span>
              <span className="nav-detail">{item.detail}</span>
            </button>
          ))}
        </nav>
        <div className="local-card">
          <span className="status-dot" />
          <div>
            <strong>Local mode</strong>
            <p>Loopback API · masked secrets</p>
          </div>
        </div>
      </aside>
      <main className="main">
        <AppHeader page={page} onNavigate={setPage} />
        <div className="content">
          {page === "dashboard" && <Dashboard onNavigate={setPage} scanPreview={scanPreview} />}
          {page === "artifacts" && <ArtifactsPage />}
          {page === "distribute" && <DistributePage />}
          {page === "scan" && <ScanPage onSessionPreview={setScanPreview} />}
          {page === "diagnostics" && <DiagnosticsPage />}
          {page === "revert" && <RevertPage />}
          {page === "secrets" && <SecretsPage />}
        </div>
      </main>
    </div>
  );
}

function AppHeader(props: { page: Page; onNavigate: (page: Page) => void }) {
  const meta = PAGE_META[props.page];
  return (
    <header className="topbar">
      <div className="topbar-title">
        <p className="eyebrow">Local control plane</p>
        <h2>{meta.title}</h2>
        <p>{meta.subtitle}</p>
      </div>
      <div className="topbar-right">
        <div className="status-row">
          <span className="status-pill">Local only</span>
          <span className="status-pill">127.0.0.1</span>
          <span className="status-pill">No database</span>
          <span className="status-pill">Secrets masked</span>
        </div>
        <div className="top-actions">
          <button type="button" className="action" onClick={() => props.onNavigate("distribute")}>
            Apply Changes
          </button>
          <button
            type="button"
            className="action secondary"
            onClick={() => props.onNavigate("scan")}
          >
            Preview Scan
          </button>
        </div>
      </div>
    </header>
  );
}

// 通用 fetch hook(只读 GET):API 错误要渲染成错误态,不能把 `{error}` 当正常数据继续渲染。
function useApi<T>(fetcher: () => Promise<Response>, deps: unknown[] = []): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    setState((current) => ({ ...current, error: null, loading: true }));
    fetcher()
      .then(readApiJson<T>)
      .then((data) => {
        if (alive) setState({ data, error: null, loading: false });
      })
      .catch((err) => {
        if (alive) {
          setState({
            data: null,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, deps);
  return state;
}

function Dashboard(props: {
  onNavigate: (page: Page) => void;
  scanPreview: SessionScanPreview | null;
}) {
  const summaryState = useApi<DashboardSummaryResult>(() => client.api.summary.$get());
  const summary = summaryState.data;
  const driftItems = summary?.driftItems ?? [];

  return (
    <div className="page-stack">
      {summaryState.error && <ApiErrorPanel errors={[summaryState.error]} />}
      <section className="stat-grid" aria-label="Dashboard summary">
        <StatCard
          label="Detected Agents"
          value={summary?.agentCounts.detected ?? "..."}
          detail={
            summary
              ? `${summary.agentCounts.ready} ready · ${summary.agentCounts.registered} registered`
              : "Detecting global agent roots"
          }
          tone="green"
        />
        <StatCard
          label="Artifacts"
          value={summary?.artifactCounts.total ?? "..."}
          detail={
            summary
              ? summary.artifactCounts.total === 0
                ? "No store artifacts yet"
                : `Rules ${summary.artifactCounts.rules} · MCP ${summary.artifactCounts.mcp} · Skills ${summary.artifactCounts.skills}`
              : "Loading store inventory"
          }
          tone="blue"
        />
        <StatCard
          label="Drift Alerts"
          value={driftItems.length}
          detail={
            summary
              ? `${summary.driftCounts.ok} ok · ${summary.driftCounts.drifted} drifted · ${summary.driftCounts.missing} missing`
              : "Loading ledger status"
          }
          tone={driftItems.length > 0 ? "red" : "green"}
        />
        <StatCard
          label="Secret References"
          value={summary?.secretRefs.length ?? "..."}
          detail={
            summary?.secretRefs.length === 0 ? "No ledger secret refs yet" : "Reference names only"
          }
          tone="amber"
        />
      </section>

      {summary?.isEmptyStore && <EmptyStorePanel onNavigate={props.onNavigate} />}

      <section className="dashboard-grid">
        <Panel
          title="Detected Agents"
          action={
            <button
              type="button"
              className="link-button"
              onClick={() => props.onNavigate("diagnostics")}
            >
              Inspect
            </button>
          }
        >
          {!summary ? (
            <p className="empty-state">Loading registered adapters...</p>
          ) : summary.agents.length === 0 ? (
            <p className="empty-state">No adapters registered.</p>
          ) : (
            <AgentReadinessList agents={summary.agents} />
          )}
        </Panel>

        <Panel
          title="Distribution Overview"
          action={
            <button
              type="button"
              className="link-button"
              onClick={() => props.onNavigate("distribute")}
            >
              Plan changes
            </button>
          }
        >
          <DistributionOverview groups={summary?.distributionCoverage ?? null} />
        </Panel>

        <Panel
          title="Recent Scan Preview"
          action={
            <button type="button" className="link-button" onClick={() => props.onNavigate("scan")}>
              Preview scan
            </button>
          }
        >
          <RecentScanPreview
            preview={props.scanPreview}
            latestImport={summary?.latestScanSummary}
          />
        </Panel>

        <Panel
          title="Drift Alerts"
          action={
            <button
              type="button"
              className="link-button"
              onClick={() => props.onNavigate("revert")}
            >
              Open revert
            </button>
          }
        >
          {!summary ? (
            <p className="empty-state">Loading drift status...</p>
          ) : driftItems.length === 0 ? (
            <p className={summary.driftCounts.ok > 0 ? "ok-state" : "empty-state"}>
              {summary.driftCounts.ok > 0
                ? "All tracked ledger entries are ok."
                : "No ledger entries yet."}
            </p>
          ) : (
            <DriftAlerts items={driftItems} />
          )}
        </Panel>

        <Panel
          title="Ledger Activity"
          action={
            <button
              type="button"
              className="link-button"
              onClick={() => props.onNavigate("revert")}
            >
              Open ledger
            </button>
          }
        >
          <LedgerActivity events={summary?.latestActivity ?? null} />
        </Panel>

        <Panel
          title="Secret References"
          action={
            <button
              type="button"
              className="link-button"
              onClick={() => props.onNavigate("secrets")}
            >
              Review refs
            </button>
          }
        >
          <SecretReferences refs={summary?.secretRefs ?? null} />
        </Panel>
      </section>
    </div>
  );
}

function AgentReadinessList(props: { agents: DashboardAgentReadiness[] }) {
  return (
    <div className="agent-readiness-list">
      {props.agents.map((agent) => (
        <article className="agent-readiness-row" key={agent.id}>
          <div>
            <strong>{agent.displayName}</strong>
            <span className="muted-row mono">{agent.root ?? agent.id}</span>
          </div>
          <ReadinessBadge status={agent.status} />
          <div className="capability-strip">
            {agent.capabilities.map((capability) => (
              <span
                className={`tag ${readinessTone(capability.status)}`}
                key={capability.capability}
              >
                {CAPABILITY_LABELS[capability.capability]} {capability.status}
              </span>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function ReadinessBadge(props: { status: DashboardAgentReadiness["status"] }) {
  return <span className={`tag ${readinessTone(props.status)}`}>{props.status}</span>;
}

function readinessTone(status: string): "green" | "amber" | "red" | "neutral" {
  if (status === "ready") return "green";
  if (status === "warning" || status === "detected") return "amber";
  if (status === "not-found") return "red";
  return "neutral";
}

function DistributionOverview(props: { groups: DashboardCoverageGroup[] | null }) {
  if (!props.groups) return <p className="empty-state">Loading distribution coverage...</p>;
  if (props.groups.length === 0) return <p className="empty-state">No coverage groups yet.</p>;
  const byCollection = new Map<string, DashboardCoverageGroup[]>();
  for (const group of props.groups) {
    byCollection.set(group.collection, [...(byCollection.get(group.collection) ?? []), group]);
  }
  return (
    <div className="coverage-list">
      {[...byCollection.entries()].map(([collection, groups]) => (
        <section className="coverage-channel" key={collection}>
          <div className="coverage-channel-header">
            <span className="tag blue">{collection}</span>
            <span className="muted">
              {groups.reduce((sum, group) => sum + group.artifactsCount, 0)} artifacts
            </span>
          </div>
          {groups.map((group) => (
            <div className="coverage-row" key={`${group.collection}:${group.scope}`}>
              <div>
                <strong>{group.scope}</strong>
                <span className="muted-row">
                  {group.desiredCount === 0
                    ? group.emptyReason
                    : `${group.appliedCount}/${group.desiredCount} applied · ${group.targetsCount} targets`}
                </span>
              </div>
              <div className="coverage-meter">
                <div className="progress-track" aria-hidden="true">
                  <span className="progress-fill" style={{ width: `${group.percentage ?? 0}%` }} />
                </div>
                <strong>{group.percentage === null ? "n/a" : `${group.percentage}%`}</strong>
              </div>
              <div className="coverage-counts">
                {group.driftedCount > 0 && (
                  <span className="tag amber">{group.driftedCount} drifted</span>
                )}
                {group.missingCount > 0 && (
                  <span className="tag red">{group.missingCount} missing</span>
                )}
                {group.brokenLinkCount > 0 && (
                  <span className="tag red">{group.brokenLinkCount} broken</span>
                )}
                {group.blockedCount > 0 && (
                  <span className="tag amber">{group.blockedCount} blocked</span>
                )}
                {group.lastAppliedAt && (
                  <span className="muted">Last applied {formatTime(group.lastAppliedAt)}</span>
                )}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function DriftAlerts(props: { items: DashboardDriftItem[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Level</th>
            <th>Agent</th>
            <th>Item</th>
            <th>Scope</th>
            <th>Target</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {props.items.slice(0, 6).map((item) => (
            <tr key={`${item.agent}-${item.capability}-${item.target}`}>
              <td>
                <StatusBadge status={item.status} />
              </td>
              <td>{item.agent}</td>
              <td>
                <span className="mono">{item.artifact}</span>
                <span className="muted-row">{item.capability}</span>
              </td>
              <td>{item.scope}</td>
              <td className="path-cell mono">{item.target}</td>
              <td>
                <DiffPreviewButton item={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface DiffResponse {
  available: boolean;
  before?: string;
  after?: string;
  warning?: string;
  redactionNotices: string[];
}

function DiffPreviewButton(props: { item: DashboardDriftItem }) {
  const [result, setResult] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function checkDiff() {
    setLoading(true);
    setError(null);
    try {
      const response = await client.api.diff.$post({ json: { identity: props.item } });
      setResult(await readApiJson<DiffResponse>(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (result?.available) {
    return (
      <details className="diff-preview">
        <summary>View diff</summary>
        <div className="diff-columns">
          <pre>{result.before ?? ""}</pre>
          <pre>{result.after ?? ""}</pre>
        </div>
        {result.redactionNotices.map((notice) => (
          <p className="warn" key={notice}>
            {notice}
          </p>
        ))}
      </details>
    );
  }
  return (
    <div className="diff-action">
      <button type="button" className="link-button" disabled={loading} onClick={checkDiff}>
        {loading ? "Checking..." : "Check diff"}
      </button>
      {result && !result.available && <span className="muted-row">{result.warning}</span>}
      {error && <span className="danger muted-row">{error}</span>}
    </div>
  );
}

function RecentScanPreview(props: {
  preview: SessionScanPreview | null;
  latestImport?: ActivityEvent;
}) {
  if (!props.preview && !props.latestImport) {
    return <p className="empty-state">No session scan preview yet.</p>;
  }
  const items = props.preview?.plan.items ?? [];
  const importable = items.filter((item) => item.action === "import").length;
  const skipped = items.filter((item) => item.action === "skip").length;
  const secretRefs = unique(items.flatMap((item) => item.secretRefs ?? []));
  return (
    <div className="scan-preview-panel">
      {props.preview && (
        <div className="scan-preview-summary">
          <span className="tag amber">session only</span>
          <strong>{props.preview.plan.agent}</strong>
          <span className="muted">{formatTime(props.preview.capturedAt)}</span>
          <span>{importable} importable</span>
          <span>{skipped} skipped</span>
        </div>
      )}
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Source</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 4).map((item) => (
                <tr key={scanItemKey(item)}>
                  <td>{item.kind}</td>
                  <td className="mono">{item.name}</td>
                  <td className="path-cell mono">{item.source}</td>
                  <td className={item.action === "skip" ? "danger" : "ok"}>{item.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {secretRefs.length > 0 && (
        <div className="secret-list">
          {secretRefs.map((ref) => (
            <span className="tag amber mono" key={ref}>
              {ref}
            </span>
          ))}
        </div>
      )}
      {props.latestImport && (
        <p className="ok-state">
          Latest imported scan: {props.latestImport.summary} · {formatTime(props.latestImport.time)}
        </p>
      )}
    </div>
  );
}

function LedgerActivity(props: { events: ActivityEvent[] | null }) {
  if (!props.events) return <p className="empty-state">Loading activity...</p>;
  if (props.events.length === 0) return <p className="empty-state">No activity recorded yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Scope</th>
            <th>Targets</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {props.events.slice(0, 6).map((event) => (
            <tr key={event.id}>
              <td>{formatTime(event.time)}</td>
              <td>{event.actor}</td>
              <td>
                <span className="tag blue">{event.action}</span>
              </td>
              <td>{event.scope ?? "global"}</td>
              <td>{event.affectedCount}</td>
              <td>{event.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SecretReferences(props: { refs: DashboardSummaryResult["secretRefs"] | null }) {
  if (!props.refs) return <p className="empty-state">Loading secret references...</p>;
  if (props.refs.length === 0) return <p className="empty-state">No secret references recorded.</p>;
  return (
    <div className="secret-ref-grid">
      {props.refs.slice(0, 8).map((ref) => (
        <div className="secret-ref" key={ref.name}>
          <span className="tag amber mono">{ref.name}</span>
          <strong>{ref.ledgerEntryCount}</strong>
        </div>
      ))}
      {props.refs.length > 8 && <span className="muted">+{props.refs.length - 8} more</span>}
    </div>
  );
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

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function EmptyStorePanel(props: { onNavigate: (page: Page) => void }) {
  return (
    <section className="empty-store-panel">
      <div>
        <p className="eyebrow">Empty store</p>
        <h3>Store artifacts and apply ledger are empty</h3>
        <p>
          The adapter list is built in. Artifact, drift, and secret counts appear after content is
          added to the cellarer store or after a scan/apply writes ledger entries.
        </p>
      </div>
      <div className="command-list">
        <code>cellarer init</code>
        <code>cellarer add &lt;path&gt;</code>
        <code>cellarer scan --agent codex --into-channel common</code>
      </div>
      <div className="empty-store-actions">
        <button type="button" className="action secondary" onClick={() => props.onNavigate("scan")}>
          Preview Scan
        </button>
        <button
          type="button"
          className="action secondary"
          onClick={() => props.onNavigate("artifacts")}
        >
          View Artifacts
        </button>
      </div>
    </section>
  );
}

function StatCard(props: {
  label: string;
  value: number | string;
  detail: string;
  tone: "green" | "blue" | "amber" | "red";
}) {
  return (
    <article className={`stat-card ${props.tone}`}>
      <span className="stat-label">{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
    </article>
  );
}

function Panel(props: {
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={["panel", props.className].filter(Boolean).join(" ")}>
      <div className="panel-header">
        <h3>{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function ApiErrorPanel(props: { errors: string[]; compact?: boolean }) {
  const uniqueErrors = [...new Set(props.errors)];
  return (
    <section className={props.compact ? "api-error compact" : "api-error"}>
      <strong>Local API error</strong>
      {uniqueErrors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </section>
  );
}

function InventoryRow(props: { label: string; count: number }) {
  return (
    <div className="inventory-row">
      <span>{props.label}</span>
      <strong>{props.count}</strong>
    </div>
  );
}

function AgentDetectBadge(props: { detected: boolean }) {
  return props.detected ? (
    <span className="tag green">detected</span>
  ) : (
    <span className="tag amber">not found</span>
  );
}

function StatusBadge(props: { status: DriftStatus }) {
  const tone = props.status === "ok" ? "green" : props.status === "drifted" ? "amber" : "red";
  return <span className={`tag ${tone}`}>{STATUS_LABELS[props.status]}</span>;
}

function DistributionMatrixView(props: {
  matrix: ReturnType<typeof buildDistributionMatrix> | null;
}) {
  if (!props.matrix) return <p className="empty-state">Loading distribution status...</p>;
  if (props.matrix.columns.length === 0) {
    return <p className="empty-state">No registered adapters to show.</p>;
  }
  return (
    <div className="table-wrap matrix-wrap">
      <table className="matrix-table">
        <thead>
          <tr>
            <th>Capability</th>
            {props.matrix.columns.map((column) => (
              <th key={column.id}>
                <span>{column.agentName}</span>
                <span className="muted-row">{column.scope}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.matrix.rows.map((row) => (
            <tr key={row.capability}>
              <th>{CAPABILITY_LABELS[row.capability]}</th>
              {props.matrix?.columns.map((column) => (
                <td key={column.id}>
                  <MatrixCellBadge cell={row.cells[column.id]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixCellBadge(props: { cell: MatrixCell | undefined }) {
  const cell = props.cell ?? { state: "empty" as const, count: 0, details: [] };
  return (
    <span className="matrix-cell">
      <span className={`tag ${matrixTone(cell.state)}`}>{MATRIX_LABELS[cell.state]}</span>
      {cell.state === "partial" && cell.details.length > 0 ? (
        <span className="muted-row">
          {cell.details.map((detail) => MATRIX_LABELS[detail]).join(" / ")}
        </span>
      ) : cell.count > 0 ? (
        <span className="muted-row">
          {cell.count} {cell.count === 1 ? "item" : "items"}
        </span>
      ) : null}
    </span>
  );
}

function matrixTone(state: MatrixCellState): "green" | "blue" | "amber" | "red" | "neutral" {
  if (state === "applied") return "green";
  if (state === "pending") return "blue";
  if (state === "empty" || state === "unsupported") return "neutral";
  if (state === "skipped" || state === "partial") return "amber";
  return "red";
}

function ArtifactsPage() {
  const artsState = useApi<Artifacts>(() => client.api.artifacts.$get());
  const arts = artsState.data;
  if (artsState.error) return <ApiErrorPanel errors={[artsState.error]} />;
  if (!arts) return <p className="empty-state">Loading artifacts...</p>;
  const groups: [string, ArtifactRow[]][] = [
    ["rules", arts.rules],
    ["mcp", arts.mcp],
    ["skills", arts.skills],
  ];
  return (
    <div className="page-stack">
      {groups.map(([kind, rows]) => (
        <div className="card" key={kind}>
          <div className="section-header">
            <h3>{kind}</h3>
            <span className="count-badge">{rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <p className="empty-state">Empty</p>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.name}</td>
                      <td>
                        {r.collections.length === 0 ? (
                          <span className="muted">no collection</span>
                        ) : (
                          r.collections.map((collection) => (
                            <span className="tag blue" key={collection}>
                              {collection}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

type MethodSelection = "default" | "symlink" | "copy";
type McpStrategySelection = "default" | "merge" | "overwrite";

interface DistributeRequest {
  agents: string[];
  scope: Scope;
  dir?: string;
  collections?: string[];
  capabilities: Capability[];
  method?: "symlink" | "copy";
  mcpStrategy?: "merge" | "overwrite";
}

interface DistributeResult {
  actions: PlanAction[];
  warnings: string[];
}

function DistributePage() {
  const agentsState = useApi<{ agents: AgentInfo[] }>(() => client.api.agents.$get());
  const artifactsState = useApi<Artifacts>(() => client.api.artifacts.$get());
  const [statusVersion, setStatusVersion] = useState(0);
  const statusState = useApi<{ items: StatusItem[] }>(
    () => client.api.status.$get(),
    [statusVersion],
  );
  const agents = agentsState.data;
  const artifacts = artifactsState.data;
  const statusData = statusState.data;
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [caps, setCaps] = useState<Record<string, boolean>>({
    rules: true,
    mcp: true,
    skills: true,
  });
  const [collections, setCollections] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState<MethodSelection>("default");
  const [mcpStrategy, setMcpStrategy] = useState<McpStrategySelection>("default");
  const [scope, setScope] = useState<Scope>("global");
  const [dir, setDir] = useState("");
  const [result, setResult] = useState<DistributeResult | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [planIsApplied, setPlanIsApplied] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const chosenAgents = Object.keys(selected).filter((a) => selected[a]);
  const chosenCaps = Object.keys(caps).filter((c) => caps[c]) as Capability[];
  const chosenCollections = Object.keys(collections).filter(
    (collection) => collections[collection],
  );
  // project 作用域必须提供 dir(与后端一致);否则禁用动作按钮。
  const dirMissing = scope === "project" && dir.trim() === "";
  const disabled = chosenAgents.length === 0 || chosenCaps.length === 0 || dirMissing;
  const currentRequest = body();
  const currentRequestKey = JSON.stringify(currentRequest);
  const previewIsCurrent = result !== null && previewKey === currentRequestKey;
  const matrix =
    agents && statusData
      ? buildDistributionMatrix({
          agents: agents.agents,
          statusItems: statusData.items,
          planActions: result && previewIsCurrent && !planIsApplied ? result.actions : undefined,
        })
      : null;

  function body(): DistributeRequest {
    return {
      agents: chosenAgents,
      scope,
      dir: scope === "project" ? dir.trim() : undefined,
      collections: chosenCollections.length > 0 ? chosenCollections : undefined,
      capabilities: chosenCaps,
      method: method === "default" ? undefined : method,
      mcpStrategy: mcpStrategy === "default" ? undefined : mcpStrategy,
    };
  }
  async function doPlan() {
    setApplied(null);
    setActionError(null);
    const request = body();
    try {
      const r = await client.api.plan.$post({ json: request });
      setResult(await readApiJson<DistributeResult>(r));
      setPreviewKey(JSON.stringify(request));
      setPlanIsApplied(false);
    } catch (err) {
      setResult(null);
      setPreviewKey(null);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }
  async function doApply() {
    if (!previewIsCurrent) return;
    setActionError(null);
    try {
      const r = await client.api.apply.$post({ json: body() });
      const j = await readApiJson<{ entries: unknown[]; plan: DistributeResult }>(r);
      setApplied(`Applied ${j.entries.length} item${j.entries.length === 1 ? "" : "s"}`);
      setResult(j.plan);
      setPreviewKey(currentRequestKey);
      setPlanIsApplied(true);
      setStatusVersion((version) => version + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page-stack">
      {[agentsState.error, artifactsState.error, statusState.error].some(Boolean) && (
        <ApiErrorPanel
          errors={[agentsState.error, artifactsState.error, statusState.error].filter(
            (error): error is string => error !== null,
          )}
        />
      )}
      <div className="card">
        <div className="control-grid">
          <section className="control-group">
            <h3>Scope</h3>
            <ScopePicker scope={scope} dir={dir} onScope={setScope} onDir={setDir} />
          </section>
          <section className="control-group">
            <h3>Agents</h3>
            <div className="option-list">
              {agents?.agents.map((a) => (
                <label className="check-row" key={a.id}>
                  <input
                    type="checkbox"
                    checked={!!selected[a.id]}
                    onChange={(e) => setSelected((s) => ({ ...s, [a.id]: e.target.checked }))}
                  />
                  <span>{a.displayName}</span>
                </label>
              ))}
            </div>
          </section>
          <section className="control-group">
            <h3>Capabilities</h3>
            <div className="option-list">
              {CAPABILITIES.map((cap) => (
                <label className="check-row" key={cap}>
                  <input
                    type="checkbox"
                    checked={!!caps[cap]}
                    onChange={(e) => setCaps((s) => ({ ...s, [cap]: e.target.checked }))}
                  />
                  <span>{CAPABILITY_LABELS[cap]}</span>
                </label>
              ))}
            </div>
          </section>
          <section className="control-group">
            <h3>Collections</h3>
            <div className="option-list">
              {artifactsState.error ? (
                <span className="muted">Collections unavailable</span>
              ) : !artifacts ? (
                <span className="muted">Loading collections...</span>
              ) : artifacts.collections.length === 0 ? (
                <span className="muted">Default collection set</span>
              ) : (
                artifacts.collections.map((collection) => (
                  <label className="check-row" key={collection}>
                    <input
                      type="checkbox"
                      checked={!!collections[collection]}
                      onChange={(e) =>
                        setCollections((current) => ({
                          ...current,
                          [collection]: e.target.checked,
                        }))
                      }
                    />
                    <span>{collection}</span>
                  </label>
                ))
              )}
            </div>
            {chosenCollections.length === 0 && (
              <span className="hint">Using configured defaults</span>
            )}
          </section>
          <section className="control-group">
            <h3>Write Options</h3>
            <label className="field-row stacked">
              <span>Method</span>
              <select
                value={method}
                onChange={(event) => setMethod(event.target.value as MethodSelection)}
              >
                <option value="default">Config default</option>
                <option value="symlink">symlink</option>
                <option value="copy">copy</option>
              </select>
            </label>
            <label className="field-row stacked">
              <span>MCP strategy</span>
              <select
                value={mcpStrategy}
                onChange={(event) => setMcpStrategy(event.target.value as McpStrategySelection)}
              >
                <option value="default">Adapter default</option>
                <option value="merge">merge</option>
                <option value="overwrite">overwrite</option>
              </select>
            </label>
          </section>
        </div>
        <div className="button-row">
          <button type="button" className="action secondary" disabled={disabled} onClick={doPlan}>
            Preview dry-run
          </button>
          <button
            type="button"
            className="action"
            disabled={disabled || !previewIsCurrent}
            onClick={doApply}
          >
            Apply
          </button>
        </div>
        {dirMissing && <p className="warn">Project scope requires a project root path.</p>}
        {chosenCaps.length === 0 && <p className="warn">Select at least one capability.</p>}
        {result && !previewIsCurrent && (
          <p className="warn">Preview is stale. Run Preview dry-run again before applying.</p>
        )}
        {actionError && <ApiErrorPanel errors={[actionError]} compact />}
        {applied && <p className="ok">{applied}</p>}
      </div>
      <Panel title="Distribution Matrix">
        <DistributionMatrixView matrix={matrix} />
      </Panel>
      {result && (
        <div className="card">
          {result.warnings.map((w) => (
            <p className="warn" key={w}>
              {w}
            </p>
          ))}
          {result.actions.length === 0 ? (
            <p className="empty-state">Preview returned no actions for the current filters.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Capability</th>
                    <th>Op</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {result.actions.map((a) => (
                    <tr key={`${a.agent}-${a.capability}-${a.target}`}>
                      <td>{a.agent}</td>
                      <td>{a.capability}</td>
                      <td className={a.op === "skip" ? "danger" : "ok"}>{a.op}</td>
                      <td className="mono">
                        {a.target}
                        {a.op === "skip" && a.reason ? (
                          <span className="muted-row">{a.reason}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ScanItem {
  kind: Capability;
  name: string;
  status: string;
  action: string;
  secretRefs?: string[];
  source: string;
}

interface ScanPlanResponse {
  agent: string;
  scope: Scope;
  items: ScanItem[];
  warnings: string[];
}

interface ScanApplyResult {
  plan: ScanPlanResponse;
  imported: ScanItem[];
}

function scanItemKey(item: ScanItem): string {
  return `${item.kind}:${item.name}:${item.source}`;
}

function ScanPage(props: { onSessionPreview: (preview: SessionScanPreview) => void }) {
  const agentsState = useApi<{ agents: AgentInfo[] }>(() => client.api.agents.$get());
  const [artifactVersion, setArtifactVersion] = useState(0);
  const artifactsState = useApi<Artifacts>(() => client.api.artifacts.$get(), [artifactVersion]);
  const agents = agentsState.data;
  const [agent, setAgent] = useState("");
  const [scope, setScope] = useState<Scope>("global");
  const [dir, setDir] = useState("");
  const [caps, setCaps] = useState<Record<string, boolean>>({
    rules: true,
    mcp: true,
    skills: true,
  });
  const [conflict, setConflict] = useState<ConflictStrategy>("keep-theirs");
  const [intoCollection, setIntoCollection] = useState("");
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [plan, setPlan] = useState<ScanPlanResponse | null>(null);
  const [planKey, setPlanKey] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ScanApplyResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const chosenCaps = Object.keys(caps).filter((c) => caps[c]) as Capability[];
  const dirMissing = scope === "project" && dir.trim() === "";
  const disabled = !agent || chosenCaps.length === 0 || dirMissing;
  const currentScanKey = JSON.stringify(scanBody());
  const previewIsCurrent = plan !== null && planKey === currentScanKey;
  const importAlreadyApplied = importResult !== null;
  const importableItems = plan?.items.filter((item) => item.action === "import") ?? [];
  const selectedScanItems = importableItems
    .filter((item) => selectedItems[scanItemKey(item)])
    .map(({ kind, name, source }) => ({ kind, name, source }));

  function scanBody(selectItems?: ScanSelection[]) {
    return {
      agent,
      scope,
      dir: scope === "project" ? dir.trim() : undefined,
      capabilities: chosenCaps,
      conflict,
      intoCollection: intoCollection.trim() || undefined,
      selectItems,
    };
  }

  async function doScan() {
    setScanError(null);
    setImportResult(null);
    try {
      const request = scanBody();
      const r = await client.api.scan.$post({ json: request });
      const nextPlan = await readApiJson<ScanPlanResponse>(r);
      setPlan(nextPlan);
      setPlanKey(JSON.stringify(request));
      props.onSessionPreview({
        plan: nextPlan,
        capturedAt: new Date().toISOString(),
        requestKey: JSON.stringify(request),
      });
      setSelectedItems(
        Object.fromEntries(
          nextPlan.items
            .filter((item) => item.action === "import")
            .map((item) => [scanItemKey(item), true]),
        ),
      );
    } catch (err) {
      setPlan(null);
      setPlanKey(null);
      setScanError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doImport(selectItems?: ScanSelection[]) {
    if (!previewIsCurrent) return;
    setScanError(null);
    try {
      const r = await client.api.scan.apply.$post({ json: scanBody(selectItems) });
      const result = await readApiJson<ScanApplyResult>(r);
      setImportResult(result);
      setPlan(result.plan);
      setPlanKey(JSON.stringify(scanBody()));
      setSelectedItems({});
      setArtifactVersion((version) => version + 1);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page-stack">
      {[agentsState.error, artifactsState.error].some(Boolean) && (
        <ApiErrorPanel
          errors={[agentsState.error, artifactsState.error].filter(
            (error): error is string => error !== null,
          )}
        />
      )}
      <div className="card">
        <div className="control-grid">
          <section className="control-group">
            <h3>Scope</h3>
            <ScopePicker scope={scope} dir={dir} onScope={setScope} onDir={setDir} />
          </section>
          <section className="control-group">
            <h3>Agent</h3>
            <label className="field-row">
              <span>Adapter</span>
              <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="">Select...</option>
                {agents?.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
          </section>
          <section className="control-group">
            <h3>Capabilities</h3>
            <div className="option-list">
              {CAPABILITIES.map((cap) => (
                <label className="check-row" key={cap}>
                  <input
                    type="checkbox"
                    checked={!!caps[cap]}
                    onChange={(e) => setCaps((s) => ({ ...s, [cap]: e.target.checked }))}
                  />
                  <span>{CAPABILITY_LABELS[cap]}</span>
                </label>
              ))}
            </div>
          </section>
          <section className="control-group">
            <h3>Import Options</h3>
            <label className="field-row stacked">
              <span>Conflict</span>
              <select
                value={conflict}
                onChange={(e) => setConflict(e.target.value as ConflictStrategy)}
              >
                {Object.entries(CONFLICT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-row stacked">
              <span>Into collection</span>
              <input
                type="text"
                placeholder="optional collection"
                value={intoCollection}
                onChange={(e) => setIntoCollection(e.target.value)}
              />
            </label>
          </section>
        </div>
        <div className="button-row">
          <button type="button" className="action" disabled={disabled} onClick={doScan}>
            Preview Scan
          </button>
          <button
            type="button"
            className="action secondary"
            disabled={importAlreadyApplied || !previewIsCurrent || selectedScanItems.length === 0}
            onClick={() => doImport(selectedScanItems)}
          >
            Import Selected
          </button>
          <button
            type="button"
            className="action secondary"
            disabled={importAlreadyApplied || !previewIsCurrent || importableItems.length === 0}
            onClick={() => doImport()}
          >
            Import All
          </button>
        </div>
        {dirMissing && <p className="warn">Project scope requires a project root path.</p>}
        {chosenCaps.length === 0 && <p className="warn">Select at least one capability.</p>}
        {plan && !previewIsCurrent && (
          <p className="warn">Preview is stale. Run Preview Scan again before importing.</p>
        )}
        {scanError && <ApiErrorPanel errors={[scanError]} compact />}
        {importResult && (
          <p className="ok">
            Imported {importResult.imported.length} item
            {importResult.imported.length === 1 ? "" : "s"}.
          </p>
        )}
      </div>
      <Panel title="Store Inventory">
        {!artifactsState.data ? (
          <p className="empty-state">Loading artifacts...</p>
        ) : (
          <div className="mini-metrics">
            <InventoryRow label="Rules" count={artifactsState.data.rules.length} />
            <InventoryRow label="MCP" count={artifactsState.data.mcp.length} />
            <InventoryRow label="Skills" count={artifactsState.data.skills.length} />
          </div>
        )}
      </Panel>
      {plan && (
        <div className="card">
          {plan.warnings.map((w) => (
            <p className="warn" key={w}>
              {w}
            </p>
          ))}
          {plan.items.length === 0 ? (
            <p className="empty-state">No importable artifacts found.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Action</th>
                    <th>Source</th>
                    <th>Secret refs</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map((it) => (
                    <tr key={scanItemKey(it)}>
                      <td>
                        {it.action === "import" ? (
                          <input
                            type="checkbox"
                            checked={!!selectedItems[scanItemKey(it)]}
                            onChange={(e) =>
                              setSelectedItems((current) => ({
                                ...current,
                                [scanItemKey(it)]: e.target.checked,
                              }))
                            }
                            aria-label={`Select ${it.kind}/${it.name}`}
                          />
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td>{it.kind}</td>
                      <td className="mono">{it.name}</td>
                      <td>
                        <span className={`tag ${it.status === "new" ? "green" : "amber"}`}>
                          {it.status}
                        </span>
                      </td>
                      <td className={it.action === "skip" ? "danger" : "ok"}>{it.action}</td>
                      <td className="path-cell mono">{it.source}</td>
                      <td>
                        {(it.secretRefs ?? []).length === 0 ? (
                          <span className="muted">none</span>
                        ) : (
                          (it.secretRefs ?? []).map((r) => (
                            <span className="tag amber mono" key={r}>
                              {r}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiagnosticsPage() {
  const agentsState = useApi<{ agents: AgentInfo[] }>(() => client.api.agents.$get());
  const agents = agentsState.data;
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<Scope>("global");
  const [dir, setDir] = useState("");
  const [inspection, setInspection] = useState<{
    scope: Scope;
    dir?: string;
    agents: AgentInspection[];
    warnings: string[];
  } | null>(null);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const chosenAgents = Object.keys(selected).filter((id) => selected[id]);
  const dirMissing = scope === "project" && dir.trim() === "";
  const disabled = dirMissing;

  function diagnosticsBody() {
    return {
      scope,
      dir: scope === "project" ? dir.trim() : undefined,
      agents: chosenAgents.length > 0 ? chosenAgents : undefined,
    };
  }

  async function runInspect() {
    setActionError(null);
    try {
      const res = await client.api.agents.inspect.$post({ json: diagnosticsBody() });
      setInspection(
        await readApiJson<{
          scope: Scope;
          dir?: string;
          agents: AgentInspection[];
          warnings: string[];
        }>(res),
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runDoctor() {
    setActionError(null);
    try {
      const res = await client.api.doctor.$post({ json: diagnosticsBody() });
      setDoctorReport(await readApiJson<DoctorReport>(res));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page-stack">
      {agentsState.error && <ApiErrorPanel errors={[agentsState.error]} />}
      <div className="card">
        <div className="control-grid">
          <section className="control-group">
            <h3>Scope</h3>
            <ScopePicker scope={scope} dir={dir} onScope={setScope} onDir={setDir} />
          </section>
          <section className="control-group">
            <h3>Agents</h3>
            <div className="option-list">
              {agents?.agents.map((agent) => (
                <label className="check-row" key={agent.id}>
                  <input
                    type="checkbox"
                    checked={!!selected[agent.id]}
                    onChange={(e) =>
                      setSelected((current) => ({
                        ...current,
                        [agent.id]: e.target.checked,
                      }))
                    }
                  />
                  <span>{agent.displayName}</span>
                </label>
              ))}
              <span className="hint">No selection runs every registered adapter.</span>
            </div>
          </section>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="action secondary"
            disabled={disabled}
            onClick={runInspect}
          >
            Run Inspect
          </button>
          <button type="button" className="action" disabled={disabled} onClick={runDoctor}>
            Run Doctor
          </button>
        </div>
        {dirMissing && <p className="warn">Project scope requires a project root path.</p>}
        {actionError && <ApiErrorPanel errors={[actionError]} compact />}
      </div>

      <Panel title="Agent Inspection">
        {!inspection ? (
          <p className="empty-state">Run Inspect to see adapter paths and capability readiness.</p>
        ) : (
          <AgentInspectionTable agents={inspection.agents} warnings={inspection.warnings} />
        )}
      </Panel>

      <Panel title="Doctor Checks">
        {!doctorReport ? (
          <p className="empty-state">Run Doctor to inspect store, registry, and target paths.</p>
        ) : (
          <div className="diagnostic-stack">
            {doctorReport.warnings.map((warning) => (
              <p className="warn" key={warning}>
                {warning}
              </p>
            ))}
            <CheckList checks={doctorReport.checks} />
            {doctorReport.agents.map((agent) => (
              <section className="diagnostic-agent" key={agent.id}>
                <div className="section-header">
                  <h3>
                    {agent.displayName} <span className="muted">({agent.id})</span>
                  </h3>
                  <AgentDetectBadge detected={agent.detected} />
                </div>
                <CheckList checks={agent.checks} />
              </section>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function AgentInspectionTable(props: { agents: AgentInspection[]; warnings: string[] }) {
  return (
    <div className="diagnostic-stack">
      {props.warnings.map((warning) => (
        <p className="warn" key={warning}>
          {warning}
        </p>
      ))}
      {props.agents.length === 0 ? (
        <p className="empty-state">No matching adapters.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Capabilities</th>
                <th>Root</th>
                <th>Paths</th>
                <th>Warnings</th>
              </tr>
            </thead>
            <tbody>
              {props.agents.map((agent) => (
                <tr key={agent.id}>
                  <td>
                    <strong>{agent.displayName}</strong>
                    <span className="muted-row">{agent.id}</span>
                  </td>
                  <td>
                    <AgentDetectBadge detected={agent.detected} />
                    {!agent.enabled && <span className="tag amber">disabled</span>}
                  </td>
                  <td>
                    {agent.supportedCapabilities.length === 0 ? (
                      <span className="muted">none for scope</span>
                    ) : (
                      agent.supportedCapabilities.map((capability) => (
                        <span className="tag blue" key={capability}>
                          {CAPABILITY_LABELS[capability]}
                        </span>
                      ))
                    )}
                  </td>
                  <td className="path-cell mono">{agent.root ?? "-"}</td>
                  <td className="path-cell mono">
                    <span className="muted-row">rules: {agent.paths.rules ?? "-"}</span>
                    <span className="muted-row">mcp: {agent.paths.mcp ?? "-"}</span>
                    <span className="muted-row">skills: {agent.paths.skillsDir ?? "-"}</span>
                  </td>
                  <td>
                    {agent.warnings.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      agent.warnings.map((warning) => (
                        <span className="muted-row" key={warning}>
                          {warning}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CheckList(props: { checks: DiagnosticCheck[] }) {
  if (props.checks.length === 0) return <p className="empty-state">No checks returned.</p>;
  return (
    <ul className="check-list">
      {props.checks.map((check) => (
        <li key={`${check.id}:${check.path ?? ""}`}>
          <CheckBadge status={check.status} />
          <div>
            <strong>{check.message}</strong>
            {check.path && <span className="muted-row mono">{check.path}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function CheckBadge(props: { status: DiagnosticCheck["status"] }) {
  const tone = props.status === "ok" ? "green" : props.status === "warning" ? "amber" : "red";
  return <span className={`tag ${tone}`}>{props.status}</span>;
}

type RevertScope = "all" | Scope;

interface RevertResponse {
  reverted: LedgerEntry[];
  warnings: string[];
}

function RevertPage() {
  const agentsState = useApi<{ agents: AgentInfo[] }>(() => client.api.agents.$get());
  const [statusVersion, setStatusVersion] = useState(0);
  const statusState = useApi<{ items: StatusItem[] }>(
    () => client.api.status.$get(),
    [statusVersion],
  );
  const agents = agentsState.data;
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<RevertScope>("all");
  const [dir, setDir] = useState("");
  const [keepBackups, setKeepBackups] = useState(false);
  const [preview, setPreview] = useState<RevertResponse | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [reverted, setReverted] = useState<RevertResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const chosenAgents = Object.keys(selected).filter((id) => selected[id]);
  const dirMissing = scope === "project" && dir.trim() === "";
  const currentPreviewKey = JSON.stringify(revertBody(true));
  const previewIsCurrent = preview !== null && previewKey === currentPreviewKey;
  const revertAlreadyApplied = reverted !== null;

  function revertBody(dryRun: boolean) {
    return {
      scope: scope === "all" ? undefined : scope,
      dir: scope === "project" ? dir.trim() : undefined,
      agents: chosenAgents.length > 0 ? chosenAgents : undefined,
      keepBackups,
      dryRun,
    };
  }

  async function runPreview() {
    setActionError(null);
    setReverted(null);
    try {
      const request = revertBody(true);
      const res = await client.api.revert.$post({ json: request });
      setPreview(await readApiJson<RevertResponse>(res));
      setPreviewKey(JSON.stringify(request));
    } catch (err) {
      setPreview(null);
      setPreviewKey(null);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runRevert() {
    if (!previewIsCurrent) return;
    setActionError(null);
    try {
      const res = await client.api.revert.$post({ json: revertBody(false) });
      const result = await readApiJson<RevertResponse>(res);
      setReverted(result);
      setPreview(result);
      setPreviewKey(currentPreviewKey);
      setStatusVersion((version) => version + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page-stack">
      {[agentsState.error, statusState.error].some(Boolean) && (
        <ApiErrorPanel
          errors={[agentsState.error, statusState.error].filter(
            (error): error is string => error !== null,
          )}
        />
      )}
      <div className="card">
        <div className="control-grid">
          <section className="control-group">
            <h3>Scope</h3>
            <fieldset className="segmented">
              <legend className="visually-hidden">Revert scope</legend>
              {(["all", "global", "project"] as RevertScope[]).map((item) => (
                <label className={scope === item ? "selected" : ""} key={item}>
                  <input
                    type="radio"
                    name="revert-scope"
                    checked={scope === item}
                    onChange={() => setScope(item)}
                  />
                  {item}
                </label>
              ))}
            </fieldset>
            {scope === "project" && (
              <input
                type="text"
                className="dir-input"
                placeholder="Project root absolute path"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
              />
            )}
          </section>
          <section className="control-group">
            <h3>Agents</h3>
            <div className="option-list">
              {agents?.agents.map((agent) => (
                <label className="check-row" key={agent.id}>
                  <input
                    type="checkbox"
                    checked={!!selected[agent.id]}
                    onChange={(e) =>
                      setSelected((current) => ({
                        ...current,
                        [agent.id]: e.target.checked,
                      }))
                    }
                  />
                  <span>{agent.displayName}</span>
                </label>
              ))}
              <span className="hint">No selection matches every agent in the ledger.</span>
            </div>
          </section>
          <section className="control-group">
            <h3>Options</h3>
            <label className="check-row">
              <input
                type="checkbox"
                checked={keepBackups}
                onChange={(e) => setKeepBackups(e.target.checked)}
              />
              <span>Keep backups</span>
            </label>
          </section>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="action secondary"
            disabled={dirMissing}
            onClick={runPreview}
          >
            Preview Revert
          </button>
          <button
            type="button"
            className="action"
            disabled={
              dirMissing ||
              revertAlreadyApplied ||
              !previewIsCurrent ||
              preview.reverted.length === 0
            }
            onClick={runRevert}
          >
            Revert
          </button>
        </div>
        {dirMissing && <p className="warn">Project scope requires a project root path.</p>}
        {preview && !previewIsCurrent && (
          <p className="warn">Preview is stale. Run Preview Revert again before reverting.</p>
        )}
        {actionError && <ApiErrorPanel errors={[actionError]} compact />}
        {reverted && (
          <p className="ok">
            Reverted {reverted.reverted.length} item
            {reverted.reverted.length === 1 ? "" : "s"}.
          </p>
        )}
      </div>

      <Panel title="Current Ledger Status">
        {!statusState.data ? (
          <p className="empty-state">Loading ledger status...</p>
        ) : statusState.data.items.length === 0 ? (
          <p className="empty-state">No ledger entries currently tracked.</p>
        ) : (
          <StatusTable items={statusState.data.items} />
        )}
      </Panel>

      {preview && (
        <Panel title="Revert Preview">
          {preview.warnings.map((warning) => (
            <p className="warn" key={warning}>
              {warning}
            </p>
          ))}
          {preview.reverted.length === 0 ? (
            <p className="empty-state">No matching ledger entries to revert.</p>
          ) : (
            <LedgerEntryTable entries={preview.reverted} />
          )}
        </Panel>
      )}
    </div>
  );
}

function StatusTable(props: { items: StatusItem[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Artifact</th>
            <th>Scope</th>
            <th>Status</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => (
            <tr key={`${item.agent}-${item.artifact}-${item.target}`}>
              <td>{item.agent}</td>
              <td>
                <span className="mono">{item.artifact}</span>
                <span className="muted-row">{item.capability}</span>
              </td>
              <td>{item.scope}</td>
              <td>
                <StatusBadge status={item.status} />
              </td>
              <td className="path-cell mono">{item.target}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LedgerEntryTable(props: { entries: LedgerEntry[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Artifact</th>
            <th>Scope</th>
            <th>Target</th>
            <th>Applied</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => (
            <tr key={`${entry.agent}-${entry.artifact}-${entry.target}`}>
              <td>{entry.agent}</td>
              <td>
                <span className="mono">{entry.artifact}</span>
                <span className="muted-row">{entry.method}</span>
              </td>
              <td>{entry.scope}</td>
              <td className="path-cell mono">{entry.target}</td>
              <td className="mono">{entry.appliedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SecretsPage() {
  const state = useApi<{ names: string[] }>(() => client.api.secrets.$get());
  const data = state.data;
  return (
    <div className="page-stack">
      <div className="card">
        <p className="muted">Only reference names are shown. Values remain masked.</p>
        {state.error ? (
          <ApiErrorPanel errors={[state.error]} compact />
        ) : !data ? (
          <p className="empty-state">Loading secret references...</p>
        ) : data.names.length === 0 ? (
          <p className="empty-state">No secret references recorded.</p>
        ) : (
          <ul className="secret-page-list">
            {data.names.map((n) => (
              <li key={n}>
                <span className="mono">{n}</span>
                <span className="muted">masked</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
