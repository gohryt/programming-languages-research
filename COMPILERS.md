# Compilers

Research on compilation techniques, intermediate representations, code generation, and runtime-compilation integration (JITs, regex, query engines, hot code swap).

This document covers lowering, optimization, code generation, runtime object models, and compiler-emitted debug metadata. It treats representations from the compiler-pass perspective — what each form enables or constrains — while the broader representation catalogue lives in `REPRESENTATIONS.md`. Compile-time memory analyses such as region inference and reference counting as a compilation strategy are in scope; broader memory-safety disciplines and runtime memory management live in `MEMORY.md`. Runtime scheduling and concurrency semantics live in `CONCURRENCY.md`; user-facing debugger workflows live in `DEBUGGERS.md`; observability pipelines live in `TRACERS.md`. Parser-side concerns are in `PARSERS.md`, and source-level module/package boundaries are in `MODULES.md` and `PACKAGING.md`.

---

## 1. Compilation Techniques

Strategies for translating source programs into executable form, spanning whole-program AOT, tiered JIT, partial-evaluation-derived compilers, and interpreter-specialization tricks that blur the interpreter/compiler line. The distinguishing axis is *how much work is deferred and to when*. Each entry picks a different point on the compile-time / peak-performance / engineering-cost triangle.

### 1.1. Copy-and-Patch — Stencil-Based Code Generation

Haoran Xu and Fredrik Kjolstad (Stanford, 2021) introduced copy-and-patch compilation: instead of emitting machine code instruction by instruction, the compiler pre-compiles a library of "stencils" — code snippets for each bytecode operation with "holes" for operands. Code generation becomes copying the stencil and patching the holes with concrete values.

Empirically, compilation is 4–6x faster than the fastest existing baseline compilers (like Liftoff in V8), while producing code of comparable quality. The compilation time is dominated by `memcpy` — there is almost no per-instruction decision-making.

The technique has historical roots: QEMU's original "dyngen" backend by Fabrice Bellard used a similar approach in 2003, compiling C stencils and extracting relocations. Copy-and-patch modernizes this by using LLVM as the stencil compiler, enabling better stencil quality and automatic relocation extraction.

Status (as of 2026-04): CPython 3.13 (October 2024) shipped copy-and-patch as an experimental JIT enabled via `--enable-experimental-jit`; CPython 3.14 (October 2025) added free-threading mode (PEP 703) on top, with Mark Shannon and the Faster CPython team independently optimising both the adaptive interpreter and the JIT for the no-GIL build. Status reports through 2025 are mixed — the 3.13 JIT is sometimes slower than the interpreter on individual benchmarks, with 3.16 targeting 5–10% speedup on the free-threaded JIT. The LuaJIT Remake project by Haoran Xu applies the technique to Lua. The technique is particularly well-suited for tier-1 (baseline) compilers in tiered JIT systems, where compilation speed matters more than peak code quality.

Sources: https://arxiv.org/abs/2011.13127 and https://docs.python.org/3/whatsnew/3.14.html and https://fidget-spinner.github.io/posts/faster-jit-plan.html

### 1.2. Tiered Compilation — Interpreter → Baseline → Optimizing

Modern VMs typically have two or three execution tiers:

1. **Interpreter**: zero compilation latency, slow execution. Good for code that runs once.
2. **Baseline compiler**: fast compilation (~1ms), moderate execution speed. Good for warm code.
3. **Optimizing compiler**: slow compilation (~100ms), fast execution. Good for hot loops.

V8 (JavaScript): Ignition (interpreter) → Sparkplug (baseline) → Maglev (mid-tier optimizing) → TurboFan (optimizing). SpiderMonkey (JavaScript): interpreter → baseline → IonMonkey. JVM HotSpot: interpreter → C1 (baseline) → C2 (optimizing).

**The interactive-language sweet spot (Jamie Brandon).** For interactive languages, the combined compile-time + run-time matters more than either alone. A program that compiles in 0.1s and runs in 1s is better than one that compiles in 0s and runs in 2s (interpreter) or compiles in 10s and runs in 0.5s (LLVM -O3). Brandon notes that the OCaml native-code compiler is about half the size of its interpreter, and yet performs one to two orders of magnitude better. This suggests the "naive compiler" sweet spot — fast compilation, reasonable execution, good tooling — is underexplored compared with both interpreters and optimizing compilers. Tiered execution (interpreted glue code + compiled hot paths) may be the practical answer for interactive languages. Debugging across tiers remains a difficult problem; see `DEBUGGERS.md §7.2` on cross-tier source and variable mapping.

Source: https://www.scattered-thoughts.net/writing/implementing-interactive-languages/

### 1.3. Futamura Projections — Compilers from Interpreters

Yoshihiko Futamura's 1971 insight: if you have a partial evaluator (a program that specializes a program given some of its inputs), you can derive compilers mechanically:

- **First projection:** Partially evaluate an interpreter with respect to a specific source program. The result is a compiled version of that program — the interpreter's dispatch overhead has been "baked away," leaving only the operations specific to the source program.
- **Second projection:** Partially evaluate the partial evaluator with respect to the interpreter. The result is a compiler for that language — a program that transforms source programs into compiled programs.
- **Third projection:** Partially evaluate the partial evaluator with respect to itself. The result is a compiler generator — a program that transforms interpreters into compilers.

The Truffle/Graal system (GraalVM) is the most successful practical application: Truffle interpreters written in Java are partially evaluated by Graal's JIT compiler, producing optimized native code. The programmer writes only the interpreter; the compiler is derived automatically.

Supercompilation (Turchin, 1986) generalizes partial evaluation by "driving" through all possible generalized execution histories of the original program, reducing redundancy of any kind — not just known inputs. In practice, supercompilers are harder to control than partial evaluators but can discover optimizations that partial evaluation misses.

The practical lesson: writing an interpreter is much easier than writing a compiler. If you have a sufficiently powerful partial evaluator or JIT, the interpreter *is* the compiler. This is why Truffle languages (Ruby, Python, JavaScript, R on GraalVM) can achieve near-native performance with relatively simple interpreter implementations.

Sources: https://arxiv.org/pdf/2411.10559 and https://mazdaywik.github.io/direct-link/The%20Concept%20of%20a%20Supercompiler.pdf

### 1.4. Sea of Nodes and E-Graphs

The **Sea of Nodes** IR (Cliff Click, mid-1990s) represents a program as a graph where both data flow and control flow are edges. Unlike traditional SSA form, there is no fixed instruction ordering within a basic block — instructions are ordered only by their data dependencies. This gives the optimizer maximum freedom to move instructions.

The Sea of Nodes is used in HotSpot's C2 compiler, V8's TurboFan, and Graal. The main benefit: optimizations like common subexpression elimination, loop-invariant code motion, and instruction scheduling fall out naturally from the graph structure. The main cost: the IR is harder to understand and debug than linear SSA.

**E-graphs** (equality graphs) take this further. An e-graph represents not one program but an equivalence class of programs simultaneously. When an optimization rule fires (e.g., `x * 2 → x << 1`), both the original and the rewritten form are kept in the graph. After all rules have been applied to saturation, an extraction pass selects the best program from the equivalence class.

Cranelift (the Wasmtime compiler) adopted e-graph-based optimization, replacing its previous peephole optimizer. The `egg` library by Max Willsey provides a general-purpose e-graph implementation in Rust. The technique is particularly powerful for phase-ordering problems — the order in which optimizations are applied no longer matters, because all possible rewrites coexist in the e-graph.

Source: https://github.com/bytecodealliance/rfcs/blob/main/accepted/cranelift-egraph.md

### 1.5. Nanopass Compiler Frameworks

Traditional compilers typically use a small number of monolithic passes (e.g., parsing, semantic analysis, lowering, optimization, code generation). The Nanopass approach — most famously used by Chez Scheme — breaks the compilation process into dozens or even hundreds of extremely small, focused passes ("nanopasses").

In a nanopass compiler, each pass performs a single, specific transformation, and the intermediate language (IL) is formally defined at each step. A domain-specific language (DSL) generates the boilerplate for traversing the AST and ensuring that the IL conforms to the required grammar before and after each pass. The perceived downside — excessive compilation time due to so many passes — was proven false by Chez Scheme, which remains one of the fastest Scheme compilers available. The benefit is an incredibly maintainable, easily testable compiler architecture.

Source: Sarkar, Waddell, Dybvig, "A Nanopass Framework for Compiler Education" (ICFP 2004).

### 1.6. Surgical Monomorphization and Lambda Sets

Monomorphization (used heavily in Rust and C++) replaces polymorphic functions with concrete implementations for each specific type, which can lead to severe code bloat. The Roc programming language introduces "Surgical Monomorphization" using a technique called "Lambda Sets."

At compile time, Roc tracks the exact set of functions (lambdas) that can inhabit a function type at any call site. It then performs defunctionalization (the general transformation is explained in §11.3): turning higher-order functions into first-order functions by replacing function pointers with a tag and a switch statement. The "surgical" part means the compiler only specializes the code exactly where it yields a performance benefit or avoids heap allocation (boxing). The result is C-like performance and highly predictable memory usage in a purely functional language, without the pervasive code bloat of traditional monomorphization.

Source: Brandhorst-Satzkorn, "Lambda Sets" (Roc design notes); see also Reynolds defunctionalization (§11.3).

### 1.7. Dynamic Superinstructions & Direct Threaded Code

In bytecode interpreters, dispatch overhead (reading the next opcode and branching to its implementation) is a major bottleneck. Direct threaded code replaces opcodes with arrays of pointers directly to the machine code implementing each operation.

To further reduce dispatch overhead, systems like GForth use "Dynamic Superinstructions." Instead of executing individual primitives (e.g., `dup`, `*`), the VM dynamically identifies common sequences of bytecodes and compiles them into a single "superinstruction" on the fly, copying the machine code routines into a contiguous block. This eliminates the dispatch boundaries between those instructions and allows the CPU to execute them as a single block of native code. The result sits between a pure interpreter and a JIT compiler: ultra-lightweight native code stitching at runtime.

Ertl's EuroForth 2023/2024 papers ("The Performance Effects of Virtual-Machine Instruction Pointer Updates," published as ECOOP 2024) quantify how IP-update dependency chains dominate critical paths on modern out-of-order cores; the paper introduces `l` (loop), `c`/`ci` (combined+immediate), and `b` (branch) instruction-combining optimizations that reduce these chains for up to 2× speedups on dispatch-bound benchmarks.

Sources: http://www.euroforth.org/ef24/papers/ and https://www.complang.tuwien.ac.at/anton/euroforth/

### 1.8. Register-Based vs Stack-Based Bytecode

The two dominant bytecode designs make different trade-offs between code size and dispatch count:

**Stack-based** (JVM, CPython, WebAssembly, CLR): operations pop operands from an implicit stack and push results. Instructions are small (often 1 byte opcode + minimal operands) because operand locations are implicit. The downside: each sub-computation requires separate push/pop instructions, inflating instruction count.

**Register-based** (Lua 5, Dalvik, V8 Ignition, LuaJIT): operations reference named virtual registers. Instructions are wider (typically 3-4 bytes with opcode + operand fields), but the same computation uses far fewer instructions. Ierusalimschy's "The Implementation of Lua 5.0" (2005) reported a 50% reduction in executed instructions when Lua switched from stack to register bytecode, yielding significant interpreter speedups despite larger bytecode.

Shi et al. (VEE 2008, "Virtual Machine Showdown: Stack Versus Registers") measured the trade-off precisely: register-based VMs execute ~47% fewer VM instructions but their code is ~25% larger. On modern CPUs, dispatch cost often dominates, so many dynamic-language VMs have favored register bytecode since Lua 5 and Dalvik. WebAssembly and several managed runtimes remain important counterexamples: stack discipline can enable compact encoding, single-pass validation, and structured control flow that are worth more than dispatch reduction in their target environments.

Sources: https://www.lua.org/doc/jucs05.pdf and https://static.usenix.org/events/vee08/full_papers/shi/shi.pdf

### 1.9. Specializing Interpreters and Bytecode Quickening

Stefan Brunthaler's **bytecode quickening** technique (ECOOP 2010) replaces generic bytecodes with type-specialized variants at runtime. The first execution of `BINARY_ADD` observes its operand types; subsequent executions are rewritten in place to a specialized opcode like `BINARY_ADD_INT` that skips the type-dispatch prologue. This amounts to inline caching but inside the interpreter dispatch loop instead of JIT-compiled code.

**CPython 3.11's specializing adaptive interpreter** (PEP 659, Mark Shannon 2021) brought this technique to mainline Python. The interpreter observes call sites and rewrites `LOAD_ATTR` into forms like `LOAD_ATTR_INSTANCE_VALUE` (fast path for common layouts) or `LOAD_ATTR_SLOT` based on observed object shapes. A counter decays on miss, and families de-optimize back to the generic form if specialization fails. Python 3.11 gained 10–60% runtime improvement primarily from this mechanism — without a JIT.

The insight: you don't need to generate machine code to get inline-caching benefits. Interpreter-level specialization captures the same monomorphic-fast-path wins with a fraction of the engineering complexity. The trade-off is favorable on both axes — large baseline speedup, low architectural cost — which makes it a strong candidate to evaluate before committing to a JIT.

Sources: https://peps.python.org/pep-0659/ and https://publications.cispa.saarland/1069/1/ecoop10.pdf

### 1.10. Production Python JITs — Cinder, Pyston, Pyjion

The mainline CPython JIT (§1.1) is one of several Python-acceleration efforts. Three production-influential alternatives are worth recording.

**Cinder / CinderX** (Meta, since 2020) is the most-deployed alternative Python runtime: a fork of CPython 3.10/3.12 with a method-level JIT, a function inliner ("Instagram inliner"), strict-typing module mode (`Static Python`), shadow bytecode for type-specialization, and immortal-object support (objects whose refcount the runtime never decrements, useful for deeply-shared globals). Cinder's JIT generates type-specialized native code per function; the function inliner aggressively inlines small callees including builtins, recovering performance lost to Python's dynamic dispatch. Production at Instagram (the largest production Python deployment) since 2020. The 2025 strategic shift was to repackage Cinder as **CinderX**, a CPython extension consumable from a vanilla CPython 3.12+ rather than a forked binary, lowering the operational cost of deploying it alongside other Python ecosystem components.

**Pyston / Pyston-lite** (originally Dropbox 2014–2017, revived 2020+) is a JIT-compiling CPython fork with attribute-cache acceleration, JIT-compiled bytecode interpretation, and a runtime model closer to PyPy than to mainline Python. Pyston-lite (2022) repackaged the JIT as a CPython extension (`pip install pyston-lite-autoload`) — same idea CinderX adopted three years later. Status (as of 2026-04): mostly dormant since the parent company refocused; mainline CPython JIT and Cinder eclipsed it.

**Pyjion** (Microsoft, 2016–2021) is the third historical production JIT effort, using the .NET CLR's RyuJIT as the codegen backend for CPython bytecode. It demonstrated that a host JIT can be reused for a guest language but shipped as research and was archived in 2022.

The deployment lesson is that copy-and-patch baselines (§1.1), adaptive interpreters (§1.9), and method-level JITs occupy distinct points in the same design space. Cinder-class JITs buy larger wins, but at much higher engineering cost.

Sources: https://github.com/facebookincubator/cinderx and https://github.com/facebookincubator/cinder and https://engineering.fb.com/2022/05/02/open-source/cinder-jits-instagram/ and https://github.com/pyston/pyston and https://blog.pyston.org/

### 1.11. PHP 8 JIT — DynASM Origin and the IR Framework

PHP 8.0 (2020) added a tracing JIT designed by Dmitry Stogov, originally built on **DynASM** (covered as a macroassembler JIT in §13.4). The first version targeted x86-64 only and emitted machine code per traced bytecode sequence. Status (as of 2026-04): PHP 8.4 (2024) incorporates a second-generation JIT based on a **standalone IR framework** (Stogov's IR, an SSA-based mid-level IR with a small set of optimization passes) that replaces direct DynASM emission with a compiler-style IR + multi-target backend. This is the same architectural shift V8 made from TurboFan to Turboshaft (`REPRESENTATIONS.md §6.5`) and from Cranelift's pre-2022 backend to its e-graph mid-end (§13.2): a typed mid-level IR makes optimizations composable and additional targets (ARM64, RISC-V) tractable.

The PHP IR framework is independent of PHP and is being explored as a substrate by other dynamic-language runtimes. Its design point is between QBE (§13.1, ~14K lines, no IR-level optimizations) and LLVM (millions of lines, every optimization): a mid-sized IR with a curated optimization set, designed for short compilation budgets typical of JITs. The architectural lesson: **for languages whose JIT compile times must stay sub-millisecond, a small SSA-IR framework with a hand-curated pass list is the natural middle point** between DynASM-style direct emission (no analysis budget) and LLVM-style full pipeline (impossible budget).

Sources: https://wiki.php.net/rfc/jit and https://wiki.php.net/rfc/jit-ir and https://php.watch/articles/jit-in-depth and https://www.zend.com/blog/php-8-4

### 1.12. Roblox Luau — `--!native` Type-Annotation-Driven JIT

Roblox's **Luau** (covered for `LOP_BREAK` bytecode patching in `TRACERS.md §1.1`) added **native code generation** in late 2023, available per-script via the `--!native` directive and per-function via `@native`. The codegen is x86-64 and ARM64 (Android included by 2025), produced from Luau bytecode at module load time, with runtime fallback to the interpreter for unsupported constructs.

The distinctive design choice is that **type annotations actively drive specialization**. Luau is gradually typed (annotations are optional); when present, the JIT uses them to elide type checks and emit specialized arithmetic. `local x: number` lets `x + 1` compile to a direct `addsd` rather than going through Luau's tagged-value arithmetic dispatch. Production deployment (Roblox engine, billions of script instances per day) makes Luau one of the largest production gradual-typing-driven JITs.

Distinct from V8's TurboFan (`REPRESENTATIONS.md §6.4`) and SpiderMonkey IonMonkey (`REPRESENTATIONS.md §5.6`): those are speculation-driven (compile assuming observed types, deopt on guard failure); Luau native uses the *programmer-supplied types* directly without speculation, treating `--!native` as a contract that types at module boundaries are correct. The trade-off is that wrong type annotations produce undefined behaviour rather than deopt — but in Roblox's user-script ecosystem, where the typed/native combination is opt-in by the script author, the discipline scales.

The lesson generalises: **for gradually-typed languages with optional annotations, treating annotations as optimization hints rather than only as documentation can substitute for speculative JITs**. The annotation surface becomes part of the optimizer's contract; the cost is annotation-correctness pressure on programmers rather than a deoptimization machinery in the runtime.

Sources: https://create.roblox.com/docs/luau/native-code-gen and https://luau.org/news/2025-12-19-luau-recap-runtime-2025/ and https://devforum.roblox.com/t/optimizing-native-code-performance-with-type-hints-and-magic/4247690

### 1.13. Codon — Whole-Program Python AOT to LLVM

Shajii et al.'s **Codon** (MIT/Exaloop, PLDI 2023) is a Python-syntax compiler that produces standalone native binaries via LLVM, *without* CPython runtime overhead. Where Cinder/Pyston/Pyjion (§1.10) and the CPython JIT (§1.1) work *with* Python's reference-counted dynamic semantics, Codon abandons them: it imposes static type inference on a Python subset, monomorphises generic code at compile time, and emits LLVM IR with no heap-tag dispatch on hot paths. Reported speedups are 10–100× on numeric and string-heavy workloads, with C-competitive performance where Codon's inferred types are tight enough.

The architectural choice is "compile a Python *dialect*, not the language itself": full CPython-extension semantics, dynamic class modification, and ad-hoc reflection are not supported. In exchange, Codon offers domain-extensibility through a **plugin SDK** — the same compiler infrastructure backs Seq (computational genomics) and other domain-specific Codon dialects, each adding domain-typed primitives without forking the toolchain. Distinct from Numba (§1.14), which JIT-compiles selected functions inside an otherwise standard CPython process; Codon replaces CPython entirely.

Status (as of 2026-04): production-stable; Exaloop ships Codon under a source-available license with commercial deployments in computational biology and high-frequency data processing. The lesson generalises: **a typed Python dialect plus whole-program AOT** is a different point in the Python-acceleration design space from any JIT, and pays off when partial Python compatibility is acceptable.

Sources: https://github.com/exaloop/codon and https://news.mit.edu/2023/codon-python-based-compiler-achieve-orders-magnitude-speedups-0314 and https://dl.acm.org/doi/abs/10.1145/3578360.3580275

### 1.14. Numba — Decorator-Driven Python LLVM JIT

Lam, Pitrou, Seibert et al.'s **Numba** (Anaconda, 2012+) takes the opposite position from Codon (§1.13): instead of replacing CPython, it lives *inside* a normal CPython process and compiles selected functions on demand. The `@jit` (or `@njit` — "no-Python" mode) decorator marks a function for JIT compilation; on first call, Numba's frontend infers Python and NumPy types from the call's actual arguments, lowers a typed IR, and emits machine code via **llvmlite** (Numba's LLVM Python binding, ~14 MB vs LLVM's full ~100 MB — a project deliverable in its own right).

The deployment niche is *numerical and array-heavy* code: Numba shines on tight `for` loops over NumPy arrays, ufuncs, and reductions, where type inference reliably collapses to fixed numeric types. The compiled function reuses NumPy's memory layout directly, so no marshalling cost crosses the JIT boundary. **GPU support** via `@cuda.jit` extends the same decorator surface to CUDA kernels; **AOT mode** lets functions be compiled ahead of time and cached across processes. The price of staying inside CPython is real — anything that calls Python C-extension functions whose signatures Numba can't infer falls back to "object mode" with full CPython dispatch overhead, often eliminating the speedup entirely.

The lesson generalises: **a decorator-driven JIT operating on a typed subset of an existing dynamic language is a viable middle ground** between full-language acceleration (CPython JIT, §1.1) and language-replacement compilation (Codon, §1.13). The cost is the typed-subset boundary; the benefit is incremental adoption — users add `@jit` to their hot loops without rewriting the program. PyPy and GraalPy occupy adjacent points (whole-language acceleration); Cython occupies another (typed-extension compilation).

Sources: https://numba.pydata.org/ and https://github.com/numba/llvmlite and https://numba.pydata.org/numba-doc/dev/user/jit.html

---

## 2. Memory Management in Compilers

Compilers allocate enormous numbers of small objects — AST nodes, IR instructions, types, symbols — with highly predictable lifetimes. The entries in this chapter differ on *which regularity they exploit*: per-phase lifetime, structural equality, per-field access patterns, or alignment guarantees. Each is a targeted optimization that pays off because compiler workloads are not general-purpose allocation workloads.

### 2.1. Arena Allocation — Bump Allocators

Arena (bump) allocation is the dominant memory management strategy in compilers. The pattern: allocate a large contiguous region, bump a pointer forward for each allocation, never free individual objects. When the compilation phase ends, free the entire arena at once. This section is about arenas as an implementation technique inside compilers; language-facing allocator API models (explicit allocator parameters, context allocators, temp allocators, allocator toolkits) are covered in `MEMORY.md §7.12`.

Rust's `bumpalo` crate is the canonical implementation: allocation is a pointer bump + alignment check (~2ns). There is no per-object deallocation, no free list, no fragmentation. The trade-off: objects in the arena cannot be individually freed. This is acceptable in compilers because AST nodes, IR instructions, and type objects all have the same lifetime — they live for one compilation phase and die together.

The `bump-scope` crate extends this with allocation scopes/checkpoints: you can "reset" the arena to a previous point, freeing everything allocated after that point. This supports nested phases (e.g., parse a function body, optimize it, emit code, reset the arena for the next function).

Arena allocation also enables pointer-free representations: instead of storing pointers to children, store indices into the arena. Indices are typically 32 bits (vs 64-bit pointers), saving 4 bytes per reference. This is the approach used by ECS (Entity Component System) architectures in game engines, and it maps directly to flat AST representations (see `PARSERS.md §3`).

### 2.2. String Interning and Hash Consing

**String interning**: store each unique string once, refer to it by index or pointer. Two interned strings can be compared for equality in O(1) by comparing their indices. Every major compiler uses this for identifiers — rustc's `Symbol`, V8's `InternedString`, Go's `string` (which are immutable and can be compared by pointer in some cases).

The implementation is a hash map from string content to index. The strings themselves are stored in a contiguous buffer (often arena-allocated). The lookup cost is one hash + one comparison per new string; subsequent uses are free.

**Hash consing** generalizes interning to structured data. Instead of deduplicating strings, it deduplicates entire data structures: if two AST nodes are structurally identical, they share the same allocation. Equality testing becomes pointer comparison — O(1) regardless of structure size.

Hash consing is used in BDD libraries, symbolic computation (JuliaSymbolics reported up to 100x faster numerical evaluation), and persistent data structures. In compilers, it's most useful for type representations — many expressions share the same type, and deduplication can dramatically reduce memory usage.

The key property: hash-consed structures are automatically persistent (immutable). Modifications create new structures that share unmodified subparts. This enables efficient incremental computation, undo/redo, and structural diff.

Source: https://en.wikipedia.org/wiki/Hash_consing

### 2.3. Struct-of-Arrays Layout

Instead of an array of structs (`[{kind, span, left, right}, ...]`), store parallel arrays (`kinds[], spans[], lefts[], rights[]`). This is the data-oriented design approach used by Zig's AST, ECS game engines, and many database column stores.

Benefits: better cache utilization when accessing one field across many nodes (e.g., iterate over all `kind` fields without touching `span` or children); enables SIMD processing of uniform arrays; smaller alignment padding waste.

Costs: more complex access patterns when you need all fields of one node; more arrays to manage; harder to add/remove fields.

The Zig compiler uses struct-of-arrays for its AST (`std.MultiArrayList`) and reports significant performance improvements over pointer-based trees. The Accelerated-Zig-Parser stores token lengths in a separate `u8[]` array (4x smaller than the `u32[]` offset array), exploiting the fact that almost all tokens are short.

### 2.4. Qualifiers in Pointer Bits

Cuik (and Clang before it) stores type qualifiers (`const`, `volatile`, `restrict`, `atomic`) in the bottom bits of type pointers. This requires types to be allocated at 16-byte alignment, ensuring the bottom 4 bits are always zero. A "qualified type" is just a pointer with some bits set — no additional allocation needed.

This trick saves enormous amounts of memory in C/C++ compilers where every expression has a qualified type. Without it, each qualified type would need a separate wrapper allocation. With it, `QualType` is the same size as a raw pointer and can be passed by value.

The general principle: if your allocations have known alignment, the bottom bits of pointers are free storage. This is used beyond compilers — tagged pointers in NaN-boxing (JavaScript engines), small integer optimization (Ruby's Fixnum), and discriminated unions (Rust's `Option<&T>` uses the null pointer niche). See §3 on value representation.

---

## 3. Value Representation

For dynamically-typed languages, every runtime value must carry enough type information to dispatch correctly — and the encoding of that information into a single machine word is one of the most consequential decisions a VM makes. The entries below differ on *where the tag lives and what it costs to extract the payload*: NaN boxing hides tags in unused IEEE 754 double patterns, tagged pointers steal low alignment bits, and ExBoxing hybridizes the two. The trade-offs are between pointer width, immediate float support, and the number of branches on every hot-path access.

### 3.1. NaN Boxing — 64 Bits for Everything

NaN boxing exploits the IEEE 754 double-precision format: any value with all 11 exponent bits set and a non-zero mantissa is a NaN (Not a Number). There are 2⁵² possible NaN bit patterns, but only one is needed for the canonical NaN. The remaining ~2⁵² patterns can encode pointers, integers, booleans, nil, and other tagged values — all in 64 bits.

SpiderMonkey (Firefox), LuaJIT, and JavaScriptCore use NaN boxing. The advantage: every value fits in a 64-bit word, enabling register-width operations and avoiding heap allocation for numbers. A double is stored directly; everything else is stored in the NaN mantissa bits with a type tag.

The disadvantage: extracting a pointer requires masking off tag bits, and storing a double requires checking for (and avoiding) the NaN range. Some operations need extra branches. Also, only 48-bit pointers fit (sufficient on current x86-64 hardware, but not future-proof).

Source: https://firefox-source-docs.mozilla.org/js/index.html

### 3.2. Tagged Pointers — Low-Bit Type Tags

Tagged pointers store type information in the low bits of a pointer, exploiting alignment guarantees. If all heap objects are 8-byte aligned, the low 3 bits are always zero and can store a type tag with 8 possible values.

V8 (Chrome), Ruby (CRuby), and OCaml use tagged pointers. OCaml's convention: the low bit distinguishes integers (bit 0 = 1) from pointers (bit 0 = 0). This means OCaml integers are 63 bits, not 64 — a trade-off for O(1) type checking on every value.

Sources: https://v8.dev/blog/pointer-compression and https://ocaml.org/manual/5.2/runtime.html

### 3.3. ExBoxing — Bridging Tagged Pointers and NaN Boxing

Kannan Vijayan (SpiderMonkey team) proposed ExBoxing: use low-bit tagging (like V8) for the common case, but reserve a special tag for "extended" values that encode floating-point numbers using an exponent-biased scheme. The most commonly used doubles (small integers, common fractions) fit in the extended encoding; rare doubles fall back to heap allocation.

This captures most of NaN boxing's benefit (common numbers as immediates) while retaining tagged pointers' advantages (simpler pointer extraction, no NaN-range checks, natural null representation).

Source: https://medium.com/@kannanvijayan/exboxing-bridging-the-divide-between-tag-boxing-and-nan-boxing-07e39840e0ca

---

## 4. Register Allocation

Mapping unbounded virtual registers to a small fixed set of physical registers is one of the most expensive phases in any optimizing compiler, and also one of the most load-bearing for final code quality. The distinguishing axis in this chapter is the *cost of compile time versus quality of allocation*: graph coloring produces near-optimal assignments but runs in NP-complete territory, linear scan accepts a few percent more spills for a 15–68x compilation speedup, and SSA-based regalloc families split the difference by exploiting the structure SSA already gives them.

### 4.1. Graph Coloring — The Classic Approach

Chaitin (1981) formulated register allocation as graph coloring: build an "interference graph" where nodes are live ranges and edges connect simultaneously-live ranges, then color the graph with K colors (K = number of physical registers). If a node cannot be colored, it is "spilled" to memory.

Graph coloring produces excellent code but is expensive: the interference graph can be quadratic in the number of live ranges, and coloring is NP-complete in general (though heuristics work well in practice). GCC's IRA/LRA lineage uses graph-coloring ideas, while LLVM's production allocators are better described as live-interval, greedy, splitting, and linear-scan-influenced rather than classical Chaitin-style graph coloring.

### 4.2. Linear Scan — Fast Allocation for JITs

Poletto and Sarkar (1999) proposed linear scan: number all instructions, compute live intervals [start, end] for each variable, then scan intervals left-to-right, assigning registers greedily. When all registers are occupied, spill the interval with the farthest endpoint.

Linear scan is O(N log N) — vastly faster than graph coloring. The code quality is slightly worse (1–5% more spills), but the compilation time reduction is dramatic: 15–68x faster than graph coloring in the Extended Linear Scan comparison.

Every tier-1 (baseline) JIT uses linear scan or a variant: V8's Liftoff, SpiderMonkey's baseline compiler, HotSpot's C1. Optimizing tiers use more sophisticated allocators — graph-coloring, backtracking, greedy/live-interval, or SSA-aware splitting allocators depending on the VM — to trade more compile time for better code. The two families serve different points on the compile-time vs code-quality trade-off.

A middle-ground lineage worth naming: **SSA-based register allocation** (see Pereira-Palsberg's puzzle-solving work and the Das-Ayers "Efficient Global Register Allocation" line). These algorithms operate on SSA form directly, exploiting the fact that SSA's lifetime intervals are easier to split cleanly, and avoiding the need to destruct SSA before allocation. Cranelift's regalloc2 (§13.2) and GCC's more recent IRA passes take this approach.

Sources: https://web.cs.ucla.edu/~palsberg/course/cs132/linearscan.pdf and https://arxiv.org/pdf/2011.05608

---

## 5. Compiler-Emitted Source Position Metadata

Parser-side strategies for *storing* positions on AST nodes are in `PARSERS.md §1`. This section covers how compilers *encode and export* source positions alongside compiled output so debuggers, profilers, and stack-trace formatters can map back. The distinguishing axis across entries is *how aggressively the encoding exploits the regularity of compiler output* — that consecutive instructions usually map to consecutive source lines — via delta encoding, run-length encoding, state-machine opcodes, or adaptive-width integers. Entries span JVM `LineNumberTable` and `LocalVariableTable`, CPython PEP 657's per-instruction column ranges, Lua Compact Debug and LuaJIT's adaptive width, DWARF's `.debug_line` state machine, and the VLQ delta encoding used by JS source maps.

### 5.1. Bytecode-to-Source Side Tables — JVM, CPython, Lua

**JVM** `LineNumberTable`: array of `(bytecode_pc: u16, line_number: u16)` pairs per method. 4 bytes per entry. Line-only granularity. Generated by default by `javac` even without explicit `-g`, but omittable with `-g:none` and compiler-dependent for other JVM language compilers. `LocalVariableTable` is separate: 10 bytes per variable entry. The line-only granularity is a deliberate trade-off — it's sufficient for stack traces and debugger stepping, and keeps class files compact.

**CPython PEP 657** (Python 3.11+): added `(start_line, end_line, start_col, end_col)` per instruction. Column offsets stored as `uint8_t` (0-255). Location tables became ~9x larger than in 3.10, overall `.pyc` size increased ~22%. Opt-out via `PYTHONNODEBUGRANGES` or `-Xno_debug_ranges`. The motivation was to show exact error locations in tracebacks (the `^^^` under the offending expression), which is worth the size increase for developer experience.

**Lua**: standard Lua uses 4 bytes per instruction for line info. Lua Compact Debug (NodeMCU) replaces this with run-length encoding of line deltas. LuaJIT uses adaptive encoding: `u8` for ≤255 lines, `u16` for ≤65535, `u32` otherwise. The adaptive approach is elegant — most functions are short, so most line numbers fit in a byte.

Sources: https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html and https://peps.python.org/pep-0657/ and https://www.lua.org/manual/5.4/manual.html#4.7

### 5.2. DWARF `.debug_line` State Machine

DWARF's `.debug_line` section encodes source location information as a state machine program. The state machine has registers for address, line, column, file, etc. Opcodes advance these registers. A "special opcode" (single byte) encodes both a line delta and an address delta, covering the common case of sequential statements in compact form.

The encoding achieves remarkable density: for typical C/C++ programs, the line table is 1–5% of the text section size. For comparison, naively storing `(address, line)` pairs would be ~8 bytes per source line, while DWARF typically uses 1–2 bytes per source line.

The design principle: exploit the regularity of compiler output. Consecutive machine instructions usually correspond to consecutive or nearby source lines. Delta encoding captures this regularity.

> The *location expression* side of DWARF — describing where variables live under optimization — is a debugger correctness concern covered in `DEBUGGERS.md §7.1`.

Source: https://dwarfstd.org/

### 5.3. JS Source Maps — VLQ Delta Encoding

JavaScript source maps (ECMA-426) encode mappings as VLQ (Variable Length Quantity) delta-encoded Base64 strings. Each segment encodes: generated column delta (reset per line), source file index delta, original line delta, original column delta, optional name index delta. Semicolons separate generated lines.

The delta encoding is key: in minified JavaScript, consecutive generated positions map to consecutive original positions (since minification reorders very little). Each delta is typically 0–2 Base64 digits. For a 1MB minified file, the source map is typically 200–500KB — smaller than the original source. ECMA-426 reduced source map sizes by 50% versus v2.

Bidirectional lookup (generated→original and original→generated) is implemented via binary search on sorted segments. This enables both "jump to source" (click on minified code, see original) and "jump to generated" (set breakpoint in source, find generated location).

Source: https://tc39.es/ecma426/

### 5.4. Design Principle — Delta Encoding and Regularity

Most compact encodings here exploit the same observation: consecutive machine instructions usually correspond to consecutive or nearby source positions. JVM and CPython are useful as simple side-table baselines; Lua Compact Debug, LuaJIT, DWARF, and source maps more aggressively exploit regularity through compression. This regularity is captured by:
- **Run-length encoding** (Lua Compact Debug)
- **Adaptive width encoding** (LuaJIT)
- **State-machine special opcodes** (DWARF)
- **VLQ delta encoding** (Source Maps)
- **Bounded-width column offsets** (PEP 657)

Picking one of these families early matters because the dominant cost is *read* performance (stack traces, exceptions): a format cheap to decode sequentially but occasionally random-accessed by binary search is the practical sweet spot.

---

## 6. Intermediate Representations Beyond SSA

SSA is the default IR shape for modern imperative compilers, but compiler engineering still uses a wider family: CPS/ANF for explicit control, MLIR-style dialects for staged lowering, dense linear SSA for compile speed, source-adjacent HIR/MIR cascades for semantic analysis, and target-neutral IRs for multi-backend compilation. The entries below are intentionally compiler-facing: they focus on which passes each representation enables, which metadata must survive lowering, and how the representation affects compile latency and optimization complexity.

> The representation catalogue itself — concrete syntax trees, AST layouts, bytecode families, e-graphs, effect-annotated IRs, content-addressed code, Forth-style direct representations, and target-adjacent IRs — lives in `REPRESENTATIONS.md`. This chapter keeps only the IR-as-optimization-substrate framing.

### 6.1. CPS, ANF, and SSA — The Triad of Compiler IRs

Three IR forms dominate compiler construction, and they are deeply related:

**Static Single Assignment (SSA)**: each variable is assigned exactly once, and φ-functions at join points select values from incoming edges. Used by LLVM, GCC, Go, and almost every modern AOT compiler. SSA makes def-use chains trivial and enables powerful optimizations (constant propagation, dead code elimination, global value numbering) as direct graph operations. The dominant form for imperative language compilers.

**Continuation-Passing Style (CPS)**: every function call passes an explicit continuation — a closure representing "what to do next." Function calls never return; they instead invoke their continuation. CPS was pioneered by Steele (1978) in the Rabbit compiler for Scheme and used extensively in Appel's SML/NJ compiler. CPS makes all control flow explicit, including non-local returns, exceptions, and coroutines. Kelsey (1995) showed a formal correspondence: CPS and SSA are essentially the same — SSA's φ-functions correspond to CPS's continuation parameters, and SSA's basic blocks correspond to CPS's continuation lambdas.

**A-Normal Form (ANF)**: Flanagan et al. (1993) proposed ANF as a simpler alternative to CPS. In ANF, every intermediate result is named (let-bound), and every function argument is a trivial expression (a variable or constant). ANF captures the same sequencing guarantees as CPS without the syntactic overhead of explicit continuations. Most modern functional compilers (GHC's Core, OCaml's Flambda) use ANF or ANF-like forms.

CPS is the most expressive (it can directly represent delimited continuations, algebraic effects, and coroutines), but SSA is the most widely tooled and understood. For languages with advanced control flow (effects, async, generators), CPS or a CPS-like IR may be the natural first choice, with lowering to SSA for backend optimization. ANF is the pragmatic middle ground — simpler than CPS, more structured than SSA.

Sources: https://bernsteinbear.com/assets/img/kelsey-ssa-cps.pdf and https://www.cs.princeton.edu/~appel/papers/cpcps.pdf

### 6.2. MLIR — Multi-Level Intermediate Representation

MLIR's compiler-pipeline value is the multi-level pass model: dialects define their own operations and types, and a compiler stages lowering as a pipeline of pattern-driven rewrites between dialects rather than running every pass against a single fixed IR. The same infrastructure that drives the rewrites can also script user-extensible transformations via the Transform dialect, so optimization order and dialect selection become explicit pipeline configuration. The catalogue of dialects and how they are organized as program representations lives in `REPRESENTATIONS.md §10.1`.

Sources: https://mlir.llvm.org/ and https://arxiv.org/abs/2202.03293

### 6.3. V8 Turboshaft — Cache-Oriented Linear IR

V8's migration from TurboFan (Sea of Nodes) to **Turboshaft** is the compiler-pass datapoint behind §1.4's SoN trade-offs: when compile-time reductions matter, switching from a graph IR to a dense linear IR with flat-buffer storage and 32-bit operand indices pays off. Status (as of 2026-04): the V8 team reported 30–40% compile-time reductions on the affected pipelines with parity or better code quality. The general SoN-vs-linear contrast (slow compile, hard debugging, cache locality) is covered in §1.4 and `REPRESENTATIONS.md §6.5`; what is unique to Turboshaft for compiler-pass design is the data-model commitment (fixed-size slots, indexed operands) that pass authors must respect.

Sources: https://v8.dev/blog/turboshaft and https://docs.google.com/presentation/d/1s1at4981oW06S52uL2HFizgVMYvaV1kB8i6oEiEbFBQ/

### 6.4. Rust's HIR → THIR → MIR Pipeline

rustc's three-stage cascade is the canonical compiler-pass example of "each analysis phase gets the shape it needs": HIR for type checking and lints, THIR for explicit types/coercions/pattern structure, MIR for borrow checking, drop elaboration, const evaluation, and optimization before LLVM lowering. The compiler-pass takeaway is the boundary, not the layer count — once an analysis becomes flow-sensitive or needs explicit destruction/resource semantics, doing it on the AST becomes fragile, and a MIR-like layer gives those passes a stable substrate at the cost of one more translation and one more source-mapping obligation. The full representation catalogue is in `REPRESENTATIONS.md §10.3`.

### 6.5. Cranelift CLIF and Binaryen

The compiler-pass implication is that IR design follows the dominant consumer: dense SSA (CLIF) buys compile speed for the optimizer, while structured trees (Binaryen) buy Wasm-specific rewrite simplicity. Choosing one or the other constrains which passes are cheap and which require extra structure to reconstruct. The representation details — small types, integer indices, structured control flow — live in `REPRESENTATIONS.md §6.2`.

Sources: https://github.com/bytecodealliance/wasmtime/tree/main/cranelift and https://github.com/WebAssembly/binaryen

### 6.6. Mojo KGEN and POP Dialect — Parametric MLIR

Status (as of 2026-04): Mojo's KGEN/POP matters here for one compiler-pipeline reason: unresolved parameterization can survive as IR until a later elaboration stage. That makes compile-time metaprogramming part of lowering rather than a separate AST macro system, and it keeps generic/comptime code distributable and cacheable before instantiation. `REPRESENTATIONS.md §5.4` covers the parametric-IR data model; §12.10 covers the metaprogramming angle.

Sources: https://llvm.org/devmtg/2025-10/slides/technical_talks/lattner_zhu.pdf and https://github.com/modular/modular/blob/main/mojo/stdlib/docs/internal/pop_dialect.md

### 6.7. Ballerina BIR — Single IR, Dual Backends, Cached for Incrementality

The compiler-pass implication is that a shared mid-level artifact with per-target lowering is cleaner than duplicating the pipeline once a language needs multiple serious backends — but only if the IR avoids assumptions from any one backend. BIR also serves as the package-level cache for incremental builds. The structural details and serialization format live in `REPRESENTATIONS.md §5.5`.

Sources: https://medium.com/ballerina-techblog/peering-into-the-ballerina-intermediate-representation-8e97361a070e and http://dl.lib.uom.lk/handle/123/16182

### 6.8. RakuAST — Class-Based AST as Compiler-Extensibility Substrate

The compiler-facing lesson is that a user-visible AST can sit above an older lowering target instead of replacing it: Rakudo parses to RakuAST objects, then lowers through `IMPL-TO-QAST` into the existing pipeline. This is a metaprogramming and extension-point decision rather than an optimizer-IR decision; the cost is object dispatch, allocation, and GC pressure during compilation. Full representation details live in `REPRESENTATIONS.md §3.8`.

Sources: https://docs.raku.org/type/RakuAST and https://news.perlfoundation.org/post/grant-rakuast-2020-12 and https://github.com/lizmat/articles/blob/main/review-of-2025.md

---

## 7. SSA Construction and Destruction

Converting a source program (or AST/HIR) into SSA form, and later removing SSA before register allocation, are two of the most common operations in any SSA-based compiler. Entries differ along *when* SSA is constructed relative to CFG availability and *how* it is dismantled: Cytron's classical dominance-frontier algorithm requires a complete CFG plus dominator tree up front, Braun's on-the-fly construction builds SSA incrementally as bytecode is parsed using incomplete φ-functions, and Sreedhar / Boissinot's out-of-SSA techniques formalize the parallel-copy-resolution problem at block boundaries (including the cycle-breaking swap case) and show that coalescing before destruction beats coalescing after.

### 7.1. Cytron et al. — Dominance-Frontier SSA Construction

The classical algorithm (Cytron, Ferrante, Rosen, Wegman, Zadeck — TOPLAS 1991) constructs SSA by computing **dominance frontiers** and placing φ-functions at every block in the iterated dominance frontier of each variable's definition sites. Variables are then renamed via a DFS over the dominator tree, maintaining per-variable version stacks.

The algorithm is correct and complete, produces "minimal" SSA (the smallest set of φ-functions sufficient to meet the single-assignment invariant), and runs in near-linear time in practice. GCC, LLVM, and most classical AOT compilers use variants of it. The drawback: it requires a complete CFG plus dominator tree before construction can start. For JITs that build the IR incrementally from a linear source like bytecode, this is awkward.

Source: https://dl.acm.org/doi/10.1145/115372.115320

### 7.2. Braun — Simple and Efficient SSA Construction

Matthias Braun et al. (CC 2013, "Simple and Efficient Construction of Static Single Assignment Form") presented an algorithm that builds SSA on the fly, directly from a linear instruction stream, without computing dominance information upfront. The core idea is to maintain a per-block, per-variable *current definition* map and use **incomplete φ-functions** for variables that are read in a block before all its predecessors have been sealed. When a block is later sealed (all predecessors known), incomplete φ-functions are filled in and possibly optimized away.

The algorithm produces minimal SSA for reducible CFGs and near-minimal SSA for irreducible ones. It is dramatically simpler than Cytron's algorithm — a few hundred lines in practice — and crucially it plays well with JITs that build IR as they parse bytecode. **Cranelift**, **Firm/libFirm**, and several recent backends use Braun's algorithm directly.

The lesson: for a JIT, choose Braun. For a batch compiler with a stable CFG, Cytron is fine and the tooling literature is richer.

Source: https://pp.ipd.kit.edu/uploads/publikationen/braun13cc.pdf

### 7.3. Out-of-SSA — Parallel Copy Resolution

SSA must be removed before register allocation (in most backends) because physical registers can't be assigned in single-assignment form. The naive "replace each φ(x₁, x₂) with copies on the incoming edges" approach is subtly wrong — parallel copies at block boundaries can conflict (the swap problem: `x = y; y = x`).

Sreedhar et al. (POPL 1999, "Translating Out of Static Single Assignment Form") formalized out-of-SSA as a parallel copy insertion problem on the CFG edges, followed by **parallel copy sequentialization** using the Boissinot et al. (2009) algorithm or equivalent. The sequentialization handles cycles via a temporary register when no register is free.

More recent work (Boissinot, Darte, Rastello, Guillon, 2009) showed that doing **SSA-based coalescing before destruction** produces better code than coalescing after — live ranges can be merged across φ-functions while the structural information is still explicit. Cranelift's regalloc2 (§13.2) integrates this insight by operating directly on SSA.

Sources: https://compilers.cs.uni-saarland.de/papers/bbhlmz13cc.pdf and https://hal.inria.fr/inria-00349925v1/document

---

## 8. Optimization Passes

A catalog of the optimizations that actually move the needle, separated from the IR and backend design choices above. SSA (§6, §7) is the substrate; these are the transformations. Entries are organized by *what regularity they exploit*: redundant computations across the CFG (GVN, PRE, Lazy Code Motion), constant values propagated through conditional branches (SCCP), loop structure (LICM, auto-vectorization, polyhedral tiling under Polly, modulo-scheduled pipelining), aggregate decomposition (SROA, mem2reg), tail position (tail call elimination), straight-line isomorphic operations (SLP vectorization), and — at the edge of the field — solver-driven search over the instruction space itself (STOKE, Souper, Denali).

### 8.1. Global Value Numbering (GVN)

GVN assigns the same "value number" to expressions that provably compute the same result, then replaces redundant computations with references to the earlier value. Unlike local common subexpression elimination (CSE), GVN operates across the whole function, handling values that flow through φ-functions.

**Hash-based GVN** (the common implementation) canonicalizes each SSA instruction into a tuple (opcode, operands, type), looks up the tuple in a hash table, and reuses any prior matching value. **RPO-based GVN** (Reverse Post-Order) extends this to handle loops by iterating to a fixed point. LLVM's `GVN` pass additionally integrates memory dependence analysis to handle load-store redundancy.

GVN is typically the single most impactful scalar optimization — 5–15% speedup on integer benchmarks is routine. It also enables downstream passes by surfacing equivalences that weren't syntactically obvious.

Source: https://llvm.org/docs/Passes.html#gvn-global-value-numbering

### 8.2. Sparse Conditional Constant Propagation (SCCP)

Wegman and Zadeck (TOPLAS 1991) combined constant propagation with dead-branch elimination in a single lattice-based analysis. The key insight: traditional constant propagation analyzes all branches, even those provably unreachable; by propagating lattice values *through* conditional branches and marking one side unreachable when the condition is a known constant, SCCP discovers constants that conventional analysis misses.

The analysis operates on a three-point lattice (⊥ "undef" → constant → ⊤ "overdefined") with a work list. When a constant condition selects a branch, the unselected branch is pruned from consideration, potentially making more instructions dead. LLVM's `-sccp` pass is a direct implementation and runs early in the optimization pipeline because it feeds so many downstream passes.

Source: https://dl.acm.org/doi/10.1145/103135.103136

### 8.3. Loop-Invariant Code Motion (LICM)

LICM hoists computations out of loops when their operands don't change across iterations. The classical formulation (Aho-Sethi-Ullman) uses dominator-based analysis: an expression is loop-invariant if all its operands are either defined outside the loop or are themselves loop-invariant. Hoisting is safe when the loop is guaranteed to execute at least once (or the expression has no side effects).

The payoff on numerical code is substantial — pulling address computations, pure function calls, and constant sub-expressions out of inner loops is often the single biggest scalar win. LLVM's `LICM` pass additionally hoists loads/stores that can be proven safe and handles PHI reduction.

The subtle correctness concern: hoisting speculatively-executed operations can introduce faults on paths where the loop body wouldn't have run. Most compilers gate speculative hoisting on `mustexec` analysis or explicit "can this op trap?" queries.

Source: https://llvm.org/doxygen/LICM_8cpp_source.html

### 8.4. Scalar Replacement of Aggregates (SROA)

SROA breaks structs and small arrays apart into individual scalar values, so the optimizer can reason about each field independently. After SROA, a local struct `{int x, int y}` that's only accessed field-by-field becomes two independent SSA values — eligible for register allocation, GVN, and constant folding as individual scalars.

The effect is transformative: languages that allocate small structs frequently (Rust tuples, Go value types, C++ `std::pair`) depend on SROA to produce code competitive with hand-written scalar C. Without SROA, every field access would remain a load/store through memory. LLVM's `SROA` pass is one of the first passes run on any optimized module.

The related **mem2reg** pass converts `alloca`-based local variables into SSA registers; SROA extends this to aggregate types. Together they form the transition from "naive lowering that allocates everything on the stack" to "optimized SSA with values in registers."

Source: https://llvm.org/docs/Passes.html#sroa-scalar-replacement-of-aggregates

### 8.5. Partial Redundancy Elimination (PRE)

Morel and Renvoise (1979) introduced PRE as a generalization of both CSE and LICM: eliminate expressions that are redundant on *some* control-flow paths but not all. The classical algorithm places computations at points that make them fully redundant at the use site, balancing speedup against code-size increase from additional computations on previously-unaffected paths.

**Lazy Code Motion** (Knoop, Rüthing, Steffen 1992) improved on this by minimizing register pressure — placing computations as late as possible while preserving the partial-redundancy elimination. Modern compilers (GCC, LLVM) use variants of Lazy PRE.

PRE is the compiler-theoretic framework underlying LICM and CSE: both are special cases of PRE where the set of paths is restricted to loops or straight-line code respectively.

Source: https://dl.acm.org/doi/10.1145/359060.359069

### 8.6. Tail Call Elimination

Tail call elimination (TCE) rewrites a call in tail position — where the caller does nothing after the callee returns — into a jump, reusing the current stack frame. This is mandatory for languages that rely on recursion for iteration (Scheme's "proper tail calls"; OCaml, Erlang, Haskell in practice).

The mechanical transformation: after argument evaluation, overwrite the caller's arguments in place, deallocate locals, and `jmp` to the callee instead of `call`. The result is constant-stack-space tail recursion. LLVM exposes this via the `musttail` attribute (strict correctness) and the `tail` hint (opportunistic). WebAssembly added tail calls in 2023 as the `return_call`/`return_call_indirect` instructions.

The implementation hazard: tail calls interact awkwardly with ABIs that expect callee-cleanup or with stack-walking debuggers. Most C ABIs technically permit TCE but many legacy tooling assumptions (stack traces, unwinding) break if it happens. Languages that need reliable TCE either define it at the IR level (LLVM `musttail`, WebAssembly tail calls) or compile to trampolines when the target ABI is hostile.

Sources: https://llvm.org/docs/LangRef.html#call-instruction and https://github.com/WebAssembly/tail-call

### 8.7. Auto-Vectorization and SLP

Modern CPUs have wide SIMD registers (128–512 bits); using them for scalar code requires either explicit intrinsics or an auto-vectorizer. Two main algorithms:

- **Loop vectorization** (LLVM `LoopVectorize`, GCC tree-vectorize): analyzes loops for data parallelism, transforms `for i: a[i] = b[i] + c[i]` into chunked operations on vector registers. Requires stride analysis, alias checking, and handling of loop tails that don't fit a full vector width.
- **Superword-Level Parallelism (SLP)**: Larsen & Amarasinghe (PLDI 2000). Instead of vectorizing loops, SLP finds *straight-line* code with isomorphic operations on independent data and packs them into vector operations. Example: `a = x1+y1; b = x2+y2; c = x3+y3; d = x4+y4` becomes a single 4-wide vector add. SLP is crucial for code that has already been loop-unrolled or that operates on small fixed-size structures.

Both passes are notoriously difficult to tune: too aggressive and they produce slower code than scalar (due to shuffle costs); too conservative and they miss obvious opportunities. Recent work on **VPlan** (LLVM) replaces the legacy vectorizer with a planned rewrite built around vectorization plans as first-class IR.

Sources: https://llvm.org/docs/Vectorizers.html and https://groups.csail.mit.edu/commit/papers/00/pldi00.pdf

### 8.8. Polly — Polyhedral Optimization in LLVM

While §15.1 covers polyhedral compilation in the AI context, **Polly** (Grosser, Zheng, Aloor et al.) brings polyhedral analysis into mainline LLVM as an optional optimization layer. It detects regions of code that fit the polyhedral model (affine loop bounds, affine array accesses), represents them as Integer Set Library (ISL) polyhedra, applies tiling / interchange / fusion transformations, and lowers back to LLVM IR.

Polly is not enabled by default because polyhedral analysis can be slow and the classical polyhedral model doesn't handle non-affine loops. But for scientific code that fits the model, speedups of 2–10x over stock LLVM -O3 are routine. The practical lesson: polyhedral optimization is a specialized tool that pays off massively on a narrow class of code, and modern compilers increasingly treat it as an optional pass rather than a mainstream transformation.

Source: https://polly.llvm.org/

### 8.9. Superoptimization — STOKE, Souper, Denali

Superoptimization rethinks the optimizer as a search problem: given a short instruction sequence, find an equivalent sequence that's shorter or faster, without a fixed set of rewrite rules.

- **Denali** (Joshi, Nelson, Randall, 2002) used an E-graph and SAT solver to search for instruction-level optima on Alpha assembly.
- **STOKE** (Schkufza, Churchill, Aiken, ASPLOS 2013) uses MCMC-style stochastic search over the instruction space, with a cost function combining correctness (via test equivalence) and performance (via measured throughput). STOKE found sequences for `popcount` and related primitives that beat hand-written Intel reference code.
- **Souper** (Regehr, Sasnauskas, et al.) targets LLVM IR: it extracts "interesting" IR fragments from programs, asks an SMT solver whether a shorter equivalent exists, and produces proven-correct peephole rules that can be fed back into LLVM's `InstCombine`. Many real LLVM optimizations have come directly from Souper output.

The practical upshot is limited: superoptimization is slow (minutes to hours per sequence) and only applies to short code fragments. But as a *source of optimizer rules*, it is transformative — rules proven by a solver are strictly better than rules hand-designed against test cases.

Sources: https://raw.githubusercontent.com/eschkufz/stoke-release/master/docs/stoke.pdf and https://github.com/google/souper

---

## 9. Instruction Selection and Scheduling

Lowering SSA IR into concrete target instructions is two distinct problems: choosing *which* machine instructions implement each IR operation (selection), and choosing *when* those instructions execute (scheduling). Register allocation (§4) sits between them. Entries on the selection side differ on *scope of the match* — tree-local DP tiling (BURG/BURS), block-local DAG matching (LLVM SelectionDAG), or whole-CFG matching on generic MIR (GlobalISel) — while entries on the scheduling side differ on *how far the schedule is allowed to move instructions*: within a single block (list scheduling), across basic blocks along a profile-selected trace with compensation code (Fisher's trace scheduling, superblock/hyperblock), or across loop iterations for overlapped execution (Rau's modulo scheduling).

### 9.1. BURG/BURS — Tree Tiling Instruction Selection

Fraser, Hanson, and Proebsting's **BURG** / **BURS** (Bottom-Up Rewrite Grammar / Bottom-Up Rewrite System, 1992) formulates instruction selection as tree-pattern matching on the IR: write instruction patterns as grammar rules with cost annotations, and a dynamic-programming matcher finds the minimum-cost tiling that covers the expression tree.

A rule looks like `Reg ← ADD(Reg, Reg) "add %0, %1, %2" cost 1`. Multiple rules can match the same IR node, and the matcher chooses the combination that minimizes total cost. The generated selector is a finite-state tree automaton that runs in linear time in the IR size.

BURG-style selection was dominant from the late 1980s through the mid-2000s. Its limitation is that it operates tree-locally — it can't easily exploit instructions that span multiple IR nodes (like a fused multiply-add across a DAG). Modern compilers mostly moved to DAG- and CFG-level selection, but tree tiling remains the clearest pedagogical model and is still used in small backends and generators like `iburg`.

**Production case study — MoarVM expression JIT.** Raku's MoarVM uses a BURS-derived tiler as its primary instruction selector. Textual tile definitions specify a pattern, the function implementing the tile, the resulting symbol (used to match further tiles), and a cost. A per-architecture tile-table generator written in Perl precomputes the optimal-tile lookup table from the tile definitions, so that at JIT time selecting the best tile for an IR node reduces to a table lookup. The generated tiler feeds into a linear-scan register allocator (§4.2) and DynASM-based code emission (§13.4). The expression IR itself is a linear array with integer indices rather than pointers, for the same cache-locality reasons as Turboshaft (§6.3) and Cranelift CLIF (§6.5).

Sources: https://dl.acm.org/doi/10.1145/143103.143139 and https://github.com/MoarVM/MoarVM/blob/master/docs/jit/overview.org

### 9.2. LLVM SelectionDAG and GlobalISel

LLVM's instruction selection has two generations:

- **SelectionDAG** (the legacy path): builds a DAG per basic block, applies target-independent legalization, then matches target patterns via tablegen-generated selectors. The DAG representation enables matching across multi-node idioms (e.g., recognizing `(x & -x)` as a single BMI instruction). Drawback: per-block DAGs lose inter-block information, and the DAG→MI (Machine Instruction) conversion is expensive.
- **GlobalISel** (the replacement): operates on LLVM IR directly via the GMIR (Generic MIR) representation, going through Legalize → Select → RegBankSelect as explicit passes. GlobalISel was designed to compile faster than SelectionDAG while retaining target-specific pattern-matching expressiveness, and it avoids the per-block DAG split. Adoption is gradual — AArch64 uses it by default at `-O0`, other targets are migrating.

The split maps to a broader trend: compiler backends want global CFG-level selection (GlobalISel) rather than block-local DAG-level selection (SelectionDAG), because modern ISA features (predication, tail calls, link-time patchability) often span blocks.

Sources: https://llvm.org/docs/GlobalISel/ and https://llvm.org/docs/CodeGenerator.html

### 9.3. List Scheduling

After instruction selection, the backend must order instructions for optimal pipeline use. **List scheduling** (Gibbons & Muchnick, Adams & Gibbons 1976 era) is the workhorse algorithm: build a dependency DAG, topologically order, and at each cycle pick the "best" ready instruction using a heuristic (critical path length, register pressure, resource availability).

List scheduling is a greedy heuristic — provably not optimal, but runs in near-linear time and produces good schedules in practice. Every production backend (LLVM `MachineScheduler`, GCC `haifa-sched`) uses a variant with target-specific heuristics tuned per-microarchitecture (Skylake vs Zen vs Graviton).

The structural trade-off: pre-RA scheduling maximizes ILP but can raise register pressure, causing spills; post-RA scheduling respects physical registers but has less freedom. Most backends do *both* — a pre-RA pass for ILP, then a post-RA pass to clean up after allocation.

Source: https://dl.acm.org/doi/10.1145/502874.502884

### 9.4. Trace Scheduling

Fisher's **trace scheduling** (IEEE TC 1981) extends scheduling across basic block boundaries by selecting a likely-executed "trace" through the CFG, scheduling it as if it were a single straight-line block, then inserting compensation code at the side exits and entries to preserve correctness.

This was the foundation of the Multiflow TRACE VLIW compiler and the intellectual ancestor of modern trace-based JITs (§14.1). The idea survives conceptually in superblock/hyperblock scheduling, if-conversion, trace formation, and profile-guided block layout, though modern LLVM backends do not generally expose a direct classical trace-scheduling pass.

The payoff is highest on architectures with wide issue width (VLIW, superscalar with deep pipelines) where intra-block parallelism runs out. The cost is compensation code — each side exit may need fix-up instructions to account for operations scheduled past branches. Profile data helps pick the right traces.

Source: https://ieeexplore.ieee.org/document/1675828

### 9.5. Software Pipelining / Modulo Scheduling

Software pipelining transforms an inner loop so that iterations overlap — iteration *i+1* starts executing while iteration *i* is still finishing — exposing more ILP across iteration boundaries. **Modulo scheduling** (Rau, HP Labs 1994) is the classical algorithm: find the minimum initiation interval (II) such that the loop body can be scheduled periodically with period II, then generate prologue/kernel/epilogue.

Modulo scheduling pays off most on architectures with high register count and wide issue (IA-64, modern GPUs, some DSPs). LLVM's `MachinePipeliner` implements it for targets that opt in. On general-purpose CPUs with out-of-order execution, much of the benefit is captured by the hardware scheduler, so explicit software pipelining is often redundant — which is why it's an optional, target-specific pass rather than a universal one.

Source: https://www.hpl.hp.com/techreports/94/HPL-94-115.pdf

---

## 10. Pattern Matching Compilation

Compiling pattern-matching constructs (`match`/`case`/`switch` over algebraic data types) into efficient branching code is a distinct subfield within codegen. Entries differ on *how the pattern matrix is lowered to control flow and how aggressively redundant tests are shared*: Maranget's decision trees with column-selection heuristics are the dominant modern approach (OCaml, Rust, Swift, GHC all descend from this); Augustsson/Wadler backtracking automata trade re-testing scrutinees for simpler codegen; and production compilers layer on matrix factoring, constructor jump tables, and guard sequencing to shrink the tree. Parallel to codegen, the same pattern matrix drives exhaustiveness and reachability checks — with GADT-aware refinement (Graf-Simon-Peyton Jones) pushing into constraint solving when type indices restrict the inhabitant set.

### 10.1. Maranget — Decision Trees

Luc Maranget's "Compiling Pattern Matching to Good Decision Trees" (ML Workshop 2008) is the standard reference. The input is a pattern matrix (rows = clauses, columns = pattern positions); the output is a decision tree where each internal node tests one scrutinee component and each leaf is an action.

The key design decision is **column selection heuristics** — which component to test next. Maranget evaluates several (first-column, needed-column, branching-factor, arity) and shows that combined heuristics produce trees that are typically within 10% of optimal while remaining linear-time to build. Most ML-family languages (OCaml, Haskell GHC, Rust, Swift) use direct descendants of this algorithm.

The alternative, **backtracking automata** (Augustsson 1985, Wadler 1987), compiles matches into sequential case analysis with fall-through on failure. Automata are simpler to generate but can re-test the same scrutinee components repeatedly; decision trees avoid this by construction. Modern compilers almost universally use decision trees.

Source: http://moscova.inria.fr/~maranget/papers/ml05e-maranget.pdf

### 10.2. Exhaustiveness and Reachability Checking

Beyond codegen, pattern-match compilation carries two static checks:

- **Exhaustiveness**: does the match handle every possible value? Missing cases should warn (or error) at compile time. Computed by checking whether the *negated* pattern matrix is empty.
- **Reachability**: is every clause reachable, or is some clause dominated by earlier clauses? A dominated clause is dead code.

Maranget's "Warnings for pattern matching" (JFP 2007) formalizes both checks as algorithms on the pattern matrix. Rust, OCaml, and Haskell all implement these — missing-case warnings and "unreachable pattern" lints trace directly to this work.

The implementation detail: for GADTs or types with type-level indexing, exhaustiveness requires constraint solving (what inhabitants does the type actually have given the scrutinee's refined type?). GHC's checker (`Pattern Match Coverage Checking`, Graf-Simon-Peyton Jones 2020) handles this via a symbolic interpreter over the pattern and type constraints.

Sources: https://journals.cambridge.org/action/displayAbstract?aid=1411304 and https://simon.peytonjones.org/assets/pdfs/gadtpm-acm.pdf

### 10.3. Matrix and Nested-Pattern Optimizations

Beyond the basic decision-tree algorithm, production compilers apply further optimizations:

- **Pattern matrix factoring**: common prefixes across clauses are shared, reducing tree size.
- **Constructor switches**: when many patterns test distinct constructors of the same datatype, the tree is compiled to a jump table keyed on the constructor tag (O(1) dispatch instead of O(log n) binary testing).
- **Guard sequencing**: `match x with | Pat1 when guard1 -> ... | Pat2 -> ...` must fall through to Pat2 when Pat1 matches but the guard fails. Naive implementation duplicates the Pat2 tests; careful compilation shares them.
- **String pattern matching** uses specialized dispatch (Aho-Corasick for multiple fixed strings, or perfect hash tables for small closed sets).

The cumulative effect: a hand-written series of `if` tests on a sum type is often *worse* than what a good pattern-match compiler produces, because the compiler applies all these optimizations uniformly.

---

## 11. Closure Compilation

Representing first-class functions — and especially functions that capture their lexical environment — is a cross-cutting concern that shapes both the IR and the calling convention. Entries differ on *where the captured environment lives and how access cost scales*: Appel's flat closures bundle all captures into a single record for O(1) field access at the cost of per-closure allocation, linked/shared closures chain environment frames to amortize allocation across nested definitions at the cost of chain-walking lookups, Johnsson's lambda lifting avoids closures entirely by threading captures through as extra arguments, and Reynolds's defunctionalization replaces the whole higher-order apparatus with a sum type plus a global `apply` dispatcher — a whole-program transform that forfeits separate compilation but eliminates runtime closure machinery.

### 11.1. Closure Conversion — Flat Closures

**Closure conversion** (Appel & Jim 1989; extensively in Appel's "Compiling with Continuations" 1992) transforms nested, free-variable-referencing functions into flat top-level functions that receive their environment as an explicit argument. The closure becomes a pair `(code_pointer, environment)`; calling it means loading both and invoking `code_pointer(environment, args...)`.

Two main environment representations:

- **Flat closures**: environment is a record containing all captured variables. Allocation cost scales with capture count, but variable access is O(1) regardless of nesting depth. Used by OCaml, Haskell (with some adjustments for sharing), and most production functional language compilers.
- **Linked (shared) closures**: environment is a linked list of enclosing frames. Allocation is cheaper when multiple nested functions share environment, but variable access walks the chain. Used in early Scheme implementations and retained in some interactive systems.

The practical tradeoff is measured by how often closures are called versus allocated. Hot loops favor flat closures (fast access); deeply-nested definitions with rare calls favor linked (cheap allocation).

Source: https://www.cs.princeton.edu/~appel/papers/cpcps.pdf

### 11.2. Lambda Lifting

**Lambda lifting** (Johnsson 1985) is the inverse of closure conversion in a sense: rather than packaging free variables into an environment, extra parameters are added to the function signature so that nothing is free. The function is then lifted to top level.

Example: `let f x = y + x` inside a binding for `y` becomes `let f_lifted y x = y + x`, with all call sites rewritten to pass `y` explicitly. When the captured variables are few and cheap to pass, lambda lifting can be cheaper than closure conversion — no environment allocation at all.

Modern compilers mix closure conversion, lambda lifting/floating, and specialization: fully-applied functions with small capture sets may be lifted or specialized; higher-order functions that flow into data structures become proper closures. In GHC, full laziness, lambda lifting/floating, `SpecConstr`, and worker/wrapper are distinct but interacting transformations: `SpecConstr` specializes constructor-heavy call patterns and worker/wrapper improves strictness/unboxing/representation, rather than being simple examples of lambda lifting.

Source: https://www.microsoft.com/en-us/research/publication/lambda-lifting-transforming-programs-to-recursive-equations/

### 11.3. Defunctionalization

Reynolds's **defunctionalization** (1972, "Definitional Interpreters for Higher-Order Programming Languages") replaces higher-order functions with first-order datatypes: every lambda in the program becomes a constructor of a sum type, and function application becomes a `match` over the sum.

For a program with finitely many syntactic lambdas (which is any closed program), defunctionalization is a whole-program transformation that eliminates closures entirely, producing first-order code that's trivially amenable to C-style compilation. The sum type of "all possible function values" plus the global dispatch `apply` function replace the dynamic closure machinery.

This is the theoretical backbone of Roc's lambda sets (§1.6) and appears in MLton, some Idris backends, and specialized GPU compilers where closures can't be allocated at runtime. The cost is losing separate compilation — defunctionalization is fundamentally whole-program, so library-level code must either be generic over a closure type or pre-committed to the full set of callers.

Sources: https://dl.acm.org/doi/10.1145/800194.805852 and https://www.cs.ru.nl/~jhh/publications/danvy-nielsen-cc.pdf

---

## 12. Macros and Compile-Time Metaprogramming

Compile-time code execution and program generation sit between parsing and lowering; they're the mechanism by which a language lets users extend its own compiler. Entries differ on *what the metaprogram operates over and when it runs*: raw token trees (Rust `macro_rules!` and proc macros), typed AST nodes (Scala 3 inline/quoted, Nim typed macros, Template Haskell), fully-evaluated compile-time values that double as generics (Zig `comptime`, D CTFE, Mojo `@parameter`), multi-stage quoted code (MetaOCaml, Terra), arbitrary code execution at compile time (Jai `#run`, Nim), and the dictionary-defining tradition (Forth `CREATE`/`DOES>`). The axis cuts across hygiene guarantees, termination guarantees, and whether the meta-language is the same as the object language.

### 12.1. Zig comptime

Zig's **`comptime`** is the most distinctive modern take on compile-time evaluation. Any expression prefixed with `comptime` is evaluated during compilation; any function parameter marked `comptime` must be known at compile time and the function is specialized for each distinct value.

What makes it original is the uniformity. Generics are `comptime` parameters to functions that return types. Conditional compilation is `comptime if` branching. Reflection over types and values happens through ordinary compile-time execution. Zig deliberately does **not** have a macro system in the AST-rewriting sense: `comptime` functions compute values, types, and specialized declarations, but they do not receive and return arbitrary syntax trees. There are no template parameters, no macro language, no preprocessor — just the same Zig language running at compile time with restrictions on which operations are allowed.

```zig
fn List(comptime T: type) type {
    return struct {
        items: []T,
        // ...
    };
}
```

Here `List` is a regular function that runs at compile time, takes a type, and returns a type. Calling `List(u32)` produces a new struct type — it's the same machinery as generic specialization in C++ or Rust, but expressed without special syntax.

The cost is compile-time performance: `comptime` evaluation runs the same machinery as the main compiler, and unboundedly large comptime programs can exhaust resources. Zig addresses this pragmatically with evaluation quotas rather than formal termination guarantees.

Source: https://ziglang.org/documentation/master/#comptime

### 12.2. Rust Declarative and Procedural Macros

Rust has two macro systems:

- **Declarative macros** (`macro_rules!`): pattern-based rewriting on token trees. Patterns match syntactic fragments (`$x:expr`, `$t:ty`, `$i:ident`) and templates substitute them into output tokens. Hygienic via token-level binding tracking — names introduced in the macro don't collide with names at the call site.
- **Procedural macros**: arbitrary Rust code that manipulates token streams. Three flavors: function-like (`foo!(...)`), derive (`#[derive(Foo)]`), and attribute (`#[foo] fn bar() {}`). The proc macro is compiled as a separate crate and loaded by the compiler during macro expansion; the target crate's tokens become a `TokenStream` argument.

The architectural choice worth noting: proc macros are compiled as separate host crates and loaded by the compiler during expansion; they are not sandboxed by default. Tooling may execute them through a separate proc-macro server, and **Watt** (David Tolnay) compiles proc macros to WebAssembly for deterministic, sandboxed execution — trading a bit more latency for reproducibility and isolation.

Sources: https://doc.rust-lang.org/reference/macros.html and https://github.com/dtolnay/watt

### 12.3. Terra — Lua as Staged Systems Metalanguage

**Terra** (DeVito, Hegarty, Aiken, Hanrahan, Vitek, PLDI 2013) is a low-level (C-like) language embedded in Lua as its meta-language. Lua runs at compile time; Terra code is what Lua emits. Because Lua is a full dynamic language, the meta-programming surface is effectively unlimited — loops, conditionals, first-class functions, and libraries all operate on Terra AST fragments at compile time.

The novelty is separating the two languages cleanly: Lua never runs at Terra's runtime, Terra never runs at Lua's metatime. This avoids the usual staged-programming problem of accidentally running code at the wrong stage. The result is a systems language where generic code, domain-specific optimizations, and custom code generators can be built up in Lua and emitted as Terra functions.

Terra demonstrated particularly well on domain compilers — the original paper showed a high-performance DSL for image processing built from a few hundred lines of Lua driving Terra codegen, outperforming hand-written C.

Sources: https://terralang.org/ and https://cs.stanford.edu/~zdevito/pldi071-devito.pdf

### 12.4. MetaOCaml — Multi-Stage Programming

**MetaOCaml** (Taha & Sheard 2000; Kiselyov's current implementation) adds three constructs to OCaml: `.< e >.` quotes code, `.~ e` splices a quoted fragment into a larger quote, and `.! e` runs a quoted code value. These enable **multi-stage programming (MSP)**: writing programs that generate and then execute programs, with full type safety across stages.

```ocaml
let rec power n x =
  if n = 0 then .<1>.
  else .< .~x * .~(power (n-1) x) >.
;;
(* power 3 generates: .< x * x * x * 1 >. *)
```

The type system tracks stages: `int code` is a quoted int-producing expression, distinct from `int`. Running a quoted value (`.! e`) is explicit. This makes MSP safer than text-template generation (Terra, C++ templates) at the cost of being restricted to the ML-family type discipline.

MSP is the theoretical framework behind JIT specialization in Truffle and the correctness underpinning of Lean's tactic elaboration. Most practical languages don't expose MSP directly, but their internal compilation pipelines embody its principles.

Source: https://okmij.org/ftp/ML/MetaOCaml.html

### 12.5. Template Haskell

Template Haskell (Sheard & Peyton Jones, Haskell Workshop 2002) adds staged metaprogramming to GHC via quotations and splices similar to MetaOCaml, but with access to full Haskell at compile time plus GHC's internal API (inspect types, access names, introspect declarations).

The critical practical feature is **reification**: at compile time, a TH program can inspect existing declarations (type constructors, class instances) and generate code based on them. This is what enables `deriveJSON`-style code generation in the `aeson` library — the macro inspects the target type and emits a handwritten-quality JSON serializer.

TH's reputation is mixed: it's powerful enough to solve real problems, slow enough to hurt compile times, and coupled tightly enough to GHC that portability between compiler versions is painful. But it established the pattern of "compile-time reflection + code generation" that most modern languages now offer in some form.

Source: https://www.microsoft.com/en-us/research/publication/template-meta-programming-for-haskell/

### 12.6. Scala 3 Inline and Macros

Scala 3 redesigned metaprogramming around two primitives:

- **`inline def`**: functions whose bodies are inlined at the call site during typechecking. Arguments can be marked `inline` to force compile-time evaluation. Unlike C++ `inline`, Scala's is semantic — certain operations only work on inline values (e.g., `constValue`).
- **Quoted macros**: expression-level quotations (`'{ e }`) and splices (`${ e }`) inspired by MetaOCaml. A macro is a quoted-code-producing function run at compile time. Typed throughout — `Expr[Int]` is distinct from `Int`.

The design goal was to replace Scala 2's ad-hoc whitebox and blackbox macros (deprecated for portability reasons) with a disciplined two-tier system. Inline covers the simple cases cleanly; quoted macros handle the complex ones with strong correctness guarantees. Early reports from libraries ported between the two suggest the new system is more predictable but somewhat more verbose.

Source: https://docs.scala-lang.org/scala3/reference/metaprogramming/index.html

### 12.7. D CTFE and C++ constexpr / consteval

Two languages converged on full compile-time function evaluation from different starting points:

**D's CTFE** (Compile-Time Function Evaluation) executes arbitrary pure D functions at compile time when their arguments are known. Template arguments, `static if` conditions, and `enum` initializers can all invoke CTFE transparently. The implementation runs a simplified interpreter over D's frontend AST. The rule is pragmatic: "if it's pure and the arguments are known, it runs at compile time."

**C++ `constexpr` / `consteval`** followed a more conservative trajectory: C++11 introduced `constexpr` for simple expressions, and each standard expanded what's allowed (C++14 added statements, C++17 added more library support, C++20 added `consteval` for mandatory compile-time and limited dynamic allocation during constant evaluation, and C++23 expanded library and language support further). C++26 continues that trajectory, but "nearly all of pure C++" remains an implementation- and proposal-status-sensitive claim rather than a settled portability guarantee.

The interesting difference: D bet on a dynamic interpreter early and scaled up; C++ layered formal rules incrementally and caught up. The end state is similar — both let you run much of the language at compile time — but the path dependencies show. Mainstream C++ `constexpr` evaluation is usually implemented by an interpreter/evaluator inside the compiler rather than by JIT- or AOT-compiling the compile-time program; its advantage is tighter integration with the type system and optimizer, while D's CTFE is often more permissive but can be slower on large compile-time workloads.

Sources: https://dlang.org/articles/ctarguments.html and https://en.cppreference.com/w/cpp/language/constexpr

### 12.8. Nim Macros and Templates

Nim's macro system is notable for exposing the compiler's AST to user code while still being integrated with semantic analysis. Macros can operate on untyped syntax trees, typed syntax trees, or both depending on how their parameters are declared. This gives Nim a spectrum: templates perform hygienic-ish syntactic substitution before full semantic checking, untyped macros can introduce new syntax-shaped code early, and typed macros can inspect resolved symbols and type information.

The advantage: macro authors can choose the phase they need. A typed macro can produce diagnostics with type information intact, while an untyped macro or template can generate declarations and bindings that become visible to later semantic analysis. This is more flexible than Rust proc macros over token streams, but less isolated from compiler internals.

The cost is phase complexity. Because Nim exposes several expansion modes, users must understand when names are resolved, when generated declarations become visible, and which AST shape a macro receives. The design is powerful, but it is not simply "macros over an already-type-checked AST"; it is a multi-phase metaprogramming system spanning templates, untyped macros, and typed macros.

Source: https://nim-lang.org/docs/macros.html

### 12.9. Forth CREATE / DOES> — Runtime-Extensible Defining Words

Forth's `CREATE` / `DOES>` pair predates most of the macro systems above and achieves a large fraction of their expressiveness with one primitive. `CREATE name` reserves dictionary space and installs default execution semantics (push the allocated address on the data stack). `DOES>` overrides those semantics: everything after `DOES>` in a *defining word* becomes the runtime behavior for every word the defining word later creates.

```forth
: CONSTANT  CREATE ,  DOES>  @ ;
42 CONSTANT ANSWER   \ defines ANSWER so that it pushes 42
```

`CONSTANT` is a defining word: calling it `CREATE`s a new word (`ANSWER`), comma-compiles `42` into its dictionary space, and — via `DOES>` — arranges that invoking `ANSWER` fetches from that space. Arrays, structures, object-dispatch tables, and entire object systems have been built on nothing but `CREATE` / `DOES>`.

The insight: `CREATE/DOES>` fuses a compile-time action (shaping the new word's dictionary entry) and a deferred runtime action (the `DOES>`-installed behavior) using the language's existing execution model — no separate macro language, no hygiene system, no AST transformation. Modern languages achieve similar expressiveness through comptime (§12.1) or macros (§§12.2–12.8), but usually at the cost of a dedicated metaprogramming phase. Forth makes its runtime its metaprogram.

The trade-off is scope: `CREATE/DOES>` targets defining-word patterns specifically, not arbitrary compile-time computation. But defining-word patterns turn out to cover a surprisingly large fraction of the use cases that push other languages toward full macro systems, and the mechanism costs almost nothing to implement.

Sources: https://softwareengineering.stackexchange.com/questions/339283/forth-how-do-create-and-does-work-exactly and https://news.ycombinator.com/item?id=44231594

### 12.10. Mojo's Three-Stage Pipeline and `@parameter`

Status (as of 2026-04): Mojo's metaprogramming formalizes what Zig `comptime` (§12.1) leaves implicit: a distinct, named compile-time stage with well-defined inputs and outputs. The compiler pipeline is:

1. **Parser** — produces IR (over the POP dialect, §6.6) and performs type checking. Simple `comptime` expressions like `2 + 3` get constant-folded here.
2. **Interpreter** — runs compile-time code. Any remaining `comptime` expression that cannot be constant-folded is executed by an interpreter over Mojo's frontend, operating on compile-time values and producing compile-time values.
3. **Elaborator** — substitutes concrete parameter values into parametric declarations and produces concrete specialized functions and structs. Parametric IR becomes concrete IR here (§6.6 covers the POP side of this).

The syntactic design exposes the stages cleanly:

- **Parameters in `[]`, arguments in `()`.** A function `fn repeat[count: Int](msg: String)` takes `count` at compile time and `msg` at runtime. Calling `repeat[3]("hi")` specializes the function for `count=3` during elaboration.
- **`comptime` keyword** for values and control flow that must run at compile time: `comptime let N = compute_size()`, `comptime if CONDITION: ...`, `comptime for i in range(N): ...`.
- **`@parameter` decorator** for functions / loops / conditionals that should execute at compile time. `@parameter for` unrolls the loop at compile time; `@parameter if` compiles only the taken branch.

The payoff: metaprogramming reads like regular Mojo because it *is* regular Mojo — just evaluated earlier in the pipeline. The distinctive contribution is that the compile-time stage is an *MLIR pass pipeline* with a named elaborator step rather than a pre-pass or syntactic expander, so compile-time code benefits from the same optimization infrastructure as runtime code. Compared to Zig `comptime` (§12.1), Template Haskell (§12.5), Scala 3 inline+quoted (§12.6), and Rust proc macros (§12.2), Mojo's distinctive axis is the parametric-IR layer between interpretation and elaboration.

Sources: https://docs.modular.com/stable/mojo/manual/metaprogramming/comptime-evaluation/ and https://docs.modular.com/stable/mojo/manual/parameters/

### 12.11. Jai — `#run`, Baking, and Compiler-as-Library

Status (as of 2026-04): Jonathan Blow's **Jai** is in closed beta since 2014, targeting release alongside *Order of the Sinking Star*. The guiding design is that the compiler is a library that the programmer drives, not a black box that consumes source files.

The core features:

- **`#run` any function at compile time.** Result is either baked into the binary as a constant or used to drive compilation. Canonical demos: generating an sRGB lookup table at compile time; running an entire Space Invaders game at compile time and embedding the final state. The compile-time runtime is a bytecode interpreter built into the compiler.
- **`#insert` for generalized AST insertion.** Produces structured code from a compile-time computation and splices it into surrounding context — enables data-layout transformations (e.g., struct-of-arrays from a struct-of-scalars schema) as library code.
- **Compiler message loop.** A proc marked `#compiler` receives messages from the compiler during compilation ("type-checking started," "declaration parsed," "bytecode generated"); the meta-program can inspect, modify, or reject them. This makes the compiler a plugin host accessible as ordinary Jai. The build system itself is a Jai meta-program (`build.jai`) — no separate configuration language.
- **Dual backends.** Custom x64 backend for fast-path dev builds (no optimization, near-instant compile); LLVM for release. The custom backend exists specifically because even LLVM -O0 adds noticeable compile latency on large codebases. Compile-speed target: 1M LOC/second; public demos show 80k LOC compiling in under a second.

The design trade-off is principled: if compile-time code is ordinary language code that can mutate the AST and control the compiler, there's no "metaprogramming language" to learn. The cost is a compiler that must be designed as a library from day one — hard to retrofit.

Sources: https://github.com/BSVino/JaiPrimer/wiki/Metaprogramming and https://en.wikipedia.org/wiki/JAI_(programming_language)

### 12.12. C++26 Reflection — P2996 Static Reflection

C++26 introduces **static reflection** as a first-class language feature via P2996 (Sutter, Childers, Faisal, Snyder et al.; voted into the C++26 working draft 2024–2025; current revision P2996R13, June 2025). Two new operators define the surface: `^^expr` (the *lift* operator) reflects an entity into a compile-time `std::meta::info` value, and `[: meta-expr :]` (the *splice* operator) substitutes a reflected value back into source position as an identifier, type, or expression. The reflection model is a curated subset of what Daveed Vandevoorde's earlier **P1240** specified, dropping the most contentious features (raw token splicing, generative function emission) for a conservative MVP that committee members judged shippable.

The mechanical primitives:

- **`std::meta::info`** — the type of every compile-time reflection value. A consteval-only opaque handle; cannot be runtime-stored.
- **Member iteration** — `members_of(^^MyType)` returns a `std::vector<info>` of every non-special member, allowing template-free iteration over fields, methods, base classes, and enumerators.
- **Splice substitution** — `[:r:]` produces a name, type, or expression depending on what `r` reflects; `template_arguments_of`, `type_of`, `name_of`, `is_class`, `is_enum` complete the meta-query API.
- **`define_aggregate`** — generates an aggregate type at consteval time; the principal generative-code-emission primitive (more constrained than P1240's earlier proposal).

The most consequential application is **eliminating `<type_traits>` and SFINAE-heavy generic code**: every metafunction in the standard's traits library can be re-expressed as a few-line consteval function over reflection. Production targets include replacing **Qt's `moc`** (the Meta-Object Compiler that has shipped as an external preprocessor since the 1990s precisely because C++ lacked reflection), Boost.PFR's structural reflection over POD types, automatic JSON/protobuf serialisation, and ORM column mappings.

Status (as of 2026-04): voted into C++26 working draft; GCC and Clang shipping experimental support behind `-freflection`-style flags, with significant fixes through GCC 15 / Clang 19+. MSVC has not yet announced an implementation date. Distinct from D's CTFE + `__traits` (§12.7) and Zig's `comptime` (§12.1): C++26 reflection is more constrained (consteval-only, no token splicing, no raw code generation in the MVP) but designed to compose cleanly with C++'s template + concept system. Distinct from Rust proc macros (§12.2): reflection runs *during* template instantiation rather than as a separate pre-compilation phase, so generated code participates in normal type checking and overload resolution rather than producing tokens that the parser re-ingests.

The lesson generalises beyond C++: **a reflection MVP can be valuable even when generative code emission is left out** — the ability to *query* type structure compositionally eliminates the most painful 80% of template-metaprogramming use cases without committing to the full Lisp-macro design space. For language designers, P2996 is the cleanest production data point on "reflection without macros" — a useful intermediate between Rust's procedural macros and Zig's full compile-time evaluation.

Sources: https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2023/p2996r0.html and https://isocpp.org/files/papers/P2996R13.html and https://wiki.qt.io/C%2B%2B_reflection_(P2996)_and_moc

---

## 13. Lightweight Compiler Backends

LLVM delivers near-peak code quality at the cost of compile time measured in seconds per translation unit and a dependency footprint measured in millions of lines. This chapter collects backends and compiler architectures that make the opposite trade: accept 50–70% of LLVM's peak performance in exchange for one or two orders of magnitude faster compilation and far smaller codebases — and at the other extreme, the whole-program optimisers that accept slow compilation in exchange for C-competitive runtime performance. Entries differ on *how they buy that compile-time / runtime trade-off* — QBE by aggressive simplification of the optimizer, Cranelift by a DSL-driven selector plus e-graph mid-end, TPDE by a single-pass adapter framework over existing IR, macroassembler JITs by pushing register allocation onto the human, Virgil by doing whole-program reachability before any codegen, **SBCL** by aggressive type-directed open coding inside a REPL-driven block compiler, **Stalin** by closed-world flow-sensitive type inference over Scheme, and **MLton** by whole-program defunctionalization plus monomorphisation plus contification over Standard ML.

### 13.1. QBE — 70% of LLVM in 10% of the Code

QBE is a compiler backend by Quentin Carbonneaux that targets the sweet spot between TCC (no optimization) and LLVM (full industrial optimizer). Written in ~14,000 lines of C99 with zero dependencies, QBE provides:
- Uniform SSA-based IL used at all compilation stages
- Copy elimination, sparse conditional constant propagation, dead instruction elimination
- Registerization of small stack slots
- Linear register allocator with hinting (split spiller + allocator, enabled by SSA)
- Full C ABI support on amd64, arm64, and riscv64

Benchmarks show QBE-compiled code runs roughly 50–70% the speed of LLVM -O2. Compilation is near-instant (~2 seconds for the compiler itself with `-O2`). The `cproc` C11 compiler (8,000 lines of C) uses QBE as its backend and can build GCC 4.7, binutils, git, and much more.

The lesson for new languages: you don't need LLVM to get reasonable codegen. QBE provides a self-contained, hackable, and understandable backend that any language can target. For bootstrapping compilers or interpreter-to-native tiers — where small dependency footprint and hackability matter more than peak code quality — QBE is one of the strongest options to evaluate.

Source: https://c9x.me/compile/

### 13.2. Cranelift & ISLE — Fast Compilation with DSL-Driven Instruction Selection

Cranelift is an optimizing compiler backend developed by the Bytecode Alliance (originally by Mozilla for Wasmtime). Unlike LLVM, Cranelift prioritizes compilation speed while maintaining reasonable code quality — making it ideal for JIT and baseline compilation tiers.

Key innovations:
- **ISLE DSL** (Instruction Selection Lowering Expressions): instruction selection rules are written in a statically-typed term-rewriting DSL, compiled to Rust match trees. This replaces hand-written C++ lowering code with declarative rules that are easier to verify, fuzz, and maintain. The ISLE compiler merges all rules into a decision tree, sharing work where possible.
- **regalloc2**: a novel register allocator by Chris Fallin that combines aspects of linear scan with SSA-aware splitting. Status (as of 2026-04): provides ~20% faster compilation than its predecessor while improving code quality 10–20% on register pressure-heavy benchmarks. The key insight: operate on SSA form directly, split live ranges at block boundaries, and use parallel move resolution.
- **E-graph mid-end**: Cranelift's mid-end is e-graph-based — see §1.4.

Cranelift is used as the backend for Wasmtime (WebAssembly), `rustc_codegen_cranelift` (alternative Rust backend for debug builds — 2–4x faster compilation than LLVM), and several other projects. It targets x86-64, aarch64, s390x, and riscv64.

Sources: https://cranelift.dev/ and https://cfallin.org/blog/2022/06/09/cranelift-regalloc2/

### 13.3. TPDE — Adaptable Single-Pass Backend Framework

TPDE (Schwarz, Kamm & Engelke, 2025) is a compiler back-end framework that adapts to existing SSA-form code representations. Instead of requiring IR translation (a significant cost when targeting LLVM), TPDE performs compilation in a single pass — combining instruction selection, register allocation, and instruction encoding — using only an IR-specific adapter.

Target instructions are derived from code written in high-level language through LLVM's Machine IR, easing portability while enabling optimizations during code generation. The authors built a new back-end for LLVM IR from scratch targeting x86-64 and AArch64, showing compilation speeds an order of magnitude faster than LLVM -O0 while producing code with comparable quality.

TPDE represents a new point in the design space: the framework approach means you can bolt fast native codegen onto any existing SSA-based IR without inventing a new backend from scratch. For a language with its own IR, this could provide near-instant native compilation without LLVM dependency.

Source: https://arxiv.org/abs/2505.22610

### 13.4. Macroassembler JITs — DynASM

For generating machine code on the fly without the weight of a full compiler backend like LLVM or even Cranelift, macroassemblers provide a highly efficient solution. DynASM, created by Mike Pall for LuaJIT, is a prominent example.

DynASM is a C preprocessor and a tiny runtime. The developer writes assembly instructions directly interspersed with C code. A preprocessor converts these assembly lines into C macros that emit the raw machine code bytes at runtime. It avoids the overhead of intermediate representations, instruction selection passes, or register allocation algorithms, delegating those tasks to the human programmer writing the assembly. This results in JIT compilers that are extraordinarily small, fast, and capable of generating highly optimized, architecture-specific machine code with near-zero compilation latency.

Source: https://luajit.org/dynasm.html

### 13.5. MoarVM "lego" JIT — Template-Based Direct Emit

MoarVM (Raku's VM) has two JITs that coexist. The older of the pair, the **lego JIT**, is a template-based direct-emit compiler: each MoarVM instruction has a hand-written template that maps directly to x86-64 machine code via DynASM. Compilation is a single linear pass over the bytecode, emitting machine code from the per-instruction templates with no IR in between.

The design sits between copy-and-patch (§1.1) and DynASM macroassembly (§13.4): like copy-and-patch, it treats each source opcode as a unit of machine code to stitch together; like DynASM, the "templates" are hand-written assembly rather than compiler-extracted stencils. It predates copy-and-patch in the literature.

The lego JIT survives alongside MoarVM's newer expression JIT because many MoarVM instructions either (a) have such simple one-to-one machine-code mappings that an expression tree adds no value, or (b) haven't yet been ported to the expression JIT's tile-template DSL. In production, MoarVM runs a mix — expression-JITted code for instructions that benefit from cross-instruction optimization, lego-JITted code for everything else.

The broader design pattern — two JITs with different complexity/throughput trade-offs, dispatched per opcode — can be a reasonable transitional compromise when a VM's instruction set is large and heterogeneous. The cost is maintaining two codegen paths; the benefit is that simple instructions don't pay the overhead of the more sophisticated backend. MoarVM's later retrospective makes the caution explicit: this pattern is healthy only if there is a clear migration or deprecation plan for the older path.

Bart Wiegmans's June 2023 retrospective is the postmortem: the unordered IR of the expression JIT prevents cross-basic-block optimization, and "failing to deprecate the lego JIT" is named as a mistake. Status (as of 2026-04): no significant JIT codegen work has shipped since the retrospective, and **MoarVM on AArch64 (Apple Silicon, ARM64 Linux/macOS) runs the interpreter only** — there is no native JIT backend. Spesh (§14.4) optimizations are still active and Homebrew/distro packages support ARM64, but native code generation is x86-64-only.

Sources: https://github.com/MoarVM/MoarVM/blob/master/docs/jit/overview.org and http://brrt-to-the-future.blogspot.com/2023/06/retrospective-of-moarvm-jit.html

### 13.6. Virgil — Self-Hosted Lightweight Whole-Program Compiler

Ben Titzer's **Virgil** (compiled by **Aeneas**, the Virgil compiler binary, 2006–present) is a compiler-engineering existence proof: production-grade whole-program optimization with compile times and binary sizes one to two orders of magnitude better than mainstream alternatives. Status (as of 2026-04): public measurements (linked from `github.com/titzer/virgil/issues/80`) report Virgil compiling benchmarks ~50× faster than rustc and ~300× faster than TinyGo, with executable output ~35× smaller than Rust and ~20× smaller than TinyGo; numbers are upstream-published, not independently re-benchmarked here.

The techniques that get Virgil there:

- **Reachability-first compilation.** The compiler parses and type-checks all code but only lowers reachable code from `main()`. Unreachable generic code never gets specialized, imported-but-unused modules never get codegened. Most languages do dead-code elimination post-optimization; Virgil does it pre-optimization, saving the optimizer's time on code that will be discarded.
- **Specialization driven by reachability.** Polymorphic instantiation only happens for combinations that are actually reached — not the Cartesian product of all type arguments × all call sites. This collapses the generic explosion that hurts compile times in Rust and C++.
- **Local SSA optimizations, no fixed-point iteration.** Most of Virgil's optimizer is lightweight local peephole-style rewrites on SSA. Unlike LLVM, which iterates many passes to saturation, Virgil does mostly single-pass transformations. Less aggressive, much faster.
- **Fully self-hosted, no runtime in another language.** Compiler, runtime, GC, libraries, system interface are all in Virgil. On native targets, there is no C startup code — Virgil's own `_start` calls directly into the kernel.
- **Multi-target from one compiler.** Same source compiles to x86-darwin, x86-64-linux, JAR (JVM), or Wasm. The compiler is contained in a single executable; no separate linker, assembler, or runtime package.

The lesson for a new language: "LLVM-level optimization" is not always the right target. For systems where compile latency is a first-class concern (game engines, dev workflows, small embedded targets), a simpler compiler with reachability analysis can deliver both faster builds and smaller binaries than a fully-optimizing toolchain. The trade-off is that generated code is slower than LLVM -O3 output — but often only by a small margin on the workloads Virgil targets. **Stalin (§13.8)** takes the opposite trade-off in the same whole-program-compilation design space — much heavier inference, much slower compilation, much smaller code.

Virgil also publishes research on novel representations (Teo & Titzer, "Unboxing Virgil ADTs for Fun and Profit," JENSFEST 2024) demonstrating that whole-program knowledge enables ADT representation choices that would be unsafe under separate compilation.

Sources: https://github.com/titzer/virgil/ and https://github.com/titzer/virgil/issues/80

### 13.7. SBCL — Aggressive Optimization in a REPL-Driven Compiler

**Steel Bank Common Lisp** (SBCL, derived from CMUCL since 2000; lead maintainers Christophe Rhodes, William Newman, Nikodemus Siivola, Stas Boukarev) is one of the longest-lived production aggressive optimisers in any language family — a Common Lisp implementation with whole-function-level type inference, automatic specialisation based on inferred types, and direct native code generation without an intermediate IR family in the LLVM/Cranelift sense. The compiler is itself written in Common Lisp and is the descendant of CMUCL's *Python* compiler (no relation to the language Python).

Distinguishing features:

- **Block compiler architecture**: SBCL compiles top-level forms incrementally as they are read, accumulating a type environment across the program. A `(defun foo ...)` form compiles immediately to native code with the types known at that point; later definitions extend the environment and may trigger recompilation hints. This makes SBCL a hybrid of **REPL-style interactivity and aggressive AOT optimisation** — every interactive session is silently type-inferring across thousands of definitions.
- **Type-directed open coding**: when the inferred type of a Lisp value is sufficiently constrained (a known integer range, a fixed-shape array, a specific class), SBCL replaces generic dispatch with direct machine instructions. `(+ x y)` where both operands are inferred fixnum becomes a single `addq` on x86-64; `(aref vec i)` where `vec` is a typed `(simple-array (unsigned-byte 8))` becomes a direct array load with type-elided bounds checking.
- **No separate JIT tier**: SBCL is fully AOT — all code is compiled before execution — but the compilation is incremental and integrated into the REPL. The lesson is that "compile aggressively at function definition time" can substitute for tiered JIT (§14) for languages with sufficient type-inference discipline at the function boundary.
- **Fully self-hosted**: the SBCL compiler is written in Common Lisp; bootstrapping reproducibility is checked via cross-comparison across host implementations (SBCL, CCL, ECL, CLISP). The bootstrap chain is closer to Forth metacompilation (§33.10) than to mrustc-style alternative-compiler bootstrap (§28.2).

Status (as of 2026-04): production deployment includes ITA Software's QPX search engine (acquired by Google for Google Flights), Genworks GDL (CAD), Mirai (animation), several quantitative trading firms, and various scientific-computing pipelines. Performance is competitive with C on numeric kernels with proper type declarations. The CMUCL→SBCL→CCL lineage is one of the most mature production-FP-compiler stories outside the ML family, and a useful counterweight to the JIT-everywhere assumption common in modern dynamic-language compiler design.

Sources: https://www.sbcl.org/ and https://sbcl.sourceforge.net/manual/ and https://sbcl.org/manual/index.html

### 13.8. Stalin Scheme — Whole-Program Aggressive Compilation

Jeffrey Mark Siskind's **Stalin** (Scheme to native via C, 1991+) takes whole-program optimisation to a research extreme: **type inference, control-flow analysis, escape analysis, and constant propagation are all run over the entire program** — including all libraries — before code generation. The compiler can elide allocation entirely for objects proven not to escape, specialise generic operations to monomorphic call sites, unbox numbers throughout, and emit C code competitive with hand-written C on numeric benchmarks (Siskind reports 0.6–4× of `gcc -O2` C performance on the SPEC suite, achieved purely through aggressive whole-program inference rather than runtime specialisation).

The architectural cost is uncompromising:

- **No separate compilation**: Stalin requires the whole program to be available at compile time. There is no library boundary; the compiler must see every definition.
- **No dynamic loading or eval**: extending Scheme's reflective semantics is impossible because the type-inference algorithm relies on closed-world reasoning.
- **Super-linear compilation time**: type inference scales poorly with program size. Stalin times out on some programs and falls back to less aggressive specialisation; large benchmarks can take minutes to hours to compile.
- **Undecidable in general**: the underlying type-inference algorithm (a flow-sensitive form of Henglein's quartic-time inference adapted to Scheme) is undecidable in the worst case.

The relevance to a new language is the **upper bound on what whole-program compilation can achieve** for a dynamically-typed source language. Stalin shows that Scheme's lack of language-level type information can be substantially recovered by whole-program inference, but only at compilation costs unacceptable for interactive development. **Virgil** (§13.6) takes a similar whole-program-reachability-first approach with weaker optimisation and faster compilation; **Stalin** shows the opposite trade-off in the same design space; **SBCL** (§13.7) is the production middle ground that gives up some specialisation power in exchange for incremental compilation.

Status (as of 2026-04): research-grade. Stalin is no longer actively developed but the techniques continue to influence whole-program optimisers (the optimisation analyses Siskind catalogued are now standard in some MLton, Roc, and Virgil passes). The lesson is that interactive-development requirements are usually what foreclose Stalin-class aggressive optimisation, not algorithmic limits.

Sources: https://engineering.purdue.edu/~qobi/papers/aplas2003.pdf and https://github.com/barak/stalin and https://www.iro.umontreal.ca/~feeley/papers/SiskindEC97.pdf

### 13.9. MLton — Whole-Program Optimising SML Compiler

**MLton** (Cejtin, Jagannathan, Weeks et al., 1998+) is the canonical whole-program optimising compiler for Standard ML and the most mature production-grade whole-program functional-language compiler in continuous use. It sits between Stalin (§13.8) and Virgil (§13.6) in the whole-program lineage: more aggressive than Virgil's reachability-first compilation (heavy monomorphisation, full defunctionalization), but less radical than Stalin's flow-sensitive type inference (MLton starts from already-typed SML, so it skips the type-inference cost Stalin pays).

The architectural pillars:

- **Whole-program defunctionalization**: every function value is replaced with a tagged sum of all syntactically-occurring lambdas in the program, plus a global `apply` dispatcher. This is Reynolds defunctionalization (§11.3) applied at scale; it eliminates closures entirely in favour of first-order code that C-style optimisers can handle. Roc's lambda sets (§1.6) are the modern descendant of this design.
- **Aggressive monomorphisation**: every polymorphic SML function is specialised at every used type instantiation. Combined with defunctionalization, this means the post-compilation SSA has no polymorphism, no closures, and no higher-order functions left.
- **Contification**: turning function calls into local jumps where the call has only one return point. This is a key MLton-specific optimisation — Cejtin, Jagannathan, Weeks's 1998 contification analysis identifies functions that can be "lowered" into the calling control-flow graph as basic blocks, eliminating entire call/return overhead and unlocking subsequent CFG-level optimisations.
- **SSA-based optimiser pipeline** with ~20 distinct passes: contification, inlining, loop-invariant code motion, common subexpression elimination, useless-variable elimination, redundant-tuple elimination, and **ref-flattening** (turning `ref` cells into mutable struct fields when the alias graph permits). Each pass is small and follows the nanopass discipline (§1.5) more loosely than Chez Scheme but with similar per-pass-language separation.
- **Native code generation** via either an in-tree backend (x86, AMD64, ARM64) or LLVM. Performance is competitive with hand-written C on numeric kernels; SML's type discipline plus whole-program monomorphisation gives the optimiser more information than typical C compilers receive.

The cost is the same shape Stalin's is: **no separate compilation** (the whole program must be available), **slow compilation** for large programs (whole-program analyses scale poorly — 100 KLOC SML programs commonly take minutes to compile), and **incompatibility with `eval` / dynamic loading**. MLton's `.mlb` (ML Basis) files are the project structure; large MLton programs partition into compilation units only at the build-system level, not at the language level.

Production: the **HOL4** theorem prover compiles to MLton for production performance; **Mythryl** (a syntactic variant of SML) ships on MLton; **MaPLe** parallel SML extension (PLDI 2021) is an MLton fork; **Roc's compiler** (§1.6) inherits MLton's defunctionalisation and contification techniques. Status (as of 2026-04): MLton is actively maintained but moves slowly; the codebase is roughly 200 KLOC of SML and stands as the longest-running production-grade whole-program functional-language compiler.

The lesson generalises: **monomorphisation + defunctionalization + whole-program SSA optimisation gives ML-family languages C-competitive performance** at the price of separate-compilation flexibility. Any language designer choosing whether to support full ML-style polymorphism should evaluate which side of the MLton trade-off the language wants to live on.

Sources: http://mlton.org/ and https://www.cs.purdue.edu/homes/suresh/papers/popl00-camera-ready.pdf and https://github.com/MLton/mlton and https://www.cs.purdue.edu/homes/suresh/papers/contification.pdf

### 13.10. ActiveJ Codegen — Productive ASM Wrapper for Runtime JVM Bytecode Generation

ActiveJ Codegen (SoftIndex Lab) is a productivity layer over **ObjectWeb ASM** for runtime bytecode generation on the JVM. ASM is the canonical low-level bytecode-manipulation library, but its visitor-based API (`MethodVisitor.visitInsn`, `MethodVisitor.visitVarInsn`, manual stack-frame accounting) is verbose and error-prone for anything beyond simple class transformation. Codegen replaces this with an **expression-based fluent DSL** modelled on a Lisp-like AST: `call(staticField(System.class, "out"), "println", value("Hello world"))` produces the bytecode for `System.out.println("Hello world")`, with stack-frame accounting, type inference, and verifier-correctness handled automatically.

The expression vocabulary covers:

- Arithmetic (`add`, `sub`, `mul`, `div`, `mod`, `neg`), bitwise, and comparison ops with automatic type promotion.
- Field/method access (`property`, `call`, `staticCall`, `constructor`).
- Control flow (`ifThenElse`, `loop`, `forEach`, `switch`, `tryCatch`).
- Local variables (`let`, `set`).
- Relational-algebra-shaped operations on iterables (filter, map, reduce, group-by, sort) — useful for query-engine codegen.
- Records (heterogeneous data containers) — the Java-21 `record` keyword as a Codegen primitive.

Generated classes are cached in-memory by their generation key (in-process re-use) and optionally persisted via `BytecodeStorage` to disk for cross-process reuse — relevant when the same generated class would be regenerated repeatedly across application restarts (database query plans, schema-bound serializer codecs, AST-bound calculators).

The most-deployed Codegen application is **ActiveJ Serializer** — the framework's schema-free serializer that generates per-type binary codec classes at first use, recovering hand-written-codec performance from runtime-introspected Java classes. ActiveJ claims it as the fastest JVM serializer; whether it is *the* fastest is contested, but the design pattern (one generated codec class per serialized type, cached forever, JIT-warm before use) is the same one Kryo, FlatBuffers, and Cap'n Proto Java each implement at varying levels of automation. Codegen is what makes "generate one codec class per type" cheap to implement.

Distinct from the §13 lightweight backends (QBE, Cranelift, TPDE, DynASM, MoarVM lego, Virgil): those generate native machine code; Codegen generates JVM bytecode. Distinct from MetaOCaml/Terra staged programming (§12.3, §12.4): those provide compile-time staging with type-safe quotations; Codegen is runtime, with type inference but without staged-code typing — the bytecode is verifier-checked at class-define time. Distinct from Template Haskell (§12.5): TH is compile-time AST-rewriting, Codegen is runtime bytecode emission. The right comparison point is **JitBuilder**, the JIT-building library shipped as part of Eclipse OMR (see `MEMORY.md §6.21`) — both target managed-runtime bytecode generation with productivity-oriented APIs; Codegen is JVM-only, JitBuilder is multi-language.

Sister technique inside ActiveJ: **Specializer (§17.4)** uses ASM directly (not Codegen) to rewrite existing class instances rather than generate new classes from scratch. The two libraries target adjacent but distinct use cases — Codegen for "I have an AST/schema and want a class implementing it"; Specializer for "I have a class instance and want a specialised static class encoding its values."

The lesson generalises: **a productive expression-based DSL over the host runtime's bytecode-emission library** (ASM for JVM, IL emit API for CLR, V8's `Wasm.builder()` style APIs for Wasm-emitting Java code) substantially lowers the cost of runtime code generation for query engines, serializer codecs, expression evaluators, and DI frameworks. The cost is one library between user and bytecode; the benefit is dropping the floor of "should I codegen this?" from "only if it's worth a 1000-line ASM exercise" to "if I have an AST or schema to specialise against, yes."

Sources: https://activej.io/codegen and https://activej.io/codegen/examples and https://central.sonatype.com/artifact/io.activej/activej-codegen

### 13.11. QuickJS — Tiny Embeddable JavaScript Engine

Fabrice Bellard's **QuickJS** (released 2019, with Charlie Gordon as co-maintainer; **QuickJS-NG** is the active community fork as of 2024) is the standout small-footprint JavaScript engine — the design slot V8 and SpiderMonkey explicitly do not target. Built around an interpreter-only execution model (no JIT), QuickJS compiles to a ~210 KB shared library, supports nearly the full ECMAScript 2023 specification including BigInt, modules, async/await, generators, proxies, and regular expressions — implemented in roughly 70 KLOC of portable C99.

The architectural choice is "interpreter density first, peak performance never": where V8 Ignition (§1.8) hands off to TurboFan/Maglev (§14) for hot code, QuickJS interprets to the end. Hand-tuned bytecode dispatch, NaN-boxed value representation (§3.1), and reference counting with cycle collection provide the small heap footprint and deterministic memory model that JIT-bearing engines cannot match in embedded scenarios. The runtime fits in tens of KB of RAM after stripping unused features at compile time, opening deployment targets V8 cannot reach: smartcards, ESP32/Cortex-M MCUs, IoT devices, and constrained sandboxes.

Production: **TXIKI.JS** (small Node-alternative runtime over QuickJS-NG and libuv), several embedded JavaScript-in-firmware projects, and Bellard's own QuickJS-based systems. Distinct from MoarVM lego JIT (§13.5), which is a template-direct-emit JIT for a non-JS language; distinct from Hermes (`REPRESENTATIONS.md §9.11`), which is also JIT-less but ships pre-compiled bytecode rather than parsing JS source on device.

The lesson generalises: **a JIT-less interpreter is a viable production design for any language target where deployment constraints (memory, code-signing, deterministic timing, audit complexity) outweigh peak throughput**. QuickJS demonstrates this for JavaScript at production scale; for new languages targeting embedded or sandboxed deployment, "no JIT, tiny runtime, good interpreter dispatch" is a recoverable design point.

Sources: https://bellard.org/quickjs/ and https://github.com/quickjs-ng/quickjs and https://bellard.org/quickjs/quickjs.html

### 13.12. Wasmer, WAVM, WAMR — Alternative Wasm Runtimes

Wasmtime (Bytecode Alliance) is the Wasm runtime cited throughout this document, but the broader Wasm runtime ecosystem includes three alternatives worth recording, each making a different point in the runtime-design space.

**Wasmer** (Wasmer Inc., 2019+) is the only Wasm runtime shipping **three swappable backends**: SinglePass (instant compilation, naive codegen — for fast startup or short-lived workloads), Cranelift (the same backend used by Wasmtime, balanced compile-vs-quality), and **LLVM** (peak performance via the full LLVM pipeline at the cost of seconds of compilation per module). Wasmer's Universal Binary format ships pre-compiled object files so cold-start can skip codegen entirely — a deployment angle Wasmtime does not target. Production users include serverless platforms (Wasmer Edge), runtime-isolated UDFs in databases, and embedded scripting in Rust/C++ applications.

**WAVM** (Andrew Scheidecker, 2017+) is the LLVM-pure Wasm runtime — every Wasm function compiles via LLVM to native code with no SinglePass-style fallback. The design point is "Wasm as a compile target for high-performance numerics," where LLVM-quality code generation is mandatory. Production niche is narrower than Wasmer's; the runtime is C++17 with optional dependencies on libxml2 (debug info) and libffi (FFI bindings).

**WAMR (WebAssembly Micro Runtime)** is the Bytecode Alliance's *embedded-target* sibling to Wasmtime — written in C, designed for memory budgets in the kilobytes, with classic interpreter, fast interpreter, AOT, and JIT execution modes selected at build time. WAMR is what runs on ESP32, Cortex-M, and other MCU-class hardware where Wasmtime's Rust runtime would be too heavy. It is the Wasm analogue of QuickJS (§13.11) — interpreter-density-first, peak-performance-never — but for a different source language.

The trade-off axis across the three: **compilation strategy diversity (Wasmer)**, **LLVM-only pure performance (WAVM)**, **embedded-target footprint (WAMR)**. Wasmtime + Cranelift sits in the middle as the production default. Combined with §22 (BPF/eBPF JIT) and §24 (Wasm streaming compile), this rounds out the Wasm-runtime landscape: Wasmtime for general-purpose deployment, Wasmer for backend choice, WAVM for compute-heavy workloads, WAMR for embedded.

Sources: https://wasmer.io/ and https://github.com/wasmerio/wasmer and https://github.com/WAVM/WAVM and https://github.com/bytecodealliance/wasm-micro-runtime

### 13.13. ASTro — AST-Based Reusable Optimization Framework

Koichi Sasada's **ASTro** (VMIL 2025) is a reusable framework for building optimized AST-traversal interpreters via partial evaluation. The motivation is a common VM engineering failure mode: the language semantics are written once in an interpreter, then partially duplicated in a compiler, optimizer, and runtime helpers. ASTro keeps the AST interpreter as the semantic source of truth and generates optimized execution machinery from it, reducing duplication between the interpreter and partial evaluator.

The design point is adjacent to Truffle/Graal (§1.3) and RPython (§14.7), but narrower and more reusable for AST interpreters: define the AST node semantics, let the framework derive optimized variants and traversal structure, and avoid rewriting language semantics into a second IR-specific optimizer. This is especially relevant for small dynamic languages, DSLs, and research VMs where maintaining separate interpreter and compiler semantics is the largest correctness risk.

Status (as of 2026-04): workshop/research prototype. The lesson generalises: **AST interpreters can be made a reusable optimization substrate**, not merely a slow reference implementation, if the AST traversal and specialization hooks are designed as framework APIs.

Sources: https://dl.acm.org/doi/10.1145/3759548.3763371 and https://www.atdot.net/~ko1/activities/2025_astro_VMIL2025.pdf

---

## 14. Trace-Based JIT & Speculative Optimization

Aggressive JIT optimization depends on *speculating* — assuming types, shapes, branch directions, or escape behavior that the compiler can't statically prove but that the observed execution suggests. The central design question across this chapter is: when speculation fails, how does the runtime get back to correct execution? Entries differ on the unit of compilation and the recovery mechanism — traces with guard-driven side exits, method-level deoptimization via on-stack replacement, per-block versioning that sidesteps global speculation, worker-thread specialization with lazy stack-unwind deopt, and dispatcher programs that unify every Raku dispatch kind under a single specializable substrate.

### 14.1. Trace-Based JIT Compilation — LuaJIT, PyPy

While §1.2 covers tiered compilation, it describes only method-based JITs. Trace-based JITs take a fundamentally different approach: instead of compiling entire functions, they record "traces" — linear sequences of instructions actually executed through hot loops — and compile those.

**LuaJIT** (Mike Pall) is the canonical example. When a loop becomes hot, LuaJIT's interpreter records a trace of the bytecodes executed through one iteration, including inlined function calls. The trace is then compiled to machine code by a sophisticated single-pass assembler. Guards are inserted at every point where the trace could diverge (type checks, branch conditions). If a guard fails, execution falls back to the interpreter ("side exit"), which may start recording a new trace from that point.

LuaJIT achieves remarkable performance — often within 2x of optimized C — with a codebase of ~60,000 lines. The trace compiler's single-pass design means compilation is extremely fast (microseconds per trace).

**PyPy** (Bolz et al.) uses meta-tracing: instead of tracing the user program directly, PyPy traces the execution of the *interpreter* running the user program. When the interpreter enters a hot loop in user code, the meta-tracer records what the interpreter does — which bytecodes it dispatches, what type checks it performs, what allocations it makes. The resulting trace is specialized to the observed types, and optimizations (constant folding, allocation removal, unboxing) are applied.

CF Bolz-Tereick (2025) reflects on tracing JITs: they excel at optimizing across function boundaries and through deeply nested dynamic dispatch (because the trace naturally inlines everything), but struggle with methods that have many divergent paths (trace explosion). Status (as of 2026-04): most production JITs (V8, SpiderMonkey, HotSpot) are method-based, but LuaJIT and PyPy demonstrate that tracing can be highly competitive for the right workloads.

Sources: https://pypy.org/posts/2025/01/musings-tracing.html and https://kipp.ly/jits-impls/

### 14.2. Deoptimization & On-Stack Replacement (OSR)

Speculative optimization in JITs creates a fundamental problem: what happens when an assumption is violated while optimized code is running? Two mechanisms address this:

**On-Stack Replacement (OSR)** allows switching execution tiers while a function is mid-execution. OSR-up: when a long-running interpreted loop becomes hot, the JIT compiles it and transfers execution to the compiled version without waiting for the function to return. OSR-down (deoptimization): when a speculative assumption fails in compiled code, execution transfers back to the interpreter at the equivalent program point.

The engineering challenge: at the moment of transfer, all live variables must be mapped between the source and target representations. The interpreter and compiler may use different stack layouts, register assignments, and even different variable representations (an unboxed double in compiled code vs. a tagged value in the interpreter). D'Elia and Demetrescu (2018) formalized OSR as a general framework for transferring execution between related program versions, implemented in LLVM.

**Deoptless** (Flückiger et al., PLDI 2022) proposes replacing traditional deoptimization points with dispatched specialized continuations. Instead of falling back to the interpreter on guard failure, the system dispatches to a separately compiled continuation specialized for the failing case. This provides a more transparent performance model — no mysterious slowdowns from deoptimization storms.

Barrière et al. (POPL 2021) formally verified speculation and deoptimization in a JIT compiler, proving that the observable behavior of speculative execution matches the source semantics — a critical correctness property that is notoriously hard to get right.

Sources: https://season-lab.github.io/papers/osr-distilled-pldi18.pdf and https://janvitek.org/pubs/pldi22.pdf

### 14.3. Basic Block Versioning — YJIT

Maxime Chevalier-Boisvert's **Basic Block Versioning (BBV)**, from her PhD thesis and deployed in production as Ruby's **YJIT**, is a distinct approach that's neither method-based nor trace-based. BBV compiles one basic block at a time, *lazily*, and creates separate specialized versions of a block based on the runtime types observed at its entry.

The key insight: when a basic block is first compiled, its entry state (types of live values) is recorded. If the block is later entered with a different type profile, a new version is compiled specialized to that profile. Both versions coexist; control transfers to whichever version matches the current state. Type propagation within a block lets the compiler emit unboxed arithmetic and direct-dispatch method calls without a separate type inference pass.

Compared with tracing:
- No trace recording or explosion on divergent paths — BBV handles branchy code naturally because each block is an independent unit.
- No method-level compilation unit — BBV doesn't wait for a whole method to be hot before compiling anything.
- Specialization is driven by observed types, not by user-written type hints, and happens at block granularity.

Status (as of 2026-04): production since Ruby 3.1 (2021). YJIT now delivers 2–3x speedups on Rails workloads with compilation overhead low enough for production opt-in, and some Rails deployments enable it by default. The technique has since been adopted in experimental JITs for other dynamic languages.

Sources: https://chrisseaton.com/truffleruby/basic-block-versioning/ and https://dl.acm.org/doi/10.1145/2816707.2816714

### 14.4. MoarVM spesh — Worker-Thread Specialization and Lazy Deoptimization

MoarVM's **spesh** subsystem (Jonathan Worthington et al.) is the runtime specializer that consumes type statistics and produces type-specialized, optimized versions of bytecode. Two design points distinguish it from V8 TurboFan or HotSpot C2:

**Specialization runs on a worker thread.** Most optimizing JITs pause execution to compile (TurboFan, C2, LuaJIT's trace compiler). MoarVM instead runs a dedicated spesh thread that consumes logs of observed types and calls from other threads, produces specialized bytecode + machine code asynchronously, and hands the results back to be installed when ready. The main threads never block on compilation. The cost is that specializations arrive slightly later than with synchronous compilation; the benefit is no latency spikes from pause-for-compile and better multi-core utilization on machines with cores to spare.

**Lazy deoptimization on stack unwind.** When a guard fails inside specialized code, the obvious approach is to walk every specialized frame on the stack and deoptimize them all. MoarVM does something cheaper: the frame that triggered the guard failure is deoptimized immediately, but other specialized frames currently on the stack are only *marked* as needing deoptimization. They're actually deopted when the stack unwinds into them. If a marked frame returns without ever triggering a guard of its own, no work is wasted.

**Uninlining after inline-guard failure.** When spesh has inlined several methods into a specialized frame and a guard inside one of the inlined regions fails, MoarVM reconstructs the original stack frames that inlining had erased. The inliner records "resume init" metadata describing how to rebuild each inlined frame's register state; deoptimization replays this to push the correct frames onto the call stack dynamically. This is more aggressive than classical OSR (§14.2), which typically falls back to the interpreter without reconstructing the inlined call hierarchy. Spesh's uninlining keeps the original program's semantics visible to the debugger and profiler even after aggressive inlining.

Sources: https://6guts.wordpress.com/2017/11/05/moarvm-specializer-improvements-part-3-optimizing-code/ and https://github.com/MoarVM/MoarVM/blob/new-disp/src/spesh/deopt.c

### 14.5. MoarVM new-disp — Dispatch as Specializable Programs

Raku's dispatch semantics are unusually rich (single dispatch, multiple dispatch, proto/only-star, `where`-clause bind-failure resumption, `callsame`/`nextsame`, wrappers, user-extensible dispatchers); implementing each as its own VM mechanism would be untenable.

**new-disp** (Jonathan Worthington, merged into MoarVM in 2021) unifies them all into a single primitive: **dispatch programs**. A dispatcher is written in NQP (Not Quite Perl, Rakudo's bootstrapping subset) that receives an argument capture and records guards (cheap type/literal checks installed for fast re-dispatch), delegations (forward the possibly-modified capture to another dispatcher, or ultimately to a "boot" dispatcher), and resumption points (so `callsame` / bind-failure can re-enter the dispatch where it left off).

The recorded program is a first-class object: spesh specializes it, the JIT (§13.5, §9.1) compiles the guard chain and delegation to native code, and the result behaves like an inline cache for arbitrarily complex dispatch semantics.

For example: method dispatch is a dispatcher that guards on the invocant's type and delegates to the cached method; multiple dispatch guards on each argument's type and delegates to the matching candidate; `callsame` is resumption of the enclosing dispatch with the next candidate. Because dispatch programs are specializable and JIT-compilable, even multiple dispatch with `where` clauses collapses to approximately inline-cache speed when the types are monomorphic. Classical PICs (§17.2) handle one-argument dispatch with a chain of type comparisons; new-disp generalizes this to arbitrary dispatcher programs over arbitrary argument captures, with the same specialization pay-off.

Sources: https://6guts.wordpress.com/2021/09/29/the-new-moarvm-dispatch-mechanism-is-here/ and https://6guts.wordpress.com/2021/04/15/raku-multiple-dispatch-with-the-new-moarvm-dispatcher/ and https://gist.github.com/jnthn/e81634dec57acdea87fcb2b92c722959

### 14.6. MoarVM ThreadPoolAwaiter — Compiler Consequences of Continuation-Captured Await

The spesh-interaction is the load-bearing point: continuation capture across an `await` must preserve enough resumption metadata to land back in specialized frames correctly, and (interaction with §14.5) dispatch programs contain resumption points, so a continuation captured across a dispatch site must restore the dispatch program's state as well as the language stack. This makes async/await a stress test for specialization metadata, deoptimization metadata, and continuation-safe inline caches rather than merely a scheduler feature. The `Supply` / `react` / `whenever` CPS-transform onto Promise chains and the broader scheduler/awaiter design live in `CONCURRENCY.md §11.6`.

Sources: https://github.com/rakudo/rakudo/blob/nom/src/core/ThreadPoolScheduler.pm and https://github.com/MoarVM/MoarVM/blob/master/src/core/threads.c and https://docs.raku.org/language/concurrency.html

### 14.7. Multi-Tier JIT Generation from Meta-Tracing Interpreters — 2SOM / RPython

Izawa, Masuhara, and Bolz-Tereick's **2SOM** (ECOOP 2025) adds a lightweight tier to an RPython meta-tracing VM without implementing a new traditional JIT backend. The method treats interpreter definitions not only as language semantics but also as compilation-strategy specifications. Two interpreter variants drive the same meta-tracing infrastructure: a tier-1 interpreter that generates subroutine-threaded code for quick warm-up, and a tier-2 interpreter that triggers RPython's ordinary tracing JIT for hot loops.

The practical machinery is the interesting part:

- **Embedded profiling** in the tier-1 code counts back edges and raises a tier-transition event when a threshold is reached.
- **Interpreter switching** transfers the current frame from the lightweight interpreter into the heavyweight tracing interpreter, letting existing `jit_merge_point` machinery enter optimized code.
- **Shallow tracing** avoids corrupting interpreter state when threaded-code generation traces both sides of a branch: handler calls are recorded without executing side-effecting handler bodies during tracing.
- **Direct calls with inline caching** turn dynamic method dispatch in threaded code into guarded direct `call_assembler` paths when receiver types match cached observations.

The reported result on synthesized SOM workloads is about **15% faster warm-up** than tracing-JIT-only execution, with about **5% peak-performance loss**. The limitation is equally important: the approach cannot add a tier requiring a fundamentally different low-level backend, register allocator, or instruction scheduler, because it reuses the meta-tracing compiler's existing trace pipeline.

The design lesson: **meta-compiler frameworks can recover a tiered-VM shape by varying interpreter definitions**, not only by building multiple independent compilers. This is most attractive for language implementations that already have a high-quality interpreter and want a baseline native tier without duplicating semantics.

Source: https://arxiv.org/html/2504.17460v1

### 14.8. Reusing Highly Optimized IR in Dynamic Compilation

Pečimúth, Leopoldseder, and Tůma's **Reusing Highly Optimized IR in Dynamic Compilation** (ECOOP 2025) studies dynamic compilation systems that avoid throwing away expensive optimization work when runtime conditions change. The general pattern is to preserve optimized IR fragments and adapt or reconnect them across recompilation events, instead of returning all the way to bytecode or an unoptimized IR whenever profiling data, assumptions, or bytecode operands change.

This sits between tiered compilation (§1.2), deoptimization (§14.2), and IR caching (§18): the unit being cached is not only generated machine code, but an already-optimized compiler representation that can be reused as input to later dynamic compilation. The benefit is lower compile latency for hot paths that change incrementally; the risk is correctness complexity around invalidated assumptions, deopt metadata, and IR versioning.

The design lesson: **dynamic compilers should treat optimized IR as a reusable artifact**, not just an ephemeral by-product of one compilation event, when hot code evolves under stable structure.

Sources: https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2025.25 and https://labs.oracle.com/pls/apex/f?p=94065:10:983652587227:11670

---

## 15. Domain-Specific & AI-Oriented Compilation

Tensor workloads, GPU kernels, and differentiable programs have driven a parallel compiler ecosystem in which general-purpose IRs like LLVM are one layer among many. The entries below differ on *which abstraction level the optimizer operates at*: polyhedral frameworks reason about affine loop nests as integer polyhedra, Enzyme differentiates already-optimized LLVM IR, NVRTC and SPIR-V act as runtime-compilable portable GPU IRs, and stacks like Mesa NIR and XLA assemble multi-stage pipelines of specialized dialects. Each picks a level of abstraction that trades generality for domain-specific transformations a lower-level compiler would miss.

### 15.1. Polyhedral Compilation — Loop Nest Optimization

Polyhedral compilation represents loop nests and array accesses as parametric integer polyhedra, enabling mathematically precise reasoning about dependencies, parallelism, and data locality. For a language targeting AI workloads — which are dominated by nested loops over tensors — polyhedral techniques are directly relevant.

The core idea: a loop nest like `for i in 0..N: for j in 0..M: A[i][j] = B[j][i]` is modeled as an iteration domain (the set of (i,j) points), an access relation (mapping iterations to array elements), and a schedule (mapping iterations to execution times). Transformations like tiling, interchange, fusion, skewing, and parallelization are expressed as affine transformations of the schedule — and the polyhedral framework can automatically verify that these transformations preserve program semantics.

**Halide** (Ragan-Kelley et al., 2012) introduced the influential separation of algorithm from schedule. The programmer writes what to compute (the algorithm), and separately specifies how to compute it (the schedule — tiling factors, parallelism, vectorization, storage). This decoupling allows exploring optimization spaces without modifying the algorithm, and enables auto-tuning.

**Tiramisu** extends polyhedral compilation with the full power of the model (including skewing for RNN optimization), achieving 2x speedup over TVM on recurrent architectures.

**Triton** (Tillet et al.) takes a different approach: instead of polyhedral analysis, it provides block-level programming abstractions for GPU kernels, letting the compiler handle memory coalescing and scheduling within blocks. Triton has become the dominant way to write custom GPU kernels for PyTorch.

Sources: http://polyhedral.info/ and https://triton-lang.org/main/programming-guide/chapter-2/related-work.html

### 15.2. Automatic Differentiation at the Compiler Level — Enzyme

Automatic Differentiation (AD) computes exact derivatives of programs by applying the chain rule systematically. While frameworks like PyTorch and JAX provide AD through operator overloading or tracing, **Enzyme** (Moses & Churavy, 2020) operates at the LLVM IR level — differentiating compiled code rather than source code.

Enzyme's approach is uniquely powerful:
- **Language-agnostic**: because it operates on LLVM IR, it can differentiate programs written in C, C++, Rust, Julia, Fortran, Swift, or any LLVM-targeting language.
- **Optimization-friendly**: AD happens after LLVM optimization passes, meaning the derivative code benefits from the same optimizations as the original. Conversely, the derivative itself can be further optimized. Moses showed that performing AD after optimization can be orders of magnitude faster than AD before optimization.
- **GPU support**: Enzyme can differentiate CUDA kernels, generating reverse-mode gradients of parallel GPU code — the first fully automatic AD tool to do so.

The alternative approaches:
- **Source-to-source** AD (Tapenade, ADIFOR) rewrites source code to produce gradient functions. Requires all code to be available and analyzable at the source level.
- **Operator overloading** AD (JAX, Adept) provides differentiable versions of language primitives. Requires rewriting code to use non-standard types.
- **DSL-based** AD (TensorFlow, PyTorch) defines computation in a differentiable graph language. Restricted to the operations the DSL supports.

Sources: https://enzyme.mit.edu/ and https://c.wsmoses.com/papers/EnzymeGPU.pdf

### 15.3. CUDA NVRTC — Runtime PTX Compilation

**NVRTC** (NVIDIA Runtime Compilation) is CUDA's API for compiling CUDA C++ source code to PTX at runtime. The workflow: application supplies kernel source as a string, NVRTC returns PTX, the application passes PTX to the CUDA driver, the driver compiles PTX to the target GPU's SASS (Streaming Assembler). Two compilation stages: host-side NVRTC for source→PTX, driver-side for PTX→SASS.

NVRTC exists because static CUDA compilation (`nvcc`) embeds PTX for a specific set of GPU architectures; code running on a newer GPU pays a driver-level JIT anyway. NVRTC lets applications generate kernels dynamically — specializing on input dimensions, fusing operations, or implementing user-defined functions — without shipping a full CUDA toolchain.

The technique dominates production GPU workloads. PyTorch's `torch.compile`, TensorFlow's XLA, JAX's `jit`, and most modern deep learning frameworks use NVRTC internally. The alternative would be shipping thousands of pre-compiled kernel variants; runtime compilation reduces this to generating exactly what's needed.

Source: https://docs.nvidia.com/cuda/nvrtc/

### 15.4. SPIR-V as Portable GPU IR

**SPIR-V** (Standard Portable Intermediate Representation, Khronos 2015) is the binary IR used by Vulkan, OpenCL 2.1+, and OpenGL 4.6. It's SSA-based, statically typed, and explicitly designed for both kernel (OpenCL) and graphics shader (Vulkan) workloads.

The architecture: frontends (GLSL, HLSL, SYCL, OpenCL C++) compile to SPIR-V; drivers then lower SPIR-V to the target GPU's native instruction set. This decouples source language evolution from driver implementation, and makes SPIR-V the *de facto* portable GPU IR across vendors.

For runtime compilation, the interesting pattern is **SPIR-V as IR-level input to a JIT**: applications can generate SPIR-V directly (via libraries like `spirv-tools` or `rspirv`), submit to the driver, and get native GPU code without ever going through a high-level source language. This is how several GPU database engines and real-time shader generators operate.

Sources: https://www.khronos.org/spir/ and https://registry.khronos.org/SPIR-V/specs/unified1/SPIRV.html

### 15.5. Mesa NIR and GPU Compiler Stacks

**Mesa's NIR** (New Intermediate Representation) is the open-source GPU driver stack's internal IR, used by Intel, AMD, Nvidia (Nouveau), and others for compiling shaders to their respective architectures. NIR is SSA-based, deliberately low-level, and designed for aggressive transformations — the Mesa compiler runs dozens of passes on NIR before lowering to hardware-specific IRs.

Separately, **XLA** (Accelerated Linear Algebra, Google) and **Triton** (OpenAI) illustrate two ends of the stack:
- XLA takes TensorFlow or JAX graphs, applies fusion and layout transformations, and lowers through HLO (High-Level Ops) to target-specific backends including GPU (via LLVM NVPTX) and TPU. The JIT path compiles per-input-shape, caching compiled executables.
- Triton (covered briefly in §15.1's polyhedral note) takes Python-like kernel code, applies block-level optimizations, and emits LLVM IR targeting NVPTX. Distinct from NVRTC because Triton owns the entire compilation pipeline from Python AST to PTX, rather than wrapping NVIDIA's C++ compiler.

The takeaway for language design: GPU compilation is fundamentally a multi-stage pipeline with portable IRs (SPIR-V, LLVM IR, NIR, HLO) at each level. The trade-off for a new GPU-targeting language is between plugging into one of these IRs (inheriting driver/vendor support and tooling) and inventing a parallel IR (gaining language-specific optimizations at the cost of duplicating the pipeline below).

### 15.6. Bend / HVM2 — Interaction-Combinator Runtime to GPU

The HVM2 runtime (concurrency angle in `CONCURRENCY.md §3.11`, representation angle in `REPRESENTATIONS.md §13.12`) compiles **Bend** source code to an interaction-combinator graph, then to either a C runtime or a CUDA runtime. The CUDA backend's compilation pipeline is unusual: rather than emitting per-program PTX (the NVRTC §15.3 pattern) or per-kernel SPIR-V (§15.4), HVM2 ships a **fixed CUDA evaluator** that interprets the graph at runtime, distributing active-pair rewrites across warp lanes. The "compiler" therefore becomes a *graph-builder for the GPU evaluator*, not a code generator in the traditional sense.

The architectural lesson is distinct from every other entry in this chapter: where Triton (§15.1, §15.5), NVRTC (§15.3), Mojo (§6.6), and TornadoVM (next subsection) all generate target-specific kernel code, HVM2 generates target-neutral graph data and lets a fixed runtime evaluate it. This pays a constant-factor performance cost vs hand-tuned kernels, but eliminates the per-program codegen step entirely — a Bend program runs on any HVM2-supported device without backend-specific compilation. Status (as of 2026-04): the CUDA backend is research-grade; production deployment requires either accepting the constant-factor cost or generating specialised kernels for hot subgraphs (a hybrid approach not yet in the public roadmap).

Sources: https://github.com/HigherOrderCO/HVM2 and https://github.com/HigherOrderCO/Bend and https://raw.githubusercontent.com/HigherOrderCO/HVM/main/paper/HVM2.pdf

### 15.7. Project Babylon and TornadoVM — Java to GPU

The JVM has two complementary 2024–2026 efforts to compile Java to GPUs without writing CUDA C or OpenCL.

**Project Babylon** (OpenJDK, Paul Sandoz et al., 2024+) is the upstream OpenJDK answer. The mechanism is **code reflection**: the compiler emits a *code model* — a typed, structured representation of a method's body — alongside the bytecode for selected methods (typically annotated `@CodeReflection` or in known classes). The HAT runtime ("Heterogeneous Accelerator Toolkit") consumes code models and translates them to GPU-native targets at runtime: OpenCL C for AMD/Intel/Apple GPUs, CUDA PTX for NVIDIA. Distinct from JNI/CUDA wrappers: the Java method body itself is the source for the GPU kernel, with no separate kernel language. Status (as of 2026-04): Babylon is in active development under OpenJDK; HAT prototypes ship with experimental Java 25+ builds. The 2025 demos focused on writing GPU-ready ML model bodies in plain Java.

**TornadoVM** (University of Manchester, Juan Fumero et al., since ~2014; v2.0 December 2025) predates Babylon and takes a different architectural choice: a **Graal-based JIT plugin** that intercepts annotated Java methods (`@Parallel`, `@Reduce`) and lowers them to one of three GPU backends (OpenCL C, NVIDIA CUDA PTX, SPIR-V). Production deployment for LLM inference, scientific computing, and data analytics on Java-shop infrastructure. v2.0 added native INT8 support for NVIDIA, FP32-to-INT8 quantisation kernels, and a more polished Java-native programming surface.

The two efforts are complementary rather than competing: Babylon provides the upstream JDK *infrastructure* (code models as a stable API surface for any GPU-targeting framework); TornadoVM provides a production-deployable *implementation* on top of Graal. The expected long-term architecture has TornadoVM (or its successors) consuming Babylon code models from JDK 26+ rather than parsing bytecode, simplifying both projects.

The lesson for language designers: **a managed-runtime language can add GPU compilation without designing a new GPU DSL** if the compiler emits structured code models (Babylon) that a separate framework can consume and lower. This is more flexible than the "language X needs its own GPU compiler" pattern (Triton, Mojo, Bend) but pays a coordination cost — the JDK and TornadoVM teams must agree on code-model semantics for the integration to work.

Sources: https://openjdk.org/projects/babylon/ and https://www.tornadovm.org/ and https://tornadovm.readthedocs.io/en/latest/introduction.html and https://www.infoq.com/news/2025/12/tornadovm-20-gpu-llm/ and https://jjfumero.github.io/posts/2025/02/07/babylon-and-tornadovm

Sources: https://docs.mesa3d.org/nir/ and https://www.tensorflow.org/xla

### 15.8. Pydrofoil — Compiling Sail ISA Specifications into Fast Simulators

**Pydrofoil** (ECOOP 2025) is a multi-stage compiler that generates fast instruction-set simulators from **Sail** processor ISA specifications. Sail specifications are already used as executable formal models for RISC-V, ARM, CHERI, and related architectures; Pydrofoil turns those specifications into higher-performance simulators rather than forcing implementers to choose between a trusted but slow formal model and a separately written fast emulator.

The pipeline is significant because the source artifact is a semantics specification, not an implementation-oriented language. Pydrofoil specialises and compiles the Sail model, removing interpretive overhead while preserving the connection to the authoritative ISA description. That makes it a useful case study in **specification-as-compiler-input**: the same semantic artifact can feed verification tools, test generation, and executable simulators.

The design lesson generalises beyond ISA simulators: when a language or platform already has an executable formal semantics, a staged compiler can sometimes generate practical runtime artifacts from the semantics directly, avoiding semantic drift between spec, interpreter, and tests.

Sources: https://arxiv.org/abs/2503.04389 and https://github.com/pydrofoil/pydrofoil

---

## 16. Advanced Memory Management

This chapter keeps only the **compiler-pass** view of memory strategies: where the compiler inserts, proves away, or lowers memory-management operations. The language/runtime design space — ownership, borrowing, regions, ARC/RC, tracing GC, allocator APIs, capabilities, verification, and concurrent reclamation — is covered in `MEMORY.md`.

The compiler-facing question is narrower: what information must be represented in IR so memory management can be optimized rather than treated as opaque runtime calls?

### 16.1. Perceus — Compile-Time Reference Counting and Reuse

Perceus is the compiler-pass datapoint that RC can be an IR transformation rather than a runtime-library convention: the compiler inserts precise `dup`/`drop` and runs reuse analysis to reclaim same-sized storage in place. Full memory-model treatment lives in `MEMORY.md §3.2` and `MEMORY.md §3.4`.

Source: https://www.microsoft.com/en-us/research/wp-content/uploads/2020/11/perceus-tr-v1.pdf

### 16.2. Region-Based Memory Management — Compiler Inference and Bulk Free

The compiler-design question is whether region/arena placement is a required source-level discipline, an inferred optimization, or a lower-level allocator feature. If regions affect safety, they must appear in typed IR and in borrow/effect constraints; if they are only an optimization, a MIR/backend allocation-placement pass suffices. The full region survey (MLKit inference, Cyclone, hybrids with GC) lives in `MEMORY.md §2`.

Sources: https://elsman.com/mlkit/ and https://www.cs.umd.edu/projects/cyclone/papers/cyclone-regions.pdf

### 16.3. Vale — Runtime Checks as Compiler-Eliminable Memory Safety

The compiler-pass takeaway is that the compiler eliminates runtime safety checks using region/purity information — the IR has to expose enough aliasing, region, and purity facts that later passes can prove a generation check redundant inside a scope. See `MEMORY.md §2.6` for the full Vale memory-design discussion (generational references mechanics, regions, hybrid-generational memory) and the canonical sources.

---

## 17. Runtime Object Model Optimization

Dynamic-language runtimes face an inherent tension: source code says `obj.x` without committing to a layout, but native code wants a fixed offset. The techniques in this chapter bridge that gap at runtime — observing object shapes and specializing code against them. The distinguishing axis is *how the specialization is cached and how it degrades when assumptions break*: hidden classes plus monomorphic inline caches for the common case, polymorphic inline caches for small call-site type distributions, and deeper speculative specialization that guards on object-model invariants with OSR-based deoptimization when guards fail.

### 17.1. Hidden Classes & Inline Caching — V8, SpiderMonkey

For dynamically typed languages, property access on objects (`obj.field`) is potentially an expensive hash table lookup. Hidden classes (called "Shapes" in SpiderMonkey, "Maps" in V8, "Structures" in JavaScriptCore) solve this by imposing static-like structure on dynamic objects.

When an object is created, the engine assigns it a hidden class describing its layout — which properties exist and at what memory offsets. When a property is added, a new hidden class is created (or an existing one is reused via transition chains). Objects with the same hidden class have identical memory layouts, enabling fixed-offset access instead of hash lookups.

**Inline caching (IC)** exploits hidden classes at call sites. The first time `obj.x` is executed, the engine looks up the property, records the hidden class and the offset, and patches the call site with a fast path: "if the object's hidden class is C, load from offset 16." Subsequent executions hit the fast path in O(1). If different hidden classes are seen at the same call site:
- **Monomorphic IC**: one hidden class — fastest, single comparison + direct load.
- **Polymorphic IC**: 2–4 hidden classes — linear search through a small table.
- **Megamorphic IC**: many classes — falls back to generic hash lookup.

The performance cliff is dramatic. Status (as of 2026-04): V8 and SpiderMonkey continue to report monomorphic property access on the order of 60–100x faster than the megamorphic fallback, which is why they invest heavily in hidden-class stability analysis and why "initialize all properties in the constructor" remains critical JavaScript performance advice. The same monomorphic-fast-path idea is what bytecode quickening (§1.9) carries into interpreter dispatch loops without a JIT.

Sources: https://v8.dev/docs/hidden-classes and https://mrale.ph/blog/2015/01/11/whats-up-with-monomorphism.html

### 17.2. Polymorphic Inline Caches (Hölzle-Chambers-Ungar)

Urs Hölzle, Craig Chambers, and David Ungar introduced **polymorphic inline caches (PICs)** in the SELF compiler ("Optimizing Dynamically-Typed Object-Oriented Languages With Polymorphic Inline Caches", ECOOP 1991). The mechanism extends monomorphic inline caching (§17.1) to handle call sites with 2–10 receiver types, without falling back to the slow megamorphic dispatch.

The implementation: when a site goes polymorphic, instead of patching a single type/offset pair into the call, the compiler generates a small stub with a chain of type comparisons. The first matching type dispatches; a miss appends a new entry up to a configured cap, after which the site is flagged megamorphic and falls back to method lookup.

PICs are load-bearing for any dynamic-dispatch language. Status (as of 2026-04):
- In Smalltalk and SELF, PICs made message sends nearly free for typical call sites.
- V8 and SpiderMonkey's IC caches are direct descendants; the ICState machine (Uninitialized → Monomorphic → Polymorphic → Megamorphic) is the PIC lineage.
- Julia's method dispatch uses a tree of type tests equivalent to a PIC, specialized per call site.

The key property that makes PICs profitable: call-site type distributions are *heavily Zipfian*. A small number of types cover the vast majority of calls, so a small PIC captures almost all dispatches cheaply. This is why the polymorphic-vs-megamorphic cliff (§17.1) is so steep — staying within the PIC's capacity is the difference between fast and fallback.

Source: https://bibliography.selflanguage.org/_static/pics.pdf

### 17.3. Speculative Type Specialization in the Object Model

JIT compilers extend inline caching (§§17.1–17.2) with deeper speculation guarded by runtime checks; the general OSR/deoptimization mechanism is covered in §14.2 and the MoarVM lazy-unwind variant in §14.4. The object-model-specific patterns layered on top are: **type specialization** (compile arithmetic assuming integer operands), **shape guards** (compile property access assuming a specific hidden class), **bounds-check elimination** (prove array indices in bounds and drop the check), and **allocation sinking / scalar replacement** (replace a non-escaping object with stack-allocated fields). V8 TurboFan, SpiderMonkey IonMonkey, and HotSpot C2 all combine these patterns; the operational cost is managing deoptimization frequency, typically via adaptive recompilation that drops assumptions after repeated deopts.

### 17.4. ActiveJ Specializer — Instance-to-Static Class Rewriting at Runtime

ActiveJ Specializer (SoftIndex Lab, since v3, current v6.0-rc2) is an unusual point in the runtime-object-model design space: rather than caching dispatch decisions (§17.1, §17.2) or speculating on observed types (§17.3), it transforms class instances into **specialised static classes** whose methods are static and whose instance fields become baked-in `static final` constants. The original instance disappears; what remains is a class whose state is encoded entirely in its bytecode, and which the JVM's JIT can aggressively inline, dead-code-eliminate, and constant-fold as if the values had been hand-written.

The mechanism uses ASM at runtime. Given an instance whose class has predictable shape (no lambdas, simple instance construction), the Specializer:

1. Walks the instance's field values and serializes each as a target class's `static final` field.
2. Rewrites every instance method `m(args)` as a static method `m(this_was_instance, args)` whose body has had all `this.field` reads inlined to constant references.
3. Defines the new class via `DefiningClassLoader`, instantiates a "compiled" handle that delegates to the static methods, and returns it as the same interface type.

The result: dispatch goes through static method calls (cheap on HotSpot — directly inlinable), field reads become constant loads (the JIT specialises through them), and the entire instance's data flow becomes a candidate for HotSpot's escape analysis, scalar replacement, and aggressive inlining. ActiveJ's published benchmark on a parsed-AST calculator expression: tree-walking evaluation 828 ns/op, manual hand-written code 116 ns/op, Specializer-rewritten AST instance 117 ns/op — a ~7× speedup that recovers manual-code performance from a generic interpreter.

The Specializer's main production user is **ActiveJ Inject** (the framework's DI library): bindings — the closure-like values produced by the injector graph — are Specializer-compiled into static classes, eliminating the per-injection dispatch overhead. ActiveJ measured ~2× server-throughput gains from `Injector.useSpecializer()` on RPC workloads. The technique is also applied to expression trees (calculator/query AST nodes), serializer codecs, and any other tree-shaped data structure where each instance carries small immutable state and is hot enough to amortise the rewrite cost.

Distinct from the rest of §17:
- **Hidden classes (§17.1)** track shared layout across instances; Specializer makes each instance its own class.
- **PICs (§17.2)** cache dispatch by receiver type; Specializer eliminates dispatch by making the call static.
- **Speculative type specialization (§17.3)** speculates on *observed* types and deoptimises on guard failure; Specializer doesn't speculate — it rewrites against *known field values* and never needs to deoptimise.

Distinct from Futamura-style partial evaluation (§1.3): Futamura specialises a *program* against partially-known *inputs* at compile time; Specializer specialises *one runtime instance* against *its own field values* at the moment it is constructed. The classes-of-things being specialised (programs vs instances) are fundamentally different.

Status (as of 2026-04): production-stable, used inside ActiveJ Inject and several internal SoftIndex Lab products. Caveats: ActiveJ marks Specializer "experimental" and notes it does not support lambdas and may struggle with non-trivial instance graphs. Caching of generated classes (in-memory and persistent via `BytecodeStorage`, see §13.10) avoids paying the rewrite cost more than once per (class, field-value-tuple) pair.

The lesson generalises: **for any managed runtime where class instances carry small immutable state and are repeatedly invoked, runtime instance-to-static-class rewriting is a complementary lever to PIC-style dispatch caching** — different mechanism, different cost model, additive performance gain. New language runtimes targeting the JVM (Kotlin, Scala, Clojure, Groovy implementations) inherit Specializer's applicability for free; new managed runtimes designing their own bytecode can adopt the same rewrite pattern.

Sources: https://activej.io/specializer and https://activej.io/specializer/examples and https://activej.io/inject/speeding-up-injection

---

## 18. Incremental & Query-Based Compilation

Interactive tooling — language servers, IDE diagnostics, watch-mode builds — requires compilers that do as little work as possible when anything changes. Entries in this chapter differ on *what the unit of caching is and how invalidation propagates*: query-based architectures like Salsa memoize demand-driven functions with automatic dependency tracking, parallel codegen splits a single compilation across workers, and Unison makes content-addressing the primary code identity so that rebuilds collapse to hash lookups. Each extracts incrementality from a different level of the compilation pipeline.

> The *module-system* angle on dependency boundaries — package vs crate vs module identity, deterministic resolution, and how source-level module design constrains incremental invalidation — lives in `PACKAGING.md §3` and `PACKAGING.md §4.1` (lockfiles).

### 18.1. Query-Based Compilation — rustc, Salsa, rust-analyzer

Traditional compilers execute a fixed sequence of passes (parse → type-check → lower → optimize → codegen). Query-based compilers invert this: computation is organized as a set of memoized functions ("queries") that compute results on demand. When a query is invoked, the system checks if a valid cached result exists; if not, it computes the result and caches it, tracking which inputs were read.

**rustc** is built around a query-based architecture. Instead of running type inference as a monolithic pass, the compiler defines queries like `type_of(DefId) → Type`, `mir_built(DefId) → Mir`, `codegen_unit(Symbol) → CodegenUnit`. Each query is computed on demand and memoized. When an input changes, incremental compilation invalidates the affected query results and reuses the rest where dependency tracking can prove they remain valid.

**Salsa** (Matsakis et al.) is the incremental computation framework used by rust-analyzer. It provides:
- **Automatic dependency tracking**: queries automatically track which other queries they read; no manual dependency declarations needed.
- **Shallow verification**: when an input changes, Salsa checks if the query's result actually changed before invalidating dependent queries. This "green" verification prevents cascading recomputation.
- **Cycle detection**: handles mutually recursive queries gracefully.
- **Parallel execution**: Salsa 2.0+ supports parallel query evaluation, enabling parallel autocomplete and diagnostics in rust-analyzer.

Recent Salsa work and rust-analyzer integration focus on faster revision tracking, better parallelism, and avoiding unnecessary recomputation during crate-graph and source edits. Persistent on-disk caching is a harder, more application-specific layer than ordinary in-memory query reuse, so it should be treated as a possible architecture extension rather than a default Salsa guarantee. The migration yielded major performance wins: David Barsky and Lukas Wirth reported significant improvements in rust-analyzer responsiveness.

Sources: https://rustc-dev-guide.rust-lang.org/query.html and https://github.com/salsa-rs/salsa

### 18.2. Parallel Compilation

A distinct axis from incrementality: splitting a single compilation unit across multiple threads to use available cores. Three representative approaches:

**rustc codegen units**: rustc partitions a crate's post-optimization MIR into multiple "codegen units" (CGUs), one per parallel worker. Each CGU is lowered to LLVM IR and compiled independently; LLVM runs per-CGU. The trade-off: more CGUs parallelize better but lose cross-CGU inlining, hurting code quality. The default heuristic is 16 CGUs for dev builds (speed), 1 for release (code quality). `-C codegen-units=N` exposes the knob.

**LLVM parallel codegen**: LLVM's own `llvm::parallelFor` infrastructure runs individual function compilations on a thread pool when the frontend submits them asynchronously. Swift and some Rust paths use this; the C++ frontend (Clang) historically used a serial codegen pipeline but has incrementally parallelized it.

**Salsa parallel queries**: as mentioned in §18.1, Salsa 2.0+ evaluates independent queries concurrently. For rust-analyzer this means autocomplete, diagnostic computation, and hover-info can run in parallel across files without manual thread management.

The architectural lesson: parallel compilation is more effective when the IR boundary is clean — a codegen unit, a query, a module — than when parallelism is injected into a sequential pipeline. Early design choices that expose independent sub-compilations pay off dramatically when multicore scaling becomes a priority.

Sources: https://rustc-dev-guide.rust-lang.org/backend/codegen.html and https://github.com/salsa-rs/salsa

### 18.3. Unison — Content-Addressed Code and Distributed Computation

Paul Chiusano's **Unison** takes a design axis the rest of this document doesn't touch: **code identity by content hash, not by name**. Every term, type, and dependency is identified by a hash of its syntax tree; names are a bidirectional `name ↔ hash` metadata mapping. The codebase is a SQLite-backed database of hashed nodes; text-form source exists only transiently via "scratch files" rendered from the database.

The compiler-pass consequences:

- **No build step.** Definitions are stored compiled by hash; adding a definition to the database *is* the build.
- **Result caching by expression hash.** Pure expressions are cached keyed by expression-tree hash; a watched expression recomputes only when its hash changes. The effect system prevents I/O in watch positions, so caching is safe.
- **Distributed computation for free.** Shipping a computation means shipping the bytecode tree; the receiver requests missing dependencies by hash and runs locally. The Unison **Remote** ability exposes this directly.

This makes Unison the **inverse** of the rest of this chapter: query-based compilation (§18.1) caches compiled outputs by input hash but keeps source name-addressed; Unison makes content-addressing the *primary* code identity, and builds/caches/distribution fall out as corollaries. The module-system and ecosystem implications — non-breaking renames, dependency-conflict elimination by construction, code-hosting that understands content-addressed code, and the broader axis of identity-by-name vs identity-by-hash — live in `PACKAGING.md §3`.

For a new language, partial content-addressing (hashing compiled artifacts by IR content, caching expression results by hash) captures much of the value with lower ecosystem cost than full Unison-style replacement of text source.

Sources: https://www.unison-lang.org/docs/the-big-idea/ and https://softwaremill.com/trying-out-unison-part-1-code-as-hashes/

### 18.4. TypeScript — Project References and Incremental Build Info

TypeScript's incremental story differs from rustc/Salsa (§18.1) in important architectural ways. Where Salsa is a generic memoizing query framework retrofitted onto rust-analyzer, TypeScript ships **two complementary mechanisms** baked into the compiler itself.

**Project references** (TypeScript 3.0, 2018) split a large codebase into independently-buildable sub-projects via `tsconfig.json`'s `references` field. Each sub-project produces declaration files (`.d.ts`) plus a build-info file (`.tsbuildinfo`) that records its declarations' hashes. Downstream sub-projects depend only on the *published declarations* of upstream projects, not on their source — so editing an implementation file inside a leaf project does not invalidate sibling projects whose interfaces are unchanged. `tsc --build` (and `tsc -b`) walks the reference graph, rebuilds only out-of-date projects, and reuses the cached `.tsbuildinfo` for the rest.

**`--incremental`** (TypeScript 3.4, 2019) operates within a single project: the compiler emits a `.tsbuildinfo` recording per-file hashes, dependency edges (which file imports which), and which files contributed to which output. On the next build, files whose hashes haven't changed are skipped, and reverse-dependency walking determines the minimal set to recheck. This is closer to traditional makefile-style incremental compilation than to Salsa's demand-driven memoisation.

The combination is unusually effective for monorepo-scale TypeScript: a multi-MLOC codebase split into hundreds of project-referenced sub-projects, each with `--incremental` enabled, recompiles a single-file edit in well under a second on warm cache. Distinct from Salsa (§18.1) and rust-analyzer's query graph: TypeScript's mechanism is *file-granularity*, not symbol-granularity, so a one-character edit to a hot import-graph file still invalidates the file. Distinct from Bazel/Buck build-graph caching (`PACKAGING.md §4.5`): project references operate inside the language compiler and use language-level interface stability, not build-system-level content hashing of intermediate outputs.

The lesson is that **a language compiler can layer two incremental mechanisms — one for cross-project boundaries (interface-driven), one for intra-project files (hash-driven)** — without committing to a generalised query framework. For language designers, project references demonstrate that "publish typed interfaces as a stable boundary" is a viable architecture without going as far as Rust's separately-compiled crate model or OCaml's `.mli` discipline.

Sources: https://www.typescriptlang.org/docs/handbook/project-references.html and https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-0.html and https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html

### 18.5. Incremental Computing by Differential Execution

Kumar, Pacak, and Erdweg's **Incremental Computing by Differential Execution** (ECOOP 2025) studies automatic incrementalization by executing *differences* when inputs change. Rather than recomputing a function from scratch or relying only on memoized subcalls, differential execution supplies rules for how an execution should be updated given an input delta.

The compiler/tooling relevance is the granularity: the changed artifact is not necessarily a file, module, or query key, but a structured value with an edit. Differential execution can exploit the shape of the edit — insertion, deletion, replacement, field update — and propagate only the semantic consequences. This connects to language-server incrementality, live programming, build systems, and long-lived reactive computations where the program repeatedly answers nearly-identical questions.

The design lesson: **incrementality can be expressed as a semantics of change**, not only as cache invalidation. Query systems (§18.1) ask “which cached results are stale?”; differential execution asks “what is the output delta induced by this input delta?”

Sources: https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2025.20 and https://www.pl.informatik.uni-mainz.de/files/2025/04/autoinc-diff-exec.pdf

---

## 19. Type-System Outputs and Compiler Consequences

Full type-system and semantic-analysis details are in `TYPES.md`; this section focuses on what the compiler consumes after semantic analysis. The compiler cares less about the declarative typing rules themselves and more about the artifacts they leave behind: typed syntax, elaborated core terms, dictionaries or witnesses, effect evidence, specialization decisions, type-directed layout facts, and constraints that affect lowering.

### 19.1. Typed Elaboration as a Compiler Boundary

Many modern frontends elaborate rich surface syntax into a smaller typed core before optimization. This boundary can make later compiler passes simpler: overloads are resolved, implicit arguments are inserted, associated types are normalized where possible, coercions are explicit, pattern refinements are recorded, and typed holes or unresolved obligations have already become diagnostics rather than optimizer concerns.

Compiler consequence: preserve enough type metadata to lower correctly, but avoid forcing every backend pass to understand the full source type system. A typed HIR/THIR-like layer can act as the bridge between `TYPES.md` concerns and MIR/SSA/codegen concerns.

### 19.2. Evidence, Dictionary, and Witness Passing

Type classes, traits, protocols, capabilities, and effect systems often elaborate implicit source facts into explicit compiler values: dictionaries, witnesses, vtables, capability tokens, or effect-handler evidence. Haskell-style dictionary passing turns class constraints into extra parameters; Rust-style monomorphization often resolves trait calls statically; Swift-style generics can pass value-witness and protocol-witness tables for separately compiled generic code.

Compiler consequence: evidence passing creates real calling-convention, inlining, specialization, and ABI choices. Once evidence is explicit in IR, ordinary optimization can inline through it, remove unused fields, specialize hot instantiations, or preserve it across dynamic boundaries.

Sources: https://www.cs.tufts.edu/~nr/cs257/archive/philip-wadler/ad-hoc-polymorphism.pdf and https://download.swift.org/docs/assets/generics.pdf

### 19.3. Effect Handler Lowering

Algebraic effects and typed capabilities are type-system topics (see `TYPES.md §11` for effect-system semantics), but their implementation is a compiler/runtime topic. Efficient effect-handler implementations avoid naive full continuation capture when possible. Koka-style generalized evidence passing threads handler evidence through calls; OCaml 5 exposes effect handlers through runtime-supported continuations and stack switching (see `CONCURRENCY.md §5.5` for the runtime continuation/stack-switching machinery).

Compiler consequence: the chosen effect representation affects call ABI, tail calls, stack maps, async lowering, optimization barriers, and interaction with memory management. If effects are statically typed, the compiler can often erase or specialize effect evidence; if effects are dynamically handled, the runtime must carry enough state to find handlers and resume continuations.

Sources: https://xnning.github.io/papers/multip.pdf and https://ocaml.org/manual/5.2/effects.html

### 19.4. Constraint Results as Optimization Inputs

Constraint solvers such as OutsideIn(X), trait solvers, and bidirectional elaborators belong canonically in `TYPES.md`, but their results inform compilation. Solved constraints may produce concrete types, selected implementations, normalized associated types, coercions, local equality assumptions, effect rows, lifetime/region facts, or proof terms.

Compiler consequence: later passes should consume solved facts in a stable representation rather than re-running source-level inference. For example, monomorphization needs selected generic arguments; pattern lowering may need GADT-refined inhabitance facts; borrow/drop elaboration may need region or ownership constraints; and debug metadata may need source-to-typed-core mappings.

Source: https://www.microsoft.com/en-us/research/publication/outsideinx-modular-type-inference-with-local-assumptions/

---

## 20. Regex Compilation

Regular expressions are one of the most widely-deployed forms of runtime compilation — a regex library compiles a pattern into a matcher on every call to `compile(pattern)`. Entries differ on *whether the pattern lowers to native code, a compact NFA/DFA interpreted at runtime, or a hybrid tiered pipeline*, and on the linked correctness question of backtracking vs linear-time guarantees. PCRE-JIT compiles patterns straight to native via hand-written per-architecture assembly templates and keeps PCRE's full backtracking semantics (fast common case, still exponential worst case); V8 irregexp tiers from bytecode to native and supplements this with a restricted non-backtracking fallback engine for eligible expressions; Cox's RE2 and Andrew Gallant's Rust `regex` deliberately reject JIT in favour of a Thompson NFA plus lazy DFA plus SIMD literal prefilters, guaranteeing O(nm); and Brzozowski derivatives (revived by Owens-Reppy-Turon) sidestep construction entirely by matching through incremental syntactic transformation.

### 20.1. PCRE-JIT

Zoltán Herczeg's **PCRE-JIT** (integrated into PCRE since 2011, now in PCRE2) compiles PCRE patterns directly to native machine code via a custom lightweight code generator. The JIT targets x86, x86-64, ARM, MIPS, PowerPC, and SPARC, without depending on LLVM or any heavyweight backend — the code emitter is ~30k lines of hand-written assembly templates.

The strategy is pattern-structural: each regex node (character class, quantifier, alternation, capture group) lowers to a sequence of native instructions that inline the matching logic. There's no interpreter loop, no bytecode dispatch — a compiled regex is a chunk of native code that runs against the input. Speedups over PCRE's bytecode interpreter are typically 4–15x on complex patterns.

The design trade-off: PCRE's semantics include backtracking features (backreferences, lookaround, possessive quantifiers) that preclude linear-time guarantees. PCRE-JIT inherits this — a pathological pattern on adversarial input can still exponentiate. The JIT makes matching fast on the common case, not safe on the worst case.

Source: https://www.pcre.org/current/doc/html/pcre2jit.html

### 20.2. V8 irregexp

V8's **irregexp** is the JavaScript regex engine, and since 2019 it uses a hybrid compilation strategy: patterns are first compiled to an intermediate bytecode interpreter, and hot patterns are then JIT-compiled to native code via V8's regex-specific compiler. Originally irregexp compiled directly to native, but V8 moved the default to interpreted bytecode for cold-start latency, with JIT as an optimization trigger.

V8's public regexp architecture remains centered on irregexp's own bytecode interpreter, tier-up to native code for hot patterns, and a separate non-backtracking fallback engine for eligible expressions. That fallback trades full JavaScript regexp generality for guaranteed linear behavior on patterns that avoid features such as backreferences and lookaround. This is not a general migration of regexp compilation to WebAssembly; it is a tiered regexp engine plus a restricted safe engine for ReDoS-sensitive cases.

Like PCRE, full JavaScript regex semantics include backtracking, so worst-case exponential time is possible for some patterns. V8 mitigates this for selected expressions by falling back to the non-backtracking engine when excessive backtracking is detected or when explicitly requested by flags.

Sources: https://v8.dev/blog/regexp-tier-up and https://v8.dev/blog/jsregexp

### 20.3. RE2 and Rust regex — Deliberately No JIT

Russ Cox's **RE2** (Google, 2010) and Rust's **regex** crate (Andrew Gallant) take the opposite position: *no backtracking, no JIT, linear-time guaranteed*. Patterns are compiled to an NFA (Thompson construction), which is either simulated directly or lazily subset-constructed into a DFA as matching proceeds.

The key correctness property is **O(nm)** worst-case time, where n is the input length and m is the pattern size. No pattern, however adversarial, can cause exponential blowup. This is the property PCRE and JavaScript regex sacrificed for expressiveness.

The implementation is remarkable because there's *no* code generation in the traditional sense — the "compiled regex" is a compact NFA data structure plus a small interpreter. Yet Rust's `regex` routinely outperforms PCRE on realistic workloads, because:
- SIMD literal prefilters scan the input for required substrings before entering the NFA at all
- The lazy DFA caches state transitions during matching, amortizing construction
- Pattern analysis selects between multiple matching strategies (literal, Aho-Corasick for alternation of literals, lazy DFA, NFA)

The principle: a careful interpreter with smart prefilters can match or beat a JIT for a restricted pattern language, while preserving linearity. The Rust `regex` crate is the canonical modern reference.

Sources: https://swtch.com/~rsc/regexp/regexp1.html and https://docs.rs/regex/latest/regex/

### 20.4. Regex Derivatives — Brzozowski Revisited

Brzozowski's **derivative of a regular expression** (1964) is a direct algorithm for regex matching: given regex `r` and first input character `c`, compute `D_c(r)` — the regex matching the rest of an input whose first character was `c`. Repeat for each character; if at the end the derivative accepts the empty string, the match succeeded.

Derivatives languished for decades because they generate exponentially many derivative expressions in the worst case. Owens, Reppy, and Turon ("Regular-expression derivatives reexamined", JFP 2009) showed that with **similarity-based canonicalization** (treating equivalent derivatives as equal via a cheap syntactic normal form), the number of distinct derivatives stays bounded — matching Brzozowski's original claim that derivatives would produce DFAs directly. The resulting DFAs are often smaller than those produced by Thompson→subset construction.

Derivatives are now used as a building block in more advanced regex systems: they extend cleanly to extended regexes (intersection, complement), to regex types (Hosoya-Pierce), and to parser combinators. They're also the technique of choice when correctness is paramount — "parsing with derivatives" (`PARSERS.md §2.10`) is the CFG analogue.

Source: https://www.ccs.neu.edu/home/turon/re-deriv.pdf

### 20.5. Cross-Reference — Ragel, Hyperscan, simdjson

Several lexer-generation tools cited in PARSERS.md also qualify as regex compilers:

- **Ragel** (`PARSERS.md §5.3`): compiles regex + actions into a native-code finite-state machine, used for HTTP parsing in Mongrel/Puma.
- **Hyperscan** (`PARSERS.md §5.5`): multi-pattern regex matcher using SIMD, deployed in Suricata and Snort for intrusion detection.
- **simdjson** / **simdcsv** (`PARSERS.md §2.14`): not regex engines, but demonstrate that SIMD-accelerated structural scanning outperforms regex-based approaches for structured formats.

The collective message: regex is the default text-processing tool, but for performance-critical specific-pattern tasks, specialized tools win. A language's regex library should be good enough for casual use (RE2-style guaranteed linearity is the modern baseline) while leaving room for specialized tools when the workload demands.

---

## 21. Database Query Compilation

SQL is the original domain-specific compilation target, and modern analytical databases invest heavily in compiling queries to efficient machine code — often at query arrival time, sometimes via LLVM. Entries differ on *whether the engine compiles each query to a fused loop at arrival time or executes via a vectorized batch interpreter*, and on where the latency/throughput trade lands for the workload. HyPer and its successor Umbra use Neumann's produce/consume model to fuse operator trees into one tight loop (Umbra replaces LLVM with a custom backend to cut compile time); Databricks Photon and DuckDB take the opposite position — vectorized interpretation with SIMD-friendly kernels and no JIT, DuckDB explicitly rejecting compilation because millisecond-scale interactive queries can't absorb 50 ms of codegen; Spark's Tungsten whole-stage codegen threads JVM bytecode through Janino and piggybacks on HotSpot; and Apache Arrow Gandiva treats LLVM-backed expression compilation as a reusable library with a keyed cache.

### 21.1. HyPer and Umbra — Produce/Consume Model

Thomas Neumann's **HyPer** (SIGMOD 2011, "Efficiently Compiling Efficient Query Plans for Modern Hardware") introduced the produce/consume model for SQL compilation. A query plan is a tree of operators (scan, filter, join, aggregate); instead of each operator iterating over tuples from below (the classical iterator model, "volcano style"), the compiler generates a single fused loop where each operator's `produce` method generates code that calls the parent's `consume` method.

The result is a query compiled to one tight loop over the input rows with no virtual dispatch, no per-tuple function calls, and no materialization of intermediate results. Performance gains are dramatic — 10x or more over iterator-model interpreters on analytical queries.

**Umbra** (Neumann et al., CIDR 2020) is HyPer's successor, incorporating lessons from a decade of production use. Key evolution: Umbra uses a custom low-level IR and a fast backend instead of LLVM, because LLVM compilation time became the bottleneck for short analytical queries. The tradeoff is 10–30% slower generated code for 5–10x faster compilation — the right choice when the query runs once and the plan is large.

Sources: https://15721.courses.cs.cmu.edu/spring2017/papers/03-compilation/p539-neumann.pdf and https://db.in.tum.de/~neumann/papers/umbra.pdf

### 21.2. Databricks Photon — Vectorized with Codegen

**Photon** (Databricks, SIGMOD 2022) is Apache Spark's native C++ execution engine, a full rewrite of Spark's SQL execution layer. Unlike HyPer's per-query codegen, Photon uses a **vectorized interpreter**: operations process batches of rows at a time with SIMD-friendly kernels, amortizing dispatch overhead across the batch.

The architectural choice is deliberate: vectorized interpretation reaches ~80% of the performance of fully compiled code while avoiding per-query compilation latency. For workloads that mix many short queries with a few long-running ones, vectorization is the better default. Photon supplements this with selective codegen for hot paths.

This illustrates a broader convergence: the best analytical query engines of 2024 are neither pure interpreters nor pure compilers, but vectorized engines with optional codegen. The dominant axis of optimization has become **batching + SIMD**, not instruction-per-tuple compilation.

Source: https://www.databricks.com/wp-content/uploads/2022/07/photon-sigmod22.pdf

### 21.3. Apache Spark Whole-Stage Codegen

Apache Spark's **Tungsten / Whole-Stage CodeGen** (introduced in Spark 2.0, 2016) generates JVM bytecode for SQL query operators fused into "stages" — maximal runs of pipelined operators without shuffle boundaries. Each stage becomes a Java class emitted at query planning time and loaded via the JVM's class loader; HotSpot then JITs it to native code.

The implementation leans on Janino, a lightweight Java compiler that produces bytecode in-process. Unlike HyPer's LLVM codegen, Spark's approach nests a managed runtime (JVM) inside a query engine — heavier but portable across every JVM platform.

The key engineering insight: by going through JVM bytecode, Spark gets HotSpot's full optimizer for free, at the cost of class loading overhead and GC pressure from transient generated classes. The design is a reasonable choice when the host platform is already the JVM and querying frequency is moderate.

Source: https://databricks.com/blog/2016/05/23/apache-spark-as-a-compiler-joining-a-billion-rows-per-second-on-a-laptop.html

### 21.4. DuckDB — Why It Doesn't JIT

**DuckDB** (Raasveldt & Mühleisen, CIDR 2020) is a notable outlier: a modern analytical database that explicitly rejects JIT compilation. Instead, DuckDB uses a vectorized interpreter with tightly-tuned SIMD kernels, similar to Photon's approach.

The authors' argument: JIT compilation latency is lethal for interactive analytics where queries run in milliseconds; a 50ms compile time means 50ms of user-observed wait even if the query itself runs in 5ms. Vectorized interpretation reaches competitive throughput without any compilation phase at all.

DuckDB's position is a useful counterexample to the "compile everything" orthodoxy. When query latency matters more than throughput, and when the query plan space is small enough to pre-tune kernels, interpretation beats JIT. The design choice depends on workload.

Sources: https://duckdb.org/why_duckdb.html and https://www.cidrdb.org/cidr2020/papers/p22-raasveldt-cidr20.pdf

### 21.5. Apache Arrow Gandiva

**Gandiva** (Dremio, 2018) is an LLVM-based expression compiler for Apache Arrow. Given an expression tree (e.g., a WHERE clause or projection expression), Gandiva generates LLVM IR that operates directly on Arrow's columnar memory layout, compiles via LLVM, and caches the resulting native code keyed by expression signature.

The architecture is a pure compile-time-expression library, not a full query engine — Gandiva handles expressions, not joins or aggregations. This narrow scope keeps it simple enough to embed in any Arrow-consuming system (Dremio, Python's PyArrow, Apache Drill). Compilation is cached, so recurring expressions (typical in production workloads) pay the compile cost once.

The Gandiva design pattern — "LLVM-backed expression compilation as a library" — is broadly useful. Any system that repeatedly evaluates data-dependent expressions can benefit from pre-compilation plus caching, whether it's a query engine, a streaming filter, or a rule-based alerting system.

Sources: https://arrow.apache.org/docs/cpp/gandiva.html and https://www.dremio.com/blog/introducing-gandiva-initiative-for-apache-arrow/

### 21.6. Differential Dataflow + Materialize — IVM as a Distinct Compilation Paradigm

Frank McSherry's **differential dataflow** (Naiad project, MSR Cambridge 2013–2015; productionised at **Materialize**, 2019+) compiles SQL into a fundamentally different runtime artifact from HyPer / Photon / DuckDB / Spark: the query plan becomes a **graph of differential operators**, each operator transforming *changes* (deltas) rather than full result sets, and the overall pipeline maintains its output as an **incrementally-updated materialised view** that is always current with the input data. This is **incremental view maintenance (IVM)** as a first-class compilation target rather than as a feature retrofitted onto a batch engine.

The mechanical core: every relation has a *timestamp* (a partial order, supporting both wall-clock time and logical iteration counts for fixed-point queries), every record carries a *multiplicity* (positive for insertions, negative for deletions), and operators (`map`, `filter`, `join`, `reduce`, `iterate`) are defined to consume and produce difference streams while preserving the invariant that integrating the difference stream over time yields the correct snapshot. The compiler turns an SQL query into a fixed dataflow graph; the runtime feeds input changes through the graph, and the materialised output is always consistent with the inputs.

Distinct from streaming SQL engines that re-evaluate over windows (Flink, Kafka Streams, ksqlDB): Materialize produces *strict serialisability* — every input change is reflected in every materialised view atomically — at sub-millisecond latency, with no window-boundary effects. Distinct from batch SQL engines (HyPer §21.1, Photon §21.2, DuckDB §21.4): Materialize cannot accept arbitrary one-shot queries efficiently; its compilation target is *long-lived materialised views*, not single queries. The trade-off is sharp: low-latency continuous queries vs high-throughput one-shot analytics.

The compilation lesson generalises beyond SQL: **IVM is a distinct compilation paradigm**, not a feature. A query compiler targeting IVM produces a runtime data structure that maintains state incrementally; the operator algebra (delta-based, with timestamps and retractions) is designed for incremental composition rather than batch evaluation. For any language whose users want "this expression is always up to date as inputs change" (Excel-like reactive computation, real-time dashboards, live indices), IVM-as-compilation-target is more direct than batch + cache-invalidation.

Status (as of 2026-04): Materialize is in production for real-time dashboards, live anomaly detection, and operational analytics; competitors include **RisingWave** (similar IVM model), **Epsio** (IVM as a layer over PostgreSQL), and IVM features in PostgreSQL, ClickHouse, and Snowflake (more limited, view-maintenance-only). The **timely dataflow** runtime underneath Materialize is a separate research artifact also worth noting for its handling of fixed-point queries (recursive views) — a use case where batch SQL engines struggle.

Sources: https://materialize.com/ and https://materialize.com/blog/olvm/ and https://materializedview.io/p/everything-to-know-incremental-view-maintenance and https://github.com/TimelyDataflow/differential-dataflow

### 21.7. Velox — Vectorized Execution Engine as a Library

Pedreira et al.'s **Velox** (Meta, VLDB 2022; open source 2022+) is a composable C++ vectorized execution engine — distributed as a *library* rather than as a complete database — designed to be reused across multiple data-processing engines. Where DuckDB (§21.4) and Photon (§21.2) ship as full systems with their own SQL frontends, Velox is the *backend half*: a pluggable execution engine that other systems integrate. As of 2026-04 it powers **Spark Gluten** (Velox-accelerated Spark via the Apache Gluten project), **Presto/Prestissimo** (the Velox-based Presto worker), and several internal Meta data-processing systems.

The architectural pillars:

- **Vector primitives over Arrow-shaped columnar data** — every operator is a function over `RowVector`, `FlatVector`, `DictionaryVector`, `ConstantVector`, `LazyVector` types. The same vector representations Apache Arrow defines, so Velox interoperates trivially with the broader Arrow ecosystem.
- **Adaptive optimisation at runtime** — Velox specialises operator implementations based on observed data: if a column proves nullable-but-rarely-null, its kernel switches to a fast-path that handles nulls via branch prediction; if a join key proves to have low cardinality, the hash table morphs into a dictionary lookup. This adaptivity replaces some of the planner-time decisions HyPer (§21.1) compiles into the query plan.
- **First-class support for complex types** — nested structs, lists, maps, and decimals get full vectorized treatment, where many SQL engines fall back to row-by-row processing for non-scalar columns.
- **Separable from any one query language** — Velox accepts plans expressed in its own internal IR, and existing engines (Presto SQL, Spark SQL, Substrait) compile their query plans *to* that IR. This is why Velox is a "unified execution engine" — Meta runs multiple data-processing systems against the same execution backend.

Distinct from DuckDB's choice (§21.4) to reject JIT compilation entirely: Velox uses a *combination* of vectorized interpretation and selective LLVM codegen depending on the operator. Distinct from differential dataflow + Materialize (§21.6): Velox targets one-shot query execution, not incrementally maintained materialised views. Distinct from Apache Arrow Gandiva (§21.5): Gandiva is a per-expression LLVM JIT library; Velox is the entire post-plan execution engine including operators, scheduling, memory management, and I/O.

The lesson generalises: **a column-vectorized engine designed as a library, not a system, can amortise across multiple frontends** — the same execution-engine design pattern that LLVM established for compiler backends, applied to query execution. The cost is that Velox cannot make end-to-end planning decisions (it sees the plan after the frontend's planner is done); the benefit is that one execution-engine investment serves many SQL dialects and several distributed-execution architectures.

Sources: https://github.com/facebookincubator/velox and https://research.facebook.com/publications/velox-metas-unified-execution-engine/ and https://velox-lib.io/ and https://engineering.fb.com/2023/03/09/open-source/velox-open-source-execution-engine/

---

## 22. BPF and eBPF JIT

The Linux kernel runs the most widely-deployed production JIT on earth — verifier-first restricted bytecode plus per-architecture in-kernel native compilation — and the design is the blueprint for letting untrusted users load code into a kernel safely.

### 22.1. The BPF Verifier and In-Kernel JIT

An eBPF program is submitted as bytecode from userspace via a `bpf()` syscall. Before execution, the kernel runs a **verifier** that performs extensive static analysis: bounded execution (no unbounded loops), memory safety (all loads/stores must be provably in-bounds), no pointer leaks to userspace, no accessing uninitialized memory. Programs that fail verification are rejected.

Only verified programs reach the **JIT**, which compiles BPF bytecode to native instructions on every major architecture (x86-64, ARM64, RISC-V, PPC, s390). The JIT is per-architecture hand-written, living in the kernel tree under `arch/*/net/bpf_jit*.c`. Compilation is single-pass and fast — tens of microseconds for typical programs.

The design is a specific answer to a hard problem: how do you let untrusted users load code into the kernel safely? The answer is *restrict the language severely* (no function pointers, no recursion, bounded stack, typed pointers) so that a lightweight verifier can prove safety, then JIT to native without further checks. The verifier does the hard work; the JIT is straightforward.

BPF's reach is extraordinary. Every packet filter (tcpdump, Cilium, Cloudflare), every kernel tracing tool (bcc, bpftrace, covered in `TRACERS.md §1.3` and `§1.7`), and every XDP-based high-performance networking path goes through this pipeline. The combination of verified restricted bytecode + per-architecture JIT is the blueprint for safe in-kernel code execution.

BPF is the canonical model for kernel-resident or sandboxed execution: verifier-first restricted bytecode plus per-architecture in-kernel JIT. Even outside that target, the design illustrates how much can be achieved with a verifier-first approach to safety.

Sources: https://docs.kernel.org/bpf/ and https://www.kernel.org/doc/html/latest/bpf/verifier.html

### 22.2. Move Bytecode Verifier — Linear-Resource-Discipline at the Trust Boundary

The same verifier-first design that BPF (§22.1) deploys at the OS kernel boundary appears at the smart-contract trust boundary in **Move** (Aptos/Sui). Every Move bytecode module submitted to a Move VM (Aptos blockchain, Sui blockchain, or off-chain executor) passes through a **mandatory bytecode verifier** before any execution. The verifier statically enforces:

- **Linear resource discipline**: types declared with the `key`/`store` abilities (resources, see `TYPES.md §12.5`) cannot be silently dropped or duplicated; every code path must explicitly destroy, store, or transfer them.
- **Type safety**: every operand must have the type the opcode expects, including across module boundaries; no implicit coercions.
- **Reference safety**: borrowed references cannot escape their scope; mutable and immutable borrows of the same object cannot overlap (Rust-borrow-checker-class invariants enforced at the bytecode layer).
- **Bounded execution**: structural limits on stack depth, function nesting, and instruction count.
- **Module visibility and access**: cross-module calls respect declared `public`/`friend` visibility; cross-module storage accesses respect ability constraints.

Like BPF, Move's verifier accepts *only* programs it can prove safe; rejected modules cannot run at all. Unlike BPF, the safety property being enforced is not "doesn't crash the kernel" but "doesn't violate the linear-resource invariants the asset model depends on." The two are structurally similar: a small, mandatory static analysis at the trust boundary substitutes for runtime checks throughout the program.

The lesson generalises: **a verifier-restricted bytecode is the natural compilation target for any language whose programs run in untrusted contexts**. BPF deploys this for kernel modules; Move deploys it for blockchain smart contracts; WASI/Component Model (`MODULES.md §11.2`) deploys it for sandboxed Wasm. For language designers building compilers that target sandbox-class execution environments (WebAssembly with capability discipline, embedded scripting languages with restricted authority, plug-in systems for other applications), the verifier-restricted bytecode pattern is the structurally cleanest answer.

Sources: https://aptos.dev/network/blockchain/move and https://move-language.github.io/move/ and https://hackenproof.com/blog/for-hackers/move-smart-contract-security-guide-part-1

---

## 23. Hot Code Swap and Dynamic Loading

Runtime compilation integration includes not just "compile and run" but "replace running code without stopping the process." Entries differ on *where the code/state boundary is drawn*: Erlang BEAM cleaves at the module level with at-most-two-versions-in-flight semantics that work because Erlang processes share nothing; Julia's Revise.jl exploits the first-class method table to swap methods under a running JIT; Common Lisp's image-based redefinition treats the live environment itself as the program, with interactive `defun` propagating through CLOS dispatch; .NET Edit-and-Continue and the JVM HotSwap equivalent replace method bodies via debugger-facing APIs (`ICorProfilerInfo::SetILFunctionBody`, JVMTI) under tight constraints (Debug builds, no signature changes); and the C/C++ `dlopen` live-reload pattern (Casey Muratori's Handmade Hero being the canonical demonstration) draws the boundary by hand, keeping mutable state in the host and hot-swappable code in a shared library. The shared lesson is that any live-reload discipline requires a clean split between replaceable code and surviving state, whether the language enforces the split or the programmer does.

> The *module-system* angle — what the language commits to (flat vs hierarchical module identity, individually loadable artifacts, fully-qualified-call vs local-call distinctions) so that runtime swap is even possible — is covered in `MODULES.md §10`. Erlang's hot-reload story in particular is enabled by language-design choices made decades ago at the module-system layer.

### 23.1. Erlang/BEAM — Hot Module Reload

Erlang's **BEAM** virtual machine supports hot module reload natively: a running system can load a new version of a module while existing processes continue executing the old version. The VM keeps two versions of each module active simultaneously (old and current). Existing process calls to the old version complete naturally; fully-qualified calls (`Module:Func(...)`) always dispatch to the current version, enabling gradual migration.

When a third version is loaded, BEAM kills any remaining processes still executing the now-two-versions-old code, then promotes current→old and loads new→current. This cap of "at most two versions in flight" is what makes the semantics tractable.

Hot swap is core to Erlang's positioning as a language for 99.999% uptime systems — telecom switches, messaging backbones. The key enabler is Erlang's pure-functional, share-nothing process model: processes don't share state, so replacing a module's code doesn't invalidate references held by other processes. The language design and the runtime feature are co-designed.

Source: https://www.erlang.org/doc/system/code_loading.html

### 23.2. Julia Revise.jl

Julia's **Revise.jl** (Tim Holy) is a library, not a language feature, that provides hot code update during interactive development. When source files change on disk, Revise re-parses, incrementally updates the method table (adding new methods, replacing edited ones), and invalidates compilation caches for affected methods. The next call to a changed method triggers recompilation.

The trick that makes this work is Julia's method table being a first-class runtime object — methods are values that can be added, removed, or replaced. Combined with Julia's JIT, this means the running program always executes whatever the latest source says, without a restart.

Revise is the central tool of Julia's interactive development workflow: open a REPL, edit code, see changes immediately. The analogous design in Common Lisp (§23.3) is the ancestor; Julia proves the pattern works in a modern language with aggressive compilation.

Source: https://timholy.github.io/Revise.jl/stable/

### 23.3. Common Lisp — Incremental Redefinition

Common Lisp treats the live image as the primary development environment: every function, class, method, and variable can be redefined at runtime. `(defun foo () ...)` evaluated interactively replaces the existing `foo`; future calls see the new definition. Method dispatch tables (CLOS) propagate changes automatically; global variable rebinding takes effect immediately.

The SLIME / SLY IDE environments build on this to provide "compile-defun" and "compile-file" commands that update the running image incrementally. Combined with the condition/restart system (`DEBUGGERS.md §3.5`), the workflow is: run code → hit an error → the debugger pops up → edit the offending function → restart the frame → continue.

This development style — sometimes called "image-based" or "residential" — is philosophically distinct from edit-compile-run. The whole system is always live; code changes are made *to* the running system rather than to a file that will later be recompiled. Smalltalk pushed this idea further (`DEBUGGERS.md §3.4`), but Common Lisp established the compiled, static-type-free version that most modern interactive languages inherit.

Source: http://www.lispworks.com/documentation/HyperSpec/Body/26_glo_r.htm

### 23.4. .NET Edit-and-Continue

.NET's **Edit-and-Continue (EnC)** is Visual Studio's feature that lets a developer modify source code while a paused debug session is active and continue execution with the new code applied. The CLR's Profiling API exposes `ICorProfilerInfo::SetILFunctionBody`, allowing the debugger to replace method IL at the bytecode level mid-execution.

The implementation constraints are substantial: EnC only works in Debug builds (so optimization can't have inlined or eliminated the target method), only certain categories of edits are supported (method body changes yes, signature changes no), and the new IL must be re-JIT-compiled before the next call. Despite these limits, EnC remains one of the most-used Visual Studio features for iterative debugging.

The analog in Java is **HotSwap** via the JVMTI (JVM Tool Interface): debuggers can replace method bodies in a running JVM, subject to similar constraints. IntelliJ IDEA uses this for its "Reload Changed Classes" feature.

Source: https://learn.microsoft.com/en-us/visualstudio/debugger/edit-and-continue

### 23.5. C dlopen and Live Reload Patterns

C and C++ build hot reload via **dlopen** / **LoadLibrary**: compile to a shared library, call functions through pointers, and swap in a new `.so` / `.dll` by reloading and redirecting the pointers. The game-development community popularized the discipline: keep mutable state in host-owned structures, put only stateless logic in the reloadable module, re-bind pointers after each reload. Casey Muratori's Handmade Hero is the canonical live-coding demonstration.

The general principle: live reload requires a clean boundary between *code* (replaceable) and *state* (must survive). Languages designed for hot swap (Erlang, Lisp, Julia) put the boundary at the module level; C-family programmers draw it by hand.

Sources: https://handmadehero.org/ and https://hero.handmade.network/episode/code/day022

---

## 24. WebAssembly Compilation Techniques

WebAssembly's binary format was designed from the start for fast compilation — structured control flow, stack-discipline validation, and section ordering that enables streaming. The entries below differ on *which part of the fast-startup story they target*: streaming and lazy compilation parallelize work with network download and defer uncalled functions, while Virgil's in-place interpreter avoids the rewrite step entirely by reusing a validation-generated sidetable to execute the original bytes. Both exploit properties that are baked into Wasm's format rather than layered on top.

### 24.1. Streaming & Lazy Compilation

WebAssembly's binary format was designed from the ground up for fast compilation. Several techniques exploit this:

- **Streaming compilation**: V8's `WebAssembly.compileStreaming()` begins compiling WebAssembly functions as bytes arrive over the network, before the entire module is downloaded. The binary format places function bodies after the type and import sections, so the compiler knows all signatures before it encounters any function body. This enables compilation to proceed in parallel with download.
- **Lazy compilation**: V8 does not compile all functions eagerly. Instead, functions are compiled on first call by the baseline compiler (Liftoff). This avoids compiling functions that are never called — common in large modules that export many unused functions.
- **One-pass validation and compilation**: WebAssembly's structured control flow (no arbitrary `goto`) and stack machine design enable single-pass validation. The validator maintains a type stack and checks each instruction in sequence — O(n) time, O(1) state per instruction. Liftoff exploits this by compiling during the same single pass: each WebAssembly instruction is immediately translated to machine code.
- **Lazy validation** (proposed, V8; Status as of 2026-04): defer function body validation until the function is first called. Combined with lazy compilation, this means the engine pays no compile-time or validation cost for unused functions.

The design lesson: if a language's binary format is designed for streaming, single-pass compilation, the cold-start latency can be dramatically reduced. WebAssembly's structured control flow is the key enabler — it sacrifices `goto` but gains compilability. For a language targeting both native and Wasm compilation, this trade-off is worth understanding.

Source: https://v8.dev/docs/wasm-compilation-pipeline

### 24.2. Virgil's In-Place Wasm Interpreter — Sidetable from Validation

Standard Wasm interpreters come in two flavors: **rewriting interpreters** that translate Wasm bytecode to an internal format (faster dispatch, slower startup, more memory) or **JITs** that compile to machine code (fastest steady-state, even slower startup). There was no third option for fast startup without rewriting — until Titzer's 2022 PLDI paper on the **wizard** engine used by Virgil (see §13.6 for Virgil's compiler side).

The technique:

- Wasm validation already walks every instruction, tracking a type stack and verifying structured control flow. This walk produces enough information to execute the bytecode correctly — if you save it.
- Save it as a **compact sidetable**: a small auxiliary structure indexed by instruction offset, storing per-instruction metadata (operand stack depth, branch targets, block types). The sidetable is generated as a side-effect of validation, with no extra pass.
- At interpretation time, the interpreter reads the original Wasm bytes and consults the sidetable at each instruction for the context needed to execute. No rewriting, no internal format, just original bytes + sidetable.

Results reported in the paper: order-of-magnitude improvements in memory consumption and processing time over rewriting Wasm interpreters, with dispatch performance comparable to well-tuned rewriting interpreters. The paper's framing: "This restores the missing execution tier for Wasm."

Why this matters beyond Virgil: the design pattern — *compact sidetable generated as a by-product of validation, enabling in-place interpretation of the original bytes* — is broadly applicable. Any bytecode format whose validation produces enough structural information can use this technique to avoid the rewriting step. The relevant design question for a bytecode format is whether its validator can emit a sidetable, because that unlocks a fast-startup interpretation tier without the memory cost of internal-format conversion.

Source: https://www.cs.tufts.edu/~nr/cs257/archive/ben-titzer/wasm-interp.pdf

---

## 25. Verified Compilers

Formal verification of compilers is a distinct research thread: proving mechanically that the compiled code implements the source program's semantics, not just testing on benchmarks. Entries differ on *where the verification stops and whether the guarantee is once-and-done or per-run*: CompCert's Coq proof chain covers a C compiler down to assembly (validated empirically when CSmith found zero middle-end miscompilations); CakeML extends the chain all the way to machine code and closes the trusting-trust loop by compiling itself from its own verified source; Vellvm formalizes LLVM IR semantics in Coq and verifies individual passes (mem2reg, SROA, parts of GVN) against that spec rather than building a new compiler; and translation validation (Pnueli-Siegel-Singerman, Alive2, Crellvm) gives up whole-compiler verification in exchange for per-compilation equivalence certificates produced by SMT — a more scalable trade that has already found dozens of real LLVM bugs.

### 25.1. CompCert — The Verified Optimizing C Compiler

Xavier Leroy's **CompCert** (started 2006, first paper POPL 2006; commercially available) is a C compiler whose correctness is proven in Coq. The chain of proofs shows that for every well-defined C program, the generated PowerPC, x86, ARM, or RISC-V assembly preserves the source's observable behavior. Optimizations (constant propagation, CSE, register allocation, function inlining) are each verified against a formal semantics of the intermediate language.

The practical outcome: CompCert-compiled code has been shown in independent evaluation (CSmith fuzzing by Regehr et al.) to have *zero* middle-end miscompilation bugs — while every other evaluated C compiler (GCC, Clang, commercial) had many. Airbus uses CompCert for safety-critical avionics code; the proof discharges entire categories of certification requirements.

The cost is performance: CompCert-compiled code runs ~15–20% slower than GCC -O2, because many aggressive but unverified optimizations are omitted. For safety-critical systems where verification is mandatory, this is an acceptable trade; for general use it usually isn't.

Sources: https://compcert.org/ and https://xavierleroy.org/publi/compcert-CACM.pdf

### 25.2. CakeML — Verified from Source to Machine Code

**CakeML** (Kumar, Myreen, Norrish, Owens, POPL 2014) is a verified implementation of a subset of Standard ML, differing from CompCert in two ways: (1) the proof extends all the way down to machine code — CompCert stops at assembly language — and (2) the entire compiler is verified in HOL4, with a bootstrapping story that produces a self-hosted verified compiler binary.

The bootstrapping trick is striking: the CakeML compiler is itself written in CakeML, and the verified compiler has compiled itself from source. This closes the loop of trusting-trust concerns within the formal system — the produced binary is provably faithful to the source, including the code of the compiler itself.

CakeML targets ML-family languages (garbage-collected, higher-order), not C. The performance gap versus production ML compilers (MLton, OCaml) is larger than CompCert's gap versus GCC, but the research is aimed at pushing the verification frontier, not matching production speeds.

Source: https://cakeml.org/

### 25.3. Vellvm — Verified LLVM IR Semantics

**Vellvm** (Zhao, Zdancewic, et al., POPL 2012) takes a different tack: rather than building a new verified compiler, formalize the semantics of LLVM IR in Coq, then verify individual LLVM optimizations against that semantics. The goal is retrofitting formal correctness onto an existing production compiler, one pass at a time.

Vellvm has verified mem2reg, SROA, and parts of GVN. The resulting "verified" versions can be swapped into LLVM and produce the same output as the originals on proven-correct inputs, with a formal guarantee that the optimization preserves semantics.

The project's practical value is as a reference semantics: having a machine-checked spec of what LLVM IR means is useful even if only portions of the optimizer are verified. It is the model for how verification might incrementally infiltrate industrial compilers.

Source: https://www.seas.upenn.edu/~jianzhou/Vellvm.pdf

### 25.4. Translation Validation

A pragmatic alternative to whole-compiler verification: rather than prove the compiler correct, check *each compilation run* for correctness. **Translation validation** (Pnueli, Siegel, Singerman 1998) compares source and target after compilation, producing a proof certificate for that specific run.

Modern translation validation tools:
- **Alive2** (Lopes et al., PLDI 2021) verifies LLVM IR optimizations by encoding source and optimized versions as SMT queries and checking for equivalence. Alive2 has found dozens of real bugs in LLVM optimizations.
- **Crellvm** (Kang et al., 2018) did similar work earlier, focused on proving optimizations correct per-compilation.

Translation validation is more scalable than full verification — it doesn't require a mechanized proof of every transformation — at the cost of being per-run rather than once-and-done. For most practical scenarios this is the right trade.

Source: https://web.ist.utl.pt/nuno.lopes/pubs/alive2-pldi21.pdf

---

## 26. Profile-Guided and Post-Link Optimization

Some of the biggest real-world compiler wins come *after* initial compilation: using runtime profile data to re-optimize, or rewriting final binaries based on observed behavior. Entries differ on *how the profile is collected and at what point in the toolchain it is consumed*: classical instrumentation-based PGO (GCC `-fprofile-generate`/`-fprofile-use`, Clang `-fprofile-instr-generate`) inserts counters during an initial compile and requires two builds plus a representative workload run; Google's AutoFDO replaces the instrumentation phase with hardware sampling (`perf` samples mapped back to source lines via DWARF), closing the loop directly against production binaries; Facebook's BOLT rewrites the already-linked ELF binary for better code layout using sample profiles, finding 5–15% on top of `-O3 + LTO + PGO`; and Google's Propeller moves the same class of layout optimizations into the link step, producing relinkable object files that integrate more cleanly with existing build systems.

### 26.1. Instrumentation-Based PGO

Classical **Profile-Guided Optimization** instruments the program during an initial compilation — inserting counters on every branch and function entry — runs it on representative workloads to collect a profile, then recompiles with the profile as input. The optimizer uses the profile to guide inlining (prefer hot callees), layout (pack hot paths into instruction cache), and branch prediction (arrange `if` sides to minimize mispredictions).

The reported gains are substantial: 10–20% speedup over `-O3` is typical for C/C++ workloads, occasionally 30%+ for branchy code. GCC's `-fprofile-generate` / `-fprofile-use` and Clang's `-fprofile-instr-generate` / `-fprofile-instr-use` are the standard toolchains.

The friction is operational: the workflow requires two builds, a profiling run, and correct handling of the profile file. Many projects skip PGO not because it doesn't work but because the build pipeline becomes more complex. Making PGO easy to run is a sometimes-overlooked design goal for a new language's toolchain.

Source: https://clang.llvm.org/docs/UsersManual.html#profile-guided-optimization

### 26.2. AutoFDO — Sampling-Based Profiles

Google's **AutoFDO** (Chen, Li, Hundt, CGO 2016) eliminates the instrumentation phase by using **sampling profiles** collected from production binaries via `perf` (hardware performance counters). A production binary running on real workloads produces samples; the compiler converts these to a synthetic profile and uses them in re-compilation just like instrumented PGO data.

The key trick is *source line mapping*: samples are collected against machine addresses, and AutoFDO maps them back to source lines via DWARF debug info. The compiler then attributes the samples to IR instructions during the next build.

AutoFDO is the default PGO mechanism at Google; production binaries routinely ship with AutoFDO-optimized builds, refreshed from the prior day's sample data. This closes the loop without requiring developers to set up explicit profiling runs.

Source: https://research.google/pubs/pub45290/

### 26.3. BOLT — Post-Link Binary Optimizer

**BOLT** (Panchenko et al., CGO 2019) is a *post-link* optimizer from Facebook: it takes a compiled ELF binary plus a perf sample profile, and rewrites the binary's layout for better cache behavior. No recompilation required; BOLT operates on the already-linked executable.

BOLT's main optimizations are code layout: reordering basic blocks within functions so hot paths fall through, reordering functions so hot ones cluster in the same pages, and outlining cold code. Reported gains on Facebook's HHVM and Clang itself are 5–15% over `-O3` + LTO + PGO — on top of everything the compiler already did.

BOLT's significance is not just the gains but the location of the optimization. After the linker has produced the final binary, BOLT still finds substantial wins, implying that even state-of-the-art compiler pipelines leave performance on the table. The architecture of the compiler pipeline — many separate passes, each with incomplete global view — is the reason BOLT can improve things.

Source: https://research.facebook.com/publications/bolt-a-practical-binary-optimizer-for-data-centers-and-beyond/

### 26.4. Propeller — Fine-Grained Code Layout

Google's **Propeller** (2021) is BOLT's successor in the post-link layout-optimization space. The twist: rather than rewriting the final binary (BOLT's approach, which is hard to run in production because the binary changes between the profile run and the optimized build), Propeller produces *relinkable* object files. The optimizer runs during the link step, using profile data to guide block placement and function ordering.

The architectural advantage: Propeller's output is a standard relinked binary, easier to integrate with existing build systems. The performance gains are comparable to BOLT — 3–7% typical — with lower operational overhead.

The message for language tooling: layout optimization is valuable enough to be built into the linker. Designing an object-file format and linker that expose block-granularity layout control from the start is cheaper than retrofitting it later.

Source: https://storage.googleapis.com/pub-tools-public-publication-data/pdf/d753cb3608d6a8e8d71cf2b98a4deab80ec37d77.pdf

---

## 27. LTO and Modern Linkers

Link-time optimization and linker design are often treated as backend concerns, but both directly affect compile latency and code quality. Entries differ along *how cross-module information flows at link time and how parallelizable the resulting work is*: Full LTO merges all bitcode into one module for maximum cross-module inlining at the cost of a serial O(program-size) bottleneck, ThinLTO decouples "decide what to inline" from "apply the optimization" to parallelize the latter across translation units, and modern linkers (lld, mold, wild) attack throughput by aggressive symbol-resolution parallelism and incremental in-place relinks. Each picks a different point on the compile-quality / link-latency / memory-footprint triangle.

### 27.1. Full LTO and ThinLTO

**Link-time optimization (LTO)** defers part of compilation until link time, when the whole program (or module set) is available. The canonical wins are cross-module inlining, whole-program dead-code elimination, and devirtualization across translation unit boundaries.

**Full LTO** (GCC's `-flto`, Clang's `-flto=full`) merges all LLVM IR bitcode from every translation unit into one giant module, then runs the full optimizer on it. Maximum code quality; minimal scalability — the link step becomes an O(program size) serial bottleneck, often adding minutes to link times on large projects.

**ThinLTO** (Tobias Grosser, Teresa Johnson et al., 2016) is Clang's scalable alternative. Each translation unit emits bitcode with a summary of what's exported, imported, and called. The linker reads all summaries, builds a call graph, decides per-function what to inline across modules, and *then* parallelizes the actual optimization across the translation units. Link time approaches that of non-LTO builds while retaining most of Full LTO's benefits.

ThinLTO's key design insight: cross-module information flow at link time doesn't require serial processing, if you separate "decide what to do" from "do it" and parallelize the second phase. Every serious C/C++ codebase at scale uses ThinLTO today; Full LTO is reserved for small, performance-critical components.

Source: https://clang.llvm.org/docs/ThinLTO.html

### 27.2. mold, wild, lld — Modern Linkers

Linker throughput has become a first-class concern as C++ codebases grow. Three modern contenders:

- **lld** (LLVM's linker, Rui Ueyama): 5–10x faster than GNU `ld.bfd` on large binaries, through aggressive parallelism and avoiding unnecessary I/O. Default linker in many LLVM-based toolchains since the mid-2010s.
- **mold** (also Rui Ueyama, 2020): 2–4x faster than lld in many cases, primarily through more aggressive parallelism in symbol resolution and relocation processing. Mold pioneered techniques like parallel input-file parsing and lock-free output section packing.
- **wild** (David Lattimore, 2024): an incremental linker written in Rust, focused on the "relink after small change" case. Wild remembers prior link structure and patches the output file in place rather than regenerating it. Status (as of 2026-04): targets <100ms relinks on medium binaries.

The collective progress is dramatic: linking a large C++ project has gone from a 30-second bottleneck to a sub-second one within 10 years. The trade-off for a new language is between targeting the legacy linker (broader compatibility, slower link) and targeting mold or wild (faster link, narrower platform coverage); designing object files to suit modern linker algorithms keeps the option open.

Sources: https://github.com/rui314/mold and https://github.com/davidlattimore/wild and https://lld.llvm.org/

---

## 28. Bootstrapping

How does a language compile itself? Getting from "no compiler exists" to "the language compiles itself" is a recurring design problem for new languages, and the chain of compilers used to build the chain is itself a security and reproducibility surface. Entries differ along *what trust dependency the bootstrap chain carries and how auditable it is*: Thompson's "Reflections on Trusting Trust" frames the threat model, mrustc breaks Rust's self-hosting cycle with an alternate C++ implementation so the full rustc binary can be rebuilt without any prior rustc, and GNU Mes plus stage0 trace every build dependency back to a 357-byte hex seed so the entire system is reconstructible from auditable source. A complementary tradition — Forth metacompilation (§33.10) — focuses less on trust and more on shrinking retargetable compilers into very small code budgets while still self-hosting.

### 28.1. Reflections on Trusting Trust

Ken Thompson's Turing Award lecture ("Reflections on Trusting Trust", 1984) showed that a self-hosting compiler can contain a Trojan that reproduces itself into future versions of the compiler, with no trace in source code. The classic attack: modify the compiler to insert a backdoor into `login`, and *also* insert code that re-inserts the modification when compiling itself. Once the modified compiler exists, the source can be clean — but every future build is compromised.

The lesson isn't just security-theoretic; it illustrates why bootstrapping chains matter. A language's trust chain reaches back to whatever compiler was used to bootstrap the first version, which was compiled by yet another tool, and so on. "Source available" doesn't imply "verifiable" unless the whole chain is reproducible.

Source: https://www.cs.cmu.edu/~rdriley/487/papers/Thompson_1984_ReflectionsonTrustingTrust.pdf

### 28.2. mrustc — Rust from C++

**mrustc** is an alternative Rust compiler written in C++ that compiles Rust source to C source. It exists specifically to break Rust's bootstrap chain: once mrustc compiles `rustc` version N from Rust source, that `rustc` can compile any later Rust version, avoiding the "rustc-compiled-by-rustc-compiled-by-rustc" transitive dependency on all prior rustc binaries.

mrustc does not implement borrow checking or many modern Rust features — it only needs to compile enough Rust to build rustc. This pragmatic scope keeps mrustc tractable (tens of thousands of lines of C++ vs rustc's millions) while closing the bootstrap loop.

The pattern generalizes: any self-hosted language can benefit from a stripped-down "stage-0" compiler in a different language, specifically to audit or reproduce the build chain without dependence on a pre-existing binary.

Source: https://github.com/thepowersgang/mrustc

### 28.3. GNU Mes / stage0 / Full-Source Bootstrapping

The **Bootstrappable Builds** project traces every build dependency back to a small, auditable seed. The canonical chain: **stage0** is a 357-byte binary (called `hex0`) that reads hex source code. stage0 builds up, step by step, to a C compiler (Mescc → tinycc → GCC), from which the rest of a system can be built.

**GNU Mes** implements the upper layers: a tiny Scheme interpreter that compiles to a tinycc-precursor, which compiles a full tinycc, which compiles GCC. The total trust surface is the 357-byte hex0 binary plus source for everything else — auditable by humans, not dependent on any binary blob.

The principle applies beyond security: for any language with an evolving self-hosting compiler, having a low-dependency bootstrap path (even if slow) is insurance against losing the ability to rebuild from source if the compiled-compiler chain breaks.

Sources: https://bootstrappable.org/ and https://www.gnu.org/software/mes/

---

## 29. ABI and Calling Conventions

Code generation has to produce something that interoperates with the rest of the system — OS kernel, libraries, debuggers. This boundary is the ABI, and every language runtime targeting a mainstream platform inherits concrete decisions about argument-passing registers, callee-save sets, name mangling, object-file layout, and thread-local storage from it. Entries below span the three dominant calling conventions (System V AMD64, Windows x64, AAPCS), name-mangling schemes that encode overloading and generics into linker symbols (Itanium C++ ABI, Rust v0), the object-file formats that carry compiled code across tools (ELF, Mach-O, COFF/PE), and the four TLS models that trade access speed against dynamic-loading flexibility.

### 29.1. System V AMD64, Windows x64, AAPCS

The three dominant calling conventions differ in detail but share structure:

- **System V AMD64 ABI** (Linux, macOS, BSD on x86-64): first six integer arguments in `rdi, rsi, rdx, rcx, r8, r9`; first eight float arguments in `xmm0-7`; return in `rax` / `rdx` (or `xmm0`); callee-saved `rbx, rbp, r12-r15`.
- **Windows x64**: first four arguments (any type) in `rcx, rdx, r8, r9`; return in `rax`; callee-saved includes the high xmm registers. Shadow space (32 bytes) reserved on stack by caller.
- **AAPCS** (ARM): similar shape, with `r0-r3` or `x0-x7` for arguments and `r0` / `x0` for return.

The differences matter for FFI: a function compiled for one ABI cannot be called via the other. Cross-compiling or targeting multiple platforms requires the backend to emit the correct convention per target.

A language's own functions don't need to follow any specific ABI internally — many compilers use a custom, more efficient convention for intra-module calls (more argument registers, no callee-save bloat, register-based tail calls). But the boundary to `extern "C"` must respect the platform ABI exactly.

Sources: https://gitlab.com/x86-psABIs/x86-64-ABI and https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention

### 29.2. Name Mangling

C++ overloading, templates, and namespaces produce multiple functions with the same source name; **name mangling** encodes the full signature into a unique linker symbol. The Itanium C++ ABI's mangling scheme (used by GCC, Clang, and every Unix C++) produces symbols like `_ZN9Namespace8functionEi` for `Namespace::function(int)`.

Rust's mangling (RFC 2603, `v0` scheme) is similar in purpose: encodes the crate, module path, type parameters, and hashes. Swift mangles differently again, capturing Swift-specific constructs (protocols, generics with constraints).

A mangling scheme is required whenever the language supports any of: overloading, generics, namespaces, nested types. Whatever scheme is chosen must be:
- **Unambiguous**: no two distinct source entities produce the same mangled name.
- **Reversible** (demangleable): debuggers need to reconstruct source names from symbols.
- **Stable**: mangled names in public libraries must not change across compiler versions without careful ABI versioning.

Sources: https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling and https://rust-lang.github.io/rfcs/2603-symbol-name-mangling-v0.html

### 29.3. Object File Formats

Three dominant formats carry compiled code:

- **ELF** (Linux, BSD, Solaris): sections for text, data, BSS, debug info, symbol tables, relocations. Extended by DWARF for debug info, by `.note.*` sections for metadata.
- **Mach-O** (macOS, iOS): similar concepts, different encoding. Adds fat binaries (multiple architectures in one file), code signing sections.
- **COFF / PE** (Windows): sections, import/export tables, resource directories.

Most compilers target LLVM (and inherit LLVM's object file support) or emit directly through an assembler. Going direct-to-object-file is only worth it for specialized runtimes (BPF JIT, custom VMs) or to avoid LLVM's compile latency.

### 29.4. Thread-Local Storage Models

Thread-local variables require ABI support. The dominant models:

- **Local-exec**: TLS variable offset known at link time relative to the thread's TLS block. Fastest access but requires linker cooperation; only works for executables, not shared libraries.
- **Initial-exec**: offset resolved at program start via the dynamic linker. Fast access (one indirection) but only works if the library is present at program start.
- **General-dynamic**: offset resolved on each access via `__tls_get_addr`. Slowest but most flexible; works for libraries loaded via `dlopen`.
- **Local-dynamic**: like general-dynamic but amortizes the lookup across multiple accesses in the same function.

The compiler must choose a model per TLS access based on visibility and module kind. Many languages just expose "thread-local" and let the backend pick; a few (C++ with `thread_local`, Rust with `#[thread_local]`) give users manual control.

Source: https://www.akkadia.org/drepper/tls.pdf

### 29.5. Project Panama / Foreign Function & Memory API — Managed-Runtime FFI Without C Glue

The Java equivalent of native interop has historically been **JNI**: write a `native` method declaration in Java, write a hand-rolled C/C++ glue function with the `JNIEXPORT JNICALL` calling convention, compile it into a shared library, and load the library at runtime. JNI is verbose, requires a separate build pipeline for the C side, mishandles memory by default (every off-heap pointer is a `jlong` that the caller must validate), and forces the JVM into an opaque-call mode that disables many optimizations. **Project Panama** (OpenJDK, since ~2014) and its first finalized deliverable, the **Foreign Function & Memory (FFM) API** (JEP 454, finalized in **JDK 22, March 2024**), replace this entire stack.

The mechanical pieces:

- **`MemorySegment`** — a typed view over a contiguous off-heap memory region. Distinct from `ByteBuffer` (now considered legacy): `MemorySegment` carries a *spatial bound* (the segment's length) and a *temporal bound* (its `Arena` lifetime), so out-of-bounds and use-after-free are detected at runtime rather than producing UB.
- **`Arena`** — the lifetime owner. `Arena.ofConfined()` is single-thread, deterministic-cleanup; `Arena.ofShared()` is multi-thread; `Arena.ofAuto()` defers cleanup to the GC; `Arena.global()` is the never-freed root. Closing an arena invalidates every segment derived from it, and subsequent access throws — Rust-borrow-checker-class spatial+temporal safety expressed as a runtime contract.
- **`Linker`** — `Linker.nativeLinker()` returns the platform-specific linker; `linker.downcallHandle(symbolAddress, FunctionDescriptor)` produces a `MethodHandle` that invokes the native function directly with no intermediate C glue. The downcall handle is JIT-compileable and inlinable in HotSpot.
- **`FunctionDescriptor`** — the Java-side declaration of a native function's calling convention via `ValueLayout` constants (`JAVA_LONG`, `JAVA_INT`, `ADDRESS`, etc.).
- **`SymbolLookup`** — locates symbols in shared libraries; `linker.defaultLookup()` exposes the standard C library.
- **`jextract`** — command-line tool that reads C header files and emits Java source binding the declared functions, types, and constants. Eliminates the manual `FunctionDescriptor` writing for libraries with stable headers.

Distinct from `MEMORY.md §10.2` CHERI C/C++ programming model (also discusses pointer provenance) — Panama operates *inside* a managed-runtime where the JVM remains the source of truth for object lifetimes, while CHERI hardware-enforces capabilities for the unmanaged C/C++ language. Distinct from the calling conventions in §29.1 — Panama uses those conventions on the platform side but exposes them through Java method handles rather than C function pointers. Distinct from .NET P/Invoke (the analogous CLR mechanism) — Panama is more memory-discipline-explicit (Arena + MemorySegment) where P/Invoke leans on `IntPtr` + manual `Marshal` calls.

Status (as of 2026-04): production in JDK 22+. **JEP 472** ("Prepare to Restrict the Use of JNI") signals JNI is being deprecated in favour of FFM — applications calling `native` methods will increasingly require `--enable-native-access=ALL-UNNAMED` or per-module declarations, surfacing as a warning today and an error later. Major libraries (Lucene, Netty, Apache Arrow Java, several JDBC drivers) have begun migrating to FFM for new-codepath native calls.

The **Vector API** (JEP 426, separate Panama deliverable) is the sibling — managed-runtime SIMD intrinsics with cross-platform abstraction. Together with FFM, the two close the gap between Java and C-level performance for native interop and SIMD-heavy code without the JNI / hand-written-intrinsic cost.

The lesson generalises: **a managed-runtime language can adopt a borrow-checker-class temporal+spatial discipline for native memory** (via Arena-bounded MemorySegments) without forcing that discipline on its own GC'd heap. The FFM API is the cleanest production example of a hybrid model — GC for managed objects, explicit-arena ownership for foreign memory — and the design pattern transfers directly to other managed runtimes (CLR, BEAM, V8) considering FFI redesigns.

Sources: https://openjdk.org/jeps/454 and https://openjdk.org/projects/panama/ and https://docs.oracle.com/en/java/javase/25/core/foreign-function-and-memory-api.html

---

## 30. .NET ReadyToRun and AOT+JIT Hybrids

Pure AOT and pure JIT are extremes, each sacrificing something valuable — AOT gives up profile-driven runtime specialization, JIT pays compile latency on every first call. Entries below stake out the productive middle by *shipping pre-compiled native code alongside the IL, so the runtime can skip JIT for already-compiled methods but still re-optimize them later from profile data*. .NET's ReadyToRun format with CrossGen2 is the production example; HotSpot's removed `jaotc` is a cautionary example; GraalVM Native Image goes further and gives up the JIT fallback entirely for smaller binaries and faster startup. Each picks a different answer to "what runtime flexibility do you trade away for startup latency?"

### 30.1. .NET ReadyToRun (R2R)

**ReadyToRun** (introduced .NET Core 3.0, 2019) is .NET's hybrid format: assemblies contain both IL (the traditional JIT input) and pre-compiled native code for the target architecture. At runtime, the CLR uses the native code directly, skipping JIT for methods that are already compiled. The IL stays available so *methods can still be re-JITed* when tiered compilation or profile-guided re-optimization decides to.

The motivation is startup latency: pure JIT pays a compile cost on every first call; pure AOT produces large binaries and misses runtime specialization opportunities. R2R's native code is typically less optimized than what the JIT would eventually produce (the AOT doesn't have the JIT's profile data), but it's available immediately.

**CrossGen2** is the AOT compiler that produces R2R images. It runs on any platform and targets any .NET runtime architecture, replacing the earlier CrossGen with a rewritten pipeline based on RyuJIT's infrastructure. CrossGen2 enables cross-compilation — building Windows ARM64 R2R binaries on a Linux x86-64 build machine.

R2R is the production default for most .NET framework assemblies. Application developers opt in via `<PublishReadyToRun>true</PublishReadyToRun>`. The measured effect: ~2-3x startup speedup for CLI tools and ASP.NET services, with minimal steady-state performance difference versus pure JIT.

Source: https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/readytorun-format.md

### 30.2. HotSpot `jaotc` — Deprecated AOT Experiment

Status (JDK 9 through JDK 16/17-era cleanup): experimental in JDK 9; removed from the main JDK in the JDK 16/17-era cleanup. HotSpot's `jaotc`, based on Graal, could precompile Java classes into a shared library that the JVM loaded at startup, reducing some first-use JIT latency while retaining the ordinary JVM runtime. The idea matched the same hybrid pattern as ReadyToRun: use AOT code as a startup accelerator, then let the managed runtime remain in charge.

The experiment did not become the mainstream Java deployment path, while GraalVM continued outside the main JDK. The lesson is that an AOT+JIT hybrid must justify its maintenance cost against simpler levers: class-data sharing, faster tiered JITs, profile-guided warmup, and full native-image deployment.

### 30.2b. Project Leyden — AOT Caching with Full JIT Fallback

**Project Leyden** (OpenJDK, since 2020 with deliveries beginning JDK 25, 2025) is the second OpenJDK attempt at AOT-and-JIT coexistence after `jaotc`. The architectural difference: Leyden's primary deliverable is **AOT caching** (per-method ahead-of-time compiled code stored in a per-application cache that the JVM consults on startup) rather than full ahead-of-time native images. The cache is generated from a "training run" — an instrumented run of the application that records which methods are hot, profile data, and observed types — and the JVM's HotSpot JIT remains the runtime authority for re-compilation, deoptimisation, and tier-up. AOT cache hits replace first-call JIT compilation; misses fall through to ordinary tiered compilation.

The mechanical pieces are:
- **AppCDS extension**: the existing Class Data Sharing format gains AOT-compiled-method slots, so the same archive that loads classes also primes the JIT cache.
- **Profile-data reuse**: training-run profiles persist into the cache so AOT-compiled methods can be re-JITed with profile feedback even on first run.
- **`jcmd`-driven training** plus build-time training tools (Maven/Gradle plugins, Spring Boot integration via `spring-boot-maven-plugin process-aot`) produce the cache as a build artifact rather than a per-deployment training step.

Status (as of 2026-04): JDK 25 (LTS, October 2025) shipped Leyden's first wave (`-XX:CacheDataStore=` plus AOT-class-loading). JDK 26 adds AOT-cache support for ZGC (`MEMORY.md §6.4`). Spring Boot 4 integrated Leyden alongside its existing GraalVM Native Image support, giving deployers a choice between fast-startup-with-full-dynamism (Leyden) and faster-startup-with-closed-world (Native Image §30.3). Reported speedups on Spring Boot startup: 2–3× cold-start improvement without the closed-world reflection-modelling cost of GraalVM.

The lesson generalises: **AOT caching with full JIT fallback is a less radical bet than closed-world native images, and may suit more workloads**. Where R2R (§30.1) is .NET's similar hybrid and GraalVM Native Image (§30.3) gives up dynamism entirely, Leyden picks a middle point — AOT only what training data justifies, fall back to JIT for everything else, preserve all runtime dynamism (reflection, dynamic class loading, agents, redefinition).

Sources: https://openjdk.org/projects/leyden/ and https://developer.ibm.com/articles/java-project-leyden/ and https://softwaremill.com/project-leyden-and-jdk-26-bringing-aot-caching-to-zgc/ and https://quarkus.io/blog/leyden-2/

### 30.2c. Project CRaC — Coordinated Restore at Checkpoint

**Project CRaC** (OpenJDK, Anton Kozlov / Azul, since 2021) is the third OpenJDK answer to JVM startup latency, complementing Leyden (§30.2b, AOT cache) and GraalVM Native Image (§30.3, closed-world AOT). Its mechanism is fundamentally different from both: rather than compiling code ahead of time, CRaC **snapshots a fully warmed-up JVM** — post-JIT, post-class-load, post-cache-warm — and restores from the snapshot on subsequent starts.

The mechanical core uses **CRIU** underneath on Linux (covered from the debugger angle in `DEBUGGERS.md §2.7`) but adds a coordination layer the generic CRIU lacks. Java applications hold open file descriptors, network connections, JDBC pools, and other live resources that cannot survive arbitrary process snapshotting. CRaC introduces the **`org.crac` API** with two callbacks per registered resource:

- **`beforeCheckpoint(Context)`** — close files, flush buffers, drop sockets, release pool connections, persist in-memory state. Called in registration order.
- **`afterRestore(Context)`** — reopen files, reconnect sockets, rebuild pools, rehydrate state. Called in *reverse* registration order — so an init sequence and its teardown are mirror-symmetric.

A `jcmd JDK.checkpoint` command (or the in-process `Core.checkpointRestore()`) initiates a snapshot. The JVM walks all registered resources, invokes their `beforeCheckpoint`, then hands control to CRIU which writes the process image to disk. Restoration is the reverse: CRIU restores the process image, the JVM invokes `afterRestore` in reverse order, and the application resumes with all JIT-compiled code, class metadata, and warm caches intact — typical Spring Boot / Quarkus / Micronaut applications report 1–3 second cold starts dropping to **tens of milliseconds**.

Distinct from Leyden (§30.2b): Leyden caches AOT-compiled code, CRaC caches the *entire JVM state* (heap, threads, JIT'd code, pools). Distinct from Native Image (§30.3): CRaC preserves all dynamism (reflection, dynamic class loading, agents, JFR) because the running JVM is unchanged — Native Image gives those up. Distinct from generic CRIU (`DEBUGGERS.md §2.7`): CRaC supports **multiple restores from a single checkpoint** (the design point that distinguishes it as a *deployment* tool rather than a debug tool), because the application coordinates resource state through the API.

The key constraint: **at checkpoint time, no open file handles or network connections are allowed** — every external resource must be releasable. This is restrictive but tractable for most service applications: Spring Boot 3+, Micronaut 4+, and Quarkus 2.10+ ship CRaC integration in their HikariCP / Redis / JDBC / Tomcat / Jetty / Netty integrations, so application authors mostly inherit checkpoint-correctness from framework integrations.

Status (as of 2026-04): Linux-only (x64 + ARM64) for actual checkpoint creation; Windows / macOS support a "simulation engine" for development. Available in **Azul Zulu Builds of OpenJDK** (JDK 17, 21, 25). Production deployments include AWS Lambda Java cold-start optimisation, Cloudflare Workers Java integration, and several FaaS platforms. The `--XX:CRaCCheckpointTo=` and `--XX:CRaCRestoreFrom=` JVM flags drive the lifecycle; runtime constraints (CPU count, memory) at restore should match checkpoint conditions for stability.

The lesson generalises beyond the JVM: **for any managed runtime serving short-lived workloads (FaaS, CLI tools, batch workers, ephemeral containers), a coordinated checkpoint/restore mechanism is a third lever alongside AOT compilation and lazy initialisation**. The coordination cost — explicit `beforeCheckpoint`/`afterRestore` discipline for resource-holding code — is the price for retaining all dynamism that AOT and closed-world approaches give up. CRIU's process-snapshot infrastructure is the OS-level enabler; CRaC is the language-runtime layer that makes it usable for production Java services.

Sources: https://openjdk.org/projects/crac/ and https://docs.azul.com/core/crac/crac-introduction and https://crac.org/ and https://azul.com/products/components/crac and https://github.com/openjdk/crac

### 30.3. GraalVM Native Image — Closed-World AOT

GraalVM Native Image takes the more radical trade: closed-world analysis at build time, whole-program AOT compilation, and a native executable with fast startup and low memory footprint. Unlike ReadyToRun, there is no ordinary JIT fallback for arbitrary methods at runtime. Reflection, dynamic class loading, proxies, serialization, and resource access must be declared or discovered during image building.

The benefit is excellent startup latency and deployment simplicity for CLIs, serverless functions, and microservices. The cost is reduced dynamism, longer builds, larger build-time memory use, and the need to model runtime reflection ahead of time. Native Image is the reminder that AOT is not just a backend decision: it shapes the semantics of reflection, loading, initialization, and dynamic code generation.

The design pattern — ship AOT code with IL fallback for re-optimization, or choose closed-world AOT and remove the fallback entirely — is a useful spectrum whenever startup matters. The trade-offs between these designs are the active frontier of managed-runtime compilation.

---

## 31. Case Study — ty (Astral)

A case study of what happens when a language's tooling is rebuilt from scratch around the incrementality primitives covered in §18 rather than retrofitted onto a legacy checker. This chapter focuses on Astral's ty — a Python type checker written in Rust atop Salsa — as a concrete datapoint on the cold-start and incremental performance tier that becomes reachable when query-based architecture, intersection types, and rustc-style diagnostics are designed in from day one. It is the closest thing in this document to a full-stack worked example of the techniques §18 covers abstractly.

### 31.1. Salsa-Based Incremental Type Checking

Status (as of 2026-04): ty (formerly "Red Knot") is Astral's Python type checker and language server, written in Rust. It type-checks the `home-assistant` project in 2.19 seconds — 8.9x faster than mypy (19.6s), 20.8x faster than Pyright (45.7s). In incremental mode (editing a file in the PyTorch repository), ty recomputes diagnostics in 4.7ms — 80x faster than Pyright.

The architecture is built on **Salsa** (the same incremental computation framework used by rust-analyzer, described in §18.1). Key design decisions:

- **Incremental from the ground up**: the entire type checker is structured as Salsa queries. Parsing, name resolution, type inference, and diagnostic emission are all memoized, demand-driven computations. When a file changes, only the queries that transitively depend on it are recomputed. This is what enables 4.7ms incremental updates on a multi-million-line codebase.
- **First-class intersection types**: unlike mypy and Pyright, ty supports intersection types natively. This enables more precise type narrowing — after `isinstance(x, A)` in a branch where `x: A | B`, ty narrows to exactly `A` rather than approximating. Intersection types also enable more accurate modeling of Python's runtime type system (multiple inheritance, protocol composition).
- **Advanced type narrowing and reachability analysis**: ty performs control-flow-sensitive type narrowing (including `hasattr` narrowing) and uses type information to detect unreachable code — going beyond what traditional type checkers infer.
- **Diagnostic system inspired by rustc**: ty produces multi-file, multi-span diagnostics that explain not just *what* is wrong but *why*, pulling context from declarations in other files. The diagnostic output is designed for both humans and AI agents.
- **Gradual typing with gradual guarantee**: ty avoids false positives on untyped code. Partially typed codebases receive appropriate treatment rather than a flood of errors — critical for adoption in existing projects.

ty demonstrates that combining Salsa-based incrementality with a Rust implementation creates a new performance tier for language tooling: cold-start performance that matches or exceeds cached performance of existing tools, and incremental performance that enables real-time editor feedback on the largest codebases.

Source: https://astral.sh/blog/ty

---

## 32. Factor — Self-Hosting Optimizing Compiler for a Stack Language

**Factor** is one of the best counterexamples to the idea that concatenative languages must choose between elegance and serious compilation. The compiler is written in Factor, lowers stack code into SSA-based IR, and then applies a very recognizable optimizing pipeline: type inference, sparse conditional constant propagation, generic-dispatch elimination, escape analysis, scalar replacement, value numbering, representation selection, instruction scheduling, and linear-scan register allocation.

What makes Factor especially worth adding here is that it shows how a compiler can start from a stack-effect language and still end up with a modern register-oriented optimizer without pretending the source language was expression-oriented all along. The **stack checker** is also part of the compiler story: abstract interpretation of stack effects is doing real frontend work, not just linting.

Factor demonstrates a self-hosting, strongly optimizing compiler with industrial architecture for a concatenative language — the cost is a niche ecosystem of little relevance to readers focused on conventional syntax.

Sources: https://factorcode.org/slava/dls.pdf and https://concatenative.org/wiki/view/Factor/Optimizing%20compiler

---

## 33. Fast Forth Implementation Spectrum

Forth needs a different comparison frame from most compiler literature. "Fastest Forth" can mean at least three different things:

1. **fastest threaded-code engine** (interpreter/VM core),
2. **fastest desktop native-code compiler**, or
3. **fastest tiny embedded native-code system**.

There is no universally accepted public benchmark suite that cleanly settles all three at once, so it is better to describe the design space than to crown a single winner. Sections §33.5–§33.8 are intentionally collapsed into §33.9 ("Secondary Forths and Community Datapoints"), which gathers the supporting design points and the practical bottom-line ranking in one place; the stub headings are retained only to preserve numbering.

### 33.1. Gforth — The Strong Conservative Pick for Fast Open Threaded Code

If the question is "what is the strongest open, portable, well-documented Forth implementation with a fast traditional engine?", **Gforth** is the obvious answer. The Gforth manual states that on RISC machines its engine is "very close to optimal" for threaded-code execution, and the system layers in **dynamic superinstructions** (see §1.7 for the mechanism) and later **stack caching** as the major performance levers.

Gforth matters beyond Forth because it is one of the cleanest long-running laboratories for VM implementation techniques: direct/indirect threading hybrids, superinstruction formation, stack caching, and careful benchmarking.

Gforth is the strongest documented open threaded engine — open source, ANS-oriented, and extremely instructive — but outrun by good commercial native-code Forths when absolute peak performance is the priority.

Sources: https://gforth.org/manual/Performance.html and https://www.complang.tuwien.ac.at/forth/gforth/Docs-html/Dynamic-Superinstructions.html

### 33.2. VFX Forth — The Strong Conservative Pick for Peak Desktop Performance

If the question is "which Forth is usually named when people want the *fastest desktop production compiler*?", the conservative answer is **VFX Forth**. MPE's own material claims it has long been the fastest Windows Forth, emphasizes **native code generation**, **aggressive stack-traffic optimization**, and **inlining**, and says the result gets within roughly 25% of hand-written assembler on their published examples.

This should be read as a **vendor claim**, not a neutral standards-body ranking, but it lines up with the reputation VFX has in practitioner discussions: if peak speed matters and commercial tooling is acceptable, VFX is usually in the first sentence.

Native code, a serious optimizer, and large-codebase credibility make VFX the usual top pick for "fastest serious desktop Forth," with the caveat that it is commercial/closed and much of the public benchmark evidence is uneven and vendor-hosted.

Sources: https://www.mpeforth.com/software/pc-systems/vfx-forth-common-features/ and https://vfxforth.com/

### 33.3. SwiftForth — Subroutine Threading with Direct Code Substitution

**SwiftForth** takes a more transparent path: it is a **subroutine-threaded** system that substitutes direct code where possible and supports inline expansion for words whose headers mark them as inlineable. This gives it a strong reputation as a very fast desktop Forth without requiring the full optimizer mystique of VFX.

The implementation angle is worth calling out because subroutine threading is often dismissed as "just compile calls," but SwiftForth shows how much mileage you can get once you combine that with direct substitution and selective inlining.

SwiftForth offers a clear execution model, fast in practice, commercially supported, and a good exemplar of subroutine-threaded design — with less published detail on deep optimizer internals than VFX or Gforth, and a commercial license.

Source: https://www.forth.com/swiftforth/

### 33.4. Mecrisp / Mecrisp-Stellaris — Tiny Embedded Native Code with Direct-to-Flash Compilation

For microcontrollers, **Mecrisp** and **Mecrisp-Stellaris** sit in a different league from desktop Forths. They compile **directly into flash**, perform **constant folding**, and in the newer RA compiler path add **automatic inlining** and even **register allocation for the data stack**. This is a notably elegant answer to embedded constraints: keep the environment interactive, but compile straight to native code in tiny memory budgets.

The design is especially original because it is not merely "a small Forth." It combines tiny-system practicality with real compiler behavior instead of falling back to a purely interpreted core.

**Mecrisp-Quintus** (Matthias Koch, with Krzysztof Klaus) is the RISC-V / MIPS sibling, and adds a distinctive twist: a loadable **"Acrobatics"** extension — an inlining + dual-stack register allocator *written in Forth itself*, loaded on top of the base RV32 native compiler. The compiler-as-loadable-Forth-program inverts the usual host/target relationship and is itself a piece of metacompilation (§33.10).

Mecrisp delivers an excellent embedded story — tiny footprint, native code, direct-to-flash workflow, and an unusually strong fit for MCU work — offset by architecture-specificity and little relevance to large desktop-hosted applications.

Sources: https://mecrisp.sourceforge.net/ and https://github.com/hansfbaier/mecrisp-quintus

### 33.5. zeptoforth — Native/Inlined Cortex-M Forth with an RTOS Mindset

(Subsumed in §33.9.)

### 33.6. iForth / tForth — Benchmark Culture and Parallel-Compiler Lineage

(Subsumed in §33.9.)

### 33.7. colorForth — Radical Source Representation and Tiny Compiler Path

(Subsumed in §33.9.)

### 33.8. Practical Bottom Line on "Fastest Forth"

(Subsumed in §33.9.)

### 33.9. Secondary Forths and Community Datapoints

A handful of secondary Forths fill out the design space without changing the headline picks. **zeptoforth** is a modern Cortex-M Forth that mixes subroutine threading, native code inlining, and a preemptively multitasking RTOS — interesting because most tiny Forths stay minimal, but zeptoforth leans toward "serious embedded application environment" while remaining performance-conscious. Marcel Hendrix's **iForth** preserves an unusually rich benchmark culture (matrix, LINPACK, FFT, nsieve) and inherits ideas from the parallel transputer compiler **tForth**. **colorForth** (Chuck Moore) is the most idiosyncratic line: a color-tagged source representation paired with a tiny subroutine-threaded compiler that inlines several primitive arithmetic operations — interesting because source notation, compiler size, and machine model are co-designed.

A defensible short ranking: fastest open threaded-code implementation is **Gforth / gforth-fast**; fastest desktop native-code implementation (conservative pick) is **VFX Forth**, with **SwiftForth** in the same discussion; most distinctive tiny embedded native-code systems are **Mecrisp-Stellaris / Mecrisp** (and zeptoforth for a richer MCU environment). Public benchmarking is thinner than in the C/C++/JVM/JS worlds, so reputations are strong but apples-to-apples comparisons are scarce. Community datapoints worth recording: a 1.4M-line Forth codebase moved onto VFX Forth reportedly ran ~10× faster than the earlier threaded-code build (HN anecdote, not benchmark science); commenters around SwiftForth's IDE release described Gforth as the free well-rounded choice while saying SwiftForth's optimized subroutine threading is materially faster.

Sources: https://hackaday.io/project/170826-zeptoforth and https://github.com/tabemann/zeptoforth/discussions/190 and https://iforth.nl/ and https://www.ultratechnology.com/color4th.html and https://www.forth.com/resources/forth-programming-language/ and https://news.ycombinator.com/item?id=44142652 and https://news.ycombinator.com/item?id=47045194 and https://news.ycombinator.com/item?id=22802449

### 33.10. Forth Metacompilation and Self-Hosting Cross-Compilation

Distinct from our §28 bootstrapping coverage is a pattern unique to the Forth tradition: **metacompilation**. A Forth system is bootstrapped in two phases. A "seed" metacompiler — typically written in a host language (C, Lisp) — first compiles a minimal Forth kernel with a handful of primitive CODE words. A *Forth-written* metacompiler then regenerates the full Forth system from source, including the metacompiler itself. After the second phase, the host-language seed is no longer needed.

**lbForth** (Lars Brinkhoff) is the canonical modern example. The bootstrap chain is:

1. **12 primitive C words** plus a small Lisp-written metacompiler (using SBCL, CLISP, CCL, or ECL) produce an initial Forth targeting C.
2. The resulting Forth runs a *Forth-written* metacompiler that regenerates the full system.
3. The same Forth metacompiler retargets to produce native kernels for Linux (x86), Windows, ARM, RISC-V, 68000, PDP-11, and asm.js, plus cross-compilers for 6502, 8051, AVR, Cortex-M, MSP430, PDP-8, PIC, and STM8.

All retargetability lives in a single architecture-specific file (`nucleus.fth`) plus an assembler written in Forth. Higher-level words live in portable `kernel.fth`. Adding a new architecture means writing one nucleus file and an assembler module — everything else is compiled from portable source.

**Gforth's cross-compiler** follows the same pattern but integrated into the Gforth build system. A machine-description file (`arch/<target>/machine.fs`) specifies the target's cell size, endianness, memory layout, and primitive implementations; the host Gforth runs `cross.fs` (regular Forth code, not a special tool) to produce a target image. The cross-compiler looks like Forth but runs in a mode where compiled code executes on the target, not the host.

Why this is distinct from §28's bootstrapping story: §28 focused on breaking the trust chain (mrustc, GNU Mes). Forth metacompilation is instead about **producing retargetable compilers in very small code budgets**. The same Forth kernel compiles to dozens of architectures from a handful of target-specific files, because the compiler itself is written in the language it compiles. The transferable pattern for multi-architecture embedded deployment is to keep target-specific code isolated to a small plug-in module, write the compiler in the source language, and bootstrap once per new target rather than reimplementing the compiler.

Sources: https://github.com/larsbrinkhoff/lbForth and https://gforth.org/manual/Cross-Compiler.html

### 33.11. Open Firmware / fcode and BootSafe — Forth as Privileged Boot Environment

IEEE 1275 Open Firmware (Sun OpenBoot, Apple PowerPC, OLPC XO, IBM POWER) ships an fcode interpreter that runs *before* the OS, with full machine access. The fcode evaluator can mutate the device tree, persist NVRAM scripts, and bypass typical OS controls — Mudge's Phrack 53 article ("FORTH Hacking on Sparc Hardware") and the SANS GIAC "OpenBoot Credentials Hack" paper document concrete bypasses against Solaris.

The only serious *formal* security work is Cornell's **BootSafe** (Hunt, Erlingsson, Kozen, ACSAC 2007): a Java-to-fcode certifying compiler plus an ECC-style fcode verifier that runs inside the Open Firmware kernel — a typed-assembly-language–style proof-carrying-fcode design enforcing memory safety on loaded option-ROM drivers. The verifier reconstructs typing for fcode tokens before the evaluator dispatches them, rejecting drivers that fail the proof. The design pattern — verifier-in-the-evaluator, tied to a certifying compiler — is the closest Forth-ecosystem analogue to the BPF verifier (§22.1) or to Wasm validation (§24.1), and is the rare instance of formal memory safety applied to a stack-language interpreter at the trust boundary between firmware and OS. BootSafe never shipped beyond research, and Open Firmware's broader trust surface (NVRAM scripts, password bypasses, full device-tree mutation from the `ok` prompt) limits what any in-evaluator verifier can deliver against a determined attacker.

Sources: https://www.cs.cornell.edu/~kozen/Papers/acsac.pdf and https://github.com/MitchBradley/openfirmware and https://www.giac.org/paper/gcih/182/

### 33.12. Static Stack-Effect Verification — Ertl 2021, StrongForth, typeforth

Three concrete static stack-effect checkers establish that compile-time stack discipline can be a *safety* mechanism, not just documentation. Anton Ertl's "Practical Considerations in a Static Stack Checker" (EuroForth 2021) introduces **anchors** — placeholder stack signatures for words with statically-unknown effects (`execute`, `r>`) — together with a single-pass control-flow-join algorithm. Anchors are what made stack checking practical: earlier checkers either rejected too many programs (no `execute`) or too few (no flow merge). **StrongForth** (Stephan Becher) goes further, providing full strong static type-checking with overloading by stack signature; the compile-time data-type heap shadows the runtime data stack. **typeforth** is a modern minimal implementation storing 16-bit type IDs in word flag cells, treating branching as checkpoint+merge of the typestack, with a `nocheck` escape hatch.

The theoretical anchor is Stoddart & Knaggs (1992) "Type Inference in Stack Based Languages" plus Pöial's EuroForth 1993 stack-effect inference algebra. The fully-realized production-language version is Factor (see §32); the Forth lineage above shows that the same discipline can be retrofitted onto an ANS Forth and used as an opt-in safety pass without redesigning the language — at the cost of fragile anchor signatures for `execute`-style words (which understate actual behavior to keep the checker tractable) and the usual opt-in gap, where unannotated code gets no guarantee.

Sources: https://repositum.tuwien.at/handle/20.500.12708/152198 and https://www.stephan-becher.de/strongforth/ and https://github.com/typeforth/typeforth

### 33.13. FreeForth — Compile-Time Register Renaming for Stack Operations

Christophe Lavarenne's **FreeForth** (and the maintained FreeForth2 by dan4thewin) is a subroutine-threaded i386 Forth with one genuinely novel codegen trick: the top two stack cells live in two registers, and `swap` is implemented by *renaming the registers at compile time* — no machine instructions emitted at all. Tail-call→jump conversion and pop-less conditional jumps follow the same renaming scheme, and there is no separate interpret mode (everything goes through compiled anonymous functions).

The pattern generalizes: when a stack machine's top-of-stack lives in registers, every primitive that swaps or rotates the top *N* items can be a compile-time renaming rather than an emit-store-emit-load sequence. For a small fixed *N* (typically 2 or 3), this collapses an entire class of stack-shuffling overhead. FreeForth is the cleanest existing example of the technique in a Forth, and it transfers directly to any other stack-VM frontend that pins TOS to registers — with the limitation that the technique only handles shuffles of a fixed small N (typically 2 or 3 regs), and procedure boundaries still pay normal stack save/restore cost.

Sources: http://christophe.lavarenne.free.fr/ff/ and https://github.com/dan4thewin/FreeForth2

### 33.14. mcp_forth — Embeddable Multi-Backend MCU Codegen

Liam Howatt's **mcp_forth** (2024) is an embeddable native-codegen Forth targeting x86-32, Xtensa (ESP32-S3), and a portable bytecode VM, designed to *self-compile inside* MCUs with 100 KB–10 MB RAM and to drive peripherals as small as 8 KB. The architecture is unusual because most embeddable language runtimes pick one of those points (interpreter on tiny MCUs, native codegen on large ones); mcp_forth covers the spectrum with a shared front-end and pluggable back-ends. The specific value for new-language design is the existence proof: "compile inside an ESP32-S3" is achievable with a small enough compiler core, even one that is not extracted from a larger toolchain. Sits next to Mecrisp (§33.4) and zeptoforth (§33.5) as a third design point in the embedded Forth space — multi-backend rather than single-target. The cost is the inverse of Mecrisp's: no single backend gets the depth of optimization a single-target Forth can deliver, and per-target maturity varies.

Source: https://github.com/liamHowatt/mcp_forth

---

## 34. Summary of Compiler Techniques

Rows are grouped by chapter and within a group roughly follow body order. The Examples column ends with `(§N.M)` anchors back into the chapter where the technique is described in detail. The space and time columns characterize the compiler-side cost of each technique, not the cost it imposes on emitted code.

| Technique | Space Cost | Time Cost | Key Trade-off | Examples |
|---|---|---|---|---|
| Copy-and-patch stencils | Stencil library (~MB) | memcpy + patch per instruction | Compilation speed vs code quality | CPython 3.13 JIT (§1.1) |
| Futamura projection | Interpreter + PE | JIT compilation cost | Compiler from interpreter for free | Truffle/Graal (§1.3) |
| Sea of Nodes IR | Graph structure | Enables global optimization | Complex to implement/debug | HotSpot C2, V8 TurboFan (§1.4) |
| E-graph optimization | Equivalence classes | Avoids phase-ordering | Memory for explored rewrites | Cranelift, egg (§1.4) |
| Nanopass framework | AST boilerplate | Fast single-task passes | Formal ILs per pass | Chez Scheme (§1.5) |
| Surgical monomorphization | Lambda set tags | Compile-time defunctionalization | Avoids code bloat | Roc (§1.6) |
| Dynamic superinstructions | On-the-fly code stitching | Eliminates dispatch overhead | Basic template copying | GForth (§1.7) |
| Register vs stack bytecode | Wider instructions | ~47% fewer ops executed | Dispatch overhead vs code size | Lua 5, Dalvik, V8 Ignition (§1.8) |
| Specializing adaptive interpreter | Per-site type counters | 10–60% speedup without JIT | Interpreter complexity | CPython 3.11+, Brunthaler quickening (§1.9) |
| Production Python JITs | Method JIT + inliner + type specialization | ~30–50% wins on Instagram-scale workloads | Large codebase + full-time team | Cinder/CinderX, Pyston, Pyjion (§1.10) |
| PHP 8 IR-based JIT | DynASM origin + standalone SSA IR framework | Mid-sized IR for sub-ms JIT budgets | Curated optimization set | PHP 8 IR (§1.11) |
| Type-annotation-driven gradual JIT | `--!native` + type-hint specialization | Bypasses speculation; production at billions/day | Wrong annotations = UB | Roblox Luau native (§1.12) |
| Whole-program Python AOT | LLVM via typed Python dialect | 10–100× speedups; standalone binary | Drops full-CPython compatibility | Codon (§1.13) |
| Decorator-driven Python LLVM JIT | `@jit` + llvmlite | Fast NumPy loops without full-language JIT | Object-mode fallback eliminates speedup | Numba (§1.14) |
| Arena allocation | One large region | ~2ns per allocation | No individual free | bumpalo, every compiler (§2.1) |
| String interning | Hash table + buffer | One hash per new string | O(1) equality after intern | rustc Symbol, V8 (§2.2) |
| Hash consing | Hash table + structure | One hash per construction | O(1) structural equality | BDDs, type representations (§2.2) |
| Struct-of-arrays | Parallel arrays | Better cache for columnar access | Worse for per-node access | Zig AST, ECS (§2.3) |
| Qualifiers in pointer bits | 0 extra bytes | Mask on access | Requires aligned allocation | Cuik, Clang (§2.4) |
| NaN boxing | 0 extra bytes | Mask/check on access | 48-bit pointer limit | SpiderMonkey, LuaJIT (§3.1) |
| Tagged pointers | 0 extra bytes | Mask on access | Reduced integer range | V8, OCaml, Ruby (§3.2) |
| Graph coloring regalloc | Interference graph | NP-complete (heuristic) | Best code, slow compilation | GCC IRA/LRA; classical Chaitin-style allocators (§4.1) |
| Linear scan regalloc | Live intervals | O(N log N) | 15–68x faster, slightly worse code | V8 Liftoff, HotSpot C1 (§4.2) |
| Bytecode-to-source side table | 2–10 bytes/entry | O(log N) lookup | Separate from code, optional | JVM, CPython, Lua (§5.1) |
| Compressed/delta line info | ~1 byte/line in compact cases | O(N) decode, O(log N) search | Compact but sequential decode | Lua Compact Debug (§5.1), DWARF (§5.2), source maps (§5.3) |
| CPS IR | Explicit continuations | All control flow explicit | Syntactic overhead | SML/NJ, Chez Scheme (§6.1) |
| ANF IR | Let-bound intermediates | Simpler than CPS, same power | Less expressive control | GHC Core, OCaml (§6.1) |
| MLIR multi-level IR | Dialect per abstraction | Progressive lowering, composable | Learning curve, framework weight | TensorFlow, Triton, IREE (§6.2) |
| Turboshaft linear IR | Flat op buffer + indices | 30–40% faster compile than SoN | Less global freedom than graph IRs | V8 Turboshaft (§6.3) |
| Multi-level IR pipeline | HIR/THIR/MIR stages | Per-phase optimality | Translation layer cost | rustc (§6.4) |
| Parametric MLIR dialect | Unresolved parameters in IR | Serializable pre-instantiation IR | Requires elaborator pass | Mojo KGEN + POP (§6.6) |
| Dual-backend shared IR | Single IR, multiple targets | Target-neutral IR, cached for incremental | Forces IR target-agnosticism | Ballerina BIR (JVM + LLVM) (§6.7) |
| Class-based AST as compiler frontend | Raku objects per node | Round-trip + user-level macros | Lowering still goes through QAST | RakuAST (§6.8) |
| Braun SSA construction | Block-local def maps | On-the-fly, no dominators | Extends to irreducible CFGs | Cranelift, Firm (§7.2) |
| Out-of-SSA parallel copies | Copy-insertion + seq | Correct swap resolution | Register pressure on cycles | Sreedhar, Boissinot (§7.3) |
| Global Value Numbering | Hash of canonicalized ops | 5–15% scalar speedup | Cross-block via φ handling | LLVM GVN (§8.1) |
| SCCP | Lattice + worklist | Finds constants conv. misses | Combines CP with dead-branch | Wegman-Zadeck (§8.2) |
| LICM | Dominator analysis | Major speedup on loops | Speculative exec correctness | Classical + LLVM (§8.3) |
| SROA | Breaks aggregates to scalars | Enables register-level opts | Requires alias-free local structs | LLVM SROA, mem2reg (§8.4) |
| PRE / Lazy Code Motion | Dataflow + placement | Generalizes CSE + LICM | Register pressure management | Morel-Renvoise, Knoop et al. (§8.5) |
| Tail call elimination | Jump reuse of frame | Constant-stack recursion | ABI and debug interop | LLVM musttail, WebAssembly (§8.6) |
| Loop auto-vectorization | Stride + alias analysis | 2–8x on SIMD-friendly loops | Cost model failures | LLVM LoopVectorize (§8.7) |
| SLP vectorization | Isomorphic op packing | Fills vector regs in straight code | Shuffle overhead risk | LLVM SLPVectorizer (§8.7) |
| Polly (polyhedral in LLVM) | ISL polyhedra | 2–10x on affine loops | Analysis restrictions | LLVM Polly (§8.8) |
| Superoptimization | Stochastic / SAT search | Best-known code fragments | Minutes to hours per sequence | STOKE, Souper, Denali (§8.9) |
| BURG tree tiling | Rule-based tree match | Linear-time selector | Tree-local only | iburg, small backends (§9.1) |
| BURS tiler + DynASM + linear IR | Tile-table lookup per node | Production BURS for dynamic JIT | Tile-DSL + Perl generator | MoarVM expression JIT (§9.1) |
| SelectionDAG / GlobalISel | DAG / CFG-level patterns | Handles multi-node idioms | DAG per block adds compile cost | LLVM backends (§9.2) |
| List scheduling | Greedy ready-list heuristics | Near-linear, good ILP | Heuristic, not optimal | LLVM MachineScheduler, GCC (§9.3) |
| Trace / superblock scheduling | Profile-picked trace | Cross-block ILP | Compensation code at exits | Multiflow TRACE; superblock/hyperblock scheduling as conceptual descendants (§9.4) |
| Software pipelining | Modulo scheduling | Overlapping iteration execution | Wide-issue only | LLVM MachinePipeliner, IA-64 (§9.5) |
| Pattern match decision trees | Maranget heuristics | Avoids re-testing scrutinees | Column-selection trade-offs | OCaml, Rust, GHC (§10.1) |
| Exhaustiveness checking | Matrix negation | Compile-time coverage warnings | GADT constraint solving | GHC, OCaml, Rust (§10.2) |
| Closure conversion (flat) | Record per closure | O(1) variable access | Alloc cost per capture count | OCaml, GHC (§11.1) |
| Lambda lifting | Extra params instead of env | No allocation | Increases arity and call-site plumbing; less effective for escaping higher-order values or separate compilation | Lifted/floated functions; specialization passes (§11.2) |
| Defunctionalization | Sum type of all lambdas | Eliminates closures | Whole-program only | Roc, MLton, GPU backends (§11.3) |
| Zig comptime | Same language at compile time | Unified generics, reflection, and compile-time evaluation without AST macros | Compile-time resource use | Zig (§12.1) |
| Rust proc macros | Separate host crate loaded during expansion | Arbitrary compile-time code | Latency; not sandboxed by default; Watt explores Wasm sandboxing | Rust, Watt (Wasm sandbox) (§12.2) |
| Terra staged metaprogramming | Lua meta, Terra runtime | Clean stage separation | Two-language surface | Terra (§12.3) |
| Multi-stage programming | Quotations + splices, stage types | Type-safe code generation | Restricted to ML-style | MetaOCaml, Lean tactics (§12.4) |
| Template Haskell reification | Compile-time reflection | Generate code from types | Compile-time overhead | GHC (§12.5) |
| Scala 3 inline + quoted macros | Two-tier system | Typed, composable macros | Verbosity vs whitebox | Scala 3 (§12.6) |
| Full CTFE (D / C++ constexpr) | Interpreter of language subset | Pure fns at compile time | Tight rules (C++) vs speed (D) | D, C++20+ (§12.7) |
| Nim macros/templates | Untyped, typed, and template phases | Declaration generation + semantic AST inspection | Phase complexity and compiler-internal AST coupling | Nim (§12.8) |
| CREATE / DOES> defining words | Dictionary entry + deferred action | Compile-time codegen, zero macro infra | Scoped to defining-word patterns | Forth (every dialect) (§12.9) |
| Three-stage comptime pipeline | Parse → interpret → elaborate | Compile-time work as MLIR pass | Pipeline complexity vs macro expander | Mojo `@parameter` (§12.10) |
| `#run` + AST mutation + build-as-code | Compiler-as-library API | Metaprogramming = ordinary code | Compiler must be library-first | Jai (§12.11) |
| Static reflection via lift/splice operators | `^^expr` + `[: r :]` over `std::meta::info` | Reflection without macros; eliminates SFINAE | Consteval-only MVP; no token splicing | C++26 P2996 (§12.12) |
| QBE backend | ~14K lines C99 | ~50–70% LLVM perf, instant compile | Limited targets, fewer opts | cproc (§13.1) |
| Cranelift + ISLE | DSL-driven lowering | Fast compile, e-graph mid-end | Less mature than LLVM | Wasmtime, rustc debug (§13.2) |
| TPDE single-pass | Adapter-based framework | 10x faster than LLVM -O0 | No cross-function opts | LLVM IR fast mode (§13.3) |
| Macroassembler JIT (DynASM) | Direct code emission | Zero IL overhead | Human handles regalloc | LuaJIT (§13.4) |
| Template-based direct-emit JIT | One hand-written template per opcode | Simple, fast compile, no IR | Per-opcode maintenance cost | MoarVM lego JIT (§13.5) |
| Reachability-first whole-program compile | Lazy codegen of reached code | 50–300x faster than rustc/TinyGo | Whole-program only, no sep-compile | Virgil (Aeneas) (§13.6) |
| REPL-driven type-directed open coding | Block-compiler + type-environment accumulation | AOT-quality code, REPL-style interactivity | Per-language; Common-Lisp-flavoured | SBCL (§13.7) |
| Whole-program type-inference compilation | Closed-world flow + escape + alias analysis | 0.6–4× of `gcc -O2` from Scheme source | Super-linear compile time; no sep-compile or eval | Stalin (§13.8) |
| Whole-program monomorphisation + defunctionalization + contification | SSA pipeline of ~20 small passes | C-competitive on numeric SML; HOL4 production scale | No separate compilation; minutes-scale compile times | MLton (§13.9) |
| Productive expression DSL over JVM bytecode | Lisp-like AST → ASM → cached generated class | Drops floor of "should I codegen?" for managed-runtime apps | JVM-only; runtime not compile-time | ActiveJ Codegen (§13.10) |
| Tiny embeddable JS engine | NaN-boxed RC + cycle collector | ~210 KB, fits in tens of KB RAM after stripping | No JIT; interpreter-only | QuickJS / QuickJS-NG (§13.11) |
| Multi-backend Wasm runtime | SinglePass / Cranelift / LLVM swappable backends | Pick compile-vs-quality per workload | Triple maintenance burden | Wasmer (§13.12) |
| LLVM-only Wasm runtime | All Wasm via full LLVM pipeline | Peak performance for compute-heavy workloads | Seconds of compile-per-module | WAVM (§13.12) |
| Embedded Wasm runtime | C, kilobyte-budget, multi-mode execution | Wasmtime-class semantics on MCU-class hardware | Per-mode build configuration | WAMR (§13.12) |
| AST interpreter as reusable optimisation substrate | AST semantics + partial-evaluator framework | Avoids semantic duplication between interpreter and compiler | Framework-driven optimisation shape | ASTro (§13.13) |
| Trace-based JIT | Trace recording | Auto-inlining, cross-function opt | Trace explosion on branchy code | LuaJIT, PyPy (§14.1) |
| OSR / Deoptimization | Stack frame mapping | Tier switch mid-execution | Complex frame reconstruction | V8, HotSpot, SpiderMonkey (§14.2) |
| Basic Block Versioning | Per-block specialized variants | Type specialization without tracing | Code duplication | Ruby YJIT (§14.3) |
| Worker-thread specialization | Async log/plan/install | No pause-for-compile latency | Specializations arrive later | MoarVM spesh (§14.4) |
| Lazy stack-unwind deopt | Mark frames, deopt on return | Skips work for frames that unwind | Slight complication in unwinder | MoarVM spesh (§14.4) |
| Uninlining on guard failure | Inliner records resume-init | Reconstructs pre-inlining stack | Per-inline metadata cost | MoarVM spesh (§14.4) |
| Dispatcher programs (guards+delegate+resume) | Recorded dispatch bytecode | One mechanism for all dispatch kinds | Requires NQP-style dispatcher substrate | MoarVM new-disp (§14.5) |
| Continuation-safe await lowering | First-class continuations + resumption metadata | Non-blocking wait composes with specialization | Requires VM continuation primitive | MoarVM ThreadPoolAwaiter (§14.6; `CONCURRENCY.md`) |
| Tiered JIT from interpreter variants | Multiple interpreter definitions + shared meta-tracer | Adds warm-up tier without a second full backend | Cannot change low-level backend architecture | 2SOM / RPython (§14.7) |
| Reusable optimized IR in dynamic compilation | Cache/preserve optimized IR across recompiles | Reduces repeated optimization work | Assumption invalidation and IR-versioning complexity | Oracle Labs dynamic compilation (§14.8) |
| Polyhedral compilation | Parametric polyhedra | Optimal loop tiling/fusion | Restricted to affine loops | Halide, Tiramisu, Triton (§15.1) |
| Enzyme AD | LLVM IR differentiation | Language-agnostic, GPU support | Requires LLVM integration | Julia, C/C++, Rust (§15.2) |
| NVRTC runtime PTX compile | CUDA source → PTX → SASS | Dynamic kernel specialization | Two-stage compile | PyTorch, JAX, XLA (§15.3) |
| SPIR-V portable GPU IR | Binary SSA IR | Vendor-independent GPU codegen | Driver-level lowering | Vulkan, OpenCL, Mesa (§15.4) |
| Mesa NIR / XLA / Triton | Multi-stage GPU pipelines | Specialized backends per stage | Ecosystem fragmentation | Mesa, TensorFlow, OpenAI (§15.5) |
| Interaction-net runtime to GPU | Fixed CUDA evaluator interpreting graphs | No per-program codegen step | Constant-factor cost vs hand-tuned kernels | Bend / HVM2 (§15.6) |
| Java to GPU via code reflection | Code models lowered to OpenCL/PTX at runtime | No separate kernel language | OpenJDK feature still maturing | Project Babylon + TornadoVM (§15.7) |
| Executable semantics to fast simulator | Sail spec + staging/specialization | One authoritative ISA spec feeds practical simulator | Spec language constrains optimisation shape | Pydrofoil (§15.8) |
| Perceus ref counting | Linear resource calculus | Garbage-free, in-place reuse | No cycles without extension | Koka (§16.1) |
| Region-based memory | Region inference | Bulk deallocation, no GC pauses | Less control than ownership | MLKit, Cyclone (§16.2) |
| Generational references | 48-bit gen per alloc + per-ref | 2–10% cost, no GC/RC/borrow checker | Runtime check on every deref | Vale (§16.3) |
| Immutable region borrowing | Freeze region, pre-check once | Zero generation checks while frozen | `pure`/region annotation burden | Vale regions (§16.3) |
| Historical hybrid-generational memory prototype | Static analysis + scope tethering | Intended to elide many runtime checks | Abandoned/subsumed by regions + generational references | Vale HGM (§16.3) |
| Hidden classes / IC | Shape transition chains | 60–100x faster monomorphic access | Megamorphic cliff | V8, SpiderMonkey, JSC (§17.1) |
| Polymorphic Inline Caches | Type-chain dispatch stubs | O(1) for <10 types | Megamorphic cliff | SELF, V8 ICs, Julia (§17.2) |
| Instance-to-static-class rewriting | ASM-driven runtime instance specialisation | 7× speedup recovering manual-code performance | JVM-only; instance state must be predictable | ActiveJ Specializer (§17.4) |
| Query-based compilation | Memoized demand-driven | Minimal recompilation | Architectural complexity | rustc, Salsa, rust-analyzer (§18.1) |
| Parallel codegen units | Split per-function compile | Near-linear core scaling | Lost cross-module inlining | rustc CGUs, LLVM parallel (§18.2) |
| Content-addressed code by hash | Hash-keyed codebase DB | Distributed compute, renames free | Ecosystem friction (no text files) | Unison (§18.3) |
| Project references + `--incremental` | `.tsbuildinfo` per project + per-file hashes | Sub-second rebuild on multi-MLOC monorepo | File-granularity, not symbol-granularity | TypeScript (§18.4) |
| Typed elaboration boundary | Rich surface → typed core | Backend isolation from source type system | Requires stable typed metadata | Lean, Rust HIR/THIR, Swift SIL (§19.1) |
| Evidence / dictionary / witness passing | Implicit facts become IR values | Ordinary optimizer can specialize them | ABI and calling-convention pressure | Haskell, Swift, Rust traits (§19.2) |
| Effect handler lowering | Handler evidence or continuations | Typed effects become executable control flow | Runtime/ABI co-design | Koka, OCaml 5 (§19.3) |
| Constraint results as optimization inputs | Solved obligations feed lowering | Avoids re-running inference in backend | Needs durable fact representation | GHC, Rust, Lean (§19.4) |
| PCRE-JIT | Hand-written pattern templates | 4–15x over bytecode | Inherits backtracking blowup | PCRE2 (§20.1) |
| irregexp tiered engine | Bytecode + native tier-up + restricted linear fallback | Fast common case, safe subset available | Full JS regex keeps backtracking semantics | V8 JavaScript (§20.2) |
| NFA + lazy DFA regex | Thompson NFA + DFA cache | O(nm) guaranteed | No backrefs/lookaround | RE2, Rust regex (§20.3) |
| Regex derivatives | Similarity canonicalization | Compact DFA | Needs canonical form | Owens-Reppy-Turon (§20.4) |
| Produce/consume SQL codegen | LLVM IR per query | 10x over iterator model | Compile latency | HyPer, Umbra (§21.1) |
| Vectorized interpretation | SIMD kernels + batching | ~80% of JIT perf | Batch setup overhead | Photon, DuckDB (§21.2) |
| JVM bytecode SQL codegen | Janino runtime classes | Reuses HotSpot JIT | Class-loading overhead | Spark Tungsten (§21.3) |
| LLVM expression JIT library | Per-expression native code | Caches by signature | Narrow scope (no joins) | Apache Arrow Gandiva (§21.5) |
| Differential dataflow + IVM | Delta-based operator graph + materialised views | Always-current materialised state, sub-ms latency | Long-lived views only, not one-shot queries | Materialize, RisingWave, Epsio (§21.6) |
| Vectorized execution engine as library | Arrow-shaped vectors + adaptive operator specialisation | One backend amortised across many SQL frontends | Cannot make end-to-end planning decisions | Velox / Spark Gluten / Prestissimo (§21.7) |
| BPF verifier + in-kernel JIT | Static analysis + native emit | Safe user code in kernel | Restricted source language | Linux BPF/eBPF (§22.1) |
| Move bytecode verifier | Linear-resource discipline + reference safety + ability lattice | Largest-deployment linear-types verifier | Smart-contract-shaped programs only | Move VM (Aptos/Sui) (§22.2) |
| Hot module reload | Two versions simultaneously | Uptime under upgrade | Requires process-isolated model | Erlang BEAM (§23.1) |
| Runtime method table patch | Re-JIT on change | Interactive development | Process-local, not distributed | Julia Revise.jl (§23.2), Common Lisp (§23.3) |
| Edit-and-Continue / HotSwap | IL-level method replace | Iterative debug workflow | Restricted to debug builds | .NET EnC, JVM JVMTI (§23.4) |
| dlopen live reload | Swap shared library ptrs | Language-agnostic | Manual state/code separation | Game engines, Handmade Hero (§23.5) |
| Wasm streaming compile | Structured binary format | Compile during download | No arbitrary goto | V8, SpiderMonkey (§24.1) |
| Sidetable-driven in-place interpreter | Validation-emitted sidetable | Fast startup, no rewriting | Requires validator to emit structure | Virgil wizard Wasm (§24.2) |
| CompCert verified compilation | Coq proofs per pass | Zero miscompilation bugs | ~15% slower than GCC | Airbus, safety systems (§25.1) |
| CakeML full-stack verification | HOL4 + self-hosting | Verified down to machine code | ML subset, slower than MLton | Research, bootstrap (§25.2) |
| Translation validation | SMT equivalence per run | Finds bugs, no full proof | Per-compilation cost | Alive2, Crellvm (§25.4) |
| Instrumentation PGO | Two-build + counter insertion | 10–20% gain over -O3 | Build pipeline complexity | GCC, Clang (§26.1) |
| AutoFDO sampling PGO | perf samples + DWARF mapping | No build instrumentation | Needs production samples | Google-scale workloads (§26.2) |
| BOLT post-link optimizer | Rewrites ELF layout | 5–15% over -O3+LTO+PGO | Binary modification | Facebook HHVM, Clang (§26.3) |
| Propeller relinkable layout | Linker-phase reorder | Comparable to BOLT, cleaner integ | Linker cooperation needed | Google (§26.4) |
| Full LTO | Merged bitcode module | Max cross-module opt | Serial link bottleneck | GCC -flto, Clang -flto=full (§27.1) |
| ThinLTO | Summaries + parallel opt | Near LTO quality, scalable | Summary overhead | Clang/LLVM default (§27.1) |
| Modern parallel linkers | Lock-free symbol resolution | 2–10x faster than ld.bfd | Per-platform tuning | mold, lld, wild (§27.2) |
| Alternative-compiler bootstrap | Scoped second implementation | Breaks self-hosting cycle | Duplicated parsing work | mrustc (Rust from C++) (§28.2) |
| Stage0 / minimal bootstrap | 357-byte hex0 seed | Fully auditable chain | Slow, multi-stage build | GNU Mes, Bootstrappable Builds (§28.3) |
| Itanium C++ mangling | Structured name encoding | Unambiguous linker symbols | Verbose, demangling needed | GCC, Clang, Rust v0 (§29.2) |
| TLS model selection | Exec / init / general-dynamic | Speed-vs-flexibility per access | Per-symbol model choice | ELF, Mach-O, COFF (§29.4) |
| Java FFM API | `MemorySegment` + `Linker` + `MethodHandle` | Pure-Java FFI without JNI per-call overhead | Off-heap memory and lifetime management on the user | Project Panama / FFM (§29.5) |
| R2R AOT+JIT hybrid | Pre-native with IL fallback | Fast startup + re-spec | AOT less optimized than JIT | .NET CrossGen2 (§30.1) |
| Deprecated JVM AOT hybrid | Shared-library native image loaded by HotSpot | Startup experiment with JVM fallback | Removed from mainline JDK | HotSpot `jaotc` (§30.2) |
| AOT caching with JIT fallback | Training-run profiles → AOT cache + JIT for misses | Preserves all dynamism; 2–3× cold-start | Cache must be primed by training | Project Leyden (JDK 25+) (§30.2b) |
| Process checkpoint/restore as JVM warmup | CRIU snapshot of warmed JVM + `org.crac` lifecycle | Sub-second restore of multi-second-warmup JVM | Snapshot is environment-coupled; resources need pre-checkpoint release | Project CRaC, Azul Zulu (§30.2c) |
| Closed-world native image | Whole-program AOT executable | Fast startup, low memory | Reduced reflection/loading dynamism | GraalVM Native Image (§30.3) |
| Salsa incremental type checking | Memoized query graph | 80x faster incremental vs Pyright | Requires query-based architecture | ty, rust-analyzer (§31.1) |
| Forth metacompilation | 2-phase host-seed + self-host | Retarget to N archs from ~1 file/arch | Forth-only idiom | lbForth, Gforth cross (§33.10) |
| Proof-carrying fcode verifier | Verifier inside evaluator | Memory-safe option-ROM drivers | OF-specific design | BootSafe (§33.11) |
| Static stack-effect verification | Per-word signature | Compile-time discipline as safety | Anchors required for `execute`-style | Ertl 2021, StrongForth, typeforth (§33.12) |
| Compile-time register renaming for stack ops | Two TOS regs | Zero-cost `swap` / rotate | Fixed N TOS regs only | FreeForth (§33.13) |
| Multi-backend embeddable MCU codegen | Shared frontend + pluggable backends | Compiles inside 100 KB–10 MB MCU | Multi-target maintenance | mcp_forth (§33.14) |

---

## 35. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Compilation Techniques

1. Copy-and-Patch Compilation — https://arxiv.org/abs/2011.13127
2. Jamie Brandon: Implementing Interactive Languages — https://www.scattered-thoughts.net/writing/implementing-interactive-languages/
3. Futamura-style derivation of compilers (2024) — https://arxiv.org/pdf/2411.10559
4. Futamura Projections — Y. Futamura, "Partial evaluation of computation process" (1971)
5. Supercompilation (Turchin) — https://mazdaywik.github.io/direct-link/The%20Concept%20of%20a%20Supercompiler.pdf
6. Sea of Nodes — Click, "From Quads to Graphs" (1993)
7. Cranelift E-graph RFC — https://github.com/bytecodealliance/rfcs/blob/main/accepted/cranelift-egraph.md
8. The Implementation of Lua 5.0 (Ierusalimschy et al., 2005) — https://www.lua.org/doc/jucs05.pdf
9. Virtual Machine Showdown: Stack Versus Registers (Shi et al., VEE 2008) — https://static.usenix.org/events/vee08/full_papers/shi/shi.pdf
10. CPython PEP 659: Specializing Adaptive Interpreter — https://peps.python.org/pep-0659/
11. Efficient Interpretation by Inline Caching and Quickening (Brunthaler, ECOOP 2010) — https://publications.cispa.saarland/1069/1/ecoop10.pdf
12. EuroForth 2024 proceedings (Ertl IP-update papers) — http://www.euroforth.org/ef24/papers/
13. Anton Ertl EuroForth collection — https://www.complang.tuwien.ac.at/anton/euroforth/
14. Python 3.14 release notes (free-threading) — https://docs.python.org/3/whatsnew/3.14.html
15. Faster CPython JIT plan for 3.16 (Ken Jin) — https://fidget-spinner.github.io/posts/faster-jit-plan.html
16. CinderX repository — https://github.com/facebookincubator/cinderx
17. Cinder repository (Meta CPython fork) — https://github.com/facebookincubator/cinder
18. Meta — Cinder JIT function inliner (2022) — https://engineering.fb.com/2022/05/02/open-source/cinder-jits-instagram/
19. Pyston repository — https://github.com/pyston/pyston
20. Pyston blog — https://blog.pyston.org/
21. PHP RFC: JIT — https://wiki.php.net/rfc/jit
22. PHP RFC: JIT IR Framework — https://wiki.php.net/rfc/jit-ir
23. PHP JIT in depth (php.watch) — https://php.watch/articles/jit-in-depth
24. Zend — What's new in PHP 8.4 (JIT changes) — https://www.zend.com/blog/php-8-4
25. Roblox — Luau Native Code Generation — https://create.roblox.com/docs/luau/native-code-gen
26. Luau Recap for 2025: Runtime — https://luau.org/news/2025-12-19-luau-recap-runtime-2025/
27. Luau native code with type hints — https://devforum.roblox.com/t/optimizing-native-code-performance-with-type-hints-and-magic/4247690
28. Codon repository (Exaloop) — https://github.com/exaloop/codon
29. MIT News — Codon Python compiler — https://news.mit.edu/2023/codon-python-based-compiler-achieve-orders-magnitude-speedups-0314
30. Shajii et al. — Codon: a Compiler for High-Performance Pythonic Applications (PLDI 2023) — https://dl.acm.org/doi/abs/10.1145/3578360.3580275
31. Numba — A High Performance Python Compiler — https://numba.pydata.org/
32. llvmlite — lightweight LLVM Python binding — https://github.com/numba/llvmlite
33. Numba `@jit` documentation — https://numba.pydata.org/numba-doc/dev/user/jit.html

### Chapter 2 — Memory Management in Compilers

1. Hash Consing — https://en.wikipedia.org/wiki/Hash_consing

Background: arena allocation, struct-of-arrays layout, and qualifier-bit packing are practitioner-folklore techniques without single canonical citations; the Zig `MultiArrayList`, Rust `bumpalo`, and Clang/Cuik `QualType` source trees are the load-bearing references.

### Chapter 3 — Value Representation

1. ExBoxing — https://medium.com/@kannanvijayan/exboxing-bridging-the-divide-between-tag-boxing-and-nan-boxing-07e39840e0ca
2. SpiderMonkey JS::Value (NaN boxing) — https://firefox-source-docs.mozilla.org/js/index.html
3. V8 Smi and HeapObject tagged pointers — https://v8.dev/blog/pointer-compression
4. OCaml runtime value representation — https://ocaml.org/manual/5.2/runtime.html

(References 2–4 are also cited inline at §3.1 (NaN boxing) and §3.2 (tagged pointers).)

### Chapter 4 — Register Allocation

1. Linear Scan Register Allocation — https://web.cs.ucla.edu/~palsberg/course/cs132/linearscan.pdf
2. Efficient Global Register Allocation — https://arxiv.org/pdf/2011.05608

### Chapter 5 — Compiler-Emitted Source Position Metadata

1. JVM `LineNumberTable` and `LocalVariableTable` attributes — https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html
2. PEP 657 — Include Fine-Grained Error Locations in Tracebacks — https://peps.python.org/pep-0657/
3. Lua debug information and line tables — https://www.lua.org/manual/5.4/manual.html#4.7
4. DWARF Debugging Standard — https://dwarfstd.org/
5. ECMA-426 Source Map Format — https://tc39.es/ecma426/

### Chapter 6 — Intermediate Representations Beyond SSA

1. CPS-SSA Correspondence (Kelsey, 1995) — https://bernsteinbear.com/assets/img/kelsey-ssa-cps.pdf
2. Compiling with Continuations (Appel, 1992) — https://www.cs.princeton.edu/~appel/papers/cpcps.pdf
3. MLIR: Multi-Level Intermediate Representation — https://mlir.llvm.org/
4. Composable Code Generation in MLIR — https://arxiv.org/abs/2202.03293
5. V8 Turboshaft blog — https://v8.dev/blog/turboshaft
6. V8 Turboshaft design presentation — https://docs.google.com/presentation/d/1s1at4981oW06S52uL2HFizgVMYvaV1kB8i6oEiEbFBQ/
7. Cranelift source — https://github.com/bytecodealliance/wasmtime/tree/main/cranelift
8. Binaryen — https://github.com/WebAssembly/binaryen
9. Building Modern Language Frontends with MLIR (Lattner & Zhu, LLVM Dev Meeting 2025) — https://llvm.org/devmtg/2025-10/slides/technical_talks/lattner_zhu.pdf
10. Mojo POP Dialect Internal Docs — https://github.com/modular/modular/blob/main/mojo/stdlib/docs/internal/pop_dialect.md
11. Peering into the Ballerina Intermediate Representation (Piyasekara, 2024) — https://medium.com/ballerina-techblog/peering-into-the-ballerina-intermediate-representation-8e97361a070e
12. JVM Compiler Backend for Ballerina IR (dissertation) — http://dl.lib.uom.lk/handle/123/16182
13. RakuAST documentation — https://docs.raku.org/type/RakuAST
14. Perl Foundation RakuAST grant — https://news.perlfoundation.org/post/grant-rakuast-2020-12
15. lizmat 2025 Raku year review — https://github.com/lizmat/articles/blob/main/review-of-2025.md

### Chapter 7 — SSA Construction and Destruction

1. Efficient SSA Construction (Cytron et al., TOPLAS 1991) — https://dl.acm.org/doi/10.1145/115372.115320
2. Simple and Efficient Construction of SSA Form (Braun et al., CC 2013) — https://pp.ipd.kit.edu/uploads/publikationen/braun13cc.pdf
3. Translating Out of SSA Form (Sreedhar et al., POPL 1999) — https://compilers.cs.uni-saarland.de/papers/bbhlmz13cc.pdf
4. Revisiting Out-of-SSA Translation (Boissinot et al., 2009) — https://hal.inria.fr/inria-00349925v1/document

### Chapter 8 — Optimization Passes

1. LLVM GVN pass reference — https://llvm.org/docs/Passes.html#gvn-global-value-numbering
2. Wegman-Zadeck Sparse Conditional Constant Propagation — https://dl.acm.org/doi/10.1145/103135.103136
3. LLVM LICM implementation — https://llvm.org/doxygen/LICM_8cpp_source.html
4. LLVM SROA pass reference — https://llvm.org/docs/Passes.html#sroa-scalar-replacement-of-aggregates
5. Morel-Renvoise PRE — https://dl.acm.org/doi/10.1145/359060.359069
6. LLVM call instruction and `musttail` — https://llvm.org/docs/LangRef.html#call-instruction
7. WebAssembly Tail Call proposal — https://github.com/WebAssembly/tail-call
8. LLVM Vectorizers — https://llvm.org/docs/Vectorizers.html
9. SLP Vectorization (Larsen & Amarasinghe, PLDI 2000) — https://groups.csail.mit.edu/commit/papers/00/pldi00.pdf
10. Polly (polyhedral LLVM) — https://polly.llvm.org/
11. STOKE Superoptimizer — https://raw.githubusercontent.com/eschkufz/stoke-release/master/docs/stoke.pdf
12. Souper — https://github.com/google/souper

### Chapter 9 — Instruction Selection and Scheduling

1. BURS Instruction Selection (Fraser, Hanson, Proebsting) — https://dl.acm.org/doi/10.1145/143103.143139
2. MoarVM JIT overview — https://github.com/MoarVM/MoarVM/blob/master/docs/jit/overview.org
3. LLVM GlobalISel — https://llvm.org/docs/GlobalISel/
4. LLVM CodeGenerator — https://llvm.org/docs/CodeGenerator.html
5. List Scheduling Classical Reference — https://dl.acm.org/doi/10.1145/502874.502884
6. Trace Scheduling (Fisher, 1981) — https://ieeexplore.ieee.org/document/1675828
7. Modulo Scheduling (Rau, HP Labs 1994) — https://www.hpl.hp.com/techreports/94/HPL-94-115.pdf

### Chapter 10 — Pattern Matching Compilation

1. Compiling Pattern Matching to Good Decision Trees (Maranget, 2008) — http://moscova.inria.fr/~maranget/papers/ml05e-maranget.pdf
2. Warnings for Pattern Matching (Maranget, JFP 2007) — https://journals.cambridge.org/action/displayAbstract?aid=1411304
3. GADTs Meet Their Match (Graf, Simon, Peyton Jones, 2020) — https://simon.peytonjones.org/assets/pdfs/gadtpm-acm.pdf

### Chapter 11 — Closure Compilation

1. Lambda Lifting (Johnsson, 1985) — https://www.microsoft.com/en-us/research/publication/lambda-lifting-transforming-programs-to-recursive-equations/
2. Defunctionalization (Reynolds, 1972) — https://dl.acm.org/doi/10.1145/800194.805852
3. A Functional Correspondence Between Defunctionalization and CPS (Danvy-Nielsen) — https://www.cs.ru.nl/~jhh/publications/danvy-nielsen-cc.pdf

### Chapter 12 — Macros and Compile-Time Metaprogramming

1. Zig comptime documentation — https://ziglang.org/documentation/master/#comptime
2. Rust Macros Reference — https://doc.rust-lang.org/reference/macros.html
3. Watt: Rust proc macros in Wasm — https://github.com/dtolnay/watt
4. Terra project site — https://terralang.org/
5. Terra: A Multi-Stage Language for High-Performance Computing — https://cs.stanford.edu/~zdevito/pldi071-devito.pdf
6. MetaOCaml — https://okmij.org/ftp/ML/MetaOCaml.html
7. Template Haskell — https://www.microsoft.com/en-us/research/publication/template-meta-programming-for-haskell/
8. Scala 3 Metaprogramming — https://docs.scala-lang.org/scala3/reference/metaprogramming/index.html
9. D CTFE Compile-Time Arguments — https://dlang.org/articles/ctarguments.html
10. C++ constexpr (cppreference) — https://en.cppreference.com/w/cpp/language/constexpr
11. Nim Macros — https://nim-lang.org/docs/macros.html
12. Forth CREATE / DOES> — https://softwareengineering.stackexchange.com/questions/339283/forth-how-do-create-and-does-work-exactly
13. HN discussion: Implementing DOES> in Forth — https://news.ycombinator.com/item?id=44231594
14. Mojo Compile-Time Evaluation — https://docs.modular.com/stable/mojo/manual/metaprogramming/comptime-evaluation/
15. Mojo Parameterization — https://docs.modular.com/stable/mojo/manual/parameters/
16. Jai Metaprogramming (BSVino's JaiPrimer) — https://github.com/BSVino/JaiPrimer/wiki/Metaprogramming
17. Jai (programming language) — https://en.wikipedia.org/wiki/JAI_(programming_language)
18. P2996R0 — Reflection for C++26 (initial revision) — https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2023/p2996r0.html
19. P2996R13 — Reflection for C++26 — https://isocpp.org/files/papers/P2996R13.html
20. Qt wiki — C++ reflection (P2996) and moc — https://wiki.qt.io/C%2B%2B_reflection_(P2996)_and_moc

### Chapter 13 — Lightweight Compiler Backends

1. QBE Compiler Backend — https://c9x.me/compile/
2. Cranelift project — https://cranelift.dev/
3. Cranelift regalloc2 — https://cfallin.org/blog/2022/06/09/cranelift-regalloc2/
4. TPDE: A Fast Adaptable Compiler Back-End Framework — https://arxiv.org/abs/2505.22610
5. Retrospective of the MoarVM JIT (Bart Wiegmans, 2023) — http://brrt-to-the-future.blogspot.com/2023/06/retrospective-of-moarvm-jit.html
6. Virgil — A Fast and Lightweight Systems Programming Language — https://github.com/titzer/virgil/
7. Why is Virgil so fast? (GitHub issue) — https://github.com/titzer/virgil/issues/80
8. Steel Bank Common Lisp — https://www.sbcl.org/
9. SBCL manual (SourceForge) — https://sbcl.sourceforge.net/manual/
10. SBCL manual (canonical) — https://sbcl.org/manual/index.html
11. ASTro: An AST-Based Reusable Optimization Framework — https://dl.acm.org/doi/10.1145/3759548.3763371
12. ASTro VMIL 2025 paper PDF — https://www.atdot.net/~ko1/activities/2025_astro_VMIL2025.pdf
13. Siskind — "Stalin: a Statically-Typing-Inferring Whole-Program Optimizing Compiler for Scheme" (APLAS 2003 invited) — https://engineering.purdue.edu/~qobi/papers/aplas2003.pdf
14. Stalin source mirror — https://github.com/barak/stalin
15. Siskind — "Flow-Directed Lightweight Closure Conversion" (1997 tech report) — https://www.iro.umontreal.ca/~feeley/papers/SiskindEC97.pdf
16. MLton home — http://mlton.org/
17. Cejtin, Jagannathan, Weeks — "Flow-Directed Closure Conversion for Typed Languages" (POPL 2000) — https://www.cs.purdue.edu/homes/suresh/papers/popl00-camera-ready.pdf
18. MLton repository — https://github.com/MLton/mlton
19. Fluet, Weeks — "Contification Using Dominators" — https://www.cs.purdue.edu/homes/suresh/papers/contification.pdf
20. ActiveJ Codegen — https://activej.io/codegen
21. ActiveJ Codegen examples — https://activej.io/codegen/examples
22. activej-codegen on Maven Central — https://central.sonatype.com/artifact/io.activej/activej-codegen
23. LuaJIT DynASM — https://luajit.org/dynasm.html
24. QuickJS (Bellard) — https://bellard.org/quickjs/
25. QuickJS-NG — https://github.com/quickjs-ng/quickjs
26. QuickJS specification — https://bellard.org/quickjs/quickjs.html
27. Wasmer — https://wasmer.io/
28. Wasmer repository — https://github.com/wasmerio/wasmer
29. WAVM — https://github.com/WAVM/WAVM
30. WebAssembly Micro Runtime (WAMR) — https://github.com/bytecodealliance/wasm-micro-runtime

### Chapter 14 — Trace-Based JIT & Speculative Optimization

1. Musings on Tracing in PyPy (Bolz-Tereick, 2025) — https://pypy.org/posts/2025/01/musings-tracing.html
2. How JIT Compilers are Implemented and Fast — https://kipp.ly/jits-impls/
3. On-Stack Replacement, Distilled (D'Elia & Demetrescu, PLDI 2018) — https://season-lab.github.io/papers/osr-distilled-pldi18.pdf
4. Deoptless: Speculation with Dispatched OSR (Flückiger et al., PLDI 2022) — https://janvitek.org/pubs/pldi22.pdf
5. Basic Block Versioning (Chevalier-Boisvert) — https://chrisseaton.com/truffleruby/basic-block-versioning/
6. Simple and Effective Type Check Removal Through Lazy Basic Block Versioning (OOPSLA 2015) — https://dl.acm.org/doi/10.1145/2816707.2816714
7. MoarVM Specializer Improvements Part 3 (jnthn, 2017) — https://6guts.wordpress.com/2017/11/05/moarvm-specializer-improvements-part-3-optimizing-code/
8. MoarVM spesh deoptimization source — https://github.com/MoarVM/MoarVM/blob/new-disp/src/spesh/deopt.c
9. The new MoarVM dispatch mechanism is here (jnthn, 2021) — https://6guts.wordpress.com/2021/09/29/the-new-moarvm-dispatch-mechanism-is-here/
10. Raku multiple dispatch with the new MoarVM dispatcher (jnthn, 2021) — https://6guts.wordpress.com/2021/04/15/raku-multiple-dispatch-with-the-new-moarvm-dispatcher/
11. New MoarVM dispatch design gist — https://gist.github.com/jnthn/e81634dec57acdea87fcb2b92c722959
12. Rakudo ThreadPoolScheduler — https://github.com/rakudo/rakudo/blob/nom/src/core/ThreadPoolScheduler.pm
13. MoarVM threads.c — https://github.com/MoarVM/MoarVM/blob/master/src/core/threads.c
14. Raku concurrency docs — https://docs.raku.org/language/concurrency.html
15. A Lightweight Method for Generating Multi-Tier JIT Compilation Virtual Machine in a Meta-Tracing Compiler Framework — https://arxiv.org/html/2504.17460v1
16. Reusing Highly Optimized IR in Dynamic Compilation — https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2025.25
17. Oracle Labs publication page — Reusing Highly Optimized IR in Dynamic Compilation — https://labs.oracle.com/pls/apex/f?p=94065:10:983652587227:11670

### Chapter 15 — Domain-Specific & AI-Oriented Compilation

1. Polyhedral Compilation — http://polyhedral.info/
2. Triton: Related Work on Polyhedral vs Scheduling Languages — https://triton-lang.org/main/programming-guide/chapter-2/related-work.html
3. Enzyme: High-Performance AD of LLVM — https://enzyme.mit.edu/
4. Enzyme GPU Reverse-Mode AD — https://c.wsmoses.com/papers/EnzymeGPU.pdf
5. NVIDIA NVRTC — https://docs.nvidia.com/cuda/nvrtc/
6. Khronos SPIR-V — https://www.khronos.org/spir/
7. SPIR-V Specification — https://registry.khronos.org/SPIR-V/specs/unified1/SPIRV.html
8. Mesa NIR — https://docs.mesa3d.org/nir/
9. TensorFlow XLA — https://www.tensorflow.org/xla
10. HVM2 repository — https://github.com/HigherOrderCO/HVM2
11. Bend repository — https://github.com/HigherOrderCO/Bend
12. Taelin — HVM2 paper — https://raw.githubusercontent.com/HigherOrderCO/HVM/main/paper/HVM2.pdf
13. OpenJDK Project Babylon — https://openjdk.org/projects/babylon/
14. TornadoVM home — https://www.tornadovm.org/
15. TornadoVM introduction — https://tornadovm.readthedocs.io/en/latest/introduction.html
16. InfoQ — TornadoVM 2.0 GPU LLM — https://www.infoq.com/news/2025/12/tornadovm-20-gpu-llm/
17. Babylon vs TornadoVM (Fumero) — https://jjfumero.github.io/posts/2025/02/07/babylon-and-tornadovm
18. Pydrofoil: accelerating Sail-based instruction set simulators — https://arxiv.org/abs/2503.04389
19. Pydrofoil repository — https://github.com/pydrofoil/pydrofoil

### Chapter 16 — Advanced Memory Management

1. Perceus: Garbage Free Reference Counting with Reuse (PLDI 2021) — https://www.microsoft.com/en-us/research/wp-content/uploads/2020/11/perceus-tr-v1.pdf
2. MLKit Region-Based Memory Management — https://elsman.com/mlkit/
3. Region-Based Memory Management in Cyclone (PLDI 2002) — https://www.cs.umd.edu/projects/cyclone/papers/cyclone-regions.pdf
4. Vale memory design (canonical treatment in `MEMORY.md §2.6`; sources collected there).

### Chapter 17 — Runtime Object Model Optimization

1. Hidden Classes in V8 — https://v8.dev/docs/hidden-classes
2. Mrale.ph — What's up with Monomorphism? — https://mrale.ph/blog/2015/01/11/whats-up-with-monomorphism.html
3. Polymorphic Inline Caches (Hölzle, Chambers, Ungar, ECOOP 1991) — https://bibliography.selflanguage.org/_static/pics.pdf
4. ActiveJ Specializer overview — https://activej.io/specializer
5. ActiveJ Specializer examples — https://activej.io/specializer/examples
6. ActiveJ Inject — speeding up injection (Specializer integration) — https://activej.io/inject/speeding-up-injection

### Chapter 18 — Incremental & Query-Based Compilation

1. rustc Query System — https://rustc-dev-guide.rust-lang.org/query.html
2. Salsa Incremental Computation Framework — https://github.com/salsa-rs/salsa
3. rustc Codegen Backend Guide — https://rustc-dev-guide.rust-lang.org/backend/codegen.html
4. Unison: The Big Idea — https://www.unison-lang.org/docs/the-big-idea/
5. Trying out Unison, part 1: code as hashes (SoftwareMill) — https://softwaremill.com/trying-out-unison-part-1-code-as-hashes/
6. TypeScript Handbook — Project References — https://www.typescriptlang.org/docs/handbook/project-references.html
7. TypeScript 3.0 release notes — https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-0.html
8. TypeScript 3.4 release notes (`--incremental`) — https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html

### Chapter 19 — Type-System Outputs and Compiler Consequences

1. How to Make Ad-hoc Polymorphism Less Ad Hoc (Wadler & Blott, POPL 1989) — https://www.cs.tufts.edu/~nr/cs257/archive/philip-wadler/ad-hoc-polymorphism.pdf
2. Swift Generics documentation — https://download.swift.org/docs/assets/generics.pdf
3. Generalized Evidence Passing for Effect Handlers (Xie & Leijen, ICFP 2021) — https://xnning.github.io/papers/multip.pdf
4. OCaml 5 effect handlers manual — https://ocaml.org/manual/5.2/effects.html
5. OutsideIn(X) (Vytiniotis, Peyton Jones, Schrijvers, Sulzmann, 2011) — https://www.microsoft.com/en-us/research/publication/outsideinx-modular-type-inference-with-local-assumptions/

### Chapter 20 — Regex Compilation

1. PCRE2 JIT — https://www.pcre.org/current/doc/html/pcre2jit.html
2. V8 regexp tier up — https://v8.dev/blog/regexp-tier-up
3. V8 regexp engine — https://v8.dev/blog/jsregexp
4. Regular Expression Matching Can Be Simple And Fast (Cox) — https://swtch.com/~rsc/regexp/regexp1.html
5. Rust regex crate — https://docs.rs/regex/latest/regex/
6. Regular-expression derivatives reexamined (Owens-Reppy-Turon, JFP 2009) — https://www.ccs.neu.edu/home/turon/re-deriv.pdf

### Chapter 21 — Database Query Compilation

1. HyPer: Efficiently Compiling Query Plans (Neumann, SIGMOD 2011) — https://15721.courses.cs.cmu.edu/spring2017/papers/03-compilation/p539-neumann.pdf
2. Umbra (Neumann et al., CIDR 2020) — https://db.in.tum.de/~neumann/papers/umbra.pdf
3. Photon (Databricks, SIGMOD 2022) — https://www.databricks.com/wp-content/uploads/2022/07/photon-sigmod22.pdf
4. Apache Spark as a Compiler — https://databricks.com/blog/2016/05/23/apache-spark-as-a-compiler-joining-a-billion-rows-per-second-on-a-laptop.html
5. Why DuckDB — https://duckdb.org/why_duckdb.html
6. DuckDB: an Embeddable Analytical Database (CIDR 2020) — https://www.cidrdb.org/cidr2020/papers/p22-raasveldt-cidr20.pdf
7. Apache Arrow Gandiva — https://arrow.apache.org/docs/cpp/gandiva.html
8. Dremio Gandiva intro — https://www.dremio.com/blog/introducing-gandiva-initiative-for-apache-arrow/
9. Materialize home — https://materialize.com/
10. Materialize — Online View Maintenance (OLVM) — https://materialize.com/blog/olvm/
11. Everything to Know About Incremental View Maintenance — https://materializedview.io/p/everything-to-know-incremental-view-maintenance
12. Differential dataflow repository — https://github.com/TimelyDataflow/differential-dataflow
13. Velox repository — https://github.com/facebookincubator/velox
14. Pedreira et al. — Velox: Meta's Unified Execution Engine (VLDB 2022) — https://research.facebook.com/publications/velox-metas-unified-execution-engine/
15. Velox project site — https://velox-lib.io/
16. Meta engineering — Introducing Velox — https://engineering.fb.com/2023/03/09/open-source/velox-open-source-execution-engine/

### Chapter 22 — BPF and eBPF JIT

1. Linux BPF Documentation — https://docs.kernel.org/bpf/
2. BPF Verifier — https://www.kernel.org/doc/html/latest/bpf/verifier.html
3. Aptos Move language and runtime — https://aptos.dev/network/blockchain/move
4. Move language reference — https://move-language.github.io/move/
5. Move smart-contract security guide — https://hackenproof.com/blog/for-hackers/move-smart-contract-security-guide-part-1

### Chapter 23 — Hot Code Swap and Dynamic Loading

1. Erlang Code Loading — https://www.erlang.org/doc/system/code_loading.html
2. Julia Revise.jl — https://timholy.github.io/Revise.jl/stable/
3. Common Lisp HyperSpec — Reader glossary — http://www.lispworks.com/documentation/HyperSpec/Body/26_glo_r.htm
4. Visual Studio Edit and Continue — https://learn.microsoft.com/en-us/visualstudio/debugger/edit-and-continue
5. Handmade Hero — https://handmadehero.org/
6. Handmade Hero Day 22: Instantaneous Live Code Editing — https://hero.handmade.network/episode/code/day022

### Chapter 24 — WebAssembly Compilation Techniques

1. V8 WebAssembly Compilation Pipeline — https://v8.dev/docs/wasm-compilation-pipeline
2. A Fast In-Place Interpreter for WebAssembly (Titzer, PLDI 2022) — https://www.cs.tufts.edu/~nr/cs257/archive/ben-titzer/wasm-interp.pdf

### Chapter 25 — Verified Compilers

1. CompCert — https://compcert.org/
2. The CompCert Verified Compiler (Leroy, CACM) — https://xavierleroy.org/publi/compcert-CACM.pdf
3. CakeML — https://cakeml.org/
4. Vellvm (Zhao et al., POPL 2012) — https://www.seas.upenn.edu/~jianzhou/Vellvm.pdf
5. Alive2 Translation Validation (Lopes et al., PLDI 2021) — https://web.ist.utl.pt/nuno.lopes/pubs/alive2-pldi21.pdf

### Chapter 26 — Profile-Guided and Post-Link Optimization

1. Clang PGO — https://clang.llvm.org/docs/UsersManual.html#profile-guided-optimization
2. AutoFDO (Chen, Li, Hundt, CGO 2016) — https://research.google/pubs/pub45290/
3. BOLT (Panchenko et al., CGO 2019) — https://research.facebook.com/publications/bolt-a-practical-binary-optimizer-for-data-centers-and-beyond/
4. Propeller: Profile Guided Optimizing Large Scale LLVM-based Relinker — https://storage.googleapis.com/pub-tools-public-publication-data/pdf/d753cb3608d6a8e8d71cf2b98a4deab80ec37d77.pdf

### Chapter 27 — LTO and Modern Linkers

1. ThinLTO — https://clang.llvm.org/docs/ThinLTO.html
2. mold linker — https://github.com/rui314/mold
3. wild linker — https://github.com/davidlattimore/wild
4. lld — https://lld.llvm.org/

### Chapter 28 — Bootstrapping

1. Reflections on Trusting Trust (Thompson, 1984) — https://www.cs.cmu.edu/~rdriley/487/papers/Thompson_1984_ReflectionsonTrustingTrust.pdf
2. mrustc — https://github.com/thepowersgang/mrustc
3. Bootstrappable Builds — https://bootstrappable.org/
4. GNU Mes — https://www.gnu.org/software/mes/

### Chapter 29 — ABI and Calling Conventions

1. System V AMD64 ABI — https://gitlab.com/x86-psABIs/x86-64-ABI
2. Windows x64 Calling Convention — https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention
3. Itanium C++ ABI (Name Mangling) — https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling
4. Rust v0 Symbol Mangling RFC — https://rust-lang.github.io/rfcs/2603-symbol-name-mangling-v0.html
5. ELF TLS Models (Drepper) — https://www.akkadia.org/drepper/tls.pdf
6. JEP 454: Foreign Function & Memory API — https://openjdk.org/jeps/454
7. OpenJDK Project Panama — https://openjdk.org/projects/panama/
8. Java SE 25 Foreign Function and Memory API documentation — https://docs.oracle.com/en/java/javase/25/core/foreign-function-and-memory-api.html

### Chapter 30 — .NET ReadyToRun and AOT+JIT Hybrids

1. .NET ReadyToRun Format — https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/readytorun-format.md
2. OpenJDK Project Leyden — https://openjdk.org/projects/leyden/
3. IBM Developer — Improve Java startup with Project Leyden — https://developer.ibm.com/articles/java-project-leyden/
4. SoftwareMill — Project Leyden & JDK 26: AOT Caching to ZGC — https://softwaremill.com/project-leyden-and-jdk-26-bringing-aot-caching-to-zgc/
5. Quarkus — How we integrated Project Leyden — https://quarkus.io/blog/leyden-2/
6. OpenJDK Project CRaC — https://openjdk.org/projects/crac/
7. CRaC home page — https://crac.org/
8. Azul — Coordinated Restore at Checkpoint — https://azul.com/products/components/crac
8a. Azul Docs — CRaC introduction — https://docs.azul.com/core/crac/crac-introduction
9. OpenJDK CRaC repository — https://github.com/openjdk/crac

### Chapter 31 — Case Study — ty (Astral)

1. ty: An Extremely Fast Python Type Checker and LSP — https://astral.sh/blog/ty

### Chapter 32 — Factor — Self-Hosting Optimizing Compiler for a Stack Language

1. Factor: a dynamic stack-based programming language — https://factorcode.org/slava/dls.pdf
2. Factor optimizing compiler overview — https://concatenative.org/wiki/view/Factor/Optimizing%20compiler

### Chapter 33 — Fast Forth Implementation Spectrum

1. Gforth performance — https://gforth.org/manual/Performance.html
2. Gforth dynamic superinstructions — https://www.complang.tuwien.ac.at/forth/gforth/Docs-html/Dynamic-Superinstructions.html
3. VFX Forth common features — https://www.mpeforth.com/software/pc-systems/vfx-forth-common-features/
4. VFX Forth — https://vfxforth.com/
5. SwiftForth — https://www.forth.com/swiftforth/
6. Mecrisp — https://mecrisp.sourceforge.net/
7. zeptoforth project page — https://hackaday.io/project/170826-zeptoforth
8. zeptoforth inline discussion — https://github.com/tabemann/zeptoforth/discussions/190
9. iForth home page — https://iforth.nl/
10. colorForth presentation — https://www.ultratechnology.com/color4th.html
11. Forth history / colorForth note — https://www.forth.com/resources/forth-programming-language/
12. HN: Implementing a Forth — https://news.ycombinator.com/item?id=44142652
13. HN: SwiftForth IDE — https://news.ycombinator.com/item?id=47045194
14. HN: I had my third go at Forth this year — https://news.ycombinator.com/item?id=22802449
15. lbForth (Lars Brinkhoff) — https://github.com/larsbrinkhoff/lbForth
16. Gforth Cross-Compiler Manual — https://gforth.org/manual/Cross-Compiler.html
17. Mecrisp-Quintus (Hans Baier port) — https://github.com/hansfbaier/mecrisp-quintus
18. BootSafe — Hunt, Erlingsson, Kozen (ACSAC 2007) — https://www.cs.cornell.edu/~kozen/Papers/acsac.pdf
19. Mitch Bradley Open Firmware — https://github.com/MitchBradley/openfirmware
20. SANS GIAC OpenBoot Credentials Hack — https://www.giac.org/paper/gcih/182/
21. Ertl — Practical Considerations in a Static Stack Checker (EuroForth 2021) — https://repositum.tuwien.at/handle/20.500.12708/152198
22. StrongForth (Becher) — https://www.stephan-becher.de/strongforth/
23. typeforth — https://github.com/typeforth/typeforth
24. FreeForth (Lavarenne) — http://christophe.lavarenne.free.fr/ff/
25. FreeForth2 (dan4thewin) — https://github.com/dan4thewin/FreeForth2
26. mcp_forth (Liam Howatt) — https://github.com/liamHowatt/mcp_forth
