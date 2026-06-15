import { useEffect, useState, type FormEvent } from 'react';
import { Input } from '../../components/Input';
import type { ApiFn, AppState, Webhook, WebhookDelivery } from '../../types';
import { errMsg } from '../../types';

interface WebhooksPanelProps {
  state: AppState;
  api: ApiFn;
}

const KNOWN_EVENTS = [
  'payment_intent.created',
  'payment_intent.succeeded',
  'payment_intent.failed',
  'payment_intent.cancelled',
  'refund.created',
  'refund.succeeded',
  'dispute.created',
  'dispute.resolved',
  'payout.paid',
  '*',
] as const;

export function WebhooksPanel({ state, api }: WebhooksPanelProps) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState(null);
  const [form, setForm] = useState({ url: '', events: ['*'] });
  const [generatedSecret, setGeneratedSecret] = useState('');

  // Deliveries drawer
  const [viewingDeliveriesFor, setViewingDeliveriesFor] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);

  const fetchWebhooks = async () => {
    setLoading(true);
    try {
      const resp = await api({ state, path: '/webhooks', token: state.dashboardJwt });
      setWebhooks(resp.data || []);
    } catch (err) {
      alert(`Failed to load webhooks: ${errMsg(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWebhooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setEditingWebhook(null);
    setForm({ url: '', events: ['*'] });
    setGeneratedSecret('');
    setShowCreateModal(true);
  };

  const openEdit = (webhook) => {
    setEditingWebhook(webhook);
    setForm({ url: webhook.url, events: webhook.events });
    setGeneratedSecret('');
    setShowCreateModal(true);
  };

  const closeModal = () => {
    setShowCreateModal(false);
    setEditingWebhook(null);
    setGeneratedSecret('');
  };

  const toggleEvent = (eventName) => {
    setForm((curr) => {
      if (eventName === '*') {
        return { ...curr, events: curr.events.includes('*') ? [] : ['*'] };
      }
      const cleaned = curr.events.filter((e) => e !== '*');
      const next = cleaned.includes(eventName)
        ? cleaned.filter((e) => e !== eventName)
        : [...cleaned, eventName];
      return { ...curr, events: next };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.url || form.events.length === 0) {
      alert('URL and at least one event are required.');
      return;
    }

    try {
      if (editingWebhook) {
        await api({
          state,
          path: `/webhooks/${editingWebhook.id}`,
          method: 'PATCH',
          token: state.dashboardJwt,
          body: { url: form.url, events: form.events },
        });
        closeModal();
        fetchWebhooks();
      } else {
        const resp = await api({
          state,
          path: '/webhooks',
          method: 'POST',
          token: state.dashboardJwt,
          body: form,
        });
        setGeneratedSecret(resp.secret);
        fetchWebhooks();
      }
    } catch (err) {
      alert(`Save failed: ${errMsg(err)}`);
    }
  };

  const handleDelete = async (webhookId) => {
    if (!confirm('Delete this webhook? Future events will not be delivered to its URL.')) return;
    try {
      await api({
        state,
        path: `/webhooks/${webhookId}`,
        method: 'DELETE',
        token: state.dashboardJwt,
      });
      fetchWebhooks();
    } catch (err) {
      alert(`Delete failed: ${errMsg(err)}`);
    }
  };

  const handleToggleStatus = async (webhook) => {
    try {
      await api({
        state,
        path: `/webhooks/${webhook.id}`,
        method: 'PATCH',
        token: state.dashboardJwt,
        body: { status: webhook.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
      });
      fetchWebhooks();
    } catch (err) {
      alert(`Status toggle failed: ${errMsg(err)}`);
    }
  };

  const handleSendTest = async (webhookId) => {
    try {
      await api({
        state,
        path: `/webhooks/${webhookId}/test`,
        method: 'POST',
        token: state.dashboardJwt,
      });
      alert('Test event queued! Check the deliveries log in a few seconds.');
    } catch (err) {
      alert(`Test send failed: ${errMsg(err)}`);
    }
  };

  const fetchDeliveries = async (webhook) => {
    setViewingDeliveriesFor(webhook);
    setDeliveriesLoading(true);
    setDeliveries([]);
    try {
      const resp = await api({
        state,
        path: `/webhooks/${webhook.id}/deliveries?limit=100`,
        token: state.dashboardJwt,
      });
      setDeliveries(resp.data || []);
    } catch (err) {
      alert(`Failed to load deliveries: ${errMsg(err)}`);
    } finally {
      setDeliveriesLoading(false);
    }
  };

  const handleRetry = async (deliveryId) => {
    if (!viewingDeliveriesFor) return;
    try {
      await api({
        state,
        path: `/webhooks/${viewingDeliveriesFor.id}/deliveries/${deliveryId}/retry`,
        method: 'POST',
        token: state.dashboardJwt,
      });
      alert('Delivery requeued for retry.');
      fetchDeliveries(viewingDeliveriesFor);
    } catch (err) {
      alert(`Retry failed: ${errMsg(err)}`);
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '60px 0', color: '#64748b' }}>Loading webhooks…</div>;
  }

  return (
    <div>
      <div className="table-container">
        <div className="table-header" style={{ flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3 style={{ margin: 0 }}>Webhook Endpoints ({webhooks.length})</h3>
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '12px' }}>
              POST signed events to your endpoints. Verify the <code>X-Payments-Signature</code> header
              with the secret returned at creation time.
            </p>
          </div>
          <button className="action" onClick={openCreate}>
            + Add Webhook
          </button>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Endpoint URL</th>
              <th>Events</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Deliveries</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {webhooks.map((w) => (
              <tr key={w.id}>
                <td style={{ fontFamily: 'monospace', maxWidth: '320px', wordBreak: 'break-all' }}>
                  {w.url}
                </td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {w.events.map((ev) => (
                      <span
                        key={ev}
                        style={{
                          fontSize: '10px',
                          padding: '2px 6px',
                          borderRadius: '6px',
                          background: '#eef2ff',
                          color: '#4338ca',
                          fontFamily: 'monospace',
                        }}
                      >
                        {ev}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <span className={`status-badge ${w.status === 'ACTIVE' ? 'succeeded' : 'failed'}`}>
                    {w.status}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>{w._count?.deliveries ?? 0}</td>
                <td>{new Date(w.createdAt).toLocaleDateString()}</td>
                <td>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    <button
                      className="ghost"
                      style={{ padding: '4px 8px', fontSize: '11px' }}
                      onClick={() => fetchDeliveries(w)}
                    >
                      Deliveries
                    </button>
                    <button
                      className="ghost"
                      style={{ padding: '4px 8px', fontSize: '11px', color: '#0d9488', borderColor: '#99f6e4', background: '#f0fdfa' }}
                      onClick={() => handleSendTest(w.id)}
                    >
                      Send Test
                    </button>
                    <button
                      className="ghost"
                      style={{ padding: '4px 8px', fontSize: '11px' }}
                      onClick={() => openEdit(w)}
                    >
                      Edit
                    </button>
                    <button
                      className="ghost"
                      style={{ padding: '4px 8px', fontSize: '11px', color: '#a16207', borderColor: '#fde68a', background: '#fef3c7' }}
                      onClick={() => handleToggleStatus(w)}
                    >
                      {w.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className="ghost"
                      style={{ padding: '4px 8px', fontSize: '11px', color: '#be123c', borderColor: '#ffe4e6', background: '#fff1f2' }}
                      onClick={() => handleDelete(w.id)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {webhooks.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '40px 16px', color: '#64748b' }}>
                  No webhooks yet. Click <strong>+ Add Webhook</strong> to start receiving event
                  notifications.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create/Edit modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>
                {editingWebhook ? 'Edit Webhook' : 'New Webhook'}
              </h2>
              <button className="ghost" type="button" onClick={closeModal} style={{ padding: '6px 12px', borderRadius: '10px' }}>
                Close
              </button>
            </div>

            {generatedSecret ? (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '16px', padding: '16px', textAlign: 'left' }}>
                <strong style={{ color: '#16a34a', display: 'block', marginBottom: '8px' }}>
                  ✓ Webhook Created — copy your signing secret now
                </strong>
                <p style={{ fontSize: '12px', color: '#15803d', margin: '0 0 10px 0' }}>
                  This secret will not be shown again. Store it server-side; use it to verify the
                  <code> X-Payments-Signature</code> header on every incoming webhook.
                </p>
                <input readOnly className="share-input" value={generatedSecret} style={{ width: '100%', marginBottom: '12px' }} />
                <button className="action" type="button" onClick={closeModal}>
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} style={{ textAlign: 'left' }}>
                <Input
                  label="Endpoint URL"
                  type="url"
                  value={form.url}
                  onChange={(val) => setForm((c) => ({ ...c, url: val }))}
                  placeholder="https://example.com/webhooks/payments"
                />
                <div style={{ marginTop: '14px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '8px' }}>
                    Subscribed Events
                  </span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
                    {KNOWN_EVENTS.map((ev) => {
                      const checked = form.events.includes(ev);
                      return (
                        <label
                          key={ev}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 12px',
                            borderRadius: '10px',
                            border: '1px solid',
                            borderColor: checked ? '#2563eb' : '#cbd5e1',
                            background: checked ? '#edf4ff' : 'white',
                            cursor: 'pointer',
                            fontSize: '12px',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleEvent(ev)}
                          />
                          <span style={{ fontFamily: 'monospace', fontWeight: ev === '*' ? 800 : 600 }}>
                            {ev === '*' ? '* (all events)' : ev}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button className="action" type="submit">
                    {editingWebhook ? 'Save Changes' : 'Create Webhook'}
                  </button>
                  <button className="action secondary" type="button" onClick={closeModal}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Deliveries modal */}
      {viewingDeliveriesFor && (
        <div className="modal-overlay" onClick={() => setViewingDeliveriesFor(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <div style={{ textAlign: 'left' }}>
                <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Webhook Deliveries</h2>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#64748b', fontFamily: 'monospace' }}>
                  {viewingDeliveriesFor.url}
                </p>
              </div>
              <button className="ghost" type="button" onClick={() => setViewingDeliveriesFor(null)} style={{ padding: '6px 12px', borderRadius: '10px' }}>
                Close
              </button>
            </div>

            {deliveriesLoading ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>Loading…</div>
            ) : (
              <div style={{ maxHeight: '460px', overflowY: 'auto', border: '1px solid #cbd5e1', borderRadius: '12px' }}>
                <table className="data-table" style={{ fontSize: '12px' }}>
                  <thead>
                    <tr>
                      <th>Delivery ID</th>
                      <th>Event</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Response</th>
                      <th>Last Attempt</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.id}>
                        <td style={{ fontFamily: 'monospace' }}>{d.id.slice(0, 8)}…</td>
                        <td>
                          <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{d.event?.type || '—'}</div>
                          <div style={{ fontSize: '10px', color: '#64748b' }}>
                            {d.event?.id ? d.event.id.slice(0, 8) + '…' : '—'}
                          </div>
                        </td>
                        <td>
                          <span className={`status-badge ${
                            d.status === 'DELIVERED' ? 'succeeded'
                              : d.status === 'FAILED' ? 'failed'
                              : 'processing'
                          }`}>
                            {d.status}
                          </span>
                        </td>
                        <td>{d.attempts}</td>
                        <td>
                          {d.responseCode ?? '—'}
                          {d.responseBody && (
                            <div style={{ fontSize: '10px', color: '#64748b', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.responseBody}>
                              {d.responseBody.slice(0, 60)}
                            </div>
                          )}
                        </td>
                        <td>{d.lastAttemptAt ? new Date(d.lastAttemptAt).toLocaleString() : 'Pending'}</td>
                        <td>
                          {d.status !== 'DELIVERED' && (
                            <button
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: '11px' }}
                              onClick={() => handleRetry(d.id)}
                            >
                              Retry
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {deliveries.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                          No deliveries yet. Click <strong>Send Test</strong> to enqueue one.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
