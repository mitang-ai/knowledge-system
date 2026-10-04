import type { CaptureEnvelope } from "../types";
export function exportCapture(capture: CaptureEnvelope) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "sediment-capture-" + capture.id + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function openSystem(origin: string) {
  void chrome.tabs.create({ url: origin });
}
export function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
