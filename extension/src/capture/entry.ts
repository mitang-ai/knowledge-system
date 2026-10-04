import { extractDocument } from "./extract";
import type { CaptureEnvelope } from "../types";
declare global {
  var __sedimentCaptureV1:
    | ((preferSelection?: boolean) => CaptureEnvelope)
    | undefined;
}
// Lives in the isolated extension world, not the page's JavaScript world.
globalThis.__sedimentCaptureV1 = (preferSelection = true) =>
  extractDocument(
    document,
    preferSelection ? window.getSelection()?.toString() || "" : "",
  );
