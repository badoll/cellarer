import type { MutationPlan } from "@cellarer/core/client-api";
import { useLayoutEffect, useRef, useState } from "react";
import { apiFetch, type VersionedClientApiPath } from "./api.js";
import { ClientApiError, readApiJson } from "./api-state.js";

export interface WorkflowAction {
  title: string;
  description: string;
  planPath: VersionedClientApiPath;
  applyPath: VersionedClientApiPath;
  input: Record<string, unknown>;
  applyInput?: Record<string, unknown>;
  success: string;
}
export interface WorkflowPreview {
  plan?:
    | MutationPlan
    | { actions?: readonly Record<string, unknown>[]; warnings?: readonly string[] };
  mutationPlan?: MutationPlan;
  blocked?: readonly string[];
  conflicts?: readonly { message?: string; code?: string }[];
  targets?: readonly {
    key: string;
    target: string;
    proposedAction?: string;
    consumerSet?: readonly string[];
    blocked?: boolean;
    blockReason?: string;
  }[];
  targetKeys?: readonly string[];
  [key: string]: unknown;
}

export async function workflowPost<T>(path: VersionedClientApiPath, input: unknown): Promise<T> {
  return readApiJson<T>(
    await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}
export function workflowError(error: unknown): string {
  if (!(error instanceof ClientApiError))
    return error instanceof Error ? error.message : String(error);
  const next =
    error.code === "RECOVERY_REQUIRED"
      ? "Inspect the operation journal and follow Core recovery guidance before another mutation."
      : "Review the blocker, then request a new preview. No mutation was retried.";
  return `${error.code}: ${error.message}. ${next}${error.details ? ` ${JSON.stringify(error.details)}` : ""}`;
}
async function workflowFailure(error: unknown): Promise<string> {
  const original = workflowError(error);
  if (!(error instanceof ClientApiError) || error.code !== "LOCK_CONFLICT") return original;
  try {
    const readiness = await readApiJson<{ blockers: { code: string; operationId?: string }[] }>(
      await apiFetch("/api/v1/readiness"),
    );
    const recovery = readiness.blockers.filter((blocker) => blocker.code === "RECOVERY_REQUIRED");
    return recovery.length
      ? `${original} Readiness: ${JSON.stringify(recovery)}. Inspect the operation journal and follow Core recovery guidance before another mutation.`
      : original;
  } catch {
    return original;
  }
}
export function previewAuthority(preview: WorkflowPreview): MutationPlan | null {
  if (
    preview.blocked?.length ||
    preview.conflicts?.length ||
    preview.targets?.some((target) => target.blocked)
  )
    return null;
  const nested = preview.plan as { targets?: readonly { blocked?: boolean }[] } | undefined;
  const transition = preview.mutationPlan?.normalizedInputs.reconciliation as
    | { blocked?: readonly unknown[] }
    | undefined;
  if (nested?.targets?.some((target) => target.blocked) || transition?.blocked?.length) return null;
  if (preview.mutationPlan) return preview.mutationPlan;
  return preview.plan && "authorization" in preview.plan ? (preview.plan as MutationPlan) : null;
}

export function WorkflowDialog({
  action,
  onClose,
  onApplied,
}: {
  action: WorkflowAction;
  onClose(): void;
  onApplied(message: string): void;
}) {
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const generation = useRef(0);
  const applying = useRef(false);
  const key = JSON.stringify(action);
  useLayoutEffect(() => {
    generation.current++;
    setPreview(null);
    setError(null);
    setBusy(null);
    return () => {
      generation.current++;
    };
  }, [key]);
  async function plan() {
    if (applying.current) return;
    const token = ++generation.current;
    setPreview(null);
    setError(null);
    setBusy("preview");
    try {
      const result = await workflowPost<WorkflowPreview>(action.planPath, action.input);
      if (token === generation.current) setPreview(result);
    } catch (error) {
      const message = await workflowFailure(error);
      if (token === generation.current) setError(message);
    } finally {
      if (token === generation.current) setBusy(null);
    }
  }
  async function apply() {
    const mutationPlan = preview && previewAuthority(preview);
    if (!mutationPlan || applying.current) return;
    applying.current = true;
    const token = generation.current;
    setBusy("apply");
    setError(null);
    try {
      await workflowPost(action.applyPath, {
        ...action.applyInput,
        ...(preview?.targetKeys ? { targetKeys: preview.targetKeys } : {}),
        mutationPlan,
      });
      if (token === generation.current) {
        setPreview(null);
        onApplied(action.success);
      }
    } catch (error) {
      if (token === generation.current) setPreview(null);
      const message = await workflowFailure(error);
      if (token === generation.current) setError(message);
    } finally {
      applying.current = false;
      if (token === generation.current) setBusy(null);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal sync-modal workflow-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={action.title}
      >
        <div className="panel-header modal-header">
          <div>
            <h3>{action.title}</h3>
            <p>{action.description}</p>
          </div>
          <button type="button" disabled={busy === "apply"} onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted">
          Confirm applies only this reviewed plan. Closing discards the preview.
        </p>
        <div className="button-row">
          <button
            className="action secondary"
            type="button"
            disabled={busy !== null}
            onClick={plan}
          >
            {busy === "preview" ? "Previewing..." : "Preview"}
          </button>
          <button
            className="action"
            type="button"
            disabled={busy !== null || !preview || !previewAuthority(preview)}
            onClick={apply}
          >
            {busy === "apply" ? "Applying..." : "Confirm"}
          </button>
        </div>
        {error && (
          <p className="api-error" role="alert">
            {error}
          </p>
        )}
        {preview && <PreviewSummary preview={preview} />}
      </section>
    </div>
  );
}
function PreviewSummary({ preview }: { preview: WorkflowPreview }) {
  const transition = preview.mutationPlan?.normalizedInputs.reconciliation as
    | {
        changes?: readonly {
          target: string;
          selector: string;
          outcome: string;
          attribution: string;
        }[];
        blocked?: readonly { target: string; code: string }[];
      }
    | undefined;
  const actions = preview.plan && "actions" in preview.plan ? preview.plan.actions : undefined;
  return (
    <section className="sync-plan">
      <h4>Reviewed effects</h4>
      {transition?.changes?.map((change) => (
        <p key={`${change.target}:${change.selector}`}>
          <strong>{change.outcome}</strong> · {change.selector} ·{" "}
          {change.attribution === "unmanaged" ? "User content preserved" : change.attribution} ·{" "}
          {change.target}
        </p>
      ))}
      {transition?.blocked?.map((block) => (
        <p className="warn" key={`${block.target}:${block.code}`}>
          {block.code}: {block.target}
        </p>
      ))}
      {preview.blocked?.map((reason) => (
        <p className="warn" key={reason}>
          {reason}
        </p>
      ))}
      {preview.conflicts?.map((conflict, index) => (
        <p className="warn" key={`${conflict.code}:${index}`}>
          {conflict.code}: {conflict.message}
        </p>
      ))}
      {preview.targets?.map((target) => (
        <p key={target.key}>
          <strong>{target.proposedAction ?? "Target"}</strong> · {target.target}
          <br />
          Consumers before: {target.consumerSet?.join(", ") ?? "See receipt"}
          {target.blockReason && <span className="warn"> · {target.blockReason}</span>}
        </p>
      ))}
      {actions?.map((raw, index) => {
        const action = raw as unknown as Record<string, unknown>;
        return (
          <p key={String(action.actionId ?? index)}>
            <strong>{String(action.op ?? action.kind ?? "Store change")}</strong> ·{" "}
            {String(
              action.target ?? action.resourceId ?? action.actionId ?? "Reviewed Store document",
            )}
            <span className="muted-row">{action.reason as string | undefined}</span>
          </p>
        );
      })}
      {!previewAuthority(preview) && (
        <p className="warn">
          Blocked. Resolve these dependencies or conflicts before a new preview.
        </p>
      )}
      <details>
        <summary>Full plan and dependency evidence</summary>
        <pre>{JSON.stringify(preview, null, 2)}</pre>
      </details>
    </section>
  );
}
