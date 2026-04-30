# Modules, Imports, and Visibility Boundaries

Research on language-level module systems: import semantics, export and visibility rules, encapsulation boundaries, dynamic loading, and tooling implications across programming languages.

This document focuses on the structure above files and below whole programs: how languages define units of encapsulation, dependency, initialization, and source-level naming. The companion document `PACKAGING.md` covers the ecosystem layer above modules — package identity, resolution, lockfiles, registries, build systems, workspaces, and reproducibility — which in production languages is usually separate even when it appears unified at first glance. Parser and AST structure live in `PARSERS.md`. Compile-time graph invalidation, incremental compilation, and IR boundaries live in `COMPILERS.md`, though this document cross-references them where module design affects build and tooling behavior. Runtime observability and debugger protocol boundaries live in `TRACERS.md` and `DEBUGGERS.md`. The unifying axis here is *where modularity lives*: in files, directories, declarations, typed interfaces, runtime loaders, or macro phases.

A module system is not just syntax for writing `import foo`. It is the language's answer to a cluster of hard questions:

- What counts as a separately understandable unit of code?
- What names are visible where?
- What dependencies are allowed to exist?
- What work happens when a dependency is introduced?
- What can be cached, compiled, documented, or versioned independently?
- What must tools know in order to rename, navigate, or refactor code safely?

Because of this, module-system design leaks into nearly every other part of the language toolchain. A file-based module model affects parser and IDE assumptions. A package-based identity model affects the build graph and version resolution. Import-time execution affects debuggability, reproducibility, and cyclic semantics. Macro-phase imports affect compilation order and expandability. In practice, module systems are where language design, compiler architecture, and ecosystem ergonomics meet.

This document first defines the major mechanism families, then uses those families to organize later case studies and concrete language comparisons. The goal is not to catalog syntax. It is to build a design vocabulary rich enough to support explicit language-design comparisons later.

---

## 1. What Module Systems Are For

A module system exists because neither a single file nor a whole program is the right unit of reasoning for most software. A file is too small to express architectural boundaries, while a whole program is too large to compile, analyze, distribute, or refactor as one undifferentiated blob. Modules provide a middle scale: large enough to expose meaningful abstractions, small enough to remain tractable as units of naming, compilation, and ownership.

This chapter names the jobs module systems actually perform. Later chapters will show that different languages assign these jobs to different mechanisms. Some languages make files themselves the module unit. Some make directories or packages the meaningful boundary. Some separate source organization from binary packaging. Some treat modules as typed abstraction layers. Some let imports execute arbitrary code and produce singleton runtime objects. Those are all answers to the same underlying problem set.

### 1.1. Name organization

The most obvious purpose of a module system is preventing the global namespace from collapsing under its own weight. Once a program contains more than a few dozen declarations, flat naming stops scaling. Two packages both want a `parse`, `format`, `String`, `Map`, `Token`, or `Builder`. Without a module boundary, either names become absurdly prefixed or accidental collisions become routine.

But name organization is not only collision avoidance. It also encodes *how programmers expect to find things*. If a language says "networking lives under `net`", "filesystem support lives under `fs`", or "cryptographic hashes live under `crypto.hash`", then the module tree becomes part of the language's conceptual map. That conceptual map is later consumed by documentation generators, IDE auto-import, code search, and architecture discussions. In many ecosystems, the module path *is* the public identity of a concept.

The design choice is therefore not just whether names are nested, but **what hierarchy carries meaning**. A file path? A declared module path? A package manifest path? A collection name? A registry name? Different systems choose different anchors, and those anchors shape everything downstream.

### 1.2. Encapsulation and visibility

A module boundary is also a visibility boundary. It distinguishes implementation details from API surface. The language may expose this with explicit markers (`pub`, `export`, `public`), naming conventions (Go's capitalization), interface files (`.mli`), export lists, or package-private scopes. Whatever the syntax, the purpose is the same: some declarations are promises to the outside world, others are merely local machinery.

This matters for more than hygiene. Visibility is what lets a compiler and a programmer agree on which changes are semantically relevant. If a function is private to a module, the implementer can freely refactor it without breaking downstream users. If it is public, refactoring must preserve the published contract. A coarse module system forces programmers to preserve more accidental surface area than they intended; a more expressive one lets them hide aggressively and evolve internals safely.

There is also a granularity question. Some languages offer only public vs private. Others add crate-local, package-local, parent-visible, friend-like, or selectively re-exported scopes. That granularity is not academic: it determines whether a large codebase can express "public to sibling implementation modules, but not to external users" without structural hacks.

### 1.3. Dependency graph formation

Imports are not merely name lookups; they define a graph. That graph determines what must be processed before what else can be processed, which changes force recompilation, which cycles are legal, and where the language expects architectural seams to appear.

A language with purely static imports gives the compiler a clean directed graph early. This graph can be used for scheduling, caching, parallel compilation, dead-code reasoning, and IDE indexing. A language with runtime import behavior may still have a graph, but the graph is partly semantic rather than purely structural: import statements can trigger side effects, observe environment state, or create partially initialized singleton module objects. That makes the graph harder to use as a compiler artifact.

The question "does the language permit import cycles?" is therefore really a question about whether the graph must be a DAG. Systems that insist on a DAG usually do so because they want compilation, initialization, and tooling to be simple and deterministic. Systems that tolerate cycles must instead define what happens when a node is observed before one of its incoming dependencies has finished initialization.

### 1.4. Separate compilation and caching

Large programs are built incrementally, not from nothing. A useful module system therefore provides a natural decomposition into compilation units and cache keys. A module should ideally be small enough that changing one does not invalidate the entire world, but large enough that the overhead of compiling it independently is justified.

Some languages make the top-level module the compiler unit by construction. Some distinguish module syntax from package compilation units. Some let the build tool, rather than the language, decide which files cohere into a reusable artifact. Some typed module systems make interfaces explicit enough that downstream users depend only on a compact signature surface instead of the whole implementation body.

These choices directly affect compiler architecture. Query-based and incremental compilers, discussed in `COMPILERS.md §18`, rely on stable dependency boundaries and reproducible graph formation. A module system that makes those boundaries explicit helps the compiler. A module system that entangles imports with runtime effects complicates invalidation and reuse.

### 1.5. Packaging and distribution

Packaging and distribution — versioning, registries, lockfiles, build orchestration — is canonically owned by `PACKAGING.md`. The module-system question this raises (whether package identity and module identity are fused or separated) is treated in §2.6 below.

### 1.6. Tooling and IDE surfaces

Modules are one of the first things tools need to understand. Auto-import must know where a symbol can legally come from. Rename must know what names are visible and whether a move changes API surface. Unused-import detection depends on static resolution. Documentation generators need a stable module tree. Code search, jump-to-definition, workspace indexing, and semantic highlighting all start from the module graph.

This is why module systems that are elegant on paper but unpredictable in resolution semantics usually create miserable toolchains. A language can tolerate many things at runtime; tools need determinism. When import behavior depends on execution, environment mutation, ambiguous search paths, or dynamic package rewriting, IDE support becomes heuristic-heavy instead of principled.

The design pressure from tooling therefore usually pushes toward:
- deterministic resolution,
- explicit visibility,
- static graph formation,
- stable module identity,
- limited import-time side effects.

Not every language accepts that pressure. Dynamic systems often privilege flexibility over analyzability. But the trade-off is real, and module-system design is one of the sharpest places where it appears.

---

## 2. Core Design Axes

This chapter defines the comparison vocabulary for the rest of the document. The goal is not to rank languages yet, but to identify the major dimensions along which they differ. Most real-world module systems are composites: file-based *and* package-based, static *and* runtime-initialized, hierarchical *and* declaration-sensitive. The axes below isolate those components so later case studies can be compared cleanly.

### 2.1. File-based vs declared modules

The first question is whether a module exists because of **where code lives** or because of **what the code says**.

In a **file-based** design, a source file or directory intrinsically defines the module unit. Python's `foo.py`, Go's package directories, OCaml compilation units, and many Zig/Odin workflows lean in this direction. The benefit is simplicity: the language does not need much extra syntax to tell the compiler how to partition the program. Tooling can often infer the module graph directly from the filesystem.

In a **declaration-based** design, the source explicitly states the module it defines, and the filesystem is secondary or merely conventional. ML-family module expressions, Java package declarations, some C# namespace arrangements, and C++20 module interface units all live somewhere on this axis. The benefit is decoupling: the programmer can reason about logical structure separately from file layout. The cost is that compilers and tools now need an additional layer of interpretation before the graph is clear.

Most practical systems mix the two. Rust's `mod` declarations create logical modules, but the filesystem still constrains where out-of-line module bodies are found. Java package names are declared, but directory structure is expected to mirror them. The real design variable is therefore not binary "file-based or declared", but **how authoritative the filesystem is**.

This decision matters early. A fully file-based model buys simplicity and fast tooling bootstrapping. A declared model buys flexibility and future abstraction power. A hybrid model can work well, but only if the resolution rules stay deterministic.

### 2.2. Flat vs hierarchical namespaces

A second axis is whether modules exist in a **flat set** or a **nested tree**.

A **flat module space** means each module is named as a single top-level entity, perhaps with conventions layered above it. Erlang is the classic example: each file is one named module, and cross-module reference is direct. Flat systems reduce ceremony and resolution complexity, but they scale poorly as ecosystems grow unless package naming conventions do significant extra work.

A **hierarchical namespace** introduces parents and children: `std.io`, `crypto.hash.sha2`, `crate::parser::lexer`, `net/http`, and so on. Hierarchies help organize large APIs and encode conceptual structure. They also make selective visibility and re-export patterns more meaningful, because the tree itself expresses ownership and adjacency.

But hierarchy can mean different things:
- the filesystem tree may be the namespace tree,
- the declared module path may be the namespace tree,
- the package path may be the namespace tree,
- or several of these may only approximately align.

That distinction becomes important later when discussing re-exports and path clarity. A hierarchy is useful only if users can reliably predict what kind of hierarchy it is.

### 2.3. Static imports vs import-time execution

One of the most consequential distinctions in the entire document is whether an import is merely a **dependency declaration** or whether it also causes **module body execution**.

In a **static import** system, an import primarily says: "make these names available and add an edge in the compile/build graph." The imported module may still have initialization semantics, but those semantics are not generally exposed as arbitrary top-level executable behavior with language-level side effects visible to ordinary importers. Rust, Zig, and Go lean heavily toward this model.

In an **import-time execution** system, importing a module performs work. Python executes module top-level code. CommonJS executes the body of the required file. JavaScript ESM has static syntax, but module instantiation and evaluation are still runtime events that can observe ordering, trigger side effects, and expose partially initialized state in cycles. Ruby's `require` likewise loads and executes code.

This distinction drives several downstream properties:

- **Tooling**: static imports are easier to index and reason about without executing code.
- **Cycles**: runtime execution forces a language to define what happens when a module is observed mid-initialization.
- **Determinism**: import-time execution can make behavior environment-sensitive.
- **Testing and reproducibility**: side-effectful imports can make "just loading code" already mutate global state.

For a language designer, this may be one of the highest-leverage decisions. Refusing import-time execution by default sharply simplifies the compiler, tooling, and initialization model. Allowing it buys flexibility, plugin-style extension, and dynamic metaprogramming surfaces — at considerable cost.

### 2.4. Explicit exports vs public-by-default

A language must decide what becomes visible outside a module.

In an **explicit export** design, nothing leaves the module boundary unless marked: `pub`, `export`, `provide`, export lists, or similar mechanisms. Rust, Zig, Racket, and many typed module systems follow this path. The design bias is toward hiding by default, which supports refactoring and prevents accidental API growth.

In a **public-by-default** design, declarations are externally visible unless hidden or omitted from a separate interface surface. OCaml without `.mli` files, Python's conventional openness, and some namespace-based languages approximate this. The benefit is less friction for small code. The cost is that internals can become accidentally depended on.

A third variant is **convention-based export**, where names are public if they match a naming rule. Go is the most important example: identifiers beginning with an uppercase letter are exported, lowercase ones are package-internal. This is unusually lightweight, but also unusually dependent on lexical naming discipline.

There is also a distinction between:
- export visibility to *everyone*,
- export visibility only within a package/crate,
- export visibility to parents/ancestors,
- and re-exports, where a module republishes names from another one.

The richer the visibility lattice, the more precisely large codebases can express intent. The simpler the lattice, the easier it is to teach and implement. The trade-off is real.

### 2.5. Cycles: forbidden, tolerated, or structured

Module graphs raise the question every sufficiently large codebase eventually hits: what if A depends on B and B depends on A?

A language can answer this in several ways.

**Hard prohibition** makes the dependency graph a DAG. Go is the canonical example. This yields cleaner compilation scheduling, simpler initialization semantics, and easier tooling, but it pushes programmers toward interfaces, refactoring, or graph restructuring when cycles would otherwise appear naturally.

**Tolerance with partial initialization** permits cycles, but then the language must specify what is visible when a module is imported before its body has finished executing. Python and JavaScript ESM both live here, though with very different semantics. This buys flexibility, but often surprises users and complicates failure modes.

**Structured mediation** means the language provides a higher-order abstraction layer — signatures, functors, interfaces, or explicit dependency injection patterns — so cycles are broken not by runtime tolerance but by architectural indirection. ML-family systems are especially strong here.

This axis matters because cycle policy is never just a convenience rule. It determines whether the module system is helping enforce architecture, or merely reflecting it after the fact.

### 2.6. Module identity: path-based, package-based, or declaration-based

When two pieces of code both say they import `foo.bar`, what makes that the *same* `foo.bar`?

Some systems say the answer is **filesystem path**. Others say it is **declared module name**. Others say it is **package-manifest identity plus path inside the package**. Still others incorporate URLs, registry paths, or major-version suffixes into identity.

This matters because identity influences:
- caching,
- dependency resolution,
- reproducible builds,
- documentation links,
- binary compatibility,
- and conflict handling between different versions of "the same" library.

Go is a particularly strong case: package import paths are built from module path plus directory path, and semantic import versioning bakes major version into the path. Python is a contrasting case: import identity is heavily path-search-based and less tightly tied to distribution identity. Rust separates package, crate, and module identities in a more layered way.

A useful module system must therefore decide not only how names are written, but what those names actually denote.

### 2.7. Module system vs package manager

The interaction between language-level modularity and ecosystem-level package management is canonical in `PACKAGING.md §2.2`. The summary: a module system manages source-level imports and visibility; a package manager handles distribution, versioning, registries, and build orchestration. The two can be tightly fused (Cargo, Go), loosely coupled (Python), or mediated by metadata (Node).

### 2.8. Module boundaries and runtime state

Finally, a module may exist only at compile time, or it may also be a runtime object with initialization and state.

In static systems, a module is mostly a source and compilation boundary. In dynamic systems, a module often becomes a singleton object created at first import, with mutable top-level state and initialization order semantics. Even static-looking systems can drift toward runtime module identity once reflection, dynamic loading, or plugin architectures are introduced.

This matters for:
- reloading,
- hot swapping,
- plugin systems,
- test isolation,
- side effects,
- concurrency,
- and debugger behavior.

A system with runtime module objects must answer:
- when does initialization happen?
- does it happen once?
- can it be repeated?
- how do cycles behave?
- how much state may a module retain globally?

A system that keeps module boundaries mostly compile-time can avoid many of these questions, but may need separate mechanisms later for plugins or scripting.

This is another high-leverage choice: if modules are kept primarily static and non-executing, many later features become easier to specify cleanly. If dynamic loading is ever desired, it can be added as a separate mechanism instead of entangling every import with runtime behavior.

---

## 3. Static Compile-Time Graph Systems

This chapter covers the family of module systems that most directly optimize for **deterministic dependency graphs, separate compilation, and tooling clarity**. In these systems, an import is primarily a compile-time edge: it makes names available, constrains visibility, and adds a node-to-node dependency in the build graph. Importing a module is not generally treated as arbitrary top-level program execution in the Python or CommonJS sense.

That does not mean these systems are identical. They still vary sharply along several of the axes from Chapter 2:

- whether the top-level unit is a crate, package, or file;
- how tightly the filesystem constrains module identity;
- whether exports are explicit or convention-based;
- whether re-exports are first-class;
- whether import cycles are prohibited outright;
- and how much the package manager participates in identity and resolution.

The common thread is that the compiler and tools can usually construct the module graph **without executing user code**. That property has large consequences. It makes unused-import detection easy. It makes code indexing and jump-to-definition reliable. It makes incremental invalidation more local. It makes cycle handling a structural property instead of a runtime hazard. And it often pushes language communities toward architectural styles where dependency direction is visible and enforceable.

The languages in this chapter — Rust, Zig, Go, and Odin — are especially relevant to systems-language design because they are all trying, in different ways, to give programmers strong control over structure without drifting into the higher-order typed-module world of ML or the runtime-import world of Python and JavaScript.

### 3.1. Rust — Crates, Modules, `use`, and the Visibility Lattice

Rust's module system is layered. The outermost unit is the **package**, which is Cargo's build/share/publish concept. A package contains one or more **crates**, and a crate is the compiler's primary compilation unit: a library crate or binary crate rooted at `lib.rs` or `main.rs`. Inside a crate is a **tree of modules** formed by `mod` declarations and inline module bodies. This three-level distinction — package, crate, module — is one of Rust's most important design choices because it prevents "what gets compiled together?", "what gets published together?", and "what is a namespace boundary?" from collapsing into one concept.

A `mod foo;` declaration introduces a child module and, when out-of-line, loads its body from the filesystem according to the logical module path. The filesystem matters, but it is not wholly authoritative: the logical module tree is created by declarations, and the file layout must satisfy those declarations. Rust 2018 simplified this significantly by making path rules more consistent and by largely removing the need for `extern crate`.

Rust's import mechanism, `use`, is path-oriented rather than loader-oriented. It brings names into scope, optionally renames them, and supports selective imports, grouped imports, glob imports, and re-exports via `pub use`. This makes **API curation** a first-class module-system activity. A crate can hide an internal tree behind a flatter public facade, or expose a carefully chosen "prelude"-style surface while freely reorganizing internals underneath.

Visibility is unusually rich compared with many systems languages. In addition to private vs public, Rust offers `pub(crate)`, `pub(super)`, `pub(self)`, and `pub(in path)`. This is a real design advantage for large codebases: it lets a project express "visible across this internal subsystem but not outside the crate" without inventing artificial package boundaries or naming hacks. The trade-off is more conceptual surface area for learners.

The privacy default is deliberately restrictive: items are private unless made visible. This makes hiding the default and API publication explicit, which aligns well with refactoring and semantic versioning. It also means that "module organization" and "public API design" are tightly linked — something the Rust 2018 cleanup tried to make clearer after years of community confusion around pre-2018 path semantics.

Rust strongly prefers **acyclic crate graphs**. The language and Cargo ecosystem do not tolerate cyclic crate dependencies in ordinary practice, and the module tree inside a crate is not designed as a cycle-tolerant runtime graph either. Architectural indirection is expected to happen through traits, smaller crates, or internal module refactoring rather than through cyclic import semantics.

Rust is a strong example of a system where:
- package identity,
- compilation identity,
- module-tree identity,
- and visibility control

are related but not collapsed into one mechanism. The downside is complexity. The upside is that tooling, encapsulation, and API shaping are all unusually powerful.

Sources: https://doc.rust-lang.org/reference/items/modules.html and https://doc.rust-lang.org/reference/visibility-and-privacy.html and https://doc.rust-lang.org/cargo/reference/manifest.html and https://doc.rust-lang.org/edition-guide/rust-2018/path-changes.html

### 3.2. Zig — `@import`, Namespaces as Values, and Low-Magic Resolution

Zig's module/import story is much more austere. The built-in function `@import(...)` takes a file path or package name and yields a namespace-like struct containing the imported file's public declarations. This is one of Zig's most distinctive design moves: import is not presented as a special statement that mutates scope through hidden language machinery; it is a compile-time construct that produces a value-like namespace object.

In practice, Zig code usually binds this namespace to a local constant:

- `const std = @import("std");`
- `const foo = @import("foo.zig");`

and then accesses declarations through that namespace. This gives imports a strong *lexical explicitness*. Names do not silently appear in scope just because a file imported something. The programmer chooses the local binding, and later uses are visibly qualified unless manually aliased.

The standard library import `@import("std")` is compiler-recognized, while other imports resolve by file path or configured package names. The build system is deeply relevant here. Zig's `build.zig` constructs the artifact graph explicitly, and root modules are provided to executables and libraries through build declarations. This means that source-level module resolution and build-graph formation are not separate, loosely synchronized systems; they are intentionally close.

Like Rust and Go, Zig's imports are primarily static dependency edges. Importing a Zig source file does not mean "run this module body now and cache its object." It means "make these declarations available at compile time under this namespace." That keeps indexing, dead-import detection, and dependency analysis simple. It also fits Zig's broader philosophy: no hidden control flow, no hidden allocation, no hidden work.

Zig's module system is comparatively weak as an abstraction mechanism and comparatively strong as a transparency mechanism. It does not try to be a typed module calculus. It does not provide a large visibility lattice. Its strength is that the programmer can usually answer "where did this name come from?" and "what file or package defines this?" by local inspection.

The main trade-off is that package and dependency ergonomics can become build-system-shaped. Because `@import` and the build graph are closely related, package exposure and dependency naming are partly configured outside the source file. This is not necessarily bad — in fact it helps determinism — but it means the language surface and the build surface must be designed together.

Zig is an especially valuable reference for languages that prioritize:
- deterministic static imports,
- no import-time execution,
- explicit namespace usage,
- and a module system that stays easy for tools to reason about.

Sources: https://ziglang.org/documentation/master/#import and https://ziglang.org/learn/build-system/ and https://ziglang.org/documentation/master/#Packages

### 3.3. Go — Package DAGs, Capitalization Exports, and Cycle Prohibition

Go's module story is simple in surface syntax and strict in architectural consequences. The language-level unit is the **package**, which is generally one directory of `.go` files sharing the same package clause. The distribution/versioning unit is the **module**, rooted by a `go.mod` file. Import paths combine these two worlds: the module path supplies the prefix, and the package directory supplies the suffix.

This split is central. A Go module is "a collection of packages that are released, versioned, and distributed together"; a Go package is the compilation and namespace unit. That makes Go closer to Rust than to Python: package identity, build identity, and distribution identity are related but not identical.

Imports are fully static. The compiler and `go` tool read import paths from source files, resolve them through the module graph, and build a DAG of package dependencies. Go's famous **import cycle prohibition** falls naturally out of this design. If the compiler wants packages to be independently compilable in dependency order — and potentially in parallel — then the package graph must be acyclic. The language chooses to enforce that rule structurally instead of tolerating partially initialized packages or hidden runtime loaders.

This is one of the cleanest examples in language design of a restriction that is painful locally but beneficial globally. Programmers dislike import cycles because the compiler rejects code that "obviously" could be made to work with a loader. But Go's tooling and compile-speed story are stronger precisely because the language refuses that complexity. Dependency direction becomes visible in architecture, not just in runtime behavior.

Visibility is also unusual: **capitalization determines export**. Identifiers beginning with an uppercase letter are exported from the package; lowercase identifiers are package-private. This is extremely lightweight and avoids explicit `pub` markers, but it also means the module system depends on a naming convention rather than an explicit declaration. The convention is simple enough that it works in practice, but it is less expressive than Rust's scoped visibility lattice.

Go's package-per-directory rule is also strong. Filesystem structure is not merely conventional metadata; it materially determines package identity. This gives the ecosystem a lot of uniformity and makes resolution straightforward. The cost is reduced flexibility for rearranging source trees independently of logical organization.

The Go modules layer adds another important design lesson: **package identity and version identity are linked by import paths**. Semantic Import Versioning encodes major version into the module path itself for v2+, so the source import path changes when compatibility changes. This is a powerful reproducibility move, but it also means that versioning policy leaks directly into source-level naming.

Go is a particularly clear reference for a deliberately **DAG-enforcing, compiler/tooling-first** module model. It is especially relevant to languages that value fast builds, clean architecture boundaries, and deterministic tooling over flexible cyclic semantics.

Sources: https://go.dev/ref/spec#Packages and https://go.dev/ref/mod and https://research.swtch.com/vgo-import and https://go.dev/blog/package-names

### 3.4. Odin — Package-Per-Directory Simplicity

Odin's package model is simpler and less formally layered than Rust's or Go's, but that simplicity is exactly why it is valuable as a reference point. Odin organizes code around **packages**, with directory structure playing a large role in package identity and import organization. The official ecosystem is further described in terms of **collections** such as `base`, `core`, and `vendor`, which act as grouped roots of packages rather than as semantic language features in the ML sense.

The language aims for low ceremony. There is less emphasis on explicit module declarations as separate syntactic objects and more emphasis on "code in this package directory belongs together." This makes the module/import system easy to explain and easy to operate in smaller codebases. It also fits Odin's broader philosophy of directness and low abstraction overhead.

Compared with Go, Odin appears less rigidly optimized around a package-DAG-as-compilation-machine story, at least in its public presentation. Compared with Rust, it offers less expressivity in visibility structure and fewer distinct layers between package, compilation unit, and published artifact. But the benefit is ergonomic clarity: code organization is visible from the filesystem and import paths without much extra language machinery.

This makes Odin useful in two ways.

First, it is a reminder that a systems language does not need Rust's level of module-system richness to be usable. A package-per-directory model with predictable import rules may be sufficient if the language's goals emphasize readability, straightforward tooling, and a relatively opinionated project layout.

Second, Odin is a good counterweight to Go. Both lean on directory/package organization, but Go turns that into a hard architecture rule with cycle prohibition and capitalization-driven exports. Odin's ecosystem suggests a softer, more convention-shaped style — useful for calibrating how strict the rules should be.

At the same time, Odin's official documentation is less specification-like than Rust's, Go's, or Python's. For this document, that means Odin should be treated as a practical design point with lighter formal grounding, not as the primary reference for edge-case semantics.

Sources: https://odin-lang.org/docs/overview/#packages and https://odin-lang.org/docs/overview/#import-statements

### 3.5. Design Lessons from the Static Family

Taken together, Rust, Zig, Go, and Odin show a coherent family resemblance:

- imports are primarily **static dependency edges**;
- the compiler can build the import graph without executing user code;
- filesystem layout matters materially, though to different degrees;
- module/package boundaries are used to support compilation and tooling, not just name grouping;
- cycle tolerance is low or absent compared with dynamic languages;
- visibility is part of architectural discipline, not just syntax sugar.

But they also span a meaningful range inside that family:

- **Rust** maximizes expressivity in visibility and API shaping.
- **Zig** maximizes explicitness and low-magic namespace imports.
- **Go** maximizes compile-graph clarity and enforces architectural acyclicity.
- **Odin** maximizes low-ceremony package organization.

This is already enough to suggest a language designer should decide early whether to sit closer to:
- Rust's explicit API curation,
- Zig's transparent namespace imports,
- Go's hard DAG discipline,
- or Odin's low-ceremony package layout.

The likely common baseline among them is:
- static imports,
- no import-time execution,
- deterministic resolution,
- explicit or strongly legible exports,
- and a module graph simple enough for the compiler and IDE to trust.

---

## 4. Runtime Import Systems

This chapter covers the family of module systems where importing a module is not merely adding a static edge in the compiler's dependency graph, but also a **runtime event**. The imported module may be searched for dynamically, instantiated lazily, evaluated immediately, cached as a singleton object, or observed in a partially initialized state during cycles. These systems often support highly flexible extension patterns and interactive workflows, but they pay for that flexibility with more complicated initialization semantics and weaker static analyzability.

The contrast with Chapter 3 is the point. Rust, Zig, Go, and Odin mostly treat imports as compile-time structure. Python, JavaScript, CommonJS, Ruby, and many Lua module conventions treat imports as part of execution. In these systems, the import graph is also an initialization graph. Tools and compilers can still analyze parts of it statically, but they must account for the fact that importing is semantically meaningful even before any "real" application code begins.

Three consequences recur across this family:

- **module identity is often a runtime object identity**, not only a source-level path identity;
- **cycles require initialization semantics**, not just graph validation;
- **tooling quality depends on how much of the loader behavior remains predictable without executing code**.

This family is especially useful as both a warning and a source of design trade-offs. Runtime import systems can be productive and expressive, but they demand more careful answers to ordering, side effects, caching, and partial initialization than static systems do.

### 4.1. Python — Module Objects, Packages, and Import-Time Execution

Python's import system is the clearest mainstream example of modules as **runtime objects**. Importing performs two conceptually distinct operations — finding/loading a module and then binding it into the importing scope — but the visible effect for programmers is that `import x` executes code if `x` has not been imported yet. A Python module is therefore not just a namespace in the abstract sense; it is a cached object produced by executing top-level code.

This model extends naturally to **packages**. A regular package is typically a directory containing an `__init__.py` file, and importing the package executes that file. The package can define names, mutate `__path__`, perform setup work, or trigger further imports. Python also supports **namespace packages**, where `__init__.py` is absent and the import machinery synthesizes package structure from the search path. This is elegant in distribution terms, but it makes identity and resolution even more loader-sensitive.

The import machinery itself is layered: fully qualified names, finder/loader protocols, `importlib`, path hooks, and module specs all participate. This gives Python enormous flexibility — embedders, zip imports, plugin systems, and custom importers are all viable — but it also means that "what does this import mean?" is partly answered by the runtime environment. A source file alone is not always enough.

Cyclic imports illustrate the cost. Since modules are created and cached before their execution finishes, one module can observe another in a **partially initialized** state. This is not merely an annoying edge case; it is an unavoidable consequence of executable imports. The programmer must understand not just the dependency graph, but the evaluation order of top-level code and when specific names become available.

Python is the strongest case against casually allowing import-time execution. The model is powerful, but it moves initialization order, loader behavior, and side effects into what would otherwise be a simple structural feature. That cost propagates into tooling, testing, and architecture.

Sources: https://docs.python.org/3/reference/import.html and https://peps.python.org/pep-0328/ and https://peps.python.org/pep-0420/ and https://docs.python.org/3/library/importlib.html

### 4.2. JavaScript ESM — Static Syntax, Live Bindings, and Runtime Evaluation

ECMAScript modules occupy a hybrid position. Their **syntax is static** — `import` and `export` forms are known to the parser and usable by bundlers and compilers — but module loading, instantiation, and evaluation are still runtime semantics. This gives ESM much more static analyzability than Python or CommonJS, while still retaining the notion of a runtime module instance.

One of ESM's most important design choices is **live bindings**. An importer does not receive a copy of an exported value; it receives access to the exporter's binding slot. This is a significant semantic difference from object-copy or mutable-export models and is one reason ESM cycles can sometimes work where CommonJS-style cycles fail. The binding exists before evaluation completes, but its value may remain uninitialized until the exporter runs.

That leads directly to ESM's cycle semantics. Cycles are tolerated, but they are not free. If two modules depend on one another and access each other's bindings only after both have completed the relevant initialization, execution can succeed. If one accesses a still-uninitialized binding too early, evaluation fails. This is more principled than Python's "partially initialized module object" behavior, but it still means the runtime semantics of evaluation order matter.

Node adds another layer: the same ESM semantics live inside a platform-specific resolution and format-selection system. The `"type": "module"` field, `.mjs`, URL-based resolution, and `exports` maps all participate in how a module specifier becomes a concrete module record. This is not a language-level module system in isolation; it is a language-plus-runtime-plus-package-metadata system.

The design lesson is subtle. ESM shows that **static syntax does not automatically imply static semantics**. A language can have parse-time-known imports and still inherit complex runtime initialization, cycle, and environment-resolution behavior. A language that wants the analyzability benefits of static syntax may also need to reject or tightly limit ESM-style runtime loader semantics.

Sources: https://tc39.es/ecma262/#sec-modules and https://nodejs.org/api/esm.html and https://html.spec.whatwg.org/multipage/webappapis.html#module-system and https://hacks.mozilla.org/2018/03/es-modules-a-cartoon-deep-dive/

### 4.3. Node CommonJS — `require`, Mutable Exports, and Loader-Centric Semantics

CommonJS is the older Node.js module model and represents a different point in the design space from ESM. Here, the primary abstraction is not live bindings between declared exports, but a **loader function**: `require(...)` executes the target module the first time, caches the resulting module object, and returns its exports.

This makes CommonJS straightforward and dynamic, but much less statically transparent than ESM. Because `require` is an ordinary function call, it can be conditional, data-driven, or path-manipulated. This flexibility was historically useful, but it means the import graph is not as directly visible to the parser or build tools. Bundlers and analyzers can often recover most of it, but only by applying heuristics or conventions.

The export model is also different. CommonJS modules typically fill out a mutable `module.exports` object. Consumers receive that object rather than a set of live binding slots. This makes interop intuitive for some dynamic programming patterns, but it weakens the connection between declared module surface and the compiler-visible namespace structure. It also means cycles behave differently from ESM cycles: what another module sees depends heavily on exactly when `module.exports` has been populated.

CommonJS matters for this document not because it should be imitated directly, but because it demonstrates what happens when the loader becomes the semantic center of modularity. The system becomes flexible and easy to extend locally, but the graph becomes less explicit and less compiler-friendly. ESM was, in part, a reaction to these limits.

Sources: https://nodejs.org/api/modules.html and https://nodejs.org/api/packages.html

### 4.4. Ruby and Lua — Lightweight Runtime Loading Models

Ruby and Lua are worth noting as lighter-weight members of the runtime-import family. They are less specification-heavy than Python's import machinery or Node's ESM/CJS split, but they illustrate the same broad theme: loading code is part of runtime behavior, not merely compile-time structure.

Ruby's `require` and `load` model encourages a culture where module boundaries are relatively soft. Files are loaded, classes and modules are opened or reopened, and monkey patching is normal enough that visibility boundaries often function more as convention than hard encapsulation. This is productive in small systems and REPL-heavy workflows, but it weakens the guarantees that tooling and architecture can rely on.

Lua traditionally treats modules as tables returned by executed files. This is in some ways an even more stripped-down version of the same idea: a module is whatever namespace-like object the file computes and returns. For embeddable systems, this can be excellent — the language imposes little structure and leaves policy to the host or the application. But the cost is that modularity becomes a convention, not a strong semantic substrate.

These systems are useful cautionary reference points for language design. They show that a language can survive with highly flexible runtime loading, but that such flexibility tends to weaken the compiler and toolchain's ability to reason about program structure in advance.

Sources: https://docs.ruby-lang.org/en/master/Kernel.html#method-i-require and https://www.lua.org/manual/5.4/manual.html#6.3 and https://www.lua.org/pil/8.html

### 4.5. Perl 5 — Symbol-Table Modules and `use` as Compile-Time `require + import`

Perl 5 is the historical predecessor that Raku reacts against (forward-ref §8.9), and a useful contrast against the more elaborate runtime-import systems above. A Perl package is declared with `package Foo;` and creates a symbol table named `%Foo::`. Subroutines, variables, and other names live in that hash, with no language-level visibility distinction — `our $x` is package-scoped, `my $x` is lexically-scoped, but neither restricts cross-package access. Any code can read `$Foo::x` from anywhere.

`use Module;` desugars exactly to `BEGIN { require Module; Module->import(LIST); }` — the `BEGIN` block forces compile-time execution. `require` is the lower primitive: it loads a `.pm` file by searching `@INC` (the module search path, populated from compiled-in defaults plus `PERL5LIB` and `-I` flags), then executes the file. `import` is just a method call that the convention `Exporter` module standardizes — `@EXPORT` names are imported by default, `@EXPORT_OK` are imported on request, `%EXPORT_TAGS` groups them by tag. None of this is enforced by the language; it's all convention layered on top of "modules are symbol tables" and "`use` calls `import`."

The split between `use` (compile-time) and `require` (runtime) is the direct ancestor of Raku's `use`/`need`/`require` three-way split, and CPAN is the ecosystem Raku's fez/zef explicitly replaces. The contrast clarifies what Raku's ambitious identity model actually buys: Perl modules have *no* identity beyond filesystem path and package name, which is why CPAN suffered the supply-chain attacks that fez/zef was designed to close.

Sources: https://perldoc.perl.org/functions/use and https://perldoc.perl.org/functions/require and https://perldoc.perl.org/Exporter and https://perldoc.perl.org/perlmod

### 4.6. Common Lisp — Packages as Symbol Namespaces, `defpackage`, and ASDF

Common Lisp's `defpackage` is the richest export-list mechanism in the survey. A package declaration looks like:

```lisp
(defpackage #:my-app
  (:use #:cl)
  (:nicknames #:app)
  (:shadow #:format)
  (:shadowing-import-from #:alexandria #:hash-table-keys)
  (:import-from #:bordeaux-threads #:make-thread)
  (:export #:run #:configure)
  (:intern #:helper))
```

The distinguishing property of Common Lisp packages: **they namespace symbols, not bindings**. A symbol — the canonical name token — is *interned* in exactly one home package, but can be made *accessible* in many other packages via `use`, `import`, or qualified reference. Functions, variables, classes, and macros all live in symbols, so namespacing-by-symbol governs all of them uniformly. Six distinct relationships exist: present-and-internal (interned in the package, not exported), present-and-external (interned and exported), inherited (visible via a `:use`d package), shadowed (a local symbol blocks an inherited one of the same name), shadowing-imported (an imported symbol blocks an inherited one), and uninterned (`#:foo` syntax — a symbol belonging to no package).

Qualified syntax: `pkg::name` accesses an internal symbol (double-colon, by convention discouraged in client code); `pkg:name` accesses an exported symbol (single-colon, the public-API form). The lexical convention itself encodes the visibility distinction. `IN-PACKAGE` switches the current package for subsequent reads.

**ASDF (Another System Definition Facility)** is the system-definition layer that sits above packages — the equivalent of Cargo or npm. An ASDF system declared in a `.asd` file lists components (Lisp files) with dependencies, supports versions, and integrates with Quicklisp (the de facto package archive) for distribution. The two-layer split is deliberate: packages are language-level symbol-namespace machinery; ASDF systems are ecosystem-level distribution units. They can be one-to-one but commonly aren't — a single ASDF system can define multiple packages.

The lesson: **a sufficiently rich symbol-namespace operation set (use, import, shadowing-import, intern, export, shadow) eliminates the need for separate "import keyword variants"**. Languages like Python and Java have one `import` keyword and accumulate workarounds for partial imports, renames, and conflicts; Common Lisp expresses all those operations as orthogonal options on `defpackage`. The cost is conceptual surface area — `:shadow` vs `:shadowing-import-from` vs `:import-from` is a non-obvious distinction.

Sources: https://www.lispworks.com/documentation/HyperSpec/Body/m_defpkg.htm and https://www.lispworks.com/documentation/HyperSpec/Body/f_export.htm and https://lisp-docs.github.io/docs/tutorial/packages and https://asdf.common-lisp.dev/

### 4.7. Clojure — First-Class Dynamic Namespaces, `:require` vs `:import`

Clojure's namespace model differs from every other entry in this survey in one specific way: **namespaces are runtime-mutable first-class objects**, mapping symbols to Vars (function/value bindings) and Class objects (Java classes brought in via `:import`). They can be created, removed, modified, enumerated, and inspected at runtime via `all-ns`, `find-ns`, `ns-publics`, `ns-imports`, `ns-resolve`. This is similar to Common Lisp's package model in that namespaces are first-class, but Clojure additionally tracks the JVM class space alongside the Clojure namespace space.

The `ns` macro is the standard top-of-file declaration:

```clojure
(ns my-app.core
  (:require [clojure.string :as str]
            [clojure.set :refer [union intersection]]
            [my-app.config :as-alias config])
  (:import [java.util.concurrent ConcurrentHashMap]
           [java.time Instant]))
```

The interesting design choice is the **orthogonal `:require` vs `:import` split**. `:require` loads Clojure namespaces (compiles them if not yet compiled, populates the runtime namespace map), with sub-options `:as` (alias), `:refer` (selective import of named Vars), `:as-alias` (alias without loading — used for namespace-qualified keywords without forcing the namespace to exist as a source file). `:import` brings in Java classes, with no analogous `:as` or `:refer` (Java classes go into the namespace's class map, not its Var map). The two mechanisms coexist because the JVM class loader and the Clojure runtime are different naming systems with different invalidation rules.

`:as-alias` is a uniquely Clojure feature worth naming: it lets you write `::config/timeout` (a namespace-qualified keyword) in code without requiring `my-app.config` to exist as a source file. The qualified keyword resolves through the alias map, not the namespace-load machinery. Used heavily for clojure.spec definitions and other late-bound qualified-keyword patterns.

The dynamic-mutability is genuinely used: REPL-driven development in Clojure relies on redefining Vars in a running namespace via `def`, with the new definition taking effect immediately for unqualified callers. This is the basis for Clojure's interactive workflow — much closer to Common Lisp's image-based development (covered in `DEBUGGERS.md §3.5`) than to Java's compile-and-restart model.

Sources: https://clojure.org/reference/namespaces and https://clojuredocs.org/clojure.core/ns and https://clojuredocs.org/clojure.core/require and https://clojure-doc.org/articles/language/namespaces/

### 4.8. Tcl — Orthogonal Namespaces and Packages

Tcl is the cleanest example in the survey of **two completely orthogonal modularity mechanisms**: namespaces (pure naming, no distribution semantics) and packages (versioned distribution, no naming semantics). The two are independent and serve different purposes.

A namespace is declared with `namespace eval ::foo { ... }`. Names inside use `::` as the path separator: `::foo::bar` references `bar` inside `foo` from the global namespace. Namespaces nest, support `namespace export` for visibility hints, and follow Tcl's lexical scoping rules. They have no distribution identity — a namespace exists in one Tcl interpreter for as long as it's defined, and is gone otherwise.

A package is declared with `package provide MyPkg 1.3` (typically inside a Tcl source file) and consumed with `package require MyPkg 1.2-2.0` (asking for a version in a range). The discovery mechanism is `pkgIndex.tcl` files in directories on the Tcl auto-path: each file contains `package ifneeded MyPkg 1.3 [list source [file join $dir mypkg.tcl]]`, which registers a script-to-execute to load that specific version. The `pkg_mkIndex` helper auto-generates these. `package require` searches the registered index, picks the best matching version, and runs the registered script.

The crucial design point: **multiple versions of the same package can be registered simultaneously**. `pkgIndex.tcl` registrations are version-keyed; the resolver picks one when `package require X 1.2` is called. The application can hold one version while a sub-component requires another — though only one is *loaded* at a time per package name.

By convention, a package called `MyPkg` defines a namespace called `::MyPkg` and puts all its commands there. But this is convention, not a language requirement — `package provide` and `namespace eval` are independent constructs. A package could create no namespace; a namespace could exist without any package mechanism.

The lesson is that **modularity has two distinct concerns — naming and distribution — and they don't need to be coupled at the language level**. Most modern languages collapse them (Rust: package contains crates contains modules; Go: module contains packages). Tcl shows the alternative: keep them orthogonal, make the convention-of-correspondence explicit but not enforced. The cost is more concepts; the benefit is each mechanism stays simple and uncoupled.

Sources: https://www.tcl-lang.org/man/tcl8.6/TclCmd/package.htm and https://www.tcl-lang.org/man/tcl8.6/TclCmd/namespace.htm and https://wiki.tcl-lang.org/page/package+ifneeded

### 4.9. Design Lessons from the Runtime Family

Python, ESM, CommonJS, Ruby, Lua, Perl 5, Common Lisp, Clojure, and Tcl collectively show a coherent alternative to the static systems of Chapter 3.

Their common traits are:

- module loading is at least partly **runtime behavior**;
- imports participate in **initialization order**;
- module identity often has a **singleton runtime-object** dimension;
- cycles require semantic treatment, not merely graph validation;
- loader or environment configuration has real influence over meaning.

Specific design lessons added by the symbol-table and Lisp-family entries:

- **Symbol-table-as-namespace** (Common Lisp packages, Perl 5 packages, Clojure namespaces): if the language already has a symbol-table-shaped runtime, the module system can be a thin layer over it — at the cost of no enforced visibility unless the language adds one.
- **A sufficiently rich symbol-namespace operation set** (Common Lisp's `:shadow`/`:shadowing-import-from`/`:import-from`/`:export`/`:intern`) eliminates the need for separate "import keyword variants" — but at the cost of conceptual surface area.
- **Orthogonal naming and distribution** (Tcl namespaces vs packages): the two concerns can be language-decoupled. Most languages collapse them; the choice is deliberate.
- **Two parallel module systems for two underlying naming systems** (Clojure `:require` for Clojure namespaces, `:import` for Java classes): when a runtime spans two distinct naming systems, the module language can carry both via orthogonal keywords rather than forcing them into one mechanism.
- **First-class runtime-mutable namespaces** (Clojure, Common Lisp): the basis for REPL-driven and image-based development, but ties the language to a runtime model that compilers and static tooling have to participate in.
- **Compile-time `use` vs runtime `require`** (Perl 5 `use` = `BEGIN { require + import }`): the split between "available at compile time" and "available at runtime" is a meaningful distinction that more languages should expose explicitly.

The advantage of the runtime family is flexibility. Plugin architectures, dynamic loading, reflective import patterns, and interactive workflows all become natural. The cost is that the language's module system now participates in execution semantics much more directly than in static systems. Compilers and IDEs can still do useful work, but they must either approximate loader behavior or re-implement parts of it.

This family sharpens one of the central design questions for any language. A runtime-import model also chooses:
- initialization-order semantics,
- partially initialized cycle behavior,
- a more difficult tooling story,
- and a more environment-sensitive notion of module identity.

If modules are wanted primarily as compilation and architecture boundaries, the runtime family is more useful as a cautionary contrast than as a direct template.

---

## 5. Typed and Phase-Aware Module Systems

The static systems of Chapter 3 treat modules primarily as **dependency and visibility boundaries**. The runtime systems of Chapter 4 treat modules as **loader-mediated runtime objects**. A third family uses modules for something more ambitious: they become part of the language's *semantic abstraction machinery itself*. In this family, modules are not only containers of declarations. They may have interfaces as first-class objects, support parameterization over other modules, or participate in phase distinctions between compile-time and runtime environments.

This chapter is especially important for language design because it answers a different question from "how do I import another file?" It answers: **what is the largest abstraction unit the language wants to make explicit?** If the answer is "just files and packages", a language can stay close to the static systems. If the answer is "typed implementation boundaries, macro phases, and reusable semantic interfaces", then the design space starts to look more like ML and Racket.

The examples in this chapter therefore matter less as drop-in templates and more as **upper bounds on module-system ambition**. OCaml and Standard ML show what happens when modules become typed abstraction layers. Haskell shows a lighter-weight path where modules remain important but do not become a full higher-order module calculus. Racket shows a different axis entirely: modules as phase-indexed language-extension boundaries.

### 5.1. OCaml — Compilation Units, Signatures, and Functors

OCaml's module system is the clearest production example of modules as **typed abstraction units**. At the source-file level, OCaml uses **compilation units**: an `.ml` file is a module implementation, and an optional `.mli` file is its interface. A compilation unit named `A` behaves roughly like:

`module A : sig ... end = struct ... end`

This is already a stronger abstraction boundary than the file-based systems in Chapter 3. Without an `.mli`, an implementation's inferred interface is exported by default. With an `.mli`, the author can sharply restrict what is visible. The file boundary is therefore both a compilation unit and a typed interface boundary.

But OCaml goes much further. Modules can be described by **signatures**, which play the role that types play for values. A signature specifies which types, values, submodules, and exceptions are visible. This means that "what a module promises" is itself a formal language object, not just an emergent property of public declarations.

On top of that, OCaml has **functors**: functions from modules to modules. A functor can take a module matching a given signature and produce a new module. This is a profoundly different view of modularity from the Rust/Zig/Go world. The module system is not just organizing names and dependencies; it is a way to write reusable, parameterized abstraction layers over whole groups of definitions.

The practical result is a module system with unusual expressive power:
- interfaces are explicit and type-like,
- abstraction barriers are strong,
- large systems can encode invariants at the module boundary,
- and "dependency inversion" can happen through functor application rather than only through object interfaces or traits.

The cost is also real:
- more concepts to learn,
- more surface area in the compiler,
- more ceremony for simple projects,
- and more distance from the file-as-module simplicity of Go or Zig.

OCaml is the strongest argument that module design can be a **semantic abstraction feature**, not merely an organizational feature. The key question is whether a language designer wants any part of that power, or wants to remain intentionally simpler. Full treatment of OCaml's value restriction and polymorphic-variant trade-offs lives in `TYPES.md §§6.8, 9`; OCaml 5's domains and effect-handler concurrency live in `CONCURRENCY.md §§5.5, 2.6`.

Sources: https://v2.ocaml.org/manual/moduleexamples.html and https://dev.realworldocaml.org/files-modules-and-programs.html and https://dev.realworldocaml.org/functors.html

### 5.2. Standard ML — Structures, Signatures, and the Classical Module Calculus

Standard ML is the classical reference for the typed module-system tradition that OCaml later industrialized. Its core concepts are:
- **structures** — module implementations,
- **signatures** — module interfaces,
- **functors** — parameterized modules.

The importance of SML in this document is conceptual. It makes the separation between:
- values and types,
- modules and signatures,
- implementation and interface,
- and modules and higher-order module computation

fully explicit. In other words, it presents the "module system" not as syntax around files, but as a language-within-the-language for managing abstraction at a larger grain.

This matters because many modern languages inherit only fragments of this tradition. Rust has strong visibility and package structure, but not higher-order modules. Haskell has modules and export lists, but not the same full functor-oriented module calculus. Racket has powerful module phases, but with a different emphasis. SML is the clean baseline for understanding what "modules as semantic abstraction" actually means before later languages compromise or specialize it.

The trade-off, as always, is that expressive power increases conceptual weight. SML's module system is elegant, but it is not lightweight. That makes it useful as a design boundary even when an implementer ultimately stays far simpler.

Sources: https://smlfamily.github.io/sml97-defn.pdf and https://www.cs.cmu.edu/~rwh/isml/book.pdf and https://homepages.inf.ed.ac.uk/dts/fps/papers/MacQueen.pdf

### 5.3. Haskell — Export Lists, Qualified Imports, and Package Layering

Haskell sits between the ML tradition and the simpler static systems. A Haskell module is declared explicitly, can provide an **export list**, and can import other modules either qualified or unqualified. This gives it a more formal and explicit surface than Python or Go, but without the full structure/signature/functor machinery of Standard ML and OCaml.

The export-list mechanism is especially important. It makes API surface a deliberate part of module declaration, rather than merely "everything public unless hidden". Qualified imports likewise make namespace control more explicit, helping avoid collisions without forcing a fully hierarchical package-qualified path on every use.

At the ecosystem level, Haskell also separates:
- module names,
- package names,
- and build/distribution units

more than some simpler systems do. Cabal/Stack package boundaries and module visibility rules are related, but not identical. This makes Haskell a useful design reference for ecosystems that want package-level and source-level identities layered without becoming the same mechanism.

Compared with OCaml, Haskell's module system is less ambitious as a semantic abstraction calculus. Compared with Rust or Go, it is more declaration-oriented and explicit about export surfaces. That middle position is a useful reference for languages that want stronger source-level API control without adopting full ML-style higher-order modules. Full treatment of GHC's richer type-system story lives in `TYPES.md §6.7`; GHC's lightweight-thread, capability, spark, and STM runtime design lives in `CONCURRENCY.md §§2.6, 3.7, 9.6`.

Sources: https://www.haskell.org/onlinereport/haskell2010/haskellch5.html and https://cabal.readthedocs.io/en/stable/cabal-package.html and https://downloads.haskell.org/~ghc/latest/docs/users_guide/packages.html

### 5.4. Racket — Modules, Phases, and `#lang`

Racket is the most important example in this chapter for a different reason: it treats modules as **phase-aware language-extension boundaries**. A Racket module is not only a namespace and compilation unit; it is also part of the language's macro-expansion model. Imports can be shifted across phases with forms like `for-syntax`, and modules can be instantiated or visited at different phase levels depending on whether they are needed for runtime evaluation or compile-time expansion.

This is a qualitatively different design point from both the static graph systems and the ML-style typed module systems. In Racket, modules participate directly in the language's metaprogramming semantics. The distinction between compile-time and runtime is not an implementation detail hidden behind proc-macro crates or compiler internals; it is part of the programmer-visible module language.

The `#lang` mechanism pushes this even further. A source file can declare not only "which module am I in?" but effectively "which language is this file written in?" That makes modules into language-construction boundaries. Racket's module system is therefore one of the strongest examples anywhere of **modules as extension substrate**, not just code organization.

This power comes with complexity:
- multiple phase levels,
- module instantiation vs visiting,
- different import modes for compile-time and runtime,
- and a tighter coupling between the expander and the module system than most languages ever attempt.

Racket is not primarily a candidate for direct imitation. It is a warning and an inspiration. If a language ever wants macros, DSLs, or language-as-library features at this level, then module phases must be designed deliberately. If that power is not wanted now, then Racket is evidence that it is often better deferred than approximated halfway.

Sources: https://docs.racket-lang.org/reference/Modules.html and https://docs.racket-lang.org/guide/module-paths.html and https://docs.racket-lang.org/guide/phases.html and https://docs.racket-lang.org/guide/hash-lang_reader.html

### 5.5. Ada — Packages, Specification/Body Split, Child Packages, Generic Packages

Ada (1980 / 1983 ISO standard) shipped one of the first formally-specified module systems in a production language, and most of its design choices are still load-bearing in safety-critical software 40+ years later. The unit of modularity is the **package**, declared in two parts:

```ada
-- foo.ads (specification)
package Foo is
   type T is private;
   function Make (X : Integer) return T;
   function Value (Self : T) return Integer;
private
   type T is record
      Val : Integer;
   end record;
end Foo;

-- foo.adb (body)
package body Foo is
   function Make (X : Integer) return T is
   begin
      return (Val => X);
   end Make;

   function Value (Self : T) return Integer is
   begin
      return Self.Val;
   end Value;
end Foo;
```

The specification declares the public interface; the body contains the implementation. The two are compiled separately. This is the design that became OCaml's `.mli`/`.ml` split (§5.1), ML's structures-and-signatures (§5.2), and influenced Modula-2's later DEFINITION/IMPLEMENTATION split (§5.6).

Ada's distinguishing features beyond the spec/body split:

- **Private parts in the specification.** A spec can declare types as `private`, exposing the existence of the type to clients while hiding its representation. The actual representation appears in a `private` block at the end of the spec — visible to the body but conceptually hidden from clients. This is opaque type abstraction baked into the language.
- **Child packages.** `Foo.Bar` is a child package of `Foo`, declared as `package Foo.Bar is ... end;`. Children have privileged visibility into their parent's private part, enabling internal hierarchy without exposing internals to unrelated clients. **Private child packages** (`private package Foo.Internal`) are visible only to other children of `Foo`, not to external clients of `Foo` — a fine-grained visibility lattice predating Rust's `pub(crate)`/`pub(super)` by decades.
- **Generic packages.** `generic type T is private; package Stack is ...` — packages parameterized over types, values, or other packages. Instantiated with `package Int_Stack is new Stack (T => Integer);`. The closest thing to ML functors in any production language outside the ML family.
- **`with` and `use` clauses.** `with Foo;` makes the package available; `use Foo;` brings its names into unqualified scope (discouraged in Ada style guides because of the visibility cost).

The `pragma Pure`, `pragma Preelaborate`, `pragma Elaborate_All` system controls package initialization order and side-effect-free guarantees — a highly explicit version of the initialization ordering that Python (§4.1) and ESM (§4.2) struggle with implicitly.

The lesson: **Ada shows that the specification/body split, opaque types, child packages, and generic packages are individually usable design points that compose without any single one becoming the "module system."** Most modern language designers cherry-pick from this menu; Ada has them all and demonstrates they can coexist coherently.

Sources: http://www.ada-auth.org/standards/22rm/html/RM-7.html and http://www.ada-auth.org/standards/22rm/html/RM-10.html and http://www.ada-auth.org/standards/22rm/html/RM-12.html and https://learn.adacore.com/courses/intro-to-ada/chapters/modular_programming.html

### 5.6. Modula-2 / Modula-3 / Oberon — The Wirth Lineage

Niklaus Wirth's three successors to Pascal — **Modula-2** (1978), **Oberon** (1986), and (with DEC SRC) **Modula-3** (1989) — collectively defined the design vocabulary that ML modules, OCaml's `.mli`/`.ml` split, and most of the typed-module-system literature inherit. None is in heavy current production use; their importance is foundational.

**Modula-2** introduced the `DEFINITION MODULE Foo` / `IMPLEMENTATION MODULE Foo` split:

```modula-2
DEFINITION MODULE Stack;
TYPE Stack;  (* opaque *)
PROCEDURE Create() : Stack;
PROCEDURE Push(s : Stack; v : INTEGER);
PROCEDURE Pop(s : Stack) : INTEGER;
END Stack.

IMPLEMENTATION MODULE Stack;
TYPE Stack = POINTER TO StackRec;
TYPE StackRec = RECORD ... END;
PROCEDURE Create() : Stack;
BEGIN
  ...
END Create;
END Stack.
```

The definition file declares an opaque type `Stack` with no visible representation; the implementation supplies the representation. This is the **direct ancestor of OCaml's `.mli`/`.ml` split** (§5.1) and conceptually identical to ML signatures + structures (§5.2), except that Modula-2 made it *the* module mechanism (no anonymous structures, no functors, no first-class modules).

**Modula-3** extended this with **opaque type matching across module boundaries**, generic interfaces and modules (`INTERFACE List(T) ... END;` instantiated as `MODULE IntList = List(INTEGER) ...`), and the most rigorous formal module semantics of any production language at that time. The Modula-3 type system was the substrate for several formal module-calculus papers in the 1990s (Cardelli, Leroy, Harper-Lillibridge), making it the bridge between Wirth-style production modules and the ML/SML formal calculi covered in §9.1.

**Oberon** simplified Modula-2 dramatically by replacing the separate definition file with **inline export markers**: a single asterisk after a declared identifier marks it as exported.

```oberon
MODULE Stack;
  TYPE Stack* = POINTER TO StackRec;  (* exported *)
  TYPE StackRec = RECORD ... END;     (* not exported — implementation detail *)
  PROCEDURE Create*() : Stack; ...    (* exported *)
END Stack.
```

This is the design Nim later adopted (§8.5). Oberon also introduced **`*` for read-only export** and **`-` for read-write export of variables** — finer-grained than Nim's single-marker scheme. The lesson: per-declaration export markers eliminate the need for separate interface files but require every public name to carry the syntactic noise.

Across the three: Wirth's lineage shows that **opacity, hierarchy, and selective export are independent design dimensions** that can be combined or separated. Modern languages cherry-pick — Rust took selective export (`pub`), OCaml took the spec/body split (`.mli`/`.ml`), Nim took inline export markers — but rarely combine all three.

Sources: https://www.modula2.org/reference/ and https://www.cs.purdue.edu/homes/hosking/m3/reference/syntax.html and http://www.projectoberon.com/ and https://en.wikipedia.org/wiki/Oberon_(programming_language)

### 5.7. Design Lessons from the Typed and Phase-Aware Family

OCaml, Standard ML, Haskell, Racket, Ada, and the Modula-2/3/Oberon lineage are grouped together because they all show module systems doing more than:
- grouping declarations,
- controlling visibility,
- and forming dependency graphs.

They do so in three distinct directions.

The **ML / OCaml direction** makes modules into *typed abstraction layers*. Signatures, functors, and explicit interfaces let the module system express architecture and invariants at a semantic level above ordinary values and types.

The **Racket direction** makes modules into *phase-aware metaprogramming boundaries*. Imports are not only "who can see this name?" but "at what phase does this binding exist, and what language-expansion work does requiring it perform?"

The **Ada / Modula-2 direction** establishes the *specification/body split as a foundational design point* — the public interface lives in one file or block, the implementation in another, and the two are compiled separately with opaque types matched across the boundary. This is the design that became OCaml's `.mli`/`.ml` and ML's signatures + structures; Ada and Modula were where it was first proven in production languages.

Haskell sits between these poles: more disciplined and declaration-oriented than file-only systems, but less ambitious than full ML-style module calculi or Racket's phase tower.

Specific lessons added by the Ada and Wirth-lineage entries:

- **Specification/body split as a language-level construct** (Ada packages, Modula-2 DEFINITION/IMPLEMENTATION, OCaml `.mli`/`.ml`): separating the public interface file from the implementation file enforces interface-first design, enables independent compilation, and predates ML signatures. The split can be inline (Oberon `*`, Nim `*`) or out-of-line (Ada, Modula-2, OCaml); both are viable.
- **Private parts in specifications** (Ada): a spec can declare a type as opaque to clients while exposing the representation to the body — type abstraction baked into the language without separate signature/structure machinery.
- **Hierarchical packages with privileged child visibility** (Ada child packages): children of a package can see the parent's internals; private children stay invisible to external clients. Predates Rust's `pub(crate)`/`pub(super)` lattice by decades.
- **Generic packages as ML-functor precursors** (Ada generics): parameterized modules taking types/values/packages as parameters, instantiated explicitly. Predates ML functors as a production feature.
- **Independent design dimensions** (Wirth lineage): opacity, hierarchy, and selective export can be combined or separated. Modern languages cherry-pick — Rust took selective export, OCaml took the spec/body split, Nim took inline export markers — but rarely combine all three.

This family suggests three concrete design possibilities:

- **Stay simple**: use modules only for naming, visibility, and dependencies.
- **Adopt stronger interfaces**: perhaps explicit export surfaces or interface declarations (or an Ada-style spec/body split), without going full functor calculus.
- **Plan for future phases**: if macros or compile-time metaprogramming are likely, keep the module system simple now but avoid design choices that would make phase-aware imports impossible later.

The key design lesson is that module systems can become one of the most powerful semantic layers in a language — but only at real cost. That cost should be adopted only if the language clearly wants the power.

## 6. JVM and .NET Module Systems

The JVM and CLR worlds occupy a distinctive position in this survey: they began with namespace-style modularity in the 1990s and only retrofitted true module systems decades later. Both runtimes survived for years on the strength of *binary artifact + classpath/assembly load*, with packages or namespaces serving as namespace organizers but not as enforceable visibility boundaries between published artifacts. This chapter covers what the late module retrofits actually look like, why they took so long, and what their cost-benefit profile teaches a language designer who is choosing between "namespaces only" and "real module systems" early.

### 6.1. Java — Packages, Access Levels, and the Long Road to JPMS

A Java **package** is a flat namespace declared at the top of each file (`package com.example.foo;`). Until JPMS, packages were the only language-level modularity feature in Java: they grouped types, served as the boundary for the package-private (default) access level, and shaped the conventional directory layout of source trees. Crucially, packages never owned a published artifact identity. A JAR could contain types from any number of packages; multiple JARs could split-package contributors to the same package; and the runtime classpath was a flat search path with last-loader-wins resolution semantics.

This produced a long-running set of pathologies: classpath hell (multiple incompatible JARs claiming the same fully qualified class name), accidental access via `sun.misc.Unsafe` and other internal types whose package-private status did not survive cross-JAR loading, no language-level expression of "this JAR depends on that JAR," and no enforced strong encapsulation between platform internals and applications.

**JPMS (Java Platform Module System)**, shipped in Java 9 (2017) as Project Jigsaw, layered an explicit module system *above* packages without retiring them. A module is declared by a `module-info.java` file at the root of a module artifact:

```
module com.example.foo {
    requires com.example.bar;
    requires transitive java.sql;
    exports com.example.foo.api;
    exports com.example.foo.spi to com.example.consumer;
    opens com.example.foo.internal to com.example.reflective.framework;
    uses com.example.foo.spi.Plugin;
    provides com.example.foo.spi.Plugin with com.example.foo.impl.PluginImpl;
}
```

The key elements:

- `requires` — directed module dependency edges, optionally `transitive` (re-exposed to consumers).
- `exports` — which packages are exported, optionally qualified `to` specific consumer modules (a friend mechanism).
- `opens` — like `exports` but additionally permits deep reflective access; needed because frameworks like Spring and Hibernate routinely break encapsulation through reflection.
- `uses`/`provides` — declarative `ServiceLoader` participation, encoded in module metadata so the runtime can resolve services without classpath scanning.

JPMS modules form an explicit dependency DAG validated at compile time, link time (`jlink`), and run time. A reads-graph is constructed at startup; reflective access into packages that are not `opens` raises `IllegalAccessError`. The platform itself (`java.base`, `java.sql`, `java.xml`, etc.) became modular, allowing custom runtime images via `jlink` that strip unused modules — useful for container images and embedded deployments.

The cost was severe ecosystem disruption. JPMS adoption took years: Maven Central had to learn `Automatic-Module-Name` manifest entries for legacy JARs, build tools needed module-path support alongside the classpath, and many frameworks needed to add `opens` directives or migrate away from deep reflection. Status (as of 2026-04): large parts of the Java ecosystem still run on the classpath rather than the module path, treating JPMS as opt-in rather than the default.

The design lesson is two-edged. JPMS proved that retrofitting a module system onto a 25-year-old runtime is *possible* and can deliver real benefits: strong encapsulation of platform internals (closing access to `sun.misc.Unsafe`-style backdoors), reliable reflection boundaries, custom runtime images, and explicit dependency graphs. But it also proved how expensive the retrofit is: every existing artifact had to either declare a module, accept being treated as an "automatic module" with weaker guarantees, or stay on the classpath. Committing to a real module system from version 1 is dramatically better than discovering twenty years later that namespaces alone do not suffice.

Sources: https://openjdk.org/projects/jigsaw/spec/ and https://openjdk.org/jeps/261 and https://www.oracle.com/corporate/features/understanding-java-9-modules.html and https://dev.java/learn/modules/

### 6.2. C# / .NET — Namespaces, Assemblies, and `InternalsVisibleTo`

The CLR analogue of Java's split is **namespaces** plus **assemblies**. Namespaces (`namespace Foo.Bar { ... }` or, since C# 10, file-scoped `namespace Foo.Bar;`) are pure naming hierarchies — they do not correspond to artifacts and are not visibility boundaries beyond the conventional `internal` access level. Assemblies are the actual unit of distribution, deployment, and visibility enforcement: typically a `.dll` or `.exe` containing compiled IL, metadata, and a strong-name or version identity. The mapping between namespaces and assemblies is many-to-many. One assembly can contribute types to many namespaces; one namespace can be assembled from types in many assemblies.

The visibility levels are richer than Java's. C# offers `public`, `internal` (visible only within the assembly), `protected`, `private`, `protected internal` (the union: same assembly OR derived class in any assembly), and `private protected` (the intersection: derived class within the same assembly). The assembly is therefore the meaningful encapsulation boundary, with the namespace serving primarily as a naming concern.

Two CLR-specific mechanisms shape how this plays out in practice:

- **`[InternalsVisibleTo("OtherAssembly")]`** — a friend assembly attribute that grants `internal` access to a specifically named consumer. This is the canonical way to expose internals to a sibling test assembly without making them public to the world. The named consumer can optionally include a public-key token, restricting friend access to strong-named callers.
- **Strong naming and the GAC (Global Assembly Cache)** — a legacy mechanism for binding assembly identity to a cryptographic public key plus version, enabling side-by-side deployment of multiple versions. The .NET Core / .NET 5+ ecosystem has largely moved away from the GAC toward NuGet packages and per-application directories, but strong naming remains a versioning primitive in places.

.NET also supports **assembly-level visibility shaping** via `[assembly: TypeForwardedTo(typeof(Foo))]`, which lets one assembly redirect a type reference to another. This is how the platform splits `mscorlib.dll` into `System.Runtime.dll` and friends across .NET versions without breaking compiled binaries — the type identity migrates while consumer references continue to compile.

Compared with JPMS, .NET's modularity is structurally similar (assembly ≈ module artifact, `internal` ≈ package-private) but architecturally far less ambitious. There is no language-level dependency declaration like `requires`; assembly references live in the project file (`.csproj`) and the package manager (NuGet). There is no notion analogous to qualified `exports ... to` beyond `InternalsVisibleTo`. There is no language-enforced reads-graph. The trade-off is that .NET avoided JPMS-scale ecosystem disruption, at the price of leaving the assembly-as-module abstraction quieter and more convention-shaped.

The design lesson is that CLR-style "the binary artifact is the encapsulation boundary, the source-level namespace is just naming" is workable for decades if the language never tries to enforce more. But it leaves visibility weaker than ML or Rust, leans heavily on tooling (NuGet, MSBuild) for dependency management, and provides no built-in mechanism for the platform to evolve its internal type layout safely without `TypeForwardedTo`-style retrofits.

Sources: https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/namespaces/ and https://learn.microsoft.com/en-us/dotnet/standard/assembly/ and https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.internalsvisibletoattribute and https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/internal

### 6.3. Scala — Packages, Top-Level Declarations, and Implicit Imports

Scala layers package syntax on top of the JVM's package model with several additions worth naming. Source files declare `package foo.bar`, and any number of files in different directories may contribute to the same package. Scala also supports **package objects** (Scala 2) and, in Scala 3, **top-level definitions**, which let `def`, `val`, `type`, `given`, and `extension` appear directly inside a package without wrapping them in an enclosing object. This eliminates the Java pattern of "everything must live inside a class" and gives packages the role of being containers of definitions, not just types.

Scala's import system is more elaborate than Java's. Imports can rename (`import foo.{Bar => Baz}`), exclude (`import foo.{Bar => _, _}`), pick selective subsets, and — in Scala 3 — explicitly bring `given` instances into scope (`import foo.given`) separately from ordinary identifiers. This makes implicit / `given` resolution part of the import system rather than ambient, which significantly improves predictability. Scala 3 also exposes `export` clauses, which re-export selected members of a delegated value as members of the enclosing definition — a first-class re-export mechanism that goes beyond what Java packages provide.

Compilation-unit ordering matters less in Scala than in F# (covered later) but more than in Java: implicit / `given` instances are resolved by a search procedure that depends on which definitions are in scope, and the import policy determines what is in scope at any given site. This is why Scala 3 made the `given` import explicit — it gives the compiler and the reader a single answer to "what implicits is this method site seeing?"

At the artifact level, Scala compiles to JVM `.class` files and inherits JPMS / classpath behavior unchanged. Scala does not declare `module-info.java`-style metadata, and ScalaJS / Scala Native have their own artifact and packaging stories that mostly bypass JPMS. The Scala-specific module-system contribution is therefore at the *source level* — richer imports, top-level definitions, `given` import scoping, and `export` clauses — not at the artifact level.

Sources: https://docs.scala-lang.org/scala3/reference/changed-features/imports.html and https://docs.scala-lang.org/scala3/reference/other-new-features/export.html and https://docs.scala-lang.org/scala3/book/packaging-imports.html

### 6.4. Kotlin — Packages, `internal` Visibility, and Multiplatform Modules

Kotlin's surface module story looks Java-like — files declare `package foo.bar`, types are organized into hierarchical namespaces, and JVM compilation produces standard `.class` files. The interesting differences are the visibility lattice and the multi-platform module abstraction.

Kotlin's visibility levels are `public` (default), `private` (file-scoped at top level, class-scoped within a class), `protected`, and **`internal`** — visible only within the same Kotlin **module**. A Kotlin module is a build-tool concept (a Gradle subproject, a Maven module, an IntelliJ module, an Ant target) rather than a language-level construct. The visibility level binds to the build-tool boundary, but there is no `module-info.kt` declaring it. The absence of a language-level module declaration is intentional: Kotlin treats "module" as a build-tool primitive, the way Go treats "package" as a directory primitive.

This is a useful design point. Kotlin gets `internal`-visibility encapsulation that respects build boundaries without inventing JPMS-style language syntax. The cost is that the boundary is implicit — you have to know the build configuration to know what counts as the same module. Tooling (IDE, kotlinc) handles the bookkeeping.

**Kotlin Multiplatform** (formerly KMM) introduces a more elaborate module concept: a multiplatform module declares `commonMain` source plus per-target source sets (`jvmMain`, `iosMain`, `jsMain`, etc.). The module produces multiple artifacts simultaneously, with `expect`/`actual` declarations bridging platform-specific implementations. Here "module" means closer to "library that compiles to several platforms with shared and platform-specific code partitioned by source set." This is a build-tool-and-language hybrid: the language has `expect`/`actual`, the build tool decides which source sets contribute to which target.

Sources: https://kotlinlang.org/docs/visibility-modifiers.html and https://kotlinlang.org/docs/packages.html and https://kotlinlang.org/docs/multiplatform.html

### 6.5. Design Lessons from JVM/CLR Module Layering

The JVM and CLR ecosystems together demonstrate three durable patterns worth carrying forward to any module-system design.

First, **namespace-only modularity is insufficient at scale, and retrofitting a module system is expensive** (canonical retrofit story at §6.1). Bake real module boundaries in from the first release, even if simple.

Second, **the binary artifact is a strong candidate for the encapsulation boundary**. Both ecosystems converged on "the published artifact (JAR / DLL / module) is what `internal` privacy respects," sidestepping source-level enforcement when the same source compiles into many artifact configurations. The corollary: a friend mechanism (`InternalsVisibleTo`, `exports ... to`) is needed almost immediately, because test code lives in a sibling artifact.

Third, **reflection and metaprogramming break encapsulation unless the module system explicitly accommodates them**. JPMS's `opens` directive exists because Spring, Hibernate, and Jackson cannot work without deep reflective access; .NET's analogues are looser but present. A module system from scratch should decide early whether reflection is permitted, restricted, or first-class — and if first-class, what mechanism (the equivalent of `opens`) explicitly authorizes it.

Fourth, **language-level modules and build-tool modules (§6.4)** can be the same or different things, but the relationship must be stated. Kotlin is honest about it: the build tool defines the module. JPMS pretends the language defines the module while Maven and Gradle still own dependency resolution. Making the relationship explicit is one of the cleaner design choices in this space.

---

## 7. Headers, Translation Units, and C++20 Modules

C and C++ occupy a unique slot in this survey: for forty years, they had no language-level module system at all. Modularity was achieved through the **textual-include + separate-compilation + linker** triad, with the preprocessor's `#include` directive treating header files as macro-expanded source insertions. C++20 finally introduced named modules as a first-class language feature, but adoption is still in progress, and the migration story is itself instructive about what a module system has to do to displace a deeply entrenched alternative.

### 7.1. C and C++ Translation Units, `#include`, and Header Files

A C or C++ **translation unit** is the unit of compilation: a single `.c` / `.cpp` source file plus everything textually included by it after preprocessing. The preprocessor processes `#include` directives by literally inserting the named header file's text at the include site, then the compiler parses the expanded result. There is no semantic notion of "the header" after preprocessing; the contents simply become part of the translation unit.

This model has remarkable strengths and weaknesses both rooted in its simplicity. Strengths: any text editor can produce a working compilation unit; the language has no module-resolution machinery to specify; cross-translation-unit references are entirely the linker's job (resolving `extern` symbol references against object files and libraries); and the same header can be consumed by C, C++, and assembly with appropriate guards. Weaknesses: every translation unit re-parses every transitively included header (the famous `<windows.h>` and `<iostream>` blowup, where a one-line `hello.cpp` expands to hundreds of thousands of tokens); macros leak across header boundaries unless carefully scoped; declaration order in a header determines what subsequent code sees, making header authoring a careful art; and there is no enforced visibility boundary — anything declared in a header is visible to everyone who includes it.

The defenses against these weaknesses are conventions and tooling, not language features:

- **Header guards** (`#ifndef FOO_H`, `#define FOO_H`, `#endif`) prevent multiple-inclusion within a single translation unit.
- **Forward declarations** instead of `#include`s where possible, to reduce transitive header pull-in (the Pimpl idiom is one extreme expression).
- **Precompiled headers (PCH)** cache the parsed token stream of a fixed set of headers. GCC, Clang, and MSVC all support PCH; they reduce compile times substantially but add fragility — the PCH must be rebuilt when any input changes, and the same PCH must be used in compatible configurations across a project.
- **Include-what-you-use** static analysis tools (Google's `iwyu`, Clang's `-Wmissing-includes`) help police accidental transitive dependencies.

The semantic consequence is that **C and C++ translation units have no module identity at all**. The unit of distribution is the library (`.a`, `.so`, `.lib`, `.dll`), the unit of source organization is the header / source file pair, and the bridge between them is the symbol table managed by the linker. There is no "what does this header export?" beyond what its declarations and macros happen to define. There is no "what does this header depend on?" beyond what `#include` directives appear in it. The module graph is implicit in the include graph and emerges only after preprocessing.

This is why C and C++ build systems (Make, CMake, Bazel, Buck, Meson, Ninja) are so much more complex than build systems for languages with explicit modules: they must compute the include graph by re-running the preprocessor, track header timestamps for incremental rebuilds, and manage compilation-unit-level options (`-D`, `-I`, `-W`) that are not visible in the source.

Sources: https://en.cppreference.com/w/cpp/preprocessor/include and https://gcc.gnu.org/onlinedocs/cpp/ and https://github.com/include-what-you-use/include-what-you-use

### 7.2. C++20 Modules — Named Modules, Module Interface Units, and BMI Caching

C++20 introduced **named modules** as a first-class alternative to header inclusion. The syntax is deliberately small:

```cpp
// foo.cppm — module interface unit
export module foo;
export int answer() { return 42; }
int helper() { return 0; }  // not exported — internal linkage to the module

// main.cpp
import foo;
int main() { return answer(); }
```

A **module interface unit** declares the module name and which entities are exported. A **module implementation unit** (declared `module foo;` without `export`) contributes additional definitions to the same module without exposing them. **Module partitions** (`export module foo:bar;`) let large modules be split across multiple files while presenting one external interface.

The compiler produces a **Built Module Interface (BMI)** — a binary serialization of the module interface that subsequent `import` statements can load directly, bypassing tokenization and parsing. BMIs are toolchain-specific (GCC's `.gcm`, Clang's `.pcm`, MSVC's `.ifc`), not portable across compilers or even compiler versions. This is intentional: the BMI is a compiler implementation detail, not a distribution format. Distribution still happens at the source level, with consumers building their own BMIs.

The performance and engineering benefits over `#include` are substantial:

- **Parse once per module**, not once per translation unit that includes the module. On large codebases this can be a 5–10x compile-time improvement, larger on aggressive header-only template-heavy code.
- **Macros do not leak** across module boundaries. `#define` inside a module is invisible to importers unless the module explicitly exports it (which most do not).
- **Declaration order is internal** to the module. An importer sees the module's exported entities as a flat set, not as a sequence whose visibility depends on where in the file they appear.
- **`import std;`** (C++23) provides a single named-module replacement for the entire standard library, replacing dozens of `#include <...>` lines.

The migration story is the hard part. C++20 also defines **header units** (`import "foo.h";`), which let an existing header be imported as if it were a module, getting most of the parse-once benefit without rewriting the header. Header units are a transitional bridge: they let a project move incrementally from `#include` to `import` without big-bang rewrites. But header units also inherit some of the header model's weaknesses — they can leak macros (with restrictions) and they require the toolchain to determine what to do at the import-vs-include boundary.

Tooling support has been the gating factor. GCC 14+, Clang 17+, and MSVC have varying levels of named-module support; build systems (CMake, Bazel) added module dependency scanning relatively late; cppcheck, clangd, and other analyzers needed specific module support. Status (as of 2026-04): named modules are usable but not yet ubiquitous; the standard library import (`import std;`) is the most common entry point because it requires only consumer-side adoption.

The lessons are direct. First, **a module system can be retrofitted onto a 40-year-old textual language, but the migration takes a decade plus**. C++20 modules are real and good; they will not displace `#include` ecosystem-wide for many more years. Second, **the BMI is a per-compiler caching artifact, not a distribution format**. Trying to standardize a portable binary module format was attempted (C++ Modules TS) and the committee converged on "don't standardize it" — every compiler caches differently, and that's fine because source distribution is the contract. Third, **macros and the preprocessor remain the dirtiest corner of the migration**. A language designer wanting module-style benefits should avoid a textual macro layer entirely, or confine it (as Rust and C++20 modules do) so macro effects do not cross module boundaries.

Sources: https://en.cppreference.com/w/cpp/language/modules and https://isocpp.org/files/papers/P1103R3.pdf and https://learn.microsoft.com/en-us/cpp/cpp/modules-cpp and https://gcc.gnu.org/wiki/cxx-modules and https://clang.llvm.org/docs/StandardCPlusPlusModules.html

### 7.3. Design Lessons from the Header-to-Module Migration

C++20 modules are the most expensive module-system retrofit in software history (alongside JPMS — the canonical retrofit story is at §6.1), and the design choices the committee made are worth studying.

**Module identity is decoupled from filenames.** A module named `foo` lives in whatever file declares `export module foo;`. The build system maps module names to their interface units, but the source language treats the module name as authoritative. This is the opposite of Go, which makes the directory path part of the package import path. The C++20 design preserves the historical C++ freedom to organize files however the project wants, at the cost of requiring a module-name-to-file mapping somewhere (typically the build system).

**The preprocessor is contained but not eliminated.** Inside a module, `#define` and `#include` still work, but their effects do not escape the module boundary unless explicitly exported. This is a pragmatic compromise: existing C++ code uses macros pervasively, and a module system that banned them outright would have been a non-starter. The compromise is to localize macro effects rather than remove them.

**Source distribution remains the contract.** Despite the BMI, no portable binary module format exists. This avoids the ABI-stability nightmare that would have dominated standardization, but it also means every consumer compiles every dependency from source. A language designer should consciously decide whether to follow this model (Rust does) or ship binary artifacts as distribution units (Go effectively does via build caches; .NET and JVM do explicitly).

**Tooling lag is the rate-limiting factor.** Even with the language feature standardized, ecosystem adoption depends on build systems, IDEs, package managers, and analyzers. C++20 modules were specified in 2020 but were not practically usable until ~2024. Shipping modules from version 1 sidesteps this, but the ecosystem won't materialize until the tools exist.

The deepest lesson is conservative: **a language without modules at the start will accumulate a textual-include-style alternative whose inertia eventually exceeds the benefit of the formal module system**. The right time to introduce modules is before there is anything to migrate.

---

## 8. Modules in Additional Production Languages

Beyond the core systems-language and scripting-language references, several production languages have made distinctive module-system choices worth recording. The entries below are individually shorter than chapters 3–7 but collectively map a wider portion of the design space, especially around the relationship between source files, compilation order, distribution, and resilient ABI evolution.

### 8.1. Swift — Modules as Frameworks and Library Evolution

Swift's module unit is the **module**, which corresponds operationally to a Swift framework, a static library, an Xcode target, or a Swift Package Manager (SPM) target. Imports are a single keyword: `import Foundation`, `import MyAppKit`. Within a module, all source files share a flat namespace; types can reference each other without import declarations. Across modules, imports are the only way to reference declarations.

Swift's visibility lattice is deeper than Java's or Kotlin's: `open` (public + subclassable across modules), `public` (visible across modules, not subclassable across modules without `open`), `package` (visible within the same Swift package — added in Swift 5.9, 2023), `internal` (default; visible within the module), `fileprivate` (visible within the source file), `private` (visible within the enclosing declaration). Status (as of 2026-04): `package` is the most recent significant addition; previously, Swift had no way to share types between sibling modules in a multi-module package without making them `public`, polluting the published API surface.

The most distinctive Swift contribution is **Library Evolution Mode**, the resilient-ABI compilation mode that lets a binary module evolve its internal layout without breaking already-compiled clients. With Library Evolution enabled, Swift emits per-module `.swiftinterface` text files (a stable serialized form of the module's public API) plus binary `.swiftmodule` files. Consumers compile against the interface, and the runtime resolves layouts dynamically. This is what allows Apple to ship a new iOS SDK and have apps built against an older SDK continue to run — the equivalent of .NET's `TypeForwardedTo` plus C++ ABI conventions, baked into the compiler at module granularity.

Swift Package Manager (SPM) added the package-level distribution layer, with `Package.swift` describing dependencies, products, and target structure. SPM packages can declare both library products (consumed as modules) and executable products. Cross-module visibility within a package is the `package` access level; cross-package visibility requires `public`.

Sources: https://docs.swift.org/swift-book/documentation/the-swift-programming-language/accesscontrol and https://github.com/swiftlang/swift-evolution/blob/main/proposals/0386-package-access-modifier.md and https://github.com/swiftlang/swift/blob/main/docs/LibraryEvolution.rst and https://www.swift.org/documentation/package-manager/

### 8.2. Erlang and Elixir — Applications, OTP, and Code Loading

Erlang has the simplest possible module surface — `-module(foo).` declares a module, `-export([func/1, other/2]).` declares its public functions, and `foo:func(arg)` calls a function in another module. Module names are flat (no hierarchy), and a module corresponds to a single `.erl` source file producing a single `.beam` BEAM file. The flatness reflects Erlang's age (1986) and is the canonical example of a flat-namespace ecosystem that scales reasonably through naming conventions (`my_lib_socket`, `cowboy_http`) rather than through hierarchical paths.

Above modules, Erlang/OTP layers **applications**, which are not modules in the namespace sense but are the unit of *runtime configuration and supervision*. An OTP application is described by a `.app` file listing its modules, registered names, started supervisor, environment configuration, and dependencies on other applications. The runtime treats applications as the lifecycle unit: start, stop, take down with their supervisors. This gives Erlang two distinct levels — the module (compilation and namespace unit) and the application (deployment and runtime unit) — without trying to fuse them.

The runtime story is unusual: Erlang supports **hot module reload**, where a running system can load a new version of a module while existing processes continue executing the old version. The VM keeps two versions of each module active simultaneously; existing local calls (`func()` within the module) continue on the old version, while fully-qualified calls (`my_module:func()`) always dispatch to the current version. This is the canonical mechanism for telecom-style 99.999% uptime systems and is covered in `COMPILERS.md §23.1` from the runtime angle. The module system enables this directly: because modules are flat, named, individually loadable artifacts with explicit export lists, the runtime can swap their implementations without invalidating the global namespace.

**Elixir** sits on top of the Erlang VM and reuses the same module mechanics with a more hierarchical naming convention (`MyApp.Accounts.User`) and the `defmodule ... do ... end` syntax. The dot-separated module name is a convention layered on top of the flat BEAM module namespace — `MyApp.Accounts.User` compiles to a BEAM module named `Elixir.MyApp.Accounts.User`. Elixir's `import`, `alias`, `require`, and `use` keywords cover different access patterns: `alias` for shorter names, `import` for unqualified function access, `require` for compile-time macro availability, `use` for invoking a module's `__using__/1` macro at compile time. **Mix** is Elixir's build tool, which adds package and dependency management (with **Hex** as the registry) above the application layer.

**Gleam** (Louis Pilfold, 2016+; v1.0 March 2024) is the third major BEAM language and the first with **Hindley-Milner type inference** as the primary discipline. Modules use the same `.gleam` file = one module convention with hierarchical names mirroring directory paths (`gleam/io.gleam` → `gleam/io`); imports are declarative `import gleam/list` with optional `as` renames and selective `.{map, filter}` unqualified-import; privacy is per-declaration (`pub fn` exports, no marker = module-local). The compiler targets *both* Erlang BEAM and JavaScript, sharing the same module declaration syntax across both backends — distinct from Elixir, which is BEAM-only. The package manager (`gleam` CLI plus Hex registry) integrates with the Mix/Hex ecosystem so Gleam modules can be published alongside Erlang/Elixir packages and consumed from any BEAM language. The lesson: a typed, ML-flavoured layer on a flat-named-runtime substrate (BEAM) is feasible without redesigning the runtime; the module system is unchanged from Erlang's, but the type system makes the ML-style `import .{..}` discipline feel natural rather than retrofitted. Source: https://gleam.run/

Sources: https://www.erlang.org/doc/system/code_loading.html and https://www.erlang.org/doc/design_principles/applications.html and https://hexdocs.pm/elixir/Kernel.html#defmodule/2 and https://hexdocs.pm/mix/Mix.html and https://gleam.run/

### 8.3. Julia — Module Objects, `using`/`import`, and Precompilation

Julia's module system is closer to Python's than to Rust's, but with stronger compile-time integration and aggressive precompilation. A module is declared with `module Foo ... end`, can be nested inside another module, and can `include("file.jl")` to splice in source files (textual inclusion, not module composition). The top-level module of a package is called `Main` for scripts and is the package's namespace for installed packages.

Julia distinguishes `using` and `import`:

- `using Foo` — imports the module's `export`-listed names into the current scope, plus the module name itself.
- `import Foo` — imports only the module name, requiring qualified access (`Foo.bar`).
- `import Foo: bar, baz` — imports specific names, allowing them to be extended (overloaded) in the current module.

The `export` directive lists the names brought into scope by `using`. Names not exported are still accessible via qualified syntax (`Foo.unexported`); Julia has no language-level enforcement of privacy beyond convention (an underscore prefix or just leaving the name unexported).

The interesting performance contribution is **precompilation**. Each Julia package is compiled to a `.ji` cache file the first time it is loaded, and subsequent loads use the cache. Since Julia 1.9 (2023), packages also produce **native code caches** (`pkgimage`), which embed JIT-compiled native code for type-stable methods so that downstream packages do not pay the JIT cost on first use. This makes loading large package graphs (e.g., a Plots.jl pipeline) substantially faster, addressing the long-standing "time to first plot" complaint.

Julia's package manager (`Pkg`) maintains environments: `Project.toml` lists dependencies, `Manifest.toml` records the resolved versions (a lockfile). Environments are stackable, so one can have a base environment plus a per-project environment; the resolution is deterministic.

The module-system-relevant lesson from Julia is that **`include`-style textual splicing can coexist with module declarations** if precompilation handles the resulting cost. Julia conventionally puts each module's contents into one file but uses `include` to assemble large modules from many files, treating files as a project-organization unit and modules as the namespace unit.

Sources: https://docs.julialang.org/en/v1/manual/modules/ and https://docs.julialang.org/en/v1/manual/code-loading/ and https://julialang.org/blog/2023/04/julia-1.9-highlights/

### 8.4. Dart — Libraries, Parts, and Underscore Privacy

Dart's module unit is the **library**, which can be a single file (the default) or a multi-file library coordinated by a `library` directive plus `part` and `part of` directives. A library is the privacy boundary: identifiers beginning with an underscore (`_foo`) are private to the library, not just to the file. This is structurally similar to Go's capitalization convention but inverted (underscore for private rather than capitalization for public).

Imports use URI specifiers: `import 'dart:io';` for SDK libraries, `import 'package:foo/foo.dart';` for pub packages, `import 'src/helpers.dart';` for relative paths. The `package:` scheme is resolved by the pub package manager via `pubspec.yaml` and a `.dart_tool/package_config.json` file generated at `pub get` time.

Dart supports `show` and `hide` clauses on imports (`import 'foo.dart' show Bar, Baz;` or `import 'foo.dart' hide Internal;`), an `as` clause for prefixing (`import 'foo.dart' as f;`), and an `export` directive for republishing. The `deferred as` form supports lazy loading on web and AOT-compiled mobile, so a library's code is only loaded when it is first referenced — relevant for code-splitting large applications.

The `part`/`part of` system is unusual. A `part` file is *not* its own library; it is a syntactic continuation of the parent library, sharing the parent's privacy and import scope. This is similar to C++ separate compilation units that share a translation context, but expressed at the source level. The part is mostly used for code generation: a build_runner-generated `*.g.dart` file is typically a `part of` the consuming library, letting it access private members for serialization, ORM, or freezing.

Sources: https://dart.dev/language/libraries and https://dart.dev/tools/pub/dependencies and https://dart.dev/language/built-in-types#part-and-part-of

### 8.5. Nim — File-as-Module with `*` Export Marker

Nim's module surface is among the simplest in the survey. Every `.nim` file is automatically a module; there is no module declaration syntax. Imports use `import foo`, qualified imports use `from foo import bar`, and selective imports use `from foo import bar, baz`. The module is identified by its filename (without extension), and imports are resolved through the package path or relative paths.

The export mechanism is uniquely terse: a single asterisk (`*`) after a declared identifier marks it as exported. `proc foo*(x: int): int = ...` exports `foo`; `proc bar(x: int): int = ...` keeps `bar` private. This makes the export decision visible at the declaration site without a separate export list, and at the cost of one character of syntactic noise. Nim also supports `include "file.nim"` for textual inclusion (sharing scope with the includer), `from foo import nil` to import a module without bringing names into scope, and `export foo` to re-export an imported module's public names.

Nim's package manager is **Nimble**, which uses `.nimble` files for package metadata. Packages can declare dependencies on other Nimble packages and are resolved by Nimble's solver against the published index.

The design lesson is that **a tiny per-declaration export marker can replace export lists entirely** if the language is willing to make the marker mandatory at every public declaration. The trade-off is a small visual noise floor on every public symbol; the benefit is that the export decision is locally visible and reviewable.

Sources: https://nim-lang.org/docs/manual.html#modules and https://nimble.directory/ and https://nim-lang.org/docs/manual.html#modules-export-marker

### 8.6. Elm — Strict Static Modules with No Cycles

Elm pushes the static-graph philosophy to an unusually strict extreme. Every Elm file declares its module name explicitly (`module Foo.Bar exposing (..)`), and the module name *must* match the file path. Imports are static (`import Foo.Bar exposing (baz)`), and the language **forbids cyclic imports outright** — if `Foo` imports `Bar` and `Bar` imports `Foo`, the compiler rejects the program. This is structurally similar to Go's package-cycle rule but enforced at the module-file level rather than the package level.

Modules use **exposing** lists to control visibility: `module Foo exposing (bar, Baz)` exposes only the named items; `module Foo exposing (..)` exposes everything (discouraged for libraries); `module Foo exposing (Baz(..))` exposes a type and all its constructors. The granularity matters because Elm's type system relies on exposed-or-hidden type constructors to enforce opaque types — a library can expose a type `Money` without exposing its `Money Int` constructor, forcing consumers to use the library's smart constructors.

Elm's package manager publishes to `package.elm-lang.org` and enforces **strict semantic versioning**: the publishing tool diffs the public API and rejects patch-version publishes that change the API surface. This is unusual — most ecosystems put SemVer compliance on the publisher's discretion. Elm makes it a tooling-level guarantee.

The module-system-relevant lesson is that **forbidding cycles at the file level, not just the package level**, is feasible if the language is willing to enforce it. Elm's pure-functional design helps (no mutable singletons that benefit from cycle tolerance), but the discipline transfers to other static-functional designs.

Sources: https://elm-lang.org/docs/style-guide and https://package.elm-lang.org/help/design-guidelines and https://elm-lang.org/docs/syntax#modules

### 8.7. F# — File Order Matters and Compilation Units

F# is the most distinctive entry in this chapter because **file order in the project file is part of the language's semantics**. F# compiles source files top-to-bottom in the order listed in the `.fsproj` file, and a declaration in file `B.fs` cannot reference a declaration in file `C.fs` if `C.fs` appears below `B.fs`. There is no forward declaration. Cycles between files are impossible because the compiler simply does not allow a later file's declarations to be visible to an earlier one.

This is the mirror image of every other module system in this survey: rather than letting the import graph emerge from declarations and then validating acyclicity, F# imposes a strict total order at the project level and lets imports respect it for free. The benefit is striking compile-time and reasoning simplicity — there is no possibility of complex dependency cycles, and the order is humanly visible in the project file. The cost is that refactoring (moving declarations between files) sometimes requires reordering the project, and large projects can have project files thousands of lines long.

F# also has `module Foo` and `namespace Foo` declarations. Modules are compilation-unit organizers (a file can be one module or several); namespaces are CLR-level namespaces inherited from .NET. The `[<AutoOpen>]` attribute on a module makes its contents implicitly imported when the enclosing namespace is referenced — a controlled mechanism for global-feeling helpers without polluting every consumer's import list.

The design lesson is that **strict file ordering eliminates entire classes of module-system complexity** at the price of project-file ergonomics. Most languages would never accept this trade-off, but for a language whose audience already accepts strict editor-driven workflows (F# users typically use Visual Studio or Rider, both of which display file order graphically), it works.

Sources: https://learn.microsoft.com/en-us/dotnet/fsharp/language-reference/modules and https://learn.microsoft.com/en-us/dotnet/fsharp/language-reference/namespaces and https://learn.microsoft.com/en-us/dotnet/fsharp/style-guide/component-design-guidelines

### 8.8. Crystal and Pony

Two smaller-scope mentions worth grouping; Zig's full coverage lives at §3.2 and `PACKAGING.md §3.5`.

**Crystal** uses `require "foo"` for textual inclusion-style imports, idempotent via a load-set. Modules are declared with `module Foo ... end` and form hierarchies (`Foo::Bar`). The combination is similar to Ruby's `require` plus Ruby's modules but with static type checking and AOT compilation. Shards is the package manager.

**Pony** has a strict per-package-directory model (one directory = one package, every `.pony` file in the directory is part of that package) plus capability-based reference types (`MEMORY.md §1.10`). The module system itself is straightforward; the distinctive work happens at the type-system level with reference capabilities as the unit of authority.

Sources: https://crystal-lang.org/reference/syntax_and_semantics/requiring_files.html and https://tutorial.ponylang.io/packages/

### 8.9. Raku — `auth`/`ver`/`api` Identity, Repository Chain, and the fez/zef Ecosystem

Status (as of 2026-04): the fez/zef ecosystem is the current Raku module ecosystem, replacing CPAN and the older p6c.

Raku has the most ambitious distribution-identity model in this survey: a distribution is identified by a four-tuple expressed inline in import statements — `Foo::Bar:ver<0.0.42>:auth<zef:lizmat>:api<2.0>:from<Perl5>`. The `auth` field names the publishing authority (typically `zef:user`); `ver` is the version; `api` marks API-compatibility level; `from` is an interop tag. This is the only mainstream system where consumers can require *exactly one* among multiple distributions sharing a name but differing in `auth` — `use HTTP::Tiny:auth<zef:alice>` and `use HTTP::Tiny:auth<zef:bob>` resolve to distinct artifacts. (Compare Perl 5's package-identity-as-name-only model at §4.5, which Raku reacts against.)

Three distinct keywords govern loading. `use` performs compile-time load + import. `need` performs compile-time load only, without importing names into the lexical scope. `require` performs runtime load + lexically-scoped import. The distinction between *loading* (making a compunit available) and *importing* (making symbols visible) is sharper than in any other production language.

The resolution mechanism is the **`$*REPO` chain**: a linked list of `CompUnit::Repository` objects (`core → vendor → site → home`), each implementing a `need` method that may resolve the request or delegate. `CompUnit::Repository::FileSystem` is the development-mode repo; `CompUnit::Repository::Installation` is the production repo (version-aware, auth-aware, content-addressed). Custom repos are ordinary Raku objects — more flexible than Python's `sys.path` finder/loader machinery. `META6.json` carries `provides`, `depends`, `auth`, `ver`, `api`; the `provides` map decouples filesystem layout from importable name (a distribution can put source in `lib/foo.pm` and provide `Foo::Bar`). The **fez/zef ecosystem** validates `auth` against the uploader's identity, rejects version `*` (poisoning attack), enforces one-upload-per-(dist, version), and serves a JSON master index — closing a class of supply-chain attacks viable on CPAN.

The design lesson: **if multiple distributions of the same name must coexist, identity has to be a tuple, not a string**. Raku makes the tuple visible in the import syntax itself, so a security-conscious importer can pin `auth` directly without external lockfiles. Full treatment of Raku's multi-dispatch and roles lives in `TYPES.md §6.6`; Raku's schedulers, promises, and `react`/`whenever` live in `CONCURRENCY.md §11.6`.

Sources: https://docs.raku.org/language/modules and https://docs.raku.org/language/distributions/configuration-structure and https://docs.raku.org/language/compilation and https://github.com/ugexe/zef and https://deathbyperl6.com/fez-zef-a-raku-ecosystem-and-auth/

### 8.10. Forth — Wordlists, the Search-Order Stack, and `DEFINITIONS`

Forth's module mechanism (the "Search-Order word set" of Forth-2012) is fundamentally unlike anything else in the survey: there is no `import` declaration, no module file format, no package manifest — just a stack of *wordlists* (named-word dictionaries) that the text interpreter searches in order. Primitives include `WORDLIST` (create), `SET-ORDER`/`GET-ORDER` (read/write the search order), `ALSO` (duplicate the top), `PREVIOUS` (pop), `ONLY` (reset), `FORTH` (push the standard wordlist), and `DEFINITIONS` (make the top of the search order also the compilation wordlist).

The model is imperative: programmers manipulate the search-order stack within source files. To define editor commands without polluting the main namespace, push an editor wordlist via `ALSO`, define words, then pop with `PREVIOUS`. Lookup searches each wordlist newest-first; the search-order stack shadows top-down. Gforth adds a `voc1:voc2:word` qualified-syntax overlay via its recognizer system. The Gforth manual is candid about the trade-off: "trying to modularize programs in this way has disadvantages for debugging and reuse/factoring." The recurring concern is that "what does this name resolve to right now?" depends on dynamic search-order state.

The lesson: **stack-of-tables is viable as a module primitive when source order and execution order are deliberately fused** (Forth's `:` definitions compile immediately into the top wordlist). It is poorly suited to languages with separate compilation, deferred linking, or static reasoning. Stack-effect type systems live in `TYPES.md §9.4`; Forth-family multitasking lives in `CONCURRENCY.md §7.5`.

Sources: https://forth-standard.org/standard/search and https://gforth.org/manual/Word-Lists.html and https://gforth.org/manual/Wordlists-and-Search-Order-Tutorial.html and https://www.complang.tuwien.ac.at/forth/gforth/Docs-html-history/0.6.2/Why-use-word-lists-.html

### 8.11. Factor — Vocabularies, `USING:`, and Ambiguous-Use Errors

Factor is the modern concatenative language that replaced Forth's wordlist-stack with a declarative module system. A *vocabulary* is the module unit (a directory of `.factor` files in a flat namespace identified by dotted names: `kernel`, `math.functions`, `io.files`). Imports are declarative: `USE: vocab` and `USING: v1 v2 v3 ;` add to the search path; `IN: my.app` sets the current vocabulary; `QUALIFIED:`, `FROM: ... =>`, `EXCLUDE: ... =>`, and `RENAME: ... =>` cover the R6RS-style refinement vocabulary.

The distinctive mechanism is the **ambiguous-use-error**: if a name resolves to multiple imported vocabularies, the parser raises an error rather than silently picking one. Users disambiguate via `vocabulary:word` qualified syntax — the inverse of Forth's "first-found wins" search-order semantics. Vocabularies live under root directories (`core`, `basis`, `extra`, `work`); loading is via `require` or `reload`.

The contrast with Forth (§8.10) is sharp: Forth wordlists are runtime data the programmer mutates with imperative stack operations; Factor vocabularies are declarative compile-time entities resolved by the parser. Factor's optimizing compiler (`COMPILERS.md §32`) operates over fully-resolved vocabulary references, enabling whole-program type inference and inlining that the Forth wordlist model would obstruct.

Sources: https://docs.factorcode.org/content/article-tour-vocabularies.html and https://docs.factorcode.org/content/article-vocabs.loader.html and https://docs.factorcode.org/content/article-vocabs.roots.html and https://docs.factorcode.org/content/word-USE__colon__%2Csyntax.html

### 8.12. D — `module foo.bar;`, Package Access, and `version()` Conditional Compilation

D's module system is production but niche — D never gained mainstream traction despite being roughly contemporary with Rust. The design choices are still worth recording because they sit at an interesting intermediate point between C++ and the modern static-graph systems.

A D source file declares its module identity with a `module foo.bar;` line at the top. The dotted name maps to filesystem path `foo/bar.d`, similar to Java but enforced at the language level rather than by convention. **`package.d` files** act as re-export hubs: a file at `foo/package.d` is imported as `foo` and typically re-exports submodules with `public import foo.bar; public import foo.baz;`. This is similar to Rust's `mod.rs` (now `mod-name.rs`) but more declarative.

Access modifiers are unusually rich for a C-syntax language:

- `private` — visible only within the same module.
- `package` — visible within the same package (directory tree). Can be parameterized: `package(my.lib)` restricts visibility to a specific package.
- `protected` — for class member access.
- `public` — visible everywhere.
- `export` — visible across shared library boundaries (relevant for `.dll`/`.so` symbol export).

The **`export` modifier** is unusual: it distinguishes "visible to other modules within this binary" (`public`) from "visible across binary linking boundaries" (`export`). This addresses a problem most languages punt on — ELF/PE export visibility — at the language level.

**`version(IDENT) { ... }`** and **`debug { ... }`** blocks provide conditional compilation gated on identifiers defined at compile time (via `-version=Foo` flags). This is C's `#ifdef` reframed as a language-level construct rather than a preprocessor pass — version blocks respect normal module scoping rules. **`static if`** is the more general compile-time conditional, comparable to Zig's `comptime if`.

**DUB** is D's package manager, with `dub.json` or `dub.sdl` manifests and the registry at code.dlang.org. DUB packages map one-to-one to D packages (directory trees), making the source/distribution alignment closer to Go than to Rust.

The lesson: **a richer access-modifier lattice (private/package/protected/public/export) addresses real visibility distinctions** — particularly the binary-export boundary that languages like Java and C# handle implicitly via reflection visibility and that C/C++ handle out-of-band via `__declspec(dllexport)` / visibility attributes. D made it a first-class language concern.

Sources: https://dlang.org/spec/module.html and https://dlang.org/spec/attribute.html#visibility_attributes and https://dlang.org/spec/version.html and https://dub.pm/

### 8.13. Lean 4 — `import`, `namespace`, `section`, `open`, `export`

Lean 4's module surface is conventional: `import Foo.Bar` loads another file-shaped module, `namespace Foo ... end Foo` opens a hierarchical naming scope, `section ... end` provides a non-namespace scope for `variable` declarations, `open Foo` brings unqualified access, and `export Foo (a b c)` re-exports specific names. Imports are transitive. Modules are file-shaped (`Foo/Bar.lean` ↔ `Foo.Bar`). Lean deliberately *did not* inherit Racket's phase tower (§5.4) despite a Racket-influenced macro elaborator (`PARSERS.md §2.22`).

The module-relevant design point is that **Lean modules participate in instance resolution**: an `instance : Add Nat where ...` declared in module `Foo` is only visible to clients that `import Foo`, so the import graph determines the visible instance set. Instance scoping is closer to Rust's coherence-by-orphan-rule than to Haskell's open-world assumption. Macro visibility follows the same pattern — a `macro_rules` declaration is visible where its namespace is `open`'d. Typeclass coherence semantics, the broader instance-resolution rules, and dispatch behavior are owned by `TYPES.md §6`; the module-system claim here is that imports are the scoping primitive, not type-system internals.

Lake (`lakefile.lean` / `lakefile.toml`) is the package manager; Mathlib is the dominant single-package Lean ecosystem with hundreds of namespaces.

The lesson: **a conventional namespace-import module system can be made semantically load-bearing for instance and macro scoping without adopting Racket-style phase machinery** — a viable middle ground.

Sources: https://lean-lang.org/lean4/doc/setup.html and https://lean-lang.org/theorem_proving_in_lean4/interacting_with_lean.html and https://lean-lang.org/lean4/doc/whatsnew.html and https://leanprover-community.github.io/

### 8.14. R — NAMESPACE Files and Method Dispatch Interaction

R's module model is shaped by its statistical-computing audience: packages are the unit of distribution and the unit of namespace, with a flat **NAMESPACE** file declaring exports and imports, plus distinctive interaction with R's S3 and S4 method-dispatch systems.

A NAMESPACE file is line-oriented:

```
export(my_function)
export(another_function)
exportPattern("^[^.]")    # export everything not starting with a dot
import(stats)             # import all names from stats
importFrom(utils, head, tail)
S3method(print, my_class)
S3method(summary, my_class)
```

The distinctive features:

- **Flat declarative form**, not tied to source-code annotations. Unlike Nim's `*` marker, R requires the package author to maintain a separate NAMESPACE file.
- **`exportPattern`** uses regex to declare exports, making "everything not prefixed with a dot" expressible as a single line.
- **`S3method(generic, class)`** is the critical line: it registers an S3 method for dispatch. **Method registration is separate from name export** — a `print.my_class` function can be exported (callable by name) and registered (called by `print()` dispatch on objects of `my_class`), or registered without export (called via dispatch but not directly), or exported without registration (callable but not dispatched).
- **`useDynLib(packagename)`** registers compiled C/Fortran shared libraries shipped with the package.

The DESCRIPTION file is the manifest (`Package:`, `Version:`, `Depends:`, `Imports:`, `Suggests:`). **CRAN** is the central registry, with strict pre-publication review (manual vetting plus automated checks) — the strictest registry in the survey, more rigorous than crates.io, npm, or PyPI.

The lesson: **method-dispatch registration and name export are independent operations**, and a language with method dispatch has to decide whether they're coupled (Java: implicit method visibility tracks class visibility) or decoupled (R: explicit registration, separate from name export). The decoupling is more verbose but lets package authors expose dispatch behavior without exposing the implementing functions by name.

Sources: https://cran.r-project.org/doc/manuals/r-release/R-exts.html#Package-namespaces and https://r-pkgs.org/namespace.html and https://cran.r-project.org/web/packages/policies.html

### 8.15. Design Lessons from Additional Production Languages

The systems in this chapter add several specific lessons not covered by chapters 3–7:

- **Resilient ABI as a module-system concern** (Swift Library Evolution): if a language wants binary stability across module versions, the module system needs to emit interface descriptions as artifacts, separate from implementation, and let the runtime resolve layouts dynamically.
- **Application as a runtime concept distinct from module** (Erlang/OTP): the deployment/lifecycle unit can usefully differ from the namespace/compilation unit.
- **Hot reload requires explicit module identity at runtime** (Erlang): if modules are flat, named, individually loadable artifacts, they can be swapped at runtime.
- **Native-code precompilation caches are a module-system concern** (Julia 1.9 pkgimage): a module's first-load cost is paid once if the runtime caches compiled artifacts at module granularity.
- **File-order-as-project-semantics** (F#) is feasible but rare and requires tooling support to make project-file ergonomics tolerable.
- **Per-declaration export markers** (Nim's `*`) can replace export lists entirely with one character of syntactic noise per public symbol.
- **Cycle prohibition at the file level** (Elm) is stricter than Go's package-level rule and entirely workable in pure-functional languages.
- **Underscore privacy** (Dart `_foo`, Python convention) is a lightweight alternative to `pub`/`internal` keywords; Dart enforces it at the language level, Python leaves it as convention.
- **Distribution identity as a tuple, not a string** (Raku `:auth`/`:ver`/`:api`): if multiple distributions of the same name must coexist, identity has to be a tuple expressed in import syntax, not just a string disambiguated by lockfile.
- **Splitting load from import** (Raku `use`/`need`/`require`): "make a compunit available" and "bring symbols into scope" are independent operations, and forcing them into one keyword loses expressiveness.
- **Stack-of-tables vs declarative imports** (Forth wordlists vs Factor vocabularies): the same "named-word collection" primitive admits both an imperative manipulation model and a declarative resolution model; the latter scales better to separate compilation and static analysis.
- **Refusing to guess on ambiguity** (Factor's ambiguous-use-error): a module system that refuses to silently pick among multiple resolutions trades convenience for robustness.
- **Per-binary-export modifier** (D's `export`): distinguishing "visible across module boundaries within this binary" from "visible across linking boundaries between binaries" addresses the ELF/PE export-table concern at the language level rather than via build-system attributes.
- **Module system as instance-resolution scope** (Lean 4): typeclass instances are scoped to module imports, so the import graph determines which dispatch tables are visible. Avoids Haskell's global instance assumption while keeping Rust's coherence stricter.
- **Method registration decoupled from name export** (R NAMESPACE `S3method` vs `export`): when the language has method dispatch, registering a method for dispatch and exporting its name as a callable are independent operations, expressible separately.
- **Compile-time-elaborated parametric IR shipped pre-instantiation** (Mojo §8.16): when the language has serialisable parametric IR, the module system can ship pre-elaboration code for cross-platform / cross-target specialisation, inverting Rust's monomorphisation-at-library-build-time model.

A language designer can pick from this menu without committing to any single ecosystem's full module system. Symbol-table-and-namespace lessons from Perl 5, Common Lisp, Clojure, and Tcl now live with the rest of the runtime-import family in §4.9; specification/body and Wirth-lineage lessons from Ada, Modula-2/3, and Oberon live with the typed family in §5.7.

### 8.16. Mojo — File-as-Module over Three-Stage Compile-Time Elaboration

Mojo's module-system *surface* is conventional Python-with-types (`from foo import bar`, file-as-module, dotted package paths), but the *underlying compilation pipeline* is the MLIR-based three-stage parser → interpreter → elaborator covered in `COMPILERS.md §6.6` (KGEN/POP) and `COMPILERS.md §12.10` (`@parameter`). The module-system-relevant consequence is that **modules participate in compile-time elaboration**: a parametric struct `List[T]` declared in module `collections` can be specialised at compile time at every call site, with the specialisation living in the importing module's compiled artifact rather than in `collections`.

Distinct from Python (§4.1) inheritance: Mojo imports do not perform module-body execution in the Python sense. A Mojo module is a compile-time namespace of declarations; importing it makes the declarations available without running their initialisation code at import time. There is no `__init__.py` that runs on first import, and no module-object singleton with mutable state.

Distinct from Rust (§3.1) crates: Mojo's parametric types (KGEN/POP) are **serialisable pre-instantiation**, so a Mojo library can ship parametric code that is specialised on the consumer's machine for the consumer's hardware target. This is the inverse of Rust's monomorphisation-at-library-build-time model: Rust generates concrete code at the library author's site for a fixed target tuple; Mojo defers specialisation to the consumer. The architectural benefit is **target-specific specialisation across the module boundary** — a generic SIMD kernel in a Mojo library can be specialised for AVX-512 on one consumer and Apple AMX on another from the same source artifact.

Status (as of 2026-04): Mojo's module system is still evolving. The language was closed-source through 2024 with parts (the standard library, then the compiler core) becoming open-source over 2024–2026; a stable 1.0 module-system specification has not been published. The design point worth recording is the **compile-time-elaboration interaction**: a module system designed for a language with serialisable parametric IR has different identity-and-distribution properties than one designed for monomorphisation-at-link-time (Rust), runtime specialisation (Java erasure plus JIT), or whole-program reachability (Virgil, `COMPILERS.md §13.6`).

The lesson for language designers: **if the language has compile-time parametric IR, the module system can ship pre-elaboration code for cross-platform / cross-target specialisation** — a property only Mojo currently has at production scale, but one available to any language with similar IR architecture.

Sources: https://docs.modular.com/mojo/manual/packages/ and https://docs.modular.com/mojo/manual/structs/ and https://docs.modular.com/mojo/manual/parameters/

### 8.17. CUE — Lattice-Based Configuration Language

Marcel van Lohuizen's **CUE** (Configure, Unify, Execute; descended from Google's GCL) is a configuration language whose module system is unusual because **types and values inhabit the same lattice**, and unification — not assignment — is the primary composition operator. A CUE module is a directory of `.cue` files plus a `cue.mod/module.cue` manifest; imports use Go-style paths (`import "list"`, `import "encoding/json"`); files in the same package implicitly compose by unification, so two files declaring `service: { name: "foo" }` and `service: { port: 8080 }` produce one combined `service: { name: "foo", port: 8080 }` without any explicit merge directive.

The module-system-relevant property is that **constraints and concrete values are the same kind of thing**. A "type" like `int & >0` (positive integer) is a value in the lattice; unifying it with `42` yields `42`; unifying it with `-1` yields `_|_` (bottom — unification failure). Module composition therefore enforces type-and-constraint compatibility automatically: importing a constrained schema and unifying it with concrete data either produces a more-specific value or a build-time error. The package manager (`cue`) supports module versions and dependency resolution against a CUE-specific module proxy.

Production: Kubernetes ecosystem (Istio configuration, kube-policy systems), Dagger CI/CD, several internal Google configuration tools, Tailscale ACLs. Distinct from JSON/YAML schemas: CUE schemas are CUE values, so schemas can be unified with each other to produce more-specific schemas, and a value validates against a schema by being unifiable with it. Distinct from Pkl (Apple's typed configuration language): Pkl is more imperative with classes and inheritance; CUE is fully declarative with lattice unification as the only composition primitive.

The lesson generalises beyond configuration: **a module system can be a unification system if the language's types and values share a lattice**. Most general-purpose languages cannot adopt this model because their type systems are stratified — types and values are different kinds of thing — but for declarative-data languages (configuration, schemas, policy) the unification model handles composition, validation, and constraint propagation in one mechanism.

Sources: https://cuelang.org/docs/introduction/ and https://cuelang.org/ and https://github.com/cue-lang/cue

### 8.18. Haxe — Cross-Compilation as a Module-System Concern

Nicolas Cannasse's **Haxe** is a strict, statically-typed language whose distinguishing trait is that the *target backend* is a configuration choice at compile time: the same source can compile to JavaScript, PHP, C++, C#, Java, Python, Lua, HashLink (Haxe's own VM), NekoVM, or Haxe-specific JVM bytecode. The module system uses Java-like file-as-module-with-`package`-declaration semantics (a file `com/foo/Bar.hx` declares `package com.foo;` and exports class `Bar`), but with one critical addition: **conditional compilation via `#if <flag>`** is used to gate target-specific code, allowing one module file to provide platform-specific implementations behind a single API.

The module-system-interesting property is the **target-conditional dependency**. A library may depend on `js.html.Document` only when compiling to JavaScript, on `cpp.NativeMath` only when compiling to C++, and on neither when compiling to Python. The Haxe build system (`haxelib` + `hxml` build scripts) resolves the dependency graph per-target, so the same library can declare different sets of cross-module imports depending on target — a design point that languages with single-target compilation never need to address. The std library itself is partitioned into target-specific subpackages (`js.*`, `php.*`, `python.*`, etc.) plus a target-agnostic core, and the `target.*` namespace conventions encode the boundary explicitly.

Production: **Heaps** game engine, **Shiro Games** (Northgard, Dune: Spice Wars), **Motion-Twin** (Dead Cells before C++ rewrite), enterprise PHP apps via the `php7` target, and several embedded UI systems on HashLink. Distinct from Kotlin Multiplatform (`§6.4`) which compiles to JVM/JS/Native via separate per-target source-set hierarchies: Haxe uses one source set with `#if` directives, simpler at small scale and noisier at large scale. Distinct from F# (`§8.7`) which has a Fable transpiler to JavaScript: Fable is one bolt-on backend whereas Haxe was multi-target from the start, and the Haxe macro system (compile-time AST manipulation in Haxe itself) lets a library generate target-specific bindings programmatically rather than maintaining hand-written stubs per target.

The lesson for a language designer: **if cross-compilation to multiple radically different runtimes is a first-class goal, the module system needs to be target-aware from the start**. Retrofitting target-conditional imports onto a single-target module system (as Kotlin and F# did) tends to produce per-target source-set hierarchies whose composition rules are awkward; designing the module system around a target enum from day one (as Haxe and Zig with `comptime` target detection do) keeps the surface uniform.

Sources: https://haxe.org/manual/introduction.html and https://haxe.org/ and https://github.com/HaxeFoundation/haxe and https://lib.haxe.org/

### 8.19. Pkl — Apple's Class-Based Configuration Language

Apple's **Pkl** (introduced February 2024, open-source under Apache 2.0; pronounced "Pickle") is a typed configuration language that occupies the same design slot as CUE (§8.17): generate JSON, YAML, property lists, or other structured configuration formats from a typed source language. Where CUE's discipline is *unification on a lattice* (types and values inhabit the same lattice; composition is unification), Pkl takes the *class-based object-oriented* path — classes with inheritance, abstract members, late-binding, and amend-and-extend overrides, all structurally typed and compile-time validated.

The distinguishing properties:

- **Late binding with abstract members** — a base class can declare an abstract field that a subclass must override; the abstract designation is part of the type, and the type checker rejects instantiation of an abstract class.
- **Type predicates** (`Int(this > 0)`, `String(matches(...))`) — refinement-typed integers and strings, validated at evaluation time. Integration-style predicate refinement, comparable to Ada SPARK's `Predicate` aspect (§5.5) but in a configuration context.
- **Amend-and-extend** — `(existingObject) { foo = newValue }` produces a copy of `existingObject` with `foo` overridden. Composes deeply through nested objects without commitment to either declarative-merge (CUE) or imperative-mutate (Helm) semantics.
- **Multi-format output** — one Pkl file can emit JSON, YAML, .plist, .pcf (Pkl Configuration Format), .properties, or arbitrary user-defined output via `output.text` and renderers. The same source generates Kubernetes manifests, GitHub Actions workflows, and Helm values without parallel maintenance.
- **Native bindings** for Java, Kotlin, Swift, Go, and Node — Pkl files can be evaluated by host applications and produce typed records in the host language. This closes the typing loop: configuration written in Pkl is type-checked at evaluation time *and* type-checked at consumption time by the host.
- **Module system with URL-shaped imports** — `import "package://pkg.pkl-lang.org/pkl-pantry/pkl.experimental.uri@1.0.0#/URI.pkl"` (URL-shaped imports with version pinning, similar to Deno `PACKAGING.md §3.7`).

Distinct from CUE (§8.17): Pkl is imperative-OO with classes; CUE is declarative-lattice with unification. Distinct from Jsonnet (a JSON-templating language pre-dating both): Pkl has a richer type system, while Jsonnet is dynamically typed. Distinct from HCL (Terraform's configuration language): HCL is declarative without a real type system; Pkl is class-based with type checking.

Production: Apple uses Pkl extensively internally for service configuration; external adoption includes several large-scale Kubernetes-and-Helm deployments where Helm's untyped templating became unmaintainable. Status (as of 2026-04): pre-1.0 (~0.27+) but production-stable per Apple's own usage. The lesson generalises: **typed configuration languages are converging on "real type system + multi-format output"**, with the design choice between unification (CUE) and class-based (Pkl) reflecting whether the audience prefers declarative or object-oriented thinking. For language designers asking "should I have a configuration sub-language?" — the answer is increasingly yes, and the design space is now well-mapped.

Sources: https://pkl-lang.org/index.html and https://github.com/apple/pkl and https://pkl-lang.org/blog/introducing-pkl.html

---

## 9. Research and Advanced Module Calculi

The languages in chapters 3–8 are all production systems that compromise expressive power for ecosystem viability. The research lineage in this chapter is the opposite: each entry pushes the module system in a particular formal direction, often producing systems that are conceptually beautiful but never widely deployed. They matter to a language designer not as templates to imitate, but as upper bounds on what a module system *could* be — and as cautions about which kinds of expressive power are not worth the cost.

### 9.1. Standard ML Module Calculus — The Classical Foundation

The Standard ML module system, formalized by MacQueen and others through the 1980s and presented in its mature form in the SML97 Definition, is the foundational reference for typed module calculi. Its three-layer structure — **structures** (implementations), **signatures** (interfaces), and **functors** (parameterized modules) — became the vocabulary every later module-system researcher builds against or reacts to.

The technical depth that production languages have not absorbed is substantial:

- **Sharing constraints and `where type` clauses**: when two functors must be applied to structures whose abstract types are equal, the signature can express that equality directly (`functor F(X : SIG where type t = int)`), letting the type checker enforce it without the user choosing a specific implementation.
- **Translucent vs opaque ascription**: SML distinguishes `S : SIG` (transparent — the signature constrains what is visible but lets the user see through to concrete types) from `S :> SIG` (opaque — the signature creates a strict abstraction barrier). Most production languages have only one form.
- **Generative vs applicative functors**: see §9.7.
- **Higher-order functors**: functors that take and return functors, enabling abstraction over abstraction patterns.

Production languages have absorbed signatures-and-modules but largely not the full machinery. OCaml is the closest to SML's expressivity (and adds first-class modules), but even OCaml's mainstream usage rarely exercises sharing constraints or opaque ascription deeply. The lesson is that module-calculus expressivity has a practical ceiling — the marginal user cost of each additional feature exceeds the marginal benefit at some point, and that point is reached fairly early.

Sources: https://smlfamily.github.io/sml97-defn.pdf and http://www.cs.cmu.edu/~rwh/smlbook/book.pdf and https://homepages.inf.ed.ac.uk/dts/fps/papers/MacQueen.pdf

### 9.2. 1ML — Unifying Modules and Core

Andreas Rossberg's **1ML** (ICFP 2015, with subsequent refinements) is the most ambitious modern attempt to *unify* the ML module language and the ML core language. In ordinary ML, the module language and the core (term/type) language are distinct: types are in the core, signatures are in the module language; values are in the core, structures are in the module language. They use different syntax, different binding mechanisms, and different scoping rules. 1ML demonstrates that this dichotomy can be eliminated: in 1ML, **modules are first-class values, signatures are first-class types, functors are ordinary functions**, and the core/module distinction collapses into one language.

The technical move that makes this work is treating signatures as a particular form of (large) type and modules as values of those types. Type abstraction is recovered through existential quantification, and applicative-vs-generative functor distinctions are recovered through choice of polymorphism mode (predicative vs impredicative). The result is a language whose module system is as expressive as full SML modules but expressed with no separate module syntax.

1ML is not a production language. Its significance is conceptual: it shows that the apparent need for "two languages" (core + module) is not fundamental, and that a sufficiently expressive single language can absorb the module system. Most production languages will not benefit from this — the two-language style is what makes ML modules approachable — but the existence proof matters because it bounds what is necessary.

Sources: https://people.mpi-sws.org/~rossberg/1ml/1ml.pdf and https://people.mpi-sws.org/~rossberg/

### 9.3. Modular Implicits — Type-Class-Style Inference for OCaml

White, Bour, and Yallop's **Modular Implicits** (ML Workshop 2014) propose extending OCaml with a mechanism for *implicitly* applying functors to their argument structures, similar to how Haskell elaborates type-class instances. The user writes `show 42` and the elaborator searches the visible scope for a structure matching `SHOW with type t = int`, applying the appropriate functor automatically.

This is conceptually significant because it shows that **type classes and module systems are duals** in a precise sense. Type classes are dictionaries-passed-implicitly; ML modules are dictionaries-passed-explicitly. Modular implicits make ML modules participate in implicit elaboration, recovering type-class ergonomics without abandoning the module-calculus foundation. Scala's implicits (Scala 2) and `given`/`using` (Scala 3) are independent designs in the same conceptual space; Rust's traits are another point.

The proposal has not landed in mainline OCaml, partly because the elaboration semantics interact subtly with OCaml's existing type inference and module language. The design space remains open: OCaml's existing first-class modules cover some of the use cases, and the community has debated whether implicit modules add enough value to justify the language complexity.

Sources: https://arxiv.org/abs/1512.01895 and https://www.cl.cam.ac.uk/~jdy22/papers/modular-implicits.pdf and https://www.lpw25.net/

### 9.4. Backpack — Indefinite Modules and Mixin Linking for Haskell

**Backpack** (Kilpatrick, Dreyer, Peyton Jones, Marlow — POPL 2014) is GHC's mixin module system, motivated by the longstanding limitation that Haskell cannot express "this module depends on a module of this signature" without either dependency-injecting through type-class dictionaries or hand-coding boilerplate. Backpack adds **indefinite modules** (modules with unfilled holes that match a signature) and **module instantiation at link time**.

The design pattern is straightforward: a library can expose a signature `Stream` and an indefinite implementation that depends on `Stream`-matching modules. Downstream consumers instantiate the library with their preferred concrete `Stream` implementation, and the result is a fully linked module. This is closer to ML functors than to type classes, but operating at the package layer rather than the module-language layer.

Backpack landed in GHC 8.2 (2017) but has seen modest adoption. The mainstream Haskell answer to "abstraction over implementations" remains type classes, partly because Cabal's tooling integration with Backpack remained rough for years. The lesson: **module-level mixin linking can be a powerful alternative to type classes**, but it competes with an entrenched mechanism and needs strong tooling to win adoption. Greenfield designs without an entrenched type-class system can choose mixin modules cleanly; one that already has type classes faces an uphill migration.

Sources: https://plv.mpi-sws.org/backpack/backpack-popl.pdf and https://gitlab.haskell.org/ghc/ghc/-/wikis/backpack and https://wiki.haskell.org/Backpack

### 9.5. MixML and Recursive Mixin Modules

Derek Dreyer's **MixML** (Dreyer-Rossberg, ICFP 2008) and the broader mixin-module tradition (Bracha-Cook 1990; Flatt-Felleisen 1998; Hirschowitz-Leroy 2002) explore module systems whose composition operator is *mixin merging* rather than functor application. A mixin module declares required imports (slots) and provided exports; mixing unifies slots and exports, propagating type identities and recursively composing. MixML's contribution is **type-safe recursion across module boundaries**: two modules can mutually depend through their interfaces if their composition resolves all slots — structurally similar to Backpack's indefinite modules but with composition rather than instantiation as the primitive.

Mixin modules have not landed in any major production language. Scala's traits are loosely inspired but operate at the value/class level. The lesson is that **recursive cross-module dependency is solvable with the right algebraic structure**, but production languages typically ban cycles instead — a simpler answer that vastly simplifies implementation.

Sources: https://people.mpi-sws.org/~dreyer/papers/mixml/icfp08.pdf and https://www.mpi-sws.org/~dreyer/

### 9.6. Newspeak — Modules as Parameterized Top-Level Classes

Gilad Bracha's **Newspeak** has no global namespace and no static state. Top-level classes are parameterized over the modules they need: a top-level class is a module that takes its dependencies as constructor arguments, and instantiating the class produces a module instance. This is ocap modularity (canonical at `MEMORY.md §10`) lifted to the language's primary modularity mechanism. Modules cannot hold mutable global state, modules are parameterized over dependencies without DI framework, and module composition is object construction; multiple instances of "the same module" can coexist with different bindings, supporting test isolation, sandboxing, and live update naturally.

Newspeak is small and academic but has influenced E, Caja, SES (Hardened JavaScript), and the broader ocap tradition. The lesson: **fusing "module" and "object" produces a remarkably clean ocap story**, but it requires the language to commit to no-global-state from day one — essentially unretrofittable.

Sources: https://newspeaklanguage.org/ and https://bracha.org/newspeak.pdf and https://bracha.org/newspeak-modules.pdf

### 9.7. Applicative vs Generative Functors

A subtle but practically important distinction in the ML module tradition is **applicative** vs **generative** functor application. The question is: when a functor `F` is applied twice to the same argument structure `M`, do `F(M)` and `F(M)` produce the *same* abstract type, or *fresh* abstract types?

- **Applicative functors** (OCaml's default): `F(M).t` and `F(M).t` are the same type. Two applications to the same argument produce equivalent results.
- **Generative functors** (SML's default; OCaml when the functor body has effects): each application produces fresh abstract types. `F(M).t` from one application is a different type from `F(M).t` from another.

This matters when functors are used to implement abstract data types like sets or maps. Applicative semantics means a `Set(IntOrder)` produced in one module is interchangeable with `Set(IntOrder)` produced in another. Generative semantics means they are distinct types — a deliberate choice when the functor allocates global state, refs, or other side-effecting resources that must not be shared.

OCaml supports both: `module F (X : SIG) = struct ... end` is applicative when pure; `module F (X : SIG) : sig ... end = struct ... end` (with sealing) is generative. Programmers must understand the distinction to write correct abstract-type abstractions in OCaml.

The design lesson: **module application semantics is a language-design choice**, not just an implementation detail. Any language introducing functors must decide whether default behavior is applicative (more usable, but rules out mutable state in functor bodies) or generative (more flexible, but every application produces a fresh type).

Sources: https://v2.ocaml.org/manual/moduleexamples.html#s:applicative-functors and https://people.mpi-sws.org/~dreyer/papers/dreyer/thesis.pdf

### 9.8. First-Class Modules

OCaml supports **first-class modules**: a module can be packaged into a value of type `(module SIG)`, passed as a function argument, stored in a data structure, and unpacked back into a module at the call site. This bridges the gap between the module language and the core language without going as far as 1ML's full unification.

```ocaml
let make_set : type a. (module COMPARABLE with type t = a) -> a list -> a list =
  fun (module Cmp) xs -> List.sort_uniq Cmp.compare xs
```

Here `(module Cmp)` is a first-class module value pattern. The argument is supplied as `(module IntComparable)`. This is closer to dependency injection than to traditional functor application: the dependency is chosen dynamically at runtime, not statically through functor application.

First-class modules have been in OCaml since 3.12 (2010) and are the substrate behind several library patterns (e.g., the `(module Show)` argument idiom, certain monadic frameworks). They demonstrate that the gap between the module language and the core language can be bridged pragmatically without committing to 1ML's full unification.

Sources: https://v2.ocaml.org/manual/firstclassmodules.html and https://dev.realworldocaml.org/first-class-modules.html

### 9.9. Scheme R6RS / R7RS Libraries — The Canonical Declarative Module Form

The Scheme standardization process produced two distinct module designs, both deeply influential. **R6RS libraries** (2007) introduced the form:

```scheme
(library (stack)
  (export make push! pop! empty!)
  (import (rnrs))
  (define (make) ...)
  (define (push! s v) ...))
```

The library name is a list of identifiers (`(net http client)`); export lists name bindings; import lists name libraries with optional refinements. The four import refinements that became canonical across the broader Lisp/functional ecosystem:

- `(only (lib) name1 name2 ...)` — import only the named bindings.
- `(except (lib) name1 ...)` — import everything except the named bindings.
- `(prefix (lib) my-)` — import all bindings with the given prefix added.
- `(rename (lib) (old1 new1) (old2 new2) ...)` — import bindings under different local names.

These compose with import-list parentheses, so `(import (only (rename (foo) (bar baz)) baz))` imports `bar` from `(foo)` as `baz`. R6RS additionally supports versioning (`(my-lib (1 2))`) and **phasing** (`for` annotations indicating whether a library is needed at expand-time, run-time, or both — the same phase tower covered in §5.4 for Racket).

**R7RS libraries** (2013) deliberately simplified by dropping versioning and phasing, replacing `library` with `define-library`, and adding several declarations: `(include "file.scm")` for textually-included source, `(include-ci ...)` for case-insensitive include, `(include-library-declarations ...)` for shared library headers, and crucially `(cond-expand ...)` for portable feature-conditional compilation. The R7RS form is more pragmatic; R6RS is more formally specified.

The R6RS/R7RS import refinements are the canonical reference for declarative module composition. Their influence is visible throughout the survey: Haskell's `import qualified ... as` and `hiding`, Racket's `provide` / `require` forms (covered in §5.4), Rust's `use` with `as` renames, even Python's `from X import Y as Z`. R6RS made `only`/`except`/`prefix`/`rename` a complete vocabulary that subsequent designs picked from rather than reinventing.

A subtle technical point worth recording: the import-list itself is a *form*, not just a list of names. The `(library X)` wrapper is required only when one of the names in `X` would otherwise be parsed as `for`/`only`/`except`/`prefix`/`rename` — a self-referential escape hatch that disambiguates the small set of import-keyword names from arbitrary library-name identifiers. Most production languages skip this nicety and reserve their import-keywords globally.

The lesson generalizes: **a small fixed set of import refinement operators (only/except/prefix/rename) covers virtually every selective-import pattern**, and the R6RS/R7RS vocabulary can be adopted without inventing a parallel set. The cost is minor — ~four import-form keywords to specify and document.

Sources: https://www.r6rs.org/final/html/r6rs/r6rs-Z-H-10.html and https://small.r7rs.org/attachment/r7rs.pdf and https://standards.scheme.org/corrected-r7rs/r7rs-Z-H-7.html and https://standards.scheme.org/corrected-r7rs/r7rs-Z-H-12.html

### 9.10. Agda and Idris 2 — Dependent-Type Modules and Records-as-Functors

In dependently-typed languages, the module/record boundary dissolves: a module is a record, and its fields can be types or proofs depending on earlier values. ML-style functors become a special case of ordinary record construction whose parameter list is a telescope of dependent values rather than a fixed signature.

**Agda** declares parameterized modules with `module Stack (A : Set) where ...`, instantiated as `module IntStack = Stack Nat`. The structural difference from ML functors is that subsequent module parameters can reference earlier parameters as values, not just as types — a property requiring dependent-type machinery in the core language. Agda's other module operations (`open M`, `open M using (...)`, `hiding`, `renaming`, anonymous `module _ where ...`, `record`-as-module) follow the R6RS refinement vocabulary (§9.9). **Idris 2** inherits the same model and adds **interfaces** (records-of-functions resolved by search), structurally different from Lean 4's import-scoped registration (§8.13).

The module-structure claim: **once the language has dependent types, modules don't need to be a separate construct from records.** ML's three-stratum split (values, types, modules) collapses to one, but the property is fundamentally a typing-rule consequence; full treatment of dependent types lives in `TYPES.md §10`. A non-dependently-typed language inherits ML's stratified module language because its core language cannot express type-of-type fields.

Sources: https://agda.readthedocs.io/en/latest/language/module-system.html and https://agda.readthedocs.io/en/latest/language/record-types.html and https://idris2.readthedocs.io/en/latest/tutorial/modules.html and https://idris2.readthedocs.io/en/latest/tutorial/interfaces.html

### 9.11. Design Lessons from Research Module Calculi

The research tradition produces several specific lessons for module-system design:

- **Module systems can be unified with the core language** (1ML), but production languages generally choose not to, because the two-language structure is more approachable.
- **Implicit module elaboration is feasible** (modular implicits), and overlaps significantly with type classes; languages should choose one or the other, not both.
- **Mixin module composition is more expressive than functor application** (Backpack, MixML), but production languages have generally chosen the simpler model.
- **The applicative/generative functor distinction is a real semantic choice** (OCaml vs SML defaults), and any language with parameterized modules has to take a position.
- **First-class modules are a useful pragmatic compromise** between the two-language ML style and full 1ML unification.
- **Modules-as-objects-with-no-globals** (Newspeak) is the cleanest ocap module design but requires no-global-state from day one.
- **Canonical declarative import refinements** (R6RS/R7RS Scheme): the four-operator vocabulary `only`/`except`/`prefix`/`rename` covers virtually every selective-import pattern, adoptable without reinventing the wheel.
- **Dependent types collapse the module/record distinction** (Agda, Idris 2): once values and types live in one universe, ML's stratified module language becomes redundant — modules are just records with type-of-type fields. This only works if the language commits to dependent types from the start; it isn't retrofittable onto a stratified core.

The deepest lesson is that **module-system expressivity has a steep diminishing-returns curve**. SML-level expressivity (signatures, functors, sharing constraints, opaque ascription) is the practical ceiling for production languages; everything beyond that is research-grade and rarely justifies its cost. A defensible target is "Rust + ML signatures" or "Go + functors" — unless dependent types are committed to early, in which case the entire question dissolves into the core language.

A complementary lesson, separate from the expressivity curve, comes from Carbon (§9.12): **modules from day 1 with no migration debt** is a feasible alternative to retrofitting modules onto an established ecosystem (JPMS §6.1, C++20 §7.2). The Carbon design takes lessons from the C++20 retrofit — explicit `package`/`library` declarations, API/impl file split, per-API-element export markers, strict acyclic imports, build-system-managed module identity — and bakes them into version 1 instead of hoping the ecosystem will migrate.

### 9.12. Carbon — Modules from Day 1 in a C++ Successor

Google's **Carbon** (announced CppNow 2022, lead by Chandler Carruth) is an experimental C++ successor language with a module system designed against the lessons of the C++20 modules retrofit (§7.2) and the JPMS retrofit (§6.1). Unlike C++20, Carbon makes modules the primary unit from version 1; unlike JPMS, modules are language-level rather than artifact-level; unlike Rust, the module-and-package layering is co-designed with the build system from the start.

Carbon's module design (still evolving; Carbon is pre-1.0, status as of 2026-04):

- **Explicit `package` and `library` declarations**: every Carbon source file declares its package and library at the top via `package Foo library "Bar" api;` (or `impl` for implementation files). Imports are `import Foo library "Bar";` — the package name resolves through a dependency manifest, the library name resolves within the package.
- **API/impl file split**: Carbon distinguishes API files (the public-interface files, similar to Ada's specification §5.5 or OCaml's `.mli` §5.1) from impl files (the implementation bodies). API files are the only thing visible to importers; impl files supply the bodies.
- **Per-API-element export markers**: API files use the `api` modifier on declarations (similar to Nim §8.5's `*` marker but as an explicit keyword). The visibility decision is locally visible at every declaration.
- **Strict acyclic imports**: cycles are forbidden between libraries within a package and between packages. The language statically rejects cyclic dependency graphs, following Go (§3.3) rather than Python (§4.1).
- **Toolchain-managed module identity**: a `BUILD` file (similar to Bazel's) names libraries and their dependencies, mapping language-level imports to artifact-level builds. Carbon explicitly accepts that build-tool and language are co-designed (§6.4 Kotlin's lesson).

The distinguishing claim is that **Carbon learns from the C++20 retrofit**: by making modules the *only* unit from day 1, Carbon avoids the migration overhead that left half of C++'s ecosystem still on `#include` in 2026. The cost is that Carbon has no existing ecosystem to consume — every dependency must be Carbon-native, with C++ interop via a dedicated FFI layer rather than `import` of C++ headers. The interop story is structurally distinct: Carbon defines a controlled interop surface for calling into and out of C++ libraries, but Carbon imports do not see C++ headers as modules.

Status (as of 2026-04): Carbon is pre-1.0, not production-ready. The published 2025 roadmap targeted two areas of focus: a "major chunk of C++ interop working" demo and the design of memory safety; both are still in progress as of early 2026. The language is being developed in the open at `github.com/carbon-language/carbon-lang`; the explicit non-goal is "stable enough for production today." For module-system designers, Carbon is the cleanest current example of "modules from day 1, no migration debt" in a C-family successor language — even if Carbon itself never reaches production, its module-system design choices are an instructive data point on what can be done when the migration constraint is removed.

Sources: https://github.com/carbon-language/carbon-lang/blob/trunk/docs/design/modules.md and https://github.com/carbon-language/carbon-lang and https://github.com/carbon-language/carbon-lang/blob/trunk/docs/design/code_and_name_organization/README.md

---

## 10. Dynamic Loading, Plugins, and Hot Module Replacement

The chapters above treat modules primarily as compile-time or load-time concerns. This chapter covers what happens when a system needs to *load, swap, or unload modules at runtime* — for plugin architectures, live-coding workflows, hot deployment, or interactive development. The mechanisms differ sharply by language family, but they share a common challenge: the language's module identity model and the runtime's module-instance model must agree, or strange things happen at the boundary.

### 10.1. Native Shared Libraries — `dlopen`/`LoadLibrary` and Symbol Resolution

POSIX `dlopen(path, flags)` and Windows `LoadLibrary(path)` are the lowest-level dynamic-module mechanisms. The OS loads the shared object (`.so`/`.dylib`/`.dll`) into the calling process's address space, resolves symbol references against the global symbol table, and returns a handle. `dlsym(handle, name)` looks up a named symbol; `dlclose(handle)` decrements the reference count and may unload.

The mechanism is the substrate beneath higher-level dynamic-loading systems but is itself extremely raw. It has no notion of types, versions, or module identity beyond filename. Symbol name conflicts between concurrently-loaded libraries are managed by per-library namespaces (`RTLD_LOCAL`) or accepted as global shadowing (`RTLD_GLOBAL`). C++ name mangling, which encodes class and namespace structure into symbols, is the closest the C/C++ ecosystem comes to enforcing module identity at the dynamic-loading layer.

The `dlopen` model is the hot-reload primitive used by game engines (covered in `COMPILERS.md §23.5` from the runtime angle), database extensions (PostgreSQL `LOAD`, SQLite virtual tables), and traditional plugin architectures. The general pattern is: keep all mutable state in the host process, put only stateless logic in the reloadable shared object, and re-bind function pointers after each reload. The discipline is on the programmer; the language and OS provide only the loading mechanism.

Sources: https://man7.org/linux/man-pages/man3/dlopen.3.html and https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibrarya

### 10.2. Java Class Loaders and OSGi

The JVM's runtime module mechanism is the **class loader hierarchy**. Each loaded class has an associated `ClassLoader`, and the loader's identity is part of the class's runtime identity — two `Foo` classes loaded by different loaders are distinct types from the JVM's perspective, even if they have identical bytecode. Class loaders form a parent-delegation chain by default: a class loader asks its parent before defining the class itself, ensuring that platform classes (`java.lang.String`) are always loaded by the bootstrap loader.

Custom class loaders enable rich dynamic-loading patterns: application servers (Tomcat, JBoss) use per-webapp loaders to isolate one app's class versions from another's; build tools use loaders to isolate compile-time plugins; Spring uses class loaders to support hot-deploy in development.

**OSGi** is the canonical formalization of dynamic module loading on the JVM. An OSGi bundle is a JAR with extra manifest metadata declaring which packages it imports and exports, with explicit version ranges. The OSGi runtime resolves imports against exports across all installed bundles, builds a per-bundle class loader graph, and supports starting, stopping, updating, and uninstalling bundles at runtime. This is the JVM's most ambitious module-system design and was developed independently of JPMS — they coexist with some friction. Eclipse, Apache Karaf, and many telecom platforms run on OSGi.

The lesson is that **dynamic module loading on a managed runtime requires the runtime to participate in module identity**. The JVM does this via class-loader-as-identity-component. The CLR does this via assembly load contexts (`AssemblyLoadContext`, .NET Core 3+). Languages without a managed runtime (C, Rust) cannot offer the same guarantees and rely on programmer discipline.

Sources: https://docs.oracle.com/javase/8/docs/technotes/guides/lang/cl-mt.html and https://www.osgi.org/resources/architecture/ and https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext

### 10.3. Erlang Hot Module Reload

Erlang's flat-module + two-version-active hot reload is covered at §8.2 (canonical) and from the runtime side in `COMPILERS.md §23.1`. The point relevant here is the design preconditions: a language wanting Erlang-style hot reload must commit early to flat module identity, individually loadable artifacts, a fully-qualified-call vs local-call distinction, and immutable per-process state — all language-design choices, not runtime features added later.

### 10.4. Python `importlib.reload` and Plugin Patterns

Python supports module reloading via `importlib.reload(module)`, which re-executes the module's top-level code and updates the cached `sys.modules` entry. The mechanism is conceptually simple but practically tricky: existing references to module-defined classes, functions, or values continue to point at the *old* objects, while new lookups against the module find the *new* ones. The result is a running program with two coexisting versions of "the same" function.

For plugin architectures, the more common pattern is `importlib.import_module(name)` for dynamic discovery — typically driven by entry-point metadata (`entry_points` in `pyproject.toml`) that lets installed packages register plugins for a host application to discover. This is how Pytest discovers test runners, how Django finds installed apps, and how Sphinx loads extensions. The plugin model is a discovery mechanism layered on top of the standard import system, not a separate runtime mechanism.

The lesson is that **Python's runtime-import model trivially supports plugin discovery but only weakly supports hot reload**. The "old objects still in memory" problem is fundamental to import-time-execution semantics; eliminating it would require changing how Python references resolve. Designs that want both runtime imports and clean hot reload should either restrict reloading to specific patterns (Julia's Revise.jl handles this for development workflows) or commit to the Erlang-style flat-module architecture from day one.

Sources: https://docs.python.org/3/library/importlib.html#importlib.reload and https://packaging.python.org/en/latest/specifications/entry-points/

### 10.5. JavaScript Dynamic `import()` and Module Federation

ECMAScript modules support **dynamic import** via the `import()` expression, which returns a promise resolving to the module record. This is the static-syntax equivalent of `require()` in CommonJS but with the same instantiation/evaluation semantics as static `import` declarations. Dynamic imports enable code splitting (load a module only when needed), conditional loading (load different modules based on runtime detection), and lazy initialization patterns.

**Webpack's Module Federation** (introduced 2020) extends this further: a federated module can expose modules to other federated modules at runtime, across separately-deployed bundles. Two independently-built React applications can share component implementations, with the runtime resolving "import the `Header` component from the remote `app1` federation" against whichever version `app1` happens to be serving. This is the closest the JavaScript ecosystem comes to OSGi-style runtime module composition.

The lesson is that **dynamic module loading composes with package-metadata-shaped resolution** (`PACKAGING.md §3.4`): the same `package.json` `exports` map that determines static-import resolution also determines dynamic-import resolution, and the same loader configuration drives both. This is consistent but means the loader story has to be designed once for both static and dynamic paths.

Sources: https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-module-system and https://webpack.js.org/concepts/module-federation/

### 10.6. Hot Module Replacement in Bundlers (HMR)

Webpack, Vite, esbuild, and Parcel support **Hot Module Replacement** during development. The module-identity-relevant property is that HMR requires modules to be addressable by stable identity in the dependency graph and to declare cooperation explicitly: the `import.meta.hot.accept(...)` boundary is the module asserting "I integrate the new version of myself." Without an accepting boundary the bundler walks up the dependency graph until it finds one, or falls back to a full reload. Accept-callback semantics, dependency-graph walking, and runtime patching mechanics live in `DEBUGGERS.md §3.12`.

The module-system lesson is that **hot replacement requires explicit cooperation from modules being replaced** — the same constraint Erlang (§8.2) and Julia's Revise.jl encode at the language level. Robust hot reload requires exposing an analogue of `import.meta.hot.accept` as a module-system primitive from day one.

Sources: https://vitejs.dev/guide/features.html#hot-module-replacement and https://webpack.js.org/concepts/hot-module-replacement/ and https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules#hot_module_replacement

## 11. Wasm Component Model and Capability-Scoped Modules

WebAssembly's module story has evolved through three distinct generations: core Wasm modules (the original `.wasm` binary format), the abandoned **Module Linking** proposal, and the current **Component Model**. The Component Model is the most ambitious modern realization of "modules with strict typed interfaces and explicit capability boundaries" outside the ML tradition, and it is worth covering separately because it represents a binary-level module system designed from scratch with full hindsight on what does and does not work.

### 11.1. Core Wasm Modules — Imports, Exports, and Linear Memory

A core Wasm module is a binary artifact declaring **imports** (functions, globals, memories, tables, tags expected from the host or other modules), **exports** (the same kinds, exposed for consumers), and a **start function** that runs at instantiation. The module's body is a sequence of typed function definitions. Modules are stateless until **instantiated**; an instance owns its own copies of mutable globals, memories, and tables.

The host (a browser, Node.js, Wasmtime, Wasmer, etc.) instantiates a module by supplying values for its imports — typically functions implementing system calls, memories provided by the host, or tables shared with other modules. The host then invokes exported functions. This is similar to `dlopen`-style native dynamic loading but with the entire memory model statically declared in the binary and the host having full control over what authority each instance receives.

Core Wasm modules are remarkably good at **language-agnostic deterministic execution** but are weak as a module-system substrate for higher-level programs. They have no notion of strings, records, lists, optional values, or other higher-level types — only `i32`, `i64`, `f32`, `f64`, and references. Two Wasm modules cannot share complex data structures directly; they have to negotiate through linear memory, which is awkward and error-prone.

The intermediate attempt that didn't ship is worth recording. **Module Linking** was a 2019–2021 W3C Wasm proposal to give core modules a typed-import linking story: a Wasm module could declare imports of *other Wasm modules* (not just functions), with type-checked module-as-module composition. The proposal got as far as Phase 2 in the Wasm CG process but was eventually superseded and folded into the Component Model. The reason the proposal didn't reach mainstream adoption is instructive: it tried to graft module composition onto the core Wasm type system, which only knew about scalar values and references. Composing modules required composing *interfaces*, and interfaces needed richer types (strings, records, variants, options, lists) than core Wasm provides. The Component Model resolved this by introducing WIT as a separate typed IDL above core Wasm rather than extending core Wasm's type system in place. Module Linking is the cautionary precedent: a typed module composition system needs a typed substrate, and adding the types to the substrate after the fact didn't work.

Sources: https://webassembly.github.io/spec/core/syntax/modules.html and https://webassembly.org/specs/

### 11.2. The Component Model — WIT, Worlds, and Resource Types

The **Wasm Component Model** (W3C draft, with reference implementation in Wasmtime since 2024) layers a typed interface system on top of core Wasm. A **component** is a Wasm artifact that declares its imports and exports using **WIT** (Wasm Interface Type) — a typed IDL with primitive types, records, variants, options, lists, results, and **resource types** (opaque handles that can be passed across component boundaries without exposing internal layout).

```wit
package example:greeter;

interface greeter {
  greet: func(name: string) -> string;
}

world hello {
  import wasi:cli/environment;
  export greeter;
}
```

A `world` is the component-level analog of an ML signature: it declares the full set of imports the component requires and exports it provides. A component implementing `world hello` can be instantiated against any host that provides `wasi:cli/environment` and will export the `greeter` interface. The runtime negotiates the WIT-typed boundary, marshalling values between caller and callee through the **canonical ABI** (a standardized lowering from WIT types to core Wasm types and linear memory).

The **resource type** is the most distinctive contribution. A resource is an opaque handle owned by the component that defined it; another component can hold the handle and call methods on it (delegated through the runtime to the owning component) but cannot access the underlying memory. This is structurally similar to Erlang processes, OS file descriptors, or capability tokens — and it is the foundation for **WASI worlds** to express capability-scoped APIs.

### 11.3. WASI Worlds and Capability-Scoped Modules

**WASI** (Preview 2 launched January 2024; Preview 3 RC `0.3.0-rc-2025-09-16` released September 2025) is built on the Component Model. WASI defines worlds for common use cases (`wasi:cli/command`, `wasi:http/proxy`, `wasi:keyvalue/store`), each declaring the narrow capability handles a component in that world receives — filesystem dirs, sockets, HTTP clients, clocks, RNGs, etc. The module-boundary point is that a world is a typed-binary IDL: capabilities cross the component boundary as resource handles, and a component's authority equals the handles it was granted at instantiation. Capability mechanics, attenuation/virtualization patterns, and the broader ocap argument live in `MEMORY.md §10`; here the relevant fact is that the Component Model preserves those properties at the binary module boundary because all external interaction goes through declared imports.

The Preview 3 release adds **native async via Component Model `future` and `stream` types** — first-class typed async primitives in WIT signatures, replacing the Preview 2 pattern of pollable resource handles. A function returning `future<u32>` exposes a typed promise the consumer awaits; a function returning `stream<u8>` exposes a typed byte stream with built-in backpressure. Status (as of 2026-04): Wasmtime 37+ supports Preview 3 previews; runtime adoption is in early stages, with most production deployments still on Preview 2. The async primitives are co-designed with the Component Model rather than layered on top, so a component-to-component async call goes through the typed interface without needing a separate async runtime per language.

The module-system-relevant lessons: **a binary-level module system can be designed from scratch with strong typed interfaces** if the ecosystem commits to a typed IDL (WIT plays for components what signatures play for ML modules); **the canonical ABI matters** — marshalling typed data across the component boundary has real per-call overhead that the design must balance against richness; and **adding async to the IDL after the fact requires careful co-design** rather than bolting per-runtime async semantics on each side of a synchronous interface.

Sources: https://github.com/WebAssembly/component-model and https://component-model.bytecodealliance.org/ and https://github.com/WebAssembly/WASI and https://github.com/WebAssembly/WASI/blob/main/Proposals.md and https://wasi.dev/roadmap

### 11.4. Design Lessons from Wasm Components

- **Capability-scoped modules are practical** (see `MEMORY.md §10` for ocap mechanics) — typed resource handles + zero-ambient-authority instantiation, with most cost in ecosystem commitment, not language complexity.
- **Module composition is virtualization-friendly** — one component can wrap another by reimplementing its imports.

For a language targeting Wasm or any sandboxed environment, the Component Model is the natural fit; for general-purpose languages, the design choices (typed interfaces, capability-scoped imports, no ambient authority) are worth considering even outside the Wasm ecosystem.

---

## 12. Summary of Module Techniques

The previous chapters now cover enough of the design space to support direct comparison. The tables below compress the recurring trade-offs into forms that are easier to scan than the prose chapters. They do not replace the chapter detail; they identify the dominant patterns that emerge once file layout, dependency graphs, runtime initialization, typed abstraction, package identity, dynamic loading, and build-system layering are all viewed together.

### 12.1. Module identity models

| Language / system | Primary unit of modularity | Identity source | File-layout coupling | Package/distribution identity |
|---|---|---|---|---|
| Rust (§3.1) | Module tree inside a crate | `mod` declarations plus crate root | Medium | Separate package/crate layering |
| Zig (§3.2) | Imported file / exposed package module | Build-exposed package name or file path | Medium-high | Build-context-defined; URL+hash via `build.zig.zon` |
| Go (§3.3) | Package | Directory path under module path | High | Module in `go.mod`, package below it |
| Odin (§3.4) | Package | Directory/package organization and collection roots | High | Lightweight collection/package model |
| Python (§4.1) | Module / package object | Qualified import name resolved through import machinery | Medium-high | Separate packaging ecosystem |
| JavaScript ESM (§4.2) | Module record | Specifier resolved by host environment | Medium | Strongly shaped by runtime/package metadata |
| Node CommonJS (§4.3) | Loaded module object | Loader path / specifier resolution | Medium | Strongly shaped by package metadata |
| OCaml (§5.1) | Compilation unit / module | File-backed compilation unit name | High | Libraries/packages layered above units |
| Standard ML (§5.2) | Structure / functor / signature | Declaration-based | Low-medium | Implementation-specific ecosystem layer |
| Haskell (§5.3) | Module | Declared module name plus package/build context | Medium | Package manager/build layer distinct |
| Racket (§5.4) | Module | Module path + phase-relative binding context | Medium | Collections/packages layered above |
| C / headers (§7.1) | Translation unit + header graph | Files and include paths | High | External build/package layer |
| C++20 modules (§7.2) | Module interface unit | Declared module name + BMI/toolchain mapping | Medium | External build/package layer |
| Java / JPMS (§6.1) | Package + module | Package declaration + `module-info.java` | Medium-high | Module artifact (JAR with module-info), Maven coords |
| C# / .NET (§6.2) | Namespace + assembly | Namespace declaration + assembly identity | Low | Assembly (DLL) + NuGet coords |
| Scala 3 (§6.3) | Package + top-level definition | Package declaration | Medium | JVM artifact + Maven coords |
| Kotlin (§6.4) | Package + build-tool module | Package declaration + Gradle/Maven module | Medium | JVM artifact + Maven coords |
| Swift (§8.1) | Module (framework / SPM target) | Build-tool target name | Low-medium | Framework / SPM package |
| Erlang (§8.2) | Module (`-module(foo).`) | Flat module name | Medium (one module per file) | OTP application + Hex package |
| Elixir (§8.2) | Module (`defmodule MyApp.Foo`) | Hierarchical-by-convention atom name | Medium | Mix project + Hex package |
| Gleam (§8.2) | File-as-module on BEAM and JS | Hierarchical name mirroring directory path | High | gleam CLI + Hex package |
| Julia (§8.3) | Module + package | `module Foo`, possibly nested | Low (file-as-include) | Pkg environment + General registry |
| Dart (§8.4) | Library | URI specifier (`package:foo/foo.dart`) | Medium-high | pub package |
| Nim (§8.5) | File-as-module | Filename | High | Nimble package |
| Elm (§8.6) | Module declaration | Module path matches file path | Strict (file path = module path) | elm-lang.org package |
| F# (§8.7) | File + module/namespace | Project-file order + `module` declaration | Strict (project file authoritative) | NuGet package |
| Raku (§8.9) | Distribution + compunit | `Name:ver<X>:auth<Y>:api<Z>` 4-tuple in import syntax | Low (filename via META6 `provides` map) | fez/zef ecosystem with auth-validated 4-tuple identity |
| Perl 5 (§4.5) | Package (symbol table) | `package Foo;` declaration + filesystem path | Medium (path = `Foo/Bar.pm`) | CPAN distribution |
| Common Lisp (§4.6) | Package (symbol namespace) | `defpackage` declaration | Low | ASDF system + Quicklisp |
| Clojure (§4.7) | Namespace | `ns` macro declaration; runtime-mutable | Low-medium | deps.edn or Leiningen project + Clojars |
| Tcl (§4.8) | Namespace + package (orthogonal) | `namespace eval` for naming, `package provide` for distribution | Low (auto-path discovery via `pkgIndex.tcl`) | Tcl package with versioned `pkgIndex.tcl` |
| Forth (§8.10) | Wordlist | `WORDLIST` runtime token + search-order stack position | None (wordlists are runtime data) | Implementation-specific (no standard ecosystem) |
| Factor (§8.11) | Vocabulary | Dotted-name vocabulary + directory path | High (vocabulary = directory) | Vocab roots: core/basis/extra/work |
| Ada (§5.5) | Package | `package`/`package body` declaration; child packages form hierarchy | Medium (compilation-unit naming) | Build-system-defined (Alire ecosystem, GNAT project files) |
| Modula-2 / Modula-3 (§5.6) | DEFINITION/IMPLEMENTATION module pair | Module name in `DEFINITION MODULE` / `IMPLEMENTATION MODULE` | Medium-high | Implementation-specific |
| Oberon (§5.6) | Module with inline `*` export markers | `MODULE` declaration | High | Project-specific (Project Oberon) |
| D (§8.12) | Module | `module foo.bar;` declaration | High (module name = filesystem path) | DUB package + code.dlang.org |
| Lean 4 (§8.13) | Module + namespace | File path = module path; `namespace` declarations | High | Lake package + Mathlib + Reservoir |
| R (§8.14) | Package | DESCRIPTION manifest + NAMESPACE file | Medium-high | CRAN registry with strict review |
| Agda (§9.10) | Module (parameterized over dependent types) | `module M (...) where` declaration | Medium | Cabal/Stack ecosystem; agda-stdlib |
| Idris 2 (§9.10) | Module + interface | `module M` declaration | Medium | pack package manager |
| Wasm Component (§11.2) | Component artifact | WIT world declaration | None (binary artifact) | Distribution-format-independent |
| Deno (`PACKAGING.md §3.7`) | Module URL + content hash | HTTPS URL with version path; lockfile pins SHA-256 | None (URL-shaped) | No central registry; URL identity = distribution identity |
| Mojo (§8.16) | File-as-module | Filename + dotted package path | Medium-high | Compile-time-elaborated parametric IR shipped pre-instantiation |
| CUE (§8.17) | Directory-as-package on lattice | `cue.mod/module.cue` manifest + Go-style import path | Medium | CUE module proxy |
| Pkl (§8.19) | File-as-module + classes with amend-and-extend | URL-shaped `import "package://..."` with version pinning | Medium | pkl-lang.org package registry |
| Carbon (§9.12) | Library inside package | `package`/`library` declaration | Toolchain-managed | BUILD-file mapping; modules from day 1 |

### 12.2. Import semantics

| Language / system | Static syntax? | Import-time execution? | Runtime module instance? | Cycles | Notes |
|---|---|---|---|---|---|
| Rust (§3.1) | Yes | No in the Python/loader sense | Not the primary model | Strongly discouraged / structurally acyclic in practice | Import is mainly name and visibility control |
| Zig (§3.2) | Yes (`@import`) | No | Not the primary model | Static dependency style | Import yields a namespace-like value |
| Go (§3.3) | Yes | Limited package init, but not arbitrary import-body model like Python | Some runtime init semantics | Forbidden | Compiler/tooling-first DAG design |
| Odin (§3.4) | Yes | Minimal compared with scripting languages | Not the primary model | Simpler static package style | Package organization is the main story |
| Python (§4.1) | Yes | Yes | Yes, cached module object | Allowed, with partial initialization hazards | Import system is core runtime machinery |
| JavaScript ESM (§4.2) | Yes | Yes, via instantiation/evaluation | Yes | Allowed, with live-binding initialization semantics | Static syntax does not imply static semantics |
| Node CommonJS (§4.3) | Function-style `require` | Yes | Yes, cached export object | Allowed, loader-shaped | Much weaker static analyzability |
| OCaml (§5.1) | Yes | No runtime-import model in the scripting sense | Not primary | Generally structured through compilation units/interfaces | Module system is semantic and typed |
| Standard ML (§5.2) | Yes | No runtime-import model in the scripting sense | Not primary | Structured through signatures/functors | Classical typed-module model |
| Haskell (§5.3) | Yes | No scripting-style import execution | Not primary | More static/declarative than runtime systems | Export lists and qualification are central |
| Racket (§5.4) | Yes | Yes, but phase-aware and expander-governed | Yes, with instantiation/visit distinction | Phase-mediated | Import semantics are part of macro semantics |
| Java / JPMS (§6.1) | Yes | Static class load (no top-level body exec) | Class objects per loader | Forbidden across modules | Module reads-graph validated at compile/link/run |
| C# / .NET (§6.2) | Yes | No top-level body in the Python sense | Assemblies as runtime objects | Allowed at namespace level | Reference assemblies tracked at build time |
| Scala 3 (§6.3) | Yes | No scripting-style import execution | Not primary | Generally structural | Import scoping for `given` is explicit |
| Swift (§8.1) | Yes | No body execution at import | Module objects exist at runtime | Allowed | Library evolution mode emits stable interface artifacts |
| Erlang (§8.2) | Yes | No top-level body | Modules are runtime entities; reload-aware | Allowed (reload-friendly) | Two-version-active rule |
| Julia (§8.3) | Yes | Yes (module body executes) | Yes, cached | Allowed | Precompilation caches reduce first-load cost |
| Dart (§8.4) | Yes | Limited (top-level initializers run) | Library objects | Allowed | `deferred` imports for lazy loading |
| Nim (§8.5) | Yes | Limited (compile-time `static:` blocks) | Not primary | Allowed | Single-character `*` export marker |
| Elm (§8.6) | Yes | No (pure functional, no imperative top-level) | Not primary | **Forbidden at file level** | Strictest cycle prohibition in survey |
| F# (§8.7) | Yes | No top-level body in Python sense | Not primary | Forbidden by file ordering | Project-file order is authoritative |
| Raku (§8.9) | Yes | Limited (compile-time `use`/`need` vs runtime `require`) | Compunit objects | Allowed, repository-mediated | Three-way load/import split |
| Perl 5 (§4.5) | Yes | Yes (`use` is `BEGIN { require + import }`) | Package symbol table | Allowed | `use` is compile-time, `require` is runtime |
| Common Lisp (§4.6) | Yes | Yes (`defpackage` + `in-package` execute) | Yes — packages are first-class objects | Allowed (symbols can be forward-declared) | Symbol-table operations are runtime |
| Clojure (§4.7) | Yes (`ns` macro) | Yes (namespace bodies execute on `:require`) | Yes — runtime-mutable namespaces | Allowed | `:as-alias` defers loading |
| Tcl (§4.8) | Yes (`package require`) | Yes (registered scripts execute) | Packages tracked at runtime | Implementation-dependent | One version loaded per package name |
| Forth (§8.10) | No (imperative stack ops) | Yes (every `:` definition mutates the dictionary at execution time) | Wordlists are runtime data | Possible via shadowing | No separate compile/load distinction |
| Factor (§8.11) | Yes (`USING:`) | Vocabulary loading is compile-time | Vocabulary objects | Not the primary model | Ambiguous-use-error refuses to guess |
| Ada (§5.5) | Yes (`with`/`use`) | Limited (package elaboration controlled by pragmas) | Not primary | Allowed; ordering controlled by `pragma Elaborate_All` | Specification/body split is foundational |
| Modula-2 / Modula-3 (§5.6) | Yes (`FROM ... IMPORT`) | Module body executes once on first import | Module records exist at runtime | Allowed | DEFINITION/IMPLEMENTATION ancestor of `.mli`/`.ml` |
| Oberon (§5.6) | Yes (`IMPORT`) | Module body executes on first import | Not primary | Allowed | Inline `*` export marker per declaration |
| D (§8.12) | Yes (`import`) | Limited (`static this()` module ctors run at startup) | Not primary | Allowed | `version()` blocks for conditional compilation |
| Lean 4 (§8.13) | Yes (`import`) | Module elaboration is compile-time | Not primary | Allowed (forced acyclic in practice) | Imports affect typeclass instance scope |
| R (§8.14) | Yes (`library()`/`requireNamespace()`) | Yes (package onLoad hooks fire) | Yes — environments are first-class | Allowed | NAMESPACE file decouples export from S3/S4 dispatch |
| Agda (§9.10) | Yes (`open`, `import`) | Module bodies elaborate lazily | Not primary | Disallowed (acyclic) | Parameters can be dependent types |
| Idris 2 (§9.10) | Yes (`import`) | Module bodies elaborate at compile time | Not primary | Disallowed (acyclic) | Interfaces are records-of-functions |
| Wasm Component (§11.2) | Yes (WIT) | No (component instantiation, not body exec) | Component instances per host | Generally not — explicit world | Capability handles passed at instantiation |
| Deno (`PACKAGING.md §3.7`) | Yes (ESM) | Yes (ESM evaluation) | Module records per host | Allowed (ESM live-binding) | URL-shaped imports, content-hashed lockfile |
| Mojo (§8.16) | Yes (`from foo import bar`) | No (no module-body exec at import time) | Compile-time namespace | Disallowed in practice | Compile-time elaboration over imports |
| Carbon (§9.12) | Yes (`import Foo library "Bar"`) | No (compile-time only) | Not primary | Forbidden across libraries / packages | API/impl file split with explicit `api` markers |
| Haxe (§8.18) | Yes (`package`) | No body exec at import | Not primary | Allowed | `#if` target-conditional imports across multi-target std library |

### 12.3. Visibility and export models

| Language / system | Export model | Visibility granularity | Re-exports | Key trade-off |
|---|---|---|---|---|
| Rust (§3.1) | Explicit `pub` family | Fine-grained (`pub`, `pub(crate)`, `pub(super)`, `pub(in)`) | Strong | Powerful API shaping, more complexity |
| Zig (§3.2) | `pub` declarations | Simple public/private | Moderate via namespace re-exposure | Low magic, less expressive visibility lattice |
| Go (§3.3) | Capitalization convention | Package-private vs exported | Limited compared with Rust | Very simple, but naming-driven |
| Odin (§3.4) | Package-oriented, lower ceremony | Simpler than Rust | Limited / ecosystem-convention shaped | Easy to read, fewer expressive controls |
| Python (§4.1) | Mostly public-by-default with conventions | Convention-heavy | Trivial via rebinding/import patterns | Flexible, weak encapsulation |
| JavaScript ESM (§4.2) | Explicit `export` | Module-level | Strong | Good static surface control, runtime complexity remains |
| Node CommonJS (§4.3) | Mutable `module.exports` | Module object shaped by code | Trivial | Flexible but weakly structured |
| OCaml (§5.1) | Public-by-default unless constrained by `.mli` | Interface-file-based | Possible | Strong abstraction with explicit interfaces |
| Standard ML (§5.2) | Signature-controlled | Strong interface discipline | Possible | Abstraction power at high conceptual cost |
| Haskell (§5.3) | Explicit export lists | Module-level | Moderate | Good source-level API curation |
| Racket (§5.4) | `provide` forms | Module and phase aware | Strong | Powerful and precise, but phase complexity |
| Java / JPMS (§6.1) | `exports`, `exports ... to` | Package-level via module-info | Indirectly via re-exports of imported packages | Friend-export (`exports ... to`) is rare elsewhere |
| C# / .NET (§6.2) | `public`/`internal`/`protected` family + `InternalsVisibleTo` | Assembly-level boundary | Indirect via `TypeForwardedTo` | Friend assemblies are the canonical pattern |
| Scala 3 (§6.3) | Modifier keywords + `export` clauses | Package + access modifiers | First-class `export` | Re-exports as a language feature |
| Swift (§8.1) | `open`/`public`/`package`/`internal`/`fileprivate`/`private` | Six-level lattice | Strong | `package` level was a late addition |
| Erlang (§8.2) | `-export([func/arity, ...])` | Per-function arity granularity | Limited | Function-arity-pair is the export atom |
| Elixir (§8.2) | `def`/`defp` | Per-function | Limited | Macro-level `defmacro`/`defmacrop` distinction |
| Julia (§8.3) | `export` lists | Module-level | Possible | Privacy is convention only |
| Dart (§8.4) | Underscore-prefix privacy | Library-level (not file-level) | `export` directive | `_foo` is private to the library |
| Nim (§8.5) | `*` export marker | Per-declaration | `export` keyword | Most concise export marking in survey |
| Elm (§8.6) | `exposing (...)` list | Module-level | Possible | Type constructor exposing controls opaqueness |
| F# (§8.7) | Access modifiers + `[<AutoOpen>]` | Module-level + namespace | Possible | `AutoOpen` for ambient helpers |
| Raku (§8.9) | `is export` trait + tags | Per-declaration with optional tag groups | Possible via re-export | Multi-distribution coexistence by `:auth` |
| Perl 5 (§4.5) | Convention (`@EXPORT`/`@EXPORT_OK` via Exporter module) | Per-symbol | Trivial via rebinding | No language-enforced visibility |
| Common Lisp (§4.6) | `(:export ...)` in `defpackage` + `:shadow`/`:shadowing-import-from` | Per-symbol with explicit shadowing | Possible (re-import + re-export) | Six-relationship lattice — richest in survey |
| Clojure (§4.7) | Convention (private Vars use `defn-`/`defprivate-`) | Per-Var, runtime-checkable | Trivial (Vars are first-class) | First-class namespace introspection |
| Tcl (§4.8) | `namespace export` (advisory) | Namespace-level | Possible | Convention-driven, not language-enforced |
| Forth (§8.10) | Per-wordlist visibility via search-order position | Per-wordlist | Manual (push wordlist to search order) | Stack-managed visibility |
| Factor (§8.11) | All public within vocabulary | Vocabulary-level (no per-word privacy) | Strong via `EXCLUDE:` / `RENAME:` / `FROM:` | Ambiguous-use-error on conflict |
| Ada (§5.5) | Specification declares public; `private` part for opacity | Per-package + child-package privileges | Possible via re-export | Private child packages for fine-grained scoping |
| Modula-2 / Modula-3 (§5.6) | DEFINITION declares public surface | Module-level | Limited | Opaque types matched across the spec/body boundary |
| Oberon (§5.6) | Inline `*` (read-only) and `-` (read-write) markers | Per-declaration | Possible | Single-character markers per public symbol |
| D (§8.12) | `private`/`package`/`protected`/`public`/`export` | Five-level lattice | `public import` for re-export | `export` distinguishes binary-export visibility |
| Lean 4 (§8.13) | Public-by-default; `private` for module-local | Module-level + section-level | Strong via `export` clause | Imports affect instance resolution scope |
| R (§8.14) | NAMESPACE file `export()`/`exportPattern()` | Package-level | Possible (with care for S3/S4 dispatch) | Method registration decoupled from export |
| Agda (§9.10) | Public-by-default; `private` block for module-local | Module-level | `open public` for re-export | Records and modules are unified |
| Idris 2 (§9.10) | Access modifiers on declarations | Per-declaration | Possible | Interfaces add typeclass-style dispatch |
| Wasm Component (§11.2) | WIT `interface` declarations | Component boundary | Worlds compose interfaces | Typed at the binary boundary |
| Deno (`PACKAGING.md §3.7`) | Explicit `export` (ESM) | Module-level | First-class re-exports | URL identity bundles distribution + visibility |
| Mojo (§8.16) | Convention plus `fn`/`struct` modifiers | Module-level | Possible | Imports do not run module bodies |
| Carbon (§9.12) | Explicit `api` modifier per declaration | Per-declaration in API file | Possible via re-export | API/impl file split enforces interface-first design |

### 12.4. Typed and phase-aware abstraction power

| Language / system | Typed module interfaces? | Parameterized modules? | Phase-aware imports? | Distinctive strength |
|---|---|---|---|---|
| Rust (§3.1) | Not in the ML sense | No higher-order module system | Limited via proc-macro separation, not phase tower | Strong visibility and crate layering |
| Zig (§3.2) | No | No | No | Extremely explicit static imports |
| Go (§3.3) | No | No | No | Compiler-friendly package DAG |
| Python (§4.1) | No | No | No | Runtime flexibility, loader extensibility |
| JavaScript ESM (§4.2) | No | No | No | Live bindings with static syntax |
| OCaml (§5.1) | Yes (signatures) | Yes (functors) | No phase tower like Racket | Production typed module calculus |
| Standard ML (§5.2) | Yes | Yes | No | Classical module calculus |
| Haskell (§5.3) | Weaker than ML signatures/functors | Not in the same sense | No | Export/qualification discipline without full higher-order modules |
| Racket (§5.4) | Module contracts and language tooling, not ML signatures | Not the same abstraction style | Yes | Modules as macro- and language-phase boundaries |
| 1ML (research) (§9.2) | Yes (signatures = types) | Yes, as ordinary functions | No phase tower | Unifies module language with core language |
| Backpack (Haskell) (§9.4) | Yes (mixin-style holes) | Indefinite-module instantiation | No | Mixin linking at the package layer |
| MixML (research) (§9.5) | Yes (mixin signatures) | Yes (mixin merging) | No | Type-safe recursive cross-module dependency |
| Newspeak (§9.6) | Yes (top-level class declarations) | Yes (top-level class is a parameterized module) | No | Modules as parameterized objects, no globals |
| R6RS Scheme libraries (§9.9) | No types (untyped) | No (declarative imports only) | Yes (R6RS phasing via `for` annotations) | Canonical `only`/`except`/`prefix`/`rename` import refinements |
| R7RS Scheme `define-library` (§9.9) | No types (untyped) | No | No (R7RS dropped phasing) | Pragmatic simplification of R6RS plus `cond-expand` |
| Ada generic packages (§5.5, §9.1) | Yes (specification = signature) | Yes (generic instantiation) | No | Production typed module system since 1980 |
| Modula-2 / Modula-3 (§5.6) | Yes (DEFINITION = signature) | Modula-3 generic interfaces | No | Direct ancestor of OCaml `.mli`/`.ml` |
| Agda (§9.10) | Yes (record types as module signatures) | Yes (with dependent type parameters) | No | Modules collapse into records under dependent types |
| Idris 2 (§9.10) | Yes (interface declarations) | Yes (parametric over types and values) | No | Interfaces dispatch via search resolution |
| Wasm Component (§11.2) | Yes (WIT worlds) | Worlds compose imports/exports | No | Typed module interfaces at the binary boundary |

### 12.5. Packaging, identity, and resolution

Subsumed by the identity column of §12.1 and the prose treatment in `PACKAGING.md §3` (Packages, Identity, and Resolution) and `PACKAGING.md §4` (Build Systems, Workspaces, Lockfiles, and Registries). Refer to §12.1 for module identity sources at a glance, `PACKAGING.md §3.1`–`PACKAGING.md §3.7` for the per-language packaging postures, and `PACKAGING.md §4.1`–`PACKAGING.md §4.7` for lockfiles, workspaces, registries, and build-system layering.

### 12.6. Tooling friendliness

| Language / system | Static graph quality | Resolution determinism | Incremental-friendly? | Main tooling pain |
|---|---|---|---|---|
| Rust (§3.1) | High | High | High | Re-export-heavy APIs can complicate surface tracking |
| Zig (§3.2) | High | High | High | Build-context coupling must stay explicit |
| Go (§3.3) | Very high | High | Very high | Architectural rigidity from no-cycle rule |
| Odin (§3.4) | High | High | High in principle | Less formal specification than Rust/Go |
| Python (§4.1) | Lower | Medium | Harder | Import-time execution and environment-shaped resolution |
| JavaScript ESM (§4.2) | Medium-high | Medium | Moderate | Runtime host resolution and cyclic initialization semantics |
| Node CommonJS (§4.3) | Lower | Medium | Harder | Dynamic `require` patterns and mutable exports |
| OCaml (§5.1) | High | High | High | More conceptual complexity for users |
| Haskell (§5.3) | High | High | High | Package/build layering can be nontrivial |
| Racket (§5.4) | Medium | Medium-high | Depends on phase/tooling support | Phase complexity |
| Java / JPMS (§6.1) | High | High | High | JPMS adoption gap; classpath fallback fragments tooling |
| C# / .NET (§6.2) | High | High | High | Reflection-heavy frameworks weaken encapsulation guarantees |
| Swift (§8.1) | High | High | High | Library Evolution mode requires explicit annotations |
| Erlang (§8.2) | High | High | High (per-module reload) | Flat namespace scales via convention |
| Julia (§8.3) | Medium-high | High | High with precompilation | First-load latency before pkgimage cache |
| Elm (§8.6) | Very high | Very high | Very high | Strict file-cycle ban can frustrate prototyping |
| F# (§8.7) | Very high | Very high | Very high | Project-file ordering ergonomics |
| Wasm Component (§11.2) | High (typed binary) | High | High | Tooling for WIT is still maturing |

### 12.7. Visibility and scoping comparison

Merged into §12.3 (Visibility and export models), which covers the same ground with per-language granularity. The distilled mechanism categories — default-private with explicit markers, capitalization-driven, underscore-prefix, interface-file restriction, friend mechanisms, build-tool visibility, multi-level lattices — are recoverable from the §12.3 rows by the "Export model" and "Visibility granularity" columns.

### 12.8. Cycle policy

| Policy | Languages | Trade-off |
|---|---|---|
| Forbidden across files | Elm, F# (via project ordering) | Strictest; forces architectural decomposition early |
| Forbidden across packages | Go | Forces interface-style indirection |
| Tolerated with partial-init semantics | Python (mid-init module visibility), JS ESM (live bindings), CommonJS (whatever `module.exports` has populated) | Flexible but error-prone |
| Tolerated with structured mediation | OCaml/SML (signatures, functors), Backpack | Cycles broken via parameterization |
| Discouraged but not forbidden | Rust (intra-crate, in practice rare) | Pragmatic middle ground |
| Per-module reload tolerates two-version cycles | Erlang | Cycles must respect reload semantics |

### 12.9. Design option matrix

Subsumed by §13 (open-design questions) and §14 (closing synthesis). See those sections for the recurring decision points and the cross-cutting reading of the design space.

---

## 13. Open Design Questions

These are the recurring decision points a module-system designer faces. Each summarizes a trade-off explored at length earlier; the canonical chapters do the work.

- **§13.1. Is a module a file, a directory, or a declared unit?** File-based, directory-based, declared-based, or hybrid; the right answer depends on how authoritative the filesystem should be (see §2.1, §12.1).
- **§13.2. Are imports static dependency edges, or runtime events?** Forbidding import-time execution buys static graphs, simple cycles, and easy tooling; allowing it buys plugin extension at high cost (see §2.3, §3, §4, §12.2).
- **§13.3. Are exports explicit, public-by-default, or convention-driven?** Explicit exports support refactoring; public-by-default is convenient but accumulates accidental API; convention-driven sits between (see §2.4, §12.3).
- **§13.4. Are cycles forbidden, tolerated, or structured?** Hard prohibition, partial-init tolerance, or structured mediation through signatures/functors — see §2.5, §3.3, §12.8 for the taxonomy.
- **§13.5. Are package identity and module identity the same?** Tight coupling vs separation vs loose coupling; see §2.6, `PACKAGING.md §3.1`–`PACKAGING.md §3.6`, and the identity column of §12.1.
- **§13.6. Does package metadata participate in resolution?** Loader-shaped resolution (Node) vs purely installation metadata (Cargo, Go); see `PACKAGING.md §3.4` and `PACKAGING.md §3.6` for the prose treatment, and §12.1 for the identity column.
- **§13.7. Are runtime modules first-class objects, or only compile-time abstractions?** Runtime module objects enable hot reload and reflection; compile-time-only modules keep the runtime cheap (see §2.8, §12.2).
- **§13.8. Should phase-aware macro/module separation be designed in?** Designing phases in from day one (Racket §5.4) or deferring while avoiding phase-fusing early choices.
- **§13.9. How are dynamic loading and hot reload supported?** Flat-module two-version-active (§8.2), class-loader hierarchies (§10.2), or accept-callback HMR (§10.6) — all require early language-level cooperation.
- **§13.10. Is the artifact boundary the module boundary?** Java module/JAR, .NET assembly, Swift framework, Wasm component all make the artifact the encapsulation unit (see §11).
- **§13.11. How is reflection accommodated?** Permitted, restricted, or first-class — JPMS `opens`, .NET reflection, Wasm resource handles each take a different position (see §6.5, §11.3).

---

## 14. Closing Synthesis

The design space splits into static graph systems (chapter 3), runtime import systems (chapter 4), typed or phase-aware abstraction systems (chapters 5, 9), JVM/.NET retrofits (chapter 6), C/C++ headers and modules (chapter 7), additional production languages (chapter 8), runtime/dynamic/capability-scoped modules (chapters 10, 11), and the packaging-and-distribution layer treated separately in `PACKAGING.md §3` and `PACKAGING.md §4`.

Across these families, a small set of decisions does most of the load-bearing work, and the rest of the design surface tends to follow from them. The first is **whether imports are static dependency edges or runtime events** (§2.3, §13.2). Refusing import-time execution by default is the single most consequential lever: it sharply simplifies the compile graph, the cycle story, the tooling story, and the initialization-order story all at once. Allowing it buys plugin-style extension and dynamic metaprogramming surfaces, but every later decision (cycles, hot reload, IDE indexing, reproducibility) becomes harder. Python, ESM, and CommonJS show how much complexity propagates from this one choice.

The second is **where the artifact boundary sits relative to the typed module boundary** (§11, §13.10). Rust's source-level distribution, Java's JAR-as-module, .NET's assembly, Swift's framework with Library Evolution, and the Wasm Component Model with WIT all answer this differently. When the artifact boundary is also the typed interface boundary, capability scoping (§11.3, `MEMORY.md §10`) and resilient ABI evolution (§8.1) become natural; when artifacts are merely byproducts of source builds, both have to be reinvented in tooling.

The third is **the lockfile and content-hash convergence** (`PACKAGING.md §4.1`). Modern ecosystems are converging on content-addressed lockfiles whether the underlying registry is centralized (Cargo, Hex), URL-shaped (Go), or hermetic (Nix, Guix). A new package manager that ships without one will be retrofitting it within a few years; the only real choice is whether reproducibility lives at the lockfile layer or all the way down in the build derivation.

The fourth is **how reflective and ocap concerns shape the rest** (§6.5, §11.3, §13.11). A module system that decides early whether reflection is permitted, restricted, or first-class — and whether ambient authority crosses module boundaries — gets capability-scoped modules and disciplined frameworks for free. A system that defers the question accumulates `opens`-style escape hatches (JPMS), `InternalsVisibleTo` patches (.NET), and reflection-permission frameworks that the original module design did not anticipate.

A defensible baseline leans toward the static-graph family for source-level semantics and Rust-style layered package/module identity for the packaging concern; runtime, dynamic-loading, and capability-scoped properties can be added later if early choices do not foreclose them (flat identity preserves hot reload; typed interfaces preserve capability scoping; explicit visibility preserves artifact-boundary encapsulation).

The strongest cross-cutting lesson is that module-system retrofits are uniformly painful (JPMS, C++20, Python's import patches, the CJS/ESM reconciliation). Committing to a module system from version 1 — even a simple one — with the right invariants (static graph, explicit exports, deterministic resolution, layered package identity) makes later additions extensions rather than rewrites.

---

## 15. References

References are grouped by the chapter that first cites them. Within each chapter they roughly follow subsection order.

### Chapter 3 — Static Compile-Time Graph Systems

1. Rust Reference — Modules — https://doc.rust-lang.org/reference/items/modules.html
2. Rust Reference — Visibility and Privacy — https://doc.rust-lang.org/reference/visibility-and-privacy.html
3. Cargo manifest reference — https://doc.rust-lang.org/cargo/reference/manifest.html
4. Rust 2018 path changes — https://doc.rust-lang.org/edition-guide/rust-2018/path-changes.html
5. Zig language reference — `@import` builtin — https://ziglang.org/documentation/master/#import
6. Zig build-system tutorial — https://ziglang.org/learn/build-system/
7. Zig language reference — Packages — https://ziglang.org/documentation/master/#Packages
8. Go language specification — Packages — https://go.dev/ref/spec#Packages
9. Go module reference — https://go.dev/ref/mod
10. Go blog — Package names — https://go.dev/blog/package-names
10b. Russ Cox — Semantic import versioning — https://research.swtch.com/vgo-import
11. Odin overview — Packages and Imports — https://odin-lang.org/docs/overview/#packages
12. Odin overview — Import statements — https://odin-lang.org/docs/overview/#import-statements

### Chapter 4 — Runtime Import Systems

1. Python Reference — The import system — https://docs.python.org/3/reference/import.html
2. PEP 328 — Imports: Multi-Line and Absolute/Relative — https://peps.python.org/pep-0328/
3. PEP 420 — Implicit Namespace Packages — https://peps.python.org/pep-0420/
4. CPython `importlib` — https://docs.python.org/3/library/importlib.html
5. ECMAScript — Modules — https://tc39.es/ecma262/#sec-modules
6. Node.js ESM documentation — https://nodejs.org/api/esm.html
7. HTML Standard — Module system integration — https://html.spec.whatwg.org/multipage/webappapis.html#module-system
8. Lin Clark — ES modules: A cartoon deep-dive — https://hacks.mozilla.org/2018/03/es-modules-a-cartoon-deep-dive/
9. Node.js Modules: CommonJS — https://nodejs.org/api/modules.html
10. Node.js Packages — https://nodejs.org/api/packages.html
11. Ruby `Kernel#require` — https://docs.ruby-lang.org/en/master/Kernel.html#method-i-require
12. Lua 5.4 manual — Modules and `require` — https://www.lua.org/manual/5.4/manual.html#6.3
13. Programming in Lua — Modules and Packages — https://www.lua.org/pil/8.html
14. Perl 5 — `use` documentation — https://perldoc.perl.org/functions/use
15. Perl 5 — `require` documentation — https://perldoc.perl.org/functions/require
16. Perl 5 — Exporter module — https://perldoc.perl.org/Exporter
17. Perl 5 — perlmod — https://perldoc.perl.org/perlmod
18. Common Lisp — `defpackage` macro (CLHS) — https://www.lispworks.com/documentation/HyperSpec/Body/m_defpkg.htm
19. Common Lisp — `export` function (CLHS) — https://www.lispworks.com/documentation/HyperSpec/Body/f_export.htm
20. Common Lisp packages tutorial — https://lisp-docs.github.io/docs/tutorial/packages
21. ASDF — Another System Definition Facility — https://asdf.common-lisp.dev/
22. Clojure — Namespaces reference — https://clojure.org/reference/namespaces
23. Clojure — `ns` macro docs — https://clojuredocs.org/clojure.core/ns
24. Clojure — `require` docs — https://clojuredocs.org/clojure.core/require
25. Clojure-doc — Namespaces guide — https://clojure-doc.org/articles/language/namespaces/
26. Tcl — `package` manual page — https://www.tcl-lang.org/man/tcl8.6/TclCmd/package.htm
27. Tcl — `namespace` manual page — https://www.tcl-lang.org/man/tcl8.6/TclCmd/namespace.htm
28. Tcl wiki — `package ifneeded` — https://wiki.tcl-lang.org/page/package+ifneeded

### Chapter 5 — Typed and Phase-Aware Module Systems

1. OCaml Manual — Module examples — https://v2.ocaml.org/manual/moduleexamples.html
2. Real World OCaml — Files, Modules, and Programs — https://dev.realworldocaml.org/files-modules-and-programs.html
3. Real World OCaml — Functors — https://dev.realworldocaml.org/functors.html
4. Robert Harper — Programming in Standard ML — https://www.cs.cmu.edu/~rwh/isml/book.pdf
5. Haskell 2010 Report — Chapter 5: Modules — https://www.haskell.org/onlinereport/haskell2010/haskellch5.html
6. Cabal package documentation — https://cabal.readthedocs.io/en/stable/cabal-package.html
7. GHC user guide — Packages — https://downloads.haskell.org/~ghc/latest/docs/users_guide/packages.html
8. Racket Reference — Modules — https://docs.racket-lang.org/reference/Modules.html
9. Racket Guide — Module Paths — https://docs.racket-lang.org/guide/module-paths.html
10. Racket Guide — Module Phases — https://docs.racket-lang.org/guide/phases.html
11. Racket Guide — `#lang` reader — https://docs.racket-lang.org/guide/hash-lang_reader.html
12. Ada Reference Manual — Packages — http://www.ada-auth.org/standards/22rm/html/RM-7.html
13. Ada Reference Manual — Program Structure and Compilation Issues — http://www.ada-auth.org/standards/22rm/html/RM-10.html
14. Ada Reference Manual — Generic Units — http://www.ada-auth.org/standards/22rm/html/RM-12.html
15. Learn Ada — Modular programming — https://learn.adacore.com/courses/intro-to-ada/chapters/modular_programming.html
16. Modula-2 Reference — https://www.modula2.org/reference/
17. Modula-3 Language Definition — https://www.cs.purdue.edu/homes/hosking/m3/reference/syntax.html
18. Project Oberon — http://www.projectoberon.com/
19. Wikipedia — Oberon (programming language) — https://en.wikipedia.org/wiki/Oberon_(programming_language)

### Chapter 6 — JVM and .NET Module Systems

1. Project Jigsaw specification — https://openjdk.org/projects/jigsaw/spec/
2. JEP 261: Module System — https://openjdk.org/jeps/261
3. Oracle — Understanding Java 9 Modules — https://www.oracle.com/corporate/features/understanding-java-9-modules.html
4. dev.java — Modules tutorial — https://dev.java/learn/modules/
5. Microsoft Learn — Namespaces (C# Programming Guide) — https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/namespaces/
6. Microsoft Learn — .NET assemblies — https://learn.microsoft.com/en-us/dotnet/standard/assembly/
7. Microsoft Learn — `InternalsVisibleToAttribute` — https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.internalsvisibletoattribute
8. Microsoft Learn — `internal` access modifier — https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/internal
9. Scala 3 — Imports (changed features) — https://docs.scala-lang.org/scala3/reference/changed-features/imports.html
10. Scala 3 — Export clauses — https://docs.scala-lang.org/scala3/reference/other-new-features/export.html
11. Scala 3 Book — Packaging and Imports — https://docs.scala-lang.org/scala3/book/packaging-imports.html
12. Kotlin — Visibility modifiers — https://kotlinlang.org/docs/visibility-modifiers.html
13. Kotlin — Packages and imports — https://kotlinlang.org/docs/packages.html
14. Kotlin Multiplatform — https://kotlinlang.org/docs/multiplatform.html

### Chapter 7 — Headers, Translation Units, and C++20 Modules

1. cppreference — `#include` directive — https://en.cppreference.com/w/cpp/preprocessor/include
2. GCC C preprocessor manual — https://gcc.gnu.org/onlinedocs/cpp/
3. include-what-you-use — https://github.com/include-what-you-use/include-what-you-use
4. cppreference — Modules (C++20) — https://en.cppreference.com/w/cpp/language/modules
5. P1103R3 — Merging Modules — https://isocpp.org/files/papers/P1103R3.pdf
6. Microsoft Learn — Overview of modules in C++ — https://learn.microsoft.com/en-us/cpp/cpp/modules-cpp
7. GCC wiki — C++ modules — https://gcc.gnu.org/wiki/cxx-modules
8. Clang — Standard C++ Modules — https://clang.llvm.org/docs/StandardCPlusPlusModules.html

### Chapter 8 — Modules in Additional Production Languages

1. Swift Programming Language — Access Control — https://docs.swift.org/swift-book/documentation/the-swift-programming-language/accesscontrol
2. SE-0386 — `package` access modifier — https://github.com/swiftlang/swift-evolution/blob/main/proposals/0386-package-access-modifier.md
3. Swift — Library Evolution — https://github.com/swiftlang/swift/blob/main/docs/LibraryEvolution.rst
4. Swift Package Manager documentation — https://www.swift.org/documentation/package-manager/
5. Erlang — Code loading — https://www.erlang.org/doc/system/code_loading.html
6. Erlang — Applications design principles — https://www.erlang.org/doc/design_principles/applications.html
7. Elixir — `Kernel.defmodule/2` — https://hexdocs.pm/elixir/Kernel.html#defmodule/2
8. Mix build tool — https://hexdocs.pm/mix/Mix.html
8b. Gleam programming language — https://gleam.run/
9. Julia Manual — Modules — https://docs.julialang.org/en/v1/manual/modules/
10. Julia Manual — Code loading — https://docs.julialang.org/en/v1/manual/code-loading/
11. Julia 1.9 highlights (precompilation) — https://julialang.org/blog/2023/04/julia-1.9-highlights/
12. Dart — Libraries and visibility — https://dart.dev/language/libraries
13. Dart — Package dependencies — https://dart.dev/tools/pub/dependencies
14. Dart — `part` and `part of` — https://dart.dev/language/built-in-types#part-and-part-of
15. Nim manual — Modules — https://nim-lang.org/docs/manual.html#modules
16. Nimble package directory — https://nimble.directory/
17. Nim manual — Export marker — https://nim-lang.org/docs/manual.html#modules-export-marker
18. Elm style guide — https://elm-lang.org/docs/style-guide
19. Elm package design guidelines — https://package.elm-lang.org/help/design-guidelines
20. Elm syntax — Modules — https://elm-lang.org/docs/syntax#modules
21. F# — Modules — https://learn.microsoft.com/en-us/dotnet/fsharp/language-reference/modules
22. F# — Namespaces — https://learn.microsoft.com/en-us/dotnet/fsharp/language-reference/namespaces
23. F# — Component design guidelines — https://learn.microsoft.com/en-us/dotnet/fsharp/style-guide/component-design-guidelines
24. Crystal — Requiring files — https://crystal-lang.org/reference/syntax_and_semantics/requiring_files.html
25. Pony — Packages — https://tutorial.ponylang.io/packages/
26. Raku — Modules — https://docs.raku.org/language/modules
27. Raku — Distributions: configuration and structure — https://docs.raku.org/language/distributions/configuration-structure
28. Raku — Compilation and module loading — https://docs.raku.org/language/compilation
29. zef package installer — https://github.com/ugexe/zef
30. fez/zef ecosystem and auth — https://deathbyperl6.com/fez-zef-a-raku-ecosystem-and-auth/
31. Forth-2012 — Search-Order word set — https://forth-standard.org/standard/search
32. Gforth manual — Word Lists — https://gforth.org/manual/Word-Lists.html
33. Gforth manual — Wordlists and Search Order Tutorial — https://gforth.org/manual/Wordlists-and-Search-Order-Tutorial.html
34. Gforth manual — Why use word lists? — https://www.complang.tuwien.ac.at/forth/gforth/Docs-html-history/0.6.2/Why-use-word-lists-.html
35. Factor — Vocabularies tour — https://docs.factorcode.org/content/article-tour-vocabularies.html
36. Factor — Vocabulary loader — https://docs.factorcode.org/content/article-vocabs.loader.html
37. Factor — Vocabulary roots — https://docs.factorcode.org/content/article-vocabs.roots.html
38. Factor — `USE:` syntax — https://docs.factorcode.org/content/word-USE__colon__%2Csyntax.html
39. D Language — Modules specification — https://dlang.org/spec/module.html
40. D Language — Visibility attributes — https://dlang.org/spec/attribute.html#visibility_attributes
41. D Language — Conditional compilation (`version`) — https://dlang.org/spec/version.html
42. DUB package manager — https://dub.pm/
43. Lean 4 — Setting up Lean — https://lean-lang.org/lean4/doc/setup.html
44. Theorem Proving in Lean 4 — Interacting with Lean — https://lean-lang.org/theorem_proving_in_lean4/interacting_with_lean.html
45. Lean 4 — What's new — https://lean-lang.org/lean4/doc/whatsnew.html
46. Lean Community / Mathlib — https://leanprover-community.github.io/
47. R — Writing R Extensions: Package namespaces — https://cran.r-project.org/doc/manuals/r-release/R-exts.html#Package-namespaces
48. R Packages (Wickham & Bryan) — Namespace chapter — https://r-pkgs.org/namespace.html
49. CRAN Repository Policy — https://cran.r-project.org/web/packages/policies.html
50. Mojo packages manual — https://docs.modular.com/mojo/manual/packages/
51. Mojo structs manual — https://docs.modular.com/mojo/manual/structs/
52. Mojo parameters / parametric types — https://docs.modular.com/mojo/manual/parameters/
53. CUE language documentation — https://cuelang.org/docs/introduction/
54. CUE language home — https://cuelang.org/
55. CUE repository — https://github.com/cue-lang/cue
56. Haxe Manual — Introduction — https://haxe.org/manual/introduction.html
57. Haxe language home — https://haxe.org/
58. Haxe repository — https://github.com/HaxeFoundation/haxe
59. Haxelib package directory — https://lib.haxe.org/
60. Pkl language home — https://pkl-lang.org/index.html
61. Pkl repository — https://github.com/apple/pkl
62. Introducing Pkl — Apple Open Source — https://pkl-lang.org/blog/introducing-pkl.html

### Chapter 9 — Research and Advanced Module Calculi

1. SML97 Definition (revised) — https://smlfamily.github.io/sml97-defn.pdf
2. Robert Harper — Programming in Standard ML — http://www.cs.cmu.edu/~rwh/smlbook/book.pdf
3. David MacQueen — Modules for SML — https://homepages.inf.ed.ac.uk/dts/fps/papers/MacQueen.pdf
4. Andreas Rossberg — 1ML (ICFP 2015) — https://people.mpi-sws.org/~rossberg/1ml/1ml.pdf
5. Andreas Rossberg homepage — https://people.mpi-sws.org/~rossberg/
6. White, Bour, Yallop — Modular Implicits — https://arxiv.org/abs/1512.01895
7. Jeremy Yallop — Modular implicits paper (PDF) — https://www.cl.cam.ac.uk/~jdy22/papers/modular-implicits.pdf
8. Leo White homepage — https://www.lpw25.net/
9. Backpack POPL 2014 — https://plv.mpi-sws.org/backpack/backpack-popl.pdf
10. GHC wiki — Backpack — https://gitlab.haskell.org/ghc/ghc/-/wikis/backpack
11. Haskell wiki — Backpack — https://wiki.haskell.org/Backpack
12. Dreyer & Rossberg — MixML (ICFP 2008) — https://people.mpi-sws.org/~dreyer/papers/mixml/icfp08.pdf
13. Derek Dreyer homepage — https://www.mpi-sws.org/~dreyer/
14. Newspeak language — https://newspeaklanguage.org/
15. Bracha — The Newspeak Programming Platform — https://bracha.org/newspeak.pdf
16. Bracha — Newspeak modules — https://bracha.org/newspeak-modules.pdf
17. OCaml — Applicative functors — https://v2.ocaml.org/manual/moduleexamples.html#s:applicative-functors
18. Derek Dreyer thesis — https://people.mpi-sws.org/~dreyer/papers/dreyer/thesis.pdf
19. OCaml — First-class modules — https://v2.ocaml.org/manual/firstclassmodules.html
20. Real World OCaml — First-Class Modules — https://dev.realworldocaml.org/first-class-modules.html
21. R6RS — Libraries (Chapter 7) — https://www.r6rs.org/final/html/r6rs/r6rs-Z-H-10.html
22. R7RS small — `define-library` (PDF) — https://small.r7rs.org/attachment/r7rs.pdf
23. R7RS corrected — Program structure (libraries) — https://standards.scheme.org/corrected-r7rs/r7rs-Z-H-7.html
24. R7RS corrected — Notes on R6RS compatibility — https://standards.scheme.org/corrected-r7rs/r7rs-Z-H-12.html
25. Agda — Module system — https://agda.readthedocs.io/en/latest/language/module-system.html
26. Agda — Record types — https://agda.readthedocs.io/en/latest/language/record-types.html
27. Idris 2 — Modules and namespaces — https://idris2.readthedocs.io/en/latest/tutorial/modules.html
28. Idris 2 — Interfaces — https://idris2.readthedocs.io/en/latest/tutorial/interfaces.html
29. Carbon module design — https://github.com/carbon-language/carbon-lang/blob/trunk/docs/design/modules.md
30. Carbon language repository — https://github.com/carbon-language/carbon-lang
31. Carbon — code and name organization — https://github.com/carbon-language/carbon-lang/blob/trunk/docs/design/code_and_name_organization/README.md

### Chapter 10 — Dynamic Loading, Plugins, and Hot Module Replacement

1. POSIX `dlopen(3)` — https://man7.org/linux/man-pages/man3/dlopen.3.html
2. Microsoft Learn — `LoadLibraryA` — https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibrarya
3. Java class loading and threads — https://docs.oracle.com/javase/8/docs/technotes/guides/lang/cl-mt.html
4. OSGi Alliance — Architecture — https://www.osgi.org/resources/architecture/
5. .NET Core — Understanding `AssemblyLoadContext` — https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext
6. CPython `importlib.reload` — https://docs.python.org/3/library/importlib.html#importlib.reload
7. Python Packaging — Entry points — https://packaging.python.org/en/latest/specifications/entry-points/
8. HTML Standard — Module system integration — https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-module-system
9. Webpack — Module Federation — https://webpack.js.org/concepts/module-federation/
10. Vite — Hot Module Replacement — https://vitejs.dev/guide/features.html#hot-module-replacement
11. Webpack — HMR concept — https://webpack.js.org/concepts/hot-module-replacement/
12. MDN — Modules and HMR — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules#hot_module_replacement

### Chapter 11 — Wasm Component Model and Capability-Scoped Modules

1. WebAssembly Specification — Modules — https://webassembly.github.io/spec/core/syntax/modules.html
2. WebAssembly Specs index — https://webassembly.org/specs/
3. WebAssembly Component Model — https://github.com/WebAssembly/component-model
4. Bytecode Alliance — Component Model book — https://component-model.bytecodealliance.org/
5. WASI repository — https://github.com/WebAssembly/WASI
6. WASI proposals — https://github.com/WebAssembly/WASI/blob/main/Proposals.md
7. WASI roadmap (0.3 native async) — https://wasi.dev/roadmap
