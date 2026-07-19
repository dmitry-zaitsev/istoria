// Desktop notifications via the web Notification API (Chromium/Electron
// supports it natively). Drop-in replacement for the Tauri
// `@tauri-apps/plugin-notification` surface used by the app — same function
// names and shapes so callers are unchanged.

export async function isPermissionGranted(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  return Notification.permission === "granted";
}

export async function requestPermission(): Promise<"granted" | "denied" | "default"> {
  if (typeof Notification === "undefined") return "denied";
  return Notification.requestPermission();
}

export function sendNotification(options: { title: string; body?: string }): void {
  if (typeof Notification === "undefined") return;
  // eslint-disable-next-line no-new
  new Notification(options.title, { body: options.body });
}
