# Parsers

Research on parser architectures, source location strategies, AST representations, and error recovery across languages and toolchains.

This document focuses on the **front end**: everything from characters to a usable syntax tree. Representation entries here are scoped to parser output and parse-time data flow; the broader CST/AST/IR catalogue lives in `REPRESENTATIONS.md`. Everything downstream — semantic analysis, IR, code generation, and runtime concerns — is in `COMPILERS.md`. Debug-info encoding formats (DWARF state machine, JS Source Maps, JVM `LineNumberTable`, CPython PEP 657) are compiler-output concerns and live in `COMPILERS.md` as well. The structure *above* files — module systems, import semantics, package boundaries, build-graph formation — lives in `MODULES.md`.

---

## 1. Source Location Strategies

Techniques for cheaply attaching file and line/column information to AST nodes without dominating the tree's memory footprint or slowing the parser. The subsections below vary along one primary axis: how much per-node storage the strategy pays, trading that against the cost of resolving a byte offset back to a human-readable line/column on demand. Entries span spans-per-node (rustc, swc, Go, Cuik), width-only or token-indexed designs that store nothing absolute (Roslyn, rowan, Zig), and the shared binary-search line-table machinery that backs most of them.

### 1.1. Spans on AST Nodes — rustc, swc, Go, Cuik

**rustc** went through three iterations of span size: 16 bytes → 4 bytes → 8 bytes. The current compact `Span` is 8 bytes and stores common byte-position and hygiene-context cases inline; rare cases spill to an interner rather than carrying a full `SpanData` everywhere. A separate `SourceMap` stores line-start offsets and converts byte positions to line/column lazily via binary search. The key decision: store byte offsets everywhere, compute line/column only when needed for diagnostics. This avoids the cost of tracking newlines during parsing.

**swc** mirrors rustc: `Span { lo: BytePos(u32), hi: BytePos(u32), ctxt: SyntaxContext }` = 12 bytes per node. `BytePos(0)` is reserved for compiler-synthesized spans. The cost is real — on a large AST with millions of nodes, spans alone can consume tens of megabytes.

**Go** uses compact `token.Pos` integers throughout the AST rather than storing full spans everywhere. All files in a compilation share a virtual address space via `FileSet.AddFile(name, base, size)`. Each file occupies `[base, base+size]`. Resolution is a binary search on the `FileSet`, then on the file's line-start table. Many AST nodes store a primary start position and compute `End()` structurally, while other structs store additional token positions for delimiters, operators, literals, braces, or parentheses. This is still space-efficient compared with full `(lo, hi)` spans, but it is not a strict "one position per node" scheme.

**Cuik** packs source locations into `u32` with bit fields: 1 bit macro flag, 14 bits file ID, 17 bits file position. `SourceRange` is two of these = 8 bytes. Every `Stmt` and `Subexpr` carries a `SourceRange`. Line/column resolution uses a binary-searchable `line_map` per file. The bit-packing is impressively tight but limits file size to 128KB and file count to 16384 — workable for many hand-written C translation units, but risky for generated code, amalgamated libraries, or arbitrary-language source files.

Sources: https://rustc-dev-guide.rust-lang.org/diagnostics.html and https://rustdoc.swc.rs/swc_common/struct.Span.html and https://pkg.go.dev/go/token and https://pkg.go.dev/go/ast

### 1.2. No Stored Positions — Zig, Roslyn, rowan

Three production systems omit absolute positions from AST/tree nodes entirely. The position-strategy summary is here; full layout details live in §3.

**Zig** AST nodes store token indices rather than byte offsets, with tokens themselves storing a start offset — so position lookup is a two-step dereference. The strategy is enabled by Zig's pipeline: once the typed-IR layer ZIR (Zig Intermediate Representation) is emitted, the AST, token list, and source text can be freed. See §3.3.

**Roslyn** and **rowan** both store widths (character counts) on green nodes rather than absolute offsets, so a separate red layer can compute positions by summing widths from the root on demand. Per-node absolute-position storage is zero; the motivation is incremental reparse-without-invalidation. The full red-green layout, ownership model, and `TextRange` semantics are in §3.2.

Sources: https://github.com/ziglang/zig/tree/master/lib/std/zig and https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-syntax

### 1.3. Line Position Resolution — Cuik's `line_map` and Go's `FileSet`

Both Cuik and Go use the same fundamental approach for resolving byte offsets to line/column positions: a sorted array of line-start byte offsets. Given a byte position, binary search the array to find the line number (index of the greatest line-start ≤ position), then subtract the line-start from the position to get the column.

Construction is a single linear scan of the source (find all `\n` bytes, record their offsets). Resolution is O(log lines) per query. Memory is one `u32` per source line — typically 1–4KB per file.

Go's `FileSet` extends this to multiple files by giving each file a non-overlapping range in a virtual address space. A `token.Pos` from any file in the compilation can be resolved by first binary-searching the `FileSet` for the file, then binary-searching the file's line table. Two binary searches, constant per file.

> Note: the compiler-side counterparts — encoding these positions alongside compiled output (JVM `LineNumberTable`, CPython PEP 657, DWARF `.debug_line`, JS Source Maps) — are covered in `COMPILERS.md §5`.

---

## 2. Parser Architectures

This chapter catalogs the top-level parsing algorithms a language implementation can pick between. Subsection numbering follows the document's research-history accumulation rather than family order; the family-grouped index below is the navigational map. Entries differ along the grammar-expressiveness / performance trade-off: O(n) deterministic parsers at one extreme through cubic-worst-case Earley/GLL/GLR at the other, with incremental reparsers and SIMD scanners on separate axes entirely.

- **Expression / operator parsing**: §2.1 Pratt, §2.2 Precedence climbing, §2.27 shunting-yard and operator-precedence grammars
- **PEG family**: §2.3 PEG/packrat, §2.4 Pest, §2.5 LPeg
- **Classical deterministic parsers**: §2.25 recursive descent, §2.26 LL/LR/LALR/IELR
- **Generalized CFG parsers**: §2.6 GLL, §2.7 Tomita GLR, §2.8 Earley + Leo, §2.9 CYK/Valiant, §2.10 Parsing with derivatives, §2.28 ambiguity and SPPF
- **Incremental / editor-oriented**: §2.11 Tree-sitter, §2.12 Lezer (and §7.8 rust-analyzer's parser)
- **Fast lexing and structural scanning**: §2.13 Accelerated-Zig, §2.14 simdjson (and §5.3–§5.5 lexer generators)
- **Special models and extensibility**: §2.15 Meriyah, §2.16 Scannerless, §2.17 TCC, §2.18 Parser combinators, §2.19 ANTLR4 ALL(\*), §2.20 Ohm, §2.21 Layout-sensitive, §2.22 Extensible syntax, §2.23 syntax-parse, §2.29 syntax-directed translation, §2.30 beyond-CFG formalisms

### 2.1. Pratt Parsing — Top-Down Operator Precedence

Vaughan Pratt's 1973 algorithm for expression parsing assigns a "binding power" (integer precedence) to each operator. The parser consists of two functions per token: `nud` (null denotation, for prefix position) and `led` (left denotation, for infix/postfix position). The core loop is remarkably simple:

```
fn parse(min_bp):
    left = nud(next_token())
    while bp(peek()) > min_bp:
        left = led(left, next_token())
    return left
```

Bob Nystrom's explanation in "Pratt Parsers: Expression Parsing Made Easy" made the algorithm accessible to a much wider audience than Pratt's original paper. The key insight: recursive descent is natural for statements (which start with keywords), and Pratt parsing is natural for expressions (which start with operands). The two compose perfectly — use recursive descent at the statement level, Pratt parsing within expressions.

The main advantage is extensibility: adding a new operator requires only specifying its binding power and its `led` function. No grammar rewriting or precedence-table refactoring is required. This is why Pratt parsers dominate in language implementations that need to evolve their operator set.

Source: https://journal.stuffwithstuff.com/2011/03/19/pratt-parsers-expression-parsing-made-easy/
### 2.2. Precedence Climbing — The Parameterised Alternative to Pratt

**Precedence climbing** (attributed to Keith Clarke, Martin Richards, and later Theodore Norvell) is a closely related alternative to Pratt parsing (§2.1) for expression grammars. Instead of keeping a table of `nud` and `led` functions keyed by token, the parser is a single recursive function parameterised by a minimum precedence:

```
fn parse_expr(min_prec):
    left = parse_atom()
    while is_binop(peek()) and prec(peek()) >= min_prec:
        op = consume()
        next_min = prec(op) + (1 if left_assoc(op) else 0)
        right = parse_expr(next_min)
        left = mk_binop(op, left, right)
    return left
```

Eli Bendersky's 2012 post is the common English-language reference, and notes that **Clang's** `Parser::ParseExpression` (in `lib/Parse/ParseExpr.cpp`) is a production implementation: it calls `ParseCastExpression` for atoms and climbs precedence levels in exactly this shape. The equivalence with Pratt is not controversial — Norvell's 2016 update explicitly states precedence climbing and Top-Down Operator Precedence "are pretty much the same algorithm, formulated a bit differently." The practical difference is pedagogical and ergonomic: Pratt centres per-operator functions (extensibility feels like adding methods), precedence climbing centres a single control-flow function (extensibility is a table edit). For a language with a small, fixed operator set — C, C++, Rust expression position — precedence climbing is less code; for languages that add operators late (§2.22 extensible syntax, Haskell user-defined operators), Pratt's per-token dispatch is more natural.

Sources: https://eli.thegreenplace.net/2012/08/02/parsing-expressions-by-precedence-climbing and https://www.engr.mun.ca/~theo/Misc/exp_parsing.htm
### 2.3. PEG Parsing and Packrat Memoization

Parsing Expression Grammars (Bryan Ford, 2004) define syntax in terms of recognition rather than generation. The choice operator is ordered: `A / B` tries `A` first, and only tries `B` if `A` fails. This eliminates ambiguity by construction — every valid input has exactly one parse tree.

PEG parsers are naturally recursive descent, with one function per grammar rule. The problem: backtracking can cause exponential time. Packrat parsing solves this by memoizing every rule's result at every input position, guaranteeing linear time at the cost of O(input × rules) memory.

Recent PEG research explores two directions that matter for language tooling. One line handles left recursion through cycle detection and fixed-point iteration, avoiding the old rule that PEG grammars must be manually rewritten to remove left-recursive expression forms. Another line makes packrat-style memo tables incremental by storing parse results in edit-aware interval structures, so typical small edits avoid rebuilding the whole memo table. These results are promising, but they should be treated as research/tool-specific techniques rather than baseline PEG guarantees.

The practical limitation: packrat parsing's memory consumption. For a 1MB source file with 100 grammar rules, the memoization table is ~100MB. Various strategies exist (lazy memoization, bounded tables, selective memoization), but the space-time trade-off is fundamental.

Status (as of 2026-04): CPython has shipped `pegen`, its PEG parser generator, as the default parser since 3.9 (PEP 617); the old LL(1) parser was removed in 3.10. The PEG approach is the established CPython parser architecture, not an experimental side path.

Sources: https://we-like-parsers.github.io/pegen/peg_parsers.html and https://peps.python.org/pep-0617/ and https://web.cs.ucla.edu/~todd/research/pub.php?id=pepm08 and https://arxiv.org/abs/2104.11050
### 2.4. Pest — PEG Without Packrat Memoisation

pest is a Rust PEG parser generator (see §2.3 for the PEG formalism) emphasising accessibility and speed over theoretical guarantees. It follows PEG ordered-choice semantics: alternatives are tried in order, and a later alternative is considered only if the earlier one fails. However, repetitions and predicates are greedy and do not perform regex-style backtracking to make later expressions succeed. Generated parsers read like direct recursive-descent code rather than table-driven state machines.

Pest does not advertise packrat linear-time guarantees the way rust-peg's `#[cache]` attribute and peginator's opt-in memoization do. In practice pest behaves like a PEG recursive-descent interpreter of the grammar, trading worst-case complexity guarantees for smaller memory footprint and strong performance on typical inputs. For pathological inputs or grammars with costly ordered-choice/backtracking patterns, a memoizing alternative (pegen in CPython 3.9+, rust-peg with `#[cache]`) is the safer choice.

pest offers readable grammars, good error messages, and fast common-case parsing, at the cost of lacking an explicit packrat complexity guarantee for adversarial inputs.

Sources: https://pest.rs/ and https://github.com/pest-parser/pest
### 2.5. LPeg — PEGs Compiled to a Parsing Virtual Machine

Roberto Ierusalimschy's **LPeg** is Lua's PEG library, and its distinctive implementation choice is that the grammar is compiled not to recursive-descent code (§2.3, §2.4) nor to a packrat memoisation table, but to bytecode for a tiny **parsing virtual machine**. Medeiros and Ierusalimschy's 2008 DLS paper specifies the VM directly: instructions like `Char c`, `Choice L`, `Commit L`, `PartialCommit L`, `Jump L`, `Call L`, `Return`, and `Fail`, running on two stacks (a backtrack stack and a call stack). Each PEG operator maps to a handful of instructions — `A / B` becomes `Choice L1 ; <A> ; Commit L2 ; L1: <B> ; L2:`, with `Commit` discarding the backtrack entry on success.

The parsing machine gives LPeg a different performance profile than packrat PEG. There is no memoisation table, so worst-case complexity is exponential — but typical grammars run faster than interpreted packrat because the VM fits in instruction cache and the bytecode is compact. The 2009 SPE journal version integrates the VM design with the Lua API and captures patterns-as-first-class-values in the host language (a close relative of parser combinators, §2.18, but with a compiled runtime). LPeg has displaced Lua's original pattern library for serious text processing.

LPeg offers a compact, fast, allocation-light PEG runtime with clean semantics preservation — offset by no linear-time guarantee (no packrat), a VM-specific mental model for debugging, and tight coupling to Lua as the host.

Sources: https://www.inf.puc-rio.br/~roberto/docs/peg.pdf and http://www.inf.puc-rio.br/~roberto/lpeg/
### 2.6. GLL Parsing — Generalized Recursive Descent

GLL (Generalized LL) parsing, described by Scott and Johnstone (2010), extends recursive descent parsing to handle all context-free grammars, including left-recursive and ambiguous grammars. The key idea: when the parser reaches a point where multiple alternatives could apply, it forks, exploring all possibilities in parallel.

The two data structures that make this practical are the **graph-structured stack** (GSS) and the **Shared Packed Parse Forest** (SPPF). The GSS replaces the exponential forest of independent parser stacks with a DAG: stack tops that share a common prefix collapse into a single node, so equivalent parse states are not duplicated. The SPPF is the dual idea on the output side — common subtrees are shared and ambiguous alternatives are stored as packed nodes, keeping the forest polynomial. With these structures, GLL runs in cubic time (O(n³)) worst case and linear time on deterministic or near-deterministic grammar families. Unambiguous grammars are not automatically linear; some still require quadratic or cubic work.

GLL is attractive because it retains the structure of recursive descent — each grammar rule maps directly to a parsing function — while removing all restrictions on the grammar. No left-recursion elimination, no ambiguity resolution, no lookahead constraints. Afroozeh and Izmaylova (2015) demonstrated practical GLL with speedups of 1.5–5.2x over the original algorithm on Java, C#, and OCaml grammars.

The Iguana parsing framework implements optimized GLL and has been used for data-dependent grammars that unify lexing and parsing (scannerless parsing), handle operator precedence, indentation sensitivity, and preprocessor directives — all in a single formalism.

Source: https://pure.royalholloway.ac.uk/en/publications/purely-functional-gll-parsing
### 2.7. Tomita's Generalized LR — The Graph-Structured Stack

Masaru Tomita's "An Efficient Augmented Context-Free Parsing Algorithm" (Computational Linguistics 13.1–2, 1987; CMU PhD 1985; book 1986) introduced **Generalized LR (GLR)** parsing: an LR automaton that, when its parsing table has a shift-reduce or reduce-reduce conflict, forks and explores all viable actions in parallel. GLR is the bottom-up sibling of GLL (§2.6) and reuses the same GSS-plus-SPPF substrate — see §2.6 for the GSS/SPPF definitions. With Rekers's 1992 SPPF integration, GLR handles arbitrary context-free grammars — ambiguous, non-deterministic — in cubic time worst case and linear time on the LR-deterministic parts of the grammar.

GLR is the direct ancestor of the incremental and scannerless systems elsewhere in this document: tree-sitter (§2.11) uses GLR exploration at declared conflicts, Lezer (§2.12) offers opt-in GLR, SGLR (§2.16) pairs scannerless grammars with GLR. **RNGLR** (Scott & Johnstone, TOPLAS 2006) fixes the original algorithm's correctness hole on hidden-left-recursive grammars; **BRNGLR** (Scott, Johnstone & Economopoulos, 2007) achieves cubic worst-case bounds. Tomita's original motivation was natural-language parsing for CMU's machine-translation work, which is why the algorithm accepted ambiguity as a first-class output rather than an error.

Sources: https://aclanthology.org/J87-1004.pdf and https://dl.acm.org/doi/pdf/10.1145/1146809.1146810
### 2.8. Earley Parsing — The General CFG Algorithm

Jay Earley's 1970 algorithm ("An efficient context-free parsing algorithm", CACM 13.2) parses arbitrary context-free grammars by maintaining, at each input position, a set of "Earley items" — dotted productions tagged with the position where the matching began. The algorithm runs in **O(n³)** worst case, **O(n²)** for unambiguous grammars, and **O(n)** for LR-compatible grammars, without any grammar restrictions or left-recursion elimination.

The classic weakness is right recursion: the original Earley algorithm is quadratic on right-recursive rules because it builds O(n) items per position that all complete at the end. **Joop Leo's 1991 improvement** ("A general context-free parsing algorithm running in linear time on every LR(k) grammar without using lookahead", TCS 82.1) avoids this by recognising right-recursion patterns and collapsing their Earley sets via "deterministic reduction paths", restoring linear time on every LR(k) grammar. Earley + Leo is the foundation of Marpa (§7.2).

**Lark** (Python) is the pragmatic modern Earley implementation: it ships both Earley (with SPPF output for ambiguous grammars) and LALR(1) backends, and it layers an Earley-on-top-of-a-chart parser that consumes regex matches rather than single characters, giving real-world-usable speed while keeping full CFG expressiveness. Earley's practical appeal is the same as GLL (§2.6) and scannerless GLR (§2.16): any grammar parses, no conflict engineering is required, and ambiguity is represented in the output rather than silently resolved.

Sources: https://en.wikipedia.org/wiki/Earley_parser and https://github.com/lark-parser/lark
### 2.9. CYK and Valiant — Foundational but Theoretical

The **Cocke–Younger–Kasami** algorithm (independently rediscovered in the 1960s; first published by Itiroo Sakai in 1961) is a bottom-up dynamic-programming recogniser for context-free grammars in Chomsky Normal Form. It fills an n × n triangular table bottom-up: cell (i, j) holds the set of non-terminals deriving the substring of length *j* starting at position *i*. Every cell takes O(n) work (choose a split point), for O(n³) total. CYK is the canonical textbook introduction to CFG parsing and is still the basis of many NLP and ambiguity-aware tools, but the CNF requirement and the cubic constant make it rare in production language implementations.

**Valiant's 1975 reduction** ("General Context-Free Recognition in Less than Cubic Time") showed that CFG recognition can be reduced to Boolean matrix multiplication of n × n matrices — so any faster matrix multiplication algorithm immediately gives a faster CFG parser. Using Strassen's method, this yields **O(n^2.81)**. Using more recent matrix-multiplication bounds, the exponent drops further. Lee (2002) later proved the reduction goes both ways: fast CFG parsing requires fast Boolean matrix multiplication, so Valiant's bound is in a precise sense the best asymptotic result we know.

Neither algorithm is used in production compilers — constants are too large, and real grammars either admit LL/LR linearity or have structural constraints that Earley/GLL exploit better. They belong in this document as the theoretical anchors that tell you what is and is not possible for general CFG parsing.

Sources: https://en.wikipedia.org/wiki/CYK_algorithm and https://www.cs.cornell.edu/home/llee/papers/bmmcfl-jacm.home.html
### 2.10. Parsing with Derivatives

Introduced by Matt Might et al., this is an elegant approach that extends Brzozowski's derivative for regular expressions to arbitrary Context-Free Grammars (CFGs). A parser evaluates the "derivative" of a grammar with respect to the first token of input, returning a new grammar that matches the remainder of the input.

While its naive implementation can suffer from exponential blowup, with appropriate memoization, laziness, and fixed-point operations, it translates into concise, purely functional code that can parse ambiguous and left-recursive grammars. Later optimizations (like Zippy LL(1) Parsing with Derivatives) have reduced its time complexity to linear for restricted grammars, turning an interesting functional pearl into a practically viable parsing strategy.

Source: https://matt.might.net/papers/might2011derivatives.pdf
### 2.11. Tree-sitter — Incremental LR Parsing with Error Recovery

Tree-sitter is a parser generator that produces incremental GLR parsers in C. Its design priorities — in order — are: robustness (useful results with syntax errors), speed (parse on every keystroke), generality (any language), and dependency-freedom (pure C11 runtime).

The incremental parsing algorithm: when the source is edited, tree-sitter identifies which portions of the old syntax tree are invalidated by the edit, then reparses only those portions, reusing unchanged subtrees. The key data structure is the syntax tree itself — nodes store their byte ranges, and the parser can skip over subtrees whose ranges weren't affected by the edit.

Error recovery is built into the LR automaton and is critical for editor use cases where the source is constantly in an invalid state — see §4.2 for the parallel-strategies mechanism.

Tree-sitter grammars are written in a JavaScript DSL that generates C parsing tables. The generated parsers are typically 50–200KB of C code per language. The runtime library is ~50KB. This is small enough to embed in any application.

Status (as of 2026-04): tree-sitter is used in Neovim, Helix, Zed, GitHub code navigation, and many other tools, having effectively replaced regex-based syntax highlighting in modern editors.

**Precision note:** Calling tree-sitter simply "GLR" is directionally correct, but in practice the generated parser behaves like an LR parser most of the time and invokes GLR exploration when the grammar declares a runtime conflict. That makes it different in feel from always-generalized systems like GLL or Marpa: tree-sitter gets editor-grade speed partly by keeping its generalized machinery selective rather than universal.

Sources: https://tree-sitter.github.io/tree-sitter and https://tree-sitter.github.io/tree-sitter/creating-parsers/2-the-grammar-dsl.html
### 2.12. Lezer — Incremental Parsing for Code Editors

Lezer is the parser system built for CodeMirror 6. Like tree-sitter, it is designed for incremental parsing, error tolerance, and providing a syntax tree for editor tooling. However, unlike tree-sitter's C/C++ foundation, Lezer generates JavaScript modules that run directly in the browser without WebAssembly overhead.

It uses an LR parsing algorithm (with opt-in GLR) but is highly specialized for JavaScript's execution model. Lezer outputs a compact, non-abstract syntax tree (where nodes keep track of their width and structure rather than being full JS objects), ensuring low memory consumption and high locality. The parser seamlessly recovers from syntax errors, guaranteeing that an editor always has a workable syntax tree for highlighting and code navigation.

Source: https://marijnhaverbeke.nl/blog/lezer.html
### 2.13. Accelerated-Zig-Parser (Validark) — SIMD Tokenization

SIMD-accelerated tokenizer achieving 2.75x faster and 2.47x less memory than mainline Zig tokenizer.

Key techniques:
- **SIMD bitstring scanning**: produces bitstrings per 64-byte chunk for identifiers, quotes, whitespace, and comments simultaneously, then uses vector compression to find token extents.
- **Perfect hash functions**: keywords and operators mapped into 7-bit address space. Single 16-byte comparison per identifier to check against keyword table. Uses Phil Bagwell's array-mapped trie compression for packed lookup buffers.
- **Token length encoding**: stores token lengths as `u8` instead of absolute `u32` start offsets. Almost all tokens are <256 bytes. A `0` sentinel indicates the next 4 bytes contain the true length. This is a 4x memory reduction for the common case.
- **Sentinel padding**: source buffer padded with sentinel characters at the end. Eliminates bounds-checking in inner loops — the SIMD scan cannot overrun because sentinels terminate every scan pattern.
- **Newline bitmap as reusable artifact**: SIMD scanning produces a non-newline bitmap as a side product. Later pipeline stages reuse it for line-number computation without re-scanning the source.

The general principle: tokenization is embarrassingly SIMD-friendly because it operates on independent byte-level predicates. The same 64-byte chunk can be tested for all token-start conditions simultaneously.

Source: https://github.com/Validark/Accelerated-Zig-Parser
### 2.14. SIMD-Accelerated Structural Parsing (simdjson)

Geoff Langdale and Daniel Lemire pioneered parsing gigabytes of data per second by heavily utilizing SIMD instructions (e.g., AVX-512) for more than just tokenization. In libraries like `simdjson` and `simdcsv`, the parser operates in two distinct stages:
1. **Structural Index Generation:** SIMD instructions simultaneously identify all structural characters (quotes, colons, brackets, delimiters) across a block of 64 bytes. This produces a bitmap index of all structurally significant locations.
2. **Structural Processing:** A second pass iterates only over the structural characters identified in the first stage to build the actual parsed representation.

By eliminating byte-by-byte loops and branch mispredictions, this approach can parse at gigabytes per second, frequently bottlenecking on main memory bandwidth rather than the CPU.

Sources: https://arxiv.org/abs/1902.08318 and https://simdjson.org/
### 2.15. Meriyah — Opt-In Location Tracking

100% ECMAScript-compliant JavaScript parser. Key design: location tracking is opt-in via boolean flags (`ranges`, `loc`). When both are off, AST nodes carry zero location overhead. When on, the parser captures its current position into nodes.

This is a useful pattern when different consumers have different needs: a bundler or syntax-only pass can parse without `ranges`/`loc`, while diagnostics, transforms, and tooling can enable them. Re-parsing only a specific region is safe only when the parser can reconstruct the surrounding syntactic and option context; otherwise a full-file reparse with locations enabled is the conservative design. The cost of location tracking is not just storage — it's also the cost of maintaining line/column state during scanning, which involves checking for newlines on every character advance.

Source: https://github.com/nicolo-ribaudo/meriyah
### 2.16. Scannerless Parsing — No Separate Lexer

Scannerless (lexerless) parsing eliminates the traditional lexer/parser pipeline, using a single grammar formalism from characters to syntax trees. The grammar describes both token structure and phrase structure in one unified specification.

The primary advantage: compositional grammars. When two languages are embedded (e.g., SQL in Java, HTML in PHP, regex in any language), their token rules may conflict. A traditional lexer cannot handle multiple token grammars simultaneously. A scannerless parser treats everything as characters, avoiding the conflict entirely.

Scannerless GLR parsing (SGLR) has been used in the Spoofax language workbench and the Rascal meta-programming language for exactly this purpose — parsing real-world programs in languages with complex lexical interactions.

The cost: scannerless grammars are more ambiguous than tokenized ones (because character-level alternatives create more nondeterminism), requiring a more powerful — and slower — parsing algorithm. SRNGLR (Economopoulos et al., 2009) is on average 33% faster than SGLR, and 95% faster on highly ambiguous grammars.

The relevance is straightforward: any language that supports string interpolation, heredocs, or embedded DSLs faces the same lexer-composition problem. Scannerless parsing is the principled solution.

Sources: https://en.wikipedia.org/wiki/Scannerless_parsing and https://ir.cwi.nl/pub/24027/24027B.pdf
### 2.17. TCC — No AST, Direct Code Emission

Fabrice Bellard's Tiny C Compiler parses C and emits machine code in a single pass, with no AST. Source locations flow from the lexer's current position directly into DWARF debug info during code generation. Each time the code generator emits an instruction, it records the current source line.

This is the extreme end of the "no intermediate representation" spectrum. The benefit is speed and simplicity: TCC compiles C faster than GCC can preprocess it. The cost is optimization — without an IR, there is no opportunity for analysis or transformation between parsing and code generation. TCC-compiled code runs 3–10x slower than GCC -O2.

For interactive use cases (compile-and-run scripts, rapid iteration), TCC's approach is compelling. The compilation is so fast that the compile-time component of edit-compile-run is effectively zero.

Source: https://bellard.org/tcc/
### 2.18. Parser Combinators — Parsers as First-Class Values

Parser combinators treat parsers as ordinary values in the host language and build larger parsers by composing smaller ones through higher-order functions. Daan Leijen and Erik Meijer's **Parsec** (2001) is the landmark design: monadic combinators in Haskell that produce precise error locations and the set of legal productions at the failure point, with heuristics to avoid naive space leaks. **Megaparsec** (Mark Karpov) is the current industrial-strength descendant — an MTL-style monad transformer with better error quality and documented performance characteristics comparable to Attoparsec when combinators are used carefully.

The Rust lineage spans **nom** (zero-copy, byte-oriented; popular for binary protocols), its 2023 fork **winnow** (mutable-input, tooling-oriented redesign), and **chumsky**, which foregrounds error recovery: it reports multiple errors, recovers into a consistent state, emits partial ASTs, supports context-sensitive grammars, and ships a `chumsky::pratt` module unifying Pratt's per-operator extensibility with combinator typing — features normally seen in hand-written compiler front-ends.

The trade-off vs. parser generators is real. Combinators give you a parser that is type-checked by the host language, composable at runtime, and free of a separate build step — but they typically run slower than a well-tuned LR or hand-written RD parser, offer weaker grammar introspection (no explicit grammar object to inspect for conflicts or first-sets), and shift responsibility for left-recursion elimination and precedence to the author. Most production compilers that start with combinators eventually migrate to hand-written code (see §5.2 and §6 on Ruff).

Sources: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/parsec-paper-letter.pdf and https://github.com/mrkkrp/megaparsec and https://github.com/rust-bakery/nom and https://github.com/winnow-rs/winnow and https://github.com/zesterer/chumsky
### 2.19. ANTLR4 — Adaptive LL(\*)

Terence Parr and Sam Harwell's **ALL(\*)** algorithm (OOPSLA 2014, with Kathleen Fisher) is the engine behind ANTLR4. The idea is to move grammar analysis from generator time to parse time: at each ambiguous decision point, ALL(\*) launches a subset-construction-style lookahead that explores all viable alternatives in parallel over the actual input, building a prediction DFA lazily and caching it for future visits. When regular lookahead is insufficient, it falls back to GLL-style exploration (see §2.6). The earlier LL(\*) algorithm (PLDI 2011) did static analysis; ALL(\*) is the adaptive, dynamic successor that removed LL(\*)'s grammar restrictions.

The worst case is theoretically O(n⁴), but Parr and Harwell report that ALL(\*) consistently runs linearly on real grammars and outperforms GLR/GLL by orders of magnitude on practical inputs. The algorithm handles any non-left-recursive CFG directly; direct left recursion is rewritten by ANTLR4's front-end into the equivalent Pratt-like precedence-climbing form.

ALL(\*) is why ANTLR4 displaced yacc/bison for many grammar-first users: grammars stay readable (no manual precedence disambiguation or conflict refactoring), lookahead is effectively unlimited, and the generated parsers produce decent error messages out of the box. The practical limits are code size, the two-pass analyze-then-parse overhead on cold code paths, and the same "generated parser is a black box" pressures that push production compilers towards hand-written recursive descent (see §5.2).

Sources: https://www.antlr.org/papers/allstar-techreport.pdf and https://github.com/antlr/antlr4
### 2.20. Ohm — PEG with Externalised Semantic Actions

Ohm (Alex Warth, Patrick Dubroy, et al.) is a PEG variant that deliberately **separates syntax from semantics**. The `.ohm` grammar file contains *only* rules and parsing expressions — no inline action code. Semantic actions live in a separate file as a visitor: one JavaScript (or other host-language) method per grammar rule, keyed by rule name. This is a direct response to the authors' earlier system **OMeta** (Warth & Piumarta, DLS 2007), whose power came partly from allowing inline semantic actions and pattern-matching over arbitrary host-language objects rather than just strings.

The Warth group's argument for separation is modularity: you can apply multiple independent "semantics" to the same grammar (one for evaluation, one for pretty-printing, one for type-checking) without duplicating or interleaving the parsing logic. The 2016 paper "Modular Semantic Actions" formalises this as a reusable attribute-grammar-like model where different semantics can extend or override each other cleanly.

Compared with traditional PEG tools, Ohm loses the convenience of inline actions but gains grammar reusability and much cleaner tooling surface: since the grammar is pure data, the same `.ohm` file can drive a parser, a syntax highlighter, a fuzzer, and a documentation generator. OMeta's ancestor property — the ability to parse over arbitrary data streams, not just text — is not carried forward in Ohm, which is string-focused.

Sources: https://ohmjs.org/pubs/dls2016/modular-semantic-actions.pdf and http://www.tinlizzie.org/~awarth/papers/dls07.pdf
### 2.21. Indentation- and Layout-Sensitive Parsing

Peter Landin's "off-side rule" (1966) is the foundational idea: nested blocks are delimited by indentation instead of brackets. The common production technique is a **layout stage** between lexer and parser that inserts virtual `{`, `;`, and `}` tokens based on column positions, so the downstream grammar can stay ordinary context-free.

The **Haskell 2010 Report** gives the canonical specification. A layout-sensitive keyword (`let`, `where`, `do`, `of`) not followed by an explicit `{` inserts a virtual `{n}` token where *n* is the indentation of the next lexeme. The algorithm maintains a stack of layout contexts — each a column number or 0 for an explicit brace — and emits `;` when a new line matches the current indent, closes the context with `}` when it is less, and pushes a new context when greater. A distinctive feature is the "parse-error rule": if the token stream otherwise fails to parse but would succeed with a virtual `}`, one is inserted. That rule entangles layout with the grammar in a way that is famously hard to implement cleanly outside a hand-written parser. **Python** takes a simpler approach in its `tokenize` module: INDENT/DEDENT tokens emitted by the lexer on pure column comparisons, with no parse-error feedback.

Data-dependent grammars (§2.6 Iguana) and scannerless GLR (§2.16) offer a more principled alternative: specify indentation as a parameterised constraint inside the grammar itself, which avoids the "layout stage as a separate kludge" problem. Adams (2013) developed a formal theory of indentation-sensitive parsing that composes with LR generators. In practice, most layout-sensitive languages (Haskell, Python, F#, Nim) still ship the simpler lexer-pass design because it gives hand-written parsers total control over the weird cases.

Sources: https://www.haskell.org/onlinereport/haskell2010/haskellch10.html and https://michaeldadams.org/papers/layout_parsing/LayoutParsing.pdf
### 2.22. Extensible Syntax — Racket Readtables, Lean 4, Rhombus

A distinct family of parsers deliberately exposes the grammar to user code at compile time.

**Racket's reader** is the oldest. `read-syntax` walks input character by character consulting a **readtable**: a first-class, mutable mapping from characters to reader procedures. Any character can be rebound to start a new syntactic form. `#lang` goes further, dispatching to an arbitrary user-defined reader module that can implement a whole non-s-expression surface syntax — and the result is always a syntax object carrying source locations and hygienic lexical context, suitable for macro expansion downstream. This is the canonical "the reader is a library, not a table of productions" design.

**Lean 4** (de Moura & Ullrich, CADE 2021) takes the idea into a dependently typed prover: a lexerless, memoising combinator-style recursive descent reads a runtime-extensible production table that users grow with `syntax` and `macro_rules` forms mid-file, with per-category Pratt precedence and built-in macro hygiene.

**Rhombus / Shrubbery** (Flatt et al., OOPSLA 2023) is Racket's parens-free variant. Parsing splits in two: a **shrubbery** reader produces an indentation-and-bracket tree with no knowledge of operators or precedence, and a second **enforest** pass (a Honu-style refinement) resolves operators and binding forms through user-definable macros.

Shared thesis: language extension should be a user-level library concern, not a privileged compiler-authoring one. The cost is a parser that must accommodate a runtime-changing grammar, which rules out most table-driven generators.

Sources: https://docs.racket-lang.org/reference/readtables.html and https://lean-lang.org/papers/lean4.pdf and https://users.cs.utah.edu/plt/publications/oopsla23-faadffggkkmppst.pdf and https://docs.racket-lang.org/shrubbery/index.html
### 2.23. syntax-parse — Parsing Macro Inputs with Specifications

Ryan Culpepper and Matthias Felleisen's **syntax-parse** (ICFP 2010 "Fortifying Macros"; JFP 22(4–5) 2012 extended version) is Racket's parser for *macro inputs*. Racket's reader (§2.22) turns text into syntax objects; syntax-parse is the layer above that turns a macro's received syntax object into structured data, with error messages that explain misuse. A macro author writes a pattern — for example `(my-for ([x:id seq] ...) body ...+)` — using **syntax classes** like `id`, `expr`, or user-defined classes with their own pattern structure, optional annotations, side conditions, and attributes. When a macro is called with syntactically ill-formed arguments, syntax-parse does not emit an opaque "bad syntax"; it points at the specific sub-form that failed to match and explains which alternative was expected.

This is macro-level parsing, complementing §2.22: the reader exposes character-level grammar to users, syntax-parse exposes term-level grammar to macro authors. The 2012 paper formalises the system as a pattern language with deterministic error attribution — given several failed alternatives, syntax-parse picks the one that got furthest into the input and reports that, mirroring Parsec/Megaparsec error-quality heuristics (§2.18) but at the syntax-object level. In Racket this is not a niche tool: every non-trivial `define-syntax` in the standard library is written against syntax-parse, and the syntax classes themselves are the standard way to document "what a valid macro call looks like."

syntax-parse delivers specification-driven macro error messages comparable to a parser generator's diagnostics — at the cost of a second parsing layer above the reader and of being Racket-specific in a way that readtables, Pratt, and combinators are not.

Sources: https://www2.ccs.neu.edu/racket/pubs/c-jfp12.pdf and https://docs.racket-lang.org/syntax/Parsing_Syntax.html

### 2.24. Structured Editing, Projectional Editing, and Hybrid Editing

Most parser research assumes that programs are edited as plain text and that a parser's job is to recover structure from a character stream. Modern language tooling complicates that assumption. **Structured editing** treats the program's syntax tree as the primary editing object, while **projectional editing** goes further and edits the tree directly instead of parsing text at all. Hybrid systems try to preserve ordinary text editing while retaining stronger structural guarantees than a traditional parse-on-save workflow can provide.

The trade-off is not theoretical elegance but *editing freedom*. Structured and projectional systems can guarantee syntactic correctness, make AST-level refactorings trivial, and support notations that ordinary parsers handle poorly — tables, diagrams, context-sensitive forms, mixed textual/graphical surfaces, and aggressively extensible syntax. JetBrains MPS is the clearest production reference point: the editor manipulates AST nodes directly, persistence and diff/merge operate on syntax structure with stable node identities, and language composition avoids grammar ambiguity by construction.

The cost is that many programmers regularly make intermediate edits that are intentionally syntactically invalid: block edits, multi-line partial rewrites, or temporary violations of delimiter balance. Pure projectional editors often make such workflows awkward. This is why the most relevant design question for a new language is not simply "projectional or text?" but **where to place the boundary between free-form editing and structural awareness**.

Laurence Tratt's 2024 essay argues that **incremental parsing** is the practical bridge. The editor can let users type ordinary text while maintaining a continuously updated parse tree in the background, including partially broken trees when the source is invalid. This recovers many of the benefits of structured editing without forbidding transient syntax errors. Beckmann et al.'s **Partial Parsing for Structured Editors** strengthens the same point from a language-workbench angle: partial parsing can support keyboard-centric structured editing generated from general-purpose grammars, reducing reliance on menus and mouse-driven syntax construction.

The language-design lesson is that parser strategy and editor strategy are no longer separable. If a language expects rich IDE support, syntax-aware completions, or multiple notations over one syntax tree, then structured, projectional, or hybrid editing models should be considered alongside ordinary incremental parsing rather than deferred until much later.

Sources: https://tratt.net/laurie/blog/2024/structured_editing_and_incremental_parsing.html and https://dl.acm.org/doi/10.1145/3567512.3567522 and https://www.jetbrains.com/help/mps/mps-faq.html

### 2.25. Recursive Descent — The Hand-Written Baseline

Recursive descent deserves an explicit entry because it is not merely an implementation detail behind Pratt parsing (§2.1) or PEG (§2.3). In its simplest form, each grammar production becomes a host-language function, and the parser advances through the token stream by calling these functions directly. Predictive recursive descent chooses alternatives from lookahead tokens; backtracking recursive descent tries alternatives speculatively; resilient recursive descent (§7.8) deliberately consumes a well-formed prefix and emits error nodes instead of failing globally.

The production appeal is control. A hand-written recursive-descent parser can special-case ambiguous constructs, attach targeted diagnostics, perform context-sensitive recovery, avoid table indirection, and keep hot paths allocation-free. The usual pattern is: parse declarations and statements with recursive descent, parse expressions with Pratt or precedence climbing, and reserve ad-hoc lookahead for the few places where the grammar is intentionally not LL(1). The list of production compilers and tools that take this path is given once in §5.2.

The cost is that ambiguity detection moves from generator to author. An LR generator will report a shift/reduce conflict; a recursive-descent parser may silently prefer whichever branch its code checks first. Good recursive-descent implementations compensate with tests, explicit grammar comments, debug traces, and carefully named helper functions such as `at_item_start`, `recover_until`, and `expect_contextual_keyword`.

Sources: https://tratt.net/laurie/blog/2020/which_parsing_approach.html and https://matklad.github.io/2023/05/21/resilient-ll-parsing-tutorial.html

### 2.26. Deterministic LL and LR — The Classical Compiler Workhorses

The classic parsing families are still the vocabulary of compiler front-ends even when a production parser is hand-written. **LL** parsers read left-to-right and construct a leftmost derivation; they are naturally top-down and align with recursive descent. `LL(1)` uses one token of lookahead, `LL(k)` uses fixed k-token lookahead, and `LL(*)`/`ALL(*)` generalise the lookahead story (§2.19). Grammar engineering for LL usually means eliminating left recursion and left-factoring common prefixes so that a lookahead token selects one production.

**LR** parsers read left-to-right and construct a rightmost derivation in reverse; they are bottom-up and operate as shift/reduce automata. The family includes `LR(0)`, `SLR(1)`, `LALR(1)`, canonical `LR(1)`, `LR(k)`, and practical variants such as Bison's `IELR(1)`. `SLR` is compact but weak, `LALR(1)` is the yacc-era sweet spot, canonical `LR(1)` has better conflict precision but larger tables, and `IELR(1)` aims to preserve canonical LR(1) language recognition with LALR-like table size.

For language design, the key question is not "which acronym is best?" but "where should ambiguity be discovered?" LL-style parsers tend to put ambiguity resolution in source-code control flow; LR-style generators surface conflicts statically as shift/reduce or reduce/reduce reports; generalized parsers (§2.6–§2.8) accept ambiguity and return a forest; PEG (§2.3) bakes priority into ordered choice. A language designer can intentionally target an LL/RD-friendly grammar for implementation simplicity, an LR-friendly grammar for conflict diagnostics and generator support, or a more expressive syntax with a generalized or PEG parser.

Sources: https://dickgrune.com/Books/PTAPG_2nd_Edition/index.html and https://www.gnu.org/software/bison/manual/bison.html

### 2.27. Shunting-Yard and Operator-Precedence Grammars

Dijkstra's **shunting-yard** algorithm is the classic stack-based expression parser: operands go to an output queue, operators sit on a stack, and precedence/associativity decide when stacked operators are popped. It is easy to implement and ideal for calculators, bytecode emitters, and expression-only DSLs. Compared with Pratt (§2.1) and precedence climbing (§2.2), shunting-yard is less natural when expressions contain rich prefix/postfix forms, contextual keywords, lambdas, or error recovery, but it remains the simplest way to translate infix expressions to postfix or bytecode.

The older **operator-precedence grammar** family, associated with Floyd, generalises the same idea into parsing tables between terminal symbols: "yields precedence", "takes precedence", or "equal precedence". Operator-precedence parsers are deterministic and efficient for a restricted class of grammars with no adjacent nonterminals and no empty productions. Modern compilers rarely use the full formalism, but its spirit survives in yacc/Bison precedence declarations and in the binding-power tables used by Pratt and precedence climbing.

Sources: https://en.wikipedia.org/wiki/Shunting_yard_algorithm and https://en.wikipedia.org/wiki/Operator-precedence_parser

### 2.28. Ambiguity, Parse Forests, and Disambiguation

Generalized parsers do not make ambiguity disappear; they make it explicit. When GLR, GLL, Earley, or CYK finds multiple parses, the practical output is usually a **Shared Packed Parse Forest** (SPPF): common subtrees are shared, and ambiguous alternatives are stored as packed nodes. This keeps the representation polynomial rather than exploding into every full parse tree.

Ambiguity management is therefore a separate design problem. Common strategies include:
- grammar refactoring to remove the ambiguity,
- precedence and associativity filters,
- longest-match token policies,
- priority annotations,
- "prefer shift" or "prefer earlier rule" defaults,
- semantic filters after parsing,
- explicit ambiguity nodes exposed to later phases.

The engineering lesson is that "accepts all CFGs" is not the same as "gives the tree you wanted." For programming languages, a parser that frequently produces ambiguity forests pushes complexity downstream into name resolution, macro expansion, or type checking. Tree-sitter and Lezer mostly avoid this by asking grammar authors to declare conflicts and by resolving common precedence cases in the grammar. Lark's Earley backend exposes SPPF for cases where ambiguity is intentionally preserved.

Sources: https://lark-parser.readthedocs.io/en/stable/parsers.html and https://tree-sitter.github.io/tree-sitter/creating-parsers/3-writing-the-grammar.html

### 2.29. Syntax-Directed Translation and Attribute Grammars

Parsing rarely stops at "recognise the sentence." Most compiler front-ends attach work to productions: build AST nodes, record declarations, desugar constructs, emit bytecode, or compute attributes. This family is usually called **syntax-directed translation**. In a yacc-style parser, semantic actions are host-language fragments attached to grammar reductions; in recursive descent, they are ordinary code inside parse functions; in Raku/NQP (§6.3), grammar matches are paired with action methods that build QAST.

**Attribute grammars** formalise the same idea. Synthesised attributes flow upward from children to parent; inherited attributes flow downward or sideways from parent and left siblings. S-attributed grammars use only synthesised attributes and fit bottom-up parsing naturally. L-attributed grammars allow a restricted form of inherited attributes that can be evaluated left-to-right, making them practical for recursive descent and LL parsers.

The modern tooling lesson from Ohm (§2.20) and syntax-parse (§2.23) is that inline semantic actions are convenient but couple syntax to one interpretation. External action objects, visitors, or action methods let one grammar support multiple consumers: AST construction, pretty-printing, linting, documentation, and error explanation.

Sources: https://web.cs.wpi.edu/~cs544/PLT6.5.2.html and https://cecs.wright.edu/~tkprasad/papers/Attribute-Grammars.pdf

### 2.30. Beyond-CFG Formalisms — TAG, MCFG, Boolean Grammars, and Friends

Most programming-language parsers live in the regular + CFG + context-sensitive-escape-hatch world: regular lexers, CFG-ish syntax, and semantic checks after parsing. Research parsing goes further. **Tree-Adjoining Grammars** (TAG), **Multiple Context-Free Grammars** (MCFG), **Linear Context-Free Rewriting Systems** (LCFRS), and **Range Concatenation Grammars** (RCG) capture mildly context-sensitive patterns important in natural language. **Conjunctive** and **Boolean grammars** extend CFGs with intersection and negation. **Visibly pushdown languages** sit between regular and deterministic context-free languages and model nested calls/returns while retaining strong automata properties.

For ordinary programming-language implementations, these are rarely the baseline. They matter as boundary markers: if a syntax feature seems to require cross-serial dependencies, arbitrary indentation constraints, macro-time grammar mutation, or semantic feedback during parsing, it may be outside ordinary CFG parsing. At that point the implementation choice is usually not "use TAG" but "move the constraint to a later semantic phase, redesign the syntax, or use a specialised parser with explicit context."

Sources: https://link.springer.com/book/10.1007/978-3-642-14846-0 and https://dickgrune.com/Books/PTAPG_2nd_Edition/index.html

---

## 3. Flat and Compact AST Representations

Parser output has two competing jobs: feed the compiler cheaply and preserve enough source structure for diagnostics, formatting, macros, and editor tooling. This chapter keeps the parser-facing view of AST/CST layout: what the parser emits, what source-position information it retains, and what can be dropped after lowering. The broader representation catalogue — including full CST APIs, AST taxonomy, HIR/MIR/SSA, bytecode, e-graphs, content-addressed IRs, and effect-annotated forms — lives in `REPRESENTATIONS.md`.

### 3.1. Cuik — Postfix Expression Encoding

Cuik stores expressions as a flat `Subexpr` array in reverse-Polish order. For a parser, the important point is that child links are implicit in sequence position rather than explicit pointers, so expression parsing can append compact nodes and later codegen can walk them sequentially.

Benefit: excellent locality, no pointer overhead, trivial serialization. Cost: random subtree access requires a walk. The full representation trade-off is covered in `REPRESENTATIONS.md §3.1`.

Source: https://github.com/RealNeGate/Cuik

### 3.2. Red-Green and Full-Fidelity Trees as Parser Outputs

Editor-oriented systems (Roslyn, rowan, SwiftSyntax, Lezer, Tree-sitter) emit a persistent, error-tolerant CST with lossless token/trivia retention and stable node identity across edits, rather than a one-shot AST. Whether nodes carry absolute byte ranges or width-only green nodes with lazy red wrappers is a representation-side choice — the full red-green mechanism, `TextRange` semantics, and CST APIs live in `REPRESENTATIONS.md §2`.

Sources: https://ericlippert.com/2012/06/08/red-green-trees/ and https://github.com/rust-analyzer/rowan and https://github.com/swiftlang/swift-syntax and https://tree-sitter.github.io/tree-sitter

### 3.3. Zig — Token-Indexed AST with Relative Offsets

Zig's parser emits an AST that references tokens by index rather than by byte offset. Diagnostics resolve positions through the token table and source manager, and once ZIR (Zig Intermediate Representation) is emitted the AST plus token list can be discarded — a conservative memory-saving alternative to full-fidelity CSTs. The fuller layout discussion (token-indexed AST plus ZIR memory model) is in `REPRESENTATIONS.md §3.2`.

Source: https://github.com/ziglang/zig/blob/master/src/Zir.zig

### 3.4. Arena-Based Parser Layouts with Offsets

Arena-allocated parser output can use 32-bit offsets in place of pointers for child/sibling/parent edges, halving edge size on 64-bit platforms, simplifying bulk-free, and keeping trees serializable — a natural fit for one-phase parser ASTs. The general arena-plus-offset layout is in `REPRESENTATIONS.md §3.3`; compiler-internal arena allocation lives in `COMPILERS.md §2.1`.

Source: https://news.ycombinator.com/item?id=40276112

### 3.5. Oil / OSH / YSH — Lossless Syntax Trees via ASDL

Oil's shift from a classical AST to a lossless syntax tree is the parser-side warning that "AST" is too lossy for source-to-source tools — shell trivia (comments, heredocs, backslashes, token boundaries) must be retained when execution is not the only consumer. The design question for any language implementer is whether one parser output should serve both execution and tooling. ASDL schemas and the broader lossless-tree design are in `REPRESENTATIONS.md §2.6–§2.7`.

Source: https://www.oilshell.org/blog/2017/02/11.html

---

## 4. Error Recovery

Techniques for keeping a usable syntax tree on invalid input — essential once a parser has to run on every keystroke in an editor rather than once per clean file. The entries differ on where recovery authority lives: in a synchronization-token skip loop (panic mode), in the parser algorithm itself (tree-sitter's parallel forks, Röhrich insertion-only), in the language design (Hazel's typed holes), in a programmable handler called by the parser (Marpa's Ruby Slippers), or in a prose specification that enumerates every recovery action (HTML5).

### 4.1. Panic Mode — Skip to Synchronization Token

The simplest error recovery: when the parser encounters an unexpected token, skip tokens until reaching a "synchronization point" (typically a semicolon, closing brace, or keyword that starts a new statement). Resume parsing from there.

The advantage: trivially simple to implement, predictable behavior, prevents cascading errors. The disadvantage: potentially skips large amounts of valid code, producing a sparse AST with many missing nodes. For editor use cases where every keystroke may produce a syntax error, panic mode is too destructive — it discards too much context.

### 4.2. Tree-sitter's Parallel Error Recovery

Tree-sitter forks the parser state at the error point, races insert/delete/`ERROR`-wrap strategies, and keeps whichever consumes the most subsequent input — see §2.11 for the full incremental-GLR mechanism. Concretely, one fork inserts a missing token and proceeds, another deletes the offending token, and a third wraps the surrounding region in an `ERROR` node so that valid sibling subtrees survive. The cost (multiple parallel parse attempts) buys structurally useful trees on broken input, which is what syntax highlighting and navigation need on every keystroke.

### 4.3. Insertion-Only Error Correction

Röhrich (1980) showed that for LL(k) and LR(k) parsers, error correction can be achieved by inserting terminal symbols to the right of the error location, never deleting. The output always corresponds to a syntactically valid program. The correction algorithm requires only one character per parser state, making it extremely cheap in space.

The insight: insertion-only correction is sufficient because any syntax error can be "fixed" by inserting the missing tokens needed to close the current syntactic context. A missing semicolon, a missing closing brace, a missing `then` keyword — all can be corrected by insertion. Deletion is needed only for truly garbage input, which is rare in practice.

Source: https://link.springer.com/article/10.1007/BF00263989

### 4.4. Hazel's Approach — Typed Holes as Error Recovery

Hazel inserts "typed holes" wherever the parser encounters incomplete or missing expressions. Unlike traditional error recovery which produces error nodes, holes are semantically meaningful — they have types, so downstream phases can still operate on the incomplete program. Full type-system treatment of holes belongs in `TYPES.md §10.2`; this parser section focuses on their use as recovery nodes.

This turns error recovery from a hack (skip some tokens, hope for the best) into a language feature: every intermediate editor state is a valid program with holes. The trade-off: it requires the entire language and type system to be designed around the possibility of holes, which is a much larger commitment than bolting error recovery onto an existing parser.

> The *live evaluation* side — running incomplete programs and seeing partial results — is covered in `DEBUGGERS.md §6.2`.

Source: https://hazel.org/

### 4.5. Ruby Slippers Recovery — Programmable Token Injection (Marpa)

Marpa's distinctive contribution is **Ruby Slippers parsing**: rather than recovering only *after* the parser has fallen over, Marpa exposes what it is expecting at any input position and lets the surrounding application inject, substitute, or adjust tokens to keep the parse moving. The interface flips error recovery from a fixed generator-side heuristic into a programmable callback — the host program decides which "expected" token to synthesise, on what evidence, and the parser resumes as if the input had always contained it. This is the natural fit for parsing forgiving formats (HTML-like dialects, configuration files with optional punctuation) where the recovery rules are domain knowledge rather than parser-generator choices. The Marpa parser engine itself (Earley/Leo) is covered in §7.2.

Source: https://jeffreykegler.github.io/Ocean-of-Awareness-blog/individual/2011/11/marpa-and-the-ruby-slippers.html

### 4.6. HTML5 — Recovery as Specification

The HTML Standard takes error recovery further than any other approach surveyed: the specification itself *is* the recovery algorithm. Every byte sequence, valid or not, must produce a well-defined DOM tree, and two conformant parsers must produce spec-equivalent DOM structure on identical input. The tree construction algorithm is a state machine of "insertion modes" alongside a stack of open elements and a list of active formatting elements; auxiliary algorithms (adoption agency, foster parenting) and a long list of named parse errors each carry a mandated recovery action. The takeaway is that the spec *is* the algorithm — the parser has no choices left to make.

This is categorically different from tree-sitter's parallel exploration (§4.2) and panic-mode skipping (§4.1): there are no "error nodes" or "unresolved regions" — every byte contributes to the tree under rules as tight as the grammar itself. The consequence is that HTML's parser is complex but interoperable: Chromium, Gecko, and WebKit implement the same specification and produce identical DOMs on the same bytes.

The HTML5 approach gives full interoperability on adversarial input and a single unambiguous DOM for tooling — offset by a parser far larger than any CFG-based alternative and by historical baggage in the recovery rules (many exist to match 1990s browser quirks rather than principled design).

Source: https://html.spec.whatwg.org/multipage/parsing.html

### 4.7. Minimum-Distance Error Repair — Burke–Fisher, Fischer/LeBlanc, CPCT+

Between panic mode (§4.1) and full recovery-as-specification (§4.6) is a family of algorithms that search for a small edit sequence — insert, delete, or substitute tokens — that lets parsing continue. **Burke–Fisher** repair backs up a bounded number of tokens from the detected error point, tries single-token repairs around that window, reparses, and chooses the repair that gets furthest. This matters because the true mistake is often before the token where the LR automaton finally gets stuck.

The modern representative is **CPCT+** ("Don't Panic! Better, Fewer, Syntax Errors for LR Parsers"). It searches for the complete set of minimum-cost repair sequences at an error location, merges compatible configurations for speed, and uses the set of repairs to reduce cascading diagnostics. Diekmann and Tratt report that CPCT+ repaired 98.37% of 200,000 invalid Java files within a 0.5s timeout and produced far fewer cascading error locations than panic mode.

For a language implementation, minimum-distance repair is especially attractive when using LR-family infrastructure: it gives high-quality diagnostics without requiring every grammar production to hand-code recovery. The cost is algorithmic complexity and a need to rank repairs so that the parser's "fix" matches programmer intent.

Sources: https://www.cs.princeton.edu/courses/archive/spr04/cos320/notes/error-recovery.pdf and https://arxiv.org/abs/1804.07133

### 4.8. Resilient Parsing for Interactive Tooling

This section synthesizes the editor-oriented implications of the recovery techniques above rather than introducing a separate parser family. Interactive tooling changes the parser's success condition. A batch compiler may reasonably stop once it has emitted one high-quality syntax error. An IDE, formatter, refactoring engine, or semantic-completion service usually cannot. It needs a tree — often a best-effort one — for *every* intermediate editor state, including incomplete declarations, half-written expressions, and mismatched delimiters.

This shifts the parser's job from "accept or reject" toward **producing the most useful structurally sound tree possible under invalid input**. The specific mechanisms vary:
- local recovery with explicit `ERROR` or placeholder nodes;
- resilient recursive-descent strategies that parse a correct prefix and quarantine the broken region;
- phrase-level repair and token synchronization;
- AST placeholders that let later phases continue operating.

Matklad's **resilient LL parsing** work is the clearest hand-written parser formulation of this philosophy: instead of propagating failure upward, each production consumes what it can, inserts localized error nodes, and preserves unaffected siblings so later tooling remains meaningful. The Hylo 2025 work on **error-tolerant parsing and compilation** makes the same point from a language-implementation perspective: interactive development requires more than nicer parse errors; it requires a tree that later stages — semantic analysis, diagnostics, navigation, and completion — can still consume.

The practical design question for a new language is therefore not only which parsing algorithm to use, but whether the language wants:
- one parser optimized for compiler throughput and a separate resilient parser for tooling;
- or one parser deliberately engineered to satisfy both batch compilation and interactive editing.

This concern connects parser design directly to AST design (§3), semantic analysis (`TYPES.md §13`), and debugger/tooling workflows (`DEBUGGERS.md §6.2`).

Sources: https://matklad.github.io/2023/05/21/resilient-ll-parsing-tutorial.html and https://repository.tudelft.nl/record/uuid:5f796ca0-1b65-4d28-9255-6cb4b6810817

---

## 5. Parser Techniques

Lower-level lexing and dispatch primitives that sit underneath the parser architectures in §2 — the machinery every parser relies on even when the top-level algorithm is hand-written recursive descent. Entries cover keyword recognition (perfect hashing vs small sorted tables), parser implementation strategy (hand-written vs generated), and the lexer-generator families themselves: Ragel's action-annotated FSMs, re2c's direct-coded DFAs, and Hyperscan's SIMD multi-pattern matcher. The axis is "how low do you go before generated code stops paying for itself."

### 5.1. Keyword Recognition — Perfect Hashing

Recognizing keywords during lexing can be done by string comparison against a list, by a trie, or by a perfect hash function that maps keyword strings to a compact integer range with no collisions.

`gperf` is the classic tool for generating perfect hash functions from a keyword list. The generated code is typically a single hash computation + one string comparison (to verify). This is O(1) per keyword check, with very small constant factors.

The Accelerated-Zig-Parser uses a variant: keywords and operators mapped into a 7-bit address space via a perfect hash, then verified with a single 16-byte SIMD comparison. This eliminates branching in the keyword recognition path.

For small keyword sets (<50 keywords, which covers most languages), a simple sorted array with binary search or even linear scan is often faster than a perfect hash due to better branch prediction and cache behavior. The perfect hash wins for larger sets or when the hash can be folded into SIMD processing.

Source: https://www.gnu.org/software/gperf/

### 5.2. Parser Implementation Strategy — Hand-Written vs Generated

The broader practitioner trend: parser generators (LALRPOP, yacc/Bison, ANTLR, Menhir) are excellent for bootstrapping, grammar documentation, and static conflict analysis, but they can become constraints as a tool matures. Status (as of 2026-04): production compilers and toolchains using hand-written parsers — typically recursive descent plus Pratt/precedence climbing for expressions — include GCC, Clang, Go, rustc, V8, Zig, Ruff (§6.1), and rust-analyzer (§7.8). The usual reasons are custom error recovery, contextual lookahead, incremental reparsing, and hot-path tuning that outweigh the convenience of grammar-driven generation.

This is the decision point that connects the classical algorithms (§2.24–§2.25), generated-tool lineage (§7.3, §7.9), and Ruff's migration (§6.1): the right choice depends less on theoretical power than on who must debug the grammar, own the diagnostics, and optimize the parser. §5.6 covers the contextual-lexer/external-scanner machinery that is usually what pushes a hand-written parser past what a generator can accept; the tree-sitter externals footnote in §8.5 is the practitioner-facing companion.

### 5.3. Ragel — State-Machine Compiler with Embedded Actions

Adrian Thurston's **Ragel** compiles regular expressions plus embedded host-language actions into a finite-state machine, emitting C, C++, D, Go, Ruby, Java, or assembly. The distinctive idea is that actions are attached to state-machine transitions, not to grammar reductions — you can fire arbitrary code on entering, leaving, or transitioning between states, which makes Ragel well-suited to streaming protocol parsers where token boundaries and host-state updates interleave. Ragel has a reputation for producing final code that is faster than hand-written equivalents because the generated control flow maps cleanly onto the CPU's branch predictor.

Ragel's most visible win is **Zed Shaw's Mongrel HTTP parser** (2006): a Ragel grammar for HTTP/1.1 that replaced hand-written request parsers across Ruby web servers. Mongrel's parser was inherited by Thin and then by Puma, which became the default Ruby on Rails server from Rails 5.0 in 2016. The same parser lineage shows up in multiple Python and Node HTTP implementations.

Sources: https://en.wikipedia.org/wiki/Ragel and http://www.colm.net/open-source/ragel/

### 5.4. re2c — Direct-Coded DFAs

**re2c** (Peter Bumbulis originally; Ulya Trofimovich currently) is a lexer generator with a specific performance claim: instead of emitting a table-driven DFA, it emits **direct-coded** DFAs — nested `if`/`switch`/`goto` structures that encode transitions as conditional jumps. Modern re2c uses a lookahead-TDFA algorithm that performs submatch extraction inline. This typically produces faster lexers than table-driven tools and often smaller binaries.

re2c targets C, C++, D, Go, Haskell, Java, JavaScript, OCaml, Python, Rust, Swift, V, and Zig. Status (as of 2026-04): production users include **PHP** (the Zend engine lexer), **Ninja** (whose lexer was rewritten on re2c for speed), SpamAssassin, Yasm, and BRL-CAD.

Sources: https://re2c.org/ and https://github.com/skvadrik/re2c

### 5.5. Hyperscan — Multi-Pattern Streaming Regex with SIMD

**Hyperscan** (Intel, Xiang Wang et al., NSDI 2019) is a different animal: not a lexer generator but a runtime library that matches **thousands of regular expressions simultaneously** against a streaming byte input, using SSE3 and higher SIMD instructions. It supports a streaming mode where match state is carried across data blocks — essential for network traffic that arrives in fragments.

Hyperscan's production adoption is in intrusion detection: it is the default multi-pattern matcher (mpm) in **Suricata** and has been integrated into Snort. The design is genuinely different from traditional lexer generation — there is no "token produced" output; instead user callbacks fire on each pattern match — but it fits the same practical slot when the task is "recognise which of many patterns applies" rather than "tokenise into a syntactic stream". For a compiler lexer, Hyperscan is overkill; for a content-aware firewall or SIEM, it is the state of the art.

Sources: https://www.intel.com/content/www/us/en/developer/articles/technical/introduction-to-hyperscan.html and https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf

### 5.6. Contextual Lexing, Lexer Modes, and Parser-Feedback Tokenization

A traditional lexer commits to a token stream before the parser sees structure. Real languages often violate that clean separation: regex literals vs division in JavaScript, heredocs in shell/Ruby, indentation in Python, nested comments, string interpolation, template languages, JSX, SQL-in-host-language DSLs, and macro systems. The practical solutions are **lexer modes**, **contextual lexers**, **external scanners**, and **scannerless parsing** (§2.16).

Lexer modes are explicit states: after seeing a string opener, the lexer switches to "inside string"; after a heredoc marker, it switches to "heredoc body"; after an interpolation opener, control returns to normal code lexing. Parser-feedback lexers go further: the parser tells the lexer which terminal symbols are valid in the current parse state, and the lexer matches only that subset. Lark's contextual lexer does this for LALR(1), resolving terminal collisions that a context-free lexer would mis-tokenize. **Tree-sitter external scanners** are the hand-written escape hatch when the generated lexer cannot express a token: a grammar declares `externals` and bails out to a hand-written C `scan` function (plus `create`, `destroy`, `serialize`, `deserialize`) for context-sensitive tokens like Python INDENT/DEDENT, Bash and Ruby heredocs, and Ruby percent strings. External scanners take priority over the normal lexer and must participate in incremental-parsing state via `serialize`/`deserialize`. In practice this is where tree-sitter grammars accumulate most of their subtlety — a grammar that looks declarative in the JavaScript DSL often relies on a few hundred lines of hand-written C.

This is often the right compromise for language design: keep the fast regular lexer for ordinary tokens, but allow narrow, well-isolated context hooks for the few places where syntax is not regular.

Sources: https://lark-parser.readthedocs.io/en/stable/examples/advanced/conf_lalr.html and https://oilshell.org/blog/2017/12/17.html and https://tree-sitter.github.io/tree-sitter/creating-parsers/4-external-scanners.html

### 5.7. Grammar Engineering and Conflict Analysis

Parser algorithms are only half of the work; the other half is shaping the grammar so the chosen algorithm behaves well. Core grammar-engineering operations include:
- eliminating direct and indirect left recursion for LL/recursive-descent parsers,
- left-factoring common prefixes,
- computing nullable, FIRST, and FOLLOW sets,
- identifying statement/expression recovery boundaries,
- adding precedence and associativity declarations,
- separating lexical keywords from contextual keywords,
- diagnosing shift/reduce and reduce/reduce conflicts,
- producing minimal counterexample strings for conflicts.

Good parser generators turn conflict analysis into a design tool. Menhir's error-state and conflict tooling (§7.3) is strong here, and langcc's conflict tracing (§7.1) explicitly tries to map LR conflicts back to concrete confusing input pairs. Hand-written parsers need their own equivalent discipline: debug traces, small ambiguity tests, and comments documenting every non-obvious lookahead decision.

Sources: https://gallium.inria.fr/~fpottier/menhir/manual.html and https://langcc.io/

### 5.8. flex / lex — The Historical Baseline

Mike Lesk and Eric Schmidt's **lex** (Bell Labs, 1975) is the canonical lexer generator and the historical baseline every later tool in this chapter is in dialogue with: a regular-expression DSL with embedded host-language action code, compiled to a table-driven DFA. Vern Paxson's **flex** (Berkeley, 1987+) is the open-source rewrite that displaced lex in production usage and is still POSIX-mandated, actively maintained, and the lexer generator of last resort when more modern tools are unavailable.

The architectural place relative to §§5.3–5.5: flex emits **table-driven** DFAs (a 2D transition table walked by a tight interpreter loop), where re2c (§5.4) emits **direct-coded** DFAs (nested `if`/`switch`/`goto`) and Ragel (§5.3) generates state machines with arbitrary action code on transitions. Flex's table-driven approach typically loses to re2c on dispatch speed and to Ragel on action flexibility, but produces smaller generated source and remains the most portable across host-language ecosystems (flex generates C/C++; lex variants exist for Java, Go, OCaml, and others).

The lasting design lesson is that **the regex-DSL-plus-action-code template is the substrate every later lexer generator inherits**. Hand-written lexers in production compilers (§5.2) often look like flex output once keyword recognition (§5.1) and contextual modes (§5.6) are bolted on. flex matters as the design baseline against which Ragel, re2c, Hyperscan, and ANTLR's lexer rules are best understood as departures: direct-coded vs table-driven DFAs (re2c), action-on-transition flexibility (Ragel), SIMD multi-pattern matching (Hyperscan), and integrated grammar/lexer co-generation (ANTLR).

Production: every Unix system's lex/yacc workflow, the Linux kernel's lexer infrastructure, Postfix, ntpd, PostgreSQL's parser, and thousands of long-running C codebases. Status (as of 2026-04): still POSIX-mandated, still maintained, still the default when re2c or Ragel are unavailable or when generated-code portability matters more than dispatch speed.

Sources: https://westes.github.io/flex/manual/ and https://www.gnu.org/software/flex/manual/

---

## 6. Case Studies — Ruff, Forth, and Raku/Rakudo

Three production-oriented parser case studies that anchor the survey in real implementation trade-offs. Ruff shows a modern tool migrating from a generated parser to hand-written recursive descent for speed and diagnostics. Forth shows the opposite of grammar-driven parsing: a tiny extensible text interpreter whose performance comes from compilation strategy rather than syntax analysis. Raku/Rakudo shows a highly extensible grammar system made practical through longest-token matching, slang switching, and action-based lowering.

### 6.1. Generated Parser to Hand-Written Recursive Descent

Ruff is a Python linter and formatter written in Rust. Its parser evolution is one well-documented data point for the broader hand-written-vs-generated trade-off catalogued in §5.2.

Ruff initially used the RustPython parser, then a LALRPOP-generated parser. In v0.4.0 (April 2024), it switched to a hand-written recursive descent parser; the project reported roughly 2x faster parsing and a 20–40% overall speedup across linting and formatting, with 2.2–2.4x speedup per file on micro-benchmarks.

The reasons cited for the migration mirror the general pattern in §5.2:
- **Control and flexibility**: Python has syntactic constructs (e.g., parenthesized `with` items) that the team found awkward to encode in a generator's grammar DSL but straightforward in hand-written code.
- **Performance**: the generated parser was opaque to hot/cold-path distinction and domain-specific tuning. Hand-written code allowed direct control over allocation, lookahead, and branch prediction.
- **Error recovery**: hand-written code allows context-sensitive recovery (inserting missing colons, recovering from invalid assignment targets) directly in local control flow. Generators can support sophisticated recovery via hooks, annotations, or external repair (§4.7), but the previous setup made the necessary recoveries impractical. Diagnostics shifted from generic "Unexpected token" to structured messages like "Expected 'def', 'with' or 'for' to follow 'async', found 'while'".
- **Editor resilience**: a tool that runs as a language server must produce useful trees on syntactically invalid code; the hand-written parser made resilient parsing tractable.

Source: https://astral.sh/blog/ruff-v0.4.0

### 6.2. Case Study — Forth Text Interpreters, Recognizers, and Superinstructions

Forth is a useful outlier because the "parser" is not a grammar-driven syntax-tree builder. A traditional Forth system has a **text interpreter** that repeatedly scans the next blank-delimited word from the input buffer, looks it up in the dictionary, and either executes it immediately or compiles its execution token depending on `STATE`. The input cursor is exposed as `>IN`; words such as `:`, `'`, `."`, `S"`, and defining words are themselves **parsing words** that consume additional characters from the same input stream. This means parsing is extensible at the word level: executing a word can change how the rest of the current source line is consumed.

The performance lesson is separation of concerns. The textual parser is intentionally simple — scan a word, dictionary lookup, recognizer chain, dispatch — while high-performance Forth systems invest in compilation strategy. Modern Forth recognizers generalize the old "if not found, try number conversion" fallback into an extensible chain: one recognizer may identify integers, another floating literals, another quoted strings, another target-specific constants. VFX explicitly calls this out as a way to install new numeric literals and make the text interpreter easier to change; Gforth's manual similarly warns that parsing words should usually have a non-parsing factor because consuming from the input stream is hard to compose. **Gforth** uses direct-threaded execution plus static and dynamic superinstructions in `gforth-fast`; the manual reports roughly 2× speedups from dynamic superinstructions with replication, with similar gains in the broader Ertl/Gregg superinstruction literature.

**VFX Forth** represents the more aggressive native-code end: it preserves Forth's interactive model but compiles optimised native code with inlining and cross-word stack-traffic elimination, generating code MPE describes as within ~25% of hand-written assembler. The parsing lesson is language-agnostic: a tiny extensible surface parser can coexist with serious optimisation if the compilation boundary is chosen carefully.

Sources: https://gforth.org/manual/The-Text-Interpreter.html and https://net2o.de/gforth/The-Input-Stream.html and https://gforth.org/manual/Dynamic-Superinstructions.html and https://mpeforth.com/software/pc-systems/vfx-forth-common-features/

### 6.3. Case Study — Raku/Rakudo Grammars, Slangs, and Longest Token Matching

Raku is the opposite extreme from Forth: the language exposes a powerful grammar system, and the main high-performance implementation, **Rakudo on MoarVM**, is itself written using **NQP** (Not Quite Perl, the Raku-subset implementation language) grammars plus action methods. The front end pairs `Perl6::Grammar`/`Raku::Grammar` with `Perl6::Actions`/`Raku::Actions`; parsing produces a grammar-shaped parse tree, and action methods map it into **QAST** (the Q Abstract Syntax Tree, NQP's compiler-internal IR) or newer RakuAST structures. The later stages lower this into MoarVM's **MAST** (MoarVM Assembly Syntax Tree, the bytecode-adjacent form) and bytecode, so the parser sits in a multi-stage compiler rather than a direct text-interpreter loop. Regexes and grammars are not just libraries: they are parsed and compiled as nested languages in the same compiler pipeline.

The distinctive parser idea is **Longest Token Matching** (LTM). In Raku alternations using `|`, the engine does not simply try alternatives in source order. It extracts the declarative prefix of each branch — the portion representable by a finite-state machine — builds NFA-style matching machinery, and prefers the branch with the longest declarative match, with specificity and textual order as tie-breakers. This is transitive through subrule calls and proto-regexes, so grammar extensions can intermix fairly: a newly introduced operator or term competes by how much input it can consume, not merely by where it was declared.

Rakudo also has **slangs**: separate grammar/action pairs for main language syntax, quoting, regexes, and other nested syntactic domains. A grammar can call into another slang with `LANG`, letting the compiler switch parsing languages mid-file. The performance trick is that this extensibility is not implemented by blindly backtracking through every grammar rule: the QRegex engine extracts finite declarative prefixes, builds NFA-style dispatch at alternation points, and only falls back to slower procedural matching after that prefix can no longer decide. For language design, Raku demonstrates both the power and cost of user-visible grammar machinery: extensibility and embedded languages become first-class, but parser performance depends on extracting finite declarative prefixes and avoiding non-declarative constructs that defeat LTM.

Sources: https://edumentab.github.io/rakudo-and-nqp-internals-course/slides-day1.pdf and https://docs.raku.org/syntax/%7C and https://github.com/rakudo/rakudo/blob/master/src/main.nqp

---

## 7. Additional Parser Tools

Specific tools and libraries outside the main algorithmic families in §2 that nonetheless carry load-bearing implementation ideas worth naming separately. The axis across the entries is "what slot does this tool fill that the algorithm-centric chapters leave empty": langcc generates entire frontend skeletons, Marpa packages Earley/Leo with a programmable recovery API, Menhir and Bison represent industrial LR-family tooling, ungrammar specifies the CST API without being a parser, syn ships recursive descent as a library, SwiftSyntax and @babel/parser anchor production macro/plugin ecosystems, and rust-analyzer's parser crate is the canonical resilient-LL reference implementation.

### 7.1. langcc — XLR Parser Generation for Full Front-Ends

Joe Zimmerman's **langcc** is one of the few serious attempts to make parser generation competitive again for full industrial languages. The interesting claim is not just "another LR generator," but that it extends canonical LR with several implementation ideas — including grammar transformations, per-symbol attributes, recursive-descent actions, and **XLR**, an extension that adds bounded nondeterministic choice to shift/reduce parsing. It also generates much more than a parser: AST types, traversals, hashing, and pretty-printers.

The really original side is the developer ergonomics around conflicts. Rather than dumping opaque shift/reduce tables, langcc includes a **conflict tracing** story that tries to map LR conflicts back to explicit confusing input pairs. That is exactly the sort of feature parser generators historically needed and mostly failed to provide.

langcc offers a grammar-first workflow that generates a full frontend with unusually strong performance claims and serious conflict diagnosis — offset by a research-tool ecosystem far less battle-tested than Menhir, tree-sitter, or ANTLR, and with fewer production case studies.

Sources: https://langcc.io/ and https://arxiv.org/abs/2209.08383

### 7.2. Marpa — Earley/Leo Parsing with "Ruby Slippers" Recovery

**Marpa** is Jeffrey Kegler's practical general parser in the Earley/Leo family. The marquee property is that it aims to parse any BNF grammar exactly, without forcing arbitrary conflict resolution, while still achieving linear-time behavior on large practical classes of grammars. Unlike PEG, it is not based on ordered choice, so it keeps the exact CFG meaning instead of embedding parsing policy into the grammar. Marpa also pairs the engine with **Ruby Slippers** programmable recovery — described in §4.5 — which turns error recovery into a host-driven token-injection interface.

Marpa offers exact CFG semantics with unrestricted recursion, a programmable recovery/event model, and parse-forest-friendly output — at the cost of a smaller ecosystem, a less familiar mental model than recursive descent or LR, and ambiguity management that pushes complexity into later phases.

Source: https://jeffreykegler.github.io/Marpa-web-site/

### 7.3. Menhir — Industrial LR(1) with Incremental and Error-Message APIs

**Menhir** is OCaml's modern yacc, but two implementation ideas separate it from the classical lineage. The first is the **incremental API** (in `--table` mode): parser states are persistent data structures, so parsing can stop at any token boundary and resume from a saved checkpoint — exactly the substrate IDE integration and custom recovery want. The second is **error-message infrastructure**, building on François Pottier's "Reachability and Error Diagnosis in LR(1) Parsers" (CC 2016): given an LR(1) automaton, the tool enumerates every state in which an error can be detected and computes a minimal input sentence that drives the parser to that state. The grammar author maintains a `.messages` file pairing each erroneous sentence with a hand-written diagnostic, and the `--compile-errors` workflow verifies coverage as the grammar evolves. CompCert's C parser has used this in production; the result is per-error-state prose that reads as if hand-authored, qualitatively unlike ANTLR4's defaults (§2.19).

Menhir also exposes an inspection API for parser states and an unparsing API for AST-to-text round-trips, which most generators omit. The trade-offs are OCaml-centricity and larger generated tables/code when advanced APIs are enabled.

Source: https://gallium.inria.fr/~fpottier/menhir/manual.html

### 7.4. Ungrammar — Generate the Concrete Syntax Tree API, Not the Parser

rust-analyzer's **ungrammar** is not a parser generator at all, and that is exactly why it is interesting. It specifies the **shape of the concrete syntax tree** as a schema and generates the typed API for navigating that tree. The parser itself can stay hand-written or otherwise independently engineered.

This addresses a real pain point: the grammar shape you need for parsing is often not the tree shape you want to expose to tools. Left-recursion elimination, precedence encoding, and recovery scaffolding distort parse trees. Ungrammar decouples "how do I parse strings?" from "what typed tree API do I want clients to use?"

Ungrammar cleanly separates parser mechanics from CST API design — ideal for IDE/tooling stacks and lossless trees — but it is not a parser, adds another specification layer, and is most useful only once you already care about a typed CST API.

Source: https://rust-analyzer.github.io/blog/2020/10/24/introducing-ungrammar.html

### 7.5. syn — Library-Shaped Recursive-Descent for a Full Language (Rust)

David Tolnay's **syn** is the parser used by virtually every Rust procedural macro. It is a hand-written recursive-descent parser for the full Rust grammar, shaped as a library rather than a compiler subsystem. The input is a `proc_macro2::TokenStream` — already lex-and-grouped by the compiler into a token tree with balanced delimiters — and output is a rich hierarchy of typed AST nodes, one Rust `struct` or `enum` per syntactic category.

The design point most worth copying is the `Parse` trait: every AST node type implements `fn parse(input: ParseStream) -> Result<Self>`, and arbitrary node types compose via `input.parse::<T>()?`. Users extend the parser by implementing `Parse` on their own types, typically combined with `custom_keyword!` to declare identifiers that should be treated as reserved words in a local DSL. This gives macro authors the ergonomics of a parser generator (type-driven composition, per-node error messages) without a separate grammar file or build step — the grammar *is* Rust type definitions.

syn is influential beyond Rust because it demonstrates that a full production-language parser can live as a library with a stable public API — it is the token-to-AST layer for thousands of `#[derive(...)]` macros, `quote!`, `html!`, `sqlx::query!`, and serde-style data-binding frameworks. The price is coupling to Rust's grammar evolution (syn tracks every new syntactic feature) and build-time cost, since every proc macro compiles a non-trivial syn slice into every host crate.

Source: https://github.com/dtolnay/syn

### 7.6. SwiftSyntax — Full-Fidelity Trees for Compiler Plugins

SwiftSyntax is covered as a representation in `REPRESENTATIONS.md §2.3`; the parser-tooling lesson belongs here. Swift's macro system made the syntax tree a language extension boundary: user-written macros receive a full-fidelity tree and return rewritten syntax, so the parser must preserve every token, comment, and whitespace trivia needed for byte-exact round-tripping.

SwiftSyntax is evidence that if macros operate on syntax rather than typed IR, losslessness is not optional. The parser output becomes part of the public language API, with the upside of source-preserving macros and formatters and the downside of a larger syntax-tree dependency surface.

### 7.7. Babel — Options-Driven Grammar for Evolving Standards

**@babel/parser** is the JavaScript / TypeScript parser used across the Babel, webpack, Rollup, and adjacent ecosystems. Its defining architectural choice is a **plugin-based grammar**: new syntactic features are compiled into the parser but dormant until enabled per-parse via an options bag (`{ sourceType, plugins: ["jsx", "typescript", "decorators"] }`). Plugins can hook into specific grammar productions, so the same parser binary can simultaneously support stable ECMAScript, JSX, TypeScript, Flow, and any number of TC39 Stage-0 through Stage-3 proposals gated behind flags.

This architecture is directly driven by JavaScript's standards process: new syntax proposals land in the parser as plugins long before they become part of the language, so tooling, linters, and babel-transforms can experiment with them; when TC39 advances a proposal, the plugin is retained but enabled by default. Status (as of 2026-04): the plugin interface is documented as internal, not (yet) open to external plugins, because guaranteeing grammar composability across arbitrary third-party plugins remains unsolved. TC39 stage assignments evolve continuously, so any specific stage list dates quickly.

Babel's parser is strictly more expressive than a fixed-grammar approach (syn, rustc's parser) at the cost of ambiguity — the same source bytes can parse differently under different plugin combinations, and some plugins are incompatible with others. The trade-off fits JavaScript's reality: multiple syntactic dialects must coexist in the same toolchain, and the grammar is effectively a moving target.

Sources: https://babeljs.io/docs/babel-parser and https://github.com/babel/babel/tree/master/packages/babel-parser

### 7.8. rust-analyzer Parser — Resilient LL for IDE-Grade Tolerance

rust-analyzer's own parser lives in the `parser` crate and is distinct from §7.5 syn: syn consumes an already-lex-and-grouped `proc_macro2::TokenStream`, while rust-analyzer's parser reads Rust source directly and produces a rowan (§3.2) concrete syntax tree. Architecturally it is hand-written recursive descent with **event-driven tree construction**: the parser emits a stream of `StartNode(kind)`, `FinishNode`, `Token`, and `Error` events, and a separate sink assembles them into a rowan green tree. That decoupling is what lets the same parser power both full-file parses and macro-expansion sub-parses.

The load-bearing design choice is **resilience**: the parser is built to produce a usable tree on *any* input, however broken. Matklad's "Resilient LL Parsing Tutorial" (2023) documents the pattern. Each parsing function consumes a well-formed prefix and bails with an inline `ERROR` node rather than propagating failure; an unrecognised token in statement position becomes an `ERROR` node beside its well-formed neighbours rather than poisoning the enclosing function. A mistake in one `fn` does not interfere with parsing the next. This matters because rust-analyzer runs on every keystroke against files that are syntactically invalid most of the time; there is no "parse error, stop" mode.

Unlike syn, which can assume balanced delimiters and skip recovery work, rust-analyzer's parser pays constant complexity for resilience and for the event-plus-sink indirection — but it gains the ability to serve an IDE. Compared with tree-sitter's parallel-strategies recovery (§4.2), resilient LL is cheaper per parse (no speculative forking) but relies harder on the parser author encoding recovery points explicitly in each production. The design is now imitated by Lelwel, Typst's parser, and several recent resilient-LL generators.

Sources: https://github.com/rust-lang/rust-analyzer/tree/master/crates/parser and https://matklad.github.io/2023/05/21/resilient-ll-parsing-tutorial.html

### 7.9. Yacc/Bison — The Classic LR Parser Generator Lineage

Yacc established the classic Unix parser-generator shape: a grammar file with tokens, precedence declarations, productions, and semantic actions; generated C code implementing an LALR(1) shift/reduce parser; and conflict reports for grammar ambiguities. GNU Bison is the modern continuation, supporting traditional LALR(1), canonical LR(1), IELR(1), and GLR.

This section exists as the tool-specific complement to the algorithm overview in §2.26. Bison matters because many parser concepts are easiest to understand in its vocabulary: shift/reduce conflicts, reduce/reduce conflicts, `%left`/`%right` precedence declarations, `%prec` overrides, semantic value stacks, location stacks, and generated error paths. Even when an implementer chooses recursive descent or tree-sitter, knowing the Yacc/Bison model clarifies what is gained and lost by leaving table-driven LR.

Source: https://www.gnu.org/software/bison/manual/bison.html

### 7.10. LALRPOP — LR(1) Parser Generator for Rust

Niko Matsakis's **LALRPOP** (2015+) is the Rust-ecosystem LR(1) parser generator: grammar declarations in a `.lalrpop` file, compiled to Rust code via a build-script step, producing an LALR(1) (with `LR(1)` opt-in) parser whose action functions are Rust expressions. The design is clearly in the yacc/Bison lineage (§7.9) but optimised for Rust idioms — pattern matching on token enums, lifetime-parameterised AST nodes, errors via `Result`, and grammar rule combinators that play well with macros.

Distinguishing features:

- **Rust-native action code**: each grammar rule's action is an arbitrary Rust expression with full access to the type system, generic pattern matching, and lifetime annotations. Compare yacc/Bison where action code is C and AST construction is type-cast-heavy.
- **Built-in fallible actions**: rules can return `Result<T, E>` and LALRPOP integrates this into the parsing automaton without panic-or-die error paths.
- **Macro-friendly grammar combinators**: `Comma<T>` (comma-separated list), `Tier<Op, Next>` (precedence-climbing scaffold) and similar parameterised rules are first-class in LALRPOP's macro layer.
- **Full LALR(1) and opt-in LR(1)**: most grammars use the smaller LALR(1) tables; conflicting grammars opt into canonical LR(1).

Production: rustc historically used LALRPOP for some embedded-DSL parsing; Ruff (§6.1) used a LALRPOP-generated Python parser before migrating to hand-written recursive descent. Ruff's migration story is the broader practitioner lesson: LALRPOP is excellent for bootstrapping and grammar documentation but generates parsers harder to hand-tune for hot paths, error recovery, and contextual lookahead than recursive descent. The same tension Tratt's "Which Parsing Approach?" essay frames (§8.4) plays out here: LALRPOP's static-conflict-detection advantage matters when correctness-by-construction is the priority; recursive descent wins when latency, recovery, or domain-specific lookahead is.

Status (as of 2026-04): production-stable, still maintained, the de facto LR(1) parser generator for Rust when one is needed.

Sources: https://lalrpop.github.io/lalrpop/ and https://github.com/lalrpop/lalrpop

### 7.11. Language Workbenches and Grammar-Centered Tooling

A newer line of parser-adjacent work treats the grammar not merely as input to a parser generator, but as the starting point for a **tooling stack**: parser, formatter, language-server integration, and sometimes reference resolution or editor services. The question is no longer only "what algorithm recognizes this language?" but "how much of the surrounding tooling can be derived from one authoritative syntax specification?"

**AnyText** (SLE 2025) is a strong current example. It combines a scannerless, incremental packrat parser with left-recursion support, an EBNF-like grammar notation, formatting instructions that drive pretty-printing, and first-class LSP support from the same language definition. This is a materially different design point from classic parser generators: the grammar becomes part of a broader language-workbench substrate.

The attraction is obvious. A language author wants one source of truth for syntax and enough generated infrastructure that adding a feature to the language does not require hand-maintaining the parser, pretty-printer, and editor support in lockstep. But the cost is also real. The 2025 MontiCore experience report on **Challenges of Modular Language Design** is a valuable counterweight: compositional language engineering introduces substantial infrastructure complexity, parser-composition edge cases, and pressure from the limitations of target languages and host compilers.

The parser-design lesson is therefore double-sided:
- a single-source grammar can become the center of a powerful tooling ecosystem;
- modular syntax composition and language-workbench generation should be treated as major architectural commitments, not as a small extension of parser generation.

For a new language, this section is the bridge between ordinary parsing and the broader language-engineering question: whether the syntax definition should remain a compiler-internal artifact or become the source of truth for editor and tooling infrastructure as well.

Sources: https://dl.acm.org/doi/10.1145/3732771.3742716 and https://dl.acm.org/doi/10.1145/3732771.3742717 and https://www.spoofax.dev/background/bibliography/sdf3/

---

## 8. Community Marginalia Worth Mining

The following are not primary sources; they are useful because they capture practitioner experience, implementation folklore, and sharp one-paragraph explanations that papers often omit.

### 8.1. Tree-sitter Praise and Pushback

HN threads on tree-sitter capture both the usual praise (compact trees, explicit `ERROR` nodes, good fit for per-keystroke parsing) and grammar-author criticism (external scanners, generated bulk, conflict-behaviour debugging) — useful balance against the official docs.

Sources: https://news.ycombinator.com/item?id=26225298 and https://news.ycombinator.com/item?id=39768020

### 8.2. Ungrammar in One Sentence

An HN explanation of **ungrammar** gets to the core idea in one paragraph: it is not really about parsing strings, but about generating the **concrete syntax tree node API**. That is a valuable framing to keep around because it helps readers separate grammar engineering from tree-API engineering.

Sources: https://news.ycombinator.com/item?id=24878098 and https://news.ycombinator.com/item?id=37119482

### 8.3. langcc as "More Than a Parser Generator"

The HN discussion around langcc highlights a key implementation point that can be easy to miss from the name alone: langcc is trying to generate a **whole frontend skeleton**, not just a parser. That makes it a closer relative of syntax/IR workbenches than of classic yacc.

Source: https://news.ycombinator.com/item?id=32949019

### 8.4. Tratt — "Which Parsing Approach?"

Laurence Tratt's 2020 essay is the most-cited recent practitioner comparison of LR, LL (recursive descent), PEG, GLR, Earley, and Marpa from a language-implementer's perspective. The sharp claim is that recursive descent — though the dominant production choice (§5.2) — silently resolves ambiguities the programmer may not realise exist, and that LR parsing's static ambiguity detection is undervalued. Tratt treats generalised parsers (Earley/GLL/GLR) as the dynamic-typing analogue for grammars: expressive and safe, but with errors deferred to runtime.

Worth reading alongside this document because it argues a position the survey above deliberately does not take: that the LR family deserves more attention than the hand-written-RD consensus currently gives it. That framing is a useful counterweight when choosing between §2.19 ANTLR4, §7.3 Menhir, and §5.2 hand-written for a new project.

Source: https://tratt.net/laurie/blog/2020/which_parsing_approach.html

### 8.5. Tree-sitter External Scanners

The practitioner pushback worth preserving: external scanners are the friction point most commonly named by grammar authors (see §8.1). A grammar that looks declarative in the JavaScript DSL often relies on a few hundred lines of hand-written C to handle context-sensitive tokens — worth knowing about before committing to tree-sitter for a layout-sensitive or heredoc-heavy language. See §5.6 for the mechanism.

Source: https://tree-sitter.github.io/tree-sitter/creating-parsers/4-external-scanners.html

---

## 9. Summary of Parser Techniques

Rows are grouped by family. Within a group, order roughly follows the body text.

### 9.1. Source position strategies

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| Span per AST node (lo+hi) | 8–12 bytes/node | O(1) access | Memory vs convenience | rustc, swc (§1.1) |
| Compact token positions | usually one or a few `token.Pos` fields/node | O(1) access, structural `End()` where possible | Much smaller than full spans, but not uniformly one field | Go `token.Pos` (§1.1) |
| Bit-packed source range | 8 bytes/range | O(1) access | File count/size limits | Cuik (§1.1) |
| Width-only green nodes | no absolute offsets; width still stored | O(depth) to resolve | Enables incremental reparse | Roslyn, rowan (§1.2) |
| Token-indexed AST / relative IR locations | compact indices/offsets, not full spans | O(1) via token table during parsing; later via retained/reloadable source metadata | Separates parse-time AST positions from post-lowering diagnostic locations | Zig (§1.2, §3.3) |
| Full-fidelity syntax tree / red-green tree | Parser emits CST with retained trivia | Width-only nodes with O(depth) position resolution; incremental reuse | Parser must produce stable, lossless output for macros/formatters; layout details in `REPRESENTATIONS.md §2` | SwiftSyntax, Roslyn, rowan-style systems (§3.2, §7.6) |

### 9.2. Expression and operator parsing

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| Pratt parsing | O(1) per operator | Drives parse via binding power | Only for expressions | Most hand-written parsers (§2.1) |
| Precedence climbing | Single recursive fn | O(tokens) | Same power as Pratt, simpler for fixed op sets | Clang expression parser (§2.2) |
| Shunting-yard | Operator stack + output queue | O(tokens) | Excellent for expression-only translators, weaker for rich syntax | calculators, bytecode emitters (§2.26) |
| Operator-precedence grammars | Precedence relation table | Linear for restricted grammars | Historical formalism behind precedence declarations | Floyd, yacc-style precedence (§2.26) |

### 9.3. PEG family

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| PEG/packrat | O(input × rules) memo table | O(input) guaranteed | Memory for time | pegen (CPython 3.9+) (§2.3) |
| PEG without packrat | Recursive-descent | Fast common case, no linear guarantee | Simpler, pathological-input risk | pest (§2.4) |
| PEG parsing machine | Bytecode + two stacks | Fast common case, exponential worst | Compact runtime, no memoisation | LPeg (§2.5) |

### 9.4. Generalized CFG parsers

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| GLL parsing | GSS + SPPF | O(n³) worst, often O(n) on deterministic subsets | Handles all CFGs, no restrictions | Iguana (§2.6) |
| Tomita GLR + GSS | Graph-structured stack + SPPF | O(n³) worst, O(n) on LR parts | Arbitrary CFG, ambiguity as output | classic GLR, SGLR (§2.7) |
| Earley + Leo | Earley items per position | O(n) on LR(k), O(n³) worst | Any CFG, ambiguity as output | Lark, Marpa (§2.8) |
| CYK / Valiant | O(n²) table / matrix | O(n³) / O(n^2.81) | Theoretical anchors for general CFG | textbooks, NLP (§2.9) |
| Parsing with derivatives | Brzozowski's extension | Naive exponential; practical variants depend on memoization, laziness, and grammar restrictions | Elegant functional formulation, but complexity control is nontrivial | functional parsers (§2.10) |
| Ambiguity + SPPF | Packed forest | Polynomial sharing of many parses | Ambiguity becomes downstream policy | GLR, GLL, Earley, Lark (§2.27) |

### 9.5. Incremental and editor-oriented

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| Incremental LR with selective GLR conflicts (tree-sitter) | Full syntax tree | Usually proportional to changed region; worst case can reparse more | Editor-usable tree over invalid input, with explicit `ERROR` or missing nodes | Neovim, Helix, Zed (§2.11) |
| Lezer parser | Compact JS tree | Incremental reparse; linear full parse | No Wasm overhead | CodeMirror 6 (§2.12) |
| Resilient LL + rowan | Event stream + ERROR nodes | Linear, constant recovery cost | Always produces a tree; per-production recovery | rust-analyzer, Typst, Lelwel (§7.8) |
| Hybrid structured editing + partial parsing | Parser + editor-maintained structure | Incremental on edited regions, with extra editor-side bookkeeping | Keeps keyboard-centric text workflows while preserving more structure than plain text parsing | Partial Parsing for Structured Editors, Tratt's incremental-structured-editing framing (§2.24) |
| Workbench-generated incremental parsing + pretty-printing | Grammar plus generated infrastructure | Depends on workbench/runtime complexity | Single-source syntax for parser, formatter, and LSP comes with larger tooling commitment | AnyText (§7.11) |

### 9.6. Lexing and tokenization

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| SIMD tokenization | Sentinel padding needed | ~2.75x faster than scalar | Architecture-specific | Accelerated-Zig-Parser (§2.13) |
| SIMD structural parsing | Two-pass index generation | Parses at RAM speed | Memory bandwidth bottleneck | simdjson, simdcsv (§2.14) |
| FSM compiler with action hooks | States + transition actions | Streaming-friendly | Protocol parsers | Ragel (Mongrel, Puma) (§5.3) |
| Direct-coded DFA lexer | if/switch/goto chains | Faster than tables | Generator-specific output | re2c (PHP, Ninja) (§5.4) |
| SIMD multi-pattern matcher | SSE/AVX pattern state | Gigabits/s streaming | Not a tokenizer; match-callbacks | Hyperscan (Suricata) (§5.5) |
| Contextual lexer / lexer modes | Mode state or parser feedback | Fast regular lexing with context hooks | Needed for heredocs, interpolation, embedded DSLs | Lark contextual lexer, tree-sitter externals (§5.6) |
| Table-driven DFA generator | Generated transition tables | Slower than direct-coded DFA, faster than table-walk interpreters | Most portable across host languages; POSIX-mandated | flex / lex (§5.8) |

### 9.7. Special parser styles

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| Hand-written recursive descent | Direct Rust/C code | Can outperform generated parsers in tuned production cases; linear on designed grammar | More code to maintain | Ruff, GCC, Clang, Go, Rust (§2.24, §5.2) |
| Deterministic LL/LR | Parse stack or call stack | Linear for accepted grammar class | Static conflicts vs grammar restrictions | LL(1), LALR(1), LR(1), IELR(1) (§2.25) |
| Library-shaped RD parser | Typed node hierarchy | Hand-written RD performance; extra API/compile-time costs depend on use | Macro/DSL substrate, no grammar file | syn (Rust) (§7.5) |
| Parser combinators | Host-language values | Runtime composition cost | Typed in host, no generator; slower than RD | Parsec, nom, chumsky, winnow (§2.18) |
| ALL(*) adaptive LL | Lazy prediction DFAs | Linear on practical grammars, O(n⁴) worst | No grammar conflict engineering | ANTLR4 (§2.19) |
| Scannerless parsing | Single grammar | Slower (more ambiguity) | Composable grammars, no lexer hack | SGLR, Rascal (§2.16) |
| Externalised semantic actions | Grammar file + visitor | One parse, many semantics | Modular, but no inline shortcuts | Ohm (§2.20) |
| Layout stage (offside rule) | Context stack per file | Linear | Parser stays CFG; parse-error rule is hairy | Haskell, Python, F#, Nim (§2.21) |
| Options-driven plugin grammar | One parser, many dialects | Per-plugin dispatch | Evolving standards in one binary | @babel/parser (§7.7) |
| Extensible reader / syntax table | Runtime-mutable grammar | Dispatch per token | Language extension as library | Racket readtable, Lean 4, Rhombus (§2.22) |
| Pattern-spec macro parser | Syntax classes | One parse, structured errors | Macro-input parsing with per-form diagnostics | Racket syntax-parse (§2.23) |
| Syntax-directed translation | Semantic actions / attributes | Work attached to productions | Convenient but can couple grammar to one consumer | yacc actions, NQP actions, attribute grammars (§2.28) |
| Text interpreter | Input cursor + dictionary lookup | Tiny extensible parser | Parsing words mutate source consumption | Forth, Gforth, VFX (§6.2) |
| Longest-token grammar engine | NFA over declarative prefixes | Prunes alternatives by longest match | Powerful extensibility; non-declarative parts limit LTM | Raku/Rakudo (§6.3) |
| Yacc/Bison LR generator | Tables + semantic stack | Linear; generator reports conflicts | Classic LR workflow, less custom recovery | Bison LALR/LR/IELR/GLR (§7.9) |
| LR(1) parser generator (Rust) | Tables + Rust action functions | Linear; tablegen at build time | Static conflict detection vs hand-written tunability | LALRPOP (§7.10) |

### 9.8. Error recovery

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| Insertion-only error correction | 1 byte per parser state | Per-error-site | Always produces valid output | Röhrich (1980) (§4.3) |
| Typed holes | Language-level feature | Per-hole type inference | Requires language co-design | Hazel (§4.4) |
| Ruby Slippers recovery | Programmable token injection | Handler per recovery point | Recovery as API, not heuristic | Marpa (§4.5) |
| Recovery-as-specification | Insertion-mode state machine | Linear | Spec-equivalent DOM structure on any input; huge spec | HTML5, CSS forgiving selectors (§4.6) |
| LR(1) error-state messages | `.messages` file + enumeration | Compile-time verified coverage | Author-written diagnostics tied to states | Menhir + Pottier CC 2016 (§7.3) |
| Minimum-distance repair | Search over insert/delete/substitute repairs | Per-error search with timeout | Better diagnostics, fewer cascades | Burke–Fisher, CPCT+ (§4.7) |
| Resilient parsing for interactive tooling | Extra error/placeholder nodes and recovery logic | Usually linear full parse; locality depends on design | Keeps semantic tooling alive on incomplete code, but often complicates parser architecture | rust-analyzer, Hylo work, resilient LL (§4.8, §7.8) |

### 9.9. Flat and compact AST representations

The full-fidelity red/green and token-indexed designs already appear in §9.1 from the source-position angle (§§3.2, 3.3); rows below cover layouts that have no position-strategy correspondence. Chapter §8 (Community Marginalia) is supplementary practitioner reading and is intentionally not summarised here.

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| Postfix expression array | Flat reverse-Polish array | Sequential walk for random access | Cache locality, trivial serialization, no per-node pointers | Cuik (§3.1) |
| Arena + 32-bit offsets | Half a pointer per relation | O(1) random access | Pointer-free layout, cache-friendly | arena-parser idiom (§3.4) |
| Lossless syntax tree (ASDL) | Larger trees, retains trivia | One parse, dual-purpose (exec + tooling) | Round-trips for source-to-source tooling | Oil/OSH/YSH (§3.5) |

---

## 10. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Source Location Strategies

1. rustc `Span` and source-map internals — https://rustc-dev-guide.rust-lang.org/diagnostics.html
2. swc spans and source maps — https://rustdoc.swc.rs/swc_common/struct.Span.html
3. Go `token.FileSet`, `token.Pos`, and `go/ast` positions — https://pkg.go.dev/go/token and https://pkg.go.dev/go/ast
4. Zig compiler AST/token storage — https://github.com/ziglang/zig/tree/master/lib/std/zig
5. Roslyn immutable trees — https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-syntax
6. rowan red-green syntax trees — https://github.com/rust-analyzer/rowan

### Chapter 2 — Parser Architectures

1. Pratt Parsers: Expression Parsing Made Easy — https://journal.stuffwithstuff.com/2011/03/19/pratt-parsers-expression-parsing-made-easy/
2. Parsing Expressions by Precedence Climbing (Bendersky, 2012) — https://eli.thegreenplace.net/2012/08/02/parsing-expressions-by-precedence-climbing
3. Norvell — Parsing Expressions by Recursive Descent — https://www.engr.mun.ca/~theo/Misc/exp_parsing.htm
4. PEG parsers (pegen) — https://we-like-parsers.github.io/pegen/peg_parsers.html
5. PEP 617 — New PEG parser for CPython — https://peps.python.org/pep-0617/
6. Packrat Parsers Can Support Left Recursion (Warth, Douglass, Millstein, PEPM 2008) — https://web.cs.ucla.edu/~todd/research/pub.php?id=pepm08
7. Incremental packrat parsing / GPeg (Yedidia & Chong, 2021) — https://arxiv.org/abs/2104.11050
8. pest — https://pest.rs/
9. pest GitHub — https://github.com/pest-parser/pest
10. LPeg: A parsing machine for PEGs (Medeiros & Ierusalimschy, DLS 2008) — https://www.inf.puc-rio.br/~roberto/docs/peg.pdf
11. LPeg site — http://www.inf.puc-rio.br/~roberto/lpeg/
12. GLL Parsing (Scott & Johnstone) — https://pure.royalholloway.ac.uk/en/publications/purely-functional-gll-parsing
13. Tomita — An Efficient Augmented Context-Free Parsing Algorithm (Computational Linguistics, 1987) — https://aclanthology.org/J87-1004.pdf
14. Right Nulled GLR Parsers (Scott & Johnstone, TOPLAS 2006) — https://dl.acm.org/doi/pdf/10.1145/1146809.1146810
15. Earley parser — https://en.wikipedia.org/wiki/Earley_parser
16. Lark parser toolkit — https://github.com/lark-parser/lark
17. CYK algorithm — https://en.wikipedia.org/wiki/CYK_algorithm
18. Fast CFG Parsing Requires Fast Boolean Matrix Multiplication (Lee) — https://www.cs.cornell.edu/home/llee/papers/bmmcfl-jacm.home.html
19. Parsing with Derivatives: A Functional Pearl (Might, Darais & Spiewak, ICFP 2011) — https://matt.might.net/papers/might2011derivatives.pdf
20. Tree-sitter — https://tree-sitter.github.io/tree-sitter
21. Tree-sitter grammar DSL conflict handling — https://tree-sitter.github.io/tree-sitter/creating-parsers/2-the-grammar-dsl.html
22. Lezer (Marijn Haverbeke) — https://marijnhaverbeke.nl/blog/lezer.html
23. Accelerated-Zig-Parser — https://github.com/Validark/Accelerated-Zig-Parser
24. simdjson: Parsing Gigabytes of JSON per Second (Langdale & Lemire, VLDB 2019) — https://arxiv.org/abs/1902.08318
25. simdjson project — https://simdjson.org/
26. Meriyah — https://github.com/nicolo-ribaudo/meriyah
27. Scannerless Parsing — https://en.wikipedia.org/wiki/Scannerless_parsing
28. One Parser to Rule Them All (Data-Dependent Grammars) — https://ir.cwi.nl/pub/24027/24027B.pdf
29. TCC (Tiny C Compiler) — https://bellard.org/tcc/
30. Parsec: Direct Style Monadic Parser Combinators (Leijen & Meijer) — https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/parsec-paper-letter.pdf
31. Megaparsec — https://github.com/mrkkrp/megaparsec
32. nom (Rust parser combinators) — https://github.com/rust-bakery/nom
33. winnow (Rust) — https://github.com/winnow-rs/winnow
34. chumsky (Rust) — https://github.com/zesterer/chumsky
35. Adaptive LL(*) (Parr, Harwell, Fisher, OOPSLA 2014) — https://www.antlr.org/papers/allstar-techreport.pdf
36. ANTLR4 — https://github.com/antlr/antlr4
37. Modular Semantic Actions (Warth et al., DLS 2016) — https://ohmjs.org/pubs/dls2016/modular-semantic-actions.pdf
38. OMeta (Warth & Piumarta, DLS 2007) — http://www.tinlizzie.org/~awarth/papers/dls07.pdf
39. Haskell 2010 Report, Chapter 10 (Layout) — https://www.haskell.org/onlinereport/haskell2010/haskellch10.html
40. Principled Parsing for Indentation-Sensitive Languages (Adams) — https://michaeldadams.org/papers/layout_parsing/LayoutParsing.pdf
41. Racket Readtables — https://docs.racket-lang.org/reference/readtables.html
42. Lean 4 system description (de Moura & Ullrich, CADE 2021) — https://lean-lang.org/papers/lean4.pdf
43. Rhombus (OOPSLA 2023) — https://users.cs.utah.edu/plt/publications/oopsla23-faadffggkkmppst.pdf
44. Shrubbery Notation — https://docs.racket-lang.org/shrubbery/index.html
45. Fortifying Macros (Culpepper & Felleisen, JFP 2012) — https://www2.ccs.neu.edu/racket/pubs/c-jfp12.pdf
46. Racket syntax-parse docs — https://docs.racket-lang.org/syntax/Parsing_Syntax.html
47. Parsing Techniques — A Practical Guide — https://dickgrune.com/Books/PTAPG_2nd_Edition/index.html
48. GNU Bison Manual — https://www.gnu.org/software/bison/manual/bison.html
49. Shunting-yard algorithm — https://en.wikipedia.org/wiki/Shunting_yard_algorithm
50. Operator-precedence parser — https://en.wikipedia.org/wiki/Operator-precedence_parser
51. Lark parser algorithms — https://lark-parser.readthedocs.io/en/stable/parsers.html
52. Tree-sitter grammar writing guide — https://tree-sitter.github.io/tree-sitter/creating-parsers/3-writing-the-grammar.html
53. L-attributed Attribute Grammars — https://web.cs.wpi.edu/~cs544/PLT6.5.2.html
54. Attribute Grammars — https://cecs.wright.edu/~tkprasad/papers/Attribute-Grammars.pdf
55. Parsing Beyond Context-Free Grammars — https://link.springer.com/book/10.1007/978-3-642-14846-0

### Chapter 3 — Flat and Compact AST Representations

1. Cuik (RealNeGate) — https://github.com/RealNeGate/Cuik
2. Roslyn Red-Green Trees — https://ericlippert.com/2012/06/08/red-green-trees/
3. Zig ZIR documentation — https://github.com/ziglang/zig/blob/master/src/Zir.zig
4. HN: Arena-based parsers — https://news.ycombinator.com/item?id=40276112
5. From AST to Lossless Syntax Tree — https://www.oilshell.org/blog/2017/02/11.html

### Chapter 4 — Error Recovery

1. Röhrich Error Correction (1980) — https://link.springer.com/article/10.1007/BF00263989
2. Hazel Typed Holes — https://hazel.org/
3. Marpa and the Ruby Slippers — https://jeffreykegler.github.io/Ocean-of-Awareness-blog/individual/2011/11/marpa-and-the-ruby-slippers.html
4. HTML Standard — Parsing HTML documents — https://html.spec.whatwg.org/multipage/parsing.html
5. Princeton COS 320 Error Recovery notes — https://www.cs.princeton.edu/courses/archive/spr04/cos320/notes/error-recovery.pdf
6. Don't Panic! Better, Fewer, Syntax Errors for LR Parsers — https://arxiv.org/abs/1804.07133
7. Resilient LL Parsing Tutorial — https://matklad.github.io/2023/05/21/resilient-ll-parsing-tutorial.html
8. Error-Tolerant Parsing and Compilation for Hylo — https://repository.tudelft.nl/record/uuid:5f796ca0-1b65-4d28-9255-6cb4b6810817

### Chapter 5 — Parser Techniques

1. gperf Perfect Hash Generator — https://www.gnu.org/software/gperf/
2. Ragel (Wikipedia) — https://en.wikipedia.org/wiki/Ragel
3. Ragel project page — http://www.colm.net/open-source/ragel/
4. re2c — https://re2c.org/
5. re2c GitHub — https://github.com/skvadrik/re2c
6. Hyperscan introduction (Intel) — https://www.intel.com/content/www/us/en/developer/articles/technical/introduction-to-hyperscan.html
7. Hyperscan: A Fast Multi-pattern Regex Matcher (Wang et al., NSDI 2019) — https://www.usenix.org/system/files/nsdi19-wang-xiang.pdf
8. Lark contextual lexer example — https://lark-parser.readthedocs.io/en/stable/examples/advanced/conf_lalr.html
9. Oil Shell: When Are Lexer Modes Useful? — https://oilshell.org/blog/2017/12/17.html
10. Menhir manual — https://gallium.inria.fr/~fpottier/menhir/manual.html
11. langcc — https://langcc.io/
12. flex manual (Westes) — https://westes.github.io/flex/manual/
13. GNU flex — https://www.gnu.org/software/flex/manual/

### Chapter 6 — Case Studies — Ruff, Forth, and Raku/Rakudo

1. Ruff v0.4.0: Hand-Written Recursive Descent Parser — https://astral.sh/blog/ruff-v0.4.0
2. Gforth Text Interpreter — https://gforth.org/manual/The-Text-Interpreter.html
3. Gforth Input Stream — https://net2o.de/gforth/The-Input-Stream.html
4. Gforth Dynamic Superinstructions — https://gforth.org/manual/Dynamic-Superinstructions.html
5. VFX Forth common features — https://mpeforth.com/software/pc-systems/vfx-forth-common-features/
6. Rakudo and NQP Internals course — https://edumentab.github.io/rakudo-and-nqp-internals-course/slides-day1.pdf
7. Raku longest alternation docs — https://docs.raku.org/syntax/%7C
8. Rakudo main compiler setup — https://github.com/rakudo/rakudo/blob/master/src/main.nqp

### Chapter 7 — Additional Parser Tools

1. Practical LR Parser Generation — https://arxiv.org/abs/2209.08383
2. Marpa parser site — https://jeffreykegler.github.io/Marpa-web-site/
3. Introducing Ungrammar — https://rust-analyzer.github.io/blog/2020/10/24/introducing-ungrammar.html
4. syn (David Tolnay) — https://github.com/dtolnay/syn
5. swift-syntax — https://github.com/swiftlang/swift-syntax
6. @babel/parser docs — https://babeljs.io/docs/babel-parser
7. @babel/parser source — https://github.com/babel/babel/tree/master/packages/babel-parser
8. rust-analyzer parser crate — https://github.com/rust-lang/rust-analyzer/tree/master/crates/parser
9. Resilient LL Parsing Tutorial (Matklad, 2023) — https://matklad.github.io/2023/05/21/resilient-ll-parsing-tutorial.html
10. LALRPOP book — https://lalrpop.github.io/lalrpop/
11. LALRPOP repository — https://github.com/lalrpop/lalrpop
12. AnyText (SLE 2025) — https://dl.acm.org/doi/10.1145/3732771.3742716
13. Lessons Learned from Developing the MontiCore Language Workbench: Challenges of Modular Language Design — https://dl.acm.org/doi/10.1145/3732771.3742717
14. SDF3 bibliography (Spoofax) — https://www.spoofax.dev/background/bibliography/sdf3/
15. JetBrains MPS FAQ — https://www.jetbrains.com/help/mps/mps-faq.html
16. Beckmann et al. — Partial Parsing for Structured Editors — https://dl.acm.org/doi/10.1145/3567512.3567522

### Chapter 8 — Community Marginalia Worth Mining

1. HN: Tree-sitter parsing system — https://news.ycombinator.com/item?id=26225298
2. HN: Tree-sitter is great / hard to use — https://news.ycombinator.com/item?id=39768020
3. HN: Ungrammar — https://news.ycombinator.com/item?id=24878098
4. HN: AST vs. Bytecode — https://news.ycombinator.com/item?id=37119482
5. HN: langcc — https://news.ycombinator.com/item?id=32949019
6. Tratt — Which Parsing Approach? — https://tratt.net/laurie/blog/2020/which_parsing_approach.html
7. Tree-sitter External Scanners — https://tree-sitter.github.io/tree-sitter/creating-parsers/4-external-scanners.html
8. Tratt — Structured Editing and Incremental Parsing — https://tratt.net/laurie/blog/2024/structured_editing_and_incremental_parsing.html
