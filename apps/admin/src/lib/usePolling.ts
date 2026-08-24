import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export type PollStatus = "idle" | "checking" | "changed" | "synced";

export function usePolling(onChange: () => void) {
  const [status, setStatus] = useState<PollStatus>("idle");

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<{ mtime_ms: number }>("db:changed", () => {
        setStatus("changed");
        onChange();
        setTimeout(() => setStatus("synced"), 1500);
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [onChange]);

  return { status };
}
