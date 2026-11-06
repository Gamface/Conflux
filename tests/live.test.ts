// Live checks against the real internet. Skipped unless CONFLUX_LIVE=1 (CI "live" job).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRuntime, ctxFor } from "./helpers.ts";

const live = process.env.CONFLUX_LIVE === "1";

test("live: web_fetch reads a real page", { skip: !live }, async () => {
  const rt = makeRuntime();
  try {
    const r = await rt.gateway.execute("web_fetch", { url: "https://example.com" }, ctxFor(rt));
    assert.equal(r.isError, undefined, r.content);
    assert.match(r.content, /Example Domain/);
  } finally {
    await rt.cleanup();
  }
});

test("live: browser navigates, snapshots refs, clicks a link, and policy sees the real element", { skip: !live }, async () => {
  const rt = makeRuntime();
  try {
    const c = ctxFor(rt);
    const nav = await rt.gateway.execute("browser_navigate", { url: "https://example.com" }, c);
    assert.equal(nav.isError, undefined, nav.content);
    assert.match(nav.content, /\[@e1\] link "[^"]+"/);
    assert.ok((nav.data as any).screenshot.length > 1000, "screenshot captured");

    // A rule naming the visible link text must refuse the click, proving element resolution is live.
    rt.policy = { ...rt.policy, deny: [...rt.policy.deny, 'has(element) && element.role == "link" && element.name.matches("(?i)more information|learn more")'] };
    const refused = await rt.gateway.execute("browser_click", { ref: "e1" }, c);
    assert.match(refused.content, /Refused by policy/);

    rt.policy = { ...rt.policy, deny: rt.policy.deny.slice(0, -1) };
    const clicked = await rt.gateway.execute("browser_click", { ref: "e1" }, c);
    assert.equal(clicked.isError, undefined, clicked.content);
    assert.doesNotMatch((clicked.data as any).url, /^https:\/\/example\.com\/?$/, "navigated away");
  } finally {
    await rt.cleanup();
  }
});

test("live: a workflow fetches and summarises a real URL", { skip: !live }, async () => {
  const rt = makeRuntime();
  try {
    const r = await rt.workflows.run("summarize-url", { url: "https://example.com" });
    assert.equal(r.status, "succeeded", r.error ?? "");
    assert.match(String(r.outputs.summary), /\S/);
  } finally {
    await rt.cleanup();
  }
});

test("live: real model (Anthropic) answers and calls a tool", { skip: !live || !process.env.ANTHROPIC_API_KEY }, async () => {
  const rt = makeRuntime({ defaultModel: "anthropic" });
  try {
    const r = await rt.runner.run({ coworkerId: "assistant", input: "Save a page titled Live check with the body 'ok'. Then reply with just: done." });
    assert.equal(r.error, undefined);
    assert.equal(rt.pages.list()[0]?.title, "Live check");
  } finally {
    await rt.cleanup();
  }
});
