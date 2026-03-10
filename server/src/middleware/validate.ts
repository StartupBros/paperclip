import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";
import { HttpError } from "../errors.js";

export function validate(schema: ZodSchema, options?: { status?: number }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(options?.status ?? 400, "Validation error", parsed.error.errors));
      return;
    }
    req.body = parsed.data;
    next();
  };
}
