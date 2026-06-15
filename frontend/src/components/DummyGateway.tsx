import { useState } from 'react';
import { Input } from './Input';
import { Select } from './Select';
import { formatCurrency } from '../lib/format';
import type { DummyOutcome, DummyPaymentMethod } from '../types';

interface DummyGatewayProps {
  merchantLabel: string;
  amount: number;
  currency?: string;
  loading?: boolean;
  confirmLabel?: string;
  busyLabel?: string;
  onClose: () => void;
  onConfirm: (method: DummyPaymentMethod, outcome: DummyOutcome) => void;
}

export function DummyGateway({
  merchantLabel,
  amount,
  currency = 'INR',
  loading = false,
  confirmLabel = 'Confirm Simulated Payment',
  busyLabel = 'Processing Simulated Payment...',
  onClose,
  onConfirm,
}: DummyGatewayProps) {
  const [method, setMethod] = useState<DummyPaymentMethod>('card');
  const [outcome, setOutcome] = useState<DummyOutcome>('SUCCESS');
  const [cardNumber, setCardNumber] = useState('4111 1111 1111 1111');
  const [upiVpa, setUpiVpa] = useState('test@upi');
  const [bank, setBank] = useState('HDFC Bank');
  const [wallet, setWallet] = useState('Paytm Wallet');

  return (
    <div className="modal-overlay" style={{ zIndex: 9999 }} onClick={onClose}>
      <div
        className="modal-card"
        style={{
          maxWidth: '520px',
          padding: '28px',
          borderRadius: '24px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '24px' }}>🛡️</span>
            <div style={{ textAlign: 'left' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800 }}>Secure Sandbox Gateway</h3>
              <span style={{ fontSize: '11px', color: '#64748b' }}>Simulated Payment Processor</span>
            </div>
          </div>
          <button className="ghost" type="button" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={onClose}>
            Close
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            background: '#f8fafc',
            padding: '14px',
            borderRadius: '16px',
            border: '1px solid #cbd5e1',
            marginBottom: '20px',
            fontSize: '13px',
          }}
        >
          <div style={{ textAlign: 'left' }}>
            <span
              style={{
                color: '#64748b',
                display: 'block',
                fontSize: '10px',
                fontWeight: 'bold',
                textTransform: 'uppercase',
              }}
            >
              Paying Merchant
            </span>
            <strong style={{ display: 'block', marginTop: '3px' }}>{merchantLabel}</strong>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span
              style={{
                color: '#64748b',
                display: 'block',
                fontSize: '10px',
                fontWeight: 'bold',
                textTransform: 'uppercase',
              }}
            >
              Amount Due
            </span>
            <strong style={{ color: '#2563eb', display: 'block', marginTop: '3px', fontSize: '16px' }}>
              {formatCurrency(amount, currency)}
            </strong>
          </div>
        </div>

        <div style={{ textAlign: 'left', marginBottom: '20px' }}>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 800,
              color: '#475569',
              display: 'block',
              marginBottom: '8px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Choose Payment Method
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
            {(
              [
                { id: 'card' as const, label: 'Card', icon: '💳' },
                { id: 'upi' as const, label: 'UPI', icon: '📱' },
                { id: 'netbanking' as const, label: 'Bank', icon: '🏦' },
                { id: 'wallet' as const, label: 'Wallet', icon: '👛' },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMethod(m.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '12px 8px',
                  borderRadius: '16px',
                  border: '2px solid',
                  borderColor: method === m.id ? '#2563eb' : '#cbd5e1',
                  background: method === m.id ? '#edf4ff' : 'white',
                  color: method === m.id ? '#1e40af' : '#1e293b',
                  fontSize: '11px',
                  fontWeight: '800',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                <span style={{ fontSize: '18px' }}>{m.icon}</span>
                <span>{m.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            textAlign: 'left',
            background: '#f8fafc',
            padding: '16px',
            borderRadius: '16px',
            border: '1px solid #cbd5e1',
            marginBottom: '20px',
          }}
        >
          {method === 'card' && (
            <div style={{ display: 'grid', gap: '10px' }}>
              <Input label="Mock Card Number" value={cardNumber} onChange={setCardNumber} placeholder="4111 1111 1111 1111" />
              <div className="row" style={{ display: 'flex', gap: '8px' }}>
                <div style={{ flex: 1 }}>
                  <Input label="Expiry Date" placeholder="MM/YY" value="12/30" onChange={() => {}} />
                </div>
                <div style={{ flex: 1 }}>
                  <Input label="CVV" type="password" placeholder="123" value="123" onChange={() => {}} />
                </div>
              </div>
            </div>
          )}
          {method === 'upi' && (
            <div>
              <Input label="Mock UPI VPA Address" value={upiVpa} onChange={setUpiVpa} placeholder="e.g. user@gpay" />
              <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                {['test@upi', 'customer@okaxis', 'pay@ybl'].map((vpa) => (
                  <button
                    key={vpa}
                    type="button"
                    className="ghost"
                    style={{ padding: '4px 8px', borderRadius: '8px', fontSize: '10px' }}
                    onClick={() => setUpiVpa(vpa)}
                  >
                    {vpa}
                  </button>
                ))}
              </div>
            </div>
          )}
          {method === 'netbanking' && (
            <Select
              label="Mock Bank Institution"
              value={bank}
              onChange={setBank}
              options={['HDFC Bank', 'State Bank of India', 'ICICI Bank', 'Axis Bank', 'Kotak Bank']}
            />
          )}
          {method === 'wallet' && (
            <Select
              label="Mock Wallet Service"
              value={wallet}
              onChange={setWallet}
              options={['Paytm Wallet', 'PhonePe Wallet', 'Amazon Pay', 'Mobikwik']}
            />
          )}
        </div>

        <div style={{ textAlign: 'left', marginBottom: '24px' }}>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 800,
              color: '#475569',
              display: 'block',
              marginBottom: '8px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Simulate Gateway Outcome
          </span>
          <div style={{ display: 'grid', gap: '10px' }}>
            {(
              [
                {
                  id: 'SUCCESS' as const,
                  title: '🟢 SUCCESS',
                  desc: 'Debits customer, credits merchant balance, registers SUCCESS status.',
                },
                {
                  id: 'FAILURE_DECLINED' as const,
                  title: '🔴 FAILURE (Card Declined)',
                  desc: 'Simulates direct rejection. No funds are cut, registers FAILED status.',
                },
                {
                  id: 'FAILURE_REVERTED' as const,
                  title: '⚠️ FAILURE (Money Cut & Reverted)',
                  desc: 'Funds are debited, but transaction timeout triggers auto-reversal/refund.',
                },
              ] as const
            ).map((out) => (
              <label
                key={out.id}
                style={{
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'start',
                  padding: '12px',
                  borderRadius: '16px',
                  border: '2px solid',
                  borderColor: outcome === out.id ? '#2563eb' : '#cbd5e1',
                  background: outcome === out.id ? '#edf4ff' : 'white',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                <input
                  type="radio"
                  name="gateway_outcome"
                  value={out.id}
                  checked={outcome === out.id}
                  onChange={() => setOutcome(out.id)}
                  style={{ marginTop: '3px' }}
                />
                <div style={{ fontSize: '12px' }}>
                  <strong
                    style={{
                      display: 'block',
                      color: outcome === out.id ? '#1e40af' : '#1e293b',
                      fontWeight: 'bold',
                    }}
                  >
                    {out.title}
                  </strong>
                  <span
                    style={{
                      color: '#64748b',
                      fontSize: '11px',
                      display: 'block',
                      marginTop: '2px',
                      lineHeight: '1.3',
                    }}
                  >
                    {out.desc}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            className="action"
            style={{
              flex: 1,
              height: '48px',
              fontSize: '14px',
              background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
            }}
            onClick={() => onConfirm(method, outcome)}
            disabled={loading}
          >
            {loading ? busyLabel : confirmLabel}
          </button>
          <button className="action secondary" style={{ height: '48px' }} onClick={onClose} disabled={loading}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
