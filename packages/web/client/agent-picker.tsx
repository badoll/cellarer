import type { Capability, ControlPlaneAgentListDto, Scope } from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { browserWorkbenchLocale } from "./workbench-labels.js";
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
  const zh = browserWorkbenchLocale() === "zh-CN";
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
      <legend>{zh ? "已注册 Agent 目标" : "Registered Agent targets"}</legend>
      {scope === "project" && !dir?.trim() && (
        <p>
          {zh
            ? "输入项目根目录后查看目标兼容性。"
            : "Enter a project root to inspect target compatibility."}
        </p>
      )}
      {error && <p className="warn">{error}</p>}
      {data?.agents?.map((agent) => {
        const supported = kinds.every((kind) => agent.capabilityScopes[kind].includes(scope));
        return (
          <label className="field-row" key={agent.id}>
            <input
              type="checkbox"
              aria-label={`${zh ? "目标" : "Target"} ${agent.id}`}
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
              <strong>{agent.displayName}</strong> ·{" "}
              {agent.detected ? (zh ? "已检测" : "Detected") : zh ? "未检测" : "Not detected"} ·{" "}
              {!agent.enabled
                ? zh
                  ? "已停用"
                  : "Disabled"
                : supported
                  ? zh
                    ? "支持此范围"
                    : "Supported scope"
                  : zh
                    ? "不支持此范围"
                    : "Unsupported scope"}
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
