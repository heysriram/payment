# Payment Gateway Frontend

React testing console for the Express payment gateway backend.

## Run

From `frontend/`:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

Keep the backend running on `http://localhost:3000`. The Vite dev server proxies `/api` to the backend, so the default API base `/api/v1` works without CORS changes.

## Flow

1. Register a merchant.
2. Login and verify TOTP.
3. Create or paste API keys.
4. Create a customer.
5. Attach a payment method with the public tokenize key.
6. Create and confirm a payment intent with the secret key.
