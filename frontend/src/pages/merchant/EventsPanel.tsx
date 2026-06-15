import { useEffect, useState } from 'react';
import type { ApiFn, AppState, GatewayEvent } from '../../types';
import { errMsg } from '../../types';

interface EventsPanelProps {
  state: AppState;
  api: ApiFn;
}

export function EventsPanel({ state, api }: EventsPanelProps) {
  const [events, setEvents] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState('');
  const [filterSince, setFilterSince] = useState('');
  const [filterUntil, setFilterUntil] = useState('');

  const [selectedEvent, setSelectedEvent] = useState(null);
  const [eventDetail, setEventDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const buildPath = ({ cursor }: { cursor?: string } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', '20');
    if (filterType.trim()) params.set('type', filterType.trim());
    if (filterSince) params.set('since', new Date(filterSince).toISOString());
    if (filterUntil) params.set('until', new Date(filterUntil).toISOString());
    if (cursor) params.set('cursor', cursor);
    return `/events?${params.toString()}`;
  };

  const fetchEvents = async ({ cursor }: { cursor?: string } = {}) => {
    setLoading(true);
    try {
      const resp = await api({ state, path: buildPath({ cursor }), token: state.dashboardJwt });
      if (cursor) {
        setEvents((curr) => [...curr, ...(resp.data || [])]);
      } else {
        setEvents(resp.data || []);
      }
      setHasMore(!!resp.has_more);
      setNextCursor(resp.next_cursor || null);
    } catch (err) {
      alert(`Failed to load events: ${errMsg(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = () => fetchEvents();
  const resetFilters = () => {
    setFilterType('');
    setFilterSince('');
    setFilterUntil('');
    setTimeout(() => fetchEvents(), 0);
  };

  const openEvent = async (event) => {
    setSelectedEvent(event);
    setEventDetail(null);
    setDetailLoading(true);
    try {
      const resp = await api({
        state,
        path: `/events/${event.id}`,
        token: state.dashboardJwt,
      });
      setEventDetail(resp.event);
    } catch (err) {
      alert(`Failed to load event details: ${errMsg(err)}`);
      setSelectedEvent(null);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div>
      <div className="table-container">
        <div className="table-header" style={{ flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3 style={{ margin: 0 }}>Events Log ({events.length}{hasMore ? '+' : ''})</h3>
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '12px' }}>
              Append-only audit log of every business event. Drill in to see the full payload and
              webhook delivery attempts for each event.
            </p>
          </div>
          <button className="ghost" onClick={() => fetchEvents()}>
            Refresh
          </button>
        </div>

        {/* Filter bar */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', padding: '12px 16px', flexWrap: 'wrap', borderBottom: '1px solid #e2e8f0' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#64748b' }}>
            Type
            <input
              type="text"
              placeholder="e.g. payment_intent.succeeded"
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '6px 10px', fontSize: '12px', minWidth: '240px' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#64748b' }}>
            Since
            <input
              type="datetime-local"
              value={filterSince}
              onChange={(e) => setFilterSince(e.target.value)}
              style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '6px 10px', fontSize: '12px' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#64748b' }}>
            Until
            <input
              type="datetime-local"
              value={filterUntil}
              onChange={(e) => setFilterUntil(e.target.value)}
              style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '6px 10px', fontSize: '12px' }}
            />
          </label>
          <button className="action" onClick={applyFilters} style={{ height: '32px', fontSize: '12px' }}>
            Apply
          </button>
          <button className="action secondary" onClick={resetFilters} style={{ height: '32px', fontSize: '12px' }}>
            Reset
          </button>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Event ID</th>
              <th>Type</th>
              <th>API Version</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id}>
                <td style={{ fontFamily: 'monospace' }}>{ev.id.slice(0, 13)}…</td>
                <td>
                  <span style={{ fontFamily: 'monospace', fontSize: '11px', padding: '2px 6px', background: '#eef2ff', color: '#4338ca', borderRadius: '6px' }}>
                    {ev.type}
                  </span>
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{ev.apiVersion || '—'}</td>
                <td>{new Date(ev.createdAt).toLocaleString()}</td>
                <td>
                  <button className="ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => openEvent(ev)}>
                    View Payload
                  </button>
                </td>
              </tr>
            ))}
            {!loading && events.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '40px 16px', color: '#64748b' }}>
                  No events match these filters.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>Loading…</td>
              </tr>
            )}
          </tbody>
        </table>

        {hasMore && (
          <div style={{ padding: '12px 16px', textAlign: 'center', borderTop: '1px solid #e2e8f0' }}>
            <button className="ghost" onClick={() => fetchEvents({ cursor: nextCursor })} disabled={loading}>
              Load More
            </button>
          </div>
        )}
      </div>

      {/* Event detail modal */}
      {selectedEvent && (
        <div className="modal-overlay" onClick={() => setSelectedEvent(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '780px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <div style={{ textAlign: 'left' }}>
                <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Event Details</h2>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#64748b', fontFamily: 'monospace' }}>
                  {selectedEvent.id}
                </p>
              </div>
              <button className="ghost" type="button" onClick={() => setSelectedEvent(null)} style={{ padding: '6px 12px', borderRadius: '10px' }}>
                Close
              </button>
            </div>

            {detailLoading || !eventDetail ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>Loading payload…</div>
            ) : (
              <div style={{ textAlign: 'left' }}>
                <div className="receipt-grid" style={{ marginBottom: '16px', background: '#f8fafc' }}>
                  <div className="receipt-row">
                    <span>Type</span>
                    <strong style={{ fontFamily: 'monospace' }}>{eventDetail.type}</strong>
                  </div>
                  <div className="receipt-row">
                    <span>API Version</span>
                    <strong style={{ fontFamily: 'monospace' }}>{eventDetail.apiVersion || '—'}</strong>
                  </div>
                  <div className="receipt-row">
                    <span>Created</span>
                    <strong>{new Date(eventDetail.createdAt).toLocaleString()}</strong>
                  </div>
                </div>

                <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '6px' }}>
                  Payload
                </span>
                <pre
                  style={{
                    background: '#0f172a',
                    color: '#e2e8f0',
                    padding: '14px',
                    borderRadius: '12px',
                    fontSize: '11px',
                    overflowX: 'auto',
                    maxHeight: '280px',
                    overflowY: 'auto',
                    margin: 0,
                  }}
                >
{JSON.stringify(eventDetail.payload, null, 2)}
                </pre>

                <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', margin: '16px 0 6px' }}>
                  Webhook Deliveries ({eventDetail.deliveries?.length || 0})
                </span>
                {eventDetail.deliveries && eventDetail.deliveries.length > 0 ? (
                  <div style={{ border: '1px solid #cbd5e1', borderRadius: '12px', overflow: 'hidden' }}>
                    <table className="data-table" style={{ fontSize: '11px', margin: 0 }}>
                      <thead>
                        <tr>
                          <th>Webhook</th>
                          <th>Status</th>
                          <th>Attempts</th>
                          <th>Response</th>
                          <th>Last Attempt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {eventDetail.deliveries.map((d) => (
                          <tr key={d.id}>
                            <td style={{ fontFamily: 'monospace' }}>{d.webhookId.slice(0, 8)}…</td>
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
                            <td>{d.responseCode ?? '—'}</td>
                            <td>{d.lastAttemptAt ? new Date(d.lastAttemptAt).toLocaleString() : 'Pending'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p style={{ color: '#64748b', fontSize: '12px', margin: 0 }}>
                    No webhook deliveries — either no webhooks were registered for this event type
                    when it was generated, or the wildcard <code>*</code> webhook hadn't been created yet.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
