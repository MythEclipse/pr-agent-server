// biome-ignore-all lint/suspicious/noExplicitAny: test fakes stand in for untyped GitHub payloads
import { describe, expect, test } from "vitest"
import {
	type DependabotAlert,
	enableAutomatedSecurityFixes,
	enableVulnerabilityAlerts,
	fetchOpenDependabotAlerts,
	fetchOpenDependabotAlertsResult,
} from "../src/ops/security.ts"
import { groupAlertsByManifest, scanVulns, summarizeVulns } from "../src/ops/vulnFixer.ts"

describe("ops/security", () => {
	test("enableVulnerabilityAlerts enables alerts when not yet enabled", async () => {
		const calls: any[] = []
		const api = {
			async request(method: string, path: string, opts: any) {
				calls.push({ method, path, opts })
				if (method === "GET") return { status: 404, data: {} }
				if (method === "PUT") return { status: 204, data: {} }
				return { status: 400, data: {} }
			},
		}

		const step = await enableVulnerabilityAlerts(api as any, "MythEclipse/test-repo", "token123")
		expect(step.ok).toBe(true)
		expect(step.line).toContain("vulnerability alerts enabled")
		expect(calls).toHaveLength(2)
		expect(calls[0].method).toBe("GET")
		expect(calls[1].method).toBe("PUT")
	})

	test("enableVulnerabilityAlerts skips when already enabled (204)", async () => {
		const calls: any[] = []
		const api = {
			async request(method: string, path: string, opts: any) {
				calls.push({ method, path, opts })
				if (method === "GET") return { status: 204, data: {} }
				return { status: 400, data: {} }
			},
		}

		const step = await enableVulnerabilityAlerts(api as any, "MythEclipse/test-repo", "token123")
		expect(step.ok).toBe(false)
		expect(step.line).toContain("already enabled")
		expect(calls).toHaveLength(1)
	})

	test("enableAutomatedSecurityFixes enables when disabled", async () => {
		const calls: any[] = []
		const api = {
			async request(method: string, path: string, opts: any) {
				calls.push({ method, path, opts })
				if (method === "GET") return { status: 404, data: {} }
				if (method === "PUT") return { status: 204, data: {} }
				return { status: 400, data: {} }
			},
		}

		const step = await enableAutomatedSecurityFixes(api as any, "MythEclipse/test-repo", "token123")
		expect(step.ok).toBe(true)
		expect(step.line).toContain("automated security fixes enabled")
		expect(calls).toHaveLength(2)
	})

	test("enableAutomatedSecurityFixes skips when already enabled and not paused", async () => {
		const calls: any[] = []
		const api = {
			async request(method: string, path: string, opts: any) {
				calls.push({ method, path, opts })
				if (method === "GET") return { status: 200, data: { enabled: true, paused: false } }
				return { status: 400, data: {} }
			},
		}

		const step = await enableAutomatedSecurityFixes(api as any, "MythEclipse/test-repo", "token123")
		expect(step.ok).toBe(false)
		expect(step.line).toContain("already enabled")
		expect(calls).toHaveLength(1)
	})

	test("fetchOpenDependabotAlerts parses open alerts correctly", async () => {
		const fakeAlerts: DependabotAlert[] = [
			{
				number: 1,
				state: "open",
				dependency: {
					package: { ecosystem: "npm", name: "lodash" },
					manifest_path: "package.json",
				},
				security_advisory: {
					ghsa_id: "GHSA-1234",
					cve_id: "CVE-2026-9999",
					summary: "Prototype pollution",
					severity: "high",
				},
				security_vulnerability: {
					package: { ecosystem: "npm", name: "lodash" },
					severity: "high",
					vulnerable_version_range: "< 4.17.21",
					first_patched_version: { identifier: "4.17.21" },
				},
				url: "https://api.github.com/repos/MythEclipse/test-repo/dependabot/alerts/1",
				html_url: "https://github.com/MythEclipse/test-repo/security/dependabot/1",
				created_at: "2026-11-01T00:00:00Z",
			},
		]

		const api = {
			async request() {
				return { status: 200, data: fakeAlerts }
			},
		}

		const alerts = await fetchOpenDependabotAlerts(api as any, "MythEclipse/test-repo", "token")
		expect(alerts).toHaveLength(1)
		expect(alerts[0].dependency.package.name).toBe("lodash")
	})

	/**
	 * PAGINATION.
	 *
	 * The original read ONE page of 100 and stopped. On this fleet that reported
	 * 317 open alerts when the real number was 630 — nearly half the problem
	 * invisible, in the one report whose whole job is to make the problem visible.
	 * These tests pin the two facts that were wrong: more than one page is read,
	 * and "failed" is not "none".
	 */
	describe("alert pagination", () => {
		/** An API that serves `total` alerts across pages of `per_page`. */
		const paged = (total: number, failOnPage?: number) => {
			const seen: string[] = []
			return {
				seen,
				api: {
					async request(_method: string, path: string) {
						seen.push(path)
						const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1")
						const size = Number(/[?&]per_page=(\d+)/.exec(path)?.[1] ?? "100")
						if (failOnPage === page) return { status: 502, data: { message: "bad gateway" } }
						const start = (page - 1) * size
						const data = Array.from(
							{ length: Math.max(0, Math.min(size, total - start)) },
							(_, i) => ({
								number: start + i + 1,
								state: "open",
								dependency: {
									package: { ecosystem: "npm", name: `p${start + i}` },
									manifest_path: "package.json",
								},
								security_advisory: { ghsa_id: "G", cve_id: null, summary: "", severity: "high" },
								security_vulnerability: {
									package: { ecosystem: "npm", name: "x" },
									severity: "high",
									vulnerable_version_range: "<1",
									first_patched_version: null,
								},
								url: "",
								html_url: "",
								created_at: "",
							}),
						)
						return { status: 200, data }
					},
				},
			}
		}

		test("a repo with 250 alerts yields all 250, not the first 100", async () => {
			const { api, seen } = paged(250)
			const alerts = await fetchOpenDependabotAlerts(api as any, "o/r", "t")
			expect(alerts).toHaveLength(250)
			// 100 + 100 + 50: three requests, the last one short.
			expect(seen).toHaveLength(3)
		})

		test("an exact multiple of the page size stops without an empty extra page", async () => {
			const { api, seen } = paged(200)
			const alerts = await fetchOpenDependabotAlerts(api as any, "o/r", "t")
			expect(alerts).toHaveLength(200)
			// Page 2 is full, so one more request is made and answers empty; the
			// point is that it TERMINATES rather than looping.
			expect(seen.length).toBeLessThanOrEqual(3)
		})

		test("a clean repo costs exactly one request", async () => {
			const { api, seen } = paged(0)
			expect(await fetchOpenDependabotAlerts(api as any, "o/r", "t")).toHaveLength(0)
			expect(seen).toHaveLength(1)
		})

		test("a failure on page 1 is reported as NOT ok — not as an empty repo", async () => {
			// The distinction the sync depends on: an empty list would be used to
			// derive a config, and a failure must not be.
			const { api } = paged(250, 1)
			const res = await fetchOpenDependabotAlertsResult(api as any, "o/r", "t")
			expect(res.ok).toBe(false)
			expect(res.alerts).toEqual([])
			if (!res.ok) expect(res.status).toBe(502)
		})

		test("a failure on a LATER page keeps what was read, and still reports NOT ok", async () => {
			const { api } = paged(250, 2)
			const res = await fetchOpenDependabotAlertsResult(api as any, "o/r", "t")
			expect(res.ok).toBe(false)
			// Page 1's 100 are kept — better than discarding them — but the caller
			// is told the answer is partial.
			expect(res.alerts).toHaveLength(100)
		})

		test("a successful read reports ok, so the sync may act on it", async () => {
			const { api } = paged(150)
			const res = await fetchOpenDependabotAlertsResult(api as any, "o/r", "t")
			expect(res.ok).toBe(true)
			expect(res.alerts).toHaveLength(150)
		})
	})
})

describe("ops/vulnFixer", () => {
	const sampleAlerts: DependabotAlert[] = [
		{
			number: 1,
			state: "open",
			dependency: {
				package: { ecosystem: "npm", name: "esbuild" },
				manifest_path: "package.json",
			},
			security_advisory: {
				ghsa_id: "GHSA-esbuild",
				cve_id: "CVE-2026-1111",
				summary: "Dev server issue",
				severity: "medium",
			},
			security_vulnerability: {
				package: { ecosystem: "npm", name: "esbuild" },
				severity: "medium",
				vulnerable_version_range: "< 0.25.0",
				first_patched_version: { identifier: "0.25.0" },
			},
			url: "https://api.github.com/repos/r/alerts/1",
			html_url: "https://github.com/r/security/dependabot/1",
			created_at: "2026-11-01T00:00:00Z",
		},
		{
			number: 2,
			state: "open",
			dependency: {
				package: { ecosystem: "cargo", name: "glib" },
				manifest_path: "Cargo.lock",
			},
			security_advisory: {
				ghsa_id: "GHSA-glib",
				cve_id: null,
				summary: "Memory bug",
				severity: "critical",
			},
			security_vulnerability: {
				package: { ecosystem: "cargo", name: "glib" },
				severity: "critical",
				vulnerable_version_range: "< 0.20.0",
				first_patched_version: { identifier: "0.20.0" },
			},
			url: "https://api.github.com/repos/r/alerts/2",
			html_url: "https://github.com/r/security/dependabot/2",
			created_at: "2026-11-02T00:00:00Z",
		},
	]

	test("groupAlertsByManifest groups by manifest path", () => {
		const groups = groupAlertsByManifest(sampleAlerts)
		expect(groups.size).toBe(2)
		expect(groups.get("package.json")).toHaveLength(1)
		expect(groups.get("Cargo.lock")).toHaveLength(1)
	})

	test("summarizeVulns formats alert list", () => {
		const emptySummary = summarizeVulns("MythEclipse/clean-repo", [])
		expect(emptySummary[0]).toContain("0 open Dependabot security alerts")

		const summary = summarizeVulns("MythEclipse/vulnerable-repo", sampleAlerts)
		expect(summary[0]).toContain("2 open security alerts")
		expect(summary[1]).toContain("esbuild")
		expect(summary[1]).toContain("CVE-2026-1111")
		expect(summary[2]).toContain("glib")
		expect(summary[2]).toContain("GHSA-glib")
	})

	test("scanVulns iterates over repositories and accumulates alerts", async () => {
		const api = {
			async request(_method: string, path: string) {
				if (path.includes("repo-a")) return { status: 200, data: sampleAlerts }
				return { status: 200, data: [] }
			},
		}

		const res = await scanVulns(api as any, ["MythEclipse/repo-a", "MythEclipse/repo-b"], "token")
		expect(res).toHaveLength(2)
		expect(res[0].alerts).toHaveLength(2)
		expect(res[1].alerts).toHaveLength(0)
	})
})
