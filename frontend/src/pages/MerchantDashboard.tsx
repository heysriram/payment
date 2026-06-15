import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Input } from '../components/Input';
import { Select } from '../components/Select';
import { InvoiceDetailsModal } from '../components/InvoiceDetailsModal';
import { formatCurrency } from '../lib/format';
import { WebhooksPanel } from './merchant/WebhooksPanel';
import { EventsPanel } from './merchant/EventsPanel';
import type {
  ApiFn,
  ApiKey,
  AppState,
  CustomerSearchResult,
  Dispute,
  LineItem,
  MerchantBalance,
  MerchantCustomer,
  MerchantProfile,
  PaymentIntent,
  PaymentMethod,
  Transaction,
  WalletTransaction,
} from '../types';
import { errMsg } from '../types';

interface MerchantDashboardProps {
  state: AppState;
  api: ApiFn;
  handleLogout: () => void;
  updateState: (patch: Partial<AppState>) => void;
}

type DashboardTab = 'overview' | 'customers' | 'webhooks' | 'events';
type CustomerModalTab = 'create' | 'import';

interface CustomerDetail extends MerchantCustomer {
  walletBalance: number;
  isOwnCustomer: boolean;
  paymentMethods: PaymentMethod[];
  paymentIntents: PaymentIntent[];
}

export function MerchantDashboard({ state, api, handleLogout, updateState }: MerchantDashboardProps) {
  const [merchant, setMerchant] = useState(null);
  const [balance, setBalance] = useState({ available: 0, pending: 0 });
  const [intents, setIntents] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerSort, setCustomerSort] = useState('totalSpent');
  const [selectedWalletTransactions, setSelectedWalletTransactions] = useState([]);
  const [viewingWalletCustomer, setViewingWalletCustomer] = useState(null);
  const [items, setItems] = useState([{ name: 'Items Unit', price: '500', quantity: '1' }]);
  const [customerId, setCustomerId] = useState('');
  const [captureMethod, setCaptureMethod] = useState('AUTOMATIC');
  const [createdLink, setCreatedLink] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedIntent, setSelectedIntent] = useState(null);
  const [refundingIntentId, setRefundingIntentId] = useState(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [payoutAmount, setPayoutAmount] = useState('');
  const [showPayoutModal, setShowPayoutModal] = useState(false);

  const [apiKeys, setApiKeys] = useState([]);
  const [newKeyMode, setNewKeyMode] = useState('TEST');
  const [newKeyType, setNewKeyType] = useState('secret');
  const [generatedKeyText, setGeneratedKeyText] = useState('');
  const [showKeyModal, setShowKeyModal] = useState(false);

  const [activeTab, setActiveTab] = useState('overview');
  const [intentActionLoading, setIntentActionLoading] = useState(null);

  const [showCreateCustomerModal, setShowCreateCustomerModal] = useState(false);
  const [customerModalTab, setCustomerModalTab] = useState('create');
  const [newCustomerForm, setNewCustomerForm] = useState({ name: '', email: '', phone: '' });
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [importSearchQuery, setImportSearchQuery] = useState('');
  const [importCandidates, setImportCandidates] = useState([]);
  const [importSearching, setImportSearching] = useState(false);
  const [importingId, setImportingId] = useState(null);
  const [viewingCustomerDetailId, setViewingCustomerDetailId] = useState(null);
  const [customerDetail, setCustomerDetail] = useState(null);
  const [customerDetailLoading, setCustomerDetailLoading] = useState(false);

  const [claimingCustomerId, setClaimingCustomerId] = useState(null);

  const [showCreateInvoice, setShowCreateInvoice] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [allDbCustomers, setAllDbCustomers] = useState([]);
  const [loadingAllCustomers, setLoadingAllCustomers] = useState(false);

  const [systemHealth, setSystemHealth] = useState({ status: 'unknown', ready: false });

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
      const mCustomers = await api({ state, path: '/merchants/customers', token: state.dashboardJwt }).catch(() => ({ customers: [] }));

      setMerchant(mProfile.merchant);
      setBalance(mBalance.balance);
      setIntents(mIntents.intents);
      setTransactions(mTxns.transactions);
      setDisputes(mDisputes.disputes);
      setApiKeys(mKeys.data || []);
      setCustomers(mCustomers.customers || []);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lightweight liveness/readiness pinger. Poll every 30s; the server's
  // /api/health and /api/ready endpoints are very cheap and don't require
  // auth. Vite proxies /api/* to the backend in dev; in prod we expect the
  // dashboard to be served from the same origin as the API.
  useEffect(() => {
    let cancelled = false;

    const ping = async () => {
      try {
        const [h, r] = await Promise.all([
          fetch('/api/health', { cache: 'no-store' }).then((res) => res.ok),
          fetch('/api/ready', { cache: 'no-store' }).then((res) => res.ok),
        ]);
        if (!cancelled) {
          setSystemHealth({ status: h ? 'ok' : 'down', ready: r });
        }
      } catch {
        if (!cancelled) setSystemHealth({ status: 'down', ready: false });
      }
    };

    ping();
    const id = setInterval(ping, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const handleCreatePaymentLink = async (e) => {
    e.preventDefault();
    if (items.some(it => !it.name || Number(it.price) <= 0 || Number(it.quantity) <= 0)) {
      alert('Please fill out all item names, prices, and quantities correctly.');
      return;
    }

    setCreatingInvoice(true);
    setLinkCopied(false);
    try {
      const intentAmount = Math.round(totalRupees * 100);
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
      alert(`Failed to create payment intent: ${errMsg(err)}`);
    } finally {
      setCreatingInvoice(false);
    }
  };

  const handleCopyCheckoutLink = async () => {
    try {
      await navigator.clipboard.writeText(createdLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      alert('Could not copy to clipboard. Select the link and copy manually.');
    }
  };

  const handleResetCreateInvoice = () => {
    setItems([{ name: 'Items Unit', price: '500', quantity: '1' }]);
    setCustomerId('');
    setCaptureMethod('AUTOMATIC');
    setCreatedLink('');
    setLinkCopied(false);
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
      alert(`Settlement failed: ${errMsg(err)}`);
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
      alert(`Payout failed: ${errMsg(err)}`);
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
      alert(`Refund failed: ${errMsg(err)}`);
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
      alert(`Dispute simulation failed: ${errMsg(err)}`);
    }
  };

  const handleCaptureIntent = async (intentId) => {
    if (!confirm('Capture this manually-authorised payment? Funds will move to your Pending balance.')) return;
    setIntentActionLoading(intentId);
    try {
      await api({
        state,
        path: `/merchants/payment-intents/${intentId}/capture`,
        method: 'POST',
        token: state.dashboardJwt,
      });
      alert('Payment captured.');
      fetchData();
    } catch (err) {
      alert(`Capture failed: ${errMsg(err)}`);
    } finally {
      setIntentActionLoading(null);
    }
  };

  const handleCancelIntent = async (intentId) => {
    if (!confirm('Cancel this payment intent? It will be marked as VOID and the customer will not be able to pay.')) return;
    setIntentActionLoading(intentId);
    try {
      await api({
        state,
        path: `/merchants/payment-intents/${intentId}/cancel`,
        method: 'POST',
        token: state.dashboardJwt,
      });
      alert('Payment intent cancelled.');
      fetchData();
    } catch (err) {
      alert(`Cancel failed: ${errMsg(err)}`);
    } finally {
      setIntentActionLoading(null);
    }
  };

  const handleCreateCustomerSubmit = async (e) => {
    e.preventDefault();
    if (!newCustomerForm.name && !newCustomerForm.email && !newCustomerForm.phone) {
      alert('Please provide at least a name, email, or phone.');
      return;
    }
    setCreatingCustomer(true);
    try {
      await api({
        state,
        path: '/merchants/customers',
        method: 'POST',
        token: state.dashboardJwt,
        body: {
          name: newCustomerForm.name || undefined,
          email: newCustomerForm.email || undefined,
          phone: newCustomerForm.phone || undefined,
        },
      });
      setShowCreateCustomerModal(false);
      setNewCustomerForm({ name: '', email: '', phone: '' });
      fetchData();
    } catch (err) {
      alert(`Could not create customer: ${errMsg(err)}`);
    } finally {
      setCreatingCustomer(false);
    }
  };

  const handleSearchImportCandidates = async (q) => {
    setImportSearching(true);
    try {
      const path = `/merchants/customers-search${q ? `?q=${encodeURIComponent(q)}` : ''}`;
      const resp = await api({ state, path, token: state.dashboardJwt });
      setImportCandidates(resp.data || []);
    } catch (err) {
      alert(`Search failed: ${errMsg(err)}`);
      setImportCandidates([]);
    } finally {
      setImportSearching(false);
    }
  };

  // Debounce the import search so we don't hammer the backend on every
  // keystroke. 250ms feels snappy without flooding.
  useEffect(() => {
    if (!showCreateCustomerModal || customerModalTab !== 'import') return;
    const id = setTimeout(() => handleSearchImportCandidates(importSearchQuery), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importSearchQuery, showCreateCustomerModal, customerModalTab]);

  // Load every customer in the database when the invoice form opens. The
  // dropdown groups them by relationship (Owned / Guests / Others), so the
  // merchant can invoice anyone — picking a customer not yet related to
  // them works because POST /merchants/payment-intents now accepts any
  // existing customerId.
  useEffect(() => {
    if (!showCreateInvoice) return;
    let cancelled = false;
    (async () => {
      setLoadingAllCustomers(true);
      try {
        const resp = await api({
          state,
          path: '/merchants/customers-search?include_own=true&limit=500',
          token: state.dashboardJwt,
        });
        if (!cancelled) setAllDbCustomers(resp.data || []);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load customer list for invoice form:', err);
          setAllDbCustomers([]);
        }
      } finally {
        if (!cancelled) setLoadingAllCustomers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreateInvoice]);

  const handleImportCustomer = async (sourceCustomerId, label) => {
    if (!confirm(`Import ${label || 'this customer'} into your merchant?`)) return;
    setImportingId(sourceCustomerId);
    try {
      await api({
        state,
        path: '/merchants/customers/import',
        method: 'POST',
        token: state.dashboardJwt,
        body: { sourceCustomerId },
      });
      setShowCreateCustomerModal(false);
      setImportSearchQuery('');
      setImportCandidates([]);
      fetchData();
    } catch (err) {
      alert(`Import failed: ${errMsg(err)}`);
    } finally {
      setImportingId(null);
    }
  };

  // Claim from the Customers tab — same backend operation as Import, just a
  // one-click flow against a guest row that's already visible.
  const handleClaimGuest = async (customer) => {
    const label = customer.name || customer.email || customer.id.slice(0, 8);
    if (!confirm(
      `Add "${label}" to your merchant's owned customers? This creates a fresh customer record under your merchant; their existing payment history stays intact.`
    )) {
      return;
    }
    setClaimingCustomerId(customer.id);
    try {
      await api({
        state,
        path: '/merchants/customers/import',
        method: 'POST',
        token: state.dashboardJwt,
        body: { sourceCustomerId: customer.id },
      });
      fetchData();
    } catch (err) {
      alert(`Claim failed: ${errMsg(err)}`);
    } finally {
      setClaimingCustomerId(null);
    }
  };

  const handleOpenCustomerDetail = async (customerId) => {
    setViewingCustomerDetailId(customerId);
    setCustomerDetail(null);
    setCustomerDetailLoading(true);
    try {
      const resp = await api({
        state,
        path: `/merchants/customers/${customerId}`,
        token: state.dashboardJwt,
      });
      setCustomerDetail(resp.customer);
    } catch (err) {
      alert(`Could not load customer profile: ${errMsg(err)}`);
      setViewingCustomerDetailId(null);
    } finally {
      setCustomerDetailLoading(false);
    }
  };

  const handleDownloadOpenApi = async () => {
    try {
      const resp = await fetch('/api/payments/openapi.yaml');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'openapi.yaml';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Could not download OpenAPI spec: ${errMsg(err)}`);
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
      alert(`Resolution failed: ${errMsg(err)}`);
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
        body: { mode: newKeyMode, isSecret, scopes },
      });

      setGeneratedKeyText(data.secret);
      fetchData();
    } catch (err) {
      alert(`Key generation failed: ${errMsg(err)}`);
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
      alert(`Revocation failed: ${errMsg(err)}`);
    }
  };

  const handleExportCSV = () => {
    if (transactions.length === 0) {
      alert('No transactions to export.');
      return;
    }
    const headers = 'Transaction ID,Type,Customer Name,Customer Email,Amount (INR),Gateway,Gateway Ref,Status,Occurred At\n';
    const rows = transactions.map((t) => {
      const amt = (t.amount / 100).toFixed(2);
      const date = new Date(t.occurredAt).toISOString();
      const customerName = (t.paymentIntent?.customer?.name || '').replace(/"/g, '""');
      const customerEmail = (t.paymentIntent?.customer?.email || '').replace(/"/g, '""');
      return `"${t.id}","${t.type}","${customerName}","${customerEmail}",${amt},"${t.gateway}","${t.gatewayTxnId || 'N/A'}","${t.status}","${date}"`;
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
      alert(`Failed to fetch wallet transactions: ${errMsg(err)}`);
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
      <header style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
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
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            title={
              systemHealth.status === 'ok'
                ? `API healthy${systemHealth.ready ? ' & ready' : ' (warming up — DB or Redis not ready)'}`
                : systemHealth.status === 'down'
                  ? 'API is unreachable'
                  : 'Checking API status…'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '999px',
              background:
                systemHealth.status === 'ok' && systemHealth.ready
                  ? '#f0fdf4'
                  : systemHealth.status === 'ok'
                    ? '#fef3c7'
                    : '#fef2f2',
              color:
                systemHealth.status === 'ok' && systemHealth.ready
                  ? '#16a34a'
                  : systemHealth.status === 'ok'
                    ? '#a16207'
                    : '#b91c1c',
              border: `1px solid ${
                systemHealth.status === 'ok' && systemHealth.ready
                  ? '#bbf7d0'
                  : systemHealth.status === 'ok'
                    ? '#fde68a'
                    : '#fecaca'
              }`,
              fontSize: '11px',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background:
                  systemHealth.status === 'ok' && systemHealth.ready
                    ? '#16a34a'
                    : systemHealth.status === 'ok'
                      ? '#d97706'
                      : '#dc2626',
              }}
            />
            {systemHealth.status === 'unknown'
              ? 'Checking…'
              : systemHealth.status === 'ok' && systemHealth.ready
                ? 'Operational'
                : systemHealth.status === 'ok'
                  ? 'Degraded'
                  : 'Down'}
          </span>
          <a
            href="/api/payments/docs"
            target="_blank"
            rel="noreferrer"
            className="ghost"
            style={{
              padding: '6px 12px',
              borderRadius: '10px',
              fontSize: '12px',
              fontWeight: 700,
              background: '#edf4ff',
              borderColor: '#cfe0ff',
              color: '#1d4ed8',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            API Docs
          </a>
          <button
            className="ghost"
            onClick={handleDownloadOpenApi}
            style={{ padding: '6px 12px', borderRadius: '10px', fontSize: '12px', fontWeight: 700 }}
          >
            Download OpenAPI
          </button>
          <button className="ghost" style={{ background: '#fff1f2', borderColor: '#ffe4e6', color: '#be123c' }} onClick={handleLogout}>
            Sign Out
          </button>
        </div>
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
          <span>Total Customers</span>
          <strong>{customers.length}</strong>
        </div>
        <div className="stat-card">
          <span>Total Payments</span>
          <strong>{intents.length}</strong>
        </div>
      </section>

      {/* Tab navigation */}
      <nav
        style={{
          display: 'flex',
          gap: '4px',
          borderBottom: '1px solid #cbd5e1',
          marginBottom: '24px',
          overflowX: 'auto',
        }}
      >
        {[
          { id: 'overview', label: 'Overview', desc: 'Payments, ledger, disputes' },
          { id: 'customers', label: `Customers (${customers.length})`, desc: 'Roster & wallets' },
          { id: 'webhooks', label: 'Webhooks', desc: 'Endpoints & deliveries' },
          { id: 'events', label: 'Events', desc: 'Append-only audit log' },
        ].map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              title={tab.desc}
              style={{
                background: 'transparent',
                border: 'none',
                borderBottom: active ? '3px solid #2563eb' : '3px solid transparent',
                color: active ? '#1d4ed8' : '#64748b',
                fontWeight: active ? 800 : 600,
                fontSize: '13px',
                padding: '12px 18px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                marginBottom: '-1px',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === 'overview' && (<>
      {/* Ledger Actions */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <button className="action" onClick={handleSettle} disabled={balance.pending <= 0} style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', boxShadow: '0 10px 20px -5px rgba(16, 185, 129, 0.2)' }}>
          Settle Ledger (Clear Pending)
        </button>
        <button className="action secondary" onClick={() => setShowPayoutModal(true)} disabled={balance.available <= 0} style={{ background: '#edf4ff', color: '#1d4ed8', border: '1px solid #cfe0ff' }}>
          Request Bank Payout
        </button>
        <button
          className="action secondary"
          onClick={() => setShowCreateInvoice((v) => !v)}
          style={{ background: showCreateInvoice ? '#fff' : 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', color: showCreateInvoice ? '#1d4ed8' : '#fff', border: '1px solid #cfe0ff' }}
        >
          {showCreateInvoice ? 'Hide Invoice Form' : '+ Create Payment Link'}
        </button>
      </div>

      {/* Create Invoice / Payment Link panel */}
      {showCreateInvoice && (
        <section
          style={{
            marginBottom: '28px',
            padding: '24px',
            background: 'white',
            border: '1px solid #cbd5e1',
            borderRadius: '20px',
            boxShadow: '0 4px 12px -4px rgba(15, 23, 42, 0.08)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '12px', marginBottom: '16px' }}>
            <h3 style={{ margin: 0 }}>Create Payment Link</h3>
            <span style={{ fontSize: '11px', color: '#64748b' }}>
              Total: <strong style={{ color: '#0f172a' }}>{formatCurrency(Math.round(totalRupees * 100))}</strong>
            </span>
          </div>

          {createdLink ? (
            <div>
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '14px', padding: '16px', marginBottom: '14px' }}>
                <strong style={{ color: '#16a34a', display: 'block', marginBottom: '6px' }}>
                  ✓ Payment link created
                </strong>
                <p style={{ fontSize: '12px', color: '#15803d', margin: '0 0 10px' }}>
                  Share the URL below with your customer. They can pay it with Razorpay, the dummy
                  gateway, or — if signed in — pick a saved method.
                </p>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'stretch' }}>
                  <input
                    readOnly
                    value={createdLink}
                    onFocus={(e) => e.target.select()}
                    className="share-input"
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: '12px' }}
                  />
                  <button className="action" type="button" onClick={handleCopyCheckoutLink}>
                    {linkCopied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="action secondary" type="button" onClick={handleResetCreateInvoice}>
                  Create another
                </button>
                <a
                  className="ghost"
                  href={createdLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{ padding: '10px 16px', borderRadius: '12px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                >
                  Preview checkout →
                </a>
              </div>
            </div>
          ) : (
            <form onSubmit={handleCreatePaymentLink} style={{ textAlign: 'left' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '14px' }}>
                <label className="field">
                  <span>
                    Customer (optional)
                    {loadingAllCustomers && (
                      <span style={{ marginLeft: '6px', fontSize: '11px', color: '#94a3b8', fontWeight: 500 }}>
                        loading…
                      </span>
                    )}
                  </span>
                  {(() => {
                    const ownedIds = new Set(
                      customers.filter((c) => c.isOwnCustomer !== false).map((c) => c.id)
                    );
                    const guestIds = new Set(
                      customers.filter((c) => c.isOwnCustomer === false).map((c) => c.id)
                    );
                    const owned = allDbCustomers.filter((c) => c.isOwnCustomer === true);
                    const guests = allDbCustomers.filter(
                      (c) => c.isOwnCustomer === false && guestIds.has(c.id)
                    );
                    const others = allDbCustomers.filter(
                      (c) =>
                        c.isOwnCustomer === false && !guestIds.has(c.id) && !ownedIds.has(c.id)
                    );
                    const renderOption = (c, suffix = '') => (
                      <option key={c.id} value={c.id}>
                        {c.name || 'Anonymous'}
                        {c.email ? ` · ${c.email}` : c.phone ? ` · ${c.phone}` : ''}
                        {suffix}
                      </option>
                    );
                    return (
                      <select
                        value={customerId}
                        onChange={(e) => setCustomerId(e.target.value)}
                        style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', background: 'white', fontFamily: 'inherit' }}
                      >
                        <option value="">— Anonymous (no customer record) —</option>
                        {owned.length > 0 && (
                          <optgroup label={`Your customers (${owned.length})`}>
                            {owned.map((c) => renderOption(c))}
                          </optgroup>
                        )}
                        {guests.length > 0 && (
                          <optgroup label={`Guests — paid you before (${guests.length})`}>
                            {guests.map((c) => renderOption(c, ' (guest)'))}
                          </optgroup>
                        )}
                        {others.length > 0 && (
                          <optgroup label={`Other customers in database (${others.length})`}>
                            {others.map((c) => renderOption(c, ' (other merchant)'))}
                          </optgroup>
                        )}
                      </select>
                    );
                  })()}
                  <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
                    Picking a customer from another merchant is fine — they'll show up under your
                    "Customers" tab as a guest after they pay this invoice.
                  </span>
                </label>
                <label className="field">
                  <span>Capture mode</span>
                  <select
                    value={captureMethod}
                    onChange={(e) => setCaptureMethod(e.target.value)}
                    style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', background: 'white', fontFamily: 'inherit' }}
                  >
                    <option value="AUTOMATIC">Automatic (capture on success)</option>
                    <option value="MANUAL">Manual (auth then capture later)</option>
                  </select>
                </label>
              </div>

              <span style={{ fontSize: '12px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '8px' }}>
                Line Items
              </span>
              <div style={{ display: 'grid', gap: '8px', marginBottom: '14px' }}>
                {items.map((item, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 120px 80px 36px',
                      gap: '8px',
                      alignItems: 'center',
                    }}
                  >
                    <input
                      type="text"
                      placeholder="Item name"
                      value={item.name}
                      onChange={(e) => updateItemField(idx, 'name', e.target.value)}
                      style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '8px 12px', fontSize: '13px' }}
                    />
                    <input
                      type="number"
                      min="1"
                      step="0.01"
                      placeholder="Price (₹)"
                      value={item.price}
                      onChange={(e) => updateItemField(idx, 'price', e.target.value)}
                      style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '8px 12px', fontSize: '13px' }}
                    />
                    <input
                      type="number"
                      min="1"
                      placeholder="Qty"
                      value={item.quantity}
                      onChange={(e) => updateItemField(idx, 'quantity', e.target.value)}
                      style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '8px 12px', fontSize: '13px' }}
                    />
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => handleRemoveItem(idx)}
                      disabled={items.length === 1}
                      style={{ padding: '8px', fontSize: '14px', color: items.length === 1 ? '#cbd5e1' : '#be123c' }}
                      title="Remove this line item"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              <button
                type="button"
                className="ghost"
                onClick={handleAddItem}
                style={{ marginBottom: '16px', fontSize: '12px', padding: '6px 12px' }}
              >
                + Add line item
              </button>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="action" type="submit" disabled={creatingInvoice}>
                  {creatingInvoice ? 'Creating…' : 'Create Payment Link'}
                </button>
                <button className="action secondary" type="button" onClick={() => setShowCreateInvoice(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}

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
                  <th>Type</th>
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
                    <td>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: '800',
                          padding: '3px 8px',
                          borderRadius: '8px',
                          background: intent.metadata?.type === 'wallet_topup' ? '#f0fdfa' : '#edf4ff',
                          color: intent.metadata?.type === 'wallet_topup' ? '#0d9488' : '#1d4ed8',
                          border: `1px solid ${intent.metadata?.type === 'wallet_topup' ? '#99f6e4' : '#cfe0ff'}`,
                          display: 'inline-block'
                        }}
                      >
                        {intent.metadata?.type === 'wallet_topup' ? '👛 Wallet Top-up' : '📄 Invoice Checkout'}
                      </span>
                    </td>
                    <td>{formatCurrency(intent.amount, intent.currency)}</td>
                    <td>
                      <span className={`status-badge ${intent.status.toLowerCase()}`}>{intent.status}</span>
                    </td>
                    <td>{new Date(intent.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button className="ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setSelectedIntent(intent)}>
                          View
                        </button>
                        {intent.status === 'PROCESSING' && intent.captureMethod === 'MANUAL' && (
                          <button
                            className="ghost"
                            style={{ padding: '4px 10px', fontSize: '11px', color: '#0d9488', borderColor: '#99f6e4', background: '#f0fdfa' }}
                            disabled={intentActionLoading === intent.id}
                            onClick={() => handleCaptureIntent(intent.id)}
                          >
                            {intentActionLoading === intent.id ? 'Capturing…' : 'Capture'}
                          </button>
                        )}
                        {['REQUIRES_PAYMENT', 'REQUIRES_ACTION'].includes(intent.status) && (
                          <button
                            className="ghost"
                            style={{ padding: '4px 10px', fontSize: '11px', color: '#a16207', borderColor: '#fde68a', background: '#fef3c7' }}
                            disabled={intentActionLoading === intent.id}
                            onClick={() => handleCancelIntent(intent.id)}
                          >
                            {intentActionLoading === intent.id ? 'Cancelling…' : 'Cancel'}
                          </button>
                        )}
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
                    <td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                      No payments found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent Transactions sidebar */}
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
                    <span className={`status-badge ${intent.status.toLowerCase()}`}>{intent.status}</span>
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

      {/* Main Lists Section (Overview tab) */}
      <div style={{ marginTop: '30px' }}>
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
                    <span className={`status-badge ${d.status.toLowerCase()}`}>{d.status}</span>
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
            <h3>Transactions Audit Log ({transactions.length})</h3>
            <button className="ghost" onClick={handleExportCSV}>Export CSV Report</button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Transaction ID</th>
                <th>Type</th>
                <th>Customer</th>
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
                  <td style={{ fontWeight: 800 }}>
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: '800',
                        padding: '3px 8px',
                        borderRadius: '8px',
                        background:
                          txn.type === 'CAPTURE' ? '#f0fdf4' :
                          txn.type === 'REFUND' ? '#fff7ed' :
                          txn.type === 'VOID' ? '#f1f5f9' :
                          txn.type === 'WITHDRAWAL' ? '#fef2f2' : '#eff6ff',
                        color:
                          txn.type === 'CAPTURE' ? '#16a34a' :
                          txn.type === 'REFUND' ? '#ea580c' :
                          txn.type === 'VOID' ? '#64748b' :
                          txn.type === 'WITHDRAWAL' ? '#dc2626' : '#2563eb',
                        border: `1px solid ${
                          txn.type === 'CAPTURE' ? '#bbf7d0' :
                          txn.type === 'REFUND' ? '#ffedd5' :
                          txn.type === 'VOID' ? '#e2e8f0' :
                          txn.type === 'WITHDRAWAL' ? '#fecaca' : '#bfdbfe'
                        }`,
                        display: 'inline-block'
                      }}
                    >
                      {txn.type}
                    </span>
                  </td>
                  <td>
                    {txn.paymentIntent?.customer ? (
                      <div>
                        <div style={{ fontWeight: 700 }}>
                          {txn.paymentIntent.customer.name || 'Anonymous'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          {txn.paymentIntent.customer.email || ''}
                        </div>
                      </div>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>—</span>
                    )}
                  </td>
                  <td>{formatCurrency(txn.amount, txn.paymentIntent?.currency)}</td>
                  <td>{txn.gateway}</td>
                  <td style={{ fontFamily: 'monospace' }}>{txn.gatewayTxnId || 'N/A'}</td>
                  <td>
                    <span className={`status-badge ${txn.status.toLowerCase()}`}>{txn.status}</span>
                  </td>
                  <td>{new Date(txn.occurredAt).toLocaleString()}</td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                    No transaction entries in double-entry ledger yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>)}

      {activeTab === 'customers' && (
        <div>
        {/* All Customers — full roster with purchase aggregates and wallet balance */}
        <div className="table-container" style={{ marginTop: '8px' }}>
          <div className="table-header" style={{ flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h3 style={{ margin: 0 }}>All Customers ({customers.length})</h3>
              <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '12px' }}>
                Total spent across all customers:{' '}
                <strong style={{ color: '#0f172a' }}>
                  {formatCurrency(customers.reduce((sum, c) => sum + (c.totalSpent || 0), 0))}
                </strong>{' '}
                · Total wallet balance held:{' '}
                <strong style={{ color: '#0f172a' }}>
                  {formatCurrency(customers.reduce((sum, c) => sum + (c.walletBalance || 0), 0))}
                </strong>
              </p>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="action" onClick={() => setShowCreateCustomerModal(true)} style={{ padding: '8px 16px', fontSize: '12px' }}>
                + New Customer
              </button>
              <input
                type="text"
                placeholder="Search by name, email, or ID…"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                style={{
                  border: '1px solid #cbd5e1',
                  borderRadius: '10px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  minWidth: '220px',
                }}
              />
              <select
                value={customerSort}
                onChange={(e) => setCustomerSort(e.target.value)}
                style={{
                  border: '1px solid #cbd5e1',
                  borderRadius: '10px',
                  padding: '6px 10px',
                  fontSize: '12px',
                  background: 'white',
                }}
              >
                <option value="totalSpent">Sort: Highest spend</option>
                <option value="walletBalance">Sort: Highest wallet</option>
                <option value="totalPayments">Sort: Most payments</option>
                <option value="recent">Sort: Newest first</option>
                <option value="lastPaymentAt">Sort: Recently active</option>
                <option value="name">Sort: Name A→Z</option>
              </select>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Contact</th>
                <th style={{ textAlign: 'right' }}>Total Spent</th>
                <th style={{ textAlign: 'right' }}>Payments</th>
                <th style={{ textAlign: 'right' }}>Methods</th>
                <th style={{ textAlign: 'right' }}>Wallet</th>
                <th>Last Payment</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const q = customerSearch.trim().toLowerCase();
                const filtered = q
                  ? customers.filter(
                      (c) =>
                        (c.name || '').toLowerCase().includes(q) ||
                        (c.email || '').toLowerCase().includes(q) ||
                        c.id.toLowerCase().includes(q)
                    )
                  : customers;
                const sorted = [...filtered].sort((a, b) => {
                  switch (customerSort) {
                    case 'walletBalance':
                      return (b.walletBalance || 0) - (a.walletBalance || 0);
                    case 'totalPayments':
                      return (b.totalPayments || 0) - (a.totalPayments || 0);
                    case 'recent':
                      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                    case 'lastPaymentAt': {
                      const at = a.lastPaymentAt ? new Date(a.lastPaymentAt).getTime() : 0;
                      const bt = b.lastPaymentAt ? new Date(b.lastPaymentAt).getTime() : 0;
                      return bt - at;
                    }
                    case 'name':
                      return (a.name || '').localeCompare(b.name || '');
                    case 'totalSpent':
                    default:
                      return (b.totalSpent || 0) - (a.totalSpent || 0);
                  }
                });

                if (sorted.length === 0) {
                  return (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                        {customers.length === 0
                          ? 'No customer records yet. Customers appear here once they register or pay an invoice.'
                          : 'No customers match the search.'}
                      </td>
                    </tr>
                  );
                }

                return sorted.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 800 }}>{c.name || 'Anonymous'}</span>
                        {c.isOwnCustomer === false && (
                          <span
                            title="This customer's home merchant is different — they paid you via a public checkout link."
                            style={{
                              fontSize: '9px',
                              fontWeight: 800,
                              padding: '2px 6px',
                              borderRadius: '6px',
                              background: '#fef3c7',
                              color: '#92400e',
                              border: '1px solid #fde68a',
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                            }}
                          >
                            Guest
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>
                        {c.id.slice(0, 13)}…
                      </div>
                    </td>
                    <td>
                      <div>{c.email || '—'}</div>
                      {c.phone && <div style={{ fontSize: '11px', color: '#64748b' }}>{c.phone}</div>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 800 }}>
                      {formatCurrency(c.totalSpent || 0, c.currency)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {c.successfulPayments}
                      {c.totalPayments > c.successfulPayments && (
                        <span style={{ color: '#94a3b8', fontSize: '11px' }}>
                          {' '}/ {c.totalPayments}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{c.paymentMethodCount}</td>
                    <td style={{ textAlign: 'right' }}>
                      {c.walletBalance > 0 ? (
                        <strong style={{ color: '#0d9488' }}>{formatCurrency(c.walletBalance)}</strong>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>—</span>
                      )}
                    </td>
                    <td>
                      {c.lastPaymentAt ? (
                        <span title={new Date(c.lastPaymentAt).toLocaleString()}>
                          {new Date(c.lastPaymentAt).toLocaleDateString()}
                        </span>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>Never</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        <button
                          className="ghost"
                          style={{ padding: '4px 10px', fontSize: '11px' }}
                          onClick={() => handleOpenCustomerDetail(c.id)}
                        >
                          View Profile
                        </button>
                        {c.isOwnCustomer === false && (
                          <button
                            className="ghost"
                            style={{ padding: '4px 10px', fontSize: '11px', color: '#1d4ed8', borderColor: '#cfe0ff', background: '#edf4ff' }}
                            disabled={claimingCustomerId === c.id}
                            onClick={() => handleClaimGuest(c)}
                            title="Create a fresh customer record under your merchant with this person's profile."
                          >
                            {claimingCustomerId === c.id ? 'Claiming…' : 'Claim'}
                          </button>
                        )}
                        <button
                          className="ghost"
                          style={{ padding: '4px 10px', fontSize: '11px', color: '#0f766e', borderColor: '#99f6e4', background: '#f0fdfa' }}
                          onClick={() => handleViewWalletTransactions(c)}
                        >
                          Wallet Log
                        </button>
                      </div>
                    </td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
        </div>
      )}

      {activeTab === 'webhooks' && (
        <div style={{ marginTop: '8px' }}>
          <WebhooksPanel state={state} api={api} />
        </div>
      )}

      {activeTab === 'events' && (
        <div style={{ marginTop: '8px' }}>
          <EventsPanel state={state} api={api} />
        </div>
      )}

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
                  <Select label="Mode" value={newKeyMode} onChange={setNewKeyMode} options={['TEST', 'LIVE']} />
                  <Select label="Key Type" value={newKeyType} onChange={setNewKeyType} options={['secret', 'public']} />
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
                        <span style={{ fontWeight: 800, color: t.type === 'TOPUP' ? '#0d9488' : '#be123c' }}>{t.type}</span>
                      </td>
                      <td>{formatCurrency(t.amount)}</td>
                      <td>
                        <span className="status-badge succeeded">{t.status}</span>
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

      {/* Create / Import Customer Modal */}
      {showCreateCustomerModal && (
        <div className="modal-overlay" onClick={() => setShowCreateCustomerModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '560px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Add Customer</h2>
              <button className="ghost" type="button" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={() => setShowCreateCustomerModal(false)}>
                Close
              </button>
            </div>

            <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid #e2e8f0', marginBottom: '16px' }}>
              {[
                { id: 'create', label: 'Create New' },
                { id: 'import', label: 'Import Existing' },
              ].map((tab) => {
                const active = customerModalTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setCustomerModalTab(tab.id)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      borderBottom: active ? '3px solid #2563eb' : '3px solid transparent',
                      color: active ? '#1d4ed8' : '#64748b',
                      fontWeight: active ? 800 : 600,
                      fontSize: '13px',
                      padding: '10px 14px',
                      cursor: 'pointer',
                      marginBottom: '-1px',
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {customerModalTab === 'create' && (
              <>
                <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 16px' }}>
                  Create a customer record without going through the public registration flow.
                  Useful for back-office imports or call-center workflows. The server auto-generates
                  a unique <code>externalId</code>.
                </p>
                <form onSubmit={handleCreateCustomerSubmit} style={{ textAlign: 'left' }}>
                  <Input
                    label="Full Name"
                    value={newCustomerForm.name}
                    onChange={(val) => setNewCustomerForm((c) => ({ ...c, name: val }))}
                    placeholder="e.g. Priya Sharma"
                  />
                  <Input
                    label="Email"
                    type="email"
                    value={newCustomerForm.email}
                    onChange={(val) => setNewCustomerForm((c) => ({ ...c, email: val }))}
                    placeholder="customer@example.com"
                  />
                  <Input
                    label="Phone (E.164)"
                    value={newCustomerForm.phone}
                    onChange={(val) => setNewCustomerForm((c) => ({ ...c, phone: val }))}
                    placeholder="+919876543210"
                  />
                  <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
                    <button className="action" type="submit" disabled={creatingCustomer}>
                      {creatingCustomer ? 'Creating…' : 'Create Customer'}
                    </button>
                    <button className="action secondary" type="button" onClick={() => setShowCreateCustomerModal(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              </>
            )}

            {customerModalTab === 'import' && (
              <div style={{ textAlign: 'left' }}>
                <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 14px' }}>
                  Search the global customer pool — anyone who has registered or paid through this
                  gateway. Importing creates a fresh customer record under your merchant with the
                  source person's profile copied over. Their original record stays untouched.
                </p>

                <input
                  type="text"
                  autoFocus
                  placeholder="Search by name, email, phone, or external ID…"
                  value={importSearchQuery}
                  onChange={(e) => setImportSearchQuery(e.target.value)}
                  style={{
                    width: '100%',
                    border: '1px solid #cbd5e1',
                    borderRadius: '12px',
                    padding: '10px 14px',
                    fontSize: '13px',
                    marginBottom: '12px',
                    boxSizing: 'border-box',
                  }}
                />

                <div style={{ maxHeight: '360px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '12px' }}>
                  {importSearching ? (
                    <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
                      Searching…
                    </div>
                  ) : importCandidates.length === 0 ? (
                    <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
                      {importSearchQuery
                        ? 'No customers match your search.'
                        : 'Start typing to search the global customer pool.'}
                    </div>
                  ) : (
                    <div style={{ display: 'grid' }}>
                      {importCandidates.map((c) => (
                        <div
                          key={c.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '10px 14px',
                            borderBottom: '1px solid #f1f5f9',
                            gap: '12px',
                          }}
                        >
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                              <strong style={{ fontSize: '13px' }}>{c.name || 'Anonymous'}</strong>
                              {c.alreadyImported && (
                                <span
                                  title="A customer with this email already exists under your merchant — import would be refused."
                                  style={{
                                    fontSize: '9px',
                                    fontWeight: 800,
                                    padding: '2px 6px',
                                    borderRadius: '6px',
                                    background: '#fef3c7',
                                    color: '#92400e',
                                    border: '1px solid #fde68a',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                  }}
                                >
                                  Already in roster
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                              {c.email || '—'} {c.phone ? ` · ${c.phone}` : ''}
                            </div>
                            <div style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace', marginTop: '2px' }}>
                              {c.id.slice(0, 13)}… · created {new Date(c.createdAt).toLocaleDateString()}
                            </div>
                          </div>
                          <button
                            className="action"
                            type="button"
                            disabled={importingId === c.id || c.alreadyImported}
                            onClick={() => handleImportCustomer(c.id, c.name || c.email)}
                            style={{
                              padding: '6px 14px',
                              fontSize: '12px',
                              opacity: c.alreadyImported ? 0.4 : 1,
                            }}
                          >
                            {importingId === c.id ? 'Importing…' : 'Import'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Customer Detail Drill-down Modal */}
      {viewingCustomerDetailId && (
        <div className="modal-overlay" onClick={() => setViewingCustomerDetailId(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #cbd5e1', paddingBottom: '12px', marginBottom: '16px' }}>
              <div style={{ textAlign: 'left' }}>
                <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>
                  {customerDetail?.name || 'Customer Profile'}
                </h2>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#64748b', fontFamily: 'monospace' }}>
                  {viewingCustomerDetailId}
                </p>
              </div>
              <button className="ghost" type="button" style={{ padding: '6px 12px', borderRadius: '10px' }} onClick={() => setViewingCustomerDetailId(null)}>
                Close
              </button>
            </div>

            {customerDetailLoading || !customerDetail ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#64748b' }}>Loading profile…</div>
            ) : (
              <div style={{ textAlign: 'left' }}>
                <div className="receipt-grid" style={{ marginBottom: '20px', background: '#f8fafc' }}>
                  <div className="receipt-row">
                    <span>Email</span>
                    <strong>{customerDetail.email || '—'}</strong>
                  </div>
                  <div className="receipt-row">
                    <span>Phone</span>
                    <strong>{customerDetail.phone || '—'}</strong>
                  </div>
                  <div className="receipt-row">
                    <span>External ID</span>
                    <strong style={{ fontFamily: 'monospace' }}>{customerDetail.externalId}</strong>
                  </div>
                  <div className="receipt-row">
                    <span>Wallet Balance</span>
                    <strong style={{ color: customerDetail.walletBalance > 0 ? '#0d9488' : '#0f172a' }}>
                      {formatCurrency(customerDetail.walletBalance)}
                    </strong>
                  </div>
                  <div className="receipt-row">
                    <span>Relationship</span>
                    <strong>
                      {customerDetail.isOwnCustomer ? (
                        <span style={{ color: '#16a34a' }}>Owned customer</span>
                      ) : (
                        <span style={{ color: '#92400e' }}>Guest (paid via public link)</span>
                      )}
                    </strong>
                  </div>
                  <div className="receipt-row">
                    <span>Created</span>
                    <strong>{new Date(customerDetail.createdAt).toLocaleString()}</strong>
                  </div>
                </div>

                <span style={{ fontSize: '13px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '8px' }}>
                  Saved Methods ({customerDetail.paymentMethods?.length || 0})
                </span>
                {customerDetail.paymentMethods && customerDetail.paymentMethods.length > 0 ? (
                  <div style={{ border: '1px solid #cbd5e1', borderRadius: '12px', overflow: 'hidden', marginBottom: '20px' }}>
                    <table className="data-table" style={{ fontSize: '12px', margin: 0 }}>
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Brand</th>
                          <th>Last 4</th>
                          <th>Expiry</th>
                          <th>Saved On</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customerDetail.paymentMethods.map((m) => (
                          <tr key={m.id}>
                            <td style={{ fontWeight: 700 }}>{m.type}</td>
                            <td>{m.brand || '—'}</td>
                            <td>{m.last4 ? `•••• ${m.last4}` : '—'}</td>
                            <td>{m.expMonth && m.expYear ? `${m.expMonth}/${m.expYear}` : '—'}</td>
                            <td>{new Date(m.createdAt).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p style={{ color: '#64748b', fontSize: '12px', margin: '0 0 20px' }}>
                    No saved payment methods yet.
                  </p>
                )}

                <span style={{ fontSize: '13px', fontWeight: 800, color: '#475569', display: 'block', marginBottom: '8px' }}>
                  Recent Payments ({customerDetail.paymentIntents?.length || 0})
                  <span style={{ fontWeight: 500, color: '#94a3b8', marginLeft: '6px' }}>
                    (last 25, this merchant only)
                  </span>
                </span>
                {customerDetail.paymentIntents && customerDetail.paymentIntents.length > 0 ? (
                  <div style={{ maxHeight: '320px', overflowY: 'auto', border: '1px solid #cbd5e1', borderRadius: '12px' }}>
                    <table className="data-table" style={{ fontSize: '12px', margin: 0 }}>
                      <thead>
                        <tr>
                          <th>Intent ID</th>
                          <th>Amount</th>
                          <th>Status</th>
                          <th>Capture</th>
                          <th>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customerDetail.paymentIntents.map((i) => (
                          <tr key={i.id}>
                            <td style={{ fontFamily: 'monospace' }}>{i.id.slice(0, 13)}…</td>
                            <td style={{ fontWeight: 700 }}>{formatCurrency(i.amount, i.currency)}</td>
                            <td>
                              <span className={`status-badge ${i.status.toLowerCase()}`}>{i.status}</span>
                            </td>
                            <td style={{ fontSize: '11px', color: '#64748b' }}>{i.captureMethod}</td>
                            <td>{new Date(i.createdAt).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p style={{ color: '#64748b', fontSize: '12px', margin: 0 }}>
                    No payments from this customer yet.
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
