// The typed oRPC client.
//
// TClient is imported as a TYPE ONLY (skill §13.1) — the backend runtime
// never reaches the browser; every call below goes over HTTP to /rpc.

import { createORPCClient } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import { createTanstackQueryUtils } from "@orpc/tanstack-query"
import type { TClient } from "@pr-agent/api"

const link = new RPCLink({
	url: `${import.meta.env.VITE_API_URL ?? ""}/rpc`,
	fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
})

export const client: TClient = createORPCClient(link)
export const orpc = createTanstackQueryUtils(client)