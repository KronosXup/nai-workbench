import { snapPixels } from './pixelSnapAlgorithm';
import type { PixelBuffer, PixelSnapOptions, PixelSnapResult } from './pixelSnapAlgorithm';

export type PixelSnapRequest = { source: PixelBuffer; options: PixelSnapOptions };
export type PixelSnapResponse = { result: PixelSnapResult; error?: never } | { error: string; result?: never };

// Each preview owns one worker; terminate it to cancel obsolete CPU work.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PixelSnapRequest>) => void) | null;
  postMessage: (message: PixelSnapResponse, transfer: Transferable[]) => void;
};
scope.onmessage = ({ data }) => {
  try {
    const result = snapPixels(data.source, data.options);
    scope.postMessage({ result }, [result.data.buffer as ArrayBuffer]);
  } catch (cause) {
    scope.postMessage({ error: cause instanceof Error ? cause.message : '像素整理失败，请重试。' }, []);
  }
};
