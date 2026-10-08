import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Dev proxies to the API so cookies stay same-origin. In production Hono
// serves this build from WEB_DIST_PATH and falls through to index.html.
const API_PORT = process.env.VITE_API_PORT ?? "4023"

export default defineConfig({
	// Order is required: the router plugin generates routeTree.gen.ts and must
	// run BEFORE any JSX transform, or it sees the routes too late.
	plugins: [tanstackRouter({ autoCodeSplitting: true }), tailwindcss(), react()],
	resolve: {
		alias: { "#": new URL("./src", import.meta.url).pathname },
	},
	server: {
		port: 5173,
		proxy: {
			"/rpc": `http://localhost:${API_PORT}`,
			"/api/auth": `http://localhost:${API_PORT}`,
			"/api": `http://localhost:${API_PORT}`,
		},
	},
	build: {
		outDir: "dist",
		rollupOptions: {
			output: {
				// Vite 8 bundles with Rolldown, which only accepts manualChunks
				// as a function rather than a map.
				manualChunks(id: string) {
					if (id.includes("@tanstack/react-query")) return "tanstack-query"
					if (id.includes("@tanstack/react-router")) return "tanstack-router"
					if (id.includes("react-dom")) return "react-dom"
					return undefined
				},
			},
		},
	},
})
