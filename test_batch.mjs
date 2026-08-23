import fs from 'fs';
import Papa from 'papaparse';

const fileStr = fs.readFileSync('Data/Unihack_ Sample Dataset - Input.csv', 'utf-8');
const parsed = Papa.parse(fileStr, { header: true, skipEmptyLines: true });
const rows = parsed.data;

const mfr = "dishwasher";
const filtered = rows.filter(r => (r.Part_Manuf || "").toLowerCase().includes(mfr.toLowerCase()) || (r.Part_Desc || "").toLowerCase().includes(mfr.toLowerCase()));

const products = filtered.map(r => ({
  raw_text: `${r.Mfg_Part_Num || ""} ${r.Part_Manuf || ""} ${r.Part_Desc || ""}`.trim()
})).slice(0, 10);

console.log(`Sending ${products.length} products...`);

fetch('http://localhost:3001/api/process-batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ products })
}).then(res => res.json()).then(data => {
  console.log("Done. Check Next.js server logs.");
}).catch(console.error);
