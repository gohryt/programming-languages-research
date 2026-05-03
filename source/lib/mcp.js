export async function loadMcpModules() {
  try {
    const mcpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const transportModule = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    let z;
    try {
      // SDK imports from the `zod/v4` subpath (Zod v4, or v3.25+'s shim).
      z = await import("zod/v4");
    } catch (_zodV4Error) {
      const zodModule = await import("zod");
      z = zodModule.z ?? zodModule.default ?? zodModule;
    }
    return {
      McpServer: mcpModule.McpServer,
      ResourceTemplate: mcpModule.ResourceTemplate,
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

function jsonResource(uri, value) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
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

function safeResource(fn) {
  return async (uri, vars) => jsonResource(uri, await fn(uri, vars));
}

function decoded(value) {
  return decodeURIComponent(String(value));
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

function indexSummary(bundle) {
  const records = bundle.records ?? {};
  const entries = Object.entries(records)
    .map(([id, record]) => ({
      id,
      kind: record.kind,
      name: record.name,
      summary: record.summary ?? "",
      tags: record.derivedTags ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    generatedAt: bundle.generatedAt ?? null,
    count: entries.length,
    records: entries,
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

export function buildMcpServer({ McpServer, ResourceTemplate, z, getBundle }) {
  const server = new McpServer({
    name: "mage-research-corpus",
    version: "0.1.0",
  });

  server.registerTool(
    "list_records",
    {
      title: "List records",
      description:
        "List records in the research corpus, optionally filtered by kind, tag(s), or text match. " +
        "Use `tag` for AND-style filtering (every tag must match a section); use `tag_any` for OR-style.",
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
      title: "Get record",
      description:
        "Return one record by id, or one section if `section` is supplied. Includes content, refs, sources, and (for sections) backlinks and mentions.",
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
        "Return all tags used in the corpus, with usage counts and any descriptor metadata. Optionally filter to one axis.",
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
        "Return the descriptor (if any) for a tag along with every section that uses it.",
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
        "Return all tag axes (the colon-prefix grouping) with the values that appear under each.",
      inputSchema: {},
    },
    safeTool(async () => listAxesSummary(getBundle())),
  );

  server.registerTool(
    "get_axis",
    {
      title: "Get axis grouping",
      description:
        "Return all tag values along an axis with the sections grouped under each value (the comparison-table view from the static site).",
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
      title: "Full-text search",
      description:
        "Substring search (case-insensitive) over record/section content. Returns matched records and/or sections with short snippets.",
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
      title: "Get cross references",
      description:
        "Return outbound refs (this record/section → others) and inbound backlinks (others → this) with resolved record/section names.",
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

  server.registerResource(
    "index",
    "research://index",
    {
      title: "Research corpus index",
      description: "Compact list of every record (id, kind, name, summary).",
      mimeType: "application/json",
    },
    safeResource(async () => indexSummary(getBundle())),
  );

  server.registerResource(
    "record",
    new ResourceTemplate("research://record/{id}", { list: undefined }),
    {
      title: "Record",
      description: "Full record JSON by id.",
      mimeType: "application/json",
    },
    safeResource(async (_uri, vars) =>
      recordSummary(getBundle(), decoded(vars.id)),
    ),
  );

  server.registerResource(
    "section",
    new ResourceTemplate("research://record/{id}/{section}", {
      list: undefined,
    }),
    {
      title: "Record section",
      description:
        "One section of a record. Use `record/{id}` for the full record.",
      mimeType: "application/json",
    },
    safeResource(async (_uri, vars) =>
      sectionSummary(getBundle(), decoded(vars.id), decoded(vars.section)),
    ),
  );

  server.registerResource(
    "tag",
    new ResourceTemplate("research://tag/{tag}", { list: undefined }),
    {
      title: "Tag",
      description: "Tag descriptor and all sections that use it.",
      mimeType: "application/json",
    },
    safeResource(async (_uri, vars) =>
      tagSummary(getBundle(), decoded(vars.tag)),
    ),
  );

  server.registerResource(
    "axis",
    new ResourceTemplate("research://axis/{axis}", { list: undefined }),
    {
      title: "Axis",
      description: "Tag values along an axis with sections grouped under each.",
      mimeType: "application/json",
    },
    safeResource(async (_uri, vars) =>
      axisSummary(getBundle(), decoded(vars.axis)),
    ),
  );

  return server;
}
