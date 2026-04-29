# Packaging, Identity, Resolution, and Distribution

This document collects the *ecosystem-level* layer that sits above source-language module systems: how packages are identified, resolved, distributed, versioned, locked, registered, and built. The companion document `MODULES.md` covers language-level module mechanisms — imports, visibility, naming, encapsulation, cycles, and dynamic loading — and treats the *source-level* concerns of how modules work as code artifacts. This file owns the *distribution* concerns of how packages cross machines, ecosystems, and time.

The split exists because in production languages, source-level modularity and distribution-level packaging are usually distinct mechanisms even when they appear unified at first glance. Rust separates package, crate, and module identity. Go separates module path from package path. Python keeps import system and packaging ecosystem deliberately decoupled. Conflating the two in design leads to import behaviour that is too environment-sensitive for tools and package identity that is too weak for reproducibility — the worst of both worlds. Splitting them in this corpus reflects that production-language reality.

Cross-references: language-level module concerns (imports, visibility, cycle policy, dynamic loading) live in `MODULES.md`. Compile-time graph invalidation and incremental compilation live in `COMPILERS.md §18`. Memory-safety and ownership concerns at the package boundary live in `MEMORY.md §10` (capability-based modularity).

---

## 1. What Packaging Manages Beyond Modules

A *module* is usually a source-level or language-level unit of naming and visibility. A *package* is usually a distribution unit: the thing versioned, published, downloaded, or installed. Sometimes the two align neatly. Sometimes a package contains many modules. Sometimes one module is compiled into a library artifact but referenced under a different logical name. Sometimes source packages, binary artifacts, and runtime namespaces all use different identities.

This distinction matters because versioning pressure lives at the package boundary, while visibility and code navigation usually live at the module boundary. Languages that fuse the two can feel simpler, but they often pay later in awkward resolution rules or namespace churn when distribution needs evolve.

Packaging adds several concerns that pure module systems do not address:

- **Versioning** — how releases are identified, ordered, and constrained. SemVer (`major.minor.patch`), CalVer (`YYYY.MM.PATCH`), Git SHA, monotonic counters. The choice shapes dependency-resolution algorithms.
- **Identity** — what makes two artifacts "the same" across machines and time. Path, registry name, content hash, signed manifest, or some combination.
- **Resolution** — given a constraint set ("I need at least X version 2.x"), pick a concrete dependency tree. Greedy, SAT-based, MVS (Go's Minimal Version Selection), constraint-solver-based.
- **Distribution** — how artifacts physically reach consumers. Central registry, decentralised URL, content-addressed CDN, vendored repository.
- **Reproducibility** — given identical inputs, do all consumers get bit-identical builds? Lockfiles plus content hashes are the table-stakes mechanism.
- **Build orchestration** — how a package's source becomes its compiled artifact. Cargo, Maven, npm scripts, Bazel, Nix derivations.
- **Workspace and monorepo support** — multiple packages developed together, shared lockfile, cross-package path references.

These concerns interact: identity affects resolution, resolution feeds the lockfile, lockfile drives reproducibility, build orchestration consumes the lockfile. A clean packaging design considers all of them; a confused one solves some and creates pathologies in others.

---

## 2. Core Design Axes for Packaging

The axes below distinguish packaging-system design choices the way the axes in `MODULES.md §2` distinguish module-system choices. Most real-world packaging systems are composites along these axes.

### 2.1. Module identity vs package identity

Source-level module identity (the names programmers write in `import` statements) and distribution-level package identity (the units versioned and published) can be:

- **Tightly fused** — Cargo (crate name) and Go (module path) make package identity nearly synonymous with import identity at the source level. The package manager shapes import semantics directly.
- **Layered** — Rust separates package, crate, and module identities cleanly. The same crate can live in different package layouts; the same package can ship multiple crates.
- **Loosely coupled** — Python keeps import resolution and packaging ecosystem distinct. The import system reasons about names and search paths; packaging reasons about distribution metadata and environment installation state.

The trade-off: tight fusion is simpler to teach but bakes packaging policy into language semantics. Loose coupling is more flexible but creates ambiguity between "what can be imported" and "what was declared as a dependency".

### 2.2. Module system vs package manager

A module system manages source-level imports and visibility. A package manager handles distribution, versioning, registries, and build orchestration. The two can be more or less integrated:

- **Tight integration** — Cargo, Go modules, Node's `package.json` and exports maps. The package manager's metadata directly drives module resolution. Coherent semantics; less flexibility.
- **Loose coupling** — Python's import system and packaging ecosystem are distinct layers. Flexibility; ambiguity risk.

A language that does not consciously separate these roles often ends up with the worst of both worlds: imports that are too environment-sensitive for tooling and package identity that is too weak for reproducibility.

This axis matters early in language design. If module identity and package identity are separated cleanly, source imports can remain stable while the package manager evolves independently. If they are fused, the package manager effectively becomes part of the language's naming semantics.

---

## 3. Packages, Identity, and Resolution

`MODULES.md` treats modules primarily as language-level structures: what names they expose, how they form dependency graphs, and whether imports are static, executable, typed, or phase-aware. But real ecosystems add another layer above source modules: **package identity, distribution identity, and resolution policy**. This is where many apparently simple module systems become complicated. The source language may say "import `foo.bar`", but the toolchain still has to answer:
- which artifact provides `foo.bar`?
- what version of it is selected?
- how is that identity represented in source?
- and how much of the answer is determined by the language versus the package manager or build tool?

This chapter therefore separates three concepts that many ecosystems blur together:

- **source-level module identity** — the names programmers write in imports;
- **build-graph identity** — the units the compiler actually schedules and caches;
- **distribution identity** — the units versioned, downloaded, published, and installed.

Some systems align these cleanly. Some intentionally keep them separate. Some make them partially overlap, which often creates the most confusion. This chapter is decisive for language design because an elegant source-level module system can still become painful if package identity and resolution semantics are underspecified.

### 3.1. Rust — Packages, Crates, and Source-Level Modules as Distinct Layers

Rust's package/crate/module layering is canonical at `MODULES.md §3.1`. The packaging-relevant point here is that Cargo adds a fourth layer in practice — **workspaces**, which group multiple packages that evolve together — and that crate/package resolution is delegated to Cargo manifest metadata, leaving source-level module syntax stable as packaging and workspace workflows evolve.

A workspace is a top-level grouping declared by a root `Cargo.toml` with a `[workspace]` table listing its `members`. Each member is a package (with its own `Cargo.toml` and one or more crates inside it), but the workspace as a whole shares one `Cargo.lock`, one `target/` directory, and (optionally) one set of shared `[workspace.dependencies]` resolved consistently across members. The workspace boundary therefore buys *coordinated dependency resolution and build artifacts* across packages that ship and version separately, while the package boundary continues to own *what gets published as a unit on crates.io*. Cross-member dependencies in a workspace can be path-based (resolved locally during development) without changing the published-package identity (resolved via registry when consumed externally).

Sources: https://doc.rust-lang.org/cargo/reference/workspaces.html and https://doc.rust-lang.org/reference/crates-and-source-files.html and https://doc.rust-lang.org/cargo/reference/registries.html

### 3.2. Go — Modules as Distribution Units, Packages as Compilation Units

Go's package/module split is canonical at `MODULES.md §3.3`. The packaging-relevant point here is the identity-versioning interaction. **Semantic Import Versioning** requires major-version changes `v2+` to appear in the module path itself, so a breaking version change is reflected directly in source-level import names. The upside is reproducibility and clarity; the downside is that package-manager policy leaks into source identity more directly than in Rust. Go's package graph and distribution graph are closely aligned, and versioning policy is explicit at the source level.

Sources: https://go.dev/ref/mod#go-mod-file and https://research.swtch.com/vgo-import and https://go.dev/ref/mod#minimal-version-selection

### 3.3. Python — Import System and Packaging as Loosely Coupled Systems

Python takes the opposite approach. The **import system** is part of the language runtime and is primarily concerned with finding, loading, and caching module objects. **Packaging**, by contrast, is an ecosystem layer: wheels, source distributions, metadata, installers, environment managers, and package indexes all exist largely outside the core import semantics.

This separation gives Python enormous flexibility. A module can come from the filesystem, a zip file, a custom importer, or a namespace package spread across multiple directory roots. But the cost is that "what can be imported?" and "what dependency was declared?" are not the same question. The import system reasons in terms of fully qualified names, `sys.path`, `__path__`, finders, loaders, and specs; packaging tools reason in terms of distribution metadata and environment installation state.

This is one of the main reasons Python environments are powerful but notoriously slippery. The language itself does not give one simple authoritative answer to module identity at the distribution level. Instead, multiple layers cooperate:
- import machinery resolves names to modules,
- packaging metadata tells installers what to put in the environment,
- the environment then determines what imports will succeed.

Python is a valuable caution: **separating package management from imports can be good, but only if the identity boundary is still crisp enough for tools and users to reason about**. Otherwise, import behavior becomes too environment-shaped.

Sources: https://packaging.python.org/en/latest/specifications/ and https://peps.python.org/pep-0517/ and https://peps.python.org/pep-0621/

### 3.4. Node and JavaScript — Package Metadata as Resolution Policy

JavaScript's module story is inseparable from package metadata once it enters the Node ecosystem. ECMAScript itself defines module syntax and runtime semantics, but Node's resolution and loading behavior is strongly shaped by `package.json`, especially fields such as:

- `"type"` — whether `.js` files are interpreted as ESM or CommonJS,
- `"exports"` — which entry points are exposed and under which conditions,
- and package subpath mappings that distinguish import and require behavior.

This creates a system where package metadata is not merely installation information; it is an active participant in module resolution. The source-level specifier and the package boundary cooperate to determine what code is actually imported. This is more tightly integrated than Python's packaging split, but also more loader-shaped than Go's explicit path identity.

The result is expressive and powerful, especially for dual ESM/CJS distribution, but it comes at the cost of conceptual complexity. The same package may present different entry points to different consumers depending on loader mode and metadata configuration. The language-level module system and the package manager cannot really be discussed independently.

Node is the strongest warning about allowing package metadata to redefine source-level resolution semantics too aggressively. Such systems are flexible, but they make static reasoning and ecosystem simplicity harder.

Sources: https://nodejs.org/api/packages.html#exports and https://docs.npmjs.com/cli/v10/configuring-npm/package-json and https://nodejs.org/api/packages.html#conditional-exports

### 3.5. Zig and Odin — Package Roots, Build Context, and Tooling Simplicity

Zig and Odin are useful here because they show lighter-weight package stories than Cargo, Go modules, or Node package metadata.

In **Zig**, package and module resolution are closely tied to the build configuration. `@import` itself is simple, but what package names are available depends on how the build graph exposes root modules and dependencies. This means the source language stays low-magic, while the build layer carries more of the responsibility for naming and exposure. The design is relatively deterministic, but it also means package identity is somewhat build-context-shaped.

In **Odin**, the language and ecosystem lean heavily on package-per-directory organization and named collections such as `base`, `core`, and `vendor`. This is much less elaborate than Cargo or npm, but also much less detached from source tree layout. The result is easy to understand and easy for tools to follow, at the cost of less abstraction between source organization and ecosystem packaging.

These systems matter because they show that a maximal package manager model is not needed immediately. A language can begin with deterministic package roots and straightforward import resolution, then grow richer packaging later if the source-level identity model is kept clean.

Sources: https://ziglang.org/learn/build-system/ and https://odin-lang.org/docs/overview/#packages

### 3.6. Design Lessons from Packages, Identity, and Resolution

Across Rust, Go, Python, Node, Zig, and Odin, a few durable patterns emerge.

First, **source-level modularity and distribution-level modularity are usually not the same thing**, even when a language tries to align them closely. The key design question is not whether they differ — they almost always do — but whether that difference is explicit and principled.

Second, languages seem to fall into three broad package-identity postures:

- **Layered but explicit** — Rust: package, crate, and module are distinct and named separately.
- **Closely aligned** — Go: module path strongly shapes package import identity.
- **Loosely coupled** — Python: import system and packaging ecosystem are distinct layers.

Node demonstrates a fourth, more volatile posture:

- **metadata-shaped resolution** — package metadata actively participates in import semantics.

Deno (§3.7) demonstrates a fifth:

- **URL-shaped identity with no central registry** — module identity *is* an HTTPS URL, content-addressed via lockfile, with no governance bottleneck and capability-sandboxed import authority.

A defensible default path is:

- keep **module identity** clear and source-level;
- keep **package identity** explicit but not overly entangled with import syntax;
- keep **resolution deterministic** and friendly to tools;
- avoid making package metadata too loader-powerful too early;
- and decide consciously whether version identity should ever leak into source import paths.

This chapter therefore sharpens one of the main choices in this design space: whether to look more like Rust's layered separation, Go's path-aligned identity, Python's looser split, or Node's metadata-shaped resolution. The dominant pattern in modern systems-language design favors a layered Rust-style model, but the right answer depends on whether the ecosystem prioritizes reproducibility, conceptual simplicity, runtime flexibility, or distribution flexibility.

### 3.7. Deno — URL-Based Module Identity and No Central Registry

Ryan Dahl's **Deno** (2018+) takes a position no other entry in this chapter takes: **module identity is an HTTPS URL, and there is no central registry**. An import statement is `import { serve } from "https://deno.land/std@0.220.0/http/server.ts";` — the URL is the canonical name, the version is in the path, and there is no equivalent of crates.io, npm, PyPI, or Maven Central as a governance bottleneck. Modules are content-addressed via SHA-256 in a `deno.lock` file, downloaded on first use, and cached in a per-user directory under `$DENO_DIR`.

The design choices that follow:

- **No `node_modules` or virtual environment per project**: dependencies are content-addressed in a global cache, shared across projects. Builds are reproducible because the lock file pins the URL plus the content hash.
- **Subresource integrity by default**: an import that resolves to bytes whose hash does not match the lock file is rejected at load. This defends against registry compromise and man-in-the-middle attacks without requiring users to opt in.
- **Per-program capability sandbox**: a Deno program runs with no ambient authority by default — `--allow-net`, `--allow-read`, `--allow-write`, `--allow-env` are explicit grants. Combined with URL-shaped imports, this makes it possible to audit "what code runs, where it came from, and what authority it has" at deployment time. The capability angle complements `MEMORY.md §10` (object-capability discipline) at the runtime boundary.
- **Bring-your-own-CDN identity**: deno.land/std is one CDN; jsr.io is another; private registries can be self-hosted by serving HTTPS responses with the right content negotiation. There is no governance bottleneck because identity is URL-shaped.
- **Top-level `await` and ESM by default**: Deno follows ECMAScript module semantics (`MODULES.md §4.2`) directly, with no CommonJS distinction.

Status (as of 2026-04): Deno 2.0+ added **jsr.io** (a curated registry serving canonical URLs while still URL-shaped) and improved npm-package interoperability via `npm:`-prefixed specifiers, partially closing the ecosystem gap with Node. Production users include Deno Deploy, Netlify Edge Functions, and several Node-replacement deployments. The two main current criticisms are the loss of central discovery (no equivalent of npm search) and ecosystem fragmentation between `deno.land/x`, `jsr.io`, and `npm:` resolution paths.

The design lesson generalises: **content-addressed URLs as module identity** eliminate the registry-name-squatting and registry-availability problems §3.4 names for Node and §4.3 names for crates.io / PyPI, at the cost of giving up centralised discovery affordances and ecosystem-curation. Go's import-paths-as-URLs (§3.2) takes a similar position with a less radical lockfile model. A new language designer can adopt URL-shaped imports without committing to the full Deno model.

Sources: https://docs.deno.com/runtime/fundamentals/modules/ and https://deno.com/blog/jsr_q4 and https://docs.deno.com/runtime/fundamentals/security/ and https://jsr.io/docs

---


---

## 4. Build Systems, Workspaces, Lockfiles, and Registries

A module system is incomplete without the surrounding ecosystem of build tools, dependency resolvers, lockfiles, registries, and workspace structures. This chapter covers the layer above the language-level module system, where the practical experience of "how do I add a dependency?", "how do I build my project?", and "how do I publish?" actually plays out. The choices here often determine whether a language's module system feels lightweight or oppressive in everyday use.

### 4.1. Lockfiles and Reproducible Resolution

A **lockfile** records the exact versions of every transitively-resolved dependency at a moment in time, so that subsequent builds reproduce the same resolution regardless of subsequent registry changes. The lockfile is committed to source control alongside the project's manifest, and the package manager uses it as the authoritative source of truth in CI and on other developers' machines.

The dominant lockfile families:

- **`Cargo.lock`** (Rust) — TOML-formatted, listing every crate and version with content checksums. Recommended for binary projects, optional for libraries.
- **`package-lock.json`** / `yarn.lock` / `pnpm-lock.yaml` (Node) — three competing formats from npm, Yarn, and pnpm. They differ in resolution algorithms (npm and Yarn use nested-dependency trees historically; pnpm uses a flat content-addressed store with symlinks).
- **`go.sum`** (Go) — content hashes for every module version used, validated against a checksum database (`sum.golang.org`) to detect tampering.
- **`Pipfile.lock`** / `poetry.lock` / `uv.lock` (Python) — multiple competing formats with overlapping but not identical scope.
- **`Manifest.toml`** (Julia) — records the resolved versions of all packages in an environment.
- **`composer.lock`** (PHP), **`Gemfile.lock`** (Ruby), **`mix.lock`** (Elixir), etc.

The identity-relevant design question is whether the lockfile pins by version-string only or by content hash. The **content-hash approach** (Cargo, Go, Nix, pnpm) is increasingly the consensus: a lockfile entry pins not just a version number but the bytes of the dependency, so tampering or registry compromise is detectable. Go's checksum database goes further by maintaining a public log of every known module version's hash, defending against retroactive registry changes. Cache-key formation, manifest-vs-lockfile validation, and incremental invalidation mechanics are covered in `COMPILERS.md §18`.

Sources: https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html and https://go.dev/ref/mod#go-sum-files and https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json and https://pnpm.io/motivation

### 4.2. Workspaces and Monorepos

A **workspace** is a project structure where multiple related packages share a single source tree, build configuration, and (usually) lockfile. Workspaces are the package-manager-level answer to "I have several libraries that evolve together."

- **Cargo workspaces** — declared by a top-level `Cargo.toml` with `[workspace]` and `members = [...]`. Member crates share a single `Cargo.lock`, can depend on each other by relative path, and `cargo build`/`cargo test` operate on the whole workspace.
- **Go workspaces** — `go.work` (introduced Go 1.18, March 2022) lets multiple modules be developed together, overriding `go.sum` resolution for the listed modules. Different from Cargo's model: each Go module retains its own `go.mod` and `go.sum`, the workspace just unifies their development.
- **Yarn workspaces** / **npm workspaces** / **pnpm workspaces** — declared via `workspaces` in the root `package.json`. Member packages are typically symlinked into the root `node_modules`, so cross-references resolve to the local source.
- **Bazel** has the most ambitious "workspace" concept: `WORKSPACE` (or `MODULE.bazel` in bzlmod) defines an entire build universe with arbitrary internal package boundaries, source dependencies, and remote build artifacts.

The general design tension is between **monorepo benefits** (atomic cross-package changes, shared tooling, single source of truth for versions) and **per-package independence** (separate version histories, separate publishing cadences, separate ownership). Workspace mechanisms try to give the first while preserving the second; the trade-offs vary by ecosystem.

The package-manager design lesson is that **workspace support must be a first-class feature, not a hack on top of the single-package model**. Cargo and pnpm got this right relatively early; npm and Yarn took years to converge on consistent semantics.

Sources: https://doc.rust-lang.org/cargo/reference/workspaces.html and https://go.dev/ref/mod#workspaces and https://docs.npmjs.com/cli/v10/using-npm/workspaces and https://pnpm.io/workspaces

### 4.3. Public Registries and Naming

Most modern languages ship with an official public registry hosting community packages:

- **crates.io** (Rust) — single global namespace, first-come-first-served names, no organizational scoping. Names like `tokio`, `serde`, `rand` are global.
- **npm** (JavaScript) — flat namespace with `@scope/name` scoped names introduced later for organizations and forks.
- **PyPI** (Python) — flat namespace, similar to crates.io.
- **Hex** (Erlang/Elixir) — flat namespace.
- **Hackage** (Haskell) — flat namespace.
- **NuGet** (.NET) — convention-based hierarchical names (`Microsoft.Extensions.Logging`) but the registry treats them as flat strings.
- **Maven Central** (JVM) — coordinate-based: `groupId:artifactId:version`, where `groupId` is conventionally a reverse-DNS-style organization identifier (`org.apache.commons`).
- **Go modules** — *no central registry*. Module paths are URLs (typically `github.com/user/repo`), the Go tool fetches directly from the version-control host or a configured proxy (`proxy.golang.org`).

The Go choice is unusual and instructive. By making module identity an arbitrary URL-shaped string, Go avoids registry-name-squatting entirely and aligns ecosystem identity with version-control identity. The cost is that there is no central place to discover packages or browse popularity; community-run tools like `pkg.go.dev` fill that gap.

The **scoped vs flat namespace** decision is one of the most consequential choices for ecosystem health. Flat namespaces (crates.io, PyPI) have suffered from name-squatting, typo-squatting, and maintenance abandonment. Scoped namespaces (npm `@scope`, Maven `groupId`) defend against this but require organizations to claim and maintain their scopes. Any new registry should commit to scoped names from the start; retrofitting is painful (npm's `@scope` introduction in 2014 left a long tail of unscoped legacy names).

Sources: https://crates.io/policies and https://docs.npmjs.com/about-scopes and https://research.swtch.com/vgo-import and https://central.sonatype.org/publish/requirements/coordinates/

### 4.4. Vendoring and Mirroring

**Vendoring** is the practice of committing copies of dependency source into the project's own repository, so builds do not depend on external registries at all. Go has the most mature vendoring story: `go mod vendor` writes all dependencies into `vendor/`, and the Go toolchain uses them transparently if present. Other ecosystems support vendoring via tooling but treat it as exceptional rather than routine.

**Mirroring** is the practice of running an internal copy of a public registry, often with content auditing or version pinning. Artifactory, Nexus, and self-hosted Verdaccio (npm), Sonatype Nexus (Maven, npm, PyPI), and Cloudsmith are commercial or open-source registry mirrors used by enterprises that cannot allow direct registry access from build infrastructure.

The design lesson is that **registry availability is a build-graph concern**. A build that depends on an external registry being reachable can fail for reasons unrelated to the project's code. Vendoring eliminates this; mirroring centralizes the failure mode. At minimum, support vendoring as a first-class workflow (copying dependencies into the project's own repo) so hermetic builds are achievable.

Sources: https://go.dev/ref/mod#vendoring and https://www.sonatype.com/products/sonatype-nexus-repository

### 4.5. Build-System Module Visibility — Bazel and Buck

Beyond the language and package layer, large monorepos use build systems with their own module-visibility model. **Bazel** (Google's open-sourced build system) and **Buck** (Meta's) implement per-target visibility declarations: a `BUILD` file lists targets (libraries, binaries, tests) and each target has a `visibility = [...]` attribute restricting which other targets can depend on it. This is enforced by the build graph at build time, not by the language.

This is structurally similar to JPMS's `exports ... to` qualified exports but at the build-graph level rather than the language level. The consequence is that **a single source file can have one set of language-level visibility and a different set of build-system-level visibility**, with the latter being the operative constraint in monorepo deployments.

The interaction with language-level modules is subtle. In a Bazel monorepo using Java, a class can be `public` (Java visibility) but only depended on by specific Bazel targets (Bazel visibility). The build graph enforces architectural boundaries that Java's package-level visibility cannot. Google internally relies on this heavily.

The lesson is that **at sufficient scale, build-system visibility becomes the dominant abstraction**, not language-level visibility. Languages designed for monorepo use should consider whether their module-system primitives compose cleanly with build-system visibility, or whether the two will fight. Most languages punt on this; Bazel's reach is substantial enough that punting is increasingly costly.

Sources: https://bazel.build/concepts/visibility and https://buck2.build/docs/api/build/visibility/

### 4.6. Functional Package Management — Nix Flakes and Guix

Most package managers in §4.1–§4.5 treat reproducibility as a *lockfile* concern: pin the resolved dependency tree, hash the artifacts, and trust the registry to serve the same bytes for the same hash. Nix and Guix take a more aggressive position: **every package is a pure function from inputs to outputs, and the build sandbox is hermetic by language-level construction**. The package manager is a programming environment for writing and composing those functions.

**Nix flakes** (introduced 2021, opt-in stable since NixOS 22.05) are the modern Nix interface. A flake is a directory containing a `flake.nix` file at its root that declares **inputs** (other flakes) and **outputs** (packages, NixOS modules, dev shells, apps):

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-23.11";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system}; in
      {
        packages.default = pkgs.callPackage ./default.nix {};
        devShells.default = pkgs.mkShell { buildInputs = [ pkgs.cargo ]; };
      });
}
```

Inputs are pinned in **`flake.lock`** by content hash (the *narHash* — a hash of the unpacked filesystem tree, not just the tarball). Because every input is content-addressed, two builds against the same `flake.lock` produce identical outputs *byte for byte*, regardless of when or where they run.

The build process is hermetic: each derivation runs in a sandbox with only its declared inputs visible, no network access, no `/usr`, no `$HOME`. Outputs are stored in `/nix/store/<hash>-<name>/` where `<hash>` is computed from all inputs. Two derivations with the same inputs produce the same output path; this is the basis for binary caching across machines.

**Guix** (GNU project) is a Lisp-based variant of the same model. Package definitions are Scheme expressions instead of Nix expressions; the underlying store and reproducibility model are the same. Guix additionally emphasizes **bootstrappable builds** — every package can be traced back to a small bootstrap seed (covered in `COMPILERS.md §28.3` from the compiler-bootstrap angle).

**Spack** is the HPC-oriented variant. It adds **combinatorial version selection**: a single package can be installed in multiple variants (different compilers, different MPI implementations, different optimization levels), each with its own hash. The dependency resolver picks compatible combinations across the entire dependency tree.

The design points worth carrying forward:

- **Reproducibility by language-level construction**, not by retrofitted lockfile. The build is hermetic because the package definition language disallows non-pure operations, not because the package manager promises to.
- **Content-addressed outputs** as the basis for sharing. Two machines computing the same derivation produce identical bytes; binary caches just serve those bytes by hash.
- **Inputs are themselves packages** (or flakes). The dependency graph is fully declarative; there's no concept of "system-installed" vs "managed" — everything is a function input.
- **The package manifest is a real programming language**. Nix and Guix expressions can be abstract, parameterized, and composed. The cost is a steep learning curve; the benefit is that complex package configurations (cross-compilation, multi-target builds, variant selection) are expressible as ordinary code.

Compared with Cargo, npm, or PyPI — which are *artifact distribution* systems with reproducibility added on — Nix and Guix are *build* systems with distribution as a side effect. The trade-off is acquisition cost (significant Nix learning curve, a separate package ecosystem to inhabit) for hermetic reproducibility that no lockfile-based system can match.

For a package manager designer, the question Nix and Guix raise is whether reproducibility is a *property of the lockfile* or a *property of the build*. Most modern systems pick the former; Nix shows the latter is achievable and structurally cleaner, at the cost of much higher complexity.

Sources: https://nixos.wiki/wiki/Flakes and https://nix.dev/concepts/flakes.html and https://guix.gnu.org/manual/en/html_node/Defining-Packages.html and https://spack.readthedocs.io/en/latest/concretize.html

### 4.7. Design Lessons from Build Systems and Registries

The build-system-and-registry layer adds several specific lessons not visible at the language level:

- **Lockfiles with content hashes are now table stakes.** A new package manager that ships without a content-hashed lockfile will be retrofitting one within a few years.
- **Workspace support must be first-class**, not bolted on. Cargo's clean workspace story is a strong differentiator.
- **Scoped registry names defend against name-squatting.** A new ecosystem should adopt them from day one.
- **No-central-registry models** (Go) work if module identity is URL-shaped. They reduce ecosystem governance burden but lose discovery affordances.
- **Vendoring should be a first-class workflow** for hermetic builds and disaster-recovery scenarios.
- **Build-system visibility is a layer above language visibility** and dominates at large scale. Compatibility with Bazel-style visibility is increasingly important for languages targeting enterprise monorepo use.
- **Reproducibility can be a build-system property, not just a lockfile property** (Nix, Guix). Hermetic, content-addressed builds eliminate "works on my machine" by construction. The cost is a substantial language learning curve for the package manifest; the benefit is reproducibility that no retrofitted lockfile can guarantee.

A language designer can pick from this menu deliberately rather than discover the choices through painful retrofits.

---


---

## 5. Summary of Packaging Techniques

Rows are grouped by topic; within a topic, ordering follows the body text.

### 5.1. Package identity models

| System | Identity Source | Distribution Identity | Notes |
|---|---|---|---|
| Rust (§3.1) | Package name + crate name + module tree | crates.io coordinates | Three-level layering |
| Go (§3.2) | Module path = URL prefix + directory | go.mod + checksum DB | URL-shaped identity |
| Python (§3.3) | Import name (loose) + dist name (separate) | PyPI dist-info | Decoupled |
| Node (§3.4) | Package name + scope | npm registry | Metadata-shaped resolution |
| Zig (§3.5) | Build-context name | URL+hash via build.zig.zon | Build-tool-defined |
| Odin (§3.5) | Directory name + collection | Lightweight; no central registry | Convention-driven |
| Deno (§3.7) | HTTPS URL | URL + content hash in deno.lock | URL-shaped, no central registry |

### 5.2. Lockfile and reproducibility mechanisms

| System | Lockfile | Identity Pinning | Notes |
|---|---|---|---|
| Cargo (§4.1) | `Cargo.lock` | Version + content checksum | Auto-generated; recommended for binaries |
| Go (§4.1) | `go.sum` | Content hashes via sum.golang.org | Tamper-evident |
| npm (§4.1) | `package-lock.json` | Version + integrity SHA | Dependency tree resolved |
| Yarn (§4.1) | `yarn.lock` | Version + checksum | Alternative resolution algorithm |
| pnpm (§4.1) | `pnpm-lock.yaml` | Content-addressed store + symlinks | Disk-efficient |
| Pip / Poetry / uv (§4.1) | Various competing | Mixed | Python ecosystem fragmentation |
| Julia (§4.1) | `Manifest.toml` | Resolved versions per environment | Pkg-managed |
| Nix Flakes (§4.6) | `flake.lock` | narHash content addressing | Build-derivation reproducibility |

### 5.3. Workspace and monorepo support

| System | Workspace Concept | Lockfile Sharing | Notes |
|---|---|---|---|
| Cargo (§4.2) | `[workspace]` with members list | Single `Cargo.lock` | Path-based intra-workspace deps |
| Go (§4.2) | `go.work` | Per-module `go.sum` | Workspace overrides resolution |
| npm/Yarn/pnpm (§4.2) | `workspaces` in `package.json` | Single root lockfile | Symlinked node_modules |
| Bazel / Buck (§4.5) | `WORKSPACE` / `MODULE.bazel` | Build-system-managed | Arbitrary cross-package boundaries |

### 5.4. Registry models

| Model | Examples | Trade-off |
|---|---|---|
| Flat namespace + first-come naming | crates.io, PyPI, Hex, Hackage | Name-squatting risk |
| Scoped namespace | npm `@scope/`, Maven `groupId:` | Org-level claim and protection |
| URL-shaped (no central registry) | Go (URLs), Deno (URLs) | Eliminates governance bottleneck; loses discovery affordance |
| Strict pre-publication review | CRAN | Quality control at registry-policy level |

### 5.5. Reproducibility models

| Approach | Mechanism | Examples |
|---|---|---|
| Lockfile-pinned | Version + content hash | Cargo, Go, npm, Pip |
| Content-addressed build derivation | Hermetic sandbox + narHash | Nix flakes, Guix |
| Combinatorial variant selection | Concretisation per dependency tuple | Spack |
| Vendoring | Source committed to repo | Go, idiomatic for hermetic builds |

---

## 6. Open Design Questions

These are the recurring decision points a packaging-system designer faces.

- **§6.1. Are package identity and module identity the same?** Tight coupling vs separation vs loose coupling; canonical at §2.1, §2.2.
- **§6.2. Does package metadata participate in resolution?** Loader-shaped resolution (Node) vs purely installation metadata (Cargo, Go); see §3.4 and §3.6.
- **§6.3. Is a central registry mandatory or optional?** Centralised governance (crates.io, PyPI) vs URL-shaped identity (Go, Deno) vs no registry (vendoring-only).
- **§6.4. Is reproducibility a lockfile property or a build-derivation property?** Lockfile-pinned (Cargo, Go, npm) vs hermetic-derivation (Nix, Guix).
- **§6.5. Is workspace support first-class?** Cargo's clean workspace story vs npm's bolt-on. New ecosystems should design for this from day 1.
- **§6.6. How is build-system visibility related to language visibility?** At sufficient scale (Bazel monorepos), build-system visibility dominates language visibility.
- **§6.7. Is vendoring a first-class workflow?** Hermetic builds, disaster recovery, and air-gapped environments require it.
- **§6.8. How are major-version transitions identified at the source level?** Semantic Import Versioning (Go) bakes major version into the import path; most other systems use lockfile-and-manifest indirection.

---

## 7. Closing Synthesis

Three decisions do most of the load-bearing work in packaging-system design.

The first is **lockfile-and-content-hash adoption** (§4.1). Modern ecosystems are converging on content-addressed lockfiles whether the underlying registry is centralised (Cargo, Hex), URL-shaped (Go), or hermetic (Nix, Guix). A new package manager that ships without one will be retrofitting it within a few years; the only real choice is whether reproducibility lives at the lockfile layer or all the way down in the build derivation.

The second is **registry posture** (§4.3, §3.7). Languages fall into roughly four categories: layered-but-explicit (Rust), tightly-aligned (Go, with module path = URL), loosely-coupled (Python), or metadata-shaped (Node). Deno demonstrates a fifth: URL-shaped identity with no central registry. The dominant pattern in modern systems-language design favors a layered Rust-style model, but the right answer depends on whether the ecosystem prioritises reproducibility, conceptual simplicity, runtime flexibility, or distribution flexibility.

The third is **workspace-and-build-system co-design** (§4.2, §4.5). A package manager designed without a workspace concept accumulates monorepo workarounds within a few years. A package manager designed without considering build-system visibility (Bazel-style) struggles when ecosystems push past single-package-publishing toward platform-engineering organisations.

For a new language designer, the actionable summary: pick a lockfile format with content hashing, decide registry posture before the first 1.0, support workspaces from day 1, commit to vendoring as a first-class workflow, and treat build-system visibility as a separate concern from language-level visibility. Each of these choices is cheaper to make at design time than to retrofit.

---

## 8. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 3 — Packages, Identity, and Resolution

1. Rust Reference — Crates and Source Files — https://doc.rust-lang.org/reference/crates-and-source-files.html
2. Cargo registries reference — https://doc.rust-lang.org/cargo/reference/registries.html
3. Go module file reference — https://go.dev/ref/mod#go-mod-file
4. Go — Minimal version selection — https://go.dev/ref/mod#minimal-version-selection
5. Python Packaging Specifications — https://packaging.python.org/en/latest/specifications/
6. PEP 517 — A build-system independent format for source trees — https://peps.python.org/pep-0517/
7. PEP 621 — Storing project metadata in `pyproject.toml` — https://peps.python.org/pep-0621/
8. Node.js Packages — Subpath exports — https://nodejs.org/api/packages.html#exports
9. npm `package.json` reference — https://docs.npmjs.com/cli/v10/configuring-npm/package-json
10. Node.js Conditional exports — https://nodejs.org/api/packages.html#conditional-exports
11. Deno modules documentation — https://docs.deno.com/runtime/fundamentals/modules/
12. JSR — JavaScript Registry — https://jsr.io/docs
13. Deno security and permissions — https://docs.deno.com/runtime/fundamentals/security/
14. Deno blog — JSR Q4 update — https://deno.com/blog/jsr_q4


### Chapter 4 — Build Systems, Workspaces, Lockfiles, and Registries

1. Cargo — `Cargo.toml` vs `Cargo.lock` — https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html
2. Go — `go.sum` files — https://go.dev/ref/mod#go-sum-files
3. npm — `package-lock.json` — https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json
4. pnpm — Motivation — https://pnpm.io/motivation
5. Cargo workspaces — https://doc.rust-lang.org/cargo/reference/workspaces.html
6. Go workspaces — https://go.dev/ref/mod#workspaces
7. npm workspaces — https://docs.npmjs.com/cli/v10/using-npm/workspaces
8. pnpm workspaces — https://pnpm.io/workspaces
9. crates.io policies — https://crates.io/policies
10. npm — About scopes — https://docs.npmjs.com/about-scopes
11. Russ Cox — Semantic import versioning — https://research.swtch.com/vgo-import
12. Sonatype — Maven Central coordinates — https://central.sonatype.org/publish/requirements/coordinates/
13. Go vendoring — https://go.dev/ref/mod#vendoring
14. Sonatype Nexus Repository — https://www.sonatype.com/products/sonatype-nexus-repository
15. Bazel — Visibility — https://bazel.build/concepts/visibility
16. Buck2 — Visibility API — https://buck2.build/docs/api/build/visibility/
17. NixOS Wiki — Flakes — https://nixos.wiki/wiki/Flakes
18. nix.dev — Concepts: Flakes — https://nix.dev/concepts/flakes.html
19. GNU Guix — Defining Packages — https://guix.gnu.org/manual/en/html_node/Defining-Packages.html
20. Spack — Concretization (combinatorial version selection) — https://spack.readthedocs.io/en/latest/concretize.html
