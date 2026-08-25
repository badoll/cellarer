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

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [adapterForm, setAdapterForm] = useState<AdapterFormState>(EMPTY_ADAPTER_FORM);
  const [adapterPending, setAdapterPending] = useState(false);
  const [postCommitInventoryRefresh, setPostCommitInventoryRefresh] =
    useState<PostCommitInventoryRefresh | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <section className="panel agents-panel">
        <div className="panel-header">
          <h3>Registered agents</h3>
          <span className="tag neutral">{loading ? "Loading" : `${agents.length} agents`}</span>
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
          <div className="table-wrap agents-table-wrap">
            <table className="agents-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Root</th>
                  <th>Capabilities</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <strong>{agent.displayName}</strong>
                      <span className="muted-row mono">{agent.id}</span>
                    </td>
                    <td>
                      <span className={`tag ${agent.detected ? "green" : "amber"}`}>
                        {agent.detected ? "detected" : "missing"}
                      </span>
                    </td>
                    <td className="path-cell mono">
                      {agent.detectionEvidence.root ?? "not detected"}
                    </td>
                    <td>
                      <div className="capability-strip">{capabilityTags(agent)}</div>
                    </td>
                    <td>
                      <label className="switch-row">
                        <input
                          type="checkbox"
                          checked={agent.enabled !== false}
                          disabled={pendingAgentId === agent.id}
                          onChange={(event) => void setEnabled(agent.id, event.target.checked)}
                        />
                        <span>{agent.enabled === false ? "Disabled" : "Enabled"}</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
