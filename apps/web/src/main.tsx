import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createRouter, getQueryClient } from "./router.tsx"
import "./styles.css"

const router = createRouter()
const queryClient = getQueryClient()

const root = document.getElementById("root")
if (!root) throw new Error("missing #root element")

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
)
