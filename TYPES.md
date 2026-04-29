# Type Systems, Semantic Analysis, and Type Checking

This document owns research on type systems and the semantic-analysis machinery that makes them usable in compilers, language servers, runtimes, and tools.

It covers the path from names and scopes to typed programs: symbol tables, name resolution, type representation, inference, checking, subtyping, generics, traits/type classes, gradual typing, dependent typing, effects, ownership-adjacent type disciplines, exhaustiveness, diagnostics, and incremental semantic analysis.

Ownership boundary: parser algorithms belong in `PARSERS.md`; concrete and intermediate representation catalogues belong in `REPRESENTATIONS.md`; lowering, optimization, and code generation belong in `COMPILERS.md`; ownership and memory-safety policy belongs in `MEMORY.md`; module/package boundaries belong in `MODULES.md`; language-server protocol and formatter/linter UX should be treated in a future tooling document if that exists. This document focuses on the semantic rules and algorithms that decide what programs mean before lowering.

---

## 1. Scope and Design Axes

### 1.1. Static, dynamic, gradual, and hybrid checking

A static type checker rejects some programs before execution; a dynamic language defers most checks to runtime; a gradual type system deliberately allows typed and untyped regions to coexist, usually with runtime casts or contracts at boundaries. The engineering choice is not simply safety versus flexibility: it also changes compilation strategy, runtime metadata, optimizer assumptions, diagnostic quality, and language-server latency.

Typed Racket is a strong example of migratory typing: typed and untyped modules interoperate through contracts, and the type system uses occurrence typing to understand predicates common in dynamic Racket code. Sources: https://www2.ccs.neu.edu/racket/pubs/typed-racket.pdf and https://docs.racket-lang.org/ts-guide/occurrence-typing.html

TypeScript is an intentionally pragmatic structural type system for JavaScript. Its handbook explicitly notes unsound compatibility choices made to model common JavaScript idioms, while its narrowing machinery tracks control-flow-sensitive refinements. Sources: https://www.typescriptlang.org/docs/handbook/type-compatibility.html and https://www.typescriptlang.org/docs/handbook/2/narrowing.html

### 1.2. Nominal, structural, and path-dependent identity

Nominal systems decide compatibility primarily from declarations and names. Structural systems decide compatibility from members or shape. Path-dependent systems allow a type to depend on a value path, as in Scala's `p.T`-style types and the DOT calculus family.

Nominal systems usually produce simpler error messages and better separate-compilation boundaries. Structural systems support flexible object and record encodings but require careful recursive comparison, variance, and caching. Path-dependent systems support expressive module/object encodings but make soundness and compiler implementation substantially harder.

Scala 3's compiler represents many type forms directly, including term references, type references, singleton types, refined types, union/intersection types, match types, method types, polymorphic types, and type bounds. Source: https://dotty.epfl.ch/docs/internals/type-system.html

DOT research exists because full Scala-style path-dependent typing is difficult to make sound; pDOT extends DOT to paths of arbitrary length and comes with a mechanized proof. Sources: https://scala-lang.org/blog/2016/02/17/scaling-dot-soundness.html and https://dl.acm.org/doi/10.1145/3360571

### 1.3. Explicitness, inference, and annotation burden

A language can require explicit types everywhere, infer local types, infer polymorphic types, or use bidirectional checking to infer when possible and check against known expectations when available. More inference reduces annotation burden but can make diagnostics less local and implementation more complex.

The ML family popularized static typing with parametric polymorphism and automatic type inference, now commonly called Hindley-Milner. The Standard ML history identifies Milner's let-polymorphism and Algorithm W as central contributions. Source: https://smlfamily.github.io/history/SML-history.pdf

Damas and Milner showed principal type schemes for the applicative part of ML, giving a foundation for decidable inference that finds the most general type in that setting. Source: https://www.cs.cmu.edu/~crary/819-f09/DamasMilner82.pdf

### 1.4. Soundness, usefulness, and deliberate unsoundness

A type system may aim for a formal progress-and-preservation theorem, an implementation-guiding informal discipline, or a pragmatic tool that catches many mistakes without proving full soundness. Deliberate unsoundness is sometimes chosen for compatibility, ergonomics, or ecosystem migration.

For a new language, the key is to make this choice explicit. A type checker that is sound by design can support stronger optimizer and runtime assumptions. A pragmatic checker can be easier to adopt but should avoid silently promising guarantees it cannot provide.

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

### 2.1. 1960s — ALGOL, Simula, and early typed structure

ALGOL-era languages used types to constrain operations and guide storage/layout decisions. Simula made class-like abstractions part of the type story, turning types into a modelling tool rather than only a machine-layout discipline.

A historical survey of type theory and programming languages notes how ALGOL, Simula, typed lambda calculi, polymorphism, and Curry-Howard connections shaped the modern concept of type systems. Source: https://arxiv.org/pdf/1510.03726

### 2.2. 1970s — Typed lambda calculi, polymorphism, and ML

The 1970s brought the typed lambda calculus vocabulary into programming-language implementation. ML combined static typing, parametric polymorphism, and type inference in a practical language used as the metalanguage of LCF.

System F made explicit type abstraction and application central to the theory of parametric polymorphism. Hindley-Milner inference made a useful rank-1 fragment practical without requiring users to write all type arguments.

Sources: https://web.eecs.umich.edu/~weimerw/2012-4610/reading/Cardelli_TypeSystems.pdf and https://www.cs.cmu.edu/~crary/819-f09/DamasMilner82.pdf

### 2.3. 1980s — Modules, abstract types, type classes, and subtyping

The 1980s and early 1990s expanded the type-checker workload: ML modules, abstract data types, object-oriented subtyping, and Haskell type classes all required more than expression-local inference.

Type classes introduced ad-hoc polymorphism resolved by compiler evidence, commonly implemented through dictionary passing. This design makes overloading explicit in the intermediate representation while preserving source-level implicitness.

### 2.4. 1990s — Objects, rows, variants, and local type inference

Row polymorphism and polymorphic variants addressed extensible records and variants without committing to nominal object hierarchies. Gaster and Jones described a practical polymorphic type system for extensible records and variants with inference and compilation strategy. Source: https://web.cecs.pdx.edu/~mpj/pubs/96-3.pdf

OCaml's polymorphic variants show how structural variant polymorphism can be integrated into a production ML-family language with inference and efficient compilation. Source: https://caml.inria.fr/pub/papers/garrigue-polymorphic_variants-ml98.pdf

Local type inference became important for languages that wanted explicit polymorphism, subtyping, or higher-rank features without full global inference. Pierce and Turner's work combined local synthesis of type arguments with bidirectional propagation of expected types. Source: https://www.cis.upenn.edu/~bcpierce/papers/lti-toplas.pdf

### 2.5. 2000s — Gradual typing, GADTs, and richer static analysis

The 2000s made typed/untyped migration and GADTs prominent. GADTs let constructors refine type parameters and are powerful for embedded languages and invariant-carrying data, but they complicate inference because pattern matching introduces local equality assumptions.

OutsideIn(X) introduced a constraint-based approach to type inference with local assumptions, parameterized by an underlying constraint domain, and was motivated by GADTs, type classes, and type families. Source: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/jfp-outsidein.pdf

Gradual typing and migratory typing explored how to add static reasoning to dynamic languages while preserving interoperation. Typed Racket is a production-quality research lineage here. Source: https://www2.ccs.neu.edu/racket/pubs/typed-racket.pdf

### 2.6. 2010s — Bidirectional typing, dependent elaboration, ownership, and effects

Bidirectional typing became the default practical pattern for expressive type systems because it balances inference and annotation requirements. Dunfield and Krishnaswami's survey describes type checking and type synthesis modes, their history, and their usefulness for error locality. Source: https://dl.acm.org/doi/fullHtml/10.1145/3450952

Dependent languages such as Coq, Agda, Idris, and Lean made elaboration a central compiler phase: surface syntax with implicit arguments, holes, overloads, coercions, tactics, and type classes is elaborated into a smaller kernel language.

Lean's elaborator handles higher-order unification, overloading, coercions, type class inference, tactics, and computational reduction, balancing efficiency and usability. Source: https://leodemoura.github.io/files/elaboration.pdf

Rust made ownership, borrowing, lifetimes, traits, associated types, and monomorphization prominent in mainstream systems programming. Full memory-model details belong in `MEMORY.md`, but the type-checker consequence is that lifetimes and trait obligations become semantic constraints solved alongside ordinary typing.

### 2.7. 2020s through 2026 — Effect handlers, noncopyable types, trait solvers, and typed tooling

As of early 2026, several trends are especially relevant to new language implementations:

- effect systems and algebraic effects moving from research into languages such as Koka, Flix, Unison, and runtime-level support in OCaml;
- Rust's next-generation trait solving and Chalk lineage treating traits as logic-programming goals;
- Swift generics expanding around parameter packs, noncopyable types, nonescapable types, and integer generic parameters;
- TypeScript expanding type-level programming through conditional types, inference in conditional types, and control-flow analysis;
- Lean, Idris, Agda, and Rocq/Coq continuing to refine elaboration, holes, tactics, and bidirectional hints.

Status (as of 2026-04): Koka's repository reports recent releases and describes the language as a strongly typed functional language with effect types and handlers. Source: https://github.com/koka-lang/koka/

Status (Swift 6.2 materials): Swift generics documentation identifies parameter packs in Swift 5.9, noncopyable types in Swift 6, and nonescapable types and integer generic parameters in Swift 6.2. Source: https://download.swift.org/docs/assets/generics.pdf

Status (as of May 2022 in the rustc dev guide): Chalk was described as experimental and under development, with the new-style trait solver based on Chalk ideas. Source: https://rustc-dev-guide.rust-lang.org/traits/chalk.html

---

## 3. Name Resolution, Scopes, and Semantic Binding

### 3.1. Name resolution before type checking

Most type checkers depend on a resolved representation of names. The resolver maps identifiers to declarations, handles lexical scopes, imports, module aliases, prelude visibility, shadowing, and sometimes overload sets. A language can resolve names before typing, during typing, or through a query system that interleaves resolution and type constraints.

Pre-typing resolution is simpler and gives clear duplicate-name and unknown-name diagnostics. Interleaved resolution is needed when overloads, type-directed lookup, extension methods, implicits, macros, or dependent module paths affect what a name denotes.

### 3.2. Symbols, definitions, and stable identity

A compiler usually needs stable symbol identities distinct from source spelling. A symbol may represent a local variable, type parameter, module, type constructor, trait, method, associated type, field, label, effect, capability, or generated compiler artifact.

Stable identities help incremental compilation, caching, cross-reference indexes, language-server rename, and serialized metadata. If symbol identity is path-based, package-based, or declaration-based, the module system must make that policy explicit; full package identity belongs in `MODULES.md`.

### 3.3. Scope graphs and query-oriented semantics

Scope-graph approaches represent binding structure as graph edges and resolve names through graph queries. Query-based compilers and language servers often memoize name-resolution and type-checking facts so that edits invalidate only affected facts.

This design is attractive for IDEs because it lets editor features ask for exactly the semantic fact needed at a cursor location instead of forcing whole-program analysis.

---

## 4. Core Type Representation

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

Type checking creates many equivalent type structures. Interning or hash-consing can make equality cheap and improve cache locality. Arena allocation can simplify lifetime management of semantic objects. These implementation techniques are adjacent to `COMPILERS.md` and `REPRESENTATIONS.md`, but type checkers place special pressure on them because unification and normalization may allocate heavily.

### 4.3. Error types and poison containment

A practical type checker should use explicit error types to continue checking after an error. The key is to avoid cascades: an unresolved name should not produce hundreds of unrelated type errors. Many compilers treat error types as compatible with anything for recovery, but diagnostics should remember the originating error so secondary messages can be suppressed or marked dependent.

---

## 5. Inference and Checking Algorithms

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

Dependently typed languages often elaborate terms with holes and open unification constraints. Idris elaborator reflection exposes a proof state with holes, goal types, incomplete proof terms, context, and open unification problems. Source: https://docs.idris-lang.org/en/latest/elaboratorReflection/tactics.html

Agda-related work on proof-relevant unification treats unifiers as equivalences between solution spaces, replacing ad hoc restrictions and making dependent pattern matching more soundly extensible. Source: https://jesper.sikanda.be/files/proof-relevant-unification.pdf

---

## 6. Polymorphism, Generics, and Reuse

### 6.1. Parametric polymorphism

Parametric polymorphism lets code work uniformly over types. A compiler can implement it by:

- monomorphization, generating specialized code per type instantiation;
- dictionary or witness passing, passing operations and metadata at runtime;
- uniform representation, boxing or using tagged values;
- reified generics, preserving type arguments in runtime metadata;
- hybrid specialization, compiling generic code but specializing hot or visible cases.

The type checker must decide which operations are valid on a type parameter. That usually means explicit bounds, type classes, traits, protocols, concepts, or structural constraints.

### 6.2. Type classes, traits, protocols, and concepts

Type classes and trait-like systems turn operations on type parameters into obligations solved by instance/implementation search. The compiler usually elaborates these obligations into dictionaries, witnesses, vtables, or statically selected methods.

Key design axes:

- global coherence versus local implicit search;
- orphan rules and package boundaries;
- associated types versus generic parameters;
- specialization and overlapping instances;
- negative reasoning and specialization;
- whether solving is syntax-directed, logic-programming-based, or ad hoc.

Chalk lowers Rust trait information into logical predicates and uses a solver similar to a Prolog engine, while remaining embeddable in hosts such as rustc and rust-analyzer. Source: https://rust-lang.github.io/chalk/book/

Rust's next-generation trait solver frames trait checking as proving goals under a parameter environment, returning success, ambiguity, or error plus constraints. Source: https://rustc-dev-guide.rust-lang.org/solve/trait-solving.html

### 6.3. Associated types and projection equality

Associated types attach type-level results to trait/protocol implementations. They improve abstraction but complicate equality because a projection such as `Iterator.Item` may not normalize until the implementing type is known.

Chalk models associated type normalization with predicates such as normalization and alias equality; unification involving projections may produce subgoals rather than immediately deciding equality. Source: https://rust-lang.github.io/chalk/book/clauses/type_equality.html

### 6.4. Coherence and ambiguity

Coherence means the same overloaded expression has a unique meaning independent of compilation order or search strategy. Haskell, Rust, Swift, and Scala-like systems make different trade-offs around global uniqueness, associated types, implicits, and path-dependent typing.

A 2025 paper comparing type-class coherence in Swift, Rust, Scala, and Haskell notes that mainstream non-dependent systems often rely on coherence, while Scala-like dependent typing supports more flexible implicit resolution at the cost of intricate disambiguation policies. Source: https://arxiv.org/pdf/2502.20546

### 6.5. Variadic generics, const generics, and type-level computation

Modern generic systems increasingly include parameter packs, const or integer generics, type-level functions, conditional types, match types, and compile-time evaluation. These features blur the boundary between type checking and compile-time computation.

TypeScript conditional types select types based on assignability tests and can infer type variables within the checked type. Source: https://www.typescriptlang.org/docs/handbook/2/conditional-types.html

Swift's generics documentation tracks features such as parameter packs, noncopyable types, nonescapable types, and integer generic parameters. Source: https://download.swift.org/docs/assets/generics.pdf

### 6.6. Raku — Multi-Dispatch, Roles, Subsets, and Type Objects

Raku is a useful counterexample to the clean nominal-vs-structural and static-vs-dynamic dichotomies. It combines nominal classes, roles, subset constraints, coercion wrappers, type objects, and a powerful multi-dispatch system in one language. The result is not a minimal theoretical core but a broad practical design space for languages that want runtime reflection and expressive call semantics without giving up types entirely.

**Multi-dispatch** is central rather than ornamental. Candidate selection depends on arity, parameter types, names, and in some ambiguous cases declaration order, `where` clauses, or subset refinements. This makes dispatch part of the semantic model of routine calls, not merely an overload-resolution pre-pass. Source: https://docs.raku.org/language/functions

**Roles** act as shareable behavior fragments and also participate in type checks. **Subsets** wrap a base type with additional `where`-style constraints checked on assignment or call boundaries; the Raku docs explicitly describe them as an attempt toward gradual typing, though not a full gradual type system. **Type objects** and the MOP make types directly inspectable and extensible at runtime. Sources: https://docs.raku.org/language/typesystem and https://docs.raku.org/language/structures and https://docs.raku.org/language/mop

The design lesson is that a language can expose a very rich *runtime* type world — type objects, roles, coercions, subsets — without making all of it statically decidable. Raku is valuable evidence that the space between "plain dynamic" and "fully static" is much larger than most mainstream languages explore.

### 6.7. Haskell — Type Classes, GADTs, Type Families, and Linear Types in Production

Haskell, and especially GHC, is the strongest production example of a language where advanced type-system features accumulate over decades without collapsing into a wholly new language. The result is not a single elegant core visible to most users, but an extensible typed platform: type classes, multi-parameter classes, functional dependencies, GADTs, kind polymorphism, type families, arbitrary-rank polymorphism, roles, and linear types all coexist inside one compiler.

The important design lesson is architectural rather than aesthetic: once a language commits to an extension-oriented type checker, the implementation needs stable mechanisms for adding new forms of evidence, local assumptions, and defaulting restrictions without breaking existing code. GHC's user guide is useful not because it is minimal, but because it shows the cumulative shape of a production type system. Sources: https://downloads.haskell.org/ghc/latest/docs/html/users_guide/exts/typeclasses.html and https://haskell.org/ghc/docs/latest/html/users_guide/exts/gadt.html and https://haskell.org/ghc/docs/latest/html/users_guide/exts/type_families.html and https://www.haskell.org/ghc/docs/latest/html/users_guide/exts/types.html

A few concrete lessons stand out:

- **Type classes** scale from simple ad-hoc polymorphism to a large design space of class resolution rules, defaulting, and associated type-level computation.
- **GADTs** make pattern matching feed equalities back into type checking, but in practice require rigidity and local-generalization restrictions.
- **Type families** give open type-level computation, contrasting with closed ADT-style reasoning.
- **Linear types** show that even a lazy language can retrofit resource usage guarantees through arrow-level multiplicity.

### 6.8. OCaml — Value Restriction, Polymorphic Variants, and Practical ML Typing

OCaml is a crucial counterweight to Haskell. Where GHC often expands the type-level frontier, OCaml repeatedly chooses pragmatic boundaries that preserve predictable inference, compilation speed, and interoperability. Its design lessons include the **value restriction**, relaxed value restriction, polymorphic variants, GADTs, and a long-standing willingness to expose advanced features without requiring them for ordinary code.

The **value restriction** is especially important historically: it is the classic production answer to the interaction of let-polymorphism and effects. Rather than pretending unrestricted polymorphism plus mutation will remain simple, OCaml makes the restriction explicit and teaches programmers where annotations or eta-expansion are needed. Source: https://v2.ocaml.org/releases/5.0/htmlman/manual001.html

**Polymorphic variants** are equally valuable as a modularity lesson. They increase flexibility and support open composition, but the OCaml manual is candid that they weaken the discipline compared with ordinary variants and can require more explicit type annotation in library code. Source: https://ocaml.org/manual/polyvariant.html

For a new language, OCaml is the clearest example of a language that repeatedly prefers *manageable, explainable compromises* over maximal static expressiveness.

### 6.9. Idris 2 — Dependent Effects and Quantitative Type Theory

Idris and Idris 2 are especially valuable when the boundary between type systems and effects becomes blurry. The Idris Effects library and later Idris 2's Quantitative Type Theory show how a language can track not only what type a computation returns, but also which resources, protocol states, or capabilities are available before and after an effectful action.

Dependent effects let the availability or shape of an effect depend on runtime outcomes that are then discharged by pattern matching. This is especially powerful for protocol checking: opening a file can yield a different postcondition depending on success, and the type checker can force the program to account for both outcomes. Sources: https://docs.idris-lang.org/en/latest/effects/depeff.html and https://www.type-driven.org.uk/edwinb/papers/effects.pdf

Idris 2's Quantitative Type Theory adds multiplicities to binders, bringing linearity and erasure directly into the core type theory. The practical payoff is that type-level reasoning about resource use, protocol state, and even session-type-style concurrency can be expressed in one language rather than split across a type system and a separate effect discipline. Source: https://www.type-driven.org.uk/edwinb/papers/idris-qtt.pdf

### 6.10. Koka and Elm — Two Opposite Functional Design Lessons

Koka and Elm are both functional languages, but they represent opposite responses to the question "how much semantic structure should the type system expose?"

**Koka** pushes further into effect-aware typing. It tracks effect rows in function types, supports algebraic effects and handlers, and uses type-directed compilation strategies such as selective CPS based on those effect types. This is a reference point for languages that want types to explain not only values, but also control and side-effect behavior. Sources: https://www.microsoft.com/en-us/research/publication/koka-programming-with-row-polymorphic-effect-types/ and https://dl.acm.org/doi/10.1145/3009837.3009872 and https://koka-lang.github.io/koka/doc/

**Elm** goes the other direction: it deliberately restricts the language and runtime interface to preserve simplicity and operational predictability. Historically, Elm's type system ruled out certain higher-order signal constructions, and its task/effect architecture keeps asynchronous effects in a carefully controlled surface model. The lesson is that a type system can be valuable not only because it expresses more, but because it forbids forms that would make the runtime or programmer model too complex. Sources: https://elm-lang.org/assets/papers/concurrent-frp.pdf and https://github.com/elm/core/blob/master/src/Task.elm

---

## 7. Subtyping, Unions, Intersections, and Refinement

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

For a new language, refinement types can start as an optional verification layer rather than part of the core type checker. If they are part of the core, the language needs a policy for decidability, timeouts, trusted axioms, and reproducible builds.

---

## 8. Algebraic Data Types, Patterns, and Exhaustiveness

### 8.1. Algebraic data types

Algebraic data types combine products and sums. They make many invariants explicit and support pattern matching, exhaustiveness checking, serialization schemas, and compiler optimizations.

The type checker should track constructor result types, field types, visibility, generic parameters, and whether constructors are closed or extensible across modules.

### 8.2. GADTs and equality assumptions

Generalized algebraic data types allow constructors to return refined instantiations of a type constructor. Pattern matching on a GADT introduces local type equalities, which must be available while checking the branch.

GADTs are powerful for typed embedded languages, length-indexed data, state machines, and proof-carrying APIs, but they require careful inference design to avoid ambiguous or unsound conclusions.

OutsideIn(X) and bidirectional systems are both important reference points for GADT implementation. Sources: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/jfp-outsidein.pdf and https://dl.acm.org/doi/fullHtml/10.1145/3450952

### 8.3. Exhaustiveness and usefulness checking

Pattern-match diagnostics ask two questions:

- exhaustiveness: can some value reach no branch?
- usefulness: can a branch ever match anything not matched earlier?

Maranget's algorithm for ML-style pattern-matching warnings detects useless clauses and non-exhaustive matches and can produce witness patterns for missing cases. Source: http://moscova.inria.fr/~maranget/papers/warn/index.html

Modern languages complicate this with guards, GADTs, view patterns, union types, path-dependent types, and open variants. GHC-related work handles GADTs, guards, and laziness in a unified framework; Scala-oriented work abstracts the type-system-specific part as spaces. Sources: https://dl.acm.org/doi/10.1145/2784731.2784748 and https://infoscience.epfl.ch/nanna/record/225497/files/p61-liu.pdf?withWatermark=0&withMetadata=0&version=1&registerDownload=1

---

## 9. Rows, Records, Variants, and Extensibility

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

Sources: https://web.cecs.pdx.edu/~mpj/pubs/96-3.pdf and https://caml.inria.fr/pub/papers/garrigue-polymorphic_variants-ml98.pdf

### 9.2. Structural records versus nominal records

Structural records make shape the interface. Nominal records make declaration identity the interface. Structural systems favor ad hoc composition and data interchange; nominal systems favor explicit API boundaries and evolution control.

A language can mix both by using nominal declarations for public types and structural row types for local records, anonymous objects, effects, or pattern matching.

### 9.3. Extensible variants and open errors

Extensible variants allow adding cases without modifying a central type definition. This is useful for plugin systems, typed errors, extensible interpreters, and modular effect encodings. The trade-off is that exhaustiveness becomes local unless the row is known to be closed.

### 9.4. Concatenative and Stack-Effect Type Systems — Forth, StrongForth, and Factor

Concatenative languages suggest a different path for type-system design: rather than starting from variable-binding terms and assigning them ordinary function types, they often start from **stack effects**. A word is described by what it consumes from and produces onto the stack. This can be treated as mere documentation, as in traditional Forth, or elevated into a static semantic discipline.

Peter Knaggs' work on **type inference in stack-based languages** formalizes stack-language typing as an algebra over type signatures, explicitly motivated by Forth. The key point is that composition in a concatenative language induces composition of stack effects, so effect inference can proceed structurally over the program text. Source: https://dl.acm.org/doi/10.1007/BF01212404

**StrongForth** is the clearest production-style proof that a Forth-like language can support strong static checking without runtime type tags. The compiler tracks the types of items on a compile-time model of the data stack, rejects words whose stack effects do not match, checks branch and loop consistency, and even allows overloads distinguished by stack parameter types. Sources: https://www.stephan-becher.de/strongforth/ and https://www.stephan-becher.de/strongforth/intro.htm

**Factor** takes a more selective route. Factor is dynamically typed overall, but its optimizing compiler enforces declared stack effects through a **stack checker**. For higher-order combinators that accept quotations, Factor adds **row-polymorphic stack effect variables** such as `..a`, letting quotations talk about "the rest of the stack" in a typed way. This is a useful design point for languages that want static protocol checking over pipelines or combinators without requiring a fully static runtime type system. Sources: https://factorcode.org/littledan/dls.pdf and https://docs.factorcode.org/content/article-inference.html and https://docs.factorcode.org/content/article-effects-variables.html

A 2017 thesis on an **optional, pluggable type system for Forth** adds another valuable lesson: the rigor of stack-language checking can itself be configurable, ranging from stack-underflow checking to stronger static consistency, with support for multiple stack effects, higher-order programming, and assertions/casts. This is a strong reference for gradual or tool-assisted semantics in low-ceremony languages. Source: https://repositum.tuwien.at/handle/20.500.12708/7117

---

## 10. Dependent Types, Elaboration, Holes, and Tactics

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

Elaborator reflection exposes parts of the elaboration engine to user code. Idris and Lean show how tactics can construct terms, inspect goals, and manipulate proof states.

Idris documentation describes elaboration as desugaring surface Idris into a smaller TT core, with holes and guesses that elaboration programs can control. Source: https://docs.idris-lang.org/en/latest/elaboratorReflection/elabReflection.html

Lean's metaprogramming framework exposes APIs to internal structures and tactic state, enabling tactics to synthesize expressions. Source: https://lean-lang.org/papers/tactic.pdf

### 10.4. Kernel versus elaborator split

A small kernel gives a compact trusted base, while the elaborator can be large, heuristic, and user-extensible. This split is valuable even outside proof assistants: a new language can elaborate a rich surface into a simpler typed core and check that core with a smaller algorithm.

---

## 11. Effect Systems and Capability Typing

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

Koka tracks side effects in function types and supports effect handlers as a typed, composable mechanism. Sources: https://github.com/koka-lang/koka/ and https://koka-lang.github.io/koka/doc/

Flix describes a type and effect system with primitive effects, algebraic effects, heap effects, effect polymorphism, sub-effecting, effect exclusion, purity reflection, and associated effects. Source: https://doc.flix.dev/effect-system.html

Unison uses abilities and ability handlers; a function type may require an ability set, and handlers provide abilities in scope. Source: https://unison-lang.org/docs/language-reference/abilities-and-ability-handlers

OCaml 5 exposes effect handlers through the runtime-level `Effect` module, but its manual notes that they do not provide static effect safety and are experimental in the documented version. Source: https://ocaml.org/manual/5.2/effects.html

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

---

## 12. Linear, Affine, Ownership, and Resource Types

Full memory-management treatment belongs in `MEMORY.md`, but type-checker machinery for resource usage belongs here.

### 12.1. Linear and affine types

Linear types require exactly-one use; affine types allow at-most-one use. They can encode resource protocols, file handles, unique buffers, session-like APIs, and memory management without runtime tracing.

Linear Haskell attaches linearity to function arrows to integrate with an existing higher-order polymorphic language and support code reuse between linear and non-linear contexts. Source: https://dl.acm.org/doi/10.1145/3158093

The GHC linear types proposal contrasts linearity with uniqueness and notes that Clean and Rust use uniqueness/ownership-like approaches. Source: https://ghc-proposals.readthedocs.io/en/latest/proposals/0111-linear-types.html

### 12.2. Ownership, borrowing, and lifetimes as type constraints

Ownership systems track who may destroy, move, alias, or mutate a value. Borrowing systems introduce references whose validity depends on lifetime constraints. The checker must reason about moves, partial moves, reborrows, variance, aliasing, and destructor timing.

Full Rust, Vale, Austral, Swift, Mojo, Hylo, and related memory-safety details belong in `MEMORY.md`; this document cares about the checker architecture: resource variables, use counts, lifetime regions, effectful drops, and diagnostics.

### 12.3. Typestate and protocol checking

Typestate tracks state transitions in the type of a value: open versus closed file, initialized versus uninitialized object, authenticated versus anonymous connection. It can be encoded with linear types, phantom types, session types, or dependent indices.

A practical design should decide whether typestate is a library pattern or a first-class checker feature.

---

## 13. Semantic Analysis for Tooling and Incrementality

### 13.1. Typed syntax and semantic models

A compiler can expose semantic information as typed syntax trees, symbol graphs, query results, or an API over compiler internals. IDE features need stable mappings between syntax nodes and semantic objects.

The Go language server `gopls` stores sessions, folders, views, snapshots, overlays, caches, packages, type-checking results, and serializable indexes for references and method sets. Source: https://go.googlesource.com/tools/+/refs/heads/master/gopls/doc/design/implementation.md

Rust-analyzer emphasizes that a performant language server avoids analysis unless necessary and needs bidirectional mapping between syntax and semantic elements for features like refactoring. Source: https://rust-analyzer.github.io/blog/2023/12/26/the-heart-of-a-language-server.html

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

| Technique family | Best for | Main implementation burden | Main trade-off |
|---|---|---|---|
| Explicit simple static types | Small compilers, predictable diagnostics | Annotation parsing and checking | Higher annotation burden |
| Hindley-Milner inference | ML-style functional cores | Unification, generalization, value restriction | Harder with subtyping/effects/GADTs |
| Bidirectional typing | Expressive languages with partial inference | Mode discipline and expected-type propagation | Requires annotations at boundaries |
| Constraint solving | Many interacting features | Constraint origins, solver architecture | Diagnostics can become indirect |
| Nominal subtyping | OO APIs and stable libraries | Declaration graph and variance | Less ad hoc flexibility |
| Structural typing | Records, objects, JavaScript-like shapes | Recursive comparison and caching | Potentially weaker API boundaries |
| Type classes / traits | Bounded generics and overloading | Instance search, coherence, evidence | Ambiguity and compile-time cost |
| Associated types | Abstract families of related types | Projection equality and normalization | Harder inference and errors |
| Row polymorphism | Extensible records, variants, effects | Row unification and layout policy | Complex messages and ABI questions |
| Union/intersection types | Dynamic-language migration, narrowing | Subtyping lattice and flow analysis | Can be expensive and unsound if pragmatic |
| Gradual typing | Migration from dynamic code | Runtime casts/contracts and blame | Runtime overhead and boundary complexity |
| Refinement types | Strong invariants over values | SMT integration and decidability policy | Solver unpredictability |
| Dependent types | Proofs and precise invariants | Elaborator, holes, unification, kernel | High implementation complexity |
| Effect systems | Purity, capabilities, checked effects | Effect rows/sets and handler typing | Annotation and inference complexity |
| Linear/affine types | Resources and protocols | Use-counting and move analysis | Ergonomic friction |
| Exhaustiveness checking | Pattern-match safety | Pattern matrix or space algorithms | Hard with open/extensible types |
| Incremental semantic analysis | IDEs and fast rebuilds | Query dependency graph and stable IDs | Architecture complexity |

---

## 16. Design Implications for a New Language

1. Start with a small typed core even if the surface language is rich. A compact internal calculus makes elaboration, testing, and diagnostics easier.
2. Decide early whether the language values principal inference, bidirectional local inference, or explicitness. This choice shapes syntax and user expectations.
3. Treat name resolution and type checking as reusable services, not only compiler passes.
4. Preserve source origins for every semantic fact and constraint.
5. If traits/type classes/protocols exist, design coherence and ambiguity rules before users depend on edge cases.
6. If effects or capabilities are part of the design, decide whether they are checked, inferred, dynamically handled, or merely documented.
7. If ownership or linearity exists, keep the memory-safety model in `MEMORY.md` but document the checker mechanics here.
8. Avoid exposing internal type normal forms directly in diagnostics.
9. Make typed holes and partial programs first-class if IDE quality matters.
10. Keep the type checker deterministic: diagnostics, inferred types, and selected instances should not depend on hash iteration order or filesystem traversal order.

---

## 17. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Scope and Design Axes

- Typed Racket Guide — Occurrence Typing: https://docs.racket-lang.org/ts-guide/occurrence-typing.html
- Migratory Typing: Ten Years Later / Typed Racket: https://www2.ccs.neu.edu/racket/pubs/typed-racket.pdf
- TypeScript Handbook — Type Compatibility: https://www.typescriptlang.org/docs/handbook/type-compatibility.html
- TypeScript Handbook — Narrowing: https://www.typescriptlang.org/docs/handbook/2/narrowing.html
- Scala 3 / Dotty Type System Internals: https://dotty.epfl.ch/docs/internals/type-system.html
- Scaling DOT to Scala — Soundness: https://scala-lang.org/blog/2016/02/17/scaling-dot-soundness.html
- A path to DOT: formalizing fully path-dependent types: https://dl.acm.org/doi/10.1145/3360571

### Chapter 2 — Historical Through-Line, 1960–2026

- Historical survey of types and programming languages: https://arxiv.org/pdf/1510.03726
- Cardelli, Type Systems: https://web.eecs.umich.edu/~weimerw/2012-4610/reading/Cardelli_TypeSystems.pdf
- The History of Standard ML: https://smlfamily.github.io/history/SML-history.pdf
- Damas and Milner, Principal type-schemes for functional programs: https://www.cs.cmu.edu/~crary/819-f09/DamasMilner82.pdf
- OutsideIn(X): Modular type inference with local assumptions: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/jfp-outsidein.pdf
- Dunfield and Krishnaswami, Bidirectional Typing: https://dl.acm.org/doi/fullHtml/10.1145/3450952
- Lean elaboration algorithm: https://leodemoura.github.io/files/elaboration.pdf
- Koka repository: https://github.com/koka-lang/koka/
- Swift generics documentation: https://download.swift.org/docs/assets/generics.pdf
- Rustc dev guide — Chalk-based trait solving: https://rustc-dev-guide.rust-lang.org/traits/chalk.html

### Chapter 3 — Name Resolution, Scopes, and Semantic Binding

- Modularizing GHC: https://hsyl20.fr/home/files/papers/2022-ghc-modularity.pdf
- Rust-analyzer, The Heart of a Language Server: https://rust-analyzer.github.io/blog/2023/12/26/the-heart-of-a-language-server.html
- Gopls implementation design: https://go.googlesource.com/tools/+/refs/heads/master/gopls/doc/design/implementation.md

### Chapter 4 — Core Type Representation

- Scala 3 Types.scala and type-system internals: https://github.com/scala/scala3/blob/main/compiler/src/dotty/tools/dotc/core/Types.scala and https://dotty.epfl.ch/docs/internals/type-system.html

### Chapter 5 — Inference and Checking Algorithms

- Damas and Milner: https://www.cs.cmu.edu/~crary/819-f09/DamasMilner82.pdf
- The History of Standard ML: https://smlfamily.github.io/history/SML-history.pdf
- OutsideIn(X): https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/jfp-outsidein.pdf
- Dunfield and Krishnaswami, Bidirectional Typing: https://dl.acm.org/doi/fullHtml/10.1145/3450952
- Christiansen, Bidirectional Typing tutorial: https://davidchristiansen.dk/tutorials/bidirectional.pdf
- Pierce and Turner, Local Type Inference: https://www.cis.upenn.edu/~bcpierce/papers/lti-toplas.pdf
- Idris elaborator reflection tactics: https://docs.idris-lang.org/en/latest/elaboratorReflection/tactics.html
- Proof-relevant unification: https://jesper.sikanda.be/files/proof-relevant-unification.pdf

### Chapter 6 — Polymorphism, Generics, and Reuse

- Chalk book: https://rust-lang.github.io/chalk/book/
- Chalk type equality and unification: https://rust-lang.github.io/chalk/book/clauses/type_equality.html
- Rustc dev guide — next-generation trait solving: https://rustc-dev-guide.rust-lang.org/solve/trait-solving.html
- Swift generics documentation: https://download.swift.org/docs/assets/generics.pdf
- TypeScript conditional types: https://www.typescriptlang.org/docs/handbook/2/conditional-types.html
- Type-class coherence comparison: https://arxiv.org/pdf/2502.20546
- Raku functions and multi-dispatch: https://docs.raku.org/language/functions
- Raku type system: https://docs.raku.org/language/typesystem
- Raku structures and subsets: https://docs.raku.org/language/structures
- Raku metaobject protocol: https://docs.raku.org/language/mop
- GHC type classes: https://downloads.haskell.org/ghc/latest/docs/html/users_guide/exts/typeclasses.html
- GHC GADTs: https://haskell.org/ghc/docs/latest/html/users_guide/exts/gadt.html
- GHC type families: https://haskell.org/ghc/docs/latest/html/users_guide/exts/type_families.html
- GHC type extensions overview: https://www.haskell.org/ghc/docs/latest/html/users_guide/exts/types.html
- OCaml manual overview: https://v2.ocaml.org/releases/5.0/htmlman/manual001.html
- OCaml polymorphic variants: https://ocaml.org/manual/polyvariant.html
- Idris dependent effects: https://docs.idris-lang.org/en/latest/effects/depeff.html
- Brady, Programming and reasoning with algebraic effects and dependent types: https://www.type-driven.org.uk/edwinb/papers/effects.pdf
- Idris 2 QTT: https://www.type-driven.org.uk/edwinb/papers/idris-qtt.pdf
- Koka row-polymorphic effect types: https://www.microsoft.com/en-us/research/publication/koka-programming-with-row-polymorphic-effect-types/
- Koka type-directed compilation of row-typed algebraic effects: https://dl.acm.org/doi/10.1145/3009837.3009872
- Koka documentation: https://koka-lang.github.io/koka/doc/
- Elm concurrent FRP thesis: https://elm-lang.org/assets/papers/concurrent-frp.pdf
- Elm Task implementation: https://github.com/elm/core/blob/master/src/Task.elm

### Chapter 7 — Subtyping, Unions, Intersections, and Refinement

- TypeScript Handbook — Type Compatibility: https://www.typescriptlang.org/docs/handbook/type-compatibility.html
- TypeScript Handbook — Narrowing: https://www.typescriptlang.org/docs/handbook/2/narrowing.html
- Typed Racket occurrence typing: https://docs.racket-lang.org/ts-guide/occurrence-typing.html
- Occurrence typing modulo theories: https://dl.acm.org/doi/10.1145/2908080.2908091

### Chapter 8 — Algebraic Data Types, Patterns, and Exhaustiveness

- Maranget, Warnings for pattern matching: http://moscova.inria.fr/~maranget/papers/warn/index.html
- GADTs meet their match: https://dl.acm.org/doi/10.1145/2784731.2784748
- Generic exhaustivity checking with spaces: https://infoscience.epfl.ch/nanna/record/225497/files/p61-liu.pdf?withWatermark=0&withMetadata=0&version=1&registerDownload=1

### Chapter 9 — Rows, Records, Variants, and Extensibility

- Gaster and Jones, A Polymorphic Type System for Extensible Records and Variants: https://web.cecs.pdx.edu/~mpj/pubs/96-3.pdf
- Garrigue, Programming with Polymorphic Variants: https://caml.inria.fr/pub/papers/garrigue-polymorphic_variants-ml98.pdf
- Abstracting extensible data types: https://dl.acm.org/doi/10.1145/3290325
- Gradual typing for row types: https://arxiv.org/pdf/1910.08480
- Knaggs, Type inference in stack based languages: https://dl.acm.org/doi/10.1007/BF01212404
- StrongForth homepage and introduction: https://www.stephan-becher.de/strongforth/ and https://www.stephan-becher.de/strongforth/intro.htm
- Factor stack checker and stack effect row variables: https://docs.factorcode.org/content/article-inference.html and https://docs.factorcode.org/content/article-effects-variables.html
- Factor paper on stack effects and row polymorphism: https://factorcode.org/littledan/dls.pdf
- Optional, pluggable typing for Forth: https://repositum.tuwien.at/handle/20.500.12708/7117

### Chapter 10 — Dependent Types, Elaboration, Holes, and Tactics

- Lean elaboration algorithm: https://leodemoura.github.io/files/elaboration.pdf
- Lean metaprogramming framework: https://lean-lang.org/papers/tactic.pdf
- Idris elaborator reflection: https://docs.idris-lang.org/en/latest/elaboratorReflection/elabReflection.html
- Idris tactics and proof state: https://docs.idris-lang.org/en/latest/elaboratorReflection/tactics.html
- Elaborator reflection paper: https://davidchristiansen.dk/pubs/elab-reflection.pdf
- Proof-relevant unification: https://jesper.sikanda.be/files/proof-relevant-unification.pdf
- Elaborating dependent copattern matching: https://jesper.sikanda.be/files/elaborating-dependent-copattern-matching.pdf

### Chapter 11 — Effect Systems and Capability Typing

- Koka repository: https://github.com/koka-lang/koka/
- Koka documentation: https://koka-lang.github.io/koka/doc/
- Flix effect system: https://doc.flix.dev/effect-system.html
- Flix effects and handlers: https://doc.flix.dev/effects-and-handlers.html
- Unison abilities and handlers: https://unison-lang.org/docs/language-reference/abilities-and-ability-handlers
- OCaml 5 effect handlers manual: https://ocaml.org/manual/5.2/effects.html
- Eff language repository: https://github.com/matijapretnar/eff/

### Chapter 12 — Linear, Affine, Ownership, and Resource Types

- GHC proposal — Linear Types: https://ghc-proposals.readthedocs.io/en/latest/proposals/0111-linear-types.html
- Linear Haskell: practical linearity in a higher-order polymorphic language: https://dl.acm.org/doi/10.1145/3158093
- Linearity and Uniqueness: An Entente Cordiale: https://link.springer.com/chapter/10.1007/978-3-030-99336-8_13
- Austral linear types: https://austral-lang.org/linear-types
- Vale linear-aliasing model: https://vale.dev/linear-aliasing-model

### Chapter 13 — Semantic Analysis for Tooling and Incrementality

- Gopls implementation design: https://go.googlesource.com/tools/+/refs/heads/master/gopls/doc/design/implementation.md
- Rust-analyzer, The Heart of a Language Server: https://rust-analyzer.github.io/blog/2023/12/26/the-heart-of-a-language-server.html
- Modularizing GHC: https://hsyl20.fr/home/files/papers/2022-ghc-modularity.pdf
