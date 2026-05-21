# TAFS Subvention Calculator

Password-gated, single-page subvention calculator for the TAFS rate buy-down workflow. Static HTML/CSS/JS on S3, fronted by CloudFront (HTTPS-only), with a Node 20 Lambda handling password auth against AWS Secrets Manager and issuing 24-hour HMAC-signed JWTs.

```
public/                       static site (synced to S3)
  index.html                   login overlay + calculator + auth gate
  fonts/Manrope-*.ttf          official brand typeface
lambda/                       Node 20 Lambda (zipped + uploaded by CI)
  index.mjs                    POST /auth → Secrets Manager → JWT
  package.json
.github/workflows/deploy.yml  CI pipeline (S3 sync + Lambda update + CF invalidate)
```

## Architecture

```
Browser
   │  HTTPS
   ▼
CloudFront  (viewer-protocol-policy = redirect-to-https)
   │
   ├── /        → S3 origin  (tafs-subvention-calc)
   │              static index.html, fonts/
   │
   └── /auth    → Lambda Function URL  (subvention-calc-auth)
                  POST { password } → 200 { token } | 401
                          │
                          ▼
                  Secrets Manager  (subvention-calc/password, KMS-encrypted)
```

- Password lives in Secrets Manager; Lambda reads it once per cold start (5-min in-memory cache).
- On success, Lambda returns an HS256 JWT with `exp = now + 24h`, signed with `JWT_SIGNING_SECRET` (a Lambda env var encrypted at rest by Lambda's KMS key).
- Client stores the JWT in `localStorage`. On revisit within 24h, the calculator loads instantly without re-prompting.
- Sharing the URL gives a new browser only the URL — the localStorage token is per-browser, so the new visitor hits the login form.

## One-time AWS bootstrap (Path α, manual)

Do this once in the `calculator-assetfinanceshop` AWS account console. Region: **ap-southeast-2 (Sydney)**.

### 1. Secrets Manager

- Secrets Manager → **Store a new secret** → "Other type of secret"
- Plaintext: `<your-password>` (just the raw password — no JSON wrapper needed; the Lambda also accepts `{"password":"…"}` form). Get the actual value from your password manager / a teammate; never commit it.
- Secret name: `subvention-calc/password`
- Encryption: default (`aws/secretsmanager`)
- Save the resulting **secret ARN** — needed in step 3.

### 2. IAM role for Lambda

- IAM → Roles → **Create role**
- Trusted entity: AWS service → Lambda
- Attach the AWS-managed policy `AWSLambdaBasicExecutionRole`
- Create one inline policy `secretsmanager-read` (replace the ARN with the one from step 1):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "secretsmanager:GetSecretValue",
    "Resource": "arn:aws:secretsmanager:ap-southeast-2:ACCOUNT_ID:secret:subvention-calc/password-*"
  }]
}
```

- Role name: `subvention-calc-auth-role`

### 3. Lambda function

- Lambda → **Create function** → Author from scratch
- Name: `subvention-calc-auth`
- Runtime: **Node.js 20.x**
- Architecture: arm64 (cheaper)
- Execution role: existing → `subvention-calc-auth-role`
- Create function. **Code** → upload anything as a placeholder (the GitHub Action will overwrite on first push). Or paste the contents of `lambda/index.mjs` directly and rename the file to `index.mjs`.
- **Configuration → Environment variables**:
  - `SECRET_ARN` = the ARN from step 1
  - `JWT_SIGNING_SECRET` = a random 32-byte hex string (generate with `openssl rand -hex 32`)
  - `JWT_TTL_HOURS` = `24` (optional)
  - `CORS_ORIGIN` = `*` for now; tighten to your CloudFront domain after step 5
- **Configuration → Function URL**:
  - Enable Function URL
  - Auth type: **NONE** (the password check is inside the Lambda code, not IAM-based)
  - CORS: enable, Allow-Origin `*` (or set to CloudFront origin)
- Copy the resulting Function URL — needed in step 5.

### 4. S3 bucket

- S3 → **Create bucket** → `tafs-subvention-calc` in `ap-southeast-2`
- Block all public access: **ON** (CloudFront OAC will read it)
- Default encryption: SSE-S3 (or SSE-KMS if you prefer)
- Versioning: off (optional)

### 5. CloudFront distribution

- CloudFront → **Create distribution**
- Origin 1 (S3 default):
  - Origin domain: pick the `tafs-subvention-calc.s3.ap-southeast-2.amazonaws.com` bucket
  - Origin access: **Origin access control (OAC)** → Create new OAC (sigv4, recommended)
  - After creating, CloudFront shows you a bucket policy snippet → click "Copy policy" → paste into the S3 bucket's Permissions → Bucket policy
- Origin 2 (Lambda Function URL):
  - Origin domain: paste the Lambda Function URL (without `https://` and without trailing `/`)
  - Protocol: HTTPS only
- Default cache behavior (S3):
  - Viewer protocol policy: **Redirect HTTP to HTTPS**
  - Allowed methods: GET, HEAD
  - Cache policy: `Managed-CachingOptimized`
- Add cache behavior for path pattern `/auth`:
  - Origin: the Lambda Function URL origin
  - Viewer protocol policy: HTTPS only
  - Allowed methods: GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE
  - Cache policy: `Managed-CachingDisabled`
  - Origin request policy: `Managed-AllViewerExceptHostHeader`
- Settings:
  - Default root object: `index.html`
  - Price class: PriceClass_100
  - TLS: SNI, minimum TLSv1.2_2021
- Create — propagation takes ~10–15 min.
- Save the **Distribution ID** and the **Distribution Domain Name** (the `dXXXX.cloudfront.net` URL).

### 6. GitHub Secrets

In `github.com/assetfinanceshop/subvention-calculator/settings/secrets/actions` (or as Org Secrets at `github.com/organizations/assetfinanceshop/settings/secrets/actions`):

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `CLOUDFRONT_DISTRIBUTION_ID` = the ID from step 5

The IAM user behind those AWS keys needs:
- `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the new bucket
- `lambda:UpdateFunctionCode` on the new function
- `cloudfront:CreateInvalidation` on the new distribution

(Probably matches what the existing calculator's IAM user already has, scoped to the new resource ARNs — add an inline policy with the new ARNs if not.)

## Deploy

```bash
git push origin main
```

GitHub Actions runs `s3 sync public/` + `lambda update-function-code` + `cloudfront create-invalidation`. ~60–90 seconds plus ~30 seconds for CloudFront propagation.

## Rotating the password

1. Secrets Manager → `subvention-calc/password` → Retrieve → Edit → set new value → Save.
2. Wait up to 5 minutes (Lambda's in-memory cache TTL), or manually clear by republishing the Lambda (which forces a cold start). Easier: run the workflow manually via GitHub → Actions → workflow_dispatch.

## Local preview

`public/index.html` works offline against `http://localhost:8000/`, but the login form will fail (`/auth` isn't reachable locally). To test the calculator UI itself, briefly set `localStorage.subv_jwt` to any string with a valid future `exp` claim, or comment out the auth gate.

## Files

| File | Purpose |
|---|---|
| `public/index.html` | Login overlay + calculator + auth gate JS |
| `public/fonts/Manrope-*.ttf` | Self-hosted brand typeface |
| `lambda/index.mjs` | Auth handler (Node 20, AWS SDK v3 pre-bundled) |
| `lambda/package.json` | Just declares the runtime + ESM type |
| `.github/workflows/deploy.yml` | CI pipeline |
| `CLAUDE.md` | Working rules for AI pair-programming on this repo |
