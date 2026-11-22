# Deploy checklist (API on Render, web on Vercel)

Order matters: API first, then web, then connect them.

## 1. API on Render
1. New > Blueprint > pick this repo (`render.yaml`).
2. In Environment, fill the three `sync: false` values: `NEO4J_URI`, `NEO4J_PASSWORD` (and `NEO4J_USER` if not `neo4j`), `SARVAM_API_KEY` (optional).
   Without `NEO4J_URI` the API runs in memory: all data disappears on restart or sleep.
3. Copy the generated `OFFICER_PASSWORD` and `ADMIN_KEY` from Environment. The server refuses to start in production without `OFFICER_PASSWORD`.
4. Open `https://<your-api>.onrender.com/health`. Expect `{"status":"ok", ...}`.

## 2. Web on Vercel
1. Import the repo. Root directory: `packages/web`.
2. Settings > Environment Variables: `VITE_API_URL` = your Render URL, no trailing slash.
3. Redeploy (Vite bakes the value in at build time; changing it later needs a new build).
4. If you forget step 2, the site shows "not connected to the server" instead of silently failing.

## 3. Before a demo
- Render free tier sleeps: open `/health` 1-2 minutes before. For the finale, ping `/health` every 10 minutes from a free uptime monitor.
- Officer portal: Sample data > **Load sample town** (paste `ADMIN_KEY` first). Data is in Neo4j if `NEO4J_URI` is set, else memory.
- `GEOFENCE=false` is set in `render.yaml` so laptops without location still work. For a phone demo of the location check set it to `true` and test on https.
- OTP is simulated: no SMS is sent; each sign-in gets a random code shown on screen as a "demo SMS". Say so.
- After deploying, set CORS_ORIGIN to the Vercel URL, then run `npm run neo4j:smoke` and `npm run sarvam:smoke` with the real keys.
- Phone checks to do once: camera, microphone, location permission, Hindi text, read aloud. None of these have been verified in a real browser.

## 4. Keys that are not verified live yet
`npm run neo4j:smoke` and `npm run sarvam:smoke` (with keys in `.env`) before relying on either on stage.
