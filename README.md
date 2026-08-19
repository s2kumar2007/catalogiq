# CatalogIQ

CatalogIQ is a Unilog product-content enrichment prototype. It turns messy
industrial catalogue rows into the provided Unilog delivery format while keeping
the process measurable and traceable.

## Unilog Batch Solution

The challenge materials say the reference documents are supporting resources,
and that the important processing files are the input and expected output
datasets in `Data/`. This repo therefore uses:

- `Data/Unihack_ Sample Dataset - Input.csv` as the 1,000-row working input.
- `Data/Unihack_ Expected Output - Delivery Format (1).csv` as the 252-column
  delivery schema and available ground-truth example rows.

Run the enrichment pipeline:

```bash
node scripts/unilog-enrich.js
```

Generated files:

- `outputs/catalogiq_unilog_delivery.csv` - 1,000 enriched rows in the exact
  delivery-column order.
- `outputs/catalogiq_unilog_report.json` - run summary, format checks,
  available ground-truth comparison, and trace samples.

The implemented slice focuses on the highest-value, demonstrable parts of the
problem statement:

- Standardizes placeholder brand fields and manufacturer names.
- Detects canonical brands from noisy descriptions and manufacturer strings.
- Classifies common abrasive/tool products into commerce-ready classpaths.
- Extracts product type, size, grit, package quantity, and application signals.
- Builds mobile, invoice, short, long, retail, and attribute fields.
- Preserves the expected 252-column delivery schema for downstream submission.
- Flags low-confidence or generic classifications for human review in the
  report.

The approach is intentionally schema-first: output columns come from the
expected delivery file, and every generated value is constrained by simple
rules instead of free-form invention. With the full reference workbooks
available, the same structure can be extended by replacing the local maps with
the official manufacturer/brand list, UOM table, decimal/fraction lookup, and
LOV values.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
