import HealthScoreDashboard from "@/components/HealthScoreDashboard";
import type { PipelineResult as DashboardPipelineResult } from "@/components/HealthScoreDashboard";

export interface BatchSummary {
  avg_health_score: number;
  validation_status_counts: {
    valid: number;
    flagged: number;
    invalid: number;
  };
  total_gap_asks: number;
  sorted_products: DashboardPipelineResult[];
}

export interface BatchResponse {
  batch_id: string;
  products: DashboardPipelineResult[];
  summary: BatchSummary;
}
