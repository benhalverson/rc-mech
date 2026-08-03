# Serve the dashboard and API from one Worker

**Status:** accepted

RC Mech serves the Angular dashboard as Worker static assets and exposes the Hono API from the same Cloudflare Worker. This keeps browser authentication same-origin, avoids a separately deployed frontend/API boundary, and fits the application's small operator-focused surface; the tradeoff is that frontend and API releases share one deployment.
