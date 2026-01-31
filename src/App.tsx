import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { supabase } from "./lib/supabase";

type Bar = { id: string; name: string; sort_order: number };
type Product = {
  id: string;
  bar_id: string;
  name: string;
  price_gross: number;
  sort_order: number;
  is_active: boolean;
};

type CartLine = { product: Product; qty: number };

type StaffAuth = {
  id: string;
  name: string;
  role: "staff" | "admin";
};

type ReceiptResponse = {
  order_id: string;
  receipt_no: string;
  short_no: number;
  public_token: string;
  receipt_url: string;
  gross: number;
  tax: number;
  net: number;
};

type ReceiptOrderRow = {
  id: string;
  receipt_no: string;
  created_at: string;
  payment_method: "cash" | "sumup";
  gross_total: number;
  tax_total: number;
  net_total: number;
  status: "completed" | "voided";
};

type ReceiptItemRow = {
  order_id: string;
  name_snapshot: string;
  qty: number;
  line_total_gross: number;
};

const EVENT_ID = "00000000-0000-0000-0000-000000000001";
const STORAGE_KEY_BAR = "festkassa:selectedBarId";
const STORAGE_KEY_DEVICE = "festkassa:deviceId";
const STORAGE_KEY_STAFF = "festkassa:staffSession"; // JSON

function euro(n: number) {
  return new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(n);
}
function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function randomToken(len = 40) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
  return out;
}
function getDeviceId() {
  const existing = localStorage.getItem(STORAGE_KEY_DEVICE);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY_DEVICE, id);
  return id;
}

function isReceiptRoute() {
  return window.location.pathname.startsWith("/r/");
}
function getReceiptTokenFromPath() {
  if (!window.location.pathname.startsWith("/r/")) return null;
  const t = window.location.pathname.replace("/r/", "").trim();
  return t.length ? t : null;
}

/**
 * ✅ PIN-Check via RPC (Hash in DB)
 */
async function checkPin(pin: string): Promise<StaffAuth | null> {
  const clean = pin.trim();
  if (!clean) return null;

  const { data, error } = await supabase.rpc("check_staff_pin", { pin_input: clean });
  if (error) return null;

  const row = (data as any[])?.[0];
  if (!row) return null;

  const role = row.role as "staff" | "admin";
  if (role !== "staff" && role !== "admin") return null;

  return { id: row.id, name: row.name, role };
}

function loadStaffSession(): StaffAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STAFF);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.id || !parsed?.name || !parsed?.role) return null;
    if (parsed.role !== "staff" && parsed.role !== "admin") return null;
    return parsed as StaffAuth;
  } catch {
    return null;
  }
}
function saveStaffSession(s: StaffAuth) {
  localStorage.setItem(STORAGE_KEY_STAFF, JSON.stringify(s));
}
function clearStaffSession() {
  localStorage.removeItem(STORAGE_KEY_STAFF);
}

export default function App() {
  if (isReceiptRoute()) return <ReceiptPage />;
  return <KassaPage />;
}

function KassaPage() {
  const [bars, setBars] = useState<Bar[]>([]);
  const [selectedBarId, setSelectedBarId] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY_BAR));
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "sumup">("cash");

  const [error, setError] = useState<string | null>(null);
  const [loadingBars, setLoadingBars] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);

  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<ReceiptResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Mitarbeiter-Storno (letzter Bon, ohne Grund, PIN staff/admin)
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidPin, setVoidPin] = useState("");
  const [voidLoading, setVoidLoading] = useState(false);
  const [voidMsg, setVoidMsg] = useState<string | null>(null);

  // ✅ Login
  const [staff, setStaff] = useState<StaffAuth | null>(() => loadStaffSession());
  const [loginPin, setLoginPin] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginMsg, setLoginMsg] = useState<string | null>(null);

  // Admin
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminUser, setAdminUser] = useState<StaffAuth | null>(null);
  const [adminPinInput, setAdminPinInput] = useState("");
  const [adminTab, setAdminTab] = useState<"void" | "reprint" | "report">("void");
  const [adminMsg, setAdminMsg] = useState<string | null>(null);

  const [voidReceiptNo, setVoidReceiptNo] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [reprintReceiptNo, setReprintReceiptNo] = useState("");

  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportTotals, setReportTotals] = useState<{ brutto: number; ust: number; netto: number; bons: number } | null>(null);
  const [reportByBar, setReportByBar] = useState<Array<{ bar: string; brutto: number; bons: number }>>([]);
  const [reportByProduct, setReportByProduct] = useState<Array<{ produkt: string; menge: number; brutto: number }>>([]);

  const selectedBar = useMemo(() => bars.find((b) => b.id === selectedBarId) ?? null, [bars, selectedBarId]);
  const cartLines = useMemo(() => Object.values(cart), [cart]);

  const grossTotal = useMemo(() => round2(cartLines.reduce((s, l) => s + Number(l.product.price_gross) * l.qty, 0)), [cartLines]);
  const taxTotal = useMemo(() => round2(grossTotal * (20 / 120)), [grossTotal]); // 20% aus Bruttopreis
  const netTotal = useMemo(() => round2(grossTotal - taxTotal), [grossTotal, taxTotal]);

  // Bars laden
  useEffect(() => {
    (async () => {
      setLoadingBars(true);
      setError(null);

      const { data, error } = await supabase.from("bars").select("id,name,sort_order").order("sort_order", { ascending: true });
      if (error) setError(error.message);
      else setBars((data ?? []) as any);

      setLoadingBars(false);
    })();
  }, []);

  // Produkte je Bar laden
  useEffect(() => {
    if (!selectedBarId) {
      setProducts([]);
      return;
    }

    (async () => {
      setLoadingProducts(true);
      setError(null);

      const { data, error } = await supabase
        .from("products")
        .select("id,bar_id,name,price_gross,sort_order,is_active")
        .eq("bar_id", selectedBarId)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });

      if (error) setError(error.message);
      else setProducts((data ?? []) as any);

      setLoadingProducts(false);
    })();
  }, [selectedBarId]);

  function chooseBar(id: string) {
    localStorage.setItem(STORAGE_KEY_BAR, id);
    setSelectedBarId(id);
    setCart({});
    setPaymentMethod("cash");
    setLastReceipt(null);
    setQrDataUrl(null);
    setError(null);
  }

  function resetBar() {
    localStorage.removeItem(STORAGE_KEY_BAR);
    setSelectedBarId(null);
    setProducts([]);
    setCart({});
    setPaymentMethod("cash");
    setLastReceipt(null);
    setQrDataUrl(null);
    setError(null);
  }

  function addToCart(p: Product) {
    setCart((prev) => {
      const ex = prev[p.id];
      const nextQty = (ex?.qty ?? 0) + 1;
      return { ...prev, [p.id]: { product: p, qty: nextQty } };
    });
  }
  function inc(id: string) {
    setCart((prev) => {
      const line = prev[id];
      if (!line) return prev;
      return { ...prev, [id]: { ...line, qty: line.qty + 1 } };
    });
  }
  function dec(id: string) {
    setCart((prev) => {
      const line = prev[id];
      if (!line) return prev;
      const next = line.qty - 1;
      if (next <= 0) {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      }
      return { ...prev, [id]: { ...line, qty: next } };
    });
  }
  function clearCart() {
    setCart({});
  }

  function buildReceiptText(args: {
    barName: string;
    receiptNo: string;
    createdAtISO: string;
    payment: "cash" | "sumup";
    lines: Array<{ qty: number; name: string; lineTotal: number }>;
    gross: number;
    tax: number;
    net: number;
  }) {
    const head =
      `*** ${args.barName.toUpperCase()} ***\n` +
      `Bon-Nr: ${args.receiptNo}\n` +
      `${new Date(args.createdAtISO).toLocaleString("de-AT")}\n` +
      `Kassier: ${staff ? `${staff.name} (${staff.role})` : "—"}\n` +
      `Zahlung: ${args.payment === "sumup" ? "Karte (SumUp)" : "Bar"}\n` +
      `-----------------------------\n`;

    const body = args.lines.map((l) => `${l.qty}x ${l.name}  ${euro(l.lineTotal)}\n`).join("");

    const foot =
      `-----------------------------\n` +
      `BRUTTO  ${euro(args.gross)}\n` +
      `USt 20% ${euro(args.tax)}\n` +
      `NETTO   ${euro(args.net)}\n`;

    return head + body + foot;
  }

  async function doCheckout(printRequested: boolean) {
    try {
      setError(null);

      if (!staff) return void setError("Bitte zuerst einloggen.");
      if (!selectedBarId || !selectedBar) return void setError("Bitte zuerst die Bar auswählen.");
      if (cartLines.length === 0) return void setError("Warenkorb ist leer.");

      setCheckoutLoading(true);

      const deviceId = getDeviceId();

      
      const { data: seqRows, error: seqErr } = await supabase.rpc("next_receipt", { p_event_id: EVENT_ID });
if (seqErr) throw new Error(seqErr.message);

const row = Array.isArray(seqRows) ? seqRows[0] : seqRows;
if (!row?.receipt_no || !row?.short_no) {
  throw new Error("next_receipt() hat keine Bon-Nummer geliefert. Prüfe event_counters / RPC.");
}

const receiptNo = row.receipt_no as string;
const shortNo = row.short_no as number;


      const publicToken = randomToken(40);
      const createdAtISO = new Date().toISOString();

      const { data: order, error: oErr } = await supabase
        .from("orders")
        .insert({
          event_id: EVENT_ID,
          bar_id: selectedBarId,
          device_id: deviceId,
          cashier_user_id: null, // legacy, wenn vorhanden
          cashier_staff_id: staff.id,
          cashier_name_snapshot: staff.name,
          cashier_role_snapshot: staff.role,
          receipt_no: receiptNo,
          short_no: shortNo,
          public_token: publicToken,
          payment_method: paymentMethod,
          status: "completed",
          gross_total: grossTotal,
          tax_rate: 0.2,
          tax_total: taxTotal,
          net_total: netTotal,
          receipt_offered: true,
          receipt_printed: printRequested ? true : false,
          created_at: createdAtISO,
        })
        .select("id")
        .single();

      if (oErr) throw new Error(oErr.message);

      const itemsRows = cartLines.map((l) => ({
        order_id: (order as any).id,
        product_id: l.product.id,
        name_snapshot: l.product.name,
        unit_price_gross: l.product.price_gross,
        qty: l.qty,
        line_total_gross: round2(Number(l.product.price_gross) * l.qty),
      }));

      const { error: iErr } = await supabase.from("order_items").insert(itemsRows);
      if (iErr) throw new Error(iErr.message);

      if (printRequested) {
        const payload = buildReceiptText({
          barName: selectedBar.name,
          receiptNo,
          createdAtISO,
          payment: paymentMethod,
          lines: cartLines.map((l) => ({
            qty: l.qty,
            name: l.product.name,
            lineTotal: round2(Number(l.product.price_gross) * l.qty),
          })),
          gross: grossTotal,
          tax: taxTotal,
          net: netTotal,
        });

        const { error: pErr } = await supabase.from("print_jobs").insert({
          event_id: EVENT_ID,
          order_id: (order as any).id,
          payload,
          status: "queued",
        });
        if (pErr) throw new Error(pErr.message);
      }

      const receiptUrl = `/r/${publicToken}`;
      const absUrl = `${window.location.origin}${receiptUrl}`;
      const qr = await QRCode.toDataURL(absUrl, { margin: 1, scale: 6 });

      setLastReceipt({
        order_id: (order as any).id,
        receipt_no: receiptNo,
        short_no: shortNo,
        public_token: publicToken,
        receipt_url: receiptUrl,
        gross: grossTotal,
        tax: taxTotal,
        net: netTotal,
      });
      setQrDataUrl(qr);

      clearCart();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setCheckoutLoading(false);
    }
  }

  // Mitarbeiter-Storno: staff oder admin PIN, ohne Grund, nur letzter Bon
  async function voidLastReceiptNoReason() {
    try {
      setVoidMsg(null);
      if (!lastReceipt) return void setVoidMsg("Kein letzter Bon vorhanden.");

      setVoidLoading(true);

      const auth = await checkPin(voidPin);
      if (!auth) return void setVoidMsg("Falscher PIN.");

      const nowIso = new Date().toISOString();

      const { error: uErr } = await supabase.from("orders").update({ status: "voided", voided_at: nowIso }).eq("id", lastReceipt.order_id);
      if (uErr) throw new Error(uErr.message);

      const { error: vErr } = await supabase.from("voids").insert({
        order_id: lastReceipt.order_id,
        voided_by: `${auth.role}:${auth.name}`,
        reason: "",
      });
      if (vErr) throw new Error(vErr.message);

      setVoidMsg(`Storno ok: ${lastReceipt.receipt_no}`);
      setVoidPin("");
    } catch (e: any) {
      setVoidMsg(`Fehler: ${e?.message ?? String(e)}`);
    } finally {
      setVoidLoading(false);
    }
  }

  function openAdmin() {
    setAdminMsg(null);
    setAdminTab("void");
    setAdminOpen(true);
  }
  function closeAdmin() {
    setAdminMsg(null);
    setAdminPinInput("");
    setAdminOpen(false);
  }

  async function unlockAdmin() {
    setAdminMsg(null);
    const auth = await checkPin(adminPinInput);
    if (auth?.role === "admin") {
      setAdminUnlocked(true);
      setAdminUser(auth);
      setAdminMsg(`Admin entsperrt (${auth.name}).`);
      setAdminPinInput("");
    } else {
      setAdminMsg("Kein Admin-PIN.");
    }
  }

  function lockAdmin() {
    setAdminUnlocked(false);
    setAdminUser(null);
    setAdminMsg("Admin gesperrt.");
  }

  async function adminVoidByReceipt() {
    try {
      setAdminMsg(null);
      if (!adminUnlocked) return void setAdminMsg("Bitte zuerst Admin entsperren.");

      const r = voidReceiptNo.trim();
      const reason = voidReason.trim();
      if (!r) return void setAdminMsg("Bitte Bon-Nr eingeben.");
      if (!reason) return void setAdminMsg("Bitte Storno-Grund eingeben.");

      const { data: o, error: oErr } = await supabase.from("orders").select("id,status").eq("event_id", EVENT_ID).eq("receipt_no", r).single();
      if (oErr) throw new Error(oErr.message);
      if (!o) throw new Error("Bon nicht gefunden.");
      if ((o as any).status === "voided") return void setAdminMsg("Dieser Bon ist bereits storniert.");

      const nowIso = new Date().toISOString();

      const { error: uErr } = await supabase.from("orders").update({ status: "voided", voided_at: nowIso }).eq("id", (o as any).id);
      if (uErr) throw new Error(uErr.message);

      const who = adminUser ? `${adminUser.role}:${adminUser.name}` : "admin";
      const { error: vErr } = await supabase.from("voids").insert({ order_id: (o as any).id, voided_by: who, reason });
      if (vErr) throw new Error(vErr.message);

      setAdminMsg(`Storno ok: ${r}`);
      setVoidReceiptNo("");
      setVoidReason("");
    } catch (e: any) {
      setAdminMsg(`Fehler: ${e?.message ?? String(e)}`);
    }
  }

  async function adminReprintByReceipt() {
    try {
      setAdminMsg(null);
      if (!adminUnlocked) return void setAdminMsg("Bitte zuerst Admin entsperren.");

      const r = reprintReceiptNo.trim();
      if (!r) return void setAdminMsg("Bitte Bon-Nr eingeben.");

      const { data: o, error: oErr } = await supabase
        .from("orders")
        .select("id,bar_id,receipt_no,created_at,payment_method,gross_total,tax_total,net_total")
        .eq("event_id", EVENT_ID)
        .eq("receipt_no", r)
        .single();

      if (oErr) throw new Error(oErr.message);
      if (!o) throw new Error("Bon nicht gefunden.");

      const { data: it, error: iErr } = await supabase.from("order_items").select("name_snapshot,qty,line_total_gross").eq("order_id", (o as any).id);
      if (iErr) throw new Error(iErr.message);

      const barName = bars.find((b) => b.id === (o as any).bar_id)?.name ?? "Bar";

      const payload = buildReceiptText({
        barName,
        receiptNo: (o as any).receipt_no,
        createdAtISO: (o as any).created_at,
        payment: (o as any).payment_method,
        lines: (it ?? []).map((x: any) => ({ qty: x.qty, name: x.name_snapshot, lineTotal: Number(x.line_total_gross) })),
        gross: Number((o as any).gross_total),
        tax: Number((o as any).tax_total),
        net: Number((o as any).net_total),
      });

      const { error: pErr } = await supabase.from("print_jobs").insert({ event_id: EVENT_ID, order_id: (o as any).id, payload, status: "queued" });
      if (pErr) throw new Error(pErr.message);

      setAdminMsg(`Reprint queued: ${r}`);
      setReprintReceiptNo("");
    } catch (e: any) {
      setAdminMsg(`Fehler: ${e?.message ?? String(e)}`);
    }
  }

  async function loadReport(range: "all" | "today") {
    try {
      setReportLoading(true);
      setReportError(null);
      setReportTotals(null);
      setReportByBar([]);
      setReportByProduct([]);

      if (!adminUnlocked) return void setReportError("Bitte Admin entsperren.");

      let q = supabase.from("orders").select("id,bar_id,gross_total,tax_total,net_total,created_at,status").eq("event_id", EVENT_ID).eq("status", "completed");

      if (range === "today") {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        q = q.gte("created_at", start.toISOString());
      }

      const { data: orders, error: oErr } = await q;
      if (oErr) throw new Error(oErr.message);

      const totals = {
        brutto: round2((orders ?? []).reduce((s: number, o: any) => s + Number(o.gross_total), 0)),
        ust: round2((orders ?? []).reduce((s: number, o: any) => s + Number(o.tax_total), 0)),
        netto: round2((orders ?? []).reduce((s: number, o: any) => s + Number(o.net_total), 0)),
        bons: (orders ?? []).length,
      };
      setReportTotals(totals);

      const barMap = new Map<string, { bar: string; brutto: number; bons: number }>();
      for (const o of orders ?? []) {
        const barName = bars.find((b) => b.id === (o as any).bar_id)?.name ?? "Unbekannt";
        const ex = barMap.get(barName) ?? { bar: barName, brutto: 0, bons: 0 };
        ex.brutto = round2(ex.brutto + Number((o as any).gross_total));
        ex.bons += 1;
        barMap.set(barName, ex);
      }
      setReportByBar(Array.from(barMap.values()).sort((a, b) => b.brutto - a.brutto));

      const ids = (orders ?? []).map((o: any) => o.id);
      if (ids.length) {
        const { data: items, error: iErr } = await supabase.from("order_items").select("order_id,name_snapshot,qty,line_total_gross").in("order_id", ids);
        if (iErr) throw new Error(iErr.message);

        const prodMap = new Map<string, { produkt: string; menge: number; brutto: number }>();
        for (const it of items ?? []) {
          const key = (it as any).name_snapshot as string;
          const ex = prodMap.get(key) ?? { produkt: key, menge: 0, brutto: 0 };
          ex.menge += Number((it as any).qty);
          ex.brutto = round2(ex.brutto + Number((it as any).line_total_gross));
          prodMap.set(key, ex);
        }
        setReportByProduct(Array.from(prodMap.values()).sort((a, b) => b.brutto - a.brutto));
      }
    } catch (e: any) {
      setReportError(e?.message ?? String(e));
    } finally {
      setReportLoading(false);
    }
  }

  // ✅ styles: CSSProperties + functions → any
  const styles: Record<string, any> = {
    page: {
      minHeight: "100vh",
      background:
        "radial-gradient(1200px 600px at 20% 10%, rgba(120, 0, 255, 0.25), transparent 55%)," +
        "radial-gradient(900px 500px at 85% 20%, rgba(0, 255, 200, 0.18), transparent 55%)," +
        "radial-gradient(900px 700px at 60% 90%, rgba(0, 120, 255, 0.12), transparent 60%)," +
        "linear-gradient(180deg, #050510 0%, #07071a 35%, #04040c 100%)",
      color: "#e9e9ff",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    },
    topbar: {
      position: "sticky",
      top: 0,
      zIndex: 10,
      backdropFilter: "blur(10px)",
      background: "rgba(5,5,16,0.6)",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
    },
    topbarInner: {
      maxWidth: 1280,
      margin: "0 auto",
      padding: "14px 16px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    brand: { display: "flex", flexDirection: "column", lineHeight: 1.05 },
    title: { margin: 0, fontWeight: 900, letterSpacing: 1.2, textTransform: "uppercase", fontSize: 18 },
    subtitle: { margin: "4px 0 0 0", opacity: 0.75, fontSize: 13, letterSpacing: 0.4 },
    layout: { maxWidth: 1280, margin: "0 auto", padding: 16, display: "grid", gridTemplateColumns: "1fr 380px", gap: 16 },
    card: {
      borderRadius: 18,
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(12,12,28,0.55)",
      boxShadow: "0 12px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)",
      overflow: "hidden",
    },
    cardHeader: {
      padding: "14px 14px",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    cardHeaderTitle: { margin: 0, fontSize: 16, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase" },
    pill: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "8px 10px",
      borderRadius: 999,
      border: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(255,255,255,0.05)",
      fontWeight: 800,
      fontSize: 13,
      whiteSpace: "nowrap",
    },
    subtleBtn: {
      padding: "10px 12px",
      borderRadius: 14,
      border: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(255,255,255,0.06)",
      color: "#e9e9ff",
      fontWeight: 800,
      cursor: "pointer",
    },
    dangerBtn: {
      padding: "10px 12px",
      borderRadius: 14,
      border: "1px solid rgba(255,80,80,0.35)",
      background: "rgba(255,80,80,0.12)",
      color: "#ffecec",
      fontWeight: 900,
      cursor: "pointer",
    },
    barRow: { display: "flex", gap: 10, flexWrap: "wrap", padding: 14 },
    barBtn: (active: boolean): React.CSSProperties => ({
      padding: "12px 14px",
      borderRadius: 16,
      border: active ? "1px solid rgba(0,255,200,0.55)" : "1px solid rgba(255,255,255,0.12)",
      background: active ? "linear-gradient(135deg, rgba(0,255,200,0.18), rgba(120,0,255,0.15))" : "rgba(255,255,255,0.05)",
      color: active ? "#eafffb" : "#e9e9ff",
      fontSize: 16,
      fontWeight: 900,
      cursor: "pointer",
    }),
    productsGrid: { padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 },
    productCard: {
      borderRadius: 18,
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(10,10,22,0.65)",
      boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
      padding: 14,
      cursor: "pointer",
      userSelect: "none",
    },
    productName: { fontSize: 18, fontWeight: 900, marginBottom: 10 },
    productPrice: { fontSize: 16, opacity: 0.9, fontWeight: 800 },
    rightInner: { padding: 14, display: "flex", flexDirection: "column", gap: 12 },
    totals: { padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", display: "grid", gap: 8 },
    totalRow: { display: "flex", justifyContent: "space-between", gap: 10, fontWeight: 800, opacity: 0.95 },
    cartLine: { display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "10px 10px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)" },
    qtyControls: { display: "flex", alignItems: "center", gap: 8 },
    qtyBtn: { width: 40, height: 40, borderRadius: 12, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)", color: "#e9e9ff", fontWeight: 900, fontSize: 18, cursor: "pointer" },
    payRow: { display: "flex", gap: 10 },
    payBtn: (active: boolean): React.CSSProperties => ({
      flex: 1,
      padding: "12px 12px",
      borderRadius: 16,
      border: active ? "1px solid rgba(0,255,200,0.55)" : "1px solid rgba(255,255,255,0.12)",
      background: active ? "linear-gradient(135deg, rgba(0,255,200,0.18), rgba(0,120,255,0.10))" : "rgba(255,255,255,0.05)",
      color: "#e9e9ff",
      fontWeight: 900,
      cursor: "pointer",
    }),
    footerActions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
    bigCheckout: {
      gridColumn: "1 / -1",
      padding: "14px 14px",
      borderRadius: 18,
      border: "1px solid rgba(0,255,200,0.45)",
      background: "linear-gradient(135deg, rgba(0,255,200,0.24), rgba(120,0,255,0.18))",
      color: "#eafffb",
      fontWeight: 950,
      fontSize: 18,
      cursor: "pointer",
      opacity: checkoutLoading ? 0.6 : 1,
    },
    hint: { opacity: 0.75, fontSize: 13, lineHeight: 1.35 },
    modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 100 },
    modal: { width: "min(900px, 100%)", borderRadius: 18, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(12,12,28,0.92)", boxShadow: "0 18px 60px rgba(0,0,0,0.55)", overflow: "hidden" },
    modalHeader: { padding: 14, borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
    tabs: { display: "flex", gap: 8, padding: 14, borderBottom: "1px solid rgba(255,255,255,0.08)" },
    tabBtn: (active: boolean): React.CSSProperties => ({
      padding: "10px 12px",
      borderRadius: 14,
      border: active ? "1px solid rgba(0,255,200,0.55)" : "1px solid rgba(255,255,255,0.12)",
      background: active ? "rgba(0,255,200,0.12)" : "rgba(255,255,255,0.06)",
      color: "#e9e9ff",
      fontWeight: 900,
      cursor: "pointer",
    }),
    modalBody: { padding: 14, display: "grid", gap: 12 },
    input: { width: "100%", padding: "12px 12px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "#e9e9ff", fontWeight: 800, outline: "none", fontSize: 16 },
    table: { width: "100%", borderCollapse: "separate", borderSpacing: 0, overflow: "hidden", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 16, background: "rgba(255,255,255,0.04)" },
    th: { textAlign: "left", padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", opacity: 0.85 },
    td: { padding: 10, borderBottom: "1px solid rgba(255,255,255,0.06)" },
  };

  async function doLogin() {
    try {
      setLoginMsg(null);
      setLoginLoading(true);

      const auth = await checkPin(loginPin);
      if (!auth) {
        setLoginMsg("Falscher PIN.");
        return;
      }

      setStaff(auth);
      saveStaffSession(auth);
      setLoginPin("");
      setLoginMsg(null);
    } finally {
      setLoginLoading(false);
    }
  }

  function doLogout() {
    setStaff(null);
    clearStaffSession();
    setCart({});
    setLastReceipt(null);
    setQrDataUrl(null);
    setError(null);
    // Bar Auswahl lassen wir bewusst gespeichert (damit Gerät an einer Bar bleibt)
  }

  // Admin UI
  async function unlockAdmin() {
    setAdminMsg(null);
    const auth = await checkPin(adminPinInput);
    if (auth?.role === "admin") {
      setAdminUnlocked(true);
      setAdminUser(auth);
      setAdminMsg(`Admin entsperrt (${auth.name}).`);
      setAdminPinInput("");
    } else {
      setAdminMsg("Kein Admin-PIN.");
    }
  }
  function lockAdmin() {
    setAdminUnlocked(false);
    setAdminUser(null);
    setAdminMsg("Admin gesperrt.");
  }
  function openAdmin() {
    setAdminMsg(null);
    setAdminTab("void");
    setAdminOpen(true);
  }
  function closeAdmin() {
    setAdminMsg(null);
    setAdminPinInput("");
    setAdminOpen(false);
  }

  async function adminVoidByReceipt() {
    try {
      setAdminMsg(null);
      if (!adminUnlocked) return void setAdminMsg("Bitte zuerst Admin entsperren.");

      const r = voidReceiptNo.trim();
      const reason = voidReason.trim();
      if (!r) return void setAdminMsg("Bitte Bon-Nr eingeben.");
      if (!reason) return void setAdminMsg("Bitte Storno-Grund eingeben.");

      const { data: o, error: oErr } = await supabase.from("orders").select("id,status").eq("event_id", EVENT_ID).eq("receipt_no", r).single();
      if (oErr) throw new Error(oErr.message);
      if (!o) throw new Error("Bon nicht gefunden.");
      if ((o as any).status === "voided") return void setAdminMsg("Dieser Bon ist bereits storniert.");

      const nowIso = new Date().toISOString();
      const { error: uErr } = await supabase.from("orders").update({ status: "voided", voided_at: nowIso }).eq("id", (o as any).id);
      if (uErr) throw new Error(uErr.message);

      const who = adminUser ? `${adminUser.role}:${adminUser.name}` : "admin";
      const { error: vErr } = await supabase.from("voids").insert({ order_id: (o as any).id, voided_by: who, reason });
      if (vErr) throw new Error(vErr.message);

      setAdminMsg(`Storno ok: ${r}`);
      setVoidReceiptNo("");
      setVoidReason("");
    } catch (e: any) {
      setAdminMsg(`Fehler: ${e?.message ?? String(e)}`);
    }
  }

  async function adminReprintByReceipt() {
    try {
      setAdminMsg(null);
      if (!adminUnlocked) return void setAdminMsg("Bitte zuerst Admin entsperren.");

      const r = reprintReceiptNo.trim();
      if (!r) return void setAdminMsg("Bitte Bon-Nr eingeben.");

      const { data: o, error: oErr } = await supabase
        .from("orders")
        .select("id,bar_id,receipt_no,created_at,payment_method,gross_total,tax_total,net_total")
        .eq("event_id", EVENT_ID)
        .eq("receipt_no", r)
        .single();

      if (oErr) throw new Error(oErr.message);
      if (!o) throw new Error("Bon nicht gefunden.");

      const { data: it, error: iErr } = await supabase.from("order_items").select("name_snapshot,qty,line_total_gross").eq("order_id", (o as any).id);
      if (iErr) throw new Error(iErr.message);

      const barName = bars.find((b) => b.id === (o as any).bar_id)?.name ?? "Bar";

      const payload = buildReceiptText({
        barName,
        receiptNo: (o as any).receipt_no,
        createdAtISO: (o as any).created_at,
        payment: (o as any).payment_method,
        lines: (it ?? []).map((x: any) => ({ qty: x.qty, name: x.name_snapshot, lineTotal: Number(x.line_total_gross) })),
        gross: Number((o as any).gross_total),
        tax: Number((o as any).tax_total),
        net: Number((o as any).net_total),
      });

      const { error: pErr } = await supabase.from("print_jobs").insert({ event_id: EVENT_ID, order_id: (o as any).id, payload, status: "queued" });
      if (pErr) throw new Error(pErr.message);

      setAdminMsg(`Reprint queued: ${r}`);
      setReprintReceiptNo("");
    } catch (e: any) {
      setAdminMsg(`Fehler: ${e?.message ?? String(e)}`);
    }
  }

  // Report
  async function loadReport(range: "all" | "today") {
    try {
      setReportLoading(true);
      setReportError(null);
      setReportTotals(null);
      setReportByBar([]);
      setReportByProduct([]);

      if (!adminUnlocked) return void setReportError("Bitte Admin entsperren.");

      let q = supabase.from("orders").select("id,bar_id,gross_total,tax_total,net_total,created_at,status").eq("event_id", EVENT_ID).eq("status", "completed");

      if (range === "today") {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        q = q.gte("created_at", start.toISOString());
      }

      const { data: orders, error: oErr } = await q;
      if (oErr) throw new Error(oErr.message);

      const totals = {
        brutto: round2((orders ?? []).reduce((s: number, o: any) => s + Number(o.gross_total), 0)),
        ust: round2((orders ?? []).reduce((s: number, o: any) => s + Number(o.tax_total), 0)),
        netto: round2((orders ?? []).reduce((s: number, o: any) => s + Number(o.net_total), 0)),
        bons: (orders ?? []).length,
      };
      setReportTotals(totals);

      const barMap = new Map<string, { bar: string; brutto: number; bons: number }>();
      for (const o of orders ?? []) {
        const barName = bars.find((b) => b.id === (o as any).bar_id)?.name ?? "Unbekannt";
        const ex = barMap.get(barName) ?? { bar: barName, brutto: 0, bons: 0 };
        ex.brutto = round2(ex.brutto + Number((o as any).gross_total));
        ex.bons += 1;
        barMap.set(barName, ex);
      }
      setReportByBar(Array.from(barMap.values()).sort((a, b) => b.brutto - a.brutto));

      const ids = (orders ?? []).map((o: any) => o.id);
      if (ids.length) {
        const { data: items, error: iErr } = await supabase.from("order_items").select("order_id,name_snapshot,qty,line_total_gross").in("order_id", ids);
        if (iErr) throw new Error(iErr.message);

        const prodMap = new Map<string, { produkt: string; menge: number; brutto: number }>();
        for (const it of items ?? []) {
          const key = (it as any).name_snapshot as string;
          const ex = prodMap.get(key) ?? { produkt: key, menge: 0, brutto: 0 };
          ex.menge += Number((it as any).qty);
          ex.brutto = round2(ex.brutto + Number((it as any).line_total_gross));
          prodMap.set(key, ex);
        }
        setReportByProduct(Array.from(prodMap.values()).sort((a, b) => b.brutto - a.brutto));
      }
    } catch (e: any) {
      setReportError(e?.message ?? String(e));
    } finally {
      setReportLoading(false);
    }
  }

  // ⭐ Login-Gate: wenn nicht eingeloggt → Login Screen
  if (!staff) {
    return (
      <div style={styles.page}>
        <div style={styles.topbar}>
          <div style={styles.topbarInner}>
            <div style={styles.brand}>
              <h1 style={styles.title}>Festkassa</h1>
              <p style={styles.subtitle}>Login erforderlich (PIN)</p>
            </div>
          </div>
        </div>

        <div style={{ maxWidth: 560, margin: "0 auto", padding: 16 }}>
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <h2 style={styles.cardHeaderTitle}>Mitarbeiter Login</h2>
              {selectedBarId && <span style={styles.pill}>Bar gespeichert</span>}
            </div>

            <div style={{ padding: 14, display: "grid", gap: 12 }}>
              <div style={styles.hint}>PIN eingeben. Danach kannst du Bestellungen bonieren und Stornos machen.</div>

              <input
                style={styles.input}
                placeholder="PIN"
                value={loginPin}
                onChange={(e) => setLoginPin(e.target.value)}
                inputMode="numeric"
                type="password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") doLogin();
                }}
              />

              <button style={styles.subtleBtn} onClick={doLogin} disabled={loginLoading}>
                {loginLoading ? "Prüfe…" : "Einloggen"}
              </button>

              {loginMsg && <div style={{ ...styles.totals, color: "#ff8080", fontWeight: 900 }}>{loginMsg}</div>}

              <div style={styles.totals}>
                <div style={{ ...styles.totalRow, fontWeight: 950 }}>
                  <span>Hinweis</span>
                  <span>PIN = Storno-PIN</span>
                </div>
                <div style={styles.hint}>
                  Wenn Geräte herumliegen, verhindert der Login, dass “irgendwer” Bestellungen tippt.
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, opacity: 0.65, fontSize: 12 }}>
            (Der Login wird pro Gerät gespeichert. Abmelden oben rechts, wenn Schichtwechsel ist.)
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.topbar}>
        <div style={styles.topbarInner}>
          <div style={styles.brand}>
            <h1 style={styles.title}>Festkassa</h1>
            <p style={styles.subtitle}>
              Eingeloggt: <b>{staff.name}</b> ({staff.role}) {selectedBar ? `• Bar: ${selectedBar.name}` : "• Bar auswählen"}
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button style={styles.subtleBtn} onClick={openAdmin}>
              Admin {adminUnlocked ? `✓${adminUser?.name ? ` (${adminUser.name})` : ""}` : ""}
            </button>
            <button style={styles.subtleBtn} onClick={doLogout}>Abmelden</button>
            {selectedBar && (
              <button style={styles.subtleBtn} onClick={resetBar}>
                Bar wechseln
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={styles.layout}>
        {/* LEFT */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <h2 style={styles.cardHeaderTitle}>{selectedBar ? "Bestellung" : "Bar Auswahl"}</h2>
            {loadingBars && <span style={styles.pill}>Lade…</span>}
          </div>

          {!selectedBarId ? (
            <div style={styles.barRow}>
              {bars.map((b) => (
                <button key={b.id} onClick={() => chooseBar(b.id)} style={styles.barBtn(false)}>
                  {b.name}
                </button>
              ))}
              <div style={{ width: "100%", marginTop: 10 }}>
                <p style={styles.hint}>Wähle die Bar einmal aus. Die Auswahl wird auf diesem Gerät gespeichert.</p>
                {error && <p style={{ color: "#ff8080", marginTop: 8 }}>{error}</p>}
              </div>
            </div>
          ) : (
            <>
              <div style={{ padding: 14, display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 950 }}>{selectedBar?.name}</div>
                  <div style={{ ...styles.hint, marginTop: 4 }}>Tippe ein Produkt, um es in den Warenkorb zu legen.</div>
                </div>
                <button style={styles.subtleBtn} onClick={() => setCart({})}>
                  Warenkorb leeren
                </button>
              </div>

              {loadingProducts ? (
                <div style={{ padding: 14 }}>
                  <p>Lade Produkte…</p>
                </div>
              ) : (
                <div style={styles.productsGrid}>
                  {products.map((p) => (
                    <div key={p.id} style={styles.productCard} onClick={() => addToCart(p)}>
                      <div style={styles.productName}>{p.name}</div>
                      <div style={styles.productPrice}>{euro(Number(p.price_gross))}</div>
                    </div>
                  ))}
                  {products.length === 0 && <p style={{ padding: 6 }}>Keine Produkte für diese Bar.</p>}
                </div>
              )}

              {error && <div style={{ padding: 14, color: "#ff8080" }}>{error}</div>}
            </>
          )}
        </div>

        {/* RIGHT */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <h2 style={styles.cardHeaderTitle}>Checkout</h2>
            <span style={styles.pill}>{cartLines.length} Position{cartLines.length === 1 ? "" : "en"}</span>
          </div>

          <div style={styles.rightInner}>
            {lastReceipt && (
              <div style={styles.totals}>
                <div style={{ ...styles.totalRow, fontWeight: 950 }}>
                  <span>Letzter Beleg</span>
                  <span>{lastReceipt.receipt_no}</span>
                </div>
                <div style={styles.totalRow}>
                  <span>Beleg anzeigen</span>
                  <a href={lastReceipt.receipt_url} style={{ color: "#aef", fontWeight: 900, textDecoration: "none" }}>
                    öffnen
                  </a>
                </div>

                {qrDataUrl && (
                  <div style={{ marginTop: 8 }}>
                    <img src={qrDataUrl} alt="QR" style={{ width: "100%", borderRadius: 12 }} />
                  </div>
                )}

                <button
                  style={styles.dangerBtn}
                  onClick={() => {
                    setVoidOpen(true);
                    setVoidMsg(null);
                    setVoidPin("");
                  }}
                >
                  Letzten Bon stornieren
                </button>

                <button
                  style={styles.subtleBtn}
                  onClick={() => {
                    setLastReceipt(null);
                    setQrDataUrl(null);
                  }}
                >
                  Neue Bestellung
                </button>
              </div>
            )}

            {cartLines.length === 0 ? (
              <p style={styles.hint}>Warenkorb ist leer. Tippe links Produkte an.</p>
            ) : (
              <>
                <div style={{ display: "grid", gap: 10 }}>
                  {cartLines.map((line) => {
                    const lineTotal = Number(line.product.price_gross) * line.qty;
                    return (
                      <div key={line.product.id} style={styles.cartLine}>
                        <div>
                          <div style={{ fontWeight: 950 }}>{line.product.name}</div>
                          <div style={{ opacity: 0.8, marginTop: 4 }}>{euro(lineTotal)}</div>
                        </div>
                        <div style={styles.qtyControls}>
                          <button style={styles.qtyBtn} onClick={() => dec(line.product.id)}>
                            –
                          </button>
                          <div style={{ minWidth: 22, textAlign: "center", fontWeight: 950 }}>{line.qty}</div>
                          <button style={styles.qtyBtn} onClick={() => inc(line.product.id)}>
                            +
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={styles.totals}>
                  <div style={styles.totalRow}>
                    <span>Brutto</span>
                    <span>{euro(grossTotal)}</span>
                  </div>
                  <div style={styles.totalRow}>
                    <span>USt 20%</span>
                    <span>{euro(taxTotal)}</span>
                  </div>
                  <div style={{ ...styles.totalRow, fontWeight: 950, fontSize: 16 }}>
                    <span>Netto</span>
                    <span>{euro(netTotal)}</span>
                  </div>
                </div>

                <div>
                  <div style={{ ...styles.hint, marginBottom: 8 }}>Zahlungsart</div>
                  <div style={styles.payRow}>
                    <button style={styles.payBtn(paymentMethod === "cash")} onClick={() => setPaymentMethod("cash")}>
                      Bar
                    </button>
                    <button style={styles.payBtn(paymentMethod === "sumup")} onClick={() => setPaymentMethod("sumup")}>
                      Karte (SumUp)
                    </button>
                  </div>
                </div>

                <div style={styles.footerActions}>
                  <button style={styles.subtleBtn} onClick={clearCart}>
                    Abbrechen
                  </button>

                  <button style={styles.subtleBtn} disabled={checkoutLoading} onClick={() => doCheckout(true)} title="Nur wenn Kunde wirklich Papier will">
                    Abschließen + Drucken
                  </button>

                  <button style={styles.bigCheckout} disabled={checkoutLoading} onClick={() => doCheckout(false)}>
                    {checkoutLoading ? "Speichere…" : "Abschließen (digital)"}
                  </button>

                  <div style={{ ...styles.hint, gridColumn: "1 / -1" }}>
                    Standard: digitaler Beleg (Anzeige + QR). Papier nur auf Nachfrage – sonst Chaos am zentralen Drucker.
                  </div>

                  {error && (
                    <div style={{ gridColumn: "1 / -1", color: "#ff8080", fontWeight: 800 }}>
                      Fehler: {error}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Mitarbeiter-Storno Modal */}
      {voidOpen && (
        <div style={styles.modalOverlay} onClick={() => setVoidOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ fontWeight: 950, letterSpacing: 0.6, textTransform: "uppercase" }}>Storno</div>
                <div style={styles.hint}>
                  Letzter Bon: <b>{lastReceipt?.receipt_no ?? "—"}</b>
                </div>
              </div>
              <button style={styles.subtleBtn} onClick={() => setVoidOpen(false)}>
                Schließen
              </button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.hint}>PIN von Mitarbeiter oder Admin eingeben.</div>

              <input style={styles.input} placeholder="PIN" value={voidPin} onChange={(e) => setVoidPin(e.target.value)} inputMode="numeric" type="password" />

              <button style={styles.dangerBtn} disabled={voidLoading} onClick={voidLastReceiptNoReason}>
                {voidLoading ? "Storniere…" : "Storno bestätigen"}
              </button>

              {voidMsg && <div style={{ ...styles.totals, color: voidMsg.startsWith("Fehler") ? "#ff8080" : "#eafffb" }}>{voidMsg}</div>}
            </div>
          </div>
        </div>
      )}

      {/* Admin Modal */}
      {adminOpen && (
        <div style={styles.modalOverlay} onClick={closeAdmin}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ fontWeight: 950, letterSpacing: 0.6, textTransform: "uppercase" }}>Admin</div>
                <div style={styles.hint}>Status: {adminUnlocked ? `entsperrt (${adminUser?.name ?? "Admin"})` : "gesperrt"}</div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {adminUnlocked && (
                  <button style={styles.dangerBtn} onClick={lockAdmin}>
                    Sperren
                  </button>
                )}
                <button style={styles.subtleBtn} onClick={closeAdmin}>
                  Schließen
                </button>
              </div>
            </div>

            <div style={styles.tabs}>
              <button style={styles.tabBtn(adminTab === "void")} onClick={() => setAdminTab("void")}>
                Storno
              </button>
              <button style={styles.tabBtn(adminTab === "reprint")} onClick={() => setAdminTab("reprint")}>
                Reprint
              </button>
              <button style={styles.tabBtn(adminTab === "report")} onClick={() => setAdminTab("report")}>
                Abschluss
              </button>

              <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
                {!adminUnlocked && (
                  <>
                    <input
                      style={{ ...styles.input, width: 180 }}
                      placeholder="Admin PIN"
                      value={adminPinInput}
                      onChange={(e) => setAdminPinInput(e.target.value)}
                      inputMode="numeric"
                      type="password"
                    />
                    <button style={styles.subtleBtn} onClick={unlockAdmin}>
                      Entsperren
                    </button>
                  </>
                )}
                {adminUnlocked && <span style={styles.pill}>Admin ✓</span>}
              </div>
            </div>

            <div style={styles.modalBody}>
              {adminMsg && <div style={{ ...styles.totals, color: adminMsg.startsWith("Fehler") ? "#ff8080" : "#eafffb" }}>{adminMsg}</div>}

              {adminTab === "void" && (
                <>
                  <div style={{ fontWeight: 950 }}>Storno per Bon-Nr (mit Grund)</div>
                  <input style={styles.input} placeholder="Bon-Nr" value={voidReceiptNo} onChange={(e) => setVoidReceiptNo(e.target.value)} />
                  <input style={styles.input} placeholder="Storno-Grund (Pflicht)" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                  <button style={styles.dangerBtn} onClick={adminVoidByReceipt} disabled={!adminUnlocked}>
                    Stornieren
                  </button>
                </>
              )}

              {adminTab === "reprint" && (
                <>
                  <div style={{ fontWeight: 950 }}>Reprint per Bon-Nr</div>
                  <input style={styles.input} placeholder="Bon-Nr" value={reprintReceiptNo} onChange={(e) => setReprintReceiptNo(e.target.value)} />
                  <button style={styles.subtleBtn} onClick={adminReprintByReceipt} disabled={!adminUnlocked}>
                    Reprint in Queue
                  </button>
                </>
              )}

              {adminTab === "report" && (
                <>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button style={styles.subtleBtn} onClick={() => loadReport("today")} disabled={reportLoading || !adminUnlocked}>
                      Heute laden
                    </button>
                    <button style={styles.subtleBtn} onClick={() => loadReport("all")} disabled={reportLoading || !adminUnlocked}>
                      Ganzes Event laden
                    </button>
                    {reportLoading && <span style={styles.pill}>Lade…</span>}
                  </div>

                  {reportError && <div style={{ color: "#ff8080", fontWeight: 800 }}>Fehler: {reportError}</div>}

                  {reportTotals && (
                    <div style={styles.totals}>
                      <div style={{ ...styles.totalRow, fontWeight: 950 }}>
                        <span>Gesamt</span>
                        <span>{reportTotals.bons} Bons</span>
                      </div>
                      <div style={styles.totalRow}>
                        <span>Brutto</span>
                        <span>{euro(reportTotals.brutto)}</span>
                      </div>
                      <div style={styles.totalRow}>
                        <span>USt 20%</span>
                        <span>{euro(reportTotals.ust)}</span>
                      </div>
                      <div style={{ ...styles.totalRow, fontWeight: 950 }}>
                        <span>Netto</span>
                        <span>{euro(reportTotals.netto)}</span>
                      </div>
                    </div>
                  )}

                  {reportByBar.length > 0 && (
                    <div>
                      <div style={{ fontWeight: 950, marginBottom: 8 }}>Umsatz pro Bar</div>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Bar</th>
                            <th style={styles.th}>Bons</th>
                            <th style={styles.th}>Brutto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportByBar.map((r) => (
                            <tr key={r.bar}>
                              <td style={styles.td}>{r.bar}</td>
                              <td style={styles.td}>{r.bons}</td>
                              <td style={styles.td}>{euro(r.brutto)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {reportByProduct.length > 0 && (
                    <div>
                      <div style={{ fontWeight: 950, marginBottom: 8 }}>Top Produkte</div>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Produkt</th>
                            <th style={styles.th}>Menge</th>
                            <th style={styles.th}>Brutto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportByProduct.slice(0, 30).map((r) => (
                            <tr key={r.produkt}>
                              <td style={styles.td}>{r.produkt}</td>
                              <td style={styles.td}>{r.menge}</td>
                              <td style={styles.td}>{euro(r.brutto)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 16px 16px 16px", opacity: 0.6, fontSize: 12 }}>
        Login + Storno PIN via RPC <b>check_staff_pin</b> • Bestellungen speichern Kassier: <b>{staff.name}</b>
      </div>
    </div>
  );
}

function ReceiptPage() {
  const token = getReceiptTokenFromPath();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<ReceiptOrderRow | null>(null);
  const [items, setItems] = useState<ReceiptItemRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        if (!token) {
          setError("Ungültiger Beleg-Link.");
          return;
        }

        const { data: o, error: oErr } = await supabase
          .from("orders")
          .select("id,receipt_no,created_at,payment_method,gross_total,tax_total,net_total,status")
          .eq("public_token", token)
          .single();

        if (oErr) throw new Error(oErr.message);

        const { data: it, error: iErr } = await supabase.from("order_items").select("order_id,name_snapshot,qty,line_total_gross").eq("order_id", (o as any).id);
        if (iErr) throw new Error(iErr.message);

        setOrder(o as any);
        setItems((it ?? []) as any);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #050510 0%, #07071a 35%, #04040c 100%)",
    color: "#e9e9ff",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    padding: 18,
  };

  const cardStyle: React.CSSProperties = {
    maxWidth: 520,
    margin: "0 auto",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(12, 12, 28, 0.55)",
    boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
    overflow: "hidden",
  };

  const mono: React.CSSProperties = {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    whiteSpace: "pre-wrap",
    lineHeight: 1.35,
  };

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <div style={{ padding: 14, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ fontWeight: 950, letterSpacing: 0.6, textTransform: "uppercase" }}>Beleganzeige</div>
          <div style={{ opacity: 0.8, marginTop: 6 }}>Token: {token ?? "—"}</div>
        </div>

        <div style={{ padding: 14 }}>
          {loading && <p>Lade…</p>}
          {error && <p style={{ color: "#ff8080", fontWeight: 800 }}>Fehler: {error}</p>}

          {!loading && !error && order && (
            <div style={mono}>
              {`Bon-Nr: ${order.receipt_no}\n`}
              {`${new Date(order.created_at).toLocaleString("de-AT")}\n`}
              {`Zahlung: ${order.payment_method === "sumup" ? "Karte (SumUp)" : "Bar"}\n`}
              {`Status: ${order.status}\n`}
              {`-----------------------------\n`}
              {items.map((it) => `${it.qty}x ${it.name_snapshot}  ${euro(Number(it.line_total_gross))}\n`).join("")}
              {`-----------------------------\n`}
              {`BRUTTO  ${euro(Number(order.gross_total))}\n`}
              {`USt 20% ${euro(Number(order.tax_total))}\n`}
              {`NETTO   ${euro(Number(order.net_total))}\n`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
