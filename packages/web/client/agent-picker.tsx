import type { Capability, ControlPlaneAgentListDto, Scope } from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { workflowError } from "./workflow-dialog.js";

export function AgentPicker({
  value,
  onChange,
  scope,
  dir,
  kinds,
  disabled,
}: {
  value: string[];
  onChange(value: string[]): void;
  scope: Scope;
  dir?: string;
  kinds: readonly Capability[];
  disabled?: boolean;
}) {
  const [data, setData] = useState<ControlPlaneAgentListDto | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    if (scope === "project" && !dir?.trim()) return;
    const query = new URLSearchParams({
      scope,
      ...(scope === "project" ? { dir: dir?.trim() ?? "" } : {}),
    });
    apiFetch(`/api/v1/agents?${query}`)
      .then(readApiJson<ControlPlaneAgentListDto>)
      .then((data) => {
        if (alive) setData(data);
      })
      .catch((error) => {
        if (alive) setError(workflowError(error));
      });
    return () => {
      alive = false;
    };
  }, [scope, dir]);
  return (
    <fieldset className="agent-picker" disabled={disabled}>
      <legend>Registered Agent targets</legend>
      {scope === "project" && !dir?.trim() && (
        <p>Enter a project root to inspect target compatibility.</p>
      )}
      {error && <p className="warn">{error}</p>}
      {data?.agents?.map((agent) => {
        const supported = kinds.every((kind) => agent.capabilityScopes[kind].includes(scope));
        return (
          <label className="field-row" key={agent.id}>
            <input
              type="checkbox"
              aria-label={`Target ${agent.id}`}
              checked={value.includes(agent.id)}
              disabled={!supported || !agent.enabled}
              onChange={() =>
                onChange(
                  value.includes(agent.id)
                    ? value.filter((id) => id !== agent.id)
                    : [...value, agent.id],
                )
              }
            />
            <span>
              <strong>{agent.displayName}</strong> · {agent.detected ? "Detected" : "Not detected"}{" "}
              · {!agent.enabled ? "Disabled" : supported ? "Supported scope" : "Unsupported scope"}
              <span className="muted-row">
                {agent.compatibility
                  .filter((cell) => kinds.includes(cell.capability))
                  .map(
                    (cell) =>
                      `${cell.capability}: ${cell.evidence}; native ${cell.native}${cell.prerequisites.length ? ` (${cell.prerequisites.join("; ")})` : ""}`,
                  )
                  .join(" · ")}
              </span>
            </span>
          </label>
        );
      })}
      {data?.warnings.map((warning) => (
        <p className="warn" key={warning}>
          {warning}
        </p>
      ))}
    </fieldset>
  );
}
