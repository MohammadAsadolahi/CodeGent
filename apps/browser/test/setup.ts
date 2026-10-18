import { afterEach } from 'vitest'

// jsdom has no layout engine, so `innerText` is missing. Approximate it with `textContent`, which
// is exact for the single-line / <br>-free fixtures used in unit tests. Behaviour that depends on
// real layout is covered by the browser end-to-end tests instead.
if (!('innerText' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? ''
    },
    set(this: HTMLElement, value: string) {
      this.textContent = value
    }
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  document.title = ''
})
