import type { SettingsSummary } from "@cellarer/core/client-api";
import { useEffect, useState } from "react";
import { apiFetch, applyPlannedControlPlaneMutation } from "./api.js";
import { readApiJson } from "./api-state.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SettingsPage({ onAgents }: { onAgents?: () => void } = {}) {
  const [settings, setSettings] = useState<SettingsSummary | null>(null);
  const [draftDefaults, setDraftDefaults] = useState<string[]>([]);
  const [pendingDefaults, setPendingDefaults] = useState<{ plan: unknown; names: string[] } | null>(
    null,
  );
  const [newCollection, setNewCollection] = useState("");
  const [newCollectionDescription, setNewCollectionDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await readApiJson<SettingsSummary>(await apiFetch("/api/v1/settings"));
      setSettings(result);
      setDraftDefaults(result.defaults.collections);
      setPendingDefaults(null);
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

  async function previewDefaults() {
    setError(null);
    try {
      const names = [...draftDefaults].sort();
      const planned = await readApiJson<{ plan: unknown }>(
        await apiFetch("/api/v1/collections/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "set-defaults", collectionNames: names }),
        }),
      );
      setPendingDefaults({ plan: planned.plan, names });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function confirmDefaults() {
    if (!pendingDefaults) return;
    setSaving(true);
    setError(null);
    try {
      await readApiJson(
        await apiFetch("/api/v1/mutations/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mutationPlan: pendingDefaults.plan }),
        }),
      );
      await load();
    } catch (err) {
      setPendingDefaults(null);
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack settings-page">
      <p className="settings-safety-note">
        配置变更只更新本地 Store 设置，不会自动写入任何 Agent 或项目。下发前需另行预览并确认。
      </p>
      {error && (
        <section className="api-error compact">
          <strong>本地 API 错误</strong>
          <p>{error}</p>
        </section>
      )}
      {loading && !settings ? (
        <p className="empty-state">正在加载设置…</p>
      ) : settings ? (
        <>
          <div className="settings-dashboard-grid">
            <section className="settings-grid">
              <section className="panel settings-card">
                <div className="panel-header">
                  <h3>本地 Store</h3>
                </div>
                <dl className="kv-list">
                  <div>
                    <dt>存储路径</dt>
                    <dd className="mono">{settings.storeRoot}</dd>
                  </div>
                  <div>
                    <dt>CELLARER_HOME</dt>
                    <dd>{settings.cellarerHomeActive ? "已启用" : "未启用"}</dd>
                  </div>
                </dl>
              </section>

              <section className="panel settings-card">
                <div className="panel-header">
                  <h3>默认资源选择</h3>
                </div>
                <dl className="kv-list">
                  <div>
                    <dt>落点方式</dt>
                    <dd>{settings.defaults.method}</dd>
                  </div>
                  <div>
                    <dt>默认分组</dt>
                    <dd>{settings.defaults.collections.join(", ")}</dd>
                  </div>
                  <div>
                    <dt>密钥模式</dt>
                    <dd>{settings.defaults.secretMode}</dd>
                  </div>
                </dl>
                <div className="settings-default-picker">
                  <strong>用于新下发请求的默认分组</strong>
                  {settings.collections.map((collection) => (
                    <label key={collection.name}>
                      <input
                        type="checkbox"
                        checked={draftDefaults.includes(collection.name)}
                        onChange={() => {
                          setPendingDefaults(null);
                          setDraftDefaults((current) =>
                            current.includes(collection.name)
                              ? current.filter((name) => name !== collection.name)
                              : [...current, collection.name],
                          );
                        }}
                      />
                      {collection.name}
                    </label>
                  ))}
                  <button
                    type="button"
                    className="action secondary"
                    disabled={
                      saving ||
                      JSON.stringify([...draftDefaults].sort()) ===
                        JSON.stringify([...settings.defaults.collections].sort())
                    }
                    onClick={previewDefaults}
                  >
                    预览默认选择
                  </button>
                  {pendingDefaults && (
                    <div className="settings-default-confirm">
                      <p>
                        将默认分组更新为：{pendingDefaults.names.join(", ") || "无"}。只改 Store
                        设置，不下发目标。
                      </p>
                      <button
                        type="button"
                        className="action"
                        disabled={saving}
                        onClick={confirmDefaults}
                      >
                        确认当前计划
                      </button>
                    </div>
                  )}
                </div>
              </section>
            </section>

            <section className="panel settings-card">
              <div className="panel-header">
                <h3>分组</h3>
                <span className="tag neutral">{settings.collections.length} 个分组</span>
              </div>
              <div className="collection-list">
                {settings.collections.map((collection) => (
                  <article className="collection-row" key={collection.name}>
                    <span className="tag blue">{collection.name}</span>
                    <p>{collection.description ?? "暂无描述"}</p>
                  </article>
                ))}
              </div>
              <div className="settings-form-row">
                <label className="field-row stacked">
                  <span>新建分组</span>
                  <input
                    type="text"
                    value={newCollection}
                    placeholder="work"
                    onChange={(event) => setNewCollection(event.target.value)}
                  />
                </label>
                <label className="field-row stacked">
                  <span>描述</span>
                  <input
                    type="text"
                    value={newCollectionDescription}
                    placeholder="可选"
                    onChange={(event) => setNewCollectionDescription(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="action secondary"
                  disabled={saving || newCollection.trim() === ""}
                  onClick={addCollection}
                >
                  添加分组
                </button>
              </div>
            </section>

            <section className="panel settings-card">
              <div className="panel-header">
                <h3>Agent 适配器</h3>
                <span className="tag neutral">
                  {settings.builtinAdapterIds.length + settings.customAdapterIds.length} 个
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>类型</th>
                      <th>管理</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.builtinAdapterIds.map((id) => (
                      <tr key={id}>
                        <td>{id}</td>
                        <td>内置</td>
                        <td>Agent 页</td>
                      </tr>
                    ))}
                    {settings.customAdapterIds.map((id) => (
                      <tr key={id}>
                        <td>{id}</td>
                        <td>自定义</td>
                        <td>Agent 页</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {onAgents && (
                <button type="button" className="action secondary" onClick={onAgents}>
                  管理适配器
                </button>
              )}
            </section>
          </div>

          <section className="panel settings-card">
            <div className="panel-header">
              <h3>密钥引用</h3>
              <span className="tag amber">{settings.secretRefs.length} 个引用</span>
            </div>
            {settings.secretRefs.length === 0 ? (
              <p className="empty-state">尚无密钥引用记录。</p>
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
