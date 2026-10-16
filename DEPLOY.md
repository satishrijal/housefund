# HouseFund — Deploy Guide

Get the app live in about 20 minutes. You need: this folder's files,
a GitHub account, a Neon account (free Postgres), a Render account (free).

## Step 1 — Put it on GitHub (5 min)

1. On github.com, tap **+ → New repository**. Name it `housefund`. Private is fine.
2. Tap **uploading an existing file**, drag in ALL files from the housefund folder
   (server.js, db.js, ledger.js, auth.js, package.json, package-lock.json,
   the `public/` folder, `test/` folder).
   - Do NOT upload the `data/` folder or `node_modules/`.
3. Tap **Commit changes**.

## Step 2 — Free Postgres on Neon (5 min)

1. Go to neon.tech, sign up (free).
2. **New Project** → name it `housefund` → Create.
3. Copy the **connection string** (starts with `postgresql://…`). Keep it handy.
   - It looks like: `postgresql://user:password@ep-xxx.neon.tech/dbname?sslmode=require`

## Step 3 — Launch on Render (5 min)

1. Go to dashboard.render.com → **New + → Web Service**.
2. Connect your GitHub, pick the `housefund` repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - Plan: **Free**
4. Tap **Environment** and add three variables:
   - `DATABASE_URL` = the Neon connection string from Step 2
   - `ADMIN_USER` = pick something (e.g. `satish`)
   - `ADMIN_PASS` = pick a strong password (this is YOUR admin login)
5. Tap **Create Web Service**. Wait ~3 minutes for the first deploy.
   - Free plan sleeps when idle: the first visit after a while takes ~30–60 seconds. Normal.

## Step 4 — Create the member accounts (3 min)

1. Open `https://YOUR-APP.onrender.com/admin`
2. Log in with your ADMIN_USER / ADMIN_PASS.
3. Tap **+ New member** for each roommate:
   - Name: e.g. `Alex` · Username: e.g. `alex` · leave password blank (auto-generates)
4. **Copy each temp password** and send it to that person (text them).
5. On their first login they'll be forced to set their own password.
   - If anyone forgets: come back here → **Reset pw** → send them the new temp password.

## Step 5 — Everyone installs it (1 min each)

1. Each roommate opens the app URL in **iPhone Safari**.
2. Share → **Add to Home Screen**. Now it opens like a real app.

## Backups (your data safety)

- **Anytime:** Admin panel → **Download full backup** → saves everything as one file. Keep it.
- The server also keeps the last 30 daily backups automatically.
- Google Drive auto-upload: needs your Google account reconnected — say the word and I'll wire it.

## If something breaks

- App won't load: check Render dashboard → Logs.
- "Postgres unreachable" in logs: check the DATABASE_URL variable (Neon dashboard → connection string).
- Admin login fails: check ADMIN_USER / ADMIN_PASS in Render → Environment (then Manual Deploy → Clear build cache & deploy).
