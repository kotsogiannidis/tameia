import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const LOOKBACK_DAYS = 3;

const BRAND_TO_PRODUCT: Record<string, string> = {
  "Frog Mobile": "Frog",
  "What's Up": "WU",
  "Cosmo Card": "Cosmokarta",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

type MapRow = {
  variation_id: number;
  parent_id: number | null;
  brand: string;
  package_eur: number;
  sim_type: string;
};

async function isAuthorized(req: Request, sb: ReturnType<typeof createClient>) {
  const cronHdr = req.headers.get("x-cron-secret");
  if (cronHdr) {
    const { data } = await sb.from("app_settings").select("value").eq("key", "woo_cron_secret")
      .maybeSingle();
    if (data?.value && cronHdr === data.value) return true;
  }

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;

  const token = auth.slice(7);
  if (token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return true;

  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon) {
    const userSb = createClient(Deno.env.get("SUPABASE_URL")!, anon, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await userSb.auth.getUser();
    if (user) return true;
  }

  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (!(await isAuthorized(req, sb))) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let ordersSynced = 0;
  let catalogSynced = 0;
  let stockApplied = 0;
  let stockRestored = 0;
  const affected = new Set<string>();
  const unmapped = new Set<string>();

  try {
    const { data: cfg } = await sb.from("app_settings").select("key,value")
      .in("key", ["woo_url", "woo_key", "woo_secret"]);
    const map = Object.fromEntries((cfg ?? []).map((r) => [r.key, r.value]));
    let wooUrl = String(map.woo_url || "").trim();
    let wooKey = String(map.woo_key || "").trim();
    let wooSecret = String(map.woo_secret || "").trim();
    if (!wooUrl || !wooKey || !wooSecret) {
      wooUrl = wooUrl || Deno.env.get("WOO_URL")?.trim() || "";
      wooKey = wooKey || Deno.env.get("WOO_KEY")?.trim() || "";
      wooSecret = wooSecret || Deno.env.get("WOO_SECRET")?.trim() || "";
    }
    if (!wooUrl || !wooKey || !wooSecret) {
      throw new Error("Ρύθμισε WooCommerce API στο Settings → 🔌 API (URL + Consumer Key + Secret)");
    }

    const { data: maps, error: mapErr } = await sb
      .from("woo_product_map")
      .select("variation_id,parent_id,brand,package_eur,sim_type");
    if (mapErr) throw mapErr;

    const byVar = new Map<string, MapRow>();
    const byParent = new Map<string, MapRow>();
    for (const m of (maps ?? []) as MapRow[]) {
      byVar.set(String(m.variation_id), m);
      if (m.parent_id) byParent.set(String(m.parent_id), m);
    }

    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const auth = "Basic " + btoa(`${wooKey}:${wooSecret}`);
    const base = wooUrl.replace(/\/$/, "");

    let page = 1;
    let totalPages = 1;

    do {
      const url = `${base}/wp-json/wc/v3/orders`
        + `?per_page=100&page=${page}`
        + `&modified_after=${encodeURIComponent(since)}`
        + `&orderby=modified&order=asc`;

      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`WooCommerce ${res.status}: ${(await res.text()).slice(0, 300)}`);
      totalPages = parseInt(res.headers.get("X-WP-TotalPages") ?? "1", 10);

      const orders = await res.json();
      const rows: Record<string, unknown>[] = [];

      for (const o of orders) {
        let qty15 = 0;
        let qty5 = 0;
        for (const li of o.line_items ?? []) {
          const vid = li.variation_id ? String(li.variation_id) : "";
          const pid = String(li.product_id ?? "");
          const m = (vid && byVar.get(vid)) || byParent.get(pid);
          if (!m) {
            unmapped.add(li.sku ? String(li.sku) : `product:${pid}${vid ? `/var:${vid}` : ""}`);
            continue;
          }
          const pkg = Number(m.package_eur);
          if (pkg === 15) qty15 += li.quantity ?? 0;
          else if (pkg === 5) qty5 += li.quantity ?? 0;
        }

        const pay = o.payment_method === "cod" ? "cash" : "card";
        const d = String(o.date_paid || o.date_created || "").slice(0, 10);
        if (!d) continue;
        affected.add(d);

        rows.push({
          woo_order_id: o.id,
          order_number: String(o.number ?? o.id),
          order_date: d,
          status: o.status,
          payment: pay,
          qty15,
          qty5,
          total: Number(o.total ?? 0),
          currency: o.currency ?? "EUR",
          raw: o,
          synced_at: new Date().toISOString(),
        });
      }

      if (rows.length) {
        const { error } = await sb.from("woo_orders").upsert(rows, { onConflict: "woo_order_id" });
        if (error) throw error;
        ordersSynced += rows.length;
      }
      page++;
    } while (page <= totalPages);

    const { data: stockResult, error: stockErr } = await sb.rpc("apply_woo_order_stock");
    if (stockErr) throw stockErr;
    stockApplied = Number(stockResult?.applied ?? 0);
    stockRestored = Number(stockResult?.restored ?? 0);

    for (const d of affected) {
      const { error } = await sb.rpc("refresh_online_sales", { p_date: d });
      if (error) throw error;
    }

    const parentIds = [...new Set((maps ?? []).map((m: MapRow) => m.parent_id).filter(Boolean))];
    const catalogRows: Record<string, unknown>[] = [];

    for (const parentId of parentIds) {
      const varUrl = `${base}/wp-json/wc/v3/products/${parentId}/variations?per_page=100`;
      const varRes = await fetch(varUrl, { headers: { Authorization: auth } });
      if (!varRes.ok) continue;

      const variations = await varRes.json();
      for (const v of variations) {
        const m = byVar.get(String(v.id));
        if (!m) continue;

        const storeProduct = BRAND_TO_PRODUCT[m.brand] ?? m.brand;
        catalogRows.push({
          variation_id: v.id,
          parent_id: parentId,
          brand: m.brand,
          product_name: v.name ?? m.brand,
          package_eur: m.package_eur,
          sim_type: m.sim_type,
          sku: v.sku ?? null,
          price: Number(v.regular_price || v.price || m.package_eur),
          stock_qty: v.manage_stock === false ? 999 : Math.max(0, Number(v.stock_quantity ?? 0)),
          woo_status: v.status === "publish" ? "publish" : (v.status ?? "draft"),
          image_url: v.image?.src ?? null,
          store_product: storeProduct,
          synced_at: new Date().toISOString(),
        });
      }
    }

    if (catalogRows.length) {
      const { error: catErr } = await sb.from("woo_catalog").upsert(catalogRows, {
        onConflict: "variation_id",
      });
      if (catErr) throw catErr;
      catalogSynced = catalogRows.length;
    }

    const { error: catalogStockErr } = await sb.rpc("apply_woo_catalog_stock");
    if (catalogStockErr) throw catalogStockErr;

    await sb.from("woo_sync_log").insert({
      ok: true,
      orders_synced: ordersSynced,
      catalog_synced: catalogSynced,
      stock_applied: stockApplied,
      unmapped_skus: [...unmapped],
      dates_affected: [...affected],
      meta: { stock_restored: stockRestored },
    });

    return json({
      ok: true,
      orders_synced: ordersSynced,
      catalog_synced: catalogSynced,
      stock_applied: stockApplied,
      stock_restored: stockRestored,
      dates: [...affected],
      unmapped_skus: [...unmapped],
    });
  } catch (e) {
    const err = String(e);
    await sb.from("woo_sync_log").insert({
      ok: false,
      error_message: err,
      orders_synced: ordersSynced,
      catalog_synced: catalogSynced,
      stock_applied: stockApplied,
      unmapped_skus: [...unmapped],
      dates_affected: [...affected],
      meta: { stock_restored: stockRestored },
    }).catch(() => {});
    await sb.from("alerts").insert({
      alert_type: "woo_sync_failed",
      severity: "critical",
      store: "Online",
      title: "Αποτυχία WooCommerce sync",
      body: err.slice(0, 500),
      meta: { orders_synced: ordersSynced, catalog_synced: catalogSynced, stock_applied: stockApplied },
    }).catch(() => {});
    return json({ ok: false, error: err }, 500);
  }
});

