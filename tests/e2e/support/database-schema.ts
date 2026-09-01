const managedDatabasePattern = /^e2e_[0-9]+_[0-9]+$/;

export function assertManagedE2EDatabaseName(database: string) {
  if (!managedDatabasePattern.test(database)) {
    throw new Error(
      "E2E_DATABASE_NAME must match e2e_<github-run-id>_<github-run-attempt>.",
    );
  }
}

export function isManagedE2EDatabaseName(database: string) {
  return managedDatabasePattern.test(database);
}

export function withDatabase(connectionString: string, database: string) {
  assertManagedE2EDatabaseName(database);
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  url.searchParams.delete("schema");
  return url.toString();
}
