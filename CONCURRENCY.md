# Concurrency, Scheduling, and Runtime Coordination

This document owns research on language-level and runtime-level concurrency: threads, green threads, tasks, fibers, actors, channels, async/await, structured concurrency, scheduling, cancellation, synchronization, race-freedom, software transactional memory, and the runtime machinery that connects concurrent programs to I/O and operating-system resources.

Ownership boundary: memory-safety and ownership models belong in `MEMORY.md`; type-system treatment of effects, capabilities, and `Send`/`Sync`-style marker traits belongs in `TYPES.md`; compiler lowering and code generation belong in `COMPILERS.md`; tracing, profiling, and runtime event pipelines belong in `TRACERS.md`; debugger workflows for async stacks and concurrency bugs belong in `DEBUGGERS.md`; module/package boundaries belong in `MODULES.md`. This document focuses on the execution model and coordination mechanisms.

---

## 1. Scope and Design Axes

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

Kernel threads are scheduled by the operating system. Virtual threads or green threads are scheduled by a language runtime onto a smaller or dynamically sized set of kernel threads. Fibers are stackful user-mode execution contexts. Stackless tasks are usually state machines that advance through explicit suspension points.

Java virtual threads are scheduled by the JDK rather than the OS; the JDK scheduler assigns virtual threads to platform-thread carriers in an M:N arrangement. Source: https://openjdk.org/jeps/444

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

Message passing can simplify data-race reasoning, but it introduces ordering, buffering, backpressure, mailbox growth, and selective-receive costs. Shared memory can be efficient and familiar, but puts more burden on synchronization and race prevention.

### 1.6. Structured vs unstructured concurrency

Structured concurrency requires child tasks to be scoped: they cannot outlive their parent scope, and failure/cancellation flows through the task tree. Unstructured concurrency allows detached tasks, fire-and-forget work, daemon tasks, and independent lifetimes.

Swift's structured concurrency proposal frames tasks and child tasks as the primary units of concurrency and requires child tasks in a task group to complete before the group scope exits. Source: https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md

Nathaniel Smith's Trio nursery model emphasizes that a nursery block does not exit until tasks inside it have finished or have been cancelled and cleaned up. Source: https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful

---

## 2. Historical Through-Line, 1960–2026

### 2.1. 1960s–1970s — Processes, monitors, CSP, actors, and coroutines

Early concurrency research split into several durable families: shared-memory synchronization, monitors, message passing, communicating sequential processes, actors, coroutines, and continuations. These are not merely historical ideas; modern systems recombine them constantly.

The actor model treats independent entities as concurrent units that communicate by asynchronous messages. CSP-style systems emphasize synchronous or buffered channels and process composition. Coroutine systems emphasize explicit suspension and resumption.

### 2.2. 1980s — Erlang processes and fault-oriented concurrency

Erlang made lightweight isolated processes, message passing, links, monitors, and supervision central to the language. The key lesson is that concurrency can be designed around failure containment rather than only throughput.

Erlang processes each have their own message queue. A `receive` scans the queue for a matching message; if no message matches, the process waits until a new message arrives. Source: https://www.erlang.org/doc/system/conc_prog.html

### 2.3. 1990s — Work stealing and fork-join parallelism

Cilk made work-stealing scheduling a practical and theoretically grounded basis for fork-join parallelism. Work stealing uses per-worker deques: workers run their own local work; idle workers steal from others.

Cilk's work-first principle moved overhead from the common local execution path to the less common stealing path. This led to low spawn overhead and provable bounds for well-structured computations. Sources: https://dl.acm.org/doi/10.1145/277652.277725 and https://people.csail.mit.edu/matei/courses/2015/6.S897/readings/cilk.pdf

### 2.4. 2000s — STM, multicore pressure, and async libraries

As multicore machines became common, languages explored STM, actors, futures/promises, event loops, and thread pools. Haskell STM and Clojure STM show two influential approaches to composable shared-state coordination.

GHC supports Software Transactional Memory with atomic blocks, transactional variables, `retry`, `orElse`, and invariants. Source: https://haskell.org/ghc/docs/latest/html/users_guide/exts/stm.html

Clojure refs use STM with MVCC-style snapshot isolation and automatic retry on conflicts, while atoms and agents cover independent synchronous and asynchronous state changes. Sources: https://clojure.org/reference/refs and https://clojure.org/concurrent_programming

### 2.5. 2010s — Async/await, goroutines, actors, and data-race type systems

Async/await became the mainstream notation for stackless asynchronous code. Go popularized language-integrated goroutines and channels over an M:N runtime. Rust exposed stackless futures and let libraries such as Tokio provide executors and I/O. Pony explored actor-model data-race freedom through reference capabilities. Swift introduced actors and structured concurrency.

Go's runtime models goroutines as Gs, OS threads as Ms, and scheduling resources as Ps; the scheduler matches G, M, and P to execute user Go code. Source: https://go.dev/src/runtime/HACKING.md

Pony's reference-capability system statically prevents data races in an actor-model language while allowing efficient message passing. Source: https://www.ponylang.io/media/papers/fast-cheap.pdf

### 2.6. Functional Concurrency in Production ML and Haskell Systems

Functional languages developed several distinct concurrency traditions rather than converging on one runtime model. **GHC** built lightweight green threads, `MVar`s, async exceptions, STM, and sparks for parallel evaluation into one runtime. **OCaml 5** split the problem: domains provide parallel execution, while effect handlers and fibers provide a substrate for user-level concurrency abstractions. **Elm** intentionally restricted the surface concurrency model around tasks and effect managers to preserve a simple browser-oriented runtime. **Koka** treats concurrency primarily as an effect-handler design space, with typed control abstractions and a runtime/compiler contract still evolving.

The key design lesson is that "functional concurrency" is not one thing. Some systems emphasize a rich runtime substrate (GHC), some emphasize typed control abstractions (Koka, Idris), some emphasize effect-handler runtimes (OCaml 5), and some deliberately constrain the concurrency model to preserve simplicity (Elm).

Sources: https://haskell.org/ghc/docs/latest/html/users_guide/using-concurrent.html and https://www.microsoft.com/en-us/research/wp-content/uploads/2009/09/multicore-ghc.pdf and https://ocaml.org/manual/effects.html and https://kcsrk.info/papers/retro-concurrency_pldi_21.pdf and https://elm-lang.org/assets/papers/concurrent-frp.pdf and https://koka-lang.github.io/koka/doc/

### 2.7. 2020s through 2026 — Virtual threads, structured scopes, typed data isolation, and effect-based concurrency

Status (JDK 21): Java virtual threads became a final feature through JEP 444, giving the JDK an M:N virtual-thread scheduler over carrier platform threads. Source: https://openjdk.org/jeps/444

Status (as of JDK 26 docs): `ForkJoinPool` remains Java's core work-stealing executor and supports scheduled tasks in the JDK 26 API. Source: https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/concurrent/ForkJoinPool.html

Status (Swift 5.5+): Swift added async/await, task groups, actors, and `Sendable` checking as part of its concurrency model. Sources: https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md and https://github.com/apple/swift-evolution/blob/main/proposals/0302-concurrent-value-and-concurrent-closures.md

Status (as of early 2026): WebAssembly effect-handler and typed-continuation work is being explored as a substrate for stack switching, async/await, generators, continuations, and effect handlers. Source: https://wasmfx.dev/specs/explainer/

---

## 3. Scheduler Architectures

### 3.1. One OS thread per language thread

The simplest runtime maps each language thread to an OS thread. This gives strong OS integration, native blocking behavior, mature debugging, and simple FFI expectations. The cost is high per-thread memory, OS scheduling overhead, and limited scalability for millions of mostly-blocked tasks.

This model is often good enough for CPU-bound or moderate-concurrency programs, and it remains the best interoperability baseline for native languages.

### 3.2. M:N scheduling

An M:N runtime multiplexes many language tasks onto many kernel threads. It gives the runtime control over task scheduling, stack representation, I/O integration, and per-task metadata.

Go's G/M/P model is the canonical production example: goroutines are Gs, OS threads are Ms, and Ps represent the resources and right to execute Go code. There are exactly `GOMAXPROCS` Ps, while Ms can grow when threads block in system calls. Source: https://go.dev/src/runtime/HACKING.md

Java virtual threads also use M:N scheduling: virtual threads mount on carrier platform threads and unmount when they yield or block in supported ways. Source: https://openjdk.org/jeps/444

### 3.3. Work-stealing schedulers

Work stealing gives each worker a local deque and lets idle workers steal tasks from other workers. The owner usually pushes and pops from one end for cache locality; thieves steal from the other end to reduce contention.

Cilk's work stealing has theoretical performance bounds for fully strict computations and inspired many modern runtime schedulers. Java's `ForkJoinPool` documentation explicitly identifies work stealing as the main difference from ordinary executors. Sources: https://people.csail.mit.edu/matei/courses/2015/6.S897/readings/cilk.pdf and https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/concurrent/ForkJoinPool.html

### 3.4. Event-loop schedulers

An event-loop runtime maintains a set of ready tasks and I/O interests. When the OS reports readiness or completion, the runtime wakes the corresponding tasks. This model powers JavaScript runtimes, libuv systems, Python async frameworks, and many Rust executors.

Event-loop schedulers are efficient for I/O-bound workloads but must prevent CPU-bound tasks from starving the loop. They need explicit blocking pools, cooperative yielding, or preemption support.

### 3.5. Actor schedulers

Actor runtimes schedule entities with mailboxes rather than arbitrary call stacks. An actor processes messages sequentially, which protects actor-local mutable state. Runtime design questions include mailbox representation, fairness, priority, selective receive, actor migration, backpressure, and supervision.

BEAM runs one scheduler per core on multicore machines and balances work across scheduler run queues. Source: https://happi.github.io/theBeamBook/

Pony actors execute synchronously within an actor and communicate by asynchronous messages, with reference capabilities controlling what data can cross actor boundaries. Source: https://www.ponylang.io/media/papers/fast-cheap.pdf

### 3.6. Scheduler fairness and quotas

A runtime needs a fairness policy: time slices, instruction counts, reductions, explicit yields, poll budgets, or priority queues. Fairness is not free; checking for preemption too often hurts throughput, but checking too rarely harms latency.

BEAM reductions are a language-runtime-level unit of work. Go uses safe-point and signal-based preemption. Rust async relies heavily on futures returning quickly and not blocking in `poll`. Sources: https://blog.appsignal.com/2024/04/23/deep-diving-into-the-erlang-scheduler.html, https://go.dev/src/runtime/preempt.go, and https://doc.rust-lang.org/stable/std/future/trait.Future.html

### 3.7. GHC Capabilities, Lightweight Threads, and Spark Scheduling

GHC's runtime is one of the strongest production examples of a functional-language scheduler built around **lightweight threads** plus a separate parallel-evaluation mechanism. The runtime exposes **capabilities** as virtual processors; each capability can run one Haskell thread at a time, while the runtime manages one or more OS threads behind the scenes. This design lets ordinary Haskell threads remain extremely cheap while still allowing multicore execution and blocking foreign calls.

A separate mechanism, **sparks**, represents speculative parallel work created by `par`. GHC's multicore runtime moved spark pools to per-HEC work-stealing queues, separating thread scheduling from spark load balancing. This is a useful design pattern: not every concurrent execution unit in a runtime must be scheduled by the same policy or inhabit the same queue.

Sources: https://haskell.org/ghc/docs/latest/html/users_guide/using-concurrent.html and https://www.microsoft.com/en-us/research/wp-content/uploads/2009/09/multicore-ghc.pdf and https://github.com/ghc/ghc/blob/master/rts/Schedule.c

---

## 4. Async/Await and Futures

### 4.1. Futures and promises

A future represents a computation that may produce a value later. A promise is often the write side that completes a future. Some languages make futures eager; others make them lazy.

Rust futures are lazy: nothing happens unless an executor polls them. This design gives zero runtime dependency in the standard abstraction but requires an executor and explicit wakeups. Source: https://rust-lang.github.io/async-book/02_execution/04_executor.html

### 4.2. Poll/wake execution

In poll/wake systems, asynchronous resources store a waker and call it when progress may be possible. The executor then polls the task again. This avoids blocking worker threads on each resource.

The Rust `Future` trait's `poll` method receives `Pin<&mut Self>` and a `Context` containing a `Waker`; `poll` should return quickly and must not block. Source: https://doc.rust-lang.org/stable/std/future/trait.Future.html

### 4.3. Async function lowering

Stackless async functions are typically compiled into state machines. Each suspension point stores local state in the future object. This makes allocation and stack usage explicit, but it can produce large state machines and requires careful pinning or move restrictions when self-references are possible.

The Rust Reference describes `await` as converting into a future, pinning it, polling it with the current task context, returning `Pending` when not ready, and resuming from that state later. Source: https://doc.rust-lang.org/stable/reference/expressions/await-expr.html

### 4.4. Async coloring and API propagation

Stackless async often colors APIs: a function that awaits must itself be async, and callers must await it. This makes suspension explicit and helps compilers and readers, but retrofitting async into a large synchronous API can be painful.

Virtual-thread and fiber systems choose the opposite trade-off: blocking-looking APIs can suspend the logical task without requiring the caller to become async. The runtime and standard library must then ensure that blocking operations unmount or park only the logical task, not the carrier thread.

### 4.5. Blocking in async runtimes

Blocking a worker thread in an async runtime can starve unrelated tasks. Practical runtimes provide escape hatches: blocking thread pools, `spawn_blocking`, `block_in_place`, or annotations that let the scheduler compensate.

Tokio's task docs explain that tasks should not perform blocking syscalls and provide APIs for running blocking work in an asynchronous context. Source: https://docs.rs/tokio/0.2.9/tokio/task/index.html

### 4.6. Elm Tasks and Effect Managers — Constrained Functional Asynchrony

Elm is an instructive contrast to richer async systems. A `Task` in Elm is a description of asynchronous work that can later be turned into a command. The standard sequencing primitives are intentionally simple, and the runtime keeps a tight grip on how effects enter the system. Historically, Elm's broader FRP design also used type-level restrictions — such as ruling out higher-order signals — to keep the concurrent/reactive runtime manageable.

The lesson is that a functional language can deliberately under-express concurrency in order to preserve runtime simplicity and predictable UI semantics. This is the opposite of the "maximally expressive substrate" approach seen in GHC or effect-handler languages. Sources: https://elm-lang.org/assets/papers/concurrent-frp.pdf and https://github.com/elm/core/blob/master/src/Task.elm

---

## 5. Stackful Coroutines, Fibers, Continuations, and Virtual Threads

### 5.1. Stackful fibers

A fiber has its own stack or stack segment and can suspend with an ordinary call stack intact. This makes synchronous-looking code natural and helps retrofit existing APIs. Costs include stack allocation, stack growth, stack scanning for GC, and foreign-call pinning.

OCaml 5 effect handlers use fibers as small heap-allocated, dynamically resized stacks for delimited continuations. Source: https://kcsrk.info/ocaml/multicore/2015/05/20/effects-multicore/

### 5.2. Delimited continuations

Delimited continuations capture the rest of a computation up to a prompt or handler. They are a powerful substrate for generators, coroutines, async/await, green threads, and effect handlers.

WasmFX / typed continuations aims to extend WebAssembly with structured non-local control flow for efficient compilation of async/await, generators, continuations, and effect handlers. Source: https://wasmfx.dev/specs/explainer/

### 5.3. Virtual threads

Virtual threads make the thread abstraction cheap enough to use per request or per task. They preserve blocking-style code while moving scheduling into the runtime.

Java virtual threads mount on a carrier platform thread while running and unmount when yielding or blocking in supported operations. They do not preserve affinity to a particular carrier thread. Source: https://openjdk.org/jeps/444

### 5.4. Pinning and blocking hazards

Virtual-thread and fiber systems must handle operations that cannot safely unmount: native calls, monitor regions, critical sections, or runtime-internal pinned states. If a virtual thread is pinned while blocking, its carrier may be blocked too, reducing scalability.

OpenJDK Loom implementation discussions and code expose concepts such as continuations, carrier threads, and pinned reasons. Source: https://github.com/openjdk/loom/blob/fibers/src/java.base/share/classes/java/lang/VirtualThread.java

### 5.5. OCaml 5 — Domains, Fibers, and Effect-Handler Concurrency

OCaml 5 is especially important because it separates **parallelism** from **concurrency substrate**. Domains are the unit of parallel execution, while effect handlers and heap-allocated fibers support user-level concurrency abstractions such as lightweight threads, generators, and asynchronous I/O. This is a different decomposition from both GHC and Loom.

Another useful lesson is that OCaml's effect handlers are runtime-backed but not statically effect-safe in the stock language. That means the concurrency substrate is powerful and composable, but the burden of disciplined use falls more on library design and runtime semantics than on the type checker. Sources: https://ocaml.org/manual/effects.html and https://kcsrk.info/papers/retro-concurrency_pldi_21.pdf

---

## 6. Actors, Mailboxes, and Supervision

### 6.1. Actor model basics

An actor owns state, processes one message at a time, and communicates by sending messages. This gives a clear isolation boundary: actor-local mutable state does not require locks if only the actor can touch it.

Actor systems differ on whether messages are ordered, typed, selective, bounded, durable, distributed, priority-aware, or supervised.

### 6.2. Erlang/BEAM processes

Erlang processes are lightweight units managed by BEAM, not OS processes. Each has its own message queue; `receive` scans messages against patterns. Selective receive is expressive but means mailbox scanning can become a performance concern.

Source: https://www.erlang.org/doc/system/conc_prog.html

### 6.3. Supervision and fault containment

Erlang's deepest concurrency lesson is not only actors but supervised failure: processes can crash independently, supervisors restart children, and links/monitors make failure visible. A language runtime can treat failure propagation as part of the concurrency model rather than an afterthought.

### 6.4. Swift actors and reentrancy

Swift actors provide data isolation: mutable actor state is protected so only one thread accesses it at a time. Actor-isolated functions are reentrant; if a function suspends, other work may run on the actor before it resumes, so invariants must not be assumed across `await` without care.

Source: https://github.com/apple/swift-evolution/blob/main/proposals/0306-actors.md

### 6.5. Pony actors and reference capabilities

Pony combines actors with reference capabilities to statically prevent data races. Values that can be sent between actors must satisfy capability restrictions, allowing immutable or isolated data to move without copying while preventing shared mutable races.

Source: https://www.ponylang.io/media/papers/fast-cheap.pdf

### 6.6. ActorForth — Typed Stack Language Meets Actors

ActorForth is a noteworthy design point because it explicitly combines a Forth-like stack language, static type bookkeeping, and actor semantics on top of the BEAM. Its pitch is effectively that a type system can keep track of stack discipline while actors become the concurrency model. Each actor has its own state, stack, and mailbox, and communication is purely by message passing.

The design lesson is not that a new language should become Forth-on-BEAM, but that concatenative execution and actor isolation are not inherently incompatible. If a language already values small compositional units, actor-style decomposition can align unusually well with that style. Source: https://github.com/ActorForth/ActorForth/blob/master/docs/IntroToActorForth.md

---

## 7. Channels, CSP, and Message-Passing Coordination

### 7.1. Channels as synchronization points

Channels combine communication and synchronization. They may be unbuffered, bounded, or unbounded. Unbuffered channels force rendezvous; bounded channels provide backpressure; unbounded channels avoid sender blocking but can hide overload until memory grows.

Go channels are often paired with goroutines to express CSP-like communication. The scheduler and netpoller make blocking channel and I/O operations suspend goroutines rather than OS threads in ordinary cases.

### 7.2. Select and alternatives

A `select` or alternative construct waits on multiple communication operations. Implementation choices include randomization for fairness, priority ordering, registration with wait queues, cancellation safety, and avoiding lost wakeups.

### 7.3. Backpressure

Backpressure is a first-class concurrency concern. Without it, fast producers can overwhelm slow consumers. Mechanisms include bounded queues, demand signals, credit-based protocols, async streams, supervision policies, and load shedding.

### 7.4. Distributed message passing

Distributed actors and channels must confront serialization, versioning, network partitions, retries, ordering, identity, authentication, and rolling upgrades. The local concurrency abstraction rarely survives unchanged across the network boundary.

### 7.5. Forth Family Concurrency — Cooperative Tasks, Mailboxes, and CSP-Style Channels

Traditional Forth systems have long supported multitasking, often through a small round-robin scheduler and an explicit `PAUSE` word. This is a useful reminder that concurrency need not begin with heavyweight thread APIs; it can begin with a tiny cooperative runtime and a handful of synchronization words.

Several Forth systems and proposals expose a recurring trio of mechanisms:

- **cooperative task switching** via `PAUSE`;
- **timesliced or interrupt-driven preemption** as an optional extension;
- **mailboxes or channels** for task synchronization and data transfer.

The modern design lesson is that Forth-style concurrency is often intentionally small and explicit. It optimizes for predictability, embedded deployment, and programmer-visible scheduling rather than transparent suspension. Sources: https://www.forth2020.org/about-forth and https://theforth.net/package/multi-tasking and http://www.mosaic-industries.com/embedded-systems/sbc-single-board-computers/freescale-hcs12-9s12-c-language/instrument-control/forth-real-time-operating-system and https://gforth.org/manual/Pthreads.html and http://www.ultratechnology.com/4thpar.html

---

## 8. Structured Concurrency and Cancellation

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

Lock-free queues, deques, and stacks are central to schedulers and executors. They reduce blocking but increase proof burden and expose memory-reclamation challenges. Work-stealing deques are especially sensitive: owner operations should be cheap, while steal operations can afford heavier synchronization.

### 9.6. Haskell STM and Lightweight Thread Coordination

Haskell's STM is especially valuable because it sits inside a runtime that already supports huge numbers of lightweight threads. This makes STM not just a shared-state abstraction in the abstract, but a real scheduling and wakeup mechanism for fine-grained functional concurrency. `retry` and `orElse` provide a different coordination vocabulary from locks or channels: transactions block until watched state changes, rather than explicitly waiting on a condition variable or mailbox.

The broader lesson is that STM becomes much more compelling when paired with cheap threads and a runtime that treats blocking as parking a lightweight computation rather than sleeping an expensive kernel thread. Sources: https://haskell.org/ghc/docs/latest/html/users_guide/exts/stm.html and https://haskell.org/ghc/docs/latest/html/libraries/base-4.22.0.0-66f8/Control-Concurrent.html

---

## 10. Data-Race Freedom and Safe Sharing

### 10.1. Marker traits and sendability

A type system can track which values may cross concurrency domains. Rust uses `Send` and `Sync`: `Send` means ownership can be transferred to another thread; `Sync` means shared references are safe across threads. Source: https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html

Swift uses `Sendable` and `@Sendable` closures to model values safe to pass across concurrency domains; actors implicitly conform because they serialize mutable state access. Sources: https://github.com/apple/swift-evolution/blob/main/proposals/0302-concurrent-value-and-concurrent-closures.md and https://developer.apple.com/documentation/swift/sendable

### 10.2. Actor isolation

Actor isolation prevents direct unsynchronized access to actor-local mutable state. This is a semantic guarantee, but it interacts with reentrancy: after an `await`, actor state may have changed.

Swift's actor proposal explicitly warns that actor-isolated functions are reentrant and state can change across an `await`. Source: https://github.com/apple/swift-evolution/blob/main/proposals/0306-actors.md

### 10.3. Reference capabilities

Reference capabilities classify aliases by what they can read, write, or send. Pony's capabilities are an influential design point for combining high-performance actors with static data-race freedom.

Source: https://www.ponylang.io/media/papers/fast-cheap.pdf

### 10.4. Ownership and borrowing as concurrency controls

Ownership and borrowing can make sharing explicit and statically prevent many races. Full treatment belongs in `MEMORY.md`, but concurrency design must decide whether ownership is only a memory-management feature or also a cross-task sharing discipline.

### 10.5. Runtime race detection

Static race freedom is strong but restrictive. Dynamic race detectors, happens-before tracing, lockset analysis, and scheduler fuzzing are useful complements. Full debugger and tracer treatment belongs in `DEBUGGERS.md` and `TRACERS.md`.

---

## 11. I/O Integration, Timers, and Blocking Boundaries

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

Tokio describes a runtime as providing an I/O driver, scheduler, and timer. The driver receives OS I/O events, wakes tasks, and lets the scheduler poll ready futures. Source: https://docs.rs/tokio/latest/tokio/runtime/

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

### 11.6. Raku — Schedulers, Reactive Blocks, and Continuation-Based Await

Raku is one of the more interesting production languages in this area because it exposes several concurrency layers at once:

- `Promise` for eventual results;
- `Supply` for asynchronous streams;
- `Channel` for thread-safe queued communication;
- `react` / `whenever` for reactive lexical event handling;
- explicit `Scheduler` roles for task placement policy.

The runtime design is especially interesting because `await` on promises and channels no longer blocks a thread; Rakudo uses one-shot stackful continuations as an implementation strategy so the awaiting computation can be resumed later without forcing async coloring all the way up the call stack. This makes Raku a valuable counterexample to both stackless-future systems and goroutine/virtual-thread systems.

Its `Channel` design is also revealing: send is non-blocking and the queue is effectively unbounded, which simplifies producers but weakens built-in backpressure. Meanwhile `react` and `whenever` provide a structured event scope, but long-running work inside a `whenever` block typically needs an explicit `start` to avoid serializing all handlers.

Sources: https://docs.raku.org/language/concurrency and https://docs.raku.org/type/Scheduler and https://docs.raku.org/type/Channel and https://docs.raku.org/type/Promise and https://docs.raku.org/syntax/react and https://docs.raku.org/syntax/whenever and https://stackoverflow.com/questions/62817878/what-are-the-specifics-about-the-continuations-upon-which-rakudo-relies/62819961 and https://docs.raku.org/language/concurrency

---

## 12. Runtime Observability and Debuggability

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

1. Decide whether concurrency is a library feature, runtime feature, type-system feature, or all three.
2. Pick a blocking story early. If ordinary blocking APIs are allowed, the runtime must make them scale or isolate them.
3. Prefer structured concurrency by default, with explicit detached escape hatches.
4. Treat cancellation as a protocol with cleanup, not as a boolean flag.
5. Make task identity and parentage observable from day one.
6. If using stackless async, design around async coloring and cancellation of spawned tasks.
7. If using virtual threads/fibers, design pinning, stack scanning, FFI, and debugger integration early.
8. If using actors, define mailbox ordering, backpressure, supervision, and reentrancy policy.
9. If using channels, decide boundedness and `select` fairness semantics.
10. Keep data-race safety aligned with the type system: `Send`/`Sync`, `Sendable`, ownership, capabilities, or actor isolation should not be afterthoughts.
11. Separate CPU parallelism from I/O concurrency in APIs and scheduler policy.
12. Provide runtime hooks for tracing, profiling, and deterministic scheduler testing.

---

## 14. Summary of Concurrency Techniques

### 14.1. Execution units and scheduling

| Technique | Mechanism | Strength | Cost / risk | Examples |
|---|---|---|---|---|
| OS threads | Kernel-scheduled stacks | Simple FFI and blocking semantics | High per-thread overhead | POSIX threads, Java platform threads |
| M:N goroutines | Runtime maps tasks to OS threads | Many cheap blocking-looking tasks | Runtime complexity | Go G/M/P (§3.2) |
| Virtual threads | Runtime-scheduled thread abstraction | Retrofit blocking style | Pinning and carrier blocking | Java Loom (§5.3) |
| Stackless futures | State machines + poll/wake | Lightweight, explicit suspension | Async coloring, executor burden | Rust futures (§4) |
| Stackful fibers | User-mode stacks | Natural synchronous style | Stack scanning/growth/pinning | OCaml fibers, Loom continuations (§5) |
| Work stealing | Per-worker deques | Good fork-join load balancing | Blocking hurts; deque complexity | Cilk, ForkJoinPool (§3.3) |
| Actor scheduler | Mailboxes + isolated state | Local mutable state without locks | Mailbox growth, reentrancy | BEAM, Pony, Swift actors (§6) |
| Event loop | Ready queue + I/O driver | Efficient I/O concurrency | CPU-bound starvation | libuv, Tokio, JavaScript runtimes (§4, §11) |

### 14.2. Coordination mechanisms

| Technique | Mechanism | Strength | Cost / risk | Examples |
|---|---|---|---|---|
| Mutex / lock | Mutual exclusion | Simple and fast uncontended | Deadlocks, priority inversion | POSIX, Java, Rust `Mutex` |
| Atomics | Memory-ordering primitives | Lock-free runtime building block | Hard to use correctly | Schedulers, queues, RC |
| Channels | Send/receive queues | Communication + synchronization | Backpressure policy needed | Go, CSP, async channels |
| Actor messages | Per-actor mailbox | Encapsulated state | Selective receive / mailbox scanning | Erlang, Akka, Pony |
| STM | Atomic transactions | Composable shared-state updates | Conflicts, retries, opacity | Haskell STM, Clojure refs (§9.4) |
| Structured scopes | Parent owns children | No orphan tasks | Requires cancellation protocol | Trio, Swift, Java scopes (§8) |
| Cancellation tokens/scopes | Cooperative cancellation | Cleanup-friendly | Tasks must check/yield | Trio, Kotlin, Swift, Rust libraries |
| Effect handlers | Delimited continuations/evidence | User-defined control abstractions | Runtime/compiler co-design | OCaml 5, Koka, WasmFX (§5, `TYPES.md`) |

### 14.3. Safe sharing mechanisms

| Technique | Mechanism | Strength | Cost / risk | Examples |
|---|---|---|---|---|
| Sendability markers | Types safe across domains | Lightweight static checks | Requires library annotations | Rust `Send`/`Sync`, Swift `Sendable` (§10) |
| Actor isolation | State accessible only through actor | Data-race safety by construction | Reentrancy surprises | Swift actors, Pony actors |
| Reference capabilities | Alias permissions | Precise race freedom | Annotation/model complexity | Pony (§10.3) |
| Ownership/borrowing | Unique or scoped access | Memory + concurrency safety | Ergonomic constraints | Rust, Hylo, Austral (`MEMORY.md`) |
| Immutable persistent data | Share by value/reference safely | Cheap snapshots, STM-friendly | Update allocation/model shift | Clojure, functional languages |
| Runtime race detection | Dynamic happens-before/lockset | Finds real bugs in tests | Runtime overhead, incomplete | ThreadSanitizer (`DEBUGGERS.md`, `TRACERS.md`) |

---

## 15. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Scope and Design Axes

- JEP 444: Virtual Threads — https://openjdk.org/jeps/444
- Tokio task documentation — https://docs.rs/tokio/0.2.9/tokio/task/index.html
- Rust `Future` trait — https://doc.rust-lang.org/stable/std/future/trait.Future.html
- OCaml effect handlers manual — https://ocaml.org/manual/effects.html
- Erlang scheduler overview — https://blog.appsignal.com/2024/04/23/deep-diving-into-the-erlang-scheduler.html
- Go runtime preemption source — https://go.dev/src/runtime/preempt.go
- Swift structured concurrency proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md
- Trio structured concurrency essay — https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful

### Chapter 2 — Historical Through-Line, 1960–2026

- Erlang concurrent programming docs — https://www.erlang.org/doc/system/conc_prog.html
- Cilk-5 implementation paper — https://dl.acm.org/doi/10.1145/277652.277725
- Cilk work-stealing scheduler notes — https://people.csail.mit.edu/matei/courses/2015/6.S897/readings/cilk.pdf
- GHC STM documentation — https://haskell.org/ghc/docs/latest/html/users_guide/exts/stm.html
- Clojure refs and transactions — https://clojure.org/reference/refs
- Clojure concurrent programming — https://clojure.org/concurrent_programming
- Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
- Pony reference capabilities paper — https://www.ponylang.io/media/papers/fast-cheap.pdf
- Swift Sendable proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0302-concurrent-value-and-concurrent-closures.md
- WasmFX explainer — https://wasmfx.dev/specs/explainer/

### Chapter 3 — Scheduler Architectures

- Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
- JEP 444: Virtual Threads — https://openjdk.org/jeps/444
- Cilk scheduler paper — https://people.csail.mit.edu/matei/courses/2015/6.S897/readings/cilk.pdf
- Java `ForkJoinPool` API — https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/concurrent/ForkJoinPool.html
- The BEAM Book — https://happi.github.io/theBeamBook/
- Erlang scheduler overview — https://blog.appsignal.com/2024/04/23/deep-diving-into-the-erlang-scheduler.html
- Go preemption source — https://go.dev/src/runtime/preempt.go
- Rust `Future` trait — https://doc.rust-lang.org/stable/std/future/trait.Future.html
- Concurrent Haskell / capabilities docs — https://haskell.org/ghc/docs/latest/html/users_guide/using-concurrent.html
- Multicore GHC paper — https://www.microsoft.com/en-us/research/wp-content/uploads/2009/09/multicore-ghc.pdf
- GHC scheduler source — https://github.com/ghc/ghc/blob/master/rts/Schedule.c

### Chapter 4 — Async/Await and Futures

- Rust async book — build an executor — https://rust-lang.github.io/async-book/02_execution/04_executor.html
- Rust `Future` trait — https://doc.rust-lang.org/stable/std/future/trait.Future.html
- Rust Reference — await expressions — https://doc.rust-lang.org/stable/reference/expressions/await-expr.html
- Tokio task documentation — https://docs.rs/tokio/0.2.9/tokio/task/index.html
- Tokio async in depth — https://tokio.rs/tokio/tutorial/async
- Elm concurrent FRP thesis — https://elm-lang.org/assets/papers/concurrent-frp.pdf
- Elm Task implementation — https://github.com/elm/core/blob/master/src/Task.elm

### Chapter 5 — Stackful Coroutines, Fibers, Continuations, and Virtual Threads

- Effective Concurrency with Algebraic Effects — https://kcsrk.info/ocaml/multicore/2015/05/20/effects-multicore/
- WasmFX explainer — https://wasmfx.dev/specs/explainer/
- JEP 444: Virtual Threads — https://openjdk.org/jeps/444
- OpenJDK Loom `VirtualThread` source — https://github.com/openjdk/loom/blob/fibers/src/java.base/share/classes/java/lang/VirtualThread.java
- OpenJDK Loom `Continuation` source — https://github.com/openjdk/loom/blob/fibers/src/java.base/share/classes/jdk/internal/vm/Continuation.java
- OCaml effect handlers manual — https://ocaml.org/manual/effects.html
- Retrofitting effect handlers onto OCaml — https://kcsrk.info/papers/retro-concurrency_pldi_21.pdf

### Chapter 6 — Actors, Mailboxes, and Supervision

- Erlang concurrent programming docs — https://www.erlang.org/doc/system/conc_prog.html
- The BEAM Book — https://happi.github.io/theBeamBook/
- Swift actors proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0306-actors.md
- Pony reference capabilities paper — https://www.ponylang.io/media/papers/fast-cheap.pdf
- LWN, Preventing data races with Pony — https://lwn.net/Articles/1001224/
- ActorForth introduction — https://github.com/ActorForth/ActorForth/blob/master/docs/IntroToActorForth.md

### Chapter 7 — Channels, CSP, and Message-Passing Coordination

- Erlang concurrent programming docs — https://www.erlang.org/doc/system/conc_prog.html
- Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
- Go networking internals — https://goperf.dev/02-networking/networking-internals/
- Forth2020 on Forth multitasking — https://www.forth2020.org/about-forth
- Proposed Forth multitasking wordset — https://theforth.net/package/multi-tasking
- QED-Forth multitasking overview — http://www.mosaic-industries.com/embedded-systems/sbc-single-board-computers/freescale-hcs12-9s12-c-language/instrument-control/forth-real-time-operating-system
- Gforth pthreads and message queues — https://gforth.org/manual/Pthreads.html
- Parallel Forth and channels — http://www.ultratechnology.com/4thpar.html

### Chapter 8 — Structured Concurrency and Cancellation

- JEP 428: Structured Concurrency — https://openjdk.org/jeps/428
- Swift structured concurrency proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md
- Swift TaskGroup documentation — https://developer.apple.com/documentation/swift/taskgroup
- Trio structured concurrency essay — https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful
- Rust async book — structured concurrency — https://rust-lang.github.io/async-book/part-reference/structured.html

### Chapter 9 — Synchronization, Shared State, and STM

- Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
- GHC STM documentation — https://haskell.org/ghc/docs/latest/html/users_guide/exts/stm.html
- Haskell `stm` package — https://hackage.haskell.org/package/stm
- Concurrent Haskell base docs — https://haskell.org/ghc/docs/latest/html/libraries/base-4.22.0.0-66f8/Control-Concurrent.html
- Clojure refs and transactions — https://clojure.org/reference/refs
- Clojure concurrent programming — https://clojure.org/concurrent_programming

### Chapter 10 — Data-Race Freedom and Safe Sharing

- Rust book — `Send` and `Sync` — https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html
- Swift Sendable proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0302-concurrent-value-and-concurrent-closures.md
- Swift Sendable documentation — https://developer.apple.com/documentation/swift/sendable
- Swift actors proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0306-actors.md
- Pony reference capabilities paper — https://www.ponylang.io/media/papers/fast-cheap.pdf

### Chapter 11 — I/O Integration, Timers, and Blocking Boundaries

- Go networking internals — https://goperf.dev/02-networking/networking-internals/
- Tokio runtime documentation — https://docs.rs/tokio/latest/tokio/runtime/
- Go runtime scheduler source — https://go.dev/src/runtime/proc.go
- Raku concurrency overview — https://docs.raku.org/language/concurrency
- Raku Scheduler role — https://docs.raku.org/type/Scheduler
- Raku Channel docs — https://docs.raku.org/type/Channel
- Raku Promise docs — https://docs.raku.org/type/Promise
- Raku `react` syntax — https://docs.raku.org/syntax/react
- Raku `whenever` syntax — https://docs.raku.org/syntax/whenever
- Rakudo continuation explanation for non-blocking await — https://stackoverflow.com/questions/62817878/what-are-the-specifics-about-the-continuations-upon-which-rakudo-relies/62819961

### Chapter 12 — Runtime Observability and Debuggability

- Go runtime hacking guide — https://go.dev/src/runtime/HACKING.md
- Tokio runtime documentation — https://docs.rs/tokio/latest/tokio/runtime/
- Swift structured concurrency proposal — https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md
