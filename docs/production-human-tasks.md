# Production deployment human tasks

Date: 2026-06-24

Branch: `a/production-readiness`

This checklist starts where the code-side production-readiness work stops. The app now has stricter production env validation, quota guards, security headers, CI, operations scripts, and public alpha policy drafts. The remaining work requires provider accounts, billing, DNS, emails, production credentials, dashboard setup, and live smoke tests.

Do not share production with external users until every P0 item below is complete.

## P0: Required Before Production Deploy

### 1. Choose the production URL

Pick one canonical app URL:

- `https://app.learnrecur.com`
- or `https://alpha.learnrecur.com`
- or another final production URL you actually want users to see.

Steps:

1. Buy or access the domain.
2. Add the chosen app hostname in Vercel.
3. Add the DNS records Vercel gives you.
4. Wait for Vercel to show HTTPS as active.
5. Use this exact URL for `NEXT_PUBLIC_APP_URL`.

Do not use localhost, a random preview URL, or a temporary URL for production env.

### 2. Create the Vercel production project

Steps:

1. Create/import the LearnRecur GitHub repo in Vercel.
2. Framework preset: Next.js.
3. Install command: `npm ci`.
4. Build command: `npm run build`.
5. Add the production domain.
6. Confirm Vercel production builds run with `VERCEL_ENV=production`.
7. Confirm `/api/inngest` is reachable by Inngest. Vercel deployment protection must not block it.
8. Confirm the plan supports the configured `/api/inngest` `maxDuration` in `vercel.json`.

### 3. Create the Neon production database

Steps:

1. Create a Neon production project.
2. Create the production database.
3. Copy the pooled connection string to Vercel as `DATABASE_URL`.
4. Copy the direct connection string to Vercel as `DIRECT_URL`.
5. Confirm backups or point-in-time restore are enabled for your plan.
6. Configure billing and storage alerts.
7. Before app traffic, run production migrations:

```bash
npm ci
npm run prisma:validate
npm run prisma:generate
npm run prisma:deploy
```

Only run `prisma:deploy` from one controlled place for a release.

### 4. Create the Clerk production instance

Steps:

1. Create a Clerk production instance.
2. Configure app URLs:
   - Sign in: `/sign-in`
   - Sign up: `/sign-up`
   - After sign in: `/dashboard`
   - After sign up: `/dashboard`
3. Copy production keys to Vercel:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
4. Confirm public sign-up is configured as intended.
5. Create your first test account.
6. Confirm the test account can sign in.

### 5. Create the private S3 bucket

Steps:

1. Create a production S3 bucket, for example `learnrecur-prod-source-uploads`.
2. Enable "Block all public access."
3. Keep object ACLs disabled if AWS offers that option.
4. Enable default encryption.
5. Add a lifecycle rule to abort incomplete multipart uploads after 7 days.
6. Configure CORS for only the production app URL:

```json
[
  {
    "AllowedOrigins": ["https://app.learnrecur.com"],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

7. Create a least-privilege IAM key for the bucket.
8. Set Vercel env:
   - `AWS_REGION`
   - `S3_BUCKET_NAME`
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`

After deployment, upload a PNG and a PDF through the real app and confirm direct S3 object URLs are denied.

### 6. Create the Inngest production app

Steps:

1. Create a production Inngest app/environment.
2. Create an event key.
3. Copy it to Vercel as `INNGEST_EVENT_KEY`.
4. Copy the signing key to Vercel as `INNGEST_SIGNING_KEY`.
5. Set:

```text
INNGEST_APP_ID=learnrecur
INNGEST_DEV=0
```

6. Deploy Vercel production.
7. Sync functions from `https://your-production-url/api/inngest`.
8. Confirm these functions appear:
   - `choice-exercise-refill`
   - `exact-input-exercise-refill`
   - `math-exercise-refill`
   - `source-upload-draft`
   - `due-practice-reminders`
9. Turn on Inngest failure alerts.

### 7. Create the Gemini production key

Steps:

1. Create the production Gemini API project/key.
2. Enable billing if required.
3. Restrict the key where Google allows it.
4. Set Vercel env:

```text
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash
```

5. Configure budget and quota alerts.
6. Run live smoke tests:
   - Paste source text and generate drafts.
   - Upload a PNG and generate drafts.
   - Upload a PDF and generate drafts.
   - Activate a draft and confirm verified multiple-choice exercises.
   - Trigger exact-input generation.
   - Trigger math generation.

If any Gemini path fails because the API surface changed, pause deployment and fix that before inviting testers.

### 8. Create the Resend production sender

Steps:

1. Add the sending domain in Resend.
2. Add DNS records for DKIM, SPF, and DMARC.
3. Wait for domain verification.
4. Create a production API key.
5. Set Vercel env:

```text
RESEND_API_KEY=...
RESEND_FROM_EMAIL=LearnRecur <practice@app.learnrecur.com>
```

6. Enable reminders for a test user.
7. Confirm a real reminder email arrives.
8. Confirm it links to `/practice` and `/settings`.
9. Watch the Resend dashboard for bounces or domain errors.

### 9. Set every Vercel production env var

Required production values:

```text
NEXT_PUBLIC_APP_URL=https://app.learnrecur.com
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
DATABASE_URL=postgresql://...pooled...
DIRECT_URL=postgresql://...direct...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash
AWS_REGION=...
S3_BUCKET_NAME=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
INNGEST_APP_ID=learnrecur
INNGEST_DEV=0
INNGEST_EVENT_KEY=...
INNGEST_SIGNING_KEY=...
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=LearnRecur <practice@app.learnrecur.com>
```

Optional:

```text
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FORCE_REDIRECT_URL=/dashboard
NEXT_PUBLIC_CLERK_SIGN_UP_FORCE_REDIRECT_URL=/dashboard
```

Do not set `CLERK_WEBHOOK_SECRET` until a Clerk webhook route is implemented.

### 10. Run the strict env check against production env

After production env is configured locally or in CI:

```bash
LEARNRECUR_STRICT_ENV=1 npm run env:check
```

Expected result:

```text
Production environment check passed.
```

If it fails, fix env before deploying.

## P0: Production Smoke Test

Use a production test account.

1. Visit `/dashboard` while signed out. Confirm redirect to `/sign-in`.
2. Sign in. Confirm `/dashboard` loads.
3. Try signing up with a new email. Confirm the app creates the account.
4. Confirm `/ops` returns not found for a signed-in user.
5. Create a manual draft skill.
6. Paste source material and generate drafts.
7. Upload a small PNG source.
8. Upload a small PDF source.
9. Confirm Inngest processes upload jobs.
10. Activate a draft skill.
11. Confirm verified exercises are created.
12. Open `/practice`.
13. Answer an exercise and confirm instant feedback.
14. Confirm `/history` records the review.
15. Enable reminders and confirm a real email arrives.
16. Download `/settings/export`.
17. Run `npm run ops -- report` from a trusted local machine with production env configured.
18. Confirm Vercel logs have no unexpected server errors.
19. Confirm Inngest shows successful function runs.
20. Confirm Neon connection counts look normal.
21. Confirm S3 objects are private.
22. Confirm Gemini usage is expected.
23. Confirm Resend has no bounce/domain errors.

## P1: Human Review Before External Alpha

Complete these before anyone outside your direct test circle uses the app:

1. Review `/privacy` and `/terms`.
2. Replace draft policy language with final founder/legal-approved language.
3. Publish a support email address.
4. Decide the manual account deletion SLA.
5. Rehearse the account deletion script on a non-production database.
6. Rehearse S3 storage audit on a non-production bucket.
7. Configure provider alerts:
   - Vercel deploy and server-error alerts.
   - Neon billing/storage/connection alerts.
   - Inngest function failure alerts.
   - Gemini quota and budget alerts.
   - Resend bounce or complaint alerts.
   - AWS S3 public-access and storage growth alerts.
8. Decide who can rotate credentials.
9. Store provider recovery codes and billing access somewhere durable.
10. Confirm rollback in Vercel works.

## Operations Commands To Rehearse

Run these against staging or a disposable production-like database before using them on production.

```bash
npm run ops -- report
npm run ops -- storage-audit
npm run ops -- export-user --user-id USER_ID --out ./export.json
npm run ops -- disable-reminders --user-id USER_ID --confirm USER_ID
npm run ops -- delete-user --user-id USER_ID
npm run ops -- delete-user --user-id USER_ID --confirm USER_ID --delete-s3
npm run ops -- mark-generation-job-failed --job-id JOB_ID --reason "manual ops correction" --confirm JOB_ID
npm run ops -- requeue-source-upload --user-id USER_ID --source-file-id SOURCE_ID --confirm SOURCE_ID
```

The delete command is dry-run unless `--confirm USER_ID --delete-s3` are both present.

## Known Human Blockers

These cannot be completed by code alone:

- Payment method for Vercel, Neon, AWS, Gemini, Inngest, Resend, and domain/DNS.
- Production provider accounts and ownership.
- Production credentials.
- DNS control.
- Email/domain verification.
- Clerk production restricted-signup setup.
- Inngest function sync from the deployed app.
- Gemini live smoke tests with real billing/quota.
- Resend live email delivery test.
- S3 bucket creation and public-access verification.
- Legal/privacy/terms approval.
- Final support email and user deletion policy.

Once these are done, the next code step should be a final release verification pass on the real production configuration.
