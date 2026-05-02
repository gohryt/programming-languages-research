#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const TAGS_DIR = path.join(ROOT, "tags");
const SUMMARY_DIR = path.join(ROOT, "summary");
const SCHEMA_PATH = path.join(ROOT, "schema", "record.schema.json");
const TAG_SCHEMA_PATH = path.join(ROOT, "schema", "tag.schema.json");
const SUMMARY_DATA_PATH = path.join(SUMMARY_DIR, "data.json");
const KINDS = new Set([
  "language",
  "framework",
  "tool",
  "runtime",
  "concept",
  "library",
]);
const AMBIGUOUS_ALIASES = new Set(["c", "r", "go", "elm"]);

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function nowIsoString() {
  return new Date().toISOString();
}

function isKebabCase(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isTagPattern(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(:[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(value);
}

function tagToId(tag) {
  return tag.replace(":", "-");
}

function tagAxis(tag) {
  const idx = tag.indexOf(":");
  return idx === -1 ? null : tag.slice(0, idx);
}

function normalizeId(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

function parseValue(rawValue) {
  if (rawValue === undefined) {
    return true;
  }
  return rawValue;
}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const optionName = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[optionName] = parseValue(next);
        index += 1;
      } else {
        options[optionName] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

function validateAgainstSchema(schema, record) {
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

function getRecordPath(recordId) {
  return path.join(DATA_DIR, `${recordId}.json`);
}

function loadRecord(recordId) {
  return JSON.parse(fs.readFileSync(getRecordPath(recordId), "utf8"));
}

function writeRecord(recordId, record) {
  if (!record.provenance) {
    record.provenance = {};
  }
  if (!record.provenance.createdAt) {
    record.provenance.createdAt = nowIsoString();
  }
  record.provenance.updatedAt = nowIsoString();
  fs.writeFileSync(
    getRecordPath(recordId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function createStarterRecord(kind, displayName) {
  return {
    kind,
    name: displayName,
    aliases: [],
    summary: "",
    sections: [
      {
        id: "overview",
        title: "Overview",
        tags: [],
        content: "",
        refs: [],
      },
    ],
    sources: [],
  };
}

function parseCommaSeparated(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseRefSpec(rawSpec) {
  const value = String(rawSpec);
  const separator = value.lastIndexOf(":");
  if (separator === -1) {
    throw new Error(`Invalid ref spec: ${value}. Expected target:type`);
  }
  return {
    target: value.slice(0, separator),
    type: value.slice(separator + 1),
  };
}

function getSection(record, sectionId) {
  const section = record.sections.find((entry) => entry.id === sectionId);
  if (!section) {
    throw new Error(`No section named ${sectionId}`);
  }
  return section;
}

function requireOption(options, name, message) {
  if (!options[name]) {
    throw new Error(message ?? `Missing required --${name}`);
  }
  return options[name];
}

function openInEditor(filePath) {
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    throw new Error("No editor configured. Set $EDITOR or $VISUAL.");
  }
  const result = spawnSync(editor, [filePath], { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}`);
  }
}

function loadAllRecords() {
  ensureDirectory(DATA_DIR);
  const recordsById = {};
  const warnings = [];
  const schema = loadSchema();
  const dataFiles = fs
    .readdirSync(DATA_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  for (const filename of dataFiles) {
    const recordId = path.basename(filename, ".json");
    const record = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, filename), "utf8"),
    );
    const validationErrors = validateAgainstSchema(schema, record);
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

function loadTagSchema() {
  if (!fs.existsSync(TAG_SCHEMA_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(TAG_SCHEMA_PATH, "utf8"));
}

function validateTagDescriptor(schema, descriptor, filename) {
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

function loadAllTagDescriptors() {
  if (!fs.existsSync(TAGS_DIR)) {
    return { byTag: {}, byId: {}, warnings: [] };
  }
  const tagSchema = loadTagSchema();
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
    const errors = validateTagDescriptor(tagSchema, descriptor, filename);
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

function resolveRefTarget(target, recordsById) {
  const [recordId, sectionId] = target.split("#");
  const record = recordsById[recordId];
  if (!record) {
    return { error: `Unknown target record: ${recordId}` };
  }
  if (!sectionId) {
    return { recordId, record, section: null };
  }
  const section = record.sections.find((entry) => entry.id === sectionId);
  if (!section) {
    return { error: `Unknown target section: ${target}` };
  }
  return { recordId, record, section };
}

function buildAliasIndex(recordsById, warnings) {
  const aliasIndex = new Map();
  for (const [recordId, record] of Object.entries(recordsById)) {
    const names = [record.name, ...(record.aliases ?? [])]
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
    for (const name of names) {
      const normalized = name.toLowerCase();
      if (AMBIGUOUS_ALIASES.has(normalized)) {
        warnings.push(
          `Alias or name is ambiguous and will not be auto-linked: ${name}`,
        );
        continue;
      }
      if (
        aliasIndex.has(normalized) &&
        aliasIndex.get(normalized) !== recordId
      ) {
        warnings.push(
          `Alias collision for ${name}: ${recordId} and ${aliasIndex.get(normalized)}`,
        );
        continue;
      }
      aliasIndex.set(normalized, recordId);
    }
  }
  return aliasIndex;
}

function deriveMentionLinks(section, aliasIndex, recordId) {
  const content = section.content;
  const mentions = [];
  const seenTargets = new Set();
  for (const [alias, targetRecordId] of aliasIndex.entries()) {
    if (targetRecordId === recordId) {
      continue;
    }
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(content) && !seenTargets.has(targetRecordId)) {
      seenTargets.add(targetRecordId);
      mentions.push({ alias, target: `${targetRecordId}#overview` });
    }
  }
  mentions.sort((left, right) => left.alias.localeCompare(right.alias));
  return mentions;
}

function summarizeRecords(recordsById) {
  const indexes = {
    recordIds: Object.keys(recordsById).sort(),
    tags: [],
    kinds: [],
  };
  const allTags = new Set();
  const allKinds = new Set();
  const backlinksByAnchor = new Map();
  const warnings = [];
  const aliasIndex = buildAliasIndex(recordsById, warnings);

  for (const [recordId, record] of Object.entries(recordsById)) {
    allKinds.add(record.kind);
    const derivedTags = new Set();
    for (const section of record.sections) {
      section.anchor = `${recordId}#${section.id}`;
      section.refs = section.refs ?? [];
      section.backlinks = [];
      section.sources = section.sources ?? [];
      section.mentions = deriveMentionLinks(section, aliasIndex, recordId);
      for (const tag of section.tags) {
        derivedTags.add(tag);
        allTags.add(tag);
      }
      for (const ref of section.refs) {
        const resolved = resolveRefTarget(ref.target, recordsById);
        if (resolved.error) {
          throw new Error(
            `Unresolved ref in ${recordId}#${section.id}: ${resolved.error}`,
          );
        }
        if (resolved.section) {
          if (!backlinksByAnchor.has(ref.target)) {
            backlinksByAnchor.set(ref.target, []);
          }
          backlinksByAnchor.get(ref.target).push({
            source: `${recordId}#${section.id}`,
            type: ref.type,
          });
        }
      }
    }
    record.derivedTags = Array.from(derivedTags).sort();
  }

  for (const record of Object.values(recordsById)) {
    for (const section of record.sections) {
      section.backlinks = (backlinksByAnchor.get(section.anchor) ?? []).sort(
        (left, right) => left.source.localeCompare(right.source),
      );
    }
  }

  indexes.tags = Array.from(allTags).sort();
  indexes.kinds = Array.from(allKinds).sort();

  return {
    generatedAt: nowIsoString(),
    version: 1,
    records: recordsById,
    indexes,
    warnings,
  };
}

function writeSummaryBundle(bundle, options) {
  ensureDirectory(SUMMARY_DIR);
  if (options.clean) {
    for (const entry of fs.readdirSync(SUMMARY_DIR)) {
      if (entry === "index.html" || entry === "app.js" || entry === "app.css") {
        continue;
      }
      fs.rmSync(path.join(SUMMARY_DIR, entry), {
        recursive: true,
        force: true,
      });
    }
  }
  const output = {
    generatedAt: bundle.generatedAt,
    version: bundle.version,
    records: bundle.records,
    indexes: bundle.indexes,
    tagDescriptors: bundle.tagDescriptors ?? {},
  };
  fs.writeFileSync(SUMMARY_DATA_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${SUMMARY_DATA_PATH}`);
}

function printRecord(recordId, record, options) {
  const lines = [];
  lines.push(`${recordId} (${record.kind})`);
  lines.push(`  Name: ${record.name}`);
  if (record.summary) {
    lines.push(`  Summary: ${record.summary}`);
  }
  if ((record.aliases ?? []).length > 0) {
    lines.push(`  Aliases: ${record.aliases.join(", ")}`);
  }
  lines.push(`  Sections: ${record.sections.length}`);
  for (const section of record.sections) {
    const tagText =
      section.tags.length > 0 ? ` [${section.tags.join(", ")}]` : "";
    lines.push(`    - ${section.id}: ${section.title}${tagText}`);
  }
  if (options.path) {
    lines.push(`  Path: ${getRecordPath(recordId)}`);
  }
  return lines.join("\n");
}

function commandList(args, options) {
  const { recordsById } = loadAllRecords();
  const selectedKind = options.kind ? String(options.kind) : null;
  const requiredTags = options.tag
    ? parseCommaSeparated(String(options.tag))
    : [];
  const anyOfTags = options["tag-any"]
    ? parseCommaSeparated(String(options["tag-any"]))
    : [];
  const selectedText = options.match
    ? String(options.match).toLowerCase()
    : null;
  const groupBy = options["group-by"] ? String(options["group-by"]) : null;
  const detailed = Boolean(options.verbose || options.v);
  const sectionMode = Boolean(options.sections || options["list-sections"] || groupBy);

  const sectionMatches = (section) => {
    for (const t of requiredTags) {
      if (!section.tags.includes(t)) return false;
    }
    if (anyOfTags.length > 0) {
      const ok = anyOfTags.some((t) => section.tags.includes(t));
      if (!ok) return false;
    }
    return true;
  };

  const recordMatches = (record) => {
    if (selectedKind && record.kind !== selectedKind) return false;
    if (requiredTags.length > 0 || anyOfTags.length > 0) {
      return record.sections.some((s) => sectionMatches(s));
    }
    return true;
  };

  if (groupBy) {
    // Section-level output, grouped by values along the named axis.
    const groups = new Map();
    for (const [recordId, record] of Object.entries(recordsById)) {
      if (!recordMatches(record)) continue;
      for (const section of record.sections) {
        if (!sectionMatches(section)) continue;
        for (const t of section.tags) {
          if (!t.startsWith(groupBy + ":")) continue;
          if (!groups.has(t)) groups.set(t, []);
          groups
            .get(t)
            .push({ recordId, sectionId: section.id, title: section.title });
        }
      }
    }
    if (groups.size === 0) {
      console.log(`(no sections found with tags on axis "${groupBy}")`);
      return;
    }
    const output = [];
    for (const [tag, entries] of [...groups.entries()].sort()) {
      output.push(`${tag}  (${entries.length})`);
      entries.sort((a, b) => a.recordId.localeCompare(b.recordId));
      for (const e of entries) {
        output.push(`  ${e.recordId}#${e.sectionId} — ${e.title}`);
      }
    }
    console.log(output.join("\n"));
    return;
  }

  if (sectionMode) {
    const lines = [];
    for (const [recordId, record] of Object.entries(recordsById).sort(
      (a, b) => a[0].localeCompare(b[0]),
    )) {
      if (!recordMatches(record)) continue;
      for (const section of record.sections) {
        if (!sectionMatches(section)) continue;
        const haystack =
          `${recordId} ${section.id} ${section.title} ${section.tags.join(" ")}`.toLowerCase();
        if (selectedText && !haystack.includes(selectedText)) continue;
        lines.push(`${recordId}#${section.id} — ${section.title}`);
      }
    }
    console.log(lines.join("\n") || "(no sections matched)");
    return;
  }

  const outputs = [];
  for (const [recordId, record] of Object.entries(recordsById).sort(
    (left, right) => left[1].name.localeCompare(right[1].name),
  )) {
    if (!recordMatches(record)) continue;
    const haystack =
      `${recordId} ${record.name} ${(record.aliases ?? []).join(" ")} ${record.sections.map((section) => `${section.id} ${section.title} ${section.tags.join(" ")}`).join(" ")}`.toLowerCase();
    if (selectedText && !haystack.includes(selectedText)) {
      continue;
    }
    outputs.push(
      detailed
        ? printRecord(recordId, record, options)
        : `${recordId} (${record.kind})`,
    );
  }

  console.log(outputs.join(detailed ? "\n\n" : "\n"));
}

function commandShow(args, options) {
  const [targetRaw] = args;
  if (!targetRaw) {
    throw new Error("Usage: show <record-id|record-id#section-id>");
  }
  const [recordIdRaw, sectionIdRaw] = String(targetRaw).split("#");
  const recordId = normalizeId(recordIdRaw);
  const record = loadRecord(recordId);

  if (!sectionIdRaw) {
    if (options.json) {
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    console.log(printRecord(recordId, record, { path: true }));
    return;
  }

  const section = getSection(record, normalizeId(sectionIdRaw));
  if (options.json) {
    console.log(JSON.stringify(section, null, 2));
    return;
  }
  const lines = [];
  lines.push(`${recordId}#${section.id}`);
  lines.push(`  Title: ${section.title}`);
  lines.push(`  Tags: ${section.tags.join(", ") || "(none)"}`);
  lines.push(`  Refs: ${(section.refs ?? []).length}`);
  lines.push("");
  lines.push(section.content);
  console.log(lines.join("\n"));
}

function commandAddSection(args, options) {
  const [recordIdRaw, sectionIdRaw] = args;
  if (!recordIdRaw || !sectionIdRaw) {
    throw new Error(
      "Usage: add-section <record-id> <section-id> [--title TITLE] [--tags a,b] [--content TEXT | --content-file FILE]",
    );
  }
  const recordId = normalizeId(recordIdRaw);
  const recordPath = getRecordPath(recordId);
  if (!fs.existsSync(recordPath)) {
    throw new Error(`Record does not exist: ${recordId}`);
  }
  const record = loadRecord(recordId);
  const sectionId = normalizeId(sectionIdRaw);
  if (record.sections.some((section) => section.id === sectionId)) {
    throw new Error(`Section already exists: ${sectionId}`);
  }
  const content = options["content-file"]
    ? fs.readFileSync(
        path.resolve(process.cwd(), String(options["content-file"])),
        "utf8",
      )
    : options.content
      ? String(options.content)
      : "";
  const section = {
    id: sectionId,
    title: options.title ? String(options.title) : sectionId,
    tags: options.tags
      ? parseCommaSeparated(options.tags).map(normalizeId)
      : [],
    content,
    refs: [],
  };
  record.sections.push(section);
  const schema = loadSchema();
  const errors = validateAgainstSchema(schema, record);
  if (errors.length > 0) {
    throw new Error(`Validation failed:\n- ${errors.join("\n- ")}`);
  }
  writeRecord(recordId, record);
  console.log(`Added section ${recordId}#${sectionId}`);
}

function commandCreate(args, options) {
  const [kindRaw, idRaw] = args;
  if (!kindRaw || !idRaw) {
    throw new Error("Usage: create <kind> <id>");
  }
  const kind = String(kindRaw);
  if (!KINDS.has(kind)) {
    throw new Error(`Invalid kind: ${kind}`);
  }
  const recordId = normalizeId(String(idRaw));
  if (!recordId) {
    throw new Error("Could not derive a valid record id");
  }
  ensureDirectory(DATA_DIR);
  const recordPath = getRecordPath(recordId);
  if (fs.existsSync(recordPath) && !options.force) {
    throw new Error(`Record already exists: ${recordId}`);
  }
  const displayName = options.name ? String(options.name) : String(idRaw);
  const record = createStarterRecord(kind, displayName);
  record.aliases = parseCommaSeparated(options.aliases);
  record.summary = options.summary ? String(options.summary) : "";
  writeRecord(recordId, record);
  if (options.edit) {
    openInEditor(recordPath);
  }
  console.log(`Created ${recordPath}`);
}

function commandUpdate(args, options) {
  const [recordIdRaw] = args;
  if (!recordIdRaw) {
    throw new Error("Usage: update <record-id> [options]");
  }
  const recordId = normalizeId(String(recordIdRaw));
  const recordPath = getRecordPath(recordId);
  if (!fs.existsSync(recordPath)) {
    throw new Error(`Record does not exist: ${recordId}`);
  }

  if (options.edit) {
    openInEditor(recordPath);
    const schema = loadSchema();
    const record = loadRecord(recordId);
    const errors = validateAgainstSchema(schema, record);
    if (errors.length > 0) {
      throw new Error(
        `Validation failed after edit:\n- ${errors.join("\n- ")}`,
      );
    }
    writeRecord(recordId, record);
    console.log(`Edited ${recordPath}`);
    return;
  }

  const record = loadRecord(recordId);

  if (options["set-kind"]) {
    const nextKind = String(options["set-kind"]);
    if (!KINDS.has(nextKind)) {
      throw new Error(`Invalid kind: ${nextKind}`);
    }
    record.kind = nextKind;
  }
  if (options["set-name"]) {
    record.name = String(options["set-name"]);
  }
  if (options["set-summary"]) {
    record.summary = String(options["set-summary"]);
  }
  if (options["add-alias"]) {
    const alias = String(options["add-alias"]);
    record.aliases = Array.from(new Set([...(record.aliases ?? []), alias]));
  }
  if (options["remove-alias"]) {
    const alias = String(options["remove-alias"]);
    record.aliases = (record.aliases ?? []).filter((entry) => entry !== alias);
  }

  if (options["add-source"]) {
    const url = String(options["add-source"]);
    const source = options["source-label"]
      ? { label: String(options["source-label"]), url }
      : { url };
    record.sources = record.sources ?? [];
    record.sources.push(source);
  }
  if (options["clear-sources"]) {
    record.sources = [];
  }

  if (options["add-section"]) {
    const sectionId = normalizeId(String(options["add-section"]));
    if (record.sections.some((section) => section.id === sectionId)) {
      throw new Error(`Section already exists: ${sectionId}`);
    }
    record.sections.push({
      id: sectionId,
      title: options.title ? String(options.title) : sectionId,
      tags: [],
      content: options.content ? String(options.content) : "",
      refs: [],
    });
  }

  if (options["remove-section"]) {
    const sectionId = normalizeId(String(options["remove-section"]));
    record.sections = record.sections.filter(
      (section) => section.id !== sectionId,
    );
  }

  if (options["rename-section"]) {
    const sectionId = normalizeId(String(options["rename-section"]));
    const section = getSection(record, sectionId);
    section.title = String(
      requireOption(options, "title", "rename-section requires --title"),
    );
  }

  if (options["set-section-title"]) {
    const sectionId = normalizeId(String(options["set-section-title"]));
    const section = getSection(record, sectionId);
    section.title = String(
      requireOption(options, "title", "set-section-title requires --title"),
    );
  }

  if (options["set-section-id"]) {
    const sectionId = normalizeId(String(options["set-section-id"]));
    const section = getSection(record, sectionId);
    const nextSectionId = normalizeId(
      String(requireOption(options, "to", "set-section-id requires --to")),
    );
    if (
      record.sections.some(
        (entry) => entry.id === nextSectionId && entry !== section,
      )
    ) {
      throw new Error(`Section id already exists: ${nextSectionId}`);
    }
    section.id = nextSectionId;
  }

  if (options["set-section-tags"]) {
    const sectionId = normalizeId(String(options["set-section-tags"]));
    const section = getSection(record, sectionId);
    const tagsValue = requireOption(
      options,
      "tags",
      "set-section-tags requires --tags",
    );
    section.tags = parseCommaSeparated(tagsValue).map(normalizeId);
  }

  if (options["clear-section-tags"]) {
    const section = getSection(
      record,
      normalizeId(String(options["clear-section-tags"])),
    );
    section.tags = [];
  }

  if (options["add-tag"]) {
    const sectionId = normalizeId(
      String(requireOption(options, "section", "add-tag requires --section")),
    );
    const section = getSection(record, sectionId);
    const tag = normalizeId(String(options["add-tag"]));
    section.tags = Array.from(new Set([...(section.tags ?? []), tag]));
  }

  if (options["remove-tag"]) {
    const sectionId = normalizeId(
      String(
        requireOption(options, "section", "remove-tag requires --section"),
      ),
    );
    const section = getSection(record, sectionId);
    const tag = normalizeId(String(options["remove-tag"]));
    section.tags = (section.tags ?? []).filter((entry) => entry !== tag);
  }

  if (options["set-section-content"]) {
    const section = getSection(
      record,
      normalizeId(String(options["set-section-content"])),
    );
    if (options["content-file"]) {
      section.content = fs.readFileSync(
        path.resolve(process.cwd(), String(options["content-file"])),
        "utf8",
      );
    } else {
      section.content = String(
        requireOption(
          options,
          "content",
          "set-section-content requires --content or --content-file",
        ),
      );
    }
  }

  if (options["append-section-content"]) {
    const section = getSection(
      record,
      normalizeId(String(options["append-section-content"])),
    );
    const content = options["content-file"]
      ? fs.readFileSync(
          path.resolve(process.cwd(), String(options["content-file"])),
          "utf8",
        )
      : String(
          requireOption(
            options,
            "content",
            "append-section-content requires --content or --content-file",
          ),
        );
    section.content = section.content
      ? `${section.content}\n\n${content}`
      : content;
  }

  if (options["clear-section-content"]) {
    const section = getSection(
      record,
      normalizeId(String(options["clear-section-content"])),
    );
    section.content = "";
  }

  if (options["add-ref"]) {
    const sectionId = normalizeId(String(options["add-ref"]));
    const ref = parseRefSpec(
      requireOption(options, "ref", "add-ref requires --ref target:type"),
    );
    const section = getSection(record, sectionId);
    section.refs = section.refs ?? [];
    const duplicate = section.refs.some(
      (entry) => entry.target === ref.target && entry.type === ref.type,
    );
    if (!duplicate) {
      section.refs.push(ref);
    }
  }

  if (options["remove-ref"]) {
    const sectionId = normalizeId(String(options["remove-ref"]));
    const ref = parseRefSpec(
      requireOption(options, "ref", "remove-ref requires --ref target:type"),
    );
    const section = getSection(record, sectionId);
    section.refs = (section.refs ?? []).filter(
      (entry) => !(entry.target === ref.target && entry.type === ref.type),
    );
  }

  if (options["clear-refs"]) {
    const section = getSection(
      record,
      normalizeId(String(options["clear-refs"])),
    );
    section.refs = [];
  }

  const schema = loadSchema();
  const errors = validateAgainstSchema(schema, record);
  if (errors.length > 0) {
    throw new Error(`Validation failed:\n- ${errors.join("\n- ")}`);
  }
  writeRecord(recordId, record);
  console.log(`Updated ${recordPath}`);
}

function commandDelete(args, options) {
  const [targetRaw] = args;
  if (!targetRaw) {
    throw new Error("Usage: delete <record-id|record-id#section-id>");
  }
  const [recordIdRaw, sectionIdRaw] = String(targetRaw).split("#");
  const recordId = normalizeId(recordIdRaw);
  const recordPath = getRecordPath(recordId);
  if (!fs.existsSync(recordPath)) {
    throw new Error(`Record does not exist: ${recordId}`);
  }

  if (!sectionIdRaw) {
    fs.rmSync(recordPath);
    console.log(`Deleted ${recordPath}`);
    return;
  }

  const record = loadRecord(recordId);
  const sectionId = normalizeId(sectionIdRaw);
  const originalLength = record.sections.length;
  record.sections = record.sections.filter(
    (section) => section.id !== sectionId,
  );
  if (record.sections.length === originalLength) {
    throw new Error(`No section named ${sectionId}`);
  }
  if (record.sections.length === 0 && !options.force) {
    throw new Error(
      "Refusing to leave a record with zero sections; use --force and delete the record instead",
    );
  }
  if (record.sections.length === 0 && options.force) {
    fs.rmSync(recordPath);
    console.log(`Deleted ${recordPath}`);
    return;
  }
  writeRecord(recordId, record);
  console.log(`Deleted section ${recordId}#${sectionId}`);
}

function commandSummarize(args, options) {
  const { recordsById, warnings: loadWarnings } = loadAllRecords();
  const tagDescriptors = loadAllTagDescriptors();
  const selectedIds = options.only
    ? new Set(parseCommaSeparated(options.only).map(normalizeId))
    : null;
  const filteredRecords = {};
  for (const [recordId, record] of Object.entries(recordsById)) {
    if (!selectedIds || selectedIds.has(recordId)) {
      filteredRecords[recordId] = record;
    }
  }
  const bundle = summarizeRecords(filteredRecords);
  const tagWarnings = checkTagDescriptors(tagDescriptors, bundle.indexes.tags);
  bundle.tagDescriptors = tagDescriptors.byTag;
  bundle.indexes.tagAxes = collectTagAxes(bundle.indexes.tags, tagDescriptors);
  const warnings = [
    ...loadWarnings,
    ...bundle.warnings,
    ...tagDescriptors.warnings,
    ...tagWarnings,
  ];
  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
  }
  if (options.check) {
    console.log(
      `Validated ${Object.keys(filteredRecords).length} record(s), ${Object.keys(tagDescriptors.byTag).length} tag descriptor(s)`,
    );
    return;
  }
  writeSummaryBundle(bundle, options);
}

function checkTagDescriptors(tagDescriptors, allTags) {
  const warnings = [];
  const usedTags = new Set(allTags);
  for (const tag of Object.keys(tagDescriptors.byTag)) {
    if (!usedTags.has(tag)) {
      warnings.push(
        `Tag descriptor ${tag} has no sections referencing it`,
      );
    }
  }
  for (const descriptor of Object.values(tagDescriptors.byTag)) {
    for (const alias of descriptor.aliases ?? []) {
      if (usedTags.has(alias)) {
        warnings.push(
          `Tag ${alias} is still in use but is declared as alias of ${descriptor.tag}; rewrite section.tags to use the canonical form`,
        );
      }
    }
    if (descriptor.parent && !tagDescriptors.byTag[descriptor.parent]) {
      warnings.push(
        `Tag ${descriptor.tag} has parent ${descriptor.parent} which has no descriptor`,
      );
    }
  }
  return warnings;
}

function collectTagAxes(tags, tagDescriptors) {
  const axes = {};
  for (const tag of tags) {
    const axis = tagAxis(tag);
    if (!axis) continue;
    if (!axes[axis]) axes[axis] = [];
    axes[axis].push(tag);
  }
  // Surface axes/values declared in descriptors even if no section uses them yet —
  // a team can register a new axis by dropping a descriptor file.
  for (const descriptor of Object.values(tagDescriptors.byTag)) {
    if (!descriptor.axis) continue;
    if (!axes[descriptor.axis]) axes[descriptor.axis] = [];
    if (
      descriptor.tag &&
      tagAxis(descriptor.tag) === descriptor.axis &&
      !axes[descriptor.axis].includes(descriptor.tag)
    ) {
      axes[descriptor.axis].push(descriptor.tag);
    }
  }
  for (const axis of Object.keys(axes)) {
    axes[axis] = Array.from(new Set(axes[axis])).sort();
  }
  return axes;
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function commandServe(args, options) {
  const port = Number(options.port ?? 8000);
  const host = String(options.host ?? "127.0.0.1");
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${host}:${port}`);
    let requestPath = decodeURIComponent(url.pathname);
    if (requestPath === "/") {
      requestPath = "/index.html";
    }
    const safePath = path.normalize(requestPath).replace(/^\/+/, "");
    const filePath = path.join(SUMMARY_DIR, safePath);
    if (!filePath.startsWith(SUMMARY_DIR)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    fs.createReadStream(filePath).pipe(response);
  });
  server.listen(port, host, () => {
    console.log(`Serving ${SUMMARY_DIR}`);
    console.log(`Open http://${host}:${port}`);
  });
}

function printUsage() {
  console.log(`Usage:
  research create <kind> <id> [--name NAME] [--aliases a,b] [--summary TEXT] [--force] [--edit]
  research list [--kind KIND] [--tag a,b] [--tag-any a,b] [--match TEXT] [--verbose] [--path]
                [--sections] [--group-by AXIS]
  research show <record-id|record-id#section-id> [--json]
  research add-section <record-id> <section-id> [--title TITLE] [--tags a,b] [--content TEXT | --content-file FILE]
  research update <record-id> [--edit]
    Top-level:
      --set-kind KIND
      --set-name NAME
      --set-summary TEXT
      --add-alias ALIAS
      --remove-alias ALIAS
      --add-source URL [--source-label LABEL]
      --clear-sources
    Sections:
      --add-section ID [--title TITLE] [--content TEXT]
      --remove-section ID
      --rename-section ID --title TITLE
      --set-section-title ID --title TITLE
      --set-section-id ID --to NEW_ID
      --set-section-tags ID --tags a,b,c
      --clear-section-tags ID
      --add-tag TAG --section ID
      --remove-tag TAG --section ID
      --set-section-content ID (--content TEXT | --content-file FILE)
      --append-section-content ID (--content TEXT | --content-file FILE)
      --clear-section-content ID
      --add-ref ID --ref target:type
      --remove-ref ID --ref target:type
      --clear-refs ID
  research delete <record-id|record-id#section-id> [--force]
  research summarize [--check] [--clean] [--only id1,id2]
  research serve [--host HOST] [--port PORT]
`);
}

function main() {
  const argv = process.argv.slice(2);
  const { positional, options } = parseArguments(argv);
  const [command, ...args] = positional;
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  ensureDirectory(DATA_DIR);
  ensureDirectory(SUMMARY_DIR);

  switch (command) {
    case "create":
      commandCreate(args, options);
      return;
    case "list":
      commandList(args, options);
      return;
    case "show":
      commandShow(args, options);
      return;
    case "add-section":
      commandAddSection(args, options);
      return;
    case "update":
      commandUpdate(args, options);
      return;
    case "delete":
      commandDelete(args, options);
      return;
    case "summarize":
      commandSummarize(args, options);
      return;
    case "serve":
      commandServe(args, options);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
