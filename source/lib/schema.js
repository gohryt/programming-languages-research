import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { RECORD_SCHEMA_PATH, TAG_SCHEMA_PATH } from "./constants.js";

// allErrors: report every issue per record so the user sees the full list.
// We don't validate date-time / uri shapes (matching prior behavior), so
// register them as no-ops to silence ajv's "unknown format" warnings.
const ajv = new Ajv.default({ allErrors: true, strict: false });
ajv.addFormat("date-time", true);
ajv.addFormat("uri", true);

let recordValidator = null;
let tagValidator = null;

function compileFromPath(schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  return ajv.compile(schema);
}

function getRecordValidator() {
  if (!recordValidator) {
    recordValidator = compileFromPath(RECORD_SCHEMA_PATH);
  }
  return recordValidator;
}

function getTagValidator() {
  if (tagValidator !== null) return tagValidator;
  if (!fs.existsSync(TAG_SCHEMA_PATH)) {
    tagValidator = false;
    return null;
  }
  tagValidator = compileFromPath(TAG_SCHEMA_PATH);
  return tagValidator;
}

function formatError(error, prefix = "") {
  const path = error.instancePath || "/";
  const allowed =
    error.params && Array.isArray(error.params.allowedValues)
      ? ` (allowed: ${error.params.allowedValues.map(String).join(", ")})`
      : "";
  return `${prefix}${path}: ${error.message}${allowed}`;
}

export function validateRecord(record) {
  const validate = getRecordValidator();
  const errors = [];
  if (!validate(record)) {
    for (const error of validate.errors) {
      errors.push(formatError(error));
    }
  }
  // Ajv's `uniqueItems` compares whole objects, which doesn't catch sections
  // sharing an `id` if other fields differ. Check explicitly.
  if (Array.isArray(record.sections)) {
    const seen = new Set();
    for (const section of record.sections) {
      const id = section?.id;
      if (typeof id === "string") {
        if (seen.has(id)) {
          errors.push(`Duplicate section id: ${id}`);
        }
        seen.add(id);
      }
    }
  }
  return errors;
}

export function validateTagDescriptor(descriptor, filename) {
  const validate = getTagValidator();
  if (!validate) return [];
  const errors = [];
  if (!validate(descriptor)) {
    for (const error of validate.errors) {
      errors.push(formatError(error, `${filename}: `));
    }
  }
  return errors;
}
