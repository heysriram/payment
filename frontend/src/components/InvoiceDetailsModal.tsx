import { formatCurrency } from '../lib/format';
import type { PaymentIntent } from '../types';

interface InvoiceDetailsModalProps {
  intent: PaymentIntent;
  onClose: () => void;
}

export function InvoiceDetailsModal({ intent, onClose }: InvoiceDetailsModalProps) {
  const lineItems = intent.metadata?.line_items || [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid #cbd5e1',
            paddingBottom: '12px',
            marginBottom: '16px',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Invoice Details</h2>
          <button className="ghost" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={onClose}>
            Close
          </button>
        </div>

        <div className="receipt-grid" style={{ marginBottom: '16px', background: '#f8fafc' }}>
          <div className="receipt-row">
            <span>Invoice UUID</span>
            <strong>{intent.id}</strong>
          </div>
          <div className="receipt-row">
            <span>Customer Details</span>
            <strong>
              {intent.customer?.name || 'Anonymous'} ({intent.customer?.email || 'Guest'})
            </strong>
          </div>
          <div className="receipt-row">
            <span>Invoice Status</span>
            <strong className={`status-badge ${intent.status.toLowerCase()}`}>{intent.status}</strong>
          </div>
          <div className="receipt-row">
            <span>Created At</span>
            <strong>{new Date(intent.createdAt).toLocaleString()}</strong>
          </div>
          {intent.transactions?.[0]?.gatewayTxnId && (
            <div className="receipt-row">
              <span>Razorpay Reference</span>
              <strong>{intent.transactions[0].gatewayTxnId}</strong>
            </div>
          )}
        </div>

        <div style={{ textAlign: 'left', marginBottom: '16px' }}>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 800,
              color: '#475569',
              display: 'block',
              borderBottom: '1px solid #cbd5e1',
              paddingBottom: '6px',
              marginBottom: '8px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Line Items Breakdown
          </span>
          {lineItems.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid #cbd5e1',
                    color: '#475569',
                    height: '28px',
                    textAlign: 'left',
                  }}
                >
                  <th>Item Description</th>
                  <th style={{ textAlign: 'center' }}>Unit Price (₹)</th>
                  <th style={{ textAlign: 'center' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0', height: '36px' }}>
                    <td style={{ fontWeight: 'bold' }}>{item.name}</td>
                    <td style={{ textAlign: 'center' }}>{formatCurrency(Number(item.price || 0) * 100)}</td>
                    <td style={{ textAlign: 'center' }}>x{item.quantity}</td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold' }}>
                      {formatCurrency(Number(item.price || 0) * Number(item.quantity || 1) * 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: '#64748b', fontSize: '13px', padding: '10px 0' }}>
              Flat invoice with no itemized breakdown.
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: '#e2e8f0',
            padding: '16px',
            borderRadius: '16px',
            border: '1px solid #cbd5e1',
          }}
        >
          <span style={{ fontSize: '13px', color: '#475569', fontWeight: 'bold' }}>Total Settled:</span>
          <strong style={{ fontSize: '20px', color: '#0f172a' }}>
            {formatCurrency(intent.amount, intent.currency)}
          </strong>
        </div>
      </div>
    </div>
  );
}
