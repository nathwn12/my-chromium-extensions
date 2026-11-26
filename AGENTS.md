# Repository policy

- Root policy is cross-cutting only. What is true of one package stays with that package: package-level policy lives in that package's AGENTS.md as a delta from this file; package facts, versions and paths belong to their owning source or generated docs.
- One fact has one home. Cite or generate it; never retype it into a policy, README or plan.
- Change control runs in order: plan, spec, decision record, code. A superseded decision stays visible and is marked, never silently removed.
- A worker changes only files inside its own seam. Verify a handover by hash, not by promise.
- Every claim in a change report carries the command and its exit code. A claim without a command is unverified; a check that never failed proves nothing.
- Do not add a build step, a new transport, or a publishing path to an extension without a recorded decision; procedure and current state belong in guides, not here.
- Audio verification makes no sound: no autoplay, no headed browser, no muted audio test. If a browser-based audio check is unavoidable, stop and get explicit approval before running it.
- Local-only stays local: no account, telemetry, or browser-to-cloud bridge. Presence traffic stays on the declared local messaging path.
- Do not edit the vendored checker or its pin to make a red gate pass; a mismatch is a signal to investigate, not a reason to weaken the gate.
