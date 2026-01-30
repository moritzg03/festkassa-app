import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("❌ SUPABASE_URL oder SERVICE_KEY fehlt");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

console.log("🖨️ Festkassa Print-Bridge gestartet…");

async function pollPrintJobs() {
  const { data, error } = await supabase
    .from("print_jobs")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    console.error("❌ Fehler beim Lesen der Queue:", error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.log("⏳ Keine Druckjobs");
    return;
  }

  const job = data[0];

  console.log("🧾 Neuer Druckjob:");
  console.log("--------------------------------");
  console.log(job.payload);
  console.log("--------------------------------");

  // 👉 später: hier kommt der echte Druck

  const { error: updErr } = await supabase
    .from("print_jobs")
    .update({ status: "printed", printed_at: new Date().toISOString() })
    .eq("id", job.id);

  if (updErr) {
    console.error("❌ Konnte Job nicht abschließen:", updErr.message);
  } else {
    console.log("✅ Job als gedruckt markiert");
  }
}

// alle 3 Sekunden prüfen
setInterval(pollPrintJobs, 3000);