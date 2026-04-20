import type { Request, Response } from "express";

export function captureRawBody(req: Request, _res: Response, buffer: Buffer, encoding: BufferEncoding): void {
  if (buffer.length === 0) {
    return;
  }

  req.rawBody = buffer.toString(encoding || "utf8");
}
