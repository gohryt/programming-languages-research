import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DATA_DIR = path.join(ROOT, "data");
export const TAGS_DIR = path.join(ROOT, "tags");
export const SUMMARY_DIR = path.join(ROOT, "summary");
export const RECORD_SCHEMA_PATH = path.join(ROOT, "schema", "record.schema.json");
export const TAG_SCHEMA_PATH = path.join(ROOT, "schema", "tag.schema.json");
export const SUMMARY_DATA_PATH = path.join(SUMMARY_DIR, "data.json");

export const KINDS = new Set([
  "language",
  "framework",
  "tool",
  "runtime",
  "concept",
  "library",
]);
