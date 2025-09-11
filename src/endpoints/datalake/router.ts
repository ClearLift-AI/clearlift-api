import { Hono } from "hono";
import { fromHono } from "chanfana";
import { CreateTable, ListTables, GetTableSchema, DropTable } from "./tables";
import { WriteData, BatchWriteData, QueryData } from "./data";
import { InitializeDatalake, GetStandardSchemas } from "./init";
import { SyncCampaignsToDatalake, SyncEventsToDatalake, GetSyncStatus } from "./sync";

export const datalakeRouter = fromHono(new Hono());

// Table management
datalakeRouter.post("/tables", CreateTable);
datalakeRouter.get("/tables", ListTables);
datalakeRouter.get("/tables/:table/schema", GetTableSchema);
datalakeRouter.delete("/tables/:table", DropTable);

// Data operations
datalakeRouter.post("/tables/:table/data", WriteData);
datalakeRouter.post("/tables/:table/batch", BatchWriteData);
datalakeRouter.post("/query", QueryData);

// Initialization
datalakeRouter.post("/init", InitializeDatalake);
datalakeRouter.get("/schemas", GetStandardSchemas);

// Data pipeline sync
datalakeRouter.post("/sync/campaigns", SyncCampaignsToDatalake);
datalakeRouter.post("/sync/events", SyncEventsToDatalake);
datalakeRouter.get("/sync/status", GetSyncStatus);