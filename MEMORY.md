# Memory Management and Memory Safety

Research on compile-time and runtime memory disciplines — ownership and borrowing, region inference, reference-counting compilation, modern C++ safety initiatives, hardware tagging and capabilities, tracing GC architectures, allocators, formal verification of memory safety, concurrent reclamation, and capability-based authority.

This document is the canonical owner for memory-model and memory-safety research. It spans both compile-time analyses and runtime systems: ownership and borrowing, regions, reference-counting compilation, tracing GC, allocators, hardware mechanisms, verified memory safety, concurrent reclamation, and capability-based authority. `COMPILERS.md §16` keeps only the compiler-pass view of selected techniques. Runtime execution coordination lives in `CONCURRENCY.md`; this file discusses those mechanisms only where they determine memory ownership, heap shape, reclamation, or data-race safety. Sanitizers as observability tools live in `TRACERS.md §8`. Capability-based modularity at the binary boundary is covered here from the authority angle and in `MODULES.md §11` from the module-system angle. The unifying axis across the chapters is *where the safety argument is paid for*: in source annotations, in the type system, in compile-time analysis, in runtime checks, in hardware tags, in formal proofs, or in the language's authority discipline.

---

## 1. Ownership and Borrowing — Compile-Time Aliasing Discipline

Ownership systems make memory safety a static type-system property by enforcing aliasing rules at compile time. The distinguishing axis across entries is *what discipline replaces ambient mutable aliasing*: Rust's shared-versus-mutable borrowing, Hylo's mutable value semantics, Swift's exclusivity over ARC, Pony's reference capabilities, OxCaml's modal types over a GC'd language, Inko's single ownership plus processes, and Move's resource types. Each picks a different point on the annotation-burden / inference-power / expressiveness triangle.

### 1.1. Rust — Non-Lexical Lifetimes (NLL)

Rust's defining mechanism is the borrow checker: every reference has a region/lifetime, and the type system enforces that `&mut T` is unique while `&T` is shared. NLL (stable in Rust 1.31, December 2018; on-by-default for all editions in Rust 1.63, August 2022) reformulated borrow scopes from the lexical block boundary to *liveness over the MIR control-flow graph*. A borrow ends at its last *use*, not at the closing brace.

The technical advances NLL ships with: (1) MIR-based dataflow that computes "loans live at point P" via constraint propagation; (2) two-phase borrows that split a `&mut` into a reservation phase (read-only) and an activation phase, enabling patterns like `vec.push(vec.len())` that would otherwise alias; (3) reborrowing rules that let `&mut *p` produce a fresh inner borrow, re-enabling `p` after the inner borrow ends.

Sources: https://blog.rust-lang.org/2022/08/05/nll-by-default.html and https://rust-lang.github.io/rfcs/2025-nll.html and https://smallcultfollowing.com/babysteps/blog/2017/03/01/nested-method-calls-via-two-phase-borrowing/

### 1.2. Rust — Polonius

Niko Matsakis's **Polonius** is a reformulation of borrow-checking as a per-CFG-point *loan-liveness* problem rather than NLL's region-as-set-of-points model. Origins are sets of *loans* with subset constraints computed at every CFG point, which directly resolves "NLL problem case #3" and lending-iterator patterns (`fn next(&mut self) -> &mut T`) that NLL rejects. The original 2018 prototype was Datalog-based (the `datafrog` engine, exporting `borrow_region` / `subset_base` / `loan_invalidated_at` facts); the 2024 "Polonius alpha" landed in `rustc` as a location-sensitive analysis behind `-Zpolonius=next` — a strict superset of NLL.

Co-developed with `a-mir-formality`, a formal model of MIR + the trait system used to derive the location-insensitive subset that ships first. The end-state goal is a single reformulation of the borrow checker that passes more programs and is easier to reason about.

Sources: https://rust-lang.github.io/polonius/ and https://blog.rust-lang.org/inside-rust/2023/10/06/polonius-update/ and https://rust-lang.github.io/rust-project-goals/2026/polonius.html

### 1.3. Rust — Stacked Borrows and Tree Borrows

These are not borrow-checkers but *operational aliasing models* — they define what counts as undefined behaviour for `unsafe` Rust, so the compiler can soundly enforce `noalias` optimizations, and so Miri can detect aliasing violations dynamically.

**Stacked Borrows** (Jung, Dang, Kang, Dreyer — POPL 2020) gives every memory location a stack of pointer tags. Borrowing pushes; using a pointer requires its tag to be in the stack and pops anything above it — a *dynamic* version of the static borrow checker that works without lifetimes. **Tree Borrows** (Villani, Hostert, Dreyer, Jung — PLDI 2025) replaces the stack with a per-allocation tree of borrows, tracking per-pointer state (Reserved/Active/Frozen/Disabled) so that reads from a parent don't kill a child borrow. Empirical evaluation on the top 30,000 crates rejects 54% fewer real programs than Stacked Borrows while preserving most optimizations and additionally licensing read-read reorderings.

Tree Borrows is an experimental aliasing model available in Miri, not the established default model. Stacked Borrows remains the more established operational model for Miri-based aliasing checks today, while Tree Borrows is a promising candidate being evaluated because it accepts more real unsafe-Rust patterns without giving up the optimization story. The mechanical aliasing-detection side is covered from the debugger angle in `DEBUGGERS.md §8.8`; the formal-soundness side appears in §8.11 below.

Sources: https://plv.mpi-sws.org/rustbelt/stacked-borrows/paper.pdf and https://www.ralfj.de/blog/2018/08/07/stacked-borrows.html and https://dl.acm.org/doi/10.1145/3735592

### 1.4. Rust — Pin/Unpin and Async Lifetimes

Library-level rather than language-level mechanism for *address stability*, needed because async desugars to self-referential state machines that cannot tolerate moves. `Pin<P>` is a wrapper proving the pointee won't move until dropped; `Unpin` is an opt-out auto-trait declaring "I don't care about address stability." `Future::poll(self: Pin<&mut Self>, ...)` threads the pin through every poll, making self-referential `async fn` state machines sound without compiler support. The drop guarantee — once pinned, `drop` runs before the memory is reused — is what intrusive data structures (e.g. tokio's linked lists) actually rely on.

Pin stabilized in Rust 1.33 (February 2019); async/await in 1.39 (November 2019). The library-only character is unusual: Rust's ownership machinery is rich enough to express "addresses are stable until destruction" without a new language feature. C++20 coroutines (`CONCURRENCY.md §4.7`) face the same self-reference problem and resolve it differently: coroutine frames are heap-allocated by default and accessed indirectly through `coroutine_handle`, sidestepping the address-stability question by making the frame's address fixed by allocation rather than by type discipline.

Sources: https://doc.rust-lang.org/std/pin/ and https://rust-lang.github.io/async-book/part-reference/pinning.html and https://without.boats/blog/pin/

### 1.5. Rust — View Types (Work in Progress)

Proposed extension to express partial/disjoint borrows of struct fields in function signatures, eliminating today's spurious inter-procedural borrow conflicts. Syntax `&mut {f1, f2} self` records *multiple* loans (one per named field) instead of a single whole-struct loan, so two methods accessing disjoint field sets compose. Niko Matsakis's "maximally minimal" design pairs explicit field lists with potential row-polymorphism inference; the competing RFC #3736 ("Partial Types") generalizes to nested products. This remains a design-space discussion / pre-RFC area rather than a stabilized Rust feature.

Sources: https://smallcultfollowing.com/babysteps/blog/2026/03/21/view-types-max-min/ and https://smallcultfollowing.com/babysteps/series/view-types/ and https://github.com/rust-lang/rfcs/pull/3736

### 1.6. Hylo — Mutable Value Semantics and Subscripts

Dimi Racordon and Dave Abrahams's **Hylo** (formerly Val) achieves memory safety *without first-class references*. Every binding is an independent value; the language exposes shared/mutable access only through compile-time *projections* with strictly bounded lifetimes. The four parameter conventions — `let`, `inout`, `sink`, `set` — replace references; `inout` is "copy-in / copy-out" semantically but compiles to in-place mutation under the law of exclusivity.

The distinctive primitive is **subscripts** that `yield` rather than `return`: `subscript min(x: yielded T, y: yielded T): T { if cond { &x } else { &y } }`. The caller gets temporary access to a part of an existing value, with the variant (`let`/`inout`/`sink`) chosen at the call site. No lifetime annotations exist in surface syntax: aliasing constraints are inferred from projection nesting because a projection's lifetime is always "until the call returns." The Swiftlet calculus (Racordon-Abrahams, JOT 2022) is the formal grounding.

Sources: https://www.hylo-lang.org/ and https://docs.hylo-lang.org/language-tour/subscripts and https://www.jot.fm/issues/issue_2022_02/article2.pdf

### 1.7. Mojo — `owned`/`borrowed`/`inout` with ASAP Destruction

Modular's **Mojo** grafts Rust-style ownership onto Python syntax with one distinctive twist: destruction at *last use* (sub-expression granularity) rather than end of scope. Argument conventions are `borrowed` (default, immutable shared), `inout` (mutable unique), and `owned`/`var` (consuming); the transfer operator `^` ends the source binding's lifetime explicitly. The lifetime checker calls `__del__` immediately after a value's last use within an expression — intermediates in `a + b + c + d` die between sub-ops — in contrast to Rust's end-of-scope drops.

Mojo's "origins" (lifetime parameters) are tracked symbolically by the compiler; per-field destruction tracks partial moves of struct fields independently. Ownership shipped with the first public release in 2023; lifetimes/origins stabilized 2024–2026.

Sources: https://docs.modular.com/mojo/manual/values/ownership/ and https://docs.modular.com/mojo/manual/lifecycle/death/ and https://www.modular.com/blog/deep-dive-into-ownership-in-mojo

### 1.8. Swift — Law of Exclusivity and Noncopyable Types

Swift adds compile-time + runtime exclusivity enforcement on top of an ARC-managed language, then layers opt-in noncopyable types that get Rust-like static guarantees. The **Law of Exclusivity** (SE-0176, Swift 4): "two accesses to the same variable may not overlap unless both are reads" — enforced statically for locals/`inout`, dynamically (via per-variable access flags) for class properties and globals.

**SE-0390 noncopyable structs/enums** (Swift 5.9, 2023): `struct Foo: ~Copyable` suppresses the implicit `Copyable` conformance; values have unique ownership and may declare a `deinit`. SE-0427 (Swift 6.0, 2024) extends this to generics via a default `Copyable` constraint that can be suppressed with `~Copyable`. **SE-0377 parameter modifiers** make `consuming`/`borrowing` part of the API contract; `consuming` methods can use `discard self` to suppress `deinit`. This is Swift's clearest move into the Rust-adjacent design space — opt-in linearity layered on an ARC-managed language.

Sources: https://github.com/apple/swift-evolution/blob/main/proposals/0176-enforce-exclusive-access-to-memory.md and https://github.com/apple/swift-evolution/blob/main/proposals/0390-noncopyable-structs-and-enums.md and https://github.com/apple/swift/blob/main/docs/OwnershipManifesto.md

### 1.9. Austral — Linear Types as the Primary Mechanism

Fernando Borretti's **Austral** uses linearity (every linear value used *exactly* once) as the load-bearing safety primitive, not an opt-in. The linearity checker fits in roughly 600 lines of OCaml. Linear types double as **capabilities** (see §10 for the capability/authority framing): the entrypoint receives a `RootCapability` and APIs require passing capability values (`EnvCap`, `FileSystemCap`, etc.) — supply-chain attacks become a type error since capabilities cannot be forged or stashed in globals.

Region-tagged borrows (`borrow` statement introducing a fresh region type `R`) re-enable shared/mutable references inside a lexical scope without losing the linearity invariant, by ensuring references cannot escape the region. The language is designed for "fits-in-head" simplicity: the linearity rules fit on one page; the compiler is small enough to be auditable. Status (2023): 1.0.0-alpha.

Sources: https://austral-lang.org/spec/spec.html and https://borretti.me/article/how-australs-linear-type-checker-works and https://borretti.me/article/how-capabilities-work-austral

### 1.10. Pony — Reference Capabilities

Sylvan Clebsch's **Pony** has six per-reference capabilities — `iso` (read/write unique), `trn` (write-unique with `box` aliases allowed), `ref` (mutable, actor-local), `val` (deeply immutable, sendable), `box` (read-only view abstracting `ref`/`val`/`trn`), `tag` (identity-only, sendable) — that form a 3×3 matrix on (deny global aliases) × (deny local aliases). The **sendable subset** is the diagonal (`iso`, `val`, `tag`): only those can cross actor boundaries because their local and global guarantees coincide. This is the static foundation for data-race freedom *by construction*, proven in "Deny Capabilities for Safe, Fast Actors" (Clebsch et al., AGERE 2015).

`consume` and `recover` blocks let capability-changing assignments happen safely: `consume` ends an alias to allow reassignment; `recover` lifts the capability of objects constructed inside it, so a freshly built `ref` graph can become `iso` if the recover block could only see sendable inputs. The same system reappears from the capability/authority angle in §10.1 below — Pony is the cleanest example of one mechanism doing both ownership and ocap work.

Sources: https://tutorial.ponylang.io/reference-capabilities/reference-capabilities.html and https://tutorial.ponylang.io/reference-capabilities/capability-matrix.html and https://www.ponylang.io/media/papers/fast-cheap.pdf

### 1.11. Linear Haskell — Multiplicity-Polymorphic Arrows

GHC's `-XLinearTypes` (Bernardy et al., POPL 2018; shipped GHC 9.0, February 2021) puts linearity on the *function arrow* (`a %1 -> b`), not on types. A linear function promises "if my result is consumed once, my argument is consumed once," but can still be applied to unrestricted values. The **multiplicity-polymorphic arrow** `a %m -> b` with `m :: Multiplicity` (`One` or `Many`) lets `map`, `(.)`, etc. be reused unmodified for both linear and non-linear callers — solving the "code duplication" problem that kept linear types out of mainstream FP for thirty years.

All non-GADT data constructors are linear by default, so existing types like `(,)` and `[]` get useful linear types for free; existing programs continue to type-check. The implementation cost in GHC was ~1,150 lines. "Linear Constraints" (PACMPL 2021) layers an inferred `=∘` arrow on top for ergonomics. Status (GHC 9.12): experimental.

Sources: https://arxiv.org/abs/1710.09756 and https://downloads.haskell.org/~ghc/latest/docs/users_guide/exts/linear_types.html

### 1.12. Idris 2, Granule, Clean — Multiplicities, Graded Types, Uniqueness

Three adjacent mechanisms worth naming as a group, none requiring full per-entry treatment.

**Idris 2** (Edwin Brady) uses **Quantitative Type Theory**: every binder has a multiplicity 0 / 1 / ω, where 0 = erased at runtime, 1 = used exactly once, ω = unrestricted. Unifies linearity *and* erasure: types are 0-quantity; runtime values are 1 or ω. **Granule** combines linear types with **graded modal types** — `a [n]` says "use `a` exactly `n` times" where `n` ranges over a user-chosen semiring (naturals, intervals, security levels), generalizing linear `!` to track fine-grained co-effects. **Clean uniqueness types** (since the 1990s) use `*T` for "no other reference exists, destructive update is safe"; semantically distinct from linearity (Clean is about graphs, linearity about lambda terms; uniqueness is about the past, linearity about the future).

Sources: https://arxiv.org/abs/2104.00480 and https://granule-project.github.io/ and https://wiki.clean.cs.ru.nl/download/html_report/CleanRep.2.2_11.htm

### 1.13. OxCaml — Modal Memory Management for OCaml

Jane Street's **OxCaml** branch (Lorenzen, Dolan, White et al.; "Oxidizing OCaml with Modal Memory Management", ICFP 2024) retrofits Rust-style ownership onto OCaml without abandoning the language's tracing GC. The mechanism is **three orthogonal mode axes** attached to every binding:

- **Locality** (`local` vs `global`): a `local` value is allowed to allocate on the call's stack frame and may not escape it; `global` values may escape and are heap-allocated under GC. The compiler statically rejects programs that try to return a `local` from a function or store one in a heap data structure.
- **Uniqueness** (`unique` vs `shared`): a `unique` value has no aliases; the compiler can rewrite operations on it in place (the equivalent of Lean 4's `isExclusive`-guarded mutation §3.6, but proven statically rather than checked at runtime).
- **Affinity** (`affine` vs `many`): an `affine` value can be used at most once; `many` values are unrestricted. Affinity composes with uniqueness to recover Rust-style move semantics for resource handles (file descriptors, mutex tokens) within an otherwise GC'd language.

The combinations form a small mode lattice; arrow types carry mode annotations on parameters and results (`f : 'a @ local -> 'b @ unique`). The compiler infers most mode usage; explicit annotations are needed at the API boundary. OxCaml ships an `exclave_` keyword that lets `local` values escape *into* a parent stack frame when the call structure permits, recovering the equivalent of Hylo's subscript-yields (`§1.6`) for OCaml.

The architectural contribution is showing that **ownership and a tracing GC compose in one language** without choosing between them. Rust gives up GC entirely; Hylo (`§1.6`) gives up first-class references; Mojo (`§1.7`) gives up Python compatibility. OxCaml gives up nothing — existing OCaml code typechecks unchanged at the default modes (`global`, `shared`, `many`), and performance-critical code opts into the more restrictive modes for stack allocation, in-place mutation, and resource management. Status (as of 2026-04): production at Jane Street since early 2024; the OxCaml branch was open-sourced July 2025; merging the modes into mainline OCaml is being negotiated, with parts (locality/stack allocation) likelier to land first.

The lesson generalises: **modes are a lower-cost retrofit path for ownership disciplines than language redesign**. A language with a sound type system can introduce locality, uniqueness, and affinity as opt-in modes without breaking existing code, with the compiler enforcing them only where annotated. For language designers considering Rust-style discipline as a feature rather than a foundation, OxCaml is the reference data point.

Sources: https://blog.janestreet.com/oxidizing-ocaml-locality/ and https://blog.janestreet.com/oxidizing-ocaml-ownership/ and https://antonlorenzen.de/oxidizing-ocaml-modal-memory-management.pdf and https://oxcaml.org/documentation/stack-allocation/reference/ and https://tarides.com/blog/2025-07-09-introducing-jane-street-s-oxcaml-branch/

### 1.14. Inko — Single Ownership with Erlang-Style Processes

Yorick Peterse's **Inko** is the closest production language to "Rust's ownership + Erlang's processes" — single-ownership with deterministic destruction, no shared mutable state across processes, message passing with ownership transfer, and a Rust-implemented runtime targeting native code via LLVM. Where Pony (`§1.10`) layers a six-capability lattice on top of an actor runtime, Inko picks the simpler discipline: every value has exactly one owner, sending a value over a channel transfers ownership to the receiver, and receivers cannot share their state back without explicitly cloning.

The runtime uses **lightweight processes** (similar to Erlang's, BEAM `§6.9`) scheduled cooperatively across an OS thread pool; messages cross processes by ownership move, eliminating the shared-heap data races that motivate Pony's reference capabilities. Garbage collection is *not* required for the ownership discipline (Inko's runtime uses RC for cyclic references inside one process), so allocation and reclamation are deterministic and the compiler can reason about resource lifetimes statically.

Distinct from Pony: no capability lattice — every value is "owned by one process" and that's the entire discipline. Distinct from Rust: no borrow checker; references are not first-class, and "borrows" within a function are inferred from lexical scope rather than explicit lifetime annotations. Distinct from Erlang: static typing throughout, with HM-derived inference and explicit type annotations at module boundaries.

Status (as of 2026-04): pre-1.0, actively developed since ~2015, version 0.18 released 2025. Production users few; the language's value as a design data point is the proof that **the Rust-ownership/Erlang-process combination is a coherent design choice** without committing to either the borrow checker's complexity or the BEAM's runtime. Sources: https://inko-lang.org/ and https://docs.inko-lang.org/manual/master/getting-started/concurrency/ and https://github.com/inko-lang/inko

---

## 2. Region-Based Memory Management

This chapter covers both classic region systems, where lifetimes enable bulk deallocation, and newer region-like designs where regions act as isolation domains, borrowing/projection scopes, or allocator/runtime layout units. The axis across entries is *who specifies the region structure*: programmer (Cyclone, Encore), full inference (MLKit, ASAP), capability annotations (Verona, Pony), opt-in projection on top of generational refs (Vale), or runtime layout policy (RC-Immix). The trade-off is annotation burden vs. inference power vs. expressiveness across concurrency and runtime implementation. Compile-time RC and tracing GC sit at the two endpoints of "no annotation" approaches; regions are the structurally distinct middle ground.

### 2.1. Cyclone — Explicit Regions and Outlives Subtyping

Grossman, Morrisett, Jim, Hicks, Wang, Cheney's **Cyclone** (PLDI 2002) is a safe C dialect with explicit, lexically-scoped region annotations on pointer types. Pointer types `int*ρ` are parameterised by region variables; a LIFO discipline on region lifetimes induces an outlives relation that becomes a sound subtyping rule. Existential region bounds let closures and ADTs hide their captured region while still proving non-dangling.

The annotation burden was empirically tractable: porting legacy C, only ~6% of an 8% changed-line set were region annotations. Cyclone's algorithm is bidirectional type-checking with effect inference — not full Hindley-Milner reconstruction. Tracked unique/RC pointers were added in the 2006 SCP follow-up. Cyclone is the canonical "explicit regions, modest annotation cost" reference and the direct ancestor of Rust's lifetime annotations.

Sources: https://www.cs.umd.edu/projects/cyclone/papers/cyclone-regions.pdf and https://www.cs.umd.edu/projects/PL/cyclone/scp.pdf and https://www.cs.cornell.edu/Projects/cyclone/online-manual/main-screen008.html

### 2.2. Tofte–Talpin / MLKit — Automatic Region Inference

The canonical "no annotations, all inferred" baseline. Tofte–Talpin's stack-of-regions semantics (1994; ICFP 1996; IC 1997) is a region-annotated lambda calculus where every value lives in a region, regions form a runtime stack, and `letregion ρ in e` is the only allocation/deallocation primitive. Region- and effect-polymorphism with *polymorphic recursion in regions* is the load-bearing extension: type schemes ∀α…ρ…ε.τ are required for recursive functions to allocate into different regions per call.

Algorithm specification: unification + constraint-solving. Mads Tofte / Martin Elsman's syntax-directed Algorithm R (TOPLAS 1998) uses Algorithm-W-style unification with fixed-point iteration to handle polymorphic-recursive regions; Birkedal–Tofte's alternative is constraint-based. MLKit ships the syntax-directed one. Storage-mode / multiplicity inference further refines representations after inference. Annotation burden: zero; inference power: very strong, with classic pathologies (region "stuck" until end of program — the leak problem, partly fixed by Aiken–Fähndrich–Levien 1995's relaxed LIFO).

Sources: https://elsman.com/mlkit/pdf/toplas98.pdf and https://elsman.com/mlkit/pdf/retro.pdf

### 2.3. MLKit + GC and Parallel Region Inference

Two recent extensions of the MLKit line worth naming separately. Elsman & Hallenberg (JFP 2021) combine region inference with tag-free generational GC: per-region collectors are specialised by exploiting *typed regions*, and write barriers are minimised. Empirically the combination often beats either technique alone — regions handle the common case (short-lived data freed in bulk), GC handles the pathological case (long-lived data with complex sharing). Elsman & Henriksen (PLDI 2023) deliver parallel region inference for MLKit with leaf threads, avoiding allocation races. Together these papers update the 1990s MLKit story to a multicore world.

Sources: https://elsman.com/mlkit/pdf/jfp2021.pdf and https://elsman.com/mlkit/pdf/parreg-pldi23.pdf

### 2.4. Verona — Per-Region Pluggable Strategies and Behaviour-Oriented Concurrency

Microsoft Research / Imperial / Uppsala's **Verona** is a concurrent OO language where every object lives in exactly one of a *forest of isolated regions*, and a thread has at most one "window of mutability" — the active region — at a time. The distinctive contribution: **per-region pluggable memory strategies** (trace, RC, arena) chosen by the programmer, so a region's policy doesn't bleed into the rest of the program (Cheeseman et al., OOPSLA 2023). Reference-capability types — `iso`, `mut`, `imm`, plus capabilities for moving objects between regions/threads — enforce isolation with no atomic ops on data accesses.

**Behaviour-Oriented Concurrency** (BoC, OOPSLA 2023) replaces actors with `when` behaviours that asynchronously acquire exclusive access to multiple `cown`-wrapped regions atomically — solving the "atomic update of N actors" problem actors leave open. **Dynamic Region Ownership** (PLDI 2025) is a *dynamic* enforcement of the same discipline retrofitted into Python, relevant to the free-threaded CPython work. Verona is the most ambitious modern composition of regions + concurrency + memory-strategy choice.

Sources: https://dl.acm.org/doi/10.1145/3622846 and https://www.microsoft.com/en-us/research/publication/dynamic-region-ownership-for-concurrency-safety/ and https://github.com/microsoft/verona

### 2.5. Encore — Capabilities-as-Regions for Active Objects

Brandauer, Castegren, Clarke, Wrigstad et al.'s **Encore** (UpScale, 2015–2018) is an actor/active-object language whose type system uses reference capabilities (linear, locally-shared, subordinate, thread-local, read-only) to control aliasing across active-object boundaries. Per-actor unshared local heaps + capability-checked transfer: passing an exclusive (linear) capability to another actor is a move; subordinate objects cannot escape their owning actor. A capability annotates a *type*, demarcating an aliasing regime — ownership is checked structurally rather than via Tofte-Talpin region variables.

Encore is the cleanest example of "capabilities-as-regions" at the language level — closer in shape to Pony than to Cyclone, but with a stronger emphasis on parallel-combinator coordination.

Sources: https://ebjohnsen.org/publication/15-encore/15-encore.pdf and https://eliasc.github.io/

### 2.6. Vale — Region-Borrowing Prototype and Group Borrowing

Evan Ovadia's **Vale** layers region borrowing on top of generational references. `COMPILERS.md §16.3` summarizes the compiler-pass angle: runtime generation checks are inserted explicitly, then eliminated where region and immutability analysis proves them redundant. The first region-borrowing prototype shipped July 2023: pure functions and `region` blocks can temporarily make data immutable, eliminating generation checks for code inside the block. The August 2025 **Group Borrowing** proposal (Nick Smith, endorsed by Ovadia) is a *zero-overhead* alternative to aliasable-xor-mutable — adds mutable aliasing without RC/GC/generational refs, described as cleaner than Vale's regions, still draft. Hybrid-Generational Memory was effectively abandoned after ~32 iterations; Ovadia explicitly says regions + generational refs subsumed it.

Annotation burden is opt-in: programs run without regions; add `pure`/region annotations only where you want zero generation checks. This is the "regions as immutability projection" design point — distinct from regions as deallocation discipline.

Sources: https://verdagon.dev/blog/regions-prototype and https://verdagon.dev/blog/group-borrowing and https://verdagon.dev/grimoire/grimoire

### 2.7. ASAP — As-Static-As-Possible

Raphaël Proust's **ASAP** (Cambridge PhD 2017) is fully automatic, with no annotations and no GC: dataflow analyses (usage + aliasing) emit per-program-point deallocation instructions at compile time, falling back to bounded runtime scans only when static info is insufficient. Subsumes both linear types and Tofte–Talpin regions: given a linear/region-correct program, ASAP emits equivalent free instructions. Where static analysis can't decide, it inserts specialised scan-and-deallocate code (bounded, unlike a tracing GC).

Followed up by Nathan Corbyn's Cambridge Part II (2020) with an LLVM backend and benchmarks vs. Boehm GC. It is the most aggressive no-annotation, no-GC point in the design space.

Sources: https://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-908.pdf and https://nathancorbyn.com/nc513.pdf

### 2.8. Boyapati — Single-Owner Regions for RTSJ Java

Boyapati, Salcianu, Beebee, Rinard (PLDI 2003) fuse ownership types and region types for RTSJ Java. Every object has an owner (object or region); the ownership relation is acyclic; encapsulation and outlives are statically enforced. This eliminates RTSJ runtime checks for scoped-memory access, significantly faster than dynamic checks. The work directly influenced Encore's and Pony's later capability designs and is the cleanest "regions + ownership types" combination on a JVM-class language.

Sources: https://people.csail.mit.edu/rinard/techreport/MIT-LCS-TR-869.pdf and https://dl.acm.org/doi/10.1145/781131.781168

### 2.9. RC-Immix Region Coloring (Runtime Layout)

Not a region *language* feature but a *runtime* layout technique. Shahriyar, Blackburn, Yang, McKinley (OOPSLA 2013) marry reference counting with Immix's mark-region heap (lines + blocks) for high-throughput RC. Per-line live-object counts (a coarse "region color") let the collector reclaim whole lines when the line count hits zero, avoiding free-list fragmentation. Proactive + reactive copying integrated with RC eliminates fragmentation; backup tracing handles cycles. See `MEMORY.md §6.2` for LXR, which extends this lineage with low-latency region-colored RC.

Region granularity is independent of language-level region semantics — purely a layout/locality optimization. The lesson is that the same word means two different things in this chapter and chapter 6: programmer-visible regions vs. allocator-internal regions.

Sources: https://www.steveblackburn.org/pubs/papers/rcix-oopsla-2013.pdf and http://arxiv.org/pdf/2210.17175v1

### 2.10. Spegion — Implicit and Non-Lexical Regions with Sized Allocations

Hughes, Vollmer, and Batty's **Spegion** (ECOOP 2025) revisits region-based memory management with three modern constraints: region lifetimes should be **implicit**, should be **non-lexical**, and should support **sized allocations** rather than assuming uniform heap cells. Classic Tofte–Talpin regions (§2.2) infer region structure but tie deallocation to lexical region scopes; this makes some natural allocation patterns impossible or forces data to remain live longer than necessary. Spegion loosens that shape by allowing region lifetimes to follow control-flow use rather than block nesting.

The non-lexical aspect is the main bridge to Rust-style NLL (`MEMORY.md §1.1`): a region can become dead at the last use rather than at the end of the syntactic scope that introduced it. The sized-allocation aspect makes the calculus more implementation-facing than many classic region calculi, because real allocators care about object size classes, block reuse, and layout decisions.

The lesson is that **region systems are not limited to lexical stack-shaped lifetimes**. A language can keep the bulk-free and no-tracing benefits of regions while moving toward flow-sensitive lifetimes familiar from modern borrow checking. Status (as of 2026-04): research-grade, but directly relevant to languages searching for a middle point between GC, ownership, and arena allocation.

Sources: https://arxiv.org/abs/2506.02182 and https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2025.15

---

## 3. Compile-Time Reference Counting

Reference counting as a *compilation strategy* — the compiler inserts inc/dec/reset/reuse operations from a static analysis, not the programmer. The axis is *how cycles are handled* (banned by linearity, banned by language rule, programmer-managed weak refs, runtime cycle collector) and *how in-place mutation is enabled* (compile-time uniqueness proof vs. runtime RC == 1 check). This chapter owns the memory-model survey; `COMPILERS.md §16.1` keeps the shorter compiler-pass capsule for Perceus, and `COMPILERS.md §1.6` covers Roc lambda sets from the monomorphization/defunctionalization angle.

### 3.1. Swift ARC — SIL-Level RC Optimization

Swift compiler-inserts strong/weak/unowned RC ops on every assignment, with aggressive SIL-level optimization passes that elide redundant retain/release pairs. Three-counter side-table model (strong/unowned/weak in `RefCount.h`): inline atomic word that escapes to a side table only when weak refs form, overflow occurs, or associated objects are needed — keeping the common case to one cache line.

The `is_unique` / COW primitive lowers to `Builtin.isUnique`, enabling `Array`/`Set`/`String` value semantics to mutate in place when RC == 1; the optimizer treats `is_unique` as a write to preserve a +1 retain across it. ARC code motion (retain sinking + release hoisting via iterative dataflow in `ARCCodeMotion.cpp`), epilogue-release matching, `TempRValueElimination`, and devirtualized-release stripping for stack-promoted classes round out the toolkit. Cycles are not collected — the programmer uses `weak` (zeroing) or `unowned` (trap-on-use). ObjC bridge forces atomic ops on bridged classes; Swift-native classes use non-atomic fast paths when statically provable single-threaded. Steady CPU overhead is ~10–30% in pointer-heavy code; weak refs are 2–3× more expensive than strong because of side-table indirection.

Sources: https://github.com/swiftlang/swift/blob/main/stdlib/public/SwiftShims/RefCount.h and https://apple-swift.readthedocs.io/en/latest/ARCOptimization.html and https://github.com/swiftlang/swift/blob/main/docs/WeakReferences.md

### 3.2. Perceus — Frame-Limited Reuse, FIP, TRMC

Compiler-pass capsule in `COMPILERS.md §16.1`; details and later developments live here. Three significant developments since 2022:

**Frame-Limited Reuse** (Lorenzen-Leijen, ICFP 2022): drop-guided reuse formally proven *frame-limited* — peak heap grows by at most a constant factor — replacing fragile size-pairing reuse with a robust derivation rule. **FIP / FP² calculus** (ICFP 2023): the `fip` keyword statically certifies a function uses zero allocation and constant stack; covers splay trees, finger trees, merge/quick sort, and generically derived in-place `map`. **TRMC + first-class constructor contexts** (POPL 2023; JFP 2024): tail-recursion modulo context generalizes TRMc to CPS, monoids, and evaluation contexts; the hybrid implementation uses Perceus heap semantics so call/cc and effect handlers stay sound.

Together these turn Perceus from a refcount-with-reuse system into a complete *compile-time imperative-from-functional* programming model — purely functional source, in-place mutation in the binary, with formal frame bounds.

Sources: https://www.microsoft.com/en-us/research/wp-content/uploads/2023/07/flreuse.pdf and https://dl.acm.org/doi/10.1145/3607840 and https://antonlorenzen.de/trmc-jfp.pdf

### 3.3. Lobster — Lifetime-Analysis Borrow-Check-Lite

Wouter van Oortmerssen's **Lobster** is a statically-typed Python-ish language using flow-sensitive lifetime analysis to elide ~95% of RC ops at compile time, with a custom bump-style allocator for the rest. Its lifetime analysis plays a borrow-checker-like role: it tracks ownership through flow-sensitive type inference and specialization, removing inc/dec on locally-scoped references entirely. Inline structs (zero-overhead values) plus race-free, GIL-free multithreading via a distributed memory model mean RC objects do not cross thread boundaries.

Cycles are banned in practice; if leaked, reported at exit with a human-readable diagnostic. Cost is claimed within an order of magnitude of C, far above Python/Lua. The "leak report at exit" is a clever pragmatic move: the cycle problem is pushed back to the programmer, but with tooling support rather than silent leaks.

Sources: https://aardappel.github.io/lobster/language_reference.html and https://aardappel.github.io/lobster/philosophy.html and http://strlen.com/language-design-overview/

### 3.4. Roc Morphic + Lambda Sets

Extends `COMPILERS.md §1.6`. Roc combines **Morphic** (borrow-based RC inference, eliminates most inc/dec) + Perceus reuse + LLVM. Two recent updates worth recording. A Morphic alias-analysis bug surfaced in December 2024 (issue #7367): incorrect in-place mutation when `joinpoint`/`jump` form loops, prompting PR #7370 to *limit Morphic to trivial analysis* until fixed — a useful lesson on the difficulty of proving uniqueness across CFG back-edges. New lambda syntax `|a, b| expr` (issue #7465, January 2025) is purely syntactic but lands alongside continued investment in lambda-set specialization and "ambient" lambda-set inference for type-class method dispatch. The upstream `morphic-lang/morphic` is the cleaner reference implementation than the Roc embedding.

Sources: https://github.com/roc-lang/roc/issues/7367 and https://github.com/morphic-lang/morphic and https://www.roc-lang.org/fast

### 3.5. Nim ARC / ORC — Hooks, Sink/Lent, YRC Threadsafe Cycle Collector

Nim's `--gc:arc` desugars `ref` into hook-driven RC + move semantics; `--gc:orc` adds a Bacon-style cycle collector running on suspected cyclic types. The hooks `=destroy` / `=sink` / `=copy` with control-flow `lastReadOf` analysis convert copies to moves; `sink T` parameters take ownership; `lent T` returns hidden borrows that emit no destructor. `.cursor` and `.acyclic` annotations let the user statically prove an edge can't form a cycle, removing it from ORC's trial-deletion roots — a hand-written escape hatch.

The proposed **YRC threadsafe cycle collector** work (PR #25495) explores striped per-thread queues for acyclic atomic RC plus a single global Bacon collector for cyclic refs, with deferred RC updates and TLA+ model-checked invariants. Status (as of 2026-04): active design / implementation effort, not established Nim behavior. ARC alone leaks cycles; ORC catches them via Bacon trial-deletion. ARC is competitive with manual C in seq-heavy code; ORC adds latency-stable cycle scans.

Sources: https://nim-lang.github.io/Nim/destructors.html and https://github.com/nim-lang/RFCs/issues/177 and https://github.com/nim-lang/Nim/pull/25495

### 3.6. Lean 4 — Atomic-vs-Persistent RC Sentinels

Ullrich & de Moura's Lean 4 compiler (2019+) inserts explicit `inc`/`dec`/`reset`/`reuse` ops in IR (Perceus-like, predates Perceus formalization); reuse analysis enables in-place mutation of unique arrays/strings. The distinctive low-level trick: `m_rc == 0` as a persistent sentinel + sign-bit for thread-shared. Positive RC = single-threaded fast path (non-atomic), negative = atomic, zero = persistent/compact-region (no RC at all). All in `lean.h`.

`isExclusive`-guarded primitives — `Array.set`, `Array.swap` — test RC == 1 and mutate in place, else copy, giving pure functional semantics with imperative speed; `dbgTraceIfShared` helps locate accidental sharing. **PersistentArray** is an HAMT-style trie with a tail buffer mutated in place under unique RC, used pervasively in Lean's elaborator/tactic state — making RC a first-class enabler of an entire compiler architecture. Cycles are banned by language (no mutable cycles in pure Lean values). Comparable to OCaml in functional code; matches imperative when reuse fires.

Sources: https://lean-lang.org/doc/reference/latest/Run-Time-Code/Reference-Counting/ and https://github.com/leanprover/lean4/blob/master/src/include/lean/lean.h and https://docs.lean-lang.org/functional_programming_in_lean/Programming___-Proving___-and-Performance/Insertion-Sort-and-Array-Mutation/

---

## 4. Modern C++ Memory Safety

The C++ language-safety debate of 2024–2026 appears to have shifted toward **Profiles-style migration and library hardening**, while Sean Baxter's Safe C++ proposal stopped being actively pursued in WG21. Profiles also failed to land in C++26 normatively — instead, the committee created a parallel **language safety white paper** (Sutter and Ažman, editors) alongside C++26, while standard-library hardening (§4.8) provides the clearest normative bounds/precondition-checking safety addition. C++26 also ships hazard pointers, RCU, and contracts, which are safety-relevant but address different classes of problems from language-level memory-safety profiles. Entries below differ on *how aggressively the migration story preserves existing C++ semantics*: from Lifetime Profile and Stroustrup Profiles (recompile, fix flagged code) through cppfront (alternative syntax, transpile) to Safe C++ (Rust-style borrow check, viral `safe`) and Fil-C (runtime capabilities, full transparency).

### 4.1. The Profiles vs Safe C++ Resolution (June 2025)

Status (as of 2026-04): in June 2025 Sean Baxter publicly described Profiles as having prevailed in the committee discussion and indicated Safe C++ (P3390) was no longer being continued. SG23 voted to prioritize Profiles over Safe C++. Profiles themselves also failed to forward to CWG for C++26 at Hagenberg (February 2025); the committee instead created a non-normative language-safety white paper targeting compiler implementations behind flags before C++29.

The technical fault lines: the Profiles camp argues annotations should be exceptional and that most existing C++ can be made safer by recompilation plus restrictions plus library hardening, with viral `safe`/lifetime annotations rejected as unacceptable disruption. The Safe C++ camp argues that without language-level aliasing/exclusivity information, sound lifetime safety is impossible and Profiles risk replicating existing static analyzers without verifiable guarantees.

Sources: https://open-std.org/jtc1/sc22/wg21/docs/papers/2023/p2759r0.pdf and https://wg21.link/P3586 and https://www.theregister.com/2025/09/16/safe_c_proposal_ditched/

### 4.2. Lifetime Profile — P1179 in MSVC and Clang

Local-only static analysis identifying generalized "Owner"/"Pointer" types via type categories to detect dangling/use-after-free at compile time without whole-program annotation. Acyclic CFG analysis with ~5% compile-time overhead; identifies Owner (e.g. `unique_ptr`, `string`) vs. Pointer (e.g. `string_view`, iterators) generically; uses `gsl::Owner`, `gsl::Pointer`, `clang::lifetimebound` attributes to refine.

Partially shipped in MSVC (warnings 26486–26489 in C++ Core Check) since 2019; **upstreamed to Clang trunk** as `-Wlifetime-safety` (Clang 23+). Status (as of early 2026): lifetime/profile work is not normative C++26. The active path is a non-normative language-safety white paper plus compiler experiments and flags, with possible later standardization into a lifetime profile.

Sources: https://wg21.link/p1179 and http://clang.llvm.org/docs/LifetimeSafety.html and https://devblogs.microsoft.com/cppblog/lifetime-profile-update-in-visual-studio-2019-preview-2/

### 4.3. Stroustrup's Profiles Framework

Opt-in, scope-applicable bundles of guarantees (bounds, type, lifetime, arithmetic) that a conforming compiler must enforce — restrictions on existing C++ rather than new syntax, with the explicit goal of "fixing existing code by recompilation." Three retained syntactic constructs in P3589: `[[profiles::enforce(...)]]`, `[[profiles::suppress(...)]]`, and the post-Hagenberg `[[profiles::exempt]]` for whole-header opt-out. Initial profiles (P3081 R2): `std::type`, `std::bounds`, `std::lifetime`, plus aggregate `std::strict`. Each rule must be decidable at compile time (allowing injected runtime checks).

Stroustrup's framing (P3651): profiles do not change valid-program semantics, are independent of new features, and trace back decades to Core Guidelines work. Status (as of early 2026): not adopted normatively for C++26; forwarded instead into the parallel language safety white paper. Gabriel Dos Reis has an experimental implementation, and broad VS analyzer support exists for ~4 Core Guidelines profiles already.

Sources: https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2025/p3081r2.pdf and https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2025/p3589r2.pdf and https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2025/p3651r0.pdf

### 4.4. Safe C++ — P3390 / Circle

Sean Baxter's **Safe C++** grafts Rust-style affine types + invasive borrow checker onto C++ as a `#feature on safety` mode with a parallel `std2` standard library. Viral `safe`-specifier and full Mid-Level IR-based NLL borrow checking. New reference syntax `T^` / `const T^` (mutable/shared borrow) with explicit lifetime parameters and outlives-constraints; `rel` relocation operator; choice types (Rust-style enums) with safe pattern matching; affine (move-only) value semantics enforcing law of exclusivity.

P3444 alternative ("Memory Safety without Lifetime Parameters") uses `T%` reference with a single invented lifetime per call — eliminates explicit lifetime annotation burden at cost of expressivity. Implemented end-to-end in Circle (single-author Clang fork); proves a borrow-checker-equipped C++ subset is feasible. Status (as of early 2026): effectively dead in WG21; Baxter publicly stopped work mid-2025 ("The Rust safety model is unpopular with the committee"). His critique site enumerates concrete reasons Profiles cannot achieve sound memory safety without aliasing information.

Sources: https://safecpp.org/P3390R0.html and https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2024/p3444r0.html and https://www.circle-lang.org/draft-profiles.html

### 4.5. cppfront / Cpp2 — Syntax Reform with Safety Defaults

Herb Sutter's alternative-syntax frontend transpiles to today's C++; safety becomes the default with explicit `unchecked_*` opt-outs, while remaining 100% interop with existing C++. Bounds-checked subscripts, null-checked dereferences, mixed-sign comparison rejection, and div-by-zero checks are on by default; `-no-subscript-checks` etc. switch them off per file. Unified `operator=` covers construction/assignment/destruction; `that` parameter for safer copy/move; type-unsafe casts not expressible in Cpp2 syntax.

Compiles to standard C++20 — drop-in into existing build systems with all existing tooling. Personal experiment (Sutter); not on the standardization track. Provides empirical evidence for Profiles-style "safe defaults" claims.

Sources: https://hsutter.github.io/cppfront/ and https://hsutter.github.io/cppfront/cpp2/safety/ and https://herbsutter.com/2025/03/

### 4.6. Fil-C — InvisiCaps and FUGC

Filip Pizlo's **Fil-C** is a fanatically-compatible memory-safe C/C++ compiler using **invisible capabilities (InvisiCaps)** — every 64-bit pointer has shadow capability metadata stored outside the visible address space, looked up on every dereference. Thread-safe variant of SoftBound, immune to pointer races (worst case = panic). FUGC (Fil's Unbelievable Garbage Collector): concurrent, real-time, accurate; threads never suspended; freeing zeroes capability bounds. Stack allocations are heap-allocated to make signal handlers / `longjmp` memory-safe.

Compiles unmodified Linux userspace (Linux From Scratch); supports pthreads, signals, mmap, C++ exceptions, atomics, SIMD intrinsics. Based on Clang 20.1.8. Active single-developer project; ~1.5× slowdown best case, ~4× worst. Not standardized but increasingly cited as the "what a sound C/C++ memory-safety solution actually looks like" reference point.

Sources: https://github.com/pizlonator/fil-c/ and https://fil-c.org/invisicaps.html and https://github.com/pizlonator/fil-c/blob/deluge/Manifesto.md

### 4.7. C++26 Hazard Pointers and RCU

C++26 is the first ISO standard to ship lock-free safe deferred reclamation as primitive vocabulary: `<hazard_pointer>` (P2530R3, derived from Folly's production implementation in use since 2017) and RCU (P2545). Both are complementary — HP behaves as a scalable refcount, RCU as a scalable RW-lock. Mechanism details, reader/writer cost, and retention bounds are in §9.1, §9.2, and §9.12; this entry only marks the C++ standardization milestone.

Sources: https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2023/p2530r3.pdf and https://wg21.link/P2545R0 and https://en.cppreference.com/w/cpp/header/hazard_pointer.html

### 4.8. Hardened libc++ / MSVC STL / libstdc++

The clearest normative C++26 standard-library hardening / bounds-checking memory-safety addition: bounds/precondition checks in standard containers/iterators with controlled performance overhead. **libc++** uses `_LIBCPP_HARDENING_MODE` ∈ {`none`, `fast`, `extensive`, `debug`}; `_LIBCPP_ABI_BOUNDED_ITERATORS` makes iterator types carry bounds for `span`/`string_view`. Shipped 2024. **MSVC STL** ships `_MSVC_STL_HARDENING=1` opt-in (VS 2022 17.14, May 2025); uses `__fastfail`/`__builtin_verbose_trap` for ~29-byte trap codegen; default in a future release. **libstdc++** is actively implementing.

Google reports significant CVE-class elimination from rolling out `fast` mode in production. Standardized in C++26; vendor-shipping but mostly opt-in. The pragmatic C++ safety story is: Profiles for the language layer is unfinished; library hardening is what's actually shipping.

Sources: https://github.com/microsoft/STL/wiki/STL-Hardening and https://learn.microsoft.com/en-us/cpp/overview/cpp-conformance-improvements

### 4.9. Standard Smart Pointers, `span`, `observer_ptr`

Vocabulary types encoding ownership/aliasing intent, the baseline for the Profiles approach. `std::span` (C++20) is the canonical replacement for `T*, size_t` pairs; in hardened libc++ its iterators carry bounds. `observer_ptr<T>` (proposed N4282, "world's dumbest smart pointer" expressing non-owning intent) was never standardized; stuck in `std::experimental` after years; the Profiles era reduces motivation. `unique_ptr` / `shared_ptr` / `weak_ptr` are RAII-based heap ownership; recognized by Clang's lifetime analysis as Owner/Pointer types and form the substrate Profiles enforce against. The lesson: C++'s ownership story is library-level vocabulary types, not language-level affinity — and the Profiles approach doubles down on that choice.

Sources: https://open-std.org/jtc1/sc22/wg21/docs/papers/2014/n4282.pdf and https://cppreference.com/w/cpp/experimental/observer_ptr.html

---

## 5. Hardware-Assisted Memory Safety

Hardware mechanisms add silicon-enforced memory-safety primitives that software-only solutions cannot deliver at acceptable cost. The axis across entries is *what the hardware enforces*: bounded addressing (CHERI capabilities), per-allocation tagging (ARM MTE, SPARC ADI), pointer integrity (ARM PAC), control-flow integrity (Intel CET), or per-page protection groups (MPK). This chapter also includes HWASan as a software-tagged predecessor and design analogue of MTE rather than as a silicon-enforced mechanism. The deployment story is uneven — PAC, CET, and MPK are mainstream; MTE is present on selected consumer devices with device- and OS-specific enablement policies; Apple MIE is an announced production memory-tagging architecture with release-specific coverage; CHERI is mature in research/toolchain ecosystems and emerging embedded deployments; Intel MPX is a cautionary tale of hardware safety done badly.

### 5.1. ARM MTE — 4-Bit Tags and Sync/Async Modes

ARM's **Memory Tagging Extension** stores a 4-bit tag per 16-byte granule, both in pointer top bits (TBI) and in shadow tag memory; hardware checks on every load/store. SYNC / ASYNC / ASYMM modes trade precision for speed — SYNC traps immediately on tag mismatch with the faulting PC and exact address; ASYNC accumulates faults to a status register checked on context switch. Scudo allocator integration randomises tags on malloc/free for use-after-free and linear-overflow detection; see `MEMORY.md §7.5`. Stack tagging is provided by the `AArch64StackTagging` compiler instrumentation pass.

Overhead: Scudo + MTE SYNC ≈ 12% geomean SPECrate, MTE ASYNC ≈ 4% (NanoTag, 2025). Originally marketed as "near-zero" — real cost is non-trivial in SYNC. Status (as of 2026-04): shipping on Pixel 8/9 (opt-in) and upcoming flagship Android SoCs; Apple MIE on recent A-series devices is covered separately in §5.2. The **TIKTAG attack** (2024) demonstrated speculative tag leakage on Pixel 8.

Sources: https://android.googlesource.com/platform/bionic/+/main/docs/mte.md and https://arxiv.org/pdf/2509.22027 and https://learn.arm.com/learning-paths/mobile-graphics-and-gaming/mte_on_pixel8/

### 5.2. Apple Memory Integrity Enforcement (MIE)

Apple's **MIE** is one of the most aggressive consumer deployments of hardware-assisted memory safety to date, combining **Enhanced MTE (EMTE)** in synchronous mode, secure typed allocators (`kalloc_type`, `xzone malloc`), and Tag Confidentiality Enforcement against speculative side channels. Apple pushed Arm to specify EMTE (2022) so synchronous tag-check is cheap enough for production rather than debug-only. **Tag Confidentiality Enforcement (TCE)** is the response to TIKTAG: pointer-offset clamping (<4 GB), Spectre-v1 hardening, poisoning patterns (`0x2BAD`), VA layout tricks to prevent speculative tag leakage.

Status (as of 2026-04): Apple announced production deployment on recent A-series devices with broad system coverage and an Enhanced Security path for third-party apps; exact device coverage, default-on scope, and third-party-app exposure are vendor- and release-specific and should be checked against current Apple platform documentation. This is an important production existence proof that MTE-class safety can move beyond debug-only deployments.

Sources: https://security.apple.com/blog/memory-integrity-enforcement/ and https://8ksec.io/mie-deep-dive-kernel/ and https://developer.apple.com/videos/play/meet-with-apple/206/

### 5.3. HWASan — Software-Tagged ASan via Top-Byte-Ignore

**Hardware-Assisted AddressSanitizer** is compiler-instrumented MTE-style tagging using AArch64 Top-Byte-Ignore (8-bit tag in pointer upper byte) with software-managed shadow tag memory — works without MTE hardware. It is included here as the software-tagged predecessor and design analogue of MTE rather than as a silicon-enforced mechanism. Smaller shadow than ASan (1/16 vs 1/8 memory), per-allocation tagged pointers, stack-tagging IR pass, outlined check sequences with custom calling convention to keep code small. Higher cost than MTE (everything is software) but lower than ASan; widely used in Android system builds for fuzzing and debug. Ships in Clang/LLVM upstream; default for Android system-image fuzzing pipeline; precursor to MTE deployments. The full ASan/MSan/TSan/UBSan family lives in `TRACERS.md §8`.

Source: https://clang.llvm.org/docs/HardwareAssistedAddressSanitizerDesign.html

### 5.4. ARM Pointer Authentication (PAC)

Cryptographic MAC (QARMA-based) over upper pointer bits, signed/verified by dedicated PAC instructions; enforces pointer integrity for CFI / ROP / JOP defence. Five keys (IA / IB / DA / DB / GA) with separate signing domains; Apple extends with up to 9 modifier types and hardware diversifiers in XNU; LR signing on call boundaries for backward-edge CFI. Universal on Apple silicon since A12 / M1; mandatory in iOS / macOS kernels; available on most ARMv8.3+ SoCs; Linux uses for in-kernel CFI on arm64. The **PACMAN attack** (2022) showed speculative bypass — mitigated in current Apple silicon. PAC sits at the "pointer integrity, not bounds" point — orthogonal to MTE.

Sources: https://www.usenix.org/system/files/usenixsecurity23-cai-zechao.pdf and https://projectzero.google/2019/02/examining-pointer-authentication-on.html and https://cap.csail.mit.edu/sites/default/files/research-pdfs/PACMAN-%20Attacking%20ARM%20Pointer%20Authentication%20with%20Speculative%20Execution.pdf

### 5.5. Intel CET — Shadow Stacks and Indirect Branch Tracking

Intel's **Control-flow Enforcement Technology** combines a hardware shadow stack (CALL pushes return addr; RET checks mismatch → #CP fault) and Indirect Branch Tracking (indirect CALL/JMP must land on `ENDBR` opcode). Shadow stack lives in special read-only-to-userspace pages; speculation also limited to ~2 instructions past non-ENDBR targets (Alder Lake+). Ships on Tiger Lake (11th gen, 2020) and later, AMD Zen 3+. Linux: CET-IBT in 5.18, **userspace shadow stack in 6.4 (2023)**. Windows 11 enables Hardware-enforced Stack Protection. Mainstream now.

Sources: https://docs.kernel.org/next/x86/shstk.html and https://www.phoronix.com/news/Intel-CET-IBT-For-Linux-5.18

### 5.6. CHERI / Morello / CheriBSD

Cambridge / SRI International's **CHERI** replaces 64-bit pointers with 128-bit unforgeable capabilities — address + bounds + permissions + 1-bit validity tag in tagged memory — enforced by the ISA. It provides hardware-enforced spatial safety and strong pointer provenance/integrity for C/C++; temporal safety requires an accompanying revocation, quarantine, or allocation discipline. Software compartmentalisation (sub-library c18n in CheriBSD 25.03 isolating malloc/syscall surface) and a pure-capability ABI (CheriABI) build on the ISA. Overhead ~2.2–3.2% geomean for SPECint 2006 in pure-cap mode on optimised microarchitectures; the Morello prototype is much higher because store buffers were sized for 64-bit. Doubled pointer size also imposes significant memory overhead.

Status (as of 2026-04): Morello is a research prototype, not commercial; CheriBSD 25.03 is the reference OS; production silicon for a Morello successor still pending. Wind River joined the CHERI Alliance in April 2026 (porting VxWorks/Helix to CHERI on RISC-V). Programming-model details, including compartments, are in §10.2.

Sources: https://www.cl.cam.ac.uk/research/security/ctsrd/pdfs/202411-iccd-cap-contracts.pdf and https://www.cheribsd.org/release-notes/25.03/index.html and https://www.businesswire.com/news/home/20260421249526/en/Wind-River-Joins-the-CHERI-Alliance

### 5.7. CHERIoT — Microcontroller CHERI

32-bit RISC-V CHERI variant designed from scratch for MCU-class deeply embedded systems; combines hardware memory safety with rich compartmentalisation. Object-granularity heap safety in hardware (incl. assembly); revocation-based use-after-free; lightweight cross-compartment calls; 64-bit capability over 32-bit address (4 bytes metadata + 4 bytes addr). Status (as of 2026-04): CHERIoT 1.0 ISA released November 2025; SCI Semiconductors **ICENI** chip (cheriot-ibex core) returning from fab and scaling mass production in 2026 — *first commercial CHERI silicon*. Microsoft's CHERIoT-RTOS is open-source; CHERIoT-Rust port active.

CHERIoT is the most plausible near-term CHERI deployment: avoiding the Morello-class store-buffer cost by targeting MCUs where pointer-size growth is acceptable and compartmentalisation is the killer feature.

Sources: https://cheriot.org/sail/specification/release/2025/11/03/cheriot-1.0.html and https://github.com/Microsoft/cheriot-ibex and https://www.microsoft.com/en-us/research/publication/cheriot-rtos-an-os-for-fine-grained-memory-safe-compartments-on-low-cost-embedded-devices/

### 5.8. SoftBound / CETS / LowFat — Software-Pointer Bounds Research

Pure software pointer-based bounds (SoftBound) and identifier-based temporal safety (CETS) via LLVM IR instrumentation with disjoint metadata; LowFat encodes bounds in pointer's bit-pattern via aligned size-class allocator. Overhead: SoftBound ~83% spatial, +CETS = ~116% combined. LowFat much cheaper for heap (single-digit %) at the cost of no sub-object detection. Research only; influence visible in HWASan/MTE designs and CHERI's pointer-with-metadata model; never deployed in production toolchains. Worth naming for design genealogy.

Sources: http://acg.cis.upenn.edu/softbound/ and https://acg.cis.upenn.edu/papers/ismm10_cets.pdf and https://github.com/GJDuck/LowFat

### 5.9. Memory Protection Keys — MPK / PKU / Arm POE

4-bit (x86) or 3-bit (ARM POE) key per page table entry + per-thread permission register (PKRU/POR_EL0); permission changes via single user-mode WRPKRU/MSR write (~20–26 cycles), *no TLB flush*. Intra-process isolation without page-table modifications; per-thread view enables data-plane sandboxing (libmpk, ERIM, Hodor).

Intel Skylake-SP (2017)+ server, Tiger Lake+ client; AMD Zen 3+; ARMv8.9 FEAT_S1POE (2024+ silicon). Linux pkey APIs upstream. Used in WebAssembly sandboxes, OpenSSL key isolation, JIT W^X. The fast cross-domain switch (no TLB flush) is what makes MPK uniquely useful for in-process compartmentalisation.

Sources: https://kernel.org/doc/html/latest/core-api/protection-keys.html and https://www.usenix.org/system/files/sec20fall_connor_prepub.pdf

### 5.10. CHERI-Lite — Lower-Cost Capability-Style Mitigation

**CHERI-Lite** (Microsoft Research, 2025) explores a middle ground between full CHERI capabilities (§5.6) and lighter-weight pointer-tagging designs such as MTE (§5.1). The core idea is to retain the security value of *tagged, non-forgeable pointers* while reducing the hardware and software adoption burden of full architectural capabilities. Instead of carrying the full CHERI semantic model — bounds, permissions, sealed object capabilities, and a pure-capability ABI — CHERI-Lite focuses on preventing attackers from freely fabricating pointers and reusing stale ones in the most common exploit patterns.

The design point matters because full CHERI is powerful but expensive:
- pointers become larger;
- ABIs and compilers change substantially;
- legacy code and interoperability become harder;
- hardware support must be pervasive to get the full benefit.

CHERI-Lite is therefore best read as a **transition strategy** rather than as a replacement for full CHERI. It suggests a practical deployment path for ecosystems that want stronger memory-safety exploit mitigation than MTE/PAC/CET alone provide, but cannot yet absorb the full compatibility cost of CHERI.

For language and runtime designers, the lesson is that hardware memory-safety mechanisms need not be all-or-nothing. There is a meaningful design space between:
- full spatial+authority capability systems (CHERI, CHERIoT);
- tagging-only systems (MTE, HWASan);
- and control-flow-only integrity systems (PAC, CET).

Status (as of 2026-04): research-stage proposal, not a mainstream deployed hardware target.

Sources: https://www.microsoft.com/en-us/research/publication/cheri-lite-for-memory-safety-exploit-mitigation/ and https://www.microsoft.com/en-us/research/wp-content/uploads/2025/11/CHERI-Lite-for-Memory-Safety.pdf

### 5.11. SPARC ADI and Intel MPX — Lessons from Predecessors

Two cautionary tales whose lessons informed every later design.

**SPARC ADI (Application Data Integrity)** is the direct conceptual ancestor of ARM MTE: 4-bit tag per 64-byte granule encoded in SPARC pointer top bits; hardware checks on load/store. Shipped on SPARC M7 (2015) through M8/T8; Solaris `adiheap`, `adistack`, `libadimalloc`, KADI for kernel. Effectively legacy as Oracle has wound down SPARC; the *idea* won via MTE.

**Intel MPX** (deprecated, removed post-Tiger Lake) failed for concrete reasons: up to 50% slowdown, 4× page faults, cache pressure from bounds-table walks; only 4 bounds registers → constant spill/fill into bounds tables; no temporal safety; ABI-breaking; false positives on legal C idioms; broken with multithreading and SGX/TSX. GCC dropped support, Clang never added it. The MPX failure pattern — too few hardware resources, no temporal coverage, ABI breakage — directly informed MTE / CET / CHERI designs.

Sources: https://docs.oracle.com/en/operating-systems/solaris/oracle-solaris/11.4/prog-interfaces/using-application-data-integrity-adi.html and https://arxiv.org/pdf/2009.06490

---

## 6. Tracing GC Architectures

Tracing collectors trade per-op simplicity for periodic root-and-trace overhead. The axis across entries is *which performance dimension is optimized*: throughput (parallel collectors, generational hypothesis), latency (Pauseless / C4 / ZGC / Shenandoah lineage), memory footprint (Erlang per-process), or actor isolation (Erlang again, OCaml 5 domains). Two further axes cut across: *whether the collector compacts* (mark-region in Immix, mark-compact in ZGC, mark-sweep with no compaction in Go) and *the write-barrier cost*. The chapter also covers the **Boehm-Demers-Weiser** conservative collector for unmodified C/C++ and the **MPS** pluggable-pool framework, the historical **HotSpot CMS / ParNew / Parallel Scavenge** lineage that preceded G1/ZGC/Shenandoah, and the recent JVM heap-layout shifts — **Project Valhalla** value classes (changing what objects exist) and **Project Lilliput** compact object headers (shrinking the objects that remain).

### 6.1. Immix — Mark-Region with Opportunistic Evacuation

Blackburn & McKinley's **Immix** (PLDI 2008) is a mark-region collector that allocates and reclaims memory in contiguous regions at a coarse block grain when possible and finer line grain otherwise — defining a fourth GC family alongside semi-space, mark-sweep, and mark-compact. Two-level block (32 KB) / line (128 B) hierarchy enabling bump-allocation into partially-free blocks. Opportunistic evacuation that mixes copying and marking in a single pass — evacuates only fragmented source blocks when target space is available, otherwise marks in place. The same allocator path serves mutator and collector, achieving 7–25% improvement over canonical collectors. Foundational; basis for Rust's experimental GC, Scala Native, MMTk's flagship plan, Ruby/Julia MMTk bindings, and LXR.

Source: https://www.steveblackburn.org/pubs/papers/immix-pldi-2008.pdf

### 6.2. LXR — RC + Immix for Low Latency at Throughput

Zhao, Blackburn, McKinley's **LXR** (PLDI 2022) combines reference counting with Immix's mark-region heap to deliver low pauses *via* regular brief stop-the-world cycles plus occasional concurrent tracing for cycles — contradicting the orthodoxy that low pauses require concurrent copying. Field-logging coalescing write barrier with only ~1.6% mutator overhead, jointly maintaining RC, remembered sets, and the concurrent SATB log. RC remembered sets enable judicious copying of mature objects without full evacuation. Lazy decrement processing and survival-rate-driven pause modulation; on Lucene with a tight heap, 7.8× throughput and 10× better p99.99 tail latency over Shenandoah.

Research collector implemented atop MMTk; not in production but actively developed. Challenges the C4 / ZGC / Shenandoah cost premise — that latency requires concurrent copying — by showing brief regular STW + RC can hit *both* better throughput and better tail latency.

Sources: https://www.steveblackburn.org/pubs/papers/lxr-pldi-2022.pdf and https://arxiv.org/pdf/2210.17175v1

### 6.3. MMTk — Memory Management Toolkit

Portable, language-agnostic GC framework written in Rust providing a catalog of pluggable plans (NoGC, MarkSweep, SemiSpace, Immix, GenImmix, StickyImmix, LXR) accessed through a clean binding API. Cross-runtime architecture with separate bindings (mmtk-openjdk, mmtk-julia, mmtk-ruby, mmtk-v8); plans share allocators, barriers, and tracing infrastructure. First-class support for hierarchical Immix and reference-counting plans not available in any production runtime. **Drives Ruby's Modular GC** (Feature #20470) shipped in Ruby 3.4 (January 2025) — the first production-language adoption of the framework as a bundled gem.

Shipped experimentally with Ruby 3.4 (MarkSweep only currently, Immix in testing). Julia binding active. V8 binding stalled. OpenJDK binding most mature. The "GC as portable library" idea is what makes LXR-class research immediately transferable to multiple production runtimes.

Sources: https://github.com/mmtk and https://railsatscale.com/2025-01-08-new-for-ruby-3-4-modular-garbage-collectors-and-mmtk/

### 6.4. ZGC — Colored Pointers and Self-Healing Load Barriers

OpenJDK's **ZGC** is a concurrent region-based compacting collector using colored 64-bit pointers with metadata bits and load barriers to translate stale references on the fly, achieving sub-millisecond pauses independent of heap size up to 16 TB. Colored pointers — Marked0/Marked1/Remapped/Finalizable bits embedded in the high bits of 64-bit references; a load barrier resolves stale pointers without an STW remap phase. Self-healing barriers update the loaded reference back into the field, ensuring each barrier slow path fires at most once per location. **Generational ZGC** (JEP 439, JDK 21+) added a young generation with store barriers for young/old tracking; in JDK 25 it became the *only* ZGC implementation (legacy non-generational mode removed).

Status (JDK 25): production since JDK 15. Generational ZGC is the only ZGC mode in JDK 25 LTS, which does not imply ZGC is the default JVM collector; Linux/Windows/macOS.

Sources: https://openjdk.org/jeps/439 and https://wiki.openjdk.java.net/display/zgc

### 6.5. Shenandoah — Load Reference Barriers

Red Hat / OpenJDK's **Shenandoah** is a concurrent compacting collector that performs object relocation in parallel with the application, with pause times in low milliseconds independent of heap size. Evolved from Brooks-style forwarding-pointer indirection on every read (JDK 12) to **load reference barriers** (JDK 13) that fire only at reference-load definition sites, eliminating primitive-read overhead. Self-fixing barriers (JDK 14): the slow path CAS-updates the field back to the to-space copy, so each location pays the slow path at most once. Connection-matrix region tracking instead of card-table-style remembered sets; supports heaps up to ~4 TB; generational mode (JEP 404) introduced experimentally.

Status (as of 2026-04): production-ready since JDK 15; default in Red Hat builds; widely used for latency-sensitive Java workloads.

Sources: https://developers.redhat.com/blog/2019/06/27/shenandoah-gc-in-jdk-13-part-1-load-reference-barriers and https://developers.redhat.com/blog/2020/03/04/shenandoah-gc-in-jdk-14-part-1-self-fixing-barriers

### 6.6. G1 — Predictive Pause-Time Regional Collection

Status (as of 2026-04): the default JVM collector since JDK 9. Regional generational collector that divides the heap into ~2048 fixed-size regions and uses pause-time prediction to select a "collection set" of highest-yield regions, balancing throughput with a soft pause-time goal. Tracks per-region live-data and copy cost to fit collections within `-XX:MaxGCPauseMillis`. Concurrent SATB marking identifies old regions; subsequent stop-the-world mixed collections evacuate young regions plus selected old regions chosen by the pause-time model. Card-table + remembered-set mechanics scale to heaps in the tens of GB (practical ~32 GB) without colored pointers or load barriers.

Throughput-leaning workhorse; baseline pauses ~9–10 ms at idle, frequent multi-ms pauses under load. Does *not* hit sub-ms in practice — the latency story belongs to ZGC, Shenandoah, and C4.

Source: https://docs.oracle.com/en/java/javase/24/gctuning/garbage-first-garbage-collector-tuning.html

### 6.7. Azul C4 — The Pauseless Lineage

Azul's **Continuously Concurrent Compacting Collector** (production since 2010) is the direct ancestor of ZGC and Shenandoah. Generational pauseless collector using a Loaded Value Barrier (LVB) read barrier to support concurrent compaction, concurrent remapping, and concurrent incremental-update tracing. Simultaneous-generational concurrency: young and old generation collections run concurrently and independently, never blocking each other. LVB read barrier ensures every loaded reference is "self-healed" to a safe form, allowing relocation without STW remap. OS-kernel virtual-memory enhancements (originally on Linux) sustain the high VM mapping rate required for pauseless operation. The sole collector in Azul Prime (formerly Zing).

Sources: https://www.azul.com/products/components/pgc/ and https://dl.acm.org/doi/10.1145/1993478.1993491

### 6.8. Go — Hybrid-Barrier Tricolor Concurrent Mark-Sweep

Go's GC is concurrent non-generational, non-compacting tricolor mark-sweep with a hybrid write barrier; the design is explicitly latency-first ("minimize latency, not maximize throughput"). The hybrid Yuasa+Dijkstra-style write barrier was introduced around Go 1.8 to eliminate the stack-rescan STW phase; later releases continued refining pacing, assists, and latency behavior. STW phases (mark/sweep termination) typically stay short. **`GOMEMLIMIT`** (Go 1.19) — soft absolute heap cap with a GC-CPU governor preventing thrashing; complements the ratio-based GOGC. Pacer redesign work and assist-credit accounting; allocate-black + size-segregated 8 KB spans per-P eliminate locks in the common path.

Trade-off is no compaction (potential fragmentation), no generations (every GC is full-heap), but excellent tail latency and predictable behaviour. The most consequential design choice is *not having generations* — Go bet that the generational hypothesis would not hold for its actual workloads, and the bet has held up.

Sources: https://go.dev/doc/gc-guide and https://go.dev/src/runtime/mgc.go

### 6.9. Erlang/BEAM — Per-Process Heaps

Each lightweight process owns a private generational copying (Cheney-style) heap; messages are deep-copied across heaps so no inter-process references exist, eliminating any global GC pause. Per-process generational semi-space copying with `fullsweep_after` counter (default 65535) — major collections almost never run; process death reclaims memory in O(1) with no scan/compaction. Heap binaries (≤64 B) live on the process heap; large refc binaries live in a globally reference-counted heap shared across processes. `on_heap` / `off_heap` message-queue tuning trades sender-side fragment allocation against receiver-side young-heap pressure.

Production for decades; the model many actor/ML runtimes (Pony, Akka tuning) emulate. Per-process heaps make the generational hypothesis *less* relevant: the dominant reclamation mechanism is process death, not generational age. The lesson: if a runtime owns the actor model, it can build memory management around process lifecycles instead of object lifecycles.

Sources: https://www.erlang.org/doc/apps/erts/garbagecollection.html and https://erlang.org/doc/efficiency_guide/processes.html

### 6.10. OCaml 5 — Multicore Domain GC

OCaml 5.0 (December 2022) shipped a stop-the-world parallel minor copying collector + mostly-concurrent mark-sweep major collector, with one private minor heap per *domain* and a shared major heap. STW parallel minor collection: all domains promote in parallel; conflicting promotions of the same object are serialized via interrupts. Idempotent marking + disjoint sweeping on the shared major heap — domains can mark the same object redundantly and each sweeps only its own pool slice; tiny STW only at major-cycle end. Dirty-stack tracking for fibers: stacks not currently running may temporarily violate the strong tricolor invariant, cleaned at minor GCs. Backwards-compatible with single-domain code and the C API. The cleanest example of retrofitting multicore onto a previously single-threaded GC.

Sources: https://fun-ocaml.com/2024/slides/multicore-gc.pdf and https://github.com/ocaml-multicore/docs/blob/main/ocaml_5_design.md

### 6.11. V8 Orinoco — Hybrid Generational Concurrent

V8's **Orinoco** combines parallel, concurrent, and incremental techniques across a generational heap (Scavenger young-gen + Mark-Compact major) to push GC work off the main JS thread. Concurrent marking with helper threads + write-barrier-tracked refs; main thread does only a brief marking-finalization pause. Parallel Scavenger and parallel compaction reduced compaction time from ~7 ms to under 2 ms; concurrent sweeping runs alongside JS execution. Black allocation, parallel remembered-set processing, and Oilpan integration for Blink/C++ tracing across the JS heap boundary. Default in Chrome / Node.js; stable production since ~2017.

Sources: https://v8.dev/blog/trash-talk and https://v8.dev/blog/orinoco

### 6.12. Lua 5.4 — Optional Generational Mode

Optional generational mode (opt-in via `collectgarbage("generational")`) added alongside the default incremental tricolor collector; not the default because it doesn't help large-data-structure workloads. Two-cycle aging (G_NEW → G_SURVIVAL → G_OLD0/1/G_OLD) — objects must survive *two* GC cycles to become old, fixing the inaccurate single-cycle promotion of the failed Lua 5.2 generational experiment. Minor / major multipliers (default 20% / 100% of last-major heap) tune frequency; can degrade to incremental temporarily under stress. Forward-barrier driven; old objects touched by a write transition to G_TOUCHED states tracked in a separate gray list. The cleanest example of "generational hypothesis is workload-specific" — Lua makes it opt-in deliberately.

Sources: https://www.lua.org/manual/5.4/manual.html and https://www.lua.org/source/5.4/lgc.h.html

### 6.13. MoarVM GC — Generational, Parallel STW, Per-Thread Nursery

Raku's MoarVM ships a generational, parallel, precise, *moving* GC. "Parallel" here means stop-the-world but multi-thread cooperation on the collection — *not* concurrent or mostly-concurrent in the ZGC / Shenandoah / Go sense (§§6.4–6.8). The nursery is per-thread (semi-space copying for cheap death-young behaviour); the old generation uses sized buckets with large-object special-casing. Cross-thread reachability is handled by passing `ThreadWork` / `WorkToPass` structures via a per-thread "in-tray" (`add_in_tray_to_worklist`) — the GC's analogue of work-passing across mutator threads, distinct from a traditional remembered-set + write-barrier approach.

The in-flight PR #1861 ("Dedicated nursery memory area") reserves a single ~1 GB virtual region at startup for nursery allocation so the nursery-membership test on the write barrier collapses to a bounds check — eliminating pointer-following on the hot path. Even without colored pointers (§6.4) or load-reference barriers (§6.5), an aggressive per-thread nursery plus bounds-check write barrier delivers respectable latency on a workload (Raku) where most allocations die young.

Sources: https://www.moarvm.org/features.html and https://github.com/MoarVM/MoarVM/blob/master/src/gc/collect.c and https://github.com/MoarVM/MoarVM/pull/1861

### 6.14. Boehm-Demers-Weiser GC — Conservative Tracing for Unmodified C/C++

Hans Boehm, Alan Demers, and Mark Weiser's **BDW collector** (1988+) is the canonical conservative tracing GC and the reason this chapter even discusses GC for languages that "don't have one." *Conservative* means the collector treats every machine word as potentially a pointer — it has no static type information, so it cannot tell pointers from integers and must assume any value matching a heap address is a live reference. This trades some precision for the property that **C and C++ programs need no source modification**: BDW intercepts `malloc`/`realloc`/`free` (or replaces them via `LD_PRELOAD`-style hooks) and walks roots from CPU registers, the call stacks of all threads, and global data segments by scanning bit patterns.

The precision cost is bounded in practice — Boehm's empirical analyses show conservative misidentification typically retains <5% extra memory on real programs — but unbounded in the worst case (an integer that happens to match a heap address keeps an object alive indefinitely). To mitigate this, BDW supports **typed allocation** (`GC_malloc_typed`) where the program declares per-object pointer layout, restoring per-field precision while keeping the conservative root scan. Generational and incremental modes are available; the collector compiles on virtually every Unix and Windows platform.

Distinct from precise tracing GCs in §§6.1–6.13: BDW does not require type metadata at every heap allocation, write barriers, or compiler cooperation — exactly the properties that make it deployable in unmodified C/C++ codebases. Distinct from MPS (§6.15): BDW is one collector, MPS is a framework of pluggable pool classes.

Production: GCJ (Java to native via GCC), historical Mono runtime (replaced by SGen in Mono 2.8, 2010), Mozilla SpiderMonkey's xpconnect bridge, many Scheme implementations (Chicken, MIT/GNU, Bigloo, Gambit), Inferno OS's Limbo runtime, Crystal language runtime, and ~20 years of embedded scripting where adding a precise GC was infeasible. Status (as of 2026-04): still actively maintained and the conservative-GC reference for languages and runtimes that did not include GC support from the start.

Sources: https://hboehm.info/gc/ and https://www.hboehm.info/gc/issues.html and https://www.hboehm.info/papers/spe_88_si.pdf

### 6.15. MPS — Memory Pool System as Pluggable GC Framework

Ravenbrook's **Memory Pool System** (MPS, 1994+) is a flexible GC framework distinct from BDW's single-collector model: MPS supports both **precise and conservative scanning** and is structured around **pool classes** that the application chooses per allocation domain. A program can mix mark-sweep (`AMC`), copying (`AMS`), automatic mark-compact, and reference-counted pools in one heap, with MPS providing the underlying root scanning, write barriers, and GC scheduling.

The architectural lesson is **per-pool memory-management policy in one runtime**. The same program can allocate Java-style objects into a generational copying pool, COBOL-style flat records into a manually-managed pool, and DSL-specific types into a custom pool, all sharing one root set and one collector cycle. Verona's per-region pluggable strategies (§2.4) are conceptually similar but enforced at the language level; MPS provides the same flexibility as a library for languages that do not have language-level region typing.

The implementation has unusually rich verification heritage: MPS's hot-path code is **specified in a formal modelling language** (the "MPS protocol") and large parts of the codebase have been reviewed for memory-management invariants by professional verifiers. Twenty-plus years of continuous maintenance with no major reported memory-safety bug is an unusual record for a 60 KLOC C codebase performing concurrent root scanning.

Production: Open Dylan's runtime is MPS-based; **Configura's CET designer** (a CAD tool) has shipped on MPS since the 1990s; the collector also underpins several proprietary financial-systems runtimes. Status (as of 2026-04): commercial support and licensing via Ravenbrook; MPS itself is BSD-licensed.

Sources: https://www.ravenbrook.com/project/mps/ and https://memory-pool-system.readthedocs.io/ and https://www.ravenbrook.com/project/mps/master/manual/html/

### 6.16. HotSpot CMS / ParNew / Parallel Scavenge — The Pre-G1 Lineage

The HotSpot collector lineage that preceded G1 (§6.6), ZGC (§6.4), and Shenandoah (§6.5) is worth recording for design genealogy. **ParNew** is a parallel young-generation copying collector (1990s) that pairs with **CMS (Concurrent Mark-Sweep)** for the old generation. CMS performs concurrent marking and concurrent sweeping with brief STW initial-mark and final-remark pauses, and *does not compact* — accepting fragmentation in exchange for low pauses, the same trade-off Go's GC (§6.8) makes today. **Parallel Scavenge / Parallel Old** is the throughput-oriented STW alternative: parallel young-and-old generation collection without concurrency, optimising for total throughput rather than pause time.

CMS shipped in Java 1.4.2 (2003) and was the latency-oriented JVM collector for over a decade. The architectural pattern — **concurrent marking with STW initial/final marking phases plus non-compacting sweeping** — directly inspired Go's tricolor mark-sweep (§6.8) and indirectly motivated the colored-pointer load-barrier designs (§§6.4, 6.5, 6.7). CMS's failure modes also drove the next-generation designs: **fragmentation** accumulates without compaction, and the eventual fall-back **STW Full GC** becomes the tail-latency floor; **remark-phase pauses** scale with mutation rate and can be unpredictable; and **promotion failures** cascade into stop-the-world events when the old generation fragments enough that an object cannot be promoted.

Status (JDK 14+, 2020): CMS was deprecated in JDK 9 (2017) and removed in JDK 14 (2020), replaced by G1 as default and ZGC/Shenandoah for low-latency. ParNew is removed alongside CMS. Parallel Scavenge / Parallel Old remains available as the throughput-tuned alternative. The deprecation is itself a design lesson: a collector without compaction accumulates fragmentation that eventually forces a full STW compacting collection, and the bound on that pause becomes the tail-latency floor — exactly what colored-pointer designs (§6.4) eliminate by making compaction concurrent.

Sources: https://docs.oracle.com/en/java/javase/13/gctuning/concurrent-mark-sweep-cms-collector.html and https://openjdk.org/jeps/291 and https://openjdk.org/jeps/363

### 6.17. Project Valhalla — JVM Value Types and Heap Layout

**Project Valhalla** (Brian Goetz, John Rose, Dan Heidinga et al., OpenJDK, 2014+) redefines JVM heap layout by introducing **value classes** (formerly "inline classes") and **primitive types in generics**. The change is fundamental to JVM memory: today every non-primitive value is a heap-allocated object with an 8/16-byte header, and `List<Integer>` boxes every `int` into a heap object. Valhalla's value classes are stack-allocated or inlined into containing structures by default; primitive-backed generics avoid the boxing entirely. This is included in the tracing-GC chapter rather than allocators (§7) because the change is fundamentally about *which objects exist on the GC heap at all*, not about the allocator's internal policy.

The mechanism, in stages:

- **Value classes (`value class Point`)**: declared via the `value` modifier; instances have **no identity** (`==` compares fields; `hashCode` is field-based), are **immutable**, and the JIT may **flatten them inline** wherever the container's layout permits. A `Point[]` becomes a flat array of two-coordinate records, not an array of pointers to heap-allocated Points. The flattening is opportunistic: the JIT decides per-call-site whether the value-class is small enough and the container layout regular enough to flatten.
- **Null-restricted types (`Point!`)**: a value type that cannot be null. Null-restricted types are eligible for full flattening; nullable references must still carry a presence indicator (because flattened layout has no natural representation for "absent"). The `!` modifier is the first time JVM types acquire null-restriction at the language level.
- **Primitive types as value classes**: in JDK 25+ preview, `int`, `long`, `double` etc. are unified with value classes, making `int` a value class with static methods and field-like access in the same syntactic position as user-defined value types. The unification eliminates the historical Java distinction between "primitives" and "objects" — everything is an object, but value-class objects flatten.
- **Primitive specialisation in generics** (project-internal "Q-types"): `List<int>` is a real instantiation, not a `List<Integer>` with autoboxing. The JVM specialises the bytecode at first instantiation, so collection types that historically paid 4–8× memory overhead for primitive elements (autoboxed `Integer`s in an `ArrayList<Integer>`) become flat primitive arrays.

The expected memory-pressure impact is large. JEP-Valhalla benchmarks report 2–5× memory reduction and 1.5–3× throughput improvement on workloads that allocate large numbers of small immutable structures (geometry, financial records, collections of pairs, `Optional<T>`, `Map.Entry`). The GC pressure benefit (§§6.4–6.13) compounds: fewer live heap objects means shorter GC pauses, more efficient generational promotion, and better cache locality. ZGC (§6.4) and Shenandoah (§6.5) both gain proportionally because their barrier costs scale with the number of object headers traversed.

Trade-offs: value classes lose object identity, which breaks code that relies on identity-based hashing (`IdentityHashMap`) or `==` reference equality (`object1 == object2` becomes a field-by-field comparison). Synchronisation primitives (`synchronized`, `wait`/`notify`) cannot be applied to value classes — they have no monitor header. Library migration is non-trivial: `Optional<T>`, `Map.Entry`, `LocalDate`, and many JDK types are candidates for value-class migration, but each migration is an ABI change requiring careful staging.

Status (as of 2026-04): Valhalla is in **preview** in JDK 25+ (LW5 prototype), with full delivery expected across JDK 26–28. The first user-facing migration (Java records becoming value classes by default) is the planned smooth-migration path; existing record-based code becomes flattenable without source change. The architectural lesson is that **a managed runtime that started with universal heap allocation can retrofit value semantics**, but the cost is a decade-plus design effort spanning JEPs, ABI changes, and standard-library migrations. For new languages, value classes (or noncopyable structs §1.8, or Hylo's MVS §1.6) should be designed in from day 1 — retrofitting them onto an established type system is what made Valhalla a 12+ year effort.

Sources: https://openjdk.org/projects/valhalla/ and https://openjdk.org/jeps/401 and https://cr.openjdk.org/~briangoetz/valhalla/sov/01-background.html and https://www.youtube.com/watch?v=XBu54ZIXIgM

### 6.18. Compact Object Headers — Project Lilliput / JEP 519

Project Valhalla (§6.17) restructured *which* objects exist on the heap; **Project Lilliput** (Roman Kennke, Andrew Haley et al., OpenJDK 2021+) is the parallel effort to shrink the headers of every object that *does* exist. JEP 519 ("Compact Object Headers") delivered the result in JDK 25 (2025), reducing the JVM object header from 12–16 bytes to **8 bytes** for the vast majority of objects on the heap.

The mechanism, simplified: a Java object header historically contained two words — a *mark word* (~8 bytes; lock state, identity hash, GC age, biased-locking metadata) and a *class word* (~8 bytes on 64-bit, with compressed oops; the pointer to the Klass metadata). JEP 519 rearranges this to fit *both* the mark-word state and the class pointer into a single 64-bit header by:

- Compressing the class pointer to **22 bits** (sufficient for ~4M loaded classes per VM, a comfortable upper bound for almost all production deployments).
- Stealing the remaining 42 bits for mark-word state (lock bits, identity hash, GC age, GC-specific marker bits).
- **Eliminating biased locking entirely** — already deprecated and disabled by default since JDK 15 (JEP 374), so the change formalised a transition that had already happened operationally.
- Using lookup tables for the rare cases where 22-bit class pointers are insufficient.

The memory-footprint impact is large for object-heavy workloads. Benchmarks reported in the JEP and in early production rollouts (Cassandra, Spark, Kafka, large-heap microservices) show **5–15% heap reduction** on typical workloads, with corresponding GC-pause and cache-locality benefits. Combined with **Project Valhalla** (§6.17), the two changes attack heap pressure from opposite directions: Valhalla eliminates objects entirely where possible (value-class flattening); Lilliput shrinks the objects that remain. Together they represent the largest JVM memory-layout shift since the original 64-bit JVM port.

Trade-offs are subtle but real. Identity-hash storage moves: an object's identity hash is now lazily materialised on first `System.identityHashCode()` call rather than always present in the header, costing a one-time atomic update per object. Locking remains correct (the locking protocol is more constrained but functionally equivalent); biased-locking removal had already happened in JDK 15. Some debugging tools (heap dumps, JVM TI agents, third-party profilers) needed updates to handle the new layout — Eclipse MAT, YourKit, JProfiler, and async-profiler released compatible versions in 2024–2025.

Status (as of 2026-04): preview/optional in JDK 24 (`-XX:+UnlockExperimentalVMOptions -XX:+UseCompactObjectHeaders`); shipped in JDK 25 LTS (2025) as the default for new deployments. The JDK 25 LTS release is the canonical "post-Valhalla, post-Lilliput" JVM. Cross-architecture rollout (x86-64, AArch64, RISC-V) is essentially complete.

Cross-reference: the architectural lesson pairs with `REPRESENTATIONS.md §9.1` (JVM bytecode) and §9.2 (CIL) — a managed runtime designed in 1995 with then-luxurious 16-byte headers can shed half that cost three decades later, but only at the cost of multi-year design and validation effort. For a new language designer, **per-object metadata size deserves the same scrutiny per-allocation cost gets** — every byte of object header multiplies by every live object on the heap. Valhalla (§6.17) attacks the count of objects; Lilliput attacks the size of each.

Sources: https://openjdk.org/jeps/519 and https://wiki.openjdk.org/display/lilliput and https://shipilev.net/jvm/objects-inside-out/ and https://openjdk.org/jeps/450

### 6.19. Iso — Request-Private Garbage Collection (PLDI 2025)

Tianle Qiu and Stephen M. Blackburn's **Iso** (PLDI 2025; ANU/Google) is the first request-private garbage collector for Java with a competitive performance profile. The mechanism: each request running on the JVM gets its own *request-private heap region*; when the request completes, its private region is reclaimed wholesale without any thread-local-to-shared-heap promotion. This is the GC analogue to Erlang's per-process heaps (§6.9) — each request lives in its own GC universe — but adapted to Java's shared-mutable-heap reality through **opportunistic copying**: allocations stay request-private when no shared references reach them, and only escape to the shared heap when sharing is observed.

The architectural trick is using **Immix's mark-region heap structure** (§6.1) as the substrate. Immix already partitions the heap into 32 KB blocks; Iso assigns whole blocks to requests at allocation time and reclaims them on request completion. Cross-request references force promotion of the source object to the shared heap, but in measurement on real Java workloads (microservices, REST handlers, Spring Boot apps) the vast majority of allocations remain request-local and are reclaimed with zero tracing.

The reported result: for request-shaped workloads, Iso outperforms OpenJDK G1 (§6.6) by significant margins on both throughput and tail latency, because most allocation/reclamation cycles bypass the global GC entirely. The lesson generalises: **for languages and runtimes serving request/response workloads, partitioning the heap by request is a more direct lever than tuning a global concurrent collector**. Web frameworks have approximated this with object pools and arena allocators per request; Iso brings it into the GC itself, transparently to the application.

Status (as of 2026-04): research-grade, with an artifact at the PLDI 2025 proceedings. Production deployment in OpenJDK or Azul Prime is the natural next step but not yet announced. The architectural pattern — request-scoped heap regions with opportunistic escape to a shared heap — is reusable beyond Java for any GC'd request-shaped runtime.

Sources: https://www.steveblackburn.org/pubs/papers/iso-pldi-2025.pdf and https://dl.acm.org/doi/10.1145/3729285 and https://pldi25.sigplan.org/details/pldi-2025-papers/36/Iso-Request-Private-Garbage-Collection

### 6.20. Arborescent Garbage Collection — Synchronous Immediate Cycle Collection (ISMM 2025)

Lahaie-Bertrand, Oest O'Leary, Melançon, Feeley, and Monnier's **Arborescent GC** (ISMM 2025 Best Paper) addresses the long-standing weakness of reference counting (§3): cycles either leak (ARC, Lobster) or require a separate cycle-collection phase (ORC, Bacon trial-deletion) introducing latency spikes. Arborescent GC instead reclaims unreachable cyclic structures **immediately and synchronously** at the moment the last external reference is dropped, using a dynamic-graph reachability algorithm inspired by Even and Shiloach's classical decremental-connectivity work.

The mechanism: every object maintains an **arborescence** — a spanning tree of incoming references rooted at a globally-reachable anchor. When an edge is removed, the algorithm checks whether the affected subtree can still reach the root via any remaining edge; if not, the entire subtree is unreachable and is reclaimed immediately. The cost per edge update is bounded (related to the subtree's structure, not the heap size); cycles are *not* a special case — they are reclaimed by the same algorithm as acyclic structures.

Compared to existing RC + cycle collectors:
- **Bacon trial-deletion** (used in ORC, CPython): reclaims cycles asynchronously in batched scans; introduces unpredictable latency spikes.
- **Backwards reference counting** (Vale-style generational refs): defers reclamation entirely; requires explicit programmer cooperation.
- **Mark-and-sweep over RC** (some Lisp implementations): a separate full traversal; defeats RC's incremental property.

Arborescent GC reclaims with **bounded latency** in the strict real-time sense — every edge update is processed in time proportional to the size of the affected subtree, not the heap. The trade-off is bookkeeping: every object carries arborescence pointers, and edge updates are more expensive than plain RC's `inc`/`dec`. The empirical evaluation in the paper shows the technique competitive with mature tracing collectors on JavaScript-style workloads while delivering Erlang-class predictability.

The lesson: **for languages where deterministic memory behaviour matters more than peak throughput** (real-time, embedded, financial trading), incremental cycle reclamation via dynamic-graph reachability is now a practical alternative to either pure RC + leak-on-cycles or RC + asynchronous trial-deletion. Status (as of 2026-04): research-grade, ISMM 2025 Best Paper artifact.

Sources: https://oestoleary.com/papers/ISMM25.pdf and https://dl.acm.org/doi/10.1145/3735950.3735953 and https://www.iro.umontreal.ca/~feeley/papers/LahaieBertrandOestOLearyMelanconFeeleyMonnierISMM25.pdf

### 6.21. Eclipse OMR — Pluggable Multi-Language Runtime Toolkit

IBM's **Eclipse OMR** is the open-source extraction of the J9 JVM's runtime components (GC framework, JIT compiler, port library, threading, diagnostic) into a language-agnostic toolkit. Originally built for J9 Java, OMR now serves as the runtime substrate for **OpenJ9** (IBM's drop-in JVM alternative to HotSpot), **Eclipse Omega VM**, and several research/production projects retrofitting GC and JIT capabilities onto languages without their own runtime: **OMR Ruby+** (a Ruby integration with GC and JIT acceleration), **SOM++** (a Smalltalk dialect), and various OMR-based DSL runtimes. JitBuilder is the OMR component that lets a language frontend describe its semantics declaratively and get a JIT-compiled implementation without writing a backend.

**OpenJ9** is the production-grade IBM JVM that consumes OMR as its runtime substrate. Distinct from HotSpot (the OpenJDK default), OpenJ9 ships in IBM Semeru Runtimes and several enterprise Java distributions, with its primary differentiation in **AOT compilation via Shared Class Cache** (a per-machine cache of compiled classes shared across JVM instances), aggressive memory-footprint optimisation (typically 30–60% lower heap-after-startup than HotSpot on equivalent workloads), and an architecture that lets Garbage Collection policy be selected per workload (`-Xgc:concurrentScavenge`, `-Xgc:gencon`, `-Xgc:metronome`, `-Xgc:balanced`). The Shared Class Cache is conceptually similar to .NET R2R (`COMPILERS.md §30.1`) and Project Leyden (`COMPILERS.md §30.2b`) — pre-compiled native code amortised across runs — but OpenJ9's predates Leyden by over a decade and operates at a different granularity (per-class, machine-wide cache).

The architectural contribution is the **decoupling of runtime services from language semantics**: GC, threading, JIT, and diagnostics are reusable libraries with well-defined interfaces, and a new language implementation can pick which to consume rather than building each from scratch. This is similar in spirit to MMTk (§6.3) for GC alone, but OMR is broader (also covers JIT, port library, threading) and originated from production J9 code rather than research prototypes.

Status (as of 2026-04): actively maintained at github.com/eclipse-omr/omr; production via OpenJ9. The lesson: **a language designer building a new managed runtime should evaluate OMR + JitBuilder before writing GC and JIT from scratch**, much as a frontend designer evaluates LLVM before writing a backend. The cost is OMR's specific APIs and assumptions; the benefit is decades of production-tested GC and JIT engineering.

Sources: https://github.com/eclipse-omr/omr and https://eclipse.dev/omr/starter/whatisomr.html and https://projects.eclipse.org/projects/technology.omr

### 6.22. CRGC — Fault-Recovering Actor Garbage Collection in Pekko

Plyukhin, Agha, and Montesi's **CRGC** (PLDI 2025) studies garbage collection in actor systems where failures and recovery are part of the programming model. Actor runtimes complicate ordinary GC because reachability is not only a heap graph question: actors own mailboxes, in-flight messages, supervision relationships, and failure/restart state. A collector must preserve the actor semantics even when faults occur during or around collection.

CRGC's design point is **fault-recovering actor GC** in Apache Pekko, the Apache fork of Akka. The important language-runtime lesson is that actor heaps and actor references should be treated as semantic runtime objects, not merely ordinary heap nodes. Collection, failure recovery, and message delivery must agree on a consistent notion of actor liveness.

This belongs at the boundary between memory management and concurrency: `CONCURRENCY.md §6` owns actors and supervision; this section owns the collection/reclamation consequences. The general design lesson is that **runtime memory management should match the unit of failure and isolation**. Actor-local heaps, per-actor snapshots, and mailbox-aware reachability can make actor runtimes more predictable than a single global object graph.

Sources: https://pldi25.sigplan.org/details/pldi-2025-papers/39/CRGC-Fault-Recovering-Actor-Garbage-Collection-in-Pekko and https://dl.acm.org/doi/10.1145/3729288

### 6.23. Memory Tiering in a Python Virtual Machine

Li et al.'s **Memory Tiering in Python Virtual Machine** (VMIL 2025) explores adapting a CPython-like runtime to heterogeneous memory. Memory tiering moves data among memory classes with different latency, bandwidth, capacity, or persistence characteristics — for example DRAM plus slower large-capacity memory — based on runtime hotness and object behaviour.

The VM-level problem differs from OS-only page migration. A language runtime knows object types, allocation sites, container layouts, reference relationships, and interpreter hot paths; using that semantic information can guide placement better than page-level recency alone. In a Python VM, the challenge is especially visible because object overhead is high, pointer chasing is common, and container objects create rich graph structure.

The design lesson: **future memory managers may need placement policy, not just reclamation policy**. Heap design can expose hot/cold object classification, allocation-site metadata, and profiling hooks so runtimes can target heterogeneous memory without rewriting user programs. This is adjacent to allocators (§7), GC layout (§6), and tracing/profiling (`TRACERS.md §14`) because tiering decisions require runtime telemetry.

Sources: https://people.cs.vt.edu/~butta/docs/vmil25_mtp.pdf and https://conf.researchr.org/details/icfp-splash-2025/vmil-2025/7/Memory-Tiering-in-Python-Virtual-Machine

---

## 7. General-Purpose Allocators

The space below tracing GC and above raw `mmap`. Entries differ on *what they optimize for*: raw throughput (mimalloc, snmalloc, rpmalloc), TLB efficiency at fleet scale (TCMalloc + Temeraire), tail latency under decay (jemalloc), security hardening (Scudo, hardened_malloc, PartitionAlloc), memory footprint (Mesh), hard real-time predictability (TLSF), or language-level allocator ergonomics (Zig's explicit allocator parameters, Odin/Jai context allocators, C3 temp pools, Beef allocator-aware `new`, Hare runtime heaps, D's composable allocator building blocks). Arena/bump allocators are covered in `COMPILERS.md §2.1`.

### 7.1. mimalloc — Three-List Sharding and Secure Mode

Daan Leijen's **mimalloc** (Microsoft Research) uses page-local sharded free lists with three lists per page (`free`, `local_free`, `thread_free`) that enforce a "temporal cadence" — the fast path is hit predictably and maintenance work batches at known intervals. Three-list sharding lets the alloc/free fast path stay branchless while deferred-free and remote-free are merged in lock-free. Encoded free-list pointers (per-page random keys) detect corruption; secure mode adds guard pages around metadata, randomized init, and double-free detection (~10% overhead). Optional "guarded mode" (sampled OS guard pages, e.g. 1/4000) makes UBSan-style overflow detection feasible in production.

Production users: Lean and Koka runtime (its design driver), Redis, .NET runtime experiments, Swift / Python ref-counting backends.

Sources: https://www.microsoft.com/en-us/research/wp-content/uploads/2019/06/mimalloc-tr-v1.pdf and https://microsoft.github.io/mimalloc/modes.html and https://github.com/microsoft/mimalloc

### 7.2. snmalloc — Lock-Free Message-Passing Return-to-Owner

Microsoft Research's **snmalloc** uses lock-free message-passing — instead of thread-local caches, deallocations from foreign threads are batched onto an MPSC queue and "returned to owner" with a single atomic exchange (no CAS loop). Pony-derived MPSC remote-deallocation queue: thousands of cross-thread frees flushed with one atomic op, optimal for producer/consumer workloads. Bump-pointer + free-list hybrid stores all per-slab metadata in 64 bits per 64 KiB slab. Recent versions: meta-data is held out-of-band behind guard pages, in-band metadata uses a corruption-detecting encoding, and a "combining lock" (MCS + flat combining) cuts startup contention.

Default malloc in the Verona language runtime; available as Rust crate / `LD_PRELOAD` shim. The "return-to-owner" model is the cleanest answer to producer-consumer cross-thread free patterns where standard thread-cache designs accumulate orphaned blocks.

Sources: https://www.microsoft.com/en-us/research/publication/issm-2019-proceedings-of-the-2019-acm-sigplan-international-symposium-on-memory-management/ and https://github.com/microsoft/snmalloc

### 7.3. TCMalloc + Temeraire — Per-CPU + Hugepage-Aware

Google's **TCMalloc** (the modern open-source reincarnation, separate from gperftools) uses per-CPU (not just per-thread) caches plus a hugepage-aware backend (Temeraire) that maximises 2 MiB-page coverage for TLB efficiency across the fleet. Per-CPU mode using restartable sequences (`rseq`) for cache access without atomics or per-thread storage explosion. Temeraire's `HugeFiller` / `HugeCache` / `HugeAllocator` / `HugeRegion` heuristics pack allocations onto already-full hugepages while keeping others fully empty so they can be returned to the OS. Hot/cold size-class hints — cold allocations get `MADV_NOHUGEPAGE` and live in a separate page heap, enabling memory tiering.

Production: Google's entire datacenter fleet (search, YouTube, Borg jobs). Status (as of 2026-04): documented fleet-wide deployment per Google's published descriptions; exact rollout share is vendor- and time-specific. The OSDI 2021 paper documents fleet-CPU savings — TCMalloc + Temeraire is optimised for *aggregate* CPU cost across millions of machines, not per-allocation throughput.

Sources: https://google.github.io/tcmalloc/design and https://google.github.io/tcmalloc/temeraire.html and https://storage.googleapis.com/pub-tools-public-publication-data/pdf/cebd5a9f6e300184fd762f190ffd8978b724e0c8.pdf

### 7.4. jemalloc — Decay-Purge and Multi-Arena

Jason Evans's **jemalloc** is a multi-arena allocator (round-robin arena assignment, default 4× CPUs) with explicit dirty/muzzy page state machine and decay-based purge. Two-stage decay: pages transit dirty → muzzy (`MADV_FREE`) → retained, with sigmoidal decay timers (`dirty_decay_ms`, `muzzy_decay_ms`) tunable per arena. Background-thread purge with trylock pattern keeps decay off the allocation hot path. Built-in heap profiling (`jeprof`), arena introspection via `mallctl`, separate huge arena.

Production: FreeBSD libc, Firefox, Redis, Cassandra, Rust historically (2015–2018), Meta's server fleet. The decay-purge model is what gives jemalloc its excellent long-tail behaviour on long-running servers.

Sources: https://people.freebsd.org/~jasone/jemalloc/bsdcan2006/jemalloc.pdf and https://github.com/jemalloc/jemalloc

### 7.5. Scudo — Hardened Allocator with First-Class MTE

LLVM's **Scudo** is a hardened `malloc` derived from LLVM Sanitizers' `CombinedAllocator`, designed around practical-exploit mitigation (not bug detection) with first-class ARM MTE integration (see §5.1 for the MTE hardware mechanism). Primary/Secondary split: primary services blocks of identical size with randomization; secondary uses `mmap` + guard pages for large allocations. MTE: 4-bit random tag per 16-byte granule with exclusion masks (no adjacent-tag collisions); chunks retagged on free for probabilistic UAF detection. Per-block chunk headers carry a checksum that traps corruption; thread-cache assignment is randomized.

Status (as of 2026-04): default allocator in Android 11+ (non-Svelte) and Fuchsia. The "hardening, not detection" framing is important — Scudo aims to make bugs unexploitable, not visible.

Sources: https://llvm.org/docs/ScudoHardenedAllocator.html and https://github.com/llvm/llvm-project/tree/main/compiler-rt/lib/scudo/standalone

### 7.6. GrapheneOS hardened_malloc

64-bit-only OpenBSD-malloc successor focused exclusively on hardening — heavy isolation, per-size-class regions with random bases, and complete metadata/data separation. All mutable allocator state lives in a single dedicated metadata region behind guard pages — *no in-band metadata at all* for slab allocations. Randomly sized guard pages around each large allocation so equal-sized requests yield non-deterministic mappings. Double quarantine (randomized array + queue) plus write-after-free detection via clearing-on-free; integrates with MTE on supported devices.

GrapheneOS system-wide via Bionic; usable on glibc/musl Linux as `LD_PRELOAD`. Sits at the most-aggressive end of the security/throughput trade-off — accepts substantial overhead for maximum exploit mitigation.

Sources: https://github.com/GrapheneOS/hardened_malloc and https://synacktiv.com/en/publications/exploring-grapheneos-secure-allocator-hardened-malloc

### 7.7. PartitionAlloc — Type-Aware Partitioning and MiraclePtr

Chrome's **PartitionAlloc** uses type/size-aware partitioning — different "partitions" exist in disjoint address-space regions and a freed slot can only be reused by an allocation of the same bucket *and* same partition, neutering most type-confusion exploits. 2 MiB super-pages with permanently-inaccessible first/last partition pages (guard pages); metadata in a dedicated, non-adjacent OOB region. **BackupRefPtr / MiraclePtr**: PA stores a refcount per allocation; `raw_ptr<T>` increments it, so freed slots aren't really freed until all dangling pointers drop — turns UAFs into leaks/non-security crashes. PartitionAlloc-Everywhere routes all of Chrome's `malloc` to PA; integrates with MTE on Android Pixel.

Status (as of 2026-04): deployed across all Chromium-derived browsers (Chrome, Edge, Brave, Opera) reaching billions of users per public Chromium documentation; exact per-platform default scope is release-specific. MiraclePtr is the most consequential exploit-mitigation deployed at scale on a memory-unsafe codebase.

Sources: https://chromium.googlesource.com/chromium/src/+/HEAD/base/allocator/partition_allocator/PartitionAlloc.md and https://security.googleblog.com/2022/09/use-after-freedom-miracleptr.html

### 7.8. Mesh — Compaction Without Relocation via mremap

Bobby Powers et al.'s **Mesh** (PLDI 2019) implements "compaction without relocation" — finds pairs of sparsely-occupied pages whose live-object bitmaps are disjoint and merges them at the *physical* page level via `mremap`, leaving virtual addresses unchanged. Randomized allocation + randomized search algorithm provably breaks the Robson worst-case fragmentation bound with high probability. Uses only standard virtual-memory operations (no kernel changes) so it works as a drop-in `LD_PRELOAD` library. Built on Heap Layers; reduced Firefox memory by 16%, Redis by 39% with comparable runtime to state-of-the-art allocators.

The "compact without moving" idea is unique in the allocator literature — virtual memory is what makes it possible.

Sources: https://people.cs.umass.edu/~mcgregor/papers/19-pldi.pdf and https://github.com/plasma-umass/Mesh

### 7.9. rpmalloc — Span-Aligned Lock-Free Cache

Mattias Jansson's **rpmalloc** uses lock-free per-thread caches built on fixed 64 KiB span alignment, so the free path can find the span header by masking low address bits — no central table lookup. Each span is exclusively owned by its allocating thread; cross-thread frees go to a per-span deferred free list and are reclaimed when the owning thread next needs a span. Four-level cache hierarchy (active span, partial-free list, free-span list, global list) with adaptive sizing per size-class. Public domain (Unlicense) and pluggable memory mapper, making it popular in game engines and embedded contexts. Used in Unreal Engine variants, Haiku OS, various Rust crates via `rpmalloc-rs`.

Source: https://github.com/mjansson/rpmalloc

### 7.10. TLSF — Bounded-Time Allocation

**Two-Level Segregated Fit** delivers bounded-time *O(1)* malloc/free for hard real-time systems via two bitmap-indexed levels of segregated free lists, located in O(1) using `clz`/`ffs`. Two-level bitmap: first level partitions by power-of-two, second level subdivides each into linear ranges; a fitting block is found in two bit-scan instructions regardless of heap size. ~4 bytes overhead per allocation; fragmentation typically <15%, max <25%. Pool can be added/removed on the fly, supports externalised headers (`TLSF-EXT`) for non-memory resource arenas.

Production: Eclipse 4diac FORTE IEC 61499 runtime, Linux distros (in-kernel and userland tools), Ravenscar / hard-RT firmware, multimedia codecs, network appliances. The only allocator in this chapter giving a hard worst-case bound — the right choice when latency determinism is the goal.

Sources: http://www.gii.upv.es/tlsf/ and https://github.com/mattconte/tlsf

### 7.11. Hoard — Provable Blowup Bounds

Emery Berger's **Hoard** (ASPLOS 2000) is the foundational scalable malloc — combines per-processor heaps with a single global heap under a discipline that *provably* bounds blowup (factor of P) and avoids false sharing. Superblock model: heaps own contiguous superblocks; when a per-processor heap drops below a fullness threshold, mostly-empty superblocks migrate to the global heap for any thread to claim. *First* allocator to provably bound memory blowup to a constant under producer-consumer workloads. Up to 60× speed-up vs. Solaris malloc and 18× vs. then-best alternatives on 14 CPUs.

Most subsequent allocators (jemalloc, tcmalloc) cite Hoard as ancestor. Worth naming for design genealogy.

Sources: https://people.cs.umass.edu/~emery/pubs/berger-asplos2000.pdf and https://emeryberger.github.io/Hoard/

### 7.11b. Linux folio + mTHP — OS-Level Memory Management Refactoring (2022–2026)

Every userspace allocator in this chapter sits on top of OS page allocation. Two parallel Linux kernel efforts have reshaped that substrate in 2022–2026 and matter for any language runtime targeting Linux.

The **folio refactoring** (Matthew Wilcox et al., merged starting Linux 5.16, 2022) replaces uses of `struct page` (the kernel's per-page metadata) with `struct folio` — a typed handle representing a contiguous physically-aligned run of pages. Where `struct page` conflated single-page and multi-page (compound) cases ambiguously, requiring runtime checks throughout the kernel, `struct folio` makes the typing explicit. The 2025 milestone is moving `struct folio` to be allocated independently of `struct page`, eliminating a long-standing memory-management ambiguity. The lesson for language runtime designers: **the OS-level page metadata you allocate on top of is moving from "single page or maybe compound" to "explicit-size folio"**, which makes huge-page-aware allocators (TCMalloc + Temeraire §7.3, jemalloc with hugepage hints §7.4) cleaner to implement.

**Multi-size Transparent Huge Pages (mTHP)** (merged Linux 6.6+, 2023+) extends Transparent Huge Pages (THP) — which previously gave only PMD-sized 2 MB pages — to allocate folios of *intermediate* sizes (16 KB, 32 KB, 64 KB, 128 KB, 256 KB, 512 KB, 1 MB) called "anonymous mTHP." This is critical because the binary choice between 4 KB pages (no TLB benefit) and 2 MB pages (memory waste, allocation pressure) was poor for many workloads. mTHP fills the middle. UEK8 documentation reports 5–20% performance improvements on mixed workloads from mTHP enablement; ARM64 work in Linux 6.17 (2025) optimised khugepaged for batched PTE operations on large folios.

The runtime-design implication: **allocator designs that explicitly cooperate with the OS page-size hierarchy (4 KB → multi-size mTHP → 2 MB THP → 1 GB hugepages) outperform allocators that assume one page size everywhere**. TCMalloc's Temeraire backend (§7.3) is the production existence proof. For new language runtimes, exposing explicit large-allocation paths (`std.mem.Allocator` policy hints in Zig, allocator zones in C3) lets runtime code request mTHP-friendly sizes when allocation patterns warrant.

Sources: https://blogs.oracle.com/linux/intro-to-folios and https://lwn.net/Articles/1015320/ and https://blogs.oracle.com/linux/uek8-a-few-notable-changes-in-the-core-kernel and https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html

### 7.12. Language-Level Allocator APIs — Zig, Odin, C3, Jai, Beef, Hare, D

A separate design axis from allocator internals is **how a language routes allocation authority through ordinary code**. Zig, Odin, C3, Jai, Beef, Hare, and D are useful because they make allocation policy visible at the language/library boundary rather than treating `malloc` as ambient global state.

**Zig** is the strictest mainstream example: there is no default global allocator. Data structures accept a `std.mem.Allocator` parameter and allocation failure is an ordinary `error.OutOfMemory` path. The standard palette is deliberately small (`page_allocator`, `FixedBufferAllocator`, `ArenaAllocator`, debug/general-purpose with leak/UAF detection, `SmpAllocator`, `c_allocator`). Zig chooses verbosity over hidden allocation — libraries do not secretly pick a heap policy — at the cost of allocator parameters percolating through call graphs.

**Odin** uses an implicit `context` containing `context.allocator` and `context.temp_allocator`; built-ins (`make`, dynamic arrays, maps) and library routines use that context unless overridden. The default temp allocator is arena-based, expected to be reset with `free_all(context.temp_allocator)` at a frame or request boundary; `TEMP_ALLOCATOR_GUARD` supports nested scoped temp lifetimes. Ergonomics are high without per-call allocator parameters, but lifetime discipline depends on conventions around temp resets.

**C3** is close to Odin but more explicit about the temporary-allocation idiom. Heap allocation goes through `mem`, temp allocation through `tmem`, and an `@pool` macro flushes temp allocations at end of lexical scope; many APIs have `t`/`temp_` variants (`tmalloc`, `tnew`, `string::tformat`) that route into `tmem`. `VMEM_TEMP` uses virtual-memory protection so use-after-pool segfaults deterministically, and `TrackingAllocator` records leaks/backtraces. The lesson: arena-style temp allocation becomes much safer when paired with a debug mode that makes escaped temp pointers crash.

**Jai** (closed beta; public descriptions are community-derived) is included as historical influence: an implicit context carrying allocator + temp allocator, threaded through calls, with `push_allocator` or double-comma shorthand to rebind allocator policy for a subtree of calls without manual parameter threading.

**Beef** preserves `new` syntax but makes allocator selection a first-class part of allocation expressions: `scope` for lexical-lifetime objects, `new` for workspace-selected global allocator, `new:allocator` for a custom allocator object (which implements at least `Alloc`/`Free`). Core types like `String`/`List` expose overridable hooks; the runtime ships a debug allocator with real-time leak checking and hot-compilation support.

**Hare** is C-like: the runtime exposes `malloc`, `realloc`, `free_`, and `setheap` (swaps the internal heap, with caller responsibility for matching `free`/`delete`). Freestanding programs can supply their own `malloc`/`free`/`ensure`/`unensure` so the compiler's dynamic slice operations work without the full runtime. Hare makes the heap replaceable at a small ABI boundary but does not attempt allocator plumbing through library APIs.

**D**'s `std.experimental.allocator` is an allocator-toolkit design: a high-level interface plus composable building blocks (`Region`, `InSituRegion`, `BorrowedRegion`, `SharedRegion`, `free_list`, `fallback_allocator`, `segregator`, `stats_collector`, `bucketizer`, `affix_allocator`). `Region` is the canonical bump allocator (three pointers, no general deallocation, `deallocateAll` to reuse). Provides combinators experts assemble into domain-specific heaps rather than one blessed language policy.

The reusable design space:

- **Zig model** — explicit allocator parameter everywhere. Best transparency and testability; highest API friction.
- **Odin model** — implicit context allocator plus explicit override. Best ergonomics; requires strong conventions for temp lifetimes.
- **C3 model** — heap + temp allocator as first-class named defaults, with scoped `@pool` and virtual-memory debug mode.
- **Jai model** — implicit context allocator and temporary storage; weaker public documentation.
- **Beef model** — allocation expression chooses global, scoped, or custom allocator.
- **Hare model** — runtime heap replacement at a small ABI boundary.
- **D model** — allocator building blocks and wrappers as a library.

Sources: https://zig.guide/standard-library/allocators/ and https://github.com/ziglang/zig/blob/master/lib/std/heap.zig and https://odin-lang.org/docs/overview/ and https://pkg.odin-lang.org/base/runtime/ and https://github.com/odin-lang/Odin/blob/master/core/os/allocators.odin and https://c3-lang.org/language-common/memory/ and https://c3-lang.org/misc-advanced/debugging/ and https://github.com/Ivo-Balbaert/The_Way_to_Jai/blob/main/book/21A_Memory_Allocators_and_Temporary_Storage.md and https://github.com/Jai-Community/Jai-Community-Library/wiki/Advanced and https://www.beeflang.org/docs/language-guide/memory/ and https://docs.harelang.org/rt and https://harelang.org/documentation/usage/freestanding.html and https://dlang.org/phobos/std_experimental_allocator.html and https://dlang.org/phobos-prerelease/std_experimental_allocator_building_blocks_region.html

### 7.13. V (Vlang) — Memory Mode as Compiler Flag

V (Alex Medvednikov, since 2019) takes a position the §7.12 entries don't: it exposes **four orthogonal memory modes** as command-line flags, letting the user pick the discipline at compile time without committing the language source to one model. Where Zig is "always explicit allocator parameter" and Odin is "implicit context allocator," V is "your choice — compile flag picks the model."

The four modes:

- **Default — minimal tracing GC**: a small, well-performing tracing collector. The default ergonomic choice for general-purpose application code.
- **`-autofree`**: the compiler statically inserts `free()` calls during compilation for ~90–100% of objects (Lobster-influenced — see `§3.3`). The remaining small fraction (objects whose lifetime escapes static analysis) is handled by the GC, or by reference counting in some V documentation versions. Programmers can mark functions `[manualfree]` to opt out per function. Status (as of 2026-04): autofree is experimental, with V 1.0 stabilisation as the planned milestone.
- **`-prealloc`**: arena allocation tuned for short-lived single-threaded batch workloads (compilers, build tools, batch data processing). Allocation is bump-pointer; deallocation is end-of-program reset.
- **`-gc none`**: full manual via `C.malloc`/`C.free` exposed as builtins; the developer takes complete responsibility.

Three less-flagship modes round it out: `[heap]` struct attribute forces heap allocation per type, `&MyStruct{...}` per-call-site heap allocation, and `[manualfree]` opts a single function out of autofree. The `-b wasm -autofree -gc none` combination produces WASM output with neither GC nor explicit allocator — useful for embedded WASM targets where GC would cost too much.

The architectural lesson generalises: **a language can expose memory-mode choice as a build flag rather than as a language commitment**. Lobster (`§3.3`) hard-codes "lifetime analysis + bump arena" as its model; Rust hard-codes ownership; Go hard-codes GC. V hard-codes nothing — the same source compiles into a GC binary, an autofree binary, an arena binary, or a manual-malloc binary. The cost is that the source code style must remain conservative (no relying on a specific lifetime model), and autofree as the most ambitious mode is still experimental. The benefit is unusual deployment flexibility: the same V codebase serves a server (default GC), a batch tool (prealloc), an embedded WASM module (manual), and a long-lived service (autofree once stable) without source-level rewrites.

V's multiple backends (C as default, Go, JS in browser/Node/freestanding variants, native x64/arm64, WebAssembly) compose with the memory-mode choice — the same source can target a native binary with GC and a WASM module without GC from one codebase. Status (as of 2026-04): V is pre-1.0 (~v0.4.x at the time of writing), with autofree stabilisation gating the 1.0 milestone. The mode-as-flag design is established and the language has built itself with this discipline since inception.

Sources: https://docs.vlang.io/memory-management.html and https://vlang.io/ and https://github.com/vlang/v/discussions/18374

---

## 8. Verified Memory Safety

Formally verified memory safety treats safety as a theorem to prove rather than a property to argue. Entries differ on *what is verified* (type/memory safety only, full functional correctness, UB-free execution), *how much proof engineering is required* (3–5× for HACL\*, 10–30× for foundational Coq proofs), and *what production code has shipped*. HACL\*/EverCrypt is the deepest production deployment; CompCert is the compiler equivalent; Verus, Prusti, Creusot, Aeneas, RefinedRust are the modern Rust verification toolbox. Rust's operational aliasing model (Stacked/Tree Borrows) sits at the boundary between formal model and runtime enforcement; see `DEBUGGERS.md §8.8` for the Miri side and `MEMORY.md §1.3` for the language-level perspective. The shared **verification-IL family** that Prusti, Creusot, Dafny, and many other verifiers compile to (Boogie, Viper, WhyML, F\*-Low\*) is treated as a representation question in `REPRESENTATIONS.md §11.8`; this chapter focuses on the verifiers themselves rather than their target ILs.

### 8.1. RustBelt — Mechanized Soundness with Lifetime Logic

Jung, Jourdan, Krebbers, Dreyer (POPL 2018) deliver the first mechanized soundness proof for a realistic subset of Rust (lambdaRust) including unsafe code, built on Iris in Coq. **Lifetime logic**: a novel Iris-derived logic with "borrow propositions" mirroring Rust's borrow checker; semantic typing via logical relations. Extensible methodology: each unsafe library (Arc, Rc, Cell, RefCell, Mutex, RwLock, mem::swap, thread::spawn, rayon::join) gets a verification condition rather than syntactic typing. Fundamental theorem + adequacy proven once-and-for-all in Coq.

Research artifact; influences official Rust language decisions but not a developer-facing tool. Found unsoundness bugs in Rust's standard library. The reference work for "Rust unsafe is sound when used correctly," and the foundation every later Rust verifier builds on or compares to.

Sources: https://plv.mpi-sws.org/rustbelt/popl18/paper.pdf and https://people.mpi-sws.org/~jung/thesis.html

### 8.2. Iris — Higher-Order Concurrent Separation Logic

Jung, Krebbers et al.'s **Iris** is a language-generic higher-order concurrent separation logic framework in Coq/Rocq, providing a single foundation for many program logics. Won the 2023 Alonzo Church Award. Higher-order ghost state with user-definable resource algebras unifies invariants, atomicity, and partial-commutative-monoid reasoning. **Iris Proof Mode (IPM/MoSeL)** Coq tactics make embedded separation-logic proofs as ergonomic as native Coq proofs. "Iris-in-Iris" self-hosting: Iris's own model is built within itself.

Foundation for RustBelt, RefinedRust, RefinedC, many other verifications; used in 50+ research projects. The closest thing the field has to a universal substrate for separation-logic verification.

Sources: https://iris-project.org/ and https://www.cambridge.org/core/journals/journal-of-functional-programming/article/iris-from-the-ground-up-a-modular-foundation-for-higherorder-concurrent-separation-logic/26301B518CE2C52796BFA12B8BAB5B5F

### 8.3. Verus — SMT-Backed Linear-Permission Verifier

Lattuada, Hance, Cho, Brun, Subasinghe, Zhou, Howell, Parno, Hawblitzel deliver SMT-backed verification of full functional correctness for Rust, leveraging Rust's linear types as ghost permissions to verify both safe and unsafe code with low annotation overhead. **Linear ghost permissions** let ghost code carry capability tokens (e.g. raw-pointer permissions) borrow-checked exactly like real Rust. **Tri-modal language** separates `spec` (uncomputable, unrestricted), `proof` (linear, ghost), and `exec` (compiled) modes. SMT-tuning — per-function `rlimit`, isolated bit-vector reasoning, encoder optimizations — yields 3–61× speedups vs prior tools.

Used at Google for kernel verification (Android pKVM/NRKernel), at Amazon, and inside Linux kernel verification work. Verified case studies include OS page tables, NUMA-aware data-structure replication, crash-safe storage, and a concurrent memory allocator (~6.1K LoC impl + 31K LoC proof). Status (as of 2026-04): among the most production-relevant Rust verifiers in this survey.

Sources: https://www.microsoft.com/en-us/research/publication/verus-a-practical-foundation-for-systems-verification/ and https://github.com/verus-lang/verus and https://verus-lang.github.io/verus/guide/

### 8.4. Prusti — Auto-Active via Viper

ETH Zurich's **Prusti** is an auto-active deductive verifier for Rust that translates programs to Viper (intermediate verification language; see `REPRESENTATIONS.md §11.8` for the broader verification-IL family Viper belongs to) and uses Viper's permission-based reasoning + Z3. **Ownership-to-separation lift**: derives the separation-logic permission framing automatically from Rust's borrow-checker output, so users write only functional pre/postconditions. **Pledges**: specification mechanism for reasoning about borrow-expirations (final values after the lifetime ends). **Default panic-freedom**: verifies absence of overflows / array OOB / unwrap panics with no annotations. Open-source, available as VSCode extension (Prusti Assistant); restricted to safe Rust subset; used in industrial pilots and academic teaching but no major production code base verified.

Sources: https://www.pm.inf.ethz.ch/research/prusti.html and https://github.com/viperproject/prusti-dev

### 8.5. Creusot — Prophetic Borrows in WhyML

Inria's **Creusot** is an auto-active verifier that translates Rust MIR to WhyML (Why3's IR; covered in the verification-IL family at `REPRESENTATIONS.md §11.8`), using a "prophetic" encoding to handle mutable borrows in a purely functional setting. **Prophetic borrows**: the `^x` operator denotes the future final value of a borrow, allowing Rust mutable references to be encoded as (current, prophecy) pairs in a functional logic (RustHorn / RustHornBelt heritage). **Pearlite** specification language: ML-style logical syntax with ghost code, snapshots, and trait-aware predicates. **Why3 multi-prover backend** discharges VCs via Z3, CVC4/CVC5, Alt-Ergo simultaneously. Open-source v0.11 (April 2026); growing test suite with verified Vec/sort/binary-search/iterators; not yet shipping inside production-critical software.

Sources: https://hal.inria.fr/hal-03737878/document and https://github.com/creusot-rs/creusot

### 8.6. Aeneas — LLBC to Pure Functional Programs

Son Ho & Protzenko's **Aeneas** translates a borrow-checked Rust subset (LLBC) into a pure lambda-calculus, eliminating heap reasoning so users prove properties in F\* / Coq / Lean / HOL4 over functional programs. **LLBC + symbolic borrow semantics** gives a pure functional semantics to safe Rust, including mutable borrows. **Backward functions**: a novel encoding that turns a mutable borrow's "give back the updated value" into a pure function call, sidestepping prophecies. Borrow-checker proven sound via symbolic execution (ICFP 2024 follow-up). Active research toolchain; used by Microsoft (Protzenko) for crypto-adjacent verification; safe-Rust only today, with separation-logic extensions for unsafe in progress.

Sources: https://arxiv.org/pdf/2206.07185 and https://github.com/AeneasVerif/aeneas

### 8.7. RefinedRust — Foundational Refinement Types

Gaeher, Sammler, Jung, Krebbers, Dreyer (PLDI 2024) deliver a refinement-type system for Rust producing foundational Coq proofs (machine-checked, no trusted automation), sound w.r.t. an Iris/RustBelt model and supporting both safe and unsafe code. **Radium**: realistic operational semantics for real Rust (vs. RustBelt's idealized lambdaRust), including place semantics. **Refined ownership types** combine ownership with refinement predicates; semantic model in Iris extends RustBelt's lifetime logic with new borrow flavors for unsafe code. **Foundational guarantee**: tool emits Coq scripts; the type checker is not in TCB. Research prototype; case study verifies a variant of `std::Vec` including unsafe pointer manipulation.

Sources: https://iris-project.org/pdfs/2024-pldi-refinedrust.pdf and https://dl.acm.org/doi/10.1145/3656422

### 8.8. VeriFast — Symbolic Execution for C, Java, Rust

Bart Jacobs's **VeriFast** is a modular symbolic-execution-based separation-logic verifier for sequential and multithreaded C, Java, and (recently) Rust. **Predicate-based heap layouts** with explicit fold/unfold ghost commands; users write predicates, lemmas, and contracts inline. **Higher-order ghost code** including lemma function pointers for fine-grained concurrency. **Featherweight VeriFast**: Coq-mechanized soundness of the symbolic-execution core. Mature open-source tool used in industrial-scale case studies (JavaCard applets, OS components); user-facing trust includes the symbolic executor.

Sources: http://people.cs.kuleuven.be/~bart.jacobs/verifast/ and https://verifast.github.io/verifast-docs/

### 8.9. F\* / Low\* / KaRaMeL — Project Everest's HACL\*, EverCrypt

Dependently typed ML with effects (F\*) plus a verified C-extractable subset (Low\*); Low\* programs verify against a stack/heap memory model and compile to readable C via KaRaMeL (formerly KreMLin). The F\* / Low\* / KaRaMeL pipeline is also catalogued in `REPRESENTATIONS.md §11.8` as part of the verification-IL family alongside Boogie, Viper, and WhyML. **Low\* memory model** (ICFP 2017) — region-based stack/heap with abstract pointers, integrated with F\*'s effect system. **EverCrypt agile multiplexer**: single verified API selects HACL\* (C) or ValeCrypt (asm) at runtime, sealing the abstraction. **Vale/F\* integration** connects C-level and assembly-level proofs against a shared spec.

HACL\* / EverCrypt code ships in **Mozilla Firefox NSS** (Curve25519, ChaCha20, Poly1305 since NSS 3.33+), the **Linux kernel** (WireGuard VPN), **mbedTLS**, **Microsoft WinQuic**, the **Tezos blockchain**, and the **ElectionGuard SDK**. Status (as of 2026-04): consumer/integration list reflects publicly documented deployments; exact module coverage and version pin per downstream are time-sensitive. The deepest real-world deployment of formal verification for memory-safe code. The lesson: cryptographic primitives are the killer app for formal verification — small, performance-critical, well-specified, and security-load-bearing.

Sources: https://hacl-star.github.io/Overview.html and https://www.microsoft.com/en-us/research/project/project-everest-verified-secure-implementations-https-ecosystem/ and https://fstar-lang.org/oplss2019/EverCrypt-06282019.pdf

### 8.10. CompCert Memory Model

Leroy, Appel, Blazy, Stewart's CompCert provides a block-based memory model shared across all CompCert IRs; not a separation logic itself but engineered to be separation-logic-friendly and used by the Verified Software Toolchain (VST). **Abstract blocks + concrete byte representation** (v2): exposes integer/float byte layout while keeping pointers abstract for opaqueness. **Fine-grained permissions**: per-byte access rights (Freeable / Writable / Readable / Nonempty / None) enabling read-only-data optimizations and DRF concurrency. **Massert / Separation library** in Coq: footprint-equipped assertions with separating conjunction used in CompCert's Stacking pass and in VST.

CompCert C is a commercial verified compiler (AbsInt) used in DO-178C avionics certification; the memory model is the de facto standard reused by VST, Iris-CompCert linkages, and many follow-on works. The "memory model that supports verified compilation *and* verified user code" is the load-bearing engineering choice.

Sources: https://compcert.org/doc/html/compcert.common.Separation.html and https://www.cambridge.org/core/books/abs/program-logics-for-certified-compilers/compcert-memory-model/BC069D42EA52CDBE871A22C118A2C74B

### 8.11. Stacked Borrows / Tree Borrows — Formal Model Side

Language-level model and empirical acceptance results are in §1.3; runtime/Miri side is in `DEBUGGERS.md §8.8`. The distinct contribution here is *optimization soundness*: Stacked Borrows' Coq mechanization justifies the compiler's `noalias`-style reorderings past unknown calls, and Tree Borrows' Rocq mechanization (Villani et al., PLDI 2025) preserves those optimizations while additionally licensing read-read reorderings. An aliasing model must agree across three views — language-level discipline, runtime checker, and compiler theorem.

Source: https://iris-project.org/pdfs/2025-pldi-treeborrows.pdf

### 8.12. SPARK / Ada — Industrial Auto-Active Verification

AdaCore's **SPARK** (subset of Ada with formal-verification annotations, descended from work at Praxis/Altran in the 1980s) is the longest-running production formal-verification toolchain — used in DO-178C avionics, EAL-rated security products, railway signalling, and increasingly Linux-kernel and CHERI-related verification. Where Verus (§8.3), Prusti (§8.4), and Creusot (§8.5) target Rust, SPARK targets Ada with the same auto-active discipline: pre/postconditions on subprograms, loop invariants, type predicates, and dependency contracts (`Depends`, `Global`) discharged by an SMT solver via Why3 (`REPRESENTATIONS.md §11.8` covers Why3 as a verification IL).

The SPARK design is unusually mature in production:

- **Five proof levels** (`Stone`, `Bronze`, `Silver`, `Gold`, `Platinum`) corresponding to absence-of-runtime-errors, initialization correctness, key-property partial proof, full functional correctness, and worst-case-execution-time bounds. Each level extends the previous; teams adopt incrementally without requiring full Platinum across an entire codebase.
- **Ghost code** — `Ghost` aspect on declarations marks them as proof-only, automatically erased before code generation. Lets specifications express invariants over data structures without runtime cost.
- **Proof contexts** declared explicitly with `pragma SPARK_Mode` per package — pragma can be `On`, `Off`, or `Auto` per declaration, allowing incremental migration of an Ada codebase to SPARK section by section.
- **Multi-prover backend via Why3** — same Z3 / CVC4 / CVC5 / Alt-Ergo dispatch the rest of the Why3 ecosystem uses (`REPRESENTATIONS.md §11.8`). This is where SPARK shares infrastructure with Frama-C, Creusot, and other Why3-based verifiers.
- **Liquid-types-style refinement** — type predicates (`Subtype X is Integer with Predicate => X mod 2 = 0`) provide a refinement-typing surface integrated with the rest of Ada's type system, comparable to LiquidHaskell (`TYPES.md §7.5`) but with a longer production history.

Status (as of 2026-04): production deployment includes Ariane-class space launchers, Boeing avionics, Eurofighter Typhoon flight control, NVIDIA security firmware, thousands of certified-system codebases. AdaCore's 2025 retrospective covers Wind River's CHERI Alliance partnership (relevant to `MEMORY.md §5.6` CHERI), expanded LLM-generated-code verification studies (SCITEPRESS 2025), and increasing FAA/EASA acceptance of SPARK as a DO-178C verification path.

Distinct from CompCert (§8.10): CompCert verifies a *compiler*; SPARK verifies *application code*. Distinct from Verus (§8.3): Verus targets Rust with Rust's ownership for soundness; SPARK targets Ada with Ada's strong-typing-plus-contracts for soundness — both are auto-active, both use SMT, but the source language constraints differ. Distinct from F\*/Low\* (§8.9): F\* is dependently-typed with effects; SPARK is first-order Ada plus refinement.

The lesson generalises: **a production-mature formal-verification toolchain takes decades to mature**. SPARK's lineage is over 35 years old; Ada's was already 15 years old when SPARK began. For new languages contemplating formal verification as a feature, the cost is not just the verification IL (Why3, Boogie, Viper — all covered in `REPRESENTATIONS.md §11.8`) but also the multi-decade community investment in proof patterns, certifying-authority acceptance, and educational material. Easier to *target* an existing verifier than to ship a new one.

Sources: https://www.adacore.com/blog/year-in-review-2025-a-transformative-year-for-high-integrity-software-at-adacore and https://archive.fosdem.org/2025/schedule/event/fosdem-2025-4879-understanding-liquid-types-contracts-and-formal-verification-with-ada-spark/ and https://www.scitepress.org/Papers/2025/134619/134619.pdf and https://hackernoon.com/the-language-that-refuses-to-crash-why-ada-still-matters-in-2025

---

## 9. Concurrent Memory Reclamation

Mechanisms for safely reclaiming memory in lock-free data structures, where readers cannot easily be told "stop touching that pointer." The axis across entries is *who pays what cost*: hazard pointers add a per-protected-pointer fence to every read; RCU/QSBR have zero-cost readers but require cooperative quiescence; EBR has ~1 fence per pin but unbounded retention under stalls; HE/IBR/Hyaline/Stamp-It/NBR/VBR offer various combinations of bounded retention and EBR-grade throughput. C++26 standardizes hazard pointers and RCU as language-level primitives; see `MEMORY.md §4.7`.

### 9.1. Hazard Pointers

Maged Michael's **hazard pointers** (2002 / 2004): each thread publishes single-writer/multi-reader pointers naming the objects it is currently dereferencing; retirers scan all hazard pointers before freeing. Wait-free read protection using only single-word atomic stores plus a release/acquire fence (or seq_cst) per acquire. Bounded retired-list size O(N · H · R) (threads × HPs × retire batch), giving worst-case bounded retention. Integrated ABA fix without DCAS.

Cost: ~1 store + 1 fence (often a full `mfence` on x86) per protected read; retire is amortized O(H · N) scan. Production: Folly `hazptr`, OpenBSD/Concurrency Kit, McKenney's RCU "hazard variant," **C++26 `std::hazard_pointer`** (P2530R3).

Sources: https://www.cs.otago.ac.nz/cosc440/readings/hazard-pointers.pdf and https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2023/p2530r3.pdf

### 9.2. RCU — Read-Copy-Update

Paul McKenney's **RCU** (Linux 2002): readers execute lightweight critical sections; writers publish then wait a "grace period" — interval after which every CPU has passed a quiescent state — before reclaiming. Zero-overhead readers in non-preemptible kernels (compiler barrier only, no atomics). Hierarchical Tree RCU for scalable grace-period detection across thousands of CPUs. `rcu_assign_pointer` / `rcu_dereference` publish-subscribe pattern that doubles as a memory-ordering API.

Cost: reader 0–2 instructions (preempt-disable); writer `synchronize_rcu()` blocks ms-scale; `call_rcu()` async. Worst-case retention: unbounded under stalled readers (a CPU never quiescing blocks a grace period). Production: Linux kernel (everywhere — VFS dcache, networking, modules), liburcu (userspace), QEMU.

Sources: https://www.kernel.org/doc/html/latest/RCU/Design/Requirements/Requirements.html and https://liburcu.org/

### 9.3. QSBR — Quiescent-State-Based Reclamation

Variant of EBR/RCU where threads explicitly announce quiescent points (no live references held) instead of bracketing critical sections. Among the lowest-overhead read-side schemes when the program already has natural quiescent points: ordinary reads need no per-access synchronization, while one quiescent announcement per outer loop iteration amortizes barrier cost. Per-data-structure QS variables in DPDK let writers wait only on relevant readers.

Cost: reader zero per access; one relaxed store per quiescent point. Trade-off: requires cooperative threads that periodically reach a "no references held" state — incompatible with arbitrary library code. Production: liburcu-qsbr, DPDK `rte_rcu_qsbr` (packet-loop quiescence model), Linux user-mode QSBR.

Sources: https://liburcu.org/ and https://doc.dpdk.org/guides-20.11/prog_guide/rcu_lib.html

### 9.4. Epoch-Based Reclamation — Crossbeam in Rust

Keir Fraser's EBR (2003): a global epoch counter advances when all threads in critical sections have observed the current epoch; objects retired in epoch *e* freed once all threads reach *e+2*. Library-encapsulated, transparent to data-structure code. Only three epoch values needed (mod-3 invariant). Batched deferred destruction amortizes the scan. Cost: reader one acquire load + relaxed store per pin; SeqCst fence on first pin to publish.

Worst-case retention: unbounded — a single stalled/preempted thread holding a pin freezes reclamation globally (the canonical EBR weakness). **Crossbeam (Rust)** adapts EBR to Rust's affine type system: `Guard` RAII pin + `Atomic<T>` / `Shared<'g, T>` whose lifetime is bounded by the guard, statically preventing use-after-pin. Lifetime-parameterised shared pointers convert reclamation safety into a borrow-check obligation. GhostCell composes with crossbeam to give zero-cost branded interior mutability for graph-shaped lock-free structures. Foundation of most Rust lock-free libraries.

Sources: http://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-579.html and https://docs.rs/crossbeam-epoch/

### 9.5. Hazard Eras

Ramalhete & Correia (SPAA 2017) combine hazard-pointer-style explicit reservations with EBR-style epoch ranges — each protected pointer carries a "birth/retire era" interval matched against per-thread reserved era. Reserves an *interval*, not an individual pointer, so one slot covers many sequential dereferences. Bounded memory like HPs but ~6× faster. Lock-free.

Source: https://github.com/pramalhe/ConcurrencyFreaks/blob/master/papers/hazarderas-2017.pdf

### 9.6. Interval-Based Reclamation (IBR)

Wen et al. (PPoPP 2018): threads reserve a finite epoch interval; blocks track birth/retire epoch; freeable when no reservation interval intersects the block's lifetime. TagIBR, 2GEIBR, POIBR variants trading throughput for space; avoids per-dereference fence; bounded space like HP. University of Rochester library; basis for many subsequent comparisons.

Sources: https://www.cs.rochester.edu/u/scott/papers/2018_PPoPP_IBR.pdf and https://github.com/urcs-sync/Interval-Based-Reclamation

### 9.7. Wait-Free Eras

Nikolaev & Ravindran (PPoPP 2020) extend Hazard Eras to fully wait-free progress for arbitrary wait-free data structures by guaranteeing bounded reclamation work per operation. First universal wait-free SMR; helping mechanism on era publication; near-EBR throughput with strict bounds.

Source: https://www.ssrg.ece.vt.edu/papers/ppopp20.pdf

### 9.8. Hyaline / Hyaline-1

Nikolaev & Ravindran (PODC 2019 / PLDI 2021) apply distributed reference counting only at reclamation time (not on access), with retired objects threaded into a shared list whose handle pointers carry the per-thread reference counts. Reclamation workload self-balances across threads (any thread may free). Snapshot-free and transparent — no thread (un)registration. Hyaline-S delivers HP-grade memory bounds with EBR-grade throughput. Works on x86, ARM, PPC, MIPS with LL/SC or DWCAS. Reference C/C++ implementation in `rusnikola/lfsmr`.

Sources: https://arxiv.org/pdf/1905.07903 and https://github.com/rusnikola/lfsmr

### 9.9. Stamp-It

Pöter & Träff (PPoPP 2018) deliver a lock-free doubly linked "stamp pool" of thread reservations giving amortized O(1) reclamation overhead independent of thread count. Thread-count-independent reclamation cost. Proof of correctness in the C++11/17 memory model with weakest-possible orderings. Earlier reclamation than EBR/HP in many workloads.

Source: https://arxiv.org/abs/1805.08639

### 9.10. VBR — Version-Based Reclamation

Sheffi, Herlihy, Petrank (DISC 2021) use fully optimistic reclamation — both reads *and* writes are speculative. Each object carries a version stamp; operations validate version on read and CAS-with-version on write, abort/retry on mismatch. Eliminates hazard-pointer protection on writes (prior optimistic schemes only optimised reads). Reuses freed memory immediately into a typed allocator. Outperforms EBR/HP/HE/IBR on linked-list, hash-table, skip-list benchmarks while remaining lock-free.

Source: https://arxiv.org/abs/2107.13843

### 9.11. NBR — Neutralization-Based Reclamation

Singh, Brown, Mashtizadeh (PPoPP 2021) use an EBR-like fast path; when the thread-local retire buffer overflows, the reclaimer sends a POSIX signal to all threads, which respond by re-validating their position (handshake) — "neutralizing" any thread holding stale references. Bounds memory like HP but reclamation speed like EBR (38% faster than DEBRA on BST, 243% faster than HP on lazy linked-list). No record-layout changes, no recovery code. Works for many lock-based as well as lock-free structures using only atomic R/W/CAS.

Source: https://rcs.uwaterloo.ca/~ali/papers/ppopp21-nbr.pdf

### 9.12. Folly hazptr

Facebook's production C++ hazard pointers — thread-cached `hazptr_rec`s, RAII `hazptr_holder`, `hazptr_obj_base<T>::retire()`, multi-domain support. Thread-local hprec cache with dynamic sizing & decay (recent commits). Link-counting API for graph reclamation with no reader overhead. Cohorts and synchronous reclamation extensions queued for C++29 (P3135R0). In production at Meta since 2017; the reference implementation behind C++26 `std::hazard_pointer`.

Source: https://github.com/facebook/folly/blob/main/folly/synchronization/Hazptr.h

### 9.13. RRR-SMR — Reduce, Reuse, Recycle for Lock-Free Data Structures (PLDI 2025)

Nikolaev, Boyle, et al.'s **RRR-SMR** ("Reduce, Reuse, Recycle: Better Methods for Practical Lock-Free Data Structures", PLDI 2025) addresses a fundamental limitation of every SMR scheme in §§9.1–9.12: existing safe-memory-reclamation methods only allow *reclamation* of retired memory (return to the allocator), not *reuse* (in-place rebirth as a different node of the same type within the data structure). Reuse is dramatically more efficient than reclaim-and-reallocate because it avoids allocator round-trips, but unsafe under naive SMR — a stale reader holding a pointer to the old value would see the new value and break invariants.

The RRR contribution is a general method of **constructing data structures whose nodes can be safely recycled** under SMR by reasoning about which fields must be left untouched while a stale reader could observe them. The mechanism uses *generation tags* in node headers that retired nodes carry into reuse, plus a discipline ensuring reuses are visible to stale readers as inert "tombstone" states rather than as inconsistent live nodes. Combined with HE/IBR/Hyaline-class SMR schemes (§§9.5, 9.6, 9.8), RRR-recycled data structures outperform classical SMR-based ones on contention-heavy workloads where allocation pressure dominates.

The lesson generalises: **SMR research has converged on bounded retention; the next frontier is bounded reuse-vs-reclaim cycles**. For language designers building lock-free data structures into a language runtime (channels, lock-free queues, work-stealing deques), RRR-SMR is the current best technique for combining safe reader-side discipline with allocation-pressure-friendly reuse.

Sources: https://dl.acm.org/doi/10.1145/3729337 and https://pldi25.sigplan.org/details/pldi-2025-papers/88/RRR-SMR-Reduce-Reuse-Recycle-Better-Methods-for-Practical-Lock-Free-Data-Structur and https://zenodo.org/records/15110373

---

## 10. Capability-Based Memory and Authority

Capabilities are unforgeable tokens binding *designation* and *authority*: holding the reference *is* the permission. This differs fundamentally from ownership/borrow checking, which tracks aliasing discipline over already-accessible memory. Caps instead control *which memory exists at all* in a component's reachable graph, eliminating ambient authority. Entries below cover the language/programming-model angle; the hardware-ISA side of CHERI is in §5.6–5.7.

### 10.1. Pony Reference Capabilities — The Authority Angle

From the authority angle, Pony's six rcaps double as object capabilities; the ownership/aliasing matrix is in §1.10. From the *authority* angle proper: `tag` (opaque, identity-only) is exactly an actor reference under ocap discipline, and the sendable subset `{iso, val, tag}` is the static foundation for object-capability message passing — only sendable references cross actor boundaries, so data-race freedom and capability transfer fall out of the same type-system rule. Pony is the cleanest example of one mechanism doing both ownership and ocap work; see §1.10 for the rcap matrix and recovery rules.

Source: https://tutorial.ponylang.io/reference-capabilities/recovering-capabilities.html

### 10.2. CHERI C/C++ — Programming Model and Compartments

Hardware ISA, capability layout, and overhead numbers are in §5.6. From the *programming model* angle: source C/C++ is mostly unchanged but pointer provenance is enforced — integer-pointer casts narrow but never forge authority, and `intptr_t`-style idioms surface compiler diagnostics under the pure-capability ABI. **Sealed capabilities** provide opaque, unforgeable handles for entry points and authority-bearing objects, but they do not by themselves solve temporal safety; see §5.6 for the temporal-safety caveat. The CHERI C/C++ toolchain is mature in CheriBSD.

Sources: https://github.com/CTSRD-CHERI/cheri-c-programming and https://www.cl.cam.ac.uk/research/security/ctsrd/

### 10.3. CHERIoT Compartments — Embedded Ocap

CHERIoT extends the CHERI programming model with first-class **compartment annotations**: `__cheri_compartment`, `__cheri_libcall`, `__cheri_callback`. The compiler distinguishes intra-compartment direct calls, library calls (no security boundary, no mutable globals), and cross-compartment calls (sealed entry capabilities through a switcher). `CHERIOT_NO_AMBIENT_MALLOC` is a compile-time switch removing implicit allocator authority — pure ocap discipline at the C level. Sealing is used for unforgeable entry capabilities and authority-bearing handles, while allocator and revocation policy remain explicit runtime-design questions rather than automatic consequences of capability hardware alone.

This is one of the cleanest existing C-language ocap designs, possible because CHERIoT made compartments a first-class hardware-checked boundary. Treat availability and deployment status as hardware- and vendor-specific; see `MEMORY.md §5.7`.

Sources: https://cheriot.org/book/language_extensions.html and https://cheriot.org/rtos/sealing/2025/11/06/sealing.html

### 10.4. Newspeak / E — Object Capabilities

Mark Miller's "All Authority Accessed Only by References" thesis: authority is conveyed *only* by holding object references; no global namespace, no static state, no ambient ability to do I/O — every effect requires receiving a reference from a creator. **Newspeak** (Bracha): top-level classes are stateless module *definitions*; instantiation accepts a `platform` parameter that is the sole source of external authority — module composition becomes capability passing. **Sealer/unsealer pairs (E)**: rights amplification primitive that lets two parties hold capabilities whose joint use exceeds either alone (basis for E's mint/purse currency pattern). **Granovetter operator**: only "introduction" via existing references can grow the reference graph — formalized as the lambda calculus security kernel.

Newspeak is active as a Smalltalk-family OSS language; E's ideas live on in Agoric, Spritely, Cap'n Proto, and SES (now in TC39 process as "Hardened JS"). The reference works for ocap design.

Sources: https://erights.org/elib/capability/ode/ode-capabilities.html and https://bracha.org/newspeak.pdf

### 10.5. WASI / Wasm Component Model — Resource Handles

WASIp2 (launched January 2024) is built on the Component Model and Wit IDL; modules have *zero ambient authority* and receive every system resource (filesystem dirs, sockets, clocks) as explicit capability handles passed through typed component-model "worlds." **Resource handles** in Wit are first-class typed references that owning components can transfer; the canonical ABI prohibits raw memory sharing across components. Host grants like `--dir /data::readonly` are positive enumerations at instantiation, not ACL lookups at use. **Virtualization/polyfill**: a component implementing `wasi:filesystem` can intercept and constrain another component's file access — capabilities compose like reference attenuation in E.

> The *module-system* angle — components as a typed binary-level module substrate, WIT as the equivalent of ML signatures at the artifact boundary, and the Component Model's role as the most modern realization of capability-scoped modularity in mainstream tooling — is covered in `MODULES.md §11`.

Production for serverless/edge (Cloudflare, Fastly, Fermyon); Preview 3 (`future`/`stream`) in progress. The most consequential modern deployment of ocap principles in industry tooling.

Source: https://github.com/WebAssembly/WASI/blob/main/docs/Preview2.md

### 10.6. Singularity / Midori — Software-Isolated Processes

Microsoft Research's **Singularity** introduced Software-Isolated Processes (SIPs) — type-safe-language isolation replaces hardware MMU. **Midori** extended this with *objects-as-capabilities* (Joe Duffy): no `DateTime.Now`, no `File.Open` — to read time you must hold a `Clock`. **Sing# channel contracts** statically verify message-passing protocols between SIPs; ownership transfer of exchange-heap objects. Eliminated ambient authority at the language level — a static no-IO function is automatically pure and memoizable, aligning security with effect tracking. KeyKOS / EROS lineage acknowledged.

Research; Midori discontinued 2015 but ideas seeded C# nullable refs, async, and Project Verona. The cleanest "ocap as language design choice" reference for type-safe language families.

Sources: https://joeduffyblog.com/2015/11/10/objects-as-secure-capabilities/ and https://www.microsoft.com/en-us/research/project/singularity/

### 10.7. seL4 / EROS — Verified Capability Kernels

Capability kernels where every kernel object (TCB, CNode, frame, endpoint) is named only by a capability stored in a CSpace; user-level *retypes* untyped memory into kernel objects, so memory allocation policy lives outside the verified kernel. **Untyped capabilities** + **retype**: kernel never allocates implicitly; all in-kernel memory consumption is authorized. **Formal proof of authority confinement** (Isabelle/HOL refinement down to C): take-grant-style bound proven on the actual implementation. **Reply capabilities**: single-use return tokens making RPC exactly-once and revocation-safe. seL4 deployed in safety-critical/defense; Coyotos archived; EROS academic.

Sources: https://docs.sel4.systems/Tutorials/capabilities.html and https://cacm.acm.org/research/sel4-formal-verification-of-an-operating-system-kernel/

### 10.8. Cap'n Proto / CapTP

Distributed object capabilities with the network protocol descended from E's CapTP — interface refs are first-class wire types, and *promise pipelining* lets dependent calls travel in one round trip. **Promise pipelining**: pre-send calls against the *result* of an in-flight call, eliminating chatty RPC patterns; equivalent to E's eventual-send composition. **Three-vat introduction**: secure handoff of a capability from vat A to C via B without B gaining authority. **Distributed acyclic GC** (Spritely Goblins, Agoric): cross-vat ref counting with the ocap invariant preserved. Cap'n Proto in production at Cloudflare Workers; OCapN (Spritely + Agoric) in active standardization. **Cap'n Web** (Cloudflare 2025) is the JavaScript-native sibling of the same protocol family, ported to TypeScript with the same promise-pipelining and capability semantics; runtime/coordination angle is canonical at `CONCURRENCY.md §7.8`.

Sources: https://capnproto.org/rpc.html and https://files.spritely.institute/docs/guile-goblins/0.15.1/CapTP-The-Capability-Transport-Protocol.html

### 10.9. Joe-E / Caja / SES — Hardened JS

Define a *taming subset* of an existing language (Java, JavaScript) that statically bans ambient-authority constructs (mutable statics, reflection, file APIs) so the remainder is provably ocap-safe. **Maximal subset principle** (Joe-E): forbid only what breaks ocap reasoning; preserve existing tooling. **Verifiable functional purity** as a special case of capability emptiness. **SES → Hardened JS** is now a TC39 proposal; `Compartment` + `lockdown()` ship in Node, Endo, Agoric, MetaMask LavaMoat. Joe-E and Caja archived; SES production via Endo/Agoric. The "language subset by deletion" technique generalizes — any memory-unsafe-by-default language can be retrofitted with ocap by removing ambient-authority constructs.

Source: https://people.eecs.berkeley.edu/~daw/papers/joe-e-ndss10.pdf

### 10.10. Monte / Spritely Goblins

Modern ocap languages directly descended from E. **Monte** is a Python-flavored standalone runtime; **Spritely Goblins** is a Racket/Guile library implementing CapTP and "time-traveling" transactional ocap actors. Quasi-functional actor turns enabling local rollback ("time travel"); netlayer abstraction over Tor / I2P / libp2p; Hyptis / Brassica demonstrate composing ocap with CRDTs. Spritely Institute funded non-profit; Goblins beta; Monte dormant.

Source: https://spritely.institute/goblins/

### 10.11. F\* / Steel — Capabilities as Separation-Logic Resources

Steel is a concurrent separation logic embedded in F\*; capabilities are *separation-logic resources* (`slprop`) representing exclusive ownership of memory regions, threaded through Hoare quintuples. AC-matching tactics + SMT for frame inference; selectors abstracting resources for SMT-friendly specs; SteelCore soundness fully mechanized in F\*. Production verification work appears in Project Everest (HACL\*, EverParse, EverCrypt; see `MEMORY.md §8.9`). The cleanest example of "capabilities as separation-logic resources" in a verified-systems language.

Sources: https://project-everest.github.io/assets/steel.pdf and https://github.com/FStarLang/steel

---

## 11. Summary Tables

Rows grouped by chapter; within a group, order roughly follows the body text.

### 11.1. Ownership and borrowing

| Technique | Annotation Cost | Inference Power | Key Trade-off | Examples |
|---|---|---|---|---|
| MIR-CFG NLL | Lifetime params on signatures | Liveness over CFG | Most production-mature; well-understood | Rust 1.31+ (§1.1) |
| Polonius / Datalog reformulation | Same as NLL | Per-CFG-point loan liveness | Accepts more programs; alpha-status as of 2026-04 | rustc -Zpolonius (§1.2) |
| Stacked / Tree Borrows | None (operational model) | Defines UB for unsafe | Tree Borrows rejects 54% fewer programs | Miri (§1.3, §8.11) |
| Pin/Unpin | Library-only | Address stability | Self-referential async state machines | Rust async (§1.4) |
| View types (proposed) | Field lists in signature | Disjoint partial borrows | Pre-RFC | Rust (§1.5) |
| Mutable value semantics | No lifetime annotations; parameter conventions only | Inferred from projection nesting | No first-class refs at all | Hylo (§1.6) |
| `owned`/`borrowed`/`inout` + ASAP destruction | Argument modifiers | Rust-style with sub-expression drop | Smaller live ranges than Rust | Mojo (§1.7) |
| Law of exclusivity + noncopyable | Static + dynamic exclusivity | Opt-in linear types on ARC base | Layered linearity on GC/RC | Swift (§1.8) |
| Pure linearity + capabilities | Linear annotations | Use-once mandatory | Capabilities double as authority | Austral (§1.9) |
| Six reference capabilities | rcap per reference | Sendable subset by construction | Data-race freedom static | Pony (§1.10) |
| Multiplicity-polymorphic arrows | `%m ->` arrows | Polymorphism over linearity | Code reuse vs. opt-in | Linear Haskell (§1.11) |
| Quantitative type theory / graded modal | 0/1/ω or semiring | Unifies linearity + erasure | Academic; small ecosystem | Idris 2, Granule, Clean (§1.12) |
| Modal memory management | Locality + uniqueness + affinity modes | Stack alloc + reuse + borrow on a GC base | Production retrofit at Jane Street | OxCaml (§1.13) |
| Single ownership + actor processes | Move-on-send across processes | Erlang-style isolation with static types | Pre-1.0 ecosystem | Inko (§1.14) |
| Resource-with-abilities | Linear/copy/drop/key/store ability lattice | Mandatory bytecode verifier at trust boundary | Largest production deployment of linearity | Move (Aptos/Sui) (`TYPES.md §12.5`) |

### 11.2. Region-based memory management

| Technique | Annotation Cost | Inference Power | Key Trade-off | Examples |
|---|---|---|---|---|
| Explicit regions + outlives subtyping | ~6% of LoC | Bidirectional + effect inference | Modest annotation; LIFO discipline | Cyclone (§2.1) |
| Tofte-Talpin / MLKit region inference | Zero | Unification + fixed-point | Region-stuck pathology | MLKit (§2.2) |
| Regions + GC hybrid | Zero | Inference + per-region collectors | Regions handle fast path, GC handles complex | MLKit + GC (§2.3) |
| Per-region pluggable strategies + BoC | Capability annotations | Static isolation | One language, many memory policies | Verona (§2.4) |
| Capabilities-as-regions for actors | Pervasive caps | Type-system-based | Concurrency safety from same mechanism | Encore (§2.5) |
| Region borrowing on generational refs | Opt-in `pure`/region | Type system | Pay cost only where unannotated | Vale (§2.6) |
| Hybrid static/dynamic ASAP | Zero | Dataflow + bounded scans | No GC, bounded fallback | ASAP (§2.7) |
| Single-owner regions | Ownership annotations | Type-checked | Eliminates RTSJ runtime checks | Boyapati (§2.8) |
| Per-line region coloring (runtime) | None | Allocator-internal | Independent of language regions | RC-Immix (§2.9) |

### 11.3. Compile-time reference counting

| Technique | Cycle Strategy | In-Place Mutation | Key Trade-off | Examples |
|---|---|---|---|---|
| SIL ARC + retain elision | Programmer `weak`/`unowned` | `is_unique` runtime check | ARC + ObjC bridge atomics | Swift (§3.1) |
| Perceus + reuse + FIP + TRMC | No general cyclic heap in pure source | Compile-time uniqueness | Pure functional source, imperative bin | Koka (§3.2) |
| Lifetime-analysis borrow-check-lite | Banned (leak-detect at exit) | Compile-time | Cycle problem pushed to programmer | Lobster (§3.3) |
| Morphic + lambda sets + Perceus | Banned by purity | Compile-time | Loop alias-analysis still tricky | Roc (§3.4) |
| ARC + `=destroy`/`sink`/`lent` + ORC | ARC leaks; ORC trial-deletion | Hooks + cursor annotations | Two GC modes per project | Nim (§3.5) |
| RC sentinels + `isExclusive` | Banned by language | Test RC == 1, mutate or copy | Atomic/persistent via sign bit | Lean 4 (§3.6) |

### 11.4. C++ memory safety

| Technique | Sound Memory Safety? | Migration Cost | Status (2026) | Examples |
|---|---|---|---|---|
| Lifetime Profile P1179 | Local only | Recompile | Shipping in MSVC, Clang trunk | (§4.2) |
| Stroustrup Profiles | No (per critics) | Recompile | Whitepaper for C++26 sidecar | (§4.3) |
| Safe C++ + Circle | Yes | Viral `safe`, parallel `std2` | Not pursued after 2025 / effectively dead in WG21 | (§4.4) |
| cppfront / Cpp2 alternative syntax | Defaults safer | Transpile | Personal project | (§4.5) |
| Fil-C InvisiCaps + FUGC | Yes (runtime) | Recompile | Single-developer; ~1.5–4× slowdown | (§4.6) |
| Hazard pointers + RCU | Concurrent reclamation | None (vocabulary) | Standardized C++26 | (§4.7, §9.1, §9.2, §9.12) |
| Hardened libc++/MSVC STL/libstdc++ | Library bounds checks | Opt-in compile flag | Shipping; default coming | (§4.8) |

### 11.5. Hardware-assisted memory safety

| Technique | Granularity | Overhead | Deployment Status / Notes | Examples |
|---|---|---|---|---|
| ARM MTE 4-bit per 16B granule | Per-allocation | 4–12% (ASYNC/SYNC) | Shipping on selected Android/Arm devices; exact default policy is device- and OS-specific | (§5.1) |
| Apple MIE (EMTE + TCE) | Per-allocation; broad system coverage, exact scope release-specific | Reported as production-suitable by Apple | Apple-announced deployment; exact device coverage and third-party scope are time-sensitive | (§5.2) |
| HWASan via TBI | Per-allocation | Higher than MTE, lower than ASan | Android system fuzzing; software-tagged predecessor and design analogue of MTE (§5.1) | (§5.3) |
| ARM PAC | Per-pointer integrity | Near-zero | Universal Apple silicon | (§5.4) |
| Intel CET | Shadow stack + IBT | Near-zero | Tiger Lake+, Zen 3+ | (§5.5) |
| CHERI capabilities | 128-bit per pointer | ~2–3% on optimised microarchitectures; Morello higher; pointer-size memory overhead significant | CheriBSD/Morello research; commercial production silicon still pending except embedded CHERIoT path | (§5.6) |
| CHERIoT MCU CHERI | 64-bit cap over 32-bit addr | Designed for MCU budgets | Emerging embedded CHERI ecosystem; silicon availability is vendor- and date-specific | (§5.7) |
| SoftBound/CETS/LowFat | Per-pointer software | 80–200% / single-digit% | Research only | (§5.8) |
| MPK/POE | Per-page-group | ~20–26 cycles per switch | Skylake-SP+, Zen 3+, ARMv8.9 | (§5.9) |
| CHERI-Lite | Tagged-pointer / capability-style mitigation | Research-stage; intended lower adoption cost than full CHERI | Transitional design point between full CHERI and lighter tagging schemes | (§5.10) |
| SPARC ADI / Intel MPX | Tag / bounds | Various | ADI legacy; MPX dead | (§5.11) |

### 11.6. Tracing GC architectures

| Technique | Latency | Throughput | Memory | Examples |
|---|---|---|---|---|
| Mark-region + opportunistic evacuation | Moderate STW | High (7–25% gain) | Fragmentation-resistant | Immix (§6.1) |
| RC + Immix hybrid | Brief STW + short C | 7.8× over Shenandoah on Lucene | RC overhead | LXR (§6.2) |
| Portable plan framework | Plan-dependent | Plan-dependent | Plan-dependent | MMTk (§6.3) |
| Colored pointers + load barrier + self-healing | <1 ms up to 16 TB | ~10–30% overhead | Compaction | ZGC (§6.4) |
| Concurrent compaction + load reference barriers | Low ms | Production-ready | Compaction | Shenandoah (§6.5) |
| Predictive pause-time regional | ~9–10 ms baseline | Default JVM | Regional | G1 (§6.6) |
| Pauseless via LVB read barrier | Pauseless | Commercial JVM | Compaction | Azul C4 (§6.7) |
| Hybrid-barrier tricolor mark-sweep | <500 µs STW | Ratio + soft cap | No compaction, no generations | Go (§6.8) |
| Per-process private heaps + copy-on-send | No global pause | Process death O(1) | High deep-copy cost | Erlang (§6.9) |
| Multi-domain STW minor + concurrent major | Low ms | Per-domain parallelism | Domains share major | OCaml 5 (§6.10) |
| Hybrid generational concurrent | <2 ms compaction | Default Chrome/Node | Generational | V8 Orinoco (§6.11) |
| Optional generational mode | Incremental default | Workload-dependent | 2-cycle aging | Lua 5.4 (§6.12) |
| Generational parallel STW + per-thread nursery | STW (not concurrent) | Multi-thread parallel collect | Per-thread semi-space; bounds-check write barrier | MoarVM (§6.13) |
| Conservative tracing GC for unmodified C/C++ | Pause varies | Standard tracing | No source modification; ~5% over-retention typical | Boehm-Demers-Weiser (§6.14) |
| Pluggable per-pool GC framework | Pool-policy-dependent | Pool-policy-dependent | Per-allocation-domain policy in one heap | Ravenbrook MPS (§6.15) |
| Concurrent mark-sweep without compaction | Low-ms STW initial/final mark | Concurrent marking + sweeping | Fragmentation accumulates → eventual STW Full GC | HotSpot CMS / ParNew (deprecated) (§6.16) |
| Value-class flattening retrofitted onto JVM | Inline classes + null-restricted types + primitive generics | 2–5× memory reduction on small-struct workloads | 12+ year retrofit; loses object identity | Project Valhalla (preview JDK 25+) (§6.17) |
| 8-byte JVM object header | Class pointer compressed to 22 bits + 42-bit mark word | 5–15% heap reduction; better cache locality | Required biased-locking removal first; tooling updates | Project Lilliput / JEP 519 (JDK 25) (§6.18) |
| Request-private GC | Per-request mark-region heap on Immix substrate | Bypasses global GC for request-local allocations | Research-grade; PLDI 2025 | Iso (§6.19) |
| Synchronous immediate cycle collection | Arborescence (dynamic-graph reachability) | RC + cycle reclamation in bounded time | Per-edge bookkeeping cost | Arborescent GC (ISMM 2025) (§6.20) |
| Pluggable language-agnostic runtime toolkit | GC + JIT + threading as reusable libraries | Decades of J9-tested engineering in OSS | OMR-specific APIs and assumptions | Eclipse OMR (§6.21) |

### 11.7. General-purpose allocators

| Technique | Throughput | Hardening | Latency | Examples |
|---|---|---|---|---|
| Three-list sharding + secure mode | High | Optional secure | Predictable | mimalloc (§7.1) |
| Lock-free MPSC return-to-owner | Very high | Out-of-band metadata | P99 stable | snmalloc (§7.2) |
| Per-CPU + hugepage-aware | High at fleet | Standard | TLB-optimized | TCMalloc + Temeraire (§7.3) |
| Multi-arena + decay-purge | High | Standard | Long-tail-stable | jemalloc (§7.4) |
| Hardened with first-class MTE | Moderate | Strong + MTE | Trap on UAF | Scudo (§7.5) |
| Maximum isolation | Lower | Strongest | Hardening tax | hardened_malloc (§7.6) |
| Type-aware partitioning + MiraclePtr | Moderate | UAF→leak via refcount | Production browser | PartitionAlloc (§7.7) |
| Compact-without-relocate via mremap | Comparable | Standard | Reclaim memory | Mesh (§7.8) |
| Lock-free per-thread span-aligned | High | Standard | Game-engine focus | rpmalloc (§7.9) |
| Bounded-time O(1) | Moderate | Hard real-time | Worst-case bound | TLSF (§7.10) |
| Per-processor + global; provable blowup | Foundational | Standard | First scalable malloc | Hoard (§7.11) |

### 11.8. Language-level allocator interfaces

| Technique | Ergonomics | Transparency | Key Trade-off | Examples |
|---|---|---|---|---|
| Explicit allocator parameter API | Lower | Highest | No hidden allocation; API friction | Zig (§7.12) |
| Context allocator + temp arena | High | Medium | Lifetime discipline via context reset | Odin (§7.12) |
| Implicit context allocator + temporary storage | High | Medium | Strong model, but weaker public documentation here | Jai (§7.12) |
| Scoped temp-pool allocator | High | Medium-high | Escaped temp pointers need debug support | C3 (§7.12) |
| Allocation-expression allocator control | High for object-style code | Medium | Global, scoped, or custom allocation | Beef (§7.12) |
| Runtime heap replacement | Moderate | Low-medium | Good freestanding story, weak per-library policy | Hare (§7.12) |
| Composable allocator building blocks | Low for casual users | High for experts | Toolkit over one blessed policy | D `std.experimental.allocator` (§7.12) |
| Mode-as-compiler-flag (`-autofree`/`-prealloc`/`-gc none`) | High default; specialised modes via flags | Low to high | Single source compiles under different policies; mode-specific bug surface | V (Vlang) (§7.13) |

### 11.9. Verified memory safety

| System | What's Verified | Proof Cost | Production | Examples |
|---|---|---|---|---|
| RustBelt | Soundness of Rust subset incl. unsafe | High (Coq) | Reference; bug-finding | (§8.1) |
| Iris | Concurrent separation-logic foundation | Foundational | 50+ projects | (§8.2) |
| Verus | Functional correctness via SMT | ~5× proof:code | Google pKVM, Amazon, Linux | (§8.3) |
| Prusti | Functional + panic-freedom via Viper | Auto-active | Industrial pilots | (§8.4) |
| Creusot | Functional via WhyML + prophetic borrows | Auto-active | Test suite | (§8.5) |
| Aeneas | Pure functional translation of safe Rust | Per-prover | Microsoft crypto | (§8.6) |
| RefinedRust | Foundational refinement types | High | Vec case study | (§8.7) |
| VeriFast | Separation logic for C/Java/Rust | Manual ghost code | JavaCard, OS components | (§8.8) |
| F\*/Low\*/KaRaMeL | Memory safety + functional correctness | ~3–5× | Firefox, Linux, mbedTLS, Tezos | (§8.9) |
| CompCert memory model | Compiler correctness substrate | Foundational | Avionics DO-178C | (§8.10) |
| Stacked/Tree Borrows | UB definition for unsafe Rust | Operational | Stacked Borrows established in Miri; Tree Borrows experimental | (§8.11) |
| SPARK / Ada | Auto-active functional correctness on Ada | 5 proof levels, multi-prover via Why3 | DO-178C avionics, NVIDIA firmware, ~35-year lineage | (§8.12) |

### 11.10. Concurrent memory reclamation

| Technique | Reader Cost | Retention Bound | Composes With | Examples |
|---|---|---|---|---|
| Hazard pointers | 1 store + 1 fence per HP | Bounded O(N·H·R) | Lock-free DS, C++26 | (§9.1) |
| RCU | 0–2 instructions | Unbounded under stalls | Linux kernel everywhere | (§9.2) |
| QSBR | Zero | Unbounded under stalls | Cooperative threads only | (§9.3) |
| Epoch-based | 1 fence per pin | Unbounded under stalls | Crossbeam, GhostCell | (§9.4) |
| Hazard Eras | Era reservation per dereference | Bounded | Lock-free, ~6× faster than HP | (§9.5) |
| IBR | Interval reservation | Bounded | Various lock-free DS | (§9.6) |
| Wait-Free Eras | Bounded per op | Bounded | Wait-free DS | (§9.7) |
| Hyaline | Distributed RC at reclaim | Bounded (HP-grade) | Self-balancing | (§9.8) |
| Stamp-It | Reservation in stamp pool | Bounded, thread-independent | C++ concurrency | (§9.9) |
| VBR | Optimistic versioning | Immediate reuse | Lock-free typed allocator | (§9.10) |
| NBR | EBR fast + signal handshake | Bounded (HP-grade) | Lock and lock-free DS | (§9.11) |
| Folly hazptr | Production HP | Bounded | C++26 reference impl | (§9.12) |
| RRR-SMR (PLDI 2025) | Bounded; recycling rather than reallocation | Generation-tagged tombstones for safe reuse | Lock-free DS contention-heavy workloads | (§9.13) |

### 11.11. Capability-based memory

| Technique | Authority Mechanism | Concurrency Story | Production | Examples |
|---|---|---|---|---|
| Six rcaps + sendable subset | Type-system deny-properties | Static data-race freedom | Pony stable | (§10.1) |
| 128-bit hardware capabilities | ISA-enforced unforgeable | Per-thread caps | CheriBSD reference OS / research toolchain | (§5.6, §10.2) |
| `__cheri_compartment` annotations | Hardware-checked compartments | Per-compartment isolation | Emerging CHERIoT silicon; vendor/date-specific | (§10.3) |
| No globals + reference passing | Lambda-calculus security kernel | Eventual-send vats | Newspeak/E research | (§10.4) |
| Resource handles in Wit IDL | Component Model worlds | Per-component | Cloudflare/Fastly/Fermyon | (§10.5) |
| Objects-as-capabilities | Type-safe SIPs | Channel contracts | Research / influence-only | (§10.6) |
| CSpaces + retype | Verified kernel caps | Capability-protected IPC | seL4 deployed | (§10.7) |
| Promise pipelining + 3-vat introduction | Distributed CapTP | Vat single-thread | Cap'n Proto Cloudflare | (§10.8) |
| Maximal-subset taming | Subset by deletion | Existing language | SES Hardened JS production | (§10.9) |
| Time-traveling ocap actors | CapTP + transactional | Vat single-thread | Goblins beta | (§10.10) |
| Separation-logic resources | Type-checked `slprop` | SteelCore mechanized | Project Everest | (§10.11) |

---

## 12. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Ownership and Borrowing

1. Non-Lexical Lifetimes default — https://blog.rust-lang.org/2022/08/05/nll-by-default.html
2. NLL RFC 2025 — https://rust-lang.github.io/rfcs/2025-nll.html
3. Two-phase borrows (Matsakis) — https://smallcultfollowing.com/babysteps/blog/2017/03/01/nested-method-calls-via-two-phase-borrowing/
4. Polonius project — https://rust-lang.github.io/polonius/
5. Polonius alpha update — https://blog.rust-lang.org/inside-rust/2023/10/06/polonius-update/
6. Stacked Borrows POPL 2020 — https://plv.mpi-sws.org/rustbelt/stacked-borrows/paper.pdf
7. Tree Borrows PLDI 2025 — https://dl.acm.org/doi/10.1145/3735592
8. Pin/Unpin docs — https://doc.rust-lang.org/std/pin/
9. without.boats on pin — https://without.boats/blog/pin/
10. View types max-min — https://smallcultfollowing.com/babysteps/blog/2026/03/21/view-types-max-min/
11. Hylo language — https://www.hylo-lang.org/
12. Mutable value semantics (JOT 2022) — https://www.jot.fm/issues/issue_2022_02/article2.pdf
13. Mojo ownership — https://docs.modular.com/mojo/manual/values/ownership/
14. Mojo lifecycle/death — https://docs.modular.com/mojo/manual/lifecycle/death/
15. Swift Law of Exclusivity SE-0176 — https://github.com/apple/swift-evolution/blob/main/proposals/0176-enforce-exclusive-access-to-memory.md
16. SE-0390 noncopyable — https://github.com/apple/swift-evolution/blob/main/proposals/0390-noncopyable-structs-and-enums.md
17. Swift Ownership Manifesto — https://github.com/apple/swift/blob/main/docs/OwnershipManifesto.md
18. Austral spec — https://austral-lang.org/spec/spec.html
19. Austral linearity — https://borretti.me/article/how-australs-linear-type-checker-works
20. Pony reference capabilities — https://tutorial.ponylang.io/reference-capabilities/reference-capabilities.html
21. Pony Deny Capabilities for Safe, Fast Actors — https://www.ponylang.io/media/papers/fast-cheap.pdf
22. Linear Haskell POPL 2018 — https://arxiv.org/abs/1710.09756
23. GHC linear types user guide — https://downloads.haskell.org/~ghc/latest/docs/users_guide/exts/linear_types.html
24. Idris 2 QTT — https://arxiv.org/abs/2104.00480
25. Granule project — https://granule-project.github.io/
26. Polonius rust-project-goals 2026 — https://rust-lang.github.io/rust-project-goals/2026/polonius.html
27. Ralf Jung — "Stacked Borrows" — https://www.ralfj.de/blog/2018/08/07/stacked-borrows.html
28. Async book pinning chapter — https://rust-lang.github.io/async-book/part-reference/pinning.html
29. Matsakis view-types series — https://smallcultfollowing.com/babysteps/series/view-types/
30. RFC #3736 Partial Types — https://github.com/rust-lang/rfcs/pull/3736
31. Hylo subscripts language tour — https://docs.hylo-lang.org/language-tour/subscripts
32. Modular — "Deep dive into ownership in Mojo" — https://www.modular.com/blog/deep-dive-into-ownership-in-mojo
33. Borretti — "How capabilities work in Austral" — https://borretti.me/article/how-capabilities-work-austral
34. Pony capability matrix — https://tutorial.ponylang.io/reference-capabilities/capability-matrix.html
35. Clean language report 2.2 — https://wiki.clean.cs.ru.nl/download/html_report/CleanRep.2.2_11.htm
36. Lorenzen et al. — Oxidizing OCaml with Modal Memory Management (ICFP 2024) — https://antonlorenzen.de/oxidizing-ocaml-modal-memory-management.pdf
37. Jane Street — Oxidizing OCaml: Locality — https://blog.janestreet.com/oxidizing-ocaml-locality/
38. Jane Street — Oxidizing OCaml: Ownership — https://blog.janestreet.com/oxidizing-ocaml-ownership/
39. OxCaml stack-allocation reference — https://oxcaml.org/documentation/stack-allocation/reference/
40. Tarides — Introducing Jane Street's OxCaml Branch — https://tarides.com/blog/2025-07-09-introducing-jane-street-s-oxcaml-branch/
41. Inko language home — https://inko-lang.org/
42. Inko concurrency manual — https://docs.inko-lang.org/manual/master/getting-started/concurrency/
43. Inko repository — https://github.com/inko-lang/inko

### Chapter 2 — Region-Based Memory Management

1. Cyclone PLDI 2002 — https://www.cs.umd.edu/projects/cyclone/papers/cyclone-regions.pdf
2. Cyclone tracked pointers SCP 2006 — https://www.cs.umd.edu/projects/PL/cyclone/scp.pdf
3. Elsman, MLKit Algorithm R TOPLAS 1998 — https://elsman.com/mlkit/pdf/toplas98.pdf
4. MLKit retrospective — https://elsman.com/mlkit/pdf/retro.pdf
5. Elsman & Hallenberg JFP 2021 — https://elsman.com/mlkit/pdf/jfp2021.pdf
6. Elsman & Henriksen PLDI 2023 — https://elsman.com/mlkit/pdf/parreg-pldi23.pdf
7. Verona OOPSLA 2023 capabilities — https://dl.acm.org/doi/10.1145/3622846
8. Verona Dynamic Region Ownership PLDI 2025 — https://www.microsoft.com/en-us/research/publication/dynamic-region-ownership-for-concurrency-safety/
9. Verona project — https://github.com/microsoft/verona
10. Encore SFM 2015 — https://ebjohnsen.org/publication/15-encore/15-encore.pdf
11. Vale region-borrowing prototype — https://verdagon.dev/blog/regions-prototype
12. Vale Group Borrowing — https://verdagon.dev/blog/group-borrowing
13. ASAP Cambridge PhD — https://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-908.pdf
14. ASAP practical evaluation — https://nathancorbyn.com/nc513.pdf
15. Boyapati ownership + region PLDI 2003 — https://dl.acm.org/doi/10.1145/781131.781168
16. RC-Immix OOPSLA 2013 — https://www.steveblackburn.org/pubs/papers/rcix-oopsla-2013.pdf
17. Cyclone online manual — https://www.cs.cornell.edu/Projects/cyclone/online-manual/main-screen008.html
18. Elias Castegren homepage — https://eliasc.github.io/
19. Vale Grimoire — https://verdagon.dev/grimoire/grimoire
20. Boyapati ownership + region MIT-LCS-TR-869 — https://people.csail.mit.edu/rinard/techreport/MIT-LCS-TR-869.pdf
21. LXR arXiv preprint (region-coloured RC) — http://arxiv.org/pdf/2210.17175v1

### Chapter 3 — Compile-Time Reference Counting

1. Swift RefCount.h — https://github.com/swiftlang/swift/blob/main/stdlib/public/SwiftShims/RefCount.h
2. Swift ARC Optimization — https://apple-swift.readthedocs.io/en/latest/ARCOptimization.html
3. Frame-Limited Reuse ICFP 2022 — https://www.microsoft.com/en-us/research/wp-content/uploads/2023/07/flreuse.pdf
4. FIP / FP² calculus ICFP 2023 — https://dl.acm.org/doi/10.1145/3607840
5. TRMC + constructor contexts — https://antonlorenzen.de/trmc-jfp.pdf
6. Lobster reference — https://aardappel.github.io/lobster/language_reference.html
7. Lobster philosophy — https://aardappel.github.io/lobster/philosophy.html
8. Roc Morphic loop bug — https://github.com/roc-lang/roc/issues/7367
9. morphic-lang/morphic — https://github.com/morphic-lang/morphic
10. Nim destructors — https://nim-lang.github.io/Nim/destructors.html
11. Nim YRC threadsafe cycle collector PR — https://github.com/nim-lang/Nim/pull/25495
12. Lean 4 RC reference — https://lean-lang.org/doc/reference/latest/Run-Time-Code/Reference-Counting/
13. Lean lean.h — https://github.com/leanprover/lean4/blob/master/src/include/lean/lean.h
14. Swift WeakReferences design — https://github.com/swiftlang/swift/blob/main/docs/WeakReferences.md
15. Wouter van Oortmerssen — Lobster language design overview — http://strlen.com/language-design-overview/
16. Roc — "Fast" page — https://www.roc-lang.org/fast
17. Nim RFC #177 ARC/ORC design — https://github.com/nim-lang/RFCs/issues/177
18. Functional Programming in Lean — Insertion Sort and Array Mutation — https://docs.lean-lang.org/functional_programming_in_lean/Programming___-Proving___-and-Performance/Insertion-Sort-and-Array-Mutation/

### Chapter 4 — Modern C++ Memory Safety

1. P2759 Stroustrup et al. Profiles direction — https://open-std.org/jtc1/sc22/wg21/docs/papers/2023/p2759r0.pdf
2. P3586 Plethora of Problems with Profiles — https://wg21.link/P3586
3. Safe C++ proposal withdrawn (The Register) — https://www.theregister.com/2025/09/16/safe_c_proposal_ditched/
4. P1179 Lifetime Profile — https://wg21.link/p1179
5. Clang LifetimeSafety docs — http://clang.llvm.org/docs/LifetimeSafety.html
6. P3081 Stroustrup Profiles R2 — https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2025/p3081r2.pdf
7. P3589 Profiles syntax — https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2025/p3589r2.pdf
8. Safe C++ P3390 — https://safecpp.org/P3390R0.html
9. P3444 Memory Safety without Lifetime Parameters — https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2024/p3444r0.html
10. Circle draft profiles — https://www.circle-lang.org/draft-profiles.html
11. cppfront / Cpp2 safety — https://hsutter.github.io/cppfront/cpp2/safety/
12. Fil-C Manifesto — https://github.com/pizlonator/fil-c/blob/deluge/Manifesto.md
13. Fil-C InvisiCaps — https://fil-c.org/invisicaps.html
14. C++26 Hazard Pointers P2530R3 — https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2023/p2530r3.pdf
15. C++26 RCU P2545 — https://wg21.link/P2545R0
16. MSVC STL Hardening — https://github.com/microsoft/STL/wiki/STL-Hardening
17. Lifetime Profile update in Visual Studio 2019 (MSVC blog) — https://devblogs.microsoft.com/cppblog/lifetime-profile-update-in-visual-studio-2019-preview-2/
18. P3651 Stroustrup — Profiles framing — https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2025/p3651r0.pdf
19. cppfront project — https://hsutter.github.io/cppfront/
20. Herb Sutter — March 2025 blog — https://herbsutter.com/2025/03/
21. Fil-C repository — https://github.com/pizlonator/fil-c/
22. cppreference — `<hazard_pointer>` header — https://en.cppreference.com/w/cpp/header/hazard_pointer.html
23. MSVC C++ conformance improvements — https://learn.microsoft.com/en-us/cpp/overview/cpp-conformance-improvements
24. N4282 observer_ptr proposal — https://open-std.org/jtc1/sc22/wg21/docs/papers/2014/n4282.pdf
25. cppreference — experimental observer_ptr — https://cppreference.com/w/cpp/experimental/observer_ptr.html

### Chapter 5 — Hardware-Assisted Memory Safety

1. Bionic MTE docs — https://android.googlesource.com/platform/bionic/+/main/docs/mte.md
2. NanoTag / MTE overhead 2025 — https://arxiv.org/pdf/2509.22027
3. Apple MIE blog — https://security.apple.com/blog/memory-integrity-enforcement/
4. 8ksec MIE kernel deep-dive — https://8ksec.io/mie-deep-dive-kernel/
5. HWASan design — https://clang.llvm.org/docs/HardwareAssistedAddressSanitizerDesign.html
6. Pointer Authentication examination (Project Zero) — https://projectzero.google/2019/02/examining-pointer-authentication-on.html
7. PACMAN attack — https://cap.csail.mit.edu/sites/default/files/research-pdfs/PACMAN-%20Attacking%20ARM%20Pointer%20Authentication%20with%20Speculative%20Execution.pdf
8. Linux shadow stack docs — https://docs.kernel.org/next/x86/shstk.html
9. CHERI cap-contracts ICCD 2024 — https://www.cl.cam.ac.uk/research/security/ctsrd/pdfs/202411-iccd-cap-contracts.pdf
10. CheriBSD 25.03 release — https://www.cheribsd.org/release-notes/25.03/index.html
11. CHERIoT 1.0 ISA — https://cheriot.org/sail/specification/release/2025/11/03/cheriot-1.0.html
12. cheriot-ibex — https://github.com/Microsoft/cheriot-ibex
13. Linux Memory Protection Keys — https://kernel.org/doc/html/latest/core-api/protection-keys.html
14. CHERI-Lite for Memory Safety Exploit Mitigation — https://www.microsoft.com/en-us/research/publication/cheri-lite-for-memory-safety-exploit-mitigation/
15. CHERI-Lite paper PDF — https://www.microsoft.com/en-us/research/wp-content/uploads/2025/11/CHERI-Lite-for-Memory-Safety.pdf
16. SPARC ADI Solaris docs — https://docs.oracle.com/en/operating-systems/solaris/oracle-solaris/11.4/prog-interfaces/using-application-data-integrity-adi.html
17. Intel MPX retrospective — https://arxiv.org/pdf/2009.06490
18. Arm learning path — MTE on Pixel 8 — https://learn.arm.com/learning-paths/mobile-graphics-and-gaming/mte_on_pixel8/
19. Apple developer — Meet with Apple session 206 (MIE/EMTE) — https://developer.apple.com/videos/play/meet-with-apple/206/
20. Cai et al. — PAC analysis (USENIX Security 2023) — https://www.usenix.org/system/files/usenixsecurity23-cai-zechao.pdf
21. Phoronix — Intel CET-IBT for Linux 5.18 — https://www.phoronix.com/news/Intel-CET-IBT-For-Linux-5.18
22. Wind River joins the CHERI Alliance — https://www.businesswire.com/news/home/20260421249526/en/Wind-River-Joins-the-CHERI-Alliance
23. CHERIoT-RTOS publication — https://www.microsoft.com/en-us/research/publication/cheriot-rtos-an-os-for-fine-grained-memory-safe-compartments-on-low-cost-embedded-devices/
24. SoftBound project page — http://acg.cis.upenn.edu/softbound/
25. CETS ISMM 2010 paper — https://acg.cis.upenn.edu/papers/ismm10_cets.pdf
26. LowFat allocator — https://github.com/GJDuck/LowFat
27. Connor et al. — MPK security (USENIX Security 2020) — https://www.usenix.org/system/files/sec20fall_connor_prepub.pdf

### Chapter 6 — Tracing GC Architectures

1. Immix PLDI 2008 — https://www.steveblackburn.org/pubs/papers/immix-pldi-2008.pdf
2. LXR PLDI 2022 — https://www.steveblackburn.org/pubs/papers/lxr-pldi-2022.pdf
3. MMTk — https://github.com/mmtk
4. Ruby 3.4 Modular GC — https://railsatscale.com/2025-01-08-new-for-ruby-3-4-modular-garbage-collectors-and-mmtk/
5. ZGC JEP 439 — https://openjdk.org/jeps/439
6. Shenandoah LRB JDK 13 — https://developers.redhat.com/blog/2019/06/27/shenandoah-gc-in-jdk-13-part-1-load-reference-barriers
7. G1 tuning JDK 24 — https://docs.oracle.com/en/java/javase/24/gctuning/garbage-first-garbage-collector-tuning.html
8. Azul C4 — https://www.azul.com/products/components/pgc/
9. Go GC guide — https://go.dev/doc/gc-guide
10. Erlang BEAM GC — https://www.erlang.org/doc/apps/erts/garbagecollection.html
11. OCaml multicore GC slides — https://fun-ocaml.com/2024/slides/multicore-gc.pdf
12. V8 Orinoco — https://v8.dev/blog/orinoco
13. Lua 5.4 manual — https://www.lua.org/manual/5.4/manual.html
14. MoarVM features overview — https://www.moarvm.org/features.html
15. MoarVM gc/collect.c — https://github.com/MoarVM/MoarVM/blob/master/src/gc/collect.c
16. MoarVM PR #1861 dedicated nursery — https://github.com/MoarVM/MoarVM/pull/1861
17. LXR arXiv preprint — https://arxiv.org/pdf/2210.17175v1
18. OpenJDK ZGC wiki — https://wiki.openjdk.java.net/display/zgc
19. Shenandoah self-fixing barriers JDK 14 — https://developers.redhat.com/blog/2020/03/04/shenandoah-gc-in-jdk-14-part-1-self-fixing-barriers
20. Azul C4 ISMM 2011 — https://dl.acm.org/doi/10.1145/1993478.1993491
21. Go runtime mgc.go — https://go.dev/src/runtime/mgc.go
22. Erlang efficiency guide — processes — https://erlang.org/doc/efficiency_guide/processes.html
23. OCaml 5 design notes — https://github.com/ocaml-multicore/docs/blob/main/ocaml_5_design.md
24. V8 — "Trash talk" Orinoco intro — https://v8.dev/blog/trash-talk
25. Lua 5.4 lgc.h source — https://www.lua.org/source/5.4/lgc.h.html
26. Boehm-Demers-Weiser GC home — https://hboehm.info/gc/
27. BDW GC issues and design notes — https://www.hboehm.info/gc/issues.html
28. Boehm & Weiser, "Garbage Collection in an Uncooperative Environment" (SP&E 1988) — https://www.hboehm.info/papers/spe_88_si.pdf
29. Ravenbrook Memory Pool System — https://www.ravenbrook.com/project/mps/
30. MPS documentation (readthedocs mirror) — https://memory-pool-system.readthedocs.io/
31. MPS official manual (Ravenbrook) — https://www.ravenbrook.com/project/mps/master/manual/html/
32. Oracle JDK 13 — Concurrent Mark-Sweep collector tuning — https://docs.oracle.com/en/java/javase/13/gctuning/concurrent-mark-sweep-cms-collector.html
33. JEP 291: Deprecate CMS — https://openjdk.org/jeps/291
34. JEP 363: Remove CMS — https://openjdk.org/jeps/363
35. Project Valhalla — https://openjdk.org/projects/valhalla/
36. JEP 401: Value Classes and Objects (Preview) — https://openjdk.org/jeps/401
37. Goetz — State of Valhalla, Part 1 (Background) — https://cr.openjdk.org/~briangoetz/valhalla/sov/01-background.html
37a. State of Valhalla — Goetz talk (YouTube) — https://www.youtube.com/watch?v=XBu54ZIXIgM
38. JEP 519: Compact Object Headers — https://openjdk.org/jeps/519
39. OpenJDK Project Lilliput wiki — https://wiki.openjdk.org/display/lilliput
40. Aleksey Shipilëv — "Java Objects Inside Out" — https://shipilev.net/jvm/objects-inside-out/
41. JEP 450: Compact Object Headers (Experimental) — https://openjdk.org/jeps/450
42. Qiu & Blackburn — Iso: Request-Private Garbage Collection (PLDI 2025) — https://www.steveblackburn.org/pubs/papers/iso-pldi-2025.pdf
43. Iso ACM DL — https://dl.acm.org/doi/10.1145/3729285
43a. Iso PLDI 2025 details — https://pldi25.sigplan.org/details/pldi-2025-papers/36/Iso-Request-Private-Garbage-Collection
44. Lahaie-Bertrand et al. — Arborescent Garbage Collection (ISMM 2025) — https://oestoleary.com/papers/ISMM25.pdf
45. Arborescent GC ACM DL — https://dl.acm.org/doi/10.1145/3735950.3735953
45a. Arborescent GC author copy (Université de Montréal) — https://www.iro.umontreal.ca/~feeley/papers/LahaieBertrandOestOLearyMelanconFeeleyMonnierISMM25.pdf
46. Eclipse OMR repository — https://github.com/eclipse-omr/omr
47. What is OMR? — https://eclipse.dev/omr/starter/whatisomr.html
48. Eclipse OMR project page — https://projects.eclipse.org/projects/technology.omr
49. Eclipse OpenJ9 home — https://www.eclipse.org/openj9/
50. OpenJ9 documentation — https://www.eclipse.org/openj9/docs/
51. IBM Semeru Runtimes — https://developer.ibm.com/languages/java/semeru-runtimes/

### Chapter 7 — General-Purpose Allocators

1. mimalloc tech report — https://www.microsoft.com/en-us/research/wp-content/uploads/2019/06/mimalloc-tr-v1.pdf
2. mimalloc GitHub — https://github.com/microsoft/mimalloc
3. snmalloc GitHub — https://github.com/microsoft/snmalloc
4. TCMalloc design — https://google.github.io/tcmalloc/design
5. Temeraire OSDI 2021 — https://storage.googleapis.com/pub-tools-public-publication-data/pdf/cebd5a9f6e300184fd762f190ffd8978b724e0c8.pdf
6. jemalloc BSDCan 2006 — https://people.freebsd.org/~jasone/jemalloc/bsdcan2006/jemalloc.pdf
7. jemalloc GitHub — https://github.com/jemalloc/jemalloc
8. Scudo docs — https://llvm.org/docs/ScudoHardenedAllocator.html
9. GrapheneOS hardened_malloc — https://github.com/GrapheneOS/hardened_malloc
10. PartitionAlloc design — https://chromium.googlesource.com/chromium/src/+/HEAD/base/allocator/partition_allocator/PartitionAlloc.md
11. MiraclePtr blog — https://security.googleblog.com/2022/09/use-after-freedom-miracleptr.html
12. Mesh PLDI 2019 — https://people.cs.umass.edu/~mcgregor/papers/19-pldi.pdf
13. rpmalloc GitHub — https://github.com/mjansson/rpmalloc
14. TLSF site — http://www.gii.upv.es/tlsf/
15. Hoard ASPLOS 2000 — https://people.cs.umass.edu/~emery/pubs/berger-asplos2000.pdf
16. mimalloc modes documentation — https://microsoft.github.io/mimalloc/modes.html
17. snmalloc ISMM 2019 proceedings — https://www.microsoft.com/en-us/research/publication/issm-2019-proceedings-of-the-2019-acm-sigplan-international-symposium-on-memory-management/
18. TCMalloc Temeraire docs — https://google.github.io/tcmalloc/temeraire.html
19. Scudo standalone source — https://github.com/llvm/llvm-project/tree/main/compiler-rt/lib/scudo/standalone
20. Synacktiv — Exploring GrapheneOS hardened_malloc — https://synacktiv.com/en/publications/exploring-grapheneos-secure-allocator-hardened-malloc
21. Mesh repository — https://github.com/plasma-umass/Mesh
22. TLSF reference implementation (Conte) — https://github.com/mattconte/tlsf
23. Hoard project page — https://emeryberger.github.io/Hoard/
24. Zig Guide — Allocators — https://zig.guide/standard-library/allocators/
25. Zig `std.heap` source — https://github.com/ziglang/zig/blob/master/lib/std/heap.zig
26. Odin overview — dynamic arrays, `make`, `delete`, and `context.allocator` — https://odin-lang.org/docs/overview/
27. Odin runtime allocator API — https://pkg.odin-lang.org/base/runtime/
28. Odin OS allocators and temp allocator guards — https://github.com/odin-lang/Odin/blob/master/core/os/allocators.odin
29. C3 memory handling — heap allocator, temp allocator, and `@pool` — https://c3-lang.org/language-common/memory/
30. C3 debugging allocators — `VMEM_TEMP` and `TrackingAllocator` — https://c3-lang.org/misc-advanced/debugging/
31. The Way to Jai — Memory Allocators and Temporary Storage — https://github.com/Ivo-Balbaert/The_Way_to_Jai/blob/main/book/21A_Memory_Allocators_and_Temporary_Storage.md
32. Jai Community Wiki — Advanced / context and temporary storage — https://github.com/Jai-Community/Jai-Community-Library/wiki/Advanced
33. Beef memory guide — custom allocators, `scope`, and debug allocator — https://www.beeflang.org/docs/language-guide/memory/
34. Hare runtime heap API — https://docs.harelang.org/rt
35. Hare freestanding runtime allocation hooks — https://harelang.org/documentation/usage/freestanding.html
36. D `std.experimental.allocator` — https://dlang.org/phobos/std_experimental_allocator.html
37. D allocator regions — https://dlang.org/phobos-prerelease/std_experimental_allocator_building_blocks_region.html
38. Oracle Linux blog — Introduction to Folios — https://blogs.oracle.com/linux/intro-to-folios
39. LWN — The state of the page in 2025 — https://lwn.net/Articles/1015320/
40. Oracle UEK8 kernel notes (mTHP) — https://blogs.oracle.com/linux/uek8-a-few-notable-changes-in-the-core-kernel
41. Linux Transparent Huge Pages admin guide — https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html
42. V (Vlang) Memory management — https://docs.vlang.io/memory-management.html
43. V language home page — https://vlang.io/
44. V `-autofree` discussion (#18374) — https://github.com/vlang/v/discussions/18374

### Chapter 8 — Verified Memory Safety

1. RustBelt POPL 2018 — https://plv.mpi-sws.org/rustbelt/popl18/paper.pdf
2. Iris project — https://iris-project.org/
3. Verus paper — https://www.microsoft.com/en-us/research/publication/verus-a-practical-foundation-for-systems-verification/
4. Verus repo — https://github.com/verus-lang/verus
5. Prusti page — https://www.pm.inf.ethz.ch/research/prusti.html
6. Creusot paper — https://hal.inria.fr/hal-03737878/document
7. Creusot repo — https://github.com/creusot-rs/creusot
8. Aeneas paper — https://arxiv.org/pdf/2206.07185
9. RefinedRust PLDI 2024 — https://iris-project.org/pdfs/2024-pldi-refinedrust.pdf
10. VeriFast site — http://people.cs.kuleuven.be/~bart.jacobs/verifast/
11. HACL\* / EverCrypt overview — https://hacl-star.github.io/Overview.html
12. Project Everest — https://www.microsoft.com/en-us/research/project/project-everest-verified-secure-implementations-https-ecosystem/
13. CompCert separation — https://compcert.org/doc/html/compcert.common.Separation.html
14. Tree Borrows PLDI 2025 paper — https://iris-project.org/pdfs/2025-pldi-treeborrows.pdf
15. Ralf Jung — PhD thesis — https://people.mpi-sws.org/~jung/thesis.html
16. Iris from the ground up (JFP) — https://www.cambridge.org/core/journals/journal-of-functional-programming/article/iris-from-the-ground-up-a-modular-foundation-for-higherorder-concurrent-separation-logic/26301B518CE2C52796BFA12B8BAB5B5F
17. Verus user guide — https://verus-lang.github.io/verus/guide/
18. Prusti dev repository — https://github.com/viperproject/prusti-dev
19. Aeneas repository — https://github.com/AeneasVerif/aeneas
20. RefinedRust PLDI 2024 (ACM DL) — https://dl.acm.org/doi/10.1145/3656422
21. VeriFast docs — https://verifast.github.io/verifast-docs/
22. EverCrypt OPLSS 2019 — https://fstar-lang.org/oplss2019/EverCrypt-06282019.pdf
23. CompCert memory model chapter (Cambridge) — https://www.cambridge.org/core/books/abs/program-logics-for-certified-compilers/compcert-memory-model/BC069D42EA52CDBE871A22C118A2C74B
24. AdaCore — Year in Review 2025 — https://www.adacore.com/blog/year-in-review-2025-a-transformative-year-for-high-integrity-software-at-adacore
25. FOSDEM 2025 — Understanding liquid types, contracts and formal verification with Ada/SPARK — https://archive.fosdem.org/2025/schedule/event/fosdem-2025-4879-understanding-liquid-types-contracts-and-formal-verification-with-ada-spark/
26. Cramer et al. — Verifying LLM-Generated Code with SPARK (SCITEPRESS 2025) — https://www.scitepress.org/Papers/2025/134619/134619.pdf
27. The Language That Refuses to Crash (Hackernoon, 2025) — https://hackernoon.com/the-language-that-refuses-to-crash-why-ada-still-matters-in-2025

### Chapter 9 — Concurrent Memory Reclamation

1. Hazard Pointers (Michael) — https://www.cs.otago.ac.nz/cosc440/readings/hazard-pointers.pdf
2. Linux RCU docs — https://www.kernel.org/doc/html/latest/RCU/Design/Requirements/Requirements.html
3. liburcu — https://liburcu.org/
4. DPDK RCU — https://doc.dpdk.org/guides-20.11/prog_guide/rcu_lib.html
5. Fraser EBR thesis — http://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-579.html
6. Crossbeam-epoch — https://docs.rs/crossbeam-epoch/
7. Hazard Eras SPAA 2017 — https://github.com/pramalhe/ConcurrencyFreaks/blob/master/papers/hazarderas-2017.pdf
8. IBR PPoPP 2018 — https://www.cs.rochester.edu/u/scott/papers/2018_PPoPP_IBR.pdf
9. Wait-Free Eras PPoPP 2020 — https://www.ssrg.ece.vt.edu/papers/ppopp20.pdf
10. Hyaline — https://arxiv.org/pdf/1905.07903
11. Stamp-It — https://arxiv.org/abs/1805.08639
12. VBR DISC 2021 — https://arxiv.org/abs/2107.13843
13. NBR PPoPP 2021 — https://rcs.uwaterloo.ca/~ali/papers/ppopp21-nbr.pdf
14. Folly Hazptr — https://github.com/facebook/folly/blob/main/folly/synchronization/Hazptr.h
15. Interval-Based Reclamation library (Rochester) — https://github.com/urcs-sync/Interval-Based-Reclamation
16. Hyaline reference implementation (lfsmr) — https://github.com/rusnikola/lfsmr
17. Nikolaev et al. — RRR-SMR: Reduce, Reuse, Recycle (PLDI 2025) — https://dl.acm.org/doi/10.1145/3729337
18. RRR-SMR PLDI 2025 abstract — https://pldi25.sigplan.org/details/pldi-2025-papers/88/RRR-SMR-Reduce-Reuse-Recycle-Better-Methods-for-Practical-Lock-Free-Data-Structur
19. RRR-SMR Zenodo artifact — https://zenodo.org/records/15110373

### Chapter 10 — Capability-Based Memory and Authority

1. CHERI C/C++ programming — https://github.com/CTSRD-CHERI/cheri-c-programming
2. CHERIoT compartments — https://cheriot.org/book/language_extensions.html
3. CHERIoT sealing — https://cheriot.org/rtos/sealing/2025/11/06/sealing.html
4. E ocap ode — https://erights.org/elib/capability/ode/ode-capabilities.html
5. Newspeak paper — https://bracha.org/newspeak.pdf
6. WASIp2 docs — https://github.com/WebAssembly/WASI/blob/main/docs/Preview2.md
7. Joe Duffy Objects-as-Capabilities — https://joeduffyblog.com/2015/11/10/objects-as-secure-capabilities/
8. Singularity project — https://www.microsoft.com/en-us/research/project/singularity/
9. seL4 capabilities tutorial — https://docs.sel4.systems/Tutorials/capabilities.html
10. seL4 CACM paper — https://cacm.acm.org/research/sel4-formal-verification-of-an-operating-system-kernel/
11. Cap'n Proto RPC — https://capnproto.org/rpc.html
12. Spritely Goblins CapTP — https://files.spritely.institute/docs/guile-goblins/0.15.1/CapTP-The-Capability-Transport-Protocol.html
13. Joe-E NDSS 2010 — https://people.eecs.berkeley.edu/~daw/papers/joe-e-ndss10.pdf
14. Spritely Goblins — https://spritely.institute/goblins/
15. Steel paper — https://project-everest.github.io/assets/steel.pdf
16. Pony recovering capabilities tutorial — https://tutorial.ponylang.io/reference-capabilities/recovering-capabilities.html
17. Cambridge CTSRD CHERI project — https://www.cl.cam.ac.uk/research/security/ctsrd/
18. Steel repository — https://github.com/FStarLang/steel
