import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two pages: the alert form (/) and the earlier "Try it" concept (/try/).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { story: resolve(__dirname, "index.html"), try: resolve(__dirname, "try/index.html") },
    },
  },
});
