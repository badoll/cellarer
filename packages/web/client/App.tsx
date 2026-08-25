import type {
  Capability,
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
  DashboardAgentReadiness,
  DashboardCoverageGroup,
  DashboardSummaryResult,
  DiscoverySummaryResult,
} from "@cellarer/core/client-api";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AgentsPage } from "./agents-page.js";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { DashboardIcon, type DashboardIconName } from "./dashboard-icons.js";
import { ImportDialog } from "./import-dialog.js";
import { InventoryPage } from "./inventory-page.js";
import {
  destinationLabel,
  type Page,
  RESOURCE_KINDS,
  type ResourceState,
  resourceKindLabel,
} from "./product-model.js";
import { ResourcePage } from "./resource-pages.js";
import { SettingsPage } from "./settings-page.js";

interface NavItem {
  page: Page;
  label: string;
  detail: string;
  icon: DashboardIconName;
}

interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { page: "dashboard", label: "Dashboard", detail: "Overview", icon: "dashboard" },
  { page: "inventory", label: "Inventory", detail: "Live sources", icon: "scan" },
  { page: "skills", label: "Skills", detail: "Library", icon: "artifacts" },
  { page: "mcp", label: "MCP", detail: "Servers", icon: "database" },
  { page: "rules", label: "Rules", detail: "Instructions", icon: "rules" },
  { page: "agents", label: "Agents", detail: "Targets", icon: "agent" },
  { page: "settings", label: "Settings", detail: "Defaults", icon: "settings" },
];

const PAGE_META: Record<Page, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Local-first overview of resources, collections, and agent targets.",
  },
  inventory: {
    title: "Inventory",
    subtitle: "Read-only candidates across bounded registered user and project sources.",
  },
  skills: {
    title: "Skills",
    subtitle: "Managed and discovered skill resources for agent runtimes.",
  },
  mcp: {
    title: "MCP",
    subtitle: "MCP server resources and their sync status across agents.",
  },
  rules: {
    title: "Rules",
    subtitle: "Instruction resources, collection membership, and target status.",
  },
  agents: {
    title: "Agents",
    subtitle: "Registered adapters, detected roots, and capability coverage.",
  },
  settings: {
    title: "Settings",
    subtitle: "Store defaults, collections, adapters, and secret references.",
  },
};

const SAFETY_ITEMS: { icon: DashboardIconName; label: string }[] = [
  { icon: "home", label: "Local only" },
  { icon: "host", label: "127.0.0.1" },
  { icon: "database", label: "No database" },
  { icon: "lock", label: "Secrets masked" },
];

const RESOURCE_STATE_LABELS: Record<ResourceState, string> = {
  managed: "Managed",
  discovered: "Discovered",
  synced: "Synced",
  drifted: "Drifted",
  missing: "Missing",
  blocked: "Blocked",
};

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  return (
    <div className="app">
      <MobileChrome page={page} onNavigate={setPage} />
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
              <DashboardIcon name={item.icon} />
              <span>
                <span className="nav-label">{item.label}</span>
                <span className="nav-detail">{item.detail}</span>
              </span>
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
          {page === "dashboard" && <DashboardPage onNavigate={setPage} />}
          {page === "inventory" && <InventoryPage />}
          {page === "skills" && <ResourcePage kind="skills" />}
          {page === "mcp" && <ResourcePage kind="mcp" />}
          {page === "rules" && <ResourcePage kind="rules" />}
          {page === "agents" && <AgentsPage />}
          {page === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}

function MobileChrome(props: { page: Page; onNavigate: (page: Page) => void }) {
  return (
    <div className="mobile-chrome">
      <div className="mobile-brand-row">
        <div className="brand compact">
          <div className="brand-mark" aria-hidden="true">
            <span />
          </div>
          <div>
            <h1>cellarer</h1>
            <p>Local control plane</p>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Open settings"
          onClick={() => props.onNavigate("settings")}
        >
          <DashboardIcon name="settings" />
        </button>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {NAV_ITEMS.map((item) => (
          <button
            type="button"
            key={item.page}
            className={props.page === item.page ? "active" : ""}
            onClick={() => props.onNavigate(item.page)}
          >
            <DashboardIcon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
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
          {SAFETY_ITEMS.map((item) => (
            <span className="status-pill" key={item.label}>
              <DashboardIcon name={item.icon} />
              {item.label}
            </span>
          ))}
        </div>
        <div className="top-actions compact-actions">
          {props.page !== "settings" && (
            <button
              type="button"
              className="action secondary"
              onClick={() => props.onNavigate("settings")}
            >
              <DashboardIcon name="settings" />
              Settings
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

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

function DashboardPage(props: { onNavigate: (page: Page) => void }) {
  return <DashboardShell onNavigate={props.onNavigate} />;
}

function DashboardShell(props: { onNavigate: (page: Page) => void }) {
  const [importOpen, setImportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const summaryState = useApi<DashboardSummaryResult>(
    () => apiFetch("/api/v1/summary"),
    [reloadKey],
  );
  const resourcesState = useApi<ControlPlaneResourceListDto>(
    () => apiFetch("/api/v1/resources"),
    [reloadKey],
  );
  const discoveryState = useApi<DiscoverySummaryResult>(
    () => apiFetch("/api/v1/discovery"),
    [reloadKey],
  );
  const summary = summaryState.data;
  const resourceCounts = resourcesState.data?.counts ?? null;
  const resourceCountsByKind = resourcesState.data
    ? countResourcesByKind(resourcesState.data.resources)
    : null;
  const discovery = discoveryState.data;
  const discoveryTotal = discovery
    ? discovery.totals.rules + discovery.totals.mcp + discovery.totals.skills
    : "...";
  const blockedSyncCount = resourceCounts
    ? resourceCounts.drifted + resourceCounts.missing + resourceCounts.blocked
    : null;

  return (
    <div className="page-stack">
      <ApiErrorList errors={[summaryState.error, resourcesState.error, discoveryState.error]} />
      <section className="stat-grid" aria-label="Dashboard summary">
        <StatCard
          label="Managed Resources"
          value={resourceCounts?.managed ?? summary?.artifactCounts.total ?? "..."}
          detail={
            resourceCounts
              ? `${resourceCounts.discovered} discovered · ${resourceCounts.synced} synced`
              : "Loading resource catalog"
          }
          tone="blue"
          icon="artifacts"
        />
        <StatCard
          label="Discovery"
          value={discoveryTotal}
          detail={
            discovery
              ? `${destinationLabel(discovery.destination)} sources`
              : "Scanning readable files"
          }
          tone="amber"
          icon="scan"
        />
        <StatCard
          label="Sync Health"
          value={resourceCounts?.synced ?? "..."}
          detail={
            resourceCounts
              ? `${blockedSyncCount} drift or missing targets`
              : "Loading synced target state"
          }
          tone={blockedSyncCount && blockedSyncCount > 0 ? "amber" : "green"}
          icon="check"
        />
        <StatCard
          label="Agents"
          value={summary?.agentCounts.detected ?? "..."}
          detail={
            summary
              ? `${summary.agentCounts.ready} ready · ${summary.agentCounts.registered} registered`
              : "Checking local agent roots"
          }
          tone="green"
          icon="agent"
        />
      </section>

      <section className="dashboard-actions next-actions" aria-label="Next actions">
        <button type="button" className="resource-shortcut" onClick={() => setImportOpen(true)}>
          <DashboardIcon name="scan" />
          <span>
            <strong>Import existing setup</strong>
            <span>Preview before adding resources</span>
          </span>
        </button>
        <button
          type="button"
          className="resource-shortcut"
          onClick={() => props.onNavigate("skills")}
        >
          <DashboardIcon name="apply" />
          <span>
            <strong>Sync library</strong>
            <span>{resourceCounts?.managed ?? 0} managed resources</span>
          </span>
        </button>
        <button
          type="button"
          className="resource-shortcut"
          onClick={() => props.onNavigate("rules")}
        >
          <DashboardIcon name="warning" />
          <span>
            <strong>Fix drift</strong>
            <span>{blockedSyncCount ?? 0} targets need review</span>
          </span>
        </button>
        <button
          type="button"
          className="resource-shortcut"
          onClick={() => props.onNavigate("agents")}
        >
          <DashboardIcon name="agent" />
          <span>
            <strong>Review agents</strong>
            <span>{summary?.agentCounts.registered ?? 0} registered targets</span>
          </span>
        </button>
      </section>

      <section className="dashboard-actions" aria-label="Resource shortcuts">
        {RESOURCE_KINDS.map((kind) => (
          <button
            type="button"
            className="resource-shortcut"
            key={kind}
            onClick={() => props.onNavigate(kind)}
          >
            <DashboardIcon name={resourceIcon(kind)} />
            <span>
              <strong>{resourceKindLabel(kind)}</strong>
              <span>{resourceCountsByKind?.[kind] ?? 0} resources loaded</span>
            </span>
          </button>
        ))}
      </section>

      <section className="dashboard-main-layout">
        <div className="dashboard-primary-stack">
          <Panel title="Agent Readiness" icon="agent">
            {!summary ? (
              <p className="empty-state">Loading registered agents...</p>
            ) : summary.agents.length === 0 ? (
              <p className="empty-state">No registered agents.</p>
            ) : (
              <AgentReadinessList agents={summary.agents} />
            )}
          </Panel>
        </div>

        <div className="dashboard-side-stack">
          <Panel title="Collection Coverage" icon="settings">
            <CoverageList groups={summary?.distributionCoverage ?? null} />
          </Panel>

          <Panel title="Resource State" icon="artifacts">
            <ResourceCountGrid counts={resourcesState.data?.counts ?? resourceCounts} />
          </Panel>
        </div>

        <Panel title="Discovery Summary" icon="rules" className="span-all">
          <DiscoveryPanel discovery={discovery} />
        </Panel>

        <Panel title="Recent Activity" icon="activity" className="span-all">
          <ActivityTable events={summary?.latestActivity ?? null} />
        </Panel>
      </section>
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          setReloadKey((value) => value + 1);
        }}
      />
    </div>
  );
}

function AgentReadinessList(props: { agents: DashboardAgentReadiness[] }) {
  return (
    <div className="agent-readiness-table">
      <div className="agent-readiness-head" aria-hidden="true">
        <span>Agent</span>
        <span>Status</span>
        <span>Root path</span>
        <span>Scope</span>
        {RESOURCE_KINDS.map((kind) => (
          <span key={kind}>{resourceKindLabel(kind)}</span>
        ))}
      </div>
      {props.agents.map((agent) => (
        <article className="agent-readiness-row" key={agent.id}>
          <div className="agent-cell">
            <span className={`adapter-marker ${adapterTone(agent.id)}`} aria-hidden="true">
              {adapterInitials(agent.displayName, agent.id)}
            </span>
            <div>
              <strong>{agent.displayName}</strong>
              <span className="muted-row">{agent.id}</span>
            </div>
          </div>
          <span className={`tag status-badge ${readinessTone(agent.status)}`}>
            <DashboardIcon name={statusIcon(agent.status)} />
            {agent.status}
          </span>
          <span className="agent-root mono" title={agent.root ?? agent.id}>
            {agent.root ?? agent.id}
          </span>
          <span className="scope-chip">{agent.scope}</span>
          {RESOURCE_KINDS.map((kind) => {
            const capability = agent.capabilities.find((item) => item.capability === kind);
            return (
              <span
                className={`status-icon ${readinessTone(capability?.status ?? "unsupported")}`}
                role="img"
                aria-label={`${resourceKindLabel(kind)} ${capability?.status ?? "unsupported"}`}
                title={`${resourceKindLabel(kind)} ${capability?.status ?? "unsupported"}`}
                key={kind}
              >
                <DashboardIcon name={statusIcon(capability?.status ?? "unsupported")} />
              </span>
            );
          })}
        </article>
      ))}
    </div>
  );
}

function CoverageList(props: { groups: DashboardCoverageGroup[] | null }) {
  if (!props.groups) return <p className="empty-state">Loading collection coverage...</p>;
  if (props.groups.length === 0) return <p className="empty-state">No collection coverage yet.</p>;
  return (
    <div className="coverage-list">
      {props.groups.map((group) => (
        <section className="coverage-collection" key={`${group.collection}:${group.scope}`}>
          <div className="coverage-collection-header">
            <div>
              <span className="tag blue">{group.collection}</span>
              <span className="muted">{group.scope}</span>
            </div>
            <div className="coverage-collection-meta">
              <span>{group.artifactsCount} resources</span>
              <span>{group.targetsCount} targets</span>
            </div>
          </div>
          <div className="coverage-row">
            <div>
              <strong>{group.percentage === null ? "n/a" : `${group.percentage}%`}</strong>
              <span className="muted-row">
                {group.desiredCount === 0
                  ? group.emptyReason
                  : `${group.appliedCount}/${group.desiredCount} synced`}
              </span>
            </div>
            <div className="coverage-meter">
              <div className="progress-track" aria-hidden="true">
                <span className="progress-fill" style={{ width: `${group.percentage ?? 0}%` }} />
              </div>
            </div>
            <div className="coverage-counts">
              {group.driftedCount > 0 && (
                <span className="tag amber">{group.driftedCount} drifted</span>
              )}
              {group.missingCount > 0 && (
                <span className="tag red">{group.missingCount} missing</span>
              )}
              {group.blockedCount > 0 && (
                <span className="tag amber">{group.blockedCount} blocked</span>
              )}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function DiscoveryPanel(props: { discovery: DiscoverySummaryResult | null }) {
  if (!props.discovery) return <p className="empty-state">Loading discovery summary...</p>;
  return (
    <div className="discovery-panel">
      <div className="mini-metrics">
        {RESOURCE_KINDS.map((kind) => (
          <div className="mini-metric" key={kind}>
            <span>{resourceKindLabel(kind)}</span>
            <strong>{props.discovery?.totals[kind] ?? 0}</strong>
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Detected</th>
              <th>Rules</th>
              <th>MCP</th>
              <th>Skills</th>
            </tr>
          </thead>
          <tbody>
            {props.discovery.agents.map((agent) => (
              <tr key={agent.agent}>
                <td>
                  <strong>{agent.displayName}</strong>
                  <span className="muted-row mono">{agent.agent}</span>
                </td>
                <td>
                  <AgentDetectBadge detected={agent.detected} />
                </td>
                <td>{agent.counts.rules}</td>
                <td>{agent.counts.mcp}</td>
                <td>{agent.counts.skills}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.discovery.warnings.length > 0 && (
        <WarningList warnings={props.discovery.warnings} compact />
      )}
    </div>
  );
}

function ActivityTable(props: { events: DashboardSummaryResult["latestActivity"] | null }) {
  if (!props.events) return <p className="empty-state">Loading activity...</p>;
  if (props.events.length === 0) return <p className="empty-state">No activity recorded yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Targets</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {props.events.slice(0, 6).map((event) => (
            <tr key={event.id}>
              <td>{formatTime(event.time)}</td>
              <td>
                <span className="tag blue">{event.action}</span>
              </td>
              <td>{event.actor}</td>
              <td>{event.affectedCount}</td>
              <td>{event.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function StatCard(props: {
  label: string;
  value: number | string;
  detail: string;
  tone: "green" | "blue" | "amber" | "red";
  icon: DashboardIconName;
}) {
  return (
    <article className={`stat-card ${props.tone}`}>
      <div className="stat-icon" aria-hidden="true">
        <DashboardIcon name={props.icon} />
      </div>
      <div>
        <span className="stat-label">{props.label}</span>
        <strong>{props.value}</strong>
        <p>{props.detail}</p>
      </div>
    </article>
  );
}

function Panel(props: {
  title: string;
  icon?: DashboardIconName;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={["panel", props.className].filter(Boolean).join(" ")}>
      <div className="panel-header">
        <h3>
          {props.icon && <DashboardIcon name={props.icon} />}
          {props.title}
        </h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function ApiErrorList(props: { errors: Array<string | null> }) {
  const errors = props.errors.filter((error): error is string => error !== null);
  if (errors.length === 0) return null;
  return (
    <section className="api-error">
      <strong>Local API error</strong>
      {[...new Set(errors)].map((error) => (
        <p key={error}>{error}</p>
      ))}
    </section>
  );
}

function WarningList(props: { warnings: string[]; compact?: boolean }) {
  if (props.warnings.length === 0) return null;
  return (
    <section className={props.compact ? "warning-list compact" : "warning-list"}>
      {props.warnings.map((warning) => (
        <p className="warn" key={warning}>
          {warning}
        </p>
      ))}
    </section>
  );
}

function AgentDetectBadge(props: { detected: boolean }) {
  return props.detected ? (
    <span className="tag green">detected</span>
  ) : (
    <span className="tag amber">not found</span>
  );
}

function resourceIcon(kind: Capability): DashboardIconName {
  if (kind === "mcp") return "database";
  if (kind === "rules") return "rules";
  return "artifacts";
}

function statusIcon(status: string): DashboardIconName {
  if (status === "ready" || status === "managed" || status === "synced" || status === "detected") {
    return "check";
  }
  if (status === "discovered" || status === "pending") return "info";
  if (status === "unsupported" || status === "disabled") return "disabled";
  if (status === "not-found" || status === "missing" || status === "broken-link") return "error";
  return "warning";
}

function readinessTone(status: string): "green" | "amber" | "red" | "neutral" {
  if (status === "ready") return "green";
  if (status === "warning" || status === "detected") return "amber";
  if (status === "not-found" || status === "missing") return "red";
  return "neutral";
}

function adapterInitials(displayName: string, id: string): string {
  if (id === "claude-code") return "CC";
  if (id === "codex") return "Cx";
  if (id === "cursor") return "Cu";
  return displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function adapterTone(id: string): string {
  if (id === "claude-code") return "sun";
  if (id === "codex") return "ink";
  if (id === "cursor") return "steel";
  return "default";
}

function countResourcesByKind(
  resources: readonly Pick<ControlPlaneResourceDto, "kind">[],
): Record<Capability, number> {
  return {
    skills: resources.filter((resource) => resource.kind === "skills").length,
    mcp: resources.filter((resource) => resource.kind === "mcp").length,
    rules: resources.filter((resource) => resource.kind === "rules").length,
  };
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
