import type { AppForms, AppState, AppView, ApiFn } from './types';
import { useMemo, useState } from 'react';
import { api } from './lib/api';
import { initialForms, readStorage, writeStorage } from './lib/storage';
import { AuthPortal } from './pages/AuthPortal';
import { CustomerDashboard } from './pages/CustomerDashboard';
import { MerchantDashboard } from './pages/MerchantDashboard';
import { CustomerCheckout } from './pages/CustomerCheckout';

export function App() {
  const [state, setState] = useState<AppState>(readStorage);
  const [forms, setForms] = useState<AppForms>({ ...initialForms });

  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const intentId = urlParams.get('intentId') || '';
  const clientSecret = urlParams.get('clientSecret') || '';

  const [view, setView] = useState<AppView>(() => {
    if (intentId && clientSecret) return 'checkout';
    const storage = readStorage();
    if (storage.dashboardJwt) return 'dashboard';
    if (storage.currentCustomerId) return 'customer_dashboard';
    return 'auth';
  });

  const updateState = (patch: Partial<AppState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      writeStorage(next);
      return next;
    });
  };

  const updateForm = <K extends keyof AppForms>(
    group: K,
    field: keyof AppForms[K],
    value: string
  ) => {
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
        api={api as ApiFn}
      />
    );
  }

  if (view === 'customer_dashboard') {
    return (
      <main className="shell" style={{ gridTemplateColumns: '1fr' }}>
        <section className="workspace">
          <CustomerDashboard state={state} api={api as ApiFn} handleLogout={handleLogout} />
        </section>
      </main>
    );
  }

  return (
    <main className="shell" style={{ gridTemplateColumns: '1fr' }}>
      <section className="workspace">
        <MerchantDashboard
          state={state}
          api={api as ApiFn}
          handleLogout={handleLogout}
          updateState={updateState}
        />
      </section>
    </main>
  );
}
