import type { Capability } from "@cellarer/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { client } from "./api.js";

type Page = "dashboard" | "artifacts" | "distribute" | "scan" | "secrets";
type Scope = "global" | "project";
type DriftStatus = "ok" | "drifted" | "missing" | "broken-link";

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
  { page: "secrets", label: "Secrets", detail: "References" },
];

const PAGE_META: Record<Page, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Unified management of local agent configuration artifacts.",
  },
  artifacts: {
    title: "Artifacts",
    subtitle: "Rules, MCP servers, skills, and channel tags in the cellarer store.",
  },
  distribute: {
    title: "Distribute",
    subtitle: "Preview a plan first, then apply the generated changes through core.",
  },
  scan: {
    title: "Scan Preview",
    subtitle: "Read native agent files and preview import candidates without writing.",
  },
  secrets: {
    title: "Secret References",
    subtitle: "Reference names only. Secret values are not returned by the Web API.",
  },
};

const CAPABILITIES: Capability[] = ["rules", "mcp", "skills"];
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

interface ArtifactRow {
  id: string;
  name: string;
  channels: string[];
}
interface Artifacts {
  rules: ArtifactRow[];
  mcp: ArtifactRow[];
  skills: ArtifactRow[];
  channels: string[];
}
interface AgentInfo {
  id: string;
  displayName: string;
  capabilities: Record<string, string[]>;
  detected: boolean;
  root: string;
}
interface StatusItem {
  artifact: string;
  agent: string;
  scope: Scope;
  capability: Capability;
  target: string;
  status: DriftStatus;
}

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
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
          {page === "dashboard" && <Dashboard onNavigate={setPage} />}
          {page === "artifacts" && <ArtifactsPage />}
          {page === "distribute" && <DistributePage />}
          {page === "scan" && <ScanPage />}
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

// 通用 fetch hook(只读 GET)。
function useApi<T>(fetcher: () => Promise<Response>, deps: unknown[] = []): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    fetcher().then(async (r) => {
      if (alive) setData((await r.json()) as T);
    });
    return () => {
      alive = false;
    };
  }, deps);
  return data;
}

function Dashboard(props: { onNavigate: (page: Page) => void }) {
  const arts = useApi<Artifacts>(() => client.api.artifacts.$get());
  const agents = useApi<{ agents: AgentInfo[] }>(() => client.api.agents.$get());
  const st = useApi<{ items: StatusItem[] }>(() => client.api.status.$get());
  const secrets = useApi<{ names: string[] }>(() => client.api.secrets.$get());

  const artifactTotal =
    arts === null ? null : arts.rules.length + arts.mcp.length + arts.skills.length;
  const detectedAgentCount = agents?.agents.filter((agent) => agent.detected).length ?? null;
  const driftItems = st?.items.filter((i) => i.status !== "ok") ?? [];
  const ledgerTotal = st?.items.length ?? null;
  const secretCount = secrets?.names.length ?? null;
  const isEmptyStore =
    arts !== null && st !== null && secrets !== null && artifactTotal === 0 && ledgerTotal === 0;

  return (
    <div className="page-stack">
      <section className="stat-grid" aria-label="Dashboard summary">
        <StatCard
          label="Detected Agents"
          value={detectedAgentCount ?? "..."}
          detail={
            agents
              ? `${detectedAgentCount ?? 0} detected · ${agents.agents.length} registered`
              : "Detecting global agent roots"
          }
          tone="green"
        />
        <StatCard
          label="Artifacts"
          value={artifactTotal ?? "..."}
          detail={
            arts
              ? artifactTotal === 0
                ? "No store artifacts yet"
                : `Rules ${arts.rules.length} · MCP ${arts.mcp.length} · Skills ${arts.skills.length}`
              : "Loading store inventory"
          }
          tone="blue"
        />
        <StatCard
          label="Drift Items"
          value={st ? driftItems.length : "..."}
          detail={
            st
              ? ledgerTotal === 0
                ? "No apply ledger yet"
                : `${ledgerTotal ?? 0} tracked ledger ${ledgerTotal === 1 ? "entry" : "entries"}`
              : "Loading ledger status"
          }
          tone={driftItems.length > 0 ? "red" : "green"}
        />
        <StatCard
          label="Secret Refs"
          value={secretCount ?? "..."}
          detail={secretCount === 0 ? "No ledger secret refs yet" : "Reference names only"}
          tone="amber"
        />
      </section>

      {isEmptyStore && <EmptyStorePanel onNavigate={props.onNavigate} />}

      <section className="dashboard-grid">
        <Panel
          title="Detected Agents"
          action={
            <button
              type="button"
              className="link-button"
              onClick={() => props.onNavigate("distribute")}
            >
              Open distribute
            </button>
          }
        >
          {!agents ? (
            <p className="empty-state">Loading registered adapters...</p>
          ) : agents.agents.length === 0 ? (
            <p className="empty-state">No adapters registered.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Root</th>
                    <th>Rules</th>
                    <th>MCP</th>
                    <th>Skills</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.agents.map((agent) => (
                    <tr key={agent.id}>
                      <td>
                        <strong>{agent.displayName}</strong>
                        <span className="muted-row">{agent.id}</span>
                      </td>
                      <td>
                        <AgentDetectBadge detected={agent.detected} />
                      </td>
                      <td className="path-cell mono">{agent.root}</td>
                      {CAPABILITIES.map((capability) => (
                        <td key={capability}>
                          <CapabilityScopes scopes={agent.capabilities[capability] ?? []} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Store Inventory"
          action={
            <button
              type="button"
              className="link-button"
              onClick={() => props.onNavigate("artifacts")}
            >
              View artifacts
            </button>
          }
        >
          {!arts ? (
            <p className="empty-state">Loading artifacts...</p>
          ) : (
            <div className="inventory-list">
              <InventoryRow label="Rules" count={arts.rules.length} />
              <InventoryRow label="MCP" count={arts.mcp.length} />
              <InventoryRow label="Skills" count={arts.skills.length} />
              <div className="channel-row">
                <span>Channels</span>
                <div>
                  {arts.channels.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    arts.channels.map((channel) => (
                      <span className="tag blue" key={channel}>
                        {channel}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Ledger Status"
          action={
            <button
              type="button"
              className="link-button"
              onClick={() => props.onNavigate("distribute")}
            >
              Re-plan
            </button>
          }
        >
          {!st ? (
            <p className="empty-state">Loading ledger status...</p>
          ) : st.items.length === 0 ? (
            <p className="empty-state">No ledger entries yet.</p>
          ) : driftItems.length === 0 ? (
            <p className="ok-state">All tracked ledger entries are ok.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Artifact</th>
                    <th>Scope</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {driftItems.map((item) => (
                    <tr key={`${item.agent}-${item.capability}-${item.target}`}>
                      <td>{item.agent}</td>
                      <td>
                        <span className="mono">{item.artifact}</span>
                        <span className="muted-row">{item.capability}</span>
                      </td>
                      <td>{item.scope}</td>
                      <td>
                        <StatusBadge status={item.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
          {!secrets ? (
            <p className="empty-state">Loading secret references...</p>
          ) : secrets.names.length === 0 ? (
            <p className="empty-state">No secret references recorded.</p>
          ) : (
            <div className="secret-list">
              {secrets.names.slice(0, 8).map((name) => (
                <span className="tag amber mono" key={name}>
                  {name}
                </span>
              ))}
              {secrets.names.length > 8 && (
                <span className="muted">+{secrets.names.length - 8} more</span>
              )}
            </div>
          )}
        </Panel>
      </section>
    </div>
  );
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

function Panel(props: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>{props.title}</h3>
        {props.action}
      </div>
      {props.children}
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

function CapabilityScopes(props: { scopes: string[] }) {
  if (props.scopes.length === 0) return <span className="muted">not supported</span>;
  return (
    <div className="capability-scopes">
      {props.scopes.map((scope) => (
        <span className="tag green" key={scope}>
          {scope}
        </span>
      ))}
    </div>
  );
}

function StatusBadge(props: { status: DriftStatus }) {
  const tone = props.status === "ok" ? "green" : props.status === "drifted" ? "amber" : "red";
  return <span className={`tag ${tone}`}>{STATUS_LABELS[props.status]}</span>;
}

function ArtifactsPage() {
  const arts = useApi<Artifacts>(() => client.api.artifacts.$get());
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
                        {r.channels.length === 0 ? (
                          <span className="muted">no channel</span>
                        ) : (
                          r.channels.map((ch) => (
                            <span className="tag blue" key={ch}>
                              {ch}
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

interface PlanAction {
  agent: string;
  capability: string;
  scope: string;
  target: string;
  op: string;
  reason?: string;
  preview?: { before?: string; after?: string };
}

function DistributePage() {
  const agents = useApi<{ agents: AgentInfo[] }>(() => client.api.agents.$get());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [caps, setCaps] = useState<Record<string, boolean>>({
    rules: true,
    mcp: true,
    skills: true,
  });
  const [scope, setScope] = useState<Scope>("global");
  const [dir, setDir] = useState("");
  const [result, setResult] = useState<{ actions: PlanAction[]; warnings: string[] } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const chosenAgents = Object.keys(selected).filter((a) => selected[a]);
  const chosenCaps = Object.keys(caps).filter((c) => caps[c]) as Capability[];
  // project 作用域必须提供 dir(与后端一致);否则禁用动作按钮。
  const dirMissing = scope === "project" && dir.trim() === "";
  const disabled = chosenAgents.length === 0 || dirMissing;

  function body() {
    return {
      agents: chosenAgents,
      scope,
      dir: scope === "project" ? dir.trim() : undefined,
      capabilities: chosenCaps,
    };
  }
  async function doPlan() {
    setApplied(null);
    const r = await client.api.plan.$post({ json: body() });
    setResult(await r.json());
  }
  async function doApply() {
    const r = await client.api.apply.$post({ json: body() });
    const j = await r.json();
    setApplied(`Applied ${j.entries.length} item${j.entries.length === 1 ? "" : "s"}`);
    setResult(j.plan);
  }

  return (
    <div className="page-stack">
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
        </div>
        <div className="button-row">
          <button type="button" className="action secondary" disabled={disabled} onClick={doPlan}>
            Preview dry-run
          </button>
          <button type="button" className="action" disabled={disabled} onClick={doApply}>
            Apply
          </button>
        </div>
        {dirMissing && <p className="warn">Project scope requires a project root path.</p>}
        {applied && <p className="ok">{applied}</p>}
      </div>
      {result && (
        <div className="card">
          {result.warnings.map((w) => (
            <p className="warn" key={w}>
              {w}
            </p>
          ))}
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
        </div>
      )}
    </div>
  );
}

interface ScanItem {
  kind: string;
  name: string;
  status: string;
  action: string;
  secretRefs?: string[];
  source: string;
}

function ScanPage() {
  const agents = useApi<{ agents: AgentInfo[] }>(() => client.api.agents.$get());
  const [agent, setAgent] = useState("");
  const [scope, setScope] = useState<Scope>("global");
  const [dir, setDir] = useState("");
  const [plan, setPlan] = useState<{ items: ScanItem[]; warnings: string[] } | null>(null);

  const dirMissing = scope === "project" && dir.trim() === "";
  const disabled = !agent || dirMissing;

  async function doScan() {
    const r = await client.api.scan.$post({
      json: { agent, scope, dir: scope === "project" ? dir.trim() : undefined },
    });
    setPlan(await r.json());
  }
  return (
    <div className="page-stack">
      <div className="card">
        <div className="control-grid two">
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
        </div>
        <div className="button-row">
          <button type="button" className="action" disabled={disabled} onClick={doScan}>
            Preview Scan
          </button>
        </div>
        {dirMissing && <p className="warn">Project scope requires a project root path.</p>}
      </div>
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
                    <th>Type</th>
                    <th>Name</th>
                    <th>Action</th>
                    <th>Secret refs</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map((it) => (
                    <tr key={`${it.kind}-${it.name}`}>
                      <td>{it.kind}</td>
                      <td className="mono">{it.name}</td>
                      <td className={it.action === "skip" ? "danger" : "ok"}>{it.action}</td>
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

function SecretsPage() {
  const data = useApi<{ names: string[] }>(() => client.api.secrets.$get());
  return (
    <div className="page-stack">
      <div className="card">
        <p className="muted">Only reference names are shown. Values remain masked.</p>
        {!data ? (
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
