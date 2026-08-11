import type { SettingsSummary } from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { apiFetch, applyPlannedControlPlaneMutation } from "./api.js";
import { readApiJson } from "./api-state.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsSummary | null>(null);
  const [newCollection, setNewCollection] = useState("");
  const [newCollectionDescription, setNewCollectionDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSettings(await readApiJson<SettingsSummary>(await apiFetch("/api/v1/settings")));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function addCollection() {
    const name = newCollection.trim();
    if (!settings || !name) return;
    setSaving(true);
    setError(null);
    try {
      await applyPlannedControlPlaneMutation("/api/v1/collections/plan", {
        action: "create",
        collectionName: name,
        description: newCollectionDescription.trim() || undefined,
        resourceIds: [],
      });
      setNewCollection("");
      setNewCollectionDescription("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      {error && (
        <section className="api-error compact">
          <strong>Local API error</strong>
          <p>{error}</p>
        </section>
      )}
      {loading && !settings ? (
        <p className="empty-state">Loading settings...</p>
      ) : settings ? (
        <>
          <section className="settings-grid">
            <section className="panel settings-card">
              <div className="panel-header">
                <h3>Store</h3>
              </div>
              <dl className="kv-list">
                <div>
                  <dt>Store root</dt>
                  <dd className="mono">{settings.storeRoot}</dd>
                </div>
                <div>
                  <dt>CELLARER_HOME</dt>
                  <dd>{settings.cellarerHomeActive ? "active" : "not active"}</dd>
                </div>
              </dl>
            </section>

            <section className="panel settings-card">
              <div className="panel-header">
                <h3>Defaults</h3>
              </div>
              <dl className="kv-list">
                <div>
                  <dt>Method</dt>
                  <dd>{settings.defaults.method}</dd>
                </div>
                <div>
                  <dt>Collections</dt>
                  <dd>{settings.defaults.collections.join(", ")}</dd>
                </div>
                <div>
                  <dt>Secret mode</dt>
                  <dd>{settings.defaults.secretMode}</dd>
                </div>
              </dl>
            </section>
          </section>

          <section className="panel settings-card">
            <div className="panel-header">
              <h3>Collections</h3>
              <span className="tag neutral">{settings.collections.length} collections</span>
            </div>
            <div className="collection-list">
              {settings.collections.map((collection) => (
                <article className="collection-row" key={collection.name}>
                  <span className="tag blue">{collection.name}</span>
                  <p>{collection.description ?? "No description"}</p>
                </article>
              ))}
            </div>
            <div className="settings-form-row">
              <label className="field-row stacked">
                <span>New collection</span>
                <input
                  type="text"
                  value={newCollection}
                  placeholder="work"
                  onChange={(event) => setNewCollection(event.target.value)}
                />
              </label>
              <label className="field-row stacked">
                <span>Description</span>
                <input
                  type="text"
                  value={newCollectionDescription}
                  placeholder="Optional"
                  onChange={(event) => setNewCollectionDescription(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="action secondary"
                disabled={saving || newCollection.trim() === ""}
                onClick={addCollection}
              >
                Add collection
              </button>
            </div>
          </section>

          <section className="panel settings-card">
            <div className="panel-header">
              <h3>Secret references</h3>
              <span className="tag amber">{settings.secretRefs.length} refs</span>
            </div>
            {settings.secretRefs.length === 0 ? (
              <p className="empty-state">No secret references recorded.</p>
            ) : (
              <div className="settings-list">
                {settings.secretRefs.map((ref) => (
                  <span className="tag amber mono" key={ref.name}>
                    {ref.name} ({ref.ledgerEntryCount})
                  </span>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
