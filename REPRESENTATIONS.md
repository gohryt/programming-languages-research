# Representations

Research on the data structures and encodings used to represent programs internally — concrete syntax trees, abstract syntax trees, source-adjacent IRs, mid-level IRs, SSA forms, CPS/ANF, e-graphs, bytecode, multi-level IR architectures, effect-/region-/capability-annotated IRs, persistent and content-addressed IRs, domain-specific representations, Forth-style direct representations, and target-adjacent IRs.

This document treats each representation as an artifact in its own right: the design pressures behind its data layout, what it makes cheap, what it makes expensive, and where it sits in the language's compilation pipeline. Parser-side AST layout (Cuik postfix, Zig token-indexing, red-green construction) is in `PARSERS.md §3`, where the framing is parse-time data flow. IR-as-optimization-substrate (CPS/ANF/SSA correspondence, MLIR dialects, instruction-selection DSLs, Turboshaft, Mojo POP) is in `COMPILERS.md §6` and §1.4, where the framing is the transformation passes that consume each form. This document picks up the broader survey those two leave: lossless trees as a tooling substrate, the bytecode family as a portability target, e-graphs as equality-saturating representations, content-addressed code, and the named mid-level IRs (Rust MIR, Zig ZIR/AIR, Google JSIR, Mojo KGEN/POP, Ballerina BIR) treated at greater length. The unifying axis across chapters is *what the representation is for*: source fidelity, optimization, portability, abstraction layering, security analysis, or storage identity.

Cross-references into this document live in `PARSERS.md §3` (parser-side AST layouts) and `COMPILERS.md §6` (IRs beyond SSA), with both chapters keeping their existing entries and adding pointers here for the broader survey.

---

## 1. Scope and Design Axes

This chapter names the recurring axes along which representations differ. None of these axes is binary in practice — almost every real representation makes a different trade-off on each — but separating them clarifies what each later entry is optimizing for. The axes are not ordered by importance; they are ordered by how visible the trade-off becomes at the source level.

### 1.1. Tree vs Graph

A program can be represented as a tree (one parent per node, no shared substructures) or as a graph (multiple parents allowed, sharing or cycles possible). Trees are easier to traverse, serialize, and reason about structurally — every traversal terminates, and every node has a unique path from the root. Graphs allow shared subexpressions (hash consing), cyclic dependency representations (def-use chains in SSA), and richer structural identities, at the cost of needing visitor logic that handles repeated visits.

The classical pipeline trees-then-graphs reflects this: parsers emit trees (ASTs are usually trees), and middle-end IRs convert to graphs (SSA def-use chains, sea-of-nodes, e-graphs). Some representations sit in the middle: rowan's red-green trees (§2.2) are trees in the green layer but allow structural sharing of identical subtrees as a storage policy.

### 1.2. Mutable vs Immutable

A mutable representation is updated in place by transformation passes; an immutable one is rebuilt as a new value each time it changes. Mutable IRs (LLVM IR, GCC GIMPLE, V8 TurboFan) optimize for in-pass throughput — passes can rewrite instructions, replace operands, and fold subgraphs without allocating new nodes. Immutable IRs (Roslyn green nodes, Lean 4 persistent arrays, Salsa memoized values) optimize for incrementality, equality-by-identity, and concurrent access — the same value can be shared across compilation queries without locking.

The trade-off is real: mutable IRs are faster for throughput-oriented batch compilation; immutable IRs are nearly mandatory for query-based incremental compilers (`COMPILERS.md §18`) and content-addressed systems (§12 here).

### 1.3. Pointer-Rich vs Flat-Arena

A pointer-rich representation links nodes by heap pointers — every parent holds child pointers, every traversal dereferences. A flat-arena representation stores nodes in contiguous arrays and links by indices into those arrays; child references become `u32` offsets, not 64-bit pointers. Flat-arena designs (Cuik postfix, Zig token-indexed, struct-of-arrays AST in `PARSERS.md §3.3`) halve memory footprint, improve cache locality, and make serialization trivial — at the cost of traversal indirection through an arena base pointer and the need for explicit lifetime management of the arena.

The choice is most consequential for ASTs, where node counts run into millions on large codebases. SSA IRs are pointer-rich more often because the optimizer needs to reroute references frequently; an arena layout would force more rewrite work.

### 1.4. Typed vs Untyped

A typed representation carries enough information for the type of every value/operand to be checked or inferred. LLVM IR is typed (every value has an `i32`, `i64`, `<4 x float>`, etc.); WebAssembly is typed; JVM bytecode is typed at instruction granularity. An untyped representation leaves type information to side metadata or doesn't track it — Forth's data stack is untyped, raw assembly is untyped, dynamic-language bytecodes are partly typed (CPython tracks reference cells but not the underlying values).

Typed representations enable verification (Wasm validation, JVM bytecode verification), aggressive optimization (LLVM's type-based alias analysis), and better tooling. Untyped representations are simpler and more flexible but push verification and analysis cost onto consumers.

### 1.5. Single-Level vs Multi-Level

A single-level representation has one IR — LLVM IR (mostly), Cranelift CLIF, LuaJIT IR. A multi-level representation is a *cascade* of progressively-lowered IRs, each tuned to a phase: Rust's HIR → THIR → MIR → LLVM IR (§10.3), GHC's Core → STG → Cmm (§10.4), Mojo's KGEN parametric layer → POP dialect → LLVM dialect (§5.4). MLIR (§10.1) industrialized this pattern with first-class dialects that can coexist in one module and lower progressively.

The trade-off is engineering simplicity vs per-phase optimality. A single-level IR has one set of passes, one set of analyses, one printer. A multi-level cascade lets each level be tuned to what its consumers need (HIR for type inference, THIR for pattern-match exhaustiveness, MIR for borrow checking) at the cost of translation layers between them.

### 1.6. Source-Faithful vs Lowered

A source-faithful representation preserves features visible in the source: comments, whitespace, original control structures (`if`/`while`/`for` rather than CFG jumps), parenthesization, original variable names. A lowered representation discards these for analysis convenience: scopes flatten into linear blocks, structured control becomes branches, names become numeric identifiers.

The dichotomy is design-meaningful because some tools require fidelity. Source-to-source transformers (refactoring tools, formatters, deobfuscators) must round-trip back to readable source — Roslyn (§2.1), rowan (§2.2), SwiftSyntax (§2.3), and Google JSIR (§5.10) all preserve enough information for this. Optimizers can discard fidelity for analysis power. Hybrid designs (Hermes HIR, Mojo KGEN, JSIR's `jshir` dialect) preserve some structure for specific phases while still admitting lowering.

### 1.7. Persistent vs Ephemeral

A persistent representation lives across compilation sessions: stored on disk, content-addressed, queryable later. Unison's hashed AST (§12.1) is the extreme case — code identity is the hash, not a name. Salsa's memoized values (§12.2) persist across queries within a single rust-analyzer session. Lean 4's persistent arrays (§12.3) survive across elaborator invocations. An ephemeral representation lives only during one compilation pass — most LLVM IR uses are like this.

Persistence enables incremental compilation, distributed builds, content-addressed sharing, and reproducibility. The cost is that every IR change must be considered as a schema migration; persistent IRs cannot be reorganized as freely as in-memory ones.

---

## 2. Concrete Syntax Trees and Lossless Representations

A concrete syntax tree (CST) preserves every token, every comment, every piece of trivia from the source. Lossless trees take this further: byte-exact round-tripping is a guarantee, not a hope. The chapter's distinguishing axis is *what mechanism enforces the lossless property*: structural sharing of immutable green nodes (Roslyn, rowan), full-fidelity byte-level retention (SwiftSyntax), or schema-derived APIs that make trivia a first-class field on every node (ASDL, ungrammar). All entries serve tooling — refactoring, formatting, IDE navigation, code generation — where fidelity to the original source is mandatory and any lossy detail is a bug.

### 2.1. Roslyn Red-Green Trees (C#)

C# and VB.NET's compiler API uses a two-layer tree: immutable, position-free **green nodes** that store kind + width + child references, and ephemeral **red nodes** that wrap green nodes with absolute text positions and parent pointers computed lazily on demand. Editing produces a new green tree that shares unchanged subtrees with the old one — an O(edit-size) update rather than O(file-size). The red tree is rebuilt on each navigation but cheap because it caches over the underlying green structure.

The original contribution is treating *width-only* nodes as the storage representation. Most position-aware ASTs store absolute offsets per node, paying for them on every edit. Roslyn pays for absolute positions only when the user navigates, and even then only for the path actually visited. This is why Roslyn supports massive solutions (~1M-line solutions in Visual Studio) with sub-second incremental responses.

Source: https://ericlippert.com/2012/06/08/red-green-trees/ and https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-syntax

### 2.2. rust-analyzer rowan

rowan is the Rust port of Roslyn's red-green design, used by rust-analyzer and a growing number of language servers (Lelwel, Typst's parser, several research projects). Same green/red split, same incremental properties. Distinctive additions: green nodes are interned by hash, so identical subtrees across a workspace share storage; rowan's `SyntaxNode` is a thin handle (~16 bytes) rather than a full red-tree allocation; and trivia (comments, whitespace) is attached to tokens rather than synthesized as separate nodes, simplifying the API.

rowan is also content-agnostic: the language-specific node kind enum is supplied by the consumer. The same library powers Rust, Typst, Lelwel-generated grammars, and several DSL projects. This separation of concrete-syntax-tree mechanics from language-specific node types is what makes rowan a reusable lossless-tree library rather than a Rust-specific component.

Source: https://github.com/rust-analyzer/rowan and https://rust-analyzer.github.io/blog/2020/10/24/introducing-ungrammar.html

### 2.3. SwiftSyntax

Apple's SwiftSyntax is the official syntax library for Swift, modelled on Roslyn red-green but with explicit *byte-exact round-trip* as a first-party API guarantee. Every comment, every space, every token is preserved through the tree and re-serializable to the exact original bytes. This is stronger than rowan's default — rowan preserves trivia but byte-exactness depends on the printer.

The reason for the stronger guarantee: SwiftSyntax is the boundary for Swift macros (SE-0382, SE-0389, Swift 5.9+). A user-written macro receives a SwiftSyntax tree and returns one; compile then continues with the rewritten tree. If round-trip were lossy, every macro expansion would silently mangle source. The cost is that every macro plugin compiles a non-trivial SwiftSyntax dependency into its binary, which has been a recurring source of macro build-time complaints in Xcode.

Source: https://github.com/swiftlang/swift-syntax and https://github.com/swiftlang/swift-evolution/blob/main/proposals/0389-attached-macros.md

### 2.4. Lezer (CodeMirror 6)

Marijn Haverbeke's Lezer is the parser system for CodeMirror 6: incremental, error-tolerant, and producing a compact non-abstract syntax tree. Nodes store width and child structure rather than full JS object trees with parent pointers. A red-tree-like layer provides position-aware navigation when needed, but the on-disk/in-memory representation stays lean.

Lezer's distinctive design point is that it emits *binary buffer trees* — children are encoded as offsets into a flat `Uint16Array` rather than JavaScript objects. This is the JavaScript equivalent of a flat-arena AST (§3) plus the green-tree incrementality of Roslyn/rowan, in a representation small enough that 100k-line files stay performant in a browser.

Source: https://marijnhaverbeke.nl/blog/lezer.html

### 2.5. Tree-sitter Trees

Tree-sitter syntax trees are immutable, error-tolerant, and incremental — every edit produces a new tree that shares unchanged subtrees. Each node carries a byte range, a kind, and a parent pointer (computed lazily). The trees are designed to survive arbitrary syntactic invalidity: every state of an in-progress edit produces a valid tree, with `ERROR` and `MISSING` nodes filling in syntactic gaps.

Where Roslyn's green tree is position-free, tree-sitter's nodes store byte ranges directly — appropriate because tree-sitter's primary consumer is editor highlighting, where most queries ask "what is at byte offset X?" rather than "what is the third child of this node?" The trade-off favours navigation queries over edit-locality.

Source: https://tree-sitter.github.io/tree-sitter

### 2.6. Oil / OSH Lossless Syntax Tree

The Oil shell project explicitly migrated from a classical AST to a *lossless syntax tree*: every comment, every here-doc indent, every brace-expansion subtle lives in the tree. The motivating constraint is that a shell has to support both *execution* and *source-to-source tooling* (lint, format, refactor) from one parse, and shells are exactly the language where comments and whitespace carry semantic weight (heredoc terminators, line-continuation backslashes, IFS interactions).

Oil's tree is schema-defined in ASDL (§2.7), generating typed Python and C++ accessors from one specification. The lesson: when the language has interactions between trivia and semantics, fidelity must be a first-class design concern, not an afterthought.

Source: https://www.oilshell.org/blog/2017/02/11.html

### 2.7. ASDL — Abstract Syntax Description Language

ASDL (Wang, Appel, Korn, Serra; 1997) is a language for describing tree-shaped data with sums, products, and optional fields. From one ASDL file, generators emit typed Python, C, C++, ML, or Java accessors. CPython's `Python.asdl` defines the canonical Python AST shape; Oil/OSH derived its lossless tree from ASDL; SML/NJ used it internally; CompCert uses an ASDL-like spec for its IR languages.

The contribution that earns it a place here is *the schema as the ground truth*. Without a schema, every consumer of an AST has to reinvent its node taxonomy and carry its drift over time. With ASDL, the tree shape is one file — visitors, traversals, and serializers are generated from it. This is the same design philosophy as ungrammar (§3.7), but two decades older.

Source: https://www.cs.princeton.edu/research/techreps/TR-554-97 and https://docs.python.org/3/library/ast.html

---

## 3. Abstract Syntax Trees

ASTs discard trivia and minor syntactic detail in exchange for analysis-friendly structure. The chapter's distinguishing axis is *node layout strategy*: postfix-encoded (Cuik), token-indexed (Zig), arena+offset (HN-style C parsers), tagged-union (Rust/OCaml ADTs), class-hierarchy (Java compiler), schema-generated (ESTree, ungrammar, ASDL — covered in §2.7), or first-class language objects (RakuAST). Each layout makes a different trade between memory footprint, traversal cost, and serializability. The summary at `PARSERS.md §3` covers these from the parser-output angle; this chapter takes the representation-itself angle.

### 3.1. Cuik Postfix-Encoded Expressions

Cuik (RealNeGate) stores expression trees as a flat `Subexpr` array in reverse-Polish order. Child references are *implicit from position*, not explicit pointers — to traverse, walk the array right-to-left. From the project documentation: "to represent a metric shitload of expressions in Cuik we compact them using a postfix notation. Instead of using pointers to refer to inputs it's implicit."

Trade-offs: excellent cache locality (sequential access), no per-node pointer overhead, trivial serialization. Random access to a specific subexpression requires walking from the start, which is acceptable for a compiler that processes expressions sequentially during evaluation or codegen. Statement-level structure still uses a more conventional representation; only expression interiors are postfix.

Source: https://github.com/RealNeGate/Cuik

### 3.2. Zig Token-Indexed AST

Zig's AST stores token indices, not byte offsets. Each AST node references its source position via a `TokenIndex` into the parser's token list; tokens themselves carry only their start byte offset. To recover line/column for diagnostics, the compiler dereferences the token, then dereferences the source manager.

Layout is struct-of-arrays via `std.MultiArrayList`: parallel arrays of `tag`, `data`, `main_token` rather than an array of structs. Cache locality on whole-AST traversals (e.g., "list every function declaration") is excellent. Once ZIR is generated (§5.2), the AST and token list can be discarded — the AST is genuinely a parser output, not a long-lived compiler artifact.

Source: https://github.com/ziglang/zig/tree/master/lib/std/zig

### 3.3. Arena + Offset ASTs

A common pattern in C and Rust parsers: allocate AST nodes from a bump arena, refer to children by 32-bit offsets into the arena rather than pointers. Offsets halve the per-edge cost vs 64-bit pointers, eliminate per-node free overhead (the whole arena is freed at once), and make serialization trivial. The Rust `bumpalo` crate is the canonical implementation in that ecosystem; many hand-written C parsers use the same pattern with `mmap`-backed arenas.

This is `COMPILERS.md §2.1` from the language-side; here it's worth naming as a representation choice. Many compilers' "AST" is structurally an arena + an entry point — there is no separate AST type at all.

Source: https://docs.rs/bumpalo/

### 3.4. Tagged-Union ASTs (Rust enums, OCaml ADTs)

Algebraic data types — Rust `enum`, OCaml variant types, Haskell sum types — give ASTs a natural representation: one variant per syntactic category. Rust's `syn` crate is the canonical example: every Rust syntactic form has a corresponding `syn::*` enum variant, and pattern matching exhaustively over the enum is checked by the compiler.

The trade-off: tagged unions store a discriminant per node (typically 1 byte plus padding for alignment, often 8 bytes total in practice). For ASTs with many variants, the wasted padding can be substantial. The win is that every pattern match is exhaustive by construction, and the compiler refuses to compile until every case is handled — refactor safety that no class hierarchy or schema can match.

Source: https://github.com/dtolnay/syn

### 3.5. Class-Hierarchy ASTs (Java javac, Roslyn red layer)

In OO languages, ASTs are commonly modelled as class hierarchies: `Node` base class, subclasses for `BinaryExpr`, `IfStmt`, etc. The visitor pattern handles traversals. The advantage is open extensibility — adding a new node type is adding a new subclass — and the traditional fit with object-oriented languages.

The cost is that exhaustiveness is no longer compiler-enforced (a visitor that misses a subclass falls through to the default case), and dynamic dispatch on every traversal step has measurable overhead at scale. Modern OO-compilers (Roslyn, IntelliJ's PSI) compensate with sealed class hierarchies, the "expression problem" workarounds, or generated visitor code.

Source: https://docs.oracle.com/javase/specs/jls/se21/html/

### 3.6. ESTree (JavaScript)

ESTree is the de-facto AST schema for JavaScript tooling. Originally from Mozilla's SpiderMonkey JS reflection API, now maintained as a standalone spec used by ESLint, Prettier, Babel, Acorn, and most JS tools. Each node is a plain JavaScript object with a `type` property and category-specific fields; no class hierarchy, no tagged enum — just JSON-shaped data.

The trade-off is that nothing enforces schema conformance — every consumer trusts that `node.type === "BinaryExpression"` implies the expected shape. Babel's plugin system layers a dynamic type-check on top, but the underlying ESTree spec is untyped JSON. The pragmatic upside is portability: ESTree trees serialize trivially to JSON, are easy to diff, and any JSON-aware tool can manipulate them.

Source: https://github.com/estree/estree

### 3.7. ungrammar — CST Schema Without a Parser

rust-analyzer's ungrammar is a domain-specific language for *describing* concrete syntax tree shapes — not a parser generator. From an `ungrammar` file, generators emit typed accessor APIs for the CST without generating a parser at all. The parser stays hand-written and provides whatever recovery and resilience the IDE needs (`PARSERS.md §7.4`).

The contribution: separating "what is the typed shape of the tree?" from "how do we parse strings into it?" is rare. Most parser tools couple the two — yacc/Bison emit both grammar tables and AST types — leading to grammar-shaped trees that are awkward to navigate. ungrammar inverts this: design the tree first as a typed API, then write whatever parser produces it.

Source: https://rust-analyzer.github.io/blog/2020/10/24/introducing-ungrammar.html

### 3.8. RakuAST — Class-Based AST as Compiler Frontend

Rakudo's RakuAST replaces the QAST-based front-end with an AST whose nodes are Raku classes under the `RakuAST::` package: `RakuAST::StatementList`, `RakuAST::Call::Name`, etc. `.AST` parses to objects, `.DEPARSE` round-trips back to source, and `IMPL-TO-QAST` lowers to the runtime IR.

The radical move: AST nodes are *first-class language objects*. User macros construct, traverse, and rewrite syntax with the same tools used to manipulate any other Raku object hierarchy. Compile-time `$?SOURCE` and `$?CHECKSUM` (SHA-1) become available for runtime debuggers and packaging. Cross-references: `PARSERS.md §6.3` (Rakudo grammars), `COMPILERS.md §6.8` (RakuAST → QAST lowering), `COMPILERS.md §14.5` (MoarVM new-disp). The cost: every AST traversal goes through full language object dispatch, with measurable allocation pressure during compilation.

Source: https://docs.raku.org/type/RakuAST

---

## 4. High-Level / Source-Adjacent IRs

High-level IRs sit close to the source — close enough to round-trip, name-resolve, or run macro expansion against. The chapter's distinguishing axis is *what semantic refinement the IR adds beyond the AST*: name-resolved bindings (Rust HIR), type-checked operands and explicit coercions (THIR), SSA-form with closure analysis (Swift SIL), partial evaluation traces (Truffle), or transformation-pipeline state (Babel). They are deliberately not designed for codegen — that role belongs to mid-level IRs (§5).

### 4.1. Rust HIR (High-Level IR)

rustc's HIR is the desugared, name-resolved form of the AST. Macro expansion has run; `for` loops have become `loop` + `match`; type annotations are still expressions, not yet checked. HIR is the IR most type-checking, lints, and trait resolution operate on. Its data model is still tree-shaped (close to the AST in structure) but with stable IDs assigned to every body and every binding, so cross-references can be resolved without re-walking the tree.

The motivation for HIR existing alongside the AST: the AST is whatever the parser produces, including macro invocations and unresolved paths; HIR is what semantic analysis can actually consume. Splitting them lets the AST stay focused on syntax-tree concerns and the HIR on resolved-binding concerns.

Source: https://rustc-dev-guide.rust-lang.org/hir.html

### 4.2. Rust THIR (Typed HIR)

THIR is the next level down: HIR with all types explicit, all coercions made concrete, all method calls resolved to specific function bodies, and pattern matching desugared to a decision-tree form. THIR exists primarily as a stepping stone to MIR (§5.1) — most analyses don't operate on THIR directly. Borrow checking and exhaustiveness checking happen at the MIR level; THIR's role is to make the typed program shape explicit before lowering.

The lesson is that the cascade of HIR → THIR → MIR is not arbitrary: each level discards information the next-lower level doesn't need (HIR keeps source structure, THIR keeps type-explicit structure, MIR keeps CFG structure). A two-level cascade would be too coarse.

Source: https://rustc-dev-guide.rust-lang.org/thir.html

### 4.3. Swift SIL (Swift Intermediate Language)

Swift's SIL is unusually high-level for an IR: it preserves Swift-specific constructs (existentials, generic specialization markers, witness tables, ARC retain/release pairs, devirtualization opportunities) that LLVM IR cannot represent. SIL is SSA-form but with Swift-aware operations rather than generic LLVM ones — it has `apply` (function call), `partial_apply` (closure construction), `class_method`, `witness_method`, and so on.

The design point: Swift's optimizations (specialization, devirtualization, ARC elision, escape analysis) need representation power that LLVM lacks, and lowering to LLVM IR before running them would lose information. SIL is the optimization substrate; lowering to LLVM IR happens only after SIL-level optimizations have run. This is a multi-level architecture (§10) without using MLIR.

Source: https://github.com/swiftlang/swift/blob/main/docs/SIL.rst

### 4.4. C# Roslyn Semantic Model

Roslyn's "semantic model" is the typed, name-resolved view layered on top of the syntax tree. Where the syntax tree (§2.1) is purely lexical, the semantic model answers questions: "what type does this expression have?" "what symbol does this identifier refer to?" "is this method override valid?" The model is computed lazily — querying it for one expression doesn't trigger full-program analysis.

Distinct from a separate IR layer: Roslyn does not lower the syntax tree into a different data structure for semantic queries. Instead, the syntax tree is queried *with* a semantic model parameter, and the model produces type/symbol facts on demand. This is the lazy-query equivalent of Salsa (§12.2), but framed as IDE infrastructure rather than compiler architecture.

Source: https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/get-started/semantic-analysis

### 4.5. Hermes HIR (Hermes IR)

Meta's Hermes JavaScript engine has its own multi-level IR: a high-level IR (HIR) that retains JS semantics (closures, scopes, hoisting), and a lower-level Hermes Bytecode (HBC, §9.11) that the engine actually executes. HIR is SSA-form; HBC is a register-based bytecode tuned for fast load on resource-constrained devices (React Native targets).

HIR's distinctive design choice: it's optimized for *ahead-of-time* compilation, unlike V8's IRs which are JIT-oriented. Hermes precompiles JS to HBC at app build time and ships only HBC to devices, eliminating parse and compile cost at startup. The HIR layer lets Hermes apply JS-aware optimizations (eager type narrowing, dead-code elimination) before lowering to bytecode.

Source: https://github.com/facebook/hermes/tree/main/lib/Optimizer

### 4.6. Truffle / Graal AST as IR

In the GraalVM Truffle framework, the language implementer writes an *AST interpreter* — but the AST is also the IR. Partial evaluation specializes the AST against observed types and values, producing an effectively-compiled version of the same tree. There is no separate IR phase; the AST nodes carry inline caches, profiling, and specialization metadata that make them executable both interpretively and (after Graal partial evaluation) as native code.

This is the Futamura projection (§COMPILERS.md §1.3) made concrete: the partial evaluator (Graal) plus the interpreter (the AST + node specializations) is the compiler. Truffle's contribution is showing that the same data structure can be both the source-faithful AST and the optimization substrate, eliminating a translation layer.

Source: https://www.graalvm.org/latest/graalvm-as-a-platform/language-implementation-framework/

### 4.7. Babel AST + Plugin Pipeline

Babel transforms JavaScript via plugins, each operating on the ESTree-shaped AST (§3.6). The "IR" in Babel is the AST itself, mutated in place by visitor functions; plugins register interest in specific node types and rewrite them. The transformation pipeline composes plugins in order, but each plugin sees the AST as-is — there is no separate intermediate form.

The pragmatic consequence: Babel's representation is the same shape across all phases, which makes plugin authoring trivial and plugin composition near-free. The cost is that some optimizations want a different shape (SSA, sea-of-nodes, etc.) and Babel cannot offer those without breaking its plugin contract. Babel optimizes for *transformation* throughput, not *optimization* depth — which fits its actual use case (transpiling, bundling, minifying) better than a heavyweight optimizer would.

Source: https://babeljs.io/docs/babel-parser

---

## 5. Mid-Level IRs

Mid-level IRs are where most analysis and optimization happens: name-resolved, type-explicit, in CFG or graph form, but not yet target-specific. The chapter's distinguishing axis is *what each IR is the substrate for*: borrow checking (Rust MIR), AOT-with-comptime evaluation (Zig ZIR), LLVM-frontend lowering (Mojo KGEN, Ballerina BIR), JIT speculation (V8 Maglev, JavaScriptCore DFG), or source-fidelity-preserving security analysis (Google JSIR). The same operational structure (CFG of typed instructions) supports very different goals depending on what metadata each IR threads through it.

### 5.1. Rust MIR (Mid-Level IR)

rustc's MIR is the borrow checker's native IR. CFG of basic blocks; statements are simple three-address operations; terminators are explicit (`Goto`, `SwitchInt`, `Drop`, `Call`, `Return`). Every variable has explicit drop semantics, every borrow has a region, every reference carries the lifetime that reaches it. Pattern matching is fully desugared to chains of comparisons.

MIR was introduced in 2016 specifically because borrow checking on the AST had become unmaintainable — non-lexical lifetimes (NLL) and later Polonius (`MEMORY.md §1.2`) require a flow-sensitive representation. MIR's CFG gave the borrow checker a clean substrate, and const-eval, drop elaboration, exhaustiveness checking, and miri (`DEBUGGERS.md §8.8`) all became cleaner on MIR than they were on the AST. Lowering to LLVM IR happens after MIR-level passes complete.

Source: https://rustc-dev-guide.rust-lang.org/mir/index.html and https://blog.rust-lang.org/2016/04/19/MIR.html

### 5.2. Zig ZIR (Zig Intermediate Representation)

ZIR is the IR Zig generates from the AST and feeds to semantic analysis. The defining design choice: ZIR encodes *unanalyzed* code — types are not yet resolved, comptime evaluation has not yet run, generic instantiation has not happened. Each ZIR instruction stores `node_offset` relative to its parent declaration rather than an absolute token index, so source-position metadata is compact and survives source-buffer freeing (`PARSERS.md §3.3`).

ZIR is the substrate for Zig's `comptime`: comptime evaluation is interpretation of ZIR with the analyzer choosing instantiation values. Once analysis completes, ZIR is lowered to AIR (§5.3). The two-stage ZIR → AIR design lets Zig's unique combination of comptime, generic specialization, and multiple compilation targets share the same front-end IR.

Source: https://github.com/ziglang/zig/blob/master/src/Zir.zig

### 5.3. Zig AIR (Analyzed IR)

AIR is what ZIR becomes after semantic analysis: types resolved, comptime evaluated, generic functions instantiated, dead branches removed. AIR is lower-level than ZIR — closer to a typed CFG with explicit operands — and is the input to Zig's LLVM backend (or its self-hosted backends targeting WebAssembly, x86_64, or aarch64).

The two-IR architecture exists because comptime evaluation needs to operate on un-analyzed code (ZIR) while codegen needs analyzed code (AIR). A single IR could carry both, but at the cost of either making comptime see analyzed code (impossible, since comptime drives instantiation) or making codegen consume un-analyzed code (impractical for an LLVM backend that needs concrete types).

Source: https://github.com/ziglang/zig/blob/master/src/Air.zig

### 5.4. Mojo KGEN and POP Dialect

Mojo's compiler is built on MLIR. The **KGEN** layer (Kernel Generator) represents *parametric* code as first-class IR — Mojo's generic functions, parameter-bound `@parameter` decisions, and `comptime` evaluation all live as parametric MLIR ops. The **POP dialect** (Parametric Operations) provides parametric types (`!pop.simd<size, dtype>`) and ops whose concrete semantics depend on parameter values.

The distinctive properties: pre-elaboration parametric IR is *serializable to disk* and instantiable later, even on a different target. A parametric Mojo function compiled today can be specialized at the user's machine for their CPU. This is unlike most generic systems (C++ templates, Rust monomorphization) which materialize concrete types at the original compile site. Cross-reference: `COMPILERS.md §6.6` covers the same dialect from the optimizer angle; here the focus is the parametric-IR data model itself.

Source: https://github.com/modular/modular/blob/main/mojo/stdlib/docs/internal/pop_dialect.md

### 5.5. Ballerina BIR

Ballerina IR (BIR) is the shared IR between Ballerina's two compilation pipelines: jBallerina (BIR → JVM bytecode) and nBallerina (BIR → LLVM IR → native binary). BIR is generated from the desugared AST after lowering high-level constructs. It is deliberately lower-level than the AST but higher-level than either target bytecode.

The two architectural details: BIR is *cached as a linking artifact* — each package's BIR is serialized to binary and cached in `.ballerina/`, letting incremental builds resolve cross-module references without re-parsing source. And the dual-target requirement forces cleanly target-neutral semantics — BIR cannot bake in JVM-isms or LLVM-isms because both backends consume it. Cross-reference: `COMPILERS.md §6.7` covers BIR from the dual-backend angle.

Source: https://medium.com/ballerina-techblog/peering-into-the-ballerina-intermediate-representation-8e97361a070e

### 5.6. SpiderMonkey IonMonkey MIR / LIR

SpiderMonkey's IonMonkey (Firefox's optimizing JS JIT) uses two IR levels: a **MIR** (Mid-level IR, unrelated to Rust's MIR or LLVM's MIR) which is SSA-form with high-level JS-aware operations (`MAdd`, `MGuardShape`, `MCall`), and a lower **LIR** (Low-level IR) used for register allocation and machine-code emission.

MIR's role is the JS-specific optimizer — type specialization, range analysis, allocation sinking, redundant guard elimination. The handover to LIR happens after IonMonkey decides instructions are stable; LIR is closer to the target ISA but still abstracted enough to support multiple architectures. The two-IR design predates V8's Turboshaft (§6.5) and addresses the same problem: separating high-level transformation from target-specific scheduling.

Source: https://wiki.mozilla.org/IonMonkey

### 5.7. V8 Maglev IR

V8's Maglev is a mid-tier optimizing JIT inserted between Sparkplug (baseline) and TurboFan (full optimizer). Its IR is SSA-form but designed for *speed of compilation*, not depth of optimization — Maglev's selling point is that it produces good-enough code in a fraction of TurboFan's compile time, hitting steady-state performance early.

Maglev's IR carries explicit deopt metadata at every speculative operation, so when an assumption fails the runtime can bail out to Sparkplug code. The IR is intentionally less expressive than TurboFan's sea-of-nodes (§6.4) — fewer node kinds, fewer optimizations, simpler CFG. The trade-off favours JIT-compile-time over peak throughput, which fits the "warm path" workload where Maglev typically runs.

Source: https://v8.dev/blog/maglev

### 5.8. JavaScriptCore DFG (Data Flow Graph)

JavaScriptCore's DFG is a mid-tier optimizing JIT IR, named for its data-flow-graph structure (SSA + explicit dataflow edges). DFG uses *speculative type guards* aggressively: every operation checks observed types and deoptimizes to baseline interpretation if assumptions fail. The IR carries explicit OSR exit points so the runtime can transition cleanly between optimization tiers.

DFG sits between LLInt (interpreter), Baseline (template JIT), DFG (mid-tier optimizer), and FTL (Faster Than Light, the top-tier B3 SSA optimizer). The four-tier design is deliberate: each tier compiles fast enough to take over from the one below before the upper tier becomes a startup-latency bottleneck.

Source: https://webkit.org/blog/3362/introducing-the-webkit-ftl-jit/

### 5.9. HHVM HHIR (HipHop Intermediate Representation)

HHVM's HHIR is the IR for Hack and PHP. SSA-form, with HHVM-specific operations modelling dynamic dispatch, magic methods, weak typing, and reference semantics. HHIR is the substrate for HHVM's optimizing JIT (Tier 2+); the lower bytecode (HHBC, §9.10) is what the interpreter and baseline JIT consume.

The distinctive feature: HHIR is generated from a *region* (a connected subgraph of the bytecode) rather than from whole functions. Region-based JIT compilation, popularized by Hauswirth and Pemberton's earlier work, lets the JIT focus optimization effort on the specific control-flow paths that are actually hot, sidestepping the cost of optimizing entire functions where most basic blocks are cold.

Source: https://github.com/facebook/hhvm/tree/master/hphp/runtime/vm/jit

### 5.10. Google JSIR — MLIR-Based JS for Source Analysis

Google's JSIR is an MLIR-based JavaScript IR designed for *source-to-source* analysis: deobfuscation, taint analysis, and decompilation of Hermes bytecode back to readable JS. The dual-dialect design (`jsir` for SSA values, `jshir` for high-level structured control flow as MLIR regions) is what distinguishes it from optimizer-oriented JS IRs (Maglev, DFG, IonMonkey MIR).

Specifically: `jshir` represents `if`/`while`/`for`/`logical_expression` as MLIR regions rather than CFG jumps, so the original control-flow structure is preserved. L-value vs r-value separation is explicit (`identifier_ref` vs `identifier`). Round-trip back to the Babel AST is claimed at 99.9%+ success, achieved via post-order traversal mapping that recursively reconstructs AST nesting from use-def chains. JSIR underpins Google's CASCADE LLM-powered deobfuscator (arXiv:2507.17691).

The lesson generalizes: an IR designed for *security analysis* — taint propagation, dataflow tracking, source recovery — has different fidelity requirements than an IR designed for codegen. JSIR shows MLIR's region machinery accommodating both: structured control as regions for source fidelity, SSA values for dataflow.

Source: https://github.com/google/jsir and https://arxiv.org/abs/2507.17691

---

## 6. SSA-Based IRs

SSA — every variable assigned exactly once, with φ-functions at join points — is the dominant IR shape for modern imperative compilers. The chapter's distinguishing axis is *what graph structure SSA sits inside*: linear basic blocks (LLVM IR, Cranelift CLIF, Bril), Sea-of-Nodes (HotSpot C2, V8 TurboFan), linear-with-side-tables (V8 Turboshaft), or trace-form (LuaJIT). The trade-off is global-scheduling freedom (Sea-of-Nodes maximum, linear blocks minimum) vs cache locality and compile-time predictability (linear blocks better than graphs). `COMPILERS.md §6.1` covers the formal correspondence between CPS, ANF, and SSA; this chapter focuses on concrete production IRs.

### 6.1. LLVM IR

LLVM IR is the de-facto industry-standard SSA IR for ahead-of-time compilation: typed (every value carries an `i32`/`i64`/`<n x T>` type), linear (basic blocks contain instructions in source order, terminators are explicit branches), and platform-independent (the same IR can target x86, ARM, RISC-V, PowerPC, WebAssembly, NVPTX). Its textual `.ll` form is human-readable and serializable; its bitcode form is compact and hashable.

LLVM IR's strength is breadth: 30+ years of optimization passes, every major front-end (Clang, Rust, Swift, Julia, Kotlin Native, Zig) targets it, and the surrounding ecosystem (LLVMlite, MLIR, LLD, sanitizers) is unmatched. Its weakness, increasingly named in modern compiler discussions, is compile-time cost — LLVM optimization passes are expensive enough that JITs (Cranelift, V8 Turboshaft) have moved away from LLVM IR specifically to escape its overhead.

Source: https://llvm.org/docs/LangRef.html

### 6.2. Cranelift CLIF

Cranelift's IR (CLIF) is SSA-based but designed for compile *speed* rather than peak code quality. It uses dense integer indices instead of pointers (similar to Turboshaft), keeps types minimal (`i8`/`i16`/`i32`/`i64`/`f32`/`f64`/vector + references), and is deliberately lower-level than LLVM IR — no target-independent bitcasts, fewer implicit conversions, fewer node kinds.

The result is a backend that compiles ~10× faster than LLVM at modestly lower code quality. CLIF is the IR behind Wasmtime (WebAssembly), `rustc_codegen_cranelift` (alternative Rust backend for debug builds, 2–4× faster compile than LLVM), and several other projects. Cross-reference: `COMPILERS.md §13.2` covers Cranelift's ISLE-driven instruction selection and regalloc2; here the focus is the IR data model.

Source: https://github.com/bytecodealliance/wasmtime/tree/main/cranelift

### 6.3. HotSpot C2 — Sea of Nodes

HotSpot's C2 (server-tier JIT) uses Cliff Click's Sea-of-Nodes IR: a graph where both data flow and control flow are edges, and basic blocks are not first-class — instructions are ordered only by their data dependencies. This gives the optimizer maximum scheduling freedom: any instruction can move anywhere its dependencies allow, and global instruction scheduling falls out as a consequence of the IR shape.

The cost is that the IR is harder to print, debug, and reason about than linear SSA, and global scheduling on every pass adds compile-time overhead. HotSpot accepts these costs because peak code quality matters more for long-running server workloads. The same IR style appears in V8 TurboFan (§6.4) and Graal — all server-tier JITs that prioritize peak throughput.

Source: Click (1995) "From Quads to Graphs" and https://www.oracle.com/technical-resources/articles/java/architect-evans-pt1.html

### 6.4. V8 TurboFan

TurboFan is V8's classical optimizing JIT, also Sea-of-Nodes. Layered atop the base SoN, TurboFan adds *type system specialization* (Number vs String vs JSObject), inline caches feedback (call sites embedded with observed types), and deoptimization metadata (every speculative operation knows how to bail to Ignition bytecode if assumptions fail).

For a decade TurboFan was V8's only optimizer; it was replaced (or supplemented) by Turboshaft (§6.5) starting in 2022. The reason for replacement: TurboFan's SoN graph made compilation slow, and JS workloads often need many short-lived optimizations rather than deep peak quality. The trade-off illustrates that Sea-of-Nodes is analytically elegant but operationally expensive at JIT scale.

Source: https://v8.dev/blog/launching-ignition-and-turbofan

### 6.5. V8 Turboshaft

Turboshaft is V8's replacement for TurboFan's Sea-of-Nodes IR. Where TurboFan stored operations in a graph with implicit ordering, Turboshaft keeps operations in *straight-line basic blocks* with dense indexed operand references — closer to LLVM IR than to SoN. Operations live in a flat buffer with fixed-size slots; operands are 32-bit indices rather than pointers.

The motivation was concrete: SoN compile time was 30–40% of total V8 JIT time on the affected pipelines, debugging was hard because program order was implicit, and cache locality suffered from pointer-chasing. Turboshaft's linear shape eliminates global scheduling per pass and gives pass authors predictable iteration behaviour. The team reported 30–40% compile-time reduction with parity-or-better code quality.

Source: https://v8.dev/blog/turboshaft

### 6.6. LuaJIT IR

LuaJIT's IR (Mike Pall's design) is SSA-form but *trace-shaped*: a trace records the linear sequence of operations executed through one iteration of a hot loop, including inlined function calls. Guards check that every speculation (type, branch, allocation) holds; if a guard fails, execution falls back to the interpreter at a side exit, which may start recording a new trace.

The trace IR is dense, with carefully-tuned representation: each op is a fixed-size record, with operands as small indices into the trace buffer. Allocation sinking, store forwarding, and constant folding all operate on the trace as a linear sequence. LuaJIT's trace compiler is the cleanest production demonstration that an SSA IR can be maximally compact when scoped to a single hot path.

Source: https://www.freelists.org/post/luajit/Compiler-Design-Specification

### 6.7. GHC Cmm

GHC's Cmm (C--, "C minus minus") is the lowest IR before native codegen. Cmm is a portable assembly language: typed (`bits32`, `bits64`, `float64`), with explicit calling conventions, machine word operations, and labeled blocks. It's flat (no high-level constructs) but still target-independent — the same Cmm can lower to x86-64, ARM64, or via the LLVM backend.

Cmm's role in GHC's multi-level pipeline (§10.4): Core (high-level functional) → STG (operational semantics for laziness) → Cmm (portable assembly) → native. Each level discards information the next doesn't need. Cmm is also the IR Cmm-CMM-level optimizations operate on (block layout, register allocation hints, peephole rewrites).

Source: https://gitlab.haskell.org/ghc/ghc/-/wikis/commentary/compiler/cmm-type

### 6.8. Bril (Big Red Intermediate Language)

Bril is a research IR designed at Cornell for teaching compiler construction (CS 6120). Its claim to fame: the IR is JSON-shaped. Every Bril program is a JSON document with functions, basic blocks, and instructions encoded as nested objects. Tools, optimizers, and analyzers can be written in any language that can parse JSON.

Bril is intentionally minimal — fewer instructions than LLVM, no type system beyond a small set of primitives, no implicit conversions. The didactic point is that an IR doesn't need to be complex to support real optimizations (LICM, GVN, dead-code elimination, register allocation). The JSON encoding makes Bril uniquely accessible for student projects: a 50-line Python script can read a Bril program, transform it, and write it back. As a representation, Bril shows that *the wire format itself can be the IR* — there is no separate textual form, no separate binary, just JSON.

Source: https://capra.cs.cornell.edu/bril/

---

## 7. CPS, ANF, and Functional IRs

Functional-language compilers historically chose IRs that make control flow explicit at the term level rather than encoding it in a CFG. The chapter's distinguishing axis is *how control is exposed*: via explicit continuation arguments (CPS), via let-bound intermediate names with trivial argument forms (ANF), or via direct-style with effect annotations (Koka). All three are formally related — Kelsey (1995) showed CPS and SSA correspond — but the surface representation choice shapes what optimizations are easy to express.

### 7.1. Continuation-Passing Style (CPS)

CPS represents every function call as taking an explicit continuation: instead of returning a value, a function invokes its continuation with the value. Function calls never return; they tail-call into continuations. Steele's Rabbit compiler for Scheme (1978) and Appel's SML/NJ (1992) are the canonical implementations.

CPS makes all control flow explicit at the term level: non-local returns, exceptions, coroutines, async/await, and effect handlers all express naturally as continuation manipulation. The cost is that the IR has many more lambda terms than the source — every operation introduces a continuation parameter. For optimizers, this can be either a feature (uniform structure) or a bug (more nodes to process).

Source: https://www.cs.princeton.edu/~appel/papers/cpcps.pdf

### 7.2. A-Normal Form (ANF)

Flanagan, Sabry, Duba, Felleisen (1993) introduced ANF as a simpler alternative to CPS. In ANF, every intermediate result is named (`let x = e in ...`) and every function argument is *trivial* (a variable or a constant — never a complex expression). ANF captures the same sequencing guarantees as CPS but without explicit continuation arguments.

ANF's appeal: it's more readable than CPS, easier to map back to source for debugging, and most optimizations (β-reduction, dead-let elimination, common subexpression elimination) have natural ANF formulations. Most modern functional compilers (GHC's Core in let-normal form, OCaml's Flambda, Roc, Koka before its CPS-based effect handlers) use ANF or ANF-like forms.

Source: https://users.soe.ucsc.edu/~cormac/papers/pldi93.pdf

### 7.3. GHC Core

GHC's Core is a small typed lambda calculus with let-bindings, case analysis, and explicit type abstraction/application. Core is ANF-like (every let binds an intermediate), strongly typed (System F + extensions), and the substrate for all major GHC optimizations (inlining, specialization, fusion, strictness analysis, demand analysis).

Core's distinctive property: it's *small enough to fit in a memorable specification*, which makes it tractable for formal reasoning. The GHC team treats Core as a stable interface — passes operate on Core, not on the much more complex Haskell source — so the compiler's invariants live at the Core level. This is also why Core is the level at which Haskell's "Beautiful Concurrency" (parallel evaluation, STM) is implemented.

Source: https://gitlab.haskell.org/ghc/ghc/-/blob/master/compiler/GHC/Core.hs

### 7.4. OCaml Flambda

OCaml's Flambda is the optimizer between the OCaml front-end and the bytecode/native back-ends. Flambda's IR is ANF-like, with explicit closure representation and value-flow analysis. The original Flambda 1 was rewritten as Flambda 2 in 2020+, with a new IR that more aggressively unboxes values, specializes on known-shape arguments, and fuses pattern matches.

Flambda is interesting for this survey because it's an ANF IR designed for *aggressive value-representation optimization* in a strict language. Where GHC Core lives in a lazy world (where value representation matters less), Flambda assumes strict evaluation and exploits it: known-int-typed bindings unbox to raw machine integers, known-tuple-typed bindings unbox to multiple registers, known-closure-typed bindings inline aggressively.

Source: https://v2.ocaml.org/manual/flambda.html

### 7.5. Koka — Effect-Typed IR

Koka's IR carries explicit effect annotations on every function: `f : int -> <io,exn> int` says "function consuming int, performing I/O and exceptions, returning int." The IR is direct-style (not CPS) but threads effect types through every binding, so optimizations can exploit purity (`<>`-typed expressions can be reordered, deduplicated, and inlined freely).

Effect handlers compile via *evidence passing* (Xie & Leijen, ICFP 2021): the runtime threads handler references as extra arguments through every effectful operation, avoiding continuation capture for the common case (tail-resumptive handlers). This makes Koka's representation an interesting hybrid: direct-style at the surface, effect-typed for purity tracking, evidence-passing at runtime, and Perceus reference-counting (`MEMORY.md §3.2`) for memory.

Source: https://koka-lang.github.io/koka/doc/book.html

---

## 8. E-Graphs and Equality-Saturating IRs

E-graphs represent not one program but an equivalence class of programs. When an optimizer rewrites `x * 2 → x << 1`, both forms remain in the e-graph; an extraction pass selects the best form after all rewrites have run to saturation. This dissolves the phase-ordering problem (the order of optimizations no longer matters) at the cost of a heavier representation. The chapter's distinguishing axis is *how tightly e-graph machinery integrates with the rest of the compiler*: as a general-purpose library (egg), as a Datalog-extended rewriting engine (egglog), as an integrated optimization pass (Cranelift), or as a non-SSA program structure entirely (RVSDG).

### 8.1. egg (Equality Saturation Library)

Max Willsey's egg is a Rust library implementing efficient e-graphs. The core insight: e-graph operations (add, merge, rebuild) become near-linear time using a deferred-rebuild strategy ("rebuilding"), which makes equality saturation practical for compiler-scale programs. egg is used by SymbolicUtils.jl, MLIR's PDLL, the Cranelift mid-end (§8.3), Herbie (numerical accuracy), Tensat (tensor algebra), and several research compilers.

The contribution: e-graphs went from "interesting research idea" to "production optimization technique" in roughly five years, almost entirely because egg made the implementation tractable. Cross-reference: `COMPILERS.md §1.4` covers e-graphs from the optimization angle.

Source: https://egraphs-good.github.io/

### 8.2. egglog

Yihong Zhang et al.'s egglog combines e-graphs with Datalog. Rules are written declaratively over a relational schema; the engine derives all consequences via fixed-point Datalog evaluation. This makes complex rewrites — those needing multi-pattern matching, recursive rule application, or interaction with external facts — express naturally as Datalog clauses.

egglog targets workloads where the rewrite system is itself complex: program analysis, type inference, theorem proving, equational program optimization. The representation: an e-graph plus a relational database, queryable with Datalog. This is unusual enough to deserve a separate entry from egg — egg is a library; egglog is a *language* for writing rewrite systems.

Source: https://github.com/egraphs-good/egglog

### 8.3. Cranelift e-Graph Mid-End

Cranelift adopted egg-based e-graphs for its mid-end optimizer in 2022, replacing its previous peephole-rewriter. The rewriter's rules — strength reduction, algebraic identities, GVN — express as ISLE (`COMPILERS.md §13.2`) patterns over the e-graph. The acyclic-egraph (aegraph) variant Cranelift uses is a restricted form of e-graph that disallows cycles, making extraction easier.

This is the largest production deployment of e-graphs as of 2025. Trade-offs: e-graphs use more memory than mutable IRs (every rewrite preserves the original alongside the new form), and extraction has to choose among equivalent programs. Cranelift's choice of acyclic e-graphs accepts some expressiveness loss for predictable extraction.

Source: https://github.com/bytecodealliance/rfcs/blob/main/accepted/cranelift-egraph.md

### 8.4. RVSDG — Region-Based Value State Dependence Graph

Reissmann, Meyer, Bahmann, Själander (2020) propose RVSDG as an SSA alternative. Where SSA represents control flow via CFG basic blocks and φ-functions, RVSDG represents control via *regions* (nestable subgraphs) and dataflow via dependency edges. Loops, conditionals, and tail-recursive functions all become region nodes with explicit input/output ports.

RVSDG's pitch: many optimizations (loop-invariant code motion, partial redundancy elimination, dead-code elimination) become structural graph transformations on RVSDG, simpler than their SSA equivalents. Hugin and JLM are research compilers built on RVSDG. The form is not yet in production (LLVM, GCC, Cranelift all use SSA), but appears in compiler-research papers and in some experimental MLIR dialects.

Source: https://dl.acm.org/doi/10.1145/3391902

---

## 9. Bytecode Representations

Bytecode is portable, compact, and verifiable in ways that machine code is not — at the cost of an extra dispatch layer at execution time (or a JIT to remove that layer). The chapter's distinguishing axis is *what the bytecode optimizes for*: stack-based compactness (JVM, CIL, CPython, Wasm), register-based efficiency (Lua, Dalvik DEX, V8 Ignition), in-kernel safety (BPF), or platform-specific download size (Hermes HBC, HHBC). Same family, very different design pressures.

### 9.1. JVM Bytecode

JVM bytecode is stack-based: operations pop operands from an implicit operand stack and push results. Instructions are 1-byte opcodes plus optional operands; a typical class file averages 1–4 bytes per instruction. The bytecode is *typed* — `iload` loads an int, `aload` loads a reference, `i2l` converts int to long — and JVM verification before execution ensures stack and type safety.

JVM bytecode's longevity (since 1995) reflects its design strengths: small, portable, verifiable, and JIT-friendly. The cost is that stack-based dispatch is slower than register-based (Shi et al. VEE 2008 measured ~47% more dispatched instructions for stack VMs; `COMPILERS.md §1.8`), which is why HotSpot's JIT compiles bytecode away rather than interpreting it long-term.

Source: https://docs.oracle.com/javase/specs/jvms/se21/html/

### 9.2. CIL (.NET Common Intermediate Language)

CIL is .NET's bytecode, also stack-based, also typed. ECMA-335 standardizes the format. CIL adds features JVM bytecode lacks: explicit value types (structs that don't allocate on the heap), generics (preserved through CIL rather than erased), unsafe pointer types, and tail-call instructions. The runtime (CoreCLR) JIT-compiles CIL to native via RyuJIT.

CIL's design philosophy: "the runtime is a target, not a translator." Source languages (C#, F#, VB.NET, IronPython, IronRuby) compile to CIL with as little semantic loss as possible — generic information, attribute metadata, and debug symbols all flow through. The runtime's job is to JIT these features efficiently, not to lower them.

Source: https://ecma-international.org/publications-and-standards/standards/ecma-335/

### 9.3. DEX (Dalvik Executable)

Android's DEX is *register-based* bytecode: each method declares a fixed register set (typically 8–16 registers per method), and instructions name source and destination registers explicitly. This contrasts with JVM stack bytecode and aligns with Dalvik VM's choice (later inherited by ART) to optimize for the dispatch-cost characteristics of mobile CPUs.

DEX's distinctive design: multiple class files merge into a single `classes.dex` per app, with shared string and type pools. This dramatically reduces APK size compared to shipping individual `.class` files. Multidex (handling apps with >64K methods) and ART's AOT compilation (DEX → native at install time) are downstream consequences of this format choice.

Source: https://source.android.com/docs/core/runtime/dex-format

### 9.4. BEAM (Erlang VM Bytecode)

BEAM is the bytecode for the Erlang VM, also used by Elixir, LFE, and other BEAM languages. Register-based, with operations modeling Erlang's per-process heap, message passing, and pattern matching natively. Tail calls are first-class (every BEAM call site is potentially a tail call). The bytecode is loaded into the VM as `.beam` files, one per Erlang module.

BEAM's distinctive feature: hot code reload is a first-class VM concept. Modules can be reloaded while processes continue executing the old version (`COMPILERS.md §23.1`, `MODULES.md §11.3`). This shapes the bytecode design — BEAM avoids cross-module inlining at the bytecode level, keeping module boundaries swappable.

Source: https://www.erlang.org/doc/system/code_loading.html

### 9.5. LuaJIT Bytecode

LuaJIT's bytecode is register-based with 32-bit instruction words (8-bit opcode, 8-bit destination register, 16-bit operand fields). It's slightly different from standard Lua 5.x bytecode — LuaJIT tunes its instructions for trace-JIT ergonomics, with operations like `MOV` and arithmetic ops sized to fit interpreter dispatch into a tight loop.

The interpreter is written in hand-tuned assembly per architecture; the bytecode hits the cache predictably because the encoding is fixed-width. LuaJIT's interpreter is one of the fastest interpreters ever built — within 2× of native code on many benchmarks before the JIT even fires. The bytecode design is a major reason: simple, predictable, dispatch-friendly.

Source: http://wiki.luajit.org/Bytecode-2.0

### 9.6. CPython Bytecode

CPython's bytecode is stack-based, with each opcode encoded as 1 byte (opcode) + 1 byte (oparg or extension). Modern CPython (3.11+) uses an *adaptive* interpreter: hot opcodes are rewritten in place to type-specialized variants (`LOAD_ATTR_INSTANCE_VALUE` instead of generic `LOAD_ATTR`) based on runtime feedback. PEP 659 specifies this.

The specializing adaptive interpreter is the most consequential CPython performance change in years: 10–60% runtime improvement without a JIT, by exploiting monomorphic call-site type stability inside the interpreter dispatch loop. Cross-reference: `COMPILERS.md §1.9` covers specialization mechanics; here the focus is the bytecode's role as the substrate that allows in-place opcode rewriting.

Source: https://peps.python.org/pep-0659/

### 9.7. MoarVM MAST and MoarVM Bytecode

MoarVM (Raku's VM) has two bytecode levels. **MAST** (MoarVM Abstract Syntax Tree) is the high-level abstract bytecode that NQP and Raku compile to. **MoarVM bytecode** (often called MBC) is the lower-level executable form — register-based, with operations modeling Raku's rich semantics (multi-dispatch, multiple integers, parameter handling, container types).

The two-level design lets MAST be the stable target for Raku's compiler while MBC is free to evolve. MoarVM's spesh and new-disp subsystems (`COMPILERS.md §14.4`, `§14.5`) operate on MBC, specializing it for observed types. The lego JIT (`§13.5`) and expression JIT (`§9.1`) consume MBC and emit native code.

Source: https://github.com/MoarVM/MoarVM/blob/master/docs/bytecode.markdown

### 9.8. WebAssembly

WebAssembly is a stack-based bytecode designed for portability and verification. Operations push and pop typed values from a virtual stack; control flow is *structured* (`block`, `loop`, `if`/`else`, no arbitrary `goto`), which enables single-pass validation and one-pass compilation. Memory is a linear array of bytes; the program's address space is sandboxed.

Wasm's structured control flow is the design choice that distinguishes it from JVM bytecode. JVM allows arbitrary jump targets within a method, requiring stackmap frames for verification; Wasm's structured form makes verification single-pass and decoder-friendly. Cross-reference: `COMPILERS.md §24.2` covers Wasm's in-place interpreter (Virgil); here the focus is the format itself.

Source: https://webassembly.github.io/spec/core/

### 9.9. BPF / eBPF Bytecode

Linux BPF (Berkeley Packet Filter) is a restricted bytecode designed for *in-kernel* execution: 11 64-bit registers, a fixed instruction set, no unbounded loops, no function pointers, no recursion. The kernel verifier checks every program before execution: bounded execution, memory safety, no information leaks. Verified programs are JIT-compiled to native by per-architecture in-kernel JITs (`COMPILERS.md §22`).

eBPF's design point: a verifier-first restricted bytecode is the answer to "how do you let untrusted users load code into the kernel safely?" The restricted ISA makes the verifier tractable; the JIT then runs without further checks. This pattern (restricted bytecode + verifier + JIT) is widely cited as a model for safe in-process code execution beyond kernels.

Source: https://docs.kernel.org/bpf/

### 9.10. HHBC (HHVM Bytecode)

HHVM's HHBC (HipHop Bytecode) is the bytecode for Hack and PHP. Register-based (or rather, partially register- and stack-based — HHBC has both), with operations modeling PHP's dynamic dispatch, weak typing, magic methods, and reference semantics. HHBC is what HHVM's interpreter (LLInt) and baseline JIT execute; HHIR (§5.9) is the higher-level IR for the optimizing JIT.

HHBC's notable feature: the bytecode encodes type observations (which call sites observed which types) inline, so the JIT can speculate based on the bytecode itself. This lets the JIT be invoked in a "warm" state — it doesn't need to re-collect type observations because the bytecode already contains them.

Source: https://github.com/facebook/hhvm/blob/master/hphp/doc/bytecode.specification

### 9.11. Hermes HBC

Hermes Bytecode is the executable form of Meta's Hermes JavaScript engine (used in React Native). HBC is generated *ahead of time* on developer machines, not at runtime — the React Native build process compiles JS to HBC and ships only HBC to devices. This is unusual for JS engines (V8 ships parse+compile to runtime); Hermes' AOT model is what enables fast app startup on resource-constrained mobile devices.

HBC is register-based, compact, and designed for fast load and execution rather than for repeated JIT optimization (Hermes is interpreter-only by default; there's no JIT). The trade-off: Hermes JS code runs 5–10× slower than V8 once warm, but starts 30–50% faster cold — the right trade for a mobile bundler. Cross-reference: §4.5 covers Hermes HIR (the higher level Hermes lowers from before HBC).

Source: https://github.com/facebook/hermes/blob/main/doc/Design.md

---

## 10. Multi-Level IR Architectures

Multi-level IR architectures lower a program through a *cascade* of progressively-specialized IRs, each tuned to its phase. The chapter's distinguishing axis is *how the levels are coupled*: as a fixed pipeline (Rust HIR→THIR→MIR→LLVM), as a generic dialect framework with arbitrary lowering paths (MLIR), or as a series of nanopasses each emitting its own micro-IR (Chez Scheme nanopass, `COMPILERS.md §1.5`). The trade-off is engineering simplicity vs per-phase optimality; for languages with disparate optimization concerns (ownership analysis, comptime evaluation, GPU codegen) the cascade pays for itself, while simpler languages can run a single-level IR at less cost.

### 10.1. MLIR Dialects

MLIR (Lattner et al., 2020) generalizes the multi-level IR pattern: instead of a fixed cascade, every IR is a *dialect* — a self-contained set of operations, types, and verification rules — and dialects can coexist in one MLIR module. Lowering between dialects is a transformation pass (the `linalg` dialect lowers to `scf` lowers to `llvm`); analyses and optimizations can target any dialect that exposes their structure.

The contribution: making "the IR you want" cheap to define. Adding a new dialect for a domain (CUDA `gpu`, Linalg structured-loop, SPV for SPIR-V, Tensor) is a few hundred lines; integrating it with the rest of MLIR is automatic. This is how Mojo (§5.4), IREE, Triton, Torch-MLIR, Polygeist, and many other projects build their compilers — they don't write a compiler from scratch; they write a few dialects on top of MLIR.

Source: https://mlir.llvm.org/

### 10.2. LLVM IR + Machine IR

LLVM's main pipeline has two IRs: target-independent **LLVM IR** (§6.1) for high-level optimization, and target-dependent **Machine IR (MIR)** (`§15.1` here, distinct from Rust's MIR) for register allocation, instruction selection, and machine-code emission. The boundary is the SelectionDAG / GlobalISel pass that lowers LLVM IR to MIR.

The two-level split exists because target-independent and target-dependent optimizations have different concerns: target-independent passes care about value flow and aliasing; target-dependent passes care about register pressure, instruction latencies, and ABI conventions. A single IR could carry both, but at the cost of either being too high-level for codegen or too low-level for analysis.

Source: https://llvm.org/docs/LangRef.html and https://llvm.org/docs/MIRLangRef.html

### 10.3. Rust HIR → THIR → MIR Cascade

rustc's IR cascade is the canonical "moderate-complexity language with a multi-level IR" example. AST → HIR (desugared, name-resolved, §4.1) → THIR (typed, coercion-explicit, §4.2) → MIR (CFG, borrow-check substrate, §5.1) → LLVM IR. Each stage discards information the next stage doesn't need; each stage runs analyses appropriate to its level (HIR for type inference, THIR for pattern exhaustiveness, MIR for borrow checking and drop elaboration).

The lesson: even moderate-complexity languages benefit from multiple IRs. The cost is translation layers between them; the benefit is per-phase optimality. Cross-reference: `COMPILERS.md §6.4` covers the cascade from the optimizer angle; here the focus is the cascade as a representation architecture.

Source: https://rustc-dev-guide.rust-lang.org/mir/index.html

### 10.4. GHC Core → STG → Cmm

GHC's pipeline: Core (typed lambda calculus, §7.3) → STG (Spineless Tagless G-machine, operational semantics for laziness) → Cmm (portable assembly, §6.7) → native or LLVM. Each level has a specific role: Core for high-level optimizations, STG for laziness-related transformations (closure analysis, eager-evaluation analysis), Cmm for codegen-level concerns (register allocation, calling conventions).

STG is the level that distinguishes GHC's pipeline from strict-language compilers: it makes the implementation of laziness explicit (closures, indirections, blackholing) so optimizations can reason about evaluation order. A direct Core-to-machine-code lowering would fold these operational details into machine instructions, losing the analysis substrate.

Source: https://gitlab.haskell.org/ghc/ghc/-/wikis/commentary/compiler/generated-code

### 10.5. OCaml Lambda → Cmm

OCaml's IR cascade is shorter: source → typed AST → Lambda (untyped lambda calculus with explicit closures) → Cmm (Caml-aware portable assembly) → native. Flambda (§7.4) is an optional optimization layer that operates on Lambda. The cascade is shorter than GHC's because OCaml is strict and doesn't need the equivalent of STG.

OCaml's Cmm is similar to GHC's Cmm in role but has Caml-specific concerns: blocks have headers tagged with type and size, GC allocation has specialized fast paths, exceptions thread through the code via a global handler chain. The Cmm-to-native lowering targets x86-64, ARM64, RISC-V, PowerPC, SPARC, and others — same multi-target story as GHC.

Source: https://v2.ocaml.org/manual/intfc.html

---

## 11. Effect-, Region-, and Capability-Annotated IRs

Some IRs carry semantic annotations beyond ordinary types — effects, regions, multiplicities, or capabilities — that drive analyses no plain SSA can support. The chapter's distinguishing axis is *what the annotation enforces*: lifetime/region discipline (MLKit, Cyclone IR), effect purity (Koka), affine resource use (Linear Haskell, Granule), runtime quantity (Idris 2 QTT), or proof-vs-execute separation (Verus, RustBelt). Cross-references: `MEMORY.md §1` and `§2` cover these systems from the language-design angle; this chapter focuses on the IR layer that makes the annotation tractable.

### 11.1. MLKit RegionExp

MLKit's IR is a region-annotated lambda calculus (Tofte-Talpin, 1994). Every value lives in a region, every region has a stack-discipline lifetime, and every allocation is `letregion ρ in e`. The IR carries region variables on every type and effect signatures on every function: `f : (int -> int) at ρ_1 with ε`.

The region inference algorithm (Algorithm R, polymorphic-recursive) operates directly on this annotated IR. The IR shape is what makes inference tractable: effect annotations make it visible which regions a function may allocate in, so inference can place `letregion` boundaries optimally. Cross-reference: `MEMORY.md §2.2` covers MLKit from the memory-management angle.

Source: https://elsman.com/mlkit/

### 11.2. Koka — Effect Type System in IR

Koka's IR threads effect types through every binding (§7.5). The representation: every function arrow is `a -> <effects> b`; every let-binding's type carries the effects of the bound expression. The optimizer uses effects to decide what's safe to reorder (`<>` pure expressions can be moved freely; effectful expressions cannot cross effect boundaries).

Effect types as IR annotations make Koka's optimizer simpler than a heuristic equivalent: no separate purity analysis is needed because the types are the analysis. The cost is that the IR is more complex than untyped or simply-typed alternatives, and effect inference adds compile-time overhead.

Source: https://www.microsoft.com/en-us/research/publication/algebraic-effects-handlers-go-mainstream/

### 11.3. Linear Haskell — Multiplicity-Annotated IR

GHC's Linear Haskell (`-XLinearTypes`, GHC 9.0+) puts multiplicities on the function arrow: `a %1 -> b` is a linear function (must consume its argument exactly once); `a %m -> b` is multiplicity-polymorphic. The IR (an extended Core) carries these multiplicities through every binding.

The implementation cost in GHC was small (~1,150 lines) because the multiplicities ride on top of Core's existing type machinery. The contribution: linear types, which had been kept out of mainstream functional languages for thirty years, became a Core extension rather than a separate language. Cross-reference: `MEMORY.md §1.11` covers Linear Haskell from the resource-discipline angle.

Source: https://arxiv.org/abs/1710.09756

### 11.4. Granule — Graded Modal IR

Granule's IR layers *graded modal types* on top of linearity: `a [n]` means "use `a` exactly `n` times" where `n` ranges over a user-chosen semiring (naturals, intervals, security levels, capabilities). The IR carries these grades on every binding and propagates them through every operation.

The point of grades is to express co-effects — properties of how a value is consumed — that simple linearity cannot. Security levels (low, high) distinguish public and secret data; intervals bound how many times a function can be called. Granule remains research-grade but its IR design is a clean exemplar of how graded modal types layer onto a typed lambda calculus.

Source: https://granule-project.github.io/

### 11.5. Idris 2 — Quantitative Type Theory IR

Idris 2's IR uses Quantitative Type Theory (QTT, McBride 2016): every binder has a multiplicity 0 / 1 / ω, where 0 = erased at runtime, 1 = used exactly once, ω = unrestricted. This unifies linearity *and* erasure: types are 0-quantity (no runtime cost), runtime values are 1 or ω, and the compiler eliminates 0-quantity values during compilation.

QTT's contribution to the IR landscape: a single multiplicity dimension subsumes both Granule's grades and traditional erasure markers. The IR is simpler than carrying both as separate annotations, while expressing the same things. Cross-reference: `MEMORY.md §1.12` covers Idris 2 from the language-design angle.

Source: https://idris2.readthedocs.io/

### 11.6. Verus — Proof / Spec / Exec IR Separation

Verus's IR has three modes: `spec` (uncomputable, unrestricted, used in specifications), `proof` (linear, ghost, used in proofs), and `exec` (compiled, runs at runtime). The three modes share the same surface syntax but are tracked separately in the IR — the compiler erases `spec` and `proof` code before runtime, leaving only `exec`.

The contribution: a typed mode system that makes verification artifacts (proofs, specifications) coexist with compiled code in the same IR without affecting runtime cost. Linear ghost permissions in the `proof` mode let ghost code carry capability tokens (e.g., raw-pointer permissions) borrow-checked exactly like real Rust. Cross-reference: `MEMORY.md §8.3` covers Verus from the formal-verification angle.

Source: https://github.com/verus-lang/verus

### 11.7. RustBelt — λRust as Logical IR

RustBelt's λRust (Jung et al., POPL 2018) is a formal IR for Rust subset, defined in Coq. λRust is the substrate for soundness proofs — every Rust unsafe library (Arc, Rc, Cell, RefCell, Mutex) gets a soundness statement in λRust, proven via lifetime logic. The IR is mechanized: every operation has a small-step semantics in Coq, and proofs are checked machine-by-machine.

This is the IR-as-formal-artifact extreme: λRust is not compiled and run; it's defined and reasoned about. Yet it counts as a language representation because it captures what Rust *means* mathematically, and every other Rust-related verifier (Verus, Prusti, Creusot, Aeneas, RefinedRust) builds atop or adjacent to it. Cross-reference: `MEMORY.md §8.1` covers RustBelt from the formal-soundness angle.

Source: https://plv.mpi-sws.org/rustbelt/popl18/paper.pdf

---

## 12. Persistent and Content-Addressed IRs

A persistent IR survives across compilation sessions. A content-addressed IR identifies code by a hash of its content rather than by name. The chapter's distinguishing axis is *what persistence enables*: incremental compilation memoization (Salsa), distributed execution and rename-without-cost (Unison), or fast persistent data structures inside the compiler itself (Lean 4). All three blur the line between "IR" and "database."

### 12.1. Unison — Hashed AST as Code Identity

Unison's program representation is its hash. Every term, type, and dependency is identified by a hash of its abstract syntax tree; names are *metadata* — a `name ↔ hash` mapping — rather than the canonical identifier. Source files are not the source of truth; a Unison codebase is a SQLite-backed database of hashed AST nodes.

The consequences are radical. No build step (definitions are stored compiled-by-hash). Renames are free (metadata-only). Dependency conflicts are eliminated by construction (two libraries defining `map` are different hashes). Distributed computation is trivial (ship the bytecode tree by hash, dependencies sync on demand). Cross-reference: `COMPILERS.md §18.3` covers Unison from the incremental-compilation angle.

Source: https://www.unison-lang.org/docs/the-big-idea/

### 12.2. Salsa — Memoized Query Values as IR

Salsa is the incremental computation framework behind rust-analyzer. The "IR" in Salsa is the memoized graph of query values: every query result (parsed AST, resolved name, inferred type, computed MIR) is cached and identified by its inputs. When an input changes, dependent query results are invalidated; everything else is reused.

This is IR-as-database: the rust-analyzer compiler's intermediate state isn't a tree or graph in memory but a set of memoized facts in Salsa's storage. Querying for a type triggers lazy computation; storing the result makes it durable for later queries. Cross-reference: `COMPILERS.md §18.1` covers Salsa from the incremental-architecture angle.

Source: https://github.com/salsa-rs/salsa

### 12.3. Lean 4 — Persistent Arrays as Compiler IR

Lean 4's compiler uses *persistent arrays* (HAMT-style tries with a tail buffer that can be mutated in place under unique reference count) pervasively in its elaborator and tactic engine. The compiler's intermediate state — the list of declared definitions, the tactic-mode goals, the elaborator's metavariable assignments — lives in persistent arrays that share structure across versions.

This makes Lean's IR fast to update and trivially undoable: rolling back a tactic is just dropping a reference to the new persistent state. Combined with Lean's compile-time RC (`MEMORY.md §3.6`), in-place mutation happens whenever the persistent array is provably unique-referenced. Cross-reference: `MEMORY.md §3.6` covers Lean 4's RC mechanics.

Source: https://github.com/leanprover/lean4/blob/master/src/include/lean/lean.h

---

## 13. Domain-Specific / Non-Traditional IRs

Some representations are not general-purpose IRs but encode a specific domain — instruction selection, scheduling, syntactic analysis, security verification, image-processing pipelines. The chapter's distinguishing axis is *what kind of computation the representation describes*: a rewrite system (ISLE, Datalog, SmPL, Stratego), a separation of concerns (Halide algorithm/schedule), a syntax schema (ungrammar, ASDL), a specification (TLA+), or a hardware model (ISLA). All earn their place because they show that "language representation" extends well beyond compiler IRs.

### 13.1. ISLE — Cranelift Instruction-Selection DSL

ISLE (Instruction Selection / Lowering Expressions) is Cranelift's DSL for writing instruction-selection rules. Each rule is a typed term-rewrite from CLIF (§6.2) input patterns to machine-instruction outputs. The ISLE compiler merges all rules into a decision tree, sharing matching work across rules.

The point: instruction selection rules are themselves a representation, and they should be readable, type-checked, and verifiable. Hand-written instruction selectors (LLVM SelectionDAG, GCC machine descriptions) are notoriously hard to maintain; ISLE makes them declarative. Cross-reference: `COMPILERS.md §13.2` covers ISLE from the codegen-pipeline angle.

Source: https://github.com/bytecodealliance/wasmtime/blob/main/cranelift/codegen/src/isle/README.md

### 13.2. ungrammar — CST Schema as Representation

ungrammar (covered in §3.7 above) is also worth naming as a domain-specific representation: it represents a *syntax schema* in a form that generators can consume. The schema is the code; visitors, tree types, and accessors are emitted from it. This is the "schema as ground truth" pattern at the syntactic level.

The contribution is the same as ASDL's: separating tree-shape design from parser implementation. ungrammar is more recent and more closely tied to rowan/rust-analyzer; ASDL is older and more language-agnostic. Both occupy the same design slot.

Source: https://rust-analyzer.github.io/blog/2020/10/24/introducing-ungrammar.html

### 13.3. Datalog as Program Representation — Soufflé

Soufflé compiles Datalog programs to efficient C++ for static analysis. The "IR" here is *the Datalog program itself*: rules declare what facts are derivable, and the engine derives all consequences. Pointer analysis, type inference, security analysis, and compiler optimizations have all been encoded as Datalog programs over Soufflé.

Soufflé is the production-grade Datalog engine for compiler-related uses (the academic ancestor is Bddbddb). The contribution is showing that program analysis can be expressed declaratively as Datalog rules over a relational schema, and that the engine can derive consequences faster than hand-written analyses.

Source: https://souffle-lang.github.io/

### 13.4. Coccinelle SmPL — Semantic Patch Language

Coccinelle (Lawall, Muller, Padioleau, et al.) is a tool for *transforming* C code by writing semantic patches in SmPL (Semantic Patch Language). A SmPL patch describes a code transformation as a pair of `before` and `after` patterns over the AST, parameterized by metavariables. Coccinelle finds every occurrence in the codebase and applies the transformation.

The IR is the semantic patch itself: a representation of "the change to make." Coccinelle is widely used for Linux kernel API migrations; tens of thousands of kernel commits have been generated by SmPL patches. The pattern generalizes: refactoring tools (Comby, fastmod), rewrite-driven optimizers, and security patchers all benefit from "the transformation" being a first-class object.

Source: https://coccinelle.gitlabpages.inria.fr/website/

### 13.5. TLA+ Specifications as IRs

TLA+ specifications are not IRs in the compilation sense — TLA+ is a specification language for concurrent and distributed systems, not a programming language. But the specifications themselves are representations: state machines with explicit invariants, expressed in mathematical logic, queryable by the TLC model checker.

The connection to IRs: TLC produces a finite-state model from the spec, and its outputs (state graphs, counterexample traces) are themselves representations the user navigates. TLA+ Toolbox's Trace Explorer (`DEBUGGERS.md §12.1`) treats counterexamples as interactive debuggable artifacts. The lesson: a specification language can play an IR-like role for verification tools.

Source: https://lamport.azurewebsites.net/tla/tla.html

### 13.6. Stratego / Spoofax — Term-Rewriting Representations

Stratego is a strategic term-rewriting language; Spoofax is the language workbench built on it. Programs are represented as terms (similar to ASTs), and transformations are strategies — composable rewrite rules with traversal control. The "IR" is the term tree plus the strategy that operates on it.

Stratego/Spoofax has been used for whole-language definitions (parser, type-checker, code generator, IDE features all expressed as rewrites). The contribution is showing that compilation can be expressed as term rewriting, with the rewrite engine providing the dispatch and traversal infrastructure. Production users include MetaBorg and Rascal (a related language workbench).

Source: https://www.spoofax.dev/

### 13.7. Halide — Algorithm / Schedule Split

Halide's representation explicitly separates the *algorithm* (what to compute) from the *schedule* (how to compute it: tile size, vectorization, parallelism, storage layout). The same algorithm can be re-scheduled without touching the algorithm code, exploring an enormous optimization search space.

This algorithm/schedule split is a distinctive IR design: most compilers embed scheduling decisions within the IR (loop nests, pragmas, layout choices), and changing them requires rewriting the program. Halide's separation lets auto-tuners (Halide's autoscheduler, Adams et al.) explore schedules automatically while the algorithm remains stable. Cross-reference: `COMPILERS.md §15.1` covers Halide from the polyhedral-compilation angle.

Source: https://halide-lang.org/

### 13.8. ISLA — CHERI ISA Specification IR

ISLA is a tool for executing instructions specified in the Sail ISA description language symbolically, used heavily in CHERI verification work. The IR here is the *Sail specification* of an ISA — a formal description of every instruction's semantics, expressed in Sail's typed functional language.

Sail/ISLA's contribution to representations: an ISA can be a representation, queryable by symbolic-execution tools, formally verifiable, and the source of multiple downstream artifacts (emulators, decoders, formal models). ARM, RISC-V, MIPS, and CHERI all have Sail specifications; ISLA executes them for verification and bug-finding. Cross-reference: `MEMORY.md §5.6` covers CHERI hardware capabilities.

Source: https://github.com/rems-project/isla

### 13.9. Bril — JSON-Encoded IR

Bril (introduced in §6.8) deserves a second mention here for its distinctive *encoding choice*: JSON. Most IRs have a textual or binary form; Bril's wire format is JSON. Tools, optimizers, and analyzers can be written in any language that can parse JSON — Python, JavaScript, Rust, OCaml, Haskell. The didactic point is that an IR's representation can itself be a non-traditional choice that lowers the barrier to participation.

Source: https://capra.cs.cornell.edu/bril/

---

## 14. Forth-Style Direct Representations

Forth's representation tradition is unlike anything in the compiler-IR mainstream. Programs are sequences of dictionary-entry references; "compilation" is concatenating addresses; "interpretation" is dispatching through them. The chapter's distinguishing axis is *how dispatch works*: indirect through an instruction-pointer table (DTC), through one extra indirection (ITC), or via subroutine calls (STC). The endpoint is colorForth and arrayForth, where the source representation IS the parsed program — no translation pass exists. Cross-reference: `COMPILERS.md §33` covers Forth implementations from the compiler angle; here the focus is the direct-representation tradition.

### 14.1. Direct Threaded Code (DTC)

In direct threaded code, a compiled Forth word is a sequence of *addresses of machine code routines*. The interpreter inner loop is "fetch next address, jump to it, the routine ends with NEXT which fetches the next address." Each primitive is implemented as machine code; the threaded code is just an array of pointers.

DTC is the simplest Forth dispatch and the historical default. Modern Forths (GForth, VFX) use DTC for rapid prototyping and fall back to it when advanced techniques don't apply. The representation is exquisitely compact — a Forth program is literally a list of addresses, with no per-instruction overhead beyond the address itself.

Source: https://www.bradrodriguez.com/papers/moving1.htm

### 14.2. Indirect Threaded Code (ITC)

Indirect threaded code adds one indirection: compiled words are sequences of addresses pointing to *code-field words* that themselves point to machine code. This level lets Forth treat user-defined words and primitives uniformly — both have a code field, and the code field is what the inner loop dispatches on.

ITC enables `DOES>`, the operator that lets a user-defined word install custom behavior for words it creates (`COMPILERS.md §12.9`). A constant defined as `42 CONSTANT ANSWER` works because `CREATE` allocates dictionary space, and `DOES> @` installs a code field that fetches from that space. ITC's extra indirection is what makes this transparent.

Source: https://www.bradrodriguez.com/papers/moving1.htm

### 14.3. Subroutine Threaded Code (STC)

In subroutine threaded code, a compiled word is a sequence of `CALL` instructions — actual machine-code call instructions, not data pointers. The CPU's call/return machinery does the dispatch; no inner loop, no NEXT routine. SwiftForth and VFX Forth use STC heavily; Mecrisp and zeptoforth do too.

STC removes the dispatch overhead at the cost of larger code size (a `CALL` is 5 bytes on x86-64; a threaded-code address is 8 bytes — actually larger, but one execute removes a dispatch). On modern CPUs with deep branch predictors, STC's predictable call/return pattern is faster than ITC/DTC's data-driven dispatch. Cross-reference: `COMPILERS.md §33.3` covers SwiftForth.

Source: https://www.bradrodriguez.com/papers/moving1.htm

### 14.4. Dictionary Entries as Program Representation

Forth's fundamental representation is the *dictionary*: a linked list of named entries, each containing a name, a flag word (immediate, hidden, etc.), a code field, and a parameter field. The program is a sequence of dictionary references; compilation extends the dictionary; interpretation walks it.

This is not an IR layered atop a parser tree — it IS the program representation. There is no AST in classical Forth; the source is interpreted directly into dictionary entries via the text-interpreter (`PARSERS.md §6.2`). The dictionary is simultaneously the symbol table, the code store, and the executable form. Cross-reference: `MODULES.md §9.10` covers Forth wordlists as the module system.

Source: https://forth-standard.org/standard/dictionaries

### 14.5. colorForth — Pre-Parsed Source Representation

Chuck Moore's colorForth inverts the parser-output relationship entirely. The editor stores source as 32-bit cells where the upper 4 bits encode token class (color-coded in display: green=interpret, red=compile, yellow=execute, etc.) and the lower 28 bits encode the symbol. The on-disk file *is* the parsed AST.

There is no surface text-to-tokens pass; the editor produces tokens directly, and the compiler is a trivial walker over the pre-parsed cells. This is the most extreme "representation as ground truth" in the survey: the program form on disk is the same form the compiler consumes. Cross-reference: `PARSERS.md §6.2` covers colorForth's parsing model.

Source: https://colorforth.github.io/parsed.html

### 14.6. arrayForth on GA144

arrayForth, Chuck Moore's language for the GreenArrays GA144 multicomputer, takes the colorForth model further. The GA144's 144 small CPUs each have 18-bit memory words that pack several small instruction fields per word; the language is designed around the chip's specific instruction-slot constraints. Source representation is colorForth-style pre-parsed cells, but with even tighter coupling between language-level token classes and machine-level instruction slots.

This is PL/ISA co-design taken to its limit: the source representation, the language semantics, the compiler, and the hardware ISA were all designed together. The lesson is that representation choices propagate through the whole stack, and that designing them in isolation leaves performance on the table.

Source: https://www.greenarraychips.com/home/documents/greg/GA144.htm

---

## 15. Target-Adjacent IRs

Target-adjacent IRs sit between high-level optimization and machine code. The chapter's distinguishing axis is *how much target structure they expose*: machine instructions but in SSA form (LLVM Machine IR), expression trees over machine operations (GCC RTL), structured high-level abstractions in a target-agnostic shell (GIMPLE), or the program's executable form itself (Wasm, DEX, ELF/Mach-O/COFF object files).

### 15.1. LLVM Machine IR (MIR)

LLVM's Machine IR is a *target-specific* SSA IR: still SSA, but with target-specific instruction opcodes (x86 `MOVQ`, ARM `LDR`), target register classes, and target-specific scheduling models. MIR is what the codegen passes (register allocation, scheduling, peephole optimization, code emission) operate on after lowering from LLVM IR.

The LLVM team uses "MIR" for both the in-memory form and a textual serialization (`.mir` files), the latter mostly for testing. Note: LLVM's MIR is unrelated to Rust's MIR (§5.1) — same acronym, very different IRs, named within their respective projects without coordination.

Source: https://llvm.org/docs/MIRLangRef.html

### 15.2. GCC GIMPLE and RTL

GCC has two target-adjacent IRs: GIMPLE (high-level, target-agnostic) and RTL (Register Transfer Language, target-specific). GIMPLE is SSA-form three-address code with C-like type system; RTL is an S-expression-based language modeling machine instructions as register transfers (`(set (reg:SI 0) (plus:SI (reg:SI 1) (reg:SI 2)))`).

The two-IR design predates LLVM's MIR by decades. GIMPLE is the substrate for most GCC optimization passes (loop transformations, scalar optimizations, vectorization). RTL is for register allocation, scheduling, and machine-code emission. The transition between GIMPLE and RTL happens after target-independent optimization.

Source: https://gcc.gnu.org/onlinedocs/gccint/GIMPLE.html and https://gcc.gnu.org/onlinedocs/gccint/RTL.html

### 15.3. Cranelift MachInst

Cranelift's MachInst is the target-specific IR that CLIF lowers to. It's a vector of machine instructions in basic-block order, with virtual registers (assigned to physical registers by regalloc2). MachInst is target-specific (separate definitions for x86-64, ARM64, RISC-V, s390x) but the code-emission framework is shared.

The contribution: MachInst is *flat* (a vector, not a graph) and dense (32-bit operand indices), matching Cranelift's compile-speed priority. Where LLVM MIR can be a graph with arbitrary cross-references, Cranelift MachInst is a linear sequence with predictable iteration.

Source: https://github.com/bytecodealliance/wasmtime/tree/main/cranelift/codegen/src/machinst

### 15.4. WebAssembly as Target IR

Wasm (§9.8) is target-adjacent in the sense that it's the executable form many compilers target. Rust, C/C++ (Emscripten), Go (TinyGo, GOARCH=wasm), AssemblyScript, Zig — all emit Wasm. The Wasm module is what runs.

The implication: Wasm's design constraints (structured control, type validation, bounded memory) propagate back to source-language compilers. A Rust function compiled to Wasm cannot use arbitrary `goto`, cannot read uninitialized memory, cannot exceed Wasm's type system. The IR-to-target transition forces source-language designs to fit Wasm's shape.

Source: https://webassembly.github.io/spec/core/

### 15.5. DEX as Target Form

Android's DEX (§9.3) is target-adjacent for the Java/Kotlin compiler pipeline: javac/kotlinc emit JVM `.class` files, then the `d8` (or `dx`) tool translates them to DEX. ART then consumes DEX. The two-step (Java bytecode → DEX) reflects DEX's later arrival; modern Android tooling can emit DEX more directly.

DEX as a *target* (not as an intermediate form) is what gives Android its install-time-AOT model: ART compiles DEX to native at install or first-run, caching the result in `/data/dalvik-cache`. The DEX-to-native compilation is fast (~seconds per app) because DEX is already register-based and analysis-friendly.

Source: https://source.android.com/docs/core/runtime/dex-format

### 15.6. ELF / Mach-O / COFF as Program Representation

Object file formats — ELF (Linux/BSD), Mach-O (macOS/iOS), COFF/PE (Windows) — are themselves program representations. Sections for text, data, BSS, debug info, symbol tables, relocations; metadata for build IDs, linker hints, code signing. The file is what the operating system loads and executes.

For language designers, the object file format constrains what compilers can express. Stack-unwind tables (DWARF `.eh_frame`, SFrame, ORC), debug info (`.debug_*`), build IDs, symbol exports — all live in section conventions defined by the format. A new language emitting native code must speak ELF/Mach-O/COFF or rely on a backend (LLVM, Cranelift, GCC) that does.

Source: https://refspecs.linuxfoundation.org/elf/elf.pdf and https://github.com/aidansteele/osx-abi-macho-file-format-reference

---

## 16. Summary of Representation Techniques

Rows grouped by chapter, in chapter order. Each row's Examples column ends with the subsection anchor `(§N.M)`.

### 16.1. Concrete syntax trees and lossless representations

| Technique | Storage Cost | Key Trade-off | Examples |
|---|---|---|---|
| Roslyn red-green | Width-only green nodes; ephemeral red layer | Sub-second incremental edits; class-hierarchy API | C# / VB.NET (§2.1) |
| rowan red-green + interning | Hashed-deduplicated green nodes; thin handles | Same as Roslyn + workspace-wide structural sharing | rust-analyzer + Typst, Lelwel (§2.2) |
| Byte-exact full-fidelity | Every comment/space preserved | Macro plugin substrate; large dependency footprint | SwiftSyntax (§2.3) |
| Binary buffer tree | Children as Uint16Array offsets | Browser-scale incrementality | Lezer / CodeMirror 6 (§2.4) |
| Error-tolerant CST | Byte-range nodes with ERROR/MISSING | Always-valid tree on any input | Tree-sitter (§2.5) |
| ASDL-driven lossless tree | Schema generates Python + C++ accessors | Source-faithful for shell semantics | Oil OSH (§2.6) |
| Schema-defined typed accessors | One ASDL file is the spec | Older than ungrammar; same idea | CPython AST, SML/NJ (§2.7) |

### 16.2. Abstract syntax trees

| Technique | Storage Cost | Key Trade-off | Examples |
|---|---|---|---|
| Postfix expression array | Flat reverse-Polish array | Cache locality; no random access | Cuik (§3.1) |
| Token-indexed AST | Indices into token list | Two-step source position resolution | Zig (§3.2) |
| Arena + 32-bit offsets | Half pointer per relation | O(1) access; bulk free | Rust `bumpalo`, many C parsers (§3.3) |
| Tagged-union ADT | Discriminant per node | Compiler-checked exhaustiveness | Rust `syn`, OCaml ADTs (§3.4) |
| Class-hierarchy AST | Subclass per syntactic form | Open extensibility; runtime dispatch | javac, Roslyn red layer (§3.5) |
| JSON-shaped AST | Per-node type discriminator | Untyped; trivially serializable | ESTree / JS tooling (§3.6) |
| Schema-derived CST API | Generators from one ungrammar file | Decouples parser from tree types | rust-analyzer ungrammar (§3.7) |
| First-class language objects | Heap nodes per language object | Macro-friendly; allocation pressure | RakuAST (§3.8) |

### 16.3. High-level / source-adjacent IRs

| Technique | Phase Goal | Key Trade-off | Examples |
|---|---|---|---|
| Desugared, name-resolved tree | Type checking + lints | Stable IDs across compilation | Rust HIR (§4.1) |
| Type-explicit, coercion-resolved | Stepping stone to MIR | Discards source structure | Rust THIR (§4.2) |
| Swift-specific SSA | ARC/devirt/specialization | Pre-LLVM optimization substrate | Swift SIL (§4.3) |
| Lazy semantic-model query | IDE introspection on demand | Computed per-question, not whole-program | C# Roslyn semantic model (§4.4) |
| AOT-oriented JS HIR | Hermes optimizer pre-bytecode | Optimized for ship-only-bytecode | Hermes HIR (§4.5) |
| Self-specializing AST as IR | Partial evaluation = compilation | One data structure for both phases | Truffle / GraalVM (§4.6) |
| Plugin-rewritten ESTree | Visitor passes mutate AST | Shape-stable across plugin pipeline | Babel (§4.7) |

### 16.4. Mid-level IRs

| Technique | Phase Goal | Key Trade-off | Examples |
|---|---|---|---|
| Borrow-check CFG IR | NLL/Polonius + drop elaboration | Multi-IR cascade complexity | Rust MIR (§5.1) |
| Pre-analysis untyped IR | Comptime evaluation substrate | Two-IR ZIR/AIR split | Zig ZIR (§5.2) |
| Post-analysis typed IR | LLVM-backend feed | Same as ZIR cascade | Zig AIR (§5.3) |
| Parametric MLIR layer | Pre-elaboration parametric IR | Serializable parametric code | Mojo KGEN/POP (§5.4) |
| Dual-target shared IR | One IR, two backends | Forces target-neutral semantics | Ballerina BIR (§5.5) |
| JS-aware SSA + LIR pair | Type-spec optimizer for JIT | Same problem as Turboshaft | IonMonkey MIR/LIR (§5.6) |
| Mid-tier deopt-rich SSA | Fast warm-tier code | Less expressive than top tier | V8 Maglev (§5.7) |
| Speculative DFG with OSR | Mid-tier between Baseline and FTL | Four-tier complexity | JavaScriptCore DFG (§5.8) |
| Region-based JIT IR | Per-region compilation | Avoids whole-function overhead | HHVM HHIR (§5.9) |
| MLIR-based JS IR for source-to-source | Region-preserved control + SSA | 99.9% AST round-trip | Google JSIR (§5.10) |

### 16.5. SSA-based IRs

| Technique | Graph Shape | Key Trade-off | Examples |
|---|---|---|---|
| Linear typed SSA | Basic blocks + φ functions | Industry standard; compile-time cost | LLVM IR (§6.1) |
| Compile-fast SSA | Dense indices + minimal types | ~10× faster than LLVM at 50–70% quality | Cranelift CLIF (§6.2) |
| Sea-of-Nodes graph | Data + control as edges | Maximum scheduling freedom; expensive | HotSpot C2 (§6.3) |
| Sea-of-Nodes JS-tuned | Type system + IC feedback | Top-tier peak; slow compile | V8 TurboFan (§6.4) |
| Linear SSA with side tables | Flat operation buffer | 30–40% faster compile than SoN | V8 Turboshaft (§6.5) |
| Trace-form SSA | Linear hot-path recording | Tight on hot loops; trace explosion risk | LuaJIT IR (§6.6) |
| Portable assembly SSA | Pre-codegen substrate | Multi-target without LLVM | GHC Cmm (§6.7) |
| JSON-encoded SSA | Wire format = IR | Pedagogical; minimal tooling | Bril (§6.8) |

### 16.6. CPS, ANF, and functional IRs

| Technique | Control Flow | Key Trade-off | Examples |
|---|---|---|---|
| Continuation-passing | Explicit continuation params | Uniform but verbose | Steele Rabbit, SML/NJ (§7.1) |
| Let-named ANF | Trivial-argument constraint | Simpler than CPS, same guarantees | Flanagan ANF (§7.2) |
| Typed lambda Core | Small specifiable IR | Stable optimization substrate | GHC Core (§7.3) |
| Strict-language ANF | Aggressive value-rep specialization | Unboxing-heavy optimizer | OCaml Flambda (§7.4) |
| Effect-typed direct-style | Effects as IR annotations | Purity-driven optimizations | Koka (§7.5) |

### 16.7. E-graphs and equality-saturating IRs

| Technique | Sharing Structure | Key Trade-off | Examples |
|---|---|---|---|
| Library-form e-graph | Deferred-rebuild operations | Production-grade; egg ecosystem | egg (§8.1) |
| Datalog-extended rewriting | Rules as Datalog over relational schema | Multi-pattern + recursive rewrites | egglog (§8.2) |
| Acyclic e-graph mid-end | Restricted form for predictable extraction | Largest production e-graph deployment | Cranelift e-graph (§8.3) |
| Region-based dataflow graph | Regions instead of CFG | Optimization simplicity; not in production | RVSDG (§8.4) |

### 16.8. Bytecode representations

| Technique | Dispatch Model | Key Trade-off | Examples |
|---|---|---|---|
| Stack-based typed bytecode | Implicit operand stack | Compact; ~47% more dispatch | JVM (§9.1) |
| Stack-based + value types + generics | Same as JVM + .NET features | Richer types preserved through CIL | .NET CIL (§9.2) |
| Register-based merged classes | Per-method register set | Smaller APK; mobile-tuned | Android DEX (§9.3) |
| BEAM register bytecode | Per-process heap operations | Hot-reloadable module boundaries | Erlang BEAM (§9.4) |
| Trace-JIT-tuned register | Fixed-width 32-bit ops | Interpreter within 2× of native | LuaJIT bytecode (§9.5) |
| Specializing adaptive bytecode | Type-rewritten opcodes | 10–60% speedup without JIT | CPython (§9.6) |
| Two-level Raku bytecode | MAST + MBC | Stable target + evolving runtime | MoarVM MAST/MBC (§9.7) |
| Structured-control stack bytecode | No goto; one-pass validation | Wasm portability + sandboxing | WebAssembly (§9.8) |
| Verifier-restricted bytecode | 11 regs, no unbounded loops | Safe in-kernel execution | Linux BPF (§9.9) |
| Region-JIT-feeding bytecode | Inline type observations | JIT bypasses warm-up | HHVM HHBC (§9.10) |
| AOT-only mobile JS bytecode | Build-time → device-load | Fast startup, slower steady-state | Hermes HBC (§9.11) |

### 16.9. Multi-level IR architectures

| Technique | Cascade Shape | Key Trade-off | Examples |
|---|---|---|---|
| Generic dialect framework | Arbitrary lowering paths | Reusable compiler infrastructure | MLIR (§10.1) |
| Two-tier target split | LLVM IR + Machine IR | Target-independent vs target-dependent | LLVM (§10.2) |
| Four-stage Rust pipeline | HIR → THIR → MIR → LLVM | Per-phase optimality; translation cost | rustc (§10.3) |
| Three-stage GHC pipeline | Core → STG → Cmm | Lazy-language operational layer | GHC (§10.4) |
| Two-stage OCaml pipeline | Lambda → Cmm | Strict-language minimal cascade | OCaml (§10.5) |

### 16.10. Effect-, region-, and capability-annotated IRs

| Technique | Annotation Carried | Key Trade-off | Examples |
|---|---|---|---|
| Region-effect lambda calculus | ρ regions + ε effects | Inference-tractable region discipline | MLKit RegionExp (§11.1) |
| Effect types on every arrow | `<effects>` in IR | Purity-driven optimization; complex types | Koka (§11.2) |
| Multiplicity-polymorphic arrows | `%m ->` arrows | Linear types in mainstream Haskell | Linear Haskell (§11.3) |
| Graded modal types | `a [n]` over a semiring | Co-effects beyond linearity | Granule (§11.4) |
| Quantitative type theory | 0/1/ω multiplicity | Linearity + erasure unified | Idris 2 (§11.5) |
| Three-mode IR (spec/proof/exec) | Erased ghost code in IR | Verification artifacts at zero runtime cost | Verus (§11.6) |
| Mechanized λRust | Coq-defined IR with operational semantics | Soundness theorem substrate | RustBelt (§11.7) |

### 16.11. Persistent and content-addressed IRs

| Technique | Identity Source | Key Trade-off | Examples |
|---|---|---|---|
| Hash-addressed AST | SHA of subtree | Free renames; ecosystem friction | Unison (§12.1) |
| Memoized query graph | Input hash | Incremental compilation native | Salsa / rust-analyzer (§12.2) |
| Persistent arrays as IR | Structural sharing under unique RC | Fast undo; mutates when unique | Lean 4 (§12.3) |

### 16.12. Domain-specific / non-traditional IRs

| Technique | Domain | Key Trade-off | Examples |
|---|---|---|---|
| Term-rewrite DSL | Instruction selection | Type-checked declarative rules | ISLE (§13.1) |
| Schema-as-IR for syntax trees | CST API generation | Decouples parser from tree | ungrammar (§13.2) |
| Datalog program as IR | Static analysis | Declarative deduction; engine cost | Soufflé (§13.3) |
| Semantic patch language | Code transformation | Refactoring as first-class artifact | Coccinelle SmPL (§13.4) |
| Specification as queryable IR | Verification | Spec semantics drive model checker | TLA+ (§13.5) |
| Term + strategy IR | Whole-language workbench | Rewrite-driven compilation | Stratego / Spoofax (§13.6) |
| Algorithm/schedule split | Image processing | Auto-tunable schedule space | Halide (§13.7) |
| Sail ISA spec as IR | Hardware verification | Symbolic execution of ISA semantics | ISLA / CHERI (§13.8) |
| JSON-encoded IR | Pedagogy | Minimal tooling barrier | Bril (§13.9) |

### 16.13. Forth-style direct representations

| Technique | Dispatch Model | Key Trade-off | Examples |
|---|---|---|---|
| Direct threaded code | Address array + NEXT routine | Compact; fastest threaded baseline | DTC Forths (§14.1) |
| Indirect threaded code | Address → code-field → machine | Enables `DOES>` uniformly | ITC Forths (§14.2) |
| Subroutine threaded code | Native CALL/RET dispatch | Branch-predictor friendly | SwiftForth, VFX, Mecrisp (§14.3) |
| Dictionary as program form | Linked list of named entries | No AST layer; symbol = code | All classical Forth (§14.4) |
| Pre-parsed source on disk | 32-bit color-tagged cells | Editor produces tokens, no parser | colorForth (§14.5) |
| Source = ISA-shaped tokens | Cells match instruction slots | PL/ISA co-design | arrayForth on GA144 (§14.6) |

### 16.14. Target-adjacent IRs

| Technique | Target Coupling | Key Trade-off | Examples |
|---|---|---|---|
| Target-specific SSA MIR | Per-target instructions in SSA | Codegen substrate after LLVM IR | LLVM Machine IR (§15.1) |
| Two-IR target pipeline | GIMPLE high + RTL low | Predates LLVM by decades | GCC (§15.2) |
| Linear MachInst | Vector of target instructions | Cranelift compile-speed priority | Cranelift MachInst (§15.3) |
| Wasm as target | Structured control + verifier | Source-language design constraint | Wasm-targeting compilers (§15.4) |
| DEX as install-time AOT input | Register-based merged classes | Install-time native compilation | Android ART (§15.5) |
| Object-file format as program form | ELF/Mach-O/COFF sections | OS-loadable representation | Native binaries (§15.6) |

---

## 17. References

References are grouped by the chapter that first cites them. Within each chapter they roughly follow subsection order.

### Chapter 2 — Concrete Syntax Trees and Lossless Representations

1. Roslyn Red-Green Trees (Eric Lippert) — https://ericlippert.com/2012/06/08/red-green-trees/
2. Microsoft Learn — Work with the syntax model (Roslyn) — https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-syntax
3. rowan (rust-analyzer) — https://github.com/rust-analyzer/rowan
4. Introducing ungrammar (rust-analyzer blog) — https://rust-analyzer.github.io/blog/2020/10/24/introducing-ungrammar.html
5. swift-syntax — https://github.com/swiftlang/swift-syntax
6. SE-0389 Attached Macros — https://github.com/swiftlang/swift-evolution/blob/main/proposals/0389-attached-macros.md
7. Lezer (Marijn Haverbeke) — https://marijnhaverbeke.nl/blog/lezer.html
8. Tree-sitter — https://tree-sitter.github.io/tree-sitter
9. From AST to Lossless Syntax Tree (Oil Shell) — https://www.oilshell.org/blog/2017/02/11.html
10. ASDL — Abstract Syntax Description Language (Wang, Appel, Korn, Serra) — https://www.cs.princeton.edu/research/techreps/TR-554-97
11. CPython `ast` module documentation — https://docs.python.org/3/library/ast.html

### Chapter 3 — Abstract Syntax Trees

1. Cuik (RealNeGate) — https://github.com/RealNeGate/Cuik
2. Zig compiler AST/std.zig — https://github.com/ziglang/zig/tree/master/lib/std/zig
3. bumpalo arena allocator (Rust) — https://docs.rs/bumpalo/
4. syn (David Tolnay) — https://github.com/dtolnay/syn
5. Java Language Specification — https://docs.oracle.com/javase/specs/jls/se21/html/
6. ESTree spec — https://github.com/estree/estree
7. RakuAST documentation — https://docs.raku.org/type/RakuAST

### Chapter 4 — High-Level / Source-Adjacent IRs

1. rustc HIR — https://rustc-dev-guide.rust-lang.org/hir.html
2. rustc THIR — https://rustc-dev-guide.rust-lang.org/thir.html
3. Swift SIL specification — https://github.com/swiftlang/swift/blob/main/docs/SIL.rst
4. Microsoft Learn — Roslyn semantic analysis — https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/get-started/semantic-analysis
5. Hermes Optimizer — https://github.com/facebook/hermes/tree/main/lib/Optimizer
6. GraalVM Truffle Language Implementation Framework — https://www.graalvm.org/latest/graalvm-as-a-platform/language-implementation-framework/
7. @babel/parser — https://babeljs.io/docs/babel-parser

### Chapter 5 — Mid-Level IRs

1. rustc MIR Guide — https://rustc-dev-guide.rust-lang.org/mir/index.html
2. Introducing MIR (Rust blog) — https://blog.rust-lang.org/2016/04/19/MIR.html
3. Zig ZIR source — https://github.com/ziglang/zig/blob/master/src/Zir.zig
4. Zig AIR source — https://github.com/ziglang/zig/blob/master/src/Air.zig
5. Mojo POP dialect internal docs — https://github.com/modular/modular/blob/main/mojo/stdlib/docs/internal/pop_dialect.md
6. Peering into the Ballerina Intermediate Representation — https://medium.com/ballerina-techblog/peering-into-the-ballerina-intermediate-representation-8e97361a070e
7. SpiderMonkey IonMonkey wiki — https://wiki.mozilla.org/IonMonkey
8. V8 Maglev introduction — https://v8.dev/blog/maglev
9. Introducing the WebKit FTL JIT — https://webkit.org/blog/3362/introducing-the-webkit-ftl-jit/
10. HHVM JIT source tree — https://github.com/facebook/hhvm/tree/master/hphp/runtime/vm/jit
11. Google JSIR — https://github.com/google/jsir
12. CASCADE: LLM-Powered JavaScript Deobfuscator at Google (arXiv 2507.17691) — https://arxiv.org/abs/2507.17691

### Chapter 6 — SSA-Based IRs

1. LLVM Language Reference Manual — https://llvm.org/docs/LangRef.html
2. Cranelift source tree — https://github.com/bytecodealliance/wasmtime/tree/main/cranelift
3. Sea of Nodes — Click "From Quads to Graphs" (Oracle archive) — https://www.oracle.com/technical-resources/articles/java/architect-evans-pt1.html
4. V8 — Launching Ignition and TurboFan — https://v8.dev/blog/launching-ignition-and-turbofan
5. V8 Turboshaft blog — https://v8.dev/blog/turboshaft
6. LuaJIT compiler design specification (freelists archive) — https://www.freelists.org/post/luajit/Compiler-Design-Specification
7. GHC Cmm wiki — https://gitlab.haskell.org/ghc/ghc/-/wikis/commentary/compiler/cmm-type
8. Bril (Cornell CS 6120) — https://capra.cs.cornell.edu/bril/

### Chapter 7 — CPS, ANF, and Functional IRs

1. Compiling with Continuations (Appel, 1992) — https://www.cs.princeton.edu/~appel/papers/cpcps.pdf
2. The Essence of Compiling with Continuations (Flanagan et al., PLDI 1993) — https://users.soe.ucsc.edu/~cormac/papers/pldi93.pdf
3. GHC Core source — https://gitlab.haskell.org/ghc/ghc/-/blob/master/compiler/GHC/Core.hs
4. OCaml Manual — Flambda — https://v2.ocaml.org/manual/flambda.html
5. Algebraic Effects Handlers Go Mainstream (Microsoft Research) — https://www.microsoft.com/en-us/research/publication/algebraic-effects-handlers-go-mainstream/
6. Koka Programming Language — https://koka-lang.github.io/koka/doc/book.html

### Chapter 8 — E-Graphs and Equality-Saturating IRs

1. egg (Equality Saturation Library) — https://egraphs-good.github.io/
2. egglog — https://github.com/egraphs-good/egglog
3. Cranelift e-graph RFC — https://github.com/bytecodealliance/rfcs/blob/main/accepted/cranelift-egraph.md
4. RVSDG: An Intermediate Representation for Optimizing Compilers (Reissmann et al., 2020) — https://dl.acm.org/doi/10.1145/3391902

### Chapter 9 — Bytecode Representations

1. Java Virtual Machine Specification — https://docs.oracle.com/javase/specs/jvms/se21/html/
2. ECMA-335 (Common Language Infrastructure) — https://ecma-international.org/publications-and-standards/standards/ecma-335/
3. Android DEX format — https://source.android.com/docs/core/runtime/dex-format
4. Erlang Code Loading — https://www.erlang.org/doc/system/code_loading.html
5. LuaJIT Bytecode 2.0 — http://wiki.luajit.org/Bytecode-2.0
6. PEP 659: Specializing Adaptive Interpreter — https://peps.python.org/pep-0659/
7. MoarVM bytecode documentation — https://github.com/MoarVM/MoarVM/blob/master/docs/bytecode.markdown
8. WebAssembly Specification — Core — https://webassembly.github.io/spec/core/
9. Linux BPF documentation — https://docs.kernel.org/bpf/
10. HHBC specification — https://github.com/facebook/hhvm/blob/master/hphp/doc/bytecode.specification
11. Hermes design document — https://github.com/facebook/hermes/blob/main/doc/Design.md

### Chapter 10 — Multi-Level IR Architectures

1. MLIR — https://mlir.llvm.org/
2. LLVM Machine IR Language Reference — https://llvm.org/docs/MIRLangRef.html
3. GHC generated code wiki — https://gitlab.haskell.org/ghc/ghc/-/wikis/commentary/compiler/generated-code
4. OCaml C interface manual — https://v2.ocaml.org/manual/intfc.html

### Chapter 11 — Effect-, Region-, and Capability-Annotated IRs

1. MLKit — https://elsman.com/mlkit/
2. Linear Haskell (POPL 2018) — https://arxiv.org/abs/1710.09756
3. Granule project — https://granule-project.github.io/
4. Idris 2 documentation — https://idris2.readthedocs.io/
5. Verus repository — https://github.com/verus-lang/verus
6. RustBelt POPL 2018 — https://plv.mpi-sws.org/rustbelt/popl18/paper.pdf

### Chapter 12 — Persistent and Content-Addressed IRs

1. Unison: The Big Idea — https://www.unison-lang.org/docs/the-big-idea/
2. Salsa Incremental Computation Framework — https://github.com/salsa-rs/salsa
3. Lean 4 lean.h source — https://github.com/leanprover/lean4/blob/master/src/include/lean/lean.h

### Chapter 13 — Domain-Specific / Non-Traditional IRs

1. Cranelift ISLE README — https://github.com/bytecodealliance/wasmtime/blob/main/cranelift/codegen/src/isle/README.md
2. Soufflé Datalog engine — https://souffle-lang.github.io/
3. Coccinelle — https://coccinelle.gitlabpages.inria.fr/website/
4. TLA+ home (Lamport) — https://lamport.azurewebsites.net/tla/tla.html
5. Spoofax language workbench — https://www.spoofax.dev/
6. Halide — https://halide-lang.org/
7. ISLA / Sail (CHERI) — https://github.com/rems-project/isla

### Chapter 14 — Forth-Style Direct Representations

1. Brad Rodriguez — Moving Forth Part 1 (Threading models) — https://www.bradrodriguez.com/papers/moving1.htm
2. Forth-2012 Standard — Dictionaries — https://forth-standard.org/standard/dictionaries
3. colorForth parsed source representation — https://colorforth.github.io/parsed.html
4. GreenArrays GA144 documentation — https://www.greenarraychips.com/home/documents/greg/GA144.htm

### Chapter 15 — Target-Adjacent IRs

1. GCC GIMPLE — https://gcc.gnu.org/onlinedocs/gccint/GIMPLE.html
2. GCC RTL — https://gcc.gnu.org/onlinedocs/gccint/RTL.html
3. Cranelift MachInst source — https://github.com/bytecodealliance/wasmtime/tree/main/cranelift/codegen/src/machinst
4. ELF Specification (Linux Foundation) — https://refspecs.linuxfoundation.org/elf/elf.pdf
5. Mach-O File Format Reference — https://github.com/aidansteele/osx-abi-macho-file-format-reference
