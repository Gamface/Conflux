/**
 * A small, dependency-free, side-effect-free expression language — a practical subset of CEL.
 *
 * OpenBot's insight: a boundary a company wants is a sentence ("never click Submit on a page outside
 * our domain"), so policies are expressions, not rule tables. The same language drives workflow
 * if/else branches, so there is one thing to learn.
 *
 *   tool.name == "browser_click" && element.name.matches("(?i)submit|pay") && !page.host.endsWith("acme.com")
 *   action.effect in ["write", "destructive"] && coworker.id != "admin"
 *   args.path.startsWith("secrets/") || has(args.force)
 *
 * Evaluation is fail-closed: an unknown field or a type error throws, and the policy engine treats a
 * throwing rule as refused. A rule that cannot be evaluated never grants permission.
 */

export class ExprError extends Error {}

type Node =
  | { k: "lit"; v: unknown }
  | { k: "id"; name: string }
  | { k: "list"; items: Node[] }
  | { k: "member"; obj: Node; prop: string }
  | { k: "index"; obj: Node; idx: Node }
  | { k: "call"; fn: string; target?: Node; args: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "cond"; c: Node; t: Node; f: Node };

type Tok = { t: "num" | "str" | "id" | "op" | "eof"; v: string };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", ".", "?", ":"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new ExprError("unterminated string");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character '${c}' at ${i}`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  out.push({ t: "eof", v: "" });
  return out;
}

class Parser {
  private p = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  private peek(): Tok {
    return this.toks[this.p];
  }
  private next(): Tok {
    return this.toks[this.p++];
  }
  private accept(v: string): boolean {
    const t = this.peek();
    if ((t.t === "op" || t.t === "id") && t.v === v) {
      this.p++;
      return true;
    }
    return false;
  }
  private expect(v: string): void {
    if (!this.accept(v)) throw new ExprError(`expected '${v}' but found '${this.peek().v || "end"}'`);
  }
  parse(): Node {
    const n = this.cond();
    if (this.peek().t !== "eof") throw new ExprError(`unexpected '${this.peek().v}'`);
    return n;
  }
  private cond(): Node {
    const c = this.or();
    if (this.accept("?")) {
      const t = this.cond();
      this.expect(":");
      return { k: "cond", c, t, f: this.cond() };
    }
    return c;
  }
  private or(): Node {
    let a = this.and();
    while (this.accept("||")) a = { k: "bin", op: "||", a, b: this.and() };
    return a;
  }
  private and(): Node {
    let a = this.rel();
    while (this.accept("&&")) a = { k: "bin", op: "&&", a, b: this.rel() };
    return a;
  }
  private rel(): Node {
    const a = this.add();
    for (const op of ["==", "!=", "<=", ">=", "<", ">", "in"]) {
      if (this.accept(op)) return { k: "bin", op, a, b: this.add() };
    }
    return a;
  }
  private add(): Node {
    let a = this.mul();
    for (;;) {
      if (this.accept("+")) a = { k: "bin", op: "+", a, b: this.mul() };
      else if (this.accept("-")) a = { k: "bin", op: "-", a, b: this.mul() };
      else return a;
    }
  }
  private mul(): Node {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        this.next();
        a = { k: "bin", op: t.v, a, b: this.unary() };
      } else return a;
    }
  }
  private unary(): Node {
    if (this.accept("!")) return { k: "un", op: "!", a: this.unary() };
    if (this.accept("-")) return { k: "un", op: "-", a: this.unary() };
    return this.postfix();
  }
  private args(): Node[] {
    const args: Node[] = [];
    if (!this.accept(")")) {
      do args.push(this.cond());
      while (this.accept(","));
      this.expect(")");
    }
    return args;
  }
  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.accept(".")) {
        const id = this.next();
        if (id.t !== "id") throw new ExprError("expected field name after '.'");
        if (this.accept("(")) n = { k: "call", fn: id.v, target: n, args: this.args() };
        else n = { k: "member", obj: n, prop: id.v };
      } else if (this.accept("[")) {
        const idx = this.cond();
        this.expect("]");
        n = { k: "index", obj: n, idx };
      } else return n;
    }
  }
  private primary(): Node {
    const t = this.next();
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "id") {
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      if (this.accept("(")) return { k: "call", fn: t.v, args: this.args() };
      return { k: "id", name: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      const n = this.cond();
      this.expect(")");
      return n;
    }
    if (t.t === "op" && t.v === "[") {
      const items: Node[] = [];
      if (!this.accept("]")) {
        do items.push(this.cond());
        while (this.accept(","));
        this.expect("]");
      }
      return { k: "list", items };
    }
    throw new ExprError(`unexpected '${t.v || "end of expression"}'`);
  }
}

const cache = new Map<string, Node>();

export function compile(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    n = new Parser(lex(src)).parse();
    if (cache.size > 2000) cache.clear();
    cache.set(src, n);
  }
  return n;
}

function regex(pattern: string): RegExp {
  // Support the RE2 / CEL style "(?i)" prefix for case-insensitive matches.
  let flags = "";
  if (pattern.startsWith("(?i)")) {
    flags = "i";
    pattern = pattern.slice(4);
  }
  return new RegExp(pattern, flags);
}

function str(v: unknown, fn: string): string {
  if (typeof v !== "string") throw new ExprError(`${fn}() needs a string, got ${typeof v}`);
  return v;
}

function truthy(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new ExprError(`${where} needs a boolean, got ${JSON.stringify(v)}`);
  return v;
}

function ev(n: Node, env: Record<string, unknown>): unknown {
  switch (n.k) {
    case "lit":
      return n.v;
    case "list":
      return n.items.map((i) => ev(i, env));
    case "id":
      if (!(n.name in env)) throw new ExprError(`unknown name '${n.name}'`);
      return env[n.name];
    case "member": {
      const o = ev(n.obj, env);
      if (o === null || typeof o !== "object" || !(n.prop in (o as object))) {
        throw new ExprError(`no field '${n.prop}'`);
      }
      return (o as Record<string, unknown>)[n.prop];
    }
    case "index": {
      const o = ev(n.obj, env) as any;
      const i = ev(n.idx, env) as any;
      if (o === null || typeof o !== "object" || !(i in o)) throw new ExprError(`no index '${i}'`);
      return o[i];
    }
    case "un": {
      const a = ev(n.a, env);
      if (n.op === "!") return !truthy(a, "!");
      if (typeof a !== "number") throw new ExprError("unary - needs a number");
      return -a;
    }
    case "cond":
      return truthy(ev(n.c, env), "?:") ? ev(n.t, env) : ev(n.f, env);
    case "bin": {
      if (n.op === "&&") return truthy(ev(n.a, env), "&&") && truthy(ev(n.b, env), "&&");
      if (n.op === "||") return truthy(ev(n.a, env), "||") || truthy(ev(n.b, env), "||");
      const a = ev(n.a, env) as any;
      const b = ev(n.b, env) as any;
      switch (n.op) {
        case "==":
          return JSON.stringify(a) === JSON.stringify(b);
        case "!=":
          return JSON.stringify(a) !== JSON.stringify(b);
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "%":
          return a % b;
        case "in":
          if (Array.isArray(b)) return b.some((x) => JSON.stringify(x) === JSON.stringify(a));
          if (typeof b === "string") return b.includes(str(a, "in"));
          if (b && typeof b === "object") return a in b;
          throw new ExprError("'in' needs a list, string or map");
      }
      throw new ExprError(`unknown operator ${n.op}`);
    }
    case "call":
      return call(n, env);
  }
}

function call(n: Extract<Node, { k: "call" }>, env: Record<string, unknown>): unknown {
  // Macros that bind a variable: list.exists(x, pred), list.all(x, pred), list.filter(x, pred), list.map(x, expr)
  if (n.target && ["exists", "all", "filter", "map"].includes(n.fn)) {
    const list = ev(n.target, env);
    if (!Array.isArray(list)) throw new ExprError(`${n.fn}() needs a list`);
    const v = n.args[0];
    if (!v || v.k !== "id" || !n.args[1]) throw new ExprError(`${n.fn}(var, expr) expected`);
    const each = (item: unknown) => ev(n.args[1], { ...env, [v.name]: item });
    if (n.fn === "exists") return list.some((i) => truthy(each(i), "exists"));
    if (n.fn === "all") return list.every((i) => truthy(each(i), "all"));
    if (n.fn === "filter") return list.filter((i) => truthy(each(i), "filter"));
    return list.map(each);
  }
  if (!n.target && n.fn === "has") {
    try {
      const v = ev(n.args[0], env);
      return v !== undefined && v !== null;
    } catch {
      return false;
    }
  }
  const target = n.target ? ev(n.target, env) : undefined;
  const args = n.args.map((a) => ev(a, env));
  switch (n.fn) {
    case "startsWith":
      return str(target, n.fn).startsWith(str(args[0], n.fn));
    case "endsWith":
      return str(target, n.fn).endsWith(str(args[0], n.fn));
    case "contains":
      if (Array.isArray(target)) return target.includes(args[0]);
      return str(target, n.fn).includes(str(args[0], n.fn));
    case "matches":
      return regex(str(args[0], n.fn)).test(str(target ?? args[1], n.fn));
    case "lowerAscii":
      return str(target, n.fn).toLowerCase();
    case "upperAscii":
      return str(target, n.fn).toUpperCase();
    case "size": {
      const v = n.target ? target : args[0];
      if (typeof v === "string" || Array.isArray(v)) return v.length;
      if (v && typeof v === "object") return Object.keys(v).length;
      throw new ExprError("size() needs a string, list or map");
    }
    case "string":
      return String(args[0]);
    case "int":
      return Math.trunc(Number(args[0]));
    case "double":
      return Number(args[0]);
    case "now":
      return Date.now();
  }
  throw new ExprError(`unknown function ${n.fn}()`);
}

export function evaluate(src: string, env: Record<string, unknown>): unknown {
  return ev(compile(src), env);
}

/** Evaluate a boolean rule. Throws ExprError on anything that is not a clean boolean. */
export function test(src: string, env: Record<string, unknown>): boolean {
  const v = evaluate(src, env);
  if (typeof v !== "boolean") throw new ExprError(`rule must produce a boolean, got ${JSON.stringify(v)}`);
  return v;
}

export function validate(src: string): string | null {
  try {
    compile(src);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
