import { NextResponse } from "next/server";
import { readAttachment } from "@/lib/uploads";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const { row, data } = await readAttachment(id);
    const bytes = new Uint8Array(data);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": row.mime,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      },
    });
  } catch (error) {
    const status = (error as Error).message === "attachment not found" ? 404 : 500;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }
}
