import type { ApiCallOptions } from '../types';

export class ApiError extends Error {
  data?: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.data = data;
  }
}

export async function api<T = any>({
  state,
  path,
  method = 'GET',
  token,
  idempotencyKey,
  body,
}: ApiCallOptions): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${state.apiBase || '/api/v1'}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof (data as { error?: { message?: string } }).error?.message === 'string'
        ? (data as { error: { message: string } }).error.message
        : `HTTP ${response.status}`;
    throw new ApiError(message, data);
  }
  return data as T;
}
