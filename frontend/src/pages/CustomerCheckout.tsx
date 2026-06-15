import { useEffect, useState } from 'react';
import { DummyGateway } from '../components/DummyGateway';
import { formatCurrency } from '../lib/format';
import { loadRazorpayScript } from '../lib/razorpay';
import { api } from '../lib/api';
import type { AppState, AppView, DummyOutcome, DummyPaymentMethod, PaymentMethod, PublicPaymentIntent } from '../types';
import { errMsg } from '../types';

interface CustomerCheckoutProps {
  intentId: string;
  clientSecret: string;
  state: AppState;
  setView: (view: AppView) => void;
}

interface SuccessDetails {
  paymentId: string;
  orderId: string;
  status: string;
  amount: number;
  currency: string;
}

export function CustomerCheckout({ intentId, clientSecret, state, setView }: CustomerCheckoutProps) {
  const [intent, setIntent] = useState<PublicPaymentIntent | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [successDetails, setSuccessDetails] = useState<SuccessDetails | null>(null);

  const [showDummyGateway, setShowDummyGateway] = useState(false);
  const [checkoutFailureMessage, setCheckoutFailureMessage] = useState('');

  // Saved-method picker state. Only populated when the customer signed in to
  // the portal matches the customerId attached to this intent.
  const [savedMethods, setSavedMethods] = useState<PaymentMethod[]>([]);
  const [savedMethodsLoaded, setSavedMethodsLoaded] = useState(false);

  const fetchIntentDetails = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api({
        state,
        path: `/payment_intents/${intentId}/public?client_secret=${clientSecret}`,
        method: 'GET',
      });
      setIntent(data.paymentIntent);

      // If the logged-in customer owns this intent, pull their saved methods
      // so we can offer a "pay with saved card" picker. Failure is silent —
      // the regular gateway buttons stay available either way.
      if (
        data.paymentIntent.customerId &&
        state.currentCustomerId &&
        state.currentCustomerId === data.paymentIntent.customerId
      ) {
        try {
          const methodsResp = await api({
            state,
            path: `/customers/${data.paymentIntent.customerId}/methods/public`,
          });
          setSavedMethods(methodsResp.methods || []);
        } catch {
          setSavedMethods([]);
        } finally {
          setSavedMethodsLoaded(true);
        }
      } else {
        setSavedMethodsLoaded(true);
      }
    } catch (err) {
      setError(errMsg(err) || 'Failed to load checkout details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIntentDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentId]);

  const handlePaySavedMethod = async (method: PaymentMethod) => {
    if (!intent) return;
    setPaying(true);
    setCheckoutFailureMessage('');
    try {
      const confirmData = await api({
        state,
        path: `/payment_intents/${intent.id}/confirm/dummy`,
        method: 'POST',
        body: {
          client_secret: clientSecret,
          outcome: 'SUCCESS',
          payment_method: (method.type || 'CARD').toLowerCase(),
          payment_method_id: method.id,
        },
      });

      setSuccessDetails({
        paymentId: confirmData.paymentIntent.id,
        orderId: `dmy_ord_${Math.random().toString(36).substring(2, 10)}`,
        status: confirmData.paymentIntent.status,
        amount: confirmData.paymentIntent.amount,
        currency: confirmData.paymentIntent.currency,
      });
    } catch (err) {
      setCheckoutFailureMessage(`Could not charge saved method: ${errMsg(err)}`);
    } finally {
      setPaying(false);
    }
  };

  const handlePay = async () => {
    if (!intent) return;
    setPaying(true);
    try {
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        alert('Failed to load Razorpay checkout script. Are you online?');
        setPaying(false);
        return;
      }

      const options = {
        key: intent.razorpayKeyId,
        amount: intent.amount,
        currency: intent.currency,
        name: intent.merchantName,
        description: `Order Ref: ${intent.id.slice(0, 8)}`,
        order_id: intent.razorpayOrderId,
        handler: async function (response) {
          setPaying(true);
          try {
            const confirmData = await api({
              state,
              path: `/payment_intents/${intent.id}/confirm/public`,
              method: 'POST',
              body: {
                client_secret: clientSecret,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
              },
            });

            setSuccessDetails({
              paymentId: response.razorpay_payment_id,
              orderId: response.razorpay_order_id,
              status: confirmData.paymentIntent.status,
              amount: confirmData.paymentIntent.amount,
              currency: confirmData.paymentIntent.currency,
            });
          } catch (err) {
            alert(`Payment confirmation failed: ${errMsg(err)}`);
          } finally {
            setPaying(false);
          }
        },
        prefill: {
          name: 'Jane Doe',
          email: 'customer@example.com',
          contact: '9876543210',
        },
        theme: { color: '#2563eb' },
      };

      const rzp = new window.Razorpay!(options);
      rzp.on('payment.failed', function (resp) {
        alert(`Payment failed: ${resp.error.description}`);
      });
      rzp.open();
    } catch (err) {
      alert(`Razorpay launch error: ${errMsg(err)}`);
    } finally {
      setPaying(false);
    }
  };

  const handleDummyPay = () => {
    setShowDummyGateway(true);
  };

  const executeDummyPayment = async (selectedMethod: DummyPaymentMethod, selectedOutcome: DummyOutcome) => {
    if (!intent) return;
    setPaying(true);
    setCheckoutFailureMessage('');
    try {
      const confirmData = await api({
        state,
        path: `/payment_intents/${intent.id}/confirm/dummy`,
        method: 'POST',
        body: {
          client_secret: clientSecret,
          outcome: selectedOutcome,
          payment_method: selectedMethod,
        },
      });

      setShowDummyGateway(false);

      if (selectedOutcome === 'SUCCESS') {
        setSuccessDetails({
          paymentId: confirmData.paymentIntent.id || `dmy_pm_${Math.random().toString(36).substring(2, 10)}`,
          orderId: `dmy_ord_${Math.random().toString(36).substring(2, 10)}`,
          status: confirmData.paymentIntent.status,
          amount: confirmData.paymentIntent.amount,
          currency: confirmData.paymentIntent.currency,
        });
      } else if (selectedOutcome === 'FAILURE_DECLINED') {
        setCheckoutFailureMessage(
          `Payment Failed: Decline code 'card_declined' / Insufficient funds. Your card was NOT charged.`
        );
        fetchIntentDetails();
      } else if (selectedOutcome === 'FAILURE_REVERTED') {
        setCheckoutFailureMessage(
          `Payment Failed: A system processing timeout occurred. A charge of ${formatCurrency(intent.amount, intent.currency)} was debited from your account but has been automatically reversed/refunded.`
        );
        fetchIntentDetails();
      }
    } catch (err) {
      alert(`Dummy Payment confirmation failed: ${errMsg(err)}`);
    } finally {
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className="checkout-wrapper">
        <div className="checkout-card">
          <h2>Loading Checkout Details...</h2>
          <div style={{ marginTop: '20px', color: '#64748b' }}>Connecting securely to host gateway...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="checkout-wrapper">
        <div className="checkout-card" style={{ borderTop: '4px solid #ef4444' }}>
          <h2 style={{ color: '#ef4444' }}>Checkout Error</h2>
          <p style={{ color: '#475569', margin: '18px 0' }}>{error}</p>
          <button className="ghost" onClick={() => setView('auth')}>
            Return to Portal Login
          </button>
        </div>
      </div>
    );
  }

  if (successDetails) {
    return (
      <div className="checkout-wrapper">
        <div className="checkout-card">
          <div className="success-checkmark">✓</div>
          <h2 className="success-title">Payment Successful!</h2>
          <p style={{ color: '#64748b', fontSize: '14px', marginBottom: '24px' }}>
            Your transaction has been processed securely.
          </p>

          <div className="receipt-grid">
            <div className="receipt-row">
              <span>Status</span>
              <strong style={{ color: '#16a34a', fontWeight: 'bold' }}>{successDetails.status}</strong>
            </div>
            <div className="receipt-row">
              <span>Amount Paid</span>
              <strong style={{ fontWeight: 'bold' }}>
                {formatCurrency(successDetails.amount, successDetails.currency)}
              </strong>
            </div>
            <div className="receipt-row">
              <span>{successDetails.paymentId.startsWith('dmy_') ? 'Payment Reference ID' : 'Razorpay Payment ID'}</span>
              <strong>{successDetails.paymentId}</strong>
            </div>
            <div className="receipt-row">
              <span>Order ID</span>
              <strong>{successDetails.orderId}</strong>
            </div>
          </div>

          <button
            className="ghost"
            style={{ width: '100%' }}
            onClick={() => {
              window.history.pushState({}, document.title, window.location.pathname);
              setView('auth');
            }}
          >
            Return to Portal Login
          </button>
        </div>
      </div>
    );
  }

  if (intent.status === 'SUCCEEDED') {
    return (
      <div className="checkout-wrapper">
        <div className="checkout-card">
          <div className="success-checkmark">✓</div>
          <h2 className="success-title" style={{ color: '#2563eb' }}>Invoice Already Paid</h2>
          <p style={{ color: '#64748b', fontSize: '14px', marginBottom: '24px' }}>
            This payment intent has already been successfully captured.
          </p>
          <div className="receipt-grid">
            <div className="receipt-row">
              <span>Amount</span>
              <strong>{formatCurrency(intent.amount, intent.currency)}</strong>
            </div>
            <div className="receipt-row">
              <span>Merchant</span>
              <strong>{intent.merchantName}</strong>
            </div>
            <div className="receipt-row">
              <span>Status</span>
              <strong>{intent.status}</strong>
            </div>
          </div>
          <button className="ghost" style={{ width: '100%' }} onClick={() => setView('auth')}>
            Return to Portal Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-wrapper">
      <div className="checkout-card" style={{ maxWidth: '540px' }}>
        <div className="checkout-merchant-name">{intent.merchantName}</div>
        <h2 className="checkout-title">Payment Invoice</h2>

        {checkoutFailureMessage && (
          <div style={{
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            color: '#b91c1c',
            borderRadius: '16px',
            padding: '16px',
            marginBottom: '20px',
            fontSize: '13px',
            textAlign: 'left',
            lineHeight: '1.5'
          }}>
            <strong>⚠️ Payment Transaction Failure</strong>
            <p style={{ margin: '6px 0 0 0', color: '#991b1b' }}>{checkoutFailureMessage}</p>
            <button
              className="ghost"
              style={{
                marginTop: '10px',
                padding: '4px 10px',
                fontSize: '11px',
                color: '#b91c1c',
                borderColor: '#fca5a5',
                background: '#fef2f2',
                borderRadius: '8px'
              }}
              onClick={() => setCheckoutFailureMessage('')}
            >
              Dismiss
            </button>
          </div>
        )}

        {intent.metadata?.line_items && (
          <div style={{ textAlign: 'left', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '16px', padding: '16px', marginBottom: '20px' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', borderBottom: '1px solid #e2e8f0', paddingBottom: '6px', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Items Summary</span>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <tbody>
                {intent.metadata.line_items.map((item, idx) => (
                  <tr key={idx} style={{ height: '32px' }}>
                    <td style={{ color: '#0f172a', fontWeight: 'bold' }}>{item.name}</td>
                    <td style={{ color: '#64748b', textAlign: 'center' }}>x{item.quantity}</td>
                    <td style={{ color: '#0f172a', textAlign: 'right', fontWeight: 'bold' }}>
                      {formatCurrency(Number(item.price || 0) * Number(item.quantity || 1) * 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="checkout-amount-box">
          <div className="checkout-amount-label">Grand Total Due</div>
          <div className="checkout-amount-value">{formatCurrency(intent.amount, intent.currency)}</div>
        </div>

        {savedMethodsLoaded && savedMethods.length > 0 && (
          <div style={{ marginBottom: '24px', textAlign: 'left' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
              Pay with a saved method
            </span>
            <div style={{ display: 'grid', gap: '8px' }}>
              {savedMethods.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handlePaySavedMethod(m)}
                  disabled={paying}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    border: '1px solid #cbd5e1',
                    borderRadius: '14px',
                    background: 'white',
                    cursor: paying ? 'not-allowed' : 'pointer',
                    transition: 'all 120ms ease',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    if (!paying) {
                      e.currentTarget.style.borderColor = '#2563eb';
                      e.currentTarget.style.background = '#edf4ff';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = '#cbd5e1';
                    e.currentTarget.style.background = 'white';
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '13px', color: '#0f172a' }}>
                      {m.type === 'CARD'
                        ? `${m.brand || 'Card'} ${m.last4 ? `•••• ${m.last4}` : ''}`
                        : m.type === 'UPI'
                          ? `UPI · ${m.last4 || m.brand || 'saved handle'}`
                          : `${m.brand || m.type}`}
                    </div>
                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                      {m.type === 'CARD' && m.expMonth && m.expYear
                        ? `Expires ${String(m.expMonth).padStart(2, '0')}/${m.expYear}`
                        : `Saved ${new Date(m.createdAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <span style={{ fontSize: '12px', color: '#2563eb', fontWeight: 700 }}>
                    {paying ? 'Processing…' : 'Use →'}
                  </span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '16px 0 4px' }}>
              <span style={{ flex: 1, height: '1px', background: '#cbd5e1' }} />
              <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                or use a new method
              </span>
              <span style={{ flex: 1, height: '1px', background: '#cbd5e1' }} />
            </div>
          </div>
        )}

        <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '24px', lineHeight: '1.5' }}>
          Select card, UPI, net banking, or wallet in the Razorpay overlay checkout, or simulate a dummy offline payment to complete your transaction.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button className="checkout-btn" onClick={handlePay} disabled={paying}>
            {paying ? 'Launching Gateway...' : 'Pay with Razorpay'}
          </button>
          <button
            className="checkout-btn"
            style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', marginTop: 0 }}
            onClick={handleDummyPay}
            disabled={paying}
          >
            {paying ? 'Processing...' : 'Simulate Dummy Payment (Offline)'}
          </button>
        </div>

        <div className="checkout-brands">
          <span>🔒 Secured via PCI-safe Razorpay Checkout</span>
        </div>
      </div>

      {showDummyGateway && (
        <DummyGateway
          merchantLabel={intent.merchantName}
          amount={intent.amount}
          currency={intent.currency}
          loading={paying}
          confirmLabel="Confirm Simulated Payment"
          busyLabel="Processing Simulated Payment..."
          onClose={() => setShowDummyGateway(false)}
          onConfirm={executeDummyPayment}
        />
      )}
    </div>
  );
}
