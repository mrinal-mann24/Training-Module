// Liveness probe for the Docker healthcheck and uptime monitoring.
// Deliberately touches nothing (no DB, no LLM) — it answers "is the
// Next.js server process up", not "are the dependencies healthy".
export function GET() {
  return Response.json({ status: 'ok' });
}
