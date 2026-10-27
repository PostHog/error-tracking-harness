import { defineConfig } from 'vite'
import posthog from '@posthog/rollup-plugin'
import { sri } from 'vite-plugin-sri3'

// The harness passes the plugin options for the case under test as one JSON variable.
const posthogOptions = JSON.parse(process.env.POSTHOG_HARNESS_OPTIONS)

// Subresource Integrity: index.html carries a hash of every script it loads, computed after the
// PostHog plugin has injected its chunk ids. A later rewrite of any chunk would break the page.
export default defineConfig({
    plugins: [posthog(posthogOptions), sri()],
    build: { outDir: 'dist', emptyOutDir: true, minify: true },
})
