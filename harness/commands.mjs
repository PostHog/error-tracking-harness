// Portable argv commands. Only documented tokens are expanded; no implicit shell evaluation.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

export const TOKENS = new Set(['port', 'host', 'work', 'releaseVersion', 'cliPath'])
const tokenPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/g

export function expand(value, tokens) {
    return value.replace(tokenPattern, (_, name) => {
        if (!TOKENS.has(name)) throw new Error(`Unknown command token {${name}}`)
        if (tokens[name] === undefined || tokens[name] === null) throw new Error(`Command token {${name}} is unavailable`)
        return String(tokens[name])
    })
}

export function commandArgs(command, tokens, work, env) {
    const argv = command.argv.map((arg) => expand(arg, tokens))
    const cwd = path.resolve(work, expand(command.cwd ?? '.', tokens))
    const extra = Object.fromEntries(Object.entries(command.env ?? {}).map(([key, value]) => [key, expand(value, tokens)]))
    return { argv, cwd, env: { ...env, ...extra }, timeout: command.timeoutMs ?? 180_000 }
}

export function runCommand(command, { work, tokens = {}, env, log, input, timeout } = {}) {
    const resolved = commandArgs(command, tokens, work, env)
    return new Promise((resolve, reject) => {
        const child = spawn(resolved.argv[0], resolved.argv.slice(1), {
            cwd: resolved.cwd, env: resolved.env,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        })
        if (input !== undefined) child.stdin.end(input)
        let output = ''
        child.stdout.on('data', (data) => (output += data))
        child.stderr.on('data', (data) => (output += data))
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout ?? resolved.timeout)
        child.once('error', (error) => { clearTimeout(timer); reject(error) })
        child.once('close', (code, signal) => {
            clearTimeout(timer)
            if (log) writeFileSync(log, output)
            resolve({ code: code ?? -1, signal, output })
        })
    })
}
