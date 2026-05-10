/** Shared cursor pagination request shape for new and migrated APIs. */
export type PageRequest = {
  cursor?: string;
  limit?: number;
  filters?: Record<string, unknown>;
  sort?: Array<{ field: string; direction: "asc" | "desc" }>;
};

/** Shared cursor pagination response shape for list APIs. */
export type PageResult<TItem> = {
  items: TItem[];
  nextCursor: string | null;
  hasMore: boolean;
};
