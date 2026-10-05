"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Same polling pattern as the Active Workflows queue — auto-refresh on a
// timer, paused while the tab isn't visible, plus a manual refresh a
// caller can trigger right after submitting a new request instead of
// waiting out the interval.
export function useLiveList<T>(fetchFn: () => Promise<T[]>, pollMs = 5000) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;

  const refresh = useCallback(async () => {
    try {
      const data = await fetchRef.current();
      setItems(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load records.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, pollMs);
    function onVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { items, error, refresh, lastUpdated };
}
