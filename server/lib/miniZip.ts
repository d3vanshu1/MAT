/**
 * miniZip.ts — ZIP extractor using fflate (pure JS, no Web API dependency).
 */
import { unzipSync } from "fflate";

/**
 * Extract all files from a ZIP archive.
 * Returns a map of filename → Uint8Array content.
 */
export async function unzip(zipData: Uint8Array): Promise<Map<string, Uint8Array>> {
  const entries = unzipSync(zipData);
  const result = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (!name.endsWith("/")) {
      result.set(name, data);
    }
  }
  return result;
}

/** Decode UTF-8 bytes to string without TextDecoder (not available in all VMs) */
export function utf8Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      parts.push(String.fromCharCode(b));
      i++;
    } else if (b < 0xE0) {
      parts.push(String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)));
      i += 2;
    } else if (b < 0xF0) {
      parts.push(String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)));
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      const offset = cp - 0x10000;
      parts.push(String.fromCharCode(0xD800 + (offset >> 10), 0xDC00 + (offset & 0x3FF)));
      i += 4;
    }
  }
  return parts.join("");
}

/**
 * Convenience: extract and decode text files from a zip.
 */
export async function unzipText(zipData: Uint8Array): Promise<Map<string, string>> {
  const files = await unzip(zipData);
  const textFiles = new Map<string, string>();
  for (const [name, data] of files) {
    textFiles.set(name, utf8Decode(data));
  }
  return textFiles;
}
