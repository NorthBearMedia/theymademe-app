# They Made Me — Go-Live Checklist

The code side of the customer journey is complete and tested. These are the
actions that must be done **outside the repo** (dashboards + server env),
in order. Everything here is ~an hour of clicking.

## 1. JotForm (theymademe account)

- [ ] **Re-enable the intake form** `260414001149039` ("AI Family Tree - Your
      Details") — it is currently **DISABLED**, which kills the whole funnel.
      JotForm → My Forms → right-click the form → Enable. (If JotForm disabled
      it for a plan limit, resolve that first.)
- [ ] **Add the webhook**: form → Settings → Integrations → Webhooks →
      `https://theymademe.co.uk/api/form-submission?token=<INTAKE_SECRET>`
      (use the INTAKE_SECRET value from the server's .env). The app now parses
      JotForm's multipart webhooks and this form's exact field names — tested
      against your real submission.
- [ ] **Recommended — collect payment inside the form**: add a JotForm
      **Stripe payment field** tied to the package question, so payment and
      family details arrive together (kills the pay-without-submitting /
      submit-without-paying gap). Until then, payment stays via the separate
      Stripe links on the landing page and you reconcile by email address.
- [ ] Optional: switch the 7 free-text date questions to date pickers
      (the app now repairs 2-digit years like "23/08/89", but pickers are cleaner).

## 2. Server environment (/opt/theymademe-app/.env)

- [ ] **SMTP for customer emails** (order confirmation + tree delivery):
      `SMTP_HOST=…  SMTP_PORT=587  SMTP_USER=…  SMTP_PASS=…`
      `MAIL_FROM="They Made Me <hello@theymademe.co.uk>"`
      Any provider works (e.g. Resend/Postmark/Google Workspace SMTP).
      Without these, emails are logged no-ops and the admin UI shows
      "Email not configured".
- [ ] **SESSION_SECRET** — set a strong random value. The app now refuses to
      boot in production with the default.
- [ ] **INTAKE_SECRET** — confirm it's set (same value as in the webhook URL).
- [ ] **FamilySearch PRODUCTION** (currently defaults to beta):
      `FS_AUTH_URL=https://ident.familysearch.org/cis-web/oauth2/v3/authorization`
      `FS_TOKEN_URL=https://ident.familysearch.org/cis-web/oauth2/v3/token`
      `FS_API_BASE=https://api.familysearch.org`
      `FS_CLIENT_ID=<your production app key>` — requires an approved
      production key from FamilySearch (their developer support handles the
      beta→production promotion; commercial use requires their sign-off).
- [ ] Rebuild + restart: `docker compose up -d --build` (installs nodemailer/multer).

## 3. Every research day

- [ ] **Connect FamilySearch via OAuth** from the admin dashboard before
      approving jobs. Authenticated tokens last ~24h and there is no refresh —
      the dashboard now shows a **"Search-only — reconnect for tree access"**
      warning when tree traversal would be degraded. Reconnect when you see it.

## 4. Ops

- [ ] **Backups**: schedule a copy of `/opt/theymademe-app/data/` offsite
      (it holds every customer's tree). Even a daily
      `tar czf` to object storage is fine.
- [ ] After SSL is confirmed working: re-enable HSTS and secure cookies in
      `app/src/server.js` (two flags marked "SSL bootstrap").

## What's already wired in the code (no action needed)

- Webhook accepts the live form's exact fields (incl. multipart, name
  objects, "whichPackage" → 4/5/6 generations, 2-digit-year repair).
- Order-confirmation email fires on intake; **Send to Customer** button on a
  completed research job emails the fan-chart PDF and stamps it Delivered.
- Landing-page footer now links to /terms (Privacy + Terms).
- Refund-guarantee tracking: completed jobs below 3 solid generations are
  flagged in the admin so you can honour the refund promise proactively.
- Stalled-job detection, master rulebook governance, accuracy harness
  (validated 100% on the real Ahlfors-Hunt/Vallance tree).
