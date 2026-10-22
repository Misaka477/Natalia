---
name: computer-use
description: >-
  Use before driving the desktop with the computer_* tools — window
  enumeration, screenshots, clicking, typing, keys — and whenever a click
  "did nothing". Carries the probe-first rhythm, the physical-coordinate
  rules, and the verification discipline these tools are built around.
---

# Driving the desktop

Six tools, one discipline: **probe, then one action, then verify.** The
desktop has no DOM to re-read, so the window listing and the screenshot are
the only two ways to know what is true, and every action reports what it
actually did.

## The rhythm

1. `computer_windows` — enumerate. Always first, even when you think you
   know what is open: it answers what exists, which one is in front, and
   where it is. A click decided without it is a guess about which window
   the coordinates belong to.
2. `computer_activate` — bring the target window to the front. Input goes
   to the foreground window whatever you intended.
3. `computer_screenshot` — capture. Prefer a window over the whole screen:
   a full-screen image costs context and answers less.
4. ONE action: `computer_click`, `computer_type`, or `computer_key`.
5. Verify: read the click's verdict, or take another screenshot. Do not
   chain several actions into one decision — a desktop does not tell you
   what happened in between.

## Coordinates

Every coordinate these tools take is a **physical screen pixel**, on the
same grid the screenshot is captured on. The rules:

- A point read off a **window** screenshot is relative to that window's
  CLIENT AREA origin. The screenshot's answer carries
  `window.clientOrigin`; add it before clicking:
  `screen = clientOrigin + point`. The window's rectangle is wrong for
  this — it includes the title bar and borders, which is exactly the
  offset that lands a click one title-bar above its target.
- A point read off a **full-screen** screenshot is already a screen point.
- Coordinates are integers. Never estimate from a scaled image: capture
  the window, not the screen, and use the numbers the capture reports.

## Verification

`computer_click` samples the pixels around the point before and after and
reports the verdict:

- **verified** — the screen changed; the answer gives the size of the
  change.
- **nothing changed** — the click reached the screen and the page did not
  answer it. Check in order: the coordinate transform, whether another
  window is in front, whether the target is disabled. **Do not click the
  same pixel again** — re-enumerate and re-screenshot first. Clicking a
  wrong point twice is how a dialog gets dismissed by accident.
- A tiny change (a caret, a hover tint) is noise, not a response.

`computer_type` and `computer_key` report the window that had focus when
they sent. If that is not the window you meant, activate it first — the
answer is the fact that tells you.

## Scope and honesty

- These tools act on the real desktop: they click real buttons and type
  real text. One action at a time, and stop when a result surprises you.
- A refused platform (no Windows input/capture layer) answers with the
  reason at call time. It is not a bug to work around.
- Never start a second copy of anything to make a click land: if the target
  is not there, the enumeration would have said so.
