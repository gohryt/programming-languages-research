# Programming Languages Research

A corpus of programming-language design and implementation research — parsing, type systems, IRs, compilers, concurrency, debuggers, tracers, memory models, modules, packaging — stored as JSON records under `data/`. A static site renders the corpus for humans; a [Model Context Protocol](https://modelcontextprotocol.io) endpoint serves it to AI agents.

Records are language-agnostic. Write "a new language" or "a compiler" — not project-specific recommendations.

## Repository layout

```
data/                       # research records, one JSON file per record
tags/                       # optional tag descriptors
schema/                     # JSON Schemas for records and tag descriptors
source/research.js          # entry: validates data/, writes summary/data.json, serves UI + /mcp
source/lib/                 # supporting modules (records, schema, mcp, acme, serve)
summary/index.html          # static site (consumes summary/data.json)
deploy/programming-languages-research.service  # systemd user unit
```

## Workflow

Edit JSON files in `data/` directly; commit with git.

```sh
npm install              # one-time
npm start                # validate, write summary/data.json, serve UI + /mcp
npm run check            # validate only — for pre-commit / CI
```

`npm start` is `node source/research.js`. Run with `--help` for flags.

## MCP server

`/mcp` exposes the corpus over Streamable HTTP (stateless). CORS is permissive.

**Tools:** `list_records` (filter by kind / tag intersection / tag union / substring), `get_record` (full record or one section), `list_tags`, `get_tag`, `list_axes`, `get_axis`, `search` (snippets), `get_cross_refs` (resolved inbound + outbound).

**Resources:** `research://index`, `research://record/{id}`, `research://record/{id}/{section}`, `research://tag/{tag}`, `research://axis/{axis}`.

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

Runs as a **systemd user unit** out of `~/.programming-languages-research`. Auto-TLS via Let's Encrypt is provisioned on first run when `--host` is a public hostname; cached under `.acme/<domain>/`, renewed ~30 days before expiry. `--allowed-host` gates DNS-rebinding attacks.

### Prerequisites

- DNS A/AAAA record points at the VPS.
- Inbound `:80` (HTTP-01) and `:443` (TLS) reachable.
- `git`, `node`, `npm` installed (`sudo pacman -S --noconfirm git nodejs npm` on Arch).

### One-time system setup

User units can't grant `CAP_NET_BIND_SERVICE` on their own, so lower the unprivileged port floor and enable lingering for the deploy user (so the service survives logout and starts at boot):

```sh
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/50-unprivileged-ports.conf
sudo sysctl --system
sysctl net.ipv4.ip_unprivileged_port_start
# expected: net.ipv4.ip_unprivileged_port_start = 80

sudo loginctl enable-linger "$USER"
```

If the verification line doesn't print `80`, the service will hit `EACCES` when binding `:80` for the ACME challenge.

### Install

SSH in as the user the service should run as (e.g. `linuxuser`):

```sh
git clone https://github.com/gohryt/programming-languages-research.git ~/.programming-languages-research
cd ~/.programming-languages-research
npm ci --omit=dev

mkdir -p ~/.config/systemd/user
cp deploy/programming-languages-research.service \
   ~/.config/systemd/user/programming-languages-research.service
$EDITOR ~/.config/systemd/user/programming-languages-research.service
# replace programming-languages-research.example.com → your hostname
# replace admin@example.com → your contact for Let's Encrypt expiry notices

systemctl --user daemon-reload
systemctl --user enable --now programming-languages-research.service
journalctl --user -u programming-languages-research.service -f
```

When you see `[acme] certificate provisioned (expires …)` followed by `Serving …`, the site is live.

### Deploying updates

Push to GitHub from your dev machine, then on the VPS:

```sh
cd ~/.programming-languages-research
git pull
npm ci --omit=dev
systemctl --user restart programming-languages-research.service
```

No `sudo` after the one-time system setup.

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
3. `npm run check` validates schema and resolves every cross-ref.
4. Commit, push to GitHub, then on the VPS: `cd ~/.programming-languages-research && git pull && npm ci --omit=dev && systemctl --user restart programming-languages-research.service`.
