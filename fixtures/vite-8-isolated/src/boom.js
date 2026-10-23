export function explode(where) {
    const detail = { where, at: Date.now() }
    throw new Error(`boom from ${detail.where}`) // harness:throw:entry
}
