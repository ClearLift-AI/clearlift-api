import { Hono } from "hono";
import { fromHono } from "chanfana";
import { ListPlatforms } from "./list";
import { SyncPlatform } from "./sync";
import { GetSyncHistory } from "./syncHistory";

export const platformsRouter = fromHono(new Hono());

platformsRouter.get("/list", ListPlatforms);
platformsRouter.post("/sync", SyncPlatform);
platformsRouter.get("/sync/history", GetSyncHistory);