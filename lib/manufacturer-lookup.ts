import * as XLSX from "xlsx";
import path from "path";
import fs from "fs";

let masterList: { name: string; brand: string }[] | null = null;

function loadMasterList() {
  if (masterList !== null) return masterList;

  try {
    const filePath = path.join(process.cwd(), "Data", "UniCat_Manufacturer_and_Brand_List.xlsx");
    if (!fs.existsSync(filePath)) {
      masterList = [];
      return masterList;
    }

    const fileBuffer = fs.readFileSync(filePath);
    const wb = XLSX.read(fileBuffer, { type: "buffer" });
    const wsName = wb.SheetNames[0];
    const ws = wb.Sheets[wsName];
    const data = XLSX.utils.sheet_to_json<any>(ws);

    masterList = data.map((row) => ({
      name: (row["MANUFACTURER_NAME"] || "").toString().trim(),
      brand: (row["BRAND_NAME"] || "").toString().trim(),
    }));
  } catch (err) {
    console.warn("[manufacturer-lookup] Failed to load master list:", err);
    masterList = [];
  }
  return masterList;
}

/**
 * Calculates a simple Jaccard-like similarity between two strings based on words.
 */
function tokenSetRatio(s1: string, s2: string): number {
  const set1 = new Set(s1.toLowerCase().split(/\s+/).filter(Boolean));
  const set2 = new Set(s2.toLowerCase().split(/\s+/).filter(Boolean));
  if (set1.size === 0 || set2.size === 0) return 0;
  
  let intersection = 0;
  for (const word of set1) {
    if (set2.has(word)) intersection++;
  }
  
  return intersection / Math.max(set1.size, set2.size);
}

export function matchManufacturer(rawName: string): { name: string; matched: boolean } {
  if (!rawName || rawName.trim() === "") {
    return { name: rawName, matched: false };
  }

  const list = loadMasterList();
  if (list.length === 0) {
    return { name: rawName, matched: false };
  }

  let bestMatch = { name: rawName, score: 0 };

  // First try matching against manufacturer names
  for (const row of list) {
    if (!row.name) continue;
    
    const score = tokenSetRatio(rawName, row.name);
    if (score > bestMatch.score) {
      bestMatch = { name: row.name, score };
    }
  }

  // If manufacturer name match is good enough, return it
  if (bestMatch.score >= 0.82) {
    return { name: bestMatch.name, matched: true };
  }

  // Fallback: try matching against brand names
  bestMatch = { name: rawName, score: 0 };
  for (const row of list) {
    if (!row.brand) continue;
    
    const score = tokenSetRatio(rawName, row.brand);
    if (score > bestMatch.score) {
      bestMatch = { name: row.brand, score };
    }
  }

  if (bestMatch.score >= 0.82) {
    return { name: bestMatch.name, matched: true };
  }

  return { name: rawName, matched: false };
}
