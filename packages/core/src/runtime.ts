import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "./db.ts";
import { EventBus } from "./events.ts";
import { loadConfig, saveOverride, type Config, type Coworker } from "./config.ts";
import { validatePolicy, type Policy } from "./governance/policy.ts";
import { ApprovalCenter } from "./governance/approvals.ts";
import { Gateway } from "./governance/gateway.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { MemoryStore } from "./learning/memory.ts";
import { SkillStore } from "./learning/skills.ts";
import { PageStore } from "./stores/pages.ts";
import { KnowledgeStore } from "./stores/knowledge.ts";
import { AgentRunner } from "./agent/runner.ts";
import { WorkflowEngine, httpRequestTool, codeRunTool } from "./workflow/engine.ts";
import { TaskQueue, Scheduler } from "./tasks/queue.ts";
import { BrowserManager, browserTools } from "./computer/browser.ts";
import { desktopTools } from "./computer/desktop.ts";
import { McpManager } from "./mcp/client.ts";
import { learningTools } from "./tools/learning.ts";
import { planningTools } from "./tools/planning.ts";
import { fileTools } from "./tools/files.ts";
import { webTools } from "./tools/web.ts";
import { spaceTools } from "./tools/spaces.ts";
import { knowledgeTools } from "./tools/knowledge.ts";
import { orchestrationTools } from "./tools/orchestration.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export class CoworkerRegistry {
  private rt: Runtime;
  constructor(rt: Runtime) {
    this.rt = rt;
  }
  list(): Coworker[] {
    return this.rt.config.coworkers;
  }
  get(id: string): Coworker | undefined {
    return this.rt.config.coworkers.find((c) => c.id === id);
  }
  upsert(c: Coworker): Coworker {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(c.id)) throw new Error("coworker id must be kebab-case");
    if (!c.name || !c.role) throw new Error("coworker needs a name and role instructions");
    c.tools ??= ["*"];
    const i = this.rt.config.coworkers.findIndex((x) => x.id === c.id);
    if (i >= 0) this.rt.config.coworkers[i] = c;
    else this.rt.config.coworkers.push(c);
    saveOverride(this.rt.config, { coworkers: [c] });
    return c;
  }
}

/** Everything a run needs, wired once per process. */
export class Runtime {
  readonly config: Config;
  readonly db: Db;
  readonly bus = new EventBus();
  readonly tools = new ToolRegistry();
  readonly gateway = new Gateway();
  readonly approvals: ApprovalCenter;
  readonly memory: MemoryStore;
  readonly skills: SkillStore;
  readonly pages: PageStore;
  readonly knowledge: KnowledgeStore;
  readonly coworkers: CoworkerRegistry;
  readonly runner: AgentRunner;
  readonly workflows: WorkflowEngine;
  readonly tasks: TaskQueue;
  readonly scheduler: Scheduler;
  readonly browser: BrowserManager;
  readonly mcp: McpManager;
  policy: Policy;
  log: (...a: unknown[]) => void;

  constructor(config?: Config, opts: { quiet?: boolean; dbPath?: string } = {}) {
    this.config = config ?? loadConfig();
    this.log = opts.quiet ? () => {} : (...a) => console.log("[conflux]", ...a);
    mkdirSync(this.config.dataDir, { recursive: true });
    this.db = new Db(opts.dbPath ?? join(this.config.dataDir, "conflux.db"));
    this.policy = this.config.policy;
    this.approvals = new ApprovalCenter(this.db, this.bus);
    this.memory = new MemoryStore(this.config.dataDir);
    this.skills = new SkillStore(join(REPO_ROOT, "skills"), this.config.dataDir, this.db);
    this.pages = new PageStore(this.db);
    this.knowledge = new KnowledgeStore(this.db);
    this.coworkers = new CoworkerRegistry(this);
    this.runner = new AgentRunner(this);
    this.workflows = new WorkflowEngine(this);
    this.tasks = new TaskQueue(this);
    this.scheduler = new Scheduler(this);
    this.browser = new BrowserManager(this);
    this.mcp = new McpManager(this);

    this.tools.register(
      ...learningTools, ...planningTools, ...fileTools, ...webTools, ...spaceTools, ...knowledgeTools,
      ...orchestrationTools, httpRequestTool, codeRunTool, ...browserTools, ...desktopTools,
    );
    this.workflows.seed(join(REPO_ROOT, "examples", "workflows"));
    this.seedKnowledge(join(REPO_ROOT, "examples", "knowledge"));
    this.workflows.registerTools();
  }

  /** First run only: index the sample handbook so retrieval and the kb-answer workflow work out of the box. */
  private seedKnowledge(dir: string): void {
    if (!existsSync(dir) || this.db.get("SELECT 1 FROM knowledge LIMIT 1") || this.db.get("SELECT 1 FROM threads LIMIT 1")) return;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(dir, f), "utf8");
      const title = text.match(/^#\s+(.+)$/m)?.[1] ?? f;
      this.knowledge.add("handbook", title, text, `examples/knowledge/${f}`);
    }
  }

  workspaceDir(coworkerId: string): string {
    const d = join(this.config.dataDir, "workspaces", coworkerId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  setPolicy(p: Policy): void {
    const errs = validatePolicy(p);
    if (errs.length) throw new Error(errs.map((e) => `${e.rule}: ${e.error}`).join("; "));
    this.policy = p;
    this.config.policy = p;
    saveOverride(this.config, { policy: p });
  }

  /** Start background services: task workers, scheduler, MCP servers. */
  async start(): Promise<void> {
    this.tasks.start();
    this.scheduler.start();
    await this.mcp.start();
  }

  async stop(): Promise<void> {
    this.tasks.stop();
    this.scheduler.stop();
    this.mcp.stop();
    await this.browser.close();
    this.db.close();
  }
}
