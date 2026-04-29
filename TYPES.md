# Type Systems, Semantic Analysis, and Type Checking

This document owns research on type systems and the semantic-analysis machinery that makes them usable in compilers, language servers, runtimes, and tools.

It covers the path from names and scopes to typed programs: symbol tables, name resolution, type representation, inference, checking, subtyping, generics, traits/type classes, gradual typing, dependent typing, effects, ownership-adjacent type disciplines, exhaustiveness, diagnostics, and incremental semantic analysis.

Ownership boundary: parser algorithms belong in `PARSERS.md`; concrete and intermediate representation catalogues belong in `REPRESENTATIONS.md`; lowering, optimization, and code generation belong in `COMPILERS.md`; ownership and memory-safety policy belongs in `MEMORY.md`; module/package boundaries belong in `MODULES.md`; language-server protocol and formatter/linter UX should be treated in a future tooling document if that exists. This document focuses on the semantic rules and algorithms that decide what programs mean before lowering.

---

## 1. Scope and Design Axes

This chapter names the recurring axes along which type-system designs differ. The axes overlap and combine in practice — most production type checkers make a different trade-off on each — but separating them clarifies what each later chapter is optimising for. The axes below are ordered roughly by how visible the choice is to the language user, from "what counts as well-typed" through "where types live" to "how much the user must annotate."

### 1.1. Static, dynamic, gradual, and hybrid checking

A static type checker rejects some programs before execution; a dynamic language defers most checks to runtime; a gradual type system deliberately allows typed and untyped regions to coexist, usually with runtime casts or contracts at boundaries. The engineering choice is not simply safety versus flexibility: it also changes compilation strategy, runtime metadata, optimizer assumptions, diagnostic quality, and language-server latency.

Typed Racket is a strong example of migratory typing: typed and untyped modules interoperate through contracts, and the type system uses *occurrence typing* — flow-sensitive refinement of a variable's type based on predicate tests in the surrounding control flow — to understand predicates common in dynamic Racket code. Full treatment in §7.3.

TypeScript is an intentionally pragmatic structural type system for JavaScript. Its handbook notes unsound compatibility choices made to model common JavaScript idioms; its narrowing machinery tracks control-flow-sensitive refinements. Source: https://www.typescriptlang.org/docs/handbook/type-compatibility.html. Detail in §6.5 (conditional types) and §7.2 (narrowing).

### 1.2. Nominal, structural, and path-dependent identity

Nominal systems decide compatibility primarily from declarations and names. Structural systems decide compatibility from members or shape. Path-dependent systems allow a type to depend on a value path, as in Scala's `p.T`-style types and the DOT calculus family (Dependent Object Types — a small core calculus used to study Scala-style type membership and path-dependent typing).

Nominal systems usually produce simpler error messages and better separate-compilation boundaries. Structural systems support flexible object and record encodings but require careful recursive comparison, variance, and caching. Path-dependent systems support expressive module/object encodings but make soundness and compiler implementation substantially harder.

Scala 3's compiler represents many type forms directly, including term references, type references, singleton types, refined types, union/intersection types, match types, method types, polymorphic types, and type bounds. Source: https://dotty.epfl.ch/docs/internals/type-system.html

DOT research exists because full Scala-style path-dependent typing is difficult to make sound; pDOT extends DOT to paths of arbitrary length and comes with a mechanized proof. Sources: https://scala-lang.org/blog/2016/02/17/scaling-dot-soundness.html and https://dl.acm.org/doi/10.1145/3360571

### 1.3. Explicitness, inference, and annotation burden

A language can require explicit types everywhere, infer local types, infer polymorphic types, or use bidirectional checking to infer when possible and check against known expectations when available. More inference reduces annotation burden but can make diagnostics less local and implementation more complex.

The ML family popularized static typing with parametric polymorphism and automatic type inference, now commonly called Hindley-Milner. Damas-Milner / Algorithm W is canonical in §5.1.

### 1.4. Soundness, usefulness, and deliberate unsoundness

A type system may aim for a formal progress-and-preservation theorem, an implementation-guiding informal discipline, or a pragmatic tool that catches many mistakes without proving full soundness. Deliberate unsoundness is sometimes chosen for compatibility, ergonomics, or ecosystem migration.

The trade-off is whether the choice is made explicit: a type checker that is sound by design can support stronger optimizer and runtime assumptions; a pragmatic checker can be easier to adopt but tends to silently promise guarantees it cannot provide unless that limitation is documented.

### 1.5. Local versus whole-program reasoning

Some checks are local to an expression or function body; others require module graphs, trait/typeclass instance search, exhaustiveness over all constructors, region/ownership facts, or whole-program assumptions. This distinction determines incremental compilation strategy and language-server architecture.

A practical compiler often separates:

- name resolution;
- type representation and interning;
- inference variables and unification tables;
- constraint generation;
- constraint solving;
- trait/typeclass/effect solving;
- typed syntax or high-level typed representation;
- diagnostic explanation data.

---

## 2. Historical Through-Line, 1960–2026

The modern type-system design space accumulated by recombination rather than by replacement: System F, Hindley-Milner inference, type classes, GADTs, occurrence typing, dependent types, refinement types, linear types, and effect rows each emerged in a different decade and now coexist in production type checkers. This chapter traces the through-line from 1960s ALGOL/Simula type-as-storage-discipline to the 2020s' effect handlers and modal memory management, identifying where each idea entered the lineage and which subsequent designs absorbed or reacted against it.

### 2.1. 1960s — ALGOL, Simula, and early typed structure

ALGOL-era languages used types to constrain operations and guide storage/layout decisions. Simula made class-like abstractions part of the type story, turning types into a modelling tool rather than only a machine-layout discipline.

A historical survey of type theory and programming languages notes how ALGOL, Simula, typed lambda calculi, polymorphism, and Curry-Howard connections shaped the modern concept of type systems. Source: https://arxiv.org/pdf/1510.03726

### 2.2. 1970s — Typed lambda calculi, polymorphism, and ML

The 1970s brought the typed lambda calculus vocabulary into programming-language implementation. ML combined static typing, parametric polymorphism, and type inference in a practical language used as the metalanguage of LCF. System F made explicit type abstraction and application central to the theory of parametric polymorphism; Hindley-Milner inference made a useful rank-1 fragment practical without explicit type arguments. Algorithmic detail in §5.1.

Source: https://web.eecs.umich.edu/~weimerw/2012-4610/reading/Cardelli_TypeSystems.pdf

### 2.3. 1980s — Modules, abstract types, type classes, and subtyping

The 1980s and early 1990s expanded the type-checker workload: ML modules, abstract data types, object-oriented subtyping, and Haskell type classes all required more than expression-local inference.

Type classes introduced ad-hoc polymorphism resolved by compiler evidence, commonly implemented through dictionary passing. This design makes overloading explicit in the intermediate representation while preserving source-level implicitness.

### 2.4. 1990s — Objects, rows, variants, and local type inference

Row polymorphism — type-level abstraction over the *rest* of a record's fields or a variant's cases, expressed by a *row variable* standing for an unknown extension — addressed extensible records and variants without committing to nominal object hierarchies. Canonical treatment with Gaster/Jones and Garrigue references in §9.1.

Local type inference became important for languages that wanted explicit polymorphism, subtyping, or higher-rank features without full global inference. Pierce and Turner's work combined local synthesis of type arguments with bidirectional propagation of expected types. Source: https://www.cis.upenn.edu/~bcpierce/papers/lti-toplas.pdf

### 2.5. 2000s — Gradual typing, GADTs, and richer static analysis

The 2000s made typed/untyped migration and GADTs prominent. GADTs let constructors refine type parameters and are powerful for embedded languages and invariant-carrying data, but they complicate inference because pattern matching introduces local equality assumptions.

OutsideIn(X) — where *X* is a parameter naming the underlying constraint domain (e.g. type equalities, type-class predicates, or type-family axioms) — introduced a constraint-based approach to inference with local assumptions. Canonical treatment in §5.2.

Gradual and migratory typing explored how to add static reasoning to dynamic languages while preserving interoperation; Typed Racket is a production-quality research lineage here (see §7.3).

### 2.6. 2010s — Bidirectional typing, dependent elaboration, ownership, and effects

Bidirectional typing became the default practical pattern for expressive type systems because it balances inference and annotation requirements (canonical treatment in §5.3).

Dependent languages such as Coq, Agda, Idris, and Lean made elaboration a central compiler phase: surface syntax with implicit arguments, holes, overloads, coercions, tactics, and type classes is elaborated into a smaller kernel language. Canonical Lean elaborator treatment in §10.1.

Rust made ownership, borrowing, lifetimes, traits, associated types, and monomorphization prominent in mainstream systems programming. Full memory-model details belong in `MEMORY.md §1`; the type-checker consequence is that lifetimes and trait obligations become semantic constraints solved alongside ordinary typing.

### 2.7. 2020s through 2026 — Effect handlers, noncopyable types, trait solvers, and typed tooling

As of early 2026, several trends are especially relevant to new language implementations:

- `Status (as of 2026-04):` effect systems and algebraic effects moving from research into languages such as Koka, Flix, and Unison, with runtime-level support in OCaml. Canonical Koka treatment in §11.2.
- `Status (as of 2026-04):` Rust's next-generation trait solving and Chalk lineage treating traits as logic-programming goals. Canonical treatment in §6.2.
- `Status (Swift 6.2 materials):` Swift generics expanding around parameter packs, noncopyable types, nonescapable types, and integer generic parameters. Detail in §6.5.
- `Status (as of 2026-04):` TypeScript expanding type-level programming through conditional types, inference in conditional types, and control-flow analysis. Detail in §6.5 and §7.2.
- `Status (as of 2026-04):` Lean, Idris, Agda, and Rocq/Coq continuing to refine elaboration, holes, tactics, and bidirectional hints. See §10.

Full memory-model details belong in `MEMORY.md §1`.

---

## 3. Name Resolution, Scopes, and Semantic Binding

Before a type checker can reason about a program, identifiers must be bound to declarations and scopes must be modelled. This chapter covers the resolver as a phase or service: what runs before typing, what stable identities the rest of the compiler needs, and how query- or graph-shaped semantics support modern IDEs. Module identity proper belongs in `MODULES.md`; only the type-checker-facing surface is covered here.

### 3.1. Name resolution before type checking

Most type checkers depend on a resolved representation of names. The resolver maps identifiers to declarations, handles lexical scopes, imports, module aliases, prelude visibility, shadowing, and sometimes overload sets. A language can resolve names before typing, during typing, or through a query system that interleaves resolution and type constraints.

Pre-typing resolution is simpler and gives clear duplicate-name and unknown-name diagnostics. Interleaved resolution is needed when overloads, type-directed lookup, extension methods, implicits, macros, or dependent module paths affect what a name denotes.

### 3.2. Symbols, definitions, and stable identity

A compiler usually needs stable symbol identities distinct from source spelling. A symbol may represent a local variable, type parameter, module, type constructor, trait, method, associated type, field, label, effect, capability, or generated compiler artifact.

Stable identities help incremental compilation, caching, cross-reference indexes, language-server rename, and serialized metadata. If symbol identity is path-based, package-based, or declaration-based, the module system must make that policy explicit; full package identity belongs in `MODULES.md`.

### 3.3. Scope graphs and query-oriented semantics

Scope-graph approaches represent binding structure as graph edges and resolve names through graph queries. The Néron–Tolmach–Visser–Wachsmuth scope-graph framework formalized this view; subsequent work and Spoofax tooling has built on it. Query-based compilers and language servers often memoize name-resolution and type-checking facts so that edits invalidate only affected facts.

This design is attractive for IDEs because it lets editor features ask for exactly the semantic fact needed at a cursor location instead of forcing whole-program analysis.

---

## 4. Core Type Representation

A type checker needs an internal representation of types that is both fast to compare and rich enough to support diagnostics. This chapter covers the split between source-syntax type annotations and canonical type objects, the implementation techniques (interning, hash-consing, arenas) that keep equality cheap, and the role of explicit error types in keeping recovery local.

### 4.1. Type syntax versus canonical type objects

Source type annotations should be parsed as syntax first, then resolved into canonical type objects. This separation lets diagnostics point at source syntax while the solver compares normalized internal forms.

Internal type objects commonly include:

- primitive types;
- nominal type constructors;
- type variables and inference variables;
- function types;
- tuples and records;
- variants and unions;
- references, pointers, and capabilities;
- type applications;
- associated type projections;
- type aliases and opaque types;
- recursive types;
- universal and existential quantifiers;
- effect rows or capability sets;
- error types that permit recovery.

### 4.2. Interning, hash-consing, and arenas

Type checking creates many equivalent type structures. Interning or hash-consing can make equality cheap and improve cache locality. Arena allocation can simplify lifetime management of semantic objects. These implementation techniques are adjacent to `COMPILERS.md §2.1` (compiler-internal arenas) and `REPRESENTATIONS.md §12` (content-addressed and hash-consed IRs), but type checkers place special pressure on them because unification and normalization may allocate heavily.

### 4.3. Error types and poison containment

A practical type checker should use explicit error types to continue checking after an error. The key is to avoid cascades: an unresolved name should not produce hundreds of unrelated type errors. Many compilers treat error types as compatible with anything for recovery, but diagnostics should remember the originating error so secondary messages can be suppressed or marked dependent.

---

## 5. Inference and Checking Algorithms

A type checker's algorithmic core decides how much the programmer must annotate, how predictable diagnostics are, and how many features can interact in one solver. This chapter walks the canonical algorithms from the rank-1 ML core through constraint-based and bidirectional approaches to the unification machinery underneath. The distinguishing axis across subsections is how each technique trades global inference power for local predictability and feature interoperability.

### 5.1. Hindley-Milner and Algorithm W

Hindley-Milner inference provides let-polymorphism, principal types, and predictable inference for a rank-1 polymorphic functional core. Algorithm W threads substitutions while recursively inferring expressions and unifying constraints.

Strengths:

- low annotation burden;
- principal types in the classic setting;
- excellent for ML-style languages;
- conceptually small enough for an early compiler.

Costs:

- effects require value restriction or another discipline;
- subtyping complicates principality;
- higher-rank polymorphism requires annotations or bidirectional methods;
- type classes, GADTs, and associated types require a richer constraint solver.

Sources: https://smlfamily.github.io/history/SML-history.pdf and https://www.cs.cmu.edu/~crary/819-f09/DamasMilner82.pdf

### 5.2. Constraint generation and solving

Constraint-based checkers separate walking the syntax from solving generated obligations. This is useful when many features interact: subtyping, numeric literals, overloads, traits, effects, lifetimes, row variables, and local assumptions.

A typical pipeline is:

1. create inference variables for unknowns;
2. generate equality, subtyping, trait, effect, and region constraints;
3. solve easy unifications eagerly;
4. defer overloaded or ambiguous constraints;
5. default literals and unresolved variables when policy allows;
6. emit diagnostics with origin spans and explanation chains.

OutsideIn(X) is a canonical example of a modular constraint-based approach for local assumptions from advanced features such as GADTs and type families. Source: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/jfp-outsidein.pdf

### 5.3. Bidirectional typing

Bidirectional typing splits typing into two modes:

- synthesis: infer a type from an expression;
- checking: verify an expression against an expected type.

This technique is especially useful when full inference is undecidable, too expensive, or hostile to diagnostics. It lets expected types flow into lambdas, patterns, literals, and holes, while still allowing obvious expressions to synthesize types.

Bidirectional typing improves error locality because the checker often knows what type was expected at the exact subexpression that fails. Sources: https://dl.acm.org/doi/fullHtml/10.1145/3450952 and https://davidchristiansen.dk/tutorials/bidirectional.pdf

### 5.4. Higher-rank polymorphism and local inference

Higher-rank polymorphism permits functions to accept polymorphic functions as arguments or return them in richer ways than ML's rank-1 fragment. Inference is not generally as simple as Hindley-Milner, so practical languages require annotations and use bidirectional checking.

Local type inference can synthesize omitted type arguments and infer lambda parameter types from expected function types without performing global inference. Source: https://www.cis.upenn.edu/~bcpierce/papers/lti-toplas.pdf

### 5.5. Unification and normalization

Unification solves equality between type expressions, but different type systems need different forms:

- first-order unification for ML-style inference;
- row unification for extensible records and variants;
- higher-order or pattern unification for dependent types;
- equality modulo type families, associated types, aliases, reductions, and normalization;
- heterogeneous equality in dependently typed pattern matching.

Dependently typed languages often elaborate terms with holes and open unification constraints; Idris elaborator reflection is the canonical example, treated in §10.3.

Agda-related work on proof-relevant unification treats unifiers as equivalences between solution spaces, replacing ad hoc restrictions and making dependent pattern matching more soundly extensible. Source: https://jesper.sikanda.be/files/proof-relevant-unification.pdf

---

## 6. Polymorphism, Generics, and Reuse

Polymorphism is where a type system either pays for or gives up most of its expressive power. This chapter covers parametric polymorphism and its compilation strategies, the family of trait/type-class/protocol mechanisms that turn type-parameter operations into solver obligations, the projection and coherence problems they introduce, and a sequence of language-specific case studies (Raku, Haskell, OCaml, Idris 2, Koka, Elm) chosen to illustrate the design space. The distinguishing axis across subsections is how each system handles ad-hoc polymorphism: by static evidence, runtime dispatch, dependent indexing, effect rows, or deliberate restriction.

### 6.1. Parametric polymorphism

Parametric polymorphism lets code work uniformly over types. A compiler can implement it by:

- monomorphization, generating specialized code per type instantiation;
- dictionary or witness passing, passing operations and metadata at runtime;
- uniform representation, boxing or using tagged values;
- reified generics, preserving type arguments in runtime metadata;
- hybrid specialization, compiling generic code but specializing hot or visible cases.

The type checker must decide which operations are valid on a type parameter. That usually means explicit bounds, type classes, traits, protocols, concepts, or structural constraints.

### 6.2. Type classes, traits, protocols, and concepts

Type classes and trait-like systems turn operations on type parameters into obligations solved by instance/implementation search. The compiler usually elaborates these obligations into dictionaries, witnesses, vtables, or statically selected methods; lowering and IR-level representation of evidence are covered in `COMPILERS.md §19.2`.

Key design axes:

- global coherence versus local implicit search;
- orphan rules and package boundaries;
- associated types versus generic parameters;
- specialization and overlapping instances;
- negative reasoning and specialization;
- whether solving is syntax-directed, logic-programming-based, or ad hoc.

Chalk lowers Rust trait information into logical predicates and uses a solver similar to a Prolog engine, while remaining embeddable in hosts such as rustc and rust-analyzer. Source: https://rust-lang.github.io/chalk/book/

Rust's next-generation trait solver frames trait checking as proving goals under a parameter environment, returning success, ambiguity, or error plus constraints. Status (as of 2026-04): a flagship 2025–2026 Rust project goal targets stabilization of `-Znext-solver=globally`, replacing the existing trait solver implementation entirely; LWN's March 2026 coverage describes the rewrite as simplifying future trait-system changes, fixing several long-standing soundness bugs, and improving compile times on trait-heavy code. Sources: https://rustc-dev-guide.rust-lang.org/solve/trait-solving.html and https://lwn.net/Articles/1063124/ and https://rust-lang.github.io/rust-project-goals/

### 6.3. Associated types and projection equality

Associated types attach type-level results to trait/protocol implementations. They improve abstraction but complicate equality because a projection such as `Iterator.Item` may not normalize until the implementing type is known.

Chalk models associated type normalization with predicates such as normalization and alias equality; unification involving projections may produce subgoals rather than immediately deciding equality. Source: https://rust-lang.github.io/chalk/book/clauses/type_equality.html

### 6.4. Coherence and ambiguity

Coherence means the same overloaded expression has a unique meaning independent of compilation order or search strategy. Haskell, Rust, Swift, and Scala-like systems make different trade-offs around global uniqueness, associated types, implicits, and path-dependent typing.

A 2025 comparative paper on type-class coherence in Swift, Rust, Scala, and Haskell notes that mainstream non-dependent systems often rely on coherence, while Scala-like dependent typing supports more flexible implicit resolution at the cost of intricate disambiguation policies. Source: https://arxiv.org/pdf/2502.20546

### 6.5. Variadic generics, const generics, and type-level computation

Modern generic systems increasingly include parameter packs, const or integer generics, type-level functions, conditional types, match types, and compile-time evaluation. These features blur the boundary between type checking and compile-time computation.

TypeScript conditional types select types based on assignability tests and can infer type variables within the checked type. Source: https://www.typescriptlang.org/docs/handbook/2/conditional-types.html

Swift's generics documentation tracks features such as parameter packs, noncopyable types, nonescapable types, and integer generic parameters. Source: https://download.swift.org/docs/assets/generics.pdf

### 6.6. Raku — Multi-Dispatch, Roles, Subsets, and Type Objects

Raku is a useful counterexample to the clean nominal-vs-structural and static-vs-dynamic dichotomies. It elevates multi-dispatch into a core semantic model of routine calls — candidate selection depends on arity, parameter types, names, declaration order, `where` clauses, and subset refinements — and pairs it with subset types (a base type plus a `where`-style predicate, described in the docs as an attempt toward gradual typing) and runtime-inspectable type objects via the metaobject protocol. The design lesson is that a language can expose a rich *runtime* type world — type objects, roles, coercions, subsets — without making all of it statically decidable. RakuAST as a class-hierarchy AST that exposes the same metaobject machinery to the compiler frontend is treated in `REPRESENTATIONS.md §3.8`. Sources: https://docs.raku.org/language/functions, https://docs.raku.org/language/typesystem, https://docs.raku.org/language/structures, and https://docs.raku.org/language/mop

### 6.7. Haskell — Type Classes, GADTs, Type Families, and Linear Types in Production

Haskell (specifically GHC) is the strongest production example of a language where advanced type-system features accumulate over decades without collapsing into a new language: type classes, multi-parameter classes, functional dependencies, GADTs, kind polymorphism, type families, arbitrary-rank polymorphism, roles, and linear types all coexist. The architectural lesson is that an extension-oriented type checker needs stable mechanisms for adding new forms of evidence, local assumptions, and defaulting restrictions without breaking existing code; type classes scale into a design space of resolution rules and defaulting; GADTs feed equalities back into pattern-match checking but require rigidity restrictions; type families give open type-level computation; linear types are treated canonically in §12.1. Sources:

- https://downloads.haskell.org/ghc/latest/docs/html/users_guide/exts/typeclasses.html
- https://haskell.org/ghc/docs/latest/html/users_guide/exts/gadt.html
- https://haskell.org/ghc/docs/latest/html/users_guide/exts/type_families.html
- https://www.haskell.org/ghc/docs/latest/html/users_guide/exts/types.html

### 6.8. OCaml — Value Restriction, Polymorphic Variants, and Practical ML Typing

OCaml is a counterweight to Haskell: it repeatedly chooses pragmatic boundaries that preserve predictable inference, compilation speed, and interoperability over maximal type-level expressiveness. The classic production answer to let-polymorphism interacting with mutation is the **value restriction** (and its relaxed variant): rather than papering over the unsoundness, OCaml makes the restriction explicit and pushes annotations or eta-expansion onto the programmer at the call sites where it matters. Source: https://v2.ocaml.org/releases/5.0/htmlman/manual001.html

OCaml's polymorphic variants are the canonical production example of structural variant polymorphism with row inference; the row-polymorphism treatment with the Gaster/Jones and Garrigue references is in §9.1.

The broader lesson from OCaml is that a language can repeatedly prefer *manageable, explainable compromises* over maximal static expressiveness without losing usability.

### 6.9. Idris 2 — Dependent Effects and Quantitative Type Theory

Idris and Idris 2 are especially valuable when the boundary between type systems and effects becomes blurry. The Idris Effects library and later Idris 2's Quantitative Type Theory show how a language can track not only what type a computation returns, but also which resources, protocol states, or capabilities are available before and after an effectful action.

Dependent effects let the availability or shape of an effect depend on runtime outcomes that are then discharged by pattern matching. This is especially powerful for protocol checking: opening a file can yield a different postcondition depending on success, and the type checker can force the program to account for both outcomes. Sources: https://docs.idris-lang.org/en/latest/effects/depeff.html and https://www.type-driven.org.uk/edwinb/papers/effects.pdf

Idris 2's Quantitative Type Theory adds multiplicities to binders, bringing linearity and erasure directly into the core type theory. The practical payoff is that type-level reasoning about resource use and protocol state can be expressed in one language rather than split across a type system and a separate effect discipline. Source: https://www.type-driven.org.uk/edwinb/papers/idris-qtt.pdf

### 6.10. Koka and Elm — Two Opposite Functional Design Lessons

Koka and Elm represent opposite responses to the question "how much semantic structure should the type system expose?" Koka exposes effects as first-class structure in the source: every function arrow carries a row-polymorphic effect set, so purity, exceptions, async, divergence, and user-defined operations are visible to inference, to handler typing, and to selective-CPS lowering. Canonical treatment in §11.2.

Elm chooses the opposite discipline: the type-system-relevant lesson is restriction-as-design — the language refuses to expose imperative effects, FFI, runtime exceptions, or higher-kinded abstraction at all, so that ordinary Hindley-Milner inference and a small total subset of the surface remain enough to type the whole program. Elm's task/effect architecture and concurrent-FRP runtime story is owned by `CONCURRENCY.md §4.6`.

---

## 7. Subtyping, Unions, Intersections, and Refinement

Once a type system admits values of one type in positions expecting another, the checker has to decide compatibility, and decide it consistently. This chapter covers nominal and structural subtyping, union and intersection types, flow-sensitive refinement (occurrence typing), refinement types backed by external solvers, the production refinement-type tooling (LiquidHaskell, Dafny, Stainless, Whiley, Flux, F\*) that has shipped at scale, and Dolan-style **algebraic subtyping** that combines proper subtyping with HM-style principal type inference. Each step adds expressiveness and trades a corresponding amount of inference predictability or solver determinism.

### 7.1. Subtyping

Subtyping allows a value of one type to be used where another is expected. Implementation concerns include variance, recursive types, object fields, method arguments, generics, lifetimes, and type aliases.

Nominal subtyping is easier to cache because declarations define edges. Structural subtyping requires recursive comparison of members and must guard against cycles. Mixed systems need clear rules for when names matter and when structure matters.

### 7.2. Union and intersection types

Union types model alternatives; intersection types model simultaneous capabilities. They pair naturally with control-flow narrowing, pattern matching, and dynamic-language migration.

TypeScript and Typed Racket show two production-oriented approaches to union narrowing: TypeScript follows JavaScript control flow and type guards, while Typed Racket uses occurrence typing with propositions attached to predicates. Sources: https://www.typescriptlang.org/docs/handbook/2/narrowing.html and https://docs.racket-lang.org/ts-guide/occurrence-typing.html

### 7.3. Occurrence typing and flow-sensitive refinement

Occurrence typing refines the type of a variable based on predicates and control flow. It is especially useful for languages where programmers naturally inspect values at runtime.

Typed Racket's occurrence typing assigns logical propositions to predicates so the checker can know, for example, that a successful string predicate narrows a union to string. Source: https://docs.racket-lang.org/ts-guide/occurrence-typing.html

Occurrence typing can be extended with solver-backed refinement over external theories such as arithmetic and bitvectors. Source: https://dl.acm.org/doi/10.1145/2908080.2908091

### 7.4. Refinement types and SMT-backed checking

Refinement types attach logical predicates to base types. They can express array bounds, non-empty lists, units of measure, state protocols, and security properties. SMT-backed checking increases power but introduces solver performance, predictability, and diagnostic challenges.

The main trade-off is placement: refinement types as an optional verification layer impose no cost on programs that ignore them; integrating them into the core type checker raises the question of decidability, timeouts, trusted axioms, and reproducible builds. §7.5 catalogues the production tooling that has shipped this design.

### 7.5. Production Refinement-Type Tooling — LiquidHaskell, Dafny, Stainless, Whiley, Flux, F\*

§7.4 names refinement types in the abstract; the production tooling deserves specific attention because refinement types are now production-viable for narrow, well-specified domains.

**LiquidHaskell** (Vazou, Rondon, Jhala — POPL 2014; production usage since 2017) is the most-deployed refinement-type system. Predicates are inferred via SMT-aided abstract interpretation (the *liquid* algorithm: predicate abstraction over a fixed set of qualifiers), with user-supplied annotations like `{v:Int | v > 0}`. Production users include Galois, Tweag, Awake Security; verified properties include sorted-list invariants, capacity bounds, total-pattern-match obligations, and termination. Distinct from §6.7 GHC type classes: LiquidHaskell layers refinement on top of the existing Haskell type system rather than extending the core, so its trust boundary is the SMT solver plus the LH plugin rather than GHC itself.

**Dafny** (Microsoft Research, K. Rustan M. Leino) is the canonical auto-active verification language: refinement types plus loop invariants plus pre/post conditions, all SMT-discharged via Boogie (see `REPRESENTATIONS.md §11.8`). Used at AWS for the **IAM policy engine** (~10 KLOC of verified Dafny replacing C++), at Cloudflare for proxy authority logic, and increasingly in Linux kernel verification work. The IAM deployment is the largest production codebase verified in any refinement-types system to date.

**Stainless** (EPFL, Viktor Kunčak) extends Scala with refinement types via *Pure Scala*, an embedded total-functional subset; SMT-discharge architecture similar to Dafny. **Whiley** (David J. Pearce) is a standalone refinement-typed systems language. **Flux** (Lehmann, Geller, Vazou, Jhala, Lerner — PLDI 2023) brings LiquidHaskell-style refinement to **Rust on top of MIR**, leveraging Rust's ownership for soundness rather than fighting it; this combination is novel because Rust's affinity discipline makes the implicit-pointer-aliasing problem (the worst case for refinement-type SMT encodings) tractable.

**F\* refinement types**: covered from the verification-result side in `MEMORY.md §8.9` (Project Everest, HACL\*, EverCrypt). The Everest deployment is the largest production refinement-types result outside Dafny IAM; F\* is also distinctive in combining refinement with *effect-typed computation*, so refinements can constrain not only return values but also which effects an expression performs.

The design lesson: **refinement types are now production-viable for narrow well-specified domains** (cryptographic primitives, access control, parser combinators, sorting) where the refinement predicate is small, the cost of a wrong implementation is high, and the SMT solver has a fast path for the relevant theory. Status (as of 2026-04): broad-domain refinement remains research; narrow-domain refinement has shipped at significant scale.

Sources: https://ucsd-progsys.github.io/liquidhaskell/ and https://dafny.org/ and https://stainless.epfl.ch/ and https://whiley.org/ and https://flux-rs.github.io/flux/ and https://www.fstar-lang.org/

### 7.6. MLsub and Algebraic Subtyping — Principal Type Inference with Subtypes

Stephen Dolan's **MLsub** (Cambridge PhD thesis, 2017) is the canonical research line combining **principal-type inference** (the property HM gives — every well-typed program has a most-general type that subsumes all valid types) with **proper subtyping** (the property OO type systems give — `Cat <: Animal` lets cats be used where animals are expected). The classical problem: HM (§5.1) does not handle subtyping; F<: and OO-style subtype inference are exponential or undecidable in general; the two design points seemed irreconcilable. Dolan's **algebraic subtyping** resolves the conflict by treating the lattice of types as a *bicompletion of polar types* and showing that **biunification** yields principal types accounting for both upper and lower subtype bounds.

The technical contributions:

- **Polar types**: types appear with positive (output) or negative (input) polarity. A function type `A → B` is contravariant in `A` (negative position) and covariant in `B` (positive position). Polarity is what makes subtyping align with type-variable usage: a type variable in negative position has an *upper bound* (callers can pass any subtype), in positive position has a *lower bound* (callers can use any supertype).
- **Biunification**: a unification variant where each type variable has both an *upper bound* (the largest type it can be) and a *lower bound* (the smallest type it must be). Substituting a variable replaces it everywhere with a type that satisfies both bounds. This is strictly more general than ordinary unification (which handles only equality) and gives a clean account of subtype constraints.
- **Algebraic subtyping**: the type lattice is required to be a **distributive lattice** with structural intersection and union types. Types like `Int ∧ String` (intersection) and `Int ∨ String` (union) are first-class, and the subtyping relation is exactly the lattice ordering. This is the key restriction — restrictive enough to keep principal types, expressive enough for practical subtyping.
- **Compact polar types**: the inferred types can be presented compactly without exposing the lattice machinery, so error messages and type signatures remain readable to ordinary programmers.

The result is **principal types in the presence of subtyping** with HM-style inference. Every well-typed program has a most-general type that subsumes all valid types, including those involving subtype relations. This was thought infeasible in the OO-typing literature; MLsub shows it works by restricting the type structure to a distributive lattice with structural ∧ and ∨.

Distinct from row polymorphism (§9.1): rows handle extensible records and variants but not full subtyping over arbitrary types. Distinct from F<: (Cardelli's bounded subtyping for OO): F<: handles general subtyping but loses HM-style principal inference. MLsub's contribution is the middle ground — restrictive enough on the type lattice to keep principal types, expressive enough for practical subtyping including over function types, records, and structural variants.

Production / research adoption:

- **MLstruct** (Lionel Parreaux, EPFL, 2020+): the first practical implementation of MLsub-style algebraic subtyping in a language usable beyond research papers. Adds object-oriented features (records with width-and-depth subtyping) and is the substrate for further research into MLsub's interaction with OOP.
- **MLscript** (Parreaux et al.): the followup language combining algebraic subtyping with class-based OOP, polymorphic methods, and modular abstraction.
- **Influence on Scala 3 typing**: Dolan's polarity-and-biunification work fed into Scala 3's match-types and inference improvements, though Scala 3 does not implement full MLsub — Scala 3 retains ordinary unification with bounded type parameters rather than full biunification.
- **Influence on Roc, Grain, Inko**: several modern functional language designs cite Dolan's thesis when explaining their inference choices.

Status (as of 2026-04): research-grade for full implementations; MLstruct/MLscript are the canonical reference. The lesson for language designers: **subtyping and HM-style principal inference are compatible** if the type lattice is restricted to a distributive lattice with structural intersections and unions. Languages that want both features can adopt MLsub's polarity-and-biunification approach; languages that want unrestricted subtyping (path-dependent types, F-bounded polymorphism) must accept the loss of principal inference.

Sources: https://www.cl.cam.ac.uk/~sd601/thesis.pdf and https://infoscience.epfl.ch/record/278576 and https://github.com/hkust-taco/mlscript and https://lptk.github.io/programming/2020/03/26/demystifying-mlsub.html

---

## 8. Algebraic Data Types, Patterns, and Exhaustiveness

Algebraic data types — products and sums — are one of the most consequential type-checker design decisions because they tie together pattern matching, exhaustiveness checking, GADT equalities, and constructor-driven optimizations. This chapter covers the data-type machinery that supports invariant-carrying APIs, the local equality assumptions GADTs introduce on pattern-match branches, and the exhaustiveness/usefulness checks that turn pattern-match warnings into a usable diagnostic.

### 8.1. Algebraic data types

Algebraic data types combine products and sums. They make many invariants explicit and support pattern matching, exhaustiveness checking, serialization schemas, and compiler optimizations.

The type checker should track constructor result types, field types, visibility, generic parameters, and whether constructors are closed or extensible across modules.

### 8.2. GADTs and equality assumptions

Generalized algebraic data types allow constructors to return refined instantiations of a type constructor. Pattern matching on a GADT introduces local type equalities, which must be available while checking the branch.

GADTs are powerful for typed embedded languages, length-indexed data, state machines, and proof-carrying APIs, but they require careful inference design to avoid ambiguous or unsound conclusions. OutsideIn(X) (§5.2) and bidirectional checking (§5.3) are the canonical implementation reference points.

### 8.3. Exhaustiveness and usefulness checking

Pattern-match diagnostics ask two questions:

- exhaustiveness: can some value reach no branch?
- usefulness: can a branch ever match anything not matched earlier?

Maranget's algorithm for ML-style pattern-matching warnings detects useless clauses and non-exhaustive matches and can produce witness patterns for missing cases. Source: http://moscova.inria.fr/~maranget/papers/warn/index.html

Modern languages complicate this with guards, GADTs, view patterns, union types, path-dependent types, and open variants. GHC-related work handles GADTs, guards, and laziness in a unified framework; Scala-oriented work abstracts the type-system-specific part as spaces. Sources: https://dl.acm.org/doi/10.1145/2784731.2784748 and https://infoscience.epfl.ch/nanna/record/225497/files/p61-liu.pdf?withWatermark=0&withMetadata=0&version=1&registerDownload=1

---

## 9. Rows, Records, Variants, and Extensibility

Row polymorphism gives a type-level handle on extensibility: records that grow, variants that open, effect rows that compose. This chapter covers row polymorphism itself, its tension with nominal record declarations, the additional vocabulary needed for extensible variants and open errors, and the unusual case of concatenative languages whose primary typing discipline is a stack effect rather than a function arrow.

### 9.1. Row polymorphism

Row polymorphism tracks the presence or absence of fields or variants with row variables. It supports extensible records, polymorphic variants, effect rows, and sometimes capability sets.

Strengths:

- flexible structural composition;
- precise record update and projection types;
- extensible variants without central registration;
- natural fit for effect rows.

Costs:

- row unification is more complex than ordinary type unification;
- error messages can expose implementation details;
- duplicate labels and scoped labels need policy;
- separate compilation and ABI layout may need canonicalization.

Gaster and Jones described a practical polymorphic type system for extensible records and variants with inference and a compilation strategy; OCaml's polymorphic variants show how structural variant polymorphism can be integrated into a production ML-family language. Sources: https://web.cecs.pdx.edu/~mpj/pubs/96-3.pdf and https://caml.inria.fr/pub/papers/garrigue-polymorphic_variants-ml98.pdf

### 9.2. Structural records versus nominal records

Structural records make shape the interface. Nominal records make declaration identity the interface. Structural systems favor ad hoc composition and data interchange; nominal systems favor explicit API boundaries and evolution control.

A language can mix both by using nominal declarations for public types and structural row types for local records, anonymous objects, effects, or pattern matching.

### 9.3. Extensible variants and open errors

Extensible variants allow adding cases without modifying a central type definition. This is useful for plugin systems, typed errors, extensible interpreters, and modular effect encodings. The trade-off is that exhaustiveness becomes local unless the row is known to be closed.

### 9.4. Concatenative and Stack-Effect Type Systems — Forth, StrongForth, and Factor

Concatenative languages suggest a different path for type-system design: instead of starting from variable-binding terms with ordinary function types, they describe each word by what it consumes from and produces onto the stack, and use composition of stack effects in place of function-type unification. Knaggs formalizes this as an algebra over stack-effect signatures; StrongForth is a production-style proof that strong static stack-effect checking is feasible in a Forth-like language (typed compile-time stack model, branch/loop consistency, overloads on stack types); Factor extends the idea with **row-polymorphic stack effect variables** such as `..a` so higher-order combinators can talk about "the rest of the stack" — a direct analogue of row polymorphism (§9.1) over stacks rather than records. A 2017 pluggable-typing thesis adds the lesson that stack-language checking can be configurable from underflow-only to stronger static consistency. Sources:

- https://dl.acm.org/doi/10.1007/BF01212404
- https://www.stephan-becher.de/strongforth/
- https://www.stephan-becher.de/strongforth/intro.htm
- https://factorcode.org/littledan/dls.pdf
- https://docs.factorcode.org/content/article-inference.html
- https://docs.factorcode.org/content/article-effects-variables.html
- https://repositum.tuwien.at/handle/20.500.12708/7117

---

## 10. Dependent Types, Elaboration, Holes, and Tactics

Dependent typing forces a particular pipeline shape on the type checker: a rich surface language is elaborated into a small core that a trusted kernel re-checks, with metavariables, unification, and tactics as the connective tissue. This chapter covers dependent type basics, typed holes as first-class diagnostic objects, elaborator reflection and tactics, the kernel/elaborator split itself, and the homotopy-type-theoretic upper bound (Cubical Agda's computable univalence). The distinguishing axis across subsections is how much surface power is delegated to elaboration heuristics versus encoded in the trusted core. Multi-stage programming and staged metaprogramming as a *compiler* construct (rather than a type-system construct) are owned by `COMPILERS.md §12.4`.

### 10.1. Dependent types

Dependent types allow types to mention terms. They can express precise invariants such as vector length, protocol state, parser grammar properties, or proof obligations. Full dependent typing changes the type checker into an elaborator plus kernel architecture in many systems.

A common architecture is:

1. parse rich surface syntax;
2. resolve names and implicit arguments;
3. create metavariables for holes;
4. elaborate to a small core language;
5. solve unification and typeclass obligations;
6. check the core term in a trusted kernel;
7. expose tactics or metaprogramming for proof automation.

Lean's elaborator is a major reference for combining implicit arguments, overloading, coercions, type class inference, tactics, and reduction. Source: https://leodemoura.github.io/files/elaboration.pdf

### 10.2. Holes and typed incomplete programs

Typed holes let programmers ask the checker what type is expected and what variables are in scope. They also support editor workflows, partial programs, and proof development.

Holes should be first-class diagnostic objects with expected type, local context, constraints, and candidate completions. They should not be treated merely as parse errors.

### 10.3. Elaborator reflection and tactics

Elaborator reflection exposes parts of the elaboration engine to user code so tactics can construct terms, inspect goals, and manipulate proof states. Idris documentation describes elaboration as desugaring surface Idris into a smaller TT core, with holes and guesses that elaboration programs can control; the proof state exposed to tactics includes goal types, incomplete proof terms, context, and open unification problems. Sources: https://docs.idris-lang.org/en/latest/elaboratorReflection/elabReflection.html and https://docs.idris-lang.org/en/latest/elaboratorReflection/tactics.html

Lean's metaprogramming framework exposes APIs to internal structures and tactic state, enabling tactics to synthesize expressions. Source: https://lean-lang.org/papers/tactic.pdf

### 10.4. Kernel versus elaborator split

A small kernel gives a compact trusted base, while the elaborator can be large, heuristic, and user-extensible. This split is valuable even outside proof assistants: a language can elaborate a rich surface into a simpler typed core and check that core with a smaller algorithm.

### 10.5. Cubical Agda and Homotopy Type Theory — Computable Univalence

Univalent Foundations / Homotopy Type Theory (Voevodsky and the HoTT Book authors, 2010s) reframes equality in dependent types: instead of propositional equality decided by definitional reduction, equality is a *path* in a higher-dimensional structure, and **univalence** (equivalent types are equal) becomes a primitive rather than a postulated axiom. **Cubical Agda** (Vezzosi, Mörtberg, Abel — POPL 2021) is the production-grade implementation of this idea: an Agda flavour where univalence is *computable* rather than assumed, paths are first-class terms, and **higher inductive types** (HITs) — types defined by both points and paths between them — are first-class.

The practical consequence is that quotient types (sets modulo equivalence relations), set-truncated universes, and computational interpretations of category-theoretic constructions all become directly expressible. This is a strict superset of ordinary dependent typing: every Agda proof works in Cubical Agda, plus proofs that require univalence or HITs become tractable rather than blocked.

Distinct from Lean (§10.1), Coq, and Idris 2 (§6.9): those are based on intensional type theory with propositional equality; Cubical reformulates the kernel itself, building on the cubical type theory of Cohen, Coquand, Huber, and Mörtberg (2015). The kernel cost is significantly more sophisticated — interval pretypes, partial elements, glue types, transport along paths — but the user-visible benefit is that proofs about quotient structures (equivalence classes, syntactic-equality-mod-renaming, abstract data types modulo their representation) become much shorter and computational rather than axiomatic.

Status (as of 2026-04): research-grade. Mainstream proof assistants (Lean, Coq) have not adopted univalence as primitive; Cubical Agda is the production implementation, with **Cubical-Coq** (an experimental plugin) and **agda-unimath** (a large univalent-mathematics library) as complementary efforts. For language-design purposes, Cubical Agda matters as an **upper bound on dependent-type expressivity** — the design point at which equality itself becomes a first-class computational object.

Sources: https://agda.readthedocs.io/en/latest/language/cubical.html and https://homotopytypetheory.org/book/ and https://dl.acm.org/doi/10.1145/3434283 and https://unimath.github.io/agda-unimath/

---

## 11. Effect Systems and Capability Typing

Effect systems extend a type to describe not only the result of an expression but the side effects, capabilities, or control transfers it may perform. This chapter covers the basic type-and-effect discipline, algebraic effects and handlers as a generalization of exceptions, the row-shaped or capability-shaped representations of effect sets, lexical second-class capabilities (Effekt), and **session types** as the typing discipline for communication protocols between processes. Runtime scheduling and execution-strategy concerns belong in `CONCURRENCY.md`; effect handlers realized as a concurrency substrate (delimited continuations, fibers, scheduler integration) are owned by `CONCURRENCY.md §5.5`; this chapter focuses on type rules.

### 11.1. Type-and-effect systems

A type-and-effect system gives expressions both a result type and an effect description. Effects may represent I/O, exceptions, allocation, mutation, async suspension, nondeterminism, region access, capabilities, or user-defined algebraic operations.

Effect systems can support:

- pure/effectful distinction;
- checked exceptions;
- capability-controlled APIs;
- algebraic effects and handlers;
- async/await as a user-level effect;
- optimization by knowing which code is pure;
- safe embedding and sandboxing.

### 11.2. Algebraic effects and handlers

Algebraic effects expose operations whose meaning is supplied by handlers. They generalize exceptions and can express control abstractions such as coroutines, backtracking, async, generators, and cooperative threads.

`Status (as of 2026-04):` Koka tracks side effects in function types and supports effect handlers as a typed, composable mechanism, using row-polymorphic effect types and type-directed compilation strategies (such as selective CPS) driven by those effect rows. Sources:

- https://www.microsoft.com/en-us/research/publication/koka-programming-with-row-polymorphic-effect-types/
- https://dl.acm.org/doi/10.1145/3009837.3009872
- https://github.com/koka-lang/koka/
- https://koka-lang.github.io/koka/doc/

Flix describes a type and effect system with primitive effects, algebraic effects, heap effects, effect polymorphism, sub-effecting, effect exclusion, purity reflection, and associated effects. Source: https://doc.flix.dev/effect-system.html

Unison uses abilities and ability handlers; a function type may require an ability set, and handlers provide abilities in scope. Source: https://unison-lang.org/docs/language-reference/abilities-and-ability-handlers

`Status (OCaml 5.2):` the runtime-level `Effect` module exposes effect handlers without static effect safety; from a type-rule perspective, this means OCaml's effects are unchecked at the type level even when handled at runtime. Runtime/maturity detail is owned by `CONCURRENCY.md §5.5` and `COMPILERS.md §19.3`. Source: https://ocaml.org/manual/5.2/effects.html

### 11.3. Effect rows and capability sets

Effect rows use row-polymorphism-like machinery to express extensible sets of effects. Capability sets can be treated similarly, but with an authority interpretation: a function may only perform operations for capabilities in its environment.

Design choices:

- closed versus open effect rows;
- inferred versus explicit effects;
- lexical versus dynamic handler lookup;
- single-shot versus multi-shot continuations;
- effect polymorphism;
- how effects appear in public APIs;
- whether unhandled effects are compile errors or runtime errors.

### 11.4. Effekt — Lexical Effect Handlers with Second-Class Capabilities

Brachthäuser, Schuster, Ostermann's **Effekt** (Tübingen, 2020+) is a research language whose effect system is built around **second-class capabilities**: an effect handler is a capability that can be received as an argument or be in scope, but cannot be stored in heap data structures, returned from functions, or otherwise escape its lexical introduction site. This eliminates the need for runtime evidence threading at the cost of restricting where capabilities can flow.

The trade-off vs Koka (§11.2) is sharp. Koka uses **first-class evidence passing**: a handler can be stored, passed in records, and returned from functions; the runtime threads evidence through every effectful operation. Effekt uses **lexical scoping**: handlers always live on the call stack at handler-installation time, so the compiler compiles handler invocations to direct calls plus stack manipulation rather than runtime evidence lookup. The two languages span a clean spectrum of effect-system design: Koka's runtime cost is per-effect-operation (evidence dispatch), Effekt's restriction is at the type level (capabilities cannot escape).

Effekt also explores three additional design points:

- **Bidirectional effect typing** (§5.3): effect rows participate in bidirectional inference so handlers' expected types flow into the implementations of effectful operations.
- **Algebraic effects with explicit subtyping**: effect rows have a formal subtype lattice, so a function performing only `<exn>` can be passed where a `<exn,async>` function is expected.
- **Capability-passing for resources** (database connections, file handles, mutex tokens): second-class semantics line up naturally with RAII-style resource management — the resource is the capability, lexical scoping bounds its lifetime, and escape is statically prevented.

The compiler targets the JVM, JavaScript, and the LLVM-backed Chez Scheme runtime; the language is implemented in Scala 3.

Status (as of 2026-04): research-grade. Effekt is one of the cleanest examples of "effect handlers as a primary language design choice" rather than as an effect-row addition to an existing functional core. Combined with Koka (§11.2), Flix (§11.2), and Unison (§11.2), the four span the dominant design space for effect-handler languages.

Recent compilation work has formalised the lexical-effect-handler discipline as an *evidence-lifting* transformation that infers and inserts the minimal handler-frame metadata at compile time, enabling efficient native compilation of second-class handlers without the per-operation evidence dispatch Koka pays (Schuster et al., OOPSLA 2023). The 2025 follow-up "Affect: An Affine Type and Effect System" (van Rooij, POPL 2025) investigates affine — rather than purely linear — handler resources, allowing handlers to be installed at most once but discarded without explicit close, simplifying common resource-management patterns at the cost of slightly weaker static guarantees.

Sources: https://effekt-lang.org/ and https://se.cs.uni-tuebingen.de/publications/brachthaeuser20effect.pdf and https://dl.acm.org/doi/10.1145/3428194 and https://dl.acm.org/doi/10.1145/3622831 and https://iris-project.org/pdfs/2025-popl-affect.pdf

### 11.5. Session Types — Typed Communication Protocols

Session types (Honda 1993; Honda, Vasconcelos, Kubo — ESOP 1998; multiparty extension Honda, Yoshida, Carbone — POPL 2008) are the canonical typing discipline for **communication protocols**. A session type is an inhabited type for one *side* of a channel; the protocol is the dual pair: `!T.S` ("send `T`, then continue with session `S`") on one endpoint requires `?T.S'` ("receive `T`, then continue with session `S'`") on the other, with `S` and `S'` themselves dual. The type system rejects programs that try to send a message of the wrong type, receive in a state where the protocol expects a send, or close a channel before the protocol completes.

The two-party (binary) form generalises to **multiparty session types (MPST)**: a global type describes the protocol from the system view, and per-role *projections* give each participant its local session type. The Imperial College / OOI **Scribble** specification language is the production-grade MPST tool: participants generate session-typed APIs from a single global protocol description, and the projection algorithm guarantees that local conformance implies global protocol fidelity.

Distinct from typestate (§12.3): typestate tracks *one object's* state machine; session types track *the protocol of communication between multiple parties*. Distinct from algebraic effects (§11.2): effects describe what a function may do; session types describe the contract between communicating processes. They commonly compose — Effekt (§11.4) and Singularity OS's Sing# integrate session types with effect handlers / channel contracts, respectively. Distinct from CSP-style channels (`CONCURRENCY.md §7.1`): CSP gives runtime communication, session types give *static* communication-protocol typing — the same protocol can be a runtime behaviour or a compile-time guarantee.

Production and research deployments:

- **Singularity OS Sing#** — Microsoft Research's microkernel (2005–2010) used session-typed channel contracts to verify zero-data-race kernel-level message passing (covered from the runtime/SIP angle in `MEMORY.md §10.6`).
- **Rust crates** — `mpstthree` (multiparty), `rumpsteak` (binary), `session-types-ng`. Use Rust's affinity discipline to enforce session linearity natively.
- **F* session types** (Project Everest) for low-level network protocol verification.
- **Java Sessions / Mungo / StMungo** — JVM session-types frameworks with Scribble integration.
- **OCaml session-ocaml** — ML-family experiment.
- **Effekt session types** — extends Effekt's second-class capabilities (§11.4) with session-typed channels.

Status (as of 2026-04): full multiparty session types remain research-grade in production languages; binary session types are simpler to integrate but limited to two-party protocols. The architectural lesson is that **session types are the type-level dual of CSP and the actor model**: for a language with channels, session types are the strongest static guarantee available; for a language with actors, MPST adapts naturally as a global-protocol description that projects to per-actor local types. Languages designing channels or actors from scratch should decide early whether session-type integration is in scope, since retrofitting linear-session discipline onto an existing channel API is hard.

Sources: https://www.doc.ic.ac.uk/~yoshida/papers/multiparty-tutorial.pdf and https://www.scribble.org/ and https://groups.inf.ed.ac.uk/abcd/papers/ESOP98.pdf and https://github.com/sessionrs/sessionrs

### 11.6. Verse — Functional-Logic Programming with Failure-as-Effect

Tim Sweeney and Simon Peyton Jones's **Verse** (Epic Games, deployed in **Unreal Editor for Fortnite (UEFN)** since 2023) is the largest production deployment of **functional-logic programming** in any language — and the design point worth recording is that **failure is a first-class effect**. Every Verse expression has a *success/failure* outcome alongside its value: `if (x > 0) { y } else { fail }` reads naturally because the failure context is part of the language's evaluation semantics, not an exception bolted on top. Failure backtracks across logical-and and propagates through logical-or, recovering the Mercury / Curry functional-logic tradition with deterministic execution semantics suitable for an authoritative game runtime.

The type-system contribution of interest in this chapter is treating **failure as an effect row** comparable to the algebraic-effects rows of Koka (§11.2) and the second-class capabilities of Effekt (§11.4). A Verse function's signature includes which effect specifiers it may exhibit — `decides`, `varies`, `transacts`, `reads`, `writes`, `allocates`, `suspends` — and the type system rejects programs that invoke a stronger-effect callee from a weaker-effect context. The `transacts` effect is particularly distinctive: a function in `transacts` context may roll back its mutations on failure, recovering software transactional memory (`CONCURRENCY.md §9.4`) at the language level rather than as a library.

The **deterministic execution semantics** is the architectural complement: Verse evaluation in UEFN must produce identical outcomes on every client running the same simulation, so the language commits to a deterministic interleaving of failures, transactions, and effect handlers. This is rare for a production game-runtime language; most game scripting (Lua in Roblox via Luau, C# in Unity, GameplayTags in Unreal Blueprint) accepts non-determinism as the cost of dynamic dispatch and lets gameplay code paper over it.

Status (as of 2026-04): Verse is shipping inside UEFN with millions of player-creators authoring Fortnite Islands; the language has not been published as a standalone toolchain outside Epic's ecosystem, and the formal semantics paper drafts (Sweeney + SPJ) circulate but have not appeared in a peer-reviewed venue. The cleanest production data point for "functional-logic + deterministic execution + failure-as-effect" as a language design choice, with the major caveat that documentation is partial and the language is not portable beyond UEFN today.

The lesson generalises: **for languages whose primary use case demands deterministic re-execution** (game simulation, on-chain smart contracts, distributed-system state machines, time-travel debugging substrates — `DEBUGGERS.md §3.13`), making failure a typed effect is structurally cleaner than retrofitting deterministic exception handling onto an effect-untyped core. Verse is the existence proof at production scale.

Sources: https://dev.epicgames.com/documentation/en-us/uefn/verse-language-reference and https://simon.peytonjones.org/assets/pdfs/verse-conf.pdf

---

## 12. Linear, Affine, Ownership, and Resource Types

Resource-tracking type disciplines — linear, affine, ownership/borrowing, and typestate — share a common type-checker shape: they count uses, track regions, and flag invalidated references. This chapter covers the checker-side mechanics: linear/affine arrows, ownership constraints, typestate as a checker feature versus a library pattern, and ATS as the production-ready combination of linear and dependent types in a systems-language setting. Full memory-safety policy and runtime treatment belong in `MEMORY.md §1`.

### 12.1. Linear and affine types

Linear types require exactly-one use; affine types allow at-most-one use. They can encode resource protocols, file handles, unique buffers, session-like APIs, and memory management without runtime tracing.

Linear Haskell attaches linearity to function arrows to integrate with an existing higher-order polymorphic language and support code reuse between linear and non-linear contexts. The resource-discipline framing — multiplicity-polymorphic arrows used to discharge memory-management obligations — is treated in `MEMORY.md §1.11`. Source: https://dl.acm.org/doi/10.1145/3158093

The GHC linear types proposal contrasts linearity with uniqueness and notes that Clean and Rust use uniqueness/ownership-like approaches. Source: https://ghc-proposals.readthedocs.io/en/latest/proposals/0111-linear-types.html

### 12.2. Ownership, borrowing, and lifetimes as type constraints

From the type checker's side, ownership and borrowing reduce to a constraint domain: resource variables with use counts, lifetime regions with subsumption rules, and obligations attached to references. The semantic-policy questions — what counts as a move, how partial moves and reborrows compose, how aliasing relates to mutability, when destructors run — are owned by `MEMORY.md §1`. This subsection cares only about the checker architecture: resource variables, use counts, lifetime regions, effectful drops, and the diagnostics they produce.

### 12.3. Typestate and protocol checking

Typestate tracks state transitions in the type of a value: open versus closed file, initialized versus uninitialized object, authenticated versus anonymous connection. It can be encoded with linear types, phantom types, session types, or dependent indices.

The trade-off is whether typestate lives as a library pattern (low implementation cost, less uniform diagnostics) or as a first-class checker feature (more uniform error messages and stronger guarantees, but additional checker complexity and surface syntax).

### 12.4. ATS — Linear Plus Dependent Types in a Production Systems Language

Hongwei Xi's **ATS** (Applied Type System, 2003+) is one of the few production systems languages combining **linear types** (proof obligations consumed on use), **dependent types** (types parametric over runtime values), and **C interoperability**. ATS compiles to portable C and targets the systems-programming domain — kernels, embedded systems, cryptography — where Rust's ownership model would be preferred today, but ATS shipped a more expressive type system a decade earlier.

The distinctive combination: every value carries a linear-type obligation (consumed exactly once unless the type is non-linear), and types can mention values, so an array's type includes its length, a list's type includes its sortedness, and a file handle's type encodes whether it is currently open. This lets the type system express invariants that Rust's borrow checker (§12.2) cannot: "this loop body must consume the iterator exactly once and produce a result that maintains the sortedness invariant" becomes a type-check obligation discharged statically.

The internal architecture has two strata:

- **Statics**: the dependent-type and proof language, which is total and decidable. Statics terms are erased at runtime.
- **Dynamics**: the linear-typed runtime language, where every value is tracked by linearity, and proof terms from the statics layer can be threaded as ghost arguments to discharge invariants.

The ergonomic cost is real: ATS's dependent types interact with linearity in ways that produce verbose annotations and intricate proof obligations. The language has not seen wide adoption despite shipping useful production code (the Postiats compiler is itself written in ATS, plus several embedded-systems and cryptography projects). Compare Idris 2's QTT (§6.9): QTT aims for similar expressivity with cleaner ergonomics, leveraging multiplicities in binders rather than separate linear-and-dependent type strata.

The lesson is that **combining linearity with dependent types is feasible at production scale** but ergonomically demanding; modern designs (QTT, Granule — `MEMORY.md §1.12`) attempt cleaner integrations of the same expressive power.

Sources: http://www.ats-lang.org/ and https://www.cs.bu.edu/~hwxi/ATS/ATS.html and https://www.cs.bu.edu/~hwxi/atslangweb/ATS2/COURSES/PRACTAlT/HTML/x46.html

### 12.5. Move — Resource Types and Abilities for Smart Contracts

Sam Blackshear et al.'s **Move** (Diem/Libra, 2019; now production at **Aptos** and **Sui**, 2022+) is the largest production deployment of linear types in any language, period. The core type-system primitive is the **resource** — a struct whose values must be linearly used: cannot be copied, cannot be silently dropped (must be explicitly destroyed via a constructor of the defining module), and cannot leak from the module that defined it. This is exactly the discipline ATS (§12.4) and Linear Haskell (`MEMORY.md §1.11`) describe, but applied to digital assets where copying or losing a value is a real economic loss.

Move replaces ad-hoc linearity with an **ability system**: every type carries up to four abilities — `copy` (can be duplicated by `=`), `drop` (can be silently discarded at scope end), `key` (can be a top-level resource stored in global state), `store` (can be nested inside another resource). A type without `copy + drop` is fully linear; a type with only `key` is a top-level singleton; a type with `key + store` can be moved into nested storage. Function generics carry ability constraints (`fun foo<T: copy + drop>(x: T)`), making "this function only works on duplicable types" a first-class type-system concept.

The **bytecode verifier** (mandatory before execution) statically enforces the ability discipline at the bytecode level — distinct from compile-time-only linearity in Haskell or Rust, because Move bytecode crosses trust boundaries (modules from different authors run on the same chain). The verifier is similar in spirit to the BPF verifier (`COMPILERS.md §22`): a small static analysis that gates execution. The **Move Prover** (covered as a Boogie frontend in `REPRESENTATIONS.md §11.8`) layers SMT-discharged functional correctness on top.

The Sui and Aptos Move dialects diverged in 2022. Sui Move adds *object-centric* semantics where every resource has a globally unique ID and storage is owner-keyed; Aptos Move retains the original Diem account-centric model. Both share the ability system and bytecode verifier; the differences are in how resources are stored and how ownership is expressed at the language level.

The lesson generalises beyond blockchain: **a small, mandatory verifier checking linear/ability discipline at the trust boundary** is dramatically more deployable than full dependent-type or refinement-type machinery, and covers the asset-protection use cases that motivated linear types in the first place. For a language designer considering linear types, Move is the existence proof that an ability lattice with 2–4 dimensions can express most real linearity needs without the proof-engineering cost of QTT (§6.9) or ATS (§12.4).

Sources: https://aptos.dev/network/blockchain/move and https://move-language.github.io/move/ and https://github.com/diem/move and https://github.com/MystenLabs/sui/blob/main/external-crates/move/documentation/book/src/abilities.md

---

## 13. Semantic Analysis for Tooling and Incrementality

A modern type checker is not only a batch compiler phase: it is also a service for language servers, refactoring tools, documentation generators, and debuggers. This chapter covers the typed-syntax surface those tools depend on, the dependency tracking required for incremental rechecking, and the architectural shape that lets a type checker be reused as a library. Query-based incremental compilation as a *compiler-architecture* technique (memoization frameworks, demand-driven recomputation, query identity) is owned by `COMPILERS.md §18`. Tooling-architecture detail beyond what the type checker exposes is out of scope.

### 13.1. Typed syntax and semantic models

A compiler can expose semantic information as typed syntax trees, symbol graphs, query results, or an API over compiler internals. IDE features need stable mappings between syntax nodes and semantic objects.

Two production language servers illustrate the type-checker-facing surface: `gopls` exposes serializable indexes over type-checking results so editor queries do not retypecheck, and rust-analyzer documents that a performant language server avoids analysis unless necessary and needs bidirectional mapping between syntax and semantic elements for features like refactoring. Sources: https://go.googlesource.com/tools/+/refs/heads/master/gopls/doc/design/implementation.md and https://rust-analyzer.github.io/blog/2023/12/26/the-heart-of-a-language-server.html

### 13.2. Incremental type checking

Incremental semantic analysis needs dependency tracking at a finer granularity than files. Useful keys include parsed file, module interface, symbol table, import graph, type of declaration, body check result, trait obligations, macro expansion result, and diagnostics.

Challenges:

- edits in public signatures invalidate dependents;
- edits in bodies may not invalidate interfaces;
- implicit search can depend on visible instances;
- macro expansion may change scopes and types;
- generated code should have stable identities;
- stale diagnostics must be withdrawn precisely.

### 13.3. Compiler-as-library boundary

A type checker should be designed as a reusable component, not only a batch compiler phase. Language servers, documentation generators, linters, formatters with semantic needs, refactoring tools, test generators, and debuggers may all need typed information.

GHC modularity work highlights the tension between a batch compiler and reusable compiler library: IDEs need low-latency frontend components, while the compiler pipeline traditionally assumes one-shot compilation. Source: https://hsyl20.fr/home/files/papers/2022-ghc-modularity.pdf

---

## 14. Diagnostics and Error Explanation

A type checker spends much of its observable lifetime explaining itself. This chapter covers origin tracking through inference and constraint solving, ambiguity versus definite mismatch, the rendering of internal types into human-readable form, and the distinction between concise messages for experienced users and expanded explanations for learners.

### 14.1. Origin tracking

Every generated constraint should remember source origin, expected type, actual type, and explanation context. Without origin tracking, solvers produce technically correct but unusable diagnostics.

Useful diagnostic metadata:

- primary source span;
- secondary spans;
- expected and actual type renderings;
- why the expected type was expected;
- where an inferred type variable was introduced;
- which obligation failed;
- which candidates were considered;
- ambiguity versus definite mismatch;
- suggested annotation or import;
- whether the message is suppressed because it depends on a previous error.

### 14.2. Ambiguity and defaulting

Ambiguity is not the same as type error. Numeric literals, overloaded functions, implicit instances, generic associated types, and effect variables may remain unsolved without additional context. A language needs a defaulting policy or a requirement for annotations.

### 14.3. Human-readable type rendering

Internal type representations are often unsuitable for users. The diagnostic renderer should simplify aliases, hide inference-variable internals, choose stable names, avoid exposing normalized projections unless necessary, and show enough structure to explain the problem.

### 14.4. Teaching mode and expert mode

A language can support layered diagnostics: concise messages by default, expanded explanations on request, and machine-readable JSON for tools. Type errors are often where users learn the language, so the checker should preserve a clear story about how the error follows from the rules.

---

## 15. Summary of Type-System Techniques

The technique families below collapse the chapter-level material into a comparison axis. Each row picks the one or two design dimensions that most distinguish the family from its peers, and the Examples column anchors back to the body chapter where the technique is treated in detail. Rows are ordered by topical proximity rather than chapter order, so closely related families (e.g., HM, bidirectional, and constraint solving) sit together.

| Technique family | Best for | Main implementation burden | Main trade-off | Examples |
|---|---|---|---|---|
| Explicit simple static types | Small compilers, predictable diagnostics | Annotation parsing and checking | Higher annotation burden | (§1.3) |
| Hindley-Milner inference | ML-style functional cores | Unification, generalization, value restriction | Harder with subtyping/effects/GADTs | (§5.1) |
| Bidirectional typing | Expressive languages with partial inference | Mode discipline and expected-type propagation | Requires annotations at boundaries | (§5.3) |
| Constraint solving | Many interacting features | Constraint origins, solver architecture | Diagnostics can become indirect | (§5.2) |
| Nominal subtyping | OO APIs and stable libraries | Declaration graph and variance | Less ad hoc flexibility | (§7.1) |
| Structural typing | Records, objects, JavaScript-like shapes | Recursive comparison and caching | Potentially weaker API boundaries | (§1.2, §7.1) |
| Algebraic subtyping with principal inference | Subtyping that composes with HM-style inference | Polar types + biunification + distributive lattice | Restricts type structure to distributive lattice | MLsub, MLstruct (§7.6) |
| Type classes / traits | Bounded generics and overloading | Instance search, coherence, evidence | Ambiguity and compile-time cost | (§6.2, §6.4) |
| Associated types | Abstract families of related types | Projection equality and normalization | Harder inference and errors | (§6.3) |
| Row polymorphism | Extensible records, variants, effects | Row unification and layout policy | Complex messages and ABI questions | (§9.1, §9.4) |
| Union/intersection types | Dynamic-language migration, narrowing | Subtyping lattice and flow analysis | Can be expensive and unsound if pragmatic | (§7.2, §7.3) |
| Gradual typing | Migration from dynamic code | Runtime casts/contracts and blame | Runtime overhead and boundary complexity | (§1.1) |
| Refinement types | Strong invariants over values | SMT integration and decidability policy | Solver unpredictability | (§7.4); production tooling — LiquidHaskell, Dafny, Stainless, Whiley, Flux, F\* (§7.5) |
| Dependent types | Proofs and precise invariants | Elaborator, holes, unification, kernel | High implementation complexity | (§10.1, §10.3, §6.9); Cubical Agda / HoTT (§10.5) |
| Effect systems | Purity, capabilities, checked effects | Effect rows/sets and handler typing | Annotation and inference complexity | (§11.1, §11.2, §11.3); Effekt second-class capabilities (§11.4) |
| Session types | Statically-typed communication protocols | Linearity discipline + duality + (for MPST) projection | Production tooling research-grade; integrates with channels and actors | Sing#, Scribble, Rust mpstthree (§11.5) |
| Failure-as-effect functional-logic typing | Domain language with non-determinism + decidability | Effect specifiers (`transacts`/`decides`/`varies`) drive typed search | Confines logic-programming-style search to where effect annotation permits it | Verse (§11.6) |
| Linear/affine types | Resources and protocols | Use-counting and move analysis | Ergonomic friction | (§12.1, §12.3); ATS linear-plus-dependent (§12.4); Move ability system (§12.5) |
| Exhaustiveness checking | Pattern-match safety | Pattern matrix or space algorithms | Hard with open/extensible types | (§8.3) |
| Incremental semantic analysis | IDEs and fast rebuilds | Query dependency graph and stable IDs | Architecture complexity | (§13.2, §13.3) |

---

## 16. Design Implications for a New Language

1. Start with a small typed core even if the surface language is rich. A compact internal calculus makes elaboration, testing, and diagnostics easier.
2. Decide early whether the language values principal inference, bidirectional local inference, or explicitness. This choice shapes syntax and user expectations.
3. Treat name resolution and type checking as reusable services, not only compiler passes.
4. Preserve source origins for every semantic fact and constraint.
5. If traits/type classes/protocols exist, design coherence and ambiguity rules before users depend on edge cases.
6. If effects or capabilities are part of the design, decide whether they are checked, inferred, dynamically handled, or merely documented.
7. If ownership or linearity exists, keep the memory-safety model in `MEMORY.md §1` but document the checker mechanics here.
8. Avoid exposing internal type normal forms directly in diagnostics.
9. Make typed holes and partial programs first-class if IDE quality matters.
10. Keep the type checker deterministic: diagnostics, inferred types, and selected instances should not depend on hash iteration order or filesystem traversal order.

---

## 17. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Scope and Design Axes

1. Typed Racket Guide — Occurrence Typing — https://docs.racket-lang.org/ts-guide/occurrence-typing.html
2. Migratory Typing: Ten Years Later / Typed Racket — https://www2.ccs.neu.edu/racket/pubs/typed-racket.pdf
3. TypeScript Handbook — Type Compatibility — https://www.typescriptlang.org/docs/handbook/type-compatibility.html
4. TypeScript Handbook — Narrowing — https://www.typescriptlang.org/docs/handbook/2/narrowing.html
5. Scala 3 / Dotty Type System Internals — https://dotty.epfl.ch/docs/internals/type-system.html
6. Scaling DOT to Scala — Soundness — https://scala-lang.org/blog/2016/02/17/scaling-dot-soundness.html
7. A path to DOT: formalizing fully path-dependent types — https://dl.acm.org/doi/10.1145/3360571

### Chapter 2 — Historical Through-Line, 1960–2026

1. Historical survey of types and programming languages — https://arxiv.org/pdf/1510.03726
2. Cardelli, Type Systems — https://web.eecs.umich.edu/~weimerw/2012-4610/reading/Cardelli_TypeSystems.pdf
3. The History of Standard ML — https://smlfamily.github.io/history/SML-history.pdf
4. Damas and Milner, Principal type-schemes for functional programs — https://www.cs.cmu.edu/~crary/819-f09/DamasMilner82.pdf
5. OutsideIn(X): Modular type inference with local assumptions — https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/jfp-outsidein.pdf
6. Dunfield and Krishnaswami, Bidirectional Typing — https://dl.acm.org/doi/fullHtml/10.1145/3450952
7. Lean elaboration algorithm — https://leodemoura.github.io/files/elaboration.pdf
8. Koka repository — https://github.com/koka-lang/koka/
9. Swift generics documentation — https://download.swift.org/docs/assets/generics.pdf

### Chapter 3 — Name Resolution, Scopes, and Semantic Binding

1. Modularizing GHC — https://hsyl20.fr/home/files/papers/2022-ghc-modularity.pdf
2. Rust-analyzer, The Heart of a Language Server — https://rust-analyzer.github.io/blog/2023/12/26/the-heart-of-a-language-server.html
3. Gopls implementation design — https://go.googlesource.com/tools/+/refs/heads/master/gopls/doc/design/implementation.md

### Chapter 4 — Core Type Representation

1. Scala 3 type-system internals — https://dotty.epfl.ch/docs/internals/type-system.html

### Chapter 5 — Inference and Checking Algorithms

1. Damas and Milner — https://www.cs.cmu.edu/~crary/819-f09/DamasMilner82.pdf
2. The History of Standard ML — https://smlfamily.github.io/history/SML-history.pdf
3. OutsideIn(X) — https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/jfp-outsidein.pdf
4. Dunfield and Krishnaswami, Bidirectional Typing — https://dl.acm.org/doi/fullHtml/10.1145/3450952
5. Christiansen, Bidirectional Typing tutorial — https://davidchristiansen.dk/tutorials/bidirectional.pdf
6. Pierce and Turner, Local Type Inference — https://www.cis.upenn.edu/~bcpierce/papers/lti-toplas.pdf
7. Idris elaborator reflection tactics — https://docs.idris-lang.org/en/latest/elaboratorReflection/tactics.html
8. Proof-relevant unification — https://jesper.sikanda.be/files/proof-relevant-unification.pdf

### Chapter 6 — Polymorphism, Generics, and Reuse

1. Chalk book — https://rust-lang.github.io/chalk/book/
2. Chalk type equality and unification — https://rust-lang.github.io/chalk/book/clauses/type_equality.html
3. Rustc dev guide — next-generation trait solving — https://rustc-dev-guide.rust-lang.org/solve/trait-solving.html
3b. LWN — Rust's next-generation trait solver (March 2026) — https://lwn.net/Articles/1063124/
3c. Rust Project Goals — https://rust-lang.github.io/rust-project-goals/
4. Swift generics documentation — https://download.swift.org/docs/assets/generics.pdf
5. TypeScript conditional types — https://www.typescriptlang.org/docs/handbook/2/conditional-types.html
6. Type-class coherence comparison — https://arxiv.org/pdf/2502.20546
7. Raku functions and multi-dispatch — https://docs.raku.org/language/functions
8. Raku type system — https://docs.raku.org/language/typesystem
9. Raku structures and subsets — https://docs.raku.org/language/structures
10. Raku metaobject protocol — https://docs.raku.org/language/mop
11. GHC type classes — https://downloads.haskell.org/ghc/latest/docs/html/users_guide/exts/typeclasses.html
12. GHC GADTs — https://haskell.org/ghc/docs/latest/html/users_guide/exts/gadt.html
13. GHC type families — https://haskell.org/ghc/docs/latest/html/users_guide/exts/type_families.html
14. GHC type extensions overview — https://www.haskell.org/ghc/docs/latest/html/users_guide/exts/types.html
15. OCaml manual overview — https://v2.ocaml.org/releases/5.0/htmlman/manual001.html
16. Idris dependent effects — https://docs.idris-lang.org/en/latest/effects/depeff.html
17. Brady, Programming and reasoning with algebraic effects and dependent types — https://www.type-driven.org.uk/edwinb/papers/effects.pdf
18. Idris 2 QTT — https://www.type-driven.org.uk/edwinb/papers/idris-qtt.pdf

### Chapter 7 — Subtyping, Unions, Intersections, and Refinement

1. TypeScript Handbook — Narrowing — https://www.typescriptlang.org/docs/handbook/2/narrowing.html
2. Typed Racket occurrence typing — https://docs.racket-lang.org/ts-guide/occurrence-typing.html
3. Occurrence typing modulo theories — https://dl.acm.org/doi/10.1145/2908080.2908091
4. LiquidHaskell project — https://ucsd-progsys.github.io/liquidhaskell/
5. Dafny verification language — https://dafny.org/
6. Stainless (EPFL) — https://stainless.epfl.ch/
7. Whiley language — https://whiley.org/
8. Flux refinement types for Rust — https://flux-rs.github.io/flux/
9. F\* language — https://www.fstar-lang.org/
10. Stephen Dolan — Algebraic Subtyping (Cambridge PhD thesis, 2017) — https://www.cl.cam.ac.uk/~sd601/thesis.pdf
11. Parreaux — "MLstruct: Principal Type Inference in a Boolean Algebra of Structural Types" (EPFL) — https://infoscience.epfl.ch/record/278576
12. MLscript repository — https://github.com/hkust-taco/mlscript
13. Parreaux — "Demystifying MLsub" — https://lptk.github.io/programming/2020/03/26/demystifying-mlsub.html

### Chapter 8 — Algebraic Data Types, Patterns, and Exhaustiveness

1. Maranget, Warnings for pattern matching — http://moscova.inria.fr/~maranget/papers/warn/index.html
2. GADTs meet their match — https://dl.acm.org/doi/10.1145/2784731.2784748
3. Generic exhaustivity checking with spaces — https://infoscience.epfl.ch/nanna/record/225497/files/p61-liu.pdf?withWatermark=0&withMetadata=0&version=1&registerDownload=1

### Chapter 9 — Rows, Records, Variants, and Extensibility

1. Gaster and Jones, A Polymorphic Type System for Extensible Records and Variants — https://web.cecs.pdx.edu/~mpj/pubs/96-3.pdf
2. Garrigue, Programming with Polymorphic Variants — https://caml.inria.fr/pub/papers/garrigue-polymorphic_variants-ml98.pdf
3. Knaggs, Type inference in stack based languages — https://dl.acm.org/doi/10.1007/BF01212404
4. StrongForth homepage and introduction — https://www.stephan-becher.de/strongforth/ and https://www.stephan-becher.de/strongforth/intro.htm
5. Factor stack checker and stack effect row variables — https://docs.factorcode.org/content/article-inference.html and https://docs.factorcode.org/content/article-effects-variables.html
6. Factor paper on stack effects and row polymorphism — https://factorcode.org/littledan/dls.pdf
7. Optional, pluggable typing for Forth — https://repositum.tuwien.at/handle/20.500.12708/7117

### Chapter 10 — Dependent Types, Elaboration, Holes, and Tactics

1. Lean elaboration algorithm — https://leodemoura.github.io/files/elaboration.pdf
2. Lean metaprogramming framework — https://lean-lang.org/papers/tactic.pdf
3. Idris elaborator reflection — https://docs.idris-lang.org/en/latest/elaboratorReflection/elabReflection.html
4. Idris tactics and proof state — https://docs.idris-lang.org/en/latest/elaboratorReflection/tactics.html
5. Proof-relevant unification — https://jesper.sikanda.be/files/proof-relevant-unification.pdf
6. Cubical Agda documentation — https://agda.readthedocs.io/en/latest/language/cubical.html
7. Homotopy Type Theory book — https://homotopytypetheory.org/book/
8. Vezzosi, Mörtberg, Abel — Cubical Agda (POPL 2021) — https://dl.acm.org/doi/10.1145/3434283
9. agda-unimath univalent-mathematics library — https://unimath.github.io/agda-unimath/

### Chapter 11 — Effect Systems and Capability Typing

1. Koka row-polymorphic effect types — https://www.microsoft.com/en-us/research/publication/koka-programming-with-row-polymorphic-effect-types/
2. Koka type-directed compilation of row-typed algebraic effects — https://dl.acm.org/doi/10.1145/3009837.3009872
3. Koka repository — https://github.com/koka-lang/koka/
4. Koka documentation — https://koka-lang.github.io/koka/doc/
5. Flix effect system — https://doc.flix.dev/effect-system.html
6. Unison abilities and handlers — https://unison-lang.org/docs/language-reference/abilities-and-ability-handlers
7. OCaml 5 effect handlers manual — https://ocaml.org/manual/5.2/effects.html
8. Effekt language home — https://effekt-lang.org/
9. Brachthäuser, Schuster, Ostermann — "Effects as Capabilities" (OOPSLA 2020) — https://se.cs.uni-tuebingen.de/publications/brachthaeuser20effect.pdf
10. Effekt OOPSLA 2020 (ACM DL) — https://dl.acm.org/doi/10.1145/3428194
10b. Schuster et al. — Enabling Efficient Compilation of Lexical Effect Handlers (OOPSLA 2023) — https://dl.acm.org/doi/10.1145/3622831
10c. Affect: An Affine Type and Effect System (POPL 2025) — https://iris-project.org/pdfs/2025-popl-affect.pdf
11. Yoshida — Multiparty Session Types tutorial — https://www.doc.ic.ac.uk/~yoshida/papers/multiparty-tutorial.pdf
12. Scribble multiparty protocol description language — https://www.scribble.org/
13. Honda, Vasconcelos, Kubo — "Language Primitives and Type Discipline for Structured Communication-Based Programming" (ESOP 1998) — https://groups.inf.ed.ac.uk/abcd/papers/ESOP98.pdf
14. Session types in Rust (sessionrs) — https://github.com/sessionrs/sessionrs
15. Verse Language Reference (Epic Games / UEFN) — https://dev.epicgames.com/documentation/en-us/uefn/verse-language-reference
16. Verse: A Functional-Logic Language with Failure-Effect (Peyton Jones et al.) — https://simon.peytonjones.org/assets/pdfs/verse-conf.pdf

### Chapter 12 — Linear, Affine, Ownership, and Resource Types

1. GHC proposal — Linear Types — https://ghc-proposals.readthedocs.io/en/latest/proposals/0111-linear-types.html
2. Linear Haskell: practical linearity in a higher-order polymorphic language — https://dl.acm.org/doi/10.1145/3158093
3. ATS language home — http://www.ats-lang.org/
4. ATS overview (Boston University) — https://www.cs.bu.edu/~hwxi/ATS/ATS.html
5. ATS practical aspects — https://www.cs.bu.edu/~hwxi/atslangweb/ATS2/COURSES/PRACTAlT/HTML/x46.html
6. Aptos — Move Web3 Language and Runtime — https://aptos.dev/network/blockchain/move
7. Move Language Reference — https://move-language.github.io/move/
8. Diem Move repository — https://github.com/diem/move
9. Sui Move abilities — https://github.com/MystenLabs/sui/blob/main/external-crates/move/documentation/book/src/abilities.md

### Chapter 13 — Semantic Analysis for Tooling and Incrementality

1. Gopls implementation design — https://go.googlesource.com/tools/+/refs/heads/master/gopls/doc/design/implementation.md
2. Rust-analyzer, The Heart of a Language Server — https://rust-analyzer.github.io/blog/2023/12/26/the-heart-of-a-language-server.html
3. Modularizing GHC — https://hsyl20.fr/home/files/papers/2022-ghc-modularity.pdf
