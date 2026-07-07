import type {
  Capability,
  DashboardAgentReadiness,
  DashboardCoverageGroup,
  DashboardSummaryResult,
  DiscoverySummaryResult,
  ResourceCatalogItem,
  ResourceCatalogResult,
  SettingsSummary,
} from "@cellarer/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { client } from "./api.js";
import { readApiJson } from "./api-state.js";
import { DashboardIcon, type DashboardIconName } from "./dashboard-icons.js";
import {
  type Page,
  RESOURCE_KINDS,
  destinationLabel,
  resourceKindLabel,
  summarizeResourceCounts,
  type ResourceState,
} from "./product-model.js";

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

interface AgentInfo {
  id: string;
  displayName: string;
  capabilities: Partial<Record<Capability, string[]>>;
  detected: boolean;
  root?: string;
}

interface AgentsResponse {
  agents: AgentInfo[];
  warnings: string[];
}

const NAV_ITEMS: NavItem[] = [
  { page: "dashboard", label: "Dashboard", detail: "Overview", icon: "dashboard" },
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

const RESOURCE_STATE_TONES: Record<ResourceState, "green" | "blue" | "amber" | "red" | "neutral"> =
  {
    managed: "green",
    discovered: "blue",
    synced: "green",
    drifted: "amber",
    missing: "red",
    blocked: "amber",
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
  const summaryState = useApi<DashboardSummaryResult>(() => client.api.summary.$get());
  const resourcesState = useApi<ResourceCatalogResult>(() => client.api.resources.$get());
  const discoveryState = useApi<DiscoverySummaryResult>(() => client.api.discovery.$get());
  const settingsState = useApi<SettingsSummary>(() => client.api.settings.$get());
  const summary = summaryState.data;
  const resourceCounts = resourcesState.data
    ? summarizeResourceCounts(resourcesState.data.resources)
    : null;
  const resourceCountsByKind = resourcesState.data
    ? countResourcesByKind(resourcesState.data.resources)
    : null;
  const discovery = discoveryState.data;
  const settings = settingsState.data;

  return (
    <div className="page-stack">
      <ApiErrorList
        errors={[summaryState.error, resourcesState.error, discoveryState.error, settingsState.error]}
      />
      <section className="stat-grid" aria-label="Dashboard summary">
        <StatCard
          label="Managed Resources"
          value={summary?.artifactCounts.total ?? resourceCounts?.managed ?? "..."}
          detail={summary ? resourceCountDetail(summary.artifactCounts) : "Loading resource catalog"}
          tone="blue"
          icon="artifacts"
        />
        <StatCard
          label="Detected Agents"
          value={summary?.agentCounts.detected ?? "..."}
          detail={
            summary
              ? `${summary.agentCounts.ready} ready · ${summary.agentCounts.registered} registered`
              : "Checking local agent roots"
          }
          tone="green"
          icon="agent"
        />
        <StatCard
          label="Discovery"
          value={discovery ? discovery.totals.rules + discovery.totals.mcp + discovery.totals.skills : "..."}
          detail={discovery ? `${destinationLabel(discovery.destination)} sources` : "Scanning readable files"}
          tone="amber"
          icon="rules"
        />
        <StatCard
          label="Collections"
          value={settings?.collections.length ?? summary?.collections.length ?? "..."}
          detail={settings ? defaultCollectionsLabel(settings.defaults.collections) : "Loading defaults"}
          tone="green"
          icon="settings"
        />
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

      <section className="dashboard-grid">
        <Panel title="Agent Readiness" icon="agent">
          {!summary ? (
            <p className="empty-state">Loading registered agents...</p>
          ) : summary.agents.length === 0 ? (
            <p className="empty-state">No registered agents.</p>
          ) : (
            <AgentReadinessList agents={summary.agents} />
          )}
        </Panel>

        <Panel title="Collection Coverage" icon="settings">
          <CoverageList groups={summary?.distributionCoverage ?? null} />
        </Panel>

        <Panel title="Resource State" icon="artifacts">
          <ResourceCountGrid counts={resourcesState.data?.counts ?? resourceCounts} />
        </Panel>

        <Panel title="Discovery Summary" icon="rules">
          <DiscoveryPanel discovery={discovery} />
        </Panel>

        <Panel title="Recent Activity" icon="activity" className="span-all">
          <ActivityTable events={summary?.latestActivity ?? null} />
        </Panel>
      </section>
    </div>
  );
}

function ResourcePage(props: { kind: Capability }) {
  const state = useApi<ResourceCatalogResult>(
    () => client.api.resources[":kind"].$get({ param: { kind: props.kind } }),
    [props.kind],
  );
  const label = resourceKindLabel(props.kind);
  const counts = state.data?.counts ?? (state.data ? summarizeResourceCounts(state.data.resources) : null);

  return (
    <div className="page-stack">
      <ApiErrorList errors={[state.error]} />
      <section className="resource-toolbar">
        <div>
          <p className="eyebrow">{destinationLabel("user")}</p>
          <h3>{label} resources</h3>
          <p>
            {state.data
              ? `${state.data.resources.length} resources generated at ${formatTime(state.data.generatedAt)}`
              : "Loading resource catalog"}
          </p>
        </div>
        <ResourceCountGrid counts={counts} compact />
      </section>

      {state.loading && !state.data ? (
        <p className="empty-state">Loading {label.toLowerCase()} resources...</p>
      ) : state.data?.resources.length === 0 ? (
        <p className="empty-state">No {label.toLowerCase()} resources found.</p>
      ) : (
        <div className="resource-list">
          {state.data?.resources.map((resource) => (
            <ResourceCard resource={resource} key={resource.id} />
          ))}
        </div>
      )}

      {state.data && state.data.warnings.length > 0 && <WarningList warnings={state.data.warnings} />}
    </div>
  );
}

function AgentsPage() {
  const agentsState = useApi<AgentsResponse>(() => client.api.agents.$get());
  const summaryState = useApi<DashboardSummaryResult>(() => client.api.summary.$get());
  const readinessById = new Map((summaryState.data?.agents ?? []).map((agent) => [agent.id, agent]));

  return (
    <div className="page-stack">
      <ApiErrorList errors={[agentsState.error, summaryState.error]} />
      {agentsState.loading && !agentsState.data ? (
        <p className="empty-state">Loading agents...</p>
      ) : agentsState.data?.agents.length === 0 ? (
        <p className="empty-state">No agents registered.</p>
      ) : (
        <div className="agents-grid">
          {agentsState.data?.agents.map((agent) => (
            <AgentCard
              agent={agent}
              readiness={readinessById.get(agent.id)}
              key={agent.id}
            />
          ))}
        </div>
      )}
      {agentsState.data && agentsState.data.warnings.length > 0 && (
        <WarningList warnings={agentsState.data.warnings} />
      )}
    </div>
  );
}

function SettingsPage() {
  const state = useApi<SettingsSummary>(() => client.api.settings.$get());
  const settings = state.data;

  return (
    <div className="page-stack">
      <ApiErrorList errors={[state.error]} />
      {state.loading && !settings ? (
        <p className="empty-state">Loading settings...</p>
      ) : settings ? (
        <>
          <section className="settings-grid">
            <Panel title="Store" icon="home">
              <dl className="kv-list">
                <div>
                  <dt>Store root</dt>
                  <dd className="mono">{settings.storeRoot}</dd>
                </div>
                <div>
                  <dt>CELLARER_HOME</dt>
                  <dd>{settings.cellarerHomeActive ? "active" : "not active"}</dd>
                </div>
              </dl>
            </Panel>
            <Panel title="Defaults" icon="settings">
              <dl className="kv-list">
                <div>
                  <dt>Method</dt>
                  <dd>{settings.defaults.method}</dd>
                </div>
                <div>
                  <dt>Collections</dt>
                  <dd>{defaultCollectionsLabel(settings.defaults.collections)}</dd>
                </div>
                <div>
                  <dt>Secret mode</dt>
                  <dd>{settings.defaults.secretMode}</dd>
                </div>
              </dl>
            </Panel>
            <Panel title="Adapters" icon="agent">
              <dl className="kv-list">
                <div>
                  <dt>Built in</dt>
                  <dd>{settings.builtinAdapterIds.length}</dd>
                </div>
                <div>
                  <dt>Custom</dt>
                  <dd>{settings.customAdapterIds.length}</dd>
                </div>
              </dl>
            </Panel>
            <Panel title="Secret References" icon="lock">
              {settings.secretRefs.length === 0 ? (
                <p className="empty-state">No ledger secret references.</p>
              ) : (
                <div className="settings-list">
                  {settings.secretRefs.map((ref) => (
                    <span className="tag amber mono" key={ref.name}>
                      {ref.name} · {ref.ledgerEntryCount}
                    </span>
                  ))}
                </div>
              )}
            </Panel>
          </section>

          <Panel title="Collections" icon="settings">
            {settings.collections.length === 0 ? (
              <p className="empty-state">No collections configured.</p>
            ) : (
              <div className="collection-list">
                {settings.collections.map((collection) => (
                  <article className="collection-row" key={collection.name}>
                    <span className="tag blue">{collection.name}</span>
                    <p>{collection.description ?? "No description"}</p>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

function ResourceCard(props: { resource: ResourceCatalogItem }) {
  return (
    <article className="resource-card">
      <div className="resource-card-header">
        <div>
          <span className="tag neutral">{resourceKindLabel(props.resource.kind)}</span>
          <h3>{props.resource.name}</h3>
          <p className="mono">{props.resource.id}</p>
        </div>
        <ResourceStateBadge state={props.resource.state} />
      </div>
      <div className="resource-meta">
        <MetaBlock label="Collections">
          {props.resource.collections.length === 0 ? (
            <span className="muted">default</span>
          ) : (
            props.resource.collections.map((collection) => (
              <span className="tag blue" key={collection}>
                {collection}
              </span>
            ))
          )}
        </MetaBlock>
        {props.resource.sourcePath && (
          <MetaBlock label="Source">
            <span className="mono path-cell">{props.resource.sourcePath}</span>
          </MetaBlock>
        )}
        {props.resource.lastActivityAt && (
          <MetaBlock label="Last activity">
            <span>{formatTime(props.resource.lastActivityAt)}</span>
          </MetaBlock>
        )}
      </div>
      {props.resource.syncTargets.length > 0 && (
        <div className="sync-target-list">
          {props.resource.syncTargets.map((target) => (
            <div className="sync-target" key={`${target.agent}:${target.destination}:${target.target}`}>
              <span>{target.agent}</span>
              <span>{destinationLabel(target.destination)}</span>
              <ResourceStateBadge state={target.state} />
              <span className="mono path-cell">{target.target}</span>
            </div>
          ))}
        </div>
      )}
      {props.resource.secretRefs.length > 0 && (
        <div className="secret-list">
          {props.resource.secretRefs.map((ref) => (
            <span className="tag amber mono" key={ref}>
              {ref}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function AgentCard(props: {
  agent: AgentInfo;
  readiness: DashboardAgentReadiness | undefined;
}) {
  const capabilities = RESOURCE_KINDS.filter((kind) => (props.agent.capabilities[kind] ?? []).length > 0);
  return (
    <article className="agent-card">
      <div className="agent-card-head">
        <span className={`adapter-marker ${adapterTone(props.agent.id)}`} aria-hidden="true">
          {adapterInitials(props.agent.displayName, props.agent.id)}
        </span>
        <div>
          <h3>{props.agent.displayName}</h3>
          <p className="mono">{props.agent.id}</p>
        </div>
        <AgentDetectBadge detected={props.agent.detected} />
      </div>
      <dl className="kv-list compact">
        <div>
          <dt>Root</dt>
          <dd className="mono">{props.agent.root ?? "not detected"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{props.readiness?.status ?? "unknown"}</dd>
        </div>
      </dl>
      <div className="capability-strip">
        {capabilities.length === 0 ? (
          <span className="tag neutral">No capabilities</span>
        ) : (
          capabilities.map((capability) => (
            <span className="tag blue" key={capability}>
              {resourceKindLabel(capability)}
            </span>
          ))
        )}
      </div>
    </article>
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
        <section className="coverage-channel" key={`${group.collection}:${group.scope}`}>
          <div className="coverage-channel-header">
            <div>
              <span className="tag blue">{group.collection}</span>
              <span className="muted">{group.scope}</span>
            </div>
            <div className="coverage-channel-meta">
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
              {group.driftedCount > 0 && <span className="tag amber">{group.driftedCount} drifted</span>}
              {group.missingCount > 0 && <span className="tag red">{group.missingCount} missing</span>}
              {group.blockedCount > 0 && <span className="tag amber">{group.blockedCount} blocked</span>}
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
      {props.discovery.warnings.length > 0 && <WarningList warnings={props.discovery.warnings} compact />}
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

function ResourceStateBadge(props: { state: ResourceState }) {
  return (
    <span className={`tag status-badge ${RESOURCE_STATE_TONES[props.state]}`}>
      <DashboardIcon name={statusIcon(props.state)} />
      {RESOURCE_STATE_LABELS[props.state]}
    </span>
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

function MetaBlock(props: { label: string; children: ReactNode }) {
  return (
    <div className="meta-block">
      <span>{props.label}</span>
      <div>{props.children}</div>
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

function resourceCountDetail(counts: DashboardSummaryResult["artifactCounts"]): string {
  return `Skills ${counts.skills} · MCP ${counts.mcp} · Rules ${counts.rules}`;
}

function countResourcesByKind(resources: ResourceCatalogItem[]): Record<Capability, number> {
  return {
    skills: resources.filter((resource) => resource.kind === "skills").length,
    mcp: resources.filter((resource) => resource.kind === "mcp").length,
    rules: resources.filter((resource) => resource.kind === "rules").length,
  };
}

function defaultCollectionsLabel(collections: string[]): string {
  return collections.length === 0 ? "default" : collections.join(", ");
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
