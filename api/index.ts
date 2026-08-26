// Vercel Function entry point. Vercel auto-detects any file under api/ as a
// serverless function and passes it standard (req, res) — an Express app
// instance works directly as that handler. All actual routing still happens
// inside src/index.ts; this file only exists because Vercel needs something
// under api/ to build, and the app.listen()/migrations block there is
// already guarded by `if (!process.env.VERCEL)` so it's a no-op here.
import app from "../src/index";

export default app;
