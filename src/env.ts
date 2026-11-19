// Loads .env (if present) before other modules read process.env.
// Import this first in every entrypoint.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // no .env — defaults apply
}
