export async function loadMcpModules() {
  try {
    const mcpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const transportModule = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const z = await import("zod");
    return {
      McpServer: mcpModule.McpServer,
      StreamableHTTPServerTransport:
        transportModule.StreamableHTTPServerTransport,
      z,
    };
  } catch (error) {
    return { error };
  }
}

function jsonText(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function jsonError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

function safeTool(fn) {
  return async (...args) => {
    try {
      return jsonText(await fn(...args));
    } catch (error) {
      return jsonError(error.message ?? String(error));
    }
  };
}

function findRecord(bundle, id) {
  const record = bundle.records?.[id];
  if (!record) throw new Error(`Unknown record: ${id}`);
  return record;
}

function findSection(record, sectionId) {
  const section = record.sections.find((entry) => entry.id === sectionId);
  if (!section) {
    throw new Error(`Unknown section: ${sectionId}`);
  }
  return section;
}

function sectionRow(recordId, recordName, section) {
  return {
    recordId,
    recordName,
    sectionId: section.id,
    sectionTitle: section.title,
    tags: section.tags,
  };
}

function findSectionsWithTag(bundle, tag) {
  const out = [];
  for (const [recordId, record] of Object.entries(bundle.records ?? {})) {
    for (const section of record.sections) {
      if ((section.tags ?? []).includes(tag)) {
        out.push(sectionRow(recordId, record.name, section));
      }
    }
  }
  return out;
}

function recordEntry(id, record) {
  return {
    id,
    kind: record.kind,
    name: record.name,
    summary: record.summary ?? "",
    aliases: record.aliases ?? [],
    sections: record.sections.map((section) => ({
      id: section.id,
      title: section.title,
      tags: section.tags,
    })),
    tags: record.derivedTags ?? [],
  };
}

function recordSummary(bundle, id) {
  const record = findRecord(bundle, id);
  return { id, ...record };
}

function sectionSummary(bundle, id, sectionId) {
  const record = findRecord(bundle, id);
  const section = findSection(record, sectionId);
  return { recordId: id, recordName: record.name, ...section };
}

function tagSummary(bundle, tag) {
  const descriptors = bundle.tagDescriptors ?? {};
  const sections = findSectionsWithTag(bundle, tag);
  return {
    tag,
    descriptor: descriptors[tag] ?? null,
    count: sections.length,
    sections,
  };
}

function listTagsSummary(bundle, axisFilter) {
  const tags = bundle.indexes?.tags ?? [];
  const descriptors = bundle.tagDescriptors ?? {};
  const counts = new Map();
  for (const record of Object.values(bundle.records ?? {})) {
    for (const section of record.sections) {
      for (const tag of section.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
  }
  const out = [];
  for (const tag of tags) {
    const tagAxis = tag.includes(":") ? tag.slice(0, tag.indexOf(":")) : null;
    if (axisFilter && tagAxis !== axisFilter) continue;
    out.push({
      tag,
      axis: tagAxis,
      count: counts.get(tag) ?? 0,
      descriptor: descriptors[tag] ?? null,
    });
  }
  out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { count: out.length, tags: out };
}

function listAxesSummary(bundle) {
  const axes = bundle.indexes?.tagAxes ?? {};
  return {
    axes: Object.fromEntries(
      Object.entries(axes).map(([axis, tags]) => [axis, tags.slice().sort()]),
    ),
  };
}

function axisSummary(bundle, axis) {
  const tags = bundle.indexes?.tagAxes?.[axis];
  if (!tags || tags.length === 0) {
    throw new Error(`No tags registered under axis: ${axis}`);
  }
  return {
    axis,
    groups: tags
      .slice()
      .sort()
      .map((tag) => tagSummary(bundle, tag)),
  };
}

function filterRecords(bundle, { kind, tag, tagAny, match, limit }) {
  const cap = limit ?? 100;
  const out = [];
  const records = bundle.records ?? {};
  for (const [id, record] of Object.entries(records)) {
    if (kind && record.kind !== kind) continue;
    if (
      tag?.length &&
      !tag.every((t) =>
        record.sections.some((s) => (s.tags ?? []).includes(t)),
      )
    ) {
      continue;
    }
    if (
      tagAny?.length &&
      !tagAny.some((t) =>
        record.sections.some((s) => (s.tags ?? []).includes(t)),
      )
    ) {
      continue;
    }
    if (match) {
      const needle = match.toLowerCase();
      const haystack = [
        id,
        record.name,
        record.summary ?? "",
        (record.aliases ?? []).join(" "),
        record.sections
          .map((s) => `${s.id} ${s.title} ${(s.tags ?? []).join(" ")}`)
          .join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    out.push(recordEntry(id, record));
    if (out.length >= cap) break;
  }
  return {
    count: out.length,
    truncated: out.length >= cap,
    records: out,
  };
}

function searchCorpus(bundle, { query, scope, limit }) {
  const needle = query.toLowerCase();
  const useScope = scope ?? "both";
  const cap = limit ?? 50;
  const results = [];
  const snippet = (text) => {
    if (!text) return "";
    const i = text.toLowerCase().indexOf(needle);
    if (i < 0) return text.slice(0, 160);
    const start = Math.max(0, i - 60);
    const end = Math.min(text.length, i + needle.length + 100);
    return (
      (start > 0 ? "…" : "") +
      text.slice(start, end) +
      (end < text.length ? "…" : "")
    );
  };

  outer: for (const [recordId, record] of Object.entries(
    bundle.records ?? {},
  )) {
    if (useScope === "record" || useScope === "both") {
      const haystack = `${recordId} ${record.name} ${
        record.summary ?? ""
      } ${(record.aliases ?? []).join(" ")}`.toLowerCase();
      if (haystack.includes(needle)) {
        results.push({
          type: "record",
          recordId,
          kind: record.kind,
          name: record.name,
          summary: record.summary ?? "",
          snippet: snippet(`${record.name} — ${record.summary ?? ""}`),
        });
        if (results.length >= cap) break outer;
      }
    }
    if (useScope === "section" || useScope === "both") {
      for (const section of record.sections) {
        const haystack = `${section.id} ${section.title} ${(
          section.tags ?? []
        ).join(" ")} ${section.content ?? ""}`.toLowerCase();
        if (haystack.includes(needle)) {
          results.push({
            type: "section",
            recordId,
            recordName: record.name,
            sectionId: section.id,
            sectionTitle: section.title,
            tags: section.tags,
            snippet: snippet(section.content ?? section.title),
          });
          if (results.length >= cap) break outer;
        }
      }
    }
  }
  return {
    query,
    scope: useScope,
    count: results.length,
    truncated: results.length >= cap,
    results,
  };
}

function resolveRefForRpc(bundle, target) {
  const [recordId, sectionId] = String(target).split("#");
  const record = bundle.records?.[recordId];
  if (!record) return null;
  if (sectionId) {
    const section = record.sections.find((entry) => entry.id === sectionId);
    if (!section) return null;
    return sectionRow(recordId, record.name, section);
  }
  return { recordId, recordName: record.name };
}

function crossRefs(bundle, id, sectionId) {
  const record = findRecord(bundle, id);
  const sectionsToScan = sectionId
    ? [findSection(record, sectionId)]
    : record.sections;

  const outbound = [];
  const inbound = [];
  for (const section of sectionsToScan) {
    for (const ref of section.refs ?? []) {
      outbound.push({
        from: { recordId: id, sectionId: section.id },
        target: ref.target,
        type: ref.type,
        resolved: resolveRefForRpc(bundle, ref.target),
      });
    }
    for (const back of section.backlinks ?? []) {
      inbound.push({
        to: { recordId: id, sectionId: section.id },
        source: back.source,
        type: back.type,
        resolved: resolveRefForRpc(bundle, back.source),
      });
    }
  }
  return {
    recordId: id,
    sectionId: sectionId ?? null,
    outbound,
    inbound,
  };
}

export function buildMcpServer({ McpServer, z, getBundle }) {
  const server = new McpServer({
    name: "programming-languages-research",
    version: "0.1.0",
  });

  server.registerTool(
    "list_records",
    {
      title: "List records",
      description:
        "Enumerate records in the programming-languages research corpus (languages, frameworks, tools, runtimes, concepts, libraries) with optional filtering. " +
        "`tag` requires every listed tag to appear on at least one section of the record (intersection); `tag_any` requires any one (union); `match` is a case-insensitive substring filter over id, name, summary, aliases, and section titles/tags. " +
        "Returns each match's id, kind, name, summary, aliases, derived tag set, and a section list (id/title/tags). Use `search` instead when you need snippets across full section content.",
      inputSchema: {
        kind: z
          .enum([
            "language",
            "framework",
            "tool",
            "runtime",
            "concept",
            "library",
          ])
          .optional()
          .describe("Filter by record kind."),
        tag: z
          .array(z.string())
          .optional()
          .describe(
            "Tags that must all be present in some section (intersection).",
          ),
        tag_any: z
          .array(z.string())
          .optional()
          .describe(
            "Tags any of which must be present in some section (union).",
          ),
        match: z
          .string()
          .optional()
          .describe(
            "Substring filter (case-insensitive) over id, name, summary, aliases, and section titles/tags.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum entries returned. Default 100."),
      },
    },
    safeTool(async ({ kind, tag, tag_any, match, limit }) =>
      filterRecords(getBundle(), {
        kind,
        tag,
        tagAny: tag_any,
        match,
        limit,
      }),
    ),
  );

  server.registerTool(
    "get_record",
    {
      title: "Get a record",
      description:
        "Return a single record's full JSON — metadata (kind, name, summary, aliases, provenance) plus an ordered list of sections, each with `tags`, `content` (markdown), `refs` (typed cross-references to other records/sections), `sources` (URLs), and the build-time-derived `backlinks` (inbound refs) and `mentions` (alias auto-detections in body text). When `section` is supplied, returns just that one section.",
      inputSchema: {
        id: z.string().describe("Record id (kebab-case)."),
        section: z
          .string()
          .optional()
          .describe(
            "Section id (kebab-case). If omitted, the full record is returned.",
          ),
      },
    },
    safeTool(async ({ id, section }) =>
      section
        ? sectionSummary(getBundle(), id, section)
        : recordSummary(getBundle(), id),
    ),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "Return every tag that appears on any section in the corpus, with usage count and the descriptor (if `tags/<id>.json` exists for it). Tags are kebab-case strings; axis-prefixed tags use the form `axis:value` (e.g. `family:cooperative-safepoints`, `off-cost:zero`). Use `axis` to narrow to one axis.",
      inputSchema: {
        axis: z
          .string()
          .optional()
          .describe(
            "Filter to tags belonging to a single axis (e.g. 'family', 'off-cost').",
          ),
      },
    },
    safeTool(async ({ axis }) => listTagsSummary(getBundle(), axis)),
  );

  server.registerTool(
    "get_tag",
    {
      title: "Get tag",
      description:
        "Return a tag's descriptor (if one is defined under `tags/`) plus every section across the corpus that carries it. Useful for cross-cutting views — e.g. every section tagged `compiler`, or every section under `family:cooperative-safepoints`.",
      inputSchema: {
        tag: z
          .string()
          .describe(
            "Tag literal (e.g. 'compiler' or 'family:cooperative-safepoints').",
          ),
      },
    },
    safeTool(async ({ tag }) => tagSummary(getBundle(), tag)),
  );

  server.registerTool(
    "list_axes",
    {
      title: "List tag axes",
      description:
        "Return every tag axis with the values that appear under it. An axis is a `colon-prefix` shared by several tags so the corpus can be compared along one dimension; conventional axes are `domain`, `family`, `off-cost`, `on-cost`, and `granularity` (see README for tier values).",
      inputSchema: {},
    },
    safeTool(async () => listAxesSummary(getBundle())),
  );

  server.registerTool(
    "get_axis",
    {
      title: "Get axis grouping",
      description:
        "Return every tag value along one axis with the sections grouped under each — the comparison-table view from the static site. Useful for surveys like 'which mechanism families are recorded?' or 'which records are tagged `off-cost:zero`?'.",
      inputSchema: {
        axis: z
          .string()
          .describe(
            "Axis name (e.g. 'family', 'off-cost', 'on-cost', 'granularity', 'domain').",
          ),
      },
    },
    safeTool(async ({ axis }) => axisSummary(getBundle(), axis)),
  );

  server.registerTool(
    "search",
    {
      title: "Search corpus",
      description:
        "Case-insensitive substring search across record names, summaries, aliases, section titles, section body content, and tags. Returns hits with short snippets around the match. Default `scope` is `both` (records and sections); use `record` or `section` to narrow. Reach for this when you need full-text content matches; use `list_records` when filtering structurally by kind/tag.",
      inputSchema: {
        query: z.string().min(1).describe("Search string."),
        scope: z
          .enum(["record", "section", "both"])
          .optional()
          .describe(
            "Limit results to records, sections, or both. Default 'both'.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries returned. Default 50."),
      },
    },
    safeTool(async ({ query, scope, limit }) =>
      searchCorpus(getBundle(), { query, scope, limit }),
    ),
  );

  server.registerTool(
    "get_cross_refs",
    {
      title: "Get cross-references",
      description:
        "Return both outbound `refs` (this record/section → others) and inbound `backlinks` (others → this), with destination record/section names resolved. Each edge carries a kebab-case `type` (e.g. `related`, `contrasts-with`, `instance-of`, `compared-with`). Use this to understand what a record builds on and what depends on it.",
      inputSchema: {
        id: z.string().describe("Record id."),
        section: z
          .string()
          .optional()
          .describe(
            "Section id. If omitted, refs/backlinks for all sections of the record are returned.",
          ),
      },
    },
    safeTool(async ({ id, section }) => crossRefs(getBundle(), id, section)),
  );

  return server;
}
