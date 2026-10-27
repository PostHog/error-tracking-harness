export function explodeUncaught() {
    throw new Error('boom from uncaught exception') // harness:throw:uncaught
}
