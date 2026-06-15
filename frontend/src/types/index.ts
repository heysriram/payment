export type AppView = 'auth' | 'dashboard' | 'customer_dashboard' | 'checkout';

export interface AppState {
  apiBase: string;
  dashboardJwt: string;
  partialJwt: string;
  secretKey: string;
  publicKey: string;
  merchantId: string;
  customerId: string;
  paymentMethodId: string;
  paymentIntentId: string;
  currentCustomerId: string;
  currentCustomerName: string;
  currentCustomerEmail: string;
}

export interface RegisterForm {
  name: string;
  legalName: string;
  gst: string;
  pan: string;
  email: string;
  password: string;
}

export interface LoginForm {
  email: string;
  password: string;
  code: string;
}

export interface CustomerRegisterForm {
  name: string;
  email: string;
  phone: string;
}

export interface CustomerLoginForm {
  email: string;
}

export interface AppForms {
  register: RegisterForm;
  login: LoginForm;
  customerRegister: CustomerRegisterForm;
  customerLogin: CustomerLoginForm;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiCallOptions {
  state: AppState;
  path: string;
  method?: HttpMethod;
  token?: string;
  idempotencyKey?: string;
  body?: unknown;
}

export type ApiFn = <T = any>(options: ApiCallOptions) => Promise<T>;

export interface LineItem {
  name: string;
  price: string | number;
  quantity: string | number;
}

export interface PaymentIntentMetadata {
  line_items?: LineItem[];
  type?: string;
  [key: string]: unknown;
}

export interface PaymentIntentCustomer {
  name?: string | null;
  email?: string | null;
}

export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  captureMethod?: string;
  customer?: PaymentIntentCustomer | null;
  merchant?: { name?: string | null } | null;
  metadata?: PaymentIntentMetadata | null;
  transactions?: Array<{ gatewayTxnId?: string | null }>;
}

export interface PublicPaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  merchantName: string;
  customerId?: string | null;
  metadata?: PaymentIntentMetadata | null;
  razorpayOrderId?: string | null;
  razorpayKeyId?: string;
}

export interface PaymentMethod {
  id: string;
  type: string;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  createdAt: string;
}

export interface MerchantCustomer {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  createdAt: string;
  walletBalance?: number;
  totalSpent?: number;
  totalPayments?: number;
  successfulPayments?: number;
  paymentMethodCount?: number;
  lastPaymentAt?: string | null;
  currency?: string;
  isOwnCustomer?: boolean;
  externalId?: string;
}

export interface CustomerSearchResult {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  createdAt: string;
  isOwnCustomer: boolean;
  alreadyImported: boolean;
}

export interface MerchantProfile {
  id: string;
  name: string;
  legalName?: string;
  gst?: string | null;
  status: string;
}

export interface MerchantBalance {
  available: number;
  pending: number;
}

export interface Transaction {
  id: string;
  type: string;
  amount: number;
  status: string;
  gateway: string;
  gatewayTxnId?: string | null;
  occurredAt: string;
  paymentIntent?: {
    currency?: string;
    customer?: PaymentIntentCustomer | null;
  } | null;
}

export interface Dispute {
  id: string;
  amount: number;
  status: string;
  transaction?: {
    paymentIntentId?: string;
    paymentIntent?: {
      currency?: string;
      customer?: PaymentIntentCustomer | null;
    };
  } | null;
}

export interface ApiKey {
  id: string;
  keyId: string;
  mode: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  status: string;
  createdAt: string;
  _count?: { deliveries: number };
}

export interface WebhookDelivery {
  id: string;
  status: string;
  attempts: number;
  responseCode?: number | null;
  responseBody?: string | null;
  lastAttemptAt?: string | null;
  event?: { id: string; type: string; createdAt: string } | null;
}

export interface GatewayEvent {
  id: string;
  type: string;
  apiVersion?: string | null;
  createdAt: string;
  payload?: unknown;
  deliveries?: Array<{
    id: string;
    webhookId: string;
    status: string;
    attempts: number;
    responseCode?: number | null;
    lastAttemptAt?: string | null;
  }>;
}

export interface WalletTransaction {
  id?: string;
  type?: string;
  amount?: number;
  description?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export type DummyPaymentMethod = 'card' | 'upi' | 'netbanking' | 'wallet';
export type DummyOutcome = 'SUCCESS' | 'FAILURE_DECLINED' | 'FAILURE_REVERTED';

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
