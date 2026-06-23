import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CASH_THRESHOLD = 500;
const DEPOSIT_DAYS = 3;
const ALERT_EMAIL = Deno.env.get("ALERT_EMAIL") ?? "kotsogiannidis@connectphone.gr";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function sendEmail(subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("ALERT_FROM") ?? "ConnectPhone <alerts@connectphone.eu>",
      to: [ALERT_EMAIL],
      subject,
      html,
    }),
  });
}

async function upsertAlert(
  sb: ReturnType<typeof createClient>,
  type: string,
  store: string | null,
  title: string,
  body: string,
  severity: string,
  meta: Record<string, unknown>,
) {
  const day = new Date().toISOString().slice(0, 10);
  const { data: existing } = await sb.from("alerts").select("id")
    .eq("alert_type", type)
    .eq("store", store ?? "")
    .gte("created_at", day)
    .is("dismissed_at", null)
    .maybeSingle();
  if (existing) return null;

  const { data, error } = await sb.from("alerts").insert({
    alert_type: type,
    severity,
    store,
    title,
    body,
    meta,
  }).select("id,title,body").single();
  if (error) throw error;
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const created: { title: string; body: string }[] = [];

  try {
    const { data: stockRows } = await sb.from("stock").select("store,product,empty,loaded_10gb,loaded_unlim,load_sim,empty_sim,empty_esim,load_esim");
    const { data: thresholds } = await sb.from("stock_thresholds").select("*");
    const thMap = new Map((thresholds ?? []).map((t) => [`${t.store}|${t.product}`, t.min_qty]));

    for (const r of stockRows ?? []) {
      let qty = 0;
      if (r.store === "Online" || r.store === "Κεντρική Αποθήκη") {
        qty = (r.load_sim ?? 0) + (r.load_esim ?? 0) + (r.empty_sim ?? 0) + (r.empty_esim ?? 0);
      } else if (r.product === "10GB") qty = r.loaded_10gb ?? 0;
      else if (r.product === "Unlimited WU") qty = r.loaded_unlim ?? 0;
      else if (r.product === "Unlimited Vodafone") qty = r.load_sim ?? 0;
      else if (r.product === "Άδεια") qty = r.empty ?? 0;
      else qty = (r.loaded_10gb ?? 0) + (r.loaded_unlim ?? 0);

      const min = thMap.get(`${r.store}|${r.product}`) ?? 5;
      if (qty < min) {
        const title = `Χαμηλό απόθεμα: ${r.product}`;
        const body = `${r.store}: ${qty} τεμάχια (όριο ${min})`;
        const a = await upsertAlert(sb, "low_stock", r.store, title, body, "warning", { qty, min, product: r.product });
        if (a) created.push(a);
      }
    }

    const physical = ["Μύκονος", "Σαντορίνη", "Ρόδος"];
    for (const store of physical) {
      const { data: cashVal } = await sb.rpc("store_cash_available", { p_store: store });
      const cash = Number(cashVal ?? 0);
      if (cash <= CASH_THRESHOLD) continue;

      const { data: daysVal } = await sb.rpc("days_since_last_deposit", { p_store: store });
      const days = Number(daysVal ?? 999);
      if (days < DEPOSIT_DAYS) continue;

      const title = `Μετρητά χωρίς κατάθεση — ${store}`;
      const body = `Διαθέσιμα ${cash.toFixed(2)}€, τελευταία κατάθεση πριν ${days} ημέρες`;
      const a = await upsertAlert(sb, "cash_no_deposit", store, title, body, "warning", { cash, days });
      if (a) created.push(a);
    }

    const since = new Date(Date.now() - 86400000).toISOString();
    const { data: failLog } = await sb.from("woo_sync_log")
      .select("*").eq("ok", false).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (failLog) {
      const title = "Online sync απέτυχε";
      const body = failLog.error_message ?? "Άγνωστο σφάλμα";
      const a = await upsertAlert(sb, "woo_sync_failed", "Online", title, body, "critical", { log_id: failLog.id });
      if (a) created.push(a);
    }

    if (created.length) {
      const html = created.map((a) => `<p><b>${a.title}</b><br>${a.body}</p>`).join("");
      await sendEmail(`ConnectPhone — ${created.length} νέα alerts`, html);
    }

    return json({ ok: true, alerts_created: created.length, alerts: created });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

