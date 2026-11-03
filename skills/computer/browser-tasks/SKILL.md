---
name: browser-tasks
description: Complete tasks on websites with your own persistent browser — navigate, read, fill forms, and hand control to the user for logins or anything risky.
---

# Browser tasks

1. `browser_navigate url=…` → read the `[@eN]` refs and visible text that come back.
2. Act with `browser_click ref=eN` / `browser_type ref=eN text=… submit=true`. Each action returns a fresh snapshot — use only refs from the most recent one.
3. **Logins**: never ask for passwords in chat. Ask the user to open the Computer panel and take control to sign in; your profile keeps the session afterwards.
4. Prefer `web_fetch` for static pages (cheaper); use the browser for JavaScript apps, logins and forms.
5. Before submitting anything that sends, buys, books or deletes, summarise exactly what will be submitted. Policy may require approval — that is expected.

## Verify
After the final action, snapshot once more and confirm the success state (confirmation text, URL change) before reporting done.
