# HouseFund

One house. Shared expenses. Zero confusion.

A mobile-first household finance app for roommates: monthly grocery fund,
Splitwise-style expense splitting with an auditable ledger, bills, shopping
list, inventory, receipt photos, and one-tap backups.

## How it works

- **No self-signup.** The house admin creates every member account in the
  admin panel (`/admin`). Members log in with username + password.
- **First login forces a password change.** Forgotten passwords are reset by
  the admin (temp password shown once).
- **Money math:** every expense is split into allocations that must add up
  to the total exactly. All amounts are integer cents — no float drift.
  Transactions are immutable; mistakes are fixed with reversing entries.

## Run locally

```bash
npm install
ADMIN_USER=admin ADMIN_PASS=pick-a-strong-password node server.js
```

Open http://localhost:3000 → admin panel at http://localhost:3000/admin

Set `DATABASE_URL` (Neon Postgres) to use Postgres instead of the JSON file.

## Tests

```bash
npm test   # ledger acceptance tests + full API end-to-end
```

## Deploy

See **DEPLOY.md** — GitHub → Neon → Render, about 20 minutes.

## Project layout

- `ledger.js` — pure money engine (contributions, allocations, debts, settlements, reversals)
- `db.js` — Postgres/JSON dual storage, serialized writes, rolling backups
- `auth.js` — scrypt passwords, sessions, temp passwords
- `server.js` — zero-dependency HTTP API + static files
- `public/` — PWA mobile app (Home, Activity, Add, Groceries, House) + admin panel
- `test/` — acceptance tests from the product brief
