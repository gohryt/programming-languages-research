# Research Index and Ownership Guide

This directory collects language-design research across parsing, compilation, debugging, tracing, program representations, memory management, and module/package boundaries.

The goal is to make the notes useful to any programming-language implementer. Keep the documents language-agnostic: prefer phrases like "a new language", "a compiler", "a runtime", or "a language server" rather than project-specific names.

---

## Documents

| File | Owns | Use it for |
|---|---|---|
| `PARSERS.md` | Characters → tokens → parse trees | Parser architectures, source positions, lexing, error recovery, parser-output AST/CST concerns |
| `REPRESENTATIONS.md` | Program representation catalogue | CSTs, AST layouts, HIR/MIR/SSA, bytecode, e-graphs, content-addressed IRs, target-adjacent formats |
| `COMPILERS.md` | Compiler pipeline and execution strategy | Lowering, optimization, code generation, backends, JIT tiers, compiler-emitted debug metadata |
| `DEBUGGERS.md` | Debugger workflows and protocols | Breakpoints, record/replay, time travel, debugger protocols, DWARF correctness, fault isolation |
| `TRACERS.md` | Runtime observability and profiling | Tracing, profiling, probes, event pipelines, trace storage, visualization, continuous profiling |
| `MEMORY.md` | Memory models and memory safety | Ownership, borrowing, regions, RC, GC, allocators, hardware safety, verification, reclamation, capabilities |
| `MODULES.md` | Module/package boundaries | Imports, package identity, linking boundaries, dynamic loading, hot reload at the module-system level |

---

## Canonical Ownership Table

When adding new research, put the full treatment in the canonical document and keep other mentions short.

| Topic | Canonical document | Non-canonical documents should contain |
|---|---|---|
| Parser algorithms | `PARSERS.md` | A short cross-reference only |
| Lexing/tokenization | `PARSERS.md` | A note only when relevant to tooling/runtime |
| Source locations during parsing | `PARSERS.md` | Cross-reference from compiler/debugger metadata sections |
| Concrete syntax trees | `REPRESENTATIONS.md` | Parser-specific implications in `PARSERS.md` |
| AST layouts | `REPRESENTATIONS.md` | Parser-output capsules in `PARSERS.md` |
| HIR/MIR/SSA/bytecode representations | `REPRESENTATIONS.md` | Compiler-pass implications in `COMPILERS.md` |
| Compiler lowering and optimization | `COMPILERS.md` | Representation or runtime docs should only link back |
| Backends and code generation | `COMPILERS.md` | Runtime/tracing docs should mention only integration points |
| JIT tiers and deoptimization | `COMPILERS.md` | Debugger/tracer docs should discuss only observability implications |
| Debugger UX and protocols | `DEBUGGERS.md` | Tracing docs should avoid repeating workflow details |
| Breakpoint mechanisms | `DEBUGGERS.md` | `TRACERS.md` may discuss shared patching/probe mechanics |
| Record/replay and time travel | `DEBUGGERS.md` | `TRACERS.md` may discuss trace storage or event substrates |
| Runtime event pipelines | `TRACERS.md` | Debugger docs may discuss query/debug workflows over traces |
| Profiling and sampling | `TRACERS.md` | Compiler/debugger docs should mention required metadata only |
| Trace formats and viewers | `TRACERS.md` | Debugger docs may mention analysis/query use cases |
| Ownership and borrowing | `MEMORY.md` | Compiler docs may discuss IR requirements |
| Region systems | `MEMORY.md` | Compiler docs may discuss region inference/lowering only |
| Reference counting and GC | `MEMORY.md` | Compiler docs may discuss optimization of RC/GC barriers only |
| Allocator APIs | `MEMORY.md` | Compiler docs may discuss internal compiler arenas only |
| Sanitizers | `TRACERS.md` | `MEMORY.md` discusses the safety model; `DEBUGGERS.md` discusses debugging use |
| Module identity and import semantics | `MODULES.md` | Compiler/runtime docs should mention implementation consequences only |
| Hot reload at module boundaries | `MODULES.md` | Compiler/debugger docs may discuss code replacement mechanics |

---

## Cross-Reference Policy

Use cross-references to avoid repeating full explanations.

Good pattern:

> Full representation details are in `REPRESENTATIONS.md §5.1`; this section focuses on the compiler-pass consequences.

Avoid copying a full subsection into multiple documents. If a topic belongs to another document, keep only:

1. one or two sentences of local context;
2. the reason this document cares;
3. a cross-reference to the canonical section.

---

## Source, Citation, and Status Style

Use inline source lines for local provenance:

- `Source:` for one source.
- `Sources:` for multiple sources.

Examples:

- `Source: https://example.com/paper`
- `Sources: https://example.com/paper and https://example.com/docs`

Use inline sources when a claim is specific, surprising, implementation-dependent, numeric, historical, or likely to be checked by a reader. Broad background claims may rely on the final references section instead.

Each document should also keep a final `References` section. The standard preamble is:

> References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

Avoid repeating long inline source lines in non-canonical capsule sections when the canonical document already cites them.

For date-sensitive claims, include an explicit date or version marker near the claim. Prefer one of these forms:

- `Status (as of 2026-04): ...`
- `Status (JDK 25): ...`
- `As of early 2026, ...`
- `Scheduled for 2026-Q2, ...`

Date-sensitive claims include standards-process status, release availability, deprecation/removal status, production-readiness, experimental/stable labels, and vendor roadmap statements. If the date is uncertain, keep the wording conservative rather than implying current truth.

---

## Writing Guidelines

- Keep the research language-agnostic.
- Prefer system names and technique names over project-specific recommendations.
- Separate mechanism from policy:
  - mechanism: how something works;
  - policy: when a language should choose it.
- When a topic crosses documents, explicitly name the ownership boundary.
- Preserve useful trade-offs: space cost, time cost, disabled overhead, annotation burden, implementation complexity, and tooling consequences.
- Mark date-sensitive claims with a date when possible, especially implementation status or standards-process status.
- Do not add broad surveys to non-canonical documents; add short capsules and cross-references instead.

---

## Suggested Document Shape

Each large research document should roughly follow this structure:

1. Scope and ownership note.
2. Main survey chapters.
3. Summary table or mechanism-family summary.
4. References.

Optional but useful:

- "Design implications" sections, written generically for language implementers.
- "Do not duplicate; see ..." notes for heavily cross-linked topics.

---

## Maintenance Checklist

Before adding or expanding a section:

- [ ] Is this the canonical document for the topic?
- [ ] If not, can this be a short capsule plus cross-reference?
- [ ] Does the section duplicate another explanation?
- [ ] Are source lines using `Source:` / `Sources:` correctly?
- [ ] Is the wording language-agnostic?
- [ ] Are date-sensitive claims marked with a date or status?
- [ ] Does the summary table need a new row?
- [ ] Does the final references section need an entry?