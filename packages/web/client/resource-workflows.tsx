import type {
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
} from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { readApiJson } from "./api-state.js";
import {
  type WorkflowAction,
  WorkflowDialog,
  workflowError,
  workflowPost,
} from "./workflow-dialog.js";

export function ResourceWorkflows({
  resource,
  onChanged,
}: {
  resource: ControlPlaneResourceDto;
  onChanged(message: string): void;
}) {
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [evidence, setEvidence] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const resourceId = resource.id;
  const input = { resourceId };
  async function inspect(kind: "dependencies" | "update/check") {
    setError("");
    try {
      setEvidence(await workflowPost(`/api/v1/resources/${kind}`, input));
    } catch (error) {
      setError(workflowError(error));
    }
  }
  if (resource.discovered) return <p>Import from Inventory before managing this resource.</p>;
  return (
    <section>
      <div className="button-row">
        <button type="button" onClick={() => inspect("dependencies")}>
          Show dependencies
        </button>
        <button type="button" onClick={() => inspect("update/check")}>
          Check source update
        </button>
        <button
          type="button"
          onClick={() =>
            setAction({
              title: "Update Store resource",
              description: `Stage and review a source update for ${resourceId}. Agent targets stay unchanged.`,
              planPath: "/api/v1/resources/update/plan",
              applyPath: "/api/v1/resources/update/apply",
              input,
              success:
                "Store update completed. Deployments may be pending; preview reconciliation separately.",
            })
          }
        >
          Preview source update
        </button>
        <button
          type="button"
          onClick={() =>
            setAction({
              title: "Remove from Store",
              description: `Remove only ${resourceId}. Referenced resources are blocked. No cascade, target uninstall or historical revert.`,
              planPath: "/api/v1/resources/remove/plan",
              applyPath: "/api/v1/resources/remove/apply",
              input: { ...input, cascade: false },
              applyInput: { ...input, cascade: false },
              success: "Resource removed from Store. No target was uninstalled.",
            })
          }
        >
          Remove from Store
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="api-error">
          {error}
        </p>
      )}
      {evidence !== null && (
        <details open>
          <summary>Source / dependency evidence</summary>
          <pre>{JSON.stringify(evidence, null, 2)}</pre>
        </details>
      )}
      {action && (
        <WorkflowDialog
          action={action}
          onClose={() => setAction(null)}
          onApplied={(message) => {
            setAction(null);
            setMessage(message);
            onChanged(message);
          }}
        />
      )}
    </section>
  );
}

interface Collection {
  name: string;
  resourceIds: string[];
  description?: string;
}
export function CollectionEditor() {
  const [loading, setLoading] = useState(true);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [resources, setResources] = useState<readonly ControlPlaneResourceDto[]>([]);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setName("");
    setMembers([]);
    Promise.all([
      apiFetch("/api/v1/collections").then(readApiJson<{ collections: Collection[] }>),
      apiFetch("/api/v1/resources?includeDiscovered=false").then(
        readApiJson<ControlPlaneResourceListDto>,
      ),
    ])
      .then(([data, library]) => {
        if (!alive) return;
        setCollections(data.collections);
        setResources(library.resources);
        setLoading(false);
      })
      .catch((error) => {
        if (alive) {
          setError(workflowError(error));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [reload]);
  const existing = collections.find((collection) => collection.name === name);
  function plan() {
    setAction({
      title: existing ? "Edit Collection members" : "Create Collection",
      description: existing
        ? `Replace ${name} membership with exactly ${members.join(", ") || "no resources"}. Targets stay unchanged.`
        : `Create the empty Collection ${name}; edit its members separately.`,
      planPath: "/api/v1/collections/plan",
      applyPath: "/api/v1/mutations/apply",
      input: existing
        ? { action: "set-members", collectionName: name, resourceIds: members }
        : { action: "create", collectionName: name, resourceIds: [] },
      success:
        "Collection saved. Existing deployments may be pending; preview Profile reconciliation separately.",
    });
  }
  return (
    <section className="panel workflow-panel">
      <h3>Collections</h3>
      <p>Store membership changes do not sync or uninstall targets.</p>
      <label className="field-row stacked">
        <span>Collection name</span>
        <input
          type="text"
          disabled={loading}
          list="workflow-collections"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setMembers(
              collections.find((collection) => collection.name === event.target.value)
                ?.resourceIds ?? [],
            );
          }}
        />
        <datalist id="workflow-collections">
          {collections.map((collection) => (
            <option key={collection.name} value={collection.name} />
          ))}
        </datalist>
      </label>
      {existing && (
        <fieldset>
          <legend>Exact members</legend>
          {resources.map((resource) => (
            <label className="field-row" key={resource.id}>
              <input
                type="checkbox"
                checked={members.includes(resource.id)}
                onChange={() =>
                  setMembers((current) =>
                    current.includes(resource.id)
                      ? current.filter((id) => id !== resource.id)
                      : [...current, resource.id],
                  )
                }
              />
              {resource.id}
            </label>
          ))}
        </fieldset>
      )}
      <button className="action secondary" type="button" disabled={!name.trim()} onClick={plan}>
        {existing ? "Review membership" : "Review new Collection"}
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {action && (
        <WorkflowDialog
          action={action}
          onClose={() => setAction(null)}
          onApplied={(message) => {
            setMessage(message);
            setAction(null);
            setLoading(true);
            setReload((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
