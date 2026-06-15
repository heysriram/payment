import { useEffect, useState } from 'react';
import { Input } from '../components/Input';
import { InvoiceDetailsModal } from '../components/InvoiceDetailsModal';
import { DummyGateway } from '../components/DummyGateway';
import { formatCurrency } from '../lib/format';
import { loadRazorpayScript } from '../lib/razorpay';
import type { ApiFn, AppState, DummyOutcome, DummyPaymentMethod, PaymentIntent, PaymentMethod, WalletTransaction } from '../types';
import { errMsg } from '../types';

interface CustomerDashboardProps {
  state: AppState;
  api: ApiFn;
  handleLogout: () => void;
}

export function CustomerDashboard({ state, api, handleLogout }: CustomerDashboardProps) {
  const [payments, setPayments] = useState([]);
  const [methods, setMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedIntent, setSelectedIntent] = useState(null);
  const [payingIntentId, setPayingIntentId] = useState(null);

  // Wallet State
  const [walletBalance, setWalletBalance] = useState(0);
  const [walletTransactions, setWalletTransactions] = useState([]);
  const [showAddFundsModal, setShowAddFundsModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [addAmount, setAddAmount] = useState('500');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [walletLoading, setWalletLoading] = useState(false);

  // Dummy Gateway state for wallet topup
  const [showDummyGateway, setShowDummyGateway] = useState(false);
  const [topupFailureMessage, setTopupFailureMessage] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const cPayments = await api({
        state,
        path: `/customers/${state.currentCustomerId}/payments/public`,
      });
      const cMethods = await api({
        state,
        path: `/customers/${state.currentCustomerId}/methods/public`,
      });
      setPayments(cPayments.payments);
      setMethods(cMethods.methods);

      const walletData = await api({
        state,
        path: `/customers/${state.currentCustomerId}/wallet/public`,
      });
      setWalletBalance(walletData.balance);
      setWalletTransactions(walletData.transactions);
    } catch (err) {
      console.error('Error fetching customer history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (state.currentCustomerId) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentCustomerId]);

  const handlePayInvoice = async (intent) => {
    setPayingIntentId(intent.id);
    try {
      const resp = await api({
        state,
        path: `/payment_intents/${intent.id}/checkout_link/public`,
        method: 'POST',
        body: { customerId: state.currentCustomerId },
      });
      const url = `${window.location.origin}/?intentId=${resp.intentId}&clientSecret=${resp.clientSecret}`;
      window.location.assign(url);
    } catch (err) {
      alert(`Could not open the payment link: ${errMsg(err)}`);
      setPayingIntentId(null);
    }
  };

  const handleDeleteMethod = async (method) => {
    const label =
      method.last4
        ? `${method.brand || method.type} ending in ${method.last4}`
        : method.type;
    if (!confirm(`Remove ${label} from your saved methods?`)) return;
    try {
      await api({
        state,
        path: `/customers/${state.currentCustomerId}/methods/${method.id}/public`,
        method: 'DELETE',
      });
      setMethods((curr) => curr.filter((m) => m.id !== method.id));
    } catch (err) {
      alert(`Could not remove method: ${errMsg(err)}`);
    }
  };

  const handleAddFundsSubmit = async (e) => {
    e.preventDefault();
    const amountInPaise = Math.round(Number(addAmount) * 100);
    if (amountInPaise < 100) {
      alert('Minimum top-up amount is ₹1.00 (100 paise).');
      return;
    }
    setWalletLoading(true);
    try {
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        alert('Failed to load Razorpay checkout script. Are you online?');
        setWalletLoading(false);
        return;
      }

      const orderData = await api({
        state,
        path: `/customers/${state.currentCustomerId}/wallet/order/public`,
        method: 'POST',
        body: { amount: amountInPaise },
      });

      const options = {
        key: orderData.razorpayKeyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Wallet Top-up',
        description: `Add money to Wallet for ${state.currentCustomerName}`,
        order_id: orderData.orderId,
        handler: async function (response) {
          try {
            await api({
              state,
              path: `/customers/${state.currentCustomerId}/wallet/topup/public`,
              method: 'POST',
              body: {
                amount: orderData.amount,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
              },
            });
            alert(`Successfully added ${formatCurrency(orderData.amount)} to your wallet!`);
            setShowAddFundsModal(false);
            setAddAmount('500');
            fetchData();
          } catch (err) {
            alert(`Top-up verification failed: ${errMsg(err)}`);
          }
        },
        prefill: {
          name: state.currentCustomerName,
          email: state.currentCustomerEmail,
        },
        theme: { color: '#0f766e' },
      };

      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function (resp) {
        alert(`Payment failed: ${resp.error.description}`);
      });
      rzp.open();
    } catch (err) {
      alert(`Failed to initialize top-up: ${errMsg(err)}`);
    } finally {
      setWalletLoading(false);
    }
  };

  const handleDummyAddFunds = (e) => {
    if (e) e.preventDefault();
    const amountInPaise = Math.round(Number(addAmount) * 100);
    if (amountInPaise < 100) {
      alert('Minimum top-up amount is ₹1.00 (100 paise).');
      return;
    }
    setShowDummyGateway(true);
  };

  const executeDummyWalletTopUp = async (selectedMethod, selectedOutcome) => {
    const amountInPaise = Math.round(Number(addAmount) * 100);
    if (amountInPaise < 100) {
      alert('Minimum top-up amount is ₹1.00 (100 paise).');
      return;
    }
    setWalletLoading(true);
    setTopupFailureMessage('');
    try {
      await api({
        state,
        path: `/customers/${state.currentCustomerId}/wallet/topup/dummy`,
        method: 'POST',
        body: {
          amount: amountInPaise,
          outcome: selectedOutcome,
          payment_method: selectedMethod,
        },
      });

      setShowDummyGateway(false);
      setShowAddFundsModal(false);

      if (selectedOutcome === 'SUCCESS') {
        alert(`Successfully added ${formatCurrency(amountInPaise)} (Dummy) to your wallet!`);
        setAddAmount('500');
        fetchData();
      } else if (selectedOutcome === 'FAILURE_DECLINED') {
        setTopupFailureMessage(
          `Wallet Top-up Failed: Decline code 'insufficient_funds' or card declined by bank. Your account was NOT charged.`
        );
        fetchData();
      } else if (selectedOutcome === 'FAILURE_REVERTED') {
        setTopupFailureMessage(
          `Wallet Top-up Failed: A system processing timeout occurred. A charge of ${formatCurrency(amountInPaise)} was debited from your account but has been automatically reversed/refunded.`
        );
        fetchData();
      }
    } catch (err) {
      alert(`Dummy Wallet Top-up failed: ${errMsg(err)}`);
    } finally {
      setWalletLoading(false);
    }
  };

  const handleWithdrawSubmit = async (e) => {
    e.preventDefault();
    const amountInPaise = Math.round(Number(withdrawAmount) * 100);
    if (amountInPaise <= 0) {
      alert('Please enter a valid withdrawal amount.');
      return;
    }
    if (amountInPaise > walletBalance) {
      alert(`Insufficient wallet balance. Available: ${formatCurrency(walletBalance)}`);
      return;
    }
    setWalletLoading(true);
    try {
      await api({
        state,
        path: `/customers/${state.currentCustomerId}/wallet/withdraw/public`,
        method: 'POST',
        body: { amount: amountInPaise },
      });
      alert(`Successfully withdrew ${formatCurrency(amountInPaise)} from your wallet!`);
      setShowWithdrawModal(false);
      setWithdrawAmount('');
      fetchData();
    } catch (err) {
      alert(`Withdrawal failed: ${errMsg(err)}`);
    } finally {
      setWalletLoading(false);
    }
  };

  const handleDownloadReceipt = (p) => {
    const lineItems = p.metadata?.line_items || [];
    const itemsSummary = lineItems.map((item) => {
      const total = ((Number(item.price || 0) * Number(item.quantity || 1))).toFixed(2);
      return `${item.name} x${item.quantity} -- ₹${item.price} (Total: ₹${total})`;
    }).join('\n');

    const receiptText = `
========================================
           PAYMENT GATEWAY RECEIPT
========================================
Merchant Store: ${p.merchant?.name || 'Unknown Store'}
Invoice UUID:   ${p.id}
Status:         ${p.status}
Payment Date:   ${new Date(p.createdAt).toLocaleString()}
Currency:       ${p.currency}
----------------------------------------
Itemized Line Bills:
${itemsSummary || 'Flat payment with no itemized line details.'}
----------------------------------------
Grand Total Paid: ₹${(p.amount / 100).toFixed(2)}
Razorpay Ref ID:  ${p.transactions?.[0]?.gatewayTxnId || 'N/A'}

Thank you for your purchase!
Secure payment verified via PCI Gateway.
========================================
`;

    const blob = new Blob([receiptText], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `receipt_${p.id.slice(0, 8)}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0' }}>
        <h2>Loading Customer Purchase History...</h2>
      </div>
    );
  }

  return (
    <div className="customer-dashboard" style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
      <header style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p className="eyebrow">Customer Account</p>
          <h1>Welcome, {state.currentCustomerName}</h1>
          <p style={{ color: '#64748b', margin: '4px 0 0' }}>
            Email ID: {state.currentCustomerEmail} | Customer UUID: <span style={{ fontFamily: 'monospace' }}>{state.currentCustomerId}</span>
          </p>
        </div>
        <button className="ghost" style={{ background: '#fff1f2', borderColor: '#ffe4e6', color: '#be123c' }} onClick={handleLogout}>
          Logout
        </button>
      </header>

      {topupFailureMessage && (
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
          <strong>⚠️ Wallet Top-up Transaction Failure</strong>
          <p style={{ margin: '6px 0 0 0', color: '#991b1b' }}>{topupFailureMessage}</p>
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
            onClick={() => setTopupFailureMessage('')}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Metrics Row */}
      <section className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '28px' }}>
        <div className="stat-card" style={{ background: 'linear-gradient(135deg, #0d9488 0%, #0f766e 100%)' }}>
          <span>Wallet Balance</span>
          <strong style={{ fontSize: '24px' }}>{formatCurrency(walletBalance)}</strong>
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button
              onClick={() => setShowAddFundsModal(true)}
              style={{
                background: 'white',
                color: '#0d9488',
                border: '0',
                borderRadius: '8px',
                padding: '6px 12px',
                fontSize: '11px',
                fontWeight: '800',
                cursor: 'pointer',
              }}
            >
              + Add Funds
            </button>
            <button
              onClick={() => setShowWithdrawModal(true)}
              disabled={walletBalance <= 0}
              style={{
                background: 'rgba(255, 255, 255, 0.2)',
                color: 'white',
                border: '0',
                borderRadius: '8px',
                padding: '6px 12px',
                fontSize: '11px',
                fontWeight: '800',
                cursor: walletBalance <= 0 ? 'not-allowed' : 'pointer',
              }}
            >
              Withdraw
            </button>
          </div>
        </div>
        <div className="stat-card">
          <span>Total Spent</span>
          <strong>
            {formatCurrency(
              payments.filter((p) => p.status === 'SUCCEEDED').reduce((acc, curr) => acc + curr.amount, 0)
            )}
          </strong>
        </div>
        <div className="stat-card">
          <span>Total Purchases</span>
          <strong>{payments.length}</strong>
        </div>
        <div className="stat-card">
          <span>Saved Cards</span>
          <strong>{methods.length}</strong>
        </div>
      </section>

      {/* Pending Invoices — invoices a merchant generated for this customer
          but hasn't been paid yet. Click "Pay Now" to mint a fresh checkout
          link and complete payment. */}
      {(() => {
        const pending = payments.filter(
          (p) => !['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(p.status)
        );
        if (pending.length === 0) return null;
        const totalDue = pending.reduce((sum, p) => sum + p.amount, 0);
        return (
          <section
            style={{
              marginBottom: '24px',
              padding: '24px',
              background: 'linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%)',
              border: '1px solid #fdba74',
              borderRadius: '20px',
              boxShadow: '0 4px 12px -4px rgba(234, 88, 12, 0.15)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <p className="eyebrow" style={{ color: '#9a3412', margin: 0 }}>
                  Action Required
                </p>
                <h3 style={{ margin: '4px 0 0', color: '#7c2d12' }}>
                  {pending.length} pending invoice{pending.length === 1 ? '' : 's'} ·{' '}
                  <span style={{ fontWeight: 800 }}>{formatCurrency(totalDue)}</span> due
                </h3>
              </div>
            </div>
            <div style={{ display: 'grid', gap: '10px' }}>
              {pending.map((p) => (
                <div
                  key={p.id}
                  style={{
                    background: 'white',
                    borderRadius: '14px',
                    padding: '14px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    flexWrap: 'wrap',
                    border: '1px solid #fed7aa',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: '14px', color: '#0f172a' }}>
                        {p.merchant?.name || 'Unknown Store'}
                      </strong>
                      <span className={`status-badge ${p.status.toLowerCase()}`}>{p.status}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px', fontFamily: 'monospace' }}>
                      {p.id.slice(0, 13)}… · created {new Date(p.createdAt).toLocaleDateString()}
                    </div>
                    {p.metadata?.line_items && p.metadata.line_items.length > 0 && (
                      <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
                        {p.metadata.line_items
                          .map((li) => `${li.name} ×${li.quantity}`)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>
                      {formatCurrency(p.amount, p.currency)}
                    </div>
                    <button
                      className="action"
                      onClick={() => handlePayInvoice(p)}
                      disabled={payingIntentId === p.id}
                      style={{
                        marginTop: '8px',
                        padding: '8px 16px',
                        fontSize: '12px',
                        background: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)',
                        boxShadow: '0 4px 12px -4px rgba(234, 88, 12, 0.4)',
                      }}
                    >
                      {payingIntentId === p.id ? 'Opening checkout…' : 'Pay Now →'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      {/* Main logs */}
      <div className="table-container">
        <div className="table-header">
          <h3>My Purchase History</h3>
          <button className="ghost" onClick={fetchData}>Refresh</button>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Invoice ID</th>
              <th>Merchant Store</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Payment Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td style={{ fontFamily: 'monospace' }}>{p.id.slice(0, 13)}...</td>
                <td style={{ fontWeight: 800 }}>{p.merchant?.name || 'Unknown Store'}</td>
                <td>{formatCurrency(p.amount, p.currency)}</td>
                <td>
                  <span className={`status-badge ${p.status.toLowerCase()}`}>
                    {p.status}
                  </span>
                </td>
                <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                <td>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button className="ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setSelectedIntent(p)}>
                      View Receipt
                    </button>
                    {!['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(p.status) && (
                      <button
                        className="ghost"
                        style={{ padding: '4px 10px', fontSize: '11px', color: '#9a3412', borderColor: '#fed7aa', background: '#fff7ed' }}
                        onClick={() => handlePayInvoice(p)}
                        disabled={payingIntentId === p.id}
                      >
                        {payingIntentId === p.id ? 'Opening…' : 'Pay Now'}
                      </button>
                    )}
                    {p.status === 'SUCCEEDED' && (
                      <button className="ghost" style={{ padding: '4px 10px', fontSize: '11px', color: '#16a34a', borderColor: '#bbf7d0', background: '#f0fdf4' }} onClick={() => handleDownloadReceipt(p)}>
                        Download TXT
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                  No payment records found. Pay using a generated checkout link to see it list here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Wallet Transactions Log */}
      <div className="table-container" style={{ marginTop: '28px' }}>
        <div className="table-header">
          <h3>Wallet Transactions Log</h3>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Transaction ID</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Reference ID</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {walletTransactions.map((t) => (
              <tr key={t.id}>
                <td style={{ fontFamily: 'monospace' }}>{t.id}</td>
                <td>
                  <span style={{ fontWeight: 800, color: t.type === 'TOPUP' ? '#0d9488' : '#be123c' }}>
                    {t.type}
                  </span>
                </td>
                <td>{formatCurrency(t.amount)}</td>
                <td>
                  <span className="status-badge succeeded">{t.status}</span>
                </td>
                <td style={{ fontFamily: 'monospace' }}>{t.ref}</td>
                <td>{new Date(t.date).toLocaleString()}</td>
              </tr>
            ))}
            {walletTransactions.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                  No wallet transactions yet. Top up your wallet to see activities logged here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="table-container" style={{ marginTop: '28px' }}>
        <div className="table-header">
          <h3>Saved Cards & UPI Handles</h3>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Method ID</th>
              <th>Type</th>
              <th>Brand / Handler</th>
              <th>Card Last 4</th>
              <th>Expiry</th>
              <th>Authorized On</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {methods.map((m) => (
              <tr key={m.id}>
                <td style={{ fontFamily: 'monospace' }}>{m.id.slice(0, 13)}...</td>
                <td style={{ fontWeight: 800 }}>{m.type}</td>
                <td>{m.brand || 'N/A'}</td>
                <td>{m.last4 ? `•••• ${m.last4}` : 'N/A'}</td>
                <td>{m.expMonth && m.expYear ? `${m.expMonth}/${m.expYear}` : 'N/A'}</td>
                <td>{new Date(m.createdAt).toLocaleDateString()}</td>
                <td>
                  <button
                    className="ghost"
                    style={{ padding: '4px 10px', fontSize: '11px', color: '#be123c', borderColor: '#ffe4e6', background: '#fff1f2' }}
                    onClick={() => handleDeleteMethod(m)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {methods.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                  No saved payment methods. Cards are tokenized automatically upon successful checkouts.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add Funds Modal */}
      {showAddFundsModal && (
        <div className="modal-overlay" onClick={() => setShowAddFundsModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px' }}>Add Funds to Wallet</h3>
            <form onSubmit={handleAddFundsSubmit}>
              <Input
                label="Amount to Add (₹)"
                type="number"
                value={addAmount}
                onChange={setAddAmount}
                placeholder="e.g. 500"
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '20px' }}>
                <button className="action" type="submit" disabled={walletLoading}>
                  {walletLoading ? 'Processing...' : 'Pay via Razorpay'}
                </button>
                <button
                  className="action"
                  type="button"
                  style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' }}
                  onClick={handleDummyAddFunds}
                  disabled={walletLoading}
                >
                  {walletLoading ? 'Processing...' : 'Simulate Dummy Payment'}
                </button>
                <button className="action secondary" type="button" onClick={() => setShowAddFundsModal(false)} disabled={walletLoading}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Withdraw Funds Modal */}
      {showWithdrawModal && (
        <div className="modal-overlay" onClick={() => setShowWithdrawModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px' }}>Withdraw Funds from Wallet</h3>
            <form onSubmit={handleWithdrawSubmit}>
              <Input
                label="Amount to Withdraw (₹)"
                type="number"
                value={withdrawAmount}
                onChange={setWithdrawAmount}
                placeholder="e.g. 200"
              />
              <p style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
                Available Wallet Balance: {formatCurrency(walletBalance)}
              </p>
              <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                <button className="action danger" type="submit" disabled={walletLoading}>
                  {walletLoading ? 'Processing...' : 'Confirm Withdrawal'}
                </button>
                <button className="action secondary" type="button" onClick={() => setShowWithdrawModal(false)} disabled={walletLoading}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showDummyGateway && (
        <DummyGateway
          merchantLabel="Self (Wallet Top-up)"
          amount={Math.round(Number(addAmount) * 100)}
          loading={walletLoading}
          confirmLabel="Confirm Simulated Top-up"
          busyLabel="Processing Simulated Top-up..."
          onClose={() => setShowDummyGateway(false)}
          onConfirm={executeDummyWalletTopUp}
        />
      )}

      {selectedIntent && <InvoiceDetailsModal intent={selectedIntent} onClose={() => setSelectedIntent(null)} />}
    </div>
  );
}
