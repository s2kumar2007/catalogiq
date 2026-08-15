// HealthScoreDashboard component — aggregate health metrics across a batch.
// TODO: wire up to BatchResult type from @/lib/types

interface HealthScoreDashboardProps {
  // placeholder
  totalProducts?: number;
  avgScore?: number;
}

export default function HealthScoreDashboard({
  totalProducts = 0,
  avgScore = 0,
}: HealthScoreDashboardProps) {
  return (
    <section className="rounded-xl border border-gray-200 p-6 shadow-sm">
      <h2 className="text-xl font-bold mb-4">Catalog Health</h2>
      <div className="flex gap-8">
        <div>
          <p className="text-sm text-gray-500">Products</p>
          <p className="text-3xl font-semibold">{totalProducts}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500">Avg Score</p>
          <p className="text-3xl font-semibold">{Math.round(avgScore * 100)}%</p>
        </div>
      </div>
      {/* TODO: charts, breakdown by gap type */}
    </section>
  );
}
