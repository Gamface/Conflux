---
name: desktop-automation
description: Drive native desktop apps through their accessibility tree with refs, not pixels. Use for any task in a desktop application (Calculator, Finder, Music, Slack, Electron apps).
---

# Desktop automation (snapshot → act → verify)

The desktop tools wrap an accessibility CLI. Elements appear as `[@e5] button "7"` lines.

1. `desktop_apps` if you are unsure what is running; `desktop_open` to launch.
2. `desktop_snapshot app=<App>` — read the refs. Refs are only valid for the latest snapshot.
3. Act on refs: `desktop_click target=e5 app=<App>`, `desktop_type text="…" target=e3 app=<App>`, `desktop_key combo=cmd+k app=<App>`.
4. **Re-snapshot to verify** the state changed as expected (or `desktop_text` to read results).
5. If a ref is stale, snapshot again — never guess refs.

## Selectors when refs are not enough
`'role=button'`, `'name="Login"'`, `'name~="Log"'` (contains), `'button "Submit"'`, `'role=button index=2'`.

## Pitfalls
- Electron apps are reached via CDP automatically; the first call may take ~5 s.
- Actions that submit, pay or delete will usually require the user's approval — explain what you are about to do first.
