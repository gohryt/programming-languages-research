# Programming Languages Research

A corpus of programming-language design and implementation research — parsing, type systems, IRs, compilers, concurrency, debuggers, tracers, memory models, modules, packaging — stored as JSON records under `data/`. A static site renders the corpus for humans; a [Model Context Protocol](https://modelcontextprotocol.io) endpoint serves it to AI agents.

Records are language-agnostic. Write "a new language" or "a compiler" — not project-specific recommendations.

## Repository layout

```
data/                       # research records, one JSON file per record
tags/                       # optional tag descriptors
schema/                     # JSON Schemas for records and tag descriptors
research.rs                 # Rust entry: validates data/, writes static/data.json, serves UI + /mcp
static/index.html           # static site (consumes static/data.json)
deploy/programming-languages-research.service  # systemd user unit
```

## Workflow

Edit JSON files in `data/` directly; commit with git.

Local development:

```sh
cargo build --release
cargo run --release --
cargo run --release -- --build-summary
```

Install directly from GitHub:

```sh
curl -fsSL https://raw.githubusercontent.com/gohryt/programming-languages-research/main/install.sh | sh -s -- --host programming-languages-research.example.com --email admin@example.com
```

## MCP server

`/mcp` exposes the corpus over Streamable HTTP (stateless). CORS is permissive.

**Tools:** `list_records` (filter by kind / tag intersection / tag union / substring), `get_record` (full record or one section), `list_tags`, `get_tag`, `list_axes`, `get_axis`, `search` (snippets), `get_cross_refs` (resolved inbound + outbound).

Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "research": {
      "type": "http",
      "url": "https://research.example.com/mcp"
    }
  }
}
```

For local development point the URL at `http://127.0.0.1:8000/mcp`.

## Production deployment

Runs as a **systemd user unit** out of `~/.programming-languages-research`. When `--host` is a public hostname, the Rust server provisions and renews Let's Encrypt certificates automatically via ACME; the account and certificates are cached under `.acme/<domain>/`. `--allowed-host` still gates DNS-rebinding attacks.

### Prerequisites

- DNS A/AAAA record points at the VPS.
- Inbound `:80` and `:443` reachable.

### One-time system setup

User units cannot grant `CAP_NET_BIND_SERVICE`, so lower the unprivileged port floor system-wide and enable lingering for the deploy user:

```sh
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/50-unprivileged-ports.conf
sudo sysctl --system

sudo loginctl enable-linger "$USER"
```

### Install

SSH in as the user the service should run as (e.g. `linuxuser`) and run the installer:

```sh
curl -fsSL https://raw.githubusercontent.com/gohryt/programming-languages-research/main/install.sh | sh -s -- --host programming-languages-research.example.com --email admin@example.com
```

To update later, run the same command again.

The installer downloads the latest bundle release, installs it under `~/.programming-languages-research`, writes the systemd user unit, reloads the user daemon, and starts the service.

When you see ACME events followed by `Serving ...`, the site is live.

No `sudo` is needed after the one-time system setup.

## GitHub Releases

A GitHub Actions workflow at `.github/workflows/release.yml` builds release artifacts on every push to `main` and on manual dispatch using the nightly toolchain. It publishes:

- `programming-languages-research-bundle.tar.gz` — primary bundle archive containing the executable and generated static assets
- `programming-languages-research-static.tar.gz` — static-only archive containing `static/`

The workflow generates `static/data.json` via `--build-summary`, then packages the resulting `static/` contents into the release.

## Record shape

Records are JSON files in `data/`, validated against `schema/record.schema.json`. Top-level fields:

- `kind` — `language`, `framework`, `tool`, `runtime`, `concept`, or `library`
- `name` — display name
- `summary` — one or two sentences
- `aliases` — strings the site uses to auto-link mentions in other records' content
- `sections` — `[{ id, title, tags, content, refs?, sources? }]`; section ids are kebab-case, unique within the record
- `sources` — `[{ label?, url }]` for record-wide citations
- `provenance` — optional `{ createdAt, updatedAt }` ISO timestamps

Inside a section, `refs` is `[{ target, type }]`. The `target` is `record-id` or `record-id#section-id`; `type` is a kebab-case label (`related`, `contrasts-with`, `instance-of`, `compared-with`, …). Section-level URLs go in the section's `sources`; broad references at top level.

Mark date-sensitive claims (production status, standards-process state, deprecations) with `Status (as of 2026-04): …` or `Status (JDK 25): …`. Don't invent URLs.

## Tags

Tags are kebab-case strings inside section `tags[]` arrays — no central registry, anyone can introduce one. Two forms:

- **Plain:** `compiler`, `ebpf`, `jvm` — for technology / property tags.
- **Axis-prefixed:** `axis:value` — `family:cooperative-safepoints`, `off-cost:zero`, `granularity:per-event` — for one value along a comparison axis the site can group by.

Document a tag with `tags/<id>.json` (filename is the tag with `:` → `-`). Schema: `schema/tag.schema.json`. Required fields: `tag`, `name`. Optional: `description`, `axis`, `aliases`, `parent`, `examples`. A tag without a descriptor still works.

### Conventional axes

| Axis | Tier values | Meaning |
|---|---|---|
| `domain` | `tracing`, `debugging`, `profiling`, `observability` | Topic cluster. |
| `family` | open-ended | Mechanism family — comparison view. |
| `off-cost` | `zero`, `low`, `medium`, `always-on` | Steady-state overhead when off. |
| `on-cost` | `low`, `medium`, `high`, `dominant` | Active overhead when on. |
| `granularity` | open-ended | Unit of observation/effect. |

Conventions, not requirements.

## Cross-references

Use `refs` to point at canonical records / sections instead of duplicating prose. The good pattern: 1–2 sentences of local context, the reason this record cares, then the cross-ref. Inline mentions of other record names auto-link via the `aliases` index.

## Adding a record

1. Create `data/<id>.json` (kebab-case id matches the filename):
   ```json
   {
     "kind": "concept",
     "name": "Display Name",
     "summary": "One- or two-sentence orientation.",
     "sections": [
       { "id": "overview", "title": "Overview", "tags": [], "content": "" }
     ]
   }
   ```
2. Add a `refs` entry on at least one umbrella record's section so the new record is reachable.
3. `cargo run --release -- --build-summary` validates and rebuilds the generated summary without starting the server.
4. Commit and push to `main`; GitHub Actions publishes updated release artifacts. On the VPS, rerun the installer or replace static assets from the latest release and restart the service.
