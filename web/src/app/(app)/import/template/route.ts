import { NextResponse } from "next/server";
import { generateTemplateWorkbook } from "@/lib/setup-import";

export async function GET() {
  const buffer = await generateTemplateWorkbook();
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="aps-setup-template.xlsx"',
    },
  });
}
