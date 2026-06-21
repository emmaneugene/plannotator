# Bug: `/plannotator-last` shows a blank page with 2+ assistant messages

## Title

`/plannotator-last` renders a blank page when the session has more than one recent assistant message

## Summary

`/plannotator-last` opens a blank Plannotator page whenever the current Pi session has **two or more** recent assistant messages. The page never renders; the browser console shows React's minified error `#301` ("Too many re-renders").

With zero or one recent assistant message it works fine, so the failure looks intermittent — but it's actually deterministic based on message count.

## Impact

Users can't annotate the last assistant response in any normal multi-turn session. The server starts and the browser opens, but the React app crashes before drawing the annotation UI, leaving an empty page.

## Reproduction

1. Start Pi with the Plannotator Pi extension installed.
2. Have a conversation that produces **at least two** assistant responses.
3. Run `/plannotator-last`.
4. Open the Plannotator URL.

- **Expected:** the last assistant message renders and can be annotated.
- **Actual:** blank page; console shows React error `#301` / "Too many re-renders".

## Root cause

This is a classic React anti-pattern: **calling `setState` during render** creates an infinite render loop.

The trigger only fires in multi-message mode:

```ts
messageMultiSelectMode = annotateSource === 'message' && recentMessages.length > 1
```

That's why one message is fine but two or more crashes.

### How setState gets called during render

`currentFeedbackPayload` is computed in a `useMemo` (i.e. during render). Following the call chain:

```text
useMemo(() => getCurrentFeedbackPayload())   ← runs during render
  └─ getCurrentFeedbackPayload()
       └─ buildFullAnnotationsOutput()
            └─ buildMessageAnnotationEntries()
                 └─ saveCurrentMessageState()
                      └─ setCachedMessageAnnotationCounts(...)   ← setState!
```

`saveCurrentMessageState()` writes React state:

```ts
setCachedMessageAnnotationCounts(buildMessageAnnotationCounts(states));
```

Because it produces a **fresh `Map` every time**, React's `Object.is` bail-out never kicks in. Each render schedules another render, repeating until React gives up and throws `#301`.

### Why this regressed

Commit `1fa60522` ("perf: defer multi-message annotation export to submit time") converted `messageAnnotationEntries` from a render-time `useMemo` into an on-demand `useCallback` (`buildMessageAnnotationEntries`). The intent was to do this work only at submit time — but the callback was still reachable from the render-time `useMemo` above, so the `setState` inside it now runs during render.

## Fix

In `packages/editor/App.tsx`, `buildMessageAnnotationEntries()` now reads state instead of writing it:

```diff
- const states = saveCurrentMessageState();
+ const states = getMessageStatesWithCurrent();
```

with matching dependency update:

```diff
- }, [annotateSource, recentMessages, saveCurrentMessageState]);
+ }, [annotateSource, recentMessages, getMessageStatesWithCurrent]);
```

`getMessageStatesWithCurrent()` returns the same merged data (cached message states + the live state of the currently selected message, via `buildCurrentMessageState()`) but is **pure** — it never calls `setState`. The exported feedback is unchanged; the render loop is gone.

`saveCurrentMessageState()` still exists and is still used by genuine event handlers (e.g. `handleSelectMessage`), where calling `setState` is correct.

## Verification

Using a harness server whose `/api/plan` returns two recent assistant messages:

| | Before fix | After fix |
|---|---|---|
| `#root` | stays empty | renders normally |
| Console | React error `#301` | no error |
| Message content | absent | visible |

## Build notes

For Pi extension testing, rebuild the plan UI and copy it into the Pi extension:

```bash
bun run build:hook
bun run --cwd apps/pi-extension build
```

If the review dist is missing (the hook build needs `review.html`), build it first:

```bash
bun run --cwd apps/review build
```
