import type { AppState } from '../types';

export const defaults: AppState = {
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

export const initialForms = {
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
} as const;

const STORAGE_KEY = 'pg-console';

export function readStorage(): AppState {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

export function writeStorage(value: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}
