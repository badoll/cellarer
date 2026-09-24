import { useRef, useState } from "react";
import {
  type WorkflowAction,
  WorkflowDialog,
  workflowError,
  workflowPost,
} from "./workflow-dialog.js";

interface ValidatedBundle {
  resource: { id: string; kind: string; name: string };
  bundleDigest: string;
  contentFingerprint: string;
}

export function BundleImport({ onImported }: { onImported(): void }) {
  const [bundlePath, setBundlePath] = useState("");
  const [validated, setValidated] = useState<ValidatedBundle | null>(null);
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [validating, setValidating] = useState(false);
  const generation = useRef(0);

  async function validate() {
    const path = bundlePath.trim();
    if (!path) return;
    const token = ++generation.current;
    setValidated(null);
    setError("");
    setValidating(true);
    try {
      const result = await workflowPost<ValidatedBundle>("/api/v1/resources/bundle/validate", {
        bundlePath: path,
      });
      if (token === generation.current) setValidated(result);
    } catch (cause) {
      if (token === generation.current) setError(workflowError(cause));
    } finally {
      if (token === generation.current) setValidating(false);
    }
  }

  function review() {
    if (!validated) return;
    const path = bundlePath.trim();
    setAction({
      title: "Import configuration bundle",
      description: `Review exact Store import of ${validated.resource.kind} ${validated.resource.id}. Agent targets remain unchanged.`,
      planPath: "/api/v1/resources/bundle-import/plan",
      applyPath: "/api/v1/resources/bundle-import/apply",
      input: { bundlePath: path },
      applyInput: { bundlePath: path },
      success: "Bundle imported into Store. Sync to an Agent is a separate action.",
    });
  }

  return (
    <section className="panel workflow-panel" aria-label="Add configuration bundle">
      <h3>Add configuration bundle</h3>
      <p>
        Choose an existing local Cellarer resource bundle. Validation and import are separate from
        Agent sync.
      </p>
      <label className="field-row stacked">
        <span>Bundle path</span>
        <input
          type="text"
          value={bundlePath}
          onChange={(event) => {
            generation.current++;
            setBundlePath(event.target.value);
            setValidated(null);
            setAction(null);
            setError("");
            setValidating(false);
          }}
          placeholder="Absolute path to a resource bundle"
        />
      </label>
      <div className="button-row">
        <button
          type="button"
          className="action secondary"
          disabled={!bundlePath.trim() || validating}
          onClick={validate}
        >
          {validating ? "Validating..." : "Validate bundle"}
        </button>
        <button
          type="button"
          className="action"
          disabled={!validated || validating}
          onClick={review}
        >
          Review Store import
        </button>
      </div>
      {validated && (
        <p role="status">
          Validated {validated.resource.kind} {validated.resource.id}. Import still requires a
          reviewed plan.
        </p>
      )}
      {error && (
        <p role="alert" className="api-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {action && (
        <WorkflowDialog
          action={action}
          onClose={() => setAction(null)}
          onApplied={(result) => {
            setAction(null);
            setValidated(null);
            setMessage(result);
            onImported();
          }}
        />
      )}
    </section>
  );
}
