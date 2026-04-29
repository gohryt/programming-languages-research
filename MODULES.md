# Modules, Imports, and Package Boundaries

Research on module systems, import semantics, export and visibility rules, package boundaries, build-graph formation, and tooling implications across programming languages and ecosystems.

This document focuses on the structure above files and below whole programs: how languages define units of encapsulation, dependency, initialization, and distribution. Parser and AST structure live in `PARSERS.md`. Compile-time graph invalidation, incremental compilation, and IR boundaries live in `COMPILERS.md`, though this document cross-references them where module design affects build and tooling behavior. Runtime observability and debugger protocol boundaries live in `TRACERS.md` and `DEBUGGERS.md`. The unifying axis here is *where modularity lives*: in files, directories, declarations, typed interfaces, package manifests, runtime loaders, or macro phases.

A module system is not just syntax for writing `import foo`. It is the language's answer to a cluster of hard questions:

- What counts as a separately understandable unit of code?
- What names are visible where?
- What dependencies are allowed to exist?
- What work happens when a dependency is introduced?
- What can be cached, compiled, documented, or versioned independently?
- What must tools know in order to rename, navigate, or refactor code safely?

Because of this, module-system design leaks into nearly every other part of the language toolchain. A file-based module model affects parser and IDE assumptions. A package-based identity model affects the build graph and version resolution. Import-time execution affects debuggability, reproducibility, and cyclic semantics. Macro-phase imports affect compilation order and expandability. In practice, module systems are where language design, compiler architecture, and ecosystem ergonomics meet.

This document follows the style of the other research notes: first define the major mechanism families, then use those families to organize later case studies and concrete language comparisons. The goal is not to catalog syntax. The goal is to build a design vocabulary rich enough to support explicit language-design comparisons later.

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

This matters for more than hygiene. Visibility is what lets a compiler and a programmer agree on which changes are semantically relevant. If a function is private to a module, the implementer can freely refactor it without breaking downstream users. If it is public, refactoring must preserve the published contract. A weak module system forces programmers to preserve more accidental surface area than they intended; a strong one lets them hide aggressively and evolve internals safely.

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

In many ecosystems, "module" and "package" are dangerously easy to conflate. They are not the same thing.

A *module* is usually a source-level or language-level unit of naming and visibility. A *package* is usually a distribution unit: the thing versioned, published, downloaded, or installed. Sometimes the two align neatly. Sometimes a package contains many modules. Sometimes one module is compiled into a library artifact but referenced under a different logical name. Sometimes source packages, binary artifacts, and runtime namespaces all use different identities.

This distinction matters because versioning pressure lives at the package boundary, while visibility and code navigation usually live at the module boundary. Languages that fuse the two can feel simpler, but they often pay later in awkward resolution rules or namespace churn when distribution needs evolve.

For a new language, this distinction matters early. If module identity and package identity are separated cleanly, source imports can remain stable while the package manager evolves independently. If they are fused, the package manager effectively becomes part of the language's naming semantics.

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

For a new language, this matters early. A fully file-based model buys simplicity and fast tooling bootstrapping. A declared model buys flexibility and future abstraction power. A hybrid model can work well, but only if the resolution rules stay deterministic.

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

Language-level modularity and ecosystem-level dependency management are often intertwined, but they do not have to be.

A **tightly integrated** design lets the package manager shape module identity directly. Cargo packages, Go modules, Node's `package.json` and exports maps all sit somewhere on this spectrum. The benefit is coherence: build and source semantics are aligned. The cost is that package-management decisions become language-semantics decisions.

A **loosely coupled** design keeps imports and packaging distinct. Python is the clearest example: the import system is one thing, packaging and distribution another. This gives flexibility, but also leaves more room for ambiguity and mismatch between "what code I can import" and "what dependency I declared".

There is no universal best answer, but the distinction must be explicit. A language that does not consciously separate these roles often ends up with the worst of both worlds: imports that are too environment-sensitive for tooling, but package identity that is still too weak for reproducibility.

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

For a new language, this is another high-leverage choice: if modules are kept primarily static and non-executing, many later features become easier to specify cleanly. If dynamic loading is ever desired, it can be added as a separate mechanism instead of entangling every import with runtime behavior.

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

Source: https://doc.rust-lang.org/reference/items/modules.html and https://doc.rust-lang.org/reference/visibility-and-privacy.html and https://doc.rust-lang.org/cargo/reference/manifest.html and https://doc.rust-lang.org/edition-guide/rust-2018/path-changes.html

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

Source: https://ziglang.org/documentation/master/#import and https://ziglang.org/learn/build-system/ and https://ziglang.org/documentation/master/#Packages

### 3.3. Go — Package DAGs, Capitalization Exports, and Cycle Prohibition

Go's module story is simple in surface syntax and strict in architectural consequences. The language-level unit is the **package**, which is generally one directory of `.go` files sharing the same package clause. The distribution/versioning unit is the **module**, rooted by a `go.mod` file. Import paths combine these two worlds: the module path supplies the prefix, and the package directory supplies the suffix.

This split is central. A Go module is "a collection of packages that are released, versioned, and distributed together"; a Go package is the compilation and namespace unit. That makes Go closer to Rust than to Python: package identity, build identity, and distribution identity are related but not identical.

Imports are fully static. The compiler and `go` tool read import paths from source files, resolve them through the module graph, and build a DAG of package dependencies. Go's famous **import cycle prohibition** falls naturally out of this design. If the compiler wants packages to be independently compilable in dependency order — and potentially in parallel — then the package graph must be acyclic. The language chooses to enforce that rule structurally instead of tolerating partially initialized packages or hidden runtime loaders.

This is one of the cleanest examples in language design of a restriction that is painful locally but beneficial globally. Programmers dislike import cycles because the compiler rejects code that "obviously" could be made to work with a loader. But Go's tooling and compile-speed story are stronger precisely because the language refuses that complexity. Dependency direction becomes visible in architecture, not just in runtime behavior.

Visibility is also unusual: **capitalization determines export**. Identifiers beginning with an uppercase letter are exported from the package; lowercase identifiers are package-private. This is extremely lightweight and avoids explicit `pub` markers, but it also means the module system depends on a naming convention rather than an explicit declaration. The convention is simple enough that it works in practice, but it is less expressive than Rust's scoped visibility lattice.

Go's package-per-directory rule is also strong. Filesystem structure is not merely conventional metadata; it materially determines package identity. This gives the ecosystem a lot of uniformity and makes resolution straightforward. The cost is reduced flexibility for rearranging source trees independently of logical organization.

The Go modules layer adds another important design lesson: **package identity and version identity are linked by import paths**. Semantic Import Versioning encodes major version into the module path itself for v2+, so the source import path changes when compatibility changes. This is a powerful reproducibility move, but it also means that versioning policy leaks directly into source-level naming.

Go is a particularly clear reference for a deliberately **DAG-enforcing, compiler/tooling-first** module model. It is especially relevant to languages that value fast builds, clean architecture boundaries, and deterministic tooling over flexible cyclic semantics.

Source: https://go.dev/ref/spec#Packages and https://go.dev/ref/mod and https://research.swtch.com/vgo-import and https://go.dev/blog/package-names

### 3.4. Odin — Package-Per-Directory Simplicity

Odin's package model is simpler and less formally layered than Rust's or Go's, but that simplicity is exactly why it is valuable as a reference point. Odin organizes code around **packages**, with directory structure playing a large role in package identity and import organization. The official ecosystem is further described in terms of **collections** such as `base`, `core`, and `vendor`, which act as grouped roots of packages rather than as semantic language features in the ML sense.

The language aims for low ceremony. There is less emphasis on explicit module declarations as separate syntactic objects and more emphasis on "code in this package directory belongs together." This makes the module/import system easy to explain and easy to operate in smaller codebases. It also fits Odin's broader philosophy of directness and low abstraction overhead.

Compared with Go, Odin appears less rigidly optimized around a package-DAG-as-compilation-machine story, at least in its public presentation. Compared with Rust, it offers less expressivity in visibility structure and fewer distinct layers between package, compilation unit, and published artifact. But the benefit is ergonomic clarity: code organization is visible from the filesystem and import paths without much extra language machinery.

This makes Odin useful in two ways.

First, it is a reminder that a systems language does not need Rust's level of module-system richness to be usable. A package-per-directory model with predictable import rules may be sufficient if the language's goals emphasize readability, straightforward tooling, and a relatively opinionated project layout.

Second, Odin is a good counterweight to Go. Both lean on directory/package organization, but Go turns that into a hard architecture rule with cycle prohibition and capitalization-driven exports. Odin's ecosystem suggests a somewhat softer, more convention-shaped style. That difference is useful when evaluating how strict a new language should be.

At the same time, Odin's official documentation is less specification-like than Rust's, Go's, or Python's. For this document, that means Odin should be treated as a practical design point with lighter formal grounding, not as the primary reference for edge-case semantics.

Source: https://odin-lang.org/docs/overview/#packages and https://odin-lang.org/docs/overview/#import-statements

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

This is already enough to suggest that a new language should decide early whether it wants to sit closer to:
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

Source: https://docs.python.org/3/reference/import.html and https://peps.python.org/pep-0328/ and https://peps.python.org/pep-0420/ and https://docs.python.org/3/library/importlib.html

### 4.2. JavaScript ESM — Static Syntax, Live Bindings, and Runtime Evaluation

ECMAScript modules occupy a hybrid position. Their **syntax is static** — `import` and `export` forms are known to the parser and usable by bundlers and compilers — but module loading, instantiation, and evaluation are still runtime semantics. This gives ESM much more static analyzability than Python or CommonJS, while still retaining the notion of a runtime module instance.

One of ESM's most important design choices is **live bindings**. An importer does not receive a copy of an exported value; it receives access to the exporter's binding slot. This is a significant semantic difference from object-copy or mutable-export models and is one reason ESM cycles can sometimes work where CommonJS-style cycles fail. The binding exists before evaluation completes, but its value may remain uninitialized until the exporter runs.

That leads directly to ESM's cycle semantics. Cycles are tolerated, but they are not free. If two modules depend on one another and access each other's bindings only after both have completed the relevant initialization, execution can succeed. If one accesses a still-uninitialized binding too early, evaluation fails. This is more principled than Python's "partially initialized module object" behavior, but it still means the runtime semantics of evaluation order matter.

Node adds another layer: the same ESM semantics live inside a platform-specific resolution and format-selection system. The `"type": "module"` field, `.mjs`, URL-based resolution, and `exports` maps all participate in how a module specifier becomes a concrete module record. This is not a language-level module system in isolation; it is a language-plus-runtime-plus-package-metadata system.

The design lesson is subtle. ESM shows that **static syntax does not automatically imply static semantics**. A language can have parse-time-known imports and still inherit complex runtime initialization, cycle, and environment-resolution behavior. A language that wants the analyzability benefits of static syntax may also need to reject or tightly limit ESM-style runtime loader semantics.

Source: https://tc39.es/ecma262/#sec-modules and https://nodejs.org/api/esm.html and https://html.spec.whatwg.org/multipage/webappapis.html#module-system and https://hacks.mozilla.org/2018/03/es-modules-a-cartoon-deep-dive/

### 4.3. Node CommonJS — `require`, Mutable Exports, and Loader-Centric Semantics

CommonJS is the older Node.js module model and represents a different point in the design space from ESM. Here, the primary abstraction is not live bindings between declared exports, but a **loader function**: `require(...)` executes the target module the first time, caches the resulting module object, and returns its exports.

This makes CommonJS straightforward and dynamic, but much less statically transparent than ESM. Because `require` is an ordinary function call, it can be conditional, data-driven, or path-manipulated. This flexibility was historically useful, but it means the import graph is not as directly visible to the parser or build tools. Bundlers and analyzers can often recover most of it, but only by applying heuristics or conventions.

The export model is also different. CommonJS modules typically fill out a mutable `module.exports` object. Consumers receive that object rather than a set of live binding slots. This makes interop intuitive for some dynamic programming patterns, but it weakens the connection between declared module surface and the compiler-visible namespace structure. It also means cycles behave differently from ESM cycles: what another module sees depends heavily on exactly when `module.exports` has been populated.

CommonJS matters for this document not because it should be imitated directly, but because it demonstrates what happens when the loader becomes the semantic center of modularity. The system becomes flexible and easy to extend locally, but the graph becomes less explicit and less compiler-friendly. ESM was, in part, a reaction to these limits.

Source: https://nodejs.org/api/modules.html and https://nodejs.org/api/packages.html

### 4.4. Ruby and Lua — Lightweight Runtime Loading Models

Ruby and Lua are worth noting as lighter-weight members of the runtime-import family. They are less specification-heavy than Python's import machinery or Node's ESM/CJS split, but they illustrate the same broad theme: loading code is part of runtime behavior, not merely compile-time structure.

Ruby's `require` and `load` model encourages a culture where module boundaries are relatively soft. Files are loaded, classes and modules are opened or reopened, and monkey patching is normal enough that visibility boundaries often function more as convention than hard encapsulation. This is productive in small systems and REPL-heavy workflows, but it weakens the guarantees that tooling and architecture can rely on.

Lua traditionally treats modules as tables returned by executed files. This is in some ways an even more stripped-down version of the same idea: a module is whatever namespace-like object the file computes and returns. For embeddable systems, this can be excellent — the language imposes little structure and leaves policy to the host or the application. But the cost is that modularity becomes a convention, not a strong semantic substrate.

These systems are useful cautionary reference points for language design. They show that a language can survive with highly flexible runtime loading, but that such flexibility tends to weaken the compiler and toolchain's ability to reason about program structure in advance.

Source: https://docs.ruby-lang.org/en/master/Kernel.html#method-i-require and https://www.lua.org/manual/5.4/manual.html#6.3 and https://www.lua.org/pil/8.html

### 4.5. Perl 5 — Symbol-Table Modules and `use` as Compile-Time `require + import`

Perl 5 is the historical predecessor that Raku reacts against, and a useful contrast against the more elaborate runtime-import systems above. A Perl package is declared with `package Foo;` and creates a symbol table named `%Foo::`. Subroutines, variables, and other names live in that hash, with no language-level visibility distinction — `our $x` is package-scoped, `my $x` is lexically-scoped, but neither restricts cross-package access. Any code can read `$Foo::x` from anywhere.

`use Module;` desugars exactly to `BEGIN { require Module; Module->import(LIST); }` — the `BEGIN` block forces compile-time execution. `require` is the lower primitive: it loads a `.pm` file by searching `@INC` (the module search path, populated from compiled-in defaults plus `PERL5LIB` and `-I` flags), then executes the file. `import` is just a method call that the convention `Exporter` module standardizes — `@EXPORT` names are imported by default, `@EXPORT_OK` are imported on request, `%EXPORT_TAGS` groups them by tag. None of this is enforced by the language; it's all convention layered on top of "modules are symbol tables" and "`use` calls `import`."

The split between `use` (compile-time) and `require` (runtime) is the direct ancestor of Raku's `use`/`need`/`require` three-way split, and CPAN is the ecosystem Raku's fez/zef explicitly replaces. The contrast clarifies what Raku's ambitious identity model actually buys: Perl modules have *no* identity beyond filesystem path and package name, which is why CPAN suffered the supply-chain attacks that fez/zef was designed to close.

Source: https://perldoc.perl.org/functions/use and https://perldoc.perl.org/functions/require and https://perldoc.perl.org/Exporter and https://perldoc.perl.org/perlmod

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

Source: https://www.lispworks.com/documentation/HyperSpec/Body/m_defpkg.htm and https://www.lispworks.com/documentation/HyperSpec/Body/f_export.htm and https://lisp-docs.github.io/docs/tutorial/packages and https://asdf.common-lisp.dev/

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

Source: https://clojure.org/reference/namespaces and https://clojuredocs.org/clojure.core/ns and https://clojuredocs.org/clojure.core/require and https://clojure-doc.org/articles/language/namespaces/

### 4.8. Tcl — Orthogonal Namespaces and Packages

Tcl is the cleanest example in the survey of **two completely orthogonal modularity mechanisms**: namespaces (pure naming, no distribution semantics) and packages (versioned distribution, no naming semantics). The two are independent and serve different purposes.

A namespace is declared with `namespace eval ::foo { ... }`. Names inside use `::` as the path separator: `::foo::bar` references `bar` inside `foo` from the global namespace. Namespaces nest, support `namespace export` for visibility hints, and follow Tcl's lexical scoping rules. They have no distribution identity — a namespace exists in one Tcl interpreter for as long as it's defined, and is gone otherwise.

A package is declared with `package provide MyPkg 1.3` (typically inside a Tcl source file) and consumed with `package require MyPkg 1.2-2.0` (asking for a version in a range). The discovery mechanism is `pkgIndex.tcl` files in directories on the Tcl auto-path: each file contains `package ifneeded MyPkg 1.3 [list source [file join $dir mypkg.tcl]]`, which registers a script-to-execute to load that specific version. The `pkg_mkIndex` helper auto-generates these. `package require` searches the registered index, picks the best matching version, and runs the registered script.

The crucial design point: **multiple versions of the same package can be registered simultaneously**. `pkgIndex.tcl` registrations are version-keyed; the resolver picks one when `package require X 1.2` is called. The application can hold one version while a sub-component requires another — though only one is *loaded* at a time per package name.

By convention, a package called `MyPkg` defines a namespace called `::MyPkg` and puts all its commands there. But this is convention, not a language requirement — `package provide` and `namespace eval` are independent constructs. A package could create no namespace; a namespace could exist without any package mechanism.

The lesson is that **modularity has two distinct concerns — naming and distribution — and they don't need to be coupled at the language level**. Most modern languages collapse them (Rust: package contains crates contains modules; Go: module contains packages). Tcl shows the alternative: keep them orthogonal, make the convention-of-correspondence explicit but not enforced. The cost is more concepts; the benefit is each mechanism stays simple and uncoupled.

Source: https://www.tcl-lang.org/man/tcl8.6/TclCmd/package.htm and https://www.tcl-lang.org/man/tcl8.6/TclCmd/namespace.htm and https://wiki.tcl-lang.org/page/package+ifneeded

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

This family sharpens one of the central design questions for any new language. A runtime-import model also chooses:
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

OCaml is the strongest argument that module design can be a **semantic abstraction feature**, not merely an organizational feature. The key question is whether a new language wants any part of that power, or whether it wants to remain intentionally simpler. Full treatment of OCaml's value restriction and polymorphic-variant trade-offs lives in `TYPES.md §§6.8, 9`; OCaml 5's domains and effect-handler concurrency live in `CONCURRENCY.md §§5.5, 2.6`.

Source: https://v2.ocaml.org/manual/moduleexamples.html and https://dev.realworldocaml.org/files-modules-and-programs.html and https://dev.realworldocaml.org/functors.html

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

The trade-off, as always, is that expressive power increases conceptual weight. SML's module system is elegant, but it is not lightweight. That makes it useful as a design boundary even when a new language ultimately decides to stay far simpler.

Source: https://smlfamily.github.io/sml97-defn.pdf and https://www.cs.cmu.edu/~rwh/isml/book.pdf and https://homepages.inf.ed.ac.uk/dts/fps/papers/MacQueen.pdf

### 5.3. Haskell — Export Lists, Qualified Imports, and Package Layering

Haskell sits between the ML tradition and the simpler static systems. A Haskell module is declared explicitly, can provide an **export list**, and can import other modules either qualified or unqualified. This gives it a more formal and explicit surface than Python or Go, but without the full structure/signature/functor machinery of Standard ML and OCaml.

The export-list mechanism is especially important. It makes API surface a deliberate part of module declaration, rather than merely "everything public unless hidden". Qualified imports likewise make namespace control more explicit, helping avoid collisions without forcing a fully hierarchical package-qualified path on every use.

At the ecosystem level, Haskell also separates:
- module names,
- package names,
- and build/distribution units

more than some simpler systems do. Cabal/Stack package boundaries and module visibility rules are related, but not identical. This makes Haskell a useful design reference for ecosystems that want package-level and source-level identities layered without becoming the same mechanism.

Compared with OCaml, Haskell's module system is less ambitious as a semantic abstraction calculus. Compared with Rust or Go, it is more declaration-oriented and explicit about export surfaces. That middle position is a useful reference for any new language that wants stronger source-level API control without adopting full ML-style higher-order modules. Full treatment of GHC's richer type-system story lives in `TYPES.md §6.7`; GHC's lightweight-thread, capability, spark, and STM runtime design lives in `CONCURRENCY.md §§2.6, 3.7, 9.6`.

Source: https://www.haskell.org/onlinereport/haskell2010/haskellch5.html and https://cabal.readthedocs.io/en/stable/cabal-package.html and https://downloads.haskell.org/~ghc/latest/docs/users_guide/packages.html

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

Source: https://docs.racket-lang.org/reference/Modules.html and https://docs.racket-lang.org/guide/module-paths.html and https://docs.racket-lang.org/guide/phases.html and https://docs.racket-lang.org/guide/hash-lang_reader.html

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

Source: http://www.ada-auth.org/standards/22rm/html/RM-7.html and http://www.ada-auth.org/standards/22rm/html/RM-10.html and http://www.ada-auth.org/standards/22rm/html/RM-12.html and https://learn.adacore.com/courses/intro-to-ada/chapters/modular_programming.html

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

**Modula-3** extended this with **opaque type matching across module boundaries**, generic interfaces and modules (`INTERFACE List(T) ... END;` instantiated as `MODULE IntList = List(INTEGER) ...`), and the most rigorous formal module semantics of any production language at that time. The Modula-3 type system was the substrate for several formal module-calculus papers in the 1990s (Cardelli, Leroy, Harper-Lillibridge), making it the bridge between Wirth-style production modules and the ML/SML formal calculi covered in §10.1.

**Oberon** simplified Modula-2 dramatically by replacing the separate definition file with **inline export markers**: a single asterisk after a declared identifier marks it as exported.

```oberon
MODULE Stack;
  TYPE Stack* = POINTER TO StackRec;  (* exported *)
  TYPE StackRec = RECORD ... END;     (* not exported — implementation detail *)
  PROCEDURE Create*() : Stack; ...    (* exported *)
END Stack.
```

This is the design Nim later adopted (§9.5). Oberon also introduced **`*` for read-only export** and **`-` for read-write export of variables** — finer-grained than Nim's single-marker scheme. The lesson: per-declaration export markers eliminate the need for separate interface files but require every public name to carry the syntactic noise.

Across the three: Wirth's lineage shows that **opacity, hierarchy, and selective export are independent design dimensions** that can be combined or separated. Modern languages cherry-pick — Rust took selective export (`pub`), OCaml took the spec/body split (`.mli`/`.ml`), Nim took inline export markers — but rarely combine all three.

Source: https://www.modula2.org/reference/ and https://www.cs.purdue.edu/homes/hosking/m3/reference/syntax.html and http://www.projectoberon.com/ and https://en.wikipedia.org/wiki/Oberon_(programming_language)

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

---

## 6. Packages, Identity, and Resolution

The previous chapters treated modules primarily as language-level structures: what names they expose, how they form dependency graphs, and whether imports are static, executable, typed, or phase-aware. But real ecosystems add another layer above source modules: **package identity, distribution identity, and resolution policy**. This is where many apparently simple module systems become complicated. The source language may say "import `foo.bar`", but the toolchain still has to answer:
- which artifact provides `foo.bar`?
- what version of it is selected?
- how is that identity represented in source?
- and how much of the answer is determined by the language versus the package manager or build tool?

This chapter therefore separates three concepts that many ecosystems blur together:

- **source-level module identity** — the names programmers write in imports;
- **build-graph identity** — the units the compiler actually schedules and caches;
- **distribution identity** — the units versioned, downloaded, published, and installed.

Some systems align these cleanly. Some intentionally keep them separate. Some make them partially overlap, which often creates the most confusion. This chapter is decisive for new-language design because an elegant source-level module system can still become painful if package identity and resolution semantics are underspecified.

### 6.1. Rust — Packages, Crates, and Source-Level Modules as Distinct Layers

Rust is one of the clearest modern examples of *not* collapsing all modularity concepts into one. Cargo's **package** is the build/share/publish unit. A package may contain one library crate and any number of binary crates. A **crate** is the compiler's primary compilation unit: the unit rooted at `lib.rs` or `main.rs` that produces one library or executable artifact. Inside a crate lives the **module tree**, shaped by `mod` declarations and file layout.

This layering has several practical consequences:

- A package can publish multiple related compilation units without pretending they are one namespace tree.
- The compiler can reason about crates as artifact-sized units while still allowing fine-grained internal module structure.
- Source-level module paths do not need to carry version numbers or package-manager metadata directly.

Cargo adds a fourth layer in practice: **workspaces**, which group multiple packages that evolve together. This is not a module-system feature in the language sense, but it strongly shapes real Rust code organization. The important lesson is that Rust keeps these layers explicit enough that the ecosystem can talk about them precisely: package, workspace, crate, module.

Rust's module resolution is therefore mostly static and local once the crate boundary is known, but crate/package resolution itself is delegated to Cargo manifest metadata. This separation is one reason Rust's source-level module syntax remains relatively stable even as packaging and workspace workflows evolve.

Source: https://doc.rust-lang.org/cargo/reference/workspaces.html and https://doc.rust-lang.org/reference/crates-and-source-files.html and https://doc.rust-lang.org/cargo/reference/registries.html

### 6.2. Go — Modules as Distribution Units, Packages as Compilation Units

Go's distinction between **modules** and **packages** is similarly important, but the mapping is tighter than Rust's. A Go **module** is a tree of source files rooted by a `go.mod` file and is the unit that is released, versioned, and downloaded. A **package** is typically a directory inside that tree and is the unit imported and compiled. Import paths are formed from:

- the module path declared in `go.mod`, plus
- the relative directory path to the package.

This gives Go a very strong identity model. Import paths are not merely human-friendly names; they are also version-sensitive, distribution-relevant addresses. **Semantic Import Versioning** pushes this even further by requiring major-version changes `v2+` to appear in the module path itself. That means a breaking version change is reflected directly in source-level import names.

The upside is reproducibility and clarity. The downside is that package-manager policy leaks into source identity more directly than in Rust. This is a deliberate trade-off: Go chooses strong alignment between source imports and release identity rather than trying to hide versioning behind a more abstract layer.

Go is a particularly clear reference for a design where:
- package graph and distribution graph are closely aligned,
- import paths are semantically meaningful identities,
- and versioning policy is explicit at the source level.

Source: https://go.dev/ref/mod#go-mod-file and https://research.swtch.com/vgo-import and https://go.dev/ref/mod#minimal-version-selection

### 6.3. Python — Import System and Packaging as Loosely Coupled Systems

Python takes the opposite approach. The **import system** is part of the language runtime and is primarily concerned with finding, loading, and caching module objects. **Packaging**, by contrast, is an ecosystem layer: wheels, source distributions, metadata, installers, environment managers, and package indexes all exist largely outside the core import semantics.

This separation gives Python enormous flexibility. A module can come from the filesystem, a zip file, a custom importer, or a namespace package spread across multiple directory roots. But the cost is that "what can be imported?" and "what dependency was declared?" are not the same question. The import system reasons in terms of fully qualified names, `sys.path`, `__path__`, finders, loaders, and specs; packaging tools reason in terms of distribution metadata and environment installation state.

This is one of the main reasons Python environments are powerful but notoriously slippery. The language itself does not give one simple authoritative answer to module identity at the distribution level. Instead, multiple layers cooperate:
- import machinery resolves names to modules,
- packaging metadata tells installers what to put in the environment,
- the environment then determines what imports will succeed.

Python is a valuable caution: **separating package management from imports can be good, but only if the identity boundary is still crisp enough for tools and users to reason about**. Otherwise, import behavior becomes too environment-shaped.

Source: https://packaging.python.org/en/latest/specifications/ and https://peps.python.org/pep-0517/ and https://peps.python.org/pep-0621/

### 6.4. Node and JavaScript — Package Metadata as Resolution Policy

JavaScript's module story is inseparable from package metadata once it enters the Node ecosystem. ECMAScript itself defines module syntax and runtime semantics, but Node's resolution and loading behavior is strongly shaped by `package.json`, especially fields such as:

- `"type"` — whether `.js` files are interpreted as ESM or CommonJS,
- `"exports"` — which entry points are exposed and under which conditions,
- and package subpath mappings that distinguish import and require behavior.

This creates a system where package metadata is not merely installation information; it is an active participant in module resolution. The source-level specifier and the package boundary cooperate to determine what code is actually imported. This is more tightly integrated than Python's packaging split, but also more loader-shaped than Go's explicit path identity.

The result is expressive and powerful, especially for dual ESM/CJS distribution, but it comes at the cost of conceptual complexity. The same package may present different entry points to different consumers depending on loader mode and metadata configuration. The language-level module system and the package manager cannot really be discussed independently.

Node is the strongest warning about allowing package metadata to redefine source-level resolution semantics too aggressively. Such systems are flexible, but they make static reasoning and ecosystem simplicity harder.

Source: https://nodejs.org/api/packages.html#exports and https://docs.npmjs.com/cli/v10/configuring-npm/package-json and https://nodejs.org/api/packages.html#conditional-exports

### 6.5. Zig and Odin — Package Roots, Build Context, and Tooling Simplicity

Zig and Odin are useful here because they show lighter-weight package stories than Cargo, Go modules, or Node package metadata.

In **Zig**, package and module resolution are closely tied to the build configuration. `@import` itself is simple, but what package names are available depends on how the build graph exposes root modules and dependencies. This means the source language stays low-magic, while the build layer carries more of the responsibility for naming and exposure. The design is relatively deterministic, but it also means package identity is somewhat build-context-shaped.

In **Odin**, the language and ecosystem lean heavily on package-per-directory organization and named collections such as `base`, `core`, and `vendor`. This is much less elaborate than Cargo or npm, but also much less detached from source tree layout. The result is easy to understand and easy for tools to follow, at the cost of less abstraction between source organization and ecosystem packaging.

These systems matter because they show that a new language does not need a maximal package manager model immediately. A language can begin with deterministic package roots and straightforward import resolution, then grow richer packaging later if the source-level identity model is kept clean.

Source: https://ziglang.org/learn/build-system/ and https://odin-lang.org/docs/overview/#packages

### 6.6. Design Lessons from Packages, Identity, and Resolution

Across Rust, Go, Python, Node, Zig, and Odin, a few durable patterns emerge.

First, **source-level modularity and distribution-level modularity are usually not the same thing**, even when a language tries to align them closely. The key design question is not whether they differ — they almost always do — but whether that difference is explicit and principled.

Second, languages seem to fall into three broad package-identity postures:

- **Layered but explicit** — Rust: package, crate, and module are distinct and named separately.
- **Closely aligned** — Go: module path strongly shapes package import identity.
- **Loosely coupled** — Python: import system and packaging ecosystem are distinct layers.

Node demonstrates a fourth, more volatile posture:

- **metadata-shaped resolution** — package metadata actively participates in import semantics.

A common path for a new language is:

- keep **module identity** clear and source-level;
- keep **package identity** explicit but not overly entangled with import syntax;
- keep **resolution deterministic** and friendly to tools;
- avoid making package metadata too loader-powerful too early;
- and decide consciously whether version identity should ever leak into source import paths.

This chapter therefore sharpens one of the main choices for any new language: whether to look more like Rust's layered separation, Go's path-aligned identity, Python's looser split, or Node's metadata-shaped resolution. The dominant pattern in modern systems-language design favors a layered Rust-style model, but the right answer depends on whether the ecosystem prioritizes reproducibility, conceptual simplicity, runtime flexibility, or distribution flexibility.

---

## 7. JVM and .NET Module Systems

The JVM and CLR worlds occupy a distinctive position in this survey: they began with namespace-style modularity in the 1990s and only retrofitted true module systems decades later. Both runtimes survived for years on the strength of *binary artifact + classpath/assembly load*, with packages or namespaces serving as namespace organizers but not as enforceable visibility boundaries between published artifacts. This chapter covers what the late module retrofits actually look like, why they took so long, and what their cost-benefit profile teaches a language designer who is choosing between "namespaces only" and "real module systems" early.

### 7.1. Java — Packages, Access Levels, and the Long Road to JPMS

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

The cost was severe ecosystem disruption. JPMS adoption took years: Maven Central had to learn `Automatic-Module-Name` manifest entries for legacy JARs, build tools needed module-path support alongside the classpath, and many frameworks needed to add `opens` directives or migrate away from deep reflection. Even today, large parts of the Java ecosystem run on the classpath rather than the module path, treating JPMS as opt-in rather than the default.

The design lesson is two-edged. JPMS proved that retrofitting a module system onto a 25-year-old runtime is *possible* and that it can deliver real benefits: strong encapsulation of platform internals (closing access to `sun.misc.Unsafe`-style backdoors), reliable reflection boundaries, custom runtime images, and explicit dependency graphs. But it also proved how expensive the retrofit is: every existing artifact had to either declare a module, accept being treated as an "automatic module" with weaker guarantees, or stay on the classpath. A new language is dramatically better off committing to a real module system from version 1 than discovering, twenty years later, that namespaces alone do not suffice.

Source: https://openjdk.org/projects/jigsaw/spec/ and https://openjdk.org/jeps/261 and https://www.oracle.com/corporate/features/understanding-java-9-modules.html and https://dev.java/learn/modules/

### 7.2. C# / .NET — Namespaces, Assemblies, and `InternalsVisibleTo`

The CLR analogue of Java's split is **namespaces** plus **assemblies**. Namespaces (`namespace Foo.Bar { ... }` or, since C# 10, file-scoped `namespace Foo.Bar;`) are pure naming hierarchies — they do not correspond to artifacts and are not visibility boundaries beyond the conventional `internal` access level. Assemblies are the actual unit of distribution, deployment, and visibility enforcement: typically a `.dll` or `.exe` containing compiled IL, metadata, and a strong-name or version identity. The mapping between namespaces and assemblies is many-to-many. One assembly can contribute types to many namespaces; one namespace can be assembled from types in many assemblies.

The visibility levels are richer than Java's. C# offers `public`, `internal` (visible only within the assembly), `protected`, `private`, `protected internal` (the union: same assembly OR derived class in any assembly), and `private protected` (the intersection: derived class within the same assembly). The assembly is therefore the meaningful encapsulation boundary, with the namespace serving primarily as a naming concern.

Two CLR-specific mechanisms shape how this plays out in practice:

- **`[InternalsVisibleTo("OtherAssembly")]`** — a friend assembly attribute that grants `internal` access to a specifically named consumer. This is the canonical way to expose internals to a sibling test assembly without making them public to the world. The named consumer can optionally include a public-key token, restricting friend access to strong-named callers.
- **Strong naming and the GAC (Global Assembly Cache)** — a legacy mechanism for binding assembly identity to a cryptographic public key plus version, enabling side-by-side deployment of multiple versions. The .NET Core / .NET 5+ ecosystem has largely moved away from the GAC toward NuGet packages and per-application directories, but strong naming remains a versioning primitive in places.

.NET also supports **assembly-level visibility shaping** via `[assembly: TypeForwardedTo(typeof(Foo))]`, which lets one assembly redirect a type reference to another. This is how the platform splits `mscorlib.dll` into `System.Runtime.dll` and friends across .NET versions without breaking compiled binaries — the type identity migrates while consumer references continue to compile.

Compared with JPMS, .NET's modularity is structurally similar (assembly ≈ module artifact, `internal` ≈ package-private) but architecturally far less ambitious. There is no language-level dependency declaration like `requires`; assembly references live in the project file (`.csproj`) and the package manager (NuGet). There is no notion analogous to qualified `exports ... to` beyond `InternalsVisibleTo`. There is no language-enforced reads-graph. The trade-off is that .NET avoided JPMS-scale ecosystem disruption, at the price of leaving the assembly-as-module abstraction quieter and more convention-shaped.

The design lesson is that CLR-style "the binary artifact is the encapsulation boundary, the source-level namespace is just naming" is workable for decades if the language never tries to enforce more. But it leaves visibility weaker than ML or Rust, leans heavily on tooling (NuGet, MSBuild) for dependency management, and provides no built-in mechanism for the platform to evolve its internal type layout safely without `TypeForwardedTo`-style retrofits.

Source: https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/namespaces/ and https://learn.microsoft.com/en-us/dotnet/standard/assembly/ and https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.internalsvisibletoattribute and https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/internal

### 7.3. Scala — Packages, Top-Level Declarations, and Implicit Imports

Scala layers package syntax on top of the JVM's package model with several additions worth naming. Source files declare `package foo.bar`, and any number of files in different directories may contribute to the same package. Scala also supports **package objects** (Scala 2) and, in Scala 3, **top-level definitions**, which let `def`, `val`, `type`, `given`, and `extension` appear directly inside a package without wrapping them in an enclosing object. This eliminates the Java pattern of "everything must live inside a class" and gives packages the role of being containers of definitions, not just types.

Scala's import system is more elaborate than Java's. Imports can rename (`import foo.{Bar => Baz}`), exclude (`import foo.{Bar => _, _}`), pick selective subsets, and — in Scala 3 — explicitly bring `given` instances into scope (`import foo.given`) separately from ordinary identifiers. This makes implicit / `given` resolution part of the import system rather than ambient, which significantly improves predictability. Scala 3 also exposes `export` clauses, which re-export selected members of a delegated value as members of the enclosing definition — a first-class re-export mechanism that goes beyond what Java packages provide.

Compilation-unit ordering matters less in Scala than in F# (covered later) but more than in Java: implicit / `given` instances are resolved by a search procedure that depends on which definitions are in scope, and the import policy determines what is in scope at any given site. This is why Scala 3 made the `given` import explicit — it gives the compiler and the reader a single answer to "what implicits is this method site seeing?"

At the artifact level, Scala compiles to JVM `.class` files and inherits JPMS / classpath behavior unchanged. Scala does not declare `module-info.java`-style metadata, and ScalaJS / Scala Native have their own artifact and packaging stories that mostly bypass JPMS. The Scala-specific module-system contribution is therefore at the *source level* — richer imports, top-level definitions, `given` import scoping, and `export` clauses — not at the artifact level.

Source: https://docs.scala-lang.org/scala3/reference/changed-features/imports.html and https://docs.scala-lang.org/scala3/reference/other-new-features/export.html and https://docs.scala-lang.org/scala3/book/packaging-imports.html

### 7.4. Kotlin — Packages, `internal` Visibility, and Multiplatform Modules

Kotlin's surface module story looks Java-like — files declare `package foo.bar`, types are organized into hierarchical namespaces, and JVM compilation produces standard `.class` files. The interesting differences are the visibility lattice and the multi-platform module abstraction.

Kotlin's visibility levels are `public` (default), `private` (file-scoped at top level, class-scoped within a class), `protected`, and **`internal`** — visible only within the same Kotlin **module**. A Kotlin module is a build-tool concept (a Gradle subproject, a Maven module, an IntelliJ module, an Ant target) rather than a language-level construct. The visibility level binds to the build-tool boundary, but there is no `module-info.kt` declaring it. The absence of a language-level module declaration is intentional: Kotlin treats "module" as a build-tool primitive, the way Go treats "package" as a directory primitive.

This is a useful design point. Kotlin gets `internal`-visibility encapsulation that respects build boundaries without inventing JPMS-style language syntax. The cost is that the boundary is implicit — you have to know the build configuration to know what counts as the same module. Tooling (IDE, kotlinc) handles the bookkeeping.

**Kotlin Multiplatform** (formerly KMM) introduces a more elaborate module concept: a multiplatform module declares `commonMain` source plus per-target source sets (`jvmMain`, `iosMain`, `jsMain`, etc.). The module produces multiple artifacts simultaneously, with `expect`/`actual` declarations bridging platform-specific implementations. Here "module" means closer to "library that compiles to several platforms with shared and platform-specific code partitioned by source set." This is a build-tool-and-language hybrid: the language has `expect`/`actual`, the build tool decides which source sets contribute to which target.

Source: https://kotlinlang.org/docs/visibility-modifiers.html and https://kotlinlang.org/docs/packages.html and https://kotlinlang.org/docs/multiplatform.html

### 7.5. Design Lessons from JVM/CLR Module Layering

The JVM and CLR ecosystems together demonstrate three durable patterns worth carrying forward to any new language design.

First, **namespace-only modularity is insufficient at scale, and retrofitting a module system later is expensive**. Java waited 22 years to ship JPMS; the disruption was significant, adoption is partial even today, and many parts of the ecosystem still treat the classpath as the operative reality. .NET never made the leap and continues to lean on assemblies plus convention. A new language should bake real module boundaries in from the first release, even if they are simple.

Second, **the binary artifact is a strong candidate for the encapsulation boundary**. Both ecosystems converged on "the published artifact (JAR / DLL / module) is what `internal` privacy respects." This sidesteps the problem of trying to enforce visibility at the source level when the same source can be compiled into many artifact configurations. The corollary: a friend mechanism (`InternalsVisibleTo`, `exports ... to`) is needed almost immediately, because test code typically lives in a sibling artifact and needs internal access.

Third, **reflection and metaprogramming break encapsulation unless the module system explicitly accommodates them**. JPMS's `opens` directive exists because Spring, Hibernate, and Jackson cannot work without deep reflective access. .NET's reflection has fewer enforced limits, but its analogues to `opens` show up indirectly through `[assembly: AllowPartiallyTrustedCallers]` and similar trust attributes. A language designing a module system from scratch should decide early whether reflection is permitted, restricted, or first-class — and if first-class, what mechanism (the equivalent of `opens`) explicitly authorizes it.

The fourth, less visible lesson is that **language-level modules and build-tool modules can be the same thing or different things, but the relationship must be clearly stated**. Kotlin is honest about it: the build tool defines the module. JPMS pretends the language defines the module, but in practice Maven and Gradle still own the dependency-resolution side. Pretending these are unrelated breeds confusion; making the relationship explicit is one of the cleaner design choices a new language can make.

---

## 8. Headers, Translation Units, and C++20 Modules

C and C++ occupy a unique slot in this survey: for forty years, they had no language-level module system at all. Modularity was achieved through the **textual-include + separate-compilation + linker** triad, with the preprocessor's `#include` directive treating header files as macro-expanded source insertions. C++20 finally introduced named modules as a first-class language feature, but adoption is still in progress, and the migration story is itself instructive about what a module system has to do to displace a deeply entrenched alternative.

### 8.1. C and C++ Translation Units, `#include`, and Header Files

A C or C++ **translation unit** is the unit of compilation: a single `.c` / `.cpp` source file plus everything textually included by it after preprocessing. The preprocessor processes `#include` directives by literally inserting the named header file's text at the include site, then the compiler parses the expanded result. There is no semantic notion of "the header" after preprocessing; the contents simply become part of the translation unit.

This model has remarkable strengths and weaknesses both rooted in its simplicity. Strengths: any text editor can produce a working compilation unit; the language has no module-resolution machinery to specify; cross-translation-unit references are entirely the linker's job (resolving `extern` symbol references against object files and libraries); and the same header can be consumed by C, C++, and assembly with appropriate guards. Weaknesses: every translation unit re-parses every transitively included header (the famous `<windows.h>` and `<iostream>` blowup, where a one-line `hello.cpp` expands to hundreds of thousands of tokens); macros leak across header boundaries unless carefully scoped; declaration order in a header determines what subsequent code sees, making header authoring a careful art; and there is no enforced visibility boundary — anything declared in a header is visible to everyone who includes it.

The defenses against these weaknesses are conventions and tooling, not language features:

- **Header guards** (`#ifndef FOO_H`, `#define FOO_H`, `#endif`) prevent multiple-inclusion within a single translation unit.
- **Forward declarations** instead of `#include`s where possible, to reduce transitive header pull-in (the Pimpl idiom is one extreme expression).
- **Precompiled headers (PCH)** cache the parsed token stream of a fixed set of headers. GCC, Clang, and MSVC all support PCH; they reduce compile times substantially but add fragility — the PCH must be rebuilt when any input changes, and the same PCH must be used in compatible configurations across a project.
- **Include-what-you-use** static analysis tools (Google's `iwyu`, Clang's `-Wmissing-includes`) help police accidental transitive dependencies.

The semantic consequence is that **C and C++ translation units have no module identity at all**. The unit of distribution is the library (`.a`, `.so`, `.lib`, `.dll`), the unit of source organization is the header / source file pair, and the bridge between them is the symbol table managed by the linker. There is no "what does this header export?" beyond what its declarations and macros happen to define. There is no "what does this header depend on?" beyond what `#include` directives appear in it. The module graph is implicit in the include graph and emerges only after preprocessing.

This is why C and C++ build systems (Make, CMake, Bazel, Buck, Meson, Ninja) are so much more complex than build systems for languages with explicit modules: they must compute the include graph by re-running the preprocessor, track header timestamps for incremental rebuilds, and manage compilation-unit-level options (`-D`, `-I`, `-W`) that are not visible in the source.

Source: https://en.cppreference.com/w/cpp/preprocessor/include and https://gcc.gnu.org/onlinedocs/cpp/ and https://github.com/include-what-you-use/include-what-you-use

### 8.2. C++20 Modules — Named Modules, Module Interface Units, and BMI Caching

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

Tooling support has been the gating factor. GCC 14+, Clang 17+, and MSVC have varying levels of named-module support; build systems (CMake, Bazel) added module dependency scanning relatively late; cppcheck, clangd, and other analyzers needed specific module support. As of the mid-2020s, named modules are usable but not yet ubiquitous; the standard library import (`import std;`) is the most common entry point because it requires only consumer-side adoption.

The lessons are direct. First, **a module system can be retrofitted onto a 40-year-old textual language, but the migration takes a decade plus**. C++20 modules are real and good; they will not displace `#include` ecosystem-wide for many more years. Second, **the BMI is a per-compiler caching artifact, not a distribution format**. Trying to standardize a portable binary module format across compilers was attempted (the C++ Modules TS) and the committee converged on "don't standardize it" — every compiler caches differently, and that's fine because source distribution is the contract. Third, **macros and the preprocessor remain the dirtiest corner of the migration**. A new language that wants module-style benefits should avoid a textual macro layer entirely, or confine it (as Rust and C++20 modules do) so that macro effects do not cross module boundaries.

Source: https://en.cppreference.com/w/cpp/language/modules and https://isocpp.org/files/papers/P1103R3.pdf and https://learn.microsoft.com/en-us/cpp/cpp/modules-cpp and https://gcc.gnu.org/wiki/cxx-modules and https://clang.llvm.org/docs/StandardCPlusPlusModules.html

### 8.3. Design Lessons from the Header-to-Module Migration

C++20 modules are the most expensive module-system retrofit in software history, and the design choices the committee made are worth studying for any new language.

**Module identity is decoupled from filenames.** A module named `foo` lives in whatever file declares `export module foo;`. The build system maps module names to their interface units, but the source language treats the module name as authoritative. This is the opposite of Go, which makes the directory path part of the package import path. The C++20 design preserves the historical C++ freedom to organize files however the project wants, at the cost of requiring a module-name-to-file mapping somewhere (typically the build system).

**The preprocessor is contained but not eliminated.** Inside a module, `#define` and `#include` still work, but their effects do not escape the module boundary unless explicitly exported. This is a pragmatic compromise: existing C++ code uses macros pervasively, and a module system that banned them outright would have been a non-starter. The compromise is to localize macro effects rather than remove them.

**Source distribution remains the contract.** Despite the BMI, no portable binary module format exists. This avoids the ABI-stability nightmare that would have dominated standardization, but it also means every consumer compiles every dependency from source. A new language should consciously decide whether to follow this model (Rust does) or to ship binary artifacts as distribution units (Go effectively does, via build caches; .NET and JVM do explicitly).

**Tooling lag is the rate-limiting factor.** Even with the language feature standardized, ecosystem adoption depends on build systems, IDEs, package managers, and analyzers. C++20 modules were specified in 2020 but were not practically usable until ~2024. A new language can sidestep this by shipping modules from version 1, but it must also be honest that the ecosystem won't materialize until the tools exist.

The deepest lesson is conservative: **a language without modules at the start will accumulate a textual-include-style alternative whose inertia eventually exceeds the benefit of the formal module system**. The right time to introduce modules is before there is anything to migrate.

---

## 9. Modules in Additional Production Languages

Beyond the core systems-language and scripting-language references, several production languages have made distinctive module-system choices worth recording. The entries below are individually shorter than chapters 3–8 but collectively map a wider portion of the design space, especially around the relationship between source files, compilation order, distribution, and resilient ABI evolution.

### 9.1. Swift — Modules as Frameworks and Library Evolution

Swift's module unit is the **module**, which corresponds operationally to a Swift framework, a static library, an Xcode target, or a Swift Package Manager (SPM) target. Imports are a single keyword: `import Foundation`, `import MyAppKit`. Within a module, all source files share a flat namespace; types can reference each other without import declarations. Across modules, imports are the only way to reference declarations.

Swift's visibility lattice is deeper than Java's or Kotlin's: `open` (public + subclassable across modules), `public` (visible across modules, not subclassable across modules without `open`), `package` (visible within the same Swift package — added in Swift 5.9), `internal` (default; visible within the module), `fileprivate` (visible within the source file), `private` (visible within the enclosing declaration). The `package` level was the most recent and most consequential addition: previously, Swift had no way to share types between sibling modules in a multi-module package without making them `public`, polluting the published API surface.

The most distinctive Swift contribution is **Library Evolution Mode**, the resilient-ABI compilation mode that lets a binary module evolve its internal layout without breaking already-compiled clients. With Library Evolution enabled, Swift emits per-module `.swiftinterface` text files (a stable serialized form of the module's public API) plus binary `.swiftmodule` files. Consumers compile against the interface, and the runtime resolves layouts dynamically. This is what allows Apple to ship a new iOS SDK and have apps built against an older SDK continue to run — the equivalent of .NET's `TypeForwardedTo` plus C++ ABI conventions, baked into the compiler at module granularity.

Swift Package Manager (SPM) added the package-level distribution layer, with `Package.swift` describing dependencies, products, and target structure. SPM packages can declare both library products (consumed as modules) and executable products. Cross-module visibility within a package is the `package` access level; cross-package visibility requires `public`.

Source: https://docs.swift.org/swift-book/documentation/the-swift-programming-language/accesscontrol and https://github.com/swiftlang/swift-evolution/blob/main/proposals/0386-package-access-modifier.md and https://github.com/swiftlang/swift/blob/main/docs/LibraryEvolution.rst and https://www.swift.org/documentation/package-manager/

### 9.2. Erlang and Elixir — Applications, OTP, and Code Loading

Erlang has the simplest possible module surface — `-module(foo).` declares a module, `-export([func/1, other/2]).` declares its public functions, and `foo:func(arg)` calls a function in another module. Module names are flat (no hierarchy), and a module corresponds to a single `.erl` source file producing a single `.beam` BEAM file. The flatness reflects Erlang's age (1986) and is the canonical example of a flat-namespace ecosystem that scales reasonably through naming conventions (`my_lib_socket`, `cowboy_http`) rather than through hierarchical paths.

Above modules, Erlang/OTP layers **applications**, which are not modules in the namespace sense but are the unit of *runtime configuration and supervision*. An OTP application is described by a `.app` file listing its modules, registered names, started supervisor, environment configuration, and dependencies on other applications. The runtime treats applications as the lifecycle unit: start, stop, take down with their supervisors. This gives Erlang two distinct levels — the module (compilation and namespace unit) and the application (deployment and runtime unit) — without trying to fuse them.

The runtime story is unusual: Erlang supports **hot module reload**, where a running system can load a new version of a module while existing processes continue executing the old version. The VM keeps two versions of each module active simultaneously; existing local calls (`func()` within the module) continue on the old version, while fully-qualified calls (`my_module:func()`) always dispatch to the current version. This is the canonical mechanism for telecom-style 99.999% uptime systems and is covered in `COMPILERS.md §23.1` from the runtime angle. The module system enables this directly: because modules are flat, named, individually loadable artifacts with explicit export lists, the runtime can swap their implementations without invalidating the global namespace.

**Elixir** sits on top of the Erlang VM and reuses the same module mechanics with a more hierarchical naming convention (`MyApp.Accounts.User`) and the `defmodule ... do ... end` syntax. The dot-separated module name is a convention layered on top of the flat BEAM module namespace — `MyApp.Accounts.User` compiles to a BEAM module named `Elixir.MyApp.Accounts.User`. Elixir's `import`, `alias`, `require`, and `use` keywords cover different access patterns: `alias` for shorter names, `import` for unqualified function access, `require` for compile-time macro availability, `use` for invoking a module's `__using__/1` macro at compile time. **Mix** is Elixir's build tool, which adds package and dependency management (with **Hex** as the registry) above the application layer.

Source: https://www.erlang.org/doc/system/code_loading.html and https://www.erlang.org/doc/design_principles/applications.html and https://hexdocs.pm/elixir/Kernel.html#defmodule/2 and https://hexdocs.pm/mix/Mix.html

### 9.3. Julia — Module Objects, `using`/`import`, and Precompilation

Julia's module system is closer to Python's than to Rust's, but with stronger compile-time integration and aggressive precompilation. A module is declared with `module Foo ... end`, can be nested inside another module, and can `include("file.jl")` to splice in source files (textual inclusion, not module composition). The top-level module of a package is called `Main` for scripts and is the package's namespace for installed packages.

Julia distinguishes `using` and `import`:

- `using Foo` — imports the module's `export`-listed names into the current scope, plus the module name itself.
- `import Foo` — imports only the module name, requiring qualified access (`Foo.bar`).
- `import Foo: bar, baz` — imports specific names, allowing them to be extended (overloaded) in the current module.

The `export` directive lists the names brought into scope by `using`. Names not exported are still accessible via qualified syntax (`Foo.unexported`); Julia has no language-level enforcement of privacy beyond convention (an underscore prefix or just leaving the name unexported).

The interesting performance contribution is **precompilation**. Each Julia package is compiled to a `.ji` cache file the first time it is loaded, and subsequent loads use the cache. Since Julia 1.9 (2023), packages also produce **native code caches** (`pkgimage`), which embed JIT-compiled native code for type-stable methods so that downstream packages do not pay the JIT cost on first use. This makes loading large package graphs (e.g., a Plots.jl pipeline) substantially faster, addressing the long-standing "time to first plot" complaint.

Julia's package manager (`Pkg`) maintains environments: `Project.toml` lists dependencies, `Manifest.toml` records the resolved versions (a lockfile). Environments are stackable, so one can have a base environment plus a per-project environment; the resolution is deterministic.

The module-system-relevant lesson from Julia is that **`include`-style textual splicing can coexist with module declarations** if precompilation handles the resulting cost. Julia conventionally puts each module's contents into one file but uses `include` to assemble large modules from many files, treating files as a project-organization unit and modules as the namespace unit.

Source: https://docs.julialang.org/en/v1/manual/modules/ and https://docs.julialang.org/en/v1/manual/code-loading/ and https://julialang.org/blog/2023/04/julia-1.9-highlights/

### 9.4. Dart — Libraries, Parts, and Underscore Privacy

Dart's module unit is the **library**, which can be a single file (the default) or a multi-file library coordinated by a `library` directive plus `part` and `part of` directives. A library is the privacy boundary: identifiers beginning with an underscore (`_foo`) are private to the library, not just to the file. This is structurally similar to Go's capitalization convention but inverted (underscore for private rather than capitalization for public).

Imports use URI specifiers: `import 'dart:io';` for SDK libraries, `import 'package:foo/foo.dart';` for pub packages, `import 'src/helpers.dart';` for relative paths. The `package:` scheme is resolved by the pub package manager via `pubspec.yaml` and a `.dart_tool/package_config.json` file generated at `pub get` time.

Dart supports `show` and `hide` clauses on imports (`import 'foo.dart' show Bar, Baz;` or `import 'foo.dart' hide Internal;`), an `as` clause for prefixing (`import 'foo.dart' as f;`), and an `export` directive for republishing. The `deferred as` form supports lazy loading on web and AOT-compiled mobile, so a library's code is only loaded when it is first referenced — relevant for code-splitting large applications.

The `part`/`part of` system is unusual. A `part` file is *not* its own library; it is a syntactic continuation of the parent library, sharing the parent's privacy and import scope. This is similar to C++ separate compilation units that share a translation context, but expressed at the source level. The part is mostly used for code generation: a build_runner-generated `*.g.dart` file is typically a `part of` the consuming library, letting it access private members for serialization, ORM, or freezing.

Source: https://dart.dev/language/libraries and https://dart.dev/tools/pub/dependencies and https://dart.dev/language/built-in-types#part-and-part-of

### 9.5. Nim — File-as-Module with `*` Export Marker

Nim's module surface is among the simplest in the survey. Every `.nim` file is automatically a module; there is no module declaration syntax. Imports use `import foo`, qualified imports use `from foo import bar`, and selective imports use `from foo import bar, baz`. The module is identified by its filename (without extension), and imports are resolved through the package path or relative paths.

The export mechanism is uniquely terse: a single asterisk (`*`) after a declared identifier marks it as exported. `proc foo*(x: int): int = ...` exports `foo`; `proc bar(x: int): int = ...` keeps `bar` private. This makes the export decision visible at the declaration site without a separate export list, and at the cost of one character of syntactic noise. Nim also supports `include "file.nim"` for textual inclusion (sharing scope with the includer), `from foo import nil` to import a module without bringing names into scope, and `export foo` to re-export an imported module's public names.

Nim's package manager is **Nimble**, which uses `.nimble` files for package metadata. Packages can declare dependencies on other Nimble packages and are resolved by Nimble's solver against the published index.

The design lesson is that **a tiny per-declaration export marker can replace export lists entirely** if the language is willing to make the marker mandatory at every public declaration. The trade-off is a small visual noise floor on every public symbol; the benefit is that the export decision is locally visible and reviewable.

Source: https://nim-lang.org/docs/manual.html#modules and https://nimble.directory/ and https://nim-lang.org/docs/manual.html#modules-export-marker

### 9.6. Elm — Strict Static Modules with No Cycles

Elm pushes the static-graph philosophy to an unusually strict extreme. Every Elm file declares its module name explicitly (`module Foo.Bar exposing (..)`), and the module name *must* match the file path. Imports are static (`import Foo.Bar exposing (baz)`), and the language **forbids cyclic imports outright** — if `Foo` imports `Bar` and `Bar` imports `Foo`, the compiler rejects the program. This is structurally similar to Go's package-cycle rule but enforced at the module-file level rather than the package level.

Modules use **exposing** lists to control visibility: `module Foo exposing (bar, Baz)` exposes only the named items; `module Foo exposing (..)` exposes everything (discouraged for libraries); `module Foo exposing (Baz(..))` exposes a type and all its constructors. The granularity matters because Elm's type system relies on exposed-or-hidden type constructors to enforce opaque types — a library can expose a type `Money` without exposing its `Money Int` constructor, forcing consumers to use the library's smart constructors.

Elm's package manager publishes to `package.elm-lang.org` and enforces **strict semantic versioning**: the publishing tool diffs the public API and rejects patch-version publishes that change the API surface. This is unusual — most ecosystems put SemVer compliance on the publisher's discretion. Elm makes it a tooling-level guarantee.

The module-system-relevant lesson is that **forbidding cycles at the file level, not just the package level**, is feasible if the language is willing to enforce it. Elm's pure-functional design helps (no mutable singletons that benefit from cycle tolerance), but the discipline transfers to other static-functional designs.

Source: https://elm-lang.org/docs/style-guide and https://package.elm-lang.org/help/design-guidelines and https://elm-lang.org/docs/syntax#modules

### 9.7. F# — File Order Matters and Compilation Units

F# is the most distinctive entry in this chapter because **file order in the project file is part of the language's semantics**. F# compiles source files top-to-bottom in the order listed in the `.fsproj` file, and a declaration in file `B.fs` cannot reference a declaration in file `C.fs` if `C.fs` appears below `B.fs`. There is no forward declaration. Cycles between files are impossible because the compiler simply does not allow a later file's declarations to be visible to an earlier one.

This is the mirror image of every other module system in this survey: rather than letting the import graph emerge from declarations and then validating acyclicity, F# imposes a strict total order at the project level and lets imports respect it for free. The benefit is striking compile-time and reasoning simplicity — there is no possibility of complex dependency cycles, and the order is humanly visible in the project file. The cost is that refactoring (moving declarations between files) sometimes requires reordering the project, and large projects can have project files thousands of lines long.

F# also has `module Foo` and `namespace Foo` declarations. Modules are compilation-unit organizers (a file can be one module or several); namespaces are CLR-level namespaces inherited from .NET. The `[<AutoOpen>]` attribute on a module makes its contents implicitly imported when the enclosing namespace is referenced — a controlled mechanism for global-feeling helpers without polluting every consumer's import list.

The design lesson is that **strict file ordering eliminates entire classes of module-system complexity** at the price of project-file ergonomics. Most languages would never accept this trade-off, but for a language whose audience already accepts strict editor-driven workflows (F# users typically use Visual Studio or Rider, both of which display file order graphically), it works.

Source: https://learn.microsoft.com/en-us/dotnet/fsharp/language-reference/modules and https://learn.microsoft.com/en-us/dotnet/fsharp/language-reference/namespaces and https://learn.microsoft.com/en-us/dotnet/fsharp/style-guide/component-design-guidelines

### 9.8. Crystal, Pony, and Zig's Build-System Module Story

Three smaller-scope mentions worth grouping together.

**Crystal** uses `require "foo"` for textual inclusion-style imports, where `require` reads and evaluates the named file once (idempotent via a load-set). Modules are declared with `module Foo ... end` and form hierarchies (`Foo::Bar`). The combination is similar to Ruby's `require` plus Ruby's modules but with static type checking and AOT compilation. Shards is the package manager.

**Pony** has a strict per-package-directory model (one directory = one package, every `.pony` file in the directory is part of that package) plus capability-based reference types (covered in `MEMORY.md §1.10`). The module system itself is straightforward; the distinctive work happens at the type-system level with reference capabilities being the unit of authority.

**Zig's package story** is worth re-examining as a build-system pattern rather than just a language feature. Since Zig 0.11 (August 2023), the `build.zig.zon` file declares package dependencies with content-hash identity. The Zig package manager fetches by URL plus hash, validates the content, and exposes packages as named modules in `build.zig`. This makes Zig's package management entirely build-graph-driven: there is no central registry, no semantic-versioning resolver, just URLs and hashes. The trade-off is reproducibility (any URL with the right hash works, any URL with the wrong hash fails) versus discovery (no central index of available packages).

Source: https://crystal-lang.org/reference/syntax_and_semantics/requiring_files.html and https://tutorial.ponylang.io/packages/ and https://ziglang.org/download/0.11.0/release-notes.html#Package-Management

### 9.9. Raku — `auth`/`ver`/`api` Identity, Repository Chain, and the fez/zef Ecosystem

Raku has the most ambitious distribution-identity model in this survey. A distribution is identified by a four-tuple expressed inline in import statements: `Foo::Bar:ver<0.0.42>:auth<zef:lizmat>:api<2.0>:from<Perl5>`. The `auth` field names the publishing authority (typically `zef:user`); `ver` is the version; `api` marks API-compatibility level (incrementing it signals a breaking change without bumping `ver`); `from` is an interop tag (e.g. `Perl5` for modules accessed via `Inline::Perl5`). This is the only mainstream system where consumers can require *exactly one* among multiple distributions sharing a name but differing in `auth` — `use HTTP::Tiny:auth<zef:alice>` and `use HTTP::Tiny:auth<zef:bob>` resolve to distinct artifacts.

Three distinct keywords govern loading. `use` performs compile-time load + import (looking for `.rakumod` files). `need` performs compile-time load only, without importing names into the lexical scope — useful when you want a module's compunit available for fully-qualified reference but no name pollution. `require` performs runtime load + lexically-scoped import — symbols enter the local lexical scope, not the package scope. The distinction between *loading* (making a compunit available) and *importing* (making symbols visible) is sharper than in any other production language.

The resolution mechanism is the **`$*REPO` chain**: a linked list of `CompUnit::Repository` objects, each implementing a `need` method that may resolve the request or delegate to its successor. The standard chain is `core → vendor → site → home`. `CompUnit::Repository::FileSystem` is the development-mode repo (no version awareness, maps short names to file paths). `CompUnit::Repository::Installation` is the production repo (version-aware, auth-aware, content-addressed). Custom repos are ordinary Raku objects — significantly more flexible than Python's `sys.path` finder/loader machinery, because each repo can decide what to delegate, what to refuse, and what to virtualize.

`META6.json` carries `provides`, `depends`, `build-depends`, `test-depends`, `tags`, `auth`, `ver`, `api`. The `provides` map is the crucial part: it declares an explicit mapping from `use`-target name to file path, decoupling filesystem layout from importable name. A distribution can put its source in `lib/foo.pm` and provide `Foo::Bar` to importers — the filename and the import name need not match. Only modules listed in `provides` are installable.

The **fez/zef ecosystem** (current Raku module ecosystem, replacing CPAN and the older p6c) validates `auth` against the uploader's identity, rejects distributions with version `*` (a poisoning attack — `*` would supersede every other version), enforces one-upload-per-(dist, version), and serves a JSON master index from `360.zef.pm/index.json`. `fez upload` publishes; `zef install` consumes. The `auth` validation closes a class of supply-chain attacks that was viable on CPAN, where uploaders could put arbitrary `auth` values in their META.

The design lesson generalizes beyond Raku: **if the ecosystem allows multiple distributions of the same name to coexist, identity must be a tuple, not a string**. Raku's choice to make the tuple visible in the import syntax itself is unusual but principled — it means a security-conscious importer can pin `auth` directly without consulting external lockfiles. Full treatment of Raku's multi-dispatch, subsets, roles, and type-object design lives in `TYPES.md §6.6`; full treatment of Raku schedulers, promises, supplies, channels, `react`, `whenever`, and continuation-based `await` lives in `CONCURRENCY.md §11.6`.

Source: https://docs.raku.org/language/modules and https://docs.raku.org/language/distributions/configuration-structure and https://docs.raku.org/language/compilation and https://github.com/ugexe/zef and https://deathbyperl6.com/fez-zef-a-raku-ecosystem-and-auth/

### 9.10. Forth — Wordlists, the Search-Order Stack, and `DEFINITIONS`

Forth's module mechanism (the "Search-Order word set" of Forth-2012, optional but ubiquitous) is fundamentally unlike anything else in this survey. There is no `import` declaration, no module file format, no package manifest — just a stack of *wordlists* (named-word dictionaries) that the text interpreter searches in order.

The primitives:

- `WORDLIST` creates a new empty wordlist and returns its identifier (a `wid`).
- `SET-ORDER` ( widn ... wid1 n -- ) sets the search order to the listed wordlists, with `wid1` searched first.
- `GET-ORDER` ( -- widn ... wid1 n ) reads the current search order.
- `ALSO` duplicates the top of the search-order stack — adding a "scratchpad slot" to override below.
- `PREVIOUS` removes the topmost wordlist from the search order.
- `ONLY` resets to the implementation-defined minimum order (must include `FORTH-WORDLIST` and `SET-ORDER`).
- `FORTH` pushes the standard `FORTH-WORDLIST` onto the search order.
- `DEFINITIONS` makes the current top-of-search-order also be the *compilation* wordlist — newly defined words go into it.

The model: programmers manipulate the search-order stack imperatively, often within a single source file. To define editor commands without polluting the main namespace, one creates an editor wordlist, pushes it via `ALSO`, defines words while it's at the top of the search order, then pops it with `PREVIOUS`. The result is a transient namespace that exists only within a lexical region of the source.

The text interpreter searches each wordlist from newest definition to oldest — so a later definition shadows an earlier one of the same name *within* a wordlist, and an earlier wordlist on the search-order stack shadows a later one. This is essentially a manually-managed lexical-scope stack, with the programmer responsible for pushing and popping.

Gforth and several modern Forths layer additional features. **Gforth** retains the older `vocabulary` word (a wordlist plus a defining word that pushes itself onto the search order when invoked) and integrates wordlists into its **recognizer** system, so that `voc1:voc2:word` qualified syntax works as a recognizer pattern: search the topmost recognizer for `voc1`, search inside `voc1` for `voc2`, look up `word` inside `voc2`. This is a path-syntax overlay on what's structurally a stack-of-tables.

The Gforth manual is unusually candid about the trade-offs: "trying to modularize programs in this way has disadvantages for debugging and reuse/factoring that overcome the advantages in my experience." The critique echoes a recurring concern with stack-of-namespaces designs — that "what does this name resolve to right now?" depends on the current search-order state, which is harder to reason about than a static import list. Forth's defenders note that the same property allows transient editor/assembler namespaces with no per-file ceremony.

The lesson: **stack-of-tables is a viable module-system primitive for languages where source order and execution order are deliberately fused** (Forth's `:` definitions are immediately compiled and added to the top wordlist). It is poorly suited to languages with separate compilation, deferred linking, or static reasoning about visibility. Full treatment of stack-effect type systems in the Forth/Factor family lives in `TYPES.md §9.4`; Forth-family multitasking, mailboxes, and CSP-style channels live in `CONCURRENCY.md §7.5`.

Source: https://forth-standard.org/standard/search and https://gforth.org/manual/Word-Lists.html and https://gforth.org/manual/Wordlists-and-Search-Order-Tutorial.html and https://www.complang.tuwien.ac.at/forth/gforth/Docs-html-history/0.6.2/Why-use-word-lists-.html

### 9.11. Factor — Vocabularies, `USING:`, and Ambiguous-Use Errors

Factor is the modern concatenative language that took Forth's wordlist-stack idea and replaced it with a declarative module system. A *vocabulary* is Factor's module unit: a directory containing one or more `.factor` files plus optional metadata. Vocabularies form a flat namespace identified by dotted names: `kernel`, `math.functions`, `sequences`, `io.files`.

The import syntax replaces Forth's stack manipulation with declarative directives:

- `USE: kernel` — add a single vocabulary to the search path, loading it if necessary.
- `USING: kernel math sequences ;` — add multiple vocabularies (most common form).
- `IN: my.app` — set the current vocabulary (where new definitions go).
- `QUALIFIED: math.functions` — make `math.functions` accessible only via `math.functions:NAME` qualified syntax, no unqualified imports.
- `FROM: math.functions => sin cos ;` — selective import of named words.
- `EXCLUDE: kernel => 2drop 3drop ;` — import all except the listed words.
- `RENAME: drop kernel => discard ;` — import a word under a different name.
- `MAIN: my.app:run` — declare the entry point for an executable vocabulary.

The distinctive Factor mechanism is the **ambiguous-use-error**. If a name resolves to multiple imported vocabularies, the parser raises an error rather than silently picking one. The user must disambiguate via `vocabulary:word` qualified syntax. This is the inverse of Forth's "first-found wins" search-order semantics — Factor refuses to guess. The trade-off is that adding a `USE:` can break existing code by introducing an ambiguity, but the failure mode is loud rather than silent.

Vocabularies live under root directories (`vocab-roots`), conceptually the JVM classpath analog. Factor ships four roots: `core` (essential bootstrap vocabularies), `basis` (standard libraries), `extra` (community contributions), `work` (user code). Additional roots can be added via `add-vocab-root` or in `.factor-rc`. Loading is via `require` (load-once-and-cache) or `reload` (force reload from disk).

The contrast with Forth is sharp. Forth's wordlists are runtime data structures the programmer manipulates with imperative stack operations; Factor's vocabularies are declarative compile-time entities resolved by the parser. Factor inherits Forth's word-as-named-definition unit and the textual stack-effect model, but builds a Rust-or-Haskell-style declarative module system around them. This is part of why Factor feels accessible to non-Forth programmers despite being concatenative.

Factor's optimizing compiler (covered in `COMPILERS.md §32`) operates over fully-resolved vocabulary references, which is what makes whole-program type inference and inlining tractable across vocabulary boundaries — a property the Forth wordlist model would make significantly harder.

Source: https://docs.factorcode.org/content/article-tour-vocabularies.html and https://docs.factorcode.org/content/article-vocabs.loader.html and https://docs.factorcode.org/content/article-vocabs.roots.html and https://docs.factorcode.org/content/word-USE__colon__%2Csyntax.html

### 9.12. D — `module foo.bar;`, Package Access, and `version()` Conditional Compilation

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

Source: https://dlang.org/spec/module.html and https://dlang.org/spec/attribute.html#visibility_attributes and https://dlang.org/spec/version.html and https://dub.pm/

### 9.13. Lean 4 — `import`, `namespace`, `section`, `open`, `export`

Lean 4 is a research-adjacent dependently-typed proof assistant and programming language with a mature, conventional module system — interesting because Lean's macro and elaboration system is heavily Racket-influenced (covered in `PARSERS.md §2.22`) yet the module language deliberately *did not* inherit Racket's phase tower.

The structure:

- **`import Foo.Bar`** at the top of a file loads another module. Modules are file-shaped: `Foo/Bar.lean` is the source for `Foo.Bar`. Imports are transitive — `import Foo.Bar` transitively imports everything `Foo.Bar` imports.
- **`namespace Foo ... end Foo`** opens a hierarchical naming scope. Declarations inside become `Foo.X`. Namespaces nest and can span multiple files.
- **`section ... end`** is a non-namespace scope — useful for `variable` declarations that should affect a group of definitions without becoming part of the namespace.
- **`open Foo`** brings unqualified access to names in `Foo` into the current scope. Like Haskell's `import Foo` (without `qualified`).
- **`export Foo (a b c)`** re-exports specific names from `Foo` into the current namespace, making them accessible to clients via the current namespace name.

The crucial design point: **Lean modules participate in instance resolution.** Instance declarations (`instance : Add Nat where ...`) are scoped: an instance declared in module `Foo` is only visible to clients that `import Foo`. This makes the module system part of typeclass resolution semantics, not just naming. A client can have one notion of `Add Nat` if it imports `Foo.Standard` and a different notion if it imports `Foo.Modular` — instance-set determined by the import graph, not by global registration.

This is closer to Rust's coherence-by-orphan-rule than to Haskell's open-world type-class assumption. Combined with Lean's macro hygiene, the module system also controls macro visibility — a `macro_rules` declaration is visible exactly where the namespace it's declared in is `open`'d.

Lake is the package manager, with `lakefile.lean` (Lean source for the build configuration) or `lakefile.toml`. Mathlib (the community math library) is the largest Lean ecosystem and uses a single-package model with hundreds of namespaces.

The lesson: **a conventional namespace-import module system can support sophisticated typeclass/instance/macro scoping without adopting Racket-style phase machinery.** Lean's choice to keep the module system simple while making it semantically load-bearing for instance resolution is a viable middle ground.

Source: https://lean-lang.org/lean4/doc/setup.html and https://lean-lang.org/theorem_proving_in_lean4/interacting_with_lean.html and https://lean-lang.org/lean4/doc/whatsnew.html and https://leanprover-community.github.io/

### 9.14. R — NAMESPACE Files and Method Dispatch Interaction

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

Source: https://cran.r-project.org/doc/manuals/r-release/R-exts.html#Package-namespaces and https://r-pkgs.org/namespace.html and https://cran.r-project.org/web/packages/policies.html

### 9.15. Design Lessons from Additional Production Languages

The systems in this chapter add several specific lessons not covered by chapters 3–8:

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

A new language can pick from this menu without committing to any single ecosystem's full module system. Symbol-table-and-namespace lessons from Perl 5, Common Lisp, Clojure, and Tcl now live with the rest of the runtime-import family in §4.9; specification/body and Wirth-lineage lessons from Ada, Modula-2/3, and Oberon live with the typed family in §5.7.

---

## 10. Research and Advanced Module Calculi

The languages in chapters 3–9 are all production systems that compromise expressive power for ecosystem viability. The research lineage in this chapter is the opposite: each entry pushes the module system in a particular formal direction, often producing systems that are conceptually beautiful but never widely deployed. They matter to a new-language designer not as templates to imitate, but as upper bounds on what a module system *could* be — and as cautions about which kinds of expressive power are not worth the cost.

### 10.1. Standard ML Module Calculus — The Classical Foundation

The Standard ML module system, formalized by MacQueen and others through the 1980s and presented in its mature form in the SML97 Definition, is the foundational reference for typed module calculi. Its three-layer structure — **structures** (implementations), **signatures** (interfaces), and **functors** (parameterized modules) — became the vocabulary every later module-system researcher builds against or reacts to.

The technical depth that production languages have not absorbed is substantial:

- **Sharing constraints and `where type` clauses**: when two functors must be applied to structures whose abstract types are equal, the signature can express that equality directly (`functor F(X : SIG where type t = int)`), letting the type checker enforce it without the user choosing a specific implementation.
- **Translucent vs opaque ascription**: SML distinguishes `S : SIG` (transparent — the signature constrains what is visible but lets the user see through to concrete types) from `S :> SIG` (opaque — the signature creates a strict abstraction barrier). Most production languages have only one form.
- **Generative vs applicative functors**: see §10.7.
- **Higher-order functors**: functors that take and return functors, enabling abstraction over abstraction patterns.

Production languages have absorbed signatures-and-modules but largely not the full machinery. OCaml is the closest to SML's expressivity (and adds first-class modules), but even OCaml's mainstream usage rarely exercises sharing constraints or opaque ascription deeply. The lesson is that module-calculus expressivity has a practical ceiling — the marginal user cost of each additional feature exceeds the marginal benefit at some point, and that point is reached fairly early.

Source: https://smlfamily.github.io/sml97-defn.pdf and http://www.cs.cmu.edu/~rwh/smlbook/book.pdf and https://homepages.inf.ed.ac.uk/dts/fps/papers/MacQueen.pdf

### 10.2. 1ML — Unifying Modules and Core

Andreas Rossberg's **1ML** (ICFP 2015, with subsequent refinements) is the most ambitious modern attempt to *unify* the ML module language and the ML core language. In ordinary ML, the module language and the core (term/type) language are distinct: types are in the core, signatures are in the module language; values are in the core, structures are in the module language. They use different syntax, different binding mechanisms, and different scoping rules. 1ML demonstrates that this dichotomy can be eliminated: in 1ML, **modules are first-class values, signatures are first-class types, functors are ordinary functions**, and the core/module distinction collapses into one language.

The technical move that makes this work is treating signatures as a particular form of (large) type and modules as values of those types. Type abstraction is recovered through existential quantification, and applicative-vs-generative functor distinctions are recovered through choice of polymorphism mode (predicative vs impredicative). The result is a language whose module system is as expressive as full SML modules but expressed with no separate module syntax.

1ML is not a production language. Its significance for a new-language designer is conceptual: it shows that the apparent need for "two languages" (core + module) is not fundamental, and that a sufficiently expressive single language can absorb the module system. Most production languages will not benefit from this — the two-language style is what makes ML modules approachable — but the existence proof matters because it bounds what is necessary.

Source: https://people.mpi-sws.org/~rossberg/1ml/1ml.pdf and https://people.mpi-sws.org/~rossberg/

### 10.3. Modular Implicits — Type-Class-Style Inference for OCaml

White, Bour, and Yallop's **Modular Implicits** (ML Workshop 2014) propose extending OCaml with a mechanism for *implicitly* applying functors to their argument structures, similar to how Haskell elaborates type-class instances. The user writes `show 42` and the elaborator searches the visible scope for a structure matching `SHOW with type t = int`, applying the appropriate functor automatically.

This is conceptually significant because it shows that **type classes and module systems are duals** in a precise sense. Type classes are dictionaries-passed-implicitly; ML modules are dictionaries-passed-explicitly. Modular implicits make ML modules participate in implicit elaboration, recovering type-class ergonomics without abandoning the module-calculus foundation. Scala's implicits (Scala 2) and `given`/`using` (Scala 3) are independent designs in the same conceptual space; Rust's traits are another point.

The proposal has not landed in mainline OCaml, partly because the elaboration semantics interact subtly with OCaml's existing type inference and module language. The design space remains open: OCaml's existing first-class modules cover some of the use cases, and the community has debated whether implicit modules add enough value to justify the language complexity.

Source: https://arxiv.org/abs/1512.01895 and https://www.cl.cam.ac.uk/~jdy22/papers/modular-implicits.pdf and https://www.lpw25.net/

### 10.4. Backpack — Indefinite Modules and Mixin Linking for Haskell

**Backpack** (Kilpatrick, Dreyer, Peyton Jones, Marlow — POPL 2014) is GHC's mixin module system, motivated by the longstanding limitation that Haskell cannot express "this module depends on a module of this signature" without either dependency-injecting through type-class dictionaries or hand-coding boilerplate. Backpack adds **indefinite modules** (modules with unfilled holes that match a signature) and **module instantiation at link time**.

The design pattern is straightforward: a library can expose a signature `Stream` and an indefinite implementation that depends on `Stream`-matching modules. Downstream consumers instantiate the library with their preferred concrete `Stream` implementation, and the result is a fully linked module. This is closer to ML functors than to type classes, but operating at the package layer rather than the module-language layer.

Backpack landed in GHC 8.2 (2017) but has seen modest adoption. The mainstream Haskell answer to "abstraction over implementations" remains type classes, partly because Cabal's tooling integration with Backpack remained rough for years. The lesson is that **module-level mixin linking can be a powerful alternative to type classes**, but it competes with an entrenched mechanism and needs strong tooling to win adoption. A new language that has no entrenched type class system can choose mixin modules cleanly; one that already has type classes faces an uphill migration.

Source: https://plv.mpi-sws.org/backpack/backpack-popl.pdf and https://gitlab.haskell.org/ghc/ghc/-/wikis/backpack and https://wiki.haskell.org/Backpack

### 10.5. MixML and Recursive Mixin Modules

Derek Dreyer's **MixML** (Dreyer-Rossberg, ICFP 2008) and the broader mixin-module tradition (Bracha-Cook 1990; Flatt-Felleisen 1998; Hirschowitz-Leroy 2002) explore module systems whose primary composition operator is *mixin merging* rather than functor application. A mixin module declares both required imports (slots to be filled) and provided exports; mixing two modules unifies their slots and exports, propagating type identities and recursively composing.

The key technical contribution of MixML is **type-safe recursion across module boundaries**. Two modules can mutually depend on each other through their interfaces if their mixin composition resolves all slots. This is structurally similar to Backpack's indefinite modules but with composition as the primitive operator rather than instantiation.

Mixin modules have not landed in any major production language. Scala's traits are loosely inspired by the same lineage but operate at the value/class level, not the module level. The lesson is that **recursive cross-module dependency is solvable with the right algebraic structure**, but production languages have generally chosen to ban cycles instead — a much simpler answer that loses some expressivity but vastly simplifies implementation and comprehension.

Source: https://people.mpi-sws.org/~dreyer/papers/mixml/icfp08.pdf and https://www.mpi-sws.org/~dreyer/

### 10.6. Newspeak — Modules as Parameterized Top-Level Classes

Gilad Bracha's **Newspeak** uses a fundamentally different module model from any other language in this survey. Newspeak has **no global namespace and no static state**. Top-level classes are parameterized over the modules they need: a top-level class declaration is effectively a module that takes its dependencies as constructor arguments. Instantiating the top-level class binds it to specific dependency implementations, and the resulting object *is* the module instance.

This is ocap modularity (covered in `MEMORY.md §10`) lifted to the language's primary modularity mechanism. The consequences are radical: modules cannot hold mutable global state (there are no globals), modules can be parameterized over their dependencies without any ad-hoc dependency-injection framework, and module composition is just object construction. Multiple instances of "the same module" can coexist with different dependency bindings, supporting test isolation, sandboxing, and live-update patterns naturally.

Newspeak is small and academic, but its design has influenced E, Caja, SES (now Hardened JavaScript via TC39), and the broader ocap tradition. The lesson is that **fusing "module" and "object" in this way is internally consistent and produces a remarkably clean ocap story**, but it requires the language to commit to no-global-state from day one. Retrofitting it onto a language with existing globals or singleton modules is essentially impossible.

Source: https://newspeaklanguage.org/ and https://bracha.org/newspeak.pdf and https://bracha.org/newspeak-modules.pdf

### 10.7. Applicative vs Generative Functors

A subtle but practically important distinction in the ML module tradition is **applicative** vs **generative** functor application. The question is: when a functor `F` is applied twice to the same argument structure `M`, do `F(M)` and `F(M)` produce the *same* abstract type, or *fresh* abstract types?

- **Applicative functors** (OCaml's default): `F(M).t` and `F(M).t` are the same type. Two applications to the same argument produce equivalent results.
- **Generative functors** (SML's default; OCaml when the functor body has effects): each application produces fresh abstract types. `F(M).t` from one application is a different type from `F(M).t` from another.

This matters when functors are used to implement abstract data types like sets or maps. Applicative semantics means a `Set(IntOrder)` produced in one module is interchangeable with `Set(IntOrder)` produced in another. Generative semantics means they are distinct types — a deliberate choice when the functor allocates global state, refs, or other side-effecting resources that must not be shared.

OCaml supports both: `module F (X : SIG) = struct ... end` is applicative when pure; `module F (X : SIG) : sig ... end = struct ... end` (with sealing) is generative. Programmers must understand the distinction to write correct abstract-type abstractions in OCaml.

The design lesson is that **module application semantics is a language-design choice**, not just an implementation detail. A new language that introduces functors must decide whether default behavior is applicative (more usable, but rules out mutable state in functor bodies) or generative (more flexible, but every application produces a fresh type).

Source: https://v2.ocaml.org/manual/moduleexamples.html#s:applicative-functors and https://people.mpi-sws.org/~dreyer/papers/dreyer/thesis.pdf

### 10.8. First-Class Modules

OCaml supports **first-class modules**: a module can be packaged into a value of type `(module SIG)`, passed as a function argument, stored in a data structure, and unpacked back into a module at the call site. This bridges the gap between the module language and the core language without going as far as 1ML's full unification.

```ocaml
let make_set : type a. (module COMPARABLE with type t = a) -> a list -> a list =
  fun (module Cmp) xs -> List.sort_uniq Cmp.compare xs
```

Here `(module Cmp)` is a first-class module value pattern. The argument is supplied as `(module IntComparable)`. This is closer to dependency injection than to traditional functor application: the dependency is chosen dynamically at runtime, not statically through functor application.

First-class modules have been in OCaml since 3.12 (2010) and are the substrate behind several library patterns (e.g., the `(module Show)` argument idiom, certain monadic frameworks). They demonstrate that the gap between the module language and the core language can be bridged pragmatically without committing to 1ML's full unification.

Source: https://v2.ocaml.org/manual/firstclassmodules.html and https://dev.realworldocaml.org/first-class-modules.html

### 10.9. Scheme R6RS / R7RS Libraries — The Canonical Declarative Module Form

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

The lesson generalizes: **a small fixed set of import refinement operators (only/except/prefix/rename) covers virtually every selective-import pattern**, and a new language can adopt the R6RS/R7RS vocabulary without inventing a parallel set. The cost is minor: ~four import-form keywords to specify and document.

Source: https://www.r6rs.org/final/html/r6rs/r6rs-Z-H-10.html and https://small.r7rs.org/attachment/r7rs.pdf and https://standards.scheme.org/corrected-r7rs/r7rs-Z-H-7.html and https://standards.scheme.org/corrected-r7rs/r7rs-Z-H-12.html

### 10.10. Agda and Idris 2 — Dependent-Type Modules and Records-as-Functors

In dependently-typed languages, the boundary between modules and records dissolves: a module is a record, and a record can have fields that are themselves types or proofs that depend on earlier values. This makes ML-style functors a *special case* of ordinary record construction, with the parameter list being a telescope of dependent values rather than a fixed signature.

**Agda's parameterized modules** are the cleanest example:

```agda
module Stack (A : Set) where
  data Stack : Set where
    empty : Stack
    push  : A → Stack → Stack

  pop : Stack → Maybe (A × Stack)
  pop empty       = nothing
  pop (push a s)  = just (a , s)
```

`module Stack (A : Set) where ...` declares a module parameterized by a type `A : Set`. Instantiation is by passing the parameter: `module IntStack = Stack Nat`. This is structurally identical to an ML functor, but the parameter list can include dependent types — a parameter's type can mention earlier parameters' values:

```agda
module Vector (A : Set) (n : Nat) where
  -- n is in scope as a Nat value, not just a type parameter
```

ML functors can't express this — you can't have an ML functor `F` whose parameter type depends on a *value* parameter, because ML's value/type strata are separate. Agda's modules collapse the strata.

Other Agda module features:

- **`open M`** brings the contents of module `M` into the current scope; `open M public` re-exports them.
- **Anonymous modules** for local namespace scopes: `module _ where ...` introduces names without naming the module.
- **`open M using (foo)` / `hiding (bar)` / `renaming (foo to baz)`** — the same import refinements as R6RS Scheme (§10.9).
- **`record` declarations are first-class modules.** A `record Point where field x : Nat; y : Nat` is both a record type and a module, with `Point.x` and `Point.y` as projection functions.

**Idris 2** inherits a similar model and adds **interfaces** (Idris's name for typeclasses) which are themselves a module-like construct: an `interface Eq a where ...` declares a record-of-functions parameterized by `a`, and an `implementation Eq Nat where ...` constructs an instance of that record. Interface resolution is structural — finding an `Eq Nat` instance is finding a record with the right type. This is the dependent-type version of Haskell's typeclass resolution but structurally different from Lean 4's instance scoping (§9.13): Idris uses search-based resolution over the available implementations, Lean uses scoped registration via imports.

The lesson for module-system design is sharp: **once the language has dependent types, modules don't need to be a separate construct from records**. ML's three-stratum split (values, types, modules) collapses to one (values, where types and modules are values of certain types). The cost is that the type system now has to handle records-with-types-and-proofs as ordinary terms, which is a substantial commitment. The benefit is conceptual unification — there's no separate "module language" because modules are just records.

For a non-dependently-typed language, this isn't directly applicable, but the contrast clarifies what ML's stratified module language is *for*: it's an explicit second language because the core language can't express type-of-type fields. A new language that adopts dependent types early can skip the stratified module design entirely.

Source: https://agda.readthedocs.io/en/latest/language/module-system.html and https://agda.readthedocs.io/en/latest/language/record-types.html and https://idris2.readthedocs.io/en/latest/tutorial/modules.html and https://idris2.readthedocs.io/en/latest/tutorial/interfaces.html

### 10.11. Design Lessons from Research Module Calculi

The research tradition produces several specific lessons for new-language design:

- **Module systems can be unified with the core language** (1ML), but production languages generally choose not to, because the two-language structure is more approachable.
- **Implicit module elaboration is feasible** (modular implicits), and overlaps significantly with type classes; languages should choose one or the other, not both.
- **Mixin module composition is more expressive than functor application** (Backpack, MixML), but production languages have generally chosen the simpler model.
- **The applicative/generative functor distinction is a real semantic choice** (OCaml vs SML defaults), and any language with parameterized modules has to take a position.
- **First-class modules are a useful pragmatic compromise** between the two-language ML style and full 1ML unification.
- **Modules-as-objects-with-no-globals** (Newspeak) is the cleanest ocap module design but requires no-global-state from day one.
- **Canonical declarative import refinements** (R6RS/R7RS Scheme): the four-operator vocabulary `only`/`except`/`prefix`/`rename` covers virtually every selective-import pattern, and a new language can adopt it without reinventing the wheel.
- **Dependent types collapse the module/record distinction** (Agda, Idris 2): once values and types live in one universe, ML's stratified module language becomes redundant — modules are just records with type-of-type fields. This only works if the language commits to dependent types from the start; it isn't retrofittable onto a stratified core.

The deepest lesson is that **module-system expressivity has a steep diminishing-returns curve**. SML-level expressivity (signatures, functors, sharing constraints, opaque ascription) is the practical ceiling for production languages; everything beyond that is research-grade and rarely justifies its cost. A new language can do worse than aiming for "Rust + ML signatures" or "Go + functors" and stopping there — unless it commits to dependent types early, in which case the entire question dissolves into the core language.

---

## 11. Dynamic Loading, Plugins, and Hot Module Replacement

The chapters above treat modules primarily as compile-time or load-time concerns. This chapter covers what happens when a system needs to *load, swap, or unload modules at runtime* — for plugin architectures, live-coding workflows, hot deployment, or interactive development. The mechanisms differ sharply by language family, but they share a common challenge: the language's module identity model and the runtime's module-instance model must agree, or strange things happen at the boundary.

### 11.1. Native Shared Libraries — `dlopen`/`LoadLibrary` and Symbol Resolution

POSIX `dlopen(path, flags)` and Windows `LoadLibrary(path)` are the lowest-level dynamic-module mechanisms. The OS loads the shared object (`.so`/`.dylib`/`.dll`) into the calling process's address space, resolves symbol references against the global symbol table, and returns a handle. `dlsym(handle, name)` looks up a named symbol; `dlclose(handle)` decrements the reference count and may unload.

The mechanism is the substrate beneath higher-level dynamic-loading systems but is itself extremely raw. It has no notion of types, versions, or module identity beyond filename. Symbol name conflicts between concurrently-loaded libraries are managed by per-library namespaces (`RTLD_LOCAL`) or accepted as global shadowing (`RTLD_GLOBAL`). C++ name mangling, which encodes class and namespace structure into symbols, is the closest the C/C++ ecosystem comes to enforcing module identity at the dynamic-loading layer.

The `dlopen` model is the hot-reload primitive used by game engines (covered in `COMPILERS.md §23.5` from the runtime angle), database extensions (PostgreSQL `LOAD`, SQLite virtual tables), and traditional plugin architectures. The general pattern is: keep all mutable state in the host process, put only stateless logic in the reloadable shared object, and re-bind function pointers after each reload. The discipline is on the programmer; the language and OS provide only the loading mechanism.

Source: https://man7.org/linux/man-pages/man3/dlopen.3.html and https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibrarya

### 11.2. Java Class Loaders and OSGi

The JVM's runtime module mechanism is the **class loader hierarchy**. Each loaded class has an associated `ClassLoader`, and the loader's identity is part of the class's runtime identity — two `Foo` classes loaded by different loaders are distinct types from the JVM's perspective, even if they have identical bytecode. Class loaders form a parent-delegation chain by default: a class loader asks its parent before defining the class itself, ensuring that platform classes (`java.lang.String`) are always loaded by the bootstrap loader.

Custom class loaders enable rich dynamic-loading patterns: application servers (Tomcat, JBoss) use per-webapp loaders to isolate one app's class versions from another's; build tools use loaders to isolate compile-time plugins; Spring uses class loaders to support hot-deploy in development.

**OSGi** is the canonical formalization of dynamic module loading on the JVM. An OSGi bundle is a JAR with extra manifest metadata declaring which packages it imports and exports, with explicit version ranges. The OSGi runtime resolves imports against exports across all installed bundles, builds a per-bundle class loader graph, and supports starting, stopping, updating, and uninstalling bundles at runtime. This is the JVM's most ambitious module-system design and was developed independently of JPMS — they coexist with some friction. Eclipse, Apache Karaf, and many telecom platforms run on OSGi.

The lesson is that **dynamic module loading on a managed runtime requires the runtime to participate in module identity**. The JVM does this via class-loader-as-identity-component. The CLR does this via assembly load contexts (`AssemblyLoadContext`, .NET Core 3+). Languages without a managed runtime (C, Rust) cannot offer the same guarantees and rely on programmer discipline.

Source: https://docs.oracle.com/javase/8/docs/technotes/guides/lang/cl-mt.html and https://www.osgi.org/resources/architecture/ and https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext

### 11.3. Erlang Hot Module Reload

Erlang's hot reload is covered above (§9.2) and from the runtime side in `COMPILERS.md §23.1`. The module-system-relevant point is that **the language commits to flat, named, individually loadable modules from the start**, which makes the runtime mechanism possible without any retrofitting. The two-version-active rule — old version persists for in-flight calls, new version becomes current for new calls — is implemented at the BEAM VM layer and works because module names are global-flat, not nested-hierarchical-with-cycles.

A language that wants Erlang-style hot reload must commit early to: flat module identity, individually loadable artifacts, fully-qualified-call vs local-call distinction at the language level, and immutable per-process state (so reloading a module doesn't corrupt in-flight computations). All four are language-design choices, not runtime features added later.

### 11.4. Python `importlib.reload` and Plugin Patterns

Python supports module reloading via `importlib.reload(module)`, which re-executes the module's top-level code and updates the cached `sys.modules` entry. The mechanism is conceptually simple but practically tricky: existing references to module-defined classes, functions, or values continue to point at the *old* objects, while new lookups against the module find the *new* ones. The result is a running program with two coexisting versions of "the same" function.

For plugin architectures, the more common pattern is `importlib.import_module(name)` for dynamic discovery — typically driven by entry-point metadata (`entry_points` in `pyproject.toml`) that lets installed packages register plugins for a host application to discover. This is how Pytest discovers test runners, how Django finds installed apps, and how Sphinx loads extensions. The plugin model is a discovery mechanism layered on top of the standard import system, not a separate runtime mechanism.

The lesson is that **Python's runtime-import model trivially supports plugin discovery but only weakly supports hot reload**. The "old objects still in memory" problem is fundamental to the import-time-execution semantics; eliminating it would require changing how Python references resolve, which would break the language. A new language that wants both runtime imports and clean hot reload should either restrict reloading to specific patterns (Julia's Revise.jl handles this for development workflows) or commit to the Erlang-style flat-module architecture from day one.

Source: https://docs.python.org/3/library/importlib.html#importlib.reload and https://packaging.python.org/en/latest/specifications/entry-points/

### 11.5. JavaScript Dynamic `import()` and Module Federation

ECMAScript modules support **dynamic import** via the `import()` expression, which returns a promise resolving to the module record. This is the static-syntax equivalent of `require()` in CommonJS but with the same instantiation/evaluation semantics as static `import` declarations. Dynamic imports enable code splitting (load a module only when needed), conditional loading (load different modules based on runtime detection), and lazy initialization patterns.

**Webpack's Module Federation** (introduced 2020) extends this further: a federated module can expose modules to other federated modules at runtime, across separately-deployed bundles. Two independently-built React applications can share component implementations, with the runtime resolving "import the `Header` component from the remote `app1` federation" against whichever version `app1` happens to be serving. This is the closest the JavaScript ecosystem comes to OSGi-style runtime module composition.

The lesson is that **dynamic module loading composes with package-metadata-shaped resolution** (chapter 6.4): the same `package.json` `exports` map that determines static-import resolution also determines dynamic-import resolution, and the same loader configuration drives both. This is consistent but means the loader story has to be designed once for both static and dynamic paths.

Source: https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-module-system and https://webpack.js.org/concepts/module-federation/

### 11.6. Hot Module Replacement in Bundlers (HMR)

Webpack, Vite, esbuild, Parcel, and similar JavaScript bundlers support **Hot Module Replacement** during development: a code change rewrites only the affected modules, and the running browser receives the updated module record without a full reload. The mechanism layers on top of the bundler's dependency graph: the bundler tracks which modules depend on which, identifies the boundary of "modules that need to update," sends them to the browser over a WebSocket, and the runtime swaps them in.

HMR works best when modules accept replacement explicitly via `import.meta.hot.accept(...)` callbacks — the module declares "I know how to integrate the new version of myself" and the bundler honors that boundary. Without `accept`, the bundler walks up the dependency graph until it finds an accepting boundary or falls back to a full reload.

The general lesson is that **hot replacement requires explicit cooperation from the modules being replaced**. The runtime cannot blindly swap in new code; the module must declare what state survives the swap, what state is reset, and how external references are repointed. This is true for HMR in JS, for `code:load_file` in Erlang, for `Revise.jl` in Julia, and for live-coding patterns in C/C++ via `dlopen`. A new language that wants robust hot reload should make the cooperation primitive (the analogue of `import.meta.hot.accept`) part of the module-system design from day one.

Source: https://vitejs.dev/guide/features.html#hot-module-replacement and https://webpack.js.org/concepts/hot-module-replacement/ and https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules#hot_module_replacement

---

## 12. Build Systems, Workspaces, Lockfiles, and Registries

A module system is incomplete without the surrounding ecosystem of build tools, dependency resolvers, lockfiles, registries, and workspace structures. This chapter covers the layer above the language-level module system, where the practical experience of "how do I add a dependency?", "how do I build my project?", and "how do I publish?" actually plays out. The choices here often determine whether a language's module system feels lightweight or oppressive in everyday use.

### 12.1. Lockfiles and Reproducible Resolution

A **lockfile** records the exact versions of every transitively-resolved dependency at a moment in time, so that subsequent builds reproduce the same resolution regardless of subsequent registry changes. The lockfile is committed to source control alongside the project's manifest, and the package manager uses it as the authoritative source of truth in CI and on other developers' machines.

The dominant lockfile families:

- **`Cargo.lock`** (Rust) — TOML-formatted, listing every crate and version with content checksums. Recommended for binary projects, optional for libraries.
- **`package-lock.json`** / `yarn.lock` / `pnpm-lock.yaml` (Node) — three competing formats from npm, Yarn, and pnpm. They differ in resolution algorithms (npm and Yarn use nested-dependency trees historically; pnpm uses a flat content-addressed store with symlinks).
- **`go.sum`** (Go) — content hashes for every module version used, validated against a checksum database (`sum.golang.org`) to detect tampering.
- **`Pipfile.lock`** / `poetry.lock` / `uv.lock` (Python) — multiple competing formats with overlapping but not identical scope.
- **`Manifest.toml`** (Julia) — records the resolved versions of all packages in an environment.
- **`composer.lock`** (PHP), **`Gemfile.lock`** (Ruby), **`mix.lock`** (Elixir), etc.

The cross-cutting design questions are: does the lockfile include content hashes (cargo, go.sum yes; older formats no)? Is it regenerated deterministically given the same manifest and registry state (cargo and pnpm yes; npm historically no)? Does the package manager validate the lockfile against the manifest on every build (most do)?

The **content-hash approach** (Cargo, Go, Nix, pnpm) is increasingly the consensus: a lockfile entry pins not just a version number but the bytes of the dependency, so tampering or registry compromise is detectable. Go's checksum database goes further by maintaining a public log of every known module version's hash, defending against retroactive registry changes.

Source: https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html and https://go.dev/ref/mod#go-sum-files and https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json and https://pnpm.io/motivation

### 12.2. Workspaces and Monorepos

A **workspace** is a project structure where multiple related packages share a single source tree, build configuration, and (usually) lockfile. Workspaces are the package-manager-level answer to "I have several libraries that evolve together."

- **Cargo workspaces** — declared by a top-level `Cargo.toml` with `[workspace]` and `members = [...]`. Member crates share a single `Cargo.lock`, can depend on each other by relative path, and `cargo build`/`cargo test` operate on the whole workspace.
- **Go workspaces** — `go.work` (introduced Go 1.18, March 2022) lets multiple modules be developed together, overriding `go.sum` resolution for the listed modules. Different from Cargo's model: each Go module retains its own `go.mod` and `go.sum`, the workspace just unifies their development.
- **Yarn workspaces** / **npm workspaces** / **pnpm workspaces** — declared via `workspaces` in the root `package.json`. Member packages are typically symlinked into the root `node_modules`, so cross-references resolve to the local source.
- **Bazel** has the most ambitious "workspace" concept: `WORKSPACE` (or `MODULE.bazel` in bzlmod) defines an entire build universe with arbitrary internal package boundaries, source dependencies, and remote build artifacts.

The general design tension is between **monorepo benefits** (atomic cross-package changes, shared tooling, single source of truth for versions) and **per-package independence** (separate version histories, separate publishing cadences, separate ownership). Workspace mechanisms try to give the first while preserving the second; the trade-offs vary by ecosystem.

The package-manager design lesson is that **workspace support must be a first-class feature, not a hack on top of the single-package model**. Cargo and pnpm got this right relatively early; npm and Yarn took years to converge on consistent semantics.

Source: https://doc.rust-lang.org/cargo/reference/workspaces.html and https://go.dev/ref/mod#workspaces and https://docs.npmjs.com/cli/v10/using-npm/workspaces and https://pnpm.io/workspaces

### 12.3. Public Registries and Naming

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

The **scoped vs flat namespace** decision is one of the most consequential choices for ecosystem health. Flat namespaces (crates.io, PyPI) have suffered from name-squatting, typo-squatting, and maintenance abandonment. Scoped namespaces (npm `@scope`, Maven `groupId`) defend against this but require organizations to claim and maintain their scopes. A new language designing a registry should commit to scoped names from the start; retrofitting is painful (npm's `@scope` introduction in 2014 left a long tail of unscoped legacy names).

Source: https://crates.io/policies and https://docs.npmjs.com/about-scopes and https://research.swtch.com/vgo-import and https://central.sonatype.org/publish/requirements/coordinates/

### 12.4. Vendoring and Mirroring

**Vendoring** is the practice of committing copies of dependency source into the project's own repository, so builds do not depend on external registries at all. Go has the most mature vendoring story: `go mod vendor` writes all dependencies into `vendor/`, and the Go toolchain uses them transparently if present. Other ecosystems support vendoring via tooling but treat it as exceptional rather than routine.

**Mirroring** is the practice of running an internal copy of a public registry, often with content auditing or version pinning. Artifactory, Nexus, and self-hosted Verdaccio (npm), Sonatype Nexus (Maven, npm, PyPI), and Cloudsmith are commercial or open-source registry mirrors used by enterprises that cannot allow direct registry access from build infrastructure.

The design lesson is that **registry availability is a build-graph concern**. A build that depends on an external registry being reachable can fail for reasons unrelated to the project's code. Vendoring eliminates this; mirroring centralizes the failure mode. A new language should at minimum support vendoring as a first-class workflow (copying dependencies into the project's own repo) so that hermetic builds are achievable.

Source: https://go.dev/ref/mod#vendoring and https://www.sonatype.com/products/sonatype-nexus-repository

### 12.5. Build-System Module Visibility — Bazel and Buck

Beyond the language and package layer, large monorepos use build systems with their own module-visibility model. **Bazel** (Google's open-sourced build system) and **Buck** (Meta's) implement per-target visibility declarations: a `BUILD` file lists targets (libraries, binaries, tests) and each target has a `visibility = [...]` attribute restricting which other targets can depend on it. This is enforced by the build graph at build time, not by the language.

This is structurally similar to JPMS's `exports ... to` qualified exports but at the build-graph level rather than the language level. The consequence is that **a single source file can have one set of language-level visibility and a different set of build-system-level visibility**, with the latter being the operative constraint in monorepo deployments.

The interaction with language-level modules is subtle. In a Bazel monorepo using Java, a class can be `public` (Java visibility) but only depended on by specific Bazel targets (Bazel visibility). The build graph enforces architectural boundaries that Java's package-level visibility cannot. Google internally relies on this heavily.

The lesson is that **at sufficient scale, build-system visibility becomes the dominant abstraction**, not language-level visibility. A new language designed for monorepo use should consider whether its module-system primitives compose cleanly with build-system visibility, or whether the two will fight. Most languages punt on this; Bazel's reach is substantial enough that punting is increasingly costly.

Source: https://bazel.build/concepts/visibility and https://buck2.build/docs/api/build/visibility/

### 12.6. Functional Package Management — Nix Flakes and Guix

Most package managers in §12.1–§12.5 treat reproducibility as a *lockfile* concern: pin the resolved dependency tree, hash the artifacts, and trust the registry to serve the same bytes for the same hash. Nix and Guix take a more aggressive position: **every package is a pure function from inputs to outputs, and the build sandbox is hermetic by language-level construction**. The package manager is a programming environment for writing and composing those functions.

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

For a new language designing its package manager, the question Nix and Guix raise is whether reproducibility is a *property of the lockfile* or a *property of the build*. Most modern systems pick the former; Nix shows the latter is achievable and structurally cleaner, at the cost of much higher complexity.

Source: https://nixos.wiki/wiki/Flakes and https://nix.dev/concepts/flakes.html and https://guix.gnu.org/manual/en/html_node/Defining-Packages.html and https://spack.readthedocs.io/en/latest/concretize.html

### 12.7. Design Lessons from Build Systems and Registries

The build-system-and-registry layer adds several specific lessons not visible at the language level:

- **Lockfiles with content hashes are now table stakes.** A new package manager that ships without a content-hashed lockfile will be retrofitting one within a few years.
- **Workspace support must be first-class**, not bolted on. Cargo's clean workspace story is a strong differentiator.
- **Scoped registry names defend against name-squatting.** A new ecosystem should adopt them from day one.
- **No-central-registry models** (Go) work if module identity is URL-shaped. They reduce ecosystem governance burden but lose discovery affordances.
- **Vendoring should be a first-class workflow** for hermetic builds and disaster-recovery scenarios.
- **Build-system visibility is a layer above language visibility** and dominates at large scale. Compatibility with Bazel-style visibility is increasingly important for languages targeting enterprise monorepo use.
- **Reproducibility can be a build-system property, not just a lockfile property** (Nix, Guix). Hermetic, content-addressed builds eliminate "works on my machine" by construction. The cost is a substantial language learning curve for the package manifest; the benefit is reproducibility that no retrofitted lockfile can guarantee.

A new language can pick from this menu deliberately rather than discovering the choices through painful retrofits.

---

## 13. Wasm Component Model and Capability-Scoped Modules

WebAssembly's module story has evolved through three distinct generations: core Wasm modules (the original `.wasm` binary format), the abandoned **Module Linking** proposal, and the current **Component Model**. The Component Model is the most ambitious modern realization of "modules with strict typed interfaces and explicit capability boundaries" outside the ML tradition, and it is worth covering separately because it represents a binary-level module system designed from scratch with full hindsight on what does and does not work.

### 13.1. Core Wasm Modules — Imports, Exports, and Linear Memory

A core Wasm module is a binary artifact declaring **imports** (functions, globals, memories, tables, tags expected from the host or other modules), **exports** (the same kinds, exposed for consumers), and a **start function** that runs at instantiation. The module's body is a sequence of typed function definitions. Modules are stateless until **instantiated**; an instance owns its own copies of mutable globals, memories, and tables.

The host (a browser, Node.js, Wasmtime, Wasmer, etc.) instantiates a module by supplying values for its imports — typically functions implementing system calls, memories provided by the host, or tables shared with other modules. The host then invokes exported functions. This is similar to `dlopen`-style native dynamic loading but with the entire memory model statically declared in the binary and the host having full control over what authority each instance receives.

Core Wasm modules are remarkably good at **language-agnostic deterministic execution** but are weak as a module-system substrate for higher-level programs. They have no notion of strings, records, lists, optional values, or other higher-level types — only `i32`, `i64`, `f32`, `f64`, and references. Two Wasm modules cannot share complex data structures directly; they have to negotiate through linear memory, which is awkward and error-prone.

The intermediate attempt that didn't ship is worth recording. **Module Linking** was a 2019–2021 W3C Wasm proposal to give core modules a typed-import linking story: a Wasm module could declare imports of *other Wasm modules* (not just functions), with type-checked module-as-module composition. The proposal got as far as Phase 2 in the Wasm CG process but was eventually superseded and folded into the Component Model. The reason the proposal didn't reach mainstream adoption is instructive: it tried to graft module composition onto the core Wasm type system, which only knew about scalar values and references. Composing modules required composing *interfaces*, and interfaces needed richer types (strings, records, variants, options, lists) than core Wasm provides. The Component Model resolved this by introducing WIT as a separate typed IDL above core Wasm rather than extending core Wasm's type system in place. Module Linking is the cautionary precedent: a typed module composition system needs a typed substrate, and adding the types to the substrate after the fact didn't work.

Source: https://webassembly.github.io/spec/core/syntax/modules.html and https://webassembly.org/specs/

### 13.2. The Component Model — WIT, Worlds, and Resource Types

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

### 13.3. WASI Worlds and Capability-Scoped Modules

**WASI** (WebAssembly System Interface), in its current Preview 2 form (launched January 2024) and the in-progress Preview 3, is built on the Component Model. WASI defines worlds for common use cases: `wasi:cli/command` (a command-line program), `wasi:http/proxy` (an HTTP request handler), `wasi:keyvalue/store` (a key-value store consumer). Each world declares the imports a component in that world receives — typically narrow capability handles for filesystem dirs, sockets, HTTP clients, clocks, random number generators, etc.

The architectural commitment is **zero ambient authority**. A WASI component does not have access to the filesystem, network, or environment by default. The host explicitly grants capability handles at instantiation time: `--dir /data::readonly` grants a filesystem handle for `/data` with read-only permission; `--env API_KEY=...` makes that environment variable visible. A component that is not granted a filesystem capability simply has no way to read or write files — there is no "fall back to ambient access."

This is the most consequential modern deployment of object-capability principles in mainstream tooling, and it is achievable specifically because the Component Model lets capabilities be expressed as typed resource handles passed across the module boundary. Cloudflare Workers, Fastly Compute, and Fermyon Spin all run components in this style. The compositional benefits are substantial: a component implementing `wasi:filesystem` can be virtualized and intercepted by another component, attenuating or proxying its access — capabilities compose like reference attenuation in E (`MEMORY.md §10.4`).

The module-system-relevant lessons are direct. First, **a binary-level module system can be designed from scratch with strong typed interfaces** if the language ecosystem commits to a typed IDL. WIT plays the role for Wasm components that signatures play for ML modules, but at the artifact boundary rather than the source-language boundary. Second, **explicit capability handles eliminate ambient authority cleanly** if the module system makes them the only way to obtain external resources. Third, **the canonical ABI matters**: the cost of marshalling typed data across the component boundary is real, and the design has to balance richness against per-call overhead.

Source: https://github.com/WebAssembly/component-model and https://component-model.bytecodealliance.org/ and https://github.com/WebAssembly/WASI and https://github.com/WebAssembly/WASI/blob/main/Proposals.md

### 13.4. Design Lessons from Wasm Components

The Component Model adds three lessons that are unusual in the broader module-system landscape:

- **The artifact boundary can be the typed module boundary.** Wasm components carry their full interface description in the binary itself, so any host can validate, link, and instantiate them without source. This is closer to what JPMS aspires to than what JPMS achieves, and is achievable specifically because Wasm has no preprocessor or macro system to disrupt it.
- **Capability-scoped modules are practical.** The combination of typed resource handles plus zero-ambient-authority instantiation is more usable than expected — the cost is mostly ecosystem commitment to using capabilities consistently, not language complexity.
- **Module composition can be virtualization-friendly.** Because all external interaction goes through declared imports, one component can wrap another by reimplementing its imports — a standard ocap pattern that the Component Model preserves at the binary boundary.

For a new language targeting Wasm or any sandboxed-execution environment, the Component Model is the natural fit. For a general-purpose language, the design choices it embodies (typed module interfaces, capability-scoped imports, no ambient authority) are increasingly worth considering even outside the Wasm ecosystem.

---

## 14. Summary of Module Techniques

The previous chapters now cover enough of the design space to support direct comparison. The tables below compress the recurring trade-offs into forms that are easier to scan than the prose chapters. They do not replace the chapter detail; they identify the dominant patterns that emerge once file layout, dependency graphs, runtime initialization, typed abstraction, package identity, dynamic loading, and build-system layering are all viewed together.

### 14.1. Module identity models

| Language / system | Primary unit of modularity | Identity source | File-layout coupling | Package/distribution identity |
|---|---|---|---|---|
| Rust | Module tree inside a crate | `mod` declarations plus crate root | Medium | Separate package/crate layering |
| Zig | Imported file / exposed package module | Build-exposed package name or file path | Medium-high | Build-context-defined; URL+hash via `build.zig.zon` |
| Go | Package | Directory path under module path | High | Module in `go.mod`, package below it |
| Odin | Package | Directory/package organization and collection roots | High | Lightweight collection/package model |
| Python | Module / package object | Qualified import name resolved through import machinery | Medium-high | Separate packaging ecosystem |
| JavaScript ESM | Module record | Specifier resolved by host environment | Medium | Strongly shaped by runtime/package metadata |
| Node CommonJS | Loaded module object | Loader path / specifier resolution | Medium | Strongly shaped by package metadata |
| OCaml | Compilation unit / module | File-backed compilation unit name | High | Libraries/packages layered above units |
| Standard ML | Structure / functor / signature | Declaration-based | Low-medium | Implementation-specific ecosystem layer |
| Haskell | Module | Declared module name plus package/build context | Medium | Package manager/build layer distinct |
| Racket | Module | Module path + phase-relative binding context | Medium | Collections/packages layered above |
| C / headers | Translation unit + header graph | Files and include paths | High | External build/package layer |
| C++20 modules | Module interface unit | Declared module name + BMI/toolchain mapping | Medium | External build/package layer |
| Java / JPMS | Package + module | Package declaration + `module-info.java` | Medium-high | Module artifact (JAR with module-info), Maven coords |
| C# / .NET | Namespace + assembly | Namespace declaration + assembly identity | Low | Assembly (DLL) + NuGet coords |
| Scala 3 | Package + top-level definition | Package declaration | Medium | JVM artifact + Maven coords |
| Kotlin | Package + build-tool module | Package declaration + Gradle/Maven module | Medium | JVM artifact + Maven coords |
| Swift | Module (framework / SPM target) | Build-tool target name | Low-medium | Framework / SPM package |
| Erlang | Module (`-module(foo).`) | Flat module name | Medium (one module per file) | OTP application + Hex package |
| Elixir | Module (`defmodule MyApp.Foo`) | Hierarchical-by-convention atom name | Medium | Mix project + Hex package |
| Julia | Module + package | `module Foo`, possibly nested | Low (file-as-include) | Pkg environment + General registry |
| Dart | Library | URI specifier (`package:foo/foo.dart`) | Medium-high | pub package |
| Nim | File-as-module | Filename | High | Nimble package |
| Elm | Module declaration | Module path matches file path | Strict (file path = module path) | elm-lang.org package |
| F# | File + module/namespace | Project-file order + `module` declaration | Strict (project file authoritative) | NuGet package |
| Raku | Distribution + compunit | `Name:ver<X>:auth<Y>:api<Z>` 4-tuple in import syntax | Low (filename via META6 `provides` map) | fez/zef ecosystem with auth-validated 4-tuple identity |
| Perl 5 | Package (symbol table) | `package Foo;` declaration + filesystem path | Medium (path = `Foo/Bar.pm`) | CPAN distribution |
| Common Lisp | Package (symbol namespace) | `defpackage` declaration | Low | ASDF system + Quicklisp |
| Clojure | Namespace | `ns` macro declaration; runtime-mutable | Low-medium | deps.edn or Leiningen project + Clojars |
| Tcl | Namespace + package (orthogonal) | `namespace eval` for naming, `package provide` for distribution | Low (auto-path discovery via `pkgIndex.tcl`) | Tcl package with versioned `pkgIndex.tcl` |
| Forth | Wordlist | `WORDLIST` runtime token + search-order stack position | None (wordlists are runtime data) | Implementation-specific (no standard ecosystem) |
| Factor | Vocabulary | Dotted-name vocabulary + directory path | High (vocabulary = directory) | Vocab roots: core/basis/extra/work |
| Ada | Package | `package`/`package body` declaration; child packages form hierarchy | Medium (compilation-unit naming) | Build-system-defined (Alire ecosystem, GNAT project files) |
| Modula-2 / Modula-3 | DEFINITION/IMPLEMENTATION module pair | Module name in `DEFINITION MODULE` / `IMPLEMENTATION MODULE` | Medium-high | Implementation-specific |
| Oberon | Module with inline `*` export markers | `MODULE` declaration | High | Project-specific (Project Oberon) |
| D | Module | `module foo.bar;` declaration | High (module name = filesystem path) | DUB package + code.dlang.org |
| Lean 4 | Module + namespace | File path = module path; `namespace` declarations | High | Lake package + Mathlib + Reservoir |
| R | Package | DESCRIPTION manifest + NAMESPACE file | Medium-high | CRAN registry with strict review |
| Agda | Module (parameterized over dependent types) | `module M (...) where` declaration | Medium | Cabal/Stack ecosystem; agda-stdlib |
| Idris 2 | Module + interface | `module M` declaration | Medium | pack package manager |
| Wasm Component | Component artifact | WIT world declaration | None (binary artifact) | Distribution-format-independent |

### 14.2. Import semantics

| Language / system | Static syntax? | Import-time execution? | Runtime module instance? | Cycles | Notes |
|---|---|---|---|---|---|
| Rust | Yes | No in the Python/loader sense | Not the primary model | Strongly discouraged / structurally acyclic in practice | Import is mainly name and visibility control |
| Zig | Yes (`@import`) | No | Not the primary model | Static dependency style | Import yields a namespace-like value |
| Go | Yes | Limited package init, but not arbitrary import-body model like Python | Some runtime init semantics | Forbidden | Compiler/tooling-first DAG design |
| Odin | Yes | Minimal compared with scripting languages | Not the primary model | Simpler static package style | Package organization is the main story |
| Python | Yes | Yes | Yes, cached module object | Allowed, with partial initialization hazards | Import system is core runtime machinery |
| JavaScript ESM | Yes | Yes, via instantiation/evaluation | Yes | Allowed, with live-binding initialization semantics | Static syntax does not imply static semantics |
| Node CommonJS | Function-style `require` | Yes | Yes, cached export object | Allowed, loader-shaped | Much weaker static analyzability |
| OCaml | Yes | No runtime-import model in the scripting sense | Not primary | Generally structured through compilation units/interfaces | Module system is semantic and typed |
| Standard ML | Yes | No runtime-import model in the scripting sense | Not primary | Structured through signatures/functors | Classical typed-module model |
| Haskell | Yes | No scripting-style import execution | Not primary | More static/declarative than runtime systems | Export lists and qualification are central |
| Racket | Yes | Yes, but phase-aware and expander-governed | Yes, with instantiation/visit distinction | Phase-mediated | Import semantics are part of macro semantics |
| Java / JPMS | Yes | Static class load (no top-level body exec) | Class objects per loader | Forbidden across modules | Module reads-graph validated at compile/link/run |
| C# / .NET | Yes | No top-level body in the Python sense | Assemblies as runtime objects | Allowed at namespace level | Reference assemblies tracked at build time |
| Scala 3 | Yes | No scripting-style import execution | Not primary | Generally structural | Import scoping for `given` is explicit |
| Swift | Yes | No body execution at import | Module objects exist at runtime | Allowed | Library evolution mode emits stable interface artifacts |
| Erlang | Yes | No top-level body | Modules are runtime entities; reload-aware | Allowed (reload-friendly) | Two-version-active rule |
| Julia | Yes | Yes (module body executes) | Yes, cached | Allowed | Precompilation caches reduce first-load cost |
| Dart | Yes | Limited (top-level initializers run) | Library objects | Allowed | `deferred` imports for lazy loading |
| Nim | Yes | Limited (compile-time `static:` blocks) | Not primary | Allowed | Single-character `*` export marker |
| Elm | Yes | No (pure functional, no imperative top-level) | Not primary | **Forbidden at file level** | Strictest cycle prohibition in survey |
| F# | Yes | No top-level body in Python sense | Not primary | Forbidden by file ordering | Project-file order is authoritative |
| Raku | Yes | Limited (compile-time `use`/`need` vs runtime `require`) | Compunit objects | Allowed, repository-mediated | Three-way load/import split |
| Perl 5 | Yes | Yes (`use` is `BEGIN { require + import }`) | Package symbol table | Allowed | `use` is compile-time, `require` is runtime |
| Common Lisp | Yes | Yes (`defpackage` + `in-package` execute) | Yes — packages are first-class objects | Allowed (symbols can be forward-declared) | Symbol-table operations are runtime |
| Clojure | Yes (`ns` macro) | Yes (namespace bodies execute on `:require`) | Yes — runtime-mutable namespaces | Allowed | `:as-alias` defers loading |
| Tcl | Yes (`package require`) | Yes (registered scripts execute) | Packages tracked at runtime | Implementation-dependent | One version loaded per package name |
| Forth | No (imperative stack ops) | Yes (every `:` definition mutates the dictionary at execution time) | Wordlists are runtime data | Possible via shadowing | No separate compile/load distinction |
| Factor | Yes (`USING:`) | Vocabulary loading is compile-time | Vocabulary objects | Not the primary model | Ambiguous-use-error refuses to guess |
| Ada | Yes (`with`/`use`) | Limited (package elaboration controlled by pragmas) | Not primary | Allowed; ordering controlled by `pragma Elaborate_All` | Specification/body split is foundational |
| Modula-2 / Modula-3 | Yes (`FROM ... IMPORT`) | Module body executes once on first import | Module records exist at runtime | Allowed | DEFINITION/IMPLEMENTATION ancestor of `.mli`/`.ml` |
| Oberon | Yes (`IMPORT`) | Module body executes on first import | Not primary | Allowed | Inline `*` export marker per declaration |
| D | Yes (`import`) | Limited (`static this()` module ctors run at startup) | Not primary | Allowed | `version()` blocks for conditional compilation |
| Lean 4 | Yes (`import`) | Module elaboration is compile-time | Not primary | Allowed (forced acyclic in practice) | Imports affect typeclass instance scope |
| R | Yes (`library()`/`requireNamespace()`) | Yes (package onLoad hooks fire) | Yes — environments are first-class | Allowed | NAMESPACE file decouples export from S3/S4 dispatch |
| Agda | Yes (`open`, `import`) | Module bodies elaborate lazily | Not primary | Disallowed (acyclic) | Parameters can be dependent types |
| Idris 2 | Yes (`import`) | Module bodies elaborate at compile time | Not primary | Disallowed (acyclic) | Interfaces are records-of-functions |
| Wasm Component | Yes (WIT) | No (component instantiation, not body exec) | Component instances per host | Generally not — explicit world | Capability handles passed at instantiation |

### 14.3. Visibility and export models

| Language / system | Export model | Visibility granularity | Re-exports | Key trade-off |
|---|---|---|---|---|
| Rust | Explicit `pub` family | Fine-grained (`pub`, `pub(crate)`, `pub(super)`, `pub(in)`) | Strong | Powerful API shaping, more complexity |
| Zig | `pub` declarations | Simple public/private | Moderate via namespace re-exposure | Low magic, less expressive visibility lattice |
| Go | Capitalization convention | Package-private vs exported | Limited compared with Rust | Very simple, but naming-driven |
| Odin | Package-oriented, lower ceremony | Simpler than Rust | Limited / ecosystem-convention shaped | Easy to read, fewer expressive controls |
| Python | Mostly public-by-default with conventions | Convention-heavy | Trivial via rebinding/import patterns | Flexible, weak encapsulation |
| JavaScript ESM | Explicit `export` | Module-level | Strong | Good static surface control, runtime complexity remains |
| Node CommonJS | Mutable `module.exports` | Module object shaped by code | Trivial | Flexible but weakly structured |
| OCaml | Public-by-default unless constrained by `.mli` | Interface-file-based | Possible | Strong abstraction with explicit interfaces |
| Standard ML | Signature-controlled | Strong interface discipline | Possible | Abstraction power at high conceptual cost |
| Haskell | Explicit export lists | Module-level | Moderate | Good source-level API curation |
| Racket | `provide` forms | Module and phase aware | Strong | Powerful and precise, but phase complexity |
| Java / JPMS | `exports`, `exports ... to` | Package-level via module-info | Indirectly via re-exports of imported packages | Friend-export (`exports ... to`) is rare elsewhere |
| C# / .NET | `public`/`internal`/`protected` family + `InternalsVisibleTo` | Assembly-level boundary | Indirect via `TypeForwardedTo` | Friend assemblies are the canonical pattern |
| Scala 3 | Modifier keywords + `export` clauses | Package + access modifiers | First-class `export` | Re-exports as a language feature |
| Swift | `open`/`public`/`package`/`internal`/`fileprivate`/`private` | Six-level lattice | Strong | `package` level was a late addition |
| Erlang | `-export([func/arity, ...])` | Per-function arity granularity | Limited | Function-arity-pair is the export atom |
| Elixir | `def`/`defp` | Per-function | Limited | Macro-level `defmacro`/`defmacrop` distinction |
| Julia | `export` lists | Module-level | Possible | Privacy is convention only |
| Dart | Underscore-prefix privacy | Library-level (not file-level) | `export` directive | `_foo` is private to the library |
| Nim | `*` export marker | Per-declaration | `export` keyword | Most concise export marking in survey |
| Elm | `exposing (...)` list | Module-level | Possible | Type constructor exposing controls opaqueness |
| F# | Access modifiers + `[<AutoOpen>]` | Module-level + namespace | Possible | `AutoOpen` for ambient helpers |
| Raku | `is export` trait + tags | Per-declaration with optional tag groups | Possible via re-export | Multi-distribution coexistence by `:auth` |
| Perl 5 | Convention (`@EXPORT`/`@EXPORT_OK` via Exporter module) | Per-symbol | Trivial via rebinding | No language-enforced visibility |
| Common Lisp | `(:export ...)` in `defpackage` + `:shadow`/`:shadowing-import-from` | Per-symbol with explicit shadowing | Possible (re-import + re-export) | Six-relationship lattice — richest in survey |
| Clojure | Convention (private Vars use `defn-`/`defprivate-`) | Per-Var, runtime-checkable | Trivial (Vars are first-class) | First-class namespace introspection |
| Tcl | `namespace export` (advisory) | Namespace-level | Possible | Convention-driven, not language-enforced |
| Forth | Per-wordlist visibility via search-order position | Per-wordlist | Manual (push wordlist to search order) | Stack-managed visibility |
| Factor | All public within vocabulary | Vocabulary-level (no per-word privacy) | Strong via `EXCLUDE:` / `RENAME:` / `FROM:` | Ambiguous-use-error on conflict |
| Ada | Specification declares public; `private` part for opacity | Per-package + child-package privileges | Possible via re-export | Private child packages for fine-grained scoping |
| Modula-2 / Modula-3 | DEFINITION declares public surface | Module-level | Limited | Opaque types matched across the spec/body boundary |
| Oberon | Inline `*` (read-only) and `-` (read-write) markers | Per-declaration | Possible | Single-character markers per public symbol |
| D | `private`/`package`/`protected`/`public`/`export` | Five-level lattice | `public import` for re-export | `export` distinguishes binary-export visibility |
| Lean 4 | Public-by-default; `private` for module-local | Module-level + section-level | Strong via `export` clause | Imports affect instance resolution scope |
| R | NAMESPACE file `export()`/`exportPattern()` | Package-level | Possible (with care for S3/S4 dispatch) | Method registration decoupled from export |
| Agda | Public-by-default; `private` block for module-local | Module-level | `open public` for re-export | Records and modules are unified |
| Idris 2 | Access modifiers on declarations | Per-declaration | Possible | Interfaces add typeclass-style dispatch |
| Wasm Component | WIT `interface` declarations | Component boundary | Worlds compose interfaces | Typed at the binary boundary |

### 14.4. Typed and phase-aware abstraction power

| Language / system | Typed module interfaces? | Parameterized modules? | Phase-aware imports? | Distinctive strength |
|---|---|---|---|---|
| Rust | Not in the ML sense | No higher-order module system | Limited via proc-macro separation, not phase tower | Strong visibility and crate layering |
| Zig | No | No | No | Extremely explicit static imports |
| Go | No | No | No | Compiler-friendly package DAG |
| Python | No | No | No | Runtime flexibility, loader extensibility |
| JavaScript ESM | No | No | No | Live bindings with static syntax |
| OCaml | Yes (signatures) | Yes (functors) | No phase tower like Racket | Production typed module calculus |
| Standard ML | Yes | Yes | No | Classical module calculus |
| Haskell | Weaker than ML signatures/functors | Not in the same sense | No | Export/qualification discipline without full higher-order modules |
| Racket | Module contracts and language tooling, not ML signatures | Not the same abstraction style | Yes | Modules as macro- and language-phase boundaries |
| 1ML (research) | Yes (signatures = types) | Yes, as ordinary functions | No phase tower | Unifies module language with core language |
| Backpack (Haskell) | Yes (mixin-style holes) | Indefinite-module instantiation | No | Mixin linking at the package layer |
| MixML (research) | Yes (mixin signatures) | Yes (mixin merging) | No | Type-safe recursive cross-module dependency |
| Newspeak | Yes (top-level class declarations) | Yes (top-level class is a parameterized module) | No | Modules as parameterized objects, no globals |
| R6RS Scheme libraries | No types (untyped) | No (declarative imports only) | Yes (R6RS phasing via `for` annotations) | Canonical `only`/`except`/`prefix`/`rename` import refinements |
| R7RS Scheme `define-library` | No types (untyped) | No | No (R7RS dropped phasing) | Pragmatic simplification of R6RS plus `cond-expand` |
| Ada generic packages | Yes (specification = signature) | Yes (generic instantiation) | No | Production typed module system since 1980 |
| Modula-2 / Modula-3 | Yes (DEFINITION = signature) | Modula-3 generic interfaces | No | Direct ancestor of OCaml `.mli`/`.ml` |
| Agda | Yes (record types as module signatures) | Yes (with dependent type parameters) | No | Modules collapse into records under dependent types |
| Idris 2 | Yes (interface declarations) | Yes (parametric over types and values) | No | Interfaces dispatch via search resolution |
| Wasm Component | Yes (WIT worlds) | Worlds compose imports/exports | No | Typed module interfaces at the binary boundary |

### 14.5. Packaging, identity, and resolution

| Language / system | Package manager/module system relationship | Resolution style | Versioning leaks into source imports? | Main consequence |
|---|---|---|---|---|
| Rust | Layered but explicit | Cargo resolves packages, compiler resolves crates/modules | Usually no at module path level | Clean conceptual separation |
| Go | Closely aligned | Module path + directory path | Yes, via semantic import versioning | Very strong reproducibility and path identity |
| Python | Loosely coupled | Runtime import machinery + environment search path | Usually not directly | Flexible, but environment-sensitive |
| Node / ESM | Strongly metadata-shaped | Specifier resolution through host + `package.json` | Sometimes effectively yes through exports/entrypoint policy | Flexible, but complex and loader-sensitive |
| Zig | Build-context shaped | Build graph exposes package names and roots | Not usually in source syntax itself | Deterministic, but tied closely to build configuration |
| Odin | Simpler collection/package roots | Source tree and collection roots | No strong source-level version encoding | Easy to understand, less abstract |
| OCaml / Haskell | Build-tool/ecosystem-layered | Source names + compiler/build context | Usually not in ordinary source imports | Good abstraction, more tooling/build convention load |
| Racket | Collection/package layered | Module paths + collections + phases | Not the main model | Excellent extensibility, more conceptual machinery |
| Java + Maven | Layered (Maven coords distinct from JPMS module name) | Maven resolves coords, JPMS resolves module reads | Sometimes via classifier conventions | JPMS adoption is partial; classpath is still common |
| .NET + NuGet | Layered (NuGet package distinct from assembly identity) | NuGet resolves packages, runtime loads assemblies | Sometimes via package version | Package and assembly identities can drift |
| Swift + SPM | Layered (SPM package distinct from module) | SPM resolves packages, compiler loads modules | Not in source imports | Library Evolution mode separates source from binary |
| Erlang/Elixir + Hex | Layered (Hex package distinct from OTP application) | Hex resolves packages, BEAM loads modules | Not in source | Application is the deployment unit |
| Julia + Pkg + General | Layered | Pkg resolves environments, runtime loads modules | Not in source | `Manifest.toml` lockfile is the resolution truth |
| Dart + pub | Aligned (pub package = library distribution) | pub resolves packages, compiler loads libraries | Not in source | `pubspec.yaml` is the manifest |
| Nim + Nimble | Aligned | Nimble resolves packages, compiler loads modules | Not in source | Conventional naming, no enforced scoping |
| Elm + elm-lang | Aligned with strict semver enforcement | elm-lang.org resolves packages | Not in source | Tool-enforced semver compliance |
| Raku + fez/zef | Layered with auth-validated 4-tuple identity | `$*REPO` chain of CompUnit::Repository objects | Yes — `:auth`/`:ver`/`:api` appear in source `use` statements | Auth-validated supply-chain prevents poisoning |
| Perl 5 + CPAN | Loosely coupled (CPAN is convention-shaped) | `@INC` search path | Not in source | Foundational; many design issues Raku reacts against |
| Common Lisp + ASDF + Quicklisp | Layered (packages are language-level, ASDF systems are ecosystem-level) | ASDF system definitions resolve packages | Not in source | Two-layer split allows packages and systems to be many-to-many |
| Clojure + deps.edn / Leiningen | Layered (namespaces are language, deps are tool) | tools.deps or Leiningen resolves Maven coords | Not in source | Java ecosystem inherited via Maven |
| Tcl + pkgIndex.tcl | Aligned but orthogonal to namespaces | `package require` searches auto-path | Version range may be requested in source | Two-layer namespace/package model |
| Forth | Implementation-defined (no standard ecosystem) | Implementation-specific load mechanism | No | No standardized package manager |
| Factor + vocab roots | Aligned (vocabulary = directory tree) | Resolved against vocab-roots | Not in source | Single ecosystem, ambiguous-use enforced |
| Ada + Alire | Layered (project files distinct from packages) | GNAT project resolves source paths | Not in source | Spec/body split is foundational |
| Modula-2 / Modula-3 | Implementation-specific | DEFINITION/IMPLEMENTATION pair on disk | Not in source | Foundational; little active ecosystem |
| Oberon | Implementation-specific | Module name = source filename | Not in source | Project Oberon is the canonical reference system |
| D + DUB | Aligned (package = directory tree) | DUB resolves package coords | Not in source | dub.json/dub.sdl manifest |
| Lean 4 + Lake + Reservoir | Layered | Lake resolves; lakefile.lean configuration | Not in source | Mathlib is the dominant package |
| R + CRAN | Aligned (package = directory; DESCRIPTION manifest) | `library()` searches `.libPaths()` | Not in source | Strict pre-publication review |
| Agda + agda-stdlib | Cabal/Stack-layered | Cabal or stack resolves; `.agda-lib` files | Not in source | Small ecosystem, math-focused |
| Idris 2 + pack | Layered | `pack` resolves; `pack.toml` | Not in source | Modeled on Cargo |
| Nix flakes / Guix | Build-as-pure-function | Content-addressed resolution against `flake.lock` | Not in source | Hermetic reproducibility by language construction |
| Wasm Components | Distribution-format-independent | Host loads components by name | Not in source | Identity is the WIT world declaration |

### 14.6. Tooling friendliness

| Language / system | Static graph quality | Resolution determinism | Incremental-friendly? | Main tooling pain |
|---|---|---|---|---|
| Rust | High | High | High | Re-export-heavy APIs can complicate surface tracking |
| Zig | High | High | High | Build-context coupling must stay explicit |
| Go | Very high | High | Very high | Architectural rigidity from no-cycle rule |
| Odin | High | High | High in principle | Less formal specification than Rust/Go |
| Python | Lower | Medium | Harder | Import-time execution and environment-shaped resolution |
| JavaScript ESM | Medium-high | Medium | Moderate | Runtime host resolution and cyclic initialization semantics |
| Node CommonJS | Lower | Medium | Harder | Dynamic `require` patterns and mutable exports |
| OCaml | High | High | High | More conceptual complexity for users |
| Haskell | High | High | High | Package/build layering can be nontrivial |
| Racket | Medium | Medium-high | Depends on phase/tooling support | Phase complexity |
| Java / JPMS | High | High | High | JPMS adoption gap; classpath fallback fragments tooling |
| C# / .NET | High | High | High | Reflection-heavy frameworks weaken encapsulation guarantees |
| Swift | High | High | High | Library Evolution mode requires explicit annotations |
| Erlang | High | High | High (per-module reload) | Flat namespace scales via convention |
| Julia | Medium-high | High | High with precompilation | First-load latency before pkgimage cache |
| Elm | Very high | Very high | Very high | Strict file-cycle ban can frustrate prototyping |
| F# | Very high | Very high | Very high | Project-file ordering ergonomics |
| Wasm Component | High (typed binary) | High | High | Tooling for WIT is still maturing |

### 14.7. Visibility and scoping comparison

| Mechanism | Granularity | Languages | Notes |
|---|---|---|---|
| Default-private with explicit `pub`/`export` | Per-declaration | Rust, Zig, Racket, ESM, JPMS (`exports`) | Most defensive default |
| Capitalization-driven exports | Per-identifier | Go | No keyword cost; depends on naming discipline |
| Single-character export marker | Per-declaration | Nim (`*`) | Most concise default-private design |
| Underscore-prefix privacy | Per-identifier | Dart, Python (convention), Julia (convention) | Lightweight; Dart enforces it |
| Public-by-default | Per-declaration | Python, OCaml without `.mli`, default Java packages | Convenient but accumulates accidental API |
| Interface-file restriction | Per-module | OCaml `.mli`, Haskell export list | Strong API discipline |
| Friend mechanism | Cross-module specific | C# `InternalsVisibleTo`, Java `exports ... to`, C++ `friend` | Test-code access without public exposure |
| Build-tool module visibility | Per-target | Kotlin `internal`, Bazel `visibility`, Buck `visibility` | Build graph is the boundary |
| Six-level lattice | Per-declaration | Swift (`open`/`public`/`package`/`internal`/`fileprivate`/`private`) | Richest production lattice |

### 14.8. Cycle policy

| Policy | Languages | Trade-off |
|---|---|---|
| Forbidden across files | Elm, F# (via project ordering) | Strictest; forces architectural decomposition early |
| Forbidden across packages | Go | Forces interface-style indirection |
| Tolerated with partial-init semantics | Python (mid-init module visibility), JS ESM (live bindings), CommonJS (whatever `module.exports` has populated) | Flexible but error-prone |
| Tolerated with structured mediation | OCaml/SML (signatures, functors), Backpack | Cycles broken via parameterization |
| Discouraged but not forbidden | Rust (intra-crate, in practice rare) | Pragmatic middle ground |
| Per-module reload tolerates two-version cycles | Erlang | Cycles must respect reload semantics |

### 14.9. Design option matrix

| Design option | Benefit | Cost | Languages | Typical fit |
|---|---|---|---|---|
| File-as-module | Very simple mental model | Less flexible logical organization | Python, Zig-ish workflows, OCaml compilation units | Common in simpler or file-centric systems |
| Directory-as-package | Easy project organization | Filesystem becomes highly authoritative | Go, Odin | Common in systems emphasizing layout clarity |
| Declared module unit | Flexible logical structure | More resolution machinery | Rust, Java, OCaml, C++20 modules | Common in systems emphasizing explicit logical structure |
| Static imports only | Clean compiler/tooling graph | Less dynamic flexibility | Rust, Zig, Go, Odin | Common in compiler/tooling-oriented systems |
| Import-time execution | Flexible plugins/init patterns | Harder cycles, tooling, reproducibility | Python, JS, Ruby | Common in dynamic/runtime-oriented systems |
| Explicit exports | Clear APIs, good encapsulation | Slightly more verbosity | Rust, Zig, ESM, Racket | Common in systems emphasizing API discipline |
| Public-by-default | Fast early coding | Accidental API sprawl | Python, OCaml without `.mli` | Common in convenience-oriented or convention-heavy systems |
| Hard cycle prohibition | Simpler graph and init semantics | More architectural pressure on users | Go | Common where a strict dependency DAG is a design goal |
| Phase-aware imports | Future macro power | Much higher conceptual complexity | Racket | Common only in macro- or language-extension-oriented systems |
| Typed module interfaces | Strong abstraction boundaries | Major language complexity increase | OCaml, SML | Common in typed module-calculus traditions |
| Package identity separate from module identity | Cleaner ecosystem evolution | More concepts to explain | Rust, partly Haskell/OCaml | Common in layered package/module ecosystems |
| Package metadata shapes resolution | Flexible publishing/runtime interop | Harder static reasoning | Node | Common in loader- and package-metadata-shaped ecosystems |
| Resilient ABI / library evolution | Binary compatibility across versions | Compiler/runtime complexity | Swift, .NET (`TypeForwardedTo`) | Common where binary distribution dominates |
| Hot module reload at runtime | Live-coding and uptime | Requires module-identity + state-survival discipline | Erlang, Elixir, OSGi, JS HMR | Common in long-running or interactive systems |
| Capability-scoped imports | Sandboxing and ocap composition | Requires zero-ambient-authority commitment | Wasm Components, Newspeak | Common in security- and isolation-oriented designs |
| Workspace / monorepo support | Atomic multi-package edits | More tooling required | Cargo, Go, pnpm, Bazel | Increasingly table stakes for serious ecosystems |
| Content-hash lockfiles | Reproducible builds | More plumbing | Cargo, Go, pnpm, Nix | Modern standard |
| Hermetic build-as-pure-function | Reproducibility by construction | Steep learning curve; separate ecosystem | Nix flakes, Guix, Spack | Strongest reproducibility model in the survey |
| Specification/body file split | Interface-first design, opaque types | Two files per module | Ada, Modula-2, OCaml `.mli`/`.ml` | Foundational; ML/OCaml are the modern descendants |
| Dependent-type modules / records-as-functors | Module language unifies with core | Requires dependent types from day one | Agda, Idris 2 | Eliminates the stratified module language entirely |

---

## 15. Open Design Questions

The questions below are the recurring decision points any new language faces when designing a module system. They are not ranked: each represents a real trade-off, and the right answer depends on the language's broader goals.

### 15.1. Is a module a file, a directory, or a declared unit?

A file-based design (Python, Zig source files, OCaml compilation units, Nim, F#) is simple and tooling-friendly: the filesystem is authoritative. A directory-based design (Go, Odin) makes filesystem layout the package boundary, which scales project organization at the cost of locking in a specific tree shape. A declaration-based design (Rust, Java, OCaml's `module ... struct`, C++20 named modules) decouples logical structure from layout but requires more resolution machinery. Hybrids are possible (Rust's `mod` declarations plus filesystem search) but only if the resolution rules stay deterministic.

### 15.2. Are imports static dependency edges, or runtime events?

Forbidding import-time execution (the static-graph family of chapter 3) yields a clean compile graph, easier tooling, simpler initialization, and trivial cycle policy. Allowing import-time execution (chapter 4) buys flexibility and plugin-style extension at the cost of complicated cycle semantics, environment-sensitive behavior, and weaker static analyzability. This is one of the highest-leverage decisions in the design space; it is also one of the hardest to reverse.

### 15.3. Are exports explicit, public-by-default, or convention-driven?

Explicit exports (Rust `pub`, Java `public`, JPMS `exports`, ESM `export`, Nim `*`) align well with refactoring and API stability. Public-by-default (Python, OCaml without `.mli`) is convenient at small scale but accumulates accidental API. Convention-driven (Go capitalization, Dart underscore-prefix) sits between the two — lightweight but dependent on naming discipline. The richer the visibility lattice (Swift's six levels, Rust's `pub(crate)`/`pub(super)`/`pub(in)`), the more precisely large codebases can encode intent at the cost of more concepts to learn.

### 15.4. Are cycles forbidden, tolerated, or structured?

Hard prohibition (Go at the package level, Elm at the file level, F# via project ordering) yields the cleanest compilation, initialization, and tooling story but pushes architectural pressure onto users. Tolerance with partial initialization (Python, JS ESM live bindings, CommonJS) gives flexibility at the price of evaluation-order surprises. Structured mediation through signatures and functors (OCaml, SML, Backpack) trades language complexity for a principled answer. The choice signals whether the module system is meant to *enforce* architecture or merely *describe* it.

### 15.5. Are package identity and module identity the same?

Coupling them tightly (Go's module path + directory path, Elm's package = module-namespace) yields strong reproducibility and clear ecosystem identity at the cost of versioning policy leaking into source. Keeping them separate (Rust's package vs crate vs module, Haskell's module vs Cabal package) preserves stable source-level naming as the package layer evolves but requires explaining more layers. Loose coupling (Python's import system vs packaging) is the most flexible but the most environment-shaped. The choice usually shapes whether reproducible builds, package managers, and registry naming are easy or hard later.

### 15.6. Does package metadata participate in resolution?

If `package.json`-style metadata redefines what a source-level specifier means (Node `exports` maps, conditional exports), the language gains expressive distribution flexibility but loses static reasoning. If metadata is purely installation information (Cargo, Go modules), tooling has a simpler job. Most new languages benefit from leaving metadata-shaped resolution out, at least initially.

### 15.7. Are runtime modules first-class objects, or only compile-time abstractions?

Runtime module objects (Python, Erlang, Julia, OSGi-style JVM) enable hot reload, plugin discovery, dynamic introspection, and reflection-heavy frameworks. Compile-time-only modules (Rust, Zig, Go in practice) keep the compiler simple and the runtime cheap but require separate mechanisms for plugin-style extension. The decision is closely linked to whether import-time execution is permitted (§15.2).

### 15.8. Should phase-aware macro/module separation be designed in?

If a language eventually wants Racket- or Rust-style compile-time metaprogramming, the module system needs a story for which bindings exist at which phase. This can be designed in from day one (Racket's phase tower) or deferred — but a module system designed without thinking about phases can lock out future macro power. A new language can keep the initial module system simple while leaving room for a later phase refinement, but only if the early choices do not prematurely fuse phases.

### 15.9. How are dynamic loading and hot reload supported?

If hot reload is a goal (live-coding, long-running services, plugin architectures), the module system has to commit early to flat or hierarchical-but-stable identity, individually loadable artifacts, and a story for state survival across reload. Erlang's flat-module two-version-active design, OSGi's class-loader hierarchy, and JS HMR's `import.meta.hot.accept` all illustrate that this requires language-level cooperation, not just runtime tooling. Languages that ignore this until late tend to retrofit awkwardly.

### 15.10. Is the artifact boundary the module boundary?

Some languages make the published binary artifact the encapsulation unit (Java module/JAR, .NET assembly, Swift framework, Wasm component). Others keep modules as source-level abstractions and let artifacts be a separate concern (Rust crate vs package, Go package vs module). Tying modules to artifacts simplifies reasoning about distribution and binary compatibility but couples module design to packaging decisions. The Wasm Component Model is the most modern realization of artifact-as-module-boundary; it works because the typed interface description is part of the artifact.

### 15.11. How is reflection accommodated?

Frameworks that depend on deep reflection (DI containers, ORMs, serializers) break encapsulation unless the module system explicitly authorizes them. JPMS's `opens` directive, .NET's looser reflection rules, and Wasm's resource handles each take a different position. A new language should decide whether reflection is permitted (Java pre-9), restricted (JPMS post-9), or first-class (Smalltalk, Newspeak); the decision shapes both the module system and the framework ecosystem that grows on top.

---

## 16. Closing Synthesis

The design space splits into roughly five broad concerns:

1. **Static compile-time graph systems** prioritize deterministic dependency graphs, separate compilation, tooling, and explicit boundaries (chapter 3).
2. **Runtime import systems** treat imports as program execution and module initialization events, prioritizing flexibility over static analyzability (chapter 4).
3. **Typed or phase-aware abstraction systems** use modules as semantic abstraction layers, not just namespace or packaging mechanisms (chapter 5, chapter 10).
4. **Package, identity, and resolution models** determine how source-level names connect to distribution artifacts, versioning, and toolchain behavior (chapter 6, chapter 12).
5. **Runtime, dynamic, and capability-scoped modules** govern how modules are loaded, swapped, and isolated at execution time (chapter 11, chapter 13).

A baseline chosen early in a language's design often leans toward the first family for source-level semantics — static imports, explicit exports, no cycles, deterministic resolution — and toward Rust-style layered package/module identity for the second. The runtime, dynamic-loading, and capability-scoped concerns can be deferred to later versions as long as the initial design does not foreclose them: flat module identity preserves the option of hot reload, typed interfaces preserve the option of capability scoping, and explicit visibility preserves the option of artifact-boundary encapsulation.

The strongest cross-cutting lesson from this survey is that **module-system retrofits are uniformly painful**. JPMS took 22 years; C++20 modules are still rolling out a decade after specification work began; Python's import system has accumulated decades of `__path__` and namespace-package patches; Node spent years reconciling CommonJS with ESM. The new-language opportunity is to commit to a module system from version 1 — even a simple one — that sets up the right invariants (static graph, explicit exports, deterministic resolution, layered package identity) so that later additions are extensions rather than rewrites.

---

## 17. References

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

### Chapter 6 — Packages, Identity, and Resolution

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

### Chapter 7 — JVM and .NET Module Systems

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

### Chapter 8 — Headers, Translation Units, and C++20 Modules

1. cppreference — `#include` directive — https://en.cppreference.com/w/cpp/preprocessor/include
2. GCC C preprocessor manual — https://gcc.gnu.org/onlinedocs/cpp/
3. include-what-you-use — https://github.com/include-what-you-use/include-what-you-use
4. cppreference — Modules (C++20) — https://en.cppreference.com/w/cpp/language/modules
5. P1103R3 — Merging Modules — https://isocpp.org/files/papers/P1103R3.pdf
6. Microsoft Learn — Overview of modules in C++ — https://learn.microsoft.com/en-us/cpp/cpp/modules-cpp
7. GCC wiki — C++ modules — https://gcc.gnu.org/wiki/cxx-modules
8. Clang — Standard C++ Modules — https://clang.llvm.org/docs/StandardCPlusPlusModules.html

### Chapter 9 — Modules in Additional Production Languages

1. Swift Programming Language — Access Control — https://docs.swift.org/swift-book/documentation/the-swift-programming-language/accesscontrol
2. SE-0386 — `package` access modifier — https://github.com/swiftlang/swift-evolution/blob/main/proposals/0386-package-access-modifier.md
3. Swift — Library Evolution — https://github.com/swiftlang/swift/blob/main/docs/LibraryEvolution.rst
4. Swift Package Manager documentation — https://www.swift.org/documentation/package-manager/
5. Erlang — Code loading — https://www.erlang.org/doc/system/code_loading.html
6. Erlang — Applications design principles — https://www.erlang.org/doc/design_principles/applications.html
7. Elixir — `Kernel.defmodule/2` — https://hexdocs.pm/elixir/Kernel.html#defmodule/2
8. Mix build tool — https://hexdocs.pm/mix/Mix.html
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
26. Zig 0.11 release notes — Package management — https://ziglang.org/download/0.11.0/release-notes.html#Package-Management
27. Raku — Modules — https://docs.raku.org/language/modules
28. Raku — Distributions: configuration and structure — https://docs.raku.org/language/distributions/configuration-structure
29. Raku — Compilation and module loading — https://docs.raku.org/language/compilation
30. zef package installer — https://github.com/ugexe/zef
31. fez/zef ecosystem and auth — https://deathbyperl6.com/fez-zef-a-raku-ecosystem-and-auth/
32. Forth-2012 — Search-Order word set — https://forth-standard.org/standard/search
33. Gforth manual — Word Lists — https://gforth.org/manual/Word-Lists.html
34. Gforth manual — Wordlists and Search Order Tutorial — https://gforth.org/manual/Wordlists-and-Search-Order-Tutorial.html
35. Gforth manual — Why use word lists? — https://www.complang.tuwien.ac.at/forth/gforth/Docs-html-history/0.6.2/Why-use-word-lists-.html
36. Factor — Vocabularies tour — https://docs.factorcode.org/content/article-tour-vocabularies.html
37. Factor — Vocabulary loader — https://docs.factorcode.org/content/article-vocabs.loader.html
38. Factor — Vocabulary roots — https://docs.factorcode.org/content/article-vocabs.roots.html
39. Factor — `USE:` syntax — https://docs.factorcode.org/content/word-USE__colon__%2Csyntax.html
40. D Language — Modules specification — https://dlang.org/spec/module.html
41. D Language — Visibility attributes — https://dlang.org/spec/attribute.html#visibility_attributes
42. D Language — Conditional compilation (`version`) — https://dlang.org/spec/version.html
43. DUB package manager — https://dub.pm/
44. Lean 4 — Setting up Lean — https://lean-lang.org/lean4/doc/setup.html
45. Theorem Proving in Lean 4 — Interacting with Lean — https://lean-lang.org/theorem_proving_in_lean4/interacting_with_lean.html
46. Lean 4 — What's new — https://lean-lang.org/lean4/doc/whatsnew.html
47. Lean Community / Mathlib — https://leanprover-community.github.io/
48. R — Writing R Extensions: Package namespaces — https://cran.r-project.org/doc/manuals/r-release/R-exts.html#Package-namespaces
49. R Packages (Wickham & Bryan) — Namespace chapter — https://r-pkgs.org/namespace.html
50. CRAN Repository Policy — https://cran.r-project.org/web/packages/policies.html

### Chapter 10 — Research and Advanced Module Calculi

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

### Chapter 11 — Dynamic Loading, Plugins, and Hot Module Replacement

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

### Chapter 12 — Build Systems, Workspaces, Lockfiles, and Registries

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

### Chapter 13 — Wasm Component Model and Capability-Scoped Modules

1. WebAssembly Specification — Modules — https://webassembly.github.io/spec/core/syntax/modules.html
2. WebAssembly Specs index — https://webassembly.org/specs/
3. WebAssembly Component Model — https://github.com/WebAssembly/component-model
4. Bytecode Alliance — Component Model book — https://component-model.bytecodealliance.org/
5. WASI repository — https://github.com/WebAssembly/WASI
6. WASI proposals — https://github.com/WebAssembly/WASI/blob/main/Proposals.md
