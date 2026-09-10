import { Play } from "lucide-react";
import type { DealStatus } from "@/types/deal";
import ICButton from "../ui/ICButton";

interface DashboardHeaderProps {
  dealId: string;
  dealName: string;
  status: DealStatus;
  useOpus: boolean;
  onToggleOpus: (v: boolean) => void;
  onRunAll: () => void;
  onBack: () => void;
  /** Disable the Run All button */
  disableRunAll?: boolean;
  disableReason?: string;
}

export default function DashboardHeader({
  dealName,
  status,
  onRunAll,
  disableRunAll = false,
  disableReason,
}: DashboardHeaderProps) {
  return (
    <header className="sticky top-0 z-10 bg-ic-dark/80 backdrop-blur-md border-b border-ic-border px-8 py-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ic-text tracking-tight">{dealName}</h1>
          <div className="flex items-center gap-2 mt-1">
            <StatusDot status={status} />
            <span className="text-xs text-ic-muted font-light capitalize">{status.replace("_", " ")}</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <ICButton size="lg" glow onClick={onRunAll} disabled={disableRunAll}>
            <Play className="w-4 h-4" />
            Run All Modules
          </ICButton>
          {disableRunAll && disableReason && (
            <p className="text-[10px] text-ic-coral/80 font-light mt-1 text-right">{disableReason}</p>
          )}
        </div>
      </div>
    </header>
  );
}

function StatusDot({ status }: { status: DealStatus }) {
  const color =
    status === "active"
      ? "bg-ic-turquoise"
      : status === "on_hold"
        ? "bg-yellow-500"
        : "bg-ic-muted";

  return <span className={`w-2 h-2 rounded-full ${color} shadow-sm`} />;
}
