import * as React from "react"

const MOBILE_BREAKPOINT = 768

/** useSyncExternalStore 版本：服务端快照为 false，客户端直接读取视口宽度，
 *  避免在 effect 中同步 setState（react-hooks/set-state-in-effect）。 */
export function useIsMobile() {
  const subscribe = React.useCallback((onChange: () => void) => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  )
}
