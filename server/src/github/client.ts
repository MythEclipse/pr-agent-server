// GitHub App auth — JWT (app) + installation token, cached.
// Split out of the old src/github.ts (Task 3).
//
// NOTE: with Bun we must NOT pass a Promise-returning `auth()` to Octokit —
// @octokit/core's token authStrategy expects a STRING and calls .then on the
// returned value. Instead we pass a custom authStrategy whose hook injects a
// `Bearer <installationToken>` header synchronously from a token the provider
// has already prefetched (see GitHubProvider.ensureToken).

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "../config";

export type TokenGetter = () => string;

/** Sync auth hook: always attaches the cached installation token, so no
 *  request can leave without an `authorization` header (bug S10). */
export function buildAuthHook(getToken: TokenGetter) {
  return (
    request: (opts: { headers: Record<string, string> }) => Promise<unknown>,
    options: { headers?: Record<string, string> },
  ) => {
    options.headers = options.headers ?? {};
    options.headers.authorization = `Bearer ${getToken()}`;
    return request(options as { headers: Record<string, string> });
  };
}

/** Refresh the installation token when less than this much of its lifetime
 *  remains (preserves the original 60s-early-refresh semantics). */
const REFRESH_MARGIN_MS = 60_000;

/** GitHub App authentication: mints app JWTs (for installation discovery) and
 *  caches the installation token with its expiry. */
export class AppAuthClient {
  private appAuth: ReturnType<typeof createAppAuth>;
  private appClient: Octokit;
  private token: string | null = null;
  private expiresAt = 0;

  constructor(
    private cfg: Config,
    privateKeyPem: string,
  ) {
    this.appAuth = createAppAuth({
      appId: cfg.github.appId,
      privateKey: privateKeyPem,
    });
    // App-level client: uses JWT (type: 'app'), only for discovering
    // installation id (GET /repos/{owner}/{repo}/installation needs app JWT).
    this.appClient = new Octokit({
      baseUrl: cfg.github.baseUrl,
      authStrategy: () => ({
        hook: async (request: any, options: Record<string, any>) => {
          const jwtAuth = await this.appAuth({ type: "app" });
          options.headers = options.headers ?? {};
          options.headers.authorization = `Bearer ${jwtAuth.token}`;
          options.headers["x-github-api-version"] = "2022-11-28";
          return request(options);
        },
      }),
      request: { timeout: 20_000 },
    });
  }

  /** Installation-level Octokit: the sync hook reads the token cached by
   *  `installationToken()`, so callers MUST prefetch it first. */
  createInstallationOctokit(): Octokit {
    return new Octokit({
      baseUrl: this.cfg.github.baseUrl,
      authStrategy: () => ({
        hook: buildAuthHook(() => {
          if (!this.token) {
            throw new Error(
              "installation token not prefetched — call AppAuthClient.installationToken() first",
            );
          }
          return this.token;
        }),
      }),
      throttle: {
        enabled: true,
        onRateLimit: () => true,
        onSecondaryRateLimit: () => true,
      },
      request: { timeout: 20_000 },
    });
  }

  /** Cached installation token for `owner/repo`, refreshed 60s before expiry. */
  async installationToken(owner: string, repo: string): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return this.token;
    }
    const installationId = await this.discoverInstallationId(owner, repo);
    if (installationId === null) {
      throw new Error(`No GitHub App installation for ${owner}/${repo}`);
    }
    const auth = await this.appAuth({ type: "installation", installationId });
    this.token = auth.token;
    this.expiresAt = new Date(auth.expiresAt).getTime();
    return this.token;
  }

  /** Resolve the installation id: repo-scoped lookup, then list-and-filter. */
  private async discoverInstallationId(owner: string, repo: string): Promise<number | null> {
    try {
      const { data } = await this.appClient.request("GET /repos/{owner}/{repo}/installation", {
        owner,
        repo,
      });
      return (data as { id: number }).id;
    } catch {
      // fall back to listing app installations and filtering by repo
      const { data } = await this.appClient.request("GET /app/installations", { per_page: 100 });
      for (const inst of data as { id: number }[]) {
        try {
          const resp = await this.appClient.request("GET /installation/repositories", {
            per_page: 100,
          });
          const found = (
            resp.data as unknown as { repositories: { full_name?: string }[] }
          ).repositories.some((r) => r.full_name === `${owner}/${repo}`);
          if (found) return inst.id;
        } catch {
          // skip
        }
      }
      return null;
    }
  }
}
