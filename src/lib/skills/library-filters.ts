export type LibraryFilters = { query: string; collection: string; status: string };

export function parseLibraryFilters(params: URLSearchParams): LibraryFilters {
  const status = params.get("status") ?? "ACTIVE";
  return {
    query: params.get("q") ?? "",
    collection: params.get("collection") ?? "",
    status: ["ACTIVE", "PAUSED", "ARCHIVED", "ALL"].includes(status) ? status : "ACTIVE",
  };
}

export function filterLibraryItems<T extends { title: string; status: string; collectionId: string | null }>(items: T[], filters: LibraryFilters): T[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) =>
    (!query || item.title.toLocaleLowerCase().includes(query)) &&
    (filters.status === "ALL" || item.status === filters.status) &&
    (!filters.collection || (filters.collection === "uncollected" ? item.collectionId === null : item.collectionId === filters.collection)),
  );
}
