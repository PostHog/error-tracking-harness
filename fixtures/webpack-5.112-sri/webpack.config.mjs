import path from 'node:path'
import HtmlWebpackPlugin from 'html-webpack-plugin'
import { SubresourceIntegrityPlugin } from 'webpack-subresource-integrity'
import { PosthogWebpackPlugin } from '@posthog/webpack-plugin'

// The harness passes the plugin options for the case under test as one JSON variable.
const posthogOptions = JSON.parse(process.env.POSTHOG_HARNESS_OPTIONS)

// Subresource Integrity: index.html carries a hash of every script it loads, computed after the
// PostHog plugin has injected its chunk ids. A later rewrite of any chunk would break the page.
export default {
    mode: 'production',
    target: 'web',
    entry: { main: './src/index.js' },
    devtool: false,
    output: {
        path: path.resolve(import.meta.dirname, 'dist'),
        filename: '[name].[contenthash].js',
        chunkFilename: '[name].[contenthash].js',
        crossOriginLoading: 'anonymous',
        clean: true,
    },
    plugins: [new PosthogWebpackPlugin(posthogOptions), new HtmlWebpackPlugin(), new SubresourceIntegrityPlugin()],
}
