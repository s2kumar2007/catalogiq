// ProductCard component — displays a single product's extracted intelligence.
// TODO: wire up to ProductResult type from @/lib/types

interface ProductCardProps {
  // placeholder — replace with ProductResult from @/lib/types
  title?: string;
}

export default function ProductCard({ title = "Product" }: ProductCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 p-4 shadow-sm">
      <h2 className="font-semibold text-lg">{title}</h2>
      {/* TODO: render fields, confidence badges, gap flags */}
    </div>
  );
}
