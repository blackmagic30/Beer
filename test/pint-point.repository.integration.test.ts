import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PintPointRepository } from "../src/db/pint-point.repository.js";
import { sqlDatabaseInternals, type SqlBindings, type SqlDatabase, type SqlStatement, type SqlPoolMetrics } from "../src/db/sql-database.js";
import { assertPostgresFixtureDisconnected, trackPostgresPoolShutdown } from "./helpers/postgres-pool-shutdown.js";
const ADMIN_URL_ENV = "PINTPATH_PILOT_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be an explicit loopback PostgreSQL admin URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || !url.password
    || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash
    || /[\r\n\0]/.test(value)
  ) throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`);
  return url;
}

function withDatabase(url: URL, database: string, username?: string, password?: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  if (username !== undefined) result.username = username;
  if (password !== undefined) result.password = password;
  return result.toString();
}

function token(label: string): string {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function normalizeBindings(bindings: unknown[]): SqlBindings {
  if (
    bindings.length === 1
    && bindings[0] !== null
    && typeof bindings[0] === "object"
    && !Array.isArray(bindings[0])
    && !Buffer.isBuffer(bindings[0])
    && !(bindings[0] instanceof Date)
  ) return bindings[0] as Readonly<Record<string, unknown>>;
  return bindings;
}

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])) as Row;
}

/** Direct PG adapter restricted to the explicitly insecure loopback rehearsal. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly closePool: () => Promise<void>;
  private readonly transactionClient = new AsyncLocalStorage<{ client: PoolClient; nextSavepoint: number }>();
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 16,
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000",
    });
    this.closePool = trackPostgresPoolShutdown(this.pool);
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    const executor = this.transactionClient.getStore()?.client ?? this.pool;
    try {
      const result = await executor.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      return { rows: result.rows.map(normalizeRow), rowCount: result.rowCount ?? 0 };
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...bindings) => {
        const result = await this.query(sql, normalizeBindings(bindings));
        return { changes: result.rowCount };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows[0];
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, []);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `venue_access_nested_${active.nextSavepoint++}`;
        await active.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work();
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
          throw error;
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.transactionClient.run({ client, nextSavepoint: 1 }, work);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        this.transactionFailures += 1;
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closePool();
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: "postgres",
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      completedQueries: this.completedQueries,
      failedQueries: this.failedQueries,
      transactionFailures: this.transactionFailures,
      lastQueryDurationMs: null,
    };
  }
}

describe.skipIf(!configuredAdminUrl)("canonical PostgreSQL Pint Points pilot", () => {
  const databaseName = "pintpath_pilot_points_integration_test";
  const login = "pintpath_pilot_points_integration_login";
  const now = "2026-09-10T01:00:00.000Z";
  const expiry = "2026-09-10T01:05:00.000Z";
  let admin: Client;
  let target: Client;
  let db: LoopbackPostgresTestDatabase;
  let repo: PintPointRepository;

  beforeAll(async () => {
    const url = validateAdminUrl(configuredAdminUrl);
    admin = new Client({connectionString: url.toString()});
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.query(`DROP ROLE IF EXISTS ${login}`);
    await admin.query(`CREATE DATABASE ${databaseName}`);
    target = new Client({connectionString: withDatabase(url, databaseName)});
    await target.connect();
    await target.query(fs.readFileSync("src/db/postgres-schema.sql", "utf8"));
    const password = crypto.randomBytes(24).toString("hex");
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT pintpath_runtime TO ${login}`);
    db = new LoopbackPostgresTestDatabase(withDatabase(url, databaseName, login, password));
    repo = new PintPointRepository(db);
    await db.prepare(`INSERT INTO accounts(id,public_account_id,email,password_hash,role,subscription_status,status,created_at,updated_at) VALUES
      ('manager','PP-MANAGER','manager@example.test','hash','venue_manager','free','active',@now,@now),
      ('staff','PP-STAFF','staff@example.test','hash','user','free','active',@now,@now),
      ('other','PP-OTHER','other@example.test','hash','venue_manager','free','active',@now,@now)`).run({now});
    await db.prepare(`INSERT INTO venue_manager_assignments(id,user_id,venue_id,venue_name,access_level,status,created_at,updated_at) VALUES
      ('manager-a','manager','venue-a','Pilot Hotel','manager','active',@now,@now),
      ('staff-a','staff','venue-a','Pilot Hotel','counter_staff','active',@now,@now),
      ('other-b','other','venue-b','Other Hotel','manager','active',@now,@now)`).run({now});
  }, 30000);
  afterAll(async () => {
    try {
      await db?.close();
      await target?.end();
      if (admin) {
        await assertPostgresFixtureDisconnected(admin, databaseName);
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
        await admin.query(`DROP ROLE IF EXISTS ${login}`);
      }
    } finally {
      await admin?.end();
    }
  }, 30000);

  async function customer() {
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO accounts(id,public_account_id,email,password_hash,status,created_at,updated_at) VALUES(?,?,?,'hash','active',?,?)").run(id,id,`${id}@example.test`,now,now);
    const session = token(id);
    await db.prepare("INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)").run(session,id,now,"2026-09-11T00:00:00.000Z");
    return {id,session};
  }
  async function purchase(user: Awaited<ReturnType<typeof customer>>, overrides = {}) {
    const pass = await repo.createDiscountPass({id:crypto.randomUUID(),userId:user.id,sessionTokenHash:user.session,codeHash:crypto.randomUUID(),createdAt:now,expiresAt:expiry});
    return {id:crypto.randomUUID(),userId:user.id,venueId:"venue-a",venueName:"Pilot Hotel",suburb:"Fitzroy",itemName:"Carlton Draught",beverageCategory:"alcoholic",quantity:1,isAlcoholic:true,source:"venue_portal",recordedByUserId:"staff",idempotencyKey:crypto.randomUUID(),recordedAt:now,metadata:{memberPassId:pass.id},...overrides};
  }
  async function readyReward() {
    const user=await customer();
    await repo.prepareDemoBalance({userId:user.id,venueId:"venue-a",actorUserId:"manager",target:50,now});
    const code=await repo.createFreePintRewardCode({id:crypto.randomUUID(),userId:user.id,publicAccountId:user.id,codeHash:crypto.randomUUID(),createdAt:now,expiresAt:expiry,metadata:{requestedVenueId:"venue-a"}});
    return {user,code,input:{codeId:code.id,userId:user.id,publicAccountId:user.id,venueId:"venue-a",venueName:"Pilot Hotel",suburb:"Fitzroy",redeemedByUserId:"staff",redeemedAt:now,metadata:{}}};
  }
  it("uses restricted runtime and denies direct anonymous/authenticated ledger access",async()=>{
    const role=await db.prepare("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user").get();
    expect(role).toEqual({rolsuper:false,rolbypassrls:false});
    await expect(db.exec("TRUNCATE pint_point_ledger")).rejects.toThrow();
    const rls=await target.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='pintpath_app.pint_point_ledger'::regclass");
    expect(rls.rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});
  });
  it("awards one point, consumes identity code and leaves contribution points separate",async()=>{
    const user=await customer();const input=await purchase(user);const record=await repo.createPintPointDrinkRecord(input);
    expect(record.pointsAwarded).toBe(1);
    expect((await repo.getPintPointBalance(user.id)).balance).toBe(1);
    expect((await repo.getDiscountPassById(input.metadata.memberPassId))?.status).toBe("revoked");
    expect((await db.prepare("SELECT count(*)::int AS count FROM contribution_ledger WHERE user_id=?").get(user.id))?.count).toBe(0);
    expect((await repo.listPintPointLedgerForUser(user.id,10))[0]?.metadata).toMatchObject({source:"venue_portal"});
  });
  it("identical HTTP retries and simultaneous identical purchases award once",async()=>{
    const user=await customer();const input=await purchase(user);
    const rows=await Promise.all(Array.from({length:8},()=>repo.createPintPointDrinkRecord({...input,id:crypto.randomUUID()})));
    expect(new Set(rows.map(row=>row.id)).size).toBe(1);
    expect((await repo.getPintPointBalance(user.id)).balance).toBe(1);
    expect(await repo.listPintPointLedgerForUser(user.id,10)).toHaveLength(1);
    await expect(repo.createPintPointDrinkRecord({...input,id:crypto.randomUUID(),itemName:"Changed"})).rejects.toThrow("different purchase");
  });
  it("same receipt for different customers returns a friendly conflict with one award",async()=>{
    const a=await customer();const b=await customer();const receipt=crypto.randomUUID();
    const results=await Promise.allSettled([repo.createPintPointDrinkRecord(await purchase(a,{idempotencyKey:receipt})),repo.createPintPointDrinkRecord(await purchase(b,{idempotencyKey:receipt}))]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const rejected=results.find(result=>result.status==="rejected");
    expect(rejected?.status==="rejected" && rejected.reason.message).toContain("different purchase");
    expect((await repo.getPintPointBalance(a.id)).balance+(await repo.getPintPointBalance(b.id)).balance).toBe(1);
  });
  it("rejects invalid, expired, revoked-session and reused codes",async()=>{
    const user=await customer();const input=await purchase(user);
    await expect(repo.createPintPointDrinkRecord({...input,quantity:-1})).rejects.toThrow("valid purchased drink");
    await expect(repo.createPintPointDrinkRecord({...input,recordedAt:"2026-09-10T01:06:00.000Z"})).rejects.toThrow("expired");
    await db.prepare("UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?").run(now,user.session);
    await expect(repo.createPintPointDrinkRecord(input)).rejects.toThrow("expired");
    const second=await customer();const input2=await purchase(second);await repo.createPintPointDrinkRecord(input2);
    await expect(repo.createPintPointDrinkRecord({...input2,id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()})).rejects.toThrow("already used");
  });
  it("does not award for nonalcoholic drinks or trust a requested points value",async()=>{
    const user=await customer();
    const a=await repo.createPintPointDrinkRecord(await purchase(user,{beverageCategory:"non_alcoholic",isAlcoholic:false,pointsAwarded:100}));
    expect(a.pointsAwarded).toBe(0);
    const b=await repo.createPintPointDrinkRecord(await purchase(user,{pointsAwarded:100}));
    expect(b.pointsAwarded).toBe(1);
  });
  it("keeps staff and venues isolated and rechecks revoked access at mutation time",async()=>{
    const user=await customer();const input=await purchase(user);
    await expect(repo.createPintPointDrinkRecord({...input,recordedByUserId:"other"})).rejects.toThrow("not authorised");
    await expect(repo.prepareDemoBalance({userId:user.id,venueId:"venue-a",actorUserId:"staff",target:50,now})).rejects.toThrow("not authorised");
    await db.prepare("UPDATE venue_manager_assignments SET status='revoked' WHERE id='staff-a'").run();
    await expect(repo.createPintPointDrinkRecord(input)).rejects.toThrow("not authorised");
    await db.prepare("UPDATE venue_manager_assignments SET status='active' WHERE id='staff-a'").run();
  });
  it("reserves 50 once, redeems exactly 50 and adds no award; retries fail",async()=>{
    const user=await customer();
    await expect(repo.createFreePintRewardCode({id:crypto.randomUUID(),userId:user.id,publicAccountId:user.id,codeHash:crypto.randomUUID(),createdAt:now,expiresAt:expiry,metadata:{}})).rejects.toThrow("INSUFFICIENT");
    const reward=await readyReward();
    expect((await repo.getPintPointBalance(reward.user.id)).available).toBe(0);
    expect(await repo.redeemFreePintRewardCode(reward.input)).not.toBeNull();
    expect(await repo.redeemFreePintRewardCode(reward.input)).toBeNull();
    expect(await repo.getPintPointBalance(reward.user.id)).toMatchObject({balance:0,reserved:0,lifetimeRedeemed:50});
    expect(await repo.listPintPointDrinkRecordsForUser(reward.user.id,20)).toHaveLength(0);
    expect(await repo.listFreePintRewardRedemptionsForUser(reward.user.id,20)).toHaveLength(1);
  });
  it("two staff devices and eight concurrent reward requests have exactly one success",async()=>{
    const reward=await readyReward();
    const results=await Promise.all(Array.from({length:8},(_,i)=>repo.redeemFreePintRewardCode({...reward.input,redeemedByUserId:i%2?"manager":"staff"})));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo.getPintPointBalance(reward.user.id)).balance).toBe(0);
    expect((await repo.listPintPointLedgerForUser(reward.user.id,20)).filter(row=>row.type==="reward_redeemed")).toHaveLength(1);
  });
  it("wrong customer, wrong venue, expired reward and insufficient reserved balance fail",async()=>{
    const reward=await readyReward();
    expect(await repo.redeemFreePintRewardCode({...reward.input,userId:"other"})).toBeNull();
    await expect(repo.redeemFreePintRewardCode({...reward.input,venueId:"venue-b",redeemedByUserId:"other"})).rejects.toThrow("another venue");
    expect(await repo.redeemFreePintRewardCode({...reward.input,redeemedAt:"2026-09-10T01:06:00.000Z"})).toBeNull();
    await repo.prepareDemoBalance({userId:reward.user.id,venueId:"venue-a",actorUserId:"manager",target:49,now});
    expect(await repo.redeemFreePintRewardCode(reward.input)).toBeNull();
  });
  it("parallel reward generation cannot over-reserve the same 50 points",async()=>{
    const user=await customer();await repo.prepareDemoBalance({userId:user.id,venueId:"venue-a",actorUserId:"manager",target:50,now});
    const results=await Promise.allSettled(Array.from({length:8},()=>repo.createFreePintRewardCode({id:crypto.randomUUID(),userId:user.id,publicAccountId:user.id,codeHash:crypto.randomUUID(),createdAt:now,expiresAt:expiry,metadata:{}})));
    expect(results.filter(row=>row.status==="fulfilled")).toHaveLength(1);
    expect(await repo.getPintPointBalance(user.id)).toMatchObject({balance:50,reserved:50,available:0});
  });
  it("reverses append-only, releases affected reserved rewards and never repeats reversal",async()=>{
    const user=await customer();await repo.prepareDemoBalance({userId:user.id,venueId:"venue-a",actorUserId:"manager",target:49,now});
    const purchaseRecord=await repo.createPintPointDrinkRecord(await purchase(user));
    await repo.createFreePintRewardCode({id:crypto.randomUUID(),userId:user.id,publicAccountId:user.id,codeHash:crypto.randomUUID(),createdAt:now,expiresAt:expiry,metadata:{}});
    const results=await Promise.all(Array.from({length:5},()=>repo.voidPintPointDrinkRecord({recordId:purchaseRecord.id,venueId:"venue-a",actorUserId:"manager",reason:"Wrong purchase",voidedAt:now})));
    expect(results.filter(row=>!row?.idempotentReplay)).toHaveLength(1);
    expect(await repo.getPintPointBalance(user.id)).toMatchObject({balance:49,reserved:0});
    const ledger=await repo.listPintPointLedgerForUser(user.id,20);
    expect(ledger.filter(row=>row.type==="drink_scan")).toHaveLength(1);
    expect(ledger.filter(row=>row.type==="drink_void")).toHaveLength(1);
    expect((await repo.getPintPointDrinkRecordById(purchaseRecord.id))?.voidReason).toBe("Wrong purchase");
    expect((await repo.listVenueLedgerHistory("venue-a",100)).length).toBeGreaterThan(0);
    const activity = (await repo.listPintPointDrinkRecordsForVenue("venue-a",100)).find(row => row.id === purchaseRecord.id);
    expect(activity).toMatchObject({ operatorPublicAccountId: "PP-STAFF", voidedByPublicAccountId: "PP-MANAGER" });
  });
  it("executes the HTTP purchase-to-reward loop for an ordinary free pilot customer with commercial flags off", async () => {
    const user = await customer();
    const { CURRENT_LEGAL_POLICY_VERSION } = await import("../src/config/legal.js");
    const timestamp = new Date().toISOString();
    await db.prepare("UPDATE accounts SET age_confirmed_at=@now,terms_accepted_at=@now,privacy_accepted_at=@now,terms_version=@version,privacy_version=@version,email_verified_at=@now WHERE id IN ('manager','staff',@customer)").run({now:timestamp,version:CURRENT_LEGAL_POLICY_VERSION,customer:user.id});
    await db.prepare("INSERT INTO venue_profiles(venue_id,name,active,created_at,updated_at) VALUES('venue-a','Pilot Hotel',true,?,?)").run(timestamp,timestamp);
    const customerToken = `customer-${crypto.randomUUID()}`;
    const managerToken = `manager-${crypto.randomUUID()}`;
    const staffToken = `staff-${crypto.randomUUID()}`;
    for (const [rawToken, id] of [[customerToken,user.id],[managerToken,"manager"],[staffToken,"staff"]]) {
      await db.prepare("INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)").run(token(rawToken!),id,timestamp,new Date(Date.now()+3600000).toISOString());
    }
    const [{ env },{createPilotTestService},{createBusinessRouter},{errorHandler},{default:express}] = await Promise.all([
      import("../src/config/env.js"),import("./helpers/pilot-postgres-runtime.js"),import("../src/modules/business/business.routes.js"),import("../src/middleware/error-handler.js"),import("express")]);
    const service = createPilotTestService(db,{...env,NODE_ENV:"test",PUBLIC_BASE_URL:"http://127.0.0.1",SUPABASE_URL:undefined,SUPABASE_ANON_KEY:undefined,SUPABASE_SERVICE_ROLE_KEY:undefined,
      BAR_PILOT_ENABLED:true,BAR_PILOT_VENUE_IDS:"venue-a",BAR_PILOT_DEMO_ENABLED:true,BAR_PILOT_DEMO_CUSTOMER_IDS:user.id,
      COMMERCIAL_LAUNCH_ENABLED:false,CONSUMER_PAID_ENROLLMENT_ENABLED:false,PINT_POINTS_REWARDS_ENABLED:false,ALCOHOL_GAMIFICATION_ENABLED:false,DEMO_BILLING_MODE:false});
    const app = express();app.use(express.json());app.use("/api/business",createBusinessRouter(service));app.use(errorHandler);
    const server = app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    const address=server.address();if (!address || typeof address==="string") throw new Error("HTTP fixture failed");
    const base=`http://127.0.0.1:${address.port}/api/business`;
    async function request(path:string,rawToken:string,body?:unknown) {
      const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${rawToken}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const json=await response.json();return {status:response.status,...json};
    }
    try {
      const config=await request("/config",customerToken);expect(config.data).toMatchObject({commercialLaunchEnabled:false,barPilotEnabled:true,pintPointsRewardsEnabled:true,alcoholGamificationEnabled:false});
      const pass=await request("/account/pint-point-pass",customerToken,{});expect(pass.status).toBe(200);
      const preview=await request("/venue-portal/venue-a/member-preview",staffToken,{code:pass.data.code,transactionReference:"pilot-http-receipt"});expect(preview.status).toBe(200);
      expect(preview.data.wallet.rewardAvailable).toBe(false);
      expect((await request("/venue-portal/venue-b/member-preview",staffToken,{code:pass.data.code,transactionReference:"pilot-http-other"})).status).toBe(403);
      await repo.createPintPointLedgerEntry({id:crypto.randomUUID(),userId:user.id,venueId:"venue-b",drinkRecordId:null,rewardCodeId:null,type:"admin_adjustment",pointsDelta:0,pointsReservedDelta:0,description:"PRIVATE OTHER VENUE ACTIVITY",createdAt:timestamp,metadata:{otherVenueSecret:"other-venue-private-reference"}});
      const body={checkoutToken:preview.data.checkoutToken,transactionReference:"pilot-http-receipt",itemName:"Guinness",beverageCategory:"alcoholic",quantity:1,pointsAwarded:500,balance:500};
      const award=await request("/venue-portal/venue-a/pint-point-drinks",staffToken,body);expect(award.status).toBe(201);expect(award.data.pointsEarned).toBe(1);expect(award.data.wallet.balance).toBe(1);expect(award.data.wallet).not.toHaveProperty("recentLedger");expect(JSON.stringify(award.data)).not.toContain("other-venue-private-reference");
      const retry=await request("/venue-portal/venue-a/pint-point-drinks",staffToken,body);expect(retry.status).toBe(200);expect(retry.data).toMatchObject({pointsEarned:0,idempotentReplay:true,wallet:{balance:1}});
      expect((await request("/venue-portal/venue-a/pilot-demo-threshold",staffToken,{customerAccountId:user.id,target:50})).status).toBe(403);
      expect((await request("/venue-portal/venue-a/pilot-demo-threshold",customerToken,{customerAccountId:user.id,target:50})).status).toBe(403);
      const prepared=await request("/venue-portal/venue-a/pilot-demo-threshold",managerToken,{customerAccountId:user.id,target:50});expect(prepared.status).toBe(200);expect(prepared.data.wallet.rewardAvailable).toBe(true);
      const reward=await request("/account/free-pint-reward-code",customerToken,{venueId:"venue-a"});expect(reward.status).toBe(200);
      const redeemed=await request("/venue-portal/venue-a/free-pint-rewards",staffToken,{code:reward.data.code,action:"confirm"});expect(redeemed.status).toBe(201);expect(redeemed.data).toMatchObject({title:"FREE PINT REDEEMED",wallet:{balance:0,lifetimeRedeemed:50}});expect(redeemed.data.wallet).not.toHaveProperty("rewardRedemptions");
      expect((await request("/venue-portal/venue-a/free-pint-rewards",staffToken,{code:reward.data.code,action:"confirm"})).status).toBe(409);
      const history=await request("/venue-portal/venue-a/reconciliation",managerToken);expect(history.status).toBe(200);expect(history.data.freePintRedemptions.items.some((item:{userId:string})=>item.userId===user.id)).toBe(true);
      const purchaseActivity = history.data.pintPointActivity.items.find((item: { id: string }) => item.id === award.data.record.id);
      expect(purchaseActivity).toMatchObject({operatorPublicAccountId:"PP-STAFF",voidedByPublicAccountId:null});
      expect(purchaseActivity).not.toHaveProperty("recordedByUserId");
      expect(purchaseActivity).not.toHaveProperty("voidedByUserId");
      expect(JSON.stringify(purchaseActivity)).not.toContain("staff@example.test");
      const correctedActivity = history.data.pintPointActivity.items.find((item: { status: string }) => item.status === "void");
      expect(correctedActivity).toMatchObject({operatorPublicAccountId:"PP-STAFF",voidedByPublicAccountId:"PP-MANAGER"});
      expect(correctedActivity).not.toHaveProperty("voidedByUserId");
      expect((await request("/venue-portal/venue-a/reconciliation",staffToken)).status).toBe(403);
      expect((await request("/account/discount-pass",customerToken,{})).status).toBe(404);
      expect((await request("/account/free-pint-reward-code",customerToken,{})).status).toBe(403);
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });

});
