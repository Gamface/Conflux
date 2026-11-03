---
name: meeting-followups
description: Turn meeting notes or a transcript into owners, actions and dates that are actually in the text. Use when the user pastes notes and asks for follow-ups, action items or a recap.
---

# Meeting follow-ups

1. Read the whole note before extracting anything.
2. Extract only commitments that are **in the text**: who, what, by when. If an owner or date is missing, write `owner: ?` / `due: ?` — never invent one.
3. Group as:
   - **Decisions** (what was agreed)
   - **Actions** — table: Owner | Action | Due | Quote (≤ 10 words from the note that supports it)
   - **Open questions**
4. Save as a page `Follow-ups — <meeting> — <date>`.
5. Offer (do not perform) to schedule a reminder with `schedule_create` for the nearest due date.

## Verify
Every action row has a supporting quote. Count of actions matches the count of commitments you found on a second pass.
