import { Hono } from "hono";
import { z } from "zod";
import { fromHono } from "chanfana";
import { ListOrganizations } from "./list";
import { CreateOrganization } from "./create";
import { SwitchOrganization } from "./switch";

export const organizationsRouter = fromHono(new Hono());

organizationsRouter.get("/", ListOrganizations);
organizationsRouter.post("/", CreateOrganization);
organizationsRouter.post("/switch", SwitchOrganization);