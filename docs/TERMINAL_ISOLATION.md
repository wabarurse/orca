# Current fullscreen selection follow-up

The historical investigations below are retained as evidence, not current UX.
Fullscreen now always requests 1000 + 1002 (button-drag motion) + SGR 1006.
Unmodified SGR left drag highlights committed conversation only and auto-copies on
valid release through the local desktop clipboard writer; Ctrl+O explicitly re-copies.
A mere click or canceled/invalid release does not copy. No Cmd-C assumption.
Esc clears selection, and reflow/context replacement cancels it. Soft wraps copy as
visible newlines; transient streaming/activity rows are excluded. Legacy X10 wheels
remain supported, but selection requires SGR reports. See [the TUI reference](REFERENCE.md#using-the-tui) for limitations.

Apple documents [Allow Mouse Reporting](https://support.apple.com/guide/terminal/turn-on-mouse-reporting-trmlc69728a5/mac).
A terminal that disables reporting can still scroll its own history; the app cannot
force permission. Native selection/link modifiers are terminal-dependent, not a
portable substitute for this in-app selection. OSC 8 targets remain available in
unselected text. No physical Apple Terminal GUI validation was performed. Tests
inject packets into an owned PTY and use fake clipboard adapters or the SSH guard;
they do not touch the user's clipboard or prove native mouse gestures.

---

# Wheel scrolling: screen-isolation investigation

## Parser compatibility follow-up from `001954519bea7a16665c99a3cfa71cddc988a028`

**This fixes reproduced input-parser faults, not a verified cause of Apple
Terminal exposing prelaunch shell output.** The user confirmed ordinary
wheel/trackpad input with **no modifier** in a fresh `bun run dev start` launch,
and chose pinned header/footer with application-owned wheel scrolling and
terminal-modifier selection. Physical behavior is still unverified here.

### Reproduced faults and code changes

The same small characterization was run against this worktree's base `keys.ts`
and the changed implementation, with no live app, model, credentials or native
terminal interaction:

| Input | Base behavior | New behavior |
| --- | --- | --- |
| `ESC` in one read, `[<64;10;10M` in the next | `escape`, then printable report remainder | one `wheelup` |
| Legacy X10 `ESC[M` + bytes `96,42,42` | printable `` `** `` | one `wheelup` |
| SGR `<66;10;10M` (horizontal) | `wheelup` | consumed, no event |
| SGR `<64M` (missing coordinates) | `wheelup` | consumed, no event |
| SGR `<96;10;10M` (motion bit) | `wheelup` | consumed, no event |

- `keys.ts` now frames tokens incrementally, rather than detecting only some
  incomplete escape suffixes. An isolated ESC waits **25ms** outside the OSC
  query window (not the full 300ms sequence timeout). A complete key/report
  cancels that timer. This retains responsive Escape and allows an ESC-prefixed
  Alt chord or report split immediately after ESC to complete. Esc followed by
  a character within that window is inherently indistinguishable from Alt;
  after the deadline they are separate keys. No finite timeout can guarantee
  joining fragments delayed arbitrarily long. Recognized incomplete mouse
  reports are dropped at the 300ms idle timeout, not emitted as Escape; bytes
  arriving after that timeout are new input, not an indefinite mouse drain.
- Both SGR and **classic three-byte X10** packets are consumed as whole packets,
  including unknown buttons. Only vertical wheel press codes 64/65 with optional
  Shift/Alt/Ctrl bits scroll. Horizontal/release/motion/extended buttons and
  malformed SGR fields inside a CSI envelope are ignored. Coordinates must be
  positive safe integers. This does not enable another mouse mode or claim to
  support every protocol (e.g. UTF-8-extended X10/1005 or urxvt/1015).
- `term.ts` leaves stdin as bytes so X10's binary coordinates cannot be merged or
  replaced by a UTF-8 decoder. Text is decoded after framing, retaining split
  Unicode characters (even across idle periods), Alt chords and bracketed paste.
  Ctrl+C still interrupts input, including an incomplete mouse/CSI/OSC reply;
  OSC buffering/draining remains bounded. Crash/signal cleanup now also removes
  the reader/listener, so a pending Escape timer cannot survive cleanup.
- **Draft-safe `/keys`: press Ctrl+G.** This opens the existing diagnostic without
  replacing chat, answer or no-page text/cursor, or changing input history. The
  shortcut is listed with `/keys` in `/help`. Ordinary `/keys` submission still
  works from an empty composer. Keys are echoed rather than acted on, Esc exits
  the diagnostic without clearing the draft, and Ctrl+C keeps its normal cancel/
  second-press exit semantics. No draft-saving state machine or shared command/
  submission handling changed; the app change is one chord and help text.

No alternate-screen, mouse-enable/disable, selection binding, scroll clamp,
full-history restoration, queue layout, terminal preference or shell history
policy was changed. Those existing features are not new fixes in this follow-up.
No native permissions were toggled, real sessions restarted, desktop automated,
other worktree inspected, live model/web request made, or credentials accessed.

### Deterministic evidence and remaining boundary

- Parser regressions exercise SGR and raw X10 split at **every byte boundary**,
  including byte-by-byte delivery, high binary coordinates, modified wheels,
  coalesced text/reports, ignored/malformed packets and cleanup. They also cover
  fragmented Unicode/Alt/keyboard protocols, bracketed paste, OSC terminators,
  Ctrl+C and the bounded Escape timer with a manual clock.
- `realTerminal` tests cover raw bytes after the background-query window,
  fragmented Unicode and reader teardown on close/crash. App integration sends
  bytes through `realTerminal -> keyReader -> App`, checking unchanged multiline
  Unicode draft/cursor, queued previews, pinned header/footer, top/bottom clamps,
  ignored packets, `/keys` output and no live mode leave or scrollback clear.
- Existing tiny-layout, resize, full-history, queue, modal and owned-PTY tests
  remain regression coverage. The PTY still injects bytes; it does **not** generate
  a physical Apple Terminal trackpad/wheel gesture. FakeScreen likewise does not
  model Terminal's native history viewport. None of these tests establishes the
  cause or resolution of the reported shell reveal.

The outstanding user observation, after **they** choose to restart with this
change, is to press **Ctrl+G** with their draft intact, then scroll normally over
content with no modifier: do `wheelup` / `wheeldown` JSON appear, or does Terminal
move to shell content? Esc ends the diagnostic. No need to replace/save the draft
elsewhere. Until then the physical report stays open, but this does not block
independent `/clear` implementation or justify a mode/history workaround.

### Local validation of this parser follow-up

Bun 1.4.2, isolated test fixtures (no live PARALLELS_HOME changes):

- Targeted keys/terminal/app/sticky/restore/continuity/layout/FakeScreen/owned-PTY/
  help suites: **201 pass, 0 fail**, five snapshots, 9,207 assertions in ten files.
- Full `bun test`: **754 pass, 0 fail**, five snapshots, 12,113 assertions in 57 files.
- `bun run check`, `bun run build`, and `git diff --check`: passed.
- The first full run correctly flagged three help snapshots after the new
  diagnostic hint; only those expected text changes were updated and inspected,
  then targeted/full checks rerun green. No hosted CI or native gesture result
  is implied by these local checks.

## Earlier full-history follow-up from `da5cc7405944ef253dbe6c95f8a3e564cf6e5a71`

Two separate issues must not be conflated:

- **Confirmed and fixed: older saved conversation was inaccessible inside the
  live app.** `App.restorePage()` requested only `MAX_RESTORED_ROWS` (200), while
  `exitHistory` expanded the originals only after quitting. It now restores all
  originals from the orchestrator's `Transcript.history()` accessor into the
  live page, preserving order and the usual exit transcript. Model compaction
  does not replace those originals. The bounded restore helper remains available
  for explicit previews, but is no longer the live conversation's access limit.
- **Not established or fixed: Apple Terminal's physical ordinary wheel/trackpad
  gesture revealing prelaunch shell history.** The user's evidence includes
  `Updating 4c3dbd8..da5cc74`, fast-forward output, and `bun run dev start` /
  `$ bun src/cli.ts start`. That is a fresh source launch, not evidence of a stale
  binary. It does not tell us which bytes (if any) reached stdin, whether the
  terminal's native history viewport moved while alternate screen stayed active,
  or whether their main UI has an intermediary such as tmux. Workers being in
  tmux establishes none of that.

### Application change and resource use

The app still owns one alternate-screen page with its existing pinned header,
multiline composer/footer, modal precedence and scroll clamps. No terminal mode,
mouse protocol, parser, terminal preference or selection binding was changed.
Rendered conversation rows remain cached between ordinary input/activity frames;
`stickyRows()` now slices only the visible history/tail rows instead of copying
all cached history on every key. Full restore/first render, page changes and
resize reflow still cost proportional to history, and complete history remains
in memory. This is not disk-backed pagination, nor an assurance of constant
startup/resize time for arbitrarily large transcripts. It removes the silent
access limit without introducing a new paging/anchor subsystem.

### Input-path evidence and native boundary

A second source audit found the same lifecycle as the earlier record below:
`term.open()` installs input/raw mode and enables `1049`, `1000`, `1006`, `2004`
once; `App.onKey()` routes delivered wheel reports to body scrolling unless an
explicit modal owns input; only cleanup leaves alternate screen. No ordinary
wheel path disables mouse reporting, scrolls the primary screen or invokes the
legacy scrollback-clearing renderer. Thus neither duplicate/repeated mode writes
nor clearing shell history is justified by the evidence.

Read-only public documentation adds an important distinction:

- Apple's [Terminal keyboard shortcuts](https://support.apple.com/guide/terminal/keyboard-shortcuts-trmlshtcts/mac)
  explicitly lists **Toggle “Allow Mouse Reporting”** (Command-R), and separate
  **Show/Hide alternate screen** commands. These are native Terminal controls,
  independent of the app requesting mouse reporting. This is evidence such a
  permission exists, **not** evidence of its current setting in the user's window.
  No permission was inspected live or toggled during this investigation.
- The [xterm control-sequence reference](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking)
  documents normal tracking (`1000`), SGR encoding (`1006`), wheel button codes,
  and native scroll-back versus alternate-scroll cursor-key translation. It
  explains the protocol the app requests; it is not an Apple Terminal gesture
  implementation or a claim Apple follows every xterm behavior.

If Terminal (or an intermediary) consumes the gesture without forwarding input,
application code cannot intercept it. A reporting-permission change or another
terminal would require an explicit user choice, not automatic preference writes
or redesign into an inline CLI/browser. No search fallback service was used:
subscription search returned no results; the cited public pages were read via
ordinary HTTP. At that stage the parser limitations were deferred. The parser
follow-up above fixes those reproducible faults, but their relationship to the
physical shell reveal remains a hypothesis until real input is observed.

The minimal next observation is **draft-safe `/keys`** (Ctrl+G after the user
chooses to run this follow-up; the earlier build required an empty composer):
make one normal gesture over the conversation and
report whether wheel JSON appears or the whole screen instead moves to shell
history. `/keys` echoes rather than scrolling; Esc exits it. This does not require
restarting the app or changing preferences. If no report arrives, the next step
is read-only inspection of the active window's **Allow Mouse Reporting** state
and whether the main UI is inside tmux, not toggling anything without approval.

### Regression evidence for this change

- App regression restores 140 wrapped assistant messages plus original user and
  post-checkpoint messages, exceeding twice the old 200-row preview budget. It
  reaches the original pre-compaction message **while alternate screen is still
  active**, preserves multiline draft/cursor and pinned bars, clamps at the top,
  keeps position during live output and resize, follows the tail again, switches
  projects and verifies complete ordered exit output without duplicate messages.
- A 100,000-row cache regression counts history accesses: ordinary frame/draft
  updates read at most the body viewport height, including frames straddling or
  entirely inside the transient tail, not all saved rows.
- `src/tui/scroll.pty.test.ts` runs the real source CLI in an owned PTY/shell,
  temporary HOME/PARALLELS_HOME, empty inbox and synthetic checkpointed history,
  without inherited credentials or tmux/gh on PATH. Sixty prelaunch shell
  sentinels, a multiline draft, injected SGR sweeps/clamps and `/quit` verify
  complete live history access, pinned bars, one mode entry/leave, no `3J`,
  preserved shell sentinels and exact before/after `stty -g` restoration.

These are **simulated input** and application-lifecycle tests, not physical Apple
Terminal verification. The physical acceptance target remains unverified until
the user checks it, including after any restart they choose to perform.

Local checks on this change (Bun 1.4.2; no hosted CI):

- Targeted app/sticky/term/keys/restore/continuity/layout/FakeScreen/owned-PTY suites:
  **171 pass, 0 fail**, 5,673 assertions across nine files.
- Full `bun test`: **708 pass, 0 fail**, five snapshots, 8,508 assertions across
  56 files.
- `bun run check`, `bun run build`, and `git diff --check`: passed.
- The owned PTY runs source through Bun, like the supplied reproduction; the
  successful build is a separate compile check, not native gesture verification.

## Earlier PR #53 investigation (documentation only)

### Outcome and scope

Investigated from `4c3dbd819a84491501e1c61e918491c879c7f067` (PR #52).
**No application fault explaining ordinary wheel/trackpad scrolling revealing
shell content was reproduced. No production behavior was changed.** This is not
a claim that the reported Apple Terminal behavior is fixed or disproved.

The reported client is Apple Terminal, with no modifier held. At the time of
this earlier investigation, restart status was unknown; the fresh-source launch
evidence above supersedes that uncertainty. The parent process reported
`Apple_Terminal` / `470.2` / `xterm-256color`; this investigation's worker was in
tmux. Neither that worker environment nor the private tmux tests establishes
that the user's TUI runs inside tmux.

The investigation used Bun 1.4.2, macOS 26.6.2 and, for an independent terminal
emulator check, a newly created private tmux 3.7c server. No existing GUI window,
user session, live project, credentials, terminal preferences or shell history
was modified. No model requests were made.

## Source-path audit

- `src/tui/term.ts`: `open()` enables alternate screen (`1049`), basic mouse
  reporting (`1000`), SGR mouse encoding (`1006`) and bracketed paste (`2004`)
  once. Normal close disables them and restores the cursor. Rescue also ends
  synchronized updates on `SIGTERM`, `SIGHUP`, uncaught exceptions and process
  exit. A close while the background reply is pending drains input in raw mode
  before handing stdin back. These modes were already present; adding duplicate
  sequences would not address the report.
- `src/tui/keys.ts`: ordinary delivered SGR wheel reports become `wheelup` or
  `wheeldown`, not draft text. Incomplete CSI parameters are buffered. There are
  separate parser limitations below; this is not a universal mouse-protocol or
  fragmentation guarantee.
- `src/tui/app.ts`: unmodal wheel events change only the conversation's scroll
  offset, by three rows per event, clamped between zero and the newest viewport.
  Menus, project lists, explicit question panels and `/keys` own input instead
  when open. They do not disable reporting or exit alternate screen.
- `src/tui/sticky.ts`: drawing uses bounded rows, absolute cursor positioning and
  row erasure, not line-feed scrolling of the primary buffer. Header/footer and
  composer remain pinned. The app's active drawing path does not call the legacy
  `render.reprint()` helper that contains a screen/scrollback clear.
- `src/tui/render.ts`: visible content is sanitized to remove screen-switching,
  scrolling and clearing escapes; only styling and hyperlinks remain. Normal
  `App.run()` cleanup deliberately restores the primary screen **before**
  printing the active transcript. Shell content becoming available after exit
  is expected, unlike a live wheel gesture escaping the conversation.

Uncatchable termination such as SIGKILL cannot guarantee terminal restoration;
that is not an ordinary live scrolling path.

No existing layout, history, draft, Ctrl+Q, selected-session Ctrl+C,
consumption-boundary queued-display or terminal-modifier selection behavior was
changed.

## Fresh-build, owned-terminal evidence

The probes were temporary investigation harnesses, not new product commands or
new tests included in the repository test count below.

### Compiled CLI through real PTYs

Built `dist/parallels` with `bun run build`, then launched it through
`Bun.spawn({ terminal: { cols: 100, rows: 24, ... } })` in fresh temporary homes.
Each child had an explicit environment: temporary `HOME` and `PARALLELS_HOME`,
`PATH=/usr/bin:/bin` (no tmux or gh), `TERM=xterm-256color`, no inherited provider
credentials, and no Git global/system configuration. Its cwd was the temporary
home, not a user's repository.

Reproduction setup and assertions:

1. Seed `projects/probe/repo/` and a single synthetic assistant transcript entry
   containing `APP_ROW_000` through `APP_ROW_159`; leave the inbox empty. Starting
   this restored, idle orchestrator does not call a model.
2. In an owned shell, record `stty -g` and print 60 `SHELL_SENTINEL_n` lines before
   launching the freshly compiled `parallels start probe`.
3. Capture actual process output. Send `ESC [ < 64 ; 10 ; 10 M` and the equivalent
   button-65 report through the PTY, not directly to `App.onKey()`.
4. Send 1,000 up events, 20 more at the top boundary, then 1,000 down events.
   Check that the body reaches/clamps at its first and last rows, the header and
   footer stay fixed, the draft survives, and no alternate-screen leave or
   scrollback-clear sequence is emitted during the live interaction.
5. Split a report after `ESC[<64;` across writes: scrolling still works and the
   report is not inserted into the draft. In `/keys`, complete wheel reports
   produce `{"name":"wheelup"}` and `{"name":"wheeldown"}`.
6. Inject `1049l`, `1047l`, `47l`, `3J` and `2S` escapes into the first/last
   synthetic transcript rows. They are removed before visible output; they do
   not leave alternate screen, clear shell history or scroll the terminal.
7. Exercise exit paths; compare the owned shell's before/after `stty -g`, count
   alternate-screen transitions, and replay complete captured output through
   `FakeScreen` to check the visible buffer and preserved shell sentinels.

| Exit path | Child status | Alternate entry / leave | Terminal attributes |
| --- | ---: | --- | --- |
| `/quit` after wheel tests | 0 | one / one | restored exactly |
| `SIGTERM` | 143 | one / one | restored exactly |
| `SIGHUP` | 129 | one / one | restored exactly |
| `/quit` entered during startup | 0 | one / one | restored exactly |
| Startup error: project path is a regular file | 1 | one / one | restored exactly |
| Uncaught exception in a fresh compiled fake-orchestrator fixture | 1 | one / one | restored exactly |

The crash fixture used the real `App` and terminal, a synthetic history, no-op
liveness/watchers, and an orchestrator whose send/turn methods throw instead of
calling a model. Only that owned fixture deliberately crashed. The ordinary
CLI was used for the other five cases. For the startup-error case, assertions
checked raw mode/escape restoration rather than replaying diagnostic stderr as
TUI content. Early `/quit` does not prove close-before-background-timeout: the app
still awaits startup/background completion; the existing terminal unit tests
cover close during that reply window directly.

PTY delivery establishes byte handling, **not** physical wheel-to-byte conversion
by Apple Terminal. `FakeScreen` is also not an implementation of Terminal's
native scrollback UI.

### Independent private tmux terminal emulator

Started a new server with an explicitly private temporary socket and
`-f /dev/null`, using only that socket for every tmux command. No existing server
was queried or reconfigured. The child again ran the fresh CLI in an isolated
home, with no tmux/gh in its PATH. The server was destroyed after the probe.

The same sentinel/history setup and injected SGR sweeps passed. Visible captures
contained only the TUI while running. `alternate_on`, `mouse_standard_flag` and
`mouse_sgr_flag` were all `1`. Resizing the owned pane through `100x25`, `23x12`,
`6x6`, `1x1`, `80x24` and `100x24`, and scrolling at each size, did not expose a
shell sentinel in the visible pane. `/close` of the last page kept alternate
screen and reporting enabled; `/quit` restored them to `0` and restored terminal
attributes exactly.

**Important distinction:** tmux retained 36 primary-history rows while alternate
screen was active. A capture explicitly requesting *all history* (`capture-pane
-S -`) could retrieve those shell sentinels, whereas the normal visible capture
could not. The history size stayed 36 during live scrolling and resizing; it was
39 after closing the last page and quitting. This is preserved native history,
not proof the application left alternate screen. It also demonstrates why a
FakeScreen-only check cannot prove that a terminal's own history UI is
inaccessible. This observation is about the private tmux instance, not the
user's unidentified execution context or Apple Terminal's physical gestures.

## Earlier parser limitations distinguished from screen isolation

Small direct `keyReader` / `parseKeys` characterizations also found:

- Splitting an SGR report immediately after its **first ESC**, after the
  background-query window, emits `escape` and then printable report text. A lone
  ESC is intentionally delivered immediately by the current parser; holding an
  incomplete CSI only helps once `ESC[` has arrived. Splits tested after 2, 3,
  6 and 10 characters produced the expected wheel event.
- Legacy X10 mouse payload bytes are not decoded as wheel events; the parser
  requests/supports SGR instead. A synthetic `ESC[M` plus its three payload bytes
  leaves payload text as characters.
- SGR horizontal-wheel button values 66/67 are currently interpreted as vertical
  up/down, rather than distinguished from 64/65.

These can affect scrolling accuracy or draft text if those inputs actually
arrive. None of the characterized inputs caused an alternate-screen leave or
made the app scroll the primary buffer. No evidence connects them to the user's
reported shell reveal, and actual Apple Terminal bytes were not captured.
Changing immediate-Esc semantics, adding mouse protocols, or changing gesture
handling speculatively was therefore deferred at that time. The authorized
follow-up above now fixes the independently reproduced parser faults, still not
presented as a verified fix for the physical shell reveal. A raw-byte capture
would be needed if `/keys` exposes malformed reports.

## What still needs native/user verification

Read-only inspection of persisted Terminal settings found no explicit
mouse/scroll/alternate-screen keys. This does **not** establish the active
window's profile, effective defaults, runtime mouse-reporting permission or
physical gesture behavior. No preference was toggled. No claim is made about
Apple Terminal's actual text-selection modifier.

Before further action, ask the user to perform a small native check; do not drive
or restart their existing session automatically:

1. In a suitable idle app running this follow-up, press **Ctrl+G** to open `/keys`
   without replacing the draft. (On the older build, use an empty composer.) Make an
   ordinary wheel/trackpad gesture **over the content area, with no modifier**.
   The expected evidence is `wheelup` / `wheeldown` JSON. `/keys` intentionally
   echoes rather than scrolling the application history; Esc ends it. Report
   whether the whole screen instead moves to shell content, whether the header
   stays fixed, or whether the composer receives report fragments/arrows.
2. If no wheel events reach `/keys`, inspect (without toggling) the active
   Terminal window's mouse-reporting permission and relevant scrolling settings.
   Missing reports could be Terminal/native scrollback behavior, an intermediary
   such as tmux, or actual gesture location. Do not infer which from `TERM` alone.
3. The user has since supplied a fresh updated-source launch through
   `bun run dev start`; a stale compiled binary is not an explanation for that
   reproduction. After choosing to restart their own app with changes, the user
   must verify physical gestures themselves. Do not restart or drive their live
   session as part of an automated test.
4. If a fresh native run receives valid wheel events yet exposes shell content,
   collect the exact emitted modes, wheel bytes and whether it is the native
   history viewport moving. That would provide evidence for an app/terminal
   compatibility fix instead of duplicating modes or erasing history.

Native interaction or a preference-change experiment requires the user's
participation/approval first. Retain application mouse-wheel capture and
terminal-modifier selection; disabling capture or clearing shell scrollback is
not an acceptable workaround.

## Local checks on the earlier investigated base

After `bun install --frozen-lockfile` (the isolated worktree initially had no
local dependency install):

- Terminal/key/sticky/FakeScreen/layout/continuity suites: **62 pass, 0 fail**,
  4,352 assertions across six files.
- `bun test src/tui/app.test.ts`: **87 pass, 0 fail**, 1,098 assertions.
- Full `bun test`: **652 pass, 0 fail**, 7,961 assertions across 51 files.
- `bun run check`: passed.
- `bun run build`: passed; fresh compiled CLI used by the probes above.
- `git diff --check`: passed.

In PR #53 only the earlier investigation record was committed. There was no
production fix in that PR, no new behavior to merge with the independent `/help`
work, and no hosted CI result implied by those local checks.
