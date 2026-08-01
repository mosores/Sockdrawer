import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export function authorize(request: Request): NextResponse | null {
  const expected = process.env.MEMORIA_ACCESS_KEY;
  if (!expected && process.env.NODE_ENV !== "production") return null;
  if (!expected) return NextResponse.json({ error: "MEMORIA_ACCESS_KEY is not configured." }, { status: 503 });
  const supplied = request.headers.get("x-memoria-key") ?? "";
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return NextResponse.json({ error: "Unauthorized device." }, { status: 401 });
  }
  return null;
}
