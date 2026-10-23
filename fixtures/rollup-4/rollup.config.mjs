import posthog from '@posthog/rollup-plugin'

// The harness passes the plugin options for the case under test as one JSON variable.
const posthogOptions = JSON.parse(process.env.POSTHOG_HARNESS_OPTIONS)

export default {
    input: { main: 'src/index.js' },
    external: ['posthog-node'],
    plugins: [posthog(posthogOptions)],
    output: {
        dir: 'dist',
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name]-[hash].mjs',
    },
}
