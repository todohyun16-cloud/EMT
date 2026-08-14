import type { IncomingMessage, ServerResponse } from "node:http";
import { parseOfficialHolidayApiXml } from "../src/lib/holidays.js";

const ENDPOINT = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

function queryValue(request: IncomingMessage, key: string) {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.searchParams.get(key) ?? "";
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const year = Number(queryValue(request, "year"));
  const month = Number(queryValue(request, "month"));
  if (!Number.isInteger(year) || year < 1900 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    send(response, 400, { error: "A valid year and month are required." });
    return;
  }

  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!serviceKey) {
    send(response, 503, { error: "The official holiday API service key is not configured." });
    return;
  }

  try {
    const params = new URLSearchParams({
      serviceKey,
      solYear: String(year),
      solMonth: String(month).padStart(2, "0"),
      numOfRows: "100",
      pageNo: "1",
    });
    const upstream = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
    const holidays = parseOfficialHolidayApiXml(await upstream.text(), year, month);
    response.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
    send(response, 200, { holidays });
  } catch (error) {
    send(response, 502, {
      error: `Official Korean holiday API request failed: ${error instanceof Error ? error.message : "unknown error"}.`,
    });
  }
}
