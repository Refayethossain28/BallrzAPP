// Store selector: Postgres when DATABASE_URL is set (multi-instance scale),
// SQLite otherwise (zero-config dev/demo). Both expose the same async API.
// Server code imports from here and stays backend-agnostic.

const backend = process.env.DATABASE_URL
  ? await import("./db-postgres.js")
  : await import("./db-sqlite.js");

await backend.init();

export const backendName = process.env.DATABASE_URL ? "postgres" : "sqlite";

export const {
  seedIfEmpty,
  listResources, getResource, setResourceStatus, setResourceConnect, setResourceLocation,
  createRequest, getRequest, listRequests, listRequestsForDriver,
  appendAudit, setStatus, assignResource, recordPayment,
} = backend;
