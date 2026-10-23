import { defineConfig } from 'vite'
import posthog from '@posthog/rollup-plugin'

// The harness passes the plugin options for the case under test as one JSON variable.
const posthogOptions = JSON.parse(process.env.POSTHOG_HARNESS_OPTIONS)

export default defineConfig({
    plugins: [posthog(posthogOptions)],
    ssr: { external: ['posthog-node'] },
    build: {
        ssr: 'src/index.js',
        outDir: 'dist',
        emptyOutDir: true,
        minify: true,
        rollupOptions: {
            output: { format: 'es', entryFileNames: 'main.mjs', chunkFileNames: '[name]-[hash].mjs' },
        },
    },
})
