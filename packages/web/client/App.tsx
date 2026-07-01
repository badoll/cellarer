import type { Capability } from "@cellarer/core";
import { useEffect, useState } from "react";
import { client } from "./api.js";

type Page = "dashboard" | "artifacts" | "distribute" | "scan" | "secrets";
type Scope = "global" | "project";

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
      <label>
        <input
          type="radio"
          name="scope"
          checked={props.scope === "global"}
          onChange={() => props.onScope("global")}
        />
        global
      </label>
      <label>
        <input
          type="radio"
          name="scope"
          checked={props.scope === "project"}
          onChange={() => props.onScope("project")}
        />
        project
      </label>
      {props.scope === "project" && (
        <input
          type="text"
          className="dir-input"
          placeholder="工程根绝对路径(必填)"
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
}

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const nav: [Page, string][] = [
    ["dashboard", "Dashboard"],
    ["artifacts", "制品"],
    ["distribute", "下发"],
    ["scan", "扫描"],
    ["secrets", "密钥"],
  ];
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>cellarer</h1>
        <nav className="nav">
          {nav.map(([p, label]) => (
            <button
              type="button"
              key={p}
              className={page === p ? "active" : ""}
              onClick={() => setPage(p)}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
        {page === "dashboard" && <Dashboard />}
        {page === "artifacts" && <ArtifactsPage />}
        {page === "distribute" && <DistributePage />}
        {page === "scan" && <ScanPage />}
        {page === "secrets" && <SecretsPage />}
      </main>
    </div>
  );
}

// 通用 fetch hook(只读 GET)。
function useApi<T>(fetcher: () => Promise<Response>, deps: unknown[] = []): T | null {
  const [data, setData] = useState<T | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetcher 由调用方稳定提供
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

function Dashboard() {
  const arts = useApi<Artifacts>(() => client.api.artifacts.$get());
  const agents = useApi<{ agents: AgentInfo[] }>(() => client.api.agents.$get());
  const st = useApi<{ items: { status: string }[] }>(() => client.api.status.$get());
  const drift = st?.items.filter((i) => i.status !== "ok").length ?? 0;
  return (
    <>
      <h2>Dashboard</h2>
      <div className="card">
        <p>
          制品:rules {arts?.rules.length ?? "…"} · mcp {arts?.mcp.length ?? "…"} · skills{" "}
          {arts?.skills.length ?? "…"}
        </p>
        <p>agent 适配器:{agents?.agents.length ?? "…"}</p>
        <p>
          落地状态:{st ? `${st.items.length} 条台账` : "…"}
          {drift > 0 ? (
            <span className="warn"> · {drift} 漂移</span>
          ) : (
            <span className="ok"> · 全部 ok</span>
          )}
        </p>
      </div>
    </>
  );
}

function ArtifactsPage() {
  const arts = useApi<Artifacts>(() => client.api.artifacts.$get());
  if (!arts) return <p>加载中…</p>;
  const groups: [string, ArtifactRow[]][] = [
    ["rules", arts.rules],
    ["mcp", arts.mcp],
    ["skills", arts.skills],
  ];
  return (
    <>
      <h2>库房制品</h2>
      {groups.map(([kind, rows]) => (
        <div className="card" key={kind}>
          <h3>{kind}</h3>
          {rows.length === 0 ? (
            <p className="muted">(空)</p>
          ) : (
            <table>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.name}</td>
                    <td>
                      {r.channels.map((ch) => (
                        <span className="tag" key={ch}>
                          {ch}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </>
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
    setApplied(`已下发 ${j.entries.length} 项`);
    setResult(j.plan);
  }

  return (
    <>
      <h2>下发</h2>
      <div className="card">
        <p>作用域:</p>
        <ScopePicker scope={scope} dir={dir} onScope={setScope} onDir={setDir} />
        <p>选择 agent:</p>
        {agents?.agents.map((a) => (
          <label key={a.id}>
            <input
              type="checkbox"
              checked={!!selected[a.id]}
              onChange={(e) => setSelected((s) => ({ ...s, [a.id]: e.target.checked }))}
            />
            {a.displayName}
          </label>
        ))}
        <p>能力:</p>
        {["rules", "mcp", "skills"].map((cap) => (
          <label key={cap}>
            <input
              type="checkbox"
              checked={!!caps[cap]}
              onChange={(e) => setCaps((s) => ({ ...s, [cap]: e.target.checked }))}
            />
            {cap}
          </label>
        ))}
        <p>
          <button type="button" className="action secondary" disabled={disabled} onClick={doPlan}>
            预览(dry-run)
          </button>{" "}
          <button type="button" className="action" disabled={disabled} onClick={doApply}>
            下发
          </button>
        </p>
        {dirMissing && <p className="warn">project 作用域需填写工程根路径。</p>}
        {applied && <p className="ok">{applied}</p>}
      </div>
      {result && (
        <div className="card">
          {result.warnings.map((w) => (
            <p className="warn" key={w}>
              ⚠ {w}
            </p>
          ))}
          <table>
            <thead>
              <tr>
                <th>agent</th>
                <th>能力</th>
                <th>op</th>
                <th>target</th>
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
                    {a.op === "skip" && a.reason ? <div className="muted">{a.reason}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
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
    <>
      <h2>扫描回写(dry-run)</h2>
      <div className="card">
        <p>作用域:</p>
        <ScopePicker scope={scope} dir={dir} onScope={setScope} onDir={setDir} />
        <label>
          agent:
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">选择…</option>
            {agents?.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>{" "}
        <button type="button" className="action" disabled={disabled} onClick={doScan}>
          扫描
        </button>
        {dirMissing && <p className="warn">project 作用域需填写工程根路径。</p>}
      </div>
      {plan && (
        <div className="card">
          {plan.warnings.map((w) => (
            <p className="warn" key={w}>
              ⚠ {w}
            </p>
          ))}
          {plan.items.length === 0 ? (
            <p className="muted">未发现可回写制品。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>名称</th>
                  <th>动作</th>
                  <th>密钥引用</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((it) => (
                  <tr key={`${it.kind}-${it.name}`}>
                    <td>{it.kind}</td>
                    <td className="mono">{it.name}</td>
                    <td className={it.action === "skip" ? "danger" : "ok"}>{it.action}</td>
                    <td>
                      {(it.secretRefs ?? []).map((r) => (
                        <span className="tag" key={r}>
                          🔑 {r}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

function SecretsPage() {
  const data = useApi<{ names: string[] }>(() => client.api.secrets.$get());
  return (
    <>
      <h2>密钥引用</h2>
      <div className="card">
        <p className="muted">仅显示引用名(真值存于 vault / 环境变量,绝不在此回显)。</p>
        {data?.names.length === 0 ? (
          <p className="muted">(无)</p>
        ) : (
          <ul>
            {data?.names.map((n) => (
              <li key={n} className="mono">
                🔑 {n} <span className="muted">= ••••••••</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
