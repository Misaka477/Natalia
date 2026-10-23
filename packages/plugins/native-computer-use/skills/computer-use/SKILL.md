---
name: computer-use
description: Use before driving the desktop with the computer_* tools — window enumeration, screenshots, clicking, typing, keys — and whenever a click "did nothing". Carries the probe-first rhythm, the physical-coordinate rules, and the verification discipline these tools are built around.
---

# Driving the desktop

Eleven tools, one discipline: **probe, then one action, then verify.** The
desktop has no DOM to re-read, so the window listing and the state object
are the only two ways to know what is true, and every action reports what
it actually did.

## The rhythm

1. `computer_windows` — enumerate. Always first, even when you think you
   know what is open: it answers what exists, which one is in front, and
   where it is. A click decided without it is a guess about which window
   the coordinates belong to.
2. `computer_state` — **the main read.** One call returns the window's
   addressable controls (name, type, value, rect), where the focus is, the
   visible text, and WHAT CHANGED since your last read. Prefer it over
   `computer_screenshot`: an image costs context and answers one question,
   a state object answers four.
3. `computer_find` — locate a control BY NAME, with its rect and whether it
   is writable, when you already know what you are looking for.
4. `computer_activate` — bring the target window to the front. Input goes
   to the foreground window whatever you intended.
5. ONE action: `computer_click`, `computer_type`, `computer_key`, or
   `computer_fill` (the whole fill-and-submit as one verified operation).
6. Verify: read the action's own verdict, or call `computer_state` again and
   read its `diff`. Do not chain several actions into one decision — a
   desktop does not tell you what happened in between.

## Coordinates

Every coordinate these tools take is a **physical screen pixel**, on the
same grid `computer_state` and `computer_screenshot` report:

- A point read off a **window** screenshot is relative to that window's
  CLIENT AREA origin. `computer_state` carries `window.clientOrigin`; add
  it before clicking: `screen = clientOrigin + point`. The window's
  rectangle is wrong for this — it includes the title bar and borders,
  which is exactly the offset that lands a click one title-bar above its
  target.
- A point read off a **full-screen** screenshot is already a screen point.
- Coordinates are integers. Never estimate from a scaled image: capture the
  window, not the screen, and use the numbers the answer reports.

## Verification

`computer_click` samples the pixels around the point before and after and
reports the verdict:

- **verified** — the screen changed; the answer gives the size of the
  change.
- **nothing changed** — the click reached the screen and the page did not
  answer it. Check in order: the coordinate transform, whether another
  window is in front, whether the target is disabled. **Do not click the
  same pixel again** — re-enumerate and re-read the state first. Clicking a
  wrong point twice is how a dialog gets dismissed by accident.
- A tiny change (a caret, a hover tint) is noise, not a response.

`computer_fill` reports each phase (locate → focus → clear → type → submit
→ confirm) and names the one that failed, with what it saw: a field that
did not accept the text and a target that was busy are different problems,
and `ok: false` alone is not a report.

## Waiting instead of guessing

`computer_wait` polls a condition until a deadline — a control enabled, a
window title, a window in front, a pixel region stable. Use it instead of a
sleep: a delay is a guess, a wait is a fact. When it times out it says so
and tells you to re-read rather than wait longer.

## Scope and honesty

- These tools act on the real desktop: they click real buttons and type
  real text. One action at a time, and stop when a result surprises you.
- A refused platform (no Windows input/capture layer) answers with the
  reason at call time. It is not a bug to work around.
- The accessibility layer (UIA) is what `computer_state` and
  `computer_find` read. It sees rendered content, but it is not
  omniscient: canvas-drawn content (games, video, self-drawn UI) is not in
  the tree, and for those the screenshot + coordinates path is the
  fallback. Never pretend the tree covered something it did not.
