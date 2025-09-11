import { Hono } from "hono";
import { z } from "zod";
import { fromHono } from "chanfana";
import { GetUserProfile, UpdateUserProfile } from "./profile";

export const userRouter = fromHono(new Hono());

userRouter.get("/profile", GetUserProfile);
userRouter.put("/profile", UpdateUserProfile);