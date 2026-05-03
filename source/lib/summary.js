import fs from "node:fs";
import path from "node:path";
import { SUMMARY_DIR, SUMMARY_DATA_PATH } from "./constants.js";
import { ensureDirectory, nowIsoString, tagAxis } from "./util.js";
import { loadAllRecords, loadAllTagDescriptors } from "./records.js";

export function resolveRefTarget(target, recordsById) {
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

export function buildAliasIndex(recordsById, warnings) {
  const aliasIndex = new Map();
  for (const [recordId, record] of Object.entries(recordsById)) {
    const names = [record.name, ...(record.aliases ?? [])]
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
    for (const name of names) {
      const normalized = name.toLowerCase();
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

export function deriveMentionLinks(section, aliasIndex, recordId) {
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

export function summarizeRecords(recordsById) {
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

export function checkTagDescriptors(tagDescriptors, allTags) {
  const warnings = [];
  const usedTags = new Set(allTags);
  for (const tag of Object.keys(tagDescriptors.byTag)) {
    if (!usedTags.has(tag)) {
      warnings.push(`Tag descriptor ${tag} has no sections referencing it`);
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

export function collectTagAxes(tags, tagDescriptors) {
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

export function writeSummaryBundle(bundle, options) {
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

export function validateAndBuild() {
  const { recordsById, warnings: loadWarnings } = loadAllRecords();
  const tagDescriptors = loadAllTagDescriptors();
  const bundle = summarizeRecords(recordsById);
  const tagWarnings = checkTagDescriptors(tagDescriptors, bundle.indexes.tags);
  bundle.tagDescriptors = tagDescriptors.byTag;
  bundle.indexes.tagAxes = collectTagAxes(bundle.indexes.tags, tagDescriptors);
  return {
    bundle,
    warnings: [
      ...loadWarnings,
      ...bundle.warnings,
      ...tagDescriptors.warnings,
      ...tagWarnings,
    ],
    recordCount: Object.keys(recordsById).length,
    tagCount: Object.keys(tagDescriptors.byTag).length,
  };
}
