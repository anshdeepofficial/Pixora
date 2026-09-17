"use client";

import { useEffect } from "react";

export const PIXORA_VERSION = "1.1.0";

export default function VersionClient() {
  useEffect(() => {
    const sync = () => {
      document.querySelectorAll<HTMLElement>(".versionBadge").forEach((badge) => {
        const wanted = `v${PIXORA_VERSION}`;
        if (badge.textContent !== wanted) badge.textContent = wanted;
      });
      const notice = document.querySelector<HTMLElement>(".versionNotice b");
      if (notice) notice.textContent = `✓ Updated to v${PIXORA_VERSION}`;
      try { localStorage.setItem("pixora-app-version", PIXORA_VERSION); } catch {}
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
