import { useState } from 'react';
import { Input } from '../components/Input';
import type { AppForms, AppState, AppView, ApiFn } from '../types';
import { errMsg } from '../types';

interface AuthPortalProps {
  state: AppState;
  forms: AppForms;
  updateForm: <K extends keyof AppForms>(group: K, field: keyof AppForms[K], value: string) => void;
  updateState: (patch: Partial<AppState>) => void;
  setView: (view: AppView) => void;
  api: ApiFn;
}

export function AuthPortal({ state, forms, updateForm, updateState, setView, api }: AuthPortalProps) {
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
      setError(errMsg(err) || 'Registration failed.');
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
      setError(errMsg(err) || 'Login failed.');
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
      setError(errMsg(err) || 'TOTP code verification failed.');
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
      setError(errMsg(err) || 'Customer email lookup failed.');
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
      setError(errMsg(err) || 'Customer registration failed.');
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
