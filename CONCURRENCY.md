# Concurrency, Scheduling, and Runtime Coordination

This document owns research on language-level and runtime-level concurrency: threads, green threads, tasks, fibers, actors, channels, async/await, structured concurrency, scheduling, cancellation, synchronization, race-freedom, software transactional memory, and the runtime machinery that connects concurrent programs to I/O and operating-system resources.

Ownership boundary: memory-safety and ownership models belong in `MEMORY.md`; type-system treatment of effects, capabilities, and `Send`/`Sync`-style marker traits belongs in `TYPES.md`; compiler lowering and code generation belong in `COMPILERS.md`; tracing, profiling, and runtime event pipelines belong in `TRACERS.md`; debugger workflows for async stacks and concurrency bugs belong in `DEBUGGERS.md`; module/package boundaries belong in `MODULES.md`. This document focuses on the execution model and coordination mechanisms.

---

## 1. Scope and Design Axes

This chapter names the recurring axes along which concurrency designs differ. None of these axes is binary in practice — almost every real runtime makes a different trade-off on each — but separating them clarifies what each later chapter is optimising for. The axes are not ordered by importance; they are ordered by how visible the choice becomes at the source-language level.

### 1.1. Parallelism vs concurrency

Concurrency is about managing multiple in-flight computations; parallelism is about executing computations at the same time. A single-threaded event loop can be highly concurrent without parallelism. A fork-join computation can be highly parallel without exposing long-lived concurrent identities to the programmer.

A language design should separate these questions:

- Does the source language expose tasks, actors, channels, futures, or threads?
- Does the runtime multiplex user tasks onto kernel threads?
- Does blocking I/O block only the logical task or the whole worker thread?
- Are tasks preempted by the runtime, cooperatively suspended, or both?
- Are child tasks scoped and cancelled structurally?
- How does data cross concurrency domains safely?

### 1.2. Kernel threads, virtual threads, green threads, fibers, and tasks

Four execution-unit terms recur in this document:

- **Kernel threads** — scheduled by the operating system; one OS-managed stack per thread.
- **Virtual threads / green threads** — runtime-scheduled thread abstractions multiplexed onto a smaller or dynamically sized set of kernel threads.
- **Fibers** — stackful user-mode execution contexts; suspend with an ordinary call stack intact.
- **Stackless tasks** — state machines that advance through explicit suspension points; no preserved native stack across `await`.

Status (JDK 21+): Java virtual threads are scheduled by the JDK rather than the OS; the JDK scheduler assigns virtual threads to platform-thread carriers in an M:N arrangement (see §5.3). Source: https://openjdk.org/jeps/444

Tokio tasks are lightweight, non-blocking units managed by the Tokio runtime rather than the OS scheduler; tasks should yield instead of blocking worker threads. Source: https://docs.rs/tokio/0.2.9/tokio/task/index.html

### 1.3. Stackful vs stackless suspension

Stackful concurrency preserves a call stack across suspension. It is natural for blocking-looking code, but requires stack allocation, stack switching, or continuation capture. Stackless concurrency compiles async functions into state machines; it is lightweight and explicit, but async annotations and await points can spread through APIs.

Rust futures are stackless and inert until polled. The `Future::poll` method returns `Ready` or `Pending` and uses a `Waker` to ask the executor to poll again later. Source: https://doc.rust-lang.org/stable/std/future/trait.Future.html

OCaml effect handlers use delimited continuations, enabling lightweight threads, generators, coroutines, and asynchronous I/O to be expressed through handlers. Source: https://ocaml.org/manual/effects.html

### 1.4. Preemptive vs cooperative scheduling

Preemptive scheduling interrupts computations without their explicit cooperation. Cooperative scheduling requires tasks to yield, await, block through runtime-aware primitives, or consume a bounded quota.

Erlang/BEAM uses reductions as a fairness mechanism: processes are preempted after consuming a quota of abstract work rather than running arbitrary long loops forever. Source: https://blog.appsignal.com/2024/04/23/deep-diving-into-the-erlang-scheduler.html

Go combines cooperative mechanisms with asynchronous preemption at safe points. The runtime source notes that a goroutine can be preempted at any safe point and that asynchronous preemption can suspend a thread using OS mechanisms such as signals. Source: https://go.dev/src/runtime/preempt.go

### 1.5. Shared memory vs message passing

Shared-memory concurrency communicates through memory protected by locks, atomics, STM, ownership rules, or isolation. Message-passing concurrency communicates through channels, mailboxes, actor messages, or distributed transports.

Message passing can simplify data-race reasoning, but it introduces ordering, buffering, backpressure, and mailbox-growth concerns; selective-receive scanning is also commonly cited as a cost in mailbox-based systems (see §6.2). Shared memory can be efficient and familiar, but puts more burden on synchronization and race prevention.

### 1.6. Structured vs unstructured concurrency

Structured concurrency requires child tasks to be scoped: they cannot outlive their parent scope, and failure/cancellation flows through the task tree. Unstructured concurrency allows detached tasks, fire-and-forget work, daemon tasks, and independent lifetimes.

Swift's structured concurrency proposal frames tasks and child tasks as the primary units of concurrency and requires child tasks in a task group to complete before the group scope exits. Source: https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md

Nathaniel Smith's Trio nursery model emphasizes that a nursery block does not exit until tasks inside it have finished or have been cancelled and cleaned up. Source: https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful

---

## 2. Historical Through-Line, 1960–2026

The concurrency design space accumulated by recombination rather than by replacement: the actor model, CSP channels, monitors, work-stealing, STM, async/await, and effect handlers each emerged in a different decade and now coexist in modern runtimes. This chapter traces the through-line from 1960s OS-process abstractions to the 2020s' virtual threads and effect-handler runtimes, identifying where each idea entered the lineage and which subsequent designs absorbed or reacted against it. The chapter is shorter than the chapters that follow because each entry is a pointer to where the topic is treated in depth elsewhere in the document.

### 2.1. 1960s–1970s — Processes, monitors, CSP, actors, and coroutines

Early concurrency research split into several durable families: shared-memory synchronization, monitors, message passing, communicating sequential processes, actors, coroutines, and continuations. These are not merely historical ideas; modern systems recombine them constantly.

The actor model treats independent entities as concurrent units that communicate by asynchronous messages. CSP-style systems emphasize synchronous or buffered channels and process composition. Coroutine systems emphasize explicit suspension and resumption.

### 2.2. 1980s — Erlang processes and fault-oriented concurrency

Erlang made lightweight isolated processes, message passing, links, monitors, and supervision central to the language. The key lesson is that concurrency can be designed around failure containment rather than only throughput.

Each Erlang process has its own message queue scanned by `receive` (see §6.2 for selective-receive details). Source: https://www.erlang.org/doc/system/conc_prog.html

### 2.3. 1990s — Work stealing and fork-join parallelism

Cilk made work-stealing scheduling a practical and theoretically grounded basis for fork-join parallelism. Work stealing uses per-worker deques: workers run their own local work; idle workers steal from others.

Cilk's work-first principle moved overhead from the common local execution path to the less common stealing path. This led to low spawn overhead and provable bounds for well-structured computations. Sources: https://dl.acm.org/doi/10.1145/277652.277725 and https://people.csail.mit.edu/matei/courses/2015/6.S897/readings/cilk.pdf

### 2.4. 2000s — STM, multicore pressure, and async libraries

As multicore machines became common, languages explored STM, actors, futures/promises, event loops, and thread pools. Haskell STM and Clojure STM show two influential approaches to composable shared-state coordination.

GHC supports Software Transactional Memory with atomic blocks, transactional variables, `retry`, `orElse`, and invariants. Source: https://haskell.org/ghc/docs/latest/html/users_guide/exts/stm.html

Clojure refs use STM with MVCC-style snapshot isolation and automatic retry on conflicts, while atoms and agents cover independent synchronous and asynchronous state changes. Sources: https://clojure.org/reference/refs and https://clojure.org/concurrent_programming

### 2.5. 2010s — Async/await, goroutines, actors, and data-race type systems

Async/await became the mainstream notation for stackless asynchronous code. Status (Go 1.x onward): Go popularized language-integrated goroutines and channels over an M:N runtime (G/M/P; full treatment in §3.2). Rust exposed stackless futures and let libraries such as Tokio provide executors and I/O. Status (Pony, ongoing): Pony explored actor-model data-race freedom through reference capabilities (see §10.3). Status (Swift 5.5+): Swift introduced actors and structured concurrency.

### 2.6. Functional concurrency in production ML and Haskell systems

Functional languages developed several distinct concurrency traditions rather than converging on one runtime model:

- GHC bundles lightweight threads, `MVar`s, async exceptions, STM, and sparks into one runtime (full treatment in §3.7 and §9.6).
- OCaml 5 separates domains (parallel execution) from effect-handler fibers (concurrency substrate); see §5.5.
- Elm intentionally restricts concurrency around tasks and effect managers (see §4.6).
- Koka treats concurrency primarily as an effect-handler design space, with typed control abstractions.

The key design lesson is that "functional concurrency" is not one thing: some systems emphasize a rich runtime substrate, some emphasize typed control abstractions, some emphasize effect-handler runtimes, and some deliberately constrain the model to preserve simplicity.

Source: https://koka-lang.github.io/koka/doc/

### 2.7. 2020s through 2026 — Virtual threads, structured scopes, typed data isolation, and effect-based concurrency

Status (JDK 21): Java virtual threads became a final feature, giving the JDK an M:N virtual-thread scheduler over carrier platform threads (full treatment in §5.3).

Status (as of JDK 26 docs): `ForkJoinPool` remains Java's core work-stealing executor and supports scheduled tasks in the JDK 26 API. Source: https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/concurrent/ForkJoinPool.html

Status (Swift 5.5+): Swift added async/await, task groups, actors, and `Sendable` checking as part of its concurrency model.

Sources:

- https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md
- https://github.com/apple/swift-evolution/blob/main/proposals/0302-concurrent-value-and-concurrent-closures.md

Status (as of early 2026): WebAssembly effect-handler and typed-continuation work is being explored as a substrate for stack switching, async/await, generators, continuations, and effect handlers. Source: https://wasmfx.dev/specs/explainer/

---

## 3. Scheduler Architectures

A scheduler architecture decides how user-visible execution units are mapped onto kernel threads, how they yield or are preempted, and how I/O readiness translates into wakeups. This chapter surveys the dominant families: 1:1 OS threads, M:N runtimes, work-stealing pools, event loops, actor schedulers, runtime-specific designs such as GHC's capabilities-and-sparks split, the OS-level Linux scheduler (CFS / EEVDF) all M:N runtimes ride on top of, and the parallel-programming-model tier (OpenMP pragmas, Intel TBB task parallelism). Fairness and quota mechanisms are treated as a cross-cutting concern.

### 3.1. One OS thread per language thread

The simplest runtime maps each language thread to an OS thread. This gives strong OS integration, native blocking behavior, mature debugging, and simple FFI expectations. The cost is high per-thread memory, OS scheduling overhead, and limited scalability for millions of mostly-blocked tasks.

This model is often good enough for CPU-bound or moderate-concurrency programs, and it remains the best interoperability baseline for native languages.

### 3.2. M:N scheduling

An M:N runtime multiplexes many language tasks onto many kernel threads. It gives the runtime control over task scheduling, stack representation, I/O integration, and per-task metadata.

Go's G/M/P model is the canonical production example: goroutines are Gs, OS threads are Ms, and Ps represent the resources and right to execute Go code. There are exactly `GOMAXPROCS` Ps, while Ms can grow when threads block in system calls. Source: https://go.dev/src/runtime/HACKING.md

Java virtual threads also use M:N scheduling on a JDK-managed carrier pool (see §5.3 for mount/unmount semantics).

### 3.3. Work-stealing schedulers

Work stealing gives each worker a local deque and lets idle workers steal tasks from other workers. The owner usually pushes and pops from one end for cache locality; thieves steal from the other end to reduce contention.

Cilk established the theoretical foundations and inspired many modern runtime schedulers (§2.3). Java's `ForkJoinPool` documentation explicitly identifies work stealing as the main difference from ordinary executors. Source: https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/concurrent/ForkJoinPool.html

### 3.4. Event-loop schedulers

An event-loop runtime maintains a set of ready tasks and I/O interests. When the OS reports readiness or completion, the runtime wakes the corresponding tasks. This model powers JavaScript runtimes, libuv systems, Python async frameworks, and many Rust executors.

Event-loop schedulers are efficient for I/O-bound workloads but must prevent CPU-bound tasks from starving the loop. They need explicit blocking pools, cooperative yielding, or preemption support.

A distinctive Rust subfamily is the **thread-per-core io_uring runtimes** — **Glommio** (Datadog, originally for ScyllaDB-adjacent workloads) and **Monoio** (Bytedance, similar design). Each worker thread runs its own independent single-threaded event loop bound to a specific CPU core via affinity, with its own io_uring instance for asynchronous I/O. Inter-core coordination is by explicit message passing through bounded channels rather than by work-stealing across a shared scheduler. Distinct from Tokio's M:N work-stealing model (`§3.2`-style) where futures freely migrate between worker threads: Glommio/Monoio futures are pinned to one core for their lifetime, eliminating cross-core synchronisation on the hot path. The trade-off is sharp — perfect cache locality and zero shared-state contention, at the cost of needing to manually balance work across cores when the workload isn't naturally per-connection or per-shard. Production use: ScyllaDB-class databases where every connection is a long-lived shard owner, Cloudflare's pingora proxy variants, and Bytedance internal services. Distinct from ActiveJ Eventloop + Workers (`§3.12`): ActiveJ's primary/worker topology balances *connections* across worker eventloops at accept time and lets each worker run arbitrary code; Glommio/Monoio expect the application to organise itself around per-core ownership of long-lived state. Sources: https://github.com/DataDog/glommio and https://github.com/bytedance/monoio

### 3.5. Actor schedulers

Actor runtimes schedule entities with mailboxes rather than arbitrary call stacks. An actor processes messages sequentially, which protects actor-local mutable state. Runtime design questions include mailbox representation, fairness, priority, selective receive, actor migration, backpressure, and supervision.

BEAM runs one scheduler per core on multicore machines and balances work across scheduler run queues. Source: https://happi.github.io/theBeamBook/

Pony actors execute synchronously within an actor and communicate by asynchronous messages; reference capabilities gate what crosses actor boundaries (see §10.3).

### 3.6. Scheduler fairness and quotas

A runtime needs a fairness policy: time slices, instruction counts, reductions, explicit yields, poll budgets, or priority queues. Fairness is not free; checking for preemption too often hurts throughput, but checking too rarely harms latency.

BEAM reductions are a language-runtime-level unit of work. Go uses safe-point and signal-based preemption. Rust async relies heavily on futures returning quickly and not blocking in `poll`.

Sources:

- https://blog.appsignal.com/2024/04/23/deep-diving-into-the-erlang-scheduler.html
- https://go.dev/src/runtime/preempt.go
- https://doc.rust-lang.org/stable/std/future/trait.Future.html

### 3.7. GHC capabilities, lightweight threads, and spark scheduling

GHC's runtime is one of the strongest production examples of a functional-language scheduler built around **lightweight threads** plus a separate parallel-evaluation mechanism. The runtime exposes **capabilities** as virtual processors; each capability can run one Haskell thread at a time, while the runtime manages one or more OS threads behind the scenes. This design lets ordinary Haskell threads remain extremely cheap while still allowing multicore execution and blocking foreign calls.

A separate mechanism, **sparks**, represents speculative parallel work created by `par`; GHC's multicore runtime places spark pools on per-HEC work-stealing queues (§3.3), separating thread scheduling from spark load balancing. This is a useful design pattern: not every concurrent execution unit in a runtime must be scheduled by the same policy or inhabit the same queue.

Sources:

- https://haskell.org/ghc/docs/latest/html/users_guide/using-concurrent.html
- https://www.microsoft.com/en-us/research/wp-content/uploads/2009/09/multicore-ghc.pdf
- https://github.com/ghc/ghc/blob/master/rts/Schedule.c

### 3.8. Linux Kernel Scheduler — CFS and EEVDF

The Linux kernel scheduler is the OS-level scheduling context every M:N runtime (§3.2) competes with and depends on. Two generations are worth recording.

**CFS (Completely Fair Scheduler)** by Ingo Molnár (Linux 2.6.23, 2007) replaced the O(1) scheduler with a fairness-first design. Each task accumulates **vruntime** (virtual runtime) at a rate inversely proportional to its weight (priority). The scheduler picks the task with the lowest vruntime, runs it for a slice, updates its vruntime, and re-inserts it into a red-black tree keyed by vruntime. The result is "perfectly fair" CPU time distribution among ready tasks: every task gets approximately `1/N` of CPU regardless of how many tasks exist or in what order they arrived.

The mechanical primitives:

- **Red-black tree per CPU runqueue**, keyed by vruntime, with O(log N) insert/remove and O(1) leftmost-task lookup.
- **`sched_latency` target**: the wall-clock period in which every task runs at least once (default ~6 ms on busy systems, scaled down with task count).
- **Group scheduling** (cgroups CPU controller): nested CFS instances let a control group's tasks share a vruntime budget, used heavily by container runtimes (Docker, Kubernetes pod CPU limits).
- **Load balancing** across CPU runqueues via periodic and idle-triggered task migration.

**EEVDF (Earliest Eligible Virtual Deadline First)** by Peter Zijlstra (Linux 6.6, October 2023) replaced CFS as the default scheduler. The change is conceptually significant: CFS picks the *minimum vruntime* (greedy fairness); EEVDF picks the task with the **earliest virtual deadline** among **eligible** tasks (deadline-driven fairness). Each task has a *request size* (effectively its time slice) and a *deadline* equal to "now + request / weight". The scheduler picks the task with the earliest deadline whose vruntime is at most the average vruntime — guaranteeing both fairness and predictable latency.

The trade-off vs CFS: EEVDF gives **better latency for short-running interactive tasks** at minor cost to long-batch fairness. The deadline mechanism is also a natural primitive for soft real-time scheduling, which CFS approximated with `nice` and `cpu.shares` but did not directly support. Status (as of 2026-04): EEVDF is default on Linux 6.6+; the transition is essentially complete in modern distributions (Fedora 39+, Ubuntu 24.04+, RHEL 10+).

The runtime-design lesson: **all M:N runtimes (§3.2) ride on this scheduler**. Go's GOMAXPROCS workers, Java virtual-thread carriers (§5.3), Tokio worker threads, and BEAM scheduler threads (§3.5) are all CFS/EEVDF tasks underneath. Their fairness and latency properties depend on the kernel scheduler's choices: a tight-loop goroutine cannot starve other goroutines on the same Go process, but it *can* starve other Linux processes if the runtime's worker count exceeds available CPUs and `cpu.shares` aren't tuned. Designing language schedulers that are *aware of CFS/EEVDF semantics* — particularly `sched_yield` cost, cgroup CPU limits, and the interaction with per-CPU work-stealing (§3.3) — is what separates well-behaved language runtimes from ones that fight the kernel.

Sources: https://docs.kernel.org/scheduler/sched-design-CFS.html and https://lwn.net/Articles/925371/ and https://www.kernel.org/doc/html/v6.6/scheduler/sched-eevdf.html

### 3.9. OpenMP — Pragma-Driven Shared-Memory Parallelism

OpenMP (1997+; current OpenMP 5.2 from 2021, 6.0 in active development) is the de-facto standard for shared-memory parallel programming in C, C++, and Fortran. The interface is **directive-based**: `#pragma omp parallel for` on a loop, `#pragma omp parallel sections`, `#pragma omp task`, `#pragma omp critical`. The compiler (GCC, Clang, Intel, NVIDIA HPC SDK, IBM XL, AMD AOCC) lowers each directive to runtime calls into the OpenMP runtime library (`libgomp`, `libomp`, `iomp5`, etc.) which manages a thread pool and dispatches work.

The architectural distinction from the rest of §3 is that **OpenMP is a pragma-driven structured-parallelism model** rather than a thread-or-task abstraction. Programmers don't write "spawn a goroutine" or "create an actor"; they write "execute these iterations in parallel" or "this region runs concurrently across N threads." The mental model is the parallel loop nest (or task graph for OpenMP 4+ task model), not the concurrent process.

Distinguishing features:

- **`parallel for` with scheduling clauses**: `static`, `dynamic`, `guided`, `auto`, `runtime`. Static partitioning works for regular loops; dynamic and guided use queue-based scheduling for irregular workloads. The runtime manages a thread pool sized by `OMP_NUM_THREADS`.
- **`#pragma omp task`** (OpenMP 3.0+): explicit task-spawn for irregular parallelism. Tasks form a DAG; `taskwait` joins them. The OpenMP 4+ task model adds dependencies via `depend(in: x)` / `depend(out: y)` / `depend(inout: z)`, giving a deps-graph executor more powerful than parallel-for.
- **`reduction` clause**: language-level support for parallel reductions over user-supplied or built-in operators (`+`, `*`, `min`, `max`, user-defined reduction operators since OpenMP 4.0).
- **`target` directive (OpenMP 4+)**: offload to GPU or accelerator. The compiler generates kernels and the runtime manages data transfers, hiding most of the complexity that CUDA / SYCL programs handle explicitly. NVIDIA HPC SDK and AOMP are the canonical implementations.
- **NUMA awareness**: thread-affinity policy via `OMP_PLACES` (e.g. `cores`, `sockets`, explicit core lists) and `OMP_PROC_BIND` (`spread`, `close`, `master`) lets the program co-locate threads with the memory they touch.

Distinct from Cilk (§2.3, §3.3): Cilk-5 is a strict fork-join algebra with provable work-stealing bounds; OpenMP is pragma-based with multiple scheduling strategies and no global theoretical guarantee. Distinct from C++26 `std::execution` (§4.8): OpenMP works on Fortran, C, and C++ uniformly with directive-level uniformity rather than language-level template machinery. Distinct from Reactive Streams (§7.7): OpenMP is push-based with implicit barriers, not pull-based with explicit demand. Distinct from TBB (§3.10): OpenMP requires compiler support; TBB is a pure library.

Production: virtually all HPC and scientific-computing workloads (LAMMPS, Quantum ESPRESSO, OpenFOAM, weather-forecasting codes like WRF and IFS, gene-sequencing pipelines such as BWA-MEM and STAR), much of NumPy/SciPy via OpenBLAS-OpenMP, large parts of the Linux kernel's per-thread-pool work, and increasingly CUDA-adjacent work via `target` offload. By any reasonable measure, OpenMP is the most-deployed parallel programming model in the world.

Status (as of 2026-04): OpenMP 5.2 (2021) is the current spec; OpenMP 6.0 in development. The runtime-design lesson is that **a directive-driven parallelism model is a different design point** from explicit threads, fibers, async tasks, or actors. It trades programmer control for ergonomic conciseness — `#pragma omp parallel for` adds three lines and gets correct parallelism for an embarrassingly-parallel loop. The cost is opacity (it's hard to reason about what the runtime is doing without instrumentation) and lock-in (porting an OpenMP codebase to a non-OpenMP runtime is hard because the parallelism is in pragmas, not in code structure).

Sources: https://www.openmp.org/specifications/ and https://gcc.gnu.org/onlinedocs/libgomp/ and https://www.openmp.org/wp-content/uploads/OpenMP-API-Specification-5-2.pdf and https://openmp.llvm.org/

### 3.10. Intel TBB / oneTBB — Library-Level Task Parallelism for C++

Intel's **Threading Building Blocks** (TBB, 2006+) — open-sourced as **oneTBB** in 2021 under the UXL Foundation — is a C++ task-parallelism library that complements OpenMP (§3.9) by offering library-level rather than directive-level parallelism. Where OpenMP requires compiler support and pragma annotations, TBB is "just C++": templates, function objects, and concurrent containers compose with ordinary code without any compiler awareness.

The architectural pillars:

- **Tasks, not threads**: programmers express algorithms as task graphs (`parallel_for`, `parallel_invoke`, `parallel_pipeline`, `flow_graph`) or higher-level patterns. The TBB runtime manages a thread pool sized by hardware concurrency, schedules tasks via **work-stealing** across worker queues (the same algorithm Cilk §2.3 introduced and §3.3 surveys), and balances load automatically.
- **Concurrent containers**: `concurrent_hash_map`, `concurrent_queue`, `concurrent_vector`, `concurrent_unordered_map` are designed for lock-free or fine-grained-locking concurrent access from multiple tasks. Distinct from C++ `std::` containers, which require external synchronisation.
- **`flow_graph`**: dependency-graph executor for explicit task-DAG construction. Each node is a function; edges are typed data flows; the graph runs on the TBB thread pool. Comparable to OpenMP's `depend(in:/out:)` task model (§3.9) but expressed as runtime data-structure construction rather than pragma annotations.
- **`parallel_pipeline`**: pipeline-parallelism primitive for staged data processing, with explicit per-stage parallelism control (serial-in-order, serial-out-of-order, parallel).
- **NUMA support and `task_arena` partitioning**: lets programs split worker-thread pools across NUMA domains or workload classes (e.g. a UI arena vs a background-compute arena that share no workers).

Distinct from OpenMP (§3.9): TBB is a pure C++ library (no compiler support needed), giving it portability advantages but losing OpenMP's Fortran and C compatibility. Distinct from C++26 `std::execution` (§4.8): TBB is task-DAG-and-thread-pool focused on bulk parallelism; senders/receivers is async-graph composition focused on heterogeneous async; the two address overlapping but distinct workloads.

Production: Intel Embree (production ray tracing), OpenVDB (volumetric data structures used at Pixar, DreamWorks), LightGBM (gradient boosting), AutoCAD, CGAL (computational geometry library), POV-Ray, many Adobe and Autodesk products, scientific-computing libraries that need C++-native task parallelism without an OpenMP runtime dependency. **Eigen** and several BLAS implementations support oneTBB as one parallel backend among OpenMP, std::thread, and serial.

Status (as of 2026-04): oneTBB is part of the **oneAPI specification** (UXL Foundation), Apache 2.0 licensed, ships with Intel oneAPI HPC Toolkit, and is available standalone via vcpkg / Conan / system package managers. The 2021 transition from "Intel TBB" to "oneTBB" coincided with the rename of namespace from `tbb::` to keeping both for compatibility, ABI stabilisation under the oneAPI specification, and migration to a community-governance model.

The lesson generalises: **a task-parallelism library can substitute for a parallel-programming language extension** (OpenMP) when the host language has sufficient template / generics machinery to express scheduling abstractions ergonomically. C++ has it; C does not, which is why C codebases tend to use OpenMP and C++ codebases can choose between TBB, OpenMP, and `std::execution`.

Sources: https://www.intel.com/content/www/us/en/developer/tools/oneapi/onetbb.html and https://github.com/uxlfoundation/oneTBB and https://oneapi-spec.uxlfoundation.org/specifications/oneapi/latest/elements/onetbb/source/

### 3.11. Bend / HVM2 — Interaction Combinator Runtime as Implicit Parallelism

Victor Taelin's **Bend** (Higher Order Company, 2024) and its underlying runtime **HVM2 (Higher-Order Virtual Machine 2)** sit in a different corner of the parallelism design space from every other entry in this chapter. Where Go (§3.2), Cilk (§3.3), GHC sparks (§3.7), OpenMP (§3.9), and TBB (§3.10) all multiplex *explicit* tasks/threads/work-items onto cores, HVM2 treats every program as a graph of **interaction combinators** (Lafont 1997) — small first-order rewrite rules with the property that **non-overlapping rewrites are always commutative** — and parallelises by detecting those non-overlapping reductions and executing them simultaneously across CPU cores or GPU lanes.

The mechanical core: a Bend program compiles to an HVM2 net (a graph of typed nodes with directed ports). The runtime repeatedly scans for **active pairs** (two nodes whose principal ports are connected) and rewrites each pair according to its interaction rule. Because interaction-combinator semantics guarantee that disjoint active pairs never interfere, the runtime can fire thousands of rewrites in parallel without locking, scheduling, or memory-ordering subtleties. HVM2's CUDA backend executes one rewrite per warp lane on Nvidia GPUs; the C backend uses atomics on x86-64 multicore. The published 2024 paper reports near-linear speedup with core count on benchmarks ranging from list operations to symbolic differentiation — workloads with no parallel annotations of any kind.

The trade-off is real and worth naming: interaction-net evaluation pays a constant-factor overhead vs ordinary execution (every operation is a graph rewrite, not an inline machine instruction), so a sequential Bend program is slower than a sequential C program even on one thread. The bet is that on workloads with abundant intrinsic parallelism, the GPU's thousands of lanes more than compensate. Distinct from Cilk-style work stealing (§3.3), which still requires programmers to identify spawnable tasks; distinct from OpenMP pragmas (§3.9), which require declaring loop-parallel regions; distinct from data-parallel languages (Halide, Triton — `COMPILERS.md §15`), which require expressing computation as parallel array kernels. HVM2's contribution is making **arbitrary higher-order functional programs** parallel without the programmer naming the parallelism.

Status (as of 2026-04): Bend is research-grade; the standard library is small, ecosystem is nascent, and the constant-factor cost makes it unsuitable for the kind of fine-grained sequential code Rust or C target. As an existence proof that a non-explicit-parallelism programming model can scale to GPUs without programmer annotation, however, it is the most original parallel-runtime data point of the 2020s. The compile-target IR (interaction combinator graphs) is treated separately in `REPRESENTATIONS.md §13.11`; the GPU compilation pipeline angle is in `COMPILERS.md §15.6`.

Sources: https://github.com/HigherOrderCO/Bend and https://github.com/HigherOrderCO/HVM2 and https://raw.githubusercontent.com/HigherOrderCO/HVM/main/paper/HVM2.pdf and https://higherorderco.com/

### 3.12. ActiveJ Eventloop + Workers — Primary/Worker Reactor Topology on the JVM

ActiveJ (SoftIndex Lab; current v6.0-rc2) takes a Node.js-shaped single-threaded event-loop reactor and combines it with a **multi-reactor balancing topology** that sits between pure event-loop schedulers (§3.4) and full M:N goroutine runtimes (§3.2). The `Eventloop` class is a single-threaded NIO reactor with a tick loop, a task queue, scheduled-task heap, and `Selector.select()` as the only blocking call — structurally identical to Node.js's libuv loop or a single-threaded Tokio runtime. What's distinctive is the topology layered above.

The **Workers + WorkerPoolModule** mechanism splits an application into a **Primary Reactor** thread and N **Worker Reactor** threads. The Primary accepts incoming connections on listen sockets via `PrimaryServer`, then redistributes each accepted socket to a worker via thread-safe handoff; each Worker runs its own independent `Eventloop` in its own OS thread, processes the I/O for the connections it owns, and never shares mutable state with other workers. Cross-worker communication is by message passing (`Reactor.submit()` posts a task to another reactor's queue) plus thread-safe singleton services injected via the DI graph. Because workers don't share heap state, there is no per-request synchronisation; because each worker runs a single thread, there is no within-worker concurrency to coordinate.

The architectural contribution is a *clean middle point* between four neighboring designs:

- **Single eventloop (§3.4)**: one thread, one loop, one core. Node.js, single-threaded Tokio. ActiveJ is one-step richer: many independent eventloops, one per worker, balanced by a primary.
- **M:N goroutines (§3.2)**: many goroutines multiplexed across worker threads, but with a *shared heap* and runtime-stolen work. ActiveJ rejects the shared heap and the work-stealing scheduler.
- **Akka actors (§6.7)**: many actors, each single-threaded internally, message-passing. ActiveJ's workers behave identically *at the worker boundary*, but each worker is an Eventloop with arbitrary code rather than an actor with a mailbox.
- **Erlang/BEAM (§6.2)**: many isolated lightweight processes per scheduler. ActiveJ has fewer, heavier units (one per OS thread) but the same isolation guarantee.

The trade-off position: ActiveJ commits to **per-worker single-threaded code with no within-worker concurrency**, in exchange for **cross-worker isolation without runtime overhead**. The Primary Reactor handles connection-level load balancing; each Worker handles its connections with the latency and predictability of a single-threaded Node.js process; multi-core scaling comes from running N workers, not from concurrent execution within one worker. The DI integration (`@Provides @Worker Foo perWorker(...)` versus `@Provides Foo singleton(...)`) makes the worker-vs-shared distinction part of the application's typed dependency graph rather than a runtime convention.

Status (as of 2026-04): production-stable; v6.0-rc2 ships under Apache 2.0 from io.activej Maven coordinates. Used inside SoftIndex Lab products and a small population of external Java teams that have adopted the framework over Spring/Vert.x. The benchmark claim "millions of HTTP requests per second per server" matches this topology — N workers each running a single-threaded eventloop scale linearly with cores up to roughly the number of cores on the box.

The compiler-side techniques that make ActiveJ's hot paths competitive — runtime bytecode generation via ActiveJ Codegen and instance-to-static-class rewriting via ActiveJ Specializer — live in `COMPILERS.md §13.10` and `COMPILERS.md §17.4`. The runtime topology described here is independent of those techniques; a language designer could adopt the primary/worker topology without the codegen + specializer stack, or vice versa.

The lesson generalises: **for I/O-bound services where per-request isolation is the dominant correctness concern**, the primary/worker topology over isolated single-threaded reactors is a viable alternative to both shared-heap M:N runtimes (Go, Tokio multi-thread) and full actor systems (Akka, BEAM). The framework gets multi-core scaling from horizontal worker replication rather than from intra-worker concurrency, eliminating an entire class of races and synchronisation bugs in exchange for slightly higher coordination cost when work *must* cross worker boundaries.

Sources: https://activej.io/async-io/eventloop and https://activej.io/boot/workers and https://activej.io/ and https://github.com/activej/activej

---

## 4. Async/Await and Futures

Async/await is the dominant stackless approach to concurrent code: a future or promise represents an eventual result, and an executor drives suspended computations to completion via poll/wake or callback chains. This chapter focuses on the runtime contract — laziness vs eagerness, polling discipline, blocking hazards, and the propagation of async-ness through APIs — while leaving compiler-side state-machine lowering to `COMPILERS.md`. C++20 coroutines (§4.7) and C++26's `std::execution` senders/receivers (§4.8) cover the C++ end of this design space, where library-customisable promise types and value-level sender composition occupy distinct points relative to Rust futures and Go goroutines.

### 4.1. Futures and promises

A future represents a computation that may produce a value later. A promise is often the write side that completes a future. Some languages make futures eager; others make them lazy.

Rust futures are lazy: nothing happens unless an executor polls them. This design gives zero runtime dependency in the standard abstraction but requires an executor and explicit wakeups. Source: https://rust-lang.github.io/async-book/02_execution/04_executor.html

### 4.2. Poll/wake execution

In poll/wake systems, asynchronous resources store a waker and call it when progress may be possible. The executor then polls the task again. This avoids blocking worker threads on each resource.

The Rust `Future` trait's `poll` method receives `Pin<&mut Self>` and a `Context` containing a `Waker`; `poll` should return quickly and must not block. Source: https://doc.rust-lang.org/stable/std/future/trait.Future.html

### 4.3. Async function lowering

Stackless async functions are typically compiled into state machines, with each suspension point storing local state in the future object; this makes allocation explicit at the cost of large state machines and pinning constraints when self-references are possible. Compiler-side lowering, optimization, and code-generation details belong in `COMPILERS.md`; this section flags only the runtime consequences (heap layout, pinning at `await`, resumption discipline). Source: https://doc.rust-lang.org/stable/reference/expressions/await-expr.html

### 4.4. Async coloring and API propagation

Stackless async often colors APIs: a function that awaits must itself be async, and callers must await it. This makes suspension explicit and helps compilers and readers, but retrofitting async into a large synchronous API can be painful.

Virtual-thread and fiber systems choose the opposite trade-off: blocking-looking APIs can suspend the logical task without requiring the caller to become async. The runtime and standard library must then ensure that blocking operations unmount or park only the logical task, not the carrier thread. Continuation-based languages such as Raku take a similar uncoloured-await stance (see §11.6).

### 4.5. Blocking in async runtimes

Blocking a worker thread in an async runtime can starve unrelated tasks. Practical runtimes provide escape hatches: blocking thread pools, `spawn_blocking`, `block_in_place`, or annotations that let the scheduler compensate.

Tokio's task docs explain that tasks should not perform blocking syscalls and provide APIs for running blocking work in an asynchronous context. Source: https://docs.rs/tokio/0.2.9/tokio/task/index.html

### 4.6. Elm tasks and effect managers — constrained functional asynchrony

Elm is an instructive contrast to richer async systems. A `Task` in Elm is a description of asynchronous work that can later be turned into a command. The standard sequencing primitives are intentionally simple, and the runtime keeps a tight grip on how effects enter the system. Historically, Elm's broader FRP design also used type-level restrictions — such as ruling out higher-order signals — to keep the concurrent/reactive runtime manageable.

The lesson is that a functional language can deliberately under-express concurrency in order to preserve runtime simplicity and predictable UI semantics. This is the opposite of the "maximally expressive substrate" approach seen in GHC or effect-handler languages.

Sources:

- https://elm-lang.org/assets/papers/concurrent-frp.pdf
- https://github.com/elm/core/blob/master/src/Task.elm

### 4.7. C++20 Coroutines — Library-Customisable State Machines

C++20 added stackless coroutines via `co_await`, `co_yield`, and `co_return`. The compiler transforms any function containing one of these keywords into a state machine stored in a heap-allocated **coroutine frame**. The novelty relative to other stackless designs (Rust §1.3, §4.1; Swift §2.7) is that the language ships **no built-in task or generator type**: instead, a user-defined `promise_type` controls allocation, the return-object construction, suspension behaviour, exception propagation, and completion semantics. Awaitable types and awaiter customisation points let any user library define what `co_await expr` does.

The trade-off is library expressivity vs ecosystem fragmentation. C++ exposes the entire state-machine transformation as customization points, enabling zero-allocation coroutines (custom allocators on the promise type), structured-concurrency frameworks (cppcoro `task`, asio awaitables, boost.cobalt), generators, lazy futures, channels, and async-iterators — all as ordinary library code. The cost is that every framework defines its own `task<T>` / `generator<T>` / `lazy<T>`, and they do not interoperate cleanly. Compare Rust, where `Future` is one trait and async fn always desugars to one shape: less expressive, more uniform.

The C++ coroutine ABI is also distinctive. By default each coroutine frame is heap-allocated through `operator new` (overridable per `promise_type`); the compiler is *permitted but not required* to elide the allocation when the coroutine's lifetime is statically bounded — Heap Allocation Elision Optimisation (HALO). Status (as of 2026-04): HALO support varies across GCC, Clang, and MSVC; programs requiring elision typically write inline awaiters and avoid `co_await` across function boundaries. C++23 added `std::generator` as the first standardised coroutine type; broader standardisation is in §4.8.

Sources: https://en.cppreference.com/w/cpp/language/coroutines and https://lewissbaker.github.io/ and https://en.cppreference.com/w/cpp/coroutine/generator

### 4.8. C++26 `std::execution` — Senders, Receivers, and Schedulers

P2300 (Hoekstra, Niebler, Lemire et al., voted into C++26 in 2024) standardises a generic asynchronous-composition model independent of coroutines. **Senders** represent async operations as values; **receivers** consume their results; **schedulers** decide where work runs. Composition is via algorithms (`just`, `then`, `when_all`, `let_value`, `transfer`, `bulk`, `into_variant`) that build a **graph of senders** before any work starts. The graph runs only when a receiver is connected via `start(connect(sender, receiver))`, which materialises an **operation state** the runtime drives.

The model deliberately separates *what* (the sender graph) from *where* (the scheduler), so the same composition can run on a thread pool, a single-threaded loop, GPU streams, system queues, or distributed runtimes. Cancellation flows through the graph as a first-class concern via stop tokens; structured concurrency falls out because senders compose hierarchically and a parent's lifetime bounds its children's. Distinct from C++20 coroutines (§4.7): senders/receivers is a **value-level composition language**, not a transformation. A whole async pipeline can be assembled as one expression, type-checked, and submitted to a scheduler — closer to dataflow than to imperative awaits.

Algorithms can adapt: `then(s, f)` returns a new sender; `when_all(s1, s2)` waits for both; `let_value(s, λ)` continues with a derived sender once `s` completes. The result is that frameworks compose without adapter shims, and the same algorithms work over CPU, GPU, and distributed schedulers if those schedulers expose the receiver/operation-state contract. NVIDIA's stdexec is the reference implementation; production usage is just emerging.

Status (as of 2026-04): voted into C++26 working draft. Adoption requires the standard library and is gated on compiler+library version availability. The design is the strongest current example of "structured concurrency as a value-composition algebra" rather than as a coroutine-transformation feature.

Sources: https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2024/p2300r10.html and https://github.com/NVIDIA/stdexec and https://en.cppreference.com/w/cpp/execution

### 4.9. C# `async`/`await` — Eager Tasks and SynchronizationContext

C# was the first mainstream language to ship `async`/`await` as a first-class language feature (.NET 4.5, 2012, designed by Anders Hejlsberg, Mads Torgersen, and Stephen Toub). The compiler transforms an `async` method into a state machine implementing `IAsyncStateMachine`; `await expression` calls the awaiter's `GetAwaiter().GetResult()` if synchronously complete, or schedules continuation via `ICriticalNotifyCompletion.UnsafeOnCompleted` if asynchronous. The transform is conceptually similar to Rust's async fn lowering (§4.2) and C++20 coroutines (§4.7), but materialises a different runtime contract.

The distinguishing mechanism is **`Task<T>` plus `SynchronizationContext`**. A `Task` is the **eager, hot-by-default** future analogue (vs Rust's lazy Futures §4.2). When code `await`s, the runtime captures the current `SynchronizationContext` (UI thread, ASP.NET request, custom domain) and posts the continuation back onto it after the async operation completes. This solves the "I awaited a network call, now I'm on a thread-pool thread but my UI code expects the main thread" problem at the language level — `await` automatically returns to the captured context.

Key design points:

- **`ConfigureAwait(false)`**: opt-out of context capture, used pervasively in library code where context-capture overhead is unwanted and library callers may not have a context. The asymmetry — capture by default, opt out per call site — is one of the most-debated C# async ergonomic choices.
- **`ValueTask<T>`** (added .NET Core 2.0): zero-allocation alternative to `Task<T>` for the synchronous-completion case. Stack-allocated wrapper that materialises a real Task only on async completion. Comparable to Rust's `Poll::Ready` fast path but as a separate type.
- **`async` over `IAsyncEnumerable<T>` + `await foreach`**: language-level async iterators (.NET Core 3.0, 2019), comparable to Rust's `Stream` trait but with built-in compiler support and `await foreach` syntax.
- **`Channel<T>`**: standard library bounded MPSC/SPMC channel for in-process producer/consumer patterns.

Distinct from Rust futures (§4.2): C# Tasks are *eager* (running the moment they are created), while Rust Futures are *lazy* (running only when polled). The eager model removes the "forgot to `await`" footgun (the task runs anyway) but adds the "fire-and-forget without awaiting" footgun (exceptions disappear if not awaited; CLR re-throws them on finaliser thread, terminating the process by default). Distinct from C++20 coroutines (§4.7): C# bakes `Task` as the canonical async type into the language, where C++ leaves the async type to libraries. Distinct from Go (§3.2): no goroutines / direct stackful equivalent — async is the only first-class concurrency primitive at the language level.

The 2012 C# async/await is the design template most subsequent languages followed: Python `asyncio` (2014), Hack/PHP `await` (2014), JavaScript `async`/`await` (ES2017, 2017), Swift `async`/`await` (Swift 5.5, 2021), Rust `async fn` stable (1.39, 2019). Each made different lazy-vs-eager and context-capture choices, and each faces an analogous version of the "what colour is your function?" debate.

Status (as of 2026-04): production at massive scale — entire ASP.NET Core ecosystem, Azure SDK, Roslyn, Visual Studio. .NET 8+ continues evolving with **AOT-compatible async** (`async` works under AOT compilation without runtime codegen) and **`async` over interface methods** (default interface members can be async).

Sources: https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/ and https://devblogs.microsoft.com/dotnet/how-async-await-really-works/ and https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext

---

## 5. Stackful Coroutines, Fibers, Continuations, and Virtual Threads

This chapter covers execution units that preserve a logical call stack across suspension: stackful fibers, delimited continuations, virtual threads, and the implementation hazards (pinning, FFI, GC scanning) common to all of them. OCaml 5's domains-plus-effect-handlers split is treated in detail as a representative effect-handler runtime.

### 5.1. Stackful fibers

A fiber has its own stack or stack segment and can suspend with an ordinary call stack intact. This makes synchronous-looking code natural and helps retrofit existing APIs. Costs include stack allocation, stack growth, stack scanning for GC, and foreign-call pinning. (For the OCaml 5 fiber implementation as effect-handler substrate, see §5.5.)

### 5.2. Delimited continuations

Delimited continuations capture the rest of a computation up to a prompt or handler. They are a powerful substrate for generators, coroutines, async/await, green threads, and effect handlers. Raku's await uses one-shot stackful continuations as a non-blocking implementation strategy (see §11.6).

WasmFX / typed continuations aims to extend WebAssembly with structured non-local control flow for efficient compilation of async/await, generators, continuations, and effect handlers. Source: https://wasmfx.dev/specs/explainer/

### 5.3. Virtual threads

Virtual threads make the thread abstraction cheap enough to use per request or per task. They preserve blocking-style code while moving scheduling into the runtime.

Status (JDK 21+, final): Java virtual threads mount on a carrier platform thread while running and unmount when yielding or blocking in supported operations; they do not preserve affinity to a particular carrier thread. (For the inline source see §1.2; full reference in Chapter 5 References.)

### 5.4. Pinning and blocking hazards

Virtual-thread and fiber systems must handle operations that cannot safely unmount: native calls, monitor regions, critical sections, or runtime-internal pinned states. If a virtual thread is pinned while blocking, its carrier may be blocked too, reducing scalability (see §5.3 for the underlying mount/unmount model).

Status (Loom integration branch, may move as work merges): OpenJDK Loom implementation discussions and code expose concepts such as continuations, carrier threads, and pinned reasons. Source: https://github.com/openjdk/loom/blob/fibers/src/java.base/share/classes/java/lang/VirtualThread.java

### 5.5. OCaml 5 — domains, fibers, and effect-handler concurrency

OCaml 5 is especially important because it separates **parallelism** from **concurrency substrate**. Domains are the unit of parallel execution, while effect handlers and heap-allocated fibers support user-level concurrency abstractions such as lightweight threads, generators, and asynchronous I/O. This is a different decomposition from both GHC and Loom.

Another useful lesson is that OCaml's effect handlers are runtime-backed but **not statically effect-safe** in the stock language — that is, the type system does not track which functions may perform or handle which effects, so unhandled effects manifest at runtime rather than as type errors. The concurrency substrate is therefore powerful and composable, but the burden of disciplined use falls more on library design and runtime semantics than on the type checker.

Sources:

- https://ocaml.org/manual/effects.html
- https://kcsrk.info/papers/retro-concurrency_pldi_21.pdf

---

## 6. Actors, Mailboxes, and Supervision

Actor systems treat the unit of concurrency as an isolated entity with its own mailbox, processing one message at a time. This chapter surveys the major design axes — mailbox semantics, supervision, reentrancy, isolation guarantees — using Erlang/BEAM, Swift, Pony, ActorForth, Akka, and Orleans as representative points. Akka (§6.7) and Orleans (§6.8) cover the production-managed-runtime end of the design space (JVM and .NET respectively); Erlang/BEAM (§6.2) is the canonical share-nothing reference; Pony (§6.5) takes the static-data-race-freedom path; Swift (§6.4) layers actor isolation on a GC/ARC base; ActorForth (§6.6) shows actors over a concatenative core. Pony's reference-capability story, which straddles concurrency and type-system territory, is canonical in §10.3.

### 6.1. Actor model basics

An actor owns state, processes one message at a time, and communicates by sending messages. This gives a clear isolation boundary: actor-local mutable state does not require locks if only the actor can touch it.

Actor systems differ on whether messages are ordered, typed, selective, bounded, durable, distributed, priority-aware, or supervised. Bounded mailboxes give producers a backpressure signal; unbounded mailboxes shift the failure mode to memory growth (see §7.3 for backpressure mechanisms generally).

### 6.2. Erlang/BEAM processes

Erlang processes are lightweight units managed by BEAM, not OS processes. Each has its own message queue; `receive` scans messages against patterns. Selective receive is expressive but means mailbox scanning can become a performance concern.

Source: https://www.erlang.org/doc/system/conc_prog.html

### 6.3. Supervision and fault containment

Erlang's deepest concurrency lesson is not only actors but supervised failure: processes can crash independently, supervisors restart children, and links/monitors make failure visible. A language runtime can treat failure propagation as part of the concurrency model rather than an afterthought.

### 6.4. Swift actors and reentrancy

Status (Swift 5.5+): Swift actors provide data isolation: mutable actor state is protected so only one thread accesses it at a time. Actor-isolated functions are reentrant; if a function suspends, other work may run on the actor before it resumes, so invariants must not be assumed across `await` without care.

Source: https://github.com/apple/swift-evolution/blob/main/proposals/0306-actors.md

### 6.5. Pony actors and reference capabilities

From the mailbox angle, Pony checks message payloads against reference-capability constraints so isolated or immutable data can cross the actor boundary without copying (see §10.3 for the sharing mechanism; `TYPES.md` for type rules).

### 6.6. ActorForth — typed stack language meets actors

ActorForth combines a Forth-style concatenative core with static stack-type bookkeeping and BEAM-style actor semantics, suggesting that concatenative execution and actor isolation are not inherently incompatible. Source: https://github.com/ActorForth/ActorForth/blob/master/docs/IntroToActorForth.md

### 6.7. Akka — Production Actors on the JVM

Lightbend's **Akka** (Scala/Java, Jonas Bonér et al., 2009+) is the dominant production actor system on managed runtimes. Each Akka actor is a lightweight object with a typed mailbox; actors are organised hierarchically through a **supervision tree** where a parent decides on each child's failure (restart, resume, stop, escalate). Akka's **Typed API** (since 2.6, 2019) enforces compile-time message-type contracts via `Behavior[T]`; the older untyped API exchanged untyped `ActorRef`s that accept `Any`.

Distinct from BEAM actors (§6.2): Akka runs on the JVM with shared-heap memory, so actor isolation is by convention — actors are encouraged to keep state private but the language does not enforce it. Distinct from Pony (§6.5, `MEMORY.md §10.3`): no reference-capability discipline statically prevents data races across actor boundaries. The compromise is that Akka inherits the JVM's GC, JIT, and ecosystem in exchange for requiring programmer discipline for race-freedom and immutability.

**Akka Cluster** adds distribution: actors form a peer-to-peer cluster with gossip-based membership, leader election via Cluster Singleton, partitioning via Cluster Sharding (location-transparent actor names sharded by key over consistent hashing), and at-most/at-least/effectively-once delivery via **Akka Persistence** (event sourcing) and durable mailboxes. Cluster Sharding is the load-bearing primitive that lets a typical Akka deployment treat "millions of independent stateful entities" as a routing problem rather than a per-node-state problem.

Status (as of 2026-04): production at scale — Twitter/X infrastructure, PayPal, eBay, Norwegian Cruise Line, several telecom platforms. Akka 2.7+ moved to a Business Source License from Apache 2.0 in 2022, prompting **Apache Pekko** (Apache Incubator) to fork the last Apache-licensed release. The licensing change is the most consequential ecosystem event in the actor space since BEAM's open-source release.

Sources: https://akka.io/ and https://doc.akka.io/docs/akka/current/typed/actors.html and https://github.com/apache/incubator-pekko

### 6.8. Orleans — Virtual Actors and Runtime-Managed Activation

Microsoft Research's **Orleans** (Bykov, Geller, Kliot, Larus, Pandya, Thelin — OSDI 2014) introduced the **virtual actor** model. A *grain* (Orleans's actor) has a logical identity (typically a key — `UserId 12345`) that exists conceptually forever, regardless of whether any instance is currently running. The runtime materialises a grain on demand on whichever silo (server) has capacity, **deactivates** it after idle, persists state via a configured storage provider, and resurrects it on the next call. Activations are entirely runtime-managed.

The novelty vs Akka (§6.7) and BEAM (§6.2) is that **the developer never explicitly creates or destroys actors**: calling `GrainFactory.GetGrain<IUser>(12345)` returns a proxy whose lifecycle is the runtime's concern. This eliminates whole categories of bugs — orphan references, location tracking, actor restart-after-crash, supervisor-tree configuration — that traditional actor frameworks expose. Cluster sharding is implicit: any silo can hold any grain, and the directory layer routes calls to the active silo.

Trade-off: virtual actors cost more per call (silo resolution, possible activation, possibly persistence load) than direct actor refs. The model fits **stateful services with very large numbers of independent entities mostly idle** — multiplayer game lobbies, IoT device twins, per-user session state, financial-account aggregates — where most entities are inactive most of the time and the runtime can pack live activations onto a small fraction of the cluster. For workloads where every entity is hot continuously, traditional actors (Akka, BEAM) are cheaper.

Status (as of 2026-04): production at Halo 4 / 5 / Infinite (343 Industries), Microsoft Skype (historical), Honeywell, Mesh Systems, the Microsoft Gaming Cloud. Orleans 7+ adds nullable reference types, AOT compatibility, and improved streaming providers. The lesson generalises beyond .NET: location-transparent virtual identities plus runtime-managed activation is the cleanest production answer to "how do I run a billion stateful entities on a hundred machines?"

Sources: https://learn.microsoft.com/en-us/dotnet/orleans/ and https://www.microsoft.com/en-us/research/wp-content/uploads/2014/12/Orleans-MSR-TR-2014-41.pdf and https://www.usenix.org/conference/osdi14/technical-sessions/presentation/bernstein

---

## 7. Channels, CSP, and Message-Passing Coordination

Channels and CSP-style communication unify communication with synchronization: a send and a receive together constitute the rendezvous. This chapter covers channel buffering, `select`-style alternatives, backpressure policy, the additional concerns introduced by distributed transports, the Forth tradition of small cooperative-task runtimes built around `PAUSE` and explicit mailboxes, the **LMAX Disruptor** as a mechanical-sympathy ring buffer for low-latency producer/consumer pipelines, and **Reactive Streams** as a distinct demand-driven backpressure-first paradigm with its own composition algebra.

### 7.1. Channels as synchronization points

Channels combine communication and synchronization. They may be unbuffered, bounded, or unbounded. Unbuffered channels force rendezvous; bounded channels provide backpressure; unbounded channels avoid sender blocking but can hide overload until memory grows.

Go channels are often paired with goroutines to express CSP-like communication. The scheduler and netpoller make blocking channel and I/O operations suspend goroutines rather than OS threads in ordinary cases.

### 7.2. Select and alternatives

A `select` or alternative construct waits on multiple communication operations. Implementation choices include randomization for fairness, priority ordering, registration with wait queues, cancellation safety, and avoiding lost wakeups.

### 7.3. Backpressure

Backpressure is a first-class concurrency concern. Without it, fast producers can overwhelm slow consumers. Mechanisms include bounded queues, demand signals, credit-based protocols, async streams, supervision policies, and load shedding.

### 7.4. Distributed message passing

Distributed actors and channels must confront serialization, versioning, network partitions, retries, ordering, identity, authentication, and rolling upgrades. The local concurrency abstraction rarely survives unchanged across the network boundary.

### 7.5. Forth family concurrency — cooperative tasks, mailboxes, and CSP-style channels

Traditional Forth systems have long supported multitasking through a small round-robin scheduler, an explicit `PAUSE` word, and mailbox or channel words for synchronization, with optional timesliced or interrupt-driven preemption layered on top. The design lesson is that concurrency can begin with a tiny cooperative runtime optimized for predictability, embedded deployment, and programmer-visible scheduling rather than transparent suspension. Source: https://gforth.org/manual/Pthreads.html

### 7.6. LMAX Disruptor — Mechanical-Sympathy Ring Buffer

Martin Thompson, Dave Farley, and the LMAX Exchange team developed the **Disruptor** (2010) for an order-matching platform that needed sub-millisecond latency and tens of millions of transactions per second. The mechanism is a single-producer-multi-consumer ring buffer with mechanical-sympathy-driven design:

- **Cache-line padding around sequence counters** to avoid false sharing between the producer's claim cursor and consumer cursors.
- **Lock-free progress via atomic sequence numbers**: producers claim a slot by incrementing a sequence; consumers wait for the producer's sequence to advance past their own; no locks, no channels, no `wait`/`notify`.
- **Dependency graphs between consumers**: "consumer C2 may only process slot N after consumer C1 has". The graph is declared statically as a small DAG of consumer barriers; the runtime composes wait strategies along it.
- **Pre-allocated event objects**: the ring slots are mutable event objects allocated once at startup. Producers write into them in place; consumers read from them in place. No per-event allocation, no GC pressure.

LMAX reported six million transactions per second on a single matching-engine thread. The Disruptor pattern has been adopted in financial trading platforms, **log4j2's async appender**, **Apache Storm**, **Aeron messaging**, and **Disruptor.NET**. The architectural lesson is that **a single ring buffer plus careful cache-line awareness can replace queues, lock-based handoff, and the GC pressure of allocating message objects** for workloads where the producer/consumer arrangement is statically known.

Distinct from CSP-style channels (§7.1): the Disruptor doesn't decouple senders from receivers — it's a coordinated dataflow where consumers explicitly track each other's progress. Distinct from actor mailboxes (§6): zero allocation per event, and the consumer dependency graph is statically declared rather than dynamic. The trade-off is that the Disruptor is not a general-purpose IPC mechanism; it pays off when latency and throughput dominate flexibility.

Status (as of 2026-04): production-stable since 2010, still actively used in low-latency financial systems, real-time telemetry, and high-throughput logging.

Sources: https://lmax-exchange.github.io/disruptor/disruptor.html and https://martinfowler.com/articles/lmax.html and https://github.com/LMAX-Exchange/disruptor

### 7.7. Reactive Streams — Demand-Driven Backpressure as a Coordination Paradigm

The **Reactive Streams** specification (initiated by Lightbend, Pivotal, Netflix, Twitter et al., 2013–2015; absorbed into JDK 9 as `java.util.concurrent.Flow`) is a **demand-driven, backpressure-first** coordination paradigm distinct from CSP channels (§7.1), actors (§6), and senders/receivers (§4.8). The defining mechanism is that subscribers explicitly **request** N elements from publishers; publishers must not produce more than the cumulative requested count. Backpressure is the default, not an opt-in.

The four-interface protocol is small and minimal:

- `Publisher<T>` — accepts a Subscriber via `subscribe(Subscriber<T>)`.
- `Subscriber<T>` — receives `onSubscribe(Subscription)`, then `onNext(T)` / `onError(Throwable)` / `onComplete()` events.
- `Subscription` — `request(long n)` and `cancel()`.
- `Processor<T,R>` — both Publisher and Subscriber, used for transformations.

Production implementations on the JVM:

- **Project Reactor** (Pivotal/VMware) is the Spring WebFlux substrate. `Flux<T>` (0..N elements) and `Mono<T>` (0..1 element) are the core publisher types; ~250 operators (`map`, `flatMap`, `filter`, `merge`, `zip`, `buffer`, `window`, `retry`, `timeout`, ...) compose pipelines.
- **RxJava** (Netflix) was the original JVM reactive library and remains widely used; Rx 1.x predates Reactive Streams, Rx 2/3.x conform.
- **Akka Streams** (Lightbend) layers reactive streams over the Akka actor system (§6.7), with materialisation to a graph-of-actors execution.
- **Mutiny** (Quarkus) is Red Hat's alternative with a smaller operator surface and explicit cancellation handling.

Outside JVM: **RxJS** (JavaScript), **RxSwift**, and **ReactiveX** family ports are conceptual descendants but predate or diverge from the formal Reactive Streams contract.

The architectural lesson is that **demand-driven backpressure is a different coordination paradigm**, not a feature you bolt onto channels or actors. CSP channels (§7.1) push the backpressure question onto the buffer-size choice; actors (§6) onto mailbox-overflow policy; reactive streams onto explicit per-subscription request semantics. The composition algebras differ accordingly: reactive streams compose via per-subscription operators, so a pipeline reads as a value-level expression — comparable to C++26 senders/receivers (§4.8) but for streams rather than single async values.

Trade-off: reactive streams add **operator-stack debugging cost** (a stack trace through 12 reactive operators is hard to read; production tooling like Reactor's checkpoint operator and BlockHound exist precisely to address this) and **cancellation-correctness complexity** (cancelling a multi-stage pipeline requires every operator to honour cancellation signals propagating upstream). Distinct from senders/receivers (§4.8): reactive streams are designed for unbounded data flow with backpressure; senders/receivers are designed for single async results.

Status (as of 2026-04): production at huge scale across Spring (Reactor), Netflix services (RxJava, then Reactor), Akka deployments (Akka Streams). The paradigm is mature enough that the JDK absorbed the four interfaces as `java.util.concurrent.Flow` in JDK 9 (2017). For a new language with channels, the design question is whether to standardise a backpressure protocol at the language level (the Reactive Streams choice) or leave it to library-level convention (the Go choice).

Sources: https://www.reactive-streams.org/ and https://projectreactor.io/ and https://github.com/ReactiveX/RxJava and https://doc.akka.io/docs/akka/current/stream/

---

## 8. Structured Concurrency and Cancellation

Structured concurrency turns task lifetime into a syntactic property: children are scoped to a parent block, and cancellation/failure flow through the resulting tree. This chapter surveys nurseries, task groups, cancellation semantics (cooperative vs asynchronous), async-aware cleanup, and the unstructured escape hatches every practical system still needs for daemons and detached work.

### 8.1. Task trees

Structured concurrency organizes tasks into a tree. A parent scope starts children, waits for them, and owns their cancellation and failure propagation. This reduces leaks, orphan work, and invisible background failures.

Java's structured concurrency JEP describes subtasks as working on behalf of a task, with well-defined entry and exit points and lifetimes nested like syntactic blocks. Source: https://openjdk.org/jeps/428

### 8.2. Nurseries and task groups

Trio nurseries, Swift task groups, Kotlin coroutine scopes, and Java structured task scopes all enforce variants of the same rule: children do not outlive their scope.

Swift task groups wait for all child tasks before the group is destroyed, and cancellation propagates through child tasks cooperatively. Source: https://developer.apple.com/documentation/swift/taskgroup

### 8.3. Cancellation semantics

Cancellation may be:

- cooperative, observed at await/yield/checkpoint points;
- asynchronous, delivered by exception or signal;
- explicit through tokens;
- lexical through cancel scopes;
- implicit through parent failure;
- best-effort, advisory, or mandatory.

Cooperative cancellation preserves cleanup and invariants but cannot stop CPU-bound or blocked code unless it checks cancellation. Asynchronous cancellation is more forceful but can violate invariants if it interrupts arbitrary code.

### 8.4. Cleanup and async destructors

Concurrent systems need cleanup that can itself await: closing network connections, flushing buffers, joining tasks, or releasing distributed leases. Languages with synchronous destructors struggle here.

The Rust async book notes that dropping futures can cancel owned child futures, but spawned tasks require explicit handles/signals; Rust's lack of async destructors complicates asynchronous cleanup. Source: https://rust-lang.github.io/async-book/part-reference/structured.html

### 8.5. Unstructured escape hatches

Every practical system needs unstructured tasks for daemons, servers, top-level event loops, background indexing, and detached work. The key is to make unstructured concurrency explicit, observable, cancellable, and rare by default.

---

## 9. Synchronization, Shared State, and STM

Shared-memory coordination spans a spectrum from low-level locks and atomics to high-level transactional and lock-free abstractions. This chapter focuses on the runtime mechanics — parking discipline, scheduler integration, transaction commit/retry semantics, and lock-free queue requirements — while leaving memory-model formalisms to `MEMORY.md` and type-level effect tracking to `TYPES.md`.

### 9.1. Locks and mutexes

Locks are the baseline shared-memory coordination primitive. They are simple, efficient, and compatible with existing code, but are prone to deadlocks, priority inversion, lock convoying, and accidental blocking inside async runtimes.

A language/runtime should decide whether locks block OS threads, park user tasks, integrate with cancellation, or participate in priority inheritance.

### 9.2. Atomics and memory ordering

Atomics provide low-level synchronization through memory-ordering rules. They are necessary for runtimes, lock-free queues, reference counts, and high-performance coordination, but they are difficult for application programmers.

Full memory-model discussion belongs in `MEMORY.md`; this document cares about atomics as scheduler and synchronization building blocks.

### 9.3. Condition variables, semaphores, and parking

Condition variables and semaphores block until another thread signals. In user-mode runtimes, these primitives should usually park the logical task rather than the worker thread. Go's `gopark` and `goready` are runtime primitives for removing and re-adding goroutines to the scheduler run queue. Source: https://go.dev/src/runtime/HACKING.md

### 9.4. Software Transactional Memory

STM lets code group memory operations into transactions that commit atomically or retry. It composes better than locks because transactions can be combined without manually imposing a global lock ordering.

Haskell STM provides `TVar`, `atomically`, `retry`, and `orElse`; Clojure refs provide coordinated changes within `dosync` transactions using persistent data structures to make speculative updates cheap. Sources: https://haskell.org/ghc/docs/latest/html/users_guide/exts/stm.html and https://clojure.org/reference/refs

### 9.5. Lock-free and wait-free structures

Lock-free queues, deques, and stacks are central to schedulers and executors. They reduce blocking but increase proof burden and expose memory-reclamation challenges. Work-stealing deques (see §3.3) are a representative case where owner operations should be cheap while steal operations can afford heavier synchronization.

### 9.6. Haskell STM as a coordination mechanism

The coordination angle on Haskell STM is that `retry` and `orElse` provide a different vocabulary from locks or channels: a transaction blocks until watched state changes, rather than explicitly waiting on a condition variable or mailbox. Combined with GHC's cheap lightweight threads (§3.7), this makes a blocking transaction a park of a lightweight computation rather than a sleep of an expensive kernel thread, which broadens the situations where STM is practical. Source: https://haskell.org/ghc/docs/latest/html/libraries/base-4.22.0.0-66f8/Control-Concurrent.html

---

## 10. Data-Race Freedom and Safe Sharing

This chapter covers the runtime side of cross-domain sharing: which values can move between threads, tasks, or actors, and what runtime checks (or lack of them) back the static rules. Type-system formulations of sendability markers, capability kinds, and effect rows belong in `TYPES.md`; ownership and borrowing belong in `MEMORY.md`. The chapter focuses on enforcement at runtime boundaries — actor mounts, message-passing payload checks, and runtime race detectors.

### 10.1. Marker traits and sendability

Sendability markers (Rust's `Send`/`Sync`, Swift's `Sendable`) classify types by whether values or shared references may cross concurrency domains. From a runtime perspective the relevant point is that the check happens when a value is handed to another task, actor message, or thread spawn; the type rules themselves belong in `TYPES.md`. Sources: https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html and https://developer.apple.com/documentation/swift/sendable

### 10.2. Actor isolation

Actor isolation prevents direct unsynchronized access to actor-local mutable state at runtime: only an actor-mounted continuation may touch its instance state, and message payloads must satisfy the language's sendability rules. The runtime-relevant subtlety is reentrancy across `await` (see §6.4 for the Swift treatment).

### 10.3. Reference capabilities

Reference capabilities classify aliases by what they can read, write, or send, and Pony is the canonical example combining capabilities with actors to obtain static data-race freedom while still allowing zero-copy message passing.

The runtime-relevant story is the **sharing mechanism**: capability kinds such as `iso` (unique, sendable), `val` (deeply immutable, freely shareable), `ref` (actor-local, not sendable), `tag` (opaque identity, send-only), and `trn`/`box` (transition forms) determine which message payloads the compiler permits across the actor boundary, and the runtime relies on those guarantees to avoid runtime synchronization on transferred objects. Detailed type rules and subtyping belong in `TYPES.md`. Source: https://www.ponylang.io/media/papers/fast-cheap.pdf

### 10.4. Ownership and borrowing as concurrency controls

Ownership and borrowing can make sharing explicit and statically prevent many races. Full treatment belongs in `MEMORY.md`, but concurrency design must decide whether ownership is only a memory-management feature or also a cross-task sharing discipline.

### 10.5. Runtime race detection

Static race freedom is strong but restrictive. Dynamic race detectors, happens-before tracing, lockset analysis, and scheduler fuzzing are useful complements. Full debugger and tracer treatment belongs in `DEBUGGERS.md` and `TRACERS.md`.

---

## 11. I/O Integration, Timers, and Blocking Boundaries

A concurrency runtime is only as scalable as its I/O integration: the syscall boundary determines which operations park a logical task vs. block a worker, and timers feed the same scheduler decisions. This chapter covers readiness vs completion-based OS interfaces, runtime drivers and netpollers, timer wheel/heap trade-offs, FFI-blocking handling, and Raku as a continuation-based counterpoint to both stackless-future and goroutine-style designs.

### 11.1. Readiness and completion models

I/O integration differs by OS:

- readiness: `epoll`, `kqueue`, many Unix event loops;
- completion: IOCP, `io_uring` completion queues;
- blocking syscalls hidden behind runtime-managed threads;
- hybrid designs.

A concurrency runtime should make the syscall boundary explicit: which calls park a task, which block a worker, and which require a blocking pool?

### 11.2. Go netpoller

Go's network poller integrates non-blocking I/O with the goroutine scheduler: if an fd is not ready, the goroutine parks, the fd is registered with the poller, and a readiness event makes the goroutine runnable again.

Source: https://goperf.dev/02-networking/networking-internals/

### 11.3. Async runtime drivers

Status (as of 2026-04): Tokio describes a runtime as providing an I/O driver, scheduler, and timer. The driver receives OS I/O events, wakes tasks, and lets the scheduler poll ready futures. Source: https://docs.rs/tokio/latest/tokio/runtime/

### 11.4. Timers

Timers are not just library utilities. They affect scheduler sleep decisions, wakeup precision, power usage, and fairness. Runtime timer wheels, heaps, per-worker timers, and OS timers all trade accuracy for overhead.

Go's scheduler source comments mention timer heaps and netpoll interaction when workers are spinning or sleeping. Source: https://go.dev/src/runtime/proc.go

### 11.5. Foreign calls and blocking pools

FFI and native calls may block in ways the runtime cannot observe. Options include:

- require annotation for blocking calls;
- run FFI calls on a blocking pool;
- detach the worker's scheduling token before entering the call;
- pin virtual threads during native calls;
- forbid certain calls in async contexts.

### 11.6. Raku — schedulers, reactive blocks, and continuation-based await

Raku is a useful counterexample to both stackless-future systems and goroutine/virtual-thread systems: Rakudo implements `await` on promises and channels using one-shot stackful continuations, so the awaiting computation can be resumed later without blocking a thread and without forcing async coloring up the call stack. The `Channel` type complements this picture as a non-blocking, effectively unbounded queue — convenient for producers but lacking built-in backpressure, which has to be added at a higher layer (compare §7.3).

Sources:

- https://docs.raku.org/language/concurrency
- https://stackoverflow.com/questions/62817878/what-are-the-specifics-about-the-continuations-upon-which-rakudo-relies/62819961

---

## 12. Runtime Observability and Debuggability

A concurrent runtime must export enough structure to keep tracing, profiling, and debugging tractable: stable task identities, parent/child relationships, suspension sites, scheduler events, and metric counters. This chapter only sketches the runtime-side surface; full debugger workflows belong in `DEBUGGERS.md` and full event-pipeline and trace-format treatment in `TRACERS.md`.

### 12.1. Task identity and spans

Concurrent systems need stable task identities for logs, traces, cancellation, and debugging. A runtime should decide whether task IDs are exposed, inherited, recycled, or hidden behind tracing spans.

Full tracing pipeline treatment belongs in `TRACERS.md`; this document only notes that concurrency runtimes should emit task lifecycle events, wakeups, parks, steals, mailbox growth, timer delays, and cancellation propagation.

### 12.2. Async stack traces

Stackless async and actor systems fragment call stacks. A good runtime records logical parent/child relationships, await suspension points, and task creation sites so debuggers can reconstruct logical stacks.

Debugger-specific workflows belong in `DEBUGGERS.md §9`.

### 12.3. Deterministic replay and scheduler control

Concurrency bugs often depend on interleavings. Testing and debugging benefit from deterministic scheduler modes, randomized schedulers, systematic concurrency testing, replay logs, and controllable task yields.

### 12.4. Runtime metrics

Useful metrics include run queue length, task count, blocked tasks, worker utilization, steal count, mailbox sizes, cancellation latency, timer lag, poll duration, and blocking-pool saturation.

---

## 13. Design Implications for a New Language

The following are recurring trade-offs visible across the surveyed systems, framed as design axes rather than recommendations.

1. Concurrency can be a library feature, a runtime feature, a type-system feature, or any combination; the choice constrains which guarantees are checkable and which are runtime-only.
2. The blocking story shapes the entire runtime: allowing ordinary blocking APIs requires either virtual-thread-style mount/unmount machinery or strict isolation of blocking calls.
3. Structured-concurrency defaults reduce orphan-task and leak surface, at the cost of needing explicit detached escape hatches for daemons, servers, and event loops.
4. Cancellation is more usefully modelled as a protocol with cleanup obligations than as a boolean flag; cooperative variants preserve invariants but cannot stop CPU-bound code, while asynchronous variants are forceful but invariant-hostile.
5. Observable task identity and parentage from day one make tracing, debugging, and supervised failure tractable; retrofitting them later is expensive.
6. Stackless async exchanges runtime simplicity for async coloring of APIs and the need to manage cancellation of spawned tasks; sendability markers (e.g. Rust `Send`/`Sync`, Swift `Sendable`) interact with what spawned tasks may capture.
7. Virtual threads and fibers exchange API simplicity for runtime complexity around pinning, stack scanning, FFI, and debugger integration.
8. Actor models trade lock-based reasoning for choices about mailbox ordering, backpressure, supervision, and reentrancy.
9. Channel designs trade producer simplicity for backpressure clarity (bounded vs unbounded) and need a defined `select` fairness policy.
10. Data-race safety alignment with the type system — sendability markers, ownership, reference capabilities, or actor isolation — is hard to add after a language has shipped.
11. CPU parallelism and I/O concurrency tend to want different APIs and scheduler policies; conflating them in a single primitive forces compromises in both.
12. Runtime hooks for tracing, profiling, and deterministic scheduler testing are easier to add early than retrofit, and they directly enable the debugger and tracer features described in `DEBUGGERS.md` and `TRACERS.md`.

---

## 14. Summary of Concurrency Techniques

The following tables collapse the body chapters into three orthogonal axes — execution-unit choice, coordination mechanism, and safe-sharing strategy — that a language designer must decide independently. Rows are grouped by topical similarity within each axis rather than by body-chapter order, so directly comparable techniques (e.g., goroutines, virtual threads, fibers) sit adjacent. The Examples column anchors back to the body chapter where each technique is treated in detail.

### 14.1. Execution units and scheduling

| Technique | Mechanism | Strength | Cost / risk | Examples |
|---|---|---|---|---|
| OS threads | Kernel-scheduled stacks | Simple FFI and blocking semantics | High per-thread overhead | POSIX threads, Java platform threads (§3.1) |
| M:N goroutines | Runtime maps tasks to OS threads | Many cheap blocking-looking tasks | Runtime complexity | Go G/M/P (§3.2) |
| Virtual threads | Runtime-scheduled thread abstraction | Retrofit blocking style | Pinning and carrier blocking | Java Loom (§5.3) |
| Stackless futures | State machines + poll/wake | Lightweight, explicit suspension | Async coloring, executor burden | Rust futures (§4) |
| Stackful fibers | User-mode stacks | Natural synchronous style | Stack scanning/growth/pinning | OCaml fibers, Loom continuations (§5) |
| Work stealing | Per-worker deques | Good fork-join load balancing | Blocking hurts; deque complexity | Cilk, ForkJoinPool (§3.3) |
| Actor scheduler | Mailboxes + isolated state | Local mutable state without locks | Mailbox growth, reentrancy | BEAM, Pony, Swift actors (§6) |
| Event loop | Ready queue + I/O driver | Efficient I/O concurrency | CPU-bound starvation | libuv, Tokio, JavaScript runtimes (§4, §11) |
| Library-customisable stackless coroutines | `promise_type` + state-machine transform | Full library control of allocation, awaiters, generators | Ecosystem fragmentation; no canonical task type | C++20 coroutines (§4.7) |
| Sender/receiver value-composition model | Async graph as value, scheduler picks where | Decouples *what* from *where*; structured cancellation | Just emerging; ABI/library co-design needed | C++26 `std::execution` (§4.8) |
| Production actor framework on managed runtime | Hierarchical supervision + cluster sharding | Mature ecosystem, ergonomic typed messaging | Race-freedom by convention, not by language | Akka (§6.7) |
| Virtual actors with runtime-managed activation | Logical identity → on-demand silo placement | No explicit lifecycle; billions of mostly-idle entities | Per-call routing/persistence overhead | Orleans (§6.8) |
| OS kernel scheduler | Per-CPU runqueue + priority/deadline tree | Fairness across all processes; cgroup-aware | All M:N runtimes ride on top of it | Linux CFS / EEVDF (§3.8) |
| Eager-task async/await with context capture | `Task<T>` + `SynchronizationContext` | Auto-thread-affinity for UI/web frameworks | Eager tasks run before await; ConfigureAwait friction | C# `async`/`await` (§4.9) |
| Pragma-driven shared-memory parallelism | Compiler pragmas + runtime thread pool | Most-deployed parallel model in HPC; one-line parallelism | Opacity; runtime-and-compiler co-dependence | OpenMP (§3.9) |
| Library-level C++ task parallelism | Templates + work-stealing pool + concurrent containers | C++ portability; no compiler dependency | Limited to C++ host language | Intel TBB / oneTBB (§3.10) |
| Interaction-combinator parallel runtime | Graph rewrites of disjoint active pairs | No programmer annotations; scales to GPU lanes | Constant-factor overhead; research-grade | Bend / HVM2 (§3.11) |
| Primary/worker reactor topology | N isolated single-threaded eventloops + primary balancer | Per-worker isolation without shared-heap coordination | No within-worker concurrency; horizontal scaling only | ActiveJ Eventloop + Workers (§3.12) |
| Thread-per-core io_uring runtime | Pinned single-thread executor per core + io_uring submission | Cache-locality, predictable latency, no cross-core contention | No work stealing; load imbalance must be handled by sharding | Glommio, Monoio (§3.4) |

### 14.2. Coordination mechanisms

| Technique | Mechanism | Strength | Cost / risk | Examples |
|---|---|---|---|---|
| Mutex / lock | Mutual exclusion | Simple and fast uncontended | Deadlocks, priority inversion | POSIX, Java, Rust `Mutex` (§9.1) |
| Atomics | Memory-ordering primitives | Lock-free runtime building block | Hard to use correctly | Schedulers, queues, RC (§9.2) |
| Channels | Send/receive queues | Communication + synchronization | Backpressure policy needed | Go, CSP, async channels (§7.1) |
| Actor messages | Per-actor mailbox | Encapsulated state | Selective receive / mailbox scanning | Erlang, Akka, Pony (§6) |
| STM | Atomic transactions | Composable shared-state updates | Conflicts, retries, opacity | Haskell STM, Clojure refs (§9.4) |
| Structured scopes | Parent owns children | No orphan tasks | Requires cancellation protocol | Trio, Swift, Java scopes (§8) |
| Cancellation tokens/scopes | Cooperative cancellation | Cleanup-friendly | Tasks must check/yield | Trio, Kotlin, Swift, Rust libraries (§8.3) |
| Effect handlers | Delimited continuations/evidence | User-defined control abstractions | Runtime/compiler co-design | OCaml 5, Koka, WasmFX (§5, `TYPES.md`) |
| Mechanical-sympathy ring buffer | Cache-line-padded sequence counters + dependency DAG | Millions of events/sec single thread, zero alloc | Static producer/consumer arrangement; not general IPC | LMAX Disruptor (§7.6) |
| Demand-driven backpressure streams | Subscriber-requests-N + per-stage operators | Backpressure by default; rich operator algebra | Operator-stack debugging; cancellation correctness | Reactive Streams / Reactor / RxJava / Akka Streams (§7.7) |

### 14.3. Safe sharing mechanisms

| Technique | Mechanism | Strength | Cost / risk | Examples |
|---|---|---|---|---|
| Sendability markers | Types safe across domains | Lightweight static checks | Requires library annotations | Rust `Send`/`Sync`, Swift `Sendable` (§10) |
| Actor isolation | State accessible only through actor | Data-race safety by construction | Reentrancy surprises | Swift actors, Pony actors (§10.2, §6) |
| Reference capabilities | Alias permissions | Precise race freedom | Annotation/model complexity | Pony (§10.3) |
| Ownership/borrowing | Unique or scoped access | Memory + concurrency safety | Ergonomic constraints | Rust, Hylo, Austral (`MEMORY.md`) |
| Immutable persistent data | Share by value/reference safely | Cheap snapshots, STM-friendly | Update allocation/model shift | Clojure, functional languages (§9.4) |
| Runtime race detection | Dynamic happens-before/lockset | Finds real bugs in tests | Runtime overhead, incomplete | ThreadSanitizer (`DEBUGGERS.md`, `TRACERS.md`) |

---

## 15. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Scope and Design Axes

1. JEP 444: Virtual Threads — https://openjdk.org/jeps/444
2. Tokio task documentation — https://docs.rs/tokio/0.2.9/tokio/task/index.html
3. Rust `Future` trait — https://doc.rust-lang.org/stable/std/future/trait.Future.html
4. OCaml effect handlers manual — https://ocaml.org/manual/effects.html
5. Erlang scheduler overview — https://blog.appsignal.com/2024/04/23/deep-diving-into-the-erlang-scheduler.html
6. Go runtime preemption source — https://go.dev/src/runtime/preempt.go
7. Swift structured concurrency proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md
8. Trio structured concurrency essay — https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful

### Chapter 2 — Historical Through-Line, 1960–2026

1. Erlang concurrent programming docs — https://www.erlang.org/doc/system/conc_prog.html
2. Cilk-5 implementation paper — https://dl.acm.org/doi/10.1145/277652.277725
3. Cilk work-stealing scheduler notes — https://people.csail.mit.edu/matei/courses/2015/6.S897/readings/cilk.pdf
4. GHC STM documentation — https://haskell.org/ghc/docs/latest/html/users_guide/exts/stm.html
5. Clojure refs and transactions — https://clojure.org/reference/refs
6. Clojure concurrent programming — https://clojure.org/concurrent_programming
7. Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
8. Pony reference capabilities paper — https://www.ponylang.io/media/papers/fast-cheap.pdf
9. Swift Sendable proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0302-concurrent-value-and-concurrent-closures.md
10. WasmFX explainer — https://wasmfx.dev/specs/explainer/

### Chapter 3 — Scheduler Architectures

1. Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
2. JEP 444: Virtual Threads — https://openjdk.org/jeps/444
3. Cilk scheduler paper — https://people.csail.mit.edu/matei/courses/2015/6.S897/readings/cilk.pdf
4. Java `ForkJoinPool` API — https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/concurrent/ForkJoinPool.html
5. The BEAM Book — https://happi.github.io/theBeamBook/
6. Erlang scheduler overview — https://blog.appsignal.com/2024/04/23/deep-diving-into-the-erlang-scheduler.html
7. Go preemption source — https://go.dev/src/runtime/preempt.go
8. Rust `Future` trait — https://doc.rust-lang.org/stable/std/future/trait.Future.html
9. Concurrent Haskell / capabilities docs — https://haskell.org/ghc/docs/latest/html/users_guide/using-concurrent.html
10. Multicore GHC paper — https://www.microsoft.com/en-us/research/wp-content/uploads/2009/09/multicore-ghc.pdf
11. GHC scheduler source — https://github.com/ghc/ghc/blob/master/rts/Schedule.c
12. Linux kernel — CFS Design — https://docs.kernel.org/scheduler/sched-design-CFS.html
13. LWN — "An EEVDF CPU scheduler for Linux" — https://lwn.net/Articles/925371/
14. Linux kernel — EEVDF scheduler documentation — https://www.kernel.org/doc/html/v6.6/scheduler/sched-eevdf.html
15. OpenMP specifications — https://www.openmp.org/specifications/
16. GCC libgomp manual — https://gcc.gnu.org/onlinedocs/libgomp/
17. OpenMP API Specification 5.2 (PDF) — https://www.openmp.org/wp-content/uploads/OpenMP-API-Specification-5-2.pdf
18. LLVM OpenMP runtime — https://openmp.llvm.org/
19. Intel oneTBB product page — https://www.intel.com/content/www/us/en/developer/tools/oneapi/onetbb.html
20. oneTBB repository (UXL Foundation) — https://github.com/uxlfoundation/oneTBB
21. oneAPI specification — oneTBB elements — https://oneapi-spec.uxlfoundation.org/specifications/oneapi/latest/elements/onetbb/source/
22. Bend repository — https://github.com/HigherOrderCO/Bend
23. HVM2 repository — https://github.com/HigherOrderCO/HVM2
24. Taelin — HVM2: A Parallel Evaluator for Interaction Combinators — https://raw.githubusercontent.com/HigherOrderCO/HVM/main/paper/HVM2.pdf
25. Higher Order Company — https://higherorderco.com/
26. ActiveJ Eventloop — https://activej.io/async-io/eventloop
27. ActiveJ Workers (boot) — https://activej.io/boot/workers
28. ActiveJ home — https://activej.io/
29. ActiveJ repository — https://github.com/activej/activej
30. Glommio repository — https://github.com/DataDog/glommio
31. Monoio repository — https://github.com/bytedance/monoio

### Chapter 4 — Async/Await and Futures

1. Rust async book — build an executor — https://rust-lang.github.io/async-book/02_execution/04_executor.html
2. Rust `Future` trait — https://doc.rust-lang.org/stable/std/future/trait.Future.html
3. Rust Reference — await expressions — https://doc.rust-lang.org/stable/reference/expressions/await-expr.html
4. Tokio task documentation — https://docs.rs/tokio/0.2.9/tokio/task/index.html
5. Elm concurrent FRP thesis — https://elm-lang.org/assets/papers/concurrent-frp.pdf
6. Elm Task implementation — https://github.com/elm/core/blob/master/src/Task.elm
7. C++20 coroutines (cppreference) — https://en.cppreference.com/w/cpp/language/coroutines
8. Lewis Baker — coroutines blog and cppcoro — https://lewissbaker.github.io/
9. C++23 `std::generator` — https://en.cppreference.com/w/cpp/coroutine/generator
10. P2300R10: `std::execution` — https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2024/p2300r10.html
11. NVIDIA stdexec reference implementation — https://github.com/NVIDIA/stdexec
12. C++26 `<execution>` (cppreference) — https://en.cppreference.com/w/cpp/execution
13. C# Asynchronous Programming with async and await — https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/
14. "How async/await really works in C#" (Stephen Toub, .NET Blog) — https://devblogs.microsoft.com/dotnet/how-async-await-really-works/
15. .NET `SynchronizationContext` API reference — https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext

### Chapter 5 — Stackful Coroutines, Fibers, Continuations, and Virtual Threads

1. WasmFX explainer — https://wasmfx.dev/specs/explainer/
2. JEP 444: Virtual Threads — https://openjdk.org/jeps/444
3. OpenJDK Loom `VirtualThread` source — https://github.com/openjdk/loom/blob/fibers/src/java.base/share/classes/java/lang/VirtualThread.java
4. OCaml effect handlers manual — https://ocaml.org/manual/effects.html
5. Retrofitting effect handlers onto OCaml — https://kcsrk.info/papers/retro-concurrency_pldi_21.pdf

### Chapter 6 — Actors, Mailboxes, and Supervision

1. Erlang concurrent programming docs — https://www.erlang.org/doc/system/conc_prog.html
2. The BEAM Book — https://happi.github.io/theBeamBook/
3. Swift actors proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0306-actors.md
4. Pony reference capabilities paper — https://www.ponylang.io/media/papers/fast-cheap.pdf
5. ActorForth introduction — https://github.com/ActorForth/ActorForth/blob/master/docs/IntroToActorForth.md
6. Akka project site — https://akka.io/
7. Akka Typed actors documentation — https://doc.akka.io/docs/akka/current/typed/actors.html
8. Apache Pekko (Apache-licensed Akka fork) — https://github.com/apache/incubator-pekko
9. Microsoft Orleans documentation — https://learn.microsoft.com/en-us/dotnet/orleans/
10. Bykov et al., "Orleans: Cloud Computing for Everyone" (MSR-TR-2014-41) — https://www.microsoft.com/en-us/research/wp-content/uploads/2014/12/Orleans-MSR-TR-2014-41.pdf
11. Bernstein, Bykov et al., "Orleans" (OSDI 2014) — https://www.usenix.org/conference/osdi14/technical-sessions/presentation/bernstein

### Chapter 7 — Channels, CSP, and Message-Passing Coordination

1. Erlang concurrent programming docs — https://www.erlang.org/doc/system/conc_prog.html
2. Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
3. Go networking internals — https://goperf.dev/02-networking/networking-internals/
4. Gforth pthreads and message queues — https://gforth.org/manual/Pthreads.html
5. LMAX Disruptor technical paper — https://lmax-exchange.github.io/disruptor/disruptor.html
6. Martin Fowler — The LMAX Architecture — https://martinfowler.com/articles/lmax.html
7. LMAX Disruptor repository — https://github.com/LMAX-Exchange/disruptor
8. Reactive Streams specification — https://www.reactive-streams.org/
9. Project Reactor — https://projectreactor.io/
10. ReactiveX / RxJava — https://github.com/ReactiveX/RxJava
11. Akka Streams documentation — https://doc.akka.io/docs/akka/current/stream/

### Chapter 8 — Structured Concurrency and Cancellation

1. JEP 428: Structured Concurrency — https://openjdk.org/jeps/428
2. Swift structured concurrency proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md
3. Swift TaskGroup documentation — https://developer.apple.com/documentation/swift/taskgroup
4. Trio structured concurrency essay — https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful
5. Rust async book — structured concurrency — https://rust-lang.github.io/async-book/part-reference/structured.html

### Chapter 9 — Synchronization, Shared State, and STM

1. Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
2. GHC STM documentation — https://haskell.org/ghc/docs/latest/html/users_guide/exts/stm.html
3. Concurrent Haskell base docs — https://haskell.org/ghc/docs/latest/html/libraries/base-4.22.0.0-66f8/Control-Concurrent.html
4. Clojure refs and transactions — https://clojure.org/reference/refs
5. Clojure concurrent programming — https://clojure.org/concurrent_programming

### Chapter 10 — Data-Race Freedom and Safe Sharing

1. Rust book — `Send` and `Sync` — https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html
2. Swift Sendable proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0302-concurrent-value-and-concurrent-closures.md
3. Swift Sendable documentation — https://developer.apple.com/documentation/swift/sendable
4. Swift actors proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0306-actors.md
5. Pony reference capabilities paper — https://www.ponylang.io/media/papers/fast-cheap.pdf

### Chapter 11 — I/O Integration, Timers, and Blocking Boundaries

1. Go networking internals — https://goperf.dev/02-networking/networking-internals/
2. Tokio runtime documentation — https://docs.rs/tokio/latest/tokio/runtime/
3. Go runtime scheduler source — https://go.dev/src/runtime/proc.go
4. Raku concurrency overview — https://docs.raku.org/language/concurrency
5. Rakudo continuation explanation for non-blocking await — https://stackoverflow.com/questions/62817878/what-are-the-specifics-about-the-continuations-upon-which-rakudo-relies/62819961

### Chapter 12 — Runtime Observability and Debuggability

1. Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
2. Tokio runtime documentation — https://docs.rs/tokio/latest/tokio/runtime/
