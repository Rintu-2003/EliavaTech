import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { getEmailConfigStatus } from "@/lib/email";

export const dynamic = "force-dynamic";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Launch/diagnostics check. Reports WHICH settings are present, never their values.
 *
 * Disabled (404) unless HEALTH_CHECK_TOKEN is set. Call it with the header
 *   Authorization: Bearer <HEALTH_CHECK_TOKEN>
 * It does not send emails or create leads.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.HEALTH_CHECK_TOKEN?.trim();
  if (!expected) return new NextResponse(null, { status: 404 });

  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tokenMatches(provided, expected)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let database: { configured: boolean; reachable: boolean; error?: string } = {
    configured: Boolean(process.env.DATABASE_URL),
    reachable: false,
  };
  if (prisma) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = { configured: true, reachable: true };
    } catch (err) {
      database = {
        configured: true,
        reachable: false,
        error: err instanceof Error ? err.message.split("\n").pop()?.slice(0, 160) : "Unknown error",
      };
    }
  }

  const email = getEmailConfigStatus();
  const turnstile = {
    secretKeySet: Boolean(process.env.TURNSTILE_SECRET_KEY?.trim()),
    // NEXT_PUBLIC_* values are baked in at build time: redeploy after changing them.
    siteKeySet: Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim()),
  };
  const redisConfigured = Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );

  const problems: string[] = [];
  if (!turnstile.secretKeySet) problems.push("TURNSTILE_SECRET_KEY is missing: contact and pricing forms are refused");
  if (!turnstile.siteKeySet) problems.push("NEXT_PUBLIC_TURNSTILE_SITE_KEY is missing: the spam-check widget will not appear");
  if (!email.ready) problems.push(...email.problems);
  if (!database.configured) problems.push("DATABASE_URL is not set: leads are not stored (email only)");
  else if (!database.reachable) problems.push("Database is configured but not reachable");
  if (!redisConfigured) problems.push("Redis is not configured: rate limits are per server instance");
  if (!process.env.GEMINI_API_KEY?.trim()) problems.push("GEMINI_API_KEY is missing: the chat assistant will not reply");

  // Forms can deliver an enquiry only if at least one channel works.
  const canDeliverEnquiries =
    (email.ready || database.reachable || Boolean(process.env.N8N_WEBHOOK_URL?.trim())) &&
    (process.env.NODE_ENV !== "production" || turnstile.secretKeySet);

  return NextResponse.json({
    ok: problems.length === 0,
    canDeliverEnquiries,
    nodeEnv: process.env.NODE_ENV,
    turnstile,
    email: { provider: email.provider, ready: email.ready },
    database,
    redisConfigured,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    problems,
  });
}
