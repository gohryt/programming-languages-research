# Debuggers

Research on debugger implementations — user-facing bug-finding tools that pause, inspect, step, replay, or time-travel through program execution.

This document covers breakpoint mechanisms from the debugger's side, record/replay and checkpointing, omniscient/time-travel tooling, live-visualization and in-engine overlays, debugger-as-service protocols and scripting APIs, retroactive and partial evaluation, DWARF correctness and build-ID symbol distribution, automated fault-isolation (delta debugging, slicing, spectrum-based localization, statistical debugging, cause-effect chains, symbolic execution, fuzzer-assisted triage, IR-level UB interpreters, interrogative and declarative debugging), async-stack reconstruction, concurrency-aware race and deadlock detectors, post-mortem / out-of-process debugging (core dumps, kdump, kernel debuggers, embedded probe stacks), and specification-level debugging (model-checker counterexamples, interactive theorem prover proof states). Production-style observability, profiling, and always-on instrumentation live in `TRACERS.md`. Memory-safety mechanisms (sanitizers, hardware tagging, aliasing models, ownership disciplines) live in `MEMORY.md`; the Miri/Stacked-Borrows angle is split between `DEBUGGERS.md §8.8` here and `MEMORY.md §§1.3, 8.11`. Parser and compiler implementation details are in `PARSERS.md` and `COMPILERS.md`. Module systems, dynamic loading, and hot module replacement at the language-level boundary live in `MODULES.md` (see especially `MODULES.md §11` for hot-reload from the module-system angle).

---

## 1. Breakpoint Mechanisms

A breakpoint mechanism stops execution at a target condition and reliably resumes afterward — often on code that other threads are executing concurrently. Entries in this chapter differ on *where the stop condition lives*: patched into the instruction stream (`INT 3`, compiled conditional), wired into the CPU's memory-access pipeline (hardware debug registers), repurposed from a protection-boundary feature (RISC-V PMP, page-table permissions), built on the runtime's own event taxonomy (exceptions, syscalls, library loads, allocator events), or expressed as language-level invariants (assertions, contracts, semantic preconditions). The progression is from physical to logical: lower entries cost a CPU trap; higher entries cost a runtime-managed predicate evaluation.

### 1.1. GDB — INT 3 and Displaced Stepping

GDB sets breakpoints by overwriting the first byte of the target instruction with `0xCC` (INT 3). When the CPU executes it, a trap fires, transferring control to the debugger. The original byte is saved and restored when resuming.

To resume past a breakpoint without removing it (which would be racy in multithreaded programs), GDB uses "displaced stepping": it copies the original instruction to an out-of-line scratch area, executes it there, then adjusts the PC. This avoids the classic remove-step-reinsert race.

The simplest breakpoint mechanism is also the most universal. Every CPU architecture has a trap instruction. The out-of-line execution trick avoids races that simpler schemes cannot handle.

Sources: https://eli.thegreenplace.net/2011/01/27/how-debuggers-work-part-2-breakpoints and https://devblogs.microsoft.com/oldnewthing/20241111-00/?p=110503

### 1.2. Chris Wellons — INT3;NOP as Fast Conditional Breakpoint

Chris Wellons (nullprogram.com) observed that GDB's conditional breakpoints are unusably slow because GDB stops the process, evaluates the condition in the debugger, and resumes — on every hit. For a breakpoint inside a tight loop with a rare condition, this means millions of stop/evaluate/resume cycles per second.

His alternative: compile the condition directly into the code:

```c
#define breakpoint() asm ("int3; nop")

if (rare_condition) breakpoint();
```

The `nop` after `int3` is essential because `int3` leaves the instruction pointer on the *next* instruction, confusing GDB about the current scope. The `nop` gives GDB something to "land on" within the correct scope.

This transforms a conditional breakpoint from a debugger-evaluated expression (thousands of context switches per second) into a single compiled branch (zero cost until the condition is true). The fastest debugger interaction is one that doesn't involve the debugger at all.

He also describes "named positions" using C labels or assembly labels as stable breakpoint targets that survive code edits — a clever alternative to line-number breakpoints that drift when the source changes.

Source: https://nullprogram.com/blog/2024/01/28/

### 1.3. x86 Hardware Debug Registers (DR0–DR3)

x86 processors provide four hardware debug registers (DR0–DR3) that can trigger a debug exception when a specific memory address is read, written, or executed. The addresses are configured via DR7 (the debug control register). When a watched address is accessed, the CPU raises a #DB exception.

The remarkable property: hardware watchpoints add **zero overhead** to instructions that don't touch the watched address. There is no polling, no flag check, no NOP — the watch is implemented in the memory access pipeline itself. The only cost is the trap handling when the watchpoint fires (~3μs on Linux via perf).

The limitation: only 4 watchpoints, each watching at most 8 bytes. For debugging a specific variable or memory location this is ideal. For broader tracing it is insufficient. GDB uses hardware watchpoints when available and falls back to single-stepping (vastly slower) when you exceed 4.

Linux exposes this via `perf_event_open` and `ptrace(PTRACE_POKEUSER)`. Jane Street's `perftrace` tool wraps this in a Python library that records timestamps and register values when watchpoints fire, enabling trace-style analysis of specific memory locations.

Source: https://thume.ca/2023/12/02/tracing-methods/ — "Hardware breakpoints" section.

### 1.4. Raven — RISC-V Physical Memory Protection (PMP) as a Debugging Primitive

Because bare-metal RISC-V often lacks standardized external debugging hardware, researchers from SUSTech designed "Raven". Instead of relying on JTAG or dedicated debug modules, Raven creatively repurposes the RISC-V Physical Memory Protection (PMP) security feature into a debugging primitive. By restricting access to specific memory regions, they trigger PMP faults that act as extremely lightweight, zero-modification watchpoints and breakpoints. This allows full kernel debugging capabilities (stepping, introspection) on completely bare-metal embedded targets with near-zero idle overhead.

Source: https://fengweiz.github.io/paper/raven-dac22.pdf (DAC '22)

### 1.5. Page-Protection Watchpoints and Guard Pages

Hardware debug registers are precise but tiny: on x86, usually four watched addresses, each limited to a small width. A scalable alternative is to use page permissions. Mark a page `PROT_NONE` with `mprotect()` or `PAGE_GUARD` / `VirtualProtect()` on Windows; when the target reads or writes that page, the CPU raises a page fault and the debugger decides whether the access is interesting.

The trade-off is precision versus scale. Page watchpoints can cover kilobytes or megabytes and can be created in large numbers, but they trigger on every access to the protected page, not only the watched object. Debuggers and runtimes can reduce false positives by isolating selected objects onto their own pages, using guard pages around stacks or heap allocations, or combining page faults with single-step/reprotect logic.

The language-design lesson: **allocator cooperation turns crude page faults into useful object watchpoints**. A runtime that can place one object, arena, stack segment, or actor heap on a protected page can offer data breakpoints that are far larger than hardware DR registers allow.

Sources: https://man7.org/linux/man-pages/man2/mprotect.2.html and https://learn.microsoft.com/en-us/windows/win32/memory/creating-guard-pages

### 1.6. Event Breakpoints / Catchpoints

Line breakpoints answer "stop here." Event breakpoints answer "stop when this kind of thing happens anywhere." Mature debuggers expose catchpoints for exceptions, signals, syscalls, process creation, thread creation, library loading, allocation, panic, and language-specific runtime events.

GDB's `catch throw`, `catch syscall`, `catch fork`, `catch exec`, and shared-library catchpoints are the native model. Java debuggers expose caught/uncaught exception breakpoints through JPDA/JDWP. Chrome DevTools has "pause on caught exceptions" and "pause on uncaught exceptions." A language runtime can generalize this to actor message sends, task spawns, cancellation, effect invocation, allocation classes, or contract violations.

The language-design lesson: **make runtime events first-class debugger stop reasons**. If the runtime already classifies events for exceptions, panics, tasks, actors, effects, or allocators, expose those same event IDs to the debugger instead of forcing users to guess implementation functions to break on.

Sources: https://sourceware.org/gdb/current/onlinedocs/gdb.html/Set-Catchpoints.html and https://chromedevtools.github.io/devtools-protocol/tot/Debugger/

### 1.7. Assertions, Contracts, and Semantic Breakpoints

Assertions and contracts are executable claims about program state: preconditions, postconditions, invariants, representation checks, and internal sanity checks. They are usually treated as testing or verification tools, but they are also debugger hooks. A contract violation is a semantically meaningful breakpoint: the program can stop exactly where an assumption first becomes false, with the violated predicate, source location, values, and call stack preserved.

Eiffel made Design by Contract central to the language. Racket contracts enforce boundaries between components. Ada/SPARK contracts connect runtime checking and formal proof. Rust separates always-on `assert!` from debug-only `debug_assert!`. C++26 contract assertions add language-level `pre`, `post`, and `contract_assert` forms with different evaluation modes. Swift distinguishes `assert`, `precondition`, and unconditional traps.

The language-design lesson: **contracts should have debugger semantics**. A new language can define whether contract failures terminate, throw, invoke restarts, enter the debugger, continue in observe mode, log telemetry, or become catchable semantic breakpoints. This gives users a precise spectrum from zero-overhead release builds to invariant-rich debug builds.

Sources: https://docs.racket-lang.org/guide/contracts.html, https://www.eiffel.org/doc/eiffel/ET-_Design_by_Contract_%28tm%29%2C_Assertions_and_Exceptions, and https://cppreference.dev/w/cpp/language/contracts

---

## 2. Record and Replay

Record/replay debuggers turn execution into an artifact you can rewind or query. Entries differ on **what fraction of execution is re-derived on replay vs. captured at record time**: rr records nondeterministic inputs and re-derives the rest; Pernosco post-processes rr traces into a searchable database; VS Snapshot and CRIU capture whole program state at chosen points; Magic Trace and Perfetto appear here only for their debugger workflows. Their tracing substrates are covered in `TRACERS.md`.

### 2.1. rr — Deterministic Record and Replay

Mozilla's `rr` records the execution of a Linux process with ~20% overhead by:
1. Executing only one thread at a time (eliminating data race nondeterminism).
2. Using CPU hardware performance counters (retired conditional branches) to measure application progress deterministically.
3. Recording only the sources of nondeterminism: system call results, signal delivery points, context switch points.

Replay re-executes the program using the same counter values to deliver signals and switch contexts at exactly the right points. This gives bit-for-bit identical replay.

Because replay is deterministic, GDB's reverse execution commands work: reverse-continue, reverse-step, reverse-next. `rr` implements these by restoring the nearest checkpoint and replaying forward to the desired point.

The critical insight: you don't need to record every instruction — only the nondeterministic inputs. The CPU deterministically re-derives everything else during replay. This makes recording nearly free for CPU-bound code. The ~20% overhead comes primarily from the single-threaded scheduling constraint.

The hardware performance counter approach is brittle — it depends on CPU-specific counter behavior and has been broken by various CPU microcode updates and errata. The rr team maintains a list of known-good CPU models. An alternative project, `rr.soft`, replaces hardware counters with lightweight dynamic instrumentation for environments where counters are unavailable (VMs, cloud, Apple Silicon via emulation).

Sources: https://rr-project.org/ and https://queue.acm.org/detail.cfm?id=3688088

### 2.2. Pernosco — Omniscient Debugging via Post-Hoc Analysis

Robert O'Callahan (rr's creator) built Pernosco on top of rr recordings. Pernosco takes an rr trace, analyzes it using massive parallelism in the cloud, and builds a **searchable database of all program states at all points in time**. The result is an omniscient debugger that instantly answers:

- "What is the value at this memory address at time T?"
- "When was this value last modified?"
- "What is the dataflow path from this NULL to its origin?"

The killer feature is **reverse dataflow tracking**: click on a NULL pointer, and Pernosco traces it back through registers and memory to the exact instruction that produced it — without re-executing anything. This is by far the most powerful debugging capability we encountered in the research.

Pernosco also demonstrates "omniscient JS debugging" by observing V8's internal operation and inferring JavaScript-level state without modifying V8's source code. This suggests that high-level language debugging can be implemented as a layer on top of low-level omniscient tracing.

The trade-off: Pernosco's analysis takes minutes to hours and writes tens of gigabytes. It is a post-hoc tool, not a live tool. But users report it is overwhelmingly faster than traditional debugging for complex bugs.

Sources: https://pernos.co/ and https://robert.ocallahan.org/2024/10/debt-workshop.html

### 2.3. Visual Studio Snapshot Debugger — Non-Breaking Production Snapshots

Visual Studio's Snapshot Debugger for Azure App Service and Application Insights introduced "snappoints": non-breaking breakpoints that collect a point-in-time view of application state when a condition is hit in production. Unlike traditional breakpoints, a snappoint does not stop the live process for interactive stepping; it captures stack frames, locals, and related diagnostic data so the developer can inspect the recorded state later.

The important design pattern is not Unix `fork()` itself but **out-of-band snapshot collection**: the production request continues while the debugger receives a bounded artifact for later inspection. The implementation details vary by platform and runtime, and Microsoft documents the feature as a managed .NET snapshot/debugging facility rather than as a general fork-and-copy-on-write debugger.

This is a fundamentally different model from traditional debugging: snappoints don't stop execution. They create an inspectable point-in-time artifact, possibly collected from production, but you cannot freely step forward from it the way you would in a paused live process.

Source: https://devblogs.microsoft.com/visualstudio/snapshot-debugging-with-visual-studio-2017-now-ready-for-production/

### 2.4. QEMU Record/Replay — Full-System Deterministic Execution

QEMU supports full-system record and replay by running in `icount` mode (instruction counting). All nondeterministic events — hardware interrupts, timer reads, network packets, disk I/O — are logged with their instruction count. During replay, events are injected at exactly the same instruction count, producing identical execution.

Unlike rr (which only records userspace), QEMU records the entire virtual machine including the kernel, drivers, and all processes. The cost is running inside QEMU's TCG (Tiny Code Generator) JIT instead of native execution, which is typically 5–10x slower. But for kernel-level debugging or debugging across the user/kernel boundary, it is the only option.

Source: https://www.qemu.org/docs/master/devel/replay.html

### 2.5. WinDbg Time Travel Debugging (TTD) — Reverse Debugging + Queryable Trace Objects

WinDbg's Time Travel Debugging is not just "reverse execution on Windows." Its original contribution is the **query model** layered on top of the recording. Microsoft describes TTD as capturing a trace of process execution and replaying it forward or backward, but the really interesting part is that the trace is exposed as a set of **data-model objects** accessible via `dx`, JavaScript, and C++.

That makes TTD closer to a searchable execution database than to a traditional breakpoint-driven debugger. The most compelling example is the `TTD.Memory(begin, end, mask)` query interface, which returns a collection of memory-access objects for an arbitrary address range, including thread ID, IP, access type, time position, size, and value. This is a very different workflow from "set a watchpoint and wait." Instead, you **search the recorded past**.

This also distinguishes TTD from rr in a useful way. rr's killer move is deterministic replay with hardware watchpoints and reverse-continue. TTD's killer move is that the recording is directly queryable with debugger-object infrastructure, which makes large-scale "who touched this?" investigations much more natural inside the debugger itself.

The trade-off is that TTD is still a recording-based system: it adds overhead while capturing, and it is Windows-centric. But as a debugger UX idea — execution history as a queryable object model — it deserves to be in any survey of original debugger designs.

Sources: https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/time-travel-debugging-overview and https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/time-travel-debugging-object-model and https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/time-travel-debugging-memory-objects

### 2.6. devops-rewind — Branching Terminal Session Debugger

Bringing time-travel debugging concepts to the CLI, `devops-rewind` records every command (and its stdout/stderr, exit code, and context) as a numbered "step". When a multi-step deploy script or process fails, users can "rewind" to a specific step instead of restarting from scratch. The branching engine copies the session state from 0 through N into a new object and opens a new recorder, functioning like `git checkout` but for live terminal execution history.

Source: https://dev.to/lakshmisravyavedantham/i-built-a-terminal-session-debugger-with-rewind-breakpoints-and-branching-3gka

### 2.7. CRIU — Checkpoint/Restore In Userspace

CRIU (pronounced "kree-oo") freezes a running Linux process or container, writes its complete state (memory, file descriptors, TCP connections, pipe contents, cgroups, timers) to disk, and later restores the process to continue executing as if no freeze happened. It ships as container-live-migration infrastructure, but the docs explicitly surface a debugging workflow called **deferred debug**: checkpoint a misbehaving production app, restart it immediately to preserve the SLA, and debug the dump file at leisure.

The original mechanism is the **"CRIU morphs into the target"** trick. During dump, CRIU uses `ptrace` to inject a *parasite blob* into the target's address space; the parasite reads memory from inside the target and writes it out, because much of the relevant state can only be captured from within the process's own mapping. During restore, CRIU forks, and the child process *unmaps itself and becomes the target* via a *restorer blob* — a small piece of code positioned to not overlap either CRIU's mappings or the target's — which runs `munmap`/`mmap` to install the target's original memory layout and jumps into it.

This puts CRIU in a different category from rr and VS Snapshot. It does not record execution over time; it captures one point and can re-launch the process from there. Multiple checkpoints can be stored, compared, or shipped as a bug report. Combined with rr or Pernosco, a CRIU dump can be the seed for deterministic replay analysis on another machine.

The limitations are concrete: not every resource can be C/R'd (GPUs, some kernel interfaces, raw sockets), and the restored process must land on a kernel and filesystem close enough to the dump to look the same from userspace. MPI and GPU-accelerated workloads often fail outright.

Sources: https://criu.org/Main_Page and https://criu.org/Assisted_debugging

### 2.8. UndoDB / LiveRecorder — JIT-Instrumented Record/Replay

Undo's UDB is a commercial time-travel debugger for Linux C/C++/Rust that differs from rr (§2.1) in four architecturally interesting ways, each addressing a limitation that bit rr users in practice.

**JIT binary instrumentation** replaces rr's dependence on hardware performance counters. UDB inserts instrumentation at runtime into the instruction stream to measure progress deterministically, so it runs on CPUs where rr cannot — including systems where microcode updates broke PMU determinism, virtualized environments that expose inconsistent counters, and ARM64. The trade-off is higher recording slowdown (roughly 2–4×) versus rr's ~20%, but portability across supported Linux CPU and virtualization environments is much broader.

**Deferred recording mode** lets the debugger attach to a suspect process *with recording disabled*, and activate recording (`urecord`) only when something interesting is about to happen. Combined with **time limits** (`set time-limits min/max bbcount|percent|bookmark`) that constrain how far forward/reverse commands can move, this makes long recordings actually navigable — you bound the history region in focus rather than dragging the debugger across hours of irrelevant history.

**Thread fuzzing** deterministically reproduces races by perturbing scheduler decisions during recording until a race manifests, after which the resulting recording replays the race identically on demand. This converts flaky multithreaded bugs into reproducible ones — a complementary approach to ThreadSanitizer (§10.1) for cases where you already have a race but cannot catch it live.

**LiveRecorder** is the CI/production variant: UDB attached to a running service emits portable recordings shippable to a developer's machine. 99% of program state is reconstructed on demand from the minimal recording of nondeterministic inputs. UDB presents as GDB-compatible (100% of GDB commands plus `reverse-*` and `ugo time|undo|redo`), so existing VS Code / CLion / Emacs integrations work unchanged.

rr and UDB together map the design space for record/replay: rr's hardware-counter route is fastest on supported CPUs; UDB's JIT route is more portable across CPUs and virtualized environments; both share the deterministic-replay-plus-reverse-execution core and produce traces that a GDB front-end can drive.

Sources: https://undo.io/products/udb/ and https://docs.undo.io/GettingStartedWithUDB.html

### 2.9. TotalView ReplayEngine — MPI / HPC Reverse Debugging

TotalView (Perforce) is the classic HPC parallel debugger; ReplayEngine is its reverse-execution add-on. Its distinctive contribution is applying the omniscient pattern **across MPI processes**: a `dload -replay program-path` or `dattach -replay program-path` starts recording, and reverse commands (back-to, step-back, reverse-continue) then navigate the execution history of any rank in a many-process MPI job.

The difficulty ReplayEngine addresses is that HPC parallel programs communicate via RDMA (Infiniband, Cray XT/XE/XK/XC, SGI XPMEM) — remote-DMA writes that bypass the kernel and slip past ordinary record/replay mechanisms. ReplayEngine injects environment variables at MPI launch to disable specific RDMA optimizations so the writes remain visible, handles SGI XPMEM's cross-process memory mapping with configurable caps (`MPI_MAPPED_HEAP_SIZE`, `MPI_MEMMAP_OFF`), and ships per-MPI-stack configuration in its `parallel_support.tvd` file.

This is the omniscient pattern applied to scientific parallel computing where bugs manifest only at scale — thousands of MPI ranks, weeks of wall time, non-reproducible races between ranks. rr (§2.1) is single-threaded by construction; ReplayEngine lives in the opposite corner of the design space: heavy, coarse, but correct under multi-rank RDMA communication.

The design lesson: **deterministic replay must be negotiated with every nondeterminism source in the platform**. On a desktop, that means the scheduler and the kernel. On HPC, add MPI, RDMA, NUMA memory affinity, and GPU offload. A language runtime aiming at HPC has to expose hooks for each.

Sources: https://help.totalview.io/classicTV/current/HTML/Splash/tvgettingstartedug-gettingStarted.3.30.html and https://help.totalview.io/previous_releases/2024.2/HTML/TotalView/totalviewlhug-parallel-debugging-setup.19.46.html

### 2.10. Magic Trace — Triggered Hardware-Trace Debugging

Jane Street's `magic-trace` is covered as a hardware-tracing mechanism in `TRACERS.md §5.1`; the debugger-specific contribution is the workflow. Intel Processor Trace records recent control flow into a circular buffer, and a trigger event snapshots the last ~10 ms into a call-stack timeline viewable in Perfetto.

This answers a narrower but highly practical question than full record/replay: **what executed immediately before the crash, latency spike, or suspicious state?** It does not provide arbitrary historical values, but it gives low-overhead retrospective control-flow debugging for production-like runs. The language-design lesson is that hardware traces become useful only after the runtime/compiler can reconstruct meaningful language frames from raw branch packets.

Sources: https://github.com/janestreet/magic-trace and https://blog.janestreet.com/magic-trace/

### 2.11. `ocamldebug` — Fork-Checkpoint Reverse Execution (1991)

OCaml's built-in bytecode debugger has supported **reverse execution for three decades** — long predating rr, Pernosco, and most of this chapter. Commands: `reverse`, `backstep`, `previous` (step backward skipping calls), `start` (run backward to function entry), `goto time` (jump to an absolute instruction counter), `last` (undo the previous navigation command), `set history size`.

The implementation is a classic Unix fork-CoW checkpointing trick applied recursively for **time-travel**: the OCaml runtime periodically `fork()`s and suspends the child process as a **checkpoint**. Forward execution runs against the current process; reverse execution discards the current process and resumes the nearest checkpoint ≤ the target time, replaying forward to land exactly. Because each checkpoint is copy-on-write, memory overhead is proportional to post-checkpoint divergence, not to process size.

The restrictions are concrete: `ocamldebug` only works on bytecode (not native), only on Unix (Cygwin on Windows), and requires `-g` at compile time. But within those bounds, it demonstrates that **reverse execution is cheap in a language whose runtime controls process forking and whose instruction counter is deterministic** — two properties any new language can adopt at design time.

OCaml's `ocamlearlybird` exposes this over the Debug Adapter Protocol (§5.2); the DAP `StepBack` and `ReverseContinue` requests map to the native `backstep` and `reverse` commands. The underlying checkpoint machinery is unchanged since the early 1990s.

Source: https://ocaml.org/manual/5.3/debugger.html

### 2.12. Perfetto TraceProcessor + PerfettoSQL — Trace as Queryable Evidence

Perfetto's recorder, wire format, and visualization role are covered in `TRACERS.md §11.2`. The debugger-adjacent contribution is **TraceProcessor**: it ingests a trace and exposes execution events as SQLite-queryable relational tables.

That makes a trace more than a timeline. A debugger or investigation tool can ask structured questions over `slice`, `thread_slice`, `counter`, `process`, `thread`, `cpu`, and symbol tables instead of manually scrolling through rectangles. PerfettoSQL adds domain-specific table/function/view/macro support and reusable metrics, turning common performance-debugging questions into named queries.

The design lesson is narrow and important: if runtime events are emitted with stable typed schemas, a debugger can treat execution history as queryable evidence. Timeline UI is one view; SQL-like analysis is the more general interface.

Sources: https://perfetto.dev/docs/analysis/perfetto-sql-getting-started and https://perfetto.dev/docs/analysis/perfetto-sql-syntax

---

## 3. Omniscient / Time-Travel Debugging

Omniscient debugging records every interesting event and makes the execution history queryable after the fact — inverting the breakpoint model. Entries differ on **what the recorded unit is and who pays the cost**: variable assignments (ODB), structurally-shared states (Toby Ho), immutable model updates (Elm, Redux DevTools), bytecode-woven event streams at production scale (Chronon, TOD, IntelliTrace, RevDebug), decorator-level single-function traces (PySnooper, snoop, viztracer), reflective runtime frames (Pharo, Common Lisp, Racket), debugger-architecture outliers such as hypervisor-invisible hooks (HyperDbg), and managed-runtime hot-replacement (Edit-and-Continue, JVM HotSwap, Flutter hot reload) that folds compilation back into the paused-debug session. The common thread is Bil Lewis's original claim: **you don't need breakpoints if you record everything** — with HyperDbg included here as a time-travel-adjacent contrast rather than as a recording system.

### 3.1. Bil Lewis — ODB (Omniscient Debugger for Java)

Bil Lewis's ODB, the original omniscient debugger, records *every variable assignment* as a `(timestamp, variable, old_value, new_value)` tuple. After execution, a GUI allows the programmer to navigate backwards and forwards through the entire history.

The core idea: **you don't need breakpoints if you record everything.** The debugger becomes a database query tool — "show me the last time variable X changed" is a lookup, not a re-execution. "Which threads ran when?" is a fact, not a mystery.

Lewis reported that his programming style changed after using ODB exclusively: *"I now write insanely fast, making numerous mistakes. This gives me something to search for with the ODB. It's fun."* This observation — that omniscient debugging changes not just how you debug but how you write code — is striking.

The recording overhead is real but bounded. Lewis reported being able to debug Ant, JUnit, and the debugger itself. The approach does not scale to long-running production workloads, but for development and testing it is viable.

Source: https://omniscientdebugger.github.io/

### 3.2. Toby Ho — Structural Sharing for Time-Travel State

Toby Ho built a time-traveling debugger for his "Fun" language that records a snapshot of the entire program state at every step. To keep the recording compact, he uses **structural sharing** — if a stack frame didn't change between two steps, only a reference to the previous frame is stored, not a copy.

He invented a "JSON-R" format (JSON with References) where objects can be assigned IDs (`+1 {...}`) and later referenced (`*1`), allowing the history file to share identical sub-trees across snapshots.

The insight: program state changes incrementally. Most of the state is identical between consecutive steps. Persistent/immutable data structures or copy-on-write can reduce the recording overhead from O(state_size × steps) to O(delta × steps). For programs where most variables don't change on most steps, this is a dramatic reduction.

The limitation: the history file is written to disk and the debugger reads it back after execution. This is not a live debugger — it is a post-mortem replay tool. But the offline model has advantages: the debugger never needs to re-execute the program, and the history file can be shared with colleagues.

Source: https://www.tobyho.com/video/Time-Traveling-Debugger-Part-1.html

### 3.3. Elm — Immutable State Time Travel

Elm's architecture (The Elm Architecture, TEA) naturally supports time-travel debugging because every state update produces a new immutable state value. The debugger simply holds onto each state over time and provides a slider to scrub through them.

Because Elm's model values are immutable, the debugger does not need to deep-copy mutable object graphs at each step. Consecutive states can share structure through persistent data structures, making time-travel cheap compared with snapshotting an equivalent mutable program.

This only works for languages designed around immutable values from the start. Retrofitting it onto mutable-state languages requires explicit snapshotting, which is expensive. Elm demonstrates that language-level design decisions can make powerful debugging features trivial to implement.

Source: https://elm-lang.org/news/time-travel-made-easy

### 3.4. Pharo/Smalltalk — The Debugger as Development Tool

Pharo's debugger is not a diagnostic tool bolted onto the side — it is a primary development tool. When an error occurs (including `doesNotUnderstand:`, the equivalent of "method not found"), the debugger opens with the full execution stack. The developer can then:

- **Create the missing method on the fly** from inside the debugger, type the implementation, and **proceed** — execution resumes as if the method had always existed.
- **Restart any frame** in the call stack, re-executing from that point with modified code or variables.
- **Edit any method** in the stack and proceed with the new version.

This is possible because Smalltalk's runtime is fully reflective — `thisContext` is a first-class object representing the current stack frame, methods are objects that can be recompiled at any time, and the VM supports frame restart natively.

The philosophical point: the debugger is the IDE. Rather than a cycle of edit → compile → run → crash → read error → edit, the Smalltalk workflow is: run → crash → the debugger opens → write the code right there → proceed. The boundary between "writing code" and "debugging code" dissolves entirely.

No other mainstream language has achieved this level of integration, except Common Lisp (see below).

Sources: https://pharo.org/ and https://stackoverflow.com/questions/54496857/how-does-pharo-starts-debugger-when-message-is-not-understanded

### 3.5. Common Lisp — Condition/Restart System

Common Lisp's condition system separates three concerns that most languages conflate into "exception handling":

1. **Signaling:** Code detects an error and signals a condition (like throwing an exception), but the stack is *not* unwound.
2. **Handling:** A handler higher in the call stack decides what to do — but it runs *with the signaling frame still live*. It can inspect the full stack.
3. **Restarting:** The handler invokes a *restart* — a recovery strategy established by code between the handler and the signaler. The restart runs in the signaler's frame, not the handler's frame.

The critical difference from exceptions: the stack is not unwound before the handler runs. The handler can see the full context of the error, choose a recovery strategy, and resume execution as if the error never happened.

In the interactive debugger, when an unhandled condition is signaled, the debugger presents the user with a list of available restarts. The user can choose "use this value instead," "retry the operation," "skip this item," etc. — all without losing the execution context. This is the programmatic foundation for Pharo-style "fix it in the debugger" workflows, but expressed as a language-level mechanism rather than a VM feature.

The power is that libraries can establish restarts for anticipated failures without knowing how callers will handle them, and callers can handle them without knowing the library's internals. The debugger is just one possible handler.

Source: https://lisp-docs.github.io/docs/tutorial/conditions

### 3.6. Racket — Continuation Marks

Racket extends Scheme with "continuation marks" — key-value annotations that can be attached to any continuation frame (roughly, any stack frame). They are a language-level mechanism for stack inspection that doesn't require special VM privileges.

Any code can attach a mark to the current frame with `with-continuation-mark`, and any code can read all marks on the current continuation with `current-continuation-marks`. Marks on tail-called frames replace the previous mark rather than accumulating, preserving tail-call space guarantees.

Debuggers and profilers use continuation marks to implement stack inspection, step tracing, and source location tracking entirely within the language. The DrRacket IDE's debugger is implemented using continuation marks — it annotates source expressions with marks, then reads them to determine the current source location and available bindings.

The insight: if the language provides a first-class mechanism for annotating the stack, then debuggers don't need special VM hooks. They can be written as regular library code. Continuation marks also support other use cases: dynamic scoping, cost semantics tracking, and contract blame.

The overhead is one mark allocation per annotated frame. When no marks are read, the only cost is the allocation (which is amortized by the GC). When marks are read, it is a stack walk — but only the marks with the requested key are returned, not the entire stack.

Sources: https://www2.ccs.neu.edu/racket/pubs/dissertation-clements.pdf and https://srfi.schemers.org/srfi-157/srfi-157.html

### 3.7. HyperDbg — Ring -1 Debugging with EPT Hidden Hooks

HyperDbg takes a very different route from source-level debuggers and conventional kernel debuggers: it moves the debugger down to **ring -1**, building on Intel VT-x and EPT. The CCS 2022 paper describes HyperDbg as a hypervisor-based debugger that virtualizes an already running Windows system, aiming to be stealthy and as OS-independent as possible.

The most original mechanism is the **EPT hidden hook**. HyperDbg documents a mode that places a hidden `0xCC` breakpoint on a target function **without modifying the content of memory in the case of reading/writing**. In other words, code inspection from the guest can still see the original bytes even though execution traps on the hooked address. The docs also describe a faster `!epthook2` mode that avoids VM-exits, plus larger ambitions such as invisible read/write watchpoints, coverage measurement, and memory-move monitoring.

This is philosophically different from traditional debugger design. The debugger is not negotiating with the guest OS, nor patching visible code in the usual way. It is using the virtualization layer as the debugging primitive. That makes HyperDbg especially interesting for reverse engineering, anti-anti-debugging, and malware analysis, where being seen by the target is itself part of the problem.

The price is complexity and specificity. This is specialized machinery: Windows, VT-x, EPT, kernel-mode/hypervisor expertise, and significant engineering surface area. But it is genuinely original and belongs in the survey.

Sources: https://misc0110.net/files/hyperdbg_ccs22.pdf and https://docs.hyperdbg.org/commands/extension-commands/epthook and https://github.com/HyperDbg/docs

### 3.8. REPL-Integrated Debuggers — pdb, PuDB, GHCi `:history`

Dynamic-language REPLs embed the debugger as first-class commands rather than a bolt-on tool. Python's `pdb.set_trace()` (and its 3.7+ `breakpoint()` builtin) hard-codes a break in source; PuDB wraps pdb in a full-screen TUI; GHCi integrates `:break`, `:trace`, `:history`, `:back`, and `:forward` directly into Haskell's interactive environment.

The most original of these is **GHCi's `:history` / `:back`**. Because Haskell is lazy-evaluated, there is no meaningful *lexical* call stack at an arbitrary point — evaluation order does not follow source order, so "what called this function" is often unanswerable. GHCi works around this by maintaining a **ring buffer of the last N breakpoint locations passed through during evaluation**. When an exception fires, `:history` prints the sequence, `:back` steps backwards through it, and the user can inspect bindings at each historical location. This is a bounded time-travel mechanism built inside a lazy language, solving a problem eager languages do not have.

Python's `pdb` contribution is idiomatic ubiquity: `pdb.set_trace()` can be dropped anywhere, and in 3.14 the function gained a `backend` parameter to swap between `sys.settrace` (legacy) and PEP 669 `sys.monitoring` (shipped in 3.12) — the latter gives near-zero overhead when no tool is attached. PEP 768's Safe External Debugger Interface (accepted 2025) is the sibling mechanism on the attach side, covered in `TRACERS.md §2.2`. PuDB's angle is the TUI: a single-terminal split view with source, stack, breakpoints, and variables, plus post-mortem-on-crash and remote-over-socket modes, entirely keyboard-driven.

The broader pattern: in a language with an interactive REPL, the debugger is not a separate tool but a set of REPL commands that share the interpreter's state. This is the less reflective cousin of Pharo's `doesNotUnderstand:` integration (§3.4) and Common Lisp's condition/restart system (§3.5) — the same philosophy at a lower ceiling.

Sources: https://docs.python.org/3/library/pdb.html and https://documen.tician.de/pudb/index.html and https://simonmar.github.io/bib/papers/ghci-debug.pdf

### 3.9. Managed-Runtime Omniscient Debuggers — Chronon, TOD, IntelliTrace, RevDebug

Bil Lewis's ODB (§3.1) defined the shape of omniscient debugging for Java but did not solve scale. Four production-grade successors share its architecture — **bytecode weaver + event stream + replay UI + queryable history** — and each makes a different engineering bet on where the overhead lands.

**Chronon** (Prashant Deva, commercial) markets itself as "DVR for Java." A bytecode weaver logs every method call, variable assignment, and exception at runtime. The Eclipse and IntelliJ plugins let the developer **click any line of program output and jump to the moment in the recording where it was generated**; scrub backward, inspect any variable at any prior time, view the full history of changes to a field. Recording can be toggled on/off in a running JVM. The plugin is literally a time-traveling GUI wrapper over the recording file, which the developer queries like a database.

**TOD (Trace-Oriented Debugger)**, Guillaume Pothier and Éric Tanter at Université de Chile, is the academic answer to ODB's scalability problem: a **distributed event database** that scales roughly linearly across a cluster — sustained ingest of 55k events/s on one machine, 470k events/s on ten. The target JVM, event database, and debugger frontend run in separate processes; the weaver hooks the class-loading mechanism and caches weaved classes in the target JVM. **Scoped trace capture** (exclude the JDK, disable around tight loops) is essential to keep overhead usable.

**Microsoft IntelliTrace** (Visual Studio Enterprise) is the .NET/CLR analogue. Records debugger events, exceptions, .NET Framework events, and optional full-process snapshots at every breakpoint/step in its "Events and Snapshots" mode — clicking a past event in the Diagnostic Tools window switches the debugger's *time context* to that event via "Activate Historical Debugging." Produces `.iTrace` files, which a **stand-alone collector** can capture on production machines without a full VS install; an engineer opens the file in VS Enterprise later.

**RevDebug** (originally "Time Machine for .NET," renamed 2016) is the commercial "flight recorder for your code" for .NET/Java/Python/JavaScript. Value prompts show variable values inline in source during replay; global search spans the entire recording; session recording is explicitly marketed for **production** use alongside end-to-end tracing and topology discovery — an observability platform with a time-travel debugger front-end.

All four make the same design bets ODB made: record through bytecode instrumentation, store as events, replay through a trace-as-database UI. They differ on **where the overhead lands** — Chronon on the target JVM, TOD on a database cluster, IntelliTrace on snapshot size, RevDebug on commercial-grade scoping heuristics — and on **where the product boundary sits**: IDE plugin (Chronon/IntelliTrace), research prototype (TOD), commercial observability platform (RevDebug). The pattern is mature enough that choosing among them is an engineering trade-off, not a research question.

Sources: https://wiki.jvmlangsummit.com/Chronon_-_Time_Travelling_Debugger and https://pleiad.cl/tod/ and https://learn.microsoft.com/en-us/visualstudio/debugger/intellitrace and https://revdebug.com/

### 3.10. Decorator-Based Omniscient Tracing — PySnooper, snoop, viztracer

For languages with runtime tracing hooks (`sys.settrace` in Python, `TracePoint` in Ruby), omniscient-style debugging is often achievable with a **single decorator and no infrastructure**. The Python ecosystem has produced three tools in this category, each progressively richer.

**PySnooper** (Ram Rachum, 2019) — "a poor man's debugger." Apply `@pysnooper.snoop()` to a function, and the decorator writes a play-by-play log of every line executed and every variable assignment to stderr or a file. No setup, no breakpoints, no database. `watch=('foo.bar', 'self.x[...]')` lifts arbitrary expressions into the log; `depth=N` traces into nested calls.

**snoop** (Alex Hall) extends PySnooper with several worthwhile additions. `pp(expr)` is icecream-like structured print (§6.3); `pp.deep(lambda: expr)` **logs every intermediate subexpression in the order the expression evaluated them** — a lightweight version of Pernosco's reverse dataflow (§2.2) implemented via AST rewriting. Uses Alex Hall's `executing` library to reliably locate source positions, same as icecream.

**viztracer** captures function entry/exit events at Python level (via `sys.setprofile` plus a C extension for low overhead), writes them as Perfetto-format JSON, and opens the result in a Perfetto UI tab (`vizviewer result.json`). Handles threading, multiprocessing, asyncio, subprocess, and PyTorch natively. Filters reduce captured volume (`min_duration`, `log_sparse` mode) for long-running programs.

The design lesson: **if the language runtime exposes per-line or per-function callback hooks, decorator-based omniscient tracing is a ~100-line library**. No modified VM, no recording infrastructure, no server. The cost is runtime overhead (10–100× depending on configuration), but the workflow is "add a decorator, run once, inspect output." For exploratory debugging of a specific function, this is the cheapest omniscient pattern available in any mainstream language.

Sources: https://github.com/alexmojaki/snoop and https://pypi.org/project/PySnooper/ and https://viztracer.readthedocs.io/en/latest/viztracer.html

### 3.11. Redux DevTools — Omniscient Over Application State

Redux is a predictable state container for JavaScript where all state transitions happen through pure reducer functions on immutable actions. Redux DevTools exploits that discipline for **omniscient debugging over application state, not over execution**.

The mechanism is direct: record every **action** dispatched to the store. Because reducers are deterministic pure functions, the full state at any point in history can be re-derived by replaying actions from initial state — **no process snapshot needed, ever**. Click any action in the DevTools action list and the application state snaps to that point; the UI re-renders under the restored state. **Skip** an action (treat it as if it never dispatched) to test counterfactuals. **Reorder**, **import**, **export**, **persist** via URL hash (`?debug_session=reproducing_weird_bug` restores a named session across page loads).

This is Elm's time-travel pattern (§3.3) at the scale of the mainstream JS ecosystem. It works for the same reason Elm's does: **if state transitions are pure functions of immutable inputs, replay is free.** The pattern is the engineering expression of a language-design constraint, not a debugger feature bolted onto an arbitrary runtime.

Replay.io's Redux panel (§6.1) extends this further: because Replay records the *browser process*, not just the store, it can inspect non-serializable objects in any reducer after replaying to that dispatch. Pure Redux DevTools is limited to JSON-serializable state; Replay + Redux DevTools closes that gap by layering the omniscient execution recording underneath the action-replay view.

The design lesson for new languages: **every design decision that makes state transitions pure or immutable drops an entire class of debugger infrastructure into the language for free**. Elm got time travel from `update : Msg -> Model -> Model`. Redux got it from JS by convention. A language enforcing the pattern gets it by construction, without any ODB-style trace recorder.

Source: https://github.com/reduxjs/redux-devtools

### 3.12. Edit-and-Continue / Hot Code Replacement

Live code replacement sits between debugging and compilation. The user edits code while the program is paused or running; the runtime installs the new version; existing frames either continue on old code, deoptimize into an interpreter, restart, or map to the new version. The *module-system* preconditions that make this possible — flat-or-stable module identity, individually loadable artifacts, language-level cooperation primitives like `import.meta.hot.accept` — are covered in `MODULES.md §11`.

Visual Studio Edit and Continue, JVM HotSwap, Erlang hot code loading, Smalltalk images, Flutter hot reload, Clojure REPL-driven development, and browser hot-module replacement all pick different points in the design space. The core problems are stable function identity, active-frame migration, closure layout changes, object shape changes, inlined-frame deoptimization, and coexistence of old and new code.

This is the modern industry continuation of the Pharo (§3.4) and Common Lisp (§3.5) live-edit lineage: the difference is that managed runtimes (CLR, JVM, Dart VM) supply the deoptimization machinery the original reflective systems built into the language. The language-design lesson: **hot replacement needs versioned code and explicit frame semantics**. Decide whether active frames keep running old code, restart in new code, or can be migrated. Debuggers become dramatically more powerful if the runtime can deoptimize optimized frames back into an inspectable representation before applying a patch.

Sources: https://learn.microsoft.com/en-us/visualstudio/debugger/edit-and-continue, https://docs.oracle.com/javase/8/docs/technotes/guides/jpda/enhancements1.4.html, and https://docs.flutter.dev/tools/hot-reload

---

## 4. Live Visualization

Live visualization abandons the stop-inspect-resume loop in favor of continuous execution with behavior projected as an overlay. Entries differ on **what surface the behavior is projected onto**: the source code itself (WhiteBox), a timeline slider (Bret Victor, Light Table, Observable), a reactive-cell dependency graph (Excel's Trace Precedents), the game viewport (Unreal Gameplay Debugger), a captured GPU frame (RenderDoc, NSight, PIX), or the state chart the user already wrote (XState). Each asks what the user's mental model is and renders debugging in that model, not in the machine's.

### 4.1. Andrew Reece — WhiteBox

WhiteBox compiles, runs, and "debugs" C/C++ code live, displaying execution patterns and data transforms inline alongside the source code. Every expression shows what values it took, every branch shows how many times it was taken. A timeline slider allows scrubbing through the execution.

WhiteBox is not a debugger in the traditional sense — it is a **visualizer**. There is no "pause" or "step." Instead, the program runs to completion and the results are displayed as an overlay on the source code. It supports a "black box only" recording option that is faster but less detailed.

The philosophical point: separating "running" and "debugging" is an artificial distinction. If recording is cheap enough, every execution can be a debugging session. The UI should show behavior *alongside* the code, not in a separate pane.

Source: https://whitebox.systems/

### 4.2. Bret Victor — Timeline Scrubber

Bret Victor's "Inventing on Principle" talk (2012) proposed that execution isn't something you "step through" — it is a **timeline you scrub with a slider**. Every line of code has its execution history visualized alongside it. You drag a slider and see how values change over time.

This requires recording all state, but for a simple interpreter it is tractable. The visualization shows not just "what is the current value" but "how did this value evolve over the lifetime of the program."

The deeper claim: the step-by-step debugging model is a legacy of hardware limitations. With sufficient recording, the entire execution history is available simultaneously. The UI should present time as a spatial dimension, not a sequential process. No general-purpose programming environment has fully delivered the entire vision in production, but domain-specific and notebook-style systems have shipped important slices of it (§4.3).

Source: https://vimeo.com/36579366

### 4.3. Light Table, Eve, Observable — Shipped Live-Coding Environments

Where Bret Victor's "Inventing on Principle" (§4.2) was a vision, Light Table (Chris Granger, 2012) was an attempt to ship it. Every expression evaluates inline as you type; **watches** are a "next-gen println" where an expression annotated with a watch streams its value back to the editor in real time during normal execution, across Clojure, JS, and Python. Light Table integrated with Chrome DevTools Protocol (§5.4) for live JS edits to running pages and with IPython for inline matplotlib.

Eve, the successor project, confirmed a lesson from Light Table: **imperative languages fight live evaluation**. Eve abandoned imperative code for set-oriented rules with no evaluation order, exposing the fact that the Light Table vision required *language co-design* (similar to Hazel §6.2 and Elm §3.3). Light Table's own work to get live eval to behave reliably in JS and Python required "numerous caveats and strange edge cases."

Observable (Mike Bostock et al.) is the shipped form of the idea in production today. Each cell in an Observable notebook is a JavaScript expression with statically analyzed free variables; the runtime builds a **reactive dataflow DAG** and re-runs each cell whenever its inputs change. Cells may return promises or generators — the runtime composes dependencies across async boundaries and animation frames. The **Minimap** visualizes the DAG as a sidebar of cells with inbound/outbound blue wires, making the notebook's dataflow itself a debuggable artifact: click a cell to see what it depends on and what depends on it.

The lesson is the same as Elm's: **if the language (or notebook model) makes dependencies static, the debugger can read them without re-execution**. Observable's explicit limitation — the Minimap cannot see side-effect-driven dependencies — underscores the point: the moment you escape the reactive model, the static view goes blind.

The prior art is older than any of these. Excel has shipped **Trace Precedents / Trace Dependents** for decades: click a cell, press `Ctrl+[` or the Formula Auditing ribbon button, and blue arrows trace every cell feeding the formula; `Ctrl+]` traces downstream dependents; red arrows mark error propagation; black arrows with worksheet icons mark cross-sheet references. The **Watch Window** is a live cross-workbook variable watch — add any cell and observe its value update as upstream inputs change. Third-party tools (TraceModel) externalize the full dependency graph as an interactive node view. Excel's dataflow debugger predates Observable's Minimap by decades, and the design lesson is the same: a reactive-language debugger needs to expose the dependency DAG as first-class UI.

Sources: http://lighttable.com/ and https://witheve.com/deepdives/lighttable.html and https://observablehq.com/documentation/debugging/minimap and https://support.microsoft.com/en-us/office/display-the-relationships-between-formulas-and-cells-a59bef2b-3701-46bf-8ff1-d3518771d507

### 4.4. Unreal Gameplay Debugger — In-Engine Replicated Overlays

Game engines debug differently from application code because the "program" is a real-time simulation where pausing destroys the feedback loop. Unreal's Gameplay Debugger Tool (GDT) is a **runtime overlay on the game viewport** activated with a single key (apostrophe by default, or the `EnableGDT` cheat). While the game runs, pressing a numpad key toggles a data category — Abilities, Behavior Tree, NavMesh, Perception, NavGrid — which draws its state as text and shapes *on top of the game world*, against a specific actor selected by pointing the camera at it.

The original contribution is that **GDT data flows through Unreal's network replication layer**. The same replication that keeps client and server worlds in sync carries debug payloads. The consequence is that GDT displays **both server and local client values side-by-side** when you point at an actor — and any divergence reveals client-side prediction drift or ability-activation desync as visible text, not hidden bugs. This is an in-engine race detector for distributed simulation state, built out of machinery the engine already has.

Custom categories are C++ classes: `UGameplayDebuggingComponent` collects data (replicated), `AGameplayDebuggingHUDComponent` draws it. The sibling tool is the **Visual Logger**: per-tick actor snapshots saved into a timeline that can be scrubbed inside the editor, with per-category log channels — a post-hoc replay purpose-built for "why did the AI do that 30 seconds ago?" and usable in recorded PIE sessions as well as live runs.

The design pattern generalizes: shipping the debugger *inside the product*, gated by a cheat flag rather than a separate debug build, means debugging happens *in the environment where bugs actually occur* — live multiplayer, cooked builds, on-device. WhiteBox (§4.1) and retroactive console.log (§6.1) share the philosophy; GDT applies it to a latency-sensitive distributed simulation.

Source: https://dev.epicgames.com/documentation/en-us/unreal-engine/using-the-gameplay-debugger-in-unreal-engine

### 4.5. GPU Frame Debuggers — RenderDoc, NVIDIA NSight, Microsoft PIX

GPU execution is massively parallel, asynchronous, and unpausable — thousands of shader invocations fire per draw call, each with its own register state. Live, global step-through debugging of GPU execution is usually meaningless; frame debuggers instead capture the frame and allow offline inspection, including step-through replay of selected shader invocations. RenderDoc (open source, Baldur Karlsson), NVIDIA NSight Graphics, and Microsoft PIX converge on this model: **capture an entire frame offline and inspect it as a queryable object.**

A capture contains every API call issued during the frame — draws, dispatches, state-setting calls, resource updates — plus all bound textures, buffers, render targets, and shader blobs, plus the framebuffer at each boundary. The **Event Browser** is the primary navigation UI: a hierarchical tree of API events by EID (Event ID), with user-annotated sections collapsed into tree nodes. The **Pipeline State** panel inspects the entire graphics pipeline at the selected event — which shaders are bound, which textures, which vertex buffers, which rasterizer state — with drill-downs to the raw contents of every resource.

The original contribution is **pixel history**: click any pixel on the final framebuffer and get a list of every modification to that pixel across the frame. Which draw call wrote it, pre- and post-depth-test results, which fragment passed overdraw, what color was blended in. From the pixel history, launch the **shader debugger** on any contributing fragment and step through HLSL source-level with local variables and callstack (not just disassembly). This is pure observational debugging of an unobservable execution model — the GPU is never paused, but its effects are fully reconstructible.

Shader debug information is handled by stripping the debug blob at compile time (shader code bloats otherwise) and correlating by hash at capture load time. RenderDoc reverse-engineered PIX's undocumented debug-info search algorithm to stay compatible with the ecosystem of shader-compiler toolchains, under "principle of least surprise."

The design lesson is **temporal separation**: record cheaply, inspect expensively, offline. Pernosco (§2.2) applies the same principle to CPU execution. For any execution model whose *live* observation is prohibitive — GPU shaders, massively parallel kernels, production regressions — capture-and-inspect beats attach-and-step.

Sources: https://renderdoc.org/docs/how/how_debug_shader.html and https://docs.nvidia.com/nsight-graphics/UserGuide/shader-debugger-setup.html

### 4.6. XState Inspector — Live State-Machine Debugger

XState state machines are both a JavaScript/TypeScript library and a visual formalism (Harel statecharts). The Stately Inspector (`@statelyai/inspect`) debugs them in their natural notation: **the chart itself, animated with the current state highlighted.**

The mechanism is an **inspection event stream**. A running actor system emits events — `@xstate.actor` on creation, `@xstate.event` on sent events, `@xstate.snapshot` on state changes, `@xstate.microstep` on internal transitions, `@xstate.action` on action execution — over a WebSocket to an inspector. `createBrowserInspector()` opens a browser window; `createInspectorServer` relays events from a headless Node.js process to a browser UI. The inspector ingests the stream and renders three views simultaneously: the chart with the current node highlighted, a chronological event log, and **auto-generated sequence diagrams** for actor-to-actor communication derived from the event pairs.

The inspection API is **language-neutral at the protocol level**. Any runtime that emits the five event types can drive the inspector without depending on XState — the Stately docs show a non-XState Node.js harness calling `inspector.actor()` / `inspector.event()` / `inspector.snapshot()` directly. This is the state-machine analogue to DAP (§5.2) or CDP (§5.4): a thin inspection protocol decoupled from the UI.

The design lesson is **the notation is the debugger UI**. When the language's primary artifact is already a diagram (state chart, dataflow graph, proof tree), the debugger should render the diagram, not a textual stack. This extends the Whyline's philosophy (§8.9) — debug in the user's mental model, not the machine's — from interrogation to visualization.

Sources: https://stately.ai/docs/inspector and https://github.com/statelyai/inspect

---

## 5. Debugger-as-Service — Transport Protocols

Decoupling the debugger UI from the debugger runtime has become the dominant architecture — an N×M integration problem solved by standard protocols. Entries differ on **what the protocol commits to**: DAP is language-neutral and lowest-common-denominator; JDWP is transport-neutral but Java-typed; CDP is WebSocket-rich and Blink/V8-coupled; RemedyBG is shared-memory and proprietary; gdbserver vs. lldb-server differ on where authoritative environment knowledge lives; scripting APIs (GDB Python, LLDB formatters) turn the debugger itself into a programmable platform; and expression evaluation/state surgery is the in-debugger evaluator that all of these protocols expose. The Mirror principle (§5.7) names the design shape the others approximate with varying fidelity.

### 5.1. RemedyBG — Debugger as Service with Protocol

RemedyBG is a Windows-only native debugger built by a solo developer, optimized for speed and simplicity. Its interesting contribution is the debug protocol: an external process communicates with RemedyBG via shared memory and events, allowing editors and tools to control the debugger programmatically.

This is philosophically aligned with DAP (Debug Adapter Protocol) but more lightweight and lower-latency. The shared-memory approach avoids the JSON serialization overhead of DAP for high-frequency operations like variable inspection.

Source: https://remedybg.handmade.network/blog/p/3631-remedybgs_debug_protocol

### 5.2. Debug Adapter Protocol — The LSP of Debugging

The Debug Adapter Protocol (Microsoft, 2016) does for debuggers what LSP did for language servers: it decouples the IDE from the debugger runtime via a standardized JSON message protocol with LSP-like framing. Before DAP, every IDE had to implement custom integrations with every debugger (Eclipse + JDI for Java, Visual Studio + COM for C++, etc.) — an N×M problem.

DAP defines a standard set of requests (launch, attach, setBreakpoints, continue, stepIn, stackTrace, variables, evaluate) and events (stopped, output, terminated) that any IDE can send to any debug adapter. The debug adapter translates these into the native debugger's API (GDB/MI, LLDB, JDI, Chrome DevTools Protocol, etc.).

Key design decisions:
- **Stateful session model**: unlike LSP (which is largely stateless), DAP maintains a debugging session with lifecycle (initialize → launch/attach → running → stopped → terminated).
- **Thread and stack frame model**: DAP abstracts threads, stack frames, scopes, and variables into a uniform hierarchy, regardless of the underlying runtime's representation.
- **Evaluation**: the `evaluate` request allows arbitrary expression evaluation in the debugger's context, supporting watch expressions, conditional breakpoints, and REPL-style interaction.

DAP is now supported by VS Code, Neovim, Emacs (dap-mode), Helix, Zed, and many other editors. Debug adapters exist for GDB, LLDB, Chrome/Node, Python (debugpy), Go (Delve), Rust (via CodeLLDB/LLDB), Java (JDI), and dozens more.

The limitation: DAP's abstraction is lowest-common-denominator. Advanced debugger features (rr's reverse execution, Pernosco's omniscient queries, RemedyBG's shared-memory speed) are hard to express in DAP's generic request/response model. Enet et al. (2023) studied DAP's suitability for domain-specific languages and found similar friction — DSL-specific debugging concepts (model-level stepping, constraint visualization) require protocol extensions.

Sources: https://microsoft.github.io/debug-adapter-protocol/ and https://hal.science/hal-04245594v1/document

### 5.3. Debugger Scripting APIs — GDB Python, LLDB Formatters, pwndbg, gdb-dashboard

Both GDB and LLDB expose Python APIs that let users extend the debugger without recompiling it. The contribution is that **the debugger becomes a programmable platform**, not a fixed UI — the same mechanism that powers a one-off `std::vector` pretty-printer also hosts reverse-engineering plugins, CTF workflows, and entire alternative front-ends.

GDB's Python API centers on `gdb.Value`, `gdb.Type`, and the `pretty_printer` protocol: a printer class implements `to_string()` for a scalar rendering and `children()` (with a `display_hint` of `'array'` / `'map'` / `'string'`) for a container. Frame filters reshape the backtrace display; xmethods intercept C++ member calls; inferior callbacks fire on thread events. The API is sufficient to ship whole new UIs as `.gdbinit` files.

LLDB's API is richer and layers the problem into four pieces — **formats, summaries, filters, and synthetic children**. A *summary* is the one-line description (`type summary add --summary-string "(${var.x}, ${var.y})" MyVec3`) or a Python callback returning a string. A *filter* hides or reorders fields without any code. **Synthetic children** are virtual members that replace the debug-info-derived layout: `std::vector<T>` appears as `[0], [1], [2]` instead of three opaque pointers (`begin`, `end`, `capacity`). LLDB invokes the synthetic child provider *before* the summary, so summaries see the clean view. The subtle detail is `SetPreferSyntheticValue(True)`: without it, recursive inspection falls back to the real private members, defeating the abstraction.

The scripting surface is large enough to host **alternative front-ends** inside GDB/LLDB themselves. `gdb-dashboard` is a pure-Python `.gdbinit` that adds modular panels (source, registers, stack, threads, backtrace) refreshed on every stop; the user selects layouts with `dashboard -layout`. **pwndbg** is a GDB *and* LLDB plug-in focused on reverse engineering and exploit development — hex dumps, GOT/PLT inspection, `vmmap`, ROP-gadget search, qemu-user/qemu-system integration — loaded as a Python module with no debugger patches. GEF is an older sibling in the same niche.

The lesson for a language designer: a debugger scripting API turns "the UI we shipped" into "the UI you want." The cost is a Python embedding and a stable object model for values, types, frames, and events.

Sources: https://lldb.llvm.org/varformats.html and https://github.com/cyrus-and/gdb-dashboard and https://github.com/pwndbg/pwndbg

### 5.4. Chrome DevTools Protocol — Domain-Structured Wire Protocol

Chrome DevTools Protocol (CDP) is the WebSocket wire protocol that connects Chrome/Chromium/Node.js to its inspector clients. It predates DAP (§5.2) and takes an opposite architectural stance: **rich, runtime-specific, domain-structured** instead of generic and lowest-common-denominator.

CDP defines dozens of **domains** — DOM, Debugger, Network, Profiler, Runtime, Page, Performance, HeapProfiler, Tracing, Emulation, Input — each with its own commands and events. The canonical schema lives in two `.pdl` files in the Chromium tree: `browser_protocol.pdl` (browser-level domains) and `js_protocol.pdl` (V8-only domains, also usable for Node.js debugging). The `.pdl` is translated into typed C++, TypeScript, and JSON bindings, so every CDP consumer gets compile-time checking against the authoritative definition.

The architectural difference from DAP: CDP is a *persistent session* over a single WebSocket where agents in several processes (browser, renderer, Blink, V8) handle different subsets of commands. A single command may fall through *embedder → content → blink → V8*. This lets CDP expose deep browser internals (network waterfalls, heap snapshots, DOM mutation events, JS-level coverage, CPU profiler) that would not map onto a DAP request. The Puppeteer and Playwright automation libraries consume CDP directly. Chrome extensions access it through `chrome.debugger`.

The trade-off is sharp: CDP is powerful but tightly coupled to Blink/V8 semantics; DAP is weaker but portable. VS Code's own `vscode-js-debug` is a DAP adapter that **translates CDP to DAP** to bridge the two worlds — losing some CDP features along the way (e.g., fine-grained heap snapshots) because DAP cannot express them.

Sources: https://chromedevtools.github.io/devtools-protocol/ and https://chromium.googlesource.com/devtools/devtools-frontend/+/main/docs/devtools-protocol.md

### 5.5. JDWP + JPDA — Transport-Agnostic Language-Typed Protocol

Sun's Java Platform Debugger Architecture (JPDA) predates DAP by two decades and already separated the concerns DAP standardized much later. It splits debugging into three layers: **JVMTI** (the in-VM tool interface, used by the debuggee's agent), **JDWP** (the wire protocol between agent and front-end), and **JDI** (the high-level Java API used by debuggers to talk to JDWP).

JDWP's original contribution is **transport abstraction**. The specification defines packet format only (command packet, reply packet, command set + command number, length-prefixed payload) and explicitly does not define the transport. Reference implementations ship both a TCP socket transport and a shared-memory transport, and a Service Provider Interface lets third parties add their own. The same debugger binary speaks to a VM across a TCP network, across shared memory on the same host, or over a serial line with no code changes.

Unlike DAP, JDWP is **stateful and type-aware**: command sets mirror JDI interfaces — VirtualMachine, ReferenceType, ClassType, ArrayType, ObjectReference, StringReference, ThreadReference — and their commands expose language-level operations the protocol can enforce. `RedefineClasses` hot-patches a class definition at runtime; `InvokeMethod` calls an arbitrary Java method in the debuggee and returns the result; `ForceEarlyReturn` makes a frame return *now* with a specified value; `PopFrames` unwinds frames and re-executes. DAP's `evaluate` string-in-string-out is the closest analogue and is strictly weaker.

The lesson for protocol design: **a debugger protocol tied to one language can expose operations a language-neutral protocol cannot**. DAP trades this away for multi-language reach; JDWP gets live class redefinition and typed frame manipulation as first-class protocol operations in exchange for being Java-only. A new language runtime can borrow JPDA's three-layer split (in-VM tool interface, wire protocol, client-side language API) without inheriting its Java-specific commands.

Sources: https://docs.oracle.com/en/java/javase/24/docs/specs/jdwp/jdwp-spec.html and https://docs.oracle.com/en/java/javase/21/docs/specs/jpda/architecture.html

### 5.6. Remote Debugging — gdbserver vs lldb-server + SBPlatform

Remote debugging — debugger on the dev workstation, debuggee on a phone, embedded board, or prod machine — needs a wire protocol, a stub running on the target, and a decision about *where the source of truth lives*. GDB and LLDB picked opposite answers, and the split is instructive.

GDB's `gdbserver` is intentionally minimal: register read/write, memory read/write, single-step, continue, breakpoint insert. All symbol parsing, DWARF interpretation, and platform-specific logic lives on the **client** side; the client holds the authoritative view, the server handles physics only. The upside is that `gdbserver` can be tiny — useful on a Cortex-M microcontroller. The downside is that cross-target debugging requires configuring sysroot, libraries, and symbol paths correctly on the client, a perennial footgun.

LLDB's `lldb-server` combines two roles in one statically linked binary: a **gdb-remote stub** (same wire protocol as gdbserver, with LLDB-specific extensions documented in `lldb-gdb-remote.txt`) and a **platform server**. The platform server is controlled from the client via an `SBPlatform` abstraction that exposes *remote* file system access, remote process listing, and remote shell execution. The remote becomes the source of truth about its own environment: LLDB asks the remote platform to find sysroot, list loaded modules, and copy symbol files across. Apple's `debugserver` fills the same role on macOS/iOS.

Both use the GDB Remote Serial Protocol at the wire level — `g`/`G` (registers), `m`/`M` (memory), `vCont` (execution control), `Z`/`z` (breakpoints) — over TCP, Unix sockets, serial lines, or pipes (useful for wrapping SSH). The protocol is shared; the division of labor is what differs.

The design question a language runtime inherits: **do we ship a thin stub and keep knowledge at the client, or a thick agent and let the target describe itself?** Thin is easier to port; thick is easier to operate cross-target. There is no universal right answer, but the LLDB model wears better when targets diverge from the host.

Sources: https://lldb.llvm.org/use/remote.html and https://www.sourceware.org/gdb/onlinedocs/gdb/Connecting.html

### 5.7. Mirrors — Reflection as Debugger Primitive

Most mainstream reflection APIs — Java `Class.getMethods()`, Python `inspect`, C# `System.Reflection` — make the meta-level an ambient capability of every object. Gilad Bracha and David Ungar's "Mirrors: Design Principles for Meta-level Facilities of Object-Oriented Programming Languages" (OOPSLA 2004) articulates three principles such APIs violate and that **mirror-based reflection** upholds:

1. **Encapsulation**: meta-level facilities must encapsulate their implementation. A program object should not automatically expose a reflection surface.
2. **Stratification**: meta-level facilities must be separated from base-level functionality. You should not be able to reach the reflection machinery from an ordinary call site.
3. **Ontological correspondence**: the ontology of the meta-level should mirror the language's own ontology. A class mirror exposes what classes *are*; a method mirror exposes what methods *are*. No leakage of implementation detail.

The implementation: reflective capability is isolated into **mirror objects** that must be obtained explicitly, not through ambient `.getClass()`. Without a mirror in hand, a program has *no* reflective power. Newspeak (Bracha's language) has no static state and no globals; the top-level object receives a `platform` parameter as its sole connection to the outside world, and `platform` is the only way to obtain mirrors — a capability-security design.

The consequence for debuggers is direct. A debugger is structurally a program holding mirrors on a target program. Mirror principles make this compose cleanly:
- **Remote debugging** becomes natural: a mirror in the debugger process can stand for an object in the target process, because the mirror *is* the interface. JDWP/JDI (§5.5) already has this shape; the Bracha paper names why it's right.
- **Sandboxing**: untrusted base-level code that cannot obtain mirrors cannot introspect itself — a capability-security property, not a runtime check.
- **Language-neutral protocols**: mirror interfaces generalize across implementations because the base language's ontology is what's mirrored, not the implementation's object layout.

The language-design lesson: **design reflection as the debugger's primitive**, not as a convenience bolt-on. If mirrors are the only way to reach the meta-level, remote debugging, secure sandboxes, and cross-implementation debug protocols fall out of the same mechanism.

Sources: https://bracha.org/mirrors.pdf and https://bracha.org/newspeak.pdf

### 5.8. MoarVM Remote Debug Protocol — Comma's Durable Artifact

Status (as of 2026-04): the **Comma IDE** is discontinued, but it drove substantial improvements to MoarVM's debug surface that survive Comma itself: a **TCP-based remote debug protocol** for Raku/MoarVM, plus an open-source Raku client library and CLI driver. The protocol shape mirrors the JDWP / DAP / CDP family (§§5.2, 5.4, 5.5) — connect to a port the running MoarVM listens on, exchange typed commands, receive event notifications. Distinctive features: stack-frame introspection that understands Raku's role in a multi-stage compilation pipeline (RakuAST nodes → QAST → MoarVM bytecode all addressable), and integration with MoarVM's spesh and inliner metadata so that debugging *specialized* code reconstructs the original frame layout (see `COMPILERS.md §14.4` on uninlining).

The product itself shut down, but the durable artifact — a documented language-specific debug protocol contributed back to a small-team VM — is a useful pattern for new languages: even a single commercial tooling vendor can leave behind a debug protocol that outlives them, *if* the protocol is upstreamed into the runtime rather than kept inside the IDE binary. The lesson is symmetric to `TRACERS.md §3.11` (MoarVM Telemetry / heap snapshots): both originated as Comma-driven additions that became MoarVM mainline.

Sources: https://commaide.com/features and https://commaide.com/faq

### 5.9. Debugger Expression Evaluation and State Surgery

A debugger is not only an observer. Users expect to evaluate expressions in the current frame, call functions, assign variables, force returns, restart frames, and inspect values using language semantics. This requires a miniature evaluator whose environment is the paused program: current lexical scope, stack frame, registers, heap, generic instantiations, dynamic dispatch rules, and optimized-code location mappings.

GDB has `print`, `call`, `set variable`, and `return`. LLDB embeds Clang to evaluate C/C++/Objective-C expressions. Chrome DevTools evaluates JavaScript in paused stack frames. JDWP exposes operations such as object invocation and `ForceEarlyReturn` (see §5.5). Smalltalk/Pharo and Common Lisp go further: the debugger is an interactive development environment where live frames can be inspected, edited, restarted, or resumed through restarts.

The hard part is safety. Calling arbitrary code from a paused thread can deadlock, allocate, throw, mutate state, or observe inconsistent invariants. A language can define a **debug expression subset**: pure field access, formatting, total helper functions, controlled mutation, or explicitly unsafe target calls.

The language-design lesson: **design the debugger evaluator as part of the language semantics, not as an afterthought**. If the compiler can emit enough metadata for lexical scopes, generic types, closures, effects, async frames, and optimized-out values, the debugger can evaluate expressions that feel like the source language instead of raw memory pokes.

Sources: https://sourceware.org/gdb/current/onlinedocs/gdb.html/Expressions.html and https://lldb.llvm.org/use/tutorial.html

---

## 6. Retroactive and Partial Evaluation

The debugger does not have to exist at a separate moment from the program. Entries in this chapter collapse debugging *into* the edit/run cycle: Replay.io adds print statements retroactively *after* the bug occurred; Hazel evaluates programs with typed holes so every keystroke produces feedback; `dbg!` / `dbg/2` / icecream turn print debugging into a compiler-macro feature with zero attach-step. The axis is **when the diagnostic is introduced** — before execution, during editing, or after recording.

### 6.1. Replay.io — Retroactive Console.log

Replay.io is a time-travel debugger for web applications that records a browser session deterministically. The unique feature: after recording, you can **add console.log statements retroactively**. Click on a line of code, type an expression, press enter — and the logged values appear in the console as if the log statement had always been there.

The implementation: Replay maintains a pool of forked browser processes at various points in the recording. When you add a retroactive print statement, Replay finds the nearest process fork, replays forward to each point where the line executes, evaluates the expression, and returns the results. Because the work is done in parallel across multiple forks, and no fork is more than ~100ms away from a checkpoint, results appear in "low logarithmic time."

This is philosophically significant: it eliminates the "I should have added a log here" regret that plagues traditional debugging. The recording captures everything; print statements become a *query language* for the recording rather than instrumentation that must exist before the bug occurs.

Sources: https://docs.replay.io/time-travel-intro/add-console-logs-on-the-fly and https://docs.replay.io/basics/time-travel/how-does-time-travel-work

### 6.2. Hazel — Live Evaluation of Incomplete Programs

Hazel is a live functional programming environment where programs with **typed holes** — missing subexpressions — can still be typechecked and partially evaluated. The editor inserts holes automatically to guarantee that every editor state is meaningful. There are no "syntax error" states where all feedback stops.

When a program has holes, Hazel evaluates as far as it can, producing partial results. A function with a hole in one branch can still be evaluated on inputs that take the other branch. A list operation with a hole in its transform function can still report the list's length. The result is continuous, live feedback even while the program is being written.

This inverts the traditional model where feedback requires a complete, parseable, compilable program. In Hazel, *every keystroke* produces feedback because *every editor state* has both static (type) and dynamic (evaluation) meaning.

The connection to debugging: Hazel dissolves the distinction between "writing" and "debugging." You see the program's behavior as you construct it, not after. Bugs are visible the moment they are introduced, because you can see values flowing through incomplete code in real time.

> The *parser-side* perspective on Hazel — typed holes as an error-recovery strategy — is covered in `PARSERS.md §4.4`.

Sources: https://hazel.org/ and https://arxiv.org/abs/1805.00155

### 6.3. Structured Print Debugging — Rust `dbg!`, Elixir `dbg/2`, icecream

Print debugging is universal and universally apologetic. Rust's `dbg!()` macro (stabilized 2019), Elixir's `dbg/2` (2022), and Python's `icecream` (plus its 15+ community ports) turn it into a language-level feature worth using *in preference to* a traditional debugger for a large class of bugs.

The design pattern is shared across all three implementations:
1. **Expression-returning**: `dbg!(x + 1)` returns its argument, so it is insertable into any expression position without restructuring code — `let y = dbg!(f(x)) + 1;` works.
2. **Automatic source capture**: prints the expression *as written*, the file and line, and optionally the enclosing function — Rust via macro syntactic capture, icecream via Python's `executing` AST-locator library that reliably locates `ic()` calls in source.
3. **Pretty output**: uses the language's debug formatter (`Debug` trait, `Kernel.inspect/2`, `pprint`) rather than string coercion.

**Elixir's `dbg/2` goes furthest**: inside a pipeline, `x |> f() |> g() |> dbg()` prints the intermediate value *at every pipeline stage*, showing the full data evolution from a single annotation. Even better, when run under `iex`, `dbg` transparently upgrades to an interactive **pry session** — the program pauses at the call site, the user inspects locals and steps, `continue` resumes. Print-debug escalates to interactive-debug with no code change.

The original contribution is *meta*: the debugger is the compiler macro itself. There is no attach step, no breakpoint lookup, no DWARF, no protocol. The cost is zero when the line is removed, and full-source-context when the line is present. This generalizes Chris Wellons's INT3;NOP pattern (§1.2) — compile the debugging directly into the code — but at language level rather than assembly level, and with the language's own formatter doing the work.

For a new language, the implementation cost is small: a macro that captures `stringify!(expr)` and `file!()/line!()` alongside the evaluated value. The ergonomic payoff is large enough that the 15-port community ecosystem formed around Python's `ic()` within a few years.

Sources: https://doc.rust-lang.org/std/macro.dbg.html and https://www.germanvelasco.com/blog/using-dbg-to-replace-io-inspect-and-pry-into-code and https://github.com/gruns/icecream

---

## 7. DWARF Debug Information and Optimized-Code Challenges

The *encoding* side of DWARF — how line tables are packed into binaries — is covered in `COMPILERS.md §5`. This section covers the debugger-side correctness problem: tracking variables and source positions *through* optimization so the debugger can display meaningful state.

### 7.1. DWARF Location Expressions — Tracking Variables Through Optimization

DWARF debug information describes where variables live at each point in execution using "location descriptions" — stack machine programs that compute a variable's address or value. A simple local variable might be described as "register R12" or "frame pointer + 16." But after optimization, variables are split, merged, partially spilled, or eliminated entirely.

DWARF handles this with location lists: a variable's location can change at different program counter ranges. At PC 0x100–0x120, the variable is in R12. At PC 0x120–0x140, it has been spilled to [RBP-24]. At PC 0x140–0x160, it has been optimized away entirely ("value unavailable"). The debugger consults the location list for the current PC to determine where to find each variable.

The correctness problem is severe. Li et al. (PLDI 2020) presented the first systematic framework for validating debug information in optimized code, finding that both GCC and LLVM produce incorrect DWARF information that causes debuggers to display wrong variable values. Assaiante et al. (2022) studied completeness — variables whose locations should be reportable but aren't — finding that 6–22% of variable locations are unnecessarily missing across GCC and Clang.

The practical consequence: debugging optimized code is unreliable. Variables show as "optimized out" even when their value is recoverable, and worse, sometimes show incorrect values. This is why developers often resort to `-O0` for debugging, sacrificing the 2–5x performance of optimized code. A language that generates correct, complete debug information — or provides its own debugging mechanism that bypasses DWARF — sidesteps this entire class of problems.

Sources: https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf and https://faculty.cc.gatech.edu/~qzhang414/papers/pldi20_yuanbo1.pdf and https://export.arxiv.org/pdf/2211.09568v1.pdf

### 7.2. Debug Information Across Tiers — The Mapping Problem

When a program passes through multiple compilation stages (source → AST → IR → optimized IR → machine code), each transformation must carry debug information forward. Every instruction in the final machine code should map back to a source location, and every live variable should be locatable.

The mapping problem compounds across tiers:
- **Inlining** duplicates source locations — the same source line appears at multiple machine code addresses.
- **Loop unrolling** multiplies instructions — one source loop body becomes N copies.
- **Dead code elimination** removes instructions — some source lines have no corresponding machine code.
- **Register allocation** moves values — a variable's storage changes at spill/reload boundaries.

For JIT-compiled languages, the problem is worse: the JIT must emit debug information on the fly, and deoptimization must reconstruct source-level state from optimized representations. V8's TurboFan and HotSpot's C2 both maintain "frame state" metadata that describes how to reconstruct the interpreter's stack frame from the optimized code's register allocation — enabling deoptimization at any safepoint (see `COMPILERS.md §14.2` on OSR).

The lesson: debug information is not optional metadata bolted on at the end. It is a cross-cutting concern that every compilation pass must maintain. Designing the IR with debug info propagation in mind (as LLVM does with `!dbg` metadata on every instruction) is essential.

### 7.3. Bytecode-to-Native Source Map — Apache Harmony / HotSpot

JVMs maintain metadata that maps between bytecode offsets, source positions, and relevant native-code addresses. For debuggable or deoptimizable code, the JIT records enough information to map selected native PCs back to bytecode/source locations, handle safepoints, and reconstruct inlined frames. This allows a breakpoint requested at a bytecode offset to be implemented in native code where possible, and allows a native fault or sampled PC to be explained via native address → bytecode offset → line number table. The mapping is implementation-dependent and becomes approximate or many-to-many under optimization and inlining.

Source maps are the critical bridge between the user's mental model (source lines) and the machine's reality (instruction pointers or bytecode offsets). Without bidirectional mapping, debugging is impossible. Every debuggable system has this mapping in some form.

Source: https://harmony.apache.org/subcomponents/drlvm/breakpoints_and_ss.html

### 7.4. debuginfod — Build-ID-Keyed HTTP Symbol Distribution

A recurring production problem: stripped binaries save 10× disk and RAM, but strip their own debug info with them. Traditional answers — ship a debug build alongside, maintain a symbol server per tool — are clumsy. `debuginfod` (elfutils, 2019+) is the HTTP-native modern answer and is now integrated into GDB, LLDB, Valgrind, and delve.

The primitive is the **build-ID**: a 160-bit SHA-1 embedded in the ELF header at link time via `ld --build-id`. The build-ID uniquely identifies a specific compiled artifact — rebuild with any change and it changes. `debuginfod` is an HTTP service keyed on build-ID: `GET /buildid/<hex>/debuginfo`, `GET /buildid/<hex>/executable`, `GET /buildid/<hex>/source/<path>` return the matching `.debug` file, the full binary, and source listings on demand.

When GDB attaches to a stripped binary, it reads the build-ID from the ELF, sends it to the servers listed in `DEBUGINFOD_URLS`, and caches the response under `$XDG_CACHE_HOME/.debuginfod_client/`. Distribution servers — `debuginfod.archlinux.org`, `debuginfod.ubuntu.com`, Fedora's, and `debuginfod.elfutils.org` (a federated front-end that fans out to multiple upstreams) — index every package's `.debug` files and source trees and serve them globally. Ubuntu, Arch, and Fedora auto-enable the client via shell profile.

The implication for language design: **debug info becomes a separate concern from the binary and can be retrieved on demand by the debugger**. A language emitting standard DWARF with build-IDs gets the entire debuginfod ecosystem for free. Delve (Go debugger) supports it; Valgrind and KDE Crash Report do too. Sanitizer symbolization is more constrained because crash-time reporting may run in-process or in a tightly controlled helper, but modern sanitizer flows commonly delegate to external symbolizers such as `llvm-symbolizer`; debuginfod can participate when the symbolizer and distribution are built/configured for it.

The broader pattern is content-addressed symbol distribution: Microsoft's symsrv + SymbolSource has offered a similar service for PDB files for decades, keyed on the PDB signature/GUID plus age. debuginfod's contribution is making this ecosystem *default-on* for open-source stripped Linux binaries.

Sources: https://sourceware.org/elfutils/Debuginfod.html and https://sourceware.org/gdb/onlinedocs/gdb/Debuginfod.html

---

## 8. Automated Fault Isolation

Automated fault isolation treats debugging as search: given a failure and a test oracle, a program analysis narrows the cause. Entries differ on **what the search ranges over** — inputs (delta debugging, fuzzer triage), commit histories (`git bisect`), statements (program slicing), lines (Tarantula), predicates (CBI), program states (cause-effect chains), execution paths (KLEE), MIR operations (Miri), trace events indexed by question (Whyline), computation-tree nodes (Shapiro), or aggregated value-histories (Daikon's dynamic invariants). The debugger becomes an automated search engine with a domain-specific query.

### 8.1. Delta Debugging — Minimizing Failure-Inducing Input

Andreas Zeller's delta debugging algorithm (1999) answers the question: "what is the minimal input that still triggers this bug?" Given a failing input, it systematically removes chunks — first large halves, then progressively smaller pieces — testing after each removal whether the failure persists. The result is a 1-minimal failing input: removing any single element causes the failure to disappear.

The algorithm extends beyond inputs. Applied to code changes, it answers "which of these 1000 commits introduced the bug?" by binary-searching the change history (this is the principle behind `git bisect`). Applied to program state, it can isolate the minimal state difference between a passing and failing execution.

The technique is fully automated — it requires only a test oracle (pass/fail) and a way to produce subsets of the input. No understanding of the program is needed. It is the canonical example of debugging-as-search: the bug is somewhere in a large space, and delta debugging narrows the space systematically.

The practical limitation: each test requires a full program execution. For programs that take seconds or minutes to run, minimizing a large input can take hours. But for programs that run in milliseconds (unit tests, parsers, compilers), delta debugging is transformative.

Sources: https://www.debuggingbook.org/html/DeltaDebugger.html and https://www.cs.purdue.edu/homes/xyzhang/fall07/Papers/delta-debugging.pdf

### 8.2. Program Slicing — "What Affects This Variable?"

Mark Weiser introduced program slicing in 1981: given a variable at a program point, compute the subset of the program that could affect that variable's value. This "slice" is itself a valid program — it computes the same value for the variable of interest while discarding everything irrelevant.

**Static slicing** considers all possible executions: the slice includes every statement that *could* affect the variable on *any* input. Static slices tend to be large (often 30–50% of the program) but require no execution.

**Dynamic slicing** considers a specific execution: the slice includes only statements that *actually* affected the variable on *this* input. Dynamic slices are much smaller and more useful for debugging, but require running the program with the failing input.

The practical application: when a variable has a wrong value, the dynamic backward slice tells you exactly which statements contributed to that value. This is a mechanical version of what programmers do mentally — "where did this value come from?" — but computed automatically.

Dynamic slicing is closely related to Pernosco's reverse dataflow tracking. The difference is granularity: program slicing operates on source statements, while Pernosco operates on individual memory writes and register transfers.

Sources: https://en.wikipedia.org/wiki/Program_slicing and http://www0.cs.ucl.ac.uk/staff/mharman/sf.html

### 8.3. Tarantula — Fault Localization via Test Coverage Coloring

Tarantula (Jones, Harrold, Stasko, 2002) is a spectrum-based fault localization technique. Given a test suite with some passing and some failing tests, it computes a "suspiciousness" score for each source line:

```
suspiciousness(s) = (fail(s) / total_fail) / (fail(s) / total_fail + pass(s) / total_pass)
```

Lines executed mostly by failing tests get high suspiciousness (close to 1.0). Lines executed mostly by passing tests get low suspiciousness (close to 0.0). Lines executed equally by both get 0.5.

The visualization colors each source line on a red-to-green gradient: red = highly suspicious (likely buggy), green = likely correct. The programmer reads the color-coded source and focuses on the red lines.

The remarkable property: Tarantula requires no program analysis, no symbolic execution, no formal methods. It requires only (a) a test suite with at least one failing test and (b) line-level coverage information for each test. Both are routinely available in modern development workflows.

Later techniques (Ochiai, DStar, etc.) improved the suspiciousness formula, but Tarantula's contribution was showing that coverage × pass/fail is sufficient to localize faults with surprising accuracy. Empirically, Tarantula examines less than 20% of the code to find the fault in most cases.

Sources: https://dl.acm.org/doi/10.1145/1101908.1101949 and https://faculty.cc.gatech.edu/~harrold/6340/cs6340_fall2009/Slides/class20.pdf

### 8.4. Cooperative Bug Isolation — Statistical Debugging at Population Scale

Ben Liblit's Cooperative Bug Isolation (CBI) — dissertation 2004, PLDI 2005, ICML 2006 — answers a different question than Tarantula (§8.3). Tarantula assumes a dense test suite with per-test coverage. CBI assumes *sparse, noisy feedback from thousands of end-user runs in the field* — and no per-run coverage information.

The instrumentation strategy is **random sampling of predicates**. Every branch, every return-value-sign check, every scalar-pair comparison the compiler can insert is a *predicate*. Rather than recording whether each predicate was true on every run, CBI samples: each predicate is observed with small probability, so per-run overhead stays low, but aggregated across many users the sampling is provably unbiased. What ships back from each user is a feedback report: a count of how many times each sampled predicate was observed true, plus the program outcome (success / crash / deadline miss).

The analysis is statistical. A predicate *P* is suspicious if *Pr(fail | P observed true)* exceeds *Pr(fail)* by enough margin to be unlikely under the null. The PLDI 2005 extension handles **multiple concurrent bugs**: an iterative voting procedure biclusters runs and predicates so that predictors for bug A are not drowned out by the more-common bug B. Case studies identified previously-unknown crashing bugs in MOSS, CCRYPT, and EXIF, all from sparse sampled feedback alone.

The design lesson: **when per-run observation is expensive or noisy, cross-run statistics recover what single-run tracing cannot**. CBI sits next to Tarantula as the distributed-population generalization — less per-run information, traded against vastly more runs. For a language runtime that can ship observations home (opt-in crash reporters, telemetry), the CBI machinery is directly applicable and fits neatly alongside the continuous-profiling infrastructure in `TRACERS.md §14`.

Sources: https://pages.cs.wisc.edu/~liblit/dissertation/ and https://pages.cs.wisc.edu/~liblit/pldi-2005/

### 8.5. Isolating Cause-Effect Chains — Delta Debugging Over Program States

Andreas Zeller's "Isolating Cause-Effect Chains from Computer Programs" (FSE 2002, Distinguished Paper) extends delta debugging (§8.1) from *inputs* to *program states*, and in doing so answers the question most debugging sessions are really asking: *what caused this bug, not just where is it.*

The setup requires a **passing run** and a **failing run** of the same program, frozen inside GDB at comparable execution points. The delta is a set of variable-value differences between the two states. Delta debugging is applied to this delta: flip half of the differences from the passing state into the failing state, resume, see if the outcome flips. Narrow recursively until a **1-minimal state difference** is reached — a minimal set of variables whose values are *causal* to the failure in the interventional sense: change them, and the failure disappears.

Running this at several execution points produces a **cause-effect chain**: a sequence "at `main`, *v₁* differed; at `step_k`, that caused *v₂* to differ; at `step_m`, *v₂* caused *v₃*; at the crash, *v₃* was the immediate cause." The prototype found the chain for a real GCC crash: "C input contained `1.0` → an addition appeared in RTL → a cycle formed in the RTL tree → GCC crashed."

The only tool dependency is a debugger that can **read and write variables in arbitrary frames of a live process**. Zeller used GDB. The output is what programmers construct by hand when they "work backwards" from a crash, except mechanically derived and explicitly causal under an interventional definition — not "this variable correlates with failure" (Tarantula) but "changing this variable makes the failure go away."

The connection to Pernosco (§2.2) is direct: Pernosco's reverse dataflow is a memory-level refinement of the same idea, operating on register transfers rather than source variables, and on a recorded trace rather than two live runs. Cause-effect chains are the *interventional* version; reverse dataflow is the *observational* version.

Sources: https://www.st.cs.uni-saarland.de/papers/fse2002/ and https://www.cs.umd.edu/~atif/zeller.pdf

### 8.6. KLEE — Symbolic Execution as Bug Finder and Test Generator

Symbolic execution turns inputs into *symbols* and runs the program on constraint-laden states rather than concrete values. KLEE (OSDI 2008, Cadar, Dunbar, Engler) is the archetypal LLVM-IR symbolic executor and sets the template for modern tools (angr, Manticore, S2E).

The execution model: every branch *forks* the state into two children, one with the branch condition added to its path condition and one with the negation. A constraint solver (STP, later Z3) prunes states whose path condition is unsatisfiable. On hitting a bug (OOB access, assertion, division by zero, free of invalid pointer) or reaching an exit, KLEE asks the solver to produce **concrete inputs satisfying the current path condition** — so every bug comes with a minimal, replayable test case. The resulting `.ktest` file is directly executable against the uninstrumented binary.

The originality is two-fold. First, **every bug report is reproducible by construction** — no "cannot reproduce" tickets. Second, path explosion is managed by **search heuristics** rather than bounded depth: NURS-MD2U biases selection toward the state closest to uncovered instructions, balancing coverage and depth; Random Path Selection weights paths by inverse subtree size.

KLEE's empirical record: 56 bugs in 452 real applications, 10 fatal in GNU COREUTILS, 3 of them latent for over 15 years. The **cross-checking mode** compares two implementations that should agree (BUSYBOX vs COREUTILS) and symbolically searches for inputs where they differ — turning "any two implementations of the same spec" into test oracles for each other without writing a single assertion.

The trade-offs are the usual ones for symbolic execution: exponential path counts, solver cost on large constraints, weakness on code with opaque library calls, and the need to model the environment (KLEE ships a POSIX environment model). But as a **debugging** tool — "I have a hypothesis that input *X* could cause *Y*; is there an *X* that does?" — symbolic execution asks questions no other technique asks, and when the solver answers, the answer is concrete.

Sources: https://klee.github.io/docs/ and https://llvm.org/pubs/2008-12-OSDI-KLEE.pdf

### 8.7. Fuzzer-Assisted Crash Triage — `afl-tmin`, AFL `-C`, libFuzzer `-minimize_crash`

Modern coverage-guided fuzzers are indirectly powerful debuggers. AFL, libFuzzer, honggfuzz, and their descendants produce crashes by the thousand; the debugger-relevant part is what happens *after* the crash, when the fuzzer is repurposed as a triage tool. These workflows are the automated dual of manual reproduce-and-simplify.

**`afl-tmin`** is delta debugging (§8.1) packaged inside AFL. Given a crashing input and the instrumented target, it produces the minimum byte-level input that still triggers the same crash. It operates on raw bytes but uses the instrumentation coverage signature to ensure the reduced input triggers *the same* bug, not just *any* crash — solving the "minimization landed on a different bug" problem that plain delta debugging hits.

**AFL's `-C` "crash exploration mode"** takes a crashing input and fuzzes forward from it, **maintaining the crash condition as an invariant** via coverage-based acceptance. The output is a corpus of crash variants that preserve the faulting state while varying surrounding memory and control flow — answering "how much does the attacker control once the crash is reached?" in minutes of automated search. **libFuzzer's `-minimize_crash=1`** is the in-process variant of the first tool — no separate orchestration, same algorithm.

**`afl-collect`** (rc0r/afl-utils) deduplicates crashes by **backtrace hash** rather than input hash: different inputs that crash at the same backtrace collapse into one bug, addressing the "one bug shows up as 10,000 crashes" noise that otherwise overwhelms triage.

**Hybrid concolic fuzzing** (Driller, angr's phuzzer) marries AFL with symbolic execution (§8.6): when AFL gets stuck on a magic-number check or checksum it cannot mutate past, symbolic execution computes an input that satisfies the check and injects it into AFL's corpus. The two techniques cover each other's weaknesses — fuzzer gets broad coverage cheaply, symbolic execution crosses constraint walls.

The debugging role is narrow but sharp: **given a crash, produce a minimal reproducer and a population of related crashes.** Humans doing this by hand spend hours to days; machines finish in seconds to minutes.

Sources: https://afl-1.readthedocs.io/en/latest/fuzzing.html and https://chromium.googlesource.com/chromium/src/+/main/testing/libfuzzer/reproducing.md

### 8.8. Miri — MIR Interpreter as UB Detector

Miri (Ralf Jung et al., 2017–) interprets Rust's MIR one operation at a time and, in doing so, detects **Undefined Behavior as it happens**, not as a statistical consequence of a downstream crash. It sits in §8 because its purpose is fault isolation: pinpoint the exact MIR statement and memory state where safety is violated.

The architecture reuses the compiler's `rustc_const_eval::interpret` engine — the same one that evaluates `const fn` at compile time — and extends it via a `Machine` trait whose `MiriMachine` implementation adds threading, file I/O, optional FFI, and per-allocation metadata. Every MIR operation goes through UB checks: out-of-bounds (allocation bounds check), use-after-free (`AllocId` marked dead on deallocation), read of uninitialized memory (per-byte initialization bitmask in the `Allocation` struct), misaligned access (symbolic or int alignment mode), invalid value (`ValidityVisitor` — a `bool` must be 0 or 1, a `&T` must be non-null and aligned, a `char` must be a valid scalar), and **aliasing-model violations** under Stacked Borrows or Tree Borrows (Miri's experimental formal models of Rust's aliasing rules).

The original contribution, in this survey's frame, is: **the debugger is an interpreter that speaks the compiler's own IR**. Compiler and debugger share an engine. This is possible because Rust's MIR is an explicit, well-typed IR designed for analysis; the const-evaluator exists regardless of Miri. Extending it to full program execution with instrumentation was an *engineering* step, not a *design* one. No other mainstream language has this property today — although Zig's comptime evaluator and Koka's algebraic-effects interpreter are in the same family.

Miri also leaks-detects at process exit: any allocation not reachable from a `static` is a leak. MIRIFLAGS (`-Zmiri-stacked-borrows`, `-Zmiri-tree-borrows`, `-Zmiri-disable-isolation`) dial in the check strictness.

The trade-off is crushing slowdown — MIR is interpreted, not JIT'd, and every access goes through check logic — and incomplete coverage (no formal specification of Rust semantics exists, so Miri uses an approximation, and programs calling opaque C code cannot be fully verified). But for the question it answers — *is there UB on this execution?* — it answers authoritatively and with an exact MIR-level diagnostic. The design lesson for a new language: if the IR is accessible and typed, an interpreter-based UB detector is cheap to add and catches bugs no DWARF-based debugger will.

Sources: https://github.com/rust-lang/miri and https://deepwiki.com/rust-lang/rust/6.2-miri:-mir-interpreter-and-ub-detector

### 8.9. Whyline — Interrogative Debugging

Andrew Ko and Brad Myers (CHI 2004 for Alice, OOPSLA 2008 for Java) observed that when programmers debug, they don't step through code — they ask "why did this happen?" and "why didn't that happen?" Traditional debuggers force the programmer to translate those questions into breakpoint locations and watch expressions. The **Whyline** inverts the model: **the UI is a menu of why-did and why-didn't questions about program output, auto-generated from the program's source and execution.**

Selecting a question (the Alice example: *"Why didn't Pac resize 0.5?"*) triggers a program analysis that answers it using **static + dynamic slicing, precise call graphs, and new algorithms for why-not-reached code**. The answer shows only the runtime events that caused or prevented the target outcome — the predicate that was false, the actions that defined its operands, the branches that skipped the relevant code — with colors and labels matching the source. Unrelated actions are excluded, reducing visual noise dramatically.

Evaluation: comparing identical debugging scenarios, programmers using Whyline debugged 7.8× faster than without it; novices with Whyline outperformed experts without it; task-completion improved by 40%. The Java Whyline (2008) generalized the approach from Alice's tiny educational language to a mainstream ecosystem by recording execution traces with enough metadata to answer both kinds of questions retroactively on the trace.

Philosophically this sits alongside Pernosco (§2.2): both use a recorded execution as a queryable database, but Whyline's contribution is the *interrogative UI* — users don't compose queries, they pick from an auto-generated list derived from what's currently on the output. The language-design lesson: if the compiler tracks enough provenance to connect output values back to the code that produced them, an interrogative debugger is a reasonable feature to ship — not a research aspiration.

Sources: https://www.cs.cmu.edu/~NatProg/papers/Ko2008JavaWhyline.pdf and https://faculty.washington.edu/ajko/papers/Ko2004Whyline.pdf

### 8.10. Algorithmic Debugging and the Byrd Box 4-Port Model

Two connected contributions from the logic-programming tradition, both worth importing into a modern language's debugger vocabulary.

**The Byrd box model** (Lawrence Byrd, 1980) conceptualizes every Prolog predicate as a **state machine with four ports**: `call` (the predicate is invoked), `exit` (it succeeds), `redo` (the engine backtracks into it seeking another solution), `fail` (no more solutions). SWI-Prolog extends this with `unify` and `exception`. Boxes nest — calling a subgoal enters *its* box, and tracing walks a recursive tree of box activations, recording control flow through ports rather than through a linear call stack.

The original contribution is that **nondeterministic control flow needs a richer port model than call/return**. An imperative debugger's "call" and "return" cannot express backtracking or multiple-solution enumeration; the 4-port model can. For any language with coroutines, generators, search/backtracking, effect handlers, or dataflow reactivity, a Byrd-box-style tracer is more faithful than a plain call-stack tracer — each coroutine or handler has `call`, `suspend` (≈`exit`), `resume` (≈`redo`), and `fail` ports that map directly. Tracking execution through those ports exposes the control shape the programmer actually wrote.

**Algorithmic debugging** (Ehud Shapiro, MIT PhD 1982, published as *Algorithmic Program Debugging*, MIT Press) is a different mechanism. Given a program that produced a **wrong answer**, Shapiro reifies the **computation tree** of that answer — each node is a subgoal call and its observed result — and **asks the user yes/no questions** about whether each subgoal's result is intended: *"Did `factorial(5)` return 120? Correct? Y/N."* The debugger bisects the tree based on the user's answers, converging on the smallest subtree where the result is wrong but all its children were correct — **isolating the buggy clause mechanically, without the user inspecting code.**

This is **declarative debugging**: the user reasons about *intended semantics*, not operational behavior. The debugger infers the buggy code by triangulating between what the program did and what the user says should have happened. Extensions spread beyond Prolog: Naish's Mercury debugger, lazy functional-logic variants (Wadler-style), declarative diagnosers for constraint logic programming. For a language whose semantics the programmer understands better than its operational trace — which is most languages — declarative debugging complements every step-through technique in this document.

The design lesson for a new language: **the question the debugger asks the user is a choice**. "Where should I step?" (traditional), "Why did X happen?" (Whyline §8.9), "Is this result correct?" (Shapiro). The last is the cheapest for the user — it requires zero code knowledge beyond semantic intent — and the most powerful when the language's evaluator can reify its own computation tree.

Sources: https://swish.swi-prolog.org/pldoc/man?section=byrd-box-model and http://www.cs.cmu.edu/Groups/AI/lang/prolog/code/debug/shapiro/0.html

### 8.11. Dynamic Invariant Detection — Daikon

Dynamic invariant detectors observe executions and infer properties that appear to hold: `x <= y`, `len(buffer) == count`, `field != null`, "this collection is sorted", or "this function returns a value larger than its argument." Daikon (Ernst et al.) is the canonical system: it instruments programs, records values at program points, and emits likely invariants that could be written as assertions, contracts, or documentation.

This is useful for fault isolation because inferred invariants summarize what the program usually believes about its own state. A failing run can be compared against mined invariants from passing runs; violated invariants become candidate explanations. False positives are expected — the technique depends on test quality — but even false invariants reveal missing tests or underspecified behavior.

The language-design lesson: **make values observable at semantic program points**. If the compiler can expose function entries/exits, loop heads, object fields, algebraic data constructors, and effect boundaries in a typed trace format, invariant mining becomes much more accurate than raw memory observation. Daikon is the population-statistics sibling to CBI (§8.4): both extract bug signal from many runs, with Daikon mining invariants and CBI mining failure-correlated predicates.

Sources: https://plse.cs.washington.edu/daikon/ and https://plse.cs.washington.edu/daikon/pubs/

---

## 9. Async & Coroutine Debugging

Async/await, coroutines, goroutines, and effect handlers all break the assumption that the call stack is the logical call chain — once a coroutine suspends and resumes, the physical stack no longer reflects who called whom. Reconstructing the logical async chain therefore depends on whatever metadata the runtime preserves across suspension points. Entries in this chapter differ on **how much runtime cooperation** the debugger can assume: Go's built-in scheduler events (§9.2), Kotlin's coroutine objects carrying continuation state (§9.3), V8's stitched async stacks recorded at each `await` (§9.4), and Rust's `tokio-console` runtime introspection (§9.5) each represent a different point on the spectrum from designed-in metadata to retrofitted introspection.

### 9.1. The Async Stack Problem

Traditional debuggers show the call stack — the chain of function calls leading to the current point. For async/await, coroutines, and goroutines, the call stack is misleading: it shows the executor/scheduler's stack, not the logical chain of `await` calls that led to the current suspension point.

The core challenge: when a coroutine suspends and later resumes, the physical stack frame that created the coroutine may no longer exist. The "parent" in the async sense is not the caller in the stack sense. Debugging an async Python program with GDB shows `_selector.poll()` at the top of every stack — the event loop — with no indication of which coroutine is stuck or why.

The design lesson framing the rest of this chapter: **async debugging requires runtime cooperation**. The runtime must record enough metadata (parent task, spawn site, await site) to reconstruct logical call chains. Languages that design async runtimes with debugging metadata from the start (Go, Kotlin) provide dramatically better debugging experiences than languages where async was added later (Python, Rust). The four following subsections trace this spectrum from heaviest first-class support to most retrofitted.

### 9.2. Go — `runtime/trace` + Delve Goroutine Awareness

Go's runtime emits **scheduler events** — goroutine creation, blocking on channels/mutexes/syscalls, unblocking, GC pauses, system-monitor activity — into a per-thread ring buffer enabled by `runtime/trace.Start`. The result is a structured event stream that `go tool trace` visualizes as a per-goroutine timeline, with synchronization edges connecting senders to receivers across the goroutine graph. The mechanism is the same one TRACERS §3.5 covers from the always-on observability angle; for *debugging*, the same trace tells the operator which goroutine got stuck where.

**Delve** is the Go debugger's runtime-aware front-end. `goroutines` lists every live goroutine with its current state (running, runnable, waiting on chan/syscall/mutex/io), the user-level function it last entered, and the blocked-on resource. `goroutine N` switches the debugger context to goroutine N so subsequent `bt`, `frame`, `print` commands operate on its stack rather than the current OS thread's executor stack. This is the cleanest production realization of "the debugger natively understands the runtime's concurrency primitive" — Delve is built knowing about `g`, `m`, `p` structures and walks them directly.

The design takeaway is that Go's day-one investment in scheduler-event metadata pays compounding dividends for tooling. Async debugging in Go does not require stitching, post-hoc reconstruction, or third-party introspection libraries — the runtime just hands over the information.

Sources: https://github.com/go-delve/delve and https://pkg.go.dev/runtime/trace

### 9.3. Kotlin — Coroutine Object Metadata + Parallel Stacks

Kotlin coroutines are not OS threads; they are state machines compiled from `suspend fun` source, with each suspension point capturing the continuation (the "rest of the function") plus the local variables it needs. The compiler emits debug metadata describing this transformation, and IntelliJ's coroutine debugger reads that metadata to reconstruct logical call chains across `await`/`suspend` boundaries.

The **Parallel Stacks plugin** (Google, GSoC 2023) builds a visual graph of coroutine relationships from this metadata: which coroutine spawned which, what each coroutine is currently waiting on, and how cancellation propagates through the tree. Where Delve presents Go's flat goroutine list (§9.2), the Kotlin tooling presents a *graph* — appropriate because Kotlin coroutines are structured (parent–child by `coroutineScope`) in a way Go's flat goroutines are not.

The pattern: **structured concurrency in the language gives the debugger a richer object to render**. A flat list of goroutines can only be a list; a tree of structured-concurrency scopes can be a graph.

Source: https://kotlinfoundation.org/news/gsoc-2023-parallel-stacks/

### 9.4. JavaScript — V8 Stitched Async Stack Traces

V8 and Chrome DevTools maintain "async stack traces" by **recording the call stack at each `await` / `.then` / `setTimeout` callback boundary** and stitching them together when an exception fires or the debugger pauses. The user sees a synthetic stack showing the full chain of asynchronous resumptions, even though the physical stacks at each link were already discarded by the event loop. The stitching is bounded — typically the last 10 async hops are kept — to keep memory cost predictable.

The mechanism is **runtime cooperation paid at every suspension point**: each await pushes its current stack into a side data structure keyed by the resulting promise/microtask. Resumption reads the saved stack and stitches it as the "async caller." For users this is invisible; for V8 the steady-state cost is real but bounded, and the design has been the de-facto template for every modern JavaScript runtime debugger.

Sources: https://kotlinfoundation.org/news/gsoc-2023-parallel-stacks/ and https://developer.chrome.com/blog/devtools-modern-web-debugging/

### 9.5. Rust — `tokio-console` + Future Introspection

Rust's async story is the most retrofitted of the four. Async functions desugar to opaque state machines (anonymous types implementing `Future`); the physical stack at any moment shows only the executor's poll loop, never the logical chain of `await`s that led to the current suspension. Worse, the futures themselves are user-defined types with no shared metadata layout — the debugger cannot generically inspect "what is this future waiting on" without the runtime providing structure.

**`tokio-console`** is the runtime-introspection answer for Tokio. Built on `tracing` instrumentation that Tokio emits for task spawn/poll/wake/drop events, the console presents a per-task view: which task is running, which is waiting on which resource, how many times each has been polled, how long each poll took, and the source location where each task was spawned. The "waker graph" answers the unique-to-Rust-async question of *who would unblock this task* — typically a different task, identified by its waker.

The retrofit cost is visible in the architecture: tokio-console is a separate crate, requires opt-in instrumentation, and only works for Tokio (other Rust async runtimes — async-std, smol, glommio — need their own equivalents). Compare with Go (§9.2) where every binary's runtime is debuggable by Delve out of the box. The lesson generalizes: **a language that retrofits async pays the debugger tax for years afterward in the form of fragmented, runtime-specific tooling**.

Sources: https://github.com/tokio-rs/console and https://tokio.rs/blog/2021-12-announcing-tokio-console

---

## 10. Concurrency-Aware Debuggers

Concurrency bugs evade step-through debugging. Data races disappear when the scheduler is slowed, deadlocks manifest only under load, and a stop-the-world breakpoint changes the very timing relationships being investigated. The tools in this chapter instrument synchronization semantics instead of stopping execution — they *observe* concurrency rather than pause it. Entries split along three orthogonal questions: **did a race happen on this run?** (§10.1 ThreadSanitizer's hybrid happens-before + lockset), **what schedules could have happened that we haven't tried?** (§10.2 systematic schedule exploration via CHESS / loom / FoundationDB), and **why is nothing making progress?** (§10.3 deadlock/liveness wait-graph reasoning). They sit between the omniscient debuggers of §3 (which could in principle see races but rarely do at runtime resolution) and the always-on tracers of `TRACERS.md` (which record events but don't reason about happens-before).

### 10.1. ThreadSanitizer v2 — Hybrid Happens-Before + Lockset

ThreadSanitizer (Serebryany, Iskhodzhanov, PACT 2009; v2 rewrite 2013) is a dynamic data-race detector shipped in Clang and GCC as `-fsanitize=thread`. Unlike v1 (Valgrind-based, slow), TSan v2 is **compiler-instrumented** — the compiler inserts shims around every memory access and synchronization primitive — making it ~20× faster than v1 and fast enough to run on full Chromium browser binaries, not just unit tests.

The algorithm is **hybrid: happens-before + lockset**. For every memory location, TSan maintains shadow memory recording the thread ID, clock, and synchronization context of recent accesses. On each access, it checks whether the accessing thread's vector clock establishes a happens-before relation to the previous accessor. If yes — no race. If no, and the locksets held by the two threads do not intersect — race reported, with both stack traces, both thread IDs, and the held-mutex list.

The scope extends beyond pure races. TSan v2 detects **lock-order-inversion deadlocks** (cycles in a lock-graph it builds at runtime), **destruction of locked mutexes**, **use-after-free in concurrent code**, **async-signal-unsafe calls inside signal handlers**, **leaked threads**, and **races on vptr, file descriptors, and `pthread_barrier_t`**. It recognizes `std::atomic` and `__atomic_*` intrinsics, so lockless code is analyzed correctly. A **dynamic annotations API** (`ANNOTATE_HAPPENS_BEFORE` / `_AFTER` / `_IGNORE_WRITES_BEGIN`) lets user code teach TSan about custom synchronization not expressible in pthreads or standard atomics.

The trade-offs: 5–15× slowdown and 5–10× memory overhead from shadow state (~1 shadow byte per program byte of memory touched), plus the fundamental limit that TSan only finds races *that actually occurred on an instrumented execution* — scheduler coverage still matters. Suppressions files (`race:`, `deadlock:`, `thread:`, `mutex:`, `signal:` prefixes) mask benign or unfixable races in third-party code.

The design lineage: TSan descends from Helgrind (Valgrind) and inspires RacerD (Facebook, static). Go's built-in race detector (`go build -race`) is a TSan runtime with Go-specific happens-before rules for channels, `sync` primitives, and the scheduler. The language-design lesson: **if the runtime owns synchronization primitives** (Go's `go`, channels, mutex; a language's actor runtime; a language's effect system), happens-before tracking can be exhaustive with low overhead because every synchronization point is a known call site.

Sources: https://research.google.com/pubs/archive/35604.pdf and https://github.com/google/sanitizers/wiki/ThreadSanitizerDetectableBugs

### 10.2. Systematic Concurrency Schedule Exploration

Race detectors find races that happened in one execution. Systematic concurrency testing tries to *make* rare schedules happen. The runtime replaces the normal scheduler with a controlled scheduler, explores task interleavings, injects yields at synchronization points, records schedules, and replays failing schedules deterministically.

Microsoft CHESS pioneered this for threaded programs using schedule bounding and partial-order reduction. Rust's `loom` explores possible interleavings of atomics, mutexes, and threads by replacing synchronization primitives with instrumented models. FoundationDB's deterministic simulation runs distributed-system components under a deterministic event loop with randomized faults, delays, and schedules, making entire cluster failures reproducible.

The language-design lesson: **if the language owns tasks, channels, actors, or effects, it can own the scheduler in tests**. A debugger can then show "the schedule that caused the bug" as a first-class artifact, not just a stack trace. Pairs naturally with the happens-before tracking of §10.1 — schedule exploration finds the schedule, sanitizers diagnose what happens on it.

Sources: https://www.microsoft.com/en-us/research/project/chess/, https://github.com/tokio-rs/loom, and https://apple.github.io/foundationdb/testing.html

### 10.3. Deadlock and Liveness Debugging

Data races are not the only concurrency bugs. Programs also hang: locks form cycles, tasks wait on futures that will never complete, actors starve in mailboxes, channels have no receiver, and thread pools exhaust themselves. The debugger question is not "who wrote this memory?" but "why is nothing making progress?"

Classic thread dumps expose blocked threads, owned locks, and wait stacks; JVM tools can detect monitor deadlocks from a wait-for graph. Go goroutine dumps show goroutines blocked on channels, mutexes, syscalls, and timers. Linux `lockdep` validates lock ordering in the kernel. Async runtimes such as Tokio can expose task graphs and resource wait states through tools like `tokio-console`.

The language-design lesson: **debug wait relationships explicitly**. If the runtime has structured concurrency, channels, actors, promises, mutexes, and cancellation, it can maintain a wait-for graph: task A awaits future B, B waits for timer C, actor D waits for mailbox message E. A debugger can then answer "why is this task stuck?" directly.

Sources: https://docs.oracle.com/javase/8/docs/technotes/guides/troubleshoot/tooldescr034.html, https://go.dev/doc/diagnostics, https://docs.kernel.org/locking/lockdep-design.html, and https://github.com/tokio-rs/console

---

## 11. Post-Mortem and Out-of-Process Debugging

Not every bug can be caught live. Production programs crash hours after the developer went home; kernel panics leave no process to attach to; containers get killed and restarted before anyone can run `gdb -p`. Post-mortem debugging starts from a *frozen record of state* — a core dump, a vmcore, a checkpoint, a hardware-probe halt, or a curated crash artifact — and reconstructs what happened after the fact. This chapter covers the mechanisms that produce these records, the tools that read them, the hardware substrate beneath embedded targets, the production pipelines that ship crash artifacts off failing machines, and the special cases (kernel, managed runtimes) where the generic machinery falls short. CRIU (§2.7) is the non-crash sibling: checkpoint a *healthy* program for later inspection.

### 11.1. Core Dumps — ELF Cores, `coredump_filter`, On-Demand Snapshots

A core dump is a file written by the kernel (or by the process itself) containing the memory image and register state at a moment — typically a crash. On Linux/BSD, the format is ELF with `PT_LOAD` segments for each mapped region plus `PT_NOTE` segments carrying register state, signal info, `auxv`, and file-backed mapping metadata. GDB and LLDB both load cores directly: `gdb program core` and `lldb --core core`. LLDB uses a dedicated `elf-core` process plugin so core-debug and live-debug share the same API surface.

The original contribution relevant to language design is **`/proc/<pid>/coredump_filter`** — a kernel-level bitmask controlling which mapping types get dumped. The bits select among anonymous private, anonymous shared, file-backed private, file-backed shared, ELF headers, private huge pages, shared huge pages, DAX private, and DAX shared. Default is `0x33` (anonymous + ELF headers + private huge pages) — enough to debug most crashes, small enough to ship. `madvise(MADV_DONTDUMP)` marks specific regions as dump-excluded, used for large read-only mmaps or secrets. `ulimit -c` and `systemd-coredump` gate whether a dump is written at all.

**On-demand self-dump** is supported via `gcore <pid>` (GDB), LLDB's `process save-core`, and at the protocol level by the `qSaveCore` gdb-remote packet plus platform-specific `PT_COREDUMP` (FreeBSD) and `PT_DUMPCORE` (NetBSD). The use case is "snapshot a misbehaving process without killing it" — comparable to VS Snapshot (§2.3) but without `fork()`'s copy-on-write semantics; the dumped process continues running.

**Managed-runtime cores are often useless** to a generic debugger. A kernel-generated core of a .NET process captures the managed-heap *bytes* but not the object-header metadata needed to walk the heap without SOS (Son of Strike, the .NET debugger extension). The same is true of JVM cores without the SA (Serviceability Agent) plugin. The lesson: a language runtime that wants usable post-mortem support must provide a **runtime-aware dumper** (CoreCLR's `createdump`, HotSpot's `jcmd GC.heap_dump`, V8 heap snapshots) that emits a format its debugger understands, *in addition to* the generic core. Generic cores catch native-frame crashes; runtime-aware dumps catch managed-state bugs.

Sources: https://www.sourceware.org/gdb/onlinedocs/gdb/Core-File-Generation.html and https://www.moritz.systems/blog/lldb-core-dump-support-improvements/

### 11.2. kdump — kexec Capture Kernel + the `crash` Utility

Kernel panics destroy the kernel's ability to write a dump — the memory you want to capture belongs to a machine whose scheduler has just wedged. kdump solves this by pre-loading a **second kernel in reserved memory** at boot via `kexec`, and transferring control to it on panic.

The mechanism: at boot, `kexec -p` loads a small capture kernel into a reserved region (typically 128–512 MB, configured via `crashkernel=` on the main kernel's command line). The primary kernel's memory is preserved across the kexec handoff because the capture kernel operates inside its own reserved region and the primary's pages are left untouched. On panic, kernel panic handlers jump into the capture kernel, which boots into a minimal userspace, reads the primary kernel's pages through `/proc/vmcore`, writes them (or a filtered subset) to disk or a network target, and reboots.

The **`crash` utility** (Dave Anderson, Red Hat) is a **kernel-aware debugger** for the resulting vmcore. Unlike GDB, which understands ELF+DWARF but not kernel data structures, `crash` understands `task_struct`, slab allocators, zone allocators, the kernel log ring buffer, and per-CPU data. Commands include `bt` (cross-task backtrace), `ps` (process list from `task_struct`s), `kmem -s` (slab contents), `rd`/`wr` (raw memory read/write), `files` (open files per task), `log` (ring buffer extraction). It links against `vmlinux`'s debug info (or a separate `-debuginfo` package) and cross-references structures by offset.

**`makedumpfile`** shrinks the vmcore before write — a full vmcore equals physical RAM, intolerable for a 256 GB server. `makedumpfile -c -d 31` compresses and excludes zero, free, cache, and user-space pages, typically reducing the dump to 1–10% of original size while preserving kernel state.

**`pstore`** is the embedded-system variant. No reserved memory for a capture kernel, so the kernel writes oops traces and console log to persistent storage — ACPI ERST, MTD flash, or `ramoops` backed by DRAM that survives a soft reboot — for retrieval after the next boot. Useful when the bug reboots the machine before kdump can run.

Sources: https://www.kernel.org/doc/html/v5.19/admin-guide/kdump/kdump.html and https://kernel-internals.org/debugging/kdump/

### 11.3. KGDB + KDB — Dual Frontends Over a Shared Debug Core

For *live* kernel debugging — not post-crash analysis — Linux provides two frontends sharing one `debug_core`: **kgdb** (source-level via GDB Remote Serial Protocol) and **kdb** (shell-style, on-console, deadlock-safe). They are not competitors; `CONFIG_KGDB` builds both and the operator switches between them at runtime.

**kgdb** exposes a GDB remote stub inside the kernel. A developer runs `gdb vmlinux` on a host machine, connects via serial or (net)console to the target, and debugs the kernel source-level: stepping, breakpoints on symbols, variable inspection. gdbserver's wire protocol is reused; only the target side is new.

**kdb** is a shell the operator sees *on the target's own console* — keyboard, serial, or graphics console with KMS integration that saves and restores graphics modes around entry. It is deliberately **not source-level**: no DWARF parsing, no local-variable display, because those operations take locks and may touch paged-out memory. kdb's commands (`bt`, `md`, `mm`, `rd`, `go`, `ss`) are deliberately minimal to survive in any kernel state. This is kdb's original contribution: **a debugger that works even when the kernel is so broken that a source-level debugger would deadlock**.

The shared `debug_core` (in `kernel/debug/`) owns breakpoint management, single-step arming, thread snapshotting, and dispatch to the arch-specific implementation (`arch/*/kernel/kgdb.c`). I/O drivers (`kgdboc` for serial-over-console, `kgdbts` for tests) connect the debug core to the outside. Key invariants the core enforces: I/O drivers must not enable interrupts and must not take locks that could deadlock against the panicked state; breakpoint insertion must tolerate concurrent CPUs by stopping them at a barrier.

The dual-frontend design generalizes beyond kernels. For a language runtime, the same lesson applies: **a full, rich, source-level debugger is a luxury that requires a healthy runtime**. A second, minimal, shell-style debugger — usable when the runtime itself is compromised — is cheap insurance against the bug you actually hit.

Source: https://www.kernel.org/doc/html/latest/process/debugging/kgdb.html

### 11.4. Embedded Target Debugging — defmt, probe-rs, RTT, ITM

Embedded debugging has constraints no desktop debugger faces: no OS, no filesystem, no network stack, no UART baud headroom for `printf`-style logging, and RAM measured in kilobytes. The Knurling / Ferrous Systems stack addresses this with a layered design whose key insight is **move all formatting off the target**.

**`defmt` — deferred formatting.** Ordinary `printf` on a microcontroller drags the full formatter in, ballooning binary size. `defmt` instead emits a **compact binary frame** keyed to the format string's *index*; the format string itself is stored in a non-loaded `.debug` section of the ELF. The target writes a few bytes (level + format-string index + args), and the host decoder (`defmt-print` or probe-rs) reads the ELF, looks up the format string, and reconstructs the formatted message. On-target binary size drops by an order of magnitude versus `printf`, and log fidelity (structured args, typed encoding) increases.

**RTT — Real-Time Transfer.** Instead of pushing logs over UART, the target writes into a **ring buffer in its own SRAM**, structured with a well-known header pattern the probe can locate by scanning RAM. The debug probe, connected over SWD or JTAG, polls the buffer over the debug interface and drains it. No UART pins, no baud-rate trade-offs, multi-MB/s throughput on some configurations.

**ITM / SWO.** ARM Cortex-M cores include an on-chip **Instrumentation Trace Macrocell** that emits events over a dedicated serial wire (SWO). `defmt-itm` routes defmt frames through ITM for even lower overhead than RTT — the core's tracing hardware does the I/O without CPU polling or DMA burn. Cortex-M tracing hardware covered in more depth in `TRACERS.md §5`.

**probe-rs** is the host-side Rust rewrite of OpenOCD + gdbserver. It speaks SWD/JTAG natively, flashes firmware, attaches/runs targets, and integrates with defmt and RTT out of the box. `probe-rs run` is a cargo target runner, so `cargo run` on an MCU project works like running a native binary, with defmt logs streaming to the host terminal and panic backtraces decoded by `panic-probe`. A DAP adapter is built in, so VS Code debugs MCUs the same way it debugs desktop processes. `probe-rs serve` even exposes the probe over a network so a CI machine's board farm can be driven from a developer's laptop.

The generalizable lesson is a pattern also seen in debuginfod (§7.4): **the host is rich, the target is poor — push work to the host**. A language runtime targeting constrained environments should ask, for every runtime feature, what can be deferred, indexed, or decoded off-target. defmt is the `.debug_info` of embedded logging.

Sources: https://github.com/knurling-rs/defmt and https://probe.rs/docs

### 11.5. JTAG / SWD / OpenOCD Hardware Debugging

Bare-metal targets often lack `ptrace`, signals, virtual memory, files, or an operating system. Debugging happens through a hardware probe. JTAG and ARM SWD let the host halt the core, read/write registers and memory, set hardware breakpoints/watchpoints, flash firmware, and sometimes stream trace data through CoreSight, ETM, ITM, or SWO.

OpenOCD is the classic open-source bridge from probes to GDB remote protocol. `probe-rs` (covered in §11.4) is the Rust-native replacement for many Cortex-M workflows. Flash breakpoints are a special constraint: code in flash cannot be patched with `INT3` cheaply, so debuggers rely on a limited number of hardware comparators or rewrite flash pages sparingly. Semihosting lets target code request host I/O through debugger traps, useful but slow.

The language-design lesson: **embedded debugging is a target ABI, not just a tool**. Panic formatting, stack unwinding, symbol names, frame pointers, no-std allocators, and debug sections must work when the only communication channel is a probe reading memory.

Sources: https://openocd.org/doc/html/index.html and https://developer.arm.com/documentation/ihi0031/latest/

### 11.6. Production Crash Pipelines: Minidumps, Symbolication, and Grouping

Core dumps (§11.1) are complete but often too large, too sensitive, or too platform-specific for deployed software. Production crash systems instead collect compact crash artifacts: Windows minidumps, Breakpad/Crashpad dumps, Apple crash reports with `.dSYM` symbolication, JavaScript stack traces with source maps, or Sentry-style event envelopes. Server-side symbolication then reconstructs source locations from build IDs, debug files, unwind tables, source maps, and inlining metadata.

This is a debugger technique because most deployed bugs are debugged after the fact, without the original process. The crash pipeline decides whether the developer gets a useful stack trace, async causality, registers, thread list, loaded module versions, panic payload, breadcrumbs, and privacy-filtered local variables — or only "segmentation fault."

The language-design lesson: **standardize the crash artifact early**. A new language should define panic/crash metadata, build IDs, symbol lookup, async stack capture, source-map/debug-info integration, and privacy controls as part of its tooling story. The build-ID symbol distribution side is covered in §7.4 (debuginfod); minidumps are the artifact format that pairs with it.

Sources: https://chromium.googlesource.com/breakpad/breakpad, https://chromium.googlesource.com/crashpad/crashpad, and https://learn.microsoft.com/en-us/windows/win32/debug/minidump-files

---

## 12. Specification-Level Debugging

Most of this document is about debugging executions of programs. This chapter is about debugging *specifications* — artifacts whose semantics are not "run and observe" but "verify and inspect." Model checkers and interactive theorem provers share a debugger pattern: the proof or counterexample itself is the debugging surface, and the debugger's job is to make it navigable. The techniques are adjacent to omniscient debugging (§3) and typed-hole liveness (§6.2), but the execution model is fundamentally different — there is no live process, only a search over states or proof terms.

### 12.1. TLA+ — Counterexample Trace as Debugger Output

When TLC (the TLA+ model checker) detects an invariant violation, it emits the **shortest state sequence** that leads to the violation — typically 3–15 states. The TLA+ Toolbox's Error Trace View renders the trace with per-step variable-change highlights (red for changed, expandable function values for nested updates, fold/hide unchanged variables), making it a navigable debugger trace rather than a wall of text.

The **Trace Explorer** is the original contribution: an expression box attached to the error trace where the user types arbitrary TLA+ expressions. Each expression is **evaluated at every state of the trace** and its values shown as a new column. Because TLA+ supports primed variables (`x'` = value of `x` in the next state), you can write action predicates (`prod' = x' * y'`) and see which action is firing, or derived quantities (`margin == max - sum`) to understand *why* an invariant holds right until it doesn't. This is a debugger's watch panel — except every watch is evaluated over the entire already-computed trace, retroactively.

The **TLA+ Debugger** (2024) extends this with **interactive state-space exploration**: breakpoints after `Init` or `Next`, **conditional breakpoints on `~ENABLED Next`** that catch deadlocks automatically, step-in using *minimal Hamming distance* between successor states to follow a "close" next state, step-over using *maximal Hamming distance* to jump to a "far" one. Trace export supports multiple formats: DOT/GraphViz for visualization, `_TLAPlusCounterExample` for replay as a TLA+ spec, `_TLCTESpec` for trace-expression specs that re-verify the trace as a valid behavior, `_TLCActionTrace` for minimization workflows.

This is a *debugger for specifications*. The "program" is a TLA+ spec, the "bug" is an invariant violation, the "trace" is the minimal path to the violation. No live process exists to step; the trace is a finite graph the debugger walks. The design lesson: **for any verification tool whose output is a counterexample, the debugger is a navigable view of that counterexample, not a separate artifact.** SPIN and Alloy deliver similar experiences for their respective formalisms.

Sources: https://learntla.com/topics/toolbox.html and https://discuss.tlapl.us/msg06620.html

### 12.2. Lean / Coq / Agda InfoView — Proof State as Debugger

Interactive theorem provers (ITPs) are fundamentally dialogue-driven. Every user action — applying a tactic, filling a hole, elaborating a term — produces a new **proof state**: a list of open goals, each with a list of hypotheses (name + type) and a target type. The "debugger" is the view of this proof state, updated continuously as the user edits.

Lean 4's **InfoView** (described in Nawrocki et al., "An Extensible User Interface for Lean 4", ITP 2023) displays:
- All open tactic goals at the cursor position, with hypothesis lists formatted with interactive type annotations.
- **Diff highlighting**: subexpressions added or removed compared to the previous proof state are rendered green or red, so the *effect of a tactic* is visible without reading the tactic itself — a Myers-diff applied to proof state.
- **Pin** locations: freeze a proof state view at a specific location so it remains visible when the cursor moves elsewhere, useful for comparing two branches of a proof or cross-referencing an earlier obligation.
- **Bidirectional widgets**: UI components that can invoke Lean metaprograms and edit the proof script from inside the UI. The user can *make progress on the proof through the UI*, not just observe it.
- **Metavariables** (`?m.392`, `?u.498`) and named goals (`case foo`), which are the proof-level analogue of typed holes (§6.2) — incomplete portions of the proof term that still typecheck and drive goal display.

Agda's typed-hole UX and Coq's goal view are the same philosophy with syntactic variation — all three share the "goals + hypotheses + target type" trinity as the user's debugging surface.

The deeper claim: **in a language where the primary object is a proof (not a program), the debugger is a goal-state viewer**. Every tactic is simultaneously a construction step and a diagnostic — miss a hypothesis, the goal state shows what was missed; apply an over-eager rewrite, the diff highlights what got rearranged incorrectly.

See `DEBUGGERS.md §6.2` for Hazel's analogue in ordinary functional programming: incomplete expressions still typecheck and partially evaluate. InfoView is the proof-construction analogue; the underlying idea — **every editor state is meaningful; feedback is continuous** — is shared.

Sources: https://drops.dagstuhl.de/opus/volltexte/2023/18399/pdf/LIPIcs-ITP-2023-24.pdf and https://github.com/leanprover/vscode-lean4

---

## 13. Summary of Debugger Techniques

Rows grouped by chapter, in chapter order.

| Technique | Cost When Off | Cost When On | Key Trade-off | Examples |
|---|---|---|---|---|
| INT3 breakpoint + displaced stepping | N/A (inserted per bp) | Trap + handler per hit | Universal; displaced step avoids remove-step-reinsert race | GDB (§1.1) |
| Compiled conditional breakpoint (INT3;NOP) | Zero until condition true | Single trap when fired | Requires source-level edit, not runtime toggle | Chris Wellons pattern (§1.2) |
| Hardware debug registers (DR0–DR3) | Zero on unwatched access | Trap (~3μs on Linux) | Max 4 watchpoints × 8 bytes | GDB, Jane Street perftrace (§1.3) |
| RISC-V PMP as debug primitive | Reuses security regs | PMP fault | Bare-metal embedded only | Raven DAC '22 (§1.4) |
| Page-protection watchpoint | Page table permission bit | Page fault + filter + reprotect | Coarse page granularity; scales beyond DR registers | `mprotect`, `VirtualProtect(PAGE_GUARD)`, guard pages (§1.5) |
| Event breakpoint / catchpoint | Runtime event taxonomy | Stop on matching event | Needs language/runtime event IDs, not just PCs | GDB catchpoints, JDWP exception breakpoints, DevTools pause-on-exception (§1.6) |
| Contract violation as semantic breakpoint | Contract metadata/check mode | Predicate evaluation | Needs policy: ignore/observe/enforce/debug | Eiffel, Racket contracts, Rust `debug_assert!`, C++26 contracts (§1.7) |
| Deterministic record + replay | N/A | ~20% recording overhead; replay re-executes from checkpoints | Single-threaded scheduling, CPU counter brittleness | rr, rr.soft (§2.1) |
| Omniscient post-hoc query DB | N/A | Minutes to build, 10s of GB | Not live; post-hoc only | Pernosco (§2.2) |
| Out-of-band production snapshot | N/A | Bounded snapshot collection overhead | Cannot step forward from snapshot; implementation/runtime-specific | VS Snapshot Debugger (§2.3) |
| Full-system icount replay | N/A | 5–10× slowdown under TCG | Whole VM including kernel | QEMU (§2.4) |
| Queryable execution database | N/A | Recording overhead | Windows-centric, object-model UX | WinDbg TTD (§2.5) |
| Terminal session rewind | N/A | Per-step copy on branch | Command-level granularity only | devops-rewind (§2.6) |
| Process checkpoint/restore | Disk + metadata per checkpoint | `ptrace` + parasite/restorer blob | No fine-grained time travel; restore on compatible kernel | CRIU (§2.7) |
| JIT-instrumented record/replay | Cold process | ~2–4× recording slowdown | No PMU dependence; higher overhead than rr | UndoDB / LiveRecorder (§2.8) |
| MPI-aware distributed record/replay | TotalView + replay license | Heavy per-rank record, RDMA-aware | Scales to thousands of ranks; heavy overhead | TotalView ReplayEngine (§2.9) |
| Intel PT ring-buffer + trigger snapshot | Hardware tracing on | 2–10% continuous; snapshot on demand | Intel + Linux only; last ~10 ms only | Magic Trace (§2.10) |
| Fork-checkpoint reverse execution | None outside debugger | Periodic `fork()` checkpoints; memory proportional to CoW divergence; replay-to-target | Bytecode/Unix only (OCaml); predates rr by ~20y | `ocamldebug`, `ocamlearlybird` (§2.11) |
| Trace-as-SQL database | Trace ingested into SQLite tables | Per-query SQL evaluation | Needs trace stored in relational form | Perfetto TraceProcessor + PerfettoSQL (§2.12) |
| Record every assignment | O(writes) storage | Per-assignment write | Not for long-running workloads | ODB (Bil Lewis) (§3.1) |
| Structural-sharing state history | O(delta × steps) | Persistent structure sharing | Post-mortem replay, not live | Toby Ho / JSON-R (§3.2) |
| Immutable-state timeline slider | None unless history retained | Memory proportional to retained states/deltas; replay/render cost on scrub | Cheap with immutable state, but history retention is still bounded by policy | Elm (§3.3) |
| Reflective debugger-as-IDE | Full reflective runtime | Live method edit + frame restart | Requires fully reflective VM | Pharo/Smalltalk (§3.4) |
| Condition/restart system | Zero | Handler runs with signaling frame live | Language-level mechanism, not VM feature | Common Lisp (§3.5) |
| Continuation marks | One allocation per annotated frame | Stack walk on read | Requires first-class stack annotations | Racket (§3.6) |
| Hypervisor EPT hidden hooks | VMX setup | Per-hook VM-exit | Ring -1; Windows + VT-x + EPT | HyperDbg (§3.7) |
| REPL-integrated break + history | Hook points only | Ring-buffer trace record (GHCi) | History replaces missing lexical stack (laziness) | pdb/PuDB, GHCi `:history` / `:back` (§3.8) |
| Bytecode-woven event DB + replay UI | Weaver at class-load | Instrumentation per event | Scale requires distributed DB or commercial scoping | Chronon, TOD, IntelliTrace, RevDebug (§3.9) |
| Decorator-only omniscient trace | `sys.settrace` hook | 10–100× on traced code | One-function scope; no infrastructure | PySnooper, snoop, viztracer (§3.10) |
| Action-log replay over pure state | Action history array | Action re-application on jump | Requires pure reducers + immutable state | Redux DevTools (cf. Elm §3.3) (§3.11) |
| Hot code replacement | Versioned code metadata | Patch + deopt/frame policy | Active-frame migration is hard | Visual Studio Edit and Continue, JVM HotSwap, Erlang, Flutter (§3.12) |
| Post-execution inline visualization | N/A | Full-run recording | No pause/step — post-run only | WhiteBox (§4.1) |
| Timeline scrubber (aspirational) | Full state capture | Viable only at small scale | UX vision, not production | Bret Victor demo (§4.2) |
| Live coding and reactive dataflow environments | Per-cell/static dependency metadata where available | Re-evaluation or watch updates on dependency/runtime change | Observable fits the DAG model; Light Table and Eve are related but different live-programming designs | Observable, Light Table, Eve (§4.3) |
| Dataflow arrows + cross-cell watch | Reactive dependency graph exists | Draw arrows per audit | Visual clutter on complex sheets | Excel Trace Precedents/Dependents + Watch Window, TraceModel (§4.3) |
| In-game replicated debug overlay | Replication cost (already paid) | Per-frame draw on viewport | Debug category coupled to gameplay code | Unreal Gameplay Debugger + Visual Logger (§4.4) |
| Capture-and-inspect GPU frame | On-demand capture | Full frame serialized to disk | Offline only; shader debug info must be preserved | RenderDoc, NSight, PIX — pixel history + shader debugger (§4.5) |
| Live state-machine visualizer | Per-inspection WebSocket | Event-stream dispatch | Requires instrumented runtime | XState / Stately Inspector (§4.6) |
| Shared-memory debug protocol | Memory-mapped buffers | Near-zero IPC latency | Proprietary vs standardized | RemedyBG (§5.1) |
| JSON message debug adapter protocol | Per-message JSON | Higher latency than native APIs | Lowest-common-denominator abstraction | DAP (VS Code, Neovim, Helix, Zed, …) (§5.2) |
| Debugger scripting API | Python import | Per-value callback | Slower than native C++ formatters | GDB Python, LLDB formatters, gdb-dashboard, pwndbg (§5.3) |
| Domain-structured browser protocol | Persistent WebSocket | Per-domain agent dispatch | Runtime-coupled; richer than DAP | Chrome DevTools Protocol (§5.4) |
| Transport-agnostic language-typed protocol | Per-packet command ID | Typed command sets (RedefineClasses, ForceEarlyReturn) | Locked to one language's semantics | JDWP / JPDA / JVMTI (§5.5) |
| Client-vs-platform-authoritative remote | Single TCP session | Per-packet memory/reg access | gdbserver thin vs lldb-server + SBPlatform thick | gdbserver, lldb-server, debugserver (§5.6) |
| Mirror-based reflection | Capability required | Mirror dispatch per meta-op | Language must be designed for it | Newspeak, Self; JDWP/JDI shares the shape (§5.7) |
| Language-specific TCP debug protocol | Zero until client connects | Per-command dispatch, spesh-aware frame reconstruction | Protocol outlives the IDE if upstreamed | MoarVM remote debug (§5.8) |
| Debug expression evaluation | Debug metadata + evaluator | Target calls may mutate/deadlock | Requires safe subset or explicit unsafe evaluation | GDB `print/call`, LLDB expressions, DevTools console, JDWP invoke (§5.9) |
| Retroactive console.log | Deterministic recording/checkpoint infrastructure already paid | Replay/evaluate expression at hit points across checkpoints/forks | Requires upfront deterministic recording | Replay.io (§6.1) |
| Typed holes + live eval | Language-level holes | Per-hole type check | Requires language co-design | Hazel (§6.2) |
| Compile-time macro print | Zero when removed | One formatter call per hit | Source-level only; not toggleable at runtime | Rust `dbg!`, Elixir `dbg/2`, icecream (§6.3) |
| DWARF location expressions | Per-variable location list | O(PC range) lookup | Correctness bugs in optimized code | GCC, LLVM (§7.1) |
| Cross-tier debug info mapping | Per-pass metadata | Propagation cost in every pass | Must be maintained by every compilation pass | LLVM `!dbg`, V8 TurboFan frame state (§7.2) |
| Bytecode↔native source map | Per-bytecode entry | O(1) lookup | Only available where the mapping is emitted | JVM, HotSpot (§7.3) |
| Build-ID-keyed HTTP symbol fetch | Build-ID in ELF | HTTP GET on first use | Network dependency; sanitizer support depends on external symbolizer/distribution configuration | debuginfod + `DEBUGINFOD_URLS` (§7.4) |
| Delta debugging | Test oracle only | Multiple oracle runs; often near-linear/log-like on easy cases, worst-case O(n²) for `ddmin` | Needs fast pass/fail oracle | `git bisect`, `ddmin` (§8.1) |
| Dynamic program slicing | Execution trace | Post-hoc slice computation | Per-input; needs instrumented run | Weiser-derived tools (§8.2) |
| Spectrum-based fault localization | Coverage per test | Per-line scoring | Needs passing + failing tests with coverage | Tarantula, Ochiai, DStar (§8.3) |
| Sparse predicate sampling + population stats | Per-predicate counter + sampling mask | Per-sample increment | Needs many runs; finds bugs no single run can | CBI (Liblit) (§8.4) |
| Delta debugging over program states | Debugger access only | O(log state-diff) test re-runs | Needs comparable passing + failing runs | Zeller cause-effect chains (§8.5) |
| Symbolic execution + SMT | Per-fork state dup | Solver time per branch | Path explosion; every bug comes with reproducer | KLEE, angr, Manticore (§8.6) |
| Fuzzer crash minimization + exploration | Already-fuzzer-instrumented | Seconds-minutes per crash | Needs instrumented build | afl-tmin, AFL `-C`, libFuzzer `-minimize_crash` (§8.7) |
| IR-level UB interpreter | Separate `cargo miri` run | ~100× slowdown | Interpreted; partial UB model | Miri (§8.8) |
| Interrogative debugging (why-did/why-didn't) | Provenance tracking | Slicing + call-graph per question | Needs recorded trace + analysis infrastructure | Whyline — Alice + Java (§8.9) |
| 4-port tracing for nondeterministic control | Port-instrumentation hooks | Per-port trace callback | Requires Byrd-box-aware semantics | Prolog tracers (SWI, SICStus); generalizes to coroutines/effects (§8.10) |
| Declarative / algorithmic debugging | Computation-tree reification | User answers O(log n) yes/no | Requires user to know intended semantics | Shapiro ADP; Mercury declarative debugger (§8.10) |
| Dynamic invariant detection | Instrumented passing runs | Trace values + infer predicates | False positives depend on test quality | Daikon (§8.11) |
| Async stack problem framing | Conceptual: physical stack ≠ logical chain | None (taxonomy) | Reconstruction requires runtime cooperation | (§9.1) |
| Scheduler-event runtime + debugger awareness | Per-goroutine event ring buffer | Native goroutine list/switch | Requires runtime designed for it | Go `runtime/trace`, Delve (§9.2) |
| Coroutine-state metadata + structured-concurrency graph | Continuation captures per suspension | Compiler-emitted metadata read by IDE | Best when concurrency is structured | Kotlin coroutines + Parallel Stacks (§9.3) |
| Stitched async stack traces | Per-await stack snapshot | Bounded record at each suspension | Memory tax at every async hop | V8 / Chrome DevTools (§9.4) |
| Out-of-band task introspection | Per-task tracing instrumentation | Opt-in `console_subscriber` | Runtime-specific; per-runtime tooling | tokio-console (§9.5) |
| Hybrid happens-before + lockset | Shadow memory ~1 byte per byte | ~5–15× slowdown | Only finds races that execute | ThreadSanitizer, Go race detector, Helgrind (§10.1) |
| Systematic schedule exploration | Controlled test scheduler | Many explored interleavings | State-space explosion; needs runtime-owned sync | CHESS, Rust `loom`, FoundationDB simulation (§10.2) |
| Deadlock/liveness wait graph | Runtime wait metadata | Graph update per wait/block | Requires all blocking primitives to be known | JVM thread dumps, Go goroutine dumps, lockdep, tokio-console (§10.3) |
| ELF core + `coredump_filter` | Bitmask + file I/O on crash | One kernel-write | Managed runtimes need runtime-aware dumper | Core dumps, `gcore`, `qSaveCore`, SOS, SA (§11.1) |
| kexec capture kernel + vmcore | Reserved memory at boot | Full RAM snapshot on panic | Kernel-only; dump ≈ RAM (mitigated by `makedumpfile`) | kdump + `crash` + `makedumpfile` + `pstore` (§11.2) |
| Dual-frontend kernel debugger | `CONFIG_KGDB` compiled in | Either deadlock-safe shell or GDB-remote full source | kdb sacrifices DWARF for robustness | KGDB + KDB shared debug core (§11.3) |
| Deferred-format embedded logging | Format strings in `.debug` only | Binary frame + host decode | Requires probe + host-side ELF | defmt + probe-rs + RTT + ITM (§11.4) |
| Hardware probe debugging | Debug port wired in silicon | Halt/resume over JTAG/SWD | Limited breakpoints; no OS services | OpenOCD, CoreSight, probe-rs (§11.5) |
| Production minidump pipeline | Build IDs + unwind metadata | Crash artifact upload + symbolication | Privacy and symbol availability dominate usefulness | Breakpad, Crashpad, Windows minidumps, Sentry (§11.6) |
| Counterexample-trace navigable debugger | Model-checker output | Per-state expression evaluation | Requires finite-state verification tool | TLA+ Toolbox Trace Explorer + TLA+ Debugger (§12.1) |
| Proof-state viewer with diffs | ITP kernel state | Per-tactic diff + widget render | Only meaningful for proof-construction languages | Lean 4 InfoView, Coq goal view, Agda typed holes (§12.2) |

---

## 14. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Breakpoint Mechanisms

1. Eli Bendersky: How Debuggers Work, Part 2: Breakpoints — https://eli.thegreenplace.net/2011/01/27/how-debuggers-work-part-2-breakpoints
2. Debugger Breakpoints via Code Patching — https://devblogs.microsoft.com/oldnewthing/20241111-00/?p=110503
3. Chris Wellons: Two Handy GDB Breakpoint Tricks — https://nullprogram.com/blog/2024/01/28/
4. Tristan Hume: Tracing Methods (hardware breakpoints section) — https://thume.ca/2023/12/02/tracing-methods/
5. Raven: RISC-V PMP as Debugging Primitive — https://fengweiz.github.io/paper/raven-dac22.pdf
6. Linux `mprotect(2)` — https://man7.org/linux/man-pages/man2/mprotect.2.html
7. Windows Guard Pages — https://learn.microsoft.com/en-us/windows/win32/memory/creating-guard-pages
8. GDB Set Catchpoints — https://sourceware.org/gdb/current/onlinedocs/gdb.html/Set-Catchpoints.html
9. Chrome DevTools Protocol Debugger Domain — https://chromedevtools.github.io/devtools-protocol/tot/Debugger/
10. Racket Contracts — https://docs.racket-lang.org/guide/contracts.html
11. Eiffel Design by Contract — https://www.eiffel.org/doc/eiffel/ET-_Design_by_Contract_%28tm%29%2C_Assertions_and_Exceptions
12. C++ Contract Assertions — https://cppreference.dev/w/cpp/language/contracts

### Chapter 2 — Record and Replay

1. rr: Record and Replay Framework — https://rr-project.org/
2. Deterministic Record-and-Replay (ACM Queue) — https://queue.acm.org/detail.cfm?id=3688088
3. Pernosco Omniscient Debugger — https://pernos.co/
4. Robert O'Callahan: Advanced Debugging Technology — https://robert.ocallahan.org/2024/10/debt-workshop.html
5. Visual Studio Snapshot Debugger — https://devblogs.microsoft.com/visualstudio/snapshot-debugging-with-visual-studio-2017-now-ready-for-production/
6. QEMU Record/Replay — https://www.qemu.org/docs/master/devel/replay.html
7. WinDbg Time Travel Debugging Overview — https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/time-travel-debugging-overview
8. WinDbg Time Travel Debugging Object Model — https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/time-travel-debugging-object-model
9. WinDbg TTD Memory Objects — https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/time-travel-debugging-memory-objects
10. devops-rewind — https://dev.to/lakshmisravyavedantham/i-built-a-terminal-session-debugger-with-rewind-breakpoints-and-branching-3gka
11. CRIU — Checkpoint/Restore In Userspace — https://criu.org/Main_Page
12. CRIU Assisted Debugging — https://criu.org/Assisted_debugging
13. UndoDB (Undo.io) — https://undo.io/products/udb/
14. Getting Started with UDB — https://docs.undo.io/GettingStartedWithUDB.html
15. TotalView ReplayEngine — https://help.totalview.io/classicTV/current/HTML/Splash/tvgettingstartedug-gettingStarted.3.30.html
16. TotalView Using ReplayEngine with Infiniband MPIs — https://help.totalview.io/previous_releases/2024.2/HTML/TotalView/totalviewlhug-parallel-debugging-setup.19.46.html
17. Jane Street Magic Trace — https://github.com/janestreet/magic-trace
18. Tristan Hume: Magic-trace blog post — https://blog.janestreet.com/magic-trace/
19. OCaml Manual — The Debugger (`ocamldebug`) — https://ocaml.org/manual/5.3/debugger.html
20. Perfetto: Getting Started with PerfettoSQL — https://perfetto.dev/docs/analysis/perfetto-sql-getting-started
21. Perfetto: PerfettoSQL Syntax — https://perfetto.dev/docs/analysis/perfetto-sql-syntax

### Chapter 3 — Omniscient / Time-Travel Debugging

1. Bil Lewis: Omniscient Debugging — https://omniscientdebugger.github.io/
2. Toby Ho: Time Traveling Debugger — https://www.tobyho.com/video/Time-Traveling-Debugger-Part-1.html
3. Pharo — https://pharo.org/
4. Pharo DNU and Debugger (Stack Overflow) — https://stackoverflow.com/questions/54496857/how-does-pharo-starts-debugger-when-message-is-not-understanded
5. Common Lisp Condition System — https://lisp-docs.github.io/docs/tutorial/conditions
6. Racket Continuation Marks (dissertation) — https://www2.ccs.neu.edu/racket/pubs/dissertation-clements.pdf
7. SRFI 157: Continuation Marks — https://srfi.schemers.org/srfi-157/srfi-157.html
8. HyperDbg: Reinventing Hardware-Assisted Debugging — https://misc0110.net/files/hyperdbg_ccs22.pdf
9. HyperDbg EPT Hook Documentation — https://docs.hyperdbg.org/commands/extension-commands/epthook
10. HyperDbg Documentation Repository — https://github.com/HyperDbg/docs
11. Elm: Time Travel made Easy — https://elm-lang.org/news/time-travel-made-easy
12. Python `pdb` — https://docs.python.org/3/library/pdb.html
13. PuDB Console Debugger — https://documen.tician.de/pudb/index.html
14. Marlow et al.: A Lightweight Interactive Debugger for Haskell (GHCi) — https://simonmar.github.io/bib/papers/ghci-debug.pdf
15. Chronon — Time Travelling Debugger (JVMLangSummit) — https://wiki.jvmlangsummit.com/Chronon_-_Time_Travelling_Debugger
16. TOD — Omniscient Debugging (Pleiad, Pothier & Tanter) — https://pleiad.cl/tod/
17. Microsoft IntelliTrace Documentation — https://learn.microsoft.com/en-us/visualstudio/debugger/intellitrace
18. RevDebug — Flight Recorder for Your Code — https://revdebug.com/
19. alexmojaki/snoop — https://github.com/alexmojaki/snoop
20. PySnooper (Ram Rachum) — https://pypi.org/project/PySnooper/
21. VizTracer Documentation — https://viztracer.readthedocs.io/en/latest/viztracer.html
22. Redux DevTools — https://github.com/reduxjs/redux-devtools
23. Visual Studio Edit and Continue — https://learn.microsoft.com/en-us/visualstudio/debugger/edit-and-continue
24. JPDA Enhancements: HotSwap / Class Redefinition — https://docs.oracle.com/javase/8/docs/technotes/guides/jpda/enhancements1.4.html
25. Flutter Hot Reload — https://docs.flutter.dev/tools/hot-reload

### Chapter 4 — Live Visualization

1. WhiteBox Live Visualizer — https://whitebox.systems/
2. Bret Victor: Inventing on Principle — https://vimeo.com/36579366
3. Light Table — http://lighttable.com/
4. Realizing Light Table (Eve retrospective) — https://witheve.com/deepdives/lighttable.html
5. Observable Minimap — https://observablehq.com/documentation/debugging/minimap
6. Unreal Gameplay Debugger — https://dev.epicgames.com/documentation/en-us/unreal-engine/using-the-gameplay-debugger-in-unreal-engine
7. Excel: Display the Relationships Between Formulas and Cells — https://support.microsoft.com/en-us/office/display-the-relationships-between-formulas-and-cells-a59bef2b-3701-46bf-8ff1-d3518771d507
8. RenderDoc Shader Debugging — https://renderdoc.org/docs/how/how_debug_shader.html
9. NVIDIA Nsight Graphics Shader Debugger Setup — https://docs.nvidia.com/nsight-graphics/UserGuide/shader-debugger-setup.html
10. Stately Inspector (XState) — https://stately.ai/docs/inspector
11. statelyai/inspect (GitHub) — https://github.com/statelyai/inspect

### Chapter 5 — Debugger-as-Service — Transport Protocols

1. RemedyBG Debug Protocol — https://remedybg.handmade.network/blog/p/3631-remedybgs_debug_protocol
2. Debug Adapter Protocol — https://microsoft.github.io/debug-adapter-protocol/
3. DAP Suitability for DSLs (Enet et al., 2023) — https://hal.science/hal-04245594v1/document
4. LLDB Variable Formatting (summaries, filters, synthetic children) — https://lldb.llvm.org/varformats.html
5. gdb-dashboard — https://github.com/cyrus-and/gdb-dashboard
6. pwndbg — https://github.com/pwndbg/pwndbg
7. Chrome DevTools Protocol — https://chromedevtools.github.io/devtools-protocol/
8. Chromium DevTools Protocol Architecture — https://chromium.googlesource.com/devtools/devtools-frontend/+/main/docs/devtools-protocol.md
9. Java Debug Wire Protocol (JDWP) Specification — https://docs.oracle.com/en/java/javase/24/docs/specs/jdwp/jdwp-spec.html
10. Java Platform Debugger Architecture (JPDA) Structure Overview — https://docs.oracle.com/en/java/javase/21/docs/specs/jpda/architecture.html
11. LLDB Remote Debugging — https://lldb.llvm.org/use/remote.html
12. GDB Remote Connection and Packets — https://www.sourceware.org/gdb/onlinedocs/gdb/Connecting.html
13. Bracha & Ungar: Mirrors — Design Principles for Meta-level Facilities (OOPSLA 2004) — https://bracha.org/mirrors.pdf
14. Bracha: The Newspeak Programming Platform — https://bracha.org/newspeak.pdf
15. Comma IDE features — https://commaide.com/features
16. Comma IDE FAQ — https://commaide.com/faq
17. GDB Expressions — https://sourceware.org/gdb/current/onlinedocs/gdb.html/Expressions.html
18. LLDB Tutorial — https://lldb.llvm.org/use/tutorial.html

### Chapter 6 — Retroactive and Partial Evaluation

1. Replay.io Time Travel Debugger — https://docs.replay.io/time-travel-intro/add-console-logs-on-the-fly
2. Replay.io How Time Travel Works — https://docs.replay.io/basics/time-travel/how-does-time-travel-work
3. Hazel Live Programming — https://hazel.org/
4. Hazel: Live Functional Programming with Typed Holes — https://arxiv.org/abs/1805.00155
5. Rust `dbg!` Macro — https://doc.rust-lang.org/std/macro.dbg.html
6. Using Elixir's `dbg/2` (German Velasco) — https://www.germanvelasco.com/blog/using-dbg-to-replace-io-inspect-and-pry-into-code
7. icecream (Python + community ports) — https://github.com/gruns/icecream

### Chapter 7 — DWARF Debug Information and Optimized-Code Challenges

1. DWARF Debugging Format Introduction — https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
2. Debug Information Validation for Optimized Code (Li et al., PLDI 2020) — https://faculty.cc.gatech.edu/~qzhang414/papers/pldi20_yuanbo1.pdf
3. Where Did My Variable Go? (Assaiante et al., 2022) — https://export.arxiv.org/pdf/2211.09568v1.pdf
4. Apache Harmony: Breakpoints and Single Step in JIT Mode — https://harmony.apache.org/subcomponents/drlvm/breakpoints_and_ss.html
5. Debuginfod (elfutils) — https://sourceware.org/elfutils/Debuginfod.html
6. GDB Debuginfod Support — https://sourceware.org/gdb/onlinedocs/gdb/Debuginfod.html

### Chapter 8 — Automated Fault Isolation

1. Delta Debugging (The Debugging Book) — https://www.debuggingbook.org/html/DeltaDebugger.html
2. Delta Debugging original paper (Zeller & Hildebrandt) — https://www.cs.purdue.edu/homes/xyzhang/fall07/Papers/delta-debugging.pdf
3. Program Slicing — https://en.wikipedia.org/wiki/Program_slicing
4. Program Slicing survey (Harman) — http://www0.cs.ucl.ac.uk/staff/mharman/sf.html
5. Tarantula Fault Localization — https://dl.acm.org/doi/10.1145/1101908.1101949
6. Tarantula slides (GaTech) — https://faculty.cc.gatech.edu/~harrold/6340/cs6340_fall2009/Slides/class20.pdf
7. Liblit: Cooperative Bug Isolation (dissertation, 2004) — https://pages.cs.wisc.edu/~liblit/dissertation/
8. Liblit, Naik, Zheng, Aiken, Jordan: Scalable Statistical Bug Isolation (PLDI 2005) — https://pages.cs.wisc.edu/~liblit/pldi-2005/
9. Zeller: Isolating Cause-Effect Chains from Computer Programs (FSE 2002) — https://www.st.cs.uni-saarland.de/papers/fse2002/
10. Zeller: Cause-Effect Chains paper PDF — https://www.cs.umd.edu/~atif/zeller.pdf
11. KLEE Documentation — https://klee.github.io/docs/
12. Cadar, Dunbar, Engler: KLEE (OSDI 2008) — https://llvm.org/pubs/2008-12-OSDI-KLEE.pdf
13. AFL: Fuzzing, Crash Triage, `-C` Crash Exploration — https://afl-1.readthedocs.io/en/latest/fuzzing.html
14. Reproducing Crashes from ClusterFuzz (libFuzzer `-minimize_crash`) — https://chromium.googlesource.com/chromium/src/+/main/testing/libfuzzer/reproducing.md
15. Miri — https://github.com/rust-lang/miri
16. Miri: MIR Interpreter and UB Detector (DeepWiki) — https://deepwiki.com/rust-lang/rust/6.2-miri:-mir-interpreter-and-ub-detector
17. Ko & Myers: Designing the Whyline (CHI 2004) — https://faculty.washington.edu/ajko/papers/Ko2004Whyline.pdf
18. Ko & Myers: Debugging Reinvented — the Java Whyline (ICSE 2008) — https://www.cs.cmu.edu/~NatProg/papers/Ko2008JavaWhyline.pdf
19. SWI-Prolog: The Byrd Box Model and Ports — https://swish.swi-prolog.org/pldoc/man?section=byrd-box-model
20. Shapiro: Algorithmic Program Debugging (archive of the debugger code) — http://www.cs.cmu.edu/Groups/AI/lang/prolog/code/debug/shapiro/0.html
21. Daikon Dynamic Invariant Detector — https://plse.cs.washington.edu/daikon/
22. Daikon Publications — https://plse.cs.washington.edu/daikon/pubs/

### Chapter 9 — Async & Coroutine Debugging

1. Go Delve Debugger — https://github.com/go-delve/delve
2. Go `runtime/trace` package documentation — https://pkg.go.dev/runtime/trace
3. Kotlin Parallel Coroutine Stacks — https://kotlinfoundation.org/news/gsoc-2023-parallel-stacks/
4. Chrome DevTools — modern web debugging (async stacks) — https://developer.chrome.com/blog/devtools-modern-web-debugging/
5. tokio-console — https://github.com/tokio-rs/console
6. Tokio blog — Announcing tokio-console — https://tokio.rs/blog/2021-12-announcing-tokio-console

### Chapter 10 — Concurrency-Aware Debuggers

1. Serebryany & Iskhodzhanov: ThreadSanitizer (Google Research) — https://research.google.com/pubs/archive/35604.pdf
2. ThreadSanitizer Detectable Bugs (google/sanitizers wiki) — https://github.com/google/sanitizers/wiki/ThreadSanitizerDetectableBugs
3. Microsoft CHESS — https://www.microsoft.com/en-us/research/project/chess/
4. Rust `loom` — https://github.com/tokio-rs/loom
5. FoundationDB Deterministic Simulation Testing — https://apple.github.io/foundationdb/testing.html
6. Java Troubleshooting: Thread Dumps — https://docs.oracle.com/javase/8/docs/technotes/guides/troubleshoot/tooldescr034.html
7. Go Diagnostics — https://go.dev/doc/diagnostics
8. Linux Lockdep Design — https://docs.kernel.org/locking/lockdep-design.html

### Chapter 11 — Post-Mortem and Out-of-Process Debugging

1. GDB Core File Generation — https://www.sourceware.org/gdb/onlinedocs/gdb/Core-File-Generation.html
2. LLDB Core Dump Support Improvements (moritz.systems) — https://www.moritz.systems/blog/lldb-core-dump-support-improvements/
3. Linux kdump Administration Guide — https://www.kernel.org/doc/html/v5.19/admin-guide/kdump/kdump.html
4. kdump + crash: Linux Kernel Internals — https://kernel-internals.org/debugging/kdump/
5. Linux KGDB + KDB Documentation — https://www.kernel.org/doc/html/latest/process/debugging/kgdb.html
6. knurling-rs/defmt — https://github.com/knurling-rs/defmt
7. probe-rs Documentation — https://probe.rs/docs
8. OpenOCD User Guide — https://openocd.org/doc/html/index.html
9. ARM Debug Interface Architecture Specification — https://developer.arm.com/documentation/ihi0031/latest/
10. Google Breakpad — https://chromium.googlesource.com/breakpad/breakpad
11. Google Crashpad — https://chromium.googlesource.com/crashpad/crashpad
12. Windows Minidump Files — https://learn.microsoft.com/en-us/windows/win32/debug/minidump-files

### Chapter 12 — Specification-Level Debugging

1. Learn TLA+: Using the Toolbox (Error Traces and Trace Explorer) — https://learntla.com/topics/toolbox.html
2. TLA+ Debugger: Interactive State-Space Exploration — https://discuss.tlapl.us/msg06620.html
3. Nawrocki et al.: An Extensible User Interface for Lean 4 (ITP 2023) — https://drops.dagstuhl.de/opus/volltexte/2023/18399/pdf/LIPIcs-ITP-2023-24.pdf
4. leanprover/vscode-lean4 InfoView Manual — https://github.com/leanprover/vscode-lean4

