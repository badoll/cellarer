import type {
  ControlPlaneAgentDto,
  ControlPlaneAgentListDto,
  PostCommitInventoryRefresh,
} from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { apiFetch, applyPlannedControlPlaneMutation } from "./api.js";
import { readApiJson } from "./api-state.js";
import { RESOURCE_KINDS, resourceKindLabel } from "./product-model.js";

type AgentInfo = ControlPlaneAgentDto;
type AgentsResponse = ControlPlaneAgentListDto;

interface AdapterFormState {
  adapterId: string;
  adapterKind: "builtin" | "custom";
  displayName: string;
  rulesGlobal: string;
  mcpGlobal: string;
  skillsGlobal: string;
}

export const BUILTIN_ADAPTER_IDS = [
  "agents-md",
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "opencode",
  "windsurf",
] as const;

const BUILTIN_ADAPTER_ID_SET = new Set<string>(BUILTIN_ADAPTER_IDS);

const EMPTY_ADAPTER_FORM: AdapterFormState = {
  adapterId: "",
  adapterKind: "custom",
  displayName: "",
  rulesGlobal: "",
  mcpGlobal: "",
  skillsGlobal: "",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AgentsPage({ onSync }: { onSync?: () => void } = {}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [adapterForm, setAdapterForm] = useState<AdapterFormState>(EMPTY_ADAPTER_FORM);
  const [adapterPending, setAdapterPending] = useState(false);
  const [postCommitInventoryRefresh, setPostCommitInventoryRefresh] =
    useState<PostCommitInventoryRefresh | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? null;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await readApiJson<AgentsResponse>(await apiFetch("/api/v1/agents"));
      setAgents([...data.agents]);
      setWarnings([...data.warnings]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function setEnabled(agentId: string, enabled: boolean) {
    setPendingAgentId(agentId);
    setError(null);
    setPostCommitInventoryRefresh(null);
    try {
      await applyPlannedControlPlaneMutation("/api/v1/agents/plan", {
        action: "set-enabled",
        agentId,
        enabled,
      });
      setAgents((current) =>
        current.map((agent) => (agent.id === agentId ? { ...agent, enabled } : agent)),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingAgentId(null);
    }
  }

  async function saveAdapter() {
    const adapterId = adapterForm.adapterId.trim();
    if (!adapterId) return;
    setAdapterPending(true);
    setError(null);
    setPostCommitInventoryRefresh(null);
    try {
      const applied = await applyPlannedControlPlaneMutation("/api/v1/agents/plan", {
        action: "upsert-adapter",
        agentId: adapterId,
        kind: adapterForm.adapterKind,
        adapter: adapterPatch(adapterForm, adapterForm.adapterKind === "builtin"),
      });
      setPostCommitInventoryRefresh(applied.postCommitInventoryRefresh ?? null);
      setAdapterForm(EMPTY_ADAPTER_FORM);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdapterPending(false);
    }
  }

  async function deleteAdapter() {
    const adapterId = adapterForm.adapterId.trim();
    if (!adapterId) return;
    setAdapterPending(true);
    setError(null);
    setPostCommitInventoryRefresh(null);
    try {
      await applyPlannedControlPlaneMutation("/api/v1/agents/plan", {
        action: "remove-adapter",
        agentId: adapterId,
      });
      setAdapterForm(EMPTY_ADAPTER_FORM);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdapterPending(false);
    }
  }

  return (
    <div className="page-stack">
      <div className="agents-workbench">
        <section className="panel agents-panel">
          <div className="panel-header">
            <h3>已注册的 Agent</h3>
            <span className="tag neutral">{loading ? "加载中" : `${agents.length} 个`}</span>
          </div>
          {error && (
            <section className="api-error compact">
              <strong>Local API error</strong>
              <p>{error}</p>
            </section>
          )}
          {loading && agents.length === 0 ? (
            <p className="empty-state">Loading agents...</p>
          ) : agents.length === 0 ? (
            <p className="empty-state">No agents registered.</p>
          ) : (
            <div className="agent-list">
              {agents.map((agent) => (
                <button
                  type="button"
                  className={`agent-list-item ${selected?.id === agent.id ? "selected" : ""}`}
                  key={agent.id}
                  onClick={() => setSelectedId(agent.id)}
                >
                  <span className="agent-list-mark">{agent.displayName.slice(0, 1)}</span>
                  <span>
                    <strong>{agent.displayName}</strong>
                    <small>
                      {agent.id} ·{" "}
                      {agent.adapterKind === "built-in" ? "内置适配器" : "自定义适配器"}
                    </small>
                    <span className="capability-strip">{capabilityTags(agent)}</span>
                  </span>
                  <span className={`tag ${agent.detected ? "green" : "neutral"}`}>
                    {agent.detected ? "已探测" : "未探测"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="panel agent-detail-panel" aria-label="Agent 详情">
          {selected ? (
            <>
              <div className="panel-header">
                <div>
                  <h3>{selected.displayName}</h3>
                  <p>
                    {selected.id} ·{" "}
                    {selected.adapterKind === "built-in" ? "内置适配器" : "自定义适配器"}
                  </p>
                </div>
                <span className={`tag ${selected.detected ? "green" : "neutral"}`}>
                  {selected.detected ? "已探测配置" : "未探测配置"}
                </span>
              </div>
              <p>已注册目标的落点与兼容性证据；配置文件存在不等于 Agent 原生加载。</p>
              <h4>安装与配置位置</h4>
              <dl className="agent-facts">
                <dt>探测根目录</dt>
                <dd className="mono">{selected.detectionEvidence.root ?? "未探测"}</dd>
                <dt>目标路径</dt>
                <dd>
                  {selected.targets.length
                    ? selected.targets.map((target) => (
                        <p
                          className="mono"
                          key={`${target.scope}:${target.capability}:${target.path}`}
                        >
                          {target.scope} · {target.capability} · {target.path}
                        </p>
                      ))
                    : "未返回目标路径"}
                </dd>
                <dt>状态</dt>
                <dd>
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={selected.enabled !== false}
                      disabled={pendingAgentId === selected.id}
                      onChange={(event) => void setEnabled(selected.id, event.target.checked)}
                    />
                    {selected.enabled === false ? "已禁用" : "已启用"}
                  </label>
                </dd>
              </dl>
              <h4>能力与兼容性</h4>
              <div className="table-wrap">
                <table className="agent-compatibility-table">
                  <thead>
                    <tr>
                      <th>能力</th>
                      <th>范围</th>
                      <th>支持证据</th>
                      <th>原生加载</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.compatibility.map((item) => (
                      <tr key={`${item.capability}:${item.scope}`}>
                        <td>{resourceKindLabel(item.capability)}</td>
                        <td>{item.scope}</td>
                        <td>
                          {item.evidence} · {item.location ?? "未提供位置"}
                        </td>
                        <td>未验证</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h4>探测与原生加载对比</h4>
              <div className="agent-evidence-pair">
                <div>
                  <strong>探测到配置文件</strong>
                  <p>
                    {selected.detected
                      ? "已探测到配置路径，可继续预览下发。"
                      : "尚未探测到配置路径。"}
                  </p>
                </div>
                <div>
                  <strong>原生加载已验证</strong>
                  <p>未验证；需要 Agent 运行时证据。</p>
                </div>
              </div>
              {onSync && (
                <button type="button" className="action" onClick={onSync}>
                  预览同步
                </button>
              )}
            </>
          ) : (
            <p className="empty-state">没有已注册的 Agent。</p>
          )}
        </section>
      </div>

      <section className="panel adapter-config-panel">
        <div className="panel-header">
          <h3>Adapter configuration</h3>
          <span className="tag blue">Override or custom</span>
        </div>
        <div className="adapter-form-grid">
          <label className="field-row stacked">
            <span>Adapter id</span>
            <input
              type="text"
              value={adapterForm.adapterId}
              placeholder="codex or my-agent"
              onChange={(event) => setAdapterFormField("adapterId", event.target.value)}
            />
          </label>
          <label className="field-row stacked">
            <span>Display name</span>
            <input
              type="text"
              value={adapterForm.displayName}
              placeholder="Optional"
              onChange={(event) => setAdapterFormField("displayName", event.target.value)}
            />
          </label>
          <label className="field-row stacked">
            <span>Adapter kind</span>
            <select
              value={adapterForm.adapterKind}
              onChange={(event) =>
                setAdapterFormField(
                  "adapterKind",
                  event.target.value === "builtin" ? "builtin" : "custom",
                )
              }
            >
              <option value="custom">Custom definition</option>
              <option value="builtin">Built-in override</option>
            </select>
          </label>
          <label className="field-row stacked">
            <span>Rules global path</span>
            <input
              type="text"
              value={adapterForm.rulesGlobal}
              placeholder="~/.agent/AGENTS.md"
              onChange={(event) => setAdapterFormField("rulesGlobal", event.target.value)}
            />
          </label>
          <label className="field-row stacked">
            <span>MCP global path</span>
            <input
              type="text"
              value={adapterForm.mcpGlobal}
              placeholder="~/.agent/mcp.json"
              onChange={(event) => setAdapterFormField("mcpGlobal", event.target.value)}
            />
          </label>
          <label className="field-row stacked">
            <span>Skills global path</span>
            <input
              type="text"
              value={adapterForm.skillsGlobal}
              placeholder="~/.agent/skills"
              onChange={(event) => setAdapterFormField("skillsGlobal", event.target.value)}
            />
          </label>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="action"
            disabled={adapterPending || adapterForm.adapterId.trim() === ""}
            onClick={saveAdapter}
          >
            Save adapter
          </button>
          <button
            type="button"
            className="action secondary"
            disabled={adapterPending || adapterForm.adapterId.trim() === ""}
            onClick={deleteAdapter}
          >
            Delete custom adapter
          </button>
        </div>
        {postCommitInventoryRefresh && (
          <PostCommitInventoryNotice refresh={postCommitInventoryRefresh} />
        )}
      </section>

      {warnings.length > 0 && (
        <section className="warning-list">
          {warnings.map((warning) => (
            <p className="warn" key={warning}>
              {warning}
            </p>
          ))}
        </section>
      )}
    </div>
  );

  function setAdapterFormField<K extends keyof AdapterFormState>(
    field: K,
    value: AdapterFormState[K],
  ) {
    setAdapterForm((current) => ({ ...current, [field]: value }));
  }
}

export function PostCommitInventoryNotice({
  refresh,
}: {
  readonly refresh: PostCommitInventoryRefresh;
}) {
  return (
    <section className={`inventory-refresh-notice ${refresh.status}`}>
      <strong>Adapter mutation committed</strong>
      <p>
        Inventory refresh {refresh.status} for <code>{refresh.agentId}</code>.
      </p>
      {refresh.status !== "complete" && (
        <p>
          Retry manually: <code>{refresh.retryCommand}</code>
        </p>
      )}
    </section>
  );
}

function capabilityTags(agent: AgentInfo) {
  const supported = RESOURCE_KINDS.filter(
    (kind) => (agent.capabilityScopes[kind] ?? []).length > 0,
  );
  if (supported.length === 0) return <span className="tag neutral">none</span>;
  return supported.map((kind) => (
    <span className="tag blue" key={kind}>
      {resourceKindLabel(kind)} {(agent.capabilityScopes[kind] ?? []).join("/")}
    </span>
  ));
}

export function adapterPatch(
  form: AdapterFormState,
  builtin = BUILTIN_ADAPTER_ID_SET.has(form.adapterId.trim()),
) {
  const displayName = form.displayName.trim();
  const rulesGlobal = form.rulesGlobal.trim();
  const mcpGlobal = form.mcpGlobal.trim();
  const skillsGlobal = form.skillsGlobal.trim();
  return {
    displayName: displayName || undefined,
    rules: rulesGlobal ? { global: rulesGlobal, format: "markdown" as const } : undefined,
    mcp: mcpGlobal ? mcpPatch(mcpGlobal, builtin) : undefined,
    skills: skillsGlobal ? { global: skillsGlobal, format: "dir" as const } : undefined,
  };
}

function mcpPatch(path: string, builtin: boolean) {
  if (builtin) return { global: path };
  return { global: path, format: "json" as const, serversKey: "mcpServers" };
}

export function CompatibilityEvidence({
  evidence,
}: {
  evidence: ControlPlaneAgentDto["compatibility"];
}) {
  return (
    <details>
      <summary>Compatibility evidence</summary>
      {evidence.map((cell) => (
        <div key={`${cell.capability}/${cell.scope}`}>
          <strong>
            {cell.capability}/{cell.scope}: {cell.evidence}
          </strong>
          <p>Native loading: {cell.native} (not verified)</p>
          {cell.location && <code>{cell.location}</code>}
          {cell.prerequisites.map((text) => (
            <p key={text}>{text}</p>
          ))}
          {cell.sources.map((url) => (
            <p key={url}>
              <a href={url} target="_blank" rel="noreferrer">
                Official contract
              </a>
            </p>
          ))}
          <small>Contract {cell.contractVersion}</small>
        </div>
      ))}
    </details>
  );
}
