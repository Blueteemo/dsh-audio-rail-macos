/**
 * dsh-audio-rail-macos — browser half: subscribes to the host's SSE spectrum
 * stream and makes the conversation turn-rail marks (the quick-jump anchors on
 * the right edge of the chat page) pulse with the music, like a spectrum
 * analyzer rotated 90°. Each mark owns one frequency band; bass sits at the
 * bottom.
 *
 * Host DOM contract (dsh-client-ui-chat TurnNavigator): buttons carrying a
 * class token ending in `_mark` live directly inside a container whose class
 * token ends in `_marks`, ordered by their `data-index`. The host draws each
 * anchor as a fixed 20px ::before bar whose STATE length is a scaleX factor
 * (.6 default, .4 unloaded, .9 preview, 1 active) on the transform, so this
 * plugin multiplies that state factor by the audio pulse instead of
 * overriding widths — host states keep their exact look between beats.
 *
 * Pure DOM effect: no slots, no services. Degrades to a no-op when the host
 * route is unreachable, the page has no turn rail, or the user prefers
 * reduced motion.
 *
 * DOM contract verified against dsh-client-ui-chat 0.1.6-alpha.6 (fixed-pitch
 * virtual rail, 20px bar, scaleX state factors). The rail is virtualized, so
 * marks are re-scanned instead of bound once.
 *
 * Client approach adapted from dsh-audio-rail (MIT, © Lingwuxin).
 */
window.__ModuleLoader__.load({
  id: 'dsh-audio-rail-macos',
  factory() {
    const SCALE_VAR = '--dsh-audio-rail-scale'
    const PRODUCT_CAP = 1.3 // 20px bar × 1.3 = 26px stays inside the 28px frame
    // The host spends 0.4–1.0 of scaleX on STATE (unloaded/default/preview/active),
    // which leaves the active mark only 0.3 of headroom under the 1.3 ceiling — it
    // visibly stops pulsing. So state is compressed into a narrow band and every
    // mark gets the same additive pulse on top; the colour still marks the active
    // turn, and all bars move by the same amount of pixels.
    const BASE_MIN = 0.45
    const BASE_MAX = 0.8
    const PULSE = 0.5
    const ATTACK = 0.5
    const RELEASE = 0.2
    const CSS =
      '[class*="_marks"] [class*="_mark"]::before{' +
      'transform:translateY(-50%) scaleX(var(--dsh-audio-rail-scale,.6));' +
      'transform-origin:100%;' +
      // The host eases transform over .14s; at a 33ms frame rate that lag reads
      // as mush, so transform is left instant (rAF already smooths) while the
      // colour transitions the host owns keep running.
      'transition:background-color .14s;' +
      '}'

    /**
     * The host's state scaleX for one mark button, read from its classes, then
     * compressed into [BASE_MIN, BASE_MAX] so every state keeps room to pulse.
     */
    function stateBase(el) {
      const tokens = typeof el.className === 'string' ? el.className.split(/\s+/) : []
      let state = 0.6
      for (const token of tokens) {
        if (token.endsWith('_markActive')) { state = 1.0; break }
        if (token.endsWith('_markPreview')) state = 0.9
        else if (token.endsWith('_markUnloaded')) state = 0.4
      }
      // Host states live in 0.4 .. 1.0; normalise that onto our narrow band.
      const level = Math.max(0, Math.min(1, (state - 0.4) / 0.6))
      return BASE_MIN + level * (BASE_MAX - BASE_MIN)
    }

    return {
      apply(ctx) {
        ctx.effect(() => {
          if (typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return () => {}
          }

          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-audio-rail-macos'
          style.textContent = CSS
          document.head.appendChild(style)

          /** @type {{el: HTMLElement, base: number, index: number, count: number, v: number, applied: number}[]} */
          let marks = []
          /** @type {number[] | null} */
          let bands = null
          let rafId = 0
          let refreshTimer = 0

          const source = new EventSource('/audio-rail/events')
          source.addEventListener('frame', (event) => {
            try {
              const frame = JSON.parse(/** @type {MessageEvent} */(event).data)
              if (frame && Array.isArray(frame.bands)) bands = frame.bands
            } catch { /* malformed push */ }
          })

          function refreshMarks() {
            /** @type {{el: HTMLElement, index: number, count: number}[]} */
            const found = []
            document.querySelectorAll('[class*="_marks"]').forEach((container) => {
              /** @type {HTMLElement[]} */
              const rail = []
              container.querySelectorAll('[class*="_mark"]').forEach((el) => {
                if (!(el instanceof HTMLElement)) return
                const tokens = typeof el.className === 'string' ? el.className.split(/\s+/) : []
                if (!tokens.some((name) => name.endsWith('_mark'))) return
                rail.push(el)
              })
              // The rail's own virtual index orders marks top -> bottom.
              rail.sort((a, b) => parseInt(a.dataset.index || '0', 10) - parseInt(b.dataset.index || '0', 10))
              rail.forEach((el, index) => found.push({ el, index, count: rail.length }))
            })
            const previous = new Map(marks.map((m) => [m.el, m]))
            marks = found.map(({ el, index, count }) => {
              const base = stateBase(el)
              const old = previous.get(el)
              if (old) { old.base = base; old.index = index; old.count = count; return old }
              return { el, base, index, count, v: 0, applied: -1 }
            })
            observeRail()
          }

          function tick() {
            rafId = requestAnimationFrame(tick)
            const bandCount = bands ? bands.length : 0
            for (const m of marks) {
              // Band 0 (bass) goes to the bottom mark of its rail.
              const target = bandCount > 0 && m.count > 0
                ? bands[Math.floor(((m.count - 1 - m.index) / m.count) * bandCount)] || 0
                : 0
              m.v += (target - m.v) * (target > m.v ? ATTACK : RELEASE)
              const scale = Math.min(m.base + m.v * PULSE, PRODUCT_CAP)
              if (Math.abs(scale - m.applied) > 0.004) {
                m.applied = scale
                m.el.style.setProperty(SCALE_VAR, scale.toFixed(3))
              }
            }
          }

          function scheduleRefresh() {
            if (refreshTimer !== 0) return
            refreshTimer = window.setTimeout(() => { refreshTimer = 0; refreshMarks() }, 300)
          }

          // Watch only the rail container, not <body>: streaming answers rewrite
          // the transcript every frame, and observing the whole subtree would
          // queue a callback (and a full re-scan) for every one of those edits.
          /** @type {MutationObserver | undefined} */
          let railObserver
          /** @type {Element | undefined} */
          let railObserverTarget

          function observeRail() {
            const container = document.querySelector('[class*="_marks"]')
            if (container === null || container === railObserverTarget) return
            railObserver?.disconnect()
            railObserverTarget = container
            railObserver = new MutationObserver(scheduleRefresh)
            railObserver.observe(container, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['class'],
            })
          }

          // A rail can appear after a slow first render; the 2 s backstop below
          // finds it, then observeRail() takes over the fine-grained watching.
          const backstop = window.setInterval(() => { observeRail(); refreshMarks() }, 2000)
          refreshMarks()
          rafId = requestAnimationFrame(tick)

          return () => {
            cancelAnimationFrame(rafId)
            window.clearTimeout(refreshTimer)
            window.clearInterval(backstop)
            railObserver?.disconnect()
            source.close()
            for (const m of marks) m.el.style.removeProperty(SCALE_VAR)
            marks = []
            style.remove()
          }
        }, 'dsh-audio-rail-macos: turn-rail animation')
      },
    }
  },
})
