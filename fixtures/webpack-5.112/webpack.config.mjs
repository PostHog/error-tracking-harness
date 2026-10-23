import path from 'node:path'
import { PosthogWebpackPlugin } from '@posthog/webpack-plugin'

// The harness passes the plugin options for the case under test as one JSON variable.
const posthogOptions = JSON.parse(process.env.POSTHOG_HARNESS_OPTIONS)

export default {
    mode: 'production',
    target: 'node',
    entry: { main: './src/index.js' },
    devtool: false,
    externals: { 'posthog-node': 'commonjs posthog-node' },
    output: {
        path: path.resolve(import.meta.dirname, 'dist'),
        filename: '[name].js',
        chunkFilename: '[name].[contenthash].js',
        clean: true,
    },
    plugins: [new PosthogWebpackPlugin(posthogOptions)],
}
