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
deploy/research@.service    # systemd template unit (instance is the run-as user)
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

Auto-TLS via Let's Encrypt is provisioned on first run when `--host` is a public hostname; cached under `.acme/<domain>/`, renewed ~30 days before expiry. `--allowed-host` in the systemd unit gates DNS-rebinding attacks. The bundled unit grants `CAP_NET_BIND_SERVICE` so the run-as user can bind `:80` and `:443` without root.

### Prerequisites

- DNS A/AAAA record points at the VPS.
- Inbound `:80` (HTTP-01) and `:443` (TLS) reachable.
- `git`, `node`, `npm` installed (`sudo pacman -S --noconfirm git nodejs npm` on Arch).

### One-time setup

SSH in as the user the service should run as (e.g. `linuxuser`):

```sh
sudo mkdir -p /srv/research && sudo chown "$USER:$USER" /srv/research
git clone https://github.com/gohryt/programming-languages-research.git /srv/research
cd /srv/research && npm ci --omit=dev
```

Edit `deploy/research@.service` — replace `research.example.com` with your public hostname and `admin@example.com` with the address Let's Encrypt should use for expiry notices. Then install and start:

```sh
sudo cp deploy/research@.service /etc/systemd/system/research@.service
sudo systemctl daemon-reload
sudo systemctl enable --now "research@$USER.service"
sudo journalctl -u "research@$USER.service" -f
```

When you see `[acme] certificate provisioned (expires …)` followed by `Serving …`, the site is live.

### Deploying updates

Push to GitHub from your dev machine, then on the VPS:

```sh
cd /srv/research
git pull
npm ci --omit=dev
sudo systemctl restart "research@$USER.service"
```

To skip the sudo password on each deploy, drop a sudoers fragment at `/etc/sudoers.d/research-deploy` (replace `linuxuser` with your actual user):

```
linuxuser ALL=(root) NOPASSWD: /bin/systemctl restart research@linuxuser.service
```

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
4. Commit, push to GitHub, then on the VPS: `cd /srv/research && git pull && npm ci --omit=dev && sudo systemctl restart "research@$USER.service"`.
