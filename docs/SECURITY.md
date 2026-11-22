# Security remediation log (draft: fill in the ArgosX numbers)

Run the **baseline ArgosX scan on the deployed URL before deploying this version**, so the improvement is visible.
Then deploy, run the final scan, and fill in the first column from the two reports.

| ArgosX finding (fill in) | What we found ourselves | Fix in this build | Test |
|---|---|---|---|
| | Anyone could close or escalate any incident with no login (`POST /incidents/:id/resolve`, `/escalate`) | Routes removed; only the officer workflow can close an incident | `api.test.ts` (404s) |
| | Missing security headers (HSTS, nosniff, frame-options, CSP) | `@fastify/helmet`, strict CSP for a JSON API | `api.test.ts` |
| | No global rate limit; officer password guessing unlimited | `@fastify/rate-limit`: 300/min per IP, 10/min on sign-in and OTP, 20–30/min on AI routes | `security.test.ts` |
| | Fixed OTP `123456` for every phone | Random 6-digit code per request, single use, 10 min expiry, timing-safe compare; one network may verify at most 8 phones/hour | `auth_intake.test.ts`, `security.test.ts` |
| | Incident graph public: leaked reporter ids and raw device ids | Graph, rings, root cause and Ask are officer-only; device ids stored and shown only as one-way fingerprints | `api_intake.test.ts`, `security.test.ts` |
| | `/admin/replay` open | Behind the admin key | `api_intake.test.ts` |
| | 8 MB body limit on every route | 1 MB default; 8 MB only on photo/voice routes; 256 KB on language packs | – |
| | Every user appeared to share one IP behind Render's proxy (trust signal fired for everyone) | `trustProxy: true` | – |
| | CORS `*` | `CORS_ORIGIN` takes a comma-separated allowlist | `security.test.ts` |
| | Voice / translation / read-aloud could be called anonymously (cost abuse) | Need a verified citizen or a signed-in officer | `api_portal.test.ts` |

## Accepted for the MVP, and why
- **OTP delivery is simulated.** No SMS provider is connected, so the code is shown on screen as a "demo SMS". The per-network cap limits one person to a few accounts. Fix: connect an SMS provider (e.g. MSG91) and stop returning the code.
- **Officer accounts share one password** (`OFFICER_PASSWORD`, required in production). Fix: department SSO.
- **Phone location is trusted** for the pin and me-too checks. A determined spoofer can fake GPS; the graph's ring detection limits what one person can do with it.
- **`CORS_ORIGIN=*` in `render.yaml`** until the Vercel URL is known: set it to that URL before the final scan.
