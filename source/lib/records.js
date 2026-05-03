import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, TAGS_DIR } from "./constants.js";
import { ensureDirectory, tagToId } from "./util.js";
import { validateRecord, validateTagDescriptor } from "./schema.js";

export function loadAllRecords() {
  ensureDirectory(DATA_DIR);
  const recordsById = {};
  const warnings = [];
  const dataFiles = fs
    .readdirSync(DATA_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  for (const filename of dataFiles) {
    const recordId = path.basename(filename, ".json");
    const record = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, filename), "utf8"),
    );
    const validationErrors = validateRecord(record);
    if (record.id && record.id !== recordId) {
      validationErrors.push(
        `Top-level id ${record.id} does not match filename ${recordId}.json`,
      );
    }
    if ("tags" in record) {
      warnings.push(
        `Record ${recordId} contains deprecated top-level tags field`,
      );
    }
    if (validationErrors.length > 0) {
      const detail = validationErrors.map((error) => `- ${error}`).join("\n");
      throw new Error(`Validation failed for ${filename}:\n${detail}`);
    }
    recordsById[recordId] = record;
  }
  return { recordsById, warnings };
}

export function loadAllTagDescriptors() {
  if (!fs.existsSync(TAGS_DIR)) {
    return { byTag: {}, byId: {}, warnings: [] };
  }
  const byTag = {};
  const byId = {};
  const warnings = [];
  const files = fs
    .readdirSync(TAGS_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  for (const filename of files) {
    const id = path.basename(filename, ".json");
    const descriptor = JSON.parse(
      fs.readFileSync(path.join(TAGS_DIR, filename), "utf8"),
    );
    const errors = validateTagDescriptor(descriptor, filename);
    if (descriptor.id && descriptor.id !== id) {
      errors.push(
        `${filename}: id ${descriptor.id} does not match filename ${id}.json`,
      );
    }
    if (descriptor.tag && tagToId(descriptor.tag) !== id) {
      errors.push(
        `${filename}: tag ${descriptor.tag} should map to filename ${tagToId(descriptor.tag)}.json`,
      );
    }
    if (errors.length > 0) {
      throw new Error(
        `Tag descriptor validation failed for ${filename}:\n${errors.map((e) => `- ${e}`).join("\n")}`,
      );
    }
    if (byTag[descriptor.tag]) {
      warnings.push(
        `Duplicate tag descriptor for ${descriptor.tag}: ${id} and ${byTag[descriptor.tag].id}`,
      );
    }
    descriptor.id = id;
    byTag[descriptor.tag] = descriptor;
    byId[id] = descriptor;
    for (const alias of descriptor.aliases ?? []) {
      if (byTag[alias]) {
        warnings.push(
          `Tag ${alias} is both an alias of ${descriptor.tag} and a registered tag`,
        );
      }
    }
  }
  return { byTag, byId, warnings };
}
