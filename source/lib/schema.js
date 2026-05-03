import fs from "node:fs";
import { RECORD_SCHEMA_PATH, TAG_SCHEMA_PATH, KINDS } from "./constants.js";
import { isKebabCase, isTagPattern } from "./util.js";

export function loadSchema() {
  return JSON.parse(fs.readFileSync(RECORD_SCHEMA_PATH, "utf8"));
}

export function loadTagSchema() {
  if (!fs.existsSync(TAG_SCHEMA_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(TAG_SCHEMA_PATH, "utf8"));
}

export function validateAgainstSchema(schema, record) {
  const errors = [];

  const allowedTopLevelKeys = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(record)) {
    if (!allowedTopLevelKeys.has(key)) {
      errors.push(`Unexpected top-level key: ${key}`);
    }
  }

  for (const required of schema.required) {
    if (!(required in record)) {
      errors.push(`Missing required top-level field: ${required}`);
    }
  }

  if ("id" in record && !isKebabCase(record.id)) {
    errors.push("Top-level id must be kebab-case when present");
  }

  if (!KINDS.has(record.kind)) {
    errors.push(`Invalid kind: ${record.kind}`);
  }

  if (typeof record.name !== "string" || record.name.trim() === "") {
    errors.push("name must be a non-empty string");
  }

  if (!Array.isArray(record.sections) || record.sections.length === 0) {
    errors.push("sections must be a non-empty array");
  } else {
    const sectionIds = new Set();
    for (const section of record.sections) {
      const allowedSectionKeys = new Set(
        Object.keys(schema.$defs.section.properties),
      );
      for (const key of Object.keys(section)) {
        if (!allowedSectionKeys.has(key)) {
          errors.push(
            `Unexpected section key in ${section.id ?? "<unknown>"}: ${key}`,
          );
        }
      }

      for (const required of schema.$defs.section.required) {
        if (!(required in section)) {
          errors.push(
            `Section ${section.id ?? "<unknown>"} is missing required field: ${required}`,
          );
        }
      }

      if (typeof section.id !== "string" || !isKebabCase(section.id)) {
        errors.push(`Section id must be kebab-case: ${section.id}`);
      } else if (sectionIds.has(section.id)) {
        errors.push(`Duplicate section id: ${section.id}`);
      } else {
        sectionIds.add(section.id);
      }

      if (typeof section.title !== "string" || section.title.trim() === "") {
        errors.push(`Section ${section.id} title must be a non-empty string`);
      }

      if (!Array.isArray(section.tags)) {
        errors.push(`Section ${section.id} tags must be an array`);
      } else {
        const seenTags = new Set();
        for (const tag of section.tags) {
          if (!isTagPattern(tag)) {
            errors.push(`Section ${section.id} has invalid tag: ${tag}`);
          }
          if (seenTags.has(tag)) {
            errors.push(`Section ${section.id} has duplicate tag: ${tag}`);
          }
          seenTags.add(tag);
        }
      }

      if (typeof section.content !== "string") {
        errors.push(`Section ${section.id} content must be a string`);
      }

      if ("refs" in section) {
        if (!Array.isArray(section.refs)) {
          errors.push(`Section ${section.id} refs must be an array`);
        } else {
          for (const ref of section.refs) {
            const target = ref?.target;
            const type = ref?.type;
            if (
              typeof target !== "string" ||
              !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:#[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(
                target,
              )
            ) {
              errors.push(
                `Section ${section.id} has invalid ref target: ${target}`,
              );
            }
            if (typeof type !== "string" || !isKebabCase(type)) {
              errors.push(
                `Section ${section.id} has invalid ref type: ${type}`,
              );
            }
          }
        }
      }
    }
  }

  return errors;
}

export function validateTagDescriptor(schema, descriptor, filename) {
  const errors = [];
  if (!schema) return errors;

  const allowedKeys = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(descriptor)) {
    if (!allowedKeys.has(key)) {
      errors.push(`Unexpected key in ${filename}: ${key}`);
    }
  }
  for (const required of schema.required) {
    if (!(required in descriptor)) {
      errors.push(`${filename} is missing required field: ${required}`);
    }
  }
  if (typeof descriptor.tag !== "string" || !isTagPattern(descriptor.tag)) {
    errors.push(`${filename}: tag must match tag pattern`);
  }
  if (typeof descriptor.name !== "string" || descriptor.name.trim() === "") {
    errors.push(`${filename}: name must be a non-empty string`);
  }
  if ("id" in descriptor && !isKebabCase(descriptor.id)) {
    errors.push(`${filename}: id must be kebab-case`);
  }
  if ("axis" in descriptor && !isKebabCase(descriptor.axis)) {
    errors.push(`${filename}: axis must be kebab-case`);
  }
  if ("aliases" in descriptor) {
    if (!Array.isArray(descriptor.aliases)) {
      errors.push(`${filename}: aliases must be an array`);
    } else {
      for (const alias of descriptor.aliases) {
        if (!isTagPattern(alias)) {
          errors.push(`${filename}: invalid alias ${alias}`);
        }
      }
    }
  }
  if ("parent" in descriptor && !isTagPattern(descriptor.parent)) {
    errors.push(`${filename}: invalid parent tag ${descriptor.parent}`);
  }
  return errors;
}
