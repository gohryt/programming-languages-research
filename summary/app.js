import { marked } from "https://esm.sh/marked@13.0.3";

marked.use({ gfm: true, breaks: false });

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderMarkdownBlock(text) {
  return marked.parse(text ?? "");
}

function parseHash() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : "";
  const params = new URLSearchParams(hash);
  return {
    record: params.get("record"),
    section: params.get("section"),
    tag: params.get("tag"),
    axis: params.get("axis"),
    kind: params.get("kind"),
    search: params.get("search"),
  };
}

function sectionAnchor(recordId, sectionId) {
  return `${recordId}#${sectionId}`;
}

function buildSectionIndex(data) {
  const map = new Map();
  for (const [recordId, record] of Object.entries(data.records)) {
    for (const section of record.sections) {
      map.set(section.anchor ?? sectionAnchor(recordId, section.id), {
        recordId,
        record,
        section,
      });
    }
  }
  return map;
}

function buildTagIndex(data) {
  const map = new Map();
  for (const [recordId, record] of Object.entries(data.records)) {
    for (const section of record.sections) {
      for (const tag of section.tags) {
        if (!map.has(tag)) {
          map.set(tag, []);
        }
        map.get(tag).push({ recordId, record, section });
      }
    }
  }
  for (const entries of map.values()) {
    entries.sort((left, right) => {
      const byRecord = left.record.name.localeCompare(right.record.name);
      return byRecord !== 0
        ? byRecord
        : left.section.title.localeCompare(right.section.title);
    });
  }
  return map;
}

function buildKindIndex(data) {
  const map = new Map();
  for (const [recordId, record] of Object.entries(data.records)) {
    if (!map.has(record.kind)) {
      map.set(record.kind, []);
    }
    map.get(record.kind).push({ recordId, record });
  }
  for (const entries of map.values()) {
    entries.sort((left, right) =>
      left.record.name.localeCompare(right.record.name),
    );
  }
  return map;
}

function buildSearchIndex(data) {
  const entries = [];
  for (const [recordId, record] of Object.entries(data.records)) {
    entries.push({
      type: "record",
      recordId,
      title: record.name,
      kind: record.kind,
      tags: record.derivedTags ?? [],
      text: `${record.summary ?? ""} ${(record.aliases ?? []).join(" ")}`.toLowerCase(),
    });
    for (const section of record.sections) {
      entries.push({
        type: "section",
        recordId,
        sectionId: section.id,
        title: `${record.name} — ${section.title}`,
        kind: record.kind,
        tags: section.tags,
        text: `${section.title} ${section.content} ${section.tags.join(" ")}`.toLowerCase(),
      });
    }
  }
  return entries;
}

function renderTagPills(tags, clickable = true) {
  return tags
    .map((tag) =>
      clickable
        ? `<a class="tag-pill" href="#tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`
        : `<span class="tag-pill">${escapeHtml(tag)}</span>`,
    )
    .join("");
}

function renderSources(sources) {
  if (!sources || sources.length === 0) {
    return "";
  }
  const items = sources
    .map((source) => {
      const label = source.label
        ? escapeHtml(source.label)
        : escapeHtml(source.url);
      return `<li><a href="${escapeHtml(source.url)}">${label}</a></li>`;
    })
    .join("");
  return `<details class="meta-block"><summary>Sources</summary><ul class="link-list">${items}</ul></details>`;
}

function renderContent(section) {
  let html = renderMarkdownBlock(section.content);
  for (const mention of section.mentions ?? []) {
    const [recordId, sectionId] = mention.target.split("#");
    const href = `#record=${encodeURIComponent(recordId)}${sectionId ? `&section=${encodeURIComponent(sectionId)}` : ""}`;
    const pattern = new RegExp(
      `>([^<]*)\\b${escapeRegExp(mention.alias)}\\b([^<]*)<`,
      "i",
    );
    html = html.replace(
      pattern,
      (match, before, after) =>
        `>${before}<a href="${href}">${escapeHtml(mention.alias)}</a>${after}<`,
    );
  }
  return html;
}

function groupByType(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.type)) {
      groups.set(item.type, []);
    }
    groups.get(item.type).push(item);
  }
  return Array.from(groups.entries()).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
}

function renderGroupedLinks(title, items, sectionIndex) {
  if (!items || items.length === 0) {
    return "";
  }
  const groups = groupByType(items);
  const body = groups
    .map(([type, group]) => {
      const entries = group
        .map((item) => {
          const target = sectionIndex.get(item.target ?? item.source);
          const label = target
            ? `${target.record.name} — ${target.section.title}`
            : (item.target ?? item.source);
          const refTarget = item.target ?? item.source;
          const [recordId, sectionId] = refTarget.split("#");
          const href = `#record=${encodeURIComponent(recordId)}${sectionId ? `&section=${encodeURIComponent(sectionId)}` : ""}`;
          return `<li><a href="${href}">${escapeHtml(label)}</a></li>`;
        })
        .join("");
      return `<div class="link-group"><h5>${escapeHtml(type)}</h5><ul class="link-list">${entries}</ul></div>`;
    })
    .join("");
  return `<details class="meta-block"><summary>${escapeHtml(title)}</summary>${body}</details>`;
}

function renderNav(data) {
  const tags = renderTagPills(data.indexes.tags);
  const kinds = data.indexes.kinds
    .map(
      (kind) =>
        `<a class="tag-pill" href="#kind=${encodeURIComponent(kind)}">${escapeHtml(kind)}</a>`,
    )
    .join("");
  const axes = Object.keys(data.indexes.tagAxes ?? {})
    .sort()
    .map(
      (axis) =>
        `<a class="tag-pill" href="#axis=${encodeURIComponent(axis)}">${escapeHtml(axis)}</a>`,
    )
    .join("");
  return `
    <section class="panel page-topbar compact-panel">
      <div class="controls compact-controls">
        <a href="#index">Index</a>
        <span class="muted">Kinds:</span>
        <div>${kinds}</div>
        ${axes ? `<span class="muted">Axes:</span><div>${axes}</div>` : ""}
      </div>
      <form class="search-form" onsubmit="event.preventDefault(); window.location.hash = 'search=' + encodeURIComponent(this.query.value);">
        <input name="query" type="search" placeholder="Search records, sections, tags" />
        <button type="submit">Search</button>
      </form>
    </section>
    <section class="panel compact-panel browse-tags-panel">
      <details>
        <summary>Browse tags</summary>
        <div class="browse-tags-body">${tags}</div>
      </details>
    </section>
  `;
}

function renderRecordToc(recordId, record) {
  const items = record.sections
    .map(
      (section) =>
        `<li><a href="#record=${encodeURIComponent(recordId)}&section=${encodeURIComponent(section.id)}">${escapeHtml(section.title)}</a></li>`,
    )
    .join("");
  return `
      <div class="inline-toc">
        <h3>Contents</h3>
        <ul class="record-list">${items}</ul>
      </div>
  `;
}

function renderRecordView(recordId, record, selectedSection, sectionIndex) {
  const sections = record.sections
    .map((section, index) => {
      const isSelected = selectedSection === section.id;
      return `
      <article class="section${isSelected ? " section-selected" : ""}" id="${escapeHtml(section.id)}">
        <h3>${escapeHtml(section.title)}</h3>
        <div>${renderTagPills(section.tags)}</div>
        <div class="section-content">${renderContent(section)}</div>
        ${renderGroupedLinks("References", section.refs ?? [], sectionIndex)}
        ${renderGroupedLinks(
          "Referenced by",
          (section.backlinks ?? []).map((entry) => ({
            source: entry.source,
            type: entry.type,
          })),
          sectionIndex,
        )}
        ${renderGroupedLinks(
          "Mentioned",
          (section.mentions ?? []).map((entry) => ({
            target: entry.target,
            type: "mention",
          })),
          sectionIndex,
        )}
        ${renderSources(section.sources ?? [])}
      </article>
      ${index < record.sections.length - 1 ? '<hr class="section-divider" />' : ""}
    `;
    })
    .join("");

  return `
    <section class="panel record-header compact-panel">
      <h2>${escapeHtml(record.name)}</h2>
      <p>${escapeHtml(record.summary ?? "")}</p>
      <div>${renderTagPills(record.derivedTags ?? [])}</div>
      ${selectedSection ? `<p class="muted">Focused section: ${escapeHtml(selectedSection)}</p>` : ""}
      ${renderSources(record.sources ?? [])}
      ${renderRecordToc(recordId, record)}
    </section>
    <section class="panel compact-panel document-panel">
      ${sections}
    </section>
  `;
}

function renderTagDescriptorBlock(descriptor) {
  if (!descriptor) return "";
  const parts = [];
  if (descriptor.name) {
    parts.push(`<h3>${escapeHtml(descriptor.name)}</h3>`);
  }
  if (descriptor.axis) {
    parts.push(
      `<p class="muted">Axis: <a href="#axis=${encodeURIComponent(descriptor.axis)}">${escapeHtml(descriptor.axis)}</a></p>`,
    );
  }
  if (descriptor.parent) {
    parts.push(
      `<p class="muted">Parent: <a href="#tag=${encodeURIComponent(descriptor.parent)}">${escapeHtml(descriptor.parent)}</a></p>`,
    );
  }
  if (descriptor.description) {
    parts.push(
      `<div class="section-content">${renderMarkdownBlock(descriptor.description)}</div>`,
    );
  }
  if ((descriptor.aliases ?? []).length > 0) {
    const aliases = descriptor.aliases
      .map(
        (a) =>
          `<a class="tag-pill" href="#tag=${encodeURIComponent(a)}">${escapeHtml(a)}</a>`,
      )
      .join("");
    parts.push(`<div><span class="muted">Aliases:</span> ${aliases}</div>`);
  }
  if ((descriptor.examples ?? []).length > 0) {
    const examples = descriptor.examples
      .map(
        (id) =>
          `<a class="tag-pill" href="#record=${encodeURIComponent(id)}">${escapeHtml(id)}</a>`,
      )
      .join("");
    parts.push(`<div><span class="muted">Examples:</span> ${examples}</div>`);
  }
  return parts.join("");
}

function renderTagView(tag, entries, data) {
  const descriptor =
    (data.tagDescriptors && data.tagDescriptors[tag]) || null;
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.recordId)) {
      grouped.set(entry.recordId, { record: entry.record, sections: [] });
    }
    grouped.get(entry.recordId).sections.push(entry.section);
  }
  const body = Array.from(grouped.entries())
    .map(
      ([recordId, group]) => `
    <section class="panel compact-panel">
      <h3><a href="#record=${encodeURIComponent(recordId)}">${escapeHtml(group.record.name)}</a></h3>
      <ul class="section-list">
        ${group.sections
          .map(
            (section) => `
          <li>
            <a href="#record=${encodeURIComponent(recordId)}&section=${encodeURIComponent(section.id)}">${escapeHtml(section.title)}</a>
            <div>${renderTagPills(section.tags, false)}</div>
          </li>
        `,
          )
          .join("")}
      </ul>
    </section>
  `,
    )
    .join("");

  return `
    <section class="panel compact-panel">
      <h2>Tag <code>${escapeHtml(tag)}</code></h2>
      <p class="muted">Sections across the corpus that carry this tag — ${entries.length} match${entries.length === 1 ? "" : "es"}${descriptor ? "" : ". No descriptor file under <code>tags/</code> for this one yet."}</p>
      ${renderTagDescriptorBlock(descriptor)}
    </section>
    ${body}
  `;
}

function renderAxisView(axis, data, tagIndex) {
  const tags = (data.indexes.tagAxes && data.indexes.tagAxes[axis]) || [];
  if (tags.length === 0) {
    return `
      <section class="panel compact-panel">
        <h2>Axis <code>${escapeHtml(axis)}</code></h2>
        <p class="muted">No tags registered under this axis yet.</p>
      </section>
    `;
  }
  const groups = tags
    .map((tag) => {
      const entries = tagIndex.get(tag) ?? [];
      const descriptor =
        (data.tagDescriptors && data.tagDescriptors[tag]) || null;
      const items = entries
        .map(
          (entry) =>
            `<li><a href="#record=${encodeURIComponent(entry.recordId)}&section=${encodeURIComponent(entry.section.id)}">${escapeHtml(entry.record.name)} — ${escapeHtml(entry.section.title)}</a><div>${renderTagPills(entry.section.tags, true)}</div></li>`,
        )
        .join("");
      return `
        <section class="panel compact-panel">
          <h3><a href="#tag=${encodeURIComponent(tag)}"><code>${escapeHtml(tag)}</code></a> <span class="muted">(${entries.length})</span></h3>
          ${descriptor && descriptor.name ? `<p>${escapeHtml(descriptor.name)}${descriptor.description ? " — " + escapeHtml(descriptor.description) : ""}</p>` : ""}
          <ul class="section-list">${items}</ul>
        </section>
      `;
    })
    .join("");
  return `
    <section class="panel compact-panel">
      <h2>Axis <code>${escapeHtml(axis)}</code></h2>
      <p class="muted">Side-by-side comparison along this axis — ${tags.length} tag value${tags.length === 1 ? "" : "s"}, sections grouped under each. Use this view to scan how different records position themselves on one dimension.</p>
    </section>
    ${groups}
  `;
}

function renderKindView(kind, entries) {
  const list = entries
    .map(
      ({ recordId, record }) => `
    <li>
      <a href="#record=${encodeURIComponent(recordId)}">${escapeHtml(record.name)}</a>
      <div class="muted">${escapeHtml(record.summary ?? "")}</div>
      <div>${renderTagPills(record.derivedTags ?? [], false)}</div>
    </li>
  `,
    )
    .join("");

  return `
    <section class="panel compact-panel">
      <h2>Records of kind <code>${escapeHtml(kind)}</code></h2>
      <p class="muted">${entries.length} record${entries.length === 1 ? "" : "s"} classified under <code>${escapeHtml(kind)}</code>.</p>
      <ul class="record-list">${list}</ul>
    </section>
  `;
}

function renderSearchView(query, entries) {
  const normalized = query.toLowerCase();
  const filtered = entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(normalized) ||
      entry.text.includes(normalized) ||
      (entry.tags ?? []).some((tag) => tag.includes(normalized)),
  );
  const body = filtered
    .map((entry) => {
      if (entry.type === "record") {
        return `<li><a href="#record=${encodeURIComponent(entry.recordId)}">${escapeHtml(entry.title)}</a> <span class="muted">(${escapeHtml(entry.kind)})</span></li>`;
      }
      return `<li><a href="#record=${encodeURIComponent(entry.recordId)}&section=${encodeURIComponent(entry.sectionId)}">${escapeHtml(entry.title)}</a> <span class="muted">(${escapeHtml(entry.kind)})</span> <div>${renderTagPills(entry.tags ?? [], false)}</div></li>`;
    })
    .join("");

  return `
    <section class="panel compact-panel">
      <h2>Search results for <code>${escapeHtml(query)}</code></h2>
      <p class="muted">${filtered.length} match${filtered.length === 1 ? "" : "es"} across record metadata, section content, and tags.</p>
      <ul class="record-list">${body}</ul>
    </section>
  `;
}

function renderIndex(data) {
  const entries = Object.entries(data.records).sort((left, right) =>
    left[1].name.localeCompare(right[1].name),
  );
  const list = entries
    .map(
      ([recordId, record]) => `
      <li>
        <a href="#record=${encodeURIComponent(recordId)}">${escapeHtml(record.name)}</a>
        <span class="muted">(${escapeHtml(record.kind)})</span>
        <div class="muted">${escapeHtml(record.summary ?? "")}</div>
        <div>${renderTagPills(record.derivedTags ?? [], false)}</div>
      </li>
    `,
    )
    .join("");

  return `
    <section class="panel compact-panel">
      <h2>All records <span class="muted">(${entries.length})</span></h2>
      <p class="muted">Browse the corpus alphabetically. Use the controls above to narrow by kind or axis, or search across the whole corpus.</p>
      <ul class="record-list">${list}</ul>
    </section>
  `;
}

async function main() {
  const response = await fetch("./data.json");
  const data = await response.json();
  const sectionIndex = buildSectionIndex(data);
  const tagIndex = buildTagIndex(data);
  const kindIndex = buildKindIndex(data);
  const searchIndex = buildSearchIndex(data);
  const route = parseHash();
  const content = document.getElementById("content");

  let body = renderNav(data);

  if (route.record) {
    const record = data.records[route.record];
    if (!record) {
      body += `<section class="panel compact-panel"><h2>Record not found</h2><p>No record named <code>${escapeHtml(route.record)}</code> in the corpus. Check the <a href="#index">index</a> for valid ids.</p></section>`;
    } else {
      body += renderRecordView(
        route.record,
        record,
        route.section,
        sectionIndex,
      );
    }
  } else if (route.tag) {
    body += renderTagView(route.tag, tagIndex.get(route.tag) ?? [], data);
  } else if (route.axis) {
    body += renderAxisView(route.axis, data, tagIndex);
  } else if (route.kind) {
    body += renderKindView(route.kind, kindIndex.get(route.kind) ?? []);
  } else if (route.search) {
    body += renderSearchView(route.search, searchIndex);
  } else {
    body += renderIndex(data);
  }

  content.innerHTML = body;

  if (route.section) {
    const element = document.getElementById(route.section);
    if (element) {
      element.scrollIntoView({ block: "start" });
    }
  }
}

window.addEventListener("hashchange", () => {
  main().catch((error) => {
    document.getElementById("content").innerHTML =
      `<section class="panel"><h2>Failed to load corpus</h2><pre>${escapeHtml(String(error))}</pre></section>`;
  });
});

main().catch((error) => {
  document.getElementById("content").innerHTML =
    `<section class="panel"><h2>Error</h2><pre>${escapeHtml(String(error))}</pre></section>`;
});
