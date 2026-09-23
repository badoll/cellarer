import type {
  Capability,
  ClientSyncProfile,
  ClientSyncProfileDesiredState,
  ConfigurationOutcome,
  ControlPlaneResourceListDto,
  VerificationRuntimeEvidence,
} from "@cellarer/core/client-api";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentPicker } from "./agent-picker.js";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import { configurationLabel } from "./product-model.js";
import {
  type WorkflowAction,
  WorkflowDialog,
  workflowError,
  workflowPost,
} from "./workflow-dialog.js";

const emptyDesired = (): ClientSyncProfileDesiredState => ({
  agentIds: [],
  scope: "project",
  resourceIds: [],
  collectionIds: [],
  capabilities: ["mcp"],
  method: "copy",
  mergePolicy: "merge",
});
interface Verification {
  configuration: ConfigurationOutcome;
  desiredVsApplied: { status: string };
  appliedVsDisk: { status: string };
  runtime: VerificationRuntimeEvidence;
  recovery: unknown;
  coverage: unknown;
}
export function ProfilesPage() {
  const [profiles, setProfiles] = useState<ClientSyncProfile[]>([]);
  const [library, setLibrary] = useState<ControlPlaneResourceListDto | null>(null);
  const [collections, setCollections] = useState<{ name: string }[]>([]);
  const [profileId, setProfileId] = useState("");
  const [editing, setEditing] = useState(false);
  const [desired, setDesired] = useState(emptyDesired);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [selection, setSelection] = useState<"ids" | "collections" | "mixed">("ids");
  const [historicalIds, setHistoricalIds] = useState<string[]>([]);
  const verifyGeneration = useRef(0);
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([
      apiFetch("/api/v1/profiles").then(readApiJson<{ profiles: ClientSyncProfile[] }>),
      apiFetch("/api/v1/resources?includeDiscovered=false").then(
        readApiJson<ControlPlaneResourceListDto>,
      ),
      apiFetch("/api/v1/collections").then(readApiJson<{ collections: { name: string }[] }>),
    ])
      .then(([list, resources, groups]) => {
        if (alive) {
          setProfiles(list.profiles);
          setLibrary(resources);
          setCollections(groups.collections);
        }
      })
      .catch((error) => {
        if (alive) setError(workflowError(error));
      });
    return () => {
      alive = false;
    };
  }, [reload]);
  const saved = profiles.find((profile) => profile.profileId === profileId);
  const invocation = desired.scope === "project" ? { workspaceRoot: workspaceRoot.trim() } : {};
  const invocationReady = !!saved && (saved.desired.scope !== "project" || !!workspaceRoot.trim());
  useLayoutEffect(() => {
    verifyGeneration.current++;
    setVerification(null);
    return () => {
      verifyGeneration.current++;
    };
  }, [profileId, workspaceRoot, desired, saved?.revision, reload]);
  function choose(profile?: ClientSyncProfile) {
    setProfileId(profile?.profileId ?? "");
    setDesired(profile?.desired ?? emptyDesired());
    setSelection(
      profile?.desired.collectionIds.length
        ? profile.desired.resourceIds.length
          ? "mixed"
          : "collections"
        : "ids",
    );
    setHistoricalIds(profile?.desired.resourceIds ?? []);
    setEditing(!!profile);
    setVerification(null);
    setError("");
    setAction(null);
  }
  function define() {
    setAction({
      title: editing ? "Edit Profile" : "Create Profile",
      description: `Save ${profileId}: ${desired.scope}; agents ${desired.agentIds.join(", ")}; resources ${desired.resourceIds.join(", ") || "none"}; Collections ${desired.collectionIds.join(", ") || "none"}. Reconciliation is a separate target operation.`,
      planPath: "/api/v1/profiles/plan",
      applyPath: "/api/v1/profiles/apply",
      input: { action: editing ? "update" : "create", profileId, desired },
      success: "Profile saved. Target deployment is pending until separately reconciled.",
    });
  }
  function target(operation: "sync" | "uninstall") {
    if (!saved) return;
    const input = saved.desired.scope === "project" ? { workspaceRoot: workspaceRoot.trim() } : {};
    setAction({
      title: operation === "sync" ? "Reconcile Profile" : "Uninstall Profile consumers",
      description:
        operation === "sync"
          ? `Review additions, updates and managed removals for ${saved.profileId}; user content and remaining consumers are preserved.`
          : `Detach only consumers belonging to ${saved.profileId}. Shared content stays until its final consumer can be removed according to receipts. Store resources and Profile remain.`,
      planPath: `/api/v1/profiles/${encodeURIComponent(saved.profileId)}/${operation}/plan`,
      applyPath: `/api/v1/profiles/${encodeURIComponent(saved.profileId)}/${operation}/apply`,
      input,
      applyInput: input,
      success:
        operation === "sync"
          ? "Profile reconciled. Verify configuration separately; native loading remains unverified."
          : "Selected Profile consumers uninstalled. Shared target handling followed the reviewed receipt.",
    });
  }
  async function verify() {
    if (!saved) return;
    const token = ++verifyGeneration.current;
    setVerification(null);
    setError("");
    try {
      const result = await workflowPost<Verification>(
        `/api/v1/profiles/${encodeURIComponent(saved.profileId)}/verify`,
        saved.desired.scope === "project" ? { workspaceRoot: workspaceRoot.trim() } : {},
      );
      if (token === verifyGeneration.current) setVerification(result);
    } catch (error) {
      if (token === verifyGeneration.current) setError(workflowError(error));
    }
  }
  const changed = !!saved && profileSelectionKey(saved.desired) !== profileSelectionKey(desired);
  return (
    <div className="page-stack">
      <section className="panel workflow-panel">
        <h3>Profiles and deployments</h3>
        <p>Save a reusable selection, then separately preview its target changes.</p>
        <div className="button-row">
          <button type="button" onClick={() => choose()}>
            New Profile
          </button>
          {profiles.map((profile) => (
            <button type="button" key={profile.profileId} onClick={() => choose(profile)}>
              {profile.profileId}
            </button>
          ))}
        </div>
        <label className="field-row stacked">
          <span>Profile ID</span>
          <input
            type="text"
            value={profileId}
            disabled={editing}
            onChange={(event) => setProfileId(event.target.value)}
          />
        </label>
        <label className="field-row stacked">
          <span>Profile scope</span>
          <select
            value={desired.scope}
            onChange={(event) => {
              setDesired({ ...desired, scope: event.target.value as "global" | "project" });
              setVerification(null);
            }}
          >
            <option value="project">Project</option>
            <option value="global">User</option>
          </select>
        </label>
        {(desired.scope === "project" || saved?.desired.scope === "project") && (
          <label className="field-row stacked">
            <span>Workspace root</span>
            <input
              type="text"
              value={workspaceRoot}
              onChange={(event) => {
                setWorkspaceRoot(event.target.value);
                setVerification(null);
              }}
              placeholder="Absolute project path (not saved in Profile)"
            />
          </label>
        )}
        <fieldset>
          <legend>Resource kinds</legend>
          {(["rules", "mcp", "skills"] as Capability[]).map((kind) => (
            <label className="field-row" key={kind}>
              <input
                type="checkbox"
                checked={desired.capabilities.includes(kind)}
                onChange={() =>
                  setDesired({ ...desired, capabilities: toggle(desired.capabilities, kind) })
                }
              />
              {kind}
            </label>
          ))}
        </fieldset>
        <AgentPicker
          scope={desired.scope}
          dir={workspaceRoot}
          kinds={desired.capabilities}
          value={desired.agentIds}
          onChange={(agentIds) => setDesired({ ...desired, agentIds })}
        />
        <label className="field-row stacked">
          <span>Profile selection mode</span>
          <select
            value={selection}
            onChange={(event) => {
              setSelection(event.target.value as "ids" | "collections");
              setDesired({ ...desired, resourceIds: [], collectionIds: [] });
            }}
          >
            <option value="ids">Exact resources</option>
            <option value="collections">Collections</option>
            {selection === "mixed" && (
              <option value="mixed">Exact resources and Collections</option>
            )}
          </select>
        </label>
        <fieldset>
          <legend>{selection === "ids" ? "Exact resources" : "Collections"}</legend>
          {selection !== "collections" &&
            library?.resources
              .filter(
                (resource) =>
                  desired.capabilities.includes(resource.kind) ||
                  desired.resourceIds.includes(resource.id),
              )
              .map((resource) => (
                <label className="field-row" key={resource.id}>
                  <input
                    type="checkbox"
                    checked={desired.resourceIds.includes(resource.id)}
                    onChange={() =>
                      setDesired({
                        ...desired,
                        resourceIds: toggle(desired.resourceIds, resource.id),
                      })
                    }
                  />
                  {resource.id}
                </label>
              ))}
          {selection !== "ids" &&
            collections.map((collection) => (
              <label className="field-row" key={collection.name}>
                <input
                  type="checkbox"
                  checked={desired.collectionIds.includes(collection.name)}
                  onChange={() =>
                    setDesired({
                      ...desired,
                      collectionIds: toggle(desired.collectionIds, collection.name),
                    })
                  }
                />
                {collection.name}
              </label>
            ))}
        </fieldset>
        <label className="field-row stacked">
          <span>Placement</span>
          <select
            value={desired.method}
            onChange={(event) =>
              setDesired({ ...desired, method: event.target.value as "copy" | "symlink" })
            }
          >
            <option value="copy">Copy</option>
            <option value="symlink">Symlink</option>
          </select>
        </label>
        <button
          className="action"
          type="button"
          disabled={
            !profileId.trim() ||
            !desired.agentIds.length ||
            !desired.capabilities.length ||
            (!desired.resourceIds.length && !desired.collectionIds.length)
          }
          onClick={define}
        >
          Review Profile
        </button>
        {saved && (
          <section>
            <h4>Saved deployment</h4>
            <p>
              {changed
                ? "Unsaved edits: save the Profile before reconciling."
                : `Desired revision: ${saved.revision}`}
            </p>
            <div className="button-row">
              <button
                type="button"
                disabled={!invocationReady || changed}
                onClick={() => target("sync")}
              >
                Preview reconciliation
              </button>
              <button type="button" disabled={!invocationReady || changed} onClick={verify}>
                Verify deployment
              </button>
              <button
                type="button"
                disabled={!invocationReady || changed}
                onClick={() => target("uninstall")}
              >
                Preview uninstall
              </button>
              <button
                type="button"
                disabled={!invocationReady || changed || !historicalIds.length}
                onClick={() =>
                  setAction({
                    title: "Historical revert",
                    description:
                      "Restore receipt-backed history for this scope and selected resources. This is distinct from Store removal and consumer uninstall.",
                    planPath: "/api/v1/revert/plan",
                    applyPath: "/api/v1/revert/apply",
                    input: {
                      scope: saved.desired.scope,
                      ...(saved.desired.scope === "project"
                        ? { dir: invocation.workspaceRoot }
                        : {}),
                      agents: saved.desired.agentIds,
                      artifactIds: historicalIds,
                    },
                    applyInput: {
                      scope: saved.desired.scope,
                      ...(saved.desired.scope === "project"
                        ? { dir: invocation.workspaceRoot }
                        : {}),
                      agents: saved.desired.agentIds,
                      artifactIds: historicalIds,
                    },
                    success: "Historical revert completed according to the reviewed receipt.",
                  })
                }
              >
                Preview historical revert
              </button>
            </div>
            <details>
              <summary>Historical revert resources</summary>
              <p>Choose exact resources before previewing receipt-backed history.</p>
              {library?.resources.map((resource) => (
                <label className="field-row" key={resource.id}>
                  <input
                    type="checkbox"
                    checked={historicalIds.includes(resource.id)}
                    onChange={() => setHistoricalIds(toggle(historicalIds, resource.id))}
                  />
                  Revert {resource.id}
                </label>
              ))}
            </details>
          </section>
        )}
        {verification && (
          <section aria-label="Deployment verification">
            <h4>{configurationLabel(verification.configuration)}</h4>
            <p>
              Pending deployment:{" "}
              {verification.desiredVsApplied.status === "diverged" ? "Yes" : "No"}
            </p>
            <p>Disk receipts: {verification.appliedVsDisk.status}</p>
            <p>Native loading: {verification.runtime.observation}</p>
            <details>
              <summary>Coverage and recovery evidence</summary>
              <pre>{JSON.stringify(verification, null, 2)}</pre>
            </details>
          </section>
        )}
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="api-error">
            {error}
          </p>
        )}
      </section>
      {action && (
        <WorkflowDialog
          action={action}
          onClose={() => setAction(null)}
          onApplied={(message) => {
            setAction(null);
            setMessage(message);
            setVerification(null);
            setEditing(true);
            setReload((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
function toggle<T>(items: T[], value: T): T[] {
  return items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
}

export function profileSelectionKey(desired: ClientSyncProfileDesiredState): string {
  return JSON.stringify({
    ...desired,
    agentIds: [...desired.agentIds].sort(),
    resourceIds: [...desired.resourceIds].sort(),
    collectionIds: [...desired.collectionIds].sort(),
    capabilities: [...desired.capabilities].sort(),
  });
}
