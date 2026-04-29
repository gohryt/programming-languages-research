# Tracers

Research on observability, tracing, profiling, instrumentation, and runtime event pipelines — the "always-on" side of runtime introspection, as distinct from pause-and-inspect debugging.

Tracers favor structured event emission, low per-event overhead, and production safety over interactive stepping. User-facing debuggers (breakpoints, record/replay, time-travel, DWARF location tracking) are in `DEBUGGERS.md`; breakpoint-like systems appear here only when their patching or probe machinery is useful for tracing. Runtime concurrency mechanisms — schedulers, tasks, actors, channels, cancellation, STM, and I/O blocking boundaries — live in `CONCURRENCY.md`; this document covers only the event schemas, probes, buffers, sampling, and visualization needed to observe them. Memory disciplines and runtime memory architectures — GC, allocators, ownership, regions, hardware tagging, concurrent reclamation — are in `MEMORY.md`; memory-specific tracing mechanisms (heap snapshots, allocation sampling) currently live alongside their host event-pipeline entries in this document rather than being split out. Parser and compiler internals are in `PARSERS.md` and `COMPILERS.md`. Module systems, package identity, and dynamic module loading are in `MODULES.md`.

---

## 1. Bytecode and Code Patching

Mechanisms that modify the target program's instruction stream — bytecode, native code, or both — to install a probe at a specific site. The common axis across the entries below is the cost when a probe is *not* installed: a reserved NOP, a predicted short jump, a single-byte flag read, or literally nothing. Debugger breakpoints use many of the same tricks, but this chapter focuses on the patch-site and disabled-overhead design that tracing systems can reuse.

### 1.1. Luau — LOP_BREAK

Luau (Roblox's Lua fork) rejects the standard Lua `debug.sethook()` model because a hook check on every instruction, line, or function entry creates a global tax even when no tool is active. Instead, it treats observation as bytecode patching: the target opcode is replaced with `LOP_BREAK`, while a parallel `debuginsn[]` array stores the original instruction for restoration.

The tracing lesson is the disabled-overhead model, not the debugger UI: do not add a branch to every interpreter dispatch just because some instructions might be observed later. Patch only the requested sites, keep the normal bytecode stream identical when no probe is active, and pay dispatch cost only at enabled probes.

Source: https://luau.org/performance/ — "Epsilon-overhead debugger" section.

### 1.2. Erlang BeamAsm — Jump Target Patching

Erlang's BeamAsm JIT emits a tiny function prologue with a predicted jump over a shared instrumentation fragment. Normal execution pays one predictable branch; enabling observation changes a jump offset so control falls through to the fragment. Because the patch is a single byte on x86, it can be installed cheaply, and BeamAsm's W^X-compatible dual mapping lets writes go through a writable alias while execution uses the executable alias.

For tracing, the transferable idea is a compact per-function patch site with a shared slow path. The debugger-specific breakpoint semantics belong in `DEBUGGERS.md`; the tracing-relevant property is that function-entry observation can be enabled without rewriting whole functions or leaving a global hot-path hook active.

Sources: https://www.erlang.org/doc/apps/erts/beamasm — "Tracing and NIF Loading" section.

### 1.3. Linux ftrace / eBPF — NOP-to-CALL Patching

Linux function tracing is built around compiler-emitted patch points, but the exact mechanism varies by kernel version, architecture, and configuration. Historically ftrace used `-pg`/`mcount`; modern kernels commonly use `__fentry__`, dynamic ftrace, and related patchable-entry schemes. When tracing is disabled, a call site is patched to a NOP; when enabled, it is patched to call a trampoline. `text_poke()` and architecture-specific machinery handle instruction-cache coherency and cross-CPU synchronization.

eBPF uses several different attachment mechanisms rather than one universal NOP-to-CALL path. BPF fentry/fexit attaches near function entry/exit through BPF trampolines and is much cheaper than kprobes, which rely on breakpoint-style instrumentation. Static tracepoints are a separate facility, commonly implemented with tracepoint call sites, static keys, and per-tracepoint metadata rather than the same function-entry patch as ftrace. The taxonomy of static tracepoints, kprobes, kretprobes, and BPF fentry/fexit is separated in §1.11.

The disabled cost is best described as near-zero dispatch overhead, not literally zero: NOP sites still consume code bytes and can affect layout, I-cache pressure, and decode bandwidth. Even so, patchable instrumentation is the gold standard for "almost free when off, cheap when on" tracing and has been battle-tested across billions of machines.

Source: https://docs.ebpf.io/linux/concepts/trampolines/

### 1.4. Wasmtime — NOP Padding with INT 3 Replacement

Wasmtime's Winch baseline compiler reserves patch space by inserting a `nop` between native-code fragments corresponding to WebAssembly instructions. A tool can replace that reserved byte with a trap instruction and recover the Wasm instruction from side metadata.

Same principle as ftrace, applied to JIT-compiled code: reserve cheap patch sites while generating code, keep them inert when no tool is active, and use side tables to map patched native locations back to language-level positions.

Source: https://hackmd.io/@hvqFkDgPTuGNcu-NiycXZQ/SyXX166Yp

### 1.5. DTrace USDT — Is-Enabled Probes

DTrace's User Statically Defined Tracing (USDT) probes allow application developers to place trace points in their code with very low disabled overhead. A USDT probe is a static probe site described by metadata so a tracing subsystem can find it, enable it, and collect its arguments when active. On many systems the inactive probe site is a NOP-like instruction sequence or otherwise arranged so the common path avoids the expensive tracing work.

`is-enabled` probes are a related but distinct facility: they let user code cheaply ask whether a probe is active before constructing expensive arguments. That guard prevents wasted formatting, allocation, or data copying when no tracer is listening. Implementations differ in whether the guard is a memory load, a branch, a patched instruction, or a provider-specific fast path.

The key design pattern is stable across implementations: separate the "is anyone listening?" check from the "prepare and emit probe data" work. The expensive part only runs when the probe is active. This two-phase pattern — cheap guard, expensive payload — appears in almost every high-performance tracing system.

Source: https://blogs.oracle.com/linux/from-kernel-to-user-space-tracing

### 1.6. Trapless Kernel Probes (USENIX ATC 2024)

Standard Kprobes in Linux rely heavily on double traps, leading to severe penalties that prevent efficient kernel instrumentation on a large scale. IBM Research developed a trapless kernel probing mechanism that applies strategically placed NOPs, slightly modifying the code layout to bypass the typical restrictions of probe optimization. This yields a 10x improvement over standard Kprobes while preserving performance across 96% of the kernel code.

Source: https://research.ibm.com/publications/fast-trapless-kernel-probes-everywhere

### 1.7. eBPF uprobes — Near-Zero-Disabled-Overhead User-Space Monitoring

While kernel probes trace the OS, `uprobes` attach to user-space functions, offering near-zero overhead when no probe is attached. When enabled, they are commonly trap/breakpoint-style dynamic probes rather than the same NOP-to-CALL patching mechanism used by ftrace function entry. This is highly effective for profiling closed-source drivers like NVIDIA's CUDA Runtime API (`libcudart.so`). Tools can trace exact function arguments and timing (e.g., `cuMemAlloc`, `cuLaunchKernel`) using `uprobe` and `uretprobe` directly from user space without modifying the target process or requiring a context switch to a traditional debugger.

Source: https://medium.com/@kcl17/inside-cuda-building-ebpf-uprobes-for-gpu-monitoring-449519b236ed

### 1.8. ftrace function_graph — Return-Trampoline Call Trees

§1.3 describes how ftrace patches a NOP at function entry into a CALL into a trampoline — enough to trace function *entry*. The `function_graph` tracer takes this further and emits an indented, C-like call tree with per-function durations, without needing a second patch site for returns. The trick is the **return trampoline**: on entry, ftrace records the current timestamp and **overwrites the caller's return address on the stack** with the address of a ftrace-owned trampoline. When the instrumented function returns, control lands in the trampoline instead of the real caller; the trampoline records the exit timestamp, restores the true return address from its own shadow stack, and jumps to it.

The consequence is that ftrace can produce entry+exit pairs for *every* kernel function with only one patch site per function (the entry NOP of §1.3). The return side is a runtime stack manipulation — no per-call-site patching, no per-function trampoline, one shared return handler for the whole kernel. The shadow-stack storage is per-task and bounded by current call depth, so the memory cost scales with concurrency, not with binary size.

The design pattern is broadly useful: whenever a tracer needs paired entry/exit events but can only afford to patch one location, **hijack the return address and share a single return handler**. The same pattern appears in user-space profilers (e.g., uftrace's `-P funcgraph`), which is what makes `function_graph`-style output — timed, indented call trees — a tooling category of its own, distinct from both flat samplers (§11.3) and event streams (§3).

Sources: https://docs.kernel.org/trace/ftrace.html and https://lwn.net/Articles/370423/

### 1.9. eBPF CO-RE — Load-Time Offset Relocation via BTF

Every eBPF tracer that reads kernel data structures — bpftrace (§3.6), Parca (§14.3), Pyroscope, bcc's modern tool suite — depends on knowing the offset of each field it reads. Kernel struct layouts change across versions; a program compiled against one kernel's headers would read wrong offsets on another. Pre-CO-RE, the only workable answer was **BCC's runtime-compilation model**: ship a ~100 MB `clang` toolchain plus kernel-headers package with every tool, compile the BPF program on the target host at tool startup to burn in the right offsets for *this* kernel. Slow (seconds of `clang` per invocation), fat (unusable on minimal production images), and fragile (needed matching kernel-headers).

**CO-RE (Compile Once — Run Everywhere)**, driven by Andrii Nakryiko's libbpf work in 2019–2020, replaced this with load-time relocation against **BTF (BPF Type Format)**. BTF is a deduplicated type-info section (`.BTF` in vmlinux, exposed at `/sys/kernel/btf/vmlinux`) describing every struct layout of the *running* kernel, generated at kernel build time by `pahole` lifting DWARF into the compact BTF encoding. A BPF object file carries its own BTF plus a CO-RE relocation table. At `BPF_PROG_LOAD` time, libbpf walks the relocation table, matches each local type descriptor against the running kernel's BTF, computes the actual field offset, and **patches the `ldx`/`stx` instructions in place** before handing the program to the verifier.

The payoff is a one-shot relocation with zero steady-state tax: the relocated program then executes as ordinary BPF code at its chosen attachment point, with normal memory loads and no per-event version dispatch or offset-lookup cost. Portability is *field-level*: the loader can adjust offsets, bitfield positions, array indices, and even widen or narrow load sizes. It cannot invent missing fields — those require `bpf_core_field_exists()` guards in the program source — but for everything short of that it is transparent.

The broader consequence is an entire tooling category becoming viable. Distributable precompiled BPF binaries (the modern bcc tools, Parca Agent, Pyroscope eBPF profiler) only became practical once CO-RE removed the runtime-clang dependency; bpftrace one-liners became kernel-version-portable for the same reason. For a new language targeting kernel observability, CO-RE demonstrates a reusable pattern: **ship a compact typed description of the target alongside the emitted code, and let the loader patch the offsets**. The same idea can generalize to userspace uprobes where equivalent type metadata is available for the target binary, and to any instrumentation surface whose layout drifts across versions.

Sources: https://facebookmicrosites.github.io/bpf/blog/2020/02/19/bpf-portability-and-co-re.html and https://nakryiko.com/posts/bpf-core-reference-guide/ and https://docs.kernel.org/bpf/btf.html and https://www.brendangregg.com/blog/2020-11-04/bpf-co-re-btf-libbpf.html

### 1.10. LLVM XRay — Compiler-Inserted Patchable Function Sleds

LLVM XRay is the compiler-toolchain version of the same "zero when off, patch when on" design. When a program is compiled with `-fxray-instrument`, LLVM inserts patchable sleds into selected functions and emits an `xray_instr_map` section that describes where those sleds live. The runtime library can then patch individual sleds into calls to XRay trampolines, or unpatch them back to no-ops, without rebuilding the binary.

The important difference from ad-hoc function instrumentation is that XRay makes traceability an explicit ABI between the compiler and the runtime. The compiler decides which functions are eligible, lays down enough bytes to patch safely, and records a compact map from code locations to instrumentation points. The runtime owns the policy: patch everything before `main`, patch a selected function at runtime, sample a subset of functions, or emit only custom typed events.

XRay supports multiple instrumentation kinds: function entry, function exit, tail-call handling on supported architectures, and user-defined `custom` / `typed` event points. The default "basic" mode records entry/exit events into trace files for later analysis with `llvm-xray`, while the runtime API exposes finer-grained patching such as `__xray_patch_function()` for targeted tracing.

For a new language, the reusable lesson is direct: **reserve patchable trace sleds in generated code and emit a side table that lets the runtime patch them selectively**. This gives the language an always-available production tracing surface without forcing every function call through a hook check.

Sources: https://llvm.org/docs/XRay.html and https://llvm.org/docs/XRayExample.html and https://llvm.org/doxygen/XRayInstrumentation_8cpp_source.html

### 1.11. Linux kprobes, kretprobes, TRACE_EVENT, and BPF fentry/fexit

The Linux tracing stack is easiest to understand as a taxonomy of probe stability and cost. `TRACE_EVENT` static tracepoints are deliberate semantic events placed by kernel developers — `sched_switch`, block I/O events, syscall events — with stable names and structured fields. They are the production-friendly surface: a tool can depend on the event contract rather than reverse-engineering implementation details.

`kprobes` and `kretprobes` are the opposite end of the spectrum: dynamic probes attached to arbitrary kernel instruction addresses or function returns. They are excellent for one-off investigation because they require no source change and no pre-existing tracepoint, but their contract is unstable: function names, argument registers, inlining, and instruction layouts can change across kernel versions. Traditional kprobes also pay trap overhead, which is why optimized kprobes, ftrace integration, and trapless probes (§1.6) exist.

BPF `fentry` and `fexit` are the modern low-overhead middle ground. They attach eBPF programs to kernel function entry/exit paths using ftrace-style patching and BTF type metadata. Compared with kprobes, they avoid the INT 3 trap path and can expose typed arguments to the verifier and the BPF program. Compared with static tracepoints, they can target many functions that were never annotated as official events.

The language-runtime analogue is valuable. A runtime should distinguish **stable semantic tracepoints** from **unstable implementation probes**. Stable events are for production tools and compatibility promises; implementation probes are for experts diagnosing a specific build. A typed metadata format, like BTF, can make both safer by letting trace programs read arguments and fields by type rather than by guessed offsets.

Sources: https://docs.kernel.org/trace/kprobetrace.html and https://docs.kernel.org/trace/events.html and https://docs.kernel.org/bpf/btf.html and https://docs.ebpf.io/linux/program-type/BPF_PROG_TYPE_TRACING/

---

## 2. Cooperative Safepoints and Managed Handoff

The runtime does not trap at arbitrary instructions; instead it arranges for threads to notice a handoff request at points already safe for the implementation — a loop back-edge, a method boundary, an existing branch the interpreter already takes. The cost axis is the size of the hot-path check, weighed against what it enables: GC, low-intrusion attach, profiler coordination, or runtime-owned sampling. Debugger attach is one consumer; the tracing concern is how to add cooperative observation without biasing profiles or taxing every instruction.

### 2.1. HotSpot JVM — Safepoint Polling Page

HotSpot JIT-compiles Java methods into native x86 code. At certain "safepoint" locations (method returns, loop back-edges), the compiled code includes a load from a fixed "polling page" address:

```
test eax, [polling_page]
```

During normal execution the page is readable, the load succeeds silently (~1 cycle, always predicted to not fault), and execution continues. When the JVM needs to pause all threads (for GC, deoptimization, or debugger attachment), it calls `mprotect(polling_page, PROT_NONE)`. Every thread's next safepoint poll triggers a SIGSEGV. The JVM's signal handler recognizes the faulting address as the polling page and suspends the thread.

A cached memory load is very cheap on modern CPUs, and the "should I stop?" check is not a branch at all — it is a load that either succeeds silently or faults. The hardware handles the rare case (fault) outside the common execution path. This makes polling-page safepoints a classic low-overhead design on x86, though exact performance depends on microarchitecture and HotSpot implementation details.

The downside: signal handling is expensive when it fires (~microseconds per thread). But since it only fires for rare events (GC, debugger attach), the amortized cost is negligible.

Source: https://shipilev.net/jvm/anatomy-quarks/22-safepoint-polls/

### 2.2. CPython 3.14 — PEP 768 Safe External Debugger Interface

CPython's traditional `sys.settrace()` has measurable overhead even when idle, because the interpreter's evaluation loop must check tracing state on every instruction. PEP 768 introduces a lower-overhead handoff path: a pending-call flag is checked through the existing `eval_breaker` branch, which the interpreter already uses for signals and periodic work.

The tracing lesson is the piggybacked safepoint check. Instead of adding a new branch to every bytecode dispatch or injecting code at arbitrary PCs, the runtime exposes a cooperative rendezvous point that external tools can arm. The interpreter then performs the requested work at the next safe opportunity. PyPy independently adopted the same shape, suggesting the pattern generalizes beyond CPython.

Source: https://peps.python.org/pep-0768/

### 2.3. Rust `zerogc` — Compile-Time Root Tracking via the Borrow Checker

`zerogc` is an experimental Rust project that offloads GC root tracking to the compiler: lifetimes and the borrow checker enforce safepoints and root visibility statically, so pointer mutation has zero steady-state cost and tracing overhead between safepoints is strictly zero. The broader compile-time GC-root-tracking discipline overlaps with ownership/borrowing in `MEMORY.md §1`; this entry stays self-contained for now and is recorded here because the resulting safepoint shape is the cooperative-handoff pattern of this chapter.

Sources: https://docs.rs/zerogc and https://github.com/DuckLogic/zerogc

### 2.4. Safepoint Bias and `AsyncGetCallTrace`

Safepoint polling (§2.1) is elegant as a stop-the-world mechanism, but it quietly breaks sampling profilers. Mytkowicz et al. ("Evaluating the Accuracy of Java Profilers", PLDI 2010) showed that four commercial Java profilers (hprof, xprof, JProfiler, YourKit) *disagree with each other* on which method is hottest, and traced the disagreement to a shared root cause: the standard JVMTI `GetStackTrace` API can only sample threads parked at safepoints. A SIGPROF tick queues a "please come to a safepoint" request; the next safepoint-reaching instruction is what gets sampled. Tight inner loops that don't cross a safepoint never appear in the profile — their time is attributed to whichever method *did* reach a safepoint next. The sampling distribution is structurally non-uniform.

**`AsyncGetCallTrace` (AGCT)** is Sun's undocumented back-door, exported so their own Studio profiler could sample outside safepoints. It walks Java frames directly from a signal handler, *without* the safepoint handshake — hence *async*, hence can crash if the JVM mutates the stack mid-walk. Andrei Pangin's **async-profiler** productionized it by installing a SIGSEGV handler, catching AGCT's failure cases, and chaining to the JVM's own deoptimization handler. Its other design trick is merging two sources: `perf_events` gives the native stack (kernel → libjvm → JIT code); AGCT gives the Java frames (including inlined methods). async-profiler walks the native stack until it hits JIT territory, then hands off to AGCT — one unified flame graph across kernel, JNI, JVM internals, and Java.

**JEP 509 "JFR CPU-Time Profiling" (JDK 25, 2025)** is OpenJDK's supported path toward reducing this reliance on unsupported internals. Status (JDK 25, 2025): experimental and Linux-focused, not a universal replacement for every AGCT use case. JFR grows a CPU-time sampler driven by `SIGEV_THREAD_ID` POSIX per-thread CPU timers and reports failed/lost samples explicitly, so an incomplete profile is *visibly* incomplete rather than silently biased. The JEP explicitly names async-profiler's reliance on unsupported internals as motivation.

For a new language: design the async-safe stack-walk API *up front*. Retrofitting it cost OpenJDK roughly 15 years of tool-author workarounds. Go (§3.5) sidestepped the same problem by pairing unconditional frame pointers with Go 1.14's asynchronous preemption — SIGPROF samples can now land anywhere, not just at cooperative safepoints.

Safepoint bias is the *software* instance of a more general pattern: *the sample's reported PC is not the PC that caused the event*. The *hardware* instance is PMU interrupt skid, where the pipeline has moved on by the time a counter-overflow interrupt fires — addressed by PEBS / IBS / SPE (§5.5). A new language needs both problems solved: async-safe stack walks above, precise PMU records below.

Sources: https://plv.colorado.edu/papers/mytkowicz-pldi10.pdf and https://github.com/async-profiler/async-profiler and https://openjdk.org/jeps/509 and http://psy-lob-saw.blogspot.com/2016/02/why-most-sampling-java-profilers-are-fucking-terrible.html

---

## 3. Runtime-Native Event Pipelines

Event emission built into a language runtime or operating-system kernel, with structured schema, lock-free per-thread or per-CPU buffers, and a session model that lets consumers enable or disable providers dynamically. What separates this family from §1 code-patching is that the events are part of the runtime's own semantics — GC pauses, scheduler transitions, query-plan nodes, signpost intervals — not a layer over raw instructions. Entries span JVM, .NET, Windows kernel, Linux kernel, Erlang, Haskell, Go, Apple, database engines, the MoarVM language runtime, and the kernel-event-instrumentation tier (PCP for long-horizon metrics, Sysdig for syscall capture, Falco for security rule evaluation); the mechanism shape (providers + sessions + ring buffers) is remarkably consistent across very different runtimes.

### 3.1. JDK Flight Recorder (JFR) — Thread-Local Buffers + Global Circular Buffer

JFR is one of the cleanest examples of a production tracing system designed from the start around the "flight recorder" metaphor: keep a rolling history with low enough overhead that it can stay available in real systems. OpenJDK's design writes events lock-free to **thread-local buffers**; when those fill, they are promoted into a **global in-memory circular buffer** that keeps the most recent history. Depending on configuration, the oldest data is either discarded or flushed to disk as a `.jfr` recording.

The original angle is not just "low-overhead tracing," but **after-the-fact incident analysis without having to predict the exact failure point in advance**. JFR is explicitly designed so that you can leave it off, turn it on selectively, or keep a rolling buffer and dump the recent past when operations detect a problem. This is closer in spirit to an aircraft flight recorder than to a classic profiler session.

JEP 328 set explicit success metrics: **at most 1% out-of-the-box overhead on SPECjbb2015** and **no measurable overhead when not enabled**. That is an unusually concrete performance target for a tracing facility. Also notable is the event model: events are typed, self-describing, and can come from the JVM, JDK libraries, the OS, and user code via `jdk.jfr.Event`.

The trade-off is scope. JFR is excellent for JVM-centric troubleshooting, but it is not a source-level debugger, and it does not give you arbitrary native process introspection the way OS-level tracing or DBI tools do.

Sources: https://openjdk.org/jeps/328 and https://docs.oracle.com/javacomponents/jmc-5-4/jfr-runtime-guide/about.htm

### 3.2. Event Tracing for Windows (ETW) — Provider / Controller / Consumer Sessions

ETW is the canonical Windows tracing substrate. Its architecture is particularly elegant: **providers** emit events, **controllers** start/stop/configure trace sessions, and **consumers** read the resulting stream in real time or from ETL files. This separation makes tracing a dynamic system capability instead of a compile-time choice.

The implementation detail that stands out is the buffering strategy. An ETW logging session is a kernel-managed collection of **in-memory non-paged buffers**, ETW **assigns a buffer to each processor**, and event generation/buffering is **lock-free**. This is the Windows analogue of the "engineered-for-production" philosophy that makes ftrace and JFR so compelling: the hot path is optimized first, and tooling is built around that constraint.

The original side here is the **session model**. Multiple providers can be composed into a single session; sessions can be enabled or disabled dynamically without restarting the system or process; and the same infrastructure supports debugging, performance analysis, and production observability. ETW is not just a tracer — it is an operating-system-level event bus with trace semantics.

The downside is ecosystem complexity. ETW is immensely capable, but provider discovery, schema evolution, event volume management, and tooling ergonomics are all non-trivial. The mechanism is excellent; the human factors are harder.

Sources: https://learn.microsoft.com/en-us/windows-hardware/test/wpt/sessions and https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/about-event-tracing-for-drivers and https://learn.microsoft.com/en-us/windows-hardware/test/wpt/event-tracing-for-windows

### 3.3. .NET EventPipe — Cross-Platform Runtime Tracing via Diagnostic Port

EventPipe is .NET's answer to the question "what is the ETW-like thing if I want it to work the same way on Windows, Linux, and macOS?" It is built into the runtime, collects events from runtime components and `EventSource` providers, serializes them to `.nettrace`, and can stream them to an external consumer through a **diagnostic port**.

Its original side is the combination of **cross-platform semantics**, **out-of-process control**, and **low operational friction**. Unlike ETW or `perf_events`, EventPipe does not require platform-specific high-privilege tracing infrastructure. Microsoft explicitly documents that, for EventPipe, the tracer can operate as the **same user** as the target process rather than requiring admin/root access. That is a strong design choice: make production diagnostics available to application teams, not just system administrators.

The session API also exposes the design directly. A client can request rundown data and specify the size of the **circular buffer** the target runtime should use while collecting events. This makes EventPipe feel less like an opaque profiler and more like a first-class, scriptable diagnostic protocol.

The limitation is scope: EventPipe only sees **managed code and the runtime itself**. If you need kernel events, native stacks for arbitrary unmanaged libraries, or whole-system scheduling context, you still have to go out to ETW, `perf_events`, or other OS-native tools.

Sources: https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe and https://learn.microsoft.com/en-us/dotnet/core/diagnostics/microsoft-diagnostics-netcore-client and https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace

### 3.4. GHC Eventlog + ThreadScope — Runtime-Native Parallel Timeline

GHC's eventlog mechanism is easy to underestimate if you think only in terms of line stepping and breakpoints. What it offers is a **runtime-native timeline** of the things that actually matter in parallel Haskell: HEC activity, sparks, garbage collection, scheduler events, and user-defined markers. ThreadScope then renders that into a graphical view showing spark creation, spark-to-thread promotions, and GC behavior over time.

The original side is that the trace is expressed in the runtime's own semantic units, not generic CPU samples. For parallel functional programs, that is a much better fit than a conventional profiler. A developer does not just want to know "which function used time"; they want to know whether work was balanced across capabilities, whether sparks were converted into real work, and whether GC or load imbalance dominated the run.

GHC developers also explicitly contrast eventlog with heavier profiling modes. Eventlog emission has much lower runtime impact because events are essentially **a few values written into a buffer** that the RTS flushes later, whereas full profiling changes the generated code much more substantially. That makes eventlog a better "big picture first" tool.

It is not an interactive debugger, and it is obviously Haskell-specific. But as a runtime-aware design for understanding concurrency and parallelism, it is original and worth adding.

Sources: https://downloads.haskell.org/ghc/latest/docs/users_guide/runtime_control.html and https://www.haskell.org/ghc/blog/20190924-eventful-ghc.html and https://manpages.ubuntu.com/manpages/jammy/man1/threadscope.1.html

### 3.5. Go `runtime/trace` — Partitioned Execution Traces and Flight Recorder

Go's `runtime/trace` is a first-party execution tracer emitting runtime-semantic events — `GoCreate`, `GoStart`, `GoBlock{Recv,Send,Select,Sync,Cond}`, `GoSysCall`, `GCStart`, plus user-defined `Task` and `Region` spans. Buffers are **per-P** (per scheduler processor), written without locks, and serialization is split from emission. Dmitry Vyukov's original 2014 design targeted ~35% overhead; Felix Geisendörfer and Nick Ripley brought it below 1% by Go 1.21 primarily by switching to **frame-pointer-based unwinding**. Go has kept frame pointers available by default on key production architectures for years, making tracebacks a pointer chase rather than a DWARF decode on those platforms; see §13.7 for the policy history.

The Go 1.22 execution-tracer overhaul (Michael Knyszek) changed the on-wire shape from one monolithic trace to a sequence of **self-contained generations**. Each partition is a complete mini-trace that a reader can parse independently; the historical "buffer the whole thing in RAM to sort events" pain disappears. This is the load-bearing change that enabled Go 1.25's **`FlightRecorder` API** — a fixed-size in-memory circular buffer holding the last ~N seconds of runtime events, flushed on application-side trigger (error, SLO breach, user command). Status (as of 2026-04): shipped in Go 1.25 (released 2025-08). Directly parallel to JFR (§3.1), reached via a partition/generation model instead of a global circular buffer.

The other Go contribution is the **pprof `profile.proto` format** used by `runtime/pprof`. Rather than repeat the interchange-format details here, §14.2 covers why pprof became the common wire format for CPU, heap, goroutine, block, mutex, and custom profiles.

Because Go 1.14 added asynchronous preemption (SIGURG-delivered `asyncPreempt` that synthesizes a safepoint at many otherwise non-cooperative PCs), its SIGPROF-driven CPU profiler is much less tied to cooperative safepoints than older managed-runtime profilers. It can still lose or bias samples because of signal delivery, runtime state, cgo/native frames, and unwinding constraints, but it avoids the worst HotSpot-style safepoint bias of §2.4. This is one of the clearer cases where language-level runtime decisions (frame-pointer discipline + async preemption) pay down profiling pathology that other managed runtimes still work around via AGCT-style side doors.

Sources: https://go.dev/blog/execution-traces-2024 and https://go.dev/blog/flight-recorder and https://github.com/golang/proposal/blob/master/design/60773-execution-tracer-overhaul.md and https://blog.felixge.de/waiting-for-go1-21-execution-tracing-with-less-than-one-percent-overhead/ and https://github.com/google/pprof/blob/main/proto/profile.proto

### 3.6. DTrace D and bpftrace — Safety-Constrained DSLs with Aggregation Primitives

§1.5 covers DTrace's USDT *probes*. DTrace as a *system* (Cantrill, Shapiro, Leventhal — USENIX ATC 2004) is the broader design, and it deserves its own entry because its distinctive contribution is a **tracing-specialized query DSL**, not just the probe mechanism. The **D language** has, as a design axiom, *no loops and no backward branches*. What replaces loops is a rich set of **aggregation types**: `@count[]`, `@sum[]`, `@avg[]`, `@quantize[]` (log2 histogram), `@lquantize[]` (linear histogram). Each CPU updates a local copy, and reduction happens at output time — so aggregations are MP-safe *by construction*, and the no-loops rule makes bounded per-probe execution a trivial property rather than something the runtime must verify dynamically.

The other DTrace contribution is the **provider / module / function / name** probe namespace: `syscall::open:entry`, `proc:::exec-success`, `io:::start`, `sched:::on-cpu`, plus the generic `fbt` (function boundary tracing for all kernel functions) and `pid` (arbitrary user-function entry). A decade before Linux distinguished tracepoints / kprobes / uprobes / USDT as separate mechanisms, DTrace unified them behind one query syntax.

**bpftrace** (Alastair Robertson 2016, with Brendan Gregg porting DTrace's tool library) is the modern Linux revival. It compiles a D-like DSL to eBPF, inheriting safety *twice*: once from the DSL (no loops, aggregations only), once from the eBPF verifier's static analysis. Every DTrace probe class maps to a bpftrace prefix — `tracepoint:`, `kprobe:`, `uprobe:`, `usdt:`, `profile:hz:99` — and the one-liner culture (`bpftrace -e '...'`) is a direct cultural inheritance.

**SystemTap** is the instructive counter-example. Red Hat's pre-eBPF answer to DTrace (2005–) compiled `.stp` scripts to C, then to **loadable kernel modules** loaded via `insmod`. The language was inspired by D, but the execution model was not: a codegen bug meant a kernel panic, compile/load latency was seconds, and kernel-debuginfo dependency was punishing. eBPF's verifier-bounded sandbox is deliberately *less* powerful than SystemTap's module model, and that is exactly why it won — kernel-supported safety beat maximum expressiveness.

The principle: when the workload is "let many users install ad-hoc observations into a production kernel," the tracer's language must be restricted enough that safety is structural, not reviewed. DTrace established this; eBPF + bpftrace confirms it. Contrast with ETW (§3.2), which is a push-from-provider event bus — DTrace is pull-by-query, and the two models compose well (an ETW-style session can feed into a bpftrace-style aggregation pipeline).

Sources: https://www.usenix.org/legacy/event/usenix04/tech/general/full_papers/cantrill/cantrill.pdf and https://illumos.org/books/dtrace/chp-intro.html and https://github.com/bpftrace/bpftrace and https://www.brendangregg.com/blog/2018-10-08/dtrace-for-linux-2018.html and https://lwn.net/Articles/852112/

### 3.7. LTTng and CTF — Lockless Per-CPU Ring Buffers Across Kernel and Userspace

Mathieu Desnoyers's **LTTng** (Linux Trace Toolkit Next Generation, 2006–) is the Linux tracer whose distinguishing property is that the *same* lockless per-CPU ring-buffer algorithm runs in the kernel tracer and in the userspace tracer (`liblttng-ust`). On the fast path, reservation is a local compare-and-exchange loop using only local-CPU-ordered atomics — no cross-CPU memory barriers, no cacheline false sharing, no locks. This is the same design family as JFR's thread-local → global circular buffers (§3.1) and ETW's per-processor buffers (§3.2), but generalized so that user and kernel events share one buffering discipline and one wire format.

That wire format is **CTF (Common Trace Format)**, now at CTF 2. It is a standardized binary format consumed by Babeltrace, Trace Compass, and the GDB/LLDB trace loaders. The significance is that CTF is *tool-agnostic*: a CTF stream from LTTng, from a custom embedded tracer, or from a barebones microcontroller target can all be analyzed by the same viewers, the same query tools, and the same scripting library. This is the tracing analogue of pprof as a profile-format lingua franca (§14.2).

The design lesson is that **buffer discipline and wire format are separable design decisions**. LTTng treats them as two orthogonal standards: any producer that emits CTF can be analyzed by any CTF consumer, and any lockless-per-CPU producer can target any binary format. The combination — lockless per-CPU production into CTF — is what makes LTTng a viable backbone for high-frequency kernel-plus-userspace correlation in production systems.

Sources: https://lttng.org/docs/ and https://www.kernel.org/doc/ols/2006/ols2006v1-pages-209-224.pdf and https://www.dorsal.polymtl.ca/files/publications/desnoyers-mcc09-final.pdf

### 3.8. Apple `os_signpost` + Instruments — One Emission, Three Modalities

Apple's platform tracing (macOS 10.12 / iOS 10, 2016) is structured around three primitives that share one emission backend: **`os_log`** (structured logging), **`os_signpost`** (scoped intervals + markers), and **`os_activity`** (activity trees / causal grouping). A single `os_signpost_interval_begin`/`_end` pair is simultaneously a structured-log entry in `log show` / Console, a flame-bar interval in Instruments's Points-of-Interest track, and an input to Instruments's aggregation (duration stats, event counts). The developer writes one call site; tooling chooses the projection.

The mechanical trick that makes this cheap enough to leave on in shipping apps is **compile-time format extraction**: the call site is split at compile time into a static format descriptor plus typed length-encoded dynamic arguments, so the runtime never parses `printf`-style format strings at emission. It emits a tiny binary payload into the persistent **`.tracev3`** ring under `/var/db/diagnostics`, collected by `logd` and projected into text, signpost, or metric views on demand. Cost when off is effectively zero (disabled subsystems elide the call at the log-handle level); cost when on is a `memcpy` of a pre-encoded payload to a per-process shared buffer.

**Signpost IDs** reify causal grouping across threads with explicit `Process` / `Thread` / `System` matching scopes; paired with `os_activity`, the unified system gives an OS-enforced causality model — the same abstraction Go's `runtime/trace` tasks/regions (§3.5) and JFR's event stacks (§3.1) rediscovered independently. **Instruments** is the native viewer: template-based, with CPU sampling, allocation, network, thread-state, and signpost tracks unified on one timeline. It has been around since 2007 (originally DTrace-based); signposts as first-class timeline intervals date from WWDC 2018.

The design insight worth carrying forward: **a tracing API that emits one payload but supports three viewing projections (text log, timeline interval, aggregate metric) is strictly more useful than three separate APIs with three separate emission costs**. ETW (§3.2) decouples provider from viewer but still makes the provider author shape events per-viewer; Apple's design pushes the projection decision entirely into the consumer.

Sources: https://devstreaming-cdn.apple.com/videos/wwdc/2016/721wh2etddp4ghxhpcg/721/721_unified_logging_and_activity_tracing.pdf and https://developer.apple.com/documentation/os/recording-performance-data and https://developer.apple.com/videos/play/wwdc2018/405/

### 3.9. Linux `io_uring` Tracing — When the Syscall Boundary Stops Being the Tracing Boundary

`io_uring` (Jens Axboe, 2019) replaced the per-operation syscall model for async I/O with shared-memory submission and completion queues. In steady state, with `IORING_SETUP_SQPOLL`, a dedicated kernel poller thread drains submission queue entries (SQEs) from userspace-shared memory with *zero* `io_uring_enter` syscalls. Completions arrive in the CQ ring the same way.

This breaks every traditional tracing assumption. `strace` (§6.2) sees at most one `io_uring_enter` per batch — or nothing at all with SQPOLL — and cannot decode the individual SQEs that submission carried; `strace` issue #109 is the canonical "strace cannot trace io_uring" bug. Kernel kprobes attached to VFS functions see the operations fire but without the io_uring dispatch context needed to attribute them. The "trace at the syscall boundary" discipline is structurally blind here.

The robust production answer is **first-party tracepoints inside the io_uring subsystem itself**. Status (as of 2026-04): the names below are taken from `include/trace/events/io_uring.h` in mainline Linux and have evolved as the subsystem has grown — readers should consult the kernel source for the version they target. Representative tracepoints include `io_uring_submit_sqe` (per-SQE, where strace sees one batched enter), `io_uring_complete` (per-CQE), `io_uring_queue_async_work`, `io_uring_link`, `io_uring_poll_arm`/`_poll_wake`, `io_uring_cqring_wait`, `io_uring_cqe_overflow`, and about a dozen others. External probes can observe fragments of the path, but without subsystem-provided semantic events they are unstable and cannot reliably reconstruct per-SQE/per-CQE causality. Tools consume the tracepoints via `perf trace`, bpftrace (§3.6), and specialized io_uring analyzers; causal reconstruction across submit and complete is a join on the `user_data` cookie each SQE carries. Cost when on is the standard NOP-patched tracepoint cost (§1.3), zero when off — the expensive axis is *volume*, since busy rings emit millions of CQEs per second, so consumers typically aggregate in-kernel via bpftrace maps rather than streaming raw events.

The broader structural lesson is the one worth carrying forward: **shared-memory-queue IPC is a tracing blindspot that requires cooperation from the subsystem being traced**. Any transport where the syscall boundary is crossed once per *batch* rather than per *operation* — DPDK, SPDK, RDMA verbs, Vulkan command buffers, GPU submit queues — has the same property. The operation semantics live primarily in user/kernel shared memory; externally attached probes can be useful for expert diagnosis, but stable causality requires first-party semantic tracepoints. This is the inverse of the DTrace/eBPF "probe anything" promise of §3.6 and a strong argument for language/runtime tracepoints (§3.1 / §3.3 / §3.5) as a *primary* design target rather than an afterthought.

Sources: https://kernel.dk/io_uring.pdf and https://kernel.dk/axboe-kr2022.pdf and https://github.com/torvalds/linux/blob/master/include/trace/events/io_uring.h and https://lwn.net/Articles/1063853/ and https://blog.cloudflare.com/missing-manuals-io_uring-worker-pool/

### 3.10. Database Query Tracing — Every Engine Reinvents ETW for Itself

Database engines have their own tracing subsystems parallel to ETW (§3.2), JFR (§3.1), and EventPipe (§3.3), because query-plan tracing needs to see operator-level events (scan, join, sort, hash-build, lock-acquire, async-I/O-request) that OS-level tracing cannot see. Three engines illustrate the design space.

**SQL Server Extended Events (XE)** mirrors ETW's topology — packages → events → actions → predicates → sessions → dispatcher/buffers → targets — and even ships an `etw_classic_sync_target` that forwards events into OS ETW. The design point worth naming is that **predicates are evaluated synchronously on the firing thread before any buffer write**, so filtered-out events cost only a predicate evaluation.

**PostgreSQL** takes the opposite path: no event bus, instead a small set of global function-pointer **executor hooks** (`ExecutorStart/Run/Finish/End_hook`, `planner_hook`, `post_parse_analyze_hook`) that extensions chain at `_PG_init()`. `auto_explain` and `pg_stat_statements` are two consumers of the same hook surface — the former emits per-query plan-tree text when `log_min_duration` is exceeded; the latter canonicalizes parse trees into query IDs (literals replaced by `$n`) and accumulates per-ID counters as a metrics endpoint.

**MySQL Performance Schema** (since 5.7) inverts the interface entirely: events materialize into in-memory tables (`events_statements_current`, `events_waits_history_long`, `events_stages_summary_by_thread_by_event_name`) inside a dedicated `PERFORMANCE_SCHEMA` storage engine, queried via ordinary `SELECT`. With the consumer disabled, the hot path is an atomic-read of a boolean — the cheap-guard / expensive-payload pattern (§1.5) again.

The chapter takeaway: **mature DB engines reinvent ETW for themselves** because operator-level visibility requires in-engine instrumentation. The runtime is a database, the events are plan-node transitions, and the design space is the same one ETW / JFR / EventPipe already mapped out at the OS / VM level. Complement rather than compete with §12.3 OpenTelemetry's `db.statement` attribute: OTEL sees the query from outside, XE / auto_explain / Performance Schema see it from inside.

Sources: https://www.postgresql.org/docs/current/auto-explain.html and https://www.postgresql.org/docs/current/pgstatstatements.html and https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/sql-server-extended-events-engine and https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/targets-for-extended-events-in-sql-server and https://dev.mysql.com/doc/refman/en/performance-schema.html

### 3.11. MoarVM Telemetry, snapper, and Heap Snapshots

Raku's MoarVM ships production-grade language-runtime observability built around three pieces. The **`Telemetry`** module instruments `Usage`, `Thread`, `ThreadPool`, and `AdHoc` event sources; `$*SAMPLER` controls active instruments. A dedicated **`snapper` thread** samples every 0.1 s; `-Msnapper` / `-Msafe-snapper` enables zero-code-change profiling on any Raku program. **Heap snapshots** use a binary format `MoarHeapDumpv00X` (current version 3, subversion 1), produced by `src/profiler/heapsnapshot.c`, with a TOC + string-intern table; produced via `--profile=foo.mvmheap` or `Telemetry::snap(:heap)` and saved with the `.mvmheap` extension.

Tooling: **`App::MoarVM::HeapAnalyzer`** is a CLI shell over the binary format; **`moarperf`** (timo, last release 2020 but still working) is a web UI; the now-discontinued Comma IDE integrated the same. The architectural design — snapper thread + opcode-level Telemetry events + a binary heap-snapshot format with offline analyzer tools — sits squarely in the JFR / EventPipe / `runtime/trace` family (§§3.1, 3.3, 3.5), but for a smaller, less-known runtime. Worth recording as evidence that a small-team VM can ship credible always-on observability if the binary format and the analyzer are co-designed from the start — with the caveat that bus-factor is real: moarperf's last release was 2020 and the analyzer ecosystem is small enough that a single maintainer's departure is meaningful risk.

Sources: https://docs.raku.org/type/Telemetry and https://github.com/MoarVM/MoarVM/blob/master/src/profiler/heapsnapshot.c and https://github.com/timo/moarperf

### 3.12. PCP, Sysdig, and Falco — Kernel-Layer Telemetry Beyond Runtime Pipelines

Three Linux-ecosystem tracing systems that occupy a different niche from the runtime-native event pipelines of §§3.1–3.11. They instrument the OS kernel rather than the language runtime, and they answer different questions about a system's behaviour.

**Performance Co-Pilot (PCP)** (Red Hat, 2000+) is a metrics-collection and analysis framework that predates eBPF and has unusually long-horizon retention discipline. A long-running daemon (`pmcd`) collects metrics from per-domain agents (`pmda`s for the kernel, MySQL, PostgreSQL, JVM, Apache, NFS, BIND, and dozens of others), retains time-series in a binary archive format that survives across reboots, and exposes them to query clients (`pminfo`, `pmval`, `pmrep`, Grafana via the PCP datasource). Distinct from Prometheus: per-host architecture with archives shipped to central storage, not pull-from-central scraping. Distinct from eBPF (§§1.7, 1.11): agent-based with stable per-domain plugin contracts, not in-kernel-program-based. The strength is **decade-long historical retention** of metrics with consistent schema across kernel and application domains, which makes it the canonical telemetry stack for production-incident retrospectives at companies running PCP for many years.

**Sysdig** (Sysdig, Inc., 2014+) wraps system calls in a tcpdump-like UI: `sysdig` captures all syscalls and kernel-tracepoint events into a file or live stream, with filters resembling Wireshark's display filters (`fd.type=ipv4 and proc.name=nginx and evt.type=connect`). Distinct from `strace` (§6.2): designed for whole-system observation rather than single-process attachment, with optimised in-kernel capture rather than ptrace per syscall. Modern Sysdig uses eBPF (§§1.7, 1.11) as the capture mechanism, with the original kernel-module path as fallback for older kernels. The "tcpdump for syscalls" framing is the design lesson: a generic capture-and-filter tool over a uniform per-event schema scales to investigations that would require dozens of `strace` / `perf` / `ftrace` invocations to reconstruct.

**Falco** (Sysdig, Inc., 2016+; CNCF graduated 2024) is the security-tracing layer on top of Sysdig: a rule engine evaluating syscall events against threat-detection rules (`spawned_process_in_container_with_unexpected_image`, `outbound_connection_from_unauthorized_user`, `write_to_etc_directory_outside_install_phase`) and emitting alerts. Production use in Kubernetes runtime security (Sysdig Secure, Aqua, Prisma Cloud, RedHat ACS). The architectural contribution: **kernel-event-based runtime threat detection at container scale** — a single Falco daemon per node observes every syscall in every container and can flag anomalies that file-integrity-monitor or process-list-scan tools would miss.

The design lesson distinguishing these from §§3.1–3.11: **the runtime-native event pipelines instrument the language runtime; PCP, Sysdig, and Falco instrument the OS kernel**. Both layers are valuable; they answer different questions. Language-runtime tracing tells you why your async task is slow; kernel-syscall tracing tells you why your container is making unexpected network calls. A complete production observability story usually needs both, and the wire-format choice (CTF §3.7, OpenTelemetry §12.3, Falco's JSON, PCP's archive) is what determines whether the two layers correlate cleanly.

Sources: https://pcp.io/ and https://sysdig.com/blog/sysdig-vs-strace/ and https://falco.org/ and https://github.com/falcosecurity/falco

---

## 4. Instrumentation Profilers

Tools that build a per-span or per-event record explicitly at sites the developer (or the language) chose, in contrast to the sampling profilers of §13 and §14 that interrupt arbitrary code at a fixed cadence. The cost model is per-annotated-site, not per-wall-clock-sample, and the distinguishing engineering challenge is making each span cheap enough (nanoseconds) to leave on continuously in development and sometimes production builds. The chapter also covers the vendor-maintained microarchitecture-aware production analysers — Intel **VTune** and AMD **μProf** for Linux/Windows microarchitectural diagnostics; Microsoft **PerfView** and **Windows Performance Analyzer (WPA)** for ETW-native .NET-and-kernel profiling — that pair tightly with the runtime/OS event providers no third-party tool maintains as comprehensively.

### 4.1. Tracy / Spall — Nanosecond Instrumentation Profilers

Tracy and Spall are instrumentation-based profilers popular in game development, where per-frame performance visibility is essential.

**Tracy** achieves ~2ns overhead per span using a lock-free queue. The client collects events and holds them in memory until a server connects and pulls the data. The server reconstructs the timeline in real-time. Tracy supports CPU sampling, GPU tracing, memory allocation tracking, lock contention visualization, and context switch recording — all in a single tool with a custom native UI that handles hundreds of millions of events.

**Spall** takes a different approach: ~12ns per span, but the output is a compact binary file viewed in a web-based UI. Spall's simplicity is the point — a single-header C library for tracing, a web frontend for viewing. It supports `clang -finstrument-functions` for automatic whole-program tracing without manual annotation.

Both demonstrate that with careful engineering, instrumentation overhead can be low enough to leave enabled in development builds permanently. The 2–12ns per span cost is negligible compared to the microseconds or milliseconds that actual work takes, but the visibility gained is transformative.

Sources: https://github.com/wolfpld/tracy and https://gravitymoth.com/spall/spall-web.html

### 4.2. Ruby YARV — Historical Trace Instructions and TracePoint

Older YARV designs included `trace` instructions at compile time at line boundaries, method entries, and returns. The TracePoint API enabled or disabled them at runtime: when disabled, trace instructions behaved as NOPs; when enabled, they called registered callbacks.

This is best treated as the historical bytecode-level design point rather than a blanket description of modern Ruby internals. Ruby issue #14104 documents work to remove trace instructions, so the durable lesson is not "Ruby still uses trace opcodes everywhere," but that compile-time insertion of trace points with a runtime toggle has a measurable disabled cost — negligible per point, but not literally zero — and can become a substantial part of an interpreter's instruction-set surface. Modern Ruby TracePoint should therefore be read as the user-facing tracing abstraction, with implementation details varying by version.

Sources: https://docs.ruby-lang.org/en/master/TracePoint.html and https://bugs.ruby-lang.org/issues/14104

### 4.3. Erlang dbg — Match Specification Tracing in Production

Erlang's `dbg` module provides function call tracing with match specifications — pattern-matching expressions that filter which calls generate trace events. You can trace all calls to a function, or only calls where the first argument matches a specific pattern, or only calls that return a specific value.

```erlang
%% Trace calls to math:sin/1 only when argument equals 3.14
dbg:tpl(math, sin, 1, dbg:fun2ms(fun([X]) when X == 3.14 -> return_trace() end))
```

The match specification is compiled into an efficient matcher by the VM. When the pattern doesn't match, the overhead is minimal — a quick pattern check in the VM's call dispatch path. When it does match, a trace message is generated and sent to a trace handler process.

This is routinely used in production Erlang systems to diagnose issues without restarting or redeploying. The key design: tracing is an opt-in, per-function, pattern-filtered mechanism built into the VM from the start. It is not an afterthought bolted on via external tools.

The `recon` library by Fred Hebert wraps `dbg` in safety rails (rate limiting, automatic timeout) to make production tracing even safer.

Sources: https://www.erlang.org/doc/apps/runtime_tools/dbg.html and https://ferd.github.io/recon/recon_trace.html

### 4.4. Tcl — Variable and Execution Traces

Tcl provides first-class tracing as a language feature via the `trace` command. You can attach callbacks to:

- **Variable traces:** fire when a variable is read, written, or unset. `trace add variable x write myHandler` calls `myHandler` every time `x` is assigned.
- **Execution traces:** fire when a command enters or leaves execution, including per-step tracing through a procedure. `trace add execution myProc enterstep myHandler` calls `myHandler` for every command executed inside `myProc`.

The implementation is in the interpreter's variable access and command dispatch paths. When no traces are active on a variable or command, there is no overhead — the trace list is simply empty. When traces are active, each access checks the trace list and invokes callbacks.

Tcl's approach is notable for making tracing a *language-level* concept rather than a tool-level concept. Any Tcl code can set up traces on any other Tcl code's variables or commands. This enables debuggers, profilers, and monitoring tools to be written entirely in Tcl itself, with no special VM support beyond the trace mechanism.

The limitation is overhead: execution traces on hot commands add a function call per step. But for debugging and development, where the goal is understanding rather than performance, this is acceptable.

Sources: https://www.tcl-lang.org/cgi-bin/tct/tip/86.html and https://wiki.tcl-lang.org/page/Tracing+with+enterstep

### 4.5. GraalVM Truffle — AST Wrapper Node Instrumentation

Truffle's instrumentation framework inserts "wrapper nodes" into the AST around instrumentable nodes. When no instrumentation is active, the wrapper node is not present — the AST is the same as the non-debug case. When a tool (debugger, profiler) requests instrumentation, Truffle inserts wrapper nodes that intercept execution events (enter, return, exception) and forward them to the tool.

The critical property: Truffle's partial evaluation and compilation pipeline treats wrapper nodes like any other AST nodes. After JIT compilation, an active wrapper's event dispatch can be inlined and optimized. When instrumentation is removed, the wrapper node is removed and the code is recompiled — returning to full speed.

This means the cost of instrumentation is paid only in interpreted mode or during recompilation. Once the JIT stabilizes with the instrumentation in place, the overhead is minimal. And when instrumentation is removed, performance returns to the non-instrumented baseline after a recompilation.

This is arguably the most sophisticated approach to "zero overhead when disabled" in this survey: not through patching, but through treating instrumentation as part of the program's optimizable AST.

Sources: https://www.graalvm.org/latest/graalvm-as-a-platform/language-implementation-framework/ and https://www.graalvm.org/latest/graalvm-as-a-platform/implement-instrument/

### 4.6. HUGLO — Hyper-Ultra-Giga Low-Overhead Ruby Profiler

Sampling profilers often fail to catch P99.9 tail latency because they only see the *average* state of the program. Tracing profilers catch everything but are traditionally too slow for production. In a personal blog, Matt Stuchlik details building HUGLO, a Ruby tracer capturing function calls, syscalls, and thread states with strictly less than 100ns of overhead per call. By utilizing extreme micro-optimizations and native extensions to avoid Ruby-level object allocations, he built a production-safe, continuously-running tracer that catches the exact outliers that standard profilers obscure.

Source: https://blog.mattstuchlik.com/2025/04/23/low-overhead-ruby-tracing.html

### 4.7. Mozilla Gecko Profiler — Two-Tier Sampler + Marker-Based Timeline

Firefox ships an in-process profiler that sits in two tiers: a **Base Profiler** in `mozglue/baseprofiler` that loads at process start, and the full **Gecko Profiler** that takes over once `libxul` is mapped. Both write into the same unified profile buffer. This is the explicit answer to "who profiles the profiler's own initialization" — the Base Profiler catches Firefox's earliest startup (before libxul, before most of the JS engine) and hands its accumulated buffer to the full profiler when libxul is ready. JFR (§3.1) and EventPipe (§3.3) solve this differently (bootclasspath and post-start IPC respectively); Mozilla's two-tier design is a cleaner fit for a monolithic native process with a late-loaded engine.

The distinctive emission primitive is **markers vs labels**. Markers (`profiler_add_marker("FirstPaint", PaintMarker{...})`) always write; labels (`AUTO_PROFILER_LABEL`) only surface if the sampler happens to catch the thread while the RAII label is on the pseudo-stack. Marker payloads are strongly-typed C++ templates with a schema (`MarkerSchema` declares fields + tooltip labels + chart-label format), and the schema is carried in the profile JSON so the frontend renders unknown marker types without code changes. JavaScript code enters markers via the W3C `performance.mark` / `performance.measure` User Timing API, which Gecko forwards into the profiler buffer automatically — layout, paint, GC, network, DOM events, JS execution, and app-level custom markers all land on one timeline. The browser analogue of `os_signpost` (§3.8) or ETW events, with a web-standard entry point.

Stack correlation is the hard part. The sampler pauses each registered thread and walks the native stack (Windows `StackWalk64`, Linux via Mozilla-authored **LUL** unwinder for frame-pointer-free code, macOS via in-process remote unwind), interleaves it with the JS engine's interpreter/JIT stack (SpiderMonkey exposes a pseudo-stack plus PC→line maps for JIT code), and splices in C++ RAII label pseudo-frames. The result is a single stack from `nsLayoutUtils::PaintFrame` through JS `render` into `computeStyles`. The same safepoint-bias problem discussed in §2.4 applies to SpiderMonkey's Baseline and IonMonkey JITs.

**profiler.firefox.com** is the frontend — a React/Redux SPA that natively renders Gecko's profile format and also imports Linux `perf script` output, Android SimplePerf, Chrome `trace_event` JSON, Android Studio profiler, and dhat. A Chrome extension (2024) starts Chrome's internal profiler and hands the trace straight to the Firefox Profiler for analysis. Mozilla is explicitly positioning profiler.firefox.com as a universal viewer, the same pattern as Perfetto (§11.2).

Sources: https://firefox-source-docs.mozilla.org/tools/profiler/index.html and https://firefox-source-docs.mozilla.org/tools/profiler/markers-guide.html and https://firefox-source-docs.mozilla.org/tools/profiler/code-overview.html and https://github.com/firefox-devtools/profiler and https://profiler.firefox.com/

### 4.8. VTune Profiler and AMD μProf — Vendor-Maintained Microarchitecture-Aware Profilers

Intel **VTune Profiler** and AMD's symmetric **μProf** are commercial-grade production profilers exposing the full PMU surface (§5.5) plus vendor-specific microarchitectural-analysis features. The architectural distinction from the open-source profilers of §§4.1, 13, 14 is **microarchitecture-aware analysis pipelines**: VTune ships with **Top-Down Microarchitecture Analysis (TMAM)** — a hierarchical decomposition of execution time into **front-end-bound**, **back-end-bound**, **bad-speculation**, and **retiring** categories, with deeper sub-categories at each level — that requires per-microarchitecture PMU event mapping the open-source ecosystem cannot maintain at the same depth or release cadence. The TMAM mapping is updated for each new Intel microarchitecture (Skylake → Ice Lake → Sapphire Rapids → Granite Rapids) as part of VTune's release.

Distinguishing analysis modes:

- **Memory Access Analysis** (PEBS-LL, §5.5): per-load latency distribution, which DRAM channel served the request, NUMA-domain attribution, cache-miss source attribution (L1/L2/L3/DRAM/remote-socket).
- **Microarchitecture Exploration**: TMAM-driven hot-path breakdown showing which CPU pipeline stage (fetch, decode, execute, retire) is the bottleneck for each function, broken down per-instruction.
- **Threading Analysis**: critical-path analysis through synchronisation primitives, lock-contention attribution, OpenMP/TBB parallelism-efficiency metrics including imbalance and serial-region cost.
- **GPU Offload Analysis**: cross-CPU/GPU timeline integration analogous to Nsight Systems §15.2 but for Intel iGPU and Intel Arc / Data Center GPU Max parts.
- **HPC Performance Characterization**: vectorisation, FLOPS, memory-bandwidth-vs-roofline analysis with ISA-aware code-path classification.

**AMD μProf** is the equivalent on AMD silicon, with **IBS** (§5.5) as the precise-sampling primitive instead of PEBS, and AMD-microarchitecture-specific TMAM analogue. Both run on Linux and Windows; both ship CPU-microarchitecture documentation that translates raw PMU counter values into actionable diagnostics. **Apple's Instruments** (§3.8) plays a similar vendor-maintained role for Apple Silicon, with M-series-specific analysis templates, though without a published TMAM-equivalent.

The production-tools lesson is that **microarchitecture-aware analysis requires vendor cooperation**: the PMU event mapping and TMAM decomposition are Intel/AMD/Apple intellectual property updated per silicon generation. Open-source profilers (perf, async-profiler §2.4) expose the raw events; VTune / μProf / Instruments supply the interpretation layer. For workloads where microarchitectural efficiency matters (HPC, low-latency trading, high-throughput servers, AI inference), this interpretation is what distinguishes production performance work from raw sample collection.

Status (as of 2026-04): both VTune and μProf are free-as-in-beer (registration-walled binaries), supported on Linux and Windows; VTune additionally supports macOS for collection but not full analysis. Neither is open-source; both rely on the open-source perf substrate underneath.

Sources: https://www.intel.com/content/www/us/en/developer/tools/oneapi/vtune-profiler.html and https://www.amd.com/en/developer/uprof.html and https://www.intel.com/content/www/us/en/docs/vtune-profiler/cookbook/2024-0/top-down-microarchitecture-analysis-method.html

### 4.9. PerfView and Windows Performance Analyzer — ETW-Native Profiling Stacks

Vance Morrison's **PerfView** (Microsoft, 2011+; open-source 2014) is the canonical .NET performance and memory analyser, and **Windows Performance Analyzer (WPA)** is the GUI for ETW (§3.2). Both occupy the Windows-side equivalent of Linux's perf + flame-graph + heaptrack ecosystem, with deeper integration into the .NET runtime and the Windows kernel ETW substrate. Vendor-maintained, Windows-only, and tightly coupled to ETW's kernel and user-mode provider catalogue.

**PerfView** is structured around four modes:

- **CPU sampling** via ETW: kernel-side sampling (`PROFILE` ETW provider) plus stackwalk events. PerfView ingests the resulting `.etl` file and produces flame graphs, stack-aggregated views, and call-tree breakdowns. Distinct from Linux perf (`§13.1`): PerfView lives entirely on top of ETW, so its cost when off is zero (no sampling running), and its cost when on is identical to ETW's kernel sampling overhead.
- **GC and allocation analysis**: per-allocation site stack capture via the .NET CLR ETW provider, with heap-walk integration so users can see "this allocation site allocated 4 GB of strings, 99% of which were retained by this static field." This is the canonical .NET memory-leak diagnosis path; comparable in scope to Java Flight Recorder's allocation profiling (§3.1) but with substantially deeper allocation-site stacks via ETW's stackwalk events.
- **Wall-clock blocking analysis**: combines CPU samples with thread-blocking events (lock acquire, await suspension, synchronous I/O) to produce an "off-CPU-aware" wall-clock profile. Distinct from on-CPU flame graphs (§11.3) by accounting for blocked time, similar to off-CPU flame graphs (§11.4) but driven by ETW thread-state events rather than eBPF.
- **`.NET Counters`**: low-overhead always-on counters (allocation rate, GC time, working-set, exception rate, tiered-compilation events) viewable live via `dotnet-counters` or recorded in PerfView.

**WPA** is the more general Windows-side analyser. It ingests ETL traces from any ETW provider (kernel scheduling, file I/O, network, DirectX, Win32, custom application providers) and renders configurable timeline + table views. WPA is Microsoft's answer to Perfetto (`§11.2`) for Windows-native trace analysis: same "universal trace timeline" pattern, ETW as the single capture format, GUI for visual exploration plus scriptable analysis via WPA Profile XML files. WPA's **Generic Events** view exposes any provider's emitted events; **Stack views** drill into kernel-stackwalk-augmented event traces; **CPU Usage (Sampled)** is the WPA flame-graph equivalent.

The production-tools lesson is similar to VTune / μProf (§4.8): **vendor-maintained Windows analyser stacks pair tightly with the runtime/OS event providers**. PerfView's value over generic profilers comes from understanding .NET CLR ETW events (GC start/stop, JIT compilation, exception throw, type-load, tier-up to optimised code) at the same depth that VTune understands Intel PMU events. WPA's value comes from understanding kernel ETW providers (scheduler context-switch reasons, page-fault sources, file-I/O wait categories, registry access patterns) that no third-party tool maintains as comprehensively.

Distinct from Linux ecosystem: where Linux observability is fragmented across perf, ftrace, eBPF, bpftrace, Sysdig, and a dozen GUI tools, the Windows ecosystem is **ETW-as-substrate plus PerfView/WPA-as-analyser**, much more vertically integrated. The downside is platform lock-in; the upside is consistent UX and deep semantic awareness of Microsoft platform events.

Status (as of 2026-04): PerfView is open-source (MIT) and continues to track .NET runtime evolution (now covering .NET 8+, AOT-compiled binaries, and `JsonEventSource`). WPA ships in the **Windows Performance Toolkit**, part of the Windows Assessment and Deployment Kit (ADK). Both are free; both remain Windows-only.

Sources: https://github.com/microsoft/perfview and https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-analyzer and https://learn.microsoft.com/en-us/dotnet/core/diagnostics/perfview-tool

---

## 5. Hardware Tracing

Mechanisms where a CPU, SoC, or physical substrate captures execution data without software cooperation. The common axis is near-zero runtime overhead on the target — paid for in silicon area, memory bandwidth, dedicated trace pins, or (in one case) ambient electromagnetic emanation — with the decode cost offloaded to a kernel driver or an external capture device. Entries span x86 (PT, LBR, PEBS), AMD (IBS), ARM (CoreSight, SPE, Cortex-M ITM), and a physical-layer outlier (ZoP).

### 5.1. Intel Processor Trace / magic-trace — Hardware Branch Recording

Intel Processor Trace (PT), available since Skylake, records taken branches into a compact hardware bitstream. The tracing value is that branch capture happens without compiler instrumentation; the cost is mainly trace bandwidth and post-processing decode.

Jane Street's `magic-trace` is the user-facing example: it runs PT in a circular buffer, snapshots recent control flow on a trigger, and converts the decoded stream into a function-call timeline viewable in Perfetto. Status (as of 2026-04): magic-trace is open-source and actively maintained; it requires Intel PT (Skylake or newer) and Linux. `DEBUGGERS.md §2.10` covers the retrospective debugging workflow; this section keeps the tracing substrate: hardware branch packets are cheap to collect but become useful only after symbolization, frame reconstruction, and timeline export.

Sources: https://blog.janestreet.com/magic-trace/ and https://thume.ca/2023/12/02/tracing-methods/

### 5.2. Hardware LBR (Last Branch Record) — Silent Branch History

Intel processors maintain a hardware ring buffer called the Last Branch Record (LBR) which continually records the source and destination addresses of the last few dozen branches without any software overhead. The ring is updated by the CPU in the background and read at sample time, making it the cheapest possible "recent history" source for profiling and debugging.

The use case that makes LBR uniquely valuable is **Hardware Transactional Memory (TSX) debugging**. As noted by kernel developer Andi Kleen, any interrupt instantly aborts a TSX transaction, so normal profilers and breakpoint debuggers cannot observe transaction internals — the moment you interrupt to inspect state, the state is gone. LBR runs silently and does not perturb transactions, letting developers recover the exact branch history that led to an internal abort.

Beyond TSX, LBR is the enabling primitive for two very different production uses:
- **Per-sample call-stack capture** for profilers — `perf record --call-graph lbr` uses the branch ring as a zero-cost stack-walk shortcut. Covered as a dedicated mechanism in §13.6.
- **PEBS record augmentation** — PEBS records (§5.5) can be configured to include the current LBR contents, correlating a precise sample with the branch history that led to it.

Source: https://lwn.net/Articles/680996/

### 5.3. Arm CoreSight ETM / PTM — Dedicated On-Chip Trace Fabric

The Arm world has a family of tracing ideas under **CoreSight**. CoreSight is not a single feature; it is a **debug and trace architecture** with dedicated infrastructure for control, cross-triggering, routing, buffering, and off-chip export of trace data.

The standout piece is the Embedded Trace Macrocell / Program Trace Macrocell family. Arm's own documentation describes ETM-M33 as providing **non-intrusive program-flow trace**, generating the information needed for tools to reconstruct execution. It can trace all instructions, branch targets, exceptions, and cycle counts, with trigger/filter logic controlling exactly what is recorded. Other CoreSight components route this data onto the trace bus, into on-chip buffers such as ETB/ETF, or out through TPIU to external capture hardware.

What is original here is that the "tracer" is not a patch, a signal, a runtime callback, or a debugger instruction. It is a **hardware trace fabric designed into the SoC**. That matters enormously for real-time and embedded systems, where even a single interrupt or breakpoint can destroy the timing bug you are trying to observe. Arm's own examples emphasize this: trace can capture execution history non-intrusively while the target continues to run at full speed.

The limitation is deployment reality. Whether CoreSight is useful depends on what the SoC actually implemented, how much trace buffer space exists, and whether you have the capture hardware and tooling to retrieve it. But conceptually it is one of the cleanest answers to "how do I trace without perturbing timing?"

Sources: https://developer.arm.com/documentation/102520/latest/ and https://developer.arm.com/documentation/100232/latest/

### 5.4. Zero-Overhead Profiling via EM Emanations (ZoP)

Zero-Overhead Profiling takes literal "zero overhead" to the physical layer by analyzing **electromagnetic (EM) emanations** — the radio-frequency signals that any switching CMOS circuit unintentionally radiates as it executes — rather than adding software instrumentation or hardware performance counters. ZoP runs a training phase to map EM waveforms to code paths, then records the uninstrumented program during actual execution. By matching the waveforms, it tracks the execution path with >94% accuracy, completely avoiding any modifications to the target system or memory footprint.

Source: https://sites.gatech.edu/ece-alenka/wp-content/uploads/sites/463/2016/09/ZoP.pdf

### 5.5. Precise PMU Sampling — Intel PEBS, AMD IBS, ARM SPE

Ordinary PMU-overflow sampling is *imprecise*: when a performance counter overflows (cache miss, branch miss, retired instruction), the pipeline has already moved on by the time the interrupt fires, so the sampled PC is tens of instructions downstream of the instruction that actually caused the event. This "skid" makes naive `perf record -e cache-misses` attribute misses to the wrong source line. Three hardware families solve it, each with a different mechanical angle.

**Intel PEBS (Precise Event-Based Sampling)** arms the hardware once a PEBS-enabled counter overflows: the next retiring precise event atomically writes a record (EventingIP, GPRs, TSC, optional LBR/XMM/data-linear-address) into a PEBS buffer. Variants include classic PEBS, **PEBS-LL** (Load Latency, threshold via `MSR_PEBS_LD_LAT`, for cache-miss profiling with data-linear-address + DSRC fields), **Precise Store** (data-linear-address for store bottlenecks, since Haswell), **Adaptive PEBS** (variable-layout groups `basic/mem/gpr/lbr/xmm/ssp`), and **Timed PEBS / TPEBS** (retire-latency field, enabling Top-down Microarchitecture Analysis from a single `perf record` pass). `perf_event_attr.precise_ip` (0/1/2/3) selects non-precise, off-by-one PEBS, skidless PEBS, or PEBS with LBR rewound to the true eventing IP.

**AMD IBS (Instruction-Based Sampling)** inverts the model: it does not count to a threshold. Instead it **randomly tags** one fetch (IBS Fetch) or one dispatched op (IBS Op) per sampling interval and follows it through the pipeline, writing a record at retirement. IBS Op's op-count mode is explicitly *unbiased* across instruction mix (cycles mode is not). The records include retire latency, D-cache load/store addresses, branch targets, fetch latency, I-cache/ITLB details. Two dynamically-numbered PMUs expose this to `perf_event_open` at `/sys/bus/event_source/devices/ibs_{fetch,op}/type`.

**ARM SPE (Statistical Profiling Extension)**, since ARMv8.2, is the cleanest formulation. Post-decode hardware picks an op every `PMSIRR` ops (plus pseudo-random jitter) and lets it walk the pipeline; a record — virtual address + physical address + latency + data source + branch info — is written to an **AUX buffer** via the perf ring, reusing the Intel-PT plumbing added to Linux in 2015. Will Deacon's SPE patches (2017) merged upstream as `arm_spe_pmu`; production users today include Apple M-series, Neoverse servers, and AWS Graviton.

The trade-off axis is cost vs precision vs attribution granularity. Cost when off is zero (MSRs clear). Cost when on is dominated by the memory bandwidth of the record buffer — PEBS records range from 64 bytes to ~200 bytes; Adaptive / arch-PEBS can balloon with LBR+XMM+SSP groups. Granularity is per-retired-instruction with the true causing PC, plus data-source metadata that no non-precise PMU can provide. Without these, BOLT/Propeller/AutoFDO (`COMPILERS.md §26`) consumes systematically wrong profiles; with them, compiler feedback loops point at the right basic blocks. Contrast with §5.1 Intel PT (full control-flow trace, complementary) and §5.2 LBR (16/32-entry branch ring, often combined with PEBS records).

Skid is the *hardware* dual of the safepoint bias described in §2.4: both are "the sample's reported PC is not the PC that actually caused the event," expressed at different layers. PEBS/IBS/SPE fix the hardware layer; JEP 509 / async-profiler / AGCT fix the software layer; a new language needs both.

Sources: https://xem.github.io/minix86/manual/intel-x86-and-64-manual-vol3/o_fe12b1e2a880e0ce-711.html and https://lwn.net/Articles/521959/ and http://www.paradyn.org/petascale2013/slides/eranian13.pdf and https://www.amd.com/content/dam/amd/en/documents/archived-tech-docs/white-papers/AMD_IBS_paper_EN.pdf and https://github.com/jlgreathouse/AMD_IBS_Toolkit/blob/master/ibs_with_perf_events.txt and https://man7.org/linux/man-pages/man1/perf-arm-spe.1.html and https://lwn.net/Articles/711591/ and https://www.intel.com/content/www/us/en/developer/articles/technical/timed-process-event-based-sampling-tpebs.html

### 5.6. ARM Cortex-M ITM / SWO — Application Instrumentation on One Debug Pin

§5.3 covers CoreSight ETM (full program-flow trace over a dedicated parallel trace bus, aimed at post-hoc instruction reconstruction). The embedded-instrumentation companion is **ITM (Instrumentation Trace Macrocell)**, a bank of 32 memory-mapped stimulus registers at `0xE0000000` that firmware writes to directly. Each write is one store instruction (~1–6 cycles, plus an optional FIFO-full check via the read-back flag); the ITM packetizes the write with a timestamp, muxes it into the CoreSight ATB, and the TPIU/SWO serializer emits it on **one pin** (SWO) at typically 1–6 Mbps Manchester-coded, optionally higher over UART NRZ. No RAM buffer on the target, no interrupt, no trace-port pin budget.

The DWT (Data Watchpoint and Trace) unit feeds the same ITM fabric. Four DWT comparators provide hardware watchpoint events; `DWT->CYCCNT` is a free-running cycle counter; `DWT->PCSR` is a program-counter sample register the debug probe can poll over SWD to produce a PC histogram at zero CPU cost. This is the Cortex-M analogue of x86 LBR / PT — much lower fidelity, but similarly non-intrusive because the probe reads the registers through the debug interface, not through the CPU.

The trade-off is bandwidth vs pin budget. Cost when off is literally zero (`TRCENA` bit clear in `CoreDebug->DEMCR`; stimulus writes to disabled ports silently drop). Cost when on per event is a single 32-bit store plus an optional FIFO-stall if the SWO link saturates — ITM ports support blocking or drop-on-full per port. The ceiling is the SWO link itself (commonly ≤2 Mbit/s practical; SEGGER's measurements put sustained throughput around 0.3–1 MB/s). That is orders of magnitude below ETM's parallel trace port, but ETM requires 4–8 dedicated trace-port pins and a trace-capable debug probe.

**SEGGER RTT** is the counterpoint worth naming. Instead of serializing over a dedicated trace pin, the firmware writes to a RAM ring buffer, and the J-Link probe reads that RAM over the SWD debug link while the CPU runs — the Cortex-M debug AHB-AP supports coherent background memory access without halting. The cost is a small RAM buffer (~500 B ROM, ~1 KB RAM typical) and a `memcpy`-equivalent, but bandwidth jumps to 2 MB/s+ on a single standard debug pin with no TPIU/SWO clock configuration required. The broader mechanical argument worth extracting: **on architectures where the debug interface can do coherent background memory reads, treating the debugger as a polling consumer of a RAM buffer is strictly faster than any dedicated serial trace output short of full parallel trace.** See `DEBUGGERS.md §11.4` for the on-target debug-probe workflow (defmt, probe-rs, RTT/ITM consumption from the host side).

Sources: https://developer.arm.com/documentation/ddi0439/b/Instrumentation-Trace-Macrocell-Unit/ITM-functional-description and https://developer.arm.com/documentation/ddi0439/b/Data-Watchpoint-and-Trace-Unit and https://arm-software.github.io/CMSIS_6/v6.0.0/Core/group__ITM__Debug__gr.html and https://kb.segger.com/SWO and https://www.segger.com/products/debug-probes/j-link/technology/about-real-time-transfer/ and https://blog.segger.com/current-state-of-the-trace-market/

---

## 6. External Process Observation

Mechanisms where the observer runs in a separate process from the target and reads memory, intercepts syscalls, or captures a post-mortem snapshot — rather than injecting code into the target. The engineering challenge is getting a useful signal without the overhead of full ptrace, and without having to trust the stability of the target's address space when it may be corrupted.

### 6.1. py-spy / rbspy — External Process Memory Reading

py-spy (Python) and rbspy (Ruby) are sampling profilers that read the target process's memory from an external process using `process_vm_readv` (Linux), `vm_read` (macOS), or `ReadProcessMemory` (Windows). They do not inject any code, attach any debugger, or interrupt the target in any way.

Because interpreters like CPython and CRuby store their stack frames and thread state in process memory at known offsets, an external process can read those structures, decode the call stack, and produce a profile — all without the target knowing it is being observed. The overhead to the target is literally zero: no system calls, no signals, no ptrace attachment.

The trick only works for interpreters with predictable memory layouts. But the principle generalizes: if a VM stores its state in a known memory layout, an external observer can read it at any time without disturbing execution. Tristan Hume notes this could be extended to native programs: push context info onto a known data structure, and have an external process sample it via `process_vm_readv` or eBPF.

Sources: https://github.com/benfred/py-spy and https://thume.ca/2023/12/02/tracing-methods/

### 6.2. strace + seccomp-bpf — The Paradigmatic "Wrong Default" Tracer

`strace` is the canonical Unix syscall tracer and also the canonical example of a tracer whose default implementation has pathological overhead. It uses `ptrace(PTRACE_SYSCALL)`, which stops the tracee *twice per syscall* (entry and exit). Each stop is two context switches. The FOSDEM 2020 measurements (Syromiatnikov & Levin) show the canonical `dd`-style syscall-heavy workload at **37.37× slowdown** under plain strace.

The fix (strace 5.3+, GSoC 2018/2019 work by Paul Chaignon and others) is `--seccomp-bpf`: attach a seccomp-bpf cBPF filter that returns `SECCOMP_RET_TRACE` only for the syscalls the user asked about. Everything else runs native. The same benchmark drops to **1.475×** — a 25× reduction just from filtering in-kernel instead of in the tracer. Architectural footnote: seccomp filters are inherited by children but cannot be attached to an already-running process, so `strace -p PID --seccomp-bpf` cannot benefit — attach-to-existing still pays the double-stop.

The broader lesson is the cheap-guard / expensive-payload pattern (§1.5) retrofitted in-kernel: strace's original design fused the two and every syscall paid the ptrace cost regardless, while seccomp-bpf evaluates the filter inline and only takes the ptrace path for matching syscalls. The measured result is a 25× win with no change in observable semantics.

Sources: https://pchaigno.github.io/strace/2019/10/02/introducing-strace-seccomp-bpf.html and https://archive.fosdem.org/2020/schedule/event/debugging_strace_perfotmance/

### 6.3. ltrace — PLT Patching for Library-Call Tracing

`ltrace` is strace's analogue for library calls. Its classic mechanism is direct: overwrite the first instruction of each recognizable PLT (Procedure Linkage Table) trampoline with `int3` using `PTRACE_POKETEXT`. When the program reaches that trampoline, it traps into ltrace, which decodes arguments per the library's ABI, rewrites the original instruction back, single-steps, and reinstalls the `int3`.

The critical prerequisite is not lazy binding alone, but dynamically linked call sites that still pass through recognizable PLT/GOT stubs ltrace can patch or intercept. Lazy binding makes first-call interception straightforward, but `BIND_NOW` by itself does not necessarily remove all PLT calls. The broader problem is modern linking and hardening: `-fno-plt`, static linking, direct binding, symbol visibility, IFUNCs, PIE/toolchain changes, and ptrace restrictions all make ltrace fragile. The modern replacement path is eBPF uprobes (§1.7) attached to library symbols directly. This is a rare case where a classic Unix tool's mechanism became unreliable because the linking model around it changed.

Source: https://packagecloud.io/blog/how-does-ltrace-work/

### 6.4. Breakpad / Crashpad — Minidumps as the Minimal Crash Artifact

Every tracing mechanism in this document so far is *live*. The complementary modality is **post-mortem**: at the moment of crash, capture the minimal artifact needed to reconstruct state, and defer everything expensive to offline analysis. **Breakpad** (Google, 2007, used in Firefox, Chromium, many games) and its successor **Crashpad** (2014, now the Chromium default) embody this discipline.

The artifact is a **minidump**: register state, raw stack memory for each thread, loaded-module list, and a small number of metadata streams. No heap, no debuginfo. Everything symbolication-related happens *offline on a server* with access to separately-stored Breakpad symbol files (a line-oriented ASCII format converted from DWARF/PDB by `dump_syms`). The client-side artifact is small enough to upload from a crashed browser on a flaky network; the client-side code path stays minimal and allocation-free, which matters because the crashing process's address space may be corrupted.

Crashpad's load-bearing design choice is that the dump handler runs **out of process**. The application signals a separate handler; the handler suspends the crashed process from outside, snapshots its state into a minidump file, and only then lets the OS finish killing it. In-process dumpers are a gamble — if the crash scrambled the heap, any code that allocates is likely to re-crash before the dump is written. Snapshotting from a separate, non-crashing process sidesteps this entirely.

Relationship to Linux core dumps: a `core` file captures *entire* process memory (gigabytes on modern apps), has no structured metadata stream for arbitrary crash keys, and requires matching debuginfo on the analysis host. Minidumps are the opposite: application-curated "just enough to walk the stack and categorize the crash," with deliberate cost/fidelity trade-offs the application owner controls. They are also a *standardized interchange format* — the same file opens in Google's `minidump_stackwalk`, Microsoft's WinDbg, and LLDB's minidump support — which makes them closer to a universal crash-trace format than core dumps have ever been.

Sources: https://chromium.googlesource.com/crashpad/crashpad/+/HEAD/doc/overview_design.md and https://chromium.googlesource.com/breakpad/breakpad/+/HEAD/docs/stack_walking.md

---

## 7. Dynamic Binary Instrumentation

Techniques that translate every basic block before execution, rewrite instructions in place, or replace bytecode at class-load time — inserting instrumentation into unmodified binaries or managed artifacts. The cost is substantial (5–50× slowdown for full DBI, lower for specialized cases), but the visibility and the portability are unmatched: any binary, any architecture, no source, no recompilation, and in the case of APM agents (§7.6), an entire industry built on load-time bytecode rewriting.

### 7.1. Frida Stalker — Scriptable Dynamic Binary Instrumentation

Frida is a dynamic binary instrumentation toolkit that lets you hook into and rewrite running processes using JavaScript. Its "Stalker" engine does full dynamic recompilation: as each basic block is about to execute, Stalker copies it to a scratch buffer, inserts your instrumentation, and runs the instrumented copy. This is the same technique QEMU and Rosetta use for emulation, but exposed as a scriptable API.

You can:
- Trace every instruction, call, or return.
- Rewrite assembly as it runs (e.g., change branch targets, NOP out instructions).
- Attach JS callbacks to specific addresses.
- Follow execution across threads and even across processes.

The overhead is substantial (5–50x depending on the workload and density of instrumentation), but the power is unmatched: any binary, any architecture, no source code, no recompilation, scriptable in JavaScript.

The most creative use: fuzzing. fpicker attaches Frida Stalker to a target binary, instruments every basic block to update a coverage bitmap, and uses the coverage to guide a fuzzer — all without source code.

Source: https://frida.re/docs/stalker/

### 7.2. MAMBO — Low-Overhead DBI for ARM and RISC-V

MAMBO is a high-performance DBI tool specialized for ARM (AArch32, AArch64) and RISC-V. Unlike traditional instrumentation like DynamoRIO or PIN that often suffer from massive overhead, MAMBO utilizes dynamic recompilation interlaced with logging. It keeps the original code untouched (evading anti-debug tricks and checksums) while executing a heavily optimized cloned copy with tracing. It provides branch-level tracing capability with significantly lower overhead, ideal for embedded and RISC architectures.

Source: https://github.com/beehive-lab/mambo

### 7.3. E9Patch — Instruction Punning for Binary Rewriting

E9Patch is a static binary rewriter for x86-64 that inserts trampolines into compiled binaries without needing to move any existing instructions. This is hard on x86 because instructions are variable-length: a 5-byte jump overwrites multiple instructions, and some of those might be jump targets.

E9Patch solves this with three novel techniques:

- **Instruction punning:** Find addresses in the binary whose raw byte values also happen to be valid x86 NOPs or traps. Jump to those addresses as trampoline targets. The bytes were already there; they just weren't being used as code.
- **Padding:** Use `int3` padding between functions (common in compiled binaries) as trampoline space.
- **Eviction:** When no punning or padding target is available, evict a short instruction by copying it to the trampoline and replacing it with a jump.

The result: any instruction in a binary can be instrumented with zero relocation of surrounding code. This enables tools like E9AFL (fuzzing), E9Tool (tracing), and custom binary analysis passes.

The general principle: "patching" doesn't require dedicated NOP slots if you're creative about using existing bytes — repurposing existing data as executable code is a form of steganographic instrumentation.

Source: https://pldi20.sigplan.org/details/pldi-2020-papers/12/Binary-Rewriting-without-Control-Flow-Recovery

### 7.4. Cannoli — Multi-Core QEMU Trace Processing

Cannoli patches QEMU's TCG (Tiny Code Generator) JIT to log execution and memory events to a high-performance ring buffer. A Rust extension compiled as a shared library reads the ring buffer on separate cores, spreading the trace processing load across the machine.

Unlike single-threaded tracing tools, Cannoli can keep up with fast targets because the trace consumer runs in parallel with the traced program. The ring buffer acts as a decoupling layer: the traced program writes events without blocking, and the Rust consumer processes them at its own pace.

The trade-off: Cannoli is read-only — it observes but cannot modify execution. This simplifies the design enormously compared to full DBI frameworks like Frida. For tracing and analysis workloads (coverage, taint tracking, protocol reverse engineering), read-only is sufficient.

Source: https://thume.ca/2023/12/02/tracing-methods/ — "Cannoli" section.

### 7.5. PANDA — Whole-System Replay with Composable Offline Analysis

QEMU record/replay is covered from a debugger angle in `DEBUGGERS.md §2.4`. PANDA adds the most interesting missing layer: **analysis plugins designed to run on replayed executions**. PANDA is built on QEMU, but the crucial difference is that it couples whole-system record/replay with a reusable plugin ecosystem: `taint2` for dynamic taint analysis, `syscalls2` for syscall tracking, and `OSI` for guest OS introspection on Linux and Windows.

The original side is the plugin composition model. PANDA's plugin-to-plugin interface (PPP) lets plugins publish callbacks and APIs that other plugins consume. This means analyses are not monolithic; they are **assembled**. A file-taint analysis can reuse syscall tracking and OS introspection instead of re-implementing them. That is a much more scalable way to build deep analyses than the "single enormous analysis pass" style common in DBI research prototypes.

The other key design idea is temporal decoupling: record first with modest overhead, then run the expensive analysis offline on the replay. PANDA's own documentation explicitly recommends byte-level taint tracking on previously recorded systems because the live cost of such analyses is high. This is the same philosophy that makes rr/Pernosco powerful, but extended to the whole guest OS and packaged as a plugin platform.

The cost is the cost of emulation and whole-system setup. But as a design pattern — **record once, replay many times, compose heavyweight analyses on the replay** — PANDA is one of the best examples in the space.

Sources: https://panda.re/ and https://www.ndss-symposium.org/wp-content/uploads/bar2021_23001_paper.pdf

### 7.6. APM Auto-Instrumentation Agents — Managed-Runtime DBI at Class-Load

Status (as of 2026-04): commercial APM (DataDog, New Relic, Dynatrace, AppDynamics, Elastic APM) and open-source OpenTelemetry auto-instrumentation both rewrite application bytecode at class-load time to inject spans into unmodified third-party libraries. This is conceptually DBI at a coarser granularity than Frida Stalker (§7.1) or MAMBO (§7.2) — rewriting at the class-or-function boundary in managed runtimes instead of the basic block in native code.

The JVM entry point is **`java.lang.instrument`** via `-javaagent:foo.jar`. The agent JAR declares a `Premain-Class`, registers a `ClassFileTransformer` whose `transform(ClassLoader, String, Class, ProtectionDomain, byte[])` returns rewritten bytes before each class is defined, and optionally uses `retransformClasses` to patch already-loaded classes. The dominant rewriting library is **Byte Buddy** (Rafael Winterhalter), which wraps ASM the way LLVM wraps machine code: a declarative matcher DSL (`isPublic().and(named("someMethod"))`) plus `@Advice.OnMethodEnter` / `@Advice.OnMethodExit` annotations. The advice class is **a template copied byte-for-byte into the target method** — it cannot call helper methods on itself because it is inlined. OpenTelemetry, DataDog, New Relic, Dynatrace, and Elastic APM all sit on Byte Buddy for this reason.

The .NET analogue is the **CLR Profiling API**: `ICorProfilerCallback::JITCompilationStarted` plus `GetILFunctionBody` / `SetILFunctionBody` to swap IL before JIT. Python has no VM-level hook — agents rely on `sitecustomize.py` or `-m opentelemetry-instrument` wrapping, then `wrapt.ObjectProxy` to replace functions in already-imported modules. Ruby and Node rely on `require` / `import` ordering plus monkey-patching. The granularity difference matters: JVM and CLR agents can instrument arbitrary third-party JARs or DLLs without source or restart, while Python / Ruby / Node agents need their wrappers installed before the target is first imported.

The production-safety story hinges on **Muzzle** (DataDog, adopted by OpenTelemetry): each instrumentation declares the external symbols it touches, and at agent startup a reference-matcher validates them against the actual user classpath, silently skipping instrumentations whose target version doesn't match. This is what makes these agents deployable by operators who do not know which library versions the application actually uses. Class-loader isolation is the mirror image of Frida's target-hiding (§7.1): the agent ships its own SDK and rewriter library in an isolated classloader so the application's own classloader cannot see them and cannot version-conflict with the application's own dependencies.

The design lesson: **span injection without source changes, via load-time bytecode rewriting in managed runtimes**, is the dominant production path for APM adoption. It is DBI (§7.1, §7.2) reframed for a world where the "binary" is `.class` / `.dll` / `.pyc` and the "basic block" is a method. Cross-link §2 Cooperative Safepoints (class retransformation in HotSpot uses safepoints for the swap) and §12.3 OpenTelemetry (agents are where OTEL semantic conventions actually get populated for applications that weren't written with OTEL in mind).

Sources: https://docs.oracle.com/en/java/javase/21/docs/api/java.instrument/java/lang/instrument/Instrumentation.html and https://bytebuddy.net/ and https://github.com/open-telemetry/opentelemetry-java-instrumentation/blob/main/docs/contributing/javaagent-structure.md and https://github.com/DataDog/dd-trace-java/blob/master/docs/how_instrumentations_work.md and https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/profiling/icorprofilercallback-interface and https://opentelemetry.io/docs/zero-code/python/

---

## 8. Shadow State and Compiler-Inserted Checks

Mechanisms that maintain a parallel *shadow* of every piece of program state — each byte's addressability and definedness, each access's happens-before clock, each integer operation's overflow-free-ness — and verify it on every operation. The cost is always-on and heavy (2–50× slowdown depending on the tool), but the information is uniquely thorough: every byte is tracked, every invariant is checked, and the family composes with coverage-guided fuzzing (§9) to form the most effective automated bug-finding pipeline in current practice.

### 8.1. Valgrind Memcheck — Shadow Memory

Valgrind's Memcheck tool maintains a "shadow" for every byte of memory in the program. Each byte has two shadow bits: an "A" (addressability) bit indicating whether the byte is legally accessible, and "V" (validity) bits indicating whether the byte's value is defined.

Every memory operation — load, store, arithmetic — is instrumented by Valgrind's dynamic binary translator (VEX) to propagate shadow state. If an undefined value flows into a branch condition or a syscall argument, Memcheck reports it.

The overhead is 10–50x slowdown, which is enormous. But the technique — maintaining a parallel "shadow" of every piece of program state — is conceptually powerful. It is the most thorough form of runtime verification: every byte is tracked, every operation is checked. Shadow memory has been adapted for other tools: taint tracking (which bytes came from untrusted input?), race detection (which bytes were accessed by multiple threads?), and type tracking.

The general principle — "for every real thing, maintain a shadow thing with metadata" — applies far beyond memory checking. Applied to a bytecode VM, a shadow buffer tracking "which instructions have been executed" or "what was the last value produced here" is the same idea at a different granularity.

Source: https://valgrind.org/docs/shadow-memory2007.pdf

### 8.2. AddressSanitizer (ASan) — Shadow Memory for Memory Safety

AddressSanitizer (Google, 2012) detects memory errors at runtime using compiler instrumentation and shadow memory. The compiler inserts checks before every memory access, and a runtime library manages a shadow memory map that tracks which bytes are valid to access.

The shadow memory scheme maps every 8 bytes of application memory to 1 byte of shadow memory. The shadow byte encodes how many of the 8 bytes are accessible (0 = all 8 accessible, k = first k accessible, negative = all inaccessible for various reasons). Before every load/store, the compiler inserts:

```
shadow_value = *(shadow_base + (addr >> 3))
if (shadow_value != 0 && (shadow_value <= (addr & 7)))
    report_error()
```

This instrumentation adds one shadow-memory load plus compare/branch logic before the original application load/store; if counting the application access too, the fast path is effectively two memory accesses plus a branch. ASan detects use-after-free (by poisoning freed memory and quarantining it), heap/stack/global buffer overflows (by inserting poisoned "red zones" around allocations), and use-after-return.

### 8.3. ThreadSanitizer, MemorySanitizer, UBSan — The Sanitizer Family

The sanitizer family extends the shadow memory concept:

- **ThreadSanitizer (TSan)**: detects data races by maintaining a shadow "happens-before" clock per memory location. Every read/write records the thread's vector clock; conflicting unsynchronized accesses are reported. Overhead: 5–15x slowdown, 5–10x memory.
- **MemorySanitizer (MSan)**: detects use of uninitialized memory by tracking "definedness" bits — similar to Valgrind's V-bits but implemented via compiler instrumentation rather than binary translation, achieving 3x overhead vs Valgrind's 20x.
- **UndefinedBehaviorSanitizer (UBSan)**: detects undefined behavior (signed integer overflow, null pointer dereference, misaligned access) via targeted compiler checks. Overhead: <5%, making it viable for production use.

The key insight: compiler-based instrumentation is dramatically cheaper than binary translation (Valgrind) because the compiler knows which accesses need checking and can optimize the checks. ASan's 2x overhead vs Valgrind's 20x is the difference between "run it during development" and "run it only when desperate."

All sanitizers are integrated into Clang/LLVM and GCC. They compose with coverage-guided fuzzing (§9) to form the most powerful automated bug-finding pipeline available.

Sources: https://github.com/google/sanitizers/wiki/addresssanitizeralgorithm and https://releases.llvm.org/20.1.0/tools/clang/docs/AddressSanitizer.html

---

## 9. Coverage-Guided Fuzzing

Not tracing in the observability sense, but close cousins: the instrumentation primitives are the same compile-time coverage bitmaps and sanitizer callbacks that the rest of this document describes, and the technique composes with §8 shadow state to systematically explore input space until a crash is observed. Worth naming as a mechanism family because it illustrates how the same instrumentation surface can drive very different workflows — observation in §§1–8, search in §9, causal attribution in §10.

### 9.1. AFL / libFuzzer — Mutation + Coverage Feedback

Coverage-guided fuzzing combines random input mutation with code coverage feedback to systematically explore program behavior. The fuzzer maintains a corpus of inputs and repeatedly:

1. Picks an input from the corpus.
2. Mutates it (bit flips, byte insertions, dictionary-based substitutions, splice with another input).
3. Runs the target program with the mutated input.
4. Measures code coverage (which basic blocks/edges were executed).
5. If the mutated input discovered new coverage, adds it to the corpus.

**AFL** (Zalewski, 2013) pioneered this approach using compile-time instrumentation that updates a shared-memory coverage bitmap (64KB) at each branch. The bitmap hashes `(prev_block ^ curr_block)` to record edge transitions. AFL can process thousands of executions per second and has found thousands of security vulnerabilities in real-world software.

**libFuzzer** (LLVM) takes an in-process approach: the fuzzer and target run in the same process, avoiding the `fork()/exec()` overhead of AFL. This enables millions of executions per second for small targets. libFuzzer uses LLVM's SanitizerCoverage instrumentation for feedback.

The combination of fuzzing + sanitizers is transformative: fuzzing generates inputs that explore new code paths, and sanitizers detect subtle bugs (buffer overflows, use-after-free, data races) that would otherwise produce no observable symptom. Google's OSS-Fuzz runs continuous fuzzing on 1,000+ open-source projects, finding 10,000+ bugs.

A compiler that can instrument code for coverage feedback (as LLVM's SanitizerCoverage does) gives fuzzing support for free. A language runtime with built-in coverage tracking enables fuzzing without compiler modifications.

Sources: https://llvm.org/docs/LibFuzzer.html and https://lcamtuf.coredump.cx/afl/

---

## 10. Causal Profiling

Traditional profilers answer "which line took the most time?" Causal profilers answer "which line, if optimized, would most speed up the program?" — a qualitatively different question. The mechanism (virtual speedup via orchestrated pauses) is strange enough to stand as its own family.

### 10.1. Coz — Causal Profiling via Virtual Speedup

Coz does the causal trick by *virtually speeding up* a line of code — not by making it faster, but by making everything else slower. It inserts microsecond-scale pauses into all threads *except* when they are executing the target line. The effect on relative performance is the same as if the target line had actually been optimized.

By running the program many times with different virtual speedup amounts (0% to 100%) applied to different lines, Coz builds a profile showing the causal relationship between each line's performance and the program's overall throughput or latency.

Traditional profilers tell you where time is spent. Coz tells you where time *matters*. A line that takes 30% of total time might yield 0% speedup when optimized (because something else is the bottleneck), while a line taking 2% of total time might yield 20% speedup (because it is on the critical path). Only causal profiling can distinguish these cases.

Mean overhead is ~17%. The technique requires "progress points" — markers where the developer indicates meaningful work completion (e.g., end of a request, end of a frame). This is a small annotation burden but essential for defining what "throughput" means.

Sources: https://web.cs.umass.edu/publication/docs/2014/UM-CS-2014-010.pdf and https://blog.acolyer.org/2015/10/14/coz-finding-code-that-counts-with-causal-profling/

---

## 11. Trace Storage and Visualization

The downstream half of tracing: once events are captured, what data structure holds them, what wire format carries them, and what UI makes them comprehensible. The recurring design pattern across entries is **level-of-detail aggregation** — a billion events must render at 60fps when zoomed out and precisely at zoom-in, which forces pre-aggregation at write time rather than post-hoc work at read time. Flame graphs (§11.3) and off-CPU flame graphs (§11.4) are included here because they are visualization techniques with specific data-shape requirements, not captures in their own right.

### 11.1. Implicit In-Order Forests — Billion-Event Trace Visualization

Tristan Hume developed a data structure called "implicit in-order forests" for rendering billion-event trace timelines at 60fps. The problem: a standard trace viewer must draw millions of rectangles when zoomed out, which overwhelms both the CPU and GPU.

The solution: pre-aggregate trace events into a tree structure where each level represents a different zoom level. When zoomed out, only the aggregated nodes at the appropriate level are drawn. When zoomed in, individual events are drawn. The tree is implicit (stored in a flat array with computed indices, no pointers) and in-order (events are arranged depth-first, matching the temporal order), giving excellent cache locality.

Combined with a virtual-memory-based growable array, appends have O(log N) worst-case latency instead of O(N) for standard dynamic arrays. This makes the structure suitable for live trace recording — events can be appended in real time while the viewer renders the accumulated data.

The general principle: trace data structures should be designed for the access pattern of visualization (zoom = level-of-detail query), not for the access pattern of recording (sequential append). Pre-aggregation at write time eliminates work at read time.

Source: https://thume.ca/2021/03/14/iforests/

### 11.2. Perfetto, Fuchsia Trace Format, and the Universal-Viewer Pattern

**Perfetto** (Google, 2018, open-source) is a production system-wide tracing platform with three layers: an instrumentation SDK, a tracing service that multiplexes producers into buffers, and a web UI that renders protobuf-formatted traces. Because the wire format is documented, kernel ftrace converters, eBPF probes, runtime events, and custom application instrumentation can all land in the same zoomable timeline.

The **Fuchsia Trace Format (FTF)** illustrates the producer-side half of the universal-viewer pattern: use a compact emission format where hot-path cost matters, then convert into Perfetto `TracePacket` or another interchange format for storage and visualization. Chrome trace JSON remains the older import-friendly path. The important distinction is capture format vs viewer format; they do not have to be identical.

The meta-insight is architectural: the tracing ecosystem is fragmented across dozens of capture tools, but they become composable if they can export to a common viewer or wire format. Perfetto plays that role for timelines, much as pprof (§14.2) does for profiles and CTF (§3.7) does for structured event streams. The SQL/query side of Perfetto is covered from the debugger-analysis angle in `DEBUGGERS.md §2.12`.

Sources: https://perfetto.dev/ and https://perfetto.dev/docs/reference/trace-packet-proto and https://thume.ca/2023/12/02/tracing-methods/

### 11.3. Flame Graphs — Brendan Gregg's Alphabetical-Merge Trick

A flame graph (Brendan Gregg, 2011; formalized in ACM Queue / CACM 2016) renders a set of sampled stack traces as a tree of horizontal bars — leaf frames at the top, root at the bottom, bar width proportional to sample count. The visualization has become ubiquitous in profilers (perf, pprof, async-profiler, Pyroscope, Datadog), and the reason is one specific design choice: **frames at each depth are sorted alphabetically, not temporally**. This is not a default, it *is* the trick. Alphabetical ordering means that identical call paths arriving from different samples merge into one wide bar, so width becomes a direct visual analog of sample count. Without the merge, 2 million samples landing in `memcpy` via 17 different call chains would appear as 17 narrow columns you cannot see; with it, they appear as one dominant bar.

The trade-off is explicit: **temporal information is discarded**. Flame *charts* (Chrome DevTools style) keep time on the x-axis and lose the merging benefit. For "which function dominated this trace?" flame graphs win overwhelmingly; for "what was the sequence of operations?" flame charts and timeline views (§11.1, §11.2) are the right tool.

Three Gregg variants add substantial diagnostic power without changing the rendering pipeline:

- **Differential flame graphs** compute two profiles (before/after), render using profile B, and color each frame by the signed delta in sample count vs profile A. Red = grew, blue = shrank. This turns regression hunting into visual diff — much more scalable than comparing two `perf report` outputs side-by-side.
- **Icicle graphs** flip the root to the top and the leaves to the bottom. Same data, inverted orientation; useful when the dominant signal is near the root (which subsystem's entry point consumes the most time).
- **Sandwich view** (popularized by speedscope): pick a function, render all *callers* above and all *callees* below. Derived from the same folded-stack data as the main flame graph.

Modern renderers (speedscope, pprof `-http`, flamegraph.com, Grafana Phlare, Perfetto) all re-implement the same stack-collapse + alphabetical-sort + SVG-or-Canvas-rectangle recipe. The input to every one of them is Gregg's "folded stack" format — one stack per line, frames separated by semicolons, trailing count. That this plain-text format survived for 15 years as the interchange standard is itself a design insight.

Sources: https://www.brendangregg.com/flamegraphs.html and https://queue.acm.org/detail.cfm?id=2927301 and https://github.com/brendangregg/FlameGraph and https://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html

### 11.4. Off-CPU Flame Graphs — The Dual of On-CPU Sampling

On-CPU flame graphs (§11.3) sample *running* threads at a fixed frequency, so they show where a program *spends* CPU. They cannot see anything blocked: lock contention, synchronous I/O waits, scheduler latency, `select`/`epoll` stalls. These are invisible because a blocked thread is not on a CPU to be sampled.

**Off-CPU analysis** (Brendan Gregg) swaps the data source. Instead of sampling running threads, it instruments the scheduler's context-switch path and records *blocked* time. The canonical eBPF implementation attaches to `finish_task_switch()` — which runs in the context of the *next* thread, so you have the departing thread's TID plus a high-resolution timestamp, and the departing thread's stack hasn't moved since it blocked. A single probe captures both the off-CPU duration and the stack that caused the block. In-kernel aggregation into a BPF map (key = stack-id, value = summed nanoseconds) keeps only summaries — essential because scheduler events scale with load (100K–1M/s on a busy machine) and dumping every event is prohibitive.

The resulting "off-CPU flame graph" uses the same rendering as §11.3 but with width = blocked nanoseconds, not CPU nanoseconds. The two visualizations are duals: together, they account for every moment in every thread's life — either on-CPU doing work, or off-CPU waiting for something. A common production finding is that a service's p99 latency is dominated by off-CPU time (a single slow-acquired lock or a `read()` that unexpectedly blocked), which a traditional on-CPU profiler reports as nothing at all.

The caveat Gregg emphasizes: off-CPU and on-CPU widths are not directly comparable. On-CPU time has a fixed budget of N seconds × M cores per wall-clock second; off-CPU time is unbounded (a thread can be blocked for arbitrary duration). The two flame graphs should be read independently, not subtracted or merged. Wakeup-stack analysis (who unblocked this thread?) is the natural follow-up and remains an active area.

Sources: https://www.brendangregg.com/offcpuanalysis.html and https://www.brendangregg.com/FlameGraphs/offcpuflamegraphs.html and http://brendangregg.com/blog/2016-01-20/ebpf-offcpu-flame-graph.html

---

## 12. Distributed Tracing & Observability

Mechanisms for tracing a single logical request across service boundaries — the layer where HTTP calls, message queues, and RPCs fragment one user intent into many machine-local events. The engineering challenge is propagating causal context across language, transport, and organizational boundaries while sampling at rates that scale to whole-fleet volumes. Entries trace the lineage from Dapper (the origin) through sampling-strategy evolution (head → tail → consistent probability) to OpenTelemetry (the current standard) and Pivot Tracing (the research counterpoint).

### 12.1. Google Dapper — The Origin of Distributed Tracing

Sigelman et al.'s "Dapper, a Large-Scale Distributed Systems Tracing Infrastructure" (Google Technical Report, 2010) is the founding paper for request-path tracing across service boundaries. The system targets three non-negotiable constraints: **low overhead** (every instrumented RPC pays the cost), **application-level transparency** (achieved by instrumenting Google's small set of shared RPC, threading, and control-flow libraries — application code is not modified), and **ubiquitous deployment** (every binary in production uses the shared libraries, so coverage is fleet-wide by default). The span / trace-tree model that underlies every modern distributed tracer (OpenTelemetry, Zipkin, Jaeger, Datadog APM) is Dapper's contribution.

The paper's central engineering claim is that at Google scale, tracing every request is not just expensive — it is *statistically pointless*. Uniform low-rate sampling (Google's default was around one trace per thousand in 2010) preserves aggregate fidelity for the questions operators actually ask, which are about distributions and outliers, not individual requests. The design consequence is that **the sampling decision is made at the trace root and propagated** via the trace ID itself — every downstream service independently sees the same in/out decision without coordination. This "head-based sampling" remains the dominant model 15 years later and is the direct ancestor of OpenTelemetry's `TraceIdRatioBased` + `ParentBased` samplers.

The lineage worth naming briefly: Dapper (2010, Google-internal) → **Zipkin** (Twitter Hack Week 2012, effectively "Dapper for Thrift" on Finagle/Scribe/Cassandra) → **OpenTracing** (2016, vendor-neutral API) and **OpenCensus** (2017, Google's combined tracing+metrics library) → **Jaeger** (Uber 2017, Go rewrite with push architecture, later a CNCF hosted project) → **OpenTelemetry** (2019, CNCF-brokered merger of OpenTracing and OpenCensus, covered in §12.3).

Sources: https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/ and https://static.googleusercontent.com/media/research.google.com/en//archive/papers/dapper-2010-1.pdf and https://blog.x.com/engineering/en_us/a/2012/distributed-systems-tracing-with-zipkin and https://www.uber.com/us/en/blog/distributed-tracing/

### 12.2. Head-Based vs Tail-Based Sampling

Dapper's head-based sampling (§12.1) is cheap — decide once at the trace root, propagate via trace ID, no buffering — but it cannot retain rare tails. "Sample every trace that errored or exceeded 1s p99" is impossible at the root because the root does not yet know the outcome. **Tail-based sampling** addresses this directly: buffer every span of every trace in a decision window (typically 5–30 seconds), evaluate a policy against the completed trace, and *then* decide what to retain. The OpenTelemetry Collector's `tailsamplingprocessor` is the reference implementation.

The trade-off is buffering cost. Head-based pipelines scale trivially — every service drops unsampled traces at emission time — but can systematically miss the bugs operators most want to see. Tail-based pipelines catch outliers cleanly but require centralized buffering (all spans of a trace must converge at the same collector) and force trace re-assembly. Production pipelines commonly chain both: probabilistic head sampling at the edge to protect aggregate volume, then tail policies at the collector to preserve errors, latency outliers, and explicit business-event flags.

The **Consistent Probability Sampling** extension (OpenTelemetry TraceState spec) encodes a rejection threshold `T` directly in TraceState so downstream tiers can *lower* but not *raise* the sampling rate consistently with the root's decision. This is the modern refinement of Dapper's trace-ID-based sampling: a hierarchical sampling pipeline that preserves probability coherence end-to-end, rather than letting each tier roll its own dice.

Sources: https://opentelemetry.io/docs/concepts/sampling/ and https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/ and https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor

### 12.3. OpenTelemetry — The Observability Standard

Status (as of 2026-04): OpenTelemetry (OTEL) is the de facto standard for distributed tracing, metrics, and logging across service boundaries. It defines:

- **Traces**: a tree of spans representing the path of a request through a distributed system. Each span has a trace ID, span ID, parent span ID, start/end timestamps, attributes (key-value metadata), and events (timestamped log entries within a span).
- **Context propagation**: trace context (trace ID, span ID, trace flags) is serialized into HTTP headers (W3C Trace Context format: `traceparent: 00-{trace_id}-{span_id}-{flags}`) and propagated across service boundaries. Each service extracts the context, creates a child span, and propagates the updated context to downstream calls.
- **Baggage**: arbitrary key-value pairs that propagate alongside trace context — enabling cross-cutting concerns like tenant ID, feature flags, or user ID to flow through the entire request path without explicit parameter passing.

The architecture separates concerns:
- **API**: language-specific interfaces for creating spans and propagating context. Applications code against the API.
- **SDK**: configurable implementation that batches, samples, and exports telemetry data. Swappable exporters send data to backends (Jaeger, Zipkin, Datadog, Grafana Tempo).
- **Collector**: a standalone process that receives, processes, and forwards telemetry data — acting as a proxy between applications and backends.

OTEL has become the de facto standard, with official SDKs for Go, Java, Python, JavaScript, Rust, C++, .NET, Ruby, PHP, Swift, and Erlang/Elixir. Cloud providers (AWS, GCP, Azure) and observability vendors have converged on OTEL as the common wire format.

The connection to language design: if a language runtime provides built-in context propagation (similar to Racket's continuation marks, covered in `DEBUGGERS.md §3.6`, or Go's `context.Context`), distributed tracing becomes a first-class capability rather than a library concern. The runtime can automatically create spans for function calls, propagate context across async boundaries, and correlate traces with local profiling data.

Sources: https://opentelemetry.io/docs/concepts/signals/traces/ and https://opentelemetry.io/docs/concepts/context-propagation/

### 12.4. Pivot Tracing — Dynamic Queries Over Distributed Causality

Mace, Roelke, and Fonseca's "Pivot Tracing" (SOSP 2015) is a research counterpoint to static-span systems like OpenTelemetry. Instead of the developer deciding *at instrumentation time* what spans to create and what attributes to attach, users write **tracing queries at runtime** — declarative statements about what data to collect at which points in the system — and Pivot Tracing installs dynamic probes on the fly (DTrace-style, §3.6) across every node that participates.

The load-bearing primitive is the **happened-before join** (`⋈→`), a relational operator that joins two tuple streams by Lamport's happened-before relation. Example: "join every HDFS read with the user ID of the client that caused it." Naively, this requires correlating events from multiple machines after the fact. Pivot Tracing evaluates it inline by propagating **baggage** alongside each request through the RPC graph — when the first event (user-ID) fires it writes to baggage; when the second event (HDFS-read) fires it reads from baggage and emits the joined tuple. No central event log, no post-hoc correlation pass, no pre-planning which attributes to record.

The design insight worth preserving for a language-design audience: **baggage + dynamic probes** is a viable primitive stack for *retroactive* questions ("which tenant's traffic caused this disk-read latency spike?"), not just pre-declared spans. This is qualitatively different from OpenTelemetry, where every attribute a trace can carry must be added to the instrumentation ahead of time. The cost-when-off is effectively nil (no probes installed); cost-when-on scales with baggage size and probe frequency. It remains a research system, not a production one, but as a data point for "what could static-span tracing be replaced with?" it is the cleanest example.

Sources: https://sigops.org/s/conferences/sosp/2015/current/2015-Monterey/printable/122-mace.pdf and https://doi.org/10.1145/2815400.2815415

---

## 13. Sampling Profilers: Substrates and Stack Unwinding

Every sampling profiler — perf, pprof, async-profiler, py-spy, Parca, VTune — is built on two primitives: first, *interrupt or observe a thread often enough to get statistically useful samples*; second, *given that snapshot, reconstruct the call stack*. The choice of sampling substrate determines bias, delivery cost, signal-safety constraints, and lost-sample behavior. The choice of unwinding mechanism determines whether production sampling is viable once a sample has been taken. This section catalogs both layers, with the main trade-off axis for unwinding being **cost-at-walk-time vs cost-at-steady-state**.

### 13.1. Statistical Sampling Substrates — Timers, PMU Overflows, Signals, and Ring Buffers

Before a profiler can unwind anything, it needs a reason to take a sample. The classic Unix substrate is timer-driven signal delivery: `setitimer(ITIMER_PROF)` or POSIX timers raise `SIGPROF` against a running thread after some amount of CPU time or wall time. The profiler's signal handler captures the interrupted PC/register state, optionally walks the stack immediately, and records a compact sample. This is portable and simple, but it inherits every signal-handler constraint: the handler must avoid allocation, locks, most runtime APIs, and any operation that is not async-signal-safe.

Linux `perf_event_open` generalizes the substrate. A perf event can be a counter (read occasionally for an aggregate) or a sampled event (write records into an `mmap` ring buffer on overflow). The trigger can be time, CPU cycles, instructions, cache misses, branch misses, context switches, software events, or precise PMU events such as PEBS/IBS/SPE (§5.5). The ring-buffer model decouples sample production from userspace consumption: the kernel writes records into per-event buffers, and the profiler drains them asynchronously.

This layer introduces its own failure modes. Sampling by frequency ("99 Hz") and sampling by period ("every 1,000,000 cycles") answer different questions. High rates can be throttled by the kernel, overflow buffers, or perturb cache behavior enough to bias the workload. Hardware event sampling can suffer skid: the sampled PC may be near, but not exactly at, the instruction that caused the event, unless precise sampling support is available. Signal-based profilers can deadlock themselves if they try to walk runtime metadata protected by locks held by the interrupted thread.

For a new language, the design pattern is to separate **sample trigger**, **sample transport**, and **stack attribution**. The runtime may expose a safe self-sampling path, register code metadata so external profilers can unwind it, or provide a per-thread/per-CPU ring buffer for samples. Whatever the choice, the profiler must report lost samples and throttling explicitly; silent drops are worse than lower sample rates.

Sources: https://man7.org/linux/man-pages/man2/perf_event_open.2.html and https://www.brendangregg.com/perf.html and https://man7.org/linux/man-pages/man2/setitimer.2.html and https://man7.org/linux/man-pages/man7/signal-safety.7.html

### 13.2. Frame Pointers — Zero Walk Cost, 1–3% Steady-State Tax

The classical method: every function prologue saves the caller's frame pointer (e.g., `push %rbp; mov %rsp, %rbp` on x86-64), so the stack is a linked list of frames that can be walked by following `rbp` → `rbp` → `rbp` until null. Walking is a handful of instructions per frame, safe from a signal handler, requires no metadata at all.

The cost is structural: one general-purpose register is reserved for the frame pointer (instead of being available to the register allocator), and every non-leaf function pays two extra instructions on entry/exit. Measured steady-state overhead on typical workloads is 1–3%. For two decades GCC/Clang defaulted to `-fomit-frame-pointer`, reclaiming the register for performance.

In 2022–2024 this consensus reversed. **Fedora 38** (April 2023) and **Ubuntu 24.04** (April 2024) shipped with frame pointers re-enabled by default, with Canonical and Red Hat both publishing detailed rationales: the 1–3% cost is paid once across the distribution, but the *diagnostic* value — continuous profiling, production flame graphs, and crash stack traces that actually work — is paid in dividends for every debugging session, for every user. Python followed with PEP 831 (frame pointers for CPython). Brendan Gregg's "The Return of the Frame Pointers" (2024) is the definitive narrative.

Sources: https://fedoraproject.org/wiki/Changes/fno-omit-frame-pointer and https://ubuntu.com/blog/ubuntu-performance-engineering-with-frame-pointers-by-default and https://www.brendangregg.com/blog/2024-03-17/the-return-of-the-frame-pointers.html and https://peps.python.org/pep-0831/

### 13.3. DWARF `.eh_frame` / CFI — Zero Tax, Expensive Walk

DWARF Call Frame Information (CFI) — shipped in every ELF binary's `.eh_frame` section for exception unwinding — describes how to recover each frame's caller by executing a **bytecode program**. The instructions describe where the caller's registers are saved relative to the current CFA (Canonical Frame Address), which itself can be computed by an arbitrary expression over the current register file.

The design win: zero steady-state cost. Registers and instructions are unperturbed; the metadata is read only when unwinding actually happens.

The design cost: the unwind rules are an expressive stack-machine / interpreted program, and every frame requires evaluating its FDE (Frame Description Entry) instructions. In practice, walking a DWARF stack from a signal handler is so slow that it can dominate the profile of the profiler itself. Red Hat's unwinder deep-dive reports DWARF walking is roughly 20–40× slower than frame-pointer walks. Ian Lance Taylor's `.eh_frame` series explains why: the bytecode was designed for exception-handling correctness, not sampler-friendly speed.

Sources: https://developers.redhat.com/articles/2023/07/31/frame-pointers-untangling-unwinding and https://www.airs.com/blog/archives/460

### 13.4. Linux ORC Unwinder — DWARF Without the Bytecode

Josh Poimboeuf's **ORC** (Oops Rewind Capability) unwinder, merged into Linux 4.14 (2017), replaced DWARF for in-kernel unwinding. The motivating constraint was political (Linus Torvalds rejected a full DWARF state-machine interpreter in the kernel) and practical (DWARF is too slow and too complex to run safely from interrupt context). ORC's design: a purpose-built static unwind table, emitted at build time by the `objtool` static analyzer, storing only what a kernel unwinder actually needs — CFA offset, frame pointer recoverability, return-address location — and no bytecode.

Measured speedup vs DWARF in the kernel is 20–40×. The space cost is an extra ~1.3 MB per kernel build. The conceptual win is that **objtool validates unwind correctness statically** — if the kernel's code doesn't admit a consistent unwind table, the build fails. This is a design pattern worth naming: when unwinding is load-bearing, emit the table as a *first-class build output* validated by a static analyzer, rather than trusting whatever the compiler happened to emit.

Sources: https://www.kernel.org/doc/html/latest/arch/x86/orc-unwinder.html and https://lwn.net/Articles/728339/ and https://lwn.net/Articles/727553/

### 13.5. SFrame — DWARF Minus Everything DWARF Doesn't Need

**SFrame** (Indu Bhagat / Oracle, in binutils 2.40+, glibc 2.39+) brings the ORC philosophy to userspace. It is a new unwind-table format designed for *sampling profilers*, not exception handling. The core design choice: encode only CFA / FP / RA per PC range, binary-searchable, ~8 bytes per FDE row. No general bytecode interpreter. No callee-saved-register recovery (samplers don't need it). No support for arbitrary CFI programs (compilers that emit complex CFI must either simplify or fall back to DWARF).

The result is a metadata format whose fast-path walk is comparable to frame-pointer walking — fast enough to use from a signal handler at sustained sampling rates — without the 1–3% steady-state tax. The trade-off: SFrame cannot unwind through all the edge cases DWARF handles (signal trampolines, hand-written assembly, exotic calling conventions), so a production profiler needs a fallback path when SFrame is absent. The SFrame and frame-pointer communities are converging on a "both/either" model: ship both, let the sampler pick per thread.

Sources: https://sourceware.org/binutils/docs/sframe-spec.html and https://blogs.oracle.com/linux/beyond-eh-frame-frame-pointers-the-technical-underpinnings-of-sframe and https://lwn.net/Articles/930622/ and https://maskray.me/blog/2025-10-26-stack-walking-space-and-time-trade-offs

### 13.6. LBR Call-Stack Sampling — Hardware Shortcut

Intel's Last Branch Record ring buffer (introduced in §5.2 as a TSX debugging tool) can also be used as a zero-cost stack-unwinding shortcut. `perf record --call-graph lbr` configures the PMU so that on each sample, the CPU hands the kernel the last 16 or 32 taken branches — which is *already* the call chain the profiler wants, with no metadata lookup, no frame-pointer walk, no DWARF interpretation.

Cost: the branch ring buffer is continuously updated in hardware; enabling it has a measurable but small overhead on branch-intensive code. Walk cost: zero (the data is already in the sample). The critical limitation is **stack depth**: hardware caps the recorded history at 16 or 32 branches, which is often shallower than real-world call chains, so flame graphs generated from LBR samples are systematically truncated near the root. For many workloads this is acceptable; for deeply-nested code (enterprise frameworks, interpreters with dispatch chains) it is not.

LBR-based sampling sits at the "zero-cost walk" endpoint of the spectrum. It is complementary to frame pointers and SFrame — a production system can prefer LBR when branches fit, fall back to FP/SFrame when they don't.

Source: https://lwn.net/Articles/619180/. See §5.2 for the underlying LBR mechanism.

### 13.7. Go's Unconditional Frame-Pointer Discipline

Go made frame pointers a default-on runtime policy for its most important production architectures, starting with amd64 in Go 1.7 and expanding/solidifying support on other architectures over time. There is no ordinary `-fno-omit-frame-pointer` style user knob for Go code. The decision was measured — the Go team quantified the cost at roughly 1–3% on representative workloads and deemed it acceptable in exchange for Go binaries being continuously profilable, crash-traceable, and compatible with external profilers without requiring full debug-info distribution. This is a language-level policy choice, not just a compiler flag.

The dividend compounds. Felix Geisendörfer's 2023 work on Go's execution tracer (§3.5) reduced its runtime overhead from ~20% to under 1% almost entirely by switching the tracer's stack capture from its previous mechanism to frame-pointer walks. That speedup is only available because *every* Go binary has frame pointers; a tracer that had to probe for them, or fall back to DWARF, could not achieve the same baseline.

For a new language: "always emit frame pointers" is the single most consequential profilability decision. The 1–3% cost is measurable; the cost of not making it is a decade of tool-author workarounds (see §2.4 on async-profiler). The decision is cheapest when made on day one — retrofitting FP discipline onto an established ABI is much harder.

Sources: https://go.googlesource.com/proposal/+/master/design/24543-non-cooperative-preemption.md and https://blog.felixge.de/reducing-gos-execution-tracer-overhead-with-frame-pointer-unwinding/

---

## 14. Continuous Profiling

Classical profiling is point-in-time: run `perf` on one box when it's slow, save the flame graph, close the terminal. **Continuous profiling** is the qualitatively different discipline of *always-on, statistically-sampled, fleet-wide* profiling — designed to be left running in production indefinitely, aggregating across thousands of instances, and attributing performance trends back to code changes.

### 14.1. Google-Wide Profiling — The Founding Paper

Ren et al.'s "Google-Wide Profiling: A Continuous Profiling Infrastructure for Data Centers" (IEEE Micro, 2010) is the origin paper. The design's foundational move: *randomly sample machines in the fleet each day, then randomly sample time-slices on each chosen machine* (roughly one profile sample every few seconds per chosen box, at around 19Hz internal sampling). The aggregate profile is assembled from billions of small samples across thousands of machines and stored in Dremel for SQL-style analysis.

The cost-when-on is negligible *per machine* precisely because any one machine is profiled rarely; fleet coverage comes from statistical aggregation, not from per-host density. This is qualitatively different from "attach perf to one box when it's slow" — and qualitatively different from instrumenting every request with a span (§12).

The load-bearing design trick is **attribution by build ID**. Every Google binary embeds a build identifier; profiles can be re-aggregated by function × binary version, turning the profile store into a *longitudinal* performance archive. You can diff CPU cost of function `X` across last week's and this week's release, attributing regressions to commits. Without build IDs, profiles from a rolling fleet are unattributable noise. This is the same design pattern that makes source-map versioning work for JavaScript debugging, applied to profile metadata.

Sources: https://research.google/pubs/google-wide-profiling-a-continuous-profiling-infrastructure-for-data-centers/ and https://research.google.com/pubs/archive/36575.pdf

### 14.2. pprof `profile.proto` as Lingua Franca

Go's pprof format — originally `runtime/pprof`'s output schema (§3.5), documented in `profile.proto` — became the *de-facto* industry wire format for profiles. Parca, Pyroscope / Grafana Phlare, Google Cloud Profiler, Polar Signals, and Datadog all ingest pprof. Status (as of 2026-04): OpenTelemetry Profiling was still in progress, and it converges on the same shape.

The format's design is deliberately profile-type-agnostic: a generic `Sample → [Location] → Mapping` graph with arbitrary `value` dimensions (so CPU, heap, goroutine, block, mutex, and custom profiles all share one schema), a string table for interning, and gzip compression. This is the profiling equivalent of what OTLP did for traces and what CTF (§3.7) does for event streams: one interchange format that lets producers and consumers evolve independently.

For a new language: if your runtime emits profiles, emit them in pprof. The entire observability tool ecosystem will ingest them without adapter code, and users get free compatibility with continuous-profiling backends they haven't even chosen yet.

Sources: https://github.com/google/pprof/blob/main/proto/profile.proto and https://github.com/google/pprof

### 14.3. Parca — Open-Source GWP via eBPF

**Parca** (Frederic Branczyk / Polar Signals, 2021) is the open-source GWP-style system. Its distinctive choice is **whole-system profiling via eBPF** (§1.7) without application changes: a Parca Agent attaches a CPU-sampling eBPF probe to every process on a node, walks user-space stacks via a combination of frame pointers and preprocessed unwind metadata, and ships pprof-formatted profiles to a central store.

The eBPF-side unwinder is worth naming specifically: Parca / Polar Signals preprocesses userspace unwind metadata into bounded tables that an eBPF program can consult at sample time. This lets many non-frame-pointer binaries be unwound in-kernel without interpreting arbitrary DWARF CFI bytecode inside eBPF, which would be difficult to square with verifier constraints and the complexity described in §13.3.

The storage layer is **FrostDB**, a columnar database designed for profile ingestion and query. Profiles are decomposed into sample-value columns (CPU time, allocated bytes, goroutine counts) and metadata columns (function name, file, line, build ID). Queries are SQL-like aggregations over the columnar layout — the pprof ecosystem's answer to Dremel.

Sources: https://parca.dev/docs/concepts and https://www.polarsignals.com/blog/posts/2022/11/29/dwarf-based-stack-walking-using-ebpf

### 14.4. Grafana Pyroscope — Multi-Tenant Profile Aggregation

**Pyroscope** (originally Pyroscope Inc., acquired by Grafana Labs in 2023, now merged with Grafana Phlare) is the multi-tenant companion. Its original storage layer predated the pprof-as-lingua-franca convergence; the modern codebase ingests pprof alongside native formats and stores profiles in a Mimir-style (Prometheus-derived) columnar layout with tenant isolation.

The distinctive feature is **deep integration with distributed tracing** (§12): profiles are tagged with trace and span IDs, so a developer viewing an OpenTelemetry trace can jump directly to the CPU flame graph of the specific span's work. This closes the "profile → request" correlation loop that Dapper-style tracing left open — see a slow span, see exactly which functions consumed the time. Datadog Continuous Profiler and Google Cloud Profiler offer similar correlation in their managed forms.

Sources: https://grafana.com/docs/pyroscope/latest/introduction/continuous-profiling/ and https://grafana.com/docs/pyroscope/latest/reference-server-api

### 14.5. Managed Continuous Profilers — Datadog, Google Cloud Profiler

**Google Cloud Profiler** is GWP's commercial descendant — statistical, always-on, per-agent library linked into the application. **Datadog Continuous Profiler** is the managed-service take, leaning on JFR (§3.1) for JVM workloads, async-profiler (§2.4) for sidestepping safepoint bias, and pprof for Go/Python/Ruby.

The common design across all continuous profilers: the steady-state overhead target is 1–5% CPU sustained, not 0%. This is a conscious trade — you give up a small fraction of throughput in exchange for always knowing where the other 95–99% went. Pair it with span-to-profile correlation (§14.4) and you get per-request attribution for the spans that matter without paying per-request cost for the spans that don't.

Sources: https://docs.cloud.google.com/profiler/docs/concepts-profiling and https://docs.datadoghq.com/profiler/

---

## 15. GPU Tracing

GPU workloads cross a boundary that none of the prior mechanisms handle cleanly: the GPU has its *own* clock domain, its own scheduler, and its own asynchronous queue model. A `cuLaunchKernel` call returns in microseconds on the host; the kernel may not execute on the GPU until milliseconds later. To place CPU-side dispatches and GPU-side executions on one timeline requires hardware timestamps from the GPU's own clock and a cross-domain correlation mechanism.

### 15.1. NVTX — Annotation Layer for Nsight

**NVTX** (NVIDIA Tools Extension) is a lightweight API for in-application tracing annotations — `nvtxRangePush("frame")` / `nvtxRangePop()` to mark scoped ranges, `nvtxMarkA("checkpoint")` for instant events. When no profiler is attached, the library is a no-op stub (zero overhead). When Nsight Systems or Nsight Compute is attached, the ranges and markers appear as named spans on the timeline.

The "registered string handles" optimization is worth naming: `NVTX3_FUNC_RANGE` pre-interns range names so the hot-path call is a pointer push rather than a `strcmp` in the profiler — the cheap-guard / expensive-payload pattern (§1.5) applied to GPU-workload annotations, and the direct analogue of Tracy's scoped zones (§4.1) and OpenTelemetry spans (§12.3) for the GPU domain.

Sources: https://nvidia.github.io/NVTX/ and https://github.com/NVIDIA/NVTX

### 15.2. CUPTI + Nsight Systems — Cross-Clock-Domain Correlation

**CUPTI** (CUDA Profiling Tools Interface) is the low-level substrate below Nsight. It exposes two complementary APIs: a **Callback API** (synchronous entry/exit hooks on CUDA driver / runtime calls — high overhead, for deep diagnostics) and an **Activity API** (asynchronous buffered records of kernels, memcopies, driver calls — low overhead, for production sampling).

The load-bearing detail for GPU tracing is that CUPTI's `CUpti_ActivityKernel` record exposes **four separate timestamps per kernel launch**: `queued` (enqueued for submission), `submitted` (handed to GPU), `start` (began executing on an SM), `end` (finished execution). Each is on a different clock / queue domain, and only all four together reconstruct the full launch-to-finish latency breakdown — queueing latency, driver latency, execution latency are distinct sources of slowness that a single-timestamp view would blur together.

**Nsight Systems** (NVIDIA's system profiler) composes NVTX + CUPTI + OS-level perf-like sampling into a single timeline, adding GPU metric sampling (SM occupancy, tensor-core activity, PCIe/NVLink throughput) as separate tracks. It is the production end-state of the "universal timeline" pattern §11.2 describes for general tracing, specialized for GPU workloads.

The cross-vendor convergence point is **Perfetto's `GpuRenderStageEvent` proto**, which models GPU work as per-hardware-queue timelines (graphics, compute, DMA, video-encode), each carrying submission IDs that correlate back to the CPU-side `vkQueueSubmit` / `glFlush` / `cuLaunchKernel` call. The "one thing at a time per queue" constraint is enforced by the representation — true GPU parallelism surfaces as additional queues, not overlapping events on one queue. Android Graphics Profiler, Google's GPU tracing for ANGLE, AMD's rocprof (§15.3), and increasingly Nsight Systems all emit Perfetto-compatible output: GPU tracing's analogue of pprof's lingua-franca role for profiles.

Sources: https://docs.nvidia.com/cupti/ and https://developer.nvidia.com/nsight-systems and https://docs.nvidia.com/nsight-systems/UserGuide/ and https://github.com/google/perfetto/blob/main/protos/perfetto/trace/gpu/gpu_render_stage_event.proto

### 15.3. ROCm rocTracer / rocprofiler — AMD Equivalent

AMD's ROCm stack mirrors NVIDIA's three-layer model: **rocTracer** for runtime-API callback tracing, **ROC-TX** for NVTX-equivalent application annotations, and **rocprof** / **ROCProfiler-SDK** for counter and hardware-trace collection. The legacy stack (rocTracer + rocprof v1/v2) is being superseded by **ROCprofiler-SDK / rocprofv3**. Scheduled for 2026-Q2: end-of-support for the legacy rocTracer + rocprof v1/v2 tools.

The distinctive detail is the output format: `rocprof` emits **Chrome-tracing-compatible JSON**, so AMD GPU traces can be loaded directly into Perfetto (§11.2) or the Chrome DevTools tracing viewer without adapter code. This is a deliberate interoperability choice — AMD did not invent a new format, it adopted the one the existing tracing-viewer ecosystem already understood.

Sources: https://rocm.docs.amd.com/projects/roctracer/en/latest/ and https://rocm.docs.amd.com/projects/rocprofiler/en/docs-5.6.0/rocprof.html

### 15.4. Perfetto GPU Render-Stage Events

Folded into §15.2 above (Perfetto's `GpuRenderStageEvent` is the cross-vendor GPU-trace interchange that Nsight Systems, AMD rocprof, and Android Graphics Profiler all converge on). Heading retained for cross-reference stability.

---

## 16. HPC Tracing

High-performance computing has evolved its own tracing stack largely separate from the APM / observability world. The distinctive axis is **inter-rank causality**: MPI send/receive matching, collective-synchronization alignment, and trillions of events per run across thousands of ranks. Tools like Perfetto, JFR, OpenTelemetry have no notion of these primitives; the HPC ecosystem has been building against them since the 1990s.

### 16.1. Score-P — The Shared Instrumentation Backbone

**Score-P (Scalable Performance Measurement Infrastructure for Parallel Codes)** is the common measurement layer shared by Vampir, Scalasca, TAU, and Periscope. It emerged from the BMBF SILC + DOE PRIMA consortium effort around 2011 specifically to consolidate what used to be per-tool instrumentation and trace formats — before Score-P, each HPC profiler had its own instrumentation pass, its own MPI wrapper, its own trace format. Agreeing on one backbone was a prerequisite for any of them to scale.

Instrumentation enters Score-P through four routes simultaneously: **compiler hooks** (GCC/Intel/PGI/Cray emit `__cyg_profile_func_enter`/`_exit` calls), **MPI library interposition** through the standard `PMPI_*` profiling interface (which MPI itself specifies precisely so tools can wrap every call without source changes), **OPARI2 source-to-source rewriting** for OpenMP directives (because OpenMP pragmas expand too late for the compiler hooks to see them), and **PAPI / perf sampling** for hardware counters attached as sample events. Output is either OTF2 (event traces, §16.2) or CUBE4 (aggregated call-path profiles — the HPC analogue of pprof `profile.proto` in §14.2).

The design insight worth carrying forward is the **consortium-backbone pattern**: when multiple tools need the same instrumentation surface, the leverage is in standardizing the measurement layer so every tool benefits from improvements to any one of them. PAPI, `PMPI_*`, and Score-P together illustrate how HPC made this work at community scale.

Sources: https://www.vi-hps.org/projects/score-p/overview/overview.html and https://perftools.pages.jsc.fz-juelich.de/cicd/scorep/tags/latest/html/instrumentation.html

### 16.2. OTF2 — Per-Rank Lockless Parallel Trace Format

**OTF2 (Open Trace Format 2)** is the HPC trace interchange format, designed at TU Dresden / Jülich specifically for scalable I/O. The mechanical trick is physical file layout, not encoding: each rank writes its own local event file plus a small local definition file, and a single tiny global anchor (`traces.otf2`) holds the definition-ID mappings. There is no global lock, no global merge pass at write time, and readers can slice a single rank or a single time interval without touching the other files.

The 2011 design paper (Eschweiler, Wagner, Geimer, Knüpfer, Nagel, Wolf — ParCo 2011) and the 2012 encoding-techniques follow-up add per-record delta compression and on-the-fly token translation: each rank uses its own local definition ID space, and the reader translates to a global space lazily. This avoids the "unification" copy that killed OTF2's predecessors OTF and EPILOG at scale. For a modern comparison, OTF2 is to HPC what CTF (§3.7) is to Linux tracing — lockless, self-describing, designed for the scaling axis of its domain.

Scalasca's analysis engine **`scout`** is itself a parallel MPI program that reads each local OTF2 trace on the same rank that produced it, then does a distributed replay matching `MPI_Send`/`MPI_Recv` pairs and collective entry timestamps to classify "Late Sender", "Late Receiver", "Wait at Barrier", "Wait at N×N" patterns. It computes **delay cost** (the root-cause region upstream of the visible wait) and **critical path** — a fundamentally different analysis model from an APM waterfall, because the causality graph is over MPI messages, not HTTP spans.

The OTF2 ecosystem assumes a server-side viewer model: **Vampir** (TU Dresden ZIH) is the canonical OTF2 visualizer, and its distinctive choice is that **VampirServer runs as an MPI job alongside the trace files on the HPC filesystem** while the GUI is a thin client requesting aggregated time slices at the current zoom level. This is how Vampir displays traces that do not fit in the visualization host's RAM — the server lives where the data lives. Perfetto's implicit in-order forest (§11.1) is the same level-of-detail pattern, single-machine; Vampir scales it across the cluster that captured the trace.

The other long-running parallel-profiler lineage is **TAU (Tuning and Analysis Utilities)** from the University of Oregon Performance Research Lab. TAU predates Score-P and continues in parallel; its distinctive contribution is **dyninst-based dynamic instrumentation** via `tau_exec` / `tau_run`, attaching to a running MPI executable without recompilation and patching in measurement probes live. TAU feeds into Score-P today but maintains its own tracing formats (SLOG2, TAU-trace) and its own ParaProf visualizer — useful when the target cannot be rebuilt against Score-P, or when a site has existing TAU tooling.

For a new language targeting HPC workloads, the practical implication is concrete: speak OTF2 and the `PMPI_*` profiling interface, not OTLP. TAU and Score-P cover the instrumentation side; Vampir and Scalasca cover analysis; OTF2 is the wire format that makes them interchangeable.

Sources: https://perftools.pages.jsc.fz-juelich.de/cicd/otf2/docs/otf2-2.2/html/index.html and https://ebooks.iospress.nl/publication/26566 and https://apps.fz-juelich.de/scalasca/releases/scalasca/2.6/docs/manual/scout.html and https://vampir.eu/ and https://tu-dresden.de/zih/forschung/projekte/vampir and https://www.cs.uoregon.edu/research/tau/docs/html-docs/latest/usersguide/usersguide.html and https://apps.fz-juelich.de/scalasca/releases/scalasca/2.5/help/scalasca_patterns-2.5.html

### 16.3. Vampir — Server-Side Rendering for Trillion-Event Traces

Folded into §16.2 above as part of the OTF2 viewer story; heading retained for cross-reference stability.

### 16.4. TAU — Dyninst-Based Attach and Parallel Profiler Lineage

Folded into §16.2 above; heading retained for cross-reference stability.

---

## 17. Summary by Mechanism Family

The mechanism families below are organized by three orthogonal axes — steady-state overhead (cost when off), semantic richness (bytes/PCs vs language objects vs whole-system history), and recoverability (live observation vs replay vs arbitrary post-hoc queries). A practical tracer usually combines one family for control, another for data capture, and a third for presentation.

### 17.1. Direct Execution Interposition

These techniques change the code path itself: patch a site, swap in a trap, or reserve a place where control can be diverted later.

| Mechanism | Discussed in | Cost When Off | Cost When On | Granularity | Representative implementations |
|---|---|---|---|---|---|
| Hook function checked every instruction | background / contrast case | Per-instruction branch | Per-instruction call | Every instruction | Lua `debug.sethook`, CPython `sys.settrace` |
| Bytecode opcode patching | §1.1 | Zero | Per-breakpoint dispatch | Per-instruction | Luau `LOP_BREAK` |
| Function-entry patching / BPF trampolines | §§1.3, 1.11 | Reserved call/NOP site or static-key cost | Per-probe trampoline / BPF program call | Per-function entry/exit | ftrace, BPF `fentry`/`fexit` |
| Static tracepoints / USDT probes | §§1.5, 1.11 | NOP-like site, static key, or cheap is-enabled guard | Per-event argument capture + handler/probe dispatch | Per-semantic probe | DTrace USDT, Linux `TRACE_EVENT` |
| Dynamic breakpoint-style probes | §§1.7, 1.11 | Near-zero when no probe attached | Trap/breakpoint + argument decode or BPF program | Per-instruction / per-symbol | kprobes, kretprobes, eBPF uprobes |
| Trapless kernel probes | §1.6 | Reserved NOP/layout cost | Probe handler without double-trap path | Per-kernel probe site | USENIX ATC 2024 trapless probes |
| Compiler-inserted patchable sleds + side table | §1.10 | Reserved NOP sled / code-size cost | Per-patched function trampoline | Per-function / custom typed event | LLVM XRay |
| Jump target patching | §1.2 | One predicted branch | One call | Per-function | Erlang BeamAsm |
| NOP padding + INT 3 swap | §1.4 | One reserved NOP | Trap + context switch | Per-instruction | Wasmtime Winch |
| Return-address trampoline for paired entry/exit | §1.8 | One entry NOP, per-task shadow stack | One shared return handler | Per-function | ftrace `function_graph`, uftrace |
| Load-time field-offset relocation via BTF | §1.9 | Zero at runtime; metadata at load | One-time patch on `BPF_PROG_LOAD` | Per-struct-field access | eBPF CO-RE (libbpf + BTF) |
| Stable tracepoints vs dynamic typed probes | §1.11 | Zero until enabled / patchable entry cost | Per-event or per-BPF-program cost | Per-semantic-event / per-function | Linux `TRACE_EVENT`, kprobes, kretprobes, BPF `fentry`/`fexit` |
| Historical compile-time trace instructions | §4.2 | One NOP / trace site in versions using trace opcodes | Per-trace-point call | Per-line / function | Ruby YARV historical design; TracePoint abstraction |
| In-place binary rewriting via instruction punning | §7.3 | Zero | Per-patched-site logic | Per-instruction | E9Patch |
| PLT/GOT trampoline interception | §6.3 | Zero when unattached; requires recognizable dynamic-call stubs | Trap + arg decode per intercepted call | Per-library-symbol | ltrace; fragile under modern linking/hardening |
| AST wrapper node insertion | §4.5 | Zero when wrappers are absent | Recompilation + event dispatch when active | Per-AST-node | GraalVM Truffle |
| Language-level variable / execution trace | §4.4 | Zero when traces are absent | Per-access / callback | Per-variable / command | Tcl `trace` |

### 17.2. Cooperative Safepoints and Managed Handoff

These do not trap at arbitrary instructions. Instead, the runtime arranges for threads to notice a stop request at points that are already safe for the implementation.

| Mechanism | Discussed in | Cost When Off | Cost When On | Granularity | Representative implementations |
|---|---|---|---|---|---|
| Memory-protection polling page | §2.1 | One cached load | SIGSEGV + handler | Per-safepoint | HotSpot JVM |
| Existing-branch piggyback (`eval_breaker` style) | §2.2 | Effectively zero hot-path overhead; reuses an existing branch | One extra slow-path check + script execution | Per-safe-point | CPython PEP 768, PyPy analogue |
| Compile-time safepoint / root discipline | §2.3 | Zero between safepoints | Explicit safepoint / GC work | Per-safepoint region | Rust `zerogc` |
| Safepoint-only managed stack sampling | §2.4 | No async stack-walk support | Samples only at safepoints; structurally biased | Per-safepoint sample | JVMTI `GetStackTrace`-style profilers |
| Async managed stack walking | §2.4 | No steady-state cost until profiler attached | Signal/CPU-timer sample + async-safe stack walk; failed samples reported where supported | Per-signal or per-thread-timer sample | AGCT/async-profiler; JEP 509/JFR CPU-time profiling |

### 17.3. Hardware and Out-of-Process Observation

These techniques avoid or minimize software interposition in the target by leaning on CPU facilities or external readers.

| Mechanism | Discussed in | Cost When Off | Cost When On | Granularity | Representative implementations |
|---|---|---|---|---|---|
| External memory reading / sampling | §6.1 | Zero on target | Sampling interval + read cost | Per-sample | py-spy, rbspy |
| ptrace syscall tracing | §6.2 | N/A (always on when attached) | Plain ptrace: two stops per syscall; with `--seccomp-bpf`, only selected syscalls take the ptrace path, benchmarked around 1.5× on filtered workloads | Per-syscall | strace + `--seccomp-bpf` |
| Post-mortem minidump | §6.4 | Zero until crash | Out-of-process snapshot on crash | Once per crash | Breakpad, Crashpad |
| Hardware branch history / PT-style tracing | §§5.1, 5.2 | Zero / hardware facility disabled | PT bandwidth + decode cost, or LBR capture/read cost | Every branch or recent-branch window | Intel PT, magic-trace, LBR |
| Dedicated hardware trace fabric | §5.3 | Zero software overhead | Trace bandwidth / sink limits | Instruction flow | Arm CoreSight ETM/PTM |
| Side-channel execution sensing | §5.4 | Zero runtime overhead | Offline waveform classification | Code path / phase | ZoP |
| Precise PMU sampling (hardware record at retirement) | §5.5 | Zero (MSRs clear) | Per-event record memcpy into PEBS/SPE buffer | Per-retired-instruction with true PC | Intel PEBS, AMD IBS, ARM SPE |
| Single-pin application instrumentation trace | §5.6 | Zero (TRCENA clear) | One store per event; SWO-link-bandwidth-capped | Application-chosen markers | Arm Cortex-M ITM/SWO |
| RAM-ring-buffer debug-probe polling | §5.6 | Zero when unused except reserved RAM | Firmware writes to RAM buffer; probe polls over SWD/J-Link background memory access | Application logs / markers | SEGGER RTT |

### 17.4. Buffered Event Emission and Production-Safe Pipelines

The core idea is not "stop the program" but "emit structured events cheaply enough that continuous capture is practical."

| Mechanism | Discussed in | Cost When Off | Cost When On | Granularity | Representative implementations |
|---|---|---|---|---|---|
| Thread-local → global circular buffer recorder | §3.1 | Zero when disabled; very low active cost | Low-overhead continuous recording | Typed runtime events | JDK Flight Recorder |
| Per-CPU kernel trace sessions | §3.2 | Zero until providers are enabled | Lock-free event buffering | Per-event | ETW |
| Runtime diagnostics port + circular buffer | §3.3 | Zero until session attached | Runtime event buffering | Per-event | .NET EventPipe |
| Runtime-native scheduler event log | §3.4 | Low idle cost | Post-hoc analysis cost | Scheduler / GC / user events | GHC eventlog + ThreadScope |
| Partitioned execution trace + flight recorder | §3.5 | Zero when tracing disabled | Active tracing overhead reported below 1% in Go's optimized frame-pointer-based path; per-generation serialization | Scheduler / GC / user events | Go `runtime/trace`, FlightRecorder (Go 1.25) |
| Safety-constrained query DSL with aggregations | §3.6 | Zero until probe installed | Per-probe aggregation update (per-CPU local) | Per-probe | DTrace D, bpftrace |
| Lockless per-CPU ring buffer + CTF wire format | §3.7 | Zero when session off | CAS-only local producer + CTF write | Per-event | LTTng + liblttng-ust |
| Unified-logging persistent ring (one emission, three modalities) | §3.8 | Zero when subsystem disabled | Compile-time formatted payload memcpy | Per-signpost / per-log / per-activity | Apple `os_signpost` + Instruments |
| Subsystem-embedded tracepoints for shared-memory IPC | §3.9 | Zero (NOP patched) | NOP→CALL tracepoint cost | Per-SQE / per-CQE | Linux io_uring tracepoints |
| Database-engine query event bus | §3.10 | Zero when consumer off | Predicate eval + target write | Per-plan-node / per-statement | SQL Server XE, PG `auto_explain`, MySQL PS |
| Language-runtime heap snapshots + telemetry | §3.11 | Zero until snapper enabled | Per-event memcpy + 0.1 s sampler | Per-opcode event, per-object in heap dump | MoarVM Telemetry + heap snapshots |
| Long-horizon kernel/application metrics archive | §3.12 | Zero until pmcd polled | Per-metric collection + binary archive | Per-PMDA metric | Performance Co-Pilot (PCP) |
| eBPF-backed syscall capture and security rule engine | §3.12 | Zero when ruleset empty | Per-syscall capture + rule eval | Per-syscall event | Sysdig + Falco |
| Lock-free event queue | §4.1 | Very low idle cost | Per-span overhead | Per-annotated span | Tracy, Spall |
| Match-spec filtered tracing | §4.3 | Minimal pattern/filter cost | Per-matching-call | Per-function-call | Erlang `dbg` |
| Ultra-low-overhead language tracer | §4.6 | Very low active-path cost | Per-call / syscall event cost | Per-call / syscall | HUGLO |
| Two-tier in-process browser sampler + typed markers | §4.7 | Zero when session off | Per-marker payload copy + periodic sampler | Per-marker + periodic sample | Mozilla Gecko Profiler |
| Vendor microarchitecture-aware profiler with TMAM | §4.8 | Zero when session off | PMU sampling + per-microarch interpretation | Per-instruction TMAM category, memory-access source | Intel VTune, AMD μProf |
| ETW-native runtime + kernel profiling | §4.9 | Zero when session off | ETW-stackwalk + CLR provider integration | Per-allocation, per-GC-event, per-context-switch | Microsoft PerfView, Windows Performance Analyzer |
| Parallel producer/consumer trace ring buffer | §7.4 | QEMU / producer cost | Multi-core consumer cost | Every instruction / memory event | Cannoli |
| Pre-aggregated trace tree | §11.1 | Zero until enabled; O(log N) append | Low-latency append + zoom aggregation | Per-event | implicit in-order forests |
| Head-sampled distributed spans | §§12.1, 12.3 | Context propagation | Per-span overhead | Per-service call | Dapper, OpenTelemetry, Jaeger |
| Tail-sampled distributed spans | §12.2 | Per-span buffering in decision window | Post-window policy eval + drop | Per-trace | OTEL Collector `tailsamplingprocessor` |
| Dynamic distributed query with baggage | §12.4 | Zero until probe installed | Baggage propagation + join eval | Per-probe happens-before join | Pivot Tracing |

### 17.5. Heavyweight DBI and Shadow Execution

The "pay real overhead to gain deep visibility" designs: DBI, shadow state, and aggressive compiler-inserted checks.

| Mechanism | Discussed in | Cost When Off | Cost When On | Granularity | Representative implementations |
|---|---|---|---|---|---|
| Dynamic binary recompilation | §§7.1, 7.2 | N/A (always on) | 5–50× slowdown, or architecture-specific lower overhead | Every basic block | Frida Stalker, MAMBO |
| Whole-system replay + plugin composition | §7.5 | VM / recording overhead | Offline heavyweight analyses | Whole VM | PANDA |
| Managed-runtime DBI at class-load boundary | §7.6 | Agent startup + classloader isolation | Inlined `@Advice` template per method | Per-instrumented-method | DataDog / New Relic / OpenTelemetry Java agent |
| Shadow memory metadata | §8.1 | N/A (always on) | 10–50× slowdown | Every byte / access | Valgrind Memcheck |
| Compiler-inserted shadow checks | §8.2 | N/A (always on) | ~2× slowdown | Per-memory-access | AddressSanitizer |
| Race-tracking shadow clocks | §8.3 | N/A (always on) | 5–15× slowdown | Per-memory-access | ThreadSanitizer |
| Definedness tracking via compiler instrumentation | §8.3 | N/A (always on) | ~3× slowdown | Per-memory-access | MemorySanitizer |
| Targeted undefined-behavior guards | §8.3 | N/A (always on) | <5% slowdown | Per-operation | UBSan |
| Virtual speedup (causal profiling) | §10.1 | Zero when not running Coz | ~17% mean overhead plus repeated perturbation runs | Per-line / progress point | Coz |
| Coverage-guided fuzzing | §9.1 | Instrumentation cost | Thousands–millions of executions / sec | Per-edge / branch | AFL, libFuzzer |

### 17.6. Runtime-Semantic Hooks and Live Systems

Folded into §17.1 (AST wrapper / variable traces are direct-execution-interposition mechanisms operating on the runtime's own AST or command-dispatch path). Heading retained for cross-reference stability.

### 17.7. Search and Perturbation

Folded into §17.5 (causal profiling and coverage-guided fuzzing share the heavyweight "pay real overhead to gain deep visibility / search coverage" trade-off). Heading retained for cross-reference stability.

### 17.8. Sampling Substrates and Stack Unwinding

Every sampling profiler depends on two steps: a substrate that decides when and how samples are delivered, and an unwinder that converts interrupted register state into a call stack. The substrate trade-off is bias, delivery cost, and lost-sample behavior; the unwinding trade-off is steady-state runtime tax vs cost at walk time.

| Mechanism | Discussed in | Steady-State Cost | Walk Cost / Delivery Cost | Key Trade-off | Representative implementations |
|---|---|---|---|---|---|
| Timer / signal / PMU-overflow sampling substrate | §13.1 | Zero until profiler armed; PMU/timer state while active | Signal handler or kernel ring-buffer record per sample | Bias, skid, throttling, lost samples, async-signal-safety | `perf_event_open`, `SIGPROF`, `setitimer`, async-profiler, pprof |
| Frame pointers (always) | §13.2 | 1–3% runtime tax | Pointer chase per frame | Simplicity + signal-handler safety; one reserved register | Fedora 38, Ubuntu 24.04, Go, PEP 831 |
| DWARF `.eh_frame` / CFI | §13.3 | Zero | Expressive interpreted unwind program per frame (20–40× slower) | Exception-handling correctness, not sampling-friendly | GCC/Clang `-fomit-frame-pointer` default |
| Build-validated flat unwind table | §13.4 | ~1.3 MB per build | Flat lookup (no bytecode) | 20–40× faster than DWARF; kernel-only | Linux ORC (Poimboeuf, `objtool`) |
| Simplified userspace unwind format | §13.5 | ~8 bytes/row binary-searchable | ~FP-speed from signal handler | No callee-save recovery; fallback needed for exotic code | SFrame (binutils 2.40+, glibc 2.39+) |
| Hardware branch ring for call stack | §13.6 | Branch ring enable cost | Zero (already in sample) | Stack depth capped at 16/32 frames | `perf --call-graph lbr` |
| Language-policy "always FP" | §13.7 | 1–3% paid once on ABI | Pointer chase | Profilability pays compounding dividends | Go (amd64/arm64 since 1.7) |

### 17.9. Visualization and Trace Interchange

Enabling layers. They usually do not capture execution by themselves, but they are what make traces explorable.

| Mechanism | Discussed in | Cost When Off | Cost When On | Granularity | Representative implementations |
|---|---|---|---|---|---|
| Universal trace-view interchange | §11.2 | UI-side cost | Rendering / conversion cost | Per-event visualization | Perfetto protobuf exporters; Fuchsia Trace Format via conversion/import paths |
| Alphabetically-merged stack histogram | §11.3 | Post-processing only | Linear in folded-stack input | Per-sample (time discarded) | Flame graphs, speedscope, pprof `-http` |
| Scheduler-event sampling (blocked time) | §11.4 | Zero until probe installed | Per-context-switch eBPF aggregation | Per-blocked-period | Off-CPU flame graphs |
| Profile interchange format | §14.2 | N/A | Format conversion | Per-sample | pprof `profile.proto` |
| Standardized binary event wire format | §3.7 | N/A | Zero-copy binary emission | Per-event | CTF (Common Trace Format) |
| Per-rank parallel trace format | §16.2 | N/A | Per-rank local writes; lazy ID translation | Per-MPI-event | OTF2 + Vampir server-side rendering |

### 17.10. Continuous, Fleet-Scale, and Cross-Domain Observation

Designs whose distinguishing property is operating at always-on scale, across fleet boundaries, or across clock domains (CPU↔GPU) that the other families cannot bridge.

| Mechanism | Discussed in | Cost When Off | Cost When On | Granularity | Representative implementations |
|---|---|---|---|---|---|
| Fleet-sampled profiling with build-ID attribution | §14.1 | Zero per machine when not sampled | ~1–5% CPU per sampled machine | Per-function × binary-version aggregate | Google-Wide Profiling (GWP) |
| Whole-system eBPF continuous profiler | §14.3 | eBPF probe overhead | In-kernel table-driven unwinding + pprof upload | Per-process CPU sample | Parca + FrostDB |
| Multi-tenant profile store with trace correlation | §14.4 | Zero until session | ~1–5% CPU + profile-span tagging | Per-span profile jump | Grafana Pyroscope / Phlare, Datadog, GCP Profiler |
| GPU annotation API | §15.1 | No-op stub when no tool attached | Pointer-push per range | Per-range / marker | NVTX, ROC-TX |
| Cross-clock-domain GPU trace substrate | §15.2 | Zero until CUPTI session | Four-timestamp buffered record per kernel | Per-kernel-launch | CUPTI Activity API + Nsight Systems |
| Per-hardware-queue GPU timeline | §15.2 | N/A | Per-submission correlation ID emission | Per-GPU-queue event | Perfetto `GpuRenderStageEvent` |

### 17.11. Parallel and HPC Tracing

Designs for inter-rank causality, trillions of events, and the `PMPI_*` / OpenMP instrumentation surface that observability-world tools do not speak.

| Mechanism | Discussed in | Cost When Off | Cost When On | Granularity | Representative implementations |
|---|---|---|---|---|---|
| Consortium-backbone parallel measurement layer | §16.1 | Zero when session off | MPI-wrapper + compiler-hook + OPARI2 overhead | Per-function / per-MPI-call / per-OMP-region | Score-P |
| Per-rank lockless parallel trace format | §16.2 | N/A | Per-rank local writes; lazy ID translation; automated wait-state replay (`scout`) | Per-event + cross-rank message pairs | OTF2 + Scalasca |
| Cluster-side trace visualization | §16.2 | N/A | MPI-job-scale rendering; thin-client aggregates | Per-rank × per-zoom-level | Vampir + VampirServer |

---

## 18. References

References are grouped by chapter and roughly follow subsection order. Broad background references may be grouped by topic rather than exact first mention.

### Chapter 1 — Bytecode and Code Patching

1. Luau Performance — https://luau.org/performance/
2. BeamAsm, the Erlang JIT — https://www.erlang.org/doc/apps/erts/beamasm
3. eBPF Trampolines — https://docs.ebpf.io/linux/concepts/trampolines/
4. Wasmtime Debugging Design — https://hackmd.io/@hvqFkDgPTuGNcu-NiycXZQ/SyXX166Yp
5. DTrace USDT Probes — https://blogs.oracle.com/linux/from-kernel-to-user-space-tracing
6. Fast Trapless Kernel Probes (USENIX ATC 2024) — https://research.ibm.com/publications/fast-trapless-kernel-probes-everywhere
7. eBPF uprobes for GPU Monitoring — https://medium.com/@kcl17/inside-cuda-building-ebpf-uprobes-for-gpu-monitoring-449519b236ed
8. ftrace documentation (function_graph) — https://docs.kernel.org/trace/ftrace.html
9. LWN: function_graph tracer mechanism — https://lwn.net/Articles/370423/
10. Andrii Nakryiko — "BPF Portability and CO-RE" — https://facebookmicrosites.github.io/bpf/blog/2020/02/19/bpf-portability-and-co-re.html
11. Andrii Nakryiko — "BPF CO-RE reference guide" — https://nakryiko.com/posts/bpf-core-reference-guide/
12. Kernel BPF Type Format (BTF) spec — https://docs.kernel.org/bpf/btf.html
13. Brendan Gregg — "BPF binaries: BTF, CO-RE, and the future of BPF perf tools" — https://www.brendangregg.com/blog/2020-11-04/bpf-co-re-btf-libbpf.html
14. LLVM XRay Instrumentation — https://llvm.org/docs/XRay.html
15. LLVM XRay Example — https://llvm.org/docs/XRayExample.html
16. LLVM XRayInstrumentation source — https://llvm.org/doxygen/XRayInstrumentation_8cpp_source.html
17. Linux kprobe events documentation — https://docs.kernel.org/trace/kprobetrace.html
18. Linux trace events documentation — https://docs.kernel.org/trace/events.html
19. eBPF tracing program type — https://docs.ebpf.io/linux/program-type/BPF_PROG_TYPE_TRACING/

### Chapter 2 — Cooperative Safepoints and Managed Handoff

1. JVM Anatomy Quark #22: Safepoint Polls — https://shipilev.net/jvm/anatomy-quarks/22-safepoint-polls/
2. PEP 768: Safe External Debugger Interface for CPython — https://peps.python.org/pep-0768/
3. Rust zerogc — https://docs.rs/zerogc
4. zerogc GitHub — https://github.com/DuckLogic/zerogc
5. Mytkowicz et al., "Evaluating the Accuracy of Java Profilers" (PLDI 2010) — https://plv.colorado.edu/papers/mytkowicz-pldi10.pdf
6. async-profiler — https://github.com/async-profiler/async-profiler
7. JEP 509: JFR CPU-Time Profiling (JDK 25) — https://openjdk.org/jeps/509
8. Wakart, "Why (Most) Sampling Java Profilers Are Fucking Terrible" — http://psy-lob-saw.blogspot.com/2016/02/why-most-sampling-java-profilers-are-fucking-terrible.html

### Chapter 3 — Runtime-Native Event Pipelines

1. JEP 328: Flight Recorder — https://openjdk.org/jeps/328
2. Oracle Java Mission Control Runtime Guide: About Java Flight Recorder — https://docs.oracle.com/javacomponents/jmc-5-4/jfr-runtime-guide/about.htm
3. Event Tracing for Windows Sessions — https://learn.microsoft.com/en-us/windows-hardware/test/wpt/sessions
4. Event Tracing for Windows Overview — https://learn.microsoft.com/en-us/windows-hardware/test/wpt/event-tracing-for-windows
5. About Event Tracing for Drivers — https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/about-event-tracing-for-drivers
6. EventPipe Overview — https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe
7. Microsoft.Diagnostics.NETCore.Client API — https://learn.microsoft.com/en-us/dotnet/core/diagnostics/microsoft-diagnostics-netcore-client
8. dotnet-trace diagnostic tool — https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace
9. GHC Runtime System Options / Eventlog — https://downloads.haskell.org/ghc/latest/docs/users_guide/runtime_control.html
10. Eventful GHC — https://www.haskell.org/ghc/blog/20190924-eventful-ghc.html
11. ThreadScope Man Page — https://manpages.ubuntu.com/manpages/jammy/man1/threadscope.1.html
12. Go blog: More powerful Go execution traces — https://go.dev/blog/execution-traces-2024
13. Go blog: Flight Recorder in Go 1.25 — https://go.dev/blog/flight-recorder
14. Go proposal 60773: execution-tracer overhaul — https://github.com/golang/proposal/blob/master/design/60773-execution-tracer-overhaul.md
15. Geisendörfer: Go execution tracing with <1% overhead — https://blog.felixge.de/waiting-for-go1-21-execution-tracing-with-less-than-one-percent-overhead/
16. pprof `profile.proto` schema — https://github.com/google/pprof/blob/main/proto/profile.proto
17. Cantrill, Shapiro, Leventhal — "Dynamic Instrumentation of Production Systems" (USENIX ATC 2004) — https://www.usenix.org/legacy/event/usenix04/tech/general/full_papers/cantrill/cantrill.pdf
18. Illumos Dynamic Tracing Guide — https://illumos.org/books/dtrace/chp-intro.html
19. bpftrace — https://github.com/bpftrace/bpftrace
20. Brendan Gregg — "bpftrace (DTrace 2.0) for Linux 2018" — https://www.brendangregg.com/blog/2018-10-08/dtrace-for-linux-2018.html
21. LWN: Comparing SystemTap and bpftrace — https://lwn.net/Articles/852112/
22. LTTng Documentation — https://lttng.org/docs/
23. Desnoyers, OLS 2006 — LTTng per-CPU lockless buffers — https://www.kernel.org/doc/ols/2006/ols2006v1-pages-209-224.pdf
24. Desnoyers 2009 formal paper — https://www.dorsal.polymtl.ca/files/publications/desnoyers-mcc09-final.pdf
25. WWDC 2016 Session 721 — Unified Logging and Activity Tracing (PDF) — https://devstreaming-cdn.apple.com/videos/wwdc/2016/721wh2etddp4ghxhpcg/721/721_unified_logging_and_activity_tracing.pdf
26. Apple dev docs — Recording Performance Data (Instruments + signposts) — https://developer.apple.com/documentation/os/recording-performance-data
27. WWDC 2018 Session 405 — Measuring Performance Using Logging — https://developer.apple.com/videos/play/wwdc2018/405/
28. Jens Axboe — "Efficient IO with io_uring" — https://kernel.dk/io_uring.pdf
29. Jens Axboe — "What's new with io_uring" (Kernel Recipes 2022) — https://kernel.dk/axboe-kr2022.pdf
30. Linux io_uring tracepoint definitions — https://github.com/torvalds/linux/blob/master/include/trace/events/io_uring.h
31. LWN — "io_uring tracing support" — https://lwn.net/Articles/1063853/
32. Cloudflare — "Missing Manuals: io_uring worker pool" — https://blog.cloudflare.com/missing-manuals-io_uring-worker-pool/
33. PostgreSQL auto_explain docs — https://www.postgresql.org/docs/current/auto-explain.html
34. PostgreSQL pg_stat_statements docs — https://www.postgresql.org/docs/current/pgstatstatements.html
35. SQL Server Extended Events engine — https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/sql-server-extended-events-engine
36. SQL Server Extended Events targets — https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/targets-for-extended-events-in-sql-server
37. MySQL Performance Schema — https://dev.mysql.com/doc/refman/en/performance-schema.html
38. MoarVM Telemetry (Raku docs) — https://docs.raku.org/type/Telemetry
39. MoarVM heapsnapshot.c — https://github.com/MoarVM/MoarVM/blob/master/src/profiler/heapsnapshot.c
40. moarperf web UI — https://github.com/timo/moarperf
41. Performance Co-Pilot home — https://pcp.io/
42. Sysdig vs strace technical comparison — https://sysdig.com/blog/sysdig-vs-strace/
43. Falco home — https://falco.org/
44. Falco repository — https://github.com/falcosecurity/falco

### Chapter 4 — Instrumentation Profilers

1. Tracy Profiler — https://github.com/wolfpld/tracy
2. Spall Profiler — https://gravitymoth.com/spall/spall-web.html
3. Ruby TracePoint (RDoc) — https://docs.ruby-lang.org/en/master/TracePoint.html
4. Ruby Feature #14104 (trace-instruction removal) — https://bugs.ruby-lang.org/issues/14104
5. Erlang dbg Module — https://www.erlang.org/doc/apps/runtime_tools/dbg.html
6. Erlang recon_trace — https://ferd.github.io/recon/recon_trace.html
7. Tcl Trace Command — https://www.tcl-lang.org/cgi-bin/tct/tip/86.html
8. Tcl Tracing with enterstep — https://wiki.tcl-lang.org/page/Tracing+with+enterstep
9. GraalVM Language Implementation Framework — https://www.graalvm.org/latest/graalvm-as-a-platform/language-implementation-framework/
10. GraalVM Truffle Instrumentation — https://www.graalvm.org/latest/graalvm-as-a-platform/implement-instrument/
11. HUGLO — https://blog.mattstuchlik.com/2025/04/23/low-overhead-ruby-tracing.html
12. Mozilla Gecko Profiler documentation — https://firefox-source-docs.mozilla.org/tools/profiler/index.html
13. Gecko Profiler markers guide — https://firefox-source-docs.mozilla.org/tools/profiler/markers-guide.html
14. Gecko Profiler code overview (Base + Gecko tiers) — https://firefox-source-docs.mozilla.org/tools/profiler/code-overview.html
15. Firefox Profiler frontend — https://github.com/firefox-devtools/profiler
16. profiler.firefox.com — https://profiler.firefox.com/
17. Intel VTune Profiler — https://www.intel.com/content/www/us/en/developer/tools/oneapi/vtune-profiler.html
18. AMD μProf — https://www.amd.com/en/developer/uprof.html
19. Intel — Top-Down Microarchitecture Analysis Method (VTune Cookbook) — https://www.intel.com/content/www/us/en/docs/vtune-profiler/cookbook/2024-0/top-down-microarchitecture-analysis-method.html
20. PerfView repository (Microsoft) — https://github.com/microsoft/perfview
21. Microsoft Learn — Windows Performance Analyzer — https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-analyzer
22. Microsoft Learn — PerfView for .NET diagnostics — https://learn.microsoft.com/en-us/dotnet/core/diagnostics/perfview-tool

### Chapter 5 — Hardware Tracing

1. Jane Street magic-trace — https://blog.janestreet.com/magic-trace/
2. Tristan Hume: All My Favorite Tracing Tools — https://thume.ca/2023/12/02/tracing-methods/
3. Hardware LBR for TSX debugging (LWN) — https://lwn.net/Articles/680996/
4. Arm CoreSight Debug and Trace Guide — https://developer.arm.com/documentation/102520/latest/
5. Arm CoreSight ETM-M33 Technical Reference Manual — https://developer.arm.com/documentation/100232/latest/
6. Zero-Overhead Profiling via EM Emanations (ZoP) — https://sites.gatech.edu/ece-alenka/wp-content/uploads/sites/463/2016/09/ZoP.pdf
7. Intel SDM §18.13 — PEBS Data Format — https://xem.github.io/minix86/manual/intel-x86-and-64-manual-vol3/o_fe12b1e2a880e0ce-711.html
8. Stephane Eranian — perf-mem / PEBS-LL + Precise Store — https://lwn.net/Articles/521959/
9. Eranian — "Perf and PEBS Memory Sampling" (Paradyn/Petascale 2013) — http://www.paradyn.org/petascale2013/slides/eranian13.pdf
10. AMD IBS whitepaper (Drongowski, 2007) — https://www.amd.com/content/dam/amd/en/documents/archived-tech-docs/white-papers/AMD_IBS_paper_EN.pdf
11. AMD_IBS_Toolkit — IBS via perf_event_open — https://github.com/jlgreathouse/AMD_IBS_Toolkit/blob/master/ibs_with_perf_events.txt
12. `perf-arm-spe(1)` manual — https://man7.org/linux/man-pages/man1/perf-arm-spe.1.html
13. Will Deacon — ARM SPE RFC cover letter — https://lwn.net/Articles/711591/
14. Intel — Timed PEBS / TPEBS — https://www.intel.com/content/www/us/en/developer/articles/technical/timed-process-event-based-sampling-tpebs.html
15. Arm Cortex-M7 TRM — ITM functional description — https://developer.arm.com/documentation/ddi0439/b/Instrumentation-Trace-Macrocell-Unit/ITM-functional-description
16. Arm Cortex-M7 TRM — DWT functional description — https://developer.arm.com/documentation/ddi0439/b/Data-Watchpoint-and-Trace-Unit
17. CMSIS-Core ITM API — https://arm-software.github.io/CMSIS_6/v6.0.0/Core/group__ITM__Debug__gr.html
18. SEGGER SWO knowledge base — https://kb.segger.com/SWO
19. SEGGER RTT (background memory access over SWD) — https://www.segger.com/products/debug-probes/j-link/technology/about-real-time-transfer/
20. SEGGER — Current state of the trace market — https://blog.segger.com/current-state-of-the-trace-market/

### Chapter 6 — External Process Observation

1. py-spy Sampling Profiler — https://github.com/benfred/py-spy
2. strace --seccomp-bpf introduction — https://pchaigno.github.io/strace/2019/10/02/introducing-strace-seccomp-bpf.html
3. Syromiatnikov/Levin FOSDEM 2020: strace performance — https://archive.fosdem.org/2020/schedule/event/debugging_strace_perfotmance/
4. How does ltrace work? (PackageCloud) — https://packagecloud.io/blog/how-does-ltrace-work/
5. Crashpad overview design — https://chromium.googlesource.com/crashpad/crashpad/+/HEAD/doc/overview_design.md
6. Breakpad minidump stack-walking — https://chromium.googlesource.com/breakpad/breakpad/+/HEAD/docs/stack_walking.md

### Chapter 7 — Dynamic Binary Instrumentation

1. Frida Stalker — https://frida.re/docs/stalker/
2. MAMBO — https://github.com/beehive-lab/mambo
3. E9Patch Binary Rewriting — https://pldi20.sigplan.org/details/pldi-2020-papers/12/Binary-Rewriting-without-Control-Flow-Recovery
4. PANDA.re — https://panda.re/
5. PyPANDA: Taming the PANDAmonium of Whole-System Dynamic Analysis — https://www.ndss-symposium.org/wp-content/uploads/bar2021_23001_paper.pdf
6. Oracle — `java.lang.instrument` package (Java 21) — https://docs.oracle.com/en/java/javase/21/docs/api/java.instrument/java/lang/instrument/Instrumentation.html
7. Byte Buddy (Rafael Winterhalter) — https://bytebuddy.net/
8. OpenTelemetry Java agent structure — https://github.com/open-telemetry/opentelemetry-java-instrumentation/blob/main/docs/contributing/javaagent-structure.md
9. DataDog `dd-trace-java` — how instrumentations work (Muzzle) — https://github.com/DataDog/dd-trace-java/blob/master/docs/how_instrumentations_work.md
10. Microsoft CLR Profiling API `ICorProfilerCallback` — https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/profiling/icorprofilercallback-interface
11. OpenTelemetry Python zero-code instrumentation — https://opentelemetry.io/docs/zero-code/python/

### Chapter 8 — Shadow State and Compiler-Inserted Checks

1. Valgrind Shadow Memory — https://valgrind.org/docs/shadow-memory2007.pdf
2. AddressSanitizer Algorithm — https://github.com/google/sanitizers/wiki/addresssanitizeralgorithm
3. AddressSanitizer (Clang Documentation) — https://releases.llvm.org/20.1.0/tools/clang/docs/AddressSanitizer.html

### Chapter 9 — Coverage-Guided Fuzzing

1. libFuzzer — https://llvm.org/docs/LibFuzzer.html
2. AFL Fuzzer — https://lcamtuf.coredump.cx/afl/

### Chapter 10 — Causal Profiling

1. Coz Causal Profiling — https://web.cs.umass.edu/publication/docs/2014/UM-CS-2014-010.pdf
2. Coz: Finding Code That Counts (Morning Paper) — https://blog.acolyer.org/2015/10/14/coz-finding-code-that-counts-with-causal-profling/

### Chapter 11 — Trace Storage and Visualization

1. Implicit In-order Forests — https://thume.ca/2021/03/14/iforests/
2. Perfetto — https://perfetto.dev/
3. Perfetto TracePacket proto reference — https://perfetto.dev/docs/reference/trace-packet-proto
4. Brendan Gregg: Flame Graphs — https://www.brendangregg.com/flamegraphs.html
5. Gregg, "The Flame Graph" (ACM Queue / CACM 2016) — https://queue.acm.org/detail.cfm?id=2927301
6. FlameGraph source — https://github.com/brendangregg/FlameGraph
7. Differential Flame Graphs — https://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html
8. Brendan Gregg: Off-CPU Analysis — https://www.brendangregg.com/offcpuanalysis.html
9. Off-CPU Flame Graphs — https://www.brendangregg.com/FlameGraphs/offcpuflamegraphs.html
10. eBPF Off-CPU Flame Graph — http://brendangregg.com/blog/2016-01-20/ebpf-offcpu-flame-graph.html

### Chapter 12 — Distributed Tracing & Observability

1. Sigelman et al., "Dapper" (Google Research) — https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/
2. Dapper paper PDF — https://static.googleusercontent.com/media/research.google.com/en//archive/papers/dapper-2010-1.pdf
3. Twitter: Distributed Systems Tracing with Zipkin — https://blog.x.com/engineering/en_us/a/2012/distributed-systems-tracing-with-zipkin
4. Uber: Evolving Distributed Tracing — https://www.uber.com/us/en/blog/distributed-tracing/
5. OpenTelemetry Sampling concepts — https://opentelemetry.io/docs/concepts/sampling/
6. OTEL TraceState Probability Sampling — https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/
7. OTEL Collector tail-sampling processor — https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor
8. OpenTelemetry Traces — https://opentelemetry.io/docs/concepts/signals/traces/
9. OpenTelemetry Context Propagation — https://opentelemetry.io/docs/concepts/context-propagation/
10. Mace, Roelke, Fonseca — "Pivot Tracing" (SOSP 2015) PDF — https://sigops.org/s/conferences/sosp/2015/current/2015-Monterey/printable/122-mace.pdf
11. Pivot Tracing ACM DOI — https://doi.org/10.1145/2815400.2815415

### Chapter 13 — Sampling Profilers: Substrates and Stack Unwinding

1. `perf_event_open(2)` — https://man7.org/linux/man-pages/man2/perf_event_open.2.html
2. Brendan Gregg — Linux perf examples — https://www.brendangregg.com/perf.html
3. `setitimer(2)` — https://man7.org/linux/man-pages/man2/setitimer.2.html
4. `signal-safety(7)` — https://man7.org/linux/man-pages/man7/signal-safety.7.html
5. Fedora 38 frame-pointer change — https://fedoraproject.org/wiki/Changes/fno-omit-frame-pointer
6. Ubuntu performance engineering with frame pointers — https://ubuntu.com/blog/ubuntu-performance-engineering-with-frame-pointers-by-default
7. Brendan Gregg: "The Return of the Frame Pointers" — https://www.brendangregg.com/blog/2024-03-17/the-return-of-the-frame-pointers.html
8. PEP 831 — frame pointers for Python — https://peps.python.org/pep-0831/
9. Red Hat: Frame pointers — untangling unwinding — https://developers.redhat.com/articles/2023/07/31/frame-pointers-untangling-unwinding
10. Ian Lance Taylor: .eh_frame — https://www.airs.com/blog/archives/460
11. Linux ORC unwinder docs — https://www.kernel.org/doc/html/latest/arch/x86/orc-unwinder.html
12. LWN: "The ORCs are coming" — https://lwn.net/Articles/728339/
13. LKML: ORC unwinder series (Poimboeuf) — https://lwn.net/Articles/727553/
14. SFrame Specification — https://sourceware.org/binutils/docs/sframe-spec.html
15. Oracle blog: Beyond .eh_frame — SFrame technical underpinnings — https://blogs.oracle.com/linux/beyond-eh-frame-frame-pointers-the-technical-underpinnings-of-sframe
16. LWN: SFrame — https://lwn.net/Articles/930622/
17. MaskRay: Stack walking space and time trade-offs — https://maskray.me/blog/2025-10-26-stack-walking-space-and-time-trade-offs
18. LBR call-stack perf patch (Liang) — https://lwn.net/Articles/619180/
19. Go non-cooperative preemption proposal — https://go.googlesource.com/proposal/+/master/design/24543-non-cooperative-preemption.md
20. Geisendörfer: Go tracer overhead via FP unwinding — https://blog.felixge.de/reducing-gos-execution-tracer-overhead-with-frame-pointer-unwinding/

### Chapter 14 — Continuous Profiling

1. Ren et al., "Google-Wide Profiling" (IEEE Micro 2010) — https://research.google/pubs/google-wide-profiling-a-continuous-profiling-infrastructure-for-data-centers/
2. Google-Wide Profiling paper PDF — https://research.google.com/pubs/archive/36575.pdf
3. google/pprof — https://github.com/google/pprof
4. Parca concepts — https://parca.dev/docs/concepts
5. Polar Signals: DWARF stack walking via eBPF — https://www.polarsignals.com/blog/posts/2022/11/29/dwarf-based-stack-walking-using-ebpf
6. Grafana Pyroscope — continuous profiling — https://grafana.com/docs/pyroscope/latest/introduction/continuous-profiling/
7. Pyroscope server API — https://grafana.com/docs/pyroscope/latest/reference-server-api
8. Google Cloud Profiler concepts — https://docs.cloud.google.com/profiler/docs/concepts-profiling
9. Datadog Continuous Profiler — https://docs.datadoghq.com/profiler/

### Chapter 15 — GPU Tracing

1. NVTX project — https://nvidia.github.io/NVTX/
2. NVTX source — https://github.com/NVIDIA/NVTX
3. CUPTI Documentation — https://docs.nvidia.com/cupti/
4. NVIDIA Nsight Systems — https://developer.nvidia.com/nsight-systems
5. Nsight Systems User Guide — https://docs.nvidia.com/nsight-systems/UserGuide/
6. AMD ROCTracer + ROC-TX — https://rocm.docs.amd.com/projects/roctracer/en/latest/
7. AMD rocprof — https://rocm.docs.amd.com/projects/rocprofiler/en/docs-5.6.0/rocprof.html
8. Perfetto GPU render-stage proto — https://github.com/google/perfetto/blob/main/protos/perfetto/trace/gpu/gpu_render_stage_event.proto

### Chapter 16 — HPC Tracing

1. Score-P project overview (VI-HPS) — https://www.vi-hps.org/projects/score-p/overview/overview.html
2. Score-P user manual (Jülich) — https://perftools.pages.jsc.fz-juelich.de/cicd/scorep/tags/latest/html/instrumentation.html
3. OTF2 API reference — https://perftools.pages.jsc.fz-juelich.de/cicd/otf2/docs/otf2-2.2/html/index.html
4. OTF2 design paper (Eschweiler et al., ParCo 2011) — https://ebooks.iospress.nl/publication/26566
5. Scalasca `scout` analyzer — https://apps.fz-juelich.de/scalasca/releases/scalasca/2.6/docs/manual/scout.html
6. Vampir (TU Dresden ZIH) — https://vampir.eu/
7. Vampir project page (TU Dresden) — https://tu-dresden.de/zih/forschung/projekte/vampir
8. TAU User Guide (University of Oregon) — https://www.cs.uoregon.edu/research/tau/docs/html-docs/latest/usersguide/usersguide.html
9. Scalasca wait-state pattern catalog — https://apps.fz-juelich.de/scalasca/releases/scalasca/2.5/help/scalasca_patterns-2.5.html
