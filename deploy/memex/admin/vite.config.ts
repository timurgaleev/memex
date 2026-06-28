import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base '/admin/' so the built asset URLs resolve under the server's /admin mount.
export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  build: { outDir: "dist", emptyOutDir: true },
});
