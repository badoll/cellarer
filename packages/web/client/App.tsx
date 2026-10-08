import type {
  Capability,
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
  DashboardAgentReadiness,
  DashboardCoverageGroup,
  DashboardSummaryResult,
} from "@cellarer/core/client-api";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AgentsPage } from "./agents-page.js";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { DashboardIcon, type DashboardIconName } from "./dashboard-icons.js";
import { InventoryPage } from "./inventory-page.js";
import { LibraryPage } from "./library-page.js";
import { OperationHistoryPage } from "./operation-history-page.js";
import { OverviewPage } from "./overview-page.js";
import {
  configurationLabel,
  type Page,
  RESOURCE_KINDS,
  type ResourceState,
  resourceKindLabel,
} from "./product-model.js";
import { ProfilesPage } from "./profiles-page.js";
import { SettingsPage } from "./settings-page.js";
import { SyncWorkspace } from "./sync-workspace.js";
import { browserWorkbenchLocale, type PrimaryPage, workbenchLabels } from "./workbench-labels.js";

interface NavItem {
  page: PrimaryPage;
  icon: DashboardIconName;
}

interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { page: "dashboard", icon: "dashboard" },
  { page: "library", icon: "artifacts" },
  { page: "sync", icon: "apply" },
  { page: "agents", icon: "agent" },
  { page: "history", icon: "activity" },
  { page: "settings", icon: "settings" },
];

const PAGE_META: Record<Page, { title: string; subtitle: string }> = {
  library: {
    title: "Agent Config Library",
    subtitle: "Review stored Skills, MCP servers, and Rules before selecting an action.",
  },
  sync: {
    title: "Sync",
    subtitle: "Choose the target and configuration, then review the Core plan.",
  },
  history: {
    title: "Operation History",
    subtitle: "Inspect recorded operations and follow-up actions.",
  },
  profiles: {
    title: "Profiles",
    subtitle: "Desired selections, reviewed reconciliation and consumer uninstall.",
  },
  dashboard: {
    title: "Dashboard",
    subtitle: "Local-first overview of resources, collections, and agent targets.",
  },
  inventory: {
    title: "Inventory",
    subtitle: "Read-only candidates across bounded registered user and project sources.",
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

const RESOURCE_STATE_LABELS: Record<ResourceState, string> = {
  managed: "Managed",
  discovered: "Discovered",
  synced: "Synced",
  drifted: "Drifted",
  missing: "Missing",
  blocked: "Blocked",
};

export function App() {
  const [page, setPage] = useState<Page>("library");
  const [inventoryVisited, setInventoryVisited] = useState(false);
  const [libraryFocusId, setLibraryFocusId] = useState<string | undefined>();
  const labels = workbenchLabels(browserWorkbenchLocale());
  const navigate = (nextPage: Page) => {
    if (nextPage === "library") setLibraryFocusId(undefined);
    if (nextPage === "inventory") setInventoryVisited(true);
    setPage(nextPage);
  };
  return (
    <div className="app">
      <MobileChrome page={page} onNavigate={navigate} labels={labels.navigation} />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
          </div>
          <div>
            <h1>cellarer</h1>
            <p>
              {browserWorkbenchLocale() === "zh-CN"
                ? "统一 Agent 配置 Store"
                : "Unified agent config store"}
            </p>
          </div>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item.page}
              className={page === item.page ? "active" : ""}
              aria-current={page === item.page ? "page" : undefined}
              onClick={() => navigate(item.page)}
            >
              <DashboardIcon name={item.icon} />
              <span>
                <span className="nav-label">{labels.navigation[item.page]}</span>
                <span className="nav-detail">{labels.details[item.page]}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="local-card">
          <DashboardIcon name="database" />
          <div>
            <strong>{browserWorkbenchLocale() === "zh-CN" ? "本地 Store" : "Local Store"}</strong>
            <p>
              {browserWorkbenchLocale() === "zh-CN"
                ? "配置仅存于本机"
                : "Configuration stays local"}
            </p>
          </div>
        </div>
      </aside>
      <main className="main">
        <AppHeader
          page={page}
          onNavigate={navigate}
          title={labels.navigation[page]}
          subtitle={
            page in labels.subtitles
              ? labels.subtitles[page as keyof typeof labels.subtitles]
              : PAGE_META[page].subtitle
          }
        />
        <div className="content">
          {page === "library" && (
            <LibraryPage onNavigate={navigate} initialDetailId={libraryFocusId} />
          )}
          {page === "sync" && <SyncWorkspace onApplied={() => setPage("history")} />}
          {page === "history" && <OperationHistoryPage />}
          {page === "dashboard" && (
            <OverviewPage
              onDiscover={() => navigate("inventory")}
              onOpenResource={(id) => {
                setLibraryFocusId(id);
                setPage("library");
              }}
              onSync={() => setPage("sync")}
              onHistory={() => setPage("history")}
            />
          )}
          {inventoryVisited && (
            <div hidden={page !== "inventory"}>
              <InventoryPage onNavigate={navigate} />
            </div>
          )}
          {page === "profiles" && <ProfilesPage />}
          {page === "agents" && (
            <div className="page-stack">
              <button
                type="button"
                className="action secondary profile-entry"
                onClick={() => setPage("profiles")}
              >
                {labels.navigation.profiles}
              </button>
              <AgentsPage onSync={() => setPage("sync")} />
            </div>
          )}
          {page === "settings" && <SettingsPage onAgents={() => setPage("agents")} />}
        </div>
      </main>
    </div>
  );
}

function MobileChrome(props: {
  page: Page;
  onNavigate: (page: Page) => void;
  labels: Record<Page, string>;
}) {
  return (
    <div className="mobile-chrome">
      <div className="mobile-brand-row">
        <div className="brand compact">
          <div className="brand-mark" aria-hidden="true">
            <span />
          </div>
          <div>
            <h1>cellarer</h1>
            <p>{browserWorkbenchLocale() === "zh-CN" ? "本地控制台" : "Local control plane"}</p>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={browserWorkbenchLocale() === "zh-CN" ? "打开设置" : "Open settings"}
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
            aria-current={props.page === item.page ? "page" : undefined}
            onClick={() => props.onNavigate(item.page)}
          >
            <DashboardIcon name={item.icon} />
            <span>{props.labels[item.page]}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function AppHeader(props: {
  page: Page;
  onNavigate: (page: Page) => void;
  title: string;
  subtitle: string;
}) {
  const zh = browserWorkbenchLocale() === "zh-CN";
  return (
    <>
      <header className="topbar">
        <div className="evidence-flow">
          {[
            {
              number: 1,
              title: zh ? "发现" : "Discover",
              detail: zh ? "从本地与项目中发现配置" : "Inspect local sources",
              page: "inventory" as Page,
            },
            {
              number: 2,
              title: zh ? "入库" : "Store",
              detail: zh ? "写入本地 Store，版本管理" : "Manage Store revisions",
              page: "library" as Page,
            },
            {
              number: 3,
              title: zh ? "下发" : "Sync",
              detail: zh ? "按需下发到 Agent / 项目" : "Review target writes",
              page: "sync" as Page,
            },
            {
              number: 4,
              title: zh ? "验证" : "Verify",
              detail: zh ? "检验生效与实际效果" : "Inspect observed evidence",
              page: "history" as Page,
            },
          ].map((step) => (
            <button
              type="button"
              className={`flow-step ${step.number === 2 ? "current" : ""}`}
              key={step.number}
              onClick={() => props.onNavigate(step.page)}
            >
              <span className="flow-number">{step.number}</span>
              <span className="flow-copy">
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </span>
            </button>
          ))}
        </div>
        <span className="flow-local">
          {zh ? "本地运行　|　数据仅存于本机" : "Runs locally | Data stays here"}
        </span>
      </header>
      <div className="page-heading">
        {props.page === "profiles" && (
          <p className="breadcrumb">{zh ? "Agent / 配置方案" : "Agent / Profiles"}</p>
        )}
        <h2>
          {props.title}
          {props.page === "sync" && zh ? " · 审查计划" : ""}
        </h2>
        <p>{props.subtitle}</p>
      </div>
    </>
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

export function DashboardShell(props: { onNavigate: (page: Page) => void }) {
  const summaryState = useApi<DashboardSummaryResult>(() => apiFetch("/api/v1/summary"), []);
  const resourcesState = useApi<ControlPlaneResourceListDto>(
    () => apiFetch("/api/v1/resources"),
    [],
  );
  const summary = summaryState.data;
  const resourceCounts = resourcesState.data?.counts ?? null;
  const resourceCountsByKind = resourcesState.data
    ? countResourcesByKind(resourcesState.data.resources)
    : null;
  const blockedSyncCount = resourceCounts
    ? resourceCounts.drifted + resourceCounts.missing + resourceCounts.blocked
    : null;

  return (
    <div className="page-stack">
      <ApiErrorList errors={[summaryState.error, resourcesState.error]} />
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
          label="Inventory"
          value={resourceCounts?.discovered ?? "..."}
          detail="Read-only candidates from bounded sources"
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
        <button
          type="button"
          className="resource-shortcut"
          onClick={() => props.onNavigate("inventory")}
        >
          <DashboardIcon name="scan" />
          <span>
            <strong>Review Inventory</strong>
            <span>Inspect candidates before Store import</span>
          </span>
        </button>
        <button
          type="button"
          className="resource-shortcut"
          onClick={() => props.onNavigate("library")}
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
          onClick={() => props.onNavigate("library")}
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
            onClick={() => props.onNavigate("library")}
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

        <Panel title="Recent Activity" icon="activity" className="span-all">
          <ActivityTable events={summary?.latestActivity ?? null} />
        </Panel>
      </section>
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

export function CoverageList(props: { groups: DashboardCoverageGroup[] | null }) {
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
          {group.coverage.items
            .filter((item) => item.outcome !== "covered" && item.outcome !== "no-op")
            .map((item) => (
              <p className="tag amber" key={`${item.agent}:${item.capability}`}>
                {item.agent} · {item.capability}: {item.outcome} ({item.code})
              </p>
            ))}
          <div className="coverage-row">
            <div>
              <strong>{configurationLabel(group.configuration)}</strong>
              <span className="muted-row">Native Agent loading: {group.runtime.observation}</span>
              <span className="muted-row">
                Requests evaluated: {group.coverage.observed}/{group.coverage.expected}
              </span>
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
