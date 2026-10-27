// Fail before a long matrix run when a case or fixture has a typo or an invalid combination.
import { TOKENS } from './commands.mjs'
const FIXTURE = 'bundler cliSelection distGlobs distIgnore extends immutable integrity layout lifecycle minCli mode nodeModules optionalIds plugin tags throws version volatileChunks'.split(' ')
const CASE = 'cli description env expect git minCli mode options releases server'.split(' ')
const EXPECT = 'build chunkIds cli events eventsBy maps mapsBy metadataFree release reuploads symbols transport'.split(' ')
// Case applicability is independent of fixture selection tags and execution drivers.
const APPLICABILITY = /^[a-z]+(?:-[a-z0-9]+)*$/
const validApplicability = (value) => typeof value === 'string' && APPLICABILITY.test(value)
const MAPS = ['deleted', 'kept-hidden', 'kept-visible']
const EXPECT_VALUES = {
    build: ['green'], cli: ['green'], chunkIds: ['all', 'any'],
    maps: MAPS, symbols: ['all'], events: ['resolved'],
    transport: ['PUT', 'POST'],
}

function keys(object, allowed, label) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label}: expected an object`)
    for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`)
}

function validateCommand(command, label) {
    keys(command, ['argv', 'cwd', 'env', 'timeoutMs'], label)
    if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some((arg) => typeof arg !== 'string' || !arg)) throw new Error(`${label}: requires nonempty argv`)
    if (command.cwd !== undefined && (typeof command.cwd !== 'string' || !command.cwd)) throw new Error(`${label}: invalid cwd`)
    if (command.env !== undefined) {
        keys(command.env, Object.keys(command.env), `${label}.env`)
        if (Object.keys(command.env).some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error(`${label}: invalid env name`)
        if (Object.values(command.env).some((value) => typeof value !== 'string')) throw new Error(`${label}: env values must be strings`)
    }
    if (command.timeoutMs !== undefined && (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1)) throw new Error(`${label}: invalid timeoutMs`)
    for (const value of [...command.argv, command.cwd ?? '', ...Object.values(command.env ?? {})]) {
        for (const [, token] of value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) if (!TOKENS.has(token)) throw new Error(`${label}: unknown command token {${token}}`)
    }
}

export function validateLifecycle(lifecycle, name, throws) {
    keys(lifecycle, ['workspace', 'build', 'outputs', 'runtime', 'triggers'], `fixture ${name} lifecycle`)
    const label = `fixture ${name} lifecycle`
    keys(lifecycle.workspace, ['adapter', 'command'], `${label}.workspace`)
    if (!['node-modules', 'command'].includes(lifecycle.workspace.adapter)) throw new Error(`${label}: invalid workspace adapter`)
    if (lifecycle.workspace.adapter === 'command') validateCommand(lifecycle.workspace.command, `${label}.workspace.command`)
    if (lifecycle.workspace.adapter === 'node-modules' && lifecycle.workspace.command) throw new Error(`${label}: node-modules adapter cannot declare a command`)
    validateCommand(lifecycle.build, `${label}.build`)
    keys(lifecycle.outputs, ['root'], `${label}.outputs`)
    if (typeof lifecycle.outputs.root !== 'string' || !lifecycle.outputs.root || lifecycle.outputs.root.startsWith('/') || lifecycle.outputs.root.split('/').includes('..')) throw new Error(`${label}: invalid outputs.root`)
    keys(lifecycle.runtime, ['driver', 'start', 'ready', 'browser', 'serve', 'portEnv', 'hostEnv'], `${label}.runtime`)
    const driver = lifecycle.runtime.driver
    if (!['process', 'http', 'browser', 'none'].includes(driver)) throw new Error(`${label}: invalid runtime driver`)
    if (driver === 'http') {
        validateCommand(lifecycle.runtime.start, `${label}.runtime.start`)
        keys(lifecycle.runtime.ready, ['path', 'timeoutMs'], `${label}.runtime.ready`)
        if (!lifecycle.runtime.ready.path?.startsWith('/')) throw new Error(`${label}: HTTP readiness requires an absolute path`)
        if (lifecycle.runtime.ready.timeoutMs !== undefined && (!Number.isInteger(lifecycle.runtime.ready.timeoutMs) || lifecycle.runtime.ready.timeoutMs < 1)) throw new Error(`${label}: invalid HTTP readiness timeout`)
        for (const field of ['portEnv', 'hostEnv']) {
            const names = lifecycle.runtime[field]
            if (names !== undefined && (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))) throw new Error(`${label}: invalid ${field}`)
        }
        if (lifecycle.runtime.browser) {
            keys(lifecycle.runtime.browser, ['page', 'urlPrefix', 'root'], `${label}.runtime.browser`)
            if (!lifecycle.runtime.browser.page?.startsWith('/') || !lifecycle.runtime.browser.root) throw new Error(`${label}: invalid attached browser mapping`)
        }
    }
    if (driver === 'browser' && (typeof lifecycle.runtime.serve !== 'string' || !lifecycle.runtime.serve || lifecycle.runtime.serve.startsWith('/') || lifecycle.runtime.serve.split('/').includes('..'))) throw new Error(`${label}: static browser requires a workspace-relative served root`)
    if (driver !== 'http' && (lifecycle.runtime.start || lifecycle.runtime.ready || lifecycle.runtime.browser)) throw new Error(`${label}: ${driver} cannot declare HTTP startup`)
    if (!Array.isArray(lifecycle.triggers) || (driver !== 'none' && !lifecycle.triggers.length)) throw new Error(`${label}: requires triggers`)
    const covered = new Set()
    for (const [index, trigger] of lifecycle.triggers.entries()) {
        const id = `${label}.triggers[${index}]`
        keys(trigger, ['kind', 'command', 'path', 'page', 'expects', 'pageErrors', 'timeoutMs'], id)
        if (trigger.pageErrors !== undefined && (trigger.kind !== 'browser' || !Array.isArray(trigger.pageErrors) || !trigger.pageErrors.length || trigger.pageErrors.some((message) => typeof message !== 'string' || !message))) throw new Error(`${id}: invalid expected page errors`)
        if (trigger.timeoutMs !== undefined && (!Number.isInteger(trigger.timeoutMs) || trigger.timeoutMs < 1)) throw new Error(`${id}: invalid timeoutMs`)
        if (!Array.isArray(trigger.expects) || !trigger.expects.length || trigger.expects.some((expected) => !(expected in throws))) throw new Error(`${id}: unknown or missing expected throws`)
        for (const expected of trigger.expects) covered.add(expected)
        if (trigger.kind === 'process' && driver === 'process') validateCommand(trigger.command, `${id}.command`)
        else if (trigger.kind === 'http' && driver === 'http' && trigger.path?.startsWith('/')) { /* request */ }
        else if (trigger.kind === 'browser' && ['http', 'browser'].includes(driver) && trigger.page?.startsWith('/') && (driver !== 'http' || lifecycle.runtime.browser)) { /* page */ }
        else throw new Error(`${id}: invalid trigger for ${driver}`)
    }
    if (Object.keys(throws).some((name) => !covered.has(name))) throw new Error(`${label}: triggers do not cover every expected throw`)
}

export function validateFixture(config, name) {
    keys(config, FIXTURE, `fixture ${name}`)
    if (!validApplicability(config.mode ?? 'plugin')) throw new Error(`fixture ${name}: invalid applicability label ${config.mode}`)
    if (!config.throws || !config.bundler) throw new Error(`fixture ${name}: requires bundler and throws`)
    if (!Array.isArray(config.tags) || !config.tags.length || config.tags.some((tag) => typeof tag !== 'string' || !/^[a-z]+(?:-[a-z0-9]+)*$/.test(tag)) || new Set(config.tags).size !== config.tags.length) throw new Error(`fixture ${name}: requires unique lowercase kebab-case tags`)
    if ((config.mode ?? 'plugin') !== 'cli' && config.lifecycle?.workspace?.adapter === 'node-modules' && !config.plugin) throw new Error(`fixture ${name}: node-modules workspace requires plugin`)
    if (config.mode === 'cli' && config.plugin) throw new Error(`fixture ${name}: cli mode cannot use a plugin`)
    validateLifecycle(config.lifecycle, name, config.throws)
}

export function validateCase(config, name) {
    keys(config, CASE, `case ${name}`)
    if (!validApplicability(config.mode ?? 'plugin')) throw new Error(`case ${name}: invalid applicability label ${config.mode}`)
    if (config.releases !== undefined && (!Number.isInteger(config.releases) || config.releases < 1)) throw new Error(`case ${name}: releases must be a positive integer`)
    if (config.cli && config.mode !== 'cli') throw new Error(`case ${name}: cli steps require cli mode`)
    if (config.options?.sourcemaps?.releaseMode && config.options.sourcemaps.releaseMode !== 'event') throw new Error(`case ${name}: only event release mode is conformance`)
    if ((config.options?.sourcemaps?.releaseName === null || config.options?.sourcemaps?.releaseVersion === null) && !config.git && !config.env) throw new Error(`case ${name}: a release is required`)
    if (config.expect?.reuploads && Object.keys(config.expect.reuploads).some((key) => key === 'minPlugin' || key === 'minCli')) throw new Error(`case ${name}: version-gated expectations are not conformance`)
    if (config.expect) {
        keys(config.expect, EXPECT, `case ${name} expect`)
        for (const [field, allowed] of Object.entries(EXPECT_VALUES)) {
            const value = config.expect[field]
            if (value === undefined) continue
            const choices = typeof value === 'string' ? [value] : Object.values(value)
            if (choices.some((choice) => !allowed.includes(choice))) throw new Error(`case ${name}: invalid expect.${field}`)
        }
        if (config.expect.mapsBy && Object.values(config.expect.mapsBy).some((value) => !MAPS.includes(value))) {
            throw new Error(`case ${name}: invalid expect.mapsBy`)
        }
        if (config.expect.eventsBy !== undefined) {
            const by = config.expect.eventsBy
            if (!by || typeof by !== 'object' || Array.isArray(by)) throw new Error(`case ${name}: invalid expect.eventsBy`)
            for (const [throwName, value] of Object.entries(by)) {
                if (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value))) {
                    throw new Error(`case ${name}: invalid expect.eventsBy.${throwName}`)
                }
                const choices = typeof value === 'string' ? [value] : Object.values(value)
                if (choices.some((choice) => !EXPECT_VALUES.events.includes(choice))) {
                    throw new Error(`case ${name}: invalid expect.eventsBy.${throwName}`)
                }
            }
        }
    }
    if (config.cli) {
        keys(config.cli, ['command', 'input'], `case ${name} cli`)
        if (config.cli.command && !['process', 'inject-upload', 'upload'].includes(config.cli.command)) throw new Error(`case ${name}: invalid cli command`)
        if (config.cli.input && !['directory', 'stdin'].includes(config.cli.input)) throw new Error(`case ${name}: invalid cli input`)
    }
    if (config.server) {
        keys(config.server, ['presign'], `case ${name} server`)
        if (config.server.presign && !['both', 'post-only', 'put-only'].includes(config.server.presign)) throw new Error(`case ${name}: invalid presign`)
    }
    if (config.git) keys(config.git, ['remote', 'worktree'], `case ${name} git`)
}
