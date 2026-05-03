import fs from "node:fs";

export function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

export function nowIsoString() {
  return new Date().toISOString();
}

export function isKebabCase(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function isTagPattern(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(:[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(value);
}

export function tagToId(tag) {
  return tag.replace(":", "-");
}

export function tagAxis(tag) {
  const idx = tag.indexOf(":");
  return idx === -1 ? null : tag.slice(0, idx);
}

export function normalizeId(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

export function parseCommaSeparated(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
