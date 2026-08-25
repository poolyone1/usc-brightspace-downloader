import path from "node:path";
import type { Course } from "./types.js";

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/html": ".html",
  "text/plain": ".txt",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
};

export function sanitizeComponent(input: string, fallback = "untitled"): string {
  const normalized = input
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const safe = normalized === "." || normalized === ".." ? "" : normalized;
  return (safe || fallback).slice(0, 140);
}

export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = header.match(/filename\*\s*=\s*([^;]+)/i)?.[1]?.trim();
  if (extended) {
    const unquoted = extended.replace(/^"|"$/g, "");
    const encoded = unquoted.replace(/^[^']*'[^']*'/, "");
    try {
      return sanitizeComponent(decodeURIComponent(encoded));
    } catch {
      // Fall through to the basic filename form.
    }
  }
  const basic = header.match(/filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]+))/i);
  const value = basic?.[1]?.replace(/\\(.)/g, "$1") || basic?.[2]?.trim();
  return value ? sanitizeComponent(value) : null;
}

function filenameFromTopicUrl(topicUrl: string): string | null {
  try {
    const url = new URL(topicUrl, "https://brightspace.invalid");
    const basename = path.posix.basename(url.pathname);
    return basename ? sanitizeComponent(decodeURIComponent(basename)) : null;
  } catch {
    return null;
  }
}

export function preferredFilename(
  disposition: string | null,
  topicUrl: string,
  title: string,
  contentType: string | null,
): string {
  let filename =
    filenameFromDisposition(disposition) || filenameFromTopicUrl(topicUrl) || sanitizeComponent(title);
  if (!path.extname(filename)) {
    const mime = (contentType || "").split(";", 1)[0]?.trim().toLowerCase() || "";
    filename += MIME_EXTENSIONS[mime] || "";
  }
  return sanitizeComponent(filename);
}

export function courseDirectory(course: Course): string {
  return sanitizeComponent(`${course.code} - ${course.name} [${course.id}]`, String(course.id));
}

export function safeResolve(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("Manifest path must be relative.");
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error("Refusing a path outside the download directory.");
  }
  return target;
}

export function uniqueRelativePath(
  course: Course,
  modulePath: string[],
  filename: string,
  topicId: number,
  reserved: Set<string>,
): string {
  const directory = [courseDirectory(course), ...modulePath.map((part) => sanitizeComponent(part))];
  let candidate = path.join(...directory, sanitizeComponent(filename));
  const comparisonKey = (value: string) => value.normalize("NFC").toLocaleLowerCase("en-US");
  if (!reserved.has(comparisonKey(candidate))) {
    reserved.add(comparisonKey(candidate));
    return candidate;
  }

  const parsed = path.parse(candidate);
  candidate = path.join(parsed.dir, `${parsed.name} [${topicId}]${parsed.ext}`);
  let counter = 2;
  while (reserved.has(comparisonKey(candidate))) {
    candidate = path.join(parsed.dir, `${parsed.name} [${topicId}-${counter}]${parsed.ext}`);
    counter += 1;
  }
  reserved.add(comparisonKey(candidate));
  return candidate;
}

export function conflictRelativePath(relativePath: string, reserved: Set<string>): string {
  const parsed = path.parse(relativePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = path.join(parsed.dir, `${parsed.name}.remote-${stamp}${parsed.ext}`);
  let counter = 2;
  const key = (value: string) => value.normalize("NFC").toLocaleLowerCase("en-US");
  while (reserved.has(key(candidate))) {
    candidate = path.join(parsed.dir, `${parsed.name}.remote-${stamp}-${counter}${parsed.ext}`);
    counter += 1;
  }
  reserved.add(key(candidate));
  return candidate;
}
