// A browser entry: the SRI plugin hashes this chunk and the lazy one into index.html.
import { explode } from './boom.js'

document.querySelector('#app').textContent = 'error tracking harness'
try {
    explode('entry chunk')
} catch (error) {
    console.error(error)
}
import('./lazy.js').then(({ lazyExplode }) => {
    try {
        lazyExplode()
    } catch (error) {
        console.error(error)
    }
})
