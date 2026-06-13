import React, { useMemo, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const defaults = {
  apiBase: '/api/v1',
  dashboardJwt: '',
  partialJwt: '',
  secretKey: '',
  publicKey: '',
  merchantId: '',
  customerId: '',
  paymentMethodId: '',
  paymentIntentId: '',
  currentCustomerId: '',
  currentCustomerName: '',
  currentCustomerEmail: '',
};

const initialForms = {
  register: {
    name: 'Razorpay Store',
    legalName: 'Razorpay Store Pvt Ltd',
    gst: '27ABCDE1234F1Z5',
    pan: 'ABCDE1234F',
    email: 'merchant@store.com',
    password: 'StrongPass123!',
  },
  login: {
    email: 'merchant@store.com',
    password: 'StrongPass123!',
    code: '',
  },
  customerRegister: {
    name: 'Jane Doe',
    email: 'customer@example.com',
    phone: '+919876543210',
  },
  customerLogin: {
    email: 'customer@example.com',
  },
};

function readStorage() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('pg-console') || '{}') };
  } catch {
    return defaults;
  }
}

function writeStorage(value) {
  localStorage.setItem('pg-console', JSON.stringify(value));
}

async function api({ state, path, method = 'GET', token, idempotencyKey, body }) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${state.apiBase || '/api/v1'}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

function formatCurrency(amount, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency,
  }).format(amount / 100);
}

function loadRazorpayScript() {
  return new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

function App() {
  const [state, setState] = useState(readStorage);
  const [forms, setForms] = useState(initialForms);

  // Read URL params to see if we should render checkout directly
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const intentId = urlParams.get('intentId') || '';
  const clientSecret = urlParams.get('clientSecret') || '';

  const [view, setView] = useState(() => {
    if (intentId && clientSecret) return 'checkout';
    const storage = readStorage();
    if (storage.dashboardJwt) return 'dashboard';
    if (storage.currentCustomerId) return 'customer_dashboard';
    return 'auth'; // 'auth' | 'dashboard' | 'customer_dashboard' | 'checkout'
  });

  const updateState = (patch) => {
    setState((current) => {
      const next = { ...current, ...patch };
      writeStorage(next);
      return next;
    });
  };

  const updateForm = (group, field, value) => {
    setForms((current) => ({
      ...current,
      [group]: { ...current[group], [field]: value },
    }));
  };

  const handleLogout = () => {
    updateState({
      dashboardJwt: '',
      partialJwt: '',
      secretKey: '',
      publicKey: '',
      merchantId: '',
      customerId: '',
      paymentMethodId: '',
      paymentIntentId: '',
      currentCustomerId: '',
      currentCustomerName: '',
      currentCustomerEmail: '',
    });
    setView('auth');
  };

  if (view === 'checkout') {
    return (
      <CustomerCheckout
        intentId={intentId}
        clientSecret={clientSecret}
        state={state}
        setView={setView}
      />
    );
  }

  if (view === 'auth') {
    return (
      <AuthPortal
        state={state}
        forms={forms}
        updateForm={updateForm}
        updateState={updateState}
        setView={setView}
        api={api}
      />
    );
  }

  if (view === 'customer_dashboard') {
    return (
      <main className="shell" style={{ gridTemplateColumns: '1fr' }}>
        <section className="workspace">
          <CustomerDashboard state={state} api={api} handleLogout={handleLogout} />
        </section>
      </main>
    );
  }

  return (
    <main className="shell" style={{ gridTemplateColumns: '1fr' }}>
      <section className="workspace">
        <MerchantDashboard state={state} api={api} handleLogout={handleLogout} updateState={updateState} />
      </section>
    </main>
  );
}

// ─── AUTH PORTAL (REGISTER & LOGIN) ─────────────────────
function AuthPortal({ state, forms, updateForm, updateState, setView, api }) {
  const [portalMode, setPortalMode] = useState('merchant'); // 'merchant' | 'customer'
  const [tab, setTab] = useState('login'); // 'login' | 'register' | 'totp'
  const [totpQr, setTotpQr] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api({
        state,
        path: '/merchants/register',
        method: 'POST',
        body: forms.register,
      });
      updateState({
        merchantId: data.merchant?.id,
        secretKey: data.apiKeys?.test?.secretKey,
        publicKey: data.apiKeys?.test?.publicKey,
      });

      updateForm('login', 'email', forms.register.email);
      updateForm('login', 'password', forms.register.password);
      
      setTab('login');
      alert('Merchant account created successfully! Please Sign In below to configure your Authenticator.');
    } catch (err) {
      setError(err.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api({
        state,
        path: '/auth/login',
        method: 'POST',
        body: {
          email: forms.login.email,
          password: forms.login.password,
        },
      });

      updateState({ partialJwt: data.token });

      if (data.totpUri) {
        setTotpQr(data.totpUri);
      } else {
        setTotpQr('');
      }

      setTab('totp');
    } catch (err) {
      setError(err.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleTotpSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api({
        state,
        path: '/auth/totp/verify',
        method: 'POST',
        token: state.partialJwt,
        body: { code: forms.login.code },
      });

      updateState({ dashboardJwt: data.token });
      setView('dashboard');
    } catch (err) {
      setError(err.message || 'TOTP code verification failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleCustomerLoginSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api({
        state,
        path: '/customers/login/public',
        method: 'POST',
        body: { email: forms.customerLogin.email },
      });

      updateState({
        currentCustomerId: data.customer.id,
        currentCustomerName: data.customer.name,
        currentCustomerEmail: data.customer.email,
      });

      setView('customer_dashboard');
    } catch (err) {
      setError(err.message || 'Customer email lookup failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleCustomerRegisterSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api({
        state,
        path: '/customers/register/public',
        method: 'POST',
        body: forms.customerRegister,
      });

      updateState({
        currentCustomerId: data.customer.id,
        currentCustomerName: data.customer.name,
        currentCustomerEmail: data.customer.email,
      });

      setView('customer_dashboard');
      alert(`Customer registration successful! Logged in as ${data.customer.name}`);
    } catch (err) {
      setError(err.message || 'Customer registration failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-card">
        <div className="portal-selector-tabs" style={{ display: 'flex', gap: '10px', marginBottom: '24px', background: '#e2e8f0', padding: '6px', borderRadius: '14px' }}>
          <button
            type="button"
            className={`auth-tab-btn ${portalMode === 'merchant' ? 'active' : ''}`}
            onClick={() => {
              setPortalMode('merchant');
              setTab('login');
              setError('');
            }}
          >
            Merchant Portal
          </button>
          <button
            type="button"
            className={`auth-tab-btn ${portalMode === 'customer' ? 'active' : ''}`}
            onClick={() => {
              setPortalMode('customer');
              setTab('login');
              setError('');
            }}
          >
            Customer Portal
          </button>
        </div>

        <div className="auth-header">
          <div className="auth-logo">{portalMode === 'merchant' ? 'PG' : 'C'}</div>
          <h2>{portalMode === 'merchant' ? 'Payment Gateway Portal' : 'Customer Account Login'}</h2>
          <p>
            {portalMode === 'merchant'
              ? 'Configure payments, manage ledger balances, and check customer transactions.'
              : 'View your transaction receipts, billing statements, and tokenized payment methods.'}
          </p>
        </div>

        {error && <div className="auth-error">{error}</div>}

        {tab !== 'totp' && (
          <div className="auth-tabs">
            <button
              className={`auth-tab-btn ${tab === 'login' ? 'active' : ''}`}
              onClick={() => {
                setError('');
                setTab('login');
              }}
            >
              Sign In
            </button>
            <button
              className={`auth-tab-btn ${tab === 'register' ? 'active' : ''}`}
              onClick={() => {
                setError('');
                setTab('register');
              }}
            >
              Sign Up
            </button>
          </div>
        )}

        {portalMode === 'merchant' ? (
          <>
            {tab === 'register' && (
              <form onSubmit={handleRegisterSubmit}>
                <Input label="Store Name" value={forms.register.name} onChange={(val) => updateForm('register', 'name', val)} />
                <Input label="Legal Name" value={forms.register.legalName} onChange={(val) => updateForm('register', 'legalName', val)} />
                <div className="row">
                  <Input label="GSTIN Number (Optional)" value={forms.register.gst} onChange={(val) => updateForm('register', 'gst', val)} />
                  <Input label="Business PAN (Optional)" value={forms.register.pan} onChange={(val) => updateForm('register', 'pan', val)} />
                </div>
                <Input label="Business Email" type="email" value={forms.register.email} onChange={(val) => updateForm('register', 'email', val)} />
                <Input label="Password" type="password" value={forms.register.password} onChange={(val) => updateForm('register', 'password', val)} />
                
                <button className="auth-submit-btn" type="submit" disabled={loading}>
                  {loading ? 'Creating Account...' : 'Register Merchant'}
                </button>
              </form>
            )}

            {tab === 'login' && (
              <form onSubmit={handleLoginSubmit}>
                <Input label="Business Email" type="email" value={forms.login.email} onChange={(val) => updateForm('login', 'email', val)} />
                <Input label="Password" type="password" value={forms.login.password} onChange={(val) => updateForm('login', 'password', val)} />
                
                <button className="auth-submit-btn" type="submit" disabled={loading}>
                  {loading ? 'Signing In...' : 'Verify Password'}
                </button>
              </form>
            )}

            {tab === 'totp' && (
              <form onSubmit={handleTotpSubmit}>
                <h3>Authenticator Verification</h3>
                <p style={{ color: '#64748b', fontSize: '13px', margin: '8px 0 20px', lineHeight: '1.4' }}>
                  Two-Factor Authentication is required for secure account audits. Input the 6-digit verification code.
                </p>

                {totpQr && (
                  <div className="totp-setup-box">
                    <strong>Scan Authenticator QR Code</strong>
                    <div style={{ margin: '14px 0' }}>
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(totpQr)}`}
                        alt="Scan Authenticator TOTP"
                        style={{ background: 'white', padding: '10px', borderRadius: '12px', border: '1px solid #cbd5e1' }}
                      />
                    </div>
                    <div className="totp-setup-text">
                      Can't scan? Use Google Authenticator and add manual entry with your email.
                    </div>
                  </div>
                )}

                <Input
                  label="6-Digit Verification Token"
                  value={forms.login.code}
                  onChange={(val) => updateForm('login', 'code', val)}
                  placeholder="e.g. 123456"
                />

                <button className="auth-submit-btn" type="submit" disabled={loading}>
                  {loading ? 'Verifying...' : 'Verify Authenticator'}
                </button>

                <button
                  className="ghost"
                  type="button"
                  style={{ width: '100%', marginTop: '10px' }}
                  onClick={() => {
                    setError('');
                    setTab('login');
                  }}
                >
                  Back to Password Login
                </button>
              </form>
            )}
          </>
        ) : (
          <>
            {tab === 'login' && (
              <form onSubmit={handleCustomerLoginSubmit}>
                <Input
                  label="Customer Email Address"
                  type="email"
                  value={forms.customerLogin.email}
                  onChange={(val) => updateForm('customerLogin', 'email', val)}
                />
                <button className="auth-submit-btn" type="submit" disabled={loading} style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', boxShadow: '0 10px 20px -5px rgba(16, 185, 129, 0.25)' }}>
                  {loading ? 'Logging in...' : 'Sign In Customer'}
                </button>
              </form>
            )}

            {tab === 'register' && (
              <form onSubmit={handleCustomerRegisterSubmit}>
                <Input
                  label="Full Name"
                  value={forms.customerRegister.name}
                  onChange={(val) => updateForm('customerRegister', 'name', val)}
                />
                <Input
                  label="Email Address"
                  type="email"
                  value={forms.customerRegister.email}
                  onChange={(val) => updateForm('customerRegister', 'email', val)}
                />
                <Input
                  label="Mobile Contact (Optional)"
                  placeholder="+919876543210"
                  value={forms.customerRegister.phone}
                  onChange={(val) => updateForm('customerRegister', 'phone', val)}
                />
                <button className="auth-submit-btn" type="submit" disabled={loading} style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', boxShadow: '0 10px 20px -5px rgba(16, 185, 129, 0.25)' }}>
                  {loading ? 'Creating Account...' : 'Sign Up Customer'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── CUSTOMER PORTAL / DASHBOARD ───────────────────────────
function CustomerDashboard({ state, api, handleLogout }) {
  const [payments, setPayments] = useState([]);
  const [methods, setMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedIntent, setSelectedIntent] = useState(null); // details popup

  // Wallet State
  const [walletBalance, setWalletBalance] = useState(0);
  const [walletTransactions, setWalletTransactions] = useState([]);
  const [showAddFundsModal, setShowAddFundsModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [addAmount, setAddAmount] = useState('500');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [walletLoading, setWalletLoading] = useState(false);

  // Dummy Gateway States for Wallet Topup
  const [showDummyGateway, setShowDummyGateway] = useState(false);
  const [dummyGatewayMethod, setDummyGatewayMethod] = useState('card');
  const [dummyGatewayOutcome, setDummyGatewayOutcome] = useState('SUCCESS');
  const [dummyCardNumber, setDummyCardNumber] = useState('4111 1111 1111 1111');
  const [dummyUpiVpa, setDummyUpiVpa] = useState('test@upi');
  const [dummyBank, setDummyBank] = useState('HDFC Bank');
  const [dummyWallet, setDummyWallet] = useState('Paytm Wallet');
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
  }, [state.currentCustomerId]);

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
            alert(`Top-up verification failed: ${err.message}`);
          }
        },
        prefill: {
          name: state.currentCustomerName,
          email: state.currentCustomerEmail,
        },
        theme: {
          color: '#0f766e',
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function (resp) {
        alert(`Payment failed: ${resp.error.description}`);
      });
      rzp.open();
    } catch (err) {
      alert(`Failed to initialize top-up: ${err.message}`);
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
      alert(`Dummy Wallet Top-up failed: ${err.message}`);
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
      alert(`Withdrawal failed: ${err.message}`);
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
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button className="ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setSelectedIntent(p)}>
                      View Receipt
                    </button>
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
                  <span
                    style={{
                      fontWeight: 800,
                      color: t.type === 'TOPUP' ? '#0d9488' : '#be123c',
                    }}
                  >
                    {t.type}
                  </span>
                </td>
                <td>{formatCurrency(t.amount)}</td>
                <td>
                  <span className="status-badge succeeded">
                    {t.status}
                  </span>
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
              </tr>
            ))}
            {methods.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
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
        <div className="modal-overlay" style={{ zIndex: 9999 }} onClick={() => setShowDummyGateway(false)}>
          <div className="modal-card" style={{ maxWidth: '520px', padding: '28px', borderRadius: '24px', border: '1px solid #e2e8f0', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '24px' }}>🛡️</span>
                <div style={{ textAlign: 'left' }}>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800 }}>Secure Sandbox Gateway</h3>
                  <span style={{ fontSize: '11px', color: '#64748b' }}>Simulated Payment Processor</span>
                </div>
              </div>
              <button className="ghost" type="button" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={() => setShowDummyGateway(false)}>Close</button>
            </div>

            {/* Merchant / Amount Info Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', background: '#f8fafc', padding: '14px', borderRadius: '16px', border: '1px solid #cbd5e1', marginBottom: '20px', fontSize: '13px' }}>
              <div style={{ textAlign: 'left' }}>
                <span style={{ color: '#64748b', display: 'block', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase' }}>Paying Merchant</span>
                <strong style={{ display: 'block', marginTop: '3px' }}>Self (Wallet Top-up)</strong>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ color: '#64748b', display: 'block', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase' }}>Amount Due</span>
                <strong style={{ color: '#2563eb', display: 'block', marginTop: '3px', fontSize: '16px' }}>{formatCurrency(Math.round(Number(addAmount) * 100))}</strong>
              </div>
            </div>

            {/* Step 1: Select Payment Method */}
            <div style={{ textAlign: 'left', marginBottom: '20px' }}>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Choose Payment Method</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                {[
                  { id: 'card', label: 'Card', icon: '💳' },
                  { id: 'upi', label: 'UPI', icon: '📱' },
                  { id: 'netbanking', label: 'Bank', icon: '🏦' },
                  { id: 'wallet', label: 'Wallet', icon: '👛' },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setDummyGatewayMethod(m.id)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '12px 8px',
                      borderRadius: '16px',
                      border: '2px solid',
                      borderColor: dummyGatewayMethod === m.id ? '#2563eb' : '#cbd5e1',
                      background: dummyGatewayMethod === m.id ? '#edf4ff' : 'white',
                      color: dummyGatewayMethod === m.id ? '#1e40af' : '#1e293b',
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

            {/* Step 2: Payment Details Entry Mockup */}
            <div style={{ textAlign: 'left', background: '#f8fafc', padding: '16px', borderRadius: '16px', border: '1px solid #cbd5e1', marginBottom: '20px' }}>
              {dummyGatewayMethod === 'card' && (
                <div style={{ display: 'grid', gap: '10px' }}>
                  <Input label="Mock Card Number" value={dummyCardNumber} onChange={setDummyCardNumber} placeholder="4111 1111 1111 1111" />
                  <div className="row" style={{ display: 'flex', gap: '8px' }}>
                    <div style={{ flex: 1 }}><Input label="Expiry Date" placeholder="MM/YY" value="12/30" onChange={() => {}} /></div>
                    <div style={{ flex: 1 }}><Input label="CVV" type="password" placeholder="123" value="123" onChange={() => {}} /></div>
                  </div>
                </div>
              )}
              {dummyGatewayMethod === 'upi' && (
                <div>
                  <Input label="Mock UPI VPA Address" value={dummyUpiVpa} onChange={setDummyUpiVpa} placeholder="e.g. user@gpay" />
                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                    {['test@upi', 'customer@okaxis', 'pay@ybl'].map((vpa) => (
                      <button
                        key={vpa}
                        type="button"
                        className="ghost"
                        style={{ padding: '4px 8px', borderRadius: '8px', fontSize: '10px' }}
                        onClick={() => setDummyUpiVpa(vpa)}
                      >
                        {vpa}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {dummyGatewayMethod === 'netbanking' && (
                <div>
                  <Select
                    label="Mock Bank Institution"
                    value={dummyBank}
                    onChange={setDummyBank}
                    options={['HDFC Bank', 'State Bank of India', 'ICICI Bank', 'Axis Bank', 'Kotak Bank']}
                  />
                </div>
              )}
              {dummyGatewayMethod === 'wallet' && (
                <div>
                  <Select
                    label="Mock Wallet Service"
                    value={dummyWallet}
                    onChange={setDummyWallet}
                    options={['Paytm Wallet', 'PhonePe Wallet', 'Amazon Pay', 'Mobikwik']}
                  />
                </div>
              )}
            </div>

            {/* Step 3: Choose Transaction Outcome */}
            <div style={{ textAlign: 'left', marginBottom: '24px' }}>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Simulate Gateway Outcome</span>
              <div style={{ display: 'grid', gap: '10px' }}>
                {[
                  {
                    id: 'SUCCESS',
                    title: '🟢 SUCCESS',
                    desc: 'Debits customer, credits wallet balance, registers SUCCESS status.',
                  },
                  {
                    id: 'FAILURE_DECLINED',
                    title: '🔴 FAILURE (Card Declined)',
                    desc: 'Simulates direct rejection. No funds are cut, registers FAILED status.',
                  },
                  {
                    id: 'FAILURE_REVERTED',
                    title: '⚠️ FAILURE (Money Cut & Reverted)',
                    desc: 'Funds are debited, but transaction timeout triggers auto-reversal/refund.',
                  },
                ].map((out) => (
                  <label
                    key={out.id}
                    style={{
                      display: 'flex',
                      gap: '12px',
                      alignItems: 'start',
                      padding: '12px',
                      borderRadius: '16px',
                      border: '2px solid',
                      borderColor: dummyGatewayOutcome === out.id ? '#2563eb' : '#cbd5e1',
                      background: dummyGatewayOutcome === out.id ? '#edf4ff' : 'white',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <input
                      type="radio"
                      name="gateway_outcome_topup"
                      value={out.id}
                      checked={dummyGatewayOutcome === out.id}
                      onChange={() => setDummyGatewayOutcome(out.id)}
                      style={{ marginTop: '3px' }}
                    />
                    <div style={{ fontSize: '12px' }}>
                      <strong style={{ display: 'block', color: dummyGatewayOutcome === out.id ? '#1e40af' : '#1e293b', fontWeight: 'bold' }}>{out.title}</strong>
                      <span style={{ color: '#64748b', fontSize: '11px', display: 'block', marginTop: '2px', lineHeight: '1.3' }}>{out.desc}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Proceed Actions */}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                className="action"
                style={{ flex: 1, height: '48px', fontSize: '14px', background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)' }}
                onClick={() => executeDummyWalletTopUp(dummyGatewayMethod, dummyGatewayOutcome)}
                disabled={walletLoading}
              >
                {walletLoading ? 'Processing Simulated Top-up...' : 'Confirm Simulated Top-up'}
              </button>
              <button
                className="action secondary"
                style={{ height: '48px' }}
                onClick={() => setShowDummyGateway(false)}
                disabled={walletLoading}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedIntent && <InvoiceDetailsModal intent={selectedIntent} onClose={() => setSelectedIntent(null)} />}
    </div>
  );
}

// ─── MERCHANT DASHBOARD VIEW ────────────────────────────────────────
function MerchantDashboard({ state, api, handleLogout, updateState }) {
  const [merchant, setMerchant] = useState(null);
  const [balance, setBalance] = useState({ available: 0, pending: 0 });
  const [intents, setIntents] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [wallets, setWallets] = useState([]);
  const [selectedWalletTransactions, setSelectedWalletTransactions] = useState([]);
  const [viewingWalletCustomer, setViewingWalletCustomer] = useState(null);
  const [items, setItems] = useState([{ name: 'Items Unit', price: '500', quantity: '1' }]);
  const [customerId, setCustomerId] = useState('');
  const [captureMethod, setCaptureMethod] = useState('AUTOMATIC');
  const [createdLink, setCreatedLink] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedIntent, setSelectedIntent] = useState(null); // details popup
  const [refundingIntentId, setRefundingIntentId] = useState(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [payoutAmount, setPayoutAmount] = useState('');
  const [showPayoutModal, setShowPayoutModal] = useState(false);

  const [apiKeys, setApiKeys] = useState([]);
  const [newKeyMode, setNewKeyMode] = useState('TEST');
  const [newKeyType, setNewKeyType] = useState('secret');
  const [generatedKeyText, setGeneratedKeyText] = useState('');
  const [showKeyModal, setShowKeyModal] = useState(false);

  const totalRupees = useMemo(() => {
    return items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
  }, [items]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const mProfile = await api({ state, path: '/merchants/me', token: state.dashboardJwt });
      const mBalance = await api({ state, path: '/merchants/balance', token: state.dashboardJwt });
      const mIntents = await api({ state, path: '/merchants/payment-intents', token: state.dashboardJwt });
      const mTxns = await api({ state, path: '/merchants/transactions', token: state.dashboardJwt });
      const mDisputes = await api({ state, path: '/merchants/disputes', token: state.dashboardJwt }).catch(() => ({ disputes: [] }));
      const mKeys = await api({ state, path: '/api-keys', token: state.dashboardJwt }).catch(() => ({ data: [] }));
      const mWallets = await api({ state, path: '/merchants/wallets', token: state.dashboardJwt }).catch(() => ({ wallets: [] }));

      setMerchant(mProfile.merchant);
      setBalance(mBalance.balance);
      setIntents(mIntents.intents);
      setTransactions(mTxns.transactions);
      setDisputes(mDisputes.disputes);
      setApiKeys(mKeys.data || []);
      setWallets(mWallets.wallets || []);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreatePaymentLink = async (e) => {
    e.preventDefault();
    if (items.some(it => !it.name || Number(it.price) <= 0 || Number(it.quantity) <= 0)) {
      alert('Please fill out all item names, prices, and quantities correctly.');
      return;
    }

    try {
      const intentAmount = Math.round(totalRupees * 100); // rupees to paise
      const data = await api({
        state,
        path: '/merchants/payment-intents',
        method: 'POST',
        token: state.dashboardJwt,
        body: {
          amount: intentAmount,
          currency: 'INR',
          customerId: customerId || undefined,
          captureMethod,
          metadata: { line_items: items },
        },
      });

      const host = window.location.origin;
      const checkoutUrl = `${host}/?intentId=${data.paymentIntent.id}&clientSecret=${data.clientSecret}`;
      setCreatedLink(checkoutUrl);
      fetchData();
    } catch (err) {
      alert(`Failed to create payment intent: ${err.message}`);
    }
  };

  const handleAddItem = () => {
    setItems((curr) => [...curr, { name: '', price: '0', quantity: '1' }]);
  };

  const handleRemoveItem = (index) => {
    setItems((curr) => curr.filter((_, idx) => idx !== index));
  };

  const updateItemField = (index, field, value) => {
    setItems((curr) =>
      curr.map((it, idx) => (idx === index ? { ...it, [field]: value } : it))
    );
  };

  const handleSettle = async () => {
    if (balance.pending <= 0) {
      alert('No pending funds to settle.');
      return;
    }
    try {
      await api({
        state,
        path: '/merchants/settle',
        method: 'POST',
        token: state.dashboardJwt,
      });
      alert('Settlement processed successfully! Pending funds transferred to Available balance.');
      fetchData();
    } catch (err) {
      alert(`Settlement failed: ${err.message}`);
    }
  };

  const handlePayoutSubmit = async (e) => {
    e.preventDefault();
    const amountInPaise = Math.round(Number(payoutAmount) * 100);
    if (amountInPaise <= 0 || amountInPaise > balance.available) {
      alert('Invalid payout amount or insufficient available balance.');
      return;
    }
    try {
      await api({
        state,
        path: '/merchants/payout',
        method: 'POST',
        token: state.dashboardJwt,
        body: { amount: amountInPaise },
      });
      alert(`Successfully withdrew ${formatCurrency(amountInPaise)} to your bank account!`);
      setPayoutAmount('');
      setShowPayoutModal(false);
      fetchData();
    } catch (err) {
      alert(`Payout failed: ${err.message}`);
    }
  };

  const handleRefundSubmit = async (e) => {
    e.preventDefault();
    const amountInPaise = refundAmount ? Math.round(Number(refundAmount) * 100) : undefined;
    try {
      await api({
        state,
        path: `/merchants/payment-intents/${refundingIntentId}/refund`,
        method: 'POST',
        token: state.dashboardJwt,
        body: { amount: amountInPaise, reason: 'Dashboard user request' },
      });
      alert('Refund processed successfully!');
      setRefundingIntentId(null);
      setRefundAmount('');
      fetchData();
    } catch (err) {
      alert(`Refund failed: ${err.message}`);
    }
  };

  const handleSimulateDispute = async (intentId) => {
    if (!confirm('Are you sure you want to simulate a credit cardholder dispute/chargeback? This will hold the full payment amount from your Available balance.')) {
      return;
    }
    try {
      await api({
        state,
        path: `/merchants/payment-intents/${intentId}/dispute`,
        method: 'POST',
        token: state.dashboardJwt,
      });
      alert('Dispute simulation opened! Funds placed in dispute hold.');
      fetchData();
    } catch (err) {
      alert(`Dispute simulation failed: ${err.message}`);
    }
  };

  const handleResolveDispute = async (disputeId, status) => {
    try {
      await api({
        state,
        path: `/merchants/disputes/${disputeId}/resolve`,
        method: 'POST',
        token: state.dashboardJwt,
        body: { status },
      });
      alert(`Dispute resolved as ${status}!`);
      fetchData();
    } catch (err) {
      alert(`Resolution failed: ${err.message}`);
    }
  };

  const handleCreateKeySubmit = async (e) => {
    e.preventDefault();
    try {
      const isSecret = newKeyType === 'secret';
      const scopes = isSecret
        ? ['payments:write', 'payments:read', 'refunds:write', 'customers:write', 'customers:read']
        : ['tokenize'];

      const data = await api({
        state,
        path: '/api-keys',
        method: 'POST',
        token: state.dashboardJwt,
        body: {
          mode: newKeyMode,
          isSecret,
          scopes,
        },
      });

      setGeneratedKeyText(data.secret);
      fetchData();
    } catch (err) {
      alert(`Key generation failed: ${err.message}`);
    }
  };

  const handleUseKey = (keyText, isSecret) => {
    if (isSecret) {
      updateState({ secretKey: keyText });
      alert('Secret API key updated locally for creating Payment Links!');
    } else {
      updateState({ publicKey: keyText });
      alert('Public API key updated locally for checkout scripts!');
    }
    setGeneratedKeyText('');
    setShowKeyModal(false);
  };

  const handleRevokeKey = async (keyId) => {
    if (!confirm('Are you sure you want to revoke this API key? Services using it will fail to authenticate.')) {
      return;
    }
    try {
      await api({
        state,
        path: `/api-keys/${keyId}`,
        method: 'DELETE',
        token: state.dashboardJwt,
      });
      alert('API Key revoked.');
      fetchData();
    } catch (err) {
      alert(`Revocation failed: ${err.message}`);
    }
  };

  const handleExportCSV = () => {
    if (transactions.length === 0) {
      alert('No transactions to export.');
      return;
    }
    const headers = 'Transaction ID,Type,Amount (INR),Gateway,Gateway Ref,Status,Occurred At\n';
    const rows = transactions.map((t) => {
      const amt = (t.amount / 100).toFixed(2);
      const date = new Date(t.occurredAt).toISOString();
      return `"${t.id}","${t.type}",${amt},"${t.gateway}","${t.gatewayTxnId || 'N/A'}","${t.status}","${date}"`;
    }).join('\n');

    const csvContent = 'data:text/csv;charset=utf-8,' + encodeURIComponent(headers + rows);
    const link = document.createElement('a');
    link.setAttribute('href', csvContent);
    link.setAttribute('download', `merchant_transactions_report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleViewWalletTransactions = async (customer) => {
    setViewingWalletCustomer(customer);
    setSelectedWalletTransactions([]);
    try {
      const data = await api({
        state,
        path: `/merchants/customers/${customer.id}/wallet-transactions`,
        token: state.dashboardJwt,
      });
      setSelectedWalletTransactions(data.transactions || []);
    } catch (err) {
      alert(`Failed to fetch wallet transactions: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0' }}>
        <h2>Loading Merchant Dashboard...</h2>
      </div>
    );
  }

  return (
    <div className="merchant-dashboard" style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
      <header style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p className="eyebrow">Storefront Overview</p>
          <h1>{merchant?.name || 'My Store'}</h1>
          <p style={{ color: '#64748b', margin: '4px 0 0' }}>
            Legal Entity: {merchant?.legalName} | GSTIN: {merchant?.gst || 'N/A'} | Status:{' '}
            <span style={{ fontWeight: 800, color: merchant?.status === 'APPROVED' ? '#16a34a' : '#ea580c' }}>
              {merchant?.status}
            </span>
          </p>
        </div>
        <button className="ghost" style={{ background: '#fff1f2', borderColor: '#ffe4e6', color: '#be123c' }} onClick={handleLogout}>
          Sign Out
        </button>
      </header>

      {/* Metrics Grid */}
      <section className="dashboard-grid" style={{ marginBottom: '20px' }}>
        <div className="stat-card accent">
          <span>Available Balance</span>
          <strong>{formatCurrency(balance.available)}</strong>
        </div>
        <div className="stat-card">
          <span>Settling / Pending</span>
          <strong>{formatCurrency(balance.pending)}</strong>
        </div>
        <div className="stat-card">
          <span>Total Payments</span>
          <strong>{intents.length}</strong>
        </div>
        <div className="stat-card">
          <span>Total Settlements</span>
          <strong>{transactions.filter((t) => t.type === 'CAPTURE').length}</strong>
        </div>
      </section>

      {/* Ledger Actions */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '28px' }}>
        <button className="action" onClick={handleSettle} disabled={balance.pending <= 0} style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', boxShadow: '0 10px 20px -5px rgba(16, 185, 129, 0.2)' }}>
          Settle Ledger (Clear Pending)
        </button>
        <button className="action secondary" onClick={() => setShowPayoutModal(true)} disabled={balance.available <= 0} style={{ background: '#edf4ff', color: '#1d4ed8', border: '1px solid #cfe0ff' }}>
          Request Bank Payout
        </button>
      </div>

      <div className="content">
        {/* Payments Log Panel */}
        <section className="panel main-panel">
          <div className="table-header" style={{ marginBottom: '16px' }}>
            <h3 style={{ margin: 0 }}>Payments Log</h3>
            <button className="ghost" onClick={fetchData}>
              Refresh
            </button>
          </div>
          <div className="table-container" style={{ margin: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Intent ID</th>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {intents.map((intent) => (
                  <tr key={intent.id}>
                    <td style={{ fontFamily: 'monospace' }}>{intent.id.slice(0, 8)}...</td>
                    <td>{intent.customer?.name || 'Anonymous'}</td>
                    <td>{formatCurrency(intent.amount, intent.currency)}</td>
                    <td>
                      <span className={`status-badge ${intent.status.toLowerCase()}`}>
                        {intent.status}
                      </span>
                    </td>
                    <td>{new Date(intent.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button className="ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setSelectedIntent(intent)}>
                          View
                        </button>
                        {intent.status === 'SUCCEEDED' && (
                          <>
                            <button
                              className="ghost"
                              style={{ padding: '4px 10px', fontSize: '11px', color: '#1d4ed8', borderColor: '#cfe0ff', background: '#edf4ff' }}
                              onClick={() => {
                                setRefundingIntentId(intent.id);
                                setRefundAmount((intent.amount / 100).toString());
                              }}
                            >
                              Refund
                            </button>
                            <button
                              className="ghost"
                              style={{ padding: '4px 10px', fontSize: '11px', color: '#be123c', borderColor: '#ffe4e6', background: '#fff1f2' }}
                              onClick={() => handleSimulateDispute(intent.id)}
                            >
                              Dispute
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {intents.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                      No payments found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Payments Sidebar List + API Credentials Card */}
        <div style={{ display: 'grid', gap: '18px', alignContent: 'start' }}>
          <div className="panel response-panel" style={{ position: 'static', padding: '20px', width: '100%' }}>
            <h3>Recent Transactions</h3>
            <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>
              {intents.slice(0, 5).map((intent) => (
                <div
                  key={intent.id}
                  style={{
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: '12px',
                    padding: '12px',
                    fontSize: '12px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800 }}>
                    <span>{formatCurrency(intent.amount, intent.currency)}</span>
                    <span className={`status-badge ${intent.status.toLowerCase()}`}>
                      {intent.status}
                    </span>
                  </div>
                  <div style={{ color: '#64748b', marginTop: '6px', fontSize: '11px' }}>
                    ID: {intent.id.slice(0, 8)}... | {new Date(intent.createdAt).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Main Lists Section */}
      <section style={{ marginTop: '30px' }}>
        {/* Disputes Log Section */}
        <div className="table-container" style={{ marginTop: '28px' }}>
          <div className="table-header">
            <h3>Disputes & Chargebacks (Simulated)</h3>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Dispute ID</th>
                <th>Payment Ref</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {disputes.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontFamily: 'monospace' }}>{d.id.slice(0, 13)}...</td>
                  <td style={{ fontFamily: 'monospace' }}>{d.transaction?.paymentIntentId?.slice(0, 13)}...</td>
                  <td>{d.transaction?.paymentIntent?.customer?.name || 'Anonymous'}</td>
                  <td>{formatCurrency(d.amount, d.transaction?.paymentIntent?.currency)}</td>
                  <td>
                    <span className={`status-badge ${d.status.toLowerCase()}`}>
                      {d.status}
                    </span>
                  </td>
                  <td>
                    {d.status === 'NEEDS_RESPONSE' && (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          className="ghost"
                          style={{ padding: '4px 10px', fontSize: '11px', color: '#16a34a', borderColor: '#bbf7d0', background: '#f0fdf4' }}
                          onClick={() => handleResolveDispute(d.id, 'WON')}
                        >
                          Resolve Win
                        </button>
                        <button
                          className="ghost"
                          style={{ padding: '4px 10px', fontSize: '11px', color: '#b91c1c', borderColor: '#fecaca', background: '#fef2f2' }}
                          onClick={() => handleResolveDispute(d.id, 'LOST')}
                        >
                          Resolve Loss
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {disputes.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                    No disputes on file. Use the "Dispute" button on a payment row to simulate one!
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="table-container" style={{ marginTop: '28px' }}>
          <div className="table-header">
            <h3>Transactions Audit Log (Double-Entry Ledger)</h3>
            <button className="ghost" onClick={handleExportCSV}>Export CSV Report</button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Transaction ID</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Gateway</th>
                <th>Gateway Txn ID</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((txn) => (
                <tr key={txn.id}>
                  <td style={{ fontFamily: 'monospace' }}>{txn.id.slice(0, 13)}...</td>
                  <td style={{ fontWeight: 800 }}>{txn.type}</td>
                  <td>{formatCurrency(txn.amount, txn.paymentIntent?.currency)}</td>
                  <td>{txn.gateway}</td>
                  <td style={{ fontFamily: 'monospace' }}>{txn.gatewayTxnId || 'N/A'}</td>
                  <td>
                    <span className={`status-badge ${txn.status.toLowerCase()}`}>
                      {txn.status}
                    </span>
                  </td>
                  <td>{new Date(txn.occurredAt).toLocaleString()}</td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                    No transaction entries in double-entry ledger yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Customer Wallets & Ledger Logs */}
        <div className="table-container" style={{ marginTop: '28px' }}>
          <div className="table-header">
            <h3>Customer Wallets & Ledger Logs</h3>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer Name</th>
                <th>Email Address</th>
                <th>Customer UUID</th>
                <th>Current Balance</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => (
                <tr key={w.id}>
                  <td style={{ fontWeight: 800 }}>{w.name}</td>
                  <td>{w.email}</td>
                  <td style={{ fontFamily: 'monospace' }}>{w.id}</td>
                  <td>{formatCurrency(w.balance)}</td>
                  <td>
                    <button
                      className="ghost"
                      style={{ padding: '4px 10px', fontSize: '11px', color: '#0f766e', borderColor: '#99f6e4', background: '#f0fdfa' }}
                      onClick={() => handleViewWalletTransactions(w)}
                    >
                      View Wallet Transactions
                    </button>
                  </td>
                </tr>
              ))}
              {wallets.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                    No customer records found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Payout Dialog Modal */}
      {showPayoutModal && (
        <div className="modal-overlay" onClick={() => setShowPayoutModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px' }}>Withdraw available balance to bank</h3>
            <form onSubmit={handlePayoutSubmit}>
              <Input
                label="Amount to Withdraw (₹)"
                type="number"
                value={payoutAmount}
                onChange={setPayoutAmount}
                placeholder="e.g. 500"
              />
              <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                <button className="action" type="submit">Confirm Payout</button>
                <button className="action secondary" type="button" onClick={() => setShowPayoutModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Refund Dialog Modal */}
      {refundingIntentId && (
        <div className="modal-overlay" onClick={() => setRefundingIntentId(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px' }}>Process Refund</h3>
            <form onSubmit={handleRefundSubmit}>
              <Input
                label="Refund Amount (₹)"
                type="number"
                value={refundAmount}
                onChange={setRefundAmount}
                placeholder="e.g. 100"
              />
              <p style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
                Leave as default or enter a partial amount. Max refundable is the remaining capture amount.
              </p>
              <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                <button className="action danger" type="submit">Submit Refund</button>
                <button className="action secondary" type="button" onClick={() => setRefundingIntentId(null)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* API Key Manager Modal */}
      {showKeyModal && (
        <div className="modal-overlay" onClick={() => { setShowKeyModal(false); setGeneratedKeyText(''); }}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Manage Merchant API Keys</h2>
              <button className="ghost" type="button" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={() => { setShowKeyModal(false); setGeneratedKeyText(''); }}>Close</button>
            </div>

            {generatedKeyText ? (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '16px', padding: '16px', marginBottom: '20px', textAlign: 'left' }}>
                <strong style={{ color: '#16a34a', display: 'block', marginBottom: '8px' }}>✓ Key Generated Successfully!</strong>
                <p style={{ fontSize: '12px', color: '#15803d', margin: '0 0 10px 0' }}>
                  Please copy this key now. It will not be shown again for security reasons.
                </p>
                <input readOnly className="share-input" value={generatedKeyText} style={{ width: '100%', marginBottom: '12px' }} />
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button className="action" type="button" style={{ background: '#16a34a' }} onClick={() => handleUseKey(generatedKeyText, newKeyType === 'secret')}>
                    Assign and Use Locally
                  </button>
                  <button className="action secondary" type="button" onClick={() => { setGeneratedKeyText(''); }}>
                    Dismiss
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateKeySubmit} style={{ borderBottom: '1px solid #cbd5e1', paddingBottom: '20px', marginBottom: '20px', textAlign: 'left' }}>
                <span style={{ fontSize: '13px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '10px' }}>Generate New API Key</span>
                <div className="row">
                  <Select
                    label="Mode"
                    value={newKeyMode}
                    onChange={setNewKeyMode}
                    options={['TEST', 'LIVE']}
                  />
                  <Select
                    label="Key Type"
                    value={newKeyType}
                    onChange={setNewKeyType}
                    options={['secret', 'public']}
                  />
                </div>
                <button className="action" type="submit" style={{ marginTop: '10px' }}>
                  Generate Key
                </button>
              </form>
            )}

            <div style={{ textAlign: 'left' }}>
              <span style={{ fontSize: '13px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '10px' }}>Active API Keys List</span>
              <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '12px' }}>
                <table className="data-table" style={{ fontSize: '12px' }}>
                  <thead>
                    <tr>
                      <th>Key ID Prefix</th>
                      <th>Mode</th>
                      <th>Type</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiKeys.map((key) => (
                      <tr key={key.id}>
                        <td style={{ fontFamily: 'monospace' }}>{key.keyId}</td>
                        <td>
                          <span className={`status-badge ${key.mode === 'LIVE' ? 'succeeded' : 'processing'}`}>
                            {key.mode}
                          </span>
                        </td>
                        <td>{key.scopes.includes('tokenize') ? 'Public' : 'Secret'}</td>
                        <td>
                          {!key.revokedAt ? (
                            <button
                              type="button"
                              className="ghost"
                              style={{ color: '#be123c', borderColor: '#ffe4e6', background: '#fff1f2', padding: '2px 8px', fontSize: '11px' }}
                              onClick={() => handleRevokeKey(key.id)}
                            >
                              Revoke
                            </button>
                          ) : (
                            <span style={{ color: '#64748b' }}>Revoked</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {apiKeys.length === 0 && (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: '12px', color: '#64748b' }}>No active keys found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedIntent && <InvoiceDetailsModal intent={selectedIntent} onClose={() => setSelectedIntent(null)} />}

      {/* Customer Wallet Audit Modal */}
      {viewingWalletCustomer && (
        <div className="modal-overlay" onClick={() => setViewingWalletCustomer(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '720px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Wallet Transactions Audit: {viewingWalletCustomer.name}</h2>
              <button className="ghost" type="button" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={() => setViewingWalletCustomer(null)}>Close</button>
            </div>

            <p style={{ color: '#64748b', fontSize: '13px', marginBottom: '14px' }}>
              Showing ledger transaction entries stored in Redis for Customer UUID: <code style={{ background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace' }}>{viewingWalletCustomer.id}</code>
            </p>

            <div style={{ maxHeight: '360px', overflowY: 'auto', border: '1px solid #cbd5e1', borderRadius: '16px' }}>
              <table className="data-table" style={{ fontSize: '12px' }}>
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
                  {selectedWalletTransactions.map((t) => (
                    <tr key={t.id}>
                      <td style={{ fontFamily: 'monospace' }}>{t.id}</td>
                      <td>
                        <span style={{ fontWeight: 800, color: t.type === 'TOPUP' ? '#0d9488' : '#be123c' }}>
                          {t.type}
                        </span>
                      </td>
                      <td>{formatCurrency(t.amount)}</td>
                      <td>
                        <span className="status-badge succeeded">
                          {t.status}
                        </span>
                      </td>
                      <td style={{ fontFamily: 'monospace' }}>{t.ref}</td>
                      <td>{new Date(t.date).toLocaleString()}</td>
                    </tr>
                  ))}
                  {selectedWalletTransactions.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', padding: '16px', color: '#64748b' }}>No wallet activity logged for this customer.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CUSTOMER CHECKOUT VIEW (RAZORPAY INTEGRATION) ──────────────────
function CustomerCheckout({ intentId, clientSecret, state, setView }) {
  const [intent, setIntent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [successDetails, setSuccessDetails] = useState(null);

  // Dummy Gateway States
  const [showDummyGateway, setShowDummyGateway] = useState(false);
  const [dummyGatewayMethod, setDummyGatewayMethod] = useState('card');
  const [dummyGatewayOutcome, setDummyGatewayOutcome] = useState('SUCCESS');
  const [dummyCardNumber, setDummyCardNumber] = useState('4111 1111 1111 1111');
  const [dummyUpiVpa, setDummyUpiVpa] = useState('test@upi');
  const [dummyBank, setDummyBank] = useState('HDFC Bank');
  const [dummyWallet, setDummyWallet] = useState('Paytm Wallet');
  const [checkoutFailureMessage, setCheckoutFailureMessage] = useState('');

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
    } catch (err) {
      setError(err.message || 'Failed to load checkout details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIntentDetails();
  }, [intentId]);

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
            alert(`Payment confirmation failed: ${err.message}`);
          } finally {
            setPaying(false);
          }
        },
        prefill: {
          name: 'Jane Doe',
          email: 'customer@example.com',
          contact: '9876543210',
        },
        theme: {
          color: '#2563eb',
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function (resp) {
        alert(`Payment failed: ${resp.error.description}`);
      });
      rzp.open();
    } catch (err) {
      alert(`Razorpay launch error: ${err.message}`);
    } finally {
      setPaying(false);
    }
  };

  const handleDummyPay = () => {
    setShowDummyGateway(true);
  };

  const executeDummyPayment = async (selectedMethod, selectedOutcome) => {
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
      alert(`Dummy Payment confirmation failed: ${err.message}`);
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
        <div className="modal-overlay" style={{ zIndex: 9999 }} onClick={() => setShowDummyGateway(false)}>
          <div className="modal-card" style={{ maxWidth: '520px', padding: '28px', borderRadius: '24px', border: '1px solid #e2e8f0', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '24px' }}>🛡️</span>
                <div style={{ textAlign: 'left' }}>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800 }}>Secure Sandbox Gateway</h3>
                  <span style={{ fontSize: '11px', color: '#64748b' }}>Simulated Payment Processor</span>
                </div>
              </div>
              <button className="ghost" type="button" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={() => setShowDummyGateway(false)}>Close</button>
            </div>

            {/* Merchant / Amount Info Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', background: '#f8fafc', padding: '14px', borderRadius: '16px', border: '1px solid #cbd5e1', marginBottom: '20px', fontSize: '13px' }}>
              <div style={{ textAlign: 'left' }}>
                <span style={{ color: '#64748b', display: 'block', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase' }}>Paying Merchant</span>
                <strong style={{ display: 'block', marginTop: '3px' }}>{intent.merchantName}</strong>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ color: '#64748b', display: 'block', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase' }}>Amount Due</span>
                <strong style={{ color: '#2563eb', display: 'block', marginTop: '3px', fontSize: '16px' }}>{formatCurrency(intent.amount, intent.currency)}</strong>
              </div>
            </div>

            {/* Step 1: Select Payment Method */}
            <div style={{ textAlign: 'left', marginBottom: '20px' }}>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Choose Payment Method</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                {[
                  { id: 'card', label: 'Card', icon: '💳' },
                  { id: 'upi', label: 'UPI', icon: '📱' },
                  { id: 'netbanking', label: 'Bank', icon: '🏦' },
                  { id: 'wallet', label: 'Wallet', icon: '👛' },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setDummyGatewayMethod(m.id)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '12px 8px',
                      borderRadius: '16px',
                      border: '2px solid',
                      borderColor: dummyGatewayMethod === m.id ? '#2563eb' : '#cbd5e1',
                      background: dummyGatewayMethod === m.id ? '#edf4ff' : 'white',
                      color: dummyGatewayMethod === m.id ? '#1e40af' : '#1e293b',
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

            {/* Step 2: Payment Details Entry Mockup */}
            <div style={{ textAlign: 'left', background: '#f8fafc', padding: '16px', borderRadius: '16px', border: '1px solid #cbd5e1', marginBottom: '20px' }}>
              {dummyGatewayMethod === 'card' && (
                <div style={{ display: 'grid', gap: '10px' }}>
                  <Input label="Mock Card Number" value={dummyCardNumber} onChange={setDummyCardNumber} placeholder="4111 1111 1111 1111" />
                  <div className="row" style={{ display: 'flex', gap: '8px' }}>
                    <div style={{ flex: 1 }}><Input label="Expiry Date" placeholder="MM/YY" value="12/30" onChange={() => {}} /></div>
                    <div style={{ flex: 1 }}><Input label="CVV" type="password" placeholder="123" value="123" onChange={() => {}} /></div>
                  </div>
                </div>
              )}
              {dummyGatewayMethod === 'upi' && (
                <div>
                  <Input label="Mock UPI VPA Address" value={dummyUpiVpa} onChange={setDummyUpiVpa} placeholder="e.g. user@gpay" />
                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                    {['test@upi', 'customer@okaxis', 'pay@ybl'].map((vpa) => (
                      <button
                        key={vpa}
                        type="button"
                        className="ghost"
                        style={{ padding: '4px 8px', borderRadius: '8px', fontSize: '10px' }}
                        onClick={() => setDummyUpiVpa(vpa)}
                      >
                        {vpa}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {dummyGatewayMethod === 'netbanking' && (
                <div>
                  <Select
                    label="Mock Bank Institution"
                    value={dummyBank}
                    onChange={setDummyBank}
                    options={['HDFC Bank', 'State Bank of India', 'ICICI Bank', 'Axis Bank', 'Kotak Bank']}
                  />
                </div>
              )}
              {dummyGatewayMethod === 'wallet' && (
                <div>
                  <Select
                    label="Mock Wallet Service"
                    value={dummyWallet}
                    onChange={setDummyWallet}
                    options={['Paytm Wallet', 'PhonePe Wallet', 'Amazon Pay', 'Mobikwik']}
                  />
                </div>
              )}
            </div>

            {/* Step 3: Choose Transaction Outcome */}
            <div style={{ textAlign: 'left', marginBottom: '24px' }}>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Simulate Gateway Outcome</span>
              <div style={{ display: 'grid', gap: '10px' }}>
                {[
                  {
                    id: 'SUCCESS',
                    title: '🟢 SUCCESS',
                    desc: 'Debits customer, credits merchant balance, registers SUCCESS status.',
                  },
                  {
                    id: 'FAILURE_DECLINED',
                    title: '🔴 FAILURE (Card Declined)',
                    desc: 'Simulates direct rejection. No funds are cut, registers FAILED status.',
                  },
                  {
                    id: 'FAILURE_REVERTED',
                    title: '⚠️ FAILURE (Money Cut & Reverted)',
                    desc: 'Funds are debited, but transaction timeout triggers auto-reversal/refund.',
                  },
                ].map((out) => (
                  <label
                    key={out.id}
                    style={{
                      display: 'flex',
                      gap: '12px',
                      alignItems: 'start',
                      padding: '12px',
                      borderRadius: '16px',
                      border: '2px solid',
                      borderColor: dummyGatewayOutcome === out.id ? '#2563eb' : '#cbd5e1',
                      background: dummyGatewayOutcome === out.id ? '#edf4ff' : 'white',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <input
                      type="radio"
                      name="gateway_outcome"
                      value={out.id}
                      checked={dummyGatewayOutcome === out.id}
                      onChange={() => setDummyGatewayOutcome(out.id)}
                      style={{ marginTop: '3px' }}
                    />
                    <div style={{ fontSize: '12px' }}>
                      <strong style={{ display: 'block', color: dummyGatewayOutcome === out.id ? '#1e40af' : '#1e293b', fontWeight: 'bold' }}>{out.title}</strong>
                      <span style={{ color: '#64748b', fontSize: '11px', display: 'block', marginTop: '2px', lineHeight: '1.3' }}>{out.desc}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Proceed Actions */}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                className="action"
                style={{ flex: 1, height: '48px', fontSize: '14px', background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)' }}
                onClick={() => executeDummyPayment(dummyGatewayMethod, dummyGatewayOutcome)}
                disabled={paying}
              >
                {paying ? 'Processing Simulated Payment...' : 'Confirm Simulated Payment'}
              </button>
              <button
                className="action secondary"
                style={{ height: '48px' }}
                onClick={() => setShowDummyGateway(false)}
                disabled={paying}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── INVOICE DETAILS MODAL (POPUP RECEIPT OVERLAY) ──────────────────
function InvoiceDetailsModal({ intent, onClose }) {
  const lineItems = intent.metadata?.line_items || [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Invoice Details</h2>
          <button className="ghost" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={onClose}>Close</button>
        </div>

        <div className="receipt-grid" style={{ marginBottom: '16px', background: '#f8fafc' }}>
          <div className="receipt-row">
            <span>Invoice UUID</span>
            <strong>{intent.id}</strong>
          </div>
          <div className="receipt-row">
            <span>Customer Details</span>
            <strong>{intent.customer?.name || 'Anonymous'} ({intent.customer?.email || 'Guest'})</strong>
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
          <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', borderBottom: '1px solid #cbd5e1', paddingBottom: '6px', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Line Items Breakdown</span>
          {lineItems.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #cbd5e1', color: '#475569', height: '28px', textAlign: 'left' }}>
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
                    <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{formatCurrency(Number(item.price || 0) * Number(item.quantity || 1) * 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: '#64748b', fontSize: '13px', padding: '10px 0' }}>Flat invoice with no itemized breakdown.</div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#e2e8f0', padding: '16px', borderRadius: '16px', border: '1px solid #cbd5e1' }}>
          <span style={{ fontSize: '13px', color: '#475569', fontWeight: 'bold' }}>Total Settled:</span>
          <strong style={{ fontSize: '20px', color: '#0f172a' }}>{formatCurrency(intent.amount, intent.currency)}</strong>
        </div>
      </div>
    </div>
  );
}

// Helper Components
function Input({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

createRoot(document.getElementById('root')).render(<App />);
