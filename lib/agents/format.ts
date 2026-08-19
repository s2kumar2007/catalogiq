/**
 * lib/agents/format.ts
 * Stage 7: Unilog delivery formatting.
 *
 * This returns the full wide delivery shape, including ATTRIBUTE_LABEL/VALUE/UOM
 * slots and fixed retrieval columns. Official-source-only fields stay blank
 * unless a retrieval stage passes verified manufacturer data.
 */

import { DeliveryFormats, ExtractedField, UnilogDeliveryRecord } from "@/lib/types";

const {
  buildUnilogDeliveryRecord,
  loadDeliverySchema,
  rowFromFields,
} = require("@/lib/unilog-format");

export interface FormattingResult {
  delivery_formats: DeliveryFormats;
  delivery_record: UnilogDeliveryRecord;
  delivery_columns: string[];
  trace: Record<string, unknown>;
}

export async function runFormatting(
  normalizedFields: Record<string, ExtractedField>,
  officialSourceData?: Partial<UnilogDeliveryRecord>
): Promise<FormattingResult> {
  const schema = loadDeliverySchema();
  const sourceRow = rowFromFields(normalizedFields);
  const formatted = buildUnilogDeliveryRecord(sourceRow, {
    columns: schema.columns,
    categoryExamples: [],
    officialSourceData,
    officialAssetsFound: Boolean(
      officialSourceData?.["Product Image"] ||
      officialSourceData?.["Alternate Image 1"]
    ),
  });

  const attributes: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const label = formatted.record[`ATTRIBUTE_LABEL ${i}`];
    const value = formatted.record[`ATTRIBUTE_VALUE ${i}`];
    const uom = formatted.record[`ATTRIBUTE_UOM ${i}`];
    if (label && value) {
      attributes.push(`${label} = ${value}${uom ? ` ${uom}` : ""}`);
    }
  }

  return {
    delivery_formats: {
      mobile_desc: formatted.record.MOBILE_DESC,
      short_desc: formatted.record.SHORT_DESC,
      long_desc: formatted.record.LONG_DESC1,
      invoice_desc: formatted.record.INVOICE_DESC,
      retail_desc: formatted.record.RETAIL_DESC,
      attributes,
      attributes_string: attributes.join("; "),
      fixed_block_status: formatted.trace.fixed_block_status,
    },
    delivery_record: formatted.record,
    delivery_columns: schema.columns,
    trace: formatted.trace,
  };
}
