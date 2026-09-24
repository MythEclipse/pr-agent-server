// GitHub barrel — preserves the pre-split `./github` public surface.
// client.ts owns App auth + the token cache, provider.ts the PR operations.

export * from "./client";
export * from "./provider";
