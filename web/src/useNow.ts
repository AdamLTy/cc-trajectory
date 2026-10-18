import { createContext, useContext, useEffect, useState } from "react";

// The current time for live timers. One ticker in App drives every timer on the page, and it only
// ticks while something is running, so a finished page does not re-render every second.
export const NowContext = createContext(Date.now());

export function useTicker(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function useNow(): number {
  return useContext(NowContext);
}

// 0.4s, 12s, 1m 05s
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}
