// Generic HTTP runtime: argv startup, declared readiness and request triggers, process-group
// cleanup even on timeout, early exit, failed requests or browser errors.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { commandArgs } from './commands.mjs'

async function availablePort() {
    const server = createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    return port
}

function killGroup(child, signal) {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}

export async function runHttpLifecycle({ fixture, work, env, tokens = {}, log, visitBrowser }) {
    const runtime = fixture.lifecycle.runtime
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const resolvedTokens = { ...tokens, port }
    const command = commandArgs(runtime.start, resolvedTokens, work, env)
    for (const name of runtime.portEnv ?? []) command.env[name] = String(port)
    for (const name of runtime.hostEnv ?? []) command.env[name] = '127.0.0.1'
    const child = spawn(command.argv[0], command.argv.slice(1), { cwd: command.cwd, env: command.env,
        stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = ''
    child.stdout.on('data', (data) => (output += data))
    child.stderr.on('data', (data) => (output += data))
    let exited = false
    const closed = new Promise((resolve) => {
        child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) })
        child.once('error', (error) => { exited = true; resolve({ code: -1, error }) })
    })
    const requests = []
    try {
        const deadline = Date.now() + (runtime.ready.timeoutMs ?? 90_000)
        let ready = false
        while (Date.now() < deadline && !exited && !ready) {
            try { ready = (await fetch(origin + runtime.ready.path, { signal: AbortSignal.timeout(2000) })).ok } catch { /* still starting */ }
            if (!ready && !exited) await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!ready) return { code: -1, origin, output: `server did not become ready\n${output}`, requests }
        for (const trigger of fixture.lifecycle.triggers.filter((item) => item.kind === 'http')) {
            try {
                const response = await fetch(origin + trigger.path, { signal: AbortSignal.timeout(trigger.timeoutMs ?? 30_000) })
                requests.push({ path: trigger.path, status: response.status, body: (await response.text()).slice(0, 2000) })
            } catch (error) {
                requests.push({ path: trigger.path, status: null, error: error.message })
            }
        }
        // An HTTP handler can flush events asynchronously after sending its response.
        if (requests.length) await new Promise((resolve) => setTimeout(resolve, 1500))
        const page = visitBrowser ? await visitBrowser({ origin, tokens: resolvedTokens }) : null
        return { code: requests.every((request) => request.status === 200) && (!page || page.code === 0) ? 0 : 1,
            origin, output, requests, pageErrors: page?.pageErrors ?? null,
            consoleErrors: page?.consoleErrors ?? null, failedRequests: page?.failedRequests ?? null,
            replayed: page?.replayed ?? null }
    } finally {
        killGroup(child, 'SIGTERM')
        const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 5000)
        await closed
        clearTimeout(timer)
        if (log) writeFileSync(log, output + '\n' + JSON.stringify({ requests }, null, 2) + '\n')
    }
}
